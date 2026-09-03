// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Session-scoped artifact store for token-efficient skill result references.
 * Instead of returning full displayResults to the model, stores them as
 * artifacts and returns bounded references without duplicating audit detail.
 *
 * The full data still flows to the frontend via DataEnvelope — artifacts
 * only compress what Claude sees in its context window.
 *
 * Supports 3 detail levels via fetch_artifact:
 * - summary: compact metadata + bounded column aggregates
 * - rows: paginated rows (offset/limit) with totalRows + hasMore metadata
 * - full: complete original data structure
 */

import type { TraceProcessorQueryProvenance } from '../services/traceProcessorConnectionModel';
import type { IdentityResolutionV1 } from '../types/identityContract';
import type { DataEnvelopeMeta } from '../types/dataContract';
import {
  sanitizeQueryReview,
  type QueryReviewV1,
} from '../types/queryReviewContract';

export interface StoredArtifact {
  id: string;
  skillId: string;
  stepId?: string;
  layer?: string;
  title?: string;
  data: any;
  diagnostics?: any;
  storedAt: number;
  lastAccessedAt: number;
  /** Analysis plan phase that originally produced this artifact. */
  planPhaseId?: string;
  planPhaseTitle?: string;
  planPhaseGoal?: string;
  sourceToolCallId?: string;
  paramsHash?: string;
  /** Process/thread identity sidecar produced with this artifact's source Skill. */
  identityResolution?: IdentityResolutionV1;
  /** In comparison mode, which trace this artifact came from (provenance tracking) */
  sourceTrace?: import('./types').TraceSource;
  /** Trace processor provenance for SQL/artifact-backed evidence. */
  traceProvenance?: TraceProcessorQueryProvenance;
  queryReview?: QueryReviewV1;
  executionStatus?: DataEnvelopeMeta['executionStatus'];
  executionMessage?: string;
  executionError?: string;
}

export interface ArtifactSummary {
  id: string;
  skillId: string;
  stepId?: string;
  layer?: string;
  title?: string;
  rowCount: number;
  columns: string[];
  sampleRow?: any[];
  diagnosticCount: number;
  planPhaseId?: string;
  planPhaseTitle?: string;
  planPhaseGoal?: string;
  sourceToolCallId?: string;
  identityResolution?: IdentityResolutionV1;
  queryReview?: ArtifactQueryReviewRef;
  traceSide?: TraceProcessorQueryProvenance['traceSide'];
  paneSide?: TraceProcessorQueryProvenance['paneSide'];
  traceId?: string;
  executionStatus?: DataEnvelopeMeta['executionStatus'];
  executionMessage?: string;
  executionError?: string;
}

export interface ArtifactQueryReviewRef {
  /** Model-facing pointer; the StoredArtifact and report surfaces retain QueryReviewV1. */
  id: string;
  purpose: string;
  source: Pick<
    QueryReviewV1['source'],
    'skillId' | 'stepId' | 'artifactId' | 'evidenceRefId'
  >;
  observedExecution: Pick<
    QueryReviewV1['observedExecution'],
    'executed' | 'durationMs' | 'rowCount' | 'truncated'
  >;
  counts: {
    reads: number;
    filters: number;
    outputShape: number;
    guardrails: number;
    limitations: number;
  };
  limitations?: string[];
  allowedUse: QueryReviewV1['allowedUse'];
}

export type ArtifactAggregateScalar = string | number | boolean;

export interface ArtifactTopValue {
  value: ArtifactAggregateScalar;
  count: number;
  shareOfNonNull: number;
  valueTruncated?: boolean;
}

export interface ArtifactColumnAggregate {
  column: string;
  observedType: 'string' | 'number' | 'boolean' | 'bigint' | 'mixed';
  nonNullCount: number;
  nullCount: number;
  unsupportedValueCount?: number;
  distinctCount?: number;
  topValues?: ArtifactTopValue[];
  otherCount?: number;
  numeric?: {
    min: number;
    max: number;
    mean: number;
  };
}

export interface ArtifactAggregateSummary {
  analyzedRowCount: number;
  totalRowCount: number;
  complete: boolean;
  scannedColumnCount: number;
  omittedColumnCount: number;
  columns: ArtifactColumnAggregate[];
}

export interface DetailedArtifactSummary extends ArtifactSummary {
  aggregate: ArtifactAggregateSummary;
}

interface TrackedAggregateValue {
  value: ArtifactAggregateScalar;
  count: number;
  order: number;
}

interface MutableColumnAggregate {
  column: string;
  index: number;
  nonNullCount: number;
  nullCount: number;
  unsupportedValueCount: number;
  longStringCount: number;
  structuredStringCount: number;
  observedTypes: Set<ArtifactColumnAggregate['observedType']>;
  valueCounts?: Map<string, TrackedAggregateValue>;
  nextValueOrder: number;
  numericCount: number;
  numericMin: number;
  numericMax: number;
  numericMean: number;
}

function aggregateValueKey(value: ArtifactAggregateScalar, rawType: string): string {
  return `${rawType}:${String(value)}`;
}

function truncateAggregateString(value: string): {value: string; truncated: boolean} {
  if (value.length <= ArtifactStore.MAX_AGGREGATE_VALUE_CHARS) {
    return {value, truncated: false};
  }
  const suffixLength = 15;
  const prefixLength = ArtifactStore.MAX_AGGREGATE_VALUE_CHARS - suffixLength - 1;
  return {
    value: `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`,
    truncated: true,
  };
}

function roundAggregateNumber(value: number): number {
  if (Object.is(value, -0)) return 0;
  return Number(value.toPrecision(12));
}

function queryReviewRefForArtifact(review: QueryReviewV1): ArtifactQueryReviewRef {
  const limitations = review.limitations
    .slice(0, 2)
    .map(limitation => limitation.slice(0, 160));
  return {
    id: review.id,
    purpose: review.purpose.slice(0, 200),
    source: {
      skillId: review.source.skillId,
      stepId: review.source.stepId,
      artifactId: review.source.artifactId,
      evidenceRefId: review.source.evidenceRefId,
    },
    observedExecution: {
      executed: true,
      durationMs: review.observedExecution.durationMs,
      rowCount: review.observedExecution.rowCount,
      truncated: review.observedExecution.truncated,
    },
    counts: {
      reads: review.reads.length,
      filters: review.filters.length,
      outputShape: review.outputShape.length,
      guardrails: review.guardrails.length,
      limitations: review.limitations.length,
    },
    ...(limitations.length > 0 ? {limitations} : {}),
    allowedUse: review.allowedUse,
  };
}

/**
 * Compact artifact summary optimized for Claude's context window.
 * Removes redundant fields (skillId already in parent, layer unused for fetch decisions)
 * and merges columns+sampleRow into a self-describing preview object.
 */
export interface CompactArtifactSummary {
  id: string;
  stepId?: string;
  title?: string;
  rowCount: number;
  /** First row as {column: value} object — self-describing, no separate columns array needed. */
  preview?: Record<string, any>;
  /** Only present when diagnostics exist (> 0). */
  diagnosticCount?: number;
  /** Origin phase for explaining why this artifact/table exists. */
  planPhaseId?: string;
  planPhaseTitle?: string;
  traceSide?: TraceProcessorQueryProvenance['traceSide'];
  paneSide?: TraceProcessorQueryProvenance['paneSide'];
  traceId?: string;
  queryReview?: ArtifactQueryReviewRef;
  executionStatus?: DataEnvelopeMeta['executionStatus'];
  executionMessage?: string;
  executionError?: string;
}

export class ArtifactStore {
  private artifacts: Map<string, StoredArtifact> = new Map();
  private counter = 0;
  /** Maximum number of artifacts before LRU eviction. */
  private readonly maxArtifacts: number;

  constructor(maxArtifacts = 50) {
    this.maxArtifacts = maxArtifacts;
  }

  /**
   * Store a skill result artifact and return its reference ID.
   * Evicts least-recently-accessed artifacts when exceeding capacity.
   */
  store(entry: {
    skillId: string;
    stepId?: string;
    layer?: string;
    title?: string;
    data: any;
    diagnostics?: any;
    planPhaseId?: string;
    planPhaseTitle?: string;
    planPhaseGoal?: string;
    sourceToolCallId?: string;
    paramsHash?: string;
    identityResolution?: IdentityResolutionV1;
    traceProvenance?: TraceProcessorQueryProvenance;
    queryReview?: QueryReviewV1;
    executionStatus?: DataEnvelopeMeta['executionStatus'];
    executionMessage?: string;
    executionError?: string;
  }): string {
    const id = `art-${++this.counter}`;
    const now = Date.now();
    const queryReview = sanitizeQueryReview(entry.queryReview);
    this.artifacts.set(id, {
      id,
      ...entry,
      queryReview,
      storedAt: now,
      lastAccessedAt: now,
    });

    // LRU eviction: remove least-recently-accessed artifacts
    while (this.artifacts.size > this.maxArtifacts) {
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [aid, art] of this.artifacts) {
        if (art.lastAccessedAt < oldestTime) {
          oldestTime = art.lastAccessedAt;
          oldestId = aid;
        }
      }
      if (oldestId) this.artifacts.delete(oldestId);
      else break;
    }

    return id;
  }

  updateQueryReview(id: string, queryReview: QueryReviewV1 | undefined): boolean {
    const artifact = this.artifacts.get(id);
    if (!artifact) return false;
    const sanitized = sanitizeQueryReview(queryReview);
    if (!sanitized) return false;
    artifact.queryReview = sanitized;
    return true;
  }

  /**
   * Get a stored artifact by ID. Updates access time for LRU tracking.
   */
  get(id: string): StoredArtifact | undefined {
    const artifact = this.artifacts.get(id);
    if (artifact) artifact.lastAccessedAt = Date.now();
    return artifact;
  }

  /**
   * Generate a compact summary for an artifact (for Claude's context).
   */
  generateSummary(id: string): ArtifactSummary | undefined {
    const artifact = this.artifacts.get(id);
    if (!artifact) return undefined;

    const data = artifact.data;
    const columns: string[] = data?.columns || [];
    const rows: any[][] = data?.rows || [];

    return {
      id: artifact.id,
      skillId: artifact.skillId,
      stepId: artifact.stepId,
      layer: artifact.layer,
      title: artifact.title,
      rowCount: rows.length,
      columns,
      sampleRow: rows.length > 0 ? rows[0] : undefined,
      diagnosticCount: Array.isArray(artifact.diagnostics) ? artifact.diagnostics.length : 0,
      planPhaseId: artifact.planPhaseId,
      planPhaseTitle: artifact.planPhaseTitle,
      planPhaseGoal: artifact.planPhaseGoal,
      sourceToolCallId: artifact.sourceToolCallId,
      identityResolution: artifact.identityResolution,
      ...(artifact.traceProvenance?.traceSide ? { traceSide: artifact.traceProvenance.traceSide } : {}),
      ...(artifact.traceProvenance?.paneSide ? { paneSide: artifact.traceProvenance.paneSide } : {}),
      ...(artifact.traceProvenance?.traceId ? { traceId: artifact.traceProvenance.traceId } : {}),
      ...(artifact.queryReview ? {queryReview: queryReviewRefForArtifact(artifact.queryReview)} : {}),
      ...(artifact.executionStatus ? { executionStatus: artifact.executionStatus } : {}),
      ...(artifact.executionMessage ? { executionMessage: artifact.executionMessage } : {}),
      ...(artifact.executionError ? { executionError: artifact.executionError } : {}),
    };
  }

  /**
   * Add bounded, data-shape-driven aggregates for an explicit summary fetch.
   * The normal invoke_skill compact path intentionally continues to use
   * generateSummary() so it keeps the same payload and runtime cost.
   */
  private generateDetailedSummary(id: string): DetailedArtifactSummary | undefined {
    const summary = this.generateSummary(id);
    const artifact = this.artifacts.get(id);
    if (!summary || !artifact) return undefined;

    const columns: string[] = Array.isArray(artifact.data?.columns)
      ? artifact.data.columns.map((column: unknown) => String(column))
      : [];
    const rows: any[][] = Array.isArray(artifact.data?.rows) ? artifact.data.rows : [];
    const sampledRows = ArtifactStore.sampleRowsForAggregate(rows);
    const scannedColumns = columns.slice(0, ArtifactStore.MAX_AGGREGATE_COLUMNS_SCANNED);
    const mutable = scannedColumns.map<MutableColumnAggregate>((column, index) => ({
      column,
      index,
      nonNullCount: 0,
      nullCount: 0,
      unsupportedValueCount: 0,
      longStringCount: 0,
      structuredStringCount: 0,
      observedTypes: new Set(),
      valueCounts: new Map(),
      nextValueOrder: 0,
      numericCount: 0,
      numericMin: Infinity,
      numericMax: -Infinity,
      numericMean: 0,
    }));

    for (const row of sampledRows) {
      for (const state of mutable) {
        const rawValue = Array.isArray(row) ? row[state.index] : undefined;
        if (rawValue === null || rawValue === undefined) {
          state.nullCount += 1;
          continue;
        }

        state.nonNullCount += 1;
        let aggregateValue: ArtifactAggregateScalar | undefined;
        let rawType = typeof rawValue;
        if (rawType === 'string' || rawType === 'boolean') {
          aggregateValue = rawValue as string | boolean;
          state.observedTypes.add(rawType as 'string' | 'boolean');
          if (rawType === 'string' && rawValue.length > ArtifactStore.MAX_AGGREGATE_VALUE_CHARS) {
            state.longStringCount += 1;
          }
          if (rawType === 'string' && ArtifactStore.looksLikeStructuredString(rawValue)) {
            state.structuredStringCount += 1;
          }
        } else if (rawType === 'number' && Number.isFinite(rawValue)) {
          aggregateValue = rawValue;
          state.observedTypes.add('number');
          state.numericCount += 1;
          state.numericMin = Math.min(state.numericMin, rawValue);
          state.numericMax = Math.max(state.numericMax, rawValue);
          state.numericMean += (rawValue - state.numericMean) / state.numericCount;
        } else if (rawType === 'bigint') {
          aggregateValue = rawValue.toString();
          rawType = 'bigint';
          state.observedTypes.add('bigint');
        } else {
          state.unsupportedValueCount += 1;
          state.observedTypes.add('mixed');
        }

        if (aggregateValue === undefined || !state.valueCounts) continue;
        const key = aggregateValueKey(aggregateValue, rawType);
        const existing = state.valueCounts.get(key);
        if (existing) {
          existing.count += 1;
        } else if (state.valueCounts.size < ArtifactStore.MAX_TRACKED_AGGREGATE_VALUES) {
          state.valueCounts.set(key, {
            value: aggregateValue,
            count: 1,
            order: state.nextValueOrder++,
          });
        } else {
          // High-cardinality columns remain eligible for numeric ranges, but
          // categorical counts are discarded instead of growing without bound.
          state.valueCounts = undefined;
        }
      }
    }

    const categorical = mutable
      .filter(state => state.valueCounts
        && state.valueCounts.size > 0
        && Array.from(state.observedTypes).some(type => type !== 'number' && type !== 'mixed')
        && state.longStringCount / Math.max(1, state.nonNullCount) <= 0.5
        && state.structuredStringCount / Math.max(1, state.nonNullCount) <= 0.5)
      .map(state => ({state, score: ArtifactStore.categoricalAggregateScore(state, sampledRows.length)}))
      .sort((left, right) => right.score - left.score || left.state.index - right.state.index)
      .slice(0, ArtifactStore.MAX_CATEGORICAL_AGGREGATES);
    const selectedIndexes = new Set(categorical.map(candidate => candidate.state.index));
    const numeric = mutable
      .filter(state => !selectedIndexes.has(state.index) && state.numericCount > 0)
      .map(state => ({
        state,
        score: state.numericCount / Math.max(1, sampledRows.length)
          + (state.numericMin === state.numericMax ? 0 : 0.25),
      }))
      .sort((left, right) => right.score - left.score || left.state.index - right.state.index)
      .slice(0, Math.max(0, ArtifactStore.MAX_RETURNED_AGGREGATE_COLUMNS - categorical.length));
    const selected = [...categorical, ...numeric]
      .map(candidate => candidate.state)
      .sort((left, right) => left.index - right.index)
      .map(state => ArtifactStore.finalizeColumnAggregate(state));

    return {
      ...summary,
      aggregate: {
        analyzedRowCount: sampledRows.length,
        totalRowCount: rows.length,
        complete: sampledRows.length === rows.length,
        scannedColumnCount: scannedColumns.length,
        omittedColumnCount: Math.max(0, columns.length - selected.length),
        columns: selected,
      },
    };
  }

  private static sampleRowsForAggregate(rows: any[][]): any[][] {
    if (rows.length <= ArtifactStore.MAX_AGGREGATE_ROWS) return rows;
    const lastIndex = rows.length - 1;
    const sampleLastIndex = ArtifactStore.MAX_AGGREGATE_ROWS - 1;
    return Array.from(
      {length: ArtifactStore.MAX_AGGREGATE_ROWS},
      (_, index) => rows[Math.floor((index * lastIndex) / sampleLastIndex)],
    );
  }

  private static categoricalAggregateScore(
    state: MutableColumnAggregate,
    analyzedRowCount: number,
  ): number {
    const distinctCount = state.valueCounts?.size ?? 0;
    const supportedCount = Math.max(1, state.nonNullCount - state.unsupportedValueCount);
    const coverage = state.nonNullCount / Math.max(1, analyzedRowCount);
    const repetition = Math.max(0, 1 - distinctCount / supportedCount);
    const diversity = distinctCount <= 1
      ? 0.1
      : Math.min(1, Math.log2(distinctCount + 1) / 4);
    const longStringPenalty = state.longStringCount / supportedCount * 0.5;
    return coverage * 0.4 + repetition * 0.3 + diversity * 0.3 - longStringPenalty;
  }

  private static looksLikeStructuredString(value: string): boolean {
    const trimmed = value.trim();
    return (trimmed.startsWith('[') && trimmed.endsWith(']'))
      || (trimmed.startsWith('{') && trimmed.endsWith('}'));
  }

  private static finalizeColumnAggregate(state: MutableColumnAggregate): ArtifactColumnAggregate {
    const observedType = state.observedTypes.size === 1
      ? Array.from(state.observedTypes)[0]
      : 'mixed';
    const result: ArtifactColumnAggregate = {
      column: state.column,
      observedType,
      nonNullCount: state.nonNullCount,
      nullCount: state.nullCount,
      ...(state.unsupportedValueCount > 0
        ? {unsupportedValueCount: state.unsupportedValueCount}
        : {}),
    };

    if (state.valueCounts) {
      const topEntries = Array.from(state.valueCounts.values())
        .sort((left, right) => right.count - left.count || left.order - right.order)
        .slice(0, ArtifactStore.MAX_TOP_AGGREGATE_VALUES);
      const topValues = topEntries.map<ArtifactTopValue>(entry => {
        const display = typeof entry.value === 'string'
          ? truncateAggregateString(entry.value)
          : {value: entry.value, truncated: false};
        return {
          value: display.value,
          count: entry.count,
          shareOfNonNull: roundAggregateNumber(entry.count / Math.max(1, state.nonNullCount)),
          ...(display.truncated ? {valueTruncated: true} : {}),
        };
      });
      const topCount = topEntries.reduce((total, entry) => total + entry.count, 0);
      result.distinctCount = state.valueCounts.size;
      result.topValues = topValues;
      result.otherCount = Math.max(0, state.nonNullCount - topCount);
    }

    if (state.numericCount > 0) {
      result.numeric = {
        min: roundAggregateNumber(state.numericMin),
        max: roundAggregateNumber(state.numericMax),
        mean: roundAggregateNumber(state.numericMean),
      };
    }
    return result;
  }

  /**
   * Generate a compact summary optimized for Claude's context window.
   * Delegates to generateSummary(), then reshapes:
   * - skillId/layer: omitted (already in parent invoke_skill result)
   * - diagnosticCount: only included when > 0
   * - columns + sampleRow → preview: { column: value } (self-describing)
   */
  generateCompactSummary(id: string): CompactArtifactSummary | undefined {
    const full = this.generateSummary(id);
    if (!full) return undefined;
    const artifact = this.artifacts.get(id);

    let preview: Record<string, any> | undefined;
    if (full.sampleRow && full.columns.length > 0) {
      preview = {};
      for (let i = 0; i < full.columns.length; i++) {
        preview[full.columns[i]] = i < full.sampleRow.length ? full.sampleRow[i] : null;
      }
    }

    return {
      id: full.id,
      stepId: full.stepId,
      title: full.title,
      rowCount: full.rowCount,
      ...(preview ? { preview } : {}),
      ...(full.diagnosticCount > 0 ? { diagnosticCount: full.diagnosticCount } : {}),
      ...(full.planPhaseId ? { planPhaseId: full.planPhaseId } : {}),
      ...(full.planPhaseTitle ? { planPhaseTitle: full.planPhaseTitle } : {}),
      ...(artifact?.traceProvenance?.traceSide ? { traceSide: artifact.traceProvenance.traceSide } : {}),
      ...(artifact?.traceProvenance?.paneSide ? { paneSide: artifact.traceProvenance.paneSide } : {}),
      ...(artifact?.traceProvenance?.traceId ? { traceId: artifact.traceProvenance.traceId } : {}),
      ...(artifact?.queryReview ? {queryReview: queryReviewRefForArtifact(artifact.queryReview)} : {}),
      ...(artifact?.executionStatus ? { executionStatus: artifact.executionStatus } : {}),
      ...(artifact?.executionMessage ? { executionMessage: artifact.executionMessage } : {}),
      ...(artifact?.executionError ? { executionError: artifact.executionError } : {}),
    };
  }

  /**
   * Fetch artifact data at the requested detail level.
   * For 'rows' detail, supports pagination via offset/limit to prevent token overflow.
   * Returns totalRows and hasMore so the caller knows whether to fetch more.
   */
  fetch(id: string, detail: 'summary' | 'rows' | 'full', offset?: number, limit?: number): any | undefined {
    const artifact = this.artifacts.get(id);
    if (!artifact) return undefined;
    artifact.lastAccessedAt = Date.now();

    switch (detail) {
      case 'summary':
        return this.generateDetailedSummary(id);
      case 'rows': {
        const allRows: any[][] = artifact.data?.rows || [];
        const totalRows = allRows.length;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? ArtifactStore.DEFAULT_PAGE_SIZE;
        const pagedRows = allRows.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        const hasMore = effectiveOffset + effectiveLimit < totalRows;
        return {
          id: artifact.id,
          columns: artifact.data?.columns || [],
          rows: pagedRows,
          totalRows,
          offset: effectiveOffset,
          limit: effectiveLimit,
          hasMore,
          diagnostics: artifact.diagnostics,
          planPhaseId: artifact.planPhaseId,
          planPhaseTitle: artifact.planPhaseTitle,
          planPhaseGoal: artifact.planPhaseGoal,
          sourceToolCallId: artifact.sourceToolCallId,
          paramsHash: artifact.paramsHash,
          identityResolution: artifact.identityResolution,
          traceSide: artifact.traceProvenance?.traceSide,
          paneSide: artifact.traceProvenance?.paneSide,
          traceId: artifact.traceProvenance?.traceId,
          traceProvenance: artifact.traceProvenance,
          executionStatus: artifact.executionStatus,
          executionMessage: artifact.executionMessage,
          executionError: artifact.executionError,
          ...(artifact.queryReview ? {queryReview: queryReviewRefForArtifact(artifact.queryReview)} : {}),
        };
      }
      case 'full': {
        // Cap rows at MAX_FULL_ROWS to prevent context window overflow.
        // Larger datasets should use detail="rows" with pagination.
        const fullRows: any[][] = artifact.data?.rows || [];
        const truncatedFull = fullRows.length > ArtifactStore.MAX_FULL_ROWS;
        const cappedData = truncatedFull
          ? { ...artifact.data, rows: fullRows.slice(0, ArtifactStore.MAX_FULL_ROWS) }
          : artifact.data;
        return {
          id: artifact.id,
          skillId: artifact.skillId,
          stepId: artifact.stepId,
          layer: artifact.layer,
          title: artifact.title,
          data: cappedData,
          diagnostics: artifact.diagnostics,
          planPhaseId: artifact.planPhaseId,
          planPhaseTitle: artifact.planPhaseTitle,
          planPhaseGoal: artifact.planPhaseGoal,
          sourceToolCallId: artifact.sourceToolCallId,
          paramsHash: artifact.paramsHash,
          identityResolution: artifact.identityResolution,
          traceSide: artifact.traceProvenance?.traceSide,
          paneSide: artifact.traceProvenance?.paneSide,
          traceId: artifact.traceProvenance?.traceId,
          traceProvenance: artifact.traceProvenance,
          queryReview: artifact.queryReview,
          executionStatus: artifact.executionStatus,
          executionMessage: artifact.executionMessage,
          executionError: artifact.executionError,
          ...(truncatedFull ? { truncated: true, totalRows: fullRows.length, hint: 'Use detail="rows" with offset/limit for complete data' } : {}),
        };
      }
      default:
        return this.generateSummary(id);
    }
  }

  /** Default page size for 'rows' fetch — balances completeness vs token budget. */
  static readonly DEFAULT_PAGE_SIZE = 50;
  /** Hard cap for 'full' fetch — prevents context overflow on large artifacts. */
  static readonly MAX_FULL_ROWS = 500;
  /** Explicit summary aggregation limits; compact invoke_skill summaries do not use them. */
  static readonly MAX_AGGREGATE_ROWS = 5_000;
  static readonly MAX_AGGREGATE_COLUMNS_SCANNED = 128;
  static readonly MAX_RETURNED_AGGREGATE_COLUMNS = 8;
  static readonly MAX_CATEGORICAL_AGGREGATES = 6;
  static readonly MAX_TRACKED_AGGREGATE_VALUES = 64;
  static readonly MAX_TOP_AGGREGATE_VALUES = 10;
  static readonly MAX_AGGREGATE_VALUE_CHARS = 80;

  /** Get total artifact count. */
  get size(): number {
    return this.artifacts.size;
  }

  /**
   * Serialize all artifacts for snapshot persistence.
   * Returns a shallow copy of all stored artifacts.
   */
  serialize(): StoredArtifact[] {
    return Array.from(this.artifacts.values());
  }

  /**
   * Restore an ArtifactStore from a persisted snapshot.
   * Reconstructs the internal counter from the highest artifact ID
   * so new artifacts get IDs that don't collide with restored ones.
   */
  static fromSnapshot(artifacts: StoredArtifact[]): ArtifactStore {
    const store = new ArtifactStore();
    for (const art of artifacts) {
      store.artifacts.set(art.id, art);
      const num = parseInt(art.id.replace('art-', ''), 10) || 0;
      if (num > store.counter) store.counter = num;
    }
    return store;
  }

  /** Clear all artifacts (e.g., on session reset). */
  clear(): void {
    this.artifacts.clear();
    this.counter = 0;
  }
}
