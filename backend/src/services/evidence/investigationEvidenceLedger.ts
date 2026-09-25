// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import type {RuntimeToolInvocationEvent} from '../../agentRuntime/runtimeToolObserver';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticLimits';
import type {EvidenceReadRecord, EvidenceReadViewOptions} from './evidenceReadView';
import {capturedEvidenceTable, evidenceCaptureHash, freezeEvidenceValue,
  type CapturedFieldSemantics, type EvidenceScalar, type EvidenceTableWitness} from './evidenceCapture';

/** Producer-owned raw-column mappings. Neither display labels nor SQL aliases imply semantics. */
export interface InvestigationEvidenceDeclaration {
  window: {start: string; end: string};
  identity?: {upid?: string; utid?: string; cpu?: string; ucpu?: string; machine_id?: string};
  context?: {window_id?: string; role?: string};
  scan?: InvestigationScanDeclaration;
  metrics: Array<{domain: string; metric_id: string; value: string; unit?: string;
    status: string; coverage?: string; denominator?: string; aggregation?: string}>;
}
/** A registered SQL producer describes its own non-paged scan and sibling output. */
export interface InvestigationScanDeclaration {
  domain: string; resultStepId: string;
  sourceColumn?: string; resultSourceColumn?: string;
  totalRowsColumn: string; outputTruncatedColumn: string; cursorClosedColumn: string; parseFailuresColumn: string;
}
export interface InvestigationScanRecord {
  readonly recordId: string; readonly captureId: string; readonly resultCaptureId?: string;
  readonly originRunId: string; readonly traceId: string; readonly traceSide: 'current';
  readonly skillId: string; readonly stepId: string; readonly resultStepId: string;
  readonly sourceToolCallId: string; readonly definitionFingerprint: string;
  readonly selectedSqlHash: string; readonly resultSqlHash?: string;
  readonly domain: string; readonly source: string;
  readonly window: {start: string; end: string}; readonly totalRows?: string; readonly returnedRows?: string;
  readonly scanStatus: 'complete' | 'partial'; readonly captureStatus: 'unknown';
  readonly issues: readonly string[];
}
export const SCAN_RECORD_BUDGET = 1024;
export const SCAN_ROW_CHECK_BUDGET = 65536;
interface ProducerBinding {
  declaration: InvestigationEvidenceDeclaration;
  definitionFingerprint: string;
  selectedSqlHash: string;
  skillId: string;
  stepId: string;
  traceId: string;
}
export interface InvestigationEvidenceRecord {
  readonly recordId: string;
  readonly captureId: string;
  readonly rowIndex: number;
  readonly evidenceRefId?: string;
  readonly artifactId?: string;
  readonly sourceToolCallId?: string;
  readonly skillId: string;
  readonly stepId: string;
  readonly definitionFingerprint: string;
  readonly selectedSqlHash: string;
  readonly traceId: string;
  readonly traceSide: 'current' | 'reference';
  readonly originRunId?: string;
  readonly origin: 'current_run' | 'reused' | 'unknown';
  readonly domain: string;
  readonly metricId: string;
  readonly status: 'observed' | 'partial' | 'unavailable' | 'unknown';
  readonly window: {readonly start: number | string; readonly end: number | string};
  readonly upid?: number;
  readonly utid?: number;
  readonly cpu?: number | null;
  readonly ucpu?: number | null;
  readonly machineId?: number | null;
  readonly windowId?: number | string | null;
  readonly role?: string | null;
  readonly aggregation?: string;
  readonly value: EvidenceScalar;
  readonly unit?: string;
  readonly coverage?: number | string;
  readonly denominator?: number | string;
}
/**
 * Total ledger capacity for one run.
 *
 * Records are appended in tool-call order, so a saturated ledger silently
 * truncates whatever ran last. A real 10s scrolling trace reached this cap
 * exactly, with a single per-handoff metric holding more than half of it.
 */
export const LEDGER_RECORD_BUDGET = 4096;

/**
 * Per `(skillId, metricId)` capacity. This is the share any one producer may
 * take, so a high-cardinality metric cannot starve the requirements that are
 * acquired later in the run. Truncation here is reported as
 * `ledger_metric_budget_exhausted` and scoped to that metric; it is not the
 * whole-ledger `ledger_record_budget_exhausted` verdict.
 */
export const LEDGER_PER_METRIC_BUDGET = 1024;

export interface InvestigationEvidenceSnapshot {
  readonly schemaVersion: 'investigation_evidence@1';
  readonly ownerKey: string;
  readonly currentRunId?: string;
  readonly fingerprint: string;
  readonly records: readonly InvestigationEvidenceRecord[];
  readonly scans?: readonly InvestigationScanRecord[];
  readonly scanIssues?: readonly string[];
  readonly issues: readonly string[];
  readonly incompleteCaptureIds?: readonly string[];
  readonly complete: boolean;
}
const bindings = new WeakMap<EvidenceTableWitness, ProducerBinding>();
const issuedSnapshots = new WeakSet<object>();
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exactNs = (value: unknown): value is number | string =>
  (nonnegative(value) && Number.isSafeInteger(value)) ||
  (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20);

export function isInvestigationEvidenceDeclaration(value: unknown): value is InvestigationEvidenceDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const declaration = value as InvestigationEvidenceDeclaration;
  return Boolean(declaration.window && nonempty(declaration.window.start) && nonempty(declaration.window.end) &&
    (!declaration.identity || Object.entries(declaration.identity).every(([key, column]) =>
      ['upid', 'utid', 'cpu', 'ucpu', 'machine_id'].includes(key) && nonempty(column))) &&
    (!declaration.context || Object.entries(declaration.context).every(([key, column]) =>
      ['window_id', 'role'].includes(key) && nonempty(column))) &&
    (declaration.scan === undefined || validScanDeclaration(declaration.scan)) &&
    Array.isArray(declaration.metrics) && declaration.metrics.every(metric =>
      metric && nonempty(metric.domain) && nonempty(metric.metric_id) && nonempty(metric.value) && nonempty(metric.status) &&
      [metric.unit, metric.coverage, metric.denominator, metric.aggregation].every(field => field === undefined || nonempty(field)) &&
      (metric.coverage === undefined) === (metric.denominator === undefined)));
}

function validScanDeclaration(scan: InvestigationScanDeclaration): boolean {
  const required = ['domain', 'resultStepId', 'totalRowsColumn', 'outputTruncatedColumn', 'cursorClosedColumn', 'parseFailuresColumn'];
  return Boolean(scan && typeof scan === 'object' && !Array.isArray(scan) &&
    Object.keys(scan).every(key => [...required, 'sourceColumn', 'resultSourceColumn'].includes(key)) &&
    required.every(key => nonempty(scan[key as keyof InvestigationScanDeclaration])) &&
    (scan.sourceColumn === undefined) === (scan.resultSourceColumn === undefined) &&
    [scan.sourceColumn, scan.resultSourceColumn].every(value => value === undefined || nonempty(value)));
}

/** Validate nested Skill declarations before admitting a definition into the executor. */
export function validateInvestigationEvidenceDeclarations(definition: object): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'investigation_evidence' && !isInvestigationEvidenceDeclaration(child)) {
        throw new Error('Invalid investigation_evidence producer declaration');
      }
      if (key === 'investigation_evidence') investigationCaptureFields(child as InvestigationEvidenceDeclaration,
        {kind: 'skill_literal', definitionFingerprint: 'declaration_validation'});
      visit(child);
    }
  };
  visit(definition);
}

export function investigationCaptureFields(declaration: InvestigationEvidenceDeclaration | undefined,
  origin: CapturedFieldSemantics['origin']): Record<string, CapturedFieldSemantics> {
  if (!declaration) return {};
  const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
  const merge = (column: string, next: CapturedFieldSemantics): void => {
    const previous = fields[column];
    for (const key of ['unit', 'timeRole', 'clock', 'identityRole', 'metricId', 'aggregation', 'populationKey'] as const) {
      if (previous?.[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]) {
        throw new Error(`Invalid investigation_evidence conflicting field semantics: ${column}.${key}`);
      }
    }
    fields[column] = {...previous, ...next};
  };
  merge(declaration.window.start, {origin, unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'});
  merge(declaration.window.end, {origin, unit: 'ns', timeRole: 'end', clock: 'trace_monotonic'});
  for (const [identityRole, column] of Object.entries(declaration.identity ?? {})) {
    if (column) merge(column, {origin, identityRole: identityRole as CapturedFieldSemantics['identityRole']});
  }
  for (const metric of declaration.metrics) {
    merge(metric.value, {origin, metricId: metric.metric_id, ...(metric.unit ? {unit: metric.unit} : {}),
      ...(metric.aggregation ? {aggregation: metric.aggregation} : {})});
    for (const column of [metric.coverage, metric.denominator]) {
      if (column) merge(column, {origin, unit: 'ns', timeRole: 'duration'});
    }
  }
  return fields;
}

/** Called only with the original successful SQL response witness by SkillExecutor. */
export function attachInvestigationEvidence(witness: EvidenceTableWitness, binding: ProducerBinding): void {
  if (!capturedEvidenceTable(witness) || bindings.has(witness) || !isInvestigationEvidenceDeclaration(binding.declaration) ||
      ![binding.definitionFingerprint, binding.selectedSqlHash, binding.skillId, binding.stepId, binding.traceId].every(nonempty)) return;
  try {
    investigationCaptureFields(binding.declaration, {kind: 'skill_literal', definitionFingerprint: binding.definitionFingerprint});
  } catch { return; }
  bindings.set(witness, freezeEvidenceValue(structuredClone(binding)));
}

export type InvestigationToolObservation = {toolCallId: string; phase: 'started' | 'completed' | 'failed'; failed: boolean; success?: boolean; originRunId?: string};
export function captureInvestigationToolObservation(event: RuntimeToolInvocationEvent): InvestigationToolObservation {
  return Object.freeze({toolCallId: event.toolCallId, phase: event.phase,
    ...(event.phase === 'completed' ? {success: readRuntimeToolResultFacts(event.result).success} : {}),
    failed: event.phase === 'failed' || (event.phase === 'completed' && event.result.isError === true)});
}

export function investigationEvidenceFingerprint(snapshot: Omit<InvestigationEvidenceSnapshot, 'fingerprint'>): string {
  const {schemaVersion, ownerKey, currentRunId, records, issues, complete, incompleteCaptureIds, scans, scanIssues} = snapshot;
  return evidenceCaptureHash({schemaVersion, ownerKey, currentRunId, records, issues, complete,
    ...(incompleteCaptureIds ? {incompleteCaptureIds} : {}), ...(scans ? {scans} : {}), ...(scanIssues ? {scanIssues} : {})});
}
export function isIssuedInvestigationEvidenceSnapshot(value: unknown): value is InvestigationEvidenceSnapshot {
  return Boolean(value && typeof value === 'object' && issuedSnapshots.has(value));
}

export type CompactInvestigationEvidenceRecord = Pick<InvestigationEvidenceRecord,
  'recordId' | 'captureId' | 'domain' | 'metricId' | 'status' | 'origin' | 'originRunId' |
  'traceId' | 'traceSide' | 'window' | 'upid' | 'utid' | 'cpu' | 'ucpu' | 'machineId' |
  'windowId' | 'role' | 'aggregation' | 'value' | 'unit' | 'coverage' | 'denominator'>;
export interface CompactInvestigationEvidenceSnapshot {
  readonly schemaVersion: 'compact_investigation_evidence@1';
  /** Fingerprint of the complete retained ledger, not this provider projection. */
  readonly fingerprint: string;
  readonly byteBudget: number;
  readonly records: readonly CompactInvestigationEvidenceRecord[];
  readonly omittedRecordCount: number;
  readonly issues: readonly string[];
  readonly incompleteCaptureIds?: readonly string[];
  readonly complete: boolean;
}

/** Bounded provider projection. Cohorts are kept whole and never selected by success or value. */
function compactInvestigationEvidenceWithin(snapshot: InvestigationEvidenceSnapshot,
  maxBytes: number, ceilingBytes: number): CompactInvestigationEvidenceSnapshot | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ceilingBytes) return undefined;
  const groups = new Map<string, CompactInvestigationEvidenceRecord[]>();
  for (const record of snapshot.records) {
    const {recordId, captureId, domain, metricId, status, origin, originRunId, traceId, traceSide,
      window, upid, utid, cpu, ucpu, machineId, windowId, role, aggregation, value, unit, coverage, denominator} = record;
    const key = JSON.stringify([captureId, metricId, traceId, traceSide, String(window.start), String(window.end), windowId]);
    const group = groups.get(key) || [];
    group.push({recordId, captureId, domain, metricId, status, origin, originRunId, traceId, traceSide,
      window, upid, utid, cpu, ucpu, machineId, windowId, role, aggregation, value, unit, coverage, denominator});
    groups.set(key, group);
  }
  const envelope = (records: CompactInvestigationEvidenceRecord[]): CompactInvestigationEvidenceSnapshot => {
    const omittedRecordCount = snapshot.records.length - records.length;
    return {schemaVersion: 'compact_investigation_evidence@1', fingerprint: snapshot.fingerprint, byteBudget: maxBytes,
      records, omittedRecordCount, issues: [...new Set([...snapshot.issues,
        ...(omittedRecordCount ? ['investigation_provider_view_omitted_records'] : [])])].sort(),
      ...(snapshot.incompleteCaptureIds ? {incompleteCaptureIds: [...snapshot.incompleteCaptureIds]} : {}),
      complete: snapshot.complete && omittedRecordCount === 0};
  };
  const fits = (view: CompactInvestigationEvidenceSnapshot) => Buffer.byteLength(JSON.stringify(view), 'utf8') <= maxBytes;
  let view = envelope([]);
  if (!fits(view)) return undefined;
  for (const group of groups.values()) {
    const candidate = envelope([...view.records, ...group]);
    if (!fits(candidate)) break;
    view = candidate;
  }
  return freezeEvidenceValue(view);
}

/** Preserve the existing general provider-view contract and its 64 KiB ceiling. */
export function compactInvestigationEvidence(snapshot: InvestigationEvidenceSnapshot,
  maxBytes = 64 * 1024): CompactInvestigationEvidenceSnapshot | undefined {
  return compactInvestigationEvidenceWithin(snapshot, maxBytes, 64 * 1024);
}

/** Semantic review may use the shared total-input ceiling; final prompt sizing remains authoritative. */
export function compactInvestigationEvidenceForSemantic(snapshot: InvestigationEvidenceSnapshot,
  maxBytes: number): CompactInvestigationEvidenceSnapshot | undefined {
  return compactInvestigationEvidenceWithin(snapshot, maxBytes, FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
}

/** Independent from metric presence/identity: an empty successful sibling is meaningful for a scan. */
function buildScanRecords(captures: readonly EvidenceReadRecord[], options: EvidenceReadViewOptions,
  toolStates: ReadonlyMap<string, InvestigationToolObservation>): {scans: InvestigationScanRecord[]; scanIssues: string[]} {
  const scans: InvestigationScanRecord[] = [];
  const scanIssues = new Set<string>();
  const seen = new Set<string>();
  let checkedRows = 0;
  const allowed = new Set(options.allowedTraces.map(trace => `${trace.traceSide}:${trace.traceId}`));
  for (const {record, witness} of captures) {
    const binding = bindings.get(witness), table = capturedEvidenceTable(witness);
    const scan = binding?.declaration.scan;
    if (!binding || !scan || seen.has(witness.captureId)) continue;
    seen.add(witness.captureId);
    // Retained history/reference traces are not acquisitions of the active scan run.
    if (!options.currentRunId || record.originRunId !== options.currentRunId || record.meta.traceSide !== 'current' ||
        !allowed.has(`current:${record.meta.traceId}`)) continue;
    if (binding.traceId !== record.meta.traceId ||
        !record.meta.sourceToolCallId || record.captureId !== witness.captureId || !table || table.unavailableReason ||
        ['optional_error', 'unavailable', 'skipped'].includes(record.meta.executionStatus || '') ||
        new Set(table.columns).size !== table.columns.length) {
      scanIssues.add('scan_scope_or_summary_unavailable'); continue;
    }
    if (!table.rows.length) {scanIssues.add('scan_summary_empty'); continue;}
    const observation = toolStates.get(`${record.originRunId}:${record.meta.sourceToolCallId}`);
    const siblings = new Map<string, EvidenceReadRecord>();
    for (const candidate of captures) {
      const sibling = bindings.get(candidate.witness);
      if (sibling?.skillId === binding.skillId && sibling.stepId === scan.resultStepId &&
          sibling.definitionFingerprint === binding.definitionFingerprint && sibling.traceId === binding.traceId &&
          candidate.record.originRunId === record.originRunId && candidate.record.meta.traceId === record.meta.traceId &&
          candidate.record.meta.traceSide === record.meta.traceSide &&
          candidate.record.meta.sourceToolCallId === record.meta.sourceToolCallId) siblings.set(candidate.witness.captureId, candidate);
    }
    for (let index = 0; index < table.rows.length; index++) {
      if (scans.length >= SCAN_RECORD_BUDGET) {scanIssues.add('scan_record_budget_exhausted'); break;}
      if (++checkedRows > SCAN_ROW_CHECK_BUDGET) {scanIssues.add('scan_row_budget_exhausted'); break;}
      const read = (column: string) => table.rows[index][table.columns.indexOf(column)];
      const start = read(binding.declaration.window.start), end = read(binding.declaration.window.end);
      if (!exactNs(start) || !exactNs(end) || BigInt(end) < BigInt(start)) {scanIssues.add('scan_window_invalid'); continue;}
      const issues = new Set<string>();
      const sourceValue = scan.sourceColumn ? read(scan.sourceColumn) : 'all';
      const sourceValid = typeof sourceValue === 'string' && sourceValue.trim().length > 0 && sourceValue.length <= 256;
      if (!sourceValid) issues.add('scan_source_invalid');
      if (observation?.phase !== 'completed' || observation.failed || observation.success !== true) issues.add('scan_tool_success_unproven');
      const total = read(scan.totalRowsColumn), truncated = read(scan.outputTruncatedColumn), cursor = read(scan.cursorClosedColumn), failures = read(scan.parseFailuresColumn);
      if (!exactNs(total)) issues.add('scan_total_invalid');
      if (truncated !== 0) issues.add('scan_output_truncated_or_unknown');
      if (cursor !== 1) issues.add('scan_cursor_not_closed');
      if (!exactNs(failures) || BigInt(failures) !== 0n) issues.add('scan_parse_failures_or_unknown');
      const sibling = siblings.size === 1 ? [...siblings.values()][0] : undefined;
      if (!sibling) issues.add(siblings.size ? 'scan_result_ambiguous' : 'scan_result_missing');
      const resultTable = sibling && capturedEvidenceTable(sibling.witness);
      const resultBinding = sibling && bindings.get(sibling.witness);
      let returned: number | undefined;
      if (sibling && resultBinding && resultTable) {
        if (sibling.record.captureId !== sibling.witness.captureId || resultTable.unavailableReason ||
            ['optional_error', 'unavailable', 'skipped'].includes(sibling.record.meta.executionStatus || '') ||
            new Set(resultTable.columns).size !== resultTable.columns.length) issues.add('scan_result_unavailable');
        else if (!resultTable.columns.includes(resultBinding.declaration.window.start) ||
            !resultTable.columns.includes(resultBinding.declaration.window.end)) issues.add('scan_result_window_columns_missing');
        else if (scan.resultSourceColumn && !resultTable.columns.includes(scan.resultSourceColumn)) issues.add('scan_result_source_missing');
        else {
          returned = 0;
          for (const row of resultTable.rows) {
            if (++checkedRows > SCAN_ROW_CHECK_BUDGET) {issues.add('scan_row_budget_exhausted'); scanIssues.add('scan_row_budget_exhausted'); break;}
            if (scan.resultSourceColumn) {
              const value = row[resultTable.columns.indexOf(scan.resultSourceColumn)];
              if (typeof value !== 'string' || !value.trim() || value.length > 256) issues.add('scan_result_source_invalid');
              if (value !== sourceValue) continue;
            }
            returned++;
            const rowStart = row[resultTable.columns.indexOf(resultBinding.declaration.window.start)];
            const rowEnd = row[resultTable.columns.indexOf(resultBinding.declaration.window.end)];
            if (!exactNs(rowStart) || !exactNs(rowEnd) || BigInt(rowStart) > BigInt(rowEnd) ||
                BigInt(rowStart) < BigInt(start) || BigInt(rowEnd) > BigInt(end)) issues.add('scan_result_window_invalid');
          }
          if (exactNs(total) && BigInt(returned) !== BigInt(total)) issues.add('scan_result_count_mismatch');
        }
      }
      scans.push({recordId: `${witness.captureId}:scan:${index}`, captureId: witness.captureId,
        ...(sibling ? {resultCaptureId: sibling.witness.captureId, resultSqlHash: resultBinding?.selectedSqlHash} : {}),
        originRunId: record.originRunId, traceId: binding.traceId, traceSide: 'current', skillId: binding.skillId,
        stepId: binding.stepId, resultStepId: scan.resultStepId, sourceToolCallId: record.meta.sourceToolCallId,
        definitionFingerprint: binding.definitionFingerprint, selectedSqlHash: binding.selectedSqlHash,
        domain: scan.domain, source: sourceValid ? sourceValue as string : 'unknown', window: {start: String(start), end: String(end)},
        ...(exactNs(total) ? {totalRows: String(total)} : {}), ...(returned !== undefined ? {returnedRows: String(returned)} : {}),
        scanStatus: issues.size ? 'partial' : 'complete', captureStatus: 'unknown', issues: [...issues].sort()});
    }
  }
  return {scans, scanIssues: [...scanIssues].sort()};
}

/** The caller supplies retained private witnesses, never serialized artifact payloads. */
export function buildInvestigationEvidenceSnapshot(captures: readonly EvidenceReadRecord[], options: EvidenceReadViewOptions,
  observations: readonly InvestigationToolObservation[] = []): InvestigationEvidenceSnapshot {
  const records: InvestigationEvidenceRecord[] = [];
  const issues = new Set<string>();
  const incompleteCaptureIds = new Set<string>();
  const perMetricCounts = new Map<string, number>();
  const allowed = new Set(options.allowedTraces.map(trace => `${trace.traceSide}:${trace.traceId}`));
  const toolStates = new Map(observations.map(observation => [`${observation.originRunId || ''}:${observation.toolCallId}`, observation]));
  const scanResult = buildScanRecords(captures, options, toolStates);
  for (const observation of toolStates.values()) {
    if ((!options.currentRunId || observation.originRunId === options.currentRunId) &&
        (observation.phase === 'started' || observation.failed)) issues.add('tool_observation_incomplete');
  }
  for (const {record, witness} of captures) {
    const binding = bindings.get(witness);
    if (!binding || !binding.declaration.metrics.length) continue; // Arbitrary SQL does not acquire producer authority by choosing familiar aliases.
    const incomplete = (issue: string) => {issues.add(issue); incompleteCaptureIds.add(witness.captureId);};
    const table = capturedEvidenceTable(witness);
    const meta = record.meta;
    if (!table || table.unavailableReason || record.captureId !== witness.captureId ||
        binding.traceId !== meta.traceId || !allowed.has(`${meta.traceSide}:${meta.traceId}`) ||
        !['current', 'reference'].includes(meta.traceSide || '')) {
      incomplete('capture_scope_or_witness_unavailable'); continue;
    }
    if (meta.executionStatus === 'unavailable' || meta.executionStatus === 'optional_error') {
      incomplete('capture_execution_unavailable'); continue;
    }
    if (meta.executionStatus === 'skipped') {incomplete('capture_execution_skipped'); continue;}
    const observation = meta.sourceToolCallId ? toolStates.get(`${record.originRunId || ''}:${meta.sourceToolCallId}`) : undefined;
    const toolChecked = observation?.phase === 'completed' && !observation.failed;
    if (!toolChecked) incomplete('capture_tool_observation_missing');
    if (new Set(table.columns).size !== table.columns.length) {incomplete('capture_columns_ambiguous'); continue;}
    if (!table.rows.length) {incomplete('capture_empty'); continue;}
    const {declaration} = binding;
    const originRunId = record.originRunId;
    const origin = originRunId && options.currentRunId
      ? originRunId === options.currentRunId ? 'current_run' : 'reused' : 'unknown';
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
      if (records.length >= LEDGER_RECORD_BUDGET) {incomplete('ledger_record_budget_exhausted'); break;}
      const read = (column: string | undefined) => column ? table.rows[rowIndex][table.columns.indexOf(column)] : undefined;
      const start = read(declaration.window.start), end = read(declaration.window.end);
      const upid = read(declaration.identity?.upid), utid = read(declaration.identity?.utid);
      const cpu = read(declaration.identity?.cpu), ucpu = read(declaration.identity?.ucpu), machineId = read(declaration.identity?.machine_id);
      const windowId = read(declaration.context?.window_id), role = read(declaration.context?.role);
      if (!exactNs(start) || !exactNs(end) || BigInt(end) <= BigInt(start) ||
          Object.entries(declaration.identity || {}).some(([key, column]) => {
            const value = read(column);
            return !(value === null && ['cpu', 'ucpu', 'machine_id'].includes(key)) &&
              (!Number.isSafeInteger(value) || Number(value) < 0);
          }) ||
          (declaration.context?.window_id && !(windowId === null || typeof windowId === 'string' ||
            (typeof windowId === 'number' && Number.isSafeInteger(windowId)))) ||
          (declaration.context?.role && !(role === null || typeof role === 'string'))) {
        incomplete('capture_window_or_identity_invalid'); continue;
      }
      for (const [metricIndex, metric] of declaration.metrics.entries()) {
        if (records.length >= LEDGER_RECORD_BUDGET) {incomplete('ledger_record_budget_exhausted'); break;}
        // One chatty producer must not consume the whole budget. Without this,
        // a per-handoff or per-frame metric fills the ledger in tool-call order
        // and every later requirement reads as unacquired because its records
        // never got in, not because nobody looked.
        const metricKey = `${binding.skillId}:${metric.metric_id}`;
        const metricCount = perMetricCounts.get(metricKey) ?? 0;
        if (metricCount >= LEDGER_PER_METRIC_BUDGET) {incomplete('ledger_metric_budget_exhausted'); continue;}
        perMetricCounts.set(metricKey, metricCount + 1);
        const value = read(metric.value), rawStatus = read(metric.status);
        const coverage = read(metric.coverage), denominator = read(metric.denominator);
        const validCoverage = !metric.coverage || (exactNs(coverage) && exactNs(denominator) &&
          BigInt(denominator) > 0n && BigInt(coverage) <= BigInt(denominator));
        let status: InvestigationEvidenceRecord['status'] = rawStatus === 'observed' ? 'observed' : rawStatus === 'partial' ? 'partial' :
          ['unavailable', 'unsupported', 'not_recorded'].includes(String(rawStatus)) ? 'unavailable' : 'unknown';
        if (!toolChecked || value === undefined || !validCoverage) status = 'unknown';
        if (status === 'observed' && value === null) status = 'unavailable';
        if (status === 'observed' && metric.coverage && exactNs(coverage) && exactNs(denominator) &&
            BigInt(coverage) < BigInt(denominator)) status = 'partial';
        if (status === 'unknown') issues.add('capture_metric_unknown');
        records.push({recordId: `${witness.captureId}:${rowIndex}:${metricIndex}`, captureId: witness.captureId, rowIndex,
          evidenceRefId: meta.evidenceRefId, artifactId: meta.artifactId, sourceToolCallId: meta.sourceToolCallId,
          skillId: binding.skillId, stepId: binding.stepId, definitionFingerprint: binding.definitionFingerprint,
          selectedSqlHash: binding.selectedSqlHash, traceId: binding.traceId, traceSide: meta.traceSide as 'current' | 'reference',
          ...(originRunId ? {originRunId} : {}), origin, domain: metric.domain, metricId: metric.metric_id, status,
          window: {start, end}, ...(typeof upid === 'number' ? {upid} : {}), ...(typeof utid === 'number' ? {utid} : {}),
          ...(cpu === null || typeof cpu === 'number' ? {cpu} : {}), ...(ucpu === null || typeof ucpu === 'number' ? {ucpu} : {}),
          ...(machineId === null || typeof machineId === 'number' ? {machineId} : {}),
          ...(windowId === null || typeof windowId === 'number' || typeof windowId === 'string' ? {windowId} : {}),
          ...(role === null || typeof role === 'string' ? {role} : {}), ...(metric.aggregation ? {aggregation: metric.aggregation} : {}),
          value: value ?? null, ...(metric.unit ? {unit: metric.unit} : {}),
          ...(exactNs(coverage) ? {coverage} : {}), ...(exactNs(denominator) ? {denominator} : {})});
      }
    }
  }
  const body = {schemaVersion: 'investigation_evidence@1' as const, ownerKey: options.ownerKey,
    ...(options.currentRunId ? {currentRunId: options.currentRunId} : {}), records, issues: [...issues].sort(),
    incompleteCaptureIds: [...incompleteCaptureIds].sort(), complete: issues.size === 0,
    ...(scanResult.scans.length || scanResult.scanIssues.length ? scanResult : {})};
  const snapshot = freezeEvidenceValue({...body, fingerprint: investigationEvidenceFingerprint(body)});
  issuedSnapshots.add(snapshot);
  return snapshot;
}
