import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import type { SessionLogger } from '../../../services/sessionLogger';
import {
  AgentAnalyzeSessionService,
  AnalyzeSessionPreparationError,
  type AnalyzeManagedSession,
} from '../agentAnalyzeSessionService';
import { AssistantApplicationService } from '../assistantApplicationService';

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

describe('AgentAnalyzeSessionService session continuity', () => {
  let assistantAppService: AssistantApplicationService<AnalyzeManagedSession>;
  let sessionPersistenceService: any;
  let service: AgentAnalyzeSessionService<AnalyzeManagedSession>;

  beforeEach(() => {
    assistantAppService = new AssistantApplicationService<AnalyzeManagedSession>();
    sessionPersistenceService = {
      getSession: jest.fn().mockReturnValue(undefined),
      loadSessionContext: jest.fn().mockReturnValue(null),
      loadFocusStore: jest.fn().mockReturnValue(null),
      loadTraceAgentState: jest.fn().mockReturnValue(null),
    };

    service = new AgentAnalyzeSessionService<AnalyzeManagedSession>({
      assistantAppService,
      getModelRouter: () => ({} as any),
      createSessionLogger: () => createLogger(),
      sessionPersistenceService,
      sessionContextManager: { set: jest.fn() },
      buildRecoveredResultFromContext: () => null,
    });
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
});
