// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 0.4 of v2.1 — exercise the shared scene-template validator.
 * `submit_plan` and `revise_plan` both delegate here so an agent cannot
 * submit a compliant plan and then revise mandatory phases away to
 * bypass the hard-gate.
 */

import { describe, it, expect } from '@jest/globals';
import { validatePlanAgainstSceneTemplate } from '../scenePlanTemplates';

const minimalPhase = (overrides: Partial<{ name: string; goal: string; expectedTools: string[] }> = {}) => ({
  name: '',
  goal: '',
  expectedTools: [] as string[],
  ...overrides,
});

describe('validatePlanAgainstSceneTemplate', () => {
  it('returns no warnings for unknown scenes', () => {
    expect(validatePlanAgainstSceneTemplate([], undefined)).toEqual({
      warnings: [],
      missingAspectIds: [],
    });
    expect(validatePlanAgainstSceneTemplate([], 'never_existed')).toEqual({
      warnings: [],
      missingAspectIds: [],
    });
  });

  it('returns no warnings for scenes deliberately without a template (general)', () => {
    expect(validatePlanAgainstSceneTemplate(
      [minimalPhase({ name: 'whatever', goal: 'whatever' })],
      'general',
    )).toEqual({ warnings: [], missingAspectIds: [] });
  });

  it('flags every uncovered aspect when phases mention nothing relevant', () => {
    const result = validatePlanAgainstSceneTemplate(
      [minimalPhase({ name: 'overview', goal: 'fetch', expectedTools: ['execute_sql'] })],
      'scrolling',
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.missingAspectIds.length).toBe(result.warnings.length);
  });

  it('passes when phases cover every mandatory aspect for scrolling', () => {
    const result = validatePlanAgainstSceneTemplate(
      [
        minimalPhase({
          name: '帧渲染分析',
          goal: '获取卡顿帧分布',
          expectedTools: ['scrolling_analysis'],
        }),
        minimalPhase({
          name: '根因诊断',
          goal: 'jank_frame_detail 深入',
          expectedTools: ['jank_frame_detail'],
        }),
      ],
      'scrolling',
    );
    expect(result.warnings).toEqual([]);
    expect(result.missingAspectIds).toEqual([]);
  });

  it('matches keywords case-insensitively across name/goal/expectedTools', () => {
    const result = validatePlanAgainstSceneTemplate(
      [minimalPhase({ name: 'ANR Diagnosis', goal: 'find DEADLOCK', expectedTools: [] })],
      'anr',
    );
    expect(result.warnings).toEqual([]);
  });

  it('reports the same missingAspectIds across repeated calls (stable handles)', () => {
    const phases = [minimalPhase({ name: 'irrelevant', goal: 'irrelevant' })];
    const a = validatePlanAgainstSceneTemplate(phases, 'startup');
    const b = validatePlanAgainstSceneTemplate(phases, 'startup');
    expect(a.missingAspectIds).toEqual(b.missingAspectIds);
  });
});
