// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {getTraceProcessorService, type TraceInfo} from '../../services/traceProcessorService';
import {createSessionLogger} from '../../services/sessionLogger';
import {SessionPersistenceService} from '../../services/sessionPersistenceService';
import {isOwnedByContext, ownerFieldsFromContext} from '../../services/resourceOwnership';
import {hasRbacPermission} from '../../services/rbac';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import type {SceneReport} from '../../agent/scene/types';
import {resolveFeatureConfig} from '../../config';
import {evaluateAnalysisRunQuota} from '../../services/enterpriseQuotaPolicyService';
import {evaluateTenantMutationPolicy, sendTenantMutationDeniedPayload} from '../../services/enterpriseTenantLifecycleService';
import {TraceProcessorAdmissionError} from '../../services/traceProcessorRamBudget';
import {prepareAnalysisRunTraceProcessorLeases, analysisRunTraceProcessorFailureSide, type AnalysisRunTraceProcessorLeases} from '../../services/analysisRunTraceProcessorLease';
import {AnalyzeOptionsError, normalizeAnalyzeOptions, normalizeSelectionContext} from '../../routes/agent/normalizeAnalyzeOptions';
import {publicRequestErrorBody} from '../../utils/publicRequestError';
import {AgentAnalyzeSessionService, AnalyzeSessionPreparationError} from './agentAnalyzeSessionService';
import {getDefaultAndroidInternalsPackResolver} from '../../services/androidInternalsPack/androidInternalsPackResolver';
import {knowledgeScopeFromRequestContext} from '../../services/scopedKnowledgeStore';
import {authorizeAnalysisContext} from '../../services/analysisContextAuthorization';
import {registerPrivateAnalysisQueryForEcho, revokeCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';
import {privateAnalysisFailureMessage, projectOwnerAnalysisError} from '../../services/security/privateAnalysisProjection';
import {buildAnalysisContextAuthorizationFingerprint} from '../../services/resolvedAnalysisContext';
import {withRunManifestLifecycle, type RunManifestLifecycle} from '../../services/selfEvolution/runManifestLifecycle';
import type {RequestContext} from '../../middleware/auth';
import type {AnalyzeManagedSession, AnalyzeSessionRunContext} from './agentAnalyzeSessionService';
import type {AssistantApplicationService} from './assistantApplicationService';
import type {EnhancedSessionContext} from '../../agent/context/enhancedSessionContext';
import type {AgentRuntimeAnalysisResult, StreamingUpdate} from '../../agent';
import type {TraceProcessorHolderType} from '../../services/traceProcessorLeaseStore';
import type {TraceProcessorLeaseModeDecision} from '../../services/traceProcessorLeaseModeDecision';
import type {PersistedAnalysisRunStatus} from '../../services/analysisRunStore';
import type {AnalyzeMode, NormalizedAnalyzeOptions} from '../../routes/agent/normalizeAnalyzeOptions';
import type {SceneAnalysisSelection} from '../../agent/scene/types';
import type {ResourceOwnerFields} from '../../services/resourceOwnership';
import type {KnowledgeScope} from '../../services/scopedKnowledgeStore';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {AiDisabledError, assertAiFeatureEnabled, buildAiDisabledPayload} from '../../services/aiCapabilityPolicy';
import {readTraceMetadataForContext} from '../../services/traceMetadataStore';
import {
  analysisHasPrivateContext,
  privateContextRestrictsAudience,
} from '../../services/security/analysisPrivateContext';

export interface AnalysisDispatchSession extends AnalyzeManagedSession {
  sceneStoryReport?: SceneReport;
  cancellationInFlightRunId?: string;
  sceneExecutionInFlightRunId?: string;
}

/** Entry is supplied by the server route, never copied from body/options. */
export interface AnalysisRunDispatchInput {
  entry: 'analysis' | 'scene_reconstruction';
  requestId: string;
  context: RequestContext;
  requestedSessionIdOverride?: string;
  body: {
    traceId: string;
    query: string;
    sessionId?: string;
    options?: unknown;
    selectionContext?: unknown;
    referenceTraceId?: string;
    traceContext?: unknown;
    providerId?: string | null;
  };
}
export interface AnalysisRunExecutionOptions extends NormalizedAnalyzeOptions {
  runContext: AnalyzeSessionRunContext;
  traceProcessorService: ReturnType<typeof getTraceProcessorService>;
  providerId?: string | null;
  referenceTraceId?: string;
  traceContext?: unknown[];
  knowledgeScope?: KnowledgeScope;
  runManifestAttributionSink: RunManifestAttributionSink;
  sceneRunBinding?: SceneRunDispatchBinding;
}

export interface AnalysisRunDispatchResponse {
  status: number;
  body: Record<string, unknown>;
}

/** A product-issued run capability. Never serialized or read from HTTP options. */
export interface SceneRunDispatchBinding {
  bindOptions<T extends AnalysisOptions>(options: T): T;
  seal(): import('../../agent/scene/sceneRuntimeBinding').SceneRuntimeSeal | undefined;
  release(): void | Promise<void>;
}
export interface SceneRunDispatchHooks<TSession extends AnalysisDispatchSession> {
  onAdmitted(input: {
    session: TSession;
    run: AnalyzeSessionRunContext;
    traceId: string;
    requestContext: RequestContext;
    signal: AbortSignal;
    assertCurrent(): void;
  }): Promise<SceneRunDispatchBinding> | SceneRunDispatchBinding;
}

/** Route-owned session/projection helpers; admission and lifecycle stay here. */
export interface AnalysisRunDispatchDependencies<TSession extends AnalysisDispatchSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  httpAnalysisRunLeaseControllers: WeakMap<TSession, Map<string, AbortController>>;
  admittedLocalAnalysisRuns: WeakMap<TSession, Set<string>>;
  blockedSceneStrategyIds: readonly string[];
  sceneRunHooks?: SceneRunDispatchHooks<TSession>;
  configuredOutputLanguage(): OutputLanguage;
  sessionOutputLanguage(session?: {outputLanguage?: OutputLanguage} | null): OutputLanguage;
  enterpriseLeasesEnabled(): boolean;
  leaseScopeFromRequestContext(context: RequestContext): {tenantId: string; workspaceId: string; userId?: string};
  buildLeaseModeDecisionForTrace(scope: { tenantId: string; workspaceId: string; userId?: string }, traceId: string, holderType: TraceProcessorHolderType, options?: {
    analysisMode?: unknown;
    estimatedSqlMs?: unknown;
    heavySkill?: boolean;
    longTask?: boolean;
    traceSizeBytes?: number;
  }): TraceProcessorLeaseModeDecision;
  startSessionRun(session: TSession, query: string, requestId: string): AnalyzeSessionRunContext | undefined;
  markSessionRunStatus(session: TSession, status: AnalyzeSessionRunContext['status'], error?: string, runId?: string): void;
  isSessionRunCancelled(session: TSession, runId?: string): boolean;
  abortHttpFinalizationRuns(session: TSession, runId?: string): void;
  isStaleRun(session: TSession, runId: string | undefined): boolean;
  settleSessionRunExecution(session: TSession, runId: string): void;
  createHttpRunManifestLifecycle(session: TSession, run: AnalyzeSessionRunContext, options: {
    analysisMode?: AnalyzeMode;
    referenceTraceId?: string;
  }): Promise<RunManifestLifecycle>;
  sealCompletedHttpRunManifest(session: TSession, lifecycle: RunManifestLifecycle, runId: string): void;
  finalizeHttpRunManifestLifecycle(session: TSession, lifecycle: RunManifestLifecycle): void;
  persistSessionRunState(session: TSession, status: PersistedAnalysisRunStatus, error?: string, runId?: string): void;
  assignSessionOwner(session: TSession, context: RequestContext): void;
  requestedSessionIsVisible(sessionId: string, context: RequestContext): boolean;
  resolveVisibleSessionReferenceTraceIdForTrace(sessionId: string | undefined, traceId: string, context: RequestContext): string | undefined;
  buildRecoveredResultFromContext(sessionId: string, context: EnhancedSessionContext): AgentRuntimeAnalysisResult | null;
  ensureToolsRegistered(): void;
  isDedicatedSceneReplayRequest(query: string): boolean;
  runSmartAnalysis(sessionId: string, query: string, traceId: string, options: {
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
    codeAwareMode?: import('../../services/codebase/codeAwareFeature').CodeAwareMode;
    codebaseIds?: string[];
    knowledgeSourceIds?: string[];
    sourceDepth?: NormalizedAnalyzeOptions['sourceDepth'];
    runManifestAttributionSink: RunManifestAttributionSink;
  }): Promise<void>;
  smartSelectionReportId(selection?: SceneAnalysisSelection): string | undefined;
  analyzeOptionsErrorMessage(error: AnalyzeOptionsError, outputLanguage: OutputLanguage): string;
  smartPreviewSelectionErrorMessage(outputLanguage: OutputLanguage, reportId: string): string;
  resolveSmartPreviewReportForSelection(input: {
    session: TSession;
    selection?: SceneAnalysisSelection;
    traceId: string;
    owner: ResourceOwnerFields;
    loadReport?: (reportId: string) => Promise<SceneReport | null>;
  }): Promise<SceneReport | null>;
  runAgentDrivenAnalysis(sessionId: string, query: string, traceId: string,
    options: AnalysisRunExecutionOptions): Promise<void>;
  broadcastToAgentDrivenClients(sessionId: string, update: StreamingUpdate, runId?: string): void;
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

export async function dispatchAnalysisRun<TSession extends AnalysisDispatchSession>(
  input: AnalysisRunDispatchInput,
  deps: AnalysisRunDispatchDependencies<TSession>,
): Promise<AnalysisRunDispatchResponse> {
  const {
    configuredOutputLanguage, sessionOutputLanguage, enterpriseLeasesEnabled,
    leaseScopeFromRequestContext, buildLeaseModeDecisionForTrace, startSessionRun,
    markSessionRunStatus, isSessionRunCancelled, abortHttpFinalizationRuns,
    isStaleRun, settleSessionRunExecution,
    createHttpRunManifestLifecycle, sealCompletedHttpRunManifest, finalizeHttpRunManifestLifecycle,
    persistSessionRunState, assignSessionOwner,
    requestedSessionIsVisible, resolveVisibleSessionReferenceTraceIdForTrace, buildRecoveredResultFromContext,
    ensureToolsRegistered, isDedicatedSceneReplayRequest, runSmartAnalysis,
    smartSelectionReportId, analyzeOptionsErrorMessage, smartPreviewSelectionErrorMessage,
    resolveSmartPreviewReportForSelection, runAgentDrivenAnalysis, broadcastToAgentDrivenClients,
    assistantAppService, httpAnalysisRunLeaseControllers, admittedLocalAnalysisRuns,
  } = deps;
  let response: AnalysisRunDispatchResponse | undefined;
  const respond = (status: number, body: Record<string, unknown>): void => {
    if (response) throw new Error('analysis_dispatch_response_already_sent');
    response = {status, body};
  };
  const respondAnalyzeOptionsError = (error: AnalyzeOptionsError, language: OutputLanguage): void =>
    respond(error.status, publicRequestErrorBody(
      error,
      input.requestId,
      analyzeOptionsErrorMessage(error, language),
    ));
  const ensureTraceAccessible = async (traceId: string, code = 'TRACE_NOT_UPLOADED'): Promise<boolean> => {
    if (await readTraceMetadataForContext(traceId, input.context)) return true;
    respond(404, {success: false, error: 'Trace not found in backend', code});
    return false;
  };
  const sendRunStartConflictIfNeeded = (session?: TSession): boolean => {
    if (!session) return false;
    if (session.cancellationInFlightRunId) {
      respond(409, {success: false, code: 'CANCELLATION_IN_PROGRESS', error: 'The current run is still stopping',
        sessionId: session.sessionId, runId: session.cancellationInFlightRunId});
      return true;
    }
    if (session.sceneExecutionInFlightRunId || session.status === 'awaiting_user' ||
      session.activeRun?.status === 'pending' || session.activeRun?.status === 'running') {
      respond(409, {success: false, code: 'RUN_ALREADY_ACTIVE', error: 'The session already has an active run',
        sessionId: session.sessionId, runId: session.sceneExecutionInFlightRunId ?? session.activeRun?.runId});
      return true;
    }
    return false;
  };
  const dispatch = async (): Promise<void> => {
    let executionSession: TSession | undefined;
    let executionRunId: string | undefined;
    let executionRunManifestLifecycle: RunManifestLifecycle | undefined;
    let executionHandedOff = false;
    let runTraceProcessorLeases: AnalysisRunTraceProcessorLeases | undefined;
    let releaseLeaseOwner = () => {};
    let sceneRunBinding: SceneRunDispatchBinding | undefined;
    let executionSettled = false;
    // Attempt every cleanup even if a binding's release or manifest persistence fails.
    const finishExecution = async (): Promise<void> => {
      if (executionSettled) return;
      executionSettled = true;
      const session = executionSession;
      const runId = executionRunId;
      const logCleanupFailure = (label: string, error: unknown): void => {
        // Logging failures must not strand execution ownership or leases either.
        try { session?.logger.error('AnalysisRunDispatch', `Failed to ${label}`, error); } catch {}
      };
      const cleanup = (label: string, operation: () => void): void => {
        try { operation(); } catch (error) { logCleanupFailure(label, error); }
      };
      if (session && executionRunManifestLifecycle) {
        cleanup('finalize run manifest', () => finalizeHttpRunManifestLifecycle(session, executionRunManifestLifecycle!));
      }
      // Some runtimes remove session-scoped resources only after awaiting abort.
      // Keep the session and its leases owned until that cleanup has settled.
      if (sceneRunBinding) {
        const binding = sceneRunBinding;
        sceneRunBinding = undefined;
        try { await binding.release(); } catch (error) { logCleanupFailure('release scene runtime', error); }
      }
      cleanup('release run leases', releaseLeaseOwner);
      if (session && runId) cleanup('settle run execution', () => settleSessionRunExecution(session, runId));
      if (session && runId && session.sceneExecutionInFlightRunId === runId) {
        session.sceneExecutionInFlightRunId = undefined;
      }
    };
    try {
      const requestId = input.requestId;
      const requestContext = input.context;
      const {
        traceId,
        query,
        sessionId: bodyRequestedSessionId,
        options: rawOptionsValue = {},
        selectionContext: rawSelectionContext,
        referenceTraceId,
        traceContext: rawTraceContext,
        providerId,
      } = input.body;
      const rawOptions = rawOptionsValue as Record<string, unknown>;
      const requestedSessionId = input.requestedSessionIdOverride || bodyRequestedSessionId;
      const earlyOutputLanguage: OutputLanguage = rawOptions &&
        typeof rawOptions === 'object' &&
        !Array.isArray(rawOptions) &&
        (rawOptions.outputLanguage === 'en' || rawOptions.outputLanguage === 'zh-CN')
        ? rawOptions.outputLanguage
        : configuredOutputLanguage();
      if (!hasRbacPermission(requestContext, 'agent:run')) {
        respond(403, {success: false, error: 'Forbidden', details: 'Starting analysis requires agent:run permission'});
        return;
      }

      assertAiFeatureEnabled(input.entry === 'scene_reconstruction' ? 'scene_reconstruct_start' : 'agent_analyze');

      const tenantDecision = evaluateTenantMutationPolicy(requestContext);
      if (!tenantDecision.allowed) {
        respond(tenantDecision.httpStatus, sendTenantMutationDeniedPayload(tenantDecision));
        return;
      }

      if (!traceId) {
        respond(400, {
          success: false,
          code: 'TRACE_ID_REQUIRED',
          error: localize(earlyOutputLanguage, '缺少 traceId', 'traceId is required'),
        });
        return;
      }

      if (!query) {
        respond(400, {
          success: false,
          code: 'QUERY_REQUIRED',
          error: localize(earlyOutputLanguage, '缺少 query', 'query is required'),
        });
        return;
      }

      if (input.entry === 'analysis' && isDedicatedSceneReplayRequest(query)) {
        respond(400, {
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
          endpoint: input.requestedSessionIdOverride ? '/sessions/:id/runs' : '/analyze',
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
          respondAnalyzeOptionsError(error, requestedErrorLanguage);
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
        respond(analysisContextAuthorization.httpStatus, analysisContextAuthorization.payload);
        return;
      }
      if (input.entry === 'scene_reconstruction' && (!deps.sceneRunHooks || options.preset === 'smart')) {
        respond(503, {success: false, code: 'SCENE_DISPATCH_NOT_CONFIGURED', error: 'Scene investigation dispatch is not configured'});
        return;
      }
      const authorizedCodebaseSelection =
        options.codeAwareMode &&
        options.codeAwareMode !== 'off' &&
        options.codebaseIds?.length
          ? {
              codeAwareMode: options.codeAwareMode,
              codebaseIds: [...options.codebaseIds],
            }
          : undefined;

      if (requestedSessionId && !requestedSessionIsVisible(requestedSessionId, requestContext)) {
        respond(404, {success: false, error: 'Session not found'});
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
            session: (liveRequestedSession ?? {sceneStoryReport: undefined}) as TSession,
            selection: options.smartSelection,
            traceId,
            owner: ownerFieldsFromContext(requestContext),
          }) ?? undefined;
        } catch (error) {
          if (error instanceof SmartPreviewSelectionError) {
            respond(409, {
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
          respondAnalyzeOptionsError(error, requestOutputLanguage);
          return;
        }
        throw error;
      }

      // Verify trace exists
      const traceProcessorService = getTraceProcessorService();
      if (!(await ensureTraceAccessible(traceId))) {
        return;
      }
      const trace = await traceProcessorService.getOrLoadTrace(traceId);
      if (!trace) {
        respond(404, {
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
          respond(400, {
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
          candidateReferenceTraceId,
          'REFERENCE_TRACE_NOT_UPLOADED',
        ))) {
          return null;
        }
        const refTrace = await traceProcessorService.getOrLoadTrace(candidateReferenceTraceId);
        if (!refTrace) {
          respond(404, {
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
        respond(quotaDecision.httpStatus, {success: false, code: quotaDecision.code, status: quotaDecision.status, error: quotaDecision.message, details: quotaDecision.details});
        return;
      }

      // Initialize tools
      ensureToolsRegistered();

      const analyzeSessionService = new AgentAnalyzeSessionService<TSession>({
        assistantAppService,
        createSessionLogger,
        sessionPersistenceService: SessionPersistenceService.getInstance(),
        buildRecoveredResultFromContext,
        onSessionSecurityCleanup: sessionId => {
          revokeCodeAwareOutputGuards(sessionId);
          const active = assistantAppService.getSession(sessionId);
          if (active) abortHttpFinalizationRuns(active);
        },
      });

      let sessionId: string;
      let preparedSession: TSession | undefined;
      let isNewSession = true;
      let analysisContextFingerprint: string;
      if (sendRunStartConflictIfNeeded(liveRequestedSession)) return;
      try {
        analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(
          options,
          knowledgeScopeFromRequestContext(requestContext),
        );
        options = {...options, analysisContextFingerprint} as ReturnType<typeof normalizeAnalyzeOptions>;
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
        // A prepared session carries the fingerprint it was prepared under.
        preparedSession = prepared.session as TSession;
        preparedSession.androidInternalsPackPin ??=
          (options as AnalysisOptions).androidInternalsPackPin;
        (options as AnalysisOptions).androidInternalsPackPin =
          preparedSession.androidInternalsPackPin;
        isNewSession = prepared.isNewSession;
        if (isNewSession) {
          assignSessionOwner(preparedSession, requestContext);
        } else if (!isOwnedByContext(preparedSession, requestContext)) {
          respond(404, {success: false, error: 'Session not found'});
          return;
        }
      } catch (error: any) {
        if (error instanceof AnalyzeSessionPreparationError) {
          respond(error.httpStatus, {
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
          ...(input.entry === 'analysis' ? deps.blockedSceneStrategyIds : []),
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
      sessionForRun.sourceAuthorization = authorizedCodebaseSelection
        ? {
            ...authorizedCodebaseSelection,
            analysisContextFingerprint,
          }
        : undefined;
      sessionForRun.codeAwareMode = options.codeAwareMode;
      sessionForRun.codebaseIds = Array.isArray(options.codebaseIds) ? options.codebaseIds : undefined;
      sessionForRun.knowledgeSourceIds = Array.isArray(options.knowledgeSourceIds)
        ? options.knowledgeSourceIds
        : undefined;
      if (analysisHasPrivateContext(sessionForRun)) {
        registerPrivateAnalysisQueryForEcho(sessionId, query);
      }
      if (validatedSmartPreviewReport) {
        sessionForRun.sceneStoryReport = validatedSmartPreviewReport;
      }

      if (sendRunStartConflictIfNeeded(sessionForRun)) return;
      const runContext = startSessionRun(sessionForRun, query, requestId);
      if (!runContext) {
        sendRunStartConflictIfNeeded(sessionForRun);
        return;
      }
      executionSession = sessionForRun;
      executionRunId = runContext.runId;
      if (input.entry === 'scene_reconstruction') sessionForRun.sceneExecutionInFlightRunId = runContext.runId;
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

      const leaseController = new AbortController();
      const leaseControllers = httpAnalysisRunLeaseControllers.get(sessionForRun) ?? new Map<string, AbortController>();
      httpAnalysisRunLeaseControllers.set(sessionForRun, leaseControllers);
      leaseControllers.set(runContext.runId, leaseController);
      let leaseOwnerReleased = false;
      releaseLeaseOwner = () => {
        if (leaseOwnerReleased) return;
        leaseOwnerReleased = true;
        try { runTraceProcessorLeases?.release(); } finally {
          if (leaseControllers.get(runContext.runId) === leaseController) leaseControllers.delete(runContext.runId);
        }
      };
      try {
        runTraceProcessorLeases = await prepareAnalysisRunTraceProcessorLeases({
          service: traceProcessorService, scope: leaseScopeFromRequestContext(requestContext),
          runId: runContext.runId, sessionId, currentTraceId: traceId, referenceTraceId: effectiveReferenceTraceId,
          signal: leaseController.signal,
          assertCurrent: () => {
            if (assistantAppService.getSession(sessionId) !== sessionForRun ||
              isSessionRunCancelled(sessionForRun, runContext.runId) || isStaleRun(sessionForRun, runContext.runId)) {
              throw new DOMException('Analysis run is no longer current', 'AbortError');
            }
          },
          onInvalidated: () => abortHttpFinalizationRuns(sessionForRun, runContext.runId),
          metadata: {requestId: runContext.requestId, runSequence: runContext.sequence},
          ...(enterpriseLeasesEnabled() ? {decideMode: (selectedTrace: {id: string; size: number}) =>
            buildLeaseModeDecisionForTrace(leaseScopeFromRequestContext(requestContext), selectedTrace.id, 'agent_run', {
              analysisMode: options.analysisMode, traceSizeBytes: selectedTrace.size,
            })} : {}),
        });
        runTraceProcessorLeases.assertCurrent();
        if (!resolveFeatureConfig().enterprise) {
          const admittedRuns = admittedLocalAnalysisRuns.get(sessionForRun) ?? new Set<string>();
          admittedRuns.add(runContext.runId);
          admittedLocalAnalysisRuns.set(sessionForRun, admittedRuns);
          persistSessionRunState(sessionForRun, 'pending', undefined, runContext.runId);
        }
      } catch (leaseError: any) {
        if (leaseController.signal.aborted || isSessionRunCancelled(sessionForRun, runContext.runId) ||
          isStaleRun(sessionForRun, runContext.runId)) {
          respond(200, {success: false, status: 'cancelled', sessionId, runId: runContext.runId});
          return;
        }
        sessionForRun.status = 'failed';
        sessionForRun.error = leaseError.message;
        markSessionRunStatus(sessionForRun, 'failed', leaseError.message, runContext.runId);
        const admission = leaseError instanceof TraceProcessorAdmissionError;
        respond(admission ? 503 : 409, {success: false,
          code: admission ? 'TRACE_PROCESSOR_RAM_BUDGET_EXCEEDED' : leaseError.code ??
            (analysisRunTraceProcessorFailureSide(leaseError) === 'reference'
              ? 'REFERENCE_TRACE_PROCESSOR_LEASE_UNAVAILABLE' : 'TRACE_PROCESSOR_LEASE_UNAVAILABLE'),
          error: leaseError.message, ...(admission ? {details: leaseError.decision} : {}),
        });
        return;
      }
      const leases = runTraceProcessorLeases;
      if (input.entry === 'scene_reconstruction') {
        sceneRunBinding = await deps.sceneRunHooks!.onAdmitted({session: sessionForRun,
          run: runContext, traceId, requestContext, signal: leaseController.signal,
          assertCurrent: () => leases.assertCurrent()});
        leases.assertCurrent();
      }
      // Keep legacy enterprise response metadata; personal private processor identities stay internal.
      const currentLeaseEntry = enterpriseLeasesEnabled() ? leases.entries.find(entry => entry.side === 'current') : undefined;
      const referenceLeaseEntry = enterpriseLeasesEnabled() ? leases.entries.find(entry => entry.side === 'reference') : undefined;
      const agentRunLease = currentLeaseEntry?.lease;
      const referenceAgentRunLease = referenceLeaseEntry?.lease;
      const agentRunLeaseDecision = currentLeaseEntry?.decision;
      const referenceAgentRunLeaseDecision = referenceLeaseEntry?.decision;

      const handleExecutionFailure = (error: unknown): void => {
        const session = assistantAppService.getSession(sessionId);
        if (!session || session !== sessionForRun || isSessionRunCancelled(session, runContext.runId) ||
          isStaleRun(session, runContext.runId)) return;
        // Runtime owns publication once it has claimed a terminal run. This outer
        // handler covers startup failures, without producing a second error event.
        if (session.activeRun?.runId === runContext.runId &&
          ['completed', 'failed', 'cancelled', 'quota_exceeded'].includes(session.activeRun.status)) return;
        const privateKnowledge = privateContextRestrictsAudience(runContext.privateContext);
        const publicErrorMessage = privateKnowledge
          ? projectOwnerAnalysisError(sessionId, error, sessionOutputLanguage(session))
          : error instanceof Error ? error.message : String(error);
        session.logger.error('AgentRoutes', 'Analysis failed', privateKnowledge
          ? new Error(privateAnalysisFailureMessage(sessionOutputLanguage(session))) : error);
        session.status = 'failed';
        session.error = publicErrorMessage;
        markSessionRunStatus(session, 'failed', publicErrorMessage, runContext.runId);
        broadcastToAgentDrivenClients(sessionId, {type: 'error',
          content: {message: publicErrorMessage, error: publicErrorMessage}, timestamp: Date.now()}, runContext.runId);
      };

      if (options.preset === 'smart') {
        const smartAnalysisPromise = withRunManifestLifecycle(
          runManifestLifecycle,
          () => leases.run(() => runSmartAnalysis(sessionId, query, traceId, {
            runContext,
            traceProcessorService,
            smartAction: options.smartAction ?? 'preview',
            smartSelection: options.smartSelection,
            forceRefresh: options.forceRefresh === true,
            providerId: sessionForRun.providerId,
            analysisContextFingerprint: sessionForRun.analysisContextFingerprint,
            analysisMode: options.analysisMode,
            blockedStrategyIds,
            owner: ownerFieldsFromContext(requestContext),
            knowledgeScope: knowledgeScopeFromRequestContext(requestContext),
            codeAwareMode: options.codeAwareMode,
            codebaseIds: options.codebaseIds,
            knowledgeSourceIds: options.knowledgeSourceIds,
            sourceDepth: options.sourceDepth,
            runManifestAttributionSink: runManifestLifecycle.builder,
          })),
        )
          .then(() => {
            sealCompletedHttpRunManifest(
              sessionForRun,
              runManifestLifecycle,
              runContext.runId,
            );
          })
          .catch(handleExecutionFailure);
        executionHandedOff = true;
        void smartAnalysisPromise.then(finishExecution, finishExecution);

        respond(200, {
          success: true,
          sessionId,
          message: 'Smart analysis started',
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
          () => leases.run(() => runAgentDrivenAnalysis(sessionId, query, traceId, {
            ...options,
            selectionContext,
            blockedStrategyIds,
            traceProcessorService,
            runContext,
            referenceTraceId: effectiveReferenceTraceId,
            traceContext: traceContext && traceContext.length > 0 ? traceContext : undefined,
            providerId: sessionForRun.providerId !== undefined ? sessionForRun.providerId : providerId,
            ...(sceneRunBinding ? {sceneRunBinding} : {}),
            knowledgeScope: knowledgeScopeFromRequestContext(requestContext),
            runManifestAttributionSink: runManifestLifecycle.builder,
          })),
        )
          .then(() => {
            sealCompletedHttpRunManifest(
              sessionForRun,
              runManifestLifecycle,
              runContext.runId,
            );
          })
          .catch(handleExecutionFailure);
      }
      executionHandedOff = true;
      void analysisPromise.then(finishExecution, finishExecution);

      respond(200, {
        success: true,
        sessionId,
        message: preparedSession?.providerSnapshotChanged
          ? 'Provider configuration changed; continuing the session with the new provider'
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
        leaseQueueLength: agentRunLeaseDecision?.signals?.sharedQueueLength,
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
      if (executionSession && executionRunId && !executionHandedOff) {
        if (isSessionRunCancelled(executionSession, executionRunId) || isStaleRun(executionSession, executionRunId)) {
          respond(200, {success: false, status: 'cancelled', sessionId: executionSession.sessionId, runId: executionRunId});
          return;
        }
        executionSession.status = 'failed';
        executionSession.error = error?.message || 'Agent analysis failed';
        markSessionRunStatus(executionSession, 'failed', executionSession.error, executionRunId);
      }
      if (error instanceof AiDisabledError) {
        respond(403, buildAiDisabledPayload(error));
        return;
      }
      console.error('[AgentRoutes] Analyze error:', error);
      respond(500, {
        success: false,
        error: error.message || 'Agent analysis failed',
      });
    } finally {
      if (!executionHandedOff) await finishExecution();
    }

  };
  await dispatch();
  if (!response) throw new Error('analysis_dispatch_response_missing');
  return response;
}
