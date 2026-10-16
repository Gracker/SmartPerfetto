// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { DataEnvelope } from '../../types/dataContract';
import type { HeapPathClusterFailure, HeapPathClusterInputRow } from '../../types/heapPathCluster';
import type { SkillBatchAnalysisConfig } from '../skillEngine/types';
import {
  BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
  BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
  type BatchTraceDomainAnalysisV1,
  type BatchTraceDomainEvidenceRowV1,
  type BatchTraceDomainEvidenceValue,
  type BatchTraceResultStatus,
} from './batchTraceTypes';
import { clusterHeapPaths } from './heapPathClusterService';
import {rowObject} from '../../utils/traceProcessorRowUtils';

export interface BatchPostProcessorTraceInput {
  ordinal: number;
  traceIdentity: string;
  traceId?: string;
  status: BatchTraceResultStatus;
  sourceEnvelope?: DataEnvelope;
  error?: string;
  preTruncatedRowCount?: number;
}

export interface RunBatchPostProcessorInput {
  skillId: string;
  config: SkillBatchAnalysisConfig;
  traces: BatchPostProcessorTraceInput[];
}

export interface RetainedBatchSourceEnvelope {
  envelope: DataEnvelope;
  truncatedRowCount: number;
}

interface AdaptedHeapRows {
  evidenceRows: BatchTraceDomainEvidenceRowV1[];
  clusterRows: HeapPathClusterInputRow[];
  failures: HeapPathClusterFailure[];
  truncatedRowCount: number;
  eligibleTraceCount: number;
}

type BatchPostProcessor = (input: RunBatchPostProcessorInput) => BatchTraceDomainAnalysisV1;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function evidenceValue(value: unknown): BatchTraceDomainEvidenceValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return value === undefined ? null : String(value);
}

function rowRecord(row: unknown, columns: string[]): Record<string, unknown> | null {
  if (isRecord(row)) return row;
  if (!Array.isArray(row) || columns.length === 0) return null;
  return rowObject(columns, row);
}

function envelopeRows(envelope: DataEnvelope): {columns: string[]; rows: unknown[]} {
  const data = envelope.data as unknown as {columns?: unknown; rows?: unknown};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const explicitColumns = Array.isArray(data.columns)
    ? data.columns.filter((column): column is string => typeof column === 'string')
    : [];
  const objectColumns = rows.find(isRecord);
  return {
    columns: explicitColumns.length > 0 ? explicitColumns : objectColumns ? Object.keys(objectColumns) : [],
    rows,
  };
}

function canonicalValues(record: Record<string, unknown>, columns: string[]): Record<string, BatchTraceDomainEvidenceValue> {
  return Object.fromEntries(columns.map(column => [column, evidenceValue(record[column])])) as Record<
    string,
    BatchTraceDomainEvidenceValue
  >;
}

function numericValue(value: BatchTraceDomainEvidenceValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

function stringValue(value: BatchTraceDomainEvidenceValue): string {
  return value === null ? '' : String(value);
}

function compareSourceRows(
  a: Record<string, BatchTraceDomainEvidenceValue>,
  b: Record<string, BatchTraceDomainEvidenceValue>,
): number {
  return numericValue(b.retained_size_bytes) - numericValue(a.retained_size_bytes)
    || numericValue(b.self_size_bytes) - numericValue(a.self_size_bytes)
    || JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function traceFailure(trace: BatchPostProcessorTraceInput, reason: string): HeapPathClusterFailure {
  return {traceOrdinal: trace.ordinal, traceId: trace.traceIdentity, reason};
}

function adaptTraceRows(input: RunBatchPostProcessorInput): AdaptedHeapRows {
  const failures: HeapPathClusterFailure[] = [];
  const boundedByTrace: Array<{
    trace: BatchPostProcessorTraceInput;
    rows: Array<Record<string, BatchTraceDomainEvidenceValue>>;
  }> = [];
  let sourceRowCount = 0;
  let preTruncatedRowCount = 0;
  let eligibleTraceCount = 0;

  for (const trace of [...input.traces].sort((a, b) => a.ordinal - b.ordinal)) {
    preTruncatedRowCount += trace.preTruncatedRowCount ?? 0;
    if (trace.status !== 'completed') {
      failures.push(traceFailure(trace, trace.error ?? `trace_status:${trace.status}`));
      continue;
    }
    if (!trace.sourceEnvelope) {
      failures.push(traceFailure(trace, `source_step_missing:${input.config.source_step}`));
      continue;
    }
    const source = envelopeRows(trace.sourceEnvelope);
    const missingColumns = input.config.required_columns.filter(column => !source.columns.includes(column));
    if (missingColumns.length > 0) {
      failures.push(traceFailure(trace, `missing_required_columns:${missingColumns.join(',')}`));
      continue;
    }
    const sourceRecords = source.rows.map(row => rowRecord(row, source.columns));
    const malformedRowCount = sourceRecords.filter(row => row === null).length;
    if (malformedRowCount > 0) {
      failures.push(traceFailure(trace, `malformed_source_rows:${malformedRowCount}`));
      continue;
    }
    const rows = sourceRecords
      .filter((row): row is Record<string, unknown> => row !== null)
      .map(row => canonicalValues(row, input.config.required_columns))
      .sort(compareSourceRows);
    sourceRowCount += rows.length;
    // A valid zero-row source step still belongs in the support denominator:
    // it proves that the Skill executed and found no matching heap path.
    eligibleTraceCount += 1;
    boundedByTrace.push({trace, rows: rows.slice(0, input.config.per_trace_row_limit)});
  }

  const selected: Array<{
    trace: BatchPostProcessorTraceInput;
    values: Record<string, BatchTraceDomainEvidenceValue>;
  }> = [];
  for (let rowIndex = 0; selected.length < input.config.total_row_limit; rowIndex += 1) {
    let added = false;
    for (const entry of boundedByTrace) {
      const values = entry.rows[rowIndex];
      if (!values) continue;
      selected.push({trace: entry.trace, values});
      added = true;
      if (selected.length === input.config.total_row_limit) break;
    }
    if (!added) break;
  }

  const occurrenceByCanonicalRow = new Map<string, number>();
  const evidenceRows: BatchTraceDomainEvidenceRowV1[] = [];
  const clusterRows: HeapPathClusterInputRow[] = [];
  for (const entry of selected) {
    const canonical = JSON.stringify(entry.values);
    const occurrenceKey = `${entry.trace.traceIdentity}\0${canonical}`;
    const occurrence = occurrenceByCanonicalRow.get(occurrenceKey) ?? 0;
    occurrenceByCanonicalRow.set(occurrenceKey, occurrence + 1);
    const refId = `batch-row-${sha256([
      input.skillId,
      input.config.source_step,
      entry.trace.traceIdentity,
      canonical,
      occurrence,
    ].join('\0'))}`;
    evidenceRows.push({
      refId,
      traceOrdinal: entry.trace.ordinal,
      traceIdentity: entry.trace.traceIdentity,
      ...(entry.trace.traceId ? {traceId: entry.trace.traceId} : {}),
      values: entry.values,
    });
    clusterRows.push({
      traceOrdinal: entry.trace.ordinal,
      traceId: entry.trace.traceIdentity,
      upid: numericValue(entry.values.upid),
      sampleTs: stringValue(entry.values.graph_sample_ts),
      processName: stringValue(entry.values.process_name),
      path: stringValue(entry.values.path),
      className: stringValue(entry.values.class_name),
      rootType: stringValue(entry.values.root_type),
      selfSizeBytes: numericValue(entry.values.self_size_bytes),
      retainedSizeBytes: numericValue(entry.values.retained_size_bytes),
      evidenceRefId: refId,
    });
  }

  return {
    evidenceRows,
    clusterRows,
    failures,
    truncatedRowCount: preTruncatedRowCount + sourceRowCount - selected.length,
    eligibleTraceCount,
  };
}

function heapPathClusterProcessor(input: RunBatchPostProcessorInput): BatchTraceDomainAnalysisV1 {
  const adapted = adaptTraceRows(input);
  const result = clusterHeapPaths(adapted.clusterRows, adapted.failures, {
    maxRows: input.config.total_row_limit,
    traceUniverseSize: adapted.eligibleTraceCount,
  });
  if (adapted.truncatedRowCount > 0) {
    result.limitations = [...result.limitations, `batch_source_rows_truncated:${adapted.truncatedRowCount}`];
    if (result.status === 'completed') result.status = 'partial';
  }
  const evidence = {
    schemaVersion: BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
    skillId: input.skillId,
    sourceStepId: input.config.source_step,
    requiredColumns: [...input.config.required_columns],
    rowCount: adapted.evidenceRows.length,
    rejectedRowCount: result.input.rejectedRowCount,
    truncatedRowCount: adapted.truncatedRowCount,
    rows: adapted.evidenceRows,
  };
  const resolvableRefs = new Set(evidence.rows.map(row => row.refId));
  const unresolvedRef = result.clusters
    .flatMap(cluster => cluster.evidenceRefIds)
    .find(refId => !resolvableRefs.has(refId));
  if (unresolvedRef) throw new Error(`unresolved_batch_evidence_ref:${unresolvedRef}`);
  return {
    schemaVersion: BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
    operation: 'heap_path_cluster',
    evidence,
    result,
  };
}

const PROCESSORS: Record<SkillBatchAnalysisConfig['operation'], BatchPostProcessor> = {
  heap_path_cluster: heapPathClusterProcessor,
};

export function retainBatchSourceEnvelope(envelope: DataEnvelope, rowLimit: number): RetainedBatchSourceEnvelope {
  const source = envelopeRows(envelope);
  const retainedRows = source.rows.slice(0, rowLimit);
  return {
    envelope: {
      ...envelope,
      data: {...envelope.data, rows: retainedRows} as DataEnvelope['data'],
    },
    truncatedRowCount: source.rows.length - retainedRows.length,
  };
}

export function runBatchPostProcessor(input: RunBatchPostProcessorInput): BatchTraceDomainAnalysisV1 {
  const operation = input.config.operation as string;
  const processor = (PROCESSORS as Record<string, BatchPostProcessor>)[operation];
  if (!processor) throw new Error(`unknown_batch_analysis_operation:${operation}`);
  return processor(input);
}
