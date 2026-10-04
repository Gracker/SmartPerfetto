// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildStrategyRegistrySnapshot,
  buildStrategyRegistrySnapshotFromDefinitions,
  fingerprintStrategyDefinition,
  getFinalReportContract,
  getRegisteredScenes,
  getStrategyContent,
  getStrategyDetails,
  invalidateStrategyCache,
  loadStrategies,
  parseStrategyContribution,
  type StrategyRegistryContribution,
} from '../strategyLoader';
import fs from 'fs';
import {withEffectiveRuntimeRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';

const scope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
};

function contribution(
  overrides: Partial<StrategyRegistryContribution> = {},
): StrategyRegistryContribution {
  const base = loadStrategies().get('scrolling')!;
  return {
    contributionId: 'contribution-a',
    scope,
    scene: 'scrolling',
    baseStrategyFingerprint: fingerprintStrategyDefinition(base),
    createdAt: '2026-07-28T00:00:00.000Z',
    operations: [
      {
        op: 'append_core',
        operationId: 'append-core-a',
        content: 'Overlay core section.',
      },
      {
        op: 'append_detail_sections',
        operationId: 'append-detail-a',
        sections: [{
          id: 'overlay_detail_a',
          ref: 'scrolling:overlay_detail_a',
          title: 'Overlay detail',
          keywords: ['overlay'],
          content: 'Overlay detail section.',
          default: false,
        }],
      },
    ],
    ...overrides,
  };
}

describe('strategy registry snapshots', () => {
  beforeEach(() => {
    invalidateStrategyCache();
  });

  it('merges closed contributions while preserving untouched base contracts', () => {
    const base = loadStrategies().get('scrolling')!;
    const snapshot = buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [contribution()],
    });
    const effective = snapshot.getStrategy('scrolling')!;

    expect(effective.content).toContain(base.content);
    expect(effective.content).toContain('Overlay core section.');
    expect(effective.detailSections.map(detail => detail.id)).toContain('overlay_detail_a');
    expect(effective.planTemplate).toEqual(base.planTemplate);
    expect(effective.finalReportContract).toEqual(base.finalReportContract);
    expect(effective.requiredCapabilities).toEqual(base.requiredCapabilities);
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.phaseHints)).toBe(true);
  });

  it('rejects scope, base fingerprint, unknown operation, and id conflicts', () => {
    expect(() => buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [contribution({
        scope: {...scope, workspaceId: 'other'},
      })],
    })).toThrow('strategy_contribution_scope_mismatch');

    expect(() => buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [contribution({baseStrategyFingerprint: 'stale'})],
    })).toThrow('strategy_contribution_base_fingerprint_mismatch');

    expect(() => buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [{
        ...contribution(),
        operations: [{
          op: 'replace_core',
          operationId: 'replace-core-a',
          content: 'replace',
        }],
      }],
    })).toThrow('strategy_contribution_unknown_operation');

    // Phase hints reach no analysis; only a persisted overlay may still name them.
    const appendsPhaseHints = contribution({
      operations: [{
        op: 'append_phase_hints',
        operationId: 'append-legacy-hint',
        hints: [{id: 'legacy_hint', constraints: 'Legacy.'}],
      }],
    });
    expect(() => buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [appendsPhaseHints],
    })).toThrow('strategy_contribution_inert_operation');
    expect(() => parseStrategyContribution(appendsPhaseHints))
      .toThrow('strategy_contribution_inert_operation');
    expect(parseStrategyContribution(appendsPhaseHints, {legacyPhaseHints: 'read'})
      .operations).toEqual(appendsPhaseHints.operations);
  });

  it('makes every strategy getter observe the same pinned snapshot', () => {
    const snapshot = buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [contribution()],
    });
    const runtimeSnapshot = {
      scope,
      baseSkillRegistryFingerprint: 'skills-a',
      baseStrategyRegistryFingerprint: 'strategies-a',
      overlayGeneration: 'overlay:test',
      skillRegistry: {} as never,
      strategyRegistry: snapshot,
      skillNotes: {
        registryFingerprint: 'skill-notes-a',
        getSkillNotes: () => [],
        getSkillIds: () => [],
      },
    };

    withEffectiveRuntimeRegistrySnapshot(runtimeSnapshot, () => {
      expect(getStrategyContent('scrolling')).toContain('Overlay core section.');
      expect(getStrategyDetails('scrolling').map(detail => detail.id)).toContain('overlay_detail_a');
      expect(getRegisteredScenes().find(scene => scene.scene === 'scrolling'))
        .toBe(snapshot.getStrategy('scrolling'));
      expect(getFinalReportContract('scrolling'))
        .toBe(snapshot.getStrategy('scrolling')?.finalReportContract);
    });
  });

  it('excludes installation paths from semantic Strategy fingerprints', () => {
    const base = loadStrategies().get('scrolling')!;
    expect(fingerprintStrategyDefinition({
      ...base,
      sourcePath: '/another/install/backend/strategies/scrolling.strategy.md',
    })).toBe(fingerprintStrategyDefinition(base));
  });

  it('loads and trims declared investigation requirements without changing absent legacy fields', () => {
    const sourcePath = loadStrategies().get('scrolling')!.sourcePath;
    const readFileSync = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
      String(file) === sourcePath
        ? '---\nscene: scrolling\ninvestigation_requirements: ["  Follow the observed work.  "]\n---\nFixture core.'
        : readFileSync(file, options));
    try {
      const loaded = loadStrategies().get('scrolling')!;
      expect(loaded.investigationRequirements).toEqual(['Follow the observed work.']);
      expect(Object.isFrozen(loaded.investigationRequirements)).toBe(true);
      read.mockImplementation((file, options) => String(file) === sourcePath
        ? '---\nscene: scrolling\n---\nLegacy core.' : readFileSync(file, options));
      const legacy = loadStrategies().get('scrolling')!;
      expect(legacy).not.toHaveProperty('investigationRequirements');
      const snapshot = buildStrategyRegistrySnapshotFromDefinitions({definitions: [legacy], overlayGeneration: 'legacy'});
      expect(snapshot.getStrategy('scrolling')).not.toHaveProperty('investigationRequirements');
    } finally {read.mockRestore();}
  });

  it.each(['null', '[]', '"a scalar"', '[42]', '["valid", "  "]', '["valid", null]'])(
    'rejects malformed investigation requirements: %s', declaration => {
      const sourcePath = loadStrategies().get('scrolling')!.sourcePath;
      const readFileSync = fs.readFileSync;
      const read = jest.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
        String(file) === sourcePath
          ? `---\nscene: scrolling\ninvestigation_requirements: ${declaration}\n---\nFixture core.`
          : readFileSync(file, options));
      try {expect(() => loadStrategies()).toThrow('strategy_invalid_investigation_requirements');}
      finally {read.mockRestore();}
    },
  );

  it('pins investigation requirements in an independent frozen array and semantic fingerprint', () => {
    const base = loadStrategies().get('scrolling')!;
    const requirements = ['Explain the actual main-thread work.'];
    const definition = {...base, investigationRequirements: requirements};
    const snapshot = buildStrategyRegistrySnapshotFromDefinitions({definitions: [definition], overlayGeneration: 'one'});
    const pinned = snapshot.getStrategy('scrolling')!;
    expect(pinned.investigationRequirements).toEqual(requirements);
    expect(pinned.investigationRequirements).not.toBe(requirements);
    expect(Object.isFrozen(pinned.investigationRequirements)).toBe(true);
    expect(() => pinned.investigationRequirements!.push('mutate the pin')).toThrow();
    requirements[0] = 'Changed evidence boundary.';
    expect(pinned.investigationRequirements).toEqual(['Explain the actual main-thread work.']);
    expect(fingerprintStrategyDefinition(definition)).not.toBe(fingerprintStrategyDefinition(pinned));
    const updated = buildStrategyRegistrySnapshotFromDefinitions({definitions: [definition], overlayGeneration: 'one'});
    expect(updated.registryFingerprint).not.toBe(snapshot.registryFingerprint);
  });
});
