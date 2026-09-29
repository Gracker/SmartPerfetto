// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import { buildComparisonMatrix } from '../comparisonMatrixService';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

function snapshot(
  id: string,
  metricValues: {
    startupMs?: number;
    fps?: number;
    jankRate?: number;
    renderLatencyMs?: number;
  },
): AnalysisResultSnapshot {
  return {
    id,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: `trace-${id}`,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    createdBy: 'user-a',
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'startup',
    title: id,
    userQuery: 'analyze',
    traceLabel: id,
    traceMetadata: {},
    summary: { headline: 'ok' },
    metrics: [
      metricValues.startupMs === undefined ? undefined : {
        key: 'startup.total_ms',
        label: 'Startup total duration',
        group: 'startup',
        value: metricValues.startupMs,
        unit: 'ms',
        direction: 'lower_is_better',
        aggregation: 'single',
        confidence: 0.9,
        source: { type: 'skill', dataEnvelopeId: `env-${id}-startup` },
      },
      metricValues.fps === undefined ? undefined : {
        key: 'scrolling.avg_fps',
        label: 'Average FPS',
        group: 'fps',
        value: metricValues.fps,
        unit: 'fps',
        direction: 'higher_is_better',
        aggregation: 'avg',
        confidence: 0.8,
        source: { type: 'skill', dataEnvelopeId: `env-${id}-fps` },
      },
      metricValues.jankRate === undefined ? undefined : {
        key: 'scrolling.jank_rate_pct',
        label: 'Jank rate',
        group: 'jank',
        value: metricValues.jankRate,
        unit: '%',
        direction: 'lower_is_better',
        aggregation: 'avg',
        confidence: 0.8,
        source: { type: 'skill', dataEnvelopeId: `env-${id}-jank` },
      },
      metricValues.renderLatencyMs === undefined ? undefined : {
        key: 'custom.render_latency_ms',
        label: 'Render latency',
        group: 'custom',
        value: metricValues.renderLatencyMs,
        unit: 'ms',
        direction: 'lower_is_better',
        aggregation: 'avg',
        confidence: 0.75,
        source: { type: 'manual', dataEnvelopeId: `env-${id}-render-latency` },
      },
    ].filter(Boolean) as AnalysisResultSnapshot['metrics'],
    evidenceRefs: [],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
  };
}

describe('buildComparisonMatrix', () => {
  test('builds rows and deltas for startup/fps/jank metrics', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { startupMs: 1200, fps: 55, jankRate: 8 }),
        snapshot('candidate', { startupMs: 900, fps: 60, jankRate: 3 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: [
          'startup.total_ms',
          'scrolling.avg_fps',
          'scrolling.jank_rate_pct',
        ],
      },
    );

    expect(matrix.baselineSnapshotId).toBe('baseline');
    expect(matrix.rows.map(row => row.metricKey)).toEqual([
      'startup.total_ms',
      'scrolling.avg_fps',
      'scrolling.jank_rate_pct',
    ]);

    const startup = matrix.rows.find(row => row.metricKey === 'startup.total_ms')!;
    expect(startup.baseline?.numericValue).toBe(1200);
    expect(startup.deltas[0]).toMatchObject({
      snapshotId: 'candidate',
      deltaValue: -300,
      deltaPct: -25,
      assessment: 'better',
    });

    const fps = matrix.rows.find(row => row.metricKey === 'scrolling.avg_fps')!;
    expect(fps.deltas[0]).toMatchObject({
      deltaValue: 5,
      assessment: 'better',
    });

    const jank = matrix.rows.find(row => row.metricKey === 'scrolling.jank_rate_pct')!;
    expect(jank.deltas[0]).toMatchObject({
      deltaValue: -5,
      assessment: 'better',
    });
    expect(matrix.groups).toEqual([
      expect.objectContaining({
        group: 'startup',
        rowMetricKeys: ['startup.total_ms'],
        rowCount: 1,
        significantChangeCount: 1,
      }),
      expect.objectContaining({
        group: 'fps',
        rowMetricKeys: ['scrolling.avg_fps'],
        rowCount: 1,
        significantChangeCount: 1,
      }),
      expect.objectContaining({
        group: 'jank',
        rowMetricKeys: ['scrolling.jank_rate_pct'],
        rowCount: 1,
        significantChangeCount: 1,
      }),
    ]);
    expect(matrix.evidenceRefs.map(ref => ref.type)).toContain('snapshot_metric');
  });

  test('does not count tiny metric noise as significant group changes', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { startupMs: 1200, fps: 55, jankRate: 8 }),
        snapshot('candidate', { startupMs: 1199, fps: 55.2, jankRate: 7.7 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: [
          'startup.total_ms',
          'scrolling.avg_fps',
          'scrolling.jank_rate_pct',
        ],
      },
    );

    expect(matrix.rows.map(row => row.deltas[0].assessment)).toEqual([
      'better',
      'better',
      'better',
    ]);
    expect(matrix.groups.map(group => group.significantChangeCount)).toEqual([
      0,
      0,
      0,
    ]);
  });

  test('records missing metrics without dropping comparable rows', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { startupMs: 1200, fps: 55 }),
        snapshot('candidate', { startupMs: 1000 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['startup.total_ms', 'scrolling.avg_fps'],
      },
    );

    const fps = matrix.rows.find(row => row.metricKey === 'scrolling.avg_fps')!;
    expect(fps.missingSnapshotIds).toEqual(['candidate']);
    expect(matrix.missingMatrix.candidate['scrolling.avg_fps']).toBe('metric_not_found');
    expect(fps.deltas[0]).toMatchObject({
      deltaValue: null,
      assessment: 'unknown',
    });
  });

  test('builds deltas for more than two snapshots', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { startupMs: 1200 }),
        snapshot('candidate-fast', { startupMs: 900 }),
        snapshot('candidate-slow', { startupMs: 1500 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['startup.total_ms'],
      },
    );

    const startup = matrix.rows[0];
    expect(matrix.inputSnapshots.map(item => item.snapshotId)).toEqual([
      'baseline',
      'candidate-fast',
      'candidate-slow',
    ]);
    expect(startup.deltas).toHaveLength(2);
    expect(startup.deltas[0]).toMatchObject({
      snapshotId: 'candidate-fast',
      deltaValue: -300,
      deltaPct: -25,
      assessment: 'better',
    });
    expect(startup.deltas[1]).toMatchObject({
      snapshotId: 'candidate-slow',
      deltaValue: 300,
      deltaPct: 25,
      assessment: 'worse',
    });
  });

  test('supports requested custom metric keys from snapshots', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { renderLatencyMs: 18 }),
        snapshot('candidate', { renderLatencyMs: 27 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['custom.render_latency_ms'],
      },
    );

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]).toMatchObject({
      metricKey: 'custom.render_latency_ms',
      label: 'Render latency',
      group: 'custom',
      unit: 'ms',
      direction: 'lower_is_better',
    });
    expect(matrix.rows[0].deltas[0]).toMatchObject({
      deltaValue: 9,
      deltaPct: 50,
      assessment: 'worse',
    });
  });

  test('marks absent requested custom metric keys separately from standard keys', () => {
    const matrix = buildComparisonMatrix(
      [
        snapshot('baseline', { startupMs: 1200 }),
        snapshot('candidate', { startupMs: 900 }),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['custom.render_latency_ms'],
      },
    );

    expect(matrix.rows[0].metricKey).toBe('custom.render_latency_ms');
    expect(matrix.rows[0].group).toBe('custom');
    expect(matrix.rows[0].missingSnapshotIds).toEqual(['baseline', 'candidate']);
    expect(matrix.missingMatrix.baseline['custom.render_latency_ms']).toBe('custom_metric_not_found');
    expect(matrix.missingMatrix.candidate['custom.render_latency_ms']).toBe('custom_metric_not_found');
    expect(matrix.warnings).toContain('Baseline is missing metric custom.render_latency_ms');
  });

  test('rejects invalid baseline input', () => {
    expect(() =>
      buildComparisonMatrix(
        [
          snapshot('a', { startupMs: 1 }),
          snapshot('b', { startupMs: 2 }),
        ],
        { baselineSnapshotId: 'missing' },
      ),
    ).toThrow('Baseline snapshot is not part of comparison input');
  });
});


test('retains source-run investigation coverage during saved-result comparison without backfill', () => {
  const baseline = snapshot('system-baseline', {startupMs: 1200});
  const candidate = snapshot('system-candidate', {startupMs: 900});
  const hash = analysisDeliveryFingerprint;
  baseline.summary.conclusion = 'A scoped task observation.';
  baseline.summary.investigationAssessment = {schemaVersion: 1, status: 'checked',
    binding: {candidateRef: 'candidate', runId: 'run', attemptId: 'attempt', conclusionFingerprint: hash(baseline.summary.conclusion),
      conclusionContractFingerprint: hash(undefined), evidenceFingerprint: hash([]), requirementsFingerprint: hash([]),
      registryFingerprint: 'registry', intentFingerprint: hash(undefined), ledgerFingerprint: hash('ledger'), evidenceRecordsFingerprint: hash([])},
    requirements: [], evidenceRecords: []};
  baseline.summary.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
    claims: 'not_checked', source: 'not_applicable', identity: 'not_checked', report: 'not_applicable',
    investigation: 'passed', investigationEvidence: 'coverage_incomplete'};
  const matrix = buildComparisonMatrix([baseline, candidate]);
  expect(matrix.inputSnapshots[0].investigationAssessment).toEqual(baseline.summary.investigationAssessment);
  expect(matrix.inputSnapshots[0].investigationAssurance).toEqual({investigation: 'passed', investigationEvidence: 'coverage_incomplete'});
  expect(matrix.inputSnapshots[1].investigationAssessment).toBeUndefined();
  expect(matrix.inputSnapshots[1].investigationAssurance).toBeUndefined();
  expect(candidate.summary).toEqual({headline: 'ok'});
});
