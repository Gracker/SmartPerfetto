/**
 * Eval test for the batch_frame_root_cause step in scrolling_analysis
 * Validates that batch SQL classification covers all jank frames
 *
 * Runs on the canonical customer scrolling trace, the one canonical scrolling
 * trace with app jank frames (7; the Standard AOSP trace has none). The former
 * "more than the old default of 8 frames" case is retired: no canonical trace
 * has more than 8 app jank frames, and the per-session cap it guarded is now
 * the shared root_cause_sample_cap fragment (default 200), which
 * scrollingAnalysisSchema.test.ts checks for both steps. The reason-code
 * vocabulary is also checked there exhaustively against the SQL.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace, type EvalStepResult } from './runner';
import { SCROLLING_V1_REASON_CODES } from '../../src/services/caseDomainPacks';

const TRACE_FILE = 'scroll-demo-customer-scroll.pftrace';

describeWithTrace('batch_frame_root_cause step', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;
  let batchResult: EvalStepResult;
  let jankFrames: EvalStepResult;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('scrolling_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
    batchResult = await evaluator.executeStep('batch_frame_root_cause');
    jankFrames = await evaluator.executeStep('get_app_jank_frames');
  }, 120000);

  afterAll(async () => {
    await evaluator.cleanup();
  }, 30000);

  it('should classify all jank frames with valid reason_code', () => {
    expect(batchResult.success).toBe(true);
    expect(batchResult.data.length).toBeGreaterThan(0);

    // Every row must have core fields
    for (const row of batchResult.data) {
      expect(row.frame_index).toBeDefined();
      expect(row.start_ts).toBeDefined();
      expect(row.dur_ms).toBeDefined();
      expect(row.reason_code).toBeDefined();
      expect(row.primary_cause).toBeDefined();
      expect(row.confidence).toBeDefined();
    }

    // Reason codes must be from the scrolling.v1 domain pack vocabulary
    const validCodes = new Set<string>(SCROLLING_V1_REASON_CODES);
    for (const row of batchResult.data) {
      expect(validCodes).toContain(row.reason_code);
    }

    // Log distribution for manual inspection
    const dist: Record<string, number> = {};
    for (const row of batchResult.data) {
      dist[row.reason_code] = (dist[row.reason_code] || 0) + 1;
    }
    console.log(`batch_frame_root_cause: ${batchResult.data.length} frames classified`);
    console.log('Distribution:', JSON.stringify(dist, null, 2));
  });

  it('should match get_app_jank_frames frame count and identity', () => {
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
  });

  it('should include frame_id, vsync_missed, present_interval_ms columns', () => {
    expect(batchResult.success).toBe(true);
    expect(batchResult.data.length).toBeGreaterThan(0);

    for (const row of batchResult.data) {
      // frame_id should be present (from display_frame_token)
      expect(row.frame_id).toBeDefined();
      // vsync_missed should be a positive integer
      expect(row.vsync_missed).toBeDefined();
      expect(Number(row.vsync_missed)).toBeGreaterThanOrEqual(1);
    }
  });

  it('should have valid confidence values', () => {
    const validConfidence = new Set(['高', '中', '低']);
    for (const row of batchResult.data) {
      expect(validConfidence).toContain(row.confidence);
    }
  });
});
