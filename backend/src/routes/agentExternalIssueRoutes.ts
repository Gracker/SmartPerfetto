// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';

import {requireRequestContext} from '../middleware/auth';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {
  isOwnedByContext,
  sendResourceNotFound,
  type ResourceOwnerFields,
} from '../services/resourceOwnership';
import {buildExternalIssueDraft} from '../services/externalIssueReporting/draftBuilder';
import {buildDeterministicExternalIssueReview} from '../services/externalIssueReporting/deterministicFallback';
import {detectExternalIssueOpportunity} from '../services/externalIssueReporting/opportunityDetector';
import {resolveExternalIssueProviderPin} from '../services/externalIssueReporting/providerPin';
import {
  issueExternalIssueReviewAttestation,
  verifyExternalIssueReviewAttestation,
} from '../services/externalIssueReporting/reviewAttestation';
import {validateExternalIssueReview} from '../services/externalIssueReporting/reviewValidator';
import {
  resolveExternalIssueSourceRun,
  type ExternalIssueSourceRun,
  type ExternalIssueSourceRunRequest,
} from '../services/externalIssueReporting/sourceRunResolver';
import {runExternalIssueTriage} from '../services/externalIssueReporting/triageRunner';
import {
  EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION,
  type ExternalIssueReviewV1,
  type ExternalIssueUserAnswerV1,
} from '../types/externalIssueReporting';

interface AgentExternalIssueRoutesDeps {
  getSessionOwner: (sessionId: string) => ResourceOwnerFields | null | undefined;
  resolveSourceRun?: typeof resolveExternalIssueSourceRun;
  runTriage?: typeof runExternalIssueTriage;
  resolveProviderPin?: typeof resolveExternalIssueProviderPin;
}

export function registerAgentExternalIssueRoutes(
  router: express.Router,
  deps: AgentExternalIssueRoutesDeps,
): void {
  router.post('/:sessionId/external-issue/opportunity', (req, res) => {
    const authorized = authorize(req, res, deps);
    if (!authorized) return;
    const sourceRequest = readSourceRequest(req.params.sessionId, req.body);
    if (!sourceRequest.ok) {
      return res.status(400).json({success: false, error: sourceRequest.error});
    }
    const resolved = resolveSource(
      sourceRequest.value,
      authorized,
      deps,
    );
    if (!resolved.ok) {
      if (resolved.code === 'private_analysis') {
        return res.json({
          success: true,
          opportunity: {
            schemaVersion: EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION,
            runId: sourceRequest.value.runId,
            runManifestId: sourceRequest.value.runManifestId,
            ...(sourceRequest.value.resultSnapshotId
              ? {resultSnapshotId: sourceRequest.value.resultSnapshotId}
              : {}),
            status: 'disabled',
            signals: [],
            agentReviewAvailable: false,
            agentReviewUnavailableReason: 'private_analysis',
          },
        });
      }
      return sendSourceResolutionError(res, resolved);
    }
    const pin = (deps.resolveProviderPin ?? resolveExternalIssueProviderPin)(
      resolved.source.manifest,
      authorized.providerScope,
    );
    const opportunity = detectExternalIssueOpportunity(
      resolved.source,
      pin.ok ? {} : {agentReviewUnavailableReason: pin.reason},
    );
    return res.json({success: true, opportunity});
  });

  router.post('/:sessionId/external-issue/review', async (req, res) => {
    const authorized = authorize(req, res, deps);
    if (!authorized) return;
    const sourceRequest = readSourceRequest(req.params.sessionId, req.body);
    if (!sourceRequest.ok) {
      return res.status(400).json({success: false, error: sourceRequest.error});
    }
    const resolved = resolveSource(sourceRequest.value, authorized, deps);
    if (!resolved.ok) return sendSourceResolutionError(res, resolved);
    const pin = (deps.resolveProviderPin ?? resolveExternalIssueProviderPin)(
      resolved.source.manifest,
      authorized.providerScope,
    );
    const opportunity = detectExternalIssueOpportunity(
      resolved.source,
      pin.ok ? {} : {agentReviewUnavailableReason: pin.reason},
    );
    if (opportunity.status !== 'available') {
      return res.status(409).json({
        success: false,
        code: opportunity.status === 'disabled'
          ? 'EXTERNAL_ISSUE_DISABLED'
          : 'EXTERNAL_ISSUE_NOT_NEEDED',
        error: 'This run does not have a reportable opportunity',
        opportunity,
      });
    }

    if (opportunity.agentReviewAvailable) {
      const execution = await (deps.runTriage ?? runExternalIssueTriage)({
        opportunity,
        manifest: resolved.source.manifest,
        providerScope: authorized.providerScope,
      });
      if (execution.ok) {
        const validated = validateExternalIssueReview({
          raw: execution.value,
          opportunity,
          manifest: resolved.source.manifest,
          source: 'agent',
          model: execution.model,
        });
        if (validated.ok) {
          return res.json({
            success: true,
            opportunity,
            review: attestReview(
              validated.value,
              resolved.source,
              authorized.providerScope,
            ),
            validationWarnings: validated.warnings,
          });
        }
      }
      return sendFallbackReview(
        res,
        opportunity,
        resolved.source,
        authorized.providerScope,
        execution.ok ? 'agent_invalid' : execution.reason,
      );
    }

    return sendFallbackReview(
      res,
      opportunity,
      resolved.source,
      authorized.providerScope,
      opportunity.agentReviewUnavailableReason ?? 'source_artifacts_unavailable',
    );
  });

  router.post('/:sessionId/external-issue/draft', (req, res) => {
    const authorized = authorize(req, res, deps);
    if (!authorized) return;
    if (req.body?.securitySensitive === true) {
      return res.status(409).json({
        success: false,
        code: 'PRIVATE_SECURITY_ADVISORY_REQUIRED',
        error: 'Security-sensitive reports must use the repository private security advisory flow',
      });
    }
    const sourceRequest = readSourceRequest(req.params.sessionId, req.body);
    if (!sourceRequest.ok) {
      return res.status(400).json({success: false, error: sourceRequest.error});
    }
    const draftRequest = readDraftRequest(req.body);
    if (!draftRequest.ok) {
      return res.status(400).json({success: false, error: draftRequest.error});
    }
    const resolved = resolveSource(sourceRequest.value, authorized, deps);
    if (!resolved.ok) return sendSourceResolutionError(res, resolved);
    const pin = (deps.resolveProviderPin ?? resolveExternalIssueProviderPin)(
      resolved.source.manifest,
      authorized.providerScope,
    );
    const opportunity = detectExternalIssueOpportunity(
      resolved.source,
      pin.ok ? {} : {agentReviewUnavailableReason: pin.reason},
    );
    if (opportunity.status !== 'available') {
      return res.status(409).json({
        success: false,
        code: 'EXTERNAL_ISSUE_NOT_AVAILABLE',
        error: 'This run does not have an external issue opportunity',
      });
    }
    if (
      draftRequest.value.review.source === 'agent' &&
      !opportunity.agentReviewAvailable
    ) {
      return res.status(409).json({
        success: false,
        code: 'EXTERNAL_ISSUE_AGENT_REVIEW_UNAVAILABLE',
        error: 'The source run Provider pin no longer permits Agent review',
      });
    }
    if (!verifyExternalIssueReviewAttestation({
      review: draftRequest.value.review,
      providerSnapshotHash:
        resolved.source.manifest.providerSnapshotHash ?? null,
      providerScope: authorized.providerScope,
    })) {
      return res.status(400).json({
        success: false,
        code: 'EXTERNAL_ISSUE_REVIEW_ATTESTATION_INVALID',
        error: 'The submitted review was not issued by this server or has expired',
      });
    }

    const reviewValidation = revalidateSubmittedReview(
      draftRequest.value.review,
      opportunity,
      resolved.source,
    );
    if (!reviewValidation.ok) {
      return res.status(400).json({
        success: false,
        code: 'EXTERNAL_ISSUE_REVIEW_INVALID',
        error: reviewValidation.errors.join('; '),
      });
    }
    const built = buildExternalIssueDraft({
      opportunity,
      review: reviewValidation.value,
      manifest: resolved.source.manifest,
      candidateId: draftRequest.value.candidateId,
      answers: draftRequest.value.answers,
      sensitiveDataReviewed: draftRequest.value.sensitiveDataReviewed,
    });
    if (!built.ok) {
      return res.status(409).json({
        success: false,
        code: built.code,
        error: built.errors.join('; '),
      });
    }
    return res.json({success: true, draft: built.draft});
  });
}

function authorize(
  req: express.Request,
  res: express.Response,
  deps: AgentExternalIssueRoutesDeps,
): {
  providerScope: {
    tenantId: string;
    workspaceId: string;
    userId: string;
  };
} | null {
  const context = requireRequestContext(req);
  const owner = deps.getSessionOwner(routeParam(req.params.sessionId));
  if (!owner || !isOwnedByContext(owner, context)) {
    sendResourceNotFound(res, 'Session not found');
    return null;
  }
  if (!hasRbacPermission(context, 'agent:run')) {
    sendForbidden(res, 'External issue triage requires agent:run');
    return null;
  }
  return {
    providerScope: {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      userId: context.userId,
    },
  };
}

function resolveSource(
  request: ExternalIssueSourceRunRequest,
  authorized: {
    providerScope: {
      tenantId: string;
      workspaceId: string;
      userId: string;
    };
  },
  deps: AgentExternalIssueRoutesDeps,
) {
  return (deps.resolveSourceRun ?? resolveExternalIssueSourceRun)(
    request,
    {
      tenantId: authorized.providerScope.tenantId,
      workspaceId: authorized.providerScope.workspaceId,
      userId: authorized.providerScope.userId,
      auditActorUserId: authorized.providerScope.userId,
    },
  );
}

function readSourceRequest(
  sessionId: string,
  body: unknown,
): {ok: true; value: ExternalIssueSourceRunRequest} | {ok: false; error: string} {
  if (!isRecord(body)) return {ok: false, error: 'Request body must be an object'};
  const runId = readId(body.runId);
  const runManifestId = readId(body.runManifestId);
  const resultSnapshotId = body.resultSnapshotId === undefined
    ? undefined
    : readId(body.resultSnapshotId);
  if (!readId(sessionId) || !runId || !runManifestId) {
    return {
      ok: false,
      error: 'sessionId, runId, and runManifestId are required',
    };
  }
  if (body.resultSnapshotId !== undefined && !resultSnapshotId) {
    return {ok: false, error: 'resultSnapshotId is invalid'};
  }
  return {
    ok: true,
    value: {
      sessionId,
      runId,
      runManifestId,
      ...(resultSnapshotId ? {resultSnapshotId} : {}),
    },
  };
}

function readDraftRequest(body: unknown):
  | {
      ok: true;
      value: {
        review: ExternalIssueReviewV1;
        candidateId: string;
        answers: ExternalIssueUserAnswerV1[];
        sensitiveDataReviewed: boolean;
      };
    }
  | {ok: false; error: string} {
  if (!isRecord(body) || !isRecord(body.review)) {
    return {ok: false, error: 'A validated review is required'};
  }
  const candidateId = readId(body.candidateId);
  if (!candidateId) return {ok: false, error: 'candidateId is required'};
  if (!Array.isArray(body.answers) || body.answers.length > 2) {
    return {ok: false, error: 'answers must contain at most two items'};
  }
  const answers: ExternalIssueUserAnswerV1[] = [];
  for (const answer of body.answers) {
    if (!isRecord(answer) || Object.keys(answer).some(key =>
      key !== 'questionId' && key !== 'answer')) {
      return {ok: false, error: 'Each answer must contain only questionId and answer'};
    }
    const questionId = readId(answer.questionId);
    const value = typeof answer.answer === 'string' && answer.answer.trim() &&
        answer.answer.length <= 2000
      ? answer.answer.trim()
      : undefined;
    if (!questionId || !value) {
      return {ok: false, error: 'Each answer must contain a valid questionId and answer'};
    }
    answers.push({questionId, answer: value});
  }
  if (body.sensitiveDataReviewed !== true) {
    return {ok: false, error: 'sensitiveDataReviewed must be true'};
  }
  return {
    ok: true,
    value: {
      review: body.review as unknown as ExternalIssueReviewV1,
      candidateId,
      answers,
      sensitiveDataReviewed: true,
    },
  };
}

function revalidateSubmittedReview(
  review: ExternalIssueReviewV1,
  opportunity: ReturnType<typeof detectExternalIssueOpportunity>,
  source: ExternalIssueSourceRun,
) {
  if (
    !isRecord(review) ||
    review.schemaVersion !== 'external_issue_review@1' ||
    review.runId !== opportunity.runId ||
    review.runManifestId !== opportunity.runManifestId ||
    (review.source !== 'agent' && review.source !== 'deterministic_fallback') ||
    !Array.isArray(review.candidates)
  ) {
    return {
      ok: false as const,
      errors: ['Review metadata does not match the source run'],
      warnings: [],
    };
  }
  const {
    serverAttestation: _serverAttestation,
    ...unsignedReview
  } = review;
  return validateExternalIssueReview({
    raw: review.source === 'agent'
      ? {candidates: unsignedReview.candidates}
      : unsignedReview,
    opportunity,
    manifest: source.manifest,
    source: review.source,
    ...(review.model ? {model: review.model} : {}),
    ...(review.fallbackReason ? {fallbackReason: review.fallbackReason} : {}),
  });
}

function attestReview(
  review: ExternalIssueReviewV1,
  source: ExternalIssueSourceRun,
  providerScope: {
    tenantId: string;
    workspaceId: string;
    userId: string;
  },
): ExternalIssueReviewV1 {
  return {
    ...review,
    serverAttestation: issueExternalIssueReviewAttestation({
      review,
      providerSnapshotHash: source.manifest.providerSnapshotHash ?? null,
      providerScope,
    }),
  };
}

function sendFallbackReview(
  res: express.Response,
  opportunity: ReturnType<typeof detectExternalIssueOpportunity>,
  source: ExternalIssueSourceRun,
  providerScope: {
    tenantId: string;
    workspaceId: string;
    userId: string;
  },
  reason: NonNullable<ExternalIssueReviewV1['fallbackReason']>,
): express.Response {
  const fallback = buildDeterministicExternalIssueReview({
    opportunity,
    manifest: source.manifest,
    reason,
  });
  const validatedFallback = validateExternalIssueReview({
    raw: fallback,
    opportunity,
    manifest: source.manifest,
    source: 'deterministic_fallback',
    fallbackReason: reason,
  });
  if (!validatedFallback.ok) {
    return res.status(502).json({
      success: false,
      code: 'EXTERNAL_ISSUE_REVIEW_INVALID',
      error: 'The Agent review and safe fallback were both invalid',
    });
  }
  return res.json({
    success: true,
    opportunity,
    review: attestReview(
      validatedFallback.value,
      source,
      providerScope,
    ),
    validationWarnings: validatedFallback.warnings,
  });
}

function sendSourceResolutionError(
  res: express.Response,
  resolution: Exclude<
    ReturnType<typeof resolveExternalIssueSourceRun>,
    {ok: true}
  >,
): express.Response {
  const status = resolution.code === 'source_artifacts_mismatch' ? 409 : 404;
  return res.status(status).json({
    success: false,
    code: resolution.code.toUpperCase(),
    error: resolution.message,
  });
}

function readId(value: unknown): string | undefined {
  return typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : undefined;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
