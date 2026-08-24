// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AdaptiveEvidenceTier,
  AdaptiveRoutingObligationCode,
  AdaptiveRoutingReasonCode,
  AdaptiveRoutingReceiptV1,
} from '../types/adaptiveRouting';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from '../services/selfEvolution/canonicalJson';

export type AdaptiveClassifierIntent =
  | 'acknowledgement'
  | 'deterministic_direct_evidence'
  | 'semantic_quick'
  | 'semantic_full';

const POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: 'adaptive-evidence-shadow-v1',
  dispatchStopRatio: 0.8,
  enforcement: 'shadow',
});
const POLICY_FINGERPRINT = canonicalContentHash(POLICY);

const TIER_ORDER: Record<AdaptiveEvidenceTier, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

const REASONS = new Set<AdaptiveRoutingReasonCode>([
  'acknowledgement',
  'deterministic_direct_evidence',
  'quick_semantic_explanation',
  'primary_semantic_analysis',
  'user_requested_full',
  'reference_comparison',
  'private_context',
  'cross_process_causality',
  'identity_ambiguous',
  'identity_conflict',
  'evidence_conflict',
  'unsupported_claim',
  'schema_uncertain',
  'capability_uncertain',
  'causal_obligation_open',
  'required_evidence_missing',
  'budget_dispatch_threshold',
  'repeated_tool_call',
  'evidence_sufficient',
]);
const OBLIGATIONS = new Set<AdaptiveRoutingObligationCode>([
  'complete_report',
  'reference_comparison',
  'private_context',
  'cross_process_causality',
  'identity_resolution',
  'claim_support',
  'schema_resolution',
]);

function baseTier(intent: AdaptiveClassifierIntent): AdaptiveEvidenceTier {
  if (intent === 'acknowledgement' || intent === 'deterministic_direct_evidence') {
    return 'L0';
  }
  return intent === 'semantic_quick' ? 'L1' : 'L2';
}

function reasonForIntent(
  intent: AdaptiveClassifierIntent,
): AdaptiveRoutingReasonCode {
  if (intent === 'acknowledgement') return 'acknowledgement';
  if (intent === 'deterministic_direct_evidence') {
    return 'deterministic_direct_evidence';
  }
  return intent === 'semantic_quick'
    ? 'quick_semantic_explanation'
    : 'primary_semantic_analysis';
}

function reasonForObligation(
  obligation: AdaptiveRoutingObligationCode,
): AdaptiveRoutingReasonCode {
  if (obligation === 'complete_report') return 'user_requested_full';
  if (obligation === 'identity_resolution') return 'identity_ambiguous';
  if (obligation === 'claim_support') return 'unsupported_claim';
  if (obligation === 'schema_resolution') return 'schema_uncertain';
  return obligation;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function snapshotReceipt(
  value: Omit<AdaptiveRoutingReceiptV1, 'contentHash'>,
): AdaptiveRoutingReceiptV1 {
  return immutableCanonicalSnapshot({
    ...value,
    contentHash: canonicalContentHash(value),
  });
}

function emptyEvidence(): AdaptiveRoutingReceiptV1['evidence'] {
  return {
    required: 0,
    observed: 0,
    missing: 0,
    unsupportedClaims: 0,
    conflicts: 0,
    identityStatus: 'unknown',
    schemaStatus: 'unknown',
    causalOpen: 0,
  };
}

export function routeAdaptiveEvidencePreflight(input: {
  requestedMode: AdaptiveRoutingReceiptV1['requestedMode'];
  resolvedMode: AdaptiveRoutingReceiptV1['resolvedMode'];
  classifierIntent: AdaptiveClassifierIntent;
  classifierSource: AdaptiveRoutingReceiptV1['classifierSource'];
  hardObligations: AdaptiveRoutingObligationCode[];
  outputCap?: number;
}): AdaptiveRoutingReceiptV1 {
  const obligations = unique(input.hardObligations);
  if (obligations.some(item => !OBLIGATIONS.has(item))) {
    throw new Error('adaptive_routing_obligation_invalid');
  }
  if (
    input.outputCap !== undefined
    && (!Number.isSafeInteger(input.outputCap) || input.outputCap < 1)
  ) {
    throw new Error('adaptive_routing_output_cap_invalid');
  }
  let currentTier = baseTier(input.classifierIntent);
  if (input.resolvedMode === 'full' && obligations.length > 0) {
    currentTier = 'L3';
  }
  const recommendedTier = obligations.length > 0 ? 'L3' : currentTier;
  const reasons = obligations.length > 0
    ? obligations.map(reasonForObligation)
    : [reasonForIntent(input.classifierIntent)];
  return snapshotReceipt({
    schemaVersion: 'adaptive_routing@1',
    stage: 'preflight',
    requestedMode: input.requestedMode,
    resolvedMode: input.resolvedMode,
    classifierSource: input.classifierSource,
    currentTier,
    recommendedTier,
    decision: TIER_ORDER[recommendedTier] > TIER_ORDER[currentTier]
      ? 'recommend_upgrade'
      : 'stay',
    reasons: unique(reasons),
    obligations,
    evidence: emptyEvidence(),
    budget: {dispatchUtilization: '0_49', repeatedToolCalls: 0},
    shadow: true,
    policyFingerprint: POLICY_FINGERPRINT,
    ...(input.outputCap === undefined ? {} : {outputCap: input.outputCap}),
  });
}

function nonnegativeInteger(value: number, error: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(error);
  return value;
}

function utilizationBucket(
  ratio: number,
): AdaptiveRoutingReceiptV1['budget']['dispatchUtilization'] {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new Error('adaptive_routing_budget_ratio_invalid');
  }
  if (ratio < 0.5) return '0_49';
  if (ratio < 0.8) return '50_79';
  if (ratio < 1) return '80_99';
  return '100_plus';
}

export function routeAdaptiveEvidencePostEvidence(input: {
  previous: AdaptiveRoutingReceiptV1;
  evidence: Omit<AdaptiveRoutingReceiptV1['evidence'], 'missing'>;
  dispatchBudgetRatio: number;
  repeatedToolCalls: number;
}): AdaptiveRoutingReceiptV1 {
  const previous = parseAdaptiveRoutingReceipt(input.previous);
  const evidence = {
    required: nonnegativeInteger(
      input.evidence.required,
      'adaptive_routing_evidence_required_invalid',
    ),
    observed: nonnegativeInteger(
      input.evidence.observed,
      'adaptive_routing_evidence_observed_invalid',
    ),
    missing: Math.max(0, input.evidence.required - input.evidence.observed),
    unsupportedClaims: nonnegativeInteger(
      input.evidence.unsupportedClaims,
      'adaptive_routing_unsupported_claims_invalid',
    ),
    conflicts: nonnegativeInteger(
      input.evidence.conflicts,
      'adaptive_routing_conflicts_invalid',
    ),
    identityStatus: input.evidence.identityStatus,
    schemaStatus: input.evidence.schemaStatus,
    causalOpen: nonnegativeInteger(
      input.evidence.causalOpen,
      'adaptive_routing_causal_open_invalid',
    ),
  };
  const pendingPreflightUpgrade =
    TIER_ORDER[previous.recommendedTier] > TIER_ORDER[previous.currentTier];
  const inheritedReasons: AdaptiveRoutingReasonCode[] = pendingPreflightUpgrade
    ? previous.obligations.map(reasonForObligation)
    : [];
  const evidenceReasons: AdaptiveRoutingReasonCode[] = [];
  const obligations = [...previous.obligations];
  if (evidence.identityStatus === 'ambiguous') {
    evidenceReasons.push('identity_ambiguous');
    obligations.push('identity_resolution');
  }
  if (evidence.identityStatus === 'conflict') {
    evidenceReasons.push('identity_conflict');
    obligations.push('identity_resolution');
  }
  if (evidence.unsupportedClaims > 0) {
    evidenceReasons.push('unsupported_claim');
    obligations.push('claim_support');
  }
  if (evidence.conflicts > 0) evidenceReasons.push('evidence_conflict');
  if (evidence.schemaStatus === 'uncertain') {
    evidenceReasons.push('schema_uncertain');
    obligations.push('schema_resolution');
  }
  const acknowledgementOnly = previous.reasons.length === 1
    && previous.reasons[0] === 'acknowledgement';
  if (
    evidence.schemaStatus === 'unavailable'
    || (evidence.schemaStatus === 'unknown' && !acknowledgementOnly)
  ) {
    evidenceReasons.push('capability_uncertain');
    obligations.push('schema_resolution');
  }
  if (evidence.causalOpen > 0) {
    evidenceReasons.push('causal_obligation_open');
    obligations.push('cross_process_causality');
  }
  if (evidence.missing > 0) evidenceReasons.push('required_evidence_missing');
  const budgetBucket = utilizationBucket(input.dispatchBudgetRatio);
  if (budgetBucket === '80_99' || budgetBucket === '100_plus') {
    evidenceReasons.push('budget_dispatch_threshold');
  }
  const repeatedToolCalls = nonnegativeInteger(
    input.repeatedToolCalls,
    'adaptive_routing_repeated_tool_calls_invalid',
  );
  if (repeatedToolCalls > 0) evidenceReasons.push('repeated_tool_call');
  const evidenceUnresolved = evidenceReasons.some(reason => ![
    'budget_dispatch_threshold',
    'repeated_tool_call',
  ].includes(reason));
  const unresolved = evidenceUnresolved || pendingPreflightUpgrade;
  if (!evidenceUnresolved) evidenceReasons.push('evidence_sufficient');
  const reasons = [...inheritedReasons, ...evidenceReasons];

  let recommendedTier = previous.currentTier;
  let decision: AdaptiveRoutingReceiptV1['decision'] = 'stay';
  if (unresolved) {
    if (
      previous.currentTier === 'L3'
      || budgetBucket === '80_99'
      || budgetBucket === '100_plus'
    ) {
      decision = 'return_gap';
    } else {
      recommendedTier = unique(obligations).length > 0
        ? 'L3'
        : previous.currentTier === 'L0'
          ? 'L1'
          : previous.currentTier === 'L1'
            ? 'L2'
            : 'L3';
      decision = 'recommend_upgrade';
    }
  }
  return snapshotReceipt({
    schemaVersion: 'adaptive_routing@1',
    stage: 'post_evidence',
    requestedMode: previous.requestedMode,
    resolvedMode: previous.resolvedMode,
    classifierSource: previous.classifierSource,
    currentTier: previous.currentTier,
    recommendedTier,
    decision,
    reasons: unique(reasons),
    obligations: unique(obligations),
    evidence,
    budget: {dispatchUtilization: budgetBucket, repeatedToolCalls},
    shadow: true,
    policyFingerprint: previous.policyFingerprint,
    ...(previous.outputCap === undefined ? {} : {outputCap: previous.outputCap}),
  });
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

export function parseAdaptiveRoutingReceipt(
  value: unknown,
): AdaptiveRoutingReceiptV1 {
  const receipt = record(value, 'adaptive_routing_invalid');
  const allowed = new Set([
    'schemaVersion',
    'stage',
    'requestedMode',
    'resolvedMode',
    'classifierSource',
    'currentTier',
    'recommendedTier',
    'decision',
    'reasons',
    'obligations',
    'evidence',
    'budget',
    'shadow',
    'policyFingerprint',
    'outputCap',
    'contentHash',
  ]);
  if (Object.keys(receipt).some(key => !allowed.has(key))) {
    throw new Error('adaptive_routing_unknown_field');
  }
  if (
    receipt.schemaVersion !== 'adaptive_routing@1'
    || !['preflight', 'post_evidence'].includes(String(receipt.stage))
    || !['fast', 'full', 'auto'].includes(String(receipt.requestedMode))
    || !['quick', 'full'].includes(String(receipt.resolvedMode))
    || !['user_explicit', 'hard_rule', 'ai', 'runtime'].includes(
      String(receipt.classifierSource),
    )
    || !Object.keys(TIER_ORDER).includes(String(receipt.currentTier))
    || !Object.keys(TIER_ORDER).includes(String(receipt.recommendedTier))
    || !['stay', 'recommend_upgrade', 'return_gap'].includes(
      String(receipt.decision),
    )
    || receipt.shadow !== true
    || receipt.policyFingerprint !== POLICY_FINGERPRINT
    || !Array.isArray(receipt.reasons)
    || receipt.reasons.some(reason => !REASONS.has(reason))
    || new Set(receipt.reasons).size !== receipt.reasons.length
    || !Array.isArray(receipt.obligations)
    || receipt.obligations.some(item => !OBLIGATIONS.has(item))
    || new Set(receipt.obligations).size !== receipt.obligations.length
  ) {
    throw new Error('adaptive_routing_contract_invalid');
  }
  const evidence = record(receipt.evidence, 'adaptive_routing_evidence_invalid');
  const evidenceKeys = new Set([
    'required',
    'observed',
    'missing',
    'unsupportedClaims',
    'conflicts',
    'identityStatus',
    'schemaStatus',
    'causalOpen',
  ]);
  const evidenceNumbers = [
    evidence.required,
    evidence.observed,
    evidence.missing,
    evidence.unsupportedClaims,
    evidence.conflicts,
    evidence.causalOpen,
  ];
  const budget = record(receipt.budget, 'adaptive_routing_budget_invalid');
  if (
    Object.keys(evidence).some(key => !evidenceKeys.has(key))
    || evidenceNumbers.some(item => !Number.isSafeInteger(item) || (item as number) < 0)
    || evidence.missing !== Math.max(
      0,
      (evidence.required as number) - (evidence.observed as number),
    )
    || ![
      'verified',
      'not_required',
      'ambiguous',
      'conflict',
      'unknown',
    ].includes(String(evidence.identityStatus))
    || !['ready', 'uncertain', 'unavailable', 'unknown'].includes(
      String(evidence.schemaStatus),
    )
    || Object.keys(budget).some(key =>
      key !== 'dispatchUtilization' && key !== 'repeatedToolCalls')
    || !['0_49', '50_79', '80_99', '100_plus'].includes(
      String(budget.dispatchUtilization),
    )
    || !Number.isSafeInteger(budget.repeatedToolCalls)
    || (budget.repeatedToolCalls as number) < 0
    || (
      receipt.outputCap !== undefined
      && (!Number.isSafeInteger(receipt.outputCap) || (receipt.outputCap as number) < 1)
    )
  ) {
    throw new Error('adaptive_routing_nested_contract_invalid');
  }
  const currentTier = receipt.currentTier as AdaptiveEvidenceTier;
  const recommendedTier = receipt.recommendedTier as AdaptiveEvidenceTier;
  if (
    (
      (currentTier === 'L0' || currentTier === 'L1')
      !== (receipt.resolvedMode === 'quick')
    )
    || (
      receipt.decision === 'recommend_upgrade'
      && TIER_ORDER[recommendedTier] <= TIER_ORDER[currentTier]
    )
    || (
      receipt.decision !== 'recommend_upgrade'
      && recommendedTier !== currentTier
    )
    || (
      receipt.stage === 'preflight'
      && (
        evidenceNumbers.some(item => item !== 0)
        || budget.dispatchUtilization !== '0_49'
        || budget.repeatedToolCalls !== 0
        || receipt.decision === 'return_gap'
      )
    )
  ) {
    throw new Error('adaptive_routing_invariant_invalid');
  }
  const {contentHash, ...withoutHash} = receipt;
  if (
    typeof contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(contentHash)
    || canonicalContentHash(withoutHash) !== contentHash
  ) {
    throw new Error('adaptive_routing_content_hash_mismatch');
  }
  return immutableCanonicalSnapshot(receipt as unknown as AdaptiveRoutingReceiptV1);
}
