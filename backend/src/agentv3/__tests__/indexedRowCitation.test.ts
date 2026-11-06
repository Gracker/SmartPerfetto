// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Rows the model sees out of order (an interest-sorted SQL summary) or from a
 * non-zero page offset carry their artifact-wide rowIndex inline. A claim that
 * copies that index resolves to the original captured row; a wrong cell is
 * still a contradiction.
 *
 * Regression for a real run: a 15-row thread query ordered main thread first
 * was summarized by slice_count, putting HeapTaskDaemon at sample position 0.
 * The model cited sample positions as rowIndex and a correct answer ended `!`.
 */

import {describe, expect, it, jest} from '@jest/globals';
import {createClaudeMcpServer} from '../claudeMcpServer';
import {ArtifactStore} from '../artifactStore';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {QueryResult, TraceProcessorService} from '../../services/traceProcessorService';
import {parseConclusionContractDeclaration, type ConclusionContractClaimReference} from '../../agent/core/conclusionContract';
import {prepareClaimEvidence} from '../../services/evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../services/verifier/claimVerificationRunner';

const TRACE_ID = 'trace-indexed-rows';
const PROBE_ROWS: QueryResult['rows'] = [
  ['com.example.app', 1, 40],
  ['HeapTaskDaemon', 0, 90],
  ...Array.from({length: 13}, (_, index) => [`worker-${index}`, 0, 10 - index]),
];
const METRIC_ROWS: QueryResult['rows'] = Array.from({length: 60}, (_, index) => [index, `slice-${index}`]);

function fixture() {
  const query = jest.fn(async (_traceId: string, sql: string): Promise<QueryResult> => {
    if (sql.includes('probe_threads')) {
      return {columns: ['thread_name', 'is_main_thread', 'slice_count'], rows: PROBE_ROWS, durationMs: 1};
    }
    if (sql.includes('metric_rows')) return {columns: ['id', 'slice_name'], rows: METRIC_ROWS, durationMs: 1};
    return {columns: [], rows: [], durationMs: 0};
  });
  const traceProcessorService = {query} as unknown as TraceProcessorService;
  const artifactStore = new ArtifactStore();
  const mcp = createClaudeMcpServer({
    sessionId: 'session-indexed-rows', traceId: TRACE_ID,
    traceProcessorService, skillExecutor: new SkillExecutor(traceProcessorService), artifactStore,
    emitUpdate: () => {},
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const definition = mcp.toolDefinitions.find(tool => tool.name === name)!;
    const response = await definition.shared.handler(args, {});
    expect(response.isError).not.toBe(true);
    return response.structuredContent as Record<string, any>;
  };
  // A read view admits the captures that exist when it is created, like finalization.
  const readView = () => artifactStore.createEvidenceReadView({
    ownerKey: 'indexed-rows-owner', allowedTraces: [{traceId: TRACE_ID, traceSide: 'current'}]});
  return {call, readView};
}

async function verifyCell(readView: () => ReturnType<ArtifactStore['createEvidenceReadView']>,
  reference: ConclusionContractClaimReference) {
  const conclusionContract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: [{id: 'cell', kind: 'identity', text: `The cited cell is ${String(reference.value)}.`, references: [reference],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'captured.cell', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [reference]}}}],
  }).contract!;
  const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: readView()});
  const claim = runClaimVerification({conclusionContract, preparedEvidence}).claimVerificationResult.claimResults[0];
  return {reference: claim.referenceResults?.[0]?.status, proof: claim.deterministicProof?.status};
}

describe('indexed model-visible rows', () => {
  it('lets a claim cite the inline rowIndex of an interest-sorted summary sample', async () => {
    const {call, readView} = fixture();
    const result = await call('execute_sql', {sql: 'SELECT * FROM probe_threads', summary: true});
    expect(result).toMatchObject({mode: 'summary', rowShape: 'indexed_rows@1', totalRows: 15});
    // Sample position 0 is the busier daemon; the main thread is second but keeps rowIndex 0.
    expect(result.sampleRows.slice(0, 2)).toEqual([
      {rowIndex: 1, values: ['HeapTaskDaemon', 0, 90]},
      {rowIndex: 0, values: ['com.example.app', 1, 40]},
    ]);
    const main = result.sampleRows.find((sample: any) => sample.values[1] === 1);
    const cite = (rowIndex: number, value: string) =>
      ({evidenceRefId: result.evidenceRefId, rowIndex, column: 'thread_name', value});

    expect(await verifyCell(readView, cite(main.rowIndex, 'com.example.app')))
      .toEqual({reference: 'matched', proof: 'proved'});
    // The failure the inline index removes: the sample position names another row.
    const position = result.sampleRows.indexOf(main);
    expect(await verifyCell(readView, cite(position, 'com.example.app'))).toMatchObject({reference: 'value_mismatch'});
    // Strictness is unchanged: a wrong cell at the right row is still a contradiction.
    expect(await verifyCell(readView, cite(main.rowIndex, 'HeapTaskDaemon'))).toMatchObject({reference: 'value_mismatch'});
  });

  it('numbers fetched artifact pages from their offset and resolves them to the captured row', async () => {
    const {call, readView} = fixture();
    const summary = await call('execute_sql', {sql: 'SELECT * FROM metric_rows'});
    expect(summary).toMatchObject({autoSummarized: true, rowShape: 'indexed_rows@1'});
    const page = await call('fetch_artifact', {artifactId: summary.artifactId, detail: 'rows', offset: 50, limit: 3});
    expect(page.rowShape).toBe('indexed_rows@1');
    expect(page.rows).toEqual([50, 51, 52].map(rowIndex => ({rowIndex, values: [rowIndex, `slice-${rowIndex}`]})));
    expect(await verifyCell(readView,
      {artifactId: summary.artifactId, rowIndex: page.rows[1].rowIndex, column: 'slice_name', value: 'slice-51'}))
      .toEqual({reference: 'matched', proof: 'proved'});
    // detail="full" keeps the original structure, numbered from 0 in order.
    const full = await call('fetch_artifact', {artifactId: summary.artifactId, detail: 'full'});
    expect(full).not.toHaveProperty('rowShape');
    expect(full.data.rows[0]).toEqual([0, 'slice-0']);
  });
});

// B2: real MCP producers; private preparation is not HTTP visibility or adoption.
describe('quote views follow the final MCP projection', () => {
  type Scope = {runId: string; allowedTraces: Array<{traceId: string; traceSide: 'current' | 'reference'}>};
  type Factory = (input: {store: ArtifactStore; scope: Scope; assertCurrent(): void;
    productSignal: AbortSignal; deadlineAtMs: number}) => ReturnType<typeof import('../../services/evidence/evidenceQuoteContext').createEvidenceQuoteContext>;
  type View = {viewId: string; artifactId?: string; evidenceRefId?: string; rows: number[]; columns: string[];
    page: {hasMore: 'yes' | 'no' | 'unknown'; coverage: 'visible_page_only'}};
  const runId = 'run-quote-mcp', referenceTrace = 'trace-quote-reference';
  const contexts: Array<{dispose(): void}> = [];
  const {afterEach} = require('@jest/globals') as typeof import('@jest/globals');
  afterEach(() => {for (const context of contexts.splice(0)) context.dispose();});
  function quoteFactory(): Factory {
    const file = require('node:path').resolve(__dirname, '../../services/evidence/evidenceQuoteContext.ts') as string;
    expect(require('node:fs').existsSync(file)).toBe(true);
    const api = jest.requireActual<{createEvidenceQuoteContext?: Factory}>(file);
    expect(typeof api.createEvidenceQuoteContext).toBe('function');
    if (!api.createEvidenceQuoteContext) throw new Error('Missing B2 createEvidenceQuoteContext');
    return api.createEvidenceQuoteContext;
  }
  function object(value: unknown): Record<string, unknown> {
    expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object payload');
    return value as Record<string, unknown>;
  }
  function viewList(payload: Record<string, unknown>): View[] {
    if (payload.quoteViews === undefined) return [];
    expect(Array.isArray(payload.quoteViews)).toBe(true);
    if (!Array.isArray(payload.quoteViews)) throw new Error('Expected quoteViews array');
    return payload.quoteViews.map(value => {
      const view = object(value), page = object(view.page);
      expect(typeof view.viewId).toBe('string');
      expect(Number(typeof view.artifactId === 'string') + Number(typeof view.evidenceRefId === 'string')).toBe(1);
      expect(Array.isArray(view.rows) && view.rows.every(row => Number.isSafeInteger(row) && row >= 0)).toBe(true);
      expect(Array.isArray(view.columns) && view.columns.every(column => typeof column === 'string')).toBe(true);
      expect(Object.keys(view).sort()).toEqual(['columns', 'page', 'rows', 'viewId', typeof view.artifactId === 'string' ? 'artifactId' : 'evidenceRefId'].sort());
      expect(Object.keys(page).sort()).toEqual(['coverage', 'hasMore']);
      expect(page.coverage).toBe('visible_page_only');
      expect(['yes', 'no', 'unknown']).toContain(page.hasMore);
      return value as View;
    });
  }
  function producer(options: {userQuery?: string; lightweight?: boolean; executor?: SkillExecutor;
    store?: ArtifactStore; quote?: boolean; rowCount?: number} = {}) {
    const store = options.store ?? new ArtifactStore();
    const query = jest.fn(async (_traceId: string, sql: string): Promise<QueryResult> => {
      if (sql.includes('probe_threads')) return {columns: ['thread_name', 'is_main_thread', 'slice_count'], rows: PROBE_ROWS, durationMs: 1};
      if (sql.includes('quote_step')) return {columns: ['value'], rows: [[Number(/quote_step_(\d+)/.exec(sql)?.[1] ?? 0)]], durationMs: 1};
      if (sql.includes('small_rows')) return {columns: ['id', 'value'], rows: [[0, 1000], [1, 1001], [2, 1002]], durationMs: 1};
      return {columns: ['id', 'value'], rows: Array.from({length: options.rowCount ?? 60}, (_, index) => [index, 1000 + index]), durationMs: 1};
    });
    const service = {query} as unknown as TraceProcessorService;
    const quoteContext = options.quote === false ? undefined : quoteFactory()({store,
      scope: {runId, allowedTraces: [{traceId: TRACE_ID, traceSide: 'current'}, {traceId: referenceTrace, traceSide: 'reference'}]},
      assertCurrent() {}, productSignal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000});
    if (quoteContext) contexts.push(quoteContext);
    const config = {sessionId: 'session-quote-mcp', runId, traceId: TRACE_ID, referenceTraceId: referenceTrace,
      traceProcessorService: service, skillExecutor: options.executor ?? new SkillExecutor(service), artifactStore: store,
      emitUpdate: () => {}, outputLanguage: 'en' as const, userQuery: options.userQuery,
      lightweight: options.lightweight, quoteContext};
    const mcp = createClaudeMcpServer(config);
    const call = async (name: string, args: Record<string, unknown>) => {
      const definition = mcp.toolDefinitions.find(item => item.name === name);
      expect(definition).toBeDefined();
      if (!definition) throw new Error('Expected registered producer');
      const result = await definition.shared.handler(args, {toolCallId: `quote-call-${name}`});
      return {result, payload: object(result.structuredContent)};
    };
    return {store, query, service, call, quoteContext};
  }

  it.each(['execute_sql', 'execute_sql_on'] as const)('binds %s summary sample order, not derived statistics or hidden rows', async name => {
    const h = producer();
    const {payload} = await h.call(name, {sql: 'SELECT * FROM probe_threads', summary: true,
      ...(name === 'execute_sql_on' ? {trace: 'reference'} : {})});
    const summary = name === 'execute_sql_on' ? object(payload.summary) : payload;
    const samples = summary.sampleRows;
    expect(Array.isArray(samples)).toBe(true);
    if (!Array.isArray(samples)) throw new Error('Expected indexed samples');
    const visible = samples.map(sample => object(sample).rowIndex);
    expect(visible.slice(0, 2)).toEqual([1, 0]);
    const views = viewList(payload);
    expect(views.length).toBeGreaterThan(0);
    const sampleView = views.find(view => view.rows.length === visible.length);
    expect(sampleView?.rows).toEqual(visible);
    expect(sampleView?.columns).toEqual(['thread_name', 'is_main_thread', 'slice_count']);
    for (const derived of ['avg', 'p95', 'nullCount']) expect(views.flatMap(view => view.columns)).not.toContain(derived);
    expect(JSON.stringify(views)).not.toMatch(/totalRows|originalBytes|metricId|populationKey|aggregation|origin/);
    expect(payload.traceSide).toBe(name === 'execute_sql_on' ? 'reference' : 'current');
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it.each(['execute_sql', 'execute_sql_on'] as const)('offers only final raw %s rows under their registered locator', async name => {
    const h = producer();
    const {payload} = await h.call(name, {sql: 'SELECT * FROM small_rows',
      ...(name === 'execute_sql_on' ? {trace: 'reference'} : {})});
    expect(payload.success).toBe(true);
    expect(payload.rows).toEqual([[0, 1000], [1, 1001], [2, 1002]]);
    expect(viewList(payload)).toEqual([expect.objectContaining({evidenceRefId: payload.evidenceRefId,
      rows: [0, 1, 2], columns: ['id', 'value']})]);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('keeps fetch offset/full pages and the old quote-disabled payload on their original row indices', async () => {
    const h = producer();
    const {payload} = await h.call('execute_sql', {sql: 'SELECT * FROM metric_rows'});
    const artifactId = payload.artifactId;
    expect(typeof artifactId).toBe('string');
    const page = (await h.call('fetch_artifact', {artifactId, detail: 'rows', offset: 50, limit: 3})).payload;
    expect(page.rows).toEqual([50, 51, 52].map(rowIndex => ({rowIndex, values: [rowIndex, 1000 + rowIndex]})));
    expect(viewList(page)).toEqual([expect.objectContaining({artifactId, rows: [50, 51, 52], columns: ['id', 'value'],
      page: {hasMore: 'yes', coverage: 'visible_page_only'}})]);
    const legacy = producer({store: h.store, quote: false});
    const old = (await legacy.call('fetch_artifact', {artifactId, detail: 'rows', offset: 50, limit: 3})).payload;
    expect(old).not.toHaveProperty('quoteViews');
    expect(old.rows).toEqual(page.rows);
    const full = (await h.call('fetch_artifact', {artifactId, detail: 'full'})).payload;
    expect(viewList(full)).toEqual([expect.objectContaining({artifactId,
      rows: Array.from({length: 60}, (_, index) => index), columns: ['id', 'value']})]);
    expect(object(full.data).rows).toEqual(Array.from({length: 60}, (_, index) => [index, 1000 + index]));
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(legacy.query).not.toHaveBeenCalled();
  });

  it('keeps forbidRows summaries row-free and gives their derived aggregates no raw-cell view', async () => {
    const h = producer(); const original = (await h.call('execute_sql', {sql: 'SELECT * FROM metric_rows'})).payload;
    const restricted = producer({store: h.store, userQuery: 'Do not read raw rows.'});
    const response = (await restricted.call('fetch_artifact', {artifactId: original.artifactId, detail: 'summary'})).payload;
    expect(response.aggregate).toBeDefined();
    expect(response).not.toHaveProperty('sampleRow'); expect(response).not.toHaveProperty('preview');
    expect(viewList(response)).toEqual([]);
    expect(restricted.query).not.toHaveBeenCalled();
  });

  it('binds a full fetch only to the existing full-row cap, never the hidden backing tail', async () => {
    const count = ArtifactStore.MAX_FULL_ROWS + 7, h = producer({rowCount: count});
    const summary = (await h.call('execute_sql', {sql: 'SELECT * FROM metric_rows'})).payload;
    const full = (await h.call('fetch_artifact', {artifactId: summary.artifactId, detail: 'full'})).payload;
    expect(object(full.data).rows).toHaveLength(ArtifactStore.MAX_FULL_ROWS);
    const views = viewList(full);
    expect(views).toEqual([expect.objectContaining({rows: Array.from({length: ArtifactStore.MAX_FULL_ROWS}, (_, index) => index)})]);
    expect(views[0].rows).not.toContain(count - 1);
    expect(Object.keys(views[0]).sort()).toEqual(['artifactId', 'columns', 'page', 'rows', 'viewId']);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it.each([{lightweight: false, forbidRows: false}, {lightweight: true, forbidRows: false}, {lightweight: true, forbidRows: true}])(
    'prepares actual invoke_skill previews after lightweight=$lightweight / forbidRows=$forbidRows', async ({lightweight, forbidRows}) => {
    const {withEffectiveRuntimeRegistrySnapshot} = require('../../services/selfEvolution/effectiveRuntimeRegistryContext') as typeof import('../../services/selfEvolution/effectiveRuntimeRegistryContext');
    const skill: import('../../services/skillEngine/types').SkillDefinition = {name: 'quote_projection_skill', version: '1', type: 'composite',
      meta: {display_name: 'Quote fixture', description: 'Actual producer projection'}, process_scope: {role: 'global_context'},
      steps: Array.from({length: 13}, (_, index) => ({id: `step_${index}`, type: 'atomic' as const, sql: `SELECT ${index} AS value FROM quote_step_${index}`,
        process_scope: {role: 'global_context' as const}, display: {layer: 'overview' as const, level: 'key' as const,
          format: 'table' as const, columns: [{name: 'value', type: 'number' as const}]}}))};
    const snapshot: import('../../services/selfEvolution/effectiveRuntimeRegistryContext').EffectiveRuntimeRegistrySnapshot = {
      scope: {tenantId: 'quote-tenant', workspaceId: 'quote-workspace'}, baseSkillRegistryFingerprint: 'quote-skills',
      baseStrategyRegistryFingerprint: 'quote-strategies', overlayGeneration: 'quote-test',
      skillRegistry: {registryFingerprint: 'quote-skills', overlayGeneration: 'quote-test', isInitialized: () => true,
        getSkill: id => id === skill.name ? skill : undefined, getAllSkills: () => [skill], getFragmentCache: () => new Map(),
        // This test-authored Skill owns its labels, as an external pack does.
        getSkillOrigin: id => id === skill.name ? {origin: 'external_pack'} : undefined,
        getAppliedOverlayIds: () => [], getVendorOverride: () => undefined,
        getVendorOverridesForSkill: () => [], hasVendorOverrides: () => false, getVendorOverrideLoadIssues: () => [], findMatchingSkill: () => undefined},
      strategyRegistry: {registryFingerprint: 'quote-strategies', overlayGeneration: 'quote-test', getStrategy: () => undefined, getAllStrategies: () => []},
      skillNotes: {registryFingerprint: 'quote-notes', getSkillNotes: () => [], getSkillIds: () => []}};
    await withEffectiveRuntimeRegistrySnapshot(snapshot, async () => {
      const h = producer({lightweight});
      // The real executor and core use this exact pinned registry; no fabricated displayResults.
      const executor = new SkillExecutor(h.service); executor.registerSkill(skill);
      const actual = producer({lightweight, executor, userQuery: forbidRows ? 'Do not read raw rows.' : undefined});
      const {payload} = await actual.call('invoke_skill', {skillId: skill.name, params: {}});
      expect(payload.success).toBe(true);
      expect(Array.isArray(payload.artifacts)).toBe(true);
      if (!Array.isArray(payload.artifacts)) throw new Error('Expected actual artifacts');
      const artifacts = payload.artifacts.map(object);
      expect(artifacts).toHaveLength(skill.steps!.length);
      const shown = artifacts.filter(item => item.preview !== undefined);
      if (forbidRows) expect(shown).toEqual([]);
      else expect(shown.length).toBeGreaterThan(0);
      if (lightweight) expect(shown.length).toBeLessThan(artifacts.length);
      const views = viewList(payload);
      expect(views.map(view => view.artifactId)).toEqual(shown.map(item => item.id));
      for (const view of views) expect(view).toMatchObject({rows: [0], columns: ['value']});
      for (const omitted of artifacts.filter(item => item.previewOmitted)) expect(views.some(view => view.artifactId === omitted.id)).toBe(false);
    });
  });
});

// A visible producer page is not a model-authored S1 document.
describe('quote projection keeps the existing producer page limit', () => {
  it('prepares a real full 500 by 40 page without borrowing the declaration node cap', async () => {
    const file = require('node:path').resolve(__dirname, '../../services/evidence/evidenceQuoteContext.ts') as string;
    expect(require('node:fs').existsSync(file)).toBe(true);
    const api = jest.requireActual<typeof import('../../services/evidence/evidenceQuoteContext')>(file);
    expect(typeof api.createEvidenceQuoteContext).toBe('function');
    const {captureEvidenceTable} = require('../../services/evidence/evidenceCapture') as typeof import('../../services/evidence/evidenceCapture');
    const {buildTraceProcessorQueryProvenance} = require('../../services/traceProcessorConnectionModel') as typeof import('../../services/traceProcessorConnectionModel');
    const columns = Array.from({length: 40}, (_, index) => `field_${index}`);
    const rows = Array.from({length: ArtifactStore.MAX_FULL_ROWS + 7}, (_, index) => columns.map((_, column) => index * 40 + column));
    const data = {columns, rows}, store = new ArtifactStore();
    const artifactId = store.store({skillId: 'large-visible-page', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'large-page-trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(artifactId, captureEvidenceTable(data),
      {evidenceRefId: 'large-page-evidence', originRunId: 'large-page-run'})).toBe(true);
    const quoteContext = api.createEvidenceQuoteContext({store, scope: {runId: 'large-page-run',
      allowedTraces: [{traceId: 'large-page-trace', traceSide: 'current'}]}, assertCurrent() {},
      productSignal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000});
    const query = jest.fn(async (): Promise<QueryResult> => ({columns: [], rows: [], durationMs: 0}));
    const service = {query} as unknown as TraceProcessorService;
    const server = createClaudeMcpServer({traceId: 'large-page-trace', runId: 'large-page-run', artifactStore: store,
      traceProcessorService: service, skillExecutor: new SkillExecutor(service), quoteContext});
    try {
      const tool = server.toolDefinitions.find(item => item.name === 'fetch_artifact');
      if (!tool) throw new Error('Expected actual fetch_artifact');
      const result = await tool.shared.handler({artifactId, detail: 'full'}, {toolCallId: 'large-fetch'});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({
        data: {columns, rows: rows.slice(0, ArtifactStore.MAX_FULL_ROWS)}, truncated: true,
        quoteViews: [expect.objectContaining({artifactId, rows: Array.from({length: ArtifactStore.MAX_FULL_ROWS}, (_, index) => index), columns,
          page: {hasMore: 'yes', coverage: 'visible_page_only'}})]}));
      expect(query).not.toHaveBeenCalled();
    } finally {quoteContext.dispose(); store.clear();}
  });
});
