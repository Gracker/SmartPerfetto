// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import {
  RunManifestStore,
  type RunManifestStore as RunManifestStoreType,
} from '../runManifestStore';
import {buildAnalysisReceipt} from '../../analysisReceiptBuilder';
import {
  buildRunManifestFeatureFlagSnapshot,
  clearRunManifestLifecyclesForTests,
  createRunManifestLifecycle,
  disposeRunManifestLifecyclesForSession,
  RunManifestLifecycle,
  resolveRunManifestAttributionSink,
  withRunManifestLifecycle,
  currentRunManifestAttributionSink,
} from '../runManifestLifecycle';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
} from '../effectiveRuntimeRegistryContext';
import {
  resolveEffectiveSkillRegistryForRuntime,
} from '../effectiveRuntimeRegistryProvider';

function lifecycleWithStore(store: RunManifestStoreType): RunManifestLifecycle {
  return new RunManifestLifecycle({
    runId: 'run-lifecycle',
    sessionId: 'session-lifecycle',
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    runtime: 'pi-agent-core',
    providerId: null,
    outputLanguage: 'en',
    analysisMode: 'auto',
    skillRegistry: {
      registryFingerprint: 'registry-a',
      skills: [],
    },
    store,
    now: () => 100,
  });
}

describe('RunManifestLifecycle', () => {
  it('captures the canonical M0 apply flag name', () => {
    expect(buildRunManifestFeatureFlagSnapshot({
      SELF_EVOLUTION_ENABLED: 'true',
      SELF_EVOLUTION_APPLY: 'true',
      SELF_EVOLUTION_APPLY_ENABLED: 'false',
    })).toEqual(expect.objectContaining({
      selfEvolutionEnabled: true,
      selfEvolutionApplyEnabled: true,
    }));
  });

  it('retries persistence with the exact sealed DTO without resealing', () => {
    const append = jest.fn()
      .mockImplementationOnce(() => {
        throw new Error('temporary-store-failure');
      })
      .mockImplementation(() => ({
        storage: 'ephemeral',
        idempotent: false,
      }));
    const pin = jest.fn();
    const unpin = jest.fn();
    const store = {
      append,
      pin,
      unpin,
    } as unknown as RunManifestStoreType;
    const lifecycle = lifecycleWithStore(store);

    expect(() => lifecycle.sealOnceAndPersist()).toThrow('temporary-store-failure');
    expect(lifecycle.state).toBe('sealed_not_persisted');
    const firstDto = append.mock.calls[0]?.[1];
    const persisted = lifecycle.sealOnceAndPersist();

    expect(lifecycle.state).toBe('persisted');
    expect(append.mock.calls[1]?.[1]).toBe(firstDto);
    expect(persisted).toBe(firstDto);
    expect(pin).toHaveBeenCalledTimes(2);
    expect(unpin).toHaveBeenCalledTimes(1);
    expect(pin.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0],
    );
    expect(pin).toHaveBeenCalledWith(
      {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      persisted.runManifestId,
    );
  });

  it('pins a newly sealed manifest before bounded ephemeral append can evict it', () => {
    const store = new RunManifestStore({
      persistence: {
        persistence: 'unavailable',
        reason: 'data_root_not_writable',
        configured: false,
        writable: false,
        outsidePackage: false,
        externalMount: false,
        dataRoot: '/tmp/test',
        packageRoot: '/tmp/package',
        checkedAt: 1,
      },
      ephemeralCapacity: 1,
    });
    const occupied = lifecycleWithStore(store);
    const current = new RunManifestLifecycle({
      runId: 'run-current',
      sessionId: 'session-current',
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      runtime: 'pi-agent-core',
      providerId: null,
      outputLanguage: 'en',
      analysisMode: 'auto',
      skillRegistry: {
        registryFingerprint: 'registry-a',
        skills: [],
      },
      store,
      now: () => 101,
    });

    const occupiedManifest = occupied.sealOnceAndPersist();
    const currentManifest = current.sealOnceAndPersist();

    expect(store.get(
      current.identity.scope,
      occupiedManifest.runManifestId,
    )).toEqual(occupiedManifest);
    expect(store.get(
      current.identity.scope,
      currentManifest.runManifestId,
    )).toEqual(currentManifest);
    occupied.dispose();
    current.dispose();
    store.close();
  });

  it('provides the bound sink through async context and rejects identity conflicts', async () => {
    const store = {
      append: jest.fn(),
      pin: jest.fn(),
      unpin: jest.fn(),
    } as unknown as RunManifestStoreType;
    const lifecycle = lifecycleWithStore(store);

    await withRunManifestLifecycle(lifecycle, async () => {
      await Promise.resolve();
      expect(currentRunManifestAttributionSink()).toBe(lifecycle.builder);
    });

    const conflicting = {
      ...lifecycle.builder,
      identity: {
        ...lifecycle.identity,
        runId: 'other-run',
      },
    } as unknown as typeof lifecycle.builder;
    expect(() => resolveRunManifestAttributionSink(
      lifecycle.builder,
      conflicting,
    )).toThrow('run_manifest_sink_identity_conflict');
  });

  it('binds the exact runtime registry snapshot and fails closed when it is absent', async () => {
    const store = {
      append: jest.fn(),
      pin: jest.fn(),
      unpin: jest.fn(),
    } as unknown as RunManifestStoreType;
    const registry = {
      registryFingerprint: 'registry-a',
      overlayGeneration: 'builtin:registry-a',
      isInitialized: () => true as const,
      getSkill: () => undefined,
      getAllSkills: () => [],
      getFragmentCache: () => new Map<string, string>(),
      getSkillOrigin: () => undefined,
      getAppliedOverlayIds: () => [],
      getVendorOverride: () => undefined,
      getVendorOverridesForSkill: () => [],
      findMatchingSkill: () => undefined,
    };
    const snapshot: EffectiveRuntimeRegistrySnapshot = {
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      baseSkillRegistryFingerprint: 'registry-a',
      baseStrategyRegistryFingerprint: 'strategy-a',
      overlayGeneration: 'builtin:registry-a',
      skillRegistry: registry,
      strategyRegistry: {
        registryFingerprint: 'strategy-a',
        overlayGeneration: 'builtin:registry-a',
        getStrategy: () => undefined,
        getAllStrategies: () => [],
      },
    };
    const pinned = new RunManifestLifecycle({
      runId: 'run-pinned',
      sessionId: 'session-pinned',
      scope: snapshot.scope,
      runtime: 'pi-agent-core',
      outputLanguage: 'en',
      analysisMode: 'auto',
      skillRegistry: {
        registryFingerprint: 'registry-a',
        evolutionOverlayGeneration: 'builtin:registry-a',
        skills: [],
      },
      runtimeRegistrySnapshot: snapshot,
      store,
    });
    await withRunManifestLifecycle(pinned, async () => {
      await Promise.resolve();
      expect(currentEffectiveRuntimeRegistrySnapshot()).toBe(snapshot);
      expect(resolveEffectiveSkillRegistryForRuntime(registry)).toBe(registry);
    });

    const missing = lifecycleWithStore(store);
    expect(() => withRunManifestLifecycle(missing, () =>
      resolveEffectiveSkillRegistryForRuntime(registry)))
      .toThrow('effective_runtime_registry_snapshot_missing_for_run');
  });

  it('seals before four receipt projections that all reference the same manifest', async () => {
    const store = {
      append: jest.fn(),
      pin: jest.fn(),
      unpin: jest.fn(),
    } as unknown as RunManifestStoreType;
    const lifecycle = lifecycleWithStore(store);

    await withRunManifestLifecycle(lifecycle, async () => {
      const manifest = lifecycle.sealOnceAndPersist();
      const session = {
        sessionId: 'session-lifecycle',
        traceId: 'trace-lifecycle',
        query: 'analyze',
        dataEnvelopes: [],
      };
      const result = {
        sessionId: 'session-lifecycle',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'done',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 10,
      };
      const receipts = [
        buildAnalysisReceipt({
          runManifestId: manifest.runManifestId,
          session,
          result,
          finalArtifacts: {reportId: 'report-a'},
        }),
        buildAnalysisReceipt({
          runManifestId: manifest.runManifestId,
          session,
          result,
          finalArtifacts: {resultSnapshotId: 'snapshot-a'},
        }),
        buildAnalysisReceipt({
          runManifestId: manifest.runManifestId,
          session,
          result,
          finalArtifacts: {
            reportId: 'report-a',
            resultSnapshotId: 'snapshot-a',
          },
        }),
        buildAnalysisReceipt({
          runManifestId: manifest.runManifestId,
          session,
          result,
          cliTurnPath: '/tmp/session-lifecycle/turns/001.md',
        }),
      ];

      expect(receipts.map(receipt => receipt.schemaVersion)).toEqual([2, 2, 2, 2]);
      expect(new Set(receipts.map(receipt => receipt.runManifestId))).toEqual(
        new Set([manifest.runManifestId]),
      );
    });
  });

  it('disposes every active lifecycle for the cleaned-up session scope', () => {
    const store = {
      append: jest.fn(() => ({
        storage: 'ephemeral',
        idempotent: false,
      })),
      pin: jest.fn(),
      unpin: jest.fn(),
    } as unknown as RunManifestStoreType;
    const create = (runId: string, sessionId: string) => createRunManifestLifecycle({
      runId,
      sessionId,
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      runtime: 'pi-agent-core',
      outputLanguage: 'en',
      analysisMode: 'auto',
      skillRegistry: {
        registryFingerprint: 'registry-a',
        skills: [],
      },
      store,
      now: () => 100,
    });
    try {
      const first = create('run-first', 'session-cleanup');
      const second = create('run-second', 'session-cleanup');
      const other = create('run-other', 'session-other');
      first.sealOnceAndPersist();
      second.sealOnceAndPersist();

      expect(disposeRunManifestLifecyclesForSession(
        {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
        'session-cleanup',
      )).toBe(2);
      expect(first.state).toBe('disposed');
      expect(second.state).toBe('disposed');
      expect(other.state).toBe('collecting');
      expect(store.unpin).toHaveBeenCalledTimes(2);
    } finally {
      clearRunManifestLifecyclesForTests();
    }
  });
});
