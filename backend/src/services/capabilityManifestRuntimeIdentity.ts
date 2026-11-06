// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import * as fs from 'fs';
import path from 'path';
import type {
  CapabilityManifestTraceContentIdentityV1,
  CapabilityManifestTraceProcessorIdentityV1,
  CapabilityManifestTraceProcessorUnavailableReason,
} from '../types/capabilityManifest';
import {getPerfettoStdlibSymbolAssetPath} from './perfettoStdlibScanner';
import {
  getBundledTraceProcessorPath,
  getPrebuiltTraceProcessorPath,
} from './workingTraceProcessor';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const NODE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const FILE_READ_BUFFER_BYTES = 64 * 1024;
const PIN_MAX_BYTES = 64 * 1024;
const STDLIB_ASSET_MAX_BYTES = 256 * 1024;
const REPORTED_VERSION_MAX_LENGTH = 256;
const REPORTED_VERSION_PATH_PATTERN =
  /(?:^|[\s"'\[\](){}<>,;:=])(?:\/|[A-Za-z]:[\\/]|\\\\)/;

const PLATFORM_SHA_KEYS = new Map<string, string>([
  ['linux/x64', 'PERFETTO_SHELL_SHA256_LINUX_AMD64'],
  ['linux/arm64', 'PERFETTO_SHELL_SHA256_LINUX_ARM64'],
  ['darwin/x64', 'PERFETTO_SHELL_SHA256_MAC_AMD64'],
  ['darwin/arm64', 'PERFETTO_SHELL_SHA256_MAC_ARM64'],
  ['win32/x64', 'PERFETTO_SHELL_SHA256_WINDOWS_AMD64'],
]);

const KNOWN_PIN_KEYS = new Set([
  'PERFETTO_VERSION',
  'PERFETTO_ARTIFACT_VERSION',
  'PERFETTO_LUCI_URL_BASE',
  ...PLATFORM_SHA_KEYS.values(),
]);

export type ResolveCapabilityTraceIdentityInput =
  | {
      source: 'local_file';
      filePath: string;
      traceSide: 'current' | 'reference';
      androidApiLevel?: number;
      machineId?: string;
      clockRangeNs?: {startNs: string; endNs: string};
    }
  | {
      source: 'external_rpc';
      traceSide: 'current' | 'reference';
      androidApiLevel?: number;
      machineId?: string;
      clockRangeNs?: {startNs: string; endNs: string};
    };

export type ResolveCapabilityTraceProcessorIdentityInput =
  | {
      source: 'local_binary';
      selectedPath: string;
      selectionOrigin: 'default' | 'env_override' | 'explicit';
    }
  | {source: 'external_rpc'};

export type CapabilityTraceIdentityResolution =
  | {
      status: 'ready';
      identity: CapabilityManifestTraceContentIdentityV1;
    }
  | {
      status: 'unavailable';
      reason:
        | 'external_rpc_trace_fingerprint_unavailable'
        | 'trace_file_unavailable'
        | 'trace_hash_failed';
      detail?: string;
    };

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

type SecureFileReadResult =
  | {
      status: 'ready';
      identity: FileIdentity;
      sha256?: string;
      bytes?: Buffer;
    }
  | {
      status: 'unavailable';
      reason: 'file_unavailable' | 'file_read_failed' | 'file_identity_changed';
      detail?: string;
    };

export type CapabilityRuntimeIdentitySecureFileReader = (
  filePath: string,
  request: {kind: 'sha256'} | {kind: 'buffer'; maxBytes: number},
) => Promise<SecureFileReadResult>;

export interface CapabilityRuntimeIdentityDependencies {
  platform?: NodeJS.Platform | string;
  arch?: string;
  canonicalSlotResolver?: () => {
    prebuiltPath?: string;
    bundledPath?: string;
  };
  pinCandidates?: readonly string[];
  stdlibAssetPath?: string;
  secureFileReader?: CapabilityRuntimeIdentitySecureFileReader;
}

interface DigestCacheEntry {
  identity: FileIdentity;
  sha256: string;
}

interface ResolvedPin {
  revision: string;
  sha256: string;
}

const fileDigestCache = new Map<string, DigestCacheEntry>();

export function sanitizeCapabilityTraceProcessorReportedVersion(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[\x20-\x7e]+$/.test(value)) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > REPORTED_VERSION_MAX_LENGTH ||
    REPORTED_VERSION_PATH_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as {code?: unknown}).code;
  return typeof code === 'string' && NODE_ERROR_CODE_PATTERN.test(code)
    ? code
    : undefined;
}

function unavailable(
  reason: Extract<SecureFileReadResult, {status: 'unavailable'}>['reason'],
  detail?: string,
): SecureFileReadResult {
  return {
    status: 'unavailable',
    reason,
    ...(detail === undefined ? {} : {detail}),
  };
}

function identityFromStats(stats: fs.BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function inspectRegularFile(
  filePath: string,
): Promise<
  | {status: 'ready'; identity: FileIdentity}
  | Extract<SecureFileReadResult, {status: 'unavailable'}>
> {
  try {
    const stats = await fs.promises.lstat(filePath, {bigint: true});
    if (stats.isSymbolicLink()) {
      return unavailable('file_unavailable', 'symlink_rejected');
    }
    if (!stats.isFile()) {
      return unavailable('file_unavailable', 'non_regular_file');
    }
    return {status: 'ready', identity: identityFromStats(stats)};
  } catch (error) {
    return unavailable('file_unavailable', nodeErrorCode(error));
  }
}

async function defaultSecureFileReader(
  filePath: string,
  request: {kind: 'sha256'} | {kind: 'buffer'; maxBytes: number},
): Promise<SecureFileReadResult> {
  const normalizedPath = path.resolve(filePath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await inspectRegularFile(normalizedPath);
    if (before.status === 'unavailable') return before;

    if (request.kind === 'sha256') {
      const cached = fileDigestCache.get(normalizedPath);
      if (cached && sameIdentity(cached.identity, before.identity)) {
        return {
          status: 'ready',
          identity: before.identity,
          sha256: cached.sha256,
        };
      }
      if (cached) fileDigestCache.delete(normalizedPath);
    }

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
    let handle: fs.promises.FileHandle | undefined;
    let identityChanged = false;
    try {
      handle = await fs.promises.open(
        normalizedPath,
        fs.constants.O_RDONLY | noFollow,
      );
      const openedStats = await handle.stat({bigint: true});
      if (!openedStats.isFile()) {
        return unavailable('file_unavailable', 'non_regular_file');
      }
      const openedIdentity = identityFromStats(openedStats);
      if (!sameIdentity(before.identity, openedIdentity)) {
        identityChanged = true;
      } else {
        const hash = request.kind === 'sha256' ? createHash('sha256') : undefined;
        const chunks: Buffer[] = [];
        let bytesReadTotal = 0;
        const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
        while (true) {
          const {bytesRead} = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (bytesRead === 0) break;
          bytesReadTotal += bytesRead;
          if (
            request.kind === 'buffer' &&
            bytesReadTotal > request.maxBytes
          ) {
            return unavailable('file_read_failed', 'file_too_large');
          }
          const chunk = buffer.subarray(0, bytesRead);
          if (hash) hash.update(chunk);
          else chunks.push(Buffer.from(chunk));
        }

        const afterFdStats = await handle.stat({bigint: true});
        const afterPath = await inspectRegularFile(normalizedPath);
        const afterFdIdentity = identityFromStats(afterFdStats);
        if (
          afterPath.status === 'unavailable' ||
          !afterFdStats.isFile() ||
          BigInt(bytesReadTotal) !== openedIdentity.size ||
          !sameIdentity(openedIdentity, afterFdIdentity) ||
          !sameIdentity(openedIdentity, afterPath.identity)
        ) {
          identityChanged = true;
        } else if (request.kind === 'sha256' && hash) {
          const sha256 = hash.digest('hex');
          fileDigestCache.set(normalizedPath, {
            identity: openedIdentity,
            sha256,
          });
          return {status: 'ready', identity: openedIdentity, sha256};
        } else {
          return {
            status: 'ready',
            identity: openedIdentity,
            bytes: Buffer.concat(chunks),
          };
        }
      }
    } catch (error) {
      const code = nodeErrorCode(error);
      return unavailable(
        code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR'
          ? 'file_unavailable'
          : 'file_read_failed',
        code,
      );
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The verified result never includes close errors or their paths.
        }
      }
    }

    if (!identityChanged) {
      return unavailable('file_read_failed');
    }
  }
  return unavailable('file_identity_changed', 'file_identity_changed');
}

function defaultPinCandidates(): readonly string[] {
  return [
    path.resolve(__dirname, '../../../scripts/trace-processor-pin.env'),
    path.resolve(__dirname, '../trace-processor-pin.env'),
  ];
}

function defaultCanonicalSlotResolver(): {
  prebuiltPath?: string;
  bundledPath?: string;
} {
  return {
    prebuiltPath: getPrebuiltTraceProcessorPath(),
    bundledPath: getBundledTraceProcessorPath(),
  };
}

function parsePinContents(
  contents: string,
  currentShaKey: string,
): {values: Map<string, string>; pin: ResolvedPin} | undefined {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s]+)$/.exec(line);
    if (!match) return undefined;
    const [, key, value] = match;
    if (!KNOWN_PIN_KEYS.has(key) || values.has(key)) return undefined;
    if (key.startsWith('PERFETTO_SHELL_SHA256_') && !SHA256_PATTERN.test(value)) {
      return undefined;
    }
    values.set(key, value);
  }

  const revision = values.get('PERFETTO_VERSION');
  const sha256 = values.get(currentShaKey);
  if (
    revision === undefined ||
    !GIT_REVISION_PATTERN.test(revision) ||
    sha256 === undefined ||
    !SHA256_PATTERN.test(sha256)
  ) {
    return undefined;
  }
  return {values, pin: {revision, sha256}};
}

function samePinValues(
  left: Map<string, string>,
  right: Map<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function resolvePin(
  candidates: readonly string[],
  currentShaKey: string,
  reader: CapabilityRuntimeIdentitySecureFileReader,
): Promise<ResolvedPin | undefined> {
  let selected:
    | {values: Map<string, string>; pin: ResolvedPin}
    | undefined;
  for (const candidate of candidates) {
    const result = await reader(candidate, {
      kind: 'buffer',
      maxBytes: PIN_MAX_BYTES,
    });
    if (result.status === 'unavailable') {
      if (result.detail === 'ENOENT' || result.detail === 'ENOTDIR') continue;
      return undefined;
    }
    if (!result.bytes) return undefined;
    const parsed = parsePinContents(result.bytes.toString('utf8'), currentShaKey);
    if (!parsed) return undefined;
    if (selected && !samePinValues(selected.values, parsed.values)) {
      return undefined;
    }
    selected ??= parsed;
  }
  return selected?.pin;
}

async function resolveStdlibRevision(
  assetPath: string,
  reader: CapabilityRuntimeIdentitySecureFileReader,
): Promise<string | undefined> {
  const result = await reader(assetPath, {
    kind: 'buffer',
    maxBytes: STDLIB_ASSET_MAX_BYTES,
  });
  if (result.status === 'unavailable' || !result.bytes) return undefined;
  try {
    const parsed = JSON.parse(result.bytes.toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const projection = parsed as {version?: unknown; generatedFrom?: unknown};
    return projection.version === 1 &&
      typeof projection.generatedFrom === 'string' &&
      GIT_REVISION_PATTERN.test(projection.generatedFrom)
      ? projection.generatedFrom
      : undefined;
  } catch {
    return undefined;
  }
}

function unknownIdentity(
  unavailableReason: CapabilityManifestTraceProcessorUnavailableReason,
): CapabilityManifestTraceProcessorIdentityV1 {
  return {source: 'unknown', unavailableReason};
}

function unreadableBinaryReason(
  binaryResult: Extract<SecureFileReadResult, {status: 'unavailable'}>,
  platformShaKey: string | undefined,
  pin: ResolvedPin | undefined,
): CapabilityManifestTraceProcessorUnavailableReason {
  if (!platformShaKey) return 'unsupported_platform';
  if (!pin) return 'trace_processor_pin_unavailable';
  if (binaryResult.reason === 'file_unavailable') {
    return 'trace_processor_binary_unavailable';
  }
  return 'identity_resolution_failed';
}

export async function resolveCapabilityTraceIdentity(
  input: ResolveCapabilityTraceIdentityInput,
): Promise<CapabilityTraceIdentityResolution> {
  if (input.source === 'external_rpc') {
    return {
      status: 'unavailable',
      reason: 'external_rpc_trace_fingerprint_unavailable',
    };
  }
  if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
    return {status: 'unavailable', reason: 'trace_file_unavailable'};
  }
  const result = await defaultSecureFileReader(input.filePath, {kind: 'sha256'});
  if (result.status === 'unavailable') {
    const traceUnavailable = result.reason === 'file_unavailable';
    return {
      status: 'unavailable',
      reason: traceUnavailable ? 'trace_file_unavailable' : 'trace_hash_failed',
      ...(result.detail === undefined ? {} : {detail: result.detail}),
    };
  }
  if (!result.sha256) {
    return {status: 'unavailable', reason: 'trace_hash_failed'};
  }
  return {
    status: 'ready',
    identity: {
      fingerprintSha256: result.sha256,
      fingerprintKind: 'trace_bytes_sha256',
      traceSide: input.traceSide,
      ...(input.androidApiLevel === undefined
        ? {}
        : {androidApiLevel: input.androidApiLevel}),
      ...(input.machineId === undefined ? {} : {machineId: input.machineId}),
      ...(input.clockRangeNs === undefined
        ? {}
        : {clockRangeNs: {...input.clockRangeNs}}),
    },
  };
}

export async function resolveCapabilityTraceProcessorIdentity(
  input: ResolveCapabilityTraceProcessorIdentityInput = {
    source: 'external_rpc',
  },
  dependencies: CapabilityRuntimeIdentityDependencies = {},
): Promise<CapabilityManifestTraceProcessorIdentityV1> {
  if (input.source === 'external_rpc') {
    return unknownIdentity('external_rpc_binary_unavailable');
  }
  if (
    typeof input.selectedPath !== 'string' ||
    input.selectedPath.trim().length === 0
  ) {
    return unknownIdentity('trace_processor_binary_unavailable');
  }

  const reader = dependencies.secureFileReader ?? defaultSecureFileReader;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const platformShaKey = PLATFORM_SHA_KEYS.get(`${platform}/${arch}`);
  const pin = platformShaKey
    ? await resolvePin(
        dependencies.pinCandidates ?? defaultPinCandidates(),
        platformShaKey,
        reader,
      )
    : undefined;
  const binaryResult = await reader(input.selectedPath, {kind: 'sha256'});
  if (binaryResult.status === 'unavailable') {
    return unknownIdentity(
      unreadableBinaryReason(binaryResult, platformShaKey, pin),
    );
  }
  if (!binaryResult.sha256) return unknownIdentity('identity_resolution_failed');

  let slots: {prebuiltPath?: string; bundledPath?: string} = {};
  try {
    slots = (dependencies.canonicalSlotResolver ??
      defaultCanonicalSlotResolver)();
  } catch {
    slots = {};
  }
  const selectedPath = path.resolve(input.selectedPath);
  const trustedPaths = [slots.prebuiltPath, slots.bundledPath]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(candidate => path.resolve(candidate));
  const bundled = input.selectionOrigin === 'default' &&
    trustedPaths.includes(selectedPath) &&
    pin !== undefined &&
    pin.sha256 === binaryResult.sha256;

  const stdlibRevision = await resolveStdlibRevision(
    dependencies.stdlibAssetPath ?? getPerfettoStdlibSymbolAssetPath(),
    reader,
  );
  const shared = {
    ...(stdlibRevision === undefined ? {} : {stdlibRevision}),
  };
  return bundled
    ? {source: 'bundled', gitRevision: pin.revision, ...shared}
    : {
        source: 'custom',
        binarySha256: binaryResult.sha256,
        ...shared,
      };
}

/** @internal Test seam. */
export function clearCapabilityRuntimeIdentityCaches(): void {
  fileDigestCache.clear();
}

/** Internal capabilities, never recovered from stored metadata or a pathname. */
export interface ManagedTraceInputGrant {readonly kind: 'managed_trace_input'}
export interface LoadedTraceSourcePin {readonly kind: 'loaded_trace_source'}
export interface ManagedTraceLoadContext {
  readonly grant: ManagedTraceInputGrant;
  readonly serviceOwner: object;
  readonly registration: object;
  readonly assertCurrent: () => void;
  readonly sourcePin?: LoadedTraceSourcePin;
}
export interface ManagedTraceSourceBinding {
  readonly serviceOwner: object;
  readonly registration: object;
  readonly traceId: string;
  readonly finalPath: string;
}
interface ManagedInputState {
  readonly traceId: string;
  readonly finalPath: string;
  readonly identity: FileIdentity;
  readonly sha256: string;
  binding?: ManagedTraceSourceBinding;
  revoked: boolean;
}
interface ManagedLoadState {
  readonly context: ManagedTraceLoadContext;
  readonly input: ManagedInputState;
  readonly processorOwner: object;
  readonly binaryPin: string;
}
export interface ManagedTraceLoadAttempt {readonly kind: 'managed_trace_load'}
interface LoadedSourceState extends ManagedLoadState {
  readonly pin: LoadedTraceSourcePin;
  revoked: boolean;
}
const managedInputs = new WeakMap<ManagedTraceInputGrant, ManagedInputState>();
const managedLoads = new WeakMap<ManagedTraceLoadAttempt, ManagedLoadState>();
const loadedSources = new WeakMap<LoadedTraceSourcePin, LoadedSourceState>();
const processorSources = new WeakMap<object, LoadedSourceState>();
const revokedProcessorSources = new WeakSet<object>();

export class ManagedTraceSourceUnavailableError extends Error {
  readonly code = 'managed_trace_source_unavailable';
  constructor() {super('managed_trace_source_unavailable');}
}

async function grantMaterializedInput(traceId: string, finalPath: string): Promise<ManagedTraceInputGrant | undefined> {
  const normalizedPath = path.resolve(finalPath);
  const material = await defaultSecureFileReader(normalizedPath, {kind: 'sha256'});
  if (material.status !== 'ready' || !material.sha256) return undefined;
  const grant: ManagedTraceInputGrant = Object.freeze({kind: 'managed_trace_input'});
  managedInputs.set(grant, {traceId, finalPath: normalizedPath, identity: material.identity,
    sha256: material.sha256, revoked: false});
  return grant;
}

/** Replace the caller's existing copy; do not add a second copy or ever remove its source. */
export async function copyManagedTraceInput(input: {sourcePath: string; finalPath: string; traceId: string}): Promise<ManagedTraceInputGrant | undefined> {
  const {sourcePath, finalPath, traceId} = input;
  await fs.promises.copyFile(sourcePath, finalPath);
  return grantMaterializedInput(traceId, finalPath);
}

/** Replace the controlled temporary upload's existing rename. */
export async function moveManagedTraceInput(input: {tempPath: string; finalPath: string; traceId: string}): Promise<ManagedTraceInputGrant | undefined> {
  const {tempPath, finalPath, traceId} = input;
  await fs.promises.rename(tempPath, finalPath);
  return grantMaterializedInput(traceId, finalPath);
}

export function bindManagedTraceInput(input: ManagedTraceSourceBinding & {grant: ManagedTraceInputGrant}): void {
  const {grant, serviceOwner, registration, traceId, finalPath} = input;
  const state = managedInputs.get(grant);
  if (!state || state.revoked || state.binding || state.traceId !== traceId || state.finalPath !== path.resolve(finalPath)) {
    throw new ManagedTraceSourceUnavailableError();
  }
  state.binding = Object.freeze({serviceOwner, registration, traceId, finalPath: state.finalPath});
}

export function revokeManagedTraceInput(grant: ManagedTraceInputGrant): void {
  const state = managedInputs.get(grant);
  if (state) state.revoked = true;
}

function currentManagedInput(context: ManagedTraceLoadContext, binding: ManagedTraceSourceBinding): ManagedInputState | undefined {
  const state = managedInputs.get(context.grant);
  if (!state || state.revoked || !state.binding || state.binding.serviceOwner !== binding.serviceOwner ||
    state.binding.registration !== binding.registration || state.traceId !== binding.traceId ||
    state.finalPath !== path.resolve(binding.finalPath) || context.serviceOwner !== state.binding.serviceOwner ||
    context.registration !== state.binding.registration) return undefined;
  context.assertCurrent();
  return state;
}

async function sameManagedMaterial(state: ManagedInputState): Promise<boolean> {
  if (state.revoked) return false;
  const material = await defaultSecureFileReader(state.finalPath, {kind: 'sha256'});
  if (material.status !== 'ready' || !material.sha256) return false;
  if (!sameIdentity(state.identity, material.identity) || state.sha256 !== material.sha256) {
    state.revoked = true;
    return false;
  }
  return !state.revoked;
}

function binarySourcePin(identity: CapabilityManifestTraceProcessorIdentityV1): string | undefined {
  return identity.source === 'bundled' && GIT_REVISION_PATTERN.test(identity.gitRevision) &&
    identity.stdlibRevision === identity.gitRevision ? identity.gitRevision : undefined;
}

function loadedSourceCurrent(pin: LoadedTraceSourcePin, visited = new Set<LoadedTraceSourcePin>()): LoadedSourceState | undefined {
  const state = loadedSources.get(pin);
  if (!state || state.revoked || revokedProcessorSources.has(state.processorOwner) ||
    processorSources.get(state.processorOwner) !== state || visited.has(pin)) return undefined;
  visited.add(pin);
  if (currentManagedInput(state.context, state.input.binding!) !== state.input ||
    state.context.sourcePin && !loadedSourceCurrent(state.context.sourcePin, visited)) return undefined;
  return state;
}

/** Sync identity accessor only; callers verify source bytes with the async current assertion. */
export function readLoadedTraceSourcePin(processorOwner: object): LoadedTraceSourcePin | undefined {
  const state = processorSources.get(processorOwner);
  try {return state && loadedSourceCurrent(state.pin) ? state.pin : undefined;} catch {return undefined;}
}

export function revokeLoadedTraceSourcePin(processorOwner: object): void {
  revokedProcessorSources.add(processorOwner);
  const state = processorSources.get(processorOwner);
  if (state) state.revoked = true;
}

export async function assertLoadedTraceSourcePinCurrent(pin: LoadedTraceSourcePin,
  binding: ManagedTraceSourceBinding & {assertCurrent(): void}): Promise<void> {
  try {
    binding.assertCurrent();
    const state = loadedSourceCurrent(pin);
    if (!state || currentManagedInput(state.context, binding) !== state.input || !await sameManagedMaterial(state.input)) {
      throw new ManagedTraceSourceUnavailableError();
    }
    binding.assertCurrent();
    if (loadedSourceCurrent(pin) !== state) throw new ManagedTraceSourceUnavailableError();
  } catch {throw new ManagedTraceSourceUnavailableError();}
}

/** Loader-only: optional source qualification never changes ordinary parent loading. */
export async function beginManagedTraceLoad(input: ManagedTraceSourceBinding & {context: ManagedTraceLoadContext;
  processorOwner: object; binaryIdentity: CapabilityManifestTraceProcessorIdentityV1}): Promise<ManagedTraceLoadAttempt | undefined> {
  try {
    const context = Object.freeze({...input.context});
    const state = currentManagedInput(context, input), binaryPin = binarySourcePin(input.binaryIdentity);
    if (!state || !binaryPin || processorSources.has(input.processorOwner) || revokedProcessorSources.has(input.processorOwner)) return undefined;
    if (context.sourcePin) {
      await assertLoadedTraceSourcePinCurrent(context.sourcePin, {...input, assertCurrent: context.assertCurrent});
      if (loadedSources.get(context.sourcePin)?.input !== state || loadedSources.get(context.sourcePin)?.binaryPin !== binaryPin) return undefined;
    }
    if (!await sameManagedMaterial(state) || currentManagedInput(context, input) !== state) return undefined;
    const attempt: ManagedTraceLoadAttempt = Object.freeze({kind: 'managed_trace_load'});
    managedLoads.set(attempt, {context, input: state, processorOwner: input.processorOwner, binaryPin});
    return attempt;
  } catch {return undefined;}
}

/** Only called after the actual first native load and its binary/schema revalidation. */
export async function completeManagedTraceLoad(attempt: ManagedTraceLoadAttempt,
  binaryIdentity: CapabilityManifestTraceProcessorIdentityV1): Promise<LoadedTraceSourcePin | undefined> {
  const state = managedLoads.get(attempt);
  managedLoads.delete(attempt);
  if (!state) return undefined;
  try {
    if (binarySourcePin(binaryIdentity) !== state.binaryPin || !await sameManagedMaterial(state.input) ||
      currentManagedInput(state.context, state.input.binding!) !== state.input || processorSources.has(state.processorOwner) ||
      revokedProcessorSources.has(state.processorOwner) ||
      state.context.sourcePin && !loadedSourceCurrent(state.context.sourcePin)) return undefined;
    const pin: LoadedTraceSourcePin = Object.freeze({kind: 'loaded_trace_source'});
    const loaded = {...state, pin, revoked: false};
    loadedSources.set(pin, loaded); processorSources.set(state.processorOwner, loaded);
    return pin;
  } catch {return undefined;}
}
