// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {ApplicationBuildIdentity} from '../../applicationUpdate/types';
import {saveLastReconciledBuildIdentity} from '../buildIdentityStore';
import {
  getSelfEvolutionLifecycleSnapshot,
  initializeSelfEvolutionLifecycle,
} from '../selfEvolutionLifecycle';

const lastIdentity: ApplicationBuildIdentity = {
  distribution: 'portable',
  channel: 'stable',
  version: '1.0.0',
  target: {os: 'linux', arch: 'x64', id: 'linux-x64'},
  signingMode: 'unsigned',
};

describe('self-evolution lifecycle', () => {
  let root: string;
  let packageRoot: string;
  let dataRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-self-evolution-lifecycle-'));
    packageRoot = path.join(root, 'package');
    dataRoot = path.join(root, 'external-data');
    fs.mkdirSync(packageRoot);
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('keeps apply fail-closed and performs no migration or identity write for source fallback', () => {
    const identityFile = path.join(dataRoot, 'identity', 'state.json');
    const snapshot = initializeSelfEvolutionLifecycle({
      env: {
        SELF_EVOLUTION_ENABLED: '1',
        SELF_EVOLUTION_APPLY: '1',
        SMARTPERFETTO_DISTRIBUTION: 'source',
      },
      packageRoot,
      dataRoot,
      homeDir: root,
      mountPoints: [],
      migrationDestinationPath: path.join(dataRoot, 'self_improve'),
      buildIdentityFilePath: identityFile,
      now: () => 100,
    });

    expect(snapshot.persistence).toMatchObject({
      persistence: 'unavailable',
      reason: 'external_data_dir_not_configured',
    });
    expect(snapshot.migration.status)
      .toBe('not_attempted_persistence_unavailable');
    expect(snapshot.buildIdentityState.status)
      .toBe('not_loaded_persistence_unavailable');
    expect(snapshot.effectiveConfig.applyEnabled).toBe(false);
    expect(fs.existsSync(identityFile)).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'self_improve'))).toBe(false);
  });

  it('loads the last reconciled identity and enables requested apply only after all M0 gates pass', () => {
    const identityFile = path.join(
      dataRoot,
      'reconciliation',
      'last_identity.json',
    );
    saveLastReconciledBuildIdentity(lastIdentity, {
      filePath: identityFile,
      reconciledAt: '2026-07-28T00:00:00.000Z',
      persistence: {
        persistence: 'available',
        configured: true,
        writable: true,
        outsidePackage: true,
        externalMount: false,
        dataRoot,
        packageRoot,
        checkedAt: 1,
      },
    });
    const snapshot = initializeSelfEvolutionLifecycle({
      env: {
        SELF_EVOLUTION_ENABLED: '1',
        SELF_EVOLUTION_APPLY: '1',
        SMARTPERFETTO_BACKEND_DATA_DIR: dataRoot,
        SMARTPERFETTO_DISTRIBUTION: 'source',
        SMARTPERFETTO_BUILD_COMMIT: 'b'.repeat(40),
      },
      packageRoot,
      dataRoot,
      mountPoints: [],
      migrationSourceCandidates: [],
      buildIdentityFilePath: identityFile,
      now: () => 200,
    });

    expect(snapshot.persistence.persistence).toBe('available');
    expect(snapshot.migration.status).toBe('source_not_found');
    expect(snapshot.buildIdentityState).toMatchObject({
      status: 'loaded',
      record: {
        lastReconciledBuildIdentity: lastIdentity,
      },
    });
    expect(snapshot.effectiveConfig).toEqual({
      enabled: true,
      applyEnabled: true,
    });
    expect(snapshot.currentBuildIdentity.commit).toBe('b'.repeat(40));
    expect(getSelfEvolutionLifecycleSnapshot()).toBe(snapshot);
  });

  it('disables apply when legacy data cannot be safely merged', () => {
    const source = path.join(packageRoot, 'backend', 'data', 'self_improve');
    const destination = path.join(dataRoot, 'self_improve');
    fs.mkdirSync(source, {recursive: true});
    fs.writeFileSync(path.join(source, 'legacy.db'), 'legacy');
    fs.mkdirSync(destination, {recursive: true});
    fs.writeFileSync(path.join(destination, 'current.db'), 'current');

    const snapshot = initializeSelfEvolutionLifecycle({
      env: {
        SELF_EVOLUTION_ENABLED: '1',
        SELF_EVOLUTION_APPLY: '1',
        SMARTPERFETTO_BACKEND_DATA_DIR: dataRoot,
      },
      packageRoot,
      dataRoot,
      mountPoints: [],
      migrationSourceCandidates: [source],
      migrationDestinationPath: destination,
      buildIdentityFilePath: path.join(dataRoot, 'missing-identity.json'),
    });
    expect(snapshot.migration.status).toBe('blocked_destination_exists');
    expect(snapshot.effectiveConfig.applyEnabled).toBe(false);
    expect(snapshot.errors.map((issue) => issue.code)).toContain(
      'apply_blocked_by_legacy_migration',
    );
  });

  it('disables apply when an available source runtime lacks a commit', () => {
    const snapshot = initializeSelfEvolutionLifecycle({
      env: {
        SELF_EVOLUTION_ENABLED: '1',
        SELF_EVOLUTION_APPLY: '1',
        SMARTPERFETTO_BACKEND_DATA_DIR: dataRoot,
        SMARTPERFETTO_DISTRIBUTION: 'source',
      },
      packageRoot,
      dataRoot,
      mountPoints: [],
      migrationSourceCandidates: [],
      buildIdentityFilePath: path.join(dataRoot, 'missing-identity.json'),
    });

    expect(snapshot.persistence.persistence).toBe('available');
    expect(snapshot.effectiveConfig.applyEnabled).toBe(false);
    expect(snapshot.errors.map((issue) => issue.code)).toContain(
      'apply_blocked_by_invalid_current_build_identity',
    );
  });
});
