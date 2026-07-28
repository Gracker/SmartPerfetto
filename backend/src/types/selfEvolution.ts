// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ApplicationBuildIdentity} from '../services/applicationUpdate/types';
import type {AgentRuntimeKind} from '../agentRuntime/runtimeKinds';
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
  model?: string;
  outputLanguage: string;
  toolAllowlistHash: string;
  featureFlagSnapshot: Record<string, string | number | boolean>;

  analysisMode: 'fast' | 'full' | 'auto';
  resolvedMode: 'quick' | 'full';
  capabilityFlags: string[];

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
  recordScene(input: RunManifestSceneAttribution): void;
  recordRuntime(input: RunManifestRuntimeAttribution): void;
  recordMode(input: {
    requested: RunManifestV1['analysisMode'];
    resolved?: RunManifestV1['resolvedMode'];
    capabilityFlags?: readonly string[];
  }): void;
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
