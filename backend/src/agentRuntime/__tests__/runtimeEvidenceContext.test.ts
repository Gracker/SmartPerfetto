// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import * as codebaseServices from '../../services/codebase/defaultCodebaseServices';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {isIssuedEvidenceReadResolution, type EvidenceReadView} from '../../services/evidence/evidenceReadView';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';
import {SkillExecutor} from '../../services/skillEngine/skillExecutor';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {createRuntimeEvidenceContext, resolveRuntimeEvidenceStore,
  type RuntimeEvidenceContext, type RuntimeEvidenceScopeInput} from '../runtimeEvidenceContext';
import {createAnalysisHistoryReader, toAnalysisHistoryTurn} from '../analysisHistory';

const contexts: RuntimeEvidenceContext[] = [];
const roots: string[] = [];
const baseOptions: AnalysisOptions = {tenantId: 'evidence-tenant', workspaceId: 'evidence-workspace',
  userId: 'evidence-user', referenceTraceId: 'reference-trace'};
const scope = (options = baseOptions): RuntimeEvidenceScopeInput => ({logicalSessionId: 'conversation', traceId: 'trace', options});
const readOptions = {ownerKey: 'product-finalization', allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]};

it('exposes bound historical text in existing_only mode without reacquiring or granting proof', async () => {
  let active = true;
  const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
  const entry = toAnalysisHistoryTurn({id: 'history-run', turnIndex: 0, traceId: 'trace', timestamp: 1,
    query: 'why', result: {message: '有限结论', partial: true, completion: {status: 'incomplete', reason: 'turn_limit'},
      conclusionContract: {uncertainties: ['缺少 GPU'], nextSteps: ['检查 fence']}}});
  const mcp = createClaudeMcpServer({traceId: 'trace', sessionId: 'session', userQuery: 'Continue',
    traceProcessorService: {query} as unknown as TraceProcessorService, skillExecutor: new SkillExecutor({query}),
    allowNewEvidence: false, lightweight: true, conversationTraceAttached: true, androidInternalsPackStore: null,
    analysisHistoryReader: createAnalysisHistoryReader({getTurns: () => [entry], assertActive: () => {if (!active) throw new Error('revoked');}})});
  const tool = mcp.toolDefinitions.find(candidate => candidate.name === 'read_session_history')!;
  expect(tool).toBeDefined();
  expect(tool.evidenceEffect).toBe('read_existing');
  const response = await tool.shared.handler({turnId: entry.id}, {});
  expect(response.structuredContent).toMatchObject({success: true, provenance: 'historical_context', partial: true});
  expect(JSON.parse(String(response.structuredContent?.text))).toEqual(entry);
  expect(query).not.toHaveBeenCalled();
  active = false;
  expect((await tool.shared.handler({turnId: entry.id}, {})).structuredContent)
    .toMatchObject({success: false, unsupportedReason: 'analysis_history_unavailable'});
});

function contextFor(options = baseOptions) {
  const context = createRuntimeEvidenceContext(scope(options));
  contexts.push(context);
  return context;
}

function bind(context: RuntimeEvidenceContext, runId: string, options = baseOptions) {
  const controller = new AbortController();
  const sessionId = `conversation:${runId}`;
  const binding = context.bind(options, {runtimeSessionId: sessionId, runId, signal: controller.signal,
    assertAuthorized() {}});
  const store = resolveRuntimeEvidenceStore({...binding.options}, {sessionId, traceId: 'trace'}, () => {
    throw new Error('A live issued binding must not use the fallback');
  });
  return {binding, controller, sessionId, store};
}

function capture(store: ArtifactStore, value = 7) {
  const data = {columns: ['id', 'metric'], rows: Array.from({length: 5002}, (_, row) => [row, value])};
  const witness = captureEvidenceTable(data);
  const id = store.store({skillId: 'execute_sql', data,
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
  expect(store.registerEvidenceCapture(id, witness, {evidenceRefId: `captured:${id}`})).toBe(true);
  return {id, data, witness};
}

const read = (view: EvidenceReadView, id: string) => view.resolveReferences([
  {key: id, reference: {artifactId: id, rowIndex: 5001, column: 'metric'}, requiredColumns: ['metric']},
]);

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe('product-owned live evidence continuity', () => {
  it('reads the original capture across unique physical runs and preserves issued resolution identity', async () => {
    const context = contextFor();
    const first = bind(context, 'first');
    const {id} = capture(first.store);
    first.binding.release();
    const second = bind(context, 'second');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.store).not.toBe(first.store);
    expect(second.store.fetch(id, 'rows', 5001, 1)).toMatchObject({rows: [{rowIndex: 5001, values: [5001, 7]}], totalRows: 5002});
    const [resolved] = await read(second.store.createEvidenceReadView(readOptions), id);
    expect(resolved).toMatchObject({status: 'resolved', originalRowIndex: 5001, row: {metric: 7}});
    expect(isIssuedEvidenceReadResolution(resolved)).toBe(true);
  });

  it('keeps the admitted capture set fixed while the current run captures more evidence', async () => {
    const run = bind(contextFor(), 'first');
    const first = capture(run.store);
    const view = run.store.createEvidenceReadView(readOptions);
    const later = capture(run.store, 8);
    expect((await read(view, first.id))[0].status).toBe('resolved');
    expect((await read(view, later.id))[0].status).toBe('missing');
  });

  it('describes retained issued captures using bounded metadata without row data or proof authority', async () => {
    const run = bind(contextFor(), 'first');
    const captured = capture(run.store);
    run.store.store({skillId: 'display-only', title: 'Not an execution capture',
      data: {columns: ['secret'], rows: [['PRIVATE_ROW_CANARY']]}});
    const catalog = await run.binding.describeArtifacts();
    expect(catalog).toEqual({artifacts: [{artifactId: captured.id, skillId: 'execute_sql', title: 'execute_sql',
      traceId: 'trace', traceSide: 'current', rowCount: 5002, columns: ['id', 'metric'], columnCount: 2}],
      omittedArtifactCount: 1});
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_ROW_CANARY');
    expect(catalog.artifacts[0]).not.toHaveProperty('rows');
    expect(catalog.artifacts[0]).not.toHaveProperty('proof');
    expect(Object.isFrozen(catalog.artifacts[0].columns)).toBe(true);
    run.binding.release();
    await expect(run.binding.describeArtifacts()).rejects.toThrow();
  });

  it('does not describe captures outside the exact trace scope or after disposal', async () => {
    const context = contextFor();
    const run = bind(context, 'first');
    const data = {columns: ['metric'], rows: [[7]]};
    const id = run.store.store({skillId: 'fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'other-trace', traceSide: 'current'})});
    run.store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: 'outside'});
    expect(await run.binding.describeArtifacts()).toEqual({artifacts: [], omittedArtifactCount: 1});
    context.dispose();
    await expect(run.binding.describeArtifacts()).rejects.toThrow();
  });

  it('does not let late callbacks, cancellation or release from an old run affect its successor', async () => {
    const context = contextFor();
    const first = bind(context, 'first');
    const {id} = capture(first.store);
    const oldView = first.store.createEvidenceReadView(readOptions);
    const lateStore = first.store.store;
    const second = bind(context, 'second');
    first.controller.abort();
    first.binding.release();
    expect(() => lateStore({skillId: 'late', data: {columns: [], rows: []}})).toThrow();
    expect(() => first.store.clear()).toThrow();
    await expect(read(oldView, id)).rejects.toThrow();
    expect(second.store.size).toBe(1);
    expect((await read(second.store.createEvidenceReadView(readOptions), id))[0].status).toBe('resolved');
  });

  it('guards every public store entrypoint after releasing a run', () => {
    const run = bind(contextFor(), 'first');
    const {id, witness} = capture(run.store);
    const calls: Record<keyof ArtifactStore, () => unknown> = {
      store: () => run.store.store({skillId: 'late', data: {columns: [], rows: []}}),
      registerEvidenceCapture: () => run.store.registerEvidenceCapture(id, witness, {evidenceRefId: 'late'}),
      registerStandaloneEvidenceCapture: () => run.store.registerStandaloneEvidenceCapture(witness, {
        meta: {schemaVersion: '1.0', type: 'sql_result', source: 'sql', evidenceRefId: 'late'} as any,
        display: {title: 'late', format: 'table'} as any,
      }),
      updateQueryReview: () => run.store.updateQueryReview(id, undefined),
      observeInvestigationTool: () => run.store.observeInvestigationTool({phase: 'started',
        toolCallId: 'late', toolName: 'test', params: {}, extra: {}}),
      get: () => run.store.get(id), generateSummary: () => run.store.generateSummary(id),
      generateCompactSummary: () => run.store.generateCompactSummary(id),
      fetch: () => run.store.fetch(id, 'full'), size: () => run.store.size,
      serialize: () => run.store.serialize(), clear: () => run.store.clear(),
      createEvidenceReadView: () => run.store.createEvidenceReadView(readOptions),
    };
    run.binding.release();
    for (const call of Object.values(calls)) expect(call).toThrow();
  });

  it('detaches mutable store inputs and outputs without exposing backing maps', async () => {
    const context = contextFor();
    const first = bind(context, 'first');
    const {id, data} = capture(first.store);
    const outputs = [first.store.get(id)!.data, first.store.fetch(id, 'full').data,
      first.store.fetch(id, 'rows', 0, 1), first.store.serialize()[0].data];
    data.rows[0][1] = -1;
    outputs.forEach(output => {output.rows[0][1] = -2;});
    const summary = first.store.generateSummary(id)!;
    summary.sampleRow![1] = -3;
    const compact = first.store.generateCompactSummary(id)!;
    compact.preview!.metric = -4;
    expect(Object.isFrozen(first.store)).toBe(true);
    expect(Reflect.ownKeys(first.store)).not.toContain('artifacts');
    expect(Reflect.ownKeys(first.store)).not.toContain('executionCaptures');
    first.binding.release();
    const second = bind(context, 'second');
    expect(second.store.fetch(id, 'rows', 0, 1).rows).toEqual([{rowIndex: 0, values: [0, 7]}]);
    expect((await read(second.store.createEvidenceReadView(readOptions), id))[0]).toMatchObject({row: {metric: 7}});
  });

  it('preserves private capabilities through options spreads while JSON and fake handles have no authority', () => {
    const run = bind(contextFor(), 'first');
    const {id} = capture(run.store);
    const fallback = jest.fn(() => new ArtifactStore());
    expect(resolveRuntimeEvidenceStore({...run.binding.options}, {sessionId: run.sessionId, traceId: 'trace'}, fallback))
      .toBe(run.store);
    expect(fallback).not.toHaveBeenCalled();
    const json = JSON.stringify(run.binding.options);
    expect(json).not.toContain('captured');
    expect(resolveRuntimeEvidenceStore(JSON.parse(json), {sessionId: run.sessionId, traceId: 'trace'}, fallback).get(id))
      .toBeUndefined();
    const [symbol] = Object.getOwnPropertySymbols(run.binding.options);
    for (const fake of [{}, undefined, JSON.parse(JSON.stringify(contextFor()))]) {
      const forged = {...run.binding.options, [symbol]: fake};
      expect(() => resolveRuntimeEvidenceStore(forged, {sessionId: run.sessionId, traceId: 'trace'}, fallback)).toThrow();
    }
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each(['unchanged', 'trace', 'tenantId', 'workspaceId', 'userId', 'referenceTraceId', 'runId'] as const)(
    'rejects a cached issued facade after JSON removes the binding with %s scope', change => {
      const run = bind(contextFor(), 'first');
      const {id} = capture(run.store);
      const cache = new Map([[run.sessionId, run.store]]);
      const options: AnalysisOptions = JSON.parse(JSON.stringify(run.binding.options));
      if (change !== 'unchanged' && change !== 'trace') options[change] = 'other';
      const actual = {sessionId: run.sessionId, traceId: change === 'trace' ? 'other' : 'trace'};
      const fallback = jest.fn(() => cache.get(actual.sessionId)!);
      expect(() => resolveRuntimeEvidenceStore(options, actual, fallback)).toThrow('runtime_evidence_binding_required');
      expect(fallback).toHaveBeenCalledTimes(1);
      // The rejected retrieval must not destroy the still-authorized owner lease.
      expect(resolveRuntimeEvidenceStore({...run.binding.options},
        {sessionId: run.sessionId, traceId: 'trace'}, fallback).get(id)).toBeDefined();
    });

  it('retains the ordinary legacy store fallback when no binding was supplied', () => {
    const legacy = new ArtifactStore();
    const id = legacy.store({skillId: 'legacy', data: {columns: ['value'], rows: [[3]]}});
    expect(resolveRuntimeEvidenceStore({}, {sessionId: 'legacy', traceId: 'trace'}, () => legacy)).toBe(legacy);
    expect(legacy.get(id)?.data.rows).toEqual([[3]]);
    const fresh = new ArtifactStore();
    expect(resolveRuntimeEvidenceStore({}, {sessionId: 'fresh', traceId: 'trace'}, () => fresh)).toBe(fresh);
  });

  it.each(['tenantId', 'workspaceId', 'userId', 'referenceTraceId', 'codebaseIds', 'knowledgeSourceIds',
    'analysisContextFingerprint', 'runId'] as const)('rejects a copied binding with changed %s', key => {
    const run = bind(contextFor(), 'first');
    const changed = {...run.binding.options, [key]: key.endsWith('Ids') ? ['other'] : 'other'};
    expect(() => resolveRuntimeEvidenceStore(changed as AnalysisOptions,
      {sessionId: run.sessionId, traceId: 'trace'}, () => new ArtifactStore())).toThrow();
  });

  it('reads a source mode without selected codebases as the same authorization (effectiveAnalysisSelection)', () => {
    const run = bind(contextFor(), 'first');
    for (const codeAwareMode of ['off', 'metadata_only', 'provider_send'] as const) {
      expect(resolveRuntimeEvidenceStore({...run.binding.options, codeAwareMode},
        {sessionId: run.sessionId, traceId: 'trace'}, () => new ArtifactStore())).toBe(run.store);
    }
    // Codebase ids hidden by an explicit off authorize nothing either.
    expect(resolveRuntimeEvidenceStore({...run.binding.options, codeAwareMode: 'off', codebaseIds: ['hidden']},
      {sessionId: run.sessionId, traceId: 'trace'}, () => new ArtifactStore())).toBe(run.store);
  });

  it('rejects mismatched physical sessions, current trace and broadened finalization scopes', () => {
    const context = contextFor();
    const run = bind(context, 'first');
    for (const actual of [{sessionId: 'other', traceId: 'trace'}, {sessionId: run.sessionId, traceId: 'other'}]) {
      expect(() => resolveRuntimeEvidenceStore(run.binding.options, actual, () => new ArtifactStore())).toThrow();
    }
    expect(context.matches({...scope(), logicalSessionId: 'other'})).toBe(false);
    expect(context.matches({...scope(), traceId: 'other'})).toBe(false);
    expect(() => run.store.createEvidenceReadView({...readOptions,
      allowedTraces: [{traceId: 'other', traceSide: 'current'}]})).toThrow();
  });

  it('denies cancelled and disposed reads, and never reconstitutes capture authority from snapshots', async () => {
    const context = contextFor();
    const run = bind(context, 'first');
    const {id} = capture(run.store);
    const view = run.store.createEvidenceReadView(readOptions);
    const restored = ArtifactStore.fromSnapshot(run.store.serialize());
    expect((await read(restored.createEvidenceReadView(readOptions), id))[0].status).toBe('missing');
    run.controller.abort();
    await expect(read(view, id)).rejects.toThrow();
    const second = bind(context, 'second');
    const secondView = second.store.createEvidenceReadView(readOptions);
    context.dispose();
    await expect(read(secondView, id)).rejects.toThrow();
    expect(context.matches(scope())).toBe(false);
    expect(() => bind(context, 'third')).toThrow();
  });

  it('checks current source consent even when copied options retain the same authorization fingerprint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-evidence-scope-'));
    roots.push(root);
    const registry = new CodebaseRegistry(path.join(root, 'registry.json'));
    const registered = registry.register({kind: 'app_source', displayName: 'Evidence fixture', rootPath: root,
      rootAuthorization: 'native_picker', sendToProvider: true, ...baseOptions});
    jest.spyOn(codebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
    const options: AnalysisOptions = {...baseOptions, codeAwareMode: 'provider_send', codebaseIds: [registered.codebaseId]};
    options.analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(options, options);
    const context = contextFor(options);
    const run = bind(context, 'first', options);
    const {id} = capture(run.store);
    const view = run.store.createEvidenceReadView(readOptions);
    registry.setProviderConsent(registered.codebaseId, options, false, 'evidence-test');
    expect(context.matches(scope(options))).toBe(false);
    await expect(read(view, id)).rejects.toThrow();
    registry.setProviderConsent(registered.codebaseId, options, true, 'evidence-test');
    expect(context.matches(scope(options))).toBe(false);
    expect(() => run.store.get(id)).toThrow();
  });

  it('serves retained rows through real existing_only MCP without a second acquisition', async () => {
    const context = contextFor();
    const query = jest.fn(async () => ({columns: ['id', 'metric'],
      rows: Array.from({length: 301}, (_, index) => [index, 7]), durationMs: 1}));
    const makeMcp = (run: ReturnType<typeof bind>, allowNewEvidence: boolean) => createClaudeMcpServer({
      traceId: 'trace', sessionId: run.sessionId, userQuery: 'Read the metric', artifactStore: run.store,
      traceProcessorService: {query} as unknown as TraceProcessorService, skillExecutor: new SkillExecutor({query}),
      analysisNotes: [], hypotheses: [], uncertaintyFlags: [], watchdogWarning: {current: null},
      allowNewEvidence, lightweight: true, conversationTraceAttached: true, androidInternalsPackStore: null,
    });
    const invoke = async (mcp: ReturnType<typeof makeMcp>, name: string, args: Record<string, unknown>) => {
      const tool = mcp.toolDefinitions.find(candidate => candidate.name === name);
      if (!tool) throw new Error(`Missing real MCP tool: ${name}`);
      return tool.shared.handler(args, {});
    };
    const first = bind(context, 'first');
    await invoke(makeMcp(first, true), 'execute_sql', {sql: 'SELECT id, metric FROM measured'});
    const artifact = first.store.serialize().find(entry => entry.skillId === 'execute_sql');
    expect(artifact).toBeDefined();
    expect(query).toHaveBeenCalled();
    first.binding.release();
    query.mockClear();
    const second = bind(context, 'second');
    const mcp = makeMcp(second, false);
    const fetched = await invoke(mcp, 'fetch_artifact', {artifactId: artifact!.id, detail: 'rows', offset: 300, limit: 1});
    expect(fetched).toMatchObject({structuredContent: {success: true, rowShape: 'indexed_rows@1', rows: [{rowIndex: 300, values: [300, 7]}], totalRows: 301}});
    expect(query).not.toHaveBeenCalled();
    const [resolved] = await second.store.createEvidenceReadView(readOptions).resolveReferences([
      {key: 'prior', reference: {artifactId: artifact!.id, rowIndex: 300, column: 'metric'}, requiredColumns: ['metric']},
    ]);
    expect(resolved).toMatchObject({status: 'resolved', row: {metric: 7}});
    expect(isIssuedEvidenceReadResolution(resolved)).toBe(true);
  });
});
