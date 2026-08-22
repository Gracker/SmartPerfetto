// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildComparisonAppendix,
  comparisonIdentityFromReportSection,
} from '../comparisonAppendixService';
import type { QueryResult } from '../traceProcessorService';
import type {TraceSummaryExecutionV1} from '../traceSummaryExecutor';

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, durationMs: 1 };
}

describe('comparisonAppendixService', () => {
  test('builds raw trace evidence pack with package, duration delta, top slices, thread states, and limitations', async () => {
    const calls: Array<{ traceId: string; sql: string }> = [];
    const service = {
      async queryTrace(traceId: string, sql: string): Promise<QueryResult> {
        calls.push({ traceId, sql });
        if (sql.includes('startup_id') && sql.includes('from android_startups')) {
          return traceId === 'trace-current'
            ? result(['startup_id', 'package', 'startup_type', 'dur_ms'], [[1, 'com.example.heavy', 'warm', 1339]])
            : result(['startup_id', 'package', 'startup_type', 'dur_ms'], [[2, 'com.example.light', 'cold', 302]]);
        }
        if (sql.includes('from slice')) {
          return traceId === 'trace-current'
            ? result(['name', 'total_ms', 'count'], [['ChaosTask', 456, 1]])
            : result(['name', 'total_ms', 'count'], [['ActivityThreadMain', 120, 1]]);
        }
        if (sql.includes('from thread_state')) {
          return traceId === 'trace-current'
            ? result(['state', 'dur_ms', 'pct'], [['Running', 842, 62.8]])
            : result(['state', 'dur_ms', 'pct'], [['Running', 242, 80.1]]);
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };

    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current',
      referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async (_service, traceId, side) =>
        comparisonSummary(traceId === 'trace-current' ? 20 : 10, side),
    });

    expect(appendix.evidencePack.source).toBe('raw_trace_pair');
    expect(appendix.evidencePack.metrics).toMatchObject({
      currentPackage: 'com.example.heavy',
      referencePackage: 'com.example.light',
      currentDurationMs: 1339,
      referenceDurationMs: 302,
      durationDeltaMs: 1037,
    });
    expect(appendix.evidencePack.current.topSlices[0]).toMatchObject({ name: 'ChaosTask' });
    expect(appendix.evidencePack.reference.threadStates[0]).toMatchObject({ state: 'Running' });
    expect(appendix.limitations.join('\n')).toContain('Perfetto startup_type');
    expect(appendix.markdown).toContain('| dur_ms | 1339 | 302 | +1037 |');
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'compatible', specDigestSha256: 'a'.repeat(64),
    }));
    expect(appendix.evidencePack.traceSummaryComparison?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'smartperfetto_frame_timeline_jank_count', currentValue: 20,
        referenceValue: 10, delta: 10, polarity: 'LOWER_IS_BETTER',
      }),
    ]));
    expect(appendix.markdown).toContain('smartperfetto_frame_timeline_jank_count');
    expect(new Set(calls.map(call => call.traceId))).toEqual(new Set(['trace-current', 'trace-reference']));
  });

  test('does not compute deltas across different processor identities', async () => {
    const service = {queryTrace: async () => result([], [])};
    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async (_service, traceId, side) => ({
        ...comparisonSummary(traceId === 'trace-current' ? 20 : 10, side),
        traceProcessor: {source: 'custom', binarySha256: (traceId === 'trace-current' ? 'c' : 'd').repeat(64)},
      }),
    });
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'incompatible', reason: 'trace_processor_mismatch', metrics: [],
    }));
    expect(appendix.markdown).not.toContain('| 20 | 10 | +10 |');
  });

  test('isolates summary execution failure from the legacy deterministic appendix', async () => {
    const service = {queryTrace: async () => result([], [])};
    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async () => {
        throw new Error('/private/path must not escape');
      },
    });
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'incompatible', reason: 'summary_unavailable',
    }));
    expect(appendix.limitations.join('\n')).toContain('summary_unavailable');
    expect(JSON.stringify(appendix.evidencePack)).not.toContain('/private/path');
  });

  test('extracts a complete, safe identity from a deterministic comparison report section', () => {
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
          referencePackage: 'com.example.demo',
        },
      },
    })).toEqual({
      currentPackageName: 'com.example.heavy',
      referencePackageName: 'com.example.demo',
    });
  });

  test('rejects incomplete or unsafe comparison identities', () => {
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
        },
      },
    })).toBeUndefined();
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
          referencePackage: 'com.example.demo\n## injected',
        },
      },
    })).toBeUndefined();
  });
});

function comparisonSummary(jank: number, traceSide: 'current' | 'reference'): Extract<TraceSummaryExecutionV1, {status: 'ready'}> {
  const metric = {
    id: 'smartperfetto_frame_timeline_jank_count', dimensions: [], valueColumn: 'jank_count',
    unit: 'COUNT' as const, polarity: 'LOWER_IS_BETTER' as const,
    dimensionUniqueness: 'UNIQUE' as const,
  };
  return {
    schemaVersion: 'trace_summary_execution@1', status: 'ready',
    spec: {schemaVersion: 'trace_summary_spec@1', id: 'smartperfetto.core.v1', digestSha256: 'a'.repeat(64),
      metricIds: [metric.id], metrics: [metric]},
    trace: {fingerprintSha256: (traceSide === 'current' ? '1' : '2').repeat(64),
      fingerprintKind: 'trace_bytes_sha256', traceSide},
    traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64)},
    resultDigestSha256: (traceSide === 'current' ? '3' : '4').repeat(64),
    metrics: [{...metric, status: 'available', value: jank}], durationMs: 1,
  };
}
