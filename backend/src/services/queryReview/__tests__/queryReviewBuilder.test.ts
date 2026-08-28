// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {buildSqlQueryReview} from '../queryReviewBuilder';

describe('queryReviewBuilder', () => {
  it('builds SQL reviews with provenance, guardrails, and bounded use', () => {
    const review = buildSqlQueryReview({
      producerKind: 'execute_sql_on',
      executableSql: `
        SELECT SUM(dur) AS total_dur
        FROM thread_state
        WHERE ts BETWEEN \${start_ts} AND \${end_ts}
      `,
      outputColumns: [{name: 'total_dur', type: 'duration'}],
      traceProvenance: buildTraceProcessorQueryProvenance({
        traceId: 'trace-reference',
        traceSide: 'reference',
        paneSide: 'right',
      }),
      producer: {
        sourceToolCallId: 'execute_sql_on:1',
        paramsHash: 'params:1',
        planPhaseId: 'phase-1',
      },
      evidenceRefId: 'data:sql:1',
      queryHash: 'hash-1',
      artifactId: 'art-1',
      durationMs: 12,
      rowCount: 1,
      sqlRewrites: ['normalized main-thread column'],
      stdlibInjectedModules: ['android.frames'],
    });

    expect(review?.producer.kind).toBe('execute_sql_on');
    expect(review?.producer.traceSide).toBe('reference');
    expect(review?.producer.paneSide).toBe('right');
    expect(review?.source.artifactId).toBe('art-1');
    expect(review?.reads.map(read => read.table)).toContain('thread_state');
    expect(review?.guardrails.map(item => item.ruleId)).toEqual(expect.arrayContaining([
      'safe-duration-boundary',
      'overlap-range-filter',
    ]));
    expect(review?.allowedUse).toBe('review_metadata_only');
  });

  it('describes the observed tables, filters, and output columns instead of repeating a generic purpose', () => {
    const review = buildSqlQueryReview({
      producerKind: 'execute_sql',
      executableSql: 'SELECT slice.name, slice.dur AS dur_ms FROM slice JOIN thread_track USING (utid) WHERE slice.dur > 1000000',
      outputColumns: ['name', {name: 'dur_ms', type: 'duration'}],
      producer: {
        producerReason: '执行当前 Trace SQL，验证本阶段的具体数据点。',
      },
      outputLanguage: 'zh-CN',
    });

    expect(review?.title).toBe('已执行 SQL review');
    expect(review?.purpose).toContain('slice');
    expect(review?.purpose).toContain('thread_track');
    expect(review?.purpose).toContain('slice.dur > 1000000');
    expect(review?.purpose).toContain('name');
    expect(review?.purpose).toContain('dur_ms');
    expect(review?.purpose).not.toContain('验证本阶段的具体数据点');
    expect(review?.limitations.join('\n')).toContain('SQL 包含 JOIN');
  });

  it('uses language-appropriate punctuation for English query purposes', () => {
    const review = buildSqlQueryReview({
      producerKind: 'execute_sql',
      executableSql: 'SELECT name FROM slice WHERE dur > 1000000',
      outputColumns: ['name'],
      outputLanguage: 'en',
    });

    expect(review?.purpose).toContain('Queries slice; filters by dur > 1000000; returns name.');
    expect(review?.purpose).not.toContain('；');
  });
});
