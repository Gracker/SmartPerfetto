// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import { localize, parseOutputLanguage, type OutputLanguage } from '../agentv3/outputLanguage';
import {
  buildColumnDefinitions,
  type ColumnDefinition,
  type DataEnvelope,
  type DataPayload,
  type UiActionProposalSource,
  type UiActionProposalV1,
} from '../types/dataContract';
import {
  DEFAULT_MAX_UI_ACTION_PROPOSALS,
  sanitizeUiActionProposals,
} from './uiActionProposalSanitizer';

type TimeUnit = NonNullable<ColumnDefinition['unit']>;

export interface DeriveUiActionProposalsInput {
  dataEnvelopes?: DataEnvelope[];
  currentTraceId?: string;
  existingProposals?: unknown;
  maxProposals?: number;
  outputLanguage?: OutputLanguage;
}

const UNIT_TO_NS: Record<TimeUnit, bigint> = {
  ns: BigInt(1),
  us: BigInt(1_000),
  ms: BigInt(1_000_000),
  s: BigInt(1_000_000_000),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sourceForEnvelope(env: DataEnvelope): UiActionProposalSource {
  const source: UiActionProposalSource = {};
  if (env.meta.evidenceRefId) source.evidenceRefId = env.meta.evidenceRefId;
  const artifactId = env.meta.artifactId || env.meta.sourceArtifactId;
  if (artifactId) source.artifactId = artifactId;
  if (env.meta.skillId) source.skillId = env.meta.skillId;
  if (env.meta.sourceToolCallId) source.sourceToolCallId = env.meta.sourceToolCallId;
  return source;
}

function artifactIdForEnvelope(env: DataEnvelope): string {
  return (
    env.meta.artifactId ||
    env.meta.sourceArtifactId ||
    env.meta.evidenceRefId ||
    env.meta.sourceToolCallId ||
    `${env.meta.source}:${env.meta.stepId || 'table'}`
  );
}

function proposalId(kind: UiActionProposalV1['kind'], source: UiActionProposalSource, payload: unknown): string {
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify({ kind, source, payload }))
    .digest('hex')
    .slice(0, 12);
  return `ui-${kind}-${hash}`;
}

function resolveOutputLanguage(language: OutputLanguage | undefined): OutputLanguage {
  return language ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

function shortTitle(prefix: string, title: string | undefined, fallbackTitle: string): string {
  const text = [prefix, title || fallbackTitle].filter(Boolean).join(' ');
  return text.length <= 80 ? text : text.slice(0, 77).trimEnd() + '...';
}

function tableColumns(env: DataEnvelope): string[] {
  const data = env.data as DataPayload | undefined;
  if (Array.isArray(data?.columns)) {
    return data.columns.map(String).filter(Boolean);
  }
  if (Array.isArray(env.display?.columns)) {
    return env.display.columns.map(column => column.name).filter(Boolean);
  }
  return [];
}

function tableRows(env: DataEnvelope, columns: string[]): unknown[][] {
  const data = env.data as DataPayload | undefined;
  if (!Array.isArray(data?.rows)) return [];
  return data.rows.map(row => {
    if (Array.isArray(row)) return row as unknown[];
    if (isRecord(row)) return columns.map(column => row[column]);
    return [];
  });
}

function columnDefinitions(env: DataEnvelope, columns: string[]): ColumnDefinition[] {
  if (Array.isArray(env.display?.columns) && env.display.columns.length > 0) {
    return env.display.columns;
  }
  return buildColumnDefinitions(columns);
}

function normalizeUnit(unit: unknown): TimeUnit {
  return unit === 'us' || unit === 'ms' || unit === 's' ? unit : 'ns';
}

function parseTimeValueToNs(value: unknown, unit: TimeUnit): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  const multiplier = UNIT_TO_NS[unit];
  if (typeof value === 'bigint') return value * multiplier;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return BigInt(Math.round(value * Number(multiplier)));
  }
  const text = readString(value)?.replace(/[,\s]/g, '');
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return BigInt(text) * multiplier;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? BigInt(Math.round(parsed * Number(multiplier))) : undefined;
  }
  return undefined;
}

function navigationTraceId(env: DataEnvelope, currentTraceId: string | undefined): string | undefined {
  return env.meta.traceId || currentTraceId;
}

function canNavigateCurrentTrace(env: DataEnvelope, currentTraceId: string | undefined): boolean {
  if (env.meta.traceSide === 'reference') return false;
  if (currentTraceId && env.meta.traceId && env.meta.traceId !== currentTraceId) return false;
  return true;
}

function rangeProposalForColumn(
  env: DataEnvelope,
  row: unknown[],
  columns: string[],
  definitions: ColumnDefinition[],
  columnIndex: number,
  currentTraceId: string | undefined,
  outputLanguage: OutputLanguage,
): UiActionProposalV1 | undefined {
  const column = definitions[columnIndex];
  if (!column || column.clickAction !== 'navigate_range') return undefined;
  const startNs = parseTimeValueToNs(row[columnIndex], normalizeUnit(column.unit));
  if (startNs === undefined) return undefined;
  const durationColumn = column.durationColumn;
  if (!durationColumn) return undefined;
  const durationIndex = columns.indexOf(durationColumn);
  if (durationIndex < 0) return undefined;
  const durationDefinition = definitions[durationIndex];
  const durationNs = parseTimeValueToNs(
    row[durationIndex],
    normalizeUnit(durationDefinition?.unit),
  );
  if (durationNs === undefined || durationNs <= BigInt(0)) return undefined;
  const endNs = startNs + durationNs;
  const traceId = navigationTraceId(env, currentTraceId);
  const source = sourceForEnvelope(env);
  const payload = traceId
    ? { startNs: startNs.toString(), endNs: endNs.toString(), traceId }
    : { startNs: startNs.toString(), endNs: endNs.toString() };
  return {
    schemaVersion: 1,
    id: proposalId('navigate_range', source, payload),
    kind: 'navigate_range',
    title: shortTitle(
      localize(outputLanguage, '查看区间', 'Inspect range'),
      env.display?.title,
      localize(outputLanguage, '证据', 'Evidence'),
    ),
    reason: localize(
      outputLanguage,
      '该时间范围来自证据表的 timestamp 和 duration 列。',
      'This time range comes from the evidence table timestamp and duration columns.',
    ),
    source,
    payload,
    requiresConfirmation: true,
  };
}

function pointProposalForColumn(
  env: DataEnvelope,
  row: unknown[],
  definitions: ColumnDefinition[],
  columnIndex: number,
  currentTraceId: string | undefined,
  outputLanguage: OutputLanguage,
): UiActionProposalV1 | undefined {
  const column = definitions[columnIndex];
  if (!column || column.type !== 'timestamp') return undefined;
  if (column.clickAction !== 'navigate_timeline' && column.clickAction !== 'navigate_range') return undefined;
  const timestampNs = parseTimeValueToNs(row[columnIndex], normalizeUnit(column.unit));
  if (timestampNs === undefined) return undefined;
  const traceId = navigationTraceId(env, currentTraceId);
  const source = sourceForEnvelope(env);
  const payload = traceId
    ? { ts: timestampNs.toString(), traceId }
    : { ts: timestampNs.toString() };
  return {
    schemaVersion: 1,
    id: proposalId('navigate_timeline', source, payload),
    kind: 'navigate_timeline',
    title: shortTitle(
      localize(outputLanguage, '跳到时间点', 'Go to timestamp'),
      env.display?.title,
      localize(outputLanguage, '证据', 'Evidence'),
    ),
    reason: localize(
      outputLanguage,
      '该时间点来自证据表的 timestamp 列。',
      'This timestamp comes from the evidence table timestamp column.',
    ),
    source,
    payload,
    requiresConfirmation: true,
  };
}

function navigationProposalForEnvelope(
  env: DataEnvelope,
  currentTraceId: string | undefined,
  outputLanguage: OutputLanguage,
): UiActionProposalV1 | undefined {
  if (!canNavigateCurrentTrace(env, currentTraceId)) return undefined;
  const columns = tableColumns(env);
  if (columns.length === 0) return undefined;
  const rows = tableRows(env, columns);
  const firstRow = rows[0];
  if (!firstRow) return undefined;
  const definitions = columnDefinitions(env, columns);

  for (let index = 0; index < definitions.length; index++) {
    const column = definitions[index];
    if (column?.type !== 'timestamp') continue;
    const range = rangeProposalForColumn(env, firstRow, columns, definitions, index, currentTraceId, outputLanguage);
    if (range) return range;
    const point = pointProposalForColumn(env, firstRow, definitions, index, currentTraceId, outputLanguage);
    if (point) return point;
  }
  return undefined;
}

function openTableProposalForEnvelope(env: DataEnvelope, outputLanguage: OutputLanguage): UiActionProposalV1 | undefined {
  const columns = tableColumns(env);
  const rows = tableRows(env, columns);
  if (columns.length === 0 || rows.length === 0) return undefined;
  const source = sourceForEnvelope(env);
  const artifactId = artifactIdForEnvelope(env);
  const payload = env.meta.evidenceRefId
    ? { artifactId, evidenceRefId: env.meta.evidenceRefId }
    : { artifactId };
  return {
    schemaVersion: 1,
    id: proposalId('open_evidence_table', source, payload),
    kind: 'open_evidence_table',
    title: shortTitle(
      localize(outputLanguage, '打开表格', 'Open table'),
      env.display?.title,
      localize(outputLanguage, '证据', 'Evidence'),
    ),
    reason: localize(
      outputLanguage,
      '查看支撑结论的原始证据行。',
      'Inspect the raw evidence rows that support the conclusion.',
    ),
    source,
    payload,
    requiresConfirmation: true,
  };
}

function pinProposalForEnvelope(env: DataEnvelope, outputLanguage: OutputLanguage): UiActionProposalV1 | undefined {
  if (!env.meta.evidenceRefId) return undefined;
  const source = sourceForEnvelope(env);
  const payload = { evidenceRefId: env.meta.evidenceRefId };
  return {
    schemaVersion: 1,
    id: proposalId('pin_evidence', source, payload),
    kind: 'pin_evidence',
    title: shortTitle(
      localize(outputLanguage, '收藏证据', 'Save evidence'),
      env.display?.title,
      localize(outputLanguage, '证据', 'Evidence'),
    ),
    reason: localize(
      outputLanguage,
      '把这份证据或结果快照收藏到当前会话，可通过 /pins 查看；不会固定时间线泳道，也不会自动加入后续 AI 上下文。',
      'Save this evidence or result snapshot in the current conversation and view it with /pins; this does not pin a timeline track or automatically add it to later AI context.',
    ),
    source,
    payload,
    requiresConfirmation: true,
  };
}

export function deriveUiActionProposals(
  input: DeriveUiActionProposalsInput,
): UiActionProposalV1[] {
  const outputLanguage = resolveOutputLanguage(input.outputLanguage);
  const derived: UiActionProposalV1[] = [];
  for (const env of input.dataEnvelopes || []) {
    const navigation = navigationProposalForEnvelope(env, input.currentTraceId, outputLanguage);
    if (navigation) derived.push(navigation);
    const openTable = openTableProposalForEnvelope(env, outputLanguage);
    if (openTable) derived.push(openTable);
    const pin = pinProposalForEnvelope(env, outputLanguage);
    if (pin) derived.push(pin);
  }

  const existing = sanitizeUiActionProposals(input.existingProposals, {
    currentTraceId: input.currentTraceId,
    maxProposals: input.maxProposals,
  });
  return sanitizeUiActionProposals([...derived, ...existing], {
    currentTraceId: input.currentTraceId,
    maxProposals: input.maxProposals ?? DEFAULT_MAX_UI_ACTION_PROPOSALS,
  });
}
