// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import type { StreamingUpdate } from '../../agent/types';
import type { SessionStateSnapshot } from '../../agentv3/sessionStateSnapshot';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import {
  createPiAgentCoreToolFromSharedSpec,
  buildPiAnalysisCompletion,
  PI_AGENT_CORE_RUNTIME_KIND,
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
import {piContextNearlyFull, piRunThinkingLevel} from '../engines/pi/piAgentCoreRuntime';
import {installedPiAiVersion, parsePiAgentCoreModelConfig, piRuntimeFingerprintInput} from '../engines/pi/piAgentCoreConfig';
import {resolvePiCatalogModel} from '../engines/pi/piAgentCoreProvider';
import * as analysisRunSpecModule from '../analysisRunSpec';
import type { RuntimeToolResult, SharedToolSpec } from '../runtimeToolSpec';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../runtimeToolResult';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import * as claudeMcpModule from '../../agentv3/claudeMcpServer';
import * as skillExecutors from '../../services/skillEngine/skillExecutor';
import {expectRuntimeVendorHintParity} from './vendorHintParityFixture';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from './sourceFinalizationFixture';
import {createRuntimePerformanceRecorder} from '../runtimePerformance';
import {RunSupplementChannel} from '../runSupplementChannel';
import * as localizedStrategyTemplate from '../../agentv3/localizedStrategyTemplate';
import {withEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {EffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import type {AnalysisTurnIntentDecision} from '../analysisTurnIntent';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import * as systemPromptModule from '../../agentv3/claudeSystemPrompt';
import * as sceneEntryEvidence from '../sceneEntryEvidence';
import {createSelectedFoundationFixture, installSelectedNativeSignerMocks, installSelectedRuntimeFixture} from '../../../tests/helpers/selectedEvidenceFoundationFixture';
import * as selectedSkillLoader from '../../services/skillEngine/skillLoader';
import * as analysisPatternMemory from '../../agentv3/analysisPatternMemory';
import * as caseBackgroundContext from '../../services/caseEvolution/caseBackgroundContext';
import * as focusAppDetectorModule from '../../agentv3/focusAppDetector';
import * as architectureDetectorModule from '../../agent/detectors/architectureDetector';
import * as traceCompletenessModule from '../../agentv3/traceCompletenessProber';
import {resolveFocusPackageCell} from './focusEvidenceFixture';
import {registerCodeAwareCanary, revokeCodeAwareOutputGuards, clearCodeAwareOutputGuards, createCodeAwareStreamingTextProjection} from '../../services/security/codeAwareOutputRegistry';
import {createAnswerDraftStream, createProjectedAnswerDraft} from '../answerDraftStream';
import {createPiAnswerDraftController} from '../engines/pi/piAnswerDraft';
import {createAnswerReasoningFilterState, filterAnswerReasoningDelta} from '../answerReasoningFilter';
import {runtimeSupportsDraftAnswerStreaming} from '../runtimeDescriptors';
import * as sourceProjectionModule from '../../services/codebase/sourceClaimVerifier';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {renderConclusionContractSidecar, wrapConclusionAuthoringPayload, type ConclusionContract} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import * as finalizationModule from '../analysisFinalizationContext';
import * as runtimeCallStats from '../../services/runtimeCallStats';
import {takeFinalizationContext} from '../analysisFinalizationContext';
import {expectRuntimeLeftTerminalStateToFinalizer, UNREPAIRABLE_DRAFT_ISSUE} from '../../../tests/helpers/runtimeDraftTerminalState';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {loadPiProviderRuntimeModules} from '../engines/pi/piAgentCoreProvider';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';
import {declaredCandidateWithClaims, declaredClaim} from '../../../tests/helpers/conclusionDeclarationFixture';
import {admitLearnedEntry, withDurableLearningPermission} from '../../services/security/durableLearning';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {admitted} from '../../../tests/helpers/admittedAnalysisOptions';
import {createRuntimeAdmissionScope} from '../runtimeTaskDeadline';
import * as investigationViewModule from '../investigation/investigationView';

const mockClaudeVerifierVerifyConclusion = jest.fn();
jest.mock('../runtimeConclusionVerifier', () => {
  const actual = jest.requireActual('../runtimeConclusionVerifier') as any;
  return {
    ...actual,
    verifyConclusion: (...args: unknown[]) => mockClaudeVerifierVerifyConclusion(...args),
  };
});

let piClassifierDecision: AnalysisTurnIntentDecision;
let piClassifierResponses: Array<Record<string, unknown> | Error>;
let piClassifierCalls: Array<{model: unknown; context: any; options: any}>;

async function loadFakePiProviderRuntime(config: {model: Record<string, unknown>; thinkingLevel?: any}) {
  return {
    model: config.model as any,
    thinkingLevel: config.thinkingLevel,
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

/** Pi's real assistant delta shape: `contentIndex` addresses a block of `partial.content`. */
function piMessageUpdate(assistantMessageEvent: Record<string, unknown>): PiAgentCoreEvent {
  return {type: 'message_update', message: {role: 'assistant'}, assistantMessageEvent} as PiAgentCoreEvent;
}

function piTextDelta(delta: string, contentIndex = 0, blocks = ['text']): PiAgentCoreEvent {
  return piMessageUpdate({type: 'text_delta', contentIndex, delta,
    partial: {role: 'assistant', content: blocks.map(type => ({type}))}});
}

function piAssistantEvent(type: 'message_start' | 'message_end', message: Record<string, unknown> = {}): PiAgentCoreEvent {
  return {type, message: {role: 'assistant', ...message}} as PiAgentCoreEvent;
}

function piDraftEvents(updates: StreamingUpdate[]): Array<[string, string | null, string, number]> {
  return updates.filter(update => update.type === 'answer_token' || update.type === 'answer_segment_reset')
    .map(update => [update.type, update.content.token ?? null, update.content.runId, update.content.attempt]);
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

  // Mirrors Pi 1.x: systemPrompt is read-only, replayed from the seed plus transcript sections.
  state = {
    basePrompt: '',
    messages: [] as unknown[],
    tools: [] as unknown[],
    model: undefined as unknown,
    get systemPrompt(): string {
      const sections = new Map<string, string>();
      for (const message of this.messages as Array<{role?: string; sections?: Record<string, string | null>}>) {
        if (message?.role !== 'system') continue;
        for (const [name, value] of Object.entries(message.sections ?? {})) {
          if (value === null) sections.delete(name); else sections.set(name, value);
        }
      }
      return [this.basePrompt, ...sections.values()].filter(Boolean).join('\n\n');
    },
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
    this.state.basePrompt = initialState?.systemPrompt ?? '';
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

  steeringQueue: unknown[] = [];

  steer(message: unknown): void {
    this.steeringQueue.push(message);
  }

  clearSteeringQueue(): void {
    this.steeringQueue = [];
  }

  drainSteeringForTest(): unknown[] {
    const drained = this.steeringQueue;
    this.steeringQueue = [];
    return drained;
  }

  private emit(event: PiAgentCoreEvent): void {
    if (event.type === 'turn_end') this.emittedTurns++;
    for (const listener of this.listeners) listener(event);
  }
}

const realAdmitDeliveryCall = runtimeCallStats.admitDeliveryCall;

// Mocked providers answer at once inside test-sized deadlines, far below the fixed delivery-call
// estimates; budget skips have their own tests below.
afterEach(() => {jest.useRealTimers();});

beforeEach(() => {
  jest.spyOn(runtimeCallStats, 'admitDeliveryCall').mockClear().mockImplementation((recorder, input) =>
    realAdmitDeliveryCall(recorder, {...input, failOpen: true}));
  piClassifierDecision = {schemaVersion: 1, taskKind: 'fact', sceneId: 'general',
    scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new'};
  piClassifierResponses = [];
  piClassifierCalls = [];
  const actualVerifier = jest.requireActual('../runtimeConclusionVerifier') as any;
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

/** A document-knowledge search result as `search_knowledge` returns it; its excerpt is the canary. */
function piKnowledgeSearchResult(canary: string): string {
  return JSON.stringify({success: true, hits: [{
    id: 'kref-11111111-2222-3333-4444-555555555555', knowledgeBaseId: `eks_${'a'.repeat(24)}`,
    title: 'Handler', headingPath: ['Handler'], relativePath: 'private/notes.md',
    lineRange: {start: 3, end: 9}, excerpt: canary,
  }]});
}

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

/**
 * Provider activity timing uses real MCP tools. It once switched off the
 * built-in Knowledge Pack's machine-local verification; with the Pack removed
 * there is nothing to switch, and the wrapper only marks these cases.
 */
async function withProviderActivityTimingFixture<T>(run: () => Promise<T>): Promise<T> {
  return run();
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
  it.each([
    [undefined, undefined],
    ['authored_claim_document_v1', 'canonical_v1'],
    ['authored_claim_document_v2_dual', 'authoring_v2'],
    ['MODE_CANARY', 'SYNTAX_CANARY'],
  ])('ignores retired output config %s / %s and builds a plain-answer RunSpec once', async (mode, syntax) => {
    const createSpec = analysisRunSpecModule.createAnalysisRunSpec;
    let spec: ReturnType<typeof createSpec> | undefined;
    const stop = new Error('test stopped after real RunSpec');
    const specSpy = jest.spyOn(analysisRunSpecModule, 'createAnalysisRunSpec').mockImplementation(input => {
      spec = createSpec(input);
      throw stop;
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let runtime: PiAgentCoreRuntime;
    runtime = new PiAgentCoreRuntime(createFakeTraceProcessorService(), {kind: 'pi-agent-core', source: 'env'}, {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON,
        ...(mode ? {SMARTPERFETTO_FINAL_SUBMISSION: mode} : {}),
        ...(syntax ? {SMARTPERFETTO_CONCLUSION_AUTHORING: syntax} : {})},
      moduleLoader: async () => ({Agent: FakePiAgent}),
      providerRuntimeLoader: async config => {
        const provider = await loadFakePiProviderRuntime(config);
        return {...provider, streamFn: ((...args: unknown[]) => {
          (runtime as any).env.SMARTPERFETTO_FINAL_SUBMISSION = 'authored_claim_document_v1';
          (runtime as any).env.SMARTPERFETTO_CONCLUSION_AUTHORING = 'LATE_SYNTAX_CANARY';
          return provider.streamFn(...args);
        }) as typeof provider.streamFn};
      },
    });
    try {
      await expect(runtime.analyze('Explain this trace', 'output-config-pi-frozen', 'trace-pi')).rejects.toBe(stop);
      expect(piClassifierCalls).toHaveLength(1);
      expect(specSpy).toHaveBeenCalledTimes(1);
      expect(spec).not.toHaveProperty('declarationSyntax');
      expect(spec).not.toHaveProperty('finalSubmission');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/CANARY/);
    } finally {
      warn.mockRestore();
      specSpy.mockRestore();
      runtime.cleanupSession('output-config-pi-frozen');
    }
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
      runtimeKind: PI_AGENT_CORE_RUNTIME_KIND,
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
        runtime: PI_AGENT_CORE_RUNTIME_KIND,
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
      runtimeKind: PI_AGENT_CORE_RUNTIME_KIND,
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
      runtimeKind: PI_AGENT_CORE_RUNTIME_KIND,
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

  it('records a document knowledge call as Pi plan evidence without its content', async () => {
    const plan = {
      phases: [{
        id: 'p-knowledge',
        name: '知识解释',
        goal: '查询内部资料',
        expectedTools: ['search_knowledge'],
        status: 'in_progress',
        summary: '',
      }],
      successCriteria: '完成知识解释',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const spec: SharedToolSpec = {
      name: 'search_knowledge',
      description: 'Search the selected document knowledge bases',
      exposure: 'public',
      inputSchema: {query: z.string()},
      handler: jest.fn(async () => ({content: [{type: 'text', text: piKnowledgeSearchResult('PI_PLAN_PRIVATE_KNOWLEDGE_CANARY')}]} as RuntimeToolResult)),
    };
    const tool = createPiAgentCoreToolFromSharedSpec(spec, {
      allowedToolNames: new Set([spec.name]),
      analysisPlan: {current: plan},
    });

    await tool.execute('knowledge-call', {query: 'Handler'}, undefined);

    expect(plan.toolCallLog).toHaveLength(1);
    expect(JSON.stringify(plan.toolCallLog)).not.toContain('PI_PLAN_PRIVATE_KNOWLEDGE_CANARY');
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

  it('projects document knowledge results before emitting Pi agent responses', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_end',
      toolName: 'search_knowledge',
      toolCallId: 'knowledge-call',
      result: {content: [{type: 'text', text: piKnowledgeSearchResult('PI_PRIVATE_KNOWLEDGE_CANARY')}]},
    });

    expect(JSON.stringify(update)).not.toContain('PI_PRIVATE_KNOWLEDGE_CANARY');
    expect(JSON.parse(String(update?.content.result))).toMatchObject({knowledge: {referenceCount: 1}});
  });

  it('never emits raw document knowledge partial tool updates', () => {
    const update = projectPiAgentCoreEventToStreamingUpdate({
      type: 'tool_execution_update',
      toolName: 'read_knowledge_section',
      toolCallId: 'knowledge-call',
      partialResult: 'PI_PRIVATE_KNOWLEDGE_PARTIAL_CANARY',
    });

    expect(JSON.stringify(update)).not.toContain('PI_PRIVATE_KNOWLEDGE_PARTIAL_CANARY');
    expect(update).toEqual(expect.objectContaining({
      type: 'progress',
      content: expect.objectContaining({
        update: expect.objectContaining({
          outcome: 'rejected',
          toolName: 'read_knowledge_section',
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
      { kind: PI_AGENT_CORE_RUNTIME_KIND, source: 'env' },
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

  // Product-owned scene entry evidence settles before the run's MCP server is
  // built, and its segment data reaches the shared prompt context.
  it('collects scene entry evidence before building the MCP server and hands it to the prompt', async () => {
    const runtime = typedRuntime();
    const order: string[] = [];
    const evidence = {status: 'not_run' as const, skillId: 'startup_analysis', reason: 'timeout' as const};
    const scene = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt').mockImplementation(async () => {
      order.push('scene_evidence');
      return evidence;
    });
    const actualMcp = claudeMcpModule.createClaudeMcpServer;
    const mcp = jest.spyOn(claudeMcpModule, 'createClaudeMcpServer').mockImplementation(options => {
      order.push('mcp_server');
      return actualMcp(options);
    });
    const prompt = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    try {
      await runtime.analyze('分析启动性能', 'session-pi-scene-entry', 'trace-pi', {analysisMode: 'full', runId: 'run-pi-scene'});
      expect(order).toEqual(['scene_evidence', 'mcp_server']);
      expect(scene.mock.calls[0][0]).toMatchObject({traceId: 'trace-pi', turnIntent: expect.any(Object)});
      expect(prompt.mock.calls.some(([context]) => (context as any).sceneEvidence === evidence)).toBe(true);
    } finally {
      scene.mockRestore(); mcp.mockRestore(); prompt.mockRestore();
    }
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
      await runtime.analyze('Analyze the scrolling session', 'session-pi-private-experience', 'trace-pi', admitted({
        analysisMode: 'full', codeAwareMode: 'metadata_only', codebaseIds: ['cb-pi-private-experience'],
      }));
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

    const result = await runtime.analyze('快速结合源码定位候选机制', 'session-pi-source-quick', 'trace-pi', admitted({
      analysisMode: 'fast',
      assistantSurface: 'conversation',
      conversationTraceAttached: true,
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-pi-quick'],
    }));

    const agent = FakePiAgent.instances[FakePiAgent.instances.length - 1]!;
    expect(agent.state.systemPrompt).toContain('cb-pi-quick');
    expect(agent.state.systemPrompt).toContain('provider_send');
    expect(agent.state.systemPrompt).toContain('## 源码使用');
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
      const terminal = await runtime.analyze('source terminal run', sessionId, 'trace-pi', admitted({
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      }));
      const context = takeFinalizationContext(terminal)!;
      try {
        expect(context).not.toHaveProperty('getNativeDeclaration');
        expect(JSON.stringify(terminal)).not.toContain('conclusion_protocol_projection');
      } finally {context.dispose();}
      const next = await runtime.analyze('public second run', sessionId, 'trace-pi', admitted({
        analysisMode: 'fast',
        codeAwareMode: 'off',
      }));

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
    const entered = createDeferred<void>();
    FakePiAgent.promptHandler = async () => {entered.resolve(); return never.promise;};
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
      // The request timer starts at analyze entry; hold it until the prompt is
      // running, when prepareAnalysis has already reported the source use.
      jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});

      const analysis = runtime.analyze('source timeout run', sessionId, 'trace-pi', admitted({
        analysisMode: 'full',
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      }));
      await entered.promise;
      await jest.advanceTimersByTimeAsync(25);

      await expect(analysis).resolves.toMatchObject({
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

  it('observes HTTP dispatches per run without capturing the recorder in the cached Pi provider', async () => {
    const bodies: string[] = [];
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(init!.body as string);
      return new Response('{}');
    });
    const providerRuntimeLoader = jest.fn(async (config: {model: Record<string, unknown>}) => {
      const provider = await loadFakePiProviderRuntime(config);
      const stream = ((model: unknown, context: unknown, streamOptions: any) => {
        const result = provider.streamFn(model, context, streamOptions) as any;
        return {result: async () => {
          await streamOptions.fetch('https://provider.example/v1/chat/completions', {
            method: 'POST', body: JSON.stringify({messages: [{role: 'user', content: 'PRIVATE_PI_WIRE_🙂'}]}),
            signal: streamOptions.signal,
          });
          return result.result();
        }};
      }) as any;
      return {...provider, streamFn: stream, streamFnForPurpose: () => stream};
    });
    FakePiAgent.promptHandler = async agent => {
      const stream = agent.options!.streamFn as (...args: any[]) => any;
      await stream(agent.state.model, {messages: []}, {}).result();
      return undefined;
    };
    const runtime = new PiAgentCoreRuntime(createFakeTraceProcessorService(), {kind: 'pi-agent-core', source: 'env'}, {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON}, moduleLoader: async () => ({Agent: FakePiAgent}), providerRuntimeLoader,
    });
    try {
      for (let run = 0; run < 2; run++) {
        const recorder = createRuntimePerformanceRecorder();
        const start = bodies.length;
        await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(),
          () => runtime.analyze('question', 'session-pi', 'trace-pi', {analysisMode: 'fast',
            runManifestAttributionSink: createNoopAttributionSink(recorder)}));
        const receipt = recorder.seal();
        expect(receipt.modelRequests?.map(item => item.body.bodyBytes)).toEqual(bodies.slice(start).map(body => Buffer.byteLength(body)));
        expect(receipt.modelRequests?.[0]).toMatchObject({dispatchOrdinal: 1, purpose: 'classification'});
        expect(receipt.modelRequests?.some(item => item.purpose === 'answer_turn')).toBe(true);
        expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_PI_WIRE|provider.example/);
      }
      expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
    } finally {runtime.reset(); transport.mockRestore();}
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

  it('keys the Pi provider cache on content under an own __proto__ key', async () => {
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
    // JSON.parse keeps __proto__ as an own data key; the two configs differ only there.
    const withCompat = (value: string) => ({
      model: {...JSON.parse(PI_TEST_MODEL_JSON), compat: JSON.parse(`{"__proto__":{"mode":"${value}"}}`)},
      apiKey: 'redacted-test-key',
    });

    const firstLoad = (runtime as any).getProviderRuntime(withCompat('a'));
    const secondLoad = (runtime as any).getProviderRuntime(withCompat('b'));

    expect(secondLoad).not.toBe(firstLoad);
    await Promise.all([firstLoad, secondLoad]);
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(2);
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
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    const sessionId = 'session-pi-request-timeout';
    const traceId = 'trace-pi';
    const never = createDeferred<unknown[]>();
    const entered = createDeferred<void>();
    FakePiAgent.promptHandler = async () => {entered.resolve(); return never.promise;};
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
    await entered.promise;
    const outcome = Promise.race([
      analysis,
      rejectAfter(250, () => runtime.abortSession(sessionId)),
    ]);
    await jest.advanceTimersByTimeAsync(250);
    await expect(outcome).resolves.toMatchObject({
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
    FakePiAgent.promptHandler = async (agent, _input, promptIndex) => {
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
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    const sessionId = 'session-pi-abort-join';
    const traceId = 'trace-pi';
    const releasePrompt = createDeferred<unknown[]>();
    const entered = createDeferred<void>();
    const updates: StreamingUpdate[] = [];
    FakePiAgent.promptHandler = async () => {entered.resolve(); return releasePrompt.promise;};
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
    await entered.promise;
    await jest.advanceTimersByTimeAsync(40);
    let secondError: Error | undefined;
    const second = runtime.analyze('second', sessionId, traceId, {analysisMode: 'fast'})
      .catch((error: Error) => {
        secondError = error;
      });

    try {
      await Promise.resolve();
      expect(secondError).toBeDefined();
      expect(secondError!.message).toMatch(/already in progress/i);
      const resultPromise = Promise.race([
        first,
        rejectAfter(500, () => runtime.abortSession(sessionId)),
      ]);
      await jest.advanceTimersByTimeAsync(80);
      const firstResult = await resultPromise;
      expect(firstResult).toMatchObject({
        success: false,
        terminationReason: 'timeout',
      });
      releasePrompt.resolve([{
        role: 'assistant',
        content: [{type: 'text', text: 'LATE_ABORT_IGNORING_PROVIDER_TEXT'}],
      }]);
      await second;
      await jest.advanceTimersByTimeAsync(25);
      expect(JSON.stringify(updates)).not.toContain('LATE_ABORT_IGNORING_PROVIDER_TEXT');
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
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    const sessionId = 'session-pi-abort-repeated-overlap';
    const traceId = 'trace-pi';
    const releasePrompt = createDeferred<unknown[]>();
    const entered = createDeferred<void>();
    const updates: StreamingUpdate[] = [];
    FakePiAgent.promptHandler = async () => {entered.resolve(); return releasePrompt.promise;};
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
    await entered.promise;
    await jest.advanceTimersByTimeAsync(80);
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

    releasePrompt.resolve([{
      role: 'assistant',
      content: [{type: 'text', text: 'late cleanup'}],
    }]);
    await waitUntil(() => FakePiAgent.instances.length === 1);
    await jest.advanceTimersByTimeAsync(20);
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

  it('inherits logical history and ignores a transcript stored by an older snapshot', async () => {
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

    expect(snapshot.engineState).toEqual({
      kind: 'pi-agent-core',
      provider: {providerId: null, providerSnapshotHash: null},
      pi: {},
    });
    // Snapshots written before the transcript was dropped still carry it.
    const legacySnapshot = {
      ...snapshot,
      engineState: {
        ...snapshot.engineState,
        pi: {
          opaque: {
            version: 1,
            messages: [{role: 'assistant', content: [{type: 'text', text: 'LEGACY_TRANSCRIPT_CANARY'}]}],
            messageCount: 81,
            originalMessageCount: 120,
            truncated: true,
            degradedReason: 'too_large',
          },
        },
      },
    } as SessionStateSnapshot;

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
    secondRuntime.restoreFromSnapshot('session-pi-resume', 'trace-pi', legacySnapshot);
    const updates: StreamingUpdate[] = [];
    secondRuntime.on('update', update => updates.push(update));

    await secondRuntime.analyze('follow-up question', 'session-pi-resume', 'trace-pi', {
      analysisMode: 'fast',
    });

    const restoredAgent = FakePiAgent.instances[1];
    expect(restoredAgent.options).toMatchObject({
      initialState: expect.objectContaining({
        messages: [],
      }),
    });
    expect(JSON.stringify(restoredAgent.options)).not.toContain('LEGACY_TRANSCRIPT_CANARY');
    expect(updates.map(update => update.type)).not.toContain('degraded');
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

  it('never carries a Pi transcript across private analysis boundaries', async () => {
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
    await runtime.analyze('private', 'session-private-boundary', 'trace-pi', admitted({
      analysisMode: 'full',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['private-codebase'],
    }));
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
    expect(privateSnapshot.engineState).toMatchObject({kind: 'pi-agent-core', pi: {}});
    expect(JSON.stringify(privateSnapshot)).not.toContain('PRIVATE_SOURCE_CANARY');

    FakePiAgent.promptMessages = [{
      role: 'assistant',
      content: [{type: 'text', text: 'PUBLIC_AFTER_REVOKE'}],
    }];
    await runtime.analyze('public after revoke', 'session-private-boundary', 'trace-pi', {
      analysisMode: 'fast',
    });
    expect((FakePiAgent.instances[2].options?.initialState as any).messages).toEqual([]);
    expect(JSON.stringify(FakePiAgent.instances[2].options)).not.toContain('PRIVATE_SOURCE_CANARY');
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

  function typedRuntime(input: {trace?: any; env?: Record<string, string>; loader?: any} = {}) {
    return new PiAgentCoreRuntime(input.trace ?? createFakeTraceProcessorService(),
      {kind: 'pi-agent-core', source: 'env'}, {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON, ...input.env},
        moduleLoader: input.loader ?? (async () => ({Agent: FakePiAgent})),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      });
  }

  it('selected foundation: real native and metric precede focus and share the MCP store', async () => {
    const restoreSigner = installSelectedNativeSignerMocks();
    const fixture = await createSelectedFoundationFixture({traceId: 'trace-pi', runId: 'selected-pi', registerExecutor: false});
    const wired = installSelectedRuntimeFixture(fixture);
    const requestSelection = {...fixture.input.selectionContext!};
    const registryReady = jest.spyOn(selectedSkillLoader, 'ensureSkillRegistryInitialized').mockImplementationOnce(async () => {
      await Promise.resolve();
      Object.assign(requestSelection, {eventId: 999, ts: 999, dur: 999});
    });
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', targetUse: 'current_selection'};
    const order: string[] = [];
    const query = fixture.query.getMockImplementation()!;
    fixture.query.mockImplementation(async (...args) => {order.push('metric'); return query(...args);});
    const focus = jest.spyOn(focusAppDetectorModule, 'detectFocusApps').mockImplementation(async () => {
      order.push('focus'); return {apps: [], method: 'none'};
    });
    const architecture = jest.spyOn(architectureDetectorModule, 'createArchitectureDetector').mockReturnValue({detect: async () => undefined} as any);
    const completeness = jest.spyOn(traceCompletenessModule, 'probeTraceCompleteness').mockResolvedValue(undefined as any);
    const selected = jest.spyOn(sceneEntryEvidence, 'collectSelectedEvidenceForPrompt');
    const legacy = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt');
    const mcp = jest.spyOn(claudeMcpModule, 'createClaudeMcpServer');
    const prompt = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    try {
      await typedRuntime({trace: fixture.input.traceProcessorService}).analyze('Explain this selected work', 'selected-pi', 'trace-pi',
        {analysisMode: 'full', runId: 'selected-pi', selectionContext: requestSelection});
      expect(order).toEqual(['metric', 'focus']);
      expect(fixture.queryBounded.mock.calls[0][1]).toBe('SELECT id, ts, dur, track_id FROM slice WHERE id = 7');
      expect(requestSelection).toMatchObject({eventId: 999});
      expect(selected).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
      expect(wired.createExecutor.mock.results.filter(call => call.type === 'return' && call.value === fixture.executor)).toHaveLength(1);
      expect(wired.registerSkills).toHaveBeenCalledTimes(1); expect(wired.registerFragments).toHaveBeenCalledTimes(1);
      const store = selected.mock.calls[0][0].artifactStore;
      expect(mcp.mock.calls[0][0]).toMatchObject({artifactStore: store, skillExecutor: fixture.executor});
      expect(prompt.mock.calls[0][0].sceneEvidence).toMatchObject({kind: 'selected_foundation', native: {status: 'captured'}, metric: {status: 'committed'}});
      expect(store.createEvidenceReadView({ownerKey: 'owner', currentRunId: 'selected-pi', allowedTraces: [{traceId: 'trace-pi', traceSide: 'current'}]})
        .investigationEvidence!().records).toEqual([expect.objectContaining({upid: 42, utid: 43, value: 80})]);
    } finally {registryReady.mockRestore(); wired.restore(); restoreSigner(); focus.mockRestore(); architecture.mockRestore(); completeness.mockRestore(); selected.mockRestore(); legacy.mockRestore(); mcp.mockRestore(); prompt.mockRestore();}
  });

  it('selected foundation: holds the run guard while cancelled native work drains', async () => {
    const restoreSigner = installSelectedNativeSignerMocks();
    const sessionId = 'selected-pi-drain';
    const fixture = await createSelectedFoundationFixture({traceId: 'trace-pi', runId: sessionId, registerExecutor: false});
    const wired = installSelectedRuntimeFixture(fixture);
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', targetUse: 'current_selection'};

    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;}), held = new Promise<void>(resolve => {release = resolve;});
    fixture.queryBounded.mockImplementationOnce(async () => {enter(); await held; return fixture.nativeResponse;});
    const focus = jest.spyOn(focusAppDetectorModule, 'detectFocusApps');
    const selected = jest.spyOn(sceneEntryEvidence, 'collectSelectedEvidenceForPrompt');
    const runtime = typedRuntime({trace: fixture.input.traceProcessorService});
    const operation = runtime.analyze('Explain selected work', sessionId, 'trace-pi',
      {analysisMode: 'full', runId: sessionId, selectionContext: fixture.input.selectionContext});
    const settled = operation.then(value => ({value}), error => ({error}));
    try {
      await Promise.race([entered, settled.then(() => {throw new Error('analysis settled before selected native lookup');})]);
      expect(focus).not.toHaveBeenCalled();
      void runtime.abortSession(sessionId);
      await Promise.resolve();
      await expect(runtime.analyze('successor', sessionId, 'trace-pi')).rejects.toThrow(/already in progress/);
      expect(focus).not.toHaveBeenCalled(); expect(fixture.query).not.toHaveBeenCalled();
      release(); await settled;
      expect(focus).not.toHaveBeenCalled(); expect(fixture.query).not.toHaveBeenCalled();
      expect(selected).toHaveBeenCalledTimes(1);
      expect(selected.mock.calls[0][0].artifactStore.size).toBe(0);
    } finally {release(); await settled; wired.restore(); restoreSigner(); focus.mockRestore(); selected.mockRestore();}
  });

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

  it.each([undefined, 45_000])('uses product admission for the native absolute budget (explicit=%s)', async taskTimeoutMs => {
    jest.useFakeTimers({now: 36_000, doNotFake: ['nextTick', 'setImmediate']});
    passVerification();
    const sessionId = `pi-admission-${taskTimeoutMs ?? 'default'}`;
    const runId = `${sessionId}-run`;
    const owner = new AbortController();
    const scope = createRuntimeAdmissionScope({runId, admittedAt: 1000, taskTimeoutMs,
      ownerSignal: owner.signal, assertCurrent() {}});
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: declaredPiCandidate('The captured value is 17.')}]}];
    const runtime = typedRuntime({env: {[PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '60000',
      AGENT_QUICK_MAX_TURNS: '1', AGENT_QUICK_PER_TURN_MS: '60000'}});
    try {
      const result = await runtime.analyze('question', sessionId, 'trace-pi', scope.bind({analysisMode: 'fast' as const}, sessionId));
      const context = takeFinalizationContext(result)!;
      try {
        expect(context.deadlineMs).toBe(taskTimeoutMs === undefined ? 61_000 : 46_000);
        expect(piClassifierCalls[0].options.timeoutMs).toBeLessThanOrEqual(taskTimeoutMs === undefined ? 25_000 : 10_000);
        expect(owner.signal.aborted).toBe(false);
      } finally {context.dispose();}
    } finally {scope.dispose(); runtime.cleanupSession(sessionId); sessionContextManager.remove(sessionId);}
  });

  it('does not classify or create a native Agent when the product task expired during preparation', async () => {
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    const scope = createRuntimeAdmissionScope({runId: 'expired-pi', admittedAt: 0, taskTimeoutMs: 10, assertCurrent() {}});
    try {
      const result = await typedRuntime().analyze('question', 'expired-pi', 'trace-pi', scope.bind({}, 'expired-pi'));
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(piClassifierCalls).toHaveLength(0);
      expect(FakePiAgent.instances).toHaveLength(0);
    } finally {scope.dispose(); sessionContextManager.remove('expired-pi');}
  });

  it('drains an expired focus query without starting later preparation or releasing its guard early', async () => {
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', scope: 'scene_wide',
      recommendedComplexity: 'full', deliverable: 'report'};
    const sessionId = 'pi-focus-task-deadline';
    const entered = createDeferred<void>();
    const focus = createDeferred<{columns: string[]; rows: unknown[][]; durationMs: number}>();
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementationOnce(async () => {entered.resolve(); return focus.promise;});
    const scene = jest.spyOn(sceneEntryEvidence, 'collectSceneEvidenceForPrompt');
    const architecture = jest.spyOn(architectureDetectorModule, 'createArchitectureDetector');
    const completeness = jest.spyOn(traceCompletenessModule, 'probeTraceCompleteness');
    const owner = new AbortController();
    const scope = createRuntimeAdmissionScope({runId: 'pi-focus-expiry', admittedAt: 1000, taskTimeoutMs: 50,
      ownerSignal: owner.signal, assertCurrent() {}});
    const runtime = new PiAgentCoreRuntime(traceProcessorService, {kind: 'pi-agent-core', source: 'env'}, {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON, [PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '60000',
        [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '5'},
      moduleLoader: async () => ({Agent: FakePiAgent}), providerRuntimeLoader: loadFakePiProviderRuntime,
    });
    try {
      const pending = runtime.analyze('question', sessionId, 'trace-pi', scope.bind({analysisMode: 'full' as const}, sessionId));
      await entered.promise;
      await jest.advanceTimersByTimeAsync(55);
      const result = await pending;
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
      expect(owner.signal.aborted).toBe(false);
      await expect(runtime.analyze('next', sessionId, 'trace-pi')).rejects.toThrow(/already in progress/);
      focus.resolve({columns: [], rows: [], durationMs: 1});
      await jest.advanceTimersByTimeAsync(0);
      // The admitted focus step may finish its own internal queries; no later prep stage starts.
      expect(architecture).not.toHaveBeenCalled();
      expect(completeness).not.toHaveBeenCalled();
      expect(scene).not.toHaveBeenCalled();
      expect(FakePiAgent.instances).toHaveLength(0);
      const next = await runtime.analyze('next', sessionId, 'trace-pi', {analysisMode: 'fast'});
      expect(next.success).toBe(true);
      takeFinalizationContext(next)?.dispose();
    } finally {
      focus.resolve({columns: [], rows: [], durationMs: 1});
      await jest.advanceTimersByTimeAsync(0);
      scope.dispose(); scene.mockRestore(); architecture.mockRestore(); completeness.mockRestore(); runtime.cleanupSession(sessionId); sessionContextManager.remove(sessionId);
    }
  });

  it('keeps the original candidate when task expiry interrupts its continuation and holds the guard until prompt drain', async () => {
    jest.useFakeTimers({now: 1000, doNotFake: ['nextTick', 'setImmediate']});
    passVerification();
    const sessionId = 'pi-repair-task-deadline';
    const body = 'The captured marker is present; causal coverage remains unverified.';
    const entered = createDeferred<void>();
    const repair = createDeferred<unknown[]>();
    const owner = new AbortController();
    const scope = createRuntimeAdmissionScope({runId: 'pi-repair-run', admittedAt: 1000, taskTimeoutMs: 50,
      ownerSignal: owner.signal, assertCurrent() {}});
    const runtime = typedRuntime({env: {[PI_AGENT_CORE_REQUEST_TIMEOUT_MS_ENV]: '60000',
      [PI_AGENT_CORE_ABORT_JOIN_TIMEOUT_MS_ENV]: '5'}});
    FakePiAgent.promptHandler = async (_agent, _prompt, index) => {
      if (index === 2) {entered.resolve(); return repair.promise;}
      // An output-limited answer earns the one continuation interrupted below.
      return [{role: 'assistant', stopReason: 'length', content: [{type: 'text', text: body}]}];
    };
    try {
      const running = runtime.analyze('question', sessionId, 'trace-pi', scope.bind({analysisMode: 'fast' as const}, sessionId));
      await entered.promise;
      await jest.advanceTimersByTimeAsync(55);
      const result = await running;
      expect(result.conclusion).toBe(body);
      expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit', attemptId: '1'});
      expect(owner.signal.aborted).toBe(false);
      const context = takeFinalizationContext(result)!;
      try {
        expect(context.deadlineMs).toBe(1050);
      } finally {context.dispose();}
      await expect(runtime.analyze('next', sessionId, 'trace-pi')).rejects.toThrow(/already in progress/);
      repair.resolve([{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'LATE_REPAIR_MUST_NOT_REPLACE_BODY'}]}]);
      await jest.advanceTimersByTimeAsync(0);
      expect(result.conclusion).toBe(body);
      expect(sessionContextManager.getOrCreate(sessionId, 'trace-pi').getAllTurns?.()).toHaveLength(1);
      FakePiAgent.promptHandler = async () => [{role: 'assistant', stopReason: 'stop',
        content: [{type: 'text', text: declaredPiCandidate('The next run is independent.')}]}];
      const next = await runtime.analyze('next', sessionId, 'trace-pi');
      expect(next.success).toBe(true);
      takeFinalizationContext(next)?.dispose();
    } finally {
      repair.resolve([]);
      await jest.advanceTimersByTimeAsync(0);
      scope.dispose(); runtime.cleanupSession(sessionId); sessionContextManager.remove(sessionId);
    }
  });

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
    // A completed answer needs no declaration repair; neither outcome spends a second call.
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    expect(replies).toEqual([failedNext]);
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
      expect(FakePiAgent.instances[0].promptCount).toBe(1);
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
    const result = await typedRuntime({trace}).analyze('继续解释上一轮证据', 'typed-pi-existing', 'trace-pi', admitted({
      analysisMode: 'full', referenceTraceId: 'trace-ref', codeAwareMode: 'provider_send', codebaseIds: ['selected-source'],
    }));
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
        if (await (agent.options?.finishTurn as any)({message})) return [message];
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
      expect(await (agent.options?.finishTurn as any)({message})).toEqual({action: 'end'});
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
      providerRuntimeLoader: async config => ({...await loadFakePiProviderRuntime(config),
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

  it.each(['complete', 'length', 'invalid', 'no-declaration', 'no-reserve', 'deferred', 'tool-call', 'error', 'expired'] as const)(
    'gives native output_limit one bounded delivery opportunity only when eligible: %s', async outcome => {
      passVerification();
      const first = `Observed ten 195 ms lock waits.\n${protocolSidecar.slice(0, -4)}`;
      const complete = `Observed ten 195 ms lock waits. The owner chain is supported by existing rows.\n${protocolSidecar}`;
      let clock: jest.SpiedFunction<typeof Date.now> | undefined;
      FakePiAgent.promptHandler = async (agent, prompt, index) => {
        if (index === 2) {
          expect(agent.state.tools).toEqual([]);
          expect(prompt).toContain('continue_output');
          expect(prompt).toContain('Observed ten 195 ms lock waits.');
          expect(await (agent.options!.beforeToolCall as any)({toolCall: {name: 'execute_sql'}})).toMatchObject({block: true});
        }
        if (outcome === 'expired' && index === 1) clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
        return [{role: 'assistant', stopReason: index === 1 || outcome === 'length' ? 'length' : 'stop',
          ...(index === 1 && outcome === 'deferred' ? {deferred: {pending: true}} : {}),
          ...(index === 1 && outcome === 'error' ? {errorMessage: 'private provider failure'} : {}),
          content: [{type: 'text', text: index === 1 ? (outcome === 'no-declaration' ? 'Observed ten 195 ms lock waits.' : first)
            : outcome === 'invalid' ? first : outcome === 'no-declaration' ? 'Observed ten 195 ms lock waits.' : complete},
            ...(index === 1 && outcome === 'tool-call' ? [{type: 'toolCall', name: 'execute_sql', arguments: {}}] : [])]}];
      };
      const eligible = ['complete', 'length', 'invalid', 'no-declaration'].includes(outcome);
      try {
        const result = await typedRuntime({env: {AGENT_QUICK_MAX_TURNS: outcome === 'no-reserve' ? '1' : '2',
          AGENT_QUICK_TIMEOUT_SECONDS: '1'}}).analyze('query', `pi-output-limit-${outcome}`, 'trace-pi', {analysisMode: 'fast'});
        expect(FakePiAgent.instances[0].promptCount).toBe(eligible ? 2 : 1);
        if (outcome === 'complete' || outcome === 'invalid' || outcome === 'no-declaration') {
          // Any completed continuation with an answer body replaces the cut-off candidate;
          // it needs no declaration, and a stray malformed one is stripped downstream.
          expect(result.completion).toMatchObject({status: 'completed', sdkFinishReason: 'stop', attemptId: '2',
            conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
          expect(inspectCandidateProtocol(result.conclusion).canonicalBody).toContain('Observed ten 195 ms lock waits.');
        } else {
          expect(result.completion).toMatchObject({status: outcome === 'error' ? 'failed' : 'incomplete', attemptId: '1'});
          expect(result.completion?.reason).toBe(outcome === 'error' ? 'provider_error' : 'output_limit');
        }
      } finally {clock?.mockRestore();}
    });

  it('forwards the no-tool delivery policy through the pinned authorization fence', async () => {
    passVerification();
    const purposes: Array<{purpose: string; outputOnly?: boolean}> = [];
    const runtime = new PiAgentCoreRuntime(createFakeTraceProcessorService(), {kind: 'pi-agent-core', source: 'env'}, {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON}, moduleLoader: async () => ({Agent: FakePiAgent}),
      providerRuntimeLoader: async config => {
        const base = await loadFakePiProviderRuntime(config);
        return {...base, streamFnForPurpose: (purpose, policy) => {
          purposes.push({purpose, outputOnly: policy?.outputOnly}); return base.streamFn;
        }};
      },
    });
    FakePiAgent.promptHandler = async (agent, _prompt, index) => {
      if (index === 2) await (agent.options!.streamFn as any)(agent.state.model, {messages: [], tools: []}, {}).result();
      return [{role: 'assistant', stopReason: index === 1 ? 'length' : 'stop', content: [{type: 'text',
        text: index === 1 ? `Observed lock waits.\n${protocolSidecar.slice(0, -4)}` : `Observed lock waits.\n${protocolSidecar}`}]}];
    };
    const result = await runtime.analyze('query', 'pi-delivery-policy-fence', 'trace-pi');
    expect(result.completion?.status).toBe('completed');
    expect(purposes).toContainEqual({purpose: 'continuation', outputOnly: true});
  });

  it('stops native delivery after its one turn even with unused acquisition budget and a rogue tool call', async () => {
    passVerification();
    FakePiAgent.promptHandler = async (agent, _prompt, index) => {
      const message = {role: 'assistant', stopReason: index === 1 ? 'length' : 'toolUse', content: index === 1
        ? [{type: 'text', text: `Observed waits.\n${protocolSidecar.slice(0, -4)}`}]
        : [{type: 'toolCall', name: 'execute_sql', arguments: {}}]};
      if (index === 2) {
        expect(agent.state.tools).toEqual([]);
        expect(await (agent.options!.beforeToolCall as any)({toolCall: {name: 'execute_sql'}})).toMatchObject({block: true});
      }
      agent.emitForTest({type: 'turn_end', message});
      expect(await (agent.options!.finishTurn as any)({message})).toEqual(index === 2 ? {action: 'end'} : undefined);
      return [message];
    };
    const result = await typedRuntime({env: {AGENT_QUICK_MAX_TURNS: '50'}})
      .analyze('query', 'pi-single-delivery-turn', 'trace-pi', {analysisMode: 'fast'});
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit', attemptId: '1'});
  });

  it('issues no declaration repair call when a completed answer carries no declaration', async () => {
    passVerification();
    const body = 'Frame 12 missed its deadline by 4.2 ms.';
    FakePiAgent.promptHandler = async () => [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: body}]}];
    const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
    const result = await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(), () =>
      typedRuntime().analyze('query', 'pi-no-declaration', 'trace-pi',
        {runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder)}));
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    expect(result.conclusion.trim()).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', attemptId: '1'});
    expect(runtimeCallStats.admitDeliveryCall).not.toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({purpose: 'declaration_repair'}));
    const receipt = runtimePerformanceRecorder.seal();
    expect((receipt.modelCalls ?? []).some(call => call.purpose === 'declaration_repair')).toBe(false);
    expect((receipt.deliveryBudgets ?? []).some(budget => budget.purpose === 'declaration_repair')).toBe(false);
  });

  it('does not correct an undecodable authoring candidate through the ordinary Pi recovery path', async () => {
    passVerification();
    const native = `Body remains.\n${wrapConclusionAuthoringPayload('{"authoringVersion":"unsupported"}')}`;
    FakePiAgent.promptMessages = [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: native}]}];
    const result = await typedRuntime().analyze('query', 'pi-authoring-unrecoverable', 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    expect(result.completion).toMatchObject({status: 'completed'});
    expect(inspectCandidateProtocol(result.conclusion).status).toBe('invalid');
    const context = takeFinalizationContext(result)!;
    try {expect(context).not.toHaveProperty('getNativeDeclaration');}
    finally {context.dispose();}
  });

  it.each(['sidecar-only', 'invalid-schema'])('repairs native completed %s while preserving the pinned Pi prompt and source protocol', async kind => {
    passVerification();
    const first = kind === 'sidecar-only' ? protocolSidecar : protocolSidecar.replace('"focused_answer"', '"invalid-mode"');
    const complete = `The marker is present.\n${protocolSidecar}`;
    let originalPrompt = '';
    const authorizationChecksAtDispatch: number[] = [];
    FakePiAgent.promptHandler = async (agent, _input, index) => {
      // The request Pi's own loop sends through the runtime's streamFn.
      (agent.options!.streamFn as (...args: unknown[]) => unknown)(agent.state.model, {marker: 'repair'}, {});
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
      const result = await runtime.analyze('query', `pi-protocol-${kind}`, 'trace-pi', admitted({runId: `pi-protocol-${kind}`,
        codeAwareMode: 'provider_send', codebaseIds: ['codebase-a']}));
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
      expect(authorizationChecksAtDispatch[0]).toBeGreaterThan(0);
      expect(authorizationChecksAtDispatch[1]).toBeGreaterThan(authorizationChecksAtDispatch[0]);
      expect(authorization.mock.calls.every(([selection, scope, fingerprint]) => fingerprint ===
        contextAuthorization.buildAnalysisContextAuthorizationFingerprint(selection, scope))).toBe(true);
      expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('The marker is present.');
      expect(result.completion).toMatchObject({status: 'completed', attemptId: '2', conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)});
      const context = takeFinalizationContext(result)!;
      try {expect(context).not.toHaveProperty('getNativeDeclaration');}
      finally {context.dispose();}
      expect(FakePiAgent.instances[0].state.systemPrompt).toBe(originalPrompt);
      const diagnostic = updates.filter(update => update.content?.phase === 'candidate_protocol').map(update => update.content.candidateProtocolDiagnostic);
      expect(diagnostic.map(value => [value.stage, value.candidateIndex, value.status])).toEqual([
        ['native', 1, kind === 'sidecar-only' ? 'valid' : 'invalid'], ['native', 2, 'valid'], ['runtime_projected', 2, 'valid'],
      ]);
    } finally { authorization.mockRestore(); }
  });

  it.each(['plain-body', 'sidecar-only', 'invalid-schema'])('completes a bodyless Pi reply only with a correction that has a body: %s', async kind => {
    passVerification();
    const first = protocolSidecar.replace('"focused_answer"', '"invalid-mode"');
    const second = kind === 'plain-body' ? 'The marker is present.' : kind === 'sidecar-only' ? protocolSidecar : first;
    FakePiAgent.promptHandler = async (_agent, _input, index) => [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: index === 1 ? first : second}]}];
    const result = await typedRuntime().analyze('query', `pi-protocol-rejected-${kind}`, 'trace-pi');
    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    if (kind === 'plain-body') {
      // A plain answer needs no declaration to replace a bodyless reply.
      expect(result.completion?.attemptId).toBe('2');
      expect(result.conclusion.trim()).toBe('The marker is present.');
    } else {
      expect(result.completion?.attemptId).toBe('1');
      expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe('');
    }
    // A rejected correction leaves no runtime-written terminal message; finalization assesses the candidate.
    expect(result.terminationMessage).toBeUndefined();
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
      const result = await runtime.analyze('query', 'pi-projection-only-invalid', 'trace-pi');
      // The projected body no longer matches the native candidate, so finalization cannot bind its completion.
      takeFinalizationContext(result)?.dispose();
      expect(FakePiAgent.instances[0].promptCount).toBe(1);
      expect(updates.filter(update => update.content?.phase === 'candidate_protocol').map(update =>
        [update.content.candidateProtocolDiagnostic.stage, update.content.candidateProtocolDiagnostic.status]))
        .toEqual([['native', 'valid'], ['runtime_projected', 'invalid']]);
    } finally { project.mockRestore(); }
  });

  const PRIVATE_SELECTION = {codeAwareMode: 'provider_send' as const, codebaseIds: ['codebase-a']};

  it('does not redispatch Pi source context after authorization changes', async () => {
    passVerification();
    let revoked = false;
    let sent = 0;
    FakePiAgent.promptHandler = async agent => {
      // Pi's loop sends each prompt through the runtime's streamFn; a refused request sends nothing.
      try {
        (agent.options!.streamFn as (...args: unknown[]) => unknown)(agent.state.model, {marker: 'protocol'}, {});
        sent += 1;
      } catch { return []; }
      revoked = true;
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: protocolSidecar}]}];
    };
    const realAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return realAuthorization(...args);
    });
    try {
      await expect(typedRuntime().analyze('query', 'pi-protocol-revoked', 'trace-pi', admitted(PRIVATE_SELECTION)))
        .rejects.toThrow('analysis_context_changed_restart_required');
      expect(sent).toBe(1);
      expect(FakePiAgent.instances[0].aborted).toBe(true);
    } finally { authorization.mockRestore(); }
  });

  describe('authorization is checked before every model request', () => {
    // The fake agent drives the runtime's streamFn the way Pi's native loop does.
    const mainDispatches = () => piClassifierCalls.filter(call =>
      (call.context as {marker?: string} | undefined)?.marker === 'main');
    const dispatch = (agent: FakePiAgent) =>
      (agent.options!.streamFn as (...args: unknown[]) => unknown)(agent.state.model, {marker: 'main'}, {});
    const revokeWhen = (revoked: () => boolean) => {
      const real = contextAuthorization.assertCurrentAnalysisContextAuthorization;
      return jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
        if (revoked()) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
        return real(...args);
      });
    };

    it('ends the run when authorization changes after a body read, before the continuation that resends it', async () => {
      let revoked = false;
      let continuation: unknown;
      FakePiAgent.promptHandler = async agent => {
        dispatch(agent);
        revoked = true; // A source body was read and returned; consent is withdrawn before the next request.
        try { dispatch(agent); } catch (error) { continuation = error; }
        return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: protocolSidecar}]}];
      };
      const authorization = revokeWhen(() => revoked);
      try {
        await expect(typedRuntime().analyze('query', 'pi-revoked-continuation', 'trace-pi', admitted(PRIVATE_SELECTION)))
          .rejects.toThrow('analysis_context_changed_restart_required');
        expect(continuation).toBeInstanceOf(contextAuthorization.AnalysisContextAuthorizationChangedError);
        expect(mainDispatches()).toHaveLength(1);
        expect(FakePiAgent.instances[0].aborted).toBe(true);
        expect(FakePiAgent.instances[0].promptCount).toBe(1);
      } finally { authorization.mockRestore(); }
    });

    it('dispatches nothing when authorization changes after the history is rendered, before the first request', async () => {
      let revoked = false;
      FakePiAgent.promptHandler = async agent => {
        revoked = true;
        expect(() => dispatch(agent)).toThrow('analysis_context_changed_restart_required');
        return [];
      };
      const authorization = revokeWhen(() => revoked);
      try {
        await expect(typedRuntime().analyze('query', 'pi-revoked-before-dispatch', 'trace-pi', admitted(PRIVATE_SELECTION)))
          .rejects.toThrow('analysis_context_changed_restart_required');
        expect(mainDispatches()).toHaveLength(0);
      } finally { authorization.mockRestore(); }
    });
  });

  it('ends the run when authorization changes during a same-run continuation', async () => {
    passVerification();
    const body = 'Authorized candidate body.';
    const repaired = `${body} Completed.`;
    let revoked = false;
    FakePiAgent.promptHandler = async (_agent, _input, index) => {
      if (index === 2) revoked = true;
      return [{role: 'assistant', stopReason: index === 1 ? 'length' : 'stop', content: [{type: 'text', text: index === 1 ? body : repaired}]}];
    };
    const realAuthorization = contextAuthorization.assertCurrentAnalysisContextAuthorization;
    const authorization = jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation((...args) => {
      if (revoked) throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
      return realAuthorization(...args);
    });
    try {
      await expect(typedRuntime().analyze('query', 'pi-declaration-authorization-change', 'trace-pi', admitted(PRIVATE_SELECTION)))
        .rejects.toThrow('analysis_context_changed_restart_required');
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
    } finally { authorization.mockRestore(); }
  });

  it('keeps the issue-based correction for an answer whose stray declaration is invalid', async () => {
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
    expect(correctionPrompt).toContain('correct_evidence');
    expect(correctionPrompt).not.toContain('candidateProtocolDiagnostic');
  });

  it('gathers no trace facts and binds no trace for a conversation without a mounted trace', async () => {
    passVerification();
    const trace = createFakeTraceProcessorService();
    FakePiAgent.promptHandler = async () => [{role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: declaredPiCandidate('No trace is attached.')}]}];
    const sessionId = 'pi-no-trace';
    try {
      const result = await typedRuntime({trace}).analyze('A question', sessionId, `conversation-no-trace:${sessionId}`,
        {assistantSurface: 'conversation', conversationTraceAttached: false, analysisMode: 'full'});
      expect(trace.query).not.toHaveBeenCalled();
      const context = takeFinalizationContext(result);
      expect(context?.traceIdentity).toEqual({});
      context?.dispose();
    } finally {sessionContextManager.remove(sessionId);}
  });

  it('leaves the terminal state to the finalizer when a draft diagnostic has no repair', async () => {
    mockClaudeVerifierVerifyConclusion.mockImplementation(async () => ({passed: false,
      heuristicIssues: [UNREPAIRABLE_DRAFT_ISSUE], llmIssues: []}));
    FakePiAgent.promptHandler = async () => [{role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: declaredPiCandidate('Frame 12 missed its deadline.')}]}];
    const runtime = typedRuntime(); const updates: any[] = []; runtime.on('update', update => updates.push(update));
    const sessionId = 'pi-draft-terminal-state';
    try {
      const result = await runtime.analyze('same question', sessionId, 'trace-pi', {runId: 'r-draft', analysisMode: 'fast'});
      expect(FakePiAgent.instances[0].promptCount).toBe(1);
      expect(result.completion).toMatchObject({status: 'completed'});
      expectRuntimeLeftTerminalStateToFinalizer({result, updates, native: {partial: false},
        recordedTurn: sessionContextManager.get(sessionId, 'trace-pi')?.getAllTurns().slice(-1)[0]?.result});
      takeFinalizationContext(result)?.dispose();
    } finally {sessionContextManager.remove(sessionId);}
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
    // The draft diagnostic chose the correction only; the completed native answer is not partial.
    expect(result.partial).toBeUndefined();
    expect(result.terminationReason).toBeUndefined();
  });

  function observePiProjection() {
    const projection = jest.spyOn(sourceProjectionModule, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const attach = jest.spyOn(finalizationModule, 'attachFinalizationContext');
    return {
      projection, attach,
      assertReturnedContext(result: unknown) {
        const projected = projection.mock.results.map(entry => entry.value as ReturnType<typeof sourceProjectionModule.finalizeOwnerSourceAwareAnalysisResultWithProjection>)
          .find(entry => entry?.result === result);
        const attached = attach.mock.calls.find(([target]) => target === result)?.[1];
        expect(projected).toBeDefined();
        expect(attached?.deliveryContext).toBe(projected?.deliveryContext);
        return projected!;
      },
      restore() { projection.mockRestore(); attach.mockRestore(); },
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

  it('leaves the terminal state of a privacy-replaced draft to the finalizer', async () => {
    const sessionId = 'pi-replaced-terminal-state';
    FakePiAgent.promptHandler = async () => {
      revokeCodeAwareOutputGuards(sessionId);
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Native model conclusion'}]}];
    };
    const runtime = typedRuntime(); const updates: any[] = []; runtime.on('update', update => updates.push(update));
    try {
      const result = await runtime.analyze('context only', sessionId, 'trace-pi', {runId: 'replaced-terminal', analysisMode: 'fast'});
      expect(result).toMatchObject({outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}});
      expectRuntimeLeftTerminalStateToFinalizer({result, updates, native: {partial: true},
        recordedTurn: sessionContextManager.get(sessionId, 'trace-pi')?.getAllTurns().slice(-1)[0]?.result});
      takeFinalizationContext(result)?.dispose();
    } finally {clearCodeAwareOutputGuards(sessionId); sessionContextManager.remove(sessionId);}
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
    // Only the finalizer's ledger read: the run-start status makes its own.
    const runtime = typedRuntime({trace, env: {SMARTPERFETTO_INVESTIGATION_ACQUISITION_STATUS: 'false'}});
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
      expect(context).not.toHaveProperty('getSelection');
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
      runtime.abortSession(sessionId);
      try {
        // Finalization issues no model call of its own.
        expect(piClassifierCalls).toHaveLength(1);
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
      expect(context.sourceScope).toMatchObject({codeAwareMode: 'off', selectedCodebaseIds: [], hasCodebaseAccess: false});
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
      expect(context.sourceScope).toMatchObject({codeAwareMode: 'off', selectedCodebaseIds: [], hasCodebaseAccess: false});
      expect(context).not.toHaveProperty('getSelection');
      expect(context.deliveryContext).toMatchObject({completion: result.completion});
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
    expect(FakePiAgent.instances[0].promptCount).toBe(1);
    expect(result.completion?.status).toBe('completed');
  });

  describe('investigation observation before every native request', () => {
    const answer = 'Observed 18 ms of main-thread binder wait.';
    // Pi calls prepareRequest before each provider request, the first included, then streams.
    const requestOnce = async (agent: FakePiAgent, updates: unknown[]) => {
      const prepare = agent.options!.prepareRequest as (...args: unknown[]) => unknown;
      const context = {messages: [{role: 'user', content: 'PRIVATE_PI_QUESTION', timestamp: 1}], tools: agent.state.tools};
      updates.push(await prepare({context, model: agent.state.model, thinkingLevel: 'off'}, new AbortController().signal));
      await (agent.options!.streamFn as any)(agent.state.model, {messages: []}, {}).result();
      return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: answer}]}];
    };

    it.each([[undefined, true], ['off', false], ['0', false]])(
      'gives the run its note memory and rule facts unless the kill switch is off (%s)', async (flag, enabled) => {
        passVerification();
        const createExecutor = jest.spyOn(skillExecutors, 'createSkillExecutor');
        const mcp = jest.spyOn(claudeMcpModule, 'createClaudeMcpServer');
        const updates: unknown[] = [];
        FakePiAgent.promptHandler = async agent => requestOnce(agent, updates);
        try {
          await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(), () =>
            typedRuntime(flag ? {env: {SMARTPERFETTO_SKILL_RESULT_FACTS: flag}} : {}).analyze('分析启动', `pi-result-facts-${flag}`, 'trace-pi',
              {analysisMode: 'fast', runManifestAttributionSink: createNoopAttributionSink(createRuntimePerformanceRecorder())}));
          // Other callers (detectors, adapters) build executors with no options.
          expect(createExecutor.mock.calls.flatMap(call => call[2] ? [call[2]] : [])).toEqual([{diagnosticFacts: enabled}]);
          expect(Boolean(mcp.mock.lastCall?.[0].skillResultNotes)).toBe(enabled);
        } finally {
          createExecutor.mockRestore();
          mcp.mockRestore();
        }
      });

    it('records one bounded receipt per request, joins its model call and returns no update', async () => {
      passVerification();
      piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', sceneId: 'startup', scope: 'scene_wide'};
      const recorder = createRuntimePerformanceRecorder();
      const updates: unknown[] = [];
      let lateAgent: FakePiAgent | undefined;
      FakePiAgent.promptHandler = async agent => {lateAgent = agent; return requestOnce(agent, updates);};
      const result = await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(), () =>
        typedRuntime().analyze('分析启动', 'pi-investigation-receipt', 'trace-pi', {analysisMode: 'fast',
          runManifestAttributionSink: createNoopAttributionSink(recorder)}));
      expect(result.conclusion.trim()).toBe(answer);
      expect(result.completion?.status).toBe('completed');
      expect(updates).toEqual([undefined]);
      // Finalization disposed the adapter: a late request records nothing.
      expect(await (lateAgent!.options!.prepareRequest as any)({context: {messages: [], tools: []}})).toBeUndefined();
      const receipt = recorder.seal();
      expect(receipt.investigationRequests).toHaveLength(1);
      const [request] = receipt.investigationRequests!;
      expect(request).toMatchObject({requestIndex: 1, attempt: 1, purpose: 'answer_turn', status: 'observed',
        agentContext: {messageCount: 1, toolCount: lateAgent!.state.tools.length}, evidence: 'read',
        turns: {used: 0}, decision: 'no_change', requirements: {contract: 'resolved'}});
      expect(request.agentContext!.approxMessageChars).toBeGreaterThan('PRIVATE_PI_QUESTION'.length);
      expect(request.agentContext!.approxToolChars).toBeGreaterThan(0);
      const counts = request.requirements!;
      expect(counts.observed + counts.notObserved + counts.unknownNoProducer + counts.notApplicable).toBeGreaterThan(0);
      expect(receipt.modelCalls?.filter(call => call.purpose === 'answer_turn')).toEqual([expect.objectContaining({requestIndex: 1})]);
      expect(JSON.stringify(receipt.investigationRequests)).not.toContain('PRIVATE_PI_QUESTION');
    });

    it('keeps the run unchanged when deriving the view throws', async () => {
      passVerification();
      const failing = jest.spyOn(investigationViewModule, 'createInvestigationViewSource').mockReturnValue({
        derive: () => {throw new Error('PRIVATE_VIEW_FAILURE');}});
      try {
        const recorder = createRuntimePerformanceRecorder();
        const updates: unknown[] = [];
        FakePiAgent.promptHandler = async agent => requestOnce(agent, updates);
        const result = await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(), () =>
          typedRuntime().analyze('query', 'pi-investigation-view-failure', 'trace-pi',
            {runManifestAttributionSink: createNoopAttributionSink(recorder)}));
        expect(result.conclusion.trim()).toBe(answer);
        expect(result.completion?.status).toBe('completed');
        expect(updates).toEqual([undefined]);
        const receipt = recorder.seal();
        expect(receipt.investigationRequests).toEqual([expect.objectContaining({requestIndex: 1, status: 'view_failed',
          agentContext: expect.objectContaining({messageCount: 1})})]);
        expect(receipt.investigationRequests![0]).not.toHaveProperty('requirements');
        expect(JSON.stringify(receipt)).not.toContain('PRIVATE_VIEW_FAILURE');
      } finally {failing.mockRestore();}
    });

    describe('first-turn requirement acquisition status', () => {
      async function run(env: Record<string, string>, sessionId: string) {
        passVerification();
        piClassifierDecision = {...piClassifierDecision, taskKind: 'investigation', sceneId: 'startup', scope: 'scene_wide'};
        const observed: {systemPrompt?: string; options?: Record<string, unknown>} = {};
        FakePiAgent.promptHandler = async agent => {
          observed.options = agent.options!;
          observed.systemPrompt = agent.state.systemPrompt;
          return [{role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: answer}]}];
        };
        const result = await typedRuntime({env: {AGENT_QUICK_MAX_TURNS: '6', ...env}}).analyze('分析启动', sessionId, 'trace-pi', {analysisMode: 'fast'});
        return {result, observed};
      }

      it('gives each requirement its run-start ledger status by default', async () => {
        const {result, observed} = await run({}, 'pi-acquisition-default');
        expect(result.conclusion.trim()).toBe(answer);
        expect(observed.systemPrompt).toContain('## Requirement acquisition status');
        const segment = JSON.parse(observed.systemPrompt!.match(/\{"context":"investigation_requirements".*$/m)![0]);
        const statuses = Object.fromEntries(segment.data.requirements.map((item: any) => [item.id, item.acquisition]));
        expect(statuses).toMatchObject({thread_state: 'not_observed', finding_coverage: 'unknown_no_producer'});
      });

      it('leaves the prompt byte-identical without the status when switched off, and never changes the Agent loop', async () => {
        const buildSpy = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
        try {
          const off = await run({SMARTPERFETTO_INVESTIGATION_ACQUISITION_STATUS: 'false'}, 'pi-acquisition-off');
          const on = await run({}, 'pi-acquisition-on');
          expect(off.observed.systemPrompt).not.toContain('"acquisition"');
          const contexts = buildSpy.mock.calls.map(([context]) => context);
          expect('investigationAcquisition' in contexts[0]).toBe(false);
          expect(contexts[1].investigationAcquisition).toBeDefined();
          expect(systemPromptModule.buildSystemPrompt({...contexts[1], investigationAcquisition: undefined}))
            .toBe(off.observed.systemPrompt);
          expect(Object.keys(on.observed.options!)).toEqual(Object.keys(off.observed.options!));
        } finally {buildSpy.mockRestore();}
      });
    });
  });

  describe('answer drafts', () => {
    function draftController(projection?: Parameters<typeof createProjectedAnswerDraft>[1]) {
      const updates: StreamingUpdate[] = [];
      const answerDraft = createAnswerDraftStream('draft-run', update => updates.push(update));
      const controller = createPiAnswerDraftController({answerDraft, isActive: () => true});
      controller.beginAttempt(createProjectedAnswerDraft(answerDraft, projection));
      return {updates, controller};
    }
    const hold = () => jest.advanceTimersByTime(200);

    it('filters inline reasoning across deltas without altering plain text', () => {
      const run = (...deltas: string[]) => {
        const state = createAnswerReasoningFilterState();
        return {out: deltas.map(delta => filterAnswerReasoningDelta(delta, state)).join(''), state};
      };
      expect(run('plain text, no tags').out).toBe('plain text, no tags');
      expect(run('<think>hidden</think>visible').out).toBe('visible');
      expect(run('<THINK>hidden</Think>visible').out).toBe('visible');
      expect(run('a<th', 'ink>b</thi', 'nk>c').out).toBe('ac');
      expect(run('a < b and c > d').out).toBe('a < b and c > d');
      expect(run('x<', 'y').out).toBe('x<y');
      expect(run('<think>a < b <t').out).toBe('');
      const open = run('text<th');
      expect(open.out).toBe('text');
      expect(open.state.pendingTagPrefix).toBe('<th');
    });

    it('is declared on the Pi runtime descriptor', () => {
      expect(runtimeSupportsDraftAnswerStreaming('pi-agent-core')).toBe(true);
    });

    it('takes only text deltas: thinking, tool JSON, non-text blocks and inline reasoning never reach the draft', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piMessageUpdate({type: 'thinking_delta', contentIndex: 0, delta: 'private thought'}));
      controller.onEvent(piMessageUpdate({type: 'toolcall_delta', contentIndex: 1, delta: '{"sql":"select 1"}'}));
      controller.onEvent(piTextDelta('not a text block', 1, ['text', 'thinking']));
      controller.onEvent(piMessageUpdate({type: 'text_delta', delta: 'no index'}));
      controller.onEvent(piMessageUpdate({type: 'text_delta', text: 'legacy field', contentIndex: 0, partial: {content: [{type: 'text'}]}}));
      controller.onEvent(piTextDelta('<thi'));
      controller.onEvent(piTextDelta('nk>inline reasoning</think>Visible'));
      hold();
      expect(piDraftEvents(updates)).toEqual([['answer_token', 'Visible', 'draft-run', 0]]);
      expect(JSON.stringify(updates)).not.toMatch(/private thought|select 1|inline reasoning|not a text block|legacy field/);
    });

    it('separates text blocks the way the final answer joins them', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('First', 0, ['text', 'thinking', 'text']));
      controller.onEvent(piMessageUpdate({type: 'thinking_delta', contentIndex: 1, delta: 'hidden'}));
      controller.onEvent(piTextDelta('Second', 2, ['text', 'thinking', 'text']));
      hold();
      expect(piDraftEvents(updates)).toEqual([['answer_token', 'First\nSecond', 'draft-run', 0]]);
    });

    it('does not flash text a tool call follows inside the hold window', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('Let me check the trace.'));
      jest.advanceTimersByTime(100);
      controller.onEvent(piMessageUpdate({type: 'toolcall_start', contentIndex: 1}));
      hold();
      expect(updates).toEqual([]);
    });

    it('releases a steady stream when the window ends instead of waiting for a pause', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      controller.onEvent(piAssistantEvent('message_start'));
      for (const delta of ['a', 'b', 'c', 'd']) {
        controller.onEvent(piTextDelta(delta));
        jest.advanceTimersByTime(60);
      }
      expect(piDraftEvents(updates)).toEqual([['answer_token', 'abcd', 'draft-run', 0]]);
      controller.onEvent(piTextDelta('e'));
      expect(piDraftEvents(updates)).toEqual([
        ['answer_token', 'abcd', 'draft-run', 0], ['answer_token', 'e', 'draft-run', 0]]);
    });

    it('revokes answer text that preceded a tool call in the same response', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('Let me check the trace.'));
      hold();
      controller.onEvent(piMessageUpdate({type: 'toolcall_start', contentIndex: 1}));
      controller.onEvent(piTextDelta('text after the tool call', 2, ['text', 'toolCall', 'text']));
      controller.onEvent(piAssistantEvent('message_end', {stopReason: 'toolUse', content: [{type: 'toolCall'}]}));
      controller.onEvent({type: 'tool_execution_start', toolName: 'execute_sql', toolCallId: 'call-1'});
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('Final answer'));
      controller.onEvent(piAssistantEvent('message_end', {stopReason: 'stop', content: [{type: 'text', text: 'Final answer'}]}));
      expect(piDraftEvents(updates)).toEqual([
        ['answer_token', 'Let me check the trace.', 'draft-run', 0],
        ['answer_segment_reset', null, 'draft-run', 1],
        ['answer_token', 'Final answer', 'draft-run', 1],
      ]);
    });

    it('revokes the draft for a new response, a failed response and a new attempt', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController();
      const answerEnd = piAssistantEvent('message_end', {stopReason: 'stop', content: [{type: 'text', text: 'x'}]});
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('first'));
      controller.onEvent(answerEnd);
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('second'));
      controller.onEvent(answerEnd);
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('failed'));
      hold();
      controller.onEvent(piAssistantEvent('message_end', {stopReason: 'error', content: [{type: 'text', text: 'failed'}]}));
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('retried'));
      controller.onEvent(answerEnd);
      controller.beginAttempt(createProjectedAnswerDraft(createAnswerDraftStream('other-run', () => undefined), undefined));
      expect(piDraftEvents(updates)).toEqual([
        ['answer_token', 'first', 'draft-run', 0],
        ['answer_segment_reset', null, 'draft-run', 1],
        ['answer_token', 'second', 'draft-run', 1],
        ['answer_segment_reset', null, 'draft-run', 2],
        ['answer_token', 'failed', 'draft-run', 2],
        ['answer_segment_reset', null, 'draft-run', 3],
        ['answer_token', 'retried', 'draft-run', 3],
        ['answer_segment_reset', null, 'draft-run', 4],
      ]);
    });

    it('withdraws a private draft when a credential completes across lines, and shows nothing more', () => {
      jest.useFakeTimers();
      const sessionId = 'pi-private-draft';
      const {updates, controller} = draftController(
        createCodeAwareStreamingTextProjection(sessionId, 'pi-answer-test', 'owner'));
      try {
        controller.onEvent(piAssistantEvent('message_start'));
        controller.onEvent(piTextDelta('Intro line\n'));
        hold();
        for (const text of ['api_key=\n', '"synthetic-secret-123456"\n', 'Later line\n']) controller.onEvent(piTextDelta(text));
        controller.onEvent(piMessageUpdate({type: 'toolcall_start', contentIndex: 1}));
        controller.onEvent(piAssistantEvent('message_start'));
        controller.onEvent(piTextDelta('Next response\n'));
        hold();
        expect(piDraftEvents(updates)).toEqual([
          ['answer_token', 'Intro line\n', 'draft-run', 0],
          ['answer_segment_reset', null, 'draft-run', 1],
        ]);
        expect(JSON.stringify(updates)).not.toContain('synthetic-secret-123456');
      } finally { clearCodeAwareOutputGuards(sessionId); }
    });

    it('withdraws the draft when the timer path of a projection fails, without throwing', () => {
      jest.useFakeTimers();
      const {updates, controller} = draftController({
        write: () => {throw new Error('projection failed');},
        flush: () => '',
        projectComplete: text => text,
        projectCompleteWithReceipt: text => ({text, altered: false}) as any,
        altered: false,
      });
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('must not surface'));
      expect(() => hold()).not.toThrow();
      controller.onEvent(piTextDelta('nor this'));
      hold();
      expect(updates).toEqual([]);
    });

    it('does not release held text once the run is stopped or the controller is disposed', () => {
      jest.useFakeTimers();
      const updates: StreamingUpdate[] = [];
      const answerDraft = createAnswerDraftStream('draft-run', update => updates.push(update));
      let active = true;
      const controller = createPiAnswerDraftController({answerDraft, isActive: () => active});
      controller.beginAttempt(createProjectedAnswerDraft(answerDraft, undefined));
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('stale'));
      active = false;
      hold();
      controller.dispose();
      controller.finish();
      controller.onEvent(piAssistantEvent('message_start'));
      controller.onEvent(piTextDelta('after dispose'));
      hold();
      expect(updates).toEqual([]);
    });

    it('streams a run answer with its identity and keeps a correction out of the draft', async () => {
      passVerification();
      const runtime = typedRuntime();
      const updates: StreamingUpdate[] = [];
      runtime.on('update', update => updates.push(update));
      FakePiAgent.promptHandler = async (agent, _input, index) => {
        const text = index === 1 ? 'Partial report' : 'Corrected report';
        const stopReason = index === 1 ? 'length' : 'stop';
        const message = {role: 'assistant', stopReason, content: [{type: 'text', text}]};
        agent.emitForTest(piAssistantEvent('message_start'));
        agent.emitForTest(piTextDelta(text));
        agent.emitForTest({type: 'message_end', message});
        return [message];
      };
      const result = await runtime.analyze('query', 'pi-draft-correction', 'trace-pi', {runId: 'draft-run', analysisMode: 'fast'});
      takeFinalizationContext(result)?.dispose();
      expect(FakePiAgent.instances[0].promptCount).toBe(2);
      expect(piDraftEvents(updates)).toEqual([
        ['answer_token', 'Partial report', 'draft-run', 0],
        ['answer_segment_reset', null, 'draft-run', 1],
      ]);
      expect(result.conclusion).toContain('Corrected report');
    });
  });

  describe('run supplements', () => {
    const supplementDecision = {goal: 'refine_current_goal', sceneId: 'general', scopeEffect: 'none',
      target: 'current_trace', evidenceNeed: 'none', requiredAccess: 'none', deliverable: 'answer', budget: 'unchanged'};
    const answer = (text: string, stopReason = 'stop') =>
      ({role: 'assistant', stopReason, content: [{type: 'text', text}]});
    const toolTurn = () => ({role: 'assistant', stopReason: 'toolUse',
      content: [{type: 'toolCall', id: 'call-1', name: 'execute_sql', arguments: {}}]});
    const flushAsync = async () => {
      for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    };
    const classifierReply = (value: unknown) => ({role: 'assistant', stopReason: 'stop',
      content: [{type: 'text', text: JSON.stringify(value)}]});
    /** Same scheduling as Pi's agent loop: steering polls before each request and after finishTurn. */
    async function scriptedLoop(agent: FakePiAgent, turns: Array<Record<string, any>>,
      duringTurn?: (turn: number) => Promise<void>): Promise<number> {
      let pending = agent.drainSteeringForTest();
      let requests = 0;
      let index = 0;
      for (;;) {
        for (const message of pending) {
          agent.emitForTest({type: 'message_end', message});
          agent.state.messages.push(message);
        }
        await (agent.options?.prepareRequest as any)?.({context: {messages: agent.state.messages, tools: []}}, undefined);
        requests++;
        await duringTurn?.(index);
        const message = turns[Math.min(index++, turns.length - 1)];
        agent.state.messages.push(message);
        const decision = await (agent.options?.finishTurn as any)({message, toolResults: []});
        agent.emitForTest({type: 'turn_end', message, toolResults: []});
        if (decision?.action === 'end') return requests;
        pending = agent.drainSteeringForTest();
        const hasToolCall = message.content.some((part: any) => part?.type === 'toolCall');
        if (!hasToolCall && pending.length === 0) return requests;
      }
    }
    function runWithChannel(channel: RunSupplementChannel, input: {
      runtime?: PiAgentCoreRuntime;
      env?: Record<string, string>;
      sink?: RunManifestAttributionSink;
    } = {}) {
      const runtime = input.runtime ?? typedRuntime({env: input.env});
      return runtime.analyze('question', channel.runId, 'trace-pi', {
        analysisMode: 'fast', runId: channel.runId, runSupplementChannel: channel,
        ...(input.sink ? {runManifestAttributionSink: input.sink} : {}),
      });
    }

    it('joins a supplement submitted before the first prompt to request one, as a user-role JSON body', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-steer-before-prompt'});
      channel.submit({idempotencyKey: 'key-1', text: 'focus on the render thread'});
      const recorder = createRuntimePerformanceRecorder();
      FakePiAgent.promptHandler = async agent => {
        await flushAsync();
        expect(agent.options?.steeringMode).toBe('all');
        expect((agent.steeringQueue as any[]).length).toBe(1);
        await scriptedLoop(agent, [answer('done')]);
        return [answer('done')];
      };
      const sink = createNoopAttributionSink(recorder);
      const result = await withEffectiveRuntimeRegistrySnapshot(createEffectiveRuntimeRegistrySnapshot(),
        () => runWithChannel(channel, {sink}));
      takeFinalizationContext(result)?.dispose();
      const [receipt] = channel.receipts();
      expect(receipt).toMatchObject({state: 'delivered'});
      const records = channel.deliveredRecords({includeText: true});
      expect(records).toEqual([expect.objectContaining({deliveredRequestIndex: 1, text: 'focus on the render thread'})]);
      const [agent] = FakePiAgent.instances;
      const delivered = agent.state.messages.find((m: any) => m.role === 'user') as any;
      expect(delivered.content[0].text).toContain(JSON.stringify({text: 'focus on the render thread'}));
      expect(recorder.seal().runSupplements).toEqual({delivered: 1});
    });

    it('enters at the tool boundary of the running turn, not before it', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-steer-during-tool'});
      FakePiAgent.promptHandler = async agent => {
        await scriptedLoop(agent, [toolTurn(), answer('done')], async turn => {
          if (turn !== 0) return;
          channel.submit({idempotencyKey: 'key-1', text: 'mid tool note'});
          await flushAsync();
        });
        return [answer('done')];
      };
      takeFinalizationContext(await runWithChannel(channel))?.dispose();
      expect(channel.receipts()[0]).toMatchObject({state: 'delivered'});
      expect(channel.deliveredRecords({includeText: false})).toEqual([
        expect.objectContaining({deliveredRequestIndex: 2}),
      ]);
    });

    it('keeps the draft revoked when a supplement enters at a tool boundary', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-draft-supplement'});
      const runtime = typedRuntime();
      const updates: StreamingUpdate[] = [];
      runtime.on('update', update => updates.push(update));
      FakePiAgent.promptHandler = async agent => {
        await scriptedLoop(agent, [toolTurn(), answer('done')], async turn => {
          agent.emitForTest(piAssistantEvent('message_start'));
          if (turn === 0) {
            agent.emitForTest(piTextDelta('Let me check the trace.'));
            agent.emitForTest(piMessageUpdate({type: 'toolcall_start', contentIndex: 1}));
            channel.submit({idempotencyKey: 'key-1', text: 'mid tool note'});
            await flushAsync();
          } else {
            agent.emitForTest(piTextDelta('Final answer'));
            agent.emitForTest(piAssistantEvent('message_end', {stopReason: 'stop', content: [{type: 'text', text: 'Final answer'}]}));
          }
        });
        return [answer('done')];
      };
      takeFinalizationContext(await runWithChannel(channel, {runtime}))?.dispose();
      expect(channel.receipts()[0]).toMatchObject({state: 'delivered'});
      expect(piDraftEvents(updates)).toEqual([['answer_token', 'Final answer', 'run-draft-supplement', 0]]);
    });

    it('never steers onto a finished answer: not_applied with no extra provider request', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-finished-answer'});
      let withSupplement = 0;
      FakePiAgent.promptHandler = async agent => {
        withSupplement = await scriptedLoop(agent, [answer('done')], async () => {
          channel.submit({idempotencyKey: 'key-1', text: 'too late'});
          await flushAsync();
        });
        return [answer('done')];
      };
      takeFinalizationContext(await runWithChannel(channel))?.dispose();
      expect(channel.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'window_closed'});

      let without = 0;
      FakePiAgent.promptHandler = async agent => {
        without = await scriptedLoop(agent, [answer('done')]);
        return [answer('done')];
      };
      const baseline = await typedRuntime().analyze('question', 'run-baseline', 'trace-pi',
        {analysisMode: 'fast', runId: 'run-baseline'});
      takeFinalizationContext(baseline)?.dispose();
      expect(withSupplement).toBeLessThanOrEqual(without);
      expect(withSupplement).toBe(1);
    });

    it('marks a supplement queued when the turn budget runs out as not_applied and sends no further request', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-turn-limit'});
      let requests = 0;
      FakePiAgent.promptHandler = async agent => {
        requests = await scriptedLoop(agent, [toolTurn(), toolTurn(), toolTurn()], async turn => {
          if (turn !== 1) return;
          channel.submit({idempotencyKey: 'key-1', text: 'at the limit'});
          await flushAsync();
        });
        return [answer('limit reached')];
      };
      takeFinalizationContext(await runWithChannel(channel, {env: {AGENT_QUICK_MAX_TURNS: '2'}}))?.dispose();
      // Submitted during the last permitted turn: the limit ended the loop before the boundary drained it.
      expect(channel.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'turn_budget'});
      expect(requests).toBe(2);
    });

    it('clears undelivered supplements before the correction prompt so they cannot contaminate it', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const channel = new RunSupplementChannel({runId: 'run-correction'});
      const queueDuringCorrection: unknown[][] = [];
      FakePiAgent.promptHandler = async (agent, _input, index) => {
        if (index === 2) {
          queueDuringCorrection.push([...agent.steeringQueue]);
          return [answer('The corrected final answer has a body.')];
        }
        channel.submit({idempotencyKey: 'key-1', text: 'never delivered'});
        await flushAsync();
        // A truncated answer with no tool call: finishTurn ends the turn with the supplement still queued.
        await (agent.options?.finishTurn as any)({message: answer('', 'length'), toolResults: []});
        return [answer('', 'length')];
      };
      takeFinalizationContext(await runWithChannel(channel))?.dispose();
      expect(channel.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'window_closed'});
      expect(queueDuringCorrection).toEqual([[]]);
      expect(FakePiAgent.instances[0].prompts.join('\n')).not.toContain('never delivered');
    });

    it('carries delivered supplements into the closeout prompt', async () => {
      passVerification();
      const trace = createFakeTraceProcessorService();
      trace.query.mockResolvedValue({columns: ['duration_ms'], rows: [{duration_ms: 23}], durationMs: 1});
      piClassifierResponses.push(
        classifierReply(piClassifierDecision), classifierReply(supplementDecision),
        {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Observed 23 ms.'}]},
      );
      const channel = new RunSupplementChannel({runId: 'run-closeout'});
      FakePiAgent.promptHandler = async agent => {
        const sql = agent.state.tools.find((tool: any) => tool.name === 'execute_sql') as any;
        await sql.execute('closeout-evidence', {sql: 'SELECT 23 AS duration_ms'});
        channel.submit({idempotencyKey: 'key-1', text: 'mention the 23 ms figure'});
        await flushAsync();
        const message = toolTurn();
        const pending = agent.drainSteeringForTest();
        for (const steered of pending) agent.emitForTest({type: 'message_end', message: steered});
        await (agent.options?.prepareRequest as any)?.({context: {messages: agent.state.messages, tools: []}}, undefined);
        agent.emitForTest({type: 'turn_end', message});
        expect(await (agent.options?.finishTurn as any)({message, toolResults: []})).toEqual({action: 'end'});
        return [message];
      };
      const result = await runWithChannel(channel, {
        runtime: typedRuntime({trace, env: {AGENT_QUICK_MAX_TURNS: '2'}}),
      });
      takeFinalizationContext(result)?.dispose();
      expect(channel.receipts()[0]).toMatchObject({state: 'delivered'});
      const closeoutPrompt = (piClassifierCalls[piClassifierCalls.length - 1] as any).context.messages[0].content;
      expect(closeoutPrompt).toContain('mention the 23 ms figure');
    });

    it('still carries delivered supplements into the closeout prompt when the closeout template is missing', async () => {
      passVerification();
      const trace = createFakeTraceProcessorService();
      trace.query.mockResolvedValue({columns: ['duration_ms'], rows: [{duration_ms: 23}], durationMs: 1});
      piClassifierResponses.push(
        classifierReply(piClassifierDecision), classifierReply(supplementDecision),
        {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Observed 23 ms.'}]},
      );
      const realRender = localizedStrategyTemplate.renderRequiredLocalizedStrategyTemplate;
      const render = jest.spyOn(localizedStrategyTemplate, 'renderRequiredLocalizedStrategyTemplate')
        .mockImplementation((name, language, vars) => {
          if (name === 'prompt-run-supplement-closeout') throw new Error('Required strategy template is missing');
          return realRender(name, language, vars);
        });
      const channel = new RunSupplementChannel({runId: 'run-closeout-fallback'});
      FakePiAgent.promptHandler = async agent => {
        const sql = agent.state.tools.find((tool: any) => tool.name === 'execute_sql') as any;
        await sql.execute('closeout-evidence', {sql: 'SELECT 23 AS duration_ms'});
        channel.submit({idempotencyKey: 'key-1', text: 'keep this note'});
        await flushAsync();
        for (const steered of agent.drainSteeringForTest()) agent.emitForTest({type: 'message_end', message: steered});
        const message = toolTurn();
        agent.emitForTest({type: 'turn_end', message});
        await (agent.options?.finishTurn as any)({message, toolResults: []});
        return [message];
      };
      try {
        const result = await runWithChannel(channel, {runtime: typedRuntime({trace, env: {AGENT_QUICK_MAX_TURNS: '2'}})});
        takeFinalizationContext(result)?.dispose();
      } finally { render.mockRestore(); }
      const closeoutPrompt = (piClassifierCalls[piClassifierCalls.length - 1] as any).context.messages[0].content;
      expect(closeoutPrompt).toContain('keep this note');
    });

    it('aborts an in-flight classification when the window closes, so no provider call outlives it', async () => {
      passVerification();
      const verdict = createDeferred<Record<string, unknown>>();
      piClassifierResponses.push(classifierReply(piClassifierDecision), verdict.promise as any);
      const channel = new RunSupplementChannel({runId: 'run-classification-abort'});
      let aborted: boolean | undefined;
      FakePiAgent.promptHandler = async () => {
        channel.submit({idempotencyKey: 'key-1', text: 'still classifying'});
        await flushAsync();
        const call = piClassifierCalls[piClassifierCalls.length - 1] as any;
        expect(call.options.signal.aborted).toBe(false);
        channel.closeAcquisition('window_closed');
        aborted = call.options.signal.aborted;
        verdict.resolve(classifierReply(supplementDecision));
        return [answer('done')];
      };
      takeFinalizationContext(await runWithChannel(channel))?.dispose();
      expect(aborted).toBe(true);
      expect(channel.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'window_closed'});
    });

    it('settles queued supplements as run_stopped when the run is aborted', async () => {
      passVerification();
      piClassifierResponses.push(classifierReply(piClassifierDecision), classifierReply(supplementDecision));
      const runId = 'run-abort';
      const channel = new RunSupplementChannel({runId});
      const never = createDeferred<unknown[]>();
      const entered = createDeferred<void>();
      FakePiAgent.promptHandler = async () => {
        channel.submit({idempotencyKey: 'key-1', text: 'abort me'});
        await flushAsync();
        // An aborted turn is a hard exit; it must not relabel the queued supplement as window_closed.
        await (FakePiAgent.instances[FakePiAgent.instances.length - 1].options?.finishTurn as any)({
          message: {role: 'assistant', stopReason: 'aborted', content: []}, toolResults: []});
        expect(channel.receipts()[0].state).toBe('queued');
        entered.resolve();
        return never.promise;
      };
      const runtime = typedRuntime();
      const running = runWithChannel(channel, {runtime});
      await entered.promise;
      expect(channel.receipts()[0].state).toBe('queued');
      await runtime.abortSession(runId);
      never.resolve([answer('late')]);
      await running.catch(() => undefined);
      expect(channel.receipts()[0]).toMatchObject({state: 'not_applied', reason: 'run_stopped'});
    });

    it('reports the run as unsupported when the loaded module cannot steer', async () => {
      passVerification();
      class ModuleWithoutSteer extends FakePiAgent {
        override steer = undefined as any;
      }
      const channel = new RunSupplementChannel({runId: 'run-no-steer'});
      const runtime = typedRuntime({loader: async () => ({Agent: ModuleWithoutSteer})});
      FakePiAgent.promptHandler = async () => [answer('done')];
      takeFinalizationContext(await runWithChannel(channel, {runtime}))?.dispose();
      expect(channel.isUnsupported).toBe(true);
      expect(channel.submit({idempotencyKey: 'key-2', text: 'late'})).toEqual({status: 'unsupported'});
    });

    it('leaves the request unchanged when no channel is issued', async () => {
      passVerification();
      FakePiAgent.promptHandler = async () => [answer('done')];
      const result = await typedRuntime().analyze('question', 'run-no-channel', 'trace-pi',
        {analysisMode: 'fast', runId: 'run-no-channel'});
      takeFinalizationContext(result)?.dispose();
      expect(FakePiAgent.instances[0].options?.steeringMode).toBeUndefined();
      expect(FakePiAgent.instances[0].state.messages.some((m: any) => m.role === 'user')).toBe(false);
    });
  });

});

describe('Pi catalog model references', () => {
  const reference = {providers: ['zai-coding-cn', 'zai'], id: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4'};

  it('parses a catalog reference into an attribution-only model and keeps credential fields', () => {
    const config = parsePiAgentCoreModelConfig(JSON.stringify({catalog: reference, apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      thinkingLevel: 'low'}));
    expect(config.catalog).toEqual(reference);
    expect(config.model).toEqual({id: 'glm-5.3-flash', baseUrl: reference.baseUrl});
    expect(config).toMatchObject({apiKeyEnv: 'ZAI_CODING_CN_API_KEY', thinkingLevel: 'low'});
  });

  it.each([
    [{catalog: reference, id: 'glm-5.3-flash'}, 'must not combine catalog'],
    [{catalog: {...reference, providers: []}}, 'builtin provider ids'],
    [{catalog: {...reference, providers: ['Bad Id']}}, 'builtin provider ids'],
    [{catalog: {...reference, id: ''}}, 'non-empty'],
    [{catalog: {...reference, baseUrl: 'ftp://x'}}, 'HTTP(S)'],
    [{catalog: {...reference, baseUrl: 'https://user:pw@host'}}, 'credential-free'],
    [{catalog: {...reference, extra: true}}, 'unknown fields'],
  ])('rejects an invalid catalog reference %j', (json, message) => {
    expect(() => parsePiAgentCoreModelConfig(JSON.stringify(json))).toThrow(message);
  });

  it('pins the key env, a rotated key and the installed SDK version in the runtime fingerprint', () => {
    const modelJson = JSON.stringify({catalog: reference, apiKeyEnv: 'ZAI_CODING_CN_API_KEY'});
    const first = piRuntimeFingerprintInput({SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: modelJson, ZAI_CODING_CN_API_KEY: 'k1'});
    const rotated = piRuntimeFingerprintInput({SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: modelJson, ZAI_CODING_CN_API_KEY: 'k2'});
    expect(first.entries).toContainEqual(['env:ZAI_CODING_CN_API_KEY', 'k1']);
    expect(first.entries).toContainEqual(['sdk:@earendil-works/pi-ai', installedPiAiVersion()]);
    expect(installedPiAiVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(rotated.entries).not.toEqual(first.entries);
  });

  it('resolves the first listed builtin provider that has the model and keeps the configured endpoint', async () => {
    const models: Record<string, Record<string, Record<string, unknown>>> = {
      zai: {'glm-5.3-flash': {id: 'glm-5.3-flash', provider: 'zai', baseUrl: 'https://api.z.ai'}},
      'zai-coding-cn': {'glm-5.3-flash': {id: 'glm-5.3-flash', provider: 'zai-coding-cn', baseUrl: 'https://coding'}},
    };
    const loader = jest.fn(async (_specifier: string) => ({
      getBuiltinModel: (provider: string, id: string) => models[provider]?.[id],
    }));
    await expect(resolvePiCatalogModel(reference, loader)).resolves.toEqual({id: 'glm-5.3-flash',
      provider: 'zai-coding-cn', baseUrl: reference.baseUrl});
    expect(loader).toHaveBeenCalledWith('@earendil-works/pi-ai/providers/all');
    await expect(resolvePiCatalogModel({providers: ['zai'], id: 'glm-4.7-flash'}, loader))
      .rejects.toThrow('Pi catalog has no model glm-4.7-flash under zai');
  });
});

describe('piRunThinkingLevel', () => {
  const gateway = {thinkingLevel: 'low', runThinkingFollowsScene: true} as const;

  it('keeps the authored level on every other route', () => {
    expect(piRunThinkingLevel({thinkingLevel: 'high'}, true, 'anr')).toBe('high');
    expect(piRunThinkingLevel({thinkingLevel: undefined}, false, 'anr')).toBe('off');
  });

  it('follows the budget and the scene strategy on a gateway', () => {
    expect(piRunThinkingLevel(gateway, true, 'general')).toBe('low');
    expect(piRunThinkingLevel(gateway, false, 'anr')).toBe('medium');
    expect(piRunThinkingLevel(gateway, false, 'general')).toBe('high');
    expect(piRunThinkingLevel(gateway, false, 'not-a-scene' as never)).toBe('high');
  });

  it('lets an operator override a full run but not a quick one', () => {
    expect(piRunThinkingLevel(gateway, false, 'general', 'low')).toBe('low');
    expect(piRunThinkingLevel(gateway, false, 'anr', 'max')).toBe('high');
    expect(piRunThinkingLevel(gateway, true, 'anr', 'high')).toBe('low');
  });

  it('keeps the scene effort for an unrecognized override', () => {
    expect(piRunThinkingLevel(gateway, false, 'anr', 'banana')).toBe('medium');
    expect(piRunThinkingLevel(gateway, false, 'general', ' LOW ')).toBe('low');
  });
});

describe('piContextNearlyFull', () => {
  const usage = (input: number, output = 0) => ({usage: {input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output} as never});

  it('stops acquisition once the reserve no longer fits', () => {
    expect(piContextNearlyFull(usage(90_000, 1_000), 128_000)).toBe(false);
    expect(piContextNearlyFull(usage(111_616), 128_000)).toBe(true);
    expect(piContextNearlyFull(usage(110_000, 1_616), 128_000)).toBe(true);
  });

  it('never fires without a window or usage', () => {
    expect(piContextNearlyFull(usage(500_000), 0)).toBe(false);
    expect(piContextNearlyFull({}, 128_000)).toBe(false);
  });
});
