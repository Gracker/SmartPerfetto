// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ApplicationBuildIdentity,
} from '../applicationUpdate/types';
import {
  buildIdentityValidationError,
} from './buildIdentityStore';
import type {
  BuildIdentityStateSnapshot,
  LegacySelfImproveMigrationResult,
  SelfEvolutionConfig,
  SelfEvolutionConfigIssue,
  SelfEvolutionConfigValidation,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function readBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase());
}

export function loadSelfEvolutionConfig(
  env: NodeJS.ProcessEnv = process.env,
): SelfEvolutionConfig {
  return {
    enabled: readBoolean(env, 'SELF_EVOLUTION_ENABLED'),
    applyEnabled: readBoolean(env, 'SELF_EVOLUTION_APPLY'),
  };
}

export interface SelfEvolutionConfigValidationContext {
  persistence: SelfEvolutionPersistenceCapability;
  migration: LegacySelfImproveMigrationResult;
  buildIdentityState: BuildIdentityStateSnapshot;
  currentBuildIdentity: ApplicationBuildIdentity;
}

export function validateSelfEvolutionConfig(
  requestedConfig: SelfEvolutionConfig,
  context: SelfEvolutionConfigValidationContext,
): SelfEvolutionConfigValidation {
  const effectiveConfig = {...requestedConfig};
  const warnings: SelfEvolutionConfigIssue[] = [];
  const errors: SelfEvolutionConfigIssue[] = [];

  const applyRequested = requestedConfig.applyEnabled;

  if (applyRequested && !requestedConfig.enabled) {
    errors.push({
      code: 'apply_requires_self_evolution_enabled',
      message: 'SELF_EVOLUTION_APPLY requires SELF_EVOLUTION_ENABLED; disabling apply',
    });
  }

  if (
    applyRequested &&
    requestedConfig.enabled &&
    context.persistence.persistence !== 'available'
  ) {
    errors.push({
      code: 'apply_requires_persistent_user_data',
      message: [
        'SELF_EVOLUTION_APPLY requires a writable external user data directory',
        `(${context.persistence.reason ?? 'unknown'}); disabling apply`,
      ].join(' '),
    });
  }

  if (
    applyRequested &&
    requestedConfig.enabled &&
    (
      context.migration.status === 'blocked_destination_exists' ||
      context.migration.status === 'failed'
    )
  ) {
    errors.push({
      code: 'apply_blocked_by_legacy_migration',
      message: `Legacy self-improve data migration is ${context.migration.status}; disabling apply`,
    });
  }

  if (
    applyRequested &&
    requestedConfig.enabled &&
    context.buildIdentityState.status === 'invalid'
  ) {
    errors.push({
      code: 'apply_blocked_by_invalid_build_identity_state',
      message: 'Last reconciled build identity state is invalid; disabling apply',
    });
  }

  const currentIdentityError = buildIdentityValidationError(
    context.currentBuildIdentity,
  );
  if (
    applyRequested &&
    requestedConfig.enabled &&
    currentIdentityError
  ) {
    errors.push({
      code: 'apply_blocked_by_invalid_current_build_identity',
      message: [
        'Current build identity cannot be reconciled',
        `(${currentIdentityError}); disabling apply`,
      ].join(' '),
    });
  }

  effectiveConfig.applyEnabled = applyRequested && errors.length === 0;

  return {
    ok: errors.length === 0,
    requestedConfig: {...requestedConfig},
    effectiveConfig,
    warnings,
    errors,
  };
}
