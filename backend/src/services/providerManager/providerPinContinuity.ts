// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {readPiAgentCoreModelConfig} from '../../agentRuntime/engines/pi/piAgentCoreConfig';
import {
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  isProductionAgentRuntimeKind,
  isRecordedRuntimeKind,
  type AgentRuntimeKind,
  type RecordedProductionRuntimeKind,
  type RecordedRuntimeKind,
} from '../../agentRuntime/runtimeKinds';
import {piRequestOrigin, resolvePiRouteFromLegacyEnv, runtimeEnvFor} from './piProviderCatalog';
import {storedProviderRecord} from './retiredRuntime';
import {
  legacyRuntimeSnapshotOf,
  type ProviderRuntimeSnapshotResolution,
} from './providerSnapshot';
import type {ProviderService} from './providerService';
import type {ProviderConfig, ProviderScope} from './types';

/**
 * Provenance a recovered session or conversation records when its pin was
 * rebound across the move to Pi Agent Core: the retired runtime and the
 * snapshot hash it was recorded under.
 */
export interface RuntimeMigrationContinuityNote {
  at: number;
  fromRuntimeKind: RecordedRuntimeKind;
  toRuntimeKind: AgentRuntimeKind;
  previousProviderSnapshotHash: string;
}

/** A pin recorded by an earlier run: provider, runtime label, hash and the authorization it ran under. */
export interface RecordedProviderPin {
  providerId: string | null;
  runtimeKind?: string;
  snapshotHash: string;
  analysisContextFingerprint?: string;
}

export type ProviderPinContinuity =
  | {status: 'unchanged'}
  | {status: 'migrated'; note: RuntimeMigrationContinuityNote}
  | {status: 'changed'};

interface RequestTarget {
  origin: string;
  model: string;
}

function legacyRequestTarget(
  providerService: ProviderService,
  current: ProviderConfig | undefined,
  kind: RecordedProductionRuntimeKind,
): RequestTarget | undefined {
  // What the retired runtime called: the record as it was stored, before the read-time migration.
  // OpenCode named its endpoint inside its own model JSON; the migration's translation of that
  // JSON into the OpenAI-compatible fields is what it called.
  const resolution = current
    ? providerService.legacyPiRoute(kind === OPENCODE_RUNTIME_KIND ? current : storedProviderRecord(current), kind)
    : resolvePiRouteFromLegacyEnv(process.env, kind, {provider: 'legacy', hostCredentialChain: true});
  if (resolution.status !== 'resolved') return undefined;
  const origin = piRequestOrigin(resolution.route.baseUrl);
  return origin ? {origin, model: resolution.route.id} : undefined;
}

function currentRequestTarget(
  providerService: ProviderService,
  current: ProviderConfig | undefined,
): RequestTarget | undefined {
  const env = current
    ? providerService.getEnvForProviderUnderRuntime(current, PI_AGENT_CORE_RUNTIME_KIND)
    : runtimeEnvFor(process.env, null, PI_AGENT_CORE_RUNTIME_KIND);
  try {
    // The parser copies a catalog or route reference's id and baseUrl into `model`.
    const model = readPiAgentCoreModelConfig(env)?.model;
    const origin = piRequestOrigin(typeof model?.baseUrl === 'string' ? model.baseUrl : undefined);
    return origin && typeof model?.id === 'string' ? {origin, model: model.id} : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a recorded pin still describes the current one. Equal hashes (and
 * runtime) are unchanged. A pin recorded under a retired runtime is migrated
 * only when every condition holds: the legacy hash recomputed from the current
 * record under that runtime equals the recorded hash, the effective request
 * origin (scheme, host, port, base path) and model id are what the retired
 * runtime called, and the authorization fingerprint is unchanged. Anything
 * else is changed, and the caller's existing explicit outcome applies.
 */
export function reconcileRecordedProviderPin(
  providerService: ProviderService,
  recorded: RecordedProviderPin,
  current: ProviderRuntimeSnapshotResolution,
  options: {providerScope?: ProviderScope; currentAnalysisContextFingerprint?: string; now?: number} = {},
): ProviderPinContinuity {
  const currentKind = current.snapshot.runtimeKind;
  if (recorded.snapshotHash === current.snapshotHash && (!recorded.runtimeKind || recorded.runtimeKind === currentKind)) {
    return {status: 'unchanged'};
  }
  const recordedKind = recorded.runtimeKind;
  if (!isRecordedRuntimeKind(recordedKind) || recordedKind === currentKind
    || recorded.providerId !== current.snapshot.providerId
    || recorded.analysisContextFingerprint !== options.currentAnalysisContextFingerprint) {
    return {status: 'changed'};
  }
  try {
    // One read of the record serves the legacy hash and both request targets.
    const record = recorded.providerId === null
      ? undefined : providerService.getRawProvider(recorded.providerId, options.providerScope);
    if (recorded.providerId !== null && !record) return {status: 'changed'};
    const legacy = legacyRuntimeSnapshotOf(providerService, record, recordedKind);
    if (!legacy || legacy.snapshotHash !== recorded.snapshotHash) return {status: 'changed'};
    const before = legacyRequestTarget(providerService, record, legacy.snapshot.runtimeKind);
    const after = currentKind === PI_AGENT_CORE_RUNTIME_KIND ? currentRequestTarget(providerService, record) : undefined;
    if (!before || !after || before.origin !== after.origin || before.model !== after.model) return {status: 'changed'};
  } catch {
    return {status: 'changed'};
  }
  return {status: 'migrated', note: {at: options.now ?? Date.now(), fromRuntimeKind: recordedKind,
    toRuntimeKind: currentKind, previousProviderSnapshotHash: recorded.snapshotHash}};
}

/** A persisted continuity note, or undefined when the stored value is not one. */
export function parseRuntimeMigrationContinuityNote(value: unknown): RuntimeMigrationContinuityNote | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const note = value as Partial<RuntimeMigrationContinuityNote>;
  return typeof note.at === 'number' && Number.isFinite(note.at)
    && isRecordedRuntimeKind(note.fromRuntimeKind) && isProductionAgentRuntimeKind(note.toRuntimeKind)
    && typeof note.previousProviderSnapshotHash === 'string' && note.previousProviderSnapshotHash.length > 0
    ? {at: note.at, fromRuntimeKind: note.fromRuntimeKind, toRuntimeKind: note.toRuntimeKind,
        previousProviderSnapshotHash: note.previousProviderSnapshotHash}
    : undefined;
}
