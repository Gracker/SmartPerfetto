// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {EventEmitter} from 'events';
import {spawn as spawnChildProcess} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {PassThrough} from 'stream';
import net from 'net';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  OpenCodeRuntime,
  completeOpenCodeFinalReportPhaseIfDelivered,
  createOpenCodeHardenedConfig,
  createOpenCodeStandaloneMcpConfig,
  createOpenCodeStandaloneMcpToolNames,
  createOpenCodeToolAllowlist,
  dispatchOpenCodeBridgeRequest,
  extractOpenCodeAssistantText,
  getOpenCodePlanCompletionStatus,
  getOpenCodeEngineCapabilities,
  getOpenCodeRuntimeDiagnostics,
  validateOpenCodeModelConfiguration,
  __testing as openCodeTesting,
  projectOpenCodeEventToStreamingUpdate,
  runOpenCodePrompt,
  sanitizeOpenCodeConclusionText,
  type OpenCodeSdkModuleLoader,
} from '../openCodeRuntime';
import type { RuntimeFactoryInput } from '../runtimeRegistry';
import type {AnalysisPlanV3} from '../../agentv3/types';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../runtimeToolResult';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import type { QueryResult, TraceInfo, TraceProcessorService } from '../../services/traceProcessorService';
import { createTraceProcessorQueryCancelledError } from '../../services/traceProcessorCancellation';
import {runOpenCodeIntentTransport} from '../engines/opencode/openCodeIntentTransport';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import * as claudeMcpModule from '../../agentv3/claudeMcpServer';
import * as turnIntentModule from '../analysisTurnIntent';
import * as sqlKnowledgeBase from '../../services/sqlKnowledgeBase';
import * as systemPromptModule from '../../agentv3/claudeSystemPrompt';
import * as traceCompletenessProber from '../../agentv3/traceCompletenessProber';
import * as runtimePromptContext from '../runtimePromptContext';
import * as finalResultQualityGate from '../../services/finalResultQualityGate';
import * as providerManager from '../../services/providerManager';
import * as sourceClaimVerifier from '../../services/codebase/sourceClaimVerifier';
import * as finalizationContext from '../analysisFinalizationContext';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {
  clearCodeAwareOutputGuards,
  registerCodeAwareCanary,
  revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from './sourceFinalizationFixture';
import {createRuntimePerformanceRecorder} from '../runtimePerformance';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import * as evaluationRuntimeHooks from '../../services/selfEvolution/evaluationRuntimeHooks';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {inspectCandidateProtocol} from '../../services/canonicalAnalysisResult';
import {createSceneRuntimeMatrixFixture} from '../../../tests/helpers/sceneRuntimeMatrixFixture';
import {candidateWithPopulation} from '../../../tests/helpers/conclusionDeclarationFixture';

const mockOpenCodeIntentTransport = jest.fn<typeof runOpenCodeIntentTransport>();
jest.mock('../engines/opencode/openCodeIntentTransport', () => ({
  runOpenCodeIntentTransport: (input: Parameters<typeof runOpenCodeIntentTransport>[0]) => mockOpenCodeIntentTransport(input),
}));
const BOUNDED_INTENT = {
  schemaVersion: 1, taskKind: 'fact', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new',
};
function useIntent(decision: Record<string, unknown>): void {
  mockOpenCodeIntentTransport.mockResolvedValue({status: 'ok', text: JSON.stringify(decision)});
}

const mockClaudeVerifierVerifyConclusion = jest.fn();
jest.mock('../engines/claude/claudeVerifier', () => {
  const actual = jest.requireActual('../engines/claude/claudeVerifier') as any;
  return {
    ...actual,
    verifyConclusion: (...args: unknown[]) => mockClaudeVerifierVerifyConclusion(...args),
  };
});

type FakeTraceProcessorService = TraceProcessorService & {
  query: jest.MockedFunction<(traceId: string, sql: string) => Promise<QueryResult>>;
  getTrace: jest.MockedFunction<(traceId: string) => TraceInfo>;
};

beforeEach(() => {
  mockOpenCodeIntentTransport.mockReset();
  useIntent(BOUNDED_INTENT);
  const actualVerifier = jest.requireActual('../engines/claude/claudeVerifier') as any;
  mockClaudeVerifierVerifyConclusion.mockReset();
  mockClaudeVerifierVerifyConclusion.mockImplementation((...args: unknown[]) => (
    actualVerifier.verifyConclusion(...args)
  ));
});

function createFakeTraceProcessorService(): FakeTraceProcessorService {
  return {
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    getTrace: jest.fn(() => ({
      id: 'trace-opencode',
      filename: 'trace.pftrace',
      size: 1,
      uploadTime: new Date(),
      status: 'ready',
      traceOs: 'android',
      traceFormat: 'perfetto_protobuf',
    })),
  } as unknown as FakeTraceProcessorService;
}

function createFakeRuntimeInput(overrides: Partial<RuntimeFactoryInput> = {}): RuntimeFactoryInput {
  return {
    traceProcessorService: overrides.traceProcessorService ?? createFakeTraceProcessorService(),
    selection: overrides.selection ?? {
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      source: 'env',
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

async function withBackendDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-state-'));
  const previous = process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
    else process.env.SMARTPERFETTO_BACKEND_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
): RunManifestAttributionSink {
  return {
    identity: {
      runId: 'run-opencode-test',
      sessionId: 'session-opencode',
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

function createFakeModuleLoader(record: {
  createOptions?: Record<string, unknown>;
  promptInput?: unknown;
  closeCount: number;
}): OpenCodeSdkModuleLoader {
  return jest.fn(async () => ({
    createOpencodeWithEnv: jest.fn(async (options: Record<string, unknown>) => {
      record.createOptions = options;
      return {
        server: {
          url: 'http://127.0.0.1:4106',
          close: jest.fn(() => {
            record.closeCount += 1;
          }),
        },
        client: {
          session: {
            create: jest.fn(async () => ({ data: { id: 'ses-opencode-test' } })),
            prompt: jest.fn(async (input: unknown) => {
              record.promptInput = input;
              return { data: { info: { role: 'user' }, parts: [] } };
            }),
          },
        },
      };
    }),
  }));
}

function createCompletedScrollingPlanWithFinalPhase(): any {
  return {
    phases: [
      {
        id: 'p1',
        name: '滑动概览与代表帧深钻',
        goal: '采集全量掉帧类型统计和带覆盖率的根因样本并深钻代表帧',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{tool: 'invoke_skill', skillId: 'jank_frame_detail'}],
        status: 'completed',
        summary: '已采集全量掉帧类型统计和带覆盖率的根因样本，并用 jank_frame_detail 完成代表帧机制级深钻。',
      },
      {
        id: 'p2',
        name: '综合结论',
        goal: '输出完整最终报告',
        expectedTools: [],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '输出包含完整滑动场景合同的最终报告',
    submittedAt: 1,
    toolCallLog: [{
      toolName: 'invoke_skill',
      skillId: 'jank_frame_detail',
      inputSummary: 'jank_frame_detail(frameId)',
      success: true,
      matchedPhaseId: 'p1',
      timestamp: 1,
    }],
  };
}

function createCompletedStartupPlanWithFinalPhase(): any {
  return {
    phases: [
      {
        id: 'p1',
        name: '启动证据采集与根因深钻',
        goal: '采集启动指标、阶段分解与根因证据',
        expectedTools: [],
        status: 'completed',
        summary: '已完成启动类型、TTID/TTFD、阶段耗时和根因证据采集。',
      },
      {
        id: 'p2',
        name: '综合结论',
        goal: '输出完整启动分析报告',
        expectedTools: [],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '输出包含完整启动场景合同的最终报告',
    submittedAt: 1,
    toolCallLog: [
      {toolName: 'invoke_skill', skillId: 'anr_analysis', success: true, timestamp: 1},
      {toolName: 'invoke_skill', skillId: 'startup_analysis', success: true, timestamp: 2},
    ],
  };
}

function mockOpenCodePreparation(
  runtime: OpenCodeRuntime,
  plan: any,
  sceneType: 'scrolling' | 'startup' | 'anr',
  prompt: string,
  hypotheses: any[] = [],
  sourceUse?: {getSourceUseDecision(): unknown},
  quickMode = false,
): void {
  jest.spyOn(runtime as any, 'prepareAnalysis').mockResolvedValue({
    systemPrompt: 'SmartPerfetto system prompt',
    prompt,
    toolDefinitions: [],
    allowedToolNames: new Set<string>(),
    quickMode,
    sceneType,
    packageName: 'com.example.app',
    sessionContext: {addTurn: jest.fn()},
    previousTurns: [],
    analysisPlan: {current: plan, history: []},
    notes: [],
    hypotheses,
    uncertaintyFlags: [],
    analysisRunSpec: {
      runtime: {kind: OPENCODE_RUNTIME_KIND},
      query: {text: prompt},
      outputLanguage: 'zh-CN',
      traceContext: {datasetCount: 0},
      mode: {},
    },
    ...(sourceUse ? {sourceUse} : {}),
  });
}

function mockOpenCodeScrollingPreparation(runtime: OpenCodeRuntime, plan: any): void {
  mockOpenCodePreparation(runtime, plan, 'scrolling', '分析滑动性能');
}

function openCodeAssistantResponse(id: string, text: string): unknown {
  return {
    data: {
      info: {role: 'assistant', finish: 'stop', id},
      parts: [{type: 'text', text}],
    },
  };
}

function readPromptContextFrame(system: string | undefined, context: string): unknown {
  for (const line of system?.split('\n') ?? []) {
    try {
      const frame: unknown = JSON.parse(line);
      if (frame && typeof frame === 'object' && 'context' in frame && frame.context === context && 'data' in frame) {
        return frame.data;
      }
    } catch {
      // External prose assets surround the typed context frames.
    }
  }
  return undefined;
}

function createOpenCodeReportModuleLoader(
  responses: Array<unknown | (() => unknown | Promise<unknown>)>,
  promptInputs: unknown[],
  close: () => void,
): OpenCodeSdkModuleLoader {
  const prompt = jest.fn(async (input: unknown) => {
    promptInputs.push(input);
    const nextResponse = responses.shift();
    const response = typeof nextResponse === 'function'
      ? await nextResponse()
      : nextResponse;
    if (response instanceof Error) throw response;
    return response ?? openCodeAssistantResponse('empty', '');
  });
  return jest.fn(async () => ({
    createOpencodeWithEnv: jest.fn(async () => ({
      server: {url: 'http://127.0.0.1:4106', close},
      client: {
        session: {
          create: jest.fn(async () => ({data: {id: 'ses-opencode-report'}})),
          prompt,
        },
      },
    })),
  }));
}

function createNativeIntentHarness(input: {
  decision?: Record<string, unknown>;
  classifierResponse?: unknown;
  answer?: string;
  finish?: string;
  nativeError?: boolean;
  closeoutAnswer?: string;
  closeoutError?: boolean;
  mainMessages?: Record<string, unknown>[];
  beforeClassifierReply?: () => Promise<void>;
  beforeAnswerReply?: () => Promise<void>;
  env?: Record<string, string>;
  selection?: RuntimeFactoryInput['selection'];
} = {}) {
  const native = jest.requireActual('../engines/opencode/openCodeIntentTransport') as {
    runOpenCodeIntentTransport: typeof runOpenCodeIntentTransport;
  };
  mockOpenCodeIntentTransport.mockImplementation(native.runOpenCodeIntentTransport);
  const traceProcessor = createFakeTraceProcessorService();
  const configs: any[] = [];
  const prompts: any[] = [];
  const directories: string[] = [];
  const serverCloses: Array<ReturnType<typeof jest.fn>> = [];
  const aborts: Array<ReturnType<typeof jest.fn>> = [];
  const messageReadLimits: number[] = [];
  let tools: any[] = [];
  const moduleLoader = jest.fn<OpenCodeSdkModuleLoader>(async () => ({
    createOpencodeWithEnv: async (options: Record<string, unknown>) => {
      const index = configs.length;
      configs.push(options.config);
      const close = jest.fn<() => void>();
      const abort = jest.fn(async () => ({}));
      serverCloses.push(close);
      aborts.push(abort);
      return {
        server: {url: 'http://127.0.0.1:4106', close},
        client: {session: {
          create: async request => {
            directories.push(request.query?.directory ?? '');
            return {data: {id: `native-${index}`}};
          },
          abort,
          ...(index === 1 && input.mainMessages ? {
            promptAsync: async (request: unknown) => {prompts.push(request); await input.beforeAnswerReply?.(); return {};},
            messages: async (request: {query?: {limit?: number}}) => {
              const limit = request.query?.limit ?? 50;
              messageReadLimits.push(limit);
              return {data: [...input.mainMessages!].reverse().slice(0, limit)};
            },
            status: async () => ({data: {[`native-${index}`]: {type: 'busy'}}}),
          } : {}),
          prompt: async request => {
            prompts.push(request);
            if (index === 0) {
              expect(traceProcessor.query).not.toHaveBeenCalled();
              await input.beforeClassifierReply?.();
              return input.classifierResponse ?? {data: {
                info: {id: 'intent-message', role: 'assistant', finish: 'stop',
                  time: {completed: Date.now()}, modelID: 'light-model'},
                parts: [{type: 'text', text: JSON.stringify(input.decision ?? BOUNDED_INTENT)}],
              }};
            }
            if (index > 1) {
              if (input.closeoutError) throw new Error('closeout provider failure');
              return {data: {info: {id: 'closeout-message', role: 'assistant', finish: 'stop',
                time: {completed: Date.now()}, modelID: 'main-model'},
                parts: [{type: 'text', text: input.closeoutAnswer ?? 'The cause remains unknown; ask about the main-thread interval.'}]}};
            }
            await input.beforeAnswerReply?.();
            return {data: {
              info: {id: 'current-message', role: 'assistant', finish: input.finish ?? 'stop',
                ...(input.nativeError ? {error: {name: 'ProviderError'}} : {}),
                time: {completed: Date.now()}, modelID: 'main-model'},
              parts: [{type: 'text', text: input.answer ?? '已有证据仅支持这个局部结论'}],
            }};
          },
        }},
      };
    },
  }));
  const bridgeClose = jest.fn(async () => undefined);
  const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
    selection: input.selection ?? {kind: OPENCODE_RUNTIME_KIND, source: 'env'}, traceProcessorService: traceProcessor,
  }), {
    env: {
      SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({providerID: 'smartperfetto',
        modelID: 'main-model', smallModel: 'light-model'}),
      AGENT_QUICK_MAX_TURNS: '3', AGENT_MAX_TURNS: '9',
      ...input.env,
    },
    moduleLoader,
    bridgeStarter: (async (definitions: any[]) => {
      tools = definitions;
      return {port: 4107, token: 'fixture-token', requestTimeoutMs: 5000, close: bridgeClose,
        getDiagnostics: () => ({connectionCount: 0, requestCount: 0})};
    }) as any,
  });
  return {runtime, traceProcessor, configs, prompts, directories, serverCloses, aborts,
    moduleLoader, bridgeClose, messageReadLimits, getTools: () => tools};
}

describe('OpenCode native turn intent and delivery', () => {
  it('scene runtime matrix: runs the pinned OpenCode provider through shared bridge proposal and private seal', async () => {
    const f = createSceneRuntimeMatrixFixture('opencode');
    let definitions: any[] = [];
    let response: any;
    const prompts: any[] = [];
    const bridgeClose = jest.fn(async () => undefined);
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({traceProcessorService: f.traceProcessorService,
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'}}), {
      env: {SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({providerID: 'smartperfetto', modelID: 'scene-pinned-opencode'})},
      moduleLoader: createOpenCodeReportModuleLoader([async () => {
        response = await dispatchOpenCodeBridgeRequest(definitions, {jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {name: 'propose_scene_timeline', arguments: f.proposal()}}, undefined, {getSignal: () => f.controller.signal});
        return openCodeAssistantResponse('scene-main', 'Scene candidates submitted.');
      }], prompts, () => undefined),
      bridgeStarter: (async (tools: any[]) => {definitions = tools; return {port: 4107, token: 'scene-test-token',
        requestTimeoutMs: 5000, close: bridgeClose, getDiagnostics: () => ({connectionCount: 0, requestCount: 0})};}) as any,
    });
    try {
      const result = await runtime.analyze('Reconstruct this trace', f.scope.sessionId, f.scope.traceId, f.options);
      expect(result.turnIntent).toMatchObject({source: 'product', sceneId: 'scene_reconstruction'});
      expect(mockOpenCodeIntentTransport.mock.calls.filter(([input]) => input.systemPrompt === '')).toHaveLength(0);
      expect(JSON.stringify(prompts[0])).toContain('scene-pinned-opencode');
      expect(response.result.structuredContent).toMatchObject({accepted: true, revision: 1});
      const snapshot = f.seal();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.runId).toBe(f.scope.runId);
      expect(snapshot.segments[0].evidence[0].source.originRunId).toBe(f.scope.runId);
      expect(f.boundsQueries).toEqual([f.scope.traceId]);
      f.controller.abort();
      const late = await dispatchOpenCodeBridgeRequest(definitions, {jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {name: 'propose_scene_timeline', arguments: f.proposal()}}, undefined, {getSignal: () => f.controller.signal})
        .catch((error: Error) => ({error: error.message}));
      expect(JSON.stringify(late)).not.toContain('"accepted":true');
    } finally {await runtime.cleanupSession(f.scope.sessionId); f.binding.release();}
    expect((runtime as any).artifactStores.has(f.scope.sessionId)).toBe(false);
    expect(bridgeClose).toHaveBeenCalled();
  });
  it.each([false, true])('uses one pinned no-tool closeout and counts its attempt even on failure: %s', async closeoutError => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({finish: 'tool-calls', answer: 'Only the frame interval is known.',
      closeoutAnswer: 'The frame interval is known. The cause is unverified; inspect the main-thread interval next.',
      closeoutError, env: {AGENT_QUICK_MAX_TURNS: '2'}});
    const result = await harness.runtime.analyze('Continue the diagnosis', `closeout-${closeoutError}`, 'trace-opencode', {analysisMode: 'fast'});
    expect(result).toMatchObject({partial: true, rounds: 2, terminationReason: 'max_turns',
      completion: {status: 'incomplete', reason: 'turn_limit'},
      quickRun: {hardCapTurns: 2, actualTurns: 2}});
    expect(result.conclusion).toBe(closeoutError ? 'Only the frame interval is known.'
      : 'The frame interval is known. The cause is unverified; inspect the main-thread interval next.');
    expect(harness.prompts).toHaveLength(3);
    expect(harness.configs.map(config => config.agent.smartperfetto.maxSteps)).toEqual([1, 1, 1]);
    expect(harness.prompts[2].body.model).toEqual(harness.prompts[1].body.model);
    expect(Object.values(harness.prompts[2].body.tools).every(value => value === false)).toBe(true);
    expect(harness.prompts[2].body.parts[0].text).toContain('Only the frame interval is known.');
    expect(harness.aborts[1]).toHaveBeenCalledTimes(1);
    expect(harness.bridgeClose).toHaveBeenCalledTimes(1);
    expect(finalizationContext.takeFinalizationContext(result)?.hasSemanticTransport).toBe(false);
  }));

  it('does not expand a one-turn OpenCode budget with a hidden closeout call', async () => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({finish: 'tool-calls', answer: 'Partial finding', env: {AGENT_QUICK_MAX_TURNS: '1'}});
    const result = await harness.runtime.analyze('Continue', 'closeout-one', 'trace-opencode', {analysisMode: 'fast'});
    expect(result).toMatchObject({conclusion: 'Partial finding', rounds: 1, partial: true,
      completion: {status: 'incomplete', reason: 'turn_limit'}});
    expect(harness.prompts).toHaveLength(2);
  }));

  it('skips closeout when native turns between observations already consume the total budget', async () => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({env: {AGENT_QUICK_MAX_TURNS: '3'},
      mainMessages: [1, 2, 3, 4].map(index => ({info: {role: 'assistant', finish: 'tool-calls', id: `overshoot-${index}`},
        parts: [{type: 'text', text: `Finding ${index}`}]}))});
    const result = await harness.runtime.analyze('Investigate', 'overshoot', 'trace-opencode', {analysisMode: 'fast'});
    expect(result).toMatchObject({conclusion: 'Finding 4', rounds: 4, partial: true,
      completion: {status: 'incomplete', reason: 'turn_limit'}, terminationReason: 'max_turns'});
    expect(result.terminationMessage).toContain('OpenCode');
    expect(harness.prompts).toHaveLength(2);
    expect(harness.aborts[1]).toHaveBeenCalledTimes(1);
  }));

  it.each([99, 103])('expands a fresh full-run window and counts %s unique native turns', async actualTurns => withBackendDataDir(async () => {
    const mainMessages = Array.from({length: actualTurns}, (_, index) => ({
      info: {role: 'assistant', finish: 'tool-calls', id: `full-cap-${index + 1}`},
      parts: [{type: 'text', text: `Full finding ${index + 1}`}],
    }));
    // The provider may repeat a message in a paged response; that is one turn.
    mainMessages.splice(20, 0, mainMessages[20]);
    const harness = createNativeIntentHarness({env: {AGENT_MAX_TURNS: '100'}, mainMessages});
    const result = await harness.runtime.analyze('Investigate full trace', `full-cap-${actualTurns}`, 'trace-opencode', {analysisMode: 'full'});
    const closeoutAllowed = actualTurns < 100;
    expect(result).toMatchObject({rounds: actualTurns + (closeoutAllowed ? 1 : 0), partial: true,
      completion: {status: 'incomplete', reason: 'turn_limit'}, terminationReason: 'max_turns'});
    expect(harness.messageReadLimits).toEqual([50, 100, 200, 50, 100, 200]);
    expect(harness.configs[1].agent.smartperfetto.maxSteps).toBe(99);
    expect(harness.prompts).toHaveLength(closeoutAllowed ? 3 : 2);
    if (!closeoutAllowed) expect(result.conclusion).toBe(`Full finding ${actualTurns}`);
    expect(harness.aborts[1]).toHaveBeenCalledTimes(1);
  }));

  it('aborts active OpenCode acquisition on observed cap and retains multiple turns between polls', async () => {
    const messages = [1, 2, 3, 4].map(index => ({info: {role: 'assistant', finish: 'tool-calls', id: `cap-${index}`},
      parts: [{type: 'text', text: `Observed ${index}`}]}));
    const events: string[] = [];
    const readMessages = jest.fn(async () => ({data: [...messages].reverse()}));
    const abort = jest.fn(async () => {events.push('abort'); return {};});
    const pollDelay = jest.fn(async () => undefined);
    const result = await runOpenCodePrompt({server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
      client: {session: {create: jest.fn(async () => ({data: {id: 'cap'}})), prompt: jest.fn(async () => ({})), promptAsync: async () => ({}),
        messages: readMessages, status: async () => ({data: {cap: {type: 'busy'}}}), abort}}},
    {path: {id: 'cap'}, body: {parts: [{type: 'text', text: 'Investigate'}]}}, {
      sessionId: 'cap', projectDir: '/tmp/opencode-cap', timeoutMs: 1000, resumedSession: false,
      maxSteps: 2, onTurnLimit: () => {events.push('tools-closed');}, pollDelay,
    });
    expect(result).toMatchObject({turnLimitReached: true, messagesResponse: {data: messages}});
    expect(events).toEqual(['tools-closed', 'abort']);
    expect(readMessages).toHaveBeenCalledTimes(2);
    expect(pollDelay).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps pending exploration advisory after native completion or failure: failed=%s', async nativeError => withBackendDataDir(async () => {
    const body = 'The observed value is 17.';
    const harness = createNativeIntentHarness({answer: body, nativeError, beforeAnswerReply: async () => {
      const submitPlan = harness.getTools().find(tool => tool.name === 'submit_plan');
      await submitPlan.shared.handler({phases: [{id: 'explore', name: 'Optional exploration',
        goal: 'Investigate a further explanation', expectedTools: ['execute_sql']}], successCriteria: 'Explore the open question'});
      const submitHypothesis = harness.getTools().find(tool => tool.name === 'submit_hypothesis');
      await submitHypothesis.shared.handler({id: 'open-hypothesis', statement: 'A separate cause may exist.'});
    }});
    const sessionId = `opencode-advisory-${nativeError}`;
    const result = await harness.runtime.analyze('Read the current value', sessionId, 'trace-opencode', {runId: sessionId});
    expect(harness.prompts).toHaveLength(nativeError ? 2 : 3);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
    expect(result.completion).toMatchObject({status: nativeError ? 'failed' : 'completed',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
    expect(result.success).toBe(!nativeError);
    expect(result.partial === true).toBe(nativeError);
    expect(result.terminationReason).toBe(nativeError ? 'quality_gate_failed' : undefined);
    const verification = await mockClaudeVerifierVerifyConclusion.mock.results[0].value;
    expect(verification).toMatchObject({heuristicIssues: expect.arrayContaining([
      expect.objectContaining({type: 'plan_deviation', severity: 'error'}),
      expect.objectContaining({type: 'unresolved_hypothesis', severity: 'error'}),
    ])});
    const snapshot = harness.runtime.takeSnapshot(sessionId, 'trace-opencode', createSnapshotFields());
    expect(snapshot.analysisPlan?.phases).toEqual([expect.objectContaining({id: 'explore', status: 'pending'})]);
    expect(snapshot.claudeHypotheses).toEqual([expect.objectContaining({id: 'open-hypothesis', status: 'formed'})]);
  }));

  it('uses the reserved delivery turn to repair a rejected declaration around the unchanged body', async () => withBackendDataDir(async () => {
    const body = 'Frame 12 missed its deadline.';
    const harness = createNativeIntentHarness({answer: candidateWithPopulation(body, 'everywhere'), closeoutAnswer: candidateWithPopulation(body, 'cited_rows')});
    const result = await harness.runtime.analyze('same scope', 'opencode-invalid-declaration', 'trace-opencode', {
      analysisMode: 'full', runId: 'opencode-invalid-declaration',
    });
    expect(harness.prompts).toHaveLength(3);
    expect(harness.prompts[2].body.parts[0].text).toContain('invalid_declaration');
    expect(inspectCandidateProtocol(result.conclusion)).toMatchObject({status: 'valid'});
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
    finalizationContext.takeFinalizationContext(result)?.dispose();
  }));

  it('uses the reserved no-tools delivery turn for an unchanged full declaration candidate', async () => withBackendDataDir(async () => {
    const body = `${'启动正文保持完整。'.repeat(850)}\n${'Native body remains unchanged. '.repeat(170)}`.trimEnd();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8 * 1024);
    const sidecar = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: 'The authored body is preserved.'}], clusters: [], evidenceChain: [],
      claims: [], uncertainties: [], nextSteps: []} as ConclusionContract);
    const repaired = `${body}\n${sidecar}`;
    const harness = createNativeIntentHarness({answer: body, closeoutAnswer: repaired});
    const result = await harness.runtime.analyze('same scope', 'opencode-missing-declaration', 'trace-opencode', {
      analysisMode: 'full', runId: 'opencode-missing-declaration',
    });
    expect(harness.prompts).toHaveLength(3);
    expect(harness.configs[2].agent.smartperfetto.maxSteps).toBe(1);
    expect(Object.values(harness.prompts[2].body.tools).every(value => value === false)).toBe(true);
    expect(harness.prompts[2].body.parts[0].text).toContain('missing_declaration');
    expect(inspectCandidateProtocol(repaired).canonicalBody.trim()).toBe(body);
    expect(inspectCandidateProtocol(result.conclusion).canonicalBody.trim()).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed'});
    const context = finalizationContext.takeFinalizationContext(result)!;
    try { expect(context.getNativeDeclaration(result, new AbortController().signal)?.raw).toBe(repaired); }
    finally { context.dispose(); }
  }));

  it('does not dispatch declaration completion when the original body cannot fit the OpenCode output cap', async () => withBackendDataDir(async () => {
    const body = 'x'.repeat(64 * 1024);
    const harness = createNativeIntentHarness({answer: body});
    const result = await harness.runtime.analyze('same scope', 'opencode-declaration-output-cap', 'trace-opencode', {
      analysisMode: 'full',
    });
    expect(harness.prompts).toHaveLength(2);
    expect(harness.configs).toHaveLength(2);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed'});
  }));

  it('retains the original OpenCode attempt when a dispatched declaration completion changes the body', async () => withBackendDataDir(async () => {
    const body = 'Original bounded answer.';
    const changed = `Changed bounded answer.\n${renderConclusionContractSidecar({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
    })}`;
    const harness = createNativeIntentHarness({answer: body, closeoutAnswer: changed});
    const updates: unknown[] = [];
    harness.runtime.on('update', update => updates.push(update));
    const result = await harness.runtime.analyze('same scope', 'opencode-declaration-rejected', 'trace-opencode', {
      analysisMode: 'full', runId: 'opencode-declaration-rejected',
    });
    expect(harness.prompts).toHaveLength(3);
    expect(harness.configs).toHaveLength(3);
    expect(result.conclusion).toBe(body);
    expect(result.completion).toMatchObject({status: 'completed', runId: 'opencode-declaration-rejected',
      conclusionFingerprint: analysisDeliveryFingerprint(body)});
    expect(JSON.stringify(updates)).not.toContain('Changed bounded answer');
    expect(harness.serverCloses.every(close => close.mock.calls.length === 1)).toBe(true);
  }));

  it('attaches a single final context to the exact projected object and dispatches review on the pinned main model', async () => withBackendDataDir(async () => {
    const attach = jest.spyOn(finalizationContext, 'attachFinalizationContext');
    const readView = jest.spyOn(ArtifactStore.prototype, 'createEvidenceReadView');
    let context: ReturnType<typeof finalizationContext.takeFinalizationContext>;
    try {
      const harness = createNativeIntentHarness({env: {
        SMARTPERFETTO_OPENCODE_PROMPT_TIMEOUT_MS: '5000',
        SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({providerID: 'smartperfetto',
          modelID: 'main-model', smallModel: 'light-model', name: 'Pinned provider',
          baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'fixture-api-key'}),
      }});
      const options = {runId: 'final-run', referenceTraceId: 'trace-reference', codeAwareMode: 'off' as const,
        tenantId: 'tenant-opencode', workspaceId: 'workspace-opencode', userId: 'user-opencode',
        analysisContextFingerprint: '', selectionContext: {kind: 'track_event' as const, eventId: 7, ts: 42}};
      const analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(options, resolveKnowledgeScope(options));
      options.analysisContextFingerprint = analysisContextFingerprint;
      const result = await harness.runtime.analyze('same scope', 'final-context', 'trace-opencode', options);
      expect(attach).toHaveBeenCalledTimes(1);
      expect(attach.mock.calls[0][0]).toBe(result);
      expect(finalizationContext.takeFinalizationContext({...result})).toBeUndefined();
      context = finalizationContext.takeFinalizationContext(result);
      expect(context).toBeDefined();
      expect(context?.sourceScope).toMatchObject({codeAwareMode: 'off', selectedCodebaseIds: [],
        hasCodebaseAccess: false, analysisContextFingerprint});
      options.analysisContextFingerprint = 'later-auth-context';
      const providerQuery = context!.getProviderQuery(new AbortController().signal);
      expect(providerQuery).toEqual({text: 'same scope', analysisContextFingerprint});
      expect(Object.isFrozen(providerQuery)).toBe(true);
      expect(context!.getSelection(new AbortController().signal)).toEqual({present: true, kind: 'track_event',
        context: options.selectionContext, sideResolution: {status: 'unknown'}});
      expect(JSON.stringify(result)).not.toContain('"providerQuery"');
      expect(finalizationContext.takeFinalizationContext(result)).toBeUndefined();
      expect(context?.traceIdentity).toEqual({currentTraceId: 'trace-opencode', referenceTraceId: 'trace-reference'});
      expect(context?.deliveryContext).toMatchObject({acceptedCandidate: result.completion});
      expect(readView).toHaveBeenCalledTimes(1);
      expect(readView.mock.calls[0][0].currentRunId).toBe(context!.runId);
      expect(readView.mock.calls[0][0]).toMatchObject({allowedTraces: [
        {traceId: 'trace-opencode', traceSide: 'current'},
        {traceId: 'trace-reference', traceSide: 'reference'},
      ], ownerKey: expect.any(String)});
      const response = await context!.dispatchText({
        prompt: 'Review the current candidate', systemPrompt: '',
        signal: new AbortController().signal, deadlineMs: context!.deadlineMs + 60_000,
        outputByteLimit: 8192,
      });
      expect(response).toMatchObject({status: 'ok', actualModel: 'main-model'});
      expect(mockOpenCodeIntentTransport.mock.calls[1][0].deadlineMs).toBe(context!.deadlineMs);
      expect(harness.configs[2]).toMatchObject({model: 'smartperfetto/main-model', mcp: {}, instructions: [],
        agent: {smartperfetto: {maxSteps: 1}}});
      for (const config of [harness.configs[1], harness.configs[2]]) {
        expect(config.provider.smartperfetto).toMatchObject({
          npm: '@ai-sdk/openai-compatible', name: 'Pinned provider',
          options: {baseURL: 'http://127.0.0.1:9999/v1', apiKey: 'fixture-api-key'},
          models: {'main-model': {id: 'main-model', tool_call: true, reasoning: false,
            temperature: true, modalities: {input: ['text'], output: ['text']}}},
        });
        expect(config.provider.smartperfetto.models['main-model']).not.toHaveProperty('limit');
      }
      expect(harness.prompts[2].body.model).toEqual({providerID: 'smartperfetto', modelID: 'main-model'});
      expect(Object.values(harness.prompts[2].body.tools).every(enabled => enabled === false)).toBe(true);
      expect(harness.serverCloses[2]).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.dirname(harness.directories[2]))).toBe(false);
    } finally {
      context?.dispose(); readView.mockRestore(); attach.mockRestore();
    }
  }));

  it('retains failure state in finalization without granting another model dispatch', async () => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({nativeError: true});
    const result = await harness.runtime.analyze('same scope', 'final-failed', 'trace-opencode', {runId: 'failed-run'});
    const context = finalizationContext.takeFinalizationContext(result);
    try {
      expect(context?.deliveryContext).toMatchObject({completion: {runId: 'failed-run', status: 'failed'}});
      expect(context?.sourceScope).toMatchObject({codeAwareMode: 'metadata_only', selectedCodebaseIds: [], hasCodebaseAccess: false});
      expect(context?.hasSemanticTransport).toBe(false);
      expect(await context?.dispatchText({prompt: 'unused', systemPrompt: '', signal: new AbortController().signal,
        deadlineMs: Date.now() + 5000, outputByteLimit: 8192})).toEqual({status: 'unavailable', reason: 'invalid_configuration'});
      expect(harness.prompts).toHaveLength(2);
    } finally {
      context?.dispose();
    }
  }));

  it.each([
    ['zh', '这个观察包含 PRIVATE_CANARY，需要保留已有证据边界'],
    ['en', 'This observation contains PRIVATE_CANARY with an explicit evidence boundary'],
    ['ar', 'تحتوي هذه الملاحظة على PRIVATE_CANARY مع حدود الأدلة'],
  ])('carries a redacted %s candidate through the returned delivery context', async (language, answer) => withBackendDataDir(async () => {
    const sessionId = `privacy-redacted-${language}`;
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const gate = jest.spyOn(finalResultQualityGate, 'applyFinalResultQualityGate');
    try {
      const harness = createNativeIntentHarness({answer});
      const result = await harness.runtime.analyze('same scope', sessionId, 'trace-opencode');
      const projectionResult = projection.mock.results[0];
      if (projectionResult.type !== 'return') throw new Error('Source projection did not return');
      const projected = projectionResult.value;
      expect(projected.conclusionProjection.disposition).toBe('redacted');
      expect(result.outputOrigin).toBe('sdk_final');
      expect(result.completion?.status).toBe('completed');
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      expect(result.completion?.conclusionFingerprint).not.toBe(analysisDeliveryFingerprint(answer));
      expect(gate.mock.calls[0][0].context).toBe(projected.deliveryContext);
      expect(mockClaudeVerifierVerifyConclusion.mock.calls[0][2]).toMatchObject({deliveryContext: projected.deliveryContext});
      expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    } finally {
      gate.mockRestore(); projection.mockRestore(); clearCodeAwareOutputGuards(sessionId);
    }
  }));

  it.each([
    ['zh', '原始模型结论'], ['en', 'Native model conclusion'], ['ar', 'استنتاج النموذج الأصلي'],
  ])('does not certify a whole %s privacy replacement as an SDK answer', async (language, answer) => withBackendDataDir(async () => {
    const sessionId = `privacy-replaced-${language}`;
    revokeCodeAwareOutputGuards(sessionId);
    const projection = jest.spyOn(sourceClaimVerifier, 'finalizeOwnerSourceAwareAnalysisResultWithProjection');
    const gate = jest.spyOn(finalResultQualityGate, 'applyFinalResultQualityGate');
    try {
      const harness = createNativeIntentHarness({answer});
      const result = await harness.runtime.analyze('same scope', sessionId, 'trace-opencode');
      const projectionResult = projection.mock.results[0];
      if (projectionResult.type !== 'return') throw new Error('Source projection did not return');
      const projected = projectionResult.value;
      expect(projected.conclusionProjection.disposition).toBe('replaced');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
      expect(result.completion?.status).toBe('unknown');
      expect(gate.mock.calls[0][0].context).toBe(projected.deliveryContext);
      expect(mockClaudeVerifierVerifyConclusion.mock.calls[0][2]).toMatchObject({deliveryContext: projected.deliveryContext});
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally {
      gate.mockRestore(); projection.mockRestore(); clearCodeAwareOutputGuards(sessionId);
    }
  }));

  it('retains native failure after partial privacy redaction', async () => withBackendDataDir(async () => {
    const sessionId = 'privacy-native-failure';
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    try {
      const harness = createNativeIntentHarness({answer: 'Partial PRIVATE_CANARY output', nativeError: true});
      const result = await harness.runtime.analyze('same scope', sessionId, 'trace-opencode');
      expect(result).toMatchObject({success: false, partial: true,
        completion: {status: 'failed', reason: 'provider_error'}});
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally {
      clearCodeAwareOutputGuards(sessionId);
    }
  }));

  it('does not certify a revoked-session replacement of an empty native answer', async () => withBackendDataDir(async () => {
    const sessionId = 'privacy-native-empty';
    revokeCodeAwareOutputGuards(sessionId);
    try {
      const harness = createNativeIntentHarness({answer: ''});
      const result = await harness.runtime.analyze('same scope', sessionId, 'trace-opencode');
      expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}});
      expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally {
      clearCodeAwareOutputGuards(sessionId);
    }
  }));

  it('does not finalize or publish a late private answer after cancellation', async () => withBackendDataDir(async () => {
    const sessionId = 'privacy-native-cancel';
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const entered = createDeferred<void>();
    const pending = createDeferred<void>();
    const gate = jest.spyOn(finalResultQualityGate, 'applyFinalResultQualityGate');
    try {
      const harness = createNativeIntentHarness({answer: 'Late PRIVATE_CANARY output', beforeAnswerReply: async () => {
        entered.resolve(); await pending.promise;
      }});
      const updates: any[] = [];
      harness.runtime.on('update', update => updates.push(update));
      const operation = harness.runtime.analyze('same scope', sessionId, 'trace-opencode');
      const rejected = expect(operation).rejects.toThrow();
      await entered.promise;
      await harness.runtime.abortSession(sessionId);
      await rejected;
      pending.resolve();
      expect(gate).not.toHaveBeenCalled();
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.some(update => update.type === 'conclusion')).toBe(false);
      expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
    } finally {
      pending.resolve(); gate.mockRestore(); clearCodeAwareOutputGuards(sessionId);
    }
  }));

  it.each([
    ['short unheaded answer', '值来自已核对的证据'],
    ['provider error discussed as trace content', '日志里的 provider error 是本次调查对象'],
    ['long report-shaped prose', '# Analysis\n\n' + '已观察到的局部事实。'.repeat(150)],
  ])('uses SDK completion for %s', async (_label, answer) => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({answer});
    const result = await harness.runtime.analyze('same scope', 'intent-body', 'trace-opencode', {
      analysisMode: 'full', runId: 'current-run',
    });
    expect(result.conclusion).toBe(answer);
    expect(result.turnIntent).toMatchObject({status: 'resolved', scope: 'bounded_question', deliverable: 'answer'});
    expect(result.completion).toMatchObject({status: 'completed', runId: 'current-run',
      sdkFinishReason: 'stop', conclusionFingerprint: analysisDeliveryFingerprint(answer)});
    expect(result.outputOrigin).toBe('sdk_final');
    expect(harness.configs.map(config => config.agent.smartperfetto.maxSteps)).toEqual([1, 8, 1]);
    expect(harness.prompts).toHaveLength(3);
    expect(harness.traceProcessor.query).toHaveBeenCalled();
    expect(harness.serverCloses.every(close => close.mock.calls.length === 1)).toBe(true);
    expect(fs.existsSync(path.dirname(harness.directories[0]))).toBe(false);
  }));

  it('registers the native classifier model and keeps fast comparison tools', async () => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({decision: {...BOUNDED_INTENT, taskKind: 'comparison'}});
    const result = await harness.runtime.analyze('same scope', 'intent-comparison', 'trace-opencode', {
      analysisMode: 'fast', referenceTraceId: 'trace-reference',
    });
    expect(result.quickRun).toMatchObject({enforcement: 'timeout_only', hardCapTurns: 3, actualTurns: 2});
    expect(harness.configs[0]).toMatchObject({model: 'smartperfetto/light-model', mcp: {}, instructions: [],
      provider: {smartperfetto: {models: {'light-model': {id: 'light-model'}}}}});
    expect(Object.values(harness.configs[0].tools).every(value => value === false)).toBe(true);
    expect(harness.configs[1].agent.smartperfetto.maxSteps).toBe(2);
    expect(harness.getTools().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'submit_plan', 'execute_sql_on', 'compare_skill', 'execute_sql', 'fetch_artifact',
    ]));
    expect(harness.traceProcessor.query).toHaveBeenCalled();
  }));

  it.each(['bounded_question', 'scene_wide'])('denies new evidence independently of %s context scope', async scope => withBackendDataDir(async () => {
    const getContextForAI = jest.fn(() => 'new context must not be fetched');
    const knowledge = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({getContextForAI} as any);
    try {
      const harness = createNativeIntentHarness({decision: {...BOUNDED_INTENT,
        taskKind: 'investigation', scope, evidenceAccess: 'existing_only'}});
      const result = await harness.runtime.analyze('same scope', `intent-existing-${scope}`, 'trace-opencode', {
        analysisMode: 'full', referenceTraceId: 'trace-reference', codeAwareMode: 'off',
      });
      expect(result.turnIntent).toMatchObject({status: 'resolved', scope, evidenceAccess: 'existing_only'});
      const names = harness.getTools().map(tool => tool.name);
      expect(names).toContain('fetch_artifact');
      expect(names).not.toContain('execute_sql');
      expect(names).not.toContain('execute_sql_on');
      expect(names).not.toContain('lookup_aosp_source');
      expect(harness.traceProcessor.query).not.toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
      expect(getContextForAI).not.toHaveBeenCalled();
    } finally {
      knowledge.mockRestore();
    }
  }));

  // `onDemandContext` picks which memory context the prompt carries — a
  // compact quick-memory payload or the separate pattern/case sections — not
  // whether the shared typed builder runs. Both entrypoints assemble the same
  // typed contract, so this is a prompt-shape choice, not a policy one.
  it('chooses the quick-memory prompt variant on demand while the shared typed builder still runs', async () => withBackendDataDir(async () => {
    const quick = jest.spyOn(systemPromptModule, 'buildQuickSystemPrompt');
    const full = jest.spyOn(systemPromptModule, 'buildSystemPrompt');
    try {
      const bounded = createNativeIntentHarness();
      await bounded.runtime.analyze('same scope', 'prompt-variant-bounded', 'trace-opencode', {analysisMode: 'full'});
      expect(quick).toHaveBeenCalledTimes(1);
      expect(full).not.toHaveBeenCalled();
      expect(quick.mock.calls[0][0]).toMatchObject({onDemandContext: true,
        turnIntent: expect.objectContaining({scope: 'bounded_question'})});
      quick.mockClear();

      const wide = createNativeIntentHarness({decision: {...BOUNDED_INTENT, taskKind: 'investigation', scope: 'scene_wide'}});
      await wide.runtime.analyze('the whole scene', 'prompt-variant-wide', 'trace-opencode', {analysisMode: 'full'});
      expect(full).toHaveBeenCalledTimes(1);
      expect(quick).not.toHaveBeenCalled();
      expect(full.mock.calls[0][0]).toMatchObject({onDemandContext: false,
        turnIntent: expect.objectContaining({scope: 'scene_wide'})});

      for (const prompts of [bounded.prompts, wide.prompts]) {
        expect(prompts[1].body.system).toContain('"context":"turn_policy"');
      }
    } finally { quick.mockRestore(); full.mockRestore(); }
  }));

  // The completeness probe runs for every `preflight !== 'none'` turn, so a
  // bounded `read_new` turn pays for it. Leaving it out of the quick prompt
  // spent the queries and then told the model nothing about which data the
  // capture actually holds — the one thing a narrow question still needs.
  it('gives a bounded read_new turn the completeness the probe already paid for', async () => withBackendDataDir(async () => {
    const completeness = {capabilities: [], summary: 'probe-sentinel'} as never;
    const probe = jest.spyOn(traceCompletenessProber, 'probeTraceCompleteness')
      .mockResolvedValue(completeness);
    const quick = jest.spyOn(systemPromptModule, 'buildQuickSystemPrompt');
    try {
      const harness = createNativeIntentHarness();
      const result = await harness.runtime.analyze('why is this page slow', 'completeness-bounded',
        'trace-opencode', {analysisMode: 'full'});

      expect(result.turnIntent).toMatchObject({scope: 'bounded_question', evidenceAccess: 'read_new'});
      expect(probe).toHaveBeenCalledTimes(1);
      expect(quick).toHaveBeenCalledTimes(1);
      expect(quick.mock.calls[0][0].traceCompleteness).toBe(completeness);
    } finally { quick.mockRestore(); probe.mockRestore(); }
  }));

  it('passes the exact classifier registry pin to the actual MCP factory', async () => withBackendDataDir(async () => {
    const resolver = jest.spyOn(turnIntentModule, 'createAnalysisTurnIntentResolver');
    const mcp = jest.spyOn(claudeMcpModule, 'createClaudeMcpServer');
    try {
      const harness = createNativeIntentHarness();
      const result = await harness.runtime.analyze('same scope', 'intent-registry-pin', 'trace-opencode');
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(mcp).toHaveBeenCalledTimes(1);
      const resolverResult = resolver.mock.results[0];
      if (resolverResult.type !== 'return') throw new Error('Intent resolver was not created');
      const captured = resolverResult.value.strategyRegistry;
      expect(mcp.mock.calls[0][0].strategyRegistry).toBe(captured);
      expect(result.turnIntent?.registryFingerprint).toBe(captured.registryFingerprint);
    } finally {
      mcp.mockRestore();
      resolver.mockRestore();
    }
  }));

  it.each(['fast', 'full'] as const)('preserves known pair package identities for bounded %s answers', async analysisMode => withBackendDataDir(async () => {
    const originalPairBuilder = runtimePromptContext.buildRuntimeTracePairIdentityContext;
    const pair = jest.spyOn(runtimePromptContext, 'buildRuntimeTracePairIdentityContext')
      .mockImplementation(input => {
        const identity = originalPairBuilder(input);
        return identity ? {...identity, referencePackageName: 'com.reference.app'} : undefined;
      });
    const gate = jest.spyOn(finalResultQualityGate, 'applyFinalResultQualityGate');
    try {
      const harness = createNativeIntentHarness({decision: {...BOUNDED_INTENT, taskKind: 'comparison'}});
      await harness.runtime.analyze('same scope', `intent-pair-${analysisMode}`, 'trace-opencode', {
        analysisMode, packageName: 'com.current.app', referenceTraceId: 'trace-reference',
      });
      expect(pair).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledTimes(1);
      // The user named the current package; the reference package is always inferred.
      expect(gate.mock.calls[0][0].comparisonIdentity).toEqual({
        currentPackageName: 'com.current.app', referencePackageName: 'com.reference.app',
        currentPackageSource: 'user', referencePackageSource: 'auto_detected',
      });
      expect(harness.traceProcessor.query).toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      pair.mockRestore();
    }
  }));

  it.each(['env', 'provider'] as const)('preserves configured %s instructions for a full bounded answer', async source => withBackendDataDir(async () => {
    const provider = source === 'provider' ? jest.spyOn(providerManager, 'getProviderService')
      .mockReturnValue({getRawProvider: () => ({
        name: 'configured provider', models: {primary: 'main-model', light: 'light-model'},
        connection: {openCodeSystemPrompt: 'configured-provider-instruction'},
      })} as any) : undefined;
    try {
      const harness = createNativeIntentHarness({
        env: {SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT: 'configured-env-instruction'},
        ...(source === 'provider' ? {selection: {
          kind: OPENCODE_RUNTIME_KIND, source: 'provider', providerId: 'configured-provider',
        } as const} : {}),
      });
      await harness.runtime.analyze('same scope', `intent-config-${source}`, 'trace-opencode', {analysisMode: 'full'});
      expect(harness.prompts[1].body.system).toContain(`configured-${source}-instruction`);
      expect(harness.prompts[0].body.system).not.toContain(`configured-${source}-instruction`);
      expect(harness.configs[1].agent.smartperfetto.maxSteps).toBe(8);
    } finally {
      provider?.mockRestore();
    }
  }));

  // The trace facts a bounded turn is asked about are gathered; the scene-wide
  // memory tier it cannot place is not.
  it.each(['resolved', 'unavailable'] as const)('reads trace facts but no knowledge memory for %s on-demand turns', async status => withBackendDataDir(async () => {
    const getContextForAI = jest.fn(() => 'new context must not be fetched');
    const knowledge = jest.spyOn(sqlKnowledgeBase, 'getExtendedKnowledgeBase')
      .mockResolvedValue({getContextForAI} as any);
    try {
      const harness = createNativeIntentHarness(status === 'unavailable'
        ? {classifierResponse: {error: {code: 'model_not_found'}}} : {});
      const result = await harness.runtime.analyze('same scope', `intent-no-prefetch-${status}`, 'trace-opencode', {
        analysisMode: 'full',
      });
      expect(result.turnIntent).toMatchObject({status, scope: 'bounded_question', evidenceAccess: 'read_new'});
      expect(harness.getTools().map(tool => tool.name)).toContain('execute_sql');
      expect(harness.traceProcessor.query).toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
      expect(getContextForAI).not.toHaveBeenCalled();
    } finally {
      knowledge.mockRestore();
    }
  }));

  it('does not repeat an unavailable light model for the main answer', async () => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({classifierResponse: {error: {code: 'model_not_found'}}});
    const result = await harness.runtime.analyze('same scope', 'intent-fallback', 'trace-opencode');
    expect(result.turnIntent).toMatchObject({status: 'unavailable', scope: 'bounded_question'});
    expect(harness.prompts[0].body.model).toEqual({providerID: 'smartperfetto', modelID: 'light-model'});
    expect(harness.prompts[1].body.model).toEqual({providerID: 'smartperfetto', modelID: 'main-model'});
    expect(harness.configs[1].small_model).toBeUndefined();
    expect(harness.traceProcessor.query).toHaveBeenCalled();
  }));

  it.each(['length', 'tool-calls', 'unrecognized'])('does not certify native finish %s as completed', async finish => withBackendDataDir(async () => {
    const harness = createNativeIntentHarness({finish});
    const result = await harness.runtime.analyze('same scope', `intent-${finish}`, 'trace-opencode');
    expect(result.completion?.status).not.toBe('completed');
    expect(result.completion?.sdkFinishReason).toBe(finish);
    expect(result.partial).toBe(true);
    expect(harness.prompts).toHaveLength(2);
  }));

  it('cancels classification before starting answer context and cleans its host', async () => withBackendDataDir(async () => {
    const pending = createDeferred<void>();
    const entered = createDeferred<void>();
    const harness = createNativeIntentHarness({beforeClassifierReply: async () => {
      entered.resolve(); await pending.promise;
    }});
    const operation = harness.runtime.analyze('same scope', 'intent-cancel', 'trace-opencode');
    await entered.promise;
    await harness.runtime.abortSession('intent-cancel');
    await expect(operation).rejects.toThrow();
    pending.resolve();
    expect(harness.prompts).toHaveLength(1);
    expect(harness.configs).toHaveLength(1);
    expect(harness.traceProcessor.query).not.toHaveBeenCalled();
    expect(harness.serverCloses[0]).toHaveBeenCalledTimes(1);
  }));

  it('does not complete a submitted plan because the answer resembles a report', () => {
    const plan = createCompletedScrollingPlanWithFinalPhase();
    expect(getOpenCodePlanCompletionStatus(null)).toMatchObject({complete: true, hasPlan: false, pending: []});
    expect(completeOpenCodeFinalReportPhaseIfDelivered(plan, '# Report\n' + 'Evidence '.repeat(1000), 'en')).toBeUndefined();
    expect(getOpenCodePlanCompletionStatus(plan).complete).toBe(false);
    expect(plan.phases[1].status).toBe('in_progress');
    expect(sanitizeOpenCodeConclusionText('Process narration\n\n# Report')).toBe('Process narration\n\n# Report');
  });
});

describe('experimental OpenCode runtime contract', () => {
  it('cleans stale dead-owner private directories without deleting a live owner', () => {
    const now = Date.now();
    const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-private-live-test-'));
    const deadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-private-dead-test-'));
    const staleDate = new Date(now - 25 * 60 * 60 * 1000);
    try {
      fs.writeFileSync(
        path.join(liveRoot, '.owner.json'),
        JSON.stringify({pid: process.pid, createdAt: now - 26 * 60 * 60 * 1000}),
      );
      fs.writeFileSync(
        path.join(deadRoot, '.owner.json'),
        JSON.stringify({pid: 2_147_483_647, createdAt: now - 26 * 60 * 60 * 1000}),
      );
      fs.utimesSync(liveRoot, staleDate, staleDate);
      fs.utimesSync(deadRoot, staleDate, staleDate);

      openCodeTesting.cleanupStaleEphemeralOpenCodeDirs(now);

      expect(fs.existsSync(liveRoot)).toBe(true);
      expect(fs.existsSync(deadRoot)).toBe(false);
    } finally {
      fs.rmSync(liveRoot, {recursive: true, force: true});
      fs.rmSync(deadRoot, {recursive: true, force: true});
    }
  });

  it('resolves the packaged OpenCode native CLI without relying on PATH shims', () => {
    const cliPath = openCodeTesting.resolveOpenCodeCliPath();
    expect(cliPath).toContain(`${path.sep}opencode-ai${path.sep}bin${path.sep}`);
    expect(fs.statSync(cliPath).isFile()).toBe(true);
  });

  it('keeps draining server output after startup without retaining logs', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;

    const ready = openCodeTesting.waitForOpenCodeServer(child, 1_000);
    child.stdout.write('opencode server listening on http://127.0.0.1:43210\n');

    await expect(ready).resolves.toBe('http://127.0.0.1:43210');
    await Promise.all([
      new Promise<void>(resolve => child.stdout.write(Buffer.alloc(256 * 1024), resolve)),
      new Promise<void>(resolve => child.stderr.write(Buffer.alloc(256 * 1024), resolve)),
    ]);
    expect(child.stdout.readableFlowing).toBe(true);
    expect(child.stderr.readableFlowing).toBe(true);
  });

  it('retries a dynamically selected non-zero port and authenticates the local client', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-start-test-'));
    const dirs = {
      projectDir: path.join(root, 'project'),
      homeDir: path.join(root, 'home'),
      configDir: path.join(root, 'config'),
    };
    Object.values(dirs).forEach(dir => fs.mkdirSync(dir, {recursive: true}));
    const ports = [43101, 43102];
    const spawned: Array<{args: string[]; env: NodeJS.ProcessEnv}> = [];
    const clientConfig: Array<Record<string, any>> = [];
    try {
      const instance = await openCodeTesting.createOpenCodeInstanceWithExplicitEnv(
        {
          createOpencodeClient: jest.fn((config: Record<string, any>) => {
            clientConfig.push(config);
            return {session: {}};
          }),
        } as any,
        dirs,
        {
          OPENCODE_SERVER_USERNAME: 'host-user',
          OPENCODE_SERVER_PASSWORD: 'host-password',
          SMARTPERFETTO_API_KEY: 'backend-secret-must-not-reach-child',
          SMARTPERFETTO_SSO_COOKIE_SECRET: 'sso-secret-must-not-reach-child',
          OPENAI_API_KEY: 'provider-secret-required-by-child',
          PATH: process.env.PATH,
        },
        {hostname: '127.0.0.1', timeout: 1_000, config: {logLevel: 'error'}},
        {
          allocatePort: jest.fn(async () => ports.shift()!),
          spawnChild: jest.fn((_executable: string, args: string[], options: any) => {
            const child = new EventEmitter() as any;
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.exitCode = null;
            child.signalCode = null;
            child.pid = 4321 + spawned.length;
            child.kill = jest.fn(() => {
              if (child.exitCode === null) {
                child.exitCode = 0;
                queueMicrotask(() => child.emit('exit', 0));
              }
              return true;
            });
            spawned.push({args, env: options.env});
            queueMicrotask(() => {
              if (spawned.length === 1) {
                child.stderr.write('EADDRINUSE: address already in use\n');
                child.exitCode = 1;
                child.emit('exit', 1);
              } else {
                child.stdout.write('opencode server listening on http://127.0.0.1:43102\n');
              }
            });
            return child;
          }),
        },
      );

      expect(spawned).toHaveLength(2);
      expect(spawned.map(item => item.args.find(arg => arg.startsWith('--port='))))
        .toEqual(['--port=43101', '--port=43102']);
      expect(spawned.every(item => !item.args.includes('--port=0'))).toBe(true);
      expect(spawned[1].env.OPENCODE_SERVER_USERNAME).not.toBe('host-user');
      expect(spawned[1].env.OPENCODE_SERVER_PASSWORD).not.toBe('host-password');
      expect(spawned[1].env.SMARTPERFETTO_API_KEY).toBeUndefined();
      expect(spawned[1].env.SMARTPERFETTO_SSO_COOKIE_SECRET).toBeUndefined();
      expect(spawned[1].env.OPENAI_API_KEY).toBe('provider-secret-required-by-child');
      expect(spawned[1].env.PATH).toBe(process.env.PATH);
      const expectedAuth = `Basic ${Buffer.from(
        `${spawned[1].env.OPENCODE_SERVER_USERNAME}:${spawned[1].env.OPENCODE_SERVER_PASSWORD}`,
      ).toString('base64')}`;
      expect(clientConfig).toEqual([expect.objectContaining({
        baseUrl: 'http://127.0.0.1:43102',
        headers: {Authorization: expectedAuth},
      })]);
      await instance.server?.close();
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('terminates the complete OpenCode process tree on Windows', () => {
    expect(openCodeTesting.windowsTaskkillArgs(4321)).toEqual([
      '/PID',
      '4321',
      '/T',
      '/F',
    ]);
  });

  it('describes OpenCode as hidden, server-backed, JSON Schema, and no shell/file tools', () => {
    expect(getOpenCodeEngineCapabilities()).toEqual({
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      displayName: 'Experimental OpenCode',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });

  it('hardens OpenCode config and disables dangerous built-in tools', () => {
    const config = createOpenCodeHardenedConfig(['smartperfetto_query_trace']);

    expect(config).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      instructions: [],
      mcp: {},
      lsp: false,
      formatter: false,
      permission: {
        edit: 'deny',
        bash: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      grep: false,
      glob: false,
      edit: false,
      write: false,
      apply_patch: false,
      webfetch: false,
      websearch: false,
      skill: false,
      todowrite: false,
      question: false,
      smartperfetto_query_trace: true,
    });
    expect((config.agent as any).smartperfetto.tools).toMatchObject(
      config.tools as Record<string, unknown>,
    );
  });

  it('adds standalone public MCP only behind the hidden OpenCode MCP gate', () => {
    expect(createOpenCodeStandaloneMcpConfig({})).toEqual({});

    const config = createOpenCodeHardenedConfig([], {
      SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP: '1',
      SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["/usr/bin/node","/tmp/smartperfetto-mcp.js"]',
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '7777',
    });

    expect(config.mcp).toEqual({
      smartperfetto: {
        type: 'local',
        enabled: true,
        timeout: 7777,
        command: ['/usr/bin/node', '/tmp/smartperfetto-mcp.js'],
        environment: {
          SMARTPERFETTO_STANDALONE_MCP: '1',
        },
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      edit: false,
      write: false,
      apply_patch: false,
      lookup_blog_knowledge: true,
      smartperfetto_lookup_blog_knowledge: true,
      mcp__smartperfetto__lookup_blog_knowledge: true,
    });
  });

  it('uses the engine-local loader-free OpenCode MCP bridge child', () => {
    const command = openCodeTesting.resolveOpenCodeBridgeCommand({});

    expect(command).toEqual([
      process.execPath,
      path.resolve(
        process.cwd(),
        'src/agentRuntime/engines/opencode/openCodeMcpBridgeChild.cjs',
      ),
    ]);
  });

  it('threads one configured request deadline through the OpenCode client and bridge child', () => {
    const config = createOpenCodeHardenedConfig([], {
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '7777',
    }, {
      port: 43123,
      token: 'bridge-token',
      requestTimeoutMs: 7777,
      getDiagnostics: () => ({connectionCount: 0, requestCount: 0}),
      close: async () => undefined,
    } as any);

    expect(config.mcp).toEqual({
      smartperfetto: expect.objectContaining({
        timeout: 7777,
        environment: expect.objectContaining({
          SMARTPERFETTO_OPENCODE_BRIDGE_TIMEOUT_MS: '7777',
        }),
      }),
    });
  });

  it('strictly bounds OpenCode MCP timeouts for env and injected bridge contracts', async () => {
    expect(getOpenCodeRuntimeDiagnostics({
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '100',
    }).standaloneMcpTimeoutMs).toBe(100);
    expect(getOpenCodeRuntimeDiagnostics({
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '300000',
    }).standaloneMcpTimeoutMs).toBe(300_000);

    for (const invalid of ['100ms', '1.5', '-1', '0', '99', '300001', '999999999999999999999']) {
      expect(getOpenCodeRuntimeDiagnostics({
        SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: invalid,
      }).standaloneMcpTimeoutMs).toBe(5_000);
    }

    for (const invalid of [Number.NaN, -1, 0, 99, 300_001, 1.5]) {
      const bridge = await openCodeTesting.startOpenCodeMcpBridge([], undefined, {
        timeoutMs: invalid,
      } as any);
      expect(bridge.requestTimeoutMs).toBe(5_000);
      await bridge.close();
    }
  });

  it('makes the bridge child reject partial numeric timeout strings', async () => {
    const sockets = new Set<net.Socket>();
    const parent = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', chunk => {
        setTimeout(() => {
          if (!socket.destroyed) {
            socket.write(`${JSON.stringify({jsonrpc: '2.0', id: 'strict-child', result: {ok: true}})}\n`);
          }
        }, 150);
      });
    });
    await new Promise<void>((resolve, reject) => {
      parent.once('error', reject);
      parent.listen(0, '127.0.0.1', resolve);
    });
    const address = parent.address();
    if (!address || typeof address === 'string') throw new Error('test parent bridge did not bind');
    const command = openCodeTesting.resolveOpenCodeBridgeCommand({});
    const child = spawnChildProcess(command[0]!, command.slice(1), {
      env: {
        ...process.env,
        SMARTPERFETTO_OPENCODE_BRIDGE_PORT: String(address.port),
        SMARTPERFETTO_OPENCODE_BRIDGE_TOKEN: 'bridge-token',
        SMARTPERFETTO_OPENCODE_BRIDGE_TIMEOUT_MS: '40ms',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const output = new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('strict child timeout test stalled')), 1_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          clearTimeout(timer);
          resolve(buffer.slice(0, newline));
        });
      });
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 'strict-child', method: 'tools/list'})}\n`);
      await expect(output).resolves.toContain('"ok":true');
    } finally {
      child.kill();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => parent.close(() => resolve()));
    }
  });

  it('makes the bridge child honor the request-scoped parent deadline', async () => {
    const sockets = new Set<net.Socket>();
    const parent = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      parent.once('error', reject);
      parent.listen(0, '127.0.0.1', () => resolve());
    });
    const address = parent.address();
    if (!address || typeof address === 'string') throw new Error('test parent bridge did not bind');
    const command = openCodeTesting.resolveOpenCodeBridgeCommand({});
    const child = spawnChildProcess(command[0]!, command.slice(1), {
      env: {
        ...process.env,
        SMARTPERFETTO_OPENCODE_BRIDGE_PORT: String(address.port),
        SMARTPERFETTO_OPENCODE_BRIDGE_TOKEN: 'bridge-token',
        SMARTPERFETTO_OPENCODE_BRIDGE_TIMEOUT_MS: '100',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const output = new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('bridge child missed configured deadline')), 750);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          clearTimeout(timer);
          resolve(buffer.slice(0, newline));
        });
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 'deadline-child',
        method: 'tools/list',
      })}\n`);

      await expect(output).resolves.toContain('bridge request timed out');
    } finally {
      child.kill();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => parent.close(() => resolve()));
    }
  });

  it('aborts a parent bridge handler on disconnect and records no ghost success attribution', async () => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const handlerAborted = createDeferred<void>();
    const updates: any[] = [];
    let handlerSignal: AbortSignal | undefined;
    const plan = {phases: [], successCriteria: '', submittedAt: 1, toolCallLog: []} as any;
    const bridge = await openCodeTesting.startOpenCodeMcpBridge([{
      name: 'smartperfetto_query_trace',
      exposure: 'internal',
      tool: {},
      shared: {
        name: 'smartperfetto_query_trace',
        description: 'Run a trace query',
        exposure: 'internal',
        inputSchema: {},
        handler: jest.fn(async (_args: unknown, extra: any) => {
          handlerSignal = extra.signal;
          handlerSignal?.addEventListener('abort', () => handlerAborted.resolve(), {once: true});
          handlerStarted.resolve();
          await releaseHandler.promise;
          return {content: [{type: 'text', text: 'late success must be discarded'}]};
        }),
      },
    } as any], update => updates.push(update), {
      analysisPlan: {current: plan},
      timeoutMs: 1_000,
    } as any);
    const socket = net.createConnection({host: '127.0.0.1', port: bridge.port});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({
        token: bridge.token,
        request: {
          jsonrpc: '2.0',
          id: 'disconnect-call',
          method: 'tools/call',
          params: {name: 'smartperfetto_query_trace', arguments: {sql: 'select 1'}},
        },
      })}\n`);
      await handlerStarted.promise;
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      socket.destroy();
      await closed;
      await Promise.race([
        handlerAborted.promise,
        new Promise<void>(resolve => setTimeout(resolve, 500)),
      ]);
      expect(handlerSignal?.aborted).toBe(true);
      releaseHandler.resolve();
      await new Promise(resolve => setImmediate(resolve));

      expect(plan.toolCallLog).toEqual([]);
      expect(updates.filter(update => update.type === 'agent_response')).toEqual([]);
    } finally {
      releaseHandler.resolve();
      socket.destroy();
      await bridge.close();
    }
  });

  it('aborts a deadline-expired bridge handler before late success can create evidence', async () => {
    const handlerStarted = createDeferred<void>();
    const deadlineObserved = createDeferred<boolean>();
    const releaseHandler = createDeferred<void>();
    const updates: any[] = [];
    const plan = {phases: [], successCriteria: '', submittedAt: 1, toolCallLog: []} as any;
    const bridge = await openCodeTesting.startOpenCodeMcpBridge([{
      name: 'smartperfetto_query_trace',
      exposure: 'internal',
      tool: {},
      shared: {
        name: 'smartperfetto_query_trace',
        description: 'Run a trace query',
        exposure: 'internal',
        inputSchema: {},
        handler: jest.fn(async (_args: unknown, extra: any) => {
          handlerStarted.resolve();
          if (!extra.signal) {
            deadlineObserved.resolve(false);
          } else if (extra.signal.aborted) {
            deadlineObserved.resolve(true);
          } else {
            extra.signal.addEventListener('abort', () => deadlineObserved.resolve(true), {once: true});
          }
          await releaseHandler.promise;
          return {content: [{type: 'text', text: 'late deadline success'}]};
        }),
      },
    } as any], update => updates.push(update), {
      analysisPlan: {current: plan},
      timeoutMs: 100,
    } as any);
    const socket = net.createConnection({host: '127.0.0.1', port: bridge.port});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({
        token: bridge.token,
        request: {
          jsonrpc: '2.0',
          id: 'deadline-call',
          method: 'tools/call',
          params: {name: 'smartperfetto_query_trace', arguments: {sql: 'select 1'}},
        },
      })}\n`);
      await handlerStarted.promise;
      await expect(Promise.race([
        deadlineObserved.promise,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
      ])).resolves.toBe(true);
      releaseHandler.resolve();
      await new Promise(resolve => setImmediate(resolve));

      expect(plan.toolCallLog).toEqual([]);
      expect(updates.filter(update => update.type === 'agent_response')).toEqual([]);
    } finally {
      releaseHandler.resolve();
      socket.destroy();
      await bridge.close();
    }
  });

  it('closes unauthenticated MCP bridge clients before they can buffer an oversized frame', async () => {
    const bridge = await openCodeTesting.startOpenCodeMcpBridge([]);
    const socket = net.createConnection({host: '127.0.0.1', port: bridge.port});
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));

    socket.write('x'.repeat(65 * 1024));
    await closed;

    expect(bridge.getDiagnostics().lastError).toBe('bridge_request_too_large');
    await bridge.close();
  });

  it('accepts the configured SmartPerfetto MCP bridge only after OpenCode reports it connected', async () => {
    const status = jest.fn(async (_input?: unknown) => ({
      data: {smartperfetto: {status: 'connected'}},
    }));

    await expect(openCodeTesting.assertOpenCodeMcpReady({mcp: {status}} as any, '/tmp/project'))
      .resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith({query: {directory: '/tmp/project'}});
  });

  it('fails before prompting when OpenCode cannot connect the SmartPerfetto MCP bridge', async () => {
    const diagnostics = {
      connectionCount: 0,
      requestCount: 0,
    };
    const status = jest.fn(async (_input?: unknown) => {
      diagnostics.connectionCount = 1;
      diagnostics.requestCount = 2;
      return {
        data: {
          smartperfetto: {
            status: 'failed',
            error: 'bridge child exited before initialization',
          },
        },
      };
    });

    await expect(openCodeTesting.assertOpenCodeMcpReady(
      {mcp: {status}} as any,
      '/tmp/project',
      () => diagnostics,
    )).rejects.toThrow(
      'bridge child exited before initialization (connections=1, requests=2',
    );
  });

  it('enumerates conservative standalone MCP tool-name variants for OpenCode', () => {
    expect(createOpenCodeStandaloneMcpToolNames()).toEqual(
      expect.arrayContaining([
        'lookup_blog_knowledge',
        'smartperfetto_lookup_blog_knowledge',
        'mcp__smartperfetto__lookup_blog_knowledge',
        'recall_similar_case',
        'smartperfetto_recall_similar_case',
        'mcp__smartperfetto__recall_similar_case',
      ]),
    );
  });

  it('builds per-request tool allowlists by denying built-ins first', () => {
    expect(createOpenCodeToolAllowlist(['smartperfetto_query_trace'])).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      read: false,
      apply_patch: false,
      smartperfetto_query_trace: true,
    });
  });

  it('extracts final assistant text without leaking user prompts or reasoning', () => {
    const response = {
      data: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: '用户原始问题，不应作为报告' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'internal reasoning should not leak' },
            { type: 'text', text: '最终报告正文' },
            { type: 'step-finish' },
          ],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe('最终报告正文');
  });

  it('accepts the latest assistant message independently of headings or length', () => {
    const fullReport = [
      '# 启动性能分析报告',
      '',
      '## 结论',
      '这是 OpenCode 生成的完整报告正文。',
      '',
      '## 证据',
      '- smartperfetto_query_trace 返回了启动阶段证据。',
      '',
      '## 建议',
      '继续保留完整证据链。',
    ].join('\n');
    const response = {
      data: [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: fullReport }],
        },
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: '分析完成，完整报告已经生成。' }],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe('分析完成，完整报告已经生成。');
  });

  it('uses OpenCode promptAsync and polls completed assistant messages', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: '异步最终报告' }],
          },
        ],
      });
    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith({
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project', limit: 50, order: 'desc' },
    });
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('异步最终报告');
  });

  it('observes a new OpenCode session immediately without a baseline fetch or initial delay', async () => {
    const promptAsync = jest.fn(async () => ({response: {status: 204}}));
    const messages = jest.fn(async () => ({data: [{
      info: {role: 'assistant', finish: 'stop', id: 'msg-immediate'},
      parts: [{type: 'text', text: '立即完成的报告'}],
    }]}));
    const status = jest.fn(async () => ({data: {'ses-opencode': {type: 'idle'}}}));
    const pollDelay = jest.fn(async () => undefined);

    const result = await runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync, messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      pollDelay,
    } as any);

    expect(messages).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(1);
    expect(pollDelay).not.toHaveBeenCalled();
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('立即完成的报告');
  });

  it('performs a canonical final messages fetch after idle wins the concurrent observation race', async () => {
    const intermediate = {
      info: {role: 'assistant', finish: 'tool-calls', id: 'msg-tool'},
      parts: [{type: 'text', text: '并发观察时仍是工具调用'}],
    };
    const final = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-final'},
      parts: [{type: 'text', text: 'idle 后规范读取到的最终报告'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [final, intermediate]});

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({response: {status: 204}})),
          messages,
          status: jest.fn(async () => ({data: {'ses-opencode': {type: 'idle'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      pollDelay: async () => undefined,
    } as any);

    expect(messages).toHaveBeenCalledTimes(2);
    expect(extractOpenCodeAssistantText(result.messagesResponse))
      .toBe('idle 后规范读取到的最终报告');
  });

  it('keeps polling through multiple lagging idle canonical fetches without duplicate usage', async () => {
    const intermediate = {
      info: {
        role: 'assistant',
        finish: 'tool-calls',
        id: 'msg-tool',
        usage: {outputTokens: 1},
      },
      parts: [{type: 'text', text: 'canonical 仍滞后'}],
    };
    const final = {
      info: {
        role: 'assistant',
        finish: 'stop',
        id: 'msg-final',
        usage: {outputTokens: 2},
      },
      parts: [{type: 'text', text: '多次滞后后最终报告'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [final, intermediate]})
      .mockResolvedValue({data: [final, intermediate]});
    const status = jest.fn(async () => ({data: {'ses-opencode': {type: 'idle'}}}));
    const onFirstAssistantMessage = jest.fn();
    const usageSpy = jest.spyOn(evaluationRuntimeHooks, 'recordEvaluationTokenDeltaIfPresent')
      .mockImplementation(() => undefined);
    try {
      const result = await runOpenCodePrompt({
        client: {
          session: {
            prompt: jest.fn(),
            promptAsync: jest.fn(async () => ({response: {status: 204}})),
            messages,
            status,
          },
        },
        server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
      } as any, {
        path: {id: 'ses-opencode'},
        query: {directory: '/tmp/project'},
        body: {parts: [{type: 'text', text: '分析启动性能'}]},
      }, {
        sessionId: 'ses-opencode',
        projectDir: '/tmp/project',
        timeoutMs: 5_000,
        resumedSession: false,
        pollDelay: async () => undefined,
        onFirstAssistantMessage,
      });

      expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('多次滞后后最终报告');
      expect(messages).toHaveBeenCalledTimes(4);
      expect(status).toHaveBeenCalledTimes(2);
      expect(onFirstAssistantMessage).toHaveBeenCalledTimes(1);
      expect(usageSpy).toHaveBeenCalledTimes(2);
      expect(usageSpy.mock.calls).toEqual([
        [{outputTokens: 1}],
        [{outputTokens: 2}],
      ]);
    } finally {
      usageSpy.mockRestore();
    }
  });

  it('backs incomplete OpenCode polling off from 100ms toward the bounded 1s ceiling', async () => {
    const promptAsync = jest.fn(async () => ({response: {status: 204}}));
    const intermediate = {
      info: {role: 'assistant', finish: 'tool-calls', id: 'msg-tool'},
      parts: [{type: 'text', text: '正在调用工具'}],
    };
    const final = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-final'},
      parts: [{type: 'text', text: '最终报告'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [final, intermediate]})
      .mockResolvedValue({data: [final, intermediate]});
    const status = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: {'ses-opencode': {type: 'busy'}}})
      .mockResolvedValueOnce({data: {'ses-opencode': {type: 'busy'}}})
      .mockResolvedValueOnce({data: {'ses-opencode': {type: 'busy'}}})
      .mockResolvedValueOnce({data: {'ses-opencode': {type: 'idle'}}});
    const delays: number[] = [];

    const result = await runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync, messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      pollDelay: async (ms: number) => { delays.push(ms); },
      adaptiveObservation: true,
    } as any);

    expect(delays).toEqual([100, 200, 400]);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('最终报告');
  });

  it('starts independent OpenCode messages and status observations concurrently', async () => {
    const messagesStarted = createDeferred<void>();
    const statusStarted = createDeferred<void>();
    const releaseObservation = createDeferred<void>();
    const promptAsync = jest.fn(async () => ({response: {status: 204}}));
    const messages = jest.fn(async () => {
      messagesStarted.resolve();
      await releaseObservation.promise;
      return {data: [{
        info: {role: 'assistant', finish: 'stop', id: 'msg-concurrent'},
        parts: [{type: 'text', text: '并发观察完成'}],
      }]};
    });
    const status = jest.fn(async () => {
      statusStarted.resolve();
      await releaseObservation.promise;
      return {data: {'ses-opencode': {type: 'idle'}}};
    });

    const pending = runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync, messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      adaptiveObservation: true,
    } as any);

    await Promise.all([messagesStarted.promise, statusStarted.promise]);
    releaseObservation.resolve();
    await expect(pending).resolves.toMatchObject({
      messagesResponse: {data: [expect.objectContaining({info: expect.objectContaining({id: 'msg-concurrent'})})]},
    });
  });

  it('observes OpenCode messages then status sequentially with conservative polling by default', async () => {
    const firstMessages = createDeferred<void>();
    const messagesStarted = createDeferred<void>();
    const statusStarted = createDeferred<void>();
    let messageCalls = 0;
    const messages = jest.fn(async () => {
      messageCalls += 1;
      if (messageCalls === 1) {
        messagesStarted.resolve();
        await firstMessages.promise;
      }
      return {data: [{
        info: {role: 'assistant', finish: 'stop', id: 'msg-serial'},
        parts: [{type: 'text', text: '串行观察完成'}],
      }]};
    });
    const status = jest.fn(async () => {
      statusStarted.resolve();
      return {data: {'ses-opencode': {type: 'idle'}}};
    });

    const pending = runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync: jest.fn(async () => ({})), messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
    });

    await messagesStarted.promise;
    expect(status).not.toHaveBeenCalled();
    firstMessages.resolve();
    await statusStarted.promise;
    await expect(pending).resolves.toMatchObject({
      messagesResponse: {data: [expect.objectContaining({info: expect.objectContaining({id: 'msg-serial'})})]},
    });
  });

  it('uses a durable latest-message watermark when resumed history exceeds fifty messages', async () => {
    const oldMessages = Array.from({length: 75}, (_, index) => ({
      info: {role: 'assistant', finish: 'stop', id: `msg-old-${index + 1}`},
      parts: [{type: 'text', text: `旧报告 ${index + 1}`}],
    }));
    const newMessage = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-new'},
      parts: [{type: 'text', text: '本轮超过五十条历史后的新报告'}],
    };
    const promptAsync = jest.fn(async () => ({response: {status: 204}}));
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [oldMessages[oldMessages.length - 1]]})
      .mockResolvedValue({data: [newMessage, ...oldMessages.slice(-49).reverse()]});
    const status = jest.fn(async () => ({data: {'ses-opencode': {type: 'idle'}}}));

    const result = await runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync, messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: true,
      pollDelay: async () => undefined,
    } as any);

    expect(messages.mock.calls[0]?.[0]).toEqual({
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project', limit: 1, order: 'desc'},
    });
    expect(extractOpenCodeAssistantText(result.messagesResponse))
      .toBe('本轮超过五十条历史后的新报告');
  });

  it('expands a displaced resumed watermark and returns all sixty current-turn messages once', async () => {
    const baseline = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-baseline'},
      parts: [{type: 'text', text: '上一轮报告'}],
    };
    const currentMessages = Array.from({length: 60}, (_, index) => ({
      info: {
        role: 'assistant',
        finish: 'stop',
        id: `msg-current-${index + 1}`,
        usage: {ordinal: index + 1},
      },
      parts: [{type: 'text', text: `本轮消息 ${index + 1}`}],
    }));
    const descendingCurrent = [...currentMessages].reverse();
    const requestedLimits: number[] = [];
    const messages = jest.fn(async (input: any) => {
      const limit = input.query.limit as number;
      requestedLimits.push(limit);
      if (limit === 1) return {data: [baseline]};
      if (limit === 50) return {data: descendingCurrent.slice(0, 50)};
      return {data: [...descendingCurrent, baseline]};
    });
    const onFirstAssistantMessage = jest.fn();
    const usageSpy = jest.spyOn(evaluationRuntimeHooks, 'recordEvaluationTokenDeltaIfPresent')
      .mockImplementation(() => undefined);
    try {
      const result = await runOpenCodePrompt({
        client: {
          session: {
            prompt: jest.fn(),
            promptAsync: jest.fn(async () => ({})),
            messages,
            status: jest.fn(async () => ({data: {'ses-opencode': {type: 'idle'}}})),
          },
        },
        server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
      } as any, {
        path: {id: 'ses-opencode'},
        query: {directory: '/tmp/project'},
        body: {parts: [{type: 'text', text: '继续分析'}]},
      }, {
        sessionId: 'ses-opencode',
        projectDir: '/tmp/project',
        timeoutMs: 5_000,
        resumedSession: true,
        onFirstAssistantMessage,
      });

      const returned = (result.messagesResponse as any).data;
      expect(returned).toHaveLength(60);
      expect(returned.map((message: any) => message.info.id)).toEqual(
        currentMessages.map(message => message.info.id),
      );
      expect(requestedLimits).toEqual([1, 50, 100, 50, 100]);
      expect(onFirstAssistantMessage).toHaveBeenCalledTimes(1);
      expect(usageSpy).toHaveBeenCalledTimes(60);
      expect(usageSpy.mock.calls.map(call => call[0])).toEqual(
        currentMessages.map(message => message.info.usage),
      );
    } finally {
      usageSpy.mockRestore();
    }
  });

  it('fails closed when a resumed watermark remains displaced beyond the bounded maximum window', async () => {
    const baseline = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-baseline-overflow'},
      parts: [{type: 'text', text: '上一轮报告'}],
    };
    const overflowing = Array.from({length: 1_100}, (_, index) => ({
      info: {role: 'assistant', finish: 'stop', id: `msg-overflow-${index + 1}`},
      parts: [{type: 'text', text: `overflow ${index + 1}`}],
    })).reverse();
    const requestedLimits: number[] = [];
    const messages = jest.fn(async (input: any) => {
      const limit = input.query.limit as number;
      requestedLimits.push(limit);
      if (limit === 1) return {data: [baseline]};
      return {data: overflowing.slice(0, limit)};
    });

    await expect(runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages,
          status: jest.fn(async () => ({data: {'ses-other': {type: 'idle'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: true,
    })).rejects.toThrow('OpenCode current-turn history exceeded the bounded 1000-message window');

    expect(requestedLimits).toEqual([1, 50, 100, 200, 400, 800, 1000]);
  });

  it('treats a reused assistant ID with changed content as a new current-turn message', async () => {
    const baseline = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-reused', time: {completed: 10}},
      parts: [{type: 'text', text: '旧内容'}],
    };
    const changed = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-reused', time: {completed: 20}},
      parts: [{type: 'text', text: '复用 ID 后的新内容'}],
    };
    const older = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-older', time: {completed: 1}},
      parts: [{type: 'text', text: '更旧内容'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [baseline]})
      .mockResolvedValueOnce({data: [changed, older]});

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages,
          status: jest.fn(async () => ({data: {'ses-other': {type: 'idle'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: true,
      pollDelay: async () => undefined,
    });

    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('复用 ID 后的新内容');
  });

  it('treats changed tool or reasoning parts as new even when visible text and envelope identity match', async () => {
    const baseline = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-structured', time: {completed: 10}},
      parts: [
        {type: 'text', text: '相同可见文本'},
        {type: 'reasoning', text: '旧推理'},
        {type: 'tool', name: 'invoke_skill', state: {input: {skillId: 'old_skill'}}},
      ],
    };
    const changed = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-structured', time: {completed: 10}},
      parts: [
        {type: 'text', text: '相同可见文本'},
        {type: 'reasoning', text: '新推理'},
        {type: 'tool', name: 'invoke_skill', state: {input: {skillId: 'new_skill'}}},
      ],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [baseline]})
      .mockResolvedValue({data: [changed]});

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages,
          status: jest.fn(async () => ({data: {'ses-other': {type: 'idle'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: true,
      pollDelay: async () => undefined,
    });

    expect((result.messagesResponse as any).data).toEqual([changed]);
  });

  it('ignores an identical duplicate watermark but still accepts a later missing-ID message', async () => {
    const baseline = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-identical', time: {completed: 10}},
      parts: [{type: 'text', text: '完全相同'}],
    };
    const missingIdFinal = {
      info: {role: 'assistant', finish: 'stop', time: {completed: 30}},
      parts: [{type: 'text', text: '没有 ID 的本轮最终报告'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [baseline]})
      .mockResolvedValueOnce({data: [baseline]})
      .mockResolvedValueOnce({data: [missingIdFinal, baseline]});
    const status = jest.fn(async () => ({data: {'ses-other': {type: 'idle'}}}));
    const onFirstAssistantMessage = jest.fn();

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages,
          status,
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: true,
      pollDelay: async () => undefined,
      onFirstAssistantMessage,
    });

    expect(messages).toHaveBeenCalledTimes(3);
    expect(onFirstAssistantMessage).toHaveBeenCalledTimes(1);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('没有 ID 的本轮最终报告');
  });

  it("does not treat finish:'tool-calls' as terminal while target status is unknown", async () => {
    const intermediate = {
      info: {role: 'assistant', finish: 'tool-calls', id: 'msg-tool'},
      parts: [{type: 'text', text: '先调用工具'}],
    };
    const final = {
      info: {role: 'assistant', finish: 'stop', id: 'msg-final'},
      parts: [{type: 'text', text: '工具完成后的最终报告'}],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [intermediate]})
      .mockResolvedValueOnce({data: [final, intermediate]});
    const status = jest.fn(async () => ({data: {'ses-other': {type: 'idle'}}}));

    const result = await runOpenCodePrompt({
      client: {session: {prompt: jest.fn(), promptAsync: jest.fn(async () => ({})), messages, status}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      pollDelay: async () => undefined,
    } as any);

    expect(messages).toHaveBeenCalledTimes(2);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('工具完成后的最终报告');
  });

  it('rejects promptly when aborted during the 1s adaptive polling backoff', async () => {
    const abort = new AbortController();
    const reachedOneSecondBackoff = createDeferred<void>();
    const releaseBackoff = createDeferred<void>();
    const intermediate = {
      info: {role: 'assistant', finish: 'tool-calls', id: 'msg-tool'},
      parts: [{type: 'text', text: '仍在执行'}],
    };
    const pollDelay = jest.fn(async (ms: number) => {
      if (ms < 1_000) return;
      reachedOneSecondBackoff.resolve();
      await releaseBackoff.promise;
    });
    const pending = runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages: jest.fn(async () => ({data: [intermediate]})),
          status: jest.fn(async () => ({data: {'ses-opencode': {type: 'busy'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      resumedSession: false,
      signal: abort.signal,
      pollDelay,
      adaptiveObservation: true,
    } as any);
    try {
      await reachedOneSecondBackoff.promise;
      abort.abort(new Error('user cancelled'));
      const outcome = await Promise.race([
        pending.then(() => 'resolved', error => error),
        new Promise(resolve => setTimeout(() => resolve('still-pending'), 250)),
      ]);
      expect(outcome).toMatchObject({name: 'AbortError'});
    } finally {
      releaseBackoff.resolve();
      await pending.catch(() => undefined);
    }
  });

  it('uses one absolute deadline to terminate a hung messages endpoint and observes late rejection', async () => {
    const hungMessages = createDeferred<unknown>();
    const pending = runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(async () => ({})),
          messages: jest.fn(() => hungMessages.promise),
          status: jest.fn(async () => ({data: {'ses-opencode': {type: 'busy'}}})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 50,
      resumedSession: false,
    });
    try {
      await expect(Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('outer-test-timeout')), 500)),
      ])).rejects.toMatchObject({name: 'TimeoutError', code: 'OPENCODE_PROMPT_TIMEOUT'});
    } finally {
      hungMessages.reject(new Error('late endpoint rejection'));
      await pending.catch(() => undefined);
    }
  });

  it('applies the same absolute deadline while promptAsync itself is hung', async () => {
    const hungPrompt = createDeferred<unknown>();
    const pending = runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync: jest.fn(() => hungPrompt.promise),
          messages: jest.fn(async () => ({data: []})),
        },
      },
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 50,
      resumedSession: false,
    });
    try {
      await expect(Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('outer-test-timeout')), 500)),
      ])).rejects.toMatchObject({name: 'TimeoutError', code: 'OPENCODE_PROMPT_TIMEOUT'});
    } finally {
      hungPrompt.reject(new Error('late prompt rejection'));
      await pending.catch(() => undefined);
    }
  });

  it('calls onFirstAssistantMessage before async prompt completion when the first assistant message is observed', async () => {
    let clock = 0;
    const observations: string[] = [];
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const intermediateAssistant = {
      info: { role: 'assistant', finish: 'tool-calls', id: 'msg-intermediate' },
      parts: [{ type: 'text', text: '先提交计划。' }],
    };
    const finalAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-final' },
      parts: [{ type: 'text', text: '完整最终报告' }],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementationOnce(async () => {
        clock = 10;
        return { data: [intermediateAssistant] };
      })
      .mockImplementationOnce(async () => {
        clock = 30;
        return { data: [finalAssistant, intermediateAssistant] };
      })
      .mockResolvedValue({ data: [finalAssistant, intermediateAssistant] });
    const status = jest.fn<(...args: any[]) => any>()
      .mockImplementationOnce(async () => {
        observations.push(`status:${clock}`);
        return { data: { 'ses-opencode': { type: 'busy' } } };
      })
      .mockImplementationOnce(async () => {
        observations.push(`status:${clock}`);
        return { data: { 'ses-opencode': { type: 'idle' } } };
      });
    const onFirstAssistantMessage = jest.fn(() => observations.push(`first:${clock}`));

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
          status,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
      onFirstAssistantMessage,
    } as any);
    observations.push(`complete:${clock}`);

    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('完整最终报告');
    expect(onFirstAssistantMessage).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([
      'status:10',
      'first:10',
      'status:30',
      'complete:30',
    ]);
  }, 10_000);

  it('waits for the target OpenCode session to become idle after an intermediate message completes', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const intermediateAssistant = {
      info: { role: 'assistant', finish: 'tool-calls', id: 'msg-intermediate' },
      parts: [{ type: 'text', text: '先提交分析计划，再继续调用工具。' }],
    };
    const finalAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-final' },
      parts: [{ type: 'text', text: '完整最终报告' }],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [intermediateAssistant] })
      .mockResolvedValue({ data: [finalAssistant, intermediateAssistant] });
    const status = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: { 'ses-opencode': { type: 'busy' } } })
      .mockResolvedValueOnce({ data: { 'ses-opencode': { type: 'idle' } } });

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
          status,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(status).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(4);
    expect((result.messagesResponse as any).data.at(-1)).toEqual(finalAssistant);
  }, 10_000);

  it('falls back to a completed assistant message when status omits the target session', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          info: { role: 'assistant', finish: 'stop', id: 'msg-final' },
          parts: [{ type: 'text', text: '目标会话最终报告' }],
        }],
      });
    const status = jest.fn(async () => ({ data: { 'ses-other': { type: 'idle' } } }));

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
          status,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(status).toHaveBeenCalledTimes(1);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('目标会话最终报告');
  });

  it('does not return an assistant message that existed before the async prompt', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const oldAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-old' },
      parts: [{ type: 'text', text: '上一轮旧报告' }],
    };
    const newAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-new' },
      parts: [{ type: 'text', text: '本轮新报告' }],
    };
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [newAssistant, oldAssistant] });

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '继续分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 4_000,
    });

    expect(messages).toHaveBeenCalledTimes(3);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('本轮新报告');
  });

  it('does not return a longer assistant report that existed before a synchronous prompt', async () => {
    const oldAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-old' },
      parts: [{ type: 'text', text: [
        '# 上一轮旧报告',
        '',
        '## 旧结论',
        '这是已经存在于会话历史中的长报告，不得被本轮同步 prompt 重新选中。'.repeat(20),
      ].join('\n') }],
    };
    const newAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-new' },
      parts: [{ type: 'text', text: '本轮同步短报告' }],
    };
    const prompt = jest.fn(async () => ({data: newAssistant}));
    const messages = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({data: [oldAssistant]})
      .mockResolvedValueOnce({data: [newAssistant, oldAssistant]});

    const result = await runOpenCodePrompt({
      client: {session: {prompt, messages}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 4_000,
    });

    expect(messages).toHaveBeenCalledTimes(2);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('本轮同步短报告');
  });

  it('emits SmartPerfetto tool dispatch and response events from the OpenCode MCP bridge', async () => {
    const updates: any[] = [];
    const handler = jest.fn(async (args: Record<string, unknown>, extra: any) => ({
      content: [{ type: 'text', text: `ran ${args.sql} aborted=${extra.signal?.aborted ?? null}` }],
    }));
    const controller = new AbortController();
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler,
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-1',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    }, update => updates.push(update), {
      getSignal: () => controller.signal,
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-1',
      result: {
        content: [{ type: 'text', text: 'ran select 1 aborted=false' }],
      },
    });
    expect(handler).toHaveBeenCalledWith(
      { sql: 'select 1' },
      expect.objectContaining({
        runtime: 'opencode',
        signal: controller.signal,
        toolCallId: 'tool-call-1',
      }),
    );
    expect(updates).toEqual([
      expect.objectContaining({
        type: 'agent_task_dispatched',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          toolName: 'smartperfetto_query_trace',
          args: { sql: 'select 1' },
        }),
      }),
      expect.objectContaining({
        type: 'agent_response',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          result: 'ran select 1 aborted=false',
        }),
      }),
    ]);
  });

  it('preserves actual result facts through registry, bridge, and shortened response events', async () => {
    const registry = new McpToolRegistry();
    registry.registerShared({
      name: 'execute_sql', description: 'Read data', inputSchema: {}, exposure: 'public',
      handler: async () => createRuntimeToolResult({success: false, planPhaseId: 'p1', error: 'x'.repeat(14000)}, {
        decorate: text => '[accuracy] {"success":true}\n' + text,
      }),
    });
    const updates: any[] = [];
    const tracker = {current: null, prePlanToolCallLog: []} as any;
    const response = await dispatchOpenCodeBridgeRequest(registry.list(), {
      jsonrpc: '2.0', id: 'receipt-opencode', method: 'tools/call',
      params: {name: 'execute_sql', arguments: {}},
    }, update => updates.push(update), {analysisPlan: tracker});
    expect(readRuntimeToolResultFacts((response as any).result)).toEqual({success: false, planPhaseId: 'p1'});
    expect(tracker.prePlanToolCallLog).toEqual([expect.objectContaining({success: false})]);
    expect(updates.find(update => update.type === 'agent_response')).toMatchObject({content: {isError: true}});
  });

  it.each([false, true])('retains private source outcomes before transport truncation (body=%s)', async includeBody => {
    const registry = new McpToolRegistry();
    registry.registerShared({
      name: 'search_codebase', description: 'Search source', exposure: 'public', inputSchema: {},
      handler: async () => createRuntimeToolResult({success: true, matches: Array.from({length: 20}, (_, i) => ({
        referenceId: `source-reference-${i}`, codebaseId: 'codebase-a',
        filePath: `src/PRIVATE_SOURCE_PATH_${i}.kt`, lineRange: {start: 1, end: 20},
        ...(includeBody ? {text: 'PRIVATE_SOURCE_BODY'} : {}),
      }))}),
    });
    const updates: any[] = [];
    await dispatchOpenCodeBridgeRequest(registry.list(), {
      jsonrpc: '2.0', id: 'source-outcome', method: 'tools/call',
      params: {name: 'search_codebase', arguments: {}},
    }, update => updates.push(update));
    const update = updates.find(item => item.type === 'agent_response')!;
    expect(() => JSON.parse(update.content.result)).toThrow();
    expect(update.content.privateToolResultReceipt).toBeDefined();
    const projected = projectCodeAwareStreamingUpdate('opencode-source-outcome', update, true, 'en');
    expect(projected).toMatchObject({content: {resultNarration: includeBody
      ? 'Authorized content was read and is available to check against trace evidence'
      : 'Candidate source or knowledge locations are available; their content has not been read'}});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
  });

  it.each([false, true])('retains private source failures across both OpenCode response branches (throws=%s)', async throws => {
    const registry = new McpToolRegistry();
    registry.registerShared({
      name: 'read_codebase_file', description: 'Read source', exposure: 'public', inputSchema: {},
      handler: async () => {
        if (throws) throw new Error('PRIVATE_SOURCE_FAILURE');
        return createRuntimeToolResult({success: false, error: 'PRIVATE_SOURCE_FAILURE'});
      },
    });
    const updates: any[] = [];
    await dispatchOpenCodeBridgeRequest(registry.list(), {
      jsonrpc: '2.0', id: 'source-failure', method: 'tools/call',
      params: {name: 'read_codebase_file', arguments: {}},
    }, update => updates.push(update));
    const update = updates.find(item => item.type === 'agent_response')!;
    expect(update.content.privateToolResultReceipt).toBeDefined();
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_SOURCE_FAILURE');
    const projected = projectCodeAwareStreamingUpdate('opencode-source-failure', update, true, 'en');
    expect(projected).toMatchObject({content: {
      resultNarration: 'This tool call did not complete; collected evidence is retained', isError: true,
    }});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
  });

  it('projects private wiki results before emitting OpenCode responses', async () => {
    const updates: any[] = [];
    await dispatchOpenCodeBridgeRequest([{
      name: 'lookup_blog_knowledge',
      exposure: 'internal',
      tool: {},
      shared: {
        name: 'lookup_blog_knowledge',
        description: 'Lookup knowledge',
        exposure: 'internal',
        inputSchema: {},
        handler: jest.fn(async () => ({content: [{type: 'text', text: JSON.stringify({result: {
          query: 'Handler',
          probed: ['android_internals_wiki'],
          retrievedAt: 1,
          legacyPath: false,
          hits: [{
            chunkId: 'wiki-1',
            score: 1,
            metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
            snippet: 'OPENCODE_PRIVATE_WIKI_CANARY',
          }],
        }})}]})),
      },
    } as any], {
      jsonrpc: '2.0',
      id: 'wiki-call',
      method: 'tools/call',
      params: {name: 'lookup_blog_knowledge', arguments: {}},
    }, update => updates.push(update));

    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENCODE_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('records OpenCode MCP bridge tool executions into the shared analysis plan evidence log', async () => {
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
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'invoke_skill',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => ({
            content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
          })),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__invoke_skill',
        arguments: { skillId: 'jank_frame_detail', params: { frameId: 59665219 } },
      },
    }, undefined, {
      analysisPlan: { current: plan },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      result: {
        content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
      },
    });
    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        inputSummary: 'jank_frame_detail(frameId)',
        matchedPhaseId: 'p-frame-detail',
      }),
    ]);
  });

  it('rethrows bridge tool cancellation instead of returning a JSON-RPC tool error', async () => {
    await expect(dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => {
            throw createTraceProcessorQueryCancelledError();
          }),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-cancel',
      method: 'tools/call',
      params: {
        name: 'smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats completed and skipped OpenCode plan phases as closed', () => {
    const plan: AnalysisPlanV3 = {
      phases: [
        {id: 'p1', name: 'Review', goal: 'Assess available evidence', expectedTools: [], status: 'completed'},
        {id: 'p2', name: 'Optional follow-up', goal: 'Resolve additional evidence', expectedTools: [],
          status: 'skipped', skipDisposition: {kind: 'evidence_unavailable'}},
      ],
      successCriteria: 'Answer within available evidence', submittedAt: 1, toolCallLog: [],
    };
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({complete: true, pending: []});

    plan.phases[1].status = 'in_progress';
    delete plan.phases[1].skipDisposition;
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({complete: false, pending: ['p2']});
  });

  it('does not treat a completed OpenCode phase as closed when required tool evidence is missing', () => {
    const status = getOpenCodePlanCompletionStatus({
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
      toolCallLog: [],
    } as any);

    expect(status).toMatchObject({
      complete: false,
      pending: ['p-frame-detail'],
    });
    expect(status.evidenceGaps?.[0].missingExpectedCalls).toEqual([
      { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
    ]);
  });




















  it('projects OpenCode events without synthesizing route terminal events', () => {
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.text.delta.1',
      data: { delta: 'hello' },
    }, 10)).toEqual({
      type: 'answer_token',
      content: 'hello',
      timestamp: 10,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.called.1',
      data: {
        tool: 'smartperfetto_query_trace',
        callID: 'call-1',
        input: { sql: 'select 1' },
      },
    }, 11)).toMatchObject({
      type: 'tool_call',
      content: {
        name: 'smartperfetto_query_trace',
        callId: 'call-1',
        runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      },
      timestamp: 11,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.failed.1',
      data: { tool: 'bash', error: { message: 'denied' } },
    }, 12)).toMatchObject({
      type: 'degraded',
      content: {
        source: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
        reason: 'tool_failed',
        tool: 'bash',
      },
      timestamp: 12,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'analysis_completed',
      data: {},
    })).toBeUndefined();
  });

  it('runs hidden no-reply smoke with isolated config and closes the server', async () => {
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
      env: {
        SMARTPERFETTO_OPENCODE_SERVER_PORT: '4106',
        SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '12345',
      },
      moduleLoader: createFakeModuleLoader(record),
    });
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '分析启动性能',
      'session-opencode',
      'trace-opencode',
      { analysisMode: 'full', packageName: 'com.example' },
    );

    expect(result).toMatchObject({
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(result.conclusion).toContain('OpenCode hidden runtime smoke completed');
    expect(record.closeCount).toBe(1);
    expect(record.createOptions).toMatchObject({
      hostname: '127.0.0.1',
      port: 4106,
      timeout: 12345,
      config: expect.objectContaining({
        share: 'disabled',
        snapshot: false,
        instructions: [],
        mcp: {},
      }),
    });
    expect(record.promptInput).toMatchObject({
      path: { id: 'ses-opencode-test' },
      body: {
        noReply: true,
        tools: expect.objectContaining({
          bash: false,
          edit: false,
          write: false,
          apply_patch: false,
        }),
      },
    });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
    ]));
  });

  it('passes the active code-aware mode and selected codebases into the OpenCode quick prompt', async () => {
    const record: {createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number} = {
      closeCount: 0,
    };
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createFakeModuleLoader(record),
    });

    const result = await runtime.analyze(
      '快速结合源码定位候选机制',
      'session-opencode-source-quick',
      'trace-opencode',
      {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-opencode-quick'],
      },
    );

    const prompt = record.promptInput as {body?: {system?: string}} | undefined;
    expect(readPromptContextFrame(prompt?.body?.system, 'source_authorization')).toMatchObject({
      mode: 'metadata_only', codebaseIds: ['cb-opencode-quick'], evidenceAccess: 'read_new',
    });
    expect(result).toMatchObject({
      success: false,
      partial: true,
      conclusion: '',
      completion: expect.objectContaining({status: 'unknown'}),
      sourceUseDecision: expect.objectContaining({status: 'pending'}),
    });
  });

  it('returns real MCP source refs and starts the next OpenCode run without stale source state', async () => {
    const sessionId = 'session-opencode-source-finalization';
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId,
    });
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('source-terminal', `## Final Report\n${SOURCE_FINALIZATION_RAW_SOURCE}`),
        openCodeAssistantResponse('source-off', '## Final Report\npublic second run'),
      ], promptInputs, close),
    });
    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      mockOpenCodePreparation(
        runtime,
        null,
        'startup',
        'source terminal run',
        [],
        fixture.sourceUse,
        true,
      );
      const terminal = await runtime.analyze('source terminal run', sessionId, 'trace-opencode', {
        analysisMode: 'fast',
        codeAwareMode: 'provider_send',
        codebaseIds: [fixture.codebaseId],
      });
      const context = finalizationContext.takeFinalizationContext(terminal)!;
      try {
        expect(context.getNativeDeclaration(terminal, new AbortController().signal)?.raw).toBe(`## Final Report\n${SOURCE_FINALIZATION_RAW_SOURCE}`);
        expect(JSON.stringify(terminal)).not.toContain('conclusion_protocol_projection');
      } finally {context.dispose();}
      mockOpenCodePreparation(runtime, null, 'startup', 'public second run', [], undefined, true);
      const next = await runtime.analyze('public second run', sessionId, 'trace-opencode', {
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

  it('keeps private source sessions out of durable OpenCode state and removes temporary files', async () => {
    await withBackendDataDir(async dataDir => {
      const paths: {home?: string; config?: string; project?: string; env?: NodeJS.ProcessEnv} = {};
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        env: {
          XDG_DATA_HOME: '/host/xdg/data',
          XDG_STATE_HOME: '/host/xdg/state',
          XDG_CACHE_HOME: '/host/xdg/cache',
          XDG_CONFIG_HOME: '/host/xdg/config',
          USERPROFILE: 'C:\\host-profile',
          APPDATA: 'C:\\host-appdata',
          LOCALAPPDATA: 'C:\\host-localappdata',
          OPENCODE_SERVER_USERNAME: 'host-user',
          OPENCODE_SERVER_PASSWORD: 'host-password',
        },
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            paths.env = processEnv;
            paths.home = processEnv.HOME;
            paths.config = processEnv.OPENCODE_CONFIG_DIR;
            fs.writeFileSync(path.join(paths.home!, 'provider-state'), 'PRIVATE_PROVIDER_STATE');
            fs.writeFileSync(path.join(paths.config!, 'tool-state'), 'PRIVATE_TOOL_STATE');
            return {
              server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
              client: {
                session: {
                  create: jest.fn(async () => ({data: {id: 'ses-private'}})),
                  prompt: jest.fn(async (input: any) => {
                    paths.project = input.query.directory;
                    fs.writeFileSync(
                      path.join(paths.project!, 'session-state'),
                      'PRIVATE_SESSION_STATE',
                    );
                    return {data: {info: {role: 'user'}, parts: []}};
                  }),
                },
              },
            };
          }),
        }),
      });

      await runtime.analyze(
        'analyze with private source',
        'session-opencode-private',
        'trace-opencode',
        {
          analysisMode: 'full',
          codeAwareMode: 'provider_send',
          codebaseIds: ['codebase-private'],
        },
      );

      expect(paths.home).toContain('smartperfetto-opencode-private-');
      expect(paths.config).toContain('smartperfetto-opencode-private-');
      expect(paths.project).toContain('smartperfetto-opencode-private-');
      const ephemeralRoot = path.dirname(paths.project!);
      for (const key of [
        'HOME',
        'USERPROFILE',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'APPDATA',
        'LOCALAPPDATA',
        'TMPDIR',
        'TMP',
        'TEMP',
        'OPENCODE_CONFIG_DIR',
      ]) {
        expect(path.resolve(paths.env![key]!)).toContain(`${path.resolve(ephemeralRoot)}${path.sep}`);
      }
      expect(paths.env?.OPENCODE_SERVER_USERNAME).not.toBe('host-user');
      expect(paths.env?.OPENCODE_SERVER_PASSWORD).not.toBe('host-password');
      expect(fs.existsSync(paths.home!)).toBe(false);
      expect(fs.existsSync(paths.config!)).toBe(false);
      expect(fs.existsSync(paths.project!)).toBe(false);
      expect(fs.existsSync(path.join(
        dataDir,
        'agent-runtime',
        'opencode',
        'session-opencode-private',
      ))).toBe(false);
    });
  });

  it('fails closed when a custom adapter cannot accept an explicit process environment', async () => {
    const legacyCreate = jest.fn(async () => {
      throw new Error('legacy create should not be called');
    });
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
      moduleLoader: async () => ({createOpencode: legacyCreate}),
    });

    await expect(runtime.analyze(
      'private source analysis',
      'session-opencode-legacy-adapter',
      'trace-opencode',
      {codeAwareMode: 'metadata_only', codebaseIds: ['codebase-private']},
    )).rejects.toThrow('does not support explicit per-process environment isolation');
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it('injects dual-trace pane mapping into the OpenCode comparison system prompt', async () => {
    useIntent({...BOUNDED_INTENT, taskKind: 'comparison', sceneId: 'startup', scope: 'scene_wide', deliverable: 'report', recommendedComplexity: 'full'});
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (traceId: string, sql: string) => {
      if (!sql.includes('sqlite_master')) return {columns: [], rows: [], durationMs: 1};
      return {
        columns: ['name'],
        rows: [[traceId === 'trace-current' ? 'android_current_only' : 'android_reference_only']],
        durationMs: 1,
      };
    });
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createFakeModuleLoader(record),
      },
    );

    await runtime.analyze(
      '对比左右 Trace 的启动速度差异',
      'session-opencode-compare',
      'trace-current',
      {
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
      },
    );

    const promptInput = record.promptInput as { body?: { system?: string } } | undefined;
    expect(readPromptContextFrame(promptInput?.body?.system, 'comparison_identity')).toMatchObject({
      referenceTraceId: 'trace-reference', capabilityProbeStatus: 'checked',
      tracePairContext: {layout: 'horizontal', primarySide: 'left', referenceSide: 'right', panes: [
        {side: 'left', traceSide: 'current', traceId: 'trace-current'},
        {side: 'right', traceSide: 'reference', traceId: 'trace-reference'},
      ]},
    });
    expect(readPromptContextFrame(promptInput?.body?.system, 'comparison_details')).toMatchObject({
      commonCapabilities: [], capabilityDiff: {currentOnly: ['android_current_only'], referenceOnly: ['android_reference_only']},
    });
  });



  it('bounds the OpenCode architecture cache with shared LRU semantics', () => {
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput());
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




  it('restores OpenCode provider directories while creating a fresh native session', async () => {
    await withBackendDataDir(async (dataDir) => {
      const firstRecord = {
        closeCount: 0,
        createInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const firstRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            firstRecord.homeAtCreate = processEnv.HOME;
            firstRecord.configAtCreate = processEnv.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4106',
                close: jest.fn(() => {
                  firstRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  create: jest.fn(async (input: unknown) => {
                    firstRecord.createInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    firstRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });

      await firstRuntime.analyze('first OpenCode question', 'session-opencode-resume', 'trace-opencode');
      const snapshot = firstRuntime.takeSnapshot(
        'session-opencode-resume',
        'trace-opencode',
        createSnapshotFields(),
      );
      const opaque = snapshot.engineState?.kind === 'opencode'
        ? snapshot.engineState.opencode.opaque
        : undefined;

      expect(opaque).toMatchObject({
        version: 1,
        openCodeSessionId: 'ses-opencode-original',
      });
      expect(opaque?.projectDir).toContain(dataDir);
      expect(opaque?.homeDir).toContain(dataDir);
      expect(opaque?.configDir).toContain(dataDir);
      expect(firstRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(firstRecord.configAtCreate).toBe(opaque?.configDir);

      const restoredRecord = {
        closeCount: 0,
        createCalls: 0,
        getInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            restoredRecord.homeAtCreate = processEnv.HOME;
            restoredRecord.configAtCreate = processEnv.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4107',
                close: jest.fn(() => {
                  restoredRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  get: jest.fn(async (input: unknown) => {
                    restoredRecord.getInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  create: jest.fn(async () => {
                    restoredRecord.createCalls += 1;
                    return { data: { id: 'ses-opencode-new' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    restoredRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });
      restoredRuntime.restoreFromSnapshot('session-opencode-resume', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up OpenCode question', 'session-opencode-resume', 'trace-opencode');

      expect(restoredRecord.createCalls).toBe(1);
      expect(restoredRecord.getInput).toBeUndefined();
      expect(restoredRecord.promptInput).toMatchObject({
        path: { id: 'ses-opencode-new' },
        query: { directory: opaque?.projectDir },
      });
      expect(restoredRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(restoredRecord.configAtCreate).toBe(opaque?.configDir);
    });
  });

  it('rejects same-session direct overlap before OpenCode provider work starts', async () => {
    await withBackendDataDir(async () => {
      const releasePrompt = createDeferred<unknown>();
      const moduleLoader: OpenCodeSdkModuleLoader = async () => ({
        createOpencodeWithEnv: jest.fn(async () => ({
          server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
          client: {
            session: {
              create: jest.fn(async () => ({ data: { id: 'ses-opencode-overlap' } })),
              prompt: jest.fn(async () => {
                await releasePrompt.promise;
                return { data: { info: { role: 'user' }, parts: [] } };
              }),
            },
          },
        })),
      });
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });

      const first = runtime.analyze('first', 'session-opencode-overlap', 'trace-opencode', {
        runId: 'run-1',
        referenceTraceId: 'ref-1',
      });
      await Promise.resolve();
      const second = runtime.analyze('second', 'session-opencode-overlap', 'trace-opencode', {
        runId: 'run-2',
        referenceTraceId: 'ref-2',
      });

      releasePrompt.resolve(undefined);
      await expect(second).rejects.toThrow(/already in progress/i);
      await expect(first).resolves.toMatchObject({ success: true });
    });
  });

  it('allows different OpenCode sessions to run independently even with matching trace input', async () => {
    await withBackendDataDir(async () => {
      let createdSessionOrdinal = 0;
      const moduleLoader: OpenCodeSdkModuleLoader = async () => ({
        createOpencodeWithEnv: jest.fn(async () => ({
          server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
          client: {
            session: {
              create: jest.fn(async () => ({
                data: { id: `ses-opencode-isolated-${++createdSessionOrdinal}` },
              })),
              prompt: jest.fn(async () => openCodeAssistantResponse(
                `msg-opencode-isolated-${createdSessionOrdinal}`,
                'OpenCode isolated completed',
              )),
            },
          },
        })),
      });
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });

      await expect(Promise.all([
        runtime.analyze('first', 'session-opencode-isolated-1', 'trace-opencode', {
          runId: 'run-1',
          referenceTraceId: 'ref-1',
        }),
        runtime.analyze('second', 'session-opencode-isolated-2', 'trace-opencode', {
          runId: 'run-2',
          referenceTraceId: 'ref-2',
        }),
      ])).resolves.toEqual([
        expect.objectContaining({ success: true }),
        expect.objectContaining({ success: true }),
      ]);
    });
  });

  it('does not record first output when OpenCode completes without an assistant message', async () => {
    await withBackendDataDir(async () => {
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const promptInputs: unknown[] = [];
      const close = jest.fn();
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createOpenCodeReportModuleLoader([
          {data: {info: {role: 'user'}, parts: [{type: 'text', text: 'no assistant yet'}]}},
          {data: {info: {role: 'user'}, parts: [{type: 'text', text: 'still no assistant'}]}},
        ], promptInputs, close),
      });
      mockOpenCodePreparation(runtime, {
        phases: [{id: 'p1', name: 'evidence', goal: 'Review available evidence', expectedTools: [], status: 'completed', summary: 'evidence complete'}],
        successCriteria: 'done',
        submittedAt: 1,
        toolCallLog: [],
      }, 'scrolling', '分析滑动性能');

      await expect(runtime.analyze('分析滑动性能', 'session-opencode-no-output', 'trace-opencode', {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      })).resolves.toMatchObject({success: false, partial: true, conclusion: ''});

      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.firstOutputMs).toBeUndefined();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'finalization', outcome: 'error'}),
      ]));
    });
  });

  it('records first output when OpenCode observes an assistant message', async () => {
    await withBackendDataDir(async () => {
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const promptInputs: unknown[] = [];
      const close = jest.fn();
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createOpenCodeReportModuleLoader([
          openCodeAssistantResponse('msg-opencode-output', [
            '# Final Report',
            '',
            '## 综合结论',
            'OpenCode delivered assistant output.',
          ].join('\n')),
        ], promptInputs, close),
      });
      mockOpenCodePreparation(runtime, {
        phases: [{id: 'p1', name: 'evidence', status: 'completed', summary: 'evidence complete'}],
        successCriteria: 'done',
        submittedAt: 1,
        toolCallLog: [],
      }, 'scrolling', '分析滑动性能');

      await expect(runtime.analyze('分析滑动性能', 'session-opencode-output', 'trace-opencode', {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      })).resolves.toMatchObject({success: true});

      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.firstOutputMs).toEqual(expect.any(Number));
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'ok'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'provider', outcome: 'ok'}),
        expect.objectContaining({name: 'finalization', outcome: 'ok'}),
      ]));
    });
  });

  it('records OpenCode finalization exactly once on provider execution error', async () => {
    await withBackendDataDir(async () => {
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const promptInputs: unknown[] = [];
      const close = jest.fn();
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createOpenCodeReportModuleLoader([
          new Error('opencode provider failed'),
        ], promptInputs, close),
      });
      mockOpenCodePreparation(runtime, {
        phases: [{id: 'p1', name: 'evidence', status: 'completed', summary: 'evidence complete'}],
        successCriteria: 'done',
        submittedAt: 1,
        toolCallLog: [],
      }, 'scrolling', '分析滑动性能');

      await expect(runtime.analyze('分析滑动性能', 'session-opencode-error', 'trace-opencode', {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      })).rejects.toThrow('opencode provider failed');

      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'error'}));
      expect(receipt.phases).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'provider', outcome: 'error'}),
      ]));
    });
  });

  it('does not publish an OpenCode turn when cancelled during final verification', async () => {
    await withBackendDataDir(async () => {
      const sessionId = 'session-opencode-verification-cancel';
      const traceId = 'trace-opencode';
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
      const addTurn = jest.fn();
      const promptInputs: unknown[] = [];
      const close = jest.fn();
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const completedPlan = createCompletedScrollingPlanWithFinalPhase();
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createOpenCodeReportModuleLoader([
          openCodeAssistantResponse('verified', [
            '## 综合结论',
            'OpenCode verification cancellation should not publish a durable turn.',
            '',
            '## 峰值/口径指标',
            '真实掉帧 0 帧；最长帧 12ms。',
            '',
            '## 掉帧与根因分布',
            '| 根因 | 帧数 | 占比 |',
            '| --- | ---: | ---: |',
            '| none | 0 | 0% |',
            '',
            '## 代表帧分析',
            '无代表性超预算帧。',
            '',
            '## 优化建议',
            '保持当前实现并持续监控。',
          ].join('\n')),
        ], promptInputs, close),
      });
      mockOpenCodePreparation(
        runtime,
        completedPlan,
        'scrolling',
        '分析滑动性能',
      );
      jest.spyOn(runtime as any, 'prepareAnalysis').mockResolvedValue({
        systemPrompt: 'SmartPerfetto system prompt',
        prompt: '分析滑动性能',
        toolDefinitions: [],
        allowedToolNames: new Set<string>(),
        quickMode: false,
        sceneType: 'scrolling',
        packageName: 'com.example.app',
        sessionContext: {addTurn},
        previousTurns: [],
        analysisPlan: {current: completedPlan, history: []},
        notes: [],
        hypotheses: [],
        uncertaintyFlags: [],
        analysisRunSpec: {runtime: {kind: OPENCODE_RUNTIME_KIND}, query: {text: '分析滑动性能'}, outputLanguage: 'zh-CN', traceContext: {datasetCount: 0}, mode: {adaptiveRouting: undefined}},
      });

      const analysis = runtime.analyze('分析滑动性能', sessionId, traceId, {
        analysisMode: 'full',
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      });
      await verificationStarted.promise;
      const promptCountAtCancellation = promptInputs.length;
      await runtime.abortSession(sessionId);
      releaseVerification.resolve();

      await expect(analysis).rejects.toThrow(/aborted|cancelled/i);
      expect(promptInputs).toHaveLength(promptCountAtCancellation);
      expect(addTurn).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      const receipt = runtimePerformanceRecorder.seal();
      const finalizationPhases = receipt.phases.filter(phase => phase.name === 'finalization');
      expect(finalizationPhases).toHaveLength(1);
      expect(finalizationPhases[0]).toEqual(expect.objectContaining({outcome: 'cancelled'}));
    });
  });

  it('closes the OpenCode bridge when cancelled after bridge creation before provider startup', async () => {
    await withBackendDataDir(async () => {
      const sessionId = 'session-opencode-bridge-cancel';
      const closeBridge = jest.fn(async () => undefined);
      const createOpencodeWithEnv = jest.fn(async () => ({
        server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
        client: {
          session: {
            create: jest.fn(async () => ({data: {id: 'ses-opencode-bridge-cancel'}})),
            prompt: jest.fn(async () => openCodeAssistantResponse('unexpected', 'unexpected')),
          },
        },
      }));
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: jest.fn(async () => ({createOpencodeWithEnv})),
        bridgeStarter: jest.fn(async () => ({
          port: 49001,
          token: 'bridge-token',
          close: closeBridge,
          getDiagnostics: () => ({
            connectionCount: 0,
            requestCount: 0,
            lastMethod: undefined,
            lastError: undefined,
          }),
        })),
      } as any);
      mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());
      const originalResolveSessionDirs = (runtime as any).resolveSessionDirs.bind(runtime);
      jest.spyOn(runtime as any, 'resolveSessionDirs').mockImplementation((...args: unknown[]) => {
        const resolved = originalResolveSessionDirs(...args);
        void (runtime as any).executionGuard.abortSession(sessionId);
        return resolved;
      });

      await expect(runtime.analyze('分析滑动性能', sessionId, 'trace-opencode', {
        analysisMode: 'full',
      })).rejects.toThrow(/aborted|cancelled/i);
      expect(createOpencodeWithEnv).not.toHaveBeenCalled();
      expect(closeBridge).toHaveBeenCalledTimes(1);
    });
  });

  it('closes the OpenCode provider and bridge when an SDK endpoint hangs past the prompt deadline', async () => {
    await withBackendDataDir(async () => {
      const hungPrompt = createDeferred<unknown>();
      const closeServer = jest.fn(() => undefined);
      const closeBridge = jest.fn(async () => undefined);
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_REAL_ANALYSIS: 'true',
          SMARTPERFETTO_OPENCODE_PROMPT_TIMEOUT_MS: '50',
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"test","modelID":"test"}',
        },
        moduleLoader: jest.fn(async () => ({
          createOpencodeWithEnv: jest.fn(async () => ({
            server: {url: 'http://127.0.0.1:4106', close: closeServer},
            client: {
              mcp: {status: jest.fn(async () => ({data: {smartperfetto: {status: 'connected'}}}))},
              session: {
                create: jest.fn(async () => ({data: {id: 'ses-opencode-timeout'}})),
                prompt: jest.fn(async () => ({})),
                promptAsync: jest.fn(() => hungPrompt.promise),
                messages: jest.fn(async () => ({data: []})),
              },
            },
          })),
        })),
        bridgeStarter: jest.fn(async () => ({
          port: 43123,
          token: 'bridge-token',
          requestTimeoutMs: 5_000,
          getDiagnostics: () => ({connectionCount: 0, requestCount: 0}),
          close: closeBridge,
        })),
      });
      mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

      const analysis = runtime.analyze(
        '分析滑动性能',
        'session-opencode-provider-timeout',
        'trace-opencode',
        {analysisMode: 'full'},
      );
      try {
        await expect(Promise.race([
          analysis,
          new Promise((_, reject) => setTimeout(() => reject(new Error('outer-test-timeout')), 500)),
        ])).rejects.toMatchObject({name: 'TimeoutError', code: 'OPENCODE_PROMPT_TIMEOUT'});
        expect(closeServer).toHaveBeenCalledTimes(1);
        expect(closeBridge).toHaveBeenCalledTimes(1);
      } finally {
        hungPrompt.reject(new Error('late provider rejection'));
        await analysis.catch(() => undefined);
      }
    });
  });

  it('closes OpenCode server and bridge when cancelled while provider instance creation settles', async () => {
    await withBackendDataDir(async () => {
      const sessionId = 'session-opencode-create-cancel';
      const createStarted = createDeferred<void>();
      const releaseCreate = createDeferred<void>();
      const closeBridge = jest.fn(async () => undefined);
      const closeServer = jest.fn(() => undefined);
      const createOpencodeWithEnv = jest.fn(async () => {
        createStarted.resolve();
        await releaseCreate.promise;
        return {
          server: {url: 'http://127.0.0.1:4106', close: closeServer},
          client: {
            mcp: {
              status: jest.fn(async () => ({data: {smartperfetto: {status: 'connected'}}})),
            },
            session: {
              create: jest.fn(async () => ({data: {id: 'ses-opencode-create-cancel'}})),
              prompt: jest.fn(async () => openCodeAssistantResponse('unexpected', 'unexpected')),
            },
          },
        };
      });
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: jest.fn(async () => ({createOpencodeWithEnv})),
        bridgeStarter: jest.fn(async () => ({
          port: 49002,
          token: 'bridge-token',
          close: closeBridge,
          getDiagnostics: () => ({
            connectionCount: 0,
            requestCount: 0,
            lastMethod: undefined,
            lastError: undefined,
          }),
        })),
      } as any);
      mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

      const analysis = runtime.analyze('分析滑动性能', sessionId, 'trace-opencode', {
        analysisMode: 'full',
      });
      await createStarted.promise;
      await runtime.abortSession(sessionId);
      releaseCreate.resolve();

      await expect(analysis).rejects.toThrow(/aborted|cancelled/i);
      expect(createOpencodeWithEnv).toHaveBeenCalledTimes(1);
      expect(closeServer).toHaveBeenCalledTimes(1);
      expect(closeBridge).toHaveBeenCalledTimes(1);
    });
  });

  it('closes OpenCode server and bridge when cancelled during MCP readiness before ownership registration', async () => {
    await withBackendDataDir(async () => {
      const sessionId = 'session-opencode-readiness-cancel';
      const readinessStarted = createDeferred<void>();
      const releaseReadiness = createDeferred<void>();
      const closeBridge = jest.fn(async () => undefined);
      const closeServer = jest.fn(() => undefined);
      const status = jest.fn(async () => {
        readinessStarted.resolve();
        await releaseReadiness.promise;
        return {data: {smartperfetto: {status: 'connected'}}};
      });
      const createOpencodeWithEnv = jest.fn(async () => ({
        server: {url: 'http://127.0.0.1:4106', close: closeServer},
        client: {
          mcp: {status},
          session: {
            create: jest.fn(async () => ({data: {id: 'ses-opencode-readiness-cancel'}})),
            prompt: jest.fn(async () => openCodeAssistantResponse('unexpected', 'unexpected')),
          },
        },
      }));
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
        selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
      }), {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON:
            '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: jest.fn(async () => ({createOpencodeWithEnv})),
        bridgeStarter: jest.fn(async () => ({
          port: 49003,
          token: 'bridge-token',
          close: closeBridge,
          getDiagnostics: () => ({
            connectionCount: 0,
            requestCount: 1,
            lastMethod: 'mcp.status',
            lastError: undefined,
          }),
        })),
      } as any);
      mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

      const analysis = runtime.analyze('分析滑动性能', sessionId, 'trace-opencode', {
        analysisMode: 'full',
      });
      await readinessStarted.promise;
      await runtime.abortSession(sessionId);
      releaseReadiness.resolve();

      await expect(analysis).rejects.toThrow(/aborted|cancelled/i);
      expect(createOpencodeWithEnv).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledTimes(1);
      expect(closeServer).toHaveBeenCalledTimes(1);
      expect(closeBridge).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps product metadata and starts fresh without attempting a previous third-party session', async () => {
    await withBackendDataDir(async () => {
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined) },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: 'ses-opencode-original' } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          })),
        }),
      });
      await runtime.analyze('first', 'session-opencode-missing', 'trace-opencode');
      const snapshot = runtime.takeSnapshot(
        'session-opencode-missing',
        'trace-opencode',
        createSnapshotFields(),
      );
      snapshot.analysisNotes.push({section: 'observation', content: 'Retained product observation', priority: 'low', timestamp: 1});

      const createCalls: unknown[] = [];
      const updates: any[] = [];
      const getPreviousSession = jest.fn(async () => {throw new Error('missing session');});
      const promptFreshSession = jest.fn(async (_input: unknown) => ({data: {info: {role: 'user'}, parts: []}}));
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4107', close: jest.fn(() => undefined) },
            client: {
              session: {
                get: getPreviousSession,
                create: jest.fn(async (input: unknown) => {
                  createCalls.push(input);
                  return { data: { id: 'ses-opencode-fresh' } };
                }),
                prompt: promptFreshSession,
              },
            },
          })),
        }),
      });
      restoredRuntime.on('update', update => updates.push(update));
      restoredRuntime.restoreFromSnapshot('session-opencode-missing', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up', 'session-opencode-missing', 'trace-opencode');

      expect(createCalls).toHaveLength(1);
      expect(getPreviousSession).not.toHaveBeenCalled();
      expect(promptFreshSession).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'ses-opencode-fresh'}}));
      expect(restoredRuntime.getSessionNotes('session-opencode-missing')).toEqual(snapshot.analysisNotes);
      expect(updates.some(update => update.type === 'degraded')).toBe(false);
    });
  });

  it('passes per-process OpenCode env without mutating global HOME during concurrent startup', async () => {
    await withBackendDataDir(async () => {
      let activeCreates = 0;
      let maxActiveCreates = 0;
      const createRecords: Array<{ home?: string; config?: string }> = [];
      const moduleLoader: OpenCodeSdkModuleLoader = async () => ({
        createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
          activeCreates += 1;
          maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
          createRecords.push({
            home: processEnv.HOME,
            config: processEnv.OPENCODE_CONFIG_DIR,
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          activeCreates -= 1;
          return {
            server: { url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined) },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: `ses-${createRecords.length}` } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          };
        }),
      });
      const runtimeA = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });
      const runtimeB = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });
      const originalHome = process.env.HOME;
      const originalConfig = process.env.OPENCODE_CONFIG_DIR;

      await Promise.all([
        runtimeA.analyze('first', 'session-opencode-a', 'trace-opencode'),
        runtimeB.analyze('second', 'session-opencode-b', 'trace-opencode'),
      ]);

      expect(maxActiveCreates).toBe(2);
      expect(process.env.HOME).toBe(originalHome);
      expect(process.env.OPENCODE_CONFIG_DIR).toBe(originalConfig);
      expect(createRecords).toHaveLength(2);
      expect(createRecords[0].home).toContain('session-opencode-a');
      expect(createRecords[1].home).toContain('session-opencode-b');
      expect(createRecords[0].config).toContain('session-opencode-a');
      expect(createRecords[1].config).toContain('session-opencode-b');
    });
  });

  it('reports hidden runtime diagnostics without exposing a public provider', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/tmp/sdk.js',
      SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/tmp/project',
      SMARTPERFETTO_OPENCODE_SERVER_PORT: '4107',
      SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '5000',
    }, EXPERIMENTAL_OPENCODE_RUNTIME_KIND)).toMatchObject({
      configured: false,
      runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      experimental: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
      modulePath: '/tmp/sdk.js',
      projectDir: '/tmp/project',
      serverPort: 4107,
      serverTimeoutMs: 5000,
      standaloneMcpEnabled: false,
      standaloneMcpTimeoutMs: 5000,
    });
  });

  it('reports public OpenCode diagnostics by default for M14 provider checks', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      PATH: '/usr/bin',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
    })).toMatchObject({
      configured: true,
      runtime: 'opencode',
      experimental: false,
      modelConfigured: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
    });
  });

  it('does not expose malformed OpenCode model JSON through validation', () => {
    const secret = 'sk-opencode-runtime-secret';
    const result = validateOpenCodeModelConfiguration({
      SMARTPERFETTO_OPENCODE_MODEL_JSON: `{"apiKey":"${secret}",`,
    }, {kind: 'opencode', source: 'env'});

    expect(result).toEqual({
      configured: false,
      reason: 'invalid_json',
      error: 'OpenCode model configuration is invalid or incomplete; set valid SMARTPERFETTO_OPENCODE_MODEL_JSON or an OpenAI-compatible model and base URL.',
    });
    expect(JSON.stringify(result)).not.toContain(secret);

    expect(validateOpenCodeModelConfiguration({
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{}',
    }, {kind: 'opencode', source: 'env'})).toEqual({
      configured: false,
      reason: 'incomplete',
      error: 'OpenCode model configuration is invalid or incomplete; set valid SMARTPERFETTO_OPENCODE_MODEL_JSON or an OpenAI-compatible model and base URL.',
    });
  });
});
