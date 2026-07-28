// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {jest} from '@jest/globals';

import type {SkillDefinition} from '../../skillEngine/types';
import {getWorkspaceSkillRegistry} from '../../skillPacks/workspaceSkillRegistryProvider';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  withEffectiveRuntimeRegistrySnapshot,
} from '../effectiveRuntimeRegistryContext';
import {
  buildEffectiveRuntimeRegistrySnapshot,
  clearEffectiveRuntimeRegistrySnapshotsForTests,
  getPublishedEffectiveRuntimeRegistrySnapshot,
  publishEffectiveRuntimeRegistrySnapshot,
  resolveEffectiveSkillRegistryForRuntime,
} from '../effectiveRuntimeRegistryProvider';
import {fingerprintSkillDefinition} from '../skillFingerprint';
import type {SkillOverlayDeltaV1} from '../../../types/selfEvolution';

jest.mock('../../skillPacks/workspaceSkillRegistryProvider', () => ({
  getWorkspaceSkillRegistry: jest.fn(),
}));

const scopeA = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
const scopeB = {tenantId: 'tenant-a', workspaceId: 'workspace-b'};

function baseSkill(): SkillDefinition {
  return {
    name: 'base_analysis',
    version: '1',
    type: 'composite',
    meta: {
      display_name: 'Base analysis',
      description: 'Base description',
    },
    steps: [{
      id: 'base_step',
      type: 'atomic',
      sql: 'SELECT 1 AS base_value',
    }],
  };
}

function overlay(
  base: SkillDefinition,
  overlayId: string,
  scope = scopeA,
): SkillOverlayDeltaV1 {
  return {
    schemaVersion: 1,
    overlayId,
    baseSkillId: base.name,
    baseFingerprint: fingerprintSkillDefinition(base),
    proposalId: `proposal-${overlayId}`,
    createdAt: '2026-07-28T00:00:00.000Z',
    scope,
    operations: [{
      op: 'append_steps',
      operationId: `append-${overlayId}`,
      steps: [{
        id: `ovl_${overlayId}_extra`,
        type: 'atomic',
        sql: 'SELECT 2 AS overlay_value',
      }],
    }],
  };
}

function mockWorkspace(base: SkillDefinition): void {
  const definitions = [base];
  const registry = {
    isInitialized: () => true,
    getAllSkills: () => definitions,
    getSkill: (name: string) =>
      definitions.find(definition => definition.name === name),
    getFragmentCache: () => new Map<string, string>(),
    getSkillOrigin: () => ({origin: 'built_in' as const}),
    getVendorOverride: () => undefined,
    getVendorOverridesForSkill: () => [],
    findMatchingSkill: () => undefined,
  };
  (
    getWorkspaceSkillRegistry as jest.MockedFunction<
      typeof getWorkspaceSkillRegistry
    >
  ).mockResolvedValue({
    registry,
    registryFingerprint: 'base-registry-fingerprint',
    enabledPacks: [],
    getSkillOrigin: registry.getSkillOrigin,
  } as unknown as Awaited<ReturnType<typeof getWorkspaceSkillRegistry>>);
}

describe('effective runtime registry provider', () => {
  beforeEach(() => {
    clearEffectiveRuntimeRegistrySnapshotsForTests();
    jest.clearAllMocks();
  });

  it('uses the exact no-overlay sentinel and never mutates the base registry', async () => {
    const base = baseSkill();
    mockWorkspace(base);
    const snapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
    });

    expect(snapshot.overlayGeneration).toBe(
      'builtin:base-registry-fingerprint',
    );
    expect(snapshot.skillRegistry.getSkill(base.name)).not.toBe(base);
    expect(base.steps?.map(step => step.id)).toEqual(['base_step']);
    expect(Object.isFrozen(snapshot.skillRegistry.getSkill(base.name))).toBe(
      true,
    );
  });

  it('publishes scope-isolated generations only for new run contexts', async () => {
    const base = baseSkill();
    mockWorkspace(base);
    const oldSnapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [overlay(base, 'overlay_a')],
    });
    const newSnapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [overlay(base, 'overlay_b')],
    });
    const otherScopeSnapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeB,
    });
    publishEffectiveRuntimeRegistrySnapshot(oldSnapshot);

    const observations: string[] = [];
    await withEffectiveRuntimeRegistrySnapshot(oldSnapshot, async () => {
      observations.push(
        currentEffectiveRuntimeRegistrySnapshot()!.overlayGeneration,
      );
      publishEffectiveRuntimeRegistrySnapshot(newSnapshot);
      await Promise.resolve();
      observations.push(
        currentEffectiveRuntimeRegistrySnapshot()!.overlayGeneration,
      );
    });
    publishEffectiveRuntimeRegistrySnapshot(otherScopeSnapshot);

    expect(observations).toEqual([
      oldSnapshot.overlayGeneration,
      oldSnapshot.overlayGeneration,
    ]);
    expect(getPublishedEffectiveRuntimeRegistrySnapshot(scopeA)).toBe(
      newSnapshot,
    );
    expect(getPublishedEffectiveRuntimeRegistrySnapshot(scopeB)).toBe(
      otherScopeSnapshot,
    );
  });

  it('returns the same immutable snapshot on retries within one run context', async () => {
    const base = baseSkill();
    mockWorkspace(base);
    const snapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [overlay(base, 'overlay_a')],
    });

    await withEffectiveRuntimeRegistrySnapshot(snapshot, async () => {
      const first = currentEffectiveRuntimeRegistrySnapshot();
      await Promise.resolve();
      const retry = currentEffectiveRuntimeRegistrySnapshot();
      expect(retry).toBe(first);
      expect(() => {
        (
          first!.skillRegistry.getSkill(base.name)!.steps as SkillDefinition['steps']
        )!.push({
          id: 'mutation',
          type: 'atomic',
          sql: 'SELECT 3',
        });
      }).toThrow();
    });
  });

  it('rejects an affected overlay whose nested Skill reference is unavailable', async () => {
    const base = baseSkill();
    mockWorkspace(base);
    const invalid = overlay(base, 'overlay_a');
    invalid.operations = [{
      op: 'append_steps',
      operationId: 'append-overlay-a',
      steps: [{
        id: 'ovl_overlay_a_missing',
        type: 'skill',
        skill: 'missing_skill',
      }],
    }];

    await expect(buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [invalid],
    })).rejects.toThrow('effective_skill_validation_failed');
  });

  it('accepts metadata overlays on metadata-only pipeline definitions', async () => {
    const base: SkillDefinition = {
      name: 'pipeline_catalog_entry',
      version: '1',
      type: 'pipeline_definition',
      meta: {
        display_name: 'Pipeline catalog entry',
        description: 'Base metadata.',
      },
    };
    mockWorkspace(base);
    const metadataOverlay: SkillOverlayDeltaV1 = {
      ...overlay(base, 'overlay_a'),
      operations: [{
        op: 'set_metadata',
        operationId: 'metadata-overlay-a',
        meta: {description: 'Effective metadata.'},
      }],
    };

    const snapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [metadataOverlay],
    });

    expect(snapshot.skillRegistry.getSkill(base.name)?.meta.description)
      .toBe('Effective metadata.');
  });

  it('resolves run-time consumers to the pinned Skill snapshot', async () => {
    const base = baseSkill();
    mockWorkspace(base);
    const snapshot = await buildEffectiveRuntimeRegistrySnapshot({
      scope: scopeA,
      skillOverlays: [overlay(base, 'overlay_a')],
    });
    const fallback = {fallback: true} as never;

    withEffectiveRuntimeRegistrySnapshot(snapshot, () => {
      expect(resolveEffectiveSkillRegistryForRuntime(fallback))
        .toBe(snapshot.skillRegistry);
    });
  });
});
