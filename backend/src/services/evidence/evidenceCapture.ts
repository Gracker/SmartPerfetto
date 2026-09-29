// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash, randomUUID} from 'crypto';
import {readRawSqlCaptureMetadata, type RawSqlNativeRow} from './rawSqlNativeProvenance';

export type EvidenceScalar = string | number | boolean | null;
export interface CapturedFieldSemantics {
  origin: {kind: 'skill_literal' | 'native_producer'; definitionFingerprint: string;
    skillId?: string; stepId?: string; selectedSqlHash?: string};
  unit?: string;
  timeRole?: 'start' | 'end' | 'duration';
  clock?: 'trace_monotonic';
  /** Issued by a validated producer declaration, never inferred from a column name. */
  identityRole?: 'upid' | 'utid' | 'cpu' | 'ucpu' | 'machine_id';
  metricId?: string;
  aggregation?: string;
  populationKey?: string;
}
export interface EvidenceTableWitness {readonly captureId: string}
export interface CapturedNativeRow extends RawSqlNativeRow {
  readonly traceSide: 'current' | 'reference';
}
export interface CapturedEvidenceTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (EvidenceScalar | undefined)[])[];
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
  readonly unavailableReason?: string;
}
export interface CapturedAnchorFacts {
  readonly captureId: string;
  readonly originalRowIndex: number;
  readonly referenceKey?: string;
  readonly queryHash?: string;
  readonly row: Readonly<Record<string, EvidenceScalar>>;
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
  readonly nativeRow?: CapturedNativeRow;
}

export const MODEL_EVIDENCE_STRING_MAX_BYTES = 4096;
export const MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT = 32;
export const MODEL_EVIDENCE_UNIT_MAX_BYTES = 64;

export type ModelEvidenceProjectionUnavailableReason =
  | 'not_table'
  | 'unissued_witness'
  | 'unavailable_witness'
  | 'row_mismatch'
  | 'duplicate_columns'
  | 'column_mismatch'
  | 'unsupported_raw_cell';

export interface ModelEvidenceProjectionStatus {
  status: 'exact' | 'truncated' | 'unavailable';
  reason?: ModelEvidenceProjectionUnavailableReason;
  truncatedCellCount?: number;
  truncatedCells?: Array<{rowIndex: number; column: string; originalBytes: number}>;
  truncatedCellsOmitted?: number;
}

/**
 * Marker for model-visible results whose rows carry their own artifact-wide
 * index. A reordered sample or a page from a non-zero offset cannot be cited
 * by its position, so each row states the index a reference must name.
 */
export const INDEXED_ROW_SHAPE = 'indexed_rows@1';

/** A model-visible row with its zero-based index in the complete captured result. */
export interface IndexedEvidenceRow {
  rowIndex: number;
  values: unknown[];
}

/** Index a contiguous page whose first row is `firstRowIndex` in the complete result. */
export function indexEvidenceRows(page: readonly unknown[][], firstRowIndex: number): IndexedEvidenceRow[] {
  return page.map((values, position) => ({rowIndex: firstRowIndex + position, values}));
}

/** Pick rows of the complete result by index, in the given order (e.g. a reordered sample). */
export function indexEvidenceRowsAt(rows: readonly unknown[][], indices: readonly number[]): IndexedEvidenceRow[] {
  return indices.map(rowIndex => ({rowIndex, values: rows[rowIndex]}));
}

export interface ModelEvidenceProjection<T = unknown> {
  data: T;
  modelProjection: ModelEvidenceProjectionStatus;
  /** Model context only; proof authority remains in the issued witness. */
  columnUnits?: Readonly<Record<string, string>>;
}
const tables = new WeakMap<EvidenceTableWitness, CapturedEvidenceTable>();
const nativeRows = new WeakMap<EvidenceTableWitness, readonly (CapturedNativeRow | undefined)[]>();
const rawContexts = new WeakMap<EvidenceTableWitness, Readonly<{traceId: string; traceSide: 'current' | 'reference'}>>();
const owners = new WeakMap<object, EvidenceTableWitness>();
const anchorFacts = new WeakMap<object, CapturedAnchorFacts>();

export function freezeEvidenceValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeEvidenceValue);
    Object.freeze(value);
  }
  return value;
}

export function evidenceCaptureHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input && typeof input === 'object') return `{${Object.keys(input).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(input) ?? 'null';
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** A field's producer declaration; the origin is added by `nativeProducerFields`. */
export type DeclaredFieldSemantics = Omit<CapturedFieldSemantics, 'origin'>;

/**
 * Binds a native producer's declared fields to one fingerprint of the
 * definition that gives them meaning. The definition must contain everything
 * that does (producer, version, columns, declarations), so a change to any of
 * it yields a new fingerprint.
 */
export function nativeProducerFields(definition: unknown,
  declared: Readonly<Record<string, DeclaredFieldSemantics>>): Record<string, CapturedFieldSemantics> {
  const definitionFingerprint = evidenceCaptureHash(definition);
  return Object.fromEntries(Object.entries(declared).map(([column, field]) =>
    [column, {...field, origin: {kind: 'native_producer' as const, definitionFingerprint}}]));
}

export function captureEvidenceTable(data: unknown,
  fields: Record<string, CapturedFieldSemantics> = {}, unavailableReason?: string): EvidenceTableWitness {
  const witness = Object.freeze({captureId: randomUUID()});
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const rawRows = Array.isArray(data) ? data : Array.isArray(payload?.rows) ? payload.rows : undefined;
  const rawColumns = Array.isArray(payload?.columns) ? payload.columns : rawRows?.[0] &&
    typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0]) ? Object.keys(rawRows[0]) : [];
  const columns = rawColumns.filter((column): column is string => typeof column === 'string');
  const scalar = (value: unknown): EvidenceScalar | undefined => value === null || typeof value === 'string' ||
    typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
  const reason = unavailableReason || (!rawRows ? 'unmapped_evidence_shape' :
    columns.length !== rawColumns.length || columns.some(column => !column.trim()) ? 'invalid_evidence_columns' :
      rawRows.length > 0 && columns.length === 0 ? 'unmapped_evidence_columns' : undefined);
  const rows = (rawRows || []).map(row => columns.map((column, index) => scalar(Array.isArray(row)
    ? row[index] : row && typeof row === 'object' ? (row as Record<string, unknown>)[column] : undefined)));
  tables.set(witness, freezeEvidenceValue({columns: [...columns], rows,
    fields: structuredClone(fields), ...(reason ? {unavailableReason: reason} : {})}));
  return witness;
}

export function capturedEvidenceTable(witness: EvidenceTableWitness): CapturedEvidenceTable | undefined {
  return tables.get(witness);
}

function boundedModelString(value: string): {value: string; originalBytes?: number} {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= MODEL_EVIDENCE_STRING_MAX_BYTES) return {value};
  let retained = '';
  let retainedBytes = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (retainedBytes + bytes > MODEL_EVIDENCE_STRING_MAX_BYTES) break;
    retained += codePoint;
    retainedBytes += bytes;
  }
  return {value: retained, originalBytes};
}

interface DirectModelProjectionTable {
  display: Record<string, unknown>;
  columns: string[];
  displayRows: unknown[][];
  table: CapturedEvidenceTable;
  rawIndexes: number[];
}

function directModelProjectionTable<T>(displayData: T, witness?: EvidenceTableWitness):
  DirectModelProjectionTable | ModelEvidenceProjectionUnavailableReason {
  const display = displayData && typeof displayData === 'object' && !Array.isArray(displayData)
    ? displayData as Record<string, unknown> : undefined;
  const displayColumns = Array.isArray(display?.columns) ? display.columns : undefined;
  const displayRows = Array.isArray(display?.rows) ? display.rows : undefined;
  if (!displayColumns || !displayRows || displayColumns.some(column => typeof column !== 'string') ||
      displayRows.some(row => !Array.isArray(row))) return 'not_table';
  if (!witness) return 'unissued_witness';
  const table = capturedEvidenceTable(witness);
  if (!table || table.unavailableReason) return 'unavailable_witness';
  if (displayRows.length !== table.rows.length) return 'row_mismatch';
  const columns = displayColumns as string[];
  if (new Set(columns).size !== columns.length || new Set(table.columns).size !== table.columns.length) {
    return 'duplicate_columns';
  }
  const rawIndexes = columns.map(column => table.columns.indexOf(column));
  if (rawIndexes.some(index => index < 0) || displayRows.some(row => (row as unknown[]).length !== columns.length)) {
    return 'column_mismatch';
  }
  return {display: display as Record<string, unknown>, columns,
    displayRows: displayRows as unknown[][], table, rawIndexes};
}

function safeModelUnit(field: CapturedFieldSemantics | undefined): string | undefined {
  const unit = field?.unit;
  const fingerprint = field?.origin.definitionFingerprint;
  if (!field || !['skill_literal', 'native_producer'].includes(field.origin.kind) ||
      typeof fingerprint !== 'string' || !fingerprint.trim() || typeof unit !== 'string' ||
      !unit || unit.trim() !== unit || Buffer.byteLength(unit, 'utf8') > MODEL_EVIDENCE_UNIT_MAX_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(unit)) return undefined;
  return unit;
}

function columnUnitsForModel(context: DirectModelProjectionTable): Readonly<Record<string, string>> | undefined {
  const entries = context.columns.flatMap(column => {
    const unit = safeModelUnit(context.table.fields[column]);
    return unit ? [[column, unit] as const] : [];
  });
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

/** Current issued, direct-mapped producer units for model context; never evidence authority. */
export function projectEvidenceColumnUnitsForModel<T>(displayData: T, witness?: EvidenceTableWitness):
  Readonly<Record<string, string>> | undefined {
  const context = directModelProjectionTable(displayData, witness);
  if (typeof context === 'string' || context.table.rows.some((row, rowIndex) =>
    context.rawIndexes.some((index, columnIndex) => {
      const raw = row[index];
      if (raw === undefined) return true;
      const projected = typeof raw === 'string' ? boundedModelString(raw).value : raw;
      return !Object.is(context.displayRows[rowIndex][columnIndex], projected);
    }))) return undefined;
  return columnUnitsForModel(context);
}

/**
 * Produce bounded, typed cells for the model from the current issued witness.
 * This is data only: capture identity, field semantics and proof authority stay
 * in the WeakMap-backed witness and are never copied into the projection.
 */
export function projectEvidenceTableForModel<T>(displayData: T, witness?: EvidenceTableWitness): ModelEvidenceProjection<T> {
  const context = directModelProjectionTable(displayData, witness);
  if (typeof context === 'string') {
    return {data: displayData, modelProjection: {status: 'unavailable', reason: context}};
  }
  const {display, columns, table, rawIndexes} = context;

  const truncatedCells: Array<{rowIndex: number; column: string; originalBytes: number}> = [];
  let truncatedCellCount = 0;
  const rows: EvidenceScalar[][] = [];
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const projected: EvidenceScalar[] = [];
    for (let columnIndex = 0; columnIndex < rawIndexes.length; columnIndex += 1) {
      const raw = table.rows[rowIndex][rawIndexes[columnIndex]];
      if (raw === undefined) {
        return {data: displayData, modelProjection: {status: 'unavailable', reason: 'unsupported_raw_cell'}};
      }
      if (typeof raw === 'string') {
        const bounded = boundedModelString(raw);
        projected.push(bounded.value);
        if (bounded.originalBytes !== undefined) {
          truncatedCellCount += 1;
          if (truncatedCells.length < MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT) {
            truncatedCells.push({rowIndex, column: columns[columnIndex], originalBytes: bounded.originalBytes});
          }
        }
      } else {
        projected.push(raw);
      }
    }
    rows.push(projected);
  }
  const modelProjection: ModelEvidenceProjectionStatus = truncatedCellCount > 0
    ? {status: 'truncated', truncatedCellCount, truncatedCells,
      ...(truncatedCellCount > truncatedCells.length
        ? {truncatedCellsOmitted: truncatedCellCount - truncatedCells.length} : {})}
    : {status: 'exact'};
  const columnUnits = columnUnitsForModel(context);
  return {data: {...display, columns: [...columns], rows} as T, modelProjection,
    ...(columnUnits ? {columnUnits} : {})};
}

/** Only the original, sealed native response can attach row identity to a new capture. */
export function captureRawSqlEvidence(result: unknown,
  context: {traceId: string; traceSide: 'current' | 'reference'}): EvidenceTableWitness {
  const metadata = readRawSqlCaptureMetadata(result);
  if (metadata && ((metadata.sourceTraceId && metadata.sourceTraceId !== context.traceId) ||
      (context.traceSide !== 'current' && context.traceSide !== 'reference'))) {
    return captureEvidenceTable(result, {}, 'trace_capture_mismatch');
  }
  const matches = metadata?.sourceTraceId && metadata.sourceTraceId === context.traceId &&
    (context.traceSide === 'current' || context.traceSide === 'reference');
  const witness = captureEvidenceTable(result, matches ? metadata.fields : undefined);
  if (metadata && matches) {
    rawContexts.set(witness, Object.freeze({...context}));
    nativeRows.set(witness, freezeEvidenceValue(metadata.nativeRows.map(row => row?.traceId === context.traceId
      ? {...row, traceSide: context.traceSide} : undefined)));
  }
  return witness;
}

/** Private witness lookup. Serialized table metadata cannot populate this map. */
export function capturedNativeRow(witness: EvidenceTableWitness, rowIndex: number): CapturedNativeRow | undefined {
  return nativeRows.get(witness)?.[rowIndex];
}
export function capturedRawSqlContext(witness: EvidenceTableWitness): Readonly<{traceId: string; traceSide: 'current' | 'reference'}> | undefined {
  return rawContexts.get(witness);
}
export function attachEvidenceTable(owner: object, witness: EvidenceTableWitness): void {
  if (!tables.has(witness)) throw new Error('Unissued evidence table witness');
  owners.set(owner, witness);
}
export function evidenceTableFor(owner: object): EvidenceTableWitness | undefined {return owners.get(owner);}

export function bindCapturedAnchorFacts(anchor: object, witness: EvidenceTableWitness, rowIndex: number,
  selectedColumns?: readonly string[], referenceKey?: string): void {
  if (anchorFacts.has(anchor)) throw new Error('Captured anchor facts cannot be rebound');
  const table = tables.get(witness);
  const rawContext = capturedRawSqlContext(witness);
  const context = (anchor as {context?: {traceId?: string; traceSide?: string}}).context;
  if (rawContext && (rawContext.traceId !== context?.traceId || rawContext.traceSide !== context.traceSide)) return;
  if (!table || table.unavailableReason || !Number.isSafeInteger(rowIndex) || rowIndex < 0 ||
      !table.rows[rowIndex] || new Set(table.columns).size !== table.columns.length) return;
  const selected = new Set(selectedColumns || table.columns);
  const row: Record<string, EvidenceScalar> = Object.create(null);
  const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
  table.columns.forEach((column, index) => {
    const value = table.rows[rowIndex][index];
    if (selected.has(column) && value !== undefined) row[column] = value;
    if (selected.has(column) && table.fields[column]) fields[column] = structuredClone(table.fields[column]);
  });
  const hashes = new Set(Object.values(fields).map(field => field.origin.selectedSqlHash).filter(Boolean));
  const nativeRow = capturedNativeRow(witness, rowIndex);
  const boundNativeRow = nativeRow && context?.traceId === nativeRow.traceId && context.traceSide === nativeRow.traceSide &&
    row[nativeRow.outputColumn] === nativeRow.id ? nativeRow : undefined;
  anchorFacts.set(anchor, freezeEvidenceValue({captureId: witness.captureId, originalRowIndex: rowIndex, row, fields,
    ...(boundNativeRow ? {nativeRow: boundNativeRow} : {}),
    ...(referenceKey ? {referenceKey} : {}),
    ...(hashes.size === 1 ? {queryHash: [...hashes][0]} : {})}));
  freezeEvidenceValue(anchor);
}
export function getCapturedAnchorFacts(anchor: object): CapturedAnchorFacts | undefined {return anchorFacts.get(anchor);}

const unreadableAnchors = new WeakMap<object, string>();
/**
 * Issued by the claim builder from a typed read outcome that shows only that
 * the product could not read the cited evidence. A copied or serialized anchor
 * carries no mark, so a reason string alone never downgrades a missing reference.
 */
export function markUnreadableEvidenceAnchor(anchor: object, reason: string): void {
  if (!unreadableAnchors.has(anchor)) unreadableAnchors.set(anchor, reason);
}
export function unreadableEvidenceAnchorReason(anchor: object): string | undefined {return unreadableAnchors.get(anchor);}
