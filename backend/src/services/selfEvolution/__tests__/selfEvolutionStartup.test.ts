// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';

import type {
  RunManifestScope,
  SelfEvolutionLifecycleSnapshot,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {EvolutionOverlayRegistry} from '../evolutionOverlayRegistry';
import type {OverlayReconciler} from '../overlayReconciler';
import type {ProposalApplicationService} from '../proposalApplicationService';
import type {ProposalStore} from '../proposalStore';
import {reconcileSelfEvolutionOnStartup} from '../selfEvolutionStartup';

const available: SelfEvolutionPersistenceCapability = {
  persistence: 'available',
  configured: true,
  writable: true,
  outsidePackage: true,
  externalMount: false,
  dataRoot: '/tmp/self-evolution-startup-data',
  packageRoot: '/tmp/self-evolution-startup-package',
  checkedAt: 1,
};

describe('self-evolution M8 startup ordering', () => {
  it('recovers actions before reconciling and publishing the local scope', async () => {
    const events: string[] = [];
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: available,
    });
    const reconcile = jest.fn(async (scope: RunManifestScope) => {
      events.push(`reconcile:${scope.tenantId}:${scope.workspaceId}`);
      return {snapshot: {}, report: {}};
    });

    const result = await reconcileSelfEvolutionOnStartup({
      lifecycle: lifecycle(true),
      createRegistry: () => registry,
      createArtifactStore: () => ({} as never),
      createReconciler: () => ({
        reconcile,
      } as unknown as OverlayReconciler),
      createProposalStore: () => ({
        close: () => undefined,
      } as unknown as ProposalStore),
      createApplicationService: () => ({
        recoverPendingActions: () => {
          events.push('recover');
          return Promise.resolve([]);
        },
      } as unknown as ProposalApplicationService),
    });

    expect(result.status).toBe('reconciled');
    expect(events).toEqual([
      'recover',
      'reconcile:local:local',
    ]);
  });

  it('constructs the production recovery service when no override exists', async () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: available,
    });
    const listRecoverableActions = jest.fn(() => []);
    const close = jest.fn();
    const reconcile = jest.fn(async () => ({snapshot: {}, report: {}}));

    await reconcileSelfEvolutionOnStartup({
      lifecycle: lifecycle(true),
      createRegistry: () => registry,
      createArtifactStore: () => ({} as never),
      createReconciler: () => ({
        reconcile,
      } as unknown as OverlayReconciler),
      createProposalStore: () => ({
        listRecoverableActions,
        close,
      } as unknown as ProposalStore),
    });

    expect(listRecoverableActions).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalled();
  });

  it('does not open persistent stores while the feature is disabled', async () => {
    const createRegistry = jest.fn<() => EvolutionOverlayRegistry>(() => {
      throw new Error('persistent_store_must_not_open');
    });
    const result = await reconcileSelfEvolutionOnStartup({
      lifecycle: lifecycle(false),
      createRegistry,
    });
    expect(result).toEqual({status: 'disabled', reconciliations: []});
    expect(createRegistry).not.toHaveBeenCalled();
  });
});

function lifecycle(enabled: boolean): SelfEvolutionLifecycleSnapshot {
  return {
    initializedAt: 1,
    requestedConfig: {enabled, applyEnabled: enabled},
    effectiveConfig: {enabled, applyEnabled: enabled},
    persistence: available,
    migration: {status: 'source_not_found'},
    currentBuildIdentity: {
      distribution: 'source',
      channel: 'stable',
      version: '1.3.0',
      commit: 'a'.repeat(40),
      target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
      signingMode: 'source-checkout',
    },
    buildIdentityState: {status: 'missing', record: null},
    warnings: [],
    errors: [],
  };
}
