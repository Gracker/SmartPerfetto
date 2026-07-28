// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import {resolveUserDataRoot} from '../../runtimePaths';
import type {
  BuildIdentityStateSnapshot,
  SelfEvolutionLifecycleSnapshot,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {resolveApplicationBuildIdentity} from '../applicationUpdate/buildIdentity';
import {loadLastReconciledBuildIdentity} from './buildIdentityStore';
import {migrateLegacySelfImproveData} from './legacyDataMigration';
import {probeSelfEvolutionPersistence} from './persistenceCapability';
import {
  loadSelfEvolutionConfig,
  validateSelfEvolutionConfig,
} from './selfEvolutionConfig';

export interface InitializeSelfEvolutionLifecycleOptions {
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  dataRoot?: string;
  homeDir?: string;
  mountPoints?: readonly string[];
  migrationSourceCandidates?: readonly string[];
  migrationDestinationPath?: string;
  buildIdentityFilePath?: string;
  now?: () => number;
}

let lifecycleSnapshot: SelfEvolutionLifecycleSnapshot | null = null;

function loadBuildIdentityState(
  persistence: SelfEvolutionPersistenceCapability,
  filePath?: string,
): BuildIdentityStateSnapshot {
  if (persistence.persistence !== 'available') {
    return {
      status: 'not_loaded_persistence_unavailable',
      record: null,
    };
  }
  try {
    const record = loadLastReconciledBuildIdentity({filePath});
    return {
      status: record ? 'loaded' : 'missing',
      record,
    };
  } catch (error) {
    return {
      status: 'invalid',
      record: null,
      errorCode: (error as Error).message || 'invalid_build_identity_state',
    };
  }
}

function freezeSnapshot(
  snapshot: SelfEvolutionLifecycleSnapshot,
): SelfEvolutionLifecycleSnapshot {
  Object.freeze(snapshot.requestedConfig);
  Object.freeze(snapshot.effectiveConfig);
  Object.freeze(snapshot.persistence);
  Object.freeze(snapshot.migration);
  Object.freeze(snapshot.currentBuildIdentity.target);
  Object.freeze(snapshot.currentBuildIdentity);
  if (snapshot.buildIdentityState.record) {
    Object.freeze(snapshot.buildIdentityState.record.lastReconciledBuildIdentity.target);
    Object.freeze(snapshot.buildIdentityState.record.lastReconciledBuildIdentity);
    Object.freeze(snapshot.buildIdentityState.record);
  }
  Object.freeze(snapshot.buildIdentityState);
  Object.freeze(snapshot.warnings);
  Object.freeze(snapshot.errors);
  return Object.freeze(snapshot);
}

export function initializeSelfEvolutionLifecycle(
  options: InitializeSelfEvolutionLifecycleOptions = {},
): SelfEvolutionLifecycleSnapshot {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const requestedConfig = loadSelfEvolutionConfig(env);
  const persistence = probeSelfEvolutionPersistence({
    env,
    packageRoot: options.packageRoot,
    dataRoot: options.dataRoot,
    homeDir: options.homeDir,
    mountPoints: options.mountPoints,
    now,
  });
  const migration = migrateLegacySelfImproveData({
    persistence,
    destinationPath: options.migrationDestinationPath,
    sourceCandidates: options.migrationSourceCandidates,
    now: () => new Date(now()),
  });
  const buildIdentityState = loadBuildIdentityState(
    persistence,
    options.buildIdentityFilePath,
  );
  const currentBuildIdentity = resolveApplicationBuildIdentity(env);
  const validation = validateSelfEvolutionConfig(requestedConfig, {
    persistence,
    migration,
    buildIdentityState,
    currentBuildIdentity,
  });
  lifecycleSnapshot = freezeSnapshot({
    initializedAt: now(),
    requestedConfig: validation.requestedConfig,
    effectiveConfig: validation.effectiveConfig,
    persistence,
    migration,
    currentBuildIdentity,
    buildIdentityState,
    warnings: validation.warnings,
    errors: validation.errors,
  });
  return lifecycleSnapshot;
}

function uninitializedSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): SelfEvolutionLifecycleSnapshot {
  const requestedConfig = loadSelfEvolutionConfig(env);
  const dataRoot = resolveUserDataRoot(env);
  const packageRoot = path.resolve(
    env.SMARTPERFETTO_PACKAGE_ROOT?.trim() ?? process.cwd(),
  );
  const persistence: SelfEvolutionPersistenceCapability = {
    persistence: 'unavailable',
    reason: 'not_initialized',
    configured: Boolean(env.SMARTPERFETTO_BACKEND_DATA_DIR?.trim()),
    writable: false,
    outsidePackage: false,
    externalMount: false,
    dataRoot,
    packageRoot,
    checkedAt: 0,
  };
  return freezeSnapshot({
    initializedAt: 0,
    requestedConfig,
    effectiveConfig: {enabled: false, applyEnabled: false},
    persistence,
    migration: {status: 'not_attempted_persistence_unavailable'},
    currentBuildIdentity: resolveApplicationBuildIdentity(env),
    buildIdentityState: {
      status: 'not_loaded_persistence_unavailable',
      record: null,
    },
    warnings: [],
    errors: [],
  });
}

export function getSelfEvolutionLifecycleSnapshot(): SelfEvolutionLifecycleSnapshot {
  return lifecycleSnapshot ?? uninitializedSnapshot();
}
