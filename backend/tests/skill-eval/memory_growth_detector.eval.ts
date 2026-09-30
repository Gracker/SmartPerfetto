/**
 * memory_growth_detector Skill Evaluation Tests
 *
 * Covers the RSS/Swap trend signals used by memory_analysis and memory.strategy.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('memory_growth_detector skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('memory_growth_detector');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('reports RSS trend fields when linux process memory samples exist', async () => {
    const result = await evaluator.executeStep('memory_growth');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    if (result.data.length > 0) {
      expect(result.data[0]).toEqual(expect.objectContaining({
        process_name: expect.any(String),
        upid: expect.any(Number),
        pid: expect.any(Number),
        samples: expect.any(Number),
        duration_s: expect.any(Number),
        rss_growth_pct: expect.any(Number),
        rss_slope_mb_s: expect.any(Number),
        max_single_jump_mb: expect.any(Number),
        peak_avg_ratio: expect.any(Number),
        max_anon_ratio_pct: expect.any(Number),
        rating: expect.any(String),
      }));
    }
  }, 30000);
});
