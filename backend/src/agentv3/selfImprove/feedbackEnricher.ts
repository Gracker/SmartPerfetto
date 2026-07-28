// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Feedback validation + reverse-lookup helper.
 *
 * Pure functions so the logic can be unit-tested without HTTP plumbing.
 * Persisted entries are versioned via `schemaVersion` so consumers can evolve
 * the structure without breaking older JSONL lines.
 *
 * See docs/architecture/self-improving-design.md "Failure taxonomy 与证据边界".
 */

import {
  FEEDBACK_EVENT_KINDS,
  FEEDBACK_NEGATIVE_DIMENSIONS,
  FEEDBACK_POSITIVE_DIMENSIONS,
  FEEDBACK_SOURCES,
  FEEDBACK_TARGET_KINDS,
  type FeedbackDimension,
  type FeedbackEventKind,
  type FeedbackSource,
  type FeedbackTargetKind,
} from '../../types/selfEvolution';

const MAX_COMMENT_CHARS = 500;
const MAX_TRACE_ID_CHARS = 200;
const MAX_SCENE_TYPE_CHARS = 50;
const MAX_ARCHITECTURE_CHARS = 50;
const MAX_PACKAGE_NAME_CHARS = 200;
const MAX_PATTERN_ID_CHARS = 100;
const MAX_CASE_CANDIDATE_ID_CHARS = 120;
const MAX_FINDING_ID_CHARS = 100;
const MAX_FINDING_IDS_LENGTH = 20;
const MAX_EVENT_ID_CHARS = 160;
const MAX_FEEDBACK_ID_CHARS = 160;
const MAX_IDEMPOTENCY_KEY_CHARS = 240;
const MAX_RUN_ID_CHARS = 200;
const MAX_TARGET_ID_CHARS = 240;
const MAX_DIMENSIONS_LENGTH = 12;
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Schema accepted at POST /api/agent/v1/:sessionId/feedback.
 *
 * Backward-compatible: original clients (rating/comment/turnIndex only) keep working.
 * New clients may attach metadata that the backend would otherwise have to reverse-look up.
 */
export interface FeedbackInputSchema {
  rating?: 'positive' | 'negative';
  comment?: string;
  turnIndex?: number;
  traceId?: string;
  sceneType?: string;
  architecture?: string;
  packageName?: string;
  findingIds?: string[];
  patternId?: string;
  caseCandidateId?: string;
  caseCandidateSurfacedAt?: number;
  eventKind?: FeedbackEventKind;
  feedbackId?: string;
  supersedesEventId?: string;
  idempotencyKey?: string;
  runId?: string;
  targetKind?: FeedbackTargetKind;
  targetId?: string;
  dimensions?: FeedbackDimension[];
  source?: FeedbackSource;
  schemaVersion?: number;
}

/**
 * Subset of in-memory session state needed for reverse lookup.
 *
 * Decoupled from `AnalysisSession` so the enricher stays pure and so future
 * lookup sources (SessionStateSnapshot, persistence layer) can satisfy the same
 * shape without dragging in their full type surface.
 */
export interface SessionLookup {
  traceId?: string;
  referenceTraceId?: string;
}

export interface EnrichedFeedbackEntry {
  schemaVersion: 1;
  sessionId: string;
  rating: 'positive' | 'negative';
  comment?: string;
  turnIndex?: number;
  traceId?: string;
  referenceTraceId?: string;
  sceneType?: string;
  architecture?: string;
  packageName?: string;
  findingIds?: string[];
  patternId?: string;
  caseCandidateId?: string;
  caseCandidateSurfacedAt?: number;
  timestamp: string;
  /** True when at least one field was filled by reverse lookup rather than the client body. */
  enrichedFromSession: boolean;
}

export type ValidationResult =
  | { ok: true; value: FeedbackInputSchema }
  | { ok: false; error: string };

type StringFieldKey =
  | 'comment'
  | 'traceId'
  | 'sceneType'
  | 'architecture'
  | 'packageName'
  | 'patternId'
  | 'caseCandidateId'
  | 'feedbackId'
  | 'supersedesEventId'
  | 'idempotencyKey'
  | 'runId'
  | 'targetId';

const STRING_FIELDS: ReadonlyArray<{ key: StringFieldKey; max: number }> = [
  { key: 'comment', max: MAX_COMMENT_CHARS },
  { key: 'traceId', max: MAX_TRACE_ID_CHARS },
  { key: 'sceneType', max: MAX_SCENE_TYPE_CHARS },
  { key: 'architecture', max: MAX_ARCHITECTURE_CHARS },
  { key: 'packageName', max: MAX_PACKAGE_NAME_CHARS },
  { key: 'patternId', max: MAX_PATTERN_ID_CHARS },
  { key: 'caseCandidateId', max: MAX_CASE_CANDIDATE_ID_CHARS },
  { key: 'feedbackId', max: MAX_FEEDBACK_ID_CHARS },
  { key: 'supersedesEventId', max: MAX_EVENT_ID_CHARS },
  { key: 'idempotencyKey', max: MAX_IDEMPOTENCY_KEY_CHARS },
  { key: 'runId', max: MAX_RUN_ID_CHARS },
  { key: 'targetId', max: MAX_TARGET_ID_CHARS },
];

const EVENT_KINDS = new Set<string>(FEEDBACK_EVENT_KINDS);
const TARGET_KINDS = new Set<string>(FEEDBACK_TARGET_KINDS);
const SOURCES = new Set<string>(FEEDBACK_SOURCES);
const DIMENSIONS = new Set<string>([
  ...FEEDBACK_NEGATIVE_DIMENSIONS,
  ...FEEDBACK_POSITIVE_DIMENSIONS,
]);
const NEGATIVE_DIMENSIONS = new Set<string>(FEEDBACK_NEGATIVE_DIMENSIONS);
const POSITIVE_DIMENSIONS = new Set<string>(FEEDBACK_POSITIVE_DIMENSIONS);

/**
 * Validate the raw HTTP body and produce a sanitized FeedbackInputSchema.
 *
 * Truncates over-long string fields rather than rejecting — matches the
 * existing `comment.substring(0, 500)` convention in agentRoutes.ts. Hard-rejects
 * only for type errors and unknown rating / schemaVersion values.
 */
export function validateFeedbackInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;

  if (raw.schemaVersion !== undefined) {
    if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `unsupported schemaVersion (got ${String(raw.schemaVersion)}, expected ${SUPPORTED_SCHEMA_VERSION})`,
      };
    }
  }

  const eventKind = raw.eventKind ?? 'created';
  if (typeof eventKind !== 'string' || !EVENT_KINDS.has(eventKind)) {
    return {ok: false, error: 'eventKind must be "created", "replaced", or "retracted"'};
  }

  if (eventKind === 'retracted') {
    if (raw.rating !== undefined || raw.dimensions !== undefined) {
      return {ok: false, error: 'retracted feedback must not include rating or dimensions'};
    }
  } else if (raw.rating !== 'positive' && raw.rating !== 'negative') {
    return { ok: false, error: 'rating must be "positive" or "negative"' };
  }

  const value: FeedbackInputSchema = {
    ...(raw.rating === 'positive' || raw.rating === 'negative'
      ? {rating: raw.rating}
      : {}),
    eventKind: eventKind as FeedbackEventKind,
  };

  for (const { key, max } of STRING_FIELDS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return { ok: false, error: `${key} must be a string` };
    }
    value[key] = v.substring(0, max);
  }

  if (raw.turnIndex !== undefined) {
    if (typeof raw.turnIndex !== 'number' || !Number.isFinite(raw.turnIndex) || raw.turnIndex < 0) {
      return { ok: false, error: 'turnIndex must be a non-negative finite number' };
    }
    value.turnIndex = Math.floor(raw.turnIndex);
  }

  if (raw.caseCandidateSurfacedAt !== undefined) {
    if (
      typeof raw.caseCandidateSurfacedAt !== 'number' ||
      !Number.isFinite(raw.caseCandidateSurfacedAt) ||
      raw.caseCandidateSurfacedAt < 0
    ) {
      return { ok: false, error: 'caseCandidateSurfacedAt must be a non-negative finite number' };
    }
    value.caseCandidateSurfacedAt = Math.floor(raw.caseCandidateSurfacedAt);
  }

  if (raw.findingIds !== undefined) {
    if (!Array.isArray(raw.findingIds)) {
      return { ok: false, error: 'findingIds must be an array' };
    }
    const cleaned: string[] = [];
    for (const id of raw.findingIds) {
      if (typeof id !== 'string') {
        return { ok: false, error: 'findingIds entries must be strings' };
      }
      cleaned.push(id.substring(0, MAX_FINDING_ID_CHARS));
      if (cleaned.length >= MAX_FINDING_IDS_LENGTH) break;
    }
    value.findingIds = cleaned;
  }

  if (raw.targetKind !== undefined) {
    if (typeof raw.targetKind !== 'string' || !TARGET_KINDS.has(raw.targetKind)) {
      return {ok: false, error: 'targetKind is not supported'};
    }
    value.targetKind = raw.targetKind as FeedbackTargetKind;
  }

  if (raw.source !== undefined) {
    if (typeof raw.source !== 'string' || !SOURCES.has(raw.source)) {
      return {ok: false, error: 'source must be "ui", "cli", or "api"'};
    }
    value.source = raw.source as FeedbackSource;
  }

  if (raw.dimensions !== undefined) {
    if (!Array.isArray(raw.dimensions)) {
      return {ok: false, error: 'dimensions must be an array'};
    }
    const dimensions: FeedbackDimension[] = [];
    for (const dimension of raw.dimensions) {
      if (typeof dimension !== 'string' || !DIMENSIONS.has(dimension)) {
        return {ok: false, error: `unsupported feedback dimension: ${String(dimension)}`};
      }
      if (!dimensions.includes(dimension as FeedbackDimension)) {
        dimensions.push(dimension as FeedbackDimension);
      }
      if (dimensions.length >= MAX_DIMENSIONS_LENGTH) break;
    }
    value.dimensions = dimensions;
  }

  if (eventKind !== 'created') {
    if (!value.feedbackId || !value.supersedesEventId) {
      return {
        ok: false,
        error: `${eventKind} feedback requires feedbackId and supersedesEventId`,
      };
    }
  } else {
    if (value.feedbackId) {
      return {ok: false, error: 'created feedbackId is server-assigned'};
    }
    if (value.supersedesEventId) {
      return {ok: false, error: 'created feedback must not include supersedesEventId'};
    }
  }

  if (
    value.rating &&
    value.dimensions?.some(dimension =>
      value.rating === 'positive'
        ? !POSITIVE_DIMENSIONS.has(dimension)
        : !NEGATIVE_DIMENSIONS.has(dimension))
  ) {
    return {
      ok: false,
      error: `dimensions must match ${value.rating} feedback`,
    };
  }

  return { ok: true, value };
}

/**
 * Combine validated client input with best-effort reverse lookup from in-memory
 * session state. When the session has been cleaned up (after 30 min idle) the
 * lookup fields stay undefined — callers can later supplement from durable
 * snapshots if needed.
 */
export function enrichFeedbackEntry(
  sessionId: string,
  input: FeedbackInputSchema,
  session: SessionLookup | null,
  now: Date = new Date(),
): EnrichedFeedbackEntry {
  if (!input.rating) {
    throw new Error('feedback_rating_required_for_enrichment');
  }
  let enrichedFromSession = false;

  let traceId = input.traceId;
  if (!traceId && session?.traceId) {
    traceId = session.traceId.substring(0, MAX_TRACE_ID_CHARS);
    enrichedFromSession = true;
  }

  let referenceTraceId: string | undefined;
  if (session?.referenceTraceId) {
    referenceTraceId = session.referenceTraceId.substring(0, MAX_TRACE_ID_CHARS);
    enrichedFromSession = true;
  }

  const entry: EnrichedFeedbackEntry = {
    schemaVersion: 1,
    sessionId,
    rating: input.rating,
    timestamp: now.toISOString(),
    enrichedFromSession,
  };

  if (input.comment !== undefined) entry.comment = input.comment;
  if (input.turnIndex !== undefined) entry.turnIndex = input.turnIndex;
  if (traceId) entry.traceId = traceId;
  if (referenceTraceId) entry.referenceTraceId = referenceTraceId;
  if (input.sceneType) entry.sceneType = input.sceneType;
  if (input.architecture) entry.architecture = input.architecture;
  if (input.packageName) entry.packageName = input.packageName;
  if (input.findingIds && input.findingIds.length > 0) entry.findingIds = input.findingIds;
  if (input.patternId) entry.patternId = input.patternId;
  if (input.caseCandidateId) entry.caseCandidateId = input.caseCandidateId;
  if (input.caseCandidateSurfacedAt !== undefined) entry.caseCandidateSurfacedAt = input.caseCandidateSurfacedAt;

  return entry;
}
