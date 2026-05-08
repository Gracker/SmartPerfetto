// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared persistence block used after each agent turn.
 *
 * Two call sites produce this pattern with identical semantics:
 *   - `routes/agentRoutes.ts:runAgentDrivenAnalysis` (HTTP path)
 *   - `cli-user/services/cliAnalyzeService.ts:persistTurnToBackend` (CLI path)
 *
 * Each one:
 *   1. Takes a unified snapshot from the orchestrator and
 *      stashes it on the session as `_lastSnapshot` so the report builder
 *      can read analysisNotes / analysisPlan / uncertaintyFlags.
 *   2. Writes the snapshot atomically via `saveSessionStateSnapshot`, or
 *      falls back to individual-field persistence if the
 *      orchestrator doesn't expose `takeSnapshot`.
 *   3. Appends the turn's user+assistant messages to the messages table
 *      so the web UI's history view renders them.
 *
 * Centralizing here closes the drift risk: any future schema change only
 * needs one update, and both call sites stay in sync automatically.
 */

import type { AnalyzeManagedSession } from '../assistant/application/agentAnalyzeSessionService';
import { SessionPersistenceService } from './sessionPersistenceService';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';

export interface PersistAgentTurnInput {
  session: AnalyzeManagedSession;
  sessionId: string;
  traceId: string;
  query: string;
  result: { conclusion: string; totalDurationMs: number };
  /** Optional structured logger (HTTP route provides SessionLogger; CLI
   *  currently doesn't wire one through — `console` fallback is fine). */
  logger?: {
    info: (component: string, message: string, data?: unknown) => void;
    warn: (component: string, message: string, data?: unknown) => void;
  };
  /** Log component name. HTTP route passes 'AgentDrivenAnalysis' to preserve
   *  existing log-based alerts keyed on that component; CLI defaults to
   *  logComponent so CLI-only log stream is self-identifying. */
  logComponent?: string;
}

export function persistAgentTurn(input: PersistAgentTurnInput): void {
  const { session, sessionId, traceId, query, result, logger } = input;
  const logComponent = input.logComponent ?? 'AgentPersistence';
  const persistenceService = SessionPersistenceService.getInstance();

  try {
    const sessionContext = sessionContextManager.get(sessionId, traceId);

    const snapshot = typeof session.orchestrator.takeSnapshot === 'function'
      ? session.orchestrator.takeSnapshot(sessionId, traceId, {
          conversationSteps: session.conversationSteps || [],
          queryHistory: session.queryHistory || [],
          conclusionHistory: session.conclusionHistory || [],
          agentDialogue: session.agentDialogue || [],
          agentResponses: session.agentResponses || [],
          dataEnvelopes: session.dataEnvelopes || [],
          hypotheses: session.hypotheses || [],
          agentRuntimeProviderId: session.providerId,
          runSequence: session.runSequence || 0,
          conversationOrdinal: session.conversationOrdinal || 0,
        })
      : null;

    // Stash snapshot EARLY — report builder reads `_lastSnapshot` for
    // analysisNotes / analysisPlan / uncertaintyFlags. Must happen before
    // any persistence I/O that could throw.
    if (snapshot) {
      (session as unknown as { _lastSnapshot: unknown })._lastSnapshot = snapshot;
    }

    if (snapshot && sessionContext) {
      const focusStoreSnapshot = typeof session.orchestrator.getFocusStore === 'function'
        ? session.orchestrator.getFocusStore().serialize()
        : undefined;
      const traceAgentState = sessionContext.getTraceAgentState() || undefined;

      const saved = persistenceService.saveSessionStateSnapshot(
        sessionId,
        snapshot,
        {
          sessionContext,
          focusStoreSnapshot,
          traceAgentState,
          owner: {
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
          },
        },
      );
      if (saved && logger) {
        logger.info(logComponent, 'Session state snapshot persisted atomically', {
          sessionId,
          steps: snapshot.conversationSteps.length,
          envelopes: snapshot.dataEnvelopes.length,
          notes: snapshot.analysisNotes.length,
          entityStoreStats: sessionContext.getEntityStore().getStats(),
        });
      }
    } else if (sessionContext) {
      // Individual-field fallback for runtimes or older sessions that do not
      // expose a unified snapshot. Current SDK runtimes should normally take
      // the atomic snapshot path above.
      if (!persistenceService.getSession(sessionId)) {
        persistenceService.saveSession({
          id: sessionId,
          traceId,
          traceName: traceId,
          question: query,
          messages: [],
          createdAt: session.createdAt,
          updatedAt: Date.now(),
          metadata: {
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
          },
        });
      }
      persistenceService.saveSessionContext(sessionId, sessionContext);
      if (typeof session.orchestrator.getCachedArchitecture === 'function') {
        const cachedArch = session.orchestrator.getCachedArchitecture(traceId);
        if (cachedArch) persistenceService.saveArchitectureSnapshot(sessionId, cachedArch);
      }
      if (typeof session.orchestrator.getFocusStore === 'function') {
        persistenceService.saveFocusStore(sessionId, session.orchestrator.getFocusStore());
      }
      const traceAgentState = sessionContext.getTraceAgentState();
      if (traceAgentState) persistenceService.saveTraceAgentState(sessionId, traceAgentState);
      persistenceService.saveRuntimeArrays(sessionId, {
        conversationSteps: session.conversationSteps || [],
        dataEnvelopes: session.dataEnvelopes || [],
        hypotheses: session.hypotheses || [],
        queryHistory: session.queryHistory || [],
        conclusionHistory: session.conclusionHistory || [],
      });
    }

    // Messages table is a separate SQLite table, always needed for the
    // web UI's history view — persist regardless of which branch above ran.
    if (sessionContext) {
      try {
        const turnIndex = session.runSequence || 1;
        persistenceService.appendMessages(sessionId, [
          {
            id: `msg-${sessionId}-turn${turnIndex}-user`,
            role: 'user',
            content: query,
            timestamp: Date.now() - (result.totalDurationMs || 0),
          },
          {
            id: `msg-${sessionId}-turn${turnIndex}-assistant`,
            role: 'assistant',
            content: (result.conclusion || '').substring(0, 10000),
            timestamp: Date.now(),
          },
        ]);
      } catch (msgErr) {
        logger?.warn(logComponent, 'Failed to persist turn messages', {
          error: (msgErr as Error).message,
        });
      }
    }
  } catch (err) {
    // Don't fail the analysis if persistence fails — just log. Preserving
    // the snapshot on the session (done above the try boundary) is more
    // important than the SQLite write succeeding.
    const message = (err as Error).message;
    if (logger) {
      logger.warn(logComponent, 'Failed to persist session state', { error: message });
    } else {
      console.warn(`[AgentPersistence] Failed to persist session ${sessionId} to SQLite: ${message}`);
    }
  }
}
