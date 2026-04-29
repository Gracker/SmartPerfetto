// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 3-4 of v2.1 — verify the active-phase reminder string that
 * gets appended to `fetch_artifact(full|rows)` responses.
 *
 * Exercises the real on-disk strategies (no mock) so the reminder
 * stays consistent with the actual phase_hints that ship in production.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildActivePhaseReminder, REMINDER_PREFIX } from '../activePhaseReminder';
import { invalidateStrategyCache } from '../strategyLoader';
import type { AnalysisPlanV3 } from '../types';

const planWithInProgress: AnalysisPlanV3 = {
  phases: [
    { id: 'p1', name: '概览', goal: '取全帧统计', expectedTools: ['scrolling_analysis'], status: 'completed', summary: '已完成' },
    // Avoid every keyword that appears on the overview hint (frame,
    // jank, 帧, 卡顿, overview, 概览, 统计) so the matcher reliably
    // picks the root_cause_drill hint.
    { id: 'p2', name: 'drill investigation', goal: 'representative slice diagnos via 深钻', expectedTools: ['jank_frame_detail'], status: 'in_progress' },
    { id: 'p3', name: '结论', goal: '输出报告', expectedTools: [], status: 'pending' },
  ],
  successCriteria: 'identify root cause',
  submittedAt: 0,
  toolCallLog: [],
};

const planAllPending: AnalysisPlanV3 = {
  phases: [
    { id: 'p1', name: '概览采集', goal: '取数据', expectedTools: ['scrolling_analysis'], status: 'pending' },
  ],
  successCriteria: 'x',
  submittedAt: 0,
  toolCallLog: [],
};

const planAllDone: AnalysisPlanV3 = {
  phases: [
    { id: 'p1', name: '概览', goal: 'x', expectedTools: [], status: 'completed' },
    { id: 'p2', name: '结论', goal: 'y', expectedTools: [], status: 'completed' },
  ],
  successCriteria: 'x',
  submittedAt: 0,
  toolCallLog: [],
};

describe('buildActivePhaseReminder', () => {
  beforeAll(() => invalidateStrategyCache());

  it('returns empty string when plan is missing', () => {
    expect(buildActivePhaseReminder(null, 'scrolling')).toBe('');
    expect(buildActivePhaseReminder(undefined, 'scrolling')).toBe('');
  });

  it('returns empty string when sceneType is missing', () => {
    expect(buildActivePhaseReminder(planWithInProgress, undefined)).toBe('');
  });

  it('returns empty string when every phase is already done', () => {
    expect(buildActivePhaseReminder(planAllDone, 'scrolling')).toBe('');
  });

  it('starts with the canonical reminder prefix', () => {
    const reminder = buildActivePhaseReminder(planWithInProgress, 'scrolling');
    expect(reminder.startsWith(REMINDER_PREFIX)).toBe(true);
  });

  it('mentions the active phase name', () => {
    const reminder = buildActivePhaseReminder(planWithInProgress, 'scrolling');
    expect(reminder).toContain('drill investigation');
  });

  it('includes the matched phase_hint constraint and critical tools (scrolling root_cause)', () => {
    const reminder = buildActivePhaseReminder(planWithInProgress, 'scrolling');
    // scrolling root_cause_drill hint → constraint mentions reason_code + workload_heavy
    expect(reminder).toMatch(/reason_code|workload_heavy/);
    expect(reminder).toMatch(/jank_frame_detail|blocking_chain_analysis/);
  });

  it('falls back to a short phase pointer for scenes without phase_hints', () => {
    // memory has no phase_hints in its strategy frontmatter
    const memoryPlan: AnalysisPlanV3 = {
      phases: [
        { id: 'p1', name: '内存分析', goal: '查找泄漏', expectedTools: ['memory_analysis'], status: 'in_progress' },
      ],
      successCriteria: 'x',
      submittedAt: 0,
      toolCallLog: [],
    };
    const reminder = buildActivePhaseReminder(memoryPlan, 'memory');
    expect(reminder).toContain('内存分析');
    expect(reminder).toContain('查找泄漏');
  });

  it('picks the first pending phase when no phase is in_progress', () => {
    const reminder = buildActivePhaseReminder(planAllPending, 'scrolling');
    expect(reminder).toContain('概览采集');
  });

  it('caps the rendered length so a busy fetch_artifact response stays compact', () => {
    const reminder = buildActivePhaseReminder(planWithInProgress, 'scrolling');
    // Constraint is trimmed to 140 chars; total stays comfortably below
    // 350 chars (prefix + phase name + constraint + tool list).
    expect(reminder.length).toBeLessThanOrEqual(350);
  });
});
