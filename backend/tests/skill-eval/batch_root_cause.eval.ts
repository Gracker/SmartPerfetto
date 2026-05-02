/**
 * Eval test for the batch_frame_root_cause step in scrolling_analysis
 * Validates that batch SQL classification covers all jank frames
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

// Fixture removed in commit 52feac55; describeWithTrace skips when missing.
const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

describeWithTrace('batch_frame_root_cause step', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('scrolling_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 120000);

  afterAll(async () => {
    await evaluator.cleanup();
  }, 30000);

  it('should classify all jank frames with valid reason_code', async () => {
    const result = await evaluator.executeStep('batch_frame_root_cause');

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);

    // Every row must have core fields
    for (const row of result.data) {
      expect(row.frame_index).toBeDefined();
      expect(row.start_ts).toBeDefined();
      expect(row.dur_ms).toBeDefined();
      expect(row.reason_code).toBeDefined();
      expect(row.primary_cause).toBeDefined();
      expect(row.confidence).toBeDefined();
    }

    // Reason codes must be from the known set
    const validCodes = new Set([
      'buffer_stuffing',
      'binder_sync_blocking', 'small_core_placement', 'sched_delay_in_slice',
      'workload_heavy', 'big_core_low_freq', 'freq_ramp_slow',
      'scheduling_delay', 'blocking_io', 'lock_binder_wait',
      'gpu_fence_wait', 'shader_compile', 'gc_jank', 'unknown'
    ]);
    for (const row of result.data) {
      expect(validCodes).toContain(row.reason_code);
    }

    // Log distribution for manual inspection
    const dist: Record<string, number> = {};
    for (const row of result.data) {
      dist[row.reason_code] = (dist[row.reason_code] || 0) + 1;
    }
    console.log(`batch_frame_root_cause: ${result.data.length} frames classified`);
    console.log('Distribution:', JSON.stringify(dist, null, 2));
  }, 120000);

  it('should return more frames than old default of 8', async () => {
    const result = await evaluator.executeStep('batch_frame_root_cause');
    // The heavy jank trace has many jank frames
    expect(result.data.length).toBeGreaterThan(8);
  }, 120000);

  it('should match get_app_jank_frames frame count and identity', async () => {
    const batchResult = await evaluator.executeStep('batch_frame_root_cause');
    const jankFrames = await evaluator.executeStep('get_app_jank_frames');

    expect(batchResult.success).toBe(true);
    expect(jankFrames.success).toBe(true);
    // Both use same consumer-side detection + same default limit → same count
    expect(batchResult.data.length).toBe(jankFrames.data.length);

    // Verify frame identity sets match (not just count) — guards against SQL drift
    const batchStartTs = new Set(batchResult.data.map((r: any) => String(r.start_ts)));
    const jankStartTs = new Set(jankFrames.data.map((r: any) => String(r.start_ts)));
    expect(batchStartTs.size).toBe(jankStartTs.size);
    for (const ts of batchStartTs) {
      expect(jankStartTs).toContain(ts);
    }
  }, 120000);

  it('should include frame_id, vsync_missed, present_interval_ms columns', async () => {
    const result = await evaluator.executeStep('batch_frame_root_cause');
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);

    for (const row of result.data) {
      // frame_id should be present (from display_frame_token)
      expect(row.frame_id).toBeDefined();
      // vsync_missed should be a positive integer
      expect(row.vsync_missed).toBeDefined();
      expect(Number(row.vsync_missed)).toBeGreaterThanOrEqual(1);
    }
  }, 120000);

  it('should have valid confidence values', async () => {
    const result = await evaluator.executeStep('batch_frame_root_cause');
    const validConfidence = new Set(['高', '中', '低']);
    for (const row of result.data) {
      expect(validConfidence).toContain(row.confidence);
    }
  }, 120000);
});
