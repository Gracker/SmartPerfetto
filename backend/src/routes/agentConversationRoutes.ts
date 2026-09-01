// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type express from 'express';

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import {createAgentOrchestrator} from '../agentRuntime';
import {
  ConversationSessionService,
  type ConversationRun,
  type ConversationSession,
  type ConversationTraceContext,
} from '../assistant/application/conversationSessionService';
import {OrchestratorConversationRuntimeAdapter} from '../assistant/runtime/orchestratorConversationRuntimeAdapter';
import {agentSessionConfig} from '../config';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
  requireRequestContext,
} from '../middleware/auth';
import {getDefaultAndroidInternalsPackResolver} from '../services/androidInternalsPack/androidInternalsPackResolver';
import {authorizeAnalysisContext} from '../services/analysisContextAuthorization';
import {
  heartbeatAnalysisRun,
  persistAnalysisRunState,
  type AnalysisRunPersistenceScope,
  type PersistedAnalysisRunStatus,
} from '../services/analysisRunStore';
import {evaluateAnalysisRunQuota, type EnterpriseQuotaDecision} from '../services/enterpriseQuotaPolicyService';
import {
  evaluateTenantMutationPolicy,
  sendTenantMutationDeniedPayload,
} from '../services/enterpriseTenantLifecycleService';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {
  isOwnedByContext,
  ownerFieldsFromContext,
  sendResourceNotFound,
} from '../services/resourceOwnership';
import {buildAnalysisContextAuthorizationFingerprint} from '../services/resolvedAnalysisContext';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import {
  privateAnalysisFailureMessage,
  privateAnalysisQueryMessage,
} from '../services/security/privateAnalysisProjection';
import {readTraceMetadataForContext} from '../services/traceMetadataStore';
import {getTraceProcessorService} from '../services/traceProcessorService';
import {getProviderService, type ProviderScope} from '../services/providerManager';
import {resolveProviderRuntimeSnapshot} from '../services/providerManager/providerSnapshot';
import {parseOutputLanguage, type OutputLanguage} from '../agentv3/outputLanguage';
import {requireAiEnabledForHttp} from './aiCapabilityPolicyHttp';
import {AnalyzeOptionsError, normalizeAnalyzeOptions} from './agent/normalizeAnalyzeOptions';
import {resolvePrimaryConversationSourceUse} from '../assistant/runtime/conversationSourcePolicy';

const CONVERSATION_RUN_HEARTBEAT_MS = 30_000;
const heartbeatTimers = new Map<string, NodeJS.Timeout>();

export function shouldCloseConversationStream(input: {
  eventType?: string;
  enrichmentPending?: boolean;
  replay?: boolean;
  primarySettled?: boolean;
  enrichmentStatus?: 'running' | 'completed' | 'failed' | 'cancelled';
}): boolean {
  if (input.replay) {
    if (!input.primarySettled) return false;
    return input.enrichmentStatus !== 'running';
  }
  if (input.eventType === 'run_completed') return input.enrichmentPending !== true;
  return input.eventType === 'run_failed' ||
    input.eventType === 'source_enrichment_completed' ||
    input.eventType === 'source_enrichment_failed' ||
    input.eventType === 'source_enrichment_cancelled';
}

export function conversationRunUsesPrivateKnowledge(
  session: Pick<ConversationSession, 'codeAwareMode' | 'codebaseIds' | 'knowledgeSourceIds'>,
  run: Pick<ConversationRun, 'sourceUseMode'>,
): boolean {
  return Boolean(
    session.knowledgeSourceIds?.length ||
    (
      run.sourceUseMode === 'explicit' &&
      session.codeAwareMode &&
      session.codeAwareMode !== 'off' &&
      session.codebaseIds?.length
    ),
  );
}

function configuredOutputLanguage(): OutputLanguage {
  return parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

function sendQuotaDenied(
  res: express.Response,
  decision: EnterpriseQuotaDecision,
): express.Response {
  return res.status(decision.httpStatus).json({
    success: false,
    code: decision.code,
    status: decision.status,
    error: decision.message,
    details: decision.details,
  });
}

function runScope(
  session: ConversationSession,
  run: ConversationRun,
): AnalysisRunPersistenceScope {
  return {
    tenantId: session.tenantId ?? DEFAULT_TENANT_ID,
    workspaceId: session.workspaceId ?? DEFAULT_WORKSPACE_ID,
    userId: session.userId,
    sessionId: session.sessionId,
    runId: run.runId,
    traceId: session.traceContext.kind === 'attached'
      ? session.traceContext.traceId
      : `conversation-no-trace:${session.sessionId}`,
    query: conversationRunUsesPrivateKnowledge(session, run)
      ? privateAnalysisQueryMessage(session.outputLanguage ?? configuredOutputLanguage())
      : run.query,
    mode: 'conversation',
  };
}

function settleRun(session: ConversationSession, run: ConversationRun): void {
  const timer = heartbeatTimers.get(run.runId);
  if (timer) clearInterval(timer);
  heartbeatTimers.delete(run.runId);
  const status: PersistedAnalysisRunStatus = run.status === 'cancelled'
    ? 'cancelled'
    : run.status === 'failed'
      ? 'failed'
      : run.outcome?.kind === 'needs_user_input'
        ? 'awaiting_user'
        : 'completed';
  const error = run.error && conversationRunUsesPrivateKnowledge(session, run)
    ? privateAnalysisFailureMessage(session.outputLanguage ?? configuredOutputLanguage())
    : run.error;
  persistAnalysisRunState(runScope(session, run), status, {error});
}

const conversationSessionService = new ConversationSessionService({
  createRuntime: input => {
    const providerScope = input.owner
      ? {
          tenantId: input.owner.tenantId,
          workspaceId: input.owner.workspaceId,
          userId: input.owner.userId,
        }
      : undefined;
    const orchestrator = createAgentOrchestrator({
      traceProcessorService: getTraceProcessorService(),
      providerId: input.providerId,
      providerScope,
    });
    return new OrchestratorConversationRuntimeAdapter(orchestrator, {
      analysisOptions: {
        ...input.runtimeOptions,
        providerId: input.providerId,
        ...(providerScope ?? {}),
      },
    });
  },
  onRunStarted: (session, run) => {
    const scope = runScope(session, run);
    persistAnalysisRunState(scope, 'running');
    const timer = setInterval(() => heartbeatAnalysisRun(scope), CONVERSATION_RUN_HEARTBEAT_MS);
    timer.unref?.();
    heartbeatTimers.set(run.runId, timer);
  },
  onRunSettled: settleRun,
});

async function ensureTraceAccessible(
  req: express.Request,
  res: express.Response,
  traceId: string,
): Promise<boolean> {
  const metadata = await readTraceMetadataForContext(traceId, requireRequestContext(req));
  if (metadata) return true;
  res.status(404).json({
    success: false,
    code: 'TRACE_NOT_UPLOADED',
    error: 'Trace not found in backend',
  });
  return false;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function requireConversationRunPermission(
  req: express.Request,
  res: express.Response,
): ReturnType<typeof requireRequestContext> | undefined {
  const requestContext = requireRequestContext(req);
  if (!hasRbacPermission(requestContext, 'agent:run')) {
    sendForbidden(res, 'Conversation access requires agent:run permission');
    return undefined;
  }
  return requestContext;
}

async function startConversation(req: express.Request, res: express.Response): Promise<void> {
  let privateKnowledge = false;
  let failureLanguage = configuredOutputLanguage();
  try {
    const requestContext = requireConversationRunPermission(req, res);
    if (!requestContext) return;
    if (!requireAiEnabledForHttp(res, 'agent_analyze')) return;
    const tenantDecision = evaluateTenantMutationPolicy(requestContext);
    if (!tenantDecision.allowed) {
      res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
      return;
    }

    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({success: false, code: 'QUERY_REQUIRED', error: 'query is required'});
      return;
    }
    if (query.length > 50_000) {
      res.status(413).json({success: false, code: 'QUERY_TOO_LARGE', error: 'query is too large'});
      return;
    }
    const requestedSessionId = typeof req.body?.sessionId === 'string'
      ? req.body.sessionId.trim()
      : '';
    const traceId = typeof req.body?.traceId === 'string' ? req.body.traceId.trim() : '';
    const providerId = req.body?.providerId === null
      ? null
      : typeof req.body?.providerId === 'string'
        ? req.body.providerId.trim()
        : undefined;
    const options = normalizeAnalyzeOptions(
      {...(req.body?.options ?? {}), analysisMode: 'fast'},
      {endpoint: '/analyze', hasReferenceTraceId: false, ...(traceId ? {traceId} : {})},
    );
    failureLanguage = options.outputLanguage ?? configuredOutputLanguage();
    const analysisContextAuthorization = authorizeAnalysisContext({
      selection: options,
      scope: knowledgeScopeFromRequestContext(requestContext),
      outputLanguage: failureLanguage,
      canReadRegisteredContext: hasRbacPermission(requestContext, 'codebase:read'),
    });
    if (!analysisContextAuthorization.allowed) {
      res.status(analysisContextAuthorization.httpStatus)
        .json(analysisContextAuthorization.payload);
      return;
    }
    privateKnowledge = Boolean(
      options.knowledgeSourceIds?.length ||
      (
        options.codebaseIds?.length &&
        resolvePrimaryConversationSourceUse({
          query,
          hasAuthorizedCodebase: true,
        }) === 'explicit'
      ),
    );
    const analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(
      options,
      knowledgeScopeFromRequestContext(requestContext),
    );
    const existing = requestedSessionId
      ? conversationSessionService.getSession(requestedSessionId)
      : undefined;
    if (requestedSessionId && !existing) {
      sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
      return;
    }
    if (existing && !isOwnedByContext(existing, requestContext)) {
      sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
      return;
    }
    if (existing && providerId !== undefined && existing.providerId !== providerId) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_PROVIDER_CHANGED',
        error: 'Start a new conversation after changing the AI provider',
      });
      return;
    }
    if (existing?.outputLanguage && existing.outputLanguage !== failureLanguage) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_LANGUAGE_CHANGED',
        error: 'Start a new conversation after changing the output language',
      });
      return;
    }
    if (
      existing?.analysisContextFingerprint &&
      existing.analysisContextFingerprint !== analysisContextFingerprint
    ) {
      res.status(409).json({
        success: false,
        code: 'ANALYSIS_CONTEXT_CHANGED_RESTART_REQUIRED',
        error: 'Start a new conversation after changing authorized sources',
      });
      return;
    }

    const effectiveTraceContext: ConversationTraceContext = traceId
      ? {kind: 'attached', traceId}
      : existing?.traceContext ?? {kind: 'none'};
    if (
      existing &&
      (existing.traceContext.kind !== effectiveTraceContext.kind ||
        (existing.traceContext.kind === 'attached' &&
          effectiveTraceContext.kind === 'attached' &&
          existing.traceContext.traceId !== effectiveTraceContext.traceId))
    ) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_TRACE_CHANGED',
        error: 'Start a new conversation after changing the attached Trace',
      });
      return;
    }
    if (effectiveTraceContext.kind === 'attached') {
      if (!(await ensureTraceAccessible(req, res, effectiveTraceContext.traceId))) return;
      if (!(await getTraceProcessorService().getOrLoadTrace(effectiveTraceContext.traceId))) {
        res.status(404).json({
          success: false,
          code: 'TRACE_NOT_UPLOADED',
          error: 'Trace not found in backend',
        });
        return;
      }
    }

    const runtimeOptions: AnalysisOptions = {
      outputLanguage: failureLanguage,
      codeAwareMode: options.codeAwareMode,
      codebaseIds: options.codebaseIds,
      knowledgeSourceIds: options.knowledgeSourceIds,
      selectionContext: options.selectionContext,
      analysisContextFingerprint,
    };
    const availablePack = getDefaultAndroidInternalsPackResolver().resolve();
    if (availablePack) {
      runtimeOptions.androidInternalsPackPin = {
        contentVersion: availablePack.contentVersion,
        contentFingerprint: availablePack.contentFingerprint,
        sourceRevision: availablePack.sourceRevision,
      };
    }
    const quotaDecision = evaluateAnalysisRunQuota(requestContext, {
      replacingRunId: existing?.activeRun?.runId,
    });
    if (!quotaDecision.allowed) {
      sendQuotaDenied(res, quotaDecision);
      return;
    }
    if (existing?.activeRun) {
      await conversationSessionService.cancelRun(existing.sessionId, existing.activeRun.runId);
    }
    if (existing) {
      await conversationSessionService.cancelSourceEnrichments(existing.sessionId);
    }
    // Resolve immediately before the synchronous startTurn boundary. Any
    // awaited Trace load or cancellation above may have allowed a Provider
    // mutation request to run in the same process.
    const providerScope: ProviderScope = {
      tenantId: requestContext.tenantId,
      workspaceId: requestContext.workspaceId,
      userId: requestContext.userId,
    };
    const providerService = getProviderService();
    const activeProviderId = providerService.getRawEffectiveProvider(providerScope)?.id ?? null;
    const providerFollowsActive = existing
      ? existing.providerFollowsActive ?? true
      : providerId === undefined;
    const effectiveProviderId = existing
      ? existing.providerId !== undefined
        ? existing.providerId
        : activeProviderId
      : providerId !== undefined
        ? providerId
        : activeProviderId;
    if (existing && providerFollowsActive && effectiveProviderId !== activeProviderId) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_PROVIDER_CHANGED',
        error: 'Start a new conversation after changing the active AI provider',
      });
      return;
    }
    let providerPin: ReturnType<typeof resolveProviderRuntimeSnapshot>;
    try {
      providerPin = resolveProviderRuntimeSnapshot(
        providerService,
        effectiveProviderId,
        undefined,
        providerScope,
      );
    } catch (error) {
      res.status(404).json({
        success: false,
        code: 'PROVIDER_NOT_FOUND',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      existing?.providerSnapshotHash &&
      existing.providerSnapshotHash !== providerPin.snapshotHash
    ) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_PROVIDER_SNAPSHOT_CHANGED',
        error: 'Start a new conversation after changing the AI provider configuration',
      });
      return;
    }
    const turnInput = {
      query,
      ...(requestedSessionId ? {sessionId: requestedSessionId} : {}),
      traceContext: effectiveTraceContext,
      owner: ownerFieldsFromContext(requestContext),
      providerId: effectiveProviderId,
      providerFollowsActive,
      runtimeKind: providerPin.snapshot.runtimeKind,
      providerSnapshotHash: providerPin.snapshotHash,
      runtimeOptions,
      analysisContextFingerprint,
    };
    const receipt = conversationSessionService.startTurn(turnInput);
    void receipt.completion.catch(() => undefined);
    res.status(202).json({
      success: true,
      sessionId: receipt.sessionId,
      runId: receipt.runId,
      isNewSession: receipt.isNewSession,
      traceContextAttached: turnInput.traceContext.kind === 'attached',
      status: 'running',
    });
  } catch (error: unknown) {
    if (error instanceof AnalyzeOptionsError) {
      res.status(error.httpStatus).json({
        success: false,
        code: error.code,
        error: error.message,
        ...(error.details ? {details: error.details} : {}),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : /in progress|cancellation/i.test(message) ? 409 : 500).json({
      success: false,
      error: privateKnowledge ? privateAnalysisFailureMessage(failureLanguage) : message,
    });
  }
}

function streamConversation(req: express.Request, res: express.Response): void {
  const requestContext = requireConversationRunPermission(req, res);
  if (!requestContext) return;
  const session = conversationSessionService.getSession(routeParam(req.params.sessionId));
  if (!session || !isOwnedByContext(session, requestContext)) {
    sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
    return;
  }
  const runId = typeof req.query.runId === 'string' ? req.query.runId.trim() : '';
  const run = session.runs.find(candidate => candidate.runId === runId);
  if (!run) {
    sendResourceNotFound(res, 'Conversation run not found');
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  session.sseClients.push(res);

  let closed = false;
  let replaying = true;
  const pendingLiveEvents: typeof run.events = [];
  const lastEventIdValue = req.header('last-event-id') ?? req.query.lastEventId;
  const parsedLastEventId = Number(lastEventIdValue);
  let lastSentSeqId = Number.isSafeInteger(parsedLastEventId) && parsedLastEventId >= 0
    ? parsedLastEventId
    : 0;
  const send = (type: string, payload: unknown) => {
    if (!closed && !res.writableEnded) {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  };
  const sendRunEvent = (event: (typeof run.events)[number]) => {
    if (event.seqId <= lastSentSeqId) return;
    lastSentSeqId = event.seqId;
    if (!closed && !res.writableEnded) {
      res.write(`id: ${event.seqId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    const index = session.sseClients.indexOf(res);
    if (index >= 0) session.sseClients.splice(index, 1);
    if (!res.writableEnded) res.end();
  };
  const unsubscribe = conversationSessionService.subscribe(session.sessionId, event => {
    if (event.runId !== runId) return;
    if (replaying) {
      pendingLiveEvents.push(event);
      return;
    }
    sendRunEvent(event);
    if (shouldCloseConversationStream({
      eventType: event.type,
      enrichmentPending: event.type === 'run_completed'
        ? event.enrichmentPending
        : undefined,
    })) close();
  });
  const heartbeat = setInterval(() => send('heartbeat', {timestamp: Date.now()}), 15_000);
  heartbeat.unref?.();
  req.on('close', close);
  send('connected', {sessionId: session.sessionId, runId, status: run.status});
  for (const event of [...run.events].sort((left, right) => left.seqId - right.seqId)) {
    sendRunEvent(event);
  }
  replaying = false;
  for (const event of pendingLiveEvents.sort((left, right) => left.seqId - right.seqId)) {
    sendRunEvent(event);
  }
  if (shouldCloseConversationStream({
    replay: true,
    primarySettled: Boolean(run.outcome || run.error),
    enrichmentStatus: run.sourceEnrichment?.status ?? (
      run.sourceEnrichmentPending ? 'running' : undefined
    ),
  })) close();
}

async function cancelConversation(req: express.Request, res: express.Response): Promise<void> {
  try {
    const requestContext = requireConversationRunPermission(req, res);
    if (!requestContext) return;
    const session = conversationSessionService.getSession(routeParam(req.params.sessionId));
    if (!session || !isOwnedByContext(session, requestContext)) {
      sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
      return;
    }
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    if (!runId) {
      res.status(400).json({success: false, code: 'RUN_ID_REQUIRED', error: 'runId is required'});
      return;
    }
    const outcome = await conversationSessionService.cancelRun(session.sessionId, runId);
    res.json({success: true, sessionId: session.sessionId, runId, status: outcome.kind});
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : 409).json({success: false, error: message});
  }
}

function getFullHandoff(req: express.Request, res: express.Response): void {
  const requestContext = requireConversationRunPermission(req, res);
  if (!requestContext) return;
  const session = conversationSessionService.getSession(routeParam(req.params.sessionId));
  if (!session || !isOwnedByContext(session, requestContext)) {
    sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
    return;
  }
  const handoff = conversationSessionService.buildFullAnalysisHandoff(session.sessionId);
  if (!handoff) {
    res.status(409).json({success: false, code: 'FULL_ANALYSIS_NOT_RECOMMENDED'});
    return;
  }
  res.json({success: true, sessionId: session.sessionId, handoff});
}

export function registerAgentConversationRoutes(router: express.Router): void {
  router.post('/conversation', (req, res) => void startConversation(req, res));
  router.get('/conversation/:sessionId/stream', streamConversation);
  router.post('/conversation/:sessionId/cancel', (req, res) => void cancelConversation(req, res));
  router.get('/conversation/:sessionId/full-handoff', getFullHandoff);
}

export function cleanupIdleAgentConversationSessions(): string[] {
  return conversationSessionService.cleanupIdleSessions({
    terminalMaxIdleMs: agentSessionConfig.terminalMaxIdleMs,
    nonTerminalMaxIdleMs: agentSessionConfig.nonTerminalMaxIdleMs,
  });
}
