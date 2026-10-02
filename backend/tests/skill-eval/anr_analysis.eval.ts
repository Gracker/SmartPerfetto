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
import fs from 'fs';
import path from 'path';
import * as yaml from 'yaml';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';

// Use a trace file that may or may not contain ANR data.
// Fixture removed in commit 52feac55; describeWithTrace skips when missing.
const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';
const REAL_ANR_TRACE_FILE = 'perfetto/test/data/android_anr.pftrace.gz';

function describeWithRepoTrace(suiteName: string, tracePath: string, fn: () => void): void {
  const absolute = path.resolve(process.cwd(), '..', tracePath);
  if (fs.existsSync(absolute)) {
    describe(suiteName, fn);
  } else {
    describe.skip(`${suiteName} [skipped: missing trace fixture ${tracePath}]`, fn);
  }
}

describe('anr_detail evidence boundary contract', () => {
  it('should not use package-scoped legacy artifacts as final diagnosis inputs', () => {
    const skillPath = path.resolve(process.cwd(), 'skills/composite/anr_detail.skill.yaml');
    const parsed = yaml.parse(fs.readFileSync(skillPath, 'utf-8')) as {
      steps: Array<{
        id: string;
        inputs?: string[];
        rules?: Array<{
          condition?: string;
          diagnosis?: string;
          severity?: string;
          suggestions?: string[];
        }>;
        sql?: string;
        save_as?: string;
        condition?: string;
        params?: Record<string, string | number | boolean>;
      }>;
    };

    const diagnosis = parsed.steps.find(step => step.id === 'anr_event_diagnosis');
    expect(diagnosis).toBeDefined();
    expect(diagnosis?.inputs || []).not.toEqual(
      expect.arrayContaining(['blocking', 'binder_calls', 'main_sync_binder', 'sched_delay']),
    );
    expect(diagnosis?.inputs || []).toEqual(
      expect.arrayContaining([
        'direct_blocker_gap',
        'direct_blocker_candidates',
        'direct_blocker_slice_gap',
        'direct_blocker_slice_candidates',
        'app_freeze_check',
        'logcat_context_gap',
        'logcat_event_context',
      ]),
    );
    expect(diagnosis?.inputs || []).not.toContain('freeze_check');

    const rules = JSON.stringify(diagnosis?.rules || []);
    expect(rules).not.toContain('blocking.data');
    expect(rules).not.toContain('binder_calls.data');
    expect(rules).not.toContain('main_sync_binder');
    expect(rules).not.toContain('sched_delay.data');
    expect(rules).toContain('direct_blocker_candidates');
    expect(rules).toContain('direct_blocker_slice_candidates');
    expect(rules).not.toContain('direct_blocker.data');
    expect(rules).not.toContain('logcat_context.data');

    expect(parsed.steps.find(step => step.id === 'direct_blocker_evidence_gap')?.save_as).toBe(
      'direct_blocker_gap',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_classification')?.save_as).toBe(
      'direct_blocker_candidates',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_slice_evidence_gap')?.save_as).toBe(
      'direct_blocker_slice_gap',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_slice_classification')?.save_as).toBe(
      'direct_blocker_slice_candidates',
    );
    expect(parsed.steps.find(step => step.id === 'anr_logcat_evidence_gap')?.save_as).toBe(
      'logcat_context_gap',
    );
    expect(parsed.steps.find(step => step.id === 'anr_logcat_context')?.save_as).toBe(
      'logcat_event_context',
    );
    expect(parsed.steps.find(step => step.id === 'app_freeze_check')?.save_as).toBe('app_freeze_check');
    expect(parsed.steps.find(step => step.id === 'direct_blocker_evidence_gap')?.condition).not.toContain(
      'has_slice',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_classification')?.condition).not.toContain(
      'has_slice',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_slice_evidence_gap')?.condition).toContain(
      'has_slice',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_slice_classification')?.condition).toContain(
      'has_slice',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_classification')?.sql).not.toContain(
      'FROM slice',
    );
    expect(parsed.steps.find(step => step.id === 'direct_blocker_slice_classification')?.sql).toContain(
      'FROM slice',
    );

    const directBlocker = parsed.steps.find(step => step.id === 'direct_blocker_classification');
    expect(directBlocker?.sql).toContain('uninterruptible_wait_ns');
    expect(directBlocker?.sql).toContain("'uninterruptible_wait'");
    expect(directBlocker?.sql).not.toContain("WHERE state = 'D'\n              OR blocked_function");

    const sliceBlocker = parsed.steps.find(step => step.id === 'direct_blocker_slice_classification');
    expect(sliceBlocker?.sql).not.toContain("GLOB '*read*'");
    expect(sliceBlocker?.sql).not.toContain("GLOB '*write*'");
    expect(sliceBlocker?.sql).not.toContain("GLOB '*open*'");
    expect(sliceBlocker?.sql).not.toContain("GLOB '*file*'");
    expect(sliceBlocker?.sql).toContain("GLOB '*fileio*'");

    const logcatContext = parsed.steps.find(step => step.id === 'anr_logcat_context');
    expect(logcatContext?.sql).toContain('l.error_match = 1 OR l.component_match = 1 OR l.intent_match = 1');
    expect(logcatContext?.sql).toContain("THEN 'event_scoped'");
    expect(logcatContext?.sql).toContain("THEN 'target_process_context'");

    const lockContention = parsed.steps.find(step => step.id === 'lock_contention');
    expect(lockContention?.sql).toContain("process_name = '${process_name}'");
    expect(lockContention?.sql).not.toContain("process_name GLOB '${process_name}:*'");
    expect(lockContention?.sql).toContain('is_blocked_thread_main = 1');
    expect(lockContention?.sql).toContain('clipped_ns');
    expect(lockContention?.sql).toContain('ts < aw.end_ts');
    expect(lockContention?.sql).toContain('> aw.start_ts');

    expect(parsed.steps.find(step => step.id === 'blocking_reasons')?.params).toMatchObject({
      upid: '${upid}',
      pid: '${pid}',
    });
    expect(parsed.steps.find(step => step.id === 'main_thread_slices')?.params).toMatchObject({
      upid: '${upid}',
      pid: '${pid}',
    });

    const criticalLockRule = diagnosis?.rules?.find(rule =>
      rule.condition?.includes("r.severity === 'critical'"),
    );
    expect(criticalLockRule).toBeDefined();
    expect(criticalLockRule?.condition).toContain("r.blocked_type === 'MainThread'");
    expect(criticalLockRule?.diagnosis).not.toContain('lock_contention.data[0]');
    expect(criticalLockRule?.diagnosis).toContain(
      "lock_contention.data.find(r => r.blocked_type === 'MainThread' && r.severity === 'critical')",
    );
    expect(criticalLockRule?.suggestions?.join('\n')).not.toContain('lock_contention.data[0]');

    const nativePollRule = diagnosis?.rules?.find(rule =>
      rule.condition?.includes("native_poll_idle_or_ambiguous"),
    );
    expect(nativePollRule?.condition).toContain('direct_blocker_slice_candidates');

    const completeFreezeRule = diagnosis?.rules?.find(rule => rule.diagnosis?.includes('应用完全冻结'));
    expect(completeFreezeRule?.condition).toContain("thread_type === 'MainThread'");
    expect(completeFreezeRule?.condition).toContain("thread_type === 'RenderThread'");
    expect(completeFreezeRule?.condition).toContain("thread_type === 'Binder'");

    const partialFreezeRule = diagnosis?.rules?.find(rule => rule.diagnosis?.includes('不能直接等同应用完全冻结'));
    expect(partialFreezeRule?.severity).toBe('warning');
    expect(partialFreezeRule?.condition).toContain("thread_type === 'MainThread'");
  });

  it('should keep package-scoped futex probes as candidate context', () => {
    const skillPath = path.resolve(process.cwd(), 'skills/composite/anr_analysis.skill.yaml');
    const parsed = yaml.parse(fs.readFileSync(skillPath, 'utf-8')) as {
      steps: Array<{
        id: string;
        rules?: Array<{
          condition?: string;
          diagnosis?: string;
          severity?: string;
          confidence?: string;
          suggestions?: string[];
        }>;
      }>;
    };

    const diagnosis = parsed.steps.find(step => step.id === 'anr_diagnosis');
    const futexRule = diagnosis?.rules?.find(rule => rule.condition?.includes("wait_type === 'futex'"));

    expect(futexRule).toBeDefined();
    expect(futexRule?.severity).toBe('warning');
    expect(futexRule?.confidence).toBe('medium');
    expect(futexRule?.diagnosis).toContain('候选信号');
    expect(futexRule?.suggestions?.join('\n')).toContain('不能作为最终根因');
    expect(futexRule?.suggestions?.join('\n')).toContain('direct_blocker_classification');
    expect(futexRule?.suggestions?.join('\n')).toContain('MainThread lock_contention');

    const criticalFreezeRules = diagnosis?.rules?.filter(
      rule =>
        rule.severity === 'critical' &&
        rule.condition?.includes('freeze_check.data[0]?.freeze_verdict'),
    );
    expect(criticalFreezeRules?.length).toBeGreaterThanOrEqual(2);
    for (const rule of criticalFreezeRules || []) {
      expect(rule.condition).toContain('(detection.data[0]?.total_anr_count || 0) === 1');
    }

    const baselineFreezeRules = diagnosis?.rules?.filter(rule => rule.diagnosis?.includes('首个 ANR 窗口 baseline'));
    expect(baselineFreezeRules).toHaveLength(2);
    for (const rule of baselineFreezeRules || []) {
      expect(rule.condition).toContain('(detection.data[0]?.total_anr_count || 0) > 1');
      expect(rule.confidence).toBe('medium');
    }

    const strategy = fs.readFileSync(path.resolve(process.cwd(), 'strategies/anr.strategy.md'), 'utf-8');
    expect(strategy).toContain('detection.total_anr_count === 1');
    expect(strategy).toContain('detection.total_anr_count > 1');
    expect(strategy).toContain('只代表首个 ANR 窗口 baseline context');
    expect(strategy).not.toContain('跳过 Phase 3，直接到 Phase 4 输出');
  });

  it('should avoid prefix package bleed in futex wait distribution', () => {
    const skillPath = path.resolve(process.cwd(), 'skills/atomic/futex_wait_distribution.skill.yaml');
    const parsed = yaml.parse(fs.readFileSync(skillPath, 'utf-8')) as { sql?: string };

    expect(parsed.sql).not.toContain("GLOB '${package}*'");
    expect(parsed.sql).toContain("p.name = '${package}' OR p.name GLOB '${package}:*'");
    expect(parsed.sql).toContain('CROSS JOIN bounds');
    expect(parsed.sql).toContain('s.ts < b.end_ts');
    expect(parsed.sql).toContain('> b.start_ts');
    expect(parsed.sql).toContain('CASE WHEN s.dur < 0 THEN b.end_ts ELSE s.ts + s.dur END');
  });

  it('should prefer upid-safe main-thread helper filters from anr_detail', () => {
    const statesPath = path.resolve(process.cwd(), 'skills/atomic/main_thread_states_in_range.skill.yaml');
    const slicesPath = path.resolve(process.cwd(), 'skills/atomic/main_thread_slices_in_range.skill.yaml');
    const states = yaml.parse(fs.readFileSync(statesPath, 'utf-8')) as { inputs?: Array<{ name: string }>; sql?: string };
    const slices = yaml.parse(fs.readFileSync(slicesPath, 'utf-8')) as { inputs?: Array<{ name: string }>; sql?: string };

    for (const helper of [states, slices]) {
      expect(helper.inputs?.map(input => input.name)).toEqual(expect.arrayContaining(['upid', 'pid']));
      expect(helper.sql).toContain('p.upid = ${upid|0}');
      expect(helper.sql).toContain('p.pid = ${pid|0}');
      expect(helper.sql).toContain("p.name = '${package|}' OR p.name GLOB '${package|}:*'");
      expect(helper.sql).not.toContain("p.name GLOB '${package}*'");
      expect(helper.sql).not.toContain("p.name GLOB '${package|}*'");
    }
  });

  it('should pass anr_type filtering into the shared ANR context window', () => {
    const analysisPath = path.resolve(process.cwd(), 'skills/composite/anr_analysis.skill.yaml');
    const analysis = yaml.parse(fs.readFileSync(analysisPath, 'utf-8')) as {
      steps: Array<{ id: string; params?: Record<string, string> }>;
    };
    const contextPath = path.resolve(process.cwd(), 'skills/atomic/anr_context_in_range.skill.yaml');
    const context = yaml.parse(fs.readFileSync(contextPath, 'utf-8')) as {
      inputs?: Array<{ name: string }>;
      sql?: string;
    };

    expect(analysis.steps.find(step => step.id === 'get_anr_context')?.params).toMatchObject({
      anr_type: '${anr_type}',
    });
    expect(context.inputs?.map(input => input.name)).toContain('anr_type');
    expect(context.sql).toContain("AND (anr_type = '${anr_type}' OR '${anr_type}' = '')");
  });
});

describeWithTrace('anr_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;
  let hasAnrData = false;

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
        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        }

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
            'INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW',
            'BROADCAST_OF_INTENT',
            'START_FOREGROUND_SERVICE',
            'EXECUTING_SERVICE',
            'FOREGROUND_SERVICE_TIMEOUT',
            'FOREGROUND_SHORT_SERVICE_TIMEOUT',
            'CONTENT_PROVIDER_NOT_RESPONDING',
            'JOB_SERVICE_START',
            'JOB_SERVICE_STOP',
            'JOB_SERVICE_BIND',
            'JOB_SERVICE_NOTIFICATION_NOT_PROVIDED',
            'BIND_APPLICATION',
            'SYSTEM_SERVER_WATCHDOG_TIMEOUT',
            'GPU_HANG',
            'APP_TRIGGERED',
            'UNKNOWN_ANR_TYPE',
          ];
          expect(validAnrTypes).toContain(overview.anr_type);

          expect(overview.trigger_type).toBeDefined();
          expect(typeof overview.trigger_type).toBe('string');
          expect(overview.not_final).toBe(1);
        }
      }, 30000);
    });

    describe('trigger_classification step (conditional)', () => {
      it('should classify trigger type when ANR data exists or be skipped gracefully', async () => {
        const result = await evaluator.executeStep('trigger_classification');

        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        } else {
          expect(Array.isArray(result.data)).toBe(true);
        }
      }, 30000);

      it('should keep trigger and root-cause hints separate', async () => {
        const result = await evaluator.executeStep('trigger_classification');

        if (result.data.length > 0) {
          const row = result.data[0];

          expect(row.source_anr_type).toBeDefined();
          expect(row.trigger_type).toBeDefined();
          expect(row.root_cause_pattern_hints).toBeDefined();
          expect(row.not_final).toBe(1);
          expect(typeof row.analysis_focus).toBe('string');
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

          expect(['insufficient_coverage', 'overloaded', 'busy', 'normal']).toContain(cpuHealth.status);
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
          expect(['system_server_freeze', 'system_freeze', 'app_specific', 'undetermined']).toContain(freezeCheck.freeze_verdict);
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
        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        }

        if (result.data.length > 0) {
          const event = result.data[0];

          // Required fields
          expect(event.error_id).toBeDefined();
          expect(event.process_name).toBeDefined();
          expect(typeof event.process_name).toBe('string');
          expect(event.pid).toBeDefined();
          expect(event.anr_type).toBeDefined();
          expect(event.trigger_type).toBeDefined();
          expect(typeof event.trigger_type).toBe('string');

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
          expect(['actual_anr_duration', 'perfetto_default', 'heuristic_fallback']).toContain(event.timeout_source);
          expect(event.root_cause_pattern_hints).toBeDefined();
        }
      }, 30000);

      it('should include process/thread info', async () => {
        const result = await evaluator.executeStep('get_anr_events');
        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        }

        if (result.data.length > 0) {
          const event = result.data[0];

          // Process identification
          expect(event.process_name).toBeDefined();
          expect(event.pid).toBeGreaterThan(0);

          // ANR context
          expect(event.timeout_ns).toBeDefined();
          expect(BigInt(event.timeout_ns)).toBeGreaterThan(0n);
        }
      }, 30000);

      it('should have timestamp navigation fields', async () => {
        const result = await evaluator.executeStep('get_anr_events');
        if (hasAnrData) {
          expect(result.success).toBe(true);
          expect(result.data.length).toBeGreaterThan(0);
        }

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

          // Validate D-state baseline structure; this is not sufficient to prove IO root cause.
          expect(ioLoad.process_name).toBeDefined();
          expect(typeof ioLoad.uninterruptible_wait_ms).toBe('number');
          expect(ioLoad.uninterruptible_wait_ms).toBeGreaterThan(10); // > 10ms filter in SQL
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
// Real ANR Trace Smoke Tests
// ===========================================================================

describeWithRepoTrace('anr_analysis real ANR trace smoke', REAL_ANR_TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('anr_analysis');
    await evaluator.loadTrace(REAL_ANR_TRACE_FILE);
  }, 120000);

  afterAll(async () => {
    await evaluator.cleanup();
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  it('should detect ANRs in the Perfetto android_anr fixture', async () => {
    const result = await evaluator.executeSQL(`
      SELECT COUNT(*) AS total_anr_count
      FROM android_anrs
    `);

    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBeGreaterThan(0);
  }, 60000);

  it('should execute trigger_classification against real ANR types', async () => {
    const rawTypes = await evaluator.executeSQL(`
      SELECT anr_type, COUNT(*) AS event_count
      FROM android_anrs
      GROUP BY anr_type
      ORDER BY anr_type
    `);
    const result = await evaluator.executeStep('trigger_classification', { enable_detail_analysis: false });

    expect(rawTypes.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.data.length).toBe(rawTypes.rows.length);

    const rawCountByType = new Map(rawTypes.rows.map(row => [row[0], row[1]]));
    for (const row of result.data) {
      expect(rawCountByType.get(row.source_anr_type)).toBe(row.event_count);
      expect(row.trigger_type).toBeDefined();
      expect(row.not_final).toBe(1);
      expect(row.root_cause_pattern_hints).toBeDefined();
      if (row.source_anr_type !== 'UNKNOWN_ANR_TYPE') {
        expect(row.trigger_type).not.toBe('unknown');
      }
    }
  }, 180000);

  it('should filter shared ANR context by real anr_type', async () => {
    const rawTypes = await evaluator.executeSQL(`
      SELECT anr_type
      FROM android_anrs
      WHERE anr_type IS NOT NULL
      GROUP BY anr_type
      ORDER BY COUNT(*) DESC, anr_type
      LIMIT 1
    `);
    expect(rawTypes.error).toBeUndefined();
    expect(rawTypes.rows.length).toBeGreaterThan(0);

    const selectedType = rawTypes.rows[0][0];
    const result = await evaluator.executeStep('get_anr_context', {
      anr_type: selectedType,
      enable_detail_analysis: false,
    });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0].anr_type).toBe(selectedType);
  }, 180000);

  it('should execute get_anr_events with valid real per-event windows', async () => {
    const result = await evaluator.executeStep('get_anr_events', { enable_detail_analysis: false });

    expect(result.success).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);

    for (const event of result.data) {
      const perfettoStart = BigInt(event.perfetto_start);
      const perfettoEnd = BigInt(event.perfetto_end);
      const timeoutNs = BigInt(event.timeout_ns);

      expect(timeoutNs).toBeGreaterThan(0n);
      expect(perfettoEnd - perfettoStart).toBe(timeoutNs);
      expect(['actual_anr_duration', 'perfetto_default', 'heuristic_fallback']).toContain(event.timeout_source);
      expect(event.trigger_type).toBeDefined();
      expect(Number(event.upid)).toBeGreaterThan(0);
      if (event.anr_type !== 'UNKNOWN_ANR_TYPE') {
        expect(event.trigger_type).not.toBe('unknown');
      }
    }
  }, 180000);

  it('should execute clipped overview evidence probes against the real ANR trace', async () => {
    const results = await evaluator.executeStepSequence(
      ['get_anr_context', 'anr_detection', 'system_cpu_health', 'io_load', 'futex_wait_probe', 'system_freeze_check'],
      { enable_detail_analysis: false },
    );

    for (const result of results) {
      expect(result.success).toBe(true);
    }
  }, 240000);

  it('should execute anr_detail direct blocker through the real evaluator step path', async () => {
    const events = await evaluator.executeStep('get_anr_events', { enable_detail_analysis: false });
    expect(events.success).toBe(true);
    expect(events.data.length).toBeGreaterThan(0);

    const firstEvent = events.data[0];
    const detailEvaluator = createSkillEvaluator('anr_detail');

    try {
      await detailEvaluator.loadTrace(REAL_ANR_TRACE_FILE);
      const [availability, directBlocker] = await detailEvaluator.executeStepSequence(
        ['thread_evidence_availability', 'direct_blocker_classification'],
        {
          anr_ts: firstEvent.anr_ts,
          timeout_ns: firstEvent.timeout_ns,
          process_name: firstEvent.process_name,
          pid: firstEvent.pid,
          upid: firstEvent.upid,
          anr_type: firstEvent.anr_type,
          error_id: firstEvent.error_id || '',
          intent: firstEvent.intent || '',
          component: firstEvent.component || '',
          anr_dur_ms: firstEvent.anr_dur_ms,
          perfetto_start: firstEvent.perfetto_start,
          perfetto_end: firstEvent.perfetto_end,
        },
      );

      expect(availability.success).toBe(true);
      expect(availability.data[0]?.has_thread_state).toBe(1);
      expect(availability.data[0]?.has_thread_track).toBe(1);
      expect(directBlocker.success).toBe(true);
      expect(directBlocker.data.length).toBeGreaterThan(0);

      const row = directBlocker.data[0];
      expect(row.direct_blocker_type).toBeDefined();
      expect(row.root_cause_boundary).toBeDefined();
      expect(row.next_evidence_needed).toBeDefined();
      if (row.pct_of_timeout !== null && row.pct_of_timeout !== undefined) {
        expect(row.pct_of_timeout).toBeGreaterThanOrEqual(0);
        expect(row.pct_of_timeout).toBeLessThanOrEqual(100);
      }
    } finally {
      await detailEvaluator.cleanup();
    }
  }, 240000);

  it('should execute anr_detail upid-safe helper skills through the real evaluator step path', async () => {
    const events = await evaluator.executeStep('get_anr_events', { enable_detail_analysis: false });
    expect(events.success).toBe(true);
    expect(events.data.length).toBeGreaterThan(0);

    const firstEvent = events.data[0];
    const detailEvaluator = createSkillEvaluator('anr_detail');

    try {
      await detailEvaluator.loadTrace(REAL_ANR_TRACE_FILE);
      const [blocking, mainSlices] = await detailEvaluator.executeStepSequence(
        ['blocking_reasons', 'main_thread_slices'],
        {
          anr_ts: firstEvent.anr_ts,
          timeout_ns: firstEvent.timeout_ns,
          process_name: firstEvent.process_name,
          pid: firstEvent.pid,
          upid: firstEvent.upid,
          anr_type: firstEvent.anr_type,
          error_id: firstEvent.error_id || '',
          intent: firstEvent.intent || '',
          component: firstEvent.component || '',
          anr_dur_ms: firstEvent.anr_dur_ms,
          perfetto_start: firstEvent.perfetto_start,
          perfetto_end: firstEvent.perfetto_end,
        },
      );

      expect(blocking.success).toBe(true);
      expect(mainSlices.success).toBe(true);
    } finally {
      await detailEvaluator.cleanup();
    }
  }, 240000);

  it('should execute anr_detail slice blocker branch through the real evaluator step path', async () => {
    const events = await evaluator.executeStep('get_anr_events', { enable_detail_analysis: false });
    expect(events.success).toBe(true);
    expect(events.data.length).toBeGreaterThan(0);

    const firstEvent = events.data[0];
    const detailEvaluator = createSkillEvaluator('anr_detail');

    try {
      await detailEvaluator.loadTrace(REAL_ANR_TRACE_FILE);
      const [availability, sliceBlocker] = await detailEvaluator.executeStepSequence(
        ['thread_evidence_availability', 'direct_blocker_slice_classification'],
        {
          anr_ts: firstEvent.anr_ts,
          timeout_ns: firstEvent.timeout_ns,
          process_name: firstEvent.process_name,
          pid: firstEvent.pid,
          upid: firstEvent.upid,
          anr_type: firstEvent.anr_type,
          error_id: firstEvent.error_id || '',
          intent: firstEvent.intent || '',
          component: firstEvent.component || '',
          anr_dur_ms: firstEvent.anr_dur_ms,
          perfetto_start: firstEvent.perfetto_start,
          perfetto_end: firstEvent.perfetto_end,
        },
      );

      expect(availability.success).toBe(true);
      expect(availability.data[0]?.has_thread_track).toBe(1);
      expect(availability.data[0]?.has_slice).toBe(1);
      expect(sliceBlocker.success).toBe(true);
    } finally {
      await detailEvaluator.cleanup();
    }
  }, 240000);
});

// ===========================================================================
// Edge Cases Tests
// ===========================================================================

describeWithTrace('anr_analysis edge cases', TRACE_FILE, () => {
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

    it('should handle process-name filtering without prefix bleed', async () => {
      const result = await evaluator.executeStep('anr_detection', {
        process_name: 'com.android',
      });

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

describeWithTrace('anr_analysis skill definition', TRACE_FILE, () => {
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
    expect(stepIds).toContain('trigger_classification');
    expect(stepIds).toContain('anr_overview');
    expect(stepIds).toContain('get_anr_events');
    expect(stepIds).toContain('system_cpu_health');
    expect(stepIds).toContain('memory_pressure');
    expect(stepIds).toContain('io_load');
    expect(stepIds).toContain('system_freeze_check');
    expect(stepIds).toContain('top_cpu_processes');
    expect(stepIds).toContain('analyze_anr_events'); // Iterator step
    expect(stepIds).toContain('anr_diagnosis');
  });

  it('should pass UPID into per-event ANR detail analysis', () => {
    const skill = evaluator.getSkillDefinition();
    const iterator = skill?.steps?.find(step => step.id === 'analyze_anr_events') as
      | { item_params?: Record<string, string> }
      | undefined;

    expect(iterator?.item_params).toMatchObject({ upid: 'upid' });
  });

  it('should have proper display layer assignments', () => {
    const skill = evaluator.getSkillDefinition();

    if (skill?.steps) {
      for (const step of skill.steps) {
        if (step.display && typeof step.display === 'object') {
          // Validate display level (when defined)
          if (step.display.level) {
            expect(['none', 'debug', 'detail', 'summary', 'key', 'hidden']).toContain(step.display.level);
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
