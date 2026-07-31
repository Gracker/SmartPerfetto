// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION =
  'external_issue_opportunity@1' as const;
export const EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION =
  'external_issue_review@1' as const;
export const EXTERNAL_ISSUE_DRAFT_SCHEMA_VERSION =
  'external_issue_draft@1' as const;

export type ExternalIssueSignalKind =
  | 'unsupported_claim'
  | 'uncertain_claim'
  | 'partial_quality_gate'
  | 'skill_error'
  | 'skill_empty_result'
  | 'low_scene_confidence'
  | 'identity_unresolved'
  | 'report_generation_failed'
  | 'user_reported_inaccuracy';

export type ExternalIssueSignalSeverity = 'info' | 'warning' | 'error';

export interface ExternalIssueReferencesV1 {
  claimIds: string[];
  findingIds: string[];
  evidenceRefIds: string[];
  skillIds: string[];
}

export interface ExternalIssueSignalV1 {
  signalId: string;
  kind: ExternalIssueSignalKind;
  severity: ExternalIssueSignalSeverity;
  summary: string;
  references: ExternalIssueReferencesV1;
}

export type ExternalIssueReviewUnavailableReason =
  | 'private_analysis'
  | 'legacy_provider_pin_missing'
  | 'provider_snapshot_changed'
  | 'provider_not_found'
  | 'provider_credentials_unavailable'
  | 'runtime_not_supported'
  | 'source_artifacts_unavailable';

export interface ExternalIssueOpportunityV1 {
  schemaVersion: typeof EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION;
  runId: string;
  runManifestId: string;
  resultSnapshotId?: string;
  status: 'available' | 'not_needed' | 'disabled';
  signals: ExternalIssueSignalV1[];
  agentReviewAvailable: boolean;
  agentReviewUnavailableReason?: ExternalIssueReviewUnavailableReason;
}

export type ExternalIssueDecision =
  | 'report'
  | 'needs_user_input'
  | 'needs_verification'
  | 'not_reportable';

export type ExternalIssueOwnership =
  | 'analysis'
  | 'skill'
  | 'strategy'
  | 'runtime'
  | 'trace_data'
  | 'product_ui'
  | 'unknown';

export type ExternalIssueContributionKind =
  | 'bug_report'
  | 'skill_improvement'
  | 'strategy_improvement'
  | 'runtime_compatibility'
  | 'documentation'
  | 'ui_feedback'
  | 'trace_fixture'
  | 'none';

export interface ExternalIssueUserQuestionV1 {
  questionId: string;
  prompt: string;
  required: boolean;
}

export interface ExternalIssueDraftSeedV1 {
  problemStatement: string;
  expectedBehavior: string;
  reproductionHint: string;
  suggestedContribution: string;
}

export interface ExternalIssueReviewCandidateV1 {
  candidateId: string;
  decision: ExternalIssueDecision;
  ownership: ExternalIssueOwnership;
  contributionKind: ExternalIssueContributionKind;
  confidence: 'low' | 'medium' | 'high';
  title: string;
  agentAssessment: string;
  basisSignalIds: string[];
  references: ExternalIssueReferencesV1;
  missingEvidence: string[];
  userQuestions: ExternalIssueUserQuestionV1[];
  draftSeed: ExternalIssueDraftSeedV1;
}

export interface ExternalIssueReviewV1 {
  schemaVersion: typeof EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION;
  runId: string;
  runManifestId: string;
  source: 'agent' | 'deterministic_fallback';
  model?: string;
  fallbackReason?: ExternalIssueReviewUnavailableReason | 'agent_invalid';
  candidates: ExternalIssueReviewCandidateV1[];
  /**
   * Short-lived server proof issued by the review endpoint. The draft endpoint
   * requires it so clients cannot forge or alter an Agent/fallback review.
   */
  serverAttestation?: string;
}

export interface ExternalIssueUserAnswerV1 {
  questionId: string;
  answer: string;
}

export interface ExternalIssueDraftV1 {
  schemaVersion: typeof EXTERNAL_ISSUE_DRAFT_SCHEMA_VERSION;
  runId: string;
  candidateId: string;
  title: string;
  body: string;
  githubUrl: string;
  fingerprint: string;
  redactions: string[];
  notSubmitted: true;
}
