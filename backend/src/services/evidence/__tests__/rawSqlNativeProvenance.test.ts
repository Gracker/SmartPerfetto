// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {createHash} from 'crypto';
import * as identity from '../../capabilityManifestRuntimeIdentity';
import * as docs from '../../perfettoSqlDocs';
import {beginRawSqlNativeQuery, createRawSqlNativeProvenance, initializeRawSqlNativeProvenance,
  invalidateRawSqlNativeProvenance, readRawSqlCaptureFields, readRawSqlNativeProvenanceSnapshot,
  revalidateRawSqlNativeProvenance, sealRawSqlNativeQuery, readRawSqlCaptureMetadata,
  resolveRawSqlNativeRowSchema} from '../rawSqlNativeProvenance';
import {captureEvidenceTable, captureRawSqlEvidence, capturedNativeRow, capturedEvidenceTable} from '../evidenceCapture';

const revision = 'a'.repeat(40);
const binary = {source: 'local_binary' as const, selectedPath: '/pinned/trace_processor_shell', selectionOrigin: 'default' as const};
const bootstrapSql = 'INCLUDE PERFETTO MODULE android.frames.timeline;';
const columns = [{name: 'id', type: 'ID'}, {name: 'dur', type: 'DURATION'}, {name: 'ts', type: 'TIMESTAMP'}];
const asset = {version: 1, generatedFrom: revision, modules: [], symbolToModule: {}, entries: [
  {id: 'slice', name: 'slice', type: 'view' as const, category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns},
]};

describe('raw SQL native provenance', () => {
  beforeEach(() => {
    jest.spyOn(identity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(docs, 'loadPerfettoSqlDocsAsset').mockReturnValue(asset);
  });
  afterEach(() => {jest.restoreAllMocks();});

  async function ready(processorId = 'processor-a') {
    const native = createRawSqlNativeProvenance(processorId, [bootstrapSql]);
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    return native;
  }
  function capture(native: Awaited<ReturnType<typeof ready>>, sql = 'SELECT dur FROM slice', outputColumns = ['dur']) {
    const result = {columns: outputColumns, rows: [[42]], durationMs: 1};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, sql), result);
    return result;
  }

  it('signs only formal duration fields with the actual SQL hash, never timestamp or clock semantics', async () => {
    const native = await ready();
    const sql = 'SELECT dur AS elapsed, ts FROM main.slice';
    const result = {columns: ['elapsed', 'ts'], rows: [[42, 100]], durationMs: 1};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, sql), result);
    const fields = readRawSqlCaptureFields(result)!;
    expect(Object.keys(fields)).toEqual(['elapsed']);
    expect(fields.elapsed).toEqual({unit: 'ns', origin: {kind: 'native_producer',
      definitionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      selectedSqlHash: createHash('sha256').update(sql).digest('hex').slice(0, 12)}});
    expect(JSON.stringify(result)).not.toContain('native_producer');
    fields.elapsed.unit = 'ms';
    expect(readRawSqlCaptureFields(result)?.elapsed.unit).toBe('ns');
  });

  it('rejects JSON/spread/forged metadata and in-place result changes', async () => {
    const result = capture(await ready());
    expect(readRawSqlCaptureFields(result)).toBeDefined();
    expect(readRawSqlCaptureFields({...result})).toBeUndefined();
    expect(readRawSqlCaptureFields(JSON.parse(JSON.stringify(result)))).toBeUndefined();
    expect(readRawSqlCaptureFields({...result, fields: readRawSqlCaptureFields(result)})).toBeUndefined();
    result.rows[0][0] = 43;
    expect(readRawSqlCaptureFields(result)).toBeUndefined();
  });

  it('keeps native duration and row authority for a simple query after a benign nested SELECT', async () => {
    const native = createRawSqlNativeProvenance('nested-read', [bootstrapSql], 'trace');
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    const nested = {columns: ['track_id'], rows: [[458]], durationMs: 1};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance,
      'SELECT t.id AS track_id FROM track t WHERE t.id = (SELECT track_id FROM slice WHERE id = 50220)'), nested);
    expect(readRawSqlNativeProvenanceSnapshot(native.provenance).status).toBe('trusted');
    expect(readRawSqlCaptureMetadata(nested)).toBeUndefined();
    const direct = {columns: ['id', 'dur'], rows: [[50220, 33000000]], durationMs: 1};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, 'SELECT id, dur FROM slice WHERE id = 50220'), direct);
    const witness = captureRawSqlEvidence(direct, {traceId: 'trace', traceSide: 'current'});
    expect(capturedEvidenceTable(witness)?.fields.dur).toMatchObject({unit: 'ns', origin: {kind: 'native_producer'}});
    expect(capturedNativeRow(witness, 0)).toMatchObject({relation: 'slice', id: 50220, traceId: 'trace', traceSide: 'current'});
    expect(readRawSqlCaptureMetadata({...direct})).toBeUndefined();
    expect(readRawSqlCaptureMetadata(JSON.parse(JSON.stringify(direct)))).toBeUndefined();
  });

  it.each(['SELECT dur FROM slice WHERE id = (SELECT run_metric(?))',
    'SELECT dur FROM slice WHERE id IN (SELECT run_metric(?))',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice; SELECT run_metric(?))'])
  ('revokes all later native proof before executing an opaque nested query: %s', async sql => {
    const native = await ready();
    beginRawSqlNativeQuery(native.provenance, sql);
    expect(readRawSqlNativeProvenanceSnapshot(native.provenance).status).toBe('tainted');
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
  });

  it('handles prototype-named aliases as data keys', async () => {
    const result = capture(await ready(), 'SELECT dur AS "__proto__" FROM slice', ['__proto__']);
    const fields = readRawSqlCaptureFields(result)!;
    expect(Object.keys(fields)).toEqual(['__proto__']);
    expect(fields.__proto__.unit).toBe('ns');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('retains only clone eligibility after exposure and revokes it if the launch identity changes', async () => {
    const native = createRawSqlNativeProvenance('exposed-before-ready', [bootstrapSql]);
    invalidateRawSqlNativeProvenance(native.provenance);
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    expect(readRawSqlNativeProvenanceSnapshot(native.provenance)).toEqual({status: 'tainted', nativeSchemaEligible: true});
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
    const snapshot = readRawSqlNativeProvenanceSnapshot(native.provenance);
    (snapshot as {status: string}).status = 'trusted';
    expect(readRawSqlNativeProvenanceSnapshot(native.provenance).status).toBe('tainted');
    jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'custom', binarySha256: 'b'.repeat(64)});
    await revalidateRawSqlNativeProvenance(native.provenance, binary);
    expect(readRawSqlNativeProvenanceSnapshot(native.provenance)).toEqual({status: 'tainted', nativeSchemaEligible: false});
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
  });

  it.each(['CREATE VIEW shadow AS SELECT 1', bootstrapSql, 'SELECT RUN_METRIC(\'custom.sql\')',
    'WITH slice AS (SELECT 1 AS dur) SELECT dur FROM slice'])('permanently loses provenance before executing %s', async sql => {
    const native = await ready();
    beginRawSqlNativeQuery(native.provenance, sql);
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    beginRawSqlNativeQuery(native.provenance, bootstrapSql, native.bootstrapCapability);
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
  });

  it('allows only the private capability for this processor and exact bootstrap SQL', async () => {
    const native = await ready();
    beginRawSqlNativeQuery(native.provenance, bootstrapSql, native.bootstrapCapability);
    expect(readRawSqlCaptureFields(capture(native))).toBeDefined();
    const other = await ready('processor-b');
    beginRawSqlNativeQuery(other.provenance, bootstrapSql, native.bootstrapCapability);
    expect(readRawSqlCaptureFields(capture(other))).toBeUndefined();
    const forged = await ready('processor-c');
    beginRawSqlNativeQuery(forged.provenance, bootstrapSql, JSON.parse(JSON.stringify(forged.bootstrapCapability)));
    expect(readRawSqlCaptureFields(capture(forged))).toBeUndefined();
  });

  it('rejects a response spanning a provenance epoch change', async () => {
    const native = await ready();
    const ticket = beginRawSqlNativeQuery(native.provenance, 'SELECT dur FROM slice');
    invalidateRawSqlNativeProvenance(native.provenance);
    const result = {columns: ['dur'], rows: [[42]]};
    sealRawSqlNativeQuery(ticket, result);
    expect(readRawSqlCaptureFields(result)).toBeUndefined();
    expect(readRawSqlCaptureFields(capture(await ready('new-instance')))).toBeDefined();
  });

  it('never revives a processor exposed while its initial identity read was pending', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof identity.resolveCapabilityTraceProcessorIdentity>>) => void;
    jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockReturnValueOnce(new Promise(done => {resolve = done;}));
    const native = createRawSqlNativeProvenance('warming', [bootstrapSql]);
    const initializing = initializeRawSqlNativeProvenance(native.provenance, binary);
    invalidateRawSqlNativeProvenance(native.provenance);
    resolve({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    await initializing;
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
  });

  it('revokes a changed launch identity and never upgrades a previously unknown identity', async () => {
    const native = await ready();
    jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'custom', binarySha256: 'b'.repeat(64)});
    await revalidateRawSqlNativeProvenance(native.provenance, binary);
    expect(readRawSqlCaptureFields(capture(native))).toBeUndefined();
    const unknown = await ready('initially-custom');
    jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    await revalidateRawSqlNativeProvenance(unknown.provenance, binary);
    expect(readRawSqlCaptureFields(capture(unknown))).toBeUndefined();
  });

  it.each(['custom', 'doc-mismatch', 'stdlib-mismatch', 'no-schema'])('leaves %s identity unavailable', async reason => {
    if (reason === 'custom') jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'custom', binarySha256: 'b'.repeat(64)});
    if (reason === 'doc-mismatch') jest.mocked(docs.loadPerfettoSqlDocsAsset).mockReturnValue({...asset, generatedFrom: 'b'.repeat(40)});
    if (reason === 'stdlib-mismatch') jest.mocked(identity.resolveCapabilityTraceProcessorIdentity).mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: 'b'.repeat(40)});
    if (reason === 'no-schema') jest.mocked(docs.loadPerfettoSqlDocsAsset).mockReturnValue(null);
    expect(readRawSqlCaptureFields(capture(await ready()))).toBeUndefined();
  });

  it('derives a scaled duration from its formal native operand, not its output name', async () => {
    const native = await ready();
    expect(readRawSqlCaptureFields(capture(native, 'SELECT dur / 1000000 AS elapsed FROM slice', ['elapsed']))?.elapsed)
      .toMatchObject({unit: 'ms', origin: {kind: 'native_producer'}});
    expect(readRawSqlCaptureFields(capture(native, 'SELECT dur / 1000000 AS unrelated FROM slice', ['unrelated']))?.unrelated.unit).toBe('ms');
    expect(readRawSqlCaptureFields(capture(native, 'SELECT id / 1000000 AS elapsed_ms FROM slice', ['elapsed_ms']))).toBeUndefined();
    expect(readRawSqlCaptureFields(capture(native, 'SELECT 42 / 1000000 AS dur_ms FROM slice', ['dur_ms']))).toBeUndefined();
    expect(readRawSqlCaptureFields(capture(native, 'SELECT dur FROM slice', ['unexpected']))).toBeUndefined();
    expect(readRawSqlCaptureFields(capture(native))).toBeDefined();
  });

  it.each([
    ['COUNT(*)', 'count'], ['SUM(dur)', 'ns'], ['AVG(dur)', 'ns'], ['MIN(dur)', 'ns'], ['MAX(dur)', 'ns'],
    ['SUM(MIN(ts + dur, 100000000) - MAX(ts, 0))', 'ns'],
  ])('signs the sealed %s quantity without signing a native row identity', async (expression, unit) => {
    const native = await ready();
    const sql = `SELECT ${expression} AS quantity FROM slice`;
    const result = capture(native, sql, ['quantity']);
    const metadata = readRawSqlCaptureMetadata(result)!;
    expect(metadata.fields.quantity).toMatchObject({unit, origin: {kind: 'native_producer',
      definitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      selectedSqlHash: createHash('sha256').update(sql).digest('hex').slice(0, 12)}});
    expect(metadata.fields.quantity).not.toHaveProperty('clock');
    expect(metadata.fields.quantity).not.toHaveProperty('timeRole');
    expect(metadata.nativeRows).toEqual([]);
    expect(readRawSqlCaptureMetadata(structuredClone(result))).toBeUndefined();
    result.rows[0][0] = 43;
    expect(readRawSqlCaptureMetadata(result)).toBeUndefined();
  });

  it('does not lend aggregate authority to an unpinned view, a changed epoch or unsupported CASE', async () => {
    const native = await ready();
    expect(readRawSqlCaptureFields(capture(native, 'SELECT COUNT(*) AS n FROM unknown_view', ['n']))).toBeUndefined();
    const query = beginRawSqlNativeQuery(native.provenance, 'SELECT SUM(dur) AS quantity FROM slice');
    invalidateRawSqlNativeProvenance(native.provenance);
    const result = {columns: ['quantity'], rows: [[42]]};
    sealRawSqlNativeQuery(query, result);
    expect(readRawSqlCaptureMetadata(result)).toBeUndefined();
    const other = await ready('case');
    expect(beginRawSqlNativeQuery(other.provenance, 'SELECT SUM(CASE WHEN dur > 0 THEN 1 ELSE 0 END) AS n FROM slice')).toBeUndefined();
    expect(readRawSqlNativeProvenanceSnapshot(other.provenance).status).toBe('tainted');
  });

  async function nativeResult(sql: string, outputColumns: string[], rows: unknown[][], traceId: string | undefined = 'trace-a') {
    const native = createRawSqlNativeProvenance('native-row-processor', [], traceId);
    await initializeRawSqlNativeProvenance(native.provenance, binary);
    const result = {columns: outputColumns, rows};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, sql), result);
    return {result, native};
  }

  it('uses canonical formal schema identity independent of query, alias or processor', async () => {
    const pinned = {source: 'bundled' as const, gitRevision: revision, stdlibRevision: revision};
    const schema = resolveRawSqlNativeRowSchema(pinned, asset, 'SLICE')!;
    expect(schema).toEqual({relation: 'slice', idColumn: 'id', schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)});
    const direct = await nativeResult('SELECT id, dur, ts + dur AS end_ts FROM slice', ['id', 'dur', 'end_ts'], [[7, 42, 100]]);
    const aliased = await nativeResult('SELECT s.id AS event_id, s.dur AS elapsed FROM main.slice s', ['event_id', 'elapsed'], [[7, 42]]);
    expect(readRawSqlCaptureMetadata(direct.result)?.nativeRows).toEqual([{...schema, traceId: 'trace-a', outputColumn: 'id', id: 7}]);
    expect(readRawSqlCaptureMetadata(aliased.result)?.nativeRows).toEqual([{...schema, traceId: 'trace-a', outputColumn: 'event_id', id: 7}]);
    expect(readRawSqlCaptureFields(direct.result)?.dur.unit).toBe('ns');
    expect(readRawSqlCaptureFields(direct.result)?.end_ts).toBeUndefined();
    expect(resolveRawSqlNativeRowSchema({...pinned, gitRevision: 'b'.repeat(40)}, asset, 'slice')).toBeUndefined();
    expect(resolveRawSqlNativeRowSchema({source: 'custom', binarySha256: 'c'.repeat(64)}, asset, 'slice')).toBeUndefined();
    expect(resolveRawSqlNativeRowSchema(pinned, {...asset, entries: [...asset.entries, asset.entries[0]]}, 'slice')).toBeUndefined();
  });

  it.each([
    ['SELECT 7 AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT id + 0 AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT ts AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT dur FROM slice WHERE id = 7', ['dur']],
    ['SELECT id, max(dur) AS dur FROM slice', ['id', 'dur']],
  ] as [string, string[]][])('cannot manufacture a native ID from %s', async (sql, outputColumns) => {
    const {result} = await nativeResult(sql, outputColumns, [outputColumns.length === 1 ? [42] : [7, 42]]);
    expect(readRawSqlCaptureMetadata(result)?.nativeRows.some(Boolean) ?? false).toBe(false);
  });

  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', true])('does not sign invalid ID %j', async id => {
    const {result} = await nativeResult('SELECT id, dur FROM slice', ['id', 'dur'], [[id, 42]]);
    expect(readRawSqlCaptureMetadata(result)?.nativeRows).toEqual([undefined]);
  });

  it.each([
    {schemaColumns: [{name: 'id', type: 'ID'}, {name: 'utid', type: 'ID'}, {name: 'dur', type: 'DURATION'}]},
    {schemaColumns: [{name: 'id', type: 'JOINID(slice.id)'}, {name: 'dur', type: 'DURATION'}]},
  ])('rejects multi-ID and JOINID formal relations', async ({schemaColumns}) => {
    jest.mocked(docs.loadPerfettoSqlDocsAsset).mockReturnValue({...asset,
      entries: [{...asset.entries[0], columns: schemaColumns}]});
    const {result} = await nativeResult('SELECT id, dur FROM slice', ['id', 'dur'], [[7, 42]]);
    expect(readRawSqlCaptureMetadata(result)?.nativeRows).toEqual([]);
  });

  it('binds raw captures to the actual trace and never restores row authority from JSON, spread, fields or tampering', async () => {
    const {result} = await nativeResult('SELECT id, dur FROM slice', ['id', 'dur'], [[0, 42]]);
    const context = {traceId: 'trace-a', traceSide: 'reference' as const};
    const signed = capturedNativeRow(captureRawSqlEvidence(result, context), 0)!;
    expect(signed).toMatchObject({id: 0, relation: 'slice', idColumn: 'id', traceSide: 'reference'});
    expect(capturedNativeRow(captureEvidenceTable(result, readRawSqlCaptureFields(result)), 0)).toBeUndefined();
    for (const copy of [{...result}, JSON.parse(JSON.stringify(result)), {...result, nativeRows: [signed]}]) {
      expect(capturedNativeRow(captureRawSqlEvidence(copy, context), 0)).toBeUndefined();
    }
    expect(capturedNativeRow(captureRawSqlEvidence(result, {...context, traceId: 'other'}), 0)).toBeUndefined();
    expect(capturedEvidenceTable(captureRawSqlEvidence(result, {...context, traceId: 'other'}))?.fields).toEqual({});
    expect(capturedEvidenceTable(captureRawSqlEvidence(result, {...context, traceId: 'other'}))?.unavailableReason).toBe('trace_capture_mismatch');
    const unbound = createRawSqlNativeProvenance('no-trace-id', []);
    await initializeRawSqlNativeProvenance(unbound.provenance, binary);
    const noTrace = {columns: ['id', 'dur'], rows: [[0, 42]]};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(unbound.provenance, 'SELECT id, dur FROM slice'), noTrace);
    expect(capturedNativeRow(captureRawSqlEvidence(noTrace, context), 0)).toBeUndefined();
    result.rows[0][0] = 9;
    expect(capturedNativeRow(captureRawSqlEvidence(result, context), 0)).toBeUndefined();
  });

  it('does not issue a row when mutation changes the epoch while the query is in flight', async () => {
    const {native} = await nativeResult('SELECT id FROM slice', ['id'], [[7]]);
    const query = beginRawSqlNativeQuery(native.provenance, 'SELECT id, dur FROM slice');
    invalidateRawSqlNativeProvenance(native.provenance);
    const result = {columns: ['id', 'dur'], rows: [[7, 42]]};
    sealRawSqlNativeQuery(query, result);
    expect(readRawSqlCaptureMetadata(result)).toBeUndefined();
  });
});
