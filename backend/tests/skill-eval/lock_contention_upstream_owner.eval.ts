/**
 * Lock contention upstream owner-thread evaluation.
 *
 * Verifies SmartPerfetto exposes the AndroidLockContention owner-thread
 * provenance model for both the range atomic skill and the full composite skill.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'scroll-demo-customer-scroll.pftrace';

describeWithTrace('lock contention upstream owner provenance', TRACE_FILE, () => {
  let rangeEvaluator: SkillEvaluator;
  let compositeEvaluator: SkillEvaluator;
  let startTs = '';
  let endTs = '';

  beforeAll(async () => {
    rangeEvaluator = createSkillEvaluator('lock_contention_in_range');
    await rangeEvaluator.loadTrace(getTestTracePath(TRACE_FILE));

    const bounds = await rangeEvaluator.executeSQL(`
      SELECT
        printf('%d', trace_start()) AS start_ts,
        printf('%d', trace_end()) AS end_ts
    `);

    startTs = bounds.rows[0][0] as string;
    endTs = bounds.rows[0][1] as string;

    compositeEvaluator = createSkillEvaluator('lock_contention_analysis');
    await compositeEvaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 90000);

  afterAll(async () => {
    await rangeEvaluator.cleanup();
    await compositeEvaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('returns owner-thread provenance from lock_contention_in_range', async () => {
    const result = await rangeEvaluator.executeStep('owner_contentions', {
      start_ts: startTs,
      end_ts: endTs,
      package: '',
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toEqual(expect.objectContaining({
      source: expect.any(String),
      blocked_thread_name: expect.any(String),
      blocking_thread_name: expect.any(String),
      owner_thread_state: expect.any(String),
      wait_ms: expect.any(Number),
    }));
  }, 45000);

  it('returns owner-thread provenance from lock_contention_analysis', async () => {
    const result = await compositeEvaluator.executeStep('owner_contention_events', {
      start_ts: startTs,
      end_ts: endTs,
      process_name: '',
      min_duration_ms: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toEqual(expect.objectContaining({
      source: expect.any(String),
      lock_type: expect.any(String),
      owner_tid: expect.any(Number),
      owner_thread_state: expect.any(String),
      owner_state_ms: expect.any(Number),
    }));
  }, 45000);
});
