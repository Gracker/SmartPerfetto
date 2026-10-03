// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import {resolveAnalysisHistoryReader, createAnalysisHistoryReader, createRuntimeAnalysisHistoryReader, type AnalysisHistoryReader, toAnalysisHistoryTurn} from '../../../agentRuntime/analysisHistory';
import {setImmediate as nextImmediate} from 'node:timers/promises';
import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {FinalizeAnalysisResultInput, FinalizedAnalysisResult} from '../../../services/finalizeAnalysisResult';
import {canonicalizeAnalysisResult} from '../../../services/canonicalAnalysisResult';
import * as finalizationContexts from '../../../agentRuntime/analysisFinalizationContext';
import type {RuntimeFinalizationContextInput} from '../../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {createDataEnvelope} from '../../../types/dataContract';
import * as authorization from '../../../services/resolvedAnalysisContext';
import {ANSWER_DRAFT_FLUSH_INTERVAL_MS} from '../../../services/answerDraftRelay';
import {resolveKnowledgeScope} from '../../../services/scopedKnowledgeStore';
import {listProductionRuntimeKinds} from '../../../agentRuntime/runtimeKinds';
import type {AnalysisOptions, AnalysisResult, IOrchestrator} from '../../../agent/core/orchestratorTypes';
import {OrchestratorConversationRuntimeAdapter} from '../orchestratorConversationRuntimeAdapter';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {createClaudeMcpServer} from '../../../agentv3/claudeMcpServer';
import {SkillExecutor} from '../../../services/skillEngine/skillExecutor';
import type {TraceProcessorService} from '../../../services/traceProcessorService';
import {resolveRuntimeEvidenceStore} from '../../../agentRuntime/runtimeEvidenceContext';
import {captureEvidenceTable} from '../../../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../../agent/core/conclusionContract';
import {NO_PRIVATE_CONTEXT} from '../../../services/security/analysisPrivateContext';
import {resolveDurableLearningPermission} from '../../../services/security/durableLearning';

const mockFinalize = jest.fn<(input: FinalizeAnalysisResultInput) => Promise<FinalizedAnalysisResult>>();
jest.mock('../../../services/finalizeAnalysisResult', () => ({
  finalizeAnalysisResult: (input: FinalizeAnalysisResultInput) => mockFinalize(input),
}));

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'conversation-finalization-test'});
function attachContext(value: AnalysisResult, runId: string, intent: Partial<RuntimeFinalizationContextInput['turnIntent']> = {},
  extra: Partial<RuntimeFinalizationContextInput> = {}) {
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(value.conclusion)};
  finalizationContexts.attachFinalizationContext(value, {runId, sessionId: value.sessionId, deadlineMs: Date.now() + 10_000,
    strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-1'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer',
      evidenceAccess: 'existing_only', ...intent},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'}}, ...extra});
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {resolve = settle;});
  return {promise, resolve};
}

beforeEach(() => {
  mockFinalize.mockReset();
  mockFinalize.mockImplementation(async input => {
    try {
      input.owner.signal.throwIfAborted();
      input.owner.assertAuthorized();
      const canonical = canonicalizeAnalysisResult(input.result, {conversation: input.conversation});
      return {result: canonical.result, conversationOutcome: canonical.conversationOutcome
        ? {...canonical.conversationOutcome, message: canonical.result.conclusion} : undefined};
    } finally {input.context?.dispose();}
  });
});

describe('Conversation evidence and stream consumer boundaries', () => {
  function useActualFinalizer() {
    mockFinalize.mockImplementation(jest.requireActual<typeof import('../../../services/finalizeAnalysisResult')>(
      '../../../services/finalizeAnalysisResult').finalizeAnalysisResult);
  }

  function attachStoreContext(value: AnalysisResult, options: AnalysisOptions, traceId: string, store: ArtifactStore,
    body: string, claimIds: string[] = []) {
    attachContext(value, options.runId!, {}, {
      traceIdentity: {currentTraceId: traceId},
      evidenceReadView: store.createEvidenceReadView({ownerKey: value.sessionId,
        allowedTraces: [{traceId, traceSide: 'current'}]}),
      dispatchText: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
        claims: claimIds.map(claimId => ({claimId, consistency: 'consistent',
          contentLocations: [{start: 0, end: body.length, text: body}], issues: []})),
        omissions: [], requirements: []})}),
    });
  }

  function issuedStore(options: AnalysisOptions, sessionId: string, traceId: string) {
    return resolveRuntimeEvidenceStore(options, {sessionId, traceId}, () => {
      throw new Error('Conversation must supply a live evidence binding');
    });
  }

  function record(store: ArtifactStore, traceId: string) {
    const data = {columns: ['metric'], rows: [[7]]};
    const id = store.store({skillId: 'fixture', title: 'Prior metric', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'})});
    store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: 'prior-metric'});
    return id;
  }

  function updateRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an update object');
    return value as Record<string, unknown>;
  }
  function text(update: unknown): string {
    const content = updateRecord(update).content;
    if (typeof content === 'string') return content;
    const record = updateRecord(content);
    const value = record.token ?? record.delta ?? record.conclusion ?? '';
    if (typeof value !== 'string') throw new Error('Expected update text');
    return value;
  }
  const isAnswer = (update: unknown) => updateRecord(update).type === 'answer_token';

  it('provides discoverable live locators and reads them via real MCP on the second turn without another SQL query', async () => {
    useActualFinalizer();
    const emitter = createOrchestrator(async () => result('unused'));
    emitter.cleanupSession = jest.fn();
    const query = jest.fn(async () => ({columns: ['id', 'metric'], rows: Array.from({length: 301}, (_, id) => [id, 7]), durationMs: 1}));
    const physicalSessions: string[] = [];
    const rawResults: AnalysisResult[] = [];
    let artifactId: string | undefined;
    emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (prompt, sessionId, traceId, options = {}) => {
      const firstTurn = physicalSessions.length === 0;
      physicalSessions.push(sessionId);
      const store = issuedStore(options, sessionId, traceId);
      const mcp = createClaudeMcpServer({traceId, sessionId, userQuery: prompt,
        artifactStore: store, traceProcessorService: {query} as unknown as TraceProcessorService,
        skillExecutor: new SkillExecutor({query}), analysisNotes: [], hypotheses: [], uncertaintyFlags: [],
        watchdogWarning: {current: null}, lightweight: true, allowNewEvidence: firstTurn,
        conversationTraceAttached: true, androidInternalsPackStore: null,
        emitUpdate: update => emitter.emit('update', update)});
      const invoke = async (name: string, args: Record<string, unknown>) => {
        const tool = mcp.toolDefinitions.find(definition => definition.name === name);
        if (!tool) throw new Error(`Missing real MCP tool ${name}`);
        return tool.shared.handler(args, {});
      };
      await nextImmediate();
      if (firstTurn) {
        await invoke('execute_sql', {sql: 'SELECT id, metric FROM measured'});
        artifactId = store.serialize().find(artifact => artifact.skillId === 'execute_sql')?.id;
        expect(artifactId).toBeDefined();
      } else {
        const catalog = prompt.split('\n').flatMap(line => {
          try {const item = JSON.parse(line); return item?.context === 'retained_artifacts' ? [item] : [];} catch {return [];}
        })[0];
        expect(catalog.artifacts).toEqual([expect.objectContaining({artifactId, traceId, traceSide: 'current', rowCount: 301})]);
        expect(catalog.artifacts[0]).not.toHaveProperty('rows');
        // Select the locator from the actual prompt, not from test-owned history.
        const fetched = await invoke('fetch_artifact', {artifactId: catalog.artifacts[0].artifactId,
          detail: 'rows', offset: 300, limit: 1});
        expect(fetched).toMatchObject({structuredContent: {success: true, rowShape: 'indexed_rows@1', rows: [{rowIndex: 300, values: [300, 7]}]}});
      }
      const body = 'The retained metric is 7.\n';
      const reference = {artifactId: artifactId!, rowIndex: 300, column: 'metric', value: 7};
      const contract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
        conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        claims: [{id: 'metric', kind: 'numeric', text: body.trim(), references: [reference],
          semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
            discourse: 'asserted', modality: 'certain', quantifier: 'one',
            scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value: 7, unit: 'count'}}}]};
      const marker = renderConclusionContractSidecar(contract);
      for (const token of [body, marker.slice(0, 19), marker.slice(19)]) {
        emitter.emit('update', {type: 'answer_token', content: {token, runId: options.runId, attempt: 0}, timestamp: Date.now()});
      }
      const value = result(body + marker, sessionId);
      rawResults.push(value);
      attachStoreContext(value, options, traceId, store, body, ['metric']);
      return value;
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {runtimeKind: 'openai-agents-sdk'});
    const first = await adapter.run({sessionId: 'conversation', runId: 'first', query: 'Observe the metric', history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'}});
    expect(query).toHaveBeenCalled();
    query.mockClear();
    const updates: unknown[] = [];
    const second = await adapter.run({sessionId: 'conversation', runId: 'second', query: 'Use the previous observation',
      history: [{role: 'assistant', content: first.message}], traceContext: {kind: 'attached', traceId: 'trace-1'},
      onUpdate: update => updates.push(update), onAnswerDraft: update => updates.push(update)});
    expect(physicalSessions).toEqual(['conversation:first', 'conversation:second']);
    expect(query).not.toHaveBeenCalled();
    expect(second.message).toBe('The retained metric is 7.\n');
    expect(updates.filter(isAnswer).map(text).join('')).toBe(second.message);
    expect(rawResults[1].conclusion).toContain('smartperfetto:conclusion-contract@');
    expect(mockFinalize.mock.calls[1][0].result).toBe(rawResults[1]);
    expect(second.finalResult?.claimVerificationResult?.claimResults[0]).toMatchObject({
      referenceCells: [expect.objectContaining({status: 'matched'})],
      // Raw SQL provides no declared unit. A real read must not manufacture one.
      deterministicProof: {status: 'candidate', reason: 'unit_authority_unknown'},
    });
    await nextImmediate();
    expect(emitter.cleanupSession).toHaveBeenCalledWith('conversation:first');
    expect(emitter.cleanupSession).toHaveBeenCalledWith('conversation:second');
    await adapter.dispose();
  });

  it('flushes an ordinary withheld prefix at settlement without inventing native completion', async () => {
    const emitter = createOrchestrator(async () => {
      await nextImmediate();
      emitter.emit('update', {type: 'answer_token', content: {token: 'Visible\n<', totalChars: 9, runId: 'tail', attempt: 0},
        timestamp: Date.now(), id: 'last-sdk-event'});
      return result('Visible\n<');
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {runtimeKind: 'openai-agents-sdk'});
    const updates: unknown[] = [];
    await adapter.run({sessionId: 'conversation', runId: 'tail', query: 'question', history: [], traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update), onAnswerDraft: update => updates.push(update)});
    expect(updates.map(text).join('')).toBe('Visible\n<');
    expect(updates[updates.length - 1]).not.toHaveProperty('id');
    expect(updates[updates.length - 1]).not.toHaveProperty('content.done');
    await adapter.dispose();
  });

  it('forwards answer drafts only for a draft-capable runtime, as live drafts rather than runtime updates', async () => {
    const run = async (draftAnswerStreaming: boolean) => {
      const emitter = createOrchestrator(async () => {
        await nextImmediate();
        emitter.emit('update', {type: 'answer_token', content: {token: 'Draft text', runId: 'r', attempt: 0}, timestamp: 1});
        emitter.emit('update', {type: 'answer_segment_reset', content: {runId: 'r', attempt: 1}, timestamp: 2});
        emitter.emit('update', {type: 'answer_token', content: {token: 'Answer', runId: 'r', attempt: 1}, timestamp: 3});
        // A string payload without the contract never becomes a draft.
        emitter.emit('update', {type: 'answer_token', content: 'untyped', timestamp: 4});
        emitter.emit('update', {type: 'progress', content: {message: 'Working'}, timestamp: 5});
        return result('Answer');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(emitter,
        {runtimeKind: draftAnswerStreaming ? 'openai-agents-sdk' : 'pi-agent-core'});
      const updates: unknown[] = [];
      const drafts: unknown[] = [];
      await adapter.run({sessionId: 'conversation', runId: 'r', query: 'question', history: [], traceContext: {kind: 'none'},
        onUpdate: update => updates.push(update), onAnswerDraft: update => drafts.push(update)});
      await adapter.dispose();
      return {updates, drafts};
    };
    const capable = await run(true);
    expect(capable.updates.map(update => updateRecord(update).type)).toEqual(['progress']);
    expect(capable.drafts).toEqual([
      expect.objectContaining({type: 'answer_segment_reset', content: {runId: 'r', attempt: 1}}),
      expect.objectContaining({type: 'answer_token', content: {token: 'Answer', runId: 'r', attempt: 1}}),
    ]);
    const incapable = await run(false);
    expect(incapable.updates.map(update => updateRecord(update).type)).toEqual(['progress']);
    expect(incapable.drafts).toEqual([]);
  });

  it('gives a private run a draft, and drops what a timer would deliver after authorization is revoked', async () => {
    let revoked = false;
    const check = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      if (revoked) throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    const emitted = deferred<void>();
    const release = deferred<void>();
    try {
      const shown = `${'Visible private draft '.repeat(12)}\n`;
      const emitter = createOrchestrator(async () => result('unused'));
      emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, _session, _trace, options = {}) => {
        // Past the size threshold: delivered at once. The second token waits for the timer.
        emitter.emit('update', {type: 'answer_token', content: {token: shown, runId: options.runId, attempt: 0}, timestamp: 1});
        emitter.emit('update', {type: 'answer_token', content: {token: 'BUFFERED_AFTER_REVOCATION', runId: options.runId,
          attempt: 0}, timestamp: 2});
        emitted.resolve();
        await release.promise;
        return result('unused');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {runtimeKind: 'openai-agents-sdk',
        analysisOptions: {codeAwareMode: 'provider_send', codebaseIds: ['private-app']}});
      const drafts: unknown[] = [];
      // Unique ids: a finished run leaves its physical session's guards revoked.
      const run = adapter.run({sessionId: 'private-draft-conversation', runId: 'private-draft-run', query: 'question',
        history: [], traceContext: {kind: 'none'}, onAnswerDraft: update => drafts.push(update)});
      await emitted.promise;
      revoked = true;
      await new Promise(resolve => setTimeout(resolve, ANSWER_DRAFT_FLUSH_INTERVAL_MS + 50));
      expect(drafts.map(text)).toEqual([shown]);
      release.resolve();
      await run.catch(() => undefined);
      await adapter.dispose();
    } finally {check.mockRestore();}
  });

  it('rejects old producer events and delayed abort/cleanup while a replacement physical run is active', async () => {
    const startedOld = deferred<void>();
    const finishOld = deferred<void>();
    const startedNew = deferred<void>();
    const finishNew = deferred<void>();
    const oldCleanup = deferred<void>();
    const emitter = createOrchestrator(async () => result('unused'));
    emitter.cleanupSession = jest.fn<NonNullable<IOrchestrator['cleanupSession']>>(sessionId => {
      if (sessionId.endsWith(':old')) oldCleanup.resolve();
    });
    emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, sessionId, traceId, options = {}) => {
      const store = issuedStore(options, sessionId, traceId);
      const old = options.runId === 'old';
      (old ? startedOld : startedNew).resolve();
      await (old ? finishOld : finishNew).promise;
      emitter.emit('update', {type: 'answer_token', content: {token: old ? 'OLD_EVENT_CANARY' : 'New answer',
        runId: options.runId, attempt: 0}, timestamp: Date.now()});
      emitter.emit('update', {type: 'data', content: createDataEnvelope({columns: ['run'], rows: [[old ? 'old' : 'new']]},
        {type: 'sql_result', source: 'fixture', title: old ? 'Old envelope' : 'New envelope'}), timestamp: Date.now()});
      const value = result(old ? 'Old answer' : 'New answer', sessionId);
      // An aborted runtime may still return its independently attached context.
      if (old) attachContext(value, options.runId!);
      else attachStoreContext(value, options, traceId, store, 'New answer');
      return value;
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {runtimeKind: 'openai-agents-sdk'});
    const old = adapter.run({sessionId: 'conversation', runId: 'old', query: 'first', history: [], traceContext: {kind: 'attached', traceId: 'trace-1'}});
    await startedOld.promise;
    await adapter.cancel('conversation', 'old');
    await expect(old).resolves.toEqual({kind: 'cancelled', message: ''});
    const updates: unknown[] = [];
    const current = adapter.run({sessionId: 'conversation', runId: 'new', query: 'second', history: [], traceContext: {kind: 'attached', traceId: 'trace-1'},
      onUpdate: update => updates.push(update), onAnswerDraft: update => updates.push(update)});
    await startedNew.promise;
    await adapter.cancel('conversation', 'old');
    finishOld.resolve();
    await oldCleanup.promise;
    expect(updates).toEqual([]);
    expect(emitter.abortSession).not.toHaveBeenCalledWith('conversation:new');
    finishNew.resolve();
    await expect(current).resolves.toMatchObject({kind: 'answered', message: 'New answer'});
    expect(updates.filter(isAnswer).map(text).join('')).toBe('New answer');
    expect(mockFinalize.mock.calls).toHaveLength(1);
    expect(mockFinalize.mock.calls[0][0].dataEnvelopes).toEqual([
      expect.objectContaining({display: expect.objectContaining({title: 'New envelope'})}),
    ]);
    await adapter.dispose();
  });

  it.each(['trace', 'tenantId', 'workspaceId', 'userId', 'codebaseIds', 'knowledgeSourceIds'] as const)(
    'replaces retained evidence when %s changes and never restores it when the old scope returns', async changed => {
      const options: AnalysisOptions = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'};
      const emitter = createOrchestrator(async () => result('unused'));
      let calls = 0;
      emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (prompt, sessionId, traceId, runtimeOptions = {}) => {
        const store = issuedStore(runtimeOptions, sessionId, traceId);
        if (calls++ === 0) record(store, traceId);
        else {expect(store.size).toBe(0); expect(prompt).not.toContain('"context":"retained_artifacts"');}
        return result('answer', sessionId);
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {analysisOptions: options});
      const input = {sessionId: 'conversation', query: 'question', history: [], traceContext: {kind: 'attached' as const, traceId: 'trace-1'}};
      await adapter.run({...input, runId: 'first'});
      if (changed === 'codebaseIds' || changed === 'knowledgeSourceIds') options[changed] = ['another-source'];
      else if (changed !== 'trace') options[changed] = 'another-owner';
      await adapter.run({...input, runId: 'second', ...(changed === 'trace' ? {traceContext: {kind: 'attached' as const, traceId: 'trace-2'}} : {})});
      if (changed === 'codebaseIds' || changed === 'knowledgeSourceIds') delete options[changed];
      else if (changed !== 'trace') options[changed] = changed === 'tenantId' ? 'tenant' : changed === 'workspaceId' ? 'workspace' : 'user';
      await adapter.run({...input, runId: 'third'});
      await adapter.dispose();
    });

  it('revokes a current captured read view on product disposal and rejects later runs', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    let store!: ArtifactStore;
    let artifactId!: string;
    let view!: ReturnType<ArtifactStore['createEvidenceReadView']>;
    const emitter = createOrchestrator(async () => result('unused'));
    emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, sessionId, traceId, options = {}) => {
      store = issuedStore(options, sessionId, traceId);
      artifactId = record(store, traceId);
      view = store.createEvidenceReadView({ownerKey: sessionId, allowedTraces: [{traceId, traceSide: 'current'}]});
      started.resolve();
      await finish.promise;
      return result('late', sessionId);
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter);
    const input = {sessionId: 'conversation', runId: 'current', query: 'question', history: [],
      traceContext: {kind: 'attached' as const, traceId: 'trace-1'}};
    const pending = adapter.run(input);
    await started.promise;
    const requests = [{key: 'metric', reference: {artifactId, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']}];
    expect((await view.resolveReferences(requests))[0]).toMatchObject({status: 'resolved', row: {metric: 7}});
    await adapter.dispose();
    await expect(pending).resolves.toEqual({kind: 'cancelled', message: ''});
    await expect(view.resolveReferences(requests)).rejects.toThrow();
    expect(() => store.fetch(artifactId, 'rows')).toThrow();
    await expect(adapter.run({...input, runId: 'later'})).rejects.toThrow('Conversation adapter disposed');
    finish.resolve();
  });
});

function updateType(update: unknown): unknown {
  return update && typeof update === 'object' ? (update as {type?: unknown}).type : undefined;
}

function createOrchestrator(
  analyze: (options: AnalysisOptions) => Promise<AnalysisResult>,
): IOrchestrator {
  const emitter = new EventEmitter() as unknown as IOrchestrator;
  emitter.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, _sessionId, _traceId, options = {}) => analyze(options));
  emitter.reset = jest.fn();
  emitter.abortSession = jest.fn<NonNullable<IOrchestrator['abortSession']>>(() => undefined);
  return emitter;
}

function result(conclusion: string, sessionId = 'runtime-session'): AnalysisResult {
  return {
    sessionId,
    success: true,
    findings: [{
      id: 'ev-1',
      severity: 'info',
      title: 'Trace evidence',
      description: 'evidence',
      source: 'sql',
    }],
    hypotheses: [],
    conclusion,
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
  };
}

describe('OrchestratorConversationRuntimeAdapter', () => {
  it.each([
    ['a public run marker', NO_PRIVATE_CONTEXT, true],
    ['a private run marker under a public selection', {codebase: false, knowledge: true}, false],
    ['no run marker', undefined, false],
  ] as const)('grants cross-session learning from %s only', async (_label, privateContext, granted) => {
    let receivedOptions: AnalysisOptions | undefined;
    const orchestrator = createOrchestrator(async (options) => {
      receivedOptions = options;
      return result('ok\n<!-- smartperfetto:conversation-control {"kind":"answered"} -->');
    });
    await new OrchestratorConversationRuntimeAdapter(orchestrator).run({
      sessionId: 'conversation-learning', runId: 'run-learning', query: 'q', history: [], traceContext: {kind: 'none'},
      ...(privateContext ? {privateContext} : {}),
    });
    expect(resolveDurableLearningPermission(receivedOptions!)).toEqual(granted ? {runId: 'run-learning'} : undefined);
  });

  it.each(listProductionRuntimeKinds())(
    'applies the same conversation contract to %s',
    async () => {
      let receivedOptions: AnalysisOptions | undefined;
      const orchestrator = createOrchestrator(async (options) => {
        receivedOptions = options;
        return result('可以先看主线程。\n<!-- smartperfetto:conversation-control {"kind":"answered"} -->');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);

      await expect(adapter.run({
        sessionId: 'conversation-1',
        runId: 'run-1',
        query: '怎么分析？',
        history: [],
        traceContext: {kind: 'none'},
      })).resolves.toMatchObject({
        kind: 'answered',
        message: '可以先看主线程。\n',
        evidence: [{id: 'ev-1', label: 'Trace evidence', source: 'sql'}],
      });
      expect(receivedOptions).toMatchObject({
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        runId: 'run-1',
      });
    },
  );

  it('uses the per-turn selection and clears a stale constructor selection', async () => {
    const receivedOptions: AnalysisOptions[] = [];
    const orchestrator = createOrchestrator(async (options) => {
      receivedOptions.push(options);
      return result('回答');
    });
    const initialSelection = {
      kind: 'track_event' as const,
      eventId: 1,
      ts: 100,
      name: 'old slice',
    };
    const currentSelection = {
      kind: 'track_event' as const,
      source: 'track_event_selection' as const,
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
      name: 'current slice',
    };
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {
      analysisOptions: {selectionContext: initialSelection},
    });

    await adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-1',
      query: 'Analyze the selected slice',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
      selectionContext: currentSelection,
    });
    await adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-2',
      query: 'Continue without a selection',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    expect(receivedOptions[0].selectionContext).toEqual(currentSelection);
    expect(receivedOptions[1].selectionContext).toBeUndefined();
  });

  it('cancels the exact physical runtime run', async () => {
    let rejectRun: ((error: Error) => void) | undefined;
    const orchestrator = createOrchestrator(() => new Promise((_resolve, reject) => {
      rejectRun = reject;
    }));
    orchestrator.abortSession = jest.fn<NonNullable<IOrchestrator['abortSession']>>(() => rejectRun?.(new Error('Analysis aborted')));
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);
    const completion = adapter.run({
      sessionId: 'conversation-1',
      runId: 'run-1',
      query: '继续查',
      history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'},
    });

    await adapter.cancel('conversation-1', 'run-1');

    await expect(completion).resolves.toEqual({kind: 'cancelled', message: ''});
    expect(orchestrator.abortSession).toHaveBeenCalledWith('conversation-1:run-1');
  });

  it('retains owner source query references in runtime updates and terminal outcomes', async () => {
    const privateQuery = 'private pasted source line';
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn<IOrchestrator['analyze']>(async () => {
      emitter.emit('update', {
        type: 'progress',
        content: {message: privateQuery},
        timestamp: Date.now(),
      });
      return result(`Answer repeats ${privateQuery}`);
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn<NonNullable<IOrchestrator['abortSession']>>(() => undefined);
    const updates: unknown[] = [];
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'en',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
      },
    });

    const outcome = await adapter.run({
      sessionId: 'conversation-private',
      runId: 'run-private',
      query: privateQuery,
      history: [],
      traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update),
    });

    expect(JSON.stringify(updates)).toContain(privateQuery);
    expect(JSON.stringify(outcome)).toContain(privateQuery);
    expect(outcome.message).not.toContain('[PRIVATE_QUERY_REFERENCE]');
  });

  it('allows owner source query references from earlier turns throughout the current run', async () => {
    const previousPrivateQuery = 'private source pasted in the previous turn';
    const currentPrivateQuery = 'continue reviewing that source';
    const emitter = new EventEmitter() as unknown as IOrchestrator;
    emitter.analyze = jest.fn<IOrchestrator['analyze']>(async () => {
      emitter.emit('update', {
        type: 'progress',
        content: {message: previousPrivateQuery},
        timestamp: Date.now(),
      });
      return result(`Answer repeats ${previousPrivateQuery}`);
    });
    emitter.reset = jest.fn();
    emitter.abortSession = jest.fn<NonNullable<IOrchestrator['abortSession']>>(() => undefined);
    const updates: unknown[] = [];
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {
      analysisOptions: {
        outputLanguage: 'en',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-app'],
      },
    });

    const outcome = await adapter.run({
      sessionId: 'conversation-private',
      runId: 'run-private-second-turn',
      query: currentPrivateQuery,
      history: [
        {role: 'user', content: previousPrivateQuery},
        {role: 'assistant', content: 'Projected prior answer'},
      ],
      traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update),
    });

    expect(JSON.stringify(updates)).toContain(previousPrivateQuery);
    expect(JSON.stringify(outcome)).toContain(previousPrivateQuery);
    expect(outcome.message).not.toContain('[PRIVATE_QUERY_REFERENCE]');
  });

  it.each([
    '为什么这次启动很慢？',
    '结合源码看看 Foo::bar 的调用链',
    '完整审查整个源码',
  ])('preserves authorized source and fingerprint without adding a source budget: %s', async query => {
    let receivedOptions: AnalysisOptions | undefined;
    const orchestrator = createOrchestrator(async options => {
      receivedOptions = options;
      return result('Trace answer');
    });
    const analysisOptions: AnalysisOptions = {
      codeAwareMode: 'provider_send', codebaseIds: ['private-app'], taskTimeoutMs: 21_000,
    };
    analysisOptions.analysisContextFingerprint = authorization.buildAnalysisContextAuthorizationFingerprint(
      analysisOptions, resolveKnowledgeScope(analysisOptions));
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions});
    await adapter.run({sessionId: 'conversation-source', runId: 'run-source', query, history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'}});

    expect(receivedOptions).toMatchObject({...analysisOptions, assistantSurface: 'conversation', analysisMode: 'fast'});
    expect(receivedOptions?.sourceUsePolicy).toBeUndefined();
    expect(mockFinalize.mock.calls[0][0].owner.analysisContextFingerprint).toBe(analysisOptions.analysisContextFingerprint);
    expect(orchestrator.analyze).toHaveBeenCalledTimes(1);
  });

  it('runs each turn at its own source depth, not the one the adapter was built with', async () => {
    const received: AnalysisOptions[] = [];
    const orchestrator = createOrchestrator(async options => {
      received.push(options);
      return result('answer');
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {
      codeAwareMode: 'provider_send', codebaseIds: ['private-app'], sourceDepth: 'locate',
    }});
    await adapter.run({sessionId: 'conversation', runId: 'run-1', query: 'locate', history: [],
      traceContext: {kind: 'none'}});
    await adapter.run({sessionId: 'conversation', runId: 'run-2', query: 'explain', history: [],
      traceContext: {kind: 'none'}, sourceDepth: 'mechanism'});

    expect(received.map(options => options.sourceDepth)).toEqual(['locate', 'mechanism']);
  });

  it('preserves an explicit caller source policy and the total runtime budget', async () => {
    let receivedOptions: AnalysisOptions | undefined;
    const orchestrator = createOrchestrator(async options => {
      receivedOptions = options;
      return result('answer');
    });
    const sourceUsePolicy = {phase: 'explicit' as const};
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {
      codeAwareMode: 'provider_send', codebaseIds: ['private-app'], sourceUsePolicy, taskTimeoutMs: 25_000,
    }});
    await adapter.run({sessionId: 'conversation', runId: 'run', query: '继续', history: [], traceContext: {kind: 'none'}});
    expect(receivedOptions?.sourceUsePolicy).toBe(sourceUsePolicy);
    expect(receivedOptions?.taskTimeoutMs).toBe(25_000);
  });

  it.each(['provider_send', 'metadata_only', 'off', undefined] as const)(
    'rejects legacy source history without a fingerprint under %s authorization', async codeAwareMode => {
      let receivedQuery = '';
      let history = '';
      const orchestrator = createOrchestrator(async () => result('trace answer'));
      orchestrator.analyze = jest.fn<IOrchestrator['analyze']>(async (query, _session, _trace, options) => {
        receivedQuery = query;
        history = JSON.stringify(resolveAnalysisHistoryReader(options!,
          createAnalysisHistoryReader({getTurns: () => [], assertActive: () => {}})).getTurns());
        return result('trace answer');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {
        codeAwareMode, codebaseIds: ['private-app'],
      }});
      await adapter.run({sessionId: 'conversation-history', runId: 'run-history', query: '继续分析启动耗时',
        history: [
          {role: 'user', content: '上一轮普通问题'},
          {role: 'assistant', content: '普通 Trace 回答'},
          {role: 'assistant', content: 'PRIVATE_SOURCE_DERIVED_CANARY', sourceDerived: true},
        ], traceContext: {kind: 'attached', traceId: 'trace-1'}});
      expect(receivedQuery).not.toContain('普通 Trace 回答');
      expect(history).toContain('普通 Trace 回答');
      expect(history).not.toContain('PRIVATE_SOURCE_DERIVED_CANARY');
    },
  );

  it('keeps explicit source A and B history scoped through the real runtime wrapper and rejects unknown legacy grants', async () => {
    const check = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {});
    const options: AnalysisOptions = {codeAwareMode: 'provider_send', codebaseIds: ['source-a'], analysisContextFingerprint: 'grant-a'};
    const turns = ['a', 'b', 'legacy'].map((source, index) => toAnalysisHistoryTurn({
      id: `turn-${source}`, turnIndex: index, query: `QUERY_${source}`, traceId: 'trace-1', timestamp: index,
      sourceDerived: true, ...(source !== 'legacy' ? {analysisContextFingerprint: `grant-${source}`} : {}),
      result: {conclusion: `ANSWER_${source}`, completion: {status: 'completed'}},
    }));
    const received: string[][] = [];
    try {
      const orchestrator = createOrchestrator(async () => result('answer'));
      orchestrator.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, _session, _trace, runtimeOptions) => {
        const reader = createRuntimeAnalysisHistoryReader({options: {...runtimeOptions!}, sessionId: _session, traceId: _trace,
          getTurns: () => [], assertActive: () => {}});
        received.push(reader.getTurns().map(turn => turn.id));
        const forbidden = options.analysisContextFingerprint === 'grant-a' ? 'turn-b' : 'turn-a';
        expect(reader.read({turnId: forbidden})).toMatchObject({success: false});
        expect(reader.read({turnId: 'turn-legacy'})).toMatchObject({success: false});
        return result('answer');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: options});
      const input = {sessionId: 'scope-switch', query: '结合源码继续', history: [], getHistoryTurns: () => turns,
        traceContext: {kind: 'attached' as const, traceId: 'trace-1'}};
      await adapter.run({...input, runId: 'run-a'});
      options.codebaseIds = ['source-b']; options.analysisContextFingerprint = 'grant-b';
      await adapter.run({...input, runId: 'run-b'});
      options.analysisContextFingerprint = undefined;
      await adapter.run({...input, runId: 'run-unknown'});
      expect(received).toEqual([['turn-a'], ['turn-b'], []]);
      expect(turns[2].analysisContextFingerprint).toBeUndefined();
      await adapter.dispose();
    } finally {check.mockRestore();}
  });

  it('restores matching knowledge-only history through the runtime wrapper and denies every read after revocation', async () => {
    let revoked = false;
    const check = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(selection => {
      expect(selection.knowledgeSourceIds).toEqual(['private-wiki']);
      if (revoked) throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    const restoredTurn = toAnalysisHistoryTurn({id: 'restored-knowledge', turnIndex: 0,
      query: 'Prior knowledge question', traceId: 'trace-1', timestamp: 1, sourceDerived: true,
      analysisContextFingerprint: 'knowledge-grant', result: {conclusion: 'Retained knowledge conclusion', partial: true}});
    try {
      const orchestrator = createOrchestrator(async () => result('answer'));
      orchestrator.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, sessionId, traceId, runtimeOptions) => {
        expect(runtimeOptions?.sourceUsePolicy).toBeUndefined();
        const reader = createRuntimeAnalysisHistoryReader({options: {...runtimeOptions!}, sessionId, traceId,
          getTurns: () => [], assertActive: () => {}});
        expect(reader.getTurns()).toEqual([restoredTurn]);
        expect(reader.read({turnId: restoredTurn.id})).toMatchObject({success: true});
        revoked = true;
        expect(() => reader.getTurns()).toThrow('analysis_context_changed_restart_required');
        expect(() => reader.read({turnId: restoredTurn.id})).toThrow('analysis_context_changed_restart_required');
        revoked = false;
        return result('answer');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {
        codeAwareMode: 'off', knowledgeSourceIds: ['private-wiki'], analysisContextFingerprint: 'knowledge-grant',
      }});
      await adapter.run({sessionId: 'knowledge-conversation', runId: 'knowledge-followup', query: '继续解释上一轮',
        history: [], getHistoryTurns: () => [restoredTurn], traceContext: {kind: 'attached', traceId: 'trace-1'}});
      expect(orchestrator.analyze).toHaveBeenCalledTimes(1);
      await adapter.dispose();
    } finally {check.mockRestore();}
  });

  it('filters both sides of dormant source turns and rechecks authorization for every historical read', async () => {
    let reader: AnalysisHistoryReader | undefined;
    let revoked = false;
    const check = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      if (revoked) throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    try {
      const orchestrator = createOrchestrator(async () => result('answer'));
      orchestrator.analyze = jest.fn<IOrchestrator['analyze']>(async (_query, _session, _trace, options) => {
        reader = resolveAnalysisHistoryReader(options!, createAnalysisHistoryReader({getTurns: () => [], assertActive: () => {}}));
        expect(JSON.stringify(reader.getTurns())).not.toMatch(/SOURCE_QUERY_CANARY|SOURCE_ANSWER_CANARY/);
        revoked = true;
        expect(() => reader!.read({turnId: 'legacy-1'})).toThrow('analysis_context_changed_restart_required');
        revoked = false;
        return result('answer');
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {codeAwareMode: 'off'}});
      await adapter.run({sessionId: 'history-auth', runId: 'history-run', query: 'continue', traceContext: {kind: 'none'},
        history: [{role: 'user', content: 'SOURCE_QUERY_CANARY'},
          {role: 'assistant', content: 'SOURCE_ANSWER_CANARY', sourceDerived: true}]});
      await adapter.dispose();
      expect(() => reader!.read({})).toThrow();
    } finally {check.mockRestore();}
  });

  it.each([
    '```xml\n<invoke name="example">quoted text</invoke>\n```',
    '> <tool_call>quoted text</tool_call>',
    'The DSML tools_calling token is ordinary text in this explanation.',
    '<｜｜DSML｜｜tools_calling><｜｜DSML｜｜invoke name="example">text</｜｜DSML｜｜invoke>',
  ])('finalizes protocol examples as model text without inferring tool execution: %s', async body => {
    const orchestrator = createOrchestrator(async () => result(body));
    const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);

    const outcome = await adapter.run({
      sessionId: 'conversation-protocol',
      runId: 'run-protocol',
      query: '请搜索实现',
      history: [],
      traceContext: {kind: 'none'},
    });

    expect(outcome.kind).toBe('answered');
    expect(outcome.message).toBe(body);
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(mockFinalize.mock.calls[0][0].result.conclusion).toBe(body);
  });

  it.each(['Main thread busy', 'Foo::bar', 'app/src/Foo.kt:L42'])(
    'keeps the primary runtime and tool capability unchanged for finding label %s', async label => {
      let receivedOptions: AnalysisOptions | undefined;
      const orchestrator = createOrchestrator(async options => {
        receivedOptions = options;
        const value = result('answer');
        value.findings[0].title = label;
        attachContext(value, options.runId!, {scope: 'scene_wide', evidenceAccess: 'read_new'});
        return value;
      });
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator, {analysisOptions: {
        codeAwareMode: 'provider_send', codebaseIds: ['private-app'],
      }});
      await adapter.run({sessionId: 'conversation', runId: 'run', query: '为什么启动慢？', history: [],
        traceContext: {kind: 'attached', traceId: 'trace-1'}});
      expect(orchestrator.analyze).toHaveBeenCalledTimes(1);
      expect(mockFinalize).toHaveBeenCalledTimes(1);
      expect(receivedOptions).toMatchObject({codeAwareMode: 'provider_send', codebaseIds: ['private-app']});
      expect(receivedOptions?.sourceUsePolicy).toBeUndefined();
      expect(adapter).not.toHaveProperty('shouldStartSourceEnrichment');
      expect(adapter).not.toHaveProperty('runSourceEnrichment');
    },
  );

  it('takes the exact runtime result, collects raw envelopes, and preserves the finalized body', async () => {
    const envelope = createDataEnvelope({columns: ['value'], rows: [[7]]}, {type: 'sql_result', source: 'execute_sql', title: 'actual data'});
    let raw!: AnalysisResult;
    const emitter = createOrchestrator(async options => {
      emitter.emit('update', {type: 'data', content: envelope, timestamp: Date.now()});
      raw = result('  Exact body.\r\n');
      attachContext(raw, options.runId!);
      return raw;
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter);
    const updates: unknown[] = [];
    const outcome = await adapter.run({sessionId: 'conversation', runId: 'run', query: 'question', history: [],
      traceContext: {kind: 'attached', traceId: 'trace-1'}, onUpdate: update => updates.push(update)});
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    const received = mockFinalize.mock.calls[0][0];
    expect(received.result).toBe(raw);
    expect(received.owner.runId).toBe('run');
    expect(received.comparisonIdentity).toBeUndefined();
    expect(received.dataEnvelopes?.[0]).toBe(envelope);
    expect(finalizationContexts.takeFinalizationContext(raw)).toBeUndefined();
    expect(() => received.context!.runId).toThrow('finalization_context_disposed');
    expect(outcome.message).toBe('  Exact body.\r\n');
    expect(outcome.finalResult?.conclusion).toBe(outcome.message);
    expect(updates).toHaveLength(1);
  });

  it('delivers partial results with their typed failed verification instead of rejecting their message', async () => {
    const value = {...result('  Partial but useful answer.\r\n'), success: false, partial: true};
    mockFinalize.mockImplementationOnce(async input => ({result: {...input.result,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed', policy: 'record_only', passed: false,
        checkedClaimCount: 1, unsupportedClaimCount: 1, claimResults: [{claimId: 'claim', status: 'unsupported'}], issues: []}},
      conversationOutcome: {kind: 'answered', message: value.conclusion}}));
    const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () => value));
    const outcome = await adapter.run({sessionId: 'conversation', runId: 'partial', query: 'question', history: [], traceContext: {kind: 'none'}});
    expect(outcome).toMatchObject({kind: 'answered', message: value.conclusion, finalResult: {partial: true,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed', passed: false}}});
  });

  it('keeps invalid conversation control ineligible without inventing a clarification', async () => {
    const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () =>
      result('Answer body\n<!-- smartperfetto:conversation-control {invalid} -->')));
    const outcome = await adapter.run({sessionId: 'conversation', runId: 'invalid', query: 'question', history: [], traceContext: {kind: 'none'}});
    expect(outcome.kind).toBe('answered');
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(outcome.message).toBe(outcome.finalResult?.conclusion);
    expect(outcome.message).toBe('Answer body\n');
  });

  it.each(['cancel', 'dispose'] as const)('blocks late finalizer results and updates after %s', async action => {
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalize.mockImplementationOnce(input => {started.resolve(input); return finish.promise.finally(() => input.context?.dispose());});
    const emitter = createOrchestrator(async options => {
      const value = result('answer'); attachContext(value, options.runId!); return value;
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter);
    const updates: unknown[] = [];
    const pending = adapter.run({sessionId: 'conversation', runId: 'pending', query: 'question', history: [], traceContext: {kind: 'none'},
      onUpdate: update => updates.push(update)});
    const input = await started.promise;
    if (action === 'cancel') await adapter.cancel('conversation', 'pending'); else await adapter.dispose();
    expect(input.owner.signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({kind: 'cancelled', message: ''});
    emitter.emit('update', {type: 'data', content: createDataEnvelope({columns: ['value'], rows: [[8]]},
      {type: 'sql_result', source: 'execute_sql', title: 'late'}), timestamp: Date.now()});
    expect(updates).toHaveLength(0);
    expect(input.dataEnvelopes).toHaveLength(0);
    finish.resolve({result: input.result, conversationOutcome: {kind: 'answered', message: 'late'}});
    await mockFinalize.mock.results[0].value;
    expect(() => input.context!.runId).toThrow('finalization_context_disposed');
  });

  it('rejects a context belonging to a different run instead of adopting its identity', async () => {
    const take = finalizationContexts.takeFinalizationContext;
    let context: ReturnType<typeof take>;
    const spy = jest.spyOn(finalizationContexts, 'takeFinalizationContext').mockImplementation(value => (context = take(value)));
    try {
      const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () => {
        const value = result('answer'); attachContext(value, 'another-run'); return value;
      }));
      await expect(adapter.run({sessionId: 'conversation', runId: 'current-run', query: 'question', history: [], traceContext: {kind: 'none'}}))
        .rejects.toThrow('finalization_run_identity_mismatch');
      expect(mockFinalize).not.toHaveBeenCalled();
      expect(() => context!.runId).toThrow('finalization_context_disposed');
    } finally {spy.mockRestore();}
  });

  it('rechecks authorization after finalization and cannot publish a revoked result', async () => {
    let revoked = false;
    const authorizationCheck = jest.spyOn(authorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      if (revoked) throw new authorization.AnalysisContextAuthorizationChangedError();
    });
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalize.mockImplementationOnce(input => {started.resolve(input); return finish.promise;});
    try {
      const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () => result('answer')));
      const pending = adapter.run({sessionId: 'conversation', runId: 'revoke', query: 'question', history: [], traceContext: {kind: 'none'}});
      const input = await started.promise;
      revoked = true;
      finish.resolve({result: input.result, conversationOutcome: {kind: 'answered', message: 'answer'}});
      await expect(pending).rejects.toThrow('analysis_context_changed_restart_required');
    } finally {authorizationCheck.mockRestore();}
  });

  it('does not let an old finalizer return into the replacement run', async () => {
    const started = deferred<FinalizeAnalysisResultInput>();
    const finish = deferred<FinalizedAnalysisResult>();
    mockFinalize.mockImplementationOnce(input => {started.resolve(input); return finish.promise;});
    const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () => result('answer')));
    const first = adapter.run({sessionId: 'conversation', runId: 'old', query: 'first', history: [], traceContext: {kind: 'none'}});
    const oldInput = await started.promise;
    const second = await adapter.run({sessionId: 'conversation', runId: 'new', query: 'second', history: [], traceContext: {kind: 'none'}});
    await expect(first).resolves.toEqual({kind: 'cancelled', message: ''});
    expect(second.kind).toBe('answered');
    expect(oldInput.owner.signal.aborted).toBe(true);
    finish.resolve({result: oldInput.result, conversationOutcome: {kind: 'answered', message: 'late old result'}});
    await mockFinalize.mock.results[0].value;
  });

  it.each(['legacy', 'existing_only', 'unavailable', 'bounded'] as const)('does not start another runtime for %s evidence policy', async mode => {
    const emitter = createOrchestrator(async options => {
      const value = result('answer');
      if (mode !== 'legacy') attachContext(value, options.runId!, {status: mode === 'unavailable' ? 'unavailable' : 'resolved',
        scope: mode === 'bounded' ? 'bounded_question' : 'scene_wide', evidenceAccess: mode === 'existing_only' ? 'existing_only' : 'read_new'});
      return value;
    });
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter, {analysisOptions: {codeAwareMode: 'provider_send', codebaseIds: ['private-app']}});
    const input = {sessionId: 'conversation', runId: 'policy', query: '为什么启动慢？', history: [], traceContext: {kind: 'attached' as const, traceId: 'trace-1'}};
    await adapter.run(input);
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(emitter.analyze).toHaveBeenCalledTimes(1);
  });

  describe('deliver first, verify after', () => {
    const reviewPendingFinalizer = (seen: {stopSignal?: AbortSignal}) => mockFinalize.mockImplementationOnce(async input => {
      try {
        seen.stopSignal = input.reviewStopSignal;
        input.onProvisionalAnswer?.({conclusion: input.result.conclusion});
        await new Promise(resolve => input.reviewStopSignal!.addEventListener('abort', resolve, {once: true}));
        input.owner.signal.throwIfAborted();
        return {result: input.result, conversationOutcome: {kind: 'answered', message: input.result.conclusion}};
      } finally {input.context?.dispose();}
    });

    it('forwards the provisional answer once and the session-owned review stop signal', async () => {
      const seen: {stopSignal?: AbortSignal} = {};
      reviewPendingFinalizer(seen);
      const orchestrator = createOrchestrator(async () => result('Trace duration is 12.3 s.'));
      const adapter = new OrchestratorConversationRuntimeAdapter(orchestrator);
      const provisional: string[] = [];
      let delivered!: () => void;
      const deliveredPromise = new Promise<void>(resolve => {delivered = resolve;});
      const reviewStop = new AbortController();
      const completion = adapter.run({sessionId: 'conversation', runId: 'run', query: 'trace 时长', history: [],
        traceContext: {kind: 'none'}, reviewStopSignal: reviewStop.signal,
        onProvisionalAnswer: ({message}) => {provisional.push(message); delivered();}});
      await deliveredPromise;
      expect(provisional).toEqual(['Trace duration is 12.3 s.']);
      expect(seen.stopSignal).toBe(reviewStop.signal);
      reviewStop.abort();
      await expect(completion).resolves.toMatchObject({kind: 'answered', message: 'Trace duration is 12.3 s.'});
      expect(orchestrator.abortSession).not.toHaveBeenCalled();
    });

    it('owner-projects a private provisional answer like the terminal message', async () => {
      const privateQuery = '请看源码确认 PRIVATE_PROVISIONAL_CANARY 为什么返回空';
      const seen: {stopSignal?: AbortSignal} = {};
      reviewPendingFinalizer(seen);
      const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () =>
        result(`Answer repeats ${privateQuery}`)), {analysisOptions: {codeAwareMode: 'metadata_only', codebaseIds: ['private-app']}});
      const provisional: string[] = [];
      let delivered!: () => void;
      const deliveredPromise = new Promise<void>(resolve => {delivered = resolve;});
      const reviewStop = new AbortController();
      const completion = adapter.run({sessionId: 'private-provisional', runId: 'private-provisional-run', query: privateQuery,
        history: [], traceContext: {kind: 'none'}, reviewStopSignal: reviewStop.signal,
        onProvisionalAnswer: ({message}) => {provisional.push(message); delivered();}});
      await deliveredPromise;
      reviewStop.abort();
      const outcome = await completion;
      expect(provisional).toEqual([outcome.message]);
    });

    it('shows no pending cue and sends no review when the review is not required', async () => {
      mockFinalize.mockImplementation(jest.requireActual<typeof import('../../../services/finalizeAnalysisResult')>(
        '../../../services/finalizeAnalysisResult').finalizeAnalysisResult);
      const dispatchText = jest.fn(async () => ({status: 'ok' as const, text: '{}'}));
      const orchestrator = createOrchestrator(async options => {
        const value = result('Trace duration is 12.3 s.');
        attachContext(value, options.runId!, {}, {dispatchText});
        return value;
      });
      const provisional = jest.fn(() => true);
      const updates: unknown[] = [];
      const outcome = await new OrchestratorConversationRuntimeAdapter(orchestrator).run({sessionId: 'conversation',
        runId: 'no-review', query: 'trace 时长', history: [], traceContext: {kind: 'none'},
        onProvisionalAnswer: provisional, onUpdate: update => updates.push(update)});
      expect(dispatchText).not.toHaveBeenCalled();
      expect(provisional).not.toHaveBeenCalled();
      expect(JSON.stringify(updates)).not.toContain('final_review');
      expect(outcome).toMatchObject({kind: 'answered', message: 'Trace duration is 12.3 s.'});
      expect(outcome.finalResult?.claimVerificationResult?.notCheckedReason).toBe('not_required');
    });

    it('does not forward the runtime raw conclusion as a second answer source', async () => {
      const emitter = createOrchestrator(async () => {
        emitter.emit('update', {type: 'conclusion', content: {conclusion: 'raw runtime conclusion'}, timestamp: Date.now()});
        emitter.emit('update', {type: 'progress', content: {phase: 'x', message: 'still narrated'}, timestamp: Date.now()});
        return result('final');
      });
      const updates: unknown[] = [];
      await new OrchestratorConversationRuntimeAdapter(emitter).run({sessionId: 'conversation', runId: 'raw', query: 'q',
        history: [], traceContext: {kind: 'none'}, onUpdate: update => updates.push(update)});
      expect(updates.map(update => updateType(update))).toEqual(['progress']);
    });
  });

  it('projects a private final result with its failed @2 status intact and keeps the shell body consistent', async () => {
    const privateQuery = '请看源码确认 PRIVATE_FINAL_CANARY 为什么返回空';
    mockFinalize.mockImplementationOnce(async input => ({result: {...input.result, conclusion: `Answer repeats ${privateQuery}`,
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed', policy: 'record_only', passed: false,
        checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [], issues: []}},
      conversationOutcome: {kind: 'answered', message: `Answer repeats ${privateQuery}`}}));
    const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async () => result('answer')),
      {analysisOptions: {codeAwareMode: 'metadata_only', codebaseIds: ['private-app']}});
    const outcome = await adapter.run({sessionId: 'private', runId: 'private-run', query: privateQuery, history: [], traceContext: {kind: 'none'}});
    expect(outcome.finalResult?.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'failed', passed: false});
    expect(outcome.message).toBe(outcome.finalResult?.conclusion);
    expect(JSON.stringify(outcome)).toContain('PRIVATE_FINAL_CANARY');
    expect(outcome).not.toHaveProperty('semanticAssessment');
    expect(outcome).not.toHaveProperty('context');
  });

  it('passes protocol-like text through the same take/finalize/dispose boundary', async () => {
    const take = finalizationContexts.takeFinalizationContext;
    let context: ReturnType<typeof take>;
    const spy = jest.spyOn(finalizationContexts, 'takeFinalizationContext').mockImplementation(value => (context = take(value)));
    try {
      const adapter = new OrchestratorConversationRuntimeAdapter(createOrchestrator(async options => {
        const value = result('<｜｜DSML｜｜tools_calling><｜｜DSML｜｜invoke name="bash">secret</｜｜DSML｜｜invoke>');
        attachContext(value, options.runId!); return value;
      }));
      const outcome = await adapter.run({sessionId: 'conversation', runId: 'protocol', query: 'question', history: [], traceContext: {kind: 'none'}});
      expect(outcome.kind).toBe('answered');
      expect(outcome.finalResult?.conclusion).toBe(outcome.message);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(mockFinalize).toHaveBeenCalledTimes(1);
      expect(() => context!.runId).toThrow('finalization_context_disposed');
    } finally {spy.mockRestore();}
  });

  it('takes and disposes a late primary runtime context after cancellation without finalizing it', async () => {
    const lateResult = deferred<AnalysisResult>();
    const started = deferred<void>();
    const contextTaken = deferred<void>();
    const emitter = createOrchestrator(async () => {started.resolve(); return lateResult.promise;});
    const adapter = new OrchestratorConversationRuntimeAdapter(emitter,
      {analysisOptions: {codeAwareMode: 'provider_send', codebaseIds: ['private-app']}});
    const input = {sessionId: 'conversation', runId: 'source', query: '为什么启动慢？', history: [],
      traceContext: {kind: 'attached' as const, traceId: 'trace-1'}};
    const take = finalizationContexts.takeFinalizationContext;
    let context: ReturnType<typeof take>;
    const spy = jest.spyOn(finalizationContexts, 'takeFinalizationContext').mockImplementation(value => {
      context = take(value);
      contextTaken.resolve();
      return context;
    });
    try {
      const pending = adapter.run(input);
      await started.promise;
      await adapter.cancel(input.sessionId, input.runId);
      await expect(pending).resolves.toEqual({kind: 'cancelled', message: ''});
      const value = {...result('late private source answer'), sessionId: 'conversation:source'};
      attachContext(value, 'source');
      lateResult.resolve(value);
      await contextTaken.promise;
      expect(mockFinalize).not.toHaveBeenCalled();
      expect(() => context!.runId).toThrow('finalization_context_disposed');
    } finally {spy.mockRestore();}
  });

});
