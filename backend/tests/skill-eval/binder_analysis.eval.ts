/**
 * Binder Analysis Skill Evaluation Tests
 *
 * Tests the binder_analysis skill against known trace files.
 * Validates SQL queries produce correct structure and data.
 *
 * Runs on the heavy launch trace, whose android_binder_txns the suite asserts
 * before any test.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

// Use Android trace file that should have Binder transactions.
const TRACE_FILE = 'android-startup-heavy';
// The launched app: its main thread makes the startup's synchronous Binder calls.
const STARTUP_APP = 'com.example.launch.aosp.heavy';
// The one app whose main thread blocks in Binder for more than 5ms (16.1ms).
const LONG_BINDER_APP = 'com.miui.home';

describeWithTrace('binder_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('binder_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // Every Binder assertion below reads this fixture's transactions.
    const result = await evaluator.executeSQL('SELECT COUNT(*) FROM android_binder_txns');
    expect(result.error).toBeUndefined();
    expect(result.rows[0][0]).toBeGreaterThan(0);
  }, 60000); // 60s timeout for trace loading

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  // ===========================================================================
  // L1 Overview Layer Tests
  // ===========================================================================

  describe('L1: Overview Layer', () => {
    describe('check_binder step', () => {
      it('should check Binder data availability', async () => {
        const result = await evaluator.executeStep('check_binder');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).toHaveProperty('txn_count');
        expect(result.data[0]).toHaveProperty('status');
      }, 30000);

      it('should report the fixture Binder data as available', async () => {
        const result = await evaluator.executeStep('check_binder');
        const check = result.data[0];

        expect(check.status).toBe('available');
        expect(check.txn_count).toBeGreaterThan(0);
      }, 30000);
    });

    describe('binder_overview step', () => {
      it('should return Binder transaction summary', async () => {
        const result = await evaluator.executeStep('binder_overview');

        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
      }, 30000);

      it('should have valid transaction counts', async () => {
        const result = await evaluator.executeStep('binder_overview');
        const overview = result.data[0];

        expect(overview.total_txns).toBeGreaterThan(0);
        expect(typeof overview.sync_txns).toBe('number');
        expect(typeof overview.async_txns).toBe('number');
        expect(overview.sync_txns + overview.async_txns).toBe(overview.total_txns);
      }, 30000);

      it('should have valid duration metrics', async () => {
        const result = await evaluator.executeStep('binder_overview');
        const overview = result.data[0];

        expect(typeof overview.avg_dur_ms).toBe('number');
        expect(typeof overview.max_dur_ms).toBe('number');
        expect(overview.avg_dur_ms).toBeGreaterThanOrEqual(0);
        expect(overview.max_dur_ms).toBeGreaterThanOrEqual(overview.avg_dur_ms);
      }, 30000);

      it('should have valid rating', async () => {
        const result = await evaluator.executeStep('binder_overview');
        const overview = result.data[0];

        expect(['优秀', '良好', '需优化', '严重']).toContain(overview.rating);
      }, 30000);

      it('should show blocking transaction stats', async () => {
        const result = await evaluator.executeStep('binder_overview');
        const overview = result.data[0];

        expect(typeof overview.main_thread_txns).toBe('number');
        expect(typeof overview.slow_calls_count).toBe('number');
        expect(overview.main_thread_txns).toBeGreaterThanOrEqual(0);
        expect(overview.slow_calls_count).toBeGreaterThanOrEqual(0);
      }, 30000);
    });

    describe('get_process step', () => {
      it('should select target process with most activity', async () => {
        const result = await evaluator.executeStep('get_process');

        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
      }, 30000);

      it('should have process name and transaction count', async () => {
        const result = await evaluator.executeStep('get_process');
        const process = result.data[0];

        expect(process.process_name).toBeDefined();
        expect(typeof process.process_name).toBe('string');
        expect(process.txn_count).toBeGreaterThan(0);
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('main_thread_sync_binder step', () => {
      it('should list blocking Binder transactions', async () => {
        const result = await evaluator.executeStep('main_thread_sync_binder', {package: STARTUP_APP});

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
      }, 30000);

      it('should include caller/callee info', async () => {
        const result = await evaluator.executeStep('main_thread_sync_binder', {package: STARTUP_APP});

        expect(result.data.length).toBeGreaterThan(0);
        const txn = result.data[0];

        // Should have caller (client) info
        expect(txn.process_name).toBeDefined();
        expect(typeof txn.process_name).toBe('string');

        // Should have callee (server) info
        expect(txn.server_process).toBeDefined();
        expect(typeof txn.server_process).toBe('string');

        // Should have AIDL method/interface info
        expect(txn.aidl_name !== undefined || txn.aidl_interface !== undefined).toBe(true);
      }, 30000);

      it('should show duration for each transaction', async () => {
        const result = await evaluator.executeStep('main_thread_sync_binder', {package: STARTUP_APP});

        expect(result.data.length).toBeGreaterThan(0);
        for (const txn of result.data) {
          expect(typeof txn.dur_ms).toBe('number');
          expect(txn.dur_ms).toBeGreaterThan(0);
        }
      }, 30000);

      it('should have valid timestamps for timeline navigation', async () => {
        const result = await evaluator.executeStep('main_thread_sync_binder', {package: STARTUP_APP});

        expect(result.data.length).toBeGreaterThan(0);
        const txn = result.data[0];

        // binder_ts should be a timestamp string
        expect(txn.binder_ts).toBeDefined();
        const ts = BigInt(txn.binder_ts);
        expect(ts).toBeGreaterThan(0n);
      }, 30000);

      it('should have severity classification', async () => {
        const result = await evaluator.executeStep('main_thread_sync_binder', {package: STARTUP_APP});

        expect(result.data.length).toBeGreaterThan(0);
        for (const txn of result.data) {
          expect(['critical', 'warning', 'notice', 'normal']).toContain(txn.severity);
        }
      }, 30000);
    });

    describe('outgoing_by_interface step', () => {
      it('should group calls by AIDL interface', async () => {
        const result = await evaluator.executeStep('outgoing_by_interface');

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
      }, 30000);

      it('should have interface aggregation stats', async () => {
        const result = await evaluator.executeStep('outgoing_by_interface');

        expect(result.data.length).toBeGreaterThan(0);
        const row = result.data[0];

        expect(row.call_count).toBeGreaterThan(0);
        expect(typeof row.total_dur_ms).toBe('number');
        expect(typeof row.avg_dur_ms).toBe('number');
        expect(typeof row.max_dur_ms).toBe('number');
      }, 30000);
    });

    describe('binder_blocking_analysis step', () => {
      it('should analyze thread state during Binder blocking', async () => {
        const result = await evaluator.executeStep('binder_blocking_analysis');

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
      }, 30000);

      it('should show state distribution', async () => {
        const result = await evaluator.executeStep('binder_blocking_analysis', {package: LONG_BINDER_APP});

        expect(result.data.length).toBeGreaterThan(0);
        const row = result.data[0];

        expect(row.state).toBeDefined();
        expect(typeof row.state_dur_ms).toBe('number');
        expect(typeof row.state_percent).toBe('number');
        expect(row.state_percent).toBeGreaterThanOrEqual(0);
        expect(row.state_percent).toBeLessThanOrEqual(100);
      }, 30000);
    });

    describe('server_response_analysis step', () => {
      it('should analyze server-side processing time', async () => {
        const result = await evaluator.executeStep('server_response_analysis');

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
      }, 30000);

      it('should compare client wait vs server process time', async () => {
        const result = await evaluator.executeStep('server_response_analysis');

        expect(result.data.length).toBeGreaterThan(0);
        const row = result.data[0];

        expect(typeof row.total_client_wait_ms).toBe('number');
        expect(typeof row.total_server_process_ms).toBe('number');
        expect(typeof row.avg_transport_overhead_ms).toBe('number');
      }, 30000);
    });

    describe('incoming_calls step', () => {
      it('should list incoming Binder calls received by process', async () => {
        const result = await evaluator.executeStep('incoming_calls');

        expect(result.success).toBe(true);
        expect(Array.isArray(result.data)).toBe(true);
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
      expect(result.skillId).toBe('binder_analysis');
    }, 120000);

    it('should have overview layer results', async () => {
      const result = await evaluator.executeSkill();
      const overview = result.layers.overview;

      expect(overview).toBeDefined();
      // Should at least have check_binder step
      expect(Object.keys(overview!).length).toBeGreaterThan(0);
    }, 120000);

    it('should verify layered structure', async () => {
      const result = await evaluator.executeSkill();

      // Verify structure has both overview and list layers
      expect(result.layers.overview).toBeDefined();
      expect(result.layers.list).toBeDefined();

      // Overview should contain binder_overview
      const overviewKeys = Object.keys(result.layers.overview || {});
      expect(overviewKeys.length).toBeGreaterThan(0);

      expect(Object.keys(result.layers.list || {}).length).toBeGreaterThan(0);
    }, 120000);

    it('should analyse one process and refuse a package that names none', async () => {
      expect((await evaluator.executeSkill({package: STARTUP_APP})).success).toBe(true);
      expect((await evaluator.executeSkill({package: 'com.nonexistent.app'})).error)
        .toMatch(/Process identity could not be verified.*status=not_found/);
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill();
      const normalized = evaluator.normalizeForSnapshot(result);

      // Should have at least the check_binder step
      expect(normalized.stepCount).toBeGreaterThanOrEqual(1);

      // Overview layer should have data
      expect(Object.keys(normalized.layers.overview).length).toBeGreaterThan(0);
    }, 120000);

    it('should support time range filtering', async () => {
      // Get the trace time range first
      const traceRange = await evaluator.executeSQL(`
        SELECT MIN(ts) as start_ts, MAX(ts) as end_ts
        FROM slice
        WHERE dur > 0
      `);

      expect(traceRange.rows.length).toBe(1);
      const startTs = traceRange.rows[0][0];
      const endTs = traceRange.rows[0][1];
      const midTs = BigInt(startTs) + (BigInt(endTs) - BigInt(startTs)) / 2n;

      const result = await evaluator.executeSkill({
        start_ts: startTs.toString(),
        end_ts: midTs.toString(),
      });

      expect(result.success).toBe(true);
    }, 120000);
  });

  // ===========================================================================
  // SQL Execution Tests (Direct SQL validation)
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should execute simple Binder count query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as txn_count
        FROM android_binder_txns
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBeGreaterThan(0);
    }, 30000);

    it('should execute main thread sync Binder query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          client_process,
          server_process,
          client_dur / 1e6 as dur_ms
        FROM android_binder_txns
        WHERE is_sync = 1
          AND is_main_thread = 1
        ORDER BY client_dur DESC
        LIMIT 5
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(5);
    }, 30000);

    it('should execute interface grouping query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT
          server_process,
          COUNT(*) as call_count,
          SUM(client_dur) / 1e6 as total_dur_ms
        FROM android_binder_txns
        GROUP BY server_process
        ORDER BY total_dur_ms DESC
        LIMIT 10
      `);

      // Basic grouping query should work even if some columns missing
      expect(result.error).toBeUndefined();
    }, 30000);
  });
});

// ===========================================================================
// Edge Cases Tests
// ===========================================================================

describeWithTrace('binder_analysis edge cases', TRACE_FILE, () => {
  describe('with package filter', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('binder_analysis');
      await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should work with empty package filter', async () => {
      const result = await evaluator.executeStep('check_binder', { package: '' });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    }, 30000);

    it('should refuse a package that names no process', async () => {
      await expect(evaluator.executeStep('check_binder', {package: 'com.nonexistent.app.that.does.not.exist'}))
        .rejects.toThrow(/Process identity could not be verified.*status=not_found/);
    }, 30000);
  });
});
