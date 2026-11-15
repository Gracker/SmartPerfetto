// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {ArtifactStore} from '../../../agentv3/artifactStore';
import {resolveRuntimeEvidenceStore} from '../../../agentRuntime/runtimeEvidenceContext';
import {captureEvidenceTable} from '../../../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';
import {normalizeResourceOwner} from '../../../services/resourceOwnership';
import type {QueryResult} from '../../../services/traceProcessorService';
import {activateSceneRuntime, assertSceneRuntimeCapability, consumeSceneRuntimeSeal, createSceneRunDispatchBinding,
  resolveSceneProductScope, sceneRunOwnerKey, type SceneRunDispatchBinding, type SceneRuntimeSeal} from '../sceneRuntimeBinding';
import {proposeSceneTimeline} from '../sceneTimelineProposal';
import {assessSceneTimeline} from '../sceneTimelineAssessment';
import {sceneRunState} from '../sceneRunContext';
import type {SceneTimelineSegment} from '../sceneTimelineContract';
import {snapshotSceneCoverageRegistry} from '../sceneCoveragePlan';
import * as strategyLoader from '../../../agentv3/strategyLoader';
import {fingerprintSkillDefinition} from '../../../services/selfEvolution/skillFingerprint';
import type {SkillDefinition} from '../../../services/skillEngine/types';

const bindings: SceneRunDispatchBinding[] = [];
const baseScope = {runId: 'scene-run', sessionId: 'scene-session', traceId: 'scene-trace', ownerKey: sceneRunOwnerKey({})};
const bounds: QueryResult = {columns: ['start_ns', 'end_ns'], rows: [['9007199254740992', '9007199254741992']], durationMs: 0};
function fixture(input: {runId?: string; result?: QueryResult} = {}) {
  const controller = new AbortController();
  const scope = {...baseScope, runId: input.runId ?? baseScope.runId};
  let current = true;
  let acquisition = true;
  const binding = createSceneRunDispatchBinding({scope, signal: controller.signal,
    assertCurrent: () => {if (!current) throw new Error('owner_not_current');}});
  bindings.push(binding);
  const options = binding.bindOptions({runId: scope.runId, packageName: 'example.app'});
  const store = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('unexpected_fallback');});
  const query = jest.fn(async (_traceId: string, _sql: string, _options?: {signal?: AbortSignal; timeoutMs?: number}) => input.result ?? bounds);
  const actual = {...scope, artifactStore: store, traceProcessorService: {query}, deadlineMs: Date.now() + 60000,
    signal: controller.signal, canInvokeTool: () => acquisition};
  return {scope, controller, binding, options, store, query, actual,
    revoke: () => {current = false;}, close: () => {acquisition = false;}};
}
function capture(store: ArtifactStore) {
  const data = {columns: ['start_ns', 'end_ns', 'upid'], rows: [['9007199254740992', '9007199254740993', '7']]};
  const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'scene-fixture@1', skillId: 'fixture', stepId: 'facts'};
  const artifactId = store.store({skillId: 'fixture', stepId: 'facts', data,
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: baseScope.traceId, traceSide: 'current'})});
  store.registerEvidenceCapture(artifactId, captureEvidenceTable(data, {
    start_ns: {origin, timeRole: 'start', clock: 'trace_monotonic', unit: 'ns'},
    end_ns: {origin, timeRole: 'end', clock: 'trace_monotonic', unit: 'ns'}, upid: {origin, identityRole: 'upid'},
  }), {evidenceRefId: 'scene-evidence', originRunId: 'model-cannot-select-origin'});
  return artifactId;
}
function proposal(artifactId: string) {
  const segment: SceneTimelineSegment = {id: 'segment', startNs: '9007199254740992', endNs: '9007199254740993',
    object: {kind: 'upid', key: '7'}, userAction: 'Input unknown', deviceState: 'State unknown', appResponse: 'Observed interval',
    evidenceRefs: [{artifactId, rowIndex: 0}], dependencies: [], supersedes: [],
    boundaries: {start: {source: 'evidence', evidenceIndex: 0, column: 'start_ns'},
      end: {source: 'evidence', evidenceIndex: 0, column: 'end_ns'}}};
  return {baseRevision: 0, proposalId: 'proposal', segments: [segment], unresolved: []};
}
afterEach(() => {jest.restoreAllMocks(); bindings.splice(0).forEach(binding => binding.release());});

describe('scene dispatch capability and runtime evidence binding', () => {
  it('binds coverage to the exact executor snapshot and never restores plan authority from options JSON', async () => {
    const skill: SkillDefinition = {name: 'fixture', version: '1', type: 'composite', meta: {display_name: 'Fixture', description: 'Fixture'}, steps: [
      {id: 'summary', type: 'atomic', sql: 'SELECT 1', investigation_evidence: {window: {start: 'ts', end: 'end'}, metrics: [],
        scan: {domain: 'input', resultStepId: 'facts', totalRowsColumn: 'total', cursorClosedColumn: 'closed',
          outputTruncatedColumn: 'truncated', parseFailuresColumn: 'failures'}}},
      {id: 'facts', type: 'atomic', sql: 'SELECT 2', investigation_evidence: {window: {start: 'ts', end: 'end'}, metrics: []}},
    ]};
    const snapshot = snapshotSceneCoverageRegistry({getAllSkills: () => [skill], getFragmentCache: () => new Map()},
      strategyLoader.buildStrategyRegistrySnapshotFromDefinitions({definitions: strategyLoader.getRegisteredScenes(), overlayGeneration: 'coverage-test'}),
      'scene_reconstruction');
    const expected = fingerprintSkillDefinition(snapshot.skills[0], snapshot.fragments);
    skill.version = 'overlay-changed';
    jest.spyOn(strategyLoader, 'loadStrategyYaml').mockImplementation((_name, parse) => parse({profileId: 'scene_reconstruction',
      profileVersion: 1, requiredTargets: [{id: 'input', domain: 'input', source: 'all',
        producer: {skillId: 'fixture', summaryStepId: 'summary', resultStepId: 'facts'}}]}));
    const f = fixture();
    const handle = (await activateSceneRuntime(f.options, {...f.actual, sceneCoverageRegistry: snapshot}))!;
    expect(sceneRunState(handle).coveragePlan!.targets[0].producer!.definitionFingerprint).toBe(expected);
    expect(sceneRunState(handle).coveragePlan!.targets[0].producer!.definitionFingerprint).not.toBe(fingerprintSkillDefinition(skill));
    const ordinary = await activateSceneRuntime({runId: f.scope.runId, sceneCoverageRegistry: snapshot} as any, f.actual);
    expect(ordinary).toBeUndefined();
  });
  it('canonicalizes owner defaults and preserves the caller options type', () => {
    expect(sceneRunOwnerKey({})).toBe(sceneRunOwnerKey(normalizeResourceOwner({})));
    expect(sceneRunOwnerKey({userId: 'other'})).not.toBe(sceneRunOwnerKey({}));
    const f = fixture();
    const name: string = f.options.packageName;
    expect(name).toBe('example.app');
    expect(f.binding.scope).toEqual(f.scope);
    expect(() => f.binding.bindOptions({})).toThrow('scene_dispatch_already_bound');
  });
  it('rejects a product owner key which differs from the final runtime option owner', () => {
    const binding = createSceneRunDispatchBinding({scope: baseScope, signal: new AbortController().signal,
      assertCurrent() {}});
    bindings.push(binding);
    expect(() => binding.bindOptions({tenantId: 'another-tenant'})).toThrow('scene_dispatch_owner_mismatch');
  });
  it('does not query bounds or activate normal and JSON-copied runs', async () => {
    const f = fixture();
    expect(resolveSceneProductScope({}, f.scope)).toBeUndefined();
    expect(resolveSceneProductScope(JSON.parse(JSON.stringify(f.options)), f.scope)).toBeUndefined();
    expect(await activateSceneRuntime({}, f.actual)).toBeUndefined();
    expect(await activateSceneRuntime(JSON.parse(JSON.stringify(f.options)), f.actual)).toBeUndefined();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('keeps issued authority across internal spreads and rejects run/session/trace substitutions', async () => {
    const f = fixture();
    expect(resolveSceneProductScope({...f.options}, f.scope)).toEqual(f.scope);
    for (const key of ['runId', 'sessionId', 'traceId'] as const) {
      expect(() => resolveSceneProductScope(f.options, {...f.scope, [key]: 'wrong'})).toThrow('scene_dispatch_scope_mismatch');
    }
    await expect(activateSceneRuntime(f.options, {...f.actual, artifactStore: new ArtifactStore()}))
      .rejects.toThrow('scene_evidence_store_mismatch');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('uses exact trace bounds and fresh current-run evidence through the issued facade', async () => {
    const f = fixture();
    const context = (await activateSceneRuntime(f.options, f.actual))!;
    expect(f.query).toHaveBeenCalledWith(f.scope.traceId,
      'SELECT CAST(start_ts AS TEXT) AS start_ns, CAST(end_ts AS TEXT) AS end_ns FROM trace_bounds',
      expect.objectContaining({signal: expect.any(AbortSignal), timeoutMs: expect.any(Number)}));
    expect(sceneRunState(context).options.traceBounds).toEqual({startNs: bounds.rows[0][0], endNs: bounds.rows[0][1]});
    const artifactId = capture(f.store); // Captured after activation, so a stale read view cannot pass.
    const result = await proposeSceneTimeline(context, proposal(artifactId));
    expect(result).toMatchObject({accepted: true, revision: 1});
    expect(result.segments![0].evidence[0].source.originRunId).toBe(f.scope.runId);
    expect(result.segments![0].checks.slice(0, 3).every(check => check.status === 'passed')).toBe(true);
    await expect(activateSceneRuntime(f.options, f.actual)).rejects.toThrow('scene_runtime_already_activated');
  });
  it('activates a run without a total deadline using the processor query default', async () => {
    const f = fixture();
    const context = (await activateSceneRuntime(f.options, {...f.actual, deadlineMs: Number.MAX_SAFE_INTEGER}))!;
    expect(sceneRunState(context).options.deadlineMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(f.query.mock.calls[0][2]).not.toHaveProperty('timeoutMs');
    expect(f.query.mock.calls[0][2]?.signal?.aborted).toBe(false);
  });
  it.each([
    {...bounds, rows: []}, {...bounds, rows: [...bounds.rows, ...bounds.rows]},
    {...bounds, columns: ['start_ts', 'end_ts']}, {...bounds, error: 'query failed'},
    {...bounds, rows: [[9007199254740992, 9007199254741992]]},
    {...bounds, rows: [['-1', '2']]}, {...bounds, rows: [['01', '2']]}, {...bounds, rows: [['3', '2']]},
  ])('rejects missing, noncanonical or inexact trace bounds %#', async result => {
    const f = fixture({result});
    await expect(activateSceneRuntime(f.options, f.actual)).rejects.toThrow(/scene_trace_bounds/);
    expect(f.binding.seal()).toBeUndefined();
  });
  it('rejects expired, cancelled, unauthorized and closed acquisition before querying', async () => {
    const expired = fixture();
    await expect(activateSceneRuntime(expired.options, {...expired.actual, deadlineMs: Date.now() - 1}))
      .rejects.toThrow('scene_run_deadline_exhausted');
    const cancelled = fixture(); cancelled.controller.abort();
    await expect(activateSceneRuntime(cancelled.options, cancelled.actual)).rejects.toThrow();
    const revoked = fixture(); revoked.revoke();
    await expect(activateSceneRuntime(revoked.options, revoked.actual)).rejects.toThrow('owner_not_current');
    const closed = fixture(); closed.close();
    await expect(activateSceneRuntime(closed.options, closed.actual)).rejects.toThrow('scene_runtime_acquisition_closed');
    for (const f of [expired, cancelled, revoked, closed]) expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses late bounds and a proposal whose acquisition closes during its evidence read', async () => {
    const late = fixture();
    late.query.mockImplementation(async () => {late.close(); return bounds;});
    await expect(activateSceneRuntime(late.options, late.actual)).rejects.toThrow('scene_runtime_acquisition_closed');
    const f = fixture();
    const context = (await activateSceneRuntime(f.options, f.actual))!;
    const pending = proposeSceneTimeline(context, proposal(capture(f.store)));
    f.close();
    expect(await pending).toMatchObject({accepted: false, revision: 0});
  });
  it('seals committed partial work after deadline and consumes the private seal only once', async () => {
    const f = fixture();
    const context = (await activateSceneRuntime(f.options, f.actual))!;
    await proposeSceneTimeline(context, proposal(capture(f.store)));
    jest.spyOn(Date, 'now').mockReturnValue(f.actual.deadlineMs + 1);
    f.close(); // Runtime acquisition has ended; product finalization is still authorized.
    const seal = f.binding.seal()!;
    expect(() => consumeSceneRuntimeSeal(JSON.parse(JSON.stringify(seal)), f.scope)).toThrow('unissued_scene_runtime_seal');
    expect(() => consumeSceneRuntimeSeal(seal, {...f.scope, ownerKey: 'other'})).toThrow('unissued_scene_runtime_seal');
    const snapshot = consumeSceneRuntimeSeal(seal, f.scope);
    expect(assessSceneTimeline(snapshot, f.scope)).toMatchObject({revision: 1, status: 'partial'});
    expect(() => consumeSceneRuntimeSeal(seal, f.scope)).toThrow('unissued_scene_runtime_seal');
    await expect(proposeSceneTimeline(context, proposal('late'))).rejects.toThrow();
  });
  it('revokes capabilities, snapshots and evidence at product release', async () => {
    const f = fixture();
    const context = (await activateSceneRuntime(f.options, f.actual))!;
    const seal = f.binding.seal()!;
    f.binding.release();
    expect(() => resolveSceneProductScope(f.options, f.scope)).toThrow('unissued_scene_dispatch');
    expect(() => assertSceneRuntimeCapability(context, f.scope)).toThrow('unissued_scene_runtime_capability');
    expect(() => consumeSceneRuntimeSeal(seal, f.scope)).toThrow('unissued_scene_runtime_seal');
    expect(() => f.store.serialize()).toThrow();
    expect(() => resolveRuntimeEvidenceStore({}, f.scope, () => f.store)).toThrow('runtime_evidence_binding_required');
    const freshStore = new ArtifactStore();
    expect(resolveRuntimeEvidenceStore({}, f.scope, () => freshStore)).toBe(freshStore);
    expect(() => consumeSceneRuntimeSeal({} as SceneRuntimeSeal, f.scope)).toThrow('unissued_scene_runtime_seal');
  });
  it('cancels an in-flight bounds query on product release without activating a late context', async () => {
    const f = fixture();
    f.query.mockImplementation(async (_traceId, _sql, options) => {
      const signal = (options as {signal: AbortSignal}).signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    });
    const pending = activateSceneRuntime(f.options, f.actual);
    f.binding.release();
    await expect(pending).rejects.toThrow('scene_dispatch_released');
  });
  it('never seals or consumes cancelled or no-longer-authorized state', async () => {
    const f = fixture();
    await activateSceneRuntime(f.options, f.actual);
    const seal = f.binding.seal()!;
    f.controller.abort();
    expect(() => f.binding.seal()).toThrow();
    expect(() => consumeSceneRuntimeSeal(seal, f.scope)).toThrow();
    const revoked = fixture();
    await activateSceneRuntime(revoked.options, revoked.actual);
    revoked.revoke();
    expect(() => revoked.binding.seal()).toThrow('owner_not_current');
  });
});
