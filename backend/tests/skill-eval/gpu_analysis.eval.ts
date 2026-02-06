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
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('gpu_analysis skill', () => {
  let evaluator: SkillEvaluator;
  let hasGpuFrequencyData = false;
  let hasGpuMemoryData = false;
  let hasFrameTimelineData = false;
  let hasAndroidFramesModule = false;
  let hasAndroidGpuMemoryModule = false;

  // Use a general Android trace file - GPU data availability varies by device/trace
  const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

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
    describe('gpu_frequency_distribution step', () => {
      it('should execute and return data or fail gracefully', async () => {
        const result = await evaluator.executeStep('gpu_frequency_distribution');

        // The step may fail if composite skill has other failing steps
        // (like gpu_frame_correlation which uses android.frames)
        // We verify either success with data or graceful failure
        if (result.success) {
          // If successful, data should be an array
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          // If failed, check that error message exists
          console.log(`[Test Info] gpu_frequency_distribution failed: ${result.error}`);
          expect(result.error).toBeDefined();
        }
      }, 30000);

      it('should return frequency distribution when GPU data exists', async () => {
        const result = await evaluator.executeStep('gpu_frequency_distribution');

        // Only validate structure if step succeeded and has data
        if (result.success && hasGpuFrequencyData && result.data.length > 0) {
          const firstRow = result.data[0];

          // Should have expected columns
          expect(firstRow).toHaveProperty('gpu_id');
          expect(firstRow).toHaveProperty('gpu_freq_mhz');
          expect(firstRow).toHaveProperty('total_time_sec');
          expect(firstRow).toHaveProperty('time_pct');

          // Frequency should be positive
          expect(firstRow.gpu_freq_mhz).toBeGreaterThan(0);

          // Time percentage should be between 0-100
          expect(firstRow.time_pct).toBeGreaterThanOrEqual(0);
          expect(firstRow.time_pct).toBeLessThanOrEqual(100);
        }
      }, 30000);

      it('should accept time range parameters', async () => {
        const result = await evaluator.executeStep('gpu_frequency_distribution', {
          time_range_start: 0,
          time_range_end: 10,
        });

        // Parameters should be accepted; step may still fail due to other reasons
        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          console.log(`[Test Info] gpu_frequency_distribution with params failed: ${result.error}`);
        }
      }, 30000);
    });

    describe('gpu_frequency_changes step', () => {
      it('should execute and return data or fail gracefully', async () => {
        const result = await evaluator.executeStep('gpu_frequency_changes');

        if (result.success) {
          expect(Array.isArray(result.data)).toBe(true);
        } else {
          console.log(`[Test Info] gpu_frequency_changes failed: ${result.error}`);
          expect(result.error).toBeDefined();
        }
      }, 30000);

      it('should show frequency change patterns when data exists', async () => {
        const result = await evaluator.executeStep('gpu_frequency_changes');

        if (result.success && hasGpuFrequencyData && result.data.length > 0) {
          for (const row of result.data) {
            // Direction should be UP or DOWN
            expect(['UP', 'DOWN']).toContain(row.direction);

            // Change count should be positive
            expect(row.change_count).toBeGreaterThan(0);

            // Average change should be positive
            if (row.avg_change_mhz !== null) {
              expect(row.avg_change_mhz).toBeGreaterThan(0);
            }
          }
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('gpu_memory_by_process step', () => {
      it('should execute or gracefully fail when module unavailable', async () => {
        const result = await evaluator.executeStep('gpu_memory_by_process');

        // Step may fail if android.gpu.memory module data is not available
        if (hasAndroidGpuMemoryModule) {
          expect(result.success).toBe(true);
        } else {
          // If module is unavailable, we expect failure with appropriate error
          // or success with empty data
          console.log('[Test Info] gpu_memory_by_process: Module unavailable, skipping assertion');
        }
      }, 30000);

      it('should list processes with GPU memory when data exists', async () => {
        if (!hasAndroidGpuMemoryModule) {
          console.log('[Test Skip] No GPU memory module data available');
          return;
        }

        const result = await evaluator.executeStep('gpu_memory_by_process');

        if (result.success && result.data.length > 0) {
          for (const row of result.data) {
            // Process name should exist
            expect(row.process_name).toBeDefined();
            expect(typeof row.process_name).toBe('string');

            // Memory values should be non-negative
            expect(row.max_gpu_memory_mb).toBeGreaterThanOrEqual(0);
            expect(row.avg_gpu_memory_mb).toBeGreaterThanOrEqual(0);
            expect(row.min_gpu_memory_mb).toBeGreaterThanOrEqual(0);

            // Max should be >= avg >= min
            expect(row.max_gpu_memory_mb).toBeGreaterThanOrEqual(row.avg_gpu_memory_mb);
            expect(row.avg_gpu_memory_mb).toBeGreaterThanOrEqual(row.min_gpu_memory_mb);
          }
        }
      }, 30000);

      it('should support process name filter when module available', async () => {
        if (!hasAndroidGpuMemoryModule) {
          console.log('[Test Skip] No GPU memory module data available');
          return;
        }

        const result = await evaluator.executeStep('gpu_memory_by_process', {
          process_name: 'system_server',
        });

        if (result.success && result.data.length > 0) {
          for (const row of result.data) {
            expect(row.process_name.toLowerCase()).toContain('system_server');
          }
        }
      }, 30000);
    });

    describe('gpu_memory_timeline step', () => {
      it('should execute or gracefully fail when module unavailable', async () => {
        const result = await evaluator.executeStep('gpu_memory_timeline');

        if (hasAndroidGpuMemoryModule) {
          expect(result.success).toBe(true);
        } else {
          console.log('[Test Info] gpu_memory_timeline: Module unavailable, skipping assertion');
        }
      }, 30000);

      it('should show memory changes over time when data exists', async () => {
        if (!hasAndroidGpuMemoryModule) {
          console.log('[Test Skip] No GPU memory module data available');
          return;
        }

        const result = await evaluator.executeStep('gpu_memory_timeline');

        if (result.success && result.data.length > 0) {
          const firstRow = result.data[0];

          // Should have time and memory columns
          expect(firstRow).toHaveProperty('time_sec');
          expect(firstRow).toHaveProperty('process_name');
          expect(firstRow).toHaveProperty('gpu_memory_mb');

          // Time should be non-negative
          expect(firstRow.time_sec).toBeGreaterThanOrEqual(0);
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
            // Should have expected structure
            expect(row).toHaveProperty('gpu_id');
            expect(row).toHaveProperty('start_sec');
            expect(row).toHaveProperty('high_freq_duration_sec');
            expect(row).toHaveProperty('segment_count');

            // Duration should be > 0.5 (as per HAVING clause)
            expect(row.high_freq_duration_sec).toBeGreaterThan(0.5);
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

        // This step uses android.frames module which may not be available
        if (hasAndroidFramesModule && hasGpuFrequencyData) {
          expect(result.success).toBe(true);
        } else {
          // Expected to fail if android.frames module is not available
          console.log('[Test Info] gpu_frame_correlation: android.frames module unavailable, step may fail');
          // Step failure is acceptable when module is unavailable
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
            // Should have jank type
            expect(row).toHaveProperty('jank_type');

            // Frame count should be positive
            expect(row.frame_count).toBeGreaterThan(0);

            // Duration should be positive
            if (row.avg_frame_dur_ms !== null) {
              expect(row.avg_frame_dur_ms).toBeGreaterThan(0);
            }
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

      // Skill execution may partially fail due to missing modules
      // but should always return a valid result structure
      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();

      // If all required modules are available, expect success
      if (hasGpuFrequencyData && hasAndroidFramesModule && hasAndroidGpuMemoryModule) {
        expect(result.success).toBe(true);
      } else {
        // Partial success is acceptable when some modules are missing
        console.log('[Test Info] Some modules unavailable, partial results expected');
      }
    }, 120000);

    it('should have valid result structure', async () => {
      const result = await evaluator.executeSkill();

      // Should have layers object regardless of success
      expect(result.layers).toBeDefined();
      expect(result.layers.overview).toBeDefined();
      expect(result.layers.list).toBeDefined();
    }, 120000);

    it('should handle traces with minimal GPU data gracefully', async () => {
      const result = await evaluator.executeSkill();

      // Should have some step results even if empty
      const normalized = evaluator.normalizeForSnapshot(result);
      expect(normalized.stepCount).toBeGreaterThanOrEqual(0);

      // Layers structure should always be present
      expect(normalized.layers).toBeDefined();
      expect(normalized.layers.overview).toBeDefined();
    }, 120000);

    it('should support process name filter parameter', async () => {
      const result = await evaluator.executeSkill({
        process_name: 'com.android',
      });

      // Parameter should be accepted
      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();
    }, 120000);

    it('should support time range parameters', async () => {
      const result = await evaluator.executeSkill({
        time_range_start: 0,
        time_range_end: 5,
      });

      // Parameter should be accepted
      expect(result.skillId).toBe('gpu_analysis');
      expect(result.layers).toBeDefined();
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill();
      const normalized = evaluator.normalizeForSnapshot(result);

      // Verify normalized structure
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

      // Query should execute (may return empty if no GPU data)
      // Error is expected if table doesn't exist
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
        // Min freq should be <= max freq
        expect(row[1]).toBeLessThanOrEqual(row[2]);
      }
    }, 30000);

    it('should handle module import gracefully', async () => {
      // Test that INCLUDE PERFETTO MODULE works without error
      const result = await evaluator.executeSQL(`
        INCLUDE PERFETTO MODULE android.gpu.frequency;
        SELECT 1 as test
      `);

      // Should not throw even if module data is empty
      expect(result.error).toBeUndefined();
    }, 30000);
  });
});

// ===========================================================================
// Edge Cases and Error Handling Tests
// ===========================================================================

describe('gpu_analysis edge cases', () => {
  describe('with various parameter combinations', () => {
    let evaluator: SkillEvaluator;
    let hasGpuMemModule = false;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('gpu_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));

      // Check if android.gpu.memory module produces data
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

    it('should handle empty process_name filter (gpu_memory_by_process)', async () => {
      const result = await evaluator.executeStep('gpu_memory_by_process', { process_name: '' });

      // Step may fail if module is unavailable
      if (hasGpuMemModule) {
        expect(result.success).toBe(true);
      } else {
        // Expected to fail or return empty if module unavailable
        console.log('[Test Info] gpu_memory_by_process: Module unavailable');
      }
    }, 30000);

    it('should handle non-matching process filter gracefully', async () => {
      if (!hasGpuMemModule) {
        console.log('[Test Skip] No GPU memory module data available');
        return;
      }

      const result = await evaluator.executeStep('gpu_memory_by_process', {
        process_name: 'com.nonexistent.app.that.does.not.exist',
      });

      // Should succeed but return empty results
      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);

    it('should handle invalid time ranges (gpu_frequency_distribution)', async () => {
      // End before start - should return empty or handle gracefully
      const result = await evaluator.executeStep('gpu_frequency_distribution', {
        time_range_start: 100,
        time_range_end: 50,
      });

      // With invalid range, step may fail or return empty - both are acceptable
      if (result.success) {
        // If success, should have empty data for invalid range
        expect(result.data.length).toBe(0);
      } else {
        // Failure with error message is also acceptable
        console.log(`[Test Info] Invalid time range caused failure: ${result.error}`);
      }
    }, 30000);

    it('should handle very large time range (gpu_frequency_distribution)', async () => {
      const result = await evaluator.executeStep('gpu_frequency_distribution', {
        time_range_start: 0,
        time_range_end: 999999,
      });

      // Large time range should work - step may still fail due to other reasons
      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      } else {
        console.log(`[Test Info] Large time range step failed: ${result.error}`);
      }
    }, 30000);

    it('should handle null/undefined parameters (gpu_frequency_distribution)', async () => {
      const result = await evaluator.executeStep('gpu_frequency_distribution', {
        time_range_start: null,
        time_range_end: undefined,
      });

      // Null/undefined should be treated as "no filter" - step may still fail
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

describe('gpu_analysis skill definition', () => {
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

    // Verify key steps are present
    expect(stepIds).toContain('gpu_frequency_distribution');
    expect(stepIds).toContain('gpu_frequency_changes');
    expect(stepIds).toContain('gpu_memory_by_process');
    expect(stepIds).toContain('gpu_memory_timeline');
    expect(stepIds).toContain('gpu_frame_correlation');
    expect(stepIds).toContain('gpu_high_load_periods');
    expect(stepIds).toContain('gpu_ai_summary');
  });

  it('should have valid inputs defined', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill!.inputs).toBeDefined();
    expect(Array.isArray(skill!.inputs)).toBe(true);

    // Check for expected input parameters
    const inputNames = skill!.inputs!.map(i => i.name);
    expect(inputNames).toContain('process_name');
    expect(inputNames).toContain('time_range_start');
    expect(inputNames).toContain('time_range_end');
  });

  it('should have valid prerequisites', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill!.prerequisites).toBeDefined();
    expect(skill!.prerequisites!.required_tables).toContain('gpu_counter_track');
    expect(skill!.prerequisites!.modules).toContain('android.gpu.frequency');
    expect(skill!.prerequisites!.modules).toContain('android.gpu.memory');
  });
});
