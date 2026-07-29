// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  RunManifestScope,
  SelfEvolutionLifecycleSnapshot,
} from '../../types/selfEvolution';
import {buildIdentityValidationError} from './buildIdentityStore';
import {EvolutionOverlayArtifactStore} from './evolutionOverlayArtifactStore';
import {EvolutionOverlayRegistry} from './evolutionOverlayRegistry';
import {
  OverlayReconciler,
  type OverlayReconciliationResult,
} from './overlayReconciler';
import {ProposalApplicationService} from './proposalApplicationService';
import {ProposalStore} from './proposalStore';

export const LOCAL_SELF_EVOLUTION_SCOPE: RunManifestScope = Object.freeze({
  tenantId: 'local',
  workspaceId: 'local',
});

export interface SelfEvolutionStartupResult {
  status:
    | 'disabled'
    | 'persistence_unavailable'
    | 'identity_unavailable'
    | 'reconciled';
  reconciliations: OverlayReconciliationResult[];
}

export interface ReconcileSelfEvolutionOnStartupOptions {
  lifecycle: SelfEvolutionLifecycleSnapshot;
  traceProcessorVersion?: string;
  createRegistry?(): EvolutionOverlayRegistry;
  createArtifactStore?(): EvolutionOverlayArtifactStore;
  createReconciler?(input: {
    registry: EvolutionOverlayRegistry;
    artifactStore: EvolutionOverlayArtifactStore;
  }): OverlayReconciler;
  createProposalStore?(): ProposalStore;
  createApplicationService?(input: {
    proposalStore: ProposalStore;
    registry: EvolutionOverlayRegistry;
    artifactStore: EvolutionOverlayArtifactStore;
    reconciler: OverlayReconciler;
  }): ProposalApplicationService;
}

/**
 * The only production startup mount for M8 reconciliation. It finishes
 * recovery and publishes every persisted scope before workers or the listener
 * can create a new run.
 */
export async function reconcileSelfEvolutionOnStartup(
  options: ReconcileSelfEvolutionOnStartupOptions,
): Promise<SelfEvolutionStartupResult> {
  if (!options.lifecycle.effectiveConfig.enabled) {
    return {status: 'disabled', reconciliations: []};
  }
  if (options.lifecycle.persistence.persistence !== 'available') {
    return {status: 'persistence_unavailable', reconciliations: []};
  }
  if (buildIdentityValidationError(options.lifecycle.currentBuildIdentity)) {
    return {status: 'identity_unavailable', reconciliations: []};
  }
  const registry = options.createRegistry?.()
    ?? new EvolutionOverlayRegistry({
      persistence: options.lifecycle.persistence,
    });
  let proposalStore: ProposalStore | undefined;
  try {
    const artifactStore = options.createArtifactStore?.()
      ?? new EvolutionOverlayArtifactStore({
        persistence: options.lifecycle.persistence,
      });
    const reconciler = options.createReconciler?.({registry, artifactStore})
      ?? new OverlayReconciler({
        registry,
        artifactStore,
        persistence: options.lifecycle.persistence,
        buildIdentity: options.lifecycle.currentBuildIdentity,
        traceProcessorVersion:
          options.traceProcessorVersion?.trim() || 'bundled',
      });
    proposalStore = options.createProposalStore?.() ?? new ProposalStore();
    const applicationService = options.createApplicationService?.({
      proposalStore,
      registry,
      artifactStore,
      reconciler,
    }) ?? new ProposalApplicationService({
      proposalStore,
      overlayRegistry: registry,
      artifactStore,
      reconciler,
      authorize: () => undefined,
      materializeArtifacts: () => {
        throw new Error(
          'proposal_startup_recovery_requires_persisted_artifacts',
        );
      },
    });
    await applicationService.recoverPendingActions();
    const scopes = uniqueScopes([
      LOCAL_SELF_EVOLUTION_SCOPE,
      ...registry.listScopes(),
    ]);
    const reconciliations: OverlayReconciliationResult[] = [];
    for (const scope of scopes) {
      reconciliations.push(await reconciler.reconcile(scope));
    }
    return {status: 'reconciled', reconciliations};
  } finally {
    proposalStore?.close();
    registry.close();
  }
}

function uniqueScopes(scopes: readonly RunManifestScope[]): RunManifestScope[] {
  const unique = new Map(scopes.map(scope => [
    `${scope.tenantId}\0${scope.workspaceId}`,
    scope,
  ]));
  return [...unique.values()].sort((left, right) =>
    left.tenantId.localeCompare(right.tenantId)
    || left.workspaceId.localeCompare(right.workspaceId));
}
