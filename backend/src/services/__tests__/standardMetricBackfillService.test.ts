// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import { backfillStandardMetrics } from '../standardMetricBackfillService';
import type { QueryResult } from '../traceProcessorService';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

function snapshot(): AnalysisResultSnapshot {
  return {
    id: 'snapshot-a',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    runId: 'run-a',
    createdBy: 'user-a',
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'startup',
    title: 'snapshot-a',
    userQuery: 'analyze',
    traceLabel: 'trace-a',
    traceMetadata: {},
    summary: { headline: 'ok' },
    metrics: [],
    evidenceRefs: [],
    status: 'partial',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
  };
}

function result(columns: string[], row: unknown[]): QueryResult {
  return {
    columns,
    rows: [row],
    durationMs: 1,
  };
}

describe('backfillStandardMetrics', () => {
  test('extracts startup and scrolling standard metrics from trace processor SQL', async () => {
    const queries: string[] = [];
    const backfill = await backfillStandardMetrics({
      snapshot: snapshot(),
      metricKeys: [
        'startup.total_ms',
        'scrolling.avg_fps',
        'scrolling.jank_count',
        'scrolling.jank_rate_pct',
      ],
      traceProcessor: {
        async query(_traceId, sql) {
          queries.push(sql);
          if (sql.includes('android_startups')) {
            return result(['startup_total_ms'], [1234.5]);
          }
          return result(
            ['frame_count', 'jank_count', 'avg_fps', 'jank_rate_pct'],
            [120, 6, 58.8, 5],
          );
        },
      },
    });

    expect(queries).toHaveLength(2);
    expect(backfill.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'startup.total_ms', value: 1234.5, source: expect.objectContaining({ type: 'backfill' }) }),
      expect.objectContaining({ key: 'scrolling.avg_fps', value: 58.8, source: expect.objectContaining({ type: 'backfill' }) }),
      expect.objectContaining({ key: 'scrolling.jank_count', value: 6, source: expect.objectContaining({ type: 'backfill' }) }),
      expect.objectContaining({ key: 'scrolling.jank_rate_pct', value: 5, source: expect.objectContaining({ type: 'backfill' }) }),
    ]));
    expect(backfill.snapshot.metrics).toHaveLength(4);
    expect(backfill.evidenceRefs[0]).toMatchObject({
      type: 'trace_backfill',
      snapshotId: 'snapshot-a',
    });
  });

  test('returns missing reasons for unsupported metric keys', async () => {
    const backfill = await backfillStandardMetrics({
      snapshot: snapshot(),
      metricKeys: ['cpu.avg_freq_mhz'],
      traceProcessor: {
        async query() {
          throw new Error('should not query unsupported metrics');
        },
      },
    });

    expect(backfill.metrics).toHaveLength(0);
    expect(backfill.missingReasons['cpu.avg_freq_mhz']).toBe('metric_backfill_not_supported');
  });
});
