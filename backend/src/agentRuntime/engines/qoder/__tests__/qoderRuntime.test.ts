// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockInterrupt = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockQuery = jest.fn();

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
const mockEnsureSkillRegistryInitialized = jest.fn<any>().mockResolvedValue(undefined);
const mockLoadQoderSdkModule = jest.fn<any>().mockResolvedValue(mockSdkModule);
const mockResetQoderSdkModuleCache = jest.fn();
const mockCreateClaudeMcpServer = jest.fn().mockReturnValue({
  server: { name: 'smartperfetto' },
  allowedTools: ['mcp__smartperfetto__query_trace'],
  toolDefinitions: [],
});
const mockProjectionWrite = jest.fn<(text: string) => string>().mockImplementation(text => text);
const mockProjectionFlush = jest.fn<() => string>().mockReturnValue('');
const mockProjectionProjectComplete = jest.fn<(text: string) => string>().mockImplementation(text => text);
const mockBuildComparisonContext = jest.fn<any>().mockResolvedValue(undefined);
const mockBuildQuickConversationContext = jest.fn<any>().mockReturnValue(undefined);
const mockFormatTraceContext = jest.fn<any>().mockReturnValue('');

jest.mock('../qoderSdkLoader', () => ({
  loadQoderSdkModule: (...args: unknown[]) => mockLoadQoderSdkModule(...args),
  resetQoderSdkModuleCache: () => mockResetQoderSdkModuleCache(),
}));

jest.mock('../../../../services/skillEngine/skillExecutor', () => ({
  createSkillExecutor: jest.fn<any>().mockReturnValue({
    registerSkills: mockRegisterSkills,
    setFragmentRegistry: mockSetFragmentRegistry,
    executeSkill: jest.fn(),
  }),
}));

jest.mock('../../../../services/skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: (...args: unknown[]) => mockEnsureSkillRegistryInitialized(...args),
  skillRegistry: {
    isInitialized: jest.fn<any>().mockReturnValue(false),
    getAllSkills: jest.fn<any>().mockReturnValue([]),
    getFragmentCache: jest.fn<any>().mockReturnValue({}),
  },
}));

jest.mock('../../../../agentv3/claudeMcpServer', () => ({
  createClaudeMcpServer: (...args: unknown[]) => mockCreateClaudeMcpServer(...args),
  loadLearnedSqlFixPairs: jest.fn<any>().mockReturnValue([]),
}));

jest.mock('../../../../agent/detectors/architectureDetector', () => ({
  createArchitectureDetector: jest.fn<any>().mockReturnValue({
    detect: jest.fn<any>().mockResolvedValue({ type: 'pixel' }),
  }),
}));

jest.mock('../../../../agentv3/focusAppDetector', () => {
  const actual = jest.requireActual<typeof import('../../../../agentv3/focusAppDetector')>(
    '../../../../agentv3/focusAppDetector',
  );
  return {
    ...actual,
    detectFocusApps: jest.fn<any>().mockResolvedValue({ apps: [], method: 'none' }),
  };
});

jest.mock('../../../../agentv3/traceCompletenessProber', () => ({
  probeTraceCompleteness: jest.fn<any>().mockResolvedValue({
    available: [],
    missingConfig: [],
    notApplicable: [],
    insufficient: [],
  }),
}));

jest.mock('../../../../services/finalResultQualityGate', () => ({
  applyFinalResultQualityGate: jest.fn(),
  hasDeliverableFinalReportHeading: jest.fn<any>().mockReturnValue(true),
}));

jest.mock('../../claude/claudeVerifier', () => ({
  verifyConclusion: jest.fn<any>().mockResolvedValue({ heuristicIssues: [], llmIssues: [] }),
}));

jest.mock('../../../../services/security/codeAwareOutputRegistry', () => {
  const actual = jest.requireActual<typeof import('../../../../services/security/codeAwareOutputRegistry')>(
    '../../../../services/security/codeAwareOutputRegistry',
  );
  return {
    ...actual,
    createCodeAwareStreamingTextProjection: jest.fn<any>().mockImplementation(() => ({
      write: mockProjectionWrite,
      flush: mockProjectionFlush,
      projectComplete: mockProjectionProjectComplete,
    })),
  };
});

jest.mock('../../../../agentv3/claudeFindingExtractor', () => ({
  extractFindingsFromText: jest.fn<any>().mockReturnValue([]),
}));

jest.mock('../../../runtimePromptContext', () => ({
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
import * as quickEvidenceDirectAnswer from '../../../quickEvidenceDirectAnswer';
import {
  createRuntimeSourceFinalizationFixture,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from '../../../__tests__/sourceFinalizationFixture';
import {createRuntimePerformanceRecorder} from '../../../runtimePerformance';
import type {RunManifestAttributionSink} from '../../../../types/selfEvolution';

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
    mockProjectionProjectComplete.mockImplementation(text => text);
    mockBuildComparisonContext.mockResolvedValue(undefined);
    mockBuildQuickConversationContext.mockReturnValue(undefined);
    mockFormatTraceContext.mockReturnValue('');
    mockCreateClaudeMcpServer.mockReturnValue({
      server: { name: 'smartperfetto' },
      allowedTools: ['mcp__smartperfetto__query_trace'],
      toolDefinitions: [],
    });
  });

  describe('tool and permission boundaries', () => {
    it('disables all built-in SDK tools via tools: []', async () => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'ses-1' },
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
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
        { type: 'result', subtype: 'success', result: 'done' },
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
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
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
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1');

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.cwd).not.toBe(process.cwd());
    });
  });

  describe('runtime pre-evidence direct answers', () => {
    it('answers the issue #235 query without preflight detection or a Qoder SDK call', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockResolvedValueOnce({
        directAnswer: {
          conclusion: 'The 5 longest process slices are backed by deterministic trace evidence.',
          conclusionContract: {
            schemaVersion: 'conclusion_contract_v1',
            mode: 'focused_answer',
            conclusions: [{
              rank: 1,
              statement: 'The 5 longest process slices are backed by deterministic trace evidence.',
              evidenceRefIds: ['evidence-1'],
            }],
            clusters: [],
            evidenceChain: [],
            claims: [],
            uncertainties: [],
            nextSteps: [],
            metadata: {
              confidencePercent: 100,
              rounds: 0,
              claimDerivation: 'explicit_model_contract',
              claimVerificationScope: 'explicit_claims',
            },
          },
          confidence: 1,
        },
        evidenceCounts: {
          currentRunDataEnvelopes: 1,
          citedEvidenceRefs: 1,
        },
        focusResult: {
          apps: [],
          method: 'none',
        },
      } as any);
      try {
        const updates: any[] = [];
        const runtime = createRuntime();
        runtime.on('update', update => updates.push(update));

        const result = await runtime.analyze(
          'summarize top-5 longest process slices',
          'session-1',
          'trace-1',
        );

        expect(directEvidenceSpy).toHaveBeenCalledWith(expect.objectContaining({
          query: 'summarize top-5 longest process slices',
          traceId: 'trace-1',
          quickTraceFactPreEvidence: true,
        }));
        expect(createArchitectureDetector).not.toHaveBeenCalled();
        expect(detectFocusApps).not.toHaveBeenCalled();
        expect(probeTraceCompleteness).not.toHaveBeenCalled();
        expect(createSkillExecutor).not.toHaveBeenCalled();
        expect(mockCreateClaudeMcpServer).not.toHaveBeenCalled();
        expect(mockQuery).not.toHaveBeenCalled();
        expect(mockEnsureSkillRegistryInitialized).toHaveBeenCalledTimes(1);
        expect(mockLoadQoderSdkModule).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
          success: true,
          rounds: 0,
          confidence: 1,
        }));
        expect(result.quickRun).toEqual(expect.objectContaining({
          resolvedMode: 'quick',
          actualTurns: 0,
          stopReason: 'answered',
        }));
        expect(updates).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'progress',
            content: expect.objectContaining({ model: 'runtime-pre-evidence' }),
          }),
          expect.objectContaining({ type: 'conclusion' }),
          expect.objectContaining({
            type: 'answer_token',
            content: expect.objectContaining({ done: true }),
          }),
        ]));
      } finally {
        directEvidenceSpy.mockRestore();
      }
    });

    it('rejects same-session direct overlap before Qoder provider work starts', async () => {
      const comparisonStarted = createDeferred<void>();
      const releaseComparison = createDeferred<void>();
      mockBuildComparisonContext.mockImplementationOnce(async () => {
        comparisonStarted.resolve();
        await releaseComparison.promise;
        return undefined;
      });
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: 'Qoder overlap first completed.' },
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
        { type: 'result', subtype: 'success', result: 'Qoder isolated completed.' },
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

    it('stops after cancelled Qoder preflight without provider or snapshot publication', async () => {
      const preflightStarted = createDeferred<void>();
      const releasePreflight = createDeferred<any>();
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockImplementation(async () => {
        preflightStarted.resolve();
        await releasePreflight.promise;
        return undefined;
      });
      try {
        const runtime = createRuntime();
        const analysis = runtime.analyze(
          'summarize top-5 longest process slices',
          'session-qoder-cancel-preflight',
          'trace-1',
        );

        await preflightStarted.promise;
        await runtime.abortSession('session-qoder-cancel-preflight');
        releasePreflight.resolve(undefined);

        await expect(analysis).resolves.toMatchObject({
          success: false,
          partial: true,
          terminationReason: 'timeout',
        });
        expect(mockQuery).not.toHaveBeenCalled();
        const snapshot = runtime.takeSnapshot(
          'session-qoder-cancel-preflight',
          'trace-1',
          {
            conversationSteps: [],
            queryHistory: [],
            conclusionHistory: [],
            agentDialogue: [],
            agentResponses: [],
            dataEnvelopes: [],
            hypotheses: [],
            runSequence: 1,
            conversationOrdinal: 0,
          } as any,
        ) as any;
        expect(snapshot.engineState?.qoder?.opaque).toEqual({
          version: 1,
          degradedReason: 'state_unavailable',
        });
      } finally {
        directEvidenceSpy.mockRestore();
      }
    });

    it('falls back to the normal Qoder path when deterministic evidence is unavailable', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockResolvedValueOnce(undefined);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
      ]));
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({
        detect: jest.fn<any>().mockResolvedValue({type: 'COMPOSE'}),
      } as any);
      try {
        const result = await createRuntime().analyze(
          'summarize top-5 longest process slices',
          'session-1',
          'trace-1',
        );

        expect(createArchitectureDetector).toHaveBeenCalled();
        expect(probeTraceCompleteness).toHaveBeenCalledWith(
          expect.objectContaining({query: expect.any(Function)}),
          'trace-1',
          'COMPOSE',
        );
        expect(createSkillExecutor).toHaveBeenCalled();
        expect(mockCreateClaudeMcpServer).toHaveBeenCalled();
        expect(mockEnsureSkillRegistryInitialized).toHaveBeenCalledTimes(1);
        expect(mockLoadQoderSdkModule).toHaveBeenCalledTimes(1);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result.conclusion).toBe('## Final Report\nfallback');
      } finally {
        directEvidenceSpy.mockRestore();
      }
    });

    it('reuses real quick-evidence focus state on fallback without repeating Qoder focus detection', async () => {
      const detect = jest.fn<any>().mockResolvedValue({ type: 'COMPOSE' });
      const actualFocusAppDetector = jest.requireActual<typeof import('../../../../agentv3/focusAppDetector')>(
        '../../../../agentv3/focusAppDetector',
      );
      jest.mocked(detectFocusApps).mockImplementationOnce(
        actualFocusAppDetector.detectFocusApps as any,
      );
      const updates: Array<{ type?: string; content?: unknown }> = [];
      const focusSqlKinds: string[] = [];
      const traceFactSqlKinds: string[] = [];
      const traceProcessorService = {
        query: jest.fn(async (_traceId: string, sql: string) => {
          const fromFocusDetector = new Error().stack?.includes('focusAppDetector') === true;
          if (
            fromFocusDetector &&
            sql.includes('android_battery_stats_event_slices') &&
            sql.includes('GROUP BY str_value')
          ) {
            focusSqlKinds.push('battery');
            return {
              columns: ['package_name', 'total_duration_ns', 'switch_count'],
              rows: [],
              durationMs: 1,
            };
          }
          if (
            fromFocusDetector &&
            sql.includes('android_oom_adj_intervals') &&
            sql.includes('WITH foreground_intervals')
          ) {
            focusSqlKinds.push('oom_adj');
            return {
              columns: ['package_name', 'total_duration_ns', 'switch_count'],
              rows: [],
              durationMs: 1,
            };
          }
          if (sql.includes('runtime_frame_metrics')) {
            traceFactSqlKinds.push('runtime_frame_metrics');
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
              rows: [],
              durationMs: 1,
            };
          }
          if (
            fromFocusDetector &&
            sql.includes('actual_frame_timeline_slice') &&
            sql.includes('WITH frame_packages')
          ) {
            focusSqlKinds.push('frame_timeline');
            return {
              columns: ['package_name', 'total_duration_ns', 'frame_count'],
              rows: [['com.frame.app', 1_250_000_000, 3]],
              durationMs: 1,
            };
          }
          return { columns: [], rows: [], durationMs: 1 };
        }),
      };
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
      ]));
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({ detect } as any);
      try {
        const runtime = createRuntime({
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task4',
        }, traceProcessorService);
        runtime.on('update', update => updates.push(update));
        mockQuery.mockImplementationOnce(() => {
          expect(updates.map(update => update.type)).not.toContain('data');
          expect(updates.map(update => update.type)).not.toContain('conclusion');
          return createMockSdkStream([
            { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
          ]);
        });
        const result = await runtime.analyze(
          '滑动 FPS 是多少？',
          'session-qoder-reused-quick-attempt',
          'trace-1',
        );

        expect(detectFocusApps).toHaveBeenCalledTimes(1);
        expect(focusSqlKinds).toEqual(['battery', 'oom_adj', 'frame_timeline']);
        expect(traceFactSqlKinds).toEqual(['runtime_frame_metrics']);
        expect(detect).toHaveBeenCalledWith(expect.objectContaining({
          traceId: 'trace-1',
          packageName: 'com.frame.app',
        }));
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result.conclusion).toBe('## Final Report\nfallback');
      } finally {
        sessionContextManager.remove('session-qoder-reused-quick-attempt');
      }
    });

    it('starts the SDK load after a quick miss while independent trace preflight is pending', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockResolvedValueOnce(undefined);
      const sdkLoad = createDeferred<typeof mockSdkModule>();
      const architectureStarted = createDeferred<void>();
      const releaseArchitecture = createDeferred<void>();
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({
        detect: jest.fn(async () => {
          architectureStarted.resolve();
          await releaseArchitecture.promise;
          return { type: 'pixel' };
        }),
      } as any);
      mockLoadQoderSdkModule.mockReturnValueOnce(sdkLoad.promise);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
      ]));
      try {
        const analysis = createRuntime({
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task9',
        }).analyze(
          'summarize top-5 longest process slices',
          'session-qoder-sdk-overlap',
          'trace-1',
        );

        await architectureStarted.promise;
        expect(mockLoadQoderSdkModule).toHaveBeenCalledTimes(1);
        expect(mockQuery).not.toHaveBeenCalled();

        sdkLoad.resolve(mockSdkModule);
        releaseArchitecture.resolve();
        await expect(analysis).resolves.toMatchObject({ success: true });
      } finally {
        sdkLoad.resolve(mockSdkModule);
        releaseArchitecture.resolve();
        directEvidenceSpy.mockRestore();
        sessionContextManager.remove('session-qoder-sdk-overlap');
      }
    });

    it('defers the Qoder SDK load until trace preflight settles when Task 9 is not admitted', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockResolvedValueOnce(undefined);
      const architectureStarted = createDeferred<void>();
      const releaseArchitecture = createDeferred<void>();
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({
        detect: jest.fn(async () => {
          architectureStarted.resolve();
          await releaseArchitecture.promise;
          return {type: 'pixel'};
        }),
      } as any);
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', result: '## Final Report\nfallback'},
      ]));
      const analysis = createRuntime().analyze(
        'summarize top-5 longest process slices',
        'session-qoder-sdk-serial',
        'trace-1',
      );
      try {
        await architectureStarted.promise;
        expect(mockEnsureSkillRegistryInitialized).toHaveBeenCalledTimes(1);
        expect(mockLoadQoderSdkModule).not.toHaveBeenCalled();

        releaseArchitecture.resolve();
        await expect(analysis).resolves.toMatchObject({success: true});
        expect(mockLoadQoderSdkModule).toHaveBeenCalledTimes(1);
      } finally {
        releaseArchitecture.resolve();
        directEvidenceSpy.mockRestore();
        sessionContextManager.remove('session-qoder-sdk-serial');
      }
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

    it('uses quick-evidence package state when the requested package is empty', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceAttempt',
      ).mockResolvedValueOnce({
        effectivePackageName: 'com.quick.effective',
        focusResult: {
          apps: [],
          method: 'frame_timeline',
        },
        evidenceCounts: {
          currentRunDataEnvelopes: 0,
          citedEvidenceRefs: 0,
        },
      } as any);
      const architectureDetect = jest.fn<any>().mockResolvedValue({ type: 'COMPOSE' });
      jest.mocked(createArchitectureDetector).mockReturnValueOnce({
        detect: architectureDetect,
      } as any);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
      ]));
      try {
        await createRuntime({
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task4',
        }).analyze(
          '滑动 FPS 是多少？',
          'session-qoder-empty-package',
          'trace-1',
          { packageName: '   ' },
        );

        expect(detectFocusApps).not.toHaveBeenCalled();
        expect(architectureDetect).toHaveBeenCalledWith(expect.objectContaining({
          packageName: 'com.quick.effective',
        }));
        expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(expect.objectContaining({
          packageName: 'com.quick.effective',
        }));
      } finally {
        directEvidenceSpy.mockRestore();
        sessionContextManager.remove('session-qoder-empty-package');
      }
    });
  });

  describe('SkillExecutor wiring', () => {
    it('calls createSkillExecutor with traceProcessorService directly and registers skills', async () => {
      const messages = [
        { type: 'result', subtype: 'success', result: 'done' },
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

  describe('MCP context passing', () => {
    it('passes full context in full mode', async () => {
      mockBuildComparisonContext.mockResolvedValueOnce({
        referenceTraceId: 'ref-trace',
        commonCapabilities: [],
      });
      const messages = [
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'full',
        referenceTraceId: 'ref-trace',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb-1'],
        knowledgeSourceIds: ['ks-1'],
        analysisContextFingerprint: 'fp-1',
      });

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
          analysisContextFingerprint: 'fp-1',
          comparisonContext: expect.objectContaining({ referenceTraceId: 'ref-trace' }),
        }),
      );
      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.systemPrompt).toContain('## 对比模式');
    });

    it('passes lightweight: true in quick mode without plan/hypotheses', async () => {
      const messages = [
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'fast',
      });

      expect(mockCreateClaudeMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          lightweight: true,
        }),
      );
      const callArgs = mockCreateClaudeMcpServer.mock.calls[0][0] as any;
      expect(callArgs.analysisPlan).toBeUndefined();
      expect(callArgs.hypotheses).toBeUndefined();
      expect(callArgs.uncertaintyFlags).toBeUndefined();
    });

    it('passes the active code-aware mode and selected codebases into the Qoder quick prompt', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        {type: 'result', subtype: 'success', result: 'done'},
      ]));

      await createRuntime().analyze('quick source lookup', 'session-1', 'trace-1', {
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: true,
        codeAwareMode: 'provider_send',
        codebaseIds: ['cb-qoder-quick'],
      });

      const callArgs = mockQuery.mock.calls[0][0] as any;
      expect(callArgs.options.systemPrompt).toContain('cb-qoder-quick');
      expect(callArgs.options.systemPrompt).toContain('provider_send');
      expect(callArgs.options.systemPrompt).toContain('源码使用决策契约');
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
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
      ]));

      await createRuntime().analyze('test query', 'session-1', 'trace-1', {
        traceContext: [{ label: 'dataset', columns: ['value'], rows: [[1]] }],
      } as any);

      expect(mockQuery.mock.calls[0][0]).toMatchObject({
        prompt: 'localized trace context\n\ntest query',
      });
    });

    it('returns success: true for success result', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: '## Final Report\nAnalysis complete' }] } },
        { type: 'result', subtype: 'success', result: '## Final Report\nAnalysis complete', num_turns: 5 },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const result = await runtime.analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(true);
      expect(result.rounds).toBe(5);
      expect(result.conclusion).toBe('## Final Report\nAnalysis complete');
    });

    it('blocks a successful SDK result while the real shared source accessor is pending', async () => {
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
          {type: 'result', subtype: 'success', result: '## Final Report\ndone'},
        ]));

        const result = await createRuntime().analyze('test', 'session-1', 'trace-1', {
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });

        expect(result).toMatchObject({
          success: false,
          partial: true,
          terminationReason: 'plan_incomplete',
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
          {type: 'result', subtype: 'success', result: SOURCE_FINALIZATION_RAW_SOURCE, num_turns: 1},
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
            {type: 'result', subtype: 'success', result: 'public second run'},
          ]));
        const runtime = createRuntime();

        const terminal = await runtime.analyze('source run', 'session-1', 'trace-1', {
          codeAwareMode: 'provider_send',
          codebaseIds: [fixture.codebaseId],
        });
        const next = await runtime.analyze('public run', 'session-1', 'trace-1', {
          codeAwareMode: 'off',
        });

        expect(terminal.success).toBe(true);
        expect(terminal.sourceUseDecision).toEqual(decision);
        expect(terminal.sourceReferences).toEqual(decision.references);
        expect(JSON.stringify(terminal)).not.toContain(SOURCE_FINALIZATION_CANARY);
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
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
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

    it('writes assistant chunks incrementally and sanitizes the complete final answer exactly once', async () => {
      const chunks = ['## Final', ' Report\nfirst ', 'second'];
      const finalText = chunks.join('');
      mockProjectionWrite.mockImplementation(text => `<${text}>`);
      mockProjectionFlush.mockReturnValue('<tail>');
      mockProjectionProjectComplete.mockImplementation(text => `SANITIZED:${text}`);
      mockQuery.mockReturnValue(createMockSdkStream([
        ...chunks.map(text => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        })),
        { type: 'result', subtype: 'success', result: finalText },
      ]));
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      const result = await runtime.analyze('test', 'session-qoder-linear-projection', 'trace-1');

      expect(mockProjectionWrite.mock.calls.map(call => call[0])).toEqual(chunks);
      expect(mockProjectionProjectComplete).toHaveBeenCalledTimes(1);
      expect(mockProjectionProjectComplete).toHaveBeenCalledWith(finalText);
      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(updates
        .filter(update => update.type === 'answer_token')
        .map(update => update.content)
        .join('')).toBe(chunks.map(text => `<${text}>`).join('') + '<tail>');
      expect(result.conclusion).toBe(`SANITIZED:${finalText}`);
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
      {
        label: 'opaque init and progress',
        lateMessage: {
          type: 'system',
          subtype: 'init',
          session_id: 'late-opaque-canary',
        },
      },
    ])('fences late $label from a timed-out iterator after same-session reuse', async ({ lateMessage }) => {
      const releaseLateIterator = createDeferred<void>();
      const oldClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const newClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const oldInterrupt = jest.fn<() => Promise<void>>()
        .mockRejectedValue(new Error('interrupt rejection is observed'));
      mockQuery
        .mockReturnValueOnce({
          async *[Symbol.asyncIterator]() {
            await releaseLateIterator.promise;
            yield lateMessage;
          },
          interrupt: oldInterrupt,
          close: oldClose,
        })
        .mockReturnValueOnce({
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', result: '## Final Report\nnew run' };
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

      releaseLateIterator.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(oldInterrupt).toHaveBeenCalledTimes(1);
      expect(oldClose).toHaveBeenCalledTimes(1);
      expect(newClose).toHaveBeenCalledTimes(1);
      expect(mockProjectionWrite).not.toHaveBeenCalledWith('late-answer-canary');
      expect(JSON.stringify(updates)).not.toContain('late-answer-canary');
      expect(runtime.getSdkSessionId('session-qoder-timeout-late-iterator')).toBeUndefined();
      expect(runtime.getSessionNotes('session-qoder-timeout-late-iterator')).toHaveLength(1);
    });

    it('discards the final projection tail for a successful private run', async () => {
      mockProjectionFlush.mockReturnValue('private-tail-canary');
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'safe partial' }] } },
        { type: 'result', subtype: 'success', result: '## Final Report\nprivate result' },
      ]));
      const updates: any[] = [];
      const runtime = createRuntime();
      runtime.on('update', update => updates.push(update));

      await expect(runtime.analyze('private', 'session-qoder-private-tail', 'trace-1', {
        knowledgeSourceIds: ['private-wiki'],
      })).resolves.toMatchObject({ success: true });

      expect(mockProjectionFlush).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(updates)).not.toContain('private-tail-canary');
      expect(runtime.getSdkSessionId('session-qoder-private-tail')).toBeUndefined();
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
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
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

    it('handles user cancellation via abortSession without throwing', async () => {
      const releaseStream = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
          await releaseStream.promise;
          yield { type: 'result', subtype: 'success', result: 'partial' };
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });

      const runtime = createRuntime();
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder();
      const attributionSink = createNoopAttributionSink(runtimePerformanceRecorder);
      const resultPromise = runtime.analyze('test', 'session-1', 'trace-1', {
        analysisMode: 'full',
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

    it('invalidates Qoder opaque state when cancelled after SDK init before provider completion', async () => {
      const initObserved = createDeferred<void>();
      const releaseStream = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-qoder-cancel-after-init' };
          initObserved.resolve();
          await releaseStream.promise;
          yield { type: 'result', subtype: 'success', result: '## Final Report\nlate result' };
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });

      const runtime = createRuntime();
      const analysis = runtime.analyze('test', 'session-qoder-init-cancel', 'trace-1', {
        analysisMode: 'full',
      });
      await initObserved.promise;
      await runtime.abortSession('session-qoder-init-cancel');
      releaseStream.resolve();
      await expect(analysis).resolves.toMatchObject({
        sessionId: 'session-qoder-init-cancel',
        success: false,
      });

      const snapshot = runtime.takeSnapshot('session-qoder-init-cancel', 'trace-1', {
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
      } as any);

      if (snapshot.engineState?.kind !== 'qoder-agent-sdk') {
        throw new Error('expected qoder snapshot engine state');
      }
      expect(snapshot.engineState.qoder.opaque).toEqual({
        version: 1,
        degradedReason: 'state_unavailable',
      });
    });

    it('invalidates Qoder opaque state before abortSession returns while the provider stream is unsettled', async () => {
      const initObserved = createDeferred<void>();
      const releaseStream = createDeferred<void>();
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-qoder-immediate-abort' };
          initObserved.resolve();
          await releaseStream.promise;
          yield { type: 'result', subtype: 'success', result: '## Final Report\nlate result' };
        },
        interrupt: mockInterrupt,
        close: mockClose,
      });

      const runtime = createRuntime();
      const analysis = runtime.analyze('test', 'session-qoder-immediate-abort', 'trace-1', {
        analysisMode: 'full',
      });
      await initObserved.promise;
      await runtime.abortSession('session-qoder-immediate-abort');

      const snapshot = runtime.takeSnapshot('session-qoder-immediate-abort', 'trace-1', {
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
      } as any);

      if (snapshot.engineState?.kind !== 'qoder-agent-sdk') {
        throw new Error('expected qoder snapshot engine state');
      }
      expect(snapshot.engineState.qoder.opaque).toEqual({
        version: 1,
        degradedReason: 'state_unavailable',
      });

      releaseStream.resolve();
      await expect(analysis).resolves.toMatchObject({
        sessionId: 'session-qoder-immediate-abort',
        success: false,
      });
    });
  });

  describe('session resume', () => {
    it('starts each analysis with a fresh plan while preserving bounded history', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: 'done' },
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

    it('captures session ID from system init message', async () => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      await runtime.analyze('test', 'session-1', 'trace-1');

      expect(runtime.getSdkSessionId('session-1')).toBe('sdk-session-abc');
    });

    it('passes resume on subsequent calls', async () => {
      const messages1 = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      const messages2 = [
        { type: 'result', subtype: 'success', result: 'done again' },
      ];
      mockQuery
        .mockReturnValueOnce(createMockSdkStream(messages1))
        .mockReturnValueOnce(createMockSdkStream(messages2));

      const runtime = createRuntime();
      await runtime.analyze('first', 'session-1', 'trace-1');
      await runtime.analyze('second', 'session-1', 'trace-1', { analysisMode: 'fast' });

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBe('sdk-session-abc');
      expect(secondCallArgs.options.systemPrompt).toBeUndefined();
      expect(mockBuildQuickConversationContext).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ query: 'first' })]),
        expect.any(String),
      );
    });

    it('resumes when code-aware mode is explicitly off', async () => {
      const messages1 = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      const messages2 = [
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery
        .mockReturnValueOnce(createMockSdkStream(messages1))
        .mockReturnValueOnce(createMockSdkStream(messages2));

      const runtime = createRuntime();
      await runtime.analyze('first', 'session-1', 'trace-1');
      await runtime.analyze('second', 'session-1', 'trace-1', { codeAwareMode: 'off' });

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBe('sdk-session-abc');
    });

    it.each([
      { codeAwareMode: 'metadata_only' as const, codebaseIds: ['private-codebase'] },
      { knowledgeSourceIds: ['private-wiki'] },
    ])('does not retain or resume SDK sessions for private knowledge: %p', async (privateOptions) => {
      mockQuery
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'system', subtype: 'init', session_id: 'private-sdk-session' },
          { type: 'result', subtype: 'success', result: 'done' },
        ]))
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'result', subtype: 'success', result: 'done again' },
        ]));

      const runtime = createRuntime();
      await runtime.analyze('private', 'session-1', 'trace-1', privateOptions);
      expect(runtime.getSdkSessionId('session-1')).toBeUndefined();

      await runtime.analyze('public', 'session-1', 'trace-1');
      const publicCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(publicCallArgs.options.resume).toBeUndefined();
    });

    it('discards an existing public opaque session before a private run', async () => {
      mockQuery
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'system', subtype: 'init', session_id: 'public-sdk-session' },
          { type: 'result', subtype: 'success', result: 'done' },
        ]))
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'system', subtype: 'init', session_id: 'private-sdk-session' },
          { type: 'result', subtype: 'success', result: 'private done' },
        ]))
        .mockReturnValueOnce(createMockSdkStream([
          { type: 'result', subtype: 'success', result: 'public again' },
        ]));

      const runtime = createRuntime();
      await runtime.analyze('public', 'session-qoder-private-discard', 'trace-1');
      expect(runtime.getSdkSessionId('session-qoder-private-discard')).toBe('public-sdk-session');

      await runtime.analyze('private', 'session-qoder-private-discard', 'trace-1', {
        knowledgeSourceIds: ['private-wiki'],
      });
      expect(runtime.getSdkSessionId('session-qoder-private-discard')).toBeUndefined();

      await runtime.analyze('public again', 'session-qoder-private-discard', 'trace-1');
      expect((mockQuery.mock.calls[2][0] as any).options.resume).toBeUndefined();
    });

    it('clears stale session on missing-conversation error', async () => {
      const messages1 = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-abc' },
        { type: 'result', subtype: 'success', result: 'done' },
      ];
      mockQuery
        .mockReturnValueOnce(createMockSdkStream(messages1))
        .mockImplementationOnce(() => {
          throw new Error('No conversation found with session ID sdk-session-abc');
        });

      const runtime = createRuntime();
      await runtime.analyze('first', 'session-1', 'trace-1');
      expect(runtime.getSdkSessionId('session-1')).toBe('sdk-session-abc');

      await runtime.analyze('second', 'session-1', 'trace-1');
      expect(runtime.getSdkSessionId('session-1')).toBeUndefined();
    });
  });

  describe('snapshot round-trip', () => {
    it('preserves session state through snapshot/restore', async () => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sdk-session-xyz' },
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

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

      const runtime2 = createRuntime();
      runtime2.restoreFromSnapshot('session-2', 'trace-1', snapshot);

      expect(runtime2.getSdkSessionId('session-2')).toBe('sdk-session-xyz');
    });

    it('does not persist opaque SDK or intermediate state for private knowledge', async () => {
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'system', subtype: 'init', session_id: 'private-sdk-session' },
        { type: 'result', subtype: 'success', result: '## Final Report\ndone' },
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
      expect(snapshot.engineState?.kind === 'qoder-agent-sdk' && snapshot.engineState.qoder.opaque).toBeUndefined();
      expect(snapshot.conversationSteps).toEqual([]);
      expect(snapshot.agentDialogue).toEqual([]);
      expect(snapshot.agentResponses).toEqual([]);
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
        { type: 'result', subtype: 'success', result: '## Final Report\nlate' },
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
