// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {validateDataEnvelope, type DataEnvelope, type DataPayload} from '../../types/dataContract';
import type {EvidenceRelationCandidateV1, EvidenceRelationEndpointV1} from '../../types/evidenceContract';
import {deriveExactEvidenceTimeRangeNs} from './evidenceContractBuilder';

const ANR_SKILL_ID = 'anr_analysis';
const ANR_EVENTS_STEP_ID = 'get_anr_events';
const MAX_CANDIDATES = 50;
const SAFE_TRIGGER_TYPE = /^[a-z0-9_]{1,64}$/;

interface AnrEventRow {
  evidenceRefId: string;
  sourceToolCallId: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  rowIndex: number;
  errorId: string;
  triggerType: string;
  perfettoStart: string;
  anrTs: string;
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

function stablePrimitiveIdentity(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() === value && value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function admittedEnvelope(envelope: DataEnvelope): boolean {
  const meta = envelope.meta;
  return validateDataEnvelope(envelope).length === 0 &&
    meta.type === 'skill_result' &&
    meta.skillId === ANR_SKILL_ID &&
    meta.stepId === ANR_EVENTS_STEP_ID &&
    meta.executionStatus === 'observed' &&
    typeof meta.evidenceRefId === 'string' && meta.evidenceRefId.trim() === meta.evidenceRefId &&
    meta.evidenceRefId.length > 0 &&
    typeof meta.sourceToolCallId === 'string' &&
    meta.sourceToolCallId.trim() === meta.sourceToolCallId && meta.sourceToolCallId.length > 0 &&
    typeof meta.traceId === 'string' && meta.traceId.trim() === meta.traceId && meta.traceId.length > 0 &&
    (meta.traceSide === 'current' || meta.traceSide === 'reference');
}

function exactRows(envelope: DataEnvelope): AnrEventRow[] {
  if (!admittedEnvelope(envelope)) return [];
  const meta = envelope.meta;
  return rowsAsObjects(envelope).slice(0, MAX_CANDIDATES).flatMap((row, rowIndex) => {
    const errorId = stablePrimitiveIdentity(row.error_id);
    const triggerType = typeof row.trigger_type === 'string' && SAFE_TRIGGER_TYPE.test(row.trigger_type)
      ? row.trigger_type
      : undefined;
    const range = deriveExactEvidenceTimeRangeNs({perfetto_start: row.perfetto_start, anr_ts: row.anr_ts});
    if (!errorId || !triggerType || !range || range.end <= range.start) return [];
    return [{
      evidenceRefId: meta.evidenceRefId!,
      sourceToolCallId: meta.sourceToolCallId!,
      traceId: meta.traceId!,
      traceSide: meta.traceSide as 'current' | 'reference',
      rowIndex,
      errorId,
      triggerType,
      perfettoStart: range.start.toString(),
      anrTs: range.end.toString(),
    }];
  });
}

function compareRows(left: AnrEventRow, right: AnrEventRow): number {
  return left.traceId.localeCompare(right.traceId) ||
    left.traceSide.localeCompare(right.traceSide) ||
    left.evidenceRefId.localeCompare(right.evidenceRefId) ||
    left.sourceToolCallId.localeCompare(right.sourceToolCallId) ||
    left.rowIndex - right.rowIndex ||
    left.errorId.localeCompare(right.errorId) ||
    left.perfettoStart.localeCompare(right.perfettoStart) ||
    left.anrTs.localeCompare(right.anrTs) ||
    left.triggerType.localeCompare(right.triggerType);
}

function endpoint(row: AnrEventRow, column: 'error_id' | 'trigger_type'): EvidenceRelationEndpointV1 {
  return {
    evidenceRefId: row.evidenceRefId,
    sourceToolCallId: row.sourceToolCallId,
    rowIndex: row.rowIndex,
    column,
    value: column === 'error_id' ? row.errorId : row.triggerType,
  };
}

function relationId(row: AnrEventRow): string {
  const identity = JSON.stringify([
    'anr-error-trigger', row.traceId, row.traceSide, row.evidenceRefId, row.sourceToolCallId,
    row.rowIndex, row.errorId, row.perfettoStart, row.anrTs, row.triggerType,
  ]);
  return `relation:anr-error-trigger:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

export function produceAnrRelationCandidates(
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
        subject: endpoint(row, 'error_id'),
        object: endpoint(row, 'trigger_type'),
      });
    }
    if (byId.size >= MAX_CANDIDATES) break;
  }
  return Array.from(byId.values());
}
