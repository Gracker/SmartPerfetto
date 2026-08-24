// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type AdaptiveEvidenceTier = 'L0' | 'L1' | 'L2' | 'L3';
export type AdaptiveRoutingStage = 'preflight' | 'post_evidence';
export type AdaptiveRoutingDecision =
  | 'stay'
  | 'recommend_upgrade'
  | 'return_gap';
export type AdaptiveRoutingReasonCode =
  | 'acknowledgement'
  | 'deterministic_direct_evidence'
  | 'quick_semantic_explanation'
  | 'primary_semantic_analysis'
  | 'user_requested_full'
  | 'reference_comparison'
  | 'private_context'
  | 'cross_process_causality'
  | 'identity_ambiguous'
  | 'identity_conflict'
  | 'evidence_conflict'
  | 'unsupported_claim'
  | 'schema_uncertain'
  | 'capability_uncertain'
  | 'causal_obligation_open'
  | 'required_evidence_missing'
  | 'budget_dispatch_threshold'
  | 'repeated_tool_call'
  | 'evidence_sufficient';
export type AdaptiveRoutingObligationCode =
  | 'complete_report'
  | 'reference_comparison'
  | 'private_context'
  | 'cross_process_causality'
  | 'identity_resolution'
  | 'claim_support'
  | 'schema_resolution';

export interface AdaptiveRoutingReceiptV1 {
  schemaVersion: 'adaptive_routing@1';
  stage: AdaptiveRoutingStage;
  requestedMode: 'fast' | 'full' | 'auto';
  resolvedMode: 'quick' | 'full';
  classifierSource: 'user_explicit' | 'hard_rule' | 'ai' | 'runtime';
  currentTier: AdaptiveEvidenceTier;
  recommendedTier: AdaptiveEvidenceTier;
  decision: AdaptiveRoutingDecision;
  reasons: AdaptiveRoutingReasonCode[];
  obligations: AdaptiveRoutingObligationCode[];
  evidence: {
    required: number;
    observed: number;
    missing: number;
    unsupportedClaims: number;
    conflicts: number;
    identityStatus:
      | 'verified'
      | 'not_required'
      | 'ambiguous'
      | 'conflict'
      | 'unknown';
    schemaStatus: 'ready' | 'uncertain' | 'unavailable' | 'unknown';
    causalOpen: number;
  };
  budget: {
    dispatchUtilization: '0_49' | '50_79' | '80_99' | '100_plus';
    repeatedToolCalls: number;
  };
  shadow: true;
  policyFingerprint: string;
  outputCap?: number;
  contentHash: string;
}
