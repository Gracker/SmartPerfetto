// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// Test datasource fixture; production signer, identity gate and Skill core stay real.
import {jest} from '@jest/globals';
import {ArtifactStore} from '../../src/agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../src/agentv3/strategyLoader';
import type {SkillDefinition} from '../../src/services/skillEngine/types';
import type {SkillRegistryView} from '../../src/services/skillEngine/skillAnalysisAdapter';
import type {ProcessIdentityResolution} from '../../src/services/processIdentity/types';
import * as identity from '../../src/services/capabilityManifestRuntimeIdentity';
import * as docs from '../../src/services/perfettoSqlDocs';
import {beginRawSqlNativeQuery, createRawSqlNativeProvenance, initializeRawSqlNativeProvenance,
  sealRawSqlNativeQuery} from '../../src/services/evidence/rawSqlNativeProvenance';
import {acquireSelectedEvidenceFoundation, type SelectedEvidenceFoundationInput} from '../../src/agentRuntime/selectedEvidenceFoundation';
import * as intentRuntime from '../../src/agentRuntime/analysisTurnIntent';
import * as effectiveRegistry from '../../src/services/selfEvolution/effectiveRuntimeRegistryProvider';
import * as executors from '../../src/services/skillEngine/skillExecutor';

const TRACE = 'selected-trace', RUN = 'selected-run', METRIC = 'fixture.thread.duration';
const revision = 'a'.repeat(40);
const columns = ['start', 'end', 'upid', 'utid', 'value_ns', 'status', 'coverage', 'denominator'];
const row = [10, 110, 42, 43, 80, 'observed', 100, 100];
const entry = {schemaVersion: 1 as const, metricId: METRIC, subjectBinding: 'selected_thread_interval' as const,
  params: {start_ts: 'selected_start' as const, end_ts: 'selected_end' as const,
    upid: 'selected_upid' as const, utid: 'selected_utid' as const}};
export const selectedFoundationSkill = (): SkillDefinition => ({name: 'renamed_selected_producer', version: '1', type: 'atomic',
  meta: {display_name: 'Selected fixture', description: 'Selected interval'},
  identity: {policy: 'verify_if_present', scope: 'process', aliases: ['package']},
  process_scope: {role: 'target', binding: 'native_upid'},
  inputs: [{name: 'start_ts', type: 'timestamp', required: true}, {name: 'end_ts', type: 'timestamp', required: true},
    {name: 'utid', type: 'number', required: true}, {name: 'package', type: 'string', required: false}],
  sql: 'SELECT ${start_ts} AS start, ${end_ts} AS end, ${__process_scope.upid} AS upid, ${utid} AS utid, 80 AS value_ns, \'observed\' AS status, 100 AS coverage, 100 AS denominator',
  investigation_evidence: {window: {start: 'start', end: 'end'}, identity: {upid: 'upid', utid: 'utid'},
    metrics: [{domain: 'thread_state', metric_id: METRIC, value: 'value_ns', unit: 'ns', status: 'status',
      coverage: 'coverage', denominator: 'denominator'}]},
  output: {display: {layer: 'deep', level: 'detail', format: 'table',
    columns: columns.map(name => ({name, type: name === 'status' ? 'string' : 'number'}))}},
} as SkillDefinition);
const resolution = (): ProcessIdentityResolution => ({status: 'verified', upids: [42], confidenceScore: 100,
  canonicalPackageName: 'app.selected', recommendedProcessNameParam: 'app.selected', evidenceSources: ['native'], warnings: [],
  candidates: [{rank: 1, confidenceScore: 100, upid: 42, pid: 100, processName: 'app.selected', packageName: 'app.selected'}]});

export async function createSelectedFoundationFixture(options: {traceId?: string; runId?: string; registerExecutor?: boolean} = {}) {
  const traceId = options.traceId ?? TRACE, runId = options.runId ?? RUN;
  const native = createRawSqlNativeProvenance('selected-processor', [], traceId);
  await initializeRawSqlNativeProvenance(native.provenance,
    {source: 'local_binary', selectedPath: '/fixture/pinned-processor', selectionOrigin: 'default'});
  const nativeResponse = {columns: ['id', 'ts', 'dur', 'track_id'], rows: [[7, 10, 100, 9]], durationMs: 1};
  const queryBounded = jest.fn(async (_traceId: string, sql: string, _options?: unknown) => {
    const result = sql.includes('FROM slice') ? structuredClone(nativeResponse) : sql.includes('FROM thread_track')
      ? {columns: ['id', 'utid'], rows: [[9, 43]], durationMs: 1}
      : {columns: ['utid', 'upid'], rows: [[43, 42]], durationMs: 1};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, sql), result);
    return result;
  });
  const query = jest.fn(async (_traceId: string, _sql: string, _options?: unknown) => ({columns, rows: [row], durationMs: 1}));
  const tps = {query, queryBounded, getTrace: () => undefined} as any;
  const producer = selectedFoundationSkill(), definitions = new Map([[producer.name, producer]]), fragments = new Map<string, string>();
  // Some owning suites mock the runtime factory. Always retain the real gate/core here.
  const {SkillExecutor} = jest.requireActual<typeof import('../../src/services/skillEngine/skillExecutor')>(
    '../../src/services/skillEngine/skillExecutor');
  const executor = new SkillExecutor(tps);
  if (options.registerExecutor !== false) {executor.registerSkills([...definitions.values()]); executor.setFragmentRegistry(fragments);}
  // Fake only the identity datasource. The real IdentityGate issues and checks the exact private scope.
  const resolveIdentity = jest.spyOn(executor as any, 'resolveProcessIdentityForGate').mockImplementation(async () => {
    beginRawSqlNativeQuery(native.provenance, 'INCLUDE PERFETTO MODULE android.process_metadata;');
    return resolution();
  });
  const registry = {getSkill: (id: string) => definitions.get(id), getAllSkills: () => [...definitions.values()],
    getFragmentCache: () => fragments} as SkillRegistryView;
  const strategyRegistry = buildStrategyRegistrySnapshotFromDefinitions({overlayGeneration: 'selected-test',
    definitions: getRegisteredScenes().map(definition => definition.scene !== 'general' ? definition : {...definition,
      investigationContract: {schemaVersion: 1, profileRefs: [], requirements: [{id: 'selected_work', domain: 'thread_state', required: true,
        description: 'Explain selected work', evidenceMetrics: [METRIC], entryAcquisition: entry}]}})});
  const lease = new AbortController(), store = new ArtifactStore();
  const authorization = {assertCurrentInTurn: jest.fn(), settled: jest.fn<() => Promise<void>>(async () => undefined)};
  const phase = {end: jest.fn()}, startPhase = jest.fn(() => phase), recordSceneEvidence = jest.fn();
  const input: SelectedEvidenceFoundationInput = {runId, traceId, strategyRegistry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation', sceneId: 'general',
      scope: 'bounded_question', targetUse: 'current_selection', recommendedComplexity: 'quick', deliverable: 'answer',
      evidenceAccess: 'read_new', registryFingerprint: strategyRegistry.registryFingerprint},
    policy: {allowNewEvidence: true}, selectionContext: {kind: 'track_event', source: 'track_event_selection',
      eventId: 7, ts: 10, dur: 100, nativeTable: 'slice'}, skillRegistry: registry, skillExecutor: executor,
    traceProcessorService: tps, artifactStore: store, outputLanguage: 'en', timeoutMs: 20_000,
    deadlineMs: Date.now() + 30_000, canInvokeTool: () => true, executionLease: lease,
    runAuthorization: authorization, runtimePerformance: {startPhase, recordSceneEvidence}};
  const register = jest.spyOn(store, 'registerStandaloneEvidenceCapture');
  return {input, native, nativeResponse, queryBounded, query, executor, resolveIdentity, store, register, definitions,
    lease, authorization, phase, recordSceneEvidence, run: () => acquireSelectedEvidenceFoundation(input)};
}

export function installSelectedNativeSignerMocks(): () => void {
    const pin = jest.spyOn(identity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    const schema = jest.spyOn(docs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {}, entries: [
      {id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '',
        columns: [{name: 'id', type: 'ID'}, {name: 'ts', type: 'TIMESTAMP'}, {name: 'dur', type: 'DURATION'}, {name: 'track_id', type: 'JOINID'}]},
    ]});
    return () => {pin.mockRestore(); schema.mockRestore();};
}

/** Keep each adapter's actual typed resolver, while pinning the same test registry/executor. */
export function installSelectedRuntimeFixture(fixture: Awaited<ReturnType<typeof createSelectedFoundationFixture>>) {
  const actualResolver = intentRuntime.createAnalysisTurnIntentResolver;
  const resolve = jest.spyOn(intentRuntime, 'createAnalysisTurnIntentResolver').mockImplementation(input =>
    actualResolver({...input, strategyRegistry: fixture.input.strategyRegistry}));
  const registry = jest.spyOn(effectiveRegistry, 'resolveEffectiveSkillRegistryForRuntime').mockReturnValue(fixture.input.skillRegistry);
  const wasMock = jest.isMockFunction(executors.createSkillExecutor);
  const originalImplementation = wasMock ? jest.mocked(executors.createSkillExecutor).getMockImplementation() : undefined;
  const actualFactory = executors.createSkillExecutor;
  const createExecutor = jest.spyOn(executors, 'createSkillExecutor')
    .mockImplementation(originalImplementation ?? actualFactory).mockReturnValueOnce(fixture.executor);
  const registerSkills = jest.spyOn(fixture.executor, 'registerSkills');
  const registerFragments = jest.spyOn(fixture.executor, 'setFragmentRegistry');
  return {createExecutor, registerSkills, registerFragments,
    restore: () => {resolve.mockRestore(); registry.mockRestore();
      if (wasMock && originalImplementation) createExecutor.mockImplementation(originalImplementation);
      else createExecutor.mockRestore();
      registerSkills.mockRestore(); registerFragments.mockRestore();}};
}
