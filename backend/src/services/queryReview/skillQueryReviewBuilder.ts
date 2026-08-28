// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { analyzeSqlGuardrails } from '../sqlGuardrailAnalyzer';
import type { TraceProcessorQueryProvenance } from '../traceProcessorConnectionModel';
import type { DisplayResult } from '../skillEngine/types';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  sanitizeQueryReview,
  type QueryReviewV1,
} from '../../types/queryReviewContract';
import {parseOutputLanguage, type OutputLanguage} from '../../agentv3/outputLanguage';
import {
  buildObservedQueryPurpose,
  isLowSignalQueryPurpose,
  queryReviewStableHash,
  type QueryReviewProducerInput,
} from './queryReviewBuilder';
import {
  introspectSqlForQueryReview,
  type SqlReviewOutputColumn,
} from './sqlReviewIntrospector';

export interface BuildSkillQueryReviewInput {
  skillId: string;
  displayResult: DisplayResult;
  traceProvenance?: TraceProcessorQueryProvenance;
  producer?: QueryReviewProducerInput;
  artifactId?: string;
  evidenceRefId?: string;
  outputLanguage?: OutputLanguage;
}

export interface BuildSkillQueryReviewsInput {
  skillId: string;
  displayResults: DisplayResult[];
  traceProvenance?: TraceProcessorQueryProvenance;
  producer?: QueryReviewProducerInput;
  artifactIdsByStepId?: Map<string, string>;
  evidenceRefsByStepId?: Map<string, string>;
}

function outputColumnsFromDisplayResult(displayResult: DisplayResult): SqlReviewOutputColumn[] {
  const explicitColumns = Array.isArray(displayResult.columnDefinitions)
    ? displayResult.columnDefinitions
        .map(column => ({
          name: column.name,
          type: typeof column.type === 'string' ? column.type : undefined,
        }))
        .filter(column => column.name)
    : [];
  if (explicitColumns.length > 0) return explicitColumns;
  return Array.isArray(displayResult.data?.columns) ? displayResult.data.columns : [];
}

function rowCountFromDisplayResult(displayResult: DisplayResult): number | undefined {
  return Array.isArray(displayResult.data?.rows) ? displayResult.data.rows.length : undefined;
}

export function buildSkillQueryReview(input: BuildSkillQueryReviewInput): QueryReviewV1 | undefined {
  if (input.producer?.sourceToolCallId?.startsWith('compare_skill')) return undefined;

  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const executableSql = typeof input.displayResult.sql === 'string' ? input.displayResult.sql : undefined;
  const introspection = introspectSqlForQueryReview({
    sql: executableSql,
    outputColumns: outputColumnsFromDisplayResult(input.displayResult),
    outputLanguage,
  });
  const guardrails = executableSql
    ? analyzeSqlGuardrails(executableSql).map(issue => ({
        ruleId: issue.ruleId,
        message: issue.message,
        line: issue.line,
        severity: 'warning' as const,
      }))
    : [];
  const limitations = [
    ...introspection.limitations,
    ...(!executableSql ? ['Skill result review was derived from observed display metadata; full Skill YAML remains the source of truth.'] : []),
  ];
  const queryHash = executableSql
    ? queryReviewStableHash(executableSql)
    : undefined;
  const reviewId = `qr:invoke_skill:${queryReviewStableHash({
    tool: input.producer?.sourceToolCallId,
    paramsHash: input.producer?.paramsHash,
    skillId: input.skillId,
    stepId: input.displayResult.stepId,
    evidenceRefId: input.evidenceRefId,
    artifactId: input.artifactId,
    queryHash,
  })}`;
  const title = `${input.skillId}:${input.displayResult.stepId} review`;
  const requestedPurpose = input.producer?.producerReason;
  const purpose = isLowSignalQueryPurpose(requestedPurpose)
    ? buildObservedQueryPurpose({
        title: input.displayResult.title || input.displayResult.stepId,
        introspection,
        outputLanguage,
      })
    : requestedPurpose!;

  return sanitizeQueryReview({
    schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
    id: reviewId,
    producer: {
      kind: 'invoke_skill',
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
      skillId: input.skillId,
      stepId: input.displayResult.stepId,
      artifactId: input.artifactId,
      evidenceRefId: input.evidenceRefId,
      queryHash,
    },
    reads: introspection.reads,
    filters: introspection.filters,
    outputShape: introspection.outputShape,
    guardrails,
    limitations,
    observedExecution: {
      executed: true,
      executableSql,
      rowCount: rowCountFromDisplayResult(input.displayResult),
    },
    allowedUse: 'review_metadata_only',
  });
}

export function buildSkillQueryReviews(input: BuildSkillQueryReviewsInput): Map<string, QueryReviewV1> {
  const reviews = new Map<string, QueryReviewV1>();
  for (const displayResult of input.displayResults) {
    const stepId = displayResult.stepId;
    const review = buildSkillQueryReview({
      skillId: input.skillId,
      displayResult,
      traceProvenance: input.traceProvenance,
      producer: input.producer,
      artifactId: input.artifactIdsByStepId?.get(stepId),
      evidenceRefId: input.evidenceRefsByStepId?.get(stepId),
    });
    if (review) reviews.set(stepId, review);
  }
  return reviews;
}
