// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  formatToolCallNarration,
  looksLikeGenericToolMessage,
} from '../toolNarration';

describe('toolNarration', () => {
  it('describes submit_plan with phase goals', () => {
    const text = formatToolCallNarration('submit_plan', {
      phases: [
        { id: 'p1', name: '概览采集', goal: '获取帧统计和卡顿分布' },
        { id: 'p2', name: '根因分析', goal: '下钻主线程与调度证据' },
      ],
    });

    expect(text).toContain('制定分析计划');
    expect(text).toContain('获取帧统计和卡顿分布');
    expect(text).toContain('根因分析');
  });

  it('keeps late phases visible and moves conclusion-like phases to the end in narration', () => {
    const text = formatToolCallNarration('submit_plan', {
      phases: [
        { id: 'p1', name: '启动概览', goal: '定位启动事件' },
        { id: 'p2', name: '启动详情', goal: '下钻主线程状态' },
        { id: 'p3', name: '慢原因验证', goal: '交叉验证慢启动原因' },
        { id: 'p4', name: '综合结论', goal: '输出最终报告' },
        { id: 'p5', name: 'WebView专项分析', goal: '验证 Chromium/V8 相关 slice' },
      ],
    });

    expect(text).toContain('p5 WebView专项分析');
    expect(text.indexOf('p5 WebView专项分析')).toBeLessThan(text.indexOf('p4 综合结论'));
  });

  it('describes invoke_skill with skill id, purpose, and params', () => {
    const text = formatToolCallNarration('mcp__smartperfetto__invoke_skill', {
      skillId: 'startup_analysis',
      params: { process_name: 'com.example', enable_startup_details: false },
    });

    expect(text).toContain('调用 Skill startup_analysis');
    expect(text).toContain('定位启动事件');
    expect(text).toContain('process_name=com.example');
  });

  it('uses precise skill purposes for frame gap and blocking tools', () => {
    const gap = formatToolCallNarration('invoke_skill', {
      skillId: 'frame_production_gap',
      params: { process_name: 'com.example' },
    });
    const blocking = formatToolCallNarration('invoke_skill', {
      skillId: 'frame_blocking_calls',
      params: { process_name: 'com.example' },
    });
    const lockBinder = formatToolCallNarration('invoke_skill', {
      skillId: 'lock_binder_wait',
      params: { process_name: 'com.example' },
    });

    expect(gap).toContain('帧生产链路缺口');
    expect(gap).not.toContain('I/O、文件或数据库');
    expect(blocking).toContain('阻塞调用');
    expect(lockBinder).toContain('锁等待');
  });

  it('describes update_plan_phase with status and evidence', () => {
    const text = formatToolCallNarration('update_plan_phase', {
      phaseId: 'p1',
      status: 'completed',
      summary: '已经拿到启动事件表',
    });

    expect(text).toContain('推进计划阶段 p1 -> completed');
    expect(text).toContain('已经拿到启动事件表');
  });

  it('describes comparison SQL with trace side and table purpose', () => {
    const text = formatToolCallNarration('execute_sql_on', {
      trace: 'reference',
      sql: 'SELECT COUNT(*) FROM actual_frame_timeline_slice',
    });

    expect(text).toContain('执行对比 SQL');
    expect(text).toContain('对比 Trace');
    expect(text).toContain('实际帧时间线');
  });

  it('describes comparison tools with pane labels when trace pair context exists', () => {
    const tracePairContext = {
      schemaVersion: 1 as const,
      layout: 'horizontal' as const,
      primarySide: 'left' as const,
      referenceSide: 'right' as const,
      panes: [
        {side: 'left' as const, traceSide: 'current' as const, traceId: 'trace-a'},
        {side: 'right' as const, traceSide: 'reference' as const, traceId: 'trace-b'},
      ],
    };
    const sqlText = formatToolCallNarration(
      'execute_sql_on',
      {
        trace: 'reference',
        sql: 'SELECT COUNT(*) FROM actual_frame_timeline_slice',
      },
      'zh-CN',
      {tracePairContext},
    );
    const skillText = formatToolCallNarration(
      'compare_skill',
      {
        skillId: 'scrolling_analysis',
        params: {process_name: 'com.example'},
      },
      'zh-CN',
      {tracePairContext},
    );

    expect(sqlText).toContain('右侧/对比 Trace');
    expect(skillText).toContain('左侧/基线 Trace 和 右侧/对比 Trace');
  });

  it('describes comparison tools with English pane labels when requested', () => {
    const tracePairContext = {
      schemaVersion: 1 as const,
      layout: 'vertical' as const,
      primarySide: 'top' as const,
      referenceSide: 'bottom' as const,
      panes: [
        {side: 'top' as const, traceSide: 'current' as const, traceId: 'trace-a'},
        {side: 'bottom' as const, traceSide: 'reference' as const, traceId: 'trace-b'},
      ],
    };
    const sqlText = formatToolCallNarration(
      'execute_sql_on',
      {
        trace: 'reference',
        sql: 'SELECT COUNT(*) FROM actual_frame_timeline_slice',
      },
      'en',
      {tracePairContext},
    );
    const skillText = formatToolCallNarration(
      'compare_skill',
      {
        skillId: 'startup_analysis',
        params: {process_name: 'com.example'},
      },
      'en',
      {tracePairContext},
    );

    expect(sqlText).toContain('bottom pane/comparison trace');
    expect(sqlText).toContain('actual frame timeline');
    expect(skillText).toContain('top pane/baseline trace and bottom pane/comparison trace');
    expect(skillText).toContain('params: process_name=com.example');
  });

  it('describes SQL intent from comments and query shape', () => {
    const comment = formatToolCallNarration('execute_sql', {
      sql: `
        -- 查询 animation slice 及其子 slices
        SELECT name, dur FROM slice
      `,
    });
    const frameBounds = formatToolCallNarration('execute_sql', {
      sql: "SELECT printf('%d', MIN(ts)) as start_ts, printf('%d', MAX(ts + dur)) as end_ts FROM actual_frame_timeline_slice",
    });

    expect(comment).toContain('查询 animation slice 及其子 slices');
    expect(frameBounds).toContain('Trace 时间边界');
  });

  it('describes compare_skill with both traces and skill purpose', () => {
    const text = formatToolCallNarration('compare_skill', {
      skillId: 'scrolling_analysis',
      params: {process_name: 'com.example'},
    });

    expect(text).toContain('对比 Skill scrolling_analysis');
    expect(text).toContain('基线 Trace');
    expect(text).toContain('对比 Trace');
    expect(text).toContain('统计滑动会话');
    expect(text).toContain('process_name=com.example');
  });

  it('describes fetch_artifact purpose when provided', () => {
    const text = formatToolCallNarration('fetch_artifact', {
      artifactId: 'art-17',
      detail: 'rows',
      purpose: '核对根因深钻阶段的四象限完整行',
    });

    expect(text).toContain('art-17');
    expect(text).toContain('四象限完整行');
  });

  it('identifies generic tool messages that should be replaced', () => {
    expect(looksLikeGenericToolMessage('调用工具: invoke_skill')).toBe(true);
    expect(looksLikeGenericToolMessage('Call tool: submit_plan')).toBe(true);
    expect(looksLikeGenericToolMessage('调用 Skill startup_analysis：定位启动事件')).toBe(false);
  });
});
