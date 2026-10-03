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
import { getProviderService, ProviderStoreUnreadableError } from '../../services/providerManager';
import { resolveProviderRuntimeSnapshot } from '../../services/providerManager/providerSnapshot';
import type { AgentRuntimeKind, ProviderScope } from '../../services/providerManager';
import { getTraceProcessorService } from '../../services/traceProcessorService';
import {
  getSnapshotRuntimeKind,
  snapshotProvesNoPrivateContext,
  getSnapshotRuntimeProviderId,
  getSnapshotRuntimeProviderSnapshotHash,
  type ProviderContinuityBreak,
  type SessionLineage,
  type ComparisonReportSection,
  type ComparisonSourceKind,
  continuityBreaksAfterRestore,
} from '../../agentv3/sessionStateSnapshot';
import {
  type EnhancedSessionContext,
  sessionContextManager as defaultSessionContextManager,
} from '../../agent/context/enhancedSessionContext';
import type { ClaimSupportV1 } from '../../types/evidenceContract';
import type { ClaimVerificationResult } from '../../types/claimVerification';
import type { IdentityResolutionV1 } from '../../types/identityContract';
import { type SessionLogger } from '../../services/sessionLogger';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {parseOutputLanguage, type OutputLanguage} from '../../agentv3/outputLanguage';
import {
  privateAnalysisQueryMessage,
} from '../../services/security/privateAnalysisProjection';
import {
  AssistantApplicationService,
  type ManagedAssistantSession,
} from './assistantApplicationService';
import {
  registerSessionBackgroundKnowledgeReferences,
} from '../../services/androidInternalsPack/sessionBackgroundKnowledgeRegistry';
import type {AnalysisSourceActivation} from '../../services/codebase/analysisSourceActivationPolicy';
import {
  analysisHasPrivateContext,
  privateContextRestrictsAudience,
  resolveAnalysisPrivateContext,
  type AnalysisPrivateContextMarker,
} from '../../services/security/analysisPrivateContext';
import type {AnalysisContextSelection} from '../../services/resolvedAnalysisContext';

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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded';
  error?: string;
  /**
   * Fixed at admission from the selection this run was authorized with. The
   * session's selection moves on with the next run; artifacts of this run do not.
   * A run restored without a recorded marker is 'unknown'.
   */
  privateContext: AnalysisPrivateContextMarker;
}

type SessionRunsWithSelection = AnalysisContextSelection & {
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
  runRegistry?: Record<string, AnalyzeSessionRunContext>;
};

/**
 * The private-context marker of one of a session's runs, fixed when the run
 * was admitted. Without a run id, the latest run. A named run that is not
 * found is unknown, which restricts; a session with no run yet is described
 * by its current selection.
 */
export function sessionRunPrivateContext(
  session: SessionRunsWithSelection,
  runId?: string,
): AnalysisPrivateContextMarker {
  const run = runId === undefined
    ? session.activeRun ?? session.lastRun
    : [session.activeRun, session.lastRun].find(candidate => candidate?.runId === runId) ??
      session.runRegistry?.[runId];
  if (run) return run.privateContext;
  return runId === undefined ? resolveAnalysisPrivateContext(session) : 'unknown';
}

export function sessionRunHasPrivateContext(session: SessionRunsWithSelection, runId?: string): boolean {
  return privateContextRestrictsAudience(sessionRunPrivateContext(session, runId));
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
  /** SDK runtime pinned together with the provider snapshot for this session. */
  runtimeKind?: AgentRuntimeKind;
  /** Presentation language pinned for the lifetime of this runtime conversation. */
  outputLanguage?: OutputLanguage;
  /** Non-secret ProviderSnapshot hash used to decide whether SDK session state can be reused. */
  providerSnapshotHash?: string | null;
  providerSnapshotChanged?: boolean;
  providerSnapshotChangeReason?: string;
  /** Authorization partition for source/RAG-aware runtime continuity. */
  analysisContextFingerprint?: string;
  androidInternalsPackPin?: import('../../services/androidInternalsPack/types').AndroidInternalsPackIdentity;
  codeAwareMode?: import('../../services/codebase/codeAwareFeature').CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  sourceAuthorization?: {
    codeAwareMode: Exclude<import('../../services/codebase/codeAwareFeature').CodeAwareMode, 'off'>;
    codebaseIds: string[];
    analysisContextFingerprint: string;
  };
  sourceActivation?: AnalysisSourceActivation;
  /** Runtime-only replacement for `query` (source-activation reset, private-query scrub); see resolveAgentQuery. */
  agentQuery?: string;
  /** Append-only audit of provider snapshot changes observed when this session was restored. */
  continuityBreaks?: ProviderContinuityBreak[];
  /** Backend-session ancestry when a user-visible session bridged to a fresh backend session. */
  lineage?: SessionLineage;
  /** Reference trace ID for raw dual-trace comparison sessions. */
  referenceTraceId?: string;
  /** Comparison source model used by this session. */
  comparisonSource?: ComparisonSourceKind;
  /** Shared deterministic comparison section for report generation. */
  comparisonReportSection?: ComparisonReportSection;
  traceSummary?: import('../../types/traceSummaryAttribution').TraceSummaryAttributionV1;
  logger: SessionLogger;
  result?: AgentRuntimeAnalysisResult;
  hypotheses: Hypothesis[];
  agentDialogue: AnalyzeSessionAgentDialogueItem[];
  dataEnvelopes: any[];
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
  agentResponses: AnalyzeSessionAgentResponseItem[];
  conversationOrdinal: number;
  conversationSteps: AnalyzeSessionConversationStep[];
  runSequence?: number;
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
  /** Cross-turn query history — appended on each turn, never overwritten */
  queryHistory?: Array<{
    turn: number;
    query: string;
    timestamp: number;
    sourceDerived?: boolean;
  }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory?: Array<{
    turn: number;
    conclusion: string;
    confidence: number;
    timestamp: number;
    sourceDerived?: boolean;
  }>;
}

interface SessionContextManagerLike {
  set(sessionId: string, traceId: string, context: EnhancedSessionContext): void;
  remove(sessionId: string, traceId?: string): void;
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
  /** Clears request-scoped privacy guards when provider/source authorization changes. */
  onSessionSecurityCleanup?: (sessionId: string) => void;
}

interface PrepareAnalyzeSessionInput {
  traceId: string;
  query: string;
  requestedSessionId?: string;
  referenceTraceId?: string;
  providerId?: string | null;
  providerScope?: ProviderScope;
  options?: any;
  analysisContextFingerprint?: string;
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

function normalizeReferenceTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function comparisonSourceForReference(referenceTraceId?: string): ComparisonSourceKind | undefined {
  return referenceTraceId ? 'raw_trace_pair' : undefined;
}

/** The text a runtime receives for this turn: the prepared replacement when it belongs to this query. */
export function resolveAgentQuery(session: {query?: string; agentQuery?: string}, query: string): string {
  return session.agentQuery && session.query === query ? session.agentQuery : query;
}

function readPersistedReferenceTraceId(
  stateSnapshot: { referenceTraceId?: string } | null | undefined,
  metadata: { referenceTraceId?: unknown } | undefined,
): string | undefined {
  return normalizeReferenceTraceId(stateSnapshot?.referenceTraceId)
    ?? normalizeReferenceTraceId(metadata?.referenceTraceId);
}

function assertReferenceTraceCompatible(input: {
  requestedSessionId: string;
  existingReferenceTraceId?: string;
  requestedReferenceTraceId?: string;
}): void {
  const existingReferenceTraceId = normalizeReferenceTraceId(input.existingReferenceTraceId);
  const requestedReferenceTraceId = normalizeReferenceTraceId(input.requestedReferenceTraceId);

  if (existingReferenceTraceId && requestedReferenceTraceId && existingReferenceTraceId !== requestedReferenceTraceId) {
    throw new AnalyzeSessionPreparationError('referenceTraceId mismatch for requested session', {
      code: 'REFERENCE_TRACE_ID_MISMATCH',
      httpStatus: 400,
      hint: `This comparison session uses referenceTraceId=${existingReferenceTraceId}. Start a new chat to compare against a different reference trace.`,
    });
  }

  if (!existingReferenceTraceId && requestedReferenceTraceId) {
    throw new AnalyzeSessionPreparationError('referenceTraceId mismatch for requested session', {
      code: 'REFERENCE_TRACE_ID_MISMATCH',
      httpStatus: 400,
      hint: 'This session was created for single-trace analysis. Start a new chat to run raw trace comparison.',
    });
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
  private readonly onSessionSecurityCleanup?: (sessionId: string) => void;

  constructor(deps: AgentAnalyzeSessionServiceDeps<TSession>) {
    this.assistantAppService = deps.assistantAppService;
    this.createSessionLogger = deps.createSessionLogger;
    this.sessionPersistenceService = deps.sessionPersistenceService;
    this.sessionContextManager = deps.sessionContextManager ?? defaultSessionContextManager;
    this.buildRecoveredResultFromContext = deps.buildRecoveredResultFromContext;
    this.onSessionSecurityCleanup = deps.onSessionSecurityCleanup;
  }

  private revokeLiveSession(session: TSession, reason: string): void {
    this.onSessionSecurityCleanup?.(session.sessionId);
    if (session.orchestratorUpdateHandler) {
      session.orchestrator.off('update', session.orchestratorUpdateHandler);
      session.orchestratorUpdateHandler = undefined;
    }
    if (typeof session.orchestrator.abortSession === 'function') {
      void Promise.resolve(
        session.orchestrator.abortSession(session.sessionId, session.referenceTraceId),
      ).catch((error) => {
        session.logger.warn('AgentRoutes', 'Failed to abort revoked SDK session', {
          sessionId: session.sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (typeof session.orchestrator.cleanupSession === 'function') {
      void Promise.resolve(session.orchestrator.cleanupSession(session.sessionId))
        .catch((error) => {
          session.logger.warn('AgentRoutes', 'Failed to clean up revoked SDK session', {
            sessionId: session.sessionId,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    this.sessionContextManager.remove(session.sessionId);
    this.assistantAppService.deleteSession(session.sessionId);
  }

  prepareSession(input: PrepareAnalyzeSessionInput): PrepareAnalyzeSessionResult<TSession> {
    try {
      return this.prepareSessionUnchecked(input);
    } catch (error) {
      // providers.json unreadable: the provider this session would use is
      // unknown. Every provider read precedes the step it decides (a pin is
      // read before its live session could be revoked), so nothing changed.
      if (!(error instanceof ProviderStoreUnreadableError)) throw error;
      throw new AnalyzeSessionPreparationError(error.message, {
        code: error.code,
        httpStatus: error.status,
        hint: 'Repair or move providers.json, then retry; or select the system default (env) provider explicitly.',
      });
    }
  }

  private prepareSessionUnchecked(input: PrepareAnalyzeSessionInput): PrepareAnalyzeSessionResult<TSession> {
    const { traceId, query, requestedSessionId, options = {} } = input;
    const defaultOutputLanguage = parseOutputLanguage(
      process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
    );
    const explicitOutputLanguage = options.outputLanguage === 'en' ||
      options.outputLanguage === 'zh-CN'
      ? options.outputLanguage as OutputLanguage
      : undefined;
    let requestedOutputLanguage = explicitOutputLanguage ?? defaultOutputLanguage;
    const requestedPrivateKnowledge = analysisHasPrivateContext(options);
    let privateQuery = privateAnalysisQueryMessage(requestedOutputLanguage);
    const providerScope = input.providerScope;
    const requestedReferenceTraceId = normalizeReferenceTraceId(input.referenceTraceId ?? options.referenceTraceId);
    let inheritedReferenceTraceId: string | undefined;
    const explicitProviderId = input.providerId !== undefined
      ? input.providerId
      : options.providerId as string | null | undefined;
    const providerSvc = getProviderService();

    if (typeof explicitProviderId === 'string' && !providerSvc.getRawProvider(explicitProviderId, providerScope)) {
      throw new AnalyzeSessionPreparationError(`Provider not found: ${explicitProviderId}`, {
        code: 'PROVIDER_NOT_FOUND',
        httpStatus: 404,
      });
    }

    const resolveProviderSnapshotHash = (
      providerId: string | null,
      runtimeOverride?: AgentRuntimeKind,
    ) => resolveProviderRuntimeSnapshot(providerSvc, providerId, runtimeOverride, providerScope).snapshotHash;
    // The pin a session takes when it does not keep one it already has: the
    // explicit provider, else the active one. Resolved on first use, so a turn
    // that keeps its live or persisted pin never reads the active provider,
    // which is refused while providers.json is unreadable.
    let sessionProviderPin: {providerId: string | null; snapshotHash: string} | undefined;
    const resolveSessionProviderPin = () => {
      if (!sessionProviderPin) {
        const providerId = explicitProviderId !== undefined
          ? explicitProviderId
          : providerSvc.getRawEffectiveProvider(providerScope)?.id ?? null;
        sessionProviderPin = {providerId, snapshotHash: resolveProviderSnapshotHash(providerId)};
      }
      return sessionProviderPin;
    };

    if (requestedSessionId) {
      const locatedSession = this.assistantAppService.getSession(requestedSessionId);
      const persistedContinuitySnapshot = this.sessionPersistenceService
        .loadSessionStateSnapshot(requestedSessionId);
      if (!explicitOutputLanguage) {
        requestedOutputLanguage = locatedSession?.outputLanguage
          ?? persistedContinuitySnapshot?.outputLanguage
          ?? defaultOutputLanguage;
        privateQuery = privateAnalysisQueryMessage(requestedOutputLanguage);
      }
      const liveOutputLanguageMismatch = Boolean(
        locatedSession &&
        locatedSession.traceId === traceId &&
        (locatedSession.outputLanguage ?? defaultOutputLanguage) !== requestedOutputLanguage,
      );
      const liveAnalysisContextMismatch = Boolean(
        locatedSession &&
        locatedSession.traceId === traceId &&
        input.analysisContextFingerprint &&
        locatedSession.analysisContextFingerprint !== input.analysisContextFingerprint,
      );
      if ((liveAnalysisContextMismatch || liveOutputLanguageMismatch) && locatedSession) {
        this.revokeLiveSession(
          locatedSession,
          liveOutputLanguageMismatch
            ? 'output_language_mismatch'
            : 'analysis_context_fingerprint_mismatch',
        );
      }
      const existingSession = liveAnalysisContextMismatch || liveOutputLanguageMismatch
        ? undefined
        : locatedSession;
      // The live session this request continues, if it is for the same trace.
      const liveSession = existingSession && existingSession.traceId === traceId ? existingSession : undefined;
      if (liveSession) {
        assertReferenceTraceCompatible({
          requestedSessionId,
          existingReferenceTraceId: liveSession.referenceTraceId,
          requestedReferenceTraceId,
        });
        inheritedReferenceTraceId = normalizeReferenceTraceId(liveSession.referenceTraceId);
      }
      const liveSessionProviderId = liveSession
        ? explicitProviderId !== undefined
          ? explicitProviderId
          : liveSession.providerId ?? null
        : null;
      const liveSessionProviderMismatch = Boolean(
        liveSession &&
        explicitProviderId !== undefined &&
        (liveSession.providerId ?? null) !== explicitProviderId,
      );
      const liveSessionProviderMissing = Boolean(
        liveSession &&
        typeof liveSessionProviderId === 'string' &&
        !providerSvc.getRawProvider(liveSessionProviderId, providerScope),
      );
      // A session without a provider profile is pinned to its runtime, as its
      // restore resolved it; a changed default runtime is not a change to it.
      const liveSessionProviderSnapshotHash = liveSession?.providerSnapshotHash && !liveSessionProviderMissing
        ? resolveProviderSnapshotHash(liveSessionProviderId,
          liveSessionProviderId ? undefined : liveSession.runtimeKind)
        : null;
      const liveSessionProviderSnapshotMismatch = Boolean(
        liveSession &&
        !liveSessionProviderMismatch &&
        liveSession.providerSnapshotHash &&
        liveSessionProviderSnapshotHash &&
        liveSession.providerSnapshotHash !== liveSessionProviderSnapshotHash,
      );
      if (existingSession && existingSession.traceId === traceId) {
        if (liveSessionProviderMismatch) {
          existingSession.logger.info('AgentRoutes', 'Provider changed; starting a new SDK session', {
            previousProviderId: existingSession.providerId,
            nextProviderId: explicitProviderId,
          });
          this.revokeLiveSession(existingSession, 'provider_override_mismatch');
          console.log(`[AgentRoutes] Provider changed for ${requestedSessionId}, creating a new agent session`);
        } else if (liveSessionProviderMissing) {
          // The next pin is the active provider, resolved after the revocation.
          existingSession.logger.warn('AgentRoutes', 'Pinned provider was removed; starting a fresh SDK session', {
            previousProviderId: liveSessionProviderId,
          });
          this.revokeLiveSession(existingSession, 'pinned_provider_missing');
          console.log(`[AgentRoutes] Pinned provider was removed for ${requestedSessionId}, creating a new agent session`);
        } else if (liveSessionProviderSnapshotMismatch) {
          const previousProviderSnapshotHash = existingSession.providerSnapshotHash as string;
          existingSession.logger.warn('AgentRoutes', 'Provider snapshot changed; starting a fresh SDK session', {
            providerId: liveSessionProviderId,
            previousProviderSnapshotHash,
            nextProviderSnapshotHash: liveSessionProviderSnapshotHash,
          });
          sessionProviderPin = {
            providerId: liveSessionProviderId,
            snapshotHash: liveSessionProviderSnapshotHash as string,
          };
          this.revokeLiveSession(existingSession, 'provider_snapshot_hash_mismatch');
          console.log(`[AgentRoutes] Provider snapshot changed for ${requestedSessionId}, creating a new agent session`);
        } else {
          const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
          existingSession.providerId ??= null;
          existingSession.outputLanguage ??= requestedOutputLanguage;
          existingSession.runtimeKind ??= resolveProviderRuntimeSnapshot(
            providerSvc,
            liveSessionProviderId,
            undefined,
            providerScope,
          ).snapshot.runtimeKind;
          existingSession.providerSnapshotHash ??= liveSessionProviderSnapshotHash;
          existingSession.providerSnapshotChanged = false;
          existingSession.providerSnapshotChangeReason = undefined;
          existingSession.referenceTraceId = effectiveReferenceTraceId;
          existingSession.comparisonSource = comparisonSourceForReference(effectiveReferenceTraceId);
          existingSession.runSequence = Number.isFinite(existingSession.runSequence)
            ? Math.max(0, Math.floor(existingSession.runSequence as number))
            : 0;
          const privateKnowledge = requestedPrivateKnowledge || analysisHasPrivateContext(existingSession);
          existingSession.logger.info('AgentRoutes', 'Continuing multi-turn dialogue', {
            turnQuery: privateKnowledge ? privateQuery : query,
            previousQuery: privateKnowledge ? privateQuery : existingSession.query,
          });
          existingSession.query = query;
          existingSession.agentQuery = undefined;
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

      const persistedAnalysisContextFingerprint = persistedContinuitySnapshot
        ?.analysisContextFingerprint;
      const persistedAnalysisContextMismatch = Boolean(
        input.analysisContextFingerprint &&
        persistedAnalysisContextFingerprint !== input.analysisContextFingerprint,
      );
      const persistedOutputLanguageMismatch = Boolean(
        persistedContinuitySnapshot?.outputLanguage &&
        persistedContinuitySnapshot.outputLanguage !== requestedOutputLanguage,
      );
      const liveSessionSecurityCleaned = liveAnalysisContextMismatch ||
        liveOutputLanguageMismatch ||
        liveSessionProviderMismatch ||
        liveSessionProviderMissing ||
        liveSessionProviderSnapshotMismatch;
      // Private source/RAG context is intentionally non-resumable. Persisted
      // state created by an older version (or a corrupt snapshot) must never
      // rehydrate provider conversation state, raw queries, or private tool
      // results merely because its authorization fingerprint still matches.
      if (requestedPrivateKnowledge && !liveSessionSecurityCleaned) {
        this.onSessionSecurityCleanup?.(requestedSessionId);
        this.sessionContextManager.remove(requestedSessionId);
        this.sessionPersistenceService.clearPrivateSessionContextSnapshots(requestedSessionId);
      } else if (
        (persistedAnalysisContextMismatch || persistedOutputLanguageMismatch) &&
        !liveSessionSecurityCleaned
      ) {
        this.onSessionSecurityCleanup?.(requestedSessionId);
        this.sessionContextManager.remove(requestedSessionId);
      }
      const analysisContextMismatch = liveAnalysisContextMismatch || persistedAnalysisContextMismatch;
      const outputLanguageMismatch = liveOutputLanguageMismatch || persistedOutputLanguageMismatch;
      const persistedSession = requestedPrivateKnowledge || liveSessionProviderMismatch || liveSessionProviderMissing || liveSessionProviderSnapshotMismatch || analysisContextMismatch || outputLanguageMismatch
        ? null
        : this.sessionPersistenceService.getSession(requestedSessionId);
      if (persistedSession && persistedSession.traceId !== traceId) {
        throw new AnalyzeSessionPreparationError('traceId mismatch for requested session', {
          code: 'TRACE_ID_MISMATCH',
          httpStatus: 400,
          hint: `This session belongs to traceId=${persistedSession.traceId}. Switch to that trace or start a new chat.`,
        });
      }

      // Runtime state comes back only from a record that proves it read no
      // private material, and it is that record which is restored.
      if (persistedSession && persistedSession.traceId === traceId &&
        snapshotProvesNoPrivateContext(persistedContinuitySnapshot)) {
        const stateSnapshot = persistedContinuitySnapshot;
        registerSessionBackgroundKnowledgeReferences(
          requestedSessionId,
          stateSnapshot?.backgroundKnowledgeReferences ?? [],
        );
        const persistedReferenceTraceId = readPersistedReferenceTraceId(
          stateSnapshot,
          persistedSession.metadata,
        );
        assertReferenceTraceCompatible({
          requestedSessionId,
          existingReferenceTraceId: persistedReferenceTraceId,
          requestedReferenceTraceId,
        });
        inheritedReferenceTraceId = persistedReferenceTraceId;
        const restoredContext = this.sessionPersistenceService.loadSessionContext(requestedSessionId);
        if (restoredContext) {
          const snapshotRuntimeKind = getSnapshotRuntimeKind(stateSnapshot);
          const snapshotProviderId = getSnapshotRuntimeProviderId(stateSnapshot);
          const snapshotProviderHash = getSnapshotRuntimeProviderSnapshotHash(stateSnapshot);
          const restoredProviderId = explicitProviderId !== undefined
            ? explicitProviderId
            : stateSnapshot
              ? snapshotProviderId ?? null
              : resolveSessionProviderPin().providerId;
          const snapshotProviderMismatch = Boolean(
            explicitProviderId !== undefined &&
            stateSnapshot &&
            snapshotProviderId !== explicitProviderId,
          );
          if (!snapshotProviderMismatch && typeof snapshotProviderId === 'string' && !providerSvc.getRawProvider(snapshotProviderId, providerScope)) {
            throw new AnalyzeSessionPreparationError(`Provider not found: ${snapshotProviderId}`, {
              code: 'PROVIDER_NOT_FOUND',
              httpStatus: 404,
              hint: 'This persisted session was created with a Provider Manager profile that no longer exists. Recreate the provider or start a new chat.',
            });
          }
          const restoredProviderSnapshotHash = !snapshotProviderMismatch
            ? resolveProviderSnapshotHash(
                restoredProviderId,
                restoredProviderId ? undefined : snapshotRuntimeKind,
              )
            : null;
          const snapshotProviderHashMismatch = Boolean(
            !snapshotProviderMismatch &&
            snapshotProviderHash &&
            restoredProviderSnapshotHash &&
            snapshotProviderHash !== restoredProviderSnapshotHash,
          );

          if (snapshotProviderMismatch) {
            this.onSessionSecurityCleanup?.(requestedSessionId);
            this.sessionContextManager.remove(requestedSessionId);
            console.log(
              `[AgentRoutes] Provider override changed for ${requestedSessionId}, creating a new agent session`
            );
          } else {
            this.sessionContextManager.set(requestedSessionId, traceId, restoredContext);
            const restoredOrchestrator: IOrchestrator = createAgentOrchestrator({
              traceProcessorService: getTraceProcessorService(),
              providerId: restoredProviderId,
              runtimeOverride: restoredProviderId ? undefined : snapshotRuntimeKind,
              providerScope,
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

            // Restore runtime maps from the unified snapshot. Mirrors the
            // explicit /resume endpoint so both paths recover the full agent
            // state, not just SessionContext. It holds no provider-bound engine
            // state, so a provider snapshot change restores it unchanged.
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
            const fallbackRestoredRun = restoredSequence > 0
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
            const restoredRun = stateSnapshot?.lastRun || stateSnapshot?.activeRun || fallbackRestoredRun;
            const sceneSnapshotResult = stateSnapshot?.finalResult;
            const restoredResult = sceneSnapshotResult?.sceneTimeline &&
              stateSnapshot?.sessionId === requestedSessionId && stateSnapshot.traceId === traceId &&
              sceneSnapshotResult.sessionId === requestedSessionId &&
              sceneSnapshotResult.sceneTimeline.sessionId === requestedSessionId &&
              sceneSnapshotResult.sceneTimeline.traceId === traceId &&
              sceneSnapshotResult.sceneTimeline.runId === restoredRun?.runId
              ? sceneSnapshotResult : recoveredResult;
            const restoredContinuityBreaks = continuityBreaksAfterRestore(
              stateSnapshot?.continuityBreaks,
              snapshotProviderHashMismatch ? snapshotProviderHash : undefined,
            );
            const restoredLineage = stateSnapshot?.lineage ?? persistedSession.metadata?.lineage;

            const restoredLogger = this.createSessionLogger(requestedSessionId);
            restoredLogger.setMetadata({
              traceId,
              query,
              architecture: 'agent-driven',
              resumed: true,
              referenceTraceId: requestedReferenceTraceId ?? inheritedReferenceTraceId,
            });
            restoredLogger.info('AgentRoutes', 'Session restored from persistence in analyze()', {
              turnCount: restoredTurns.length,
              entityStoreStats: restoredContext.getEntityStore().getStats(),
            });
            if (snapshotProviderHashMismatch) {
              restoredLogger.warn('AgentRoutes', 'Provider snapshot changed since the snapshot was saved; continuity break recorded', {
                providerId: restoredProviderId,
                previousProviderSnapshotHash: snapshotProviderHash,
                nextProviderSnapshotHash: restoredProviderSnapshotHash,
              });
            }

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
            const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
            const restoredSession = {
              orchestrator: restoredOrchestrator,
              sessionId: requestedSessionId,
              sseClients: [],
              result: restoredResult || undefined,
              status: 'pending',
              traceId,
              query,
              tenantId: persistedSession.metadata?.tenantId,
              workspaceId: persistedSession.metadata?.workspaceId,
              userId: persistedSession.metadata?.userId,
              providerId: restoredProviderId,
              runtimeKind: restoredProviderId
                ? resolveProviderRuntimeSnapshot(
                    providerSvc,
                    restoredProviderId,
                    undefined,
                    providerScope,
                  ).snapshot.runtimeKind
                : snapshotRuntimeKind ?? resolveProviderRuntimeSnapshot(
                    providerSvc,
                    null,
                    undefined,
                    providerScope,
                  ).snapshot.runtimeKind,
              outputLanguage: requestedOutputLanguage,
              providerSnapshotHash: restoredProviderSnapshotHash ?? resolveSessionProviderPin().snapshotHash,
              providerSnapshotChanged: snapshotProviderHashMismatch || undefined,
              providerSnapshotChangeReason: snapshotProviderHashMismatch
                ? 'provider_snapshot_hash_mismatch'
                : undefined,
              analysisContextFingerprint: input.analysisContextFingerprint,
              androidInternalsPackPin: stateSnapshot?.androidInternalsPackPin,
              continuityBreaks: restoredContinuityBreaks.length > 0 ? restoredContinuityBreaks : undefined,
              lineage: restoredLineage,
              referenceTraceId: effectiveReferenceTraceId,
              comparisonSource:
                stateSnapshot?.comparisonSource
                ?? comparisonSourceForReference(effectiveReferenceTraceId),
              comparisonReportSection: stateSnapshot?.comparisonReportSection,
              createdAt: persistedSession.createdAt,
              lastActivityAt: Date.now(),
              logger: restoredLogger,
              hypotheses: stateSnapshot?.hypotheses || runtimeArrays?.hypotheses || [],
              agentDialogue: stateSnapshot?.agentDialogue || [],
              dataEnvelopes: stateSnapshot?.dataEnvelopes || runtimeArrays?.dataEnvelopes || [],
              claimSupport: stateSnapshot?.claimSupport,
              claimVerificationResult: stateSnapshot?.claimVerificationResult,
              identityResolutions: stateSnapshot?.identityResolutions,
              agentResponses: stateSnapshot?.agentResponses || [],
              conversationOrdinal: stateSnapshot?.conversationOrdinal || 0,
              conversationSteps:
                stateSnapshot?.conversationSteps || runtimeArrays?.conversationSteps || [],
              runSequence: stateSnapshot?.runSequence || restoredSequence,
              activeRun: stateSnapshot?.activeRun || restoredRun,
              lastRun: stateSnapshot?.lastRun || restoredRun,
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
            const privateKnowledge = requestedPrivateKnowledge || analysisHasPrivateContext(restoredSession);
            restoredLogger.info('AgentRoutes', 'Continuing multi-turn dialogue from persisted context', {
              turnQuery: privateKnowledge ? privateQuery : query,
              previousQuery: privateKnowledge ? privateQuery : latestTurn?.query || persistedSession.question,
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
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found or not restorable, creating new session`);
      }
    }

    const effectiveReferenceTraceId = requestedReferenceTraceId ?? inheritedReferenceTraceId;
    const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const {providerId: sessionProviderId, snapshotHash: sessionProviderSnapshotHash} = resolveSessionProviderPin();
    const orchestrator: IOrchestrator = createAgentOrchestrator({
      traceProcessorService: getTraceProcessorService(),
      providerId: sessionProviderId,
      providerScope,
    });

    const logger = this.createSessionLogger(sessionId);
    logger.setMetadata({
      traceId,
      query: requestedPrivateKnowledge ? privateQuery : query,
      architecture: 'agent-driven',
      referenceTraceId: effectiveReferenceTraceId,
    });
    logger.info('AgentRoutes', 'Agent-driven analysis session created', { options });

    const session = {
      orchestrator,
      sessionId,
      sseClients: [],
      status: 'pending',
      traceId,
      query,
      providerId: sessionProviderId,
      runtimeKind: resolveProviderRuntimeSnapshot(
        providerSvc,
        sessionProviderId,
        undefined,
        providerScope,
      ).snapshot.runtimeKind,
      outputLanguage: requestedOutputLanguage,
      providerSnapshotHash: sessionProviderSnapshotHash,
      providerSnapshotChanged: false,
      analysisContextFingerprint: input.analysisContextFingerprint,
      androidInternalsPackPin: input.options?.androidInternalsPackPin,
      referenceTraceId: effectiveReferenceTraceId,
      comparisonSource: comparisonSourceForReference(effectiveReferenceTraceId),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      logger,
      hypotheses: [],
      agentDialogue: [],
      dataEnvelopes: [],
      claimSupport: [],
      identityResolutions: [],
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
