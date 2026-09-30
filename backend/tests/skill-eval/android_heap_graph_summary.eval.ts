/**
 * android_heap_graph_summary Skill Evaluation Tests
 *
 * The checked-in launch fixture has no heap graph rows. This verifies the
 * upstream heap-dump workflow translation returns a stable no-data contract.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('android_heap_graph_summary skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('android_heap_graph_summary');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('reports a stable no-data availability row when no heap graph exists', async () => {
    const result = await evaluator.executeStep('heap_graph_availability');

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(expect.objectContaining({
      sample_count: 0,
      process_count: 0,
      reachable_heap_mb: 0,
      total_heap_mb: 0,
      status: 'no_heap_graph_data',
    }));
  }, 30000);

  it('keeps heap sample and retained-class steps executable with empty data', async () => {
    const samples = await evaluator.executeStep('heap_graph_samples');
    const classes = await evaluator.executeStep('top_retained_classes');

    expect(samples.error).toBeUndefined();
    expect(samples.success).toBe(true);
    expect(samples.data).toHaveLength(0);

    expect(classes.error).toBeUndefined();
    expect(classes.success).toBe(true);
    expect(classes.data).toHaveLength(0);
  }, 45000);
});
