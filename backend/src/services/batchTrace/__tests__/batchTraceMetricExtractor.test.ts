// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { DataEnvelope } from '../../../types/dataContract';
import type { SkillExecutionResult } from '../../skillEngine/types';
import { extractBatchTraceMetrics, toPromotableNormalizedMetrics } from '../batchTraceMetricExtractor';

function baseResult(): SkillExecutionResult {
  return {
    skillId: 'startup_analysis',
    skillName: 'Startup',
    success: true,
    displayResults: [],
    diagnostics: [],
    synthesizeData: [{
      stepId: 'overview',
      stepType: 'atomic',
      data: { total_ms: 123.4, custom_score: 7 },
      success: true,
      config: { role: 'overview' },
    }],
    executionTimeMs: 12,
  };
}

function envelope(): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'startup_analysis',
      timestamp: 1,
      skillId: 'startup_analysis',
      stepId: 'overview_table',
      evidenceRefId: 'ev-1',
    },
    data: {
      columns: ['first_frame_ms', 'device_model', 'ignored_text'],
      rows: [[88, 'Pixel 9', 'not-promotable']],
    },
    display: {
      layer: 'overview',
      format: 'table',
      title: 'Overview',
      level: 'key',
      columns: [
        { name: 'first_frame_ms', type: 'duration', label: 'First frame', unit: 'ms' },
        { name: 'device_model', type: 'string', label: 'Device' },
        { name: 'ignored_text', type: 'string', label: 'Ignored' },
      ],
    },
  };
}

describe('batch trace metric extractor', () => {
  it('promotes only observed standard metrics and keeps local numeric metrics local', () => {
    const metrics = extractBatchTraceMetrics({
      skillId: 'startup_analysis',
      ordinal: 0,
      result: baseResult(),
      dataEnvelopes: [envelope()],
    });

    expect(metrics.map(metric => metric.key)).toEqual([
      'startup.total_ms',
      'overview.custom_score',
      'startup.first_frame_ms',
      'trace.device_model',
    ]);
    expect(metrics.find(metric => metric.key === 'overview.custom_score')?.promotableMetricKey).toBeUndefined();
    expect(metrics.find(metric => metric.key === 'trace.device_model')?.value).toBe('Pixel 9');
  });

  it('keeps trace-wide fields local instead of promoting them to app metrics', () => {
    const traceWide: DataEnvelope = {
      ...envelope(),
      meta: {...envelope().meta, source: 'scrolling_analysis', skillId: 'scrolling_analysis', stepId: 'frame_timeline_population',
        scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'global_context',
          scope: {mode: 'unscoped', traceId: 'trace-a', traceSide: 'current'}}]}},
      data: {columns: ['total_frames', 'device_model'], rows: [[697, 'Pixel 9']]},
    };
    const metrics = extractBatchTraceMetrics({skillId: 'scrolling_analysis', ordinal: 0,
      result: {...baseResult(), synthesizeData: []}, dataEnvelopes: [traceWide]});

    const frames = metrics.find(metric => metric.value === 697);
    expect(frames?.key).toBe('frame_timeline_population.total_frames');
    expect(frames?.promotableMetricKey).toBeUndefined();
    expect(metrics.find(metric => metric.key === 'trace.device_model')?.value).toBe('Pixel 9');
  });

  it('converts promotable batch metrics to normalized comparison metrics', () => {
    const metrics = toPromotableNormalizedMetrics(extractBatchTraceMetrics({
      skillId: 'startup_analysis',
      ordinal: 0,
      result: baseResult(),
      dataEnvelopes: [envelope()],
    }));

    expect(metrics.map(metric => metric.key)).toEqual([
      'startup.total_ms',
      'startup.first_frame_ms',
      'trace.device_model',
    ]);
    expect(metrics[0]).toMatchObject({
      group: 'startup',
      unit: 'ms',
      confidence: 1,
      source: { type: 'skill', skillId: 'startup_analysis' },
    });
  });

  it('promotes real startup event duration columns with startup context', () => {
    const startupEventEnvelope: DataEnvelope = {
      ...envelope(),
      meta: {
        ...envelope().meta,
        source: 'startup_analysis',
        stepId: 'get_startups',
        evidenceRefId: 'ev-startup',
      },
      data: {
        columns: ['dur_ms', 'ttid_ms'],
        rows: [[451.2, 93.5]],
      },
      display: {
        ...envelope().display,
        title: 'Startup events',
        columns: [
          { name: 'dur_ms', type: 'duration', label: 'Duration', unit: 'ms' },
          { name: 'ttid_ms', type: 'duration', label: 'Time to initial display', unit: 'ms' },
        ],
      },
    };

    const metrics = extractBatchTraceMetrics({
      skillId: 'startup_analysis',
      ordinal: 0,
      result: {
        ...baseResult(),
        synthesizeData: [],
      },
      dataEnvelopes: [startupEventEnvelope],
    });

    expect(metrics.map(metric => metric.key)).toEqual([
      'startup.total_ms',
      'startup.first_frame_ms',
    ]);
    expect(metrics.map(metric => metric.promotableMetricKey)).toEqual([
      'startup.total_ms',
      'startup.first_frame_ms',
    ]);
  });
});
