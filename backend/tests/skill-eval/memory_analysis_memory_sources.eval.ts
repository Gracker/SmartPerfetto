/**
 * memory_analysis optional memory source integration tests.
 *
 * Uses the lightweight launch fixture to verify newly wired child skills remain
 * callable through the composite memory_analysis entrypoint.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('memory_analysis optional memory sources', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('memory_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('runs the RSS growth child skill through memory_analysis', async () => {
    const result = await evaluator.executeStep('memory_growth_summary', { package: '' });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  }, 45000);

  it('runs heap graph summary and leak candidates through memory_analysis', async () => {
    const summary = await evaluator.executeStep('heap_graph_summary', { package: '' });
    const candidates = await evaluator.executeStep('heap_graph_leak_candidates', { package: '' });

    expect(summary.error).toBeUndefined();
    expect(summary.success).toBe(true);
    expect(candidates.error).toBeUndefined();
    expect(candidates.success).toBe(true);
  }, 60000);
});
