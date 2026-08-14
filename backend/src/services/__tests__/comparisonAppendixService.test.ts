// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildComparisonAppendix,
  comparisonIdentityFromReportSection,
} from '../comparisonAppendixService';
import type { QueryResult } from '../traceProcessorService';

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
    expect(new Set(calls.map(call => call.traceId))).toEqual(new Set(['trace-current', 'trace-reference']));
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
