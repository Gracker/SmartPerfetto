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
 * - rows: paginated rows (offset/limit) with totalRows + hasMore metadata; each
 *   row carries its artifact-wide rowIndex (offset + position)
 * - full: complete original data structure
 */

import type { TraceProcessorQueryProvenance } from '../services/traceProcessorConnectionModel';
import {randomUUID} from 'crypto';
import {isDeepStrictEqual} from 'util';
import type {RuntimeToolInvocationEvent} from '../agentRuntime/runtimeToolObserver';
import {captureInvestigationToolObservation, recordCaptureToolCall,
  type InvestigationToolObservation} from '../services/evidence/investigationEvidenceLedger';
import {currentRuntimeToolInvocation} from '../agentRuntime/runtimeToolInvocationContext';
import {createDataEnvelope} from '../types/dataContract';
import {capturedEvidenceTable, freezeEvidenceValue, type CapturedEvidenceTable, type EvidenceTableWitness, INDEXED_ROW_SHAPE, indexEvidenceRows,
  MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT, type ModelEvidenceProjectionStatus,
  type ModelEvidenceProjectionUnavailableReason,
  projectEvidenceColumnUnitsForModel} from '../services/evidence/evidenceCapture';
import {createEvidenceReadView, MAX_EVIDENCE_READ_REFERENCES, type EvidenceReadView, type EvidenceReadViewOptions,
  type EvidenceReadRecord} from '../services/evidence/evidenceReadView';
import { scopeMetadata, type IdentityResolutionV1, type EvidenceScopeMetadata, type EvidenceScopeProvenanceV1 } from '../types/identityContract';
import type { DataEnvelopeMeta } from '../types/dataContract';
import {
  sanitizeQueryReview,
  type QueryReviewV1,
} from '../types/queryReviewContract';

export interface StoredArtifact extends EvidenceScopeMetadata {
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
  /** Bounded model-only cell projection status; never confers evidence authority. */
  modelProjection?: ModelEvidenceProjectionStatus;
}

export interface ArtifactSummary extends EvidenceScopeMetadata {
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
  modelProjection?: ModelEvidenceProjectionStatus;
  columnUnits?: Readonly<Record<string, string>>;
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

const MODEL_PROJECTION_UNAVAILABLE_REASONS = new Set<ModelEvidenceProjectionUnavailableReason>([
  'not_table', 'unissued_witness', 'unavailable_witness', 'row_mismatch',
  'duplicate_columns', 'column_mismatch', 'unsupported_raw_cell',
]);

function sanitizeModelProjection(value: ModelEvidenceProjectionStatus | undefined): ModelEvidenceProjectionStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (value.status === 'exact') return {status: 'exact'};
  if (value.status === 'unavailable') return value.reason && MODEL_PROJECTION_UNAVAILABLE_REASONS.has(value.reason)
    ? {status: 'unavailable', reason: value.reason} : undefined;
  if (value.status !== 'truncated' || !Number.isSafeInteger(value.truncatedCellCount) ||
      (value.truncatedCellCount ?? 0) <= 0 || !Array.isArray(value.truncatedCells)) return undefined;
  const truncatedCells = value.truncatedCells.filter(cell => cell && Number.isSafeInteger(cell.rowIndex) &&
    cell.rowIndex >= 0 && typeof cell.column === 'string' && cell.column.length > 0 &&
    Number.isSafeInteger(cell.originalBytes) && cell.originalBytes > 0)
    .slice(0, MODEL_EVIDENCE_TRUNCATED_CELL_LIMIT)
    .map(cell => ({rowIndex: cell.rowIndex, column: cell.column, originalBytes: cell.originalBytes}));
  if (truncatedCells.length === 0) return undefined;
  const truncatedCellCount = value.truncatedCellCount!;
  return {status: 'truncated', truncatedCellCount, truncatedCells,
    ...(truncatedCellCount > truncatedCells.length
      ? {truncatedCellsOmitted: truncatedCellCount - truncatedCells.length} : {})};
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
export interface CompactArtifactSummary extends EvidenceScopeMetadata {
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
  modelProjection?: ModelEvidenceProjectionStatus;
  columnUnits?: Readonly<Record<string, string>>;
}

// Origin belongs to the issued execution witness, not the latest artifact registration.
const captureOriginRuns = new WeakMap<EvidenceTableWitness, string | undefined>();

export const EVIDENCE_RETENTION_CELLS_ENV = 'SMARTPERFETTO_EVIDENCE_RETENTION_CELLS';

/**
 * Retained witnesses are bounded by cells — columns x rows — because a witness
 * holds every row its query returned, and a 40-column result costs forty times
 * a single-column one of the same length. Counting captures says nothing about
 * memory; counting rows says nothing about width.
 *
 * The default states an affordable resource cost (roughly tens of MB per
 * session store), not a figure read off any particular corpus. Deployments that
 * analyse wider traces raise it through the environment rather than by editing
 * a number whose only justification was the traces someone had on hand.
 */
const DEFAULT_RETAINED_EVIDENCE_CELLS = 1_000_000;

/**
 * Secondary ceiling: cells do not account for the per-record meta, column and
 * field-semantics overhead a capture carries, so a flood of one-cell captures
 * still needs a bound. The floor is what one conclusion may cite; a session
 * spans several turns and may cite across them, so the ceiling is a multiple of
 * that floor rather than equal to it.
 */
export const RETAINED_EVIDENCE_CAPTURE_CEILING = 8 * MAX_EVIDENCE_READ_REFERENCES;
/** Store key prefix of captures registered without an artifact. */
const STANDALONE_CAPTURE_KEY_PREFIX = 'capture:';

function resolveRetainedEvidenceCells(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[EVIDENCE_RETENTION_CELLS_ENV]?.trim();
  if (!configured) return DEFAULT_RETAINED_EVIDENCE_CELLS;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETAINED_EVIDENCE_CELLS;
}

function capturedCellCount(record: EvidenceReadRecord['record'] | undefined): number {
  return record ? record.totalRowCount * Math.max(1, record.columns.length) : 0;
}

/** Same columns, cells and field semantics; only then is a re-issued capture the same evidence. */
function sameCapturedTable(left: CapturedEvidenceTable | undefined, right: CapturedEvidenceTable): boolean {
  // Structural, not serialized: JSON would equate a missing cell with null.
  return Boolean(left) && !left!.unavailableReason && !right.unavailableReason &&
    isDeepStrictEqual([left!.columns, left!.rows, left!.fields], [right.columns, right.rows, right.fields]);
}

export class ArtifactStore {
  private artifacts: Map<string, StoredArtifact> = new Map();
  private readonly executionCaptures = new Map<string, EvidenceReadRecord>();
  private readonly investigationToolObservations = new Map<string, InvestigationToolObservation & {originRunId?: string}>();
  private readonly evidenceStoreId = randomUUID();
  private captureGeneration = 0;
  private counter = 0;
  /** Maximum number of artifacts before LRU eviction. */
  private readonly maxArtifacts: number;
  /** Cumulative cells across retained witnesses; the ledger's real cost. */
  private retainedEvidenceCells = 0;
  private readonly maxRetainedEvidenceCells: number;

  constructor(maxArtifacts = 50) {
    this.maxArtifacts = maxArtifacts;
    this.maxRetainedEvidenceCells = resolveRetainedEvidenceCells();
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
    scopeProvenance?: EvidenceScopeProvenanceV1;
    traceProvenance?: TraceProcessorQueryProvenance;
    queryReview?: QueryReviewV1;
    executionStatus?: DataEnvelopeMeta['executionStatus'];
    executionMessage?: string;
    executionError?: string;
    modelProjection?: ModelEvidenceProjectionStatus;
  }): string {
    const id = `art-${++this.counter}`;
    const now = Date.now();
    const queryReview = sanitizeQueryReview(entry.queryReview);
    this.artifacts.set(id, {
      id,
      ...entry,
      ...scopeMetadata(entry.scopeProvenance),
      queryReview,
      modelProjection: sanitizeModelProjection(entry.modelProjection),
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
      // Evicting a payload frees what the model reads. The execution witness is
      // a separate budget: a conclusion cites evidence produced at any point in
      // the run, and dropping the witness here would make the product report its
      // own bookkeeping loss as an unsupported claim.
      if (oldestId) this.artifacts.delete(oldestId);
      else break;
    }

    return id;
  }

  /** Private runtime witness registration; snapshots and display rows cannot recreate it. */
  registerEvidenceCapture(id: string, witness: EvidenceTableWitness,
    descriptor: {evidenceRefId: string; queryHash?: string; sourceRefs?: readonly string[]; originRunId?: string}): boolean {
    const artifact = this.artifacts.get(id);
    const table = capturedEvidenceTable(witness);
    if (!artifact || !table || !descriptor.evidenceRefId.trim()) return false;
    const envelope = createDataEnvelope({columns: [...table.columns], rows: []}, {
      type: artifact.skillId === 'execute_sql' || artifact.skillId === 'execute_sql_on' ? 'sql_result' : 'skill_result',
      source: artifact.skillId, title: artifact.title || artifact.skillId,
      skillId: artifact.skillId, stepId: artifact.stepId,
      artifactId: id, sourceArtifactId: id, evidenceRefId: descriptor.evidenceRefId,
      sourceToolCallId: artifact.sourceToolCallId, paramsHash: artifact.paramsHash, queryHash: descriptor.queryHash,
      traceId: artifact.traceProvenance?.traceId, traceSide: artifact.traceProvenance?.traceSide,
      paneSide: artifact.traceProvenance?.paneSide, planPhaseId: artifact.planPhaseId,
      executionStatus: artifact.executionStatus || 'observed', executionMessage: artifact.executionMessage,
      executionError: artifact.executionError, scopeProvenance: artifact.scopeProvenance,
      identityResolution: artifact.identityResolution,
      identityRefId: artifact.identityResolution?.identityRefId, identityStatus: artifact.identityResolution?.status,
      identityWarnings: artifact.identityResolution?.warnings,
    });
    this.captureRecord(id, witness, envelope.meta, envelope.display, descriptor.sourceRefs, descriptor.originRunId);
    return true;
  }

  registerStandaloneEvidenceCapture(witness: EvidenceTableWitness,
    descriptor: {meta: DataEnvelopeMeta; display: import('../types/dataContract').DataEnvelope['display']; sourceRefs?: readonly string[]; originRunId?: string}): boolean {
    if (!capturedEvidenceTable(witness) || !descriptor.meta.evidenceRefId) return false;
    // A producer that derives its locator from its content (the run's focus
    // detection) re-issues the same one in a later run. An identical retained
    // capture is kept as it is: its captureId, origin run and every read view
    // already issued stay valid, and the locator stays unique. Different
    // content under one locator is registered beside it and resolves as
    // ambiguous rather than rewriting what an earlier turn cited.
    const table = capturedEvidenceTable(witness)!;
    for (const [key, retained] of this.executionCaptures) {
      if (key.startsWith(STANDALONE_CAPTURE_KEY_PREFIX) && retained.record.meta.evidenceRefId === descriptor.meta.evidenceRefId &&
          retained.record.meta.sourceToolCallId === descriptor.meta.sourceToolCallId &&
          sameCapturedTable(capturedEvidenceTable(retained.witness), table)) return true;
    }
    this.captureRecord(`${STANDALONE_CAPTURE_KEY_PREFIX}${randomUUID()}`, witness, descriptor.meta, descriptor.display, descriptor.sourceRefs, descriptor.originRunId);
    return true;
  }

  private captureRecord(key: string, witness: EvidenceTableWitness, meta: DataEnvelopeMeta,
    display: import('../types/dataContract').DataEnvelope['display'], sourceRefs?: readonly string[], originRunId?: string): void {
    const table = capturedEvidenceTable(witness)!;
    // A run-scoped facade names its run explicitly; an unbound store learns it
    // from the tool invocation the capture is registered inside.
    const invocation = currentRuntimeToolInvocation();
    recordCaptureToolCall(witness, invocation.toolCallId);
    if (!captureOriginRuns.has(witness)) captureOriginRuns.set(witness, originRunId ?? invocation.runId);
    const capturedOriginRunId = captureOriginRuns.get(witness);
    const {queryReview: _reviewOnly, ...capturedMeta} = meta;
    const record = freezeEvidenceValue(structuredClone({
      captureId: witness.captureId, storeId: this.evidenceStoreId, generation: ++this.captureGeneration,
      ...(capturedOriginRunId ? {originRunId: capturedOriginRunId} : {}),
      columns: [...table.columns], totalRowCount: table.rows.length, fields: table.fields,
      meta: {...capturedMeta, ...scopeMetadata(meta.scopeProvenance)}, display,
      ...(sourceRefs ? {sourceRefs: [...sourceRefs]} : {}),
    }));
    // Both sides of the accounting read the stored record, so they cannot drift.
    this.retainedEvidenceCells += capturedCellCount(record) -
      capturedCellCount(this.executionCaptures.get(key)?.record);
    this.executionCaptures.set(key, {witness, record});
    this.evictRetainedEvidence();
  }

  /**
   * The 200-row truncation upstream applies only to what the model sees, and the
   * store is reused across a session's turns, so a handful of unbounded scans
   * can outweigh hundreds of ordinary captures. Oldest goes first, and a single
   * oversized capture is kept rather than evicting itself.
   */
  private evictRetainedEvidence(): void {
    while (this.executionCaptures.size > RETAINED_EVIDENCE_CAPTURE_CEILING ||
      (this.retainedEvidenceCells > this.maxRetainedEvidenceCells && this.executionCaptures.size > 1)) {
      const oldest = this.executionCaptures.keys().next().value!;
      this.retainedEvidenceCells -= capturedCellCount(this.executionCaptures.get(oldest)?.record);
      this.executionCaptures.delete(oldest);
    }
  }

  createEvidenceReadView(options: EvidenceReadViewOptions): EvidenceReadView {
    const admitted = new Set(this.executionCaptures.values());
    const observations = [...this.investigationToolObservations.values()];
    return createEvidenceReadView(() => [...this.executionCaptures.values()].filter(record => admitted.has(record)), options, () => observations);
  }

  /** Shared admitted-tool observer; records no payload or model-authored success claims. */
  observeInvestigationTool(event: RuntimeToolInvocationEvent, explicitRunId?: string): void {
    const originRunId = explicitRunId ?? currentRuntimeToolInvocation().runId;
    this.investigationToolObservations.set(`${originRunId || ''}:${event.toolCallId}`,
      {...captureInvestigationToolObservation(event), ...(originRunId ? {originRunId} : {})});
    while (this.investigationToolObservations.size > 4096) {
      this.investigationToolObservations.delete(this.investigationToolObservations.keys().next().value!);
    }
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
    const columnUnits = projectEvidenceColumnUnitsForModel(data, this.executionCaptures.get(id)?.witness);

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
      ...scopeMetadata(artifact.scopeProvenance),
      ...(artifact.traceProvenance?.traceSide ? { traceSide: artifact.traceProvenance.traceSide } : {}),
      ...(artifact.traceProvenance?.paneSide ? { paneSide: artifact.traceProvenance.paneSide } : {}),
      ...(artifact.traceProvenance?.traceId ? { traceId: artifact.traceProvenance.traceId } : {}),
      ...(artifact.queryReview ? {queryReview: queryReviewRefForArtifact(artifact.queryReview)} : {}),
      ...(artifact.executionStatus ? { executionStatus: artifact.executionStatus } : {}),
      ...(artifact.executionMessage ? { executionMessage: artifact.executionMessage } : {}),
      ...(artifact.executionError ? { executionError: artifact.executionError } : {}),
      ...(artifact.modelProjection ? {modelProjection: artifact.modelProjection} : {}),
      ...(columnUnits ? {columnUnits} : {}),
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
      const sampleRow = full.sampleRow;
      preview = Object.fromEntries(full.columns.map((column, i) => [column, i < sampleRow.length ? sampleRow[i] : null]));
    }

    return {
      id: full.id,
      ...scopeMetadata(artifact?.scopeProvenance),
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
      ...(artifact?.modelProjection ? {modelProjection: artifact.modelProjection} : {}),
      ...(full.columnUnits ? {columnUnits: full.columnUnits} : {}),
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
        const columnUnits = projectEvidenceColumnUnitsForModel(artifact.data, this.executionCaptures.get(id)?.witness);
        const allRows: any[][] = artifact.data?.rows || [];
        const totalRows = allRows.length;
        const effectiveOffset = offset ?? 0;
        const effectiveLimit = limit ?? ArtifactStore.DEFAULT_PAGE_SIZE;
        const pagedRows = allRows.slice(effectiveOffset, effectiveOffset + effectiveLimit);
        const hasMore = effectiveOffset + effectiveLimit < totalRows;
        return {
          id: artifact.id,
          columns: artifact.data?.columns || [],
          rowShape: INDEXED_ROW_SHAPE,
          rows: indexEvidenceRows(pagedRows, effectiveOffset),
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
      ...scopeMetadata(artifact.scopeProvenance),
          traceSide: artifact.traceProvenance?.traceSide,
          paneSide: artifact.traceProvenance?.paneSide,
          traceId: artifact.traceProvenance?.traceId,
          traceProvenance: artifact.traceProvenance,
          executionStatus: artifact.executionStatus,
          executionMessage: artifact.executionMessage,
          executionError: artifact.executionError,
          modelProjection: artifact.modelProjection,
          ...(columnUnits ? {columnUnits} : {}),
          ...(artifact.queryReview ? {queryReview: queryReviewRefForArtifact(artifact.queryReview)} : {}),
        };
      }
      case 'full': {
        const columnUnits = projectEvidenceColumnUnitsForModel(artifact.data, this.executionCaptures.get(id)?.witness);
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
      ...scopeMetadata(artifact.scopeProvenance),
          traceSide: artifact.traceProvenance?.traceSide,
          paneSide: artifact.traceProvenance?.paneSide,
          traceId: artifact.traceProvenance?.traceId,
          traceProvenance: artifact.traceProvenance,
          queryReview: artifact.queryReview,
          executionStatus: artifact.executionStatus,
          executionMessage: artifact.executionMessage,
          executionError: artifact.executionError,
          modelProjection: artifact.modelProjection,
          ...(columnUnits ? {columnUnits} : {}),
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
      const { appliedProcessScope: _legacyScope, evidenceRole: _legacyRole, ...stored } = art;
      store.artifacts.set(art.id, { ...stored, ...scopeMetadata(art.scopeProvenance),
        modelProjection: sanitizeModelProjection(art.modelProjection) });
      const num = parseInt(art.id.replace('art-', ''), 10) || 0;
      if (num > store.counter) store.counter = num;
    }
    return store;
  }

  /** Clear all artifacts (e.g., on session reset). */
  clear(): void {
    this.artifacts.clear();
    this.executionCaptures.clear();
    this.retainedEvidenceCells = 0;
    this.investigationToolObservations.clear();
    this.counter = 0;
  }
}
