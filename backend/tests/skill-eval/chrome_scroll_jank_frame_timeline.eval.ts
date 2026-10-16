/**
 * Chrome scroll jank / frame timeline evaluation.
 *
 * Current checked-in fixtures are Android app traces, so this suite verifies
 * graceful no-data behavior and stable output schemas. Chrome trace fixtures
 * can extend this with non-empty v3/v4 rows later.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'scroll-demo-customer-scroll.pftrace';

describeWithTrace('chrome_scroll_jank_frame_timeline skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('chrome_scroll_jank_frame_timeline');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('reports Chrome scroll data availability without misclassifying Android traces', async () => {
    const result = await evaluator.executeStep('chrome_trace_availability');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(expect.objectContaining({
      chrome_scroll_count: expect.any(Number),
      chrome_scroll_stats_count: expect.any(Number),
      chrome_scroll_v4_frame_count: expect.any(Number),
      chrome_scroll_v4_jank_count: expect.any(Number),
      status: expect.any(String),
    }));
    expect(result.data[0].status).toBe('no_chrome_scroll_data');
  }, 30000);

  it('keeps v3/v4 detail steps executable when Chrome rows are absent', async () => {
    const v3 = await evaluator.executeStep('chrome_scroll_v3_summary');
    const v4 = await evaluator.executeStep('chrome_scroll_v4_janky_frames');
    const timeline = await evaluator.executeStep('chrome_preferred_frame_timeline');

    expect(v3.error).toBeUndefined();
    expect(v3.success).toBe(true);
    expect(v3.data).toHaveLength(0);

    expect(v4.error).toBeUndefined();
    expect(v4.success).toBe(true);
    expect(v4.data).toHaveLength(0);

    expect(timeline.error).toBeUndefined();
    expect(timeline.success).toBe(true);
    expect(timeline.data).toHaveLength(0);
  }, 60000);
});
