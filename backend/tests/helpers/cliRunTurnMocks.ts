// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Module mocks the CLI turn tests share: the run registry, Skill fingerprint
 * and RunManifest lifecycle a CLI turn opens, none of which those tests
 * exercise. Use inside a `jest.mock` factory through `jest.requireActual`,
 * since a factory runs before the test file's own imports.
 */

import {jest} from '@jest/globals';

export const CLI_RUN_REGISTRY_FINGERPRINT = 'registry-test';
export const CLI_RUN_OVERLAY_GENERATION = 'builtin:registry-test';
export const CLI_RUN_MANIFEST_ID = 'manifest-cli-test';

export const CLI_CAPABILITY_MANIFEST_ATTRIBUTION = {
  schemaVersion: 'capability_manifest_attribution@1',
  resolution: {
    status: 'ready',
    manifestId: `capability_manifest:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    manifestSchemaVersion: 'capability_manifest@1',
    traceFingerprintSha256: 'b'.repeat(64),
    traceProcessor: {source: 'bundled', gitRevision: 'd'.repeat(40)},
  },
  probeCache: {hits: 1, misses: 1, bypasses: 0},
} as const;

export function workspaceSkillRegistryProviderModule() {
  return {getWorkspaceSkillRegistry: jest.fn(async () => ({registry: {}}))};
}

export function effectiveRuntimeRegistryProviderModule() {
  return {
    getEffectiveRuntimeRegistrySnapshot: jest.fn(async ({scope}: any) => ({
      scope: {tenantId: scope.tenantId, workspaceId: scope.workspaceId},
      overlayGeneration: CLI_RUN_OVERLAY_GENERATION,
      skillRegistry: {},
      strategyRegistry: {},
    })),
  };
}

export function skillFingerprintModule() {
  return {
    buildSkillRegistryAttribution: jest.fn(() => ({
      registryFingerprint: CLI_RUN_REGISTRY_FINGERPRINT,
      evolutionOverlayGeneration: CLI_RUN_OVERLAY_GENERATION,
      skills: [],
    })),
  };
}

/** Each created lifecycle is handed to `onCreate`, so a test can inspect its seal and dispose. */
export function runManifestLifecycleModule(onCreate: (lifecycle: any) => void = () => undefined) {
  return {
    createRunManifestLifecycle: jest.fn((input: any) => {
      const lifecycle: any = {
        state: 'collecting',
        builder: {identity: {runId: input.runId, sessionId: input.sessionId, scope: input.scope}},
        sealOnceAndPersist: jest.fn(() => {
          lifecycle.state = 'persisted';
          return {runManifestId: CLI_RUN_MANIFEST_ID, runId: input.runId,
            capabilityManifest: CLI_CAPABILITY_MANIFEST_ATTRIBUTION};
        }),
        dispose: jest.fn(() => {
          lifecycle.state = 'disposed';
        }),
      };
      onCreate(lifecycle);
      return lifecycle;
    }),
    withRunManifestLifecycle: (_lifecycle: unknown, callback: () => unknown) => callback(),
    currentRunManifestAttributionSink: () => undefined,
  };
}
