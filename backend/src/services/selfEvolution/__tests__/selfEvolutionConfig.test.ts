// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {
  ApplicationBuildIdentity,
} from '../../applicationUpdate/types';
import type {
  BuildIdentityStateSnapshot,
  LegacySelfImproveMigrationResult,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {
  loadSelfEvolutionConfig,
  validateSelfEvolutionConfig,
} from '../selfEvolutionConfig';

function persistence(
  state: 'available' | 'unavailable' = 'available',
): SelfEvolutionPersistenceCapability {
  return {
    persistence: state,
    ...(state === 'unavailable'
      ? {reason: 'external_data_dir_not_configured' as const}
      : {}),
    configured: state === 'available',
    writable: true,
    outsidePackage: true,
    externalMount: false,
    dataRoot: '/data',
    packageRoot: '/package',
    checkedAt: 1,
  };
}

function validate(
  env: NodeJS.ProcessEnv,
  overrides: {
    persistence?: SelfEvolutionPersistenceCapability;
    migration?: LegacySelfImproveMigrationResult;
    buildIdentityState?: BuildIdentityStateSnapshot;
    currentBuildIdentity?: ApplicationBuildIdentity;
  } = {},
) {
  return validateSelfEvolutionConfig(loadSelfEvolutionConfig(env), {
    persistence: overrides.persistence ?? persistence(),
    migration: overrides.migration ?? {status: 'source_not_found'},
    buildIdentityState: overrides.buildIdentityState ?? {
      status: 'missing',
      record: null,
    },
    currentBuildIdentity: overrides.currentBuildIdentity ?? {
      distribution: 'npm',
      channel: 'stable',
      version: '1.0.0',
      target: {os: 'linux', arch: 'x64'},
      signingMode: 'npm-registry',
    },
  });
}

describe('self-evolution configuration', () => {
  it('defaults every M0 feature flag off', () => {
    expect(loadSelfEvolutionConfig({})).toEqual({
      enabled: false,
      applyEnabled: false,
    });
  });

  it('parses the master and apply flags without silently enabling prerequisites', () => {
    expect(loadSelfEvolutionConfig({
      SELF_EVOLUTION_ENABLED: 'yes',
      SELF_EVOLUTION_APPLY: 'true',
    })).toEqual({
      enabled: true,
      applyEnabled: true,
    });
  });

  it('fails closed when apply is requested without the master flag', () => {
    const result = validate({SELF_EVOLUTION_APPLY: '1'});
    expect(result.ok).toBe(false);
    expect(result.requestedConfig.applyEnabled).toBe(true);
    expect(result.effectiveConfig.applyEnabled).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(
      'apply_requires_self_evolution_enabled',
    );
  });

  it('fails closed when persistence is unavailable', () => {
    const result = validate({
      SELF_EVOLUTION_ENABLED: '1',
      SELF_EVOLUTION_APPLY: '1',
    }, {
      persistence: persistence('unavailable'),
    });
    expect(result.effectiveConfig.applyEnabled).toBe(false);
    expect(result.errors.map((issue) => issue.code)).toContain(
      'apply_requires_persistent_user_data',
    );
  });

  it('fails closed for unresolved legacy migration or invalid identity state', () => {
    const migrationBlocked = validate({
      SELF_EVOLUTION_ENABLED: '1',
      SELF_EVOLUTION_APPLY: '1',
    }, {
      migration: {status: 'blocked_destination_exists'},
    });
    expect(migrationBlocked.errors.map((issue) => issue.code)).toContain(
      'apply_blocked_by_legacy_migration',
    );

    const identityInvalid = validate({
      SELF_EVOLUTION_ENABLED: '1',
      SELF_EVOLUTION_APPLY: '1',
    }, {
      buildIdentityState: {
        status: 'invalid',
        record: null,
        errorCode: 'invalid_json',
      },
    });
    expect(identityInvalid.errors.map((issue) => issue.code)).toContain(
      'apply_blocked_by_invalid_build_identity_state',
    );
  });

  it('requires a full commit for source, nightly, and any supplied commit', () => {
    for (const currentBuildIdentity of [
      {
        distribution: 'source',
        channel: 'stable',
        version: '1.0.0',
        target: {os: 'darwin', arch: 'arm64'},
        signingMode: 'source-checkout',
      },
      {
        distribution: 'docker',
        channel: 'nightly',
        version: '1.0.0',
        target: {os: 'linux', arch: 'arm64'},
        signingMode: 'container',
      },
      {
        distribution: 'docker',
        channel: 'stable',
        version: '1.0.0',
        commit: 'unknown',
        target: {os: 'linux', arch: 'arm64'},
        signingMode: 'container',
      },
    ] satisfies ApplicationBuildIdentity[]) {
      const result = validate({
        SELF_EVOLUTION_ENABLED: '1',
        SELF_EVOLUTION_APPLY: '1',
      }, {currentBuildIdentity});
      expect(result.effectiveConfig.applyEnabled).toBe(false);
      expect(result.errors.map((issue) => issue.code)).toContain(
        'apply_blocked_by_invalid_current_build_identity',
      );
    }

    const valid = validate({
      SELF_EVOLUTION_ENABLED: '1',
      SELF_EVOLUTION_APPLY: '1',
    }, {
      currentBuildIdentity: {
        distribution: 'source',
        channel: 'nightly',
        version: '1.0.0',
        commit: 'a'.repeat(40),
        target: {os: 'darwin', arch: 'arm64'},
        signingMode: 'source-checkout',
      },
    });
    expect(valid.effectiveConfig.applyEnabled).toBe(true);
  });
});
