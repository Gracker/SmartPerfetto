/**
 * Scrolling Analysis Skill Evaluation Tests
 *
 * 测试 scrolling_analysis skill 在已知 trace 文件上的行为
 * 验证 SQL 查询产生正确的结构和数据
 *
 * 注意：scrolling_analysis 需要 Android FrameTimeline 数据
 * 如果 trace 文件缺少 actual_frame_timeline_slice 表，部分测试会被跳过
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SkillEvaluator, createSkillEvaluator, getTestTracePath } from './runner';

describe('scrolling_analysis skill', () => {
  let evaluator: SkillEvaluator;
  let hasFrameTimelineData = false;

  // 使用 Android trace 文件测试 - 需要有 FrameTimeline 数据的 Android trace
  const TRACE_FILE = 'app_aosp_scrolling_heavy_jank.pftrace';

  beforeAll(async () => {
    evaluator = createSkillEvaluator('scrolling_analysis');
    await evaluator.loadTrace(getTestTracePath(TRACE_FILE));

    // 检查 trace 是否有 FrameTimeline 数据
    try {
      const result = await evaluator.executeSQL(`
        SELECT COUNT(*) as count
        FROM actual_frame_timeline_slice
        WHERE surface_frame_token IS NOT NULL
        LIMIT 1
      `);
      hasFrameTimelineData = !result.error && result.rows.length > 0 && result.rows[0][0] > 0;
    } catch (e) {
      hasFrameTimelineData = false;
    }

    if (!hasFrameTimelineData) {
      console.warn(`[Test Warning] Trace ${TRACE_FILE} does not have FrameTimeline data. Some tests will be skipped.`);
    }
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

    describe('jank_type_stats step', () => {
      it('should return jank type distribution', async () => {
        const result = await evaluator.executeStep('jank_type_stats');

        expect(result.success).toBe(true);
        // app_aosp_scrolling_heavy_jank.pftrace is a heavy-jank fixture; empty means extraction regressed.
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
          expect(['应用', 'SF', '缓冲区', '无(可能漏检)', '其他']).toContain(stat.responsibility);
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

      if (!target || Number(target.janky_count || 0) < 3) {
        console.warn('Skipping test: no session with >=3 janky frames');
        return;
      }

      const sessions = await evaluator.executeStep('scroll_sessions');
      const window = sessions.data.find(
        (row: any) => Number(row.session_id) === Number(target.session_id)
      );

      if (!window?.start_ts || !window?.end_ts) {
        console.warn('Skipping test: no valid session window for target session');
        return;
      }

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
});

// ===========================================================================
// 边界情况测试
// ===========================================================================

describe('scrolling_analysis edge cases', () => {
  describe('with package filter', () => {
    let evaluator: SkillEvaluator;

    beforeAll(async () => {
      evaluator = createSkillEvaluator('scrolling_analysis');
      await evaluator.loadTrace(getTestTracePath('app_aosp_scrolling_heavy_jank.pftrace'));
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

    it('should return condition-not-met for non-matching package in performance_summary', async () => {
      const result = await evaluator.executeStep('performance_summary', {
        package: 'com.nonexistent.app',
      });

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.error).toContain('Condition not met');
    }, 30000);

    it('should return condition-not-met for non-matching package in scroll_sessions', async () => {
      const result = await evaluator.executeStep('scroll_sessions', {
        package: 'com.nonexistent.app',
      });

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.error).toContain('Condition not met');
    }, 30000);

    it('should disable frame_variance_probe when enable_expert_probes is false', async () => {
      const result = await evaluator.executeStep('frame_variance_probe', {
        enable_expert_probes: false,
      });

      expect(result.success).toBe(false);
      expect(result.data).toEqual([]);
      expect(result.error).toContain('Condition not met');
    }, 30000);

    it('should react to frame_variance_transition_threshold_ms changes', async () => {
      const lowThreshold = await evaluator.executeStep('frame_variance_probe', {
        enable_expert_probes: true,
        frame_variance_probe_min_janky_frames: 1,
        frame_variance_transition_threshold_ms: 2,
      });
      const highThreshold = await evaluator.executeStep('frame_variance_probe', {
        enable_expert_probes: true,
        frame_variance_probe_min_janky_frames: 1,
        frame_variance_transition_threshold_ms: 20,
      });

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
