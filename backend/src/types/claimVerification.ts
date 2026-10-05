// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Version 1 remains readable in persisted results; new verification emits version 2. */
export type ClaimVerificationSchemaVersion = 'claim_verifier@1' | 'claim_verifier@2';

export type ClaimVerificationStatus = 'passed' | 'failed' | 'partial' | 'not_checked';
export type ClaimVerificationPolicy = 'block' | 'retry' | 'warn_only' | 'record_only';
export type ClaimVerificationClaimStatus =
  | 'verified'
  | 'partial'
  | 'inference'
  | 'unsupported'
  | 'not_checked';

export type ClaimReferenceVerificationStatus =
  | 'matched'
  | 'missing'
  | 'ambiguous'
  | 'value_mismatch'
  | 'ineligible'
  | 'not_checked';

/** The issue code a failing reference carries: `claim_reference_<status>`. */
export function claimReferenceIssueCode(status: ClaimReferenceVerificationStatus): string {
  return `claim_reference_${status}`;
}

export interface ClaimReferenceVerificationResult {
  evidenceRefId?: string;
  sourceRef?: string;
  artifactId?: string;
  sourceToolCallId?: string;
  anchorId?: string;
  column?: string;
  status: ClaimReferenceVerificationStatus;
  message?: string;
}

export type DeterministicClaimProofKind =
  | 'numeric_cell'
  | 'captured_cell'
  /** Historical results only: no current rule produces a source-location proof. */
  | 'source_location'
  | 'interval_overlap'
  | 'comparison_delta'
  | 'none';

/** Original native row used by a finite proof; no occurrence or causal assertion is implied. */
export interface DeterministicNativeRowIdentity {
  anchorId: string;
  evidenceRefId: string;
  captureId: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  relation: string;
  idColumn: string;
  id: number;
  schemaFingerprint: string;
}

export interface DeterministicClaimProof {
  kind: DeterministicClaimProofKind;
  status: 'proved' | 'candidate' | 'rejected' | 'not_checked';
  /** Stable machine-readable explanation; never inferred from the claim body. */
  reason: string;
  anchorIds: string[];
  evidenceRefIds: string[];
  nativeRows?: DeterministicNativeRowIdentity[];
}

export interface ClaimPropositionCoverage {
  status: 'complete' | 'partial' | 'none';
  covered: string[];
  uncovered: string[];
  reason: string;
}

export interface ClaimVerificationClaimResult {
  claimId: string;
  status: ClaimVerificationClaimStatus;
  /** Compatibility alias. A matched cell alone never verifies a proposition in v2. */
  referenceResults?: ClaimReferenceVerificationResult[];
  referenceCells?: ClaimReferenceVerificationResult[];
  deterministicProof?: DeterministicClaimProof;
  propositionCoverage?: ClaimPropositionCoverage;
}

export interface ClaimVerificationClaimResultV2 extends ClaimVerificationClaimResult {
  /** Cell matching is independent of typed proof and prose/semantics agreement. */
  referenceCells: ClaimReferenceVerificationResult[];
  /** A proved typed declaration still requires the shared semantic assessment. */
  deterministicProof: DeterministicClaimProof;
  /** Complete means the typed declaration, never the surrounding prose, is covered. */
  propositionCoverage: ClaimPropositionCoverage;
}

export interface ClaimVerificationIssue {
  claimId: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  evidenceRefId?: string;
}

export interface ClaimVerificationResult {
  schemaVersion: ClaimVerificationSchemaVersion;
  status: ClaimVerificationStatus;
  policy: ClaimVerificationPolicy;
  notCheckedReason?: string;
  /** Closed-vocabulary triage detail for `notCheckedReason` (issue codes, transport facts). */
  notCheckedDetail?: string;
  /** Compatibility boolean. Must equal status === 'passed'. */
  passed: boolean;
  checkedClaimCount: number;
  unsupportedClaimCount: number;
  claimResults: ClaimVerificationClaimResult[];
  issues: ClaimVerificationIssue[];
}

export interface ClaimVerificationResultV2 extends ClaimVerificationResult {
  schemaVersion: 'claim_verifier@2';
  claimResults: ClaimVerificationClaimResultV2[];
}
