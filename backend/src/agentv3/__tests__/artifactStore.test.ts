// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {sanitizeQueryReview} from '../../types/queryReviewContract';
import {ArtifactStore, EVIDENCE_RETENTION_CELLS_ENV, RETAINED_EVIDENCE_CAPTURE_CEILING} from '../artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {MAX_EVIDENCE_READ_REFERENCES} from '../../services/evidence/evidenceReadView';
import type {EvidenceScopeProvenanceV1} from '../../types/identityContract';

describe('ArtifactStore evidence retention', () => {
  const storeCaptured = (store: ArtifactStore, index: number, rowCount = 1, columnCount = 1) => {
    const columns = Array.from({length: columnCount}, (_, column) => `col${column}`);
    const rows = Array.from({length: rowCount}, (_, row) => columns.map((_column, column) => row + column));
    const id = store.store({skillId: 'execute_sql', title: `query ${index}`,
      sourceToolCallId: `execute_sql:${index}:hash`,
      data: {columns, rows},
      traceProvenance: {traceId: 'trace', traceSide: 'current'} as never});
    store.registerEvidenceCapture(id, captureEvidenceTable({columns, rows}),
      {evidenceRefId: `data:sql_table:current:${index}`});
    return id;
  };
  const readView = (store: ArtifactStore) => store.createEvidenceReadView({
    ownerKey: 'owner', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]});

  it('answers a citation to the first evidence of a long run', async () => {
    // A real run produced 55 artifacts against a 50-entry payload cache; its
    // conclusion cited art-2 and art-4, which the cache had already dropped, so
    // the verifier reported those claims as unsupported. Witness retention is a
    // separate budget from the payload cache and must survive that eviction.
    const store = new ArtifactStore();
    const first = storeCaptured(store, 1);
    for (let index = 2; index <= 80; index += 1) storeCaptured(store, index);

    expect(store.get(first)).toBeUndefined();
    const [resolved] = await readView(store).resolveReferences([
      {key: 'k', reference: {artifactId: first}, requiredColumns: []}]);
    expect(resolved).toMatchObject({status: 'resolved'});
  });

  it('retains at least what one conclusion may cite', () => {
    // The read view lets a single conclusion resolve MAX_EVIDENCE_READ_REFERENCES
    // references. A ledger below that floor guarantees unanswerable citations
    // no matter how the ceiling is tuned.
    expect(RETAINED_EVIDENCE_CAPTURE_CEILING).toBeGreaterThanOrEqual(MAX_EVIDENCE_READ_REFERENCES);
  });

  it('evicts the oldest witness once the capture ceiling is passed', async () => {
    const store = new ArtifactStore();
    const first = storeCaptured(store, 1);
    for (let index = 2; index <= RETAINED_EVIDENCE_CAPTURE_CEILING + 1; index += 1) storeCaptured(store, index);
    const [resolved] = await readView(store).resolveReferences([
      {key: 'k', reference: {artifactId: first}, requiredColumns: []}]);
    expect(resolved).toMatchObject({status: 'missing'});
  });

  it('accounts for width, so wide captures evict sooner than narrow ones', async () => {
    // 300 cells of budget: three 10-cell captures fit, one 200-cell capture of
    // the same row count does not. A row-based bound would not tell them apart.
    process.env[EVIDENCE_RETENTION_CELLS_ENV] = '300';
    try {
      const narrow = new ArtifactStore();
      const firstNarrow = storeCaptured(narrow, 1, 10, 1);
      storeCaptured(narrow, 2, 10, 1);
      expect((await readView(narrow).resolveReferences([
        {key: 'k', reference: {artifactId: firstNarrow}, requiredColumns: []}]))[0])
        .toMatchObject({status: 'resolved'});

      const wide = new ArtifactStore();
      const firstWide = storeCaptured(wide, 1, 10, 20);
      storeCaptured(wide, 2, 10, 20);
      expect((await readView(wide).resolveReferences([
        {key: 'k', reference: {artifactId: firstWide}, requiredColumns: []}]))[0])
        .toMatchObject({status: 'missing'});
    } finally {
      delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
    }
  });

  it('drops model units with the retained witness while keeping newer live units', () => {
    process.env[EVIDENCE_RETENTION_CELLS_ENV] = '2';
    try {
      const store = new ArtifactStore();
      const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'retention-v1', skillId: 'fixture'};
      const first = store.store({skillId: 'fixture', data: {columns: ['ttid_ms'], rows: [[10]]}});
      store.registerEvidenceCapture(first, captureEvidenceTable({columns: ['ttid_ms'], rows: [[10]]}, {
        ttid_ms: {origin, unit: 'ms'},
      }), {evidenceRefId: 'first'});
      const second = store.store({skillId: 'fixture', data: {columns: ['busy_pct'], rows: [[68], [72]]}});
      store.registerEvidenceCapture(second, captureEvidenceTable({columns: ['busy_pct'], rows: [[68], [72]]}, {
        busy_pct: {origin, unit: '%'},
      }), {evidenceRefId: 'second'});

      expect(store.fetch(first, 'summary')).not.toHaveProperty('columnUnits');
      expect(store.fetch(second, 'summary')).toMatchObject({columnUnits: {busy_pct: '%'}});
    } finally {
      delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
    }
  });
});

describe('ArtifactStore', () => {
  it('projects live producer units on every fetch surface without persisting them', () => {
    const store = new ArtifactStore();
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'artifact-v1', skillId: 'fixture'};
    const id = store.store({skillId: 'fixture', data: {
      columns: ['ttid_ms', 'busy_pct', 'ambiguous_pct'], rows: [[1912.2, 68.1, 0.3]],
    }});
    store.registerEvidenceCapture(id, captureEvidenceTable({
      columns: ['ttid_ms', 'busy_pct', 'ambiguous_pct'], rows: [[1912.2, 68.1, 0.3]],
    }, {ttid_ms: {origin, unit: 'ms'}, busy_pct: {origin, unit: '%'}}), {evidenceRefId: 'units'});

    for (const projection of [store.generateSummary(id), store.generateCompactSummary(id),
      store.fetch(id, 'summary'), store.fetch(id, 'rows'), store.fetch(id, 'full')]) {
      expect(projection).toMatchObject({columnUnits: {ttid_ms: 'ms', busy_pct: '%'}});
      expect(projection.columnUnits).not.toHaveProperty('ambiguous_pct');
    }
    const snapshot = JSON.parse(JSON.stringify(store.serialize()));
    expect(JSON.stringify(snapshot)).not.toContain('columnUnits');
    const restored = ArtifactStore.fromSnapshot(snapshot);
    for (const projection of [restored.generateSummary(id), restored.generateCompactSummary(id),
      restored.fetch(id, 'summary'), restored.fetch(id, 'rows'), restored.fetch(id, 'full')]) {
      expect(projection).not.toHaveProperty('columnUnits');
    }
    store.get(id)!.data.rows[0][0] = 999;
    expect(store.fetch(id, 'summary')).not.toHaveProperty('columnUnits');
  });

  it('bounds model projection metadata across summaries, fetches and snapshots', () => {
    const store = new ArtifactStore();
    const modelProjection = {status: 'truncated' as const, truncatedCellCount: 35,
      truncatedCells: Array.from({length: 32}, (_, rowIndex) => ({rowIndex, column: 'detail', originalBytes: 5000})),
      truncatedCellsOmitted: 3};
    const id = store.store({skillId: 'bounded', data: {columns: ['detail'], rows: [['bounded']]}, modelProjection});
    const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
    for (const projection of [restored.generateSummary(id), restored.generateCompactSummary(id),
      restored.fetch(id, 'summary'), restored.fetch(id, 'rows'), restored.fetch(id, 'full')]) {
      expect(projection.modelProjection).toEqual(modelProjection);
      expect(projection.modelProjection.truncatedCells).toHaveLength(32);
    }
  });

  it.each([
    {fields: 'metric'}, {fields: ['metric', 7]}, {availability: 'maybe'}, {relativeTo: null},
  ])('preserves invalid scope through store, snapshot and every fetch surface: %j', malformedFields => {
    const scope = {mode: 'exact_upid' as const, traceId: 'trace', traceSide: 'current' as const, upid: 42};
    const malformed = {version: 'process_scope_evidence@1', entries: [
      {role: 'global_context', scope: {mode: 'unscoped', traceId: 'trace', traceSide: 'current'}, fields: ['device_metric']},
      {role: 'target', scope, ...malformedFields},
    ]} as unknown as EvidenceScopeProvenanceV1;
    const store = new ArtifactStore();
    const id = store.store({skillId: 'invalid_scope', data: {columns: ['metric', 'device_metric'], rows: [[1, 4]]},
      scopeProvenance: malformed, ...{appliedProcessScope: scope, evidenceRole: 'target'}});
    const invalid = {version: 'process_scope_evidence@1', entries: [], invalid: true};
    expect(store.serialize()[0].scopeProvenance).toEqual(invalid);
    expect(store.serialize()[0].appliedProcessScope).toBeUndefined();
    const snapshot = JSON.parse(JSON.stringify(store.serialize()));
    // Also exercise a malformed persisted record that predates strict copying.
    snapshot[0].scopeProvenance = malformed;
    snapshot[0].appliedProcessScope = scope;
    snapshot[0].evidenceRole = 'target';
    const restored = ArtifactStore.fromSnapshot(snapshot);
    for (const candidate of [store, restored, ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(restored.serialize())))]) {
      for (const projection of [candidate.generateSummary(id), candidate.generateCompactSummary(id),
        candidate.fetch(id, 'rows'), candidate.fetch(id, 'full')]) {
        expect(projection.scopeProvenance).toEqual(invalid);
        expect(projection.appliedProcessScope).toBeUndefined();
        expect(projection.evidenceRole).toBeUndefined();
      }
    }
  });

  it('derives scope compatibility fields from entries across snapshot and fetch surfaces', () => {
    const store = new ArtifactStore();
    const id = store.store({ skillId: 'global', data: { columns: ['frequency'], rows: [[1200]] },
      scopeProvenance: { version: 'process_scope_evidence@1', entries: [{ role: 'global_context',
        scope: { mode: 'unscoped', traceId: 'trace', traceSide: 'current' } }] } });
    const snapshot = JSON.parse(JSON.stringify(store.serialize()));
    snapshot[0].appliedProcessScope = { mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 999 };
    snapshot[0].evidenceRole = 'target';
    const restored = ArtifactStore.fromSnapshot(snapshot);
    for (const projection of [restored.generateSummary(id), restored.generateCompactSummary(id),
      restored.fetch(id, 'rows'), restored.fetch(id, 'full')]) {
      expect(projection.evidenceRole).toBe('global_context');
      expect(projection.appliedProcessScope).toBeUndefined();
      expect(projection.scopeProvenance.entries[0].scope.mode).toBe('unscoped');
    }
  });
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

  it('keeps a condition-skipped step skipped in summaries and fetch results', () => {
    const store = new ArtifactStore();
    const executionMessage = 'Step skipped: its condition was not met (${has_input} > 0)';
    const artifactId = store.store({
      skillId: 'click_response_analysis',
      stepId: 'input_events',
      title: 'Input events',
      data: { columns: ['event_count'], rows: [] },
      executionStatus: 'skipped',
      executionMessage,
    });

    const expected = { executionStatus: 'skipped', executionMessage };
    expect(store.generateSummary(artifactId)).toMatchObject(expected);
    expect(store.generateCompactSummary(artifactId)).toMatchObject(expected);
    for (const detail of ['summary', 'rows', 'full'] as const) {
      const fetched = store.fetch(artifactId, detail) as Record<string, unknown>;
      expect(fetched).toMatchObject(expected);
      expect(fetched.executionError).toBeUndefined();
    }
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
