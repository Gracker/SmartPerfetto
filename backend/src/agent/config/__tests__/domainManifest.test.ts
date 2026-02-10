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

  it('treats all-group route as wildcard for unknown scene types', () => {
    const route = resolveSceneReconstructionRoute('memory_pressure_spike', DEFAULT_DOMAIN_MANIFEST);
    expect(route?.directSkillId).toBe('scrolling_analysis');
  });
});
