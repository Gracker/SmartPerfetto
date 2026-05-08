// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { requireRequestContext } from '../middleware/auth';
import { isOwnedByContext } from '../services/resourceOwnership';

interface SessionStoreLike<TSession> {
  entries(): IterableIterator<[string, TSession]>;
}

interface SessionLike {
  status: string;
  traceId: string;
  query: string;
  createdAt: number;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

interface AgentSessionCatalogRoutesDeps<TSession extends SessionLike> {
  sessionStore: SessionStoreLike<TSession>;
  buildSessionObservability: (session: TSession) => unknown;
}

export function registerAgentSessionCatalogRoutes<TSession extends SessionLike>(
  router: express.Router,
  deps: AgentSessionCatalogRoutesDeps<TSession>
): void {
  router.get('/sessions', async (req, res) => {
    try {
      const requestContext = requireRequestContext(req);
      const { traceId, limit, includeRecoverable } = req.query;
      const parsedLimit = limit ? parseInt(limit as string, 10) : 20;
      const shouldIncludeRecoverable = includeRecoverable !== 'false';

      const activeSessions: any[] = [];
      const activeIds = new Set<string>();

      for (const [sessionId, session] of deps.sessionStore.entries()) {
        if (traceId && session.traceId !== traceId) continue;
        if (!isOwnedByContext(session, requestContext)) continue;

        const activeContext = sessionContextManager.get(sessionId, session.traceId);
        activeIds.add(sessionId);
        activeSessions.push({
          sessionId,
          status: session.status,
          traceId: session.traceId,
          query: session.query,
          createdAt: session.createdAt,
          isActive: true,
          turnCount: activeContext?.getAllTurns().length ?? 0,
          entityStoreStats: null,
          observability: deps.buildSessionObservability(session),
        });
      }

      const recoverableSessions: any[] = [];
      if (shouldIncludeRecoverable) {
        try {
          const persistenceService = SessionPersistenceService.getInstance();
          const persistedResult = persistenceService.listSessions({
            traceId: traceId as string | undefined,
            limit: parsedLimit,
          });

          for (const persistedSession of persistedResult.sessions) {
            if (activeIds.has(persistedSession.id)) continue;
            if (!persistenceService.hasSessionContext(persistedSession.id)) continue;
            if (!isOwnedByContext(persistedSession.metadata, requestContext)) continue;

            const storeStats = persistenceService.getEntityStoreStats(persistedSession.id);
            const persistedContext = persistenceService.loadSessionContext(persistedSession.id);

            recoverableSessions.push({
              sessionId: persistedSession.id,
              status: 'recoverable',
              traceId: persistedSession.traceId,
              traceName: persistedSession.traceName,
              query: persistedSession.question,
              createdAt: persistedSession.createdAt,
              updatedAt: persistedSession.updatedAt,
              isActive: false,
              turnCount: persistedContext?.getAllTurns().length ?? 0,
              entityStoreStats: storeStats,
            });
          }
        } catch (persistError: any) {
          console.warn('[AgentRoutes] Failed to list recoverable sessions:', persistError.message);
        }
      }

      return res.json({
        success: true,
        activeSessions,
        totalActive: activeSessions.length,
        recoverableSessions,
        totalRecoverable: recoverableSessions.length,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });
}
