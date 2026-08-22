// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Agent Analysis Routes
 *
 * API endpoints for Agent-based trace analysis using the agent-driven architecture
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {
  getTraceProcessorService,
  type TraceInfo,
  type TraceProcessorLeaseQueryContext,
} from '../services/traceProcessorService';
import { createSessionLogger, SessionLogger } from '../services/sessionLogger';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../services/agentReportData';
import { persistAgentTurn } from '../services/persistAgentSession';
import {
  buildAnalysisReceipt,
  buildLegacyAnalysisReceipt,
  type BuildAnalysisReceiptInput,
} from '../services/analysisReceiptBuilder';
import { deriveUiActionProposals } from '../services/uiActionProposalDeriver';
import {
  buildRawTraceComparisonReportSection,
  comparisonIdentityFromReportSection,
} from '../services/comparisonAppendixService';
import {
  applyFinalResultQualityGate,
  completeFinalResultComparisonIdentity,
} from '../services/finalResultQualityGate';
import {
  deriveEvidenceBackedConclusionContractForNarrative,
  normalizeNarrativeForClient as sharedNormalizeNarrative,
} from '../services/agentResultNormalizer';
import { reportStore, persistReport } from './reportRoutes';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import {
  authenticate,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
  requireRequestContext,
  type RequestContext,
} from '../middleware/auth';
import {
  isOwnedByContext,
  ownersMatch,
  ownerFieldsFromContext,
  sendResourceNotFound,
  type ResourceOwnerFields,
} from '../services/resourceOwnership';
import { hasRbacPermission, sendForbidden } from '../services/rbac';
import { requireAiEnabledForHttp, sendAiDisabledErrorIfPresent } from './aiCapabilityPolicyHttp';
import { AiDisabledError, assertAiFeatureEnabled } from '../services/aiCapabilityPolicy';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';
import { sessionContextManager, EnhancedSessionContext } from '../agent/context/enhancedSessionContext';
import { registerCoreTools, StreamingUpdate, AgentRuntimeAnalysisResult, Hypothesis } from '../agent';
import { getSharedModelRouter } from '../agent/core/modelRouterSingleton';
import type { AnalysisOptions, IOrchestrator, TraceDataset } from '../agent/core/orchestratorTypes';
import {
  deriveConclusionSceneAspectsFromSkillIds,
  resolveConclusionScene,
} from '../agent/core/conclusionSceneTemplates';
import { DEEP_REASON_LABEL } from '../utils/analysisNarrative';
import { localize, parseOutputLanguage, type OutputLanguage } from '../agentv3/outputLanguage';
import { diagnosticLogIdentity } from '../utils/logger';
import { sanitizeNarrativeForClient } from './narrativeSanitizer';
import { registerSceneReconstructRoutes } from './agentSceneReconstructRoutes';
import { SceneStoryService } from '../agent/scene/sceneStoryService';
import { buildSmartSceneSelectionReport } from '../agent/scene/buildSmartChatReport';
import { buildSmartDeepDiveDispatch } from '../agent/scene/smartDeepDiveDispatch';
import type { SceneAnalysisSelection, SceneReport } from '../agent/scene/types';
import { SmartCancelBridge } from '../agent/scene/smartCancelBridge';
import { FileSystemSceneReportStore } from '../services/sceneReport/sceneReportStore';
import { SceneReportMemoryCache } from '../services/sceneReport/sceneReportMemoryCache';
import {TtlLruCache} from '../services/ttlLruCache';
import { FileSystemSceneJobArtifactStore } from '../services/sceneReport/sceneJobArtifactStore';
import { computeTraceContentHash } from '../agent/scene/traceHash';
import { probeTraceDuration } from '../agent/scene/sceneTraceDurationProbe';
import { agentSessionConfig, resolveFeatureConfig, sceneStoryConfig } from '../config';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorHolderType,
  type TraceProcessorLeaseRecord,
} from '../services/traceProcessorLeaseStore';
import {
  buildTraceProcessorLeaseModeDecision,
  type TraceProcessorLeaseModeDecision,
} from '../services/traceProcessorLeaseModeDecision';
import { evaluateAnalysisRunQuota, type EnterpriseQuotaDecision } from '../services/enterpriseQuotaPolicyService';
import {
  evaluateTenantMutationPolicy,
  sendTenantMutationDeniedPayload,
} from '../services/enterpriseTenantLifecycleService';
import { estimateTraceProcessorRssBytes } from '../services/traceProcessorRamBudget';
import { TraceProcessorFactory } from '../services/workingTraceProcessor';
import { registerAgentLogsRoutes } from './agentLogsRoutes';
import { registerAgentQuickSceneRoutes } from './agentQuickSceneRoutes';
import { registerAgentReportRoutes } from './agentReportRoutes';
import { registerAgentExternalIssueRoutes } from './agentExternalIssueRoutes';
import { registerAgentResumeRoutes } from './agentResumeRoutes';
import { registerAgentSessionCatalogRoutes } from './agentSessionCatalogRoutes';
import { registerTeachingRoutes } from './agentTeachingRoutes';
import {
  AnalyzeOptionsError,
  normalizeAnalyzeOptions,
  normalizeSelectionContext,
  type AnalyzeMode,
} from './agent/normalizeAnalyzeOptions';
import { finalizeAgentDrivenSession } from './agent/finalizeAgentDrivenSession';
import { projectStateTimelineRunResult } from './agent/stateTimelineRunProjection';
import { AssistantApplicationService } from '../assistant/application/assistantApplicationService';
import { StreamProjector, SSE_RING_BUFFER_SIZE, type BufferedSseEvent } from '../assistant/stream/streamProjector';
import {
  appendReplayableSseEvent,
  hasTerminalReplayAfter,
  parseLastEventId,
  TERMINAL_SSE_EVENT_TYPES,
} from '../assistant/stream/sessionSseReplay';

import {
  listSerializedAgentEventsAfter,
  persistSerializedAgentEvent,
  type AgentEventPersistenceScope,
  type SerializedAgentEvent,
} from '../services/agentEventStore';
import {
  heartbeatAnalysisRun,
  isAnalysisRunHeartbeatFresh,
  persistAnalysisRunState,
  type AnalysisRunPersistenceScope,
  type PersistedAnalysisRunStatus,
} from '../services/analysisRunStore';
import {
  AgentAnalyzeSessionService,
  AnalyzeSessionPreparationError,
  buildAgentQueryWithContinuityNotice,
  type AnalyzeSessionRunContext,
} from '../assistant/application/agentAnalyzeSessionService';
import { buildAssistantResultContract } from '../assistant/contracts/assistantResultContract';
import {
  persistCompletedAnalysisResultSnapshot,
  resolveAnalysisResultSceneType,
} from '../services/analysisResultSnapshotPipeline';
import {runPreparedAnalysisClaimVerification} from '../services/evidence/analysisRelationPreparation';
import {
  getDefaultAndroidInternalsPackResolver,
} from '../services/androidInternalsPack/androidInternalsPackResolver';
// Agent-Driven Architecture v2.0 - Focus tracking
import type { FocusInteraction } from '../agent/context/focusStore';
// DataEnvelope types for v2.0 data contract
import {
  createDataEnvelope,
  generateEventId,
  type AnalysisCompletedEvent,
  type DataEnvelope,
} from '../types/dataContract';
import { buildTraceContextDataEnvelopes, decorateTraceContextDatasets } from '../agentRuntime/traceContextEvidence';
import type { ConclusionContract } from '../agent/core/conclusionContract';
import type { ClaimSupportV1 } from '../types/evidenceContract';
import type { ClaimVerificationResult } from '../types/claimVerification';
import type { IdentityResolutionV1 } from '../types/identityContract';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import type { ConversationTurn, Finding, Intent } from '../agent/types';
import {
  validateFeedbackInput,
} from '../agentv3/selfImprove/feedbackEnricher';
import { formatToolCallNarration, looksLikeGenericToolMessage } from '../agentv3/toolNarration';
import {patternExistsForFeedback} from '../agentv3/analysisPatternMemory';
import { backendLogPath } from '../runtimePaths';
import { CaseLibrary } from '../services/caseLibrary';
import { saveCaseCandidates } from '../services/caseEvolution/saveCaseCandidates';
import { openCaseCandidateOutbox } from '../services/caseEvolution/caseCandidateOutbox';
import {caseCandidateKnowledgeScope} from '../services/caseEvolution/caseCandidateBuilder';
import {
  attachCaseHitsToContractSync,
  projectEvidenceSignaturesByCluster,
  verifyAndPruneCaseRecommendations,
} from '../services/caseEvolution/attachCaseHitsToContract';
import {
  isCaseEvolutionCaptureEnabled,
  isCaseEvolutionRetrieveEnabled,
  loadCaseEvolutionConfig,
} from '../services/caseEvolution/caseEvolutionConfig';
import {
  knowledgeScopeFromRequestContext,
  resolveKnowledgeScope,
  type KnowledgeScope,
} from '../services/scopedKnowledgeStore';
import {authorizeAnalysisContext} from '../services/analysisContextAuthorization';
import {
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
} from '../services/security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate} from '../services/security/codeAwareStreamingUpdateProjection';
import {
  privateAnalysisFailureMessage,
  privateAnalysisQueryMessage,
  projectPrivateAnalysisReceipt,
  projectPrivateAnalysisResult,
  projectPrivateFindings,
  projectPrivateConclusion,
  projectPrivateStructuredValue,
  projectPrivateTerminationMessage,
  projectPrivateTerminationReason,
  sessionUsesPrivateKnowledge,
} from '../services/security/privateAnalysisProjection';
import {
  AnalysisContextAuthorizationChangedError,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../services/resolvedAnalysisContext';
import {buildSmartDeepDiveAnalysisContext} from '../services/effectiveAnalysisMode';
import {
  cleanupIdleAgentConversationSessions,
  registerAgentConversationRoutes,
} from './agentConversationRoutes';
import type { CaseCandidateCaptureInput, CaseEvolutionConfig } from '../types/caseEvolution';
import type { CaseEvolutionEngine } from '../types/caseEvolution';
import type { AgentRuntimeKind } from '../agentRuntime/runtimeKinds';
import {getWorkspaceSkillRegistry} from '../services/skillPacks/workspaceSkillRegistryProvider';
import {buildSkillRegistryAttribution} from '../services/selfEvolution/skillFingerprint';
import {
  currentEffectiveSkillRegistry,
  getEffectiveRuntimeRegistrySnapshot,
  resolveEffectiveSkillRegistryForRuntime,
} from '../services/selfEvolution/effectiveRuntimeRegistryProvider';
import {
  createRunManifestLifecycle,
  disposeRunManifestLifecyclesForSession,
  getActiveRunManifestLifecycle,
  withRunManifestLifecycle,
  type RunManifestLifecycle,
} from '../services/selfEvolution/runManifestLifecycle';
import {getRunManifestStore} from '../services/selfEvolution/runManifestStore';
import {
  FeedbackEventStore,
  privateFeedbackStorePaths,
} from '../services/selfEvolution/feedbackEventStore';
import {
  FeedbackProjectionService,
} from '../services/selfEvolution/feedbackProjectionService';
import {
  getSelfEvolutionLifecycleSnapshot,
} from '../services/selfEvolution/selfEvolutionLifecycle';
import type {
  AppendFeedbackEventInput,
  RunManifestAttributionSink,
  RunManifestV1,
  RunManifestScope,
} from '../types/selfEvolution';
import type {AnalysisReceipt} from '../types/dataContract';
import type {CapabilityManifestAttributionV1} from '../types/capabilityManifest';

function configuredOutputLanguage(): OutputLanguage {
  return parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

function sessionOutputLanguage(
  session?: {outputLanguage?: OutputLanguage} | null,
): OutputLanguage {
  return session?.outputLanguage ?? configuredOutputLanguage();
}

const COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION = 3;
const PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION = 1;

const router = express.Router();

interface AgentRequestWithObservability extends express.Request {
  assistantRequestId?: string;
}

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

function sanitizeRequestId(raw: unknown): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const normalized = text.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, MAX_REQUEST_ID_LENGTH);
  return normalized;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestIdFromRequest(req: express.Request): string {
  const headerId = req.header(REQUEST_ID_HEADER) || req.header('x-correlation-id') || req.header('x-amzn-trace-id');
  const bodyId =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).requestId
      : undefined;

  return sanitizeRequestId(headerId) || sanitizeRequestId(bodyId) || generateRequestId();
}

function getRequestId(req: express.Request): string {
  return (req as AgentRequestWithObservability).assistantRequestId || resolveRequestIdFromRequest(req);
}

function normalizeRunSequence(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(Number(value)));
}

function buildRunId(sessionId: string, sequence: number): string {
  return `run-${sessionId}-${sequence}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendAgentQuotaDenied(res: express.Response, decision: EnterpriseQuotaDecision): express.Response {
  return res.status(decision.httpStatus).json({
    success: false,
    code: decision.code,
    status: decision.status,
    error: decision.message,
    details: decision.details,
  });
}

function terminalRunStatusForResult(
  result: AgentRuntimeAnalysisResult,
): Extract<PersistedAnalysisRunStatus, 'completed' | 'failed' | 'quota_exceeded'> {
  if (result.terminationReason === 'max_budget_usd') return 'quota_exceeded';
  return result.success ? 'completed' : 'failed';
}

function enterpriseLeasesEnabled(): boolean {
  return resolveFeatureConfig().enterprise;
}

function leaseScopeFromRequestContext(context: RequestContext) {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

function leaseScopeFromSession(session: AnalysisSession) {
  if (!session.tenantId || !session.workspaceId) return null;
  return {
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    userId: session.userId,
  };
}

function markLeaseReadyIfNew(
  lease: TraceProcessorLeaseRecord,
  scope: { tenantId: string; workspaceId: string; userId?: string },
): TraceProcessorLeaseRecord {
  if (lease.state !== 'pending') return lease;
  const store = getTraceProcessorLeaseStore();
  const starting = store.markStarting(scope, lease.id);
  return store.markReady(scope, starting.id);
}

function buildLeaseModeDecisionForTrace(
  scope: { tenantId: string; workspaceId: string; userId?: string },
  traceId: string,
  holderType: TraceProcessorHolderType,
  options: {
    analysisMode?: unknown;
    estimatedSqlMs?: unknown;
    heavySkill?: boolean;
    longTask?: boolean;
    traceSizeBytes?: number;
  } = {},
): TraceProcessorLeaseModeDecision {
  const store = getTraceProcessorLeaseStore();
  const processorStats = TraceProcessorFactory.getStats();
  return buildTraceProcessorLeaseModeDecision({
    traceId,
    holderType,
    analysisMode: options.analysisMode,
    estimatedSqlMs: options.estimatedSqlMs,
    heavySkill: options.heavySkill,
    longTask: options.longTask,
    estimatedNewLeaseRssBytes:
      typeof options.traceSizeBytes === 'number' ? estimateTraceProcessorRssBytes(options.traceSizeBytes) : undefined,
    leases: store.listLeases(scope, { traceId }),
    processors: processorStats.processors,
    ramBudget: processorStats.ramBudget,
  });
}

function buildSessionObservability(
  session: AnalysisSession,
): { runId: string; requestId: string; runSequence: number; status: string } | undefined {
  const run = session.activeRun || session.lastRun;
  if (!run) return undefined;
  return {
    runId: run.runId,
    requestId: run.requestId,
    runSequence: normalizeRunSequence(run.sequence),
    status: run.status,
  };
}

function cloneRunContext(run: AnalyzeSessionRunContext): AnalyzeSessionRunContext {
  return { ...run };
}

function ensureSessionRunRegistry(session: AnalysisSession): Record<string, AnalyzeSessionRunContext> {
  if (!session.runRegistry) session.runRegistry = {};
  if (session.activeRun?.runId) session.runRegistry[session.activeRun.runId] = cloneRunContext(session.activeRun);
  if (session.lastRun?.runId) session.runRegistry[session.lastRun.runId] = cloneRunContext(session.lastRun);
  return session.runRegistry;
}

function registerSessionRun(session: AnalysisSession, run: AnalyzeSessionRunContext): AnalyzeSessionRunContext {
  const registry = ensureSessionRunRegistry(session);
  registry[run.runId] = cloneRunContext(run);
  return registry[run.runId];
}

function resolveSessionRun(session: AnalysisSession, runId?: string): AnalyzeSessionRunContext | undefined {
  if (runId) {
    if (session.activeRun?.runId === runId) return session.activeRun;
    if (session.lastRun?.runId === runId) return session.lastRun;
    return ensureSessionRunRegistry(session)[runId];
  }
  return session.activeRun || session.lastRun;
}

function updateRegisteredSessionRun(
  session: AnalysisSession,
  runId: string,
  updates: Partial<AnalyzeSessionRunContext>,
): AnalyzeSessionRunContext | undefined {
  const existing = resolveSessionRun(session, runId);
  if (!existing) return undefined;
  const next = { ...existing, ...updates, runId };
  const registry = ensureSessionRunRegistry(session);
  registry[runId] = cloneRunContext(next);
  if (session.activeRun?.runId === runId) session.activeRun = cloneRunContext(next);
  if (session.lastRun?.runId === runId) session.lastRun = cloneRunContext(next);
  return next;
}

function isCurrentRunOwner(session: AnalysisSession, runId: string | undefined): boolean {
  return Boolean(runId && session.activeRun?.runId === runId);
}

function shouldUpdateSessionStatusForRun(session: AnalysisSession, runId: string | undefined): boolean {
  return isCurrentRunOwner(session, runId);
}

function buildStreamObservability(
  session: AnalysisSession,
  runId?: string,
): { runId?: string; requestId?: string; runSequence?: number } {
  const run = resolveSessionRun(session, runId);
  if (!run) return {};
  return {
    runId: run.runId,
    requestId: run.requestId,
    runSequence: normalizeRunSequence(run.sequence),
  };
}

function startSessionRun(
  session: AnalysisSession,
  query: string,
  requestId: string,
): AnalyzeSessionRunContext | undefined {
  if (session.cancellationInFlightRunId) return undefined;
  const nextSequence = normalizeRunSequence(session.runSequence) + 1;
  session.runSequence = nextSequence;

  const run: AnalyzeSessionRunContext = {
    runId: buildRunId(session.sessionId, nextSequence),
    requestId: sanitizeRequestId(requestId) || generateRequestId(),
    sequence: nextSequence,
    query,
    startedAt: Date.now(),
    status: 'pending',
  };
  session.activeRun = run;
  session.lastRun = run;
  session.cancelState = { runId: run.runId, cancelled: false };
  registerSessionRun(session, run);
  markSessionRunExecutionActive(session, run.runId);

  // Record query in cross-turn history (append-only, never overwritten)
  if (!session.queryHistory) session.queryHistory = [];
  session.queryHistory.push({
    turn: nextSequence,
    query,
    timestamp: Date.now(),
  });

  // Inject turn boundary marker for multi-turn conversations
  if (nextSequence > 1) {
    const outputLanguage = sessionOutputLanguage(session);
    session.conversationOrdinal = (Number.isFinite(session.conversationOrdinal) ? session.conversationOrdinal : 0) + 1;
    const boundaryOrdinal = session.conversationOrdinal;
    session.conversationSteps.push({
      eventId: `turn-boundary-${session.sessionId}-${nextSequence}`,
      ordinal: boundaryOrdinal,
      phase: 'progress',
      role: 'system',
      text: localize(
        outputLanguage,
        `── 第 ${nextSequence} 轮对话开始 ──`,
        `── Conversation turn ${nextSequence} started ──`,
      ),
      timestamp: Date.now(),
      sourceEventType: 'turn_boundary',
    });
  }

  persistSessionRunState(session, 'pending', undefined, run.runId);
  return run;
}

function markSessionRunStatus(
  session: AnalysisSession,
  status: AnalyzeSessionRunContext['status'],
  error?: string,
  runId: string | undefined = getSessionRunId(session),
): void {
  if (!runId) return;
  const completedAt =
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'quota_exceeded'
      ? Date.now()
      : undefined;
  const nextRun = updateRegisteredSessionRun(session, runId, {
    status,
    completedAt,
    error,
  });
  if (!nextRun) return;
  if (isCurrentRunOwner(session, runId)) {
    session.lastRun = cloneRunContext(nextRun);
  }
  persistSessionRunState(session, status, error, runId);
}

function initializeCancelStateForRun(session: AnalysisSession, run: AnalyzeSessionRunContext): void {
  registerSessionRun(session, run);
  if (isSessionRunCancelled(session, run.runId)) {
    session.cancelState = {
      runId: run.runId,
      cancelled: true,
      reason: session.cancelledRuns?.[run.runId]?.reason,
    };
    return;
  }
  session.cancelState = { runId: run.runId, cancelled: false };
}

function getSessionRunId(session: AnalysisSession): string | undefined {
  return session.activeRun?.runId || session.lastRun?.runId;
}

function getCompletedResultRunId(session: AnalysisSession, runId?: string): string | undefined {
  return runId ?? getSessionRunId(session);
}

function isSessionRunCancelled(
  session: AnalysisSession,
  runId: string | undefined = getSessionRunId(session),
): boolean {
  return Boolean(
    runId &&
    (session.cancelledRuns?.[runId]?.cancelled ||
      (session.cancelState?.runId === runId && session.cancelState.cancelled)),
  );
}

function markSessionRunCancelled(session: AnalysisSession, runId: string, reason: string): void {
  if (!session.cancelledRuns) session.cancelledRuns = {};
  session.cancelledRuns[runId] = {
    cancelled: true,
    reason,
    cancelledAt: Date.now(),
  };
  if (isCurrentRunOwner(session, runId)) {
    session.cancelState = { runId, cancelled: true, reason };
    session.status = 'cancelled';
    session.error = reason;
  }
  markSessionRunStatus(session, 'cancelled', reason, runId);
}

function setCurrentSessionRun(session: AnalysisSession, run: AnalyzeSessionRunContext): AnalyzeSessionRunContext {
  session.activeRun = cloneRunContext(run);
  session.lastRun = cloneRunContext(run);
  registerSessionRun(session, run);
  return session.activeRun;
}

function isStaleRun(session: AnalysisSession, runId: string | undefined): boolean {
  return Boolean(runId && !isCurrentRunOwner(session, runId));
}

function markSessionRunExecutionActive(session: AnalysisSession, runId: string): void {
  if (!session.executingRunIds) session.executingRunIds = new Set<string>();
  session.executingRunIds.add(runId);
}

function isSessionRunExecutionActive(session: AnalysisSession, runId: string): boolean {
  return session.executingRunIds?.has(runId) === true;
}

function clearCancellationInFlightIfSettled(
  session: AnalysisSession,
  runId: string,
): void {
  if (
    session.cancellationInFlightRunId !== runId ||
    session.cancellationAbortCompletedRunId !== runId ||
    isSessionRunExecutionActive(session, runId)
  ) {
    return;
  }
  session.cancellationInFlightRunId = undefined;
  session.cancellationAbortCompletedRunId = undefined;
}

function settleSessionRunExecution(session: AnalysisSession, runId: string): void {
  session.executingRunIds?.delete(runId);
  if (session.executingRunIds?.size === 0) {
    session.executingRunIds = undefined;
  }
  clearCancellationInFlightIfSettled(session, runId);
}

async function abortSessionBestEffort(session: AnalysisSession, component: string): Promise<void> {
  if (typeof session.orchestrator.abortSession !== 'function') return;
  try {
    await session.orchestrator.abortSession(session.sessionId, session.referenceTraceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn(component, 'Runtime abortSession failed during cancellation cleanup', {
      sessionId: session.sessionId,
      error: message,
    });
  }
}

async function abortOwnedRunBestEffort(session: AnalysisSession, runId: string, component: string): Promise<boolean> {
  if (session.cancellationInFlightRunId !== runId || !isCurrentRunOwner(session, runId)) {
    session.logger.warn(component, 'Skipped session abort for a run that no longer owns cancellation', {
      sessionId: session.sessionId,
      runId,
      activeRunId: session.activeRun?.runId,
      cancellationInFlightRunId: session.cancellationInFlightRunId,
    });
    return false;
  }
  await abortSessionBestEffort(session, component);
  return true;
}

function cleanupSessionBestEffort(sessionId: string, session: AnalysisSession, component: string): void {
  if (typeof session.orchestrator.cleanupSession !== 'function') return;
  try {
    const cleanup = session.orchestrator.cleanupSession(sessionId);
    void Promise.resolve(cleanup).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      session.logger.warn(component, 'Runtime cleanupSession failed', {
        sessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn(component, 'Runtime cleanupSession failed', {
      sessionId,
      error: message,
    });
  }
}

async function abortAndCleanupSession(sessionId: string, session: AnalysisSession, component: string): Promise<void> {
  await abortSessionBestEffort(session, component);
  cleanupSessionBestEffort(sessionId, session, component);
  revokeCodeAwareOutputGuards(sessionId);
  disposeRunManifestLifecyclesForSession(
    runManifestScopeFromSession(session),
    sessionId,
  );
}

async function retireAuthorizationChangedSession(
  sessionId: string,
  session: AnalysisSession,
  updateHandler: (update: StreamingUpdate) => void,
): Promise<void> {
  // Stop the event source before awaiting runtime cleanup. Cleanup may itself
  // flush callbacks, so the output guard must also remain revoked throughout
  // that asynchronous window.
  session.orchestrator.off('update', updateHandler);
  if (session.orchestratorUpdateHandler === updateHandler) {
    session.orchestratorUpdateHandler = undefined;
  }
  revokeCodeAwareOutputGuards(sessionId);
  sessionContextManager.remove(sessionId);
  if (typeof session.orchestrator.cleanupSession === 'function') {
    await Promise.resolve(session.orchestrator.cleanupSession(sessionId)).catch(() => undefined);
  }
}

function scrubAuthorizationChangedSession(session: AnalysisSession): void {
  const privateQuery = privateAnalysisQueryMessage(sessionOutputLanguage(session));
  session.query = privateQuery;
  session.agentQuery = privateQuery;
  session.result = undefined;
  session.error = undefined;
  session.hypotheses = [];
  session.scenes = undefined;
  session.trackEvents = undefined;
  session.sceneStoryReport = undefined;
  session.stateTimeline = undefined;
  session.laneAvailability = undefined;
  session.agentDialogue = [];
  session.dataEnvelopes = [];
  session.agentResponses = [];
  session.claimSupport = undefined;
  session.claimVerificationResult = undefined;
  session.identityResolutions = undefined;
  session.conversationSteps = [];
  session.queryHistory = [];
  session.conclusionHistory = [];
  session.comparisonReportSection = undefined;
  session.codebaseIds = undefined;
  session.knowledgeSourceIds = undefined;
  session.analysisContextFingerprint = undefined;
  session.activeRun = undefined;
  session.lastRun = undefined;
  session.runRegistry = undefined;
  session.runSseState = undefined;
  session.sseEventBuffer = [];
  session.sseEventSeq = 0;
}

function appendCancellationTerminalEvents(
  session: AnalysisSession,
  reason: string,
  runId?: string,
): BufferedSseEvent[] {
  const observability = buildStreamObservability(session, runId);
  const cancelled = appendAndPersistReplayableSessionEvent(
    session,
    'analysis_cancelled',
    {
      type: 'analysis_cancelled',
      architecture: 'agent-driven',
      ...observability,
      message: reason,
      reason,
      terminalRunStatus: 'cancelled',
      timestamp: Date.now(),
    },
    runId,
  );
  const end = appendAndPersistReplayableSessionEvent(
    session,
    'end',
    {
      timestamp: Date.now(),
      ...observability,
    },
    runId,
  );
  return [cancelled, end];
}

function findCancellationTerminalEvents(events: readonly BufferedSseEvent[], runId?: string): BufferedSseEvent[] {
  let cancelledIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (
      events[index].eventType === 'analysis_cancelled' &&
      (!runId || !events[index].runId || events[index].runId === runId)
    ) {
      cancelledIndex = index;
      break;
    }
  }
  if (cancelledIndex < 0) return [];
  const endIndex = events.findIndex(
    (event, index) =>
      index > cancelledIndex && event.eventType === 'end' && (!runId || !event.runId || event.runId === runId),
  );
  if (endIndex < 0) return [];
  return events.slice(cancelledIndex, endIndex + 1);
}

function getCancellationTerminalEvents(session: AnalysisSession, reason: string, runId?: string): BufferedSseEvent[] {
  const buffer =
    runId && !isCurrentRunOwner(session, runId)
      ? getRunSseReplayState(session, runId).sseEventBuffer
      : session.sseEventBuffer;
  const buffered = findCancellationTerminalEvents(buffer, runId);
  if (buffered.length > 0) return buffered;

  const persisted = loadPersistedCompletedAnalysisSseEvents(session, runId);
  const persistedTerminal = findCancellationTerminalEvents(persisted, runId);
  if (persistedTerminal.length > 0) return persistedTerminal;

  return appendCancellationTerminalEvents(session, reason, runId);
}

function writeSessionEventsToClient(res: express.Response, events: readonly BufferedSseEvent[]): void {
  for (const event of events) {
    writeBufferedSessionEvent(res, event);
  }
}

type CancelSessionRunResult = {
  session: AnalysisSession;
  runId: string;
  runStatus?: AnalyzeSessionRunContext['status'];
  outcome: 'cancelled' | 'already_cancelled' | 'run_not_found' | 'run_not_active' | 'run_not_cancellable';
  reason?: string;
};

async function cancelSessionRun(
  sessionId: string,
  runId: string,
  reason = 'Analysis cancelled by user',
): Promise<CancelSessionRunResult | undefined> {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return undefined;

  const targetRun = resolveSessionRun(session, runId);
  if (!targetRun) {
    return {
      session,
      runId,
      outcome: 'run_not_found',
    };
  }
  if (isSessionRunCancelled(session, runId) || targetRun.status === 'cancelled') {
    return {
      session,
      runId,
      runStatus: 'cancelled',
      outcome: 'already_cancelled',
      reason: session.cancelledRuns?.[runId]?.reason || targetRun.error || reason,
    };
  }
  if (!isCurrentRunOwner(session, runId)) {
    return {
      session,
      runId,
      runStatus: targetRun.status,
      outcome: 'run_not_active',
    };
  }
  if (
    (targetRun.status !== 'pending' && targetRun.status !== 'running') ||
    (session.status !== 'pending' && session.status !== 'running' && session.status !== 'awaiting_user')
  ) {
    return {
      session,
      runId,
      runStatus: targetRun.status,
      outcome: 'run_not_cancellable',
    };
  }

  session.cancellationInFlightRunId = runId;
  session.cancellationAbortCompletedRunId = undefined;
  markSessionRunCancelled(session, runId, reason);
  const smartCancelled = smartCancelBridge.cancel(sessionId, runId);
  if (smartCancelled) smartCancelBridge.tryClaimTerminal(sessionId, runId);
  const sceneCancelled = sceneStoryService.cancel(sessionId, runId);
  try {
    await abortOwnedRunBestEffort(session, runId, 'AgentRoutes');
  } finally {
    if (session.cancellationInFlightRunId === runId) {
      session.cancellationAbortCompletedRunId = runId;
      clearCancellationInFlightIfSettled(session, runId);
    }
  }
  const runManifestLifecycle = getActiveRunManifestLifecycle(
    runManifestScopeFromSession(session),
    sessionId,
    runId,
  );
  if (runManifestLifecycle) {
    finalizeHttpRunManifestLifecycle(session, runManifestLifecycle);
  }

  const terminalEvents = appendCancellationTerminalEvents(session, reason, runId);
  const terminalClients = filterSseClientsForRun(session.sseClients, runId);
  for (const client of terminalClients) {
    try {
      writeSessionEventsToClient(client, terminalEvents);
      client.end();
    } catch {
      // client may already be closed
    }
  }
  session.sseClients = session.sseClients.filter((client) => !terminalClients.includes(client));
  session.lastActivityAt = Date.now();
  session.logger.info('AgentRoutes', 'Session cancelled by user', {
    sessionId,
    runId,
    smartCancelled,
    sceneCancelled,
  });
  return {
    session,
    runId,
    runStatus: 'cancelled',
    outcome: 'cancelled',
    reason,
  };
}

function readRequiredCancellationRunId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const runId = value.trim();
  return runId ? runId : undefined;
}

function sendCancelSessionRunResult(res: express.Response, result: CancelSessionRunResult): express.Response {
  const { session, runId, runStatus, outcome, reason } = result;
  switch (outcome) {
    case 'cancelled':
    case 'already_cancelled':
      return res.json({
        success: true,
        sessionId: session.sessionId,
        runId,
        status: 'cancelled',
        sessionStatus: session.status,
        outcome,
        reason,
      });
    case 'run_not_found':
      return res.status(404).json({
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_FOUND',
        error: 'Run not found in session',
      });
    case 'run_not_active':
      return res.status(409).json({
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_ACTIVE',
        error: 'Run no longer owns the active session analysis',
        status: runStatus,
        activeRunId: session.activeRun?.runId,
        sessionStatus: session.status,
      });
    case 'run_not_cancellable':
      return res.status(409).json({
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_CANCELLABLE',
        error: 'Run is already terminal',
        status: runStatus,
        sessionStatus: session.status,
      });
  }
}

// Attach/echo requestId for all agent endpoints.
router.use((req, res, next) => {
  const requestId = resolveRequestIdFromRequest(req);
  (req as AgentRequestWithObservability).assistantRequestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
});

// Apply API-key auth and RequestContext to all Agent endpoints (dev fallback still applies when key is not configured).
router.use(authenticate);

// ============================================================================
// Session Tracking (Agent-Driven)
// ============================================================================

interface CancelledRunRecord {
  cancelled: true;
  reason: string;
  cancelledAt: number;
}

interface RunScopedSseReplayState {
  sseEventSeq: number;
  sseEventBuffer: BufferedSseEvent[];
}

interface AnalysisSession {
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  sessionId: string;
  sseClients: express.Response[];
  result?: AgentRuntimeAnalysisResult;
  status: 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded';
  error?: string;
  traceId: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  /** Provider Manager profile used for this SDK session. null means env/default fallback is pinned. */
  providerId?: string | null;
  /** SDK runtime pinned together with the provider snapshot for this session. */
  runtimeKind?: AgentRuntimeKind;
  /** Presentation language pinned to this runtime conversation. */
  outputLanguage?: OutputLanguage;
  /** Non-secret ProviderSnapshot hash used to decide whether SDK session state can be reused. */
  providerSnapshotHash?: string | null;
  providerSnapshotChanged?: boolean;
  providerSnapshotChangeReason?: string;
  agentQuery?: string;
  analysisMode?: AnalyzeMode;
  continuityBreaks?: import('../agentv3/sessionStateSnapshot').ProviderContinuityBreak[];
  codeAwareMode?: import('../services/codebase/codeAwareFeature').CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  analysisContextFingerprint?: string;
  androidInternalsPackPin?: import('../services/androidInternalsPack/types').AndroidInternalsPackIdentity;
  /** Reference trace ID for comparison mode (dual-trace analysis) */
  referenceTraceId?: string;
  comparisonSource?: 'raw_trace_pair' | 'analysis_result_snapshots';
  comparisonReportSection?: import('../agentv3/sessionStateSnapshot').ComparisonReportSection;
  query: string;
  createdAt: number;
  lastActivityAt: number;
  logger: SessionLogger;
  hypotheses: Hypothesis[];
  // Optional scene reconstruction artifacts (unified into agent-driven sessions)
  scenes?: DetectedScene[];
  trackEvents?: TrackEvent[];
  sceneStoryReport?: SceneReport;
  // Continuous state timeline lanes (from state_timeline skill)
  stateTimeline?: Record<string, StateLaneSegment[]>;
  laneAvailability?: Record<string, 'available' | 'table_missing' | 'no_data'>;
  agentDialogue: Array<{
    agentId: string;
    type: 'task' | 'response' | 'question';
    content: any;
    timestamp: number;
  }>;
  dataEnvelopes: DataEnvelope[];
  agentResponses: Array<{
    taskId: string;
    agentId: string;
    response: any;
    timestamp: number;
  }>;
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
  conversationOrdinal: number;
  conversationSteps: Array<{
    eventId: string;
    ordinal: number;
    phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
    role: 'agent' | 'system';
    text: string;
    timestamp: number;
    sourceEventType?: string;
  }>;
  runSequence?: number;
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
  cancelState?: { runId: string; cancelled: boolean; reason?: string };
  cancellationInFlightRunId?: string;
  cancellationAbortCompletedRunId?: string;
  executingRunIds?: Set<string>;
  runRegistry?: Record<string, AnalyzeSessionRunContext>;
  cancelledRuns?: Record<string, CancelledRunRecord>;
  runSseState?: Record<string, RunScopedSseReplayState>;
  /** Cross-turn query history — appended on each turn, never overwritten */
  queryHistory: Array<{ turn: number; query: string; timestamp: number }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory: Array<{
    turn: number;
    conclusion: string;
    confidence: number;
    timestamp: number;
  }>;
  /** F3: Monotonic SSE event counter for replay on reconnect */
  sseEventSeq: number;
  /** F3: Ring buffer of recent SSE events for replay on reconnect */
  sseEventBuffer: import('../assistant/stream/streamProjector').BufferedSseEvent[];
}

const assistantAppService = new AssistantApplicationService<AnalysisSession>();
const streamProjector = new StreamProjector();
const smartCancelBridge = new SmartCancelBridge();

function normalizeReceiptAnalysisMode(value: unknown): AnalyzeMode | undefined {
  return value === 'fast' || value === 'full' || value === 'auto' ? value : undefined;
}

function runManifestScopeFromSession(session: AnalysisSession): RunManifestScope {
  return {
    tenantId: session.tenantId ?? DEFAULT_TENANT_ID,
    workspaceId: session.workspaceId ?? DEFAULT_WORKSPACE_ID,
  };
}

async function createHttpRunManifestLifecycle(
  session: AnalysisSession,
  run: AnalyzeSessionRunContext,
  options: {
    analysisMode?: AnalyzeMode;
    referenceTraceId?: string;
  },
): Promise<RunManifestLifecycle> {
  if (!session.runtimeKind) {
    throw new Error(`run_manifest_runtime_missing:${run.runId}`);
  }
  const scope = runManifestScopeFromSession(session);
  const runtimeRegistrySnapshot = await getEffectiveRuntimeRegistrySnapshot({
    scope: {
      ...scope,
      userId: session.userId,
    },
  });
  const skillRegistryAttribution = buildSkillRegistryAttribution(
    runtimeRegistrySnapshot.skillRegistry,
  );
  return createRunManifestLifecycle({
    runId: run.runId,
    sessionId: session.sessionId,
    scope,
    userId: session.userId,
    startedAt: run.startedAt,
    runtime: session.runtimeKind,
    providerId: session.providerId ?? null,
    ...(session.providerSnapshotHash
      ? {providerSnapshotHash: session.providerSnapshotHash}
      : {}),
    outputLanguage: sessionOutputLanguage(session),
    analysisMode: options.analysisMode ?? session.analysisMode ?? 'auto',
    referenceTraceId: options.referenceTraceId ?? session.referenceTraceId,
    skillRegistry: skillRegistryAttribution,
    runtimeRegistrySnapshot,
  });
}

function sealHttpRunManifest(
  session: AnalysisSession,
  lifecycle: RunManifestLifecycle,
  options: {
    closePendingSkillInvocationsAsErrors?: boolean;
  } = {},
): void {
  if (lifecycle.state !== 'collecting') return;
  const run = resolveSessionRun(session, lifecycle.identity.runId);
  const resultTurns =
    session.result &&
    (run?.status === 'completed' || run?.status === 'quota_exceeded')
      ? session.result.rounds
      : 0;
  lifecycle.sealOnceAndPersist({
    scene: {
      sceneType: resolveAnalysisResultSceneType(
        session.query,
        session.dataEnvelopes,
      ),
      architecture: resolveCaseEvolutionArchitectureType(
        session,
        session.traceId,
      ),
    },
    turnCount: Number.isSafeInteger(resultTurns) && resultTurns >= 0
      ? resultTurns
      : 0,
    closePendingSkillInvocationsAsErrors:
      options.closePendingSkillInvocationsAsErrors,
  });
}

function sealCompletedHttpRunManifest(
  session: AnalysisSession,
  lifecycle: RunManifestLifecycle,
  runId: string,
): void {
  const run = resolveSessionRun(session, runId);
  if (
    !session.result ||
    (run?.status !== 'completed' && run?.status !== 'quota_exceeded')
  ) {
    return;
  }
  sealHttpRunManifest(session, lifecycle);
}

function finalizeHttpRunManifestLifecycle(
  session: AnalysisSession,
  lifecycle: RunManifestLifecycle,
): void {
  try {
    sealHttpRunManifest(session, lifecycle, {
      closePendingSkillInvocationsAsErrors: true,
    });
  } catch (error) {
    session.logger.error(
      'RunManifest',
      'Failed to persist terminal run manifest',
      error,
    );
  } finally {
    lifecycle.dispose();
  }
}

function baseAgentEventScopeFromSession(
  session: AnalysisSession,
  runId?: string,
): AgentEventPersistenceScope | null {
  const run = resolveSessionRun(session, runId);
  if (!session.tenantId || !session.workspaceId || !run?.runId) {
    return null;
  }
  return {
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    userId: session.userId,
    sessionId: session.sessionId,
    runId: run.runId,
    traceId: session.traceId,
    query: sessionUsesPrivateKnowledge(session)
      ? privateAnalysisQueryMessage(sessionOutputLanguage(session))
      : run.query || session.query,
  };
}

function agentEventScopeFromSession(
  session: AnalysisSession,
  runId?: string,
): AgentEventPersistenceScope | null {
  return resolveFeatureConfig().enterprise
    ? baseAgentEventScopeFromSession(session, runId)
    : null;
}

function analysisRunScopeFromSession(session: AnalysisSession, runId?: string): AnalysisRunPersistenceScope | null {
  return agentEventScopeFromSession(session, runId);
}

function persistSessionRunState(
  session: AnalysisSession,
  status: PersistedAnalysisRunStatus,
  error?: string,
  runId?: string,
): void {
  const scope = analysisRunScopeFromSession(session, runId);
  if (!scope) return;
  try {
    const durableError = error && sessionUsesPrivateKnowledge(session)
      ? privateAnalysisFailureMessage(sessionOutputLanguage(session))
      : error;
    persistAnalysisRunState(scope, status, {
      error: durableError,
      updateSessionStatus: shouldUpdateSessionStatusForRun(session, scope.runId),
    });
  } catch (persistError) {
    const message = persistError instanceof Error ? persistError.message : String(persistError);
    session.logger.warn('AnalysisRun', 'Failed to persist run state', {
      sessionId: session.sessionId,
      runId: scope.runId,
      status,
      error: message,
    });
  }
}

function heartbeatSessionRun(session: AnalysisSession, runId?: string): void {
  const scope = analysisRunScopeFromSession(session, runId);
  if (!scope) return;
  try {
    heartbeatAnalysisRun(scope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn('AnalysisRun', 'Failed to persist run heartbeat', {
      sessionId: session.sessionId,
      runId: scope.runId,
      error: message,
    });
  }
}

function startSessionRunHeartbeat(session: AnalysisSession, runId?: string): NodeJS.Timeout | undefined {
  if (!analysisRunScopeFromSession(session, runId)) return undefined;
  heartbeatSessionRun(session, runId);
  return setInterval(() => heartbeatSessionRun(session, runId), AGENT_RUN_HEARTBEAT_INTERVAL_MS);
}

function isPersistedSessionRunFresh(session: AnalysisSession, now: number): boolean {
  const scope = analysisRunScopeFromSession(session);
  if (!scope) return false;
  try {
    return isAnalysisRunHeartbeatFresh(scope, scope.runId, now, AGENT_RUN_HEARTBEAT_MAX_STALE_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn('AnalysisRun', 'Failed to inspect persisted run heartbeat', {
      sessionId: session.sessionId,
      runId: scope.runId,
      error: message,
    });
    return true;
  }
}

function persistBufferedAgentEvent(session: AnalysisSession, event: SerializedAgentEvent, runId?: string): void {
  const scope = agentEventScopeFromSession(session, runId) ??
    (
      event.eventType === 'analysis_completed'
        ? baseAgentEventScopeFromSession(session, runId)
        : null
    );
  if (!scope) return;
  try {
    const durableEvent = sessionUsesPrivateKnowledge(session)
      ? sanitizePersistedAnalysisCompletedEvent(session, event)
      : event;
    persistSerializedAgentEvent(scope, durableEvent, {
      updateSessionStatus: shouldUpdateSessionStatusForRun(session, scope.runId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn('AgentEvents', 'Failed to persist SSE event', {
      sessionId: session.sessionId,
      runId: scope.runId,
      eventType: event.eventType,
      cursor: event.cursor,
      error: message,
    });
  }
}

function getRunSseReplayState(session: AnalysisSession, runId: string): RunScopedSseReplayState {
  if (!session.runSseState) session.runSseState = {};
  if (!session.runSseState[runId]) {
    session.runSseState[runId] = { sseEventSeq: 0, sseEventBuffer: [] };
  }
  return session.runSseState[runId];
}

function sanitizePersistedAnalysisCompletedEvent(
  session: AnalysisSession,
  event: SerializedAgentEvent,
): SerializedAgentEvent {
  if (event.eventType !== 'analysis_completed') return event;
  const privateKnowledge = sessionUsesPrivateKnowledge(session);

  let payload: any;
  try {
    payload = JSON.parse(event.eventData || '{}');
  } catch {
    if (!privateKnowledge) return event;
    const language = sessionOutputLanguage(session);
    return {
      ...event,
      eventData: JSON.stringify({
        data: projectPrivateAnalysisResult(session.sessionId, {
          sessionId: session.sessionId,
          success: false,
          findings: [],
          hypotheses: [],
          conclusion: '',
          confidence: 0,
          rounds: 0,
          totalDurationMs: 0,
          uiActionProposals: [],
        }, language),
      }),
    };
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const conclusion =
    typeof data?.conclusion === 'string' ? data.conclusion : typeof data?.answer === 'string' ? data.answer : '';
  if (!conclusion.trim() && !privateKnowledge) return event;

  const result: AgentRuntimeAnalysisResult = {
    sessionId: session.sessionId,
    success: data?.success !== false && Boolean(conclusion.trim()),
    findings: Array.isArray(data?.findings) ? data.findings : [],
    hypotheses: Array.isArray(data?.hypotheses) ? data.hypotheses : [],
    conclusion,
    confidence: typeof data?.confidence === 'number' ? data.confidence : 0.5,
    rounds: typeof data?.rounds === 'number' ? data.rounds : 1,
    totalDurationMs: typeof data?.totalDurationMs === 'number' ? data.totalDurationMs : 0,
    partial: data?.partial === true ? true : undefined,
    terminationReason: data?.terminationReason,
    terminationMessage: data?.terminationMessage,
    conclusionContract: data?.conclusionContract,
    claimSupport: data?.claimSupport,
    claimVerificationResult: data?.claimVerificationResult,
    identityResolutions: data?.identityResolutions,
    quickRun: data?.quickRun,
    analysisReceipt: data?.analysisReceipt,
    uiActionProposals: data?.uiActionProposals,
  };

  const issue = applyFinalResultQualityGate({
    result,
    query: session.query,
    sceneType: result.conclusionContract?.metadata?.sceneId ??
      resolveAnalysisResultSceneType(session.query, session.dataEnvelopes),
  });
  if (!issue && !privateKnowledge) return event;
  const outputLanguage = sessionOutputLanguage(session);
  const trustedPrivateProjection = privateKnowledge &&
    data?.privateProjectionVersion === PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION;
  const resultForProjection = privateKnowledge && !trustedPrivateProjection
    ? {
        ...result,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: '',
        conclusionContract: undefined,
        claimSupport: undefined,
        claimVerificationResult: undefined,
        identityResolutions: undefined,
        uiActionProposals: [],
      }
    : result;
  const durableResult = privateKnowledge
    ? projectPrivateAnalysisResult(session.sessionId, resultForProjection, outputLanguage)
    : resultForProjection;

  const nextData = privateKnowledge
    ? {
        privateProjectionVersion: PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION,
        ...(typeof data?.success === 'boolean' ? {success: durableResult.success} : {}),
        conclusion: durableResult.conclusion,
        ...(Object.prototype.hasOwnProperty.call(data, 'answer')
          ? {answer: durableResult.conclusion}
          : {}),
        conclusionContract: durableResult.conclusionContract,
        claimSupport: durableResult.claimSupport,
        claimVerificationResult: durableResult.claimVerificationResult,
        identityResolutions: durableResult.identityResolutions,
        findings: durableResult.findings,
        hypotheses: durableResult.hypotheses,
        uiActionProposals: durableResult.uiActionProposals,
        smartScenePreview: trustedPrivateProjection && data.smartScenePreview
          ? projectPrivateStructuredValue(session.sessionId, data.smartScenePreview)
          : undefined,
        conversationTimeline: [],
        agentDialogueCount: 0,
        conversationTimelineCount: 0,
        comparisonReportSection: trustedPrivateProjection && data.comparisonReportSection
          ? projectPrivateStructuredValue(session.sessionId, data.comparisonReportSection)
          : undefined,
        resultContract: trustedPrivateProjection && data.resultContract
          ? projectPrivateStructuredValue(session.sessionId, data.resultContract)
          : undefined,
        analysisReceipt: projectPrivateAnalysisReceipt(durableResult.analysisReceipt),
        confidence: durableResult.confidence,
        rounds: durableResult.rounds,
        totalDurationMs: durableResult.totalDurationMs,
        partial: durableResult.partial,
        terminationReason: durableResult.terminationReason,
        terminationMessage: durableResult.terminationMessage,
        quickRun: durableResult.quickRun
          ? projectPrivateStructuredValue(session.sessionId, durableResult.quickRun)
          : undefined,
        reportUrl: typeof data?.reportUrl === 'string' &&
            /^\/api\/reports\/[A-Za-z0-9._~-]+$/.test(data.reportUrl)
          ? data.reportUrl
          : undefined,
        resultSnapshotId: typeof data?.resultSnapshotId === 'string'
          ? data.resultSnapshotId.slice(0, 160)
          : undefined,
        terminalRunStatus: data?.terminalRunStatus === 'quota_exceeded'
          ? 'quota_exceeded'
          : 'completed',
        observability: data?.observability && typeof data.observability === 'object'
          ? {
              ...(typeof data.observability.runId === 'string'
                ? {runId: data.observability.runId.slice(0, 160)}
                : {}),
              ...(typeof data.observability.requestId === 'string'
                ? {requestId: data.observability.requestId.slice(0, 160)}
                : {}),
              ...(typeof data.observability.runSequence === 'number'
                ? {runSequence: data.observability.runSequence}
                : {}),
            }
          : undefined,
      }
    : {
        ...data,
        confidence: durableResult.confidence,
        partial: durableResult.partial,
        terminationReason: durableResult.terminationReason,
        terminationMessage: durableResult.terminationMessage,
        quickRun: durableResult.quickRun,
      };
  const nextPayload = privateKnowledge
    ? {
        type: 'analysis_completed',
        ...(payload?.architecture === 'agent-driven' ? {architecture: 'agent-driven'} : {}),
        ...(typeof payload?.runId === 'string' ? {runId: payload.runId.slice(0, 160)} : {}),
        ...(typeof payload?.requestId === 'string'
          ? {requestId: payload.requestId.slice(0, 160)}
          : {}),
        ...(typeof payload?.runSequence === 'number'
          ? {runSequence: payload.runSequence}
          : {}),
        data: nextData,
        timestamp: typeof payload?.timestamp === 'number' ? payload.timestamp : event.createdAt,
      }
    : payload?.data && typeof payload.data === 'object'
      ? {...payload, data: nextData}
      : {...payload, ...nextData};
  return {
    ...event,
    eventData: JSON.stringify(nextPayload),
  };
}

function replayPersistedAgentEvents(
  session: AnalysisSession,
  res: express.Response,
  lastEventId: number,
  runId?: string,
): { replayed: number; includesTerminal: boolean; lastCursor: number } {
  const scope = agentEventScopeFromSession(session, runId);
  if (!scope) return { replayed: 0, includesTerminal: false, lastCursor: lastEventId };
  let events: SerializedAgentEvent[] = [];
  try {
    events = listSerializedAgentEventsAfter(scope, scope.runId, lastEventId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.logger.warn('AgentEvents', 'Failed to load persisted SSE replay events', {
      sessionId: session.sessionId,
      runId: scope.runId,
      lastEventId,
      error: message,
    });
    return { replayed: 0, includesTerminal: false, lastCursor: lastEventId };
  }

  let replayed = 0;
  let includesTerminal = false;
  let lastCursor = lastEventId;
  for (const event of events) {
    try {
      const replayEvent = sanitizePersistedAnalysisCompletedEvent(session, event);
      res.write(`id: ${event.cursor}\n`);
      res.write(`event: ${replayEvent.eventType}\n`);
      res.write(`data: ${replayEvent.eventData}\n\n`);
      replayed++;
      lastCursor = event.cursor;
      if (TERMINAL_SSE_EVENT_TYPES.has(event.eventType)) {
        includesTerminal = true;
      }
    } catch {
      break;
    }
  }
  return { replayed, includesTerminal, lastCursor };
}

function appendReplayableRunEvent(
  session: AnalysisSession,
  eventType: string,
  payload: unknown,
  runId?: string,
): BufferedSseEvent {
  const replayState = runId && !isCurrentRunOwner(session, runId) ? getRunSseReplayState(session, runId) : session;
  const event = appendReplayableSseEvent(replayState, eventType, payload);
  if (runId) event.runId = runId;
  persistBufferedAgentEvent(
    session,
    {
      cursor: event.seqId,
      eventType: event.eventType,
      eventData: event.eventData,
      createdAt: Date.now(),
    },
    runId,
  );
  return event;
}

function sendReplayableSessionEvent(
  session: AnalysisSession,
  res: express.Response,
  eventType: string,
  payload: unknown,
  runId?: string,
): number {
  const event = appendReplayableRunEvent(session, eventType, payload, runId);
  streamProjector.sendEvent(res, eventType, payload, event.seqId);
  return event.seqId;
}

function appendAndPersistReplayableSessionEvent(
  session: AnalysisSession,
  eventType: string,
  payload: unknown,
  runId?: string,
): BufferedSseEvent {
  return appendReplayableRunEvent(session, eventType, payload, runId);
}

function writeBufferedSessionEvent(res: express.Response, event: BufferedSseEvent): void {
  res.write(`id: ${event.seqId}\n`);
  res.write(`event: ${event.eventType}\n`);
  res.write(`data: ${event.eventData}\n\n`);
}

function loadPersistedCompletedAnalysisSseEvents(session: AnalysisSession, runId?: string): BufferedSseEvent[] {
  const scope = agentEventScopeFromSession(session, runId);
  if (!scope) return [];
  const events = listSerializedAgentEventsAfter(scope, scope.runId, 0)
    .filter(
      (event) =>
        event.eventType === 'snapshot_created' ||
        event.eventType === 'progress' ||
        event.eventType === 'analysis_completed' ||
        event.eventType === 'analysis_cancelled' ||
        event.eventType === 'scene_reconstruction_completed' ||
        event.eventType === 'end',
    )
    .map((event) => sanitizePersistedAnalysisCompletedEvent(session, event))
    .map((event) => ({
      seqId: event.cursor,
      eventType: event.eventType,
      eventData: event.eventData,
      runId: scope.runId,
    }));
  const hasCompletedTerminal = events.some((event) => event.eventType === 'analysis_completed');
  const hasCancelledTerminal = events.some((event) => event.eventType === 'analysis_cancelled');
  if ((!hasCompletedTerminal && !hasCancelledTerminal) || !events.some((event) => event.eventType === 'end')) {
    return [];
  }
  const replayState =
    runId && !isCurrentRunOwner(session, scope.runId) ? getRunSseReplayState(session, scope.runId) : session;
  replayState.sseEventSeq = Math.max(replayState.sseEventSeq || 0, ...events.map((event) => event.seqId));
  const existing = new Set(replayState.sseEventBuffer.map((event) => `${event.seqId}:${event.eventType}`));
  for (const event of events) {
    const key = `${event.seqId}:${event.eventType}`;
    if (!existing.has(key)) replayState.sseEventBuffer.push(event);
  }
  if (replayState.sseEventBuffer.length > SSE_RING_BUFFER_SIZE) {
    replayState.sseEventBuffer.splice(0, replayState.sseEventBuffer.length - SSE_RING_BUFFER_SIZE);
  }
  return events;
}

function latestBufferedProgressEvent(session: AnalysisSession, runId?: string): BufferedSseEvent | undefined {
  const replayState = runId && !isCurrentRunOwner(session, runId) ? session.runSseState?.[runId] : session;
  const buffer = replayState?.sseEventBuffer ?? [];
  return [...buffer].reverse().find((event) => event.eventType === 'progress' && (!runId || event.runId === runId));
}

type TurnHistorySource = 'memory' | 'persistence';

interface ResolvedSessionContext extends ResourceOwnerFields {
  context: EnhancedSessionContext;
  source: TurnHistorySource;
  traceId: string;
  query?: string;
  createdAt?: number;
}

function resolveSessionContextForReview(sessionId: string): ResolvedSessionContext | null {
  const activeSession = assistantAppService.getSession(sessionId);
  if (activeSession) {
    const activeContext =
      sessionContextManager.get(sessionId, activeSession.traceId) || sessionContextManager.get(sessionId);
    if (activeContext) {
      return {
        context: activeContext,
        source: 'memory',
        traceId: activeSession.traceId,
        query: activeSession.query,
        createdAt: activeSession.createdAt,
        tenantId: activeSession.tenantId,
        workspaceId: activeSession.workspaceId,
        userId: activeSession.userId,
      };
    }
  }

  const memoryContext = sessionContextManager.get(sessionId);
  if (memoryContext) {
    return {
      context: memoryContext,
      source: 'memory',
      traceId: memoryContext.getTraceId(),
      query: activeSession?.query,
      createdAt: activeSession?.createdAt,
      tenantId: activeSession?.tenantId,
      workspaceId: activeSession?.workspaceId,
      userId: activeSession?.userId,
    };
  }

  const persistenceService = SessionPersistenceService.getInstance();
  const persistedSession = persistenceService.getSession(sessionId);
  if (!persistedSession) {
    return null;
  }

  const persistedContext = persistenceService.loadSessionContext(sessionId);
  if (!persistedContext) {
    return null;
  }

  return {
    context: persistedContext,
    source: 'persistence',
    traceId: persistedSession.traceId,
    query: persistedSession.question,
    createdAt: persistedSession.createdAt,
    tenantId: persistedSession.metadata?.tenantId,
    workspaceId: persistedSession.metadata?.workspaceId,
    userId: persistedSession.metadata?.userId,
    ownerUserId: persistedSession.metadata?.ownerUserId,
  };
}

function assignSessionOwner(session: AnalysisSession, context: RequestContext): void {
  Object.assign(session, ownerFieldsFromContext(context));
}

function getAuthorizedSession(req: express.Request, res: express.Response, sessionId: string): AnalysisSession | null {
  const context = requireRequestContext(req);
  const session = assistantAppService.getSession(sessionId);
  if (!session || !isOwnedByContext(session, context)) {
    sendResourceNotFound(res, 'Session not found');
    return null;
  }
  return session;
}

function getAuthorizedSessionByRunId(
  req: express.Request,
  res: express.Response,
  runId: string,
): AnalysisSession | null {
  const context = requireRequestContext(req);
  for (const [, session] of assistantAppService.entries()) {
    const isRequestedRun = Boolean(resolveSessionRun(session, runId));
    if (isRequestedRun && isOwnedByContext(session, context)) {
      return session;
    }
  }
  sendResourceNotFound(res, 'Run not found');
  return null;
}

function isResolvedSessionAccessible(req: express.Request, resolved: ResolvedSessionContext): boolean {
  return isOwnedByContext(resolved, requireRequestContext(req));
}

async function ensureTraceAccessible(
  req: express.Request,
  res: express.Response,
  traceId: string,
  code = 'TRACE_NOT_UPLOADED',
): Promise<boolean> {
  const context = requireRequestContext(req);
  const metadata = await readTraceMetadataForContext(traceId, context);
  if (!metadata) {
    res.status(404).json({
      success: false,
      error: 'Trace not found in backend',
      code,
    });
    return false;
  }
  return true;
}

function requestedSessionIsVisible(sessionId: string, context: RequestContext): boolean {
  const activeSession = assistantAppService.getSession(sessionId);
  if (activeSession) {
    return isOwnedByContext(activeSession, context);
  }

  const persistedSession = SessionPersistenceService.getInstance().getSession(sessionId);
  return !persistedSession || isOwnedByContext(persistedSession.metadata, context);
}

function sendRunStartConflictIfNeeded(res: express.Response, session: AnalysisSession | undefined): boolean {
  if (!session) return false;
  if (session.cancellationInFlightRunId) {
    res.status(409).json({
      success: false,
      code: 'CANCELLATION_IN_PROGRESS',
      error: 'The current run is still stopping',
      sessionId: session.sessionId,
      runId: session.cancellationInFlightRunId,
    });
    return true;
  }
  const activeRun = session.activeRun;
  if (session.status === 'awaiting_user' || activeRun?.status === 'pending' || activeRun?.status === 'running') {
    res.status(409).json({
      success: false,
      code: 'RUN_ALREADY_ACTIVE',
      error: 'The session already has an active run',
      sessionId: session.sessionId,
      runId: activeRun?.runId,
    });
    return true;
  }
  return false;
}

function normalizeRouteReferenceTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveVisibleSessionReferenceTraceIdForTrace(
  sessionId: string | undefined,
  traceId: string,
  context: RequestContext,
): string | undefined {
  if (!sessionId) return undefined;

  const activeSession = assistantAppService.getSession(sessionId);
  if (activeSession) {
    if (activeSession.traceId !== traceId || !isOwnedByContext(activeSession, context)) {
      return undefined;
    }
    return normalizeRouteReferenceTraceId(activeSession.referenceTraceId);
  }

  const persistenceService = SessionPersistenceService.getInstance();
  const persistedSession = persistenceService.getSession(sessionId);
  if (
    !persistedSession ||
    persistedSession.traceId !== traceId ||
    !isOwnedByContext(persistedSession.metadata, context)
  ) {
    return undefined;
  }
  return (
    normalizeRouteReferenceTraceId(persistedSession.metadata?.referenceTraceId) ??
    normalizeRouteReferenceTraceId(persistedSession.metadata?.sessionStateSnapshot?.referenceTraceId) ??
    normalizeRouteReferenceTraceId(persistenceService.loadSessionStateSnapshot(sessionId)?.referenceTraceId)
  );
}

function buildTurnSeverityCounts(turn: ConversationTurn): Record<string, number> {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    warning: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const finding of turn.findings || []) {
    const severity = String(finding?.severity || '').toLowerCase();
    if (severity in counts) {
      counts[severity] += 1;
    } else {
      counts.info += 1;
    }
  }

  return counts;
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}

function buildDisplayTurnResult(turn: ConversationTurn): ConversationTurn['result'] {
  if (!turn.result) return turn.result;
  const message = typeof turn.result.message === 'string' ? turn.result.message : '';
  const resultForGate: AgentRuntimeAnalysisResult = {
    sessionId: turn.id,
    success: turn.result.success !== false,
    findings: Array.isArray(turn.findings) ? turn.findings : [],
    hypotheses: [],
    conclusion: message,
    confidence: typeof turn.result.confidence === 'number' ? turn.result.confidence : 0.5,
    rounds: 1,
    totalDurationMs: 0,
    partial: turn.result.partial,
    terminationReason: turn.result.terminationReason as AgentRuntimeAnalysisResult['terminationReason'],
    terminationMessage: turn.result.terminationMessage,
    conclusionContract: turn.result.conclusionContract as AgentRuntimeAnalysisResult['conclusionContract'],
    claimSupport: turn.result.claimSupport,
    claimVerificationResult: turn.result.claimVerificationResult,
    identityResolutions: turn.result.identityResolutions,
  };
  applyFinalResultQualityGate({
    result: resultForGate,
    query: turn.query,
    sceneType: resultForGate.conclusionContract?.metadata?.sceneId,
  });
  return {
    ...turn.result,
    message: resultForGate.conclusion,
    confidence: resultForGate.confidence,
    partial: resultForGate.partial,
    terminationReason: resultForGate.terminationReason,
    terminationMessage: resultForGate.terminationMessage,
  };
}

function buildTurnSummary(
  turn: ConversationTurn,
  privateSessionId?: string,
  outputLanguage: OutputLanguage = configuredOutputLanguage(),
) {
  const displayResult = buildDisplayTurnResult(turn);
  const projectedMessage = privateSessionId && displayResult
    ? projectPrivateConclusion({
        sessionId: privateSessionId,
        conclusion: displayResult.message,
        success: displayResult.success !== false,
        language: outputLanguage,
      })
    : displayResult?.message;
  const confidence = typeof displayResult?.confidence === 'number' ? displayResult.confidence : undefined;
  const sanitizedConclusion =
    typeof projectedMessage === 'string' ? normalizeNarrativeForClient(projectedMessage) : '';
  const conclusionPreview = sanitizedConclusion ? sanitizedConclusion.replace(/\s+/g, ' ').slice(0, 240) : undefined;

  return {
    turnId: turn.id,
    turnIndex: turn.turnIndex,
    timestamp: turn.timestamp,
    query: privateSessionId ? privateAnalysisQueryMessage(outputLanguage) : turn.query,
    intent: privateSessionId
      ? {primaryGoal: '', followUpType: 'initial', aspects: []}
      : {
          primaryGoal: turn.intent?.primaryGoal || '',
          followUpType: turn.intent?.followUpType || 'initial',
          aspects: Array.isArray(turn.intent?.aspects) ? turn.intent.aspects : [],
        },
    completed: !!turn.completed,
    success: typeof displayResult?.success === 'boolean' ? displayResult.success : null,
    partial: displayResult?.partial === true,
    terminationReason: privateSessionId
      ? projectPrivateTerminationReason(displayResult?.terminationReason)
      : displayResult?.terminationReason,
    terminationMessage: privateSessionId
      ? projectPrivateTerminationMessage(displayResult?.terminationMessage, outputLanguage)
      : displayResult?.terminationMessage,
    confidence,
    findingCount: Array.isArray(turn.findings) ? turn.findings.length : 0,
    severityCounts: buildTurnSeverityCounts(turn),
    conclusionPreview,
  };
}

function buildTurnDetail(
  turn: ConversationTurn,
  privateSessionId?: string,
  outputLanguage: OutputLanguage = configuredOutputLanguage(),
) {
  const summary = buildTurnSummary(turn, privateSessionId, outputLanguage);
  const displayResult = buildDisplayTurnResult(turn);
  return {
    ...summary,
    intent: privateSessionId ? summary.intent : toJsonSafe(turn.intent),
    result: displayResult
      ? toJsonSafe(privateSessionId
          ? projectPrivateAnalysisResult(privateSessionId, {
              sessionId: turn.id,
              success: displayResult.success !== false,
              findings: Array.isArray(turn.findings) ? turn.findings : [],
              hypotheses: [],
              conclusion: displayResult.message ?? '',
              confidence: displayResult.confidence ?? 0.5,
              rounds: 1,
              totalDurationMs: 0,
              partial: displayResult.partial === true,
              terminationReason: displayResult.terminationReason as AgentRuntimeAnalysisResult['terminationReason'],
              terminationMessage: displayResult.terminationMessage,
              conclusionContract: displayResult.conclusionContract as ConclusionContract | undefined,
              claimSupport: displayResult.claimSupport,
              claimVerificationResult: displayResult.claimVerificationResult,
              identityResolutions: displayResult.identityResolutions,
            }, outputLanguage)
          : displayResult)
      : null,
    findings: toJsonSafe(privateSessionId
      ? projectPrivateFindings(privateSessionId, turn.findings || [])
      : turn.findings || []),
  };
}

function getLastCompletedTurn(context: EnhancedSessionContext): ConversationTurn | null {
  const turns = context.getAllTurns();
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.completed && turn.result) {
      return turn;
    }
  }
  return null;
}

function buildRecoveredResultFromContext(
  sessionId: string,
  context: EnhancedSessionContext,
): AgentRuntimeAnalysisResult | null {
  const turn = getLastCompletedTurn(context);
  if (!turn || !turn.result) {
    return null;
  }

  const conclusion =
    typeof turn.result.message === 'string' && turn.result.message.trim().length > 0
      ? turn.result.message
      : `已恢复会话历史。可通过 /api/agent/v1/${sessionId}/turns 查看历史轮次。`;
  const confidence = typeof turn.result.confidence === 'number' ? turn.result.confidence : 0.5;

  return {
    sessionId,
    success: turn.result.success !== false,
    findings: Array.isArray(turn.findings) ? turn.findings : [],
    hypotheses: [],
    conclusion,
    confidence,
    rounds: 1,
    totalDurationMs: 0,
    partial: turn.result.partial,
    terminationReason: turn.result.terminationReason as AgentRuntimeAnalysisResult['terminationReason'],
    terminationMessage: turn.result.terminationMessage,
    conclusionContract: turn.result.conclusionContract as AgentRuntimeAnalysisResult['conclusionContract'],
    claimSupport: turn.result.claimSupport,
    claimVerificationResult: turn.result.claimVerificationResult,
    identityResolutions: turn.result.identityResolutions,
  };
}

function annotateRecoveredResultQuality(
  sessionId: string,
  session: AnalysisSession,
  result: AgentRuntimeAnalysisResult,
  query?: string,
): void {
  const issue = applyFinalResultQualityGate({
    result,
    query: query || session.query,
    sceneType: result.conclusionContract?.metadata?.sceneId ??
      resolveAnalysisResultSceneType(session.query, session.dataEnvelopes),
  });
  if (!issue) return;

  const context = sessionContextManager.get(sessionId, session.traceId) || sessionContextManager.get(sessionId);
  context?.annotateLatestCompletedTurn({
    success: result.success,
    findings: result.findings,
    message: result.conclusion,
    confidence: result.confidence,
    partial: result.partial,
    terminationReason: result.terminationReason,
    terminationMessage: result.terminationMessage,
    conclusionContract: result.conclusionContract,
    claimSupport: result.claimSupport,
    claimVerificationResult: result.claimVerificationResult,
    identityResolutions: result.identityResolutions,
  });
}

function recoverResultForSessionIfNeeded(
  sessionId: string,
  session: AnalysisSession,
): AgentRuntimeAnalysisResult | null {
  if (session.result) {
    annotateRecoveredResultQuality(sessionId, session, session.result);
    return session.result;
  }

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return null;
  }

  const recovered = buildRecoveredResultFromContext(sessionId, resolved.context);
  if (!recovered) {
    return null;
  }

  session.result = recovered;
  const turns = resolved.context.getAllTurns();
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  if (latestTurn?.query) {
    session.query = latestTurn.query;
  }
  annotateRecoveredResultQuality(sessionId, session, recovered, latestTurn?.query);
  return recovered;
}

function buildFallbackIntentFromQuery(query?: string): Intent | null {
  const primaryGoal = String(query || '').trim();
  if (!primaryGoal) return null;

  return {
    primaryGoal,
    aspects: [],
    expectedOutputType: 'summary',
    complexity: 'simple',
    followUpType: 'initial',
  };
}

export function resolveConclusionSceneIdHint(params: {
  sessionId: string;
  query?: string;
  findings?: Finding[];
  intent?: Intent;
  dataEnvelopes?: DataEnvelope[];
}): string | undefined {
  const findings = Array.isArray(params.findings) ? params.findings : [];
  let intent = params.intent;

  if (!intent) {
    const resolved = resolveSessionContextForReview(params.sessionId);
    const turn = resolved ? getLastCompletedTurn(resolved.context) : null;
    if (turn?.intent) {
      intent = turn.intent;
    }
  }

  if (!intent) {
    intent = buildFallbackIntentFromQuery(params.query) || undefined;
  }

  if (!intent) return undefined;

  const evidenceAspects = deriveConclusionSceneAspectsFromSkillIds(
    (params.dataEnvelopes || []).map(envelope => envelope.meta?.skillId),
  );
  const routedIntent = evidenceAspects.length > 0
    ? {...intent, aspects: evidenceAspects}
    : intent;

  try {
    return resolveConclusionScene({
      intent: routedIntent,
      findings,
      deepReasonLabel: DEEP_REASON_LABEL,
    }).selectedTemplate.id;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Scene Reconstruction Types (kept for backward-compatible API responses)
// =============================================================================

type SceneCategory =
  | 'cold_start'
  | 'warm_start'
  | 'hot_start'
  | 'scroll_start'
  | 'scroll'
  | 'inertial_scroll'
  | 'navigation'
  | 'app_switch'
  | 'home_screen'
  | 'app_foreground'
  | 'screen_on'
  | 'screen_off'
  | 'screen_sleep'
  | 'screen_unlock'
  | 'notification'
  | 'split_screen'
  | 'tap'
  | 'long_press'
  | 'idle'
  | 'jank_region'
  | 'back_key'
  | 'home_key'
  | 'recents_key'
  | 'anr'
  | 'ime_show'
  | 'ime_hide'
  | 'window_transition';

interface DetectedScene {
  type: SceneCategory;
  startTs: string;
  endTs: string;
  durationMs: number;
  confidence: number;
  appPackage?: string;
  metadata?: Record<string, any>;
}

interface TrackEvent {
  ts: string;
  dur: string;
  name: string;
  category: 'scene' | 'action' | 'performance' | 'finding';
  colorScheme: 'scroll' | 'tap' | 'launch' | 'system' | 'jank' | 'navigation';
  details?: Record<string, any>;
}

// Initialize Agent tools once
let toolsRegistered = false;
const SCENE_STRATEGY_IDS = ['scene_reconstruction', 'scene_reconstruction_quick'];
const MAX_SESSION_DATA_ENVELOPES = 1200;
const MAX_SESSION_AGENT_DIALOGUE = 800;
const MAX_SESSION_AGENT_RESPONSES = 400;
const TERMINAL_SESSION_MAX_IDLE_MS = agentSessionConfig.terminalMaxIdleMs;
const NON_TERMINAL_SESSION_MAX_IDLE_MS = agentSessionConfig.nonTerminalMaxIdleMs;
const AGENT_RUN_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const AGENT_RUN_HEARTBEAT_MAX_STALE_MS = NON_TERMINAL_SESSION_MAX_IDLE_MS;
const SESSION_CLEANUP_INTERVAL_MS = agentSessionConfig.cleanupIntervalMs;
const RUN_SCOPED_SSE_CLIENT_ID = Symbol('smartperfetto.runScopedSseClientId');

type RunScopedSseClient = express.Response & {
  [RUN_SCOPED_SSE_CLIENT_ID]?: string;
};

function setSseClientRunScope(client: express.Response, runId?: string): void {
  if (runId) {
    (client as RunScopedSseClient)[RUN_SCOPED_SSE_CLIENT_ID] = runId;
  } else {
    delete (client as RunScopedSseClient)[RUN_SCOPED_SSE_CLIENT_ID];
  }
}

function filterSseClientsForRun(clients: express.Response[], runId?: string): express.Response[] {
  if (!runId) return clients;
  return clients.filter((client) => {
    const scopedRunId = (client as RunScopedSseClient)[RUN_SCOPED_SSE_CLIENT_ID];
    return !scopedRunId || scopedRunId === runId;
  });
}

function trimSessionArray<T>(items: T[], maxEntries: number): void {
  if (items.length > maxEntries) {
    items.splice(0, items.length - maxEntries);
  }
}

function pushWithSessionCap<T>(items: T[], value: T, maxEntries: number): void {
  items.push(value);
  trimSessionArray(items, maxEntries);
}

function ensureToolsRegistered() {
  if (!toolsRegistered) {
    registerCoreTools();
    toolsRegistered = true;
    console.log('[AgentRoutes] Core tools registered');
  }
}

function isDedicatedSceneReplayRequest(query: string): boolean {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return false;
  return q === '/scene' || q.includes('场景还原') || q.includes('scene reconstruction') || q.includes('scene replay');
}

// ============================================================================
// Main Analysis Endpoints
// ============================================================================

/**
 * POST /api/agent/v1/analyze
 *
 * Start analysis using AgentRuntime
 *
 * Features:
 * - Agent-driven task graph planning
 * - Domain agent evidence collection
 * - Multi-round analysis with strategy planning
 * - DataEnvelope streaming
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "query": "分析这个 trace 的滑动性能",
 *   "options": {
 *     "maxRounds": 5,
 *     "confidenceThreshold": 0.7,
 *     "maxNoProgressRounds": 2,
 *     "maxFailureRounds": 2,
 *     "maxConcurrentTasks": 3
 *   }
 * }
 */
async function handleAnalyzeRequest(
  req: express.Request,
  res: express.Response,
  requestedSessionIdOverride?: string,
): Promise<void> {
  let executionSession: AnalysisSession | undefined;
  let executionRunId: string | undefined;
  let executionRunManifestLifecycle: RunManifestLifecycle | undefined;
  let executionHandedOff = false;
  try {
    const requestId = getRequestId(req);
    const requestContext = requireRequestContext(req);
    const {
      traceId,
      query,
      sessionId: bodyRequestedSessionId,
      options: rawOptions = {},
      selectionContext: rawSelectionContext,
      referenceTraceId,
      traceContext: rawTraceContext,
      providerId,
    } = req.body;
    const requestedSessionId = requestedSessionIdOverride || bodyRequestedSessionId;
    const earlyOutputLanguage: OutputLanguage = rawOptions &&
      typeof rawOptions === 'object' &&
      !Array.isArray(rawOptions) &&
      (rawOptions.outputLanguage === 'en' || rawOptions.outputLanguage === 'zh-CN')
      ? rawOptions.outputLanguage
      : configuredOutputLanguage();
    if (!hasRbacPermission(requestContext, 'agent:run')) {
      sendForbidden(res, 'Starting analysis requires agent:run permission');
      return;
    }

    if (!requireAiEnabledForHttp(res, 'agent_analyze')) {
      return;
    }

    const tenantDecision = evaluateTenantMutationPolicy(requestContext);
    if (!tenantDecision.allowed) {
      res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
      return;
    }

    if (!traceId) {
      res.status(400).json({
        success: false,
        code: 'TRACE_ID_REQUIRED',
        error: localize(earlyOutputLanguage, '缺少 traceId', 'traceId is required'),
      });
      return;
    }

    if (!query) {
      res.status(400).json({
        success: false,
        code: 'QUERY_REQUIRED',
        error: localize(earlyOutputLanguage, '缺少 query', 'query is required'),
      });
      return;
    }

    if (isDedicatedSceneReplayRequest(query)) {
      res.status(400).json({
        success: false,
        code: 'SCENE_REPLAY_SEPARATED',
        error: localize(
          earlyOutputLanguage,
          '场景还原已独立为专用功能',
          'Scene reconstruction is available as a dedicated feature',
        ),
        hint: localize(
          earlyOutputLanguage,
          '请使用 /scene 命令（前端）或 POST /api/agent/v1/scene-reconstruct（后端）',
          'Use the /scene command in the UI or POST /api/agent/v1/scene-reconstruct',
        ),
      });
      return;
    }

    const inheritedReferenceTraceId = resolveVisibleSessionReferenceTraceIdForTrace(
      requestedSessionId,
      traceId,
      requestContext,
    );
    let options: ReturnType<typeof normalizeAnalyzeOptions>;
    try {
      options = normalizeAnalyzeOptions(rawOptions, {
        endpoint: requestedSessionIdOverride ? '/sessions/:id/runs' : '/analyze',
        hasReferenceTraceId: !!referenceTraceId || !!inheritedReferenceTraceId,
        ...(typeof traceId === 'string' ? { traceId } : {}),
        ...(typeof referenceTraceId === 'string'
          ? { referenceTraceId }
          : typeof inheritedReferenceTraceId === 'string'
            ? { referenceTraceId: inheritedReferenceTraceId }
            : {}),
      });
    } catch (error: any) {
      if (error instanceof AnalyzeOptionsError) {
        const requestedErrorLanguage = rawOptions && typeof rawOptions === 'object' &&
          !Array.isArray(rawOptions) && rawOptions.outputLanguage === 'en'
          ? 'en'
          : rawOptions && typeof rawOptions === 'object' &&
              !Array.isArray(rawOptions) && rawOptions.outputLanguage === 'zh-CN'
            ? 'zh-CN'
            : configuredOutputLanguage();
        res.status(error.httpStatus).json({
          success: false,
          error: analyzeOptionsErrorMessage(error, requestedErrorLanguage),
          code: error.code,
        });
        return;
      }
      throw error;
    }
    const requestOutputLanguage = options.outputLanguage ?? configuredOutputLanguage();

    const analysisContextAuthorization = authorizeAnalysisContext({
      selection: options,
      scope: knowledgeScopeFromRequestContext(requestContext),
      outputLanguage: requestOutputLanguage,
      canReadRegisteredContext: hasRbacPermission(requestContext, 'codebase:read'),
    });
    if (!analysisContextAuthorization.allowed) {
      res.status(analysisContextAuthorization.httpStatus)
        .json(analysisContextAuthorization.payload);
      return;
    }

    if (requestedSessionId && !requestedSessionIsVisible(requestedSessionId, requestContext)) {
      sendResourceNotFound(res, 'Session not found');
      return;
    }
    const liveRequestedSession = requestedSessionId
      ? assistantAppService.getSession(requestedSessionId)
      : undefined;
    let validatedSmartPreviewReport: SceneReport | undefined;
    if (
      options.preset === 'smart' &&
      options.smartAction === 'analyze' &&
      smartSelectionReportId(options.smartSelection)
    ) {
      try {
        validatedSmartPreviewReport = await resolveSmartPreviewReportForSelection({
          session: (liveRequestedSession ?? {sceneStoryReport: undefined}) as AnalysisSession,
          selection: options.smartSelection,
          traceId,
          owner: ownerFieldsFromContext(requestContext),
        }) ?? undefined;
      } catch (error) {
        if (error instanceof SmartPreviewSelectionError) {
          res.status(409).json({
            success: false,
            error: smartPreviewSelectionErrorMessage(
              requestOutputLanguage,
              error.reportId,
            ),
            code: error.code,
          });
          return;
        }
        throw error;
      }
    }

    let selectionContext: ReturnType<typeof normalizeSelectionContext>;
    try {
      selectionContext = normalizeSelectionContext(rawSelectionContext);
    } catch (error) {
      if (error instanceof AnalyzeOptionsError) {
        res.status(error.httpStatus).json({
          success: false,
          code: error.code,
          error: analyzeOptionsErrorMessage(error, requestOutputLanguage),
        });
        return;
      }
      throw error;
    }

    // Verify trace exists
    const traceProcessorService = getTraceProcessorService();
    if (!(await ensureTraceAccessible(req, res, traceId))) {
      return;
    }
    const trace = await traceProcessorService.getOrLoadTrace(traceId);
    if (!trace) {
      res.status(404).json({
        success: false,
        error: localize(requestOutputLanguage, '后端中未找到 trace', 'Trace not found in backend'),
        hint: localize(
          requestOutputLanguage,
          '请先将 trace 上传到后端',
          'Please upload the trace to the backend first',
        ),
        code: 'TRACE_NOT_UPLOADED',
      });
      return;
    }

    const validateReferenceTraceForRun = async (candidateReferenceTraceId: string): Promise<TraceInfo | null> => {
      if (candidateReferenceTraceId === traceId) {
        res.status(400).json({
          success: false,
          error: localize(
            requestOutputLanguage,
            'referenceTraceId 必须与 traceId 不同',
            'referenceTraceId must be different from traceId',
          ),
          code: 'SAME_TRACE_COMPARISON',
        });
        return null;
      }
      if (!(await ensureTraceAccessible(
        req,
        res,
        candidateReferenceTraceId,
        'REFERENCE_TRACE_NOT_UPLOADED',
      ))) {
        return null;
      }
      const refTrace = await traceProcessorService.getOrLoadTrace(candidateReferenceTraceId);
      if (!refTrace) {
        res.status(404).json({
          success: false,
          error: localize(
            requestOutputLanguage,
            '后端中未找到对比 trace',
            'Reference trace not found in backend',
          ),
          hint: localize(
            requestOutputLanguage,
            '请先将对比 trace 上传到后端',
            'Please upload the reference trace to the backend first',
          ),
          code: 'REFERENCE_TRACE_NOT_UPLOADED',
        });
        return null;
      }
      return refTrace;
    };

    // Comparison mode: validate reference trace if provided
    let requestedReferenceTrace: TraceInfo | null = null;
    if (referenceTraceId) {
      requestedReferenceTrace = await validateReferenceTraceForRun(referenceTraceId);
      if (!requestedReferenceTrace) return;
      console.log(`[AgentRoutes] Comparison mode: current=${traceId}, reference=${referenceTraceId}`);
    }

    const quotaDecision = evaluateAnalysisRunQuota(requestContext);
    if (!quotaDecision.allowed) {
      sendAgentQuotaDenied(res, quotaDecision);
      return;
    }

    // Initialize tools
    ensureToolsRegistered();

    const analyzeSessionService = new AgentAnalyzeSessionService<AnalysisSession>({
      assistantAppService,
      createSessionLogger,
      sessionPersistenceService: SessionPersistenceService.getInstance(),
      buildRecoveredResultFromContext,
      onSessionSecurityCleanup: revokeCodeAwareOutputGuards,
    });

    let sessionId: string;
    let preparedSession: AnalysisSession | undefined;
    let isNewSession = true;
    if (sendRunStartConflictIfNeeded(res, liveRequestedSession)) return;
    try {
      const analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(
        options,
        knowledgeScopeFromRequestContext(requestContext),
      );
      (options as AnalysisOptions).analysisContextFingerprint = analysisContextFingerprint;
      const availablePack = getDefaultAndroidInternalsPackResolver().resolve();
      if (availablePack) {
        (options as AnalysisOptions).androidInternalsPackPin = {
          contentVersion: availablePack.contentVersion,
          contentFingerprint: availablePack.contentFingerprint,
          sourceRevision: availablePack.sourceRevision,
        };
      }
      const prepared = analyzeSessionService.prepareSession({
        traceId,
        query,
        requestedSessionId,
        referenceTraceId,
        providerId,
        providerScope: {
          tenantId: requestContext.tenantId,
          workspaceId: requestContext.workspaceId,
          userId: requestContext.userId,
        },
        options,
        analysisContextFingerprint,
      });
      sessionId = prepared.sessionId;
      preparedSession = prepared.session as AnalysisSession;
      preparedSession.analysisContextFingerprint = analysisContextFingerprint;
      preparedSession.androidInternalsPackPin ??=
        (options as AnalysisOptions).androidInternalsPackPin;
      (options as AnalysisOptions).androidInternalsPackPin =
        preparedSession.androidInternalsPackPin;
      isNewSession = prepared.isNewSession;
      if (isNewSession) {
        assignSessionOwner(preparedSession, requestContext);
      } else if (!isOwnedByContext(preparedSession, requestContext)) {
        sendResourceNotFound(res, 'Session not found');
        return;
      }
    } catch (error: any) {
      if (error instanceof AnalyzeSessionPreparationError) {
        res.status(error.httpStatus).json({
          success: false,
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
        });
        return;
      }
      throw error;
    }

    const blockedStrategyIds = Array.from(
      new Set([
        ...SCENE_STRATEGY_IDS,
        ...(Array.isArray(options.blockedStrategyIds) ? options.blockedStrategyIds : []),
      ]),
    );
    const sessionForRun = preparedSession || assistantAppService.getSession(sessionId);
    if (!sessionForRun) {
      throw new Error(`Session ${sessionId} not found after preparation`);
    }
    const effectiveReferenceTraceId = referenceTraceId || sessionForRun.referenceTraceId;
    let effectiveReferenceTrace = requestedReferenceTrace;
    if (effectiveReferenceTraceId) {
      if (!effectiveReferenceTrace || effectiveReferenceTraceId !== referenceTraceId) {
        effectiveReferenceTrace = await validateReferenceTraceForRun(effectiveReferenceTraceId);
        if (!effectiveReferenceTrace) return;
      }
      sessionForRun.referenceTraceId = effectiveReferenceTraceId;
      sessionForRun.comparisonSource = 'raw_trace_pair';
    }
    sessionForRun.codeAwareMode = options.codeAwareMode;
    sessionForRun.codebaseIds = Array.isArray(options.codebaseIds) ? options.codebaseIds : undefined;
    sessionForRun.knowledgeSourceIds = Array.isArray(options.knowledgeSourceIds)
      ? options.knowledgeSourceIds
      : undefined;
    if (sessionUsesPrivateKnowledge(sessionForRun)) {
      registerPrivateAnalysisQueryForEcho(sessionId, query);
    }
    if (validatedSmartPreviewReport) {
      sessionForRun.sceneStoryReport = validatedSmartPreviewReport;
    }

    if (sendRunStartConflictIfNeeded(res, sessionForRun)) return;
    const runContext = startSessionRun(sessionForRun, query, requestId);
    if (!runContext) {
      sendRunStartConflictIfNeeded(res, sessionForRun);
      return;
    }
    executionSession = sessionForRun;
    executionRunId = runContext.runId;
    sessionForRun.logger.setMetadata({
      requestId: runContext.requestId,
      runId: runContext.runId,
      runSequence: runContext.sequence,
    });
    const runManifestLifecycle = await createHttpRunManifestLifecycle(
      sessionForRun,
      runContext,
      {
        analysisMode: options.analysisMode,
        referenceTraceId: effectiveReferenceTraceId,
      },
    );
    executionRunManifestLifecycle = runManifestLifecycle;

    if (options.preset === 'smart') {
      const smartAnalysisPromise = withRunManifestLifecycle(
        runManifestLifecycle,
        () => runSmartAnalysis(sessionId, query, traceId, {
          runContext,
          traceProcessorService,
          smartAction: options.smartAction ?? 'preview',
          smartSelection: options.smartSelection,
          forceRefresh: options.forceRefresh === true,
          analysisMode: options.analysisMode,
          blockedStrategyIds,
          owner: ownerFieldsFromContext(requestContext),
          knowledgeScope: knowledgeScopeFromRequestContext(requestContext),
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
          knowledgeSourceIds: options.knowledgeSourceIds,
          runManifestAttributionSink: runManifestLifecycle.builder,
        }),
      )
        .then(() => {
          sealCompletedHttpRunManifest(
            sessionForRun,
            runManifestLifecycle,
            runContext.runId,
          );
        })
        .catch((error) => {
          const session = assistantAppService.getSession(sessionId);
          if (session) {
            const privateKnowledge = sessionUsesPrivateKnowledge(session);
            const publicErrorMessage = privateKnowledge
              ? privateAnalysisFailureMessage(sessionOutputLanguage(session))
              : error.message;
            if (isSessionRunCancelled(session, runContext.runId) || isStaleRun(session, runContext.runId)) {
              session.logger.info('AgentRoutes', 'Ignoring smart analysis failure after cancellation', {
                sessionId,
                runId: runContext.runId,
                error: privateKnowledge ? publicErrorMessage : error?.message || String(error),
              });
              return;
            }
            session.logger.error(
              'AgentRoutes',
              'Smart analysis failed',
              privateKnowledge ? new Error(publicErrorMessage) : error,
            );
            session.status = 'failed';
            session.error = publicErrorMessage;
            markSessionRunStatus(session, 'failed', publicErrorMessage, runContext.runId);
            broadcastToAgentDrivenClients(
              sessionId,
              {
                type: 'error',
                content: { message: publicErrorMessage, error: publicErrorMessage },
                timestamp: Date.now(),
              },
              runContext.runId,
            );
          }
        });
      executionHandedOff = true;
      void smartAnalysisPromise.finally(() => {
        finalizeHttpRunManifestLifecycle(
          sessionForRun,
          runManifestLifecycle,
        );
        settleSessionRunExecution(sessionForRun, runContext.runId);
      });

      res.json({
        success: true,
        sessionId,
        message: isNewSession ? 'Smart analysis started' : 'Smart analysis started',
        isNewSession,
        providerSnapshotChanged: preparedSession?.providerSnapshotChanged || undefined,
        architecture: 'agent-driven',
        preset: 'smart',
        runId: runContext.runId,
        requestId: runContext.requestId,
        runSequence: runContext.sequence,
        observability: {
          runId: runContext.runId,
          requestId: runContext.requestId,
          runSequence: runContext.sequence,
        },
      });
      return;
    }

    let agentRunLease: TraceProcessorLeaseRecord | null = null;
    let referenceAgentRunLease: TraceProcessorLeaseRecord | null = null;
    let agentRunLeaseDecision: TraceProcessorLeaseModeDecision | null = null;
    let referenceAgentRunLeaseDecision: TraceProcessorLeaseModeDecision | null = null;
    if (enterpriseLeasesEnabled()) {
      try {
        const scope = leaseScopeFromRequestContext(requestContext);
        agentRunLeaseDecision = buildLeaseModeDecisionForTrace(scope, traceId, 'agent_run', {
          analysisMode: options.analysisMode,
          traceSizeBytes: trace.size,
        });
        agentRunLease = getTraceProcessorLeaseStore().acquireHolder(
          scope,
          traceId,
          {
            holderType: 'agent_run',
            holderRef: runContext.runId,
            runId: runContext.runId,
            sessionId,
            metadata: {
              requestId: runContext.requestId,
              runSequence: runContext.sequence,
              leaseModeReason: agentRunLeaseDecision.reason,
              leaseModeSignals: agentRunLeaseDecision.signals,
            },
          },
          { mode: agentRunLeaseDecision.mode },
        );
        agentRunLease = markLeaseReadyIfNew(agentRunLease, scope);
        await traceProcessorService.ensureProcessorForLease(traceId, agentRunLease.id, agentRunLease.mode, scope);
      } catch (leaseError: any) {
        if (agentRunLease) {
          try {
            getTraceProcessorLeaseStore().markFailed(leaseScopeFromRequestContext(requestContext), agentRunLease.id);
          } catch (markFailedError: any) {
            console.warn(
              `[AgentRoutes] Failed to mark agent_run lease ${agentRunLease.id} failed: ${markFailedError.message}`,
            );
          }
        }
        if (!isSessionRunCancelled(sessionForRun, runContext.runId) && !isStaleRun(sessionForRun, runContext.runId)) {
          sessionForRun.status = 'failed';
          sessionForRun.error = leaseError.message;
          markSessionRunStatus(sessionForRun, 'failed', leaseError.message, runContext.runId);
        }
        res.status(409).json({
          success: false,
          code: 'TRACE_PROCESSOR_LEASE_UNAVAILABLE',
          error: leaseError.message,
        });
        return;
      }

      const currentLeaseRunIsActive =
        !isSessionRunCancelled(sessionForRun, runContext.runId) && !isStaleRun(sessionForRun, runContext.runId);
      if (effectiveReferenceTraceId && currentLeaseRunIsActive) {
        try {
          const scope = leaseScopeFromRequestContext(requestContext);
          referenceAgentRunLeaseDecision = buildLeaseModeDecisionForTrace(
            scope,
            effectiveReferenceTraceId,
            'agent_run',
            {
              analysisMode: options.analysisMode,
              traceSizeBytes: effectiveReferenceTrace?.size,
            },
          );
          referenceAgentRunLease = getTraceProcessorLeaseStore().acquireHolder(
            scope,
            effectiveReferenceTraceId,
            {
              holderType: 'agent_run',
              holderRef: `${runContext.runId}:reference`,
              runId: runContext.runId,
              sessionId,
              metadata: {
                requestId: runContext.requestId,
                runSequence: runContext.sequence,
                traceSide: 'reference',
                leaseModeReason: referenceAgentRunLeaseDecision.reason,
                leaseModeSignals: referenceAgentRunLeaseDecision.signals,
              },
            },
            { mode: referenceAgentRunLeaseDecision.mode },
          );
          referenceAgentRunLease = markLeaseReadyIfNew(referenceAgentRunLease, scope);
          await traceProcessorService.ensureProcessorForLease(
            effectiveReferenceTraceId,
            referenceAgentRunLease.id,
            referenceAgentRunLease.mode,
            scope,
          );
        } catch (leaseError: any) {
          if (referenceAgentRunLease) {
            try {
              getTraceProcessorLeaseStore().markFailed(
                leaseScopeFromRequestContext(requestContext),
                referenceAgentRunLease.id,
              );
            } catch (markFailedError: any) {
              console.warn(
                `[AgentRoutes] Failed to mark reference agent_run lease ${referenceAgentRunLease.id} failed: ${markFailedError.message}`,
              );
            }
          }
          if (agentRunLease) {
            try {
              getTraceProcessorLeaseStore().releaseHolder(
                leaseScopeFromRequestContext(requestContext),
                agentRunLease.id,
                'agent_run',
                runContext.runId,
              );
            } catch (releaseError: any) {
              console.warn(
                `[AgentRoutes] Failed to release current agent_run lease after reference lease failure ${agentRunLease.id}: ${releaseError.message}`,
              );
            }
          }
          if (!isSessionRunCancelled(sessionForRun, runContext.runId) && !isStaleRun(sessionForRun, runContext.runId)) {
            sessionForRun.status = 'failed';
            sessionForRun.error = leaseError.message;
            markSessionRunStatus(sessionForRun, 'failed', leaseError.message, runContext.runId);
          }
          res.status(409).json({
            success: false,
            code: 'REFERENCE_TRACE_PROCESSOR_LEASE_UNAVAILABLE',
            error: leaseError.message,
          });
          return;
        }
      }
    }

    // Validate traceContext — must be array of objects with columns/rows
    const traceContext = Array.isArray(rawTraceContext)
      ? rawTraceContext.filter(
          (d: any) => d && typeof d === 'object' && Array.isArray(d.columns) && Array.isArray(d.rows),
        )
      : undefined;

    const sessionRunIsInactive =
      isSessionRunCancelled(sessionForRun, runContext.runId) || isStaleRun(sessionForRun, runContext.runId);
    if (sessionRunIsInactive) {
      sessionForRun.logger.info('AgentRoutes', 'Skipping agent-driven analysis for inactive run', {
        sessionId,
        runId: runContext.runId,
      });
    }
    let analysisPromise: Promise<void> = Promise.resolve();
    if (!sessionRunIsInactive) {
      analysisPromise = withRunManifestLifecycle(
        runManifestLifecycle,
        () => runAgentDrivenAnalysis(sessionId, query, traceId, {
          ...options,
          selectionContext,
          blockedStrategyIds,
          traceProcessorService,
          runContext,
          referenceTraceId: effectiveReferenceTraceId,
          traceContext: traceContext && traceContext.length > 0 ? traceContext : undefined,
          providerId: sessionForRun.providerId !== undefined ? sessionForRun.providerId : providerId,
          knowledgeScope: knowledgeScopeFromRequestContext(requestContext),
          runManifestAttributionSink: runManifestLifecycle.builder,
          traceProcessorLease: agentRunLease
            ? {
                traceId,
                leaseId: agentRunLease.id,
                mode: agentRunLease.mode,
                leaseScope: leaseScopeFromRequestContext(requestContext),
              }
            : undefined,
          referenceTraceProcessorLease:
            referenceAgentRunLease && effectiveReferenceTraceId
              ? {
                  traceId: effectiveReferenceTraceId,
                  leaseId: referenceAgentRunLease.id,
                  mode: referenceAgentRunLease.mode,
                  leaseScope: leaseScopeFromRequestContext(requestContext),
                }
              : undefined,
        }),
      )
        .then(() => {
          sealCompletedHttpRunManifest(
            sessionForRun,
            runManifestLifecycle,
            runContext.runId,
          );
        })
        .catch((error) => {
          const session = assistantAppService.getSession(sessionId);
          if (session) {
            const privateKnowledge = sessionUsesPrivateKnowledge(session);
            const publicErrorMessage = privateKnowledge
              ? privateAnalysisFailureMessage(sessionOutputLanguage(session))
              : error?.message || String(error);
            if (isSessionRunCancelled(session, runContext.runId) || isStaleRun(session, runContext.runId)) {
              session.logger.info('AgentRoutes', 'Ignoring agent-driven analysis failure after cancellation', {
                sessionId,
                runId: runContext.runId,
                error: publicErrorMessage,
              });
              return;
            }
            session.logger.error(
              'AgentRoutes',
              'Agent-driven analysis failed',
              privateKnowledge ? new Error(publicErrorMessage) : error,
            );
            session.status = 'failed';
            session.error = publicErrorMessage;
            markSessionRunStatus(session, 'failed', publicErrorMessage, runContext.runId);
            broadcastToAgentDrivenClients(
              sessionId,
              {
                type: 'error',
                content: {message: publicErrorMessage, error: publicErrorMessage},
                timestamp: Date.now(),
              },
              runContext.runId,
            );
          }
        });
    }
    analysisPromise = analysisPromise.finally(() => {
      finalizeHttpRunManifestLifecycle(
        sessionForRun,
        runManifestLifecycle,
      );
    });
    executionHandedOff = true;
    void analysisPromise.finally(() => {
      if (agentRunLease) {
        try {
          getTraceProcessorLeaseStore().releaseHolder(
            leaseScopeFromRequestContext(requestContext),
            agentRunLease.id,
            'agent_run',
            runContext.runId,
          );
        } catch (releaseError: any) {
          console.warn(`[AgentRoutes] Failed to release agent_run lease ${agentRunLease.id}: ${releaseError.message}`);
        }
      }
      if (referenceAgentRunLease) {
        try {
          getTraceProcessorLeaseStore().releaseHolder(
            leaseScopeFromRequestContext(requestContext),
            referenceAgentRunLease.id,
            'agent_run',
            `${runContext.runId}:reference`,
          );
        } catch (releaseError: any) {
          console.warn(
            `[AgentRoutes] Failed to release reference agent_run lease ${referenceAgentRunLease.id}: ${releaseError.message}`,
          );
        }
      }
      settleSessionRunExecution(sessionForRun, runContext.runId);
    });

    res.json({
      success: true,
      sessionId,
      message: preparedSession?.providerSnapshotChanged
        ? 'Provider configuration changed; continuing with a fresh SDK session'
        : isNewSession
          ? 'Analysis started'
          : 'Continuing analysis (multi-turn)',
      isNewSession,
      providerSnapshotChanged: preparedSession?.providerSnapshotChanged || undefined,
      architecture: 'agent-driven',
      runId: runContext.runId,
      leaseId: agentRunLease?.id,
      leaseState: agentRunLease?.state,
      leaseMode: agentRunLease?.mode,
      leaseModeReason: agentRunLeaseDecision?.reason,
      leaseQueueLength: agentRunLeaseDecision?.signals.sharedQueueLength,
      referenceLeaseId: referenceAgentRunLease?.id,
      referenceLeaseState: referenceAgentRunLease?.state,
      referenceLeaseMode: referenceAgentRunLease?.mode,
      referenceLeaseModeReason: referenceAgentRunLeaseDecision?.reason,
      requestId: runContext.requestId,
      runSequence: runContext.sequence,
      observability: {
        runId: runContext.runId,
        requestId: runContext.requestId,
        runSequence: runContext.sequence,
      },
    });
  } catch (error: any) {
    if (sendAiDisabledErrorIfPresent(res, error)) {
      return;
    }
    console.error('[AgentRoutes] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Agent analysis failed',
    });
  } finally {
    if (!executionHandedOff && executionSession && executionRunId) {
      if (executionRunManifestLifecycle) {
        finalizeHttpRunManifestLifecycle(
          executionSession,
          executionRunManifestLifecycle,
        );
      }
      settleSessionRunExecution(executionSession, executionRunId);
    }
  }
}

registerAgentConversationRoutes(router);

router.post('/analyze', async (req, res) => {
  await handleAnalyzeRequest(req, res);
});

router.post('/sessions/:sessionId/runs', async (req, res) => {
  await handleAnalyzeRequest(req, res, req.params.sessionId);
});

/**
 * GET /api/agent/v1/:sessionId/stream
 *
 * SSE endpoint for real-time analysis updates
 *
 * Events:
 * - connected: SSE connection established
 * - conversation_step: Ordered conversational timeline step
 * - progress: Progress updates (task graph, rounds, strategy)
 * - data: DataEnvelope(s) from skill execution
 * - agent_task_dispatched: Task sent to domain agent
 * - agent_response: Agent completed task
 * - synthesis_complete: Feedback synthesis complete
 * - strategy_decision: Next iteration strategy decided
 * - analysis_completed: Final analysis result
 * - error: Error occurred
 * - end: Stream ended
 */
function resolveReplayBufferForStream(session: AnalysisSession, runId?: string): BufferedSseEvent[] {
  const targetRunId = runId || getSessionRunId(session);
  if (runId && !isCurrentRunOwner(session, runId)) {
    const byKey = new Map<string, BufferedSseEvent>();
    for (const event of [
      ...session.sseEventBuffer.filter((candidate) => candidate.runId === runId),
      ...getRunSseReplayState(session, runId).sseEventBuffer.filter((candidate) => candidate.runId === runId),
    ]) {
      byKey.set(`${event.seqId}:${event.eventType}:${event.runId || ''}`, event);
    }
    return Array.from(byKey.values()).sort((a, b) => a.seqId - b.seqId);
  }
  const source = session.sseEventBuffer;
  if (!targetRunId) return source;
  return source.filter((event) => !event.runId || event.runId === targetRunId);
}

function handleSessionStream(
  req: express.Request,
  res: express.Response,
  sessionId: string,
  options: { runId?: string } = {},
): void {
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;
  const streamRunId = options.runId;
  const streamRun = resolveSessionRun(session, streamRunId);
  if (streamRunId && !streamRun) {
    sendResourceNotFound(res, 'Run not found');
    return;
  }
  const streamStatus = streamRun?.status || session.status;

  // Check for Last-Event-ID (reconnect replay support). The header is the
  // canonical fetch-stream path; the query param is kept for older clients.
  const lastEventId = parseLastEventId(req.headers['last-event-id'], req.query.lastEventId);

  streamProjector.setSseHeaders(res);
  streamProjector.sendConnected(res, {
    sessionId,
    status: streamStatus,
    traceId: session.traceId,
    query: connectedStreamQuery(session, streamRun),
    architecture: 'agent-driven',
    timestamp: Date.now(),
    ...buildStreamObservability(session, streamRunId),
  });

  if (lastEventId !== null && (streamStatus === 'completed' || streamStatus === 'quota_exceeded')) {
    recoverResultForSessionIfNeeded(sessionId, session);
    if (session.result) {
      sendAgentDrivenResult(res, session, streamRunId);
      res.end();
      return;
    }
  }

  const shouldReplayInitialSessionBuffer =
    lastEventId === null &&
    !streamRunId &&
    (streamStatus === 'pending' ||
      streamStatus === 'running' ||
      streamStatus === 'awaiting_user' ||
      streamStatus === 'completed' ||
      streamStatus === 'quota_exceeded' ||
      streamStatus === 'failed' ||
      streamStatus === 'cancelled');
  const persistedReplayFrom = streamRunId && lastEventId === null ? 0 : lastEventId;
  let ringReplayAfter = persistedReplayFrom;
  if (persistedReplayFrom !== null) {
    const persistedReplay = replayPersistedAgentEvents(session, res, persistedReplayFrom, streamRunId);
    ringReplayAfter = persistedReplay.lastCursor;
    if (persistedReplay.replayed > 0) {
      console.log(
        `[AgentRoutes] Replayed ${persistedReplay.replayed} persisted SSE events for ${sessionId} ` +
          `(after seqId ${persistedReplayFrom})`,
      );
    }
    if (persistedReplay.includesTerminal) {
      res.end();
      return;
    }
  }

  if (ringReplayAfter === null && shouldReplayInitialSessionBuffer) {
    ringReplayAfter = 0;
  }

  const replayBuffer = resolveReplayBufferForStream(session, streamRunId);
  if (ringReplayAfter !== null && replayBuffer.length > 0) {
    const replayState = {
      sseEventSeq: Math.max(0, ...replayBuffer.map((event) => event.seqId)),
      sseEventBuffer: replayBuffer,
    };
    const replayIncludesTerminal = hasTerminalReplayAfter(replayState, ringReplayAfter);
    const replayed = streamProjector.replayBufferedEvents(res, replayBuffer, ringReplayAfter);
    if (replayed > 0) {
      console.log(
        `[AgentRoutes] Replayed ${replayed} missed SSE events for ${sessionId} (after seqId ${ringReplayAfter})`,
      );
    }
    if (replayIncludesTerminal) {
      res.end();
      return;
    }
  }

  // Add client to session
  if (streamRunId && !isCurrentRunOwner(session, streamRunId)) {
    res.end();
    return;
  }

  setSseClientRunScope(res, streamRunId);
  assistantAppService.addSseClient(sessionId, res);
  console.log(`[AgentRoutes] SSE client connected for ${sessionId}`);

  // If analysis is already completed, send the result.
  // Resumed sessions may not have session.result in memory; recover from persisted turn context.
  if (streamStatus === 'completed' || streamStatus === 'quota_exceeded') {
    recoverResultForSessionIfNeeded(sessionId, session);
    if (session.result) {
      sendAgentDrivenResult(res, session, streamRunId);
      res.end();
      assistantAppService.removeSseClient(sessionId, res);
      return;
    }
  }

  // If analysis failed, send error
  if (streamStatus === 'failed') {
    sendReplayableSessionEvent(
      session,
      res,
      'error',
      {
        error: session.error,
        message: session.error,
        timestamp: Date.now(),
        ...buildStreamObservability(session, streamRunId),
      },
      streamRunId,
    );
    sendReplayableSessionEvent(
      session,
      res,
      'end',
      {
        timestamp: Date.now(),
        ...buildStreamObservability(session, streamRunId),
      },
      streamRunId,
    );
    res.end();
    assistantAppService.removeSseClient(sessionId, res);
    return;
  }

  if (streamStatus === 'cancelled') {
    const terminalEvents = getCancellationTerminalEvents(
      session,
      session.error || session.cancelState?.reason || 'Analysis cancelled by user',
      streamRunId,
    );
    writeSessionEventsToClient(res, terminalEvents);
    res.end();
    assistantAppService.removeSseClient(sessionId, res);
    return;
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[AgentRoutes] SSE client disconnected for ${sessionId}`);
    assistantAppService.removeSseClient(sessionId, res);
  });

  // Handle write errors (EPIPE when client disconnects mid-write).
  // Without this handler, EPIPE propagates as uncaughtException and can crash
  // the SDK subprocess (which inherits the process's pipe state).
  res.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      // Expected when SSE client disconnects (e.g., curl timeout, browser navigation)
      assistantAppService.removeSseClient(sessionId, res);
      return;
    }
    console.error(`[AgentRoutes] SSE response error for ${sessionId}:`, err.message);
  });

  streamProjector.bindKeepAlive(req, res);
}

function connectedStreamQuery(
  session: AnalysisSession,
  streamRun?: AnalyzeSessionRunContext,
): string {
  return sessionUsesPrivateKnowledge(session)
    ? privateAnalysisQueryMessage(sessionOutputLanguage(session))
    : streamRun?.query ?? session.query;
}

router.get('/:sessionId/stream', (req, res) => {
  handleSessionStream(req, res, req.params.sessionId);
});

router.get('/runs/:runId/stream', (req, res) => {
  const session = getAuthorizedSessionByRunId(req, res, req.params.runId);
  if (!session) return;
  handleSessionStream(req, res, session.sessionId, { runId: req.params.runId });
});

/**
 * GET /api/agent/v1/:sessionId/status
 *
 * Get analysis status (for polling)
 */
router.get('/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;

  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  const response: any = {
    success: true,
    sessionId,
    status: session.status,
    traceId: session.traceId,
    query: sessionUsesPrivateKnowledge(session)
      ? privateAnalysisQueryMessage(sessionOutputLanguage(session))
      : session.query,
    createdAt: session.createdAt,
    observability: buildSessionObservability(session),
  };

  if (session.status === 'completed' || session.status === 'quota_exceeded') {
    const recoveredResult = recoverResultForSessionIfNeeded(sessionId, session);
    if (recoveredResult) {
      const conclusion = normalizeNarrativeForClient(recoveredResult.conclusion);
      const clientFindings = buildClientFindings(recoveredResult.findings, session.scenes || []);
      const resultContract = buildSessionResultContract(session, clientFindings);
      const sceneIdHint = resolveConclusionSceneIdHint({
        sessionId,
        query: session.query,
        findings: recoveredResult.findings,
        dataEnvelopes: session.dataEnvelopes,
      });
      const conclusionContract =
        deriveEvidenceBackedConclusionContractForNarrative(recoveredResult.conclusion, session.dataEnvelopes || [], {
          existingContract: recoveredResult.conclusionContract as ConclusionContract | undefined,
          mode: recoveredResult.rounds > 1 ? 'focused_answer' : 'initial_report',
          sceneId: sceneIdHint,
        }) || undefined;
      const qualityArtifacts =
        recoveredResult.claimSupport && recoveredResult.claimVerificationResult && recoveredResult.identityResolutions
          ? {
              claimSupport: recoveredResult.claimSupport,
              claimVerificationResult: recoveredResult.claimVerificationResult,
              identityResolutions: recoveredResult.identityResolutions,
            }
          : ensureAnalysisQualityArtifacts(session, conclusionContract, recoveredResult);
      const completedPayload = ensureCompletedAnalysisResultPayload(session);
      const finalArtifacts = completedPayload?.finalArtifacts;
      const rawCompletedConclusion = completedPayload?.normalizedConclusion || conclusion;
      const normalizedCompletedContract = completedPayload?.normalizedConclusionContract || conclusionContract;
      const privateKnowledge = sessionUsesPrivateKnowledge(session);
      const outputLanguage = sessionOutputLanguage(session);
      const normalizedCompletedConclusion = privateKnowledge
        ? projectPrivateConclusion({
            sessionId,
            conclusion: rawCompletedConclusion,
            success: recoveredResult.success,
            language: outputLanguage,
          })
        : rawCompletedConclusion;
      const projectedCompletedContract = privateKnowledge
        ? projectPrivateStructuredValue(sessionId, normalizedCompletedContract)
        : normalizedCompletedContract;
      const projectedQualityArtifacts = privateKnowledge
        ? projectPrivateStructuredValue(sessionId, qualityArtifacts)
        : qualityArtifacts;
      const projectedFindings = privateKnowledge
        ? projectPrivateStructuredValue(sessionId, clientFindings)
        : clientFindings;
      response.result = {
        answer: normalizedCompletedConclusion,
        conclusion: normalizedCompletedConclusion,
        conclusionContract: projectedCompletedContract,
        claimSupport: projectedQualityArtifacts.claimSupport,
        claimVerificationResult: projectedQualityArtifacts.claimVerificationResult,
        identityResolutions: projectedQualityArtifacts.identityResolutions,
        confidence: recoveredResult.confidence,
        totalDurationMs: recoveredResult.totalDurationMs,
        rounds: recoveredResult.rounds,
        partial: recoveredResult.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(recoveredResult.terminationReason)
          : recoveredResult.terminationReason,
        terminationMessage: privateKnowledge
          ? projectPrivateTerminationMessage(recoveredResult.terminationMessage, outputLanguage)
          : recoveredResult.terminationMessage,
        reportUrl: finalArtifacts?.reportUrl,
        reportError: privateKnowledge ? undefined : finalArtifacts?.reportError,
        resultSnapshotId: finalArtifacts?.resultSnapshotId,
        analysisReceipt: privateKnowledge
          ? projectPrivateAnalysisReceipt(completedPayload?.analysisReceipt)
          : completedPayload?.analysisReceipt,
        uiActionProposals: privateKnowledge
          ? projectPrivateStructuredValue(sessionId, completedPayload?.uiActionProposals || [])
          : completedPayload?.uiActionProposals,
        findings: projectedFindings,
        findingsCount: projectedFindings.length,
        resultContract: privateKnowledge
          ? projectPrivateStructuredValue(sessionId, resultContract)
          : resultContract,
      };
    }
  }

  if (session.status === 'failed' || session.status === 'cancelled') {
    response.error = sessionUsesPrivateKnowledge(session)
      ? privateAnalysisFailureMessage(sessionOutputLanguage(session))
      : session.error;
  }

  res.json(response);
});

/**
 * GET /api/agent/v1/:sessionId/turns
 *
 * List persisted turns for a session.
 * Supports in-memory sessions and persisted (recoverable) sessions.
 *
 * Query params:
 * - limit: default 20, max 200
 * - offset: default 0
 * - order: asc | desc (default desc)
 */
router.get('/:sessionId/turns', (req, res) => {
  const { sessionId } = req.params;
  const rawLimit = parseInt(String(req.query.limit || '20'), 10);
  const rawOffset = parseInt(String(req.query.offset || '0'), 10);
  const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return res.status(404).json({
      success: false,
      error: 'Session context not found',
      hint: 'Session may not exist or was not persisted with context snapshots',
    });
  }
  if (!isResolvedSessionAccessible(req, resolved)) {
    return sendResourceNotFound(res, 'Session context not found');
  }
  const privateSelection = assistantAppService.getSession(sessionId) ??
    SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId) ?? {};
  const privateSessionId = sessionUsesPrivateKnowledge(privateSelection) ? sessionId : undefined;
  const outputLanguage = sessionOutputLanguage(privateSelection);

  const allTurns = resolved.context.getAllTurns();
  const ordered = order === 'desc' ? [...allTurns].reverse() : [...allTurns];
  const paged = ordered.slice(offset, offset + limit);

  const latestTurn = allTurns.length > 0 ? allTurns[allTurns.length - 1] : null;

  return res.json({
    success: true,
    sessionId,
    traceId: resolved.traceId,
    source: resolved.source,
    query: privateSessionId
      ? privateAnalysisQueryMessage(outputLanguage)
      : resolved.query,
    createdAt: resolved.createdAt,
    totalTurns: allTurns.length,
    turns: paged.map(turn => buildTurnSummary(turn, privateSessionId, outputLanguage)),
    latestTurn: latestTurn
      ? buildTurnSummary(latestTurn, privateSessionId, outputLanguage)
      : null,
    pagination: {
      limit,
      offset,
      order,
      hasMore: offset + limit < ordered.length,
    },
  });
});

/**
 * GET /api/agent/v1/:sessionId/turns/:turnId
 *
 * Get details for a specific turn.
 * `turnId` supports:
 * - UUID turn ID
 * - numeric turn index (0-based or 1-based)
 * - literal `latest`
 */
router.get('/:sessionId/turns/:turnId', (req, res) => {
  const { sessionId, turnId } = req.params;

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return res.status(404).json({
      success: false,
      error: 'Session context not found',
      hint: 'Session may not exist or was not persisted with context snapshots',
    });
  }
  if (!isResolvedSessionAccessible(req, resolved)) {
    return sendResourceNotFound(res, 'Session context not found');
  }
  const privateSelection = assistantAppService.getSession(sessionId) ??
    SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId) ?? {};
  const privateSessionId = sessionUsesPrivateKnowledge(privateSelection) ? sessionId : undefined;
  const outputLanguage = sessionOutputLanguage(privateSelection);

  const turns = resolved.context.getAllTurns();
  if (turns.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'No turns recorded for this session',
    });
  }

  let turn: ConversationTurn | undefined;
  if (turnId === 'latest') {
    turn = turns[turns.length - 1];
  } else {
    turn = turns.find((t) => t.id === turnId);
    if (!turn && /^\d+$/.test(turnId)) {
      const parsed = parseInt(turnId, 10);
      turn = turns.find((t) => t.turnIndex === parsed) || turns.find((t) => t.turnIndex === parsed - 1);
    }
  }

  if (!turn) {
    return res.status(404).json({
      success: false,
      error: `Turn not found: ${turnId}`,
      hint: 'Use /api/agent/v1/:sessionId/turns to inspect available turn IDs',
    });
  }

  const previousTurn = turns.find((t) => t.turnIndex === turn!.turnIndex - 1) || null;
  const nextTurn = turns.find((t) => t.turnIndex === turn!.turnIndex + 1) || null;

  return res.json({
    success: true,
    sessionId,
    traceId: resolved.traceId,
    source: resolved.source,
    turn: buildTurnDetail(turn, privateSessionId, outputLanguage),
    navigation: {
      previousTurnId: previousTurn?.id || null,
      nextTurnId: nextTurn?.id || null,
      previousTurnIndex: previousTurn?.turnIndex ?? null,
      nextTurnIndex: nextTurn?.turnIndex ?? null,
    },
  });
});

/**
 * DELETE /api/agent/v1/:sessionId
 *
 * Clean up an analysis session
 */
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  // Close all SSE connections
  session.sseClients.forEach((client) => {
    try {
      client.end();
    } catch {}
  });

  // Clean up session-scoped state only — do NOT call reset() which clears
  // global caches (architectureCache) shared across all active sessions.
  await abortAndCleanupSession(sessionId, session, 'AgentRoutes');
  // Also clean up the EnhancedSessionContext (EntityStore, turns, working memory)
  sessionContextManager.remove(sessionId);
  assistantAppService.deleteSession(sessionId);

  res.json({ success: true });
});

function privateFeedbackResponse(input: {
  durable: boolean;
  eventId?: string;
  feedbackId?: string;
}) {
  return {
    success: true,
    schemaVersion: 1 as const,
    durableFeedbackStored: input.durable,
    storageDisposition: 'stored_private_local' as const,
    ...(input.eventId ? {eventId: input.eventId} : {}),
    ...(input.feedbackId ? {feedbackId: input.feedbackId} : {}),
    patternStatus: null,
    caseCandidateFeedbackAdded: null,
  };
}

function feedbackTargetBelongsToSession(
  session: AnalysisSession,
  targetKind: string,
  targetId: string,
  runId: string,
  manifest: ReturnType<ReturnType<typeof getRunManifestStore>['getByRunId']>,
): boolean {
  if (targetKind === 'session') return targetId === session.sessionId;
  if (targetKind === 'conclusion') {
    return targetId === runId || targetId === session.sessionId;
  }
  if (targetKind === 'finding') {
    const findings = [
      ...((session.result as any)?.findings ?? []),
      ...((session as any).findings ?? []),
    ];
    return findings.some((finding: any) =>
      finding?.id === targetId || finding?.findingId === targetId);
  }
  if (targetKind === 'claim') {
    return (session.claimSupport ?? []).some((claim: any) =>
      claim?.claimId === targetId || claim?.id === targetId);
  }
  if (targetKind === 'evidence') {
    return (session.dataEnvelopes ?? []).some((envelope: any) =>
      envelope?.meta?.evidenceRefId === targetId ||
      envelope?.evidenceRefId === targetId);
  }
  if (targetKind === 'skill_note') {
    return manifest?.injections.skillNotes.some(note => note.id === targetId) ??
      false;
  }
  if (targetKind === 'injection') {
    if (!manifest) return false;
    return Object.values(manifest.injections)
      .flat()
      .some(reference => reference.id === targetId);
  }
  return false;
}

/**
 * POST /api/agent/v1/:sessionId/feedback
 *
 * Submit user feedback on analysis quality (thumbs up/down + optional comment).
 * Stored as append-only JSONL in logs/feedback/ with versioned schema
 * (see backend/src/agentv3/selfImprove/feedbackEnricher.ts).
 */
router.post('/:sessionId/feedback', async (req, res) => {
  const { sessionId } = req.params;

  const validated = validateFeedbackInput(req.body);
  if (!validated.ok) {
    return res.status(400).json({ success: false, error: validated.error });
  }

  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;
  const requestContext = requireRequestContext(req);
  if (!hasRbacPermission(requestContext, 'agent:run')) {
    return sendForbidden(res, 'Feedback mutation requires agent:run');
  }
  const feedbackKnowledgeScope = knowledgeScopeFromRequestContext(
    requestContext,
  );
  const targetRun = resolveSessionRun(session, validated.value.runId);
  if (!targetRun) {
    return res.status(404).json({
      success: false,
      error: 'Feedback run not found in session',
    });
  }
  const resolvedFeedbackScope = resolveKnowledgeScope(feedbackKnowledgeScope);
  const runManifest = getRunManifestStore().getByRunId(
    resolvedFeedbackScope,
    targetRun.runId,
  );
  const targetKind = validated.value.targetKind ??
    (validated.value.patternId
      ? 'pattern'
      : validated.value.caseCandidateId
        ? 'case_candidate'
        : 'session');
  const targetId = validated.value.targetId ??
    validated.value.patternId ??
    validated.value.caseCandidateId ??
    sessionId;
  if (
    validated.value.patternId &&
    (targetKind !== 'pattern' || targetId !== validated.value.patternId)
  ) {
    return res.status(400).json({
      success: false,
      error: 'patternId must identify a pattern target',
    });
  }
  if (
    validated.value.caseCandidateId &&
    (
      targetKind !== 'case_candidate' ||
      targetId !== validated.value.caseCandidateId
    )
  ) {
    return res.status(400).json({
      success: false,
      error: 'caseCandidateId must identify a case_candidate target',
    });
  }
  if (targetKind === 'pattern') {
    if (!patternExistsForFeedback(targetId, feedbackKnowledgeScope)) {
      return res.status(404).json({success: false, error: 'Pattern not found'});
    }
  } else if (targetKind === 'case_candidate') {
    const outbox = openCaseCandidateOutbox();
    try {
      const candidate = outbox.getCandidate(targetId);
      const candidateScope = candidate
        ? caseCandidateKnowledgeScope(candidate.candidate)
        : null;
      if (
        !candidate ||
        !candidateScope ||
        candidateScope.tenantId !== resolvedFeedbackScope.tenantId ||
        candidateScope.workspaceId !== resolvedFeedbackScope.workspaceId
      ) {
        return res.status(404).json({
          success: false,
          error: 'Case candidate not found',
        });
      }
    } finally {
      outbox.close();
    }
  } else if (!feedbackTargetBelongsToSession(
    session,
    targetKind,
    targetId,
    targetRun.runId,
    runManifest,
  )) {
    return res.status(404).json({
      success: false,
      error: 'Feedback target not found in session run',
    });
  }

  const idempotencyKey = validated.value.idempotencyKey ??
    (typeof req.header('Idempotency-Key') === 'string'
      ? req.header('Idempotency-Key')!
      : randomUUID());
  const eventInput: AppendFeedbackEventInput = {
    kind: validated.value.eventKind ?? 'created',
    feedbackId: validated.value.feedbackId,
    supersedesEventId: validated.value.supersedesEventId,
    idempotencyKey,
    runId: targetRun.runId,
    runManifestId: runManifest?.runManifestId,
    sessionId,
    rating: validated.value.rating,
    dimensions: validated.value.dimensions,
    comment: validated.value.comment,
    targetKind,
    targetId,
    patternId: validated.value.patternId,
    caseCandidateId: validated.value.caseCandidateId,
    source: validated.value.source ?? 'ui',
    actor: {
      userId: requestContext.userId,
      permissionSnapshot: 'agent:run',
    },
    scope: {
      tenantId: resolvedFeedbackScope.tenantId,
      workspaceId: resolvedFeedbackScope.workspaceId,
    },
  };

  let store: FeedbackEventStore | null = null;
  try {
    if (sessionUsesPrivateKnowledge(session)) {
      const persistence =
        getSelfEvolutionLifecycleSnapshot().persistence.persistence ===
        'available';
      const paths = privateFeedbackStorePaths({
        scope: eventInput.scope,
        userId: requestContext.userId,
        durable: persistence,
      });
      store = new FeedbackEventStore({
        scope: eventInput.scope,
        ...paths,
      });
      const appended = await store.append(eventInput);
      for (const target of store.listDirtyTargets()) {
        store.markTargetApplied(target);
      }
      return res.json(privateFeedbackResponse({
        durable: appended.storage === 'durable',
        eventId: appended.event.eventId,
        feedbackId: appended.event.feedbackId,
      }));
    }

    store = new FeedbackEventStore({scope: eventInput.scope});
    const projected = await new FeedbackProjectionService({
      store,
      knowledgeScope: feedbackKnowledgeScope,
    }).append(eventInput);
    return res.json({
      success: true,
      schemaVersion: projected.event.schemaVersion,
      eventId: projected.event.eventId,
      feedbackId: projected.event.feedbackId,
      idempotencyKey: projected.event.idempotencyKey,
      idempotent: projected.idempotent,
      durableFeedbackStored: true,
      storageDisposition: 'stored_scoped',
      patternStatus: projected.patternStatus,
      caseCandidateFeedbackAdded:
        projected.caseCandidateProjection?.found ?? null,
    });
  } catch (err) {
    console.error('[Feedback] Failed to save feedback:', (err as Error).message);
    const code = (err as Error).message;
    const conflict = code === 'legacy_feedback_not_retractable' ||
      code.startsWith('feedback_supersedes_') ||
      code === 'feedback_idempotency_conflict' ||
      code === 'feedback_id_conflict';
    return res.status(conflict ? 409 : 500).json({
      success: false,
      error: code,
      idempotencyKey,
    });
  } finally {
    store?.close();
  }
});

/**
 * POST /api/agent/v1/:sessionId/respond
 *
 * Respond to an interactive session (e.g. continue/abort).
 *
 * Note: AgentRuntime currently does not pause for user input in v2;
 * this endpoint mainly exists for API compatibility and future multi-turn UX.
 */
async function handleSessionRespond(req: express.Request, res: express.Response, sessionId: string): Promise<void> {
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  const action = req.body?.action;
  const allowedActions = new Set(['continue', 'abort']);

  if (!action || typeof action !== 'string' || !allowedActions.has(action)) {
    res.status(400).json({
      success: false,
      error: `Invalid action: ${String(action)}. Allowed: continue, abort`,
    });
    return;
  }

  if (action === 'abort') {
    const runId = readRequiredCancellationRunId(req.body?.runId);
    if (!runId) {
      res.status(400).json({
        success: false,
        sessionId,
        code: 'RUN_ID_REQUIRED',
        error: 'runId is required for abort',
      });
      return;
    }
    const result = await cancelSessionRun(sessionId, runId, 'Aborted by user');
    if (!result) {
      sendResourceNotFound(res, 'Session not found');
      return;
    }
    sendCancelSessionRunResult(res, result);
    return;
  }

  // continue
  if (session.status !== 'awaiting_user') {
    res.status(400).json({
      success: false,
      error: `Session is not awaiting user input (current status: ${session.status})`,
    });
    return;
  }

  session.status = 'running';
  res.json({ success: true, sessionId, status: session.status });
}

router.post('/:sessionId/respond', (req, res, next) => {
  void handleSessionRespond(req, res, req.params.sessionId).catch(next);
});

router.post('/sessions/:sessionId/respond', (req, res, next) => {
  void handleSessionRespond(req, res, req.params.sessionId).catch(next);
});

// =============================================================================
// Agent-Driven Architecture v2.0 - Cancel and Focus Endpoints
// =============================================================================

/**
 * POST /api/agent/v1/:sessionId/interaction
 *
 * Record user interaction from the frontend.
 * Used to update the FocusStore for incremental analysis support.
 *
 * Request body:
 * {
 *   type: 'click' | 'query' | 'drill_down' | 'compare' | 'extend' | 'explicit',
 *   target: {
 *     entityType?: 'frame' | 'process' | 'thread' | 'session',
 *     entityId?: string,
 *     timeRange?: { start: string, end: string },  // ns as string
 *     metricName?: string,
 *     question?: string
 *   },
 *   context?: Record<string, any>  // Additional context
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focusCount: number  // Current number of tracked focuses
 * }
 */
// P1-4: Cancel endpoint — allows frontend to signal the backend to stop analysis
router.post('/:sessionId/cancel', async (req, res) => {
  const { sessionId } = req.params;
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  const runId = readRequiredCancellationRunId(req.body?.runId);
  if (!runId) {
    return res.status(400).json({
      success: false,
      sessionId,
      code: 'RUN_ID_REQUIRED',
      error: 'runId is required for cancellation',
    });
  }

  const result = await cancelSessionRun(sessionId, runId, 'Analysis cancelled by user');
  if (!result) return sendResourceNotFound(res, 'Session not found');
  return sendCancelSessionRunResult(res, result);
});

router.post('/:sessionId/interaction', async (req, res) => {
  const { sessionId } = req.params;
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  const { type, target, context } = req.body;

  // Validate type
  const allowedTypes = new Set(['click', 'query', 'drill_down', 'compare', 'extend', 'explicit']);
  if (!type || !allowedTypes.has(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid interaction type: ${String(type)}. Allowed: ${Array.from(allowedTypes).join(', ')}`,
    });
  }

  // Validate target
  if (!target || typeof target !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'target is required and must be an object',
    });
  }

  try {
    // Convert timeRange strings to BigInt if present
    const processedTarget = { ...target };
    if (target.timeRange) {
      processedTarget.timeRange = {
        start: BigInt(target.timeRange.start),
        end: BigInt(target.timeRange.end),
      };
    }

    // Build interaction
    const interaction: FocusInteraction = {
      type,
      target: processedTarget,
      source: 'ui',
      timestamp: Date.now(),
      context,
    };

    // Record the interaction — ClaudeRuntime (agentv3) doesn't implement these methods.
    if (typeof session.orchestrator.recordUserInteraction === 'function') {
      session.orchestrator.recordUserInteraction(interaction);
      const focusStore =
        typeof session.orchestrator.getFocusStore === 'function' ? session.orchestrator.getFocusStore() : null;
      const focusCount = focusStore ? focusStore.getTopFocuses(100).length : 0;
      return res.json({ success: true, sessionId, focusCount });
    }

    return res.json({ success: true, sessionId, focusCount: 0 });
  } catch (error: any) {
    console.error(`[Interaction] Error recording interaction for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to record interaction',
    });
  }
});

/**
 * GET /api/agent/v1/:sessionId/focus
 *
 * Get current user focus state for a session.
 * Useful for debugging and displaying focus indicators in the UI.
 *
 * Query params:
 * - limit: Max number of focuses to return (default: 10)
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focuses: UserFocus[],
 *   context: string  // LLM-ready focus context summary
 * }
 */
router.get('/:sessionId/focus', (req, res) => {
  const { sessionId } = req.params;
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session) return;

  try {
    // ClaudeRuntime (agentv3) doesn't implement getFocusStore — return empty.
    if (typeof session.orchestrator.getFocusStore !== 'function') {
      return res.json({ success: true, sessionId, focuses: [], context: '' });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const focusStore = session.orchestrator.getFocusStore();

    // Get top focuses
    const focuses = focusStore.getTopFocuses(limit).map((f: any) => ({
      id: f.id,
      type: f.type,
      target: {
        ...f.target,
        // Convert BigInt to string for JSON serialization
        ...(f.target.timeRange && {
          timeRange: {
            start: String(f.target.timeRange.start),
            end: String(f.target.timeRange.end),
          },
        }),
      },
      weight: f.weight,
      lastInteractionTime: f.lastInteractionTime,
      interactionCount: f.interactionHistory.length,
    }));

    // Get LLM-ready context
    const context = focusStore.buildFocusContext();

    return res.json({
      success: true,
      sessionId,
      focuses,
      context,
    });
  } catch (error: any) {
    console.error(`[Focus] Error getting focus for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get focus state',
    });
  }
});

registerAgentSessionCatalogRoutes(router, {
  sessionStore: assistantAppService,
  buildSessionObservability,
});

registerAgentResumeRoutes(router, {
  sessionStore: assistantAppService,
  buildSessionObservability,
  buildRecoveredResultFromContext,
  buildTurnSummary,
});

// ============================================================================
// Scene Reconstruction Endpoints
// ============================================================================

// Scene-report cache layer singletons. The disk store backs file-backed
// traces with a 7-day TTL; the memory LRU is the fallback for external RPC
// traces (no content hash, so they live for the lifetime of the backend).
const sceneReportStore = new FileSystemSceneReportStore(sceneStoryConfig.reportDir);
const sceneReportMemoryCache = new SceneReportMemoryCache(sceneStoryConfig.memoryCacheMaxSize);
const sceneJobArtifactStore = new FileSystemSceneJobArtifactStore(sceneStoryConfig.jobArtifactDir);

// Singleton — sceneStoryService holds per-session JobRunner state for cancel
// lookup, so it must outlive a single request. SkillExecutor is still created
// per-request inside the route handler.
const sceneStoryService = new SceneStoryService({
  broadcast: broadcastToAgentDrivenClients,
  getSession: (id) => assistantAppService.getSession(id) as any,
  isRunCurrent: (sessionId, runId) => {
    if (!runId) return true;
    const session = assistantAppService.getSession(sessionId);
    return Boolean(session && isCurrentRunOwner(session, runId));
  },
  reportStore: sceneReportStore,
  memoryCache: sceneReportMemoryCache,
  jobArtifactStore: sceneJobArtifactStore,
  computeHash: (traceId) => computeTraceContentHash(getTraceProcessorService(), traceId),
  probeDuration: (traceId) => probeTraceDuration(getTraceProcessorService(), traceId),
});

registerSceneReconstructRoutes(router, {
  assistantAppService,
  streamProjector,
  ensureToolsRegistered,
  runAgentDrivenAnalysis,
  broadcastToAgentDrivenClients,
  sendAgentDrivenResult,
  isSceneReplayOnlyQuery,
  buildSceneReplayNarrative,
  normalizeNarrativeForClient,
  sceneStoryService,
});

registerAgentQuickSceneRoutes(router, {
  detectScenesQuick,
});

// ============================================================================
// Scene Detection Cache + Parallel Helpers
// ============================================================================

const sceneCache = new TtlLruCache<DetectedScene[]>(
  sceneStoryConfig.quickSceneCacheMaxSize,
  sceneStoryConfig.quickSceneCacheTtlMs,
);
const sceneCacheSubscriptions = new WeakSet<object>();

function subscribeSceneCacheToTraceLifecycle(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
): void {
  const eventSource = traceProcessorService as unknown as {
    on?: (event: string, listener: (traceId: string) => void) => unknown;
  };
  if (typeof eventSource.on !== 'function' || sceneCacheSubscriptions.has(traceProcessorService)) return;
  eventSource.on('trace-deleted', (traceId) => sceneCache.delete(traceId));
  sceneCacheSubscriptions.add(traceProcessorService);
}
const SCENE_EXTRACTION_STEP_IDS = new Set([
  'screen_state_changes',
  'app_launches',
  'user_gestures',
  'scroll_initiation',
  'inertial_scrolls',
  'idle_periods',
  'top_app_changes',
  'system_events',
  'jank_events',
  'clean_timeline',
]);

async function runSmartAnalysis(
  sessionId: string,
  query: string,
  traceId: string,
  options: {
    runContext: AnalyzeSessionRunContext;
    traceProcessorService: ReturnType<typeof getTraceProcessorService>;
    smartAction: 'preview' | 'analyze';
    smartSelection?: SceneAnalysisSelection;
    forceRefresh: boolean;
    analysisMode?: AnalyzeMode;
    blockedStrategyIds?: string[];
    owner: ResourceOwnerFields;
    knowledgeScope?: KnowledgeScope;
    codeAwareMode?: import('../services/codebase/codeAwareFeature').CodeAwareMode;
    codebaseIds?: string[];
    knowledgeSourceIds?: string[];
    runManifestAttributionSink: RunManifestAttributionSink;
  },
): Promise<void> {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return;

  const startedAt = Date.now();
  const runId = options.runContext.runId;
  session.analysisMode = normalizeReceiptAnalysisMode(options.analysisMode) ?? session.analysisMode;
  setCurrentSessionRun(session, {
    ...options.runContext,
    query,
    status: 'running',
    startedAt: options.runContext.startedAt || startedAt,
  });
  initializeCancelStateForRun(session, session.activeRun!);
  session.status = 'running';
  session.lastActivityAt = Date.now();
  persistSessionRunState(session, 'running', undefined, runId);
  const runHeartbeatInterval = startSessionRunHeartbeat(session, runId);
  const cancelToken = smartCancelBridge.create(sessionId, runId);
  let dispatchedToAgentDeepDive = false;
  const privateKnowledge = sessionUsesPrivateKnowledge(session);
  const outputLanguage = sessionOutputLanguage(session);
  const durableQuery = privateKnowledge
    ? privateAnalysisQueryMessage(outputLanguage)
    : query;

  session.logger.info('SmartAnalysis', 'Starting smart analysis', {
    query: durableQuery,
    traceId,
    smartAction: options.smartAction,
    smartSelection: options.smartSelection,
    runId: session.activeRun?.runId,
    requestId: session.activeRun?.requestId,
  });

  try {
    const smartRegistry = currentEffectiveSkillRegistry();
    if (!smartRegistry) {
      throw new Error('effective_runtime_registry_snapshot_missing_for_run');
    }
    options.runManifestAttributionSink.recordSkillRegistry(
      buildSkillRegistryAttribution(smartRegistry),
    );
    const skillExecutor = new SkillExecutor(
      options.traceProcessorService,
      undefined,
      undefined,
      options.runManifestAttributionSink,
    );
    skillExecutor.registerSkills(smartRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(smartRegistry.getFragmentCache());

    let report: SceneReport | null = null;
    if (options.smartAction === 'analyze') {
      report = await resolveSmartPreviewReportForSelection({
        session,
        selection: options.smartSelection,
        traceId,
        owner: options.owner,
      });
    }

    if (!report) {
      report = await sceneStoryService.start({
        sessionId,
        runId,
        traceId,
        skillExecutor,
        owner: options.owner,
        options: {
          routeProfile: 'smart',
          previewOnly: true,
          forceRefresh: options.smartAction === 'preview' ? true : options.forceRefresh,
          cancelToken,
          outputLanguage,
        },
      });
    }
    if (!report) {
      throw new Error(session.error || 'Smart analysis failed before report finalization');
    }
    if (isStaleRun(session, runId)) {
      session.logger.info('SmartAnalysis', 'Ignoring stale smart analysis report', {
        sessionId,
        runId,
      });
      return;
    }

    if (options.smartAction === 'preview') {
      const result = buildSmartSceneSelectionReport({
        sessionId,
        report,
        totalDurationMs: Date.now() - startedAt,
        outputLanguage,
      });
      if (isStaleRun(session, runId) || !smartCancelBridge.tryClaimTerminal(sessionId, runId)) {
        session.logger.warn('SmartAnalysis', 'Skipping late smart preview terminal', {
          sessionId,
          runId,
        });
        return;
      }
      completeAgentDrivenSessionWithResult({
        sessionId,
        query,
        traceId,
        session,
        result,
        runId: options.runContext.runId,
        logComponent: 'SmartAnalysis',
      });
      return;
    }

    const dispatch = buildSmartDeepDiveDispatch({
      report,
      selection: options.smartSelection ?? { scope: 'all' },
      outputLanguage,
    });
    if (!dispatch) {
      throw new Error(localize(
        outputLanguage,
        '所选范围没有匹配到可深钻场景，请返回场景盘点后重新选择。',
        'The selected range does not contain a scene eligible for deep analysis. Return to the scene inventory and select again.',
      ));
    }

    session.logger.info('SmartAnalysis', 'Dispatching smart selection to agent deep dive', {
      query: privateKnowledge ? durableQuery : dispatch.query,
      selectedSceneCount: dispatch.selectedScenes.length,
      packageName: dispatch.packageName,
      previewReportId: report.reportId,
      runId: session.activeRun?.runId,
      requestId: session.activeRun?.requestId,
    });
    broadcastToAgentDrivenClients(
      sessionId,
      {
        type: 'progress',
        content: {
          phase: 'smart_deep_dive_dispatch',
          message: localize(
            outputLanguage,
            `已选中 ${dispatch.selectedScenes.length} 个场景，进入详细分析`,
            `${dispatch.selectedScenes.length} scenes selected. Starting detailed analysis.`,
          ),
        },
        timestamp: Date.now(),
      },
      runId,
    );

    dispatchedToAgentDeepDive = true;
    await runAgentDrivenAnalysis(sessionId, dispatch.query, traceId, buildSmartDeepDiveRunOptions({
      traceProcessorService: options.traceProcessorService,
      runContext: options.runContext,
      blockedStrategyIds: options.blockedStrategyIds,
      dispatch,
      knowledgeScope: options.knowledgeScope,
      outputLanguage,
      analysisMode: options.analysisMode,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      runManifestAttributionSink: options.runManifestAttributionSink,
    }));
  } catch (error: any) {
    if (isSessionRunCancelled(session, runId) || isStaleRun(session, runId)) {
      session.logger.info('SmartAnalysis', 'Ignoring smart analysis error after cancellation', {
        sessionId,
        runId,
        error: privateKnowledge
          ? privateAnalysisFailureMessage(outputLanguage)
          : error?.message || String(error),
      });
      return;
    }
    const publicErrorMessage = error instanceof SmartPreviewSelectionError
      ? smartPreviewSelectionErrorMessage(outputLanguage, error.reportId)
      : privateKnowledge
        ? privateAnalysisFailureMessage(outputLanguage)
        : error.message || String(error);
    session.status = 'failed';
    session.error = publicErrorMessage;
    markSessionRunStatus(session, 'failed', session.error, runId);
    session.logger.error(
      'SmartAnalysis',
      'Smart analysis failed',
      privateKnowledge ? new Error(publicErrorMessage) : error,
    );
    if (!dispatchedToAgentDeepDive && smartCancelBridge.tryClaimTerminal(sessionId, runId)) {
      broadcastToAgentDrivenClients(
        sessionId,
        {
          type: 'error',
          content: { message: session.error, error: session.error },
          timestamp: Date.now(),
        },
        runId,
      );
    }
  } finally {
    smartCancelBridge.release(sessionId, runId);
    if (runHeartbeatInterval) {
      clearInterval(runHeartbeatInterval);
    }
  }
}

export function buildSmartDeepDiveRunOptions(input: {
  traceProcessorService: ReturnType<typeof getTraceProcessorService>;
  runContext: AnalyzeSessionRunContext;
  blockedStrategyIds?: string[];
  dispatch: NonNullable<ReturnType<typeof buildSmartDeepDiveDispatch>>;
  knowledgeScope?: KnowledgeScope;
  outputLanguage: OutputLanguage;
  analysisMode?: AnalyzeMode;
  codeAwareMode?: import('../services/codebase/codeAwareFeature').CodeAwareMode;
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
  runManifestAttributionSink: RunManifestAttributionSink;
}): Record<string, unknown> {
  return {
    traceProcessorService: input.traceProcessorService,
    runContext: input.runContext,
    blockedStrategyIds: input.blockedStrategyIds,
    selectionContext: input.dispatch.selectionContext,
    traceContext: input.dispatch.traceContext,
    packageName: input.dispatch.packageName,
    generateTracks: false,
    knowledgeScope: input.knowledgeScope,
    outputLanguage: input.outputLanguage,
    runManifestAttributionSink: input.runManifestAttributionSink,
    ...buildSmartDeepDiveAnalysisContext(input.analysisMode, input),
  };
}

function smartSelectionReportId(selection?: SceneAnalysisSelection): string | undefined {
  return selection?.reportId || selection?.sceneSnapshotId;
}

export function analyzeOptionsErrorMessage(
  error: AnalyzeOptionsError,
  outputLanguage: OutputLanguage,
): string {
  switch (error.code) {
    case 'SMART_COMPARISON_UNSUPPORTED':
      return localize(
        outputLanguage,
        '智能分析暂不支持双 trace 对比',
        'Smart Analysis does not support dual-trace comparison yet',
      );
    case 'SMART_CONTINUATION_UNSUPPORTED':
      return localize(
        outputLanguage,
        '智能分析仅支持新会话，不能作为已有会话的后续轮次运行',
        'Smart Analysis must start a new session and cannot run as a continuation turn',
      );
    case 'INVALID_SMART_SELECTION':
      return localize(
        outputLanguage,
        '智能分析的场景选择无效，请刷新场景盘点后重新选择',
        'The Smart Analysis scene selection is invalid. Refresh the scene inventory and select again',
      );
    case 'SMART_SELECTION_REQUIRES_SMART_PRESET':
      return localize(
        outputLanguage,
        '只有智能分析可以指定场景选择',
        'Scene selection requires the Smart Analysis preset',
      );
    case 'SMART_ACTION_REQUIRES_SMART_PRESET':
      return localize(
        outputLanguage,
        '只有智能分析可以指定智能分析操作',
        'Smart actions require the Smart Analysis preset',
      );
    case 'UNSUPPORTED_SMART_ACTION':
      return localize(
        outputLanguage,
        '不支持所请求的智能分析操作',
        'The requested Smart Analysis action is unsupported',
      );
    case 'UNSUPPORTED_ANALYZE_PRESET':
      return localize(
        outputLanguage,
        '不支持所请求的分析预设',
        'The requested analysis preset is unsupported',
      );
    case 'UNSUPPORTED_OUTPUT_LANGUAGE':
      return localize(
        outputLanguage,
        '输出语言必须是 en 或 zh-CN',
        'Output language must be en or zh-CN',
      );
    case 'UNSUPPORTED_ANALYSIS_MODE':
      return localize(
        outputLanguage,
        '分析模式必须是 fast、full 或 auto',
        'Analysis mode must be fast, full, or auto',
      );
    case 'UNSUPPORTED_RUNTIME_CONTROL': {
      const field = typeof error.details?.field === 'string'
        ? error.details.field
        : '该运行参数';
      return localize(
        outputLanguage,
        `${field} 无法在所有 AI runtime 上保持一致，当前不支持按请求设置`,
        `${field} is not supported as a request-level control across all AI runtimes`,
      );
    }
    case 'UNSUPPORTED_CODE_AWARE_MODE':
      return localize(
        outputLanguage,
        '源码感知模式必须是 off、metadata_only 或 provider_send',
        'Code-aware mode must be off, metadata_only, or provider_send',
      );
    case 'CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE':
      return localize(
        outputLanguage,
        '选择源码库时，源码感知模式必须是 metadata_only 或 provider_send',
        'Selecting codebases requires code-aware mode metadata_only or provider_send',
      );
    case 'ANALYSIS_SOURCE_ALLOWLIST_TOO_LARGE': {
      const field = error.details?.field === 'codebaseIds'
        ? 'codebaseIds'
        : 'knowledgeSourceIds';
      const maxItems = typeof error.details?.maxItems === 'number'
        ? error.details.maxItems
        : 'the configured limit';
      return localize(
        outputLanguage,
        `${field} 最多允许 ${maxItems} 个唯一 ID`,
        `${field} accepts at most ${maxItems} unique IDs`,
      );
    }
    default:
      return localize(
        outputLanguage,
        '分析参数无效，请检查后重试',
        error.message,
      );
  }
}

export class SmartPreviewSelectionError extends Error {
  readonly code = 'smart_preview_selection_stale';
  readonly reportId: string;

  constructor(reportId: string) {
    super('Smart preview selection is unavailable');
    this.name = 'SmartPreviewSelectionError';
    this.reportId = reportId;
  }
}

export function smartPreviewSelectionErrorMessage(
  outputLanguage: OutputLanguage,
  reportId: string,
): string {
  return localize(
    outputLanguage,
    `智能场景盘点“${reportId}”不可用、已过期或不再被授权。请刷新场景盘点后再开始深度分析。`,
    `Smart scene inventory '${reportId}' is unavailable, expired, or no longer authorized. Refresh the scene inventory before starting deep analysis.`,
  );
}

export async function resolveSmartPreviewReportForSelection(input: {
  session: AnalysisSession;
  selection?: SceneAnalysisSelection;
  traceId: string;
  owner: ResourceOwnerFields;
  loadReport?: (reportId: string) => Promise<SceneReport | null>;
}): Promise<SceneReport | null> {
  const requestedReportId = smartSelectionReportId(input.selection);
  const sessionReport = input.session.sceneStoryReport as SceneReport | undefined;
  if (isUsableSmartPreviewReport(sessionReport, input.traceId, input.owner, requestedReportId)) {
    return sessionReport;
  }
  if (!requestedReportId) return null;

  const persisted = await (input.loadReport ?? (reportId => sceneStoryService.getReport(reportId)))(
    requestedReportId,
  );
  if (isUsableSmartPreviewReport(persisted, input.traceId, input.owner, requestedReportId)) {
    return persisted;
  }
  throw new SmartPreviewSelectionError(requestedReportId);
}

export function isUsableSmartPreviewReport(
  report: SceneReport | null | undefined,
  traceId: string,
  owner: ResourceOwnerFields,
  requestedReportId?: string,
): report is SceneReport {
  if (!report) return false;
  if (requestedReportId && report.reportId !== requestedReportId) return false;
  if (report.traceId !== traceId) return false;
  if (report.phase !== 'selection_preview') return false;
  if (report.expiresAt !== null && report.expiresAt <= Date.now()) return false;
  return ownersMatch(report, owner);
}

function completeAgentDrivenSessionWithResult(input: {
  sessionId: string;
  query: string;
  traceId: string;
  sceneType?: string;
  session: AnalysisSession;
  result: AgentRuntimeAnalysisResult;
  runId?: string;
  logComponent: string;
}): void {
  if (isSessionRunCancelled(input.session, input.runId)) {
    input.session.logger.warn(input.logComponent, 'Skipping late result after cancellation', {
      sessionId: input.sessionId,
      runId: input.runId,
    });
    return;
  }
  if (isStaleRun(input.session, input.runId)) {
    input.session.logger.warn(input.logComponent, 'Skipping stale result', {
      sessionId: input.sessionId,
      runId: input.runId,
    });
    return;
  }
  finalizeAgentDrivenSession({
    ...input,
    outputLanguage: sessionOutputLanguage(input.session),
    comparisonIdentity: comparisonIdentityFromReportSection(
      input.session.comparisonReportSection,
    ),
  }, {
    applyFinalResultQualityGate,
    isRunCurrent: (session, runId) => !runId || isCurrentRunOwner(session as AnalysisSession, runId),
    broadcast: broadcastToAgentDrivenClients,
    buildConversationStepUpdate,
    appendConversationStep,
    annotateLatestCompletedTurn: (sessionId, traceId, result) => {
      sessionContextManager.get(sessionId, traceId)?.annotateLatestCompletedTurn({
        success: result.success,
        findings: result.findings,
        message: result.conclusion,
        confidence: result.confidence,
        partial: result.partial,
        terminationReason: result.terminationReason,
        terminationMessage: result.terminationMessage,
        conclusionContract: result.conclusionContract,
        claimSupport: result.claimSupport,
        claimVerificationResult: result.claimVerificationResult,
        identityResolutions: result.identityResolutions,
      });
    },
    terminalRunStatusForResult,
    markSessionRunStatus,
    persistAgentTurn,
    ensureCompletedAnalysisSseEvents,
    sendAgentDrivenResult,
  });
}

function objectRowsToEnvelopePayload(rows: Array<Record<string, any>>): {
  columns: string[];
  rows: any[][];
} {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  return {
    columns,
    rows: rows.map((row) => columns.map((col) => (row ? row[col] : null))),
  };
}

function appendTraceContextDataEnvelopes(
  session: AnalysisSession,
  traceContext: TraceDataset[] | undefined,
  traceId: string,
): DataEnvelope[] {
  const envelopes = buildTraceContextDataEnvelopes(traceContext, traceId);
  if (envelopes.length === 0) return [];

  const existingHashes = new Set(
    (session.dataEnvelopes || [])
      .map((env) => env?.meta?.queryHash)
      .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0),
  );
  const unique = envelopes.filter((env) => {
    const hash = env.meta?.queryHash;
    if (!hash || existingHashes.has(hash)) return false;
    existingHashes.add(hash);
    return true;
  });
  if (unique.length === 0) return [];

  const turnNumber = session.activeRun?.sequence || session.runSequence || 1;
  for (const env of unique) {
    if (env.meta) (env.meta as any).turn = turnNumber;
  }

  session.dataEnvelopes.push(...unique);
  trimSessionArray(session.dataEnvelopes, MAX_SESSION_DATA_ENVELOPES);
  return unique;
}

function buildSceneExtractionEnvelopesFromRawResults(rawResults: any): DataEnvelope[] {
  const envelopes: DataEnvelope[] = [];
  if (!rawResults || typeof rawResults !== 'object') return envelopes;

  for (const [stepId, stepResult] of Object.entries(rawResults as Record<string, any>)) {
    if (!SCENE_EXTRACTION_STEP_IDS.has(stepId)) continue;
    const rows = Array.isArray((stepResult as any)?.data)
      ? ((stepResult as any).data as Array<Record<string, any>>)
      : [];
    if (rows.length === 0) continue;

    const payload = objectRowsToEnvelopePayload(rows);
    if (payload.columns.length === 0) continue;

    envelopes.push(
      createDataEnvelope(payload, {
        type: 'skill_result',
        source: `scene_reconstruction.${stepId}`,
        skillId: 'scene_reconstruction',
        stepId,
        title: stepId,
        layer: 'list',
        format: 'table',
      }),
    );
  }

  return envelopes;
}

/**
 * Execute the state_timeline skill directly (bypasses Agent decision-making).
 * Returns DataEnvelopes suitable for SSE broadcast and track overlay rendering.
 * agentv3's ClaudeRuntime doesn't auto-execute strategy tasks, so this must be
 * called explicitly from the scene reconstruction flow.
 */
async function executeStateTimelineSkill(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DataEnvelope[]> {
  await ensureSkillRegistryInitialized();

  const runtimeSkillRegistry =
    resolveEffectiveSkillRegistryForRuntime(skillRegistry);
  const skillExecutor = new SkillExecutor(traceProcessorService);
  skillExecutor.registerSkills(runtimeSkillRegistry.getAllSkills());

  const skillResult = await skillExecutor.execute('state_timeline', traceId, {
    trace_id: traceId,
  });

  if (!skillResult.success) {
    console.warn('[StateTimeline] state_timeline skill failed:', skillResult.error);
    return [];
  }

  // Convert rawResults to DataEnvelopes (same pattern as scene_reconstruction)
  const envelopes: DataEnvelope[] = [];
  if (!skillResult.rawResults || typeof skillResult.rawResults !== 'object') return envelopes;

  for (const [stepId, stepResult] of Object.entries(skillResult.rawResults as Record<string, any>)) {
    const rows = Array.isArray((stepResult as any)?.data)
      ? ((stepResult as any).data as Array<Record<string, any>>)
      : [];
    if (rows.length === 0) continue;

    const payload = objectRowsToEnvelopePayload(rows);
    if (payload.columns.length === 0) continue;

    envelopes.push(
      createDataEnvelope(payload, {
        type: 'skill_result',
        source: `state_timeline:${stepId}`,
        skillId: 'state_timeline',
        stepId,
        title: stepId,
        layer: 'list',
        format: 'table',
      }),
    );
  }

  return envelopes;
}

async function detectScenesQuickViaSkill(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  await ensureSkillRegistryInitialized();

  const runtimeSkillRegistry =
    resolveEffectiveSkillRegistryForRuntime(skillRegistry);
  const skillExecutor = new SkillExecutor(traceProcessorService);
  skillExecutor.registerSkills(runtimeSkillRegistry.getAllSkills());

  const skillResult = await skillExecutor.execute('scene_reconstruction', traceId, {
    trace_id: traceId,
  });

  if (!skillResult.success) {
    throw new Error(skillResult.error || 'scene_reconstruction execution failed');
  }

  const envelopes = buildSceneExtractionEnvelopesFromRawResults(skillResult.rawResults);
  return extractDetectedScenesFromEnvelopes(envelopes);
}

/** Detect app startups from android_startups stdlib view */
async function detectStartups(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  // Reclassify startup_type: platform may report 'warm' even when
  // bindApplication exists (process killed + ActivityRecord survives).
  const result = await tps.query(
    traceId,
    `
    SELECT
      s.ts,
      s.dur,
      s.package,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM android_startup_threads st
          JOIN thread_track tt ON tt.utid = st.utid
          JOIN slice sl ON sl.track_id = tt.id
          WHERE st.startup_id = s.startup_id
            AND st.is_main_thread = 1
            AND sl.name = 'bindApplication'
            AND sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur
        ) THEN 'cold'
        ELSE s.startup_type
      END AS startup_type,
      CAST(s.dur / 1000000 AS INT) AS dur_ms
    FROM android_startups s
    WHERE s.dur > 0
    ORDER BY s.ts
  `,
  );

  const scenes: DetectedScene[] = [];
  if (result.rows) {
    for (const row of result.rows) {
      const [ts, dur, pkg, startupType, durMs] = row;
      let sceneType: SceneCategory = 'cold_start';
      if (startupType === 'warm') sceneType = 'warm_start';
      else if (startupType === 'hot') sceneType = 'hot_start';

      scenes.push({
        type: sceneType,
        startTs: String(ts),
        endTs: String(BigInt(ts) + BigInt(dur)),
        durationMs: Number(durMs),
        confidence: 0.95,
        appPackage: pkg,
        metadata: { startupType },
      });
    }
  }
  return scenes;
}

/** Detect scroll sessions from input events + frame timeline */
async function detectScrollSessions(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const scrollResult = await tps.query(
    traceId,
    `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    gesture_markers AS (
      SELECT
        ts,
        event_action,
        SUM(CASE WHEN event_action = 'DOWN' THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS gesture_id
      FROM motion_events
    ),
    gestures AS (
      SELECT
        gesture_id,
        MIN(ts) AS down_ts,
        MAX(CASE WHEN event_action = 'UP' THEN ts ELSE NULL END) AS up_ts,
        COUNT(*) AS event_count
      FROM gesture_markers
      WHERE gesture_id > 0
      GROUP BY gesture_id
      HAVING COUNT(*) >= 4
    ),
    frame_with_stats AS (
      SELECT
        ts,
        dur,
        ts + dur AS frame_end,
        jank_type,
        COALESCE(LEAD(ts) OVER (ORDER BY ts) - (ts + dur), 999999999) AS gap_to_next
      FROM actual_frame_timeline_slice
      WHERE surface_frame_token IS NOT NULL AND dur > 0
    ),
    scroll_sessions AS (
      SELECT
        g.gesture_id,
        g.down_ts AS start_ts,
        COALESCE(
          (SELECT MIN(f.frame_end)
           FROM frame_with_stats f
           WHERE f.ts >= g.up_ts AND f.gap_to_next > 100000000),
          g.up_ts + 500000000
        ) AS end_ts
      FROM gestures g
      WHERE g.up_ts IS NOT NULL
    )
    SELECT
      s.start_ts,
      s.end_ts,
      CAST((s.end_ts - s.start_ts) / 1000000 AS INT) AS dur_ms,
      (SELECT COUNT(*) FROM frame_with_stats f WHERE f.ts >= s.start_ts AND f.frame_end <= s.end_ts) AS frame_count
    FROM scroll_sessions s
    WHERE s.end_ts > s.start_ts + 100000000
    ORDER BY s.start_ts
  `,
  );

  const scenes: DetectedScene[] = [];
  if (scrollResult.rows) {
    for (const row of scrollResult.rows) {
      const [startTs, endTs, durMs, frameCount] = row;
      if (Number(frameCount) >= 3) {
        const fps = (Number(frameCount) * 1000) / Math.max(Number(durMs), 1);
        scenes.push({
          type: 'scroll',
          startTs: String(startTs),
          endTs: String(endTs),
          durationMs: Number(durMs),
          confidence: 0.85,
          metadata: {
            frameCount: Number(frameCount),
            averageFps: Math.round(fps * 10) / 10,
          },
        });
      }
    }
  }
  return scenes;
}

/** Detect tap/click events from input events */
async function detectTapEvents(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const tapResult = await tps.query(
    traceId,
    `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    tap_events AS (
      SELECT
        ts AS down_ts,
        LEAD(ts) OVER (ORDER BY ts) AS up_ts,
        event_action
      FROM motion_events
      WHERE event_action IN ('DOWN', 'UP')
    )
    SELECT
      down_ts AS start_ts,
      up_ts AS end_ts,
      CAST((up_ts - down_ts) / 1000000 AS INT) AS dur_ms
    FROM tap_events
    WHERE event_action = 'DOWN'
      AND up_ts IS NOT NULL
      AND (up_ts - down_ts) < 300000000
    ORDER BY down_ts
    LIMIT 50
  `,
  );

  const scenes: DetectedScene[] = [];
  if (tapResult.rows) {
    for (const row of tapResult.rows) {
      const [startTs, endTs, durMs] = row;
      scenes.push({
        type: 'tap',
        startTs: String(startTs),
        endTs: String(endTs),
        durationMs: Number(durMs),
        confidence: 0.75,
      });
    }
  }
  return scenes;
}

/**
 * Legacy quick scene detection path.
 * Kept as fallback when skill-based extraction is unavailable.
 */
async function detectScenesQuickLegacy(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  // =========================================================================
  // Pre-load Perfetto stdlib modules (parallel)
  // =========================================================================
  // `android_input_events` and `android_startups` are stdlib VIEWS, not
  // intrinsic tables. They only exist after loading the corresponding modules.
  const REQUIRED_MODULES = [
    'android.input', // Creates android_input_events, android_key_events
    'android.startup.startups', // Creates android_startups
  ];

  await Promise.all(
    REQUIRED_MODULES.map((module) =>
      traceProcessorService
        .query(traceId, `INCLUDE PERFETTO MODULE ${module};`)
        .catch((e) => console.warn(`[QuickSceneDetect] Module not available: ${module}`, e)),
    ),
  );

  // =========================================================================
  // Run all 3 detection queries in parallel
  // =========================================================================
  const [startupResult, scrollResult, tapResult] = await Promise.allSettled([
    detectStartups(traceProcessorService, traceId),
    detectScrollSessions(traceProcessorService, traceId),
    detectTapEvents(traceProcessorService, traceId),
  ]);

  // Merge results from fulfilled promises
  const scenes: DetectedScene[] = [];
  if (startupResult.status === 'fulfilled') {
    scenes.push(...startupResult.value);
  } else {
    console.warn('[QuickSceneDetect] Startup detection failed:', startupResult.reason);
  }
  if (scrollResult.status === 'fulfilled') {
    scenes.push(...scrollResult.value);
  } else {
    console.warn('[QuickSceneDetect] Scroll detection failed:', scrollResult.reason);
  }
  if (tapResult.status === 'fulfilled') {
    scenes.push(...tapResult.value);
  } else {
    console.warn('[QuickSceneDetect] Tap detection failed:', tapResult.reason);
  }

  // Sort scenes by start timestamp
  scenes.sort((a, b) => {
    const aTs = BigInt(a.startTs);
    const bTs = BigInt(b.startTs);
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  return scenes;
}

async function detectScenesQuick(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  subscribeSceneCacheToTraceLifecycle(traceProcessorService);
  const cached = sceneCache.get(traceId);
  if (cached) {
    console.log('[QuickSceneDetect] Cache hit for traceId:', traceId);
    return cached;
  }

  const t0 = Date.now();

  let scenes: DetectedScene[] = [];
  try {
    scenes = await detectScenesQuickViaSkill(traceProcessorService, traceId);
    console.log(`[QuickSceneDetect] Skill extraction path returned ${scenes.length} scenes`);
    if (scenes.length === 0) {
      const legacyScenes = await detectScenesQuickLegacy(traceProcessorService, traceId);
      if (legacyScenes.length > 0) {
        console.log(
          `[QuickSceneDetect] Legacy fallback provided ${legacyScenes.length} scenes after empty skill extraction`,
        );
        scenes = legacyScenes;
      }
    }
  } catch (error: any) {
    console.warn(
      '[QuickSceneDetect] Skill extraction failed, falling back to legacy SQL path:',
      error?.message || error,
    );
    scenes = await detectScenesQuickLegacy(traceProcessorService, traceId);
  }

  scenes.sort((a, b) => {
    const aTs = BigInt(a.startTs);
    const bTs = BigInt(b.startTs);
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  console.log(`[QuickSceneDetect] Completed in ${Date.now() - t0}ms, ${scenes.length} scenes`);
  sceneCache.set(traceId, scenes);
  return scenes;
}

// ============================================================================
// Teaching Pipeline Endpoints
// ============================================================================

registerTeachingRoutes(router);

registerAgentReportRoutes(router, {
  getSession: (sessionId) => assistantAppService.getSession(sessionId),
  recoverResultForSessionIfNeeded,
  normalizeNarrativeForClient,
  buildClientFindings,
  buildSessionResultContract,
  getCompletedPayload: ensureCompletedAnalysisResultPayload,
});

registerAgentExternalIssueRoutes(router, {
  getSessionOwner: (sessionId) =>
    assistantAppService.getSession(sessionId) ??
    SessionPersistenceService.getInstance().getSession(sessionId)?.metadata,
});

// ============================================================================
// Agent-Driven Analysis Helper Functions (Phase 2-4)
// ============================================================================

type CaseCandidateSaveFn = (input: CaseCandidateCaptureInput) => Promise<unknown>;

export interface CaptureCaseCandidatesAfterQualityArtifactsInput {
  sessionId: string;
  traceId: string;
  session: AnalysisSession;
  result: AgentRuntimeAnalysisResult;
  normalizedConclusionContract?: ConclusionContract;
  sceneIdHint?: string;
  runIdForAnalysis: string;
  knowledgeScope?: KnowledgeScope;
  caseEvolutionConfig?: CaseEvolutionConfig;
  computeTraceHash?: (traceId: string) => Promise<string | null>;
  saveCandidates?: CaseCandidateSaveFn;
  /**
   * Returns the set of `${scene}::${rootCause}` keys already covered by
   * published cases, used to dedupe capture against the live library
   * (§1.2 flooding guard). Defaults to scanning the real CaseLibrary.
   */
  listPublishedSceneRootCauses?: (scope?: KnowledgeScope) => Set<string>;
  logger: Pick<SessionLogger, 'info' | 'warn'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveCaseEvolutionTurnIndex(session: AnalysisSession): number {
  const activeSequence = session.activeRun?.sequence;
  if (typeof activeSequence === 'number' && Number.isFinite(activeSequence)) {
    return activeSequence;
  }
  if (typeof session.runSequence === 'number' && Number.isFinite(session.runSequence)) {
    return session.runSequence;
  }
  if (typeof session.conversationOrdinal === 'number' && Number.isFinite(session.conversationOrdinal)) {
    return session.conversationOrdinal;
  }
  return 0;
}

function resolveCaseEvolutionEngine(runtimeKind: AgentRuntimeKind | undefined): CaseEvolutionEngine {
  switch (runtimeKind) {
    case 'openai-agents-sdk':
      return 'openai';
    case 'opencode':
      return 'opencode';
    case 'pi-agent-core':
      return 'pi';
    case 'claude-agent-sdk':
    default:
      return 'claude';
  }
}

function cloneCaseEvolutionEnvelopes(envelopes: readonly DataEnvelope[]): DataEnvelope[] {
  try {
    return structuredClone(envelopes) as DataEnvelope[];
  } catch {
    // DataEnvelope payloads are expected to be structured-cloneable. Keep a
    // detached top-level snapshot for legacy/custom envelopes that are not.
    return envelopes.map(envelope => ({...envelope}));
  }
}

export function buildCaseEvolutionSnapshotPath(sessionId: string): string {
  return `session-persistence://sessions/${sessionId}/metadata/sessionStateSnapshot`;
}

export function resolveCaseEvolutionArchitectureType(
  session: Pick<AnalysisSession, 'orchestrator'>,
  traceId: string,
): string {
  try {
    const cachedArchitecture = session.orchestrator.getCachedArchitecture?.(traceId);
    const type = cachedArchitecture?.type;
    return typeof type === 'string' && type.trim() ? type.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Build the dedupe set of `${scene}::${rootCause}` keys covered by published
 * cases in the live CaseLibrary (curated + learned). Used by the §1.2 capture
 * flooding guard so a recurring trace whose root cause already has published
 * guidance does not re-enqueue candidates. Failures are non-fatal: an empty
 * set means "no dedupe" (the candidate still goes through the qualification
 * gate), never a blocked capture.
 */
export function collectPublishedSceneRootCauses(scope: KnowledgeScope | undefined): Set<string> {
  const keys = new Set<string>();
  try {
    const library = new CaseLibrary(backendLogPath('case_library.json'));
    const published = library.listCases({ status: 'published' }, scope);
    for (const node of published) {
      const knowledge = node.knowledge;
      if (!knowledge) continue;
      const scene = knowledge.scene;
      const rootCause = knowledge.taxonomy?.primary_root_cause;
      if (scene && rootCause) keys.add(`${scene}::${rootCause}`);
    }
  } catch {
    // Library read is best-effort for dedupe; never block capture on it.
  }
  return keys;
}

export async function captureCaseCandidatesAfterQualityArtifacts(
  input: CaptureCaseCandidatesAfterQualityArtifactsInput,
): Promise<void> {
  try {
    if (sessionUsesPrivateKnowledge(input.session)) {
      input.logger.info('CaseEvolution', 'Skipping candidate capture for private source or knowledge analysis', {
        sessionId: input.sessionId,
        runId: input.runIdForAnalysis,
      });
      return;
    }
    try {
      assertAiFeatureEnabled('background_review_agent');
    } catch (error) {
      if (error instanceof AiDisabledError) {
        input.logger.info('CaseEvolution', 'Skipping background candidate capture because AI is disabled', {
          sessionId: input.sessionId,
          runId: input.runIdForAnalysis,
          feature: error.feature,
        });
        return;
      }
      throw error;
    }
    const config = input.caseEvolutionConfig || loadCaseEvolutionConfig();
    if (!isCaseEvolutionCaptureEnabled(config)) return;

    // Capture every mutable session-derived field before the first await. A
    // follow-up turn may reuse and mutate the live session while trace hashing
    // is still in flight; candidates must describe the turn that triggered
    // this call, not whichever turn happens to be current later.
    const capturedDataEnvelopes = cloneCaseEvolutionEnvelopes(input.session.dataEnvelopes || []);
    const capturedArchitectureType = resolveCaseEvolutionArchitectureType(
      input.session,
      input.traceId,
    );
    const capturedTurnIndex = resolveCaseEvolutionTurnIndex(input.session);
    const capturedEngine = resolveCaseEvolutionEngine(input.session.runtimeKind);

    const computeTraceHash =
      input.computeTraceHash || ((traceId) => computeTraceContentHash(getTraceProcessorService(), traceId));
    const traceContentHash = await computeTraceHash(input.traceId);
    // §1.2 flooding guard: build the set of (scene::rootCause) keys the
    // published library already covers, so capture skips clusters that
    // already have published guidance. Defaults to scanning the live library.
    const listPublishedSceneRootCauses =
      input.listPublishedSceneRootCauses ??
      ((scope?: KnowledgeScope) => collectPublishedSceneRootCauses(scope ?? input.knowledgeScope));
    const existingPublishedSceneRootCauses = listPublishedSceneRootCauses(input.knowledgeScope);
    const saveCandidates =
      input.saveCandidates ||
      ((captureInput: CaseCandidateCaptureInput) =>
        saveCaseCandidates(captureInput, {
          logger: input.logger,
          config,
          existingPublishedSceneRootCauses,
        }));

    await saveCandidates({
      result: input.result,
      conclusionContract: input.normalizedConclusionContract,
      claimVerificationResult: input.result.claimVerificationResult,
      dataEnvelopes: capturedDataEnvelopes,
      sceneType: input.sceneIdHint || 'general',
      architectureType: capturedArchitectureType,
      knowledgeScope: input.knowledgeScope,
      snapshotPath: buildCaseEvolutionSnapshotPath(input.sessionId),
      provenance: {
        sessionId: input.sessionId,
        runId: input.runIdForAnalysis,
        turnIndex: capturedTurnIndex,
        engine: capturedEngine,
        traceContentHash,
      },
    });
  } catch (error) {
    input.logger.warn('CaseEvolution', 'Candidate capture failed (non-fatal)', {
      sessionId: input.sessionId,
      runId: input.runIdForAnalysis,
      error: errorMessage(error),
    });
  }
}

async function runAgentDrivenAnalysis(sessionId: string, query: string, traceId: string, options: any = {}) {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return;

  const inputRun = options.runContext as AnalyzeSessionRunContext | undefined;
  const requestedRunId = inputRun?.runId ?? session.activeRun?.runId;
  if (requestedRunId && (isSessionRunCancelled(session, requestedRunId) || isStaleRun(session, requestedRunId))) {
    session.logger.info('AgentDrivenAnalysis', 'Skipping inactive run before startup', {
      sessionId,
      runId: requestedRunId,
    });
    return;
  }
  if (inputRun) {
    setCurrentSessionRun(session, {
      ...inputRun,
      query,
      status: 'running',
      startedAt: inputRun.startedAt || Date.now(),
    });
    initializeCancelStateForRun(session, session.activeRun!);
    session.runSequence = Math.max(normalizeRunSequence(session.runSequence), normalizeRunSequence(inputRun.sequence));
  } else if (!session.activeRun) {
    const fallback = startSessionRun(session, query, generateRequestId());
    if (!fallback) return;
    setCurrentSessionRun(session, {
      ...fallback,
      status: 'running',
    });
    initializeCancelStateForRun(session, session.activeRun!);
  } else {
    setCurrentSessionRun(session, {
      ...session.activeRun,
      query,
      status: 'running',
      startedAt: session.activeRun.startedAt || Date.now(),
    });
    initializeCancelStateForRun(session, session.activeRun!);
  }

  const { logger } = session;
  const outputLanguage = sessionOutputLanguage(session);
  session.analysisMode = normalizeReceiptAnalysisMode(options.analysisMode) ?? session.analysisMode;
  session.status = 'running';
  session.lastActivityAt = Date.now();
  const runIdForAnalysis = session.activeRun?.runId;
  persistSessionRunState(session, 'running', undefined, runIdForAnalysis);
  const runHeartbeatInterval = startSessionRunHeartbeat(session, runIdForAnalysis);
  logger.info('AgentDrivenAnalysis', 'Starting agent-driven analysis', {
    query: sessionUsesPrivateKnowledge(session)
      ? privateAnalysisQueryMessage(outputLanguage)
      : query,
    traceId,
    runId: session.activeRun?.runId,
    requestId: session.activeRun?.requestId,
    runSequence: session.activeRun?.sequence,
  });
  const decoratedTraceContext = decorateTraceContextDatasets(options.traceContext, traceId);
  options.traceContext = decoratedTraceContext;
  if (!runIdForAnalysis) {
    throw new Error(`Missing run id for session ${sessionId}`);
  }
  const agentQuery =
    session.agentQuery && session.query === query
      ? session.agentQuery
      : buildAgentQueryWithContinuityNotice(query, session.continuityBreaks);

  // Track generation is a lightweight derivation step from DataEnvelopes.
  // Enable by default (unless explicitly disabled) so `/api/agent/v1/analyze` can
  // also produce TrackEvent(s) when the scene reconstruction skill runs.
  const shouldGenerateTracks = options.generateTracks !== false;

  // Capture LLM call telemetry into session logs (privacy-safe: hashes + params only)
  const modelRouter = getSharedModelRouter();
  const onLlmTelemetry = (event: any) => {
    if (!event || event.sessionId !== sessionId) return;
    logger.debug('LLM', 'llmTelemetry', event);
  };
  modelRouter.on('llmTelemetry', onLlmTelemetry);

  const runWithTraceProcessorLease = <T>(fn: () => Promise<T>): Promise<T> => {
    const leaseContexts = [options.traceProcessorLease, options.referenceTraceProcessorLease].filter(
      Boolean,
    ) as TraceProcessorLeaseQueryContext[];
    if (leaseContexts.length > 1 && options.traceProcessorService?.runWithLeases) {
      return options.traceProcessorService.runWithLeases(leaseContexts, fn);
    }
    if (leaseContexts.length === 1 && options.traceProcessorService?.runWithLease) {
      return options.traceProcessorService.runWithLease(leaseContexts[0], fn);
    }
    return fn();
  };

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    if (isStaleRun(session, runIdForAnalysis) || isSessionRunCancelled(session, runIdForAnalysis)) return;
    session.lastActivityAt = Date.now();
    const sourceAware = sessionUsesPrivateKnowledge({
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
    });
    const projectedUpdate = projectCodeAwareStreamingUpdate(
      sessionId,
      update,
      sourceAware,
      outputLanguage,
    );
    // Token events are both extremely high volume and may contain model text in
    // non-private runs. They are already represented by aggregate runtime
    // telemetry, so never duplicate them into console/session logs.
    if (projectedUpdate.type !== 'answer_token') {
      logger.debug('Stream', `Update: ${projectedUpdate.type}`, projectedUpdate.content);
    }
    const normalizedUpdate = augmentConclusionUpdateWithEvidenceIndex(
      session,
      normalizeAgentDrivenUpdate(projectedUpdate, outputLanguage),
    );

    // Final narrative is emitted through analysis_completed after deterministic
    // evidence/claim verification has run. Suppress early conclusion events so
    // clients do not render an unverified terminal answer.
    const shouldBroadcastOriginalUpdate =
      normalizedUpdate.type !== 'conclusion' && normalizedUpdate.type !== 'answer_token';
    if (shouldBroadcastOriginalUpdate) {
      broadcastToAgentDrivenClients(sessionId, normalizedUpdate, runIdForAnalysis);
    }

    // Also derive a conversation_step for the timeline/observability layer.
    const conversationStep = buildConversationStepUpdate(session, normalizedUpdate, runIdForAnalysis);
    if (conversationStep) {
      appendConversationStep(session, conversationStep);
      broadcastToAgentDrivenClients(sessionId, conversationStep, runIdForAnalysis);
    }

    // Derive TrackEvent(s) for scene reconstruction sessions from emitted DataEnvelopes.
    // This keeps the TrackEvent feature while unifying on the agent-driven architecture.
    if (shouldGenerateTracks && normalizedUpdate.type === 'data') {
      const envelopes = (
        Array.isArray(normalizedUpdate.content) ? normalizedUpdate.content : [normalizedUpdate.content]
      ).filter((e): e is DataEnvelope => !!e && typeof e === 'object');
      const changed = updateSceneReconstructionArtifactsFromEnvelopes(session, envelopes);
      if (changed) {
        broadcastToAgentDrivenClients(
          sessionId,
          {
            type: 'track_data',
            content: {
              tracks: session.trackEvents || [],
              scenes: session.scenes || [],
            },
            timestamp: update.timestamp,
            id: generateEventId('track_data', sessionId),
          },
          runIdForAnalysis,
        );
      }
    }

    // Track agent dialogue events
    if (normalizedUpdate.content?.phase === 'task_dispatched' || normalizedUpdate.content?.phase === 'task_completed') {
      pushWithSessionCap(
        session.agentDialogue,
        {
          agentId: normalizedUpdate.content.agentId || 'master',
          type: normalizedUpdate.content.phase === 'task_dispatched' ? 'task' : 'response',
          content: normalizedUpdate.content,
          timestamp: normalizedUpdate.timestamp,
        },
        MAX_SESSION_AGENT_DIALOGUE,
      );

      // Collect full agent responses for HTML report enrichment
      if (normalizedUpdate.content.phase === 'task_completed') {
        pushWithSessionCap(
          session.agentResponses,
          {
            taskId: normalizedUpdate.content.taskId || '',
            agentId: normalizedUpdate.content.agentId || 'unknown',
            response: normalizedUpdate.content.response || normalizedUpdate.content,
            timestamp: normalizedUpdate.timestamp,
          },
          MAX_SESSION_AGENT_RESPONSES,
        );
      }
    }

    // Broadcast specialized events for frontend visualization.
    // Skip if the mapped type is the same as the original — agentv3 events
    // (answer_token, thought, conclusion, etc.) are already broadcast above
    // and remapping would cause duplicate delivery to the frontend.
    const eventType = mapToAgentDrivenEventType(normalizedUpdate);
    if (shouldBroadcastOriginalUpdate && eventType !== normalizedUpdate.type) {
      broadcastToAgentDrivenClients(
        sessionId,
        {
          type: eventType,
          content: normalizedUpdate.content,
          timestamp: normalizedUpdate.timestamp,
          id: normalizedUpdate.id,
        },
        runIdForAnalysis,
      );
    }
  };

  // Listen to orchestrator events
  if (session.orchestratorUpdateHandler) {
    session.orchestrator.off('update', session.orchestratorUpdateHandler);
  }
  session.orchestratorUpdateHandler = handleUpdate;
  session.orchestrator.on('update', handleUpdate);

  // Run state_timeline in parallel while keeping it inside the run-owned lease.
  // Only execute when explicitly requested (e.g. scene reconstruction flow),
  // NOT on every analyze call — raw state lane data needs LLM reasoning before display.
  let stateTimelinePromise: Promise<void> = Promise.resolve();
  if (options.executeStateTimeline && options.traceProcessorService) {
    stateTimelinePromise = runWithTraceProcessorLease(() =>
      executeStateTimelineSkill(options.traceProcessorService, traceId),
    )
      .then((envelopes) => {
        const projected = projectStateTimelineRunResult({
          envelopes,
          isStaleRun: () => isStaleRun(session, runIdForAnalysis),
          isRunCancelled: () => isSessionRunCancelled(session, runIdForAnalysis),
          isRunActive: () => {
            const status = resolveSessionRun(session, runIdForAnalysis)?.status;
            return status === 'pending' || status === 'running';
          },
          updateArtifacts: (result) => updateSceneReconstructionArtifactsFromEnvelopes(session, result),
          emitData: (envelope) => {
            broadcastToAgentDrivenClients(
              sessionId,
              {
                type: 'data',
                content: envelope,
                timestamp: Date.now(),
                id: generateEventId('data', sessionId),
              },
              runIdForAnalysis,
            );
          },
          emitTrackData: () => {
            broadcastToAgentDrivenClients(
              sessionId,
              {
                type: 'track_data',
                content: {
                  tracks: session.trackEvents || [],
                  scenes: session.scenes || [],
                },
                timestamp: Date.now(),
                id: generateEventId('track_data', sessionId),
              },
              runIdForAnalysis,
            );
          },
        });
        if (!projected) return;
        logger.info('StateTimeline', 'State timeline lanes broadcast', {
          laneCount: Object.keys(session.stateTimeline || {}).length,
          envelopeCount: envelopes.length,
        });
      })
      .catch((err) => {
        logger.warn('StateTimeline', 'state_timeline skill failed (non-fatal)', {
          error: String(err?.message || err),
        });
      });
  }

  const traceContextEnvelopes = appendTraceContextDataEnvelopes(session, decoratedTraceContext, traceId);
  if (traceContextEnvelopes.length > 0) {
    broadcastToAgentDrivenClients(
      sessionId,
      {
        type: 'data',
        content: traceContextEnvelopes,
        timestamp: Date.now(),
      },
      runIdForAnalysis,
    );
  }

  try {
    console.log('[AgentRoutes.AgentDriven] Starting orchestrator.analyze...');
    let result;
    try {
      result = await logger.timed('AgentDrivenAnalysis', 'analyze', async () => {
        const analyze = () =>
          session.orchestrator.analyze(agentQuery, sessionId, traceId, {
            traceProcessorService: options.traceProcessorService,
            packageName: options.packageName,
            timeRange: options.timeRange,
            taskTimeoutMs: options.taskTimeoutMs,
            blockedStrategyIds: options.blockedStrategyIds,
            adb: options.adb,
            selectionContext: options.selectionContext,
            analysisMode: options.analysisMode,
            traceContext: decoratedTraceContext,
            referenceTraceId: options.referenceTraceId,
            tracePairContext: options.tracePairContext,
            providerId: options.providerId,
            outputLanguage,
            codeAwareMode: options.codeAwareMode,
            codebaseIds: Array.isArray(options.codebaseIds) ? options.codebaseIds : undefined,
            knowledgeSourceIds: Array.isArray(options.knowledgeSourceIds)
              ? options.knowledgeSourceIds
              : undefined,
            analysisContextFingerprint: session.analysisContextFingerprint,
            androidInternalsPackPin: session.androidInternalsPackPin,
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
            runId: session.activeRun?.runId,
            runManifestAttributionSink: options.runManifestAttributionSink,
          });
        return runWithTraceProcessorLease(analyze);
      });
    } finally {
      await stateTimelinePromise;
    }
    console.log('[AgentRoutes.AgentDriven] analyze completed, success:', result.success);
    if (session.analysisContextFingerprint && sessionUsesPrivateKnowledge(session)) {
      assertCurrentAnalysisContextAuthorization(
        {
          codeAwareMode: session.codeAwareMode,
          codebaseIds: session.codebaseIds,
          knowledgeSourceIds: session.knowledgeSourceIds,
        },
        options.knowledgeScope ?? {
          tenantId: session.tenantId,
          workspaceId: session.workspaceId,
          userId: session.userId,
        },
        session.analysisContextFingerprint,
      );
    }
    const runIsInactive = () =>
      isSessionRunCancelled(session, runIdForAnalysis) || isStaleRun(session, runIdForAnalysis);
    if (runIsInactive()) {
      logger.info('AgentDrivenAnalysis', 'Ignoring inactive analysis success', {
        sessionId,
        runId: runIdForAnalysis,
        cancelled: isSessionRunCancelled(session, runIdForAnalysis),
      });
      return;
    }

    // Ensure trackEvents/scenes are computed for completed sessions (even without SSE clients)
    if (shouldGenerateTracks) {
      updateSceneReconstructionArtifactsFromEnvelopes(session, session.dataEnvelopes as DataEnvelope[]);
    }

    if (session.referenceTraceId && options.traceProcessorService) {
      let comparisonReportSection: typeof session.comparisonReportSection;
      try {
        comparisonReportSection = await runWithTraceProcessorLease(() =>
          buildRawTraceComparisonReportSection(options.traceProcessorService, {
            currentTraceId: traceId,
            referenceTraceId: session.referenceTraceId!,
          }),
        );
      } catch (comparisonSectionError: any) {
        if (runIsInactive()) return;
        const comparisonTitle = localize(
          outputLanguage,
          'SmartPerfetto 确定性对比附录',
          'SmartPerfetto deterministic comparison appendix',
        );
        const comparisonFailure = localize(
          outputLanguage,
          '固定 SQL 附录生成失败。请重新运行分析；若问题持续，请携带诊断标识查看服务端日志。',
          'The deterministic SQL appendix could not be generated. Retry the analysis; if the problem persists, use the diagnostic identity to inspect server logs.',
        );
        logger.warn('AgentDrivenAnalysis', 'Comparison appendix generation failed', {
          sessionId,
          runId: runIdForAnalysis,
          diagnostic: diagnosticLogIdentity(errorMessage(comparisonSectionError)),
        });
        comparisonReportSection = {
          source: 'raw_trace_pair',
          title: comparisonTitle,
          markdown: [
            `## ${comparisonTitle}`,
            '',
            `- ${comparisonFailure}`,
            '',
          ].join('\n'),
          html: `<section class="smartperfetto-comparison-appendix"><h2>${escapeHtmlForInlineHtml(comparisonTitle)}</h2><p>${escapeHtmlForInlineHtml(comparisonFailure)}</p></section>`,
          limitations: [comparisonFailure],
        };
      }
      if (runIsInactive()) {
        logger.info('AgentDrivenAnalysis', 'Ignoring comparison result for inactive run', {
          sessionId,
          runId: runIdForAnalysis,
        });
        return;
      }
      session.comparisonSource = 'raw_trace_pair';
      session.comparisonReportSection = comparisonReportSection;
    }

    if (runIsInactive()) return;
    result.conclusion = completeFinalResultComparisonIdentity({
      conclusion: result.conclusion,
      identity: comparisonIdentityFromReportSection(session.comparisonReportSection),
      outputLanguage,
    });
    let sceneIdHint: string | undefined;
    if (result.success || result.partial === true) {
      // Read the case-evolution config ONCE per request so the attach-flag
      // and capture-flag decisions see the same snapshot (MINOR-2). Both the
      // retriever-attach gate below and the capture call below consume this.
      const caseEvolutionConfig = loadCaseEvolutionConfig();
      sceneIdHint = resolveConclusionSceneIdHint({
        sessionId,
        query,
        findings: result.findings,
        dataEnvelopes: session.dataEnvelopes,
      });
      let normalizedConclusionContract = (deriveEvidenceBackedConclusionContractForNarrative(
        result.conclusion,
        session.dataEnvelopes || [],
        {
          existingContract: result.conclusionContract as ConclusionContract | undefined,
          mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
          sceneId: sceneIdHint,
        },
      ) || undefined) as ConclusionContract | undefined;
      if (normalizedConclusionContract) {
        if (isCaseEvolutionRetrieveEnabled(caseEvolutionConfig)) {
          const attached = attachCaseHitsToContractSync({
            conclusionContract: normalizedConclusionContract,
            dataEnvelopes: session.dataEnvelopes || [],
            sceneType: sceneIdHint,
            architectureType: resolveCaseEvolutionArchitectureType(session, traceId),
            knowledgeScope: options.knowledgeScope,
          });
          normalizedConclusionContract = attached.contract;
        }
        result.conclusionContract = normalizedConclusionContract;
      }
      ensureAnalysisQualityArtifacts(session, normalizedConclusionContract, result);
      if (normalizedConclusionContract?.caseRecommendations?.length) {
        const pruned = verifyAndPruneCaseRecommendations({
          contract: normalizedConclusionContract,
          evidenceSignaturesByCluster: projectEvidenceSignaturesByCluster(
            session.dataEnvelopes || [],
            normalizedConclusionContract,
          ),
          narrative: result.conclusion,
          scope: options.knowledgeScope,
        });
        normalizedConclusionContract = pruned.contract;
        result.conclusionContract = normalizedConclusionContract;
        if (pruned.issues.length > 0) {
          result.claimVerificationResult = mergeCaseRecommendationVerificationIssues(
            result.claimVerificationResult,
            pruned.issues,
          );
          session.claimVerificationResult = result.claimVerificationResult;
        }
      }
      void captureCaseCandidatesAfterQualityArtifacts({
        sessionId,
        traceId,
        session,
        result,
        normalizedConclusionContract,
        sceneIdHint,
        runIdForAnalysis,
        knowledgeScope: options.knowledgeScope,
        caseEvolutionConfig,
        logger,
      });
    }

    completeAgentDrivenSessionWithResult({
      sessionId,
      query,
      traceId,
      sceneType: sceneIdHint,
      session,
      result,
      runId: runIdForAnalysis,
      logComponent: 'AgentDrivenAnalysis',
    });
  } catch (error: any) {
    const privateKnowledge = sessionUsesPrivateKnowledge(session);
    const authorizationChanged = error instanceof AnalysisContextAuthorizationChangedError ||
      error?.code === 'analysis_context_changed_restart_required';
    if (authorizationChanged) {
      await retireAuthorizationChangedSession(sessionId, session, handleUpdate);
    }
    const publicErrorMessage = privateKnowledge
      ? privateAnalysisFailureMessage(outputLanguage)
      : error.message;
    if (isSessionRunCancelled(session, runIdForAnalysis)) {
      logger.info('AgentDrivenAnalysis', 'Ignoring analysis error after cancellation', {
        sessionId,
        runId: runIdForAnalysis,
        error: publicErrorMessage,
      });
      return;
    }
    if (isStaleRun(session, runIdForAnalysis)) {
      logger.info('AgentDrivenAnalysis', 'Ignoring stale analysis error', {
        sessionId,
        runId: runIdForAnalysis,
        error: publicErrorMessage,
      });
      return;
    }
    session.status = 'failed';
    session.error = publicErrorMessage;
    markSessionRunStatus(session, 'failed', publicErrorMessage, runIdForAnalysis);
    logger.error(
      'AgentDrivenAnalysis',
      'Agent-driven analysis failed',
      privateKnowledge ? new Error(publicErrorMessage) : error,
    );

    broadcastToAgentDrivenClients(
      sessionId,
      {
        type: 'error',
        content: {
          message: publicErrorMessage,
          error: publicErrorMessage,
          ...(authorizationChanged ? {code: 'analysis_context_changed_restart_required'} : {}),
        },
        timestamp: Date.now(),
      },
      runIdForAnalysis,
    );

    if (authorizationChanged) {
      for (const client of session.sseClients) {
        try {
          client.end();
        } catch {}
      }
      session.sseClients = [];
      scrubAuthorizationChangedSession(session);
      assistantAppService.deleteSession(sessionId);
    }

    logger.close();
    throw error;
  } finally {
    if (runHeartbeatInterval) {
      clearInterval(runHeartbeatInterval);
    }
    // Prevent listener accumulation across multi-turn requests in the same session.
    session.orchestrator.off('update', handleUpdate);
    if (session.orchestratorUpdateHandler === handleUpdate) {
      session.orchestratorUpdateHandler = undefined;
    }
    modelRouter.off('llmTelemetry', onLlmTelemetry);
  }
}

function mergeCaseRecommendationVerificationIssues(
  existing: ClaimVerificationResult | undefined,
  issues: ClaimVerificationResult['issues'],
): ClaimVerificationResult {
  if (existing) {
    return {
      ...existing,
      issues: [...existing.issues, ...issues],
    };
  }
  return {
    schemaVersion: 'claim_verifier@1',
    status: 'partial',
    policy: 'record_only',
    passed: false,
    checkedClaimCount: 0,
    unsupportedClaimCount: 0,
    claimResults: [],
    issues,
  };
}

function sanitizeConversationText(value: unknown, maxLen = 240): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function escapeHtmlForInlineHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function appendConversationStep(session: AnalysisSession, update: StreamingUpdate): void {
  if (update.type !== 'conversation_step') return;

  const payload =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};
  const contentRecord =
    payload.content && typeof payload.content === 'object' && !Array.isArray(payload.content)
      ? (payload.content as Record<string, any>)
      : {};

  const text = sanitizeConversationText(contentRecord.text);
  const ordinal = Number(payload.ordinal);
  if (!text || !Number.isFinite(ordinal) || ordinal <= 0) return;

  const phaseRaw = sanitizeConversationText(payload.phase, 24) as AnalysisSession['conversationSteps'][number]['phase'];
  const phase =
    phaseRaw === 'thinking' || phaseRaw === 'tool' || phaseRaw === 'result' || phaseRaw === 'error'
      ? phaseRaw
      : 'progress';

  const roleRaw = sanitizeConversationText(payload.role, 16) as AnalysisSession['conversationSteps'][number]['role'];
  const role = roleRaw === 'system' ? 'system' : 'agent';

  const eventId =
    sanitizeConversationText(payload.eventId, 128) ||
    sanitizeConversationText(update.id, 128) ||
    `conversation-step-${session.sessionId}-${ordinal}`;

  if (session.conversationSteps.some((step) => step.eventId === eventId || step.ordinal === ordinal)) {
    return;
  }

  session.conversationSteps.push({
    eventId,
    ordinal,
    phase,
    role,
    text,
    timestamp:
      typeof update.timestamp === 'number' && Number.isFinite(update.timestamp) ? update.timestamp : Date.now(),
    sourceEventType: sanitizeConversationText(payload?.source?.eventType, 48) || undefined,
  });

  session.conversationSteps.sort((a, b) => a.ordinal - b.ordinal);
  if (session.conversationSteps.length > 400) {
    session.conversationSteps.splice(0, session.conversationSteps.length - 400);
  }
}

function summarizeTimelineToolCall(content: Record<string, any>): string {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return '';

  const generated = formatToolCallNarration(toolName, content.args);
  const message = sanitizeConversationText(content.message);
  if (!message || looksLikeGenericToolMessage(message)) {
    return generated;
  }

  return message;
}

function normalizeTimelineTraceSide(value: unknown): 'current' | 'reference' | undefined {
  return value === 'current' || value === 'reference' ? value : undefined;
}

function normalizeTimelinePaneSide(value: unknown): 'left' | 'right' | 'top' | 'bottom' | undefined {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom' ? value : undefined;
}

function timelineTraceRoleLabel(
  traceSide: 'current' | 'reference',
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  return traceSide === 'reference'
    ? localize(language, '参考', 'reference')
    : localize(language, '当前', 'current');
}

function timelinePaneLabel(
  paneSide: 'left' | 'right' | 'top' | 'bottom',
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  switch (paneSide) {
    case 'left':
      return localize(language, '左侧', 'left');
    case 'right':
      return localize(language, '右侧', 'right');
    case 'top':
      return localize(language, '上方', 'top');
    case 'bottom':
      return localize(language, '下方', 'bottom');
  }
}

function timelineTraceLocationLabel(
  envelope: Record<string, any>,
  language: ReturnType<typeof parseOutputLanguage>,
): string | undefined {
  const traceSide = normalizeTimelineTraceSide(
    envelope?.meta?.traceSide || envelope?.traceSide || envelope?.traceProvenance?.traceSide,
  );
  if (!traceSide) return undefined;

  const paneSide = normalizeTimelinePaneSide(
    envelope?.meta?.paneSide || envelope?.paneSide || envelope?.traceProvenance?.paneSide,
  );
  const roleLabel = timelineTraceRoleLabel(traceSide, language);
  return paneSide ? `${timelinePaneLabel(paneSide, language)}/${roleLabel}` : roleLabel;
}

function summarizeTimelineResult(content: Record<string, any>): string {
  const candidates = [content.summary, content.message, content.result, content.output];

  for (const candidate of candidates) {
    const text = sanitizeConversationText(candidate);
    if (text) return text;
  }
  return '';
}

function summarizeDataEnvelopeForTimeline(
  update: StreamingUpdate,
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  const envelopes = (Array.isArray(update.content) ? update.content : [update.content]).filter(
    (entry) => entry && typeof entry === 'object',
  ) as Array<Record<string, any>>;
  if (envelopes.length === 0) return '';

  const allTitles = envelopes
    .map((env) => sanitizeConversationText(env?.display?.title || env?.meta?.stepId || env?.meta?.source))
    .filter(Boolean);
  const titles = allTitles.slice(0, 4);
  const omittedTitleCount = Math.max(0, allTitles.length - titles.length);
  const rows = envelopes
    .map((env) => {
      const data = env?.data;
      return Array.isArray(data?.rows) ? data.rows.length : undefined;
    })
    .filter((rowCount): rowCount is number => typeof rowCount === 'number');
  const rowCount = rows.reduce((sum, count) => sum + count, 0);
  const rowText = rows.length > 0
    ? localize(language, `，共 ${rowCount} 行`, `, ${rowCount} rows total`)
    : '';
  const traceLocations = [
    ...new Set(envelopes.map(env => timelineTraceLocationLabel(env, language)).filter((label): label is string => !!label)),
  ];
  const traceText = traceLocations.length > 0
    ? localize(language, `，Trace: ${traceLocations.join('/')}`, `, trace: ${traceLocations.join('/')}`)
    : '';
  const evidenceRefs = envelopes.map((env) => sanitizeConversationText(env?.meta?.evidenceRefId)).filter(Boolean);
  const evidenceText = evidenceRefs.length > 0
    ? localize(language, `，已登记 ${evidenceRefs.length} 个证据 ID`, `, ${evidenceRefs.length} evidence IDs recorded`)
    : '';
  const formats = [
    ...new Set(envelopes.map((env) => sanitizeConversationText(env?.display?.format, 24)).filter(Boolean)),
  ];
  const kindText =
    formats.length === 1
      ? (
          {
            table: localize(language, '数据表', 'tables'),
            summary: localize(language, '摘要数据', 'summaries'),
            metric: localize(language, '指标数据', 'metrics'),
            chart: localize(language, '图表数据', 'charts'),
            text: localize(language, '文本数据', 'text outputs'),
            timeline: localize(language, '时间线数据', 'timelines'),
          } as Record<string, string>
        )[formats[0]] || localize(language, '数据输出', 'data outputs')
      : localize(language, '数据输出', 'data outputs');
  const planPhases = [
    ...new Set(
      envelopes
        .map((env) => sanitizeConversationText(env?.meta?.planPhaseTitle || env?.meta?.planPhaseId, 80))
        .filter(Boolean),
    ),
  ];
  const phaseText = planPhases.length > 0
    ? localize(language, `，阶段: ${planPhases.slice(0, 2).join('/')}`, `, phase: ${planPhases.slice(0, 2).join('/')}`)
    : '';
  const phaseWarnings = [
    ...new Set(envelopes.map((env) => sanitizeConversationText(env?.meta?.planPhaseWarning, 120)).filter(Boolean)),
  ];
  const phaseWarningText = phaseWarnings.length > 0
    ? localize(language, `，阶段归因需核对: ${phaseWarnings.slice(0, 2).join('；')}`, `, phase attribution needs review: ${phaseWarnings.slice(0, 2).join('; ')}`)
    : '';
  const reasons = envelopes
    .map((env) => sanitizeConversationText(env?.meta?.producerReason || env?.meta?.toolNarration, 180))
    .filter(Boolean);
  const uniqueReasons = [...new Set(reasons)].slice(0, 3);
  const omittedReasonCount = Math.max(0, reasons.length - uniqueReasons.length);
  const reasonText =
    uniqueReasons.length > 0
      ? localize(
          language,
          `：${uniqueReasons.join('；')}${omittedReasonCount > 0 ? `；另有 ${omittedReasonCount} 条原因` : ''}`,
          `: ${uniqueReasons.join('; ')}${omittedReasonCount > 0 ? `; ${omittedReasonCount} more reasons` : ''}`,
        )
      : '';
  const titleText =
    titles.length > 0
      ? localize(
          language,
          `：${titles.join(' / ')}${omittedTitleCount > 0 ? ` / 另有 ${omittedTitleCount} 份` : ''}`,
          `: ${titles.join(' / ')}${omittedTitleCount > 0 ? ` / ${omittedTitleCount} more` : ''}`,
        )
      : '';
  const fallbackReason = localize(language, '，用于支撑后续诊断', ', supporting subsequent diagnosis');
  return localize(language, `收到 ${envelopes.length} 份`, `Received ${envelopes.length} `) +
    `${kindText}${titleText}${rowText}${traceText}${phaseText}${phaseWarningText}${evidenceText}${reasonText || fallbackReason}`;
}

function buildConversationStepUpdate(
  session: AnalysisSession,
  update: StreamingUpdate,
  runId?: string,
): StreamingUpdate | null {
  if (update.type === 'conversation_step') return null;

  const contentRecord =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};

  let phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error' = 'progress';
  let role: 'agent' | 'system' = 'agent';
  let text = '';
  const language = sessionOutputLanguage(session);

  switch (update.type) {
    case 'progress':
    case 'degraded':
    case 'stage_transition':
    case 'round_start':
    case 'strategy_decision':
    case 'synthesis_complete':
    case 'hypothesis_generated':
      phase = 'progress';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.fallback && localize(language, `降级处理: ${contentRecord.fallback}`, `Degraded handling: ${contentRecord.fallback}`)) ||
        sanitizeConversationText(contentRecord.reasoning) ||
        sanitizeConversationText(contentRecord.phase && localize(language, `阶段: ${contentRecord.phase}`, `Phase: ${contentRecord.phase}`));
      if (!text && update.type === 'hypothesis_generated' && Array.isArray(contentRecord.hypotheses)) {
        text = localize(language, `形成 ${contentRecord.hypotheses.length} 个待验证假设`, `Formed ${contentRecord.hypotheses.length} hypotheses to verify`);
      }
      break;
    case 'thought':
    case 'worker_thought':
      phase = 'thinking';
      role = update.type === 'worker_thought' ? 'system' : 'agent';
      text =
        sanitizeConversationText(contentRecord.thought) ||
        sanitizeConversationText(contentRecord.content) ||
        sanitizeConversationText(contentRecord.message);
      break;
    case 'tool_call':
    case 'agent_task_dispatched':
    case 'agent_dialogue':
      phase = 'tool';
      role = 'agent';
      text =
        summarizeTimelineToolCall(contentRecord) ||
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.taskTitle) ||
        sanitizeConversationText(contentRecord.toolName);
      break;
    case 'agent_response':
    case 'finding':
      phase = 'result';
      role = 'agent';
      if (update.type === 'finding' && Array.isArray(contentRecord.findings)) {
        const firstFinding = contentRecord.findings.find((entry) => entry && typeof entry === 'object') as
          Record<string, any> | undefined;
        const firstTitle = sanitizeConversationText(firstFinding?.title || firstFinding?.description);
        text = firstTitle
          ? localize(
              language,
              `新增发现 ${contentRecord.findings.length} 条: ${firstTitle}`,
              `${contentRecord.findings.length} new findings: ${firstTitle}`,
            )
          : localize(
              language,
              `新增发现 ${contentRecord.findings.length} 条`,
              `${contentRecord.findings.length} new findings`,
            );
      } else {
        text =
          summarizeTimelineResult(contentRecord) ||
          (contentRecord.taskId ? localize(language, `工具调用完成 (#${String(contentRecord.taskId).slice(-6)})`, `Tool call completed (#${String(contentRecord.taskId).slice(-6)})`) : '');
      }
      break;
    case 'data': {
      phase = 'result';
      role = 'system';
      text = summarizeDataEnvelopeForTimeline(update, language);
      break;
    }
    case 'conclusion':
      phase = 'result';
      role = 'agent';
      text =
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.message) ||
        localize(language, '最终结论已生成', 'Final conclusion generated');
      break;
    case 'answer_token':
      if (contentRecord.done === true) {
        phase = 'result';
        role = 'agent';
        text = localize(language, '最终回答生成完成', 'Final answer generation completed');
      }
      break;
    case 'error':
      phase = 'error';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.error) ||
        localize(language, '分析过程中发生错误', 'An error occurred during analysis');
      break;
    default:
      return null;
  }

  if (!text) return null;

  session.conversationOrdinal = (Number.isFinite(session.conversationOrdinal) ? session.conversationOrdinal : 0) + 1;
  const ordinal = session.conversationOrdinal;
  const eventId = generateEventId('conversation_step', session.sessionId);

  const metadata: Record<string, unknown> = {};
  if (typeof contentRecord.round === 'number' && Number.isFinite(contentRecord.round)) {
    metadata.round = contentRecord.round;
  }
  if (typeof contentRecord.strategyId === 'string' && contentRecord.strategyId.trim()) {
    metadata.strategyId = contentRecord.strategyId.trim();
  }
  if (contentRecord.partial === true) {
    metadata.partial = true;
  }
  if (typeof contentRecord.terminationReason === 'string' && contentRecord.terminationReason.trim()) {
    metadata.terminationReason = contentRecord.terminationReason.trim();
  }
  const run = resolveSessionRun(session, runId);
  if (run?.runId) {
    metadata.runId = run.runId;
  }
  if (run?.requestId) {
    metadata.requestId = run.requestId;
  }
  if (typeof run?.sequence === 'number' && Number.isFinite(run.sequence)) {
    metadata.runSequence = run.sequence;
  }

  return {
    type: 'conversation_step',
    id: eventId,
    timestamp: update.timestamp || Date.now(),
    content: {
      eventId,
      sessionId: session.sessionId,
      traceId: session.traceId,
      phase,
      role,
      ordinal,
      content: {
        text,
      },
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      source: {
        eventType: update.type,
        phase: typeof contentRecord.phase === 'string' ? contentRecord.phase : undefined,
      },
    },
  };
}

/**
 * Normalize orchestrator updates before mapping/broadcasting
 */
function normalizeAgentDrivenUpdate(
  update: StreamingUpdate,
  language: OutputLanguage = configuredOutputLanguage(),
): StreamingUpdate {
  const rawContent = update.content;
  if (!rawContent || typeof rawContent !== 'object' || Array.isArray(rawContent)) {
    return update;
  }

  const content: Record<string, any> = {
    ...(rawContent as Record<string, any>),
  };

  if (update.type === 'stage_transition') {
    const stageName = typeof content.stageName === 'string' ? content.stageName : 'unknown';
    const hasStageIndex = typeof content.stageIndex === 'number' && Number.isFinite(content.stageIndex);
    const hasTotalStages =
      typeof content.totalStages === 'number' && Number.isFinite(content.totalStages) && content.totalStages > 0;
    const skipped = content.skipped === true;
    const skipReason = typeof content.skipReason === 'string' ? content.skipReason.trim() : '';
    const stageSeq = hasStageIndex && hasTotalStages ? ` (${content.stageIndex + 1}/${content.totalStages})` : '';
    if (typeof content.phase !== 'string' || !content.phase.trim()) {
      content.phase = 'stage_transition';
    }
    if (typeof content.message !== 'string' || !content.message.trim()) {
      const prefix = skipped
        ? localize(language, '跳过阶段', 'Skipping stage')
        : localize(language, '进入阶段', 'Entering stage');
      const reason = skipped && skipReason ? `: ${skipReason}` : '';
      content.message = `${prefix} ${stageName}${stageSeq}${reason}`;
    }
  }

  if (update.type === 'tool_call') {
    const phase = typeof content.phase === 'string' ? content.phase : '';
    const phaseLower = phase.toLowerCase();
    const isDone = phaseLower.includes('completed') || phaseLower.includes('done') || phaseLower.includes('finished');
    if (typeof content.phase !== 'string' || !content.phase.trim()) {
      content.phase = isDone ? 'task_completed' : 'task_dispatched';
    }
    if (typeof content.message !== 'string' || !content.message.trim()) {
      const taskTitle = typeof content.taskTitle === 'string' ? content.taskTitle : '';
      const toolName = typeof content.toolName === 'string' ? content.toolName : '';
      const displayName = taskTitle || toolName || localize(language, '工具任务', 'tool task');
      content.message = isDone
        ? localize(language, `完成 ${displayName}`, `Completed ${displayName}`)
        : localize(language, `调用 ${displayName}`, `Calling ${displayName}`);
    }
  }

  return {
    ...update,
    content,
  };
}

function mapToAgentDrivenEventType(update: StreamingUpdate): StreamingUpdate['type'] {
  const phase = update.content?.phase;

  if (update.type === 'conversation_step') {
    return 'conversation_step';
  }

  if (update.type === 'stage_transition') {
    return 'progress';
  }

  if (update.type === 'tool_call') {
    const phaseText = typeof phase === 'string' ? phase.toLowerCase() : '';
    const isComplete = phaseText.includes('completed') || phaseText.includes('done') || phaseText.includes('finished');
    return isComplete ? 'agent_response' : 'agent_dialogue';
  }

  switch (phase) {
    case 'starting':
    case 'understanding':
      return 'progress';
    case 'hypotheses_generated':
      return 'hypothesis_generated';
    case 'round_start':
      return 'round_start';
    case 'tasks_dispatched':
      return 'agent_task_dispatched';
    case 'task_dispatched':
      return 'agent_dialogue';
    case 'task_completed':
      return 'agent_response';
    case 'synthesis_complete':
      return 'synthesis_complete';
    case 'strategy_decision':
      return 'strategy_decision';
    case 'concluding':
      return 'progress';
    default:
      return update.type;
  }
}

function dataEnvelopeDedupKey(envelope: DataEnvelope): string | undefined {
  const meta = envelope.meta;
  if (!meta) return undefined;
  if (typeof meta.evidenceRefId === 'string' && meta.evidenceRefId.length > 0) {
    return `evidence:${meta.evidenceRefId}`;
  }
  if (typeof meta.queryHash === 'string' && meta.queryHash.length > 0) {
    return `query:${meta.traceId || ''}:${meta.queryHash}`;
  }
  return undefined;
}

/**
 * Broadcast update to all SSE clients for an agent-driven session
 */
function broadcastToAgentDrivenClients(sessionId: string, update: StreamingUpdate, runId?: string) {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return;
  if (runId && !isCurrentRunOwner(session, runId)) return;
  session.lastActivityAt = Date.now();

  // F3: Assign monotonic sequence ID for replay on reconnect
  const seqId = ++session.sseEventSeq;

  streamProjector.broadcastStreamingUpdate(sessionId, filterSseClientsForRun(session.sseClients, runId), update, {
    observability: buildStreamObservability(session, runId),
    seqId,
    onBufferedEvent: (event) => {
      if (runId) event.runId = runId;
      session.sseEventBuffer.push(event);
      persistBufferedAgentEvent(
        session,
        {
          cursor: event.seqId,
          eventType: event.eventType,
          eventData: event.eventData,
          createdAt: Date.now(),
        },
        runId,
      );
      // Trim ring buffer to cap
      if (session.sseEventBuffer.length > SSE_RING_BUFFER_SIZE) {
        session.sseEventBuffer.splice(0, session.sseEventBuffer.length - SSE_RING_BUFFER_SIZE);
      }
    },
    onDataEnvelopeValidationWarning: (payload) => {
      console.warn(
        `[AgentRoutes.broadcastToAgentDrivenClients] DataEnvelope validation warning (envelope ${payload.envelopeIndex}):`,
        {
          sessionId: payload.sessionId,
          errors: payload.errors.slice(0, 5),
          totalErrors: payload.errors.length,
          envelope: payload.envelope,
        },
      );
    },
    onValidDataEnvelopes: (validEnvelopes) => {
      if (validEnvelopes.length > 0) {
        const existingKeys = new Set(
          (session.dataEnvelopes || [])
            .map(dataEnvelopeDedupKey)
            .filter((key): key is string => typeof key === 'string' && key.length > 0),
        );
        const uniqueEnvelopes = validEnvelopes.filter((env) => {
          const key = dataEnvelopeDedupKey(env);
          if (!key) return true;
          if (existingKeys.has(key)) return false;
          existingKeys.add(key);
          return true;
        });
        console.log(
          `[AgentRoutes.broadcastToAgentDrivenClients] Sending ${validEnvelopes.length} DataEnvelope(s) for session ${sessionId}`,
        );
        if (uniqueEnvelopes.length === 0) return;
        // P2-4: Tag envelopes with current turn number for multi-turn attribution
        const run = resolveSessionRun(session, runId);
        const turnNumber = run?.sequence || session.runSequence || 1;
        for (const env of uniqueEnvelopes) {
          if (env.meta) (env.meta as any).turn = turnNumber;
        }
        session.dataEnvelopes.push(...uniqueEnvelopes);
        trimSessionArray(session.dataEnvelopes, MAX_SESSION_DATA_ENVELOPES);
      }
    },
  });
}

// =============================================================================
// Scene Reconstruction: Derive scenes + TrackEvent(s) from DataEnvelopes
// =============================================================================

const SCENE_DISPLAY_NAMES: Record<SceneCategory, string> = {
  cold_start: '冷启动',
  warm_start: '温启动',
  hot_start: '热启动',
  scroll_start: '滑动启动',
  scroll: '滑动',
  inertial_scroll: '惯性滑动',
  navigation: '跳转',
  app_switch: '应用切换',
  home_screen: '桌面',
  app_foreground: '应用内',
  screen_on: '屏幕点亮',
  screen_off: '屏幕熄灭',
  screen_sleep: '屏幕休眠',
  screen_unlock: '解锁屏幕',
  notification: '通知操作',
  split_screen: '分屏操作',
  tap: '点击',
  long_press: '长按',
  idle: '空闲',
  jank_region: '性能问题区间',
  back_key: '返回键',
  home_key: 'Home键',
  recents_key: '最近任务键',
  anr: 'ANR',
  ime_show: '键盘弹出',
  ime_hide: '键盘收起',
  window_transition: '窗口转场',
};

const SCENE_DISPLAY_NAMES_EN: Record<SceneCategory, string> = {
  cold_start: 'cold start',
  warm_start: 'warm start',
  hot_start: 'hot start',
  scroll_start: 'scroll start',
  scroll: 'scroll',
  inertial_scroll: 'inertial scroll',
  navigation: 'navigation',
  app_switch: 'app switch',
  home_screen: 'home screen',
  app_foreground: 'app foreground',
  screen_on: 'screen on',
  screen_off: 'screen off',
  screen_sleep: 'screen sleep',
  screen_unlock: 'screen unlock',
  notification: 'notification action',
  split_screen: 'split-screen action',
  tap: 'tap',
  long_press: 'long press',
  idle: 'idle',
  jank_region: 'performance issue interval',
  back_key: 'Back key',
  home_key: 'Home key',
  recents_key: 'Recents key',
  anr: 'ANR',
  ime_show: 'keyboard shown',
  ime_hide: 'keyboard hidden',
  window_transition: 'window transition',
};

function sceneDisplayName(sceneType: SceneCategory, language = configuredOutputLanguage()): string {
  return language === 'en'
    ? SCENE_DISPLAY_NAMES_EN[sceneType] || sceneType
    : SCENE_DISPLAY_NAMES[sceneType] || sceneType;
}

const SCENE_COLOR_SCHEMES: Record<SceneCategory, TrackEvent['colorScheme']> = {
  cold_start: 'launch',
  warm_start: 'launch',
  hot_start: 'launch',
  scroll_start: 'scroll',
  scroll: 'scroll',
  inertial_scroll: 'scroll',
  navigation: 'navigation',
  app_switch: 'system',
  home_screen: 'system',
  app_foreground: 'system',
  screen_on: 'system',
  screen_off: 'system',
  screen_sleep: 'system',
  screen_unlock: 'system',
  notification: 'system',
  split_screen: 'system',
  tap: 'tap',
  long_press: 'tap',
  idle: 'system',
  jank_region: 'jank', // Use jank color to highlight performance issues
  back_key: 'system',
  home_key: 'system',
  recents_key: 'system',
  anr: 'jank',
  ime_show: 'system',
  ime_hide: 'system',
  window_transition: 'navigation',
};

/** A single continuous segment in a state timeline lane. */
interface StateLaneSegment {
  lane: string;
  state: string;
  stateLabel: string;
  startTs: string;
  endTs: string;
  durMs: number;
  sourceStatus: string;
  confidence?: string;
}

/** Lane step IDs from state_timeline skill */
const STATE_LANE_STEP_IDS = new Set([
  'device_state_lane',
  'device_state_lane_fallback',
  'input_state_lane_frames',
  'input_state_lane_fallback',
  'app_state_lane',
  'app_state_lane_fallback',
  'system_state_lane',
]);

/** Map stepId → lane name */
const STEP_TO_LANE: Record<string, string> = {
  device_state_lane: 'device',
  device_state_lane_fallback: 'device',
  input_state_lane_frames: 'input',
  input_state_lane_fallback: 'input',
  app_state_lane: 'app',
  app_state_lane_fallback: 'app',
  system_state_lane: 'system',
};

type LaneStatus = 'available' | 'available_frame_based' | 'available_heuristic' | 'table_missing' | 'no_data';
const VALID_LANE_STATUSES = new Set<string>([
  'available',
  'available_frame_based',
  'available_heuristic',
  'table_missing',
  'no_data',
]);
/** Statuses indicating data is expected (table exists, may have rows). */
const DATA_PRESENT_STATUSES = new Set<string>(['available', 'available_frame_based', 'available_heuristic']);

/**
 * Single-pass extraction of state timeline lanes + lane availability from DataEnvelopes.
 * Combines what would otherwise be two separate iterations over the same envelope array.
 */
function extractStateTimelineData(envelopes: DataEnvelope[]): {
  timeline: Record<string, StateLaneSegment[]>;
  availability: Record<string, LaneStatus>;
} {
  const timeline: Record<string, StateLaneSegment[]> = {};
  const availability: Record<string, LaneStatus> = {};

  for (const env of envelopes) {
    if (!env || env.meta?.skillId !== 'state_timeline') continue;
    const stepId = env.meta.stepId || '';

    // Lane summary → extract availability
    if (stepId === 'lane_summary') {
      const rows = payloadToObjectRowsLocal(env.data);
      for (const row of rows) {
        const lane = String(row.lane || '');
        const status = String(row.source_status || 'available');
        if (lane) {
          availability[lane] = VALID_LANE_STATUSES.has(status) ? (status as LaneStatus) : 'available';
        }
      }
      continue;
    }

    // Lane data steps → extract segments
    if (!STATE_LANE_STEP_IDS.has(stepId)) continue;

    const laneName = STEP_TO_LANE[stepId] || stepId;

    // Real data over fallback: conditions are mutually exclusive, but be safe.
    const isFallbackStep = stepId.endsWith('_fallback');
    if (isFallbackStep && timeline[laneName]?.length > 0) {
      continue;
    }

    const rows = payloadToObjectRowsLocal(env.data);
    if (rows.length === 0) continue;

    const segments: StateLaneSegment[] = [];
    for (const row of rows) {
      const startTs = String(row.start_ts || '');
      const endTs = String(row.end_ts || '');
      const durMs = Number(row.dur_ms || 0);
      if (!startTs || !endTs || durMs <= 0) continue;

      segments.push({
        lane: laneName,
        state: String(row.state || 'UNKNOWN'),
        stateLabel: String(row.state_label || ''),
        startTs,
        endTs,
        durMs,
        sourceStatus: String(row.source_status || 'available'),
        confidence: row.confidence ? String(row.confidence) : undefined,
      });
    }

    if (segments.length > 0) {
      timeline[laneName] = segments;
    }
  }

  // Reconcile: if a lane has segments, it's available; if lane_summary said
  // 'available' but we got no segments, it's really 'no_data'.
  for (const lane of [...new Set(Object.values(STEP_TO_LANE))]) {
    if (timeline[lane] && timeline[lane].length > 0) {
      // Has real data — check if it's all UNKNOWN (empty-source fallback)
      const allUnknown = timeline[lane].every((s) => s.state === 'UNKNOWN' || s.state === 'IDLE');
      if (!availability[lane]) {
        availability[lane] = allUnknown ? 'no_data' : 'available';
      }
    } else if (DATA_PRESENT_STATUSES.has(availability[lane])) {
      // lane_summary said available, but no segments arrived → no_data
      availability[lane] = 'no_data';
    }
  }

  return { timeline, availability };
}

function updateSceneReconstructionArtifactsFromEnvelopes(session: AnalysisSession, envelopes: DataEnvelope[]): boolean {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return false;

  // Extract scene events (from scene_reconstruction skill)
  const extractedScenes = extractDetectedScenesFromEnvelopes(envelopes);

  // Extract state timeline + lane availability in a single pass
  const { timeline, availability } = extractStateTimelineData(envelopes);
  let hasTimelineUpdate = false;

  if (Object.keys(timeline).length > 0) {
    session.stateTimeline = Object.assign(session.stateTimeline || {}, timeline);
    hasTimelineUpdate = true;
  }
  if (Object.keys(availability).length > 0) {
    session.laneAvailability = Object.assign(session.laneAvailability || {}, availability);
  }

  if (extractedScenes.length === 0) return hasTimelineUpdate;

  const mergedScenes = mergeDetectedScenes(session.scenes || [], extractedScenes);
  const mergedTracks = buildTrackEventsFromScenes(mergedScenes);

  const prevFingerprint = fingerprintTrackEvents(session.trackEvents || []);
  const nextFingerprint = fingerprintTrackEvents(mergedTracks);

  session.scenes = mergedScenes;
  session.trackEvents = mergedTracks;

  return prevFingerprint !== nextFingerprint;
}

function extractDetectedScenesFromEnvelopes(envelopes: DataEnvelope[]): DetectedScene[] {
  const scenes: DetectedScene[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];

  for (const env of envelopes) {
    if (!env || env.meta?.skillId !== 'scene_reconstruction') continue;

    const stepId = env.meta.stepId || '';
    const rows = payloadToObjectRowsLocal(env.data);
    if (rows.length === 0) continue;

    // Step: screen_state_changes (screen on/off/sleep)
    if (stepId === 'screen_state_changes') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const eventText = String(row.event || '');
        const type = mapScreenStateEventToSceneType(eventText);
        if (!type) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          metadata: {
            source: 'scene_reconstruction:screen_state_changes',
            event: eventText,
          },
        });
      }
      continue;
    }

    // Step: app_launches (startup events)
    if (stepId === 'app_launches') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startupType = String(row.startup_type || '').toLowerCase();
        const type: SceneCategory =
          startupType === 'warm' ? 'warm_start' : startupType === 'hot' ? 'hot_start' : 'cold_start';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.95,
          appPackage: extractRowAppPackage(row, ['package']),
          metadata: {
            source: 'scene_reconstruction:app_launches',
            startupType: startupType || undefined,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: user_gestures (tap/scroll/long_press)
    if (stepId === 'user_gestures') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const gestureType = String(row.gesture_type || '').toLowerCase();
        const type: SceneCategory =
          gestureType === 'scroll' ? 'scroll' : gestureType === 'long_press' ? 'long_press' : 'tap';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:user_gestures',
            moveCount: row.move_count,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: scroll_initiation (precise scroll start marker)
    if (stepId === 'scroll_initiation') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'scroll_start',
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row, ['app']),
          metadata: {
            source: 'scene_reconstruction:scroll_initiation',
            gestureId: row.gesture_id,
            event: row.event,
            explanation: row.explanation,
          },
        });
      }
      continue;
    }

    // Step: inertial_scrolls (fling inertia region after finger up)
    if (stepId === 'inertial_scrolls') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);
        const frameCount = Number(row.frame_count || 0);

        scenes.push({
          type: 'inertial_scroll',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: frameCount >= 12 ? 0.9 : frameCount >= 8 ? 0.8 : 0.7,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:inertial_scrolls',
            frameCount,
            jankFrames: Number(row.jank_frames || 0),
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: idle_periods (no obvious operation gap)
    if (stepId === 'idle_periods') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'idle',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          metadata: {
            source: 'scene_reconstruction:idle_periods',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: top_app_changes (app switches)
    if (stepId === 'top_app_changes') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'app_switch',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:top_app_changes',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: system_events (unlock/notification/split screen)
    if (stepId === 'system_events') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const eventText = String(row.event || '');
        const type = mapSystemEventToSceneType(eventText);
        if (!type) continue;
        // Guardrail: ignore very short unlock slices (usually render/mutex noise).
        if (type === 'screen_unlock' && durNs < 100_000_000n) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.85,
          metadata: {
            source: 'scene_reconstruction:system_events',
            event: eventText,
          },
        });
      }
      continue;
    }

    // Step: clean_timeline (quality-gated unified timeline)
    if (stepId === 'clean_timeline') {
      const cleanTimelineTypeMapping: Record<string, SceneCategory> = {
        cold_start: 'cold_start',
        warm_start: 'warm_start',
        hot_start: 'hot_start',
        scroll: 'scroll',
        tap: 'tap',
        long_press: 'long_press',
        screen_on: 'screen_on',
        screen_off: 'screen_off',
        screen_sleep: 'screen_sleep',
        screen_unlock: 'screen_unlock',
        notification: 'notification',
        split_screen: 'split_screen',
        pip: 'navigation',
        app_switch: 'app_switch',
        home_screen: 'home_screen',
        app_foreground: 'app_foreground',
        back_key: 'back_key',
        home_key: 'home_key',
        recents_key: 'recents_key',
        anr: 'anr',
        ime_show: 'ime_show',
        ime_hide: 'ime_hide',
        window_transition: 'window_transition',
        idle: 'idle',
      };

      for (const row of rows) {
        const eventType = String(row.event_type || '');
        const sceneType = cleanTimelineTypeMapping[eventType];
        if (!sceneType) continue;

        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: sceneType,
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:clean_timeline',
            eventId: row.event_id,
            timeOffset: row.time_offset,
            rating: row.rating,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: jank_events (performance issue regions) - FALLBACK
    // Collected first; only used if no gesture-like scenes are found.
    if (stepId === 'jank_events') {
      jankRowsForFallback.push(...rows);
      continue;
    }
  }

  const hasGestureLikeScene = scenes.some(
    (scene) =>
      scene.type === 'tap' ||
      scene.type === 'scroll' ||
      scene.type === 'long_press' ||
      scene.type === 'inertial_scroll',
  );

  if (!hasGestureLikeScene && jankRowsForFallback.length > 0) {
    const jankIntervals = aggregateJankFramesToIntervals(jankRowsForFallback);
    for (const interval of jankIntervals) {
      if (interval.jankCount < 3) continue;
      scenes.push({
        type: 'jank_region',
        startTs: interval.startTs,
        endTs: interval.endTs,
        durationMs: interval.durationMs,
        confidence: 0.8,
        metadata: {
          source: 'scene_reconstruction:jank_events',
          jankCount: interval.jankCount,
          severity: interval.severity,
        },
      });
    }
  }

  scenes.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return scenes;
}

// =============================================================================
// Jank Frame Aggregation Helper
// =============================================================================

interface JankInterval {
  startTs: string;
  endTs: string;
  durationMs: number;
  jankCount: number;
  severity: 'severe' | 'mild';
}

/**
 * Aggregates consecutive jank frames into intervals.
 * Adjacent jank frames within 500ms gap are merged into one interval.
 * This creates meaningful analysis targets from scattered jank events.
 */
function aggregateJankFramesToIntervals(rows: Array<Record<string, any>>): JankInterval[] {
  if (!rows.length) return [];

  const MERGE_GAP_NS = 500_000_000n; // 500ms
  const intervals: JankInterval[] = [];

  // Sort by timestamp first
  const sortedRows = [...rows].sort((a, b) => {
    const aTs = toBigInt(a.ts);
    const bTs = toBigInt(b.ts);
    if (aTs === null || bTs === null) return 0;
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  let currentStart = toBigInt(sortedRows[0].ts);
  let currentEnd = currentStart !== null ? currentStart + (toBigInt(sortedRows[0].dur) || 0n) : null;
  let jankCount = 1;
  let severities: string[] = [String(sortedRows[0].jank_severity_type || '')];

  if (currentStart === null || currentEnd === null) {
    return []; // Invalid first row
  }

  for (let i = 1; i < sortedRows.length; i++) {
    const rowTs = toBigInt(sortedRows[i].ts);
    const rowDur = toBigInt(sortedRows[i].dur) || 0n;

    if (rowTs === null) continue;

    if (rowTs - currentEnd! < MERGE_GAP_NS) {
      // Merge into current interval
      const rowEnd = rowTs + rowDur;
      if (rowEnd > currentEnd!) {
        currentEnd = rowEnd;
      }
      jankCount++;
      severities.push(String(sortedRows[i].jank_severity_type || ''));
    } else {
      // Save current interval and start a new one
      intervals.push({
        startTs: currentStart!.toString(),
        endTs: currentEnd!.toString(),
        durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
        jankCount,
        severity: severities.includes('Full') ? 'severe' : 'mild',
      });
      currentStart = rowTs;
      currentEnd = rowTs + rowDur;
      jankCount = 1;
      severities = [String(sortedRows[i].jank_severity_type || '')];
    }
  }

  // Save the last interval
  intervals.push({
    startTs: currentStart!.toString(),
    endTs: currentEnd!.toString(),
    durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
    jankCount,
    severity: severities.includes('Full') ? 'severe' : 'mild',
  });

  return intervals;
}

function mergeDetectedScenes(existing: DetectedScene[], incoming: DetectedScene[]): DetectedScene[] {
  const merged = new Map<string, DetectedScene>();

  for (const s of existing) merged.set(sceneKey(s), s);
  for (const s of incoming) merged.set(sceneKey(s), s);

  const out = Array.from(merged.values());
  out.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return out;
}

function sceneKey(scene: DetectedScene): string {
  return `${scene.type}:${scene.startTs}:${scene.endTs}:${scene.appPackage || ''}`;
}

function buildTrackEventsFromScenes(scenes: DetectedScene[]): TrackEvent[] {
  return scenes.map((scene) => {
    const displayName = sceneDisplayName(scene.type);
    const colorScheme = SCENE_COLOR_SCHEMES[scene.type] || 'system';

    const appName = scene.appPackage ? scene.appPackage.replace('com.', '').replace('android.', '') : '';

    let name = displayName;
    if (appName) name += ` [${appName}]`;
    if (Number.isFinite(scene.durationMs) && scene.durationMs > 0) name += ` ${scene.durationMs}ms`;

    let dur = '0';
    try {
      dur = (BigInt(scene.endTs) - BigInt(scene.startTs)).toString();
    } catch {}

    return {
      ts: scene.startTs,
      dur,
      name,
      category: 'scene',
      colorScheme,
      details: {
        sceneType: scene.type,
        appPackage: scene.appPackage,
        durationMs: scene.durationMs,
        confidence: scene.confidence,
        ...scene.metadata,
      },
    };
  });
}

function fingerprintTrackEvents(events: TrackEvent[]): string {
  return events.map((e) => `${e.ts}:${e.dur}:${e.name}:${e.colorScheme}`).join('|');
}

function payloadToObjectRowsLocal(payload: any): Array<Record<string, any>> {
  if (!payload || typeof payload !== 'object') return [];
  const cols = (payload as any).columns;
  const rows = (payload as any).rows;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];

  const out: Array<Record<string, any>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const obj: Record<string, any> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[String(cols[i])] = row[i];
    }
    out.push(obj);
  }
  return out;
}

function normalizeNs(value: any): string | null {
  const n = toBigInt(value);
  return n === null ? null : n.toString();
}

function toBigInt(value: any): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!/^-?\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function confidenceToScore(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const s = String(value || '').trim();
  if (!s) return 0.85;
  if (s === '高') return 0.9;
  if (s === '中') return 0.7;
  if (s === '低') return 0.5;
  return 0.8;
}

function extractRowAppPackage(row: Record<string, any>, extraFields: string[] = []): string | undefined {
  const candidateFields = ['app_package', 'appPackage', ...extraFields];
  for (const field of candidateFields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const eventApp = extractBracketContent(String(row.event || ''));
  if (eventApp) return eventApp;
  return undefined;
}

function extractBracketContent(text: string): string | null {
  const m = text.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : null;
}

function mapSystemEventToSceneType(eventText: string): SceneCategory | null {
  const e = eventText.trim();
  if (!e) return null;
  // Keep unlock mapping strict; broad substring matching causes false positives.
  if (e === '解锁屏幕' || e.includes('锁屏解锁')) return 'screen_unlock';
  if (e.includes('画中画')) return 'navigation';
  if (e.includes('通知栏') || e.includes('通知')) return 'notification';
  if (e.includes('分屏')) return 'split_screen';
  if (e.includes('Activity')) return 'navigation';
  return null;
}

function mapScreenStateEventToSceneType(eventText: string): SceneCategory | null {
  const e = eventText.trim();
  if (!e) return null;
  if (e.includes('点亮')) return 'screen_on';
  if (e.includes('熄灭')) return 'screen_off';
  if (e.includes('休眠')) return 'screen_sleep';
  return null;
}

type ClientFindingPayload = {
  id: string;
  category?: string;
  severity?: string;
  title?: string;
  description?: string;
  timestampsNs?: any;
  evidence?: any;
  details?: any;
  recommendations?: any;
  confidence?: number;
};

function buildClientFindings(
  findings: AgentRuntimeAnalysisResult['findings'],
  scenes: DetectedScene[],
): ClientFindingPayload[] {
  const base: ClientFindingPayload[] = (findings || []).map((f: any) => ({
    id: String(f?.id || `finding_${Date.now()}`),
    category: f?.category,
    severity: f?.severity,
    title: f?.title,
    description: f?.description,
    timestampsNs: f?.timestampsNs,
    evidence: f?.evidence,
    details: f?.details,
    recommendations: f?.recommendations,
    confidence: f?.confidence,
  }));

  const hasIssueLikeFinding = base.some((f) => {
    const severity = String(f.severity || '').toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'warning') return true;
    return hasIssueSignalText(`${f.title || ''} ${f.description || ''}`);
  });

  const filtered = hasIssueLikeFinding
    ? base.filter((f) => !isNoIssueText(`${f.title || ''} ${f.description || ''}`))
    : base;

  const derived = deriveSceneIssueFindings(scenes);
  const merged = [...filtered, ...derived];

  const dedup = new Map<string, ClientFindingPayload>();
  for (const f of merged) {
    const key = `${String(f.title || '').trim()}::${String(f.description || '').trim()}`;
    if (!key || key === '::') {
      dedup.set(f.id, f);
      continue;
    }
    if (!dedup.has(key)) dedup.set(key, f);
  }

  return Array.from(dedup.values());
}

function buildSessionResultContract(session: AnalysisSession, findings: ClientFindingPayload[]) {
  return buildAssistantResultContract({
    dataEnvelopes: session.dataEnvelopes,
    findings,
  });
}

function deriveSceneIssueFindings(
  scenes: DetectedScene[],
  language: OutputLanguage = configuredOutputLanguage(),
): ClientFindingPayload[] {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  const scrollScenes = scenes.filter((s) => s.type === 'scroll');

  const inertialCandidates = scenes
    .filter((s) => s.type === 'inertial_scroll')
    .map((s) => ({
      scene: s,
      jankFrames: Number((s.metadata as any)?.jankFrames || 0),
    }))
    .filter((item) => item.jankFrames > 0)
    .sort((a, b) => b.jankFrames - a.jankFrames)
    .slice(0, 3);

  const derived: ClientFindingPayload[] = [];
  for (const item of inertialCandidates) {
    const s = item.scene;
    const severity = item.jankFrames >= 100 ? 'critical' : item.jankFrames >= 40 ? 'warning' : 'info';
    const app = s.appPackage || localize(language, '未知', 'unknown');
    const inertialStartNs = toBigInt(s.startTs);
    const inertialEndNs = toBigInt(s.endTs);
    let totalScrollDurationMs = s.durationMs;
    if (inertialStartNs !== null && inertialEndNs !== null) {
      let parentScroll: DetectedScene | null = null;
      let parentStartNs: bigint | null = null;
      for (const scroll of scrollScenes) {
        const startNs = toBigInt(scroll.startTs);
        const endNs = toBigInt(scroll.endTs);
        if (startNs === null || endNs === null) continue;
        if (startNs <= inertialStartNs && endNs >= inertialStartNs) {
          if (!parentScroll || (parentStartNs !== null && startNs > parentStartNs)) {
            parentScroll = scroll;
            parentStartNs = startNs;
          }
        }
      }
      if (parentStartNs !== null && inertialEndNs > parentStartNs) {
        totalScrollDurationMs = Number((inertialEndNs - parentStartNs) / 1_000_000n);
      }
    }

    derived.push({
      id: `scene_inertial_${s.startTs}`,
      category: 'scroll',
      severity,
      title: localize(
        language,
        `惯性滑动卡顿：${item.jankFrames} 帧异常`,
        `Inertial scrolling jank: ${item.jankFrames} anomalous frames`,
      ),
      description: localize(
        language,
        `惯性 ${s.durationMs}ms，总滑动约 ${totalScrollDurationMs}ms，应用 ${app}，建议重点排查滑动后渲染路径`,
        `Inertial phase ${s.durationMs}ms, total scroll about ${totalScrollDurationMs}ms, app ${app}. Prioritize the post-scroll rendering path.`,
      ),
      details: {
        sceneType: s.type,
        startTs: s.startTs,
        endTs: s.endTs,
        durationMs: s.durationMs,
        totalScrollDurationMs,
        jankFrames: item.jankFrames,
        source: 'scene_reconstruction:derived',
      },
      confidence: 0.85,
    });
  }

  return derived;
}

function isNoIssueText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return t.includes('未发现明显性能问题') ||
    t.includes('整体流畅度良好') ||
    t.includes('分析未发现明显问题') ||
    t.includes('no obvious performance issue') ||
    t.includes('no significant performance issue') ||
    t.includes('overall smoothness is good');
}

function hasIssueSignalText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('卡顿') ||
    t.includes('掉帧') ||
    t.includes('缓冲区积压') ||
    t.includes('jank') ||
    t.includes('stutter') ||
    t.includes('deadline missed') ||
    t.includes('renderthread') ||
    t.includes('主线程阻塞')
  );
}

function isSceneReplayOnlyQuery(query: string): boolean {
  const q = String(query || '').toLowerCase();
  const isSceneQuery = q.includes('场景还原') || q.includes('scene reconstruction');
  if (!isSceneQuery) return false;
  // Scene reconstruction in this product is replay-first; quick/replay variants are explicit.
  return q.includes('仅检测') || q.includes('只检测') || q.includes('quick') || q.includes('replay');
}

const SCENE_RESPONSE_THRESHOLDS: Record<string, { good: number; acceptable: number }> = {
  cold_start: { good: 500, acceptable: 1000 },
  warm_start: { good: 300, acceptable: 600 },
  hot_start: { good: 100, acceptable: 200 },
  inertial_scroll: { good: 500, acceptable: 1000 },
  tap: { good: 100, acceptable: 200 },
  navigation: { good: 300, acceptable: 500 },
  app_switch: { good: 500, acceptable: 1000 },
};

function classifySceneResponse(
  scene: DetectedScene,
  language: OutputLanguage = configuredOutputLanguage(),
): string {
  const smooth = localize(language, '流畅', 'smooth');
  const minorVariation = localize(language, '轻微波动', 'minor variation');
  const significantVariation = localize(language, '明显波动', 'significant variation');
  const unknown = localize(language, '未知', 'unknown');
  const metadata = scene.metadata as Record<string, any> | undefined;

  if ((scene.type === 'scroll' || scene.type === 'inertial_scroll') && Number.isFinite(Number(metadata?.averageFps))) {
    const fps = Number(metadata?.averageFps);
    if (fps >= 55) return smooth;
    if (fps >= 45) return minorVariation;
    return significantVariation;
  }

  const thresholds = SCENE_RESPONSE_THRESHOLDS[scene.type];
  if (!thresholds) return unknown;
  if (scene.durationMs <= thresholds.good) return smooth;
  if (scene.durationMs <= thresholds.acceptable) return minorVariation;
  return significantVariation;
}

function formatSceneDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '-';
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

function formatSceneStartTsForNarrative(tsNs: string): string {
  const ns = toBigInt(tsNs);
  if (ns === null) return tsNs;
  const totalMs = Number(ns / 1_000_000n);
  const seconds = totalMs / 1000;
  if (!Number.isFinite(seconds)) return tsNs;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
}

function buildSceneReplayNarrative(
  scenes: DetectedScene[],
  language: OutputLanguage = configuredOutputLanguage(),
): string {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return localize(language, '未检测到可回放的用户操作场景。', 'No replayable user-interaction scenes were detected.');
  }

  const sorted = [...scenes].sort((a, b) => {
    const aTs = toBigInt(a.startTs);
    const bTs = toBigInt(b.startTs);
    if (aTs === null || bTs === null) return 0;
    if (aTs > bTs) return 1;
    if (aTs < bTs) return -1;
    return 0;
  });
  const maxItems = 12;
  const sequenceLines = sorted.slice(0, maxItems).map((scene, idx) => {
    const displayName = sceneDisplayName(scene.type, language);
    const startTs = formatSceneStartTsForNarrative(scene.startTs);
    const duration = formatSceneDurationMs(scene.durationMs);
    const response = classifySceneResponse(scene, language);
    const appText = scene.appPackage
      ? localize(language, `，应用 ${scene.appPackage}`, `, app ${scene.appPackage}`)
      : '';
    return localize(
      language,
      `${idx + 1}. [${startTs}] ${displayName}，持续 ${duration}${appText}，响应状态：${response}`,
      `${idx + 1}. [${startTs}] ${displayName}, duration ${duration}${appText}, response: ${response}`,
    );
  });

  const extraLine = sorted.length > maxItems
    ? localize(
        language,
        `- 其余 ${sorted.length - maxItems} 个场景可在表格中继续查看。`,
        `- ${sorted.length - maxItems} additional scenes are available in the table.`,
      )
    : '';

  return [
    localize(
      language,
      `共还原 ${sorted.length} 个操作场景。以下为操作与设备响应事实回放（不含根因推断）：`,
      `${sorted.length} interaction scenes reconstructed. The following is a factual replay of interactions and device responses, without root-cause inference:`,
    ),
    '',
    ...sequenceLines.map((line) => `- ${line}`),
    extraLine,
  ]
    .filter(Boolean)
    .join('\n');
}

// Delegates to the shared normalizer so CLI's buildReportHtml gets identical
// conclusion text for the same run. The HTTP-specific pieces (scene replay,
// sceneIdHint) stay inline in sendAgentDrivenResult.
function normalizeNarrativeForClient(narrative: string): string {
  return sharedNormalizeNarrative(narrative);
}

function conclusionHasEvidenceIndex(conclusion: string): boolean {
  const text = conclusion || '';
  return /(^|\n)\s*(?:##\s*)?(?:证据(?:表)?索引|evidence\s+index)(?=\s|$|[:：])/i.test(text);
}

function markdownCell(value: unknown, maxLen = 80): string {
  return (
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '/')
      .trim()
      .slice(0, maxLen) || '-'
  );
}

function buildConclusionEvidenceIndex(
  envelopes: DataEnvelope[],
  maxItems = 3,
  language: OutputLanguage = configuredOutputLanguage(),
): string {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return '';

  const seen = new Set<string>();
  const candidates: Array<{ title: string; source: string; evidence: string }> = [];
  for (const env of envelopes) {
    const meta = (env as any)?.meta || {};
    const display = (env as any)?.display || {};
    if (display.level === 'hidden') continue;

    const title = markdownCell(display.title || meta.stepId || meta.source);
    if (title === '-') continue;

    const key = String(meta.evidenceRefId || `${meta.source || ''}:${meta.stepId || ''}:${title}`);
    if (seen.has(key)) continue;
    seen.add(key);

    const source = markdownCell(meta.source || meta.skillId || 'execute_sql');
    const evidence = markdownCell(meta.evidenceRefId || meta.sourceToolCallId || '-', 36);
    candidates.push({ title, source, evidence });
  }

  if (candidates.length === 0) return '';
  const rows = candidates.slice(0, maxItems);
  const omitted = Math.max(0, candidates.length - rows.length);
  const summary = rows.map((item) => localize(
    language,
    `${item.title}（${item.source} / ${item.evidence}）`,
    `${item.title} (${item.source} / ${item.evidence})`,
  )).join(localize(language, '；', '; '));
  return [
    localize(language, '## 证据索引', '## Evidence Index'),
    '',
    localize(
      language,
      `关键数据来源：${summary}${omitted > 0 ? `；其余 ${omitted} 份结构化证据见报告数据详情。` : '。'}`,
      `Key data sources: ${summary}${omitted > 0 ? `; ${omitted} additional structured evidence items are available in report details.` : '.'}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

function appendEvidenceIndexIfMissing(
  conclusion: string,
  envelopes: DataEnvelope[],
  language: OutputLanguage = configuredOutputLanguage(),
): string {
  const normalized = conclusion || '';
  if (conclusionHasEvidenceIndex(normalized)) return normalized;
  const evidenceIndex = buildConclusionEvidenceIndex(envelopes, 3, language);
  if (!evidenceIndex) return normalized;
  return `${normalized.trim()}\n\n${evidenceIndex}`;
}

function augmentConclusionUpdateWithEvidenceIndex(session: AnalysisSession, update: StreamingUpdate): StreamingUpdate {
  if (update.type !== 'conclusion') return update;
  const content = update.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return update;
  const conclusion = (content as Record<string, any>).conclusion;
  if (typeof conclusion !== 'string') return update;
  const augmented = appendEvidenceIndexIfMissing(
    conclusion,
    session.dataEnvelopes || [],
    sessionOutputLanguage(session),
  );
  if (augmented === conclusion) return update;
  return {
    ...update,
    content: {
      ...(content as Record<string, any>),
      conclusion: augmented,
    },
  };
}

function ensureAnalysisQualityArtifacts(
  session: AnalysisSession,
  conclusionContract?: ConclusionContract,
  resultOverride?: AgentRuntimeAnalysisResult,
): {
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
} {
  const result = resultOverride || session.result;
  if (!result) return {};

  if (result.claimSupport && result.claimVerificationResult && result.identityResolutions) {
    session.claimSupport = result.claimSupport;
    session.claimVerificationResult = result.claimVerificationResult;
    session.identityResolutions = result.identityResolutions;
    const context = sessionContextManager.get(session.sessionId, session.traceId);
    context?.annotateLatestCompletedTurn({
      conclusionContract,
      claimSupport: result.claimSupport,
      claimVerificationResult: result.claimVerificationResult,
      identityResolutions: result.identityResolutions,
    });
    return {
      claimSupport: result.claimSupport,
      claimVerificationResult: result.claimVerificationResult,
      identityResolutions: result.identityResolutions,
    };
  }

  const artifacts = runPreparedAnalysisClaimVerification({
    conclusionContract,
    dataEnvelopes: session.dataEnvelopes || [],
    comparisonReportSection: session.comparisonReportSection,
    policy: 'record_only',
  });

  result.claimSupport = artifacts.claimSupport;
  result.claimVerificationResult = artifacts.claimVerificationResult;
  result.identityResolutions = artifacts.identityResolutions;
  const context = sessionContextManager.get(session.sessionId, session.traceId);
  context?.annotateLatestCompletedTurn({
    conclusionContract,
    claimSupport: artifacts.claimSupport,
    claimVerificationResult: artifacts.claimVerificationResult,
    identityResolutions: artifacts.identityResolutions,
  });
  session.claimSupport = artifacts.claimSupport;
  session.claimVerificationResult = artifacts.claimVerificationResult;
  session.identityResolutions = artifacts.identityResolutions;
  return {
    claimSupport: artifacts.claimSupport,
    claimVerificationResult: artifacts.claimVerificationResult,
    identityResolutions: artifacts.identityResolutions,
  };
}

function collectEvidenceRefsFromText(text: string | undefined): Set<string> {
  const refs = new Set<string>();
  const matches = String(text || '').match(/data:[A-Za-z0-9_.:-]+/g) || [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[).,;，。；、]+$/g, '');
    if (cleaned) refs.add(cleaned);
  }
  return refs;
}

function collectEvidenceRefsFromClaimSupport(claimSupport: ClaimSupportV1[] | undefined): Set<string> {
  const refs = new Set<string>();
  for (const claim of claimSupport || []) {
    for (const anchor of claim.anchors || []) {
      if (anchor.evidenceRefId) refs.add(anchor.evidenceRefId);
    }
  }
  return refs;
}

function currentRunEnvelopeCounts(
  session: AnalysisSession,
  runId?: string,
): {
  currentRunDataEnvelopes: number;
  frontendPrequeryInjected: number;
} {
  const run = resolveSessionRun(session, runId);
  const turn = run?.sequence || session.runSequence || session.activeRun?.sequence;
  const envelopes = session.dataEnvelopes || [];
  const current = turn ? envelopes.filter((env) => (env.meta as any)?.turn === turn) : envelopes;
  return {
    currentRunDataEnvelopes: current.length,
    frontendPrequeryInjected: current.filter((env) => env.meta?.source === 'frontend_trace_context').length,
  };
}

function quickRunVerifierStatus(
  result: AgentRuntimeAnalysisResult,
  claimVerificationResult: ClaimVerificationResult | undefined,
): NonNullable<AgentRuntimeAnalysisResult['quickRun']>['verifierStatus'] {
  if (result.partial === true || result.terminationReason === 'max_turns' || result.terminationReason === 'timeout') {
    return 'issues';
  }
  const status = claimVerificationResult?.status;
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'partial') return 'issues';
  return 'not_checked';
}

function finalizeQuickRunReceipt(
  session: AnalysisSession,
  input: {
    result: AgentRuntimeAnalysisResult;
    qualityArtifacts: CompletedAnalysisResultPayload['qualityArtifacts'];
    runId?: string;
  },
): AgentRuntimeAnalysisResult['quickRun'] {
  const receipt = input.result.quickRun;
  if (!receipt) return undefined;
  const textRefs = collectEvidenceRefsFromText(input.result.conclusion);
  const supportRefs = collectEvidenceRefsFromClaimSupport(input.qualityArtifacts.claimSupport);
  const citedRefs = new Set([...textRefs, ...supportRefs]);
  const frontendPrequeryCited = [...citedRefs].filter((ref) => ref.startsWith('data:frontend_prequery:')).length;
  const envelopeCounts = currentRunEnvelopeCounts(session, input.runId);
  const actualTurns = input.result.rounds || receipt.actualTurns;
  const extended = actualTurns > receipt.targetTurns;
  return {
    ...receipt,
    profile: receipt.profile === 'triage' ? 'triage' : extended ? 'extended' : receipt.profile,
    actualTurns,
    elapsedMs: input.result.totalDurationMs || receipt.elapsedMs,
    stopReason:
      input.result.partial === true
        ? receipt.stopReason === 'hard_cap' || receipt.stopReason === 'timeout'
          ? receipt.stopReason
          : 'partial'
        : extended && receipt.stopReason === 'answered'
          ? 'extended_answered'
          : receipt.stopReason,
    evidence: {
      ...receipt.evidence,
      frontendPrequeryInjected: Math.max(
        receipt.evidence.frontendPrequeryInjected,
        envelopeCounts.frontendPrequeryInjected,
      ),
      frontendPrequeryCited,
      currentRunDataEnvelopes: envelopeCounts.currentRunDataEnvelopes,
      citedEvidenceRefs: citedRefs.size,
    },
    verifierStatus: quickRunVerifierStatus(input.result, input.qualityArtifacts.claimVerificationResult),
  };
}

interface RunManifestReceiptReference {
  runManifestId?: string;
  capabilityManifest?: CapabilityManifestAttributionV1;
  existingReceipt?: AnalysisReceipt;
  legacyRecovery?: true;
}

function runManifestReceiptReference(
  manifest: Pick<RunManifestV1, 'runManifestId' | 'capabilityManifest'>,
): RunManifestReceiptReference {
  return {
    runManifestId: manifest.runManifestId,
    capabilityManifest: manifest.capabilityManifest,
  };
}

function resolveRunManifestReceiptReference(
  session: AnalysisSession,
  result: AgentRuntimeAnalysisResult,
  runId?: string,
): RunManifestReceiptReference {
  if (!runId) {
    const receipt = result.analysisReceipt;
    if (receipt) return {existingReceipt: receipt};
    throw new Error('run_manifest_run_id_missing');
  }
  const scope = runManifestScopeFromSession(session);
  const lifecycle = getActiveRunManifestLifecycle(
    scope,
    session.sessionId,
    runId,
  );
  if (lifecycle) {
    sealHttpRunManifest(session, lifecycle);
    const manifest = lifecycle.sealOnceAndPersist();
    const invokedSkills = new Set(manifest.skills.map(skill => skill.skillId));
    const envelopeSkills = new Set(
      session.dataEnvelopes
        .map(envelope => envelope.meta?.skillId)
        .filter((skillId): skillId is string => Boolean(skillId)),
    );
    for (const skillId of envelopeSkills) {
      if (!invokedSkills.has(skillId)) {
        lifecycle.diagnostics.push({
          code: 'data_envelope_skill_without_executor_invocation',
          recordedAt: Date.now(),
          details: {skillId},
        });
      }
    }
    return runManifestReceiptReference(manifest);
  }

  const persistedManifest = getRunManifestStore().getByRunId(scope, runId);
  if (persistedManifest) {
    return runManifestReceiptReference(persistedManifest);
  }

  const receipt = result.analysisReceipt;
  if (!receipt) {
    return {legacyRecovery: true};
  }
  if (receipt.schemaVersion === 1) {
    return {existingReceipt: receipt};
  }
  const receiptManifest = getRunManifestStore().get(
    scope,
    receipt.runManifestId,
  );
  return receiptManifest
    ? runManifestReceiptReference(receiptManifest)
    : {existingReceipt: receipt};
}

function buildAnalysisReceiptForReference(
  reference: RunManifestReceiptReference,
  input: Omit<BuildAnalysisReceiptInput, 'runManifestId'>,
): AnalysisReceipt {
  if (reference.runManifestId) {
    return buildAnalysisReceipt({
      ...input,
      runManifestId: reference.runManifestId,
      capabilityManifest: reference.capabilityManifest,
    });
  }
  if (reference.existingReceipt) return reference.existingReceipt;
  if (reference.legacyRecovery) {
    return buildLegacyAnalysisReceipt(input);
  }
  throw new Error('run_manifest_receipt_reference_missing');
}

interface CompletedAnalysisFinalArtifacts {
  reportId?: string;
  reportUrl?: string;
  reportError?: string;
  resultSnapshotId?: string;
  resultSnapshotEventData?: Record<string, unknown>;
  generatedAt: number;
  receiptReference: RunManifestReceiptReference;
}

interface CompletedAnalysisResultPayload {
  result: AgentRuntimeAnalysisResult;
  replayOnlyScene: boolean;
  normalizedConclusion: string;
  normalizedConclusionContract?: ConclusionContract;
  qualityArtifacts: {
    claimSupport?: ClaimSupportV1[];
    claimVerificationResult?: ClaimVerificationResult;
    identityResolutions?: IdentityResolutionV1[];
  };
  quickRun?: AgentRuntimeAnalysisResult['quickRun'];
  analysisReceipt?: AgentRuntimeAnalysisResult['analysisReceipt'];
  uiActionProposals?: AgentRuntimeAnalysisResult['uiActionProposals'];
  clientFindings: ReturnType<typeof buildClientFindings>;
  resultContract: ReturnType<typeof buildSessionResultContract>;
  finalArtifacts: CompletedAnalysisFinalArtifacts;
}

function ensureCompletedAnalysisFinalArtifacts(
  session: AnalysisSession,
  input: {
    result: AgentRuntimeAnalysisResult;
    hasEvidenceBackedConclusion: boolean;
    normalizedConclusion: string;
    normalizedConclusionContract?: ConclusionContract;
    qualityArtifacts: CompletedAnalysisResultPayload['qualityArtifacts'];
    resultForClient: AgentRuntimeAnalysisResult;
    runId?: string;
  },
): CompletedAnalysisFinalArtifacts {
  const runId = input.runId;
  const artifactCache = ((session as any).completedAnalysisFinalArtifactsByRunId ||= {}) as Record<
    string,
    CompletedAnalysisFinalArtifacts
  >;
  const cached = runId
    ? artifactCache[runId]
    : ((session as any).completedAnalysisFinalArtifacts as CompletedAnalysisFinalArtifacts | undefined);
  if (cached) return cached;

  const result = input.result;
  const receiptReference = resolveRunManifestReceiptReference(
    session,
    result,
    runId,
  );
  const privateKnowledge = sessionUsesPrivateKnowledge(session);
  const outputLanguage = sessionOutputLanguage(session);
  const durableResultForClient = privateKnowledge
    ? projectPrivateAnalysisResult(session.sessionId, input.resultForClient, outputLanguage)
    : input.resultForClient;
  const finalArtifacts: CompletedAnalysisFinalArtifacts = {
    generatedAt: Date.now(),
    receiptReference,
  };
  let reportId: string | undefined;

  if (!input.hasEvidenceBackedConclusion) {
    finalArtifacts.reportError = `analysis did not complete successfully (${result.terminationReason || 'failed'})`;
  } else {
    let reportLease: TraceProcessorLeaseRecord | null = null;
    reportId = `agent-report-${session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (enterpriseLeasesEnabled()) {
        const scope = leaseScopeFromSession(session);
        if (scope) {
          const traceInfo = getTraceProcessorService().getTrace(session.traceId);
          const reportLeaseDecision = buildLeaseModeDecisionForTrace(scope, session.traceId, 'report_generation', {
            traceSizeBytes: traceInfo?.size,
          });
          reportLease = getTraceProcessorLeaseStore().acquireHolder(
            scope,
            session.traceId,
            {
              holderType: 'report_generation',
              holderRef: reportId,
              reportId,
              sessionId: session.sessionId,
              runId,
              metadata: {
                leaseModeReason: reportLeaseDecision.reason,
                leaseModeSignals: reportLeaseDecision.signals,
              },
            },
            { mode: reportLeaseDecision.mode },
          );
          reportLease = markLeaseReadyIfNew(reportLease, scope);
        }
      }

      const generator = getHTMLReportGenerator();
      const reportUrl = `/api/reports/${reportId}`;
      // Report generation needs a receipt before the final snapshot ID exists,
      // so this projection is intentionally report-scoped.
      const reportReceipt = buildAnalysisReceiptForReference(receiptReference, {
        session,
        result: durableResultForClient,
        runId,
        qualityArtifacts: input.qualityArtifacts,
        quickRun: durableResultForClient.quickRun,
        finalArtifacts: {
          reportId,
          reportUrl,
          generatedAt: finalArtifacts.generatedAt,
        },
        providerId: session.providerId ?? null,
      });
      const resultForReport = {
        ...durableResultForClient,
        analysisReceipt: privateKnowledge
          ? projectPrivateAnalysisReceipt(reportReceipt)
          : reportReceipt,
      };
      const reportData = buildAgentDrivenReportData({
        session,
        result: resultForReport,
      });
      console.log(`[AgentRoutes] Generating HTML report, data keys:`, {
        hasResult: !!result,
        conclusionLength: durableResultForClient.conclusion?.length || 0,
        ...(!privateKnowledge
          ? {conclusionPreview: (input.normalizedConclusion || '').substring(0, 100)}
          : {}),
        hasConclusionContract: !!input.normalizedConclusionContract,
        findingsCount: result.findings?.length || 0,
        hypothesesCount: session.hypotheses?.length || 0,
        dialogueCount: session.agentDialogue?.length || 0,
        conversationStepCount: session.conversationSteps?.length || 0,
        dataEnvelopesCount: session.dataEnvelopes?.length || 0,
        agentResponsesCount: session.agentResponses?.length || 0,
        conclusionHistoryCount: session.conclusionHistory?.length || 0,
        hasSnapshot: !!(session as any)._lastSnapshot,
        snapshotNotes: (session as any)._lastSnapshot?.analysisNotes?.length ?? 'n/a',
        snapshotPlan: !!(session as any)._lastSnapshot?.analysisPlan,
        snapshotFlags: (session as any)._lastSnapshot?.uncertaintyFlags?.length ?? 'n/a',
        claimSupportCount: input.qualityArtifacts.claimSupport?.length || 0,
        claimVerifierStatus: input.qualityArtifacts.claimVerificationResult?.status,
      });

      const html = generator.generateAgentDrivenHTML(reportData);
      persistReport(reportId, {
        html,
        generatedAt: Date.now(),
        sessionId: session.sessionId,
        runId,
        traceId: session.traceId,
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        visibility: 'private',
      });

      finalArtifacts.reportId = reportId;
      finalArtifacts.reportUrl = reportUrl;
      console.log(`[AgentRoutes] Generated agent-driven HTML report: ${reportId} (${html.length} bytes)`);
    } catch (error: any) {
      reportId = undefined;
      finalArtifacts.reportError = error.message || 'Unknown error';
      console.error('[AgentRoutes] Failed to generate agent-driven HTML report:', {
        error: finalArtifacts.reportError,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        resultConclusion: result?.conclusion ? `${result.conclusion.length} chars` : 'EMPTY/NULL',
        resultConfidence: result?.confidence,
        resultRounds: result?.rounds,
      });
    } finally {
      if (reportLease) {
        const scope = leaseScopeFromSession(session);
        if (scope) {
          try {
            getTraceProcessorLeaseStore().releaseHolder(
              scope,
              reportLease.id,
              'report_generation',
              finalArtifacts.reportId || reportId || 'report_generation',
            );
          } catch (releaseError: any) {
            console.warn(
              `[AgentRoutes] Failed to release report_generation lease ${reportLease.id}: ${releaseError.message}`,
            );
          }
        }
      }
    }
  }

  if (input.hasEvidenceBackedConclusion) {
    try {
      // Snapshot persistence needs the latest report artifacts, but the
      // snapshot ID is only known after persistCompletedAnalysisResultSnapshot.
      const snapshotReceipt = buildAnalysisReceiptForReference(receiptReference, {
        session,
        result: durableResultForClient,
        runId,
        qualityArtifacts: input.qualityArtifacts,
        quickRun: durableResultForClient.quickRun,
        finalArtifacts,
        providerId: session.providerId ?? null,
      });
      const resultSnapshot = persistCompletedAnalysisResultSnapshot({
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        traceId: session.traceId,
        sessionId: session.sessionId,
        runId,
        reportId: finalArtifacts.reportId,
        sceneType: resolveAnalysisResultSceneType(session.query, session.dataEnvelopes),
        query: privateKnowledge
          ? privateAnalysisQueryMessage(outputLanguage)
          : session.query,
        traceLabel: session.traceId,
        conclusion: privateKnowledge
          ? durableResultForClient.conclusion
          : input.normalizedConclusion,
        conclusionContract: durableResultForClient.conclusionContract,
        claimSupport: durableResultForClient.claimSupport,
        claimVerificationResult: durableResultForClient.claimVerificationResult,
        identityResolutions: durableResultForClient.identityResolutions,
        confidence: result.confidence,
        partial: result.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(result.terminationReason)
          : result.terminationReason,
        terminationMessage: privateKnowledge
          ? projectPrivateTerminationMessage(result.terminationMessage, outputLanguage)
          : result.terminationMessage,
        dataEnvelopes: session.dataEnvelopes,
        analysisReceipt: privateKnowledge
          ? projectPrivateAnalysisReceipt(snapshotReceipt)
          : snapshotReceipt,
        uiActionProposals: durableResultForClient.uiActionProposals,
        privateKnowledge,
        outputLanguage,
      });
      finalArtifacts.resultSnapshotId = resultSnapshot?.id;
      if (resultSnapshot) {
        finalArtifacts.resultSnapshotEventData = {
          snapshotId: resultSnapshot.id,
          status: resultSnapshot.status,
          sceneType: resultSnapshot.sceneType,
          metricCount: resultSnapshot.metrics.length,
          evidenceRefCount: resultSnapshot.evidenceRefs.length,
          traceId: resultSnapshot.traceId,
          sessionId: resultSnapshot.sessionId,
          runId: resultSnapshot.runId,
          reportId: resultSnapshot.reportId,
          visibility: resultSnapshot.visibility,
          createdAt: resultSnapshot.createdAt,
        };
      }
    } catch (snapshotError: any) {
      console.warn('[AgentRoutes] Failed to persist analysis result snapshot:', {
        sessionId: session.sessionId,
        runId,
        error: snapshotError?.message || String(snapshotError),
      });
    }
  }

  if (runId) {
    artifactCache[runId] = finalArtifacts;
  } else {
    (session as any).completedAnalysisFinalArtifacts = finalArtifacts;
  }
  return finalArtifacts;
}

function ensureCompletedAnalysisResultPayload(
  session: AnalysisSession,
  runId?: string,
): CompletedAnalysisResultPayload | undefined {
  const completedRunId = getCompletedResultRunId(session, runId);
  const result = session.result;
  if (!result) return undefined;
  const replayOnlyScene = isSceneReplayOnlyQuery(session.query);
  const hasEvidenceBackedConclusion = result.success || result.partial === true;
  const isSmartResult = result.conclusionContract?.metadata?.sceneId === 'smart';
  const normalizedConclusion = replayOnlyScene
    ? buildSceneReplayNarrative(session.scenes || [])
    : hasEvidenceBackedConclusion
      ? appendEvidenceIndexIfMissing(
          normalizeNarrativeForClient(result.conclusion),
          session.dataEnvelopes || [],
          sessionOutputLanguage(session),
        )
      : normalizeNarrativeForClient(result.conclusion);
  const sceneIdHint = replayOnlyScene
    ? undefined
    : resolveConclusionSceneIdHint({
        sessionId: session.sessionId,
        query: session.query,
        findings: result.findings,
        dataEnvelopes: session.dataEnvelopes,
      });
  const normalizedConclusionContract = replayOnlyScene
    ? undefined
    : isSmartResult
      ? (result.conclusionContract as ConclusionContract)
      : hasEvidenceBackedConclusion
        ? deriveEvidenceBackedConclusionContractForNarrative(result.conclusion, session.dataEnvelopes || [], {
            existingContract: result.conclusionContract as ConclusionContract | undefined,
            mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
            sceneId: sceneIdHint,
          }) || undefined
        : undefined;
  const qualityArtifacts =
    hasEvidenceBackedConclusion && !replayOnlyScene
      ? ensureAnalysisQualityArtifacts(session, normalizedConclusionContract)
      : {};
  let quickRun = finalizeQuickRunReceipt(session, {
    result,
    qualityArtifacts,
    runId: completedRunId,
  });
  if (quickRun) {
    result.quickRun = quickRun;
  }
  if (normalizedConclusionContract) {
    result.conclusionContract = normalizedConclusionContract;
  }
  if (!replayOnlyScene) {
    const readPathQualityIssue = applyFinalResultQualityGate({
      result,
      query: session.query,
      sceneType: sceneIdHint ?? result.conclusionContract?.metadata?.sceneId,
    });
    if (readPathQualityIssue) {
      sessionContextManager.get(session.sessionId, session.traceId)?.annotateLatestCompletedTurn({
        success: result.success,
        findings: result.findings,
        message: result.conclusion,
        confidence: result.confidence,
        partial: result.partial,
        terminationReason: result.terminationReason,
        terminationMessage: result.terminationMessage,
        conclusionContract: result.conclusionContract,
        claimSupport: result.claimSupport,
        claimVerificationResult: result.claimVerificationResult,
        identityResolutions: result.identityResolutions,
      });
      quickRun = finalizeQuickRunReceipt(session, {
        result,
        qualityArtifacts,
        runId: completedRunId,
      });
      if (quickRun) {
        result.quickRun = quickRun;
      }
    }
  }
  let resultForClient: AgentRuntimeAnalysisResult =
    normalizedConclusion === result.conclusion &&
    normalizedConclusionContract === result.conclusionContract &&
    qualityArtifacts.claimSupport === result.claimSupport &&
    qualityArtifacts.claimVerificationResult === result.claimVerificationResult &&
    qualityArtifacts.identityResolutions === result.identityResolutions &&
    quickRun === result.quickRun
      ? result
      : {
          ...result,
          conclusion: normalizedConclusion,
          conclusionContract: normalizedConclusionContract,
          ...qualityArtifacts,
          quickRun,
        };
  const uiActionProposals = replayOnlyScene
    ? []
    : deriveUiActionProposals({
        dataEnvelopes: session.dataEnvelopes || [],
        currentTraceId: session.traceId,
        existingProposals: result.uiActionProposals,
      });
  result.uiActionProposals = uiActionProposals;
  resultForClient = {
    ...resultForClient,
    uiActionProposals,
  };
  const clientFindings = replayOnlyScene ? [] : buildClientFindings(result.findings, session.scenes || []);
  const resultContract = buildSessionResultContract(session, clientFindings);
  const finalArtifacts = ensureCompletedAnalysisFinalArtifacts(session, {
    result,
    hasEvidenceBackedConclusion,
    normalizedConclusion,
    normalizedConclusionContract,
    qualityArtifacts,
    resultForClient: resultForClient as AgentRuntimeAnalysisResult,
    runId: completedRunId,
  });
  const analysisReceipt = buildAnalysisReceiptForReference(
    finalArtifacts.receiptReference,
    {
      session,
      result: resultForClient,
      runId: completedRunId,
      qualityArtifacts,
      quickRun,
      finalArtifacts,
      providerId: session.providerId ?? null,
    },
  );
  result.analysisReceipt = analysisReceipt;
  resultForClient = {
    ...resultForClient,
    analysisReceipt,
  };
  if (completedRunId) {
    getActiveRunManifestLifecycle(
      runManifestScopeFromSession(session),
      session.sessionId,
      completedRunId,
    )?.dispose();
  }
  return {
    result,
    replayOnlyScene,
    normalizedConclusion,
    normalizedConclusionContract,
    qualityArtifacts,
    quickRun,
    analysisReceipt,
    uiActionProposals,
    clientFindings,
    resultContract,
    finalArtifacts,
  };
}

/**
 * Send agent-driven analysis result to SSE client
 */
function analysisCompletedData(
  data: AnalysisCompletedEvent['data'],
): AnalysisCompletedEvent['data'] {
  return data;
}

function ensureCompletedAnalysisSseEvents(session: AnalysisSession, runId?: string): BufferedSseEvent[] {
  const completedRunId = getCompletedResultRunId(session, runId);
  const sseCache = ((session as any).completedAnalysisSseEventsByRunId ||= {}) as Record<
    string,
    {
      qualityGateVersion?: number;
      events: BufferedSseEvent[];
    }
  >;
  const runCache = completedRunId ? sseCache[completedRunId] : undefined;
  const cached = completedRunId
    ? runCache?.events
    : ((session as any).completedAnalysisSseEvents as BufferedSseEvent[] | undefined);
  const cachedVersion = completedRunId
    ? runCache?.qualityGateVersion
    : (session as any).completedAnalysisSseEventsQualityGateVersion;
  if (cached?.length && cachedVersion === COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION) {
    return cached;
  }

  const completedPayload = ensureCompletedAnalysisResultPayload(session, completedRunId);
  if (!completedPayload) {
    const persisted = loadPersistedCompletedAnalysisSseEvents(session, completedRunId);
    if (persisted.length > 0) {
      if (completedRunId) {
        sseCache[completedRunId] = { events: persisted };
      } else {
        (session as any).completedAnalysisSseEvents = persisted;
        delete (session as any).completedAnalysisSseEventsQualityGateVersion;
      }
      return persisted;
    }
    return [];
  }
  const {
    result,
    normalizedConclusion,
    normalizedConclusionContract,
    qualityArtifacts,
    quickRun,
    analysisReceipt,
    uiActionProposals,
    clientFindings,
    resultContract,
    finalArtifacts,
  } = completedPayload;
  const observability = buildStreamObservability(session, completedRunId);
  const privateKnowledge = sessionUsesPrivateKnowledge(session);
  const outputLanguage = sessionOutputLanguage(session);
  const projectedConclusion = privateKnowledge
    ? projectPrivateConclusion({
        sessionId: session.sessionId,
        conclusion: normalizedConclusion,
        success: result.success,
        language: outputLanguage,
      })
    : normalizedConclusion;
  const projectedConclusionContract = privateKnowledge
    ? projectPrivateStructuredValue(session.sessionId, normalizedConclusionContract)
    : normalizedConclusionContract;
  const projectedQualityArtifacts = privateKnowledge
    ? projectPrivateStructuredValue(session.sessionId, qualityArtifacts)
    : qualityArtifacts;
  const projectedUiActionProposals = privateKnowledge
    ? projectPrivateStructuredValue(session.sessionId, uiActionProposals)
    : uiActionProposals;
  const projectedClientFindings = privateKnowledge
    ? projectPrivateStructuredValue(session.sessionId, clientFindings)
    : clientFindings;
  const projectedResultContract = privateKnowledge
    ? projectPrivateStructuredValue(session.sessionId, resultContract)
    : resultContract;
  const projectedHypotheses = projectPrivateStructuredValue(
    session.sessionId,
    result.hypotheses.map((h: AgentRuntimeAnalysisResult['hypotheses'][number]) => ({
      id: h.id,
      description: h.description,
      status: h.status,
      confidence: h.confidence,
      supportingEvidence: h.supportingEvidence,
      contradictingEvidence: h.contradictingEvidence,
    })),
  );
  const events: BufferedSseEvent[] = [];
  const progressEvent =
    latestBufferedProgressEvent(session, completedRunId) ??
    appendAndPersistReplayableSessionEvent(
      session,
      'progress',
      {
        type: 'progress',
        architecture: 'agent-driven',
        ...observability,
        data: {
          phase: 'completed',
          message: localize(
            outputLanguage,
            '分析已完成。',
            'Analysis completed.',
          ),
        },
        timestamp: Date.now(),
      },
      completedRunId,
    );
  events.push(progressEvent);

  if (finalArtifacts.resultSnapshotEventData) {
    events.push(
      appendAndPersistReplayableSessionEvent(
        session,
        'snapshot_created',
        {
          type: 'snapshot_created',
          architecture: 'agent-driven',
          ...observability,
          data: finalArtifacts.resultSnapshotEventData,
          timestamp: Date.now(),
        },
        completedRunId,
      ),
    );
  }

  // Send analysis_completed event with full result. Keep it replayable so a
  // reconnect between conclusion and report generation can recover reportUrl.
  events.push(
    appendAndPersistReplayableSessionEvent(
      session,
      'analysis_completed',
      {
        type: 'analysis_completed',
        architecture: 'agent-driven',
        ...observability,
        data: analysisCompletedData({
          ...(privateKnowledge
            ? {privateProjectionVersion: PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION}
            : {}),
          conclusion: projectedConclusion,
          conclusionContract: projectedConclusionContract,
          claimSupport: projectedQualityArtifacts.claimSupport,
          claimVerificationResult: projectedQualityArtifacts.claimVerificationResult,
          identityResolutions: projectedQualityArtifacts.identityResolutions,
          confidence: result.confidence,
          rounds: result.rounds,
          totalDurationMs: result.totalDurationMs,
          partial: result.partial,
          terminationReason: privateKnowledge
            ? projectPrivateTerminationReason(result.terminationReason)
            : result.terminationReason,
          terminationMessage: privateKnowledge
            ? projectPrivateTerminationMessage(result.terminationMessage, outputLanguage)
            : result.terminationMessage,
          quickRun,
          analysisReceipt: privateKnowledge
            ? projectPrivateAnalysisReceipt(analysisReceipt)
            : analysisReceipt,
          uiActionProposals: projectedUiActionProposals,
          smartScenePreview: privateKnowledge && result.smartScenePreview
            ? projectPrivateStructuredValue(session.sessionId, result.smartScenePreview)
            : result.smartScenePreview,
          findings: projectedClientFindings,
          resultContract: projectedResultContract,
          hypotheses: privateKnowledge
            ? projectedHypotheses
            : result.hypotheses.map((h: AgentRuntimeAnalysisResult['hypotheses'][number]) => ({
                id: h.id,
                description: h.description,
                status: h.status,
                confidence: h.confidence,
                supportingEvidence: h.supportingEvidence,
                contradictingEvidence: h.contradictingEvidence,
              })),
          agentDialogueCount: privateKnowledge ? 0 : session.agentDialogue.length,
          conversationTimelineCount: privateKnowledge ? 0 : session.conversationSteps.length,
          conversationTimeline: privateKnowledge ? [] : session.conversationSteps,
          reportUrl: finalArtifacts.reportUrl,
          reportError: privateKnowledge ? undefined : finalArtifacts.reportError,
          comparisonReportSection: session.comparisonReportSection
            ? (privateKnowledge
                ? projectPrivateStructuredValue(session.sessionId, {
                    source: session.comparisonReportSection.source,
                    title: session.comparisonReportSection.title,
                    markdown: session.comparisonReportSection.markdown,
                    limitations: session.comparisonReportSection.limitations,
                    evidencePack: session.comparisonReportSection.evidencePack,
                  })
                : {
                    source: session.comparisonReportSection.source,
                    title: session.comparisonReportSection.title,
                    markdown: session.comparisonReportSection.markdown,
                    limitations: session.comparisonReportSection.limitations,
                    evidencePack: session.comparisonReportSection.evidencePack,
                  })
            : undefined,
          resultSnapshotId: finalArtifacts.resultSnapshotId,
          observability,
          terminalRunStatus: session.status === 'quota_exceeded' ? 'quota_exceeded' : 'completed',
        }),
        timestamp: Date.now(),
      },
      completedRunId,
    ),
  );

  // Backward-compatible scene reconstruction payload (used by the legacy /scene-reconstruct clients).
  if ((session.scenes?.length || 0) > 0 || (session.trackEvents?.length || 0) > 0) {
    events.push(
      appendAndPersistReplayableSessionEvent(
        session,
        'scene_reconstruction_completed',
        {
          type: 'scene_reconstruction_completed',
          ...observability,
          data: {
            narrative: projectedConclusion,
            confidence: result.confidence,
            executionTimeMs: result.totalDurationMs,
            scenes: (session.scenes || []).map((s) => ({
              type: s.type,
              startTs: s.startTs,
              endTs: s.endTs,
              durationMs: s.durationMs,
              confidence: s.confidence,
              appPackage: s.appPackage,
            })),
            trackEvents: session.trackEvents || [],
            findings: projectedClientFindings.map((f) => ({
              id: f.id,
              category: f.category,
              severity: f.severity,
              title: f.title,
              description: f.description,
              timestampsNs: f.timestampsNs,
            })),
            suggestions: [],
            observability,
          },
          timestamp: Date.now(),
        },
        completedRunId,
      ),
    );
  }

  events.push(
    appendAndPersistReplayableSessionEvent(
      session,
      'end',
      {
        timestamp: Date.now(),
        ...observability,
      },
      completedRunId,
    ),
  );
  if (completedRunId) {
    sseCache[completedRunId] = {
      events,
      qualityGateVersion: COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION,
    };
  } else {
    (session as any).completedAnalysisSseEvents = events;
    (session as any).completedAnalysisSseEventsQualityGateVersion = COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION;
  }
  return events;
}

function sendAgentDrivenResult(res: express.Response, session: AnalysisSession, runId?: string) {
  for (const event of ensureCompletedAnalysisSseEvents(session, runId)) {
    writeBufferedSessionEvent(res, event);
  }
}

registerAgentLogsRoutes(router);

// ============================================================================
// Cleanup
// ============================================================================

// Cleanup old sessions on a configurable cadence.
const sessionCleanupInterval = setInterval(() => {
  cleanupIdleAgentConversationSessions();
  assistantAppService.cleanupIdleSessions({
    terminalMaxIdleMs: TERMINAL_SESSION_MAX_IDLE_MS,
    nonTerminalMaxIdleMs: NON_TERMINAL_SESSION_MAX_IDLE_MS,
    shouldCleanup: (_sessionId, session, context) => {
      if (!resolveFeatureConfig().enterprise || !context.isAbandonedNonTerminal) {
        return true;
      }
      if (isPersistedSessionRunFresh(session, context.now)) {
        session.lastActivityAt = context.now;
        return false;
      }
      return true;
    },
    onCleanup: (sessionId, session) => {
      console.log(`[AgentRoutes] Cleaning up stale session: ${sessionId}`);
      session.sseClients.forEach((client) => {
        try {
          client.end();
        } catch {
          // Ignore closed sockets during cleanup.
        }
      });
      // Clean up session-scoped state only — do NOT call reset() which clears
      // global caches (architectureCache) shared across all active sessions.
      void abortAndCleanupSession(sessionId, session, 'AgentRoutes');
      // Also clean up the EnhancedSessionContext (EntityStore, turns, working memory)
      sessionContextManager.remove(sessionId);
    },
  });

  // Piggyback the Scene Story disk cache cleanup on the same configurable cadence.
  // It's idempotent and self-contained, so a failed sweep here only delays
  // expired-report removal by another 30 minutes — never blocks session
  // cleanup or throws into the interval.
  void sceneReportStore
    .cleanupExpired(Date.now())
    .then((removed) => {
      if (removed > 0) {
        console.log(`[AgentRoutes] SceneReportStore expired ${removed} report(s)`);
      }
    })
    .catch((err) => {
      console.warn('[AgentRoutes] SceneReportStore cleanupExpired failed:', err?.message ?? err);
    });
}, SESSION_CLEANUP_INTERVAL_MS);
sessionCleanupInterval.unref?.();

export const agentRoutesPrivacyProjectionTestSeam = {
  buildTurnSummary,
  buildTurnDetail,
  sanitizePersistedAnalysisCompletedEvent,
  agentEventScopeFromSession,
  persistSessionRunState,
  persistBufferedAgentEvent,
  scrubAuthorizationChangedSession,
  retireAuthorizationChangedSession,
  connectedStreamQuery,
  conclusionHasEvidenceIndex,
  buildConclusionEvidenceIndex,
  appendEvidenceIndexIfMissing,
  privateFeedbackResponse,
};

export const agentRoutesReceiptTestSeam = {
  runManifestReceiptReference,
  buildAnalysisReceiptForReference,
};

export const agentRoutesSmartPreviewSelectionTestSeam = {
  hasSession: (sessionId: string) => Boolean(assistantAppService.getSession(sessionId)),
  deleteSession: (sessionId: string) => assistantAppService.deleteSession(sessionId),
};

export default router;
