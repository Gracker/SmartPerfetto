// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type {CodeAwareTextProjectionReceipt} from '../../../../services/security/codeAwareOutputRegistry';
import {expectRuntimeVendorHintParity} from '../../../__tests__/vendorHintParityFixture';

const mockInterrupt = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockQuery = jest.fn();
const mockIntentTransport = jest.fn<(...args: any[]) => any>();
const defaultIntentDecision = {
  schemaVersion: 1, taskKind: 'investigation', sceneId: 'general', scope: 'scene_wide',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'read_new',
};
function respondWithIntent(overrides: Record<string, unknown> = {}) {
  mockIntentTransport.mockResolvedValue({status: 'ok', text: JSON.stringify({...defaultIntentDecision, ...overrides})});
}
jest.mock('../qoderIntentTransport', () => ({
  runQoderIntentTransport: (...args: unknown[]) => mockIntentTransport(...args),
}));

function createMockSdkStream(messages: unknown[]) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < messages.length) {
            return { value: messages[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    interrupt: mockInterrupt,
    close: mockClose,
  };
}

function privacyProjectionApi() {
  return jest.requireActual<typeof import('../../../../services/security/codeAwareOutputRegistry')>(
    '../../../../services/security/codeAwareOutputRegistry',
  );
}

function issuedReplacementReceipt(text: string): CodeAwareTextProjectionReceipt {
  const api = privacyProjectionApi();
  const sessionId = 'qoder-test-issued-replacement';
  api.clearCodeAwareOutputGuards(sessionId);
  api.revokeCodeAwareOutputGuards(sessionId);
  const projection = api.createCodeAwareStreamingTextProjection(sessionId, 'test');
  const receipt = projection.projectCompleteWithReceipt(text);
  api.clearCodeAwareOutputGuards(sessionId);
  return receipt;
}

function readPromptContext(prompt: string, context: string): unknown {
  for (const line of prompt.split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value?.context === context) return value.data;
    } catch { /* External prose templates are not protocol records. */ }
  }
  return undefined;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForMockQuery(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mockQuery.mock.calls.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for Qoder SDK query to start');
}

const mockSdkModule = {
  query: mockQuery,
  qodercliAuth: jest.fn().mockReturnValue({ type: 'qodercli' }),
  accessTokenFromEnv: jest.fn().mockReturnValue({ type: 'accessToken' }),
  createSdkMcpServer: jest.fn(),
  AbortError: class AbortError extends Error { name = 'AbortError'; },
};

const mockRegisterSkills = jest.fn();
const mockSetFragmentRegistry = jest.fn();
const mockEnsureSkillRegistryInitialized = jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined);
const mockLoadQoderSdkModule = jest.fn<(...args: any[]) => any>().mockResolvedValue(mockSdkModule);
const mockResetQoderSdkModuleCache = jest.fn();
const mockCreateClaudeMcpServer = jest.fn().mockReturnValue({
  server: { name: 'smartperfetto' },
  allowedTools: ['mcp__smartperfetto__query_trace'],
  toolDefinitions: [],
});
const mockProjectionWrite = jest.fn<(text: string) => string>().mockImplementation(text => text);
const mockProjectionFlush = jest.fn<() => string>().mockReturnValue('');
const mockProjectionProjectComplete = jest.fn<(text: string) => CodeAwareTextProjectionReceipt>();
const mockBuildComparisonContext = jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined);
const mockBuildQuickConversationContext = jest.fn<(...args: any[]) => any>().mockReturnValue(undefined);
const mockFormatTraceContext = jest.fn<(...args: any[]) => any>().mockReturnValue('');

jest.mock('../qoderSdkLoader', () => ({
  loadQoderSdkModule: (...args: unknown[]) => mockLoadQoderSdkModule(...args),
  resetQoderSdkModuleCache: () => mockResetQoderSdkModuleCache(),
}));

jest.mock('../../../../services/skillEngine/skillExecutor', () => ({
  createSkillExecutor: jest.fn<(...args: any[]) => any>().mockReturnValue({
    registerSkills: mockRegisterSkills,
    setFragmentRegistry: mockSetFragmentRegistry,
    setRunManifestAttributionSink: jest.fn(),
    executeSkill: jest.fn(),
  }),
}));

jest.mock('../../../../services/skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: (...args: unknown[]) => mockEnsureSkillRegistryInitialized(...args),
  skillRegistry: {
    isInitialized: jest.fn<(...args: any[]) => any>().mockReturnValue(false),
    getAllSkills: jest.fn<(...args: any[]) => any>().mockReturnValue([]),
    getFragmentCache: jest.fn<(...args: any[]) => any>().mockReturnValue(new Map()),
  },
}));

jest.mock('../../../../agentv3/claudeMcpServer', () => ({
  createClaudeMcpServer: (...args: unknown[]) => mockCreateClaudeMcpServer(...args),
  loadLearnedSqlFixPairs: jest.fn<(...args: any[]) => any>().mockReturnValue([]),
}));

jest.mock('../../../../agent/detectors/architectureDetector', () => ({
  createArchitectureDetector: jest.fn<(...args: any[]) => any>().mockReturnValue({
    detect: jest.fn<(...args: any[]) => any>().mockResolvedValue({ type: 'pixel' }),
  }),
}));

jest.mock('../../../../agentv3/focusAppDetector', () => {
  const actual = jest.requireActual<typeof import('../../../../agentv3/focusAppDetector')>(
    '../../../../agentv3/focusAppDetector',
  );
  return {
    ...actual,
    detectFocusApps: jest.fn<(...args: any[]) => any>().mockResolvedValue({ apps: [], method: 'none' }),
  };
});

jest.mock('../../../../agentv3/traceCompletenessProber', () => ({
  probeTraceCompleteness: jest.fn<(...args: any[]) => any>().mockResolvedValue({
    available: [],
    missingConfig: [],
    notApplicable: [],
    insufficient: [],
  }),
}));

jest.mock('../../../../services/finalResultQualityGate', () => ({
  applyFinalResultQualityGate: jest.fn(),
}));

jest.mock('../../claude/claudeVerifier', () => ({
  verifyConclusion: jest.fn<(...args: any[]) => any>().mockResolvedValue({ heuristicIssues: [], llmIssues: [] }),
}));

jest.mock('../../../../services/security/codeAwareOutputRegistry', () => {
  const actual = jest.requireActual<typeof import('../../../../services/security/codeAwareOutputRegistry')>(
    '../../../../services/security/codeAwareOutputRegistry',
  );
  return {
    ...actual,
    createCodeAwareStreamingTextProjection: jest.fn<(...args: any[]) => any>().mockImplementation((sessionId: string, channel: string) => channel === 'qoder-answer' ? ({
      write: mockProjectionWrite,
      flush: mockProjectionFlush,
      projectComplete: (text: string) => text,
      projectCompleteWithReceipt: mockProjectionProjectComplete,
    }) : actual.createCodeAwareStreamingTextProjection(sessionId, channel)),
  };
});

jest.mock('../../../../agentv3/claudeFindingExtractor', () => ({
  extractFindingsFromText: jest.fn<(...args: any[]) => any>().mockReturnValue([]),
}));

jest.mock('../../../runtimePromptContext', () => ({
  ...jest.requireActual<typeof import('../../../runtimePromptContext')>('../../../runtimePromptContext'),
  buildRuntimeTracePairComparisonContext: (...args: unknown[]) => mockBuildComparisonContext(...args),
  buildQuickConversationContext: (...args: unknown[]) => mockBuildQuickConversationContext(...args),
  formatTraceContext: (...args: unknown[]) => mockFormatTraceContext(...args),
}));

import { QoderRuntime } from '../qoderRuntime';
import { createSkillExecutor } from '../../../../services/skillEngine/skillExecutor';
import { sessionContextManager } from '../../../../agent/context/enhancedSessionContext';
import { createArchitectureDetector } from '../../../../agent/detectors/architectureDetector';
import { detectFocusApps } from '../../../../agentv3/focusAppDetector';
import { probeTraceCompleteness } from '../../../../agentv3/traceCompletenessProber';
import {analysisDeliveryFingerprint} from '../../../../types/analysisDelivery';
import {takeFinalizationContext} from '../../../analysisFinalizationContext';
import type {AnalysisOptions} from '../../../../agent/core/orchestratorTypes';
import {buildAnalysisContextAuthorizationFingerprint} from '../../../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../../../services/scopedKnowledgeStore';
import {ArtifactStore} from '../../../../agentv3/artifactStore';
import {createRuntimeEvidenceContext} from '../../../runtimeEvidenceContext';
import {captureEvidenceTable} from '../../../../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../../../services/traceProcessorConnectionModel';
import {access} from 'node:fs/promises';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from '../../../__tests__/sourceFinalizationFixture';
import {resolveFocusPackageCell} from '../../../__tests__/focusEvidenceFixture';
import {createRuntimePerformanceRecorder} from '../../../runtimePerformance';
import type {RunManifestAttributionSink} from '../../../../types/selfEvolution';
import {McpToolRegistry} from '../../../../agentv3/mcpToolRegistry';
import type {AnalysisPlanTracker} from '../../../../agentv3/planToolCallRecorder';
import type {ClaudeSdkToolLike} from '../../../runtimeToolSpec';
import type {RuntimeToolInvocationEvent, RuntimeToolObserver} from '../../../runtimeToolObserver';
import {createRuntimeToolResult} from '../../../runtimeToolResult';
import {projectCodeAwareStreamingUpdate} from '../../../../services/security/codeAwareStreamingUpdateProjection';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../../../services/canonicalAnalysisResult';
import {createSceneRuntimeMatrixFixture} from '../../../../../tests/helpers/sceneRuntimeMatrixFixture';
import {candidateWithPopulation} from '../../../../../tests/helpers/conclusionDeclarationFixture';
import * as analysisPatternMemory from '../../../../agentv3/analysisPatternMemory';
import * as caseBackgroundContext from '../../../../services/caseEvolution/caseBackgroundContext';
import {admitLearnedEntry, withDurableLearningPermission} from '../../../../services/security/durableLearning';
import type {ClaudeMcpServerOptions} from '../../../../agentv3/claudeMcpServer';
import {NO_PRIVATE_CONTEXT} from '../../../../services/security/analysisPrivateContext';

function createRuntime(
  env: Record<string, string | undefined> = {},
  traceProcessorService: { query: (...args: any[]) => Promise<unknown> } = {
    query: jest.fn(async () => undefined),
  },
) {
  return new QoderRuntime({
    env: {
      QODER_PERSONAL_ACCESS_TOKEN: 'test-token',
      ...env,
    },
    selection: { kind: 'qoder-agent-sdk', source: 'env' },
    traceProcessorService,
  } as any);
}

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
): RunManifestAttributionSink {
  return {
    identity: {
      runId: 'run-test',
      sessionId: 'session-1',
      scope: {
        tenantId: 'tenant-test',
        workspaceId: 'workspace-test',
      },
    },
    runtimePerformanceRecorder,
    recordScene: jest.fn(),
    recordRuntime: jest.fn(),
    recordMode: jest.fn(),
    recordAdaptiveRouting: jest.fn(),
    recordCapabilityManifest: jest.fn(),
    recordSkillRegistry: jest.fn(),
    startSkillInvocation: jest.fn(() => 'skill-invocation-test'),
    finishSkillInvocation: jest.fn(),
    recordUnknownSkillInvocation: jest.fn(),
    recordSqlStatement: jest.fn(),
    recordPromptTemplate: jest.fn(),
    recordInjection: jest.fn(),
    recordToolAllowlist: jest.fn(),
    recordTurn: jest.fn(),
  };
}

describe('QoderRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureSkillRegistryInitialized.mockResolvedValue(undefined);
    mockLoadQoderSdkModule.mockResolvedValue(mockSdkModule);
    sessionContextManager.remove('session-1');
    mockProjectionWrite.mockImplementation(text => text);
    mockProjectionFlush.mockReturnValue('');
    mockProjectionProjectComplete.mockImplementation(text => privacyProjectionApi().sanitizeCodeAwareTextWithReceipt(undefined, text));
    respondWithIntent();
    mockBuildComparisonContext.mockResolvedValue(undefined);
    mockBuildQuickConversationContext.mockReturnValue(undefined);
    mockFormatTraceContext.mockReturnValue('');
    mockCreateClaudeMcpServer.mockReturnValue({
      server: { name: 'smartperfetto' },
      allowedTools: ['mcp__smartperfetto__query_trace'],
      toolDefinitions: [],
    });
  });

  it('scene runtime matrix: runs the pinned Qoder provider through shared proposal and private seal', async () => {
    const f = createSceneRuntimeMatrixFixture('qoder');
    const runtime = createRuntime({QODER_MODEL: 'scene-pinned-qoder'}, f.traceProcessorService);
    const actualMcp = jest.requireActual<typeof import('../../../../agentv3/claudeMcpServer')>('../../../../agentv3/claudeMcpServer');
    mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => actualMcp.createClaudeMcpServer(options));
    let sceneTool: any;
    let response: any;
    mockQuery.mockImplementationOnce((params: any) => ({
      async *[Symbol.asyncIterator]() {
        expect(params.options.model).toBe('scene-pinned-qoder');
        sceneTool = params.options.mcpServers.smartperfetto.instance.tools.find((item: any) => item.name === 'propose_scene_timeline');
        response = await sceneTool.handler(f.proposal(), {});
        yield {type: 'result', subtype: 'success', is_error: false, result: 'Scene candidates submitted.'};
      }, close: mockClose, interrupt: mockInterrupt,
    }));
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(result.turnIntent).toMatchObject({source: 'product', sceneId: 'scene_reconstruction'});
      expect(mockIntentTransport.mock.calls.filter(([input]) => input.systemPrompt === '')).toHaveLength(0);
      if (!response) throw new Error(`Scene mock provider did not execute: ${result.conclusion}`);
      expect(response.structuredContent).toMatchObject({accepted: true, revision: 1});
      const snapshot = f.seal();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.runId).toBe(f.scope.runId);
      expect(snapshot.segments[0].evidence[0].source.originRunId).toBe(f.scope.runId);
      expect(f.boundsQueries).toEqual([f.scope.traceId]);
      f.controller.abort();
      const late = await sceneTool.handler(f.proposal(), {}).catch((error: Error) => ({error: error.message}));
      expect(late.structuredContent?.accepted).not.toBe(true);
    } finally {runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
    expect((runtime as any).artifactStores.has(f.scope.sessionId)).toBe(false);
  });

  describe('shared tool observation', () => {
    it.each([false, true])('keeps pending exploration advisory after native completion or failure: failed=%s', async nativeError => {
      const verifier = jest.requireMock('../../claude/claudeVerifier') as {verifyConclusion: jest.Mock};
      const actualVerifier = jest.requireActual<typeof import('../../claude/claudeVerifier')>('../../claude/claudeVerifier');
      const previousVerifier = verifier.verifyConclusion.getMockImplementation();
      verifier.verifyConclusion.mockImplementation(actualVerifier.verifyConclusion as any);
      mockQuery.mockReset();
      let tracker!: AnalysisPlanTracker;
      const hypothesis = {id: 'open-hypothesis', statement: 'A separate cause may exist.', status: 'formed', formedAt: 1};
      mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => {
        tracker = options.analysisPlan;
        tracker.current = {phases: [{id: 'explore', name: 'Optional exploration', goal: 'Investigate a further explanation',
          expectedTools: ['execute_sql'], status: 'pending'}], successCriteria: 'Explore the open question', submittedAt: 1, toolCallLog: []};
        options.hypotheses.push(hypothesis);
        return {server: {name: 'smartperfetto'}, allowedTools: ['mcp__smartperfetto__query_trace'], toolDefinitions: []};
      });
      const body = 'The observed value is 17.';
      mockQuery.mockReturnValueOnce(createMockSdkStream([{type: 'result', subtype: nativeError ? 'error' : 'success',
        is_error: nativeError, result: body, ...(nativeError ? {errors: ['Native provider failure']} : {})}]))
        .mockReturnValueOnce(createMockSdkStream([{type: 'result', subtype: 'error', is_error: true, errors: ['Queued provider failure']} ]));
      try {
        const result = await createRuntime().analyze('Read the current value', `qoder-advisory-${nativeError}`, 'trace-1');
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result.conclusion).toBe(body);
        expect(result.completion).toMatchObject({status: nativeError ? 'failed' : 'completed',
          conclusionFingerprint: analysisDeliveryFingerprint(body)});
        expect(result.success).toBe(!nativeError);
        expect(result.partial).toBe(nativeError);
        expect(result.terminationReason).toBe(nativeError ? 'execution_error' : undefined);
        const verification = await verifier.verifyConclusion.mock.results[0].value;
        expect(verification).toMatchObject({heuristicIssues: expect.arrayContaining([
          expect.objectContaining({type: 'plan_deviation', severity: 'error'}),
          expect.objectContaining({type: 'unresolved_hypothesis', severity: 'error'}),
        ])});
        expect(tracker.current?.phases).toEqual([expect.objectContaining({id: 'explore', status: 'pending'})]);
        expect(hypothesis.status).toBe('formed');
      } finally {
        verifier.verifyConclusion.mockImplementation(previousVerifier!);
        mockQuery.mockReset();
      }
    });

    it.each(['fast', 'full'] as const)('passes a per-run observer to the %s MCP surface', async analysisMode => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'},
      ]));
      await createRuntime().analyze('test query', 'session-1', 'trace-1', {analysisMode});
      expect(mockCreateClaudeMcpServer.mock.calls[0][0]).toEqual(expect.objectContaining({
        toolObserver: expect.any(Function),
      }));
    });

    // The same options carry the run's own learning grant, under which
    // execute_sql learns fixes.
    it('gives the shared MCP tools the vendor hint from its own options, and the run grant', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'},
      ]));
      await createRuntime().analyze('分析启动性能', 'session-1', 'trace-1',
        withDurableLearningPermission({analysisMode: 'full' as const, runId: 'run-qoder-mcp'}, NO_PRIVATE_CONTEXT));
      const runtimeOptions = mockCreateClaudeMcpServer.mock.calls[0][0] as Partial<ClaudeMcpServerOptions>;
      expect(admitLearnedEntry(runtimeOptions.durableLearning, 1)?.runId).toBe('run-qoder-mcp');
      const actualMcp = jest.requireActual<typeof import('../../../../agentv3/claudeMcpServer')>('../../../../agentv3/claudeMcpServer');
      await expectRuntimeVendorHintParity({
        createMcpServer: actualMcp.createClaudeMcpServer, runtimeOptions});
    });

    it('records actual SDK descriptor outcomes once with intact receipts and auto-phase events', async () => {
      let descriptor!: ClaudeSdkToolLike;
      let tracker!: AnalysisPlanTracker;
      let calls = 0;
      const failure = new Error('SQL execution failed');
      mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => {
        tracker = options.analysisPlan;
        tracker.current = {
          phases: [
            {id: 'p1', name: 'First evidence', goal: 'Gather evidence', expectedTools: ['execute_sql'], status: 'pending'},
            {id: 'p2', name: 'Current investigation', goal: 'Investigate', expectedTools: ['execute_sql'], status: 'in_progress'},
          ],
          successCriteria: 'Actual successful evidence', submittedAt: 1, toolCallLog: [],
        };
        const registry = new McpToolRegistry({toolObserver: options.toolObserver});
        registry.registerShared({
          name: 'execute_sql', description: 'Execute SQL', exposure: 'public', inputSchema: {},
          handler: async () => {
            calls += 1;
            if (calls === 4) throw failure;
            const success = calls === 1 ? true : calls === 2 ? false : undefined;
            return createRuntimeToolResult({rows: ['x'.repeat(13_000)]}, {
              facts: {success, planPhaseId: calls === 1 ? 'p1' : 'p2'},
            });
          },
        });
        descriptor = registry.list()[0].tool as ClaudeSdkToolLike;
        return {server: registry.buildSdkServer(), allowedTools: registry.buildAllowedTools(), toolDefinitions: registry.list()};
      });
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          const params = {sql: 'select 1'};
          for (let call = 0; call < 3; call += 1) await descriptor.handler(params, {toolCallId: 'unknown'});
          await expect(descriptor.handler(params, {})).rejects.toBe(failure);
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));
      const result = await runtime.analyze('test query', 'session-1', 'trace-1', {analysisMode: 'full'});

      expect(result.success).toBe(true);
      const records = tracker.current!.toolCallLog;
      expect(records.map(record => record.success)).toEqual([true, false, undefined, false]);
      // A raw exception has no producer receipt; it must not inherit the
      // active phase at the later time when the exception is observed.
      expect(records.map(record => record.matchedPhaseId)).toEqual(['p1', 'p2', 'p2', undefined]);
      expect(new Set(records.map(record => record.toolCallId)).size).toBe(4);
      expect(tracker.dispatchedToolCallCount).toBe(4);
      expect(tracker.current!.phases.map(phase => phase.status)).toEqual(['completed', 'in_progress']);
      expect(updates.filter(update => update.type === 'plan_phase_updated')).toEqual([
        expect.objectContaining({content: expect.objectContaining({phaseId: 'p1', status: 'completed', origin: 'auto'})}),
      ]);
      const starts = updates.filter(update => update.type === 'agent_task_dispatched');
      const results = updates.filter(update => update.type === 'agent_response');
      expect(starts).toHaveLength(4);
      expect(results.map(update => update.content.taskId)).toEqual(starts.map(update => update.content.taskId));
      expect(results.map(update => update.content.isError)).toEqual([false, true, false, true]);
      expect(results[0].content.result).toContain('[truncated external tool result;');
      expect(result.rounds).toBe(1);
    });

    it.each(['execute_sql', 'write_analysis_note'])('deduplicates real SDK IDs for %s before counting or publishing outcomes', async toolName => {
      let descriptor!: ClaudeSdkToolLike;
      let tracker!: AnalysisPlanTracker;
      const failure = new Error('actual handler failure');
      const handler = jest.fn(async (_params: Record<string, unknown>, extra: {toolCallId?: string}) => {
        if (extra.toolCallId === 'failed') throw failure;
        return createRuntimeToolResult({success: true});
      });
      mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => {
        tracker = options.analysisPlan;
        const registry = new McpToolRegistry({toolObserver: options.toolObserver});
        registry.registerShared({
          name: toolName, description: 'Observed tool', exposure: 'public', inputSchema: {}, handler,
        });
        descriptor = registry.list()[0].tool as ClaudeSdkToolLike;
        return {server: registry.buildSdkServer(), allowedTools: registry.buildAllowedTools(), toolDefinitions: registry.list()};
      });
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          const params = {query: 'identical input'};
          for (const toolCallId of ['same-id', 'same-id', 'distinct-1', 'distinct-2', undefined, undefined]) {
            await descriptor.handler(params, {toolCallId});
          }
          await expect(descriptor.handler(params, {toolCallId: 'failed'})).rejects.toBe(failure);
          await expect(descriptor.handler(params, {toolCallId: 'failed'})).rejects.toBe(failure);
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));
      const result = await runtime.analyze('test query', 'session-1', 'trace-1', {analysisMode: 'full'});

      expect(result).toMatchObject({success: true, rounds: 1});
      expect(handler).toHaveBeenCalledTimes(8);
      expect(tracker.dispatchedToolCallCount).toBe(6);
      const starts = updates.filter(update => update.type === 'agent_task_dispatched');
      const results = updates.filter(update => update.type === 'agent_response');
      expect(starts).toHaveLength(6);
      expect(results).toHaveLength(6);
      expect(results.map(update => update.content.taskId)).toEqual(starts.map(update => update.content.taskId));
      expect(new Set(starts.map(update => update.content.taskId)).size).toBe(6);
      expect(results.filter(update => update.content.isError)).toEqual([
        expect.objectContaining({content: expect.objectContaining({taskId: 'failed', isError: true})}),
      ]);
      expect(tracker.prePlanToolCallLog).toHaveLength(toolName === 'execute_sql' ? 6 : 0);
    });

    it.each([false, true])('retains private source outcomes before transport truncation (body=%s)', async includeBody => {
      let descriptor!: ClaudeSdkToolLike;
      mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => {
        const registry = new McpToolRegistry({toolObserver: options.toolObserver});
        registry.registerShared({
          name: 'search_codebase', description: 'Search source', exposure: 'public', inputSchema: {},
          handler: async () => createRuntimeToolResult({success: true, matches: Array.from({length: 20}, (_, i) => ({
            referenceId: `source-reference-${i}`, codebaseId: 'codebase-a',
            filePath: `src/PRIVATE_SOURCE_PATH_${i}.kt`, lineRange: {start: 1, end: 20},
            ...(includeBody ? {text: 'PRIVATE_SOURCE_BODY'} : {}),
          }))}),
        });
        descriptor = registry.list()[0].tool as ClaudeSdkToolLike;
        return {server: registry.buildSdkServer(), allowedTools: registry.buildAllowedTools(), toolDefinitions: registry.list()};
      });
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await descriptor.handler({}, {toolCallId: 'source-outcome'});
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));
      await expect(runtime.analyze('test query', 'qoder-source-outcome', 'trace-1', {analysisMode: 'full'}))
        .resolves.toMatchObject({success: true});
      const update = updates.find(item => item.type === 'agent_response')!;
      expect(() => JSON.parse(update.content.result)).toThrow();
      expect(update.content.privateToolResultReceipt).toBeDefined();
      const projected = projectCodeAwareStreamingUpdate('qoder-source-outcome', update, true, 'en');
      expect(projected).toMatchObject({content: {resultNarration: includeBody
        ? 'Authorized content was read and is available to check against trace evidence'
        : 'Candidate source or knowledge locations are available; their content has not been read'}});
      expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
    });

    it('keeps source references ephemeral while projecting both public result and narration', async () => {
      const rawText = 'QODER_RAW_SOURCE_CANARY';
      const rawPath = 'src/QODER_PRIVATE_PATH_CANARY.ts';
      const reference = {
        referenceId: 'source-reference-1', codebaseId: 'source-1', filePath: rawPath,
        lineRange: {start: 1, end: 2}, text: rawText,
      };
      const rawResult = createRuntimeToolResult({success: true, reference});
      let descriptor!: ClaudeSdkToolLike;
      let tracker!: AnalysisPlanTracker;
      mockCreateClaudeMcpServer.mockImplementationOnce((options: any) => {
        tracker = options.analysisPlan;
        const registry = new McpToolRegistry({toolObserver: options.toolObserver});
        registry.registerShared({
          name: 'read_codebase_file', description: 'Read source', exposure: 'public', inputSchema: {},
          handler: async () => rawResult,
        });
        descriptor = registry.list()[0].tool as ClaudeSdkToolLike;
        return {server: registry.buildSdkServer(), allowedTools: registry.buildAllowedTools(), toolDefinitions: registry.list()};
      });
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await expect(descriptor.handler({}, {})).resolves.toBe(rawResult);
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));
      await expect(runtime.analyze('test query', 'session-1', 'trace-1', {analysisMode: 'full'}))
        .resolves.toMatchObject({success: true});

      const record = tracker.prePlanToolCallLog![0];
      expect(record).toMatchObject({success: true});
      const publicResult = updates.find(update => update.type === 'agent_response').content;
      expect(publicResult.result).toContain('filePathHash');
      expect(JSON.stringify({updates, tracker})).not.toContain(rawText);
      expect(JSON.stringify({updates, tracker})).not.toContain(rawPath);
    });

    it.each(['completed', 'cancelled', 'request-cancelled'] as const)('ignores started/completed/failed callbacks after %s', async ending => {
      const releaseStream = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          await releaseStream.promise;
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));
      const analysis = runtime.analyze('test query', 'session-1', 'trace-1', {analysisMode: 'full'});
      await waitForMockQuery();
      const options = mockCreateClaudeMcpServer.mock.calls[0][0] as {
        toolObserver: RuntimeToolObserver; analysisPlan: AnalysisPlanTracker; emitUpdate: (update: any) => void;
      };
      const requestController = new AbortController();
      if (ending === 'completed') {
        releaseStream.resolve();
        await analysis;
      } else if (ending === 'cancelled') {
        await runtime.abortSession('session-1');
        await analysis;
      } else {
        requestController.abort();
      }
      const previousUpdateCount = updates.length;
      const invocation = {
        toolCallId: 'late-call', toolName: 'execute_sql', params: {sql: 'select 1'},
        extra: {signal: requestController.signal},
      };
      const events: RuntimeToolInvocationEvent[] = [
        {...invocation, phase: 'started'},
        {...invocation, phase: 'completed', result: createRuntimeToolResult({success: true})},
        {...invocation, phase: 'failed', error: new Error('late failure')},
      ];
      for (const event of events) await options.toolObserver(event);
      if (ending !== 'request-cancelled') {
        options.emitUpdate({type: 'progress', content: 'late MCP update', timestamp: 1});
      }
      expect(options.analysisPlan.dispatchedToolCallCount).toBe(0);
      expect(options.analysisPlan.prePlanToolCallLog).toEqual([]);
      expect(updates).toHaveLength(previousUpdateCount);
      releaseStream.resolve();
      await analysis;
    });

    it('scopes SDK ID deduplication to each run while a cancelled handler settles late', async () => {
      const oldHandlerStarted = createDeferred<void>();
      const releaseOldHandler = createDeferred<void>();
      const releaseOldStream = createDeferred<void>();
      const descriptors: ClaudeSdkToolLike[] = [];
      const trackers: AnalysisPlanTracker[] = [];
      const handler = jest.fn(async () => createRuntimeToolResult({success: true}));
      let lateResult!: ReturnType<ClaudeSdkToolLike['handler']>;
      const buildMcp = (options: any) => {
        const isFirstRun = descriptors.length === 0;
        trackers.push(options.analysisPlan);
        const registry = new McpToolRegistry({toolObserver: options.toolObserver});
        registry.registerShared({
          name: 'execute_sql', description: 'Execute SQL', exposure: 'public', inputSchema: {},
          handler: async () => {
            if (isFirstRun) {
              oldHandlerStarted.resolve();
              await releaseOldHandler.promise;
            }
            return handler();
          },
        });
        descriptors.push(registry.list()[0].tool as ClaudeSdkToolLike);
        return {server: registry.buildSdkServer(), allowedTools: registry.buildAllowedTools(), toolDefinitions: registry.list()};
      };
      mockCreateClaudeMcpServer.mockImplementationOnce(buildMcp).mockImplementationOnce(buildMcp);
      mockQuery.mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          lateResult = descriptors[0].handler({}, {toolCallId: 'reused-id'});
          await releaseOldStream.promise;
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nold'};
        },
        interrupt: mockInterrupt, close: mockClose,
      }).mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          await descriptors[1].handler({}, {toolCallId: 'reused-id'});
          releaseOldHandler.resolve();
          await lateResult;
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nnew'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      const runtime = createRuntime();
      const updates: any[] = [];
      runtime.on('update', update => updates.push(update));
      const first = runtime.analyze('first', 'session-1', 'trace-1', {analysisMode: 'full'});
      await oldHandlerStarted.promise;
      await runtime.abortSession('session-1');
      await expect(first).resolves.toMatchObject({success: false});
      await expect(runtime.analyze('second', 'session-1', 'trace-1', {analysisMode: 'full'}))
        .resolves.toMatchObject({success: true});
      releaseOldStream.resolve();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(trackers[1]).toBe(trackers[0]);
      expect(trackers[1].dispatchedToolCallCount).toBe(1);
      expect(trackers[1].prePlanToolCallLog).toEqual([
        expect.objectContaining({toolCallId: 'reused-id', success: true}),
      ]);
      expect(updates.filter(update => update.type === 'agent_task_dispatched')).toHaveLength(2);
      expect(updates.filter(update => update.type === 'agent_response')).toEqual([
        expect.objectContaining({content: expect.objectContaining({taskId: 'reused-id', isError: false})}),
      ]);
    });

    it('rejects old-run callbacks while a new run owns the same session and plan tracker', async () => {
      mockQuery.mockReturnValueOnce(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nfirst'},
      ]));
      const runtime = createRuntime();
      const updates: any[] = [];
      runtime.on('update', update => updates.push(update));
      await runtime.analyze('first', 'session-1', 'trace-1', {analysisMode: 'full'});
      const oldOptions = mockCreateClaudeMcpServer.mock.calls[0][0] as {
        toolObserver: RuntimeToolObserver; analysisPlan: AnalysisPlanTracker;
      };
      mockQuery.mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          const previousUpdateCount = updates.length;
          const invocation = {toolCallId: 'old-call', toolName: 'execute_sql', params: {}, extra: {}};
          await oldOptions.toolObserver({...invocation, phase: 'started'});
          await oldOptions.toolObserver({...invocation, phase: 'completed', result: createRuntimeToolResult({success: true})});
          await oldOptions.toolObserver({...invocation, phase: 'failed', error: new Error('old failure')});
          expect(updates).toHaveLength(previousUpdateCount);
          yield {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nsecond'};
        },
        interrupt: mockInterrupt, close: mockClose,
      });
      await expect(runtime.analyze('second', 'session-1', 'trace-1', {analysisMode: 'full'}))
        .resolves.toMatchObject({success: true});
      const newOptions = mockCreateClaudeMcpServer.mock.calls[1][0] as {analysisPlan: AnalysisPlanTracker};
      expect(newOptions.analysisPlan).toBe(oldOptions.analysisPlan);
      expect(newOptions.analysisPlan.dispatchedToolCallCount).toBe(0);
      expect(newOptions.analysisPlan.prePlanToolCallLog).toEqual([]);
    });
  });

  describe('tool and permission boundaries', () => {
    it('disables all built-in SDK tools via tools: []', async () => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'ses-1' },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test query', 'session-1', 'trace-1');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.tools).toEqual([]);
      expect(callArgs.options.allowDangerouslySkipPermissions).toBeUndefined();
      expect(callArgs.options.settingSources).toEqual([]);
      expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    });

    it('does not leak secret env vars to the SDK subprocess', async () => {
      const messages = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime({
        SECRET_API_KEY: 'super-secret',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        DATABASE_URL: 'postgres://secret',
        QODER_PERSONAL_ACCESS_TOKEN: 'test-token',
        QODER_MODEL: 'test-model',
        QODER_BYOK_API_KEY: 'deepseek-secret',
        QODER_BYOK_PROVIDER: 'deepseek',
      });
      await runtime.analyze('test', 'session-1', 'trace-1');

      const callArgs = mockQuery.mock.calls[0][0] as any;
      const sdkEnv = callArgs.options.env;
      expect(sdkEnv.SECRET_API_KEY).toBeUndefined();
      expect(sdkEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sdkEnv.DATABASE_URL).toBeUndefined();
      expect(sdkEnv.QODER_PERSONAL_ACCESS_TOKEN).toBe('test-token');
      expect(sdkEnv.QODER_MODEL).toBe('test-model');
      expect(sdkEnv.QODER_BYOK_API_KEY).toBeUndefined();
      expect(sdkEnv.QODER_BYOK_PROVIDER).toBeUndefined();
    });

    it('routes Qoder model calls through a complete BYOK model policy', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));

      const runtime = createRuntime({
        QODER_MODEL: 'deepseek-main',
        QODER_LIGHT_MODEL: 'deepseek-light',
        QODER_BYOK_API_KEY: 'deepseek-secret',
        QODER_BYOK_PROVIDER: 'deepseek',
        QODER_BYOK_BASE_URL: 'https://api.deepseek.com/v1',
        QODER_BYOK_STYLE: 'openai',
      });
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      await runtime.analyze('test', 'session-1', 'trace-1', {
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      });

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.model).toBe('deepseek-main');
      expect(callArgs.options.resolveModel({ purpose: 'main' })).toEqual({
        model: {
          provider: 'deepseek',
          api_key: 'deepseek-secret',
          model: 'deepseek-main',
          url: 'https://api.deepseek.com/v1',
          style: 'openai',
        },
      });
      expect(callArgs.options.resolveModel({ purpose: 'title' })).toEqual({
        model: expect.objectContaining({ model: 'deepseek-light' }),
      });
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'sdk_start', outcome: 'ok'}),
        expect.objectContaining({name: 'skill_registry', outcome: 'ok'}),
        expect.objectContaining({name: 'provider', outcome: 'ok'}),
      ]));
    });

    it('fails closed before query when Qoder BYOK configuration is incomplete', async () => {
      const result = await createRuntime({
        QODER_BYOK_API_KEY: 'deepseek-secret',
        QODER_MODEL: undefined,
      }).analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationMessage).toContain('QODER_BYOK_PROVIDER');
      expect(result.terminationMessage).toContain('QODER_MODEL');
      expect(result.terminationMessage).not.toContain('deepseek-secret');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('does not use repo root as cwd', async () => {
      const messages = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1');

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.cwd).not.toBe(process.cwd());
    });
  });

  describe('runtime execution ownership', () => {
    it('rejects same-session direct overlap before Qoder provider work starts', async () => {
      const comparisonStarted = createDeferred<void>();
      const releaseComparison = createDeferred<void>();
      mockBuildComparisonContext.mockImplementationOnce(async () => {
        comparisonStarted.resolve();
        await releaseComparison.promise;
        return undefined;
      });
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: 'Qoder overlap first completed.' },
      ]));
      const runtime = createRuntime();
      const first = runtime.analyze(
        'summarize top-5 longest process slices',
        'session-qoder-overlap',
        'trace-1',
        { runId: 'run-1', referenceTraceId: 'ref-1' },
      );
      await comparisonStarted.promise;
      const second = runtime.analyze(
        'summarize top-5 longest process slices',
        'session-qoder-overlap',
        'trace-1',
        { runId: 'run-2', referenceTraceId: 'ref-2' },
      );

      await expect(second).rejects.toThrow(/already in progress/i);
      expect(mockQuery).not.toHaveBeenCalled();
      releaseComparison.resolve();
      await expect(first).resolves.toMatchObject({ success: true });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('allows different Qoder sessions to run independently even with matching trace input', async () => {
      mockQuery.mockImplementation(() => createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: 'Qoder isolated completed.' },
      ]));
      const runtime = createRuntime();

      await expect(Promise.all([
        runtime.analyze(
          'summarize top-5 longest process slices',
          'session-qoder-isolated-1',
          'trace-1',
          { runId: 'run-1', referenceTraceId: 'ref-1' },
        ),
        runtime.analyze(
          'summarize top-5 longest process slices',
          'session-qoder-isolated-2',
          'trace-1',
          { runId: 'run-2', referenceTraceId: 'ref-2' },
        ),
      ])).resolves.toEqual([
        expect.objectContaining({ success: true }),
        expect.objectContaining({ success: true }),
      ]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('does not publish architecture cache state when cancellation lands during detection', async () => {
      const architectureStarted = createDeferred<void>();
      const releaseArchitecture = createDeferred<void>();
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({
        detect: jest.fn(async () => {
          architectureStarted.resolve();
          await releaseArchitecture.promise;
          return { type: 'compose' };
        }),
      } as any);
      const runtime = createRuntime();
      const analysis = runtime.analyze(
        'perform a full startup analysis',
        'session-qoder-architecture-cancel',
        'trace-architecture-cancel',
        { analysisMode: 'full' },
      );

      await architectureStarted.promise;
      await runtime.abortSession('session-qoder-architecture-cancel');
      releaseArchitecture.resolve();

      await expect(analysis).resolves.toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(runtime.getCachedArchitecture('trace-architecture-cancel')).toBeUndefined();
      expect(mockQuery).not.toHaveBeenCalled();
    });

  });

  describe('SkillExecutor wiring', () => {
    it('calls createSkillExecutor with traceProcessorService directly and registers skills', async () => {
      const messages = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1');

      expect(createSkillExecutor).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.any(Function) }),
      );
      expect(mockRegisterSkills).toHaveBeenCalled();
      expect(mockSetFragmentRegistry).toHaveBeenCalled();
    });
  });

  describe('typed turn intent and budget policy', () => {
    it('classifies once with the pinned Qoder provider, isolated cwd and shared SDK/auth', async () => {
      let classifierDirectory = '';
      mockIntentTransport.mockImplementation(async (input: any) => {
        classifierDirectory = input.isolatedClassifierDirectory;
        await expect(access(classifierDirectory)).resolves.toBeUndefined();
        const sdk = await input.loadSdk();
        await input.resolveAuth(sdk);
        await input.resolveAuth(sdk);
        expect(input.config).toEqual(expect.objectContaining({
          model: 'provider-main', lightModel: 'provider-light',
          byok: expect.objectContaining({provider: 'glm', apiKey: 'provider-key', baseUrl: 'https://provider.example/coding'}),
        }));
        expect(input).not.toHaveProperty('resume');
        return {status: 'ok', text: JSON.stringify(defaultIntentDecision)};
      });
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: 'Accepted answer', num_turns: 1},
      ]));
      const result = await createRuntime({
        QODER_MODEL: 'provider-main', QODER_LIGHT_MODEL: 'provider-light',
        QODER_BYOK_PROVIDER: 'glm', QODER_BYOK_API_KEY: 'provider-key',
        QODER_BYOK_BASE_URL: 'https://provider.example/coding',
      }).analyze('An arbitrary request', 'intent-shared', 'trace-1', {runId: 'intent-run'});
      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
      expect(mockLoadQoderSdkModule).toHaveBeenCalledTimes(1);
      expect(mockSdkModule.accessTokenFromEnv).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      await expect(access(classifierDirectory)).rejects.toMatchObject({code: 'ENOENT'});
      expect(result.turnIntent).toMatchObject({status: 'resolved', sceneId: 'general', deliverable: 'answer'});
      expect(result.completion).toMatchObject({runId: 'intent-run', status: 'completed',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
    });

    it.each(['Analyze everything in detail', '谢谢，这个指标呢？'])('uses a bounded semantic decision with full budget: %s', async query => {
      respondWithIntent({taskKind: 'fact', scope: 'bounded_question', recommendedComplexity: 'quick'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'One bounded answer', num_turns: 1},
      ]));
      const result = await createRuntime({QODER_MAX_TURNS: '12', QODER_QUICK_MAX_TURNS: '3'})
        .analyze(query, 'full-bounded', 'trace-1', {analysisMode: 'full'});
      // The scene-wide memory tier stays off for a bounded question; the trace
      // facts it is asked about do not.
      expect(createArchitectureDetector).toHaveBeenCalled();
      expect(detectFocusApps).toHaveBeenCalled();
      expect(probeTraceCompleteness).toHaveBeenCalled();
      expect((mockQuery.mock.calls[0][0] as any).options.maxTurns).toBe(11);
      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        lightweight: false, allowNewEvidence: true,
      }));
      expect(result).toMatchObject({success: true, partial: false, outputOrigin: 'sdk_final'});
      expect(result.terminationReason).toBeUndefined();
    });

    it('preserves comparison, RAG and plan capabilities under an explicit fast budget', async () => {
      respondWithIntent({taskKind: 'comparison', scope: 'bounded_question'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Comparison answer', num_turns: 2},
      ]));
      const result = await createRuntime({QODER_MAX_TURNS: '12', QODER_QUICK_MAX_TURNS: '3'})
        .analyze('Compare the selected metric', 'fast-pair', 'trace-1', {
          analysisMode: 'fast', referenceTraceId: 'trace-2',
          codeAwareMode: 'metadata_only', codebaseIds: ['source-1'], knowledgeSourceIds: ['knowledge-1'],
        });
      expect(mockBuildComparisonContext).not.toHaveBeenCalled();
      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        lightweight: true, allowNewEvidence: true, userQuery: 'Compare the selected metric',
        referenceTraceId: 'trace-2', comparisonContext: expect.objectContaining({
          referenceTraceId: 'trace-2', capabilityProbeStatus: 'not_checked',
        }), analysisPlan: expect.any(Object), analysisNotes: expect.any(Array),
        codebaseIds: ['source-1'], knowledgeSourceIds: ['knowledge-1'],
      }));
      expect((mockQuery.mock.calls[0][0] as any).options.maxTurns).toBe(2);
      expect(result.quickRun).toMatchObject({hardCapTurns: 3, actualTurns: 3, enforcement: 'turn_cap'});
    });

    it('keeps artifact-capable MCP with existing_only and performs no automatic new evidence reads', async () => {
      respondWithIntent({taskKind: 'fact', scope: 'bounded_question', evidenceAccess: 'existing_only'});
      const queryTrace = jest.fn(async () => undefined);
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Previously observed fact', num_turns: 1},
      ]));
      const result = await createRuntime({}, {query: queryTrace}).analyze('Use the existing observation', 'existing-only', 'trace-1', {
        analysisMode: 'full', referenceTraceId: 'trace-2',
        codeAwareMode: 'metadata_only', codebaseIds: ['source-1'], knowledgeSourceIds: ['knowledge-1'],
      });
      expect(queryTrace).not.toHaveBeenCalled();
      expect(createArchitectureDetector).not.toHaveBeenCalled();
      expect(detectFocusApps).not.toHaveBeenCalled();
      expect(probeTraceCompleteness).not.toHaveBeenCalled();
      expect(mockBuildComparisonContext).not.toHaveBeenCalled();
      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        allowNewEvidence: false, artifactStore: expect.any(Object), referenceTraceId: 'trace-2',
      }));
      expect((mockQuery.mock.calls[0][0] as any).options.mcpServers).toHaveProperty('smartperfetto');
      expect(result.turnIntent?.evidenceAccess).toBe('existing_only');
    });

    it('retains an issued private store across physical runs while keeping cancelled callbacks isolated', async () => {
      respondWithIntent({taskKind: 'fact', scope: 'bounded_question', evidenceAccess: 'existing_only'});
      mockQuery.mockImplementation(() => createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Previously captured metric', num_turns: 1},
      ]));
      const options = {analysisMode: 'fast' as const, codeAwareMode: 'metadata_only' as const, codebaseIds: ['source-1']};
      const evidence = createRuntimeEvidenceContext({logicalSessionId: 'private-conversation', traceId: 'trace-1', options});
      const firstController = new AbortController();
      const first = evidence.bind(options, {runtimeSessionId: 'private-conversation:first', runId: 'first',
        signal: firstController.signal, assertAuthorized() {}});
      const runtime = createRuntime();
      try {
        const firstResult = await runtime.analyze('Read the metric', 'private-conversation:first', 'trace-1', first.options);
        takeFinalizationContext(firstResult)?.dispose();
        const firstStore = (mockCreateClaudeMcpServer.mock.calls[0][0] as {artifactStore: ArtifactStore}).artifactStore;
        const data = {columns: ['metric'], rows: [[7]]};
        const artifactId = firstStore.store({skillId: 'fixture', data,
          traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace-1', traceSide: 'current'})});
        firstStore.registerEvidenceCapture(artifactId, captureEvidenceTable(data), {evidenceRefId: 'private-prior'});
        first.release();
        const second = evidence.bind(options, {runtimeSessionId: 'private-conversation:second', runId: 'second',
          signal: new AbortController().signal, assertAuthorized() {}});
        firstController.abort();
        const secondResult = await runtime.analyze('Use the prior metric', 'private-conversation:second', 'trace-1', second.options);
        const finalization = takeFinalizationContext(secondResult);
        try {
          const secondStore = (mockCreateClaudeMcpServer.mock.calls[1][0] as {artifactStore: ArtifactStore}).artifactStore;
          expect(secondStore).not.toBe(firstStore);
          expect(secondStore.fetch(artifactId, 'rows')).toMatchObject({rows: [{rowIndex: 0, values: [7]}]});
          expect(() => firstStore.clear()).toThrow();
          const reads = await finalization!.resolveReferences([
            {key: 'prior', reference: {artifactId, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']},
          ], new AbortController().signal);
          expect(reads[0]).toMatchObject({status: 'resolved', row: {metric: 7}});
          expect(secondResult.turnIntent?.evidenceAccess).toBe('existing_only');
        } finally {finalization?.dispose(); second.release();}
      } finally {
        evidence.dispose();
        runtime.cleanupSession('private-conversation:first');
        runtime.cleanupSession('private-conversation:second');
      }
    });

    it('uses neutral on-demand context when semantic classification is unavailable', async () => {
      mockIntentTransport.mockResolvedValue({status: 'unavailable', reason: 'invalid_response'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Model chose the answer'},
      ]));
      const result = await createRuntime({QODER_MAX_TURNS: '11'})
        .analyze('Start a full detailed scrolling analysis', 'unavailable-intent', 'trace-1', {analysisMode: 'full'});
      expect(result.turnIntent).toMatchObject({status: 'unavailable', source: 'fallback', sceneId: 'general'});
      expect(createArchitectureDetector).toHaveBeenCalled();
      expect(detectFocusApps).toHaveBeenCalled();
      expect((mockQuery.mock.calls[0][0] as any).options.maxTurns).toBe(10);
    });

    it('uses the configured main BYOK model for utility work after classifier failure', async () => {
      mockIntentTransport.mockResolvedValue({status: 'unavailable', reason: 'provider_error'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Main model answer'},
      ]));
      await createRuntime({QODER_MODEL: 'main-model', QODER_LIGHT_MODEL: 'unavailable-light',
        QODER_BYOK_PROVIDER: 'glm', QODER_BYOK_API_KEY: 'provider-key',
      }).analyze('any request', 'classifier-model-fallback', 'trace-1');
      const options = (mockQuery.mock.calls[0][0] as any).options;
      expect(options.model).toBe('main-model');
      expect(options.resolveModel({purpose: 'utility'})).toEqual({model: {
        provider: 'glm', api_key: 'provider-key', model: 'main-model',
      }});
    });

    it('does not start the main query or publish a late intent after classifier cancellation', async () => {
      const started = createDeferred<void>();
      const late = createDeferred<any>();
      mockIntentTransport.mockImplementation(async () => {started.resolve(); return late.promise;});
      const runtime = createRuntime();
      const resultPromise = runtime.analyze('any request', 'cancel-intent', 'trace-1', {runId: 'cancel-intent-run'});
      await started.promise;
      await runtime.abortSession('cancel-intent');
      const result = await resultPromise;
      expect(result).toMatchObject({success: false, completion: {status: 'cancelled', runId: 'cancel-intent-run'}});
      late.resolve({status: 'ok', text: JSON.stringify(defaultIntentDecision)});
      await Promise.resolve();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockCreateClaudeMcpServer).not.toHaveBeenCalled();
    });

    it('applies the main wall budget even while the shared SDK module load never settles', async () => {
      const moduleLoad = createDeferred<typeof mockSdkModule>();
      mockLoadQoderSdkModule.mockReturnValue(moduleLoad.promise);
      mockIntentTransport.mockImplementation(async (input: any) => {
        await input.loadSdk();
        return {status: 'ok', text: JSON.stringify(defaultIntentDecision)};
      });
      const result = await createRuntime({
        AGENT_CLASSIFIER_TIMEOUT_MS: '10', QODER_QUICK_MAX_TURNS: '1', QODER_QUICK_PER_TURN_MS: '10',
      }).analyze('any request', 'stalled-module', 'trace-1');
      expect(result).toMatchObject({success: false, partial: true,
        turnIntent: {status: 'unavailable', unavailableReason: 'timeout'},
        completion: {status: 'incomplete', reason: 'timeout'}});
      expect(mockQuery).not.toHaveBeenCalled();
      moduleLoad.resolve(mockSdkModule);
      await Promise.resolve();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('classifier-local timeout leaves the main request available and discards the late decision', async () => {
      const late = createDeferred<any>();
      mockIntentTransport.mockReturnValue(late.promise);
      const mainCandidate = `Main request completed\n${renderConclusionContractSidecar({
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
        evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
      })}`;
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: mainCandidate, num_turns: 1},
      ]));
      const result = await createRuntime({AGENT_CLASSIFIER_TIMEOUT_MS: '20'})
        .analyze('any request', 'timeout-intent', 'trace-1');
      expect(result).toMatchObject({success: true, turnIntent: {status: 'unavailable', unavailableReason: 'timeout'}});
      expect(mockInterrupt).not.toHaveBeenCalled();
      late.resolve({status: 'ok', text: JSON.stringify(defaultIntentDecision)});
      await Promise.resolve();
      expect(result.turnIntent?.status).toBe('unavailable');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('runtime finalization context', () => {
    it('attaches the exact final object once and keeps the original deadline and trace reader scope', async () => {
      respondWithIntent({taskKind: 'comparison', scope: 'bounded_question'});
      const readerSpy = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadView');
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Final answer', num_turns: 1},
      ]));
      const startedAt = Date.now();
      const options: AnalysisOptions = {
        runId: 'final-context-run', referenceTraceId: 'trace-2', analysisMode: 'full' as const,
        tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1', providerId: 'provider-1',
        selectionContext: {kind: 'track_event', eventId: 7, ts: 42},
      };
      const pinnedFingerprint = buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
      options.analysisContextFingerprint = pinnedFingerprint;
      const result = await createRuntime({QODER_MODEL: 'main-model', QODER_MAX_TURNS: '4', QODER_FULL_PER_TURN_MS: '500'})
        .analyze('any request', 'final-context', 'trace-1', options);
      const context = takeFinalizationContext(result)!;
      expect(context).toBeDefined();
      expect(context.sourceScope).toBeUndefined(); // The default mock has no source scope accessor.
      options.analysisContextFingerprint = 'later-auth-context';
      const providerQuery = context.getProviderQuery(new AbortController().signal);
      expect(providerQuery).toEqual({text: 'any request', analysisContextFingerprint: pinnedFingerprint});
      expect(Object.isFrozen(providerQuery)).toBe(true);
      expect(context.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: options.selectionContext, sideResolution: {status: 'unknown'}});
      expect(JSON.stringify(result)).not.toContain('"providerQuery"');
      expect(takeFinalizationContext(result)).toBeUndefined();
      expect(takeFinalizationContext({...result})).toBeUndefined();
      expect(context).toMatchObject({runId: 'final-context-run', sessionId: 'final-context',
        traceIdentity: {currentTraceId: 'trace-1', referenceTraceId: 'trace-2'}, hasSemanticTransport: true});
      expect(context.deliveryContext).toMatchObject({completion: result.completion,
        acceptedCandidate: {conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
      expect(context.deadlineMs).toBeGreaterThanOrEqual(startedAt + 2000);
      expect(context.deadlineMs).toBeLessThanOrEqual(Date.now() + 2000);
      expect(readerSpy).toHaveBeenCalledWith({
        currentRunId: context.runId,
        allowedTraces: [{traceId: 'trace-1', traceSide: 'current'}, {traceId: 'trace-2', traceSide: 'reference'}],
        ownerKey: analysisDeliveryFingerprint({runId: 'final-context-run', sessionId: 'final-context',
          runtime: 'qoder-agent-sdk', tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1',
          providerId: 'provider-1', analysisContextFingerprint: pinnedFingerprint}),
      });
      expect(JSON.stringify(result)).not.toContain('hasSemanticTransport');
      context.dispose();
      readerSpy.mockRestore();
    });

    it('uses the established primary model and auth in a fresh no-tools transport after the runtime lease settles', async () => {
      respondWithIntent({taskKind: 'fact', scope: 'bounded_question'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Native main answer', num_turns: 1},
      ]));
      const runtime = createRuntime({QODER_MODEL: 'main-model', QODER_LIGHT_MODEL: 'classifier-model',
        QODER_BYOK_PROVIDER: 'glm', QODER_BYOK_API_KEY: 'same-key', QODER_BYOK_BASE_URL: 'https://provider.example/coding'});
      const result = await runtime.analyze('any request', 'fresh-final-review', 'trace-1');
      const context = takeFinalizationContext(result)!;
      const classifierCall = mockIntentTransport.mock.calls[0][0] as any;
      let reviewDirectory = '';
      mockIntentTransport.mockImplementationOnce(async (input: any) => {
        reviewDirectory = input.isolatedClassifierDirectory;
        expect(reviewDirectory).not.toBe(classifierCall.isolatedClassifierDirectory);
        expect(input.config).toMatchObject({model: 'main-model', lightModel: undefined,
          byok: {provider: 'glm', apiKey: 'same-key', baseUrl: 'https://provider.example/coding'}});
        expect(input.deadlineMs).toBe(context.deadlineMs);
        expect(input.outputByteLimit).toBe(8192);
        expect(input.signal.aborted).toBe(false);
        const sdk = await input.loadSdk();
        expect(sdk).toBe(mockSdkModule);
        expect(await input.resolveAuth(sdk)).toBe((mockQuery.mock.calls[0][0] as any).options.auth);
        expect(input).not.toHaveProperty('resume');
        return {status: 'ok', text: 'Semantic assessment response'};
      });
      await runtime.abortSession('fresh-final-review');
      const response = await context.dispatchText({prompt: 'Review current evidence', systemPrompt: '',
        deadlineMs: context.deadlineMs + 1000, outputByteLimit: 8192, signal: new AbortController().signal});
      expect(response).toEqual({status: 'ok', text: 'Semantic assessment response'});
      expect(mockLoadQoderSdkModule).toHaveBeenCalledTimes(1);
      expect(mockSdkModule.accessTokenFromEnv).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      await expect(access(reviewDirectory)).rejects.toMatchObject({code: 'ENOENT'});
      context.dispose();
    });

    it('attaches known failed native state without granting semantic dispatch', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Native failure']},
      ]));
      const result = await createRuntime({QODER_MODEL: 'main-model'}).analyze('any request', 'failed-final-context', 'trace-1');
      const context = takeFinalizationContext(result)!;
      expect(context.hasSemanticTransport).toBe(false);
      expect(context.deliveryContext).toMatchObject({completion: {status: 'failed', reason: 'provider_error'}});
      await expect(context.dispatchText({prompt: 'No retry', systemPrompt: '', deadlineMs: context.deadlineMs,
        outputByteLimit: 1024, signal: new AbortController().signal}))
        .resolves.toEqual({status: 'unavailable', reason: 'invalid_configuration'});
      context.dispose();
    });

    it.each([true, false])('keeps cancellation context and current source execution scope: current=%s', async current => {
      const scope = {codeAwareMode: 'off' as const, selectedCodebaseIds: [], hasCodebaseAccess: false,
        analysisContextFingerprint: 'qoder-source-scope'};
      mockCreateClaudeMcpServer.mockReturnValue({server: {name: 'smartperfetto'}, allowedTools: [], toolDefinitions: [],
        sourceUse: {getSourceUseDecision: () => undefined, getSourceExecutionScope: () => current ? scope : undefined}});
      const late = createDeferred<void>();
      mockQuery.mockReturnValue({async *[Symbol.asyncIterator]() {await late.promise;}, interrupt: mockInterrupt, close: mockClose});
      const runtime = createRuntime({QODER_MODEL: 'main-model'});
      const analysis = runtime.analyze('any request', 'cancel-final-context', 'trace-1');
      await waitForMockQuery();
      await runtime.abortSession('cancel-final-context');
      const result = await analysis;
      const context = takeFinalizationContext(result)!;
      expect(context.hasSemanticTransport).toBe(false);
      expect(context.sourceScope).toEqual(current ? scope : undefined);
      expect(context.deliveryContext).toMatchObject({completion: {status: 'cancelled'}});
      late.resolve();
      context.dispose();
    });

    it('does not invent a primary-model pin when the native SDK used an unspecified default', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Native answer'},
      ]));
      const result = await createRuntime().analyze('any request', 'default-model-context', 'trace-1');
      const context = takeFinalizationContext(result)!;
      expect(context.hasSemanticTransport).toBe(false);
      context.dispose();
    });
  });

  describe('MCP context passing', () => {
    it('renders an issued current-side focus-app evidence locator the run store resolves', async () => {
      (detectFocusApps as jest.Mock<(...args: any[]) => any>).mockResolvedValueOnce({
        method: 'oom_adj', confidence: 'high', primaryApp: 'com.example.qoder',
        apps: [{packageName: 'com.example.qoder', totalDurationNs: 10, switchCount: 1, score: 40}],
      });
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'done'},
      ]));
      await createRuntime().analyze('which app', 'session-focus-evidence', 'trace-1', {analysisMode: 'full'});
      const systemPrompt = (mockQuery.mock.calls[0][0] as any).options.systemPrompt;
      expect((readPromptContext(systemPrompt, 'trace_context') as any)?.focusApp?.evidence).toMatchObject({rowIndex: 0,
        row: {package_name: 'com.example.qoder', detection_method: 'oom_adj', detection_confidence: 'high'}});
      const resolution = await resolveFocusPackageCell((mockCreateClaudeMcpServer.mock.calls[0][0] as any).artifactStore,
        systemPrompt, 'trace-1');
      expect(resolution).toMatchObject({status: 'resolved', row: {package_name: 'com.example.qoder'}});
    });

    it('passes full context in full mode', async () => {
      mockBuildComparisonContext.mockResolvedValueOnce({
        referenceTraceId: 'ref-trace',
        commonCapabilities: [],
      });
      const messages = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const options: AnalysisOptions = {
        analysisMode: 'full',
        referenceTraceId: 'ref-trace',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-1'],
        knowledgeSourceIds: ['ks-1'],
      };
      const fingerprint = buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
      options.analysisContextFingerprint = fingerprint;
      await runtime.analyze('test', 'session-1', 'trace-1', options);

      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          userQuery: 'test',
          sceneType: expect.any(String),
          analysisPlan: expect.any(Object),
          hypotheses: expect.any(Array),
          uncertaintyFlags: expect.any(Array),
          watchdogWarning: expect.any(Object),
          referenceTraceId: 'ref-trace',
          codeAwareMode: 'metadata_only',
          codebaseIds: ['cb-1'],
          knowledgeSourceIds: ['ks-1'],
          analysisContextFingerprint: fingerprint,
          comparisonContext: expect.objectContaining({ referenceTraceId: 'ref-trace' }),
        }),
      );
      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(readPromptContext(callArgs.options.systemPrompt, 'comparison_identity')).toEqual(
        expect.objectContaining({referenceTraceId: 'ref-trace'}),
      );
    });

    // A quick budget compacts the catalog, but a full scene investigation is
    // exactly the turn that needs the map of what can be measured.
    it.each([
      ['a scene-wide investigation keeps the complete catalog', {}, false],
      ['a bounded question compacts it', {scope: 'bounded_question'}, true],
    ])('%s under a quick budget', async (_label, intent, lightweight) => {
      respondWithIntent(intent);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ]));
      await createRuntime().analyze('test', 'session-lightweight', 'trace-1', {analysisMode: 'fast'});
      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(expect.objectContaining({lightweight}));
    });

    it('keeps the full authorized MCP context with a quick budget hint', async () => {
      const messages = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'fast',
        sourceUsePolicy: {phase: 'explicit'},
      });

      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          lightweight: false,
          sourceUsePolicy: {phase: 'explicit'},
        }),
      );
      const callArgs = mockCreateClaudeMcpServer.mock.calls[0][0] as any;
      expect(callArgs.analysisPlan).toEqual(expect.objectContaining({current: null}));
      expect(callArgs.hypotheses).toEqual([]);
      expect(callArgs.uncertaintyFlags).toEqual([]);
    });

    it('passes the active code-aware mode and selected codebases into the Qoder quick prompt', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'done'},
      ]));

      await createRuntime().analyze('quick source lookup', 'session-1', 'trace-1', {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: ['cb-qoder-quick'],
      });

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(readPromptContext(callArgs.options.systemPrompt, 'source_authorization')).toEqual({
        mode: 'provider_send', evidenceAccess: 'read_new',
        codebases: [expect.objectContaining({id: 'cb-qoder-quick'})],
      });
    });
  });

  describe('result handling', () => {
    it('explains that BYOK does not replace Qoder authentication', async () => {
      const error = new Error('Qoder CLI process exited with code 41') as Error & { exitCode: number };
      error.exitCode = 41;
      mockQuery.mockImplementationOnce(() => {
        throw error;
      });

      const result = await createRuntime({
        QODER_MODEL: 'deepseek-main',
        QODER_BYOK_API_KEY: 'deepseek-secret',
        QODER_BYOK_PROVIDER: 'deepseek',
      }).analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationMessage).toContain('Qoder authentication failed');
      expect(result.terminationMessage).toContain('does not replace Qoder authentication');
      expect(result.terminationMessage).not.toContain('deepseek-secret');
    });

    it('uses the shared localized trace-context formatter for the user prompt', async () => {
      mockFormatTraceContext.mockReturnValueOnce('localized trace context');
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));

      await createRuntime().analyze('test query', 'session-1', 'trace-1', {
        traceContext: [{ label: 'dataset', columns: ['value'], rows: [[1]] }],
      } as any);

      expect(mockQuery.mock.calls[0][0]).toMatchObject({
        prompt: 'localized trace context\n\ntest query',
      });
    });

    it('uses the same delivery turn to repair a rejected declaration around the unchanged body', async () => {
      const body = 'Frame 12 missed its deadline.';
      mockIntentTransport
        .mockResolvedValueOnce({status: 'ok', text: JSON.stringify(defaultIntentDecision)})
        .mockResolvedValueOnce({status: 'ok', text: candidateWithPopulation(body, 'cited_rows'), finishReason: 'end_turn'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: candidateWithPopulation(body, 'everywhere'), num_turns: 1},
      ]));
      const result = await createRuntime().analyze('test', 'qoder-invalid-declaration', 'trace-1', {runId: 'qoder-invalid-declaration'});
      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
      expect((mockIntentTransport.mock.calls[1][0] as any).prompt).toContain('invalid_declaration');
      expect(inspectCandidateProtocol(result.conclusion)).toMatchObject({status: 'valid'});
      expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
      takeFinalizationContext(result)?.dispose();
    });

    it('uses one no-tools delivery turn for an unchanged full native declaration candidate', async () => {
      const body = `${'启动正文保持完整。'.repeat(850)}\n${'Native body remains unchanged. '.repeat(170)}`.trimEnd();
      expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
      const sidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'The authored body is preserved.'}], clusters: [], evidenceChain: [],
        claims: [], uncertainties: [], nextSteps: []} as ConclusionContract);
      const repaired = `${body}\n${sidecar}`;
      mockIntentTransport
        .mockResolvedValueOnce({status: 'ok', text: JSON.stringify(defaultIntentDecision)})
        .mockResolvedValueOnce({status: 'ok', text: repaired, finishReason: 'end_turn'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: body, num_turns: 1},
      ]));

      const result = await createRuntime().analyze('test', 'qoder-missing-declaration', 'trace-1', {
        runId: 'qoder-missing-declaration',
      });

      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
      expect(mockIntentTransport.mock.calls[1][0]).toMatchObject({outputByteLimit: 128 * 1024});
      expect((mockIntentTransport.mock.calls[1][0] as any).prompt).toContain('missing_declaration');
      expect(inspectCandidateProtocol(repaired).canonicalBody.trim()).toBe(body);
      expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
      expect(result.completion).toMatchObject({status: 'completed', attemptId: 'declaration-completion:1'});
      const context = takeFinalizationContext(result)!;
      try {expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(repaired);}
      finally {context.dispose();}
    });

    it('does not dispatch declaration completion when the original body cannot fit the Qoder output cap', async () => {
      const body = 'x'.repeat(128 * 1024);
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: body, num_turns: 1},
      ]));
      const result = await createRuntime().analyze('test', 'qoder-declaration-output-cap', 'trace-1');
      expect(mockIntentTransport).toHaveBeenCalledTimes(1);
      expect(result.conclusion).toBe(body);
      expect(result.completion).toMatchObject({status: 'completed', attemptId: 'main'});
    });

    it('retains the original Qoder attempt when a dispatched declaration completion changes the body', async () => {
      const body = 'Original bounded answer.';
      const changed = `Changed bounded answer.\n${renderConclusionContractSidecar({
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
        evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
      } as ConclusionContract)}`;
      mockIntentTransport
        .mockResolvedValueOnce({status: 'ok', text: JSON.stringify(defaultIntentDecision)})
        .mockResolvedValueOnce({status: 'ok', text: changed, finishReason: 'end_turn'});
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'system', subtype: 'init', session_id: 'sdk-original-session'},
        {type: 'result', subtype: 'success', is_error: false, result: body, num_turns: 1},
      ]));
      const updates: unknown[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      const result = await runtime.analyze('test', 'qoder-declaration-rejected', 'trace-1', {
        runId: 'qoder-declaration-rejected',
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
      expect(result.conclusion).toBe(body);
      expect(result.completion).toMatchObject({status: 'completed', attemptId: 'main',
        conclusionFingerprint: analysisDeliveryFingerprint(body)});
      expect(JSON.stringify(updates)).not.toContain('Changed bounded answer');
    });

    it('returns success: true for success result', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: '## Final Report\nAnalysis complete' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nAnalysis complete', num_turns: 5 },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const result = await runtime.analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(true);
      expect(result.rounds).toBe(6);
      expect(result.conclusion).toBe('## Final Report\nAnalysis complete');
    });

    it('preserves successful native completion while source usage remains pending', async () => {
      const actualMcp = jest.requireActual<typeof import('../../../../agentv3/claudeMcpServer')>(
        '../../../../agentv3/claudeMcpServer',
      );
      const fixture = createRuntimeSourceFinalizationFixture({
        createMcpServer: actualMcp.createClaudeMcpServer,
        sessionId: 'session-1',
      });
      try {
        mockCreateClaudeMcpServer.mockReturnValue(fixture.mcp);
        mockQuery.mockReturnValue(createMockSdkStream([
          {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'},
        ]));

        const result = await createRuntime().analyze('test', 'session-1', 'trace-1', {
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });

        expect(result).toMatchObject({
          success: true,
          partial: false,
          terminationReason: undefined,
          sourceUseDecision: expect.objectContaining({status: 'pending'}),
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('finalizes from real MCP ledger state without SDK tool-result messages or stale carryover', async () => {
      const actualMcp = jest.requireActual<typeof import('../../../../agentv3/claudeMcpServer')>(
        '../../../../agentv3/claudeMcpServer',
      );
      const fixture = createRuntimeSourceFinalizationFixture({
        createMcpServer: actualMcp.createClaudeMcpServer,
        sessionId: 'session-1',
      });
      try {
        const {decision} = await fixture.executeProviderSourceLookup();
        const sdkMessages = [
          {type: 'assistant', message: {content: [{type: 'text', text: SOURCE_FINALIZATION_RAW_SOURCE}]}},
          {type: 'result', subtype: 'success', is_error: false, result: SOURCE_FINALIZATION_RAW_SOURCE, num_turns: 1},
        ];
        expect(sdkMessages.every(message => message.type !== 'tool_result')).toBe(true);
        mockCreateClaudeMcpServer
          .mockReturnValueOnce(fixture.mcp)
          .mockReturnValueOnce({
            server: {name: 'smartperfetto'},
            allowedTools: ['mcp__smartperfetto__query_trace'],
            toolDefinitions: [],
          });
        mockQuery
          .mockReturnValueOnce(createMockSdkStream(sdkMessages))
          .mockReturnValueOnce(createMockSdkStream([
            {type: 'result', subtype: 'success', is_error: false, result: 'public second run'},
          ]));
        const runtime = createRuntime();

        const terminal = await runtime.analyze('source run', 'session-1', 'trace-1', {
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });
        const context = takeFinalizationContext(terminal)!;
        try {
          expect(context.getNativeDeclaration(terminal, new AbortController().signal)?.raw).toBe(SOURCE_FINALIZATION_RAW_SOURCE);
          expect(JSON.stringify(terminal)).not.toContain('conclusion_protocol_projection');
        } finally {context.dispose();}
        const next = await runtime.analyze('public run', 'session-1', 'trace-1', {
          codeAwareMode: 'off',
        });

        expect(terminal.success).toBe(true);
        expect(terminal.sourceUseDecision).toEqual(decision);
        expect(terminal.sourceReferences).toEqual(decision.references);
        expect(JSON.stringify(terminal)).toContain(SOURCE_FINALIZATION_CANARY);
        expect(next.sourceUseDecision).toBeUndefined();
        expect(next.sourceReferences).toBeUndefined();
      } finally {
        fixture.cleanup();
      }
    });

    it('preserves the real MCP source decision on timeout', async () => {
      const actualMcp = jest.requireActual<typeof import('../../../../agentv3/claudeMcpServer')>(
        '../../../../agentv3/claudeMcpServer',
      );
      const fixture = createRuntimeSourceFinalizationFixture({
        createMcpServer: actualMcp.createClaudeMcpServer,
        sessionId: 'session-qoder-source-timeout',
      });
      try {
        const {decision} = await fixture.executeProviderSourceLookup();
        mockCreateClaudeMcpServer.mockReturnValue(fixture.mcp);
        mockQuery.mockReturnValue({
          [Symbol.asyncIterator]() {
            return {next: () => new Promise(() => undefined)};
          },
          interrupt: mockInterrupt,
          close: mockClose,
        });

        const result = await createRuntime({
          QODER_MAX_TURNS: '1',
          QODER_FULL_PER_TURN_MS: '1',
        }).analyze(
          'source timeout run',
          'session-qoder-source-timeout',
          'trace-1',
          {
            analysisMode: 'full',
            codeAwareMode: 'provider_send',
            codebaseIds: [fixture.codebaseId],
          },
        );

        expect(result).toMatchObject({
          success: false,
          terminationReason: 'timeout',
          sourceUseDecision: decision,
          sourceReferences: decision.references,
        });
      } finally {
        fixture.cleanup();
      }
    });

    it('treats a success subtype carrying is_error as a failure', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: true, result: 'Authentication failed' },
      ]));

      const result = await createRuntime().analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.conclusion).toBe('Authentication failed');
    });

    it('projects answer tokens before emitting them', async () => {
      mockProjectionWrite.mockImplementation(text => text.replace('private', '[REDACTED]'));
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'private source' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      await runtime.analyze('test', 'session-1', 'trace-1', {
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-codebase'],
      });

      const tokens = updates.filter(update => update.type === 'answer_token');
      expect(tokens).toEqual([
        expect.objectContaining({ content: '[REDACTED] source' }),
      ]);
      expect(tokens).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'private source' }),
      ]));
    });

    it('projects assistant chunks incrementally and independently projects the native final answer', async () => {
      const chunks = ['## Final', ' Report\nfirst ', 'second'];
      const finalText = chunks.join('');
      mockProjectionWrite.mockImplementation(text => `<${text}>`);
      mockProjectionFlush.mockReturnValue('<tail>');
      const api = privacyProjectionApi();
      api.registerCodeAwareCanary('session-qoder-linear-projection', 'second');
      const receipt = api.sanitizeCodeAwareTextWithReceipt('session-qoder-linear-projection', finalText);
      mockQuery.mockReturnValue(createMockSdkStream([
        ...chunks.map(text => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        })),
        { type: 'result', subtype: 'success', is_error: false, result: finalText },
      ]));
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      const result = await runtime.analyze('test', 'session-qoder-linear-projection', 'trace-1');

      expect(mockProjectionWrite.mock.calls.map(call => call[0])).toEqual(chunks);
      expect(mockProjectionProjectComplete).not.toHaveBeenCalled();
      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(updates
        .filter(update => update.type === 'answer_token')
        .map(update => update.content)
        .join('')).toBe(chunks.map(text => `<${text}>`).join('') + '<tail>');
      expect(result.conclusion).toBe(receipt.text);
      expect(result.completion).toMatchObject({status: 'completed',
        conclusionFingerprint: analysisDeliveryFingerprint(receipt.text)});
      api.clearCodeAwareOutputGuards('session-qoder-linear-projection');
    });

    it('closes once and discards the projection tail after an iterator error', async () => {
      mockProjectionFlush.mockReturnValue('must-not-be-emitted');
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
          throw new Error('iterator exploded');
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      const result = await runtime.analyze('test', 'session-qoder-iterator-error', 'trace-1');

      expect(result).toMatchObject({ success: false, terminationReason: 'execution_error' });
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(updates).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'must-not-be-emitted' }),
      ]));
    });

    it('closes once and returns the timeout result shape on deadline', async () => {
      mockProjectionFlush.mockReturnValue('must-not-be-emitted');
      mockQuery.mockReturnValue({
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => undefined) };
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });
      const updates: any[] = [];
      const runtime = createRuntime({
        QODER_MAX_TURNS: '1',
        QODER_FULL_PER_TURN_MS: '1',
      });
      runtime.on('update', update => updates.push(update));

      const result = await runtime.analyze(
        'test',
        'session-qoder-timeout-cleanup',
        'trace-1',
        { analysisMode: 'full' },
      );

      expect(result).toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(result.terminationMessage).toMatch(/超时|timed out/i);
      expect(mockInterrupt).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(updates).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'must-not-be-emitted' }),
      ]));
    });

    it.each([
      {
        label: 'assistant output',
        lateMessage: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'late-answer-canary' }] },
        },
      },
      {label: 'provider error', lateMessage: new Error('Late provider failure')},
    ])('fences late $label from a timed-out iterator after same-session reuse', async ({ lateMessage }) => {
      const releaseLateIterator = createDeferred<void>();
      const oldClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const newClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const oldInterrupt = jest.fn<() => Promise<void>>()
        .mockRejectedValue(new Error('interrupt rejection is observed'));
      mockQuery
        .mockReturnValueOnce({
          async *[Symbol.asyncIterator]() {
            yield {type: 'system', subtype: 'init', session_id: 'old-timeout-opaque'};
            await releaseLateIterator.promise;
            if (lateMessage instanceof Error) throw lateMessage;
            yield lateMessage;
          },
          interrupt: oldInterrupt,
          close: oldClose,
        })
        .mockReturnValueOnce({
          async *[Symbol.asyncIterator]() {
            yield {type: 'system', subtype: 'init', session_id: 'new-run-opaque'};
            const context = mockCreateClaudeMcpServer.mock.calls[1][0] as any;
            context.analysisNotes.push({section: 'observation', content: 'Evidence collected by the new run',
              priority: 'low', timestamp: 1});
            yield { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nnew run' };
          },
          interrupt: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
          close: newClose,
        });
      const updates: any[] = [];
      const runtime = createRuntime({
        QODER_MAX_TURNS: '1',
        QODER_FULL_PER_TURN_MS: '1',
      });
      runtime.on('update', update => updates.push(update));

      await expect(runtime.analyze(
        'first',
        'session-qoder-timeout-late-iterator',
        'trace-1',
        { analysisMode: 'full' },
      )).resolves.toMatchObject({
        success: false,
        terminationReason: 'timeout',
      });
      await expect(runtime.analyze(
        'second',
        'session-qoder-timeout-late-iterator',
        'trace-1',
        { analysisMode: 'full' },
      )).resolves.toMatchObject({ success: true });

      expect((mockQuery.mock.calls[1][0] as any).options.resume).toBeUndefined();
      releaseLateIterator.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(oldInterrupt).toHaveBeenCalledTimes(1);
      expect(oldClose).toHaveBeenCalledTimes(1);
      expect(newClose).toHaveBeenCalledTimes(1);
      expect(mockProjectionWrite).not.toHaveBeenCalledWith('late-answer-canary');
      expect(JSON.stringify(updates)).not.toContain('late-answer-canary');
      expect(runtime.getSessionNotes('session-qoder-timeout-late-iterator')).toEqual([{
        section: 'observation', content: 'Evidence collected by the new run', priority: 'low', timestamp: 1,
      }]);
    });

    it('discards the final projection tail for a successful private run', async () => {
      mockProjectionFlush.mockReturnValue('private-tail-canary');
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'safe partial' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nprivate result' },
      ]));
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      await expect(runtime.analyze('private', 'session-qoder-private-tail', 'trace-1', {
        knowledgeSourceIds: ['private-wiki'],
      })).resolves.toMatchObject({ success: true });

      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(updates)).not.toContain('private-tail-canary');
    });

    it('returns hypotheses written through the shared MCP state', async () => {
      mockCreateClaudeMcpServer.mockImplementationOnce((input: any) => {
        input.hypotheses.push({
          id: 'hyp-1',
          statement: 'Main thread is blocked',
          status: 'confirmed',
          evidence: 'slice-1',
          formedAt: 100,
          resolvedAt: 200,
        });
        return {
          server: { name: 'smartperfetto' },
          allowedTools: ['mcp__smartperfetto__query_trace'],
          toolDefinitions: [],
        };
      });
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));

      const result = await createRuntime().analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'full',
      });

      expect(result.hypotheses).toEqual([
        expect.objectContaining({
          id: 'hyp-1',
          description: 'Main thread is blocked',
          status: 'confirmed',
          proposedBy: 'qoder-agent-sdk',
        }),
      ]);
    });

    it.each(['Provider error is the event being analyzed', 'A short answer without punctuation', '## Any heading\nAnswer'])
      ('accepts the native successful nullable-stop result independently of wording: %s', async conclusion => {
        mockQuery.mockReturnValue(createMockSdkStream([
          {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: conclusion, num_turns: 1},
        ]));
        const result = await createRuntime().analyze('arbitrary request', 'truthful-completion', 'trace-1');
        expect(result).toMatchObject({success: true, partial: false, conclusion, rounds: 2, outputOrigin: 'sdk_final'});
        expect(result.completion).toMatchObject({status: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(conclusion)});
        expect(result.confidence).toBe(0.35);
        expect(result.terminationReason).toBeUndefined();
      });

    it.each([
      {body: '', draft: undefined},
      {body: ' \n\t ', draft: undefined},
      {body: '', draft: 'Earlier assistant draft is not the final answer'},
      {body: ' \n\t ', draft: 'Earlier assistant draft is not the final answer'},
    ])('keeps explicit empty or whitespace native output unknown: %p', async ({body, draft}) => {
      mockQuery.mockReturnValue(createMockSdkStream([
        ...(draft ? [{type: 'assistant', message: {content: [{type: 'text', text: draft}]}}] : []),
        {type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: body, num_turns: 1},
      ]));
      const result = await createRuntime({QODER_MODEL: 'main-model'})
        .analyze('any request', 'empty-preserved-native', 'trace-1');
      expect(mockProjectionProjectComplete).not.toHaveBeenCalled();
      expect(result).toMatchObject({success: false, partial: true, confidence: 0,
        conclusion: body, outputOrigin: 'sdk_final', completion: {status: 'unknown', sdkFinishReason: 'end_turn'}});
      const context = takeFinalizationContext(result)!;
      expect(context.hasSemanticTransport).toBe(false);
      expect(context.deliveryContext).toMatchObject({completion: result.completion});
      context.dispose();
    });

    it('does not certify a runtime privacy replacement created from an empty SDK answer', async () => {
      const receipt = issuedReplacementReceipt('');
      const api = privacyProjectionApi();
      api.revokeCodeAwareOutputGuards('empty-native-body');
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: '', num_turns: 1},
      ]));
      try {
        const result = await createRuntime().analyze('any request', 'empty-native-body', 'trace-1');
        expect(mockProjectionProjectComplete).not.toHaveBeenCalled();
        expect(result).toMatchObject({success: false, partial: true, confidence: 0,
          conclusion: receipt.text, outputOrigin: 'runtime_fallback',
          completion: {status: 'unknown'}});
      } finally {api.clearCodeAwareOutputGuards('empty-native-body');}
    });

    it.each(['有证据支持的原始回答', 'Original answer with supporting evidence'])
      ('uses the issued replaced disposition for a nonempty native answer: %s', async nativeBody => {
        const receipt = issuedReplacementReceipt(nativeBody);
        expect(receipt.disposition).toBe('replaced');
        const api = privacyProjectionApi();
        api.revokeCodeAwareOutputGuards('whole-replacement');
        mockQuery.mockReturnValue(createMockSdkStream([
          {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: nativeBody, num_turns: 1},
        ]));
        try {
          const result = await createRuntime().analyze('any request', 'whole-replacement', 'trace-1', {runId: 'replacement-run'});
          expect(result).toMatchObject({success: false, partial: true, confidence: 0,
            conclusion: receipt.text, outputOrigin: 'runtime_fallback', completion: {
              status: 'unknown', runId: 'replacement-run', conclusionFingerprint: receipt.outputFingerprint,
            }});
          expect(result.completion?.candidateRef).not.toBe('replacement-run:qoder:main');
          const verifier = jest.requireMock('../../claude/claudeVerifier') as {verifyConclusion: jest.Mock};
          const context = (verifier.verifyConclusion.mock.calls[0][2] as any).deliveryContext;
          expect(context.outputOrigin).toBe('runtime_fallback');
          expect(context.completion).toEqual(result.completion);
          expect(context.acceptedCandidate.conclusionFingerprint).toBe(receipt.outputFingerprint);
          expect(JSON.stringify(result)).not.toContain(receipt.inputFingerprint);
        } finally {api.clearCodeAwareOutputGuards('whole-replacement');}
      });

    it.each(['A normal answer', '正常模型回答', '[PRIVATE_OUTPUT_SUPPRESSED]'])
      ('does not infer replacement from a preserved native body: %s', async nativeBody => {
        mockQuery.mockReturnValue(createMockSdkStream([
          {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: nativeBody, num_turns: 1},
        ]));
        const result = await createRuntime().analyze('any request', 'preserved-native', 'trace-1');
        expect(result).toMatchObject({success: true, partial: false, conclusion: nativeBody,
          outputOrigin: 'sdk_final', completion: {status: 'completed'}});
      });

    it('transfers completion only through the issued redaction chain and uses the returned candidate', async () => {
      const api = privacyProjectionApi();
      const nativeBody = 'The observation remains valid. Private implementation detail is removed.';
      api.registerCodeAwareCanary('redaction-run', 'Private implementation detail');
      const receipt = api.sanitizeCodeAwareTextWithReceipt('redaction-run', nativeBody);
      expect(receipt.disposition).toBe('redacted');
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, stop_reason: null, result: nativeBody, num_turns: 1},
      ]));
      const result = await createRuntime().analyze('any request', 'redaction-run', 'trace-1', {runId: 'redaction-run-id'});
      expect(result).toMatchObject({success: true, partial: false, conclusion: receipt.text,
        outputOrigin: 'sdk_final', completion: {status: 'completed', conclusionFingerprint: receipt.outputFingerprint}});
      expect(result.completion?.candidateRef).not.toBe('redaction-run-id:qoder:main');
      const verifier = jest.requireMock('../../claude/claudeVerifier') as {verifyConclusion: jest.Mock};
      const context = (verifier.verifyConclusion.mock.calls[0][2] as any).deliveryContext;
      expect(context.completion).toEqual(result.completion);
      expect(context.acceptedCandidate.conclusionFingerprint).toBe(receipt.outputFingerprint);
      api.clearCodeAwareOutputGuards('redaction-run');
    });

    it('keeps failed setup provenance through an issued redaction instead of rebinding the raw error', async () => {
      const api = privacyProjectionApi();
      const sessionId = 'qoder-private-setup-error';
      api.registerCodeAwareCanary(sessionId, 'private setup detail');
      mockEnsureSkillRegistryInitialized.mockRejectedValueOnce(new Error('Failure: private setup detail'));
      const result = await createRuntime().analyze('any request', sessionId, 'trace-1', {runId: 'setup-error-run'});
      expect(result).toMatchObject({success: false, confidence: 0, outputOrigin: 'runtime_fallback',
        completion: {status: 'failed', reason: 'provider_error'}});
      expect(result.conclusion).not.toContain('private setup detail');
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      expect(result.completion?.candidateRef).not.toBe('setup-error-run:qoder:main');
      api.clearCodeAwareOutputGuards(sessionId);
    });

    it('consumes replacement provenance when cancellation retires a private session', async () => {
      const api = privacyProjectionApi();
      const sessionId = 'qoder-private-cancel';
      const late = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {await late.promise;},
        interrupt: mockInterrupt, close: mockClose,
      });
      const runtime = createRuntime();
      const analysis = runtime.analyze('any request', sessionId, 'trace-1');
      await waitForMockQuery();
      api.revokeCodeAwareOutputGuards(sessionId);
      await runtime.abortSession(sessionId);
      const result = await analysis;
      expect(result).toMatchObject({success: false, partial: true, confidence: 0,
        outputOrigin: 'runtime_fallback', completion: {status: 'unknown', reason: 'cancelled'}});
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      late.resolve();
      api.clearCodeAwareOutputGuards(sessionId);
    });

    it('retains the SDK output limit even when every report heading is present', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens',
          result: '## Final Report\n## Evidence\n## Conclusion\nUnfinished', num_turns: 2},
      ]));
      const result = await createRuntime().analyze('any request', 'output-limit', 'trace-1');
      expect(result).toMatchObject({success: false, partial: true, confidence: 0,
        completion: {status: 'incomplete', reason: 'output_limit', sdkFinishReason: 'max_tokens'}});
    });

    it('does not bind a terminal receipt with no body to an earlier assistant draft', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'assistant', message: {content: [{type: 'text', text: 'Earlier draft'}]}},
        {type: 'result', subtype: 'success', is_error: false, stop_reason: null},
      ]));
      const result = await createRuntime().analyze('any request', 'stream-only', 'trace-1');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'assistant_stream',
        conclusion: 'Earlier draft', completion: {status: 'unknown'}});
    });

    it('uses the first terminal receipt and prevents a later result from replacing its body', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: 'Current final', num_turns: 1},
        {type: 'result', subtype: 'success', is_error: false, result: 'Late different body', num_turns: 8},
      ]));
      const result = await createRuntime().analyze('any request', 'one-terminal', 'trace-1', {runId: 'one-terminal-run'});
      expect(result).toMatchObject({conclusion: 'Current final', rounds: 2, completion: {
        status: 'completed', runId: 'one-terminal-run', conclusionFingerprint: analysisDeliveryFingerprint('Current final'),
      }});
    });

    it.each([true, false])('uses the reserved summary without completing acquisition (summary succeeds: %p)', async summarySucceeds => {
      respondWithIntent();
      mockIntentTransport.mockResolvedValueOnce({status: 'ok', text: JSON.stringify(defaultIntentDecision)})
        .mockResolvedValueOnce(summarySucceeds
          ? {status: 'ok', text: 'The value is 42 ms. The cause is unresolved; ask about the main thread next.', finishReason: 'end_turn'}
          : {status: 'unavailable', reason: 'provider_error'});
      mockQuery.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          const mcp = mockCreateClaudeMcpServer.mock.calls.slice(-1)[0]![0] as any;
          await mcp.toolObserver({phase: 'started', toolCallId: 'query-1', toolName: 'execute_sql', params: {}, extra: {}});
          await mcp.toolObserver({phase: 'completed', toolCallId: 'query-1', toolName: 'execute_sql', params: {}, extra: {},
            result: {content: [{type: 'text', text: JSON.stringify({columns: ['dur_ms'], rows: [[42]]})}]}});
          yield {type: 'assistant', message: {content: [{type: 'text', text: 'The observed duration is 42 ms.'}]}};
          yield {type: 'result', subtype: 'error_max_turns', is_error: true, result: '', num_turns: 2, stop_reason: 'tool_use'};
        }, interrupt: mockInterrupt, close: mockClose,
      }));
      const runtime = createRuntime({QODER_MAX_TURNS: '3', QODER_MODEL: 'pinned-main', QODER_LIGHT_MODEL: 'classifier-only'});
      const result = await runtime.analyze('Investigate duration', 'qoder-closeout', 'trace-1', {analysisMode: 'full'});
      expect((mockQuery.mock.calls[0][0] as any).options.maxTurns).toBe(2);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
      const summaryInput = mockIntentTransport.mock.calls[1][0] as any;
      expect(summaryInput.config).toMatchObject({model: 'pinned-main', lightModel: undefined});
      expect(summaryInput.prompt).toContain('42');
      expect(summaryInput.prompt).toContain('execute_sql');
      expect(summaryInput).not.toHaveProperty('resume');
      expect((mockCreateClaudeMcpServer.mock.calls[0][0] as any).canInvokeTool()).toBe(false);
      expect(result).toMatchObject({success: false, partial: true, rounds: 3, terminationReason: 'max_turns',
        completion: {status: 'incomplete', reason: 'turn_limit', attemptId: summarySucceeds ? 'turn-closeout:1' : 'main'}});
      expect(result.conclusion).toBe(summarySucceeds
        ? 'The value is 42 ms. The cause is unresolved; ask about the main thread next.'
        : 'The observed duration is 42 ms.');
      expect(result.completion?.sdkFinishReason).toBe(summarySucceeds ? 'end_turn' : 'tool_use');
      expect(result.terminationMessage).not.toContain('did not supply a final answer');
      const turn = sessionContextManager.getOrCreate('qoder-closeout', 'trace-1').getAllTurns().slice(-1)[0]!;
      expect(turn.result).toMatchObject({partial: true, completion: {status: 'incomplete', reason: 'turn_limit'}});
    });

    it.each([{maxTurns: 1, reportedTurns: 1}, {maxTurns: 3, reportedTurns: 3}])(
      'does not add a summary when the total budget has no room: %p', async ({maxTurns, reportedTurns}) => {
        mockQuery.mockReturnValue(createMockSdkStream([
          {type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Partial observation', num_turns: reportedTurns},
        ]));
        const result = await createRuntime({QODER_MAX_TURNS: String(maxTurns)}).analyze('test', 'qoder-no-summary-room', 'trace-1', {analysisMode: 'full'});
        expect(mockIntentTransport).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({rounds: reportedTurns, partial: true, completion: {reason: 'turn_limit'}});
      },
    );

    it('counts a cancelled closeout and retains the original acquired answer', async () => {
      const summaryStarted = createDeferred<void>();
      mockIntentTransport.mockResolvedValueOnce({status: 'ok', text: JSON.stringify(defaultIntentDecision)})
        .mockImplementationOnce((input: any) => new Promise(resolve => {
          summaryStarted.resolve();
          input.signal.addEventListener('abort', () => resolve({status: 'unavailable', reason: 'provider_error'}), {once: true});
        }));
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'assistant', message: {content: [{type: 'text', text: 'Acquired answer before cancellation.'}]}},
        {type: 'result', subtype: 'error_max_turns', is_error: true, result: '', num_turns: 2},
      ]));
      const runtime = createRuntime({QODER_MAX_TURNS: '3'});
      const analysis = runtime.analyze('Investigate duration', 'qoder-cancel-closeout', 'trace-1', {analysisMode: 'full'});
      await summaryStarted.promise;
      await runtime.abortSession('qoder-cancel-closeout');
      const result = await analysis;
      expect(result).toMatchObject({success: false, partial: true, rounds: 3,
        conclusion: 'Acquired answer before cancellation.', completion: {status: 'cancelled', reason: 'cancelled'}});
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockIntentTransport).toHaveBeenCalledTimes(2);
    });

    it('returns success: false for error_max_turns', async () => {
      const messages = [
        { type: 'result', subtype: 'error_max_turns', errors: ['Max turns reached'], result: '' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const result = await runtime.analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('max_turns');
    });

    it('returns success: false for error_during_execution', async () => {
      const messages = [
        { type: 'result', subtype: 'error_during_execution', errors: ['Internal error'], result: '' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const result = await runtime.analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.conclusion).toContain('Internal error');
    });

    it('returns success: false when SDK throws auth error', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('Unauthorized: invalid access token');
      });

      const runtime = createRuntime();
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const result = await runtime.analyze('test', 'session-1', 'trace-1', {
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      });

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.terminationMessage).toContain('Unauthorized: invalid access token');
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'sdk_start', outcome: 'ok'}),
        expect.objectContaining({name: 'provider', outcome: 'error'}),
      ]));
    });

    it.each(['cancelled', 'timeout'] as const)(
      'preserves current acquisition text and actual turns when %s before a terminal receipt', async reason => {
        const partialReady = createDeferred<void>();
        const releaseStream = createDeferred<void>();
        const expectedBody = 'Observed duration is 42 ms. The cause remains unresolved.';
        mockQuery.mockReturnValue({
          async *[Symbol.asyncIterator]() {
            yield {type: 'assistant', message: {content: [{type: 'text', text: 'Observed duration is 42 ms. '}]}};
            yield {type: 'assistant', message: {content: [{type: 'text', text: 'The cause remains unresolved.'}]}};
            partialReady.resolve();
            await releaseStream.promise;
            yield {type: 'assistant', message: {content: [{type: 'text', text: 'Late answer must not overwrite the partial result.'}]}};
            yield {type: 'result', subtype: 'success', is_error: false, result: 'Late result', num_turns: 9};
          },
          interrupt: mockInterrupt, close: mockClose,
        });
        const sessionId = `qoder-acquisition-${reason}`;
        const runtime = createRuntime({QODER_MAX_TURNS: '3', QODER_FULL_PER_TURN_MS: reason === 'timeout' ? '100' : '60000'});
        const resultPromise = runtime.analyze('Investigate duration', sessionId, 'trace-1', {analysisMode: 'full'});
        await partialReady.promise;
        if (reason === 'cancelled') await runtime.abortSession(sessionId);
        const result = await resultPromise;
        expect(result).toMatchObject({success: false, partial: true, rounds: 2, conclusion: expectedBody,
          completion: {status: reason === 'timeout' ? 'incomplete' : 'cancelled', reason}});
        expect(mockIntentTransport).toHaveBeenCalledTimes(1);
        expect(mockClose).toHaveBeenCalledTimes(1);
        releaseStream.resolve();
        await Promise.resolve();
        expect(result.conclusion).toBe(expectedBody);
        expect(result.rounds).toBe(2);
      },
    );

    it('handles user cancellation via abortSession without throwing', async () => {
      const releaseStream = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
          await releaseStream.promise;
          yield { type: 'result', subtype: 'success', is_error: false, result: 'partial' };
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });

      const runtime = createRuntime();
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const attributionSink = createNoopAttributionSink(runtimePerformanceRecorder);
      const resultPromise = runtime.analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'full',
        selectionContext: {kind: 'track_event', eventId: 7, ts: 42},
        runManifestAttributionSink: attributionSink,
      });
      await waitForMockQuery();
      await runtime.abortSession('session-1');
      releaseStream.resolve();
      const result = await resultPromise;

      // Regardless of timing, the result should be returned without throwing
      expect(result).toBeDefined();
      expect(result.sessionId).toBe('session-1');
      expect(result).toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'timeout',
      });
      const finalization = takeFinalizationContext(result);
      expect(finalization?.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: {kind: 'track_event', eventId: 7, ts: 42},
        sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace-1'}});
      finalization?.dispose();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'cancelled'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'finalization',
          outcome: 'cancelled',
        }),
      ]));
    });

  });

  describe('session resume', () => {
    it('starts each analysis with a fresh plan while preserving bounded history', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ]));
      const runtime = createRuntime();
      const previousPlan = {
        phases: [{
          id: 'p1',
          name: '旧阶段',
          goal: '旧 run 的分析阶段',
          expectedTools: ['get_comparison_context'],
          status: 'completed',
          summary: '旧 run 已完成，不能被下一轮继续使用。',
        }],
        successCriteria: '旧 run 完成',
        submittedAt: 1,
        toolCallLog: [],
      };
      (runtime as any).sessionPlans.set('session-1', {
        current: previousPlan,
        history: [],
        prePlanToolCallLog: [{
          toolName: 'get_comparison_context',
          timestamp: 10,
          success: true,
        }],
      });

      await runtime.analyze('second run', 'session-1', 'trace-1');

      const planState = (mockCreateClaudeMcpServer.mock.calls[0][0] as any).analysisPlan;
      expect(planState.current).toBeNull();
      expect(planState.history).toEqual([previousPlan]);
      expect(planState.prePlanToolCallLog).toEqual([]);
    });

    it('starts a fresh provider session and inherits product history on subsequent calls', async () => {
      const messages1 = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      const messages2 = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done again' },
      ];
      mockQuery
        .mockReturnValueOnce(createMockSdkStream(messages1))
        .mockReturnValueOnce(createMockSdkStream(messages2));

      const runtime = createRuntime();
      await runtime.analyze('first', 'session-1', 'trace-1');
      await runtime.analyze('second', 'session-1', 'trace-1', { analysisMode: 'fast' });

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBeUndefined();
      expect(secondCallArgs.options.systemPrompt).toEqual(expect.any(String));
      expect(secondCallArgs.prompt).toContain('first');
      expect(secondCallArgs.prompt).toContain('done');
      expect((mockCreateClaudeMcpServer.mock.calls[1][0] as any).analysisHistoryReader).toBeDefined();
    });

    it('starts fresh when code-aware mode is explicitly off', async () => {
      const messages1 = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      const messages2 = [
        { type: 'result', subtype: 'success', is_error: false, result: 'done' },
      ];
      mockQuery
        .mockReturnValueOnce(createMockSdkStream(messages1))
        .mockReturnValueOnce(createMockSdkStream(messages2));

      const runtime = createRuntime();
      await runtime.analyze('first', 'session-1', 'trace-1');
      await runtime.analyze('second', 'session-1', 'trace-1', { codeAwareMode: 'off' });

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBeUndefined();
    });

    it.each([
      { codeAwareMode: 'metadata_only' as const, codebaseIds: ['private-codebase'] },
      { knowledgeSourceIds: ['private-wiki'] },
    ])('does not retain or resume SDK sessions for private knowledge: %p', async (privateOptions) => {
      mockQuery
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'system', subtype: 'init', session_id: 'private-sdk-session' },
          { type: 'result', subtype: 'success', is_error: false, result: 'done' },
        ]))
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'result', subtype: 'success', is_error: false, result: 'done again' },
        ]));

      const runtime = createRuntime();
      await runtime.analyze('private', 'session-1', 'trace-1', privateOptions);

      await runtime.analyze('public', 'session-1', 'trace-1');
      const publicCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(publicCallArgs.options.resume).toBeUndefined();
    });

  });

  describe('snapshot round-trip', () => {
    it('keeps no native session across snapshot/restore, even from a legacy snapshot', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'system', subtype: 'init', session_id: 'sdk-session-xyz' },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1');

      const sessionFields = {
        agentRuntimeProviderId: 'prov-1',
        agentRuntimeProviderSnapshotHash: 'hash-1',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        runSequence: 0,
        conversationOrdinal: 0,
      };
      const snapshot = runtime.takeSnapshot('session-1', 'trace-1', sessionFields as any);

      expect(snapshot.agentRuntimeKind).toBe('qoder-agent-sdk');
      expect(snapshot.engineState).toEqual({
        kind: 'qoder-agent-sdk',
        provider: {providerId: 'prov-1', providerSnapshotHash: 'hash-1'},
        qoder: {},
      });
      expect(JSON.stringify(snapshot)).not.toContain('sdk-session-xyz');

      // A snapshot written before native state was dropped still carries the SDK
      // session id; restoring it must neither resume that session nor save it again.
      const legacySnapshot = {
        ...snapshot,
        engineState: {
          kind: 'qoder-agent-sdk' as const,
          provider: {providerId: 'prov-1', providerSnapshotHash: 'hash-1'},
          qoder: {opaque: {version: 1 as const, sdkSessionId: 'sdk-session-legacy'}},
        },
      };
      const runtime2 = createRuntime();
      runtime2.restoreFromSnapshot('session-2', 'trace-1', legacySnapshot);
      await runtime2.analyze('follow-up', 'session-2', 'trace-1');

      expect((mockQuery.mock.calls[1][0] as any).options.resume).toBeUndefined();
      expect(JSON.stringify(mockQuery.mock.calls[1][0])).not.toContain('sdk-session-legacy');
      expect(JSON.stringify(runtime2.takeSnapshot('session-2', 'trace-1', sessionFields as any)))
        .not.toContain('sdk-session-legacy');
    });

    it('does not persist opaque SDK or intermediate state for private knowledge', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'system', subtype: 'init', session_id: 'private-sdk-session' },
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone' },
      ]));
      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1', {
        knowledgeSourceIds: ['private-wiki'],
      });

      const snapshot = runtime.takeSnapshot('session-1', 'trace-1', {
        agentRuntimeProviderId: 'prov-1',
        agentRuntimeProviderSnapshotHash: 'hash-1',
        conversationSteps: [{ id: 'private-step' }],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [{ id: 'private-dialogue' }],
        agentResponses: [{ id: 'private-response' }],
        dataEnvelopes: [],
        knowledgeSourceIds: ['private-wiki'],
        runSequence: 0,
        conversationOrdinal: 0,
      } as any);

      expect(snapshot.engineState?.kind).toBe('qoder-agent-sdk');
      expect(snapshot.engineState?.kind === 'qoder-agent-sdk' && snapshot.engineState.qoder).toEqual({});
      expect(snapshot.conversationSteps).toEqual([]);
      expect(snapshot.agentDialogue).toEqual([]);
      expect(snapshot.agentResponses).toEqual([]);
    });

    it('prefetches admitted cross-session experience for a private run as for a public one', async () => {
      const patterns = jest.spyOn(analysisPatternMemory, 'buildPatternContextSection').mockReturnValue('PATTERN_MEMORY_SECTION');
      const negative = jest.spyOn(analysisPatternMemory, 'buildNegativePatternSection').mockReturnValue('NEGATIVE_MEMORY_SECTION');
      const cases = jest.spyOn(caseBackgroundContext, 'buildCaseBackgroundContext').mockReturnValue('CASE_BACKGROUND_SECTION');
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'},
      ]));
      try {
        await createRuntime().analyze('private question', 'session-1', 'trace-1', {
          analysisMode: 'full', knowledgeSourceIds: ['private-wiki'],
        });
        expect(patterns).toHaveBeenCalledTimes(1);
        expect(negative).toHaveBeenCalledTimes(1);
        const systemPrompt = (mockQuery.mock.calls[0][0] as any).options.systemPrompt;
        expect(systemPrompt).toContain('PATTERN_MEMORY_SECTION');
        expect(systemPrompt).toContain('NEGATIVE_MEMORY_SECTION');
        expect(systemPrompt).toContain('CASE_BACKGROUND_SECTION');
      } finally { patterns.mockRestore(); negative.mockRestore(); cases.mockRestore(); }
    });

    it('keeps a private run\'s turn and session state in memory like the other runtimes', async () => {
      // The MCP context is built before the SDK query starts; each run writes into its own context.
      mockQuery.mockImplementation(() => {
        const context = mockCreateClaudeMcpServer.mock.calls.slice(-1)[0][0] as any;
        const run = mockCreateClaudeMcpServer.mock.calls.length;
        context.analysisNotes.push({section: 'observation', content: `Private run ${run} note`, priority: 'low', timestamp: run});
        context.uncertaintyFlags.push({topic: 'wiki', assumption: `Private run ${run} assumption`, question: 'Confirm?'});
        return createMockSdkStream([
          {type: 'system', subtype: 'init', session_id: 'private-sdk-session'},
          {type: 'result', subtype: 'success', is_error: false, result: '## Final Report\ndone'},
        ]);
      });
      const runtime = createRuntime();
      await runtime.analyze('private question', 'session-1', 'trace-1', {knowledgeSourceIds: ['private-wiki']});

      // The creator's report and follow-ups read this state.
      expect(runtime.getSessionNotes('session-1')).toEqual([expect.objectContaining({content: 'Private run 1 note'})]);
      expect(runtime.getSessionUncertaintyFlags('session-1')).toEqual([expect.objectContaining({
        assumption: 'Private run 1 assumption'})]);
      const turns = sessionContextManager.getOrCreate('session-1', 'trace-1').getAllTurns();
      expect(turns).toHaveLength(1);
      expect(turns[0].result).toMatchObject({sourceDerived: true});

      // Notes carry over within the session; uncertainty flags belong to their own turn.
      await runtime.analyze('private follow-up', 'session-1', 'trace-1', {knowledgeSourceIds: ['private-wiki']});
      expect(runtime.getSessionNotes('session-1').map(note => note.content)).toEqual(['Private run 1 note', 'Private run 2 note']);
      expect(runtime.getSessionUncertaintyFlags('session-1')).toEqual([expect.objectContaining({
        assumption: 'Private run 2 assumption'})]);

      const snapshot = runtime.takeSnapshot('session-1', 'trace-1', {
        conversationSteps: [], queryHistory: [], conclusionHistory: [], agentDialogue: [], agentResponses: [],
        dataEnvelopes: [], knowledgeSourceIds: ['private-wiki'], runSequence: 1, conversationOrdinal: 1,
      } as any);
      expect(snapshot.analysisNotes).toEqual([]);
      expect(snapshot.uncertaintyFlags).toEqual([]);
      expect(snapshot.artifacts).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    it('invalidates the runtime SDK loader cache on reset', () => {
      const runtime = createRuntime();

      runtime.reset();

      expect(mockResetQoderSdkModuleCache).toHaveBeenCalledTimes(1);
    });

    it('invalidates an analysis waiting on SDK load when the session is cleaned up', async () => {
      const sdkLoad = createDeferred<typeof mockSdkModule>();
      mockLoadQoderSdkModule.mockReturnValueOnce(sdkLoad.promise);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', is_error: false, result: '## Final Report\nlate' },
      ]));
      const runtime = createRuntime();
      const analysis = runtime.analyze(
        'perform a full startup analysis',
        'session-qoder-cleanup-pending-sdk',
        'trace-1',
        { analysisMode: 'full' },
      );
      while (mockLoadQoderSdkModule.mock.calls.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      runtime.cleanupSession('session-qoder-cleanup-pending-sdk');
      sdkLoad.resolve(mockSdkModule);

      await expect(analysis).resolves.toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
