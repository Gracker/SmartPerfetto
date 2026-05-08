// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, test, beforeEach, jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import type { SessionLogger } from '../../../services/sessionLogger';
import { resetProviderService } from '../../../services/providerManager';
import { resolveProviderRuntimeSnapshot } from '../../../services/providerManager/providerSnapshot';
import {
  AgentAnalyzeSessionService,
  AnalyzeSessionPreparationError,
  type AnalyzeManagedSession,
} from '../agentAnalyzeSessionService';
import { AssistantApplicationService } from '../assistantApplicationService';
import { getProviderService } from '../../../services/providerManager';

const mockCreateAgentOrchestrator = jest.fn((_input: unknown) => ({
  analyze: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
  cleanupSession: jest.fn(),
  restoreFromSnapshot: jest.fn(),
}));

jest.mock('../../../agentRuntime', () => ({
  createAgentOrchestrator: (input: unknown) => mockCreateAgentOrchestrator(input),
}));

function createLogger(): SessionLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setMetadata: jest.fn(),
    getLogFilePath: jest.fn().mockReturnValue(''),
    close: jest.fn(),
  } as unknown as SessionLogger;
}

function createSession(sessionId: string, traceId: string): AnalyzeManagedSession {
  return {
    sessionId,
    status: 'running',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    sseClients: [],
    orchestrator: {} as any,
    traceId,
    query: 'old query',
    logger: createLogger(),
    hypotheses: [],
    agentDialogue: [],
    dataEnvelopes: [],
    agentResponses: [],
    conversationOrdinal: 0,
    conversationSteps: [],
    runSequence: 0,
  };
}

function providerSnapshotHash(providerId: string | null): string {
  return resolveProviderRuntimeSnapshot(getProviderService(), providerId).snapshotHash;
}

function createRestoredContext() {
  return {
    getAllTurns: jest.fn().mockReturnValue([]),
    getEntityStore: jest.fn().mockReturnValue({
      getStats: jest.fn().mockReturnValue({ entities: 0 }),
    }),
    setTraceAgentState: jest.fn(),
  };
}

describe('AgentAnalyzeSessionService session continuity', () => {
  let assistantAppService: AssistantApplicationService<AnalyzeManagedSession>;
  let sessionPersistenceService: any;
  let service: AgentAnalyzeSessionService<AnalyzeManagedSession>;

  beforeEach(() => {
    process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(
      os.tmpdir(),
      `analyze-session-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    resetProviderService();
    assistantAppService = new AssistantApplicationService<AnalyzeManagedSession>();
    sessionPersistenceService = {
      getSession: jest.fn().mockReturnValue(undefined),
      loadSessionContext: jest.fn().mockReturnValue(null),
      loadSessionStateSnapshot: jest.fn().mockReturnValue(null),
      loadFocusStore: jest.fn().mockReturnValue(null),
      loadTraceAgentState: jest.fn().mockReturnValue(null),
      loadArchitectureSnapshot: jest.fn().mockReturnValue(null),
      loadRuntimeArrays: jest.fn().mockReturnValue(null),
    };
    mockCreateAgentOrchestrator.mockClear();

    service = new AgentAnalyzeSessionService<AnalyzeManagedSession>({
      assistantAppService,
      createSessionLogger: () => createLogger(),
      sessionPersistenceService,
      sessionContextManager: { set: jest.fn() },
      buildRecoveredResultFromContext: () => null,
    });
  });

  afterEach(() => {
    delete process.env.PROVIDER_DATA_DIR_OVERRIDE;
    resetProviderService();
  });

  test('reuses existing in-memory session for same trace', () => {
    const existing = createSession('agent-session-1', 'trace-1');
    assistantAppService.setSession(existing.sessionId, existing);

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new follow-up question',
      requestedSessionId: existing.sessionId,
      options: {},
    });

    expect(prepared.isNewSession).toBe(false);
    expect(prepared.sessionId).toBe(existing.sessionId);
    expect(prepared.session).toBe(existing);
    expect(prepared.session.query).toBe('new follow-up question');
    expect(prepared.session.status).toBe('pending');
  });

  test('throws TRACE_ID_MISMATCH when requested persisted session belongs to another trace', () => {
    sessionPersistenceService.getSession.mockReturnValue({
      id: 'persisted-1',
      traceId: 'trace-other',
      question: 'q',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });

    try {
      service.prepareSession({
        traceId: 'trace-expected',
        query: 'follow-up',
        requestedSessionId: 'persisted-1',
        options: {},
      });
      throw new Error('expected prepareSession to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyzeSessionPreparationError);
      const prepError = error as AnalyzeSessionPreparationError;
      expect(prepError.code).toBe('TRACE_ID_MISMATCH');
      expect(prepError.httpStatus).toBe(400);
    }
  });

  test('throws PROVIDER_NOT_FOUND when explicit providerId is invalid', () => {
    try {
      service.prepareSession({
        traceId: 'trace-expected',
        query: 'new analysis',
        providerId: 'missing-provider',
        options: {},
      });
      throw new Error('expected prepareSession to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyzeSessionPreparationError);
      const prepError = error as AnalyzeSessionPreparationError;
      expect(prepError.code).toBe('PROVIDER_NOT_FOUND');
      expect(prepError.httpStatus).toBe(404);
    }
  });

  test('pins a new session to the active provider profile', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    getProviderService().activate(provider.id);

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new analysis',
      options: {},
    });

    expect(prepared.isNewSession).toBe(true);
    expect(prepared.session.providerId).toBe(provider.id);
    expect(prepared.session.providerSnapshotHash).toBe(providerSnapshotHash(provider.id));
    expect(mockCreateAgentOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: provider.id }),
    );
  });

  test('pins a new session to env fallback when no provider is active', () => {
    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new analysis',
      options: {},
    });

    expect(prepared.isNewSession).toBe(true);
    expect(prepared.session.providerId).toBeNull();
    expect(prepared.session.providerSnapshotHash).toBe(providerSnapshotHash(null));
    expect(mockCreateAgentOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: null }),
    );
  });

  test('refreshes an in-memory SDK session when the pinned provider snapshot changed', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.example.test/v1',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    const originalHash = providerSnapshotHash(provider.id);
    const oldOrchestrator = {
      analyze: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      cleanupSession: jest.fn(),
    };
    const existing = createSession('agent-session-1', 'trace-1');
    existing.orchestrator = oldOrchestrator as any;
    existing.providerId = provider.id;
    existing.providerSnapshotHash = originalHash;
    existing.conversationSteps.push({
      eventId: 'evt-1',
      ordinal: 1,
      phase: 'progress',
      role: 'agent',
      text: 'previous context',
      timestamp: Date.now(),
    });
    assistantAppService.setSession(existing.sessionId, existing);

    getProviderService().update(provider.id, {
      models: { primary: 'gpt-provider-model-v2' },
    });
    const nextHash = providerSnapshotHash(provider.id);

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new follow-up question',
      requestedSessionId: existing.sessionId,
      options: {},
    });

    expect(nextHash).not.toBe(originalHash);
    expect(prepared.isNewSession).toBe(false);
    expect(prepared.sessionId).toBe(existing.sessionId);
    expect(prepared.session.orchestrator).not.toBe(oldOrchestrator);
    expect(prepared.session.providerId).toBe(provider.id);
    expect(prepared.session.providerSnapshotHash).toBe(nextHash);
    expect(prepared.session.providerSnapshotChanged).toBe(true);
    expect(prepared.session.conversationSteps).toHaveLength(1);
    expect(oldOrchestrator.cleanupSession).toHaveBeenCalledWith(existing.sessionId);
  });

  test('reuses an in-memory session with its pinned provider when active provider changed elsewhere', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    getProviderService().activate(provider.id);

    const existing = createSession('agent-session-1', 'trace-1');
    existing.providerId = 'old-provider';
    assistantAppService.setSession(existing.sessionId, existing);

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new follow-up question',
      requestedSessionId: existing.sessionId,
      options: {},
    });

    expect(prepared.isNewSession).toBe(false);
    expect(prepared.sessionId).toBe(existing.sessionId);
    expect(prepared.session.providerId).toBe('old-provider');
  });

  test('starts a new session when an explicit provider override differs from the live session', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-provider-openai',
      },
    });

    const existing = createSession('agent-session-1', 'trace-1');
    existing.providerId = null;
    assistantAppService.setSession(existing.sessionId, existing);

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'new follow-up question',
      requestedSessionId: existing.sessionId,
      providerId: provider.id,
      options: {},
    });

    expect(prepared.isNewSession).toBe(true);
    expect(prepared.sessionId).not.toBe(existing.sessionId);
    expect(prepared.session.providerId).toBe(provider.id);
  });

  test('throws PROVIDER_NOT_FOUND when a persisted snapshot provider was deleted', () => {
    sessionPersistenceService.getSession.mockReturnValue({
      id: 'persisted-1',
      traceId: 'trace-1',
      question: 'q',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
      },
      messages: [],
    });
    sessionPersistenceService.loadSessionContext.mockReturnValue({} as any);
    sessionPersistenceService.loadSessionStateSnapshot.mockReturnValue({
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'persisted-1',
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
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: 'deleted-provider',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    try {
      service.prepareSession({
        traceId: 'trace-1',
        query: 'follow-up',
        requestedSessionId: 'persisted-1',
        options: {},
      });
      throw new Error('expected prepareSession to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyzeSessionPreparationError);
      const prepError = error as AnalyzeSessionPreparationError;
      expect(prepError.code).toBe('PROVIDER_NOT_FOUND');
      expect(prepError.httpStatus).toBe(404);
    }
  });

  test('keeps persisted conversation context but skips SDK snapshot restore when provider hash changed', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.example.test/v1',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    const originalHash = providerSnapshotHash(provider.id);
    getProviderService().update(provider.id, {
      connection: { openaiBaseUrl: 'https://api.changed.example.test/v1' },
    });
    const nextHash = providerSnapshotHash(provider.id);

    sessionPersistenceService.getSession.mockReturnValue({
      id: 'persisted-1',
      traceId: 'trace-1',
      question: 'q',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
      },
      messages: [],
    });
    sessionPersistenceService.loadSessionContext.mockReturnValue(createRestoredContext());
    sessionPersistenceService.loadSessionStateSnapshot.mockReturnValue({
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'persisted-1',
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
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: provider.id,
      agentRuntimeProviderSnapshotHash: originalHash,
      sdkSessionId: 'sdk-response-old',
      openAILastResponseId: 'sdk-response-old',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'follow-up',
      requestedSessionId: 'persisted-1',
      options: {},
    });

    const restoredOrchestrator = mockCreateAgentOrchestrator.mock.results[0]?.value as any;
    expect(nextHash).not.toBe(originalHash);
    expect(prepared.isNewSession).toBe(false);
    expect(prepared.sessionId).toBe('persisted-1');
    expect(prepared.session.providerId).toBe(provider.id);
    expect(prepared.session.providerSnapshotHash).toBe(nextHash);
    expect(prepared.session.providerSnapshotChanged).toBe(true);
    expect(prepared.session.tenantId).toBe('tenant-a');
    expect(restoredOrchestrator.restoreFromSnapshot).not.toHaveBeenCalled();
  });

  test('restores a persisted env-fallback session without reading the active provider', () => {
    const provider = getProviderService().create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    getProviderService().activate(provider.id);

    sessionPersistenceService.getSession.mockReturnValue({
      id: 'persisted-1',
      traceId: 'trace-1',
      question: 'q',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
      },
      messages: [],
    });
    sessionPersistenceService.loadSessionContext.mockReturnValue(createRestoredContext());
    sessionPersistenceService.loadSessionStateSnapshot.mockReturnValue({
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId: 'persisted-1',
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
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: null,
      runSequence: 0,
      conversationOrdinal: 0,
    });

    const prepared = service.prepareSession({
      traceId: 'trace-1',
      query: 'follow-up',
      requestedSessionId: 'persisted-1',
      options: {},
    });

    expect(prepared.isNewSession).toBe(false);
    expect(prepared.session.providerId).toBeNull();
    expect(prepared.session.tenantId).toBe('tenant-a');
    expect(prepared.session.workspaceId).toBe('workspace-a');
    expect(prepared.session.userId).toBe('user-a');
    expect(mockCreateAgentOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: null,
        runtimeOverride: 'openai-agents-sdk',
      }),
    );
  });
});
