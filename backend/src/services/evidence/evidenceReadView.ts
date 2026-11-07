// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {ConclusionContractClaimReference} from '../../agent/core/conclusionContract';
import type {DataEnvelope} from '../../types/dataContract';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';
import {wholeResultRowPredicate} from './scopedRowIdentity';
import {buildInvestigationEvidenceSnapshot, type InvestigationEvidenceSnapshot,
  type InvestigationToolObservation} from './investigationEvidenceLedger';
import {bindCapturedAnchorFacts, capturedEvidenceTable, capturedNativeRow, capturedRawSqlContext, freezeEvidenceValue,
  getCapturedAnchorFacts, type CapturedFieldSemantics, type EvidenceScalar, type EvidenceTableWitness} from './evidenceCapture';

export interface EvidenceReadRequest {
  readonly key: string;
  readonly reference: ConclusionContractClaimReference;
  readonly requiredColumns: readonly string[];
  /** Internal identity lookup: never returns or binds a cell/row witness. */
  readonly metadataOnly?: true;
}
export interface CapturedEvidenceRecord {
  readonly originRunId?: string;
  readonly captureId: string;
  readonly storeId: string;
  readonly generation: number;
  readonly columns: readonly string[];
  readonly totalRowCount: number;
  readonly meta: DataEnvelope['meta'];
  readonly display: DataEnvelope['display'];
  readonly sourceRefs?: readonly string[];
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
}
export type EvidenceReadResolution = {
  readonly key: string;
  readonly status: 'resolved';
  readonly record: CapturedEvidenceRecord;
  readonly originalRowIndex?: number;
  readonly row?: Readonly<Record<string, EvidenceScalar>>;
} | {
  readonly key: string;
  readonly status: 'missing' | 'ambiguous' | 'incomplete' | 'denied';
  readonly reason: string;
  /** Locator repair hints: identifier field names, column names and counts only, never cell values. */
  readonly locatorDetail?: EvidenceLocatorDetail;
};
export interface EvidenceLocatorDetail {
  /** Supplied identifier fields that identify a retained record. */
  readonly matchedFields?: readonly string[];
  /** Supplied identifier fields that disagree with that record. */
  readonly conflictingFields?: readonly string[];
  readonly availableColumns?: readonly string[];
  readonly rowCount?: number;
}
const MAX_LOCATOR_DETAIL_COLUMNS = 32;
export interface EvidenceReadView {
  investigationEvidence?(): InvestigationEvidenceSnapshot;
  resolveReferences(requests: readonly EvidenceReadRequest[], signal?: AbortSignal): Promise<readonly EvidenceReadResolution[]>;
}
export interface EvidenceReadBudget {maxReferences: number; maxScannedRows: number; maxCells: number; maxElapsedMs: number; maxBytes: number}
interface BatchRowRead {
  values: Map<string, EvidenceScalar | undefined>;
  nativeRow: ReturnType<typeof capturedNativeRow>;
}
interface BatchRecordRead {
  witness: EvidenceTableWitness;
  bytes: number;
  admitted: boolean;
  rows: Map<number, BatchRowRead>;
}
/** A shallow freeze or accessor does not make retained metadata immutable. */
function immutableReadRecord(record: CapturedEvidenceRecord): boolean {
  const pending: object[] = [record];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!Object.isFrozen(value)) return false;
    if (!Array.isArray(value) && !isPlainJsonObject(value)) return false;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) return false;
      const child = descriptor.value;
      if (typeof child === 'function') return false;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return true;
}
/**
 * Upper bound on the references one conclusion may resolve. The witness ledger
 * that answers those references must retain at least this many captures, or a
 * run can cite evidence the product has already discarded.
 */
export const MAX_EVIDENCE_READ_REFERENCES = 256;

/**
 * Read failures that establish only that the product could not admit or read
 * the cited evidence — never that the citation is wrong. A claim bound to one
 * stays unverified instead of being counted as contradicted.
 *
 * This is a positive list on purpose. `evidence_not_retained` cannot tell an
 * evicted capture from an identifier that was never issued, and
 * `execution_witness_mismatch` is an integrity failure; both, and any reason
 * added later, keep treating the reference as missing until classified here.
 */
const UNREADABLE_EVIDENCE_REASONS: ReadonlySet<string> = new Set([
  // the declaration was not admitted, so nothing was read
  'binding_ineligible',
  // claim preparation could not reach the read view
  'execution_read_unavailable', 'execution_read_failed', 'read_cancelled',
  // the capture exists but carries no readable table for this output shape
  'execution_witness_unavailable', 'unmapped_evidence_shape', 'invalid_evidence_columns',
  'unmapped_evidence_columns', 'display_transformation_unmapped', 'unsupported_raw_cell',
  // the step's condition was not met, so its query never ran and captured nothing
  'execution_skipped',
]);

export function evidenceReadFailureIsUnreadable(reason: string | undefined): boolean {
  return reason !== undefined && UNREADABLE_EVIDENCE_REASONS.has(reason);
}
export interface EvidenceReadViewOptions {
  currentRunId?: string;
  allowedTraces: readonly {traceId: string; traceSide: 'current' | 'reference'}[];
  ownerKey: string;
  budget?: Partial<EvidenceReadBudget>;
}
export interface EvidenceReadRecord {record: CapturedEvidenceRecord; witness: EvidenceTableWitness}
const resolutions = new WeakMap<object, {witness: EvidenceTableWitness; rowIndex?: number; fields: readonly string[];
  wholeResult?: true}>();
// These capabilities are never serialized. A reason string or a restored read
// result cannot turn a bad reference into a current-run advisory diagnostic.
// "Current" describes the authorized lookup, not the capture's origin run:
// session continuity may admit older captures for a fresh run to read.
const currentReads = new WeakSet<object>();
const currentAnchorReads = new WeakMap<object, EvidenceReadResolution>();
// A locator that bound nothing leaves its claim unverified whether it was
// written by index or by selector.
const ADVISORY_LOCATOR_FAILURES = new Set([
  'evidence_not_retained',
  'row_index_out_of_range', 'row_selector_not_found', 'row_index_selector_conflict',
  'required_column_missing', 'invalid_row_selector', 'invalid_row_index',
]);
// Identifiers the product issued for one record. A redundant field that
// disagrees with a record one of these names is a slip in the locator; a
// conflict none of them resolves still names a record that was never cited.
const ISSUED_RECORD_IDENTIFIERS: readonly string[] = ['evidenceRefId', 'artifactId', 'sourceArtifactId'];

function locatorFailureIsAdvisory(reason: string, detail: EvidenceLocatorDetail | undefined): boolean {
  if (reason !== 'identifier_conflict') return ADVISORY_LOCATOR_FAILURES.has(reason);
  return Boolean(detail?.matchedFields?.some(field => ISSUED_RECORD_IDENTIFIERS.includes(field)));
}

export function referenceBindingFailureIsAdvisory(anchor: object, status: string): boolean {
  const resolution = currentAnchorReads.get(anchor);
  if (!resolution) return false;
  if (status === 'value_mismatch') return resolution.status === 'resolved' && Boolean(getCapturedAnchorFacts(anchor));
  return status === 'missing' && resolution.status === 'missing' &&
    locatorFailureIsAdvisory(resolution.reason, resolution.locatorDetail);
}

/** An authorized live whole-result read observed an empty table, not a missing capture. */
export function isCurrentEmptyResultRead(resolution: EvidenceReadResolution | undefined): boolean {
  if (!resolution || resolution.status !== 'resolved' || !currentReads.has(resolution) ||
      resolution.originalRowIndex !== undefined || resolution.row !== undefined) return false;
  const captured = resolutions.get(resolution);
  if (!captured?.wholeResult || captured.rowIndex !== undefined ||
      captured.witness.captureId !== resolution.record.captureId) return false;
  const {meta} = resolution.record;
  if ((meta.executionStatus !== 'observed' && meta.executionStatus !== 'empty') ||
      !meta.traceId?.trim() || meta.traceId === 'unknown' ||
      (meta.traceSide !== 'current' && meta.traceSide !== 'reference')) return false;
  const table = capturedEvidenceTable(captured.witness);
  return Boolean(table && !table.unavailableReason && table.rows.length === 0 && resolution.record.totalRowCount === 0);
}

export function bindReadResolutionToAnchor(anchor: object, resolution: EvidenceReadResolution): void {
  if (currentReads.has(resolution)) currentAnchorReads.set(anchor, resolution);
  const captured = resolutions.get(resolution);
  if (captured?.rowIndex !== undefined) {
    const context = (anchor as {context?: {captureId?: string}}).context;
    if (context) context.captureId = captured.witness.captureId;
    bindCapturedAnchorFacts(anchor, captured.witness, captured.rowIndex, captured.fields, resolution.key);
  }
}
export function isIssuedEvidenceReadResolution(resolution: EvidenceReadResolution): boolean {
  return resolution.status !== 'resolved' || resolutions.has(resolution);
}

const normalized = (value: string) => value.trim().toLowerCase();
function recordIdentifierChecks(record: CapturedEvidenceRecord, ref: ConclusionContractClaimReference): {field: string; ok: boolean}[] {
  const meta = record.meta;
  const checks: {field: string; ok: boolean}[] = [];
  if (ref.evidenceRefId) checks.push({field: 'evidenceRefId', ok: ref.evidenceRefId === meta.evidenceRefId ||
    (Boolean(meta.artifactId) && [meta.artifactId, `data:${meta.artifactId}`, `ev_${meta.artifactId}`].includes(ref.evidenceRefId))});
  if (ref.artifactId) checks.push({field: 'artifactId', ok: ref.artifactId === meta.artifactId});
  if (ref.sourceArtifactId) checks.push({field: 'sourceArtifactId', ok: ref.sourceArtifactId === meta.artifactId});
  if (ref.sourceToolCallId) checks.push({field: 'sourceToolCallId', ok: ref.sourceToolCallId === meta.sourceToolCallId});
  if (ref.sourceRef) checks.push({field: 'sourceRef', ok: [...(record.sourceRefs || []), record.display.title, meta.source, meta.skillId, meta.stepId]
    .some(alias => typeof alias === 'string' && normalized(alias) === normalized(ref.sourceRef!))});
  return checks;
}
/**
 * One pass over retained records: records every supplied identifier names, and
 * the best partial match, whose agreeing and conflicting fields locate a repair.
 */
function matchRecords(records: readonly EvidenceReadRecord[], ref: ConclusionContractClaimReference) {
  const exact: EvidenceReadRecord[] = [];
  let partial: {field: string; ok: boolean}[] | undefined;
  let partialMatches = 0;
  for (const entry of records) {
    const checks = recordIdentifierChecks(entry.record, ref);
    const matched = checks.filter(check => check.ok).length;
    if (matched > 0 && matched === checks.length) exact.push(entry);
    else if (matched > partialMatches) {partial = checks; partialMatches = matched;}
  }
  const conflict: EvidenceLocatorDetail | undefined = partial && {
    matchedFields: partial.filter(check => check.ok).map(check => check.field),
    conflictingFields: partial.filter(check => !check.ok).map(check => check.field)};
  return {exact, conflict};
}

/** Runtime Store closure; no model-visible paging or Trace Processor fallback. */
export function createEvidenceReadView(records: () => readonly EvidenceReadRecord[], options: EvidenceReadViewOptions,
  observations: () => readonly InvestigationToolObservation[] = () => []): EvidenceReadView {
  if (!options.ownerKey.trim()) throw new Error('Evidence read view requires a runtime owner');
  const allowed = new Set(options.allowedTraces.map(trace => `${trace.traceSide}:${trace.traceId}`));
  const budget: EvidenceReadBudget = {maxReferences: MAX_EVIDENCE_READ_REFERENCES, maxScannedRows: 100_000, maxCells: 16_384,
    maxElapsedMs: 1500, maxBytes: 1_048_576, ...options.budget};
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid evidence read budget');
  return Object.freeze({investigationEvidence: () => buildInvestigationEvidenceSnapshot(records(), options, observations()),
    async resolveReferences(requests: readonly EvidenceReadRequest[], signal?: AbortSignal) {
    const deadline = Date.now() + budget.maxElapsedMs;
    let scanned = 0;
    let cells = 0;
    let bytes = 0;
    const available = records();
    // Only this batch shares immutable reads. Registration identity (including
    // generation) and witness stay distinct; every locator still passes the guards.
    const batchReads = new Map<CapturedEvidenceRecord, BatchRecordRead>();
    const expired = () => Boolean(signal?.aborted) || Date.now() >= deadline;
    const out: EvidenceReadResolution[] = [];
    for (const request of requests) {
      const fail = (status: 'missing' | 'ambiguous' | 'incomplete' | 'denied', reason: string, locatorDetail?: EvidenceLocatorDetail) =>
        out.push(freezeEvidenceValue({key: request.key, status, reason, ...(locatorDetail ? {locatorDetail} : {})}));
      if (out.length >= budget.maxReferences || expired()) {fail('incomplete', signal?.aborted ? 'read_cancelled' : 'read_budget_exhausted'); continue;}
      const {exact: candidates, conflict} = matchRecords(available, request.reference);
      if (candidates.length !== 1) {
        if (candidates.length > 1) fail('ambiguous', 'multiple_evidence_records');
        else if (conflict) fail('missing', 'identifier_conflict', conflict);
        else fail('missing', 'evidence_not_retained');
        continue;
      }
      const {record, witness} = candidates[0];
      if (record.captureId !== witness.captureId) {fail('missing', 'execution_witness_mismatch'); continue;}
      const rawContext = capturedRawSqlContext(witness);
      if (rawContext && (rawContext.traceId !== record.meta.traceId || rawContext.traceSide !== record.meta.traceSide)) {
        fail('denied', 'trace_capture_mismatch'); continue;
      }
      if (!allowed.has(`${record.meta.traceSide}:${record.meta.traceId}`)) {fail('denied', 'trace_outside_read_scope'); continue;}
      const table = capturedEvidenceTable(witness);
      if (!table || table.unavailableReason) {fail('missing', table?.unavailableReason || 'execution_witness_unavailable'); continue;}
      if (record.meta.executionStatus === 'unavailable' || record.meta.executionStatus === 'optional_error') {fail('missing', 'execution_unavailable'); continue;}
      if (record.meta.executionStatus === 'skipped') {fail('missing', 'execution_skipped'); continue;}
      if (new Set(table.columns).size !== table.columns.length) {fail('ambiguous', 'duplicate_evidence_columns'); continue;}
      const previous = batchReads.get(record);
      const reusable = (previous !== undefined || immutableReadRecord(record))
        && Object.isFrozen(table) && Object.isFrozen(witness);
      const recordRead = previous?.witness === witness ? previous : {
        witness, bytes: JSON.stringify(record).length * 2, admitted: false, rows: new Map<number, BatchRowRead>(),
      };
      if (reusable) batchReads.set(record, recordRead);
      const ref = request.reference;
      if (request.metadataOnly) {
        if (request.requiredColumns.length || ['rowIndex', 'rowSelector', 'column', 'value']
          .some(field => Object.prototype.hasOwnProperty.call(ref, field))) {
          fail('missing', 'invalid_metadata_locator'); continue;
        }
        const readBytes = recordRead.admitted ? 0 : recordRead.bytes;
        if (bytes + readBytes > budget.maxBytes || expired()) {fail('incomplete', 'evidence_read_size_or_deadline_exhausted'); continue;}
        bytes += readBytes;
        recordRead.admitted = true;
        const resolution: EvidenceReadResolution = freezeEvidenceValue({key: request.key, status: 'resolved', record});
        resolutions.set(resolution, {witness, fields: []});
        out.push(resolution);
        continue;
      }
      if (ref.rowIndex !== undefined && (!Number.isSafeInteger(ref.rowIndex) || ref.rowIndex < 0)) {fail('missing', 'invalid_row_index'); continue;}
      let rowIndex = ref.rowIndex;
      let failed = false;
      if (ref.rowSelector !== undefined) {
        const selectors = Object.entries(ref.rowSelector);
        if (!selectors.length || selectors.some(([column]) => !table.columns.includes(column))) {fail('missing', 'invalid_row_selector'); continue;}
        const matches: number[] = [];
        for (let index = 0; index < table.rows.length; index++) {
          if (++scanned > budget.maxScannedRows || expired()) {fail('incomplete', 'selector_scan_incomplete'); failed = true; break;}
          if (selectors.every(([column, value]) => table.rows[index][table.columns.indexOf(column)] === value)) matches.push(index);
          if (matches.length > 1) {fail('ambiguous', 'row_selector_not_unique'); failed = true; break;}
        }
        if (failed) continue;
        if (matches.length === 0) {fail('missing', 'row_selector_not_found'); continue;}
        if (rowIndex !== undefined && rowIndex !== matches[0]) {fail('missing', 'row_index_selector_conflict'); continue;}
        rowIndex = matches[0];
      }
      if (rowIndex === undefined && table.rows.length === 1) rowIndex = 0;
      if (rowIndex === undefined && ref.column) {fail('ambiguous', 'row_locator_required'); continue;}
      if (rowIndex !== undefined && !table.rows[rowIndex]) {fail('missing', 'row_index_out_of_range', {rowCount: table.rows.length}); continue;}
      const requested = new Set([...request.requiredColumns, ...(ref.column ? [ref.column] : []), ...Object.keys(ref.rowSelector || {})]);
      if ([...requested].some(column => !table.columns.includes(column))) {
        fail('missing', 'required_column_missing', {availableColumns: table.columns.slice(0, MAX_LOCATOR_DETAIL_COLUMNS)});
        continue;
      }
      // A whole multi-row or empty result binds the target identity only once every row is
      // shown to belong to it. An observed conflict wins; an unreadable upid cell or an
      // unfinished scan proves nothing either way.
      const upidColumn = table.columns.indexOf('upid');
      const admits = rowIndex === undefined && upidColumn >= 0 ? wholeResultRowPredicate(record.meta) : undefined;
      if (admits) {
        let unproven: string | undefined;
        for (const scannedRow of table.rows) {
          if (++scanned > budget.maxScannedRows || expired()) {unproven = 'whole_result_identity_scan_incomplete'; break;}
          if (scannedRow[upidColumn] === undefined) unproven ??= 'whole_result_identity_cell_unreadable';
          else if (!admits(scannedRow[upidColumn])) {fail('missing', 'whole_result_identity_conflict'); failed = true; break;}
        }
        if (failed) continue;
        if (unproven) {fail('incomplete', unproven); continue;}
      }
      const needed = new Set([...requested, ...Object.keys(table.fields),
        ...['upid', 'pid', 'utid', 'tid', 'process_name', 'thread_name'].filter(column => table.columns.includes(column))]);
      const nativeRow = rowIndex !== undefined ? capturedNativeRow(witness, rowIndex) : undefined;
      if (nativeRow && nativeRow.traceId === record.meta.traceId && nativeRow.traceSide === record.meta.traceSide) {
        needed.add(nativeRow.outputColumn);
      }
      const wholeRow = !ref.column && request.requiredColumns.length === 0;
      if (rowIndex !== undefined && wholeRow) table.columns.forEach(column => needed.add(column));
      const priorRow = rowIndex !== undefined ? recordRead.rows.get(rowIndex) : undefined;
      const cachedRow = priorRow?.nativeRow === nativeRow ? priorRow : undefined;
      const additionalColumns = [...needed].filter(column => !cachedRow?.values.has(column));
      if (rowIndex !== undefined && cells + additionalColumns.length > budget.maxCells) {fail('incomplete', 'cell_read_budget_exhausted'); continue;}
      const row: Record<string, EvidenceScalar> = Object.create(null);
      const values = new Map(cachedRow?.values);
      if (rowIndex !== undefined) {
        cells += additionalColumns.length;
        for (const column of needed) {
          const value = values.has(column) ? values.get(column) : table.rows[rowIndex][table.columns.indexOf(column)];
          if (value === undefined && (requested.has(column) || wholeRow)) {failed = true; break;}
          values.set(column, value);
          if (value !== undefined) row[column] = value;
        }
      }
      if (failed) {fail('missing', 'unsupported_raw_cell'); continue;}
      const readBytes = (recordRead.admitted ? 0 : recordRead.bytes)
        + (nativeRow && !cachedRow ? JSON.stringify(nativeRow).length * 2 : 0)
        + additionalColumns.reduce((total, column) => {
          const value = row[column];
          return value === undefined ? total : total + column.length * 6 + (typeof value === 'string' ? value.length * 6 : 32);
        }, 0);
      if (bytes + readBytes > budget.maxBytes || expired()) {fail('incomplete', 'evidence_read_size_or_deadline_exhausted'); continue;}
      bytes += readBytes;
      recordRead.admitted = true;
      if (rowIndex !== undefined) recordRead.rows.set(rowIndex, {values, nativeRow});
      const resolution: EvidenceReadResolution = freezeEvidenceValue({key: request.key, status: 'resolved', record,
        ...(rowIndex !== undefined ? {originalRowIndex: rowIndex, row} : {})});
      resolutions.set(resolution, {witness, rowIndex, fields: [...needed],
        ...(rowIndex === undefined && request.requiredColumns.length === 0 &&
          !['rowIndex', 'rowSelector', 'column', 'value'].some(field => Object.prototype.hasOwnProperty.call(ref, field))
          ? {wholeResult: true as const} : {})});
      out.push(resolution);
    }
    if (options.currentRunId?.trim()) out.forEach(resolution => currentReads.add(resolution));
    return Object.freeze(out);
  }});
}
