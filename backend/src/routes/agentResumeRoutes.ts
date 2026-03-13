import express from 'express';
import { createAgentRuntime } from '../agent';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { AnalyzeSessionRunContext } from '../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { isClaudeCodeEnabled, createClaudeRuntime } from '../agentv3';
import { createSessionLogger } from '../services/sessionLogger';
import { SessionPersistenceService } from '../services/sessionPersistenceService';

interface AssistantSessionStore {
  getSession(sessionId: string): any;
  setSession(sessionId: string, session: any): void;
}

interface AgentResumeRoutesDeps {
  sessionStore: AssistantSessionStore;
  buildSessionObservability: (session: any) => unknown;
  buildRecoveredResultFromContext: (sessionId: string, context: any) => any;
  buildTurnSummary: (turn: any) => unknown;
  getModelRouter: () => any;
}

export function registerAgentResumeRoutes(
  router: express.Router,
  deps: AgentResumeRoutesDeps
): void {
  router.post('/resume', async (req, res) => {
    const { sessionId, traceId } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    const existingSession = deps.sessionStore.getSession(sessionId);
    if (existingSession) {
      return res.json({
        success: true,
        sessionId,
        status: existingSession.status,
        message: 'Session already active',
        restored: false,
        observability: deps.buildSessionObservability(existingSession),
      });
    }

    try {
      const persistenceService = SessionPersistenceService.getInstance();

      if (!persistenceService.hasSessionContext(sessionId)) {
        return res.status(404).json({
          success: false,
          error: 'Session not found in persistence',
          hint: 'Session may have expired or was never persisted',
        });
      }

      const persistedSession = persistenceService.getSession(sessionId);
      if (!persistedSession) {
        return res.status(404).json({
          success: false,
          error: 'Session metadata not found',
        });
      }

      if (traceId && traceId !== persistedSession.traceId) {
        return res.status(400).json({
          success: false,
          error: 'traceId mismatch for resume',
          hint: `This session was created for traceId=${persistedSession.traceId}. Upload/choose that trace to resume.`,
          code: 'TRACE_ID_MISMATCH',
        });
      }

      const effectiveTraceId = persistedSession.traceId;
      const traceProcessorService = getTraceProcessorService();
      const trace = await traceProcessorService.getOrLoadTrace(effectiveTraceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: 'Trace not found in backend',
          hint: 'Please upload the trace before resuming the session',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      const restoredContext = persistenceService.loadSessionContext(sessionId);
      if (!restoredContext) {
        return res.status(500).json({
          success: false,
          error: 'Failed to deserialize session context',
        });
      }

      sessionContextManager.set(sessionId, effectiveTraceId, restoredContext);

      const orchestrator = isClaudeCodeEnabled()
        ? createClaudeRuntime(getTraceProcessorService()) as any
        : createAgentRuntime(deps.getModelRouter(), {
            enableLogging: true,
          });

      const focusSnapshot = persistenceService.loadFocusStore(sessionId);
      if (focusSnapshot && typeof orchestrator.getFocusStore === 'function') {
        orchestrator.getFocusStore().loadSnapshot(focusSnapshot);
        orchestrator.getFocusStore().syncWithEntityStore(restoredContext.getEntityStore());
      }

      const traceAgentStateSnapshot = persistenceService.loadTraceAgentState(sessionId);
      if (traceAgentStateSnapshot) {
        restoredContext.setTraceAgentState(traceAgentStateSnapshot);
      }

      const logger = createSessionLogger(sessionId);
      logger.setMetadata({
        traceId: effectiveTraceId,
        query: persistedSession.question,
        architecture: 'agent-driven',
        resumed: true,
      });
      logger.info('AgentRoutes', 'Session restored from persistence', {
        entityStoreStats: restoredContext.getEntityStore().getStats(),
        turnCount: restoredContext.getAllTurns().length,
      });

      const restoredTurns = restoredContext.getAllTurns();
      const latestTurn = restoredTurns.length > 0 ? restoredTurns[restoredTurns.length - 1] : null;
      const recoveredResult = deps.buildRecoveredResultFromContext(sessionId, restoredContext);
      const restoredRunSequence = Math.max(0, restoredTurns.length);
      const restoredRun: AnalyzeSessionRunContext | undefined = restoredRunSequence > 0
        ? {
            runId: `run-${sessionId}-${restoredRunSequence}-recovered`,
            requestId: `recovered-${sessionId}-${restoredRunSequence}`,
            sequence: restoredRunSequence,
            query: latestTurn?.query || persistedSession.question,
            startedAt: latestTurn?.timestamp || persistedSession.createdAt,
            completedAt: persistedSession.updatedAt,
            status: 'completed',
          }
        : undefined;

      // Unified snapshot restoration — all fields populated from single source
      const snapshot = persistenceService.loadSessionStateSnapshot(sessionId);

      // Restore ClaudeRuntime Maps (notes, plans, hypotheses, flags, artifacts, architecture, sdkSessionId)
      if (snapshot && typeof orchestrator.restoreFromSnapshot === 'function') {
        orchestrator.restoreFromSnapshot(sessionId, effectiveTraceId, snapshot);
        logger.info('AgentRoutes', 'ClaudeRuntime Maps restored from snapshot', {
          notes: snapshot.analysisNotes.length,
          hasPlan: !!snapshot.analysisPlan,
          hypotheses: snapshot.claudeHypotheses?.length || 0,
          flags: snapshot.uncertaintyFlags.length,
          artifacts: snapshot.artifacts?.length || 0,
        });
      } else if (typeof orchestrator.restoreArchitectureCache === 'function' && persistedSession.metadata?.architectureSnapshot) {
        // Fallback for agentv2 or when no snapshot available
        orchestrator.restoreArchitectureCache(effectiveTraceId, persistedSession.metadata.architectureSnapshot);
      }

      deps.sessionStore.setSession(sessionId, {
        orchestrator,
        sessionId,
        sseClients: [],
        result: recoveredResult || undefined,
        status: 'completed',
        traceId: effectiveTraceId,
        query: latestTurn?.query || persistedSession.question,
        createdAt: persistedSession.createdAt,
        lastActivityAt: Date.now(),
        logger,
        // All fields now restored from snapshot (previously agentDialogue/agentResponses were hardcoded to [])
        hypotheses: snapshot?.hypotheses || [],
        agentDialogue: snapshot?.agentDialogue || [],
        dataEnvelopes: snapshot?.dataEnvelopes || [],
        agentResponses: snapshot?.agentResponses || [],
        conversationOrdinal: snapshot?.conversationOrdinal || 0,
        conversationSteps: snapshot?.conversationSteps || [],
        queryHistory: snapshot?.queryHistory || [],
        conclusionHistory: snapshot?.conclusionHistory || [],
        runSequence: snapshot?.runSequence || restoredRunSequence,
        activeRun: restoredRun,
        lastRun: restoredRun,
        sseEventSeq: 0,
        sseEventBuffer: [],
      });

      return res.json({
        success: true,
        sessionId,
        traceId: effectiveTraceId,
        status: 'completed',
        message: 'Session restored from persistence',
        restored: true,
        observability: restoredRun
          ? {
              runId: restoredRun.runId,
              requestId: restoredRun.requestId,
              runSequence: restoredRun.sequence,
              status: restoredRun.status,
            }
          : undefined,
        historyEndpoints: {
          turns: `/api/agent/v1/${sessionId}/turns`,
          latestTurn: `/api/agent/v1/${sessionId}/turns/latest`,
        },
        restoredStats: {
          turnCount: restoredTurns.length,
          latestTurn: latestTurn ? deps.buildTurnSummary(latestTurn) : null,
          entityStore: restoredContext.getEntityStore().getStats(),
          focusStore: focusSnapshot ? orchestrator.getFocusStore().getStats() : null,
          traceAgentState: traceAgentStateSnapshot
            ? {
                version: traceAgentStateSnapshot.version,
                updatedAt: traceAgentStateSnapshot.updatedAt,
                turns: Array.isArray(traceAgentStateSnapshot.turnLog)
                  ? traceAgentStateSnapshot.turnLog.length
                  : 0,
                goal: traceAgentStateSnapshot.goal?.normalizedGoal ||
                  traceAgentStateSnapshot.goal?.userGoal ||
                  '',
              }
            : null,
        },
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Session restore failed:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to restore session',
      });
    }
  });
}
