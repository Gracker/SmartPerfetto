// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisOptions} from '../core/orchestratorTypes';
import {createHash} from 'crypto';
import type {ArtifactStore} from '../../agentv3/artifactStore';
import {createRuntimeEvidenceContext, resolveRuntimeEvidenceStore,
  type RuntimeEvidenceBinding, type RuntimeEvidenceContext} from '../../agentRuntime/runtimeEvidenceContext';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {normalizeResourceOwner, type ResourceOwnerFields} from '../../services/resourceOwnership';
import {assertSceneRunActive, createSceneRunContext, revokeSceneRunContext, sceneRunState, sealSceneTimeline,
  type SceneRunContext} from './sceneRunContext';
import {sceneNanosecondsSchema, type SceneScope, type SceneTimelineSnapshot} from './sceneTimelineContract';
import {initializeSceneCoveragePlan, type SceneCoverageRegistrySnapshot} from './sceneCoveragePlan';
import type {ScenePacingInputs} from './sceneProposalPacing';
import {createDeadlineRuntimeTimeout} from '../../agentRuntime/runtimeLimits';

const dispatchKey = Symbol('scene product dispatch');
const dispatches = new WeakMap<object, DispatchState>();
const capabilities = new WeakMap<SceneRunContext, DispatchState>();
const seals = new WeakMap<object, {state: DispatchState; snapshot: SceneTimelineSnapshot}>();
declare const sealBrand: unique symbol;
export interface SceneRuntimeSeal {readonly [sealBrand]: true}
interface DispatchState {
  scope: Readonly<SceneScope>; signal: AbortSignal; assertCurrent(): void;
  lifecycle: AbortController;
  released: boolean; evidenceContext?: RuntimeEvidenceContext; evidenceBinding?: RuntimeEvidenceBinding;
  activation?: Promise<SceneRunContext>; context?: SceneRunContext; seal?: SceneRuntimeSeal;
}
export interface SceneRunDispatchBinding {
  readonly scope: Readonly<SceneScope>;
  bindOptions<T extends AnalysisOptions>(options: T): T;
  seal(): SceneRuntimeSeal | undefined;
  release(): void;
}
export function sceneRunOwnerKey(input: ResourceOwnerFields): string {
  const owner = normalizeResourceOwner(input);
  return createHash('sha256').update(JSON.stringify([owner.tenantId, owner.workspaceId, owner.userId ?? null])).digest('hex');
}
function assertDispatchActive(state: DispatchState): void {
  if (state.released) throw new Error('scene_dispatch_released');
  state.signal.throwIfAborted();
  state.assertCurrent();
  state.signal.throwIfAborted();
}
function sameScope(actual: SceneScope, expected: SceneScope): boolean {
  return (['runId', 'sessionId', 'traceId', 'ownerKey'] as const).every(key => actual[key] === expected[key]);
}
function resolveDispatch(options: AnalysisOptions,
  actual: {runId: string; sessionId: string; traceId: string}): DispatchState | undefined {
  if (!Object.prototype.hasOwnProperty.call(options, dispatchKey)) return undefined;
  const token = (options as AnalysisOptions & {[dispatchKey]?: object})[dispatchKey];
  const state = token && dispatches.get(token);
  if (!state) throw new Error('unissued_scene_dispatch');
  assertDispatchActive(state);
  if (!state.evidenceBinding || options.runId !== state.scope.runId ||
      (['runId', 'sessionId', 'traceId'] as const).some(key => actual[key] !== state.scope[key])) {
    throw new Error('scene_dispatch_scope_mismatch');
  }
  return state;
}
/** Product authority survives internal spreads, never JSON, replay, or model arguments. */
export function resolveSceneProductScope(options: AnalysisOptions,
  actual: {runId: string; sessionId: string; traceId: string}): SceneScope | undefined {
  return resolveDispatch(options, actual)?.scope;
}
/** Admission creates only an opaque token; bind the final options after admission. */
export function createSceneRunDispatchBinding(input: {
  scope: SceneScope; signal: AbortSignal; assertCurrent(): void;
}): SceneRunDispatchBinding {
  if ((['runId', 'sessionId', 'traceId', 'ownerKey'] as const).some(key =>
    typeof input.scope[key] !== 'string' || !input.scope[key].trim())) {
    throw new Error('invalid_scene_scope');
  }
  const lifecycle = new AbortController();
  const state: DispatchState = {scope: Object.freeze({...input.scope}), signal: AbortSignal.any([input.signal, lifecycle.signal]), lifecycle,
    assertCurrent: input.assertCurrent, released: false};
  assertDispatchActive(state);
  const token = Object.freeze({});
  dispatches.set(token, state);
  return Object.freeze({
    scope: state.scope,
    bindOptions<T extends AnalysisOptions>(options: T): T {
      assertDispatchActive(state);
      if (state.evidenceBinding) throw new Error('scene_dispatch_already_bound');
      if (options.runId !== undefined && options.runId !== state.scope.runId) throw new Error('scene_dispatch_scope_mismatch');
      if (sceneRunOwnerKey(options) !== state.scope.ownerKey) throw new Error('scene_dispatch_owner_mismatch');
      const context = createRuntimeEvidenceContext({logicalSessionId: state.scope.sessionId,
        traceId: state.scope.traceId, options});
      state.evidenceContext = context;
      const binding = context.bind(options, {runtimeSessionId: state.scope.sessionId,
        runId: state.scope.runId, signal: state.signal, assertAuthorized: () => assertDispatchActive(state)});
      state.evidenceBinding = binding;
      return {...binding.options, [dispatchKey]: token};
    },
    seal() {
      assertDispatchActive(state);
      if (!state.context) return undefined;
      if (!state.seal) {
        const snapshot = sealSceneTimeline(state.context);
        state.seal = Object.freeze({}) as SceneRuntimeSeal;
        seals.set(state.seal, {state, snapshot});
      }
      return state.seal;
    },
    release() {
      if (state.released) return;
      state.released = true;
      state.lifecycle.abort(new Error('scene_dispatch_released'));
      if (state.context) {capabilities.delete(state.context); revokeSceneRunContext(state.context);}
      if (state.seal) seals.delete(state.seal);
      state.evidenceBinding?.release();
      state.evidenceContext?.dispose();
      dispatches.delete(token);
    },
  });
}
/** Bind only the runtime's exact issued store and original absolute deadline. */
export async function activateSceneRuntime(options: AnalysisOptions, actual: {
  sessionId: string; traceId: string; runId: string; deadlineMs: number;
  traceProcessorService: Pick<TraceProcessorService, 'query'>; artifactStore: ArtifactStore;
  sceneCoverageRegistry?: SceneCoverageRegistrySnapshot;
  signal?: AbortSignal; canInvokeTool?: () => boolean;
  /** Budget of a runtime whose deadline moves; fixed-budget runtimes derive it from deadlineMs. */
  pacing?: ScenePacingInputs;
}): Promise<SceneRunContext | undefined> {
  const state = resolveDispatch(options, actual);
  if (!state) return undefined;
  const store = resolveRuntimeEvidenceStore(options, actual, () => {throw new Error('scene_evidence_binding_required');});
  if (store !== actual.artifactStore) throw new Error('scene_evidence_store_mismatch');
  if (state.activation) throw new Error('scene_runtime_already_activated');
  if (!Number.isSafeInteger(actual.deadlineMs) || Date.now() >= actual.deadlineMs) throw new Error('scene_run_deadline_exhausted');
  const assertAcquisition = () => {
    assertDispatchActive(state);
    actual.signal?.throwIfAborted();
    if (actual.canInvokeTool?.() === false) throw new Error('scene_runtime_acquisition_closed');
    if (Date.now() >= actual.deadlineMs) throw new Error('scene_run_deadline_exhausted');
  };
  state.activation = (async () => {
    assertAcquisition();
    const timeoutMs = actual.deadlineMs === Number.MAX_SAFE_INTEGER ? undefined : Math.max(1, actual.deadlineMs - Date.now());
    const deadlineController = new AbortController();
    const deadline = timeoutMs === undefined ? undefined : createDeadlineRuntimeTimeout({
      deadlineAt: () => actual.deadlineMs, message: () => 'scene_run_deadline_exhausted',
      onTimeout: () => deadlineController.abort(new Error('scene_run_deadline_exhausted')),
    });
    void deadline?.promise.catch(() => undefined);
    const signal = AbortSignal.any([state.signal, ...(actual.signal ? [actual.signal] : []), deadlineController.signal]);
    const result = await actual.traceProcessorService.query(actual.traceId,
      'SELECT CAST(start_ts AS TEXT) AS start_ns, CAST(end_ts AS TEXT) AS end_ns FROM trace_bounds',
      {signal, ...(timeoutMs === undefined ? {} : {timeoutMs})}).finally(() => deadline?.clear());
    assertAcquisition();
    if (result.error || result.columns.length !== 2 || result.columns[0] !== 'start_ns' || result.columns[1] !== 'end_ns' ||
        result.rows.length !== 1 || result.rows[0].length !== 2) throw new Error('scene_trace_bounds_unavailable');
    const [startNs, endNs] = result.rows[0];
    if (!sceneNanosecondsSchema.safeParse(startNs).success || !sceneNanosecondsSchema.safeParse(endNs).success ||
        BigInt(startNs) > BigInt(endNs)) throw new Error('scene_trace_bounds_invalid');
    const context = createSceneRunContext({...state.scope, deadlineMs: actual.deadlineMs,
      signal: state.signal, assertAuthorized: () => assertDispatchActive(state), traceBounds: {startNs, endNs},
      pacing: actual.pacing,
      createEvidenceReadView: () => {
        assertAcquisition();
        const view = store.createEvidenceReadView({ownerKey: state.scope.ownerKey,
          allowedTraces: [{traceId: state.scope.traceId, traceSide: 'current'}]});
        return Object.freeze({
          investigationEvidence: view.investigationEvidence ? () => {
            assertAcquisition();
            return view.investigationEvidence!();
          } : undefined,
          async resolveReferences(requests, signal) {
            assertAcquisition();
            const result = await view.resolveReferences(requests, signal);
            assertAcquisition();
            return result;
          },
        } satisfies import('../../services/evidence/evidenceReadView').EvidenceReadView);
      }});
    state.context = context;
    capabilities.set(context, state);
    initializeSceneCoveragePlan(context, actual.sceneCoverageRegistry);
    return context;
  })();
  return state.activation;
}
/** MCP hosts cannot gain scene authority by accepting a structural JSON object. */
export function assertSceneRuntimeCapability(context: SceneRunContext,
  actual: {sessionId?: string; traceId: string}): void {
  const state = capabilities.get(context);
  if (!state || actual.sessionId !== state.scope.sessionId || actual.traceId !== state.scope.traceId) {
    throw new Error('unissued_scene_runtime_capability');
  }
  assertDispatchActive(state);
  assertSceneRunActive(sceneRunState(context));
}
/** Consume before product assessment; release the owning binding after finalization. */
export function consumeSceneRuntimeSeal(seal: SceneRuntimeSeal, expectedScope: SceneScope): SceneTimelineSnapshot {
  const issued = seals.get(seal);
  if (!issued || !sameScope(issued.state.scope, expectedScope)) throw new Error('unissued_scene_runtime_seal');
  assertDispatchActive(issued.state);
  seals.delete(seal);
  return issued.snapshot;
}
