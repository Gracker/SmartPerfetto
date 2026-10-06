/**
 * Scrolling Analysis Skill Evaluation Tests
 *
 * 测试 scrolling_analysis skill 在已知 trace 文件上的行为
 * 验证 SQL 查询产生正确的结构和数据
 *
 * 夹具为 customer 滑动 trace，套件在任何测试之前先断言其 FrameTimeline 数据存在。
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath, describeWithTrace } from './runner';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 使用 Android trace 文件测试 - 需要有 FrameTimeline 数据的 Android trace.
const TRACE_FILE = 'android-scroll-customer';

describeWithTrace('scrolling_analysis skill', TRACE_FILE, () => {
  let evaluator: SkillEvaluator;

  beforeAll(async () => {
    evaluator = createSkillEvaluator('scrolling_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // 下面的断言都读取该夹具的 FrameTimeline。
    const result = await evaluator.executeSQL(`
      SELECT COUNT(*) FROM actual_frame_timeline_slice WHERE surface_frame_token IS NOT NULL
    `);
    expect(result.error).toBeUndefined();
    expect(result.rows[0][0]).toBeGreaterThan(0);
  }, 60000); // 60 秒超时用于加载 trace

  afterAll(async () => {
    await evaluator.cleanup();
    // Wait for trace processor port release (destroy() has a 2s setTimeout)
    await new Promise(resolve => setTimeout(resolve, 2500));
  });

  // ===========================================================================
  // L1 Overview Layer Tests
  // ===========================================================================

  describe('L1: Overview Layer', () => {
    describe('vsync_config step', () => {
      it('should return vsync configuration data', async () => {
        const result = await evaluator.executeStep('vsync_config');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
      }, 30000);

      it('should have valid refresh rate (60-240 Hz)', async () => {
        const result = await evaluator.executeStep('vsync_config');
        const config = result.data[0];

        // 现代设备支持高刷新率，如 90Hz, 120Hz, 144Hz, 165Hz, 170Hz, 240Hz
        expect(config.refresh_rate_hz).toBeGreaterThanOrEqual(60);
        expect(config.refresh_rate_hz).toBeLessThanOrEqual(240);
      }, 30000);

      it('should have valid vsync period', async () => {
        const result = await evaluator.executeStep('vsync_config');
        const config = result.data[0];

        // vsync_period_ms 应该在 4.17ms (240Hz) 到 16.67ms (60Hz) 之间
        expect(config.vsync_period_ms).toBeGreaterThanOrEqual(4);
        expect(config.vsync_period_ms).toBeLessThanOrEqual(17);
      }, 30000);

      it('should indicate data availability', async () => {
        const result = await evaluator.executeStep('vsync_config');
        const config = result.data[0];

        expect(config.has_data).toBe(1);
        expect(config.total_frames).toBeGreaterThan(0);
      }, 30000);
    });

    describe('performance_summary step', () => {
      it('should return performance metrics', async () => {
        const result = await evaluator.executeStep('performance_summary');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
      }, 30000);

      it('should have valid frame counts', async () => {
        const result = await evaluator.executeStep('performance_summary');
        const summary = result.data[0];

        expect(summary.total_frames).toBeGreaterThan(0);
        expect(typeof summary.janky_frames).toBe('number');
        expect(summary.janky_frames).toBeGreaterThanOrEqual(0);
        expect(summary.janky_frames).toBeLessThanOrEqual(summary.total_frames);
      }, 30000);

      it('should have valid jank rate (0-100%)', async () => {
        const result = await evaluator.executeStep('performance_summary');
        const summary = result.data[0];

        expect(summary.jank_rate).toBeGreaterThanOrEqual(0);
        expect(summary.jank_rate).toBeLessThanOrEqual(100);
      }, 30000);

      it('should have valid FPS metrics', async () => {
        const result = await evaluator.executeStep('performance_summary');
        const summary = result.data[0];

        // actual_fps 应该是正数；高刷设备/trace 可能超过 200
        if (summary.actual_fps !== null) {
          expect(summary.actual_fps).toBeGreaterThan(0);
          expect(summary.actual_fps).toBeLessThanOrEqual(240);
        }
      }, 30000);

      it('should have valid performance rating', async () => {
        const result = await evaluator.executeStep('performance_summary');
        const summary = result.data[0];

        expect(['优秀', '良好', '一般', '较差']).toContain(summary.rating);
      }, 30000);

      it('should have frame duration metrics', async () => {
        const result = await evaluator.executeStep('performance_summary');
        const summary = result.data[0];

        // 帧时长应该在合理范围内（值为纳秒）
        expect(summary.avg_frame_dur).toBeGreaterThan(0);
        expect(summary.p95_frame_dur).toBeGreaterThan(0);
        expect(summary.p99_frame_dur).toBeGreaterThan(0);
        // 注意：avg 可能大于 p95，因为有极端慢帧会大幅拉高平均值
        // 只验证 p99 >= p95
        expect(summary.p99_frame_dur).toBeGreaterThanOrEqual(summary.p95_frame_dur);
      }, 30000);
    });

    describe('input_data_check step', () => {
      it('should report input data availability without requiring input events', async () => {
        const result = await evaluator.executeStep('input_data_check');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);

        const status = result.data[0];
        expect(['available', 'no_frame_match', 'unavailable']).toContain(status.input_data_status);
        expect(typeof status.total_input_events).toBe('number');
        expect(typeof status.move_events).toBe('number');
        expect(typeof status.frame_matched_events).toBe('number');
        expect(status.total_input_events).toBeGreaterThanOrEqual(0);
      }, 30000);
    });

    describe('jank_type_stats step', () => {
      it('should return jank type distribution', async () => {
        const result = await evaluator.executeStep('jank_type_stats');

        expect(result.success).toBe(true);
        // The fixture has janky frames; empty means extraction regressed.
        expect(result.data.length).toBeGreaterThan(0);
      }, 30000);

      it('should have valid jank type categories', async () => {
        const result = await evaluator.executeStep('jank_type_stats');
        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);

        for (const stat of result.data) {
          expect(stat.jank_type).toBeDefined();
          expect(typeof stat.jank_type).toBe('string');
          expect(stat.count).toBeGreaterThan(0);
          expect(typeof stat.responsibility).toBe('string');
          expect(stat.responsibility.startsWith('标签:')).toBe(true);
        }
      }, 30000);
    });
  });

  // ===========================================================================
  // L2 List Layer Tests
  // ===========================================================================

  describe('L2: List Layer', () => {
    describe('scroll_sessions step', () => {
      it('should detect scroll sessions', async () => {
        const result = await evaluator.executeStep('scroll_sessions');

        expect(result.success).toBe(true);
        // 应该至少检测到一个滑动会话
        expect(result.data.length).toBeGreaterThan(0);
      }, 30000);

      it('should have valid session structure', async () => {
        const result = await evaluator.executeStep('scroll_sessions');
        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
        const session = result.data[0];

        // 必需字段
        expect(session.session_id).toBeDefined();
        expect(session.process_name).toBeDefined();
        expect(session.start_ts).toBeDefined();
        expect(session.end_ts).toBeDefined();

        // 帧数应该 >= 10 (因为 HAVING COUNT(*) >= 10)
        expect(session.frame_count).toBeGreaterThanOrEqual(10);

        // 时长应该 > 200ms (因为 HAVING duration > 200000000ns)
        expect(session.duration_ms).toBeGreaterThan(200);
      }, 30000);

      it('should have valid timestamps', async () => {
        const result = await evaluator.executeStep('scroll_sessions');
        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);
        const session = result.data[0];

        // start_ts 和 end_ts 应该是可解析的大整数字符串
        const startTs = BigInt(session.start_ts);
        const endTs = BigInt(session.end_ts);

        expect(startTs).toBeGreaterThan(0n);
        expect(endTs).toBeGreaterThan(startTs);
      }, 30000);

      it('should have valid FPS per session', async () => {
        const result = await evaluator.executeStep('scroll_sessions');
        expect(result.success).toBe(true);
        expect(result.data.length).toBeGreaterThan(0);

        for (const session of result.data) {
          // session_fps 应该是正数，在合理范围内
          if (session.session_fps !== null) {
            expect(session.session_fps).toBeGreaterThan(0);
            expect(session.session_fps).toBeLessThanOrEqual(200);
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
      const result = await evaluator.executeSkill();

      expect(result.success).toBe(true);
      expect(result.skillId).toBe('scrolling_analysis');
    }, 120000);

    it('should have overview layer results', async () => {
      const result = await evaluator.executeSkill();
      const overview = result.layers.overview;

      // 应该有 vsync_config 和 performance_summary
      expect(overview).toBeDefined();
      expect(Object.keys(overview!).length).toBeGreaterThan(0);
      expect(overview!.input_data_check).toBeDefined();
    }, 120000);

    it('should have list layer results', async () => {
      const result = await evaluator.executeSkill();
      const list = result.layers.list;

      // 应该有 scroll_sessions
      expect(list).toBeDefined();
      expect(Object.keys(list!).length).toBeGreaterThan(0);
    }, 120000);

    it('should support deep frame details when enabled', async () => {
      const result = await evaluator.executeSkill({
        enable_frame_details: true,
        max_frames_per_session: 2,
      });

      expect(result.success).toBe(true);
      // In heavy-jank traces, deep layer should contain per-frame iterator results.
      expect(result.layers.deep).toBeDefined();
    }, 120000);

    it('should enforce max_frames_per_session for get_app_jank_frames', async () => {
      const sessionJank = await evaluator.executeStep('session_jank');
      const sortedJankSessions = [...sessionJank.data].sort(
        (a: any, b: any) => Number(b.janky_count || 0) - Number(a.janky_count || 0)
      );
      const target = sortedJankSessions[0];

      // The customer scroll fixture has a session with at least 3 janky frames.
      expect(Number(target?.janky_count || 0)).toBeGreaterThanOrEqual(3);

      const sessions = await evaluator.executeStep('scroll_sessions');
      const window = sessions.data.find(
        (row: any) => Number(row.session_id) === Number(target.session_id)
      );

      expect(window?.start_ts).toBeTruthy();
      expect(window?.end_ts).toBeTruthy();

      const baseParams = {
        package: String(window.process_name || ''),
        start_ts: String(window.start_ts),
        end_ts: String(window.end_ts),
      };

      const limited = await evaluator.executeStep('get_app_jank_frames', {
        ...baseParams,
        max_frames_per_session: 2,
      });
      const expanded = await evaluator.executeStep('get_app_jank_frames', {
        ...baseParams,
        max_frames_per_session: 20,
      });

      expect(limited.success).toBe(true);
      expect(expanded.success).toBe(true);
      expect(limited.data.length).toBeLessThanOrEqual(2);
      expect(expanded.data.length).toBeGreaterThanOrEqual(limited.data.length);

      if (expanded.data.length > 2) {
        expect(limited.data.length).toBeLessThan(expanded.data.length);
      }
    }, 120000);

    it('should expose input evidence fields on batch root cause rows', async () => {
      const result = await evaluator.executeStep('batch_frame_root_cause', {
        max_frames_per_session: 3,
      });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);

      const row = result.data[0];
      const numericFields = [
        'input_event_count',
        'input_move_count',
        'input_handling_ms',
        'input_handling_total_ms',
        'input_dispatch_ms',
        'input_e2e_ms',
        'input_slice_ms',
        'input_speculative_events',
      ];

      for (const field of numericFields) {
        expect(row).toHaveProperty(field);
        expect(Number.isNaN(Number(row[field]))).toBe(false);
      }

      expect(row).toHaveProperty('input_stage');
      expect(row).toHaveProperty('input_events_json');
      expect(row).toHaveProperty('input_slices_json');
      expect(typeof row.input_events_json).toBe('string');
      expect(typeof row.input_slices_json).toBe('string');
    }, 120000);

    it('should produce consistent normalized output', async () => {
      const result = await evaluator.executeSkill();
      const normalized = evaluator.normalizeForSnapshot(result);

      // 应该有合理数量的步骤结果
      expect(normalized.stepCount).toBeGreaterThanOrEqual(3);

      // Overview 层应该有数据
      expect(Object.keys(normalized.layers.overview).length).toBeGreaterThan(0);
    }, 120000);
  });

  // ===========================================================================
  // SQL Execution Tests (直接测试 SQL)
  // ===========================================================================

  describe('Direct SQL Execution', () => {
    it('should execute simple frame count query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as frame_count
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
      `);

      expect(result.error).toBeUndefined();
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBeGreaterThan(0);
    }, 30000);

    it('should execute jank detection query', async () => {
      const result = await evaluator.executeSQL(`
        SELECT jank_type, COUNT(*) as count
        FROM actual_frame_timeline_slice
        WHERE jank_type != 'None'
          AND surface_frame_token IS NOT NULL
        GROUP BY jank_type
        ORDER BY count DESC
        LIMIT 5
      `);

      expect(result.error).toBeUndefined();
      // 结果可能为空（如果没有 jank）或有数据
    }, 30000);
  });

  describe('input evidence', () => {
    it('should find the fixture input events matched to frames', async () => {
      const result = await evaluator.executeStep('input_data_check');

      expect(result.success).toBe(true);
      expect(result.data).toEqual([expect.objectContaining({input_data_status: 'available'})]);
      expect(result.data[0].frame_matched_events).toBeGreaterThan(0);
    }, 60000);

    it('should keep batch root cause rows compatible with input evidence columns', async () => {
      const result = await evaluator.executeStep('batch_frame_root_cause', {
        max_frames_per_session: 3,
      });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);

      const row = result.data[0];
      expect(row).toHaveProperty('input_event_count');
      expect(row).toHaveProperty('input_slice_ms');
      expect(row).toHaveProperty('input_events_json');
      expect(row).toHaveProperty('input_slices_json');
    }, 120000);
  });
});

// ===========================================================================
// 边界情况测试
// ===========================================================================

describeWithTrace('scrolling_analysis edge cases', TRACE_FILE, () => {
  describe('with package filter', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('scrolling_analysis');
      await evaluator.loadTrace(getTestTracePath(TRACE_FILE));
    }, 60000);

    afterAll(async () => {
      await evaluator.cleanup();
    });

    it('should work with empty package filter', async () => {
      const result = await evaluator.executeStep('performance_summary', { package: '' });

      expect(result.success).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].total_frames).toBeGreaterThan(0);
      expect(result.data[0].jank_rate).toBeGreaterThanOrEqual(0);
    }, 30000);

    // A package that names no process is refused by the identity gate rather
    // than analysed as an empty selection.
    it('should refuse a package that names no process', async () => {
      for (const stepId of ['performance_summary', 'scroll_sessions']) {
        await expect(evaluator.executeStep(stepId, {package: 'com.nonexistent.app'}))
          .rejects.toThrow(/Process identity could not be verified.*status=not_found/);
      }
    }, 30000);

    it('should disable frame_variance_probe when enable_expert_probes is false', async () => {
      const result = await evaluator.executeStep('frame_variance_probe', {
        enable_expert_probes: false,
      });

      expect(result.data).toEqual([]);
      expect(result.code).toBe('condition_not_met');
    }, 30000);

    it('should react to frame_variance_transition_threshold_ms changes', async () => {
      // Only these production steps feed the probe's conditions and parameters.
      // Full scrolling execution has separate coverage; repeating it here also
      // runs per-frame root-cause analysis unrelated to this threshold.
      const probeAtThreshold = async (threshold: number) => {
        const results = await evaluator.executeStepSequence([
          'frame_timeline_check', 'vsync_config', 'buffer_tx_coverage_probe',
          'performance_summary', 'expert_analysis_window', 'frame_variance_probe',
        ], {
          enable_expert_probes: true,
          frame_variance_probe_min_janky_frames: 1,
          frame_variance_transition_threshold_ms: threshold,
        });
        for (const result of results) {
          expect(result.success).toBe(true);
          expect(result.code).not.toBe('condition_not_met');
        }
        const byId = Object.fromEntries(results.map(result => [result.stepId, result]));
        expect(byId.frame_timeline_check.data[0]?.has_frame_timeline).toBe(1);
        expect(byId.vsync_config.data[0]?.has_data).toBe(1);
        expect(byId.performance_summary.data[0]?.janky_frames).toBeGreaterThanOrEqual(1);
        expect(byId.expert_analysis_window.data).toHaveLength(1);
        expect(byId.expert_analysis_window.data[0]?.window_source).not.toBe('unavailable');
        return byId.frame_variance_probe;
      };
      const lowThreshold = await probeAtThreshold(2);
      const highThreshold = await probeAtThreshold(20);

      expect(lowThreshold.success).toBe(true);
      expect(highThreshold.success).toBe(true);
      expect(lowThreshold.data.length).toBeGreaterThan(0);
      expect(highThreshold.data.length).toBeGreaterThan(0);
      expect(lowThreshold.data[0].high_variance_transitions).toBeGreaterThan(
        highThreshold.data[0].high_variance_transitions
      );
    }, 30000);
  });
});

describe('continuous main-thread work on canonical traces', () => {
  const steps = ['main_thread_work_summary', 'main_thread_work_tasks', 'main_thread_work_sources', 'main_thread_work_cadence'];
  it('delivers inter-frame tasks from the full scrolling Skill without target FrameTimeline rows', async () => {
    const evaluator = createSkillEvaluator('scrolling_analysis');
    try {
      await evaluator.loadTrace(path.resolve(process.cwd(), '../Trace/.generated/constructed/main-thread-frame-work/trace.pftrace'));
      const frameRows = await evaluator.executeSQL(`SELECT COUNT(*) AS count FROM actual_frame_timeline_slice a
        JOIN process p ON p.upid=a.upid WHERE p.name='com.smartperfetto.fixture'`);
      expect(frameRows.rows[0][0]).toBe(0);
      const result = await evaluator.executeRuntimeSkill({package:'com.smartperfetto.fixture', enable_expert_probes:false});
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const tasks = result.rawResults?.main_thread_work_tasks;
      expect(tasks?.success).toBe(true);
      expect(tasks?.data).toEqual(expect.arrayContaining([expect.objectContaining({
        task_name:'ContentLoader$MainHandler: initializeContent', phase:'between_doFrames',
        outside_doframe_ms:30,running_ms:28,runnable_ms:2,
      })]));
      expect((result.rawResults?.main_thread_work_sources.data as any[])?.length).toBeGreaterThan(0);
      expect(result.displayResults.some(row => row.stepId === 'main_thread_work_tasks')).toBe(true);
    } finally { await evaluator.cleanup(); }
  }, 120000);
  it.each([
    'lacunh_heavy.pftrace', 'launch_light.pftrace',
    'scroll_Standard-AOSP-App-Without-PreAnimation.pftrace',
    'scroll-demo-customer-scroll.pftrace', 'Scroll-Flutter-327-TextureView.pftrace',
    'Scroll-Flutter-SurfaceView-Wechat-Wenyiwen.pftrace',
  ])('preserves full-window coverage and bounded task evidence: %s', async trace => {
    const evaluator = createSkillEvaluator('scrolling_analysis');
    try {
      await evaluator.loadTrace(getTestTracePath(trace));
      const candidates = await evaluator.executeSQL(`
        SELECT p.name, p.upid FROM process p
        JOIN thread t ON t.upid=p.upid AND t.tid=p.pid
        JOIN thread_track tt ON tt.utid=t.utid
        JOIN slice s ON s.track_id=tt.id
        WHERE p.name GLOB 'com.*' AND s.dur>0
        GROUP BY p.upid
        ORDER BY SUM(s.name GLOB 'Choreographer#doFrame*') DESC, COUNT(*) DESC LIMIT 1`);
      expect(candidates.error).toBeFalsy();
      expect(candidates.rows).toHaveLength(1);
      const packageName = String(candidates.rows[0][0]);
      const full = await evaluator.executeStepSequence(steps, {package: packageName});
      for (const step of full) expect({step: step.stepId, success: step.success, error: step.error})
        .toEqual({step: step.stepId, success: true, error: undefined});
      const windows = full[0].data.filter(row => row.phase === 'window');
      expect(windows.length).toBeGreaterThan(0);
      for (const row of windows) {
        expect(typeof row.window_start_ts).toBe('string');
        expect(typeof row.window_end_ts).toBe('string');
        expect(row.annotated_wall_ms + row.unannotated_wall_ms).toBeCloseTo(row.wall_ms, 5);
        expect(row.known_state_ms + row.unknown_state_ms).toBeCloseTo(row.wall_ms, 5);
        const phases = full[0].data.filter(value => value.utid === row.utid && value.phase !== 'window');
        expect(phases.reduce((sum, value) => sum + value.wall_ms, 0)).toBeCloseTo(row.wall_ms, 5);
      }
      expect(full[1].data.length).toBeLessThanOrEqual(20);
      for (const task of full[1].data) {
        expect(typeof task.start_ts).toBe('string');
        expect(task.running_ms === null || task.running_ms <= task.wall_ms + 0.000001).toBe(true);
        expect(task.returned_task_count).toBeLessThanOrEqual(task.eligible_task_count);
      }
      const start = BigInt(windows[0].window_start_ts);
      const end = BigInt(windows[0].window_end_ts);
      const boundedEnd = end < start + 500_000_000n ? end : start + 500_000_000n;
      const bounded = await evaluator.executeStepSequence(steps, {
        package: packageName, start_ts: String(start), end_ts: String(boundedEnd),
      });
      expect(bounded.every(step => step.success)).toBe(true);
      const sources = ['skills/composite/scrolling_analysis.skill.yaml',
        'skills/fragments/main_thread_work.sql', 'skills/fragments/main_thread_work_tasks.sql',
        'skills/fragments/main_thread_work_cadence.sql'];
      const evidence = {trace, package: packageName, selectedUpid: candidates.rows[0][1],
        sourceSha256: Object.fromEntries(sources.map(file => [file,
          crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
        fullWindow: full.map(step => ({...step, outputBytes: Buffer.byteLength(JSON.stringify(step.data))})),
        boundedWindow: bounded.map(step => ({...step, outputBytes: Buffer.byteLength(JSON.stringify(step.data))}))};
      const output = path.join(process.cwd(), 'test-output/main-thread-work-20260908/real-traces');
      fs.mkdirSync(output, {recursive: true});
      fs.writeFileSync(path.join(output, `${trace}.json`), JSON.stringify(evidence, null, 2));
    } finally { await evaluator.cleanup(); }
  }, 120000);
});
