// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import type { StreamingUpdate } from '../../agent/types';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import {
  createPiAgentCoreToolFromSharedSpec,
  buildPiAnalysisCompletion,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  getPiAgentCorePlanCompletionStatus,
  getPiAgentCoreEngineCapabilities,
  PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV,
  PI_AGENT_CORE_MODULE_PATH_ENV,
  PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV,
  PI_AGENT_CORE_FAKE_STREAM_ENV,
  PI_AGENT_CORE_MODEL_JSON_ENV,
  PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV,
  PiAgentCoreRuntime,
  projectPiAgentCoreEventToStreamingUpdate,
  repairPiAgentCoreSubmitPlanArgs,
  sanitizePiAgentCoreConclusionText,
  selectAssistantConclusion,
  type PiAgentCoreEvent,
} from '../piAgentCoreRuntime';
import * as piAgentCoreRuntimeModule from '../piAgentCoreRuntime';
import type { RuntimeToolResult, SharedToolSpec } from '../runtimeToolSpec';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../runtimeToolResult';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import * as claudeMcpModule from '../../agentv3/claudeMcpServer';
import {expectRuntimeVendorHintParity} from './vendorHintParityFixture';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from './sourceFinalizationFixture';
import {createRuntimePerformanceRecorder} from '../runtimePerformance';
import {withEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {EffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import type {AnalysisTurnIntentDecision} from '../analysisTurnIntent';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import * as systemPromptModule from '../../agentv3/claudeSystemPrompt';
import * as analysisPatternMemory from '../../agentv3/analysisPatternMemory';
import * as caseBackgroundContext from '../../services/caseEvolution/caseBackgroundContext';
import * as focusAppDetectorModule from '../../agentv3/focusAppDetector';
import {resolveFocusPackageCell} from './focusEvidenceFixture';
import {registerCodeAwareCanary, revokeCodeAwareOutputGuards, clearCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';
import * as sourceProjectionModule from '../../services/codebase/sourceClaimVerifier';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import * as qualityGateModule from '../../services/finalResultQualityGate';
import {takeFinalizationContext} from '../analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {loadPiProviderRuntimeModules} from '../engines/pi/piAgentCoreProvider';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';
import {candidateWithPopulation, declaredCandidateWithClaims, declaredClaim} from '../../../tests/helpers/conclusionDeclarationFixture';
import {admitLearnedEntry, withDurableLearningPermission} from '../../services/security/durableLearning';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';

const mockClaudeVerifierVerifyConclusion = jest.fn();
jest.mock('../engines/claude/claudeVerifier', () => {
  const actual = jest.requireActual('../engines/claude/claudeVerifier') as any;
  return {
    ...actual,
    verifyConclusion: (...args: unknown[]) => mockClaudeVerifierVerifyConclusion(...args),
  };
});

let piClassifierDecision: AnalysisTurnIntentDecision;
let piClassifierResponses: Array<Record<string, unknown> | Error>;
let piClassifierCalls: Array<{model: unknown; context: any; options: any}>;

async function loadFakePiProviderRuntime(config: {model: Record<string, unknown>}) {
  return {
    model: config.model as any,
    models: {} as any,
    streamFn: ((model: unknown, context: unknown, options: unknown) => {
      piClassifierCalls.push({model, context, options});
      return {result: async () => {
        const supplied = piClassifierResponses.shift();
        if (supplied instanceof Error) throw supplied;
        return supplied ?? {
          role: 'assistant', stopReason: 'stop', model: config.model.id,
          content: [{type: 'text', text: JSON.stringify(piClassifierDecision)}],
        };
      }};
    }) as any,
  };
}

class FakePiAgent {
  static instances: FakePiAgent[] = [];
  static promptMessages: unknown[] | undefined;
  static abortHandler: ((agent: FakePiAgent) => void) | undefined;
  static promptHandler: ((
    agent: FakePiAgent,
    input: string,
    promptIndex: number,
  ) => Promise<unknown[] | undefined> | unknown[] | undefined) | undefined;

  state = {
    messages: [] as unknown[],
    tools: [] as unknown[],
    systemPrompt: '',
    model: undefined as unknown,
  };

  private readonly listeners: Array<(event: PiAgentCoreEvent) => void> = [];
  readonly options?: Record<string, unknown>;
  lastPrompt = '';
  prompts: string[] = [];
  promptCount = 0;
  emittedTurns = 0;
  aborted = false;

  constructor(options?: Record<string, unknown>) {
    this.options = options;
    FakePiAgent.instances.push(this);
    const initialState = options?.initialState as {
      tools?: unknown[];
      systemPrompt?: string;
      model?: unknown;
      messages?: unknown[];
    } | undefined;
    this.state.tools = initialState?.tools ?? [];
    this.state.systemPrompt = initialState?.systemPrompt ?? '';
    this.state.model = initialState?.model;
    this.state.messages = [...(initialState?.messages ?? [])];
  }

  subscribe(listener: (event: PiAgentCoreEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  async prompt(input: string): Promise<void> {
    this.lastPrompt = input;
    this.prompts.push(input);
    this.promptCount += 1;
    const assistantMessage = {
      stopReason: 'stop',
      role: 'assistant',
      content: [{ type: 'text', text: 'Pi smoke final' }],
    };
    this.emit({ type: 'agent_start' });
    const turnBoundary = this.emittedTurns;
    const rawMessages = await FakePiAgent.promptHandler?.(this, input, this.promptCount)
      ?? FakePiAgent.promptMessages
      ?? [assistantMessage];
    const messages = rawMessages.map(message => {
      const value = message as {role?: string};
      return value.role === 'assistant' ? {stopReason: 'stop', ...value} : value;
    });
    if (this.emittedTurns === turnBoundary) this.emit({type: 'turn_end', message: messages[messages.length - 1]});
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Pi smoke final' },
    });
    this.state.messages.push(...messages);
    this.emit({ type: 'agent_end', messages: this.state.messages });
  }

  abort(): void {
    this.aborted = true;
    FakePiAgent.abortHandler?.(this);
  }

  reset(): void {
    this.state.messages = [];
  }

  emitForTest(event: PiAgentCoreEvent): void {
    this.emit(event);
  }

  private emit(event: PiAgentCoreEvent): void {
    if (event.type === 'turn_end') this.emittedTurns++;
    for (const listener of this.listeners) listener(event);
  }
}

beforeEach(() => {
  piClassifierDecision = {schemaVersion: 1, taskKind: 'fact', sceneId: 'general',
    scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new'};
  piClassifierResponses = [];
  piClassifierCalls = [];
  const actualVerifier = jest.requireActual('../engines/claude/claudeVerifier') as any;
  mockClaudeVerifierVerifyConclusion.mockReset();
  mockClaudeVerifierVerifyConclusion.mockImplementation((...args: unknown[]) => (
    actualVerifier.verifyConclusion(...args)
  ));
  FakePiAgent.instances = [];
  FakePiAgent.promptMessages = undefined;
  FakePiAgent.abortHandler = undefined;
  FakePiAgent.promptHandler = undefined;
});

function createFakeTraceProcessorService() {
  return {
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    getTrace: jest.fn(() => ({
      id: 'trace-pi',
      filename: 'trace.pftrace',
      size: 1,
      uploadTime: new Date(),
      status: 'ready',
      traceOs: 'android',
      traceFormat: 'perfetto_protobuf',
    })),
  } as any;
}

const PI_TEST_MODEL_JSON = JSON.stringify({
  id: 'pi-test-model',
  name: 'Pi Test Model',
  api: 'openai-completions',
  provider: 'smartperfetto',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
  apiKey: 'sk-pi-test-secret',
});

function createSharedSpec(handler?: SharedToolSpec['handler']): SharedToolSpec {
  return {
    name: 'query_trace',
    description: 'Run a trace SQL query',
    exposure: 'public',
    inputSchema: {
      sql: z.string().describe('SQL query'),
      params: z.record(z.string(), z.any()).optional(),
    },
    handler: handler ?? (async () => ({
      content: [{ type: 'text', text: 'ok' }],
    } as RuntimeToolResult)),
  };
}

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
): RunManifestAttributionSink {
  return {
    identity: {
      runId: 'run-pi-test',
      sessionId: 'session-pi',
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

function createEffectiveRuntimeRegistrySnapshot(): EffectiveRuntimeRegistrySnapshot {
  const skillRegistry = {
    registryFingerprint: 'registry-test',
    overlayGeneration: 'overlay-test',
    isInitialized: () => true as const,
    getSkill: () => undefined,
    getAllSkills: () => [],
    getFragmentCache: () => new Map<string, string>(),
    getSkillOrigin: () => undefined,
    getAppliedOverlayIds: () => [],
    getVendorOverride: () => undefined,
    hasVendorOverrides: () => false,
    getVendorOverridesForSkill: () => [],
    getVendorOverrideLoadIssues: () => [],
    findMatchingSkill: () => undefined,
  };
  return {
    scope: {tenantId: 'tenant-test', workspaceId: 'workspace-test'},
    baseSkillRegistryFingerprint: 'base-skills-test',
    baseStrategyRegistryFingerprint: 'base-strategies-test',
    overlayGeneration: 'overlay-test',
    skillRegistry,
    strategyRegistry: buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'overlay-test',
    }),
    skillNotes: {
      registryFingerprint: 'skill-notes-test',
      getSkillNotes: () => [],
      getSkillIds: () => [],
    },
  };
}

function createSnapshotFields(): any {
  return {
    conversationSteps: [],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    runSequence: 1,
    conversationOrdinal: 0,
  };
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

function rejectAfter(ms: number, onTimeout?: () => void): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      onTimeout?.();
      reject(new Error(`test guard timed out after ${ms}ms`));
    }, ms);
  });
}

/** Provider activity timing uses real MCP tools, without machine-local AIW corpus verification. */
async function withProviderActivityTimingFixture<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SMARTPERFETTO_AIW_PACK_ENABLED;
  process.env.SMARTPERFETTO_AIW_PACK_ENABLED = '0';
  try {return await run();} finally {
    if (previous === undefined) delete process.env.SMARTPERFETTO_AIW_PACK_ENABLED;
    else process.env.SMARTPERFETTO_AIW_PACK_ENABLED = previous;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 500,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for test predicate');
    }
    await delay(intervalMs);
  }
}

async function submitCompletedMinimalPlan(agent: FakePiAgent): Promise<void> {
  const submitPlan = agent.state.tools.find((tool: any) => tool.name === 'submit_plan') as any;
  const updatePlanPhase = agent.state.tools.find((tool: any) => tool.name === 'update_plan_phase') as any;
  await submitPlan.execute('plan-call', {
    phases: [{
      id: 'p1',
      name: '综合分析报告',
      goal: '汇总已有证据并输出最终性能分析报告',
      expectedTools: [],
    }],
    successCriteria: '输出包含证据、根因、建议和限制的完整报告',
  });
  await updatePlanPhase.execute('phase-call', {
    phaseId: 'p1',
    status: 'completed',
    summary: '已基于现有 trace 证据完成根因汇总、建议整理和限制说明。',
  });
}

function buildUnverifiedPiReport(): string {
  return [
    '## 综合结论',
    '当前性能问题集中在主线程同步工作，报告已经完成结构化整理。',
    '',
    '## 关键证据链',
    '直接 trace 显示代表帧耗时 62.73ms，超过 8.33ms 帧预算。',
    '',
    '## 根因拆解',
    '主线程 ANIMATION 阶段承担了不适合逐帧同步执行的重计算。',
    '',
    '## 已排除因素',
    '现有证据未显示 GC 是这一代表帧的直接根因。',
    '',
    '## 优化建议',
    '**[CRITICAL] 将 ANIMATION 回调中的重计算异步化**',
    '描述：把可预计算工作移出逐帧同步回调，并保持 UI 状态提交轻量。',
    '该建议需要在保持渲染语义不变的前提下实施，并通过相同场景复测。',
    '',
    '## 置信度/限制',
    '置信度中等；仍需在修复后复测相同交互区间。',
    '',
    '补充说明：以上结论只针对当前 trace 的代表区间，不外推到其他版本、设备或未采集场景。',
  ].join('\n');
}

function buildVerifiedPiReport(): string {
  return [
    '## 综合结论',
    '主线程同步重计算是当前代表帧超预算的直接原因。',
    '',
    '## 关键证据链',
    '直接 trace 显示代表帧耗时 62.73ms，超过 8.33ms 帧预算。',
    '',
    '## 根因拆解',
    '**[CRITICAL] 将 ANIMATION 回调中的重计算异步化**',
    '证据：代表帧在 ANIMATION 阶段同步执行 47-59ms，6/7 帧发生掉帧。',
    '',
    '## 已排除因素',
    '现有证据未显示 GC 是这一代表帧的直接根因。',
    '',
    '## 优化建议',
    '将可预计算工作移出逐帧同步回调，修复后复测相同区间。',
    '',
    '## 置信度/限制',
    '置信度高；结论仅适用于当前 trace 的已采集区间。',
  ].join('\n');
}

function declaredPiCandidate(body: string): string {
  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [{rank: 1, statement: 'The candidate body is the authored conclusion.'}],
    clusters: [],
    evidenceChain: [],
    claims: [],
    uncertainties: [],
    nextSteps: [],
  };
  return `${body}\n${renderConclusionContractSidecar(contract)}`;
}

function buildScrollingPiReport(includeRepresentativeFrameSection: boolean): string {
  return [
    '## 综合结论',
    '当前滑动问题由主线程同步重计算主导，7 帧真实掉帧中的 6 帧命中同一模式。',
    '',
    '## 全帧根因分布',
    '| 根因 | 帧数 | 占比 |',
    '| --- | ---: | ---: |',
    '| ANIMATION 同步阻塞 | 6 | 85.7% |',
    '| Vulkan Shader 冷编译 | 1 | 14.3% |',
    '',
    ...(includeRepresentativeFrameSection ? [
      '## 代表帧分析',
      'Frame 59665234 耗时 62.73ms，其中 ANIMATION 回调占 59.31ms，直接 trace 显示 CustomScroll_longFrameLoad 占 59.01ms。[Evidence:data:skill:jank_frame_detail:test]',
      '',
    ] : []),
    '## 峰值/口径指标',
    '刷新率为 120Hz，单帧预算 8.33ms；最长帧 62.73ms，真实掉帧率为 2.02%。',
    '',
    '## 优化建议',
    '将 ANIMATION 回调中的同步重计算移到后台线程，并在相同滑动区间复测。',
    '',
    '## 置信度/限制',
    '置信度高；结论只覆盖当前 trace，缺失 GPU slice 时不外推 shader 内部阶段。',
  ].join('\n');
}

describe('experimental Pi agent-core runtime contract', () => {
  it('describes Pi agent-core as hidden, optional, sequential, and no shell/file tool runtime', () => {
    expect(getPiAgentCoreEngineCapabilities()).toEqual({
      kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      displayName: 'Experimental Pi Agent Core',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
      draftAnswerStreaming: false,
    });
  });

  it('loads Pi provider imports serially by default and concurrently only when Task 7 is admitted', async () => {
    const firstModule = createDeferred<unknown>();
    const serialLoader = jest.fn(async (specifier: string) => {
      if (specifier === '@earendil-works/pi-ai') return firstModule.promise;
      if (specifier === '@earendil-works/pi-ai/providers/all') return {};
      return {openAIResponsesApi: () => ({})};
    });
    const serial = loadPiProviderRuntimeModules('openai-responses' as any, {}, serialLoader);
    await Promise.resolve();
    expect(serialLoader.mock.calls.map(call => call[0])).toEqual(['@earendil-works/pi-ai']);
    firstModule.resolve({});
    await serial;
    expect(serialLoader.mock.calls.map(call => call[0])).toEqual([
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/providers/all',
      '@earendil-works/pi-ai/api/openai-responses.lazy',
    ]);

    const releaseImports = createDeferred<void>();
    const parallelLoader = jest.fn(async (specifier: string) => {
      await releaseImports.promise;
      if (specifier === '@earendil-works/pi-ai/api/openai-responses.lazy') {
        return {openAIResponsesApi: () => ({})};
      }
      return {};
    });
    const parallel = loadPiProviderRuntimeModules('openai-responses' as any, {
      SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7',
    }, parallelLoader);
    await Promise.resolve();
    expect(parallelLoader.mock.calls.map(call => call[0])).toEqual([
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/providers/all',
      '@earendil-works/pi-ai/api/openai-responses.lazy',
    ]);
    releaseImports.resolve();
    await parallel;
  });

  it('adapts shared SmartPerfetto tools into request-scoped Pi-like tools', async () => {
    const handler = jest.fn(async (
      _args: Record<string, unknown>,
      _extra: unknown,
    ) => ({
      content: [{ type: 'text', text: '42' }],
    } as RuntimeToolResult));
    const spec = createSharedSpec(handler);
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      runtimeKind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
    });
    const updates: unknown[] = [];
    const controller = new AbortController();

    expect(tool).toMatchObject({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      executionMode: 'sequential',
    });
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        sql: { type: 'string' },
      },
    });
    await expect(tool.execute(
      'call-1',
      { sql: 'select 1', params: '{"pid":123}' },
      controller.signal,
      (update) => updates.push(update),
    )).resolves.toMatchObject({
      content: [{ type: 'text', text: '42' }],
    });
    expect(handler).toHaveBeenCalledWith(
      { sql: 'select 1', params: { pid: 123 } },
      expect.objectContaining({
        runtime: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
        toolCallId: 'call-1',
        signal: controller.signal,
      }),
    );
    expect(updates).toEqual([
      { type: 'smartperfetto_tool_started', toolCallId: 'call-1', toolName: spec.name },
      { type: 'smartperfetto_tool_finished', toolCallId: 'call-1', toolName: spec.name },
    ]);
  });

  it('preserves shared tool isError through the Pi transport adapter', async () => {
    const spec = createSharedSpec(async () => ({
      content: [{ type: 'text', text: '{"success":false,"error":"reference side failed"}' }],
      isError: true,
    } as RuntimeToolResult));
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
    });

    await expect(tool.execute('call-failed', { sql: 'select 1' }, undefined)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '{"success":false,"error":"reference side failed"}' }],
    });
  });

  it('records Pi tool executions into the shared analysis plan evidence log', async () => {
    const plan = {
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '完整解释代表掉帧根因',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const spec: SharedToolSpec = {
      name: 'invoke_skill',
      description: 'Invoke a SmartPerfetto skill',
      exposure: 'public',
      inputSchema: {
        skillId: z.string(),
        params: z.record(z.string(), z.any()).optional(),
      },
      handler: jest.fn(async () => ({
        content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
      } as RuntimeToolResult)),
    };
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      runtimeKind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      analysisPlan: { current: plan },
    });

    await tool.execute(
      'call-frame-detail',
      { skillId: 'jank_frame_detail', params: { frameId: 59665219 } },
      undefined,
    );

    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        inputSummary: 'jank_frame_detail(frameId)',
        matchedPhaseId: 'p-frame-detail',
      }),
    ]);
  });

  it('suppresses Pi tool completion side effects when a handler ignores abort and settles late', async () => {
    const releaseHandler = createDeferred<RuntimeToolResult>();
    const plan = {
      phases: [
        {
          id: 'p-source',
          name: '源码查询',
          goal: '调用工具获取源码证据',
          expectedTools: ['lookup_app_source'],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '不要记录被取消后的工具结果',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const spec: SharedToolSpec = {
      name: 'lookup_app_source',
      description: 'Lookup app source',
      exposure: 'public',
      inputSchema: {query: z.string()},
      handler: jest.fn(async () => releaseHandler.promise),
    };
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      runtimeKind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      analysisPlan: { current: plan },
    });
    const controller = new AbortController();
    const updates: unknown[] = [];

    const execution = tool.execute(
      'call-late-source',
      {query: 'find cancelled source'},
      controller.signal,
      update => updates.push(update),
    );
    await Promise.resolve();
    controller.abort(new Error('cancelled after handler started'));
    releaseHandler.resolve({
      content: [{type: 'text', text: 'LATE_TOOL_RESULT_CANARY'}],
    } as RuntimeToolResult);

    const result = await execution;
    expect(result).toMatchObject({
      isError: true,
      content: [{type: 'text', text: expect.stringMatching(/aborted/i)}],
    });
    expect(JSON.stringify(result)).not.toContain('LATE_TOOL_RESULT_CANARY');
    expect(updates).toEqual([
      { type: 'smartperfetto_tool_started', toolCallId: 'call-late-source', toolName: spec.name },
    ]);
    expect(plan.toolCallLog).toEqual([]);
  });

  it('projects private wiki results before recording Pi plan evidence', async () => {
    const plan = {
      phases: [{
        id: 'p-knowledge',
        name: '知识解释',
        goal: '查询 Android 系统知识',
        expectedTools: ['lookup_blog_knowledge'],
        status: 'in_progress',
        summary: '',
      }],
      successCriteria: '完成知识解释',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const spec: SharedToolSpec = {
      name: 'lookup_blog_knowledge',
      description: 'Lookup private Android knowledge',
      exposure: 'public',
      inputSchema: {query: z.string()},
      handler: jest.fn(async () => ({content: [{type: 'text', text: JSON.stringify({
        result: {
          query: 'Handler',
          probed: ['android_internals_wiki'],
          retrievedAt: 1,
          legacyPath: false,
          hits: [{
            chunkId: 'wiki-1',
            score: 1,
            metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
            snippet: 'PI_PLAN_PRIVATE_WIKI_CANARY',
          }],
        },
      })}]} as RuntimeToolResult)),
    };
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      analysisPlan: {current: plan},
    });

    await tool.execute('wiki-call', {query: 'Handler'}, undefined);

    const serialized = JSON.stringify(plan.toolCallLog);
    expect(serialized).not.toContain('PI_PLAN_PRIVATE_WIKI_CANARY');
  });

  it('repairs recoverable Pi submit_plan argument drift before shared tool validation', () => {
    const repaired = repairPiAgentCoreSubmitPlanArgs({
      phases: [
        {
          id: 'p1',
          name: '架构确认 + 概览采集',
          goal: '确认渲染架构并采集滑动帧概览',
          expectedTools: ['invoke_skill'],
        },
        { id: 'p2' },
      ],
      goal: '对主要掉帧根因类型进行机制级深钻',
      expectedTools: ['invoke_skill', 'fetch_artifact'],
      expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
      waivers: [{ aspectId: 'unsupported', reason: 'trace 不包含该场景所需的可验证事件，因此本轮无法覆盖。' }],
    });

    expect(repaired).toEqual({
      phases: [
        {
          id: 'p1',
          name: '架构确认 + 概览采集',
          goal: '确认渲染架构并采集滑动帧概览',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        },
        {
          id: 'p2',
          name: 'p2',
          goal: '对主要掉帧根因类型进行机制级深钻',
          expectedTools: ['invoke_skill', 'fetch_artifact'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
        },
      ],
      successCriteria: '对主要掉帧根因类型进行机制级深钻',
      waivers: [{ aspectId: 'unsupported', reason: 'trace 不包含该场景所需的可验证事件，因此本轮无法覆盖。' }],
    });
    expect(repaired).not.toHaveProperty('goal');
  });

  it('fails closed when a shared tool is not request-allowed', () => {
    expect(() => createPiAgentCoreToolFromSharedSpec(createSharedSpec(), {
      allowedToolNames: new Set(['other_tool']),
    })).toThrow('Pi agent-core tool is not allowed in this request: query_trace');
  });

  it('describes the public Pi agent-core runtime as provider-pinnable but capability-limited', () => {
    expect(getPiAgentCoreEngineCapabilities('pi-agent-core')).toEqual({
      kind: 'pi-agent-core',
      displayName: 'Pi Agent Core',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
      draftAnswerStreaming: false,
    });
  });

  it('projects Pi agent-core events without synthesizing route terminal events', () => {
    const updates = [
      projectPiAgentCoreEventToStreamingUpdate({ type: 'agent_start' }, 1),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', text: 'hello' },
      }, 2),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'tool_execution_start',
        toolName: 'query_trace',
        toolCallId: 'call-1',
        args: { sql: 'select 1' },
      }, 3),
      projectPiAgentCoreEventToStreamingUpdate({
        type: 'tool_execution_end',
        toolName: 'query_trace',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'ok' }] },
      }, 4),
      projectPiAgentCoreEventToStreamingUpdate({ type: 'agent_end' }, 4),
    ].filter(Boolean) as StreamingUpdate[];

    expect(updates.map((update) => update.type)).toEqual([
      'progress',
      'agent_task_dispatched',
      'agent_response',
      'progress',
    ]);
    expect(updates.map((update) => update.type)).not.toContain('analysis_completed');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
    expect(updates.map((update) => update.type)).not.toContain('thought');
    expect(updates.map((update) => update.type)).not.toContain('tool_call');
    expect(updates[1].content).toMatchObject({
      taskId: 'call-1',
      toolName: 'query_trace',
      args: { sql: 'select 1' },
    });
    expect(updates[2].content).toMatchObject({
      taskId: 'call-1',
      result: 'ok',
    });
  });

  it('projects recoverable Pi tool failures as agent responses instead of top-level SSE errors', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end',
      toolName: 'compare_skill',
      toolCallId: 'call-invalid-args',
      isError: true,
      result: {
        content: [{ type: 'text', text: 'Validation failed: currentParams must be string' }],
      },
    });

    expect(update).toEqual(expect.objectContaining({
      type: 'agent_response',
      content: expect.objectContaining({
        taskId: 'call-invalid-args',
        toolName: 'compare_skill',
        toolCallId: 'call-invalid-args',
        isError: true,
        recoverable: true,
        result: 'Validation failed: currentParams must be string',
      }),
    }));
  });

  it('keeps Pi message-level assistant failures as top-level SSE errors', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'provider request failed',
      },
    });

    expect(update).toEqual(expect.objectContaining({
      type: 'error',
      content: expect.objectContaining({
        message: 'provider request failed',
      }),
    }));
  });

  it.each([false, true])('retains private source outcomes before transport truncation (body=%s)', includeBody => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end', toolName: 'search_codebase', toolCallId: 'source-outcome',
      result: {success: true, matches: Array.from({length: 20}, (_, i) => ({
        referenceId: `source-reference-${i}`, codebaseId: 'codebase-a',
        filePath: `src/PRIVATE_SOURCE_PATH_${i}.kt`, lineRange: {start: 1, end: 20},
        ...(includeBody ? {text: 'PRIVATE_SOURCE_BODY'} : {}),
      }))},
    })!;
    expect(() => JSON.parse(update.content.result)).toThrow();
    expect(update.content.privateToolResultReceipt).toBeDefined();
    const projected = projectCodeAwareStreamingUpdate('pi-source-outcome', update, true, 'en');
    expect(projected).toMatchObject({content: {resultNarration: includeBody
      ? 'Authorized content was read and is available to check against trace evidence'
      : 'Candidate source or knowledge locations are available; their content has not been read'}});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
  });

  it.each([false, true])('retains private source failures across both Pi response branches (event error=%s)', isError => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end', toolName: 'read_codebase_file', toolCallId: 'source-failure',
      isError, result: {success: false, error: 'PRIVATE_SOURCE_FAILURE'},
    })!;
    expect(update.content.privateToolResultReceipt).toBeDefined();
    const projected = projectCodeAwareStreamingUpdate('pi-source-failure', update, true, 'en');
    expect(projected).toMatchObject({content: {
      resultNarration: 'This tool call did not complete; collected evidence is retained', isError: true,
    }});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
  });

  it('projects private wiki results before emitting Pi agent responses', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end',
      toolName: 'lookup_blog_knowledge',
      toolCallId: 'wiki-call',
      result: {content: [{type: 'text', text: JSON.stringify({result: {
        query: 'Handler',
        probed: ['android_internals_wiki'],
        retrievedAt: 1,
        legacyPath: false,
        hits: [{
          chunkId: 'wiki-1',
          score: 1,
          metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
          snippet: 'PI_PRIVATE_WIKI_CANARY',
        }],
      }})}]},
    });

    const serialized = JSON.stringify(update);
    expect(serialized).not.toContain('PI_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('never emits raw private wiki partial tool updates', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_update',
      toolName: 'lookup_blog_knowledge',
      toolCallId: 'wiki-call',
      partialResult: 'PI_PRIVATE_WIKI_PARTIAL_CANARY',
    });

    expect(JSON.stringify(update)).not.toContain('PI_PRIVATE_WIKI_PARTIAL_CANARY');
    expect(update).toEqual(expect.objectContaining({
      type: 'progress',
      content: expect.objectContaining({
        update: expect.objectContaining({
          outcome: 'rejected',
          toolName: 'lookup_blog_knowledge',
        }),
      }),
    }));
  });

  it('filters Pi message deltas so tool args and reasoning are not logged as visible text', () => {
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        text: 'Let me inspect the trace.',
      },
    })).toBeUndefined();
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        text: '{"sql":"SELECT * FROM slice"}',
      },
    })).toBeUndefined();
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        partial: {
          role: 'assistant',
          content: [{ type: 'text', text: 'cumulative partial' }],
        },
      },
    })).toBeUndefined();
  });

  it('projects Pi assistant execution errors from terminal SDK messages', () => {
    expect(projectPiAgentCoreEventToStreamingUpdate({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'No API provider registered for api: openai-compatible',
      },
      toolResults: [],
    }, 7)).toEqual({
      type: 'error',
      content: {
        module: 'pi-agent-core',
        message: 'No API provider registered for api: openai-compatible',
      },
      timestamp: 7,
    });
  });

  it('runs a hidden smoke analysis with an injected Pi agent-core module', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND, source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    await expect(runtime.analyze('analyze startup', 'session-pi', 'trace-pi')).resolves.toMatchObject({
      sessionId: 'session-pi',
      success: true,
      conclusion: 'Pi smoke final',
      claimSupport: [],
      claimVerificationResult: {
        status: 'not_checked',
        checkedClaimCount: 0,
        unsupportedClaimCount: 0,
      },
      identityResolutions: [],
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(updates.map((update) => update.type)).toEqual([
      'progress',
      'progress',
      'progress',
    ]);
    expect(updates.map((update) => update.type)).not.toContain('analysis_completed');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
  });

  it('runs a public Pi smoke analysis with public-preview termination metadata', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await expect(runtime.analyze('analyze startup', 'session-pi', 'trace-pi')).resolves.toMatchObject({
      sessionId: 'session-pi',
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
      terminationMessage: 'Pi agent-core runtime completed through the capability-limited public preview path.',
    });
  });

  // The same options carry the run's own learning grant, under which
  // execute_sql learns fixes.
  it('gives the shared MCP tools the vendor hint from its own options, and the run grant', async () => {
    const runtime = typedRuntime();
    const mcp = jest.spyOn(claudeMcpModule, 'createClaudeMcpServer');
    let runtimeOptions: Parameters<typeof createClaudeMcpServer>[0];
    try {
      await runtime.analyze('分析启动性能', 'session-pi-vendor-hint', 'trace-pi',
        withDurableLearningPermission({analysisMode: 'full' as const, runId: 'run-pi-mcp'}, NO_PRIVATE_CONTEXT));
      runtimeOptions = mcp.mock.calls[0][0];
    } finally {
      mcp.mockRestore();
    }
    expect(admitLearnedEntry(runtimeOptions.durableLearning, 1)?.runId).toBe('run-pi-mcp');
    await expectRuntimeVendorHintParity({
      createMcpServer: createClaudeMcpServer, runtimeOptions});
  });

  it('builds a real Pi analysis context from shared SmartPerfetto prompt and tools', async () => {
    const providerRuntimeLoader = jest.fn(loadFakePiProviderRuntime);
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader,
      },
    );
    runtime.restoreArchitectureCache('trace-pi', {
      type: 'WEBVIEW',
      confidence: 0.67,
      evidence: [],
    });
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const result = await withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', 'session-pi-real', 'trace-pi', {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    );
    const agent = FakePiAgent.instances[0];
    const toolNames = agent.state.tools.map((tool: any) => tool.name);
    const receipt = runtimePerformanceRecorder.seal();

    expect(toolNames).toEqual(expect.arrayContaining([
      'execute_sql',
      'invoke_skill',
      'lookup_sql_schema',
      'submit_plan',
      'update_plan_phase',
      'submit_hypothesis',
      'resolve_hypothesis',
    ]));
    expect(agent.state.systemPrompt.length).toBeGreaterThan(500);
    expect(agent.prompts[0]).toContain('分析启动性能');
    expect(JSON.stringify(agent.state.model)).not.toContain('sk-pi-test-secret');
    expect((agent.state.model as any).apiKey).toBeUndefined();
    expect(typeof agent.options?.streamFn).toBe('function');
    expect(agent.options?.getApiKey).toBeUndefined();
    expect(result).toMatchObject({
      sessionId: 'session-pi-real',
      success: true,
      completion: expect.objectContaining({status: 'completed'}),
    });
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.claimSupport).toBeUndefined();
    expect(result.identityResolutions).toBeUndefined();
    expect(receipt.firstOutputMs).toEqual(expect.any(Number));
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
    expect(receipt.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'provider', outcome: 'ok'}),
      expect.objectContaining({name: 'finalization', outcome: 'ok'}),
    ]));
    expect(updates.map((update) => update.type)).toContain('architecture_detected');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
  });

  it('prefetches admitted cross-session experience for a private run as for a public one', async () => {
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', scope: 'scene_wide',
      recommendedComplexity: 'full', deliverable: 'report'};
    const patterns = jest.spyOn(analysisPatternMemory, 'buildPatternContextSection').mockReturnValue('PATTERN_MEMORY_SECTION');
    const negative = jest.spyOn(analysisPatternMemory, 'buildNegativePatternSection').mockReturnValue('NEGATIVE_MEMORY_SECTION');
    const cases = jest.spyOn(caseBackgroundContext, 'buildCaseBackgroundContext').mockReturnValue('CASE_BACKGROUND_SECTION');
    const buildPrompt = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: jest.fn(loadFakePiProviderRuntime),
      },
    );
    try {
      await runtime.analyze('Analyze the scrolling session', 'session-pi-private-experience', 'trace-pi', {
        analysisMode: 'full', codeAwareMode: 'metadata_only', codebaseIds: ['cb-pi-private-experience'],
      });
      expect(patterns).toHaveBeenCalledTimes(1);
      expect(negative).toHaveBeenCalledTimes(1);
      expect(buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
        patternContext: 'PATTERN_MEMORY_SECTION', negativePatternContext: 'NEGATIVE_MEMORY_SECTION',
        caseBackgroundContext: 'CASE_BACKGROUND_SECTION'}));
    } finally {
      patterns.mockRestore(); negative.mockRestore(); cases.mockRestore(); buildPrompt.mockRestore();
      sessionContextManager.remove('session-pi-private-experience');
    }
  });

  it('passes the active code-aware mode and selected codebases into the Pi quick prompt', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: jest.fn(loadFakePiProviderRuntime),
      },
    );

    const result = await runtime.analyze('快速结合源码定位候选机制', 'session-pi-source-quick', 'trace-pi', {
      analysisMode: 'fast',
      assistantSurface: 'conversation',
      conversationTraceAttached: true,
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-pi-quick'],
    });

    const agent = FakePiAgent.instances[FakePiAgent.instances.length - 1]!;
    expect(agent.state.systemPrompt).toContain('cb-pi-quick');
    expect(agent.state.systemPrompt).toContain('provider_send');
    expect(agent.state.systemPrompt).toContain('源码使用决策契约');
    expect(result).toMatchObject({
      success: true,
      partial: undefined,
      terminationReason: undefined,
      sourceUseDecision: expect.objectContaining({status: 'pending'}),
    });
  });

  it('returns real MCP source refs and does not carry the accessor into a later source-off run', async () => {
    const sessionId = 'session-pi-source-finalization';
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId,
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: jest.fn(loadFakePiProviderRuntime),
      },
    );
    const originalPrepare = (runtime as any).prepareAnalysis.bind(runtime);
    jest.spyOn(runtime as any, 'prepareAnalysis').mockImplementation(async (...args: unknown[]) => {
      const prepared = await originalPrepare(...args);
      return args[0] === 'source terminal run'
        ? {...prepared, sourceUse: fixture.sourceUse}
        : prepared;
    });
    FakePiAgent.promptHandler = (_agent, input) => [{
      role: 'assistant',
      content: [{
        type: 'text',
        text: input.includes('source terminal run')
          ? SOURCE_FINALIZATION_RAW_SOURCE
          : 'public second run',
      }],
    }];
    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const terminal = await runtime.analyze('source terminal run', sessionId, 'trace-pi', {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });
      const context = takeFinalizationContext(terminal)!;
      try {
        expect(context.getNativeDeclaration(terminal, new AbortController().signal)?.raw).toBe(SOURCE_FINALIZATION_RAW_SOURCE);
        expect(JSON.stringify(terminal)).not.toContain('conclusion_protocol_projection');
      } finally {context.dispose();}
      const next = await runtime.analyze('public second run', sessionId, 'trace-pi', {
        analysisMode: 'fast',
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

  it('preserves the real MCP source decision on request timeout', async () => {
    const sessionId = 'session-pi-source-timeout';
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId,
    });
    const never = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => never.promise;
    FakePiAgent.abortHandler = () => {
      never.resolve([{
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'Pi request timeout aborted the provider.',
        content: [{type: 'text', text: ''}],
      }]);
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '25',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '250',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: jest.fn(loadFakePiProviderRuntime),
      },
    );
    const originalPrepare = (runtime as any).prepareAnalysis.bind(runtime);
    jest.spyOn(runtime as any, 'prepareAnalysis').mockImplementation(async (...args: unknown[]) => {
      const prepared = await originalPrepare(...args);
      return {...prepared, sourceUse: fixture.sourceUse};
    });
    try {
      const {decision} = await fixture.executeProviderSourceLookup();

      const result = await runtime.analyze('source timeout run', sessionId, 'trace-pi', {
        analysisMode: 'full',
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });

      expect(result).toMatchObject({
        success: false,
        terminationReason: 'timeout',
        sourceUseDecision: decision,
        sourceReferences: decision.references,
      });
    } finally {
      fixture.cleanup();
      sessionContextManager.remove(sessionId);
    }
  });

  it('records Pi finalization exactly once on provider execution error', async () => {
    FakePiAgent.promptHandler = async () => {
      throw new Error('pi provider failed');
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.restoreArchitectureCache('trace-pi', {
      type: 'WEBVIEW',
      confidence: 0.67,
      evidence: [],
    });
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    await expect(withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('分析启动性能', 'session-pi-error', 'trace-pi', {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    )).rejects.toThrow('pi provider failed');

    const receipt = runtimePerformanceRecorder.seal();
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
    expect(receipt.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'provider', outcome: 'error'}),
    ]));
  });

  it('reuses one provider/Models runtime across turns and replaces it after reset', async () => {
    const providerRuntimeLoader = jest.fn(loadFakePiProviderRuntime);
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader,
      },
    );

    await runtime.analyze('first', 'session-provider-state', 'trace-pi', {analysisMode: 'fast'});
    await runtime.analyze('second', 'session-provider-state', 'trace-pi', {analysisMode: 'fast'});
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);

    runtime.reset();
    await runtime.analyze('after reset', 'session-provider-state', 'trace-pi', {analysisMode: 'fast'});
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(2);
  });

  it('shares pending Pi SDK and provider loads for concurrent first use of the same model fingerprint', async () => {
    FakePiAgent.promptHandler = async (_agent, input) => [{
      role: 'assistant',
      content: [{type: 'text', text: `Pi completed ${input}`}],
    }];
    const moduleLoad = createDeferred<{Agent: typeof FakePiAgent}>();
    const providerLoad = createDeferred<Awaited<ReturnType<typeof loadFakePiProviderRuntime>>>();
    const moduleLoader = jest.fn(async () => moduleLoad.promise);
    const providerRuntimeLoader = jest.fn(async (
      config: {model: Record<string, unknown>},
    ) => {
      expect(config.model.id).toBe('pi-test-model');
      return providerLoad.promise;
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7',
        },
        moduleLoader,
        providerRuntimeLoader,
      },
    );

    const first = runtime.analyze('first', 'session-pi-cache-a', 'trace-pi', {analysisMode: 'fast'});
    const second = runtime.analyze('second', 'session-pi-cache-b', 'trace-pi', {analysisMode: 'fast'});
    await Promise.resolve();

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
    providerLoad.resolve(await loadFakePiProviderRuntime({model: JSON.parse(PI_TEST_MODEL_JSON)}));
    await waitUntil(() => moduleLoader.mock.calls.length === 1);
    moduleLoad.resolve({Agent: FakePiAgent});

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({success: true, conclusion: expect.stringContaining('first')}),
      expect.objectContaining({success: true, conclusion: expect.stringContaining('second')}),
    ]);
  });

  it('resolves the pinned provider and semantic intent before main Pi SDK preparation', async () => {
    const moduleLoad = createDeferred<{Agent: typeof FakePiAgent}>();
    const moduleLoader = jest.fn(async () => moduleLoad.promise);
    const providerRuntimeLoader = jest.fn(loadFakePiProviderRuntime);
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader,
        providerRuntimeLoader,
      },
    );

    const pending = runtime.analyze('serial prep', 'session-pi-serial-prep', 'trace-pi', {
      analysisMode: 'fast',
    });
    await waitUntil(() => moduleLoader.mock.calls.length === 1);
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
    expect(piClassifierCalls).toHaveLength(1);

    moduleLoad.resolve({Agent: FakePiAgent});
    for (let attempt = 0; attempt < 20 && providerRuntimeLoader.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toMatchObject({success: true});
  });

  it('clears failed Pi provider loads so the next request can retry the same fingerprint', async () => {
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi retry completed'}],
    }];
    let providerLoadAttempts = 0;
    const providerRuntimeLoader = jest.fn(async (config: {model: Record<string, unknown>}) => {
      providerLoadAttempts += 1;
      if (providerLoadAttempts === 1) {
        throw new Error('provider module temporarily unavailable');
      }
      return loadFakePiProviderRuntime(config);
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader,
      },
    );

    await expect(runtime.analyze('first', 'session-pi-provider-retry', 'trace-pi', {
      analysisMode: 'fast',
    })).rejects.toThrow('provider module temporarily unavailable');
    await expect(runtime.analyze('second', 'session-pi-provider-retry', 'trace-pi', {
      analysisMode: 'fast',
    })).resolves.toMatchObject({
      success: true,
      conclusion: 'Pi retry completed',
    });
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(2);
  });

  it('preserves complete provider-facing Pi tool text and original details', async () => {
    const longText = `${'frame evidence '.repeat(400)}TAIL_CANARY_FULL_DETAILS_ONLY`;
    const completeResult = {
      content: [{type: 'text', text: longText}],
      artifactId: 'artifact-long-tool',
      evidenceRef: 'Evidence:data:skill:long_tool:test',
      details: {
        rows: [{frameId: 59665219, note: longText}],
      },
    } as RuntimeToolResult;
    const tool = createPiAgentCoreToolFromSharedSpec(createSharedSpec(async () => completeResult), {
      allowedToolNames: new Set(['query_trace']),
    });

    const projected = await tool.execute('call-long-tool', {sql: 'select long'}, undefined);

    expect(projected.details).toBe(completeResult);
    expect(projected.content).toEqual([{type: 'text', text: longText}]);
    expect(JSON.stringify(projected.details)).toContain('TAIL_CANARY_FULL_DETAILS_ONLY');
  });

  it('preserves producer receipt, payload and error state in provider content and Pi details', async () => {
    const original = createRuntimeToolResult({success: false, planPhaseId: 'p1', error: 'x'.repeat(14000)}, {
      decorate: text => '[accuracy] {"success":true}\n' + text,
      isError: true,
    });
    const tool = createPiAgentCoreToolFromSharedSpec(createSharedSpec(async () => original), {
      allowedToolNames: new Set(['query_trace']),
    });
    const result = await tool.execute('receipt-pi', {sql: 'select 1'}, undefined);
    expect(JSON.parse(result.content[0].text)).toEqual({_meta: original._meta, content: original.content, isError: true});
    expect(readRuntimeToolResultFacts(result.content[0].text)).toEqual({success: false, planPhaseId: 'p1'});
    expect(result.details).toBe(original);
    expect(result.isError).toBe(true);
    expect(readRuntimeToolResultFacts(result)).toEqual({success: false, planPhaseId: 'p1'});
    const event = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end', toolName: 'query_trace', toolCallId: 'receipt-pi', result,
    } as PiAgentCoreEvent);
    expect(event).toMatchObject({type: 'agent_response', content: {isError: true}});
  });

  it('preserves every Pi text block in the shared serialization order', async () => {
    const firstBlock = 'A'.repeat(1980);
    const laterCanary = 'LATER_BLOCK_PROVIDER_CANARY';
    const completeResult = {
      content: [
        {type: 'text', text: firstBlock},
        {type: 'text', text: `second block ${laterCanary}`},
      ],
      details: {
        rows: [
          {part: 1, payload: firstBlock},
          {part: 2, payload: laterCanary},
        ],
      },
    } as RuntimeToolResult;
    const tool = createPiAgentCoreToolFromSharedSpec(createSharedSpec(async () => completeResult), {
      allowedToolNames: new Set(['query_trace']),
    });

    const projected = await tool.execute('call-multi-block-tool', {sql: 'select long'}, undefined);
    const providerText = projected.content.map(block => block.text).join('\n');

    expect(providerText).toBe(`${firstBlock}\nsecond block ${laterCanary}`);
    expect(JSON.stringify(projected.details)).toContain(laterCanary);
  });

  it.each(['read_codebase_file', 'search_codebase', 'lookup_app_source'] as const)
    ('delivers complete %s JSON with source body and tail references through the Pi adapter', async toolName => {
      const sourceBody = `object Source {\n${'  val value = "source evidence"\n'.repeat(100)}}`;
      const sourceReferences = Array.from({length: 20}, (_, index) => ({
        id: `source-reference-${index}`, referenceId: `source-reference-${index}`,
        codebaseId: 'source-app', filePath: `src/Source${index}.kt`,
        lineRange: {start: 1, end: 102}, lookupKind: toolName === 'lookup_app_source' ? 'indexed' : 'body',
      }));
      const reference = {referenceId: sourceReferences[0].id, codebaseId: 'source-app',
        filePath: sourceReferences[0].filePath, lineRange: {start: 1, end: 102}, text: sourceBody};
      const payload = toolName === 'lookup_app_source'
        ? {success: true, result: {hits: [{chunk: {snippet: sourceBody}}], sourceReferences}}
        : {success: true, ...(toolName === 'read_codebase_file' ? {reference} : {matches: [reference]}), sourceReferences};
      const json = JSON.stringify(payload);
      expect(json.length).toBeGreaterThan(4000);
      const original = {content: [{type: 'text', text: json}]} as RuntimeToolResult;
      const spec = {...createSharedSpec(async () => original), name: toolName};
      const tool = createPiAgentCoreToolFromSharedSpec(spec, {allowedToolNames: new Set([toolName])});
      const result = await tool.execute(`source-${toolName}`, {}, undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(payload);
      expect(result.content[0].text).toContain('source evidence');
      expect(result.content[0].text).toContain(sourceReferences[sourceReferences.length - 1].id);
      expect(result.details).toBe(original);
    });

  it('delivers metadata-only source results without inventing a body', async () => {
    const payload = {success: true, codeAwareMode: 'metadata_only',
      matches: [{referenceId: 'metadata-reference', codebaseId: 'source-app', filePath: 'src/Source.kt'}],
      sourceReferences: [{id: 'metadata-reference', codebaseId: 'source-app', filePath: 'src/Source.kt', lookupKind: 'metadata'}]};
    const original = {content: [{type: 'text', text: JSON.stringify(payload)}]} as RuntimeToolResult;
    const tool = createPiAgentCoreToolFromSharedSpec({...createSharedSpec(async () => original), name: 'search_codebase'}, {
      allowedToolNames: new Set(['search_codebase']),
    });
    const result = await tool.execute('metadata-source', {}, undefined);
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
    expect(JSON.parse(result.content[0].text).matches[0].text).toBeUndefined();
  });

  it('serializes non-text Pi blocks as JSON instead of coercing them to object labels', async () => {
    const block = {type: 'resource', resource: {uri: 'test://resource', text: 'Resource evidence'}};
    const original = {content: [{type: 'text', text: 'Explanation'}, block]} as RuntimeToolResult;
    const tool = createPiAgentCoreToolFromSharedSpec(createSharedSpec(async () => original), {allowedToolNames: new Set(['query_trace'])});
    const result = await tool.execute('non-text-result', {}, undefined);
    expect(result.content[0].text).toBe(`Explanation\n${JSON.stringify(block)}`);
    expect(result.details).toBe(original);
  });


  it('rejects an unparsable model JSON by position, never quoting it: it can hold an API key', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        // Unquoted, so the parser would quote the key around it.
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: '{"provider":"openai","apiKey":sk-PI-CANARY-3d9}'},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    await expect(runtime.analyze('question', 'session-pi-model-json', 'trace-pi', {analysisMode: 'fast'}))
      .rejects.toThrow(new RegExp(`^${PI_AGENT_CORE_MODEL_JSON_ENV} must be valid JSON: Pi model JSON is not valid JSON$`));
  });
  it('clears failed Pi SDK module loads so the next request can retry the same fingerprint', async () => {
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi module retry completed'}],
    }];
    let moduleLoadAttempts = 0;
    const moduleLoader = jest.fn(async () => {
      moduleLoadAttempts += 1;
      if (moduleLoadAttempts === 1) {
        throw new Error('pi module temporarily unavailable');
      }
      return {Agent: FakePiAgent};
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader,
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await expect(runtime.analyze('first', 'session-pi-module-retry', 'trace-pi', {
      analysisMode: 'fast',
    })).rejects.toThrow('pi module temporarily unavailable');
    await expect(runtime.analyze('second', 'session-pi-module-retry', 'trace-pi', {
      analysisMode: 'fast',
    })).resolves.toMatchObject({
      success: true,
      conclusion: 'Pi module retry completed',
    });
    expect(moduleLoader).toHaveBeenCalledTimes(2);
  });

  it('isolates Pi module and provider cache entries by hashed fingerprints without exposing raw credentials', async () => {
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi fingerprint completed'}],
    }];
    const secret = 'sk-provider-secret-canary';
    const modelJson = JSON.stringify({
      ...JSON.parse(PI_TEST_MODEL_JSON),
      apiKey: undefined,
      apiKeyEnv: 'PI_TEST_SECRET_ENV',
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: modelJson,
          [PI_AGENT_CORE_MODULE_PATH_ENV]: '/tmp/pi-module-fingerprint-canary',
          PI_TEST_SECRET_ENV: secret,
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await runtime.analyze('first', 'session-pi-cache-fingerprint', 'trace-pi', {
      analysisMode: 'fast',
    });

    const moduleKeys = [...((runtime as any).moduleRuntimeCache as Map<string, unknown>).keys()];
    const providerKeys = [...((runtime as any).providerRuntimeCache as Map<string, unknown>).keys()];
    expect(moduleKeys).toHaveLength(1);
    expect(providerKeys).toHaveLength(1);
    for (const key of [...moduleKeys, ...providerKeys]) {
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(key).not.toContain(secret);
      expect(key).not.toContain('pi-module-fingerprint-canary');
    }
  });

  it('does not let pending Pi cache loads repopulate after reset', async () => {
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi after reset completed'}],
    }];
    const firstModuleLoad = createDeferred<{Agent: typeof FakePiAgent}>();
    let moduleLoadAttempts = 0;
    const moduleLoader = jest.fn(async () => {
      moduleLoadAttempts += 1;
      return moduleLoadAttempts === 1
        ? firstModuleLoad.promise
        : {Agent: FakePiAgent};
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader,
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const first = runtime.analyze('first', 'session-pi-pending-reset', 'trace-pi', {
      analysisMode: 'fast',
    });
    await waitUntil(() => moduleLoader.mock.calls.length === 1);
    runtime.reset();
    firstModuleLoad.resolve({Agent: FakePiAgent});
    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });

    await expect(runtime.analyze('second', 'session-pi-pending-reset', 'trace-pi', {
      analysisMode: 'fast',
    })).resolves.toMatchObject({
      success: true,
      conclusion: 'Pi after reset completed',
    });
    expect(moduleLoader).toHaveBeenCalledTimes(2);
  });

  it('does not let pending Pi provider cache loads repopulate after reset', async () => {
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi provider after reset completed'}],
    }];
    const firstProviderLoad = createDeferred<Awaited<ReturnType<typeof loadFakePiProviderRuntime>>>();
    let providerLoadAttempts = 0;
    const providerRuntimeLoader = jest.fn(async (config: {model: Record<string, unknown>}) => {
      providerLoadAttempts += 1;
      return providerLoadAttempts === 1
        ? firstProviderLoad.promise
        : loadFakePiProviderRuntime(config);
    });
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader,
      },
    );

    const first = runtime.analyze('first', 'session-pi-provider-pending-reset', 'trace-pi', {
      analysisMode: 'fast',
    });
    await Promise.resolve();
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
    runtime.reset();
    firstProviderLoad.resolve(await loadFakePiProviderRuntime({model: JSON.parse(PI_TEST_MODEL_JSON)}));
    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });

    await expect(runtime.analyze('second', 'session-pi-provider-pending-reset', 'trace-pi', {
      analysisMode: 'fast',
    })).resolves.toMatchObject({
      success: true,
      conclusion: 'Pi provider after reset completed',
    });
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(2);
  });

  it('loads distinct Pi provider fingerprints independently and keeps cache identity exact', async () => {
    const providerRuntimeLoader = jest.fn(loadFakePiProviderRuntime);
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader,
      },
    );
    const parsedModel = JSON.parse(PI_TEST_MODEL_JSON);
    const firstConfig = {
      model: parsedModel,
      apiKey: 'redacted-test-key-a',
    };
    const secondConfig = {
      ...firstConfig,
      model: {
        ...parsedModel,
        id: 'pi-test-model-b',
      },
      apiKey: 'redacted-test-key-b',
    };

    const firstLoad = (runtime as any).getProviderRuntime(firstConfig);
    const firstLoadAgain = (runtime as any).getProviderRuntime(firstConfig);
    const secondLoad = (runtime as any).getProviderRuntime(secondConfig);

    expect(firstLoadAgain).toBe(firstLoad);
    expect(secondLoad).not.toBe(firstLoad);
    await Promise.all([firstLoad, secondLoad]);
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(2);
    const providerCache = (runtime as any).providerRuntimeCache as Map<string, unknown>;
    expect(providerCache.size).toBe(2);
    expect([...providerCache.values()]).toEqual(expect.arrayContaining([firstLoad, secondLoad]));
  });

  it('selects native Pi parallel by admitted scheduler and preserves per-tool sequential descriptors', () => {
    const makeSpec = (
      name: string,
      concurrency?: SharedToolSpec['concurrency'],
    ): SharedToolSpec => ({
      name,
      description: `${name} tool`,
      exposure: 'public',
      inputSchema: {},
      ...(concurrency ? {concurrency} : {}),
      handler: async () => ({content: [{type: 'text', text: `${name} ok`}]} as RuntimeToolResult),
    });
    const safeSpecs = [
      makeSpec('lookup_sql_schema', {mode: 'commutative_read'}),
      makeSpec('list_stdlib_modules', {mode: 'commutative_read'}),
    ];
    const mixedSpecs = [
      makeSpec('lookup_sql_schema', {mode: 'commutative_read'}),
      makeSpec('execute_sql'),
    ];
    const safeTools = safeSpecs.map(spec => createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set(safeSpecs.map(item => item.name)),
    }));
    const mixedTools = mixedSpecs.map(spec => createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set(mixedSpecs.map(item => item.name)),
    }));
    const resolveMode = (piAgentCoreRuntimeModule as any).resolvePiAgentCoreNativeToolExecutionMode;

    expect(resolveMode).toEqual(expect.any(Function));
    const admittedEnv = {SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7'};
    expect(resolveMode({quickMode: true, tools: safeTools})).toBe('sequential');
    expect(resolveMode({quickMode: true, tools: safeTools, env: admittedEnv})).toBe('parallel');
    expect(resolveMode({quickMode: true, tools: mixedTools, env: admittedEnv})).toBe('parallel');
    expect(resolveMode({quickMode: false, tools: safeTools})).toBe('sequential');
    expect(resolveMode({quickMode: false, tools: safeTools, env: admittedEnv})).toBe('parallel');
    expect(safeTools.map(tool => tool.executionMode)).toEqual(['parallel', 'parallel']);
    expect(mixedTools.map(tool => tool.executionMode)).toEqual(['parallel', 'sequential']);
  });

  it('uses per-tool concurrency metadata independently of the selected Pi budget', async () => {
    FakePiAgent.promptHandler = async (agent) => [{
      role: 'assistant',
      content: [{
        type: 'text',
        text: `Pi ${agent.options?.toolExecution === 'parallel' ? 'quick' : 'full'} mode completed`,
      }],
    }];
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task7',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await runtime.analyze('这个 trace 的应用包名是什么？', 'session-pi-actual-quick-mode', 'trace-pi', {
      analysisMode: 'fast',
    });
    await runtime.analyze('分析系统性能问题', 'session-pi-actual-full-mode', 'trace-pi', {
      analysisMode: 'full',
    });

    expect(FakePiAgent.instances[0].options?.toolExecution).toBe('parallel');
    const quickToolModes = (FakePiAgent.instances[0].state.tools as Array<{name: string; executionMode?: string}>)
      .map(tool => [tool.name, tool.executionMode]);
    expect(quickToolModes).toEqual(expect.arrayContaining([
      ['lookup_sql_schema', 'parallel'],
      ['execute_sql', 'sequential'],
      ['invoke_skill', 'sequential'],
    ]));
    expect(FakePiAgent.instances[1].options?.toolExecution).toBe('parallel');
    const fullToolModes = (FakePiAgent.instances[1].state.tools as Array<{name: string; executionMode?: string}>)
      .map(tool => [tool.name, tool.executionMode]);
    expect(fullToolModes).toEqual(expect.arrayContaining([
      ['lookup_sql_schema', 'parallel'],
      ['execute_sql', 'sequential'],
      ['invoke_skill', 'sequential'],
    ]));
  });

  it('returns one timeout result and no session turn when Pi hangs before provider output', async () => {
    const sessionId = 'session-pi-request-timeout';
    const traceId = 'trace-pi';
    const never = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => never.promise;
    FakePiAgent.abortHandler = () => {
      never.resolve([{
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'Pi request timeout aborted the provider.',
        content: [{type: 'text', text: ''}],
      }]);
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '25',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '250',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const analysis = runtime.analyze('first', sessionId, traceId, {analysisMode: 'fast'});

    await expect(Promise.race([
      analysis,
      rejectAfter(250, () => runtime.abortSession(sessionId)),
    ])).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
      conclusion: expect.stringContaining('timeout'),
    });
    expect(FakePiAgent.instances[0].aborted).toBe(true);
    const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
    expect(turns).toHaveLength(0);
    sessionContextManager.remove(sessionId);
  });

  it('uses Pi provider idle timeout without treating agent_start as model output', async () => {
    const sessionId = 'session-pi-idle-timeout';
    const traceId = 'trace-pi';
    const never = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => never.promise;
    FakePiAgent.abortHandler = () => {
      never.resolve([{
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'Pi provider idle timeout aborted the provider.',
        content: [{type: 'text', text: ''}],
      }]);
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '5000',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '25',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.restoreArchitectureCache(traceId, {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });

    const analysis = runtime.analyze('first', sessionId, traceId, {analysisMode: 'full'});

    await expect(Promise.race([
      analysis,
      rejectAfter(2000, () => runtime.abortSession(sessionId)),
    ])).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
      terminationMessage: expect.stringContaining('idle'),
    });
    expect(FakePiAgent.instances[0].aborted).toBe(true);
    sessionContextManager.remove(sessionId);
  });

  it('classifies Pi provider activity separately from first visible output', () => {
    const isProviderActivity =
      (piAgentCoreRuntimeModule as any).isPiAgentCoreProviderActivityEvent;
    const isVisibleOutput =
      (piAgentCoreRuntimeModule as any).isPiAgentCoreVisibleOutputEvent;

    expect(isProviderActivity).toEqual(expect.any(Function));
    expect(isVisibleOutput).toEqual(expect.any(Function));
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'text_delta', delta: 'streamed delta'},
    })).toBe(true);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'text_delta', delta: 'streamed delta'},
    })).toBe(true);
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'thinking_delta', delta: 'thinking delta'},
    })).toBe(true);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'thinking_delta', delta: 'thinking delta'},
    })).toBe(true);
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'toolcall_delta', delta: '{"sql":"select 1"}'},
    })).toBe(true);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'toolcall_delta', delta: '{"sql":"select 1"}'},
    })).toBe(false);
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'custom_delta', delta: 'not a Pi provider event'},
    })).toBe(false);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'custom_delta', delta: 'not visible output'},
    })).toBe(false);
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'text_delta', text: 'legacy text delta'},
    })).toBe(true);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'text_delta', text: 'legacy text delta'},
    })).toBe(true);
    expect(isProviderActivity({
      type: 'message_update',
      assistantMessageEvent: {type: 'tool_json_delta', delta: '   '},
    })).toBe(false);
    expect(isVisibleOutput({
      type: 'message_update',
      assistantMessageEvent: {type: 'tool_json_delta', delta: '   '},
    })).toBe(false);
  });

  it('treats Pi text and thinking deltas as first visible output but not toolcall deltas', async () => withProviderActivityTimingFixture(async () => {
    const sessionId = 'session-pi-toolcall-activity-output';
    const traceId = 'trace-pi';
    FakePiAgent.promptHandler = async (agent) => {
      await delay(15);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'toolcall_delta', delta: '{"sql":"select 1"}'},
      });
      await delay(15);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'toolcall_delta', delta: '{"sql":"select 2"}'},
      });
      await delay(30);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'thinking_delta', delta: 'visible reasoning'},
      });
      return [{
        role: 'assistant',
        content: [{type: 'text', text: 'Pi toolcall activity completed'}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '35',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    const result = await withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('first', sessionId, traceId, {
        analysisMode: 'fast',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    );
    const receipt = runtimePerformanceRecorder.seal();

    expect(result).toMatchObject({
      success: true,
      conclusion: 'Pi toolcall activity completed',
    });
    expect(FakePiAgent.instances[0].aborted).toBe(false);
    expect(receipt.firstOutputMs).toEqual(expect.any(Number));
    expect(receipt.firstOutputMs!).toBeGreaterThanOrEqual(45);
    sessionContextManager.remove(sessionId);
  }));

  it('treats Pi text delta message_update events as real provider activity', async () => withProviderActivityTimingFixture(async () => {
    const sessionId = 'session-pi-delta-output';
    const traceId = 'trace-pi';
    FakePiAgent.promptHandler = async (agent) => {
      await delay(20);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'text_delta', delta: 'streamed delta 1'},
      });
      await delay(20);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'text_delta', delta: 'streamed delta 2'},
      });
      return [{
        role: 'assistant',
        content: [{type: 'text', text: 'Pi delta completed'}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();

    const result = await withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze('first', sessionId, traceId, {
        analysisMode: 'fast',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      }),
    );

    expect(result).toMatchObject({
      success: true,
      conclusion: 'Pi delta completed',
    });
    expect(FakePiAgent.instances[0].aborted).toBe(false);
    expect(runtimePerformanceRecorder.seal().firstOutputMs).toEqual(expect.any(Number));
    sessionContextManager.remove(sessionId);
  }));

  it('pauses Pi provider idle timeout during tools and resumes on repeated delta output', async () => withProviderActivityTimingFixture(async () => {
    const sessionId = 'session-pi-idle-tool-pause';
    const traceId = 'trace-pi';
    const updates: StreamingUpdate[] = [];
    FakePiAgent.promptHandler = async (agent) => {
      agent.emitForTest({
        type: 'tool_execution_start',
        toolName: 'lookup_sql_schema',
        toolCallId: 'tool-paused',
      });
      await delay(55);
      agent.emitForTest({
        type: 'tool_execution_end',
        toolName: 'lookup_sql_schema',
        toolCallId: 'tool-paused',
        result: {content: [{type: 'text', text: 'schema ready'}]},
      });
      await delay(18);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'text_delta', delta: 'delta after tool'},
      });
      await delay(18);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'text_delta', delta: 'delta keeps alive'},
      });
      await delay(18);
      return [{
        role: 'assistant',
        content: [{type: 'text', text: 'Pi tool pause completed'}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze('first', sessionId, traceId, {analysisMode: 'fast'});
    await delay(45);

    expect(result).toMatchObject({
      success: true,
      conclusion: 'Pi tool pause completed',
    });
    expect(FakePiAgent.instances[0].aborted).toBe(false);
    expect(updates.map(update => update.type)).not.toContain('error');
    sessionContextManager.remove(sessionId);
  }));

  it('pauses Pi provider idle between prompt calls and re-arms it for correction prompts', async () => withProviderActivityTimingFixture(async () => {
    const sessionId = 'session-pi-idle-between-prompts';
    const traceId = 'trace-pi-idle-between-prompts';
    const verificationIssue = {
      type: 'missing_evidence',
      severity: 'error',
      message: '报告缺少证据支撑，需要修正。',
      recoveryKind: 'correct_evidence',
    };
    const initialReport = declaredPiCandidate(buildUnverifiedPiReport());
    const correctedReport = declaredPiCandidate(buildVerifiedPiReport());
    mockClaudeVerifierVerifyConclusion
      .mockImplementationOnce(async () => {
        await delay(60);
        return {
          passed: false,
          heuristicIssues: [verificationIssue],
          llmIssues: [],
          durationMs: 60,
        };
      })
      .mockImplementation(async () => ({
        passed: true,
        heuristicIssues: [],
        llmIssues: [],
        durationMs: 1,
      }));
    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        await submitCompletedMinimalPlan(agent);
        return [{
          role: 'assistant',
          content: [{type: 'text', text: initialReport}],
        }];
      }
      expect(agent.state.tools).toEqual([]);
      await delay(10);
      agent.emitForTest({
        type: 'message_update',
        assistantMessageEvent: {type: 'text_delta', delta: 'correction prompt alive'},
      });
      return [{
        role: 'assistant',
        content: [{type: 'text', text: correctedReport}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '25',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '分析系统性能问题',
      sessionId,
      traceId,
      {analysisMode: 'full'},
    );
    await delay(40);

    const agent = FakePiAgent.instances[0];
    expect(agent.promptCount).toBe(2);
    expect(agent.aborted).toBe(false);
    expect(result.success).toBe(true);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(buildVerifiedPiReport());
    expect(result.terminationReason).toBeUndefined();
    expect(updates.map(update => update.type)).not.toContain('error');
    sessionContextManager.remove(sessionId);
  }));

  it('keeps same-session ownership until abort cleanup settles and suppresses late Pi events', async () => {
    const sessionId = 'session-pi-abort-join';
    const traceId = 'trace-pi';
    const releasePrompt = createDeferred<unknown[]>();
    const updates: StreamingUpdate[] = [];
    FakePiAgent.promptHandler = async () => releasePrompt.promise;
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '25',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '80',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.on('update', update => updates.push(update));

    const first = runtime.analyze('first', sessionId, traceId, {analysisMode: 'fast'});
    await delay(40);
    let secondError: Error | undefined;
    const second = runtime.analyze('second', sessionId, traceId, {analysisMode: 'fast'})
      .catch((error: Error) => {
        secondError = error;
      });

    try {
      await Promise.resolve();
      expect(secondError).toBeDefined();
      expect(secondError!.message).toMatch(/already in progress/i);
      const firstResult = await Promise.race([
        first,
        rejectAfter(500, () => runtime.abortSession(sessionId)),
      ]);
      expect(firstResult).toMatchObject({
        success: false,
        terminationReason: 'timeout',
      });
      releasePrompt.resolve([{
        role: 'assistant',
        content: [{type: 'text', text: 'LATE_ABORT_IGNORING_PROVIDER_TEXT'}],
      }]);
      await second;
      await delay(25);
      expect(JSON.stringify(updates)).not.toContain('LATE_ABORT_IGNORING_PROVIDER_TEXT');
      const snapshot = runtime.takeSnapshot(sessionId, traceId, createSnapshotFields());
      expect(snapshot.engineState?.kind === 'pi-agent-core'
        ? snapshot.engineState.pi.opaque
        : undefined).toBeUndefined();
    } finally {
      releasePrompt.resolve([{
        role: 'assistant',
        content: [{type: 'text', text: 'cleanup'}],
      }]);
      runtime.cleanupSession(sessionId);
      sessionContextManager.remove(sessionId);
    }
  });

  it('keeps same-session ownership across repeated attempts until abort-ignored prompt settles', async () => {
    const sessionId = 'session-pi-abort-repeated-overlap';
    const traceId = 'trace-pi';
    const releasePrompt = createDeferred<unknown[]>();
    const updates: StreamingUpdate[] = [];
    FakePiAgent.promptHandler = async () => releasePrompt.promise;
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '25',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.on('update', update => updates.push(update));

    const first = runtime.analyze('first', sessionId, traceId, {analysisMode: 'fast'});
    await delay(80);
    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });

    const firstAgent = FakePiAgent.instances[0];
    firstAgent.emitForTest({
      type: 'message_update',
      assistantMessageEvent: {type: 'text_delta', delta: 'LATE_MESSAGE_CANARY'},
    });
    firstAgent.emitForTest({
      type: 'tool_execution_start',
      toolName: 'execute_sql',
      toolCallId: 'late-tool',
      args: {sql: 'select 1'},
    });
    firstAgent.emitForTest({
      type: 'tool_execution_end',
      toolName: 'execute_sql',
      toolCallId: 'late-tool',
      result: {content: [{type: 'text', text: 'LATE_TOOL_CANARY'}]},
    });
    firstAgent.emitForTest({
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'LATE_ERROR_CANARY',
      },
    });

    await expect(runtime.analyze('second', sessionId, traceId, {
      analysisMode: 'fast',
    })).rejects.toThrow(/already in progress/i);
    await expect(runtime.analyze('third', sessionId, traceId, {
      analysisMode: 'fast',
    })).rejects.toThrow(/already in progress/i);
    expect(JSON.stringify(updates)).not.toContain('LATE_MESSAGE_CANARY');
    expect(JSON.stringify(updates)).not.toContain('LATE_TOOL_CANARY');
    expect(JSON.stringify(updates)).not.toContain('LATE_ERROR_CANARY');
    const postAbortSnapshot = runtime.takeSnapshot(sessionId, traceId, createSnapshotFields());
    expect(postAbortSnapshot.engineState?.kind === 'pi-agent-core'
      ? postAbortSnapshot.engineState.pi.opaque
      : undefined).toBeUndefined();

    releasePrompt.resolve([{
      role: 'assistant',
      content: [{type: 'text', text: 'late cleanup'}],
    }]);
    await waitUntil(() => FakePiAgent.instances.length === 1);
    await delay(20);
    FakePiAgent.promptHandler = undefined;
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi after cleanup completed'}],
    }];
    await expect(runtime.analyze('fourth', sessionId, traceId, {
      analysisMode: 'fast',
    })).resolves.toMatchObject({
      success: true,
      conclusion: 'Pi after cleanup completed',
    });
    sessionContextManager.remove(sessionId);
  });

  it('keeps same-session ownership after timeout returns until pending Pi startup cleanup settles', async () => {
    const sessionId = 'session-pi-deferred-startup-cleanup';
    const traceId = 'trace-pi';
    const moduleLoad = createDeferred<{Agent: typeof FakePiAgent}>();
    const moduleLoader = jest.fn(async () => moduleLoad.promise);
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1',
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '20',
          [PI_AGENT_CORE_STREAM_IDLE_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader,
      },
    );

    const first = runtime.analyze('first', sessionId, traceId, {analysisMode: 'fast'});
    await delay(60);
    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });
    await expect(runtime.analyze('second', sessionId, traceId, {
      analysisMode: 'fast',
    })).rejects.toThrow(/already in progress/i);

    moduleLoad.resolve({Agent: FakePiAgent});
    await delay(20);
    await expect(runtime.analyze('third', sessionId, traceId, {
      analysisMode: 'fast',
    })).resolves.toMatchObject({success: true});
    expect(moduleLoader).toHaveBeenCalledTimes(1);
  });

  it('cancels during focus preflight without architecture events or Pi provider start', async () => {
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report'};
    const sessionId = 'session-pi-cancel-focus-preflight';
    const traceId = 'trace-pi-focus-cancel';
    const focusQuery = createDeferred<{columns: string[]; rows: unknown[][]; durationMs: number}>();
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementationOnce(async () => focusQuery.promise);
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.restoreArchitectureCache(traceId, {
      type: 'WEBVIEW',
      confidence: 0.9,
      evidence: [],
    });
    const updates: StreamingUpdate[] = [];
    runtime.on('update', update => updates.push(update));

    const first = runtime.analyze('分析系统性能问题', sessionId, traceId, {analysisMode: 'full'});
    await waitUntil(() => traceProcessorService.query.mock.calls.length === 1);
    runtime.abortSession(sessionId);
    focusQuery.resolve({
      columns: ['package_name', 'total_duration_ns', 'switch_count'],
      rows: [['com.example.focus', 100_000_000, 1]],
      durationMs: 1,
    });

    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });
    expect(FakePiAgent.instances).toHaveLength(0);
    expect(updates.map(update => update.type)).not.toContain('architecture_detected');
    expect(runtime.getSessionNotes(sessionId)).toEqual([]);
    expect(runtime.getSessionPlan(sessionId)).toBeNull();
    expect(runtime.getSessionUncertaintyFlags(sessionId)).toEqual([]);
    const postAbortSnapshot = runtime.takeSnapshot(sessionId, traceId, createSnapshotFields());
    expect(postAbortSnapshot.engineState?.kind === 'pi-agent-core'
      ? postAbortSnapshot.engineState.pi.opaque
      : undefined).toBeUndefined();
    sessionContextManager.remove(sessionId);
  });

  it('cancels during architecture preflight before cache/event/session state mutation', async () => {
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report'};
    const sessionId = 'session-pi-cancel-architecture-preflight';
    const traceId = 'trace-pi-architecture-cancel';
    const architectureQuery = createDeferred<{columns: string[]; rows: unknown[][]; durationMs: number}>();
    const traceProcessorService = createFakeTraceProcessorService();
    let queryCount = 0;
    traceProcessorService.query.mockImplementation(async () => {
      queryCount += 1;
      if (queryCount === 1) {
        return {
          columns: ['package_name', 'total_duration_ns', 'switch_count'],
          rows: [['com.example.arch', 100_000_000, 1]],
          durationMs: 1,
        };
      }
      if (queryCount === 2) return architectureQuery.promise;
      return {columns: [], rows: [], durationMs: 1};
    });
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
          [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
          [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '30',
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', update => updates.push(update));

    const first = runtime.analyze('分析系统性能问题', sessionId, traceId, {analysisMode: 'full'});
    await waitUntil(() => traceProcessorService.query.mock.calls.length >= 2, 1000);
    runtime.abortSession(sessionId);
    architectureQuery.resolve({columns: [], rows: [], durationMs: 1});

    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
    });
    expect(FakePiAgent.instances).toHaveLength(0);
    expect(runtime.getCachedArchitecture(traceId)).toBeUndefined();
    expect(updates.map(update => update.type)).not.toContain('architecture_detected');
    expect(runtime.getSessionNotes(sessionId)).toEqual([]);
    expect(runtime.getSessionPlan(sessionId)).toBeNull();
    expect(runtime.getSessionUncertaintyFlags(sessionId)).toEqual([]);
    const postAbortSnapshot = runtime.takeSnapshot(sessionId, traceId, createSnapshotFields());
    expect(postAbortSnapshot.engineState?.kind === 'pi-agent-core'
      ? postAbortSnapshot.engineState.pi.opaque
      : undefined).toBeUndefined();
    sessionContextManager.remove(sessionId);
  });

  it('rejects same-session direct overlap before Pi provider work starts', async () => {
    const releasePrompt = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => releasePrompt.promise;
    const moduleLoader = jest.fn(async () => ({ Agent: FakePiAgent }));
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader,
      },
    );

    const first = runtime.analyze('first', 'session-pi-overlap', 'trace-pi', {
      runId: 'run-1',
      referenceTraceId: 'ref-1',
    });
    await Promise.resolve();
    const second = runtime.analyze('second', 'session-pi-overlap', 'trace-pi', {
      runId: 'run-2',
      referenceTraceId: 'ref-2',
    });

    releasePrompt.resolve([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Pi overlap first completed' }],
    }]);
    await expect(second).rejects.toThrow(/already in progress/i);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(moduleLoader).toHaveBeenCalledTimes(1);
  });

  it('allows different Pi sessions to run independently even with matching trace input', async () => {
    FakePiAgent.promptHandler = async (_agent, input) => [{
      role: 'assistant',
      content: [{
        type: 'text',
        text: `Pi isolated completed for ${String(input).includes('second') ? 'second' : 'first'}`,
      }],
    }];
    const moduleLoader = jest.fn(async () => ({ Agent: FakePiAgent }));
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_FAKE_STREAM_ENV]: '1' },
        moduleLoader,
      },
    );

    await expect(Promise.all([
      runtime.analyze('first', 'session-pi-isolated-1', 'trace-pi', {
        runId: 'run-1',
        referenceTraceId: 'ref-1',
      }),
      runtime.analyze('second', 'session-pi-isolated-2', 'trace-pi', {
        runId: 'run-2',
        referenceTraceId: 'ref-2',
      }),
    ])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(moduleLoader).toHaveBeenCalledTimes(1);
    expect(FakePiAgent.instances).toHaveLength(2);
  });

  it('does not publish a Pi turn or correction when cancelled during final verification', async () => {
    const sessionId = 'session-pi-verification-cancel';
    const traceId = 'trace-pi';
    const verificationStarted = createDeferred<void>();
    const releaseVerification = createDeferred<void>();
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => {
      verificationStarted.resolve();
      await releaseVerification.promise;
      return {
        passed: true,
        heuristicIssues: [],
        llmIssues: [],
        durationMs: 1,
      };
    });
    FakePiAgent.promptHandler = async (agent) => {
      await submitCompletedMinimalPlan(agent);
      return [{
        role: 'assistant',
        content: [{type: 'text', text: buildVerifiedPiReport()}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const analysis = withEffectiveRuntimeRegistrySnapshot(
      createEffectiveRuntimeRegistrySnapshot(),
      () => runtime.analyze(
        '分析系统性能问题',
        sessionId,
        traceId,
        {
          analysisMode: 'full',
          runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
        },
      ),
    );
    await verificationStarted.promise;
    runtime.abortSession(sessionId);
    releaseVerification.resolve();

    await expect(analysis).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
      conclusion: expect.stringMatching(/aborted|cancelled/i),
    });
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    const turns = sessionContextManager.getOrCreate(sessionId, traceId).getAllTurns?.() ?? [];
    expect(turns).toHaveLength(0);
    const receipt = runtimePerformanceRecorder.seal();
    const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
    expect(finalizationPhases).toHaveLength(1);
    expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'cancelled'}));
    sessionContextManager.remove(sessionId);
  });

  it('keeps Pi reset from releasing live runtime ownership before settle', async () => {
    const traceId = 'trace-pi';
    const releasePrompt = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => releasePrompt.promise;
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_FAKE_STREAM_ENV]: '1'},
        moduleLoader: async () => ({Agent: FakePiAgent}),
      },
    );

    const first = runtime.analyze('first', 'session-pi-reset-live', traceId, {
      analysisMode: 'fast',
    });
    await Promise.resolve();
    runtime.reset();
    const second = runtime.analyze('second', 'session-pi-reset-live', traceId, {
      analysisMode: 'fast',
    });

    releasePrompt.resolve([{
      role: 'assistant',
      content: [{type: 'text', text: 'Pi reset ownership first completed'}],
    }]);
    await expect(second).rejects.toThrow(/already in progress|aborted|cancelled/i);
    await expect(first).resolves.toMatchObject({
      success: false,
      terminationReason: 'timeout',
      conclusion: expect.stringMatching(/aborted|cancelled|cleared/i),
    });
  });

  it('bounds the Pi architecture cache with shared LRU semantics', () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {env: {[PI_AGENT_CORE_FAKE_STREAM_ENV]: '1'}},
    );
    for (let index = 0; index < 51; index += 1) {
      runtime.restoreArchitectureCache(`trace-${index}`, {
        type: 'STANDARD',
        confidence: 1,
        evidence: [],
      });
    }

    expect(runtime.getCachedArchitecture('trace-0')).toBeUndefined();
    expect(runtime.getCachedArchitecture('trace-50')).toBeDefined();
    runtime.reset();
    expect(runtime.getCachedArchitecture('trace-50')).toBeUndefined();
  });

  it('injects dual-trace pane mapping into the Pi comparison system prompt', async () => {
    piClassifierDecision = {...piClassifierDecision, taskKind: 'comparison'};
    const traceProcessorService = createFakeTraceProcessorService();
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
        },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await runtime.analyze('对比左右 Trace 的启动速度差异', 'session-pi-compare', 'trace-current', {
      analysisMode: 'full',
      packageName: 'com.example',
      referenceTraceId: 'trace-reference',
      tracePairContext: {
        schemaVersion: 1,
        layout: 'horizontal',
        primarySide: 'left',
        referenceSide: 'right',
        workspaceOpen: true,
        panes: [
          {
            side: 'left',
            traceSide: 'current',
            traceId: 'trace-current',
            traceName: 'Current Trace',
            visualState: 'live',
          },
          {
            side: 'right',
            traceSide: 'reference',
            traceId: 'trace-reference',
            traceName: 'Reference Trace',
            visualState: 'live',
          },
        ],
      },
    });

    const agent = FakePiAgent.instances[0];
    const blocks = agent.state.systemPrompt.split('\n').flatMap(line => {
      try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [value as {context?: string; data?: unknown}] : [];
      } catch { return []; }
    });
    expect(blocks.find(block => block.context === 'comparison_identity')?.data).toEqual({
      referenceTraceId: 'trace-reference', capabilityProbeStatus: 'not_checked',
      tracePairContext: {schemaVersion: 1, layout: 'horizontal', primarySide: 'left', referenceSide: 'right', panes: [
        {side: 'left', traceSide: 'current', traceId: 'trace-current', visualState: 'live'},
        {side: 'right', traceSide: 'reference', traceId: 'trace-reference', visualState: 'live'},
      ]},
    });
    expect(blocks.find(block => block.context === 'comparison_details')?.data).toMatchObject({
      commonCapabilities: [], traceNames: [
        {traceSide: 'current', traceName: 'Current Trace'}, {traceSide: 'reference', traceName: 'Reference Trace'},
      ], workspaceOpen: true,
    });
  });

  it('inherits logical history without replaying Pi opaque transcripts on follow-up', async () => {
    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First Pi answer' }],
      },
    ];
    const firstRuntime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    await firstRuntime.analyze('first question', 'session-pi-resume', 'trace-pi', {
      analysisMode: 'fast',
    });
    const snapshot = firstRuntime.takeSnapshot(
      'session-pi-resume',
      'trace-pi',
      createSnapshotFields(),
    );

    expect(snapshot.engineState?.kind).toBe('pi-agent-core');
    const piOpaque = snapshot.engineState?.kind === 'pi-agent-core'
      ? snapshot.engineState.pi.opaque
      : undefined;
    expect(piOpaque?.messages).toEqual([
      {
        role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text', text: 'First Pi answer' }],
      },
    ]);

    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second Pi answer' }],
      },
    ];
    const secondRuntime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    secondRuntime.restoreFromSnapshot('session-pi-resume', 'trace-pi', snapshot);

    await secondRuntime.analyze('follow-up question', 'session-pi-resume', 'trace-pi', {
      analysisMode: 'fast',
    });

    const restoredAgent = FakePiAgent.instances[1];
    expect(restoredAgent.options).toMatchObject({
      initialState: expect.objectContaining({
        messages: [],
      }),
    });
    expect(restoredAgent.prompts[0]).toContain('follow-up question');
    expect(restoredAgent.prompts[0]).toContain('first question');
    expect(restoredAgent.prompts[0]).toContain('First Pi answer');
    expect(restoredAgent.state.messages).toEqual([
      {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Second Pi answer'}]},
    ]);
  });

  it('never reuses a previous-turn Pi report as the current conclusion', async () => {
    const previousReport = [
      '## Final Conclusion',
      'Previous-turn root cause report that must remain context only.',
      '## Key Evidence Chain',
      'Previous trace evidence.',
    ].join('\n');
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
        },
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: previousReport}],
    }];
    await runtime.analyze('first question', 'session-pi-current-turn-boundary', 'trace-pi', {
      analysisMode: 'fast',
    });

    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'Current-turn answer only.'}],
    }];
    const current = await runtime.analyze(
      'follow-up question',
      'session-pi-current-turn-boundary',
      'trace-pi',
      {analysisMode: 'fast'},
    );

    expect(current.conclusion).toBe('Current-turn answer only.');
    expect(current.conclusion).not.toContain('Previous-turn root cause');
  });

  it('never reuses or retains opaque Pi transcripts across private analysis boundaries', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'PUBLIC_TRANSCRIPT_BEFORE_PRIVATE'}],
    }];
    await runtime.analyze('public', 'session-private-boundary', 'trace-pi', {
      analysisMode: 'fast',
    });

    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'PRIVATE_SOURCE_CANARY'}],
    }];
    await runtime.analyze('private', 'session-private-boundary', 'trace-pi', {
      analysisMode: 'full',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['private-codebase'],
    });
    expect((FakePiAgent.instances[1].options?.initialState as any).messages).toEqual([]);

    const privateSnapshot = runtime.takeSnapshot(
      'session-private-boundary',
      'trace-pi',
      {
        ...createSnapshotFields(),
        codeAwareMode: 'metadata_only',
        codebaseIds: ['private-codebase'],
      },
    );
    expect(privateSnapshot.engineState?.kind).toBe('pi-agent-core');
    expect(privateSnapshot.engineState?.kind === 'pi-agent-core'
      ? privateSnapshot.engineState.pi.opaque
      : undefined).toBeUndefined();

    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'PUBLIC_AFTER_REVOKE'}],
    }];
    await runtime.analyze('public after revoke', 'session-private-boundary', 'trace-pi', {
      analysisMode: 'fast',
    });
    expect((FakePiAgent.instances[2].options?.initialState as any).messages).toEqual([]);
    expect(JSON.stringify(FakePiAgent.instances[2].options)).not.toContain('PRIVATE_SOURCE_CANARY');

    runtime.cleanupSession('session-private-boundary');
    const cleanupSnapshot = runtime.takeSnapshot(
      'session-private-boundary',
      'trace-pi',
      createSnapshotFields(),
    );
    expect(cleanupSnapshot.engineState?.kind === 'pi-agent-core'
      ? cleanupSnapshot.engineState.pi.opaque
      : undefined).toBeUndefined();
  });

  it('keeps Pi quick mode on shared core tools without preview verification metadata', async () => {
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: {
          [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
        },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const result = await runtime.analyze('这个 trace 的应用包名是什么？', 'session-pi-quick', 'trace-pi', {
      analysisMode: 'fast',
    });
    const agent = FakePiAgent.instances[0];
    const toolNames = agent.state.tools.map((tool: any) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'execute_sql',
      'invoke_skill',
      'lookup_sql_schema',
    ]));
    expect(toolNames).toContain('submit_plan');
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.terminationReason).toBeUndefined();
  });

  it('selects the current terminal assistant without preferring an older report-shaped message', () => {
    const correctedReport = buildScrollingPiReport(true);
    const initialReport = [
      buildScrollingPiReport(false),
      '',
      '## 扩展边界说明',
      ...Array.from({length: 20}, (_, index) => (
        `- 初稿边界 ${index + 1}：本段仅用于记录已排除的外推范围，不替代代表帧证据。`
      )),
    ].join('\n');
    expect(initialReport.length).toBeGreaterThan(correctedReport.length);

    expect(selectAssistantConclusion([
      {role: 'assistant', content: [{type: 'text', text: initialReport}]},
      {role: 'assistant', content: [{type: 'text', text: correctedReport}]},
      {role: 'assistant', content: [{type: 'text', text: 'All phases are complete.'}]},
    ])).toBe('All phases are complete.');
  });

  it('does not treat a completed Pi phase as closed when required tool evidence is missing', () => {
    const plan = {
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'completed',
          summary: '已完成代表帧根因分析，并整理出主线程阻塞调用栈证据。',
        },
      ],
      successCriteria: '完整解释代表掉帧根因',
      submittedAt: 1,
      toolCallLog: [],
    } as any;

    const status = getPiAgentCorePlanCompletionStatus(plan);

    expect(status.complete).toBe(false);
    expect(status.pendingPhases.map(phase => phase.id)).toEqual(['p-frame-detail']);
    expect(status.evidenceGaps?.[0].missingExpectedCalls).toEqual([
      { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
    ]);
  });


  function typedRuntime(input: {trace?: any; env?: Record<string, string>; loader?: any} = {}) {
    return new PiAgentCoreRuntime(input.trace ?? createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'}, {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON, ...input.env},
        moduleLoader: input.loader ?? (async () => ({Agent: FakePiAgent})),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      });
  }

  it('scene runtime matrix: runs the pinned Pi provider through shared proposal and private seal', async () => {
    const f = createSceneRuntimeMatrixFixture('pi');
    const runtime = typedRuntime({trace: f.traceProcessorService});
    let sceneTool: any;
    let response: unknown;
    FakePiAgent.promptHandler = async agent => {
      expect(agent.state.model).toMatchObject({id: 'pi-test-model'});
      const availableTool = agent.state.tools.find((item: any) => item.name === 'propose_scene_timeline');
      if (availableTool) {
        sceneTool = availableTool;
        response = await sceneTool.execute('scene-call', f.proposal());
      }
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Scene candidates submitted.'}]}];
    };
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(result.turnIntent).toMatchObject({source: 'product', sceneId: 'scene_reconstruction'});
      expect(piClassifierCalls).toHaveLength(0);
      expect(JSON.stringify(response)).toContain('accepted');
      const snapshot = f.seal();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.runId).toBe(f.scope.runId);
      expect(snapshot.segments[0].evidence[0].source.originRunId).toBe(f.scope.runId);
      expect(f.boundsQueries).toEqual([f.scope.traceId]);
      f.controller.abort();
      const late = await sceneTool.execute('late-scene-call', f.proposal()).catch((error: Error) => ({error: error.message}));
      expect(JSON.stringify(late)).not.toContain('"accepted":true');
    } finally {runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
    expect((runtime as any).artifactStores.has(f.scope.sessionId)).toBe(false);
  });

  function passVerification() {
    mockClaudeVerifierVerifyConclusion.mockImplementation(async () => ({
      passed: true, heuristicIssues: [], llmIssues: [], durationMs: 0,
    }));
  }

  it.each([false, true])('keeps pending exploration advisory after native completion or failure: failed=%s', async nativeError => {
    const body = 'The observed value is 17.';
    const failedNext = {role: 'assistant', stopReason: 'error', errorMessage: 'Queued provider failure', content: []};
    const replies: unknown[] = [{role: 'assistant', stopReason: nativeError ? 'error' : 'stop',
      ...(nativeError ? {errorMessage: 'Native provider failure'} : {}), content: [{type: 'text', text: body}]}, failedNext];
    FakePiAgent.promptHandler = async (agent, _input, index) => {
      if (index === 1) {
        const submitPlan = agent.state.tools.find((tool: any) => tool.name === 'submit_plan') as any;
        await submitPlan.execute('exploration-plan', {phases: [{id: 'explore', name: 'Optional exploration',
          goal: 'Investigate a further explanation', expectedTools: ['execute_sql']}], successCriteria: 'Explore the open question'});
        const submitHypothesis = agent.state.tools.find((tool: any) => tool.name === 'submit_hypothesis') as any;
        await submitHypothesis.execute('exploration-hypothesis', {id: 'open-hypothesis', statement: 'A separate cause may exist.'});
      }
      return [replies.shift()];
    };
    const runtime = typedRuntime();
    const sessionId = `typed-pi-advisory-${nativeError}`;
    const result = await runtime.analyze('Read the current value', sessionId, 'trace-pi', {runId: sessionId});
    expect(FakePiAgent.instances[0].promptCount).toBe(nativeError ? 1 : 2);
    expect(replies).toEqual(nativeError ? [failedNext] : []);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: nativeError ? 'failed' : 'completed', attemptId: '1',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
    expect(result.success).toBe(!nativeError);
    expect(result.partial === true).toBe(nativeError);
    expect(result.terminationReason).toBe(nativeError ? 'execution_error' : undefined);
    const verification = await mockClaudeVerifierVerifyConclusion.mock.results[0].value;
    expect(verification).toMatchObject({heuristicIssues: expect.arrayContaining([
      expect.objectContaining({type: 'plan_deviation', severity: 'error'}),
      expect.objectContaining({type: 'unresolved_hypothesis', severity: 'error'}),
    ])});
    const snapshot = runtime.takeSnapshot(sessionId, 'trace-pi', createSnapshotFields());
    expect(snapshot.analysisPlan?.phases).toEqual([expect.objectContaining({id: 'explore', status: 'pending'})]);
    expect(snapshot.claudeHypotheses).toEqual([expect.objectContaining({id: 'open-hypothesis', status: 'formed'})]);
  });

  it('classifies once through the native pinned provider before any trace query and preserves a full bounded answer', async () => {
    passVerification();
    const trace = createFakeTraceProcessorService();
    const events: string[] = [];
    trace.query.mockImplementation(async () => {
      events.push(piClassifierCalls.length === 0 ? 'before_classification' : 'preflight');
      return {columns: [], rows: []};
    });
    FakePiAgent.promptMessages = [{role: 'assistant', content: [{type: 'text', text: 'A concise observation'}]}];
    const snapshot = createEffectiveRuntimeRegistrySnapshot();
    const buildPrompt = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    try {
      const result = await withEffectiveRuntimeRegistrySnapshot(snapshot, () => typedRuntime({trace}).analyze(
        '无需按标题整理：只解释刚才这个值', 'typed-pi-full-answer', 'trace-pi', {analysisMode: 'full', runId: 'run-bounded'},
      ));
      expect(piClassifierCalls).toHaveLength(1);
      expect(piClassifierCalls[0].context.tools).toEqual([]);
      expect(piClassifierCalls[0].options).toMatchObject({maxRetries: 0, maxTokens: 1024});
      // Nothing is queried before the intent is known; the trace facts a
      // bounded question needs are gathered after it.
      expect(events).not.toContain('before_classification');
      expect(events).toContain('preflight');
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
      expect(buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
        onDemandContext: true, strategyRegistry: snapshot.strategyRegistry,
        turnIntent: expect.objectContaining({scope: 'bounded_question', deliverable: 'answer'}),
      }));
      expect(result).toMatchObject({conclusion: 'A concise observation',
        turnIntent: {status: 'resolved', deliverable: 'answer'},
        completion: {status: 'completed', runId: 'run-bounded', attemptId: '1',
          conclusionFingerprint: analysisDeliveryFingerprint('A concise observation')}});
      expect(result.quickRun).toBeUndefined();
      expect(result.partial).not.toBe(true);
    } finally { buildPrompt.mockRestore(); }
  });

  it('renders an issued focus-app evidence locator that the run store resolves', async () => {
    passVerification();
    FakePiAgent.promptMessages = [{role: 'assistant', content: [{type: 'text', text: 'Focus answer'}]}];
    const focus = jest.spyOn(focusAppDetectorModule, 'detectFocusApps').mockResolvedValue({
      method: 'frame_timeline', confidence: 'medium', primaryApp: 'com.example.pi',
      apps: [{packageName: 'com.example.pi', totalDurationNs: 10, switchCount: 3, score: 30}],
    });
    try {
      const runtime = typedRuntime();
      await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(), () => runtime.analyze(
        '哪个应用在前台', 'typed-pi-focus-evidence', 'trace-pi', {analysisMode: 'full', runId: 'run-pi-focus'}));
      const resolution = await resolveFocusPackageCell((runtime as any).artifactStores.get('typed-pi-focus-evidence'),
        FakePiAgent.instances[0].state.systemPrompt, 'trace-pi', 'run-pi-focus');
      expect(resolution).toMatchObject({status: 'resolved', row: {package_name: 'com.example.pi'}});
    } finally { focus.mockRestore(); }
  });

  it('uses the same pinned healthy main model after an unavailable classifier without memory prefetch', async () => {
    passVerification();
    piClassifierResponses.push(new Error('model_not_found'));
    const trace = createFakeTraceProcessorService();
    const result = await typedRuntime({trace}).analyze('不含路由暗号的问题', 'typed-pi-fallback', 'trace-pi');
    expect(result.turnIntent).toMatchObject({status: 'unavailable', source: 'fallback', scope: 'bounded_question'});
    expect(piClassifierCalls).toHaveLength(1);
    expect(FakePiAgent.instances[0].state.model).toBe(piClassifierCalls[0].model);
    expect((FakePiAgent.instances[0].state.model as any).id).toBe('pi-test-model');
    expect(trace.query).toHaveBeenCalled();
    expect(result.completion?.status).toBe('completed');
  });

  it('preserves fast comparison capabilities and explicit comparison identity without automatic probes', async () => {
    passVerification();
    piClassifierDecision = {...piClassifierDecision, taskKind: 'comparison'};
    const trace = createFakeTraceProcessorService();
    const buildPrompt = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    try {
      const result = await typedRuntime({trace}).analyze('比较已选中的两段', 'typed-pi-fast-comparison', 'trace-current', {
        analysisMode: 'fast', referenceTraceId: 'trace-reference',
      });
      expect(result.quickRun?.requestedMode).toBe('fast');
      expect(buildPrompt).toHaveBeenCalledWith(expect.objectContaining({comparison: expect.objectContaining({
        referenceTraceId: 'trace-reference', capabilityProbeStatus: 'not_checked',
      })}));
      expect(FakePiAgent.instances[0].state.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'execute_sql'}), expect.objectContaining({name: 'submit_plan'}),
      ]));
    } finally { buildPrompt.mockRestore(); }
  });

  it('keeps existing artifacts available while an existing-only intent prevents new trace and source evidence', async () => {
    passVerification();
    piClassifierDecision = {...piClassifierDecision, evidenceAccess: 'existing_only'};
    const trace = createFakeTraceProcessorService();
    const result = await typedRuntime({trace}).analyze('继续解释上一轮证据', 'typed-pi-existing', 'trace-pi', {
      analysisMode: 'full', referenceTraceId: 'trace-ref', codeAwareMode: 'provider_send', codebaseIds: ['selected-source'],
    });
    expect(result.turnIntent?.evidenceAccess).toBe('existing_only');
    expect(trace.query).not.toHaveBeenCalled();
    const names = FakePiAgent.instances[0].state.tools.map((tool: any) => tool.name);
    expect(names).toContain('fetch_artifact');
    expect(names).not.toContain('execute_sql');
    expect(names).not.toContain('query_trace');
    expect(names).not.toContain('source_lookup');
    expect(piClassifierCalls).toHaveLength(1);
  });

  it('lets the model author an acknowledgement instead of using a canned lexical response', async () => {
    passVerification();
    piClassifierDecision = {...piClassifierDecision, taskKind: 'acknowledgement', evidenceAccess: 'existing_only'};
    const trace = createFakeTraceProcessorService();
    FakePiAgent.promptMessages = [{role: 'assistant', content: [{type: 'text', text: 'I will keep that context.'}]}];
    const result = await typedRuntime({trace}).analyze('好的，记住这个边界', 'typed-pi-ack', 'trace-pi');
    expect(result.conclusion).toBe('I will keep that context.');
    expect(result.outputOrigin).toBe('sdk_final');
    expect(result.completion?.status).toBe('completed');
    expect(FakePiAgent.instances).toHaveLength(1);
    expect(trace.query).not.toHaveBeenCalled();
  });

  it('reserves one no-tool closeout using the pinned provider while retaining incomplete status', async () => {
    passVerification();
    const trace = createFakeTraceProcessorService();
    trace.query.mockResolvedValue({columns: ['duration_ms'], rows: [{duration_ms: 23}], durationMs: 1});
    piClassifierResponses.push(
      {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: JSON.stringify(piClassifierDecision)}]},
      {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Observed 23 ms. The cause remains unknown; next ask for the main-thread interval.'}]},
    );
    let dispatched = 0;
    FakePiAgent.promptHandler = async agent => {
      const sql = agent.state.tools.find((tool: any) => tool.name === 'execute_sql') as any;
      await sql.execute('closeout-evidence', {sql: 'SELECT 23 AS duration_ms'});
      while (true) {
        dispatched++;
        const message = {role: 'assistant', stopReason: 'toolUse', content: [{type: 'text', text: `attempt ${dispatched}`} ]};
        agent.emitForTest({type: 'turn_end', message});
        if (await (agent.options?.shouldStopAfterTurn as any)({message})) return [message];
        if (dispatched > 5) throw new Error('native turn guard was not enforced');
      }
    };
    const result = await typedRuntime({trace, env: {AGENT_QUICK_MAX_TURNS: '2'}}).analyze('继续收集', 'typed-pi-cap', 'trace-pi', {analysisMode: 'fast'});
    expect(dispatched).toBe(1);
    expect(result).toMatchObject({conclusion: 'Observed 23 ms. The cause remains unknown; next ask for the main-thread interval.', rounds: 2, partial: true,
      outputOrigin: 'sdk_final',
      terminationReason: 'max_turns', completion: {status: 'incomplete', reason: 'turn_limit', sdkFinishReason: 'stop', attemptId: 'closeout-2'},
      quickRun: {enforcement: 'turn_cap', actualTurns: 2, hardCapTurns: 2}});
    expect(piClassifierCalls).toHaveLength(2);
    expect(piClassifierCalls[1].model).toBe(piClassifierCalls[0].model);
    expect(piClassifierCalls[1].context.tools).toEqual([]);
    expect(piClassifierCalls[1].context.messages[0].content).toContain('attempt 1');
    expect(piClassifierCalls[1].context.messages[0].content).toContain('duration_ms');
    expect(piClassifierCalls[1].context.messages[0].content).toContain('23');
    expect(piClassifierCalls[1].options).toMatchObject({maxRetries: 0});
    expect(piClassifierCalls[1].options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([1, 2])('never exceeds total Pi budget %s when closeout fails or is unavailable', async maxTurns => {
    passVerification();
    piClassifierResponses.push(
      {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: JSON.stringify(piClassifierDecision)}]},
      new Error('closeout provider failure'),
    );
    FakePiAgent.promptHandler = async agent => {
      const message = {role: 'assistant', stopReason: 'toolUse', content: [{type: 'text', text: 'Retained evidence'}]};
      agent.emitForTest({type: 'turn_end', message});
      expect(await (agent.options?.shouldStopAfterTurn as any)({message})).toBe(true);
      return [message];
    };
    const result = await typedRuntime({env: {AGENT_QUICK_MAX_TURNS: String(maxTurns)}})
      .analyze('继续', `typed-pi-closeout-failure-${maxTurns}`, 'trace-pi', {analysisMode: 'fast'});
    expect(result).toMatchObject({conclusion: 'Retained evidence', rounds: maxTurns, partial: true,
      completion: {status: 'incomplete', reason: 'turn_limit', attemptId: '1'}});
    expect(piClassifierCalls).toHaveLength(maxTurns);
  });

  it('applies the selected quick deadline to the whole run and keeps timeout provenance', async () => {
    const pendingPrompt = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => pendingPrompt.promise;
    FakePiAgent.abortHandler = () => pendingPrompt.resolve([]);
    const result = await typedRuntime({env: {
      AGENT_QUICK_MAX_TURNS: '1', AGENT_QUICK_PER_TURN_MS: '100',
      [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '1000',
    }}).analyze('bounded', 'typed-pi-deadline', 'trace-pi', {analysisMode: 'fast'});
    expect(result).toMatchObject({success: false, outputOrigin: 'runtime_fallback',
      turnIntent: {status: 'resolved'}, completion: {status: 'incomplete', reason: 'timeout'}});
    expect(sessionContextManager.getOrCreate('typed-pi-deadline', 'trace-pi').getAllTurns()).toHaveLength(0);
  });

  it('cancels native classification without entering the main SDK or publishing a session turn', async () => {
    const classifier = createDeferred<Record<string, unknown>>();
    let invoked = false;
    const mainLoader = jest.fn(async () => ({Agent: FakePiAgent}));
    const runtime = new PiAgentCoreRuntime(createFakeTraceProcessorService(), {kind: 'pi-agent-core', source: 'env'}, {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON}, moduleLoader: mainLoader,
      providerRuntimeLoader: async config => ({model: config.model as any, models: {} as any,
        streamFn: (() => {invoked = true; return {result: () => classifier.promise};}) as any}),
    });
    const pending = runtime.analyze('question', 'typed-pi-cancel-classification', 'trace-pi');
    await waitUntil(() => invoked);
    runtime.abortSession('typed-pi-cancel-classification');
    const result = await pending;
    expect(result.completion).toMatchObject({status: 'cancelled', reason: 'cancelled'});
    expect(mainLoader).not.toHaveBeenCalled();
    classifier.resolve({stopReason: 'stop', content: [{type: 'text', text: JSON.stringify(piClassifierDecision)}]});
    await delay(1);
    expect(mainLoader).not.toHaveBeenCalled();
    expect(sessionContextManager.getOrCreate('typed-pi-cancel-classification', 'trace-pi').getAllTurns()).toHaveLength(0);
  });

  it('uses terminal stop facts for arbitrary prose, preserves thinking separation, and does not strip a prefix', () => {
    const text = 'I need to explain why provider_error is an ordinary log value\n## Final Report\nnot a completion token';
    expect(sanitizePiAgentCoreConclusionText(text)).toBe(text);
    expect(selectAssistantConclusion([{role: 'assistant', content: [{type: 'thinking', thinking: 'private draft'}]}])).toBe('');
    const candidate = {runId: 'r', attemptId: 'a', candidateRef: 'r:a', conclusionFingerprint: analysisDeliveryFingerprint(text)};
    expect(buildPiAnalysisCompletion({runtimeKind: 'pi-agent-core', candidate,
      assistant: {stopReason: 'stop', content: [{type: 'text', text}]}})).toMatchObject({status: 'completed'});
    expect(buildPiAnalysisCompletion({runtimeKind: 'pi-agent-core', candidate,
      assistant: {stopReason: 'length', content: [{type: 'text', text: '# Complete report.'}]}})).toMatchObject({status: 'incomplete', reason: 'output_limit'});
    expect(buildPiAnalysisCompletion({runtimeKind: 'pi-agent-core', candidate,
      assistant: {content: [{type: 'text', text: '# Complete report.'}]}})).toMatchObject({status: 'unknown'});
  });

  it.each([
    {stopReason: 'aborted', status: 'cancelled', reason: 'cancelled'},
    {stopReason: 'error', status: 'failed', reason: 'provider_error'},
  ])('uses structured $stopReason despite identical error text', ({stopReason, status, reason}) => {
    const candidate = {runId: 'r', attemptId: 'a', candidateRef: 'r:a', conclusionFingerprint: analysisDeliveryFingerprint('')};
    expect(buildPiAnalysisCompletion({runtimeKind: 'pi-agent-core', candidate,
      assistant: {stopReason, errorMessage: 'Request was aborted', content: []},
    })).toMatchObject({status, reason, sdkFinishReason: stopReason});
  });

  const protocolSidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [{rank: 1, statement: 'The marker is present.'}], clusters: [], evidenceChain: [],
    claims: [], uncertainties: [], nextSteps: []} as ConclusionContract);

  it('uses the reserved delivery turn to repair a rejected declaration around the unchanged body', async () => {
    passVerification();
    const body = 'Frame 12 missed its deadline.';
    let completionPrompt = '';
    FakePiAgent.promptHandler = async (_agent, prompt, index) => {
      if (index === 2) completionPrompt = prompt;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text',
        text: candidateWithPopulation(body, index === 1 ? 'everywhere' : 'cited_rows')}]}];
    };
    const result = await typedRuntime().analyze('query', 'pi-invalid-declaration', 'trace-pi', {runId: 'pi-invalid-declaration'});
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(completionPrompt).toContain('invalid_declaration');
    expect(inspectCandidateProtocol(result.conclusion)).toMatchObject({status: 'valid'});
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
  });

  it('uses the reserved no-tools delivery turn to attach declarations to a full multilingual body', async () => {
    passVerification();
    const body = `${'启动阶段保持原始正文。'.repeat(700)}\n${'Full body remains byte-for-byte stable. '.repeat(140)}`.trimEnd();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const repaired = `${body}\n${protocolSidecar}`;
    let completionPrompt = '';
    let originalSystemPrompt = '';
    FakePiAgent.promptHandler = async (agent, prompt, index) => {
      if (index === 1) originalSystemPrompt = agent.state.systemPrompt;
      if (index === 2) {
        completionPrompt = prompt;
        expect(agent.state.tools).toEqual([]);
        expect(agent.state.systemPrompt).toBe(originalSystemPrompt);
        agent.emitForTest({type: 'message_update', assistantMessageEvent: {
          type: 'text_delta', delta: 'DECLARATION_COMPLETION_MUST_STAY_BUFFERED',
        }});
      }
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? body : repaired}]}];
    };
    const runtime = typedRuntime();
    const updates: StreamingUpdate[] = [];
    runtime.on('update', update => updates.push(update));
    const result = await runtime.analyze('query', 'pi-missing-declaration', 'trace-pi', {runId: 'pi-missing-declaration'});
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(completionPrompt).toContain('missing_declaration');
    const candidateLine = completionPrompt.split('\n').find(line => line.startsWith('{"schemaVersion":1,"kind":"original_native_candidate"'));
    expect(JSON.parse(candidateLine ?? '{}')).toEqual({schemaVersion: 1, kind: 'original_native_candidate', body});
    expect(completionPrompt).not.toContain('prior_conclusion_truncated');
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('valid');
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body.trim());
    expect(result.completion).toMatchObject({status: 'completed', attemptId: '2',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
    expect(JSON.stringify(updates)).not.toContain('DECLARATION_COMPLETION_MUST_STAY_BUFFERED');
  });

  it('does not dispatch declaration completion when the original body cannot fit the Pi output cap', async () => {
    passVerification();
    const body = 'x'.repeat(64 * 1024);
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: body}]}];
    const result = await typedRuntime().analyze('query', 'pi-declaration-output-cap', 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', attemptId: '1'});
  });

  it('rejects an unchanged Pi repair when the declaration pushes the candidate over the output cap', async () => {
    passVerification();
    const body = 'x'.repeat(64 * 1024 - 100);
    const repaired = `${body}\n${protocolSidecar}`;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(repaired, 'utf8')).toBeGreaterThan(64 * 1024);
    FakePiAgent.promptHandler = async (_agent, _prompt, index) => [{role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: index === 1 ? body : repaired}]}];
    const result = await typedRuntime().analyze('query', 'pi-declaration-overflow', 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', attemptId: '1'});
  });

  it.each(['sidecar-only', 'invalid-schema'])('repairs native completed %s while preserving the pinned Pi prompt and source protocol', async kind => {
    passVerification();
    const first = kind === 'sidecar-only' ? protocolSidecar : protocolSidecar.replace('"focused_answer"', '"invalid-mode"');
    const complete = `The marker is present.\n${protocolSidecar}`;
    let originalPrompt = '';
    const authorizationChecksAtDispatch: number[] = [];
    FakePiAgent.promptHandler = async (agent, _input, index) => {
      authorizationChecksAtDispatch.push(authorization.mock.calls.length);
      if (index === 1) originalPrompt = agent.state.systemPrompt;
      else {
        expect(agent.state.tools).toEqual([]);
        expect(agent.state.systemPrompt.startsWith(originalPrompt + '\n\n')).toBe(true);
        expect(agent.state.messages).toEqual(expect.arrayContaining([expect.objectContaining({content: [{type: 'text', text: first}]})]));
      }
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? first : complete}]}];
    };
    const runtime = typedRuntime(); const updates: any[] = []; runtime.on('update', update => updates.push(update));
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization');
    try {
      const result = await runtime.analyze('query', `pi-protocol-${kind}`, 'trace-pi', {runId: `pi-protocol-${kind}`});
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
      expect(authorizationChecksAtDispatch[0]).toBeGreaterThan(0);
      expect(authorizationChecksAtDispatch[1]).toBeGreaterThan(authorizationChecksAtDispatch[0]);
      expect(authorization.mock.calls.every(([selection, scope, fingerprint]) => fingerprint ===
        contextAuthorization.buildAnalysisContextAuthorizationFingerprint(selection, scope))).toBe(true);
      expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('The marker is present.');
      expect(result.completion).toMatchObject({status: 'completed', attemptId: '2', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      const context = takeFinalizationContext(result)!;
      try {expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(complete);}
      finally {context.dispose();}
      expect(FakePiAgent.instances[0].state.systemPrompt).toBe(originalPrompt);
      const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
      expect(diagnostic.map(value => [value.stage, value.candidateIndex, value.status])).toEqual([
        ['native', 1, kind === 'sidecar-only' ? 'valid' : 'invalid'], ['native', 2, 'valid'], ['runtime_projected', 2, 'valid'],
      ]);
    } finally { authorization.mockRestore(); }
  });

  it('gives the existing Pi relation correction the shared closed schema without a third call', async () => {
    passVerification();
    const base: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:relation_1',
        kind: 'overlap', direction: 'symmetric', subject: {evidenceRefId: 'evidence-subject'}}]};
    const first = `The marker is present.\n${renderConclusionContractSidecar({...base, relationProposals: [{
      ...base.relationProposals![0], PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY',
    }]} as any)}`;
    const complete = `The marker is present.\n${renderConclusionContractSidecar(base)}`;
    let recoveryPrompt = '';
    FakePiAgent.promptHandler = async (_agent, input, index) => {
      if (index === 2) recoveryPrompt = input;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? first : complete}]}];
    };
    const runtime = typedRuntime(); const updates: any[] = []; runtime.on('update', update => updates.push(update));
    const result = await runtime.analyze('query', 'pi-relation-protocol', 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(recoveryPrompt).toContain('proofBindings');
    expect(recoveryPrompt).toContain('endpointColumn');
    expect(recoveryPrompt).toContain('"reason":"unknown_field"');
    expect(recoveryPrompt.slice(recoveryPrompt.indexOf('{"candidateProtocolDiagnostic"'))).not.toContain('PRIVATE_RELATION_');
    expect(updates.find(update => update.content?.phase === 'candidate_protocol')?.content.candidateProtocolDiagnostic)
      .toMatchObject({relationProposalDiagnostics: [{scope: 'item', ordinal: 1, reason: 'unknown_field'}]});
    const context = takeFinalizationContext(result)!;
    try {expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(complete);}
    finally {context.dispose();}
  });

  it.each(['plain-body', 'sidecar-only', 'invalid-schema'])('retains the first Pi declaration when correction returns %s', async kind => {
    passVerification();
    const first = protocolSidecar.replace('"focused_answer"', '"invalid-mode"');
    const second = kind === 'plain-body' ? 'The marker is present.' : kind === 'sidecar-only' ? protocolSidecar : first;
    FakePiAgent.promptHandler = async (_agent, _input, index) => [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? first : second}]}];
    const result = await typedRuntime().analyze('query', `pi-protocol-rejected-${kind}`, 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    const context = takeFinalizationContext(result)!;
    try {expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(first);}
    finally {context.dispose();}
    expect(result.completion?.attemptId).toBe('1');
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('invalid');
    expect(result.terminationMessage).not.toContain('candidate_protocol_diagnostic@1');
  });

  it('does not retry a Pi candidate invalidated only by the application projection', async () => {
    passVerification();
    const raw = `The marker is present.\n${protocolSidecar}`;
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: raw}]}];
    const realProject = sourceProjectionModule.finalizeOwnerSourceAwareAnalysisResultWithProjection;
    const project = jest.spyOn(sourceProjectionModule, 'finalizeOwnerSourceAwareAnalysisResultWithProjection').mockImplementation((...args) => {
      const projected = realProject(...args);
      return {...projected, result: {...projected.result, conclusion: raw.replace('"focused_answer"', '"invalid-mode"')}};
    });
    const runtime = typedRuntime(); const updates: any[] = []; runtime.on('update', update => updates.push(update));
    try {
      await expect(runtime.analyze('query', 'pi-projection-only-invalid', 'trace-pi'))
        .rejects.toThrow('conclusion_protocol_projection_mismatch');
      expect(FakePiAgent.instances[0].promptCount).toBe(1);
      expect(updates.filter(update => update.content?.phase === 'candidate_protocol').map(update =>
        [update.content.candidateProtocolDiagnostic.stage, update.content.candidateProtocolDiagnostic.status]))
        .toEqual([['native', 'valid'], ['runtime_projected', 'invalid']]);
    } finally { project.mockRestore(); }
  });

  it('does not redispatch Pi source context after authorization changes', async () => {
    passVerification();
    let revoked = false;
    FakePiAgent.promptHandler = async () => {
      revoked = true;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: protocolSidecar}]}];
    };
    const realAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return realAuthorization(...args);
    });
    try {
      const result = await typedRuntime().analyze('query', 'pi-protocol-revoked', 'trace-pi');
      expect(FakePiAgent.instances[0].promptCount).toBe(1);
      expect(inspectCandidateProtocol(result.conclusion).status).toBe('valid');
      const context = takeFinalizationContext(result)!;
      try {expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(protocolSidecar);}
      finally {context.dispose();}
      expect(result.completion?.attemptId).toBe('1');
    } finally { authorization.mockRestore(); }
  });

  it('rejects a Pi declaration returned after authorization changes without replacing the first candidate', async () => {
    passVerification();
    const body = 'Authorized candidate body.';
    const repaired = `${body}\n${protocolSidecar}`;
    let revoked = false;
    FakePiAgent.promptHandler = async (_agent, _input, index) => {
      if (index === 2) revoked = true;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? body : repaired}]}];
    };
    const realAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return realAuthorization(...args);
    });
    try {
      const result = await typedRuntime().analyze('query', 'pi-declaration-authorization-change', 'trace-pi');
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
      expect(FakePiAgent.instances[0].state.messages).toHaveLength(1);
      expect(result.conclusion).toBe(body);
      expect(result.completion).toMatchObject({status: 'completed', attemptId: '1'});
    } finally { authorization.mockRestore(); }
  });

  it('keeps the issue-based correction when a rejected declaration is too large to repair', async () => {
    const issue = {type: 'missing_evidence', severity: 'error', message: 'Needs evidence', recoveryKind: 'correct_evidence'};
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => ({passed: false, heuristicIssues: [issue], llmIssues: []}))
      .mockImplementation(async () => ({passed: true, heuristicIssues: [], llmIssues: []}));
    const body = 'Frame 12 missed its deadline. '.repeat(2300).trimEnd();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(64 * 1024);
    const invalid = declaredCandidateWithClaims(body, [declaredClaim('miss', {semantics: {schemaVersion: 'other'}})]);
    let correctionPrompt = '';
    FakePiAgent.promptHandler = async (_agent, prompt, index) => {
      if (index === 2) correctionPrompt = prompt;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text',
        text: index === 1 ? invalid : declaredPiCandidate('Bounded finding')}]}];
    };
    await typedRuntime().analyze('same question', 'pi-oversized-declaration', 'trace-pi', {runId: 'r-oversized', analysisMode: 'fast'});
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(correctionPrompt).not.toContain('invalid_declaration');
    expect(correctionPrompt).toContain('candidateProtocolDiagnostic');
  });

  it('binds a shorter unheaded correction to its own successful SDK attempt without reclassifying', async () => {
    const issue = {type: 'missing_evidence', severity: 'error', message: '任意语言的说明', recoveryKind: 'correct_evidence'};
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => ({passed: false, heuristicIssues: [issue], llmIssues: []}))
      .mockImplementation(async () => ({passed: true, heuristicIssues: [], llmIssues: []}));
    const initialBody = declaredPiCandidate('Long unverified statement');
    const correctedBody = declaredPiCandidate('Bounded finding');
    FakePiAgent.promptHandler = async (agent, _input, index) => {
      if (index === 2) expect(agent.state.tools).toEqual([]);
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? initialBody : correctedBody}]}];
    };
    const result = await typedRuntime().analyze('same question', 'typed-pi-correction', 'trace-pi', {runId: 'r-correction', analysisMode: 'fast'});
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(piClassifierCalls).toHaveLength(1);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('Bounded finding');
    expect(result.completion).toMatchObject({status: 'completed', runId: 'r-correction', attemptId: '2',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
  });

  it('does not lend an incomplete correction receipt to a previous completed answer', async () => {
    mockClaudeVerifierVerifyConclusion.mockImplementation(async () => ({passed: false, heuristicIssues: [{
      type: 'missing_evidence', severity: 'error', message: 'evidence gap', recoveryKind: 'correct_evidence',
    }], llmIssues: []}));
    FakePiAgent.promptHandler = async (_agent, _input, index) => [{role: 'assistant',
      stopReason: index === 1 ? 'stop' : 'length', content: [{type: 'text', text: index === 1 ? 'Original evidence gap' : 'Cut-off replacement'}]}];
    const result = await typedRuntime().analyze('question', 'typed-pi-failed-correction', 'trace-pi', {runId: 'r-original'});
    expect(result.conclusion).toBe('Original evidence gap');
    expect(result.completion).toMatchObject({status: 'completed', attemptId: '1',
      conclusionFingerprint: analysisDeliveryFingerprint('Original evidence gap')});
    expect(result.partial).toBe(true);
  });

  function observePiProjection() {
    const projection = jest.spyOn(sourceProjectionModule, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const gate = jest.spyOn(qualityGateModule, 'applyFinalResultQualityGate');
    return {
      projection, gate,
      assertReturnedContext(result: unknown) {
        const projected = projection.mock.results.map(entry => entry.value as ReturnType<typeof sourceProjectionModule.finalizeOwnerSourceAwareAnalysisResultWithProjection>)
          .find(entry => entry?.result === result);
        const gateInput = gate.mock.calls.map(([input]) => input).find(input => input.result === result);
        expect(projected).toBeDefined();
        expect(gateInput?.context).toBe(projected?.deliveryContext);
        return projected!;
      },
      restore() { projection.mockRestore(); gate.mockRestore(); },
    };
  }

  it.each([
    {id: 'zh', body: '当前输出只是讨论内容已隐藏这句话，不代表权限变化'},
    {id: 'en', body: 'The log contains [PRIVATE_OUTPUT_SUPPRESSED] as ordinary text'},
  ])('preserves literal privacy wording in a $id native candidate without changing completion', async ({id, body}) => {
    passVerification();
    const sessionId = `pi-projection-preserved-${id}`;
    const observation = observePiProjection();
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: body}]}];
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi', {runId: `preserved-${id}`});
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection.disposition).toBe('preserved');
      expect(result).toMatchObject({success: true, conclusion: body, outputOrigin: 'sdk_final', completion: {
        status: 'completed', candidateRef: `preserved-${id}:pi:1`, conclusionFingerprint: analysisDeliveryFingerprint(body),
      }});
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it.each([
    {id: 'zh', body: '可公开的结论 PRIVATE_PI_CANARY 后续仍有可公开的证据边界'},
    {id: 'en', body: 'Public observation PRIVATE_PI_CANARY followed by its public scope'},
  ])('transfers only the matching $id native candidate through an issued redaction receipt', async ({id, body}) => {
    passVerification();
    const sessionId = `pi-projection-redacted-${id}`;
    const observation = observePiProjection();
    registerCodeAwareCanary(sessionId, 'PRIVATE_PI_CANARY');
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: body}]}];
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi', {runId: `redacted-${id}`});
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection).toMatchObject({disposition: 'redacted', inputFingerprint: analysisDeliveryFingerprint(body)});
      expect(result.conclusion).not.toContain('PRIVATE_PI_CANARY');
      expect(result.completion).toMatchObject({status: 'completed', runId: `redacted-${id}`, attemptId: '1',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      expect(result.completion?.candidateRef).not.toBe(`redacted-${id}:pi:1`);
      expect(projected.deliveryContext).toMatchObject({acceptedCandidate: result.completion, completion: result.completion, outputOrigin: 'sdk_final'});
      expect(result.outputOrigin).toBe('sdk_final');
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it.each([
    {id: 'zh', body: '模型正常结束并输出了完整中文结论'},
    {id: 'en', body: 'The model successfully delivered this English answer'},
  ])('does not certify a $id whole-output replacement as SDK completion', async ({id, body}) => {
    passVerification();
    const sessionId = `pi-projection-replaced-${id}`;
    const observation = observePiProjection();
    FakePiAgent.promptHandler = async () => {
      revokeCodeAwareOutputGuards(sessionId);
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: body}]}];
    };
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi', {runId: `replaced-${id}`});
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection).toMatchObject({disposition: 'replaced', inputFingerprint: analysisDeliveryFingerprint(body)});
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {
        status: 'unknown', runId: `replaced-${id}`, attemptId: '1', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion),
      }});
      expect(projected.deliveryContext).toMatchObject({outputOrigin: 'runtime_fallback', completion: result.completion});
      expect(result.completion?.candidateRef).not.toBe(`replaced-${id}:pi:1`);
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('keeps an empty native answer ineligible after a revoked-session replacement', async () => {
    passVerification();
    const sessionId = 'pi-projection-empty';
    const observation = observePiProjection();
    FakePiAgent.promptHandler = async () => {
      revokeCodeAwareOutputGuards(sessionId);
      return [{role: 'assistant', stopReason: 'stop', content: []}];
    };
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi');
      const projected = observation.assertReturnedContext(result);
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}});
      expect(projected.conclusionProjection).toMatchObject({disposition: 'replaced', inputFingerprint: analysisDeliveryFingerprint('')});
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('projects the accepted correction and retains its attempt instead of overwriting it with the initial receipt', async () => {
    const sessionId = 'pi-projection-correction';
    const observation = observePiProjection();
    mockClaudeVerifierVerifyConclusion.mockImplementationOnce(async () => ({passed: false, heuristicIssues: [{
      type: 'missing_evidence', severity: 'error', message: 'correct this evidence', recoveryKind: 'correct_evidence',
    }], llmIssues: []})).mockImplementation(async () => ({passed: true, heuristicIssues: [], llmIssues: []}));
    registerCodeAwareCanary(sessionId, 'PRIVATE_PI_CANARY');
    const nativeCorrectionBody = 'Corrected evidence PRIVATE_PI_CANARY with a bounded conclusion';
    const initialCandidate = declaredPiCandidate('Initial candidate');
    const nativeCorrection = declaredPiCandidate(nativeCorrectionBody);
    FakePiAgent.promptHandler = async (_agent, _input, index) => [{role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: index === 1 ? initialCandidate : nativeCorrection}]}];
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi', {runId: 'privacy-correction'});
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection.inputFingerprint).toBe(analysisDeliveryFingerprint(nativeCorrection));
      expect(result.completion).toMatchObject({runId: 'privacy-correction', attemptId: '2', status: 'completed',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      expect(result.completion?.candidateRef).not.toBe('privacy-correction:pi:2');
      expect(result.conclusion).not.toContain('PRIVATE_PI_CANARY');
      expect(projected.deliveryContext).toMatchObject({acceptedCandidate: result.completion, completion: result.completion});
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('preserves a native provider failure while redacting its body', async () => {
    passVerification();
    const sessionId = 'pi-projection-provider-failure';
    const observation = observePiProjection();
    registerCodeAwareCanary(sessionId, 'PRIVATE_PI_CANARY');
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'error', errorMessage: 'provider unavailable',
      content: [{type: 'text', text: 'Partial PRIVATE_PI_CANARY observation'}]}];
    try {
      const result = await typedRuntime().analyze('context only', sessionId, 'trace-pi');
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection.disposition).toBe('redacted');
      expect(result).toMatchObject({success: false, outputOrigin: 'assistant_stream', completion: {status: 'failed', reason: 'provider_error'}});
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('carries the returned replacement context on cancellation without reviving native success', async () => {
    const sessionId = 'pi-projection-cancelled';
    const observation = observePiProjection();
    const released = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => released.promise;
    FakePiAgent.abortHandler = () => released.resolve([]);
    const runtime = typedRuntime();
    try {
      const pending = runtime.analyze('context only', sessionId, 'trace-pi');
      await waitUntil(() => FakePiAgent.instances.length === 1);
      revokeCodeAwareOutputGuards(sessionId);
      runtime.abortSession(sessionId);
      const result = await pending;
      const projected = observation.assertReturnedContext(result);
      expect(projected.conclusionProjection.disposition).toBe('replaced');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown', reason: 'cancelled'}});
      expect(projected.deliveryContext).toMatchObject({completion: result.completion, outputOrigin: 'runtime_fallback'});
      expect(sessionContextManager.getOrCreate(sessionId, 'trace-pi').getAllTurns()).toHaveLength(0);
    } finally { observation.restore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('attaches finalization to the exact projected Pi result once and dispatches on the pinned model after runtime settlement', async () => {
    passVerification();
    const sessionId = 'pi-finalization-exact-result';
    const trace = createFakeTraceProcessorService();
    const runtime = typedRuntime({trace});
    const readView = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadView');
    const observation = observePiProjection();
    registerCodeAwareCanary(sessionId, 'PRIVATE_PI_CANARY');
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Public PRIVATE_PI_CANARY result'}]}];
    try {
      const options = {
        analysisMode: 'fast' as const, runId: 'pi-finalization-run', referenceTraceId: 'trace-reference',
        codeAwareMode: 'off' as const,
        tenantId: 'tenant-pi', workspaceId: 'workspace-pi', userId: 'user-pi',
        selectionContext: {kind: 'track_event' as const, eventId: 7, ts: 42},
        analysisContextFingerprint: '',
      };
      const analysisContextFingerprint = contextAuthorization.buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
      options.analysisContextFingerprint = analysisContextFingerprint;
      const result = await runtime.analyze('context only', sessionId, 'trace-current', options);
      const projected = observation.assertReturnedContext(result);
      expect(takeFinalizationContext({...result})).toBeUndefined();
      const context = takeFinalizationContext(result)!;
      expect(context).toBeDefined();
      options.analysisContextFingerprint = 'later-auth-context';
      const providerQuery = context.getProviderQuery(new AbortController().signal);
      expect(providerQuery).toEqual({text: 'context only', analysisContextFingerprint});
      expect(Object.isFrozen(providerQuery)).toBe(true);
      expect(context.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: options.selectionContext, sideResolution: {status: 'unknown'}});
      expect(JSON.stringify(result)).not.toContain('"providerQuery"');
      expect(takeFinalizationContext(result)).toBeUndefined();
      expect(context.deliveryContext).toEqual(projected.deliveryContext);
      expect(context.traceIdentity).toEqual({currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'});
      expect(readView).toHaveBeenCalledTimes(1);
      expect(readView.mock.calls[0][0].currentRunId).toBe(context.runId);
      expect(readView.mock.calls[0][0].allowedTraces).toEqual([
        {traceId: 'trace-current', traceSide: 'current'}, {traceId: 'trace-reference', traceSide: 'reference'},
      ]);
      expect(readView.mock.calls[0][0].ownerKey).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(readView.mock.calls[0][0].ownerKey);
      const queriesBefore = trace.query.mock.calls.length;
      expect(piClassifierCalls).toHaveLength(1);
      runtime.abortSession(sessionId); // The settled main lease cannot cancel the finalizer's own signal.
      try {
        const response = await context.dispatchText({prompt: 'semantic coverage', systemPrompt: '',
          deadlineMs: Date.now() + 30_000, outputByteLimit: 8192, signal: new AbortController().signal});
        expect(response.status).toBe('ok');
        expect(piClassifierCalls).toHaveLength(2);
        expect(piClassifierCalls[1].model).toBe(FakePiAgent.instances[0].state.model);
        expect(piClassifierCalls[1].context.tools).toEqual([]);
        expect(piClassifierCalls[1].context.messages).toHaveLength(1);
        expect(piClassifierCalls[1].options).not.toHaveProperty('maxTokens');
        expect(piClassifierCalls[1].model).toMatchObject({maxTokens: 4096});
        expect(piClassifierCalls[0].options.maxTokens).toBe(1024);
        expect(trace.query.mock.calls.length).toBe(queriesBefore);
        expect(FakePiAgent.instances).toHaveLength(1);
      } finally { context.dispose(); }
    } finally { observation.restore(); readView.mockRestore(); clearCodeAwareOutputGuards(sessionId); }
  });

  it('retains the original selected absolute Pi deadline instead of starting a new finalization budget', async () => {
    passVerification();
    const beforeRun = Date.now();
    FakePiAgent.promptHandler = async () => {
      await delay(20);
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Complete answer'}]}];
    };
    const result = await typedRuntime({env: {
      AGENT_QUICK_MAX_TURNS: '1', AGENT_QUICK_PER_TURN_MS: '1000',
      [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '5000',
    }}).analyze('question', 'pi-finalization-deadline', 'trace-pi', {analysisMode: 'fast'});
    const context = takeFinalizationContext(result)!;
    try {
      expect(context).toBeDefined();
      expect(context.deadlineMs).toBeGreaterThanOrEqual(beforeRun + 1000);
      expect(context.deadlineMs).toBeLessThan(Date.now() + 1000);
      expect(context.sourceScope).toMatchObject({codeAwareMode: 'metadata_only', selectedCodebaseIds: [], hasCodebaseAccess: false});
    } finally { context.dispose(); }
  });

  it('attaches a cancelled Pi run with its typed state and no transport that could restart provider work', async () => {
    const sessionId = 'pi-finalization-cancelled';
    const released = createDeferred<unknown[]>();
    FakePiAgent.promptHandler = async () => released.promise;
    FakePiAgent.abortHandler = () => released.resolve([]);
    const runtime = typedRuntime();
    const pending = runtime.analyze('question', sessionId, 'trace-pi', {runId: 'pi-cancelled-run',
      selectionContext: {kind: 'track_event', eventId: 7, ts: 42}});
    await waitUntil(() => FakePiAgent.instances.length === 1);
    runtime.abortSession(sessionId);
    const result = await pending;
    const context = takeFinalizationContext(result)!;
    expect(context).toBeDefined();
    try {
      expect(context.runId).toBe('pi-cancelled-run');
      expect(context.sourceScope).toMatchObject({codeAwareMode: 'metadata_only', selectedCodebaseIds: [], hasCodebaseAccess: false});
      expect(context.hasSemanticTransport).toBe(false);
      expect(context.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: {kind: 'track_event', eventId: 7, ts: 42},
        sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace-pi'}});
      expect(context.deliveryContext).toMatchObject({completion: result.completion});
      expect(await context.dispatchText({prompt: 'must not dispatch', systemPrompt: '',
        deadlineMs: Date.now() + 30_000, outputByteLimit: 8192, signal: new AbortController().signal}))
        .toMatchObject({status: 'unavailable', reason: 'invalid_configuration'});
      expect(piClassifierCalls).toHaveLength(1);
    } finally { context.dispose(); }
  });

  it('does not attach invented semantic state to the explicit Pi smoke path', async () => {
    const result = await typedRuntime({env: {[PI_AGENT_CORE_FAKE_STREAM_ENV]: '1'}})
      .analyze('smoke', 'pi-finalization-smoke', 'trace-pi');
    expect(takeFinalizationContext(result)).toBeUndefined();
  });

  it('preserves an explicit full budget on the conversation surface without widening a bounded request', async () => {
    passVerification();
    const trace = createFakeTraceProcessorService();
    const result = await typedRuntime({trace}).analyze('bounded follow-up', 'pi-full-conversation-budget', 'trace-pi', {
      analysisMode: 'full', assistantSurface: 'conversation', conversationTraceAttached: true,
    });
    expect(result.turnIntent).toMatchObject({scope: 'bounded_question', deliverable: 'answer'});
    expect(result.quickRun).toBeUndefined();
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(result.completion?.status).toBe('completed');
  });

});
