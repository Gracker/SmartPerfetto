// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {validateDataEnvelope, type DataEnvelope, type DataPayload} from '../../types/dataContract';
import type {EvidenceRelationCandidateV1, EvidenceRelationEndpointV1} from '../../types/evidenceContract';
import {deriveExactEvidenceTimeRangeNs} from './evidenceContractBuilder';

const STARTUP_SKILL_ID = 'startup_analysis';
const STARTUP_STEP_ID = 'get_startups';
const BINDER_STEP_ID = 'main_thread_binder_blocking';
const MAX_ROWS_PER_ENVELOPE = 50;
const MAX_CANDIDATES = 50;

interface ExactEnvelopeRow {
  evidenceRefId: string;
  sourceToolCallId?: string;
  traceId: string;
  traceSide: 'current' | 'reference';
  rowIndex: number;
  start: bigint;
  end: bigint;
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

function admittedEnvelope(envelope: DataEnvelope, stepId: string): boolean {
  const meta = envelope.meta;
  return validateDataEnvelope(envelope).length === 0 &&
    meta.skillId === STARTUP_SKILL_ID &&
    meta.stepId === stepId &&
    (meta.executionStatus === undefined || meta.executionStatus === 'observed') &&
    typeof meta.evidenceRefId === 'string' && meta.evidenceRefId.trim() === meta.evidenceRefId &&
    meta.evidenceRefId.length > 0 &&
    typeof meta.traceId === 'string' && meta.traceId.trim() === meta.traceId && meta.traceId.length > 0 &&
    (meta.traceSide === 'current' || meta.traceSide === 'reference');
}

function exactRows(envelope: DataEnvelope, stepId: string): ExactEnvelopeRow[] {
  if (!admittedEnvelope(envelope, stepId)) return [];
  const meta = envelope.meta;
  return rowsAsObjects(envelope).slice(0, MAX_ROWS_PER_ENVELOPE).flatMap((row, rowIndex) => {
    const hasValue = (key: string): boolean => row[key] !== undefined && row[key] !== null;
    const hasProducerFields = stepId === STARTUP_STEP_ID
      ? hasValue('start_ts') && hasValue('end_ts')
      : hasValue('ts_str') && (hasValue('dur_str') || hasValue('dur_ms'));
    if (!hasProducerFields) return [];
    const range = deriveExactEvidenceTimeRangeNs(row);
    if (!range) return [];
    return [{
      evidenceRefId: meta.evidenceRefId!,
      ...(typeof meta.sourceToolCallId === 'string' && meta.sourceToolCallId.trim()
        ? {sourceToolCallId: meta.sourceToolCallId}
        : {}),
      traceId: meta.traceId!,
      traceSide: meta.traceSide as 'current' | 'reference',
      rowIndex,
      start: range.start,
      end: range.end,
    }];
  });
}

function compareString(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function stableRowOrder(left: ExactEnvelopeRow, right: ExactEnvelopeRow): number {
  const lexical = compareString(left.traceId, right.traceId) ||
    compareString(left.traceSide, right.traceSide) ||
    compareString(left.evidenceRefId, right.evidenceRefId) ||
    left.rowIndex - right.rowIndex;
  if (lexical !== 0) return lexical;
  if (left.start !== right.start) return left.start < right.start ? -1 : 1;
  if (left.end !== right.end) return left.end < right.end ? -1 : 1;
  return 0;
}

function endpoint(row: ExactEnvelopeRow): EvidenceRelationEndpointV1 {
  return {
    evidenceRefId: row.evidenceRefId,
    ...(row.sourceToolCallId ? {sourceToolCallId: row.sourceToolCallId} : {}),
    rowIndex: row.rowIndex,
  };
}

function relationId(subject: ExactEnvelopeRow, object: ExactEnvelopeRow): string {
  const identity = JSON.stringify([
    'startup-binder-overlap',
    subject.traceId,
    subject.traceSide,
    subject.evidenceRefId,
    subject.rowIndex,
    object.evidenceRefId,
    object.rowIndex,
  ]);
  return `relation:startup-binder-overlap:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function overlaps(subject: ExactEnvelopeRow, object: ExactEnvelopeRow): boolean {
  if (subject.traceId !== object.traceId || subject.traceSide !== object.traceSide) return false;
  if (subject.end <= subject.start || object.end <= object.start) return false;
  return (subject.start > object.start ? subject.start : object.start) <
    (subject.end < object.end ? subject.end : object.end);
}

export function produceStartupRelationCandidates(
  dataEnvelopes: DataEnvelope[] = [],
): EvidenceRelationCandidateV1[] {
  const startups = dataEnvelopes.flatMap(envelope => exactRows(envelope, STARTUP_STEP_ID)).sort(stableRowOrder);
  const binders = dataEnvelopes.flatMap(envelope => exactRows(envelope, BINDER_STEP_ID)).sort(stableRowOrder);
  const byId = new Map<string, EvidenceRelationCandidateV1>();

  for (const startup of startups) {
    for (const binder of binders) {
      if (!overlaps(startup, binder)) continue;
      const id = relationId(startup, binder);
      if (!byId.has(id)) {
        byId.set(id, {
          schemaVersion: 'evidence_relation_candidate@1',
          id,
          kind: 'overlap',
          direction: 'subject_to_object',
          subject: endpoint(startup),
          object: endpoint(binder),
        });
      }
      if (byId.size >= MAX_CANDIDATES) return Array.from(byId.values());
    }
  }
  return Array.from(byId.values());
}
