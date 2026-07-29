// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import {spawn} from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import type {
  ProposalGateVerdict,
  ProposalMaterializationPlanV1,
} from '../../types/selfEvolution';
import {canonicalContentHash, immutableCanonicalSnapshot} from './canonicalJson';
import {
  parseProposalMaterializationPlanV1,
} from './proposalGateContract';
import {
  type ProposalMaterializationRegistry,
  resolveRootIdentityHash,
} from './proposalMaterializationPlanner';

export const PROPOSAL_CONTAINMENT_PROTOCOL_VERSION = 3;

export interface ProposalContainmentProbeV1 {
  schemaVersion: 1;
  protocolVersion: 3;
  planContentHash: string;
  materializationRegistryContentHash: string;
  rootIdentityHash: string;
  descriptorChainHash: string;
  mutationPrimitive: 'pinned_cwd_atomic_rename_v1';
  targetExists: boolean;
  targetSnapshotHash: string;
  stagingDevice: number;
  targetDevice: number;
  verdict: Exclude<ProposalGateVerdict, 'not_run'>;
  reasonCodes: string[];
  contentHash: string;
}

interface OpenedDirectory {
  absolutePath: string;
  descriptor: number;
  stat: fs.Stats;
}

export function probeProposalContainment(input: {
  plan: ProposalMaterializationPlanV1;
  registry: ProposalMaterializationRegistry;
  serializedContent: string;
}): ProposalContainmentProbeV1 {
  const plan = parseProposalMaterializationPlanV1(input.plan);
  const reasonCodes = new Set<string>();
  let targetExists = false;
  let targetSnapshotHash = canonicalContentHash({state: 'absent'});
  let stagingDevice = -1;
  let targetDevice = -1;
  let descriptorChainHash = canonicalContentHash({state: 'unavailable'});
  const opened: OpenedDirectory[] = [];
  try {
    input.registry.assertPlanPolicy(plan);
    const rootRealpath = input.registry.resolveRoot(plan.rootId);
    if (
      resolveRootIdentityHash(rootRealpath) !== plan.rootIdentityHash
      || input.registry.contentHash
        !== plan.materializationRegistryContentHash
    ) {
      reasonCodes.add('containment_root_identity_mismatch');
    }
    if (!isSafeArchiveEntry(plan.relativeTargetPath)) {
      reasonCodes.add('containment_path_escape');
    }
    assertSafeContributionArchiveEntries(plan.archiveEntries);
    assertPinnedCwdMutationCapability(reasonCodes);
    scanStructuredSecrets(
      input.serializedContent,
      plan.fileExtension,
    ).forEach(code => reasonCodes.add(code));

    const targetPath = path.resolve(rootRealpath, plan.relativeTargetPath);
    if (!isWithin(rootRealpath, targetPath)) {
      reasonCodes.add('containment_path_escape');
    } else {
      const parentRelative = path.posix.dirname(plan.relativeTargetPath);
      opened.push(...openOwnedDirectoryChain({
        rootRealpath,
        relativeDirectory: parentRelative,
        createMissing: true,
        reasons: reasonCodes,
      }));
      const targetParent = opened[opened.length - 1];
      targetDevice = targetParent?.stat.dev ?? -1;
      const staging = openSecureStaging(rootRealpath, reasonCodes);
      opened.push(staging);
      stagingDevice = staging.stat.dev;
      if (stagingDevice !== targetDevice) {
        reasonCodes.add('containment_atomic_rename_cross_device');
      }
      descriptorChainHash = canonicalContentHash(opened.map(item => ({
        relativePath: path.relative(rootRealpath, item.absolutePath),
        device: item.stat.dev,
        inode: item.stat.ino,
        mode: item.stat.mode & 0o777,
        uid: item.stat.uid,
      })));
      if (fs.existsSync(targetPath)) {
        targetExists = true;
        targetSnapshotHash = inspectExistingTarget(
          rootRealpath,
          targetPath,
          reasonCodes,
        );
      }
      revalidateOpenedDirectories(rootRealpath, opened, reasonCodes);
    }
  } catch (error) {
    reasonCodes.add(errorCode(error));
  } finally {
    closeOpenedDirectories(opened);
  }
  const capabilityUnavailable = [...reasonCodes].some(code =>
    code === 'containment_no_follow_unavailable'
    || code === 'containment_directory_flag_unavailable'
    || code === 'containment_owner_identity_unavailable'
    || code === 'containment_pinned_cwd_unavailable');
  const verdict: ProposalContainmentProbeV1['verdict'] =
    reasonCodes.size === 0
      ? 'passed'
      : capabilityUnavailable
        ? 'inconclusive'
        : 'failed';
  const withoutHash = {
    schemaVersion: 1 as const,
    protocolVersion: PROPOSAL_CONTAINMENT_PROTOCOL_VERSION as 3,
    planContentHash: plan.contentHash,
    materializationRegistryContentHash:
      plan.materializationRegistryContentHash,
    rootIdentityHash: plan.rootIdentityHash,
    descriptorChainHash,
    mutationPrimitive: 'pinned_cwd_atomic_rename_v1' as const,
    targetExists,
    targetSnapshotHash,
    stagingDevice,
    targetDevice,
    verdict,
    reasonCodes: [...reasonCodes].sort(),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseProposalContainmentProbeV1(
  value: unknown,
): ProposalContainmentProbeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('proposal_containment_probe_invalid');
  }
  const probe = value as ProposalContainmentProbeV1;
  const allowed = [
    'schemaVersion',
    'protocolVersion',
    'planContentHash',
    'materializationRegistryContentHash',
    'rootIdentityHash',
    'descriptorChainHash',
    'mutationPrimitive',
    'targetExists',
    'targetSnapshotHash',
    'stagingDevice',
    'targetDevice',
    'verdict',
    'reasonCodes',
    'contentHash',
  ];
  const {contentHash, ...withoutHash} = probe;
  if (
    probe.schemaVersion !== 1
    || probe.protocolVersion !== 3
    || Object.keys(probe).some(key => !allowed.includes(key))
    || probe.mutationPrimitive !== 'pinned_cwd_atomic_rename_v1'
    || !['passed', 'failed', 'inconclusive'].includes(probe.verdict)
    || !Array.isArray(probe.reasonCodes)
    || [...probe.reasonCodes].sort().some(
      (code, index) => code !== probe.reasonCodes[index],
    )
    || [
      probe.planContentHash,
      probe.materializationRegistryContentHash,
      probe.rootIdentityHash,
      probe.descriptorChainHash,
      probe.targetSnapshotHash,
      contentHash,
    ].some(hash => !/^[0-9a-f]{64}$/.test(hash))
    || canonicalContentHash(withoutHash) !== contentHash
  ) {
    throw new Error('proposal_containment_probe_invalid');
  }
  return immutableCanonicalSnapshot(probe);
}

/**
 * M8 uses this exact write path after rerunning the probe. A short-lived
 * bundled-Node helper pins the verified target parent as its cwd, reports the
 * directory identity before receiving content, and then uses relative names.
 */
export async function atomicWriteProposalMaterialization(input: {
  plan: ProposalMaterializationPlanV1;
  registry: ProposalMaterializationRegistry;
  serializedContent: string;
  expectedProbeContentHash: string;
}): Promise<string> {
  const fresh = probeProposalContainment({
    plan: input.plan,
    registry: input.registry,
    serializedContent: input.serializedContent,
  });
  if (
    fresh.verdict !== 'passed'
    || fresh.contentHash !== input.expectedProbeContentHash
  ) {
    throw new Error('containment_write_probe_mismatch');
  }
  const root = input.registry.resolveRoot(input.plan.rootId);
  const opened = openOwnedDirectoryChain({
    rootRealpath: root,
    relativeDirectory: path.posix.dirname(input.plan.relativeTargetPath),
    createMissing: false,
    reasons: new Set(),
  });
  const targetPath = path.join(root, input.plan.relativeTargetPath);
  try {
    revalidateOpenedDirectories(root, opened, new Set());
    await runPinnedCwdAtomicRename({
      directory: opened[opened.length - 1],
      targetName: path.basename(input.plan.relativeTargetPath),
      serializedContent: input.serializedContent,
    });
    revalidateOpenedDirectories(root, opened, new Set());
    const targetDescriptor = fs.openSync(
      targetPath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    try {
      if (
        createHash('sha256')
          .update(fs.readFileSync(targetDescriptor))
          .digest('hex')
        !== createHash('sha256')
          .update(input.serializedContent, 'utf8')
          .digest('hex')
      ) {
        throw new Error('containment_write_content_mismatch');
      }
    } finally {
      fs.closeSync(targetDescriptor);
    }
    return targetPath;
  } finally {
    closeOpenedDirectories(opened);
  }
}

const PINNED_CWD_RENAME_WORKER = String.raw`
const crypto = require('crypto');
const fs = require('fs');
let stageName;
function errorCode(error) {
  if (error && typeof error.message === 'string'
      && /^[a-z0-9_]{3,160}$/.test(error.message)) {
    return error.message;
  }
  if (error && typeof error.code === 'string') {
    return 'containment_worker_fs_' + error.code.toLowerCase();
  }
  return 'containment_worker_failed';
}
function fail(error) {
  if (stageName) {
    try { fs.unlinkSync(stageName); } catch {}
  }
  if (process.send) {
    process.send({type: 'error', code: errorCode(error)});
    process.disconnect();
    setImmediate(() => process.exit(1));
  } else {
    process.exit(1);
  }
}
try {
  if (typeof fs.constants.O_NOFOLLOW !== 'number'
      || typeof fs.constants.O_DIRECTORY !== 'number'
      || !process.send) {
    throw new Error('containment_pinned_cwd_unavailable');
  }
  const directory = fs.statSync('.');
  process.send({
    type: 'ready',
    device: directory.dev,
    inode: directory.ino,
    uid: directory.uid,
    mode: directory.mode & 0o777,
  });
  process.once('message', message => {
    let descriptor;
    try {
      if (!message || message.type !== 'write'
          || typeof message.stageName !== 'string'
          || !/^\.self-evolution-[0-9a-f-]+\.tmp$/.test(message.stageName)
          || typeof message.targetName !== 'string'
          || !message.targetName
          || message.targetName.includes('/')
          || message.targetName.includes('\\')
          || typeof message.contentBase64 !== 'string'
          || !/^[0-9a-f]{64}$/.test(message.expectedContentHash)) {
        throw new Error('containment_worker_message_invalid');
      }
      stageName = message.stageName;
      const content = Buffer.from(message.contentBase64, 'base64');
      const actualHash = crypto.createHash('sha256').update(content).digest('hex');
      if (actualHash !== message.expectedContentHash) {
        throw new Error('containment_worker_content_hash_mismatch');
      }
      descriptor = fs.openSync(
        stageName,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(stageName, message.targetName);
      stageName = undefined;
      const targetDescriptor = fs.openSync(
        message.targetName,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      let storedHash;
      try {
        storedHash = crypto.createHash('sha256')
          .update(fs.readFileSync(targetDescriptor))
          .digest('hex');
      } finally {
        fs.closeSync(targetDescriptor);
      }
      if (storedHash !== message.expectedContentHash) {
        throw new Error('containment_write_content_mismatch');
      }
      const directoryDescriptor = fs.openSync(
        '.',
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
      );
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
      process.send({type: 'done', contentHash: storedHash});
      process.disconnect();
      setImmediate(() => process.exit(0));
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      fail(error);
    }
  });
} catch (error) {
  fail(error);
}
`;

async function runPinnedCwdAtomicRename(input: {
  directory: OpenedDirectory;
  targetName: string;
  serializedContent: string;
  beforeWrite?: () => void;
}): Promise<void> {
  if (
    input.targetName !== path.basename(input.targetName)
    || !input.targetName
  ) {
    throw new Error('containment_target_name_invalid');
  }
  const capabilityReasons = new Set<string>();
  assertPinnedCwdMutationCapability(capabilityReasons);
  if (capabilityReasons.size > 0) {
    throw new Error([...capabilityReasons].sort()[0]);
  }
  const stageName = `.self-evolution-${randomUUID()}.tmp`;
  const content = Buffer.from(input.serializedContent, 'utf8');
  const expectedContentHash = createHash('sha256')
    .update(content)
    .digest('hex');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', PINNED_CWD_RENAME_WORKER],
      {
        cwd: input.directory.absolutePath,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    let settled = false;
    let ready = false;
    const timer = setTimeout(() => {
      finish(new Error('containment_worker_timeout'));
    }, 10_000);
    timer.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (error) {
        child.kill();
        reject(error);
      } else {
        if (child.connected) child.disconnect();
        child.unref();
        resolve();
      }
    };
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (!settled) {
        finish(new Error(
          code === 0
            ? 'containment_worker_exited_early'
            : 'containment_worker_failed',
        ));
      }
    });
    child.on('message', messageValue => {
      if (!messageValue || typeof messageValue !== 'object') {
        finish(new Error('containment_worker_message_invalid'));
        return;
      }
      const message = messageValue as Record<string, unknown>;
      if (!ready && message.type === 'ready') {
        if (
          message.device !== input.directory.stat.dev
          || message.inode !== input.directory.stat.ino
          || message.uid !== input.directory.stat.uid
          || message.mode !== (input.directory.stat.mode & 0o777)
        ) {
          finish(new Error('containment_worker_directory_mismatch'));
          return;
        }
        ready = true;
        try {
          input.beforeWrite?.();
          child.send({
            type: 'write',
            stageName,
            targetName: input.targetName,
            contentBase64: content.toString('base64'),
            expectedContentHash,
          }, error => {
            if (error) finish(error);
          });
        } catch (error) {
          finish(error instanceof Error
            ? error
            : new Error('containment_worker_before_write_failed'));
        }
        return;
      }
      if (
        ready
        && message.type === 'done'
        && message.contentHash === expectedContentHash
      ) {
        finish();
        return;
      }
      if (message.type === 'error' && typeof message.code === 'string') {
        finish(new Error(message.code));
        return;
      }
      finish(new Error('containment_worker_message_invalid'));
    });
  });
}

function assertPinnedCwdMutationCapability(reasons: Set<string>): void {
  try {
    if (
      !process.execPath
      || !path.isAbsolute(process.execPath)
      || typeof fs.constants.O_NOFOLLOW !== 'number'
      || typeof fs.constants.O_DIRECTORY !== 'number'
    ) {
      reasons.add('containment_pinned_cwd_unavailable');
      return;
    }
    fs.accessSync(process.execPath, fs.constants.X_OK);
  } catch {
    reasons.add('containment_pinned_cwd_unavailable');
  }
}

export const proposalContainmentGateTesting = {
  async runPinnedCwdAtomicRename(input: {
    directoryPath: string;
    targetName: string;
    serializedContent: string;
    beforeWrite?: () => void;
  }): Promise<void> {
    const directory = openDirectory(
      fs.realpathSync.native(input.directoryPath),
      new Set(),
    );
    try {
      await runPinnedCwdAtomicRename({
        directory,
        targetName: input.targetName,
        serializedContent: input.serializedContent,
        beforeWrite: input.beforeWrite,
      });
    } finally {
      fs.closeSync(directory.descriptor);
    }
  },
};

export function assertSafeContributionArchiveEntries(
  entries: readonly {relativePath: string}[],
): void {
  if (entries.some(entry => !isSafeArchiveEntry(entry.relativePath))) {
    throw new Error('containment_zip_slip');
  }
}

export function isSafeArchiveEntry(value: string): boolean {
  if (
    !value
    || value.includes('\0')
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split(/[\\/]/).every(
    segment => segment !== '' && segment !== '.' && segment !== '..',
  );
}

function openOwnedDirectoryChain(input: {
  rootRealpath: string;
  relativeDirectory: string;
  createMissing: boolean;
  reasons: Set<string>;
}): OpenedDirectory[] {
  const segments = input.relativeDirectory === '.'
    ? []
    : input.relativeDirectory.split('/');
  const opened: OpenedDirectory[] = [];
  let cursor = input.rootRealpath;
  opened.push(openDirectory(cursor, input.reasons));
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (!input.createMissing) {
        throw new Error('containment_parent_missing');
      }
      fs.mkdirSync(cursor, {mode: 0o700});
    }
    opened.push(openDirectory(cursor, input.reasons));
  }
  return opened;
}

function openDirectory(
  absolutePath: string,
  reasons: Set<string>,
): OpenedDirectory {
  const before = fs.lstatSync(absolutePath);
  if (before.isSymbolicLink()) reasons.add('containment_symlink_rejected');
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  const stat = fs.fstatSync(descriptor);
  if (
    !stat.isDirectory()
    || stat.dev !== before.dev
    || stat.ino !== before.ino
  ) {
    fs.closeSync(descriptor);
    throw new Error('containment_toctou_detected');
  }
  assertOwnerProtected(stat, reasons);
  return {absolutePath, descriptor, stat};
}

function openSecureStaging(
  rootRealpath: string,
  reasons: Set<string>,
): OpenedDirectory {
  const stagingPath = path.join(rootRealpath, '.self-evolution-staging');
  if (!fs.existsSync(stagingPath)) {
    fs.mkdirSync(stagingPath, {mode: 0o700});
  }
  const opened = openDirectory(stagingPath, reasons);
  if ((opened.stat.mode & 0o077) !== 0) {
    reasons.add('containment_staging_permissions_invalid');
  }
  try {
    fs.accessSync(stagingPath, fs.constants.W_OK);
  } catch {
    reasons.add('containment_staging_not_writable');
  }
  return opened;
}

function revalidateOpenedDirectories(
  rootRealpath: string,
  opened: readonly OpenedDirectory[],
  reasons: Set<string>,
): void {
  for (const item of opened) {
    const relative = path.relative(rootRealpath, item.absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      reasons.add('containment_path_escape');
      continue;
    }
    const before = fs.lstatSync(item.absolutePath);
    const current = fs.fstatSync(item.descriptor);
    if (
      before.isSymbolicLink()
      || current.dev !== item.stat.dev
      || current.ino !== item.stat.ino
      || before.dev !== item.stat.dev
      || before.ino !== item.stat.ino
    ) {
      reasons.add('containment_toctou_detected');
    }
  }
  if (reasons.size > 0) {
    throw new Error([...reasons].sort()[0]);
  }
}

function inspectExistingTarget(
  rootRealpath: string,
  targetPath: string,
  reasons: Set<string>,
): string {
  const before = fs.lstatSync(targetPath);
  if (before.isSymbolicLink()) {
    reasons.add('containment_symlink_rejected');
    return canonicalContentHash({state: 'symlink'});
  }
  if (!before.isFile()) {
    reasons.add('containment_target_not_file');
    return canonicalContentHash({state: 'not_file'});
  }
  const descriptor = fs.openSync(
    targetPath,
    fs.constants.O_RDONLY | noFollowFlag(),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const real = fs.realpathSync.native(targetPath);
    if (
      !isWithin(rootRealpath, real)
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      reasons.add('containment_toctou_detected');
    }
    return canonicalContentHash({
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      contentHash: createHash('sha256')
        .update(fs.readFileSync(descriptor))
        .digest('hex'),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertOwnerProtected(stat: fs.Stats, reasons: Set<string>): void {
  if (typeof process.getuid !== 'function') {
    reasons.add('containment_owner_identity_unavailable');
    return;
  }
  if (stat.uid !== process.getuid()) {
    reasons.add('containment_owner_mismatch');
  }
  if ((stat.mode & 0o022) !== 0) {
    reasons.add('containment_parent_writable_by_others');
  }
}

function scanStructuredSecrets(
  content: string,
  extension: ProposalMaterializationPlanV1['fileExtension'],
): string[] {
  const reasons = new Set<string>();
  for (const [code, pattern] of [
    [
      'containment_secret_private_key',
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    ],
    ['containment_secret_aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
    ['containment_secret_bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i],
  ] as const) {
    if (pattern.test(content)) reasons.add(code);
  }
  try {
    if (extension === '.json') {
      scanStructuredValue(JSON.parse(content), reasons);
    } else if (extension === '.yaml') {
      scanStructuredValue(yaml.load(content), reasons);
    } else if (extension === '.md') {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        content,
      );
      if (frontmatter) scanStructuredValue(yaml.load(frontmatter[1]), reasons);
    }
  } catch {
    reasons.add('containment_structured_parse_failed');
  }
  return [...reasons].sort();
}

function scanStructuredValue(
  value: unknown,
  reasons: Set<string>,
  key = '',
): void {
  if (Array.isArray(value)) {
    value.forEach(item => scanStructuredValue(item, reasons, key));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (
      /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential|private[_-]?key)/i
        .test(key)
      && typeof value === 'string'
      && value.trim().length >= 8
      && !/^(?:<redacted>|\$\{[^}]+\}|example|placeholder)$/i.test(value.trim())
    ) {
      reasons.add('containment_secret_structured_value');
    }
    return;
  }
  for (const [childKey, child] of Object.entries(
    value as Record<string, unknown>,
  )) {
    scanStructuredValue(child, reasons, childKey);
  }
}

function noFollowFlag(): number {
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new Error('containment_no_follow_unavailable');
  }
  return fs.constants.O_NOFOLLOW;
}

function directoryFlag(): number {
  if (typeof fs.constants.O_DIRECTORY !== 'number') {
    throw new Error('containment_directory_flag_unavailable');
  }
  return fs.constants.O_DIRECTORY;
}

function closeOpenedDirectories(opened: readonly OpenedDirectory[]): void {
  for (const item of [...opened].reverse()) {
    try {
      fs.closeSync(item.descriptor);
    } catch {
      // The primary containment result remains authoritative.
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{3,160}$/.test(error.message)) {
    return error.message;
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return `containment_fs_${error.code.toLowerCase()}`;
  }
  return 'containment_probe_failed';
}
