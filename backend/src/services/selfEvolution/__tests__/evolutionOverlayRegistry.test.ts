// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {
  EvolutionOverlayProvenanceV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {
  createEvolutionDegradationAlertV1,
  createEvolutionRollbackReceiptV1,
  createUpgradeReconciliationReportV1,
} from '../evolutionOverlayContract';
import {EvolutionOverlayRegistry} from '../evolutionOverlayRegistry';

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};
const fingerprint = 'a'.repeat(64);

function persistence(): SelfEvolutionPersistenceCapability {
  return {
    persistence: 'available',
    configured: true,
    writable: true,
    outsidePackage: true,
    externalMount: false,
    dataRoot: '/tmp/test',
    packageRoot: '/tmp/package',
    checkedAt: 1,
  };
}

function provenance(): EvolutionOverlayProvenanceV1 {
  return {
    schemaVersion: 1,
    overlayId: 'overlay_test',
    overlayKind: 'skill_delta',
    overlayContentHash: fingerprint,
    deltaSchemaVersion: 1,
    proposalId: 'proposal_test',
    proposalRevision: 3,
    gateVerdict: 'passed',
    derivedFrom: {
      baseKind: 'skill',
      baseId: 'startup_analysis',
      baseVersion: '1',
      baseContentFingerprint: fingerprint,
      baseOrigin: 'built_in',
    },
    dependencyFingerprints: {
      loaderSchemaVersion: 'effective-runtime-registry-v1',
    },
    producedUnder: {
      buildIdentity: {
        distribution: 'portable',
        channel: 'stable',
        version: '1.3.0',
        commit: 'b'.repeat(40),
        target: 'darwin-arm64',
      },
      traceProcessorVersion: 'v49.0',
      testedMatrix: [{runtime: 'openai-agents-sdk'}],
    },
    compatibility: {
      smartPerfettoMinVersion: '1.3.0',
      smartPerfettoMaxVersionTested: '1.3.0',
    },
    createdAt: 1,
    actor: {userId: 'maintainer'},
    scope,
  };
}

describe('EvolutionOverlayRegistry', () => {
  it('keeps staged actions non-executable and commits atomically', () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(),
    });
    const staged = registry.stageEntry({
      entryId: 'entry_test',
      overlayId: 'overlay_test',
      overlayKind: 'skill_delta',
      scope,
      proposalId: 'proposal_test',
      proposalRevision: 3,
      artifactContentHash: fingerprint,
      actionId: 'action_apply',
      baseRelation: 'unchanged',
      validationState: 'passed',
      userDisabled: false,
      createdAt: 1,
      provenance: provenance(),
    });

    expect(staged.actionState).toBe('staged');
    expect(registry.listEffectiveEntries(scope)).toEqual([]);
    expect(registry.commitAction('action_apply')).toBe(1);
    expect(registry.listEffectiveEntries(scope)).toEqual([
      expect.objectContaining({
        entryId: 'entry_test',
        actionState: 'committed',
        activationState: 'active',
        effectiveEnabled: true,
      }),
    ]);
    expect(registry.abortAction('action_apply')).toBe(0);
    registry.close();
  });

  it('derives activation priority from user, base, and validation dimensions', () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(),
    });
    registry.stageEntry({
      entryId: 'entry_test',
      overlayId: 'overlay_test',
      overlayKind: 'skill_delta',
      scope,
      proposalId: 'proposal_test',
      proposalRevision: 3,
      artifactContentHash: fingerprint,
      actionId: 'action_apply',
      baseRelation: 'unchanged',
      validationState: 'passed',
      userDisabled: false,
      createdAt: 1,
      provenance: provenance(),
    });

    expect(registry.reconcileEntry({
      scope,
      entryId: 'entry_test',
      baseRelation: 'changed',
      validationState: 'pending',
    })).toMatchObject({
      activationState: 'inactive',
      effectiveEnabled: false,
    });
    expect(registry.reconcileEntry({
      scope,
      entryId: 'entry_test',
      baseRelation: 'missing',
      validationState: 'passed',
    })).toMatchObject({
      activationState: 'quarantined',
      effectiveEnabled: false,
    });
    expect(registry.reconcileEntry({
      scope,
      entryId: 'entry_test',
      baseRelation: 'unchanged',
      validationState: 'passed',
      userDisabled: true,
    })).toMatchObject({
      activationState: 'disabled',
      effectiveEnabled: false,
    });
    registry.close();
  });

  it('publishes a prepared generation only through the matching fence', () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(),
    });
    const prepared = registry.prepareGeneration({
      scope,
      candidateGeneration: '1'.repeat(64),
      expectedFence: 0,
      actionId: 'action_apply',
      persistedAt: 10,
    });
    expect(prepared).toMatchObject({state: 'prepared', fence: 1});
    expect(() => registry.prepareGeneration({
      scope,
      candidateGeneration: '2'.repeat(64),
      expectedFence: 0,
    })).toThrow('evolution_generation_fence_conflict');
    expect(() => registry.publishGeneration({
      scope,
      candidateGeneration: '1'.repeat(64),
      fence: 2,
    })).toThrow('evolution_generation_publish_fence_lost');

    expect(registry.publishGeneration({
      scope,
      candidateGeneration: '1'.repeat(64),
      fence: 1,
    })).toMatchObject({
      state: 'published',
      candidateGeneration: '1'.repeat(64),
      publishedGeneration: '1'.repeat(64),
    });
    expect(registry.generationHead(scope)).toMatchObject({
      state: 'published',
      fence: 1,
      publishedGeneration: '1'.repeat(64),
    });
    registry.close();
  });

  it('persists immutable reports, explicit rollbacks, and non-rollback alerts', () => {
    const registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(),
    });
    const identity = {
      distribution: 'portable' as const,
      channel: 'stable' as const,
      version: '1.3.0',
      commit: 'b'.repeat(40),
      target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
      signingMode: 'macos-developer-id-notarized' as const,
    };
    const report = createUpgradeReconciliationReportV1({
      reportId: 'report_test',
      scope,
      previousBuildIdentity: null,
      currentBuildIdentity: identity,
      candidateGeneration: '1'.repeat(64),
      publishedGeneration: '1'.repeat(64),
      byBaseRelation: {
        unchanged: ['overlay_test'],
        changed: [],
        absorbed: [],
        missing: [],
        incompatible: [],
      },
      byValidationState: {
        pending: [],
        passed: ['overlay_test'],
        failed: [],
        error: [],
      },
      byActivationState: {
        active: ['overlay_test'],
        inactive: [],
        quarantined: [],
        obsolete: [],
        disabled: [],
      },
      issues: [],
      createdAt: 20,
    });
    registry.saveReport(report);
    expect(registry.latestReport(scope)).toEqual(report);

    const receipt = createEvolutionRollbackReceiptV1({
      actionId: 'action_revert',
      scope,
      kind: 'local_overlay_reverted',
      targetId: 'overlay_test',
      idempotent: true,
      sideEffectContentHash: fingerprint,
      createdAt: 21,
    });
    registry.saveRollbackReceipt(receipt);
    registry.saveRollbackReceipt(receipt);
    expect(registry.listRollbackReceipts(scope, 'action_revert'))
      .toEqual([receipt]);
    expect(registry.listRollbackReceipts(
      {tenantId: 'other', workspaceId: scope.workspaceId},
      'action_revert',
    )).toEqual([]);

    const alert = createEvolutionDegradationAlertV1({
      alertId: 'alert_test',
      scope,
      overlayIds: ['overlay_test'],
      observedGeneration: '1'.repeat(64),
      reasonCode: 'quality_regression',
      evidenceContentHashes: [fingerprint],
      autoRollback: false,
      createdAt: 22,
    });
    registry.saveDegradationAlert(alert);
    expect(registry.listDegradationAlerts(scope)).toEqual([alert]);
    registry.close();
  });
});
