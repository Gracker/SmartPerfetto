// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CaseKnowledgeReportRecommendation} from '../../types/caseKnowledge';
import type {
  SourceClaimBindingV1,
  SourceReferenceV1,
  SourceUseDecisionV1,
} from '../../services/codebase/sourceUseDecision';

export type ConclusionOutputMode = 'initial_report' | 'focused_answer' | 'need_input';
export type ConclusionClusterOutputMode = 'required' | 'optional' | 'none';
export type ConclusionClusterFrameListMode = 'none' | 'top' | 'full';
export type ConclusionClaimKind =
  | 'numeric'
  | 'categorical'
  | 'time_range'
  | 'identity'
  | 'causal'
  | 'comparison'
  | 'inference'
  | 'recommendation';
export type ConclusionClaimSupportLevel = 'verified' | 'partial' | 'inference' | 'unsupported';

export interface ConclusionContractConclusionItem {
  rank: number;
  statement: string;
  confidencePercent?: number;
  trigger?: string;
  supply?: string;
  amplification?: string;
}

export interface ConclusionContractClusterItem {
  cluster: string;
  description?: string;
  frames?: number;
  percentage?: number;
  frameRefs?: string[];
  omittedFrameRefs?: number;
}

export interface ConclusionContractClusterPolicy {
  outputMode: ConclusionClusterOutputMode;
  frameListMode: ConclusionClusterFrameListMode;
  maxFramesPerCluster?: number;
}

export interface ConclusionContractEvidenceItem {
  conclusionId: string;
  text: string;
}

export interface ConclusionContractClaimReference {
  evidenceRefId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  value?: string | number | boolean;
  sourceRef?: string;
  sourceToolCallId?: string;
  /** Canonical durable artifact id for artifact-backed claims. */
  artifactId?: string;
  /** Compatibility alias from existing artifact rows; normalize to artifactId. */
  sourceArtifactId?: string;
}

export interface ConclusionContractClaimItem {
  id?: string;
  conclusionId?: string;
  text: string;
  kind?: ConclusionClaimKind;
  references: ConclusionContractClaimReference[];
  artifactRefs?: Array<{ artifactId: string; rowIndex?: number; rowSelector?: Record<string, unknown> }>;
  relationRefs?: string[];
  /** Model-produced hint only; visible verdicts come from verifier output. */
  supportLevel?: ConclusionClaimSupportLevel;
}

export interface ConclusionContractMetadata {
  confidencePercent?: number;
  rounds?: number;
  clusterPolicy?: ConclusionContractClusterPolicy;
  sceneId?: string;
  /**
   * Claims were derived by matching the final narrative against captured
   * DataEnvelope cells, not emitted explicitly by the model.
   */
  derivedFromNarrativeEvidenceMatch?: boolean;
  claimDerivation?: 'explicit_model_contract' | 'narrative_evidence_match';
  claimVerificationScope?: 'explicit_claims' | 'sampled_narrative_evidence';
  replacedUnresolvableProviderClaims?: boolean;
}

export interface ConclusionContract {
  schemaVersion: 'conclusion_contract_v1';
  mode: ConclusionOutputMode;
  conclusions: ConclusionContractConclusionItem[];
  clusters: ConclusionContractClusterItem[];
  evidenceChain: ConclusionContractEvidenceItem[];
  claims?: ConclusionContractClaimItem[];
  sourceUseDecision?: SourceUseDecisionV1;
  sourceReferences?: SourceReferenceV1[];
  sourceClaimBindings?: SourceClaimBindingV1[];
  /**
   * Curated case-library recommendations selected by a retrieval/citation path.
   * Report rendering consumes this structured projection; retrieval remains
   * responsible for evidence-signature gating.
   */
  caseRecommendations?: CaseKnowledgeReportRecommendation[];
  uncertainties: string[];
  nextSteps: string[];
  metadata?: ConclusionContractMetadata;
}
