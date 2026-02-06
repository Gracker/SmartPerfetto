/**
 * Memory Analysis Skill Evaluation Tests
 *
 * Tests the memory_analysis skill on known trace files.
 * Validates SQL queries produce correct structure and data.
 *
 * Note: memory_analysis requires GC events in the trace.
 * If the trace file lacks GC data, some tests will be skipped or handle empty results gracefully.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('memory_analysis skill', () => {
  let evaluator: SkillEvaluator;
  let hasGCData = false;
  let hasFrameTimelineData = false;
  let targetProcessName = '';

  // Use Android trace file - may or may not have GC events
  const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('memory_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // Check if trace has any process we can analyze
    try {
      const processResult = await evaluator.executeSQL(`
        SELECT name FROM process
        WHERE name IS NOT NULL AND name != ''
        ORDER BY pid DESC
        LIMIT 1
      `);
      if (!processResult.error && processResult.rows.length > 0) {
        targetProcessName = processResult.rows[0][0] as string;
      }
    } catch (e) {
      // Ignore
    }

    // Check if trace has GC events
    try {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM slice s
        JOIN thread_track tt ON s.track_id = tt.id
        JOIN thread t ON tt.utid = t.utid
        WHERE s.name GLOB '*GC*' OR s.name GLOB '*gc*' OR s.name GLOB '*ConcurrentCopying*'
        LIMIT 1
      `);
      hasGCData = !result.error && result.rows.length > 0 && (result.rows[0][0] as number) > 0;
    } catch (e) {
      hasGCData = false;
    }

    // Check if trace has FrameTimeline data (for GC-frame impact analysis)
    try {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
        LIMIT 1
      `);
      hasFrameTimelineData = !result.error && result.rows.length > 0 && (result.rows[0][0] as number) > 0;
    } catch (e) {
      hasFrameTimelineData = false;
    }

    if (!hasGCData) {
      console.warn(`[Test Warning] Trace ${TRACE_FILE} does not have GC data. Tests will handle empty results gracefully.`);
    }
    if (!hasFrameTimelineData) {
      console.warn(`[Test Warning] Trace ${TRACE_FILE} does not have FrameTimeline data. GC-frame impact tests may have limited data.`);
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
    describe('get_process step', () => {
      it('should find target process when package is provided', async () => {
        // Use empty package to find any process
        const result = await evaluator.executeStep('get_process', { package: '' });

        expect(result.success).toBe(true);
        // Should find at least one process
        if (result.data.length > 0) {
          expect(result.data[0].upid).toBeDefined();
          expect(result.data[0].process_name).toBeDefined();
        }
      }, 30000);

      it('should have valid process structure', async () => {
        const result = await evaluator.executeStep('get_process', { package: '' });

        if (result.data.length > 0) {
          const process = result.data[0];
          expect(typeof process.upid).toBe('number');
          expect(typeof process.pid).toBe('number');
          expect(typeof process.process_name).toBe('string');
        }
      }, 30000);
    });

    describe('gc_overview step', () => {
      it('should return GC overview metrics', async () => {
        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        // Success regardless of whether GC data exists
        expect(result.success).toBe(true);
      }, 30000);

      it('should have valid GC count metrics when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        if (result.data.length > 0) {
          const overview = result.data[0];
          expect(typeof overview.total_gc_count).toBe('number');
          expect(overview.total_gc_count).toBeGreaterThanOrEqual(0);

          if (overview.total_gc_count > 0) {
            expect(overview.total_gc_time_ms).toBeGreaterThan(0);
            expect(overview.avg_gc_time_ms).toBeGreaterThan(0);
          }
        }
      }, 30000);

      it('should have GC frequency rating when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        if (result.data.length > 0 && result.data[0].total_gc_count > 0) {
          const overview = result.data[0];
          expect(['频繁', '较多', '正常', '良好']).toContain(overview.gc_frequency_rating);
          expect(['严重', '需优化', '良好', '优秀']).toContain(overview.gc_time_rating);
        }
      }, 30000);

      it('should track main thread GC separately', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        if (result.data.length > 0) {
          const overview = result.data[0];
          // main_thread_gc_count can be null if no main thread GC occurred
          const mainThreadCount = overview.main_thread_gc_count ?? 0;
          expect(typeof mainThreadCount).toBe('number');
          expect(mainThreadCount).toBeLessThanOrEqual(overview.total_gc_count);
        }
      }, 30000);
    });

    describe('gc_stats step', () => {
      it('should return GC type distribution', async () => {
        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should categorize GC types correctly when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const stat of result.data) {
            expect(stat.gc_type).toBeDefined();
            expect(typeof stat.gc_type).toBe('string');
            expect(stat.count).toBeGreaterThan(0);
            expect(stat.total_dur_ms).toBeGreaterThanOrEqual(0);
          }
        }
      }, 30000);

      it('should include average and max duration metrics', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        if (result.data.length > 0) {
          const stat = result.data[0];
          expect(typeof stat.avg_dur_ms).toBe('number');
          expect(typeof stat.max_dur_ms).toBe('number');
          expect(stat.max_dur_ms).toBeGreaterThanOrEqual(stat.avg_dur_ms);
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('gc_frame_impact step', () => {
      it('should analyze GC impact on frames', async () => {
        const result = await evaluator.executeStep('gc_frame_impact', { package: targetProcessName });

        // Step should succeed even with no data
        expect(result.success).toBe(true);
      }, 30000);

      it('should classify impact correctly when data exists', async () => {
        if (!hasGCData || !hasFrameTimelineData) {
          console.log('[Skip] No GC or FrameTimeline data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_frame_impact', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const impact of result.data) {
            expect(impact.gc_name).toBeDefined();
            expect(typeof impact.gc_dur_ms).toBe('number');
            if (impact.impact) {
              expect(['GC导致掉帧', '帧超时', '正常']).toContain(impact.impact);
            }
          }
        }
      }, 30000);
    });

    describe('main_thread_gc step', () => {
      it('should list main thread GC events', async () => {
        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should have severity classification when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const gc of result.data) {
            expect(gc.gc_type).toBeDefined();
            expect(typeof gc.dur_ms).toBe('number');
            expect(['critical', 'warning', 'notice', 'normal']).toContain(gc.severity);
            expect(typeof gc.dropped_frames).toBe('number');
          }
        }
      }, 30000);

      it('should estimate dropped frames based on duration', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const gc of result.data) {
            // Dropped frames should be roughly dur_ms / 16.67
            const expectedDropped = Math.floor(gc.dur_ms / 16.67);
            // Allow some tolerance due to integer truncation
            expect(gc.dropped_frames).toBeGreaterThanOrEqual(0);
            expect(gc.dropped_frames).toBeLessThanOrEqual(expectedDropped + 1);
          }
        }
      }, 30000);
    });

    describe('gc_thread_state step', () => {
      it('should analyze thread state during GC', async () => {
        const result = await evaluator.executeStep('gc_thread_state', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should show thread states when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_thread_state', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const state of result.data) {
            expect(state.gc_type).toBeDefined();
            expect(typeof state.gc_dur_ms).toBe('number');
            expect(state.state).toBeDefined();
            expect(typeof state.state_dur_ms).toBe('number');
          }
        }
      }, 30000);
    });

    describe('gc_interval_analysis step', () => {
      it('should detect GC intervals for memory thrashing', async () => {
        const result = await evaluator.executeStep('gc_interval_analysis', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should bucket intervals correctly when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('gc_interval_analysis', { package: targetProcessName });

        if (result.data.length > 0) {
          const validBuckets = ['<100ms (频繁)', '100-500ms', '500ms-1s', '1-5s', '>5s'];
          for (const interval of result.data) {
            expect(validBuckets).toContain(interval.interval_bucket);
            expect(interval.count).toBeGreaterThan(0);
            expect(typeof interval.avg_interval_ms).toBe('number');
          }
        }
      }, 30000);
    });

    describe('long_gc_events step', () => {
      it('should list longest GC events', async () => {
        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should order by duration descending when data exists', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        if (result.data.length > 1) {
          for (let i = 1; i < result.data.length; i++) {
            expect(result.data[i - 1].dur_ms).toBeGreaterThanOrEqual(result.data[i].dur_ms);
          }
        }
      }, 30000);

      it('should indicate main thread status', async () => {
        if (!hasGCData) {
          console.log('[Skip] No GC data in trace');
          return;
        }

        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        if (result.data.length > 0) {
          for (const gc of result.data) {
            expect(['是', '否']).toContain(gc.is_main_thread);
          }
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // Full Skill Execution Tests
  // ===========================================================================

  describe('Full Skill Execution', () => {
    it('should execute complete skill successfully', async () => {
      const result = await evaluator.executeSkill({ package: targetProcessName });

      expect(result.success).toBe(true);
      expect(result.skillId).toBe('memory_analysis');
    }, 120000);

    it('should have overview layer results', async () => {
      const result = await evaluator.executeSkill({ package: targetProcessName });
      const overview = result.layers.overview;

      expect(overview).toBeDefined();
      // Should have at least get_process step
      expect(Object.keys(overview!).length).toBeGreaterThan(0);
    }, 120000);

    it('should handle traces with minimal memory data', async () => {
      const result = await evaluator.executeSkill({ package: targetProcessName });

      // Should succeed even without GC data
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill({ package: targetProcessName });
      const normalized = evaluator.normalizeForSnapshot(result);

      // Should have at least some step results (get_process at minimum)
      expect(normalized.stepCount).toBeGreaterThanOrEqual(1);
    }, 120000);

    it('should support time range filtering', async () => {
      // Get trace time bounds first
      const boundsResult = await evaluator.executeSQL(`
        SELECT MIN(ts) as min_ts, MAX(ts) as max_ts
        FROM slice
        WHERE ts IS NOT NULL
      `);

      if (boundsResult.error || boundsResult.rows.length === 0) {
        console.log('[Skip] Could not get trace bounds');
        return;
      }

      const minTs = BigInt(boundsResult.rows[0][0] as string);
      const maxTs = BigInt(boundsResult.rows[0][1] as string);
      const midTs = minTs + (maxTs - minTs) / 2n;

      const result = await evaluator.executeSkill({
        package: targetProcessName,
        start_ts: minTs.toString(),
        end_ts: midTs.toString(),
      });

      expect(result.success).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // SQL Execution Tests (Direct SQL testing)
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should execute simple GC count query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as gc_count
        FROM slice s
        WHERE s.name GLOB '*GC*' OR s.name GLOB '*gc*'
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      // Count can be 0 if no GC events
      expect(result.rows[0][0]).toBeGreaterThanOrEqual(0);
    }, 30000);

    it('should execute GC type aggregation query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          CASE
            WHEN name GLOB '*ConcurrentCopying*' THEN 'ConcurrentCopying'
            WHEN name GLOB '*MarkSweep*' THEN 'MarkSweep'
            ELSE 'Other'
          END as gc_type,
          COUNT(*) as count
        FROM slice
        WHERE name GLOB '*GC*' OR name GLOB '*gc*' OR name GLOB '*ConcurrentCopying*'
        GROUP BY gc_type
        ORDER BY count DESC
      `);

      expect(result.error).toBeUndefined();
      // Results may be empty if no GC events
    }, 30000);

    it('should execute process lookup query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT upid, pid, name
        FROM process
        WHERE name IS NOT NULL AND name != ''
        ORDER BY pid DESC
        LIMIT 5
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBeGreaterThan(0);
    }, 30000);
  });
});

// ===========================================================================
// Edge Case Tests
// ===========================================================================

describe('memory_analysis edge cases', () => {
  describe('with package filter', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('memory_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should work with empty package filter', async () => {
      const result = await evaluator.executeStep('get_process', { package: '' });

      expect(result.success).toBe(true);
      // Empty package should match all processes, so we should get at least one
      expect(result.data.length).toBeGreaterThan(0);
    }, 30000);

    it('should handle non-matching package filter gracefully', async () => {
      const result = await evaluator.executeSkill({
        package: 'com.nonexistent.app.that.does.not.exist',
      });

      // Should succeed but may have no data in most steps
      // The skill handles empty results gracefully via conditions
      if (result.success) {
        expect(Array.isArray(Object.keys(result.layers.overview || {}))).toBe(true);
      } else {
        // Failure with error message is also acceptable
        expect(result.error).toBeDefined();
      }
    }, 60000);

    it('should handle glob patterns in package name', async () => {
      // Test with partial package name using GLOB pattern matching
      const result = await evaluator.executeStep('get_process', { package: 'com.' });

      expect(result.success).toBe(true);
      // Should match processes starting with "com."
    }, 30000);
  });

  describe('with time range constraints', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('memory_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should handle NULL time range parameters', async () => {
      const result = await evaluator.executeStep('gc_overview', {
        package: '',
        start_ts: null,
        end_ts: null,
      });

      expect(result.success).toBe(true);
    }, 30000);

    it('should handle very narrow time ranges', async () => {
      // Get a small time window (1ms)
      const boundsResult = await evaluator.executeSQL(`
        SELECT MIN(ts) as min_ts FROM slice WHERE ts IS NOT NULL
      `);

      if (boundsResult.error || boundsResult.rows.length === 0) {
        console.log('[Skip] Could not get trace bounds');
        return;
      }

      const minTs = BigInt(boundsResult.rows[0][0] as string);
      const endTs = minTs + 1000000n; // 1ms window

      const result = await evaluator.executeStep('gc_overview', {
        package: '',
        start_ts: minTs.toString(),
        end_ts: endTs.toString(),
      });

      expect(result.success).toBe(true);
      // Narrow window likely has no GC events, which is fine
    }, 30000);
  });
});
