// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {ArtifactStore} from '../../../agentv3/artifactStore';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {McpToolRegistry} from '../../../agentv3/mcpToolRegistry';
import {SkillExecutor} from '../../skillEngine/skillExecutor';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {captureEvidenceTable, evidenceTableFor} from '../evidenceCapture';
import {isIssuedInvestigationEvidenceSnapshot, investigationEvidenceFingerprint, compactInvestigationEvidence,
  compactInvestigationEvidenceForSemantic,
  investigationCaptureFields, validateInvestigationEvidenceDeclarations, LEDGER_PER_METRIC_BUDGET,
  type InvestigationEvidenceDeclaration, type InvestigationEvidenceSnapshot} from '../investigationEvidenceLedger';
import type {RuntimeToolInvocationEvent} from '../../../agentRuntime/runtimeToolObserver';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../../finalSemanticLimits';

const declaration: InvestigationEvidenceDeclaration = {window: {start: 'start', end: 'end'},
  identity: {upid: 'upid', utid: 'utid'}, metrics: [{domain: 'cpu_frequency', metric_id: 'system.cpu.frequency.time_weighted',
    value: 'freq', unit: 'kHz', status: 'status', coverage: 'coverage', denominator: 'denominator'}]};
const options = {ownerKey: 'owner', currentRunId: 'run-1', allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]};
const row = [10, 110, 42, 43, 1234, 'observed', 100, 100];
const observation = (phase: 'started' | 'completed' | 'failed', toolCallId = 'call'): RuntimeToolInvocationEvent => ({
  toolCallId, toolName: 'fixture', params: {}, extra: {}, phase,
  ...(phase === 'completed' ? {result: {content: []}} : phase === 'failed' ? {error: new Error('fixture')} : {}),
} as RuntimeToolInvocationEvent);

async function fixture(rows: unknown[][] = [row], settings: {observe?: boolean; declared?: boolean; originRunId?: string;
  declaration?: InvestigationEvidenceDeclaration; extraColumns?: string[];
  executionStatus?: 'optional_error' | 'unavailable' | 'skipped'} = {}) {
  const executor = new SkillExecutor({query: async () => ({columns: ['start', 'end', 'upid', 'utid', 'freq', 'status', 'coverage', 'denominator', ...(settings.extraColumns || [])],
    rows, durationMs: 1})});
  executor.registerSkill({name: 'ledger_fixture', version: '1', type: 'atomic',
    meta: {display_name: 'Fixture', description: 'Pre-display system evidence'}, process_scope: {role: 'global_context'},
    sql: 'SELECT * FROM actual_system_evidence', ...(settings.declared === false ? {} : {investigation_evidence: settings.declaration || declaration}),
    output: {display: {layer: 'overview', level: 'summary', format: 'table', columns: [{name: 'freq', type: 'number'}]}}});
  const result = await executor.execute('ledger_fixture', 'trace');
  expect(result.success).toBe(true);
  const display = result.displayResults[0];
  const store = new ArtifactStore();
  const originRunId = settings.originRunId || 'run-1';
  if (settings.observe !== false) {
    store.observeInvestigationTool(observation('started'), originRunId);
    store.observeInvestigationTool(observation('completed'), originRunId);
  }
  const artifactId = store.store({skillId: result.skillId, data: display.data, executionStatus: settings.executionStatus,
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'}), sourceToolCallId: 'call'});
  store.registerEvidenceCapture(artifactId, evidenceTableFor(display)!, {evidenceRefId: 'evidence:fixture', originRunId});
  return {store, artifactId, display};
}

describe('trusted investigation evidence ledger', () => {
  it('accepts a producer-owned window without inventing metric records', async () => {
    const windowOnly = {window: {start: 'start', end: 'end'}, metrics: []};
    expect(() => validateInvestigationEvidenceDeclarations({investigation_evidence: windowOnly})).not.toThrow();
    const {store} = await fixture([row], {declaration: windowOnly});
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.scans ?? []).toEqual([]);
    for (const window of [undefined, {start: '', end: 'end'}, {start: 'start', end: 1}, {start: 'same', end: 'same'}]) {
      expect(() => validateInvestigationEvidenceDeclarations({investigation_evidence: {window, metrics: []}})).toThrow();
    }
  });
  it('issues identity roles from producer mappings rather than guessed column names', () => {
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'producer', selectedSqlHash: 'sql'};
    const fields = investigationCaptureFields({...declaration,
      identity: {upid: 'target_instance', machine_id: 'machine'}}, origin);
    expect(fields.target_instance).toEqual({origin, identityRole: 'upid'});
    expect(fields.machine).toEqual({origin, identityRole: 'machine_id'});
    expect(fields.upid).toBeUndefined();
    expect(() => investigationCaptureFields({...declaration, identity: {upid: 'target', utid: 'target'}}, origin))
      .toThrow('identityRole');
  });

  it('retains producer-issued identity semantics in the actual execution read view', async () => {
    const {store, artifactId} = await fixture();
    const [resolution] = await store.createEvidenceReadView(options).resolveReferences([
      {key: 'identity', reference: {artifactId, rowIndex: 0}, requiredColumns: ['upid', 'utid']},
    ]);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') throw new Error('Missing execution capture');
    expect(resolution.record.fields.upid).toMatchObject({identityRole: 'upid', origin: {kind: 'skill_literal'}});
    expect(resolution.record.fields.utid.identityRole).toBe('utid');
  });

  it('preserves real thread-summary metric semantics when running time also denominates placement', () => {
    const skill = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/atomic/thread_system_summary_in_range.skill.yaml'), 'utf8')) as {
      investigation_evidence: InvestigationEvidenceDeclaration};
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'actual-thread-summary'};
    const fields = investigationCaptureFields(skill.investigation_evidence, origin);
    expect(fields.running_ns).toEqual({origin, unit: 'ns', timeRole: 'duration', metricId: 'system.thread.state.duration'});
    expect(fields.avg_freq_khz).toMatchObject({unit: 'kHz', metricId: 'system.thread.frequency.running_weighted', aggregation: 'running_time_weighted'});
    expect(investigationCaptureFields({...skill.investigation_evidence,
      metrics: [...skill.investigation_evidence.metrics].reverse()}, origin)).toEqual(fields);
    expect(() => validateInvestigationEvidenceDeclarations(skill)).not.toThrow();
  });

  it.each(['unit', 'timeRole'] as const)('rejects conflicting %s producer authority before registration', conflict => {
    const malformed = {...declaration, metrics: [{...declaration.metrics[0],
      denominator: conflict === 'unit' ? 'freq' : 'start'}]};
    expect(() => validateInvestigationEvidenceDeclarations({investigation_evidence: malformed}))
      .toThrow(`conflicting field semantics: ${conflict === 'unit' ? 'freq.unit' : 'start.timeRole'}`);
  });
  it('observes declared acquisitions once and isolates diagnostic observer failures', async () => {
    const phases: string[] = [];
    const registry = new McpToolRegistry({acquisitionObserver: event => {phases.push(event.phase);},
      toolObserver: () => {throw new Error('diagnostics unavailable');}});
    for (const effect of ['acquire', 'none'] as const) registry.registerShared({name: effect, description: 'fixture',
      inputSchema: {}, exposure: 'public', evidenceEffect: effect, handler: async () => ({content: []})});
    for (const tool of registry.list()) await expect(tool.shared.handler({}, {})).resolves.toEqual({content: []});
    expect(phases).toEqual(['started', 'completed']);
  });

  // A real 10s scrolling trace filled the whole ledger with one per-handoff
  // metric, so every requirement acquired later read as unacquired because its
  // records never got in. The per-metric share keeps one producer from
  // deciding what the rest of the run is allowed to record.
  it('caps a single metric so a later producer still reaches the ledger', async () => {
    const chatty = Array.from({length: LEDGER_PER_METRIC_BUDGET + 40},
      (_, index) => [10 + index, 110 + index, 42, 43, 1234, 'observed', 100, 100]);
    const {store} = await fixture(chatty);
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.records).toHaveLength(LEDGER_PER_METRIC_BUDGET);
    expect(snapshot.issues).toContain('ledger_metric_budget_exhausted');
    // Truncating one metric is scoped to that metric; it is not the
    // whole-ledger verdict, which other requirements read as insufficient.
    expect(snapshot.issues).not.toContain('ledger_record_budget_exhausted');
    expect(snapshot.records.every(record => record.metricId === 'system.cpu.frequency.time_weighted')).toBe(true);
  });

  it('rejects malformed declarations before Skill registration', () => {
    const executor = new SkillExecutor({query: async () => ({columns: [], rows: [], durationMs: 1})});
    expect(() => executor.registerSkill({name: 'invalid', version: '1', type: 'atomic',
      meta: {display_name: 'Invalid', description: 'Invalid declaration'}, sql: 'SELECT 1',
      investigation_evidence: {...declaration, metrics: [{...declaration.metrics[0], denominator: undefined}]}}))
      .toThrow('Invalid investigation_evidence');
  });
  it('retains original identity, window, units and values through real executor display projection', async () => {
    const {store, display, artifactId} = await fixture();
    expect(display.data.columns).toHaveLength(1);
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.records).toMatchObject([{domain: 'cpu_frequency', metricId: 'system.cpu.frequency.time_weighted',
      window: {start: 10, end: 110}, upid: 42, utid: 43, value: 1234, unit: 'kHz', status: 'observed', origin: 'current_run'}]);
    expect(isIssuedInvestigationEvidenceSnapshot(snapshot)).toBe(true);
    expect(isIssuedInvestigationEvidenceSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(false);
    expect(snapshot.fingerprint).toBe(investigationEvidenceFingerprint(snapshot));
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    const [read] = await store.createEvidenceReadView(options).resolveReferences([{key: 'freq',
      reference: {artifactId, rowIndex: 0}, requiredColumns: ['freq', 'start']}]);
    expect(read).toMatchObject({status: 'resolved', record: {fields: {
      freq: {unit: 'kHz', metricId: 'system.cpu.frequency.time_weighted'}, start: {unit: 'ns', timeRole: 'start'},
    }}});
  });

  it('keeps distinct task/window records and partial coverage instead of global success', async () => {
    const {store} = await fixture([row, [110, 210, 42, 44, 2400, 'observed', 50, 100]]);
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.records.map(record => record.status)).toEqual(['observed', 'partial']);
    expect(new Set(snapshot.records.map(record => record.recordId)).size).toBe(2);
    expect(snapshot.records[1]).toMatchObject({utid: 44, window: {start: 110, end: 210}});
  });

  it('preserves declared CPU/machine identity, null unknowns, role and aggregation', async () => {
    const {store} = await fixture([[...row, 1, 9, null, 'window-1', 'global_context']], {
      extraColumns: ['cpu', 'ucpu', 'machine', 'window_id', 'scope_role'], declaration: {...declaration,
        identity: {...declaration.identity, cpu: 'cpu', ucpu: 'ucpu', machine_id: 'machine'},
        context: {window_id: 'window_id', role: 'scope_role'},
        metrics: [{...declaration.metrics[0], aggregation: 'window_time_weighted'}]}});
    expect(store.createEvidenceReadView(options).investigationEvidence!().records[0]).toMatchObject({cpu: 1, ucpu: 9,
      machineId: null, windowId: 'window-1', role: 'global_context', aggregation: 'window_time_weighted'});
  });

  it('identifies an incomplete capture even when a malformed sibling row is skipped', async () => {
    const {store} = await fixture([row, [null, 110, ...row.slice(2)]]);
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].status).toBe('observed');
    expect(snapshot.incompleteCaptureIds).toEqual([snapshot.records[0].captureId]);
    expect(snapshot.complete).toBe(false);
  });

  it('keeps a visible unknown metric local without invalidating other metrics in that capture', async () => {
    const {store} = await fixture([row], {declaration: {...declaration,
      metrics: [...declaration.metrics, {...declaration.metrics[0], metric_id: 'missing.metric', value: 'missing_value'}]}});
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.records.map(record => record.status)).toEqual(['observed', 'unknown']);
    expect(snapshot.incompleteCaptureIds).toEqual([]);
    expect(snapshot.issues).toContain('capture_metric_unknown');
  });

  it('preserves exact decimal nanoseconds beyond the safe number range', async () => {
    const {store} = await fixture([['9007199254740993', '9007199254741093', ...row.slice(2, 6), '99', '100']]);
    expect(store.createEvidenceReadView(options).investigationEvidence!().records[0]).toMatchObject({
      window: {start: '9007199254740993', end: '9007199254741093'}, coverage: '99', denominator: '100', status: 'partial'});
  });

  it.each([null, 0])('preserves missing-versus-zero raw value %p', async value => {
    const {store} = await fixture([[...row.slice(0, 4), value, ...row.slice(5)]]);
    expect(store.createEvidenceReadView(options).investigationEvidence!().records[0])
      .toMatchObject({value, status: value === null ? 'unavailable' : 'observed'});
  });

  it('does not count arbitrary SQL aliases, serialized snapshots, or forged witnesses', async () => {
    const {store} = await fixture([row], {declared: false});
    expect(store.createEvidenceReadView(options).investigationEvidence!().records).toEqual([]);
    const {store: issued, artifactId} = await fixture();
    const restored = ArtifactStore.fromSnapshot(issued.serialize());
    expect(restored.createEvidenceReadView(options).investigationEvidence!().records).toEqual([]);
    expect(issued.registerEvidenceCapture(artifactId, {captureId: 'fake'}, {evidenceRefId: 'fake'})).toBe(false);
    expect(issued.registerEvidenceCapture(artifactId, captureEvidenceTable([row]), {evidenceRefId: 'fake'})).toBe(true);
    expect(issued.createEvidenceReadView(options).investigationEvidence!().records).toEqual([]);
  });

  it('requires real matching tool observations without turning missing observation into execution failure', async () => {
    const {store} = await fixture([row], {observe: false});
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.records[0].status).toBe('unknown');
    expect(snapshot.issues).toContain('capture_tool_observation_missing');
  });

  it('preserves origin on reused evidence and ignores unrelated historical failures', async () => {
    const {store} = await fixture([row], {originRunId: 'old-run'});
    store.observeInvestigationTool(observation('failed', 'old-failed'), 'old-run');
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.records[0]).toMatchObject({origin: 'reused', originRunId: 'old-run', status: 'observed'});
  });

  it('cannot relabel an old execution witness as current by registering another artifact', async () => {
    const {store, display, artifactId} = await fixture([row], {originRunId: 'old-run'});
    store.registerEvidenceCapture(artifactId, evidenceTableFor(display)!, {evidenceRefId: 'reregistered', originRunId: 'run-1'});
    expect(store.createEvidenceReadView(options).investigationEvidence!().records[0])
      .toMatchObject({origin: 'reused', originRunId: 'old-run'});
  });

  it.each([[10, 10], [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2], [null, 110]])(
    'rejects invalid or precision-lost window %p %p', async (start, end) => {
      const {store} = await fixture([[start, end, ...row.slice(2)]]);
      const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
      expect(snapshot.complete).toBe(false);
      expect(snapshot.records).toEqual([]);
    });

  it('denies wrong trace sides and never converts empty result to observed zero', async () => {
    const {store} = await fixture();
    expect(store.createEvidenceReadView({...options, allowedTraces: [{traceId: 'trace', traceSide: 'reference'}]})
      .investigationEvidence!().records).toEqual([]);
    const empty = await fixture([]);
    expect(empty.store.createEvidenceReadView(options).investigationEvidence!()).toMatchObject({records: [], complete: false});
  });

  it('never records a condition-skipped capture and reports it apart from unavailable execution', async () => {
    const skipped = (await fixture([row], {executionStatus: 'skipped'})).store.createEvidenceReadView(options).investigationEvidence!();
    expect(skipped).toMatchObject({records: [], complete: false});
    expect(skipped.issues).toContain('capture_execution_skipped');
    expect(skipped.issues).not.toContain('capture_execution_unavailable');
    const unavailable = (await fixture([row], {executionStatus: 'unavailable'})).store.createEvidenceReadView(options).investigationEvidence!();
    expect(unavailable.issues).toContain('capture_execution_unavailable');
  });
});

describe('bounded investigation provider view', () => {
  async function largeSnapshot(): Promise<InvestigationEvidenceSnapshot> {
    const {store} = await fixture();
    const original = store.createEvidenceReadView(options).investigationEvidence!();
    const records = Array.from({length: 300}, (_, index) => ({...original.records[0], recordId: `record-${index}`,
      cpu: index % 10, value: '系统频率'.repeat(40), status: index % 3 === 0 ? 'partial' as const : 'observed' as const,
      window: {start: 100 * Math.floor(index / 10), end: 100 * Math.floor(index / 10) + 100}}));
    return {...original, records};
  }

  it('bounds UTF-8 bytes deterministically and omits only whole cohorts without filtering status', async () => {
    const snapshot = await largeSnapshot();
    const compact = compactInvestigationEvidence(snapshot)!;
    expect(Buffer.byteLength(JSON.stringify(compact), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(compact.records.length).toBeGreaterThan(0);
    expect(compact.records.length).toBeLessThan(300);
    expect(compact.records.length % 10).toBe(0);
    expect(compact.omittedRecordCount).toBe(300 - compact.records.length);
    expect(compact.records[0].status).toBe('partial');
    expect(compact.complete).toBe(false);
    expect(compact.fingerprint).toBe(snapshot.fingerprint);
    expect(compact).toEqual(compactInvestigationEvidence(snapshot));
    expect(snapshot.records).toHaveLength(300);
    expect(compact.records[0]).not.toHaveProperty('definitionFingerprint');
    expect(compact.records[0]).not.toHaveProperty('sourceToolCallId');
  });

  it('does not skip an oversized first cohort to cherry pick smaller later successful records', async () => {
    const snapshot = await largeSnapshot();
    const compact = compactInvestigationEvidence(snapshot, 2048)!;
    expect(compact.records).toEqual([]);
    expect(compact.omittedRecordCount).toBe(300);
    expect(compact.issues).toContain('investigation_provider_view_omitted_records');
    expect(compactInvestigationEvidence(snapshot, 0)).toBeUndefined();
    expect(compactInvestigationEvidence(snapshot, 65537)).toBeUndefined();
  });

  it('keeps the general 64 KiB ceiling while semantic review can carry all cohorts within its total cap', async () => {
    const snapshot = await largeSnapshot();
    expect(compactInvestigationEvidence(snapshot, 64 * 1024 + 1)).toBeUndefined();
    const semantic = compactInvestigationEvidenceForSemantic(snapshot, FINAL_SEMANTIC_INPUT_BYTE_LIMIT)!;
    expect(semantic.byteBudget).toBe(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(semantic), 'utf8')).toBeLessThanOrEqual(semantic.byteBudget);
    expect(semantic.records).toHaveLength(snapshot.records.length);
    expect(semantic.omittedRecordCount).toBe(0);
    expect(semantic.complete).toBe(snapshot.complete);
    expect(compactInvestigationEvidenceForSemantic(snapshot, FINAL_SEMANTIC_INPUT_BYTE_LIMIT + 1)).toBeUndefined();
  });

  it('retains complete small evidence and incomplete capture provenance', async () => {
    const {store} = await fixture([row, [null, 110, ...row.slice(2)]]);
    const snapshot = store.createEvidenceReadView(options).investigationEvidence!();
    const compact = compactInvestigationEvidence(snapshot)!;
    expect(compact.records).toHaveLength(1);
    expect(compact.omittedRecordCount).toBe(0);
    expect(compact.complete).toBe(false);
    expect(compact.incompleteCaptureIds).toEqual(snapshot.incompleteCaptureIds);
  });
});
