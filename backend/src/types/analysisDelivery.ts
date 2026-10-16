// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import type {AnalysisTurnIntent} from '../agentRuntime/analysisTurnIntent';
import type {AgentRuntimeKind} from '../agentRuntime/runtimeKinds';
import type {ResolvedAnalysisInvestigationRequirements} from './analysisInvestigation';
import type {FinalInvestigationAssessment} from './analysisInvestigationAssessment';
import type {InvestigationEvidenceSnapshot} from '../services/evidence/investigationEvidenceLedger';

export type AnalysisDeliveryEntry = 'runtime_draft' | 'new_finalization' | 'historical_restore';
export type AnalysisAssuranceStatus =
  | 'not_applicable' | 'not_checked' | 'unavailable' | 'coverage_incomplete' | 'passed' | 'failed';
export type AnalysisOutputOrigin = 'sdk_final' | 'assistant_stream' | 'evidence_rendered' | 'runtime_fallback';
export type AnalysisRecoveryKind = 'continue_output' | 'complete_report_content' | 'correct_evidence';

/** The server binds a terminal receipt to the exact candidate it accepted. */
export interface AnalysisCandidateIdentity {
  candidateRef: string;
  runId: string;
  attemptId: string;
  conclusionFingerprint: string;
}

export interface AnalysisCompletion extends AnalysisCandidateIdentity {
  schemaVersion: 1;
  runtimeKind: AgentRuntimeKind;
  status: 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'unknown';
  reason?: 'output_limit' | 'turn_limit' | 'timeout' | 'budget_limit' | 'provider_error' | 'cancelled';
  sdkFinishReason?: string;
}

/** Never concatenate this into the body whose claims and completion were checked. */
export interface AnalysisRuntimeAppendix {
  schemaVersion: 1;
  origin: 'runtime_fallback';
  sourceCandidate: AnalysisCandidateIdentity;
  text: string;
  reason?: AnalysisCompletion['reason'];
}

export type AnalysisReportRequirementCondition =
  | {kind: 'semantic'; description: string}
  | {kind: 'unresolved'; reason: 'legacy_trigger_patterns' | 'invalid_condition'};

export interface AnalysisReportRequirement {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  /** Absent means unconditional for a scene-wide report. */
  condition?: AnalysisReportRequirementCondition;
}

export type AnalysisMissingReportSection = Pick<AnalysisReportRequirement, 'id' | 'label' | 'description'>;

export interface PinnedAnalysisReportRequirements {
  sceneId: string;
  registryFingerprint: string;
  requirements: readonly AnalysisReportRequirement[];
}

export interface AnalysisReportBinding extends AnalysisCandidateIdentity {
  conclusionContractFingerprint: string;
  evidenceFingerprint: string;
  requirementsFingerprint: string;
  registryFingerprint: string;
  intentFingerprint: string;
  caseRetrievalFingerprint?: string;
}

export interface AnalysisReportRequirementAssessment {
  requirementId: string;
  applicability: 'applicable' | 'not_applicable' | 'unknown';
  coverage: 'covered' | 'missing' | 'unknown';
  /** Offsets in the exact accepted body, not a preview or a rewritten report. */
  contentLocations?: ReadonlyArray<{start: number; end: number}>;
  claimIds?: readonly string[];
}

/** Produced by the shared final semantic review, never by a section regex. */
export interface FinalReportAssessment {
  schemaVersion: 1;
  binding: AnalysisReportBinding;
  status: 'not_checked' | 'unavailable' | 'coverage_incomplete' | 'checked';
  requirements: readonly AnalysisReportRequirementAssessment[];
}

export type EvidenceRenderedProof = {
  kind: 'verified_facts';
  candidate: AnalysisCandidateIdentity;
  claimIds: readonly string[];
  claimsFingerprint: string;
  verificationFingerprint: string;
  evidenceFingerprint: string;
} | {
  kind: 'acknowledgement';
  candidate: AnalysisCandidateIdentity;
  intentFingerprint: string;
  evidence: 'not_applicable';
};

/** Issued with the actual verification result for the current evidence snapshot. */
export interface AnalysisVerificationBinding {
  candidate: AnalysisCandidateIdentity;
  claimsFingerprint: string;
  evidenceFingerprint: string;
  verificationFingerprint: string;
}

export interface AnalysisSourceVerificationBinding extends AnalysisVerificationBinding {
  conclusionContractFingerprint: string;
  sourceUseFingerprint: string;
  sourceScopeFingerprint?: string;
}

interface CurrentAnalysisDeliveryContext {
  /** Trusted inputs come from the server's current run, not parsed output. */
  acceptedCandidate?: AnalysisCandidateIdentity;
  completion?: AnalysisCompletion;
  outputOrigin?: AnalysisOutputOrigin;
  turnIntent?: AnalysisTurnIntent;
  evidenceRenderedProof?: EvidenceRenderedProof;
  evidenceFingerprint?: string;
  claimVerificationBinding?: AnalysisVerificationBinding;
  sourceVerificationBinding?: AnalysisSourceVerificationBinding;
  sourceUseFingerprint?: string;
  sourceScopeFingerprint?: string;
  reportRequirements?: PinnedAnalysisReportRequirements;
  reportAssessment?: FinalReportAssessment;
  investigationRequirements?: ResolvedAnalysisInvestigationRequirements;
  investigationEvidence?: InvestigationEvidenceSnapshot;
  investigationAssessment?: FinalInvestigationAssessment;
}

export type AnalysisDeliveryContext =
  | {entry: 'historical_restore'}
  | (CurrentAnalysisDeliveryContext & {entry: 'runtime_draft'})
  | (CurrentAnalysisDeliveryContext & {
      entry: 'new_finalization';
      acceptedCandidate: AnalysisCandidateIdentity;
      /** Issued only from current source-free declarations and the actual run ledger. */
      sourceApplicability?: 'not_applicable';
    });

export interface AnalysisDeliveryAssurance {
  schemaVersion: 1;
  entry: AnalysisDeliveryEntry;
  completion: AnalysisAssuranceStatus;
  claims: AnalysisAssuranceStatus;
  source: AnalysisAssuranceStatus;
  identity: AnalysisAssuranceStatus;
  report: AnalysisAssuranceStatus;
  /** Independent of native completion, report formatting and claim truth. */
  investigation?: AnalysisAssuranceStatus;
  investigationEvidence?: AnalysisAssuranceStatus;
}

/** Conservative content address; changing even whitespace creates a new body. */
export function analysisDeliveryFingerprint(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined',
  ).digest('hex');
}

export function sameAnalysisCandidate(
  left: AnalysisCandidateIdentity | undefined,
  right: AnalysisCandidateIdentity | undefined,
  conclusion: string,
): boolean {
  return Boolean(left && right && [left.candidateRef, left.runId, left.attemptId].every(id =>
    typeof id === 'string' && id.trim().length > 0) &&
    left.candidateRef === right.candidateRef && left.runId === right.runId &&
    left.attemptId === right.attemptId &&
    left.conclusionFingerprint === right.conclusionFingerprint &&
    left.conclusionFingerprint === analysisDeliveryFingerprint(conclusion));
}

/** Legacy regex/recovery copies do not participate in the semantic contract. */
export function reportRequirementsFingerprint(pin: PinnedAnalysisReportRequirements): string {
  return analysisDeliveryFingerprint(pin.requirements.map(({id, label, description, required, condition}) => ({
    id, label, ...(description ? {description} : {}), required, ...(condition ? {condition} : {}),
  })));
}
