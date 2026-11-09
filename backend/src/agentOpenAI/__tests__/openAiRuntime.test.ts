// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {DEFAULT_RUNTIME_CACHE_LIMIT} from '../../agentRuntime/runtimeCache';
import {sessionContextManager} from '../../agent/context/enhancedSessionContext';
import {expectRuntimeLeftTerminalStateToFinalizer} from '../../../tests/helpers/runtimeDraftTerminalState';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {EventEmitter} from 'events';
import {MaxTurnsExceededError, OpenAIChatCompletionsModel, OpenAIResponsesModel, OpenAIProvider, Runner, RunContext, StreamedRunResult, tool, withTrace, type Model, type ModelRequest, type ModelSettings} from '@openai/agents';
import {z} from 'zod';
import {OpenAIRuntime, __testing} from '../openAiRuntime';
import {createAnswerDraftStream, createProjectedAnswerDraft} from '../../agentRuntime/answerDraftStream';
import {createAnswerReasoningFilterState} from '../../agentRuntime/answerReasoningFilter';
import type {AnalysisPlanV3, PlanPhase} from '../../agentv3/types';
import type {SessionStateSnapshot} from '../../agentv3/sessionStateSnapshot';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {chatCompletionResponse, chatCompletionToolCall, createOpenAiConfigForTest} from '../../../tests/helpers/openAiRuntimeFixture';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';
import {createOpenAIToolsFromMcpDefinitions} from '../openAiToolAdapter';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorService} from '../../services/analysisRunTraceProcessorLease';
import {OriginalTraceEvidenceRefusal} from '../../services/originalTraceEvidence';
import type {TraceProcessorLeaseRecord} from '../../services/traceProcessorLeaseStore';
import * as finalization from '../../agentRuntime/analysisFinalizationContext';
import * as runtimeCallStats from '../../services/runtimeCallStats';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {projectPrivateTerminationMessage} from '../../services/security/privateAnalysisProjection';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import * as sourceProjection from '../../services/codebase/sourceClaimVerifier';
import {
  clearCodeAwareOutputGuards, createCodeAwareStreamingTextProjection,
  registerCodeAwareCanary, revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import * as patternMemory from '../../agentv3/analysisPatternMemory';
import * as configModule from '../../agentRuntime/engines/openai/openAiConfig';
import * as intentTransport from '../../agentRuntime/engines/openai/openAiIntentTransport';
import * as reasoningCompat from '../../agentRuntime/engines/openai/mimoReasoningCompat';
import type {AnalysisTurnIntentDecision} from '../../agentRuntime/analysisTurnIntent';
import * as turnIntentRuntime from '../../agentRuntime/analysisTurnIntent';
import * as effectiveSkillRegistry from '../../services/selfEvolution/effectiveRuntimeRegistryProvider';
import * as skillExecutors from '../../services/skillEngine/skillExecutor';
import * as skillLoading from '../../services/skillEngine/skillLoader';
import {beginRawSqlNativeQuery, readRawSqlNativeProvenanceSnapshot} from '../../services/evidence/rawSqlNativeProvenance';
import {createSelectedFoundationFixture, installSelectedNativeSignerMocks} from '../../../tests/helpers/selectedEvidenceFoundationFixture';
import * as systemPrompt from '../../agentv3/claudeSystemPrompt';
import * as focusDetector from '../../agentv3/focusAppDetector';
import * as mcpModule from '../../agentv3/claudeMcpServer';
import * as sceneEntryEvidence from '../../agentRuntime/sceneEntryEvidence';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {renderConclusionContractSidecar, wrapConclusionAuthoringPayload, type ConclusionContract} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createAnalysisHistoryReader, toAnalysisHistoryTurn, withAnalysisHistoryReader} from '../../agentRuntime/analysisHistory';
import {applyFinalResultQualityGate} from '../../services/finalResultQualityGate';
import {createRuntimeSourceFinalizationFixture, SOURCE_FINALIZATION_CANARY, SOURCE_FINALIZATION_RAW_SOURCE} from '../../agentRuntime/__tests__/sourceFinalizationFixture';
import {resolveFocusPackageCell} from '../../agentRuntime/__tests__/focusEvidenceFixture';
import {expectRuntimeVendorHintParity} from '../../agentRuntime/__tests__/vendorHintParityFixture';
import {TRACE_VENDOR_METADATA_SQL} from '../../services/traceVendor/traceVendorResolver';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';
import {createRuntimePerformanceRecorder, type RuntimePerformanceOutcome} from '../../agentRuntime/runtimePerformance';
import * as performanceObservation from '../../agentRuntime/runtimePerformance';
import {createRuntimePerformanceScope} from '../../agentRuntime/runtimePerformanceContext';
import {createRuntimeAdmissionScope} from '../../agentRuntime/runtimeTaskDeadline';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {admitLearnedEntry, withDurableLearningPermission} from '../../services/security/durableLearning';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../../services/enterpriseMigration';
import {admitted} from '../../../tests/helpers/admittedAnalysisOptions';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {resetAnalysisHistoryStoreForTests} from '../../services/analysisHistoryStore';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';

const runtimes: OpenAIRuntime[] = [];
const privacySessions: string[] = [];
const finalizationContexts: finalization.RuntimeFinalizationContext[] = [];
let ownedHistoryFixture: {root: string; previousDbPath: string | undefined} | undefined;
const decision: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'fact', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new',
};
function classify(value: AnalysisTurnIntentDecision = decision) {
  jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({
    status: 'ok', text: JSON.stringify(value), actualModel: 'pinned-light', finishReason: 'stop',
  });
}
const realAdmitDeliveryCall = runtimeCallStats.admitDeliveryCall;
// Mocked providers answer at once inside test-sized deadlines, far below the fixed delivery-call
// estimates; budget skips have their own tests below.
beforeEach(() => {
  jest.spyOn(runtimeCallStats, 'admitDeliveryCall').mockClear().mockImplementation((recorder, input) =>
    realAdmitDeliveryCall(recorder, {...input, failOpen: true}));
  jest.spyOn(configModule, 'loadOpenAIConfig').mockReturnValue(createOpenAiConfigForTest());
  jest.spyOn(intentTransport, 'runOpenAiIntentTransport');
  classify();
});
afterEach(() => {
  for (const context of finalizationContexts.splice(0)) context.dispose();
  for (const runtime of runtimes.splice(0)) runtime.reset();
  for (const sessionId of privacySessions.splice(0)) clearCodeAwareOutputGuards(sessionId);
  jest.restoreAllMocks();
  const fixture = ownedHistoryFixture;
  ownedHistoryFixture = undefined;
  if (fixture) {
    let closed = false;
    try {
      resetAnalysisHistoryStoreForTests();
      closed = true;
    } finally {
      if (fixture.previousDbPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
      else process.env[ENTERPRISE_DB_PATH_ENV] = fixture.previousDbPath;
      // A connection that did not close retains its files for diagnosis.
      if (closed) fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  }
});
/** The delivery context the run handed to finalization (the context is kept for disposal). */
function attachedDeliveryContext(result: Parameters<typeof finalization.takeFinalizationContext>[0]) {
  const context = finalization.takeFinalizationContext(result);
  if (context) finalizationContexts.push(context);
  return context?.deliveryContext;
}

function createOpenAiRuntimeForTest(trace?: TraceProcessorService): any {
  const runtime = new OpenAIRuntime(trace ?? {query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})), getTrace: jest.fn()} as unknown as TraceProcessorService);
  runtimes.push(runtime);
  jest.spyOn(runtime as any, 'recordPatternMemory').mockImplementation(() => undefined);
  return runtime;
}
function emptySnapshot(sessionId: string, traceId: string): SessionStateSnapshot {
  return {version: 1, snapshotTimestamp: Date.now(), sessionId, traceId, conversationSteps: [], queryHistory: [],
    conclusionHistory: [], agentDialogue: [], agentResponses: [], dataEnvelopes: [], hypotheses: [], analysisNotes: [],
    analysisPlan: null, planHistory: [], uncertaintyFlags: [], runSequence: 0, conversationOrdinal: 0};
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
    hypotheses: [], sourceUse,
  }));
}
function responseDone(text: string, status = 'completed') {
  return {type: 'raw_model_stream_event', data: {type: 'response_done', response: {
    output: [{type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]}],
    providerData: {status, ...(status === 'incomplete' ? {incomplete_details: {reason: 'max_output_tokens'}} : {})},
  }}};
}
function sdkStream(text: string, {status = 'completed', nativeText = text, id = 'response-current', events = [] as any[]} = {}) {
  // This fixture's native payload is already materialized. Only projection consumption remains.
  const nativeLoop = Promise.resolve();
  return {currentTurn: 1, finalOutput: text, history: [{role: 'assistant', content: text}], lastResponseId: id,
    state: {}, completed: Promise.resolve(), _getStreamLoopPromise: () => nativeLoop, async *[Symbol.asyncIterator]() {
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
function streamContext(sessionId: string, quickMode: boolean, runtime?: {emitUpdate(update: unknown): void}) {
  return {sessionId, quickMode, answerStreamFilter: createAnswerReasoningFilterState(),
    answerDraft: createProjectedAnswerDraft(createAnswerDraftStream(`${sessionId}-run`, update => runtime?.emitUpdate(update)), undefined),
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
      allowMemoryPrefetch: false, requiresReport: false}, turnIntent: decision});
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
      preflight: 'trace_facts', allowMemoryPrefetch: false}});
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
    const completeness = jest.spyOn(runtime, 'detectCompleteness');
    const run = mockRun();
    const result = await runtime.analyze('compare selected facts', 'fast-pair', 'current', admitted({
      analysisMode: 'fast', providerId: null, referenceTraceId: 'reference', knowledgeSourceIds: ['kb-a'],
    }));
    expect(result.quickRun.requestedMode).toBe('fast');
    expect(focus).toHaveBeenCalled(); expect(architecture).toHaveBeenCalled();
    expect(completeness).toHaveBeenCalled();
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
  // The same best-effort vendor hint as every other runtime: built from the
  // options this runtime passes to the shared MCP factory. The same options
  // carry the run's own learning grant, under which execute_sql learns fixes.
  it('gives the shared MCP tools the vendor hint without a vendor preflight, and the run grant', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify(decision);
    jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    mockRun();
    await runtime.analyze('分析启动性能', 'vendor-hint', 'trace', withDurableLearningPermission(
      {analysisMode: 'full', providerId: null, runId: 'run-openai-mcp'}, NO_PRIVATE_CONTEXT));
    const runtimeOptions = mcp.mock.calls[0][0];
    expect(admitLearnedEntry(runtimeOptions.durableLearning, 1)?.runId).toBe('run-openai-mcp');
    expect(query.mock.calls.some(call => String((call as unknown[])[1]).includes(TRACE_VENDOR_METADATA_SQL))).toBe(false);
    await expectRuntimeVendorHintParity({
      createMcpServer: jest.requireActual<typeof mcpModule>('../../agentv3/claudeMcpServer').createClaudeMcpServer,
      runtimeOptions,
    });
  });
  // Product-owned scene entry evidence settles before the run's MCP server is
  // built, and its segment data reaches the shared prompt context.
  it('collects scene entry evidence before building the MCP server and hands it to the prompt', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify(decision);
    const order: string[] = [];
    const evidence = {status: 'not_run' as const, skillId: 'scrolling_analysis', reason: 'timeout' as const};
    const scene = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt').mockImplementation(async () => {
      order.push('scene_evidence');
      return evidence;
    });
    const actualMcp = jest.requireActual<typeof mcpModule>('../../agentv3/claudeMcpServer').createClaudeMcpServer;
    jest.spyOn(mcpModule, 'createClaudeMcpServer').mockImplementation(options => {
      order.push('mcp_server');
      return actualMcp(options);
    });
    const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    mockRun();
    await runtime.analyze('分析滑动卡顿', 'scene-entry', 'trace', {analysisMode: 'full', providerId: null, runId: 'run-scene-entry'});
    expect(order).toEqual(['scene_evidence', 'mcp_server']);
    expect(scene.mock.calls[0][0]).toMatchObject({runId: 'run-scene-entry', traceId: 'trace',
      turnIntent: expect.objectContaining({sceneId: decision.sceneId}), policy: expect.objectContaining({allowNewEvidence: true})});
    expect(prompt.mock.calls[0][0].sceneEvidence).toEqual(evidence);
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
      jest.spyOn(runtime, 'detectCompleteness').mockResolvedValue(undefined);
      mockRun();
      await runtime.analyze('why is it slow', `focus-${_label}`, 'trace', {analysisMode: 'full', providerId: null});

      expect(mcp.mock.calls[0][0].packageName).toBe(expectedPackage);
      expect(mcp.mock.calls[0][0].focusTarget).toMatchObject({source: expectedSource});
      expect(architecture).toHaveBeenCalledWith('trace', expectedPackage);
      expect(prompt.mock.calls[0][0]).toMatchObject({packageName: expectedPackage,
        focusTarget: {source: expectedSource, confidence: focusResult.confidence}});
      // Only a confident primary becomes a citable current-run evidence row.
      const evidence = prompt.mock.calls[0][0].focusTarget?.evidence;
      if (expectedPackage) {
        expect(evidence).toMatchObject({rowIndex: 0,
          row: {package_name: expectedPackage, detection_method: 'oom_adj', detection_confidence: 'medium'}});
        await expect(resolveFocusPackageCell(mcp.mock.calls[0][0].artifactStore!, evidence!.evidenceRefId, 'trace'))
          .resolves.toMatchObject({status: 'resolved', row: {package_name: expectedPackage}});
      } else {
        expect(evidence).toBeUndefined();
      }
      expect(mcp.mock.calls[0][0].focusTarget?.evidence).toBeUndefined();
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
    const completeness = jest.spyOn(runtime, 'detectCompleteness');
    const run = mockRun();
    const result = await runtime.analyze('question without trace', 'no-trace-conversation', 'no-trace', {
      assistantSurface: 'conversation', conversationTraceAttached: false, analysisMode: 'full', providerId: null,
    });
    expect(query).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(architecture).not.toHaveBeenCalled(); expect(completeness).not.toHaveBeenCalled();
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
    const result = await runtime.analyze('query', 'draft-diagnostic', 'trace', {providerId: null});
    expect(result.completion.status).toBe('completed');
    expect(result.partial).toBeUndefined(); expect(result.terminationReason).toBeUndefined();
    expect(result.conclusion).toBe(body);
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.deliveryAssurance?.claims).not.toBe('passed');
    const context = finalization.takeFinalizationContext(result);
    if (context) finalizationContexts.push(context);
    expect(context?.deliveryContext.entry).toBe('runtime_draft');
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

describe('GLM native reasoning continuity', () => {
  it('roundtrips two actual SDK tool turns without exposing private reasoning or carrying it into the next logical turn', async () => {
    const model = 'glm-5.3-flash';
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      protocol: 'chat_completions', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model, lightModel: model,
      maxTurns: 5, quickMaxTurns: 5, quickTargetTurns: 5,
    }));
    const canary = 'PRIVATE_GLM_REASONING_7162';
    const reasons = [`第一段私有推理：${canary}；先读取首轮指标。`, `第二段私有推理：${canary}；再核对后续指标。`];
    const labels = ['首轮', '次轮'];
    const visible = ['正在读取第一项。', '正在读取第二项。'];
    const finalBody = '两项工具调用已完成。';
    const declaration = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []});
    // Canonical protocol framing keeps this fixture out of declaration repair.
    const nativeAnswer = `${declaration}\n${finalBody}\n`;
    const nextAnswer = `${declaration}\n后续回答。\n`;
    const toolResults = labels.map((label, index) => JSON.stringify({step: index + 1, label, ok: true}));
    const calls = labels.map((label, index) => ({id: `glm-tool-${index + 1}`, type: 'function',
      function: {name: 'read_metric', arguments: JSON.stringify({step: index + 1, label})}}));
    let clock = 0;
    const actualModels = ['glm-actual-first', 'glm-actual-second', 'glm-actual-final', 'glm-actual-followup'];
    const headerWaits = [7, 432, 383, 11];
    const execute = jest.fn(async ({step}: {step: number; label: string}) => {
      // Let the consumer observe response_done before advancing the tool-only clock.
      await new Promise<void>(resolve => setImmediate(resolve));
      clock += 97;
      return toolResults[step - 1];
    });
    const metric = tool({name: 'read_metric', description: 'Read one fixture metric',
      parameters: z.object({step: z.number(), label: z.string()}), execute});
    const {runtime, updates} = createRuntimeWithUpdates();
    prepareStub(runtime).mockImplementation(async (...args: any[]) => ({
      systemPrompt: 'Use the fixture tools, then answer.', tools: [metric], allowedTools: ['read_metric'],
      sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns, hypotheses: [],
    }));
    const requests: Array<{messages: Array<Record<string, any>>}> = [];
    const requestBytes: number[] = [];
    const wire = (turn: number) => {
      const frame = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({
        id: `glm-response-${turn}`, object: 'chat.completion.chunk', created: 1, model: actualModels[turn],
        choices: [{index: 0, delta, finish_reason: finish}],
      })}\n\n`;
      const text = turn < 2 ? frame({role: 'assistant', reasoning_content: reasons[turn].slice(0, 7)}) +
        frame({reasoning_content: reasons[turn].slice(7)}) + frame({content: visible[turn]}) +
        frame({tool_calls: [{index: 0, ...calls[turn], function: {...calls[turn].function,
          arguments: calls[turn].function.arguments.slice(0, 10)}}]}) +
        frame({tool_calls: [{index: 0, function: {arguments: calls[turn].function.arguments.slice(10)}}]}) +
        frame({}, 'tool_calls') : frame({role: 'assistant', content: turn === 2 ? nativeAnswer : nextAnswer}) + frame({}, 'stop');
      const usage = `data: ${JSON.stringify({id: `glm-response-${turn}`, object: 'chat.completion.chunk',
        created: 1, model: actualModels[turn], choices: [], usage: {prompt_tokens: 100 + turn, completion_tokens: 20 + turn}})}\n\n`;
      const bytes = new TextEncoder().encode(text + usage + 'data: [DONE]\n\n');
      // Every Chinese codepoint and SSE line crosses transport chunk boundaries.
      return new Response(new ReadableStream({start(controller) {
        for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      }}), {headers: {'content-type': 'text/event-stream'}});
    };
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input instanceof Request ? input.url : input)).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
      const body = input instanceof Request ? await input.clone().text() : init?.body;
      requests.push(JSON.parse(String(body)));
      requestBytes.push(Buffer.byteLength(String(body)));
      clock += headerWaits[requests.length - 1];
      return wire(requests.length - 1);
    });
    const sessionId = 'glm-native-private';
    const recorder = createRuntimePerformanceRecorder({now: () => clock});
    const scope = createRuntimePerformanceScope({recorder,
      identity: {runId: 'glm-first', sessionId, scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    const first = await scope.run(() => runtime.analyze('读取两项指标。', sessionId, 'conversation-placeholder', {
      providerId: null, runId: 'glm-first', assistantSurface: 'conversation', conversationTraceAttached: false,
    }));
    expect(transport).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(3);
    const measured = recorder.seal();
    expect(measured.modelRequests?.map(item => item.body.bodyBytes)).toEqual(requestBytes);
    expect(measured.modelRequests?.map(item => item.dispatchOrdinal)).toEqual([1, 2, 3]);
    expect(measured.modelRequests?.every(item => item.purpose === 'answer_turn' && item.fetchOutcome === 'headers')).toBe(true);
    expect(measured.modelRequests![1].body.normalized!.components.reasoning).toBeGreaterThan(0);
    expect(measured.modelRequests![2].body.bodyBytes!).toBeGreaterThan(measured.modelRequests![0].body.bodyBytes!);
    const modelCalls = measured.modelCalls!.filter(call => call.purpose === 'answer_turn');
    expect(modelCalls.map(call => call.durationMs)).toEqual(headerWaits.slice(0, 3));
    expect(modelCalls.map(call => call.firstOutputMs)).toEqual(headerWaits.slice(0, 3));
    expect(modelCalls.map(call => call.startOffsetMs)).toEqual(measured.modelRequests!.map(request => request.startOffsetMs));
    expect(modelCalls.map(call => call.model)).toEqual(actualModels.slice(0, 3));
    expect(modelCalls.map(call => call.usage)).toEqual([0, 1, 2].map(turn => ({inputTokens: 100 + turn, outputTokens: 20 + turn,
      reasoningTokens: 0, cachedInputTokens: 0})));
    expect(JSON.stringify(measured)).not.toContain(canary);
    scope.dispose();
    expect(execute.mock.calls.map(call => call[0])).toEqual([{step: 1, label: labels[0]}, {step: 2, label: labels[1]}]);
    const expected = calls.flatMap((call, index) => [
      {role: 'assistant', content: [{type: 'text', text: visible[index], annotations: []}],
        reasoning_content: reasons[index], tool_calls: [call]},
      {role: 'tool', tool_call_id: call.id, content: toolResults[index]},
    ]);
    expect(requests[1].messages.filter(message => ['assistant', 'tool'].includes(message.role))).toEqual(expected.slice(0, 2));
    expect(requests[2].messages.filter(message => ['assistant', 'tool'].includes(message.role))).toEqual(expected);
    expect(first.conclusion).toBe(nativeAnswer);
    expect(first.completion.status).toBe('completed');
    expect(JSON.stringify(updates)).not.toContain(canary);
    expect(updates.filter(update => update.type === 'thought')).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(canary);
    attachedDeliveryContext(first);
    const second = await runtime.analyze('继续解释上一轮。', sessionId, 'conversation-placeholder', {
      providerId: null, runId: 'glm-next', assistantSurface: 'conversation', conversationTraceAttached: false,
    });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(requests[3])).toContain(finalBody);
    expect(JSON.stringify(requests[3])).not.toContain(canary);
    expect(requests[3].messages.some(message => 'reasoning_content' in message || 'reasoning' in message)).toBe(false);
    expect(second.conclusion).toBe(nextAnswer);
    expect(JSON.stringify(updates)).not.toContain(canary);
    attachedDeliveryContext(second);
  });
});

describe('OpenAI attempt-bound model-call timing', () => {
  const declaration = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []});
  const answer = `${declaration}\nA bounded fixture answer.\n`;
  function wire(id: string, model: string, delta: unknown, finish = 'stop', outputTokens = 23) {
    return new Response([
      {id, object: 'chat.completion.chunk', created: 1, model, choices: [{index: 0, delta, finish_reason: null}]},
      {id, object: 'chat.completion.chunk', created: 1, model, choices: [{index: 0, delta: {}, finish_reason: finish}]},
      {id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage: {prompt_tokens: 101, completion_tokens: outputTokens}},
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    {headers: {'content-type': 'text/event-stream'}});
  }
  function configure(overrides: Partial<ReturnType<typeof createOpenAiConfigForTest>> = {}) {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({protocol: 'chat_completions',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-flash', lightModel: 'glm-flash',
      maxTurns: 5, quickMaxTurns: 5, ...overrides}));
  }

  it.each(['retry', 'error', 'cancelled'] as const)('counts SDK fetch %s without manufacturing a completed logical call', async outcome => {
    configure();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createOpenAiRuntimeForTest();
    const sessionId = `fetch-timing-${outcome}`;
    let clock = 0, dispatches = 0;
    const execute = jest.fn(async () => {
      await new Promise<void>(resolve => setImmediate(resolve)); clock += 97; return '{"value":1}';
    });
    const metric = tool({name: 'read_metric', description: 'Read fixture metric', parameters: z.object({}), execute});
    prepareStub(runtime).mockImplementation(async (...args: any[]) => ({systemPrompt: 'Use the metric tool, then answer.',
      tools: [metric], allowedTools: ['read_metric'], hypotheses: [],
      sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns}));
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      dispatches++;
      if (dispatches === 1) {
        clock += 11;
        return wire('first', 'actual-first', {role: 'assistant', tool_calls: [{index: 0, id: 'metric-call',
          type: 'function', function: {name: 'read_metric', arguments: '{}'}}]}, 'tool_calls', 17);
      }
      if (dispatches === 2) {
        clock += 43;
        if (outcome === 'cancelled') {
          runtime.abortSession(sessionId);
          throw new DOMException('Fixture cancellation', 'AbortError');
        }
        return new Response('{"error":{"message":"fixture error"}}', {status: outcome === 'retry' ? 429 : 400,
          headers: {'content-type': 'application/json', 'retry-after-ms': '1'}});
      }
      clock += 79;
      return wire('last', 'actual-last', {role: 'assistant', content: answer}, 'stop', 29);
    });
    const recorder = createRuntimePerformanceRecorder({now: () => clock});
    const scope = createRuntimePerformanceScope({recorder, identity: {runId: sessionId, sessionId,
      scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    try {
      const result = scope.run(() => runtime.analyze('Read the fixture.', sessionId, 'conversation-placeholder', {
        providerId: null, runId: sessionId, assistantSurface: 'conversation', conversationTraceAttached: false}));
      if (outcome === 'cancelled') await expect(result).rejects.toThrow();
      else expect((await result).completion.status).toBe(outcome === 'retry' ? 'completed' : 'failed');
      const measured = recorder.seal(), calls = measured.modelCalls!.filter(call => call.purpose === 'answer_turn');
      expect(transport).toHaveBeenCalledTimes(outcome === 'retry' ? 3 : 2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({durationMs: 11, model: 'actual-first', outcome: 'ok', usage: {outputTokens: 17}});
      expect(calls[1]).toMatchObject({startOffsetMs: 108, durationMs: outcome === 'retry' ? 122 : 43,
        outcome: outcome === 'retry' ? 'ok' : outcome});
      expect(measured.modelRequests).toHaveLength(outcome === 'retry' ? 3 : 2);
      if (outcome === 'retry') expect(calls[1]).toMatchObject({model: 'actual-last', firstOutputMs: 122, usage: {outputTokens: 29}});
    } finally {scope.dispose();}
  });

  it.each(['fresh_signal', 'omitted_signal'] as const)(
    'keeps an actual SDK late fetch on its original attempt with %s', async signalKind => {
      configure({quickPathPerTurnMs: 100, maxRunTimeoutMs: 3_000, streamIdleTimeoutMs: 30});
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(), sessionId = `late-fetch-${signalKind}`;
      prepareStub(runtime).mockImplementation(async (...args: any[]) => {
        // Pre-acquired evidence admits the existing timeout closeout; the test does not change its policy.
        const invocation = {toolCallId: 'fixture-sql', toolName: 'execute_sql', params: {}, extra: {}};
        await args[4].toolObserver({...invocation, phase: 'started'});
        await args[4].toolObserver({...invocation, phase: 'completed', result: {
          content: [{type: 'text', text: '{"columns":["value"],"rows":[[1]],"success":true}'}]}});
        return {systemPrompt: 'Use retained fixture evidence.', tools: [], allowedTools: [], hypotheses: [],
          sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns};
      });
      const releaseOld = createDeferred<void>(), oldForwarded = createDeferred<void>(), oldAborted = createDeferred<void>();
      const newDone = createDeferred<void>(), releaseNew = createDeferred<void>();
      const realCompat = reasoningCompat.createMimoReasoningContentFetch;
      const forwarded: Array<{input: unknown; body: unknown; signal?: AbortSignal}> = [];
      let wireAttempts = 0;
      jest.spyOn(reasoningCompat, 'createMimoReasoningContentFetch').mockImplementation(baseFetch => realCompat(async (input, init) => {
        const ordinal = ++wireAttempts;
        if (ordinal === 1) await releaseOld.promise;
        const options = {...init};
        if (ordinal === 1) {
          // The installed SDK supplies a derived signal. Its identity is deliberately not our attribution key.
          expect((init as RequestInit).signal?.aborted).toBe(true);
          if (signalKind === 'fresh_signal') options.signal = new AbortController().signal;
          else delete options.signal;
        }
        forwarded.push({input, body: options.body, signal: options.signal as AbortSignal | undefined});
        const response = await baseFetch!(input, options);
        if (ordinal === 1) oldForwarded.resolve();
        return response;
      }));
      const nativeStreams: any[] = [];
      const realRun = Runner.prototype.run;
      let attempts = 0;
      jest.spyOn(Runner.prototype as any, 'run').mockImplementation(async function(this: Runner, ...args: any[]) {
        const attempt = ++attempts, runner = this;
        let native: any;
        const nativeReady = createDeferred<any>();
        void nativeReady.promise.catch(() => undefined);
        if (attempt === 1) args[2].signal.addEventListener('abort', () => oldAborted.resolve(), {once: true});
        const start = async () => {
          try {
            native = await (realRun as any).apply(runner, args);
            nativeStreams.push(native); void native.completed.catch(() => undefined);
            nativeReady.resolve(native);
          } catch (error) {nativeReady.reject(error); throw error;}
        };
        // Exercise both run-created and lazy-consume-created SDK async chains.
        if (signalKind === 'fresh_signal') await start();
        return new Proxy({}, {get: (_target, key) => {
          if (key === '_getStreamLoopPromise') return () => nativeReady.promise.then(stream => stream._getStreamLoopPromise());
          if (key === Symbol.asyncIterator) return async function* () {
            if (!native) await start();
            for await (const event of native) {
              yield event;
              if (attempt === 2 && event.type === 'raw_model_stream_event' && event.data?.type === 'response_done') {
                newDone.resolve(); await releaseNew.promise;
              }
            }
          };
          const value = native?.[key];
          return typeof value === 'function' ? value.bind(native) : value;
        }});
      });
      let clock = 0;
      const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        expect(init?.signal?.aborted).toBe(false);
        const late = forwarded.length === 1; // serial drain delivers the aborted old request first
        clock += late ? 777 : 431;
        return wire(late ? 'old' : 'new', late ? 'actual-old' : 'actual-new',
          {role: 'assistant', content: answer}, 'stop', late ? 991 : 23);
      });
      const recorder = createRuntimePerformanceRecorder({now: () => clock});
      const scope = createRuntimePerformanceScope({recorder, identity: {runId: sessionId, sessionId,
        scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
      const pending = scope.run(() => runtime.analyze('Read retained evidence.', sessionId, 'conversation-placeholder', {
        providerId: null, runId: sessionId, assistantSurface: 'conversation', conversationTraceAttached: false}));
      const beforeCompletion = (boundary: Promise<void>) => Promise.race([boundary,
        pending.then(() => {throw new Error('Runtime completed before the expected native SDK boundary');})]);
      try {
        await beforeCompletion(oldAborted.promise);
        expect(attempts).toBe(1);
        expect(wireAttempts).toBe(1);
        releaseOld.resolve(); await beforeCompletion(oldForwarded.promise);
        await beforeCompletion(newDone.promise);
        releaseNew.resolve(); await pending;
        await Promise.allSettled(nativeStreams.map(stream => stream._getStreamLoopPromise()));
        const calls = recorder.seal().modelCalls!.filter(call => call.purpose !== 'classification');
        expect(attempts).toBe(2);
        expect(wireAttempts).toBe(2);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls.map(([input, init]) => [input, init?.body]))
          .toEqual(forwarded.map(item => [item.input, item.body]));
        expect(forwarded[0].signal).toEqual(signalKind === 'fresh_signal' ? expect.any(AbortSignal) : undefined);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({purpose: 'answer_turn', outcome: 'cancelled'});
        expect(calls[1]).toMatchObject({purpose: 'continuation', outcome: 'ok', durationMs: 431,
          model: 'actual-new', usage: {inputTokens: 101, outputTokens: 23}});
        expect(JSON.stringify(calls)).not.toContain('actual-old');
      } finally {releaseOld.resolve(); releaseNew.resolve(); await pending.catch(() => undefined); scope.dispose();}
    });

  it('does not treat repeated SDK starts without response_done as successful calls when fetch is mocked away', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const recorder = createRuntimePerformanceRecorder();
    const scope = createRuntimePerformanceScope({recorder, identity: {runId: 'duplicate-start', sessionId: 'duplicate-start',
      scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    mockRun({...sdkStream(''), currentTurn: 2, async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
      yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
      throw new Error('Fixture stream failure');
    }});
    try {
      const result = await scope.run(() => runtime.analyze('query', 'duplicate-start', 'trace', {providerId: null}));
      expect(result.rounds).toBe(2);
      expect(recorder.seal().modelCalls?.filter(call => call.purpose === 'answer_turn')).toEqual([
        expect.objectContaining({outcome: 'error'}),
      ]);
    } finally {scope.dispose();}
  });
});

describe('OpenAI native drain ownership', () => {
  const frame = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []});
  const nextAnswer = `${frame}\nThe next run completed.\n`;
  const lateAnswer = `${frame}\nLATE_NATIVE_MUST_NOT_PUBLISH\n`;
  const options = {providerId: null, assistantSurface: 'conversation' as const, conversationTraceAttached: false};
  const eventLoopBoundary = () => new Promise<void>(resolve => setImmediate(resolve));

  function configureDrain(protocol: 'chat_completions' | 'responses' = 'chat_completions') {
    jest.useFakeTimers({now: 10_000, doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask']});
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      protocol, quickMaxTurns: 1, quickTargetTurns: 1,
      quickPathPerTurnMs: 1_000, maxRunTimeoutMs: 1_000, streamIdleTimeoutMs: 60_000,
    }));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  }

  /** Captures the installed SDK result without fabricating its lifetime or replacing its iterator. */
  function observeRealStreams() {
    const first = createDeferred<{stream: any; drain: Promise<unknown>}>();
    const drains: Promise<unknown>[] = [];
    const realRun = Runner.prototype.run;
    const run = jest.spyOn(Runner.prototype as any, 'run').mockImplementation(async function(this: Runner, ...args: any[]) {
      const stream = await (realRun as any).apply(this, args);
      const getter = (stream as {_getStreamLoopPromise?: () => unknown})._getStreamLoopPromise;
      expect(typeof getter).toBe('function');
      const drain = getter!.call(stream) as Promise<unknown>;
      expect(drain).toEqual(expect.objectContaining({then: expect.any(Function)}));
      void stream.completed.catch(() => undefined);
      void drain.catch(() => undefined);
      drains.push(drain);
      if (drains.length === 1) first.resolve({stream, drain});
      return stream;
    });
    return {first: first.promise, drains, run};
  }

  function observeProviderPhaseEnds(recorder: ReturnType<typeof createRuntimePerformanceRecorder>) {
    const starts = recorder.startPhase.bind(recorder);
    const ends: Array<jest.Mock<(outcome?: RuntimePerformanceOutcome) => void>> = [];
    jest.spyOn(recorder, 'startPhase').mockImplementation(name => {
      const phase = starts(name);
      if (name !== 'provider') return phase;
      const end = jest.fn(phase.end); ends.push(end);
      return {end};
    });
    return ends;
  }

  /** Exercise the real lease-owner API with no SQLite, processor process or SQL dependency. */
  function leaseFixture(sessionId: string) {
    const controller = new AbortController();
    const scope = {tenantId: 'test', workspaceId: 'test'};
    const trace = {id: 'trace', filename: 'fixture.trace', size: 1, uploadTime: new Date(0), status: 'ready' as const};
    const cleanup = jest.fn(() => true);
    const service = Object.assign(new EventEmitter(), {
      getTrace: (id: string) => id === trace.id ? trace : undefined,
      getTraceFilePath: () => '/fixture/trace', getTraceSourceKind: () => 'local_file',
      getAnalysisRunProcessorPolicy: (_id: string, query?: {leaseId?: string}) => ({sourceKind: 'local_file',
        requiresIsolation: !query?.leaseId, reason: query?.leaseId ? 'trusted' : 'shared_tainted'}),
      ensureProcessorForLease: jest.fn(async () => ({})), cleanupLeaseProcessor: cleanup,
      runWithLeases: async <T>(_contexts: unknown, fn: () => Promise<T>) => fn(),
      prepareOriginalTraceEvidenceReader: () => async () => {throw new OriginalTraceEvidenceRefusal('reader_unavailable');},
      runWithOriginalTraceReader: async <T>(_reader: unknown, fn: () => Promise<T>) => fn(),
    }) as unknown as AnalysisRunTraceProcessorService;
    let record: TraceProcessorLeaseRecord = {id: `lease-${sessionId}`, tenantId: scope.tenantId,
      workspaceId: scope.workspaceId, traceId: 'trace', mode: 'isolated', state: 'pending', rssBytes: null,
      heartbeatAt: 0, expiresAt: null, holderCount: 1, holders: []};
    const transition = (state: TraceProcessorLeaseRecord['state']) => jest.fn(() => (record = {...record, state}));
    const store = {acquireHolder: jest.fn(() => record), releaseHolder: jest.fn(() => record),
      markStarting: transition('starting'), markReady: transition('ready'), markFailed: transition('failed'),
      beginDraining: transition('released'), heartbeatHolder: jest.fn(() => record)};
    return {controller, store, cleanup, input: {service, store, scope, runId: `run-${sessionId}`, sessionId,
      currentTraceId: 'trace', signal: controller.signal, assertCurrent() {},
      ensureBackingMetadata: () => undefined}};
  }

  it.each(['timeout', 'user_cancel'] as const)('R1 keeps real HTTP and owner pending until ignored-abort fetch drains: %s', async trigger => {
    configureDrain();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const recordTurn = jest.spyOn(runtime, 'recordTurn');
    const sessionId = `real-http-drain-${trigger}`;
    const lease = leaseFixture(sessionId);
    const entered = createDeferred<AbortSignal>(), releaseFetch = createDeferred<void>();
    const observed = observeRealStreams();
    let clock = 0;
    const recorder = createRuntimePerformanceRecorder({now: () => clock});
    const providerEnds = observeProviderPhaseEnds(recorder);
    const scope = createRuntimePerformanceScope({recorder, identity: {runId: sessionId, sessionId,
      scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    let fetchSettled = false, executionSettled = false, nativeSettled = false, dispatches = 0;
    let handle: Awaited<ReturnType<typeof prepareAnalysisRunTraceProcessorLeases>> | undefined;
    let outcome: Promise<{value?: any; error?: unknown}> | undefined;
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (++dispatches === 1) {
        const signal = input instanceof Request ? input.signal : init?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        entered.resolve(signal as AbortSignal);
        // Intentionally ignore this real supplied abort signal. No replacement/deletion of it.
        await releaseFetch.promise;
        fetchSettled = true;
        return chatCompletionResponse('old-held-http', {role: 'assistant', content: lateAnswer}, 'stop');
      }
      return chatCompletionResponse('next-http', {role: 'assistant', content: nextAnswer}, 'stop');
    });
    try {
      handle = await prepareAnalysisRunTraceProcessorLeases(lease.input);
      const owned = scope.run(() => handle!.run(() => runtime.analyze('old query', sessionId, 'trace', options)))
        .finally(() => {handle!.release(); executionSettled = true;});
      outcome = owned.then(value => ({value}), error => ({error}));
      const signal = await entered.promise;
      const {stream, drain} = await observed.first;
      void drain.then(() => {nativeSettled = true;}, () => {nativeSettled = true;});
      clock = 100;
      if (trigger === 'timeout') await jest.advanceTimersByTimeAsync(1_001);
      else {
        // Product user cancellation revokes holders immediately; it does not attest native drain.
        lease.controller.abort(new DOMException('User cancelled', 'AbortError'));
        expect(lease.store.releaseHolder).toHaveBeenCalledTimes(1);
        expect(lease.cleanup).toHaveBeenCalledTimes(1);
        await runtime.abortSession(sessionId);
      }
      await stream.completed;
      await eventLoopBoundary();
      expect(signal.aborted).toBe(true);
      expect(fetchSettled).toBe(false);
      expect(nativeSettled).toBe(false); // installed SDK boundary, not a mocked getter
      expect(providerEnds).toHaveLength(1);
      expect(providerEnds[0]).not.toHaveBeenCalled();
      clock = 600; // additional held-native time belongs to provider, not a longer model call
      await eventLoopBoundary();
      expect(providerEnds[0]).not.toHaveBeenCalled();
      if (trigger === 'user_cancel') {
        expect(lease.store.releaseHolder).toHaveBeenCalledTimes(1);
      }
      const independent = await runtime.analyze('independent query', `${sessionId}-other`, 'trace', options);
      expect(independent.completion.status).toBe('completed'); attachedDeliveryContext(independent);
      // Red before the adapter fix: public completed has released this run while real fetch is held.
      expect(executionSettled).toBe(false);
      if (trigger === 'timeout') expect(lease.store.releaseHolder).not.toHaveBeenCalled();
      expect(recordTurn.mock.calls.some(([input]) => (input as any).sessionId === sessionId)).toBe(false);
      await expect(runtime.analyze('blocked successor', sessionId, 'trace', options)).rejects.toThrow('already in progress');
      expect(transport).toHaveBeenCalledTimes(2); // held old HTTP plus the independent session only
      releaseFetch.resolve();
      await drain;
      const result = await outcome;
      expect(providerEnds[0]).toHaveBeenCalledTimes(1);
      const measured = recorder.seal();
      expect(measured.phases.filter(phase => phase.name === 'provider')).toEqual([
        {name: 'provider', startOffsetMs: 0, durationMs: 600, outcome: trigger === 'timeout' ? 'error' : 'cancelled'},
      ]);
      expect(measured.modelCalls?.filter(call => call.purpose === 'answer_turn')).toEqual([
        expect.objectContaining({durationMs: 100, outcome: 'cancelled'}),
      ]);
      if (trigger === 'user_cancel') expect(result.error).toBeDefined();
      else {
        expect(result.value.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
        attachedDeliveryContext(result.value);
      }
      expect(fetchSettled).toBe(true);
      expect(lease.store.releaseHolder).toHaveBeenCalledTimes(1);
      if (trigger === 'user_cancel') expect(lease.cleanup).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(updates)).not.toContain('LATE_NATIVE_MUST_NOT_PUBLISH');
      expect(recordTurn.mock.calls.some(([input]) => String((input as any).result?.conclusion).includes('LATE_NATIVE_MUST_NOT_PUBLISH'))).toBe(false);
      const successor = await runtime.analyze('successor after drain', sessionId, 'trace', options);
      expect(successor.completion.status).toBe('completed'); attachedDeliveryContext(successor);
      expect(transport).toHaveBeenCalledTimes(3);
    } finally {
      releaseFetch.resolve();
      await Promise.allSettled(observed.drains);
      await outcome;
      handle?.release();
      scope.dispose();
      jest.useRealTimers();
    }
  });

  it.each(['timeout', 'user_cancel'] as const)('R2 waits for an already-started shared-registry tool and its real SDK loop: %s', async trigger => {
    configureDrain();
    const {runtime, updates} = createRuntimeWithUpdates();
    const recordTurn = jest.spyOn(runtime, 'recordTurn');
    const sessionId = `real-shared-tool-drain-${trigger}`;
    const entered = createDeferred<AbortSignal>(), releaseTool = createDeferred<void>();
    const observed = observeRealStreams();
    let clock = 0;
    const recorder = createRuntimePerformanceRecorder({now: () => clock});
    const providerEnds = observeProviderPhaseEnds(recorder);
    const scope = createRuntimePerformanceScope({recorder, identity: {runId: sessionId, sessionId,
      scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    let handlerSettled = false, nativeSettled = false, executionSettled = false;
    let outcome: Promise<{value?: any; error?: unknown}> | undefined;
    const handler = jest.fn(async (_args: Record<string, unknown>, extra: {signal?: AbortSignal}) => {
      expect(extra.signal).toBeInstanceOf(AbortSignal);
      await eventLoopBoundary(); // let the real native response_done freeze this model call's usage/time
      entered.resolve(extra.signal!);
      try {
        await releaseTool.promise; // started shared work is not replaced by an abort-racing fake completion
        return {content: [{type: 'text' as const, text: 'LATE_SHARED_TOOL_MUST_NOT_PUBLISH'}]};
      } finally {handlerSettled = true;}
    });
    prepareStub(runtime).mockImplementation(async (...args: any[]) => {
      const registry = new McpToolRegistry({requestScope: {sessionId: args[1], hasCodebaseAccess: false, allowNewEvidence: true},
        runId: args[4].runId, runAuthorization: args[4].runAuthorization, canInvokeTool: args[4].isActive,
        toolObserver: args[4].toolObserver});
      registry.registerShared({name: 'read_drain_fixture', description: 'Read a lifecycle fixture', inputSchema: {},
        exposure: 'public', evidenceEffect: 'acquire', handler});
      return {systemPrompt: 'Read the shared fixture, then answer.', tools: createOpenAIToolsFromMcpDefinitions(registry.list()),
        allowedTools: ['read_drain_fixture'], hypotheses: [], sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns};
    });
    const transport = jest.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => {
        clock = 31;
        const chunk = {id: 'held-shared-tool', object: 'chat.completion.chunk', created: 1, model: 'actual-tool-model'};
        return new Response([
          {...chunk, choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0,
            id: 'held-shared-tool-call', type: 'function', function: {name: 'read_drain_fixture', arguments: '{}'}}]}, finish_reason: null}]},
          {...chunk, choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]},
          {...chunk, choices: [], usage: {prompt_tokens: 101, completion_tokens: 23}},
        ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
        {headers: {'content-type': 'text/event-stream'}});
      })
      .mockImplementation(async () => chatCompletionResponse('after-tool-drain', {role: 'assistant', content: nextAnswer}, 'stop'));
    try {
      const pending = scope.run(() => runtime.analyze('old query', sessionId, 'trace', options))
        .finally(() => {executionSettled = true;});
      const settled: Promise<{value?: any; error?: unknown}> = pending.then((value: any) => ({value}), (error: unknown) => ({error}));
      outcome = settled;
      const signal = await entered.promise;
      const {stream, drain} = await observed.first;
      void drain.then(() => {nativeSettled = true;}, () => {nativeSettled = true;});
      clock = 100;
      if (trigger === 'timeout') await jest.advanceTimersByTimeAsync(1_001);
      else await runtime.abortSession(sessionId);
      await stream.completed;
      await eventLoopBoundary();
      expect(signal.aborted).toBe(true);
      expect(handlerSettled).toBe(false);
      expect(nativeSettled).toBe(false);
      expect(providerEnds).toHaveLength(1);
      expect(providerEnds[0]).not.toHaveBeenCalled();
      clock = 600;
      await eventLoopBoundary();
      expect(providerEnds[0]).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1); // no new turn while old shared work remains pending
      // Red before the adapter fix: runtime owner drains independently of the still-running handler.
      expect(executionSettled).toBe(false);
      expect(recordTurn).not.toHaveBeenCalled();
      await expect(runtime.analyze('blocked successor', sessionId, 'trace', options)).rejects.toThrow('already in progress');
      releaseTool.resolve();
      await drain;
      const result = await settled;
      expect(providerEnds[0]).toHaveBeenCalledTimes(1);
      const measured = recorder.seal();
      expect(measured.phases.filter(phase => phase.name === 'provider')).toEqual([
        {name: 'provider', startOffsetMs: 0, durationMs: 600, outcome: trigger === 'timeout' ? 'error' : 'cancelled'},
      ]);
      expect(measured.modelCalls?.filter(call => call.purpose === 'answer_turn')).toEqual([
        expect.objectContaining({model: 'actual-tool-model', durationMs: 31,
          usage: {inputTokens: 101, outputTokens: 23, reasoningTokens: 0, cachedInputTokens: 0}}),
      ]);
      expect(handlerSettled).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      if (trigger === 'user_cancel') expect(result.error).toBeDefined();
      else {
        expect(result.value.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
        attachedDeliveryContext(result.value);
      }
      expect(JSON.stringify(updates)).not.toContain('LATE_SHARED_TOOL_MUST_NOT_PUBLISH');
      const successor = await runtime.analyze('successor after drain', sessionId, 'trace', options);
      expect(successor.completion.status).toBe('completed'); attachedDeliveryContext(successor);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      releaseTool.resolve();
      await Promise.allSettled(observed.drains);
      await outcome;
      scope.dispose();
      jest.useRealTimers();
    }
  });

  it.each(['native', 'consumer'] as const)('drains the other operation when the known %s promise rejects first', async rejects => {
    configureDrain('responses');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const entered = createDeferred<void>(), consumerGate = createDeferred<void>(), native = createDeferred<void>();
    void native.promise.catch(() => undefined);
    const stream = {...sdkStream(nextAnswer), _getStreamLoopPromise: () => native.promise,
      async *[Symbol.asyncIterator]() {
        entered.resolve();
        if (rejects === 'consumer') throw new Error('consumer fixture rejected');
        await consumerGate.promise;
        yield responseDone(nextAnswer);
      }};
    const run = mockRun(stream);
    let settled = false;
    const pending: Promise<any> = runtime.analyze('query', `all-settled-${rejects}`, 'trace', options)
      .finally(() => {settled = true;});
    void pending.catch(() => undefined);
    try {
      await entered.promise;
      if (rejects === 'native') {native.reject(new Error('known native rejection')); await jest.advanceTimersByTimeAsync(1_001);}
      await eventLoopBoundary();
      expect((run.mock.calls[0][2] as {signal: AbortSignal}).signal.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(runtime.nativeDrainContractFault).toBeUndefined();
      await expect(runtime.analyze('blocked', `all-settled-${rejects}`, 'trace', options)).rejects.toThrow('already in progress');
      if (rejects === 'native') consumerGate.resolve(); else native.resolve();
      const result = await pending;
      expect(result.completion).toMatchObject(rejects === 'native'
        ? {status: 'incomplete', reason: 'timeout'} : {status: 'failed', reason: 'provider_error'});
      attachedDeliveryContext(result);
      run.mockResolvedValue(sdkStream(nextAnswer));
      const next = await runtime.analyze('after known failure', `all-settled-${rejects}`, 'trace', options);
      expect(next.completion.status).toBe('completed'); attachedDeliveryContext(next);
    } finally {
      consumerGate.resolve(); native.resolve();
      await pending.catch(() => undefined);
      jest.useRealTimers();
    }
  });

  it('releases a known failed SDK startup without poisoning the adapter', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValueOnce(new Error('known startup failure')).mockResolvedValue(sdkStream(nextAnswer));
    const failed = await runtime.analyze('query', 'failed-startup-drain', 'trace', options);
    expect(failed.completion).toMatchObject({status: 'failed', reason: 'provider_error'});
    expect(runtime.nativeDrainContractFault).toBeUndefined();
    const next = await runtime.analyze('after startup failure', 'failed-startup-drain', 'trace', options);
    expect(next.completion.status).toBe('completed'); attachedDeliveryContext(next);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects an unsupported installed SDK before any native dispatch without poisoning a healthy retry', async () => {
    const prototype = StreamedRunResult.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, '_getStreamLoopPromise')!;
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(sdkStream(nextAnswer));
    try {
      Object.defineProperty(prototype, '_getStreamLoopPromise', {configurable: true, value: undefined});
      await expect(runtime.analyze('query', 'unsupported-sdk', 'trace', options)).rejects
        .toMatchObject({code: 'OPENAI_SDK_NATIVE_DRAIN_UNAVAILABLE'});
      expect(run).not.toHaveBeenCalled();
      expect(runtime.nativeDrainContractFault).toBeUndefined();
    } finally {Object.defineProperty(prototype, '_getStreamLoopPromise', descriptor);}
    const next = await runtime.analyze('supported now', 'unsupported-sdk', 'trace', options);
    expect(next.completion.status).toBe('completed'); attachedDeliveryContext(next);
  });

  it.each(['missing', 'throws', 'nonpromise'] as const)('fails closed across reset when a dispatched stream has %s native drain', async kind => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const malformed: any = sdkStream(nextAnswer);
    if (kind === 'missing') delete malformed._getStreamLoopPromise;
    else malformed._getStreamLoopPromise = kind === 'throws'
      ? () => {throw new Error('PRIVATE_BAD_GETTER');} : () => undefined;
    const run = mockRun(malformed);
    const sessionId = `unknown-drain-${kind}`;
    const recorder = createRuntimePerformanceRecorder();
    const scope = createRuntimePerformanceScope({recorder, identity: {runId: sessionId, sessionId,
      scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}});
    let error: any;
    try {await scope.run(() => runtime.analyze('query', sessionId, 'trace', options));}
    catch (caught) {error = caught;}
    finally {scope.dispose();}
    expect(error).toMatchObject({code: 'OPENAI_SDK_NATIVE_DRAIN_UNAVAILABLE'});
    expect(recorder.seal().phases.filter(phase => phase.name === 'provider')).toEqual([
      expect.objectContaining({name: 'provider', outcome: 'error'}),
    ]);
    expect(error.message).toContain('restart this process');
    expect(error.message).not.toContain('PRIVATE_BAD_GETTER');
    expect(() => runtime.executionGuard.begin({runtime: 'openai-agents-sdk', sessionId})).toThrow('already in progress');
    runtime.abortSession(sessionId); runtime.reset();
    for (const blocked of [sessionId, `${sessionId}-other`]) {
      await expect(runtime.analyze('blocked', blocked, 'trace', options)).rejects
        .toMatchObject({code: 'OPENAI_SDK_NATIVE_DRAIN_UNAVAILABLE'});
    }
    expect(run).toHaveBeenCalledTimes(1);
    const healthy = createOpenAiRuntimeForTest(); prepareStub(healthy); run.mockResolvedValue(sdkStream(nextAnswer));
    const next = await healthy.analyze('healthy instance', `${sessionId}-healthy`, 'trace', options);
    expect(next.completion.status).toBe('completed'); attachedDeliveryContext(next);
  });

  it('keeps a completed candidate when native drain exhausts the absolute deadline before planned repair', async () => {
    configureDrain();
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      quickMaxTurns: 3, quickPathPerTurnMs: 1_000, maxRunTimeoutMs: 3_000, streamIdleTimeoutMs: 60_000,
    }));
    const body = 'The original completed candidate remains.';
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const native = createDeferred<void>(), fenced = createDeferred<void>();
    const run = mockRun().mockImplementation(async (_agent: unknown, _input: unknown, rawOptions: unknown) => {
      const options = rawOptions as {signal: AbortSignal};
      options.signal.addEventListener('abort', () => fenced.resolve(), {once: true});
      return {...sdkStream(body), history: [{role: 'user', content: 'query'}, {role: 'assistant', content: body}],
        _getStreamLoopPromise: () => native.promise};
    });
    let settled = false;
    const pending: Promise<any> = runtime.analyze('query', 'post-drain-hard-cap', 'trace', {...options, taskTimeoutMs: 3_000})
      .finally(() => {settled = true;});
    void pending.catch(() => undefined);
    try {
      await fenced.promise;
      expect(settled).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3_001);
      native.resolve();
      const result = await pending;
      expect(result.conclusion).toBe(body);
      expect(result.completion).toMatchObject({status: 'completed'});
      expect(run).toHaveBeenCalledTimes(1); // no recovery dispatch with zero remaining time
      const context = finalization.takeFinalizationContext(result)!; finalizationContexts.push(context);
      expect(context.deadlineMs).toBeLessThanOrEqual(Date.now());
      expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1); // classification only
    } finally {native.resolve(); await pending.catch(() => undefined); jest.useRealTimers();}
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
    mockRun({...sdkStream('late'), history: [], _getStreamLoopPromise: () => release.promise, async *[Symbol.asyncIterator]() {
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
  it('signals cancellation immediately but owns delayed provider creation until its native lifetime arrives', async () => {
    const entered = createDeferred<AbortSignal>(); const creation = createDeferred<ReturnType<typeof sdkStream>>();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun().mockImplementation((_agent: unknown, _input: unknown, rawOptions: unknown) => {
      const options = rawOptions as {signal: AbortSignal};
      entered.resolve(options.signal); return creation.promise;
    });
    let settled = false;
    const pending = runtime.analyze('query', 'cancel-stalled-provider', 'trace', {providerId: null});
    void pending.then(() => {settled = true;}, () => {settled = true;});
    const rejected = expect(pending).rejects.toThrow();
    try {
      const signal = await entered.promise;
      runtime.abortSession('cancel-stalled-provider');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(signal.aborted).toBe(true);
      expect(settled).toBe(false);
      await expect(runtime.analyze('blocked', 'cancel-stalled-provider', 'trace', {providerId: null})).rejects.toThrow('already in progress');
      creation.resolve(sdkStream('late creation'));
      await rejected;
    } finally {creation.resolve(sdkStream('late creation')); await pending.catch(() => undefined);}
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
    const aborted = createDeferred<void>(); const creation = createDeferred<ReturnType<typeof sdkStream>>();
    const run = mockRun().mockImplementation((_agent: unknown, _input: unknown, rawOptions: unknown) => {
      const options = rawOptions as {signal: AbortSignal};
      options.signal.addEventListener('abort', () => aborted.resolve(), {once: true});
      return creation.promise;
    });
    const pending = runtime.analyze('query', 'timeout', 'trace', {providerId: null});
    try {
      await aborted.promise;
      creation.resolve(sdkStream('late creation'));
      const result = await pending;
      expect(run).toHaveBeenCalledTimes(1); expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(result.conclusion).toBe(''); expect(result.partial).toBe(true);
    } finally {creation.resolve(sdkStream('late creation')); await pending.catch(() => undefined);}
  });

  describe('run budget on a slow but producing endpoint (Round 60 SP-E2E-08)', () => {
    // base budget 100 ms × 3 turns = 300 ms; maximum 3 s; delivery reserve 500 ms
    const slowConfig = () => ({...createOpenAiConfigForTest(), quickPathPerTurnMs: 100, quickMaxTurns: 3,
      maxRunTimeoutMs: 3_000, streamIdleTimeoutMs: 60_000});
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const toolOutput = (callId: string) => ({type: 'run_item_stream_event', name: 'tool_output',
      item: {rawItem: {callId, name: 'execute_sql', output: '{"success":true}'}}});
    const untilAbort = (signal: AbortSignal) => new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), {once: true});
    });
    function streamOf(events: (signal: AbortSignal) => AsyncGenerator<any>, text = '') {
      return async (_agent: unknown, _input: unknown, rawOptions: unknown) => {
        const options = rawOptions as {signal: AbortSignal};
        const nativeLoop = createDeferred<void>();
        return {...sdkStream(text), lastResponseId: 'slow', _getStreamLoopPromise: () => nativeLoop.promise,
          async *[Symbol.asyncIterator]() {
            try {yield* events(options.signal);} finally {nativeLoop.resolve();}
          }};
      };
    }
    function prepareWithReturnedData(runtime: any) {
      return prepareStub(runtime).mockImplementation(async (...args: any[]) => {
        const invocation = {toolCallId: 'slow-sql', toolName: 'execute_sql', params: {}, extra: {}};
        await args[4].toolObserver({...invocation, phase: 'started'});
        await args[4].toolObserver({...invocation, phase: 'completed', result: {
          content: [{type: 'text', text: JSON.stringify({columns: ['dur'], rows: [[195]], success: true})}]}});
        return {systemPrompt: 'test system prompt', tools: [], allowedTools: [], hypotheses: [],
          sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns};
      });
    }
    const budgetLine = (warn: jest.SpiedFunction<typeof console.warn>) =>
      warn.mock.calls.map(call => String(call[0])).find(line => line.startsWith('[OpenAIRuntime] run budget:')) ?? '';

    it('keeps investigating past the base budget while tool results keep returning', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun().mockImplementation(streamOf(async function* () {
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
      const run = mockRun().mockImplementation(streamOf(async function* () {
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

    it.each([
      ['https://api.deepseek.com/v1', 'responses', {reasoning: {effort: 'none'}}, undefined],
      ['https://gateway.example/v1', 'responses', undefined, undefined],
      ['https://api.deepseek.com/v1', 'responses', {reasoning: {effort: 'none'}}, 'low'],
      ['https://gateway.example/v1', 'responses', undefined, 'low'],
    ] as const)('delivers returned data after timeout with provider-aware closeout controls: %s %s %s %s', async (baseURL, protocol, controls, analysisReasoningEffort) => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...slowConfig(), baseURL, protocol,
        model: 'deepseek-flash', lightModel: 'deepseek-flash', analysisReasoningEffort});
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const recorder = createRuntimePerformanceRecorder();
      const sink = {identity: {runId: 'timeout-run', sessionId: 'timeout-delivery', scope: {tenantId: 't', workspaceId: 'w'}},
        runtimePerformanceRecorder: recorder, recordScene: jest.fn(), recordRuntime: jest.fn(), recordMode: jest.fn(),
        recordAdaptiveRouting: jest.fn(), recordCapabilityManifest: jest.fn(), recordSkillRegistry: jest.fn(),
        startSkillInvocation: jest.fn(() => 'skill-invocation'), finishSkillInvocation: jest.fn(),
        recordUnknownSkillInvocation: jest.fn(), recordSqlStatement: jest.fn(), recordPromptTemplate: jest.fn(),
        recordInjection: jest.fn(), recordToolAllowlist: jest.fn(), recordTurn: jest.fn(),
      } as unknown as RunManifestAttributionSink;
      const runtime = createOpenAiRuntimeForTest(); prepareWithReturnedData(runtime);
      const run = mockRun().mockImplementationOnce(streamOf(async function* (signal) {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield toolOutput('slow-0');
        await untilAbort(signal);
      })).mockResolvedValueOnce(sdkStream('Main thread waited 195 ms; the owner is not established.'));
      const startedAt = Date.now();
      const result = await runtime.analyze('query', 'timeout-delivery', 'trace',
        {analysisMode: 'fast', providerId: null, runManifestAttributionSink: sink});
      expect(run).toHaveBeenCalledTimes(2);
      expect((run.mock.calls[1][0] as any).tools).toEqual([]);
      expect(run.mock.calls[1][2]).toMatchObject({maxTurns: 1});
      expect(run.mock.calls[1][2]).not.toHaveProperty('previousResponseId');
      const mainSettings = (run.mock.calls[0][0] as any).modelSettings;
      const closeoutSettings = (run.mock.calls[1][0] as any).modelSettings;
      expect(mainSettings.providerData ?? {}).not.toHaveProperty('thinking');
      expect(mainSettings.providerData ?? {}).not.toHaveProperty('reasoning');
      expect(mainSettings.reasoning).toEqual(analysisReasoningEffort ? {effort: analysisReasoningEffort} : undefined);
      expect(closeoutSettings.reasoning).toEqual(controls?.reasoning);
      expect(closeoutSettings.providerData).toEqual(mainSettings.providerData);
      expect(recorder.seal().modelCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({purpose: 'answer_turn', reasoning: analysisReasoningEffort ? 'enabled' : 'provider_default', outcome: 'cancelled'}),
        expect.objectContaining({purpose: 'continuation', trigger: 'timeout',
          reasoning: controls ? 'disabled' : 'provider_default', outcome: 'ok'}),
      ]));
      const prompt = (run.mock.calls[1][1] as any[])[0].content;
      expect(prompt).toContain('本轮调查已耗尽预算（timeout：');
      expect(prompt).toContain('"rows":[[195]]');
      expect(result).toMatchObject({partial: true, terminationReason: 'timeout',
        conclusion: 'Main thread waited 195 ms; the owner is not established.',
        completion: {status: 'incomplete', reason: 'timeout'}});
      expect(result.terminationMessage).toContain('调查时间预算已耗尽');
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      // evidence reads keep a reserve after an exhausted budget
      expect(context.deadlineMs).toBeLessThanOrEqual(startedAt + 3_000);
      expect(context.deadlineMs - Date.now()).toBeGreaterThanOrEqual(50);
      expect(budgetLine(warn)).toContain('timeoutDelivery=delivered');
    });

    it('restores the empty result when the delivery call also runs out of time', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareWithReturnedData(runtime);
      const run = mockRun().mockImplementationOnce(streamOf(async function* (signal) {
        yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
        yield toolOutput('slow-0');
        await untilAbort(signal);
      })).mockImplementationOnce(async (_agent: unknown, _input: unknown, rawOptions: unknown) => {
        const options = rawOptions as {signal: AbortSignal};
        await untilAbort(options.signal); return sdkStream('late delivery');
      });
      const result = await runtime.analyze('query', 'timeout-delivery-failed', 'trace', {analysisMode: 'fast', providerId: null});
      expect(run).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({conclusion: '', partial: true, completion: {status: 'incomplete', reason: 'timeout'}});
      expect(budgetLine(warn)).toContain('timeoutDelivery=restored');
    });

    it('does not start a delivery call when nothing returned', async () => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(slowConfig());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun().mockImplementation(async (_agent: unknown, _input: unknown, rawOptions: unknown) => {
        const options = rawOptions as {signal: AbortSignal};
        await untilAbort(options.signal); return sdkStream('late creation');
      });
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
    const run = mockRun().mockResolvedValueOnce({...sdkStream(''), currentTurn: 50, history,
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
  });

  it.each(['missing', 'pending-call', 'no-user', 'oversized', 'unreadable'])
  ('uses bounded returned-data context when native history is %s', async condition => {
    const config = createOpenAiConfigForTest();
    if (condition === 'oversized') config.maxHistoryBytes = 32;
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(config);
    const history: any[] = condition === 'no-user' ? [] : [{role: 'user', content: 'The original question with enough content.'}];
    if (condition === 'pending-call') history.push({type: 'function_call', callId: 'pending', name: 'execute_sql', arguments: '{}'});
    const state = condition === 'missing' ? undefined : condition === 'unreadable'
      ? {get history() {throw new Error('unreadable');}} : {history};
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValueOnce(new MaxTurnsExceededError('cap', state as any))
      .mockResolvedValueOnce(sdkStream('Investigation incomplete. No root cause is established.'));
    const result = await runtime.analyze('query', 'cap-denied', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2]).not.toHaveProperty('previousResponseId');
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    expect(JSON.stringify(run.mock.calls[1][1])).toContain('current_run_returned_data_excerpts');
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
        sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns};
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
    expect(context).not.toHaveProperty('getNativeDeclaration');
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
  it('ends the run when authorization changes during a turn-limit summary', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValueOnce(new MaxTurnsExceededError('cap'))
      .mockResolvedValueOnce(sdkStream('A summary that must not be accepted after revocation.'));
    const currentAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (run.mock.calls.length >= 2) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return currentAuthorization(...args);
    });
    await expect(runtime.analyze('query', 'cap-summary-revoked', 'trace', admitted({analysisMode: 'fast', providerId: null,
      codeAwareMode: 'provider_send', codebaseIds: ['codebase-a']}))).rejects.toThrow('analysis_context_changed_restart_required');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('starts a fresh physical response and injects typed partial history instead of opaque SDK state', async () => {
    const runtime = createOpenAiRuntimeForTest(); const prepare = prepareStub(runtime);
    // A snapshot written before runs stopped persisting SDK state still restores.
    runtime.restoreFromSnapshot('retry', 'trace', {...emptySnapshot('retry', 'trace'), agentRuntimeKind: 'openai-agents-sdk',
      openAIHistory: [{role: 'user', content: 'opaque prior'}], openAILastResponseId: 'expired', openAIRunState: 'opaque state'});
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
    expect(JSON.stringify(run.mock.calls[0])).not.toMatch(/expired|opaque prior|opaque state/);
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

  it('does not turn an undecodable authoring candidate into a whole-answer continuation', async () => {
    const native = `Body remains.\n${wrapConclusionAuthoringPayload('{"authoringVersion":"unsupported"}')}`;
    const {runtime} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValue(recoverableStream(native, 'completed'));
    const result = await runtime.analyze('query', 'authoring-unrecoverable', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.completion.status).toBe('completed');
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('invalid');
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context).not.toHaveProperty('getNativeDeclaration');
  });

  it('continues a completed reply that carries only a declaration before finalization', async () => {
    const complete = `The marker is present.\n${protocolSidecar}`;
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(protocolSidecar, 'completed'))
      .mockResolvedValueOnce(recoverableStream(complete, 'completed'));
    const result = await runtime.analyze('query', 'protocol-recovery-sidecar-only', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(2);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('The marker is present.');
    expect(result.completion).toMatchObject({status: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context).not.toHaveProperty('getNativeDeclaration');
    const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
    expect(diagnostic.map(value => [value.stage, value.candidateIndex, value.status])).toEqual([
      ['native', 1, 'valid'], ['native', 2, 'valid'], ['runtime_projected', 2, 'valid'],
    ]);
    expect((run.mock.calls[1][0] as any).tools).toEqual([]);
    const recoveryHistory = run.mock.calls[1][1] as Array<{role?: string; content?: unknown}>;
    const recoveryPrompt = String(recoveryHistory[recoveryHistory.length - 1].content);
    // A reply without a body gets a full-answer continuation, never a declaration request.
    expect(recoveryPrompt).toContain('empty_body');
    expect(recoveryPrompt).not.toMatch(/declaration/i);
  });

  it.each(['plain', 'stray-invalid-declaration'])('issues no repair call for a completed %s answer', async kind => {
    const first = kind === 'plain' ? 'The marker is present.'
      : `The marker is present.\n${protocolSidecar.replace('"focused_answer"', '"invalid-mode"')}`;
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockResolvedValueOnce(recoverableStream(first, 'completed'))
      .mockResolvedValueOnce(recoverableStream('Must not run.', 'completed'));
    const result = await runtime.analyze('query', `no-repair-${kind}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(jest.mocked(runtimeCallStats.admitDeliveryCall)).not.toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({purpose: 'declaration_repair'}));
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('The marker is present.');
    expect(result.completion.status).toBe('completed');
    expect(result.terminationMessage).toBeUndefined();
    finalizationContexts.push(finalization.takeFinalizationContext(result)!);
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
      hypotheses: [],
    }));
    const wire = chatCompletionResponse;
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(wire('source-call', {role: 'assistant', tool_calls: [{index: 0, id: 'source-call-1', type: 'function', function: {name: 'read_codebase_file', arguments: '{}'}}]}, 'tool_calls'))
      .mockResolvedValueOnce(wire('limited-answer', {role: 'assistant', content: 'The source begins'}, maxTurns === 2 ? 'stop' : 'length'))
      .mockResolvedValueOnce(wire('complete-answer', {role: 'assistant', content: 'The complete answer uses the source already read.'}, 'stop'));
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization');
    const updates: any[] = []; runtime.on('update', (update: unknown) => updates.push(update));
    const result = await runtime.analyze('query', 'source-output-recovery', 'trace', admitted({
      providerId: null, analysisMode: 'full', codeAwareMode: 'provider_send', codebaseIds: ['codebase-a'], runId: 'recovery-run',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(maxTurns);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorization).toHaveBeenCalledWith(expect.objectContaining({codebaseIds: ['codebase-a'], runId: 'recovery-run'}),
      expect.any(Object), expect.stringMatching(/^acf2:[a-f0-9]{64}$/));
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

  it.each(['output_limit', 'empty_body'] as const)('keeps %s recovery on the investigation deadline', async kind => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const first = recoverableStream(kind === 'empty_body' ? protocolSidecar : 'Original incomplete answer.',
      kind === 'empty_body' ? 'completed' : 'incomplete');
    const start = Date.now();
    const originalStream = first[Symbol.asyncIterator];
    first[Symbol.asyncIterator] = async function* () {
      yield* originalStream();
      // Default test configuration: investigation 60 s, hard deadline 120 s.
      // A completed-answer repair could use the reserve here; these cannot.
      jest.spyOn(Date, 'now').mockReturnValue(start + 90_000);
    };
    const run = mockRun(first);
    const result = await runtime.analyze('query', `no-reserve-${kind}`, 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim())
      .toBe(kind === 'empty_body' ? '' : 'Original incomplete answer.');
    expect(runtimeCallStats.admitDeliveryCall).not.toHaveBeenCalled();
  });

  it('ends the run instead of redispatching already-read private context after authorization changes', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions', maxTurns: 3});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    let revoked = false;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      revoked = true; // The partial answer quotes source; consent is withdrawn before the recovery request.
      return chatCompletionResponse('partial', {role: 'assistant', content: 'original partial answer'}, 'length');
    }).mockResolvedValue(chatCompletionResponse('recovered', {role: 'assistant', content: 'Must never be requested.'}, 'stop'));
    const real = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return real(...args);
    });
    await expect(runtime.analyze('query', 'revoked-recovery', 'trace', admitted({providerId: null, analysisMode: 'full',
      codeAwareMode: 'provider_send', codebaseIds: ['codebase-a']}))).rejects.toThrow('analysis_context_changed_restart_required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends no classifier retry after authorization changes during its backoff', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), classifierTimeoutMs: 30_000});
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockRestore();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    let revoked = false;
    // A transient failure, then the retry the transport would send after its backoff.
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      revoked = true;
      return new Response('unavailable', {status: 503});
    });
    const real = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return real(...args);
    });
    await expect(runtime.analyze('query', 'revoked-classifier-retry', 'trace', admitted({providerId: null,
      codeAwareMode: 'provider_send', codebaseIds: ['codebase-a']}))).rejects.toThrow('analysis_context_changed_restart_required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  describe('authorization is checked before every provider request', () => {
    const revokeWhen = (revoked: () => boolean) => {
      const real = contextAuthorization.assertCurrentAnalysisContextAuthorization;
      jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
        if (revoked()) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
        return real(...args);
      });
    };
    const sourceRuntime = (execute: () => Promise<string>) => {
      jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions', maxTurns: 3});
      const sourceTool = tool({name: 'read_codebase_file', description: 'Read source', parameters: z.object({}), execute});
      const runtime = createOpenAiRuntimeForTest();
      prepareStub(runtime).mockImplementation(async (...args: any[]) => ({
        systemPrompt: 'test system prompt', tools: [sourceTool], allowedTools: ['read_codebase_file'],
        sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns, hypotheses: [],
      }));
      return runtime;
    };
    const options = {providerId: null, analysisMode: 'full', codeAwareMode: 'provider_send', codebaseIds: ['codebase-a']};

    it('ends the run when authorization changes after a body read, before the continuation that resends it', async () => {
      let revoked = false;
      const execute = jest.fn(async () => { revoked = true; return '{"success":true,"text":"startMarker()"}'; });
      const runtime = sourceRuntime(execute);
      const fetchMock = jest.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(chatCompletionResponse('source-call', {role: 'assistant', tool_calls: [{index: 0,
          id: 'source-call-1', type: 'function', function: {name: 'read_codebase_file', arguments: '{}'}}]}, 'tool_calls'))
        .mockResolvedValueOnce(chatCompletionResponse('answer', {role: 'assistant', content: 'Must never be requested.'}, 'stop'));
      revokeWhen(() => revoked);
      await expect(runtime.analyze('query', 'revoked-after-read', 'trace', admitted(options as AnalysisOptions)))
        .rejects.toThrow('analysis_context_changed_restart_required');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('dispatches nothing when authorization changes after the history is rendered, before the first request', async () => {
      let revoked = false;
      const runtime = sourceRuntime(async () => '{}');
      const fetchMock = jest.spyOn(globalThis, 'fetch')
        .mockResolvedValue(chatCompletionResponse('answer', {role: 'assistant', content: 'Must never be requested.'}, 'stop'));
      const realRun = Runner.prototype.run;
      jest.spyOn(Runner.prototype as any, 'run').mockImplementation(function (this: Runner, ...args: any[]) {
        revoked = true;
        return (realRun as any).apply(this, args);
      });
      revokeWhen(() => revoked);
      await expect(runtime.analyze('query', 'revoked-before-dispatch', 'trace', admitted(options as AnalysisOptions)))
        .rejects.toThrow('analysis_context_changed_restart_required');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('can repair current-run output without resuming an earlier remote response', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
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
    // An output-limited answer earns the one continuation attempt cancelled below.
    const run = mockRun().mockResolvedValueOnce(recoverableStream('original partial answer'))
      .mockImplementationOnce(async () => {entered.resolve(); return late.promise;});
    const updates: any[] = []; runtime.on('update', (update: unknown) => updates.push(update));
    const pending = runtime.analyze('query', 'cancelled-recovery', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toBeDefined();
    await entered.promise;
    await runtime.abortSession('cancelled-recovery');
    late.resolve(sdkStream('late answer'));
    await rejected;
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(updates.some(update => update.type === 'conclusion')).toBe(false);
  });
});

describe('explicit OpenAI analysis reasoning', () => {
  async function serialize(protocol: 'chat_completions' | 'responses', modelId: string, settings: ModelSettings) {
    const create = jest.fn(async (_body: unknown) => protocol === 'chat_completions' ? {
      id: 'chat-analysis-controls', object: 'chat.completion', created: 1, model: modelId,
      choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: 'ok'}}],
    } : {
      id: 'resp-analysis-controls', object: 'response', created_at: 1, model: modelId, status: 'completed',
      output: [{type: 'message', id: 'msg-controls', status: 'completed', role: 'assistant',
        content: [{type: 'output_text', text: 'ok', annotations: []}]}],
    });
    const client = {chat: {completions: {create}}, responses: {create}} as any;
    const model = protocol === 'chat_completions' ? new OpenAIChatCompletionsModel(client, modelId)
      : new OpenAIResponsesModel(client, modelId);
    await withTrace('analysis reasoning serializer contract', () => model.getResponse({
      input: [{role: 'user', content: 'hi'}], systemInstructions: 'answer briefly', modelSettings: settings,
      tools: [], handoffs: [], outputType: 'text', tracing: false,
    } as any));
    return JSON.parse(JSON.stringify(create.mock.calls[0][0])) as Record<string, any>;
  }

  it('isolates provider request settings while preserving native methods, retry advice and stream identity', async () => {
    const settings = Object.freeze({providerData: Object.freeze({response_format: {type: 'json_object'}})});
    const request: ModelRequest = {input: [{role: 'user', content: 'fixture'}], tools: [], handoffs: [],
      outputType: 'text', tracing: false, modelSettings: settings, signal: new AbortController().signal};
    const stream = (async function* () {})();
    const failure = new Error('fixture-model-failure'), advice = {suggested: false, retryAfterMs: 7};
    const observed: ModelRequest[] = [];
    const mutate = (copy: ModelRequest) => {
      observed.push(copy);
      copy.modelSettings.providerData!.reasoning_effort = 'max';
    };
    const native: Model = {
      async getResponse(copy) {expect(this).toBe(native); mutate(copy); throw failure;},
      getStreamedResponse(copy) {expect(this).toBe(native); mutate(copy); return stream;},
      getRetryAdvice(args) {expect(this).toBe(native); mutate(args.request); return advice;},
    };
    const getModel = jest.fn((_modelName?: string) => native);
    const isolated = await __testing.createRequestIsolatedOpenAiModelProvider({getModel}).getModel('fixture-pinned');
    expect(getModel).toHaveBeenCalledWith('fixture-pinned');
    await expect(isolated.getResponse(request)).rejects.toBe(failure);
    expect(isolated.getStreamedResponse(request)).toBe(stream);
    expect(await isolated.getRetryAdvice!({request, error: failure, stream: true, attempt: 1})).toBe(advice);
    expect(observed).toHaveLength(3);
    for (const copy of observed) {
      expect(copy).not.toBe(request); expect(copy.modelSettings).not.toBe(settings);
      expect(copy.modelSettings.providerData).not.toBe(settings.providerData);
      expect(copy.input).toBe(request.input); expect(copy.tools).toBe(request.tools);
      expect(copy.handoffs).toBe(request.handoffs); expect(copy.signal).toBe(request.signal);
    }
    expect(settings.providerData).toEqual({response_format: {type: 'json_object'}});
    const plain = await __testing.createRequestIsolatedOpenAiModelProvider({getModel: () => ({
      getResponse: native.getResponse, getStreamedResponse: native.getStreamedResponse})}).getModel();
    expect(plain).not.toHaveProperty('getRetryAdvice');
  });

  it.each([
    ['chat_completions', 'https://api.openai.com/v1', 'gpt-5.6-sol'],
    ['chat_completions', 'https://gateway.example/v1', 'unknown-model'],
    ['chat_completions', 'https://api.deepseek.com/v1', 'deepseek-flash'],
    ['chat_completions', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3-flash'],
    ['responses', 'https://api.openai.com/v1', 'gpt-5.6-sol'],
    ['responses', 'https://gateway.example/v1', 'unknown-model'],
    ['responses', 'https://api.deepseek.com/v1', 'deepseek-flash'],
  ] as const)('uses native low on %s %s %s without injecting vendor thinking', async (protocol, baseURL, model) => {
    const config = createOpenAiConfigForTest({protocol, baseURL, model, analysisReasoningEffort: 'low'});
    const settings = __testing.buildOpenAIModelSettings(config, model);
    const body = await serialize(protocol, model, settings);
    expect(body.model).toBe(model);
    expect(body).not.toHaveProperty('thinking');
    if (protocol === 'chat_completions') {
      expect(body.reasoning_effort).toBe('low');
      expect(body).not.toHaveProperty('reasoning');
    } else {
      expect(body.reasoning).toEqual({effort: 'low'});
      expect(body).not.toHaveProperty('reasoning_effort');
    }
  });

  it.each([
    ['chat_completions', 'https://api.deepseek.com/v1', 'deepseek-flash', {thinking: {type: 'disabled'}}],
    ['chat_completions', 'https://gateway.example/v1', 'deepseek-flash', {reasoning_effort: 'none'}],
    ['responses', 'https://api.deepseek.com/v1', 'deepseek-flash', {reasoning: {effort: 'none'}}],
  ] as const)('maps explicit none only on its actual %s %s contract', async (protocol, baseURL, model, expected) => {
    const config = createOpenAiConfigForTest({protocol, baseURL, model, analysisReasoningEffort: 'none'});
    const body = await serialize(protocol, model, __testing.buildOpenAIModelSettings(config, model));
    expect(body).toMatchObject(expected);
    if ('thinking' in expected) expect(body).not.toHaveProperty('reasoning_effort');
    else expect(body).not.toHaveProperty('thinking');
  });

  it.each([
    ['https://api.deepseek.com/v1', 'deepseek-flash'],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash'],
  ] as const)('expresses documented chat max through tested providerData: %s', async (baseURL, model) => {
    const config = createOpenAiConfigForTest({protocol: 'chat_completions', baseURL, model, analysisReasoningEffort: 'max'});
    const body = await serialize(config.protocol, model, __testing.buildOpenAIModelSettings(config, model));
    expect(body.reasoning_effort).toBe('max');
    expect(body).not.toHaveProperty('thinking');
  });

  it.each([
    ['chat_completions', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'none'],
    ['chat_completions', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'medium'],
    ['chat_completions', 'https://gateway.example/v1', 'deepseek-flash', 'max'],
    ['responses', 'https://api.deepseek.com/v1', 'deepseek-flash', 'max'],
  ] as const)('rejects an unsupported selected path before analysis dispatch: %s %s %s %s',
    (protocol, baseURL, model, analysisReasoningEffort) => {
      const config = createOpenAiConfigForTest({protocol, baseURL, model, analysisReasoningEffort});
      expect(() => __testing.buildOpenAIModelSettings(config, model)).toThrow('openai_text_policy_invalid_configuration');
    });

  it('validates the selected light model without borrowing the unused primary capability', () => {
    const config = createOpenAiConfigForTest({protocol: 'chat_completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3-flash', lightModel: 'unknown-light', analysisReasoningEffort: 'none'});
    expect(__testing.buildOpenAIModelSettings(config, config.lightModel).reasoning).toEqual({effort: 'none'});
    expect(() => __testing.buildOpenAIModelSettings(config, config.model)).toThrow('openai_text_policy_invalid_configuration');
  });

  it('never dispatches selected GLM analysis with none even after classification', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      protocol: 'chat_completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash', analysisReasoningEffort: 'none'}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun();
    const result = await runtime.analyze('query', 'illegal-analysis-effort', 'trace', {providerId: null});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.completion.status).toBe('failed');
  });
});

describe('OpenAI output-only delivery provider controls', () => {
  it.each([
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3-flash', {thinking: {type: 'enabled'}, reasoning_effort: 'low'}],
    ['https://api.deepseek.com/v1', 'deepseek-flash', {thinking: {type: 'disabled'}}],
  ] as const)('passes timeout closeout controls through the actual Runner for %s', async (baseURL, model, controls) => {
    const config = createOpenAiConfigForTest({protocol: 'chat_completions', baseURL, model, lightModel: model,
      quickPathPerTurnMs: 100, quickMaxTurns: 3, maxRunTimeoutMs: 3000, streamIdleTimeoutMs: 50});
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(config);
    const runtime = createOpenAiRuntimeForTest();
    prepareStub(runtime).mockImplementation(async (...args: any[]) => {
      const invocation = {toolCallId: 'closeout-data', toolName: 'execute_sql', params: {}, extra: {}};
      await args[4].toolObserver({...invocation, phase: 'started'});
      await args[4].toolObserver({...invocation, phase: 'completed', result: {
        content: [{type: 'text', text: '{"success":true,"columns":["value"],"rows":[[1]]}'}]}});
      return {systemPrompt: 'Use retained fixture evidence.', tools: [], allowedTools: [], hypotheses: [],
        sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns};
    });
    const request = jest.spyOn(globalThis, 'fetch').mockImplementationOnce((_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        const cancel = () => reject(signal.reason);
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, {once: true});
      })).mockResolvedValueOnce(chatCompletionResponse('stage-closeout', {role: 'assistant', content: 'Retained answer.'}, 'stop'));
    const result = await runtime.analyze('query', `stage-closeout-${model}`, 'trace', {analysisMode: 'fast', providerId: null});
    expect(request).toHaveBeenCalledTimes(2);
    const closeout = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(closeout).toMatchObject({...controls, tool_choice: 'none', max_tokens: config.maxOutputTokens});
    expect(closeout).not.toHaveProperty('response_format'); expect(closeout.tools ?? []).toHaveLength(0);
    expect(result).toMatchObject({partial: true, terminationReason: 'timeout', conclusion: 'Retained answer.',
      completion: {status: 'incomplete', reason: 'timeout'}});
    const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
  });

  it.each([
    ['https://api.deepseek.com/v1', 'chat_completions', 'deepseek-flash', {thinking: {type: 'disabled'}}],
    ['https://api.deepseek.com/v1', 'responses', 'deepseek-flash', {reasoning: {effort: 'none'}}],
    ['https://open.bigmodel.cn/api/paas/v4', 'chat_completions', 'glm-5.3-flash', {thinking: {type: 'enabled'}, reasoning_effort: 'low'}],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'chat_completions', 'unknown-light', undefined],
    ['https://api.deepseek.com/v1', 'chat_completions', 'unknown-light', undefined],
    ['https://gateway.example/v1', 'chat_completions', 'deepseek-flash', undefined],
    ['', 'chat_completions', 'deepseek-flash', undefined],
  ] as const)('maps %s %s %s to model-aware delivery controls', (baseURL, protocol, model, expected) => {
    expect(__testing.outputOnlyProviderData({baseURL, protocol}, 'continuation', model)).toEqual(expected);
  });

  it('does not borrow the primary model policy for an unknown selected light model', () => {
    const config = createOpenAiConfigForTest({baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'chat_completions', model: 'glm-5.3-flash', lightModel: 'unknown-light'});
    expect(__testing.outputOnlyProviderData(config, 'continuation', config.model))
      .toEqual({thinking: {type: 'enabled'}, reasoning_effort: 'low'});
    expect(__testing.outputOnlyProviderData(config, 'continuation', config.lightModel)).toBeUndefined();
  });
});

describe('OpenAI admission-bound work budget', () => {
  it('holds the session guard while a real preparation preflight drains after expiry', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    classify({...decision, taskKind: 'investigation', recommendedComplexity: 'full'});
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const focus = jest.spyOn(focusDetector, 'detectFocusApps').mockImplementation(async () => {
      entered.resolve(); await release.promise; return {apps: [], method: 'none'};
    });
    const runtime = createOpenAiRuntimeForTest();
    const architecture = jest.spyOn(runtime, 'detectArchitecture');
    const run = mockRun();
    let settled = false;
    const pending = runtime.analyze('query', 'preflight-drain-owner', 'trace', {providerId: null, taskTimeoutMs: 60_000})
      .finally(() => {settled = true;});
    try {
      await entered.promise;
      clock.mockReturnValue(now + 60_001);
      await expect(runtime.analyze('successor', 'preflight-drain-owner', 'trace', {providerId: null})).rejects.toThrow();
      expect(settled).toBe(false);
      expect(architecture).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      release.resolve();
      expect((await pending).completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(focus).toHaveBeenCalledTimes(1);
      expect(architecture).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {release.resolve(); await pending; clock.mockRestore();}
  });

  it.each(['default', 'explicit'] as const)('dispatches no classifier or model after an issued %s budget is consumed', async kind => {
    const sessionId = `admission-expired-${kind}`;
    const scope = createRuntimeAdmissionScope({runId: sessionId, admittedAt: Date.now() - 130_000,
      ...(kind === 'explicit' ? {taskTimeoutMs: 60_000} : {}), assertCurrent() {}});
    try {
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const run = mockRun();
      const result = await runtime.analyze('query', sessionId, 'trace', scope.bind({providerId: null, runId: sessionId}, sessionId));
      expect(intentTransport.runOpenAiIntentTransport).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(result.terminationReason).toBe('timeout');
    } finally {scope.dispose();}
  });

  it.each(['default', 'explicit'] as const)('does not restart the %s budget after preparation has drained', async kind => {
    const now = Date.now();
    const runtime = createOpenAiRuntimeForTest();
    const original = prepareStub(runtime).getMockImplementation()!;
    jest.spyOn(runtime, 'prepareAnalysisContext').mockImplementation(async (...args: any[]) => {
      const context = await original(...args);
      jest.spyOn(Date, 'now').mockReturnValue(now + 130_000);
      return context;
    });
    const run = mockRun();
    const result = await runtime.analyze('query', `prep-expired-${kind}`, 'trace', {providerId: null,
      ...(kind === 'explicit' ? {taskTimeoutMs: 60_000} : {})});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
  });

  it('charges classification and preparation to the same deadline passed to finalization', async () => {
    let now = 100_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockImplementation(async () => {
      now += 20_000;
      return {status: 'ok', text: JSON.stringify(decision), actualModel: 'pinned-light', finishReason: 'stop'};
    });
    const original = prepareStub(runtime).getMockImplementation()!;
    jest.spyOn(runtime, 'prepareAnalysisContext').mockImplementation(async (...args: any[]) => {
      const context = await original(...args); now += 15_000; return context;
    });
    const body = 'The marker is present.';
    const contract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: body}], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: []} as ConclusionContract;
    const run = mockRun(sdkStream(`${body}\n${renderConclusionContractSidecar(contract)}`));
    const result = await runtime.analyze('query', 'one-task-budget', 'trace', {providerId: null, taskTimeoutMs: 60_000});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.completion).toMatchObject({status: 'completed'});
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(context.deadlineMs).toBeGreaterThan(now);
    expect(context.deadlineMs).toBeLessThanOrEqual(160_000);
  });
});

describe('OpenAI observed answer output', () => {
  it.each(['authoring_v1', 'authoring_v2'] as const)(
    'measures body and stray-segment size without classifying a stray %s declaration', async syntax => {
      const frame = wrapConclusionAuthoringPayload(JSON.stringify({authoringVersion: 'unsupported'}), syntax);
      const recorder = createRuntimePerformanceRecorder();
      const sessionId = `observed-output-${syntax}`;
      const scope = createRuntimePerformanceScope({recorder,
        identity: {runId: sessionId, sessionId, scope: {tenantId: 't', workspaceId: 'w'}}, assertCurrent() {}});
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const body = 'The marker is present.\n';
      const run = mockRun(sdkStream(`${body}${frame}`));
      try {
        await scope.run(() => runtime.analyze('query', sessionId, 'trace', {providerId: null, runId: sessionId}));
        expect(run).toHaveBeenCalledTimes(1);
        const output = recorder.seal().modelCalls?.find(call => call.purpose === 'answer_turn')?.output;
        expect(output).toEqual({bodyChars: body.length, sidecarChars: frame.length});
      } finally {scope.dispose();}
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

  it('projects document knowledge tool output before emitting it', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    const context = streamContext('s-private-knowledge', false);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {rawItem: {
        callId: 'knowledge-call',
        name: 'search_knowledge',
        arguments: JSON.stringify({query: 'Handler'}),
      }},
    }, 'zh-CN', context);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {rawItem: {
        callId: 'knowledge-call',
        output: JSON.stringify({success: true, hits: [{
          id: 'kref-11111111-2222-3333-4444-555555555555', knowledgeBaseId: `eks_${'a'.repeat(24)}`,
          title: 'Handler', headingPath: ['Handler'], relativePath: 'private/notes.md',
          lineRange: {start: 3, end: 9}, excerpt: 'OPENAI_PRIVATE_KNOWLEDGE_CANARY',
        }]}),
      }},
    }, 'zh-CN', context);

    const responses = updates.filter(update => update.type === 'agent_response');
    expect(JSON.stringify(responses)).not.toContain('OPENAI_PRIVATE_KNOWLEDGE_CANARY');
    expect(JSON.parse(String(responses[0]?.content.result))).toMatchObject({knowledge: {referenceCount: 1}});
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
      }));
    expect(JSON.stringify(currentPlan)).not.toContain('StartupHooks.kt');
    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENAI_PRIVATE_SOURCE_CANARY');
    expect(serialized).not.toContain('app/src/main/java/com/example/StartupHooks.kt');
    expect(serialized).toContain('snippetHash');
  });

  it('streams current assistant text before an optional plan is submitted', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const text = '自然回答无需等待 submit_plan';
    runtime.handleStreamEvent({type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: text}}, 'zh-CN',
      streamContext('no-plan', false, runtime));
    expect(updates.filter(update => update.type === 'answer_token').map(update => update.content.token)).toEqual([text]);
  });

  it('withdraws a private draft when a credential completes across lines, and shows nothing more', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const sessionId = 'openai-private-draft';
    const projection = createCodeAwareStreamingTextProjection(sessionId, 'openai-answer-test', 'owner');
    const context = {...streamContext(sessionId, false, runtime), answerTextProjection: projection,
      answerDraft: createProjectedAnswerDraft(createAnswerDraftStream(`${sessionId}-run`,
        update => runtime.emitUpdate(update)), projection)};
    const delta = (text: string) => runtime.handleStreamEvent({type: 'raw_model_stream_event',
      data: {type: 'output_text_delta', delta: text}}, 'en', context);
    try {
      for (const text of ['Intro line\n', 'api_key=\n', '"synthetic-secret-123456"\n', 'Later line\n']) delta(text);
      runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_called', item: {rawItem: {
        type: 'function_call', callId: 'call-private', name: 'execute_sql', arguments: '{"sql":"select 1"}'}}}, 'en', context);
      delta('Next response\n');
      expect(updates.filter(update => update.type === 'answer_token' || update.type === 'answer_segment_reset')
        .map(update => [update.type, update.content.token ?? null])).toEqual([
        ['answer_token', 'Intro line\n'], ['answer_segment_reset', null]]);
      expect(JSON.stringify(updates)).not.toContain('synthetic-secret-123456');
    } finally { clearCodeAwareOutputGuards(sessionId); }
  });

  it('revokes answer text that preceded a tool call in the same response', async () => {
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun(sdkStream('Final answer', {events: [
      {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Let me check the trace.'}},
      {type: 'run_item_stream_event', name: 'tool_called', item: {rawItem: {type: 'function_call', callId: 'call-1',
        name: 'execute_sql', arguments: '{"sql":"select 1"}'}}},
      {type: 'raw_model_stream_event', data: {type: 'response_started'}},
      {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Final answer'}},
    ]}));
    await runtime.analyze('query', 'answer-then-tool', 'trace', {providerId: null, runId: 'draft-run'});
    const drafts = updates.filter(update => (update.type === 'answer_token' && update.content.token) ||
      update.type === 'answer_segment_reset');
    expect(drafts.map(update => [update.type, update.content.token ?? null, update.content.runId, update.content.attempt])).toEqual([
      ['answer_token', 'Let me check the trace.', 'draft-run', 0],
      ['answer_segment_reset', null, 'draft-run', 1],
      ['answer_token', 'Final answer', 'draft-run', 1],
    ]);
  });
});

describe('OpenAI provisional memory boundary', () => {
  function setup() {
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(runtime.recordPatternMemory).mockRestore();
    jest.spyOn(patternMemory, 'extractKeyInsights').mockReturnValue(['an observed fact']);
    const quick = jest.spyOn(patternMemory, 'saveQuickPathPattern').mockResolvedValue(undefined);
    const full = jest.spyOn(patternMemory, 'saveAnalysisPattern').mockResolvedValue(undefined);
    const input = (options: object) => ({sessionId: 'memory-draft', previousTurnCount: 0, quickMode: false,
      sceneType: 'general', options: options as never,
      result: {conclusion: 'body', findings: [{title: 'fact'}], turnIntent: decision} as never});
    return {runtime, quick, full, input};
  }
  const publicRunOptions = () => withDurableLearningPermission({runId: 'memory-run'}, NO_PRIVATE_CONTEXT);

  it('saves a runtime draft as provisional and selects the bucket from semantic scope', () => {
    const {runtime, quick, full, input} = setup();
    const draft = input(publicRunOptions());
    runtime.recordPatternMemory(draft);
    expect(quick).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled();
    expect(quick.mock.calls[0][4]).toMatchObject({status: 'provisional', learning: {runId: 'memory-run'}});
    runtime.recordPatternMemory({...draft, quickMode: true, result: {...(draft.result as object),
      turnIntent: {...decision, scope: 'scene_wide', deliverable: 'report'}} as never});
    expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.calls[0][5]).toMatchObject({status: 'provisional', learning: {runId: 'memory-run'}});
  });

  it.each([
    ['no grant', () => ({runId: 'memory-run'})],
    ['a selection that turned private', () => ({...publicRunOptions(), knowledgeSourceIds: ['private-wiki']})],
  ])('learns nothing under %s', (_label, options) => {
    const {runtime, quick, full, input} = setup();
    runtime.recordPatternMemory(input(options()));
    expect(quick).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
  });
});

describe('OpenAI durable learning across the run lifecycle', () => {
  // A finding and a root cause: everything a public run learns from, so only
  // how the run ends decides whether it learns.
  const LEARNABLE_ANSWER = '[HIGH] 主线程同步等待 Binder 回复\n主线程在 doFrame 中等待 system_server 48 ms。\n' +
    '根因：主线程同步等待 system_server 的 Binder 回复超过一帧预算';
  const ENV_KEYS = ['SMARTPERFETTO_BACKEND_LOG_DIR', ENTERPRISE_FEATURE_FLAG_ENV, ENTERPRISE_MIGRATION_PHASE_ENV];
  let savedEnv: Array<[string, string | undefined]> = [];
  let logDir = '';
  beforeEach(() => {
    savedEnv = ENV_KEYS.map(key => [key, process.env[key]]);
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-openai-learning-'));
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = logDir;
    delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'legacy';
  });
  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(logDir, {recursive: true, force: true});
  });
  function setup() {
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(runtime.recordPatternMemory).mockRestore();
    prepareStub(runtime);
    return {runtime, save: jest.spyOn(patternMemory, 'saveQuickPathPattern')};
  }
  const grant = (runId: string) => withDurableLearningPermission({runId, providerId: null}, NO_PRIVATE_CONTEXT);
  // Lets any late save start, waits until every save settled, then reads the
  // store the way a later run's prefetch does.
  async function learned(save: jest.SpiedFunction<typeof patternMemory.saveQuickPathPattern>) {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(save.mock.results.map(result => result.value));
    return save.mock.calls.flatMap(([features]) => patternMemory.matchQuickPatternsAsBackup(features));
  }
  // Whichever bucket a regression chose, nothing was written.
  const storedPatternFiles = () => fs.readdirSync(logDir).filter(name => name.endsWith('patterns.json'));

  it('learns once from a completed public run, stamped with that run', async () => {
    const {runtime, save} = setup(); mockRun(sdkStream(LEARNABLE_ANSWER));
    const result = await runtime.analyze('query', 'learning-completed', 'trace', grant('run-completed'));
    expect(result.partial).toBeUndefined(); expect(result.findings.length).toBeGreaterThan(0);
    const entries = await learned(save);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({status: 'provisional',
      learningAdmission: {version: 1, basis: 'public_run', runId: 'run-completed'}});
  });

  it('writes memory once for a plain answer without any declaration or repair call', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      protocol: 'chat_completions', baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash', lightModel: 'deepseek-flash'}));
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(runtime.recordPatternMemory).mockRestore();
    const save = jest.spyOn(patternMemory, 'saveQuickPathPattern');
    const sessionId = 'learning-plain-answer', runId = 'run-plain-answer';
    const sessionContext = sessionContextManager.getOrCreate(sessionId, 'trace');
    const workingMemory = jest.spyOn(sessionContext, 'updateWorkingMemoryFromConclusion');
    const addTurn = jest.spyOn(sessionContext, 'addTurn');
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      chatCompletionResponse('memory-native-stop', {role: 'assistant', content: LEARNABLE_ANSWER}, 'stop'));
    const options = withDurableLearningPermission({runId, providerId: null, assistantSurface: 'conversation' as const,
      conversationTraceAttached: false, analysisMode: 'fast' as const}, NO_PRIVATE_CONTEXT);
    const result = await runtime.analyze('query', sessionId, 'trace', options);
    const entries = await learned(save);
    const context = finalization.takeFinalizationContext(result)!;
    finalizationContexts.push(context);
    expect(result).toMatchObject({success: true, completion: {status: 'completed'}});
    expect(result.conclusion).toBe(LEARNABLE_ANSWER);
    expect(result.partial).toBeUndefined();
    expect(addTurn).toHaveBeenCalledTimes(1);
    expect({workingMemory: workingMemory.mock.calls.length, patternCalls: save.mock.calls.length, savedPatterns: entries.length})
      .toEqual({workingMemory: 1, patternCalls: 1, savedPatterns: 1});
    // The completed answer carries no declaration and needs no repair call.
    expect(request).toHaveBeenCalledTimes(1);
    expect(context.deliveryContext).not.toHaveProperty('finalSubmission');
  });

  it('learns nothing from a run the provider cut short', async () => {
    const {runtime, save} = setup(); mockRun(sdkStream(LEARNABLE_ANSWER, {status: 'incomplete'}));
    const result = await runtime.analyze('query', 'learning-partial', 'trace', grant('run-partial'));
    expect(result.partial).toBe(true); expect(result.findings.length).toBeGreaterThan(0);
    expect(await learned(save)).toEqual([]); expect(save).not.toHaveBeenCalled(); expect(storedPatternFiles()).toEqual([]);
  });

  it('learns nothing from a failed run', async () => {
    const {runtime, save} = setup(); mockRun().mockRejectedValue(new Error('upstream unavailable'));
    const result = await runtime.analyze('query', 'learning-failed', 'trace', grant('run-failed'));
    expect(result.success).toBe(false);
    expect(await learned(save)).toEqual([]); expect(save).not.toHaveBeenCalled(); expect(storedPatternFiles()).toEqual([]);
  });

  it('learns nothing from a run cancelled after its answer was complete', async () => {
    const {runtime, save} = setup(); mockRun(sdkStream(LEARNABLE_ANSWER));
    // The candidate is complete once its protocol diagnostic is out; cancel right there.
    let answered = false;
    runtime.on('update', (update: any) => {
      if (update.type !== 'progress' || update.content?.phase !== 'candidate_protocol' || answered) return;
      answered = true; runtime.abortSession('learning-cancelled');
    });
    await expect(runtime.analyze('query', 'learning-cancelled', 'trace', grant('run-cancelled'))).rejects.toThrow();
    expect(answered).toBe(true);
    expect(await learned(save)).toEqual([]); expect(save).not.toHaveBeenCalled(); expect(storedPatternFiles()).toEqual([]);
  });

  it('learns nothing from a run cancelled while its provider closes', async () => {
    const {runtime, save} = setup(); mockRun(sdkStream(LEARNABLE_ANSWER));
    const closing = createDeferred<void>(); const release = createDeferred<void>();
    jest.spyOn(OpenAIProvider.prototype, 'close').mockImplementation(async () => {closing.resolve(); await release.promise;});
    const pending = runtime.analyze('query', 'learning-closing', 'trace', grant('run-closing'));
    const rejected = expect(pending).rejects.toThrow();
    await closing.promise;
    runtime.abortSession('learning-closing'); release.resolve(); await rejected;
    expect(await learned(save)).toEqual([]); expect(save).not.toHaveBeenCalled(); expect(storedPatternFiles()).toEqual([]);
  });

  it('learns only from the successor when a superseded run completes late', async () => {
    const {runtime, save} = setup();
    const entered = createDeferred<void>(); const late = createDeferred<void>();
    mockRun(sdkStream(LEARNABLE_ANSWER)).mockResolvedValueOnce({...sdkStream(LEARNABLE_ANSWER), history: [], _getStreamLoopPromise: () => late.promise, async *[Symbol.asyncIterator]() {
        entered.resolve(); await late.promise; yield responseDone(LEARNABLE_ANSWER);
      }});
    const superseded = runtime.analyze('query', 'learning-superseded', 'trace', grant('run-superseded'));
    const rejected = expect(superseded).rejects.toThrow();
    await entered.promise; runtime.abortSession('learning-superseded');
    await expect(runtime.analyze('blocked follow-up', 'learning-superseded', 'trace', grant('run-blocked'))).rejects.toThrow('already in progress');
    late.resolve(); await rejected;
    const successor = await runtime.analyze('follow-up', 'learning-superseded', 'trace', grant('run-successor'));
    expect(successor.partial).toBeUndefined();
    expect((await learned(save)).map(entry => entry.learningAdmission?.runId)).toEqual(['run-successor']);
  });
});

describe('OpenAI source finalization parity', () => {
  it('preserves native provider completion while recording pending source access', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: mcpModule.createClaudeMcpServer, sessionId: 'pending-source'});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime, fixture.sourceUse); mockRun();
    try {
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', admitted({
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      }));
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
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', admitted({
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      }));
      expect(result.sourceUseDecision).toEqual(sourceDecision); expect(result.sourceReferences).toEqual(sourceDecision.references);
      expect(JSON.stringify(result)).toContain(SOURCE_FINALIZATION_CANARY);
      expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      const context = finalization.takeFinalizationContext(result)!;
      finalizationContexts.push(context);
      expect(context).not.toHaveProperty('getNativeDeclaration');
      expect(JSON.stringify(result)).not.toContain('conclusion_protocol_projection');
      prepare.mockRestore(); prepareStub(runtime); run.mockResolvedValue(sdkStream('public second answer'));
      const next = await runtime.analyze('another request', fixture.sessionId, 'trace', admitted({analysisMode: 'fast', providerId: null, codeAwareMode: 'off'}));
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
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']}));
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({outputOrigin: 'sdk_final', completion: {status: 'completed'}});
    expect(result.partial).toBeUndefined();
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    const originalContext = projected.mock.calls[0][2]?.context;
    expect(result.completion.candidateRef).not.toBe(originalContext?.entry === 'runtime_draft'
      ? originalContext.acceptedCandidate?.candidateRef : undefined);
    expect(attachedDeliveryContext(result)).toEqual(outcome.deliveryContext);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(result)).not.toContain(outcome.conclusionProjection.inputFingerprint);
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
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']}));
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('replaced');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}, quickRun: {stopReason: 'partial'}});
    expect(attachedDeliveryContext(result)).toEqual(outcome.deliveryContext);
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    if (!nativeBody) {
      const context = projected.mock.calls[0][2]?.context;
      expect(context?.entry === 'runtime_draft' && context.completion?.status).toBe('unknown');
      expect(result.confidence).toBe(0);
    }
  });
  it('leaves the terminal state of a privacy-replaced draft to the finalizer', async () => {
    const sessionId = 'replaced-terminal-state'; privacySessions.push(sessionId);
    revokeCodeAwareOutputGuards(sessionId);
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime); mockRun(sdkStream('Native answer'));
    try {
      const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, analysisMode: 'fast',
        knowledgeSourceIds: ['private-source']}));
      expect(result).toMatchObject({outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}});
      expectRuntimeLeftTerminalStateToFinalizer({result, updates, native: {partial: true},
        recordedTurn: sessionContextManager.get(sessionId, 'trace')?.getAllTurns().slice(-1)[0]?.result});
      attachedDeliveryContext(result);
    } finally {sessionContextManager.remove(sessionId);}
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
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, knowledgeSourceIds: ['private-source']}));
    expect(result.completion.status).toBe(status);
    const context = attachedDeliveryContext(result);
    expect(context?.entry === 'runtime_draft' && context.completion).toEqual(result.completion);
    expect(context?.entry === 'runtime_draft' && context.acceptedCandidate?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
  });
  it('projects a failed stream candidate and its error without upgrading native failure', async () => {
    const sessionId = 'projection-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun({...sdkStream(''), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      throw new Error('PRIVATE_CANARY provider failure');
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, knowledgeSourceIds: ['private-source']}));
    expect((projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeOwnerSourceAwareAnalysisResultWithProjection>).conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'assistant_stream', completion: {status: 'failed', reason: 'provider_error'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });
  it('keeps what the run delivered when its failure candidate has no finalization context', async () => {
    const knowledgeUse = {sources: [{knowledgeBaseId: `eks_${'a'.repeat(24)}`, kind: 'document_collection' as const,
      generation: `dc_${'1'.repeat(32)}`, deliveredReferenceCount: 1}], locations: []};
    const runtime = createOpenAiRuntimeForTest();
    prepareStub(runtime, {getSourceUseDecision: () => undefined, getKnowledgeUse: () => knowledgeUse});
    mockRun();
    // A failure after the provider answered reaches the outer catch, which returns a failure candidate.
    jest.spyOn(runtime, 'recordTurn').mockImplementation(() => { throw new Error('failure after a knowledge read'); });
    const result = await runtime.analyze('query', 'openai-knowledge-failure', 'trace',
      {providerId: null, runId: 'openai-knowledge-failure-run'});
    expect(result).toMatchObject({success: false, completion: {status: 'failed', reason: 'provider_error'}});
    expect(finalization.takeFinalizationContext(result)).toBeUndefined();
    expect(finalization.takeRunDeliveryRecord(result)).toEqual({runId: 'openai-knowledge-failure-run',
      sessionId: 'openai-knowledge-failure', knowledgeUse});
  });
  it('projects setup failure diagnostics before emitting them without inventing model output', async () => {
    const sessionId = 'projection-setup-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const {runtime, updates} = createRuntimeWithUpdates();
    prepareStub(runtime).mockRejectedValue(new Error('PRIVATE_CANARY setup failed'));
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, knowledgeSourceIds: ['private-source']}));
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
    expect(projected).not.toHaveProperty('protocolProjection');
    expect(projected.deliveryContext.entry === 'runtime_draft' && projected.deliveryContext.completion).toEqual(projected.result.completion);
  });
  it('cancellation never finalizes or publishes an unprojected stream body', async () => {
    const sessionId = 'projection-cancelled'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun({...sdkStream(''), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      entered.resolve(); await release.promise;
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const pending = runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, knowledgeSourceIds: ['private-source']}));
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession(sessionId); release.resolve(); await rejected;
    expect(projected).not.toHaveBeenCalled();
    expect(updates.filter(update => update.type === 'conclusion')).toHaveLength(0);
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
  });
});

describe('OpenAI finalization handoff', () => {
  function takeContext(result: any): finalization.RuntimeFinalizationContext {
    const context = finalization.takeFinalizationContext(result);
    if (!context) throw new Error('Missing runtime finalization context');
    finalizationContexts.push(context);
    return context;
  }
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
    expect(context).not.toHaveProperty('getSelection');
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
  it('reads the captured row beyond the display preview and denies another trace without querying', async () => {
    // Scoped history opens lazily during analyze(), before the evidence handoff.
    // This case owns that database rather than reading ambient user history.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-openai-history-'));
    fs.chmodSync(root, 0o700);
    ownedHistoryFixture = {root, previousDbPath: process.env[ENTERPRISE_DB_PATH_ENV]};
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(root, 'history.db');
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
    const result = await runtime.analyze('query', sessionId, 'trace', admitted({providerId: null, knowledgeSourceIds: ['private-source']}));
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

  it('never asks the provider to store responses', () => {
    const config = createOpenAiConfigForTest();
    expect(__testing.buildOpenAIModelSettings(config, config.model)).toEqual(expect.objectContaining({
      store: false,
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
    }));
  });

  it('uses max_completion_tokens for GPT-5.6 Chat Completions without emitting maxTokens', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'gpt-5.6-sol',
    };
    const settings = __testing.buildOpenAIModelSettings(config, config.model);

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

    expect(__testing.buildOpenAIModelSettings(config, config.model)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: false,
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
        modelSettings: __testing.buildOpenAIModelSettings(config, config.model),
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

    expect(__testing.buildOpenAIModelSettings(config, config.model)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: false,
    });
  });

 });

describe('OpenAI snapshot compatibility', () => {
  const sessionFields = {
    conversationSteps: [], queryHistory: [], conclusionHistory: [], agentDialogue: [], agentResponses: [],
    dataEnvelopes: [], hypotheses: [], runSequence: 0, conversationOrdinal: 0,
  };

  it.each([undefined, 'trace-b'])('writes only the provider pin as engine state (reference %s)', referenceTraceId => {
    const runtime = createOpenAiRuntimeForTest();
    const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
      ...sessionFields, agentRuntimeProviderId: 'provider-1', agentRuntimeProviderSnapshotHash: 'hash-1',
      ...(referenceTraceId ? {referenceTraceId, comparisonSource: 'raw_trace_pair' as const} : {}),
    });

    expect(snapshot).toMatchObject({agentRuntimeKind: 'openai-agents-sdk', agentRuntimeProviderId: 'provider-1',
      agentRuntimeProviderSnapshotHash: 'hash-1', engineState: {kind: 'openai-agents-sdk',
        provider: {providerId: 'provider-1', providerSnapshotHash: 'hash-1'}}});
    for (const field of ['sdkSessionId', 'openAIHistory', 'openAILastResponseId', 'openAIRunState']) {
      expect(snapshot).not.toHaveProperty(field);
    }
    expect(JSON.parse(JSON.stringify(snapshot.engineState))).toEqual({kind: 'openai-agents-sdk',
      provider: {providerId: 'provider-1', providerSnapshotHash: 'hash-1'}, openai: {}});
  });

  it.each([
    ['canonical engine state', {engineState: {kind: 'openai-agents-sdk' as const,
      provider: {providerId: null, providerSnapshotHash: null},
      openai: {history: [{role: 'user', content: 'previous question'}], lastResponseId: 'resp_old', runState: 'opaque'}}}],
    ['legacy mirrors', {referenceTraceId: 'trace-b', comparisonSource: 'raw_trace_pair' as const,
      openAIHistory: [{role: 'user', content: 'previous question'}], openAILastResponseId: 'resp_old',
      openAIRunState: 'opaque', sdkSessionId: 'resp_old'}],
  ])('restores product state from a snapshot carrying %s without carrying SDK state forward', (_label, runtimeState) => {
    const runtime = createOpenAiRuntimeForTest();
    const note = {id: 'n1', content: 'kept note'} as any;
    const snapshot = {...emptySnapshot('s1', 'trace-1'), analysisNotes: [note], ...runtimeState};

    runtime.restoreFromSnapshot('s1', 'trace-1', snapshot);

    expect(runtime.getSessionNotes('s1')).toEqual([note]);
    const next = runtime.takeSnapshot('s1', 'trace-1', {...sessionFields,
      ...('referenceTraceId' in runtimeState ? {referenceTraceId: runtimeState.referenceTraceId} : {})});
    expect(JSON.stringify(next)).not.toMatch(/resp_old|previous question|opaque/);
  });
});

describe('OpenAI architecture cache bound', () => {
  it('keeps restored architectures within the shared LRU bound', () => {
    const runtime = createOpenAiRuntimeForTest();
    const architecture = {type: 'STANDARD', confidence: 0.9, evidence: []};
    for (let index = 0; index <= DEFAULT_RUNTIME_CACHE_LIMIT; index++) {
      runtime.restoreFromSnapshot(`s-${index}`, `trace-${index}`, {...emptySnapshot(`s-${index}`, `trace-${index}`), architecture});
    }
    expect(runtime.architectureCache.size).toBe(DEFAULT_RUNTIME_CACHE_LIMIT);
    expect(runtime.getCachedArchitecture('trace-0')).toBeUndefined();
    expect(runtime.getCachedArchitecture(`trace-${DEFAULT_RUNTIME_CACHE_LIMIT}`)).toEqual(architecture);
  });
});

describe('OpenAI parallel tool call identity', () => {
  const calls = [
    {name: 'execute_sql', args: {sql: 'SELECT 1'}},
    {name: 'search_codebase', args: {query: 'initializeOnMainThread'}},
    {name: 'invoke_skill', args: {skillId: 'startup_analysis'}},
  ];

  // The Chat Completions converter stamps every function call of a response
  // with the response id (or FAKE_ID); only callId identifies a call.
  it.each([
    ['chat completions share the response id', (turn: number) => `chatcmpl-${turn}`],
    ['chat completions without a provider id', () => 'FAKE_ID'],
    ['Responses API items carry their own id', (turn: number, index: number) => `fc_${turn}_${index}`],
  ])('dispatches and records every parallel call once: %s', (_label, idFor) => {
    const {runtime, updates} = createRuntimeWithUpdates();
    runtime.sessionPlans.set('parallel-calls', {current: plan([phase('p1', 'in_progress')]), history: []});
    const context = streamContext('parallel-calls', false);
    for (let turn = 0; turn < 2; turn += 1) {
      calls.forEach((call, index) => runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_called',
        item: {rawItem: {type: 'function_call', id: idFor(turn, index), callId: `call_${turn}_${index}`,
          name: call.name, arguments: JSON.stringify(call.args)}}}, 'en', context));
      calls.forEach((call, index) => runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_output',
        item: {output: '{"success":true}', rawItem: {type: 'function_call_result', id: idFor(turn, index),
          callId: `call_${turn}_${index}`, name: call.name, status: 'completed',
          output: {type: 'text', text: '{"success":true}'}}}}, 'en', context));
    }
    const expected = [0, 1].flatMap(turn => calls.map((call, index) => [`call_${turn}_${index}`, call.name]));
    const summarize = (type: string) => updates.filter(update => update.type === type)
      .map(update => [update.content.taskId, update.content.toolName]);
    expect(summarize('agent_task_dispatched')).toEqual(expected);
    expect(summarize('agent_response')).toEqual(expected);
    expect(runtime.sessionPlans.get('parallel-calls')?.current?.toolCallLog.map((record: any) => record.toolCallId))
      .toEqual(expected.map(([taskId]) => taskId));
    expect(context.toolInputsByTaskId.size).toBe(0);
  });

  it('records a result whose dispatch was never observed under its own tool name', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    runtime.sessionPlans.set('unseen-dispatch', {current: plan([phase('p1', 'in_progress')]), history: []});
    const context = streamContext('unseen-dispatch', false);
    runtime.handleStreamEvent({type: 'run_item_stream_event', name: 'tool_output', item: {output: '{"success":true}',
      rawItem: {type: 'function_call_result', callId: 'call-unseen', name: 'read_codebase_file', status: 'completed',
        output: {type: 'text', text: '{"success":true}'}}}}, 'en', context);
    expect(updates.find(update => update.type === 'agent_response')?.content)
      .toMatchObject({taskId: 'call-unseen', toolName: 'read_codebase_file'});
    expect(runtime.sessionPlans.get('unseen-dispatch')?.current?.toolCallLog.map((record: any) => record.toolCallId))
      .toEqual(['call-unseen']);
  });
});

describe('OpenAI selected foundation preflight', () => {
  it.each(['ready', 'focus_failed'] as const)('retains the real selected core before a %s preflight', async preflight => {
    installSelectedNativeSignerMocks();
    const sessionId = 'selected-core-before-focus', runId = 'run-selected-core-before-focus', traceId = 'trace';
    const fixture = await createSelectedFoundationFixture({traceId, runId, registerExecutor: false});
    const resolveIntent = turnIntentRuntime.createAnalysisTurnIntentResolver;
    jest.spyOn(turnIntentRuntime, 'createAnalysisTurnIntentResolver').mockImplementation(input =>
      resolveIntent({...input, strategyRegistry: fixture.input.strategyRegistry}));
    jest.spyOn(effectiveSkillRegistry, 'resolveEffectiveSkillRegistryForRuntime').mockReturnValue(fixture.input.skillRegistry);
    const actualCreateExecutor = skillExecutors.createSkillExecutor;
    const createExecutor = jest.spyOn(skillExecutors, 'createSkillExecutor')
      .mockImplementation(actualCreateExecutor).mockReturnValueOnce(fixture.executor);
    const registerSkills = jest.spyOn(fixture.executor, 'registerSkills');
    const registerFragments = jest.spyOn(fixture.executor, 'setFragmentRegistry');
    classify({...decision, taskKind: 'investigation', targetUse: 'current_selection'});
    const order: string[] = [];
    const originalQuery = fixture.query.getMockImplementation()!;
    fixture.query.mockImplementation(async (...args) => {order.push('metric'); return originalQuery(...args);});
    const runtime = createOpenAiRuntimeForTest(fixture.input.traceProcessorService);
    jest.spyOn(focusDetector, 'detectFocusApps').mockImplementation(async () => {
      order.push('focus');
      beginRawSqlNativeQuery(fixture.native.provenance, 'INCLUDE PERFETTO MODULE android.oom_adjuster;');
      if (preflight === 'focus_failed') throw new Error('focus fixture failed after selected evidence committed');
      return {apps: [], method: 'none'};
    });
    jest.spyOn(runtime, 'detectArchitecture').mockResolvedValue(undefined);
    jest.spyOn(runtime, 'detectCompleteness').mockResolvedValue(undefined);
    const selected = jest.spyOn(sceneEntryEvidence, 'collectSelectedEvidenceForPrompt');
    const legacy = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt');
    const reset = jest.spyOn(runtime, 'resetAnalysisSessionState');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const run = mockRun(sdkStream(renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []}) + '\nA bounded answer.'));
    const result = await runtime.analyze('Explain this selected interval.', sessionId, traceId,
      {providerId: null, runId, analysisMode: 'full', selectionContext: fixture.input.selectionContext});
    expect(order).toEqual(['metric', 'focus']);
    expect(selected).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    expect(createExecutor.mock.results.filter(call => call.type === 'return' && call.value === fixture.executor)).toHaveLength(1);
    expect(registerSkills).toHaveBeenCalledTimes(1);
    expect(registerFragments).toHaveBeenCalledTimes(1);
    const store = selected.mock.calls[0][0].artifactStore;
    // Notes and rule facts are Pi's alone.
    expect(mcp.mock.calls.every(([options]) => options.skillResultNotes === undefined)).toBe(true);
    expect(createExecutor.mock.calls.every(call => call[2] === undefined)).toBe(true);
    expect(runtime.artifactStores.get(sessionId)).toBe(store);
    const selectedResult = await selected.mock.results[0].value as
      Awaited<ReturnType<typeof sceneEntryEvidence.collectSelectedEvidenceForPrompt>>;
    if (!selectedResult.handled) throw new Error('Expected a handled selected acquisition');
    const evidence = selectedResult.data;
    expect(evidence).toMatchObject({kind: 'selected_foundation', native: {status: 'captured'}, metric: {status: 'committed'}});
    if (preflight === 'ready') {
      attachedDeliveryContext(result);
      expect(reset).toHaveBeenCalledTimes(1); expect(reset.mock.calls[0][3]).toBe(store);
      expect(mcp.mock.calls[0][0].artifactStore).toBe(store);
      expect(mcp.mock.calls[0][0].skillExecutor).toBe(fixture.executor);
      expect(prompt.mock.calls[0][0].sceneEvidence).toBe(evidence);
    } else {
      expect(result).toMatchObject({success: false, partial: true, terminationReason: 'execution_error',
        completion: {status: 'failed', reason: 'provider_error'}});
      expect(finalization.takeFinalizationContext(result)).toBeUndefined();
      expect(reset).not.toHaveBeenCalled(); expect(mcp).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    }
    if (!evidence || !('kind' in evidence) || evidence.native.status !== 'captured') throw new Error('Expected a captured selected row');
    const view = store.createEvidenceReadView({ownerKey: 'owner', currentRunId: runId,
      allowedTraces: [{traceId, traceSide: 'current'}]});
    expect(view.investigationEvidence!().records).toEqual([expect.objectContaining({status: 'observed',
      upid: 42, utid: 43, window: {start: 10, end: 110}, value: 80})]);
    expect(await view.resolveReferences([{key: 'native', requiredColumns: ['dur'],
      reference: {evidenceRefId: evidence.native.evidenceRefId, rowIndex: 0, column: 'dur'}}]))
      .toMatchObject([{status: 'resolved', row: {dur: 100}, record: {fields: {dur: {unit: 'ns'}}}}]);
    expect(readRawSqlNativeProvenanceSnapshot(fixture.native.provenance).status).toBe('tainted');
  });

  function heldNativeLookup(sessionId: string) {
    classify({...decision, taskKind: 'investigation', targetUse: 'current_selection'});
    const first = createDeferred<'native' | 'focus'>(), release = createDeferred<void>();
    const order: string[] = [];
    const queryBounded = jest.fn(async () => {
      order.push('native'); first.resolve('native');
      await release.promise;
      // Deliberately unsealed: this case exercises an unavailable native result,
      // not a fabricated successful capture or metric.
      return {columns: ['id', 'ts', 'dur', 'track_id'], rows: [[7, 10, 100, 9]], durationMs: 1};
    });
    const runtime = createOpenAiRuntimeForTest({queryBounded,
      query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})), getTrace: jest.fn(),
    } as unknown as TraceProcessorService);
    const focus = jest.spyOn(focusDetector, 'detectFocusApps').mockImplementation(async () => {
      order.push('focus'); first.resolve('focus'); return {apps: [], method: 'none'};
    });
    jest.spyOn(runtime, 'detectArchitecture').mockResolvedValue(undefined);
    jest.spyOn(runtime, 'detectCompleteness').mockResolvedValue(undefined);
    const selected = jest.spyOn(sceneEntryEvidence, 'collectSelectedEvidenceForPrompt');
    const legacy = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt');
    const reset = jest.spyOn(runtime, 'resetAnalysisSessionState');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const body = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []}) + '\nA bounded answer.';
    const run = mockRun(sdkStream(body));
    const options: AnalysisOptions = {providerId: null, runId: `run-${sessionId}`, analysisMode: 'full',
      selectionContext: {kind: 'track_event', source: 'track_event_selection', nativeTable: 'slice',
        eventId: 7, ts: 10, dur: 100}};
    return {runtime, first, release, order, queryBounded, focus, selected, legacy, reset, mcp, prompt, run, options};
  }

  it('does not acquire an ambiguous pane selection when pair metadata exists without a reference id', async () => {
    const h = heldNativeLookup('selected-unknown-pane');
    h.options.tracePairContext = {schemaVersion: 1, layout: 'horizontal', primarySide: 'left', referenceSide: 'right',
      activeSide: 'right', panes: [{side: 'left', traceSide: 'current', traceId: 'trace'},
        {side: 'right', traceSide: 'reference', traceId: 'reference', active: true}]};
    const pending: ReturnType<OpenAIRuntime['analyze']> =
      h.runtime.analyze('Why is the selected event slow?', 'selected-unknown-pane', 'trace', h.options);
    try {
      expect(await Promise.race([h.first.promise, pending.then(() => 'settled', () => 'settled')])).toBe('focus');
      h.release.resolve(); attachedDeliveryContext(await pending);
      expect(h.queryBounded).not.toHaveBeenCalled(); expect(h.selected).not.toHaveBeenCalled();
    } finally {h.release.resolve(); await pending.catch(() => undefined);}
  });

  it('uses the frozen run selection when caller-owned options change during registry initialization', async () => {
    const h = heldNativeLookup('selected-frozen-scope');
    const entered = createDeferred<void>(), releaseRegistry = createDeferred<void>();
    const ensureRegistry = skillLoading.ensureSkillRegistryInitialized;
    jest.spyOn(skillLoading, 'ensureSkillRegistryInitialized').mockImplementation(ensureRegistry)
      .mockImplementationOnce(async () => {entered.resolve(); await releaseRegistry.promise; await ensureRegistry();});
    const selection = h.options.selectionContext;
    if (selection?.kind !== 'track_event') throw new Error('Expected the fixture event');
    const pending: ReturnType<OpenAIRuntime['analyze']> =
      h.runtime.analyze('Why is the selected event slow?', 'selected-frozen-scope', 'trace', h.options);
    try {
      expect(await Promise.race([entered.promise.then(() => 'registry'), pending.then(() => 'settled', () => 'settled')]))
        .toBe('registry');
      selection.eventId = 8;
      releaseRegistry.resolve();
      expect(await Promise.race([h.first.promise, pending.then(() => 'settled', () => 'settled')])).toBe('native');
      expect((h.queryBounded.mock.calls[0] as unknown as [string, string])[1]).toContain('WHERE id = 7');
      h.release.resolve(); attachedDeliveryContext(await pending);
      expect(h.prompt.mock.calls[0][0].selectionContext).toMatchObject({eventId: 7});
      expect(h.selected.mock.calls[0][0].selectionContext).not.toBe(selection);
    } finally {releaseRegistry.resolve(); h.release.resolve(); await pending.catch(() => undefined);}
  });

  it('awaits the actual selected lookup before focus and handles unavailable authority only once', async () => {
    const h = heldNativeLookup('selected-before-focus');
    const pending: ReturnType<OpenAIRuntime['analyze']> =
      h.runtime.analyze('Why is the selected event slow?', 'selected-before-focus', 'trace', h.options);
    try {
      expect(await Promise.race([h.first.promise, pending.then(() => 'settled', () => 'settled')])).toBe('native');
      expect(h.focus).not.toHaveBeenCalled(); expect(h.mcp).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
      h.release.resolve();
      const result = await pending; attachedDeliveryContext(result);
      expect(h.order).toEqual(['native', 'focus']);
      expect(h.queryBounded).toHaveBeenCalledTimes(1); expect(h.selected).toHaveBeenCalledTimes(1);
      expect(h.legacy).not.toHaveBeenCalled(); expect(h.reset).toHaveBeenCalledTimes(1);
      const earlyStore = h.selected.mock.calls[0][0].artifactStore;
      expect(h.reset.mock.calls[0][3]).toBe(earlyStore);
      expect(h.mcp.mock.calls[0][0].artifactStore).toBe(earlyStore);
      expect(h.prompt.mock.calls[0][0].sceneEvidence).toMatchObject({kind: 'selected_foundation',
        native: {status: 'failed'}, metric: {status: 'not_run'}});
    } finally {h.release.resolve(); await pending.catch(() => undefined);}
  });

  it('keeps focus and model work closed until the cancelled selected API work has actually settled', async () => {
    const h = heldNativeLookup('selected-cancel-drain');
    let settled = false;
    const pending: ReturnType<OpenAIRuntime['analyze']> = h.runtime.analyze('Why is the selected event slow?', 'selected-cancel-drain', 'trace', h.options)
      .finally(() => {settled = true;});
    const outcome = pending.then(value => ({value}), error => ({error}));
    try {
      expect(await Promise.race([h.first.promise, outcome.then(() => 'settled')])).toBe('native');
      await h.runtime.abortSession('selected-cancel-drain');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(h.focus).not.toHaveBeenCalled(); expect(h.mcp).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
      h.release.resolve();
      expect(await outcome).toHaveProperty('error');
      expect(h.focus).not.toHaveBeenCalled(); expect(h.selected).toHaveBeenCalledTimes(1);
      expect(h.queryBounded).toHaveBeenCalledTimes(1); expect(h.legacy).not.toHaveBeenCalled();
    } finally {h.release.resolve(); await outcome;}
  });
});

describe('OpenAI common final-transport observation at actual SDK boundaries', () => {
  const declaration = {schemaVersion: 'conclusion_contract_v1' as const, mode: 'focused_answer' as const,
    conclusions: [], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: []};
  const originalBody = 'PRIVATE_OBSERVED_BODY: the sampled interval is retained.';
  const valid = `${originalBody}\n${renderConclusionContractSidecar(declaration)}`;
  const invalid = `${originalBody}\n${renderConclusionContractSidecar({...declaration, clusters: undefined} as any)}`;
  const configure = () => jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
    protocol: 'chat_completions', baseURL: 'https://gateway.example/v1', model: 'gpt-5.6-sol', lightModel: 'gpt-5.6-sol',
    analysisReasoningEffort: 'low', quickMaxTurns: 3, quickTargetTurns: 2}));
  const scopeFor = (runId: string, sessionId = runId) => {
    const recorder = createRuntimePerformanceRecorder();
    return {recorder, scope: createRuntimePerformanceScope({recorder,
      identity: {runId, sessionId, scope: {tenantId: 'test', workspaceId: 'test'}}, assertCurrent() {}})};
  };

  it.each([
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3-flash'],
    ['https://api.deepseek.com/v1', 'deepseek-flash'],
  ])('records actual provider origin while preserving the full endpoint: %s', async (baseURL, model) => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue(createOpenAiConfigForTest({
      protocol: 'chat_completions', baseURL, model, lightModel: model}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      chatCompletionResponse('origin-response', {role: 'assistant', content: valid}, 'stop'));
    const id = `observed-origin-${model}`, {recorder, scope} = scopeFor(id);
    try {
      const result = await scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
      const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
      const dispatch = recorder.seal().finalTransportObservation!.events.find(event => event.kind === 'main_dispatch')!;
      const origin = new URL(baseURL).origin;
      expect(dispatch.providerOriginHash).toBe(performanceObservation.runtimeObservationHash(origin));
      expect(dispatch.providerOriginHash).not.toBe(performanceObservation.runtimeObservationHash(baseURL));
      const baseURLCommitment = dispatch.controls.commonConfig.find(field => field.field === '/baseURL');
      const expected = performanceObservation.buildRuntimeConfigCommitments({baseURL})!.find(field => field.field === '/baseURL');
      const shortened = performanceObservation.buildRuntimeConfigCommitments({baseURL: origin})!.find(field => field.field === '/baseURL');
      expect(baseURLCommitment).toEqual(expected);
      expect(baseURLCommitment?.valueCommitment).not.toBe(shortened?.valueCommitment);
      expect(request).toHaveBeenCalledTimes(1);
      const [input, init] = request.mock.calls[0];
      expect(input instanceof Request ? input.url : String(input)).toBe(`${baseURL}/chat/completions`);
      expect(JSON.parse(String(init?.body)).model).toBe(model);
      expect(result.completion?.status).toBe('completed');
    } finally {scope.dispose();}
  });

  it.each(['native', 'stray_invalid', 'continuation'] as const)(
    'keeps exact terminal facts and the retained %s author', async mode => {
      configure(); const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
      const first = mode === 'native' ? valid : mode === 'continuation' ? 'Truncated original answer.' : invalid;
      const responses = [chatCompletionResponse('original-response', {role: 'assistant', content: first}, mode === 'continuation' ? 'length' : 'stop'),
        chatCompletionResponse('later-response', {role: 'assistant', content: valid}, 'stop')];
      const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => responses.shift()!);
      const id = `observed-${mode}`, {recorder, scope} = scopeFor(id);
      try {
        const result = await scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
        const context = finalization.takeFinalizationContext(result)!; finalizationContexts.push(context);
        expect(context).not.toHaveProperty('getNativeDeclaration');
        const receipt = recorder.seal().finalTransportObservation!;
        const dispatches = receipt.events.filter(event => event.kind === 'main_dispatch');
        const terminals = receipt.events.filter(event => event.kind === 'native_terminal');
        const retained = receipt.events.find(event => event.kind === 'candidate_retained');
        // A completed answer, even one carrying a stray invalid declaration, is never repaired.
        expect(receipt.truncated).toBe(0); expect(dispatches).toHaveLength(mode === 'continuation' ? 2 : 1);
        expect(terminals).toHaveLength(dispatches.length); expect(request).toHaveBeenCalledTimes(dispatches.length);
        expect(terminals[0]).toMatchObject({fact: {response: {status: 'observed', hash: performanceObservation.runtimeObservationHash('original-response')},
          actualModel: {status: 'observed', hash: performanceObservation.runtimeObservationHash('pinned-primary')},
          rawMaterial: {status: 'observed', hash: performanceObservation.runtimeObservationHash(first)},
          nativeStatus: mode === 'continuation' ? 'incomplete' : 'completed', sdkStreamCompleted: true}, drainStatus: 'fulfilled'});
        if (mode === 'continuation') {
          expect(terminals[1]).toMatchObject({fact: {response: {status: 'observed', hash: performanceObservation.runtimeObservationHash('later-response')},
            rawMaterial: {status: 'observed', hash: performanceObservation.runtimeObservationHash(valid)}, nativeStatus: 'completed'}, drainStatus: 'fulfilled'});
          expect(terminals[1].fact.attemptKey).not.toBe(terminals[0].fact.attemptKey);
          expect(terminals[1].fact.logicalCallKey).not.toBe(terminals[0].fact.logicalCallKey);
        }
        // Declarations are retired: one body author, and no declaration is classified.
        expect(retained).toMatchObject({nativeCandidateKey: expect.any(String), carrier: 'assistant_text',
          transform: 'native', productStatus: 'completed', declaredBody: 'present', declaredClaims: 'unknown',
          authors: [{role: 'body', terminalEventKey: terminals[mode === 'continuation' ? 1 : 0].eventKey}]});
        expect(receipt.events.some(event => event.kind === 'finalizer_selected')).toBe(false);
        expect(receipt.events.filter(event => event.kind === 'candidate_retained')).toHaveLength(1);
        expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_OBSERVED_BODY|gateway\.example|pinned-primary|test-only/);
        expect(dispatches[0].controls.profiles).toEqual([expect.objectContaining({role: 'main_controls', purpose: 'answer_turn'})]);
        expect(dispatches.every(dispatch => dispatch.purpose !== 'declaration_repair')).toBe(true);
      } finally {scope.dispose();}
    });

  it('freezes completed native closeout before product status retains turn exhaustion', async () => {
    configure(); const runtime = createOpenAiRuntimeForTest();
    const read = tool({name: 'observe_fixture', description: 'Read fixture', parameters: z.object({}), execute: async () => 'fixture data'});
    prepareStub(runtime).mockImplementation(async (...args: any[]) => ({systemPrompt: 'test system prompt', tools: [read], allowedTools: [],
      sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns, hypotheses: []}));
    const request = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(chatCompletionToolCall('tool-one', 'observe_fixture', {}))
      .mockResolvedValueOnce(chatCompletionToolCall('tool-two', 'observe_fixture', {}))
      .mockResolvedValueOnce(chatCompletionResponse('closeout-response', {role: 'assistant', content: valid}, 'stop'));
    const id = 'observed-native-product-distinction', {recorder, scope} = scopeFor(id);
    try {
      const result = await scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
      const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
      const events = recorder.seal().finalTransportObservation!.events;
      const terminals = events.filter(event => event.kind === 'native_terminal');
      const terminal = terminals[terminals.length - 1]!;
      const retained = events.find(event => event.kind === 'candidate_retained');
      expect(request).toHaveBeenCalledTimes(3);
      expect(terminal).toMatchObject({fact: {nativeStatus: 'completed', finish: 'stop', sdkStreamCompleted: true,
        response: {status: 'observed', hash: performanceObservation.runtimeObservationHash('closeout-response')}}, drainStatus: 'fulfilled'});
      expect(retained).toMatchObject({productStatus: 'incomplete', authors: [{role: 'body', terminalEventKey: terminal.eventKey}]});
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'turn_limit'});
    } finally {scope.dispose();}
  });

  it('never substitutes configured model identity when the actual terminal omits model', async () => {
    configure(); const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const chunks = [{id: 'unknown-model', choices: [{index: 0, delta: {role: 'assistant', content: valid}, finish_reason: null}]},
      {id: 'unknown-model', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}];
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      {headers: {'content-type': 'text/event-stream'}}));
    const id = 'observed-unknown-model', {recorder, scope} = scopeFor(id);
    try {
      const result = await scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
      const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
      expect(recorder.seal().finalTransportObservation!.events.find(event => event.kind === 'native_terminal'))
        .toMatchObject({fact: {actualModel: {status: 'unknown'}}});
    } finally {scope.dispose();}
  });

  it('does not invent a dispatch from a mocked-away fetch and native SDK start', async () => {
    configure(); const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun().mockResolvedValue(sdkStream(valid));
    const id = 'observed-no-fetch', {recorder, scope} = scopeFor(id);
    try {
      const result = await scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
      const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
      expect(recorder.seal().finalTransportObservation?.events.some(event => event.kind === 'main_dispatch')).not.toBe(true);
    } finally {scope.dispose();}
  });

  it.each(['throw', 'missing', 'early_seal'] as const)('keeps request bytes and product outcome unchanged when observation is %s', async failure => {
    configure(); const requestBodies: string[] = [];
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestBodies.push(String(init?.body)); return chatCompletionResponse('neutral-response', {role: 'assistant', content: valid}, 'stop');
    });
    const execute = async (id: string) => {
      const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); const {recorder, scope} = scopeFor(id);
      try {
        if (failure === 'early_seal' && id.endsWith('changed')) recorder.seal();
        const result = await scope.run(() => runtime.analyze('Same question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
        const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
        return {body: result.conclusion, success: result.success, completion: result.completion?.status};
      } finally {scope.dispose();}
    };
    const before = await execute(`neutral-${failure}-before`);
    const observer = failure === 'throw' ? jest.spyOn(performanceObservation, 'recordRuntimeFinalTransportEvent').mockImplementation(() => {throw new Error('PRIVATE_OBSERVER');})
      : failure === 'missing' ? jest.spyOn(performanceObservation, 'buildRuntimeAppliedModelControls').mockReturnValue(undefined) : undefined;
    try {expect(await execute(`neutral-${failure}-changed`)).toEqual(before);} finally {observer?.mockRestore();}
    expect(request).toHaveBeenCalledTimes(2); expect(requestBodies[1]).toBe(requestBodies[0]);
  });

  it('records no native terminal while the actual fetch is pending', async () => {
    configure(); const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const entered = createDeferred<void>(), release = createDeferred<void>();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered.resolve(); await release.promise; return chatCompletionResponse('held-response', {role: 'assistant', content: valid}, 'stop');
    });
    const id = 'observed-pending-fetch', {recorder, scope} = scopeFor(id);
    const record = jest.spyOn(recorder, 'recordFinalTransportEvent');
    const work = scope.run(() => runtime.analyze('Question', id, 'trace', {providerId: null, runId: id, analysisMode: 'fast'}));
    void work.catch(() => undefined);
    try {
      await entered.promise;
      expect(record.mock.calls.some(([event]) => event.kind === 'main_dispatch')).toBe(true);
      expect(record.mock.calls.some(([event]) => event.kind === 'native_terminal')).toBe(false);
      release.resolve(); const result = await work;
      const context = finalization.takeFinalizationContext(result); if (context) finalizationContexts.push(context);
      expect(recorder.seal().finalTransportObservation!.events.find(event => event.kind === 'native_terminal')).toMatchObject({drainStatus: 'fulfilled'});
    } finally {release.resolve(); await work.catch(() => undefined); scope.dispose();}
  });
});
