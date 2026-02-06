/**
 * ANR Analysis Skill Evaluation Tests
 *
 * Tests anr_analysis skill behavior on known trace files.
 * Validates SQL queries produce correct structure and data.
 *
 * Note: Most test traces do not contain ANR data, so tests gracefully
 * handle the case where no ANR events are detected.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('anr_analysis skill', () => {
  let evaluator: SkillEvaluator;
  let hasAnrData = false;

  // Use a trace file that may or may not contain ANR data
  // Most test traces are for scrolling performance, not ANR scenarios
  const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('anr_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // Check if trace has ANR data
    try {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM android_anrs
      `);
      hasAnrData = !result.error && result.rows.length > 0 && result.rows[0][0] > 0;
    } catch (e) {
      hasAnrData = false;
    }

    if (!hasAnrData) {
      console.warn(
        `[Test Info] Trace ${TRACE_FILE} does not have ANR data. Tests will verify graceful handling of empty results.`
      );
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
    describe('anr_detection step', () => {
      it('should execute successfully', async () => {
        const result = await evaluator.executeStep('anr_detection');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
      }, 30000);

      it('should return valid detection metrics', async () => {
        const result = await evaluator.executeStep('anr_detection');
        const detection = result.data[0];

        // total_anr_count should be a number (0 or more)
        expect(typeof detection.total_anr_count).toBe('number');
        expect(detection.total_anr_count).toBeGreaterThanOrEqual(0);

        // affected_process_count should be a number
        expect(typeof detection.affected_process_count).toBe('number');
        expect(detection.affected_process_count).toBeGreaterThanOrEqual(0);

        // If ANRs exist, verify additional fields
        if (detection.total_anr_count > 0) {
          expect(detection.first_anr_ts).toBeDefined();
          expect(detection.last_anr_ts).toBeDefined();
          expect(typeof detection.anr_span_seconds).toBe('number');
        }
      }, 30000);
    });

    describe('anr_overview step (conditional)', () => {
      it('should execute when ANR data exists or be skipped gracefully', async () => {
        const result = await evaluator.executeStep('anr_overview');

        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        } else {
          // Step may be skipped due to condition: detection.data[0]?.total_anr_count > 0
          // Or may return empty results
          expect(Array.isArray(result.data)).toBe(true);
        }
      }, 30000);

      it('should have valid ANR type structure when data exists', async () => {
        const result = await evaluator.executeStep('anr_overview');

        if (result.data.length > 0) {
          const overview = result.data[0];

          // Required fields for ANR overview
          expect(overview.anr_type).toBeDefined();
          expect(typeof overview.anr_type).toBe('string');
          expect(typeof overview.anr_count).toBe('number');
          expect(overview.anr_count).toBeGreaterThan(0);

          // Type display should be a human-readable string
          expect(overview.type_display).toBeDefined();
          expect(typeof overview.type_display).toBe('string');

          // Validate known ANR types
          const validAnrTypes = [
            'INPUT_DISPATCHING_TIMEOUT',
            'BROADCAST_OF_INTENT',
            'EXECUTING_SERVICE',
            'CONTENT_PROVIDER_NOT_RESPONDING',
            'NO_FOCUSED_WINDOW',
          ];
          expect(validAnrTypes).toContain(overview.anr_type);
        }
      }, 30000);
    });

    describe('system_cpu_health step (conditional)', () => {
      it('should handle execution gracefully', async () => {
        // This step is conditional on ANR detection
        const result = await evaluator.executeStep('system_cpu_health');

        // Step may succeed with data, succeed with empty data, or be skipped
        if (result.success && result.data.length > 0) {
          const cpuHealth = result.data[0];

          // Validate CPU health structure
          expect(cpuHealth.core_type).toBeDefined();
          expect(['big', 'little', 'mid']).toContain(cpuHealth.core_type);

          if (cpuHealth.avg_util_pct !== null) {
            expect(cpuHealth.avg_util_pct).toBeGreaterThanOrEqual(0);
            expect(cpuHealth.avg_util_pct).toBeLessThanOrEqual(100);
          }

          expect(['overloaded', 'busy', 'normal']).toContain(cpuHealth.status);
        }
      }, 30000);
    });

    describe('system_freeze_check step (conditional)', () => {
      it('should handle execution gracefully', async () => {
        const result = await evaluator.executeStep('system_freeze_check');

        if (result.success && result.data.length > 0) {
          const freezeCheck = result.data[0];

          // Validate freeze check structure
          expect(typeof freezeCheck.total_apps).toBe('number');
          expect(typeof freezeCheck.frozen_apps).toBe('number');
          expect(['system_freeze', 'app_specific']).toContain(freezeCheck.freeze_verdict);
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('get_anr_events step', () => {
      it('should list ANR events when data exists or return empty array', async () => {
        const result = await evaluator.executeStep('get_anr_events');

        // Should always succeed (may be empty due to condition)
        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        } else {
          expect(Array.isArray(result.data)).toBe(true);
        }
      }, 30000);

      it('should have valid ANR event structure when data exists', async () => {
        const result = await evaluator.executeStep('get_anr_events');

        if (result.data.length > 0) {
          const event = result.data[0];

          // Required fields
          expect(event.error_id).toBeDefined();
          expect(event.process_name).toBeDefined();
          expect(typeof event.process_name).toBe('string');
          expect(event.pid).toBeDefined();
          expect(event.anr_type).toBeDefined();

          // Timestamp fields for navigation
          expect(event.anr_ts).toBeDefined();
          expect(event.perfetto_start).toBeDefined();
          expect(event.perfetto_end).toBeDefined();

          // Duration should be positive
          if (event.anr_dur_ms !== null) {
            expect(event.anr_dur_ms).toBeGreaterThan(0);
          }

          // Type display for UI
          expect(event.type_display).toBeDefined();
        }
      }, 30000);

      it('should include process/thread info', async () => {
        const result = await evaluator.executeStep('get_anr_events');

        if (result.data.length > 0) {
          const event = result.data[0];

          // Process identification
          expect(event.process_name).toBeDefined();
          expect(event.pid).toBeGreaterThan(0);

          // ANR context
          expect(event.timeout_ns).toBeDefined();
        }
      }, 30000);

      it('should have timestamp navigation fields', async () => {
        const result = await evaluator.executeStep('get_anr_events');

        if (result.data.length > 0) {
          const event = result.data[0];

          // Perfetto jump parameters should be valid timestamp strings
          const perfettoStart = BigInt(event.perfetto_start);
          const perfettoEnd = BigInt(event.perfetto_end);

          expect(perfettoStart).toBeGreaterThan(0n);
          expect(perfettoEnd).toBeGreaterThan(perfettoStart);
        }
      }, 30000);
    });

    describe('memory_pressure step (conditional)', () => {
      it('should handle execution gracefully', async () => {
        const result = await evaluator.executeStep('memory_pressure');

        // This step is optional and conditional
        if (result.success && result.data.length > 0) {
          const pressure = result.data[0];

          // Validate memory pressure structure
          expect(pressure.oom_score_adj).toBeDefined();
          expect(typeof pressure.kill_count).toBe('number');
        }
      }, 30000);
    });

    describe('io_load step (conditional)', () => {
      it('should handle execution gracefully', async () => {
        const result = await evaluator.executeStep('io_load');

        if (result.success && result.data.length > 0) {
          const ioLoad = result.data[0];

          // Validate IO load structure
          expect(ioLoad.process_name).toBeDefined();
          expect(typeof ioLoad.io_wait_ms).toBe('number');
          expect(ioLoad.io_wait_ms).toBeGreaterThan(10); // > 10ms filter in SQL
        }
      }, 30000);
    });

    describe('top_cpu_processes step (conditional)', () => {
      it('should handle execution gracefully', async () => {
        const result = await evaluator.executeStep('top_cpu_processes');

        if (result.success && result.data.length > 0) {
          const topProcess = result.data[0];

          // Validate structure
          expect(topProcess.process_name).toBeDefined();
          expect(typeof topProcess.cpu_ms).toBe('number');
          expect(typeof topProcess.cpu_pct).toBe('number');
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // Full Skill Execution Tests
  // ===========================================================================

  describe('Full Skill Execution', () => {
    it('should execute complete skill successfully', async () => {
      const result = await evaluator.executeSkill();

      expect(result.success).toBe(true);
      expect(result.skillId).toBe('anr_analysis');
    }, 120000);

    it('should handle traces without ANRs gracefully', async () => {
      const result = await evaluator.executeSkill();

      expect(result.success).toBe(true);

      // Overview layer should always have detection result
      expect(result.layers.overview).toBeDefined();

      // Detection step should be in overview
      const detection = result.layers.overview?.['anr_detection'];
      expect(detection).toBeDefined();
      expect(detection?.success).toBe(true);

      // If no ANRs, conditional steps may be skipped
      if (detection?.data?.[0]?.total_anr_count === 0) {
        // Verify skill completes without error even with no ANR data
        expect(result.error).toBeUndefined();
      }
    }, 120000);

    it('should verify result structure', async () => {
      const result = await evaluator.executeSkill();

      // Result should have the expected layer structure
      expect(result.layers).toBeDefined();
      expect(result.layers.overview).toBeDefined();

      // When ANR data exists, verify list layer has events
      if (hasAnrData) {
        expect(result.layers.list).toBeDefined();
        expect(Object.keys(result.layers.list!).length).toBeGreaterThan(0);
      }
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill();
      const normalized = evaluator.normalizeForSnapshot(result);

      // Should have at least the detection step
      expect(normalized.stepCount).toBeGreaterThanOrEqual(1);

      // Overview layer should have detection
      expect(normalized.layers.overview['anr_detection']).toBeDefined();
      expect(normalized.layers.overview['anr_detection'].hasData).toBe(true);
    }, 120000);

    it('should support process_name filter parameter', async () => {
      const result = await evaluator.executeSkill({
        process_name: 'com.example.nonexistent',
      });

      // Should succeed even with non-matching filter
      expect(result.success).toBe(true);

      // Detection should return 0 ANRs for non-existent process
      const detection = result.layers.overview?.['anr_detection'];
      expect(detection?.success).toBe(true);
    }, 120000);

    it('should support anr_type filter parameter', async () => {
      const result = await evaluator.executeSkill({
        anr_type: 'INPUT_DISPATCHING_TIMEOUT',
      });

      expect(result.success).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // SQL Execution Tests (Direct SQL testing)
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should execute ANR count query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as anr_count
        FROM android_anrs
      `);

      // Query should succeed (may return 0)
      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBeGreaterThanOrEqual(0);
    }, 30000);

    it('should execute ANR type grouping query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT anr_type, COUNT(*) as count
        FROM android_anrs
        GROUP BY anr_type
        ORDER BY count DESC
      `);

      expect(result.error).toBeUndefined();
      // Results may be empty if no ANRs
    }, 30000);

    it('should check android_anrs table schema', async () => {
      const result = await evaluator.executeSQL(`
        SELECT name FROM pragma_table_info('android_anrs')
      `);

      // If table exists, verify expected columns
      if (!result.error && result.rows.length > 0) {
        const columns = result.rows.map(row => row[0]);

        // Expected columns from skill SQL usage
        expect(columns).toContain('ts');
        expect(columns).toContain('process_name');
        expect(columns).toContain('anr_type');
      }
    }, 30000);
  });
});

// ===========================================================================
// Edge Cases Tests
// ===========================================================================

describe('anr_analysis edge cases', () => {
  describe('with different filter combinations', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('anr_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should work with empty process_name filter', async () => {
      const result = await evaluator.executeStep('anr_detection', { process_name: '' });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    }, 30000);

    it('should work with empty anr_type filter', async () => {
      const result = await evaluator.executeStep('anr_detection', { anr_type: '' });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    }, 30000);

    it('should handle wildcard process name matching', async () => {
      const result = await evaluator.executeStep('anr_detection', {
        process_name: 'com.android',
      });

      // GLOB pattern should work (com.android*)
      expect(result.success).toBe(true);
    }, 30000);

    it('should handle specific ANR type filter', async () => {
      const result = await evaluator.executeStep('anr_detection', {
        anr_type: 'BROADCAST_OF_INTENT',
      });

      expect(result.success).toBe(true);
      // Result may be 0 if no broadcast ANRs in trace
    }, 30000);

    it('should handle combined filters', async () => {
      const result = await evaluator.executeSkill({
        process_name: 'com.android.systemui',
        anr_type: 'INPUT_DISPATCHING_TIMEOUT',
      });

      expect(result.success).toBe(true);
      // Verify skill completes without error
      expect(result.error).toBeUndefined();
    }, 120000);
  });

  describe('diagnostic rules verification', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('anr_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should execute anr_diagnosis step', async () => {
      const result = await evaluator.executeStep('anr_diagnosis');

      // Diagnostic step may be skipped if no ANR data
      // or may produce diagnosis based on available data
      if (result.success) {
        expect(Array.isArray(result.data)).toBe(true);
      }
    }, 30000);
  });
});

// ===========================================================================
// Skill Definition Validation Tests
// ===========================================================================

describe('anr_analysis skill definition', () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('anr_analysis');
    await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
  });

  it('should have valid skill definition', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill).toBeDefined();
    expect(skill?.name).toBe('anr_analysis');
    expect(skill?.type).toBe('composite');
    expect(skill?.category).toBe('app_lifecycle');
  });

  it('should have all expected step IDs', () => {
    const stepIds = evaluator.getStepIds();

    // Verify key steps are present
    expect(stepIds).toContain('anr_detection');
    expect(stepIds).toContain('anr_overview');
    expect(stepIds).toContain('get_anr_events');
    expect(stepIds).toContain('system_cpu_health');
    expect(stepIds).toContain('memory_pressure');
    expect(stepIds).toContain('io_load');
    expect(stepIds).toContain('system_freeze_check');
    expect(stepIds).toContain('top_cpu_processes');
    expect(stepIds).toContain('analyze_anr_events'); // Iterator step
    expect(stepIds).toContain('anr_diagnosis');
    expect(stepIds).toContain('global_summary');
  });

  it('should have proper display layer assignments', () => {
    const skill = evaluator.getSkillDefinition();

    if (skill?.steps) {
      for (const step of skill.steps) {
        if (step.display && typeof step.display === 'object') {
          // Validate display level (when defined)
          if (step.display.level) {
            expect(['none', 'debug', 'detail', 'summary', 'key']).toContain(step.display.level);
          }

          // Validate display layer (when defined)
          if (step.display.layer) {
            expect(['overview', 'list', 'session', 'deep']).toContain(step.display.layer);
          }
        }
      }
    }
  });

  it('should have proper input definitions', () => {
    const skill = evaluator.getSkillDefinition();

    expect(skill?.inputs).toBeDefined();
    expect(Array.isArray(skill?.inputs)).toBe(true);

    // Verify expected inputs
    const inputNames = skill?.inputs?.map(i => i.name) || [];
    expect(inputNames).toContain('process_name');
    expect(inputNames).toContain('anr_type');
  });
});
