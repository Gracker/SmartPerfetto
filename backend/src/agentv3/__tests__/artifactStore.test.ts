// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {sanitizeQueryReview} from '../../types/queryReviewContract';
import {ArtifactStore} from '../artifactStore';

describe('ArtifactStore', () => {
  it('exposes pane-aware trace provenance in summaries and fetch results', () => {
    const store = new ArtifactStore();
    const traceProvenance = buildTraceProcessorQueryProvenance({
      traceId: 'trace-reference',
      traceSide: 'reference',
      paneSide: 'right',
    });
    const artifactId = store.store({
      skillId: 'startup_summary',
      stepId: 'duration',
      title: 'Startup duration',
      data: {
        columns: ['dur_ms'],
        rows: [[1234]],
      },
      traceProvenance,
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });

    expect(store.generateSummary(artifactId)).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.generateCompactSummary(artifactId)).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.fetch(artifactId, 'rows')).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
    expect(store.fetch(artifactId, 'full')).toMatchObject({
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-reference',
      executionStatus: 'optional_error',
      executionError: 'optional query failed',
    });
  });

  it('adds bounded aggregates only to explicit summary fetches', () => {
    const store = new ArtifactStore();
    const longPrefix = 'x'.repeat(90);
    const artifactId = store.store({
      skillId: 'generic_table',
      data: {
        columns: ['frame_id', 'category', 'duration_ms', 'note', 'structured_detail'],
        rows: [
          [1, 'render_sync_wait', 20, null, '[]'],
          [2, 'render_sync_wait', 30, `${longPrefix}-alpha`, '[{"name":"GC"}]'],
          [3, 'workload_heavy', 10, 'short-note', '[]'],
          [4, 'render_sync_wait', 40, 'short-note', '[]'],
        ],
      },
    });

    expect(store.generateSummary(artifactId)).not.toHaveProperty('aggregate');
    expect(store.generateCompactSummary(artifactId)).not.toHaveProperty('aggregate');

    const fetched = store.fetch(artifactId, 'summary');
    expect(fetched).not.toHaveProperty('rows');
    expect(fetched.aggregate).toMatchObject({
      analyzedRowCount: 4,
      totalRowCount: 4,
      complete: true,
      scannedColumnCount: 5,
      omittedColumnCount: 1,
    });

    const category = fetched.aggregate.columns.find((column: any) => column.column === 'category');
    expect(category).toMatchObject({
      observedType: 'string',
      nonNullCount: 4,
      nullCount: 0,
      distinctCount: 2,
      topValues: [
        {value: 'render_sync_wait', count: 3, shareOfNonNull: 0.75},
        {value: 'workload_heavy', count: 1, shareOfNonNull: 0.25},
      ],
      otherCount: 0,
    });

    const duration = fetched.aggregate.columns.find((column: any) => column.column === 'duration_ms');
    expect(duration.numeric).toEqual({min: 10, max: 40, mean: 25});

    const note = fetched.aggregate.columns.find((column: any) => column.column === 'note');
    expect(note.topValues[0]).toMatchObject({value: 'short-note', count: 2});
    expect(note.topValues[0].shareOfNonNull).toBeCloseTo(2 / 3, 10);
    const truncatedValue = note.topValues.find((value: any) => value.valueTruncated === true);
    expect(truncatedValue.value).toHaveLength(ArtifactStore.MAX_AGGREGATE_VALUE_CHARS);
    expect(fetched.aggregate.columns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({column: 'structured_detail'}),
    ]));
  });

  it('marks deterministic large-table aggregates as sampled and bounded', () => {
    const store = new ArtifactStore();
    const rows = Array.from({length: ArtifactStore.MAX_AGGREGATE_ROWS + 1}, (_, index) => [
      index % 3,
      index,
    ]);
    const artifactId = store.store({
      skillId: 'large_table',
      data: {columns: ['bucket', 'value'], rows},
    });

    const fetched = store.fetch(artifactId, 'summary');
    expect(fetched.aggregate).toMatchObject({
      analyzedRowCount: ArtifactStore.MAX_AGGREGATE_ROWS,
      totalRowCount: ArtifactStore.MAX_AGGREGATE_ROWS + 1,
      complete: false,
      scannedColumnCount: 2,
      omittedColumnCount: 0,
    });
    expect(fetched.aggregate.columns).toHaveLength(2);
    expect(fetched.aggregate.columns.find((column: any) => column.column === 'value').numeric)
      .toMatchObject({min: 0, max: ArtifactStore.MAX_AGGREGATE_ROWS});
  });

  it('caps aggregate columns and top values independently of table width', () => {
    const store = new ArtifactStore();
    const columnCount = ArtifactStore.MAX_AGGREGATE_COLUMNS_SCANNED + 6;
    const columns = Array.from({length: columnCount}, (_, index) => `column_${index}`);
    const rows = Array.from({length: 100}, (_, rowIndex) => columns.map(
      (_, columnIndex) => `group-${columnIndex}-${rowIndex % 7}`,
    ));
    const artifactId = store.store({
      skillId: 'wide_table',
      data: {columns, rows},
    });

    const fetched = store.fetch(artifactId, 'summary');
    expect(fetched.aggregate.scannedColumnCount).toBe(ArtifactStore.MAX_AGGREGATE_COLUMNS_SCANNED);
    expect(fetched.aggregate.columns.length).toBeLessThanOrEqual(
      ArtifactStore.MAX_RETURNED_AGGREGATE_COLUMNS,
    );
    expect(fetched.aggregate.columns.every(
      (column: any) => column.topValues.length <= ArtifactStore.MAX_TOP_AGGREGATE_VALUES,
    )).toBe(true);
    expect(fetched.aggregate.omittedColumnCount).toBe(
      columnCount - fetched.aggregate.columns.length,
    );
  });

  it('projects a bounded query review ref while preserving full review data', () => {
    const store = new ArtifactStore();
    const queryReview = sanitizeQueryReview({
      schemaVersion: 1,
      id: 'qr:worst-case',
      producer: {kind: 'invoke_skill'},
      title: 'Worst-case review',
      purpose: 'Explain the evidence boundary without replaying every review detail.',
      source: {
        skillId: 'scrolling_analysis',
        stepId: 'batch_frame_root_cause',
        artifactId: 'art-source',
        evidenceRefId: 'data:skill:scrolling_analysis:batch_frame_root_cause:current:test',
      },
      reads: Array.from({length: 16}, (_, index) => ({
        table: `table_${index}`,
        columns: Array.from({length: 24}, (__, column) => `column_${column}`),
        confidence: 'declared',
      })),
      filters: Array.from({length: 12}, (_, index) => ({
        expression: `filter_${index} = ${index}`,
        confidence: 'observed',
      })),
      outputShape: Array.from({length: 32}, (_, index) => ({
        name: `output_${index}`,
        type: 'string',
        required: true,
      })),
      guardrails: Array.from({length: 16}, (_, index) => ({
        ruleId: `rule_${index}`,
        message: `Guardrail ${index} with detailed review-only guidance.`,
        severity: 'warning',
      })),
      limitations: Array.from({length: 12}, (_, index) => (
        `Limitation ${index}: ${'bounded review detail '.repeat(20)}`
      )),
      observedExecution: {
        executed: true,
        executableSql: `SELECT ${'column, '.repeat(300)} 1`,
        durationMs: 42,
        rowCount: 147,
        truncated: false,
      },
      allowedUse: 'review_metadata_only',
    });
    expect(queryReview).toBeDefined();
    const artifactId = store.store({
      skillId: 'scrolling_analysis',
      stepId: 'batch_frame_root_cause',
      data: {columns: ['reason'], rows: [['render_thread_heavy']]},
      queryReview,
    });

    const compact = store.generateCompactSummary(artifactId)!;
    const summary = store.fetch(artifactId, 'summary');
    const rows = store.fetch(artifactId, 'rows');
    const full = store.fetch(artifactId, 'full');

    for (const projected of [compact.queryReview, summary.queryReview, rows.queryReview]) {
      expect(projected).toMatchObject({
        id: 'qr:worst-case',
        observedExecution: {executed: true, durationMs: 42, rowCount: 147, truncated: false},
        counts: {reads: 16, filters: 12, outputShape: 32, guardrails: 16, limitations: 12},
        allowedUse: 'review_metadata_only',
      });
      expect(projected).not.toHaveProperty('reads');
      expect(projected).not.toHaveProperty('filters');
      expect(projected).not.toHaveProperty('outputShape');
      expect(projected).not.toHaveProperty('guardrails');
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1_500);
    }
    expect(compact.queryReview?.limitations).toHaveLength(2);
    expect(full.queryReview.reads).toHaveLength(16);
    expect(full.queryReview.filters).toHaveLength(12);
    expect(full.queryReview.outputShape).toHaveLength(32);
    expect(full.queryReview.guardrails).toHaveLength(16);
    expect(full.queryReview.limitations).toHaveLength(12);
    expect(full.queryReview.observedExecution.executableSql).toContain('SELECT');
  });
});
