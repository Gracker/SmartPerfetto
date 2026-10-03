/**
 * Startup Slow Reasons Skill Evaluation Tests (v3.0)
 *
 * 验证 startup_slow_reasons skill 在已知 trace 上的 SQL 正确性：
 * - SR01-SR08 (基础检测) + SR09-SR20 (扩展检测) 的输出结构
 * - 已知 trace 的 snapshot 验证（防止 SQL 回归）
 * - warm/hot start 的冷启动门控是否正确
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('startup_slow_reasons skill', () => {
  let evaluator: SkillEvaluator;

  // lacunh_heavy.pftrace: Snapchat cold start ~3347ms, known characteristics:
  // - High D-state (memory pressure + DEX loading)
  // - 86 lock contention events (2.9ms total, minor)
  // - 52 dlopen events (9.9ms total)
  // - inflate ~104ms
  // - No WebView, no sleep, no thermal throttling
  const TRACE_FILE = 'lacunh_heavy.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('startup_slow_reasons');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
  }, 60000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  // =========================================================================
  // Step 1: startup_overview
  // =========================================================================
  describe('startup_overview step', () => {
    it('should return startup events with TTID/TTFD', async () => {
      const result = await evaluator.executeStep('startup_overview', {});

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);

      const s = result.data[0];
      expect(s.startup_id).toBeDefined();
      expect(s.package).toBeDefined();
      expect(s.startup_type).toBeDefined();
      expect(s.dur_ms).toBeGreaterThan(0);
    }, 30000);

    it('should reclassify the lacunh startup as cold before slow-reason checks consume it', async () => {
      const result = await evaluator.executeStep('startup_overview', {});

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].startup_type).toBe('cold');
      expect(result.data[0].dur_ms).toBeGreaterThan(1000);
      expect(result.data[0].ttid_ms).toBeGreaterThan(1800);
      expect(result.data[0].ts).toBeDefined();
      expect(result.data[0].dur).toBeDefined();
      expect(result.data[0].upid).toBeDefined();
    }, 30000);
  });

  // =========================================================================
  // Step 2: slow_reason_checks — output structure
  // =========================================================================
  describe('slow_reason_checks step', () => {
    it('should execute without SQL error', async () => {
      const result = await evaluator.executeStep('slow_reason_checks', {});
      expect(result.success).toBe(true);
    }, 60000);

    it('should return rows with correct column schema', async () => {
      const result = await evaluator.executeStep('slow_reason_checks', {});
      expect(result.success).toBe(true);

      // May have 0 rows if no issues detected — that's valid
      if (result.data.length > 0) {
        for (const row of result.data) {
          // Every SR row must have these 5 columns
          expect(row.reason_id).toBeDefined();
          expect(row.reason_id).toMatch(/^SR\d{2}$/);
          expect(row.reason).toBeDefined();
          expect(typeof row.reason).toBe('string');
          expect(row.severity).toBeDefined();
          expect(['critical', 'warning', 'info']).toContain(row.severity);
          expect(row.evidence).toBeDefined();
          expect(row.suggestion).toBeDefined();
        }
      }
    }, 60000);

    it('should sort by severity (critical > warning > info)', async () => {
      const result = await evaluator.executeStep('slow_reason_checks', {});
      expect(result.success).toBe(true);

      if (result.data.length > 1) {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        for (let i = 1; i < result.data.length; i++) {
          const prev = severityOrder[result.data[i - 1].severity as keyof typeof severityOrder];
          const curr = severityOrder[result.data[i].severity as keyof typeof severityOrder];
          expect(curr).toBeGreaterThanOrEqual(prev);
        }
      }
    }, 60000);
  });

  // =========================================================================
  // Snapshot: known trace characteristics (regression guard)
  // =========================================================================
  describe('snapshot: lacunh_heavy cold start', () => {
    let srResults: Record<string, any>;

    beforeAll(async () => {
      const result = await evaluator.executeStep('slow_reason_checks', {});
      expect(result.success).toBe(true);
      srResults = {};
      for (const row of result.data) {
        srResults[row.reason_id] = row;
      }
    }, 60000);

    it('should NOT detect WebView init (SR14) — Snapchat cold start has no WebView', () => {
      expect(srResults['SR14']).toBeUndefined();
    });

    it('should NOT detect explicit sleep (SR11) — no Thread.sleep in this trace', () => {
      expect(srResults['SR11']).toBeUndefined();
    });

    it('should NOT detect thermal throttling (SR16) — trace was captured at normal temp', () => {
      expect(srResults['SR16']).toBeUndefined();
    });

    it('should NOT detect high Runnable (SR17) — CPU contention is minimal', () => {
      // Runnable was 0% / 4.6ms — well under the 10% threshold
      expect(srResults['SR17']).toBeUndefined();
    });

    it('should NOT detect fsync blocking (SR20) — no fsync/sqlite D-state', () => {
      expect(srResults['SR20']).toBeUndefined();
    });

    // SR codes that MAY or MAY NOT fire depending on trace details —
    // we just verify they produce reasonable values if present
    it('SR15 (inflate): if present, should report reasonable inflate time', () => {
      if (srResults['SR15']) {
        expect(srResults['SR15'].severity).toBe('info');
        // inflate was ~104ms — above 100ms threshold but below 200ms warning
        expect(srResults['SR15'].evidence).toMatch(/inflate/);
      }
    });

    it('SR13 (dlopen): should NOT fire — total dlopen was only 9.9ms (below 30ms threshold)', () => {
      expect(srResults['SR13']).toBeUndefined();
    });
  });

  // =========================================================================
  // Full skill execution
  // =========================================================================
  describe('full skill execution', () => {
    it('should execute complete skill without errors', async () => {
      const result = await evaluator.executeSkill({});

      expect(result.success).toBe(true);
    }, 120000);
  });

  // =========================================================================
  // Warm/Hot start gate: verify cold-start-only SRs don't fire on scroll trace
  // =========================================================================
  describe('warm/hot start gate', () => {
    let scrollEvaluator: SkillEvaluator;

    beforeAll(async () => {
      scrollEvaluator = createSkillEvaluator('startup_slow_reasons');
      // The scroll trace has no startup, so the startup checks do not run.
      await scrollEvaluator.loadTrace(
        getTestTracePath('scroll_Standard-AOSP-App-Without-PreAnimation.pftrace')
      );
    }, 60000);

    afterAll(async () => {
      await scrollEvaluator.cleanup();
      await new Promise(resolve => setTimeout(resolve, 2500));
    });

    it('should not run the startup checks on a trace without a startup', async () => {
      const result = await scrollEvaluator.executeStep('slow_reason_checks', {});

      expect(result.code).toBe('condition_not_met');
      expect(result.data).toEqual([]);
    }, 60000);
  });
});
