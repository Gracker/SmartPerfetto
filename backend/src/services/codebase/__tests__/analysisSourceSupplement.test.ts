// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import type {AnalysisOptions, AnalysisResult, IOrchestrator} from '../../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration} from '../../../agent/core/conclusionContract';
import * as finalizationContext from '../../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import * as finalizer from '../../finalizeAnalysisResult';
import {clearAllCodeAwareOutputGuards, registerCodeAwareCanary} from '../../security/codeAwareOutputRegistry';
import {CodeLookupLedger} from '../codeLookupLedger';
import {AnalysisSourceSupplementFailure, analysisSourceSupplementRuntimeSessionId,
  cancelAnalysisSourceSupplement, runAnalysisSourceSupplement} from '../analysisSourceSupplement';

let mockRevision = 1;
const mockRegistryGet = jest.fn();
const mockAssertAuthorization = jest.fn();
jest.mock('../defaultCodebaseServices', () => ({
  ...jest.requireActual('../defaultCodebaseServices'),
  getDefaultCodebaseRegistry: () => ({get: mockRegistryGet}),
}));
jest.mock('../../resolvedAnalysisContext', () => {
  const actual = jest.requireActual('../../resolvedAnalysisContext');
  const fingerprint = (selection: {knowledgeSourceIds?: string[]}) =>
    `${selection.knowledgeSourceIds?.length ? 'primary' : 'source'}-auth-${mockRevision}`;
  return {...actual, buildAnalysisContextAuthorizationFingerprint: fingerprint,
    assertCurrentAnalysisContextAuthorization: (selection: unknown, scope: unknown, expected: string) => {
      mockAssertAuthorization(selection, scope, expected);
      if (fingerprint(selection as {knowledgeSourceIds?: string[]}) !== expected) throw new Error('authorization_changed');
    }};
});

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'supplement-test'});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

function runtimeResult(sessionId: string, runId: string, options: {
  body?: string; success?: boolean; contextRunId?: string;
  completionStatus?: 'completed' | 'failed' | 'unknown';
  dispatch?: (input: unknown) => Promise<any>;
  providerQuery?: finalizationContext.FinalizationProviderQuery;
} = {}): AnalysisResult {
  const body = options.body ?? '  A bounded source supplement.\n';
  const result: AnalysisResult = {sessionId, success: options.success !== false, findings: [], hypotheses: [],
    conclusion: body, confidence: 0.4, rounds: 1, totalDurationMs: 1,
    ...(options.success === false ? {partial: true, terminationReason: 'execution_error', terminationMessage: 'Private provider failure'} as const : {}),
    conclusionContract: parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], claims: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: []}).contract};
  const candidate = {runId: options.contextRunId ?? runId, attemptId: 'native-attempt', candidateRef: 'native-candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(body)};
  finalizationContext.attachFinalizationContext(result, {runId: candidate.runId, sessionId,
    deadlineMs: Date.now() + 10_000, strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable: 'answer', evidenceAccess: 'read_new'},
    providerQuery: options.providerQuery,
    // The supplement always runs with source access, which is what requires its semantic review.
    sourceScope: {codeAwareMode: 'provider_send', selectedCodebaseIds: ['app'], hasCodebaseAccess: true,
      analysisContextFingerprint: options.providerQuery?.analysisContextFingerprint ?? 'source-auth-1'},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, runtimeKind: 'qoder-agent-sdk',
        status: options.completionStatus ?? (options.success === false ? 'failed' : 'completed'),
        ...(options.success === false ? {reason: 'provider_error'} : {})}},
    dispatchText: options.dispatch ?? (async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]}, claims: [], omissions: [], requirements: []})})),
  });
  return result;
}

function createOrchestrator() {
  const analyze = jest.fn(async (_prompt: string, sessionId: string, _traceId: string, options: AnalysisOptions) =>
    runtimeResult(sessionId, options.runId!, {providerQuery: {text: _prompt, analysisContextFingerprint: options.analysisContextFingerprint}}));
  const cleanupSession = jest.fn();
  const abortSession = jest.fn();
  return {analyze, cleanupSession, abortSession,
    orchestrator: Object.assign(new EventEmitter(), {analyze, cleanupSession, abortSession, reset: jest.fn()}) as unknown as IOrchestrator};
}

function input(fixture: ReturnType<typeof createOrchestrator>, overrides: Partial<Parameters<typeof runAnalysisSourceSupplement>[0]> = {}) {
  return {orchestrator: fixture.orchestrator, sessionId: 'session-a', runId: 'run-a', traceId: 'trace-a',
    question: '', primaryConclusion: 'Primary conclusion remains separate.',
    analysisOptions: {codeAwareMode: 'provider_send' as const, codebaseIds: ['app'], knowledgeSourceIds: ['wiki'],
      analysisContextFingerprint: 'primary-auth-1', tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'},
    ...overrides};
}

beforeEach(() => {
  mockRevision = 1;
  mockRegistryGet.mockReset().mockReturnValue({lifecycleState: 'active', consent: {sendToProvider: true}});
  mockAssertAuthorization.mockReset();
  jest.spyOn(CodeLookupLedger, 'restore').mockReturnValue({getEntries: () => []} as unknown as CodeLookupLedger);
});
afterEach(() => {jest.restoreAllMocks(); clearAllCodeAwareOutputGuards();});

describe('analysis source supplement', () => {
  it.each(['completed', 'failed', 'unknown'] as const)(
    'uses the native %s status for protocol-like answer text', async completionStatus => {
      const fixture = createOrchestrator();
      const body = '```xml\n<invoke name="example">This is documentation.</invoke>\n```';
      fixture.analyze.mockImplementationOnce(async (prompt, sessionId, _trace, options) =>
        runtimeResult(sessionId, options.runId!, {body, completionStatus,
          providerQuery: {text: prompt, analysisContextFingerprint: options.analysisContextFingerprint}}));
      const finalize = jest.spyOn(finalizer, 'finalizeAnalysisResult');
      const take = jest.spyOn(finalizationContext, 'takeFinalizationContext');
      const outcome = await runAnalysisSourceSupplement(input(fixture)).catch(error => error);
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(take).toHaveBeenCalledTimes(1);
      expect(outcome.finalResult.conclusion).toBe(body);
      expect(outcome.finalResult.completion.status).toBe(completionStatus);
      expect(outcome.finalResult.deliveryAssurance.completion).toBe(
        completionStatus === 'completed' ? 'passed' : completionStatus === 'failed' ? 'failed' : 'not_checked',
      );
      expect(() => take.mock.results[0].value!.runId).toThrow('finalization_context_disposed');
    },
  );

  it('uses the shared finalizer once and returns exactly its private-safe body without trimming', async () => {
    const fixture = createOrchestrator();
    const finalize = jest.spyOn(finalizer, 'finalizeAnalysisResult');
    const take = jest.spyOn(finalizationContext, 'takeFinalizationContext');
    const outcome = await runAnalysisSourceSupplement(input(fixture));
    expect(outcome.message).toBe(outcome.finalResult?.conclusion);
    expect(outcome.message).toBe('  A bounded source supplement.\n');
    expect(outcome.finalResult?.claimVerificationResult?.schemaVersion).toBe('claim_verifier@2');
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
    expect(fixture.analyze).toHaveBeenCalledWith(expect.any(String),
      analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'), 'trace-a', expect.objectContaining({
        analysisMode: 'fast', runId: 'run-a:analysis-source-enrichment', sourceUsePolicy: {phase: 'deep_enrichment'},
        knowledgeSourceIds: undefined, analysisContextFingerprint: 'source-auth-1', codebaseIds: ['app'],
      }));
    expect(finalize.mock.calls[0][0].owner.runId).toBe('run-a:analysis-source-enrichment');
    expect(finalize.mock.calls[0][0].owner.analysisContextFingerprint).toBe('source-auth-1');
    expect(mockAssertAuthorization).toHaveBeenCalledWith(expect.objectContaining({knowledgeSourceIds: ['wiki']}),
      expect.objectContaining({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'}), 'primary-auth-1');
    expect(() => take.mock.results[0].value!.runId).toThrow('finalization_context_disposed');
  });

  it('does not replace the product owner with a mismatching context run ID', async () => {
    const fixture = createOrchestrator();
    const dispatch = jest.fn();
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {contextRunId: 'other-run', dispatch}));
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('finalization_run_identity_mismatch');
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a finalized typed failure on the old consumers failure branch', async () => {
    const fixture = createOrchestrator();
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {success: false}));
    const failure = await runAnalysisSourceSupplement(input(fixture)).catch(error => error);
    expect(failure).toBeInstanceOf(AnalysisSourceSupplementFailure);
    expect(failure.code).toBe('analysis_source_supplement_failed');
    expect(failure.finalResult).toMatchObject({success: false, terminationReason: 'execution_error',
      claimVerificationResult: {schemaVersion: 'claim_verifier@2'}});
    expect(failure.message).not.toContain('Private provider failure');
    expect(failure.finalResult.conclusion).not.toContain('Private provider failure');
  });

  it('uses the runtime-authorized query role only with the supplement fingerprint', async () => {
    const fixture = createOrchestrator();
    const finalize = jest.spyOn(finalizer, 'finalizeAnalysisResult');
    const outcome = await runAnalysisSourceSupplement(input(fixture, {question: 'Private request to inspect source'}));
    expect(outcome.finalResult?.claimVerificationResult?.passed).toBe(true);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][0].owner.analysisContextFingerprint).toBe('source-auth-1');
  });

  it('rejects a runtime query view belonging to a different authorization pin', async () => {
    const fixture = createOrchestrator();
    const dispatch = jest.fn();
    fixture.analyze.mockImplementationOnce(async (prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {dispatch, providerQuery: {text: prompt, analysisContextFingerprint: 'different-pin'}}));
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retains incomplete coverage when protected query text has no authorized semantic view', async () => {
    registerCodeAwareCanary(analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'), 'Protected query marker');
    const fixture = createOrchestrator();
    const dispatch = jest.fn();
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {dispatch}));
    const outcome = await runAnalysisSourceSupplement(input(fixture, {question: 'Protected query marker'}));
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.finalResult).toMatchObject({
      success: true, conclusion: '  A bounded source supplement.\n', completion: {status: 'completed'},
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', passed: false,
        notCheckedReason: 'input_projection_incomplete'},
    });
    expect(outcome.message).toBe(outcome.finalResult?.conclusion);
  });

  it.each(['consent', 'missing', 'deleting', 'fingerprint'] as const)('rejects %s before native work or cleanup', async condition => {
    const fixture = createOrchestrator();
    if (condition === 'consent') mockRegistryGet.mockReturnValue({consent: {sendToProvider: false}});
    if (condition === 'missing') mockRegistryGet.mockReturnValue(undefined);
    if (condition === 'deleting') mockRegistryGet.mockReturnValue({lifecycleState: 'deleting', consent: {sendToProvider: true}});
    if (condition === 'fingerprint') mockRevision = 2;
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow();
    expect(fixture.analyze).not.toHaveBeenCalled();
    expect(fixture.abortSession).not.toHaveBeenCalled();
    expect(fixture.cleanupSession).not.toHaveBeenCalled();
  });

  it('disposes a late native context after cancel and reserves the runtime identity until it arrives', async () => {
    const fixture = createOrchestrator();
    const started = deferred<void>();
    const late = deferred<AnalysisResult>();
    const take = jest.spyOn(finalizationContext, 'takeFinalizationContext');
    fixture.analyze.mockImplementationOnce(async () => {started.resolve(); return late.promise;});
    const run = runAnalysisSourceSupplement(input(fixture));
    const rejected = expect(run).rejects.toMatchObject({name: 'AbortError'});
    await started.promise;
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    await rejected;
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    late.resolve(runtimeResult(analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'), 'run-a:analysis-source-enrichment'));
    await new Promise(resolve => setImmediate(resolve));
    expect(take).toHaveBeenCalledTimes(1);
    expect(() => take.mock.results[0].value!.runId).toThrow('finalization_context_disposed');
    expect(fixture.analyze).toHaveBeenCalledTimes(1);
  });

  it('keeps the runtime identity reserved while its cleanup is still pending', async () => {
    const fixture = createOrchestrator();
    const cleaning = deferred<void>();
    const releaseCleanup = deferred<void>();
    fixture.cleanupSession.mockImplementationOnce(() => {cleaning.resolve(); return releaseCleanup.promise;});
    const run = runAnalysisSourceSupplement(input(fixture));
    await cleaning.promise;
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    expect(fixture.analyze).toHaveBeenCalledTimes(1);
    releaseCleanup.resolve();
    await run;
  });

  it('does not reuse a runtime identity while an already-started abort is still pending', async () => {
    const fixture = createOrchestrator();
    const started = deferred<void>();
    const late = deferred<AnalysisResult>();
    const releaseAbort = deferred<void>();
    fixture.analyze.mockImplementationOnce(async () => {started.resolve(); return late.promise;});
    fixture.abortSession.mockReturnValueOnce(releaseAbort.promise);
    const run = runAnalysisSourceSupplement(input(fixture));
    const rejected = expect(run).rejects.toMatchObject({name: 'AbortError'});
    await started.promise;
    const cancellation = cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    await rejected;
    late.resolve(runtimeResult(analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'), 'run-a:analysis-source-enrichment'));
    await new Promise(resolve => setImmediate(resolve));
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    expect(fixture.analyze).toHaveBeenCalledTimes(1);
    releaseAbort.resolve();
    await cancellation;
  });

  it('returns a completed supplement without waiting for SDK cleanup and keeps its identity reserved', async () => {
    const fixture = createOrchestrator();
    const cleanup = deferred<void>();
    fixture.cleanupSession.mockReturnValueOnce(cleanup.promise);
    const outcome = await runAnalysisSourceSupplement(input(fixture));
    expect(outcome.finalResult?.success).toBe(true);
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    cleanup.resolve();
  });

  it.each(['parent_signal', 'authorization'] as const)('does not wait for cleanup or commit after %s changes during finalization', async condition => {
    const fixture = createOrchestrator();
    const started = deferred<void>();
    const semantic = deferred<any>();
    const cleanup = deferred<void>();
    const abort = deferred<void>();
    const controller = new AbortController();
    fixture.cleanupSession.mockReturnValueOnce(cleanup.promise);
    fixture.abortSession.mockReturnValueOnce(abort.promise);
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) => runtimeResult(sessionId, options.runId!, {
      dispatch: async () => {started.resolve(); return semantic.promise;},
    }));
    const run = runAnalysisSourceSupplement(input(fixture, {signal: controller.signal}));
    const rejected = expect(run).rejects.toThrow();
    await started.promise;
    if (condition === 'parent_signal') controller.abort();
    else {
      mockRevision = 2;
      semantic.resolve({status: 'unavailable', reason: 'provider_error'});
    }
    await rejected;
    // Stop acknowledges the controller transition even when both SDK methods hang.
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    expect(fixture.cleanupSession).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    abort.resolve();
    semantic.resolve({status: 'unavailable', reason: 'provider_error'});
  });

  it('preserves plain XML through the shared finalizer and disposes its context', async () => {
    const fixture = createOrchestrator();
    const take = jest.spyOn(finalizationContext, 'takeFinalizationContext');
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {body: '<tool_call>opaque protocol</tool_call>'}));
    const outcome = await runAnalysisSourceSupplement(input(fixture));
    expect(outcome.message).toBe('<tool_call>opaque protocol</tool_call>');
    expect(take).toHaveBeenCalledTimes(1);
    expect(() => take.mock.results[0].value!.runId).toThrow('finalization_context_disposed');
  });

  it('cancels the final semantic operation as well as the native runtime', async () => {
    const fixture = createOrchestrator();
    const started = deferred<void>();
    const late = deferred<any>();
    const dispatch = jest.fn(async () => {started.resolve(); return late.promise;});
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) =>
      runtimeResult(sessionId, options.runId!, {dispatch}));
    const run = runAnalysisSourceSupplement(input(fixture));
    const rejected = expect(run).rejects.toMatchObject({name: 'AbortError'});
    await started.promise;
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    await rejected;
    late.resolve({status: 'unavailable', reason: 'provider_error'});
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.abortSession).toHaveBeenCalledTimes(1);
  });

  it.each(['authorization', 'parent_current', 'parent_signal'] as const)('blocks commit when %s changes during semantic review', async change => {
    const fixture = createOrchestrator();
    const controller = new AbortController();
    let current = true;
    fixture.analyze.mockImplementationOnce(async (_prompt, sessionId, _trace, options) => runtimeResult(sessionId, options.runId!, {
      dispatch: async () => {
        if (change === 'authorization') mockRevision = 2;
        if (change === 'parent_current') current = false;
        if (change === 'parent_signal') controller.abort();
        return {status: 'unavailable', reason: 'provider_error'};
      },
    }));
    await expect(runAnalysisSourceSupplement(input(fixture, {signal: controller.signal, isCurrent: () => current}))).rejects.toThrow();
  });

  it('rejects a duplicate without aborting the running entry and supersedes only a different product run', async () => {
    const fixture = createOrchestrator();
    const started = deferred<void>();
    const late = deferred<AnalysisResult>();
    fixture.analyze.mockImplementationOnce(async () => {started.resolve(); return late.promise;});
    const first = runAnalysisSourceSupplement(input(fixture));
    const rejected = expect(first).rejects.toMatchObject({name: 'AbortError'});
    await started.promise;
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    expect(fixture.abortSession).not.toHaveBeenCalled();
    expect(fixture.cleanupSession).not.toHaveBeenCalled();
    const second = await runAnalysisSourceSupplement(input(fixture, {runId: 'run-b'}));
    await rejected;
    expect(second.finalResult?.sessionId).toBe(analysisSourceSupplementRuntimeSessionId('session-a', 'run-b'));
    late.resolve(runtimeResult(analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'), 'run-a:analysis-source-enrichment'));
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.abortSession).toHaveBeenCalledWith(analysisSourceSupplementRuntimeSessionId('session-a', 'run-a'));
  });

  it('reserves a legacy cancellation identity until its outstanding SDK mutations finish', async () => {
    const fixture = createOrchestrator();
    const abort = deferred<void>();
    const cleanup = deferred<void>();
    fixture.abortSession.mockReturnValueOnce(abort.promise);
    fixture.cleanupSession.mockReturnValueOnce(cleanup.promise);
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    await expect(runAnalysisSourceSupplement(input(fixture))).rejects.toThrow('analysis_source_supplement_already_running');
    expect(fixture.analyze).not.toHaveBeenCalled();
    abort.resolve();
    cleanup.resolve();
  });

  it('aborts and cleans only the detached source runtime session when no active helper owns it', async () => {
    const fixture = createOrchestrator();
    await cancelAnalysisSourceSupplement(fixture.orchestrator, 'session-a', 'run-a');
    const runtimeSessionId = analysisSourceSupplementRuntimeSessionId('session-a', 'run-a');
    expect(fixture.abortSession).toHaveBeenCalledWith(runtimeSessionId);
    expect(fixture.cleanupSession).toHaveBeenCalledWith(runtimeSessionId);
  });
});
