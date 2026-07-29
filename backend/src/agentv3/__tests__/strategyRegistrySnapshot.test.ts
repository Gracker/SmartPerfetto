// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildStrategyRegistrySnapshot,
  fingerprintStrategyDefinition,
  getFinalReportContract,
  getPhaseHints,
  getRegisteredScenes,
  getStrategyContent,
  getStrategyDetails,
  invalidateStrategyCache,
  loadStrategies,
  type StrategyRegistryContribution,
} from '../strategyLoader';
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
        op: 'append_phase_hints',
        operationId: 'append-hint-a',
        hints: [{
          id: 'overlay_hint_a',
          keywords: ['overlay'],
          constraints: 'Use overlay evidence.',
          criticalTools: ['invoke_skill'],
          critical: false,
        }],
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
    expect(effective.phaseHints.map(hint => hint.id)).toContain('overlay_hint_a');
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

    const base = loadStrategies().get('scrolling')!;
    expect(() => buildStrategyRegistrySnapshot({
      scope,
      overlayGeneration: 'overlay:test',
      contributions: [contribution({
        operations: [{
          op: 'append_phase_hints',
          operationId: 'append-conflicting-hint',
          hints: [{
            ...base.phaseHints[0],
          }],
        }],
      })],
    })).toThrow('strategy_overlay_conflict:phase_hint');
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
      expect(getPhaseHints('scrolling').map(hint => hint.id)).toContain('overlay_hint_a');
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
});
