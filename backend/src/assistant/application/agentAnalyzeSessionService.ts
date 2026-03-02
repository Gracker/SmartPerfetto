import {
  type AgentRuntime,
  type AgentRuntimeAnalysisResult,
  createAgentRuntime,
  type Hypothesis,
  type ModelRouter,
  type StreamingUpdate,
} from '../../agent';
import { isClaudeCodeEnabled, createClaudeRuntime } from '../../agentv3';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import {
  type EnhancedSessionContext,
} from '../../agent/context/enhancedSessionContext';
import { type SessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {
  AssistantApplicationService,
  type ManagedAssistantSession,
} from './assistantApplicationService';

export interface AnalyzeSessionConversationStep {
  eventId: string;
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp: number;
  sourceEventType?: string;
}

export interface AnalyzeSessionAgentDialogueItem {
  agentId: string;
  type: 'task' | 'response' | 'question';
  content: any;
  timestamp: number;
}

export interface AnalyzeSessionAgentResponseItem {
  taskId: string;
  agentId: string;
  response: any;
  timestamp: number;
}

export interface AnalyzeSessionRunContext {
  runId: string;
  requestId: string;
  sequence: number;
  query: string;
  startedAt: number;
  completedAt?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

export interface AnalyzeManagedSession extends ManagedAssistantSession {
  orchestrator: AgentRuntime;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  traceId: string;
  query: string;
  logger: SessionLogger;
  result?: AgentRuntimeAnalysisResult;
  hypotheses: Hypothesis[];
  agentDialogue: AnalyzeSessionAgentDialogueItem[];
  dataEnvelopes: any[];
  agentResponses: AnalyzeSessionAgentResponseItem[];
  conversationOrdinal: number;
  conversationSteps: AnalyzeSessionConversationStep[];
  runSequence?: number;
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
}

interface SessionContextManagerLike {
  set(sessionId: string, traceId: string, context: EnhancedSessionContext): void;
}

interface AgentAnalyzeSessionServiceDeps<TSession extends AnalyzeManagedSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  getModelRouter: () => ModelRouter;
  createSessionLogger: (sessionId: string) => SessionLogger;
  sessionPersistenceService: SessionPersistenceService;
  sessionContextManager: SessionContextManagerLike;
  buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;
}

interface PrepareAnalyzeSessionInput {
  traceId: string;
  query: string;
  requestedSessionId?: string;
  options?: any;
}

export interface PrepareAnalyzeSessionResult<TSession extends AnalyzeManagedSession> {
  sessionId: string;
  session: TSession;
  isNewSession: boolean;
}

export class AnalyzeSessionPreparationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly hint?: string;

  constructor(message: string, options: { code: string; httpStatus: number; hint?: string }) {
    super(message);
    this.name = 'AnalyzeSessionPreparationError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.hint = options.hint;
  }
}

export class AgentAnalyzeSessionService<TSession extends AnalyzeManagedSession> {
  private readonly assistantAppService: AssistantApplicationService<TSession>;
  private readonly getModelRouter: () => ModelRouter;
  private readonly createSessionLogger: (sessionId: string) => SessionLogger;
  private readonly sessionPersistenceService: SessionPersistenceService;
  private readonly sessionContextManager: SessionContextManagerLike;
  private readonly buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;

  constructor(deps: AgentAnalyzeSessionServiceDeps<TSession>) {
    this.assistantAppService = deps.assistantAppService;
    this.getModelRouter = deps.getModelRouter;
    this.createSessionLogger = deps.createSessionLogger;
    this.sessionPersistenceService = deps.sessionPersistenceService;
    this.sessionContextManager = deps.sessionContextManager;
    this.buildRecoveredResultFromContext = deps.buildRecoveredResultFromContext;
  }

  prepareSession(input: PrepareAnalyzeSessionInput): PrepareAnalyzeSessionResult<TSession> {
    const { traceId, query, requestedSessionId, options = {} } = input;

    if (requestedSessionId) {
      const existingSession = this.assistantAppService.getSession(requestedSessionId);
      if (existingSession && existingSession.traceId === traceId) {
        existingSession.runSequence = Number.isFinite(existingSession.runSequence)
          ? Math.max(0, Math.floor(existingSession.runSequence as number))
          : 0;
        existingSession.logger.info('AgentRoutes', 'Continuing multi-turn dialogue', {
          turnQuery: query,
          previousQuery: existingSession.query,
        });
        existingSession.query = query;
        existingSession.status = 'pending';
        existingSession.lastActivityAt = Date.now();
        console.log(`[AgentRoutes] Reusing agent session ${requestedSessionId} for multi-turn dialogue`);
        return {
          sessionId: requestedSessionId,
          session: existingSession,
          isNewSession: false,
        };
      }

      const persistedSession = this.sessionPersistenceService.getSession(requestedSessionId);
      if (persistedSession && persistedSession.traceId !== traceId) {
        throw new AnalyzeSessionPreparationError('traceId mismatch for requested session', {
          code: 'TRACE_ID_MISMATCH',
          httpStatus: 400,
          hint: `This session belongs to traceId=${persistedSession.traceId}. Switch to that trace or start a new chat.`,
        });
      }

      if (persistedSession && persistedSession.traceId === traceId) {
        const restoredContext = this.sessionPersistenceService.loadSessionContext(requestedSessionId);
        if (restoredContext) {
          this.sessionContextManager.set(requestedSessionId, traceId, restoredContext);

          const restoredOrchestrator = isClaudeCodeEnabled()
            ? createClaudeRuntime(getTraceProcessorService()) as unknown as AgentRuntime
            : createAgentRuntime(this.getModelRouter(), {
                enableLogging: true,
              });

          const focusSnapshot = this.sessionPersistenceService.loadFocusStore(requestedSessionId);
          if (focusSnapshot) {
            restoredOrchestrator.getFocusStore().loadSnapshot(focusSnapshot);
            restoredOrchestrator.getFocusStore().syncWithEntityStore(restoredContext.getEntityStore());
          }

          const traceAgentStateSnapshot =
            this.sessionPersistenceService.loadTraceAgentState(requestedSessionId);
          if (traceAgentStateSnapshot) {
            restoredContext.setTraceAgentState(traceAgentStateSnapshot);
          }

          const restoredTurns = restoredContext.getAllTurns();
          const latestTurn = restoredTurns.length > 0 ? restoredTurns[restoredTurns.length - 1] : null;
          const recoveredResult = this.buildRecoveredResultFromContext(
            requestedSessionId,
            restoredContext
          );
          const restoredSequence = Math.max(0, restoredTurns.length);
          const restoredRun = restoredSequence > 0
            ? {
                runId: `run-${requestedSessionId}-${restoredSequence}-recovered`,
                requestId: `recovered-${requestedSessionId}-${restoredSequence}`,
                sequence: restoredSequence,
                query: latestTurn?.query || persistedSession.question,
                startedAt: latestTurn?.timestamp || persistedSession.createdAt,
                completedAt: persistedSession.updatedAt,
                status: 'completed' as const,
              }
            : undefined;

          const restoredLogger = this.createSessionLogger(requestedSessionId);
          restoredLogger.setMetadata({
            traceId,
            query,
            architecture: 'agent-driven',
            resumed: true,
          });
          restoredLogger.info('AgentRoutes', 'Session restored from persistence in analyze()', {
            turnCount: restoredTurns.length,
            entityStoreStats: restoredContext.getEntityStore().getStats(),
          });

          const restoredSession = {
            orchestrator: restoredOrchestrator,
            sessionId: requestedSessionId,
            sseClients: [],
            result: recoveredResult || undefined,
            status: 'pending',
            traceId,
            query,
            createdAt: persistedSession.createdAt,
            lastActivityAt: Date.now(),
            logger: restoredLogger,
            hypotheses: [],
            agentDialogue: [],
            dataEnvelopes: [],
            agentResponses: [],
            conversationOrdinal: 0,
            conversationSteps: [],
            runSequence: restoredSequence,
            activeRun: restoredRun,
            lastRun: restoredRun,
          } as unknown as TSession;

          this.assistantAppService.setSession(requestedSessionId, restoredSession);
          restoredLogger.info('AgentRoutes', 'Continuing multi-turn dialogue from persisted context', {
            turnQuery: query,
            previousQuery: latestTurn?.query || persistedSession.question,
            turnCount: restoredTurns.length,
          });
          console.log(
            `[AgentRoutes] Restored agent session ${requestedSessionId} from persistence for multi-turn dialogue`
          );

          return {
            sessionId: requestedSessionId,
            session: restoredSession,
            isNewSession: false,
          };
        }

        console.log(
          `[AgentRoutes] Requested session ${requestedSessionId} has no persisted context, creating new session`
        );
      } else {
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found, creating new session`);
      }
    }

    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const orchestrator = isClaudeCodeEnabled()
      ? createClaudeRuntime(getTraceProcessorService()) as unknown as AgentRuntime
      : createAgentRuntime(this.getModelRouter(), {
          maxRounds: options.maxRounds ?? options.maxIterations ?? 5,
          maxConcurrentTasks: options.maxConcurrentTasks || 3,
          taskTimeoutMs: options.taskTimeoutMs,
          confidenceThreshold: options.confidenceThreshold ?? options.qualityThreshold ?? 0.7,
          maxNoProgressRounds: options.maxNoProgressRounds ?? 2,
          maxFailureRounds: options.maxFailureRounds ?? 2,
          enableLogging: true,
        });

    const logger = this.createSessionLogger(sessionId);
    logger.setMetadata({ traceId, query, architecture: 'agent-driven' });
    logger.info('AgentRoutes', 'Agent-driven analysis session created', { options });

    const session = {
      orchestrator,
      sessionId,
      sseClients: [],
      status: 'pending',
      traceId,
      query,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      logger,
      hypotheses: [],
      agentDialogue: [],
      dataEnvelopes: [],
      agentResponses: [],
      conversationOrdinal: 0,
      conversationSteps: [],
      runSequence: 0,
    } as unknown as TSession;

    this.assistantAppService.setSession(sessionId, session);

    return {
      sessionId,
      session,
      isNewSession: true,
    };
  }
}
