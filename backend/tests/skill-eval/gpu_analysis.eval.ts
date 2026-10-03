/**
 * GPU Analysis Skill Evaluation Tests
 *
 * Runs gpu_analysis on the constructed gpu-workload case: one GPU frequency
 * level held to trace end, the fixture app's GPU memory growing from 128MB to
 * 192MB, and the base scroll trace's FrameTimeline.
 *
 * Absolute MHz values are not asserted: the Skill reads `gpufreq` as Hz while
 * trace_processor labels that counter kHz, which is an open unit question.
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
    it('should summarize the single frequency level held to trace end', async () => {
      const result = await evaluator.executeStep('gpu_freq_overview');

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      const gpu = result.data[0];
      expect(gpu.gpu_id).toBe(0);
      expect(gpu.min_freq_mhz).toBeLessThanOrEqual(gpu.weighted_avg_freq_mhz);
      expect(gpu.weighted_avg_freq_mhz).toBeLessThanOrEqual(gpu.max_freq_mhz);
      expect(gpu.freq_levels).toBe(1);
      expect(gpu.freq_change_count).toBe(0);
      expect(gpu.max_freq_time_pct).toBe(100);
      expect(gpu.total_time_sec).toBeGreaterThan(3);
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
      expect(result.data).toEqual([expect.objectContaining({gpu_id: 0, time_pct: 100, is_max_freq: '是'})]);
    }, 30000);

    it('should report the whole frequency interval as one high-load period', async () => {
      const result = await evaluator.executeStep('gpu_high_load_periods');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([expect.objectContaining({gpu_id: 0, segment_count: 1})]);
      expect(result.data[0].high_freq_dur_ms).toBeGreaterThan(3000);
    }, 30000);
  });

  describe('GPU-Frame Correlation', () => {
    it('should group the frames inside the frequency interval by jank type', async () => {
      const result = await evaluator.executeStep('gpu_frame_correlation');

      // The frames come from the base scroll trace: count them independently.
      const frames = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.frequency;
        SELECT COALESCE(f.jank_type, 'None') AS jank_type, COUNT(*) AS frame_count
        FROM actual_frame_timeline_slice f
        JOIN process p USING (upid)
        JOIN android_gpu_frequency g ON g.ts <= f.ts AND g.ts + g.dur > f.ts
        WHERE f.dur > 0 AND p.name NOT LIKE '/system/%'
          AND COALESCE(f.display_frame_token, f.surface_frame_token) IS NOT NULL
        GROUP BY 1
      `);
      expect(frames.error).toBeUndefined();
      expect(frames.rows.length).toBeGreaterThan(1);

      expect(result.success).toBe(true);
      const byType = Object.fromEntries(result.data.map(row => [row.jank_type, row.frame_count]));
      expect(byType).toEqual(Object.fromEntries(frames.rows));
      for (const row of result.data) {
        expect(row.avg_frame_dur_ms).toBeLessThanOrEqual(row.max_frame_dur_ms);
      }
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

  it('should have valid prerequisites', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill!.prerequisites).toBeDefined();
    expect(skill!.prerequisites!.modules).toContain('android.gpu.frequency');
    expect(skill!.prerequisites!.modules).toContain('android.gpu.memory');
  });
});
