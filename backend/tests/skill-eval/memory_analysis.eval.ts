/**
 * Memory Analysis Skill Evaluation Tests
 *
 * Tests the memory_analysis skill on known trace files.
 * Validates SQL queries produce correct structure and data.
 *
 * Runs on the constructed memory-gc-pressure case, whose fixture app GC and
 * FrameTimeline the suite asserts before any test.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

const TRACE_FILE = 'memory-gc-pressure';

describeWithTrace('memory_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;
  // The fixture app: its main thread runs a 40ms GC inside one of its janky frames.
  const targetProcessName = 'com.smartperfetto.fixture';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('memory_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // The assertions below read this fixture's GC slices and FrameTimeline.
    const gc = await evaluator.executeSQL(`
      SELECT COUNT(*) FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t USING (utid)
      JOIN process p USING (upid)
      WHERE p.name = '${targetProcessName}' AND t.tid = p.pid AND s.name GLOB '*GC*'
    `);
    expect(gc.error).toBeUndefined();
    expect(Number(gc.rows[0][0])).toBeGreaterThan(0);
    const frames = await evaluator.executeSQL(`
      SELECT COUNT(*) FROM actual_frame_timeline_slice f
      JOIN process p USING (upid)
      WHERE p.name = '${targetProcessName}'
    `);
    expect(frames.error).toBeUndefined();
    expect(Number(frames.rows[0][0])).toBeGreaterThan(0);
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
        // Fixture trace always contains processes; empty means extraction regressed.
        expect(result.data.length).toBeGreaterThan(0);
        expect(result.data[0].upid).toBeDefined();
        expect(result.data[0].process_name).toBeDefined();
      }, 30000);

      it('should have valid process structure', async () => {
        const result = await evaluator.executeStep('get_process', { package: '' });

        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
        const process = result.data[0];
        expect(typeof process.upid).toBe('number');
        expect(typeof process.pid).toBe('number');
        expect(typeof process.process_name).toBe('string');
      }, 30000);
    });

    describe('gc_overview step', () => {
      it('should return GC overview metrics', async () => {
        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        // Success regardless of whether GC data exists
        expect(result.success).toBe(true);
      }, 30000);

      it('should have valid GC count metrics', async () => {
        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        const overview = result.data[0];
        expect(overview.total_gc_count).toBeGreaterThan(0);
        expect(overview.total_gc_time_ms).toBeGreaterThan(0);
        expect(overview.avg_gc_time_ms).toBeGreaterThan(0);
      }, 30000);

      it('should have GC frequency rating', async () => {
        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        const overview = result.data[0];
        expect(['频繁', '较多', '正常', '良好']).toContain(overview.gc_frequency_rating);
        expect(['严重', '需优化', '良好', '优秀']).toContain(overview.gc_time_rating);
      }, 30000);

      it('should track main thread GC separately', async () => {
        const result = await evaluator.executeStep('gc_overview', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        const overview = result.data[0];
        // main_thread_gc_count can be null if no main thread GC occurred
        const mainThreadCount = overview.main_thread_gc_count ?? 0;
        expect(typeof mainThreadCount).toBe('number');
        expect(mainThreadCount).toBeLessThanOrEqual(overview.total_gc_count);
      }, 30000);
    });

    describe('gc_stats step', () => {
      it('should return GC type distribution', async () => {
        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should categorize GC types correctly', async () => {
        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        for (const stat of result.data) {
          expect(stat.gc_type).toBeDefined();
          expect(typeof stat.gc_type).toBe('string');
          expect(stat.count).toBeGreaterThan(0);
          expect(stat.total_dur_ms).toBeGreaterThanOrEqual(0);
        }
      }, 30000);

      it('should include average and max duration metrics', async () => {
        const result = await evaluator.executeStep('gc_stats', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        const stat = result.data[0];
        expect(typeof stat.avg_dur_ms).toBe('number');
        expect(typeof stat.max_dur_ms).toBe('number');
        expect(stat.max_dur_ms).toBeGreaterThanOrEqual(stat.avg_dur_ms);
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

      it('should pair the main-thread GC only with its own process frame', async () => {
        const result = await evaluator.executeStep('gc_frame_impact', { package: targetProcessName });

        // The 40ms main-thread GC runs inside the app's 60ms janky frame. Frames
        // of other processes overlap it too; none of them may be paired with it.
        expect(result.success).toBe(true);
        const gc = result.data.filter(row => row.gc_name === 'Background concurrent copying GC');
        expect(gc).toEqual([expect.objectContaining({
          gc_dur_ms: 40,
          frame_count: 1,
          janky_frame_count: 1,
          jank_type: 'App Deadline Missed',
          frame_dur_ms: 60,
          impact: 'GC导致掉帧',
        })]);
      }, 30000);
    });

    describe('main_thread_gc step', () => {
      it('should list main thread GC events', async () => {
        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should have severity classification', async () => {
        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        for (const gc of result.data) {
          expect(gc.gc_type).toBeDefined();
          expect(typeof gc.dur_ms).toBe('number');
          expect(['critical', 'warning', 'notice', 'normal']).toContain(gc.severity);
          expect(typeof gc.dropped_frames).toBe('number');
        }
      }, 30000);

      it('should estimate dropped frames from the detected VSync period', async () => {
        const vsync = await evaluator.executeStep('get_vsync_period', { package: targetProcessName });
        const periodNs = Number(vsync.data[0]?.vsync_period_ns);
        expect(periodNs).toBeGreaterThan(0);
        const result = await evaluator.executeStep('main_thread_gc', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        for (const gc of result.data) {
          expect(gc.dropped_frames).toBe(Math.floor(Number(gc.dur_str) / periodNs));
        }
      }, 30000);
    });

    describe('gc_thread_state step', () => {
      it('should analyze thread state during GC', async () => {
        const result = await evaluator.executeStep('gc_thread_state', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should show thread states', async () => {
        const result = await evaluator.executeStep('gc_thread_state', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        for (const state of result.data) {
          expect(state.gc_type).toBeDefined();
          expect(typeof state.gc_dur_ms).toBe('number');
          expect(state.state).toBeDefined();
          expect(typeof state.state_dur_ms).toBe('number');
        }
      }, 30000);
    });

    describe('gc_interval_analysis step', () => {
      it('should detect GC intervals for memory thrashing', async () => {
        const result = await evaluator.executeStep('gc_interval_analysis', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should bucket intervals correctly', async () => {
        const result = await evaluator.executeStep('gc_interval_analysis', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        const validBuckets = ['<100ms (频繁)', '100-500ms', '500ms-1s', '1-5s', '>5s'];
        for (const interval of result.data) {
          expect(validBuckets).toContain(interval.interval_bucket);
          expect(interval.count).toBeGreaterThan(0);
          expect(typeof interval.avg_interval_ms).toBe('number');
        }
      }, 30000);
    });

    describe('long_gc_events step', () => {
      it('should list longest GC events', async () => {
        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        expect(result.success).toBe(true);
      }, 30000);

      it('should order by duration descending', async () => {
        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(1);
        for (let i = 1; i < result.data.length; i++) {
          expect(result.data[i - 1].dur_ms).toBeGreaterThanOrEqual(result.data[i].dur_ms);
        }
      }, 30000);

      it('should indicate main thread status', async () => {
        const result = await evaluator.executeStep('long_gc_events', { package: targetProcessName });

        expect(result.data.length).toBeGreaterThan(0);
        for (const gc of result.data) {
          expect(['是', '否']).toContain(gc.is_main_thread);
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

      expect(boundsResult.error).toBeUndefined();
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
      expect(result.rows[0][0]).toBeGreaterThan(0);
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
      expect(result.rows.length).toBeGreaterThan(0);
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

describeWithTrace('memory_analysis edge cases', TRACE_FILE, () => {
  describe('with package filter', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('memory_analysis');
      await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
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

    it('should refuse a package that names no process', async () => {
      const result = await evaluator.executeSkill({
        package: 'com.nonexistent.app.that.does.not.exist',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Process identity could not be verified.*status=not_found/);
    }, 60000);
  });

  describe('with time range constraints', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('memory_analysis');
      await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
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

      expect(boundsResult.error).toBeUndefined();
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
