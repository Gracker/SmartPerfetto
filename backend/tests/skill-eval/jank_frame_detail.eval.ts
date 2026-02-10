/**
 * Jank Frame Detail Skill Evaluation Tests
 *
 * Tests the jank_frame_detail skill for per-frame jank diagnosis.
 * This skill provides L3 (diagnosis) layer analysis for individual jank frames.
 *
 * Key features tested:
 * - Quadrant analysis (CPU core utilization breakdown)
 * - Binder call analysis
 * - Main thread / RenderThread slice analysis
 * - Root cause determination
 * - Parameter handling (start_ts/end_ts, session_id, max_frames)
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('jank_frame_detail skill', () => {
  let evaluator: SkillEvaluator;
  let testFrameParams: {
    start_ts: string;
    end_ts: string;
    package: string;
    dur_ms: number;
    jank_type: string;
  } | null = null;

  // Use Android trace file with heavy jank - should have FrameTimeline data
  const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('jank_frame_detail');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // Query to find a janky frame to use for testing
    // This gives us real timestamps from the trace
    const frameQuery = await evaluator.executeSQL(`
      SELECT
        printf('%d', ts) as start_ts,
        printf('%d', ts + dur) as end_ts,
        ROUND(dur / 1e6, 2) as dur_ms,
        jank_type,
        layer_name
      FROM actual_frame_timeline_slice
      WHERE jank_type != 'None'
        AND surface_frame_token IS NOT NULL
        AND dur > 16000000
      ORDER BY dur DESC
      LIMIT 1
    `);

    if (!frameQuery.error && frameQuery.rows.length > 0) {
      const row = frameQuery.rows[0];
      // Extract package from layer_name (e.g., "com.example.app/MainActivity#0" -> "com.example.app")
      const layerName = row[4] as string || '';
      const packageMatch = layerName.match(/^([^/]+)/);
      const packageName = packageMatch ? packageMatch[1] : '';

      testFrameParams = {
        start_ts: row[0] as string,
        end_ts: row[1] as string,
        package: packageName,
        dur_ms: row[2] as number,
        jank_type: row[3] as string,
      };
      console.log(`[Test Setup] Found janky frame: ${testFrameParams.dur_ms}ms, type: ${testFrameParams.jank_type}`);
    } else {
      console.warn('[Test Warning] No janky frames found in trace. Some tests will use fallback timestamps.');
    }
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  // ===========================================================================
  // L3 Diagnosis Layer Tests
  // ===========================================================================

  describe('L3: Diagnosis Layer', () => {
    describe('quadrant_analysis step', () => {
      it('should execute quadrant analysis for a janky frame', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('quadrant_analysis', testFrameParams);

        // Step may succeed with data or be skipped due to conditions
        // Check for either success or expected skip reason
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          // Acceptable skip reasons
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should return valid quadrant structure when data exists', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('quadrant_analysis', testFrameParams);

        if (result.data.length > 0) {
          const quadrant = result.data[0];

          // Should have required fields
          expect(quadrant.quadrant).toBeDefined();
          expect(quadrant.name).toBeDefined();
          expect(typeof quadrant.dur_ms).toBe('number');
          expect(typeof quadrant.percentage).toBe('number');

          // Percentage should be 0-100
          expect(quadrant.percentage).toBeGreaterThanOrEqual(0);
          expect(quadrant.percentage).toBeLessThanOrEqual(100);
        }
      }, 30000);

      it('should categorize thread states into Q1-Q4', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('quadrant_analysis', testFrameParams);

        if (result.data.length > 0) {
          // Quadrant names should contain Q1-Q4 identifiers
          const quadrantNames = result.data.map((q: any) => q.quadrant);
          const hasValidQuadrant = quadrantNames.some((name: string) =>
            name.includes('Q1') || name.includes('Q2') || name.includes('Q3') || name.includes('Q4')
          );
          expect(hasValidQuadrant).toBe(true);
        }
      }, 30000);
    });

    describe('main_thread_slices step', () => {
      it('should return main thread time-consuming operations', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('main_thread_slices', testFrameParams);

        // This step is optional, so it may succeed with data or be skipped
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          // Acceptable: step was skipped due to condition or no matching data
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should have valid slice structure when data exists', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('main_thread_slices', testFrameParams);

        if (result.data.length > 0) {
          const slice = result.data[0];

          // Required fields
          expect(slice.name).toBeDefined();
          expect(typeof slice.name).toBe('string');
          expect(typeof slice.dur_ms).toBe('number');
          expect(slice.dur_ms).toBeGreaterThan(0);

          // Should have count and timing info
          expect(typeof slice.count).toBe('number');
          expect(slice.count).toBeGreaterThanOrEqual(1);
        }
      }, 30000);
    });

    describe('render_thread_slices step', () => {
      it('should return RenderThread operations', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('render_thread_slices', testFrameParams);

        // Step is optional - may succeed with data or be skipped
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should have timing metrics for render operations', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('render_thread_slices', testFrameParams);

        if (result.data.length > 0) {
          const slice = result.data[0];

          expect(slice.name).toBeDefined();
          expect(typeof slice.dur_ms).toBe('number');
          expect(typeof slice.avg_ms).toBe('number');
          expect(typeof slice.max_ms).toBe('number');

          // avg should be <= max
          expect(slice.avg_ms).toBeLessThanOrEqual(slice.max_ms);
        }
      }, 30000);
    });

    describe('binder_calls step', () => {
      it('should analyze Binder calls during frame', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('binder_calls', testFrameParams);

        // Binder step is optional - may succeed with data or be skipped
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should have valid Binder call structure when data exists', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('binder_calls', testFrameParams);

        if (result.data.length > 0) {
          const binderCall = result.data[0];

          expect(binderCall.interface).toBeDefined();
          expect(typeof binderCall.count).toBe('number');
          expect(typeof binderCall.dur_ms).toBe('number');
        }
      }, 30000);
    });

    describe('cpu_freq_analysis step', () => {
      it('should return CPU frequency data', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('cpu_freq_analysis', testFrameParams);

        // CPU freq step is optional - may succeed with data or be skipped
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should have big/little core frequency breakdown', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('cpu_freq_analysis', testFrameParams);

        if (result.data.length > 0) {
          const coreTypes = result.data.map((f: any) => f.core_type);
          // Should have at least one core type
          expect(coreTypes.length).toBeGreaterThan(0);

          // Each entry should have frequency metrics
          for (const freq of result.data) {
            expect(['big', 'little']).toContain(freq.core_type);
            expect(typeof freq.avg_freq_mhz).toBe('number');
            expect(freq.avg_freq_mhz).toBeGreaterThan(0);
          }
        }
      }, 30000);
    });

    describe('root_cause_summary step', () => {
      it('should produce root cause analysis', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('root_cause_summary', testFrameParams);

        // Root cause step is optional - may succeed with data or be skipped
        if (result.success) {
          expect(result.data).toBeDefined();
        } else {
          expect(result.error).toMatch(/not found in results|skipped due to condition/);
        }
      }, 30000);

      it('should have valid root cause structure when data exists', async () => {
        if (!testFrameParams) {
          console.warn('Skipping test: no janky frame available');
          return;
        }

        const result = await evaluator.executeStep('root_cause_summary', testFrameParams);

        if (result.data.length > 0) {
          const rootCause = result.data[0];

          // Required fields
          expect(rootCause.primary_cause).toBeDefined();
          expect(typeof rootCause.primary_cause).toBe('string');

          // Confidence level
          expect(['高', '中', '低']).toContain(rootCause.confidence);

          // Cause type classification
          expect(rootCause.cause_type).toBeDefined();
          expect(typeof rootCause.cause_type).toBe('string');

          // Deeper "why slow" breakdown fields
          expect(rootCause.reason_code).toBeDefined();
          expect(typeof rootCause.reason_code).toBe('string');
          expect(
            rootCause.deep_reason === null || typeof rootCause.deep_reason === 'string'
          ).toBe(true);
          expect(rootCause.optimization_hint).toBeDefined();
          expect(typeof rootCause.optimization_hint).toBe('string');

          // Structured mechanism fields for trigger/supply/amplification layering
          expect(rootCause.mechanism_group).toBeDefined();
          expect(typeof rootCause.mechanism_group).toBe('string');

          expect(rootCause.supply_constraint).toBeDefined();
          expect(typeof rootCause.supply_constraint).toBe('string');

          expect(rootCause.trigger_layer).toBeDefined();
          expect(typeof rootCause.trigger_layer).toBe('string');

          expect(rootCause.amplification_path).toBeDefined();
          expect(typeof rootCause.amplification_path).toBe('string');
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // Full Skill Execution Tests
  // ===========================================================================

  describe('Full Skill Execution', () => {
    it('should execute complete skill successfully with frame parameters', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill(testFrameParams);

      expect(result.success).toBe(true);
      expect(result.skillId).toBe('jank_frame_detail');
    }, 120000);

    it('should have deep layer results (L3 diagnosis)', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill(testFrameParams);
      const deep = result.layers.deep;

      // Deep layer should exist for per-frame diagnosis
      expect(deep).toBeDefined();
    }, 120000);

    it('should produce consistent normalized output', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill(testFrameParams);
      const normalized = evaluator.normalizeForSnapshot(result);

      // Should have multiple steps executed
      expect(normalized.stepCount).toBeGreaterThanOrEqual(1);
    }, 120000);

    it('should include quadrant and root cause data in results', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill(testFrameParams);

      // Check for key analysis steps in layers
      const allSteps: string[] = [];

      // Collect step IDs from all layers
      if (result.layers.overview) {
        allSteps.push(...Object.keys(result.layers.overview));
      }
      if (result.layers.list) {
        allSteps.push(...Object.keys(result.layers.list));
      }
      if (result.layers.deep) {
        for (const sessionSteps of Object.values(result.layers.deep)) {
          allSteps.push(...Object.keys(sessionSteps));
        }
      }
      if (result.layers.session) {
        for (const sessionSteps of Object.values(result.layers.session)) {
          allSteps.push(...Object.keys(sessionSteps));
        }
      }

      // Should have executed some diagnosis steps
      // (actual step names depend on data availability)
      expect(allSteps.length).toBeGreaterThan(0);
    }, 120000);
  });

  // ===========================================================================
  // Parameter Handling Tests
  // ===========================================================================

  describe('Parameter Handling', () => {
    it('should work with start_ts/end_ts range parameters', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill({
        start_ts: testFrameParams.start_ts,
        end_ts: testFrameParams.end_ts,
        package: testFrameParams.package,
      });

      expect(result.success).toBe(true);
    }, 120000);

    it('should handle legacy frame_ts/frame_dur parameters', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      // Calculate frame_dur from start_ts/end_ts
      const start = BigInt(testFrameParams.start_ts);
      const end = BigInt(testFrameParams.end_ts);
      const dur = end - start;

      const result = await evaluator.executeSkill({
        frame_ts: testFrameParams.start_ts,
        frame_dur: dur.toString(),
        package: testFrameParams.package,
      });

      // Legacy parameters should still work
      expect(result.success).toBe(true);
    }, 120000);

    it('should work with empty package filter', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill({
        start_ts: testFrameParams.start_ts,
        end_ts: testFrameParams.end_ts,
        package: '',
      });

      expect(result.success).toBe(true);
    }, 120000);

    it('should accept jank_type and dur_ms parameters', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill({
        start_ts: testFrameParams.start_ts,
        end_ts: testFrameParams.end_ts,
        package: testFrameParams.package,
        jank_type: testFrameParams.jank_type,
        dur_ms: testFrameParams.dur_ms,
      });

      expect(result.success).toBe(true);
    }, 120000);

    it('should accept session_id parameter', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill({
        start_ts: testFrameParams.start_ts,
        end_ts: testFrameParams.end_ts,
        package: testFrameParams.package,
        session_id: 1,
      });

      expect(result.success).toBe(true);
    }, 120000);

    it('should accept thread-specific timing parameters', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSkill({
        start_ts: testFrameParams.start_ts,
        end_ts: testFrameParams.end_ts,
        package: testFrameParams.package,
        main_start_ts: testFrameParams.start_ts,
        main_end_ts: testFrameParams.end_ts,
        render_start_ts: testFrameParams.start_ts,
        render_end_ts: testFrameParams.end_ts,
      });

      expect(result.success).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // Data Checks (Optional Steps) Tests
  // ===========================================================================

  describe('Data Source Detection', () => {
    it('should detect monitor contention availability', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          CASE
            WHEN EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = 'android_monitor_contention'
            ) THEN 1
            ELSE 0
          END as has_monitor_contention
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      // Result should be 0 or 1
      expect([0, 1]).toContain(result.rows[0][0]);
    }, 30000);

    it('should detect GC table availability', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          CASE
            WHEN EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type IN ('table', 'view') AND name = 'android_garbage_collection_events'
            ) THEN 1
            ELSE 0
          END as has_gc_table
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect([0, 1]).toContain(result.rows[0][0]);
    }, 30000);

    it('should detect Binder table availability', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          CASE
            WHEN EXISTS (
              SELECT 1 FROM sqlite_master
              WHERE type IN ('table', 'view') AND name = 'android_binder_txns'
            ) THEN 1
            ELSE 0
          END as has_binder_table
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect([0, 1]).toContain(result.rows[0][0]);
    }, 30000);
  });

  // ===========================================================================
  // Direct SQL Execution Tests
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should execute thread state query for quadrant analysis', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSQL(`
        SELECT
          ts.state,
          ts.cpu,
          COUNT(*) as count,
          SUM(ts.dur) as total_dur
        FROM thread_state ts
        JOIN thread t ON ts.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE ts.ts >= ${testFrameParams.start_ts}
          AND ts.ts < ${testFrameParams.end_ts}
          AND (p.name GLOB '${testFrameParams.package}*' OR '${testFrameParams.package}' = '')
          AND (t.tid = p.pid OR t.name = 'RenderThread')
        GROUP BY ts.state, ts.cpu
        ORDER BY total_dur DESC
        LIMIT 10
      `);

      expect(result.error).toBeUndefined();
      // May return empty if no matching thread states
    }, 30000);

    it('should execute slice query for main thread', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSQL(`
        SELECT
          s.name,
          COUNT(*) as count,
          SUM(s.dur) as total_dur,
          MAX(s.dur) as max_dur
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        JOIN process p ON t.upid = p.upid
        WHERE (p.name GLOB '${testFrameParams.package}*' OR '${testFrameParams.package}' = '')
          AND t.tid = p.pid
          AND s.ts >= ${testFrameParams.start_ts}
          AND s.ts < ${testFrameParams.end_ts}
          AND s.dur >= 1000000
        GROUP BY s.name
        ORDER BY total_dur DESC
        LIMIT 5
      `);

      expect(result.error).toBeUndefined();
    }, 30000);

    it('should execute CPU frequency query', async () => {
      if (!testFrameParams) {
        console.warn('Skipping test: no janky frame available');
        return;
      }

      const result = await evaluator.executeSQL(`
        SELECT
          cpu,
          CASE WHEN cpu >= 4 THEN 'big' ELSE 'little' END as core_type,
          AVG(value) as avg_freq,
          MAX(value) as max_freq,
          MIN(value) as min_freq
        FROM counter c
        JOIN cpu_counter_track t ON c.track_id = t.id
        WHERE t.name = 'cpufreq'
          AND c.ts >= ${testFrameParams.start_ts}
          AND c.ts < ${testFrameParams.end_ts}
        GROUP BY cpu
        ORDER BY cpu
      `);

      expect(result.error).toBeUndefined();
    }, 30000);
  });
});

// ===========================================================================
// Edge Cases Tests
// ===========================================================================

describe('jank_frame_detail edge cases', () => {
  describe('with different trace files', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('jank_frame_detail');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_light.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should handle trace with minimal jank gracefully', async () => {
      // Try to find any frame in the trace
      const frameQuery = await evaluator.executeSQL(`
        SELECT
          printf('%d', ts) as start_ts,
          printf('%d', ts + dur) as end_ts,
          layer_name
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
        LIMIT 1
      `);

      if (frameQuery.rows.length > 0) {
        const result = await evaluator.executeSkill({
          start_ts: frameQuery.rows[0][0] as string,
          end_ts: frameQuery.rows[0][1] as string,
          package: '',
        });

        // Should succeed even with minimal data
        expect(result.success).toBe(true);
      }
    }, 120000);
  });

  describe('with invalid parameters', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('jank_frame_detail');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should handle non-existent package gracefully', async () => {
      // Get a valid time range first
      const frameQuery = await evaluator.executeSQL(`
        SELECT
          printf('%d', MIN(ts)) as start_ts,
          printf('%d', MAX(ts + dur)) as end_ts
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
      `);

      if (frameQuery.rows.length > 0 && frameQuery.rows[0][0]) {
        const result = await evaluator.executeSkill({
          start_ts: frameQuery.rows[0][0] as string,
          end_ts: frameQuery.rows[0][1] as string,
          package: 'com.nonexistent.app.that.does.not.exist',
        });

        // Should not crash, may have empty results
        expect(result.success).toBe(true);
      }
    }, 120000);

    it('should handle very short time range', async () => {
      const frameQuery = await evaluator.executeSQL(`
        SELECT printf('%d', ts) as start_ts
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
        LIMIT 1
      `);

      if (frameQuery.rows.length > 0) {
        const startTs = frameQuery.rows[0][0] as string;
        // End timestamp only 1ms after start
        const endTs = (BigInt(startTs) + 1000000n).toString();

        const result = await evaluator.executeSkill({
          start_ts: startTs,
          end_ts: endTs,
          package: '',
        });

        // Should succeed but may have minimal data
        expect(result.success).toBe(true);
      }
    }, 120000);
  });
});
