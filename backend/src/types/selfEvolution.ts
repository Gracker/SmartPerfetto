// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ApplicationBuildIdentity} from '../services/applicationUpdate/types';

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
