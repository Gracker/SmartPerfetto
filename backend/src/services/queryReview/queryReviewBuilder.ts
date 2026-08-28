// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../agentv3/outputLanguage';
import { analyzeSqlGuardrails } from '../sqlGuardrailAnalyzer';
import type { TraceProcessorQueryProvenance } from '../traceProcessorConnectionModel';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  sanitizeQueryReview,
  type QueryReviewProducerKind,
  type QueryReviewV1,
} from '../../types/queryReviewContract';
import {
  introspectSqlForQueryReview,
  type SqlReviewOutputColumn,
  type SqlReviewIntrospection,
} from './sqlReviewIntrospector';

export interface QueryReviewProducerInput {
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  producerReason?: string;
}

export interface BuildSqlQueryReviewInput {
  producerKind: Extract<QueryReviewProducerKind, 'execute_sql' | 'execute_sql_on'>;
  executableSql?: string;
  outputColumns?: SqlReviewOutputColumn[];
  traceProvenance?: TraceProcessorQueryProvenance;
  producer?: QueryReviewProducerInput;
  evidenceRefId?: string;
  queryHash?: string;
  artifactId?: string;
  durationMs?: number;
  rowCount?: number;
  truncated?: boolean;
  sqlRewrites?: string[];
  stdlibInjectedModules?: string[];
  processIdentityWarning?: string;
  outputLanguage?: OutputLanguage;
  title?: string;
  purpose?: string;
}

export function queryReviewStableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const LOW_SIGNAL_QUERY_PURPOSE_PATTERNS = [
  /执行(?:当前|参考)?\s*Trace\s*SQL，?验证(?:本阶段|对比)?(?:的)?(?:具体)?数据点。?/i,
  /run sql on the (?:current|reference) trace to verify/i,
  /调用 Skill .+收集本阶段结构化证据。?/i,
  /run skill .+ to collect structured evidence for this phase/i,
  /review the (?:executed sql|skill output) shape/i,
];

export function isLowSignalQueryPurpose(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || LOW_SIGNAL_QUERY_PURPOSE_PATTERNS.some(pattern => pattern.test(text));
}

function boundedPurposeItems(values: string[], limit: number, itemLimit: number): string[] {
  return values
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map(value => value.length <= itemLimit ? value : `${value.slice(0, itemLimit - 1)}…`);
}

export function buildObservedQueryPurpose(input: {
  title?: string;
  introspection: SqlReviewIntrospection;
  outputLanguage: OutputLanguage;
}): string {
  const reads = boundedPurposeItems(
    input.introspection.reads.map(read => read.table),
    4,
    48,
  );
  const filters = boundedPurposeItems(
    input.introspection.filters.map(filter => filter.expression),
    2,
    96,
  );
  const outputs = boundedPurposeItems(
    input.introspection.outputShape.map(column => column.name),
    6,
    48,
  );
  const clauses: string[] = [];
  if (reads.length > 0) {
    clauses.push(localize(
      input.outputLanguage,
      `查询 ${reads.join('、')}`,
      `Queries ${reads.join(', ')}`,
    ));
  }
  if (filters.length > 0) {
    clauses.push(localize(
      input.outputLanguage,
      `筛选 ${filters.join('；')}`,
      `filters by ${filters.join('; ')}`,
    ));
  }
  if (outputs.length > 0) {
    clauses.push(localize(
      input.outputLanguage,
      `返回 ${outputs.join('、')}`,
      `returns ${outputs.join(', ')}`,
    ));
  }

  const title = String(input.title || '').trim();
  const subject = title
    ? localize(input.outputLanguage, `“${title}”：`, `“${title}”: `)
    : '';
  if (clauses.length > 0) {
    const separator = input.outputLanguage === 'en' ? '; ' : '；';
    const terminator = input.outputLanguage === 'en' ? '.' : '。';
    return `${subject}${clauses.join(separator)}${terminator}`;
  }
  return localize(
    input.outputLanguage,
    `${subject}展示本步骤实际返回的结构化结果。`,
    `${subject}Shows the structured result returned by this step.`,
  );
}

export function buildSqlQueryReview(input: BuildSqlQueryReviewInput): QueryReviewV1 | undefined {
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const introspection = introspectSqlForQueryReview({
    sql: input.executableSql,
    outputColumns: input.outputColumns,
    outputLanguage,
  });
  const guardrails = input.executableSql
    ? analyzeSqlGuardrails(input.executableSql).map(issue => ({
        ruleId: issue.ruleId,
        message: issue.message,
        line: issue.line,
        severity: 'warning' as const,
      }))
    : [];
  const limitations = [
    ...introspection.limitations,
    ...(input.processIdentityWarning ? [input.processIdentityWarning] : []),
  ];
  const reviewId = `qr:${input.producerKind}:${queryReviewStableHash({
    tool: input.producer?.sourceToolCallId,
    paramsHash: input.producer?.paramsHash,
    evidenceRefId: input.evidenceRefId,
    queryHash: input.queryHash,
    artifactId: input.artifactId,
    sql: input.executableSql,
  })}`;
  const requestedPurpose = input.purpose || input.producer?.producerReason;
  const title = input.title || localize(outputLanguage, '已执行 SQL review', 'Executed SQL review');
  const purpose = isLowSignalQueryPurpose(requestedPurpose)
    ? buildObservedQueryPurpose({title, introspection, outputLanguage})
    : requestedPurpose!;

  return sanitizeQueryReview({
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id: reviewId,
    producer: {
      kind: input.producerKind,
      sourceToolCallId: input.producer?.sourceToolCallId,
      paramsHash: input.producer?.paramsHash,
      planPhaseId: input.producer?.planPhaseId,
      planPhaseTitle: input.producer?.planPhaseTitle,
      traceSide: input.traceProvenance?.traceSide,
      paneSide: input.traceProvenance?.paneSide,
      traceId: input.traceProvenance?.traceId,
    },
    title,
    purpose,
    source: {
      artifactId: input.artifactId,
      evidenceRefId: input.evidenceRefId,
      queryHash: input.queryHash,
    },
    reads: introspection.reads,
    filters: introspection.filters,
    outputShape: introspection.outputShape,
    guardrails,
    limitations,
    observedExecution: {
      executed: true,
      executableSql: input.executableSql,
      sqlRewrites: input.sqlRewrites,
      stdlibInjectedModules: input.stdlibInjectedModules,
      durationMs: input.durationMs,
      rowCount: input.rowCount,
      truncated: input.truncated,
    },
    allowedUse: 'review_metadata_only',
  });
}
