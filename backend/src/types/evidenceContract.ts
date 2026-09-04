// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type EvidenceContractVersion = 'evidence_contract@1';
export type TraceTimestampNs = string | number;

export type EvidenceProducerKind =
  | 'execute_sql'
  | 'execute_sql_on'
  | 'invoke_skill'
  | 'compare_skill'
  | 'fetch_artifact'
  | 'analysis_snapshot'
  | 'manual';

export type EvidenceTraceSide = 'current' | 'reference' | 'unknown';
export type EvidencePaneSide = 'left' | 'right' | 'top' | 'bottom';

export type EvidenceIdentityRole =
  | 'app_main'
  | 'render_thread'
  | 'binder_thread'
  | 'producer'
  | 'surfaceflinger'
  | 'hwc'
  | 'unknown';

export type EvidenceSupportLevel = 'verified' | 'partial' | 'inference' | 'unsupported';
export type EvidenceRelationSchemaVersion = 'evidence_relation@1';
export type EvidenceRelationCandidateSchemaVersion = 'evidence_relation_candidate@1';
export type EvidenceRelationKindV1 =
  | 'overlap'
  | 'wakeup'
  | 'blocking_state'
  | 'binder_peer'
  | 'lock_owner'
  | 'comparison_delta'
  | 'derived';
export type EvidenceRelationDirectionV1 = 'subject_to_object' | 'object_to_subject' | 'symmetric';
export type EvidenceRelationVerificationStatusV1 = 'verified' | 'candidate' | 'rejected';
export type EvidenceRelationEvaluationV1 = 'not_configured' | 'verified' | 'candidate' | 'rejected' | 'missing';
export type EvidenceRelationReasonCodeV1 =
  | 'relation_anchor_missing'
  | 'relation_endpoint_value_mismatch'
  | 'trace_context_missing'
  | 'trace_context_mismatch'
  | 'identity_conflict'
  | 'identity_evidence_missing'
  | 'proof_anchor_missing'
  | 'proof_binding_missing'
  | 'proof_binding_mismatch'
  | 'binary_proof_verified'
  | 'overlap_range_missing'
  | 'overlap_range_invalid'
  | 'overlap_disjoint'
  | 'overlap_verified'
  | 'comparison_side_mismatch'
  | 'comparison_metric_missing'
  | 'comparison_metric_invalid'
  | 'comparison_delta_mismatch'
  | 'comparison_delta_verified'
  | 'derived_not_verified';

export type ClaimKindV1 =
  | 'numeric'
  | 'categorical'
  | 'identity'
  | 'time_range'
  | 'causal'
  | 'comparison'
  | 'inference'
  | 'recommendation';

export interface EvidenceContextV1 {
  traceId: string;
  traceSide?: EvidenceTraceSide;
  paneSide?: EvidencePaneSide;
  toolCallId?: string;
  sourceToolCallId?: string;
  producerKind: EvidenceProducerKind;
  skillId?: string;
  stepId?: string;
  queryHash?: string;
  queryReviewId?: string;
  sqlTextRef?: string;
  paramsHash?: string;
  /** Canonical artifact id used by Evidence Contract consumers. */
  artifactId?: string;
  /** Compatibility alias from existing artifact rows; normalize to artifactId. */
  sourceArtifactId?: string;
  planPhaseId?: string;
}

export interface EvidenceTimeRangeV1 {
  startTs: TraceTimestampNs;
  endTs: TraceTimestampNs;
  unit: 'ns';
  source: 'row' | 'params' | 'selection' | 'derived';
}

export interface EvidenceIdentityV1 {
  packageName?: string;
  processName?: string;
  threadName?: string;
  upid?: number;
  utid?: number;
  pid?: number;
  tid?: number;
  role?: EvidenceIdentityRole;
  identityRefId?: string;
  confidence?: number;
  status?: 'verified' | 'ambiguous' | 'weak' | 'missing' | 'not_required' | 'error';
  warnings?: string[];
}

export interface EvidenceCellV1 {
  sourceRef?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column: string;
  /** Expected value stated by the claim reference, when the claim is value-bearing. */
  value?: string | number | boolean;
  /** Actual primitive value read from the cited evidence row. */
  actualValue?: string | number | boolean;
  isSqlNull?: boolean;
  displayValue?: string;
  unit?: string;
}

export interface EvidenceAnchorV1 {
  anchorId: string;
  version: EvidenceContractVersion;
  evidenceRefId: string;
  context: EvidenceContextV1;
  cells?: EvidenceCellV1[];
  timeRange?: EvidenceTimeRangeV1;
  identity?: EvidenceIdentityV1;
  confidence?: number;
  /**
   * Limitation the evidence row declares about itself, verbatim from the
   * skill's `claim_boundary` column (for example
   * `event_count_is_not_frame_count_or_jank_count`).
   *
   * Carried onto every claim citing that row so the boundary stays auditable
   * instead of depending on the model having noticed it in the raw row.
   */
  claimBoundary?: string;
  missing?: boolean;
  missingReason?: string;
}

export interface EvidenceRelationEndpointV1 {
  evidenceRefId?: string;
  sourceToolCallId?: string;
  sourceRef?: string;
  artifactId?: string;
  sourceArtifactId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  value?: string | number | boolean;
}

export interface EvidenceRelationProofBindingV1 {
  endpointColumn: string;
  proofColumn: string;
}

export interface EvidenceRelationProofBindingsV1 {
  subject: EvidenceRelationProofBindingV1;
  object: EvidenceRelationProofBindingV1;
}

export interface EvidenceRelationCandidateV1 {
  schemaVersion: EvidenceRelationCandidateSchemaVersion;
  id: string;
  kind: EvidenceRelationKindV1;
  direction: EvidenceRelationDirectionV1;
  subject: EvidenceRelationEndpointV1;
  object?: EvidenceRelationEndpointV1;
  proof?: EvidenceRelationEndpointV1;
  proofBindings?: EvidenceRelationProofBindingsV1;
  metricColumn?: string;
  value?: string | number | boolean;
  unit?: string;
  deltaDirection?: 'current_minus_reference';
}

export interface EvidenceRelationV1 {
  schemaVersion: EvidenceRelationSchemaVersion;
  id: string;
  kind: EvidenceRelationKindV1;
  direction: EvidenceRelationDirectionV1;
  verificationStatus: EvidenceRelationVerificationStatusV1;
  reasonCode: EvidenceRelationReasonCodeV1;
  subjectAnchorId: string;
  objectAnchorId?: string;
  proofAnchorId?: string;
  relationAnchorId?: string;
  directEvidenceAnchorIds: string[];
  proofBindings?: EvidenceRelationProofBindingsV1;
  metricColumn?: string;
  value?: string | number | boolean;
  isSqlNull?: boolean;
  unit?: string;
  deltaDirection?: 'current_minus_reference';
  supportLevel: EvidenceSupportLevel;
  reason?: string;
}

export interface ClaimSupportV1 {
  claimId: string;
  kind: ClaimKindV1;
  text: string;
  anchors: EvidenceAnchorV1[];
  relationAnchors?: EvidenceAnchorV1[];
  relations?: EvidenceRelationV1[];
  relationEvaluation?: EvidenceRelationEvaluationV1;
  supportLevel: EvidenceSupportLevel;
  inferenceReason?: string;
}

export interface EvidenceContractV1 {
  schemaVersion: EvidenceContractVersion;
  anchors: EvidenceAnchorV1[];
  relations: EvidenceRelationV1[];
  claimSupport: ClaimSupportV1[];
  identityRefIds: string[];
  warnings: string[];
}
