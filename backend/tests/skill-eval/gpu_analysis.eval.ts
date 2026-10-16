/**
 * GPU Analysis Skill Evaluation Tests
 *
 * Runs gpu_analysis on the constructed gpu-workload case: one GPU frequency
 * level held to trace end, the fixture app's GPU memory growing from 128MB to
 * 192MB, and the base scroll trace's FrameTimeline.
 *
 * The frequency event is power/gpu_frequency with state 700000, which
 * trace_processor stores as kHz: the Skill must report 700 MHz.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'gpu-workload';
const FIXTURE_APP = 'com.smartperfetto.fixture';
const FIXTURE_GPU_MEMORY = {
  process_name: FIXTURE_APP,
  max_gpu_memory_mb: 192,
  avg_gpu_memory_mb: 160,
  min_gpu_memory_mb: 128,
  memory_change_mb: 64,
};

describeWithTrace('gpu_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('gpu_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('should find GPU frequency, GPU memory and FrameTimeline in the fixture', async () => {
    const result = await evaluator.executeStep('data_check');

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{has_gpu_freq: 1, has_gpu_memory: 1, has_frame_timeline: 1, has_gpu_data: 1}]);
  }, 30000);

  it('should keep the GPU work period inside the base trace', async () => {
    // The work period's bounds are CLOCK_MONOTONIC_RAW; written as trace time
    // they once landed 61 hours past the 8 s base trace and stretched it.
    const result = await evaluator.executeSQL(`
      INCLUDE PERFETTO MODULE android.gpu.work_period;
      SELECT
        (trace_end() - trace_start()) / 1e9 AS trace_s,
        (SELECT COUNT(*) FROM android_gpu_work_period_track t JOIN slice s ON s.track_id = t.id
          WHERE s.ts >= trace_start() AND s.ts + s.dur <= trace_end()) AS periods
    `);
    expect(result.error).toBeUndefined();
    const [traceSeconds, periods] = result.rows[0];
    expect(traceSeconds).toBeLessThan(10);
    expect(periods).toBe(1);
  }, 30000);

  describe('L1: Overview Layer', () => {
    it('should summarize each GPU: one held level, and one that was off before it ran', async () => {
      const result = await evaluator.executeStep('gpu_freq_overview');

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      const [gpu0, gpu1] = result.data;
      expect(gpu0).toEqual(expect.objectContaining({
        gpu_id: 0, weighted_avg_freq_mhz: 700, max_freq_mhz: 700, min_freq_mhz: 700, off_pct: 0,
        freq_levels: 1, freq_change_count: 0, max_freq_time_pct: 100,
      }));
      expect(gpu0.total_time_sec).toBeGreaterThan(3);
      // GPU 1 was off for 450 ms, then ran at 300 MHz to the end: off time is
      // not a low frequency and does not pull the average down, and powering
      // on is no frequency change.
      expect(gpu1).toEqual(expect.objectContaining({
        gpu_id: 1, weighted_avg_freq_mhz: 300, max_freq_mhz: 300, min_freq_mhz: 300, freq_levels: 1, freq_change_count: 0,
      }));
      expect(gpu1.off_pct).toBeGreaterThan(5);
      expect(gpu1.off_pct).toBeLessThan(20);
      expect(gpu1.max_freq_time_pct + gpu1.off_pct).toBeCloseTo(100, 0);
    }, 30000);

    it('should report the fixture app GPU memory growth', async () => {
      const result = await evaluator.executeStep('gpu_memory_overview');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([FIXTURE_GPU_MEMORY]);
    }, 30000);

    it('should keep the same GPU memory row when scoped to the fixture app', async () => {
      const result = await evaluator.executeStep('gpu_memory_overview', {package: FIXTURE_APP});

      expect(result.success).toBe(true);
      expect(result.data).toEqual([FIXTURE_GPU_MEMORY]);
    }, 30000);
  });

  describe('L2: List Layer', () => {
    it('should put all frequency time at the one level', async () => {
      const result = await evaluator.executeStep('gpu_freq_distribution');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        expect.objectContaining({gpu_id: 0, state: '运行', gpu_freq_mhz: 700, time_pct: 100, is_max_freq: '是'}),
        expect.objectContaining({gpu_id: 1, state: '运行', gpu_freq_mhz: 300, is_max_freq: '是'}),
        expect.objectContaining({gpu_id: 1, state: 'GPU 关闭', gpu_freq_mhz: 0, is_max_freq: ''}),
      ]);
      expect(result.data[1].time_pct + result.data[2].time_pct).toBeCloseTo(100, 1);
    }, 30000);

    it('should report the whole frequency interval as one high-load period', async () => {
      const result = await evaluator.executeStep('gpu_high_load_periods');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        expect.objectContaining({gpu_id: 0, segment_count: 1}),
        expect.objectContaining({gpu_id: 1, segment_count: 1}),
      ]);
      expect(result.data[0].high_freq_dur_ms).toBeGreaterThan(3000);
    }, 30000);
  });

  describe('GPU-Frame Correlation', () => {
    it('should correlate every frame with each GPU, averaging its running frequency inside the frame', async () => {
      const result = await evaluator.executeStep('gpu_frame_correlation');

      // The frames come from the base scroll trace: count them independently
      // per GPU, and those whose interval overlaps a running level of that GPU.
      const frames = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.frequency;
        SELECT k.gpu_id, COALESCE(f.jank_type, 'None') AS jank_type, COUNT(*) AS frame_count,
          SUM(EXISTS (SELECT 1 FROM android_gpu_frequency g
            WHERE g.gpu_id = k.gpu_id AND g.gpu_freq > 0 AND g.ts < f.ts + f.dur AND g.ts + g.dur > f.ts)) AS with_freq
        FROM actual_frame_timeline_slice f
        JOIN process p USING (upid)
        CROSS JOIN (SELECT DISTINCT gpu_id FROM android_gpu_frequency) k
        WHERE f.dur > 0 AND p.name NOT LIKE '/system/%'
          AND COALESCE(f.display_frame_token, f.surface_frame_token) IS NOT NULL
        GROUP BY 1, 2
      `);
      expect(frames.error).toBeUndefined();
      expect(new Set(frames.rows.map(([gpu]) => gpu))).toEqual(new Set([0, 1]));

      expect(result.success).toBe(true);
      const key = (gpu: unknown, type: unknown) => `${gpu}/${type}`;
      const byGpuAndType = Object.fromEntries(result.data.map(row =>
        [key(row.gpu_id, row.jank_type), [row.frame_count, row.frames_with_running_freq]]));
      expect(byGpuAndType).toEqual(Object.fromEntries(frames.rows.map(([gpu, type, count, withFreq]) =>
        [key(gpu, type), [count, withFreq]])));
      const levels: Record<number, number> = {0: 700, 1: 300};
      for (const row of result.data) {
        expect(row.avg_frame_dur_ms).toBeLessThanOrEqual(row.max_frame_dur_ms);
        if (row.frames_with_running_freq > 0) expect(row.avg_gpu_freq_mhz).toBe(levels[row.gpu_id]);
      }
      // Both GPUs ran across the same frames, each at its own level.
      const withFreq = (gpu: number) => result.data.filter(row => row.gpu_id === gpu)
        .reduce((sum, row) => sum + row.frames_with_running_freq, 0);
      expect(withFreq(1)).toBeGreaterThan(0);
      expect(withFreq(1)).toBe(withFreq(0));
    }, 30000);
  });

  describe('Diagnosis', () => {
    it('should classify a GPU held at its top frequency as GPU bound', async () => {
      const result = await evaluator.executeStep('root_cause_classification');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([expect.objectContaining({gpu_category: 'GPU_BOUND'})]);
    }, 30000);

    it('should not run the no-GPU-data fallback', async () => {
      const result = await evaluator.executeStep('fallback_no_gpu_data');

      expect(result.code).toBe('condition_not_met');
    }, 30000);
  });

  describe('Full Skill Execution', () => {
    it('should execute the complete skill', async () => {
      const result = await evaluator.executeSkill();

      expect(result.skillId).toBe('gpu_analysis');
      expect(result.success).toBe(true);
      expect(result.layers.overview).toBeDefined();
      expect(result.layers.list).toBeDefined();
    }, 120000);

    it('should refuse a package prefix that matches several processes', async () => {
      const result = await evaluator.executeSkill({package: 'com.android'});

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Process identity could not be verified.*status=ambiguous/);
    }, 120000);
  });
});

// ===========================================================================
// Edge Cases and Error Handling Tests
// ===========================================================================

describeWithTrace('gpu_analysis edge cases', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('gpu_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
  });

  it('should refuse a package that names no process', async () => {
    await expect(evaluator.executeStep('gpu_memory_overview', {package: 'com.nonexistent.app.that.does.not.exist'}))
      .rejects.toThrow(/Process identity could not be verified.*status=not_found/);
  }, 30000);

  it('should return nothing for an inverted time range', async () => {
    for (const stepId of ['gpu_memory_overview', 'gpu_freq_distribution']) {
      const result = await evaluator.executeStep(stepId, {start_ts: 100000000000, end_ts: 50000000000});
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    }
  }, 30000);

  it('should treat null and undefined bounds as the whole trace', async () => {
    const result = await evaluator.executeStep('gpu_memory_overview', {start_ts: null, end_ts: undefined});

    expect(result.success).toBe(true);
    expect(result.data).toEqual([FIXTURE_GPU_MEMORY]);
  }, 30000);
});

// ===========================================================================
// Skill Definition Validation Tests
// ===========================================================================

describeWithTrace('gpu_analysis skill definition', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('gpu_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
  });

  it('should have correct skill metadata', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('gpu_analysis');
    expect(skill!.type).toBe('composite');
    expect(skill!.version).toBeDefined();
  });

  it('should have expected step IDs', () => {
    const stepIds = evaluator.getStepIds();

    // v3.0 step IDs
    expect(stepIds).toContain('data_check');
    expect(stepIds).toContain('gpu_freq_overview');
    expect(stepIds).toContain('gpu_memory_overview');
    expect(stepIds).toContain('gpu_freq_distribution');
    expect(stepIds).toContain('gpu_frame_correlation');
    expect(stepIds).toContain('gpu_high_load_periods');
    expect(stepIds).toContain('root_cause_classification');
  });

  it('should have valid inputs defined', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill!.inputs).toBeDefined();
    expect(Array.isArray(skill!.inputs)).toBe(true);

    const inputNames = skill!.inputs!.map(i => i.name);
    expect(inputNames).toContain('package');
    expect(inputNames).toContain('start_ts');
    expect(inputNames).toContain('end_ts');
    // v3.0 threshold inputs
    expect(inputNames).toContain('high_freq_threshold_pct');
  });

  it('should read GPU frequency only through the normalizing fragment', () => {
    const skill = evaluator.getSkillDefinition();

    // android_gpu_frequency returns the raw counter, whose unit depends on the writer.
    expect(skill!.prerequisites!.modules).toEqual(['android.gpu.memory', 'intervals.intersect']);
    const frequencySteps = (skill!.steps ?? []).filter((step: any) => /gpu_frequency_/.test(step.sql ?? ''));
    expect(frequencySteps.map((step: any) => step.id)).toEqual([
      'data_check', 'gpu_freq_overview', 'gpu_freq_distribution', 'gpu_frame_correlation',
      'gpu_high_load_periods', 'root_cause_classification',
    ]);
    for (const step of frequencySteps as any[]) {
      expect(step.sql_fragments).toContain('fragments/gpu_frequency_intervals.sql');
    }
  });
});
