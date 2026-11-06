// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {createRuntimePerformanceRecorder} from '../../agentRuntime/runtimePerformance';
import {createRuntimePerformanceScope} from '../../agentRuntime/runtimePerformanceContext';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import {sanitizeQueryReview, SQL_EXECUTION_CONTEXTS} from '../../types/queryReviewContract';
import {ArtifactStore, EVIDENCE_RETENTION_CELLS_ENV, RETAINED_EVIDENCE_CAPTURE_CEILING} from '../artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {attachInvestigationEvidence} from '../../services/evidence/investigationEvidenceLedger';
import {MAX_EVIDENCE_READ_REFERENCES, isIssuedEvidenceReadResolution,
  type EvidenceReadSessionOptions} from '../../services/evidence/evidenceReadView';
import type {EvidenceScopeProvenanceV1} from '../../types/identityContract';
import type {B1QuotePage, B1QuoteScope, B1QuoteStore} from '../../services/evidence/__tests__/modelEvidenceProjection.test';

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

  it('reports evidence availability from the backing capture rather than an empty page or restored flags', () => {
    const store = new ArtifactStore();
    const id = storeCaptured(store, 1, 2);
    const available = {captureRows: 'available', columnUnits: 'unknown', registeredMetricBinding: 'absent'};
    expect(store.fetch(id, 'rows', 20, 5)).toMatchObject({rows: [], totalRows: 2, hasMore: false, modelEvidence: available});
    const snapshot = JSON.parse(JSON.stringify(store.serialize()));
    snapshot[0].modelEvidence = {captureRows: 'available', columnUnits: 'available', registeredMetricBinding: 'present'};
    const restored = ArtifactStore.fromSnapshot(snapshot);
    expect(restored.fetch(id, 'summary')).toMatchObject({modelEvidence: {
      captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
    expect(JSON.stringify(store.serialize())).not.toContain('modelEvidence');
    expect(JSON.stringify(restored.serialize())).not.toContain('modelEvidence');
  });

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

  it('keeps the retained capture when an identical standalone capture is re-issued under its locator', async () => {
    // The cell travels in a one-element array so an explicit undefined is not replaced by a default.
    const registerStandalone = (store: ArtifactStore, sourceToolCallId: string, [value]: [number | null | undefined] = [1]) =>
      store.registerStandaloneEvidenceCapture(captureEvidenceTable({columns: ['v'], rows: [[value]]}), {
        meta: {type: 'sql_result', version: '2.0', source: 'producer', timestamp: 0, evidenceRefId: 'data:reissued',
          sourceToolCallId, traceId: 'trace', traceSide: 'current'}, display: {layer: 'list', format: 'table', title: 'x'},
        originRunId: sourceToolCallId === 'producer:same' ? 'run-a' : undefined});
    const reference = {evidenceRefId: 'data:reissued', rowIndex: 0, column: 'v'};
    const store = new ArtifactStore();
    expect(registerStandalone(store, 'producer:same')).toBe(true);
    const earlierView = readView(store);
    const [first] = await earlierView.resolveReferences([{key: 'k', reference, requiredColumns: []}]);
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable({columns: ['v'], rows: [[1]]}), {
      meta: {type: 'sql_result', version: '2.0', source: 'producer', timestamp: 0, evidenceRefId: 'data:reissued',
        sourceToolCallId: 'producer:same', traceId: 'trace', traceSide: 'current'},
      display: {layer: 'list', format: 'table', title: 'x'}, originRunId: 'run-b'})).toBe(true);
    // The earlier view and a new one see the same record, still owned by its first run.
    const [again] = await earlierView.resolveReferences([{key: 'k', reference, requiredColumns: []}]);
    const [fresh] = await readView(store).resolveReferences([{key: 'k', reference, requiredColumns: []}]);
    expect(first).toMatchObject({status: 'resolved', record: {originRunId: 'run-a'}});
    for (const resolution of [again, fresh]) {
      expect(resolution).toMatchObject({status: 'resolved', record: {originRunId: 'run-a'}});
      if (resolution.status === 'resolved' && first.status === 'resolved') expect(resolution.record.captureId).toBe(first.record.captureId);
    }

    // Different content under one locator never rewrites the retained record: it is ambiguous.
    const changed = new ArtifactStore();
    registerStandalone(changed, 'producer:same', [1]);
    registerStandalone(changed, 'producer:same', [2]);
    // A missing cell and a null cell are different evidence, even though JSON prints both as null.
    const missing = new ArtifactStore();
    registerStandalone(missing, 'producer:same', [undefined]);
    registerStandalone(missing, 'producer:same', [null]);
    // And a different producer call under the same identifier is not a re-issue.
    const calls = new ArtifactStore();
    registerStandalone(calls, 'producer:one');
    registerStandalone(calls, 'producer:two');
    for (const ambiguous of [changed, missing, calls]) {
      expect((await readView(ambiguous).resolveReferences([{key: 'k', reference, requiredColumns: []}]))[0])
        .toMatchObject({status: 'ambiguous'});
    }
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
      expect(store.fetch(first, 'summary')).toMatchObject({modelEvidence: {
        captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
      expect(store.fetch(second, 'summary')).toMatchObject({columnUnits: {busy_pct: '%'}});
    } finally {
      delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
    }
  });
});

describe('ArtifactStore', () => {
  it.each([0, 3])('keeps private binding and empty/partial capture facts identical across artifact surfaces: rows=%s', rowCount => {
    const store = new ArtifactStore();
    const data = {columns: ['start', 'end', 'duration', 'status'],
      rows: Array.from({length: rowCount}, (_, index) => [index, index + 1, 1, 'partial'])};
    const witness = captureEvidenceTable(data, {duration: {unit: 'ns',
      origin: {kind: 'skill_literal', definitionFingerprint: 'private-definition'}}});
    attachInvestigationEvidence(witness, {skillId: 'custom_producer', stepId: 'root', traceId: 'trace',
      definitionFingerprint: 'private-definition', selectedSqlHash: 'private-sql',
      declaration: {window: {start: 'start', end: 'end'}, metrics: [{domain: 'fixture', metric_id: 'custom.metric',
        value: 'duration', unit: 'ns', status: 'status'}]}});
    // The public skill label cannot confer or erase the witness's actual binding.
    const id = store.store({skillId: 'execute_sql', data, executionStatus: rowCount ? 'observed' : 'empty',
      traceProvenance: {traceId: 'trace', traceSide: 'current'} as never});
    store.registerEvidenceCapture(id, witness, {evidenceRefId: 'evidence-custom'});
    const expected = {captureRows: rowCount ? 'available' : 'empty', columnUnits: 'available', registeredMetricBinding: 'present'};
    for (const result of [store.generateSummary(id), store.generateCompactSummary(id),
      store.fetch(id, 'summary'), store.fetch(id, 'rows', 100, 1), store.fetch(id, 'full')]) {
      expect(result).toMatchObject({modelEvidence: expected});
      expect(JSON.stringify(result)).not.toMatch(/private-definition|private-sql|proofEligible|verified/);
    }
    expect(store.fetch(id, 'rows', 100, 1)).toMatchObject({rows: [], totalRows: rowCount});
    const otherStore = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
    expect(otherStore.fetch(id, 'rows')).toMatchObject({modelEvidence: {
      captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
  });

  it('does not treat a capped full fetch as a complete or empty capture', () => {
    const store = new ArtifactStore();
    const data = {columns: ['value'], rows: Array.from({length: ArtifactStore.MAX_FULL_ROWS + 1}, (_, i) => [i])};
    const id = store.store({skillId: 'raw', data});
    store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: 'large'});
    expect(store.fetch(id, 'full')).toMatchObject({truncated: true, totalRows: data.rows.length,
      modelEvidence: {captureRows: 'available', columnUnits: 'unknown', registeredMetricBinding: 'absent'}});
    expect(store.fetch(id, 'full').data.rows).toHaveLength(ArtifactStore.MAX_FULL_ROWS);
  });

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
      expect(projection).toMatchObject({columnUnits: {ttid_ms: 'ms', busy_pct: '%'}, modelEvidence: {
        captureRows: 'available', columnUnits: 'available', registeredMetricBinding: 'absent'}});
      expect(projection.columnUnits).not.toHaveProperty('ambiguous_pct');
    }
    const snapshot = JSON.parse(JSON.stringify(store.serialize()));
    expect(JSON.stringify(snapshot)).not.toContain('columnUnits');
    expect(JSON.stringify(snapshot)).not.toContain('modelEvidence');
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

  it.each([...SQL_EXECUTION_CONTEXTS, undefined])('projects a bounded query review ref with context %s while preserving full data', executionContext => {
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
        ...(executionContext === undefined ? {} : {executionContext}),
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
      if (executionContext === undefined) expect(projected?.observedExecution).not.toHaveProperty('executionContext');
      else expect(projected?.observedExecution.executionContext).toBe(executionContext);
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1_500);
    }
    expect(compact.queryReview?.limitations).toHaveLength(2);
    expect(full.queryReview.reads).toHaveLength(16);
    expect(full.queryReview.filters).toHaveLength(12);
    expect(full.queryReview.outputShape).toHaveLength(32);
    expect(full.queryReview.guardrails).toHaveLength(16);
    expect(full.queryReview.limitations).toHaveLength(12);
    expect(full.queryReview.observedExecution.executableSql).toContain('SELECT');
    if (executionContext === undefined) expect(full.queryReview.observedExecution).not.toHaveProperty('executionContext');
    else expect(full.queryReview.observedExecution.executionContext).toBe(executionContext);
  });
});


describe('accepted capture activity', () => {
  it('observes issued capture registrations without a manifest or a tool call, and keeps origins honest', () => {
    const store = new ArtifactStore();
    const recorder = createRuntimePerformanceRecorder();
    const scope = createRuntimePerformanceScope({identity: {runId: 'current-run', sessionId: 'session',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}}, recorder, assertCurrent() {}});
    const data = {columns: ['private_metric'], rows: [['private value'], ['private value']]};
    const current = captureEvidenceTable(data);
    const reused = captureEvidenceTable({columns: ['x'], rows: [[1]]});
    const unknown = captureEvidenceTable(undefined);
    const empty = captureEvidenceTable({columns: ['x'], rows: []});
    const register = (witness: typeof current, originRunId?: string) => {
      const id = store.store({skillId: 'execute_sql', data, title: 'Private title'});
      return store.registerEvidenceCapture(id, witness, {evidenceRefId: `evidence-${id}`, originRunId});
    };
    expect(register(captureEvidenceTable(data), 'outside-run')).toBe(true);
    expect(recorder.activitySnapshot().captureActivity).toBeUndefined();
    scope.run(() => {
      expect(register(current, 'current-run')).toBe(true);
      expect(register(current, 'current-run')).toBe(true);
      expect(register(reused, 'older-run')).toBe(true);
      expect(register(unknown)).toBe(true);
      expect(register(empty, 'current-run')).toBe(true);
      expect(register({captureId: 'model-invented'}, 'current-run')).toBe(false);
    });
    scope.dispose();
    const receipt = recorder.seal();
    expect(receipt.activity).toMatchObject({observation: 'unavailable', attempted: 0, evidenceNovelty: 'not_assessed',
      captureActivity: {observation: 'observed', tables: 4, rowSlots: 3, unavailableTables: 1,
        currentRunTables: 2, reusedTables: 1, unknownOriginTables: 1, dropped: 0}});
    expect(JSON.stringify(receipt.activity)).not.toMatch(/private|current-run|older-run|evidence-/);
    const next = createRuntimePerformanceRecorder();
    const nextScope = createRuntimePerformanceScope({identity: {runId: 'next-run', sessionId: 'session',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}}, recorder: next, assertCurrent() {}});
    nextScope.run(() => register(current, 'next-run'));
    expect(next.activitySnapshot().captureActivity).toMatchObject({tables: 1, reusedTables: 1, currentRunTables: 0});
    nextScope.dispose();
    scope.run(() => register(captureEvidenceTable(data), 'current-run'));
    expect(recorder.seal()).toBe(receipt);
  });
});

describe('A1 current execution-record retention', () => {
  const options = {ownerKey: 'a1-retention-owner', allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]};
  function register(store: ArtifactStore, value = 7, originRunId = 'earlier-run') {
    const data = {columns: ['metric'], rows: [[value]]}, witness = captureEvidenceTable(data);
    const id = store.store({skillId: 'fixture', data, sourceToolCallId: `capture:${value}`,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    const evidenceRefId = `evidence:${id}`;
    expect(store.registerEvidenceCapture(id, witness, {evidenceRefId, originRunId})).toBe(true);
    return {id, evidenceRefId, witness};
  }
  async function read(store: ArtifactStore, id: string) {
    const [resolution] = await store.createEvidenceReadView(options).resolveReferences([
      {key: id, reference: {artifactId: id, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']},
    ]);
    if (resolution.status !== 'resolved') throw new Error('Expected a real retained cell');
    return resolution;
  }

  it('retains the exact issued pair across unrelated registrations and payload-only LRU eviction', async () => {
    const store = new ArtifactStore(1), first = register(store), resolution = await read(store, first.id);
    expect(store.isEvidenceReadResolutionRetained(resolution)).toBe(true);
    store.store({skillId: 'display-only', data: {columns: [], rows: []}});
    expect(store.get(first.id)).toBeUndefined();
    expect(store.isEvidenceReadResolutionRetained(resolution)).toBe(true);
    register(store, 8);
    expect(store.isEvidenceReadResolutionRetained(resolution)).toBe(true);
    expect(await read(store, first.id)).toMatchObject({row: {metric: 7}});
    expect(resolution.record.originRunId).toBe('earlier-run'); // Retention is not current-run authorization.
  });

  it('keeps a genuinely deduplicated standalone re-issue attached to its original registration', async () => {
    const store = new ArtifactStore(), data = {columns: ['metric'], rows: [[7]]};
    const descriptor = {meta: {type: 'sql_result' as const, version: '2.0', source: 'producer', timestamp: 0,
      evidenceRefId: 'standalone-a1', sourceToolCallId: 'same-producer', traceId: 'trace', traceSide: 'current' as const},
      display: {layer: 'list' as const, format: 'table' as const, title: 'Standalone'}, originRunId: 'first-run'};
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), descriptor)).toBe(true);
    const view = store.createEvidenceReadView(options), request = {key: 'one',
      reference: {evidenceRefId: 'standalone-a1', rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']};
    const [original] = await view.resolveReferences([request]);
    if (original.status !== 'resolved') throw new Error('Expected standalone read');
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), {...descriptor, originRunId: 'second-run'})).toBe(true);
    const [again] = await store.createEvidenceReadView(options).resolveReferences([request]);
    if (again.status !== 'resolved') throw new Error('Expected deduplicated read');
    expect(again.record).toBe(original.record);
    expect(store.isEvidenceReadResolutionRetained(original)).toBe(true);
    expect(store.isEvidenceReadResolutionRetained(again)).toBe(true);
  });

  it.each(['same-witness', 'new-witness'] as const)('invalidates only the replaced registration with %s while preserving old immutable facts', async replacementKind => {
    const store = new ArtifactStore(), first = register(store), old = await read(store, first.id);
    const unaffected = register(store, 8), unaffectedRead = await read(store, unaffected.id);
    const witness = replacementKind === 'same-witness' ? first.witness : captureEvidenceTable({columns: ['metric'], rows: [[9]]});
    expect(store.registerEvidenceCapture(first.id, witness, {evidenceRefId: first.evidenceRefId, originRunId: 'new-run'})).toBe(true);
    const fresh = await read(store, first.id);
    expect(fresh.record.generation).toBeGreaterThan(old.record.generation);
    expect(store.isEvidenceReadResolutionRetained(old)).toBe(false);
    expect(store.isEvidenceReadResolutionRetained(fresh)).toBe(true);
    expect(store.isEvidenceReadResolutionRetained(unaffectedRead)).toBe(true);
    expect(isIssuedEvidenceReadResolution(old)).toBe(true); expect(old.row).toEqual({metric: 7});
    expect(fresh.row).toEqual({metric: replacementKind === 'same-witness' ? 7 : 9});
  });

  it('does not match an old read after clear, even when its artifact locator is reused', async () => {
    const store = new ArtifactStore(), first = register(store), old = await read(store, first.id);
    store.clear(); expect(store.isEvidenceReadResolutionRetained(old)).toBe(false);
    const replacement = register(store, 9), fresh = await read(store, replacement.id);
    expect(replacement.id).toBe(first.id);
    expect(store.isEvidenceReadResolutionRetained(old)).toBe(false);
    expect(store.isEvidenceReadResolutionRetained(fresh)).toBe(true);
    expect(isIssuedEvidenceReadResolution(old)).toBe(true); expect(old.row).toEqual({metric: 7});
  });

  it('rejects a truly evicted capture while leaving its issued value unchanged', async () => {
    const previous = process.env[EVIDENCE_RETENTION_CELLS_ENV]; process.env[EVIDENCE_RETENTION_CELLS_ENV] = '1';
    try {
      const store = new ArtifactStore(), first = register(store), old = await read(store, first.id);
      const second = register(store, 9), fresh = await read(store, second.id);
      expect(store.get(first.id)).toBeDefined(); // Payload still present; only the retained witness was evicted.
      expect(store.isEvidenceReadResolutionRetained(old)).toBe(false);
      expect(store.isEvidenceReadResolutionRetained(fresh)).toBe(true);
      expect(isIssuedEvidenceReadResolution(old)).toBe(true); expect(old.row).toEqual({metric: 7});
    } finally {
      if (previous === undefined) delete process.env[EVIDENCE_RETENTION_CELLS_ENV]; else process.env[EVIDENCE_RETENTION_CELLS_ENV] = previous;
    }
  });

  it('does not recover retention from another store, display-only restoration or copied resolution', async () => {
    const store = new ArtifactStore(), first = register(store), original = await read(store, first.id);
    const other = new ArtifactStore(); register(other);
    const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
    for (const candidate of [other, restored]) expect(candidate.isEvidenceReadResolutionRetained(original)).toBe(false);
    for (const value of [{...original}, JSON.parse(JSON.stringify(original)), undefined, null,
      {status: 'resolved', record: original.record}, {status: 'missing', reason: 'not_retained'}]) {
      expect(store.isEvidenceReadResolutionRetained(value)).toBe(false);
    }
    expect(store.isEvidenceReadResolutionRetained(original)).toBe(true);
  });

  it('rejects hostile non-issued inputs without invoking status or record getters', async () => {
    const store = new ArtifactStore(), registered = register(store), issued = await read(store, registered.id);
    let inspected = 0; const inspect = () => {inspected++; throw new Error('Untrusted property was read');};
    const plain = Object.defineProperties({}, {status: {get: inspect}, record: {get: inspect}});
    const proxy = new Proxy(issued, {get: inspect, getPrototypeOf: inspect, ownKeys: inspect});
    const revoked = Proxy.revocable(issued, {get: inspect}); revoked.revoke();
    for (const value of [plain, proxy, revoked.proxy]) expect(store.isEvidenceReadResolutionRetained(value)).toBe(false);
    expect(inspected).toBe(0);
  });
});

describe('A2 retained batches and fixed session capture sets', () => {
  function options(overrides: Partial<EvidenceReadSessionOptions> = {}): EvidenceReadSessionOptions {
    return {ownerKey: 'a2-batch-owner', currentRunId: 'a2-run', sessionId: 'a2-session', attemptId: 'a2-attempt',
      allowedTraces: [{traceId: 'trace', traceSide: 'current'}], productSignal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000, assertCurrent() {}, ...overrides};
  }
  function register(store: ArtifactStore, value = 7) {
    const data = {columns: ['metric'], rows: [[value]]}, witness = captureEvidenceTable(data);
    const id = store.store({skillId: 'fixture', data, sourceToolCallId: `a2-capture:${value}`,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    const evidenceRefId = `a2:${id}`;
    expect(store.registerEvidenceCapture(id, witness, {evidenceRefId, originRunId: 'a2-run'})).toBe(true);
    return {id, witness, evidenceRefId};
  }
  const request = (id: string) => ({key: id, reference: {artifactId: id, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']});

  it('checks the complete actual record/witness set without consulting an overridable single-item method', async () => {
    const store = new ArtifactStore(), first = register(store), second = register(store, 8);
    const session = store.createEvidenceReadSession(options());
    const reads = await session.resolveReferences([request(first.id), request(second.id)]);
    expect(reads).toMatchObject([{status: 'resolved', row: {metric: 7}}, {status: 'resolved', row: {metric: 8}}]);
    const single = jest.spyOn(store, 'isEvidenceReadResolutionRetained').mockImplementation(() => {
      throw new Error('Batch must not call the public single-item method');
    });
    try {
      expect(store.areEvidenceReadResolutionsRetained(reads)).toBe(true);
      expect(session.checkRetainedBatchForCommit(reads)).toBe(true);
      expect(single).not.toHaveBeenCalled();
      expect(store.areEvidenceReadResolutionsRetained([])).toBe(true); // No claim about an empty table or caption.
    } finally {single.mockRestore(); session.dispose();}
  });

  it.each([0, 1])('rejects the entire batch after replacing capture index %i', async replacedIndex => {
    const store = new ArtifactStore(), captures = [register(store), register(store, 8)];
    const session = store.createEvidenceReadSession(options());
    const reads = await session.resolveReferences(captures.map(saved => request(saved.id)));
    expect(store.areEvidenceReadResolutionsRetained(reads)).toBe(true);
    const replaced = captures[replacedIndex];
    expect(store.registerEvidenceCapture(replaced.id, replaced.witness, {evidenceRefId: replaced.evidenceRefId})).toBe(true);
    expect(store.areEvidenceReadResolutionsRetained(reads)).toBe(false);
    expect(session.checkRetainedBatchForCommit(reads)).toBe(false);
    expect(store.isEvidenceReadResolutionRetained(reads[1 - replacedIndex])).toBe(true);
    expect(reads.every(isIssuedEvidenceReadResolution)).toBe(true);
    expect(reads).toMatchObject([{row: {metric: 7}}, {row: {metric: 8}}]);
    session.dispose();
  });

  it('runs the final bare owner guard once before checking both actual captures', async () => {
    const store = new ArtifactStore(), first = register(store), second = register(store, 8);
    let revokeFirst = false;
    const guard = jest.fn(() => {
      if (revokeFirst) {
        revokeFirst = false;
        expect(store.registerEvidenceCapture(first.id, first.witness, {evidenceRefId: first.evidenceRefId})).toBe(true);
      }
    });
    const session = store.createEvidenceReadSession(options({assertCurrent: guard}));
    const reads = await session.resolveReferences([request(first.id), request(second.id)]);
    expect(store.areEvidenceReadResolutionsRetained(reads)).toBe(true);
    expect(store.isEvidenceReadResolutionRetained(reads[0])).toBe(true);
    guard.mockClear(); revokeFirst = true;
    expect(session.checkRetainedBatchForCommit(reads)).toBe(false);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.isEvidenceReadResolutionRetained(reads[0])).toBe(false);
    expect(store.isEvidenceReadResolutionRetained(reads[1])).toBe(true);
    session.dispose();
  });

  it('rejects hostile outer collections and non-issued elements without executing accessors, proxies or iterators', async () => {
    const store = new ArtifactStore(), first = register(store), session = store.createEvidenceReadSession(options());
    const [issued] = await session.resolveReferences([request(first.id)]);
    let inspected = 0; const inspect = () => {inspected++; throw new Error('Untrusted batch property');};
    const accessor: unknown[] = []; Object.defineProperty(accessor, '0', {get: inspect});
    const iterator: unknown[] = [issued]; Object.defineProperty(iterator, Symbol.iterator, {value: inspect});
    const proxy = new Proxy([issued], {get: inspect, ownKeys: inspect, getPrototypeOf: inspect});
    const revoked = Proxy.revocable([issued], {get: inspect}); revoked.revoke();
    const hostileItem = Object.defineProperty({}, 'status', {get: inspect});
    const values: unknown[] = [undefined, null, {}, 'not-a-list', accessor, iterator, proxy, revoked.proxy,
      [hostileItem], [{...issued}], [JSON.parse(JSON.stringify(issued))], [{status: 'missing'}], [undefined]];
    for (const value of values) {
      expect(Reflect.apply(store.areEvidenceReadResolutionsRetained, store, [value])).toBe(false);
      expect(Reflect.apply(session.checkRetainedBatchForCommit, session, [value])).toBe(false);
    }
    expect(inspected).toBe(0);
    expect(store.areEvidenceReadResolutionsRetained(Object.freeze([issued]))).toBe(true);
    session.dispose();
  });

  it('rejects another store and restored display snapshots while preserving the original immutable fact', async () => {
    const store = new ArtifactStore(), first = register(store), session = store.createEvidenceReadSession(options());
    const reads = await session.resolveReferences([request(first.id)]);
    const other = new ArtifactStore(); register(other);
    const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
    expect(other.areEvidenceReadResolutionsRetained(reads)).toBe(false);
    expect(restored.areEvidenceReadResolutionsRetained(reads)).toBe(false);
    expect(store.areEvidenceReadResolutionsRetained(reads)).toBe(true);
    expect(reads.every(isIssuedEvidenceReadResolution)).toBe(true);
    session.dispose();
  });

  it('freezes the admitted capture set at session creation without losing unrelated retained captures or payload-only eviction', async () => {
    const store = new ArtifactStore(1), first = register(store), session = store.createEvidenceReadSession(options());
    const [original] = await session.resolveReferences([request(first.id)]);
    const later = register(store, 8);
    expect(store.get(first.id)).toBeUndefined(); // Only the display/payload LRU was evicted.
    expect(await session.resolveReferences([request(first.id), request(later.id)])).toMatchObject([
      {status: 'resolved', row: {metric: 7}}, {status: 'missing', reason: 'evidence_not_retained'},
    ]);
    expect(session.checkRetainedBatchForCommit([original])).toBe(true);
    const fresh = store.createEvidenceReadSession(options());
    expect(await fresh.resolveReferences([request(later.id)])).toMatchObject([{status: 'resolved', row: {metric: 8}}]);
    fresh.dispose(); session.dispose();
  });

  it.each(['clear', 'replace', 'evict'] as const)('does not resurrect a cached read after %s', async action => {
    const previous = process.env[EVIDENCE_RETENTION_CELLS_ENV];
    if (action === 'evict') process.env[EVIDENCE_RETENTION_CELLS_ENV] = '1';
    try {
      const store = new ArtifactStore(), first = register(store), session = store.createEvidenceReadSession(options());
      const [original] = await session.resolveReferences([request(first.id)]);
      expect(original).toMatchObject({status: 'resolved', row: {metric: 7}});
      if (action === 'clear') {store.clear(); expect(register(store, 9).id).toBe(first.id);}
      if (action === 'replace') expect(store.registerEvidenceCapture(first.id,
        captureEvidenceTable({columns: ['metric'], rows: [[9]]}), {evidenceRefId: first.evidenceRefId})).toBe(true);
      if (action === 'evict') register(store, 9);
      expect(await session.resolveReferences([request(first.id)]))
        .toMatchObject([{status: 'missing', reason: 'evidence_not_retained'}]);
      expect(session.checkRetainedBatchForCommit([original])).toBe(false);
      expect(isIssuedEvidenceReadResolution(original)).toBe(true);
      expect(original).toMatchObject({row: {metric: 7}});
      session.dispose();
    } finally {
      if (previous === undefined) delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
      else process.env[EVIDENCE_RETENTION_CELLS_ENV] = previous;
    }
  });

  it('keeps a real standalone dedupe in the admitted set and retains its cached metadata identity', async () => {
    const store = new ArtifactStore(), data = {columns: ['metric'], rows: [[7]]};
    const descriptor = {meta: {type: 'sql_result' as const, version: '2.0', source: 'producer', timestamp: 0,
      evidenceRefId: 'a2-standalone', sourceToolCallId: 'a2-producer', traceId: 'trace', traceSide: 'current' as const},
      display: {layer: 'list' as const, format: 'table' as const, title: 'Standalone'}, originRunId: 'a2-run'};
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), descriptor)).toBe(true);
    const session = store.createEvidenceReadSession(options());
    const one = {key: 'standalone', reference: {evidenceRefId: 'a2-standalone', rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']};
    const [original] = await session.resolveReferences([one]);
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), descriptor)).toBe(true);
    const [again] = await session.resolveReferences([one]);
    if (original.status !== 'resolved' || again.status !== 'resolved') throw new Error('Expected standalone issued reads');
    expect(again.record).toBe(original.record); expect(again).not.toBe(original);
    expect(session.checkRetainedBatchForCommit([original, again])).toBe(true);
    expect(session.budgetSnapshot()).toMatchObject({used: {references: 2, cells: 1}, reusedCells: 1, reusedRecordMetadata: 1});
    session.dispose();
  });
});

describe('B1 store-owned quote projection bindings', () => {
  const scope: B1QuoteScope = {runId: 'b1-current', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]};
  function register(store: ArtifactStore, value = 7, originRunId: string | undefined = scope.runId) {
    const data = {columns: ['metric'], rows: [[value]]}, witness = captureEvidenceTable(data);
    const id = store.store({skillId: 'fixture', data, sourceToolCallId: `b1-producer:${value}`,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    const evidenceRefId = `b1:${id}`;
    expect(store.registerEvidenceCapture(id, witness, {evidenceRefId, originRunId})).toBe(true);
    return {id, evidenceRefId, witness};
  }
  const page = (value = 7): B1QuotePage => ({rows: [0], columns: ['metric'],
    cells: [{rowIndex: 0, column: 'metric', value, availability: 'visible'}],
    page: {hasMore: 'no', coverage: 'visible_page_only'}});
  async function read(store: ArtifactStore, id: string, rowIndex = 0) {
    const [resolution] = await store.createEvidenceReadView({ownerKey: 'b1-reader', allowedTraces: scope.allowedTraces})
      .resolveReferences([{key: id, reference: {artifactId: id, rowIndex, column: 'metric'}, requiredColumns: ['metric']}]);
    if (resolution.status !== 'resolved') throw new Error('Expected actual B1 issued capture read');
    return resolution;
  }

  it('prepares either exact issued locator without calling a read view or changing payload serialization', async () => {
    const store = new ArtifactStore() as B1QuoteStore, saved = register(store);
    const payloadBefore = JSON.stringify(store.serialize()), visible = page();
    const reader = jest.spyOn(store, 'createEvidenceReadView');
    let artifactBinding: ReturnType<B1QuoteStore['prepareQuoteProjectionBinding']>;
    let evidenceBinding: ReturnType<B1QuoteStore['prepareQuoteProjectionBinding']>;
    try {
      artifactBinding = store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: visible});
      evidenceBinding = store.prepareQuoteProjectionBinding({evidenceRefId: saved.evidenceRefId}, {scope, page: visible});
      expect(artifactBinding).toBeDefined(); expect(evidenceBinding).toBeDefined();
      expect(reader).not.toHaveBeenCalled();
    } finally {reader.mockRestore();}
    const resolution = await read(store, saved.id);
    expect(store.matchesQuoteProjectionRead(artifactBinding, resolution)).toBe(true);
    expect(store.matchesQuoteProjectionRead(evidenceBinding, resolution)).toBe(true);
    expect(JSON.stringify(store.serialize())).toBe(payloadBefore);
    expect(JSON.stringify(artifactBinding)).not.toMatch(/captureId|generation|originRunId|rowIndex|fields|metric/);
  });

  it.each(['earlier-run', 'unknown-origin'] as const)('does not promote a readable %s capture into current-run quoting', async origin => {
    const store = new ArtifactStore() as B1QuoteStore, saved = register(store, 7, origin === 'earlier-run' ? 'old-run' : '');
    const resolution = await read(store, saved.id);
    expect(isIssuedEvidenceReadResolution(resolution)).toBe(true);
    expect(store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()})).toBeUndefined();
  });

  it.each([
    {runId: 'other-run', allowedTraces: [{traceId: 'trace', traceSide: 'current' as const}]},
    {runId: scope.runId, allowedTraces: [{traceId: 'foreign', traceSide: 'current' as const}]},
    {runId: scope.runId, allowedTraces: [{traceId: 'trace', traceSide: 'reference' as const}]},
  ])('rejects a scope that does not bind the capture origin and trace side: %p', requestedScope => {
    const store = new ArtifactStore() as B1QuoteStore, saved = register(store);
    expect(store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope: requestedScope, page: page()})).toBeUndefined();
  });

  it('requires a real unique registration rather than payloads, display aliases or restored snapshots', () => {
    const store = new ArtifactStore() as B1QuoteStore;
    const id = store.store({skillId: 'fixture', title: 'display-alias', data: {columns: ['metric'], rows: [[7]]}});
    expect(store.prepareQuoteProjectionBinding({artifactId: id}, {scope, page: page()})).toBeUndefined();
    const saved = register(store);
    expect(store.prepareQuoteProjectionBinding({evidenceRefId: 'display-alias'}, {scope, page: page()})).toBeUndefined();
    const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize()))) as B1QuoteStore;
    expect(restored.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()})).toBeUndefined();
    const descriptor = {meta: {type: 'sql_result' as const, version: '2.0', source: 'producer', timestamp: 0,
      evidenceRefId: 'ambiguous-b1', sourceToolCallId: 'producer', traceId: 'trace', traceSide: 'current' as const},
      display: {layer: 'list' as const, format: 'table' as const, title: 'Standalone'}, originRunId: scope.runId};
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable({columns: ['metric'], rows: [[7]]}), descriptor)).toBe(true);
    expect(store.registerStandaloneEvidenceCapture(captureEvidenceTable({columns: ['metric'], rows: [[8]]}), descriptor)).toBe(true);
    expect(store.prepareQuoteProjectionBinding({evidenceRefId: 'ambiguous-b1'}, {scope, page: page()})).toBeUndefined();
  });

  it('validates original noncontiguous row coordinates and reordered columns without granting hidden-row visibility', async () => {
    const store = new ArtifactStore() as B1QuoteStore;
    const data = {columns: ['metric', 'other'], rows: [[7, 70], [8, 80], [9, 90]]};
    const id = store.store({skillId: 'fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: 'b1-page', originRunId: scope.runId})).toBe(true);
    const visible: B1QuotePage = {rows: [2, 0], columns: ['other', 'metric'], cells: [
      {rowIndex: 2, column: 'other', value: 90, availability: 'visible'},
      {rowIndex: 2, column: 'metric', value: 9, availability: 'visible'},
      {rowIndex: 0, column: 'other', value: 70, availability: 'visible'},
      {rowIndex: 0, column: 'metric', value: 7, availability: 'visible'},
    ], page: {hasMore: 'unknown', coverage: 'visible_page_only'}};
    const binding = store.prepareQuoteProjectionBinding({artifactId: id}, {scope, page: visible});
    expect(binding).toBeDefined();
    expect(store.matchesQuoteProjectionRead(binding, await read(store, id, 2))).toBe(true);
    // The boolean is intentionally entry-only; C must separately reject row 1 if it was not visible on the producing page.
    expect(store.matchesQuoteProjectionRead(binding, await read(store, id, 1))).toBe(true);
    expect(visible.rows).toEqual([2, 0]); expect(visible.columns).toEqual(['other', 'metric']);
    const wrongIndex: B1QuotePage = {...visible, cells: [{rowIndex: 0, column: 'metric', value: 9, availability: 'visible'}]};
    expect(store.prepareQuoteProjectionBinding({artifactId: id}, {scope, page: wrongIndex})).toBeUndefined();
    const outside: B1QuotePage = {...page(), rows: [3], cells: [{rowIndex: 3, column: 'metric', value: 7, availability: 'visible'}]};
    expect(store.prepareQuoteProjectionBinding({artifactId: id}, {scope, page: outside})).toBeUndefined();
  });

  it.each(['captured-empty', 'empty-visible-page'] as const)('requires a real metadata read for %s without treating page emptiness as absence', async kind => {
    const store = new ArtifactStore() as B1QuoteStore;
    const data = {columns: ['metric'], rows: kind === 'captured-empty' ? [] : [[7], [8]]};
    const id = store.store({skillId: 'fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: 'b1-empty', originRunId: scope.runId})).toBe(true);
    const visible: B1QuotePage = {rows: [], columns: ['metric'], cells: [],
      page: {hasMore: kind === 'captured-empty' ? 'no' : 'unknown', coverage: 'visible_page_only'}};
    const binding = store.prepareQuoteProjectionBinding({artifactId: id}, {scope, page: visible});
    expect(binding).toBeDefined();
    expect(store.matchesQuoteProjectionRead(binding, undefined)).toBe(false);
    const session = store.createEvidenceReadSession({ownerKey: 'b1-empty-reader', allowedTraces: scope.allowedTraces,
      currentRunId: scope.runId, sessionId: 'b1-session', attemptId: 'b1-attempt', productSignal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000, assertCurrent() {}});
    try {
      const [metadata] = await session.resolveReferences([{key: 'empty-page-metadata', reference: {artifactId: id},
        requiredColumns: [], metadataOnly: true}]);
      expect(metadata.status).toBe('resolved');
      expect(store.matchesQuoteProjectionRead(binding, metadata)).toBe(true);
      expect(session.budgetSnapshot().used.references).toBe(1);
      expect(session.checkRetainedBatchForCommit([metadata])).toBe(true);
    } finally {session.dispose();}
  });

  it('binds the prepared exact generation, leaving current retention to A2 after replacement or clear', async () => {
    const store = new ArtifactStore() as B1QuoteStore, saved = register(store);
    const binding = store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()});
    const original = await read(store, saved.id);
    expect(store.matchesQuoteProjectionRead(binding, original)).toBe(true);
    expect(store.registerEvidenceCapture(saved.id, saved.witness, {evidenceRefId: saved.evidenceRefId, originRunId: scope.runId})).toBe(true);
    const replacement = await read(store, saved.id);
    expect(replacement.record.generation).not.toBe(original.record.generation);
    expect(store.matchesQuoteProjectionRead(binding, replacement)).toBe(false);
    expect(store.matchesQuoteProjectionRead(binding, original)).toBe(true);
    expect(store.areEvidenceReadResolutionsRetained([original])).toBe(false);
    const fresh = store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()});
    expect(store.matchesQuoteProjectionRead(fresh, replacement)).toBe(true);
    expect(store.matchesQuoteProjectionRead(fresh, original)).toBe(false);
    store.clear();
    expect(store.matchesQuoteProjectionRead(binding, original)).toBe(true); // Immutable preparation fact, not live retention.
    expect(store.areEvidenceReadResolutionsRetained([original])).toBe(false);
    expect(store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()})).toBeUndefined();
  });

  it('does not retarget a prepared identity when caller-owned locator, scope or page inputs are rewritten in place', async () => {
    const store = new ArtifactStore() as B1QuoteStore, first = register(store), second = register(store, 9);
    const locator = {artifactId: first.id};
    const traces = [{traceId: 'trace', traceSide: 'current' as const}];
    const requestedScope: B1QuoteScope = {runId: scope.runId, allowedTraces: traces};
    const rows = [0], columns = ['metric'];
    const cells = [{rowIndex: 0, column: 'metric', value: 7, availability: 'visible' as const}];
    const visible: B1QuotePage = {rows, columns, cells, page: {hasMore: 'unknown', coverage: 'visible_page_only'}};
    const binding = store.prepareQuoteProjectionBinding(locator, {scope: requestedScope, page: visible});
    expect(binding).toBeDefined();
    const original = await read(store, first.id), other = await read(store, second.id);
    locator.artifactId = second.id; requestedScope.runId = 'rewritten'; traces[0].traceId = 'foreign';
    rows[0] = 99; columns[0] = 'hidden'; cells[0].rowIndex = 99; cells[0].value = 9;
    expect(store.matchesQuoteProjectionRead(binding, original)).toBe(true);
    expect(store.matchesQuoteProjectionRead(binding, other)).toBe(false);
    expect(original.row).toEqual({metric: 7});
    // B1 exposes no private page getter. C separately verifies its stored visible-cell snapshot.
  });

  it('preserves binding across payload LRU but never makes a truly evicted capture current', async () => {
    const store = new ArtifactStore(1) as B1QuoteStore, saved = register(store);
    const binding = store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()}), original = await read(store, saved.id);
    store.store({skillId: 'display-only', data: {columns: [], rows: []}});
    expect(store.get(saved.id)).toBeUndefined();
    expect(store.matchesQuoteProjectionRead(binding, original)).toBe(true);
    expect(store.areEvidenceReadResolutionsRetained([original])).toBe(true);
    expect(store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()})).toBeDefined();
    const previous = process.env[EVIDENCE_RETENTION_CELLS_ENV]; process.env[EVIDENCE_RETENTION_CELLS_ENV] = '1';
    try {
      const limited = new ArtifactStore() as B1QuoteStore, first = register(limited);
      const prepared = limited.prepareQuoteProjectionBinding({artifactId: first.id}, {scope, page: page()});
      const issued = await read(limited, first.id); register(limited, 9);
      expect(limited.matchesQuoteProjectionRead(prepared, issued)).toBe(true);
      expect(limited.areEvidenceReadResolutionsRetained([issued])).toBe(false);
      expect(limited.prepareQuoteProjectionBinding({artifactId: first.id}, {scope, page: page()})).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
      else process.env[EVIDENCE_RETENTION_CELLS_ENV] = previous;
    }
  });

  it('rejects cross-store, copied and fabricated bindings or reads before inspecting unknown properties', async () => {
    const store = new ArtifactStore() as B1QuoteStore, saved = register(store);
    const binding = store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page()}), resolution = await read(store, saved.id);
    expect(binding).toBeDefined();
    const other = new ArtifactStore() as B1QuoteStore; register(other);
    expect(other.matchesQuoteProjectionRead(binding, resolution)).toBe(false);
    let inspected = 0; const trap = () => {inspected++; throw new Error('Unknown quote binding/read must remain opaque');};
    const getter = Object.defineProperties({}, {kind: {get: trap}, record: {get: trap}, status: {get: trap}});
    const proxy = new Proxy({}, {get: trap, ownKeys: trap, getPrototypeOf: trap});
    const revoked = Proxy.revocable({}, {get: trap}); revoked.revoke();
    for (const fake of [{kind: 'prepared_quote_projection'}, {...binding}, JSON.parse(JSON.stringify(binding)), getter, proxy, revoked.proxy, null]) {
      expect(store.matchesQuoteProjectionRead(fake, resolution)).toBe(false);
    }
    for (const fake of [{...resolution}, JSON.parse(JSON.stringify(resolution)), {status: 'missing'}, getter, proxy, revoked.proxy, undefined]) {
      expect(store.matchesQuoteProjectionRead(binding, fake)).toBe(false);
    }
    expect(inspected).toBe(0);
  });
});
