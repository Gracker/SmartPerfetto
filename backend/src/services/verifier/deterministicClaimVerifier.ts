// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ClaimSupportV1, EvidenceAnchorV1 } from '../../types/evidenceContract';
import type {
  ClaimReferenceVerificationResult,
  ClaimVerificationClaimResult,
  ClaimVerificationIssue,
  ClaimVerificationPolicy,
  ClaimVerificationResult,
} from '../../types/claimVerification';
import { evidenceValuesMatch } from '../evidence/valueComparison';

export interface DeterministicClaimVerifierInput {
  claimSupport?: ClaimSupportV1[];
  policy?: ClaimVerificationPolicy;
}

function valuesMatch(expected: unknown, actual: unknown): boolean {
  return evidenceValuesMatch(expected, actual);
}

function verifyAnchor(anchor: EvidenceAnchorV1): ClaimReferenceVerificationResult[] {
  if (anchor.missing) {
    return [{
      evidenceRefId: anchor.evidenceRefId,
      artifactId: anchor.context.artifactId,
      sourceToolCallId: anchor.context.sourceToolCallId,
      status: 'missing',
      message: anchor.missingReason || 'referenced evidence was not found',
    }];
  }
  const cells = anchor.cells || [];
  if (cells.length === 0) {
    return [{
      evidenceRefId: anchor.evidenceRefId,
      artifactId: anchor.context.artifactId,
      sourceToolCallId: anchor.context.sourceToolCallId,
      status: 'not_checked',
      message: 'evidence row was found, but no cell value was provided for deterministic verification',
    }];
  }
  return cells.map(cell => {
    const expected = cell.value;
    const actual = cell.actualValue !== undefined ? cell.actualValue : cell.displayValue;
    if (expected === undefined) {
      return {
        evidenceRefId: anchor.evidenceRefId,
        artifactId: anchor.context.artifactId,
        sourceToolCallId: anchor.context.sourceToolCallId,
        sourceRef: cell.sourceRef,
        status: 'not_checked',
        message: `claim reference for ${cell.column} did not provide an expected value`,
      };
    }
    const matched = valuesMatch(expected, actual);
    return {
      evidenceRefId: anchor.evidenceRefId,
      artifactId: anchor.context.artifactId,
      sourceToolCallId: anchor.context.sourceToolCallId,
      sourceRef: cell.sourceRef,
      status: matched ? 'matched' : 'value_mismatch',
      ...(matched ? {} : { message: `value mismatch for ${cell.column}` }),
    };
  });
}

function issueForReference(claimId: string, ref: ClaimReferenceVerificationResult): ClaimVerificationIssue | undefined {
  if (ref.status === 'matched' || ref.status === 'not_checked') return undefined;
  return {
    claimId,
    severity: ref.status === 'missing' || ref.status === 'value_mismatch' ? 'error' : 'warning',
    code: `claim_reference_${ref.status}`,
    message: ref.message || `claim reference ${ref.status}`,
    evidenceRefId: ref.evidenceRefId,
  };
}

function verifyClaim(claim: ClaimSupportV1): { result: ClaimVerificationClaimResult; issues: ClaimVerificationIssue[] } {
  if (claim.kind === 'inference' && claim.anchors.length === 0) {
    return {
      result: { claimId: claim.claimId, status: 'inference', referenceResults: [] },
      issues: [],
    };
  }

  const referenceResults = claim.anchors.flatMap(verifyAnchor);
  const issues = referenceResults
    .map(ref => issueForReference(claim.claimId, ref))
    .filter((issue): issue is ClaimVerificationIssue => Boolean(issue));

  if (claim.kind === 'causal') {
    const relationEvaluation = claim.relationEvaluation || 'not_configured';
    if (relationEvaluation === 'rejected') {
      issues.push({
        claimId: claim.claimId,
        severity: 'error',
        code: 'causal_relation_rejected',
        message: 'causal claim references a deterministically rejected EvidenceRelationV1 relation',
      });
    } else if (relationEvaluation === 'candidate') {
      issues.push({
        claimId: claim.claimId,
        severity: 'warning',
        code: 'causal_relation_candidate',
        message: 'causal claim relation support remains an unverified deterministic candidate',
      });
    } else if (relationEvaluation === 'missing' ||
      (relationEvaluation === 'not_configured' && (!claim.relations || claim.relations.length === 0))) {
      issues.push({
        claimId: claim.claimId,
        severity: 'warning',
        code: 'causal_relation_missing',
        message: 'causal claim has no explicit EvidenceRelationV1 relation support',
      });
    }
  }

  if (claim.kind === 'identity') {
    const weakIdentity = claim.anchors.some(anchor =>
      anchor.identity?.status !== 'verified' || !anchor.identity?.identityRefId
    );
    if (weakIdentity) {
      issues.push({
        claimId: claim.claimId,
        severity: 'warning',
        code: 'identity_not_verified',
        message: 'identity-sensitive claim requires verified identity support with identityRefId',
      });
    }
  }

  if (claim.anchors.some(anchor => !anchor.context.traceId || anchor.context.traceId === 'unknown')) {
    issues.push({
      claimId: claim.claimId,
      severity: 'warning',
      code: 'evidence_trace_unknown',
      message: 'claim evidence is missing traceId and cannot be treated as fully verified',
    });
  }

  const hasReferenceErrors = referenceResults.some(ref =>
    ref.status === 'missing' || ref.status === 'value_mismatch');
  const hasUncheckedReferences = referenceResults.some(ref => ref.status === 'not_checked');
  const hasMatchedReferences = referenceResults.some(ref => ref.status === 'matched');
  const relationEvaluation = claim.kind === 'causal'
    ? claim.relationEvaluation || 'not_configured'
    : undefined;
  const relationVerified = relationEvaluation === 'verified';
  const relationRejected = relationEvaluation === 'rejected';
  const status: ClaimVerificationClaimResult['status'] = hasReferenceErrors || relationRejected ||
    (claim.supportLevel === 'unsupported' && !relationVerified)
    ? 'unsupported'
    : hasUncheckedReferences && !hasMatchedReferences
      ? 'not_checked'
      : hasUncheckedReferences
        ? 'partial'
        : claim.supportLevel === 'inference' && !relationVerified
      ? 'inference'
      : issues.length > 0 || claim.supportLevel === 'partial'
        ? 'partial'
        : 'verified';

  return {
    result: {
      claimId: claim.claimId,
      status,
      referenceResults,
    },
    issues,
  };
}

export function runDeterministicClaimVerifier(input: DeterministicClaimVerifierInput): ClaimVerificationResult {
  const claimSupport = input.claimSupport || [];
  const policy = input.policy || 'record_only';
  if (claimSupport.length === 0) {
    return {
      schemaVersion: 'claim_verifier@1',
      status: 'not_checked',
      policy,
      notCheckedReason: 'no structured claim support was available',
      passed: false,
      checkedClaimCount: 0,
      unsupportedClaimCount: 0,
      claimResults: [],
      issues: [],
    };
  }

  const verified = claimSupport.map(verifyClaim);
  const claimResults = verified.map(item => item.result);
  const issues = verified.flatMap(item => item.issues);
  const unsupportedClaimCount = claimResults.filter(item => item.status === 'unsupported').length;
  const hasErrors = issues.some(issue => issue.severity === 'error');
  const hasUnsupported = unsupportedClaimCount > 0;
  const hasPartial = claimResults.some(item => item.status === 'partial' || item.status === 'inference');
  const hasNotChecked = claimResults.some(item => item.status === 'not_checked');
  const allNotChecked = claimResults.length > 0 && claimResults.every(item => item.status === 'not_checked');
  const status = hasErrors || hasUnsupported
    ? 'failed'
    : allNotChecked
      ? 'not_checked'
      : hasPartial || hasNotChecked
      ? 'partial'
      : 'passed';

  return {
    schemaVersion: 'claim_verifier@1',
    status,
    policy,
    passed: status === 'passed',
    checkedClaimCount: claimResults.length,
    unsupportedClaimCount,
    claimResults,
    issues,
  };
}
