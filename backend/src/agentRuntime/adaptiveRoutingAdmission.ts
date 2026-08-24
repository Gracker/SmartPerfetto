// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from '../services/selfEvolution/canonicalJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export interface AdaptiveRoutingAdmissionSplitEvidenceV1 {
  schemaVersion: 1;
  split: 'validation' | 'holdout';
  experimentContentHash: string;
  baselineProfileId: string;
  candidateProfileId: string;
  caseCount: number;
  repeatsPerCaseProfile: number;
  actualUsageAvailable: boolean;
  l0PassRate: number;
  unsupportedClaims: number;
  identityErrors: number;
  falseQuick: number;
  claimVerifiedRatioDelta: number;
  goldenHitRatioDelta: number;
  baselineMedianWallclockMs: number;
  candidateMedianWallclockMs: number;
  baselineMedianTokens: number;
  candidateMedianTokens: number;
  baselineMedianToolCalls: number;
  candidateMedianToolCalls: number;
}

export type AdaptiveRoutingAdmissionReason =
  | 'actual_usage_unavailable'
  | 'case_count_failed'
  | 'repeat_count_failed'
  | 'l0_pass_rate_failed'
  | 'unsupported_claims_present'
  | 'identity_errors_present'
  | 'false_quick_present'
  | 'claim_verified_delta_failed'
  | 'golden_hit_delta_failed'
  | 'cost_reduction_failed'
  | 'tool_call_growth_failed';

export interface AdaptiveRoutingAdmissionVerdictV1 {
  schemaVersion: 'adaptive_routing_admission@1';
  status: 'eligible_for_enforcement' | 'rejected' | 'inconclusive';
  reasons: AdaptiveRoutingAdmissionReason[];
  checks: {
    validation: {
      passed: boolean;
      reasons: AdaptiveRoutingAdmissionReason[];
      wallclockSaving: number;
      tokenSaving: number;
      toolCallGrowth: number;
    };
    holdout: {
      passed: boolean;
      reasons: AdaptiveRoutingAdmissionReason[];
      wallclockSaving: number;
      tokenSaving: number;
      toolCallGrowth: number;
    };
  };
  evidenceContentHash: string;
  contentHash: string;
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function nonnegative(value: unknown, error: string): number {
  const parsed = finite(value, error);
  if (parsed < 0) throw new Error(error);
  return parsed;
}

function ratio(value: unknown, error: string): number {
  const parsed = finite(value, error);
  if (parsed < 0 || parsed > 1) throw new Error(error);
  return parsed;
}

function signedRatio(value: unknown, error: string): number {
  const parsed = finite(value, error);
  if (parsed < -1 || parsed > 1) throw new Error(error);
  return parsed;
}

function positiveInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(error);
  return value as number;
}

function nonnegativeInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(error);
  return value as number;
}

function parseSplit(
  value: unknown,
  expectedSplit: 'validation' | 'holdout',
): AdaptiveRoutingAdmissionSplitEvidenceV1 {
  const evidence = record(value, 'adaptive_routing_admission_evidence_invalid');
  const allowed = new Set([
    'schemaVersion',
    'split',
    'experimentContentHash',
    'baselineProfileId',
    'candidateProfileId',
    'caseCount',
    'repeatsPerCaseProfile',
    'actualUsageAvailable',
    'l0PassRate',
    'unsupportedClaims',
    'identityErrors',
    'falseQuick',
    'claimVerifiedRatioDelta',
    'goldenHitRatioDelta',
    'baselineMedianWallclockMs',
    'candidateMedianWallclockMs',
    'baselineMedianTokens',
    'candidateMedianTokens',
    'baselineMedianToolCalls',
    'candidateMedianToolCalls',
  ]);
  if (Object.keys(evidence).some(key => !allowed.has(key))) {
    throw new Error('adaptive_routing_admission_unknown_field');
  }
  if (
    evidence.schemaVersion !== 1
    || evidence.split !== expectedSplit
    || typeof evidence.actualUsageAvailable !== 'boolean'
    || typeof evidence.experimentContentHash !== 'string'
    || !SHA256_PATTERN.test(evidence.experimentContentHash)
    || typeof evidence.baselineProfileId !== 'string'
    || typeof evidence.candidateProfileId !== 'string'
    || !PROFILE_ID_PATTERN.test(evidence.baselineProfileId)
    || !PROFILE_ID_PATTERN.test(evidence.candidateProfileId)
    || evidence.baselineProfileId === evidence.candidateProfileId
  ) {
    throw new Error('adaptive_routing_admission_identity_invalid');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    split: expectedSplit,
    experimentContentHash: evidence.experimentContentHash,
    baselineProfileId: evidence.baselineProfileId,
    candidateProfileId: evidence.candidateProfileId,
    caseCount: positiveInteger(evidence.caseCount, 'adaptive_routing_admission_case_count_invalid'),
    repeatsPerCaseProfile: positiveInteger(
      evidence.repeatsPerCaseProfile,
      'adaptive_routing_admission_repeat_count_invalid',
    ),
    actualUsageAvailable: evidence.actualUsageAvailable,
    l0PassRate: ratio(evidence.l0PassRate, 'adaptive_routing_admission_l0_rate_invalid'),
    unsupportedClaims: nonnegativeInteger(
      evidence.unsupportedClaims,
      'adaptive_routing_admission_unsupported_invalid',
    ),
    identityErrors: nonnegativeInteger(
      evidence.identityErrors,
      'adaptive_routing_admission_identity_errors_invalid',
    ),
    falseQuick: nonnegativeInteger(
      evidence.falseQuick,
      'adaptive_routing_admission_false_quick_invalid',
    ),
    claimVerifiedRatioDelta: signedRatio(
      evidence.claimVerifiedRatioDelta,
      'adaptive_routing_admission_claim_delta_invalid',
    ),
    goldenHitRatioDelta: signedRatio(
      evidence.goldenHitRatioDelta,
      'adaptive_routing_admission_golden_delta_invalid',
    ),
    baselineMedianWallclockMs: nonnegative(
      evidence.baselineMedianWallclockMs,
      'adaptive_routing_admission_wallclock_invalid',
    ),
    candidateMedianWallclockMs: nonnegative(
      evidence.candidateMedianWallclockMs,
      'adaptive_routing_admission_wallclock_invalid',
    ),
    baselineMedianTokens: nonnegative(
      evidence.baselineMedianTokens,
      'adaptive_routing_admission_tokens_invalid',
    ),
    candidateMedianTokens: nonnegative(
      evidence.candidateMedianTokens,
      'adaptive_routing_admission_tokens_invalid',
    ),
    baselineMedianToolCalls: nonnegative(
      evidence.baselineMedianToolCalls,
      'adaptive_routing_admission_tool_calls_invalid',
    ),
    candidateMedianToolCalls: nonnegative(
      evidence.candidateMedianToolCalls,
      'adaptive_routing_admission_tool_calls_invalid',
    ),
  });
}

function reduction(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return (baseline - candidate) / baseline;
}

function growth(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline;
}

function checkSplit(evidence: AdaptiveRoutingAdmissionSplitEvidenceV1) {
  const reasons: AdaptiveRoutingAdmissionReason[] = [];
  if (!evidence.actualUsageAvailable) reasons.push('actual_usage_unavailable');
  if (evidence.caseCount < 3) reasons.push('case_count_failed');
  if (evidence.repeatsPerCaseProfile < 3) reasons.push('repeat_count_failed');
  if (evidence.l0PassRate !== 1) reasons.push('l0_pass_rate_failed');
  if (evidence.unsupportedClaims > 0) reasons.push('unsupported_claims_present');
  if (evidence.identityErrors > 0) reasons.push('identity_errors_present');
  if (evidence.falseQuick > 0) reasons.push('false_quick_present');
  if (evidence.claimVerifiedRatioDelta < -0.02) {
    reasons.push('claim_verified_delta_failed');
  }
  if (evidence.goldenHitRatioDelta < -0.05) {
    reasons.push('golden_hit_delta_failed');
  }
  const wallclockSaving = reduction(
    evidence.baselineMedianWallclockMs,
    evidence.candidateMedianWallclockMs,
  );
  const tokenSaving = reduction(
    evidence.baselineMedianTokens,
    evidence.candidateMedianTokens,
  );
  if (wallclockSaving < 0.3 && tokenSaving < 0.35) {
    reasons.push('cost_reduction_failed');
  }
  const toolCallGrowth = growth(
    evidence.baselineMedianToolCalls,
    evidence.candidateMedianToolCalls,
  );
  if (toolCallGrowth > 0.1 + Number.EPSILON) {
    reasons.push('tool_call_growth_failed');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    wallclockSaving,
    tokenSaving,
    toolCallGrowth,
  };
}

export function evaluateAdaptiveRoutingAdmission(input: {
  validation: AdaptiveRoutingAdmissionSplitEvidenceV1;
  holdout: AdaptiveRoutingAdmissionSplitEvidenceV1;
}): AdaptiveRoutingAdmissionVerdictV1 {
  const validation = parseSplit(input.validation, 'validation');
  const holdout = parseSplit(input.holdout, 'holdout');
  if (
    validation.baselineProfileId !== holdout.baselineProfileId
    || validation.candidateProfileId !== holdout.candidateProfileId
  ) {
    throw new Error('adaptive_routing_admission_profile_mismatch');
  }
  const checks = {
    validation: checkSplit(validation),
    holdout: checkSplit(holdout),
  };
  const reasons = [...new Set([
    ...checks.validation.reasons,
    ...checks.holdout.reasons,
  ])];
  const inconclusiveReasons = reasons.filter(reason =>
    reason === 'actual_usage_unavailable');
  const conclusiveReasons = reasons.filter(reason =>
    reason !== 'actual_usage_unavailable');
  const status = conclusiveReasons.length > 0
      ? 'rejected' as const
      : inconclusiveReasons.length > 0
        ? 'inconclusive' as const
        : 'eligible_for_enforcement' as const;
  const visibleReasons = status === 'inconclusive' ? inconclusiveReasons : reasons;
  const withoutHash = {
    schemaVersion: 'adaptive_routing_admission@1' as const,
    status,
    reasons: visibleReasons,
    checks,
    evidenceContentHash: canonicalContentHash({validation, holdout}),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function adaptiveRoutingProductionPolicy() {
  const body = {
    schemaVersion: 1 as const,
    enforcement: 'shadow' as const,
    reason: 'admission_not_activated' as const,
  };
  return immutableCanonicalSnapshot({
    ...body,
    policyFingerprint: canonicalContentHash(body),
  });
}
