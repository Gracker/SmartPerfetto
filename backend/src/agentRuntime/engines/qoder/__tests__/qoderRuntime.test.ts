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

const mockSdkModule = {
  query: mockQuery,
  qodercliAuth: jest.fn().mockReturnValue({ type: 'qodercli' }),
  accessTokenFromEnv: jest.fn().mockReturnValue({ type: 'accessToken' }),
  createSdkMcpServer: jest.fn(),
  AbortError: class AbortError extends Error { name = 'AbortError'; },
};

const mockRegisterSkills = jest.fn();
const mockSetFragmentRegistry = jest.fn();
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
  loadQoderSdkModule: jest.fn<any>().mockResolvedValue(mockSdkModule),
}));

jest.mock('../../../../services/skillEngine/skillExecutor', () => ({
  createSkillExecutor: jest.fn<any>().mockReturnValue({
    registerSkills: mockRegisterSkills,
    setFragmentRegistry: mockSetFragmentRegistry,
    executeSkill: jest.fn(),
  }),
}));

jest.mock('../../../../services/skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: jest.fn<any>().mockResolvedValue(undefined),
  skillRegistry: {
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

jest.mock('../../../../agentv3/focusAppDetector', () => ({
  detectFocusApps: jest.fn<any>().mockResolvedValue({ apps: [], method: 'none' }),
}));

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

jest.mock('../../../../services/security/codeAwareOutputRegistry', () => ({
  sanitizeCodeAwareText: jest.fn<any>().mockImplementation((_sid: string, text: string) => text),
  createCodeAwareStreamingTextProjection: jest.fn<any>().mockImplementation(() => ({
    write: mockProjectionWrite,
    flush: mockProjectionFlush,
    projectComplete: mockProjectionProjectComplete,
  })),
}));

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

function createRuntime(env: Record<string, string | undefined> = {}) {
  return new QoderRuntime({
    env: {
      QODER_PERSONAL_ACCESS_TOKEN: 'test-token',
      ...env,
    },
    selection: { kind: 'qoder-agent-sdk', source: 'env' },
    traceProcessorService: { query: jest.fn() },
  } as any);
}

describe('QoderRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      await runtime.analyze('test', 'session-1', 'trace-1');

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
        'buildRuntimeQuickEvidenceDirectAnswer',
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

    it('falls back to the normal Qoder path when deterministic evidence is unavailable', async () => {
      const directEvidenceSpy = jest.spyOn(
        quickEvidenceDirectAnswer,
        'buildRuntimeQuickEvidenceDirectAnswer',
      ).mockResolvedValueOnce(undefined);
      mockQuery.mockReturnValue(createMockSdkStream([
        { type: 'result', subtype: 'success', result: '## Final Report\nfallback' },
      ]));
      try {
        const result = await createRuntime().analyze(
          'summarize top-5 longest process slices',
          'session-1',
          'trace-1',
        );

        expect(createArchitectureDetector).toHaveBeenCalled();
        expect(createSkillExecutor).toHaveBeenCalled();
        expect(mockCreateClaudeMcpServer).toHaveBeenCalled();
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result.conclusion).toBe('## Final Report\nfallback');
      } finally {
        directEvidenceSpy.mockRestore();
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
      const result = await runtime.analyze('test', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe('execution_error');
      expect(result.terminationMessage).toContain('Unauthorized: invalid access token');
    });

    it('handles user cancellation via abortSession without throwing', async () => {
      const messages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
        { type: 'result', subtype: 'success', result: 'partial' },
      ];
      mockQuery.mockReturnValue(createMockSdkStream(messages));

      const runtime = createRuntime();
      const resultPromise = runtime.analyze('test', 'session-1', 'trace-1');
      await runtime.abortSession('session-1');
      const result = await resultPromise;

      // Regardless of timing, the result should be returned without throwing
      expect(result).toBeDefined();
      expect(result.sessionId).toBe('session-1');
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
});
