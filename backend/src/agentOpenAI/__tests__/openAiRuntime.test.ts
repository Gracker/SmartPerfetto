// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {MaxTurnsExceededError, OpenAIChatCompletionsModel, OpenAIProvider, Runner, RunContext, tool, withTrace} from '@openai/agents';
import {z} from 'zod';
import {OpenAIRuntime, __testing} from '../openAiRuntime';
import type {AnalysisPlanV3, PlanPhase} from '../../agentv3/types';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import type {OpenAIAgentConfig} from '../../agentRuntime/engines/openai/openAiConfig';
import * as finalization from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {projectPrivateAnalysisResult, projectPrivateTerminationMessage} from '../../services/security/privateAnalysisProjection';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import * as sourceProjection from '../../services/codebase/sourceClaimVerifier';
import {
  clearCodeAwareOutputGuards, createCodeAwareStreamingTextProjection,
  registerCodeAwareCanary, revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import * as verifier from '../../agentRuntime/engines/claude/claudeVerifier';
import * as patternMemory from '../../agentv3/analysisPatternMemory';
import * as configModule from '../../agentRuntime/engines/openai/openAiConfig';
import * as intentTransport from '../../agentRuntime/engines/openai/openAiIntentTransport';
import type {AnalysisTurnIntentDecision} from '../../agentRuntime/analysisTurnIntent';
import * as systemPrompt from '../../agentv3/claudeSystemPrompt';
import * as focusDetector from '../../agentv3/focusAppDetector';
import * as mcpModule from '../../agentv3/claudeMcpServer';
import {getSourceLookupCodeReferences} from '../../services/codebase/sourceLookupTools';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import * as localizedStrategyTemplate from '../../agentv3/localizedStrategyTemplate';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createAnalysisHistoryReader, toAnalysisHistoryTurn, withAnalysisHistoryReader} from '../../agentRuntime/analysisHistory';
import {applyFinalResultQualityGate} from '../../services/finalResultQualityGate';
import {createRuntimeSourceFinalizationFixture, SOURCE_FINALIZATION_CANARY, SOURCE_FINALIZATION_RAW_SOURCE} from '../../agentRuntime/__tests__/sourceFinalizationFixture';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';

const runtimes: OpenAIRuntime[] = [];
const privacySessions: string[] = [];
const finalizationContexts: finalization.RuntimeFinalizationContext[] = [];
const decision: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'fact', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new',
};
function createOpenAiConfigForTest(): OpenAIAgentConfig {
  return {model: 'pinned-primary', lightModel: 'pinned-light', apiKey: 'test-only',
    baseURL: 'https://provider.invalid/v1', protocol: 'responses', cwd: process.cwd(),
    maxOutputTokens: 1024, maxTurns: 3, quickMaxTurns: 2, quickTargetTurns: 1,
    fullPathPerTurnMs: 60_000, fullRequestTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
    maxRunTimeoutMs: 120_000, maxHistoryBytes: 4 * 1024 * 1024, quickPathPerTurnMs: 30_000,
    classifierTimeoutMs: 10_000, outputLanguage: 'zh-CN'};
}
function classify(value: AnalysisTurnIntentDecision = decision) {
  jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({
    status: 'ok', text: JSON.stringify(value), actualModel: 'pinned-light', finishReason: 'stop',
  });
}
beforeEach(() => {
  jest.spyOn(configModule, 'loadOpenAIConfig').mockReturnValue(createOpenAiConfigForTest());
  jest.spyOn(intentTransport, 'runOpenAiIntentTransport');
  classify();
});
afterEach(() => {
  for (const context of finalizationContexts.splice(0)) context.dispose();
  for (const runtime of runtimes.splice(0)) runtime.reset();
  for (const sessionId of privacySessions.splice(0)) clearCodeAwareOutputGuards(sessionId);
  jest.restoreAllMocks();
});
function createOpenAiRuntimeForTest(trace?: TraceProcessorService): any {
  const runtime = new OpenAIRuntime(trace ?? {query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})), getTrace: jest.fn()} as unknown as TraceProcessorService);
  runtimes.push(runtime);
  jest.spyOn(runtime as any, 'recordPatternMemory').mockImplementation(() => undefined);
  return runtime;
}
function createRuntimeWithUpdates() {
  const runtime = createOpenAiRuntimeForTest();
  const updates: any[] = [];
  runtime.on('update', (update: any) => updates.push(update));
  return {runtime, updates};
}
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {resolve = res; reject = rej;});
  return {promise, resolve, reject};
}
function prepareStub(runtime: any, sourceUse?: unknown) {
  return jest.spyOn(runtime, 'prepareAnalysisContext').mockImplementation(async (...args: any[]) => ({
    systemPrompt: 'test system prompt', tools: [], allowedTools: [],
    sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns,
    hypotheses: [], sessionMapKey: args[4].analysisRunSpec.identity.sessionMapKey, sourceUse,
  }));
}
function responseDone(text: string, status = 'completed') {
  return {type: 'raw_model_stream_event', data: {type: 'response_done', response: {
    output: [{type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]}],
    providerData: {status, ...(status === 'incomplete' ? {incomplete_details: {reason: 'max_output_tokens'}} : {})},
  }}};
}
function sdkStream(text: string, {status = 'completed', nativeText = text, id = 'response-current', events = [] as any[]} = {}) {
  return {currentTurn: 1, finalOutput: text, history: [{role: 'assistant', content: text}], lastResponseId: id,
    state: {}, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
      yield* events;
      yield responseDone(nativeText, status);
    }};
}
function mockRun(stream: unknown = sdkStream('回答已完成')) {
  return jest.spyOn(Runner.prototype as any, 'run').mockResolvedValue(stream);
}
function phase(id: string, status: PlanPhase['status']): PlanPhase {
  return {id, name: `Phase ${id}`, goal: `Goal ${id}`, expectedTools: ['invoke_skill'], status,
    ...(['completed', 'skipped'].includes(status) ? {summary: `Evidence summary for ${id}`} : {})};
}
function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {phases, successCriteria: 'Evidence is sufficient', submittedAt: Date.now(), toolCallLog: []};
}
function streamContext(sessionId: string, quickMode: boolean) {
  return {sessionId, quickMode, answerStreamFilter: __testing.createOpenAiReasoningFilterState(),
    toolInputsByTaskId: new Map<string, {toolName: string; args: Record<string, unknown>}>()};
}

describe('OpenAI typed intent integration', () => {
  it.each([false, true])('scene runtime matrix: OpenAI shared proposal survives provider failure=%s', async providerFailed => {
    const f = createSceneRuntimeMatrixFixture('openai');
    const runtime = createOpenAiRuntimeForTest(f.traceProcessorService);
    let sceneTool: any;
    let response: unknown;
    jest.spyOn(Runner.prototype as any, 'run').mockImplementation(async (agent: any) => {
      expect(agent.model).toBe('pinned-primary');
      sceneTool = agent.tools.find((item: any) => item.name === 'propose_scene_timeline');
      response = await sceneTool.invoke(new RunContext(), JSON.stringify(f.proposal()));
      if (providerFailed) throw new Error('Mock provider failed after its accepted scene proposal');
      return sdkStream('Scene candidates submitted.');
    });
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(result.turnIntent).toMatchObject({source: 'product', sceneId: 'scene_reconstruction'});
      expect(intentTransport.runOpenAiIntentTransport).not.toHaveBeenCalled();
      if (providerFailed) expect(result.partial).toBe(true);
      expect(JSON.stringify(response)).toContain('accepted');
      const snapshot = f.seal();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.runId).toBe(f.scope.runId);
      expect(snapshot.segments[0].evidence[0].source.originRunId).toBe(f.scope.runId);
      expect(f.boundsQueries).toEqual([f.scope.traceId]);
      f.controller.abort();
      const late = await sceneTool.invoke(new RunContext(), JSON.stringify(f.proposal())).catch((error: Error) => ({error: error.message}));
      expect(JSON.stringify(late)).not.toContain('"accepted":true');
    } finally {runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
    expect(runtime.artifactStores.has(f.scope.sessionId)).toBe(false);
  });
  it.each(['fast', 'full', 'auto'] as const)('classifies %s once and keeps bounded answers independent of report shape', async analysisMode => {
    const runtime = createOpenAiRuntimeForTest();
    const prepare = prepareStub(runtime);
    const answer = 'provider error 是本次日志中的字段值，当前回答没有标题或句号';
    const run = mockRun(sdkStream(answer));
    const result = await runtime.analyze('任意不参与控制流的问法', `typed-${analysisMode}`, 'trace', {analysisMode, providerId: null});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledWith(expect.objectContaining({purpose: 'classification', maxOutputTokens: 1024}));
    expect(prepare.mock.calls[0][4]).toMatchObject({policy: {onDemandContext: true, preflight: 'trace_facts',
      allowAutomaticPrefetch: false, requiresReport: false}, turnIntent: decision});
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as any).model).toBe(analysisMode === 'full' ? 'pinned-primary' : 'pinned-light');
    expect(run.mock.calls[0][2]).toMatchObject({maxTurns: analysisMode === 'full' ? 2 : 1});
    expect(result.conclusion).toBe(answer);
    expect(result.completion).toMatchObject({status: 'completed', sdkFinishReason: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(answer)});
    expect(result.partial).toBeUndefined();
  });
  it('uses the configured primary after malformed light output without widening automatic evidence', async () => {
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({status: 'ok', text: 'not a decision'});
    const runtime = createOpenAiRuntimeForTest();
    const prepare = prepareStub(runtime); const run = mockRun();
    const result = await runtime.analyze('query', 'malformed', 'trace', {analysisMode: 'auto', providerId: null});
    expect(result.turnIntent).toMatchObject({status: 'unavailable', unavailableReason: 'invalid_response'});
    expect(prepare.mock.calls[0][4]).toMatchObject({policy: {budgetMode: 'quick', onDemandContext: true,
      preflight: 'trace_facts', allowAutomaticPrefetch: false}});
    expect((run.mock.calls[0][0] as any).model).toBe('pinned-primary');
    expect(run.mock.calls[0][2]).toMatchObject({maxTurns: 1});
    expect(result.quickRun.modeDecision).toBe('ai_unavailable');
  });
  it('passes the pinned provider auth and protocol to native classification', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    await runtime.analyze('query', 'pin', 'trace', {analysisMode: 'full', providerId: null});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({protocol: 'responses', baseURL: 'https://provider.invalid/v1', apiKey: 'test-only', lightModel: 'pinned-light'}),
      signal: expect.any(AbortSignal),
    }));
  });
  // A bounded comparison reads the trace facts it is about; what a quick
  // budget and a bounded scope skip is the scene-wide memory tier.
  it('keeps reference and RAG capabilities in explicit fast mode with trace-fact preflight only', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, taskKind: 'comparison'});
    const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const focus = jest.spyOn(focusDetector, 'detectFocusApps');
    const architecture = jest.spyOn(runtime, 'detectArchitecture');
    const vendor = jest.spyOn(runtime, 'detectVendor');
    const completeness = jest.spyOn(runtime, 'detectCompleteness');
    const run = mockRun();
    const result = await runtime.analyze('compare selected facts', 'fast-pair', 'current', {
      analysisMode: 'fast', providerId: null, referenceTraceId: 'reference', knowledgeSourceIds: ['kb-a'],
    });
    expect(result.quickRun.requestedMode).toBe('fast');
    expect(focus).toHaveBeenCalled(); expect(architecture).toHaveBeenCalled();
    expect(vendor).toHaveBeenCalled(); expect(completeness).toHaveBeenCalled();
    expect(prompt.mock.calls[0][0].knowledgeBaseContext).toBeUndefined();
    expect(mcp.mock.calls[0][0]).toMatchObject({referenceTraceId: 'reference', knowledgeSourceIds: ['kb-a'], allowNewEvidence: true,
      comparisonContext: {referenceTraceId: 'reference', capabilityProbeStatus: 'not_checked'}});
    expect(prompt.mock.calls[0][0]).toMatchObject({turnIntent: {taskKind: 'comparison'}, onDemandContext: true,
      comparison: {referenceTraceId: 'reference', capabilityProbeStatus: 'not_checked'}});
    const toolNames = (run.mock.calls[0][0] as any).tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('fetch_artifact');
    expect(toolNames).toContain('execute_sql');
    expect(toolNames).toEqual((mcp.mock.results[0].value as any).toolDefinitions.map((tool: any) => tool.name));
  });
  // SP-CP-11: the effective package carries its provenance into the prompt
  // and the tools; an ambiguous detection puts no package in effect at all.
  it.each([
    ['confident', {method: 'oom_adj', confidence: 'medium', primaryApp: 'com.tracedemo.stress',
      apps: [{packageName: 'com.tracedemo.stress', totalDurationNs: 1, switchCount: 1, score: 19}]},
      'com.tracedemo.stress', 'auto_detected'],
    ['ambiguous', {method: 'oom_adj', confidence: 'ambiguous', apps: [
      {packageName: 'com.example.a', totalDurationNs: 5, switchCount: 1, score: 25},
      {packageName: 'com.example.b', totalDurationNs: 4, switchCount: 1, score: 24}]},
      undefined, 'none'],
  ] as const)('scopes tools and prompt to the %s focus target only through its provenance',
    async (_label, focusResult, expectedPackage, expectedSource) => {
      const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
      const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
      classify(decision);
      const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
      const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
      jest.spyOn(focusDetector, 'detectFocusApps').mockResolvedValue(structuredClone(focusResult) as any);
      const architecture = jest.spyOn(runtime, 'detectArchitecture').mockResolvedValue(undefined);
      jest.spyOn(runtime, 'detectVendor').mockResolvedValue(null);
      jest.spyOn(runtime, 'detectCompleteness').mockResolvedValue(undefined);
      mockRun();
      await runtime.analyze('why is it slow', `focus-${_label}`, 'trace', {analysisMode: 'full', providerId: null});

      expect(mcp.mock.calls[0][0].packageName).toBe(expectedPackage);
      expect(mcp.mock.calls[0][0].focusTarget).toMatchObject({source: expectedSource});
      expect(architecture).toHaveBeenCalledWith('trace', expectedPackage);
      expect(prompt.mock.calls[0][0]).toMatchObject({packageName: expectedPackage,
        focusTarget: {source: expectedSource, confidence: focusResult.confidence}});
    });
  it('preserves existing-artifact access while existing_only forbids all automatic collection', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, evidenceAccess: 'existing_only'});
    jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer'); const run = mockRun();
    await runtime.analyze('use prior facts', 'existing', 'trace', {analysisMode: 'full', providerId: null, referenceTraceId: 'reference'});
    expect(query).not.toHaveBeenCalled();
    expect(mcp.mock.calls[0][0]).toMatchObject({allowNewEvidence: false, analysisPlan: {current: null}});
    const names = (run.mock.calls[0][0] as any).tools.map((tool: any) => tool.name);
    expect(names).toContain('fetch_artifact'); expect(names).not.toContain('execute_sql');
    expect(names).toEqual((mcp.mock.results[0].value as any).toolDefinitions.map((tool: any) => tool.name));
  });
  it('does not prefetch without an attached trace even for a scene-wide Conversation intent', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, taskKind: 'investigation', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report'});
    jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const focus = jest.spyOn(focusDetector, 'detectFocusApps');
    const architecture = jest.spyOn(runtime, 'detectArchitecture');
    const vendor = jest.spyOn(runtime, 'detectVendor');
    const completeness = jest.spyOn(runtime, 'detectCompleteness');
    const run = mockRun();
    const result = await runtime.analyze('question without trace', 'no-trace-conversation', 'no-trace', {
      assistantSurface: 'conversation', conversationTraceAttached: false, analysisMode: 'full', providerId: null,
    });
    expect(query).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(architecture).not.toHaveBeenCalled(); expect(vendor).not.toHaveBeenCalled(); expect(completeness).not.toHaveBeenCalled();
    expect(mcp.mock.calls[0][0]).toMatchObject({conversationTraceAttached: false, allowNewEvidence: true});
    expect(run).toHaveBeenCalledTimes(1); expect(result.completion.status).toBe('completed');
  });
  it('does not let native success from another body certify the accepted final candidate', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('current answer', {nativeText: 'old answer'}));
    const result = await runtime.analyze('query', 'mismatch', 'trace', {providerId: null});
    expect(result.completion).toMatchObject({status: 'unknown', conclusionFingerprint: analysisDeliveryFingerprint('current answer')});
    expect(result.partial).toBe(true);
  });
  it('uses native incomplete output even when the body has every report heading', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('## Final Report\n## Evidence\n## Conclusion', {status: 'incomplete'}));
    const result = await runtime.analyze('query', 'native-incomplete', 'trace', {providerId: null});
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit'});
    expect(result.partial).toBe(true);
  });
  it('does not freeze draft evidence diagnostics before shared finalization', async () => {
    const contract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'count-claim', text: 'The observed count is 7', kind: 'numeric', references: [{
        evidenceRefId: 'ev_count', rowIndex: 0, column: 'count', value: 7,
      }]}], uncertainties: [], nextSteps: []};
    const body = JSON.stringify(contract);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(body));
    jest.spyOn(verifier, 'verifyConclusion').mockResolvedValue({passed: false, durationMs: 1,
      heuristicIssues: [{type: 'missing_evidence', severity: 'error', message: 'Contract extraction is pending'}]});
    const result = await runtime.analyze('query', 'draft-diagnostic', 'trace', {providerId: null});
    expect(result.completion.status).toBe('completed');
    expect(result.partial).toBeUndefined(); expect(result.terminationReason).toBeUndefined();
    expect(result.conclusion).toBe(body);
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.deliveryAssurance?.claims).not.toBe('passed');
    const context = finalization.takeFinalizationContext(result);
    if (context) finalizationContexts.push(context);
    expect(context?.deliveryContext.entry).toBe('runtime_draft');
    expect(context?.hasSemanticTransport).toBe(true);
    // Actual evidence and semantic assurance belong to the shared finalization suite.
  });
  it('binds each accepted turn to its own attempt and current content', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockResolvedValueOnce(sdkStream('first')).mockResolvedValueOnce(sdkStream('second'));
    const first = await runtime.analyze('first request', 'multi-turn', 'trace', {providerId: null, runId: 'run-1'});
    const second = await runtime.analyze('follow-up', 'multi-turn', 'trace', {providerId: null, runId: 'run-2'});
    expect(first.completion.runId).toBe('run-1'); expect(second.completion.runId).toBe('run-2');
    expect(first.completion.attemptId).not.toBe(second.completion.attemptId);
    expect(second.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint('second'));
  });
});

describe('OpenAI native Chat completion boundary', () => {
  it.each(['stop', 'length'] as const)('retains native %s through the actual Agents SDK stream', async finishReason => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions', quickMaxTurns: 1});
    const payloads = [
      {id: 'chat-current', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {role: 'assistant', content: 'protocol body'}, finish_reason: null}]},
      {id: 'chat-current', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {}, finish_reason: finishReason}]},
    ];
    const wire = payloads.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
    const nativeFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wire, {headers: {'content-type': 'text/event-stream'}}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const result = await runtime.analyze('query', `chat-${finishReason}`, 'trace', {providerId: null});
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toBe('protocol body');
    expect(result.completion).toMatchObject({status: finishReason === 'stop' ? 'completed' : 'incomplete', sdkFinishReason: finishReason});
    expect(result.completion.reason).toBe(finishReason === 'length' ? 'output_limit' : undefined);
  });
  it.each([
    {name: 'unclosed EOF terminal frame', ending: 'eof'},
    {name: 'content after finish', ending: 'content'},
    {name: 'refusal after finish', ending: 'refusal'},
    {name: 'tool call after finish', ending: 'tool'},
    {name: 'different response ID in the same HTTP response', ending: 'changed_id'},
    {name: 'reused response ID around an intervening response', ending: 'reused_id'},
  ])('rejects $name through the actual Agents SDK stream', async ({ending}) => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions'});
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, id = 'chat-current') => ({
      id, object: 'chat.completion.chunk', created: 1, model: 'pinned-light',
      choices: [{index: 0, delta, finish_reason: finish}],
    });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    let wire = frame(chunk({role: 'assistant', content: 'protocol body'}));
    if (ending === 'eof') {
      // The SDK never receives this unfinished event, despite valid JSON in the bytes.
      wire += `data: ${JSON.stringify(chunk({}, 'stop'))}`;
    } else if (ending === 'changed_id') {
      wire += frame(chunk({}, 'stop', 'chat-other'));
    } else if (ending === 'reused_id') {
      wire += frame(chunk({content: 'intervening'}, null, 'chat-other')) + frame(chunk({}, 'stop'));
    } else {
      wire += frame(chunk({}, 'stop'));
      const delta = ending === 'content' ? {content: 'new content'} : ending === 'refusal'
        ? {refusal: 'new refusal'}
        : {tool_calls: [{index: 0, id: 'late-call', type: 'function', function: {name: 'unregistered_tool', arguments: '{}'}}]};
      wire += frame(chunk(delta));
    }
    if (ending !== 'eof') wire += 'data: [DONE]\n\n';
    const nativeFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wire, {headers: {'content-type': 'text/event-stream'}}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const result = await runtime.analyze('query', `invalid-chat-${ending}`, 'trace', {providerId: null});
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(result.completion.status).not.toBe('completed');
    expect(result.partial).toBe(true);
    if (ending === 'eof') {
      expect(result.conclusion).toBe('protocol body');
      expect(result.completion.sdkFinishReason).toBeUndefined();
    }
  });
  it('forwards SSE bytes unchanged while parsing split protocol frames', async () => {
    const wire = 'data: {"id":"chat-wire","choices":[{"index":0,"finish_reason":"length","delta":{}}]}\r\n\r\ndata: [DONE]\n\n';
    const encoder = new TextEncoder(); let terminal: any;
    const wrapped = __testing.createOpenAiTerminalFetch(jest.fn<typeof fetch>(async () => new Response(new ReadableStream({start(controller) {
      for (const piece of [wire.slice(0, 17), wire.slice(17, 49), wire.slice(49)]) controller.enqueue(encoder.encode(piece)); controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}})), value => {terminal = value;});
    const response = await wrapped('https://provider.invalid/v1/chat/completions');
    expect(await response.text()).toBe(wire); expect(terminal).toEqual({responseId: 'chat-wire', finishReason: 'length'});
  });
});

describe('OpenAI cancellation and bounded recovery', () => {
  it('cancels during classification before context preparation or provider execution', async () => {
    const entered = createDeferred<void>();
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockImplementation(input => new Promise((_resolve, reject) => {
      entered.resolve(); input.signal!.addEventListener('abort', () => reject(input.signal!.reason), {once: true});
    }));
    const runtime = createOpenAiRuntimeForTest(); const prepare = prepareStub(runtime); const run = mockRun();
    const pending = runtime.analyze('query', 'cancel-classify', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession('cancel-classify'); await rejected;
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it('ignores late tool results from an already cancelled stream', async () => {
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun({currentTurn: 1, finalOutput: 'late', history: [], completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      entered.resolve(); await release.promise;
      yield {type: 'run_item_stream_event', name: 'tool_output', item: {rawItem: {callId: 'late', output: '{"success":true}'}}};
    }});
    const pending = runtime.analyze('query', 'cancel-late', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession('cancel-late'); release.resolve(); await rejected;
    expect(updates.filter(update => update.type === 'agent_response')).toHaveLength(0);
  });
  it('rejects same-session overlap while allowing different sessions to proceed', async () => {
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockImplementationOnce(async () => {entered.resolve(); await release.promise; return sdkStream('first');});
    const first = runtime.analyze('query', 'overlap', 'trace', {providerId: null}); await entered.promise;
    await expect(runtime.analyze('other', 'overlap', 'other', {providerId: null})).rejects.toThrow();
    expect((await runtime.analyze('parallel', 'independent', 'trace', {providerId: null})).success).toBe(true);
    release.resolve(); expect((await first).success).toBe(true);
  });
  it('cancels immediately even when provider creation ignores its abort signal', async () => {
    const entered = createDeferred<void>();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun().mockImplementation(() => {entered.resolve(); return new Promise(() => undefined);});
    const pending = runtime.analyze('query', 'cancel-stalled-provider', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise;
    runtime.abortSession('cancel-stalled-provider'); await rejected;
  });
  it('counts the single failed closeout attempt after a native turn cap', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValue(new MaxTurnsExceededError('native turn cap'));
    const result = await runtime.analyze('query', 'native-turn-cap', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({partial: true, rounds: 2, terminationReason: 'max_turns', completion: {status: 'incomplete', reason: 'turn_limit'}});
  });
  it('returns a candidate-bound timeout without re-entering the provider', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), streamIdleTimeoutMs: 10});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockImplementation(() => new Promise(() => undefined));
    const result = await runtime.analyze('query', 'timeout', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1); expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
    expect(result.conclusion).toBe(''); expect(result.partial).toBe(true);
  });

  describe('run budget on a slow but producing endpoint (Round 60 SP-E2E-08)', () => {
    // base budget 100 ms × 3 turns = 300 ms; maximum 3 s; delivery reserve 500 ms
    const slowConfig = () => ({...createOpenAiConfigForTest(), quickPathPerTurnMs: 100, quickMaxTurns: 3,
      maxRunTimeoutMs: 3_000, streamIdleTimeoutMs: 60_000});
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const toolOutput = (callId: string) => ({type: 'run_item_stream_event', name: 'tool_output',
      item: {rawItem: {callId, name: 'execute_sql', output: '{"success":true}'}}});
    const hang = () => new Promise<never>(() => undefined);
    function streamOf(events: () => AsyncGenerator<any>, text = '') {
      return {currentTurn: 1, finalOutput: text, history: [{role: 'assistant', content: text}], lastResponseId: 'slow',
        state: {}, completed: Promise.resolve(), [Symbol.asyncIterator]: events};
    }
    function prepareWithReturnedData(runtime: any) {
      return prepareStub(runtime).mockImplementation(async (...args: any[]) => {
        const invocation = {toolCallId: 'slow-sql', toolName: 'execute_sql', params: {}, extra: {}};
        await args[4].toolObserver({...invocation, phase: 'started'});
        await args[4].toolObserver({...invocation, phase: 'completed', result: {
          content: [{type: 'text', text: JSON.stringify({columns: ['dur'], rows: [[195]], success: true})}]}});
        return {systemPrompt: 'test system prompt', tools: [], allowedTools: [], hypotheses: [],
          sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns,
          sessionMapKey: args[4].analysisRunSpec.identity.sessionMapKey};
      });
    }
    const budgetLine = (warn: jest.SpiedFunction<typeof console.warn>) =>
      warn.mock.calls.map(call => String(call[0])).find(line => line.startsWith('[OpenAIRuntime] run budget:')) ?? '';

    it('keeps investigating past the base budget while tool results keep returning', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun(streamOf(async function* () {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        for (let i = 0; i < 4; i++) { await sleep(150); yield toolOutput(`slow-${i}`); }
        yield responseDone('slow answer');
      }, 'slow answer'));
      const result = await runtime.analyze('query', 'slow-progress', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.completion).toMatchObject({status: 'completed'});
      expect(result.conclusion).toBe('slow answer');
      expect(budgetLine(warn)).toMatch(/progressExtensions=[1-9].*timeoutDelivery=not_needed/);
    });

    it('extends at the deadline while the provider is still writing output', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun(streamOf(async function* () {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        for (let i = 0; i < 10; i++) {
          await sleep(60);
          yield {type: 'raw_model_stream_event', data: {type: 'model', event: {choices: [{index: 0, delta: {reasoning_content: 'thinking'}}]}}};
        }
        yield responseDone('long final answer');
      }, 'long final answer'));
      const result = await runtime.analyze('query', 'slow-output', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.completion).toMatchObject({status: 'completed'});
    });

    it('lets a completed report spend the remaining budget on its semantic review', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      classify({...decision, taskKind: 'investigation', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report'});
      mockRun(sdkStream('Report body.'));
      const startedAt = Date.now();
      const result = await runtime.analyze('query', 'report-budget', 'trace', {analysisMode: 'fast', providerId: null});
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      expect(result.turnIntent).toMatchObject({status: 'resolved', deliverable: 'report'});
      expect(result.completion.status).toBe('completed');
      expect(context.hasSemanticTransport).toBe(true);
      // up to hard (3 s), not the 500 ms delivery reserve
      expect(context.deadlineMs).toBeGreaterThanOrEqual(startedAt + 3_000);
      expect(context.deadlineMs).toBeLessThanOrEqual(Date.now() + 3_000);
    });

    it('keeps a completed answer within the delivery reserve for its review', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      classify({...decision, deliverable: 'answer'});
      mockRun(sdkStream('Short answer.'));
      const startedAt = Date.now();
      const result = await runtime.analyze('query', 'answer-budget', 'trace', {analysisMode: 'fast', providerId: null});
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      expect(result.turnIntent).toMatchObject({deliverable: 'answer'});
      expect(result.completion.status).toBe('completed');
      expect(context.deadlineMs).toBeLessThan(startedAt + 3_000);
    });

    it('delivers a limited answer from returned data when the budget runs out', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareWithReturnedData(runtime);
      const run = mockRun().mockResolvedValueOnce(streamOf(async function* () {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield toolOutput('slow-0');
        await hang();
      }) as any).mockResolvedValueOnce(sdkStream('Main thread waited 195 ms; the owner is not established.'));
      const startedAt = Date.now();
      const result = await runtime.analyze('query', 'timeout-delivery', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(2);
      expect((run.mock.calls[1][0] as any).tools).toEqual([]);
      expect(run.mock.calls[1][2]).toMatchObject({maxTurns: 1});
      expect(run.mock.calls[1][2]).not.toHaveProperty('previousResponseId');
      const prompt = (run.mock.calls[1][1] as any[])[0].content;
      expect(prompt).toContain('本轮调查已耗尽预算（timeout：');
      expect(prompt).toContain('"rows":[[195]]');
      expect(result).toMatchObject({partial: true, terminationReason: 'timeout',
        conclusion: 'Main thread waited 195 ms; the owner is not established.',
        completion: {status: 'incomplete', reason: 'timeout'}});
      expect(result.terminationMessage).toContain('调查时间预算已耗尽');
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      // no semantic call after an exhausted budget, but evidence reads keep a reserve
      expect(context.hasSemanticTransport).toBe(false);
      expect(context.deadlineMs).toBeLessThanOrEqual(startedAt + 3_000);
      expect(context.deadlineMs - Date.now()).toBeGreaterThanOrEqual(50);
      expect(budgetLine(warn)).toContain('timeoutDelivery=delivered');
    });

    it('restores the empty result when the delivery call also runs out of time', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareWithReturnedData(runtime);
      const run = mockRun().mockResolvedValueOnce(streamOf(async function* () {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield toolOutput('slow-0');
        await hang();
      }) as any).mockImplementationOnce(() => hang());
      const result = await runtime.analyze('query', 'timeout-delivery-failed', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({conclusion: '', partial: true, completion: {status: 'incomplete', reason: 'timeout'}});
      expect(budgetLine(warn)).toContain('timeoutDelivery=restored');
    });

    it('does not start a delivery call when nothing returned', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun(); run.mockImplementation(() => hang());
      const result = await runtime.analyze('query', 'timeout-nothing', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({conclusion: '', completion: {status: 'incomplete', reason: 'timeout'}});
      expect(budgetLine(warn)).toContain('timeoutDelivery=no_returned_data');
    });

    it.each([
      [{type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'a'}}, true],
      [{type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: ''}}, false],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {choices: [{index: 0, delta: {reasoning_content: 'r'}}]}}}, true],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: '{"a"'}}]}}]}}}, true],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {choices: [{index: 0, delta: {content: ''}}]}}}, false],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {choices: []}}}, false],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {type: 'response.output_text.delta', delta: 'x'}}}, true],
      [{type: 'raw_model_stream_event', data: {type: 'model', event: {type: 'response.in_progress'}}}, false],
      [{type: 'raw_model_stream_event', data: {type: 'response_started'}}, false],
      [{type: 'agent_updated_stream_event', agent: {name: 'x'}}, false],
    ])('counts only provider output as stream activity: %j', (event, expected) => {
      expect(__testing.openAiStreamEventCarriesOutput(event)).toBe(expected);
    });
  });

  it('uses 49 investigation turns plus one no-tool summary inside a 50-turn budget', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), quickMaxTurns: 50});
    const history = [{role: 'user', content: 'Investigate the trace.'},
      {type: 'function_call', callId: 'evidence-1', name: 'execute_sql', arguments: '{}'},
      {type: 'function_call_result', callId: 'evidence-1', output: '{"rows":[{"dur":9}]}'}];
    const error = new MaxTurnsExceededError('Max turns (49) exceeded', {history, _currentTurn: 50} as any);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce({currentTurn: 50, history, completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 49; i++) yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        throw error;
      }} as any).mockResolvedValueOnce(sdkStream('Investigation incomplete; one interval was observed, its cause remains unknown.'));
    const result = await runtime.analyze('query', 'turn-cap-summary', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2]).toMatchObject({maxTurns: 49});
    expect(run.mock.calls[1][2]).toMatchObject({maxTurns: 1});
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    expect((run.mock.calls[1][0] as any).modelSettings.toolChoice).toBe('none');
    expect((run.mock.calls[1][1] as any[]).slice(0, history.length)).toEqual(history);
    expect(result).toMatchObject({rounds: 50, partial: true, terminationReason: 'max_turns', outputOrigin: 'sdk_final',
      completion: {status: 'incomplete', reason: 'turn_limit', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
    expect(result.conclusion).toContain('Investigation incomplete');
    expect(runtime.sessionMap.size).toBe(0);
  });

  it.each(['missing', 'pending-call', 'no-user', 'oversized', 'unreadable', 'remote-resume'])
  ('uses bounded returned-data context when native history is %s', async condition => {
    const config = createOpenAiConfigForTest();
    if (condition === 'oversized') config.maxHistoryBytes = 32;
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(config);
    const history: any[] = condition === 'no-user' ? [] : [{role: 'user', content: 'The original question with enough content.'}];
    if (condition === 'pending-call') history.push({type: 'function_call', callId: 'pending', name: 'execute_sql', arguments: '{}'});
    const state = condition === 'missing' ? undefined : condition === 'unreadable'
      ? {get history() {throw new Error('unreadable');}} : {history};
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    if (condition === 'remote-resume') runtime.sessionMap.set('cap-denied', {lastResponseId: 'remote', updatedAt: Date.now()});
    const run = mockRun().mockRejectedValueOnce(new MaxTurnsExceededError('cap', state as any))
      .mockResolvedValueOnce(sdkStream('Investigation incomplete. No root cause is established.'));
    const result = await runtime.analyze('query', 'cap-denied', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2]).not.toHaveProperty('previousResponseId');
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    if (condition !== 'remote-resume') expect(JSON.stringify(run.mock.calls[1][1])).toContain('current_run_returned_data_excerpts');
    expect(result).toMatchObject({rounds: 2, partial: true, terminationReason: 'max_turns'});
    expect(result.conclusion).toContain('No root cause');
  });

  it('does not add a hidden closeout turn to a one-turn configuration', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), quickMaxTurns: 1});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValue(new MaxTurnsExceededError('cap'));
    const result = await runtime.analyze('query', 'one-turn-only', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({rounds: 1, partial: true, terminationReason: 'max_turns'});
  });

  it('summarizes raw returned tool data when the SDK cannot return a usable transcript', async () => {
    const runtime = createOpenAiRuntimeForTest();
    prepareStub(runtime).mockImplementation(async (...args: any[]) => {
      const invocation = {toolCallId: 'current-sql', toolName: 'execute_sql', params: {}, extra: {}};
      await args[4].toolObserver({...invocation, phase: 'started'});
      await args[4].toolObserver({...invocation, phase: 'completed', result: {
        content: [{type: 'text', text: JSON.stringify({columns: ['dur'], rows: [[9]], success: true})}],
      }});
      return {systemPrompt: 'test system prompt', tools: [], allowedTools: [], hypotheses: [],
        sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns,
        sessionMapKey: args[4].analysisRunSpec.identity.sessionMapKey};
    });
    const run = mockRun().mockRejectedValueOnce(new MaxTurnsExceededError('cap'))
      .mockResolvedValueOnce(sdkStream('Observed dur=9; the root cause is unknown.'));
    const result = await runtime.analyze('query', 'returned-tape', 'trace', {analysisMode: 'fast', providerId: null});
    const prompt = (run.mock.calls[1][1] as any[])[0].content;
    expect(prompt).toContain('"rows":[[9]]');
    expect(prompt).toContain('"completeTranscript":false');
    expect(prompt).toContain('"verified":false');
    expect((run.mock.calls[1][0] as any).model).toBe('pinned-light');
    expect(result).toMatchObject({partial: true, rounds: 2, completion: {reason: 'turn_limit'}});
  });

  it.each(['error', 'empty', 'output-limit'])('retains the original turn-limit candidate if its summary returns %s', async outcome => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const error = new MaxTurnsExceededError('cap', {history: [{role: 'user', content: 'query'}]} as any);
    const run = mockRun().mockRejectedValueOnce(error);
    if (outcome === 'error') run.mockRejectedValueOnce(new Error('summary failed'));
    else run.mockResolvedValueOnce(sdkStream(outcome === 'empty' ? '' : 'cut short', {status: outcome === 'output-limit' ? 'incomplete' : 'completed'}));
    const result = await runtime.analyze('query', 'failed-cap-summary', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({conclusion: '', partial: true, rounds: 2, terminationReason: 'max_turns', outputOrigin: 'assistant_stream',
      completion: {status: 'incomplete', reason: 'turn_limit', conclusionFingerprint: analysisDeliveryFingerprint('')}});
  });

  it('retains a turn-limit summary with invalid declarations without clearing its quality failure', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const invalidSummary = 'Investigation incomplete; the cause is still unknown.\n' +
      '<!-- smartperfetto:conclusion-contract@1\n```json\n{"schemaVersion":"conclusion_contract_v1","mode":"focused_answer","conclusions":[],"clusters":["investigation"],"evidenceChain":[],"claims":[],"relationProposals":[],"uncertainties":[],"nextSteps":[]}\n```\n-->';
    const error = new MaxTurnsExceededError('cap', {history: [{role: 'user', content: 'query'}]} as any);
    const run = mockRun().mockRejectedValueOnce(error).mockResolvedValueOnce(sdkStream(invalidSummary));
    const result = await runtime.analyze('query', 'invalid-cap-summary', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.conclusion).toContain('Investigation incomplete; the cause is still unknown.');
    expect(result).toMatchObject({partial: true, terminationReason: 'max_turns', outputOrigin: 'sdk_final',
      completion: {status: 'incomplete', reason: 'turn_limit', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(invalidSummary);
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('invalid');
    const delivery = context.deliveryContext;
    if (delivery.entry === 'historical_restore' || !delivery.acceptedCandidate) throw new Error('Missing current candidate');
    const issue = applyFinalResultQualityGate({result, context: {...delivery, entry: 'new_finalization',
      acceptedCandidate: delivery.acceptedCandidate}});
    expect(issue).toBeDefined();
    expect(result.partial).toBe(true);
    expect(result.deliveryAssurance.claims).not.toBe('passed');
    expect(result.terminationMessage).toContain(issue!.message);
    expect(result.conclusion).toContain('Investigation incomplete; the cause is still unknown.');
  });
  it('keeps the original turn-limit candidate when authorization changes during its summary', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValueOnce(new MaxTurnsExceededError('cap'))
      .mockResolvedValueOnce(sdkStream('A summary that must not be accepted after revocation.'));
    const currentAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (run.mock.calls.length >= 2) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return currentAuthorization(...args);
    });
    const result = await runtime.analyze('query', 'cap-summary-revoked', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({conclusion: '', rounds: 2, partial: true,
      completion: {status: 'incomplete', reason: 'turn_limit', conclusionFingerprint: analysisDeliveryFingerprint('')}});
  });
  it('starts a fresh physical response and injects typed partial history instead of opaque SDK state', async () => {
    const runtime = createOpenAiRuntimeForTest(); const prepare = prepareStub(runtime);
    runtime.sessionMap.set('retry', {lastResponseId: 'expired', history: [{role: 'user', content: 'prior'}], updatedAt: Date.now()});
    const reader = createAnalysisHistoryReader({assertActive: () => undefined, getTurns: () => [
      toAnalysisHistoryTurn({id: 'prior-limited', turnIndex: 0, query: 'why slow', traceId: 'trace', timestamp: 1,
        result: {conclusion: 'Wait observed; cause unknown.', partial: true, completion: {status: 'incomplete'},
          terminationReason: 'max_turns'}}),
    ]});
    const run = mockRun(sdkStream('followup'));
    const result = await runtime.analyze('query', 'retry', 'trace', withAnalysisHistoryReader({providerId: null}, reader));
    expect(result.completion.status).toBe('completed'); expect(run).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1); expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).not.toHaveProperty('previousResponseId');
    expect(run.mock.calls[0][1]).toContain('Wait observed; cause unknown.');
    expect(run.mock.calls[0][1]).toContain('"partial":true');
    expect(run.mock.calls[0][1]).not.toContain('expired');
  });
  it('does not treat prose describing a missing response as a retry authorization', () => {
    expect(__testing.isMissingOpenAIPreviousResponseError(new Error('No response found with id old'), 'old')).toBe(false);
    expect(__testing.isMissingOpenAIPreviousResponseError({status: 404, param: 'previous_response_id'}, 'old')).toBe(true);
  });
  it('does not commit when cancellation arrives while provider close is pending', async () => {
    const scope = new __testing.RuntimeAnalysisAbortScope(); const close = createDeferred<void>(); const commit = jest.fn();
    const pending = __testing.commitAfterProviderClose(() => close.promise, scope, commit);
    const rejected = expect(pending).rejects.toThrow(); scope.abort(); close.resolve(); await rejected;
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('OpenAI bounded output-limit recovery', () => {
  function recoverableStream(text: string, status = 'incomplete') {
    return {...sdkStream(text, {status}), history: [{role: 'user', content: 'query'}, {role: 'assistant', content: text}]};
  }

  const protocolSidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [{rank: 1, statement: 'The marker is present.'}], clusters: [], evidenceChain: [],
    claims: [], uncertainties: [], nextSteps: []} as ConclusionContract);

  it('uses the reserved no-tool turn to complete a full undeclared candidate without rewriting it', async () => {
    const body = `开头🙂\n${'中English🙂'.repeat(1300)}\n结尾`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun()
      .mockResolvedValueOnce({...recoverableStream(body, 'completed'), async *[Symbol.asyncIterator]() {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'INITIAL_VISIBLE'}};
        yield responseDone(body, 'completed');
      }})
      .mockResolvedValueOnce({...recoverableStream(`${body}\n${protocolSidecar}`, 'completed'), async *[Symbol.asyncIterator]() {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'REPAIR_MUST_NOT_STREAM'}};
        yield responseDone(`${body}\n${protocolSidecar}`, 'completed');
      }});
    const result = await runtime.analyze('query', 'missing-declaration-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    expect(JSON.stringify(run.mock.calls[1][1])).toContain(JSON.stringify(body).slice(1, -1));
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body.trim());
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('valid');
    expect(result.completion).toMatchObject({status: 'completed'});
    expect(JSON.stringify(updates)).toContain('INITIAL_VISIBLE');
    expect(JSON.stringify(updates)).not.toContain('REPAIR_MUST_NOT_STREAM');
  });

  it('retains the original undeclared candidate when completion changes its body', async () => {
    const body = 'Measured value: 42 ms.';
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun()
      .mockResolvedValueOnce(recoverableStream(body, 'completed'))
      .mockResolvedValueOnce(recoverableStream(`Measured value: 43 ms.\n${protocolSidecar}`, 'completed'));
    const result = await runtime.analyze('query', 'changed-declaration-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.conclusion).toBe(body);
    expect(result.conclusionContract?.bindingEligibility).not.toBe('eligible');
    expect(result.completion).toMatchObject({status: 'completed',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
  });

  it('declines missing-declaration completion when the full history and prompt exceed the existing input cap', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), maxHistoryBytes: 1024});
    const body = 'bounded body '.repeat(300).trimEnd();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(recoverableStream(body, 'completed'));
    const result = await runtime.analyze('query', 'missing-declaration-history-cap', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed'});
  });

  it('retains the completed native candidate when the declaration template cannot render', async () => {
    const body = 'Measured value: 42 ms.';
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(recoverableStream(body, 'completed'));
    jest.spyOn(localizedStrategyTemplate, 'renderRequiredLocalizedStrategyTemplate')
      .mockImplementationOnce(() => { throw new Error('missing declaration template'); });

    const result = await runtime.analyze('query', 'missing-declaration-template', 'trace', {providerId: null,
      runId: 'missing-declaration-template'});

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', runId: 'missing-declaration-template',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
  });

  it('repairs an internally unowned source Trace binding within the existing single correction', async () => {
    const payload: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'source-body', kind: 'inference', text: 'Implementation is a candidate explanation.', references: [],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.mechanism', polarity: 'affirmed',
          discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'}}}],
      sourceClaimBindings: [{claimId: 'source-body', mechanismStatus: 'compatible', sourceReferenceIds: ['source-returned'],
        traceEvidenceRefIds: ['evidence-owned-by-another-claim']}]};
    const encode = (value: ConclusionContract) => `Implementation is a candidate explanation.\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n-->`;
    const first = encode(payload);
    const complete = encode({...payload, sourceClaimBindings: [{...payload.sourceClaimBindings![0], traceEvidenceRefIds: []}]});
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed')).mockResolvedValueOnce(recoverableStream(complete, 'completed'));
    const result = await runtime.analyze('query', 'source-link-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
    expect(diagnostic[0]).toMatchObject({status: 'invalid', issueCodes: ['invalid_reference'], sourceBindingCount: 1});
    expect(diagnostic[1]).toMatchObject({status: 'valid', sourceBindingCount: 1});
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(complete);
    expect(inspectCandidateProtocol(first).sidecar.rawPayload).toEqual(payload);
  });

  it.each(['sidecar-only', 'invalid-schema'])('repairs a native completed %s candidate before finalization', async kind => {
    const first = kind === 'sidecar-only' ? protocolSidecar : `The marker is present.\n${protocolSidecar.replace('"focused_answer"', '"invalid-mode"')}`;
    const complete = `The marker is present.\n${protocolSidecar}`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed')).mockResolvedValueOnce(recoverableStream(complete, 'completed'));
    const result = await runtime.analyze('query', `protocol-recovery-${kind}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('The marker is present.');
    expect(result.completion).toMatchObject({status: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(complete);
    const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
    expect(diagnostic.map(value => [value.stage, value.candidateIndex, value.status])).toEqual([
      ['native', 1, kind === 'sidecar-only' ? 'valid' : 'invalid'], ['native', 2, 'valid'], ['runtime_projected', 2, 'valid'],
    ]);
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    const recoveryHistory = run.mock.calls[1][1] as Array<{role?: string; content?: unknown}>;
    const recoveryPrompt = String(recoveryHistory[recoveryHistory.length - 1].content);
    if (kind === 'invalid-schema') {
      expect(recoveryPrompt).toContain('"field":"$.mode"');
      expect(recoveryPrompt).toContain('"reason":"invalid_enum"');
      expect(recoveryPrompt).not.toContain('invalid-mode');
    }
  });

  it('gives the existing relation correction a closed diagnostic and exact external schema', async () => {
    const base: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation_1',
        kind: 'overlap', direction: 'symmetric', subject: {evidenceRefId: 'evidence-subject'}}]};
    const first = `The marker is present.\n${renderConclusionContractSidecar({...base, relationProposals: [{
      ...base.relationProposals![0], PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY',
    }]} as any)}`;
    const complete = `The marker is present.\n${renderConclusionContractSidecar(base)}`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed'))
      .mockResolvedValueOnce(recoverableStream(complete, 'completed'));
    const result = await runtime.analyze('query', 'relation-protocol-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    const diagnostic = updates.find(update => update.content?.phase === 'candidate_protocol')!
      .content.candidateProtocolDiagnostic;
    expect(diagnostic).toMatchObject({status: 'invalid', issueCodes: ['invalid_relation_proposal'],
      relationProposalDiagnostics: [{scope: 'item', ordinal: 1, reason: 'unknown_field'}]});
    const recoveryHistory = run.mock.calls[1][1] as Array<{role?: string; content?: unknown}>;
    const recoveryPrompt = String(recoveryHistory[recoveryHistory.length - 1].content);
    expect(recoveryPrompt).toContain('proofBindings');
    expect(recoveryPrompt).toContain('endpointColumn');
    expect(recoveryPrompt).toContain('"reason":"unknown_field"');
    expect(recoveryPrompt).not.toContain('PRIVATE_RELATION_');
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(complete);
  });

  it.each(['en', 'zh-CN'] as const)('provides value-free schema feedback to the one correction in %s', async outputLanguage => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), outputLanguage});
    const first = `The marker is present.\n${protocolSidecar.replace('\"focused_answer\"', '\"PRIVATE_RECOVERY_STRUCTURE_CANARY\"')}`;
    const complete = `The marker is present.\n${protocolSidecar}`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed')).mockResolvedValueOnce(recoverableStream(complete, 'completed'));
    const result = await runtime.analyze('query', `structure-feedback-${outputLanguage}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    const history = run.mock.calls[1][1] as Array<{content?: unknown}>;
    const prompt = String(history[history.length - 1].content);
    const native = updates.find(update => update.content?.candidateProtocolDiagnostic?.stage === 'native').content.candidateProtocolDiagnostic;
    expect(JSON.parse(prompt.trim().split('\n').pop()!)).toEqual(native);
    expect(prompt).toContain('"field":"$.mode"');
    expect(prompt).not.toContain('PRIVATE_RECOVERY_STRUCTURE_CANARY');
    expect(prompt).not.toContain('{{candidate_protocol_diagnostic}}');
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    expect(result.completion.status).toBe('completed');
  });

  it.each(['plain-body', 'sidecar-only', 'invalid-schema'])('retains the original candidate when correction returns %s', async kind => {
    const first = `The marker is present.\n${protocolSidecar.replace('"focused_answer"', '"invalid-mode"')}`;
    const second = kind === 'plain-body' ? 'The marker is present.' : kind === 'sidecar-only' ? protocolSidecar : first;
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed')).mockResolvedValueOnce(recoverableStream(second, 'completed'));
    const result = await runtime.analyze('query', `rejected-protocol-recovery-${kind}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(first);
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('invalid');
    expect(result.completion.status).toBe('completed');
    expect(result.terminationMessage).toBeUndefined();
    expect(projectPrivateAnalysisResult(result.sessionId, result, 'en').terminationMessage).toBeUndefined();
  });

  it('shares the single completion attempt between output-limit and protocol failures', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream('limited body')).mockResolvedValueOnce(recoverableStream(protocolSidecar, 'completed'));
    const result = await runtime.analyze('query', 'shared-recovery-limit', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.conclusion).toBe('limited body');
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit'});
  });

  it('records a post-native projection fault without retrying a valid native candidate', async () => {
    const raw = `The marker is present.\n${protocolSidecar}`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const project = sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection;
    jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection').mockImplementation((...args) => {
      const projected = project(...args);
      return {...projected, result: {...projected.result, conclusion: raw.replace('"focused_answer"', '"invalid-mode"')}};
    });
    const run = mockRun(recoverableStream(raw, 'completed'));
    await runtime.analyze('query', 'projection-only-invalid', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
    expect(diagnostic.map(value => [value.stage, value.status])).toEqual([['native', 'valid'], ['runtime_projected', 'invalid']]);
  });

  it.each([2, 3])('uses actual native turns to admit one source-preserving recovery (maxTurns=%s)', async maxTurns => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions', maxTurns});
    const sourceResult = JSON.stringify({success: true, reference: {
      referenceId: 'source-returned-by-tool', codebaseId: 'codebase-a', filePath: 'src/Startup.kt',
      lineRange: {start: 1, end: 3}, text: 'startMarker()',
    }});
    const execute = jest.fn(async () => sourceResult);
    const sourceTool = tool({name: 'read_codebase_file', description: 'Read source', parameters: z.object({}), execute});
    const runtime = createOpenAiRuntimeForTest();
    prepareStub(runtime).mockImplementation(async (...args: any[]) => ({
      systemPrompt: 'test system prompt', tools: [sourceTool], allowedTools: ['read_codebase_file'],
      sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns,
      hypotheses: [], sessionMapKey: args[4].analysisRunSpec.identity.sessionMapKey,
    }));
    const wire = (id: string, delta: unknown, finishReason: string) => new Response([
      {id, object: 'chat.completion.chunk', created: 1, model: 'pinned-primary', choices: [{index: 0, delta, finish_reason: null}]},
      {id, object: 'chat.completion.chunk', created: 1, model: 'pinned-primary', choices: [{index: 0, delta: {}, finish_reason: finishReason}]},
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(wire('source-call', {role: 'assistant', tool_calls: [{index: 0, id: 'source-call-1', type: 'function', function: {name: 'read_codebase_file', arguments: '{}'}}]}, 'tool_calls'))
      .mockResolvedValueOnce(wire('limited-answer', {role: 'assistant', content: 'The source begins'}, maxTurns === 2 ? 'stop' : 'length'))
      .mockResolvedValueOnce(wire('complete-answer', {role: 'assistant', content: 'The complete answer uses the source already read.'}, 'stop'));
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization');
    const updates: any[] = []; runtime.on('update', (update: unknown) => updates.push(update));
    const result = await runtime.analyze('query', 'source-output-recovery', 'trace', {
      providerId: null, analysisMode: 'full', codeAwareMode: 'provider_send', codebaseIds: ['codebase-a'], runId: 'recovery-run',
    });
    expect(fetchMock).toHaveBeenCalledTimes(maxTurns);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorization).toHaveBeenCalledWith(expect.objectContaining({codebaseIds: ['codebase-a'], runId: 'recovery-run'}),
      expect.any(Object), expect.stringMatching(/^[a-f0-9]{64}$/));
    const previousRequestOrder = fetchMock.mock.invocationCallOrder[maxTurns - 2];
    const deliveryRequestOrder = fetchMock.mock.invocationCallOrder[maxTurns - 1];
    expect(authorization.mock.invocationCallOrder.some(order => order > previousRequestOrder && order < deliveryRequestOrder)).toBe(true);
    if (maxTurns === 2) {
      expect(result.conclusion).toBe('The source begins');
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'turn_limit', sdkFinishReason: 'stop',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      expect(result).toMatchObject({partial: true, terminationReason: 'max_turns', outputOrigin: 'sdk_final'});
      const lastRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(lastRequest.tool_choice).toBe('none');
      expect(lastRequest.tools).toBeUndefined();
      expect(lastRequest.messages).toContainEqual(expect.objectContaining({role: 'tool', tool_call_id: 'source-call-1', content: sourceResult}));
      expect(result.rounds).toBe(2);
      return;
    }
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[2]).toMatchObject({model: 'pinned-primary', store: false, tool_choice: 'none', max_tokens: 1024});
    expect(requests[2].tools).toBeUndefined();
    expect(requests[2].messages).toContainEqual(expect.objectContaining({role: 'tool', tool_call_id: 'source-call-1', content: sourceResult}));
    expect(result.conclusion).toBe('The complete answer uses the source already read.');
    expect(result.completion).toMatchObject({runId: 'recovery-run', status: 'completed', sdkFinishReason: 'stop',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
    expect(result.rounds).toBe(3);
    expect(runtime.sessionMap.size).toBe(0);
    expect(updates.filter(update => update.type === 'answer_token' && update.content.token).map(update => update.content.token).join('')).toBe('The source begins');
    expect(updates.filter(update => update.type === 'conclusion').map(update => update.content.conclusion)).toEqual([result.conclusion]);
    const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
    expect(context?.deliveryContext.entry === 'runtime_draft' && context.deliveryContext.completion?.attemptId).toBe(result.completion.attemptId);
  });

  it.each(['incomplete', 'completed-empty', 'error'])('retains the original limited candidate when recovery returns %s', async outcome => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream('original partial answer'));
    if (outcome === 'error') run.mockRejectedValueOnce(new Error('completion attempt unavailable'));
    else run.mockResolvedValueOnce(recoverableStream(outcome === 'completed-empty' ? '' : 'another partial answer', outcome === 'completed-empty' ? 'completed' : 'incomplete'));
    const result = await runtime.analyze('query', `failed-recovery-${outcome}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.conclusion).toBe('original partial answer');
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit',
      conclusionFingerprint: analysisDeliveryFingerprint('original partial answer')});
    expect(result.partial).toBe(true);
    expect(result.terminationMessage).toBeUndefined();
    expect(projectPrivateTerminationMessage(result.terminationMessage, 'en', result)).toContain('did not complete');
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    expect(run.mock.calls[1][2]).toMatchObject({maxTurns: 1});
  });

  it.each(['turns', 'history-size', 'history-missing', 'pending-tool', 'deadline'])('does not recover without an admissible %s budget/context', async missing => {
    const config = createOpenAiConfigForTest();
    if (missing === 'turns') config.quickMaxTurns = 1;
    if (missing === 'history-size') config.maxHistoryBytes = 1;
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(config);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const first = recoverableStream('original partial answer');
    if (missing === 'history-missing') first.history = [];
    if (missing === 'pending-tool') (first.history as any[]).push({type: 'function_call', callId: 'unfinished', name: 'read_codebase_file', arguments: '{}'});
    if (missing === 'deadline') {
      const start = Date.now();
      const originalStream = first[Symbol.asyncIterator];
      first[Symbol.asyncIterator] = async function* () {
        yield* originalStream();
        jest.spyOn(Date, 'now').mockReturnValue(start + 500_000);
      };
    }
    const run = mockRun(first);
    const result = await runtime.analyze('query', `no-recovery-${missing}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit'});
  });

  it('checks current authorization before redispatching already-read private context', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(recoverableStream('original partial answer'));
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
      if (run.mock.calls.length > 0) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
    });
    const result = await runtime.analyze('query', 'revoked-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toBe('original partial answer');
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit'});
    expect(result.terminationMessage).toBeUndefined();
  });

  it('can repair current-run output without resuming an earlier remote response', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    runtime.sessionMap.set('remote-recovery', {lastResponseId: 'remote-earlier', updatedAt: Date.now()});
    const run = mockRun().mockResolvedValueOnce(recoverableStream('original partial answer'))
      .mockResolvedValueOnce(sdkStream('current-run final answer'));
    const result = await runtime.analyze('query', 'remote-recovery', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2]).not.toHaveProperty('previousResponseId');
    expect(run.mock.calls[1][2]).not.toHaveProperty('previousResponseId');
    expect(result.completion).toMatchObject({status: 'completed'});
  });

  it('does not publish a late completion attempt after cancellation', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const entered = createDeferred<void>(); const late = createDeferred<any>();
    const run = mockRun().mockResolvedValueOnce(recoverableStream('original partial answer', 'completed'))
      .mockImplementationOnce(async () => {entered.resolve(); return late.promise;});
    const updates: any[] = []; runtime.on('update', (update: unknown) => updates.push(update));
    const pending = runtime.analyze('query', 'cancelled-recovery', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toBeDefined();
    await entered.promise;
    await runtime.abortSession('cancelled-recovery');
    await rejected;
    late.resolve(sdkStream('late answer'));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(updates.some(update => update.type === 'conclusion')).toBe(false);
    expect(runtime.sessionMap.size).toBe(0);
  });
});

describe('OpenAI shared tool receipt and private projection', () => {
  it.each([false, true])('retains private source outcomes before transport truncation (body=%s)', includeBody => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const context = streamContext('openai-source-outcome', false);
    runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_called', item: {rawItem: {
      callId: 'source-outcome', name: 'search_codebase', arguments: '{}',
    }}}, 'en', context);
    runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_output', item: {rawItem: {
      callId: 'source-outcome', output: JSON.stringify({success: true, matches: Array.from({length: 20}, (_, i) => ({
        referenceId: `source-reference-${i}`, codebaseId: 'codebase-a',
        filePath: `src/PRIVATE_SOURCE_PATH_${i}.kt`, lineRange: {start: 1, end: 20},
        ...(includeBody ? {text: 'PRIVATE_SOURCE_BODY'} : {}),
      }))}),
    }}}, 'en', context);
    const update = updates.find(item => item.type === 'agent_response')!;
    expect(() => JSON.parse(update.content.result)).toThrow();
    expect(update.content.privateToolResultReceipt).toBeDefined();
    const projected = projectCodeAwareStreamingUpdate('openai-source-outcome', update, true, 'en');
    expect(projected).toMatchObject({content: {resultNarration: includeBody
      ? 'Authorized content was read and is available to check against trace evidence'
      : 'Candidate source or knowledge locations are available; their content has not been read'}});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
  });

  it('records OpenAI tool calls into the active analysis plan', () => {
    const { runtime } = createRuntimeWithUpdates();
    const p1 = phase('p1', 'in_progress');
    p1.expectedCalls = [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }];
    runtime.sessionPlans.set('s-tools', {
      current: plan([p1]),
      history: [],
    });
    const context = streamContext('s-tools', false);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {
        rawItem: {
          callId: 'call-1',
          id: 'item-1',
          name: 'invoke_skill',
          arguments: JSON.stringify({ skillId: 'scrolling_analysis', params: { process_name: 'demo' } }),
        },
      },
    }, 'zh-CN', context);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {
        rawItem: {
          callId: 'call-1',
          output: JSON.stringify([{ type: 'text', text: '{"success":true,"planPhaseId":"p1"}' }]),
        },
      },
    }, 'zh-CN', context);

    expect(runtime.sessionPlans.get('s-tools')!.current!.toolCallLog).toContainEqual(expect.objectContaining({
      toolName: 'invoke_skill',
      skillId: 'scrolling_analysis',
      matchedPhaseId: 'p1',
    }));
  });

  it('records and publishes each real tool result ID once while retaining distinct calls', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const p1 = phase('p1', 'in_progress');
    p1.expectedTools = ['execute_sql'];
    runtime.sessionPlans.set('s-dedup', {current: plan([p1]), history: []});
    const onToolCalled = jest.fn();
    const context = {...streamContext('s-dedup', false), processedToolResultIds: new Set<string>(), onToolCalled};
    for (const callId of ['call-a', 'call-b']) {
      const dispatch = {type: 'run_item_stream_event', name: 'tool_called', item: {rawItem: {
        callId, name: 'execute_sql', arguments: '{"sql":"SELECT 1"}',
      }}};
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
      const result = {type: 'run_item_stream_event', name: 'tool_output', item: {rawItem: {
        callId, output: '{"success":true,"planPhaseId":"p1"}',
      }}};
      runtime.handleStreamEvent(result, 'zh-CN', context);
      runtime.handleStreamEvent(result, 'zh-CN', context);
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
    }
    expect(runtime.sessionPlans.get('s-dedup')?.current?.toolCallLog.map((call: AnalysisPlanV3['toolCallLog'][number]) => call.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(updates.filter(update => update.type === 'agent_response')).toHaveLength(2);
    expect(updates.filter(update => update.type === 'agent_task_dispatched')).toHaveLength(2);
    expect(onToolCalled).toHaveBeenCalledTimes(2);
  });

  it('projects private wiki tool output before emitting it', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    const context = streamContext('s-private-wiki', false);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {rawItem: {
        callId: 'wiki-call',
        name: 'lookup_blog_knowledge',
        arguments: JSON.stringify({source: 'android_internals_wiki'}),
      }},
    }, 'zh-CN', context);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {rawItem: {
        callId: 'wiki-call',
        output: JSON.stringify({result: {
          query: 'Handler',
          probed: ['android_internals_wiki'],
          retrievedAt: 1,
          legacyPath: false,
          hits: [{
            chunkId: 'wiki-1',
            score: 1,
            metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
            snippet: 'OPENAI_PRIVATE_WIKI_CANARY',
          }],
        }}),
      }},
    }, 'zh-CN', context);

    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENAI_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('records source references before projecting private tool output', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    const sourcePhase = phase('p-source', 'in_progress');
    sourcePhase.expectedCalls = [{ tool: 'lookup_app_source' }];
    runtime.sessionPlans.set('s-private-source', {
      current: plan([sourcePhase]),
      history: [],
    });
    const context = streamContext('s-private-source', false);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: {
        callId: 'source-call',
        name: 'lookup_app_source',
        arguments: JSON.stringify({ query: 'StartupHooks' }),
      } },
    }, 'zh-CN', context);
    const rawSourceResult = JSON.stringify({ success: true, result: {
      query: 'StartupHooks',
      hits: [{
        chunkId: 'source-1',
        score: 1,
        metadata: {
          kind: 'app_source',
          codebaseId: 'codebase-a',
          filePath: 'app/src/main/java/com/example/StartupHooks.kt',
          lineRange: { start: 10, end: 20 },
        },
        snippet: 'OPENAI_PRIVATE_SOURCE_CANARY',
      }],
    } });
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {
        output: { type: 'text', text: rawSourceResult },
        rawItem: {
          callId: 'source-call',
          output: [{ type: 'input_text', text: rawSourceResult }],
        },
      },
    }, 'zh-CN', context);

    const currentPlan = runtime.sessionPlans.get('s-private-source')!.current!;
    expect(currentPlan.toolCallLog)
      .toContainEqual(expect.objectContaining({
        toolName: 'lookup_app_source',
        matchedPhaseId: 'p-source',
        success: true,
        returnedCodeReferences: true,
      }));
    expect(getSourceLookupCodeReferences(currentPlan)).toEqual([{
      chunkId: 'source-1',
      codebaseId: 'codebase-a',
      filePath: 'app/src/main/java/com/example/StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    }]);
    expect(JSON.stringify(currentPlan)).not.toContain('StartupHooks.kt');
    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENAI_PRIVATE_SOURCE_CANARY');
    expect(serialized).not.toContain('app/src/main/java/com/example/StartupHooks.kt');
    expect(serialized).toContain('snippetHash');
  });

  it('streams current assistant text before an optional plan is submitted', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const text = '自然回答无需等待 submit_plan';
    runtime.handleStreamEvent({type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: text}}, 'zh-CN', streamContext('no-plan', false));
    expect(updates.filter(update => update.type === 'answer_token').map(update => update.content.token)).toEqual([text]);
  });
});

describe('OpenAI provisional memory boundary', () => {
  it('does not promote a runtime draft as verified and selects the bucket from semantic scope', () => {
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(runtime.recordPatternMemory).mockRestore();
    jest.spyOn(patternMemory, 'extractKeyInsights').mockReturnValue(['an observed fact']);
    const quick = jest.spyOn(patternMemory, 'saveQuickPathPattern').mockResolvedValue(undefined);
    const full = jest.spyOn(patternMemory, 'saveAnalysisPattern').mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching').mockResolvedValue(false);
    const input = {sessionId: 'memory-draft', previousTurnCount: 0, quickMode: false, sceneType: 'general', options: {},
      result: {conclusion: 'body', findings: [{title: 'fact'}], turnIntent: decision}};
    runtime.recordPatternMemory(input);
    expect(quick).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled();
    runtime.recordPatternMemory({...input, quickMode: true, result: {...input.result,
      turnIntent: {...decision, scope: 'scene_wide', deliverable: 'report'}}});
    expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.calls[0][5]).toMatchObject({status: 'provisional'});
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('OpenAI source finalization parity', () => {
  it('preserves native provider completion while recording pending source access', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: mcpModule.createClaudeMcpServer, sessionId: 'pending-source'});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime, fixture.sourceUse); mockRun();
    try {
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', {
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      });
      expect(result).toMatchObject({success: true, sourceUseDecision: {status: 'pending'}, sourceReferences: [],
        completion: {status: 'completed'}});
      expect(result.partial).toBeUndefined();
      expect(result.terminationReason).toBeUndefined();
      expect(result.conclusion).toBe('回答已完成');
      expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally {fixture.cleanup();}
  });
  it('binds the projected candidate and never inherits an earlier turn source ledger', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: mcpModule.createClaudeMcpServer, sessionId: 'bound-source'});
    const runtime = createOpenAiRuntimeForTest();
    try {
      const {decision: sourceDecision} = await fixture.executeProviderSourceLookup();
      const prepare = prepareStub(runtime, fixture.sourceUse);
      const run = mockRun(sdkStream(SOURCE_FINALIZATION_RAW_SOURCE));
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', {
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      });
      expect(result.sourceUseDecision).toEqual(sourceDecision); expect(result.sourceReferences).toEqual(sourceDecision.references);
      expect(JSON.stringify(result)).toContain(SOURCE_FINALIZATION_CANARY);
      expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(SOURCE_FINALIZATION_RAW_SOURCE);
      expect(JSON.stringify(result)).not.toContain('conclusion_protocol_projection');
      prepare.mockRestore(); prepareStub(runtime); run.mockResolvedValue(sdkStream('public second answer'));
      const next = await runtime.analyze('another request', fixture.sessionId, 'trace', {analysisMode: 'fast', providerId: null, codeAwareMode: 'off'});
      expect(next.sourceUseDecision).toBeUndefined(); expect(next.sourceReferences).toBeUndefined();
      expect(next.completion.candidateRef).not.toBe(result.completion.candidateRef);
    } finally {fixture.cleanup();}
  });
});

describe('OpenAI candidate-bound privacy projection', () => {
  it.each(['zh-CN', 'en'] as const)('consumes redacted receipts and the returned context in %s', async outputLanguage => {
    const sessionId = `redacted-candidate-${outputLanguage}`; privacySessions.push(sessionId);
    const nativeBody = outputLanguage === 'en' ? 'Before PRIVATE_CANARY after' : '前文 PRIVATE_CANARY 后文';
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(nativeBody));
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({outputOrigin: 'sdk_final', completion: {status: 'completed'}});
    expect(result.partial).toBeUndefined();
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    const originalContext = projected.mock.calls[0][2]?.context;
    expect(result.completion.candidateRef).not.toBe(originalContext?.entry === 'runtime_draft'
      ? originalContext.acceptedCandidate?.candidateRef : undefined);
    expect(verified.mock.calls[0][2]?.deliveryContext).toBe(outcome.deliveryContext);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(result)).not.toContain(outcome.conclusionProjection.inputFingerprint);
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
  });
  it.each([
    {outputLanguage: 'zh-CN' as const, nativeBody: '原生回答'},
    {outputLanguage: 'en' as const, nativeBody: 'Native answer'},
    {outputLanguage: 'en' as const, nativeBody: ''},
  ])('keeps whole replacement separate from native completion for $outputLanguage / $nativeBody', async ({outputLanguage, nativeBody}) => {
    const sessionId = `replaced-candidate-${outputLanguage}-${nativeBody.length}`; privacySessions.push(sessionId);
    revokeCodeAwareOutputGuards(sessionId);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(nativeBody));
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('replaced');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}, quickRun: {stopReason: 'partial'}});
    expect(verified.mock.calls[0][2]?.deliveryContext).toBe(outcome.deliveryContext);
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
    if (!nativeBody) {
      const context = projected.mock.calls[0][2]?.context;
      expect(context?.entry === 'runtime_draft' && context.completion?.status).toBe('unknown');
      expect(result.confidence).toBe(0);
    }
  });
  it('keeps literal placeholder text as model content when no replacement occurred', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('[PRIVATE_OUTPUT_SUPPRESSED]'));
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const result = await runtime.analyze('query', 'literal-placeholder', 'trace', {providerId: null});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('preserved');
    expect(result).toMatchObject({success: true, outputOrigin: 'sdk_final', completion: {status: 'completed'}});
    expect(result.partial).toBeUndefined();
  });
  it.each(['completed', 'incomplete'] as const)('redaction transfers native %s and does not restore an earlier context', async status => {
    const sessionId = `projection-status-${status}`; privacySessions.push(sessionId);
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('Before PRIVATE_CANARY after', {status}));
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect(result.completion.status).toBe(status);
    const context = verified.mock.calls[0][2]?.deliveryContext;
    expect(context?.entry === 'runtime_draft' && context.completion).toEqual(result.completion);
    expect(context?.entry === 'runtime_draft' && context.acceptedCandidate?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
  });
  it('projects a failed stream candidate and its error without upgrading native failure', async () => {
    const sessionId = 'projection-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun({currentTurn: 1, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      throw new Error('PRIVATE_CANARY provider failure');
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect((projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>).conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'assistant_stream', completion: {status: 'failed', reason: 'provider_error'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });
  it('projects setup failure diagnostics before emitting them without inventing model output', async () => {
    const sessionId = 'projection-setup-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const {runtime, updates} = createRuntimeWithUpdates();
    prepareStub(runtime).mockRejectedValue(new Error('PRIVATE_CANARY setup failed'));
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect(result).toMatchObject({success: false, partial: true, conclusion: '', outputOrigin: 'runtime_fallback',
      completion: {status: 'failed', reason: 'provider_error'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
  });
  it('does not use an unrelated stream projection as the native terminal body', () => {
    privacySessions.push('receipt-mismatch'); registerCodeAwareCanary('receipt-mismatch', 'PRIVATE_CANARY');
    const projection = createCodeAwareStreamingTextProjection('receipt-mismatch', 'unrelated');
    const receipt = projection.projectCompleteWithReceipt('another PRIVATE_CANARY body');
    const candidate = {
      result: {sessionId: 'receipt-mismatch', success: true, findings: [], hypotheses: [], conclusion: 'current body', confidence: 0.5, rounds: 1, totalDurationMs: 1},
      runId: 'run-current', attemptId: 'attempt-current', finish: {status: 'completed'}, outputOrigin: 'sdk_final',
      projection: {...projection, projectCompleteWithReceipt: () => receipt},
    };
    const projected = __testing.finalizeOpenAiCandidate(candidate as Parameters<typeof __testing.finalizeOpenAiCandidate>[0]);
    expect(projected.result.conclusion).toBe('current body');
    expect(projected.result.completion).toMatchObject({status: 'completed', conclusionFingerprint: analysisDeliveryFingerprint('current body')});
    expect(projected.protocolProjection).toBeDefined();
    expect(projected.deliveryContext.entry === 'runtime_draft' && projected.deliveryContext.completion).toEqual(projected.result.completion);
  });
  it('cancellation never finalizes or publishes an unprojected stream body', async () => {
    const sessionId = 'projection-cancelled'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun({currentTurn: 1, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      entered.resolve(); await release.promise;
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const pending = runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession(sessionId); release.resolve(); await rejected;
    expect(projected).not.toHaveBeenCalled();
    expect(updates.filter(update => update.type === 'conclusion')).toHaveLength(0);
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
  });
});

describe('OpenAI finalization handoff', () => {
  function takeContext(result: any): finalization.RuntimeFinalizationContext {
    const context = finalization.takeFinalizationContext(result);
    if (!context) throw new Error('Missing runtime finalization context');
    finalizationContexts.push(context);
    return context;
  }
  const transportInput = () => ({prompt: 'semantic review input', systemPrompt: 'semantic review protocol',
    signal: new AbortController().signal, deadlineMs: Date.now() + 60_000, outputByteLimit: 128 * 1024});

  it('attaches once to the returned object after the SDK provider closes', async () => {
    const order: string[] = [];
    jest.spyOn(OpenAIProvider.prototype, 'close').mockImplementation(async () => {order.push('close');});
    const originalAttach = finalization.attachFinalizationContext;
    const attach = jest.spyOn(finalization, 'attachFinalizationContext').mockImplementation((result, context) => {
      order.push('attach'); originalAttach(result, context);
    });
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const options = {providerId: null, runId: 'current-run', analysisContextFingerprint: '', codeAwareMode: 'off' as const,
      selectionContext: {kind: 'track_event' as const, eventId: 7, ts: 42, dur: 9}};
    const pinnedFingerprint = contextAuthorization.buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
    options.analysisContextFingerprint = pinnedFingerprint;
    const result = await runtime.analyze('query', 'finalization-once', 'trace', options);
    expect(order).toEqual(['close', 'attach']); expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe(result);
    expect(finalization.takeFinalizationContext({...result})).toBeUndefined();
    const context = takeContext(result);
    expect(context.sourceScope).toBeUndefined(); // An absent third-party accessor is not proof that source was off.
    options.analysisContextFingerprint = 'later-auth-context';
    const providerQuery = context.getProviderQuery(new AbortController().signal);
    expect(providerQuery).toEqual({text: 'query', analysisContextFingerprint: pinnedFingerprint});
    expect(Object.isFrozen(providerQuery)).toBe(true);
    expect(context.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
      context: options.selectionContext, sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace'}});
    expect(JSON.stringify(result)).not.toContain('"providerQuery"');
    expect(finalization.takeFinalizationContext(result)).toBeUndefined();
    expect(context.runId).toBe('current-run');
    expect(context.deliveryContext.entry === 'runtime_draft' && context.deliveryContext.completion).toEqual(result.completion);
    expect(JSON.stringify(result)).not.toContain('test-only');
    expect(result).not.toHaveProperty('dispatchText'); expect(result).not.toHaveProperty('strategyRegistry');
  });
  it.each([true, false])('hands off only available source execution scope from MCP: current=%s', async current => {
    const scope = {codeAwareMode: 'off' as const, selectedCodebaseIds: [], hasCodebaseAccess: false,
      analysisContextFingerprint: 'source-scope-pin'};
    const getter = jest.fn(() => current ? scope : undefined);
    const runtime = createOpenAiRuntimeForTest();
    prepareStub(runtime, {getSourceUseDecision: () => undefined, getSourceExecutionScope: getter});
    mockRun();
    const result = await runtime.analyze('query', `source-scope-${current}`, 'trace', {providerId: null});
    const context = takeContext(result);
    expect(context.sourceScope).toEqual(current ? scope : undefined);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(result.completion?.status).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('source-scope-pin');
  });
  it.each([undefined, 1024, 65_536])('reviews through the original pinned primary and explicit output cap %s after provider close', async maxOutputTokens => {
    const config = {...createOpenAiConfigForTest(), maxOutputTokens};
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(config);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-primary', 'trace', {providerId: null, analysisMode: 'fast'});
    const context = takeContext(result);
    config.maxOutputTokens = 7;
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(),
      model: 'later-primary', apiKey: 'later-key', baseURL: 'https://later.invalid/v1'});
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({status: 'ok', text: 'semantic review output'});
    const input = transportInput();
    const reviewed = await context.dispatchText(input);
    expect(reviewed).toMatchObject({status: 'ok', text: 'semantic review output'});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(2);
    const call = jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[1][0];
    expect(jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[0][0].purpose).toBe('classification');
    expect(call.purpose).toBe('final_semantic');
    expect(call).toMatchObject({config: {lightModel: 'pinned-primary', apiKey: 'test-only',
      baseURL: 'https://provider.invalid/v1', protocol: 'responses'}});
    if (maxOutputTokens === undefined) expect(call).not.toHaveProperty('maxOutputTokens');
    else expect(call.maxOutputTokens).toBe(maxOutputTokens);
    expect(jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[0][0].maxOutputTokens)
      .toBe(Math.min(maxOutputTokens ?? 2048, 2048));
    expect(call.deadlineMs).toBeLessThanOrEqual(context.deadlineMs);
    expect(call.signal).not.toBe(jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[0][0].signal);
    expect(call.signal?.aborted).toBe(false);
  });
  it('does not restart the original run deadline for semantic review', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-deadline', 'trace', {providerId: null});
    const context = takeContext(result);
    jest.spyOn(Date, 'now').mockReturnValue(context.deadlineMs + 1);
    expect(await context.dispatchText(transportInput())).toEqual({status: 'unavailable', reason: 'timeout'});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
  });
  it('reads the captured row beyond the display preview and denies another trace without querying', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    const store = new ArtifactStore();
    const captured = {columns: ['value'], rows: Array.from({length: 601}, (_, value) => [value])};
    const id = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[0]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    store.registerEvidenceCapture(id, captureEvidenceTable(captured), {evidenceRefId: 'ev-native-captured'});
    const foreignId = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[900]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'another-trace', traceSide: 'current'})});
    store.registerEvidenceCapture(foreignId, captureEvidenceTable({columns: ['value'], rows: [[900]]}), {evidenceRefId: 'ev-foreign'});
    runtime.artifactStores.set('finalization-read', store); prepareStub(runtime); mockRun();
    const readView = jest.spyOn(store, 'createEvidenceReadView');
    const options = {
      providerId: null, runId: 'read-run', tenantId: 'tenant', workspaceId: 'workspace', userId: 'user',
      analysisContextFingerprint: '', codeAwareMode: 'off' as const,
    };
    options.analysisContextFingerprint = contextAuthorization.buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
    const result = await runtime.analyze('query', 'finalization-read', 'trace', options);
    const context = takeContext(result);
    expect(readView.mock.calls[0][0]).toMatchObject({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: expect.any(String),
      currentRunId: context.runId});
    expect(readView.mock.calls[0][0].ownerKey.length).toBeGreaterThan(0);
    const refs = await context.resolveReferences([
      {key: 'full-row', reference: {evidenceRefId: 'ev-native-captured', rowIndex: 600, column: 'value'}, requiredColumns: ['value']},
      {key: 'foreign', reference: {evidenceRefId: 'ev-foreign', rowIndex: 0, column: 'value'}, requiredColumns: ['value']},
    ], new AbortController().signal);
    expect(refs[0]).toMatchObject({status: 'resolved', originalRowIndex: 600, row: {value: 600}});
    expect(refs[1]).toMatchObject({status: 'denied'}); expect(query).not.toHaveBeenCalled();
    const {prepareClaimEvidence} = await import('../../services/evidence/claimEvidencePreparation');
    const {runClaimVerification} = await import('../../services/verifier/claimVerificationRunner');
    const {parseConclusionContractDeclaration} = await import('../../agent/core/conclusionContract');
    // This is the ordinary raw-store CLI path, with no Conversation facade to
    // supply the run ID. The handed-off reader must retain diagnostic authority.
    for (const reference of [
      {evidenceRefId: 'ev-native-captured', rowIndex: 600, column: 'value', value: 999},
      {evidenceRefId: 'ev-invented', rowIndex: 0, column: 'value', value: 999},
    ]) {
      const conclusionContract = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        claims: [{id: 'value', kind: 'numeric', text: 'Value is 999.', references: [reference],
          semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
            discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [reference]},
            numeric: {operator: 'eq', value: 999, unit: 'count'}}}],
      }).contract!;
      const preparedEvidence = await prepareClaimEvidence({conclusionContract,
        evidenceReadView: {resolveReferences: requests => context.resolveReferences(requests, new AbortController().signal)}});
      const verification = runClaimVerification({conclusionContract, preparedEvidence}).claimVerificationResult;
      expect(verification.status).toBe('partial');
      expect(verification.claimResults[0].referenceResults?.[0].status)
        .toBe(reference.evidenceRefId === 'ev-native-captured' ? 'value_mismatch' : 'missing');
      expect(verification.claimResults[0].deterministicProof?.status).not.toBe('proved');
    }
    const futureId = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[999]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    store.registerEvidenceCapture(futureId, captureEvidenceTable({columns: ['value'], rows: [[999]]}), {evidenceRefId: 'ev-next-run'});
    expect((await context.resolveReferences([{key: 'future', reference: {evidenceRefId: 'ev-next-run', rowIndex: 0}, requiredColumns: ['value']}], new AbortController().signal))[0])
      .toMatchObject({status: 'missing'});
    const snapshot = store.serialize();
    store.clear();
    expect((await context.resolveReferences([{key: 'evicted', reference: {evidenceRefId: 'ev-native-captured', rowIndex: 600}, requiredColumns: ['value']}], new AbortController().signal))[0]).toMatchObject({status: 'missing'});
    // Restored artifact metadata supplies neither a witness nor the previous
    // run's authority. A subsequent finalization creates a freshly pinned read.
    const restored = ArtifactStore.fromSnapshot(snapshot);
    runtime.artifactStores.set('finalization-read', restored);
    const restoredView = jest.spyOn(restored, 'createEvidenceReadView');
    mockRun();
    const next = takeContext(await runtime.analyze('next query', 'finalization-read', 'trace', {...options, runId: 'next-read-run'}));
    expect(restoredView.mock.calls[0][0].currentRunId).toBe(next.runId);
    expect(next.runId).not.toBe(context.runId);
    expect((await next.resolveReferences([{key: 'old', reference: {evidenceRefId: 'ev-native-captured', rowIndex: 600}, requiredColumns: ['value']}], new AbortController().signal))[0])
      .toMatchObject({status: 'missing'});
  });
  it('does not invent an evidence reader when the runtime has no artifact store', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-no-store', 'trace', {providerId: null});
    const context = takeContext(result);
    expect(await context.resolveReferences([{key: 'missing', reference: {evidenceRefId: 'anything'}, requiredColumns: []}], new AbortController().signal))
      .toEqual([{key: 'missing', status: 'missing', reason: 'capture_unavailable'}]);
  });
  it('does not grant a Conversation placeholder trace to the evidence reader', async () => {
    const runtime = createOpenAiRuntimeForTest(); const store = new ArtifactStore();
    runtime.artifactStores.set('finalization-no-trace', store); prepareStub(runtime); mockRun();
    const view = jest.spyOn(store, 'createEvidenceReadView');
    const result = await runtime.analyze('query', 'finalization-no-trace', 'conversation-placeholder', {
      providerId: null, assistantSurface: 'conversation', conversationTraceAttached: false,
    });
    const context = takeContext(result);
    expect(context.traceIdentity.currentTraceId).toBeUndefined();
    expect(view.mock.calls[0][0].allowedTraces).toEqual([]);
  });
  it('attaches the privacy-returned context rather than the replaced native one', async () => {
    const sessionId = 'finalization-replaced'; privacySessions.push(sessionId); revokeCodeAwareOutputGuards(sessionId);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    const context = takeContext(result);
    expect(context.deliveryContext).toMatchObject({outputOrigin: 'runtime_fallback', completion: {status: 'unknown',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
    expect(result.completion).toEqual(context.deliveryContext.entry === 'runtime_draft' && context.deliveryContext.completion);
  });
  it('does not attach a fabricated finalization context for setup failure', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime).mockRejectedValue(new Error('setup failure'));
    const result = await runtime.analyze('query', 'finalization-setup-failure', 'trace', {providerId: null});
    expect(result.success).toBe(false); expect(finalization.takeFinalizationContext(result)).toBeUndefined();
  });
});

describe('OpenAI SDK token and storage contracts', () => {
  it.each(['chat_completions', 'responses'] as const)('omits all generation token caps on the actual %s SDK wire when unset', async protocol => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol, maxOutputTokens: undefined});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const nativeAnswer = `complete answer\n${renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], claims: [], relationProposals: [],
      uncertainties: [], nextSteps: []})}`;
    const chatWire = [
      {id: 'uncapped-chat', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {role: 'assistant', content: nativeAnswer}, finish_reason: null}]},
      {id: 'uncapped-chat', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]},
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
    const responseMessage = {id: 'msg-uncapped', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: nativeAnswer, annotations: []}]};
    const responseWire = [
      {type: 'response.created', response: {id: 'resp-uncapped', object: 'response', created_at: 1, model: 'pinned-light', status: 'in_progress', output: []}},
      {type: 'response.output_item.added', output_index: 0, item: responseMessage},
      {type: 'response.output_text.delta', output_index: 0, item_id: 'msg-uncapped', content_index: 0, delta: nativeAnswer},
      {type: 'response.output_item.done', output_index: 0, item: responseMessage},
      {type: 'response.completed', response: {id: 'resp-uncapped', object: 'response', created_at: 1, model: 'pinned-light', status: 'completed', output: [responseMessage], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}},
    ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(protocol === 'responses' ? responseWire : chatWire, {headers: {'content-type': 'text/event-stream'}}));
    const result = await runtime.analyze('query', `uncapped-${protocol}`, 'trace', {providerId: null});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) expect(body).not.toHaveProperty(key);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('complete answer');
    expect(jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[0][0].maxOutputTokens).toBe(2048);
  });

  it('disables provider response storage for private model calls', () => {
    const config = createOpenAiConfigForTest();
    expect(__testing.buildOpenAIModelSettings(config, config.model, false)).toEqual(expect.objectContaining({
      store: false,
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
    }));
    expect(__testing.buildOpenAIModelSettings(config, config.model, true).store).toBe(true);
  });

  it('uses max_completion_tokens for GPT-5.6 Chat Completions without emitting maxTokens', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'gpt-5.6-sol',
    };
    const settings = __testing.buildOpenAIModelSettings(config, config.model, false);

    expect(settings).toEqual({
      providerData: { max_completion_tokens: config.maxOutputTokens },
      parallelToolCalls: false,
      store: false,
    });
    expect(settings).not.toHaveProperty('maxTokens');
  });

  it('keeps maxTokens for GPT-5.6 on the Responses protocol', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      model: 'gpt-5.6-sol',
    };

    expect(__testing.buildOpenAIModelSettings(config, config.model, true)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: true,
    });
  });

  it('serializes the GPT-5.6 token limit through the Agents SDK request boundary', async () => {
    const createCompletion = jest.fn(async (_body: unknown, _options?: unknown) => ({
      id: 'chatcmpl-test',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      }],
      created: 0,
      model: 'gpt-5.6-sol',
      object: 'chat.completion',
    }));
    const model = new OpenAIChatCompletionsModel({
      chat: { completions: { create: createCompletion } },
    } as any, 'gpt-5.6-sol');
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'gpt-5.6-sol',
    };

    await withTrace('OpenAIRuntime token serialization test', async () => {
      await model.getResponse({
        input: [{ role: 'user', content: 'hi' }],
        systemInstructions: 'answer briefly',
        modelSettings: __testing.buildOpenAIModelSettings(config, config.model, false),
        tools: [],
        handoffs: [],
        outputType: 'text',
        tracing: false,
      } as any);
    });

    const requestBody = createCompletion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(requestBody.max_completion_tokens).toBe(config.maxOutputTokens);
    expect(requestBody.max_tokens).toBeUndefined();
    expect(JSON.parse(JSON.stringify(requestBody))).not.toHaveProperty('max_tokens');
  });

  it('keeps maxTokens for legacy Chat Completions models', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'deepseek-v4-pro',
    };

    expect(__testing.buildOpenAIModelSettings(config, config.model, true)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: true,
    });
  });

 });

describe('OpenAI snapshot compatibility', () => {
  it('does not persist stale OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    runtime.sessionMap.set('s1', {
      history: [{ role: 'user', content: 'previous question' }],
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.openAILastResponseId).toBeUndefined();
      expect(snapshot.openAIHistory).toBeUndefined();
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
      }));
      expect(snapshot.engineState?.openai.lastResponseId).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_fresh',
      runState: '{"state":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('resp_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"state":true}');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        openai: {
          history,
          lastResponseId: 'resp_fresh',
          runState: '{"state":true}',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    const history = [{ role: 'user', content: 'previous comparison question' }];
    runtime.sessionMap.set('s1:ref:trace-b', {
      history,
      lastResponseId: 'resp_compare_fresh',
      runState: '{"compare":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        referenceTraceId: 'trace-b',
        comparisonSource: 'raw_trace_pair',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.referenceTraceId).toBe('trace-b');
      expect(snapshot.comparisonSource).toBe('raw_trace_pair');
      expect(snapshot.sdkSessionId).toBe('resp_compare_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_compare_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"compare":true}');
      expect(snapshot.engineState?.kind).toBe('openai-agents-sdk');
      expect(snapshot.engineState?.openai.lastResponseId).toBe('resp_compare_fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('restores OpenAI response mappings with the snapshot timestamp', () => {
    const runtime = createOpenAiRuntimeForTest();
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      engineState: {
        kind: 'openai-agents-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        openai: {
          history: [{ role: 'user', content: 'previous question' }],
          lastResponseId: 'resp_old',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_old',
      updatedAt: snapshotTimestamp,
    }));
  });

  it('restores comparison OpenAI response mappings under the comparison key', () => {
    const runtime = createOpenAiRuntimeForTest();
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      referenceTraceId: 'trace-b',
      comparisonSource: 'raw_trace_pair',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      openAIHistory: [{ role: 'user', content: 'previous comparison question' }],
      openAILastResponseId: 'resp_compare_old',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toBeUndefined();
    expect(runtime.sessionMap.get('s1:ref:trace-b')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_compare_old',
      updatedAt: snapshotTimestamp,
    }));
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_old');
  });

  it('restores explicit OpenAI session mappings under the comparison key', () => {
    const runtime = createOpenAiRuntimeForTest();

    runtime.restoreSessionMapping('s1', 'resp_compare_restored', 'trace-b');

    expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_restored');
  });
});
