// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { AnalyzeSessionRunContext } from '../assistant/application/agentAnalyzeSessionService';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { createAgentOrchestrator } from '../agentRuntime';
import { createSessionLogger } from '../services/sessionLogger';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { getProviderService, ProviderStoreUnreadableError } from '../services/providerManager';
import { resolveProviderRuntimeSnapshot } from '../services/providerManager/providerSnapshot';
import { requireRequestContext } from '../middleware/auth';
import { sendRouteError } from '../middleware/routeFailure';
import {
  isOwnedByContext,
  normalizeResourceOwner,
  sendResourceNotFound,
} from '../services/resourceOwnership';
import {
  getSnapshotRuntimeKind,
  getSnapshotRuntimeProviderId,
  continuityBreaksAfterRestore,
  getSnapshotRuntimeProviderSnapshotHash,
  snapshotProvesNoPrivateContext,
} from '../agentv3/sessionStateSnapshot';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';
import {registerSessionBackgroundKnowledgeReferences} from '../services/androidInternalsPack/sessionBackgroundKnowledgeRegistry';
import {projectStoredAnalysisResultForOwner} from '../services/security/privateAnalysisProjection';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import {
  requireAiEnabledForHttp,
  sendAiDisabledErrorIfPresent,
} from './aiCapabilityPolicyHttp';
import {
  decodePrivateContextJson,
  privateContextRestrictsAudience,
} from '../services/security/analysisPrivateContext';

interface AssistantSessionStore {
  getSession(sessionId: string): any;
  setSession(sessionId: string, session: any): void;
}

interface AgentResumeRoutesDeps {
  sessionStore: AssistantSessionStore;
  buildSessionObservability: (session: any) => unknown;
  buildRecoveredResultFromContext: (sessionId: string, context: any) => any;
  buildTurnSummary: (turn: any) => unknown;
}

function restoredSessionStatus(
  restoredRun: AnalyzeSessionRunContext | undefined,
  hasRecoveredResult: boolean,
): 'completed' | 'failed' | 'cancelled' | 'quota_exceeded' {
  if (restoredRun?.status === 'quota_exceeded') return 'quota_exceeded';
  if (restoredRun?.status === 'cancelled') return 'cancelled';
  if (restoredRun?.status === 'failed') return 'failed';
  if (
    restoredRun?.status === 'pending' ||
    restoredRun?.status === 'running'
  ) {
    return 'failed';
  }
  if (restoredRun?.status === 'completed' || hasRecoveredResult) return 'completed';
  return 'completed';
}

export function registerAgentResumeRoutes(
  router: express.Router,
  deps: AgentResumeRoutesDeps
): void {
  router.post('/resume', async (req, res) => {
    const requestContext = requireRequestContext(req);
    const { sessionId, traceId } = req.body || {};

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    if (!requireAiEnabledForHttp(res, 'agent_resume')) {
      return;
    }

    const existingSession = deps.sessionStore.getSession(sessionId);
    if (existingSession) {
      if (!isOwnedByContext(existingSession, requestContext)) {
        return sendResourceNotFound(res, 'Session not found');
      }
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
      // Runtime state comes back only from a session that proves it read no
      // private material; any other session starts over, as a missing one does.
      const snapshot = persistenceService.hasSessionContext(sessionId)
        ? persistenceService.loadSessionStateSnapshot(sessionId) : null;
      if (!snapshotProvesNoPrivateContext(snapshot)) {
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
      if (!isOwnedByContext(persistedSession.metadata, requestContext)) {
        return sendResourceNotFound(res, 'Session not found');
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
      if (!await readTraceMetadataForContext(effectiveTraceId, requestContext)) {
        return sendResourceNotFound(res, 'Trace not found in backend');
      }
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

      const providerSvc = getProviderService();
      const providerScope = {
        tenantId: requestContext.tenantId,
        workspaceId: requestContext.workspaceId,
        userId: requestContext.userId,
      };
      const snapshotRuntimeKind = getSnapshotRuntimeKind(snapshot);
      const snapshotProviderId = getSnapshotRuntimeProviderId(snapshot);
      const snapshotProviderHash = getSnapshotRuntimeProviderSnapshotHash(snapshot);
      const restoredProviderId = snapshot
        ? snapshotProviderId ?? null
        : providerSvc.getRawEffectiveProvider(providerScope)?.id ?? null;
      if (typeof snapshotProviderId === 'string' && !providerSvc.getRawProvider(snapshotProviderId, providerScope)) {
        return res.status(404).json({
          success: false,
          error: `Provider not found: ${snapshotProviderId}`,
          code: 'PROVIDER_NOT_FOUND',
          hint: 'This persisted session was created with a Provider Manager profile that no longer exists. Recreate the provider or start a new chat.',
        });
      }
      const {snapshotHash: restoredProviderSnapshotHash, snapshot: {runtimeKind: restoredRuntimeKind}} =
        resolveProviderRuntimeSnapshot(
          providerSvc,
          restoredProviderId,
          restoredProviderId ? undefined : snapshotRuntimeKind,
          providerScope,
        );
      const providerSnapshotChanged = Boolean(
        snapshotProviderHash &&
        snapshotProviderHash !== restoredProviderSnapshotHash,
      );
      // A provider change is recorded here, since the resumed session already
      // carries the new hash the next analysis sees.
      const continuityBreaks = continuityBreaksAfterRestore(
        snapshot?.continuityBreaks,
        providerSnapshotChanged ? snapshotProviderHash : undefined,
      );
      const orchestrator = createAgentOrchestrator({
        traceProcessorService: getTraceProcessorService(),
        providerId: restoredProviderId,
        runtimeOverride: restoredProviderId ? undefined : snapshotRuntimeKind,
        providerScope,
        aiFeature: 'agent_resume',
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
      if (providerSnapshotChanged) {
        logger.warn('AgentRoutes', 'Provider snapshot changed since the snapshot was saved; continuity break recorded', {
          providerId: restoredProviderId,
          previousProviderSnapshotHash: snapshotProviderHash,
          nextProviderSnapshotHash: restoredProviderSnapshotHash,
        });
      }

      const restoredTurns = restoredContext.getAllTurns();
      const latestTurn = restoredTurns.length > 0 ? restoredTurns[restoredTurns.length - 1] : null;
      const snapshotRun = snapshot?.lastRun ?? snapshot?.activeRun;
      // A run serialized before markers existed carries none: it is unknown.
      const snapshotRunPrivateContext = decodePrivateContextJson(snapshotRun?.privateContext);
      const storedFinal = snapshot?.finalResult;
      const storedFinalRunId = storedFinal?.completion?.runId ?? storedFinal?.analysisReceipt?.runId;
      const matchingStoredFinal = storedFinal?.sessionId === sessionId && snapshotRun?.runId &&
        (!storedFinalRunId || storedFinalRunId === snapshotRun.runId);
      const recoveredResult = matchingStoredFinal
        ? projectStoredAnalysisResultForOwner(privateContextRestrictsAudience(snapshotRunPrivateContext),
            sessionId, storedFinal!,
            snapshot?.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE))
        : deps.buildRecoveredResultFromContext(sessionId, restoredContext);
      const restoredRunSequence = Math.max(0, restoredTurns.length);
      const fallbackRestoredRun: AnalyzeSessionRunContext | undefined = restoredRunSequence > 0
        ? {
            runId: `run-${sessionId}-${restoredRunSequence}-recovered`,
            requestId: `recovered-${sessionId}-${restoredRunSequence}`,
            sequence: restoredRunSequence,
            query: latestTurn?.query || persistedSession.question,
            startedAt: latestTurn?.timestamp || persistedSession.createdAt,
            completedAt: persistedSession.updatedAt,
            status: 'completed',
            privateContext: 'unknown',
          }
        : undefined;
      const restoredRun = snapshotRun
        ? {...snapshotRun as AnalyzeSessionRunContext, privateContext: snapshotRunPrivateContext}
        : fallbackRestoredRun;
      const restoredStatus = restoredSessionStatus(restoredRun, Boolean(recoveredResult));
      const owner = normalizeResourceOwner(persistedSession.metadata);

      // Unified snapshot restoration — all fields populated from single source
      // Restore runtime maps (notes, plans, hypotheses, flags, artifacts, architecture).
      // They hold no provider-bound engine state, so a provider snapshot change restores them unchanged.
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
        // Compatibility path for older persisted sessions that predate unified snapshots.
        orchestrator.restoreArchitectureCache(effectiveTraceId, persistedSession.metadata.architectureSnapshot);
      }

      // As a restore through analysis does, once nothing can fail any more:
      // later snapshots read the session's knowledge references from this registry.
      registerSessionBackgroundKnowledgeReferences(sessionId, snapshot?.backgroundKnowledgeReferences ?? []);
      deps.sessionStore.setSession(sessionId, {
        orchestrator,
        sessionId,
        sseClients: [],
        result: recoveredResult || undefined,
        status: restoredStatus,
        error: restoredStatus === 'failed' && restoredRun?.status !== 'failed'
          ? 'Session was interrupted before completion and cannot be resumed as completed'
          : undefined,
        traceId: effectiveTraceId,
        tenantId: owner.tenantId,
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        providerId: restoredProviderId,
        runtimeKind: restoredRuntimeKind,
        providerSnapshotHash: restoredProviderSnapshotHash,
        providerSnapshotChanged: providerSnapshotChanged || undefined,
        providerSnapshotChangeReason: providerSnapshotChanged
          ? 'provider_snapshot_hash_mismatch'
          : undefined,
        // The next analysis compares its authorization with the one this
        // session ran under; without it every resumed session looked changed
        // and was replaced, losing its history.
        analysisContextFingerprint: snapshot?.analysisContextFingerprint,
        outputLanguage: snapshot?.outputLanguage,
        codeAwareMode: snapshot?.codeAwareMode,
        codebaseIds: snapshot?.codebaseIds,
        knowledgeSourceIds: snapshot?.knowledgeSourceIds,
        androidInternalsPackPin: snapshot?.androidInternalsPackPin,
        continuityBreaks: continuityBreaks.length > 0 ? continuityBreaks : undefined,
        lineage: snapshot?.lineage ?? persistedSession.metadata?.lineage,
        referenceTraceId: snapshot?.referenceTraceId,
        comparisonSource: snapshot?.comparisonSource,
        comparisonReportSection: snapshot?.comparisonReportSection,
        query: latestTurn?.query || persistedSession.question,
        createdAt: persistedSession.createdAt,
        lastActivityAt: Date.now(),
        logger,
        // All fields now restored from snapshot (previously agentDialogue/agentResponses were hardcoded to [])
        hypotheses: snapshot?.hypotheses || [],
        agentDialogue: snapshot?.agentDialogue || [],
        dataEnvelopes: snapshot?.dataEnvelopes || [],
        claimSupport: snapshot?.claimSupport,
        claimVerificationResult: snapshot?.claimVerificationResult,
        identityResolutions: snapshot?.identityResolutions,
        agentResponses: snapshot?.agentResponses || [],
        conversationOrdinal: snapshot?.conversationOrdinal || 0,
        conversationSteps: snapshot?.conversationSteps || [],
        queryHistory: snapshot?.queryHistory || [],
        conclusionHistory: snapshot?.conclusionHistory || [],
        runSequence: snapshot?.runSequence || restoredRunSequence,
        activeRun: (snapshot?.activeRun as AnalyzeSessionRunContext | undefined) || restoredRun,
        lastRun: (snapshot?.lastRun as AnalyzeSessionRunContext | undefined) || restoredRun,
        sseEventSeq: 0,
        sseEventBuffer: [],
      });

      return res.json({
        success: true,
        sessionId,
        traceId: effectiveTraceId,
        status: restoredStatus,
        message: providerSnapshotChanged
          ? 'Session restored from persistence with a fresh SDK runtime because provider configuration changed'
          : 'Session restored from persistence',
        restored: true,
        providerSnapshotChanged: providerSnapshotChanged || undefined,
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
          focusStore: focusSnapshot && typeof orchestrator.getFocusStore === 'function'
            ? orchestrator.getFocusStore().getStats()
            : null,
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
    } catch (error: unknown) {
      if (sendAiDisabledErrorIfPresent(res, error)) {
        return;
      }
      // providers.json unreadable: the active or pinned provider is unknown.
      sendRouteError(res, error, {
        code: 'session_restore_failed',
        error: 'Failed to restore session',
        logLabel: '[AgentRoutes] Session restore failed',
      }, [ProviderStoreUnreadableError]);
    }
  });
}
