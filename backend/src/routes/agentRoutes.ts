// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Agent Analysis Routes
 *
 * API endpoints for Agent-based trace analysis using the agent-driven architecture
 */

import express from 'express';
import {createSceneRunDispatchBinding, sceneRunOwnerKey, type SceneRuntimeSeal} from '../agent/scene/sceneRuntimeBinding';
import {projectSceneTimelineForClient} from '../agent/scene/sceneTimelineProjection';
import {getSceneEvidenceArchive} from '../services/sceneReport/sceneEvidenceArchiveService';
import {resolveCapabilityTraceProcessorIdentity} from '../services/capabilityManifestRuntimeIdentity';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import {SCENE_FINITE_RULE_VERSION} from '../agent/scene/sceneTimelineProposal';
import {appendSceneAwareReplayEvent, includeLatestSceneReplay} from '../assistant/stream/sceneTimelineReplay';
import {dispatchAnalysisRun, SmartPreviewSelectionError,
  type AnalysisRunDispatchDependencies} from '../assistant/application/analysisRunDispatchService';
import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {getTraceProcessorService, type TraceProcessorLeaseQueryContext} from '../services/traceProcessorService';
import {SessionLogger} from '../services/sessionLogger';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../services/agentReportData';
import {
  persistAgentTurn,
  refreshPersistedAgentSnapshot,
} from '../services/persistAgentSession';
import {
  buildAnalysisReceipt,
  buildLegacyAnalysisReceipt,
  type BuildAnalysisReceiptInput,
} from '../services/analysisReceiptBuilder';
import { deriveUiActionProposals } from '../services/uiActionProposalDeriver';
import {
  buildRawTraceComparisonReportSection,
  resolveCapturedComparisonIdentity,
} from '../services/comparisonAppendixService';
import type {FinalResultQualityIssue} from '../services/finalResultQualityGate';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../services/finalizeAnalysisResult';
import {takeFinalizationContext, type RuntimeFinalizationContext} from '../agentRuntime/analysisFinalizationContext';
import {resolveRuntimeTurnPolicy} from '../agentRuntime/runtimeTurnPolicy';
import type {AnalysisCaseRetrievalState} from '../types/analysisDelivery';
import {copyAnalysisDeliveryFields, projectStoredConclusionSourceMetadata} from '../services/security/analysisDeliveryProjection';
import {
  normalizeNarrativeForClient as sharedNormalizeNarrative,
  resolveConclusionOutputModeForTurn,
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
import { finalReviewProgressUpdate } from '../services/finalizationProgress';
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
import {estimateTraceProcessorRssBytes} from '../services/traceProcessorRamBudget';
import { TraceProcessorFactory } from '../services/workingTraceProcessor';
import { registerAgentLogsRoutes } from './agentLogsRoutes';
import { registerAgentQuickSceneRoutes } from './agentQuickSceneRoutes';
import { registerAgentReportRoutes } from './agentReportRoutes';
import { registerAgentExternalIssueRoutes } from './agentExternalIssueRoutes';
import { registerAgentResumeRoutes } from './agentResumeRoutes';
import { registerAgentSessionCatalogRoutes } from './agentSessionCatalogRoutes';
import { registerTeachingRoutes } from './agentTeachingRoutes';
import {AnalyzeOptionsError, type AnalyzeMode} from './agent/normalizeAnalyzeOptions';
import { finalizeAgentDrivenSession } from './agent/finalizeAgentDrivenSession';
import {executeManagedTraceSummaryV1} from '../services/managedTraceSummary';
import {buildTraceSummaryAttributionV1} from '../services/traceSummaryAttribution';
import {unavailableTraceSummaryV1} from '../services/traceSummaryExecutor';
import { AssistantApplicationService } from '../assistant/application/assistantApplicationService';
import { StreamProjector, SSE_RING_BUFFER_SIZE, type BufferedSseEvent } from '../assistant/stream/streamProjector';
import {projectSerializedDataEvent} from '../assistant/stream/dataEnvelopePreview';
import {
  appendReplayableSseEvent,
  hasTerminalReplayAfter,
  isTerminalSseEvent,
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
import {buildAgentQueryWithContinuityNotice, type AnalyzeSessionRunContext} from '../assistant/application/agentAnalyzeSessionService';
import { buildAssistantResultContract } from '../assistant/contracts/assistantResultContract';
import {
  persistCompletedAnalysisResultSnapshot,
  resolveAnalysisResultSceneType,
} from '../services/analysisResultSnapshotPipeline';
// Agent-Driven Architecture v2.0 - Focus tracking
import type { FocusInteraction } from '../agent/context/focusStore';
// DataEnvelope types for v2.0 data contract
import {
  createDataEnvelope,
  validateDataEnvelope,
  generateEventId,
  type AnalysisCompletedEvent,
  type DataEnvelope,
} from '../types/dataContract';
import { buildTraceContextDataEnvelopes, decorateTraceContextDatasets } from '../agentRuntime/traceContextEvidence';
import {recordAdaptiveRoutingPostEvidenceBestEffort} from '../agentRuntime/adaptiveRoutingProjection';
import type { ConclusionContract } from '../agent/core/conclusionContract';
import {sanitizeSourceUseDecision} from '../services/codebase/sourceUseDecision';
import {type AnalysisSourceActivation} from '../services/codebase/analysisSourceActivationPolicy';
import {resetRuntimeForSourceActivation} from '../services/codebase/analysisSourceContextTransition';
import {
  AnalysisSourceSupplementFailure,
  cancelAnalysisSourceSupplement,
  runAnalysisSourceSupplement,
  type AnalysisSourceSupplementMetrics,
} from '../services/codebase/analysisSourceSupplement';
import type { ClaimSupportV1 } from '../types/evidenceContract';
import type { ClaimVerificationResult } from '../types/claimVerification';
import type { IdentityResolutionV1 } from '../types/identityContract';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { composeFragmentSql } from '../services/skillEngine/skillFragments';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import type { ConversationTurn, Finding, Intent } from '../agent/types';
import {
  validateFeedbackInput,
} from '../agentv3/selfImprove/feedbackEnricher';
import {
  deriveTimelineStep,
  sanitizeConversationText,
  summarizeDataEnvelopeForTimeline,
} from '../services/timeline/conversationTimeline';
import {patternExistsForFeedback} from '../agentv3/analysisPatternMemory';
import { backendLogPath } from '../runtimePaths';
import { CaseLibrary } from '../services/caseLibrary';
import { saveCaseCandidates } from '../services/caseEvolution/saveCaseCandidates';
import { openCaseCandidateOutbox } from '../services/caseEvolution/caseCandidateOutbox';
import {caseCandidateKnowledgeScope} from '../services/caseEvolution/caseCandidateBuilder';
import {
  attachCaseHitsToContractSync,
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
import {revokeCodeAwareOutputGuards} from '../services/security/codeAwareOutputRegistry';
import {projectCodeAwareStreamingUpdate, projectOwnerCodeAwareStreamingUpdate} from '../services/security/codeAwareStreamingUpdateProjection';
import {
  privateAnalysisFailureMessage,
  projectOwnerAnalysisError,
  privateAnalysisQueryMessage,
  projectPrivateAnalysisReceipt,
  projectOwnerAnalysisResult,
  copyAnalysisResultForSnapshot,
  projectOwnerFindings,
  projectOwnerConclusion,
  projectOwnerStructuredValue,
  projectOwnerTerminationMessage,
  projectPrivateTerminationReason,
  sessionUsesPrivateKnowledge,
} from '../services/security/privateAnalysisProjection';
import {
  AnalysisContextAuthorizationChangedError,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
  type AnalysisContextSelection,
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
import {createRunManifestLifecycle, disposeRunManifestLifecyclesForSession, getActiveRunManifestLifecycle, type RunManifestLifecycle} from '../services/selfEvolution/runManifestLifecycle';
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
  if (session.cancellationInFlightRunId || session.sceneExecutionInFlightRunId) return undefined;
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
    sourceDerived: session.sourceActivation === 'bounded_explicit' ? true : undefined,
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

interface HttpFinalizationRun {
  owner: AnalysisFinalizationOwner;
  controller: AbortController;
  assertCurrent(): void;
  release(): void;
}

const httpFinalizationRuns = new WeakMap<AnalysisSession, Map<string, HttpFinalizationRun>>();
// Root lease ownership outlives smart -> deep-dive finalization controller handoffs.
const httpAnalysisRunLeaseControllers = new WeakMap<AnalysisSession, Map<string, AbortController>>();
// Local durable parents require verified Trace backing from actual HTTP admission.
// A restored session or a prior run cannot grant this readiness to another run.
const admittedLocalAnalysisRuns = new WeakMap<AnalysisSession, Set<string>>();

function abortHttpFinalizationRuns(session: AnalysisSession, runId?: string): void {
  for (const [id, controller] of httpAnalysisRunLeaseControllers.get(session) ?? []) {
    if (!runId || id === runId) controller.abort(new DOMException('Analysis cancelled', 'AbortError'));
  }
  for (const [id, run] of httpFinalizationRuns.get(session) ?? []) {
    if (!runId || id === runId) run.controller.abort(new DOMException('Analysis cancelled', 'AbortError'));
  }
}

function createHttpFinalizationRun(
  session: AnalysisSession,
  runId: string,
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  fingerprint: string,
  dispatchedFingerprint?: string,
): HttpFinalizationRun {
  const controller = new AbortController();
  const runs = httpFinalizationRuns.get(session) ?? new Map<string, HttpFinalizationRun>();
  httpFinalizationRuns.set(session, runs);
  runs.get(runId)?.controller.abort(new DOMException('Analysis superseded', 'AbortError'));
  const owner: AnalysisFinalizationOwner = {
    runId, signal: controller.signal,
    ...(dispatchedFingerprint !== undefined ? {analysisContextFingerprint: dispatchedFingerprint} : {}),
    isCurrent: () => assistantAppService.getSession(session.sessionId) === session &&
      !httpAnalysisRunLeaseControllers.get(session)?.get(runId)?.signal.aborted &&
      isCurrentRunOwner(session, runId) && !isSessionRunCancelled(session, runId),
    assertAuthorized: () => assertCurrentAnalysisContextAuthorization(selection, scope, fingerprint),
  };
  const run: HttpFinalizationRun = {
    owner, controller,
    assertCurrent: () => {
      controller.signal.throwIfAborted();
      if (!owner.isCurrent()) throw new DOMException('Analysis superseded', 'AbortError');
      owner.assertAuthorized();
    },
    release: () => {if (runs.get(runId) === run) runs.delete(runId);},
  };
  runs.set(runId, run);
  return run;
}

async function awaitHttpFinalizationOperation<T>(
  operation: Promise<T>, run: HttpFinalizationRun, deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = run.controller.signal;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) onAbort();
    timer = setTimeout(() => reject(new DOMException('Finalization deadline exceeded', 'TimeoutError')),
      Math.max(0, Math.min(deadlineMs - Date.now(), 2_147_483_647)));
  });
  try {
    const value = await Promise.race([operation, interrupted]);
    run.assertCurrent();
    if (Date.now() >= deadlineMs) throw new DOMException('Finalization deadline exceeded', 'TimeoutError');
    return value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function markSessionRunCancelled(session: AnalysisSession, runId: string, reason: string): void {
  abortHttpFinalizationRuns(session, runId);
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
  if (session.activeRun?.runId !== run.runId) abortHttpFinalizationRuns(session);
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

async function resetSessionRuntimeForSourceActivation(
  session: AnalysisSession,
  query: string,
  nextActivation: AnalysisSourceActivation,
): Promise<void> {
  const previousActivation = session.sourceActivation;
  const resetQuery = await resetRuntimeForSourceActivation({
    orchestrator: session.orchestrator,
    sessionId: session.sessionId,
    query,
    previousActivation,
    nextActivation,
    queryHistory: session.queryHistory,
    conclusionHistory: session.conclusionHistory,
  });
  if (!resetQuery) return;
  session.agentQuery = resetQuery;
  session.logger.info('AgentRoutes', 'Reset provider runtime after source activation changed', {
    sessionId: session.sessionId,
    previousActivation,
    nextActivation,
  });
}

async function abortAndCleanupSession(sessionId: string, session: AnalysisSession, component: string): Promise<void> {
  abortHttpFinalizationRuns(session);
  await cancelActiveAnalysisSourceEnrichment(session, 'session_cancelled');
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
  abortHttpFinalizationRuns(session);
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
  outcome:
    | 'cancelled'
    | 'source_enrichment_cancelled'
    | 'already_cancelled'
    | 'run_not_found'
    | 'run_not_active'
    | 'run_not_cancellable';
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
  if (
    session.analysisSourceEnrichment?.status === 'running' &&
    session.analysisSourceEnrichment.runId === runId
  ) {
    await cancelActiveAnalysisSourceEnrichment(session, reason);
    session.lastActivityAt = Date.now();
    return {
      session,
      runId,
      runStatus: targetRun.status,
      outcome: 'source_enrichment_cancelled',
      reason,
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

function projectCancelSessionRunResult(result: CancelSessionRunResult): {status: number; body: Record<string, unknown>} {
  const { session, runId, runStatus, outcome, reason } = result;
  switch (outcome) {
    case 'source_enrichment_cancelled':
      return {status: 200, body: {
        success: true,
        sessionId: session.sessionId,
        runId,
        status: 'source_enrichment_cancelled',
        primaryRunStatus: runStatus,
        sessionStatus: session.status,
        outcome,
        reason,
      }};
    case 'cancelled':
    case 'already_cancelled':
      return {status: 200, body: {
        success: true,
        sessionId: session.sessionId,
        runId,
        status: 'cancelled',
        sessionStatus: session.status,
        outcome,
        reason,
      }};
    case 'run_not_found':
      return {status: 404, body: {
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_FOUND',
        error: 'Run not found in session',
      }};
    case 'run_not_active':
      return {status: 409, body: {
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_ACTIVE',
        error: 'Run no longer owns the active session analysis',
        status: runStatus,
        activeRunId: session.activeRun?.runId,
        sessionStatus: session.status,
      }};
    case 'run_not_cancellable':
      return {status: 409, body: {
        success: false,
        sessionId: session.sessionId,
        runId,
        code: 'RUN_NOT_CANCELLABLE',
        error: 'Run is already terminal',
        status: runStatus,
        sessionStatus: session.status,
      }};
  }
}

function sendCancelSessionRunResult(res: express.Response, result: CancelSessionRunResult): express.Response {
  const response = projectCancelSessionRunResult(result);
  return res.status(response.status).json(response.body);
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
  sceneTimelineReplay?: BufferedSseEvent;
  sceneExecutionInFlightRunId?: string;
  sceneReconstructionRunId?: string;
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
  sourceAuthorization?: {
    codeAwareMode: Exclude<import('../services/codebase/codeAwareFeature').CodeAwareMode, 'off'>;
    codebaseIds: string[];
    analysisContextFingerprint: string;
  };
  sourceActivation?: AnalysisSourceActivation;
  analysisSourceEnrichment?: {
    runId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    completedAt?: number;
    message?: string;
    metrics?: AnalysisSourceSupplementMetrics;
    errorCode?: 'analysis_source_enrichment_failed';
    finalResult?: AgentRuntimeAnalysisResult;
  };
  androidInternalsPackPin?: import('../services/androidInternalsPack/types').AndroidInternalsPackIdentity;
  /** Reference trace ID for comparison mode (dual-trace analysis) */
  referenceTraceId?: string;
  comparisonSource?: 'raw_trace_pair' | 'analysis_result_snapshots';
  comparisonReportSection?: import('../agentv3/sessionStateSnapshot').ComparisonReportSection;
  traceSummary?: import('../types/traceSummaryAttribution').TraceSummaryAttributionV1;
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
  queryHistory: Array<{
    turn: number;
    query: string;
    timestamp: number;
    sourceDerived?: boolean;
  }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory: Array<{
    turn: number;
    conclusion: string;
    confidence: number;
    timestamp: number;
    sourceDerived?: boolean;
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
  if (session.result) {
    recordAdaptiveRoutingPostEvidenceBestEffort({
      builder: lifecycle.builder,
      result: session.result,
      dataEnvelopes: session.dataEnvelopes,
      onDiagnostic: code => lifecycle.diagnostics.push({
        code,
        recordedAt: Date.now(),
      }),
    });
  }
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
  const scope = baseAgentEventScopeFromSession(session, runId);
  return scope && (resolveFeatureConfig().enterprise || admittedLocalAnalysisRuns.get(session)?.has(scope.runId))
    ? scope
    : null;
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
      ? projectOwnerAnalysisError(session.sessionId, error, sessionOutputLanguage(session))
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
        data: projectOwnerAnalysisResult(session.sessionId, {
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
  const {
    conclusionContract,
    sourceProjectionApplied,
  } = projectAnalysisCompletedConclusionContract(
    data?.conclusionContract,
    data?.sourceUseDecision,
  );

  const result: AgentRuntimeAnalysisResult = {
    sessionId: session.sessionId,
    sceneTimeline: data?.sceneTimeline?.schemaVersion === 'scene_timeline@1' &&
      data.sceneTimeline.sessionId === session.sessionId && data.sceneTimeline.traceId === session.traceId &&
      data.sceneTimeline.runId === (payload?.runId ?? data?.observability?.runId) &&
      Array.isArray(data.sceneTimeline.segments) ? data.sceneTimeline : undefined,
    sceneReport: data?.sceneReport?.schemaVersion === 'scene_report_ref@1' &&
      data.sceneReport.sessionId === session.sessionId && data.sceneReport.traceId === session.traceId &&
      data.sceneReport.runId === (payload?.runId ?? data?.observability?.runId) ? data.sceneReport : undefined,
    success: data?.success === true,
    findings: Array.isArray(data?.findings) ? data.findings : [],
    hypotheses: Array.isArray(data?.hypotheses) ? data.hypotheses : [],
    conclusion,
    confidence: typeof data?.confidence === 'number' ? data.confidence : 0.5,
    rounds: typeof data?.rounds === 'number' ? data.rounds : 1,
    totalDurationMs: typeof data?.totalDurationMs === 'number' ? data.totalDurationMs : 0,
    partial: data?.partial === true ? true : undefined,
    terminationReason: data?.terminationReason,
    terminationMessage: data?.terminationMessage,
    conclusionContract,
    sourceUseDecision: sanitizeSourceUseDecision(data?.sourceUseDecision),
    sourceClaimVerificationResult: data?.sourceClaimVerificationResult,
    ...copyAnalysisDeliveryFields(data ?? {}),
    claimSupport: data?.claimSupport,
    claimVerificationResult: data?.claimVerificationResult,
    identityResolutions: data?.identityResolutions,
    quickRun: data?.quickRun,
    analysisReceipt: data?.analysisReceipt,
    uiActionProposals: data?.uiActionProposals,
  };

  if (!privateKnowledge && !sourceProjectionApplied) return event;
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
        sourceClaimVerificationResult: undefined,
        sourceUseDecision: undefined,
        turnIntent: undefined, completion: undefined, outputOrigin: undefined, runtimeAppendix: undefined,
        reportAssessment: undefined, investigationAssessment: undefined, deliveryAssurance: undefined,
        identityResolutions: undefined,
        sceneTimeline: undefined, sceneReport: undefined,
        uiActionProposals: [],
      }
    : result;
  const durableResult = privateKnowledge
    ? projectOwnerAnalysisResult(session.sessionId, resultForProjection, outputLanguage)
    : resultForProjection;

  const nextData = privateKnowledge
    ? {
        privateProjectionVersion: PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION,
        ...copyAnalysisDeliveryFields(durableResult),
        sceneTimeline: durableResult.sceneTimeline ? projectSceneTimelineForClient(durableResult.sceneTimeline) : undefined,
        sceneReport: durableResult.sceneReport,
        sourceUseDecision: durableResult.sourceUseDecision,
        sourceClaimVerificationResult: durableResult.sourceClaimVerificationResult,
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
          ? projectOwnerStructuredValue(session.sessionId, data.smartScenePreview)
          : undefined,
        conversationTimeline: [],
        agentDialogueCount: 0,
        conversationTimelineCount: 0,
        comparisonReportSection: trustedPrivateProjection && data.comparisonReportSection
          ? projectOwnerStructuredValue(session.sessionId, data.comparisonReportSection)
          : undefined,
        resultContract: trustedPrivateProjection && data.resultContract
          ? projectOwnerStructuredValue(session.sessionId, data.resultContract)
          : undefined,
        analysisReceipt: projectPrivateAnalysisReceipt(durableResult.analysisReceipt),
        confidence: durableResult.confidence,
        rounds: durableResult.rounds,
        totalDurationMs: durableResult.totalDurationMs,
        partial: durableResult.partial,
        terminationReason: durableResult.terminationReason,
        terminationMessage: durableResult.terminationMessage,
        quickRun: durableResult.quickRun
          ? projectOwnerStructuredValue(session.sessionId, durableResult.quickRun)
          : undefined,
        reportUrl: typeof data?.reportUrl === 'string' &&
            /^\/api\/reports\/[A-Za-z0-9._~-]+$/.test(data.reportUrl)
          ? data.reportUrl
          : undefined,
        resultSnapshotId: typeof data?.resultSnapshotId === 'string'
          ? data.resultSnapshotId.slice(0, 160)
          : undefined,
        terminalRunStatus: ['completed', 'failed', 'cancelled', 'quota_exceeded'].includes(data?.terminalRunStatus)
          ? data.terminalRunStatus
          : undefined,
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
        conclusionContract: durableResult.conclusionContract,
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
      res.write(`data: ${projectSerializedDataEvent(replayEvent.eventType, replayEvent.eventData)}\n\n`);
      replayed++;
      lastCursor = event.cursor;
      if (isTerminalSseEvent(replayEvent.eventType, replayEvent.eventData)) {
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

function appendAnalysisSourceEventToCompletedCache(
  session: AnalysisSession,
  runId: string,
  event: BufferedSseEvent,
): void {
  const runCache = (session as any).completedAnalysisSseEventsByRunId?.[runId] as
    | {events?: BufferedSseEvent[]}
    | undefined;
  if (runCache?.events && !runCache.events.includes(event)) runCache.events.push(event);
  const sessionCache = (session as any).completedAnalysisSseEvents as BufferedSseEvent[] | undefined;
  if (sessionCache && !sessionCache.includes(event)) sessionCache.push(event);
}

function publishAnalysisSourceEvent(
  session: AnalysisSession,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
): BufferedSseEvent {
  const event = appendAndPersistReplayableSessionEvent(
    session,
    eventType,
    {
      type: eventType,
      architecture: 'agent-driven',
      ...buildStreamObservability(session, runId),
      ...payload,
      timestamp: Date.now(),
    },
    runId,
  );
  appendAnalysisSourceEventToCompletedCache(session, runId, event);
  for (const client of filterSseClientsForRun(session.sseClients, runId)) {
    try {
      writeBufferedSessionEvent(client, event);
    } catch {
      assistantAppService.removeSseClient(session.sessionId, client);
    }
  }
  return event;
}

function finishAnalysisSourceEventStream(session: AnalysisSession, runId: string): void {
  publishAnalysisSourceEvent(session, runId, 'end', {});
}

async function cancelActiveAnalysisSourceEnrichment(
  session: AnalysisSession,
  reason: string,
): Promise<boolean> {
  const state = session.analysisSourceEnrichment;
  if (!state || state.status !== 'running') return false;
  abortHttpFinalizationRuns(session, state.runId);
  state.status = 'cancelled';
  state.completedAt = Date.now();
  await cancelAnalysisSourceSupplement(
    session.orchestrator,
    session.sessionId,
    state.runId,
  );
  if (assistantAppService.getSession(session.sessionId) !== session ||
    session.analysisSourceEnrichment !== state || !isCurrentRunOwner(session, state.runId)) return true;
  publishAnalysisSourceEvent(session, state.runId, 'analysis_source_enrichment_cancelled', {
    reason,
  });
  finishAnalysisSourceEventStream(session, state.runId);
  return true;
}

function startAnalysisSourceEnrichment(
  session: AnalysisSession,
  input: {
    runId: string;
    traceId: string;
    question: string;
    primaryConclusion: string;
    analysisOptions: AnalysisOptions;
    finalizationRun: HttpFinalizationRun;
  },
): void {
  const state = session.analysisSourceEnrichment;
  const run = input.finalizationRun;
  const isCurrent = () => session.analysisSourceEnrichment === state && state?.status === 'running' &&
    !run.controller.signal.aborted && run.owner.isCurrent();
  if (!state || state.runId !== input.runId || !isCurrent()) {run.release(); return;}
  run.assertCurrent();
  publishAnalysisSourceEvent(session, input.runId, 'analysis_source_enrichment_started', {});
  run.assertCurrent();
  void runAnalysisSourceSupplement({
    orchestrator: session.orchestrator,
    sessionId: session.sessionId,
    runId: input.runId,
    traceId: input.traceId,
    question: input.question,
    primaryConclusion: input.primaryConclusion,
    analysisOptions: input.analysisOptions,
    signal: run.controller.signal,
    isCurrent,
    assertAuthorized: run.owner.assertAuthorized,
  }).then(outcome => {
    if (!isCurrent()) return;
    run.assertCurrent();
    state.status = 'completed';
    state.completedAt = Date.now();
    state.message = outcome.message;
    state.metrics = outcome.metrics;
    state.finalResult = outcome.finalResult;
    publishAnalysisSourceEvent(session, input.runId, 'analysis_source_enrichment_completed', {
      message: outcome.message, metrics: outcome.metrics, finalResult: outcome.finalResult,
    });
    run.assertCurrent();
    finishAnalysisSourceEventStream(session, input.runId);
  }).catch(error => {
    if (!isCurrent()) return;
    try {run.assertCurrent();} catch {return;}
    state.status = 'failed';
    state.completedAt = Date.now();
    state.errorCode = 'analysis_source_enrichment_failed';
    if (error instanceof AnalysisSourceSupplementFailure) {
      state.finalResult = error.finalResult;
      state.metrics = error.metrics;
    }
    publishAnalysisSourceEvent(session, input.runId, 'analysis_source_enrichment_failed', {
      errorCode: state.errorCode, finalResult: state.finalResult, metrics: state.metrics,
    });
    run.assertCurrent();
    finishAnalysisSourceEventStream(session, input.runId);
  }).finally(() => run.release()).catch(() => undefined);
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
        event.eventType === 'analysis_source_enrichment_started' ||
        event.eventType === 'analysis_source_enrichment_completed' ||
        event.eventType === 'analysis_source_enrichment_failed' ||
        event.eventType === 'analysis_source_enrichment_cancelled' ||
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

function requestedSessionIsVisible(sessionId: string, context: RequestContext): boolean {
  const activeSession = assistantAppService.getSession(sessionId);
  if (activeSession) {
    return isOwnedByContext(activeSession, context);
  }

  const persistedSession = SessionPersistenceService.getInstance().getSession(sessionId);
  return !persistedSession || isOwnedByContext(persistedSession.metadata, context);
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
  return turn.result;
}

function buildTurnSummary(
  turn: ConversationTurn,
  privateSessionId?: string,
  outputLanguage: OutputLanguage = configuredOutputLanguage(),
) {
  const displayResult = buildDisplayTurnResult(turn);
  const projectedMessage = privateSessionId && displayResult
    ? projectOwnerConclusion({
        sessionId: privateSessionId,
        conclusion: displayResult.message,
        success: displayResult.success !== false,
        language: outputLanguage,
        state: displayResult,
      })
    : displayResult?.message;
  const confidence = typeof displayResult?.confidence === 'number' ? displayResult.confidence : undefined;
  const sanitizedConclusion =
    typeof projectedMessage === 'string' ? projectedMessage : '';
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
      ? projectOwnerTerminationMessage(displayResult?.terminationMessage, outputLanguage, displayResult, privateSessionId)
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
          ? projectOwnerAnalysisResult(privateSessionId, {
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
              sourceClaimVerificationResult: displayResult.sourceClaimVerificationResult,
              sourceUseDecision: displayResult.sourceUseDecision,
              ...copyAnalysisDeliveryFields(displayResult),
              identityResolutions: displayResult.identityResolutions,
            }, outputLanguage)
          : displayResult)
      : null,
    findings: toJsonSafe(privateSessionId
      ? projectOwnerFindings(privateSessionId, turn.findings || [])
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

  const conclusion = typeof turn.result.message === 'string' ? turn.result.message : '';
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
    sourceClaimVerificationResult: turn.result.sourceClaimVerificationResult,
    sourceUseDecision: turn.result.sourceUseDecision,
    ...copyAnalysisDeliveryFields(turn.result),
    identityResolutions: turn.result.identityResolutions,
  };
}

function recoverResultForSessionIfNeeded(
  sessionId: string,
  session: AnalysisSession,
): AgentRuntimeAnalysisResult | null {
  const runId = getCompletedResultRunId(session);
  const belongsToRun = (result: AgentRuntimeAnalysisResult): boolean => result.sessionId === sessionId &&
    (!runId || [result.completion?.runId, result.analysisReceipt?.runId]
      .every(storedRunId => !storedRunId || storedRunId === runId));
  if (session.result) return belongsToRun(session.result) ? session.result : null;
  const snapshot = SessionPersistenceService.getInstance().loadSessionStateSnapshot(sessionId);
  const snapshotRunId = snapshot?.lastRun?.runId ?? snapshot?.activeRun?.runId;
  if (snapshot?.finalResult && runId && snapshotRunId === runId && belongsToRun(snapshot.finalResult)) {
    return snapshot.finalResult;
  }
  const resolved = resolveSessionContextForReview(sessionId);
  const recovered = resolved ? buildRecoveredResultFromContext(sessionId, resolved.context) : null;
  return recovered && belongsToRun(recovered) ? recovered : null;
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
  currentTurn?: number;
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

  const sceneEnvelopes = params.currentTurn === undefined
    ? params.dataEnvelopes || []
    : (params.dataEnvelopes || []).filter(envelope => {
        const envelopeTurn = Number((envelope.meta as any)?.turn);
        if (Number.isFinite(envelopeTurn)) return envelopeTurn === params.currentTurn;
        return params.currentTurn === 1;
      });
  const evidenceAspects = deriveConclusionSceneAspectsFromSkillIds(
    sceneEnvelopes.map(envelope => envelope.meta?.skillId),
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

function conclusionContractDeriveOptionsForSession(
  session: AnalysisSession,
  result: AgentRuntimeAnalysisResult,
  sceneId: string | undefined,
  requestedAnalysisMode?: AnalyzeMode,
): {
  existingContract?: ConclusionContract;
  mode: ConclusionContract['mode'];
  sceneId?: string;
} {
  const mode = resolveConclusionOutputModeForTurn({
    existingMode: result.conclusionContract?.mode,
    runSequence: session.runSequence,
    requestedAnalysisMode,
  });
  return {
    existingContract: result.conclusionContract
      ? {...result.conclusionContract, mode} as ConclusionContract
      : undefined,
    mode,
    ...(sceneId ? {sceneId} : {}),
  };
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
function analysisRunDispatchDependencies(): AnalysisRunDispatchDependencies<AnalysisSession> {
  return {
    configuredOutputLanguage, sessionOutputLanguage, enterpriseLeasesEnabled,
    leaseScopeFromRequestContext, buildLeaseModeDecisionForTrace, startSessionRun,
    markSessionRunStatus, isSessionRunCancelled, abortHttpFinalizationRuns,
    isStaleRun, settleSessionRunExecution, resetSessionRuntimeForSourceActivation,
    createHttpRunManifestLifecycle, sealCompletedHttpRunManifest, finalizeHttpRunManifestLifecycle,
    persistSessionRunState, cancelActiveAnalysisSourceEnrichment, assignSessionOwner,
    requestedSessionIsVisible, resolveVisibleSessionReferenceTraceIdForTrace, buildRecoveredResultFromContext,
    ensureToolsRegistered, isDedicatedSceneReplayRequest, runSmartAnalysis,
    smartSelectionReportId, analyzeOptionsErrorMessage, smartPreviewSelectionErrorMessage,
    resolveSmartPreviewReportForSelection, runAgentDrivenAnalysis, broadcastToAgentDrivenClients,
    assistantAppService, httpAnalysisRunLeaseControllers, admittedLocalAnalysisRuns,
    blockedSceneStrategyIds: SCENE_STRATEGY_IDS,
    sceneRunHooks: {onAdmitted: ({session, run, traceId, signal, assertCurrent}) => {
      session.sceneReconstructionRunId = run.runId;
      const binding = createSceneRunDispatchBinding({scope: {runId: run.runId, sessionId: session.sessionId, traceId,
        ownerKey: sceneRunOwnerKey(session)}, signal, assertCurrent});
      return {bindOptions: binding.bindOptions, seal: binding.seal, release: async () => {
        // Runtime maps must drop the exact run's facade while it is still live.
        // Cleanup precedes settlement, so a following run cannot own this session yet.
        try {await Promise.resolve(session.orchestrator.cleanupSession?.(session.sessionId));}
        finally {binding.release();}
      }};
    }},
  };
}

async function handleAnalyzeRequest(
  req: express.Request,
  res: express.Response,
  requestedSessionIdOverride?: string,
): Promise<void> {
  const response = await dispatchAnalysisRun({entry: 'analysis', requestId: getRequestId(req),
    context: requireRequestContext(req), body: req.body ?? {}, requestedSessionIdOverride},
    analysisRunDispatchDependencies());
  res.status(response.status).json(response.body);
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
  const source = includeLatestSceneReplay(session.sseEventBuffer, session.sceneTimelineReplay, targetRunId);
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

  const sourceEnrichmentRunning = session.analysisSourceEnrichment?.status === 'running';
  if (
    lastEventId !== null &&
    !sourceEnrichmentRunning &&
    (streamStatus === 'completed' || streamStatus === 'quota_exceeded')
  ) {
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
      if (!sourceEnrichmentRunning) {
        res.end();
        assistantAppService.removeSseClient(sessionId, res);
        return;
      }
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
    if (session.sseClients.length === 0 && session.analysisSourceEnrichment?.status === 'running') {
      void cancelActiveAnalysisSourceEnrichment(session, 'client_disconnected');
    }
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

async function ensureSceneHistoryAccessible(req: express.Request, res: express.Response, session: AnalysisSession): Promise<boolean> {
  if (!session.sceneReconstructionRunId && !session.result?.sceneTimeline && !session.sceneTimelineReplay &&
      session.result?.turnIntent?.sceneId !== 'scene_reconstruction' && !isDedicatedSceneReplayRequest(session.query)) return true;
  if (!await readTraceMetadataForContext(session.traceId, requireRequestContext(req))) {
    sendResourceNotFound(res, 'Scene trace is no longer accessible'); return false;
  }
  const reference = session.result?.sceneReport;
  if (reference && (reference.expiresAt <= Date.now() || !await sceneStoryService.getFinalizedReport(sceneRunOwnerKey(session), reference.reportId))) {
    sendResourceNotFound(res, 'Scene report not found or expired'); return false;
  }
  return true;
}
async function handleAuthorizedSessionStream(req: express.Request, res: express.Response, sessionId: string,
  options: {runId?: string} = {}): Promise<void> {
  const session = getAuthorizedSession(req, res, sessionId);
  if (!session || !await ensureSceneHistoryAccessible(req, res, session)) return;
  handleSessionStream(req, res, sessionId, options);
}
router.get('/:sessionId/stream', async (req, res) => {
  await handleAuthorizedSessionStream(req, res, req.params.sessionId);
});

router.get('/runs/:runId/stream', async (req, res) => {
  const session = getAuthorizedSessionByRunId(req, res, req.params.runId);
  if (!session) return;
  await handleAuthorizedSessionStream(req, res, session.sessionId, {runId: req.params.runId});
});

/**
 * GET /api/agent/v1/:sessionId/status
 *
 * Get analysis status (for polling)
 */
router.get('/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;

  const session = getAuthorizedSession(req, res, sessionId);
  if (!session || !await ensureSceneHistoryAccessible(req, res, session)) return;

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

  if (session.status === 'completed' || session.status === 'quota_exceeded' || (session.status === 'failed' && session.result)) {
    const recoveredResult = recoverResultForSessionIfNeeded(sessionId, session);
    if (recoveredResult) {
      const completedPayload = ensureCompletedAnalysisResultPayload(session);
      const result = completedPayload?.result ?? projectStoredHttpResult(session, recoveredResult);
      const finalArtifacts = completedPayload?.finalArtifacts;
      const privateKnowledge = sessionUsesPrivateKnowledge(session);
      const outputLanguage = sessionOutputLanguage(session);
      const normalizedCompletedConclusion = result.conclusion;
      const projectedCompletedContract = result.conclusionContract;
      const projectedQualityArtifacts = result;
      const projectedFindings = result.findings;
      const resultContract = buildSessionResultContract(session, projectedFindings);
      response.result = {
        ...copyAnalysisDeliveryFields(result),
        sceneTimeline: result.sceneTimeline ? projectSceneTimelineForClient(result.sceneTimeline) : undefined,
        sceneReport: result.sceneReport,
        sourceUseDecision: result.sourceUseDecision,
        sourceClaimVerificationResult: result.sourceClaimVerificationResult,
        success: result.success,
        answer: normalizedCompletedConclusion,
        conclusion: normalizedCompletedConclusion,
        conclusionContract: projectedCompletedContract,
        claimSupport: projectedQualityArtifacts.claimSupport,
        claimVerificationResult: projectedQualityArtifacts.claimVerificationResult,
        identityResolutions: projectedQualityArtifacts.identityResolutions,
        confidence: result.confidence,
        totalDurationMs: result.totalDurationMs,
        rounds: result.rounds,
        partial: result.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(result.terminationReason)
          : result.terminationReason,
        terminationMessage: privateKnowledge
          ? projectOwnerTerminationMessage(result.terminationMessage, outputLanguage, result)
          : result.terminationMessage,
        reportUrl: finalArtifacts?.reportUrl,
        reportError: privateKnowledge ? undefined : finalArtifacts?.reportError,
        resultSnapshotId: finalArtifacts?.resultSnapshotId,
        analysisReceipt: privateKnowledge
          ? projectPrivateAnalysisReceipt(completedPayload?.analysisReceipt)
          : completedPayload?.analysisReceipt,
        uiActionProposals: privateKnowledge
          ? projectOwnerStructuredValue(sessionId, completedPayload?.uiActionProposals || [])
          : completedPayload?.uiActionProposals,
        findings: projectedFindings,
        findingsCount: projectedFindings.length,
        resultContract: privateKnowledge
          ? projectOwnerStructuredValue(sessionId, resultContract)
          : resultContract,
      };
    }
  }

  if (session.status === 'failed' || session.status === 'cancelled') {
    response.error = sessionUsesPrivateKnowledge(session)
      ? projectOwnerAnalysisError(sessionId, session.error, sessionOutputLanguage(session))
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

    if (typeof session.orchestrator.recordUserInteraction === 'function') {
      session.orchestrator.recordUserInteraction(interaction);
      const focusStore =
        typeof session.orchestrator.getFocusStore === 'function' ? session.orchestrator.getFocusStore() : null;
      const focusCount = focusStore ? focusStore.getTopFocuses(100).length : 0;
      return res.json({ success: true, supported: true, sessionId, focusCount });
    }

    // No production runtime implements focus tracking. This used to answer
    // `{success: true, focusCount: 0}`, which reads as "recorded, nothing
    // tracked yet" rather than "this backend cannot record it" — a caller had
    // no way to tell the difference, and the frontend kept posting on every
    // interaction forever. The status stays 200 so the fire-and-forget caller
    // does not log a failure for a request that was well-formed.
    return res.json({
      success: false,
      supported: false,
      code: 'FOCUS_TRACKING_UNSUPPORTED',
      error: 'The active runtime does not implement focus tracking',
      sessionId,
      focusCount: 0,
    });
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
  evidenceArchive: getSceneEvidenceArchive(),
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
  streamSceneAnalysis: handleAuthorizedSessionStream,
  checkSceneHistory: async (req, res, sessionId) => {
    const session = getAuthorizedSession(req, res, sessionId);
    return Boolean(session && await ensureSceneHistoryAccessible(req, res, session));
  },
  projectSceneResult: session => session.result ? projectStoredHttpResult(session, session.result) : undefined,
  getRequestId,
  dispatchSceneAnalysis: input => dispatchAnalysisRun({...input, entry: 'scene_reconstruction'}, analysisRunDispatchDependencies()),
  cancelSceneRun: async (sessionId, runId) => {
    const result = await cancelSessionRun(sessionId, runId, 'Scene reconstruction cancelled by user');
    return result ? projectCancelSessionRunResult(result) : {status: 404, body: {success: false, code: 'SESSION_NOT_FOUND'}};
  },
  assistantAppService,
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
    providerId?: string | null;
    analysisContextFingerprint?: string;
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
  const authorizationSelection: AnalysisContextSelection = {
    codeAwareMode: session.sourceAuthorization?.codeAwareMode ?? options.codeAwareMode,
    codebaseIds: [...(session.sourceAuthorization?.codebaseIds ?? options.codebaseIds ?? [])],
    knowledgeSourceIds: [...(options.knowledgeSourceIds ?? [])],
  };
  const knowledgeScope = {...options.knowledgeScope};
  const authorizationFingerprint = session.analysisContextFingerprint ??
    buildAnalysisContextAuthorizationFingerprint(authorizationSelection, knowledgeScope);
  const finalizationRun = createHttpFinalizationRun(session, runId, authorizationSelection,
    knowledgeScope, authorizationFingerprint, options.analysisContextFingerprint);
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
    finalizationRun.assertCurrent();
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

    finalizationRun.assertCurrent();
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
      const finalized = await finalizeAnalysisResult({result, owner: finalizationRun.owner, query,
        dataEnvelopes: session.dataEnvelopes, caseRetrieval: {status: 'not_checked', recommendations: []}});
      finalizationRun.assertCurrent();
      completeAgentDrivenSessionWithResult({
        sessionId,
        query,
        traceId,
        session,
        result: finalized.result,
        qualityIssue: finalized.qualityIssue,
        assertCurrent: finalizationRun.assertCurrent,
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
      providerId: options.providerId,
      analysisContextFingerprint: options.analysisContextFingerprint,
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
        ? projectOwnerAnalysisError(sessionId, error, outputLanguage)
        : error.message || String(error);
    session.status = 'failed';
    session.error = publicErrorMessage;
    markSessionRunStatus(session, 'failed', session.error, runId);
    session.logger.error(
      'SmartAnalysis',
      'Smart analysis failed',
      privateKnowledge ? new Error(privateAnalysisFailureMessage(sessionOutputLanguage(session))) : error,
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
    finalizationRun.release();
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
  providerId?: string | null;
  analysisContextFingerprint?: string;
  codeAwareMode?: import('../services/codebase/codeAwareFeature').CodeAwareMode;
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
  runManifestAttributionSink: RunManifestAttributionSink;
}): Record<string, unknown> {
  return {
    traceProcessorService: input.traceProcessorService,
    providerId: input.providerId,
    analysisContextFingerprint: input.analysisContextFingerprint,
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

export {SmartPreviewSelectionError} from '../assistant/application/analysisRunDispatchService';

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
  qualityIssue?: FinalResultQualityIssue;
  assertCurrent?: () => void;
}): void {
  input.assertCurrent?.();
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
  finalizeAgentDrivenSession(input, {
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
        sourceClaimVerificationResult: result.sourceClaimVerificationResult,
        sourceUseDecision: result.sourceUseDecision,
        ...copyAnalysisDeliveryFields(result),
        identityResolutions: result.identityResolutions,
      });
    },
    terminalRunStatusForResult,
    markSessionRunStatus,
    persistAgentTurn,
    refreshPersistedAgentSnapshot,
    ensureCompletedAnalysisSseEvents: (session, runId) => ensureCompletedAnalysisSseEvents(session, runId, {
      entry: 'new_finalization', assertCurrent: input.assertCurrent,
    }),
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

/**
 * The Skill fragment both legacy input detectors read android_input_events
 * through, so they see the same prefix-free actions (DOWN/MOVE/UP) as Skills.
 */
const INPUT_EVENTS_FRAGMENTS = ['android_input_events_normalized.sql'];

/** Detect scroll sessions from input events + frame timeline */
async function detectScrollSessions(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const scrollResult = await tps.query(
    traceId,
    composeFragmentSql({leadingCtes: [], fragments: INPUT_EVENTS_FRAGMENTS, select: `
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
      FROM android_input_events_normalized
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
  `}),
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
    composeFragmentSql({leadingCtes: [], fragments: INPUT_EVENTS_FRAGMENTS, select: `
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
      FROM android_input_events_normalized
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
  `}),
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
  normalizeNarrativeForClient: narrative => narrative,
  buildClientFindings: copyStoredClientFindings,
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
  input: CaptureCaseCandidatesAfterQualityArtifactsInput & {assertCurrent?: () => void},
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
    input.assertCurrent?.();
    const traceContentHash = await computeTraceHash(input.traceId);
    input.assertCurrent?.();
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

    input.assertCurrent?.();
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
  options = {...options,
    codebaseIds: Array.isArray(options.codebaseIds) ? [...options.codebaseIds] : undefined,
    knowledgeSourceIds: Array.isArray(options.knowledgeSourceIds) ? [...options.knowledgeSourceIds] : undefined,
  };
  const decoratedTraceContext = decorateTraceContextDatasets(options.traceContext, traceId);
  options.traceContext = decoratedTraceContext;
  if (!runIdForAnalysis) {
    throw new Error(`Missing run id for session ${sessionId}`);
  }
  const authorizationSelection: AnalysisContextSelection = {
    codeAwareMode: session.sourceAuthorization?.codeAwareMode ?? options.codeAwareMode,
    codebaseIds: [...(session.sourceAuthorization?.codebaseIds ?? options.codebaseIds ?? [])],
    knowledgeSourceIds: [...(options.knowledgeSourceIds ?? [])],
  };
  const knowledgeScope: KnowledgeScope = {...(options.knowledgeScope ?? {
    tenantId: session.tenantId, workspaceId: session.workspaceId, userId: session.userId,
  })};
  const authorizationFingerprint = session.analysisContextFingerprint ??
    buildAnalysisContextAuthorizationFingerprint(authorizationSelection, knowledgeScope);
  const finalizationRun = createHttpFinalizationRun(session, runIdForAnalysis,
    authorizationSelection, knowledgeScope, authorizationFingerprint, options.analysisContextFingerprint);
  const startedAt = session.activeRun!.startedAt;
  const startupDeadlineMs = Number.isFinite(options.taskTimeoutMs) && options.taskTimeoutMs > 0
    ? startedAt + options.taskTimeoutMs : Number.POSITIVE_INFINITY;
  let runtimeDeadlineMs = startupDeadlineMs;
  let allowAutomaticPrefetch = false;
  let finalizationContext: RuntimeFinalizationContext | undefined;
  let contextTransferred = false;
  let sceneSeal: SceneRuntimeSeal | undefined;
  let acceptingUpdates = true;
  const rawDataEnvelopes: DataEnvelope[] = [...(session.dataEnvelopes ?? [])];
  const canPrefetch = () => {
    finalizationRun.assertCurrent();
    return !options.sceneRunBinding && allowAutomaticPrefetch && Date.now() < runtimeDeadlineMs;
  };
  const agentQuery =
    session.agentQuery && session.query === query
      ? session.agentQuery
      : buildAgentQueryWithContinuityNotice(query, session.continuityBreaks);

  // Track generation is a lightweight derivation step from DataEnvelopes.
  // Enable by default (unless explicitly disabled) so `/api/agent/v1/analyze` can
  // also produce TrackEvent(s) when the scene reconstruction skill runs.
  const shouldGenerateTracks = !options.sceneRunBinding && options.generateTracks !== false;

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
    if (!acceptingUpdates) return;
    try {finalizationRun.assertCurrent();} catch {return;}
    if (update.type === 'data') {
      const envelopes = Array.isArray(update.content) ? update.content : [update.content];
      rawDataEnvelopes.push(...envelopes.filter((item): item is DataEnvelope => validateDataEnvelope(item).length === 0));
    }
    session.lastActivityAt = Date.now();
    const sourceAware = sessionUsesPrivateKnowledge({
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
    });
    // Log from the strict projection independently, before entering owner scope.
    const logUpdate = projectCodeAwareStreamingUpdate(sessionId, update, sourceAware, outputLanguage);
    if (logUpdate && logUpdate.type !== 'answer_token') {
      logger.debug('Stream', `Update: ${logUpdate.type}`, logUpdate.content);
    }
    const projectedUpdate = projectOwnerCodeAwareStreamingUpdate(sessionId, update, sourceAware, outputLanguage);
    if (!projectedUpdate) return;
    const normalizedUpdate = normalizeAgentDrivenUpdate(projectedUpdate, outputLanguage);

    if (normalizedUpdate.type === 'conclusion' || normalizedUpdate.type === 'answer_token') return;
    if (options.sceneRunBinding && normalizedUpdate.type === 'error') {
      // A provider failure may still leave a valid committed proposal. Only the
      // product's finalization/catch path owns terminal delivery for scene runs.
      broadcastToAgentDrivenClients(sessionId, {type: 'degraded',
        content: {fallback: 'scene_runtime_error'}, timestamp: normalizedUpdate.timestamp}, runIdForAnalysis);
      return;
    }
    finalizationRun.assertCurrent();

    // Final narrative is emitted through analysis_completed after deterministic
    // evidence/claim verification has run. Suppress early conclusion events so
    // clients do not render an unverified terminal answer.
    broadcastToAgentDrivenClients(sessionId, normalizedUpdate, runIdForAnalysis);

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
    if (eventType !== normalizedUpdate.type) {
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

  try {
  finalizationRun.assertCurrent();
  const traceContextEnvelopes = appendTraceContextDataEnvelopes(session, decoratedTraceContext, traceId);
  rawDataEnvelopes.push(...traceContextEnvelopes);
  if (traceContextEnvelopes.length > 0) {
    finalizationRun.assertCurrent();
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

    console.log('[AgentRoutes.AgentDriven] Starting orchestrator.analyze...');
    finalizationRun.assertCurrent();
    let result = await logger.timed('AgentDrivenAnalysis', 'analyze', async () => {
        const baseAnalyzeOptions: AnalysisOptions = {
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
            sourceUsePolicy: options.sourceUsePolicy,
            analysisContextFingerprint: options.analysisContextFingerprint,
            androidInternalsPackPin: session.androidInternalsPackPin,
            tenantId: session.tenantId,
            workspaceId: session.workspaceId,
            userId: session.userId,
            runId: runIdForAnalysis,
            runManifestAttributionSink: options.runManifestAttributionSink,
          };
        const analyzeOptions = options.sceneRunBinding ? options.sceneRunBinding.bindOptions(baseAnalyzeOptions) : baseAnalyzeOptions;
        const analyze = () => session.orchestrator.analyze(agentQuery, sessionId, traceId, analyzeOptions).then(nativeResult => {
            sceneSeal = options.sceneRunBinding?.seal();
            finalizationContext = takeFinalizationContext(nativeResult);
            acceptingUpdates = false;
            session.orchestrator.off('update', handleUpdate);
            finalizationRun.assertCurrent();
            if (finalizationContext?.runId !== undefined && finalizationContext.runId !== runIdForAnalysis) {
              throw new Error('finalization_run_identity_mismatch');
            }
            runtimeDeadlineMs = Math.min(startupDeadlineMs, finalizationContext?.deadlineMs ?? 0);
            allowAutomaticPrefetch = finalizationContext !== undefined &&
              resolveRuntimeTurnPolicy(finalizationContext.turnIntent, options.analysisMode).allowAutomaticPrefetch;
            return nativeResult;
          });
        return runWithTraceProcessorLease(analyze);
      });
    finalizationRun.assertCurrent();
    if (canPrefetch() && options.executeStateTimeline && options.traceProcessorService) {
      try {
        const envelopes = await awaitHttpFinalizationOperation(runWithTraceProcessorLease(() =>
          executeStateTimelineSkill(options.traceProcessorService, traceId)), finalizationRun, runtimeDeadlineMs);
        rawDataEnvelopes.push(...envelopes);
        updateSceneReconstructionArtifactsFromEnvelopes(session, envelopes);
        for (const envelope of envelopes) {
          finalizationRun.assertCurrent();
          broadcastToAgentDrivenClients(sessionId, {type: 'data', content: envelope, timestamp: Date.now()}, runIdForAnalysis);
        }
      } catch {finalizationRun.assertCurrent();}
    }

    // Ensure trackEvents/scenes are computed for completed sessions (even without SSE clients)
    if (shouldGenerateTracks) {
      updateSceneReconstructionArtifactsFromEnvelopes(session, session.dataEnvelopes as DataEnvelope[]);
    }

    if (canPrefetch() && options.referenceTraceId && options.traceProcessorService) {
      let comparisonReportSection: typeof session.comparisonReportSection;
      try {
        comparisonReportSection = await awaitHttpFinalizationOperation(runWithTraceProcessorLease(() =>
          buildRawTraceComparisonReportSection(options.traceProcessorService, {
            currentTraceId: traceId,
            referenceTraceId: options.referenceTraceId,
          }),
        ), finalizationRun, runtimeDeadlineMs);
      } catch (comparisonSectionError: any) {
        finalizationRun.assertCurrent();
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
      finalizationRun.assertCurrent();
      session.comparisonSource = 'raw_trace_pair';
      session.comparisonReportSection = comparisonReportSection;
    }

    if (canPrefetch() && options.traceProcessorService) {
    try {
      const traceSummaryExecution = await awaitHttpFinalizationOperation(runWithTraceProcessorLease(() =>
        executeManagedTraceSummaryV1(options.traceProcessorService, traceId, 'current'),
      ), finalizationRun, runtimeDeadlineMs);
      finalizationRun.assertCurrent();
      session.traceSummary = buildTraceSummaryAttributionV1(traceSummaryExecution);
    } catch {
      finalizationRun.assertCurrent();
      session.traceSummary = buildTraceSummaryAttributionV1(
        unavailableTraceSummaryV1('trace_processor_session_unavailable'),
      );
    }

    }
    finalizationRun.assertCurrent();
    const sceneIdHint = finalizationContext?.turnIntent.status === 'resolved'
      ? finalizationContext.turnIntent.sceneId : result.conclusionContract?.metadata?.sceneId;
    const caseEvolutionConfig = loadCaseEvolutionConfig();
    let caseRetrieval: AnalysisCaseRetrievalState = {status: 'not_checked', recommendations: []};
    if (canPrefetch() && result.conclusionContract && isCaseEvolutionRetrieveEnabled(caseEvolutionConfig)) {
      try {
        const attached = attachCaseHitsToContractSync({
          conclusionContract: result.conclusionContract, dataEnvelopes: rawDataEnvelopes,
          sceneType: sceneIdHint, architectureType: resolveCaseEvolutionArchitectureType(session, traceId), knowledgeScope,
        });
        finalizationRun.assertCurrent();
        caseRetrieval = {status: 'checked', recommendations: attached.hits};
      } catch {
        finalizationRun.assertCurrent();
        caseRetrieval = {status: 'unavailable', recommendations: []};
      }
    }
    finalizationRun.assertCurrent();
    const comparisonIdentity = options.referenceTraceId ? await resolveCapturedComparisonIdentity({
      currentTraceId: traceId, referenceTraceId: options.referenceTraceId, dataEnvelopes: rawDataEnvelopes,
      context: finalizationContext, signal: finalizationRun.owner.signal, reportSection: session.comparisonReportSection,
    }) : undefined;
    finalizationRun.assertCurrent();
    contextTransferred = true;
    const finalized = await finalizeAnalysisResult({
      result, context: finalizationContext, owner: finalizationRun.owner, query,
      ...(sceneSeal ? {scene: {seal: sceneSeal, outputLanguage, providerId: options.providerId,
        scope: {runId: runIdForAnalysis, sessionId, traceId,
        ownerKey: sceneRunOwnerKey(session)}}} : {}),
      dataEnvelopes: rawDataEnvelopes, comparisonReportSection: session.comparisonReportSection,
      comparisonIdentity,
      caseRetrieval,
      // The semantic review can run for minutes after the answer stream ended.
      onProgress: event => broadcastToAgentDrivenClients(sessionId,
        finalReviewProgressUpdate(event, outputLanguage), runIdForAnalysis),
    });
    finalizationRun.assertCurrent();
    result = finalized.result;
    if (finalized.scenePublication && result.sceneTimeline) {
      try {
        const requestedRange = result.sceneTimeline.scanCoverage?.requestedWindow;
        if (!requestedRange) throw new Error('scene_report_bounds_unavailable');
        const tp = options.traceProcessorService;
        const processorInput = tp?.getRunningCapabilityTraceProcessorInput?.(traceId);
        const processorIdentity = processorInput ? await resolveCapabilityTraceProcessorIdentity(processorInput)
          : {source: 'unknown', reason: 'runtime_identity_unavailable'};
        finalizationRun.assertCurrent();
        const traceContentHash = tp ? await computeTraceContentHash(tp, traceId) : null;
        finalizationRun.assertCurrent();
        const published = await sceneStoryService.acceptFinalizedTimeline({publication: finalized.scenePublication,
          scope: {runId: runIdForAnalysis, sessionId, traceId, ownerKey: sceneRunOwnerKey(session)},
          assertCurrent: finalizationRun.assertCurrent,
          meta: {owner: session, requestedRange, traceContentHash,
            schemaVersion: result.sceneTimeline.schemaVersion, ruleVersion: SCENE_FINITE_RULE_VERSION,
            producerFingerprint: analysisDeliveryFingerprint({
              coveragePlan: result.sceneTimeline.scanCoverage?.plan?.fingerprint ?? null,
              definitions: [...new Set(result.sceneTimeline.segments.flatMap(item =>
                item.evidence.flatMap(excerpt => Object.values(excerpt.fields).map(field => field.origin.definitionFingerprint))))].sort(),
            }),
            traceProcessorFingerprint: analysisDeliveryFingerprint(processorIdentity)}});
        finalizationRun.assertCurrent();
        session.sceneStoryReport = published.report;
        result.sceneReport = {schemaVersion: 'scene_report_ref@1', reportId: published.report.reportId,
          traceId, sessionId, runId: runIdForAnalysis, revision: result.sceneTimeline.revision,
          manifestSha256: published.archiveRef.manifestSha256, expiresAt: published.archiveRef.expiresAt};
      } catch (error) {
        finalizationRun.assertCurrent();
        result.partial = true;
        result.sceneTimeline = {...result.sceneTimeline, diagnostics: [...result.sceneTimeline.diagnostics,
          {code: 'scene_archive_unavailable'}]};
        logger.warn('SceneReconstruction', 'Timeline archive unavailable', {diagnostic: diagnosticLogIdentity(errorMessage(error))});
      }
    }
    if (canPrefetch() && (result.success || result.partial === true)) {
      void captureCaseCandidatesAfterQualityArtifacts({
        sessionId, traceId, session, result, normalizedConclusionContract: result.conclusionContract,
        sceneIdHint, runIdForAnalysis, knowledgeScope, caseEvolutionConfig, logger,
        assertCurrent: () => {
          finalizationRun.assertCurrent();
          if (Date.now() >= runtimeDeadlineMs) throw new DOMException('Run deadline exceeded', 'TimeoutError');
        },
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
      qualityIssue: finalized.qualityIssue,
      assertCurrent: finalizationRun.assertCurrent,
    });
  } catch (error: any) {
    if (!finalizationRun.owner.isCurrent()) return;
    const privateKnowledge = sessionUsesPrivateKnowledge(session);
    const authorizationChanged = error instanceof AnalysisContextAuthorizationChangedError ||
      error?.code === 'analysis_context_changed_restart_required';
    if (authorizationChanged) {
      await retireAuthorizationChangedSession(sessionId, session, handleUpdate);
      if (!finalizationRun.owner.isCurrent()) return;
    }
    const publicErrorMessage = privateKnowledge
      ? projectOwnerAnalysisError(sessionId, error, outputLanguage)
      : error.message;
    if (isSessionRunCancelled(session, runIdForAnalysis)) {
      logger.info('AgentDrivenAnalysis', 'Ignoring analysis error after cancellation', {
        sessionId,
        runId: runIdForAnalysis,
        error: privateKnowledge ? privateAnalysisFailureMessage(sessionOutputLanguage(session)) : publicErrorMessage,
      });
      return;
    }
    if (isStaleRun(session, runIdForAnalysis)) {
      logger.info('AgentDrivenAnalysis', 'Ignoring stale analysis error', {
        sessionId,
        runId: runIdForAnalysis,
        error: privateKnowledge ? privateAnalysisFailureMessage(sessionOutputLanguage(session)) : publicErrorMessage,
      });
      return;
    }
    session.status = 'failed';
    session.error = publicErrorMessage;
    markSessionRunStatus(session, 'failed', publicErrorMessage, runIdForAnalysis);
    logger.error(
      'AgentDrivenAnalysis',
      'Agent-driven analysis failed',
      privateKnowledge ? new Error(privateAnalysisFailureMessage(sessionOutputLanguage(session))) : error,
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
    acceptingUpdates = false;
    if (!contextTransferred) finalizationContext?.dispose();
    finalizationRun.release();
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


function buildConversationStepUpdate(
  session: AnalysisSession,
  update: StreamingUpdate,
  runId?: string,
): StreamingUpdate | null {
  const language = sessionOutputLanguage(session);
  const derived = deriveTimelineStep(update, language, {
    comparisonActive: Boolean(session.referenceTraceId) || session.comparisonSource === 'analysis_result_snapshots',
    currentTraceId: session.traceId,
    referenceTraceId: session.referenceTraceId,
  });
  if (!derived) return null;

  const {phase, role, text} = derived;
  const contentRecord =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};

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
  if (update.type === 'scene_timeline_updated' && (!runId || update.content?.runId !== runId ||
      update.content?.sessionId !== sessionId || update.content?.traceId !== session.traceId)) return;
  session.lastActivityAt = Date.now();

  // F3: Assign monotonic sequence ID for replay on reconnect
  const seqId = ++session.sseEventSeq;

  streamProjector.broadcastStreamingUpdate(sessionId, filterSseClientsForRun(session.sseClients, runId), update, {
    observability: buildStreamObservability(session, runId),
    seqId,
    onBufferedEvent: (event) => {
      if (runId) event.runId = runId;
      appendSceneAwareReplayEvent(session.sseEventBuffer, event);
      if (event.eventType === 'scene_timeline_updated') session.sceneTimelineReplay = event;
      // In-progress scene witnesses are live-only. Persist the final archived
      // revision, rather than storing repeated full candidate manifests on disk.
      else persistBufferedAgentEvent(
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
  adaptiveRouting?: RunManifestV1['adaptiveRouting'];
  existingReceipt?: AnalysisReceipt;
  legacyRecovery?: true;
}

function runManifestReceiptReference(
  manifest: Pick<
    RunManifestV1,
    'runManifestId' | 'capabilityManifest' | 'adaptiveRouting'
  >,
): RunManifestReceiptReference {
  return {
    runManifestId: manifest.runManifestId,
    capabilityManifest: manifest.capabilityManifest,
    ...(manifest.adaptiveRouting
      ? {adaptiveRouting: manifest.adaptiveRouting}
      : {}),
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
      adaptiveRouting: reference.adaptiveRouting,
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
  finalArtifacts: Partial<CompletedAnalysisFinalArtifacts>;
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
    assertCurrent?: () => void;
  },
): CompletedAnalysisFinalArtifacts {
  input.assertCurrent?.();
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
    ? projectOwnerAnalysisResult(session.sessionId, input.resultForClient, outputLanguage)
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
      input.assertCurrent?.();
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
      input.assertCurrent?.();
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
      input.assertCurrent?.();
      const resultSnapshot = persistCompletedAnalysisResultSnapshot({
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        traceId: session.traceId,
        sessionId: session.sessionId,
        runId,
        reportId: finalArtifacts.reportId,
        sceneType: result.turnIntent?.status === 'resolved' ? result.turnIntent.sceneId
          : result.conclusionContract?.metadata?.sceneId ?? 'general',
        query: privateKnowledge
          ? privateAnalysisQueryMessage(outputLanguage)
          : session.query,
        traceLabel: session.traceId,
        conclusion: privateKnowledge
          ? durableResultForClient.conclusion
          : input.normalizedConclusion,
        ...copyAnalysisDeliveryFields(durableResultForClient),
        sceneReport: durableResultForClient.sceneReport,
        sceneTimelineRevision: durableResultForClient.sceneTimeline?.revision,
        success: durableResultForClient.success,
        sourceClaimVerificationResult: durableResultForClient.sourceClaimVerificationResult,
        conclusionContract: durableResultForClient.conclusionContract,
        sourceUseDecision: durableResultForClient.sourceUseDecision,
        claimSupport: durableResultForClient.claimSupport,
        claimVerificationResult: durableResultForClient.claimVerificationResult,
        identityResolutions: durableResultForClient.identityResolutions,
        confidence: result.confidence,
        partial: result.partial,
        terminationReason: privateKnowledge
          ? projectPrivateTerminationReason(result.terminationReason)
          : result.terminationReason,
        terminationMessage: privateKnowledge
          ? projectOwnerTerminationMessage(result.terminationMessage, outputLanguage, result)
          : result.terminationMessage,
        dataEnvelopes: session.dataEnvelopes,
        analysisReceipt: privateKnowledge
          ? projectPrivateAnalysisReceipt(snapshotReceipt)
          : snapshotReceipt,
        traceSummary: session.traceSummary,
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
      input.assertCurrent?.();
      console.warn('[AgentRoutes] Failed to persist analysis result snapshot:', {
        sessionId: session.sessionId,
        runId,
        error: snapshotError?.message || String(snapshotError),
      });
    }
  }

  input.assertCurrent?.();
  if (runId) {
    artifactCache[runId] = finalArtifacts;
  } else {
    (session as any).completedAnalysisFinalArtifacts = finalArtifacts;
  }
  return finalArtifacts;
}

interface CompletedPublication {
  entry: 'new_finalization';
  assertCurrent?: () => void;
}

function copyStoredClientFindings(findings: AgentRuntimeAnalysisResult['findings']): ClientFindingPayload[] {
  return findings.map((finding, index) => ({...finding, id: finding.id ?? `finding_${index + 1}`}));
}

function projectStoredHttpResult(session: AnalysisSession, result: AgentRuntimeAnalysisResult): AgentRuntimeAnalysisResult {
  return sessionUsesPrivateKnowledge(session)
    ? projectOwnerAnalysisResult(session.sessionId, result, sessionOutputLanguage(session))
    : copyAnalysisResultForSnapshot(result);
}

function ensureCompletedAnalysisResultPayload(
  session: AnalysisSession,
  runId?: string,
  publication?: CompletedPublication,
): CompletedAnalysisResultPayload | undefined {
  const completedRunId = getCompletedResultRunId(session, runId);
  // A run-scoped replay can never borrow a later turn's body or receipt.
  if (runId && runId !== getSessionRunId(session)) return undefined;
  const stored = recoverResultForSessionIfNeeded(session.sessionId, session);
  if (!stored) return undefined;
  const storedRunId = stored.completion?.runId ?? stored.analysisReceipt?.runId;
  if (completedRunId && storedRunId && storedRunId !== completedRunId) return undefined;
  if (!publication && !storedRunId && (session.status === 'running' || session.status === 'pending')) return undefined;
  publication?.assertCurrent?.();
  if (publication) {
    const qualityArtifacts = {claimSupport: stored.claimSupport, claimVerificationResult: stored.claimVerificationResult,
      identityResolutions: stored.identityResolutions};
    stored.quickRun = finalizeQuickRunReceipt(session, {result: stored, qualityArtifacts, runId: completedRunId});
    stored.uiActionProposals = deriveUiActionProposals({dataEnvelopes: session.dataEnvelopes ?? [],
      currentTraceId: session.traceId, existingProposals: stored.uiActionProposals});
    publication.assertCurrent?.();
    const finalArtifacts = ensureCompletedAnalysisFinalArtifacts(session, {
      result: stored, hasEvidenceBackedConclusion: stored.success || stored.partial === true,
      normalizedConclusion: stored.conclusion, normalizedConclusionContract: stored.conclusionContract,
      qualityArtifacts, resultForClient: stored, runId: completedRunId, assertCurrent: publication.assertCurrent,
    });
    publication.assertCurrent?.();
    stored.analysisReceipt = buildAnalysisReceiptForReference(finalArtifacts.receiptReference, {
      session, result: stored, runId: completedRunId, qualityArtifacts, quickRun: stored.quickRun,
      finalArtifacts, providerId: session.providerId ?? null,
    });
    if (completedRunId) getActiveRunManifestLifecycle(runManifestScopeFromSession(session),
      session.sessionId, completedRunId)?.dispose();
  }
  const result = projectStoredHttpResult(session, stored);
  const finalArtifacts = (completedRunId
    ? (session as any).completedAnalysisFinalArtifactsByRunId?.[completedRunId]
    : (session as any).completedAnalysisFinalArtifacts) ?? {};
  const clientFindings = copyStoredClientFindings(result.findings);
  return {
    result, replayOnlyScene: false, normalizedConclusion: result.conclusion,
    normalizedConclusionContract: result.conclusionContract,
    qualityArtifacts: {claimSupport: result.claimSupport, claimVerificationResult: result.claimVerificationResult,
      identityResolutions: result.identityResolutions},
    quickRun: result.quickRun, analysisReceipt: result.analysisReceipt,
    uiActionProposals: result.uiActionProposals, clientFindings,
    resultContract: buildSessionResultContract(session, clientFindings), finalArtifacts,
  };
}

/**
 * Send agent-driven analysis result to SSE client
 */
function analysisCompletedData(
  data: AnalysisCompletedEvent['data'],
  actualSourceUseDecision?: unknown,
): AnalysisCompletedEvent['data'] {
  const projected = projectAnalysisCompletedConclusionContract(
    data.conclusionContract,
    actualSourceUseDecision,
  );
  return projected.sourceProjectionApplied
    ? {...data, conclusionContract: projected.conclusionContract}
    : data;
}

function projectAnalysisCompletedConclusionContract(
  value: unknown,
  actualSourceUseDecision?: unknown,
): {conclusionContract?: ConclusionContract; sourceProjectionApplied: boolean} {
  const contract = projectStoredConclusionSourceMetadata(value, actualSourceUseDecision) as ConclusionContract | undefined;
  return {conclusionContract: contract, sourceProjectionApplied: contract !== value};
}

function ensureCompletedAnalysisSseEvents(session: AnalysisSession, runId?: string, publication?: CompletedPublication): BufferedSseEvent[] {
  const completedRunId = getCompletedResultRunId(session, runId);
  const sseCache = (session as any).completedAnalysisSseEventsByRunId as Record<string, {events: BufferedSseEvent[]}> | undefined;
  const cached = completedRunId ? sseCache?.[completedRunId]?.events
    : (session as any).completedAnalysisSseEvents as BufferedSseEvent[] | undefined;
  if (cached?.length && !publication) return cached.map(event => ({...event,
    eventData: sanitizePersistedAnalysisCompletedEvent(session, event as unknown as SerializedAgentEvent).eventData}));
  if (!publication) {
    const persisted = loadPersistedCompletedAnalysisSseEvents(session, completedRunId);
    if (persisted.length) return persisted;
  }
  const completedPayload = ensureCompletedAnalysisResultPayload(session, completedRunId, publication);
  if (!completedPayload) return [];
  const appendEvent = (target: AnalysisSession, eventType: string, payload: Record<string, unknown>, id?: string): BufferedSseEvent => {
    publication?.assertCurrent?.();
    if (publication) return appendAndPersistReplayableSessionEvent(target, eventType, payload, id);
    return {seqId: target.sseEventSeq ?? 0, eventType, eventData: JSON.stringify(payload), runId: id};
  };
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
  const projectedConclusion = normalizedConclusion;
  const projectedConclusionContract = normalizedConclusionContract;
  const projectedQualityArtifacts = qualityArtifacts;
  const projectedUiActionProposals = privateKnowledge
    ? projectOwnerStructuredValue(session.sessionId, uiActionProposals)
    : uiActionProposals;
  const projectedClientFindings = privateKnowledge
    ? projectOwnerStructuredValue(session.sessionId, clientFindings)
    : clientFindings;
  const projectedResultContract = privateKnowledge
    ? projectOwnerStructuredValue(session.sessionId, resultContract)
    : resultContract;
  const projectedHypotheses = projectOwnerStructuredValue(
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
    appendEvent(
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
      appendEvent(
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
    appendEvent(
      session,
      'analysis_completed',
      {
        type: 'analysis_completed',
        architecture: 'agent-driven',
        ...observability,
        data: {
          ...(privateKnowledge
            ? {privateProjectionVersion: PRIVATE_ANALYSIS_EVENT_PROJECTION_VERSION}
            : {}),
          ...copyAnalysisDeliveryFields(result),
          success: result.success,
          sourceUseDecision: result.sourceUseDecision,
          sourceClaimVerificationResult: result.sourceClaimVerificationResult,
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
            ? projectOwnerTerminationMessage(result.terminationMessage, outputLanguage, result)
            : result.terminationMessage,
          quickRun,
          analysisReceipt: privateKnowledge
            ? projectPrivateAnalysisReceipt(analysisReceipt)
            : analysisReceipt,
          uiActionProposals: projectedUiActionProposals,
          sceneTimeline: result.sceneTimeline ? projectSceneTimelineForClient(result.sceneTimeline) : undefined,
          sceneReport: result.sceneReport,
          smartScenePreview: privateKnowledge && result.smartScenePreview
            ? projectOwnerStructuredValue(session.sessionId, result.smartScenePreview)
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
                ? projectOwnerStructuredValue(session.sessionId, {
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
          sourceEnrichmentPending: session.analysisSourceEnrichment?.status === 'running',
          observability,
          terminalRunStatus: terminalRunStatusForResult(result),
        },
        timestamp: Date.now(),
      },
      completedRunId,
    ),
  );

  // Backward-compatible scene reconstruction payload (used by the legacy /scene-reconstruct clients).
  if ((session.scenes?.length || 0) > 0 || (session.trackEvents?.length || 0) > 0) {
    events.push(
      appendEvent(
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

  if (session.analysisSourceEnrichment?.status !== 'running') {
    events.push(
      appendEvent(
        session,
        'end',
        {
          timestamp: Date.now(),
          ...observability,
        },
        completedRunId,
      ),
    );
  }
  if (publication && completedRunId) {
    const writableCache = ((session as any).completedAnalysisSseEventsByRunId ||= {});
    writableCache[completedRunId] = {
      events,
      qualityGateVersion: COMPLETED_ANALYSIS_SSE_EVENTS_QUALITY_GATE_VERSION,
    };
  } else if (publication) {
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
  ensureCompletedAnalysisSseEvents,
  recoverResultForSessionIfNeeded,
  ensureCompletedAnalysisResultPayload,
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
  analysisCompletedData,
};

export const agentRoutesReceiptTestSeam = {
  runManifestReceiptReference,
  buildAnalysisReceiptForReference,
};

export const agentRoutesSmartPreviewSelectionTestSeam = {
  hasSession: (sessionId: string) => Boolean(assistantAppService.getSession(sessionId)),
  deleteSession: (sessionId: string) => assistantAppService.deleteSession(sessionId),
};

export const agentRoutesCancellationTestSeam = {
  runAgentDrivenAnalysis,
  createHttpFinalizationRun,
  startAnalysisSourceEnrichment,
  abortHttpFinalizationRuns,
  setSession: (sessionId: string, session: AnalysisSession) =>
    assistantAppService.setSession(sessionId, session),
  deleteSession: (sessionId: string) => assistantAppService.deleteSession(sessionId),
  cancelSessionRun,
};

export default router;
