/**
 * CPU Analysis Skill Evaluation Tests
 *
 * 测试 cpu_analysis skill 在已知 trace 文件上的行为
 * 验证关键步骤输出结构是否稳定（避免回归）
 *
 * 注意：skill-eval 使用 SkillExecutor（无 AI service），因此 ai_summary 步骤可能失败；
 * 本文件只验证 SQL/规则步骤的稳定性，不依赖 AI 总结。
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

// Fixture removed in commit 52feac55; describeWithTrace skips when missing.
const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

describeWithTrace('cpu_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('cpu_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  describe('L1: Overview Layer', () => {
    describe('get_process step', () => {
      it('should select a target process even when package is empty', async () => {
        const result = await evaluator.executeStep('get_process', { package: '' });

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);

        const p = result.data[0];
        expect(p.upid).toBeDefined();
        expect(p.pid).toBeDefined();
        expect(p.process_name).toBeDefined();
      }, 30000);

      it('should handle non-matching package gracefully', async () => {
        const result = await evaluator.executeStep('get_process', { package: 'com.nonexistent.package' });

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(0);
      }, 30000);
    });

    describe('core_type_stats step', () => {
      it('should return non-empty core type distribution', async () => {
        const result = await evaluator.executeStep('core_type_stats', { package: '' });

        expect(result.success).toBe(true);
        // app_aosp_scrolling_heavy_jank.pftrace has known CPU samples; empty means extraction regressed.
        expect(result.data.length).toBeGreaterThan(0);
        const row = result.data[0];
        expect(row.core_type).toBeDefined();
        expect(row.total_time_ms).toBeGreaterThanOrEqual(0);
        expect(row.percent).toBeGreaterThanOrEqual(0);
        expect(row.percent).toBeLessThanOrEqual(100);
      }, 30000);
    });

    describe('main_thread_states step', () => {
      it('should return non-empty main thread state breakdown', async () => {
        const result = await evaluator.executeStep('main_thread_states', { package: '' });

        expect(result.success).toBe(true);
        // Fixture includes main-thread state slices; empty means evaluator/data extraction regressed.
        expect(result.data.length).toBeGreaterThan(0);
        const row = result.data[0];
        expect(row.state).toBeDefined();
        expect(row.total_dur_ms).toBeGreaterThanOrEqual(0);
        expect(row.percent).toBeGreaterThanOrEqual(0);
        expect(row.percent).toBeLessThanOrEqual(100);
      }, 30000);
    });
  });

  describe('Full Skill Execution', () => {
    it('should execute complete skill without throwing', async () => {
      const result = await evaluator.executeSkill({ package: '' });

      expect(result.success).toBe(true);
      const overview = result.layers.overview;
      expect(overview).toBeDefined();
      expect(Object.keys(overview || {}).length).toBeGreaterThan(0);
    }, 120000);
  });
});
