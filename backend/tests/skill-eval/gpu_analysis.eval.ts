/**
 * GPU Analysis Skill Evaluation Tests
 *
 * Tests gpu_analysis skill behavior on known trace files.
 * Validates SQL queries produce correct structures and data.
 *
 * Note: gpu_analysis requires GPU counter data (gpu_counter_track table)
 * and optionally android.gpu.frequency/memory modules.
 * Tests gracefully handle cases where GPU data may not be present.
 *
 * IMPORTANT: Some steps in gpu_analysis use Perfetto stdlib modules that may
 * not be available in all traces or versions. Tests are designed to:
 * 1. Skip validation when data is not present
 * 2. Handle module import errors gracefully
 * 3. Verify result structure when execution succeeds
 *
 * Skill v3.0 step IDs:
 *   data_check, gpu_freq_overview, gpu_memory_overview, gpu_freq_distribution,
 *   gpu_frame_correlation, gpu_high_load_periods, root_cause_classification,
 *   fallback_no_gpu_data
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

// Use a general Android trace file - GPU data availability varies by device/trace.
// Fixture removed in commit 52feac55; describeWithTrace skips when missing.
const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

describeWithTrace('gpu_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;
  let hasGpuFrequencyData = false;
  let hasGpuMemoryData = false;
  let hasFrameTimelineData = false;
  let hasAndroidFramesModule = false;
  let hasAndroidGpuMemoryModule = false;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('gpu_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // Check if trace has GPU frequency data
    try {
      const freqResult = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM gpu_counter_track
        WHERE name LIKE '%freq%'
        LIMIT 1
      `);
      hasGpuFrequencyData = !freqResult.error && freqResult.rows.length > 0 && freqResult.rows[0][0] > 0;
    } catch (e) {
      hasGpuFrequencyData = false;
    }

    // Check if trace has GPU memory data
    try {
      const memResult = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM gpu_counter_track
        WHERE name LIKE '%mem%'
        LIMIT 1
      `);
      hasGpuMemoryData = !memResult.error && memResult.rows.length > 0 && memResult.rows[0][0] > 0;
    } catch (e) {
      hasGpuMemoryData = false;
    }

    // Check if trace has FrameTimeline data (for GPU-frame correlation)
    try {
      const frameResult = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
        LIMIT 1
      `);
      hasFrameTimelineData = !frameResult.error && frameResult.rows.length > 0 && frameResult.rows[0][0] > 0;
    } catch (e) {
      hasFrameTimelineData = false;
    }

    // Check if android.frames module is available (it may not exist in older Perfetto versions)
    try {
      const framesModuleResult = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.frames;
        SELECT 1 as test
      `);
      hasAndroidFramesModule = !framesModuleResult.error;
    } catch (e) {
      hasAndroidFramesModule = false;
    }

    // Check if android.gpu.memory module produces data
    try {
      const gpuMemModuleResult = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.memory;
        SELECT COUNT(*) as count FROM android_gpu_memory_per_process LIMIT 1
      `);
      hasAndroidGpuMemoryModule = !gpuMemModuleResult.error && gpuMemModuleResult.rows.length > 0 && gpuMemModuleResult.rows[0][0] > 0;
    } catch (e) {
      hasAndroidGpuMemoryModule = false;
    }

    console.log(`[Test Info] GPU Frequency Data: ${hasGpuFrequencyData}`);
    console.log(`[Test Info] GPU Memory Data: ${hasGpuMemoryData}`);
    console.log(`[Test Info] FrameTimeline Data: ${hasFrameTimelineData}`);
    console.log(`[Test Info] android.frames Module: ${hasAndroidFramesModule}`);
    console.log(`[Test Info] android.gpu.memory Module: ${hasAndroidGpuMemoryModule}`);

    if (!hasGpuFrequencyData && !hasGpuMemoryData) {
      console.warn(`[Test Warning] Trace ${TRACE_FILE} does not have GPU data. Some tests will verify graceful handling.`);
    }
  }, 60000); // 60 second timeout for loading trace

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  // ===========================================================================
  // L1 Overview Layer Tests
  // ===========================================================================

  describe('L1: Overview Layer', () => {
    describe('gpu_freq_overview step', () => {
      it('should execute and return data or fail gracefully', async () => {
        const result = await evaluator.executeStep('gpu_freq_overview');

        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          console.log(`[Test Info] gpu_freq_overview failed: ${result.error}`);
          expect(result.error).toBeDefined();
        }
      }, 30000);

      it('should return frequency overview when GPU data exists', async () => {
        const result = await evaluator.executeStep('gpu_freq_overview');

        if (result.success && hasGpuFrequencyData && result.data.length > 0) {
          const firstRow = result.data[0];
          expect(firstRow).toHaveProperty('gpu_id');
          expect(firstRow).toHaveProperty('weighted_avg_freq_mhz');
          expect(firstRow).toHaveProperty('max_freq_mhz');
          expect(firstRow).toHaveProperty('min_freq_mhz');
        }
      }, 30000);
    });

    describe('gpu_memory_overview step', () => {
      it('should execute or gracefully fail when module unavailable', async () => {
        const result = await evaluator.executeStep('gpu_memory_overview');

        if (hasAndroidGpuMemoryModule) {
          expect(result.success).toBe(true);
        } else {
          console.log('[Test Info] gpu_memory_overview: Module unavailable, skipping assertion');
        }
      }, 30000);

      it('should list processes with GPU memory when data exists', async () => {
        if (!hasAndroidGpuMemoryModule) {
          console.log('[Test Skip] No GPU memory module data available');
          return;
        }

        const result = await evaluator.executeStep('gpu_memory_overview');

        if (result.success && result.data.length > 0) {
          for (const row of result.data) {
            expect(row.process_name).toBeDefined();
            expect(typeof row.process_name).toBe('string');
            expect(row.max_gpu_memory_mb).toBeGreaterThanOrEqual(0);
          }
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('gpu_freq_distribution step', () => {
      it('should execute and return data or fail gracefully', async () => {
        const result = await evaluator.executeStep('gpu_freq_distribution');

        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          console.log(`[Test Info] gpu_freq_distribution failed: ${result.error}`);
          expect(result.error).toBeDefined();
        }
      }, 30000);

      it('should return frequency distribution when GPU data exists', async () => {
        const result = await evaluator.executeStep('gpu_freq_distribution');

        if (result.success && hasGpuFrequencyData && result.data.length > 0) {
          const firstRow = result.data[0];
          expect(firstRow).toHaveProperty('gpu_id');
        }
      }, 30000);
    });

    describe('gpu_high_load_periods step', () => {
      it('should execute and return data or fail gracefully', async () => {
        const result = await evaluator.executeStep('gpu_high_load_periods');

        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          console.log(`[Test Info] gpu_high_load_periods failed: ${result.error}`);
          expect(result.error).toBeDefined();
        }
      }, 30000);

      it('should identify high frequency periods when data exists', async () => {
        const result = await evaluator.executeStep('gpu_high_load_periods');

        if (result.success && hasGpuFrequencyData && result.data.length > 0) {
          for (const row of result.data) {
            expect(row).toHaveProperty('gpu_id');
          }
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // GPU-Frame Correlation Tests
  // ===========================================================================

  describe('GPU-Frame Correlation', () => {
    describe('gpu_frame_correlation step', () => {
      it('should execute or gracefully fail when android.frames module unavailable', async () => {
        const result = await evaluator.executeStep('gpu_frame_correlation');

        if (hasAndroidFramesModule && hasGpuFrequencyData) {
          expect(result.success).toBe(true);
        } else {
          console.log('[Test Info] gpu_frame_correlation: android.frames module unavailable, step may fail');
        }
      }, 30000);

      it('should correlate GPU frequency with frame jank types when data exists', async () => {
        if (!hasAndroidFramesModule) {
          console.log('[Test Skip] android.frames module not available');
          return;
        }

        const result = await evaluator.executeStep('gpu_frame_correlation');

        if (result.success && hasGpuFrequencyData && hasFrameTimelineData && result.data.length > 0) {
          for (const row of result.data) {
            expect(row).toHaveProperty('jank_type');
            expect(row.frame_count).toBeGreaterThan(0);
          }
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // Full Skill Execution Tests
  // ===========================================================================

  describe('Full Skill Execution', () => {
    it('should execute complete skill and return result structure', async () => {
      const result = await evaluator.executeSkill();

      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();

      if (hasGpuFrequencyData && hasAndroidFramesModule && hasAndroidGpuMemoryModule) {
        expect(result.success).toBe(true);
      } else {
        console.log('[Test Info] Some modules unavailable, partial results expected');
      }
    }, 120000);

    it('should have valid result structure', async () => {
      const result = await evaluator.executeSkill();

      expect(result.layers).toBeDefined();
      expect(result.layers.overview).toBeDefined();
      expect(result.layers.list).toBeDefined();
    }, 120000);

    it('should handle traces with minimal GPU data gracefully', async () => {
      const result = await evaluator.executeSkill();

      const normalized = evaluator.normalizeForSnapshot(result);
      expect(normalized.stepCount).toBeGreaterThanOrEqual(0);
      expect(normalized.layers).toBeDefined();
      expect(normalized.layers.overview).toBeDefined();
    }, 120000);

    it('should support package filter parameter', async () => {
      const result = await evaluator.executeSkill({
        package: 'com.android',
      });

      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();
    }, 120000);

    it('should support time range parameters', async () => {
      const result = await evaluator.executeSkill({
        start_ts: 0,
        end_ts: 5000000000,
      });

      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill();
      const normalized = evaluator.normalizeForSnapshot(result);

      expect(normalized.layers).toBeDefined();
      expect(normalized.layers.overview).toBeDefined();
      expect(normalized.layers.list).toBeDefined();
      expect(typeof normalized.stepCount).toBe('number');
    }, 120000);
  });

  // ===========================================================================
  // Direct SQL Execution Tests (for debugging and validation)
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should check gpu_counter_track table existence', async () => {
      const result = await evaluator.executeSQL(`
        SELECT name, COUNT(*) as track_count
        FROM gpu_counter_track
        GROUP BY name
        ORDER BY track_count DESC
        LIMIT 10
      `);

      if (!result.error) {
        expect(result.columns).toContain('name');
        expect(result.columns).toContain('track_count');
      }
    }, 30000);

    it('should query GPU frequency range if available', async () => {
      if (!hasGpuFrequencyData) {
        console.log('[Test Skip] No GPU frequency data available');
        return;
      }

      const result = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.frequency;

        SELECT
          gpu_id,
          MIN(gpu_freq) / 1e6 AS min_freq_mhz,
          MAX(gpu_freq) / 1e6 AS max_freq_mhz,
          COUNT(DISTINCT gpu_freq) AS freq_levels
        FROM android_gpu_frequency
        GROUP BY gpu_id
      `);

      expect(result.error).toBeUndefined();
      if (result.rows.length > 0) {
        const row = result.rows[0];
        expect(row[1]).toBeLessThanOrEqual(row[2]);
      }
    }, 30000);

    it('should handle module import gracefully', async () => {
      const result = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.frequency;
        SELECT 1 as test
      `);

      expect(result.error).toBeUndefined();
    }, 30000);
  });
});

// ===========================================================================
// Edge Cases and Error Handling Tests
// ===========================================================================

describeWithTrace('gpu_analysis edge cases', TRACE_FILE, () => {
  describe('with various parameter combinations', () => {
    let evaluator: SkillEvaluator;
    let hasGpuMemModule = false;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('gpu_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));

      try {
        const gpuMemModuleResult = await evaluator.executeSQL(`
          INCLUDE PERFETTO MODULE android.gpu.memory;
          SELECT COUNT(*) as count FROM android_gpu_memory_per_process LIMIT 1
        `);
        hasGpuMemModule = !gpuMemModuleResult.error && gpuMemModuleResult.rows.length > 0 && gpuMemModuleResult.rows[0][0] > 0;
      } catch (e) {
        hasGpuMemModule = false;
      }
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should handle empty package filter (gpu_memory_overview)', async () => {
      const result = await evaluator.executeStep('gpu_memory_overview', { package: '' });

      if (hasGpuMemModule) {
        expect(result.success).toBe(true);
      } else {
        console.log('[Test Info] gpu_memory_overview: Module unavailable');
      }
    }, 30000);

    it('should handle non-matching process filter gracefully', async () => {
      if (!hasGpuMemModule) {
        console.log('[Test Skip] No GPU memory module data available');
        return;
      }

      const result = await evaluator.executeStep('gpu_memory_overview', {
        package: 'com.nonexistent.app.that.does.not.exist',
      });

      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('should handle invalid time ranges (gpu_freq_distribution)', async () => {
      const result = await evaluator.executeStep('gpu_freq_distribution', {
        start_ts: 100000000000,
        end_ts: 50000000000,
      });

      if (result.success) {
        expect(result.data.length).toBe(0);
      } else {
        console.log(`[Test Info] Invalid time range caused failure: ${result.error}`);
      }
    }, 30000);

    it('should handle very large time range (gpu_freq_distribution)', async () => {
      const result = await evaluator.executeStep('gpu_freq_distribution', {
        start_ts: 0,
        end_ts: 999999000000000,
      });

      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        console.log(`[Test Info] Large time range step failed: ${result.error}`);
      }
    }, 30000);

    it('should handle null/undefined parameters (gpu_freq_distribution)', async () => {
      const result = await evaluator.executeStep('gpu_freq_distribution', {
        start_ts: null,
        end_ts: undefined,
      });

      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        console.log(`[Test Info] Null params step failed: ${result.error}`);
      }
    }, 30000);
  });
});

// ===========================================================================
// Skill Definition Validation Tests
// ===========================================================================

describeWithTrace('gpu_analysis skill definition', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('gpu_analysis');
    await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
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
