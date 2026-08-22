// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type {
  ConclusionClaimKind,
  ConclusionContract,
  ConclusionContractClaimItem,
  ConclusionContractClaimReference,
} from '../../agent/core/conclusionContract';
import type { ComparisonReportSection } from '../../agentv3/sessionStateSnapshot';
import {
  validateDataEnvelope,
  type DataEnvelope,
  type DataPayload,
  type DataEnvelopeTraceSide,
} from '../../types/dataContract';
import type {
  ClaimKindV1,
  EvidencePaneSide,
  ClaimSupportV1,
  EvidenceAnchorV1,
  EvidenceCellV1,
  EvidenceContractV1,
  EvidenceIdentityV1,
  EvidenceProducerKind,
  EvidenceRelationCandidateV1,
  EvidenceRelationEndpointV1,
  EvidenceRelationReasonCodeV1,
  EvidenceRelationV1,
  EvidenceRelationVerificationStatusV1,
  EvidenceSupportLevel,
  EvidenceTimeRangeV1,
  TraceTimestampNs,
} from '../../types/evidenceContract';
import { evidenceValuesMatch } from './valueComparison';

export interface BuildEvidenceContractInput {
  conclusionContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
  comparisonReportSection?: ComparisonReportSection;
  relationCandidates?: EvidenceRelationCandidateV1[];
}

interface EnvelopeMatch {
  envelope: DataEnvelope;
  row?: Record<string, unknown>;
  rowIndex?: number;
  missingReason?: string;
}

interface BuiltRelations {
  relations: EvidenceRelationV1[];
  anchors: EvidenceAnchorV1[];
  warnings: string[];
}

interface RelationEvaluation {
  status: EvidenceRelationVerificationStatusV1;
  reasonCode: EvidenceRelationReasonCodeV1;
}

const RELATION_KINDS = new Set([
  'overlap',
  'wakeup',
  'blocking_state',
  'binder_peer',
  'lock_owner',
  'comparison_delta',
  'derived',
]);
const RELATION_DIRECTIONS = new Set(['subject_to_object', 'object_to_subject', 'symmetric']);
const BINARY_RELATION_KINDS = new Set(['wakeup', 'blocking_state', 'binder_peer', 'lock_owner']);
const RELATION_WARNING_LIMIT = 32;

function stableHash(value: unknown): string {
  return crypto
    .createHash('sha1')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

function sanitizeIdPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function isRelationEndpoint(value: unknown): value is EvidenceRelationEndpointV1 {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    'evidenceRefId', 'sourceToolCallId', 'sourceRef', 'artifactId', 'sourceArtifactId',
    'rowIndex', 'rowSelector', 'column', 'value',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) return false;
  const identifiers = ['evidenceRefId', 'sourceToolCallId', 'sourceRef', 'artifactId', 'sourceArtifactId'];
  if (!identifiers.some(key => typeof value[key] === 'string' && String(value[key]).trim().length > 0)) return false;
  if (value.rowIndex !== undefined && (!Number.isInteger(value.rowIndex) || Number(value.rowIndex) < 0)) return false;
  if (value.rowIndex !== undefined && value.rowSelector !== undefined) return false;
  if (value.rowSelector !== undefined) {
    if (!isRecord(value.rowSelector) || Object.keys(value.rowSelector).length === 0) return false;
    if (Object.entries(value.rowSelector).some(([key, raw]) => !key.trim() || !isPrimitive(raw))) return false;
  }
  for (const key of ['evidenceRefId', 'sourceToolCallId', 'sourceRef', 'artifactId', 'sourceArtifactId', 'column']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !String(value[key]).trim())) return false;
  }
  return value.value === undefined || isPrimitive(value.value);
}

function isProofBinding(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).every(key => key === 'endpointColumn' || key === 'proofColumn') &&
    typeof value.endpointColumn === 'string' && value.endpointColumn.trim().length > 0 &&
    typeof value.proofColumn === 'string' && value.proofColumn.trim().length > 0;
}

function isProofBindings(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).every(key => key === 'subject' || key === 'object') &&
    isProofBinding(value.subject) && isProofBinding(value.object);
}

function relationCandidateError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'invalid_shape';
  const allowed = new Set([
    'schemaVersion', 'id', 'kind', 'direction', 'subject', 'object', 'proof',
    'proofBindings', 'metricColumn', 'value', 'unit', 'deltaDirection',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) return 'unknown_field';
  if (value.schemaVersion !== 'evidence_relation_candidate@1') return 'invalid_schema_version';
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)) return 'invalid_id';
  if (!RELATION_KINDS.has(String(value.kind))) return 'invalid_kind';
  if (!RELATION_DIRECTIONS.has(String(value.direction))) return 'invalid_direction';
  if (!isRelationEndpoint(value.subject)) return 'invalid_subject';
  if (value.object !== undefined && !isRelationEndpoint(value.object)) return 'invalid_object';
  if (value.proof !== undefined && !isRelationEndpoint(value.proof)) return 'invalid_proof';
  if (value.proofBindings !== undefined && !isProofBindings(value.proofBindings)) return 'invalid_proof_bindings';
  if (value.metricColumn !== undefined && (typeof value.metricColumn !== 'string' || !value.metricColumn.trim())) {
    return 'invalid_metric_column';
  }
  if (value.value !== undefined && !isPrimitive(value.value)) return 'invalid_value';
  if (value.unit !== undefined && (typeof value.unit !== 'string' || !value.unit.trim())) return 'invalid_unit';
  if (value.deltaDirection !== undefined && value.deltaDirection !== 'current_minus_reference') {
    return 'invalid_delta_direction';
  }
  if (value.kind !== 'derived' && value.object === undefined) return 'missing_object';
  if (BINARY_RELATION_KINDS.has(String(value.kind)) && !isProofBindings(value.proofBindings)) {
    return 'missing_proof_bindings';
  }
  if (BINARY_RELATION_KINDS.has(String(value.kind))) {
    const bindings = value.proofBindings as EvidenceRelationCandidateV1['proofBindings'];
    const subject = value.subject as EvidenceRelationEndpointV1;
    const object = value.object as EvidenceRelationEndpointV1;
    if ((subject.column && subject.column !== bindings!.subject.endpointColumn) ||
      (object.column && object.column !== bindings!.object.endpointColumn)) {
      return 'endpoint_binding_column_conflict';
    }
  }
  if (value.kind === 'comparison_delta') {
    if (value.deltaDirection !== 'current_minus_reference') return 'missing_delta_direction';
    if (typeof value.metricColumn !== 'string' || !value.metricColumn.trim()) return 'missing_metric_column';
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return 'invalid_delta_value';
    const subject = value.subject as EvidenceRelationEndpointV1;
    const object = value.object as EvidenceRelationEndpointV1;
    if ((subject.column && subject.column !== value.metricColumn) ||
      (object.column && object.column !== value.metricColumn)) return 'metric_column_conflict';
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function inferClaimKind(
  claim: ConclusionContractClaimItem,
  references: ConclusionContractClaimReference[],
): ClaimKindV1 {
  if (claim.kind && !(claim.kind === 'inference' && references.length > 0)) return claim.kind;
  if (references.some(ref => typeof ref.value === 'number')) return 'numeric';
  if (references.some(ref => {
    const column = String(ref.column || '').toLowerCase();
    return column === 'ts' || column.endsWith('_ts') || column.includes('timestamp') || column.includes('dur');
  })) return 'time_range';
  if (references.some(ref => {
    const column = String(ref.column || '').toLowerCase();
    return column.includes('process') || column.includes('thread') || column === 'upid' || column === 'utid' || column === 'pid' || column === 'tid';
  })) return 'identity';
  return references.length > 0 ? 'categorical' : 'inference';
}

function rowsAsObjects(envelope: DataEnvelope): Record<string, unknown>[] {
  const data = envelope.data as DataPayload | undefined;
  if (!data || !Array.isArray(data.rows)) return [];
  const columns = Array.isArray(data.columns)
    ? data.columns.map(col => String(col))
    : [];
  return data.rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      columns.forEach((col, index) => {
        record[col] = row[index];
      });
    }
    return record;
  });
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function valuesMatch(expected: unknown, actual: unknown): boolean {
  return evidenceValuesMatch(expected, actual);
}

function evidenceCellCheckStatus(cell: EvidenceCellV1): 'matched' | 'mismatch' | 'not_checked' {
  if (cell.value === undefined) return 'not_checked';
  const actual = cell.actualValue !== undefined ? cell.actualValue : cell.displayValue;
  return valuesMatch(cell.value, actual) ? 'matched' : 'mismatch';
}

function rowMatchesSelector(row: Record<string, unknown>, selector: Record<string, string | number | boolean>): boolean {
  return Object.entries(selector).every(([key, expected]) => scalarEquals(row[key], expected));
}

function normalizeSourceRef(value: string): string {
  const text = String(value || '').trim();
  const chinese = text.match(/^(?:数据)?(表|摘要|指标|图|图表|文本|时间线)\s*([0-9]+)$/);
  if (chinese) {
    const prefixMap: Record<string, string> = {
      表: 'table',
      摘要: 'summary',
      指标: 'metric',
      图: 'chart',
      图表: 'chart',
      文本: 'text',
      时间线: 'timeline',
    };
    return `${prefixMap[chinese[1]]}:${Number(chinese[2])}`;
  }
  const english = text.match(/^(?:data\s*)?(table|summary|metric|chart|figure|text|timeline)\s*([0-9]+)$/i);
  if (english) {
    const kind = english[1].toLowerCase() === 'figure' ? 'chart' : english[1].toLowerCase();
    return `${kind}:${Number(english[2])}`;
  }
  return text.toLowerCase();
}

function sourceRefAliases(envelope: DataEnvelope, ordinal: number): Array<string | undefined> {
  const format = envelope.display?.format;
  const kind = format === 'summary'
    ? 'summary'
    : format === 'metric'
      ? 'metric'
      : format === 'chart'
        ? 'chart'
        : format === 'text'
          ? 'text'
          : format === 'timeline'
            ? 'timeline'
            : 'table';
  const zhPrefix: Record<string, string[]> = {
    table: ['表', '数据表'],
    summary: ['摘要'],
    metric: ['指标'],
    chart: ['图', '图表'],
    text: ['文本'],
    timeline: ['时间线'],
  };
  const enPrefix: Record<string, string[]> = {
    table: ['Table', 'Data Table'],
    summary: ['Summary'],
    metric: ['Metric'],
    chart: ['Chart', 'Figure'],
    text: ['Text'],
    timeline: ['Timeline'],
  };
  return [
    ...(zhPrefix[kind] || []).map(prefix => `${prefix} ${ordinal}`),
    ...(enPrefix[kind] || []).map(prefix => `${prefix} ${ordinal}`),
    envelope.display?.title,
    envelope.meta?.source,
    envelope.meta?.skillId,
    envelope.meta?.stepId,
  ];
}

function evidenceRefIdAliases(value: string | undefined): string[] {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const aliases = new Set<string>([raw]);
  const artifactMatch = raw.match(/^data:(art-\d+)$/i);
  if (artifactMatch) aliases.add(artifactMatch[1]);
  const evidenceArtifactMatch = raw.match(/^ev_(art-\d+)$/i);
  if (evidenceArtifactMatch) aliases.add(evidenceArtifactMatch[1]);
  return Array.from(aliases);
}

function refEvidenceIdMatchesEnvelope(env: DataEnvelope, ref: ConclusionContractClaimReference): boolean {
  if (!ref.evidenceRefId) return false;
  const meta = env.meta || {};
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  const aliases = evidenceRefIdAliases(ref.evidenceRefId);
  return aliases.includes(String(meta.evidenceRefId || ''))
    || aliases.includes(String(metaArtifactId || ''))
    || aliases.includes(String(metaSourceArtifactId || ''));
}

function refMatchesSourceRef(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  if (!ref.sourceRef) return false;
  const target = normalizeSourceRef(ref.sourceRef);
  return sourceRefAliases(env, ordinal)
    .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
    .some(alias => normalizeSourceRef(alias) === target);
}

function refMatchesAnyEnvelopeIdentifier(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  const meta = env.meta || {};
  if (refEvidenceIdMatchesEnvelope(env, ref)) return true;
  if (ref.sourceToolCallId && meta.sourceToolCallId === ref.sourceToolCallId) return true;
  if (refMatchesSourceRef(env, ref, ordinal)) return true;
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  if (ref.artifactId && (metaArtifactId === ref.artifactId || metaSourceArtifactId === ref.artifactId)) return true;
  if (ref.sourceArtifactId && (metaSourceArtifactId === ref.sourceArtifactId || metaArtifactId === ref.sourceArtifactId)) return true;
  return false;
}

function refMatchesAllProvidedEnvelopeIdentifiers(env: DataEnvelope, ref: ConclusionContractClaimReference, ordinal: number): boolean {
  const meta = env.meta || {};
  if (ref.evidenceRefId && !refEvidenceIdMatchesEnvelope(env, ref)) return false;
  if (ref.sourceToolCallId && meta.sourceToolCallId !== ref.sourceToolCallId) return false;
  if (ref.sourceRef && !refMatchesSourceRef(env, ref, ordinal)) return false;
  const metaArtifactId = (meta as any).artifactId;
  const metaSourceArtifactId = (meta as any).sourceArtifactId;
  if (ref.artifactId && metaArtifactId !== ref.artifactId && metaSourceArtifactId !== ref.artifactId) return false;
  if (ref.sourceArtifactId && metaSourceArtifactId !== ref.sourceArtifactId && metaArtifactId !== ref.sourceArtifactId) return false;
  return true;
}

function resolveRowAndCell(envelope: DataEnvelope, ref: ConclusionContractClaimReference): Omit<EnvelopeMatch, 'envelope'> {
  const rows = rowsAsObjects(envelope);
  let row: Record<string, unknown> | undefined;
  let rowIndex: number | undefined;
  let missingReason: string | undefined;
  if (typeof ref.rowIndex === 'number') {
    if (!Number.isInteger(ref.rowIndex) || ref.rowIndex < 0) {
      missingReason = `rowIndex ${ref.rowIndex} is invalid`;
    } else {
      rowIndex = ref.rowIndex;
      row = rows[ref.rowIndex];
      if (!row) missingReason = `rowIndex ${ref.rowIndex} is outside evidence row range`;
    }
  } else if (ref.rowSelector) {
    rowIndex = rows.findIndex(candidate => rowMatchesSelector(candidate, ref.rowSelector!));
    row = rowIndex >= 0 ? rows[rowIndex] : undefined;
    if (!row) missingReason = 'rowSelector did not match any evidence row';
  } else if (rows.length === 1) {
    rowIndex = 0;
    row = rows[0];
  } else if (ref.column) {
    missingReason = rows.length === 0
      ? 'referenced evidence has no rows'
      : 'rowIndex or rowSelector is required when citing a column from multi-row evidence';
  }

  if (row && ref.column && !(ref.column in row)) {
    missingReason = `column "${ref.column}" was not found in the referenced evidence row`;
  }

  return {
    ...(row ? { row } : {}),
    ...(rowIndex !== undefined ? { rowIndex } : {}),
    ...(missingReason ? { missingReason } : {}),
  };
}

function findEnvelopeForRef(envelopes: DataEnvelope[], ref: ConclusionContractClaimReference): EnvelopeMatch | undefined {
  const indexed = envelopes.map((envelope, index) => ({ envelope, ordinal: index + 1 }));
  const candidates = indexed.filter(candidate => refMatchesAnyEnvelopeIdentifier(candidate.envelope, ref, candidate.ordinal));
  const matches = candidates.filter(candidate => refMatchesAllProvidedEnvelopeIdentifiers(candidate.envelope, ref, candidate.ordinal));
  if (matches.length === 0 && candidates.length > 0) {
    return {
      envelope: candidates[0].envelope,
      missingReason: 'referenced evidence identifiers did not resolve to the same DataEnvelope',
    };
  }
  if (matches.length === 0) return undefined;

  const resolved = matches.map(match => ({
    envelope: match.envelope,
    ...resolveRowAndCell(match.envelope, ref),
  }));
  const valid = resolved.filter(match => !match.missingReason);
  if (valid.length === 1) return valid[0];
  if (valid.length > 1) {
    return {
      envelope: valid[0].envelope,
      missingReason: 'claim reference is ambiguous across multiple DataEnvelope outputs; use evidenceRefId or artifactId',
    };
  }
  return resolved[0];
}

function inferProducerKind(envelope: DataEnvelope, ref: ConclusionContractClaimReference): EvidenceProducerKind {
  const source = String(envelope.meta?.source || '');
  const tool = ref.sourceToolCallId || envelope.meta?.sourceToolCallId || '';
  if (tool.startsWith('execute_sql_on')) return 'execute_sql_on';
  if (tool.startsWith('execute_sql')) return 'execute_sql';
  if (tool.startsWith('invoke_skill')) return 'invoke_skill';
  if (tool.startsWith('compare_skill')) return 'compare_skill';
  if (ref.artifactId || ref.sourceArtifactId || (envelope.meta as any)?.artifactId) return 'fetch_artifact';
  if (source.includes('snapshot')) return 'analysis_snapshot';
  if (envelope.meta?.skillId) return 'invoke_skill';
  return 'manual';
}

function normalizeTraceSide(value: DataEnvelopeTraceSide | undefined): 'current' | 'reference' | 'unknown' {
  return value === 'current' || value === 'reference' ? value : 'unknown';
}

function normalizePaneSide(value: unknown): EvidencePaneSide | undefined {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toTimestamp(value: unknown): TraceTimestampNs | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim();
  return s ? s : undefined;
}

function deriveTimeRange(row: Record<string, unknown> | undefined): EvidenceTimeRangeV1 | undefined {
  if (!row) return undefined;
  const start = toTimestamp(row.ts ?? row.start_ts ?? row.startTs);
  const end = toTimestamp(row.end_ts ?? row.endTs);
  const dur = toTimestamp(row.dur ?? row.duration_ns ?? row.durationNs);
  if (start !== undefined && end !== undefined) {
    return { startTs: start, endTs: end, unit: 'ns', source: 'row' };
  }
  if (start !== undefined && dur !== undefined) {
    const startNum = toNumber(start);
    const durNum = toNumber(dur);
    const computedEnd = startNum !== undefined && durNum !== undefined
      ? startNum + durNum
      : `${start}+${dur}`;
    return { startTs: start, endTs: computedEnd, unit: 'ns', source: 'row' };
  }
  return undefined;
}

function deriveIdentity(envelope: DataEnvelope, row: Record<string, unknown> | undefined): EvidenceIdentityV1 | undefined {
  const meta = envelope.meta as Record<string, any>;
  const source = row || {};
  const status = ['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error'].includes(meta.identityStatus)
    ? meta.identityStatus as EvidenceIdentityV1['status']
    : undefined;
  const identity: EvidenceIdentityV1 = {
    packageName: typeof source.package_name === 'string' ? source.package_name : undefined,
    processName: typeof source.process_name === 'string' ? source.process_name : undefined,
    threadName: typeof source.thread_name === 'string' ? source.thread_name : undefined,
    upid: toNumber(source.upid),
    utid: toNumber(source.utid),
    pid: toNumber(source.pid),
    tid: toNumber(source.tid),
    identityRefId: typeof meta.identityRefId === 'string' ? meta.identityRefId : undefined,
    status: status || (typeof meta.processIdentityWarning === 'string' ? 'weak' : undefined),
    warnings: [
      ...(Array.isArray(meta.identityWarnings) ? meta.identityWarnings.map(String) : []),
      ...(typeof meta.processIdentityWarning === 'string' ? [meta.processIdentityWarning] : []),
    ],
  };
  if (identity.warnings?.length === 0) delete identity.warnings;
  return Object.values(identity).some(value => value !== undefined) ? identity : undefined;
}

function buildCell(ref: ConclusionContractClaimReference, row: Record<string, unknown> | undefined): EvidenceCellV1 | undefined {
  if (!ref.column) return undefined;
  const rawValue = row ? row[ref.column] : undefined;
  const hasActualValue = rawValue !== undefined;
  return {
    ...(ref.sourceRef ? { sourceRef: ref.sourceRef } : {}),
    ...(typeof ref.rowIndex === 'number' ? { rowIndex: ref.rowIndex } : {}),
    ...(ref.rowSelector ? { rowSelector: ref.rowSelector } : {}),
    column: ref.column,
    ...(rawValue === null ? { isSqlNull: true } : {}),
    ...(ref.value !== undefined && ['string', 'number', 'boolean'].includes(typeof ref.value)
      ? { value: ref.value as string | number | boolean }
      : {}),
    ...(hasActualValue && rawValue !== null && ['string', 'number', 'boolean'].includes(typeof rawValue)
      ? { actualValue: rawValue as string | number | boolean }
      : {}),
    ...(hasActualValue ? { displayValue: String(rawValue) } : {}),
  };
}

function buildAnchor(
  claimId: string,
  ref: ConclusionContractClaimReference,
  match: EnvelopeMatch | undefined,
): EvidenceAnchorV1 {
  const evidenceRefId = ref.evidenceRefId || ref.artifactId || ref.sourceArtifactId || ref.sourceToolCallId || ref.sourceRef || `missing:${claimId}`;
  const anchorId = `anchor:${stableHash({
    claimId,
    evidenceRefId,
    rowIndex: ref.rowIndex ?? match?.rowIndex,
    rowSelector: ref.rowSelector,
    column: ref.column,
  })}`;

  if (!match) {
    return {
      anchorId,
      version: 'evidence_contract@1',
      evidenceRefId,
      context: {
        traceId: 'unknown',
        traceSide: 'unknown',
        producerKind: ref.artifactId || ref.sourceArtifactId ? 'fetch_artifact' : 'manual',
        ...(ref.sourceToolCallId ? { sourceToolCallId: ref.sourceToolCallId } : {}),
        ...(ref.artifactId ? { artifactId: ref.artifactId } : {}),
        ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId, artifactId: ref.artifactId || ref.sourceArtifactId } : {}),
      },
      missing: true,
      missingReason: 'referenced evidence was not found in captured DataEnvelope outputs',
      ...(ref.column ? { cells: [buildCell(ref, undefined)!] } : {}),
      confidence: 0,
    };
  }

  const { envelope, row } = match;
  const meta = envelope.meta || {};
  const artifactId = ref.artifactId || ref.sourceArtifactId || (meta as any).artifactId || (meta as any).sourceArtifactId;
  const cell = buildCell(ref, row);
  if (match.missingReason) {
    return {
      anchorId,
      version: 'evidence_contract@1',
      evidenceRefId,
      context: {
        traceId: meta.traceId || 'unknown',
        traceSide: normalizeTraceSide(meta.traceSide),
        paneSide: normalizePaneSide(meta.paneSide),
        sourceToolCallId: meta.sourceToolCallId,
        toolCallId: meta.sourceToolCallId,
        producerKind: inferProducerKind(envelope, ref),
        skillId: meta.skillId,
        stepId: meta.stepId,
        queryHash: meta.queryHash,
        queryReviewId: meta.queryReview?.id,
        paramsHash: meta.paramsHash,
        planPhaseId: meta.planPhaseId,
        ...(artifactId ? { artifactId: String(artifactId) } : {}),
        ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId } : {}),
      },
      missing: true,
      missingReason: match.missingReason,
      ...(cell ? { cells: [cell] } : {}),
      confidence: 0,
    };
  }
  return {
    anchorId,
    version: 'evidence_contract@1',
    evidenceRefId: meta.evidenceRefId || evidenceRefId,
    context: {
      traceId: meta.traceId || 'unknown',
      traceSide: normalizeTraceSide(meta.traceSide),
      paneSide: normalizePaneSide(meta.paneSide),
      sourceToolCallId: meta.sourceToolCallId,
      toolCallId: meta.sourceToolCallId,
      producerKind: inferProducerKind(envelope, ref),
      skillId: meta.skillId,
      stepId: meta.stepId,
      queryHash: meta.queryHash,
      queryReviewId: meta.queryReview?.id,
      paramsHash: meta.paramsHash,
      planPhaseId: meta.planPhaseId,
      ...(artifactId ? { artifactId: String(artifactId) } : {}),
      ...(ref.sourceArtifactId ? { sourceArtifactId: ref.sourceArtifactId } : {}),
    },
    ...(cell ? { cells: [cell] } : {}),
    ...(deriveTimeRange(row) ? { timeRange: deriveTimeRange(row) } : {}),
    ...(deriveIdentity(envelope, row) ? { identity: deriveIdentity(envelope, row) } : {}),
    confidence: 1,
  };
}

function finiteTimestamp(value: TraceTimestampNs): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const normalized = value.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canonicalBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return undefined;
  try {
    return BigInt(value.trim());
  } catch {
    return undefined;
  }
}

function canonicalBigIntRange(match: EnvelopeMatch | undefined): {start: bigint; end: bigint} | undefined {
  const row = match?.row;
  if (!row) return undefined;
  const start = canonicalBigInt(row.ts ?? row.start_ts ?? row.startTs);
  if (start === undefined) return undefined;
  const end = canonicalBigInt(row.end_ts ?? row.endTs);
  if (end !== undefined) return {start, end};
  const duration = canonicalBigInt(row.dur ?? row.duration_ns ?? row.durationNs);
  return duration === undefined ? undefined : {start, end: start + duration};
}

function relationContextStatus(
  anchors: EvidenceAnchorV1[],
): {status: EvidenceRelationVerificationStatusV1; reasonCode?: EvidenceRelationReasonCodeV1} {
  const traceIds = anchors.map(anchor => anchor.context.traceId);
  const traceSides = anchors.map(anchor => anchor.context.traceSide || 'unknown');
  const knownTraceIds = traceIds.filter(traceId => Boolean(traceId) && traceId !== 'unknown');
  const knownTraceSides = traceSides.filter(traceSide => traceSide !== 'unknown');
  if (new Set(knownTraceIds).size > 1 || new Set(knownTraceSides).size > 1) {
    return {status: 'rejected', reasonCode: 'trace_context_mismatch'};
  }
  if (traceIds.some(traceId => !traceId || traceId === 'unknown') || traceSides.includes('unknown')) {
    return {status: 'candidate', reasonCode: 'trace_context_missing'};
  }
  return {status: 'verified'};
}

function evaluateOverlap(
  subject: EvidenceAnchorV1,
  object: EvidenceAnchorV1 | undefined,
  subjectMatch: EnvelopeMatch | undefined,
  objectMatch: EnvelopeMatch | undefined,
): RelationEvaluation {
  if (subject.missing || !object || object.missing) {
    return {status: 'candidate', reasonCode: 'relation_anchor_missing'};
  }
  const context = relationContextStatus([subject, object]);
  if (context.status !== 'verified') {
    return {status: context.status, reasonCode: context.reasonCode!};
  }
  const subjectCanonical = canonicalBigIntRange(subjectMatch);
  const objectCanonical = canonicalBigIntRange(objectMatch);
  if (subjectCanonical && objectCanonical) {
    if (subjectCanonical.end < subjectCanonical.start || objectCanonical.end < objectCanonical.start) {
      return {status: 'rejected', reasonCode: 'overlap_range_invalid'};
    }
    const overlaps = (subjectCanonical.start > objectCanonical.start
      ? subjectCanonical.start
      : objectCanonical.start) < (subjectCanonical.end < objectCanonical.end
      ? subjectCanonical.end
      : objectCanonical.end);
    return overlaps
      ? {status: 'verified', reasonCode: 'overlap_verified'}
      : {status: 'rejected', reasonCode: 'overlap_disjoint'};
  }
  const subjectStart = subject.timeRange && finiteTimestamp(subject.timeRange.startTs);
  const subjectEnd = subject.timeRange && finiteTimestamp(subject.timeRange.endTs);
  const objectStart = object.timeRange && finiteTimestamp(object.timeRange.startTs);
  const objectEnd = object.timeRange && finiteTimestamp(object.timeRange.endTs);
  if ([subjectStart, subjectEnd, objectStart, objectEnd].some(value => value === undefined)) {
    return {status: 'candidate', reasonCode: 'overlap_range_missing'};
  }
  if (subjectEnd! < subjectStart! || objectEnd! < objectStart!) {
    return {status: 'rejected', reasonCode: 'overlap_range_invalid'};
  }
  if (Math.max(subjectStart!, objectStart!) < Math.min(subjectEnd!, objectEnd!)) {
    return {status: 'verified', reasonCode: 'overlap_verified'};
  }
  return {status: 'rejected', reasonCode: 'overlap_disjoint'};
}

function evaluateBinaryRelation(
  candidate: EvidenceRelationCandidateV1,
  subject: EvidenceAnchorV1,
  object: EvidenceAnchorV1 | undefined,
  proof: EvidenceAnchorV1 | undefined,
  subjectMatch: EnvelopeMatch | undefined,
  objectMatch: EnvelopeMatch | undefined,
  proofMatch: EnvelopeMatch | undefined,
): RelationEvaluation {
  if (subject.missing || !object || object.missing) {
    return {status: 'candidate', reasonCode: 'relation_anchor_missing'};
  }
  if (!proof || proof.missing) {
    return {status: 'candidate', reasonCode: 'proof_anchor_missing'};
  }
  const context = relationContextStatus([subject, object, proof]);
  if (context.status !== 'verified') {
    return {status: context.status, reasonCode: context.reasonCode!};
  }
  const bindings = candidate.proofBindings!;
  const subjectValue = subjectMatch?.row?.[bindings.subject.endpointColumn];
  const subjectProofValue = proofMatch?.row?.[bindings.subject.proofColumn];
  const objectValue = objectMatch?.row?.[bindings.object.endpointColumn];
  const objectProofValue = proofMatch?.row?.[bindings.object.proofColumn];
  const bindingValues = [subjectValue, subjectProofValue, objectValue, objectProofValue];
  const bindingsArePrimitive = bindingValues.every(isPrimitive);
  if (bindingsArePrimitive &&
    (!scalarEquals(subjectValue, subjectProofValue) || !scalarEquals(objectValue, objectProofValue))) {
    return {status: 'rejected', reasonCode: 'proof_binding_mismatch'};
  }
  const identities = [subject, object, proof].map(anchor => anchor.identity);
  if (identities.some(identity => identity?.status === 'error')) {
    return {status: 'rejected', reasonCode: 'identity_conflict'};
  }
  if (!bindingsArePrimitive) return {status: 'candidate', reasonCode: 'proof_binding_missing'};
  if (identities.some(identity => !identity || identity.status !== 'verified' || !identity.identityRefId)) {
    return {status: 'candidate', reasonCode: 'identity_evidence_missing'};
  }
  return {status: 'verified', reasonCode: 'binary_proof_verified'};
}

function actualCellValue(anchor: EvidenceAnchorV1): unknown {
  const cell = anchor.cells?.[0];
  return cell?.actualValue !== undefined ? cell.actualValue : cell?.displayValue;
}

function evaluateComparisonDelta(
  candidate: EvidenceRelationCandidateV1,
  subject: EvidenceAnchorV1,
  object: EvidenceAnchorV1 | undefined,
): RelationEvaluation {
  if (subject.missing || !object || object.missing) {
    return {status: 'candidate', reasonCode: 'relation_anchor_missing'};
  }
  if (subject.context.traceSide !== 'current' || object.context.traceSide !== 'reference') {
    return {status: 'rejected', reasonCode: 'comparison_side_mismatch'};
  }
  if (!subject.context.traceId || subject.context.traceId === 'unknown' ||
    !object.context.traceId || object.context.traceId === 'unknown') {
    return {status: 'candidate', reasonCode: 'trace_context_missing'};
  }
  const subjectRaw = actualCellValue(subject);
  const objectRaw = actualCellValue(object);
  if (subjectRaw === undefined || objectRaw === undefined) {
    return {status: 'candidate', reasonCode: 'comparison_metric_missing'};
  }
  const subjectValue = toNumber(subjectRaw);
  const objectValue = toNumber(objectRaw);
  if (subjectValue === undefined || objectValue === undefined) {
    return {status: 'rejected', reasonCode: 'comparison_metric_invalid'};
  }
  const delta = subjectValue - objectValue;
  if (!valuesMatch(candidate.value, delta)) {
    return {status: 'rejected', reasonCode: 'comparison_delta_mismatch'};
  }
  return {status: 'verified', reasonCode: 'comparison_delta_verified'};
}

function withMetricColumn(
  endpoint: EvidenceRelationEndpointV1,
  metricColumn: string | undefined,
): EvidenceRelationEndpointV1 {
  return metricColumn && !endpoint.column ? {...endpoint, column: metricColumn} : endpoint;
}

function withBindingColumn(
  endpoint: EvidenceRelationEndpointV1,
  column: string | undefined,
): EvidenceRelationEndpointV1 {
  return column ? {...endpoint, column} : endpoint;
}

function withoutCellSelection(endpoint: EvidenceRelationEndpointV1): EvidenceRelationEndpointV1 {
  const {column: _column, value: _value, ...rowEndpoint} = endpoint;
  return rowEndpoint;
}

function buildBinaryProofCells(
  candidate: EvidenceRelationCandidateV1,
  subjectMatch: EnvelopeMatch | undefined,
  objectMatch: EnvelopeMatch | undefined,
  proofMatch: EnvelopeMatch | undefined,
): EvidenceCellV1[] {
  if (!candidate.proof || !candidate.proofBindings) return [];
  const specs = [
    {
      binding: candidate.proofBindings.subject,
      expected: subjectMatch?.row?.[candidate.proofBindings.subject.endpointColumn],
    },
    {
      binding: candidate.proofBindings.object,
      expected: objectMatch?.row?.[candidate.proofBindings.object.endpointColumn],
    },
  ];
  return specs.map(({binding, expected}) => buildCell({
    ...withoutCellSelection(candidate.proof!),
    column: binding.proofColumn,
    ...(isPrimitive(expected) ? {value: expected} : {}),
  }, proofMatch?.row)!).filter(Boolean);
}

function cloneProofBindings(candidate: EvidenceRelationCandidateV1): EvidenceRelationCandidateV1['proofBindings'] {
  if (!candidate.proofBindings) return undefined;
  return {
    subject: {
      endpointColumn: candidate.proofBindings.subject.endpointColumn,
      proofColumn: candidate.proofBindings.subject.proofColumn,
    },
    object: {
      endpointColumn: candidate.proofBindings.object.endpointColumn,
      proofColumn: candidate.proofBindings.object.proofColumn,
    },
  };
}

function buildRelations(
  candidatesInput: EvidenceRelationCandidateV1[] | undefined,
  envelopes: DataEnvelope[],
): BuiltRelations {
  if (candidatesInput === undefined) return {relations: [], anchors: [], warnings: []};
  if (!Array.isArray(candidatesInput)) {
    return {relations: [], anchors: [], warnings: ['relation_candidates_skipped:invalid_container']};
  }
  const invalidWarnings: string[] = [];
  const validCandidates: EvidenceRelationCandidateV1[] = [];
  for (const [index, value] of candidatesInput.entries()) {
    const error = relationCandidateError(value);
    if (error) {
      if (invalidWarnings.length < RELATION_WARNING_LIMIT) {
        invalidWarnings.push(`relation_candidate_skipped:${index}:${error}`);
      }
      continue;
    }
    validCandidates.push(value);
  }

  const duplicateWarnings: string[] = [];
  const candidates: EvidenceRelationCandidateV1[] = [];
  const candidatesById = new Map<string, EvidenceRelationCandidateV1[]>();
  for (const candidate of validCandidates) {
    const grouped = candidatesById.get(candidate.id) || [];
    grouped.push(candidate);
    candidatesById.set(candidate.id, grouped);
  }
  for (const [id, grouped] of candidatesById) {
    const shapes = new Set(grouped.map(canonicalJson));
    if (shapes.size > 1) {
      duplicateWarnings.push(`relation_candidate_skipped:${sanitizeIdPart(id)}:duplicate_conflict`);
      continue;
    }
    candidates.push(grouped[0]);
    if (grouped.length > 1) {
      duplicateWarnings.push(`relation_candidate_skipped:${sanitizeIdPart(id)}:duplicate_ignored`);
    }
  }
  const warnings = [...duplicateWarnings, ...invalidWarnings].slice(0, RELATION_WARNING_LIMIT);

  const relations: EvidenceRelationV1[] = [];
  const anchorsById = new Map<string, EvidenceAnchorV1>();
  for (const candidate of candidates) {
    const isBinary = BINARY_RELATION_KINDS.has(candidate.kind);
    const subjectRef = withBindingColumn(
      withMetricColumn(candidate.subject, candidate.kind === 'comparison_delta' ? candidate.metricColumn : undefined),
      isBinary ? candidate.proofBindings!.subject.endpointColumn : undefined,
    );
    const objectRef = candidate.object
      ? withBindingColumn(
        withMetricColumn(candidate.object, candidate.kind === 'comparison_delta' ? candidate.metricColumn : undefined),
        isBinary ? candidate.proofBindings!.object.endpointColumn : undefined,
      )
      : undefined;
    const proofRef = candidate.proof && isBinary
      ? withoutCellSelection(candidate.proof)
      : candidate.proof;
    const subjectMatch = findEnvelopeForRef(envelopes, subjectRef);
    const objectMatch = objectRef ? findEnvelopeForRef(envelopes, objectRef) : undefined;
    const proofMatch = proofRef ? findEnvelopeForRef(envelopes, proofRef) : undefined;
    const subject = buildAnchor(`relation:${candidate.id}:subject`, subjectRef, subjectMatch);
    const object = objectRef
      ? buildAnchor(`relation:${candidate.id}:object`, objectRef, objectMatch)
      : undefined;
    const proofBase = proofRef
      ? buildAnchor(`relation:${candidate.id}:proof`, proofRef, proofMatch)
      : undefined;
    const proof = proofBase && isBinary
      ? {...proofBase, cells: buildBinaryProofCells(candidate, subjectMatch, objectMatch, proofMatch)}
      : proofBase;
    for (const anchor of [subject, object, proof]) {
      if (anchor) anchorsById.set(anchor.anchorId, anchor);
    }
    const hasEndpointValueMismatch = [subject, object, ...(isBinary ? [] : [proof])].some(anchor =>
      (anchor?.cells || []).some(cell => evidenceCellCheckStatus(cell) === 'mismatch'));
    const evaluation: RelationEvaluation = hasEndpointValueMismatch
      ? {status: 'rejected', reasonCode: 'relation_endpoint_value_mismatch'}
      : candidate.kind === 'overlap'
        ? evaluateOverlap(subject, object, subjectMatch, objectMatch)
        : BINARY_RELATION_KINDS.has(candidate.kind)
          ? evaluateBinaryRelation(candidate, subject, object, proof, subjectMatch, objectMatch, proofMatch)
          : candidate.kind === 'comparison_delta'
            ? evaluateComparisonDelta(candidate, subject, object)
            : {status: 'candidate', reasonCode: 'derived_not_verified'};
    const directEvidenceAnchorIds = Array.from(new Set(
      [subject.anchorId, object?.anchorId, proof?.anchorId].filter((value): value is string => Boolean(value)),
    ));
    relations.push({
      schemaVersion: 'evidence_relation@1',
      id: candidate.id,
      kind: candidate.kind,
      direction: candidate.direction,
      verificationStatus: evaluation.status,
      reasonCode: evaluation.reasonCode,
      subjectAnchorId: subject.anchorId,
      ...(object ? {objectAnchorId: object.anchorId} : {}),
      ...(proof ? {proofAnchorId: proof.anchorId, relationAnchorId: proof.anchorId} : {}),
      directEvidenceAnchorIds,
      ...(candidate.proofBindings ? {proofBindings: cloneProofBindings(candidate)!} : {}),
      ...(candidate.metricColumn ? {metricColumn: candidate.metricColumn} : {}),
      ...(candidate.value !== undefined ? {value: candidate.value} : {}),
      ...(candidate.unit ? {unit: candidate.unit} : {}),
      ...(candidate.deltaDirection ? {deltaDirection: candidate.deltaDirection} : {}),
      supportLevel: evaluation.status === 'verified'
        ? 'verified'
        : evaluation.status === 'rejected'
          ? 'unsupported'
          : 'inference',
      reason: evaluation.reasonCode,
    });
  }
  return {relations, anchors: Array.from(anchorsById.values()), warnings};
}

function supportLevelForClaim(
  claim: ConclusionContractClaimItem,
  kind: ClaimKindV1,
  anchors: EvidenceAnchorV1[],
): EvidenceSupportLevel {
  if (anchors.length === 0 || anchors.every(anchor => anchor.missing)) return 'unsupported';
  if (kind === 'inference') return 'inference';
  if (kind === 'recommendation') return 'partial';
  if (anchors.some(anchor => anchor.missing)) return 'partial';
  if (kind === 'causal') return 'inference';
  const cellStatuses = anchors.flatMap(anchor => (anchor.cells || []).map(evidenceCellCheckStatus));
  if (cellStatuses.some(status => status === 'mismatch')) return 'unsupported';
  if (anchors.some(anchor => !anchor.context.traceId || anchor.context.traceId === 'unknown')) return 'partial';
  if (kind === 'identity' && anchors.some(anchor =>
    anchor.identity?.status !== 'verified' || !anchor.identity?.identityRefId
  )) {
    return 'partial';
  }
  if (cellStatuses.length === 0 || cellStatuses.some(status => status === 'not_checked')) return 'partial';
  return 'verified';
}

function artifactRefsToClaimReferences(claim: ConclusionContractClaimItem): ConclusionContractClaimReference[] {
  return (claim.artifactRefs || []).map(ref => ({
    artifactId: ref.artifactId,
    ...(typeof ref.rowIndex === 'number' ? { rowIndex: ref.rowIndex } : {}),
    ...(ref.rowSelector ? { rowSelector: parseRowSelector(ref.rowSelector) } : {}),
  }));
}

function parseRowSelector(value: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const selector: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof raw)) {
      selector[key] = raw as string | number | boolean;
    }
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function buildClaimSupport(
  claim: ConclusionContractClaimItem,
  index: number,
  envelopes: DataEnvelope[],
): ClaimSupportV1 {
  const claimId = claim.id || `claim-${index + 1}`;
  const references = [
    ...(claim.references || []),
    ...artifactRefsToClaimReferences(claim),
  ];
  const anchors = references.map(ref => buildAnchor(claimId, ref, findEnvelopeForRef(envelopes, ref)));
  const kind = inferClaimKind(claim, references);
  const supportLevel = supportLevelForClaim(claim, kind, anchors);
  return {
    claimId,
    kind,
    text: claim.text,
    anchors,
    supportLevel,
    ...(supportLevel === 'inference' && claim.kind === 'causal'
      ? { inferenceReason: 'causal claim is treated as inference until EvidenceRelationV1 relation support is emitted' }
      : {}),
  };
}

function attachClaimRelations(
  claim: ConclusionContractClaimItem,
  support: ClaimSupportV1,
  candidatesConfigured: boolean,
  relationsById: Map<string, EvidenceRelationV1>,
  relationAnchorsById: Map<string, EvidenceAnchorV1>,
): ClaimSupportV1 {
  if (support.kind !== 'causal') return support;
  if (!candidatesConfigured) return {...support, relationEvaluation: 'not_configured'};
  const refs = Array.isArray(claim.relationRefs) ? claim.relationRefs : [];
  const relations = refs
    .map(id => relationsById.get(id))
    .filter((value): value is EvidenceRelationV1 => Boolean(value));
  const hasMissing = refs.length === 0 || relations.length !== refs.length;
  const relationEvaluation = relations.some(relation => relation.verificationStatus === 'rejected')
    ? 'rejected'
    : hasMissing
      ? 'missing'
      : relations.some(relation =>
        relation.verificationStatus !== 'verified' || !BINARY_RELATION_KINDS.has(relation.kind))
        ? 'candidate'
        : relations.length > 0
          ? 'verified'
          : 'missing';
  const relationAnchors = Array.from(new Set(relations.flatMap(relation => relation.directEvidenceAnchorIds)))
    .map(anchorId => relationAnchorsById.get(anchorId))
    .filter((anchor): anchor is EvidenceAnchorV1 => Boolean(anchor));
  return {
    ...support,
    relations,
    ...(relationAnchors.length > 0 ? {relationAnchors} : {}),
    relationEvaluation,
    supportLevel: relationEvaluation === 'rejected' ? 'unsupported' : support.supportLevel,
  };
}

export function buildEvidenceContract(input: BuildEvidenceContractInput): EvidenceContractV1 {
  const warnings: string[] = [];
  const envelopes = (input.dataEnvelopes || []).filter((envelope, index) => {
    const valid = validateDataEnvelope(envelope).length === 0;
    if (!valid && warnings.length < RELATION_WARNING_LIMIT) {
      warnings.push(`data_envelope_skipped:${index}:invalid`);
    }
    return valid;
  });
  const claims = input.conclusionContract?.claims || [];
  const builtRelations = buildRelations(input.relationCandidates, envelopes);
  const relationsById = new Map(builtRelations.relations.map(relation => [relation.id, relation]));
  const relationAnchorsById = new Map(builtRelations.anchors.map(anchor => [anchor.anchorId, anchor]));
  const claimSupport = claims.map((claim, index) => attachClaimRelations(
    claim,
    buildClaimSupport(claim, index, envelopes),
    input.relationCandidates !== undefined,
    relationsById,
    relationAnchorsById,
  ));
  const anchors = Array.from(new Map(
    [...claimSupport.flatMap(item => item.anchors), ...builtRelations.anchors]
      .map(anchor => [anchor.anchorId, anchor]),
  ).values());
  const identityRefIds = Array.from(new Set(
    anchors.map(anchor => anchor.identity?.identityRefId).filter((value): value is string => Boolean(value)),
  ));
  return {
    schemaVersion: 'evidence_contract@1',
    anchors,
    relations: builtRelations.relations,
    claimSupport,
    identityRefIds,
    warnings: [...warnings, ...builtRelations.warnings].slice(0, RELATION_WARNING_LIMIT),
  };
}
