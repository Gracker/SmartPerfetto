// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import type {ApplicationBuildIdentity} from '../../applicationUpdate/types';
import type {SkillDefinition} from '../../skillEngine/types';
import {getWorkspaceSkillRegistry} from '../../skillPacks/workspaceSkillRegistryProvider';
import type {
  AppliedProposalRevisionV1,
  CurationProposalV1,
  EvolutionOverlayPayloadV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  createEvolutionOverlayArtifactV1,
} from '../evolutionOverlayContract';
import {EvolutionOverlayArtifactStore} from '../evolutionOverlayArtifactStore';
import {EvolutionOverlayRegistry} from '../evolutionOverlayRegistry';
import {
  buildEffectiveRuntimeRegistrySnapshot,
  clearEffectiveRuntimeRegistrySnapshotsForTests,
  getPublishedEffectiveRuntimeRegistrySnapshot,
} from '../effectiveRuntimeRegistryProvider';
import {OverlayReconciler} from '../overlayReconciler';
import {ProposalApplicationService} from '../proposalApplicationService';
import type {ProposalStore} from '../proposalStore';
import {fingerprintSkillDefinition} from '../skillFingerprint';

jest.mock('../../skillPacks/workspaceSkillRegistryProvider', () => ({
  getWorkspaceSkillRegistry: jest.fn(),
}));

const scope = {tenantId: 'tenant', workspaceId: 'workspace'};
const identity: ApplicationBuildIdentity = {
  distribution: 'portable',
  channel: 'stable',
  version: '1.3.0',
  commit: 'a'.repeat(40),
  target: {os: 'darwin', arch: 'arm64', id: 'darwin-arm64'},
  signingMode: 'macos-developer-id-notarized',
};

describe('OverlayReconciler', () => {
  let root: string;
  let currentBase: SkillDefinition | undefined;
  let registry: EvolutionOverlayRegistry;
  let artifactStore: EvolutionOverlayArtifactStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-reconciler-'));
    currentBase = baseSkill();
    clearEffectiveRuntimeRegistrySnapshotsForTests();
    (
      getWorkspaceSkillRegistry as jest.MockedFunction<
        typeof getWorkspaceSkillRegistry
      >
    ).mockImplementation(async () => {
      const definitions = currentBase ? [currentBase] : [];
      const view = {
        isInitialized: () => true,
        getAllSkills: () => definitions,
        getSkill: (name: string) =>
          definitions.find(definition => definition.name === name),
        getFragmentCache: () => new Map<string, string>(),
        getSkillOrigin: () => ({origin: 'built_in' as const}),
        getVendorOverride: () => undefined,
        getVendorOverridesForSkill: () => [],
        getVendorOverrideLoadIssues: () => [],
        findMatchingSkill: () => undefined,
      };
      return {
        registry: view,
        registryFingerprint: canonicalContentHash(definitions),
        enabledPacks: [],
        getSkillOrigin: view.getSkillOrigin,
      } as unknown as Awaited<ReturnType<typeof getWorkspaceSkillRegistry>>;
    });
    registry = new EvolutionOverlayRegistry({
      databasePath: ':memory:',
      persistence: persistence(root),
    });
    artifactStore = new EvolutionOverlayArtifactStore({
      rootDirectory: path.join(root, 'user-data', 'overlays', 'objects'),
      persistence: persistence(root),
    });
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('isolates pending overlays, validates, publishes, and pins bound inputs', async () => {
    stageArtifact('overlay_one', 'first_tag');
    let observedInactive = false;
    const reconcile = new OverlayReconciler({
      registry,
      artifactStore,
      persistence: persistence(root),
      buildIdentity: identity,
      buildIdentityFilePath: path.join(root, 'identity.json'),
      traceProcessorVersion: 'v49.0',
      now: () => 100,
      buildSnapshot: async input => {
        if (input.skillOverlays?.length) {
          observedInactive = registry.listEntries(scope)[0]
            .activationState === 'inactive';
        }
        return buildEffectiveRuntimeRegistrySnapshot(input);
      },
    });

    const result = await reconcile.reconcile(scope);

    expect(observedInactive).toBe(true);
    expect(result.report.byActivationState.active).toEqual(['overlay_one']);
    expect(result.report.byValidationState.passed).toEqual(['overlay_one']);
    expect(registry.listEffectiveEntries(scope)).toEqual([
      expect.objectContaining({
        overlayId: 'overlay_one',
        baseRelation: 'unchanged',
        validationState: 'passed',
        activationState: 'active',
      }),
    ]);
    const validation = registry.listEntries(scope)[0].provenance.validation;
    expect(validation?.validationInputFingerprint).toBe(
      canonicalContentHash(validation?.boundInputs),
    );
    expect(getPublishedEffectiveRuntimeRegistrySnapshot(scope))
      .toBe(result.snapshot);
  });

  it('classifies base change, deletion, and downgrade conservatively', async () => {
    stageArtifact('overlay_one', 'first_tag');
    const reconcile = new OverlayReconciler({
      registry,
      artifactStore,
      persistence: persistence(root),
      buildIdentity: identity,
      buildIdentityFilePath: path.join(root, 'identity.json'),
      traceProcessorVersion: 'v49.0',
      now: (() => {
        let now = 100;
        return () => now++;
      })(),
    });
    await reconcile.reconcile(scope);

    currentBase = {
      ...baseSkill(),
      version: '2.0.0',
      meta: {...baseSkill().meta, description: 'Upstream changed.'},
    };
    expect((await reconcile.reconcile(scope)).report.byBaseRelation.changed)
      .toEqual(['overlay_one']);
    expect(registry.listEffectiveEntries(scope)).toHaveLength(1);

    currentBase = undefined;
    expect((await reconcile.reconcile(scope)).report.byBaseRelation.missing)
      .toEqual(['overlay_one']);
    expect(registry.listEffectiveEntries(scope)).toEqual([]);

    currentBase = {...baseSkill(), version: '0.5.0'};
    expect((await reconcile.reconcile(scope)).report.byBaseRelation.incompatible)
      .toEqual(['overlay_one']);
    expect(registry.listEntries(scope)[0].activationState)
      .toBe('quarantined');
  });

  it('fails the whole conflicting group and publishes the base snapshot', async () => {
    stageArtifact('overlay_one', 'first_tag');
    stageArtifact('overlay_two', 'second_tag');
    const reconcile = new OverlayReconciler({
      registry,
      artifactStore,
      persistence: persistence(root),
      buildIdentity: identity,
      buildIdentityFilePath: path.join(root, 'identity.json'),
      traceProcessorVersion: 'v49.0',
      now: () => 100,
    });

    const result = await reconcile.reconcile(scope);

    expect(result.report.byValidationState.failed)
      .toEqual(['overlay_one', 'overlay_two']);
    expect(result.report.byActivationState.quarantined)
      .toEqual(['overlay_one', 'overlay_two']);
    expect(result.report.issues).toEqual([
      expect.objectContaining({reasonCode: 'overlay_conflict'}),
    ]);
    expect(result.snapshot.overlayGeneration).toMatch(/^builtin:/);
  });

  it('applies then reverts through the durable action boundary consistently', async () => {
    const overlayId = 'overlay_apply_revert';
    const proposalId = `proposal_${overlayId}`;
    const artifact = artifactFor(overlayId, 'applied_tag');
    let proposal = {
      proposalId,
      revision: 3,
      status: 'accepted',
      tier: 'T0',
      scope,
    } as CurationProposalV1;
    const revisions: AppliedProposalRevisionV1[] = [];
    let actionArtifactContentHashes: string[] = [];
    const proposalStore = {
      get: () => proposal,
      reserveAction: (input: {
        actionId: string;
        kind: 'apply' | 'revert';
        artifactContentHashes?: string[];
      }) => {
        actionArtifactContentHashes = input.artifactContentHashes ?? [];
        return {
          schemaVersion: 1,
          actionId: input.actionId,
          kind: input.kind,
          scope,
          proposalId,
          artifactContentHashes: actionArtifactContentHashes,
          expectedRevision: input.kind === 'apply' ? 3 : 4,
          targetRevision: input.kind === 'apply' ? 4 : 5,
          state: 'pending',
          sideEffectKind: 'runtime_overlay',
          createdAt: 10,
          updatedAt: 10,
        };
      },
      markActionExecuting: (actionId: string) => ({
        schemaVersion: 1,
        actionId,
        kind: actionId === 'apply_action' ? 'apply' : 'revert',
        scope,
        proposalId,
        artifactContentHashes: actionArtifactContentHashes,
        expectedRevision: actionId === 'apply_action' ? 3 : 4,
        targetRevision: actionId === 'apply_action' ? 4 : 5,
        state: 'executing',
        sideEffectKind: 'runtime_overlay',
        createdAt: 10,
        updatedAt: 11,
      }),
      recordActionSideEffectReceipt: (actionId: string) =>
        (proposalStore as unknown as {
          markActionExecuting(id: string): unknown;
        }).markActionExecuting(actionId),
      commitAppliedRevision: (input: {
        actionId: string;
        generation: string;
        overlayIds: string[];
        receiptContentHashes: string[];
      }) => {
        const kind = input.actionId === 'apply_action' ? 'apply' : 'revert';
        const revision = {
          schemaVersion: 1,
          ordinal: revisions.length + 1,
          proposalId,
          proposalRevision: kind === 'apply' ? 4 : 5,
          actionId: input.actionId,
          kind,
          scope,
          overlayIds: input.overlayIds,
          generation: input.generation,
          receiptContentHashes: input.receiptContentHashes,
          actor: {userId: 'maintainer'},
          createdAt: 12,
          contentHash: canonicalContentHash(input),
        } as AppliedProposalRevisionV1;
        revisions.push(revision);
        proposal = {
          ...proposal,
          revision: revision.proposalRevision,
          status: kind === 'apply' ? 'applied' : 'reverted',
        };
        return revision;
      },
      finalizeActionRecord: () => undefined,
      listAppliedRevisions: () => revisions,
      getAction: () => undefined,
    } as unknown as ProposalStore;
    const reconcile = new OverlayReconciler({
      registry,
      artifactStore,
      persistence: persistence(root),
      buildIdentity: identity,
      buildIdentityFilePath: path.join(root, 'identity.json'),
      traceProcessorVersion: 'v49.0',
      now: (() => {
        let now = 100;
        return () => now++;
      })(),
    });
    const service = new ProposalApplicationService({
      proposalStore,
      overlayRegistry: registry,
      artifactStore,
      reconciler: reconcile,
      authorize: () => undefined,
      materializeArtifacts: () => [artifact],
      now: (() => {
        let now = 20;
        return () => now++;
      })(),
    });

    await service.apply({
      actionId: 'apply_action',
      scope,
      proposalId,
      actor: {userId: 'maintainer'},
    });
    expect(registry.listEffectiveEntries(scope))
      .toEqual([expect.objectContaining({overlayId})]);

    await service.revert({
      actionId: 'revert_action',
      scope,
      proposalId,
      actor: {userId: 'maintainer'},
    });
    expect(registry.listEffectiveEntries(scope)).toEqual([]);
    expect(registry.listEntries(scope)).toEqual([
      expect.objectContaining({
        overlayId,
        userDisabled: true,
        activationState: 'disabled',
      }),
    ]);
    expect(registry.listRollbackReceipts(scope, 'revert_action')).toEqual([
      expect.objectContaining({kind: 'local_overlay_reverted', targetId: overlayId}),
    ]);
    expect(revisions.map(revision => revision.proposalRevision)).toEqual([4, 5]);
  });

  function stageArtifact(overlayId: string, tag: string): void {
    const artifact = artifactFor(overlayId, tag);
    artifactStore.put(artifact);
    registry.stageEntry({
      entryId: `entry_${overlayId}`,
      overlayId,
      overlayKind: 'skill_delta',
      scope,
      proposalId: `proposal_${overlayId}`,
      proposalRevision: 3,
      artifactContentHash: artifact.contentHash,
      actionId: `action_${overlayId}`,
      baseRelation: 'unchanged',
      validationState: 'pending',
      userDisabled: false,
      createdAt: 1,
      provenance: artifact.provenance,
    });
    registry.commitAction(`action_${overlayId}`);
  }

  function artifactFor(overlayId: string, tag: string) {
    const base = baseSkill();
    const baseFingerprint = fingerprintSkillDefinition(base);
    const payload: EvolutionOverlayPayloadV1 = {
      schemaVersion: 1,
      payloadKind: 'skill_delta',
      skillOverlay: {
        schemaVersion: 1,
        overlayId,
        baseSkillId: base.name,
        baseFingerprint,
        proposalId: `proposal_${overlayId}`,
        createdAt: '2026-07-29T00:00:00.000Z',
        scope,
        operations: [{
          op: 'set_metadata',
          operationId: `set_tags_${overlayId}`,
          meta: {tags: [tag]},
        }],
      },
    };
    const artifact = createEvolutionOverlayArtifactV1({
      artifactId: `artifact:${overlayId}`,
      payload,
      provenance: {
        schemaVersion: 1,
        overlayId,
        overlayKind: 'skill_delta',
        overlayContentHash: canonicalContentHash(payload),
        deltaSchemaVersion: 1,
        proposalId: `proposal_${overlayId}`,
        proposalRevision: 3,
        gateVerdict: 'passed',
        derivedFrom: {
          baseKind: 'skill',
          baseId: base.name,
          baseVersion: base.version,
          baseContentFingerprint: baseFingerprint,
          baseOrigin: 'built_in',
        },
        dependencyFingerprints: {
          loaderSchemaVersion: 'effective-runtime-registry-v1',
        },
        producedUnder: {
          buildIdentity: {
            distribution: identity.distribution,
            channel: identity.channel,
            version: identity.version,
            commit: identity.commit,
            target: identity.target.id,
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
      },
    });
    return artifact;
  }
});

function baseSkill(): SkillDefinition {
  return {
    name: 'startup_analysis',
    version: '1.0.0',
    type: 'composite',
    meta: {
      display_name: 'Startup',
      description: 'Base startup analysis.',
      tags: [],
    },
    steps: [{
      id: 'base_step',
      type: 'atomic',
      sql: 'SELECT 1 AS value',
    }],
  };
}

function persistence(root: string): SelfEvolutionPersistenceCapability {
  return {
    persistence: 'available',
    configured: true,
    writable: true,
    outsidePackage: true,
    externalMount: false,
    dataRoot: path.join(root, 'user-data'),
    packageRoot: path.join(root, 'package'),
    checkedAt: 1,
  };
}
