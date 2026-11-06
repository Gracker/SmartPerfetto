// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {types} from 'util';
import {exactNumber} from '../../utils/exactDecimal';
import {projectEvidenceCaptureMetadataForModel, safeModelUnit, type CapturedEvidenceTable, type EvidenceTableWitness} from './evidenceCapture';
import {investigationMetricBindingForModel} from './investigationEvidenceLedger';

/** Three independent availability facts, never a proof or collection verdict. */
export interface ModelEvidenceMetadata {
  columnUnits?: Readonly<Record<string, string>>;
  modelEvidence: {
    /** Full backing capture, not the current page or complete query/population coverage. */
    captureRows: 'available' | 'empty' | 'unavailable';
    /** At least one safe issued unit; columns absent from columnUnits remain unknown. */
    columnUnits: 'available' | 'unknown';
    /** A private binding with nonempty metrics; does not imply any metric was observed. */
    registeredMetricBinding: 'present' | 'absent' | 'unknown';
  };
}

export type QuoteLocator = {artifactId: string} | {evidenceRefId: string};
export interface QuoteProjectedCell {
  readonly rowIndex: number;
  readonly column: string;
  readonly value: unknown;
  readonly unit?: string;
  readonly availability: 'visible' | 'redacted' | 'unavailable';
}
export interface QuoteProjectedPage {
  readonly rows: readonly number[];
  readonly columns: readonly string[];
  readonly cells: readonly QuoteProjectedCell[];
  readonly page: {readonly hasMore: 'yes' | 'no' | 'unknown'; readonly coverage: 'visible_page_only'};
}
export interface QuoteProjectionScope {
  readonly runId: string;
  readonly allowedTraces: readonly {readonly traceId: string; readonly traceSide: 'current' | 'reference'}[];
}
/** Its shape is not authority; only the store's private binding map recognizes it. */
export interface PreparedQuoteProjectionBinding {readonly kind: 'prepared_quote_projection'}

/** Eligibility only: retain the exact value/text; this does not bind it to evidence. */
export function isVisibleQuoteScalar(value: unknown): value is number | string | null {
  if (!(value === null || (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && exactNumber(value) !== undefined))) return false;
  return Object.is(JSON.parse(JSON.stringify(value)), value);
}

function quoteDataRecord(value: unknown, keys: readonly string[]): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) return undefined;
  return Object.getOwnPropertyDescriptors(value);
}

function dataValue(properties: PropertyDescriptorMap, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(properties, key)?.value as PropertyDescriptor | undefined;
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Read only the supplied page array's own data slots, never a custom iterator. */
function quoteArray(value: unknown, maxLength: number): unknown[] | undefined {
  if (types.isProxy(value) || !Array.isArray(value)) return undefined;
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxLength ||
      Reflect.ownKeys(value).length !== length + 1) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

/** Detach supplied scope data; this does not establish runtime ownership or authorize a trace. */
export function snapshotQuoteProjectionScope(value: unknown): QuoteProjectionScope | undefined {
  const fields = quoteDataRecord(value, ['runId', 'allowedTraces']);
  if (!fields) return undefined;
  const runId = dataValue(fields, 'runId');
  const traces = quoteArray(dataValue(fields, 'allowedTraces'), 2);
  if (typeof runId !== 'string' || !runId.trim() || !traces) return undefined;
  const allowedTraces: Array<{traceId: string; traceSide: 'current' | 'reference'}> = [];
  const sides = new Set<string>();
  for (const trace of traces) {
    const properties = quoteDataRecord(trace, ['traceId', 'traceSide']);
    if (!properties) return undefined;
    const traceId = dataValue(properties, 'traceId'), traceSide = dataValue(properties, 'traceSide');
    if (typeof traceId !== 'string' || !traceId.trim() || (traceSide !== 'current' && traceSide !== 'reference') ||
        sides.has(traceSide)) return undefined;
    sides.add(traceSide);
    allowedTraces.push(Object.freeze({traceId, traceSide}));
  }
  return Object.freeze({runId, allowedTraces: Object.freeze(allowedTraces)});
}

/** Validate only supplied visible coordinates; never copy or project the full capture. */
export function quoteProjectedPageMatchesCapture(input: unknown, table: CapturedEvidenceTable): boolean {
  const fields = quoteDataRecord(input, ['rows', 'columns', 'cells', 'page']);
  if (!fields) return false;
  const rows = quoteArray(dataValue(fields, 'rows'), table.rows.length);
  const columns = quoteArray(dataValue(fields, 'columns'), table.columns.length);
  const page = quoteDataRecord(dataValue(fields, 'page'), ['hasMore', 'coverage']);
  if (!rows || !columns || !page) return false;
  const hasMore = dataValue(page, 'hasMore');
  if ((hasMore !== 'yes' && hasMore !== 'no' && hasMore !== 'unknown') || dataValue(page, 'coverage') !== 'visible_page_only') return false;
  const declaredRows = new Set<number>(), columnIndexes = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0 || row >= table.rows.length || declaredRows.has(row)) return false;
    declaredRows.add(row);
  }
  for (const column of columns) {
    if (typeof column !== 'string' || !column.trim() || columnIndexes.has(column)) return false;
    const index = table.columns.indexOf(column);
    if (index < 0 || table.columns.lastIndexOf(column) !== index) return false;
    columnIndexes.set(column, index);
  }
  const suppliedCells = quoteArray(dataValue(fields, 'cells'), declaredRows.size * columnIndexes.size);
  if (!suppliedCells) return false;
  const seen = new Map<number, Set<string>>();
  for (const supplied of suppliedCells) {
    const cell = quoteDataRecord(supplied, ['rowIndex', 'column', 'value', 'unit', 'availability']);
    if (!cell) return false;
    const rowIndex = dataValue(cell, 'rowIndex'), column = dataValue(cell, 'column'), availability = dataValue(cell, 'availability');
    if (typeof rowIndex !== 'number' || !declaredRows.has(rowIndex) || typeof column !== 'string' ||
        !columnIndexes.has(column) || seen.get(rowIndex)?.has(column) ||
        (availability !== 'visible' && availability !== 'redacted' && availability !== 'unavailable')) return false;
    const rowColumns = seen.get(rowIndex) ?? new Set<string>(); rowColumns.add(column); seen.set(rowIndex, rowColumns);
    const unit = dataValue(cell, 'unit');
    const unitDescriptor = Object.getOwnPropertyDescriptor(cell, 'unit')?.value as PropertyDescriptor | undefined;
    if (unitDescriptor && !('value' in unitDescriptor)) return false;
    if (unit !== undefined && (typeof unit !== 'string' || unit !== safeModelUnit(table.fields[column]))) return false;
    if (availability !== 'visible') {
      // Do not read the supplied value, traverse it or retain its arbitrary object/string.
      continue;
    }
    const value = dataValue(cell, 'value');
    if (!isVisibleQuoteScalar(value)) return false;
    const raw = table.rows[rowIndex][columnIndexes.get(column)!];
    if (!Object.is(raw, value)) return false;
  }
  return true;
}

/** Fresh projection from live witnesses. Input/serialized metadata never supplies these facts. */
export function projectModelEvidenceMetadata(data: unknown, witness?: EvidenceTableWitness): ModelEvidenceMetadata {
  try {
    const {captureRows, columnUnits} = projectEvidenceCaptureMetadataForModel(data, witness);
    return {
      ...(columnUnits ? {columnUnits} : {}),
      modelEvidence: {captureRows, columnUnits: columnUnits ? 'available' : 'unknown',
        registeredMetricBinding: captureRows === 'unavailable' ? 'unknown' : investigationMetricBindingForModel(witness)},
    };
  } catch {
    // Only metadata errors are contained here; callers retain query/auth failure semantics.
    return {modelEvidence: {captureRows: 'unavailable', columnUnits: 'unknown', registeredMetricBinding: 'unknown'}};
  }
}
