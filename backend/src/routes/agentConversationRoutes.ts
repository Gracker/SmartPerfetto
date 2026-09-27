// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type express from 'express';

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import {createAgentOrchestrator} from '../agentRuntime';
import {toAnalysisHistoryTurn} from '../agentRuntime/analysisHistory';
import {getConversationSessionStore, type ConversationSessionDescriptor} from '../services/conversationSessionStore';
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
import {assertCurrentAnalysisContextAuthorization, buildAnalysisContextAuthorizationFingerprint} from '../services/resolvedAnalysisContext';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import {
  projectOwnerAnalysisError,
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

function sessionDescriptor(session: ConversationSession, run: ConversationRun): ConversationSessionDescriptor {
  if (!session.tenantId || !session.workspaceId || !session.userId || !session.runtimeKind ||
    !session.providerSnapshotHash || !session.analysisContextFingerprint || session.providerId === undefined) {
    throw new Error('conversation_recovery_context_missing');
  }
  const {finalResult: _result, recoveryStatus: _recovery, ...outcome} = run.outcome ?? {kind: 'cancelled' as const, message: ''};
  return {version: 1, sessionId: session.sessionId, tenantId: session.tenantId, workspaceId: session.workspaceId,
    userId: session.userId, traceContext: session.traceContext, providerId: session.providerId,
    providerFollowsActive: session.providerFollowsActive ?? true, runtimeKind: session.runtimeKind,
    providerSnapshotHash: session.providerSnapshotHash, analysisContextFingerprint: session.analysisContextFingerprint,
    outputLanguage: session.outputLanguage, codeAwareMode: session.codeAwareMode,
    codebaseIds: session.codebaseIds, knowledgeSourceIds: session.knowledgeSourceIds,
    status: session.status, createdAt: session.createdAt, lastActivityAt: session.lastActivityAt,
    lastRun: {runId: run.runId, query: runScope(session, run).query ?? '', turnIndex: run.turnIndex,
      status: run.status, startedAt: run.startedAt, completedAt: run.completedAt,
      ...(run.sourceUseMode === 'explicit' || session.knowledgeSourceIds?.length ? {sourceDerived: true} : {})},
    ...(run.outcome ? {lastOutcome: outcome} : {}),
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
    ? projectOwnerAnalysisError(undefined, run.error, session.outputLanguage ?? configuredOutputLanguage())
    : run.error;
  persistAnalysisRunState(runScope(session, run), status, {error});
  const descriptor = sessionDescriptor(session, run);
  const turn = session.historyTurns.find(turn => turn.id === run.runId);
  if (!turn) throw new Error('conversation_finalized_history_missing');
  // Descriptor and the exact finalized public turn share one SQLite transaction.
  getConversationSessionStore().save(descriptor, {...turn, query: descriptor.lastRun.query});
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
      runtimeOverride: input.runtimeKind,
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
    const descriptor = sessionDescriptor(session, run);
    getConversationSessionStore().save(descriptor, toAnalysisHistoryTurn({id: run.runId,
      turnIndex: run.turnIndex, query: descriptor.lastRun.query, traceId: scope.traceId,
      timestamp: run.startedAt, sourceDerived: descriptor.lastRun.sourceDerived,
      analysisContextFingerprint: descriptor.analysisContextFingerprint,
      result: {partial: true, completion: {status: 'unknown'}},
    }));
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
    const existing = requestedSessionId ? conversationSessionService.getSession(requestedSessionId) : undefined;
    const persisted = requestedSessionId && !existing
      ? getConversationSessionStore().load(ownerFieldsFromContext(requestContext), requestedSessionId) : undefined;
    const previous = existing ?? persisted;
    if (requestedSessionId && (!previous || !isOwnedByContext(previous, requestContext))) {
      sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
      return;
    }
    const traceId = typeof req.body?.traceId === 'string' ? req.body.traceId.trim() : '';
    const providerId = req.body?.providerId === null
      ? null
      : typeof req.body?.providerId === 'string'
        ? req.body.providerId.trim()
        : undefined;
    const options = normalizeAnalyzeOptions(
      {outputLanguage: previous?.outputLanguage, codeAwareMode: previous?.codeAwareMode,
        codebaseIds: previous?.codebaseIds, knowledgeSourceIds: previous?.knowledgeSourceIds,
        ...(req.body?.options ?? {}), analysisMode: 'fast'},
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
          codeAwareMode: options.codeAwareMode,
          codebaseIds: options.codebaseIds,
        }) === 'explicit'
      ),
    );
    const analysisContextFingerprint = buildAnalysisContextAuthorizationFingerprint(
      options,
      knowledgeScopeFromRequestContext(requestContext),
    );
    if (previous && providerId !== undefined && previous.providerId !== providerId) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_PROVIDER_CHANGED',
        error: 'Start a new conversation after changing the AI provider',
      });
      return;
    }
    if (previous?.outputLanguage && previous.outputLanguage !== failureLanguage) {
      res.status(409).json({
        success: false,
        code: 'CONVERSATION_LANGUAGE_CHANGED',
        error: 'Start a new conversation after changing the output language',
      });
      return;
    }
    if (
      previous?.analysisContextFingerprint &&
      previous.analysisContextFingerprint !== analysisContextFingerprint
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
      : previous?.traceContext ?? {kind: 'none'};
    if (
      previous &&
      (previous.traceContext.kind !== effectiveTraceContext.kind ||
        (previous.traceContext.kind === 'attached' &&
          effectiveTraceContext.kind === 'attached' &&
          previous.traceContext.traceId !== effectiveTraceContext.traceId))
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
    const providerFollowsActive = previous
      ? previous.providerFollowsActive ?? true
      : providerId === undefined;
    const effectiveProviderId = previous
      ? previous.providerId !== undefined
        ? previous.providerId
        : activeProviderId
      : providerId !== undefined
        ? providerId
        : activeProviderId;
    if (previous && providerFollowsActive && effectiveProviderId !== activeProviderId) {
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
      previous?.providerSnapshotHash &&
      previous.providerSnapshotHash !== providerPin.snapshotHash
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
    assertCurrentAnalysisContextAuthorization(runtimeOptions, knowledgeScopeFromRequestContext(requestContext),
      analysisContextFingerprint);
    if (persisted) {
      const history = getConversationSessionStore().listTurns(persisted);
      conversationSessionService.restoreSession(persisted, history, turnInput);
    }
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
      error: privateKnowledge ? projectOwnerAnalysisError(undefined, message, failureLanguage) : message,
    });
  }
}

async function readAuthorizedConversation(req: express.Request, res: express.Response): Promise<ConversationSession | undefined> {
  const context = requireConversationRunPermission(req, res);
  if (!context) return undefined;
  const sessionId = routeParam(req.params.sessionId);
  const live = conversationSessionService.getSession(sessionId);
  const stored = !live ? getConversationSessionStore().load(ownerFieldsFromContext(context), sessionId) : undefined;
  const metadata = live ?? stored;
  if (!metadata || !isOwnedByContext(metadata, context)) {
    sendResourceNotFound(res, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
    return undefined;
  }
  if (metadata.providerId === undefined || !metadata.runtimeKind || !metadata.providerSnapshotHash ||
    !metadata.analysisContextFingerprint) {
    res.status(409).json({success: false, code: 'CONVERSATION_RECOVERY_UNAVAILABLE',
      error: 'The conversation is missing its pinned runtime or authorization context'});
    return undefined;
  }
  const authorized = authorizeAnalysisContext({selection: metadata, scope: knowledgeScopeFromRequestContext(context),
    outputLanguage: metadata.outputLanguage ?? configuredOutputLanguage(),
    canReadRegisteredContext: hasRbacPermission(context, 'codebase:read')});
  if (!authorized.allowed) {
    res.status(authorized.httpStatus).json(authorized.payload); return undefined;
  }
  assertCurrentAnalysisContextAuthorization(metadata, knowledgeScopeFromRequestContext(context),
    metadata.analysisContextFingerprint!);
  if (metadata.traceContext.kind === 'attached' &&
    !(await ensureTraceAccessible(req, res, metadata.traceContext.traceId))) return undefined;
  // Recheck after the awaited access lookup, before loading any history or creating an SDK adapter.
  assertCurrentAnalysisContextAuthorization(metadata, knowledgeScopeFromRequestContext(context),
    metadata.analysisContextFingerprint!);
  const provider = getProviderService();
  const owner = ownerFieldsFromContext(context);
  const pin = resolveProviderRuntimeSnapshot(provider, metadata.providerId, metadata.runtimeKind, owner);
  if (pin.snapshotHash !== metadata.providerSnapshotHash || pin.snapshot.runtimeKind !== metadata.runtimeKind ||
    (metadata.providerFollowsActive && (provider.getRawEffectiveProvider(owner)?.id ?? null) !== metadata.providerId)) {
    res.status(409).json({success: false, code: 'CONVERSATION_PROVIDER_SNAPSHOT_CHANGED',
      error: 'Start a new conversation after changing the AI provider configuration'});
    return undefined;
  }
  if (live) return live;
  const runtimeOptions: AnalysisOptions = {outputLanguage: stored!.outputLanguage, codeAwareMode: stored!.codeAwareMode,
    codebaseIds: stored!.codebaseIds, knowledgeSourceIds: stored!.knowledgeSourceIds,
    analysisContextFingerprint: stored!.analysisContextFingerprint};
  return conversationSessionService.restoreSession(stored!, getConversationSessionStore().listTurns(stored!), {
    query: '', sessionId, owner, traceContext: stored!.traceContext, providerId: stored!.providerId,
    providerFollowsActive: stored!.providerFollowsActive, runtimeKind: stored!.runtimeKind,
    providerSnapshotHash: stored!.providerSnapshotHash, analysisContextFingerprint: stored!.analysisContextFingerprint,
    runtimeOptions,
  });
}

function sourceHistoryTurnAccessible(session: ConversationSession, turnId: string | undefined): boolean {
  const turn = session.historyTurns.find(candidate => candidate.id === turnId);
  return Boolean(turn?.analysisContextFingerprint &&
    turn.analysisContextFingerprint === session.analysisContextFingerprint);
}

function settledRunHistoryAccessible(session: ConversationSession, run: ConversationRun): boolean {
  const turn = session.historyTurns.find(candidate => candidate.id === run.runId);
  return run.status === 'running' || !(turn?.sourceDerived || run.sourceUseMode === 'explicit') ||
    sourceHistoryTurnAccessible(session, run.runId);
}

function requireAccessibleSettledRunHistory(session: ConversationSession, run: ConversationRun, res: express.Response): boolean {
  if (!settledRunHistoryAccessible(session, run)) {
    res.status(409).json({success: false, code: 'CONVERSATION_HISTORY_SOURCE_UNAVAILABLE',
      error: 'The source authorization for this historical turn is unavailable'});
    return false;
  }
  return true;
}

async function getConversation(req: express.Request, res: express.Response): Promise<void> {
  const session = await readAuthorizedConversation(req, res);
  if (!session) return;
  const history = session.history.filter(message => !message.sourceDerived ||
    sourceHistoryTurnAccessible(session, message.turnId ?? message.turn?.id));
  const latestRun = session.runs[session.runs.length - 1];
  const controlsAccessible = !latestRun || settledRunHistoryAccessible(session, latestRun);
  res.json({success: true, sessionId: session.sessionId, status: session.status, traceContext: session.traceContext,
    history: history.slice(-200).map(({role, content, turnId, sourceDerived, turn}) => ({
      role, content, turnId, sourceDerived,
      ...(turn ? {turn: {id: turn.id, turnIndex: turn.turnIndex, partial: turn.partial, completionStatus: turn.completionStatus,
        terminationReason: turn.terminationReason, terminationMessage: turn.terminationMessage,
        uncertainties: turn.uncertainties, nextSteps: turn.nextSteps, evidence: turn.evidence}} : {}),
    })), historyOmittedMessages: Math.max(0, history.length - 200),
    historyUnavailableMessages: session.history.length - history.length, recoveryStatus: session.recoveryStatus,
    ...(controlsAccessible ? {pendingQuestion: session.pendingQuestion,
      recommendedFullAnalysis: Boolean(session.recommendedFullAnalysis),
      fullHandoff: conversationSessionService.buildFullAnalysisHandoff(session.sessionId)} : {}),
    activeRunId: session.activeRun?.runId});
}

async function streamConversation(req: express.Request, res: express.Response): Promise<void> {
  const session = await readAuthorizedConversation(req, res);
  if (!session) return;
  const runId = typeof req.query.runId === 'string' ? req.query.runId.trim() : '';
  const run = session.runs.find(candidate => candidate.runId === runId);
  if (!run) {
    sendResourceNotFound(res, 'Conversation run not found');
    return;
  }
  if (!requireAccessibleSettledRunHistory(session, run, res)) return;
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
  if (run.lifecycleSettled && run.events.length === 0 && run.outcome) {
    send('run_completed', {sessionId: session.sessionId, runId, outcome: run.outcome, enrichmentPending: false});
  }
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
    // After a provisional answer, cancel stops only the review; the run settles
    // with its verdict before this responds (the stream carries run_completed).
    const {kind, reviewStopped} = await conversationSessionService.cancelRun(session.sessionId, runId);
    res.json({success: true, sessionId: session.sessionId, runId, status: kind, ...(reviewStopped ? {reviewStopped} : {})});
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(/not found/i.test(message) ? 404 : 409).json({success: false, error: message});
  }
}

async function getFullHandoff(req: express.Request, res: express.Response): Promise<void> {
  const session = await readAuthorizedConversation(req, res);
  if (!session) return;
  const latestRun = session.runs[session.runs.length - 1];
  if (latestRun && !requireAccessibleSettledRunHistory(session, latestRun, res)) return;
  const handoff = conversationSessionService.buildFullAnalysisHandoff(session.sessionId);
  if (!handoff) {
    res.status(409).json({success: false, code: 'FULL_ANALYSIS_NOT_RECOMMENDED'});
    return;
  }
  res.json({success: true, sessionId: session.sessionId, handoff});
}

function conversationReadRoute(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response): void => {
    void handler(req, res).catch(error => {
      if (!res.headersSent) res.status(/not found/i.test(String(error)) ? 404 : 409).json({success: false,
        code: 'CONVERSATION_RECOVERY_UNAVAILABLE', error: error instanceof Error ? error.message : String(error)});
      else res.end();
    });
  };
}

export function registerAgentConversationRoutes(router: express.Router): void {
  router.post('/conversation', (req, res) => void startConversation(req, res));
  router.get('/conversation/:sessionId', conversationReadRoute(getConversation));
  router.get('/conversation/:sessionId/stream', conversationReadRoute(streamConversation));
  router.post('/conversation/:sessionId/cancel', (req, res) => void cancelConversation(req, res));
  router.get('/conversation/:sessionId/full-handoff', conversationReadRoute(getFullHandoff));
}

export function cleanupIdleAgentConversationSessions(): string[] {
  return conversationSessionService.cleanupIdleSessions({
    terminalMaxIdleMs: agentSessionConfig.terminalMaxIdleMs,
    nonTerminalMaxIdleMs: agentSessionConfig.nonTerminalMaxIdleMs,
  });
}
