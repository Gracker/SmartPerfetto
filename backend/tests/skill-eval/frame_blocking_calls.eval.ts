/**
 * frame_blocking_calls Skill Evaluation Tests
 *
 * Verifies the upstream android.critical_blocking_calls integration exposes
 * thread-role provenance so MainThread / RenderThread / Binder blocking can be
 * distinguished by agents and the UI.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'scroll-demo-customer-scroll.pftrace';

describeWithTrace('frame_blocking_calls skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;
  let targetProcessName = '';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('frame_blocking_calls');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    const processResult = await evaluator.executeSQL(`
      SELECT p.name, COUNT(*) AS frame_count
      FROM actual_frame_timeline_slice a
      JOIN process p ON p.upid = a.upid
      WHERE p.name IS NOT NULL
        AND p.name != ''
        AND COALESCE(a.jank_type, 'None') != 'None'
      GROUP BY p.name
      ORDER BY frame_count DESC
      LIMIT 1
    `);

    if (!processResult.error && processResult.rows.length > 0) {
      targetProcessName = processResult.rows[0][0] as string;
    }
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('returns structured display output with blocking thread provenance', async () => {
    expect(targetProcessName).not.toBe('');

    const result = await evaluator.executeRuntimeSkill({ process_name: targetProcessName });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.displayResults.length).toBeGreaterThan(0);

    const table = result.displayResults[0].data;
    const columns = table.columns ?? [];
    const rows = table.rows ?? [];
    expect(columns).toEqual(expect.arrayContaining([
      'frame_id',
      'thread_role',
      'thread_name',
      'blocking_call',
      'overlap_ms',
    ]));

    if (rows.length > 0) {
      const roleIndex = columns.indexOf('thread_role');
      const nameIndex = columns.indexOf('thread_name');
      expect(roleIndex).toBeGreaterThanOrEqual(0);
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(typeof rows[0][roleIndex]).toBe('string');
      expect(typeof rows[0][nameIndex]).toBe('string');
    }
  }, 30000);
});
