// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_DOMAIN_MANIFEST,
  getAspectEvidenceChecklist,
  getModeSpecificEvidenceChecklist,
  getSceneReconstructionRoutes,
  getStrategyExecutionPolicy,
  resolveSceneReconstructionRoute,
  shouldPreferHypothesisLoop,
} from '../domainManifest';

describe('domainManifest', () => {
  it('keeps deterministic strategy route for configured strategy ids', () => {
    expect(getStrategyExecutionPolicy('scrolling')).toBe('prefer_strategy');
    expect(getStrategyExecutionPolicy('startup')).toBe('prefer_strategy');
    expect(getStrategyExecutionPolicy('scene_reconstruction')).toBe('prefer_strategy');
  });

  it('falls back to hypothesis policy for unknown strategies', () => {
    expect(getStrategyExecutionPolicy('memory_overview')).toBe('prefer_hypothesis');
  });

  it('decides hypothesis preference based on manifest policy and user loop preference', () => {
    expect(shouldPreferHypothesisLoop({
      strategyId: 'scrolling',
      preferredLoopMode: 'hypothesis_experiment',
    })).toBe(false);

    expect(shouldPreferHypothesisLoop({
      strategyId: 'memory_overview',
      preferredLoopMode: 'hypothesis_experiment',
    })).toBe(true);

    expect(shouldPreferHypothesisLoop({
      strategyId: 'memory_overview',
      preferredLoopMode: 'strategy_first',
    })).toBe(false);

    expect(shouldPreferHypothesisLoop({
      strategyId: 'memory_overview',
      preferredLoopMode: 'hypothesis_experiment',
      forceStrategy: true,
    })).toBe(false);
  });

  it('provides aspect evidence checklist from manifest mappings', () => {
    const evidences = getAspectEvidenceChecklist(['startup', 'memory', 'unknown'], DEFAULT_DOMAIN_MANIFEST);
    expect(evidences).toContain('启动阶段拆解与关键阶段耗时');
    expect(evidences).toContain('内存分配热点、GC 暂停与内存压力');
    expect(evidences).not.toContain('unknown');
  });

  it('provides mode-specific evidence checklist from manifest mappings', () => {
    expect(getModeSpecificEvidenceChecklist('compare', DEFAULT_DOMAIN_MANIFEST)).toContain(
      '对比对象统一口径指标（同窗口/同刷新率）'
    );
    expect(getModeSpecificEvidenceChecklist('strategy', DEFAULT_DOMAIN_MANIFEST)).toEqual([]);
  });

  it('keeps scene reconstruction routes in manifest and resolves startup scenes', () => {
    const routes = getSceneReconstructionRoutes(DEFAULT_DOMAIN_MANIFEST);
    expect(routes.length).toBeGreaterThanOrEqual(2);

    const startupRoute = resolveSceneReconstructionRoute('cold_start', DEFAULT_DOMAIN_MANIFEST);
    expect(startupRoute?.directSkillId).toBe('startup_detail');

    const nonStartupRoute = resolveSceneReconstructionRoute('tap', DEFAULT_DOMAIN_MANIFEST);
    expect(nonStartupRoute?.directSkillId).toBe('scrolling_analysis');
  });

  it('default manifest no longer wildcard-routes unknown scene types (commit f5942f28)', () => {
    // The default manifest deliberately whitelists scroll/interaction groups
    // instead of using sceneTypeGroups: ['all'] — wildcards used to mis-route
    // idle/screen_on/scroll_start through scrolling_analysis, none of which
    // have a meaningful Stage 2 path.
    const route = resolveSceneReconstructionRoute('memory_pressure_spike', DEFAULT_DOMAIN_MANIFEST);
    expect(route).toBeNull();
  });

  it('still treats all-group route as wildcard when manifest opts in', () => {
    const customManifest = {
      ...DEFAULT_DOMAIN_MANIFEST,
      sceneReconstructionRoutes: [
        {
          id: 'wildcard_route',
          sceneTypeGroups: ['all'] as const,
          agentId: 'frame_agent',
          domain: 'scroll',
          directSkillId: 'scrolling_analysis',
          descriptionTemplate: 'fallback',
          paramMapping: {},
        } as any,
      ],
    };
    const route = resolveSceneReconstructionRoute('memory_pressure_spike', customManifest);
    expect(route?.directSkillId).toBe('scrolling_analysis');
  });
});