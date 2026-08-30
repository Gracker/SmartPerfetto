// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ApplicationBuildIdentity} from '../services/applicationUpdate/types';
import type {AgentRuntimeKind} from '../agentRuntime/runtimeKinds';
import type {
  RuntimePerformanceReceiptV1,
  RuntimePerformanceRecorder,
} from '../agentRuntime/runtimePerformance';
import type {CapabilityManifestAttributionV1} from './capabilityManifest';
import type {AdaptiveRoutingReceiptV1} from './adaptiveRouting';
import type {
  PhaseHint,
  StrategyRegistryContribution,
} from '../agentv3/strategyLoader';
import type {
  DisplayConfig,
  SkillStep,
} from '../services/skillEngine/types';

export interface SelfEvolutionConfig {
  enabled: boolean;
  applyEnabled: boolean;
}

export type SelfEvolutionConfigErrorCode =
  | 'apply_requires_self_evolution_enabled'
  | 'apply_requires_persistent_user_data'
  | 'apply_blocked_by_legacy_migration'
  | 'apply_blocked_by_invalid_build_identity_state'
  | 'apply_blocked_by_invalid_current_build_identity';

export interface SelfEvolutionConfigIssue {
  code: SelfEvolutionConfigErrorCode;
  message: string;
}

export interface SelfEvolutionConfigValidation {
  ok: boolean;
  requestedConfig: SelfEvolutionConfig;
  effectiveConfig: SelfEvolutionConfig;
  warnings: SelfEvolutionConfigIssue[];
  errors: SelfEvolutionConfigIssue[];
}

export type SelfEvolutionPersistenceUnavailableReason =
  | 'not_initialized'
  | 'external_data_dir_not_configured'
  | 'data_root_not_writable'
  | 'package_root_unavailable'
  | 'data_root_inside_package'
  | 'docker_data_root_not_mounted';

export interface SelfEvolutionPersistenceCapability {
  persistence: 'available' | 'unavailable';
  reason?: SelfEvolutionPersistenceUnavailableReason;
  configured: boolean;
  writable: boolean;
  outsidePackage: boolean;
  externalMount: boolean;
  dataRoot: string;
  packageRoot: string;
  checkedAt: number;
  errorCode?: string;
}

export type LegacySelfImproveMigrationStatus =
  | 'not_attempted_persistence_unavailable'
  | 'source_not_found'
  | 'source_matches_destination'
  | 'already_migrated'
  | 'blocked_destination_exists'
  | 'migrated'
  | 'failed';

export interface LegacySelfImproveMigrationResult {
  status: LegacySelfImproveMigrationStatus;
  sourcePath?: string;
  destinationPath?: string;
  errorCode?: string;
}

export interface LastReconciledBuildIdentityRecordV1 {
  schemaVersion: 1;
  lastReconciledBuildIdentity: ApplicationBuildIdentity;
  reconciledAt: string;
}

export type BuildIdentityStateStatus =
  | 'not_loaded_persistence_unavailable'
  | 'missing'
  | 'loaded'
  | 'invalid';

export interface BuildIdentityStateSnapshot {
  status: BuildIdentityStateStatus;
  record: LastReconciledBuildIdentityRecordV1 | null;
  errorCode?: string;
}

export interface SelfEvolutionLifecycleSnapshot {
  initializedAt: number;
  requestedConfig: SelfEvolutionConfig;
  effectiveConfig: SelfEvolutionConfig;
  persistence: SelfEvolutionPersistenceCapability;
  migration: LegacySelfImproveMigrationResult;
  currentBuildIdentity: ApplicationBuildIdentity;
  buildIdentityState: BuildIdentityStateSnapshot;
  warnings: SelfEvolutionConfigIssue[];
  errors: SelfEvolutionConfigIssue[];
}

export interface SelfEvolutionMetrics {
  requested: SelfEvolutionConfig;
  effective: SelfEvolutionConfig;
  persistence: 'available' | 'unavailable';
  persistenceReason?: SelfEvolutionPersistenceUnavailableReason;
  migration: LegacySelfImproveMigrationStatus;
  migrationErrorCode?: string;
  buildIdentityState: BuildIdentityStateStatus;
  currentBuildIdentity: ApplicationBuildIdentity;
  lastReconciledBuildIdentity: ApplicationBuildIdentity | null;
  warnings: SelfEvolutionConfigIssue[];
  errors: SelfEvolutionConfigIssue[];
}

export interface RunManifestScope {
  tenantId: string;
  workspaceId: string;
}

export interface SkillOverlayDeltaV1 {
  schemaVersion: 1;
  overlayId: string;
  baseSkillId: string;
  baseFingerprint: string;
  proposalId: string;
  createdAt: string;
  scope: RunManifestScope;
  operations: SkillOverlayOperation[];
}

export type SkillOverlayOperation =
  | AppendStepsOperation
  | SetDisplayOperation
  | SetMetadataOperation;

export interface AppendStepsOperation {
  op: 'append_steps';
  operationId: string;
  steps: SkillStep[];
}

export interface SetDisplayOperation {
  op: 'set_display';
  operationId: string;
  display: DisplayConfig;
}

export interface SetMetadataOperation {
  op: 'set_metadata';
  operationId: string;
  meta?: {
    description?: string;
    tags?: string[];
  };
  triggers?: {
    keywords?: {
      zh?: string[];
      en?: string[];
    };
    patterns?: string[];
  };
}

export interface RunManifestIdentity {
  runId: string;
  sessionId: string;
  scope: RunManifestScope;
}

export type RunSkillOrigin =
  | 'built_in'
  | 'external_pack'
  | 'evolution_overlay';

export interface RunSkillAttribution {
  skillId: string;
  version: string;
  contentFingerprint: string;
  origin: RunSkillOrigin;
  packId?: string;
  packVersion?: string;
  trustState?: 'local_unverified' | 'approved';
  appliedOverlayIds: string[];
  invocations: number;
  okCount: number;
  emptyResultCount: number;
  errorCount: number;
}

export interface RunInjectionReference {
  id: string;
  contentHash: string;
}

export interface RunInjectionAttribution {
  patterns: RunInjectionReference[];
  skillNotes: RunInjectionReference[];
  cases: RunInjectionReference[];
  phaseHints: RunInjectionReference[];
  knowledgeDocs: RunInjectionReference[];
}

export type RunInjectionCategory = keyof RunInjectionAttribution;

export interface RunManifestV1 {
  schemaVersion: 1;
  runManifestId: string;
  runId: string;
  sessionId: string;
  sealedAt: number;
  scope: RunManifestScope;
  actor?: {userId?: string};

  sceneType: string;
  sceneConfidence?: number;
  architecture?: string;
  strategyId?: string;
  strategyContentHash?: string;
  promptTemplateHashes: RunInjectionReference[];

  skills: RunSkillAttribution[];
  skillRegistryFingerprint: string;
  evolutionOverlayGeneration: string;
  sqlStatementCount: number;
  sqlErrorCount: number;

  runtime: AgentRuntimeKind;
  providerId: string | null;
  /** Non-secret hash of the provider/runtime configuration pinned to this run. */
  providerSnapshotHash?: string;
  model?: string;
  outputLanguage: string;
  toolAllowlistHash: string;
  featureFlagSnapshot: Record<string, string | number | boolean>;

  analysisMode: 'fast' | 'full' | 'auto';
  resolvedMode: 'quick' | 'full';
  adaptiveRouting?: AdaptiveRoutingReceiptV1;
  capabilityFlags: string[];
  capabilityManifest?: CapabilityManifestAttributionV1;
  performance?: RuntimePerformanceReceiptV1;

  referenceTraceId?: string;
  comparisonIdentity?: string;
  resumeAncestry?: {
    parentRunId?: string;
    resumedFromSnapshotId?: string;
  };

  injections: RunInjectionAttribution;
  turns: number;
  wallclockMs: number;
}

export const FEEDBACK_NEGATIVE_DIMENSIONS = [
  'wrong_conclusion',
  'missed_root_cause',
  'insufficient_evidence',
  'wrong_scope',
  'too_shallow',
  'too_verbose',
  'too_slow',
  'bad_format',
  'wrong_identity',
  'other',
] as const;

export type FeedbackNegativeDimension =
  (typeof FEEDBACK_NEGATIVE_DIMENSIONS)[number];

export const FEEDBACK_POSITIVE_DIMENSIONS = [
  'accurate_root_cause',
  'good_evidence',
  'actionable',
  'concise',
  'fast',
] as const;

export type FeedbackPositiveDimension =
  (typeof FEEDBACK_POSITIVE_DIMENSIONS)[number];

export type FeedbackDimension =
  | FeedbackNegativeDimension
  | FeedbackPositiveDimension;

export type EvalScalar = string | number | boolean | null;

export interface EvalRequiredFactV1 {
  id: string;
  statement: string;
  evaluation: 'deterministic' | 'semantic';
  observationKey?: string;
  expected?: EvalScalar;
}

export interface EvalNumericExpectationV1 {
  id: string;
  observationKey: string;
  expected: number;
  unit: string;
  absoluteTolerance?: number;
  relativeTolerance?: number;
}

export interface EvalRequiredEvidenceV1 {
  id: string;
  kind:
    | 'coverage_expectation'
    | 'evidence_ref'
    | 'skill'
    | 'sql'
    | 'relation';
  locator: string;
}

export interface EvalForbiddenClaimV1 {
  id: string;
  contains: string[];
  reason: string;
}

export interface EvalAllowedGapV1 {
  id: string;
  code: string;
  requiresMissingEvidence: string[];
}

export interface EvalIdentityExpectationV1 {
  id: string;
  observationKey: string;
  expected: EvalScalar;
}

export interface EvalCausalEdgeExpectationV1 {
  id: string;
  subject: string;
  relation: string;
  object: string;
  minimumLevel: 'correlation' | 'mechanism';
}

export interface EvalGroundTruthV1 {
  schemaVersion: 1;
  requiredFacts: EvalRequiredFactV1[];
  numericExpectations: EvalNumericExpectationV1[];
  requiredEvidence: EvalRequiredEvidenceV1[];
  forbiddenClaims: EvalForbiddenClaimV1[];
  allowedGaps: EvalAllowedGapV1[];
  identityExpectations: EvalIdentityExpectationV1[];
  causalEdges: EvalCausalEdgeExpectationV1[];
}

export interface EvalGoldenScoreV1 {
  passed: boolean;
  assertionCount: number;
  passedAssertions: number;
  failedAssertions: number;
  notEvaluableAssertions: number;
  blockers: string[];
  contentHash: string;
}

export interface EvalCaseV1 {
  schemaVersion: 1;
  caseId: string;
  evalSetId: string;
  origin: 'labeled_run' | 'synthetic_seed' | 'manual_golden';
  sourceRunId?: string;
  scope: RunManifestScope;
  traces: Array<{
    role: 'current' | 'reference';
    corpusId?: string;
    catalogAlias?: string;
    contentHash: string;
  }>;
  query: string;
  analysisMode: 'fast' | 'full';
  expectedScene?: string;
  label?: {
    rating: 'positive' | 'negative';
    dimensions: FeedbackDimension[];
  };
  goldenPoints?: string[];
  groundTruth?: EvalGroundTruthV1;
  expectedRubricVersion?: string;
  split: 'train' | 'validation' | 'holdout';
  createdAt: string;
}

export interface EvalPinnedEnvironmentV1 {
  runtime: AgentRuntimeKind;
  providerId: string | null;
  model?: string;
  outputLanguage: string;
  toolAllowlistHash: string;
  injections: 'on' | 'off' | 'selective';
  overlayGeneration: string;
}

export interface EvalScoreV1 {
  schemaVersion: 1;
  caseId: string;
  evalSetId: string;
  runId: string;
  runManifestId: string;
  attempt: number;
  role: 'baseline' | 'candidate';
  candidateId?: string;
  scope: RunManifestScope;
  pinned: EvalPinnedEnvironmentV1;
  availability: 'available' | 'unavailable';
  golden?: EvalGoldenScoreV1;
  l0: {
    runOk: boolean;
    sqlErrorFree: boolean;
    reportContractPass: boolean;
    skillCrashFree: boolean;
  };
  l1: {
    claimVerifiedRatio: number;
    unsupportedClaims: number;
    evidenceAnchors: number;
  };
  l2?: {
    goldenPointHitRatio: number;
    appliedRubricVersion: string;
    judgeNotes?: string;
  };
  l3: {
    turns: number;
    wallclockMs: number;
    estimatedTokens?: number;
    toolCalls: number;
  };
}

export const PROPOSAL_KINDS = [
  'phase_hint',
  'skill_note',
  'strategy_section',
  'skill_overlay_delta',
  'skill_sql',
  'new_skill_draft',
  'retire_injection',
] as const;

export type CurationProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_TIERS = [
  'T0',
  'T1',
  'T2',
  'T3',
  'T4',
  'T5a',
] as const;

export type CurationProposalTier = (typeof PROPOSAL_TIERS)[number];

export interface ProposalDelta {
  op: 'add' | 'modify' | 'remove';
  targetKind:
    | 'skill_overlay'
    | 'strategy_overlay'
    | 'skill_note'
    | 'injection';
  targetId: string;
  operationId: string;
  anchor: string;
  baseContentHash: string;
  before?: string;
  after?: string;
}

export const PROPOSAL_GATE_IDS = [
  'schema',
  'containment',
  'prompt_injection',
  'size',
  'semantic_preservation',
  'optimistic_concurrency',
  'static_validation',
  'paired_replay',
] as const;

export type ProposalGateId = (typeof PROPOSAL_GATE_IDS)[number];
export type ProposalGateVerdict =
  | 'not_run'
  | 'passed'
  | 'failed'
  | 'inconclusive';

export interface ProposalGateCheckV1 {
  schemaVersion: 1;
  gateId: ProposalGateId;
  verdict: ProposalGateVerdict;
  reasonCodes: string[];
  evidenceContentHashes: string[];
  durationMs: number;
}

export interface ProposalMaterializationPlanV1 {
  schemaVersion: 1;
  proposalId: string;
  proposalRevision: 1;
  proposalKind: CurationProposalKind;
  draftContentHash: string;
  materializationRegistryContentHash: string;
  rootId: string;
  rootIdentityHash: string;
  relativeTargetPath: string;
  targetKind: ProposalDelta['targetKind'];
  tier: CurationProposalTier;
  channel: 'runtime_overlay' | 'maintainer_draft' | 'contribution_bundle';
  fileExtension: '.json' | '.yaml' | '.md' | '.sql';
  archiveEntries: Array<{
    relativePath: string;
    contentHash: string;
  }>;
  baseContentHash: string;
  expectedRegistryFingerprint: string;
  expectedOverlayGeneration: string;
  contentHash: string;
}

export interface ProposalCandidateMaterializationV1 {
  schemaVersion: 1;
  proposalId: string;
  proposalRevision: 1;
  draftContentHash: string;
  planContentHash: string;
  artifactId: string;
  targetKind: ProposalDelta['targetKind'];
  serializedContent: string;
  serializedContentHash: string;
  contentHash: string;
}

export interface ProposalSqlRegressionProofV1 {
  schemaVersion: 1;
  proposalId: string;
  proposalRevision: 1;
  draftContentHash: string;
  candidateMaterializationContentHash: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gatePolicyFingerprint: string;
  corpusFingerprint: string;
  traceProcessorVersion: string;
  sqlValidatorVersion: string;
  sqlGuardrailFingerprint: string;
  oracleFingerprint: string;
  budget: {
    timeoutMs: number;
    maxCpuMs: number;
    maxRows: number;
    maxResponseBytes: number;
  };
  cases: Array<{
    caseId: string;
    traceContentHash: string;
    queryContentHash: string;
    baselineQueryContentHash: string;
    baselineResultContentHash: string;
    candidateResultContentHash: string;
    oracleContentHash: string;
    orderPolicy: 'sql_order_by' | 'canonical_row_sort';
    rowCount: number;
    columns: string[];
    durationMs: number;
    traceProcessorCpuMs: number;
    resultBytes: number;
    verdict: 'passed' | 'failed' | 'inconclusive';
    reasonCode?: string;
  }>;
  verdict: Exclude<ProposalGateVerdict, 'not_run'>;
  contentHash: string;
}

export interface ProposalPairedReplaySplitSummaryV1 {
  split: 'validation' | 'holdout';
  caseCount: number;
  baselineClaimVerifiedRatioMean: number;
  candidateClaimVerifiedRatioMean: number;
  baselineUnsupportedClaims: number;
  candidateUnsupportedClaims: number;
  baselineEvidenceAnchors: number;
  candidateEvidenceAnchors: number;
  verdict: Exclude<ProposalGateVerdict, 'not_run'>;
}

export interface ProposalPairedReplayProofV1 {
  schemaVersion: 1;
  proposalId: string;
  proposalRevision: 1;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gatePolicyFingerprint: string;
  draftContentHash: string;
  candidateArtifactId: string;
  candidateMaterializationContentHash: string;
  runId: string;
  runSpecContentHash: string;
  pinnedContentHash: string;
  candidateContentHash: string;
  treatmentArtifactContentHash: string;
  materializedInputHash: string;
  fullTreatmentContractHash: string;
  caseContentHashes: Array<{
    caseId: string;
    split: EvalCaseV1['split'];
    contentHash: string;
  }>;
  publishedRecords: Array<{
    caseId: string;
    role: 'baseline' | 'candidate';
    resultRef: string;
    contentHash: string;
  }>;
  attestationContentHashes: string[];
  splitSummaries: ProposalPairedReplaySplitSummaryV1[];
  epsilon: 0.02;
  verdict: Exclude<ProposalGateVerdict, 'not_run'>;
  contentHash: string;
}

export interface ProposalGateResultV1 {
  schemaVersion: 1;
  proposalId: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gatePolicyFingerprint: string;
  draftRevision: 1;
  gatedRevision: 2;
  draftContentHash: string;
  startedAt: string;
  completedAt: string;
  checks: ProposalGateCheckV1[];
  overallVerdict: Exclude<ProposalGateVerdict, 'not_run'>;
  pairedGateVerdict: ProposalGateVerdict;
  materializationPlanContentHash?: string;
  candidateMaterializationContentHash?: string;
  sqlRegressionProofContentHash?: string;
  pairedReplayProofContentHash?: string;
  contentHash: string;
}

export interface CurationProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  revision: number;
  idempotencyKey: string;
  kind: CurationProposalKind;
  tier: CurationProposalTier;
  title: string;
  rationale: string;
  deltas: ProposalDelta[];
  expectedRegistryFingerprint: string;
  expectedOverlayGeneration: string;
  evidence: {
    negativeRunIds: string[];
    positiveRunIds: string[];
    labeledCount: number;
    negativeCount: number;
    distinctTraceCount: number;
    distinctSessionCount: number;
    statisticalVerdict: 'hypothesis_only';
  };
  pairedGateVerdict?: ProposalGateVerdict;
  expectedEffect: string;
  riskLevel: 'low' | 'medium' | 'high';
  gateResult?: ProposalGateResultV1;
  activeActionId?: string;
  status: 'draft' | 'gated' | 'accepted' | 'applied' | 'rejected' | 'reverted';
  scope: RunManifestScope;
  createdAt: string;
}

export type EvolutionOverlayKind =
  | 'skill_delta'
  | 'strategy_delta'
  | 'skill_note';

export type EvolutionBaseRelation =
  | 'unchanged'
  | 'changed'
  | 'absorbed'
  | 'missing'
  | 'incompatible';

export type EvolutionOverlayValidationState =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'error';

export type EvolutionOverlayActivationState =
  | 'active'
  | 'inactive'
  | 'quarantined'
  | 'obsolete'
  | 'disabled';

export type EvolutionOverlayActionState =
  | 'staged'
  | 'committed'
  | 'aborted';

export interface EvolutionValidationBoundInputsV1 {
  overlayContentHash: string;
  validatedAgainstBaseFingerprint: string;
  skillRegistryFingerprint: string;
  strategyRegistryFingerprint?: string;
  fragmentsFingerprint?: string;
  toolAllowlistFingerprint?: string;
  promptTemplatesFingerprint?: string;
  loaderSchemaVersion: string;
  buildIdentityFingerprint: string;
  overlayGeneration: string;
}

export interface EvolutionOverlayProvenanceV1 {
  schemaVersion: 1;
  overlayId: string;
  overlayKind: EvolutionOverlayKind;
  overlayContentHash: string;
  deltaSchemaVersion: number;
  proposalId: string;
  proposalRevision: number;
  gateVerdict: 'passed' | 'failed' | 'inconclusive';
  evalFingerprints?: {
    evalSetId: string;
    baselineHash: string;
    candidateHash: string;
  };
  derivedFrom: {
    baseKind: 'skill' | 'strategy';
    baseId: string;
    baseVersion: string;
    baseContentFingerprint: string;
    baseOrigin: 'built_in' | 'external_pack';
    basePackId?: string;
    basePackVersion?: string;
    baseTrustState?: string;
  };
  dependencyFingerprints: {
    fragments?: string;
    toolAllowlist?: string;
    promptTemplates?: string;
    loaderSchemaVersion: string;
  };
  producedUnder: {
    buildIdentity: {
      distribution: string;
      channel: string;
      version: string;
      commit?: string;
      target?: string;
    };
    traceProcessorVersion: string;
    perfettoStdlibFingerprint?: string;
    testedMatrix: Array<{
      runtime: AgentRuntimeKind;
      providerId?: string;
      model?: string;
    }>;
  };
  compatibility: {
    smartPerfettoMinVersion: string;
    smartPerfettoMaxVersionTested: string;
  };
  supersedesOverlayId?: string;
  validation?: {
    result: 'passed' | 'failed' | 'error';
    validatorVersion: string;
    at: number;
    validationInputFingerprint: string;
    boundInputs: EvolutionValidationBoundInputsV1;
  };
  createdAt: number;
  appliedAt?: number;
  reconciledAt?: number;
  actor: {userId?: string};
  scope: RunManifestScope;
}

export type EvolutionStrategyDeltaV1 =
  | {
      kind: 'strategy_contribution';
      contribution: StrategyRegistryContribution;
    }
  | {
      kind: 'phase_hint_delta';
      op: 'add' | 'modify' | 'remove';
      scene: string;
      hintId: string;
      beforeContentHash?: string;
      after?: PhaseHint;
    }
  | {
      kind: 'retire_phase_hint';
      hintId: string;
      contentHash: string;
      scene?: string;
    };

export interface EvolutionSkillNoteV1 {
  schemaVersion: 1;
  noteId: string;
  content: string;
  keywords: string[];
}

export type EvolutionSkillNoteDeltaV1 =
  | {
      kind: 'skill_note_delta';
      op: 'add' | 'modify' | 'remove';
      skillId: string;
      noteId: string;
      beforeContentHash?: string;
      after?: EvolutionSkillNoteV1;
    }
  | {
      kind: 'retire_skill_note';
      noteId: string;
      contentHash: string;
      skillId?: string;
    };

export type EvolutionOverlayPayloadV1 =
  | {
      schemaVersion: 1;
      payloadKind: 'skill_delta';
      skillOverlay: SkillOverlayDeltaV1;
    }
  | {
      schemaVersion: 1;
      payloadKind: 'strategy_delta';
      strategyDelta: EvolutionStrategyDeltaV1;
    }
  | {
      schemaVersion: 1;
      payloadKind: 'skill_note';
      skillNoteDelta: EvolutionSkillNoteDeltaV1;
    };

export interface EvolutionOverlayArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  payload: EvolutionOverlayPayloadV1;
  provenance: EvolutionOverlayProvenanceV1;
  contentHash: string;
}

export interface EvolutionOverlayRegistryEntryV1 {
  schemaVersion: 1;
  entryId: string;
  overlayId: string;
  overlayKind: EvolutionOverlayKind;
  scope: RunManifestScope;
  proposalId: string;
  proposalRevision: number;
  artifactContentHash: string;
  actionId: string;
  actionState: EvolutionOverlayActionState;
  baseRelation: EvolutionBaseRelation;
  validationState: EvolutionOverlayValidationState;
  activationState: EvolutionOverlayActivationState;
  effectiveEnabled: boolean;
  userDisabled: boolean;
  validationReason?: string;
  createdAt: number;
  reconciledAt?: number;
  provenance: EvolutionOverlayProvenanceV1;
}

export interface EvolutionGenerationRecordV1 {
  schemaVersion: 1;
  scope: RunManifestScope;
  candidateGeneration: string;
  publishedGeneration: string | null;
  fence: number;
  state: 'prepared' | 'published' | 'aborted';
  actionId?: string;
  persistedAt: number;
}

export interface UpgradeReconciliationIssueV1 {
  schemaVersion: 1;
  issueId: string;
  source: 'overlay' | 'vendor_override';
  kind:
    | 'orphan'
    | 'parse_failure'
    | 'validation_failure'
    | 'validation_error'
    | 'generation_publish_failure';
  sourcePath?: string;
  overlayId?: string;
  baseId?: string;
  reasonCode: string;
  message: string;
}

export interface UpgradeReconciliationReportV1 {
  schemaVersion: 1;
  reportId: string;
  scope: RunManifestScope;
  previousBuildIdentity: ApplicationBuildIdentity | null;
  currentBuildIdentity: ApplicationBuildIdentity;
  candidateGeneration: string;
  publishedGeneration: string;
  byBaseRelation: Record<
    EvolutionBaseRelation,
    string[]
  >;
  byValidationState: Record<
    EvolutionOverlayValidationState,
    string[]
  >;
  byActivationState: Record<
    EvolutionOverlayActivationState,
    string[]
  >;
  issues: UpgradeReconciliationIssueV1[];
  createdAt: number;
  contentHash: string;
}

export type ProposalActionKind = 'apply' | 'revert';
export type ProposalActionState =
  | 'pending'
  | 'executing'
  | 'finalized'
  | 'failed';
export type ProposalActionFailureClass =
  | 'terminal_before_side_effect'
  | 'retryable_before_side_effect'
  | 'recovery_required_after_side_effect';

export interface ProposalActionRecordV1 {
  schemaVersion: 1;
  actionId: string;
  kind: ProposalActionKind;
  scope: RunManifestScope;
  proposalId: string;
  artifactContentHashes: string[];
  expectedRevision: 3 | 4;
  targetRevision: 4 | 5;
  state: ProposalActionState;
  failureClass?: ProposalActionFailureClass;
  sideEffectKind:
    | 'runtime_overlay'
    | 'repository_patch'
    | 'case_retract'
    | 'skill_note_disable';
  sideEffectReceiptHash?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppliedProposalRevisionV1 {
  schemaVersion: 1;
  ordinal: number;
  proposalId: string;
  proposalRevision: 4 | 5;
  actionId: string;
  kind: ProposalActionKind;
  scope: RunManifestScope;
  overlayIds: string[];
  generation: string;
  receiptContentHashes: string[];
  actor: {userId?: string};
  createdAt: number;
  contentHash: string;
}

export interface RepositoryTargetBindingV1 {
  schemaVersion: 1;
  proposalId: string;
  proposalRevision: 1;
  repositoryRootIdentityHash: string;
  repositoryRelativePath: string;
  allowedRoot: string;
  baseCommit: string;
  baseBlobOid: string;
  baseFileMode: string;
  baseFileContentHash: string;
  structuralPath: string;
  anchorFingerprint: string;
  proposedFileContent: string;
  proposedFileContentHash: string;
  symlinkFree: true;
  containmentVerified: true;
  contentHash: string;
}

export interface RepositoryPatchArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  proposalId: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  targetBindingContentHash: string;
  patch: string;
  patchContentHash: string;
  reversePatch: string;
  reversePatchContentHash: string;
  applyCheck: 'passed';
  sourceMaintainer: true;
  gitCapability: 'available';
  createdAt: number;
  contentHash: string;
}

export interface ContributionBundleArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  proposalId: string;
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  archivePath: string;
  archiveContentHash: string;
  entryContentHashes: Array<{
    path: string;
    contentHash: string;
  }>;
  deidentified: true;
  createdAt: number;
  contentHash: string;
}

export interface ProposalChannelArtifactRevisionV1 {
  schemaVersion: 1;
  proposalId: string;
  ordinal: number;
  channel: 'repository_patch' | 'contribution_bundle';
  gateAttemptId: string;
  gateAttemptOrdinal: number;
  gateResultContentHash: string;
  artifactId: string;
  artifactContentHash: string;
  state: 'active' | 'revoked';
  createdAt: number;
  contentHash: string;
}

export interface EvolutionRollbackReceiptV1 {
  schemaVersion: 1;
  actionId: string;
  scope: RunManifestScope;
  kind:
    | 'local_overlay_reverted'
    | 'repository_patch_revoked'
    | 'case_retracted'
    | 'skill_note_disabled';
  targetId: string;
  idempotent: boolean;
  sideEffectContentHash: string;
  createdAt: number;
  contentHash: string;
}

export interface EvolutionDegradationAlertV1 {
  schemaVersion: 1;
  alertId: string;
  scope: RunManifestScope;
  overlayIds: string[];
  observedGeneration: string;
  reasonCode: string;
  evidenceContentHashes: string[];
  autoRollback: false;
  createdAt: number;
  contentHash: string;
}

export const FEEDBACK_TARGET_KINDS = [
  'session',
  'conclusion',
  'finding',
  'claim',
  'evidence',
  'pattern',
  'case_candidate',
  'skill_note',
  'injection',
] as const;

export type FeedbackTargetKind = (typeof FEEDBACK_TARGET_KINDS)[number];

export const FEEDBACK_EVENT_KINDS = [
  'created',
  'replaced',
  'retracted',
] as const;

export type FeedbackEventKind = (typeof FEEDBACK_EVENT_KINDS)[number];

export const FEEDBACK_SOURCES = ['ui', 'cli', 'api'] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export interface FeedbackEventV1 {
  schemaVersion: 1;
  eventId: string;
  feedbackId: string;
  supersedesEventId?: string;
  sequence: number;
  checksum: string;
  idempotencyKey: string;
  kind: FeedbackEventKind;

  runId: string;
  runManifestId?: string;
  sessionId: string;

  rating?: 'positive' | 'negative';
  dimensions?: FeedbackDimension[];
  comment?: string;

  targetKind: FeedbackTargetKind;
  targetId?: string;
  patternId?: string;
  caseCandidateId?: string;

  source: FeedbackSource;
  actor: {userId?: string; permissionSnapshot?: string};
  scope: RunManifestScope;
  timestamp: string;
}

export interface AppendFeedbackEventInput {
  kind: FeedbackEventKind;
  feedbackId?: string;
  supersedesEventId?: string;
  idempotencyKey: string;
  runId: string;
  runManifestId?: string;
  sessionId: string;
  rating?: 'positive' | 'negative';
  dimensions?: FeedbackDimension[];
  comment?: string;
  targetKind: FeedbackTargetKind;
  targetId?: string;
  patternId?: string;
  caseCandidateId?: string;
  source: FeedbackSource;
  actor: FeedbackEventV1['actor'];
  scope: RunManifestScope;
  timestamp?: string;
}

export interface AppendFeedbackEventResult {
  event: FeedbackEventV1;
  idempotent: boolean;
  storage: 'durable' | 'temporary_private';
}

export interface EffectiveFeedbackV1 {
  feedbackId: string;
  currentEventId: string;
  sequence: number | null;
  legacy: boolean;
  runId?: string;
  runManifestId?: string;
  sessionId: string;
  rating: 'positive' | 'negative';
  dimensions: FeedbackDimension[];
  comment?: string;
  targetKind: FeedbackTargetKind;
  targetId: string;
  patternId?: string;
  caseCandidateId?: string;
  source: FeedbackSource;
  actor: FeedbackEventV1['actor'];
  scope: RunManifestScope;
  timestamp: string;
}

export interface RunSkillDefinitionAttribution {
  skillId: string;
  version: string;
  contentFingerprint: string;
  origin: RunSkillOrigin;
  packId?: string;
  packVersion?: string;
  trustState?: 'local_unverified' | 'approved';
  appliedOverlayIds?: string[];
}

export interface RunSkillRegistryAttribution {
  registryFingerprint: string;
  evolutionOverlayGeneration?: string;
  skills: RunSkillDefinitionAttribution[];
}

export interface RunSkillInvocationStart {
  skillId: string;
  version: string;
  contentFingerprint: string;
}

export interface RunSkillInvocationOutcome {
  success: boolean;
  empty: boolean;
}

export interface RunManifestRuntimeAttribution {
  runtime: AgentRuntimeKind;
  providerId: string | null;
  providerSnapshotHash?: string;
  model?: string;
  outputLanguage?: string;
}

export interface RunManifestSceneAttribution {
  sceneType: string;
  sceneConfidence?: number;
  architecture?: string;
  strategyId?: string;
  strategyContentHash?: string;
}

/**
 * Narrow per-run attribution boundary. Runtime and executor layers depend on
 * this interface rather than on the concrete mutable builder service.
 */
export interface RunManifestAttributionSink {
  readonly identity: RunManifestIdentity;
  readonly runtimePerformanceRecorder?: RuntimePerformanceRecorder;
  recordScene(input: RunManifestSceneAttribution): void;
  recordRuntime(input: RunManifestRuntimeAttribution): void;
  recordMode(input: {
    requested: RunManifestV1['analysisMode'];
    resolved?: RunManifestV1['resolvedMode'];
    capabilityFlags?: readonly string[];
  }): void;
  recordAdaptiveRouting?(input: AdaptiveRoutingReceiptV1): void;
  recordCapabilityManifest(input: CapabilityManifestAttributionV1): void;
  recordSkillRegistry(input: RunSkillRegistryAttribution): void;
  startSkillInvocation(input: RunSkillInvocationStart): string;
  finishSkillInvocation(
    invocationId: string,
    outcome: RunSkillInvocationOutcome,
  ): void;
  recordUnknownSkillInvocation(skillId: string): void;
  recordSqlStatement(success: boolean): void;
  recordPromptTemplate(id: string, contentHash: string): void;
  recordInjection(
    category: RunInjectionCategory,
    id: string,
    contentHash: string,
  ): void;
  recordToolAllowlist(toolNames: readonly string[]): void;
  recordTurn(): void;
}
