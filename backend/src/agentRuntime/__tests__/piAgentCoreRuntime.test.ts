// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import type { StreamingUpdate } from '../../agent/types';
import {
  completePiAgentCoreFinalReportPhaseIfDelivered,
  createPiAgentCoreToolFromSharedSpec,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  getPiAgentCorePlanCompletionStatus,
  getPiAgentCoreEngineCapabilities,
  PI_AGENT_CORE_FAKE_STREAM_ENV,
  PI_AGENT_CORE_MODEL_JSON_ENV,
  PiAgentCoreRuntime,
  projectPiAgentCoreEventToStreamingUpdate,
  repairPiAgentCoreSubmitPlanArgs,
  sanitizePiAgentCoreConclusionText,
  selectAssistantConclusion,
  shouldContinuePiAgentCoreFinalReportAfterPlanComplete,
  verifyPiAgentCoreConclusionForCorrection,
  type PiAgentCoreEvent,
} from '../piAgentCoreRuntime';
import type { RuntimeToolResult, SharedToolSpec } from '../runtimeToolSpec';
import * as quickEvidenceDirectAnswer from '../quickEvidenceDirectAnswer';

async function loadFakePiProviderRuntime(
  config: {model: Record<string, unknown>},
) {
  return {
    model: config.model as any,
    models: {} as any,
    streamFn: jest.fn() as any,
  };
}

class FakePiAgent {
  static instances: FakePiAgent[] = [];
  static promptMessages: unknown[] | undefined;
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
      role: 'assistant',
      content: [{ type: 'text', text: 'Pi smoke final' }],
    };
    this.emit({ type: 'agent_start' });
    const messages = await FakePiAgent.promptHandler?.(this, input, this.promptCount)
      ?? FakePiAgent.promptMessages
      ?? [assistantMessage];
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', text: 'Pi smoke final' },
    });
    this.state.messages.push(...messages);
    this.emit({ type: 'agent_end', messages: this.state.messages });
  }

  abort(): void {}

  reset(): void {
    this.state.messages = [];
  }

  private emit(event: PiAgentCoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

beforeEach(() => {
  FakePiAgent.instances = [];
  FakePiAgent.promptMessages = undefined;
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
    });
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

    const result = await runtime.analyze('分析启动性能', 'session-pi-real', 'trace-pi', {
      analysisMode: 'full',
    });
    const agent = FakePiAgent.instances[0];
    const toolNames = agent.state.tools.map((tool: any) => tool.name);

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
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.claimSupport).toBeUndefined();
    expect(result.identityResolutions).toBeUndefined();
    expect(updates.map((update) => update.type)).toContain('architecture_detected');
    expect(updates.map((update) => update.type)).not.toContain('answer_token');
    expect(providerRuntimeLoader).toHaveBeenCalledTimes(1);
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

    await runtime.analyze('快速结合源码定位候选机制', 'session-pi-source-quick', 'trace-pi', {
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
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (traceId: string, sql: string) => {
      if (!sql.includes('sqlite_master')) return {columns: [], rows: [], durationMs: 1};
      return {
        columns: ['name'],
        rows: [[traceId === 'trace-current' ? 'android_current_only' : 'android_reference_only']],
        durationMs: 1,
      };
    });
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
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
    expect(agent.state.systemPrompt).toContain('## 对比模式');
    expect(agent.state.systemPrompt).toContain('### 窗口映射');
    expect(agent.state.systemPrompt).toContain('左侧/基线 Trace');
    expect(agent.state.systemPrompt).toContain('右侧/对比 Trace');
    expect(agent.state.systemPrompt).toContain('共有表/视图**: 0 个，不可直接对比');
    expect(agent.state.systemPrompt).toContain('android_current_only');
    expect(agent.state.systemPrompt).toContain('android_reference_only');
  });

  it('hydrates Pi agent-core transcript state from opaque snapshots on follow-up', async () => {
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
        role: 'assistant',
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
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First Pi answer' }],
          },
        ],
      }),
    });
    expect(restoredAgent.prompts[0]).toContain('follow-up question');
    expect(restoredAgent.prompts[0]).toContain('first question');
    expect(restoredAgent.prompts[0]).toContain('First Pi answer');
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
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
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
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
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
    expect(toolNames).not.toContain('submit_plan');
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.terminationReason).toBeUndefined();
  });

  it('answers default auto trace facts directly without loading the Pi SDK', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (_traceId: string, sql: string) => {
      expect(sql).toContain('runtime_cpu_core_count');
      return {
        columns: [
          'observed_cpu_count',
          'observed_cpus',
          'universe_source',
          'cpu_table_count',
          'cpu_table_cpus',
          'source_table',
        ],
        rows: [[
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'sched_observed',
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'sched_slice/thread_state',
        ]],
        durationMs: 2,
      };
    });
    const moduleLoader = jest.fn(async () => ({ Agent: FakePiAgent }));
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader,
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    const result = await runtime.analyze('这个 trace 的 CPU 有几个核心？', 'session-pi-auto-quick', 'trace-pi');

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(FakePiAgent.instances).toHaveLength(0);
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 0,
      stopReason: 'answered',
      evidence: {
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
    });
    expect(result.rounds).toBe(0);
    expect(result.conclusion).toContain('7 个 CPU 核心');
    expect(result.conclusionContract?.claims?.[0]?.references?.[0]).toMatchObject({
      column: 'observed_cpu_count',
      value: 7,
    });
    expect(result.terminationReason).toBeUndefined();
    expect(traceProcessorService.query).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.type)).toEqual([
      'data',
      'progress',
      'conclusion',
      'answer_token',
    ]);
  });

  it('answers acknowledgement follow-ups directly without loading the Pi SDK', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const moduleLoader = jest.fn(async () => ({ Agent: FakePiAgent }));
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader,
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    const updates: StreamingUpdate[] = [];
    runtime.on('update', (update) => updates.push(update));

    const result = await runtime.analyze('谢谢', 'session-pi-ack', 'trace-pi');

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(FakePiAgent.instances).toHaveLength(0);
    expect(traceProcessorService.query).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      conclusion: '收到。',
      confidence: 1,
      rounds: 0,
      quickRun: {
        requestedMode: 'auto',
        resolvedMode: 'quick',
        actualTurns: 0,
        stopReason: 'answered',
      },
    });
    expect(result.claimVerificationResult).toBeUndefined();
    expect(updates.map((update) => update.type)).toEqual([
      'progress',
      'conclusion',
      'answer_token',
    ]);
  });

  it('does not pre-run quick direct evidence for auto full scrolling diagnostics', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const moduleLoader = jest.fn(async () => ({ Agent: FakePiAgent }));
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader,
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.restoreArchitectureCache('trace-pi-full-scroll', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const directEvidence = jest.spyOn(
      quickEvidenceDirectAnswer,
      'buildRuntimeQuickEvidenceDirectAnswer',
    );

    try {
      const result = await runtime.analyze(
        '分析滑动性能',
        'session-pi-full-scroll',
        'trace-pi-full-scroll',
      );

      expect(directEvidence).not.toHaveBeenCalled();
      expect(moduleLoader).toHaveBeenCalledTimes(1);
      expect(FakePiAgent.instances).toHaveLength(1);
      expect(result.quickRun).toBeUndefined();
    } finally {
      directEvidence.mockRestore();
    }
  });

  it('skips focus detection for package-scoped trace fact fallback preparation', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const sqlQueries: string[] = [];
    traceProcessorService.query.mockImplementation(async (_traceId: string, sql: string) => {
      sqlQueries.push(sql);
      return { columns: [], rows: [], durationMs: 1 };
    });
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );
    runtime.restoreArchitectureCache('trace-pi', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });

    await runtime.analyze(
      '滑动 FPS 是多少？',
      'session-pi-package-fallback',
      'trace-pi',
      { packageName: 'com.example.app' },
    );

    expect(FakePiAgent.instances).toHaveLength(1);
    expect(FakePiAgent.instances[0].state.systemPrompt).toContain('com.example.app');
    expect(sqlQueries.some(sql => sql.includes('runtime_frame_metrics'))).toBe(true);
    expect(sqlQueries.some(sql => sql.includes('android_battery_stats_event_slices'))).toBe(false);
    expect(sqlQueries.some(sql => sql.includes('android_oom_adj_intervals'))).toBe(false);
  });

  it('keeps the final report when Pi emits trailing bookkeeping assistant text', async () => {
    FakePiAgent.promptMessages = [
      {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
        }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'All phases are complete. The analysis is done.' }],
      },
    ];
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const result = await runtime.analyze('分析启动性能', 'session-pi-report', 'trace-pi', {
      analysisMode: 'fast',
    });

    expect(result.conclusion).toContain('# 启动性能分析报告');
    expect(result.conclusion).toContain('ChaosTask');
    expect(result.conclusion).not.toContain('All phases are complete');
  });

  it('refreshes the final report when plan completion adds evidence without a new report', async () => {
    const correctedReport = buildVerifiedPiReport();
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (_traceId: string, sql: string) => (
      sql.includes('plan_completion_rows')
        ? {
            columns: ['value'],
            rows: Array.from({length: 60}, (_, index) => [index]),
            durationMs: 1,
          }
        : {columns: [], rows: [], durationMs: 1}
    ));
    const initialReport = [
      correctedReport,
      '',
      '## 初稿扩展边界',
      ...Array.from({length: 12}, (_, index) => (
        `- 初稿边界 ${index + 1}：该描述尚未吸收后续 SQL 补证结果。`
      )),
    ].join('\n');
    expect(initialReport.length).toBeGreaterThan(correctedReport.length);
    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        const submitPlan = agent.state.tools.find((tool: any) => tool.name === 'submit_plan') as any;
        await submitPlan.execute('plan-call', {
          phases: [{
            id: 'p1',
            name: '归纳性能证据',
            goal: '整理已采集证据的关键数值与边界',
            expectedTools: ['fetch_artifact'],
            expectedCalls: [{tool: 'fetch_artifact'}],
          }],
          successCriteria: '输出证据、根因、建议和限制完整的报告',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: initialReport}],
        }];
      }
      if (promptIndex === 2) {
        expect(input).toContain('"hasPlan": true');
        expect(input).toContain('"id": "p1"');
        const executeSql = agent.state.tools.find((tool: any) => tool.name === 'execute_sql') as any;
        await executeSql.execute('sql-artifact-source', {
          sql: 'SELECT value FROM plan_completion_rows',
        });
        const updatePlanPhase = agent.state.tools.find(
          (tool: any) => tool.name === 'update_plan_phase',
        ) as any;
        await updatePlanPhase.execute('phase-call', {
          phaseId: 'p1',
          status: 'completed',
          summary: '已归纳当前 trace 的关键耗时、代表样本和证据边界。',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: '证据阶段已闭合，等待生成更新后的最终报告。'}],
        }];
      }
      if (promptIndex === 3) {
        expect(input).toContain('"tool": "fetch_artifact"');
        const fetchArtifact = agent.state.tools.find(
          (tool: any) => tool.name === 'fetch_artifact',
        ) as any;
        await fetchArtifact.execute('artifact-call', {
          artifactId: 'art-1',
          detail: 'rows',
          offset: 0,
          limit: 50,
        });
        const updatePlanPhase = agent.state.tools.find(
          (tool: any) => tool.name === 'update_plan_phase',
        ) as any;
        await updatePlanPhase.execute('phase-after-artifact', {
          phaseId: 'p1',
          status: 'completed',
          summary: '已补齐 artifact 分页调用，并重新归纳了关键耗时与证据边界。',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: '必需 artifact 调用已补齐，plan 现在已完成。'}],
        }];
      }
      expect(input).toContain('Final Report Contract');
      return [{
        role: 'assistant',
        content: [{type: 'text', text: correctedReport}],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      traceProcessorService,
      {kind: 'pi-agent-core', source: 'env'},
      {
        env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON},
        moduleLoader: async () => ({Agent: FakePiAgent}),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-plan-completion',
      'trace-pi',
      {analysisMode: 'full'},
    );
    const agent = FakePiAgent.instances[0];

    expect(agent.promptCount).toBe(4);
    expect(result.conclusion).toBe(correctedReport);
    expect(result.partial).not.toBe(true);
    expect(result.terminationReason).toBeUndefined();
  });

  it('continues with tools to resolve hypotheses after the plan is complete', async () => {
    const report = buildVerifiedPiReport();
    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        await submitCompletedMinimalPlan(agent);
        const submitHypothesis = agent.state.tools.find(
          (tool: any) => tool.name === 'submit_hypothesis',
        ) as any;
        await submitHypothesis.execute('hypothesis-call', {
          id: 'h1',
          statement: '主线程同步重计算是代表帧超预算的直接原因',
          basis: '代表帧 ANIMATION 阶段同步执行 47-59ms',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: report}],
        }];
      }

      expect(input).toContain('"unresolvedHypotheses"');
      expect(input).toContain('"id": "h1"');
      const resolveHypothesis = agent.state.tools.find(
        (tool: any) => tool.name === 'resolve_hypothesis',
      ) as any;
      await resolveHypothesis.execute('resolve-hypothesis-call', {
        hypothesisId: 'h1',
        status: 'confirmed',
        evidence: '代表帧 ANIMATION 阶段同步执行 47-59ms，6/7 帧命中相同模式。',
      });
      return [{
        role: 'assistant',
        content: [{type: 'text', text: report}],
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

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-hypothesis-completion',
      'trace-pi',
      {analysisMode: 'full'},
    );

    expect(FakePiAgent.instances[0].promptCount).toBe(2);
    expect(result.hypotheses).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'h1', status: 'confirmed'}),
    ]));
    expect(result.partial).not.toBe(true);
    expect(result.terminationReason).toBeUndefined();
  });

  it('keeps a fresh hypothesis-resolution report after a process-only plan continuation', async () => {
    const report = buildVerifiedPiReport();
    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        const submitPlan = agent.state.tools.find((tool: any) => tool.name === 'submit_plan') as any;
        await submitPlan.execute('plan-call', {
          phases: [{
            id: 'p1',
            name: '闭合证据计划',
            goal: '完成已有证据的核对与收敛',
            expectedTools: [],
          }],
          successCriteria: '输出已验证的完整报告',
        });
        const submitHypothesis = agent.state.tools.find(
          (tool: any) => tool.name === 'submit_hypothesis',
        ) as any;
        await submitHypothesis.execute('hypothesis-call', {
          id: 'h1',
          statement: '主线程同步重计算是代表帧超预算的直接原因',
          basis: '代表帧 ANIMATION 阶段同步执行 47-59ms',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: '计划和假设已建立，准备闭合证据阶段。'}],
        }];
      }
      if (promptIndex === 2) {
        expect(input).toContain('"id": "p1"');
        const updatePlanPhase = agent.state.tools.find(
          (tool: any) => tool.name === 'update_plan_phase',
        ) as any;
        await updatePlanPhase.execute('phase-call', {
          phaseId: 'p1',
          status: 'completed',
          summary: '已有证据已核对，计划阶段完成。',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: '证据阶段已闭合，接下来处理未决假设。'}],
        }];
      }
      if (promptIndex === 3) {
        expect(input).toContain('"unresolvedHypotheses"');
        const resolveHypothesis = agent.state.tools.find(
          (tool: any) => tool.name === 'resolve_hypothesis',
        ) as any;
        await resolveHypothesis.execute('resolve-call', {
          hypothesisId: 'h1',
          status: 'confirmed',
          evidence: '代表帧 ANIMATION 阶段同步执行 47-59ms，6/7 帧命中相同模式。',
        });
        return [{
          role: 'assistant',
          content: [{type: 'text', text: report}],
        }];
      }
      throw new Error('fresh hypothesis report must not trigger another continuation');
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

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-hypothesis-fresh-report',
      'trace-pi',
      {analysisMode: 'full'},
    );

    expect(FakePiAgent.instances[0].promptCount).toBe(3);
    expect(result.conclusion).toBe(report);
    expect(result.partial).not.toBe(true);
    expect(result.terminationReason).toBeUndefined();
  });

  it('selects the latest shorter deliverable report instead of the longest stale draft', () => {
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
    ])).toBe(correctedReport);
  });

  it('does not reuse a stale draft when the bounded final-report continuation emits no report', async () => {
    const staleDraft = [
      buildVerifiedPiReport(),
      '',
      'blocked_function=do_epoll_wait 持续 120ms，证明磁盘 IO 是根因。',
    ].join('\n');
    const processOnlyReply = 'The continuation ended without a refreshed final report.';
    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        await submitCompletedMinimalPlan(agent);
        return [{
          role: 'assistant',
          content: [{type: 'text', text: staleDraft}],
        }];
      }
      if (promptIndex === 2) {
        expect(input).toContain('Final Report Contract');
        return [{
          role: 'assistant',
          content: [{type: 'text', text: processOnlyReply}],
        }];
      }
      throw new Error('text-only correction unavailable');
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

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-final-refresh-boundary',
      'trace-pi',
      {analysisMode: 'full'},
    );

    expect(result.conclusion).not.toContain('do_epoll_wait');
    expect(result.partial).toBe(true);
    expect(result.terminationReason).toBeDefined();
  });

  it('uses a shorter verified Pi correction produced with tools disabled', async () => {
    const originalReport = buildUnverifiedPiReport();
    const correctedReport = buildVerifiedPiReport();
    expect(originalReport.length).toBeGreaterThan(correctedReport.length);

    FakePiAgent.promptHandler = async (agent, input, promptIndex) => {
      if (promptIndex === 1) {
        await submitCompletedMinimalPlan(agent);
        return [{
          role: 'assistant',
          content: [{ type: 'text', text: originalReport }],
        }];
      }
      expect(input).toContain('验证反馈');
      expect(agent.state.tools).toEqual([]);
      expect(agent.state.systemPrompt).toContain('最终报告修正器');
      return [{
        role: 'assistant',
        content: [{ type: 'text', text: correctedReport }],
      }];
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-correction',
      'trace-pi',
      { analysisMode: 'full' },
    );
    const agent = FakePiAgent.instances[0];

    expect(agent.promptCount).toBe(2);
    expect(agent.state.tools.length).toBeGreaterThan(0);
    expect(result.conclusion).toBe(correctedReport);
    expect(result.partial).not.toBe(true);
    expect(result.terminationReason).toBeUndefined();
  });

  it('includes the scrolling scene contract in Pi correction verification', async () => {
    const originalReport = buildScrollingPiReport(false);

    const issues = await verifyPiAgentCoreConclusionForCorrection({
      conclusion: originalReport,
      plan: null,
      hypotheses: [],
      sceneType: 'scrolling',
      outputLanguage: 'zh-CN',
      query: '分析滑动性能',
      allowPersistentLearning: false,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('代表帧分析'),
      }),
    ]));
    const completeIssues = await verifyPiAgentCoreConclusionForCorrection({
      conclusion: buildScrollingPiReport(true),
      plan: null,
      hypotheses: [],
      sceneType: 'scrolling',
      outputLanguage: 'zh-CN',
      query: '分析滑动性能',
      allowPersistentLearning: false,
    });
    expect(completeIssues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Final Report Contract'),
      }),
    ]));
  });

  it('includes final quality-gate semantic issues in Pi correction verification', async () => {
    const issues = await verifyPiAgentCoreConclusionForCorrection({
      conclusion: [
        buildScrollingPiReport(true),
        '',
        '## 已排除因素',
        '主线程 D/DK 只有 1.7%，因此轻度磁盘 IO 阻塞不是本次掉帧根因。',
      ].join('\n'),
      plan: null,
      hypotheses: [],
      sceneType: 'scrolling',
      outputLanguage: 'zh-CN',
      query: '分析滑动性能',
      allowPersistentLearning: false,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('D/DK 只能说明不可中断等待'),
      }),
    ]));
  });

  it('includes missing dual-trace package identities in Pi correction verification', async () => {
    const issues = await verifyPiAgentCoreConclusionForCorrection({
      conclusion: [
        '# 双 Trace 性能分析报告',
        '',
        '## 综合结论',
        '',
        '当前侧 com.example.heavy 明显慢于右侧 demo。',
      ].join('\n'),
      plan: null,
      hypotheses: [],
      sceneType: 'general',
      outputLanguage: 'zh-CN',
      query: '对比两个 trace',
      allowPersistentLearning: false,
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('com.example.demo'),
      }),
    ]));
    expect(issues.filter(issue => issue.message.includes('com.example.demo'))).toHaveLength(1);
  });

  it('falls back to the original Pi report when text-only correction fails', async () => {
    const originalReport = buildUnverifiedPiReport();
    let correctionAttempts = 0;
    FakePiAgent.promptHandler = async (agent, _input, promptIndex) => {
      if (promptIndex === 1) {
        await submitCompletedMinimalPlan(agent);
        return [{
          role: 'assistant',
          content: [{ type: 'text', text: originalReport }],
        }];
      }
      correctionAttempts += 1;
      expect(agent.state.tools).toEqual([]);
      throw new Error('correction provider unavailable');
    };
    const runtime = new PiAgentCoreRuntime(
      createFakeTraceProcessorService(),
      { kind: 'pi-agent-core', source: 'env' },
      {
        env: { [PI_AGENT_CORE_MODEL_JSON_ENV]: PI_TEST_MODEL_JSON },
        moduleLoader: async () => ({ Agent: FakePiAgent }),
        providerRuntimeLoader: loadFakePiProviderRuntime,
      },
    );

    const result = await runtime.analyze(
      '分析系统性能问题',
      'session-pi-correction-failure',
      'trace-pi',
      { analysisMode: 'full' },
    );
    const agent = FakePiAgent.instances[0];

    expect(correctionAttempts).toBe(1);
    expect(agent.state.tools.length).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(result.conclusion).toBe(originalReport);
    expect(result.partial).toBe(true);
    expect(result.terminationMessage).toContain('缺少证据支撑');
    expect(result.terminationReason).not.toBe('execution_error');
  });

  it('strips Pi process narration before a deliverable final report heading', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'I have all the necessary knowledge and data. Now let me write the comprehensive final report.\n\n' +
      'Key findings: cold startup is dominated by ChaosTask.\n\n' +
      '# 启动性能分析报告\n\n' +
      '## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('# 启动性能分析报告')).toBe(true);
    expect(report).toContain('ChaosTask');
    expect(report).not.toContain('I have all the necessary');
    expect(report).not.toContain('Key findings:');
  });

  it('ignores Final Report Contract prose and starts at the actual Markdown report heading', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'The system is asking me to output the final report. Let me check what I need to include based on the Final Report Contract:\n\n' +
      '1. 启动类型与 TTID/TTFD\n' +
      '2. 阶段耗时分解\n\n' +
      'Let me now write the final report with all required elements.\n' +
      '## 综合结论\n\n' +
      '左侧冷启动 1338.65ms，右侧 301.84ms。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('## 综合结论')).toBe(true);
    expect(report).toContain('1338.65ms');
    expect(report).not.toContain('The system is asking me');
    expect(report).not.toContain('Final Report Contract');
  });

  it('does not treat a Final Report Contract heading as the delivered report', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'Let me verify the remaining contract.\n' +
      '## Final Report Contract：综合结论、证据链必须完整\n\n' +
      'The contract is now checked.\n' +
      '## 综合结论\n\n' +
      '冷启动耗时 1338.65ms。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('## 综合结论')).toBe(true);
    expect(report).not.toContain('Final Report Contract');
  });

  it('preserves a bare Chinese analysis-report title as the report boundary', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'Let me now write the report.\n\n' +
      '启动性能分析报告\n\n' +
      '综合结论：冷启动耗时 1338.65ms。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('启动性能分析报告')).toBe(true);
    expect(report).not.toContain('Let me now write');
  });

  it('does not treat a Chinese report-writing instruction as the report boundary', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'Let me prepare the report.\n' +
      '请输出启动性能分析报告\n\n' +
      '## 1. 综合结论\n\n' +
      '冷启动耗时 1338.65ms。[Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('## 1. 综合结论')).toBe(true);
    expect(report).not.toContain('请输出');
  });

  it('preserves a descriptive English Markdown report heading', () => {
    const report = sanitizePiAgentCoreConclusionText(
      'Let me now write the report.\n\n' +
      '# Final Report for Startup\n\n' +
      'Cold startup took 1338.65ms. [Evidence:data:skill:startup_analysis:test]',
    );

    expect(report.startsWith('# Final Report for Startup')).toBe(true);
    expect(report).not.toContain('Let me now write');
  });

  it('auto-closes the final Pi report phase when the complete report is delivered', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动概览采集',
          goal: '获取启动事件',
          expectedTools: ['invoke_skill'],
          status: 'completed',
          summary: '已获取 startup_analysis 关键启动事件、TTID 和冷启动类型证据。',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '基于根因诊断决策树，输出完整结构化报告',
          expectedTools: ['lookup_knowledge'],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '输出完整结构化报告',
      submittedAt: 1,
      toolCallLog: [{
        toolName: 'invoke_skill',
        timestamp: 10,
        success: true,
        matchedPhaseId: 'p1',
      }],
    } as any;

    const closed = completePiAgentCoreFinalReportPhaseIfDelivered(
      plan,
      '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
      'zh-CN',
      () => 1234,
    );

    expect(closed?.id).toBe('p3');
    expect(plan.phases[1]).toMatchObject({
      status: 'completed',
      completedAt: 1234,
    });
    expect(plan.phases[1].summary.length).toBeGreaterThanOrEqual(15);
    expect(getPiAgentCorePlanCompletionStatus(plan).complete).toBe(true);
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

  it('continues Pi final report generation when completed plan still misses the scene contract', () => {
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(shouldContinuePiAgentCoreFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
      conclusion: [
        '# 滑动性能分析报告',
        '',
        '## 1. 概览',
        '真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 全帧根因分布',
        '| 根因 | 帧数 | 占比 |',
        '| --- | ---: | ---: |',
        '| animation 同步阻塞 | 6 | 86% |',
      ].join('\n'),
    })).toBe(true);
  });

  it('does not continue Pi final report generation once the scene contract is satisfied', () => {
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(shouldContinuePiAgentCoreFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
      conclusion: [
        '# 滑动性能分析报告',
        '',
        '## 1. 概览',
        '真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 全帧根因分布',
        '| 根因 | 帧数 | 占比 |',
        '| --- | ---: | ---: |',
        '| animation 同步阻塞 | 6 | 86% |',
        '',
        '### 代表帧分析',
        '- 代表帧 frame_id=59665219：帧耗时 62.73ms，vsync_missed=7，超预算 54.4ms。关键 slice 为 CustomScroll_longFrameLoad 59.01ms。[Evidence:data:skill:scrolling_analysis:batch_frame_root_cause:test]',
        '',
        '### 峰值/口径指标',
        '- 真实掉帧 7 帧，最长帧 62.73ms。',
        '',
        '### 优化建议',
        '- 将 animation 回调里的同步重活拆分到后台线程，并用分帧提交结果；该建议直接覆盖 6/7 个掉帧样本。',
      ].join('\n'),
    })).toBe(false);
  });

  it('does not auto-close Pi final phase while earlier phases remain pending', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动概览采集',
          goal: '获取启动事件',
          expectedTools: ['invoke_skill'],
          status: 'pending',
          summary: '',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整结构化报告',
          expectedTools: ['lookup_knowledge'],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '输出完整结构化报告',
      submittedAt: 1,
      toolCallLog: [],
    } as any;

    const closed = completePiAgentCoreFinalReportPhaseIfDelivered(
      plan,
      '# 启动性能分析报告\n\n## 1. 概览\n冷启动由 ChaosTask 主导。[Evidence:data:skill:startup_analysis:test]',
      'zh-CN',
      () => 1234,
    );

    expect(closed).toBeUndefined();
    expect(getPiAgentCorePlanCompletionStatus(plan).complete).toBe(false);
  });
});
