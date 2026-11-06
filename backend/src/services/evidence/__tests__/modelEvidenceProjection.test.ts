// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import * as capture from '../evidenceCapture';
import {captureEvidenceTable, MODEL_EVIDENCE_STRING_MAX_BYTES,
  MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT, MODEL_EVIDENCE_UNIT_MAX_BYTES,
  projectEvidenceCaptureMetadataForModel, projectEvidenceTableForModel} from '../evidenceCapture';
import {projectModelEvidenceMetadata} from '../modelEvidenceMetadata';
import {stringifyRuntimeToolResult} from '../../../agentRuntime/runtimeToolSpec';
import {createRuntimeToolResult} from '../../../agentRuntime/runtimeToolResult';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import type {CapturedFieldSemantics} from '../evidenceCapture';

describe('model evidence projection', () => {
  it('separates row readability, some issued column units and absent metric binding', () => {
    const data = {columns: ['dur', 'name', 'duration_ms'], rows: [[33000000, 'task', 33]]};
    const witness = captureEvidenceTable(data, {dur: {unit: 'ns',
      origin: {kind: 'native_producer', definitionFingerprint: 'PRIVATE_FINGERPRINT'}}});
    const projected = projectModelEvidenceMetadata({...data, columnUnits: {duration_ms: 'ms'},
      modelEvidence: {registeredMetricBinding: 'present'}}, witness);
    expect(projected).toEqual({columnUnits: {dur: 'ns'}, modelEvidence: {
      captureRows: 'available', columnUnits: 'available', registeredMetricBinding: 'absent'}});
    expect(projectEvidenceCaptureMetadataForModel(data, witness).columnUnits).toEqual(projected.columnUnits);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_FINGERPRINT|verified|proofEligible/);
    expect(data.rows).toEqual([[33000000, 'task', 33]]);
  });

  it('keeps a genuine empty capture distinct from absent rows and preserves typed partial strings', () => {
    const empty = {columns: ['value'], rows: []};
    expect(projectModelEvidenceMetadata(empty, captureEvidenceTable(empty)).modelEvidence)
      .toEqual({captureRows: 'empty', columnUnits: 'unknown', registeredMetricBinding: 'absent'});
    expect(projectModelEvidenceMetadata(empty).modelEvidence)
      .toEqual({captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'});
    const original = {columns: ['text', 'value'], rows: [['中'.repeat(5000), 1]]};
    const witness = captureEvidenceTable(original);
    const projection = projectEvidenceTableForModel(original, witness);
    expect(projection.modelProjection.status).toBe('truncated');
    expect(projectModelEvidenceMetadata(projection.data, witness).modelEvidence.captureRows).toBe('available');
    expect(projection.modelProjection.status).toBe('truncated');
  });

  it.each(['unissued', 'unavailable', 'changed_rows', 'duplicate_columns', 'column_mismatch', 'unsupported_cell'] as const)
  ('does not recover readable/issued metadata from an invalid projection: %s', kind => {
    const data = {columns: ['dur'], rows: [[1]]};
    const origin = {kind: 'native_producer' as const, definitionFingerprint: 'private'};
    const witness = kind === 'unissued' ? {captureId: 'forged'} : kind === 'unavailable'
      ? captureEvidenceTable(undefined, {}, 'missing')
      : captureEvidenceTable({columns: ['dur'], rows: [[kind === 'changed_rows' ? 2 : kind === 'unsupported_cell' ? undefined : 1]]},
        {dur: {origin, unit: 'ns'}});
    const display = kind === 'duplicate_columns' ? {columns: ['dur', 'dur'], rows: [[1, 1]]}
      : kind === 'column_mismatch' ? {columns: ['other'], rows: [[1]]} : data;
    expect(projectModelEvidenceMetadata({...display, columnUnits: {dur: 'ns'},
      modelEvidence: {captureRows: 'available', registeredMetricBinding: 'present'}}, witness))
      .toEqual({modelEvidence: {captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
    expect(projectEvidenceCaptureMetadataForModel(display, witness).columnUnits).toBeUndefined();
  });

  it('keeps unsafe or untrusted units unknown rather than inferring them from numeric-looking aliases', () => {
    const data = {columns: ['unsafe_ms', 'untrusted_ns'], rows: [[1, 2]]};
    const witness = captureEvidenceTable(data, {
      unsafe_ms: {unit: 'ms\nPRIVATE', origin: {kind: 'skill_literal', definitionFingerprint: 'valid'}},
      untrusted_ns: {unit: 'ns', origin: {kind: 'native_producer', definitionFingerprint: ''}},
    });
    expect(projectModelEvidenceMetadata(data, witness)).toEqual({modelEvidence: {
      captureRows: 'available', columnUnits: 'unknown', registeredMetricBinding: 'absent'}});
  });

  it('contains only metadata calculation failures without changing input data', () => {
    const data = {columns: ['value'], rows: [[1]]};
    const projection = jest.spyOn(capture, 'projectEvidenceCaptureMetadataForModel')
      .mockImplementation(() => {throw new Error('PRIVATE_METADATA_ERROR');});
    try {
      expect(projectModelEvidenceMetadata(data)).toEqual({modelEvidence: {
        captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}});
      expect(data.rows).toEqual([[1]]);
    } finally {projection.mockRestore();}
  });

  it('measures additive metadata at the actual production tool serialization boundary', () => {
    const data = {columns: ['duration_ms', 'label'], rows: [[33, '中"\\\n']]};
    const available = projectModelEvidenceMetadata(data, captureEvidenceTable(data));
    const empty = {columns: data.columns, rows: []};
    const payloads = [
      {surface: 'raw_inline', payload: {success: true, ...data, totalRows: 1}, metadata: available},
      {surface: 'summary', payload: {success: true, totalRows: 1, columns: data.columns, sampleRows: data.rows}, metadata: available},
      {surface: 'artifact_page', payload: {id: 'art-1', columns: data.columns, rows: [{rowIndex: 0, values: data.rows[0]}], totalRows: 1, hasMore: false}, metadata: available},
      {surface: 'empty_capture', payload: {success: true, ...empty, totalRows: 0},
        metadata: projectModelEvidenceMetadata(empty, captureEvidenceTable(empty))},
      {surface: 'restored_without_witness', payload: {id: 'art-1', ...data}, metadata: projectModelEvidenceMetadata(data)},
    ];
    for (const {surface, payload, metadata} of payloads) {
      const before = Buffer.byteLength(stringifyRuntimeToolResult(createRuntimeToolResult(payload)));
      const after = Buffer.byteLength(stringifyRuntimeToolResult(createRuntimeToolResult({...payload, ...metadata})));
      expect(after - before).toBeGreaterThan(0);
      expect(after - before).toBeLessThan(256);
      console.info('[evidence-feedback serializer]', JSON.stringify({surface, beforeBytes: before, afterBytes: after, deltaBytes: after - before}));
    }
  });

  it('restores typed scalar cells in display column order', () => {
    const long = 'raw-'.repeat(40);
    const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['text', 'missing', 'enabled', 'count'],
      rows: [[long, null, false, 7]]}, {count: {origin, unit: 'ms'}});
    const display = {columns: ['enabled', 'text', 'missing'], rows: [['否', `${long.slice(0, 97)}...`, '-']]};
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected).toEqual({
      data: {columns: ['enabled', 'text', 'missing'], rows: [[false, long, null]]},
      modelProjection: {status: 'exact'},
    });
  });

  it('exposes only trusted explicit units without inferring percentage scale', () => {
    const trusted = {kind: 'skill_literal' as const, definitionFingerprint: 'fixture-v1', skillId: 'fixture'};
    const missingFingerprint = {kind: 'skill_literal' as const, definitionFingerprint: '', skillId: 'fixture'};
    const witness = captureEvidenceTable({columns: ['ttid_ms', 'busy_pct', 'ambiguous_pct', 'unsafe', 'untrusted'],
      rows: [[1912.2, 68.1, 0.3, 1, 2]]}, {
      ttid_ms: {origin: trusted, unit: 'ms'},
      busy_pct: {origin: trusted, unit: '%'},
      unsafe: {origin: trusted, unit: `x\n${'u'.repeat(MODEL_EVIDENCE_UNIT_MAX_BYTES)}`},
      untrusted: {origin: missingFingerprint, unit: 'ms'},
    });
    const projected = projectEvidenceTableForModel({
      columns: ['ambiguous_pct', 'busy_pct', 'ttid_ms', 'unsafe', 'untrusted'],
      rows: [['30%', '68.1%', '1912.20 ms', '1', '2']],
    }, witness);
    expect(projected.columnUnits).toEqual({busy_pct: '%', ttid_ms: 'ms'});
    expect(projected.columnUnits).not.toHaveProperty('ambiguous_pct');
    expect(projected.columnUnits).not.toHaveProperty('unsafe');
    expect(projected.columnUnits).not.toHaveProperty('untrusted');
  });

  it('bounds UTF-8 strings and caps truncation locators', () => {
    const raw = '中'.repeat(MODEL_EVIDENCE_STRING_MAX_BYTES);
    const columns = Array.from({length: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3}, (_, index) => `c${index}`);
    const witness = captureEvidenceTable({columns, rows: [columns.map(() => raw)]});
    const projected = projectEvidenceTableForModel({columns, rows: [columns.map(() => '中...')]}, witness);
    const first = (projected.data as {rows: string[][]}).rows[0][0];
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(MODEL_EVIDENCE_STRING_MAX_BYTES);
    expect(projected.modelProjection).toMatchObject({status: 'truncated',
      truncatedCellCount: MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT + 3,
      truncatedCellsOmitted: 3});
    expect(projected.modelProjection.truncatedCells).toHaveLength(MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT);
  });

  it.each([
    ['unissued_witness', undefined, {columns: ['value'], rows: [['-']]}],
    ['unavailable_witness', captureEvidenceTable(undefined, {}, 'unmapped'), {columns: ['value'], rows: [['-']]}],
    ['row_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null], [null]]}), {columns: ['value'], rows: [['-']]}],
    ['duplicate_columns', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['value', 'value'], rows: [['-', '-']]}],
    ['column_mismatch', captureEvidenceTable({columns: ['value'], rows: [[null]]}), {columns: ['other'], rows: [['-']]}],
    ['unsupported_raw_cell', captureEvidenceTable({columns: ['value'], rows: [[undefined]]}), {columns: ['value'], rows: [['-']]},],
  ] as const)('fails closed without turning unknown cells into SQL NULL: %s', (reason, witness, display) => {
    const projected = projectEvidenceTableForModel(display, witness);
    expect(projected.data).toBe(display);
    expect(projected.modelProjection).toEqual({status: 'unavailable', reason});
  });

  it('rejects transformed and non-table display shapes', () => {
    const witness = captureEvidenceTable({columns: ['value'], rows: [[null]]});
    const display = {text: 'no data'};
    expect(projectEvidenceTableForModel(display, witness)).toEqual({data: display,
      modelProjection: {status: 'unavailable', reason: 'not_table'}});
  });
});

// Test-only future interface; the tests below still call the real ArtifactStore methods.
// Other B1 owning tests import only this erased type, never this suite's runtime fixtures.
export type B1QuoteStore = ArtifactStore & {
  prepareQuoteProjectionBinding(locator: {artifactId: string} | {evidenceRefId: string}, actual: {
    scope: {runId: string; allowedTraces: readonly {traceId: string; traceSide: 'current' | 'reference'}[]};
    page: {
      rows: readonly number[];
      columns: readonly string[];
      cells: readonly {rowIndex: number; column: string; value: unknown; unit?: string;
        availability: 'visible' | 'redacted' | 'unavailable'}[];
      page: {hasMore: 'yes' | 'no' | 'unknown'; coverage: 'visible_page_only'};
    };
  }): Readonly<{kind: 'prepared_quote_projection'}> | undefined;
  matchesQuoteProjectionRead(binding: unknown, resolution: unknown): boolean;
};
export type B1QuotePage = Parameters<B1QuoteStore['prepareQuoteProjectionBinding']>[1]['page'];
export type B1QuoteScope = Parameters<B1QuoteStore['prepareQuoteProjectionBinding']>[1]['scope'];

describe('B1 exact visible quote projection', () => {
  const scope: B1QuoteScope = {runId: 'b1-run', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]};
  const origin: CapturedFieldSemantics['origin'] = {kind: 'skill_literal', skillId: 'fixture',
    definitionFingerprint: 'PRIVATE_B1_DEFINITION', selectedSqlHash: 'PRIVATE_B1_SQL'};
  function register(data: {columns: string[]; rows: unknown[][]}, fields: Record<string, CapturedFieldSemantics> = {}) {
    const store = new ArtifactStore() as B1QuoteStore;
    const witness = captureEvidenceTable(data, fields);
    const projected = projectEvidenceTableForModel(data, witness);
    const id = store.store({skillId: 'fixture', data: projected.data, modelProjection: projected.modelProjection,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(id, witness, {evidenceRefId: `b1:${id}`, originRunId: scope.runId})).toBe(true);
    return {store, id, witness, projected};
  }
  function page(value: unknown, options: {availability?: 'visible' | 'redacted' | 'unavailable'; unit?: string} = {}): B1QuotePage {
    return {rows: [0], columns: ['metric'], cells: [{rowIndex: 0, column: 'metric', value,
      availability: options.availability ?? 'visible', ...(options.unit === undefined ? {} : {unit: options.unit})}],
      page: {hasMore: 'no', coverage: 'visible_page_only'}};
  }
  async function issued(store: ArtifactStore, id: string) {
    const [resolution] = await store.createEvidenceReadView({ownerKey: 'b1-reader', currentRunId: scope.runId,
      allowedTraces: scope.allowedTraces}).resolveReferences([
      {key: id, reference: {artifactId: id, rowIndex: 0, column: 'metric'}, requiredColumns: ['metric']},
    ]);
    return resolution;
  }

  it.each([4, 0, null, '9007199254740993', '1.00', '1e-9'])('preserves the actual JSON-visible scalar %p without numerical coercion', async value => {
    const data = {columns: ['metric'], rows: [[value]]}, saved = register(data);
    const visible = page(value), payloadBefore = stringifyRuntimeToolResult(createRuntimeToolResult({...saved.projected}));
    const binding = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: visible});
    expect(binding).toMatchObject({kind: 'prepared_quote_projection'});
    const resolution = await issued(saved.store, saved.id);
    expect(resolution).toMatchObject({status: 'resolved', row: {metric: value}});
    expect(saved.store.matchesQuoteProjectionRead(binding, resolution)).toBe(true);
    expect(Object.is(visible.cells[0].value, value)).toBe(true);
    expect(stringifyRuntimeToolResult(createRuntimeToolResult({...saved.projected}))).toBe(payloadBefore);
  });

  it.each([
    ['different-number', 4, 11], ['numeric-string-coerced', '9007199254740993', 9007199254740992],
    ['null-to-zero', null, 0], ['negative-zero-lost', -0, 0], ['negative-zero-not-JSON-exact', -0, -0],
    ['boolean', true, true], ['plain-text', 'private text', 'private text'], ['nonfinite', Infinity, Infinity],
  ] as const)('rejects a visible scalar that cannot preserve actual capture and JSON identity: %s', (_label, raw, visible) => {
    const saved = register({columns: ['metric'], rows: [[raw]]});
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(visible)})).toBeUndefined();
  });

  it.each(['unavailable', 'redacted'] as const)('retains explicit %s positions without inspecting or cloning their arbitrary values', async availability => {
    const saved = register({columns: ['metric'], rows: [[{private: 'UNQUOTABLE_PRIVATE_OBJECT'}]]});
    let inspected = 0;
    const trap = () => {inspected++; throw new Error('Bad cell contents must not be inspected');};
    const [metadata] = await saved.store.createEvidenceReadView({ownerKey: 'b1-metadata', allowedTraces: scope.allowedTraces})
      .resolveReferences([{key: 'metadata', reference: {artifactId: saved.id}, requiredColumns: [], metadataOnly: true}]);
    expect(metadata.status).toBe('resolved');
    const values = [Object.defineProperty({}, 'private', {enumerable: true, get: trap}),
      new Proxy({}, {get: trap, ownKeys: trap, getPrototypeOf: trap})];
    for (const value of values) {
      const binding = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(value, {availability})});
      expect(binding).toMatchObject({kind: 'prepared_quote_projection'});
      expect(saved.store.matchesQuoteProjectionRead(binding, metadata)).toBe(true);
      expect(JSON.stringify(binding)).not.toMatch(/UNQUOTABLE_PRIVATE_OBJECT|metric|rowIndex|value/);
    }
    expect(inspected).toBe(0);
    // This is only entry identity; C must reject selection of this unavailable/redacted cell.
  });

  it('rejects a truncated numeric string labelled visible while keeping the actual payload unchanged', () => {
    const raw = '1'.repeat(MODEL_EVIDENCE_STRING_MAX_BYTES + 20);
    const saved = register({columns: ['metric'], rows: [[raw]]});
    const visible = (saved.projected.data as {rows: unknown[][]}).rows[0][0];
    expect(saved.projected.modelProjection.status).toBe('truncated');
    expect(visible).not.toBe(raw);
    const before = stringifyRuntimeToolResult(createRuntimeToolResult({...saved.projected}));
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(visible)})).toBeUndefined();
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id},
      {scope, page: page(visible, {availability: 'unavailable'})})).toBeDefined();
    expect(stringifyRuntimeToolResult(createRuntimeToolResult({...saved.projected}))).toBe(before);
  });

  it('accepts only already-visible safe producer units and does not copy hidden descriptor fields', async () => {
    const fields = {metric: {origin, unit: 'ms', metricId: 'PRIVATE_B1_METRIC', aggregation: 'PRIVATE_B1_AGGREGATION',
      populationKey: 'PRIVATE_B1_POPULATION'}};
    const saved = register({columns: ['metric'], rows: [[4]]}, fields);
    expect(saved.projected.columnUnits).toEqual({metric: 'ms'});
    const withUnit = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id},
      {scope, page: page(4, {unit: saved.projected.columnUnits!.metric})});
    const withoutUnit = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(4)});
    expect(withUnit).toBeDefined(); expect(withoutUnit).toBeDefined();
    const resolution = await issued(saved.store, saved.id);
    expect(saved.store.matchesQuoteProjectionRead(withUnit, resolution)).toBe(true);
    expect(saved.store.matchesQuoteProjectionRead(withoutUnit, resolution)).toBe(true);
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(4, {unit: 'us'})})).toBeUndefined();
    expect(JSON.stringify({withUnit, withoutUnit, visible: saved.projected})).not.toMatch(/PRIVATE_B1_|populationKey|aggregation|metricId|definitionFingerprint/);
  });

  it.each([
    ['line\nbreak', origin.definitionFingerprint], ['u'.repeat(MODEL_EVIDENCE_UNIT_MAX_BYTES + 1), origin.definitionFingerprint],
    ['ms', ''],
  ])('does not restore an unsafe or unauthenticated private unit %p', (unsafeUnit, definitionFingerprint) => {
    const saved = register({columns: ['metric'], rows: [[4]]}, {metric: {origin: {...origin, definitionFingerprint}, unit: unsafeUnit}});
    expect(saved.projected.columnUnits).toBeUndefined();
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(4)})).toBeDefined();
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: page(4, {unit: unsafeUnit})})).toBeUndefined();
  });

  it('keeps a mixed producer page intact and leaves its explicitly unavailable row for C to reject if selected', async () => {
    const saved = register({columns: ['metric'], rows: [[4], [true]]});
    const visible: B1QuotePage = {rows: [0, 1], columns: ['metric'], cells: [
      {rowIndex: 0, column: 'metric', value: 4, availability: 'visible'},
      {rowIndex: 1, column: 'metric', value: true, availability: 'unavailable'},
    ], page: {hasMore: 'no', coverage: 'visible_page_only'}};
    const before = JSON.stringify(visible);
    const binding = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: visible});
    expect(binding).toBeDefined();
    expect(JSON.stringify(visible)).toBe(before);
    expect(visible.rows).toEqual([0, 1]); expect(visible.cells).toHaveLength(2);
    expect(saved.store.matchesQuoteProjectionRead(binding, await issued(saved.store, saved.id))).toBe(true);
    const mislabeled: B1QuotePage = {...visible, cells: visible.cells.map(cell => ({...cell, availability: 'visible'}))};
    expect(saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: mislabeled})).toBeUndefined();
    // No private page reader is exposed here; complete selected-component availability is C's separate gate.
  });

  it('does not put hidden-row truncation coordinates, lengths or values into the page binding', async () => {
    const hidden = 'PRIVATE_B1_HIDDEN'.repeat(1000), saved = register({columns: ['metric'], rows: [[4], [hidden]]});
    expect(saved.projected.modelProjection).toMatchObject({status: 'truncated', truncatedCells: [{rowIndex: 1}]});
    const visiblePage: B1QuotePage = {...page(4), page: {hasMore: 'unknown', coverage: 'visible_page_only'}};
    const binding = saved.store.prepareQuoteProjectionBinding({artifactId: saved.id}, {scope, page: visiblePage});
    expect(binding).toBeDefined();
    expect(saved.store.matchesQuoteProjectionRead(binding, await issued(saved.store, saved.id))).toBe(true);
    const serialized = JSON.stringify({binding, page: visiblePage});
    expect(serialized).not.toMatch(/PRIVATE_B1_HIDDEN|truncatedCells|originalBytes|totalRows|totalRowCount/);
    expect(serialized).not.toContain(String(Buffer.byteLength(hidden)));
    expect(visiblePage.rows).toEqual([0]); expect(visiblePage.page.hasMore).toBe('unknown');
  });
});
