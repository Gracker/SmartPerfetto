/**
 * android_bitmap_memory_per_process Skill Evaluation Tests
 *
 * Covers both upstream bitmap counter data and the optional heap_graph bitmap
 * metadata path. The heap_graph path is optional because the currently bundled
 * trace_processor_shell may not expose android.memory.heap_graph.bitmap yet.
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'launch_light.pftrace';

describeWithTrace('android_bitmap_memory_per_process skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('android_bitmap_memory_per_process');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('returns per-process bitmap counter rows when Bitmap Memory counters exist', async () => {
    const result = await evaluator.executeStep('bitmap_memory');

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toEqual(expect.objectContaining({
      process_name: expect.any(String),
      bitmap_count: expect.any(Number),
      total_bytes: expect.any(Number),
    }));
  }, 30000);

  it('keeps heap graph bitmap metadata as an optional upstream path', async () => {
    const result = await evaluator.executeStep('heap_bitmap_metadata');

    expect(result.success).toBe(true);
    if (result.data.length > 0) {
      expect(result.data[0]).toEqual(expect.objectContaining({
        process_name: expect.any(String),
        bitmap_object_count: expect.any(Number),
        total_bytes: expect.any(Number),
      }));
    }
  }, 30000);

  it('keeps cross-process bitmap sender attribution optional', async () => {
    const result = await evaluator.executeStep('heap_bitmap_sender_attribution');

    expect(result.success).toBe(true);
    if (result.data.length > 0) {
      expect(result.data[0]).toEqual(expect.objectContaining({
        receiver_process: expect.any(String),
        source_process: expect.any(String),
        bitmap_count: expect.any(Number),
      }));
    }
  }, 30000);
});
