// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from '@jest/globals';

import type {
  RunManifestScope,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {RunManifestStore} from '../runManifestStore';

const scope: RunManifestScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
};
const persistenceAvailable: SelfEvolutionPersistenceCapability = {
  persistence: 'available',
  configured: true,
  writable: true,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/smartperfetto-run-manifest-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  ...persistenceAvailable,
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  writable: false,
};

function manifest(
  runManifestId: string,
  runId = `run-${runManifestId}`,
): RunManifestV1 {
  return {
    schemaVersion: 1,
    runManifestId,
    runId,
    sessionId: `session-${runManifestId}`,
    sealedAt: 10,
    scope,
    sceneType: 'general',
    promptTemplateHashes: [],
    skills: [],
    skillRegistryFingerprint: 'registry-a',
    evolutionOverlayGeneration: 'builtin:registry-a',
    sqlStatementCount: 0,
    sqlErrorCount: 0,
    runtime: 'openai-agents-sdk',
    providerId: null,
    outputLanguage: 'en',
    toolAllowlistHash: 'tools-a',
    featureFlagSnapshot: {},
    analysisMode: 'auto',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections: {
      patterns: [],
      skillNotes: [],
      cases: [],
      phaseHints: [],
      knowledgeDocs: [],
    },
    turns: 1,
    wallclockMs: 10,
  };
}

const stores: RunManifestStore[] = [];

afterEach(() => {
  stores.splice(0).forEach(store => store.close());
});

describe('RunManifestStore', () => {
  it('appends idempotently in SQLite and enforces scoped lookup', () => {
    const store = new RunManifestStore({
      persistence: persistenceAvailable,
      databasePath: ':memory:',
    });
    stores.push(store);
    const value = manifest('manifest-sql');

    expect(store.append(scope, value).idempotent).toBe(false);
    expect(store.append(scope, value).idempotent).toBe(true);
    expect(store.get(scope, value.runManifestId)).toEqual(value);
    expect(store.getByRunId(scope, value.runId)).toEqual(value);
    expect(store.get(
      {tenantId: 'tenant-b', workspaceId: 'workspace-a'},
      value.runManifestId,
    )).toBeUndefined();
    expect(() => store.append(scope, {
      ...value,
      sceneType: 'startup',
    })).toThrow('run_manifest_append_conflict');
  });

  it('keeps pinned active manifests when bounded ephemeral storage evicts', () => {
    const store = new RunManifestStore({
      persistence: persistenceUnavailable,
      ephemeralCapacity: 1,
    });
    stores.push(store);
    const active = manifest('manifest-active');
    const overflow = manifest('manifest-overflow');

    expect(store.append(scope, active).storage).toBe('ephemeral');
    store.pin(scope, active.runManifestId);
    store.append(scope, overflow);

    expect(store.get(scope, active.runManifestId)).toEqual(active);
    expect(store.get(scope, overflow.runManifestId)).toBeUndefined();
  });

  it('rejects caller scope that disagrees with the immutable manifest scope', () => {
    const store = new RunManifestStore({
      persistence: persistenceUnavailable,
    });
    stores.push(store);
    expect(() => store.append(
      {tenantId: 'tenant-b', workspaceId: 'workspace-a'},
      manifest('manifest-scope'),
    )).toThrow('run_manifest_scope_mismatch');
  });
});
