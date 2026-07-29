// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {FailureCategory} from '../../agentv3/selfImprove/failureTaxonomy';
import type {
  CurationProposalKind,
  CurationProposalTier,
  EffectiveFeedbackV1,
  EvalCaseV1,
  ProposalDelta,
  RunManifestScope,
  RunManifestV1,
} from '../../types/selfEvolution';

export const CURATION_ANALYZER_VERSION = 'curation-analyzer@1';
export const FAILURE_ATTRIBUTOR_VERSION = 'failure-attributor@1';
export const RETIRE_PROPOSER_VERSION = 'retire-injection-proposer@1';
export const CURATION_COORDINATOR_VERSION = 'curation-coordinator@1';
export const PROPOSAL_GENERATOR_VERSION = 'proposal-generator@1';

export interface CurationRunObservation {
  feedback: EffectiveFeedbackV1;
  manifest: RunManifestV1;
  evalCase: EvalCaseV1;
  traceContentHashes: string[];
}

export type FailureAttributionResult =
  | {
      status: 'attributed';
      category: Extract<
        FailureCategory,
        'skill_empty_result' | 'tool_repeated_failure'
      >;
      skillId: string;
      skillContentFingerprint: string;
      dimension: 'insufficient_evidence' | 'too_shallow' | 'too_slow';
      reason:
        | 'unique_skill_empty_result'
        | 'unique_skill_repeated_failure';
    }
  | {
      status: 'inconclusive';
      reason:
        | 'feedback_not_negative'
        | 'feedback_manifest_mismatch'
        | 'dimension_not_uniquely_mapped'
        | 'technical_signal_missing'
        | 'technical_signal_ambiguous';
    };

export interface CurationEvidenceSummary {
  negativeRunIds: string[];
  positiveRunIds: string[];
  labeledCount: number;
  negativeCount: number;
  distinctTraceCount: number;
  distinctSessionCount: number;
}

export interface CurationSourceState {
  scope: RunManifestScope;
  feedback: Array<{
    feedbackId: string;
    currentEventId: string;
    runId?: string;
  }>;
  manifestHashes: string[];
  traceContentHashes: string[];
  targetIdentity: Record<string, string>;
  expectedRegistryFingerprint: string;
  expectedOverlayGeneration: string;
}

export interface CurationCandidate {
  source: 'technical_attribution' | 'retire_injection';
  candidateKey: string;
  kind: CurationProposalKind;
  tier: CurationProposalTier;
  delta: Omit<ProposalDelta, 'operationId' | 'after'> & {
    afterMode: 'generated' | 'none';
  };
  evidence: CurationEvidenceSummary;
  sourceState: CurationSourceState;
  promptData: Record<string, unknown>;
}

export interface SelectedCurationCandidate extends CurationCandidate {
  proposalId: string;
  operationId: string;
  idempotencyKey: string;
  templateContentHash: string;
}

export interface ProposalGeneratedBody {
  title: string;
  rationale: string;
  after?: string;
  expectedEffect: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface CurationDiagnostic {
  code:
    | 'curation_disabled'
    | 'curation_source_rejected'
    | 'curation_scope_mismatch'
    | 'curation_feedback_manifest_missing'
    | 'curation_feedback_manifest_mismatch'
    | 'curation_eval_case_missing'
    | 'curation_eval_case_ambiguous'
    | 'curation_threshold_not_met'
    | 'curation_attribution_inconclusive'
    | 'retire_category_unsupported'
    | 'retire_cohort_inconclusive'
    | 'proposal_input_rejected'
    | 'proposal_review_failed'
    | 'proposal_output_rejected'
    | 'proposal_not_generated';
  details?: Record<string, unknown>;
}
