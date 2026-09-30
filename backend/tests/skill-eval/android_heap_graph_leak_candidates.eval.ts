/**
 * android_heap_graph_leak_candidates Skill Evaluation Tests
 *
 * The checked-in launch fixture has no heap graph rows. This verifies the
 * leak-candidate path keeps a stable empty-data contract when heap graph data
 * is absent.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('android_heap_graph_leak_candidates skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('android_heap_graph_leak_candidates');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('keeps leak candidate detection executable with empty heap graph data', async () => {
    const result = await evaluator.executeStep('leak_candidates');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  }, 30000);

  it('keeps reference holder lookup executable with no suspect objects', async () => {
    const result = await evaluator.executeStep('reference_holders');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  }, 30000);
});
