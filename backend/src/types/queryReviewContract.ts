// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const QUERY_REVIEW_SCHEMA_VERSION = 1 as const;
export const SQL_EXECUTION_CONTEXTS = ['working', 'original_trace'] as const;
/** Observed namespace only; neither a capability nor proof eligibility. */
export type SqlExecutionContext = typeof SQL_EXECUTION_CONTEXTS[number];

export type QueryReviewProducerKind = 'execute_sql' | 'execute_sql_on' | 'invoke_skill';
export type QueryReviewConfidence = 'declared' | 'observed' | 'partial';
export type QueryReviewGuardrailSeverity = 'info' | 'warning';
export type QueryReviewAllowedUse = 'review_metadata_only';
export type QueryReviewPaneSide = 'left' | 'right' | 'top' | 'bottom';

export interface QueryReviewProducerV1 {
  kind: QueryReviewProducerKind;
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  traceSide?: 'current' | 'reference';
  paneSide?: QueryReviewPaneSide;
  traceId?: string;
}

export interface QueryReviewSourceV1 {
  skillId?: string;
  stepId?: string;
  artifactId?: string;
  evidenceRefId?: string;
  queryHash?: string;
}

export interface QueryReviewReadV1 {
  table: string;
  columns?: string[];
  confidence: QueryReviewConfidence;
}

export interface QueryReviewFilterV1 {
  expression: string;
  confidence: QueryReviewConfidence;
}

export interface QueryReviewOutputShapeV1 {
  name: string;
  type?: string;
  required?: boolean;
}

export interface QueryReviewGuardrailV1 {
  ruleId: string;
  message: string;
  line?: number;
  severity: QueryReviewGuardrailSeverity;
}

export interface QueryReviewObservedExecutionV1 {
  executed: true;
  /** Absent for historical or unknown execution context. */
  executionContext?: SqlExecutionContext;
  executableSql?: string;
  sqlRewrites?: string[];
  stdlibInjectedModules?: string[];
  durationMs?: number;
  rowCount?: number;
  truncated?: boolean;
}

export interface QueryReviewV1 {
  schemaVersion: typeof QUERY_REVIEW_SCHEMA_VERSION;
  id: string;
  producer: QueryReviewProducerV1;
  title: string;
  purpose: string;
  source: QueryReviewSourceV1;
  reads: QueryReviewReadV1[];
  filters: QueryReviewFilterV1[];
  outputShape: QueryReviewOutputShapeV1[];
  guardrails: QueryReviewGuardrailV1[];
  limitations: string[];
  observedExecution: QueryReviewObservedExecutionV1;
  allowedUse: QueryReviewAllowedUse;
}

export type CompactQueryReviewForToolResponse = Pick<
  QueryReviewV1,
  | 'schemaVersion'
  | 'id'
  | 'producer'
  | 'title'
  | 'purpose'
  | 'source'
  | 'reads'
  | 'filters'
  | 'outputShape'
  | 'guardrails'
  | 'limitations'
  | 'allowedUse'
> & {
  observedExecution: Omit<QueryReviewObservedExecutionV1, 'executableSql'>;
};

const VALID_PRODUCER_KINDS: readonly QueryReviewProducerKind[] = [
  'execute_sql',
  'execute_sql_on',
  'invoke_skill',
];
const VALID_PANE_SIDES: readonly QueryReviewPaneSide[] = ['left', 'right', 'top', 'bottom'];
const VALID_CONFIDENCES: readonly QueryReviewConfidence[] = ['declared', 'observed', 'partial'];
const VALID_SEVERITIES: readonly QueryReviewGuardrailSeverity[] = ['info', 'warning'];

const MAX_SQL_CHARS = 4000;
const MAX_STRING = 240;
const MAX_ID = 160;
const MAX_ARRAY = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = MAX_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function boundedNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function boundedBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringList(value: unknown, maxItems = MAX_ARRAY, maxLength = MAX_STRING): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(item => boundedString(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

function sanitizeProducer(value: unknown): QueryReviewProducerV1 | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (typeof kind !== 'string' || !VALID_PRODUCER_KINDS.includes(kind as QueryReviewProducerKind)) {
    return undefined;
  }
  const traceSide = value.traceSide;
  const paneSide = value.paneSide;
  return {
    kind: kind as QueryReviewProducerKind,
    sourceToolCallId: boundedString(value.sourceToolCallId, MAX_ID),
    paramsHash: boundedString(value.paramsHash, MAX_ID),
    planPhaseId: boundedString(value.planPhaseId, MAX_ID),
    planPhaseTitle: boundedString(value.planPhaseTitle),
    traceSide: traceSide === 'current' || traceSide === 'reference' ? traceSide : undefined,
    paneSide: typeof paneSide === 'string' && VALID_PANE_SIDES.includes(paneSide as QueryReviewPaneSide)
      ? paneSide as QueryReviewPaneSide
      : undefined,
    traceId: boundedString(value.traceId, MAX_ID),
  };
}

function sanitizeSource(value: unknown): QueryReviewSourceV1 {
  if (!isRecord(value)) return {};
  return {
    skillId: boundedString(value.skillId, MAX_ID),
    stepId: boundedString(value.stepId, MAX_ID),
    artifactId: boundedString(value.artifactId, MAX_ID),
    evidenceRefId: boundedString(value.evidenceRefId, MAX_ID),
    queryHash: boundedString(value.queryHash, MAX_ID),
  };
}

function sanitizeConfidence(value: unknown): QueryReviewConfidence | undefined {
  return typeof value === 'string' && VALID_CONFIDENCES.includes(value as QueryReviewConfidence)
    ? value as QueryReviewConfidence
    : undefined;
}

function sanitizeReads(value: unknown): QueryReviewReadV1[] {
  if (!Array.isArray(value)) return [];
  const reads: QueryReviewReadV1[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const table = boundedString(item.table, 160);
    const confidence = sanitizeConfidence(item.confidence);
    if (!table || !confidence || seen.has(table)) continue;
    seen.add(table);
    reads.push({
      table,
      columns: stringList(item.columns, 24, 120),
      confidence,
    });
    if (reads.length >= 16) break;
  }
  return reads;
}

function sanitizeFilters(value: unknown): QueryReviewFilterV1[] {
  if (!Array.isArray(value)) return [];
  const filters: QueryReviewFilterV1[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const expression = boundedString(item.expression, 320);
    const confidence = sanitizeConfidence(item.confidence);
    if (!expression || !confidence) continue;
    filters.push({ expression, confidence });
    if (filters.length >= 12) break;
  }
  return filters;
}

function sanitizeOutputShape(value: unknown): QueryReviewOutputShapeV1[] {
  if (!Array.isArray(value)) return [];
  const output: QueryReviewOutputShapeV1[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = boundedString(item.name, 120);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push({
      name,
      type: boundedString(item.type, 80),
      required: boundedBoolean(item.required),
    });
    if (output.length >= MAX_ARRAY) break;
  }
  return output;
}

function sanitizeGuardrails(value: unknown): QueryReviewGuardrailV1[] {
  if (!Array.isArray(value)) return [];
  const guardrails: QueryReviewGuardrailV1[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const ruleId = boundedString(item.ruleId, 120);
    const message = boundedString(item.message, 400);
    const severity = typeof item.severity === 'string' && VALID_SEVERITIES.includes(item.severity as QueryReviewGuardrailSeverity)
      ? item.severity as QueryReviewGuardrailSeverity
      : undefined;
    if (!ruleId || !message || !severity) continue;
    const line = boundedNumber(item.line);
    guardrails.push({
      ruleId,
      message,
      ...(line !== undefined ? { line } : {}),
      severity,
    });
    if (guardrails.length >= 16) break;
  }
  return guardrails;
}

function sanitizeObservedExecution(value: unknown): QueryReviewObservedExecutionV1 | undefined {
  if (!isRecord(value) || value.executed !== true) return undefined;
  const executionContext = SQL_EXECUTION_CONTEXTS.find(context => context === value.executionContext);
  return {
    executed: true,
    ...(executionContext === undefined ? {} : {executionContext}),
    executableSql: boundedString(value.executableSql, MAX_SQL_CHARS),
    sqlRewrites: stringList(value.sqlRewrites, 12, 180),
    stdlibInjectedModules: stringList(value.stdlibInjectedModules, 24, 160),
    durationMs: boundedNumber(value.durationMs),
    rowCount: boundedNumber(value.rowCount),
    truncated: boundedBoolean(value.truncated),
  };
}

export function sanitizeQueryReview(value: unknown): QueryReviewV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== QUERY_REVIEW_SCHEMA_VERSION) return undefined;
  if (value.allowedUse !== 'review_metadata_only') return undefined;

  const id = boundedString(value.id, MAX_ID);
  const producer = sanitizeProducer(value.producer);
  const title = boundedString(value.title);
  const purpose = boundedString(value.purpose, 400);
  const observedExecution = sanitizeObservedExecution(value.observedExecution);
  if (!id || !producer || !title || !purpose || !observedExecution) return undefined;

  const reads = sanitizeReads(value.reads);
  const filters = sanitizeFilters(value.filters);
  const outputShape = sanitizeOutputShape(value.outputShape);
  const guardrails = sanitizeGuardrails(value.guardrails);
  const limitations = stringList(value.limitations, 12, 400) ?? [];

  if (reads.length === 0 && filters.length === 0 && outputShape.length === 0 && guardrails.length === 0 && limitations.length === 0) {
    return undefined;
  }

  return {
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id,
    producer,
    title,
    purpose,
    source: sanitizeSource(value.source),
    reads,
    filters,
    outputShape,
    guardrails,
    limitations,
    observedExecution,
    allowedUse: 'review_metadata_only',
  };
}

export function compactQueryReviewForToolResponse(
  review: QueryReviewV1,
): CompactQueryReviewForToolResponse {
  const { executableSql: _executableSql, ...observedExecution } = review.observedExecution;
  return {
    schemaVersion: review.schemaVersion,
    id: review.id,
    producer: review.producer,
    title: review.title,
    purpose: review.purpose,
    source: review.source,
    reads: review.reads,
    filters: review.filters,
    outputShape: review.outputShape,
    guardrails: review.guardrails,
    limitations: review.limitations,
    observedExecution,
    allowedUse: review.allowedUse,
  };
}
