// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {SkillDefinition} from '../../services/skillEngine/types';
import type {SkillRegistryView} from '../../services/skillEngine/skillAnalysisAdapter';
import {AnalysisContextAuthorizationChangedError} from '../../services/resolvedAnalysisContext';
import {RunManifestLifecycle, withRunManifestLifecycle} from '../../services/selfEvolution/runManifestLifecycle';
import type {RunManifestStore} from '../../services/selfEvolution/runManifestStore';
import type {InvestigationEvidenceDeclaration} from '../../services/evidence/investigationEvidenceLedger';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {resolveFocusAppTarget, type FocusAppTarget} from '../focusAppTarget';
import {createRuntimePerformanceRun} from '../runtimePerformance';
import {
  acquireSceneEntryEvidence,
  buildSceneEvidencePromptData,
  ENTRY_SKILL_TOOL_ACCESS,
  SCENE_EVIDENCE_MAX_BYTES,
  SCENE_EVIDENCE_MAX_CELLS,
  type SceneEntryEvidenceInput,
  type SceneEntryEvidenceOutcome,
} from '../sceneEntryEvidence';
import type {StrategyEntrySkill} from '../../types/sceneEntryEvidence';

const TRACE = 'trace-scene';
const RUN = 'run-scene';
const declaration: InvestigationEvidenceDeclaration = {window: {start: 'start', end: 'end'},
  identity: {upid: 'upid', utid: 'utid'}, metrics: [{domain: 'cpu_frequency', metric_id: 'system.cpu.frequency.time_weighted',
    value: 'freq', unit: 'kHz', status: 'status', coverage: 'coverage', denominator: 'denominator'}]};
const COLUMNS = ['start', 'end', 'upid', 'utid', 'freq', 'status', 'coverage', 'denominator'];
const ROW = [10, 110, 42, 43, 1234, 'observed', 100, 100];

function entrySkillDefinition(extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return {name: 'entry_fixture', version: '1', type: 'atomic',
    meta: {display_name: 'Entry fixture', description: 'Scene overview'}, process_scope: {role: 'global_context'},
    inputs: [{name: 'package', type: 'string', required: false}, {name: 'start_ts', type: 'timestamp', required: false}],
    sql: 'SELECT * FROM actual_overview', investigation_evidence: declaration,
    output: {display: {layer: 'overview', level: 'key', format: 'table', columns: [{name: 'freq', type: 'number'}]}},
    ...extra} as SkillDefinition;
}

function createLifecycle(): RunManifestLifecycle {
  const store = {append: jest.fn(), pin: jest.fn(), unpin: jest.fn()} as unknown as RunManifestStore;
  return new RunManifestLifecycle({runId: RUN, sessionId: 'session-scene', scope: {tenantId: 'tenant', workspaceId: 'workspace'},
    runtime: 'openai-agents-sdk', providerId: null, outputLanguage: 'en', analysisMode: 'auto',
    skillRegistry: {registryFingerprint: 'registry', skills: []}, store});
}

interface Harness {
  input: SceneEntryEvidenceInput;
  executor: SkillExecutor;
  store: ArtifactStore;
  lease: AbortController;
  lifecycle: RunManifestLifecycle;
  run: () => Promise<SceneEntryEvidenceOutcome>;
}

function harness(options: {
  entry?: StrategyEntrySkill | null;
  intent?: Partial<AnalysisTurnIntent>;
  focusTarget?: FocusAppTarget;
  skill?: SkillDefinition;
  overrides?: Partial<SceneEntryEvidenceInput>;
} = {}): Harness {
  const entry = options.entry === null ? undefined : options.entry ?? {id: 'entry_fixture', params: {start_ts: 'trace_start'}};
  const definitions = getRegisteredScenes().map(definition => {
    if (definition.scene !== 'scrolling') return definition;
    const {entrySkill: _declared, ...rest} = definition;
    return entry ? {...rest, entrySkill: entry} : rest;
  });
  const strategyRegistry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'scene-entry-test'});
  const skill = options.skill ?? entrySkillDefinition();
  const executor = new SkillExecutor({query: async () => ({columns: COLUMNS, rows: [ROW], durationMs: 1})} as any);
  executor.registerSkill(skill);
  const store = new ArtifactStore();
  const lease = new AbortController();
  const lifecycle = createLifecycle();
  const turnIntent = {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation',
    sceneId: 'scrolling', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'answer',
    evidenceAccess: 'read_new', registryFingerprint: strategyRegistry.registryFingerprint,
    ...options.intent} as AnalysisTurnIntent;
  const input: SceneEntryEvidenceInput = {
    runId: RUN, traceId: TRACE, turnIntent, policy: {allowNewEvidence: true}, strategyRegistry,
    skillRegistry: {getSkill: (id: string) => id === skill.name ? skill : undefined} as unknown as SkillRegistryView,
    skillExecutor: executor, traceProcessorService: {query: async () => ({columns: [], rows: []})} as any,
    artifactStore: store, focusTarget: options.focusTarget ?? resolveFocusAppTarget({}), outputLanguage: 'en',
    canInvokeTool: () => true, executionLease: {signal: lease.signal},
    runtimePerformance: createRuntimePerformanceRun(lifecycle.builder),
    ...options.overrides,
  };
  return {input, executor, store, lease, lifecycle,
    run: () => withRunManifestLifecycle(lifecycle, () => acquireSceneEntryEvidence(input))};
}

const ledger = (store: ArtifactStore) => store.createEvidenceReadView({ownerKey: 'owner', currentRunId: RUN,
  allowedTraces: [{traceId: TRACE, traceSide: 'current'}]}).investigationEvidence!();

describe('product-owned scene entry evidence', () => {
  it('runs the entry Skill and joins its capture to an observed product call, never as a model tool', async () => {
    const h = harness();
    const outcome = await h.run();
    expect(outcome).toMatchObject({status: 'ran', skillId: 'entry_fixture', artifactCount: 1, captureCount: 1});
    expect(outcome.artifacts).toEqual([expect.objectContaining({artifactId: 'art-1', stepId: expect.any(String), rowCount: 1})]);
    expect(outcome.artifactIdRange).toEqual({first: 'art-1', last: 'art-1'});
    expect(outcome.keyCells).toEqual(expect.arrayContaining([
      expect.objectContaining({artifactId: 'art-1', rowIndex: 0, column: 'freq', value: 1234})]));

    const snapshot = ledger(h.store);
    expect(snapshot.records.length).toBeGreaterThan(0);
    expect(snapshot.records.every(record => record.status === 'observed')).toBe(true);
    expect(snapshot.records[0].sourceToolCallId).toMatch(/^scene-entry:entry_fixture:/);
    expect(snapshot.issues).not.toContain('capture_tool_observation_missing');
    expect(snapshot.issues).not.toContain('tool_observation_incomplete');

    const receipt = h.lifecycle.builder.runtimePerformanceRecorder.seal();
    expect(receipt.sceneEvidence).toEqual({skillId: 'entry_fixture', status: 'ran', durationMs: expect.any(Number),
      artifactCount: 1, captureCount: 1});
    expect(receipt.phases.map(phase => phase.name)).toContain('scene_evidence');
    // Not a model tool: no tool timing and no tool-result handoff record.
    expect(receipt.tools).toEqual([]);
    expect(h.lifecycle.builder.toolResultAuditRecorder.hasRecordedData).toBe(false);
    expect(JSON.stringify(h.lifecycle.builder.toolResultAuditRecorder)).not.toContain('scene-entry:');
  });

  it('uses invoke_skill\'s registered access for the request-scope guard', () => {
    expect(ENTRY_SKILL_TOOL_ACCESS).toEqual({exposure: 'public', evidenceEffect: 'acquire'});
  });

  it('records nothing and runs nothing without a declared entry Skill', async () => {
    const h = harness({entry: null});
    const execute = jest.spyOn(h.executor, 'execute');
    expect(await h.run()).toMatchObject({status: 'not_run', reason: 'no_entry_skill'});
    expect(execute).not.toHaveBeenCalled();
    expect(h.lifecycle.builder.runtimePerformanceRecorder.seal().sceneEvidence).toBeUndefined();
    expect(buildSceneEvidencePromptData(await harness({entry: null}).run())).toBeUndefined();
  });

  it.each([
    ['a bounded question', {intent: {scope: 'bounded_question' as const}}, 'not_scene_wide'],
    ['a comparison', {intent: {taskKind: 'comparison' as const}}, 'comparison_turn'],
    ['an existing_only turn', {intent: {evidenceAccess: 'existing_only' as const}}, 'existing_only'],
    ['a policy that admits no new evidence', {overrides: {policy: {allowNewEvidence: false}}}, 'existing_only'],
    ['a closed run', {overrides: {canInvokeTool: () => false}}, 'acquisition_closed'],
    ['a run whose deadline passed', {overrides: {deadlineMs: Date.now() - 1}}, 'cancelled'],
  ])('does not start for %s', async (_label, options, reason) => {
    const h = harness(options as any);
    const execute = jest.spyOn(h.executor, 'execute');
    const prepare = jest.spyOn(h.executor, 'prepareInvocation');
    expect(await h.run()).toMatchObject({status: 'not_run', reason, artifactCount: 0, captureCount: 0});
    expect(execute).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(h.store.createEvidenceReadView({ownerKey: 'owner', allowedTraces: []}).investigationEvidence!().records).toEqual([]);
    expect(h.lifecycle.builder.runtimePerformanceRecorder.seal().sceneEvidence).toMatchObject({status: 'not_run', reason});
  });

  it('does not start when the lease was already aborted', async () => {
    const h = harness();
    h.lease.abort();
    const execute = jest.spyOn(h.executor, 'execute');
    expect(await h.run()).toMatchObject({status: 'not_run', reason: 'cancelled'});
    expect(execute).not.toHaveBeenCalled();
  });

  describe('identity', () => {
    const focused = (confidence: 'high' | 'ambiguous') => resolveFocusAppTarget({focusResult: {
      primaryApp: 'com.example.app', confidence, method: 'frame_timeline', apps: [{packageName: 'com.example.app'}],
    } as any});
    const gate = (status: 'verified' | 'ambiguous') => ({allowed: true, params: {package: 'com.example.app'}, inherited: {},
      config: {policy: 'verify_if_present' as const, scope: 'process' as const}, target: {requestedName: 'com.example.app'},
      resolution: {status, upids: status === 'verified' ? [7] : [], confidenceScore: status === 'verified' ? 95 : 60,
        evidenceSources: [], warnings: [], candidates: [
          {rank: 1, confidenceScore: 60, processName: 'com.example.app', canonicalPackageName: 'com.example.app', upid: 7},
          {rank: 2, confidenceScore: 55, processName: 'com.example.app:worker', canonicalPackageName: 'com.example.app', upid: 8},
        ]}});
    const entry: StrategyEntrySkill = {id: 'entry_fixture', params: {package: 'focus_app'}};

    it('runs only after the gate verifies the focus package', async () => {
      const h = harness({entry, focusTarget: focused('high')});
      const prepare = jest.spyOn(h.executor, 'prepareInvocation').mockResolvedValue(gate('verified') as any);
      expect(await h.run()).toMatchObject({status: 'ran', identity: {packageName: 'com.example.app'}});
      expect(prepare.mock.calls[0][2]).toMatchObject({package: 'com.example.app'});
    });

    it('does not run an ambiguous identity and lists the gate\'s candidates', async () => {
      const h = harness({entry, focusTarget: focused('high')});
      jest.spyOn(h.executor, 'prepareInvocation').mockResolvedValue(gate('ambiguous') as any);
      const execute = jest.spyOn(h.executor, 'execute');
      const outcome = await h.run();
      expect(outcome).toMatchObject({status: 'not_run', reason: 'identity_ambiguous'});
      expect(outcome.candidates).toEqual([
        {processName: 'com.example.app', packageName: 'com.example.app', upid: 7, confidence: 60},
        {processName: 'com.example.app:worker', packageName: 'com.example.app', upid: 8, confidence: 55},
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect(buildSceneEvidencePromptData(outcome)).toEqual({status: 'not_run', skillId: 'entry_fixture',
        reason: 'identity_ambiguous', candidates: outcome.candidates});
    });

    it('does not run without a confident focus app or a user target', async () => {
      for (const [binding, focusTarget] of [['focus_app', focused('ambiguous')], ['focus_app', resolveFocusAppTarget({})],
        ['user_target', focused('high')]] as const) {
        const h = harness({entry: {id: 'entry_fixture', params: {package: binding}}, focusTarget});
        const prepare = jest.spyOn(h.executor, 'prepareInvocation');
        expect(await h.run()).toMatchObject({status: 'not_run', reason: 'target_unresolved'});
        expect(prepare).not.toHaveBeenCalled();
      }
    });

    it('refuses an entry Skill the pinned registry cannot run', async () => {
      const h = harness({skill: entrySkillDefinition({sql: 'DELETE FROM slice'})});
      expect(await h.run()).toMatchObject({status: 'not_run', reason: 'capability_missing'});
    });
  });

  describe('guards around the Skill', () => {
    it('writes no artifact or capture when the lease aborts after the Skill returned', async () => {
      const h = harness();
      const realExecute = h.executor.execute.bind(h.executor);
      jest.spyOn(h.executor, 'execute').mockImplementation(async (...args: Parameters<SkillExecutor['execute']>) => {
        const result = await realExecute(...args);
        h.lease.abort();
        return result;
      });
      const outcome = await h.run();
      expect(outcome).toMatchObject({status: 'not_run', reason: 'cancelled', artifactCount: 0, captureCount: 0});
      expect(h.store.get('art-1')).toBeUndefined();
      const snapshot = ledger(h.store);
      expect(snapshot.records).toEqual([]);
      expect(snapshot.issues).toContain('tool_observation_incomplete');
    });

    it('writes nothing and ends the run with the fence error when authorization is revoked before the commit', async () => {
      const h = harness();
      const revoked = new AnalysisContextAuthorizationChangedError();
      let checks = 0;
      h.input.runAuthorization = {
        assertCurrentInTurn: () => { if (++checks >= 2) throw revoked; },
        settled: async () => undefined,
      };
      await expect(h.run()).rejects.toBe(revoked);
      expect(h.store.get('art-1')).toBeUndefined();
      expect(ledger(h.store).records).toEqual([]);
      expect(h.lifecycle.builder.runtimePerformanceRecorder.seal().sceneEvidence)
        .toMatchObject({status: 'not_run', reason: 'authorization_revoked', artifactCount: 0, captureCount: 0});
    });

    it('does not start when authorization is already revoked', async () => {
      const h = harness();
      const execute = jest.spyOn(h.executor, 'execute');
      const revoked = new AnalysisContextAuthorizationChangedError();
      h.input.runAuthorization = {assertCurrentInTurn: () => { throw revoked; }, settled: async () => undefined};
      await expect(h.run()).rejects.toBe(revoked);
      expect(execute).not.toHaveBeenCalled();
    });

    it('gives up at its own deadline, and a late Skill writes nothing', async () => {
      const h = harness({overrides: {timeoutMs: 20}});
      const realExecute = h.executor.execute.bind(h.executor);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      jest.spyOn(h.executor, 'execute').mockImplementation(async (...args: Parameters<SkillExecutor['execute']>) => {
        await gate;
        return realExecute(...args);
      });
      expect(await h.run()).toMatchObject({status: 'not_run', reason: 'timeout'});
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(h.store.get('art-1')).toBeUndefined();
      expect(ledger(h.store).records).toEqual([]);
    });
  });
});

describe('scene_evidence prompt data', () => {
  const cells = (count: number, level: 'key' | 'summary', width = 8) => Array.from({length: count}, (_, index) => ({
    artifactId: level === 'key' ? 'art-1' : 'art-2', rowIndex: 0, column: `${level}_${index}`, value: 'v'.repeat(width), unit: 'ms'}));
  const outcome = (keyCells: ReturnType<typeof cells>, summaryCells: ReturnType<typeof cells>): SceneEntryEvidenceOutcome => ({
    status: 'ran', skillId: 'scrolling_analysis', artifacts: [
      {artifactId: 'art-1', evidenceRefId: 'data:skill:scrolling_analysis:overview:current:a:b:c', stepId: 'overview', rowCount: 1},
      {artifactId: 'art-2', evidenceRefId: 'data:skill:scrolling_analysis:summary:current:a:b:c', stepId: 'summary', rowCount: 1}],
    artifactIdRange: {first: 'art-1', last: 'art-9'}, keyCells, summaryCells, artifactCount: 9, captureCount: 9, durationMs: 1});
  const bytes = (data: unknown) => Buffer.byteLength(JSON.stringify({context: 'scene_evidence', data}), 'utf8');

  it('keeps status and locators and caps cells at the count, summary cells first to go', () => {
    const data = buildSceneEvidencePromptData(outcome(cells(20, 'key'), cells(20, 'summary')))!;
    expect(data.cells!.fields).toEqual(['artifactId', 'rowIndex', 'column', 'value', 'unit']);
    expect(data.cells!.key).toHaveLength(20);
    expect(data.cells!.key[0]).toEqual(['art-1', 0, 'key_0', 'vvvvvvvv', 'ms']);
    expect(data.cells!.key.length + data.cells!.summary.length).toBe(SCENE_EVIDENCE_MAX_CELLS);
    expect(data.omittedCellCount).toBe(16);
    expect(data.artifacts).toHaveLength(2);
    expect(data.artifactIdRange).toEqual({first: 'art-1', last: 'art-9'});
    expect(bytes(data)).toBeLessThanOrEqual(SCENE_EVIDENCE_MAX_BYTES);
  });

  it('degrades deterministically under the byte bound, keeping key cells over summary cells', () => {
    const input = outcome(cells(12, 'key', 120), cells(12, 'summary', 120));
    const data = buildSceneEvidencePromptData(input)!;
    expect(bytes(data)).toBeLessThanOrEqual(SCENE_EVIDENCE_MAX_BYTES);
    expect(data.cells!.summary).toEqual([]);
    expect(data.cells!.key.length).toBeGreaterThan(0);
    expect(data.artifacts).toHaveLength(2);
    expect(buildSceneEvidencePromptData(input)).toEqual(data);
  });

  it('keeps the status line when even the locators overflow', () => {
    const many = {...outcome([], []), artifacts: Array.from({length: 40}, (_, index) => ({artifactId: `art-${index}`,
      evidenceRefId: `data:skill:scrolling_analysis:step_${index}:current:${'h'.repeat(20)}`, stepId: `step_${index}`, rowCount: 1}))};
    const data = buildSceneEvidencePromptData(many)!;
    expect(bytes(data)).toBeLessThanOrEqual(SCENE_EVIDENCE_MAX_BYTES);
    expect(data).toMatchObject({status: 'ran', skillId: 'scrolling_analysis'});
    expect(data.omittedArtifactCount).toBe(40 - data.artifacts!.length);
  });

  it('says nothing for reasons the model need not act on', () => {
    for (const reason of ['no_entry_skill', 'not_scene_wide', 'comparison_turn', 'existing_only'] as const) {
      expect(buildSceneEvidencePromptData({...outcome([], []), status: 'not_run', reason})).toBeUndefined();
    }
    expect(buildSceneEvidencePromptData({...outcome([], []), status: 'not_run', reason: 'timeout'}))
      .toEqual({status: 'not_run', skillId: 'scrolling_analysis', reason: 'timeout'});
  });
});
