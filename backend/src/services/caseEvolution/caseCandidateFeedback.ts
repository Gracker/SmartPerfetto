// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CaseNode} from '../../types/sparkContracts';
import type {EffectiveFeedbackV1} from '../../types/selfEvolution';
import {CaseLibrary} from '../caseLibrary';
import type {KnowledgeScope} from '../scopedKnowledgeStore';
import {resolveKnowledgeScope} from '../scopedKnowledgeStore';
import type {
  CandidateFeedbackProjectionResult,
  CaseCandidateOutboxHandle,
} from './caseCandidateOutbox';
import {caseCandidateKnowledgeScope} from './caseCandidateBuilder';

export interface SyncCaseCandidateFeedbackProjectionInput {
  candidateId: string;
  feedback: readonly EffectiveFeedbackV1[];
  outbox: CaseCandidateOutboxHandle;
  library?: CaseLibrary;
  knowledgeScope: KnowledgeScope;
}

export interface SyncCaseCandidateFeedbackProjectionResult
  extends CandidateFeedbackProjectionResult {
  reason?: 'missing_candidate' | 'scope_mismatch';
}

/**
 * Materialize the active effective_feedback rows for one candidate. The
 * append-only event store is authoritative; this function only overwrites a
 * derived projection and is safe to retry after a crash.
 */
export function syncCaseCandidateFeedbackProjection(
  input: SyncCaseCandidateFeedbackProjectionInput,
): SyncCaseCandidateFeedbackProjectionResult {
  const candidate = input.outbox.getCandidate(input.candidateId);
  if (!candidate) {
    return {
      found: false,
      reason: 'missing_candidate',
      supportingEvidence: 0,
      contradictingEvidence: 0,
      rejected: false,
      supported: false,
    };
  }
  const candidateScope = caseCandidateKnowledgeScope(candidate.candidate);
  const requestedScope = resolveKnowledgeScope(input.knowledgeScope);
  if (
    !candidateScope ||
    candidateScope.tenantId !== requestedScope.tenantId ||
    candidateScope.workspaceId !== requestedScope.workspaceId
  ) {
    return {
      found: false,
      reason: 'scope_mismatch',
      supportingEvidence: 0,
      contradictingEvidence: 0,
      rejected: false,
      supported: false,
    };
  }

  const projection = input.outbox.applyFeedbackProjection(
    input.candidateId,
    input.feedback,
  );
  if (!projection.found || !input.library) return projection;

  const updated = input.outbox.getCandidate(input.candidateId);
  if (!updated) return projection;
  const learnedCase = resolveLearnedCase(
    input.library,
    updated,
    candidateScope,
  );
  if (learnedCase?.knowledge) {
    input.library.applyCaseEvolutionFeedbackProjection(
      learnedCase.caseId,
      {
        candidateId: updated.candidateId,
        supportingEvidence: projection.supportingEvidence,
        contradictingEvidence: projection.contradictingEvidence,
        maintainerPromoted: updated.maintainerPromoted === 1,
        supported: projection.supported,
        feedbackProjectionRejected: projection.rejected,
      },
      candidateScope,
    );
  }
  return projection;
}

function resolveLearnedCase(
  library: CaseLibrary,
  candidate: NonNullable<
    ReturnType<CaseCandidateOutboxHandle['getCandidate']>
  >,
  scope?: KnowledgeScope,
): CaseNode | undefined {
  if (candidate.learnedCaseId) {
    const direct = library.getCase(candidate.learnedCaseId, scope);
    if (direct) return direct;
  }
  return library.listCases({}, scope).find(caseNode => {
    const marker = caseNode.knowledge?.context?.['caseEvolution.v1'];
    return !!marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      (marker as Record<string, unknown>).candidateId === candidate.candidateId;
  });
}
