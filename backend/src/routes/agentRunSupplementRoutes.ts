// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type express from 'express';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {
  RUN_SUPPLEMENT_MAX_BYTES,
  runSupplementFeatureEnabled,
  type RunSupplementChannel,
  type RunSupplementSubmitResult,
} from '../agentRuntime/runSupplementChannel';
import {CLIENT_ID_PATTERN} from '../assistant/application/conversationPendingContext';
import {requireRequestContext} from '../middleware/auth';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {evaluateTenantMutationPolicy, sendTenantMutationDeniedPayload} from '../services/enterpriseTenantLifecycleService';
import {isTerminalRunStatus} from '../services/analysisRunStore';
import {registerPrivateAnalysisQueryForEcho} from '../services/security/codeAwareOutputRegistry';
import {isPlainObject} from '../utils/llmJson';
import {requireAiEnabledForHttp} from './aiCapabilityPolicyHttp';

const ALLOWED_BODY_KEYS = new Set(['idempotencyKey', 'text']);

interface SupplementRouteSession {
  sessionId: string;
  cancellationInFlightRunId?: string;
  runSupplementChannel?: RunSupplementChannel;
}

export interface RunSupplementRouteDependencies<TSession extends SupplementRouteSession> {
  getAuthorizedSession(req: express.Request, res: express.Response, sessionId: string): TSession | null;
  resolveSessionRun(session: TSession, runId: string): {runId: string; status: string} | undefined;
  isCurrentRunOwner(session: TSession, runId: string): boolean;
  sessionRunHasPrivateContext(session: TSession, runId: string): boolean;
  sessionOutputLanguage(session: TSession): OutputLanguage;
}

type ValidatedBody = {idempotencyKey: string; text: string};
type BodyValidation = {ok: true; body: ValidatedBody} | {ok: false; status: 400 | 413; code: string};

function validateBody(body: unknown): BodyValidation {
  const invalid = {ok: false, status: 400, code: 'RUN_SUPPLEMENT_INVALID_BODY'} as const;
  if (!isPlainObject(body)) return invalid;
  if (Object.keys(body).some(key => !ALLOWED_BODY_KEYS.has(key))) return invalid;
  const {idempotencyKey, text} = body;
  if (typeof idempotencyKey !== 'string' || !CLIENT_ID_PATTERN.test(idempotencyKey)) return invalid;
  if (typeof text !== 'string' || !text.trim()) return invalid;
  if (Buffer.byteLength(text, 'utf8') > RUN_SUPPLEMENT_MAX_BYTES) {
    return {ok: false, status: 413, code: 'RUN_SUPPLEMENT_TOO_LARGE'};
  }
  return {ok: true, body: {idempotencyKey, text}};
}

/** Localized for the session's pinned language; codes stay the machine contract. */
function errorMessages(language: OutputLanguage): Record<string, string> {
  return {
    RUN_SUPPLEMENT_INVALID_BODY: localize(language, '补充说明请求格式无效', 'The supplement request body is invalid'),
    RUN_SUPPLEMENT_TOO_LARGE: localize(language, '补充说明过长', 'The supplement is too large'),
    RUN_SUPPLEMENT_UNSUPPORTED: localize(language, '此运行不支持追加补充说明', 'This run does not accept supplements'),
    RUN_NOT_FOUND: localize(language, '未找到该运行', 'Run not found in session'),
    RUN_NOT_ACTIVE: localize(language, '该运行已结束', 'The run is no longer active'),
    CANCELLATION_IN_PROGRESS: localize(language, '运行正在停止', 'The current run is still stopping'),
    RUN_SUPPLEMENT_WINDOW_CLOSED: localize(language, '本次运行已结束调查阶段，不再接收补充说明', 'The run has finished investigating and no longer accepts supplements'),
    RUN_SUPPLEMENT_CAPACITY_EXCEEDED: localize(language, '本次运行的补充说明数量已达上限', 'This run has reached its supplement limit'),
    RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT: localize(language, '相同的幂等键已用于不同内容', 'The idempotency key was already used with different text'),
  };
}

function submitErrorCode(result: Exclude<RunSupplementSubmitResult, {status: 'accepted'}>): string {
  switch (result.status) {
    case 'capacity_exceeded': return 'RUN_SUPPLEMENT_CAPACITY_EXCEEDED';
    case 'window_closed': return 'RUN_SUPPLEMENT_WINDOW_CLOSED';
    case 'not_active': return 'RUN_NOT_ACTIVE';
    case 'unsupported': return 'RUN_SUPPLEMENT_UNSUPPORTED';
  }
}

export function registerRunSupplementRoutes<TSession extends SupplementRouteSession>(
  router: express.Router,
  deps: RunSupplementRouteDependencies<TSession>,
): void {
  router.post('/sessions/:sessionId/runs/:runId/supplements', (req, res) => {
    if (!requireAiEnabledForHttp(res, 'agent_analyze')) return;
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'agent:run')) {
      sendForbidden(res, 'Submitting a supplement requires agent:run permission');
      return;
    }
    const tenantDecision = evaluateTenantMutationPolicy(context);
    if (!tenantDecision.allowed) {
      res.status(tenantDecision.httpStatus).json(sendTenantMutationDeniedPayload(tenantDecision));
      return;
    }
    const {sessionId, runId} = req.params;
    const session = deps.getAuthorizedSession(req, res, sessionId);
    if (!session) return;
    const language = deps.sessionOutputLanguage(session);
    const fail = (status: number, code: string): void => {
      res.status(status).json({success: false, code, error: errorMessages(language)[code]});
    };
    if (!runSupplementFeatureEnabled()) { fail(409, 'RUN_SUPPLEMENT_UNSUPPORTED'); return; }
    const validated = validateBody(req.body);
    if (!validated.ok) { fail(validated.status, validated.code); return; }
    const run = deps.resolveSessionRun(session, runId);
    if (!run) { fail(404, 'RUN_NOT_FOUND'); return; }
    const channel = session.runSupplementChannel?.runId === runId ? session.runSupplementChannel : undefined;
    if (!channel) {
      // The current run simply has no channel (smart/scene/other runtime); a past run is stale.
      fail(409, deps.isCurrentRunOwner(session, runId) ? 'RUN_SUPPLEMENT_UNSUPPORTED' : 'RUN_NOT_ACTIVE');
      return;
    }
    // An exact retry replays even after the run ended, before any run-state check.
    const replayed = channel.replay(validated.body);
    if (replayed?.status === 'replayed') { res.status(202).json({receipt: replayed.receipt}); return; }
    if (replayed) { fail(409, 'RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT'); return; }
    if (channel.isUnsupported) { fail(409, 'RUN_SUPPLEMENT_UNSUPPORTED'); return; }
    if (session.cancellationInFlightRunId === runId) { fail(409, 'CANCELLATION_IN_PROGRESS'); return; }
    if (!deps.isCurrentRunOwner(session, runId) || channel.isTerminated || isTerminalRunStatus(run.status)) {
      fail(409, 'RUN_NOT_ACTIVE');
      return;
    }
    const result = channel.submit(validated.body);
    if (result.status === 'accepted') {
      if (deps.sessionRunHasPrivateContext(session, runId)) registerPrivateAnalysisQueryForEcho(sessionId, result.redactedText);
      res.status(202).json({receipt: result.receipt});
      return;
    }
    fail(409, submitErrorCode(result));
  });
}
