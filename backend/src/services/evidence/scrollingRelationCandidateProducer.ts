// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {validateDataEnvelope, type DataEnvelope, type DataPayload} from '../../types/dataContract';
import type {EvidenceRelationCandidateV1, EvidenceRelationEndpointV1} from '../../types/evidenceContract';
import {deriveExactEvidenceTimeRangeNs} from './evidenceContractBuilder';

const SCROLLING_SKILL_ID = 'scrolling_analysis';
const ROOT_CAUSE_STEP_ID = 'batch_frame_root_cause';
const MAX_CANDIDATES = 50;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const SAFE_REASON_CODE = /^[a-z0-9_]{1,64}$/;

interface ScrollingRootCauseRow {
  evidenceRefId: string;
  sourceToolCallId?: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  rowIndex: number;
  frameId: string;
  reasonCode: string;
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

function canonicalFrameId(value: unknown): string | undefined {
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
    meta.skillId === SCROLLING_SKILL_ID &&
    meta.stepId === ROOT_CAUSE_STEP_ID &&
    meta.executionStatus === 'observed' &&
    typeof meta.evidenceRefId === 'string' && meta.evidenceRefId.trim() === meta.evidenceRefId &&
    meta.evidenceRefId.length > 0 &&
    typeof meta.traceId === 'string' && meta.traceId.trim() === meta.traceId && meta.traceId.length > 0 &&
    (meta.traceSide === 'current' || meta.traceSide === 'reference') &&
    (meta.sourceToolCallId === undefined ||
      (typeof meta.sourceToolCallId === 'string' && meta.sourceToolCallId.trim() === meta.sourceToolCallId &&
        meta.sourceToolCallId.length > 0));
}

function exactRows(envelope: DataEnvelope): ScrollingRootCauseRow[] {
  if (!admittedEnvelope(envelope)) return [];
  const meta = envelope.meta;
  return rowsAsObjects(envelope).slice(0, MAX_CANDIDATES).flatMap((row, rowIndex) => {
    if (row.start_ts === undefined || row.start_ts === null) return [];
    const durationRow = row.dur !== undefined && row.dur !== null
      ? {start_ts: row.start_ts, dur: row.dur}
      : row.dur_str !== undefined && row.dur_str !== null
        ? {start_ts: row.start_ts, dur_str: row.dur_str}
        : row.dur_ms !== undefined && row.dur_ms !== null
          ? {start_ts: row.start_ts, dur_ms: row.dur_ms}
          : undefined;
    if (!durationRow) return [];
    const frameId = canonicalFrameId(row.frame_id);
    const reasonCode = typeof row.reason_code === 'string' && SAFE_REASON_CODE.test(row.reason_code)
      ? row.reason_code
      : undefined;
    const range = deriveExactEvidenceTimeRangeNs(durationRow);
    if (!frameId || !reasonCode || !range || range.end <= range.start) return [];
    return [{
      evidenceRefId: meta.evidenceRefId!,
      ...(meta.sourceToolCallId ? {sourceToolCallId: meta.sourceToolCallId} : {}),
      traceId: meta.traceId!,
      traceSide: meta.traceSide as 'current' | 'reference',
      rowIndex,
      frameId,
      reasonCode,
    }];
  });
}

function compareRows(left: ScrollingRootCauseRow, right: ScrollingRootCauseRow): number {
  return left.traceId.localeCompare(right.traceId) ||
    left.traceSide.localeCompare(right.traceSide) ||
    left.evidenceRefId.localeCompare(right.evidenceRefId) ||
    left.rowIndex - right.rowIndex ||
    left.frameId.localeCompare(right.frameId) ||
    left.reasonCode.localeCompare(right.reasonCode);
}

function endpoint(row: ScrollingRootCauseRow, column: 'frame_id' | 'reason_code'): EvidenceRelationEndpointV1 {
  return {
    evidenceRefId: row.evidenceRefId,
    ...(row.sourceToolCallId ? {sourceToolCallId: row.sourceToolCallId} : {}),
    rowIndex: row.rowIndex,
    column,
    value: column === 'frame_id' ? row.frameId : row.reasonCode,
  };
}

function relationId(row: ScrollingRootCauseRow): string {
  const identity = JSON.stringify([
    'scrolling-frame-root-cause', row.traceId, row.traceSide, row.evidenceRefId,
    row.rowIndex, row.frameId, row.reasonCode,
  ]);
  return `relation:scrolling-frame-root-cause:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function produceScrollingRelationCandidates(
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
        object: endpoint(row, 'reason_code'),
      });
    }
    if (byId.size >= MAX_CANDIDATES) break;
  }
  return Array.from(byId.values());
}
