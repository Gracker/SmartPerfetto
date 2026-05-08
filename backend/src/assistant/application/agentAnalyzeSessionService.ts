// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  type AgentRuntimeAnalysisResult,
  type Hypothesis,
  type IOrchestrator,
  type StreamingUpdate,
} from '../../agent';
import { createAgentOrchestrator } from '../../agentRuntime';
import { getProviderService } from '../../services/providerManager';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import {
  type EnhancedSessionContext,
  sessionContextManager as defaultSessionContextManager,
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
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  traceId: string;
  query: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  /** Provider Manager profile used for this SDK session. null means env/default fallback is pinned. */
  providerId?: string | null;
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
  /** Cross-turn query history — appended on each turn, never overwritten */
  queryHistory?: Array<{ turn: number; query: string; timestamp: number }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory?: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }>;
}

interface SessionContextManagerLike {
  set(sessionId: string, traceId: string, context: EnhancedSessionContext): void;
}

interface AgentAnalyzeSessionServiceDeps<TSession extends AnalyzeManagedSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  createSessionLogger: (sessionId: string) => SessionLogger;
  sessionPersistenceService: SessionPersistenceService;
  /** Defaults to the module-level `sessionContextManager` singleton. Callers
   *  (HTTP route, CLI) no longer need to import it just to satisfy the deps. */
  sessionContextManager?: SessionContextManagerLike;
  buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;
}

interface PrepareAnalyzeSessionInput {
  traceId: string;
  query: string;
  requestedSessionId?: string;
  providerId?: string | null;
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
  private readonly createSessionLogger: (sessionId: string) => SessionLogger;
  private readonly sessionPersistenceService: SessionPersistenceService;
  private readonly sessionContextManager: SessionContextManagerLike;
  private readonly buildRecoveredResultFromContext: (
    sessionId: string,
    context: EnhancedSessionContext
  ) => AgentRuntimeAnalysisResult | null;

  constructor(deps: AgentAnalyzeSessionServiceDeps<TSession>) {
    this.assistantAppService = deps.assistantAppService;
    this.createSessionLogger = deps.createSessionLogger;
    this.sessionPersistenceService = deps.sessionPersistenceService;
    this.sessionContextManager = deps.sessionContextManager ?? defaultSessionContextManager;
    this.buildRecoveredResultFromContext = deps.buildRecoveredResultFromContext;
  }

  prepareSession(input: PrepareAnalyzeSessionInput): PrepareAnalyzeSessionResult<TSession> {
    const { traceId, query, requestedSessionId, options = {} } = input;
    const explicitProviderId = input.providerId !== undefined
      ? input.providerId
      : options.providerId as string | null | undefined;
    const providerSvc = getProviderService();

    if (typeof explicitProviderId === 'string' && !providerSvc.getRawProvider(explicitProviderId)) {
      throw new AnalyzeSessionPreparationError(`Provider not found: ${explicitProviderId}`, {
        code: 'PROVIDER_NOT_FOUND',
        httpStatus: 404,
      });
    }

    const activeProviderId = explicitProviderId !== undefined
      ? undefined
      : providerSvc.getRawEffectiveProvider()?.id;
    const sessionProviderId = explicitProviderId !== undefined
      ? explicitProviderId
      : activeProviderId ?? null;

    if (requestedSessionId) {
      const existingSession = this.assistantAppService.getSession(requestedSessionId);
      const liveSessionProviderMismatch = Boolean(
        existingSession &&
        existingSession.traceId === traceId &&
        explicitProviderId !== undefined &&
        (existingSession.providerId ?? null) !== explicitProviderId,
      );
      if (existingSession && existingSession.traceId === traceId) {
        if (liveSessionProviderMismatch) {
          existingSession.logger.info('AgentRoutes', 'Provider changed; starting a new SDK session', {
            previousProviderId: existingSession.providerId,
            nextProviderId: sessionProviderId,
          });
          console.log(`[AgentRoutes] Provider changed for ${requestedSessionId}, creating a new agent session`);
        } else {
          existingSession.providerId ??= null;
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
      }

      const persistedSession = liveSessionProviderMismatch
        ? null
        : this.sessionPersistenceService.getSession(requestedSessionId);
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

          const stateSnapshot =
            this.sessionPersistenceService.loadSessionStateSnapshot(requestedSessionId);
          const snapshotProviderId = stateSnapshot?.agentRuntimeProviderId;
          const restoredProviderId = explicitProviderId !== undefined
            ? explicitProviderId
            : stateSnapshot
              ? snapshotProviderId ?? null
              : sessionProviderId;
          const snapshotProviderMismatch = Boolean(
            explicitProviderId !== undefined &&
            stateSnapshot &&
            snapshotProviderId !== explicitProviderId,
          );
          if (!snapshotProviderMismatch && typeof snapshotProviderId === 'string' && !providerSvc.getRawProvider(snapshotProviderId)) {
            throw new AnalyzeSessionPreparationError(`Provider not found: ${snapshotProviderId}`, {
              code: 'PROVIDER_NOT_FOUND',
              httpStatus: 404,
              hint: 'This persisted session was created with a Provider Manager profile that no longer exists. Recreate the provider or start a new chat.',
            });
          }

          if (snapshotProviderMismatch) {
            console.log(
              `[AgentRoutes] Provider override changed for ${requestedSessionId}, creating a new agent session`
            );
          } else {
            const restoredOrchestrator: IOrchestrator = createAgentOrchestrator({
              traceProcessorService: getTraceProcessorService(),
              providerId: restoredProviderId,
              runtimeOverride: restoredProviderId ? undefined : stateSnapshot?.agentRuntimeKind,
            });

            const focusSnapshot = this.sessionPersistenceService.loadFocusStore(requestedSessionId);
            if (focusSnapshot && typeof restoredOrchestrator.getFocusStore === 'function') {
              restoredOrchestrator.getFocusStore().loadSnapshot(focusSnapshot);
              restoredOrchestrator.getFocusStore().syncWithEntityStore(restoredContext.getEntityStore());
            }

            // P0-2: Restore cached architecture to prevent re-detection failure after trace unload
            const archSnapshot = this.sessionPersistenceService.loadArchitectureSnapshot(requestedSessionId);
            if (archSnapshot && typeof restoredOrchestrator.restoreArchitectureCache === 'function') {
              restoredOrchestrator.restoreArchitectureCache(traceId, archSnapshot);
            }

            const traceAgentStateSnapshot =
              this.sessionPersistenceService.loadTraceAgentState(requestedSessionId);
            if (traceAgentStateSnapshot) {
              restoredContext.setTraceAgentState(traceAgentStateSnapshot);
            }

            // Restore SDK runtime internal maps/state from the unified snapshot.
            // Mirrors the explicit /resume endpoint so both paths recover the
            // full agent state, not just SessionContext.
            if (stateSnapshot && typeof restoredOrchestrator.restoreFromSnapshot === 'function') {
              restoredOrchestrator.restoreFromSnapshot(requestedSessionId, traceId, stateSnapshot);
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

            // Reconstruct query/conclusion history from persisted turns
            const restoredQueryHistory: Array<{ turn: number; query: string; timestamp: number }> = [];
            const restoredConclusionHistory: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }> = [];
            for (let i = 0; i < restoredTurns.length; i++) {
              const t = restoredTurns[i];
              if (t.query) {
                restoredQueryHistory.push({ turn: i + 1, query: t.query, timestamp: t.timestamp || persistedSession.createdAt });
              }
              if (t.result && typeof (t.result as any).conclusion === 'string') {
                restoredConclusionHistory.push({
                  turn: i + 1,
                  conclusion: (t.result as any).conclusion,
                  confidence: (t.result as any).confidence ?? 0,
                  timestamp: t.timestamp || persistedSession.createdAt,
                });
              }
            }

            // R4: Restore runtime arrays from SQLite for cross-restart report continuity
            const runtimeArrays = this.sessionPersistenceService.loadRuntimeArrays(requestedSessionId);

            // Source priority for session arrays: snapshot (newer unified format)
            // > runtimeArrays (legacy fallback) > reconstructed from turns.
            // agentDialogue + agentResponses live only in the snapshot — prior
            // code hardcoded them to [], which is what Codex flagged as lost state.
            const restoredSession = {
              orchestrator: restoredOrchestrator,
              sessionId: requestedSessionId,
              sseClients: [],
              result: recoveredResult || undefined,
              status: 'pending',
              traceId,
              query,
              tenantId: persistedSession.metadata?.tenantId,
              workspaceId: persistedSession.metadata?.workspaceId,
              userId: persistedSession.metadata?.userId,
              providerId: restoredProviderId,
              createdAt: persistedSession.createdAt,
              lastActivityAt: Date.now(),
              logger: restoredLogger,
              hypotheses: stateSnapshot?.hypotheses || runtimeArrays?.hypotheses || [],
              agentDialogue: stateSnapshot?.agentDialogue || [],
              dataEnvelopes: stateSnapshot?.dataEnvelopes || runtimeArrays?.dataEnvelopes || [],
              agentResponses: stateSnapshot?.agentResponses || [],
              conversationOrdinal: stateSnapshot?.conversationOrdinal || 0,
              conversationSteps:
                stateSnapshot?.conversationSteps || runtimeArrays?.conversationSteps || [],
              runSequence: stateSnapshot?.runSequence || restoredSequence,
              activeRun: restoredRun,
              lastRun: restoredRun,
              queryHistory:
                stateSnapshot?.queryHistory || runtimeArrays?.queryHistory || restoredQueryHistory,
              conclusionHistory:
                stateSnapshot?.conclusionHistory
                || runtimeArrays?.conclusionHistory
                || restoredConclusionHistory,
              sseEventSeq: 0,
              sseEventBuffer: [],
            } as unknown as TSession;

            this.assistantAppService.setSession(requestedSessionId, restoredSession);
            restoredLogger.info('AgentRoutes', 'Continuing multi-turn dialogue from persisted context', {
              turnQuery: query,
              previousQuery: latestTurn?.query || persistedSession.question,
              turnCount: restoredTurns.length,
              runtimeArraysRestored: !!runtimeArrays,
              restoredSteps: runtimeArrays?.conversationSteps?.length || 0,
              restoredEnvelopes: runtimeArrays?.dataEnvelopes?.length || 0,
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
        }

        console.log(
          `[AgentRoutes] Requested session ${requestedSessionId} has no persisted context, creating new session`
        );
      } else {
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found, creating new session`);
      }
    }

    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const orchestrator: IOrchestrator = createAgentOrchestrator({
      traceProcessorService: getTraceProcessorService(),
      providerId: sessionProviderId,
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
      providerId: sessionProviderId,
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
      queryHistory: [],
      conclusionHistory: [],
      sseEventSeq: 0,
      sseEventBuffer: [],
    } as unknown as TSession;

    this.assistantAppService.setSession(sessionId, session);

    return {
      sessionId,
      session,
      isNewSession: true,
    };
  }
}
