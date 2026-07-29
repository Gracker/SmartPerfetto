// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {
  ProviderMutationGenerationVectorV1,
} from '../providerManager/providerMutationGeneration';
import type {ProviderService} from '../providerManager/providerService';
import {
  resolveProviderRuntimeSnapshot,
} from '../providerManager/providerSnapshot';
import type {ProviderScope} from '../providerManager/types';
import type {
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
  RunInjectionCategory,
  RunManifestScope,
  RunManifestV1,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {__testing as evalContractTesting} from './evalContracts';
import type {RunManifestStore} from './runManifestStore';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INJECTION_CATEGORIES: RunInjectionCategory[] = [
  'patterns',
  'skillNotes',
  'cases',
  'phaseHints',
  'knowledgeDocs',
];

export interface EvaluationEnvironmentProofV1 {
  schemaVersion: 1;
  proofId: string;
  runId: string;
  runManifestId: string;
  evaluationStartContentHash: string;
  scope: RunManifestScope;
  pinned: EvalPinnedEnvironmentV1;
  providerSnapshotHash: string;
  providerMutationGeneration: ProviderMutationGenerationVectorV1;
  providerMutationGenerationFingerprint: string;
  injections: RunInjectionAttribution;
  injectionSetHash: string;
  injectionSelectorConfigFingerprint: string;
  environmentFingerprint: string;
  capturedAt: string;
  contentHash: string;
}

export interface EvaluationInjectionSelectorV1 {
  schemaVersion: 1;
  mode: EvalPinnedEnvironmentV1['injections'];
  selected: RunInjectionAttribution;
}

export interface EvaluationEnvironmentStartV1 {
  schemaVersion: 1;
  captureId: string;
  scope: RunManifestScope;
  pinned: EvalPinnedEnvironmentV1;
  providerSnapshotHash: string;
  providerMutationGeneration: ProviderMutationGenerationVectorV1;
  providerMutationGenerationFingerprint: string;
  injections: RunInjectionAttribution;
  injectionSetHash: string;
  injectionSelectorConfigFingerprint: string;
  environmentFingerprint: string;
  capturedAt: string;
  contentHash: string;
}

export interface CaptureEvaluationEnvironmentStartInput {
  providerService: ProviderService;
  scope: RunManifestScope;
  providerScope?: ProviderScope;
  pinned: EvalPinnedEnvironmentV1;
  selector: EvaluationInjectionSelectorV1;
  captureId?: string;
  capturedAt?: string;
  maxAttempts?: number;
}

export interface FinalizeEvaluationEnvironmentProofInput {
  providerService: ProviderService;
  providerScope?: ProviderScope;
  runManifestStore: RunManifestStore;
  start: EvaluationEnvironmentStartV1;
  runManifestId: string;
  proofId?: string;
  capturedAt?: string;
  maxAttempts?: number;
}

function nonempty(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function assertHash(value: unknown, error: string): string {
  const hash = nonempty(value, error);
  if (!SHA256_PATTERN.test(hash)) throw new Error(error);
  return hash;
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function assertProviderScope(
  scope: RunManifestScope,
  providerScope: ProviderScope | undefined,
): void {
  if (
    providerScope
    && (
      providerScope.tenantId !== scope.tenantId
      || providerScope.workspaceId !== scope.workspaceId
    )
  ) {
    throw new Error('evaluation_environment_provider_scope_mismatch');
  }
}

function assertGenerationScopeBinding(
  scope: RunManifestScope,
  providerScope: ProviderScope | undefined,
  generation: ProviderMutationGenerationVectorV1,
): void {
  const enterpriseEntries = generation.entries.filter(
    entry => entry.scope.level !== 'local',
  );
  if (enterpriseEntries.length === 0) return;
  if (!providerScope) {
    throw new Error('evaluation_environment_provider_scope_required');
  }
  assertProviderScope(scope, providerScope);
  if (enterpriseEntries.some(entry =>
    entry.scope.tenantId !== providerScope.tenantId
    || (
      entry.scope.workspaceId !== null
      && entry.scope.workspaceId !== providerScope.workspaceId
    )
    || (
      entry.scope.userId !== null
      && entry.scope.userId !== providerScope.userId
    ))) {
    throw new Error('evaluation_environment_provider_generation_scope_mismatch');
  }
}

function normalizeGeneration(
  value: ProviderMutationGenerationVectorV1,
): ProviderMutationGenerationVectorV1 {
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error('evaluation_environment_provider_generation_invalid');
  }
  const entries = value.entries.map(entry => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).some(
        key => key !== 'scope' && key !== 'revision' && key !== 'inFlight',
      )
      || !entry.scope
      || typeof entry.scope !== 'object'
      || Array.isArray(entry.scope)
      || Object.keys(entry.scope).some(
        key => !['level', 'tenantId', 'workspaceId', 'userId'].includes(key),
      )
    ) {
      throw new Error('evaluation_environment_provider_generation_invalid');
    }
    const level = entry.scope.level;
    if (!['local', 'org', 'workspace', 'personal'].includes(level)) {
      throw new Error('evaluation_environment_provider_generation_invalid');
    }
    const workspaceId = entry.scope.workspaceId;
    const userId = entry.scope.userId;
    if (
      !Number.isSafeInteger(entry.revision)
      || entry.revision < 0
      || !Number.isSafeInteger(entry.inFlight)
      || entry.inFlight < 0
      || (
        workspaceId !== null
        && (typeof workspaceId !== 'string' || !workspaceId.trim())
      )
      || (
        userId !== null
        && (typeof userId !== 'string' || !userId.trim())
      )
      || (
        level === 'local'
        && (
          entry.scope.tenantId !== 'local'
          || workspaceId !== null
          || userId !== null
        )
      )
      || (level === 'org' && (workspaceId !== null || userId !== null))
      || (level === 'workspace' && (!workspaceId || userId !== null))
      || (level === 'personal' && (!workspaceId || !userId))
    ) {
      throw new Error('evaluation_environment_provider_generation_invalid');
    }
    return {
      scope: {
        level,
        tenantId: nonempty(
          entry.scope.tenantId,
          'evaluation_environment_provider_generation_invalid',
        ),
        workspaceId,
        userId,
      },
      revision: entry.revision,
      inFlight: entry.inFlight,
    };
  });
  const keys = entries.map(entry => canonicalJsonString(entry.scope));
  if (new Set(keys).size !== keys.length) {
    throw new Error('evaluation_environment_provider_generation_duplicate_scope');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    entries,
  });
}

function assertNoInFlight(
  value: ProviderMutationGenerationVectorV1,
): void {
  if (value.entries.some(entry => entry.inFlight !== 0)) {
    throw new Error('evaluation_environment_provider_mutation_in_flight');
  }
}

export function normalizeRunInjections(
  value: RunInjectionAttribution,
): RunInjectionAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_environment_injections_invalid');
  }
  const unknown = Object.keys(value).filter(
    key => !INJECTION_CATEGORIES.includes(key as RunInjectionCategory),
  );
  if (unknown.length > 0) {
    throw new Error('evaluation_environment_injections_unknown_field');
  }
  const normalized = Object.fromEntries(INJECTION_CATEGORIES.map(category => {
    const refs = value[category];
    if (!Array.isArray(refs)) {
      throw new Error(`evaluation_environment_injections_invalid:${category}`);
    }
    const items = refs.map(ref => {
      if (
        !ref
        || typeof ref !== 'object'
        || Array.isArray(ref)
        || Object.keys(ref).some(key => key !== 'id' && key !== 'contentHash')
      ) {
        throw new Error(`evaluation_environment_injection_ref_invalid:${category}`);
      }
      return {
        id: nonempty(
          ref.id,
          `evaluation_environment_injection_id_invalid:${category}`,
        ),
        contentHash: assertHash(
          ref.contentHash,
          `evaluation_environment_injection_hash_invalid:${category}`,
        ),
      };
    }).sort((left, right) =>
      left.id.localeCompare(right.id)
      || left.contentHash.localeCompare(right.contentHash));
    if (new Set(items.map(item => item.id)).size !== items.length) {
      throw new Error(`evaluation_environment_injection_duplicate:${category}`);
    }
    return [category, items];
  })) as unknown as RunInjectionAttribution;
  return immutableCanonicalSnapshot(normalized);
}

export function normalizeEvaluationInjectionSelector(
  value: EvaluationInjectionSelectorV1,
): EvaluationInjectionSelectorV1 {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some(
      key => key !== 'schemaVersion' && key !== 'mode' && key !== 'selected',
    )
    || value.schemaVersion !== 1
    || !['on', 'off', 'selective'].includes(value.mode)
  ) {
    throw new Error('evaluation_environment_selector_invalid');
  }
  const selected = normalizeRunInjections(value.selected);
  if (value.mode === 'off' && hasInjections(selected)) {
    throw new Error('evaluation_environment_off_injections_not_empty');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    mode: value.mode,
    selected,
  });
}

function hasInjections(injections: RunInjectionAttribution): boolean {
  return INJECTION_CATEGORIES.some(category => injections[category].length > 0);
}

function environmentFingerprint(input: {
  pinned: EvalPinnedEnvironmentV1;
  providerSnapshotHash: string;
  providerMutationGenerationFingerprint: string;
  injectionSelectorConfigFingerprint: string;
}): string {
  return canonicalContentHash(input);
}

function injectionKeys(injections: RunInjectionAttribution): Set<string> {
  return new Set(INJECTION_CATEGORIES.flatMap(category =>
    injections[category].map(
      ref => `${category}\0${ref.id}\0${ref.contentHash}`,
    )));
}

function isInjectionSubset(
  actual: RunInjectionAttribution,
  allowed: RunInjectionAttribution,
): boolean {
  const allowedKeys = injectionKeys(allowed);
  return [...injectionKeys(actual)].every(key => allowedKeys.has(key));
}

function proofContentHash(
  proof: Omit<EvaluationEnvironmentProofV1, 'contentHash'>,
): string {
  return canonicalContentHash(proof);
}

function startContentHash(
  start: Omit<EvaluationEnvironmentStartV1, 'contentHash'>,
): string {
  return canonicalContentHash(start);
}

interface StableProviderSnapshotInput {
  providerService: ProviderService;
  scope: RunManifestScope;
  providerScope?: ProviderScope;
  pinned: EvalPinnedEnvironmentV1;
  maxAttempts?: number;
}

function stableProviderSnapshot(input: StableProviderSnapshotInput): {
  snapshotHash: string;
  generation: ProviderMutationGenerationVectorV1;
} {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = normalizeGeneration(
      input.providerService.getMutationGeneration(input.providerScope),
    );
    assertGenerationScopeBinding(input.scope, input.providerScope, before);
    assertNoInFlight(before);
    const resolution = resolveProviderRuntimeSnapshot(
      input.providerService,
      input.pinned.providerId,
      input.pinned.runtime,
      input.providerScope,
    );
    const after = normalizeGeneration(
      input.providerService.getMutationGeneration(input.providerScope),
    );
    assertGenerationScopeBinding(input.scope, input.providerScope, after);
    assertNoInFlight(after);
    if (canonicalJsonString(before) !== canonicalJsonString(after)) continue;
    if (resolution.snapshot.runtimeKind !== input.pinned.runtime) {
      throw new Error('evaluation_environment_runtime_mismatch');
    }
    if (resolution.snapshot.providerId !== input.pinned.providerId) {
      throw new Error('evaluation_environment_provider_mismatch');
    }
    if (
      input.pinned.model !== undefined
      && resolution.snapshot.resolvedModels.primary !== input.pinned.model
    ) {
      throw new Error('evaluation_environment_model_mismatch');
    }
    return {snapshotHash: resolution.snapshotHash, generation: after};
  }
  throw new Error('evaluation_environment_provider_snapshot_unstable');
}

export function captureEvaluationEnvironmentStart(
  input: CaptureEvaluationEnvironmentStartInput,
): EvaluationEnvironmentStartV1 {
  assertProviderScope(input.scope, input.providerScope);
  const pinned = evalContractTesting.parsePinned(input.pinned);
  const scope = evalContractTesting.parseScope(input.scope);
  const selector = normalizeEvaluationInjectionSelector(input.selector);
  if (pinned.injections !== selector.mode) {
    throw new Error('evaluation_environment_selector_mode_mismatch');
  }
  const selectorFingerprint = canonicalContentHash(selector);
  const injections = selector.selected;
  const stable = stableProviderSnapshot({...input, pinned, scope});
  const providerMutationGenerationFingerprint = canonicalContentHash(
    stable.generation,
  );
  const injectionSetHash = canonicalContentHash(injections);
  const startWithoutHash: Omit<EvaluationEnvironmentStartV1, 'contentHash'> = {
    schemaVersion: 1,
    captureId: input.captureId ?? randomUUID(),
    scope,
    pinned,
    providerSnapshotHash: stable.snapshotHash,
    providerMutationGeneration: stable.generation,
    providerMutationGenerationFingerprint,
    injections,
    injectionSetHash,
    injectionSelectorConfigFingerprint: selectorFingerprint,
    environmentFingerprint: environmentFingerprint({
      pinned,
      providerSnapshotHash: stable.snapshotHash,
      providerMutationGenerationFingerprint,
      injectionSelectorConfigFingerprint: selectorFingerprint,
    }),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  return immutableCanonicalSnapshot({
    ...startWithoutHash,
    contentHash: startContentHash(startWithoutHash),
  });
}

export function parseEvaluationEnvironmentStart(
  value: unknown,
): EvaluationEnvironmentStartV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_environment_start_invalid');
  }
  const start = value as EvaluationEnvironmentStartV1;
  const expectedKeys = [
    'schemaVersion',
    'captureId',
    'scope',
    'pinned',
    'providerSnapshotHash',
    'providerMutationGeneration',
    'providerMutationGenerationFingerprint',
    'injections',
    'injectionSetHash',
    'injectionSelectorConfigFingerprint',
    'environmentFingerprint',
    'capturedAt',
    'contentHash',
  ];
  if (
    start.schemaVersion !== 1
    || Object.keys(start).some(key => !expectedKeys.includes(key))
  ) {
    throw new Error('evaluation_environment_start_schema_invalid');
  }
  const normalized: EvaluationEnvironmentStartV1 = {
    schemaVersion: 1,
    captureId: nonempty(
      start.captureId,
      'evaluation_environment_capture_id_invalid',
    ),
    scope: evalContractTesting.parseScope(start.scope),
    pinned: evalContractTesting.parsePinned(start.pinned),
    providerSnapshotHash: assertHash(
      start.providerSnapshotHash,
      'evaluation_environment_provider_snapshot_hash_invalid',
    ),
    providerMutationGeneration: normalizeGeneration(
      start.providerMutationGeneration,
    ),
    providerMutationGenerationFingerprint: assertHash(
      start.providerMutationGenerationFingerprint,
      'evaluation_environment_provider_generation_fingerprint_invalid',
    ),
    injections: normalizeRunInjections(start.injections),
    injectionSetHash: assertHash(
      start.injectionSetHash,
      'evaluation_environment_injection_set_hash_invalid',
    ),
    injectionSelectorConfigFingerprint: assertHash(
      start.injectionSelectorConfigFingerprint,
      'evaluation_environment_selector_fingerprint_invalid',
    ),
    environmentFingerprint: assertHash(
      start.environmentFingerprint,
      'evaluation_environment_fingerprint_invalid',
    ),
    capturedAt: nonempty(
      start.capturedAt,
      'evaluation_environment_captured_at_invalid',
    ),
    contentHash: assertHash(
      start.contentHash,
      'evaluation_environment_content_hash_invalid',
    ),
  };
  if (!Number.isFinite(Date.parse(normalized.capturedAt))) {
    throw new Error('evaluation_environment_captured_at_invalid');
  }
  if (normalized.pinned.injections === 'off' && hasInjections(normalized.injections)) {
    throw new Error('evaluation_environment_off_injections_not_empty');
  }
  assertNoInFlight(normalized.providerMutationGeneration);
  const generationFingerprint = canonicalContentHash(
    normalized.providerMutationGeneration,
  );
  const injectionSetHash = canonicalContentHash(normalized.injections);
  const selectorFingerprint = canonicalContentHash(
    normalizeEvaluationInjectionSelector({
      schemaVersion: 1,
      mode: normalized.pinned.injections,
      selected: normalized.injections,
    }),
  );
  const expectedEnvironmentFingerprint = environmentFingerprint({
    pinned: normalized.pinned,
    providerSnapshotHash: normalized.providerSnapshotHash,
    providerMutationGenerationFingerprint: generationFingerprint,
    injectionSelectorConfigFingerprint:
      normalized.injectionSelectorConfigFingerprint,
  });
  if (
    normalized.providerMutationGenerationFingerprint !== generationFingerprint
    || normalized.injectionSetHash !== injectionSetHash
    || normalized.injectionSelectorConfigFingerprint !== selectorFingerprint
    || normalized.environmentFingerprint !== expectedEnvironmentFingerprint
  ) {
    throw new Error('evaluation_environment_start_fingerprint_mismatch');
  }
  const {contentHash, ...withoutHash} = normalized;
  if (contentHash !== startContentHash(withoutHash)) {
    throw new Error('evaluation_environment_start_content_hash_mismatch');
  }
  return immutableCanonicalSnapshot(normalized);
}

export function evaluationEnvironmentManifestBinding(
  startValue: EvaluationEnvironmentStartV1,
): Record<string, string> {
  const start = parseEvaluationEnvironmentStart(startValue);
  return immutableCanonicalSnapshot({
    evaluationEnvironmentStartContentHash: start.contentHash,
    evaluationInjectionMode: start.pinned.injections,
    evaluationInjectionSelectorConfigFingerprint:
      start.injectionSelectorConfigFingerprint,
  });
}

function pinnedFromManifest(
  manifest: RunManifestV1,
  injectionMode: EvalPinnedEnvironmentV1['injections'],
): EvalPinnedEnvironmentV1 {
  return evalContractTesting.parsePinned({
    runtime: manifest.runtime,
    providerId: manifest.providerId,
    ...(manifest.model === undefined ? {} : {model: manifest.model}),
    outputLanguage: manifest.outputLanguage,
    toolAllowlistHash: manifest.toolAllowlistHash,
    injections: injectionMode,
    overlayGeneration: manifest.evolutionOverlayGeneration,
  });
}

export function finalizeEvaluationEnvironmentProof(
  input: FinalizeEvaluationEnvironmentProofInput,
): EvaluationEnvironmentProofV1 {
  const start = parseEvaluationEnvironmentStart(input.start);
  assertProviderScope(start.scope, input.providerScope);
  const runManifestId = nonempty(
    input.runManifestId,
    'evaluation_environment_run_manifest_id_invalid',
  );
  const manifest = input.runManifestStore.get(start.scope, runManifestId);
  if (!manifest) throw new Error('evaluation_environment_run_manifest_not_found');
  if (!sameScope(start.scope, manifest.scope)) {
    throw new Error('evaluation_environment_run_manifest_scope_mismatch');
  }
  const startedAt = Date.parse(start.capturedAt);
  if (
    !Number.isSafeInteger(manifest.sealedAt)
    || manifest.sealedAt < startedAt
  ) {
    throw new Error('evaluation_environment_run_manifest_time_invalid');
  }
  const featureFlags = manifest.featureFlagSnapshot;
  if (
    !featureFlags
    || featureFlags.evaluationEnvironmentStartContentHash !== start.contentHash
    || featureFlags.evaluationInjectionMode !== start.pinned.injections
    || featureFlags.evaluationInjectionSelectorConfigFingerprint
      !== start.injectionSelectorConfigFingerprint
  ) {
    throw new Error('evaluation_environment_run_manifest_binding_mismatch');
  }
  const actualPinned = pinnedFromManifest(
    manifest,
    start.pinned.injections,
  );
  const actualInjections = normalizeRunInjections(manifest.injections);
  if (
    canonicalJsonString(actualPinned) !== canonicalJsonString(start.pinned)
  ) {
    throw new Error('evaluation_environment_run_manifest_environment_mismatch');
  }
  if (
    (start.pinned.injections === 'off' && hasInjections(actualInjections))
    || (
      start.pinned.injections === 'selective'
      && !isInjectionSubset(actualInjections, start.injections)
    )
  ) {
    throw new Error('evaluation_environment_run_manifest_injections_mismatch');
  }
  const stable = stableProviderSnapshot({
    providerService: input.providerService,
    scope: start.scope,
    providerScope: input.providerScope,
    pinned: actualPinned,
    maxAttempts: input.maxAttempts,
  });
  const generationFingerprint = canonicalContentHash(stable.generation);
  if (
    stable.snapshotHash !== start.providerSnapshotHash
    || generationFingerprint
      !== start.providerMutationGenerationFingerprint
  ) {
    throw new Error('evaluation_environment_changed_during_run');
  }
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(capturedAt))
    || Date.parse(capturedAt) < manifest.sealedAt
  ) {
    throw new Error('evaluation_environment_final_capture_time_invalid');
  }
  const proofWithoutHash: Omit<EvaluationEnvironmentProofV1, 'contentHash'> = {
    schemaVersion: 1,
    proofId: input.proofId ?? randomUUID(),
    runId: nonempty(manifest.runId, 'evaluation_environment_run_id_invalid'),
    runManifestId,
    evaluationStartContentHash: start.contentHash,
    scope: start.scope,
    pinned: actualPinned,
    providerSnapshotHash: start.providerSnapshotHash,
    providerMutationGeneration: start.providerMutationGeneration,
    providerMutationGenerationFingerprint:
      start.providerMutationGenerationFingerprint,
    injections: actualInjections,
    injectionSetHash: canonicalContentHash(actualInjections),
    injectionSelectorConfigFingerprint:
      start.injectionSelectorConfigFingerprint,
    environmentFingerprint: start.environmentFingerprint,
    capturedAt,
  };
  return immutableCanonicalSnapshot({
    ...proofWithoutHash,
    contentHash: proofContentHash(proofWithoutHash),
  });
}

export function parseEvaluationEnvironmentProof(
  value: unknown,
): EvaluationEnvironmentProofV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_environment_proof_invalid');
  }
  const proof = value as EvaluationEnvironmentProofV1;
  const expectedKeys = [
    'schemaVersion',
    'proofId',
    'runId',
    'runManifestId',
    'evaluationStartContentHash',
    'scope',
    'pinned',
    'providerSnapshotHash',
    'providerMutationGeneration',
    'providerMutationGenerationFingerprint',
    'injections',
    'injectionSetHash',
    'injectionSelectorConfigFingerprint',
    'environmentFingerprint',
    'capturedAt',
    'contentHash',
  ];
  if (
    proof.schemaVersion !== 1
    || Object.keys(proof).some(key => !expectedKeys.includes(key))
  ) {
    throw new Error('evaluation_environment_proof_schema_invalid');
  }
  const normalized: EvaluationEnvironmentProofV1 = {
    schemaVersion: 1,
    proofId: nonempty(proof.proofId, 'evaluation_environment_proof_id_invalid'),
    runId: nonempty(proof.runId, 'evaluation_environment_run_id_invalid'),
    runManifestId: nonempty(
      proof.runManifestId,
      'evaluation_environment_run_manifest_id_invalid',
    ),
    evaluationStartContentHash: assertHash(
      proof.evaluationStartContentHash,
      'evaluation_environment_start_content_hash_invalid',
    ),
    scope: evalContractTesting.parseScope(proof.scope),
    pinned: evalContractTesting.parsePinned(proof.pinned),
    providerSnapshotHash: assertHash(
      proof.providerSnapshotHash,
      'evaluation_environment_provider_snapshot_hash_invalid',
    ),
    providerMutationGeneration: normalizeGeneration(
      proof.providerMutationGeneration,
    ),
    providerMutationGenerationFingerprint: assertHash(
      proof.providerMutationGenerationFingerprint,
      'evaluation_environment_provider_generation_fingerprint_invalid',
    ),
    injections: normalizeRunInjections(proof.injections),
    injectionSetHash: assertHash(
      proof.injectionSetHash,
      'evaluation_environment_injection_set_hash_invalid',
    ),
    injectionSelectorConfigFingerprint: assertHash(
      proof.injectionSelectorConfigFingerprint,
      'evaluation_environment_selector_fingerprint_invalid',
    ),
    environmentFingerprint: assertHash(
      proof.environmentFingerprint,
      'evaluation_environment_fingerprint_invalid',
    ),
    capturedAt: nonempty(
      proof.capturedAt,
      'evaluation_environment_captured_at_invalid',
    ),
    contentHash: assertHash(
      proof.contentHash,
      'evaluation_environment_content_hash_invalid',
    ),
  };
  if (!Number.isFinite(Date.parse(normalized.capturedAt))) {
    throw new Error('evaluation_environment_captured_at_invalid');
  }
  if (normalized.pinned.injections === 'off' && hasInjections(normalized.injections)) {
    throw new Error('evaluation_environment_off_injections_not_empty');
  }
  assertNoInFlight(normalized.providerMutationGeneration);
  const generationFingerprint = canonicalContentHash(
    normalized.providerMutationGeneration,
  );
  const injectionSetHash = canonicalContentHash(normalized.injections);
  const expectedEnvironmentFingerprint = environmentFingerprint({
    pinned: normalized.pinned,
    providerSnapshotHash: normalized.providerSnapshotHash,
    providerMutationGenerationFingerprint: generationFingerprint,
    injectionSelectorConfigFingerprint:
      normalized.injectionSelectorConfigFingerprint,
  });
  if (
    normalized.providerMutationGenerationFingerprint !== generationFingerprint
    || normalized.injectionSetHash !== injectionSetHash
    || normalized.environmentFingerprint !== expectedEnvironmentFingerprint
  ) {
    throw new Error('evaluation_environment_proof_fingerprint_mismatch');
  }
  const {contentHash, ...withoutHash} = normalized;
  if (contentHash !== proofContentHash(withoutHash)) {
    throw new Error('evaluation_environment_proof_content_hash_mismatch');
  }
  return immutableCanonicalSnapshot(normalized);
}

export function assertEvaluationProofMatchesScore(
  score: EvalScoreV1,
  proofValue: EvaluationEnvironmentProofV1,
): EvaluationEnvironmentProofV1 {
  const proof = parseEvaluationEnvironmentProof(proofValue);
  if (
    !sameScope(score.scope, proof.scope)
    || score.runId !== proof.runId
    || score.runManifestId !== proof.runManifestId
    || canonicalJsonString(score.pinned) !== canonicalJsonString(proof.pinned)
  ) {
    throw new Error('eval_score_environment_proof_mismatch');
  }
  return proof;
}

export function assertComparableEvaluationProofs(
  baselineValue: EvaluationEnvironmentProofV1,
  candidateValue: EvaluationEnvironmentProofV1,
): void {
  const baseline = parseEvaluationEnvironmentProof(baselineValue);
  const candidate = parseEvaluationEnvironmentProof(candidateValue);
  if (
    !sameScope(baseline.scope, candidate.scope)
    || baseline.environmentFingerprint !== candidate.environmentFingerprint
  ) {
    throw new Error('evaluation_environment_not_comparable');
  }
}

export const __testing = {
  environmentFingerprint,
  hasInjections,
  normalizeGeneration,
  proofContentHash,
  startContentHash,
};
