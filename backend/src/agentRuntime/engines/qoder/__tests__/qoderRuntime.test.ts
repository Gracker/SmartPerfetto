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
}));

jest.mock('../../../../agentv3/claudeFindingExtractor', () => ({
  extractFindingsFromText: jest.fn<any>().mockReturnValue([]),
}));

jest.mock('../../../runtimePromptContext', () => ({
  buildRuntimeTracePairComparisonContext: jest.fn<any>().mockResolvedValue(undefined),
}));

import { QoderRuntime } from '../qoderRuntime';
import { createSkillExecutor } from '../../../../services/skillEngine/skillExecutor';

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
      });
      await runtime.analyze('test', 'session-1', 'trace-1');

      const callArgs = mockQuery.mock.calls[0][0] as any;
      const sdkEnv = callArgs.options.env;
      expect(sdkEnv.SECRET_API_KEY).toBeUndefined();
      expect(sdkEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(sdkEnv.DATABASE_URL).toBeUndefined();
      expect(sdkEnv.QODER_PERSONAL_ACCESS_TOKEN).toBe('test-token');
      expect(sdkEnv.QODER_MODEL).toBe('test-model');
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
        }),
      );
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
      expect(result.terminationMessage).toContain('Authentication failed');
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
      await runtime.analyze('second', 'session-1', 'trace-1');

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBe('sdk-session-abc');
      expect(secondCallArgs.options.systemPrompt).toBeUndefined();
    });

    it('does not resume in code-aware mode', async () => {
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
      await runtime.analyze('second', 'session-1', 'trace-1', { codeAwareMode: 'metadata_only' } as any);

      const secondCallArgs = mockQuery.mock.calls[1][0] as any;
      expect(secondCallArgs.options.resume).toBeUndefined();
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
  });
});
