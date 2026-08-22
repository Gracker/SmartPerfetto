// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {validateDataEnvelope, type DataEnvelope, type DataPayload} from '../../types/dataContract';
import type {EvidenceRelationCandidateV1, EvidenceRelationEndpointV1} from '../../types/evidenceContract';
import {deriveExactEvidenceTimeRangeNs} from './evidenceContractBuilder';

const INPUT_SKILL_ID = 'click_response_analysis';
const SLOW_INPUT_STEP_ID = 'slow_input_events';
const MAX_CANDIDATES = 50;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const BOTTLENECKS = new Set(['系统分发', '应用处理', 'ACK']);

interface SlowInputRow {
  evidenceRefId: string;
  sourceToolCallId: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  rowIndex: number;
  frameId: string;
  eventTs: string;
  eventEndTs: string;
  mainBottleneck: string;
}

function rowsAsObjects(envelope: DataEnvelope): Record<string, unknown>[] {
  const data = envelope.data as DataPayload | undefined;
  if (!data || !Array.isArray(data.rows)) return [];
  const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
  return data.rows.map(row => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row as unknown as Record<string, unknown>;
    }
    const object: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      columns.forEach((column, index) => {
        object[column] = row[index];
      });
    }
    return object;
  });
}

function canonicalInt64(value: unknown): string | undefined {
  const serialized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value
      : undefined;
  if (!serialized || !/^(?:0|[1-9]\d*)$/.test(serialized)) return undefined;
  try {
    return BigInt(serialized) <= MAX_INT64 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function admittedEnvelope(envelope: DataEnvelope): boolean {
  const meta = envelope.meta;
  return validateDataEnvelope(envelope).length === 0 &&
    meta.type === 'skill_result' &&
    meta.skillId === INPUT_SKILL_ID &&
    meta.stepId === SLOW_INPUT_STEP_ID &&
    meta.executionStatus === 'observed' &&
    typeof meta.evidenceRefId === 'string' && meta.evidenceRefId.trim() === meta.evidenceRefId &&
    meta.evidenceRefId.length > 0 &&
    typeof meta.sourceToolCallId === 'string' &&
    meta.sourceToolCallId.trim() === meta.sourceToolCallId && meta.sourceToolCallId.length > 0 &&
    typeof meta.traceId === 'string' && meta.traceId.trim() === meta.traceId && meta.traceId.length > 0 &&
    (meta.traceSide === 'current' || meta.traceSide === 'reference');
}

function exactRows(envelope: DataEnvelope): SlowInputRow[] {
  if (!admittedEnvelope(envelope)) return [];
  const meta = envelope.meta;
  return rowsAsObjects(envelope).slice(0, MAX_CANDIDATES).flatMap((row, rowIndex) => {
    const frameId = canonicalInt64(row.frame_id);
    const range = deriveExactEvidenceTimeRangeNs({event_ts: row.event_ts, event_end_ts: row.event_end_ts});
    const mainBottleneck = typeof row.main_bottleneck === 'string' && BOTTLENECKS.has(row.main_bottleneck)
      ? row.main_bottleneck
      : undefined;
    if (!frameId || !range || !mainBottleneck || range.end <= range.start) return [];
    return [{
      evidenceRefId: meta.evidenceRefId!,
      sourceToolCallId: meta.sourceToolCallId!,
      traceId: meta.traceId!,
      traceSide: meta.traceSide as 'current' | 'reference',
      rowIndex,
      frameId,
      eventTs: range.start.toString(),
      eventEndTs: range.end.toString(),
      mainBottleneck,
    }];
  });
}

function compareRows(left: SlowInputRow, right: SlowInputRow): number {
  return left.traceId.localeCompare(right.traceId) ||
    left.traceSide.localeCompare(right.traceSide) ||
    left.evidenceRefId.localeCompare(right.evidenceRefId) ||
    left.sourceToolCallId.localeCompare(right.sourceToolCallId) ||
    left.rowIndex - right.rowIndex ||
    left.frameId.localeCompare(right.frameId) ||
    left.eventTs.localeCompare(right.eventTs) ||
    left.eventEndTs.localeCompare(right.eventEndTs) ||
    left.mainBottleneck.localeCompare(right.mainBottleneck);
}

function endpoint(row: SlowInputRow, column: 'frame_id' | 'main_bottleneck'): EvidenceRelationEndpointV1 {
  return {
    evidenceRefId: row.evidenceRefId,
    sourceToolCallId: row.sourceToolCallId,
    rowIndex: row.rowIndex,
    column,
    value: column === 'frame_id' ? row.frameId : row.mainBottleneck,
  };
}

function relationId(row: SlowInputRow): string {
  const identity = JSON.stringify([
    'input-frame-bottleneck', row.traceId, row.traceSide, row.evidenceRefId, row.sourceToolCallId,
    row.rowIndex, row.frameId, row.eventTs, row.eventEndTs, row.mainBottleneck,
  ]);
  return `relation:input-frame-bottleneck:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function produceInputRelationCandidates(
  dataEnvelopes: DataEnvelope[] = [],
): EvidenceRelationCandidateV1[] {
  const byId = new Map<string, EvidenceRelationCandidateV1>();
  const rows = dataEnvelopes.flatMap(exactRows).sort(compareRows);
  for (const row of rows) {
    const id = relationId(row);
    if (!byId.has(id)) {
      byId.set(id, {
        schemaVersion: 'evidence_relation_candidate@1',
        id,
        kind: 'derived',
        direction: 'subject_to_object',
        subject: endpoint(row, 'frame_id'),
        object: endpoint(row, 'main_bottleneck'),
      });
    }
    if (byId.size >= MAX_CANDIDATES) break;
  }
  return Array.from(byId.values());
}
