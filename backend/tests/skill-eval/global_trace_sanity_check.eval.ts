/**
 * Global Trace Sanity Check Skill Evaluation Tests
 *
 * Verifies that the global sanity skill stays executable on a real trace and
 * that global list-style evidence is surfaced in stable layers.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  SkillEvaluator,
  createSkillEvaluator,
  describeWithTrace,
  findStepInLayers,
  getTestTracePath,
} from './runner';

const TRACE_FILE = 'launch_light.pftrace';
const TRACE_FILES = [
  'lacunh_heavy.pftrace',
  'launch_light.pftrace',
  'scroll_Standard-AOSP-App-Without-PreAnimation.pftrace',
  'scroll-demo-customer-scroll.pftrace',
  'Scroll-Flutter-327-TextureView.pftrace',
  'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace',
] as const;
const REQUIRED_STEPS = [
  'trace_window',
  'top_long_slices',
  'top_d_state_threads',
  'top_runnable_waits',
  'runqueue_pressure',
  'top_cpu_processes',
] as const;

function expectColumnWhenRows(step: { data?: any[] } | null, column: string): void {
  if (!step?.data?.length) return;
  expect(Object.prototype.hasOwnProperty.call(step.data[0], column)).toBe(true);
}

function toNs(value: unknown): bigint {
  return BigInt(String(value));
}

describeWithTrace('global_trace_sanity_check skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('global_trace_sanity_check');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('normalizes reversed time windows and clamps max_rows', async () => {
    const result = await evaluator.executeStep('trace_window', {
      start_ts: 2,
      end_ts: 1,
      max_rows: 1000,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(String(result.data[0].start_ts)).toBe('1');
    expect(String(result.data[0].end_ts)).toBe('2');
    expect(Number(result.data[0].max_rows)).toBe(100);
  }, 30000);

  it('executes all global evidence steps and exposes list results', async () => {
    const result = await evaluator.executeSkill({ max_rows: 5 });

    expect(result.success).toBe(true);

    for (const stepId of REQUIRED_STEPS) {
      const step = findStepInLayers(result.layers, stepId);
      expect(step).toBeTruthy();
      expect(step?.success).toBe(true);
      expect(Array.isArray(step?.data)).toBe(true);
    }

    expect(findStepInLayers(result.layers, 'top_long_slices')?.data?.length).toBeGreaterThan(0);
    expect(findStepInLayers(result.layers, 'runqueue_pressure')?.data).toHaveLength(1);
    expect(findStepInLayers(result.layers, 'top_cpu_processes')?.data?.length).toBeGreaterThan(0);
    expectColumnWhenRows(findStepInLayers(result.layers, 'runqueue_pressure'), 'cpu_count');
    expectColumnWhenRows(findStepInLayers(result.layers, 'runqueue_pressure'), 'runnable_wait_ge4_ms');
    expectColumnWhenRows(findStepInLayers(result.layers, 'runqueue_pressure'), 'over_cpu_capacity_ms');
    expect((result.layers.list || {}).top_d_state_threads).toBeDefined();
    expect((result.layers.list || {}).top_runnable_waits).toBeDefined();
    expectColumnWhenRows(findStepInLayers(result.layers, 'top_d_state_threads'), 'utid');
    expectColumnWhenRows(findStepInLayers(result.layers, 'top_runnable_waits'), 'utid');
    expectColumnWhenRows(findStepInLayers(result.layers, 'top_cpu_processes'), 'upid');
    expectColumnWhenRows(findStepInLayers(result.layers, 'top_cpu_processes'), 'process_key');
  }, 120000);

  it('keeps runqueue pressure defined for zero-runnable windows', async () => {
    const result = await evaluator.executeStep('runqueue_pressure', {
      start_ts: 1,
      end_ts: 2,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(Number(result.data[0].samples)).toBeGreaterThanOrEqual(1);
    expect(Number(result.data[0].avg_runnable_threads)).toBe(0);
    expect(Number(result.data[0].p95_runnable_threads)).toBe(0);
    expect(Number(result.data[0].max_runnable_threads)).toBe(0);
  }, 30000);

  it('separates fixed runnable threshold from CPU-capacity pressure', async () => {
    const result = await evaluator.executeStep('runqueue_pressure');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    const row = result.data[0];
    expect(Number(row.cpu_count)).toBeGreaterThan(0);
    expect(Number(row.runnable_wait_ge4_ms)).toBeGreaterThanOrEqual(Number(row.over_cpu_capacity_ms));
    expect(Number(row.pressure_weighted_ms)).toBe(Number(row.over_cpu_capacity_ms));
  }, 30000);

  it('attributes process-track slices to their process when available', async () => {
    const result = await evaluator.executeStep('top_long_slices', { max_rows: 20 });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.some(row =>
      row.slice_name === 'VSync'
      && row.track_scope === 'process_track'
      && row.process_name !== '<unnamed process>'
      && row.thread_name === '<process track>',
    )).toBe(true);
  }, 30000);

  it('returns only process-attributed track scopes without fabricating thread identities', async () => {
    const result = await evaluator.executeStep('top_long_slices', { max_rows: 100 });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    for (const row of result.data) {
      expect(['thread_track', 'process_track']).toContain(row.track_scope);
      expect(row.process_name).not.toBe('<unnamed process>');
      if (row.track_scope === 'process_track') {
        expect(row.thread_name).toBe('<process track>');
      } else {
        expect(row.thread_name).not.toBe('<process track>');
      }
    }
  }, 30000);

  it('clips range timestamps and durations to the requested window', async () => {
    const seed = await evaluator.executeStep('top_long_slices', { max_rows: 1 });
    expect(seed.success).toBe(true);
    expect(seed.data.length).toBeGreaterThan(0);

    const seedRow = seed.data[0];
    const sliceStart = toNs(seedRow.slice_start_ts);
    const sliceDur = toNs(seedRow.slice_dur_ns);
    expect(sliceDur).toBeGreaterThan(2n);

    const startTs = sliceStart + 1n;
    const endTs = sliceStart + (sliceDur > 1_000_000n ? 1_000_000n : sliceDur);
    const result = await evaluator.executeStep('top_long_slices', {
      start_ts: startTs.toString(),
      end_ts: endTs.toString(),
      max_rows: 5,
    });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    for (const row of result.data) {
      expect(toNs(row.ts)).toBeGreaterThanOrEqual(startTs);
      expect(toNs(row.ts)).toBeLessThan(endTs);
      expect(toNs(row.dur_ns)).toBeGreaterThan(0n);
      expect(toNs(row.dur_ns)).toBeLessThanOrEqual(endTs - startTs);
    }
  }, 30000);

  it('preserves positive duration evidence for a one-nanosecond overlap', async () => {
    const seed = await evaluator.executeStep('top_long_slices', { max_rows: 1 });
    expect(seed.success).toBe(true);
    expect(seed.data.length).toBeGreaterThan(0);

    const startTs = toNs(seed.data[0].slice_start_ts);
    const result = await evaluator.executeStep('top_long_slices', {
      start_ts: startTs.toString(),
      end_ts: (startTs + 1n).toString(),
      max_rows: 1,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(toNs(result.data[0].dur_ns)).toBe(1n);
    expect(Number(result.data[0].duration_ms)).toBeGreaterThan(0);
  }, 30000);

  it('enforces real Skill row-count boundaries', async () => {
    const atomicEvaluator = createSkillEvaluator('longest_process_slices');
    try {
      await atomicEvaluator.loadTrace(getTestTracePath(TRACE_FILE));
      const minimum = await atomicEvaluator.executeRuntimeSkill({ max_rows: 0 });
      const requested = await atomicEvaluator.executeRuntimeSkill({ max_rows: 5 });
      const maximum = await atomicEvaluator.executeRuntimeSkill({ max_rows: 999 });

      expect(minimum.success).toBe(true);
      expect(minimum.displayResults[0]?.data?.rows).toHaveLength(1);
      expect(requested.success).toBe(true);
      expect(requested.displayResults[0]?.data?.rows).toHaveLength(5);
      expect(maximum.success).toBe(true);
      expect(maximum.displayResults[0]?.data?.rows).toHaveLength(100);
    } finally {
      await atomicEvaluator.cleanup();
    }
  }, 120000);

  it('executes on every canonical trace fixture', async () => {
    for (const traceFile of TRACE_FILES) {
      const caseEvaluator = createSkillEvaluator('global_trace_sanity_check');
      try {
        // eslint-disable-next-line no-await-in-loop
        await caseEvaluator.loadTrace(getTestTracePath(traceFile));
        // eslint-disable-next-line no-await-in-loop
        const result = await caseEvaluator.executeSkill({ max_rows: 3 });

        expect(result.success).toBe(true);
        for (const stepId of REQUIRED_STEPS) {
          const step = findStepInLayers(result.layers, stepId);
          expect(step).toBeTruthy();
          expect(step?.success).toBe(true);
          expect(Array.isArray(step?.data)).toBe(true);
        }

        expect(findStepInLayers(result.layers, 'runqueue_pressure')?.data).toHaveLength(1);
        expectColumnWhenRows(findStepInLayers(result.layers, 'runqueue_pressure'), 'cpu_count');
        expectColumnWhenRows(findStepInLayers(result.layers, 'runqueue_pressure'), 'over_cpu_capacity_ms');
        expectColumnWhenRows(findStepInLayers(result.layers, 'top_d_state_threads'), 'utid');
        expectColumnWhenRows(findStepInLayers(result.layers, 'top_runnable_waits'), 'utid');
        expectColumnWhenRows(findStepInLayers(result.layers, 'top_cpu_processes'), 'upid');
        expectColumnWhenRows(findStepInLayers(result.layers, 'top_cpu_processes'), 'process_key');
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await caseEvaluator.cleanup();
      }
    }
  }, 240000);
});
