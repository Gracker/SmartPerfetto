// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {normalizeSkillDefinition} from '../../../services/skillEngine/skillLoader';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {SkillExecutor} from '../../../services/skillEngine/skillExecutor';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';
import {evidenceTableFor} from '../../../services/evidence/evidenceCapture';
import {investigationEvidenceFingerprint, type InvestigationEvidenceDeclaration, SCAN_RECORD_BUDGET, SCAN_ROW_CHECK_BUDGET}
  from '../../../services/evidence/investigationEvidenceLedger';
import {createRuntimeToolResult} from '../../../agentRuntime/runtimeToolResult';
import {createSceneRunContext, sealSceneTimeline, revokeSceneRunContext} from '../sceneRunContext';
import {proposeSceneTimeline} from '../sceneTimelineProposal';
import {assessSceneTimeline} from '../sceneTimelineAssessment';
import {captureSceneScanCoverage} from '../sceneScanCoverage';
import type {SceneRunLimits} from '../sceneTimelineContract';
import * as strategyLoader from '../../../agentv3/strategyLoader';
import {buildSceneCoveragePlan, initializeSceneCoveragePlan, sceneCoveragePolicySchema, snapshotSceneCoverageRegistry} from '../sceneCoveragePlan';
import {sceneRunState} from '../sceneRunContext';
import type {SkillDefinition} from '../../../services/skillEngine/types';
import {fingerprintSkillDefinition} from '../../../services/selfEvolution/skillFingerprint';
import {androidInputEventsTableDdl} from '../../../../tests/helpers/androidInputEventsFixture';
import {runWithinRuntimeToolInvocation} from '../../../agentRuntime/runtimeToolInvocationContext';

const scope = {ownerKey: 'owner', runId: 'run', sessionId: 'session', traceId: 'trace'};
const readOptions = {ownerKey: scope.ownerKey, currentRunId: scope.runId, allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]};
const scanDeclaration: InvestigationEvidenceDeclaration = {window: {start: 'start', end: 'end'}, metrics: [], scan: {
  domain: 'input', resultStepId: 'facts', totalRowsColumn: 'total', outputTruncatedColumn: 'truncated',
  cursorClosedColumn: 'closed', parseFailuresColumn: 'parse_failures'}};
const factDeclaration: InvestigationEvidenceDeclaration = {window: {start: 'start', end: 'end'},
  metrics: [{domain: 'input', metric_id: 'count', value: 'count', status: 'status'}]};
function fixtureDefinition(grouped = false): SkillDefinition {
  return {name: 'scan_fixture', type: 'composite', version: '1',
    meta: {display_name: 'Scan fixture', description: 'Real capture chain'}, steps: [
      {id: 'summary', type: 'atomic', sql: 'SELECT * FROM scan_summary', process_scope: {role: 'global_context'},
        investigation_evidence: {...scanDeclaration, scan: {...scanDeclaration.scan!,
          ...(grouped ? {sourceColumn: 'source', resultSourceColumn: 'source'} : {})}}, display: {level: 'detail'}},
      {id: 'facts', type: 'atomic', sql: 'SELECT * FROM scan_facts', process_scope: {role: 'global_context'},
        investigation_evidence: factDeclaration, display: {level: 'detail'}},
    ]};
}
async function acquire(store = new ArtifactStore(), config: {summaryRows?: unknown[][]; factRows?: unknown[][];
  success?: boolean | null; call?: string; factCall?: string; runId?: string; omitFacts?: boolean; duplicateWitness?: boolean;
  grouped?: boolean; factColumns?: string[]; source?: string; originTrace?: string} = {}) {
  const summaryColumns = ['start', 'end', 'total', 'truncated', 'closed', 'parse_failures', 'source'];
  const factColumns = config.factColumns || ['start', 'end', 'count', 'status', 'source'];
  const summaryRows = config.summaryRows || [['0', '100', 1, 0, 1, 0, config.source || 'touch']];
  const factRows = config.factRows || [['0', '100', 1, 'observed', config.source || 'touch']];
  const executor = new SkillExecutor({query: async (_trace: string, sql: string) => sql.includes('scan_summary')
    ? {columns: summaryColumns, rows: summaryRows, durationMs: 1} : {columns: factColumns, rows: factRows, durationMs: 1}});
  executor.registerSkill(fixtureDefinition(config.grouped));
  const traceId = config.originTrace || scope.traceId;
  const result = await executor.execute('scan_fixture', traceId);
  expect(result.success).toBe(true);
  const call = config.call || 'call', originRunId = config.runId || scope.runId;
  store.observeInvestigationTool({phase: 'completed', toolCallId: call, toolName: 'invoke_skill', params: {}, extra: {},
    result: createRuntimeToolResult({}, {facts: config.success === null ? {} : {success: config.success !== false}})}, originRunId);
  for (const display of result.displayResults) {
    if (config.omitFacts && display.stepId === 'facts') continue;
    const stepCall = display.stepId === 'facts' ? config.factCall || call : call;
    // Registered inside the invocation that produced the step, as production does.
    const register = () => runWithinRuntimeToolInvocation({toolCallId: stepCall}, async () => {
      const id = store.store({skillId: 'scan_fixture', stepId: display.stepId, data: display.data,
        sourceToolCallId: `invoke_skill:${stepCall}`,
        traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'}), executionStatus: display.executionStatus});
      store.registerEvidenceCapture(id, evidenceTableFor(display)!, {evidenceRefId: `ev:${id}`, originRunId});
    });
    await register(); if (config.duplicateWitness) await register();
  }
  return store;
}
function run(store: ArtifactStore, limits?: Partial<SceneRunLimits>, copied = false, traceBounds = {startNs: '0', endNs: '100'}) {
  const handle = createSceneRunContext({...scope, traceBounds, deadlineMs: Date.now() + 60000,
    assertAuthorized: () => {}, limits, createEvidenceReadView: () => {
      const reader = store.createEvidenceReadView(readOptions);
      return copied ? {...reader, investigationEvidence: () => JSON.parse(JSON.stringify(reader.investigationEvidence!()))} : reader;
    }});
  return handle;
}
const propose = (handle: ReturnType<typeof run>, revision = 0) => proposeSceneTimeline(handle,
  {baseRevision: revision, proposalId: `p${revision}`, segments: [], unresolved: []});

describe('scene scan producer coverage', () => {
  it('proves successful empty SQL output without claiming absent user input or complete capture', async () => {
    const store = await acquire(undefined, {summaryRows: [['0', '100', 0, 0, 1, 0]], factRows: []});
    const snapshot = store.createEvidenceReadView(readOptions).investigationEvidence!();
    expect(snapshot.scans).toEqual([expect.objectContaining({scanStatus: 'complete', totalRows: '0', returnedRows: '0', captureStatus: 'unknown'})]);
    const handle = run(store); await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope)).toMatchObject({status: 'partial', coverage: {
      status: 'partial', captureStatus: 'unknown', sources: [{scanStatus: 'complete'}]}});
    revokeSceneRunContext(handle);
  });
  it.each([{omitFacts: true}, {factCall: 'other-call'}])('does not substitute missing/foreign empty output %j', async config => {
    const store = await acquire(undefined, {...config, summaryRows: [['0', '100', 0, 0, 1, 0]], factRows: []});
    expect(store.createEvidenceReadView(readOptions).investigationEvidence!().scans![0]).toMatchObject({scanStatus: 'partial', issues: ['scan_result_missing']});
  });
  it.each([false, null])('requires explicit tool success, received %s', async success => {
    const store = await acquire(undefined, {success});
    expect(store.createEvidenceReadView(readOptions).investigationEvidence!().scans![0].issues).toContain('scan_tool_success_unproven');
  });
  it('deduplicates the same witness but refuses distinct matching sibling witnesses', async () => {
    const duplicated = await acquire(undefined, {duplicateWitness: true});
    expect(duplicated.createEvidenceReadView(readOptions).investigationEvidence!().scans).toHaveLength(1);
    expect(duplicated.createEvidenceReadView(readOptions).investigationEvidence!().scans![0].scanStatus).toBe('complete');
    await acquire(duplicated);
    expect(duplicated.createEvidenceReadView(readOptions).investigationEvidence!().scans!.every(scan => scan.issues.includes('scan_result_ambiguous'))).toBe(true);
  });
  it.each([
    [['0', '100', 2, 0, 1, 0], 'scan_result_count_mismatch'],
    [['0', '100', Number.MAX_SAFE_INTEGER + 1, 0, 1, 0], 'scan_total_invalid'],
    [['0', '100', 1, 1, 1, 0], 'scan_output_truncated_or_unknown'],
    [['0', '100', 1, 0, 0, 0], 'scan_cursor_not_closed'],
    [['0', '100', 1, 0, 1, 1], 'scan_parse_failures_or_unknown'],
  ] as Array<[unknown[], string]>)('rejects inconsistent summary %j', async (row, issue) => {
    const store = await acquire(undefined, {summaryRows: [row]});
    expect(store.createEvidenceReadView(readOptions).investigationEvidence!().scans![0]).toMatchObject({scanStatus: 'partial', issues: expect.arrayContaining([issue])});
  });
  it('requires declared source columns and nonempty source values on both sides', async () => {
    const missing = await acquire(undefined, {grouped: true, factColumns: ['start', 'end', 'count', 'status']});
    expect(missing.createEvidenceReadView(readOptions).investigationEvidence!().scans![0].issues).toContain('scan_result_source_missing');
    const invalid = await acquire(undefined, {grouped: true, factRows: [['0', '100', 1, 'observed', null]]});
    expect(invalid.createEvidenceReadView(readOptions).investigationEvidence!().scans![0].issues).toContain('scan_result_source_invalid');
  });
  it('includes scans in the authenticated snapshot fingerprint and rejects serialized/foreign snapshots', async () => {
    const store = await acquire(); const snapshot = store.createEvidenceReadView(readOptions).investigationEvidence!();
    expect(investigationEvidenceFingerprint({...snapshot, scans: []})).not.toBe(snapshot.fingerprint);
    const copied = run(store, undefined, true); await propose(copied);
    expect(assessSceneTimeline(sealSceneTimeline(copied), scope).diagnostics).toContainEqual({code: 'scene_scan_scope_or_witness_mismatch'});
    const old = await acquire(undefined, {runId: 'old'});
    expect(old.createEvidenceReadView(readOptions).investigationEvidence!().scans || []).toEqual([]);
  });
  it('unions adjacent windows, preserves gaps, partitions sources, and never invents global required targets', async () => {
    const store = await acquire(undefined, {call: 'a', grouped: true, summaryRows: [['0', '40', 1, 0, 1, 0, 'touch']], factRows: [['0', '40', 1, 'observed', 'touch']]});
    await acquire(store, {call: 'b', grouped: true, summaryRows: [['40', '100', 1, 0, 1, 0, 'touch']], factRows: [['40', '100', 1, 'observed', 'touch']]});
    await acquire(store, {call: 'c', grouped: true, summaryRows: [['0', '39', 1, 0, 1, 0, 'keys']], factRows: [['0', '39', 1, 'observed', 'keys']]});
    const handle = run(store); await propose(handle);
    const assessment = assessSceneTimeline(sealSceneTimeline(handle), scope);
    expect(assessment.status).toBe('partial');
    expect(assessment.coverage.sources.find(source => source.source === 'touch')).toMatchObject({scanStatus: 'complete', windows: [{startNs: '0', endNs: '100'}]});
    expect(assessment.coverage.sources.find(source => source.source === 'keys')).toMatchObject({scanStatus: 'partial', issues: ['scene_scan_window_gap']});
  });
  it.each([{maxScanReceipts: 1}, {maxScanReceiptBytes: 1}, {maxScanUnionWindows: 1}])('bounds retained scans and union work %j', async limits => {
    const store = await acquire(undefined, {call: 'a'}); await acquire(store, {call: 'b'});
    const handle = run(store, limits); await propose(handle);
    const assessment = assessSceneTimeline(sealSceneTimeline(handle), scope);
    expect(assessment.coverage.sources.every(source => source.scanStatus !== 'complete')).toBe(true);
  });
  it('bounds producer scan records and source row checks', async () => {
    const many = await acquire(undefined, {summaryRows: Array.from({length: SCAN_RECORD_BUDGET + 1}, () => ['0', '100', 0, 0, 1, 0]), factRows: []});
    expect(many.createEvidenceReadView(readOptions).investigationEvidence!().scanIssues).toContain('scan_record_budget_exhausted');
    const rows = await acquire(undefined, {summaryRows: [['0', '100', SCAN_ROW_CHECK_BUDGET + 1, 0, 1, 0]],
      factRows: Array.from({length: SCAN_ROW_CHECK_BUDGET + 1}, () => ['0', '100', 1, 'observed'])});
    expect(rows.createEvidenceReadView(readOptions).investigationEvidence!().scanIssues).toContain('scan_row_budget_exhausted');
  });
  it('only captures within an active mutation and never refreshes after seal', async () => {
    const store = await acquire(); const handle = run(store);
    expect(() => captureSceneScanCoverage(handle)).toThrow('scene_scan_requires_mutation');
    await propose(handle); const frozen = sealSceneTimeline(handle);
    await acquire(store, {call: 'late'});
    expect(frozen.scanCoverage!.receipts).toHaveLength(1);
    await expect(propose(handle, 1)).rejects.toThrow('scene_run_frozen');
    expect(() => assessSceneTimeline(JSON.parse(JSON.stringify(frozen)), scope)).toThrow('unissued_scene_snapshot');
  });
  it.each([
    ['composite/scene_reconstruction.skill.yaml', ['input_coverage', 'user_gestures']],
    ['atomic/scene_device_state_changes.skill.yaml', ['state_sources', 'state_intervals']],
  ] as Array<[string, string[]]>)('executes production YAML SQL through the registered capture chain: %s', async (file, steps) => {
    const raw = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')) as any;
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER); INSERT INTO trace_bounds VALUES(0,100);
        CREATE TABLE android_motion_events(id INTEGER,event_id INTEGER,ts INTEGER,action INTEGER,device_id INTEGER,display_id INTEGER,source INTEGER);
        CREATE TABLE android_key_events(id INTEGER,event_id INTEGER,ts INTEGER,action INTEGER,device_id INTEGER,display_id INTEGER,source INTEGER);
        ${androidInputEventsTableDdl()}
        CREATE TABLE android_screen_state(id INTEGER,ts INTEGER,dur INTEGER,simple_screen_state TEXT,short_screen_state TEXT);
        CREATE TABLE android_charging_states(id INTEGER,ts INTEGER,dur INTEGER,short_charging_state TEXT,charging_state TEXT);
        CREATE TABLE track(id INTEGER,name TEXT); CREATE TABLE slice(id INTEGER,track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT);
        INSERT INTO android_motion_events VALUES(1,1,10,0,1,0,4098),(2,2,90,1,1,0,4098);
        INSERT INTO android_screen_state VALUES(1,0,100,'on','on');
        INSERT INTO track VALUES(1,'DeviceStateChanged');
        INSERT INTO slice VALUES(9,1,50,0,'A'),(10,1,50,0,'B');`);
      const executor = new SkillExecutor({query: async (_trace: string, sql: string) => {
        const stmt = db.prepare(sql);
        return {columns: stmt.columns().map(column => column.name), rows: stmt.raw().all(), durationMs: 1};
      }});
      const selected = raw.steps.filter((step: any) => steps.includes(step.id));
      const fragments = new Map<string, string>();
      selected.forEach((step: any) => (step.sql_fragments || []).forEach((file: string) =>
        fragments.set(file, fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8'))));
      executor.setFragmentRegistry(fragments);
      // SQLite fixture supplies the source tables; isolate the two actual SQL steps from Perfetto INCLUDE and unrelated skill work.
      const fixtureSkill = {...raw, steps: selected.map((step: any) => {const copy = {...step}; delete copy.condition; return copy;})};
      delete fixtureSkill.prerequisites;
      executor.registerSkill(normalizeSkillDefinition(fixtureSkill, file)!);
      const result = await executor.execute(raw.name, scope.traceId, {...(raw.inputs.some((input: any) => input.name === 'trace_id') ? {trace_id: scope.traceId} : {}), start_ts: '20', end_ts: '80'});
      expect(result.error).toBeUndefined(); expect(result.success).toBe(true);
      const store = new ArtifactStore();
      store.observeInvestigationTool({phase: 'completed', toolCallId: 'production', toolName: 'invoke_skill', params: {}, extra: {},
        result: createRuntimeToolResult({}, {facts: {success: true}})}, scope.runId);
      for (const display of result.displayResults) {
        await runWithinRuntimeToolInvocation({toolCallId: 'production'}, async () => {
          const id = store.store({skillId: raw.name, stepId: display.stepId, data: display.data, sourceToolCallId: 'invoke_skill:1:production',
            traceProvenance: buildTraceProcessorQueryProvenance({traceId: scope.traceId, traceSide: 'current'}), executionStatus: display.executionStatus});
          store.registerEvidenceCapture(id, evidenceTableFor(display)!, {evidenceRefId: `ev:${id}`, originRunId: scope.runId});
        });
      }
      const ledger = store.createEvidenceReadView(readOptions).investigationEvidence!();
      const scans = ledger.scans!;
      expect(scans.length).toBe(file.includes('device') ? 3 : 1);
      expect(scans.every(scan => scan.scanStatus === 'complete' && scan.window.start === '20' && scan.window.end === '80')).toBe(true);
      if (file.includes('device')) {
        expect(scans.find(scan => scan.source === 'device_state')).toMatchObject({totalRows: '3', returnedRows: '3'});
        expect(ledger.issues).toContain('capture_window_or_identity_invalid');
        expect(ledger.records.every(record => BigInt(record.window.end) > BigInt(record.window.start))).toBe(true);
      }
    } finally {db.close();}
  });

  it('rejects unregistered scan shapes instead of accepting model-style completeness flags', () => {
    const executor = new SkillExecutor({query: async () => ({columns: [], rows: []})});
    for (const scan of [{...scanDeclaration.scan, captureComplete: true}, {...scanDeclaration.scan, sourceColumn: 'source'}, null]) {
      expect(() => executor.registerSkill({name: 'invalid', type: 'atomic', version: '1',
        meta: {display_name: 'invalid', description: 'invalid'}, sql: 'SELECT 1',
        investigation_evidence: {...scanDeclaration, scan} as InvestigationEvidenceDeclaration})).toThrow('Invalid investigation_evidence');
    }
  });

  it('rejects valid issued snapshots belonging to another owner or trace', async () => {
    for (const wrong of ['owner', 'trace']) {
      const store = await acquire(undefined, {originTrace: wrong === 'trace' ? 'other' : 'trace'});
      const handle = createSceneRunContext({...scope, traceBounds: {startNs: '0', endNs: '100'}, deadlineMs: Date.now() + 60000,
        assertAuthorized: () => {}, createEvidenceReadView: () => store.createEvidenceReadView({...readOptions,
          ownerKey: wrong === 'owner' ? 'other' : scope.ownerKey,
          allowedTraces: [{traceId: wrong === 'trace' ? 'other' : 'trace', traceSide: 'current'}]})});
      await propose(handle);
      expect(sealSceneTimeline(handle).scanCoverage!.receipts).toHaveLength(0);
    }
  });
  it('stages scan receipts until the deadline check passes, so closeout cannot publish late checks', async () => {
    const store = await acquire(); const realNow = Date.now(); let expired = false;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow + (expired ? 120000 : 0));
    try {
      const handle = createSceneRunContext({...scope, traceBounds: {startNs: '0', endNs: '100'}, deadlineMs: realNow + 60000,
        assertAuthorized: () => {}, createEvidenceReadView: () => {
          const view = store.createEvidenceReadView(readOptions);
          return {...view, investigationEvidence: () => {const snapshot = view.investigationEvidence!(); expired = true; return snapshot;}};
        }});
      await expect(propose(handle)).rejects.toThrow('scene_run_deadline_exhausted');
      const snapshot = sealSceneTimeline(handle);
      expect(snapshot.revision).toBe(0); expect(snapshot.scanCoverage!.receipts).toHaveLength(0);
    } finally {clock.mockRestore();}
  });

  it.each([['unrelated'], ['start'], ['end']])('requires window schema even when the fact table is empty: %j', async (...columns) => {
    const store = await acquire(undefined, {summaryRows: [['0', '100', 0, 0, 1, 0]], factRows: [], factColumns: columns});
    expect(store.createEvidenceReadView(readOptions).investigationEvidence!().scans![0]).toMatchObject({
      scanStatus: 'partial', issues: ['scan_result_window_columns_missing']});
  });

});


describe('fixed scene query coverage denominator', () => {
  const target = {id: 'input', domain: 'input', source: 'all',
    producer: {skillId: 'scan_fixture', summaryStepId: 'summary', resultStepId: 'facts'}};
  const policy = {profileId: 'scene_reconstruction', profileVersion: 1, requiredTargets: [target]};
  const strategies = strategyLoader.buildStrategyRegistrySnapshotFromDefinitions({definitions: strategyLoader.getRegisteredScenes(), overlayGeneration: 'coverage-test'});
  const registry = () => snapshotSceneCoverageRegistry({getAllSkills: () => [fixtureDefinition()], getFragmentCache: () => new Map()}, strategies, 'scene_reconstruction');
  function configure(handle: ReturnType<typeof run>, input: unknown = policy) {
    jest.spyOn(strategyLoader, 'loadStrategyYaml').mockImplementation((_name, parse) => parse(input));
    initializeSceneCoveragePlan(handle, registry());
  }
  afterEach(() => jest.restoreAllMocks());
  it('permits query complete from issued empty results while observation and capture remain unknown', async () => {
    const handle = run(await acquire(undefined, {summaryRows: [['0', '100', 0, 0, 1, 0]], factRows: []}));
    configure(handle); await propose(handle);
    const snapshot = sealSceneTimeline(handle);
    const assessment = assessSceneTimeline(snapshot, scope);
    expect(assessment).toMatchObject({status: 'partial', coverage: {status: 'complete', captureStatus: 'unknown',
      planFingerprint: snapshot.scanCoverage!.plan!.fingerprint, targets: [{capabilityStatus: 'queryable',
        observationStatus: 'unobserved', scanStatus: 'complete', unscannedWindows: [],
        captureUnknownWindows: [{startNs: '0', endNs: '100'}]}]}});
    expect(() => assessSceneTimeline(JSON.parse(JSON.stringify(snapshot)), scope)).toThrow('unissued_scene_snapshot');
  });
  it('does not shrink the denominator when input-device or other required producers are missing', async () => {
    const handle = run(await acquire());
    configure(handle, {...policy, requiredTargets: [target, {id: 'input_device_state', domain: 'device', source: 'all'}]});
    await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage).toMatchObject({status: 'partial', targets: [
      {id: 'input', scanStatus: 'complete'}, {id: 'input_device_state', capabilityStatus: 'unknown', observationStatus: 'unknown',
        unscannedWindows: [{startNs: '0', endNs: '100'}], captureUnknownWindows: [{startNs: '0', endNs: '100'}]},
    ]});
  });
  it('pins actual definitions and rejects a receipt produced by a changed definition', async () => {
    const handle = run(await acquire());
    jest.spyOn(strategyLoader, 'loadStrategyYaml').mockImplementation((_name, parse) => parse(policy));
    const changed = fixtureDefinition(); changed.version = 'changed';
    initializeSceneCoveragePlan(handle, {...registry(), skills: [changed]});
    await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage.targets![0]).toMatchObject({scanStatus: 'unknown'});
    expect(buildSceneCoveragePlan(policy, registry()).fingerprint).not.toBe(sceneRunState(handle).coveragePlan!.fingerprint);
  });
  it('remembers failed attempts but a complete matching rescan closes their actual gap', async () => {
    const store = await acquire(undefined, {call: 'truncated', summaryRows: [['0', '100', 1, 1, 1, 0]]});
    await acquire(store, {call: 'repaired'});
    const handle = run(store); configure(handle); await propose(handle);
    const coverage = assessSceneTimeline(sealSceneTimeline(handle), scope).coverage;
    expect(coverage).toMatchObject({status: 'complete', targets: [{scanStatus: 'complete', issues: [],
      historicalIssues: ['scan_output_truncated_or_unknown']}]});
  });
  it('keeps a one-nanosecond gap between otherwise successful scans', async () => {
    const store = await acquire(undefined, {call: 'a', summaryRows: [['0', '49', 1, 0, 1, 0]], factRows: [['0', '49', 1, 'observed']]});
    await acquire(store, {call: 'b', summaryRows: [['50', '100', 1, 0, 1, 0]], factRows: [['50', '100', 1, 'observed']]});
    const handle = run(store); configure(handle); await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage).toMatchObject({status: 'partial', targets: [{
      unscannedWindows: [{startNs: '49', endNs: '50'}], scanStatus: 'partial'}]});
  });
  it.each([{maxRequiredTargets: 1}, {maxCoveragePlanBytes: 1}])('fails a whole over-budget plan without truncating its denominator %j', async limits => {
    const handle = run(await acquire(), limits);
    configure(handle, {...policy, requiredTargets: [target, {id: 'device', domain: 'device', source: 'all'}]});
    await propose(handle);
    expect(sceneRunState(handle).coveragePlan).toBeUndefined();
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage.status).toBe('unknown');
  });
  it('requires a real zero-width scan witness and keeps exact timestamps beyond 2^53', async () => {
    const point = '9007199254740993';
    const empty = run(new ArtifactStore(), undefined, false, {startNs: point, endNs: point});
    configure(empty); await propose(empty);
    expect(assessSceneTimeline(sealSceneTimeline(empty), scope).coverage.targets![0].unscannedWindows)
      .toEqual([{startNs: point, endNs: point}]);
    const store = await acquire(undefined, {summaryRows: [[point, point, 0, 0, 1, 0]], factRows: []});
    const complete = run(store, undefined, false, {startNs: point, endNs: point});
    configure(complete); await propose(complete);
    expect(assessSceneTimeline(sealSceneTimeline(complete), scope).coverage).toMatchObject({status: 'complete',
      targets: [{scannedWindows: [{startNs: point, endNs: point}], unscannedWindows: []}]});
  });
  it('does not discharge a global receipt budget failure with a later complete target scan', async () => {
    const store = await acquire(undefined, {call: 'one'}); await acquire(store, {call: 'two'});
    const handle = run(store, {maxScanReceipts: 1}); configure(handle); await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage).toMatchObject({status: 'partial',
      targets: [{issues: expect.arrayContaining(['scene_scan_receipt_budget_exhausted'])}]});
  });
  it('freezes policy and registry snapshots and permits only one initial binding', async () => {
    const skill = fixtureDefinition(), fragments = new Map([['unused', 'original']]);
    const originalFingerprint = fingerprintSkillDefinition(skill, fragments);
    const original = snapshotSceneCoverageRegistry({getAllSkills: () => [skill], getFragmentCache: () => fragments}, strategies, 'scene_reconstruction');
    expect(fingerprintSkillDefinition(original.skills[0], original.fragments)).toBe(originalFingerprint);
    skill.version = 'changed'; fragments.set('unused', 'changed');
    expect(original.skills[0].version).toBe('1'); expect(original.fragments.get('unused')).toBe('original');
    const handle = run(await acquire()); configure(handle);
    expect(() => initializeSceneCoveragePlan(handle, original)).toThrow('scene_coverage_already_initialized');
    expect(() => initializeSceneCoveragePlan(JSON.parse(JSON.stringify(handle)), original)).toThrow('unissued_scene_context');
    expect(Object.isFrozen(sceneRunState(handle).coveragePlan)).toBe(true);
  });
  it('binds policy profile/version to the pinned strategy and preserves supplied registry identity', async () => {
    expect(() => buildSceneCoveragePlan({...policy, profileVersion: 2}, registry())).toThrow('scene_coverage_profile_mismatch');
    expect(() => buildSceneCoveragePlan({...policy, profileId: 'typo'}, registry())).toThrow('scene_coverage_profile_mismatch');
    const plan = buildSceneCoveragePlan(policy, {...registry(), registryFingerprint: 'actual-registered-snapshot'});
    expect(plan.registryFingerprint).toBe('actual-registered-snapshot');
    const handle = run(await acquire()); configure(handle, {...policy, profileVersion: 2}); await propose(handle);
    expect(assessSceneTimeline(sealSceneTimeline(handle), scope).coverage.status).toBe('unknown');
  });
  it('rejects empty, duplicated, aliased and unexpected policy claims', () => {
    for (const requiredTargets of [[], [target, target], [target, {...target, id: 'alias'}]])
      expect(sceneCoveragePolicySchema.safeParse({...policy, requiredTargets}).success).toBe(false);
    expect(sceneCoveragePolicySchema.safeParse({...policy, complete: true}).success).toBe(false);
  });
});
