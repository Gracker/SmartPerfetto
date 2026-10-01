// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {EvidenceScopeProvenanceV1} from '../../../types/identityContract';
import {answerGenerator} from '../answerGenerator';
import {smartSummaryGenerator} from '../smartSummaryGenerator';
import type {DisplayResult} from '../types';

const scope = (role: 'target' | 'global_context'): EvidenceScopeProvenanceV1 => ({version: 'process_scope_evidence@1',
  entries: [{role, scope: role === 'target'
    ? {mode: 'exact_upid', upid: 885, traceId: 'trace', traceSide: 'current'}
    : {mode: 'unscoped', traceId: 'trace', traceSide: 'current'}}]});
const display = (stepId: string, total: number, role: 'target' | 'global_context'): DisplayResult => ({
  stepId, title: stepId, level: 'summary', format: 'table',
  data: {columns: ['total_frames', 'janky_frames'], rows: [[total, role === 'target' ? 7 : 21]]}, scopeProvenance: scope(role)});

// Rule-based summaries and direct answers label `total_frames` as the app's
// frame count; a trace-wide population must not appear under that label.
describe('rule-generated key metrics', () => {
  const results = [display('frame_timeline_population', 697, 'global_context'), display('performance_summary', 347, 'target')];

  it('summarizes only target-scoped fields as app key metrics', () => {
    const summary = smartSummaryGenerator.generate({skillId: 'scrolling_analysis', skillName: 'Scrolling',
      displayResults: results, diagnostics: [], executionTimeMs: 1}).text;
    expect(summary).toContain('347');
    expect(summary).not.toContain('697');
    expect(summary).not.toContain('21');
  });

  it('answers with target-scoped fields only', () => {
    const sections = Object.fromEntries(results.map(result => [result.stepId, {
      title: result.title, scopeProvenance: result.scopeProvenance,
      data: result.data.rows!.map(row => Object.fromEntries(result.data.columns!.map((column, index) => [column, row[index]]))),
    }]));
    const {answer} = answerGenerator.generateAnswer({originalQuestion: '分析滑动性能', skillId: 'scrolling_analysis',
      skillName: 'Scrolling', success: true, diagnostics: [], sections, executionTimeMs: 1});
    expect(answer).toContain('总帧数: 347');
    expect(answer).not.toContain('697');
  });
});
