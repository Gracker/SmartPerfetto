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
import {isIssuedEvidenceReadResolution, matchesEvidenceReadSessionBinding, type EvidenceReadSession,
  type EvidenceReadSessionOptions, type EvidenceReadView} from '../../services/evidence/evidenceReadView';
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
    allowNewEvidence: false, lightweight: true, conversationTraceAttached: true,
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
      isEvidenceReadResolutionRetained: () => run.store.isEvidenceReadResolutionRetained(undefined),
      areEvidenceReadResolutionsRetained: () => run.store.areEvidenceReadResolutionsRetained([]),
      createEvidenceReadSession: () => run.store.createEvidenceReadSession({...readOptions, currentRunId: 'first',
        sessionId: run.sessionId, attemptId: 'a2-exhaustive', productSignal: run.controller.signal,
        deadlineAtMs: Date.now() + 60_000, assertCurrent() {}}),
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
      allowNewEvidence, lightweight: true, conversationTraceAttached: true,
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

describe('A1 run facade retention guard', () => {
  it('forwards the actual issued object without cloning and allows retained earlier-run facts', async () => {
    const context = contextFor(), first = bind(context, 'a1-first'), saved = capture(first.store);
    const [original] = await read(first.store.createEvidenceReadView(readOptions), saved.id);
    expect(original.status).toBe('resolved'); expect(isIssuedEvidenceReadResolution(original)).toBe(true);
    const consult = jest.spyOn(ArtifactStore.prototype, 'isEvidenceReadResolutionRetained');
    expect(first.store.isEvidenceReadResolutionRetained(original)).toBe(true);
    expect(consult.mock.calls[0][0]).toBe(original);
    first.binding.release();
    const second = bind(context, 'a1-second');
    consult.mockClear();
    expect(second.store.isEvidenceReadResolutionRetained(original)).toBe(true);
    expect(consult.mock.calls[0][0]).toBe(original);
    if (original.status !== 'resolved') throw new Error('Expected original issued read');
    expect(original.record.originRunId).toBe('a1-first');
    expect(second.store.isEvidenceReadResolutionRetained({...original})).toBe(false);
    // Retention does not apply the later compositor's separate current-run rule.
    expect(isIssuedEvidenceReadResolution(original)).toBe(true);
  });

  it.each(['release', 'cancel', 'supersede', 'dispose'] as const)('rejects %s before consulting the backing store', async stop => {
    const context = contextFor(), run = bind(context, `a1-${stop}`), saved = capture(run.store);
    const [original] = await read(run.store.createEvidenceReadView(readOptions), saved.id);
    const consult = jest.spyOn(ArtifactStore.prototype, 'isEvidenceReadResolutionRetained');
    expect(run.store.isEvidenceReadResolutionRetained(original)).toBe(true); consult.mockClear();
    if (stop === 'release') run.binding.release();
    if (stop === 'cancel') run.controller.abort(new Error('a1_product_cancelled'));
    if (stop === 'supersede') bind(context, 'a1-successor');
    if (stop === 'dispose') context.dispose();
    expect(() => run.store.isEvidenceReadResolutionRetained(original)).toThrow(stop === 'cancel'
      ? 'a1_product_cancelled' : 'Runtime evidence run is no longer active');
    expect(consult).not.toHaveBeenCalled();
    expect(isIssuedEvidenceReadResolution(original)).toBe(true);
  });

  it('propagates an actual run authorization guard failure instead of returning false absence', async () => {
    const context = contextFor(), controller = new AbortController(); let authorized = true;
    const binding = context.bind(baseOptions, {runtimeSessionId: 'conversation:a1-authorized', runId: 'a1-authorized',
      signal: controller.signal, assertAuthorized() {if (!authorized) throw new Error('a1_authorization_revoked');}});
    const store = resolveRuntimeEvidenceStore(binding.options, {sessionId: 'conversation:a1-authorized', traceId: 'trace'},
      () => {throw new Error('Unexpected store fallback');});
    const saved = capture(store), [original] = await read(store.createEvidenceReadView(readOptions), saved.id);
    const consult = jest.spyOn(ArtifactStore.prototype, 'isEvidenceReadResolutionRetained');
    expect(store.isEvidenceReadResolutionRetained(original)).toBe(true); consult.mockClear(); authorized = false;
    expect(() => store.isEvidenceReadResolutionRetained(original)).toThrow('a1_authorization_revoked');
    expect(consult).not.toHaveBeenCalled(); expect(isIssuedEvidenceReadResolution(original)).toBe(true);
  });

  it('checks real source consent revocation even when the captured authorization fingerprint is unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-a1-retention-scope-'));
    roots.push(root);
    const registry = new CodebaseRegistry(path.join(root, 'registry.json'));
    const registered = registry.register({kind: 'app_source', displayName: 'A1 evidence fixture', rootPath: root,
      rootAuthorization: 'native_picker', sendToProvider: true, ...baseOptions});
    jest.spyOn(codebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
    const options: AnalysisOptions = {...baseOptions, codeAwareMode: 'provider_send', codebaseIds: [registered.codebaseId]};
    options.analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(options, options);
    const context = contextFor(options), run = bind(context, 'a1-private', options), saved = capture(run.store);
    const [original] = await read(run.store.createEvidenceReadView(readOptions), saved.id);
    const consult = jest.spyOn(ArtifactStore.prototype, 'isEvidenceReadResolutionRetained');
    expect(run.store.isEvidenceReadResolutionRetained(original)).toBe(true); consult.mockClear();
    registry.setProviderConsent(registered.codebaseId, options, false, 'a1-retention-test');
    expect(() => run.store.isEvidenceReadResolutionRetained(original)).toThrow();
    expect(consult).not.toHaveBeenCalled();
    registry.setProviderConsent(registered.codebaseId, options, true, 'a1-retention-test');
    expect(() => run.store.isEvidenceReadResolutionRetained(original)).toThrow();
    expect(consult).not.toHaveBeenCalled();
  });
});

describe('A2 run-owned cumulative read session facade', () => {
  function options(run: ReturnType<typeof bind>, runId: string,
    overrides: Partial<EvidenceReadSessionOptions> = {}): EvidenceReadSessionOptions {
    return {...readOptions, currentRunId: runId, sessionId: run.sessionId, attemptId: 'captured-internal-attempt',
      productSignal: run.controller.signal, deadlineAtMs: Date.now() + 60_000, assertCurrent() {}, ...overrides};
  }

  it.each(['current', 'reference', 'both'] as const)('admits the actual %s trace-pair subset and binds the physical run identity', async subset => {
    const runId = `a2-subset-${subset}`, run = bind(contextFor(), runId), current = capture(run.store);
    const data = {columns: ['metric'], rows: [[9]]};
    const referenceId = run.store.store({skillId: 'fixture-reference', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'reference-trace', traceSide: 'reference'})});
    expect(run.store.registerEvidenceCapture(referenceId, captureEvidenceTable(data), {evidenceRefId: 'a2-reference'})).toBe(true);
    const allowedTraces: EvidenceReadSessionOptions['allowedTraces'] = subset === 'current' ? readOptions.allowedTraces
      : subset === 'reference' ? [{traceId: 'reference-trace', traceSide: 'reference'}]
        : [...readOptions.allowedTraces, {traceId: 'reference-trace', traceSide: 'reference'}];
    const factory = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadSession');
    const capturedOptions = options(run, runId, {allowedTraces});
    const session = run.store.createEvidenceReadSession(capturedOptions);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toMatchObject({currentRunId: runId, sessionId: run.sessionId, allowedTraces});
    expect(matchesEvidenceReadSessionBinding(session, {runId, sessionId: run.sessionId,
      attemptId: capturedOptions.attemptId, productSignal: run.controller.signal})).toBe(true);
    expect(run.sessionId).not.toBe('conversation');
    const reads = await session.resolveReferences([
      {key: 'current', reference: {artifactId: current.id, rowIndex: 5001, column: 'metric'}, requiredColumns: ['metric']},
      {key: 'reference', reference: {artifactId: referenceId, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']},
    ]);
    expect(reads.map(result => result.status)).toEqual(subset === 'both' ? ['resolved', 'resolved']
      : subset === 'current' ? ['resolved', 'denied'] : ['denied', 'resolved']);
    // The facade captures this string; only the later actual issuer can authenticate an attempt.
    expect(factory.mock.calls[0][0].attemptId).toBe('captured-internal-attempt');
    session.dispose();
  });

  it.each([
    ['foreign-current', [{traceId: 'foreign', traceSide: 'current'}]],
    ['foreign-reference', [{traceId: 'foreign', traceSide: 'reference'}]],
    ['side-swap', [{traceId: 'reference-trace', traceSide: 'current'}]],
    ['unknown-side', [{traceId: 'reference-trace', traceSide: 'other'}]],
    ['empty-trace', [{traceId: '', traceSide: 'current'}]],
    ['non-string-trace', [{traceId: 9, traceSide: 'current'}]],
  ])('rejects %s before creating any backing session', (label, allowedTraces) => {
    const runId = `a2-invalid-${label}`, run = bind(contextFor(), runId);
    const factory = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadSession');
    expect(() => Reflect.apply(run.store.createEvidenceReadSession, run.store, [{...options(run, runId), allowedTraces}]))
      .toThrow('runtime_evidence_read_scope_mismatch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects an unbound reference trace instead of extending the product scope', () => {
    const noReference = {...baseOptions, referenceTraceId: undefined};
    const runId = 'a2-no-reference', run = bind(contextFor(noReference), runId, noReference);
    const factory = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadSession');
    expect(() => run.store.createEvidenceReadSession(options(run, runId,
      {allowedTraces: [{traceId: 'reference-trace', traceSide: 'reference'}]})))
      .toThrow('runtime_evidence_read_scope_mismatch');
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['run', 'physical-session'] as const)('rejects a mismatched %s before substituting real owner values', field => {
    const runId = `a2-identity-${field}`, run = bind(contextFor(), runId);
    const factory = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadSession');
    const captured = options(run, runId, field === 'run' ? {currentRunId: 'different-run'} : {sessionId: 'conversation'});
    expect(() => run.store.createEvidenceReadSession(captured)).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['facade-batch', 'session-commit'] as const)('checks both captures after the one actual last authorization guard in %s', async entry => {
    const context = contextFor(), controller = new AbortController(), runId = `a2-last-guard-${entry}`;
    const sessionId = `conversation:${runId}`;
    let backing: ArtifactStore | undefined, first: ReturnType<typeof capture> | undefined, replaceFirst = false;
    const auth = jest.fn(() => {
      if (replaceFirst) {
        replaceFirst = false;
        if (!backing || !first) throw new Error('Expected actual backing store from the forwarded factory');
        expect(backing.registerEvidenceCapture(first.id, first.witness, {evidenceRefId: `captured:${first.id}`})).toBe(true);
      }
    });
    const binding = context.bind(baseOptions, {runtimeSessionId: sessionId, runId, signal: controller.signal, assertAuthorized: auth});
    const store = resolveRuntimeEvidenceStore(binding.options, {sessionId, traceId: 'trace'},
      () => {throw new Error('Unexpected fallback');});
    first = capture(store, 7); const second = capture(store, 8);
    const originalFactory = ArtifactStore.prototype.createEvidenceReadSession;
    jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadSession').mockImplementation(function (this: ArtifactStore, input) {
      backing = this;
      return originalFactory.call(this, input);
    });
    const ownerGuard = jest.fn(() => {});
    const session = store.createEvidenceReadSession({...readOptions, currentRunId: runId, sessionId,
      attemptId: 'last-guard-attempt', productSignal: controller.signal, deadlineAtMs: Date.now() + 60_000,
      assertCurrent: ownerGuard});
    const resolutions = await session.resolveReferences([first, second].map(saved => ({key: saved.id,
      reference: {artifactId: saved.id, rowIndex: 5001, column: 'metric'}, requiredColumns: ['metric']})));
    expect(resolutions).toMatchObject([{status: 'resolved', row: {metric: 7}}, {status: 'resolved', row: {metric: 8}}]);
    expect(store.isEvidenceReadResolutionRetained(resolutions[0])).toBe(true);
    const batch = jest.spyOn(ArtifactStore.prototype, 'areEvidenceReadResolutionsRetained');
    const single = jest.spyOn(ArtifactStore.prototype, 'isEvidenceReadResolutionRetained');
    auth.mockClear(); ownerGuard.mockClear(); replaceFirst = true;
    const retained = entry === 'facade-batch' ? store.areEvidenceReadResolutionsRetained(resolutions)
      : session.checkRetainedBatchForCommit(resolutions);
    expect(retained).toBe(false);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(ownerGuard).toHaveBeenCalledTimes(entry === 'session-commit' ? 1 : 0);
    expect(batch).toHaveBeenCalledTimes(1); expect(batch.mock.calls[0][0]).toBe(resolutions);
    expect(single).not.toHaveBeenCalled();
    expect(backing!.isEvidenceReadResolutionRetained(resolutions[0])).toBe(false);
    expect(backing!.isEvidenceReadResolutionRetained(resolutions[1])).toBe(true);
    expect(resolutions.every(isIssuedEvidenceReadResolution)).toBe(true);
    session.dispose();
  });

  it('occupies the session before a real facade authorization callback can reenter it', async () => {
    const context = contextFor(), controller = new AbortController(), runId = 'a2-facade-busy';
    const sessionId = `conversation:${runId}`;
    let session: EvidenceReadSession | undefined, recurse = false, nested: Promise<unknown> | undefined;
    const authorization = jest.fn(() => {
      if (!recurse || !session) return;
      recurse = false;
      nested = session.resolveReferences([]).then(() => 'unexpected_success', error => error.message);
      expect(() => session!.checkRetainedBatchForCommit([])).toThrow('evidence_read_session_busy');
    });
    const binding = context.bind(baseOptions, {runtimeSessionId: sessionId, runId, signal: controller.signal,
      assertAuthorized: authorization});
    const store = resolveRuntimeEvidenceStore(binding.options, {sessionId, traceId: 'trace'},
      () => {throw new Error('Unexpected fallback');});
    const saved = capture(store);
    session = store.createEvidenceReadSession({...readOptions, currentRunId: runId, sessionId,
      attemptId: 'a2-attempt', productSignal: controller.signal, deadlineAtMs: Date.now() + 60_000, assertCurrent() {}});
    authorization.mockClear(); recurse = true;
    expect(await read(session, saved.id)).toMatchObject([{status: 'resolved'}]);
    expect(await nested).toBe('evidence_read_session_busy');
    expect(authorization).toHaveBeenCalledTimes(2); // Outer pre/post only; neither nested attempt invokes the guard.
    expect(session.budgetSnapshot()).toMatchObject({state: 'open', batches: 1, submittedReferences: 1});
    authorization.mockClear(); recurse = true;
    const [resolution] = await read(session, saved.id);
    await nested;
    authorization.mockClear(); recurse = true;
    expect(session.checkRetainedBatchForCommit([resolution])).toBe(true);
    expect(await nested).toBe('evidence_read_session_busy');
    expect(authorization).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it.each(['release', 'product-cancel', 'supersede', 'context-dispose', 'session-dispose'] as const)
    ('rejects %s at both session entrypoints before consulting the pure batch', async action => {
      const context = contextFor(), runId = `a2-lifecycle-${action}`, run = bind(context, runId), saved = capture(run.store);
      const session = run.store.createEvidenceReadSession(options(run, runId));
      const [issued] = await read(session, saved.id);
      const batch = jest.spyOn(ArtifactStore.prototype, 'areEvidenceReadResolutionsRetained');
      if (action === 'release') run.binding.release();
      if (action === 'product-cancel') run.controller.abort(new Error('a2-product-stopped'));
      if (action === 'supersede') bind(context, 'a2-current-successor');
      if (action === 'context-dispose') context.dispose();
      if (action === 'session-dispose') session.dispose();
      await expect(read(session, saved.id)).rejects.toThrow();
      expect(() => session.checkRetainedBatchForCommit([issued])).toThrow();
      expect(batch).not.toHaveBeenCalled();
      expect(isIssuedEvidenceReadResolution(issued)).toBe(true);
      session.dispose();
    });

  it('keeps actual source consent revocation authoritative for cumulative reads and the final batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-a2-session-consent-')); roots.push(root);
    const registry = new CodebaseRegistry(path.join(root, 'registry.json'));
    const registered = registry.register({kind: 'app_source', displayName: 'A2 fixture', rootPath: root,
      rootAuthorization: 'native_picker', sendToProvider: true, ...baseOptions});
    jest.spyOn(codebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
    const privateOptions: AnalysisOptions = {...baseOptions, codeAwareMode: 'provider_send', codebaseIds: [registered.codebaseId]};
    privateOptions.analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(privateOptions, privateOptions);
    const runId = 'a2-private-session', run = bind(contextFor(privateOptions), runId, privateOptions), saved = capture(run.store);
    const session = run.store.createEvidenceReadSession(options(run, runId));
    const [issued] = await read(session, saved.id);
    const batch = jest.spyOn(ArtifactStore.prototype, 'areEvidenceReadResolutionsRetained');
    registry.setProviderConsent(registered.codebaseId, privateOptions, false, 'a2-session-test');
    await expect(read(session, saved.id)).rejects.toThrow();
    expect(() => session.checkRetainedBatchForCommit([issued])).toThrow();
    expect(batch).not.toHaveBeenCalled();
    registry.setProviderConsent(registered.codebaseId, privateOptions, true, 'a2-session-test');
    await expect(read(session, saved.id)).rejects.toThrow();
    expect(() => session.checkRetainedBatchForCommit([issued])).toThrow();
    expect(batch).not.toHaveBeenCalled();
    session.dispose();
  });

  it.each(['release', 'supersede', 'context-dispose'] as const)
    ('rejects %s performed synchronously by the last caller guard before the pure batch', async action => {
      const context = contextFor(), runId = `a2-last-caller-${action}`, run = bind(context, runId), saved = capture(run.store);
      let commitActionEnabled = false, actionRan = false;
      const session = run.store.createEvidenceReadSession(options(run, runId, {assertCurrent() {
        if (!commitActionEnabled) return;
        commitActionEnabled = false;
        actionRan = true;
        if (action === 'release') run.binding.release();
        if (action === 'supersede') bind(context, 'a2-last-caller-successor');
        if (action === 'context-dispose') context.dispose();
      }}));
      const [issued] = await read(session, saved.id);
      expect(issued).toMatchObject({status: 'resolved', row: {metric: 7}});
      expect(isIssuedEvidenceReadResolution(issued)).toBe(true);
      expect(run.controller.signal.aborted).toBe(false);
      const batch = jest.spyOn(ArtifactStore.prototype, 'areEvidenceReadResolutionsRetained');
      commitActionEnabled = true;
      let failure: unknown;
      try {session.checkRetainedBatchForCommit([issued]);} catch (error) {failure = error;}
      expect(actionRan).toBe(true);
      expect(run.controller.signal.aborted).toBe(false);
      expect(failure).toBeInstanceOf(DOMException);
      expect(failure).toMatchObject({name: 'AbortError', message: 'Runtime evidence run is no longer active'});
      expect(batch).not.toHaveBeenCalled();
      expect(isIssuedEvidenceReadResolution(issued)).toBe(true);
      session.dispose();
    });

  it('rejects actual provider consent revoked synchronously by the last caller guard before the pure batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-a2-last-caller-consent-')); roots.push(root);
    const registry = new CodebaseRegistry(path.join(root, 'registry.json'));
    const registered = registry.register({kind: 'app_source', displayName: 'A2 last caller fixture', rootPath: root,
      rootAuthorization: 'native_picker', sendToProvider: true, ...baseOptions});
    jest.spyOn(codebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue(registry);
    const privateOptions: AnalysisOptions = {...baseOptions, codeAwareMode: 'provider_send', codebaseIds: [registered.codebaseId]};
    privateOptions.analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(privateOptions, privateOptions);
    const runId = 'a2-last-caller-consent', run = bind(contextFor(privateOptions), runId, privateOptions), saved = capture(run.store);
    let revokeOnCommit = false, revoked = false;
    const session = run.store.createEvidenceReadSession(options(run, runId, {assertCurrent() {
      if (!revokeOnCommit) return;
      revokeOnCommit = false;
      registry.setProviderConsent(registered.codebaseId, privateOptions, false, 'a2-last-caller-test');
      revoked = true;
    }}));
    const [issued] = await read(session, saved.id);
    expect(issued).toMatchObject({status: 'resolved', row: {metric: 7}});
    expect(isIssuedEvidenceReadResolution(issued)).toBe(true);
    expect(run.controller.signal.aborted).toBe(false);
    const batch = jest.spyOn(ArtifactStore.prototype, 'areEvidenceReadResolutionsRetained');
    revokeOnCommit = true;
    let failure: unknown;
    try {session.checkRetainedBatchForCommit([issued]);} catch (error) {failure = error;}
    expect(revoked).toBe(true);
    expect(run.controller.signal.aborted).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(batch).not.toHaveBeenCalled();
    expect(isIssuedEvidenceReadResolution(issued)).toBe(true);
    session.dispose();
  });
});
