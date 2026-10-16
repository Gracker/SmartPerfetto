// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {freezeEvidenceValue} from '../../services/evidence/evidenceCapture';
import type {InvestigationScanRecord} from '../../services/evidence/investigationEvidenceLedger';
import type {EvidenceReadView} from '../../services/evidence/evidenceReadView';
import {MAX_EVIDENCE_READ_REFERENCES} from '../../services/evidence/evidenceReadView';
import {DEFAULT_SCENE_RUN_LIMITS, type SceneScope, type SceneRunLimits, type SceneSegmentAssessment,
  type SceneProposalResult, type SceneTimelineSnapshot, type SceneDiagnostic, type SceneCoveragePlan, sceneNanosecondsSchema} from './sceneTimelineContract';
import {createScenePacingState, DEFAULT_SCENE_PACING_PER_TURN_MS, type ScenePacingInputs,
  type ScenePacingState} from './sceneProposalPacing';

const contexts = new WeakMap<object, SceneRunState>();
const snapshots = new WeakMap<object, SceneRunState>();
export interface SceneRunContextOptions extends SceneScope {
  deadlineMs: number; signal?: AbortSignal; assertAuthorized: () => void;
  traceBounds: {startNs: string; endNs: string};
  createEvidenceReadView: () => EvidenceReadView;
  limits?: Partial<SceneRunLimits>;
  /** Budget of a runtime whose deadline moves; a fixed-budget runtime omits it. */
  pacing?: ScenePacingInputs;
}
declare const sceneRunContextBrand: unique symbol;
/** Opaque issued capability: only createSceneRunContext mints one, and it confers nothing once revoked. */
export interface SceneRunContext {
  readonly [sceneRunContextBrand]: true;
}
/** Internal mutable state; possession of a JSON copy confers no capability. */
export interface SceneRunState {
  readonly options: Readonly<SceneRunContextOptions>;
  readonly limits: Readonly<SceneRunLimits>;
  revision: number; busy: boolean; revoked: boolean; frozen?: SceneTimelineSnapshot;
  segments: Map<string, SceneSegmentAssessment>;
  scanReceipts: Map<string, InvestigationScanRecord>; scanDiagnostics: SceneDiagnostic[];
  coveragePlan?: SceneCoveragePlan; coveragePlanInitialized?: boolean;
  proposals: Map<string, {fingerprint: string; result: SceneProposalResult}>;
  unresolved: readonly string[]; diagnostics: SceneDiagnostic[];
  pacing: ScenePacingState;
  consumed: {scanBytes: number; scanReceipts: number; candidates: number; bytes: number; references: number; receipts: number; dependencyEdges: number};
}
function assertSceneRunAuthorized(state: SceneRunState): void {
  if (state.revoked) throw new Error('scene_run_revoked');
  state.options.assertAuthorized();
  if (state.options.signal?.aborted) throw new Error('scene_run_cancelled');
}
export function assertSceneRunActive(state: SceneRunState, allowFrozen = false): void {
  assertSceneRunAuthorized(state);
  if (Date.now() >= state.options.deadlineMs) throw new Error('scene_run_deadline_exhausted');
  if (state.frozen && !allowFrozen) throw new Error('scene_run_frozen');
}
export function createSceneRunContext(options: SceneRunContextOptions): SceneRunContext {
  if (['runId', 'sessionId', 'traceId', 'ownerKey'].some(key => !options[key as keyof SceneScope]?.trim()) ||
      !Number.isSafeInteger(options.deadlineMs)) throw new Error('invalid_scene_scope');
  const bounds = {...options.traceBounds};
  sceneNanosecondsSchema.parse(bounds.startNs); sceneNanosecondsSchema.parse(bounds.endNs);
  if (BigInt(bounds.startNs) > BigInt(bounds.endNs)) throw new Error('invalid_scene_bounds');
  const limits = Object.freeze({...DEFAULT_SCENE_RUN_LIMITS, ...options.limits});
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0) ||
      limits.maxReferencesPerRead > MAX_EVIDENCE_READ_REFERENCES) throw new Error('invalid_scene_limits');
  const state: SceneRunState = {options: Object.freeze({...options, traceBounds: Object.freeze(bounds)}), limits,
    revision: 0, busy: false, revoked: false, segments: new Map(), scanReceipts: new Map(), scanDiagnostics: [], proposals: new Map(), unresolved: [], diagnostics: [],
    pacing: createScenePacingState(resolvePacingInputs(options)),
    consumed: {scanBytes: 0, scanReceipts: 0, candidates: 0, bytes: 0, references: 0, receipts: 0, dependencyEdges: 0}};
  assertSceneRunActive(state);
  const handle = Object.freeze({}) as SceneRunContext;
  contexts.set(handle, state);
  return handle;
}
/** A fixed-budget runtime supplies only its deadline: acquisition and the run end together. */
function resolvePacingInputs(options: SceneRunContextOptions): ScenePacingInputs {
  if (options.pacing) return options.pacing;
  const startedAt = Date.now();
  const deadline = options.deadlineMs;
  return {startedAt, baseBudgetMs: Math.max(1, deadline - startedAt), investigationLimitAt: deadline,
    current: () => deadline, perTurnMs: DEFAULT_SCENE_PACING_PER_TURN_MS};
}
function scopeMatches(actual: SceneScope, expected: SceneScope): boolean {
  return (['runId', 'sessionId', 'traceId', 'ownerKey'] as const).every(key => actual[key] === expected[key]);
}
export function sceneRunState(handle: SceneRunContext): SceneRunState {
  const state = contexts.get(handle);
  if (!state) throw new Error('unissued_scene_context');
  return state;
}
export async function mutateSceneRun<T>(handle: SceneRunContext, operation: (state: SceneRunState) => Promise<T>): Promise<T> {
  const state = sceneRunState(handle);
  assertSceneRunActive(state);
  if (state.busy) throw new Error('scene_mutation_in_progress');
  state.busy = true;
  try {return await operation(state);} finally {state.busy = false;}
}
/** Product closeout only: preserve committed work after expiry, without acquiring evidence.
 * An in-flight proposal must pass assertSceneRunActive before committing, so sealing
 * immediately closes its write path while retaining the last committed revision.
 */
export function sealSceneTimeline(handle: SceneRunContext): SceneTimelineSnapshot {
  const state = sceneRunState(handle);
  assertSceneRunAuthorized(state);
  if (state.frozen) return state.frozen;
  const {runId, sessionId, traceId} = state.options;
  const snapshot: SceneTimelineSnapshot = freezeEvidenceValue({schemaVersion: 'scene_timeline@1', runId, sessionId, traceId,
    revision: state.revision, segments: [...state.segments.values()], unresolved: [...state.unresolved],
    diagnostics: [...state.diagnostics], scanCoverage: {revision: state.revision,
      requestedWindow: {...state.options.traceBounds}, receipts: [...state.scanReceipts.values()],
      diagnostics: [...state.scanDiagnostics], maxUnionWindows: state.limits.maxScanUnionWindows,
      ...(state.coveragePlan ? {plan: state.coveragePlan} : {})}});
  snapshots.set(snapshot, state);
  state.frozen = snapshot;
  return snapshot;
}
export function assertIssuedSceneSnapshot(snapshot: SceneTimelineSnapshot, expected: SceneScope): void {
  const state = snapshots.get(snapshot);
  if (!state || state.frozen !== snapshot || !scopeMatches(state.options, expected)) throw new Error('unissued_scene_snapshot');
  assertSceneRunAuthorized(state);
}

/** Release at the product-owned terminal boundary, including failures and cancellation. */
export function revokeSceneRunContext(handle: SceneRunContext): void {
  const state = contexts.get(handle);
  if (!state) return;
  state.revoked = true;
  if (state.frozen) snapshots.delete(state.frozen);
  state.scanReceipts.clear(); state.scanDiagnostics = [];
  state.segments.clear(); state.proposals.clear(); state.unresolved = []; state.diagnostics = [];
  contexts.delete(handle);
}
