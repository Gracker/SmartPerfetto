// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OpenAIChatCompletionsModel, Runner, withTrace } from '@openai/agents';
import { OpenAIRuntime, __testing } from '../openAiRuntime';
import type { AnalysisPlanV3, PlanPhase } from '../../agentv3/types';
import type { OpenAIAgentConfig } from '../../agentRuntime/engines/openai/openAiConfig';
import * as patternMemory from '../../agentv3/analysisPatternMemory';
import { createAnalysisRunSpec } from '../../agentRuntime/analysisRunSpec';
import type { QueryResult, TraceProcessorService } from '../../services/traceProcessorService';
import {getSourceLookupCodeReferences} from '../../services/codebase/sourceLookupTools';
import {assessFinalReportContractCompleteness} from '../../services/finalReportContractGate';

afterEach(() => {
  jest.restoreAllMocks();
});

function phase(id: string, status: PlanPhase['status']): PlanPhase {
  const p: PlanPhase = {
    id,
    name: `Phase ${id}`,
    goal: `Goal ${id}`,
    expectedTools: ['invoke_skill'],
    status,
  };
  if (status === 'completed' || status === 'skipped') {
    p.summary = `Evidence summary for ${id}`;
  }
  return p;
}

function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {
    phases,
    successCriteria: 'Complete every phase before final answer',
    submittedAt: Date.now(),
    toolCallLog: phases.flatMap((phase, index) => {
      if (
        phase.status !== 'completed' ||
        (phase.expectedCalls ?? []).length > 0 ||
        (phase.expectedTools ?? []).length === 0
      ) {
        return [];
      }
      return [{
        toolName: phase.expectedTools[0],
        timestamp: index + 1,
        success: true,
        matchedPhaseId: phase.id,
      }];
    }),
  };
}

function startupFinalReportForReconciliation(): string {
  return [
    '## 综合结论',
    '',
    '本次为冷启动，TTID=1912ms，TTFD 数据不可用；当前 trace 的首帧延迟主要来自主线程同步负载。',
    '',
    '## 阶段耗时分解',
    '',
    'startup_detail 显示 ChaosTask self_ms=456ms，LoadSimulator self_ms=457ms，合计占启动窗口 68%。',
    '',
    '## 根因拆解',
    '',
    'A4 主线程重任务与当前 trace 的 Running 证据一致，证据引用 art-10 和 art-32。',
    '',
    '## App/系统分层建议',
    '',
    '- App 层：拆分首帧前同步任务，并延迟非关键初始化。',
    '- 系统/平台层：当前 trace 未发现可确认的平台瓶颈，保持监测。',
  ].join('\n');
}

type RawOpenAiOutputTextDeltaForTest = {
  type: 'raw_model_stream_event';
  data: {
    type: 'output_text_delta';
    delta: string;
  };
};

type OpenAiStreamContextForTest = {
  sessionId: string;
  quickMode: boolean;
  answerStreamFilter: ReturnType<typeof __testing.createOpenAiReasoningFilterState>;
  toolInputsByTaskId: Map<string, { toolName: string; args: Record<string, unknown> }>;
  onSuppressedAnswerDelta?: (delta: string) => void;
};

function rawOutputTextDelta(delta: string): RawOpenAiOutputTextDeltaForTest {
  return {
    type: 'raw_model_stream_event',
    data: {
      type: 'output_text_delta',
      delta,
    },
  };
}

function streamContext(sessionId: string, quickMode: boolean): OpenAiStreamContextForTest {
  return {
    sessionId,
    quickMode,
    answerStreamFilter: __testing.createOpenAiReasoningFilterState(),
    toolInputsByTaskId: new Map(),
  };
}

type OpenAiModeClassificationForTest = {
  quickMode: boolean;
  source: 'user_explicit' | 'hard_rule' | 'ai';
  reason?: string;
  skipQuickTracePreflightDetection: boolean;
  quickAcknowledgementDirectAnswer: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
};

type OpenAiPrepareContextForTest = {
  tools: unknown[];
  allowedTools: string[];
  systemPrompt: string;
  directTraceFactAnswer?: { conclusion: string };
  quickMemoryContextCounts?: Record<string, unknown>;
};

type OpenAiRuntimeAnalysisResultForTest = {
  quickRun?: unknown;
  rounds?: number;
  conclusion?: string;
  conclusionContract?: {
    claims?: Array<{ references?: Array<Record<string, unknown>> }>;
  };
  partial?: boolean;
  terminationReason?: string;
  findings?: unknown[];
};

type OpenAiRuntimeSnapshotForTest = {
  sdkSessionId?: string;
  openAILastResponseId?: string;
  openAIHistory?: unknown;
  openAIRunState?: string;
  engineState?: {
    kind?: string;
    provider?: unknown;
    openai: {
      history?: unknown;
      lastResponseId?: string;
      runState?: string;
    };
  };
  referenceTraceId?: string;
  comparisonSource?: string;
};

type OpenAiSessionMapEntryForTest = Record<string, unknown>;

type OpenAiRuntimeTestAccess = {
  on: (event: 'update', listener: (update: OpenAiStreamingUpdateForTest) => void) => void;
  analyze: (...args: unknown[]) => Promise<OpenAiRuntimeAnalysisResultForTest>;
  classifyModeForRequest: (...args: unknown[]) => Promise<OpenAiModeClassificationForTest>;
  prepareAnalysisContext: (...args: unknown[]) => Promise<OpenAiPrepareContextForTest>;
  detectArchitecture: (...args: unknown[]) => Promise<unknown>;
  detectVendor: (...args: unknown[]) => Promise<string | null>;
  getPlanCompletionStatus: (...args: unknown[]) => unknown;
  shouldFinalizeAfterPlanComplete: (...args: unknown[]) => boolean;
  reconcileCompletedConclusionPhase: (...args: unknown[]) => boolean;
  shouldRequestFinalReportAfterPlanComplete: (...args: unknown[]) => boolean;
  buildFinalReportAfterPlanCompletePrompt: (...args: unknown[]) => string;
  formatPlanContinuationMessage: (...args: unknown[]) => string;
  formatPlanCompleteReportContinuationMessage: (...args: unknown[]) => string;
  buildCompletedPlanFallbackConclusion: (...args: unknown[]) => string | undefined;
  buildPlanPhaseSummaryFallbackConclusion: (...args: unknown[]) => string | undefined;
  handleStreamEvent: (...args: unknown[]) => string;
  recordMaxTurnsPartialResult: (...args: unknown[]) => OpenAiRuntimeAnalysisResultForTest;
  recordPatternMemory: (...args: unknown[]) => void;
  getSdkSessionId: (...args: unknown[]) => string | undefined;
  forgetOpenAILastResponseId: (...args: unknown[]) => void;
  takeSnapshot: (...args: unknown[]) => OpenAiRuntimeSnapshotForTest;
  restoreFromSnapshot: (...args: unknown[]) => void;
  restoreSessionMapping: (...args: unknown[]) => void;
  registerAbortHandle: (
    sessionId: string,
    handle: {readonly aborted: boolean; abort(): void},
  ) => () => void;
  resetAnalysisSessionState: (sessionId: string) => unknown;
  sessionPlans: Map<string, {
    current: AnalysisPlanV3 | null;
    history: AnalysisPlanV3[];
    prePlanToolCallLog?: AnalysisPlanV3['toolCallLog'];
  }>;
  sessionSqlErrors: Set<string>;
  sessionMap: Map<string, OpenAiSessionMapEntryForTest>;
};

type TraceQueryForOpenAiTest = (traceId: string, sql: string) => Promise<QueryResult>;
type TraceGetForOpenAiTest = (traceId: string) => undefined;
type TraceProcessorForOpenAiTest = TraceProcessorService & {
  query: jest.MockedFunction<TraceQueryForOpenAiTest>;
  getTrace: jest.MockedFunction<TraceGetForOpenAiTest>;
};

type OpenAiStreamingUpdateForTest = {
  type?: string;
  content?: {
    done?: boolean;
    message?: unknown;
    token?: string;
    [key: string]: unknown;
  };
};

function createOpenAiConfigForTest(): OpenAIAgentConfig {
  return {
    model: 'test-model',
    lightModel: 'test-light-model',
    maxOutputTokens: 1024,
    maxTurns: 3,
    quickMaxTurns: 1,
    quickTargetTurns: 1,
    protocol: 'responses',
    cwd: process.cwd(),
    fullPathPerTurnMs: 60_000,
    fullRequestTimeoutMs: 20 * 60_000,
    streamIdleTimeoutMs: 5 * 60_000,
    maxHistoryBytes: 4 * 1024 * 1024,
    quickPathPerTurnMs: 30_000,
    classifierTimeoutMs: 10_000,
    outputLanguage: 'zh-CN',
  };
}

function createOpenAiRuntimeForTest(
  traceProcessor = createTraceProcessorForOpenAiPrepareTest(),
): OpenAiRuntimeTestAccess {
  return new OpenAIRuntime(traceProcessor) as unknown as OpenAiRuntimeTestAccess;
}

function createRuntimeWithUpdates(): {
  runtime: OpenAiRuntimeTestAccess;
  updates: OpenAiStreamingUpdateForTest[];
} {
  const runtime = createOpenAiRuntimeForTest();
  const updates: OpenAiStreamingUpdateForTest[] = [];
  runtime.on('update', update => updates.push(update));
  return { runtime, updates };
}

function createTraceProcessorForOpenAiPrepareTest(): TraceProcessorForOpenAiTest {
  return {
    query: jest.fn<TraceQueryForOpenAiTest>(async () => ({ columns: [], rows: [], durationMs: 0 })),
    getTrace: jest.fn(() => undefined),
  } as unknown as TraceProcessorForOpenAiTest;
}

describe('OpenAIRuntime analysis cancellation scope', () => {
  it('aborts every provider request linked to the active analysis', () => {
    const scope = new __testing.RuntimeAnalysisAbortScope();
    const first = scope.createLinkedController();
    const second = scope.createLinkedController();

    scope.abort();

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
  });

  it('pre-aborts provider requests created after cancellation', () => {
    const scope = new __testing.RuntimeAnalysisAbortScope();
    scope.abort();

    const late = scope.createLinkedController();

    expect(late.controller.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).toThrow('Analysis aborted');
  });

  it('does not retain completed provider-request listeners', () => {
    const scope = new __testing.RuntimeAnalysisAbortScope();
    const completed = scope.createLinkedController();
    completed.dispose();

    scope.abort();

    expect(completed.controller.signal.aborted).toBe(false);
  });

  it('inherits cancellation across a retry scope handoff', () => {
    const runtime = createOpenAiRuntimeForTest();
    const first = new __testing.RuntimeAnalysisAbortScope();
    runtime.registerAbortHandle('session-a', first);
    first.abort();
    const retry = new __testing.RuntimeAnalysisAbortScope();

    runtime.registerAbortHandle('session-a', retry);

    expect(retry.aborted).toBe(true);
    expect(() => retry.throwIfAborted()).toThrow('Analysis aborted');
  });

  it('does not commit success when cancellation arrives while the provider is closing', async () => {
    const scope = new __testing.RuntimeAnalysisAbortScope();
    let releaseClose: (() => void) | undefined;
    const closePending = new Promise<void>(resolve => {
      releaseClose = resolve;
    });
    let committed = false;

    const result = __testing.commitAfterProviderClose(
      () => closePending,
      scope,
      () => {
        committed = true;
        return 'committed';
      },
    );
    scope.abort();
    releaseClose?.();

    await expect(result).rejects.toThrow('Analysis aborted');
    expect(committed).toBe(false);
  });

  it('commits success only after the provider has closed', async () => {
    const scope = new __testing.RuntimeAnalysisAbortScope();
    const order: string[] = [];

    const result = await __testing.commitAfterProviderClose(
      async () => {
        order.push('close');
      },
      scope,
      () => {
        order.push('commit');
        return 'committed';
      },
    );

    expect(result).toBe('committed');
    expect(order).toEqual(['close', 'commit']);
  });
});

type OpenAiSessionContextForPrepareTest = {
  getAllTurns: jest.MockedFunction<() => unknown[]>;
  generatePromptContext: jest.MockedFunction<() => string>;
  generateRecentSqlResultPromptContext: jest.MockedFunction<(maxTurns?: number) => string>;
  getEntityStore: jest.MockedFunction<() => {
    getStats: () => { totalEntityCount: number };
    getAllFrames: () => unknown[];
    getAllSessions: () => unknown[];
  }>;
};

function createSessionContextForOpenAiPrepareTest(): OpenAiSessionContextForPrepareTest {
  return {
    getAllTurns: jest.fn(() => []),
    generatePromptContext: jest.fn(() => ''),
    generateRecentSqlResultPromptContext: jest.fn(() => ''),
    getEntityStore: jest.fn(() => ({
      getStats: () => ({ totalEntityCount: 0 }),
      getAllFrames: () => [],
      getAllSessions: () => [],
    })),
  };
}

function createOpenAiAnalysisRunSpecForTest(input: {
  query: string;
  sessionId: string;
  traceId: string;
  analysisMode?: 'fast' | 'full' | 'auto';
}) {
  return createAnalysisRunSpec({
    query: input.query,
    sessionId: input.sessionId,
    traceId: input.traceId,
    options: input.analysisMode ? { analysisMode: input.analysisMode } : {},
    runtimeSelection: { kind: 'openai-agents-sdk', source: 'default' },
    sceneType: 'general',
    outputLanguage: 'zh-CN',
    previousTurns: [],
    resolvedMode: input.analysisMode === 'full' ? 'full' : 'quick',
    budget: {
      model: 'deepseek-v4-pro',
      lightModel: 'deepseek-v4-flash',
      maxTurns: 3,
      quickMaxTurns: 1,
      quickTargetTurns: 1,
      maxOutputTokens: 1024,
      fullPathPerTurnMs: 60_000,
      quickPathPerTurnMs: 30_000,
      classifierTimeoutMs: 10_000,
    },
  });
}

describe('OpenAIRuntime quick mode classification metadata', () => {
  it('marks auto acknowledgement follow-ups for zero-turn direct answers', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      '谢谢',
      's-openai-auto-ack',
      'trace-openai-auto-ack',
      {},
      'general',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      quickAcknowledgementDirectAnswer: true,
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('keeps pure acknowledgement follow-ups direct even when a reference trace is attached', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      '谢谢',
      's-openai-auto-ack-reference',
      'trace-openai-auto-ack-reference',
      { referenceTraceId: 'trace-reference' },
      'general',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      quickAcknowledgementDirectAnswer: true,
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('marks explicit fast acknowledgement follow-ups for zero-turn direct answers', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      'ok',
      's-openai-fast-ack',
      'trace-openai-fast-ack',
      { analysisMode: 'fast' },
      'general',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      quickAcknowledgementDirectAnswer: true,
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('marks explicit fast identity fact lookups for quick preflight skip', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      '这个 trace 的应用包名和主要进程是什么？',
      's-openai-fast-identity',
      'trace-openai-fast-identity',
      { analysisMode: 'fast' },
      'scrolling',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      reason: 'user requested fast',
      skipQuickTracePreflightDetection: true,
    }));
  });

  it('keeps explicit fast reference-trace identity lookups off single-trace pre-evidence', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      '这个 trace 的应用包名和主要进程是什么？',
      's-openai-fast-identity-reference',
      'trace-openai-fast-identity-reference',
      { analysisMode: 'fast', referenceTraceId: 'trace-reference' },
      'scrolling',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      reason: 'user requested fast',
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
    }));
  });

  it('keeps explicit fast reference-trace scrolling overviews off scrolling triage pre-evidence', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      'scroll jank overview and smoothness',
      's-openai-fast-scroll-reference',
      'trace-openai-fast-scroll-reference',
      { analysisMode: 'fast', referenceTraceId: 'trace-reference' },
      'scrolling',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      reason: 'user requested fast',
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
    }));
  });

  it('does not skip quick preflight for explicit fast diagnostic questions', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      '分析滑动性能并给优化建议',
      's-openai-fast-diagnostic',
      'trace-openai-fast-diagnostic',
      { analysisMode: 'fast' },
      'scrolling',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      skipQuickTracePreflightDetection: false,
    }));
  });

  it('marks auto identity hard-rule lookups for quick preflight skip', async () => {
    const runtime = createOpenAiRuntimeForTest();

    const result = await runtime.classifyModeForRequest(
      'What are the package name and main process for this trace?',
      's-openai-auto-identity',
      'trace-openai-auto-identity',
      {},
      'general',
      createOpenAiConfigForTest(),
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      reason: 'trace identity fact lookup',
      skipQuickTracePreflightDetection: true,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('marks supported trace fact hard-rule lookups for quick trace evidence', async () => {
    const runtimeWithPrivates = createOpenAiRuntimeForTest();

    const result = await runtimeWithPrivates.classifyModeForRequest(
      '滑动 FPS 是多少？',
      's-openai-auto-trace-fact',
      'trace-openai-auto-trace-fact',
      {},
      'scrolling',
      {},
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      reason: 'trace fact lookup',
      skipQuickTracePreflightDetection: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
    }));
  });

  it('uses scoped trace fact pre-evidence and skips quick preflight when a selection context is present', async () => {
    const runtimeWithPrivates = createOpenAiRuntimeForTest();

    const result = await runtimeWithPrivates.classifyModeForRequest(
      '这个 trace 一共有多少帧？',
      's-openai-auto-trace-fact-selection',
      'trace-openai-auto-trace-fact-selection',
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 1,
          endNs: 2,
        },
      },
      'scrolling',
      {},
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      reason: 'trace fact lookup',
      skipQuickTracePreflightDetection: true,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: true,
    }));
  });

  it('does not use global process identity pre-evidence when a selection context is present in auto mode', async () => {
    const runtimeWithPrivates = createOpenAiRuntimeForTest();

    const result = await runtimeWithPrivates.classifyModeForRequest(
      '这个选区的应用包名和主要进程是什么？',
      's-openai-auto-identity-selection',
      'trace-openai-auto-identity-selection',
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 1,
          endNs: 2,
        },
      },
      'scrolling',
      {},
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      reason: 'trace identity fact lookup',
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('does not use global process identity pre-evidence when a selection context is present in fast mode', async () => {
    const runtimeWithPrivates = createOpenAiRuntimeForTest();

    const result = await runtimeWithPrivates.classifyModeForRequest(
      '选区里的 PID 是多少？',
      's-openai-fast-identity-selection',
      'trace-openai-fast-identity-selection',
      {
        analysisMode: 'fast',
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 1,
          endNs: 2,
        },
      },
      'scrolling',
      {},
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'user_explicit',
      reason: 'user requested fast',
      skipQuickTracePreflightDetection: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
    }));
  });

  it('marks mixed identity and trace fact lookups for both runtime evidence sources', async () => {
    const runtimeWithPrivates = createOpenAiRuntimeForTest();

    const result = await runtimeWithPrivates.classifyModeForRequest(
      'PID 和滑动 FPS 是多少？',
      's-openai-auto-mixed-facts',
      'trace-openai-auto-mixed-facts',
      {},
      'scrolling',
      {},
    );

    expect(result).toEqual(expect.objectContaining({
      quickMode: true,
      source: 'hard_rule',
      reason: 'trace identity fact lookup',
      skipQuickTracePreflightDetection: true,
      quickProcessIdentityPreEvidence: true,
      quickTraceFactPreEvidence: true,
    }));
  });

  it('restores vendor and architecture preflight when identity-only evidence is unusable', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    const runtime = createOpenAiRuntimeForTest(traceProcessor);
    const detectArchitecture = jest.spyOn(runtime, 'detectArchitecture')
      .mockResolvedValue({ type: 'Standard', confidence: 0.9, evidence: [] });
    const detectVendor = jest.spyOn(runtime, 'detectVendor')
      .mockResolvedValue('xiaomi');
    const sessionContext = createSessionContextForOpenAiPrepareTest();

    const context = await runtime.prepareAnalysisContext(
      '这个 trace 的应用包名和主要进程是什么？',
      's-openai-preflight-identity',
      'trace-openai-preflight-identity',
      { analysisMode: 'fast' },
      {
        config: { outputLanguage: 'zh-CN' },
        sceneType: 'general',
        lightweight: true,
        analysisRunSpec: createOpenAiAnalysisRunSpecForTest({
          query: '这个 trace 的应用包名和主要进程是什么？',
          sessionId: 's-openai-preflight-identity',
          traceId: 'trace-openai-preflight-identity',
          analysisMode: 'fast',
        }),
        sessionContext,
        previousTurns: [],
        skipQuickTracePreflightDetection: true,
        quickProcessIdentityPreEvidence: true,
      },
    );

    expect(detectArchitecture).toHaveBeenCalledWith('trace-openai-preflight-identity', undefined);
    expect(detectVendor).toHaveBeenCalledWith('trace-openai-preflight-identity');
    expect(sessionContext.generateRecentSqlResultPromptContext).toHaveBeenCalledWith(3);
    expect(context.quickMemoryContextCounts).toEqual(expect.objectContaining({
      recentSqlResults: expect.any(Number),
      patternHints: expect.any(Number),
    }));
    expect(runtime.sessionSqlErrors.has('s-openai-preflight-identity')).toBe(true);
  });

  it('uses trace fact pre-evidence without loading quick tools when evidence is complete', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    traceProcessor.query.mockImplementation(async (_traceId: string, sql: string) => {
      if (sql.includes('runtime_frame_metrics')) {
        return {
          columns: [
            'package_name',
            'process_names',
            'upid_count',
            'total_frames',
            'window_start_ns',
            'window_end_ns',
            'duration_s',
            'fps',
            'source_table',
          ],
          rows: [[
            'com.example.app',
            'com.example.app',
            1,
            347,
            10,
            4_449_374_956,
            4.449375,
            77.99,
            'actual_frame_timeline_slice',
          ]],
          durationMs: 2,
        };
      }
      return { columns: [], rows: [], durationMs: 0 };
    });
    const runtime = new OpenAIRuntime(traceProcessor);
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));
    const runtimeWithPrivates = runtime as unknown as {
      detectArchitecture: (...args: unknown[]) => Promise<unknown>;
      detectVendor: (...args: unknown[]) => Promise<unknown>;
      prepareAnalysisContext: (...args: unknown[]) => Promise<{
        tools: unknown[];
        allowedTools: string[];
        systemPrompt: string;
        directTraceFactAnswer?: { conclusion: string };
      }>;
    };
    const detectArchitecture = jest.spyOn(runtimeWithPrivates, 'detectArchitecture')
      .mockResolvedValue({ type: 'Standard', confidence: 0.9, evidence: [] });
    const detectVendor = jest.spyOn(runtimeWithPrivates, 'detectVendor')
      .mockResolvedValue('xiaomi');
    const sessionContext = createSessionContextForOpenAiPrepareTest();

    const context = await runtimeWithPrivates.prepareAnalysisContext(
      '滑动 FPS 是多少？',
      's-openai-preflight-trace-fact',
      'trace-openai-preflight-trace-fact',
      { analysisMode: 'fast', packageName: 'com.example.app' },
      {
        config: { outputLanguage: 'zh-CN' },
        sceneType: 'scrolling',
        lightweight: true,
        analysisRunSpec: createOpenAiAnalysisRunSpecForTest({
          query: '滑动 FPS 是多少？',
          sessionId: 's-openai-preflight-trace-fact',
          traceId: 'trace-openai-preflight-trace-fact',
          analysisMode: 'fast',
        }),
        sessionContext,
        previousTurns: [],
        skipQuickTracePreflightDetection: true,
        quickTraceFactPreEvidence: true,
      },
    );

    expect(detectArchitecture).not.toHaveBeenCalled();
    expect(detectVendor).not.toHaveBeenCalled();
    expect(context.tools).toHaveLength(0);
    expect(context.allowedTools).toEqual([]);
    expect(context.systemPrompt).toBe('');
    expect(context.directTraceFactAnswer?.conclusion).toContain('77.99 FPS');
    expect(sessionContext.generateRecentSqlResultPromptContext).not.toHaveBeenCalled();
    expect(sessionContext.generatePromptContext).not.toHaveBeenCalled();
    expect(sessionContext.getEntityStore).not.toHaveBeenCalled();
    expect(traceProcessor.getTrace).not.toHaveBeenCalled();
    expect(traceProcessor.query).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'data',
      content: [expect.objectContaining({
        meta: expect.objectContaining({
          source: 'runtime_trace_fact:frame_metrics',
          intent: 'runtime_trace_fact_lookup',
        }),
      })],
    }));
  });

  it('skips focus detection for global trace fact pre-evidence', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    traceProcessor.query.mockImplementation(async (_traceId: string, sql: string) => {
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
    const runtime = new OpenAIRuntime(traceProcessor);
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));
    const runtimeWithPrivates = runtime as unknown as {
      detectArchitecture: (...args: unknown[]) => Promise<unknown>;
      detectVendor: (...args: unknown[]) => Promise<unknown>;
      prepareAnalysisContext: (...args: unknown[]) => Promise<{
        tools: unknown[];
        allowedTools: string[];
        systemPrompt: string;
        directTraceFactAnswer?: { conclusion: string };
      }>;
    };
    const detectArchitecture = jest.spyOn(runtimeWithPrivates, 'detectArchitecture')
      .mockResolvedValue({ type: 'Standard', confidence: 0.9, evidence: [] });
    const detectVendor = jest.spyOn(runtimeWithPrivates, 'detectVendor')
      .mockResolvedValue('xiaomi');
    const sessionContext = createSessionContextForOpenAiPrepareTest();

    const context = await runtimeWithPrivates.prepareAnalysisContext(
      'CPU 有几核？',
      's-openai-preflight-global-trace-fact',
      'trace-openai-preflight-global-trace-fact',
      { analysisMode: 'fast' },
      {
        config: { outputLanguage: 'zh-CN' },
        sceneType: 'general',
        lightweight: true,
        analysisRunSpec: createOpenAiAnalysisRunSpecForTest({
          query: 'CPU 有几核？',
          sessionId: 's-openai-preflight-global-trace-fact',
          traceId: 'trace-openai-preflight-global-trace-fact',
          analysisMode: 'fast',
        }),
        sessionContext,
        previousTurns: [],
        skipQuickTracePreflightDetection: true,
        quickTraceFactPreEvidence: true,
      },
    );

    expect(traceProcessor.query).toHaveBeenCalledTimes(1);
    expect(detectArchitecture).not.toHaveBeenCalled();
    expect(detectVendor).not.toHaveBeenCalled();
    expect(context.tools).toHaveLength(0);
    expect(context.allowedTools).toEqual([]);
    expect(context.systemPrompt).toBe('');
    expect(context.directTraceFactAnswer?.conclusion).toContain('7 个 CPU 核心');
    expect(sessionContext.generateRecentSqlResultPromptContext).not.toHaveBeenCalled();
    expect(sessionContext.generatePromptContext).not.toHaveBeenCalled();
    expect(sessionContext.getEntityStore).not.toHaveBeenCalled();
    expect(traceProcessor.getTrace).not.toHaveBeenCalled();
    const dataUpdates = updates.filter(update => update.type === 'data');
    expect(dataUpdates).toHaveLength(1);
    expect(dataUpdates[0].content).toEqual([expect.objectContaining({
      meta: expect.objectContaining({
        source: 'runtime_trace_fact:cpu_core_count',
        intent: 'runtime_trace_fact_lookup',
      }),
    })]);
  });

  it('answers default auto trace facts before preparing the OpenAI SDK context', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    traceProcessor.query.mockImplementation(async (_traceId: string, sql: string) => {
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
    const runtime = new OpenAIRuntime(traceProcessor);
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));
    const runtimeWithPrivates = runtime as unknown as {
      prepareAnalysisContext: (...args: unknown[]) => Promise<unknown>;
    };
    const prepareAnalysisContext = jest.spyOn(runtimeWithPrivates, 'prepareAnalysisContext');

    const result = await runtime.analyze(
      '这个 trace 的 CPU 有几个核心？',
      's-openai-direct-trace-fact',
      'trace-openai-direct-trace-fact',
    );

    expect(prepareAnalysisContext).not.toHaveBeenCalled();
    expect(traceProcessor.query).toHaveBeenCalledTimes(1);
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
    expect(updates.map(update => update.type)).toEqual([
      'data',
      'progress',
      'conclusion',
      'answer_token',
    ]);
  });

  it('answers package-scoped trace facts directly without focus detection', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    traceProcessor.query.mockImplementation(async (_traceId: string, sql: string) => {
      expect(sql).toContain('runtime_frame_metrics');
      return {
        columns: [
          'package_name',
          'process_names',
          'upid_count',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          1,
          347,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'actual_frame_timeline_slice',
        ]],
        durationMs: 2,
      };
    });
    const runtime = new OpenAIRuntime(traceProcessor);
    const updates: Array<{ type?: string; content?: unknown }> = [];
    runtime.on('update', update => updates.push(update));
    const runtimeWithPrivates = runtime as unknown as {
      prepareAnalysisContext: (...args: unknown[]) => Promise<unknown>;
    };
    const prepareAnalysisContext = jest.spyOn(runtimeWithPrivates, 'prepareAnalysisContext');

    const result = await runtime.analyze(
      '滑动 FPS 是多少？',
      's-openai-direct-scoped-trace-fact',
      'trace-openai-direct-scoped-trace-fact',
      { packageName: 'com.example.app' },
    );

    expect(prepareAnalysisContext).not.toHaveBeenCalled();
    expect(traceProcessor.query).toHaveBeenCalledTimes(1);
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
    expect(result.conclusion).toContain('77.99 FPS');
    expect(result.conclusionContract?.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'fps',
      value: 77.99,
    }));
    expect(updates).toEqual([
      expect.objectContaining({
        type: 'data',
        content: [expect.objectContaining({
          meta: expect.objectContaining({
            source: 'runtime_trace_fact:frame_metrics',
            intent: 'runtime_trace_fact_lookup',
          }),
        })],
      }),
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
      expect.objectContaining({ type: 'answer_token' }),
    ]);
  });

  it('restores normal quick preflight when trace fact pre-evidence is unusable', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    traceProcessor.query.mockImplementation(async (_traceId: string, sql: string) => {
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
        rows: [],
        durationMs: 2,
      };
    });
    const runtime = new OpenAIRuntime(traceProcessor);
    const runtimeWithPrivates = runtime as unknown as {
      detectArchitecture: (...args: unknown[]) => Promise<unknown>;
      detectVendor: (...args: unknown[]) => Promise<unknown>;
      sessionSqlErrors: Map<string, unknown[]>;
      prepareAnalysisContext: (...args: unknown[]) => Promise<{
        tools: unknown[];
        allowedTools: string[];
        systemPrompt: string;
        quickMemoryContextCounts?: unknown;
      }>;
    };
    const detectArchitecture = jest.spyOn(runtimeWithPrivates, 'detectArchitecture')
      .mockResolvedValue({ type: 'Standard', confidence: 0.9, evidence: [] });
    const detectVendor = jest.spyOn(runtimeWithPrivates, 'detectVendor')
      .mockResolvedValue('xiaomi');
    const sessionContext = createSessionContextForOpenAiPrepareTest();

    const context = await runtimeWithPrivates.prepareAnalysisContext(
      'CPU 有几核？',
      's-openai-preflight-trace-fact-empty',
      'trace-openai-preflight-trace-fact-empty',
      { analysisMode: 'fast' },
      {
        config: { outputLanguage: 'zh-CN' },
        sceneType: 'general',
        lightweight: true,
        analysisRunSpec: createOpenAiAnalysisRunSpecForTest({
          query: 'CPU 有几核？',
          sessionId: 's-openai-preflight-trace-fact-empty',
          traceId: 'trace-openai-preflight-trace-fact-empty',
          analysisMode: 'fast',
        }),
        sessionContext,
        previousTurns: [],
        skipQuickTracePreflightDetection: true,
        quickTraceFactPreEvidence: true,
      },
    );

    expect(detectArchitecture).toHaveBeenCalledWith('trace-openai-preflight-trace-fact-empty', undefined);
    expect(detectVendor).toHaveBeenCalledWith('trace-openai-preflight-trace-fact-empty');
    expect(sessionContext.generateRecentSqlResultPromptContext).toHaveBeenCalledWith(3);
    expect(runtimeWithPrivates.sessionSqlErrors.has('s-openai-preflight-trace-fact-empty')).toBe(true);
    expect(context.tools.length).toBeGreaterThan(0);
    expect(context.allowedTools.length).toBeGreaterThan(0);
    expect(context.quickMemoryContextCounts).toEqual(expect.objectContaining({
      recentSqlResults: expect.any(Number),
      patternHints: expect.any(Number),
    }));
    expect(context.systemPrompt).not.toContain('data:runtime_trace_fact:cpu_core_count');
    expect(context.systemPrompt).not.toContain('runtime_trace_fact:cpu_core_count');
  });

  it('keeps vendor and architecture preflight for diagnostic fast context', async () => {
    const traceProcessor = createTraceProcessorForOpenAiPrepareTest();
    const runtime = createOpenAiRuntimeForTest(traceProcessor);
    const detectArchitecture = jest.spyOn(runtime, 'detectArchitecture')
      .mockResolvedValue({ type: 'Standard', confidence: 0.9, evidence: [] });
    const detectVendor = jest.spyOn(runtime, 'detectVendor')
      .mockResolvedValue('xiaomi');
    const sessionContext = createSessionContextForOpenAiPrepareTest();

    await runtime.prepareAnalysisContext(
      '分析滑动性能并给优化建议',
      's-openai-preflight-diagnostic',
      'trace-openai-preflight-diagnostic',
      { analysisMode: 'fast' },
      {
        config: { outputLanguage: 'zh-CN' },
        sceneType: 'scrolling',
        lightweight: true,
        analysisRunSpec: createOpenAiAnalysisRunSpecForTest({
          query: '分析滑动性能并给优化建议',
          sessionId: 's-openai-preflight-diagnostic',
          traceId: 'trace-openai-preflight-diagnostic',
          analysisMode: 'fast',
        }),
        sessionContext,
        previousTurns: [],
        skipQuickTracePreflightDetection: false,
      },
    );

    expect(detectArchitecture).toHaveBeenCalledWith('trace-openai-preflight-diagnostic', undefined);
    expect(detectVendor).toHaveBeenCalledWith('trace-openai-preflight-diagnostic');
    expect(sessionContext.generateRecentSqlResultPromptContext).toHaveBeenCalledWith(3);
    expect(runtime.sessionSqlErrors.has('s-openai-preflight-diagnostic')).toBe(true);
  });
});

describe('OpenAIRuntime plan completion guard', () => {
  it('drops unfinished pre-plan evidence when a new analysis run starts', () => {
    const runtime = createOpenAiRuntimeForTest();
    runtime.sessionPlans.set('s-stale-pre-plan', {
      current: null,
      history: [],
      prePlanToolCallLog: [{
        toolName: 'get_comparison_context',
        timestamp: 10,
        success: true,
      }],
    });

    runtime.resetAnalysisSessionState('s-stale-pre-plan');

    expect(runtime.sessionPlans.get('s-stale-pre-plan')?.prePlanToolCallLog).toEqual([]);
  });

  it('treats full-mode runs as incomplete until every plan phase is closed', () => {
    const runtime = createOpenAiRuntimeForTest();

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: false,
      pendingPhases: [],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending'), phase('p3', 'in_progress')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [
        expect.objectContaining({ id: 'p2' }),
        expect.objectContaining({ id: 'p3' }),
      ],
    });

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('does not require a plan in quick mode', () => {
    const runtime = createOpenAiRuntimeForTest();

    expect(runtime.getPlanCompletionStatus('s1', true)).toMatchObject({
      complete: true,
      hasPlan: false,
      pendingPhases: [],
    });
  });

  it('does not treat closed phases with weak summaries as complete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const weak = phase('p1', 'completed');
    weak.summary = 'done';

    runtime.sessionPlans.set('s1', {
      current: plan([weak]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
    });
  });

  it('does not treat completed phases as complete until structured expected calls are observed', () => {
    const runtime = createOpenAiRuntimeForTest();
    const p1 = phase('p1', 'completed');
    p1.expectedCalls = [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }];
    runtime.sessionPlans.set('s1', {
      current: plan([p1]),
      history: [],
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: false,
      hasPlan: true,
      pendingPhases: [expect.objectContaining({ id: 'p1' })],
      evidenceGaps: [expect.objectContaining({ phase: expect.objectContaining({ id: 'p1' }) })],
    });

    runtime.sessionPlans.get('s1')!.current!.toolCallLog.push({
      toolName: 'invoke_skill',
      skillId: 'scrolling_analysis',
      matchedPhaseId: 'p1',
      timestamp: Date.now(),
    });

    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    });
  });

  it('allows deterministic stream finalization after full-mode plan completion', () => {
    const runtime = createOpenAiRuntimeForTest();

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'in_progress')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(false);

    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, 'final text')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', false, '', 'previous answer')).toBe(true);
    expect(runtime.shouldFinalizeAfterPlanComplete('s1', true, 'final text')).toBe(false);
  });

  it('reconciles the sole in-progress conclusion phase from a deliverable final report', () => {
    const runtime = createOpenAiRuntimeForTest();
    const conclusionPhase = phase('p2', 'in_progress');
    conclusionPhase.name = '综合结论';
    conclusionPhase.goal = '输出最终报告和优化建议';
    conclusionPhase.expectedTools = [];
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), conclusionPhase]),
      history: [],
    });
    const finalReport = startupFinalReportForReconciliation();

    expect(runtime.reconcileCompletedConclusionPhase({
      sessionId: 's1',
      quickMode: false,
      conclusion: finalReport,
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(true);
    expect(runtime.getPlanCompletionStatus('s1', false)).toMatchObject({
      complete: true,
      pendingPhases: [],
    });
    expect(conclusionPhase).toMatchObject({
      status: 'completed',
      summary: expect.stringContaining('TTID=1912ms'),
    });
  });

  it('does not reconcile conclusion output while an evidence phase remains pending', () => {
    const runtime = createOpenAiRuntimeForTest();
    const conclusionPhase = phase('p3', 'in_progress');
    conclusionPhase.name = '综合结论';
    conclusionPhase.goal = '输出最终报告和优化建议';
    conclusionPhase.expectedTools = [];
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending'), conclusionPhase]),
      history: [],
    });

    expect(runtime.reconcileCompletedConclusionPhase({
      sessionId: 's1',
      quickMode: false,
      conclusion: '## 综合结论\n\n这是一份超过两百字但取证阶段尚未完成的最终报告。'.repeat(8),
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(false);
    expect(conclusionPhase.status).toBe('in_progress');
  });

  it('does not reconcile a conclusion phase from an incomplete report contract', () => {
    const runtime = createOpenAiRuntimeForTest();
    const conclusionPhase = phase('p2', 'in_progress');
    conclusionPhase.name = '综合结论';
    conclusionPhase.goal = '输出最终报告和优化建议';
    conclusionPhase.expectedTools = [];
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), conclusionPhase]),
      history: [],
    });

    expect(runtime.reconcileCompletedConclusionPhase({
      sessionId: 's1',
      quickMode: false,
      conclusion: '## 综合结论\n\n当前启动比较慢，建议继续检查。'.repeat(12),
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(false);
    expect(conclusionPhase.status).toBe('in_progress');
  });

  it('does not reconcile a conclusion phase with an unmet structured expected call', () => {
    const runtime = createOpenAiRuntimeForTest();
    const conclusionPhase = phase('p2', 'in_progress');
    conclusionPhase.name = '综合结论';
    conclusionPhase.goal = '输出最终报告和优化建议';
    conclusionPhase.expectedCalls = [{tool: 'lookup_blog_knowledge'}];
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), conclusionPhase]),
      history: [],
    });

    expect(runtime.reconcileCompletedConclusionPhase({
      sessionId: 's1',
      quickMode: false,
      conclusion: startupFinalReportForReconciliation(),
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(false);
    expect(conclusionPhase.status).toBe('in_progress');
  });

  it('does not read finalOutput after forced plan-complete aborts', () => {
    const stream = {
      get finalOutput() {
        throw new Error('finalOutput getter should not be read');
      },
    };

    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: false,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: true,
      timedOut: false,
    })).toBeUndefined();
    expect(__testing.readCompletedStreamFinalOutput(stream, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: true,
    })).toBeUndefined();
  });

  it('reads finalOutput only after natural stream completion', () => {
    expect(__testing.readCompletedStreamFinalOutput({ finalOutput: 'done' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
    })).toBe('done');
  });

  it('does not treat stream finalOutput as final before a full-mode plan is complete', () => {
    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: '我将先查询 FrameTimeline。' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: false,
      planComplete: false,
    })).toBeUndefined();

    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: 'quick answer' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: true,
      planComplete: false,
    })).toBe('quick answer');

    expect(__testing.readPlanEligibleStreamFinalOutput({ finalOutput: '## 综合结论\n\n证据完整。' }, {
      streamCompleted: true,
      completedByPlanIdle: false,
      timedOut: false,
      quickMode: false,
      planComplete: true,
    })).toBe('## 综合结论\n\n证据完整。');
  });

  it('suppresses full-mode answer deltas before a plan is submitted', () => {
    const { runtime, updates } = createRuntimeWithUpdates();

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('我将分析这个 doFrame 帧，首先查询 FrameTimeline。'),
      'zh-CN',
      streamContext('s-pre-plan', false),
    );

    expect(delta).toBe('');
    expect(updates.some(update => update.type === 'answer_token')).toBe(false);
  });

  it('suppresses full-mode answer deltas while the plan is still pending', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-pending', {
      current: plan([phase('p1', 'completed'), phase('p2', 'pending')]),
      history: [],
    });

    const captured: string[] = [];
    const context = streamContext('s-pending', false);
    context.onSuppressedAnswerDelta = value => captured.push(value);
    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('我将重新制定计划并继续分析。'),
      'zh-CN',
      context,
    );

    expect(delta).toBe('');
    expect(captured).toEqual(['我将重新制定计划并继续分析。']);
    expect(updates.some(update => update.type === 'answer_token')).toBe(false);
  });

  it('streams answer deltas after a full-mode plan is complete', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-complete', {
      current: plan([phase('p1', 'completed'), phase('p2', 'skipped')]),
      history: [],
    });

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。'),
      'zh-CN',
      streamContext('s-complete', false),
    );

    expect(delta).toBe('## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。');
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'answer_token',
      content: { token: '## 综合结论\n\nFrame 卡顿来自主线程长时间 Sleeping。' },
    }));
  });

  it('keeps quick-mode answer streaming unchanged', () => {
    const { runtime, updates } = createRuntimeWithUpdates();

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('快速结论：主线程 Running 时间最高。'),
      'zh-CN',
      streamContext('s-quick', true),
    );

    expect(delta).toBe('快速结论：主线程 Running 时间最高。');
    expect(updates.some(update => update.type === 'answer_token')).toBe(true);
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
    const rawSourceResult = JSON.stringify({ result: {
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

  it('strips OpenAI-compatible reasoning markers from visible text', () => {
    expect(__testing.stripOpenAiReasoningArtifacts(
      '<think>内部推理不应展示</think>\n\n## 综合结论\n\n用户可见结论。</think>',
    )).toBe('## 综合结论\n\n用户可见结论。');

    expect(__testing.stripOpenAiReasoningArtifacts(
      '## 综合结论\n\n用户可见结论。\n\n<think>未闭合内部推理',
    )).toBe('## 综合结论\n\n用户可见结论。');

    expect(__testing.sanitizeOpenAiConclusionText(
      '## 综合结论\n\nFrame 卡顿主要来自主线程阻塞。</think>',
    )).toBe('## 综合结论\n\nFrame 卡顿主要来自主线程阻塞。');
  });

  it('strips reasoning markers across split answer deltas', () => {
    const state = __testing.createOpenAiReasoningFilterState();

    expect(__testing.filterOpenAiVisibleAnswerDelta('<thi', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('nk>内部推理', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('仍然不可见</thi', state)).toBe('');
    expect(__testing.filterOpenAiVisibleAnswerDelta('nk>## 综合结论', state)).toBe('## 综合结论');
    expect(__testing.filterOpenAiVisibleAnswerDelta('\n\n用户可见。', state)).toBe('\n\n用户可见。');
  });

  it('tracks reasoning state while full-mode answer deltas are suppressed', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    runtime.sessionPlans.set('s-transition', {
      current: plan([phase('p1', 'pending')]),
      history: [],
    });
    const context = streamContext('s-transition', false);

    expect(runtime.handleStreamEvent(
      rawOutputTextDelta('<think>内部推理开始'),
      'zh-CN',
      context,
    )).toBe('');

    runtime.sessionPlans.set('s-transition', {
      current: plan([phase('p1', 'completed')]),
      history: [],
    });

    const delta = runtime.handleStreamEvent(
      rawOutputTextDelta('仍然不可见</think>## 综合结论'),
      'zh-CN',
      context,
    );

    expect(delta).toBe('## 综合结论');
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'answer_token',
      content: { token: '## 综合结论' },
    }));
  });

  it('strips leading process narration from plan-idle conclusions', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。p2.7 的触发条件检查已经完成，接下来输出结论。\n\n' +
      '**根因编号映射**\n\n' +
      '- S1: 主线程 Running 占比 63%，对应 art-1 的线程状态表。\n' +
      '- S2: Sleeping 占比 35%，对应 art-2 的阻塞明细表，需要作为次要风险说明。',
      { completedByPlanIdle: true, planComplete: true, fallbackConclusion: 'fallback' },
    );

    expect(sanitized).toContain('**根因编号映射**');
    expect(sanitized).not.toContain('我需要完成剩余的阶段状态更新');
  });

  it('strips multi-paragraph planning narration before the report body', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '我来分析 `com.example.launch.aosp.heavy` 的启动性能。这是一个启动分析场景。\n\n' +
      '首先，提交分析计划：## Phase 1 — 启动概览采集\n\n' +
      '调用 `startup_analysis` 获取启动事件列表、延迟归因、主线程热点。\n\n' +
      '### Phase 1 关键发现记录\n\n' +
      '- 冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。\n' +
      '- 主线程 Running=63%，证据来自 art-10。',
    );

    expect(sanitized).toContain('### Phase 1 关键发现记录');
    expect(sanitized).not.toContain('我来分析');
    expect(sanitized).not.toContain('提交分析计划');
    expect(sanitized).not.toContain('调用 `startup_analysis`');
  });

  it('strips scratch findings and continuation narration before an embedded final report heading', () => {
    const sanitized = __testing.sanitizeOpenAiConclusionText(
      '**根因分布统计：**\n' +
      '- **workload_heavy**: 6帧 (85.7%) - 最严重62.73ms，超预算7.5倍\n\n' +
      '根据 Phase 1.9 要求，我需要对占比 >15% 的根因类型进行深钻。workload_heavy 占比 85.7%，必须深钻。\n\n' +
      '让我更新计划并执行深钻：## 滑动性能分析报告\n\n' +
      '### 概览\n\n' +
      '本次分析覆盖 347 帧，结论引用 art-14 和 art-16。\n\n' +
      '### 根因\n\n' +
      '主线程 animation/CustomScroll_longFrameLoad 是主要耗时点，证据来自 frame_blocking_calls。',
      { completedByPlanIdle: true, planComplete: true },
    );

    expect(sanitized.trim().startsWith('## 滑动性能分析报告')).toBe(true);
    expect(sanitized).toContain('本次分析覆盖 347 帧');
    expect(sanitized).not.toContain('根据 Phase 1.9 要求');
    expect(sanitized).not.toContain('让我更新计划');
  });

  it('falls back to completed phase summaries when the candidate is only process narration', () => {
    expect(__testing.sanitizeOpenAiConclusionText(
      '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      {
        completedByPlanIdle: true,
        planComplete: true,
        fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
      },
    )).toBe('分析计划已完成，基于已完成阶段摘要输出。');
  });

  it('treats startup-type validation scratch text as process narration', () => {
    const fallback = '## 综合结论\n\n冷启动 TTID=1912ms，主因是主线程模拟负载。\n\n## 关键证据链\n\n- startup_analysis type_display=冷启动，R009 已修正。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate:
        '验证逻辑：\n' +
        '- **bindApplication 不存在** → 没有 Application 初始化阶段\n' +
        '- **performCreate 存在** → 有 Activity 重建\n\n' +
        '但 Skill 将其重分类为冷启动（R009），可能是因为该应用行为特殊。实际上根据框架信号，**应维持温启动分类**。\n\n' +
        '现在进入 Phase 2，调用 startup_detail：Phase 2 返回了丰富数据。关键概览：Q1=62.8%, Q4b=35.1%。',
      accumulatedAnswer: '',
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(fallback);
  });

  it('recovers the accumulated report when the plan-idle candidate is only bookkeeping', () => {
    const report = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '启动诊断完成，主线程 Running=63%，ChaosTask self=456ms，结论引用 art-10 和 data:sql_summary:current:abc。\n\n' +
      '## 根因\n\n' +
      '模拟负载是主要瓶颈，LoadSimulator_ActivityInit=250ms，相关数据来自 art-32。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      accumulatedAnswer: report,
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: '分析计划已完成，基于已完成阶段摘要输出。',
    });

    expect(chosen).toBe(report);
  });

  it('does not treat phase process narration as a valid final report', () => {
    const fallback = '## 综合结论\n\n阶段证据已收敛。\n\n## 关键证据链\n\n- TTID=1912ms。';
    const leaked = [
      '1. **冷启动**，dur=1338.65ms，原分类warm已被重分类为cold（R009）',
      '2. **TTID=1912.20ms > dur=1338.65ms**，差距573.55ms（R008触发）',
      '',
      '现在完成Phase 1，进入Phase 1.5验证启动类型，然后进入Phase 2深钻。',
    ].join('\n');

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: leaked,
      accumulatedAnswer: leaked,
      completedByPlanIdle: true,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(fallback);
  });

  it('recovers the accumulated report after natural plan completion when finalOutput collapses to fallback', () => {
    const fallback = '## 综合结论\n\n' +
      '完成综合结论输出。冷启动 TTID=1912ms，主因是主线程模拟负载。\n\n' +
      '## 分阶段证据摘要\n\n' +
      '- 启动概览采集: 获取启动概览，TTID=1912ms。\n' +
      '- 综合结论: 完成综合结论输出。';
    const report = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '冷启动 TTID=1912ms，主线程模拟负载是主因；ChaosTask self=456ms，LoadSimulator_ActivityInit self=249.8ms，SimulateInflation self=175.5ms。' +
      '四象限 Q1=62.8%、Q4b=35.1%，CPU-bound 为主，证据引用 art-10、art-32 和 data:sql_table:current:abc。\n\n' +
      '## 关键证据链\n\n' +
      '- startup_detail 显示主线程 Running=63%，S=35%，D=1.7%。\n' +
      '- hot_slice_states 显示 ChaosTask/SimulateInflation Running >98%。\n' +
      '- memory_pressure_in_range 显示 pressure_level=none，排除内存压力。\n\n' +
      '## 优化建议\n\n' +
      '降低启动期模拟负载，拆分 Activity 初始化中的同步等待，并把 inflate 成本移出首帧关键路径。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: '我需要完成剩余的阶段状态更新。现在继续调用 update_plan_phase。',
      accumulatedAnswer: report,
      completedByPlanIdle: false,
      planComplete: true,
      fallbackConclusion: fallback,
    });

    expect(chosen).toBe(report);
  });

  it('keeps a valid finalOutput report instead of preferring stale accumulated text', () => {
    const staleInterimReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '这是较早的阶段性报告，包含还没有被后续 SQL 校正的初步判断，文本更长但不是最终答案。\n\n' +
      '## 早期证据\n\n' +
      '- 初步估算 TTID=2100ms，ChaosTask=500ms。\n' +
      '- 初步估算内存压力可疑，但后续阶段尚未验证。\n\n' +
      '## 待验证项\n\n' +
      '仍需要继续执行内存压力、Binder、CPU 频率和 WebView 排除检查。\n\n' +
      '## 临时建议\n\n' +
      '先降低模拟负载，并继续收集证据。'.repeat(8);
    const finalReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '最终校正后 TTID=1912ms，主因是主线程模拟负载；内存压力、CPU 频率和 Binder 均可排除。\n\n' +
      '## 关键证据链\n\n' +
      '- startup_detail 显示 ChaosTask self=456ms。\n' +
      '- memory_pressure_in_range 显示 pressure_level=none。\n\n' +
      '## 优化建议\n\n' +
      '拆分主线程同步负载。';

    const chosen = __testing.chooseOpenAiConclusionText({
      candidate: finalReport,
      accumulatedAnswer: `${staleInterimReport}\n\n${finalReport}`,
      completedByPlanIdle: false,
      planComplete: true,
      fallbackConclusion: '## 综合结论\n\n阶段摘要。\n\n## 分阶段证据摘要\n\n- p1: 采集摘要。',
    });

    expect(chosen).toBe(finalReport);
  });

  it('uses the current run answer before cross-continuation accumulated text for recovery', () => {
    expect(__testing.selectOpenAiRecoveryAnswer({
      runAnswer: '## 当前最终报告\n\n证据已完成校正。',
      accumulatedAnswer: '## 早期阶段报告\n\n这是上一轮 continuation 的阶段性内容。',
    })).toBe('## 当前最终报告\n\n证据已完成校正。');

    expect(__testing.selectOpenAiRecoveryAnswer({
      runAnswer: '   ',
      accumulatedAnswer: '## 累计报告\n\n只有当前 run 为空时才使用累计文本。',
    })).toBe('## 累计报告\n\n只有当前 run 为空时才使用累计文本。');
  });

  it('requests bounded final-report continuations when a completed plan only has summary fallback', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = { complete: true, hasPlan: true, pendingPhases: [] };
    const fallback = '## 综合结论\n\n阶段摘要。\n\n## 分阶段证据摘要\n\n- p1: 采集摘要。';
    const summaryLikeFallback = '## 综合结论\n\n完成综合结论输出。冷启动 TTID=1912ms。\n\n' +
      '## 分阶段证据摘要\n\n' +
      '- 启动概览采集: 获取启动概览，TTID=1912ms。\n' +
      '- 启动详情分析: 四象限 Q1=62.8%、Q4b=35.1%。';
    const fullReport = '# 启动性能分析报告\n\n' +
      '## 综合结论\n\n' +
      '这是面向用户的完整最终报告，包含 TTID=1912ms、ChaosTask=456ms、LoadSimulator_ActivityInit=249.8ms 等证据。\n\n' +
      '## 关键证据链\n\n' +
      '- 引用 art-10 和 data:sql_table:current:abc。\n' +
      '- 排除 CPU 频率、内存压力、Binder 等系统因素。\n\n' +
      '## 优化建议\n\n' +
      '拆分主线程同步负载，延后非首帧必要工作。';

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: true,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: summaryLikeFallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '1. **冷启动**，dur=1338.65ms。',
        '',
        '现在完成Phase 1，进入Phase 1.5验证启动类型。',
      ].join('\n'),
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '### Phase 1 关键发现记录',
        '',
        '- 冷启动 dur=1338.65ms，TTID=1912.20ms。',
        '- 主线程 Running=63%。',
      ].join('\n'),
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 1,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 2,
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fallback,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 4,
    })).toBe(false);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: fullReport,
      fallbackConclusion: fallback,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
    })).toBe(false);
  });

  it('requests final-report continuation when the scene contract is incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '## 综合结论',
        '',
        'com.example.demo 滑动性能一般：347帧中7帧真实掉帧，最长帧62.73ms。',
        '',
        '## 根因拆解',
        '',
        '- animation 回调同步执行 CustomScroll_longFrameLoad。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析滑动性能',
      sceneType: 'scrolling',
    })).toBe(true);
  });

  it('requests final-report continuation when a deliverable report violates a semantic quality boundary', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {complete: true, hasPlan: true, pendingPhases: []};
    const report = startupFinalReportForReconciliation();

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: `${report}\n\n## 已排除因素\n\nblocked_function=do_epoll_wait 命中 120ms，说明主线程在磁盘 IO 阻塞，所以这是 IO 根因。`,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(true);

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: `${report}\n\n## 已排除因素\n\nblocked_function=do_epoll_wait 通常表示等待事件或空闲，不是磁盘 IO 根因。`,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBe(false);
  });

  it('requests a bounded continuation when a complete report has a CRITICAL recommendation without local evidence', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {complete: true, hasPlan: true, pendingPhases: []};
    const report = `${startupFinalReportForReconciliation()}\n\n` + [
      '## 优化建议',
      '',
      '1. **[CRITICAL] `ChaosTask` 移出主线程启动路径**',
      '- 建议改为异步执行。',
    ].join('\n');
    const reportWithEvidence = report.replace(
      '- 建议改为异步执行。',
      '- 当前 `ChaosTask` self=456ms，证据引用 art-10；建议改为异步执行。',
    );
    const input = {
      quickMode: false,
      planStatus,
      completedByPlanIdle: false,
      timedOut: false,
      query: '分析启动性能',
      sceneType: 'startup' as const,
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      ...input,
      conclusion: report,
      finalReportContinuations: 0,
    })).toBe(true);
    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      ...input,
      conclusion: reportWithEvidence,
      finalReportContinuations: 0,
    })).toBe(false);
    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      ...input,
      conclusion: report,
      finalReportContinuations: 4,
    })).toBe(false);
  });

  it('requests final-report continuation when a successful source lookup lacks a locatable CodeRef', () => {
    const runtime = createOpenAiRuntimeForTest();
    const completedPlan = plan([phase('p1', 'completed'), phase('p2', 'completed')]);
    completedPlan.toolCallLog.push({
      toolName: 'lookup_app_source',
      timestamp: Date.now(),
      matchedPhaseId: 'p1',
      success: true,
      returnedCodeReferences: true,
    });
    runtime.sessionPlans.set('source-session', {current: completedPlan, history: []});
    const report = startupFinalReportForReconciliation();
    const input = {
      sessionId: 'source-session',
      quickMode: false,
      planStatus: {complete: true, hasPlan: true, pendingPhases: []},
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析启动性能',
      sceneType: 'startup' as const,
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      ...input,
      conclusion: `${report}\n\n源码参考：StartupHooks.kt。`,
    })).toBe(true);
    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      ...input,
      conclusion: `${report}\n\n源码定位：app/src/main/java/demo/StartupHooks.kt:L10-L20。`,
    })).toBe(false);
  });

  it('requests final-report continuation when the memory scene contract is incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 内存分析报告',
        '',
        '## 综合结论',
        '',
        'PSS 持续上涨，可能存在泄漏，需要优化内存。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析内存上涨和 GC 抖动',
      sceneType: 'memory',
    })).toBe(true);
  });

  it('requests final-report continuation when the power background-governance contract is incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 功耗分析报告',
        '',
        '## 综合结论',
        '',
        '后台 JobScheduler 耗电高，可能是 quota 导致，需要减少后台任务。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析 JobScheduler runtime quota pending reason stop reason',
      sceneType: 'power',
    })).toBe(true);
  });

  it('requests final-report continuation when the network request-stage contract is incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 网络分析报告',
        '',
        '## 综合结论',
        '',
        'OkHttp 请求慢主要是 DNS/TLS/TTFB 慢，建议优化缓存和服务端。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '分析 OkHttp EventListener DNS TLS TTFB 是否慢',
      sceneType: 'network',
    })).toBe(true);
  });

  it('requests final-report continuation when startup diagnostic API boundaries are incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 启动性能分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationStartInfo 显示启动慢，App Performance Score 偏低，建议优化启动。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationStartInfo STARTUP_STATE 和 App Performance Score 分析启动 TTID/TTFD',
      sceneType: 'startup',
    })).toBe(true);
  });

  it('requests final-report continuation when memory diagnostic API boundaries are incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# 内存分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationExitInfo REASON_LOW_MEMORY 说明 OOM 来自内存泄漏，建议优化对象释放。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationExitInfo REASON_LOW_MEMORY 和 ProfilingManager heap dump 分析 OOM',
      sceneType: 'memory',
    })).toBe(true);
  });

  it('requests final-report continuation when ANR diagnostic API boundaries are incomplete', () => {
    const runtime = createOpenAiRuntimeForTest();
    const planStatus = {
      complete: true,
      hasPlan: true,
      pendingPhases: [],
    };

    expect(runtime.shouldRequestFinalReportAfterPlanComplete({
      quickMode: false,
      planStatus,
      conclusion: [
        '# ANR 分析报告',
        '',
        '## 综合结论',
        '',
        'ApplicationExitInfo getAnrInfo 和 ProfilingTrigger system trace 说明当前 ANR 是系统确认根因。',
      ].join('\n'),
      fallbackConclusion: undefined,
      completedByPlanIdle: false,
      timedOut: false,
      finalReportContinuations: 0,
      query: '用 ApplicationExitInfo getAnrInfo 和 ProfilingTrigger ANR system trace 分析 ANR',
      sceneType: 'anr',
    })).toBe(true);
  });

  it('uses a full-report continuation prompt that preserves scene-specific sections', () => {
    const runtime = createOpenAiRuntimeForTest();

    const zhPrompt = runtime.buildFinalReportAfterPlanCompletePrompt({
      outputLanguage: 'zh-CN',
      requireCodeReference: true,
    });
    expect(zhPrompt).toContain('继续遵守本轮场景策略');
    expect(zhPrompt).toContain('Final Report Contract');
    expect(zhPrompt).toContain('场景契约要求的结构');
    expect(zhPrompt).toContain('完整性优先');
    expect(zhPrompt).toContain('先输出 Final Report Contract 要求的必需结构');
    expect(zhPrompt).toContain('证据类型');
    expect(zhPrompt).toContain('relative/path/File.kt:L10-L20');
    expect(zhPrompt).toContain('版本/政策敏感');
    expect(zhPrompt).toContain('缺失数据只能写成限制');
    expect(zhPrompt).toContain('`epoll` / `poll`');
    expect(zhPrompt).toContain('kernel wchan 单帧');
    expect(zhPrompt).toContain('D/DK/Q4a');
    expect(zhPrompt).toContain('不可中断等待');
    expect(zhPrompt).toContain('标题、表格分类或已排除因素');
    expect(zhPrompt).toContain('无法归因 I/O');
    expect(zhPrompt).toContain('同一线程和等待窗口');
    expect(zhPrompt).toContain('每个 `[CRITICAL]`');
    expect(zhPrompt).toContain('不能只把它降为 `[HIGH]`');
    expect(zhPrompt).not.toContain('2500-3500');
    expect(zhPrompt).not.toContain('最多 1200');

    const enPrompt = runtime.buildFinalReportAfterPlanCompletePrompt({
      outputLanguage: 'en',
    });
    expect(enPrompt).toContain('scene strategy');
    expect(enPrompt).toContain('Final Report Contract');
    expect(enPrompt).toContain('structures required by the scene contract');
    expect(enPrompt).toContain('Prioritize completeness');
    expect(enPrompt).toContain('before long trees');
    expect(enPrompt).toContain('evidence type');
    expect(enPrompt).toContain('version/policy-sensitive');
    expect(enPrompt).toContain('Missing data is a limitation');
    expect(enPrompt).toContain('`epoll` / `poll`');
    expect(enPrompt).toContain('single kernel wchan frame');
    expect(enPrompt).toContain('D/DK/Q4a');
    expect(enPrompt).toContain('uninterruptible wait');
    expect(enPrompt).toContain('headings, table categories, or ruled-out factors');
    expect(enPrompt).toContain('cannot be attributed to I/O');
    expect(enPrompt).toContain('same thread and wait window');
    expect(enPrompt).toContain('Every `[CRITICAL]`');
    expect(enPrompt).toContain('Do not evade this by relabeling it as `[HIGH]`');
    expect(enPrompt).not.toContain('1,200-1,800');
    expect(enPrompt).not.toContain('at most 700');
  });

  it('renders the current report contract gaps in contract order without stale placeholders', () => {
    const runtime = createOpenAiRuntimeForTest();
    const incompleteReport = startupFinalReportForReconciliation()
      .replace('A4 主线程重任务', '主线程重任务');
    const contractIssue = assessFinalReportContractCompleteness({
      conclusion: incompleteReport,
      query: '分析启动性能',
      sceneType: 'startup',
    });

    expect(contractIssue?.missingSections.map(section => section.id)).toEqual([
      'root_cause_references',
    ]);

    const continuationPrompt = runtime.buildFinalReportAfterPlanCompletePrompt({
      outputLanguage: 'zh-CN',
      missingSections: contractIssue?.missingSections,
      requireCodeReference: true,
    });

    expect(continuationPrompt).toContain('### 必须补齐的缺失小节');
    expect(continuationPrompt).toContain('- 根因编号引用: 关键根因只能引用启动知识库已有的 A1-A18、B1-B12');
    expect(continuationPrompt.indexOf('### 必须补齐的缺失小节'))
      .toBeLessThan(continuationPrompt.indexOf('relative/path/File.kt:L10-L20'));
    expect(continuationPrompt).not.toContain('{{missing_sections}}');

    const completeIssue = assessFinalReportContractCompleteness({
      conclusion: startupFinalReportForReconciliation(),
      query: '分析启动性能',
      sceneType: 'startup',
    });
    expect(completeIssue).toBeUndefined();

    const nextPrompt = runtime.buildFinalReportAfterPlanCompletePrompt({
      outputLanguage: 'zh-CN',
      missingSections: completeIssue?.missingSections,
    });
    expect(nextPrompt).not.toContain('### 必须补齐的缺失小节');
  });

  it('renders every English contract gap and no unresolved template variables', () => {
    const runtime = createOpenAiRuntimeForTest();
    const missingSections = [
      {
        id: 'root_cause_references',
        label: 'Root-cause references',
        description: 'Use only evidence-backed A/B/SR identifiers.',
        recoveryText: {zh: [], en: []},
      },
      {
        id: 'audience_recommendations',
        label: 'App/System recommendations',
        description: 'Separate app and platform actions.',
        recoveryText: {zh: [], en: []},
      },
    ];

    const prompt = runtime.buildFinalReportAfterPlanCompletePrompt({
      outputLanguage: 'en',
      missingSections,
    });

    expect(prompt).toContain('### Required Missing Sections');
    expect(prompt).toContain('- Root-cause references: Use only evidence-backed A/B/SR identifiers.');
    expect(prompt).toContain('- App/System recommendations: Separate app and platform actions.');
    expect(prompt.indexOf('Root-cause references')).toBeLessThan(prompt.indexOf('App/System recommendations'));
    expect(prompt).not.toContain('{{missing_sections}}');
  });

  it('returns a terminal partial result when the provider stalls before creating a stream', async () => {
    const originalIdleTimeout = process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS;
    const originalRequestTimeout = process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS;
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '15';
    process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS = '1000';

    const runtime = createOpenAiRuntimeForTest();
    const updates: OpenAiStreamingUpdateForTest[] = [];
    runtime.on('update', update => updates.push(update));
    let providerSignal: AbortSignal | undefined;
    jest.spyOn(Runner.prototype as any, 'run')
      .mockImplementation(async (...args: unknown[]) => {
        const options = args[2] as {signal?: AbortSignal};
        providerSignal = options.signal;
        return await new Promise(() => undefined);
      });
    jest.spyOn(runtime, 'classifyModeForRequest').mockResolvedValue({
      quickMode: false,
      source: 'user_explicit',
      reason: 'test full mode',
      skipQuickTracePreflightDetection: false,
      quickAcknowledgementDirectAnswer: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
    });
    jest.spyOn(runtime, 'prepareAnalysisContext').mockResolvedValue({
      tools: [],
      allowedTools: [],
      systemPrompt: 'test system prompt',
      sessionContext: {
        addTurn: jest.fn(),
        updateWorkingMemoryFromConclusion: jest.fn(),
      },
      previousTurns: [],
      architecture: {type: 'Standard', confidence: 1, evidence: []},
      hypotheses: [],
      sessionMapKey: 's-provider-create-idle-timeout',
      effectivePackageName: 'com.example.demo',
    } as any);
    jest.spyOn(runtime, 'recordPatternMemory').mockImplementation(() => undefined);

    try {
      const result = await runtime.analyze(
        '分析启动性能',
        's-provider-create-idle-timeout',
        'trace-provider-create-idle-timeout',
        {analysisMode: 'full', providerId: null},
      );

      expect(providerSignal?.aborted).toBe(true);
      expect(result).toMatchObject({
        success: true,
        partial: true,
        terminationReason: 'timeout',
      });
      expect(updates).toContainEqual(expect.objectContaining({
        type: 'degraded',
        content: expect.objectContaining({
          fallback: 'partial_result_after_timeout',
          timeoutKind: 'stream_idle',
        }),
      }));
    } finally {
      if (originalIdleTimeout === undefined) delete process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS;
      else process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = originalIdleTimeout;
      if (originalRequestTimeout === undefined) delete process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS;
      else process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS = originalRequestTimeout;
    }
  });

  it('recomputes contract gaps for the fresh continuation report and keeps only the second report', async () => {
    const runtime = createOpenAiRuntimeForTest();
    const slowReasonPhase = phase('p1', 'completed');
    slowReasonPhase.name = '冷启动慢原因交叉验证';
    slowReasonPhase.summary = [
      'startup_slow_reasons returned reason_id=SR12.',
      'bindApplication non_fw_percent=98.8%, self_ms=568.8ms, evidence=art-sr12.',
    ].join(' ');
    const completedPlan = plan([slowReasonPhase]);
    completedPlan.toolCallLog.push({
      toolName: 'invoke_skill',
      skillId: 'startup_slow_reasons',
      matchedPhaseId: 'p1',
      success: true,
      timestamp: Date.now(),
    });
    completedPlan.toolCallLog.push(
      {
        toolName: 'invoke_skill',
        skillId: 'anr_analysis',
        success: true,
        timestamp: Date.now() + 1,
      },
      {
        toolName: 'invoke_skill',
        skillId: 'startup_analysis',
        success: true,
        timestamp: Date.now() + 2,
      },
    );
    runtime.sessionPlans.set('s-current-contract-gap', {
      current: completedPlan,
      history: [],
    });

    const initialReport = startupFinalReportForReconciliation()
      .replace('A4 主线程重任务', 'EARLY_DRAFT_CANARY');
    const freshReport = startupFinalReportForReconciliation()
      .replace(
        'A4 主线程重任务与当前 trace 的 Running 证据一致，证据引用 art-10 和 art-32。',
        'SR12 交叉验证命中 bindApplication 非框架 Slice：non_fw_percent=98.8%、self_ms=568.8ms，证据引用 art-sr12；它支持排查三方 SDK/应用初始化，但不是合成负载的直接编号映射。',
      );
    const inputs: unknown[] = [];
    const streams = [initialReport, freshReport].map((finalOutput, index) => ({
      currentTurn: 1,
      finalOutput,
      history: [{role: 'assistant', content: finalOutput}],
      lastResponseId: `resp-${index + 1}`,
      state: {},
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {},
    }));
    const runSpy = jest.spyOn(Runner.prototype as any, 'run')
      .mockImplementation(async (_agent: unknown, input: unknown) => {
        inputs.push(input);
        const stream = streams.shift();
        if (!stream) throw new Error('unexpected third OpenAI prompt');
        return stream;
      });
    jest.spyOn(runtime, 'classifyModeForRequest').mockResolvedValue({
      quickMode: false,
      source: 'user_explicit',
      reason: 'test full mode',
      skipQuickTracePreflightDetection: false,
      quickAcknowledgementDirectAnswer: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
    });
    const addTurn = jest.fn();
    const updateWorkingMemoryFromConclusion = jest.fn();
    jest.spyOn(runtime, 'prepareAnalysisContext').mockResolvedValue({
      tools: [],
      allowedTools: [],
      systemPrompt: 'test system prompt',
      sessionContext: {
        addTurn,
        updateWorkingMemoryFromConclusion,
      },
      previousTurns: [],
      architecture: {type: 'Standard', confidence: 1, evidence: []},
      hypotheses: [],
      sessionMapKey: 's-current-contract-gap',
      effectivePackageName: 'com.example.demo',
    } as any);
    jest.spyOn(runtime, 'recordPatternMemory').mockImplementation(() => undefined);

    const result = await runtime.analyze(
      '请调用 anr_analysis 检查这个启动 Trace 是否包含 ANR。',
      's-current-contract-gap',
      'trace-current-contract-gap',
      {analysisMode: 'full', providerId: null},
    );

    expect(runSpy).toHaveBeenCalledTimes(2);
    const continuationInput = inputs[1] as Array<{role?: string; content?: string}>;
    const continuationPrompt = continuationInput[continuationInput.length - 1]?.content ?? '';
    expect(continuationPrompt).toContain('根因编号引用');
    expect(continuationPrompt).toContain('关键根因只能引用启动知识库已有的 A1-A18、B1-B12');
    expect(result.conclusion).toBe(freshReport);
    expect(result.conclusion).toContain('SR12 交叉验证命中 bindApplication 非框架 Slice');
    expect(result.conclusion).toContain('non_fw_percent=98.8%');
    expect(result.conclusion).not.toContain('EARLY_DRAFT_CANARY');
    expect(result.partial).not.toBe(true);
    expect(addTurn).toHaveBeenCalledTimes(1);
    expect(updateWorkingMemoryFromConclusion).toHaveBeenCalledTimes(1);
  });

  it('continues a complete report once for missing CRITICAL evidence and finishes with the fresh evidenced report', async () => {
    const runtime = createOpenAiRuntimeForTest();
    const evidencePhase = phase('p1', 'completed');
    evidencePhase.name = '启动证据采集';
    evidencePhase.summary = 'ChaosTask self=456ms，evidence=art-10。';
    runtime.sessionPlans.set('s-critical-evidence-gap', {
      current: plan([evidencePhase]),
      history: [],
    });

    const reportBase = `${startupFinalReportForReconciliation()}\n\n## 优化建议\n\n`;
    const initialReport = `${reportBase}1. **[CRITICAL] \`ChaosTask\` 移出主线程启动路径**\n- 建议改为异步执行。`;
    const freshReport = `${reportBase}1. **[CRITICAL] \`ChaosTask\` 移出主线程启动路径** — 当前 \`ChaosTask\` self=456ms，证据引用 art-10；建议改为异步执行。`;
    const inputs: unknown[] = [];
    const streams = [initialReport, freshReport].map((finalOutput, index) => ({
      currentTurn: 1,
      finalOutput,
      history: [{role: 'assistant', content: finalOutput}],
      lastResponseId: `resp-critical-${index + 1}`,
      state: {},
      completed: Promise.resolve(),
      async *[Symbol.asyncIterator]() {},
    }));
    const runSpy = jest.spyOn(Runner.prototype as any, 'run')
      .mockImplementation(async (_agent: unknown, input: unknown) => {
        inputs.push(input);
        const stream = streams.shift();
        if (!stream) throw new Error('unexpected third OpenAI prompt');
        return stream;
      });
    jest.spyOn(runtime, 'classifyModeForRequest').mockResolvedValue({
      quickMode: false,
      source: 'user_explicit',
      reason: 'test full mode',
      skipQuickTracePreflightDetection: false,
      quickAcknowledgementDirectAnswer: false,
      quickProcessIdentityPreEvidence: false,
      quickTraceFactPreEvidence: false,
      quickScrollingTriagePreEvidence: false,
    });
    const addTurn = jest.fn();
    const updateWorkingMemoryFromConclusion = jest.fn();
    jest.spyOn(runtime, 'prepareAnalysisContext').mockResolvedValue({
      tools: [],
      allowedTools: [],
      systemPrompt: 'test system prompt',
      sessionContext: {addTurn, updateWorkingMemoryFromConclusion},
      previousTurns: [],
      architecture: {type: 'Standard', confidence: 1, evidence: []},
      hypotheses: [],
      sessionMapKey: 's-critical-evidence-gap',
      effectivePackageName: 'com.example.demo',
    } as any);
    jest.spyOn(runtime, 'recordPatternMemory').mockImplementation(() => undefined);

    const result = await runtime.analyze(
      '分析启动性能',
      's-critical-evidence-gap',
      'trace-critical-evidence-gap',
      {analysisMode: 'full', providerId: null},
    );

    expect(runSpy).toHaveBeenCalledTimes(2);
    const continuationInput = inputs[1] as Array<{role?: string; content?: string}>;
    const continuationPrompt = continuationInput[continuationInput.length - 1]?.content ?? '';
    expect(continuationPrompt).toContain('每个 `[CRITICAL]`');
    expect(result.conclusion).toBe(freshReport);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({severity: 'critical', evidence: expect.any(Array)}),
    ]));
    expect(result.partial).not.toBe(true);
    expect(addTurn).toHaveBeenCalledTimes(1);
    expect(updateWorkingMemoryFromConclusion).toHaveBeenCalledTimes(1);
  });

  it('uses user-facing continuation progress text instead of provider internals', () => {
    const runtime = createOpenAiRuntimeForTest();
    const message = runtime.formatPlanContinuationMessage({
      hasPlan: true,
      complete: false,
      pendingPhases: [
        { id: 'p3', name: '综合结论' },
      ],
    }, 'zh-CN');

    expect(message).toBe('继续补齐剩余分析阶段：综合结论');
    expect(message).not.toContain('OpenAI');
    expect(message).not.toContain('plan');
    expect(message).not.toContain('提前结束');

    const reportMessage = runtime.formatPlanCompleteReportContinuationMessage('zh-CN');
    expect(reportMessage).toBe('最终报告仍需补齐，继续整理完整结论。');
    expect(reportMessage).not.toContain('OpenAI');
    expect(reportMessage).not.toContain('plan');
    expect(reportMessage).not.toContain('provider');
  });

  it('builds a user-facing structured fallback when a completed plan has no final answer text', () => {
    const runtime = createOpenAiRuntimeForTest();
    const p1 = phase('p1', 'completed');
    p1.name = '获取启动概览';
    p1.summary = '检测到冷启动 dur=1338ms，TTID=1912ms，证据来自 art-2。';
    const p2 = phase('p2', 'completed');
    p2.name = '综合结论';
    p2.goal = '输出最终结论和优化建议';
    p2.summary = '主要瓶颈是 ChaosTask self=456ms，相关数据来自 art-30。';
    runtime.sessionPlans.set('s1', {
      current: plan([p1, p2]),
      history: [],
    });

    const fallback = runtime.buildCompletedPlanFallbackConclusion('s1', false, 'zh-CN');

    expect(fallback).toContain('## 综合结论');
    expect(fallback).toContain('主要瓶颈是 ChaosTask self=456ms');
    expect(fallback).toContain('## 关键证据链');
    expect(fallback).toContain('## 根因拆解');
    expect(fallback).toContain('art-30');
    expect(fallback).not.toContain('## 分阶段证据摘要');
    expect(fallback).not.toContain('模型未生成独立最终段落');
  });

  it('recognizes provider stream termination as recoverable', () => {
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('terminated'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('stream terminated before completion'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('socket hang up'))).toBe(true);
    expect(__testing.isRecoverableOpenAIStreamTermination(new Error('rate limit exceeded'))).toBe(false);
  });

  it('builds partial phase-summary fallback for interrupted incomplete plans', () => {
    const runtime = createOpenAiRuntimeForTest();
    runtime.sessionPlans.set('s1', {
      current: plan([phase('p1', 'completed'), phase('p2', 'completed'), phase('p3', 'pending')]),
      history: [],
    });

    const fallback = runtime.buildPlanPhaseSummaryFallbackConclusion('s1', false, 'zh');

    expect(fallback).toContain('OpenAI 流在计划完成前中断');
    expect(fallback).toContain('p1 Phase p1');
    expect(fallback).toContain('p2 Phase p2');
    expect(fallback).toContain('未完成阶段：p3:Phase p3');
  });

  it('records max-turns partial results into session context', () => {
    const runtime = createOpenAiRuntimeForTest();
    const addTurn = jest.fn();
    const updateWorkingMemoryFromConclusion = jest.fn();
    const updates: OpenAiStreamingUpdateForTest[] = [];
    runtime.on('update', update => updates.push(update));

    const result = runtime.recordMaxTurnsPartialResult({
      error: new Error('Max turns exceeded'),
      query: '分析卡顿',
      sessionId: 's-max',
      outputLanguage: 'zh-CN',
      accumulatedAnswer: '## 综合结论\n\nOpenAI 已收集到部分证据，但达到轮次上限。',
      context: {
        hypotheses: [],
        previousTurns: [{ id: 'prev' }],
        sessionContext: {
          addTurn,
          updateWorkingMemoryFromConclusion,
        },
      },
      startTime: Date.now() - 1000,
      rounds: 5,
      quickMode: false,
      maxTurns: 1,
    });

    expect(result.partial).toBe(true);
    expect(result.terminationReason).toBe('max_turns');
    expect(addTurn).toHaveBeenCalledWith(
      '分析卡顿',
      expect.objectContaining({ complexity: 'complex', followUpType: 'extend' }),
      expect.objectContaining({
        agentId: 'openai-agent',
        partial: true,
        terminationReason: 'max_turns',
      }),
      result.findings,
    );
    expect(updateWorkingMemoryFromConclusion).not.toHaveBeenCalled();
    expect(updates.some(update => update.type === 'conclusion')).toBe(true);
    expect(updates.some(update => update.type === 'answer_token' && update.content?.done === true)).toBe(true);
    expect(updates.some(update => (
      update.type === 'degraded' &&
      String(update.content?.message).includes('当前上限 1 turns')
    ))).toBe(true);
  });

  it('writes successful quick results to the quick-path memory bucket', () => {
    const runtime = createOpenAiRuntimeForTest();
    const saveQuick = jest.spyOn(patternMemory, 'saveQuickPathPattern')
      .mockResolvedValue(undefined);
    const saveFull = jest.spyOn(patternMemory, 'saveAnalysisPattern')
      .mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching')
      .mockResolvedValue(false);

    runtime.recordPatternMemory({
      sessionId: 's-quick-memory',
      result: {
        sessionId: 's-quick-memory',
        success: true,
        findings: [{
          title: '焦点进程已识别',
          severity: 'high',
          description: '包名为 com.example.app，来自当前 trace 的 process evidence。',
          confidence: 0.8,
          category: 'process_identity',
        }],
        hypotheses: [],
        conclusion: '根因: 当前问题只需要回答包名，焦点进程为 com.example.app。',
        confidence: 0.8,
        rounds: 2,
        totalDurationMs: 1200,
      },
      previousTurnCount: 3,
      quickMode: true,
      sceneType: 'scrolling',
      architecture: { type: 'Standard' },
      packageName: 'com.example.app',
      options: {},
    });

    expect(saveQuick).toHaveBeenCalledWith(
      expect.arrayContaining([
        'arch:Standard',
        'scene:scrolling',
        'domain:example',
        'cat:process_identity',
        expect.stringContaining('finding:焦点进程已识别'),
      ]),
      expect.arrayContaining([
        expect.stringContaining('焦点进程已识别'),
        expect.stringContaining('根因:'),
      ]),
      'scrolling',
      'Standard',
      expect.objectContaining({
        status: 'provisional',
        provenance: { sessionId: 's-quick-memory', turnIndex: 3 },
      }),
    );
    expect(saveFull).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it('writes successful full OpenAI results to long-term memory and attempts quick promotion', () => {
    const runtime = createOpenAiRuntimeForTest();
    const saveQuick = jest.spyOn(patternMemory, 'saveQuickPathPattern')
      .mockResolvedValue(undefined);
    const saveFull = jest.spyOn(patternMemory, 'saveAnalysisPattern')
      .mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching')
      .mockResolvedValue(true);

    runtime.recordPatternMemory({
      sessionId: 's-full-memory',
      result: {
        sessionId: 's-full-memory',
        success: true,
        findings: [{
          title: 'RenderThread blocked by long task',
          severity: 'high',
          description: 'A long RenderThread slice overlaps the janky frame window.',
          confidence: 0.85,
          category: 'render_thread',
        }],
        hypotheses: [],
        conclusion: '根因: RenderThread 长任务覆盖掉帧窗口。',
        confidence: 0.85,
        rounds: 6,
        totalDurationMs: 8000,
      },
      previousTurnCount: 1,
      quickMode: false,
      sceneType: 'scrolling',
      architecture: { type: 'Standard' },
      packageName: 'com.example.app',
      options: {},
    });

    expect(saveFull).toHaveBeenCalledWith(
      expect.arrayContaining([
        'arch:Standard',
        'scene:scrolling',
        'domain:example',
        'cat:render_thread',
        expect.stringContaining('finding:RenderThread blocked'),
      ]),
      expect.arrayContaining([expect.stringContaining('RenderThread blocked by long task')]),
      'scrolling',
      'Standard',
      0.85,
      expect.objectContaining({
        status: 'provisional',
        provenance: { sessionId: 's-full-memory', turnIndex: 1 },
      }),
    );
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({
      sceneType: 'scrolling',
      architectureType: 'Standard',
      verifierPassed: true,
    }));
    expect(saveQuick).not.toHaveBeenCalled();
  });

  it('does not write OpenAI pattern memory for partial results', () => {
    const runtime = createOpenAiRuntimeForTest();
    const saveQuick = jest.spyOn(patternMemory, 'saveQuickPathPattern')
      .mockResolvedValue(undefined);
    const saveFull = jest.spyOn(patternMemory, 'saveAnalysisPattern')
      .mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching')
      .mockResolvedValue(false);

    runtime.recordPatternMemory({
      sessionId: 's-partial-memory',
      result: {
        sessionId: 's-partial-memory',
        success: true,
        findings: [{
          title: 'Incomplete finding',
          severity: 'high',
          description: 'Partial output should not be remembered.',
          confidence: 0.5,
        }],
        hypotheses: [],
        conclusion: '根因: 尚未完成。',
        confidence: 0.5,
        rounds: 1,
        totalDurationMs: 1000,
        partial: true,
      },
      previousTurnCount: 0,
      quickMode: true,
      sceneType: 'scrolling',
      architecture: { type: 'Standard' },
      packageName: 'com.example.app',
      options: {},
    });

    expect(saveQuick).not.toHaveBeenCalled();
    expect(saveFull).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it.each([
    ['codebase only', {codeAwareMode: 'metadata_only' as const, codebaseIds: ['app']}],
    ['private RAG only', {knowledgeSourceIds: ['wiki']}],
    ['source and private RAG', {
      codeAwareMode: 'provider_send' as const,
      codebaseIds: ['app'],
      knowledgeSourceIds: ['wiki'],
    }],
  ])('does not write cross-session pattern memory for %s', (_label, options) => {
    const runtime = createOpenAiRuntimeForTest();
    const saveQuick = jest.spyOn(patternMemory, 'saveQuickPathPattern').mockResolvedValue(undefined);
    const saveFull = jest.spyOn(patternMemory, 'saveAnalysisPattern').mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching').mockResolvedValue(false);

    runtime.recordPatternMemory({
      sessionId: 's-private-memory',
      result: {
        sessionId: 's-private-memory',
        success: true,
        findings: [{
          title: 'PRIVATE_PATTERN_CANARY',
          severity: 'high',
          description: 'Private source result.',
        }],
        hypotheses: [],
        conclusion: 'PRIVATE_PATTERN_CONCLUSION_CANARY',
        confidence: 0.8,
        rounds: 2,
        totalDurationMs: 1000,
      },
      previousTurnCount: 0,
      quickMode: false,
      sceneType: 'scrolling',
      architecture: {type: 'Standard'},
      packageName: 'com.example.app',
      options,
    });

    expect(saveQuick).not.toHaveBeenCalled();
    expect(saveFull).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('OpenAIRuntime previous response recovery', () => {
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

  it('keeps quick mode off the remote OpenAI response chain', () => {
    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: true,
      config: {
        ...createOpenAiConfigForTest(),
        outputLanguage: 'en',
      },
      sessionEntry: {
        history: [{ role: 'user', content: 'full-mode history' }],
        lastResponseId: 'resp_full',
        updatedAt: Date.now(),
      },
      effectivePrompt: 'what is the package name?',
      previousTurns: [{
        id: 'turn-1',
        timestamp: Date.now(),
        query: 'analyze startup',
        intent: {},
        result: { message: 'Startup report with TTID=1912ms' },
        findings: [{ title: 'TTID high', severity: 'medium' }],
        turnIndex: 0,
        completed: true,
      }],
    });

    expect(resolved.previousResponseId).toBeUndefined();
    expect(resolved.shouldPersistRemoteSession).toBe(false);
    expect(resolved.input).toEqual(expect.stringContaining('## Recent Conversation Context'));
    expect(resolved.input).toEqual(expect.stringContaining('what is the package name?'));
    expect(resolved.input).not.toEqual(expect.stringContaining('full-mode history'));
  });

  it('uses fresh previous response ids only for full-mode OpenAI runs', () => {
    const now = 1_700_000_000_000;

    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: false,
      config: {
        ...createOpenAiConfigForTest(),
        outputLanguage: 'en',
      },
      sessionEntry: {
        history: [{ role: 'user', content: 'previous question' }],
        lastResponseId: 'resp_fresh',
        updatedAt: now - 1_000,
      },
      effectivePrompt: 'continue',
      previousTurns: [],
      now,
    });

    expect(resolved.input).toBe('continue');
    expect(resolved.previousResponseId).toBe('resp_fresh');
    expect(resolved.shouldPersistRemoteSession).toBe(true);
  });

  it('does not send oversized retained history into a full-mode continuation', () => {
    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: false,
      config: {
        ...createOpenAiConfigForTest(),
        protocol: 'chat_completions',
        maxHistoryBytes: 256,
      },
      sessionEntry: {
        history: [{role: 'user', content: 'x'.repeat(2_000)}],
        updatedAt: Date.now(),
      },
      effectivePrompt: 'continue from bounded local context',
      previousTurns: [],
    });

    expect(resolved.input).toBe('continue from bounded local context');
    expect(JSON.stringify(resolved)).not.toContain('x'.repeat(256));
  });

  it('does not join or persist a remote response chain for private analyses', () => {
    const resolved = __testing.resolveOpenAIRunInput({
      quickMode: false,
      config: {
        ...createOpenAiConfigForTest(),
        outputLanguage: 'en',
      },
      sessionEntry: {
        history: [{role: 'user', content: 'PRIVATE_REMOTE_HISTORY_CANARY'}],
        lastResponseId: 'resp_private',
        updatedAt: Date.now(),
      },
      effectivePrompt: 'analyze selected source',
      previousTurns: [{
        id: 'private-turn',
        timestamp: Date.now(),
        query: 'previous private question',
        intent: {},
        result: {message: 'PRIVATE_LOCAL_OPENAI_CONTINUITY_CANARY'},
        findings: [],
        turnIndex: 0,
        completed: true,
      }],
      allowRemotePersistence: false,
    });

    expect(resolved.input).toEqual(expect.stringContaining('analyze selected source'));
    expect(resolved.input).toEqual(expect.stringContaining('PRIVATE_LOCAL_OPENAI_CONTINUITY_CANARY'));
    expect(resolved.previousResponseId).toBeUndefined();
    expect(resolved.shouldPersistRemoteSession).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain('PRIVATE_REMOTE_HISTORY_CANARY');
  });

  it('recognizes stale previous response errors from OpenAI Responses', () => {
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('No response found with id resp_old_123'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('previous_response_id does not exist'),
      'resp_old_123',
    )).toBe(true);
    expect(__testing.isMissingOpenAIPreviousResponseError(
      new Error('rate limit exceeded'),
      'resp_old_123',
    )).toBe(false);
  });

  it('does not expose stale OpenAI response mappings for persistence', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    runtime.sessionMap.set('s1', {
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears stale previous response ids while preserving local history', () => {
    const runtime = createOpenAiRuntimeForTest();
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_stale',
      runState: '{"state":true}',
      updatedAt: Date.now(),
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      runtime.forgetOpenAILastResponseId('s1', 'No response found with id resp_stale');
    } finally {
      warnSpy.mockRestore();
    }

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      history,
      lastResponseId: undefined,
      runState: undefined,
    }));
  });

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
