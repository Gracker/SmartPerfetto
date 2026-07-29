// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {backendLogPath, userDataPath} from '../../runtimePaths';
import type {
  AppendFeedbackEventInput,
  AppendFeedbackEventResult,
  EffectiveFeedbackV1,
  FeedbackDimension,
  FeedbackEventV1,
  FeedbackTargetKind,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  FEEDBACK_EVENT_KINDS,
  FEEDBACK_NEGATIVE_DIMENSIONS,
  FEEDBACK_POSITIVE_DIMENSIONS,
  FEEDBACK_SOURCES,
  FEEDBACK_TARGET_KINDS,
} from '../../types/selfEvolution';
import {withFilesystemRegistryLockAsync} from '../filesystemRegistryLock';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';

export interface FeedbackEventStoreOptions {
  scope: RunManifestScope;
  eventLogPath?: string;
  databasePath?: string;
  storage?: AppendFeedbackEventResult['storage'];
  visibility?: FeedbackStoreVisibility;
}

export type FeedbackStoreVisibility = 'public_scoped' | 'private_local';
export type FeedbackStoreDurability = 'durable' | 'temporary';

export interface FeedbackStoreProvenance {
  visibility: FeedbackStoreVisibility;
  durability: FeedbackStoreDurability;
}

export interface FeedbackProjectionTarget {
  targetKind: FeedbackTargetKind;
  targetId: string;
  revision: number;
}

export interface LegacyCandidateFeedbackImport {
  sourceRowId: number;
  candidateId: string;
  sourceSessionId: string;
  sourceAnalysisRunId?: string;
  rating: 'positive' | 'negative';
  receivedAt: number;
}

interface IndexedEventRow {
  eventId: string;
  feedbackId: string;
  eventJson: string;
  commandFingerprint: string | null;
  legacy: number;
}

interface EffectiveFeedbackRow {
  feedback_id: string;
  current_event_id: string;
  sequence: number | null;
  legacy: number;
  run_id: string | null;
  run_manifest_id: string | null;
  session_id: string;
  rating: 'positive' | 'negative';
  dimensions_json: string;
  comment: string | null;
  target_kind: FeedbackTargetKind;
  target_id: string;
  pattern_id: string | null;
  case_candidate_id: string | null;
  source: EffectiveFeedbackV1['source'];
  actor_json: string;
  timestamp: string;
}

const EVENT_SCHEMA_VERSION = 1;
const LEGACY_SOURCE = 'api';
const MAX_COMMENT_CHARS = 500;
const NEGATIVE_DIMENSIONS = new Set<FeedbackDimension>(
  FEEDBACK_NEGATIVE_DIMENSIONS,
);
const POSITIVE_DIMENSIONS = new Set<FeedbackDimension>(
  FEEDBACK_POSITIVE_DIMENSIONS,
);
const EVENT_KINDS = new Set<string>(FEEDBACK_EVENT_KINDS);
const SOURCES = new Set<string>(FEEDBACK_SOURCES);
const TARGET_KINDS = new Set<string>(FEEDBACK_TARGET_KINDS);

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function checksumForEvent(event: Omit<FeedbackEventV1, 'checksum'>): string {
  return canonicalContentHash(event);
}

function normalizedCommand(input: AppendFeedbackEventInput): Record<string, unknown> {
  return {
    kind: input.kind,
    ...(input.kind !== 'created' && input.feedbackId
      ? {feedbackId: input.feedbackId}
      : {}),
    ...(input.supersedesEventId
      ? {supersedesEventId: input.supersedesEventId}
      : {}),
    idempotencyKey: input.idempotencyKey,
    runId: input.runId,
    ...(input.runManifestId ? {runManifestId: input.runManifestId} : {}),
    sessionId: input.sessionId,
    ...(input.rating ? {rating: input.rating} : {}),
    ...(input.dimensions && input.dimensions.length > 0
      ? {dimensions: [...input.dimensions]}
      : {}),
    ...(input.comment !== undefined ? {comment: input.comment} : {}),
    targetKind: input.targetKind,
    targetId: eventTargetId(input),
    ...(input.patternId ? {patternId: input.patternId} : {}),
    ...(input.caseCandidateId
      ? {caseCandidateId: input.caseCandidateId}
      : {}),
    source: input.source,
    actor: {...input.actor},
    scope: {...input.scope},
  };
}

function commandFingerprint(input: AppendFeedbackEventInput): string {
  return canonicalContentHash(normalizedCommand(input));
}

function eventTargetId(input: {
  targetKind: FeedbackTargetKind;
  targetId?: string;
  patternId?: string;
  caseCandidateId?: string;
  sessionId: string;
}): string {
  if (input.targetKind === 'pattern') {
    const patternId = input.patternId ?? input.targetId;
    if (!patternId) throw new Error('feedback_pattern_target_required');
    if (input.targetId && input.targetId !== patternId) {
      throw new Error('feedback_pattern_target_mismatch');
    }
    return patternId;
  }
  if (input.targetKind === 'case_candidate') {
    const candidateId = input.caseCandidateId ?? input.targetId;
    if (!candidateId) throw new Error('feedback_case_candidate_target_required');
    if (input.targetId && input.targetId !== candidateId) {
      throw new Error('feedback_case_candidate_target_mismatch');
    }
    return candidateId;
  }
  if (input.targetKind === 'session') {
    if (input.targetId && input.targetId !== input.sessionId) {
      throw new Error('feedback_session_target_mismatch');
    }
    return input.sessionId;
  }
  if (!input.targetId) throw new Error('feedback_target_id_required');
  return input.targetId;
}

function looksLikeFeedbackEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return 'eventId' in event ||
    'feedbackId' in event ||
    'sequence' in event ||
    'checksum' in event ||
    'idempotencyKey' in event ||
    'kind' in event;
}

function assertNonemptyString(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
}

function assertFeedbackEvent(value: unknown): asserts value is FeedbackEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('feedback_event_invalid');
  }
  const event = value as Partial<FeedbackEventV1>;
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new Error('feedback_schema_version_invalid');
  }
  assertNonemptyString(event.eventId, 'feedback_event_id_invalid');
  assertNonemptyString(event.feedbackId, 'feedback_id_invalid');
  if (!Number.isSafeInteger(event.sequence) || event.sequence! <= 0) {
    throw new Error('feedback_sequence_invalid');
  }
  assertNonemptyString(event.checksum, 'feedback_checksum_invalid');
  assertNonemptyString(event.idempotencyKey, 'feedback_idempotency_key_required');
  if (!EVENT_KINDS.has(String(event.kind))) {
    throw new Error('feedback_event_kind_invalid');
  }
  assertNonemptyString(event.runId, 'feedback_run_id_invalid');
  if (event.runManifestId !== undefined) {
    assertNonemptyString(
      event.runManifestId,
      'feedback_run_manifest_id_invalid',
    );
  }
  assertNonemptyString(event.sessionId, 'feedback_session_id_invalid');
  if (!TARGET_KINDS.has(String(event.targetKind))) {
    throw new Error('feedback_target_kind_invalid');
  }
  if (event.targetId !== undefined) {
    assertNonemptyString(event.targetId, 'feedback_target_id_invalid');
  }
  if (event.patternId !== undefined) {
    assertNonemptyString(event.patternId, 'feedback_pattern_target_required');
  }
  if (event.caseCandidateId !== undefined) {
    assertNonemptyString(
      event.caseCandidateId,
      'feedback_case_candidate_target_required',
    );
  }
  if (!SOURCES.has(String(event.source))) {
    throw new Error('feedback_source_invalid');
  }
  if (
    !event.actor ||
    typeof event.actor !== 'object' ||
    Array.isArray(event.actor)
  ) {
    throw new Error('feedback_actor_invalid');
  }
  if (
    event.actor.userId !== undefined &&
    (typeof event.actor.userId !== 'string' || !event.actor.userId.trim())
  ) {
    throw new Error('feedback_actor_invalid');
  }
  if (
    event.actor.permissionSnapshot !== undefined &&
    typeof event.actor.permissionSnapshot !== 'string'
  ) {
    throw new Error('feedback_actor_invalid');
  }
  if (
    !event.scope ||
    typeof event.scope !== 'object' ||
    Array.isArray(event.scope)
  ) {
    throw new Error('feedback_scope_invalid');
  }
  assertNonemptyString(event.scope.tenantId, 'feedback_scope_invalid');
  assertNonemptyString(event.scope.workspaceId, 'feedback_scope_invalid');
  assertNonemptyString(event.timestamp, 'feedback_timestamp_invalid');
  if (!Number.isFinite(Date.parse(event.timestamp))) {
    throw new Error('feedback_timestamp_invalid');
  }
  if (event.comment !== undefined) {
    if (typeof event.comment !== 'string') {
      throw new Error('feedback_comment_invalid');
    }
    if (event.comment.length > MAX_COMMENT_CHARS) {
      throw new Error('feedback_comment_too_long');
    }
  }
  if (event.dimensions !== undefined) {
    if (!Array.isArray(event.dimensions)) {
      throw new Error('feedback_dimensions_invalid');
    }
    for (const dimension of event.dimensions) {
      if (
        !NEGATIVE_DIMENSIONS.has(dimension) &&
        !POSITIVE_DIMENSIONS.has(dimension)
      ) {
        throw new Error('feedback_dimension_invalid');
      }
    }
  }
  if (event.kind === 'created') {
    if (event.supersedesEventId) {
      throw new Error('feedback_created_must_not_supersede');
    }
    if (event.rating !== 'positive' && event.rating !== 'negative') {
      throw new Error('feedback_rating_required');
    }
  } else {
    assertNonemptyString(
      event.supersedesEventId,
      'feedback_supersedes_required',
    );
    if (event.kind === 'retracted') {
      if (event.rating !== undefined || event.dimensions !== undefined) {
        throw new Error('feedback_retracted_payload_forbidden');
      }
    } else if (event.rating !== 'positive' && event.rating !== 'negative') {
      throw new Error('feedback_rating_required');
    }
  }
  if (
    event.rating &&
    event.dimensions?.some(dimension =>
      event.rating === 'positive'
        ? !POSITIVE_DIMENSIONS.has(dimension)
        : !NEGATIVE_DIMENSIONS.has(dimension))
  ) {
    throw new Error('feedback_dimension_rating_mismatch');
  }
  eventTargetId(event as FeedbackEventV1);
}

function parseEffectiveRow(row: EffectiveFeedbackRow): EffectiveFeedbackV1 {
  return {
    feedbackId: row.feedback_id,
    currentEventId: row.current_event_id,
    sequence: row.sequence,
    legacy: row.legacy === 1,
    ...(row.run_id ? {runId: row.run_id} : {}),
    ...(row.run_manifest_id ? {runManifestId: row.run_manifest_id} : {}),
    sessionId: row.session_id,
    rating: row.rating,
    dimensions: JSON.parse(row.dimensions_json) as FeedbackDimension[],
    ...(row.comment !== null ? {comment: row.comment} : {}),
    targetKind: row.target_kind,
    targetId: row.target_id,
    ...(row.pattern_id ? {patternId: row.pattern_id} : {}),
    ...(row.case_candidate_id
      ? {caseCandidateId: row.case_candidate_id}
      : {}),
    source: row.source,
    actor: JSON.parse(row.actor_json) as EffectiveFeedbackV1['actor'],
    scope: {
      tenantId: '',
      workspaceId: '',
    },
    timestamp: row.timestamp,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128) || '_';
}

export function publicFeedbackLogPath(scope: RunManifestScope): string {
  return backendLogPath(
    'feedback',
    safeSegment(scope.tenantId),
    safeSegment(scope.workspaceId),
    'feedback.jsonl',
  );
}

export function publicFeedbackIndexPath(): string {
  return userDataPath('self_improve', 'feedback_index.db');
}

export function privateFeedbackStorePaths(input: {
  scope: RunManifestScope;
  userId: string;
  durable: boolean;
}): {
  eventLogPath: string;
  databasePath: string;
  storage: AppendFeedbackEventResult['storage'];
  visibility: 'private_local';
} {
  const segments = [
    safeSegment(input.scope.tenantId),
    safeSegment(input.scope.workspaceId),
    safeSegment(input.userId),
  ];
  const root = input.durable
    ? userDataPath('self_improve', 'private_feedback', ...segments)
    : path.join(
        os.tmpdir(),
        'SmartPerfetto',
        'private_feedback',
        hashText(segments.join('\0')).slice(0, 24),
      );
  return {
    eventLogPath: path.join(root, 'feedback.jsonl'),
    databasePath: path.join(root, 'feedback_index.db'),
    storage: input.durable ? 'durable' : 'temporary_private',
    visibility: 'private_local',
  };
}

export class FeedbackEventStore {
  private readonly scope!: RunManifestScope;
  private readonly eventLogPath!: string;
  private readonly databasePath!: string;
  private readonly storage!: AppendFeedbackEventResult['storage'];
  readonly provenance!: FeedbackStoreProvenance;
  private database: Database.Database | undefined;

  constructor(options: FeedbackEventStoreOptions) {
    const storage = options.storage ?? 'durable';
    const provenance = Object.freeze({
      visibility: options.visibility ?? 'public_scoped',
      durability: storage === 'durable' ? 'durable' : 'temporary',
    });
    Object.defineProperties(this, {
      scope: immutableProperty(Object.freeze({...options.scope})),
      eventLogPath: immutableProperty(
        options.eventLogPath ?? publicFeedbackLogPath(options.scope),
      ),
      databasePath: immutableProperty(
        options.databasePath ?? publicFeedbackIndexPath(),
      ),
      storage: immutableProperty(storage),
      provenance: immutableProperty(provenance),
    });
  }

  async append(input: AppendFeedbackEventInput): Promise<AppendFeedbackEventResult> {
    this.validateInput(input);
    return withFilesystemRegistryLockAsync(
      this.eventLogPath,
      'feedback_event_store_busy',
      async lease => {
        lease.assertHeld();
        this.catchUpLocked();
        const fingerprint = commandFingerprint(input);
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          if (existing.commandFingerprint !== fingerprint) {
            throw new Error('feedback_idempotency_conflict');
          }
          if (existing.legacy === 1) {
            throw new Error('feedback_idempotency_conflict');
          }
          return {
            event: JSON.parse(existing.eventJson) as FeedbackEventV1,
            idempotent: true,
            storage: this.storage,
          };
        }

        this.validateTransition(input);
        const sequence = this.nextSequence();
        const targetId = eventTargetId(input);
        const eventWithoutChecksum: Omit<FeedbackEventV1, 'checksum'> = {
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId: randomUUID(),
          feedbackId: input.feedbackId ?? randomUUID(),
          ...(input.supersedesEventId
            ? {supersedesEventId: input.supersedesEventId}
            : {}),
          sequence,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          runId: input.runId,
          ...(input.runManifestId ? {runManifestId: input.runManifestId} : {}),
          sessionId: input.sessionId,
          ...(input.rating ? {rating: input.rating} : {}),
          ...(input.dimensions && input.dimensions.length > 0
            ? {dimensions: [...input.dimensions]}
            : {}),
          ...(input.comment !== undefined ? {comment: input.comment} : {}),
          targetKind: input.targetKind,
          targetId,
          ...(input.patternId ? {patternId: input.patternId} : {}),
          ...(input.caseCandidateId
            ? {caseCandidateId: input.caseCandidateId}
            : {}),
          source: input.source,
          actor: {...input.actor},
          scope: {...input.scope},
          timestamp: input.timestamp ?? new Date().toISOString(),
        };
        const event: FeedbackEventV1 = {
          ...eventWithoutChecksum,
          checksum: checksumForEvent(eventWithoutChecksum),
        };
        this.appendLine(canonicalJsonString(event));
        lease.assertHeld();
        this.catchUpLocked(new Map([[event.eventId, fingerprint]]));
        return {event, idempotent: false, storage: this.storage};
      },
    );
  }

  async importAcceptedLegacyCandidateFeedback(
    records: readonly LegacyCandidateFeedbackImport[],
  ): Promise<number> {
    return withFilesystemRegistryLockAsync(
      this.eventLogPath,
      'feedback_event_store_busy',
      async lease => {
        lease.assertHeld();
        this.catchUpLocked();
        let imported = 0;
        for (const record of records) {
          if (
            !Number.isSafeInteger(record.sourceRowId) ||
            record.sourceRowId <= 0 ||
            !record.candidateId.trim() ||
            !record.sourceSessionId.trim() ||
            !Number.isFinite(record.receivedAt)
          ) {
            throw new Error('legacy_candidate_feedback_import_invalid');
          }
          const timestamp = new Date(record.receivedAt).toISOString();
          const line = canonicalJsonString({
            legacyCandidateFeedbackAccepted: true,
            legacySourceRowId: record.sourceRowId,
            sessionId: record.sourceSessionId,
            ...(record.sourceAnalysisRunId
              ? {runId: record.sourceAnalysisRunId}
              : {}),
            rating: record.rating,
            caseCandidateId: record.candidateId,
            timestamp,
            storageScope: {...this.scope},
          });
          const eventId = `legacy:${hashText(
            `${scopeKey(this.scope)}\0${line}`,
          )}`;
          const existing = this.db().prepare(`
            SELECT 1 FROM feedback_event_index WHERE event_id = ?
          `).get(eventId);
          if (existing) continue;
          this.appendLine(line);
          imported += 1;
        }
        lease.assertHeld();
        this.catchUpLocked();
        return imported;
      },
    );
  }

  catchUp(): void {
    this.catchUpLocked();
  }

  rebuild(): void {
    const database = this.db();
    database.transaction(() => {
      database.prepare(`
        DELETE FROM effective_feedback
        WHERE tenant_id = ? AND workspace_id = ?
      `).run(this.scope.tenantId, this.scope.workspaceId);
      database.prepare(`
        DELETE FROM feedback_projection_targets
        WHERE tenant_id = ? AND workspace_id = ?
      `).run(this.scope.tenantId, this.scope.workspaceId);
      database.prepare(`
        DELETE FROM feedback_event_index
        WHERE tenant_id = ? AND workspace_id = ?
      `).run(this.scope.tenantId, this.scope.workspaceId);
      database.prepare(`
        DELETE FROM feedback_projection_offsets
        WHERE tenant_id = ? AND workspace_id = ? AND log_path = ?
      `).run(
        this.scope.tenantId,
        this.scope.workspaceId,
        this.eventLogPath,
      );
    })();
    this.catchUpLocked();
  }

  getEffectiveForTarget(
    targetKind: FeedbackTargetKind,
    targetId: string,
  ): EffectiveFeedbackV1[] {
    const rows = this.db().prepare(`
      SELECT *
      FROM effective_feedback
      WHERE tenant_id = ? AND workspace_id = ?
        AND target_kind = ? AND target_id = ?
      ORDER BY COALESCE(sequence, -1), event_index_id, feedback_id
    `).all(
      this.scope.tenantId,
      this.scope.workspaceId,
      targetKind,
      targetId,
    ) as EffectiveFeedbackRow[];
    return rows.map(row => ({
      ...parseEffectiveRow(row),
      scope: {...this.scope},
    }));
  }

  listDirtyTargets(): FeedbackProjectionTarget[] {
    return this.db().prepare(`
      SELECT
        target_kind AS targetKind,
        target_id AS targetId,
        revision
      FROM feedback_projection_targets
      WHERE tenant_id = ? AND workspace_id = ?
        AND (applied_revision IS NULL OR applied_revision < revision)
      ORDER BY revision, target_kind, target_id
    `).all(
      this.scope.tenantId,
      this.scope.workspaceId,
    ) as FeedbackProjectionTarget[];
  }

  markTargetApplied(target: FeedbackProjectionTarget): boolean {
    const result = this.db().prepare(`
      UPDATE feedback_projection_targets
      SET applied_revision = ?
      WHERE tenant_id = ? AND workspace_id = ?
        AND target_kind = ? AND target_id = ?
        AND revision = ?
    `).run(
      target.revision,
      this.scope.tenantId,
      this.scope.workspaceId,
      target.targetKind,
      target.targetId,
      target.revision,
    );
    return result.changes === 1;
  }

  effectiveStats(targetKind?: FeedbackTargetKind): {
    totalPositive: number;
    totalNegative: number;
    distinctSessions: number;
  } {
    const row = this.db().prepare(`
      SELECT
        SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS totalPositive,
        SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS totalNegative,
        COUNT(DISTINCT session_id) AS distinctSessions
      FROM effective_feedback
      WHERE tenant_id = ? AND workspace_id = ?
        AND (? IS NULL OR target_kind = ?)
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
      targetKind ?? null,
      targetKind ?? null,
    ) as {
      totalPositive: number | null;
      totalNegative: number | null;
      distinctSessions: number | null;
    };
    return {
      totalPositive: row.totalPositive ?? 0,
      totalNegative: row.totalNegative ?? 0,
      distinctSessions: row.distinctSessions ?? 0,
    };
  }

  listEffective(): EffectiveFeedbackV1[] {
    const rows = this.db().prepare(`
      SELECT *
      FROM effective_feedback
      WHERE tenant_id = ? AND workspace_id = ?
      ORDER BY COALESCE(sequence, -1), event_index_id, feedback_id
    `).all(
      this.scope.tenantId,
      this.scope.workspaceId,
    ) as EffectiveFeedbackRow[];
    return rows.map(row => ({
      ...parseEffectiveRow(row),
      scope: {...this.scope},
    }));
  }

  async listEffectiveSnapshot(): Promise<EffectiveFeedbackV1[]> {
    return withFilesystemRegistryLockAsync(
      this.eventLogPath,
      'feedback_event_store_busy',
      async lease => {
        lease.assertHeld();
        this.catchUpLocked();
        lease.assertHeld();
        return this.listEffective();
      },
    );
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private validateInput(input: AppendFeedbackEventInput): void {
    if (!sameScope(input.scope, this.scope)) {
      throw new Error('feedback_scope_mismatch');
    }
    if (!input.idempotencyKey.trim()) {
      throw new Error('feedback_idempotency_key_required');
    }
    if (input.comment && input.comment.length > MAX_COMMENT_CHARS) {
      throw new Error('feedback_comment_too_long');
    }
    const timestamp = input.timestamp ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error('feedback_timestamp_invalid');
    }
    eventTargetId(input);
    if (input.kind === 'created') {
      if (input.feedbackId) {
        throw new Error('feedback_created_feedback_id_forbidden');
      }
      if (input.supersedesEventId) {
        throw new Error('feedback_created_must_not_supersede');
      }
      if (!input.rating) throw new Error('feedback_rating_required');
    } else {
      if (!input.feedbackId || !input.supersedesEventId) {
        throw new Error('feedback_supersedes_required');
      }
      if (input.kind === 'retracted' && (input.rating || input.dimensions)) {
        throw new Error('feedback_retracted_payload_forbidden');
      }
      if (input.kind === 'replaced' && !input.rating) {
        throw new Error('feedback_rating_required');
      }
    }
    if (
      input.rating &&
      input.dimensions?.some(dimension =>
        input.rating === 'positive'
          ? !POSITIVE_DIMENSIONS.has(dimension)
          : !NEGATIVE_DIMENSIONS.has(dimension))
    ) {
      throw new Error('feedback_dimension_rating_mismatch');
    }
  }

  private validateTransition(input: AppendFeedbackEventInput): void {
    const database = this.db();
    if (input.kind === 'created') return;

    const superseded = database.prepare(`
      SELECT
        event_id AS eventId,
        feedback_id AS feedbackId,
        event_json AS eventJson,
        command_fingerprint AS commandFingerprint,
        legacy
      FROM feedback_event_index
      WHERE tenant_id = ? AND workspace_id = ? AND event_id = ?
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
      input.supersedesEventId,
    ) as IndexedEventRow | undefined;
    if (!superseded) throw new Error('feedback_superseded_event_not_found');
    if (superseded.legacy === 1) {
      throw new Error('legacy_feedback_not_retractable');
    }
    if (superseded.feedbackId !== input.feedbackId) {
      throw new Error('feedback_supersedes_feedback_mismatch');
    }
    const current = database.prepare(`
      SELECT *
      FROM effective_feedback
      WHERE tenant_id = ? AND workspace_id = ? AND feedback_id = ?
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
      input.feedbackId,
    ) as EffectiveFeedbackRow | undefined;
    if (!current || current.current_event_id !== input.supersedesEventId) {
      throw new Error('feedback_supersedes_fork');
    }
    const supersededEvent = JSON.parse(superseded.eventJson) as FeedbackEventV1;
    const nextTargetId = eventTargetId(input);
    if (
      supersededEvent.sessionId !== input.sessionId ||
      supersededEvent.runId !== input.runId ||
      supersededEvent.targetKind !== input.targetKind ||
      eventTargetId(supersededEvent) !== nextTargetId ||
      (supersededEvent.actor.userId ?? '') !== (input.actor.userId ?? '')
    ) {
      throw new Error('feedback_supersedes_identity_mismatch');
    }
  }

  private nextSequence(): number {
    const row = this.db().prepare(`
      SELECT MAX(sequence) AS sequence
      FROM feedback_event_index
      WHERE tenant_id = ? AND workspace_id = ? AND sequence IS NOT NULL
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
    ) as {sequence: number | null};
    return (row.sequence ?? 0) + 1;
  }

  private findByIdempotencyKey(key: string): IndexedEventRow | undefined {
    return this.db().prepare(`
      SELECT
        event_id AS eventId,
        feedback_id AS feedbackId,
        event_json AS eventJson,
        command_fingerprint AS commandFingerprint,
        legacy
      FROM feedback_event_index
      WHERE tenant_id = ? AND workspace_id = ? AND idempotency_key = ?
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
      key,
    ) as IndexedEventRow | undefined;
  }

  private catchUpLocked(
    commandFingerprints: Map<string, string> = new Map(),
  ): void {
    if (!fs.existsSync(this.eventLogPath)) return;
    const buffer = fs.readFileSync(this.eventLogPath);
    const offsetRow = this.db().prepare(`
      SELECT byte_offset AS byteOffset
      FROM feedback_projection_offsets
      WHERE tenant_id = ? AND workspace_id = ? AND log_path = ?
    `).get(
      this.scope.tenantId,
      this.scope.workspaceId,
      this.eventLogPath,
    ) as {byteOffset: number} | undefined;
    let offset = offsetRow?.byteOffset ?? 0;
    if (offset > buffer.length) throw new Error('feedback_projection_offset_invalid');
    if (offset === buffer.length) return;

    let cursor = offset;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0) throw new Error('feedback_log_incomplete_tail');
      const endOffset = newline + 1;
      const rawLine = buffer.subarray(cursor, newline).toString('utf8');
      this.projectLine(
        rawLine,
        endOffset,
        commandFingerprints,
      );
      cursor = endOffset;
      offset = endOffset;
    }
  }

  private projectLine(
    rawLine: string,
    endOffset: number,
    commandFingerprints: Map<string, string>,
  ): void {
    const database = this.db();
    database.transaction(() => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        throw new Error('feedback_log_json_invalid');
      }
      let revision: number | undefined;
      if (looksLikeFeedbackEvent(parsed)) {
        assertFeedbackEvent(parsed);
        revision = this.projectEvent(
          parsed,
          commandFingerprints.get(parsed.eventId) ??
            commandFingerprint({
              kind: parsed.kind,
              feedbackId: parsed.feedbackId,
              supersedesEventId: parsed.supersedesEventId,
              idempotencyKey: parsed.idempotencyKey,
              runId: parsed.runId,
              runManifestId: parsed.runManifestId,
              sessionId: parsed.sessionId,
              rating: parsed.rating,
              dimensions: parsed.dimensions,
              comment: parsed.comment,
              targetKind: parsed.targetKind,
              targetId: parsed.targetId,
              patternId: parsed.patternId,
              caseCandidateId: parsed.caseCandidateId,
              source: parsed.source,
              actor: parsed.actor,
              scope: parsed.scope,
            }),
        );
      } else {
        revision = this.projectLegacyEntry(parsed, rawLine);
      }
      database.prepare(`
        INSERT INTO feedback_projection_offsets (
          tenant_id, workspace_id, log_path, byte_offset, revision
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, workspace_id, log_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          revision = excluded.revision
      `).run(
        this.scope.tenantId,
        this.scope.workspaceId,
        this.eventLogPath,
        endOffset,
        revision ?? 0,
      );
    })();
  }

  private projectEvent(
    event: FeedbackEventV1,
    fingerprint: string,
  ): number {
    if (!sameScope(event.scope, this.scope)) {
      throw new Error('feedback_log_scope_mismatch');
    }
    const {checksum, ...eventWithoutChecksum} = event;
    if (checksumForEvent(eventWithoutChecksum) !== checksum) {
      throw new Error('feedback_checksum_mismatch');
    }
    const expectedSequence = this.nextSequence();
    if (event.sequence !== expectedSequence) {
      throw new Error('feedback_sequence_invalid');
    }
    this.validateTransition({
      kind: event.kind,
      feedbackId: event.feedbackId,
      supersedesEventId: event.supersedesEventId,
      idempotencyKey: event.idempotencyKey,
      runId: event.runId,
      runManifestId: event.runManifestId,
      sessionId: event.sessionId,
      rating: event.rating,
      dimensions: event.dimensions,
      comment: event.comment,
      targetKind: event.targetKind,
      targetId: event.targetId,
      patternId: event.patternId,
      caseCandidateId: event.caseCandidateId,
      source: event.source,
      actor: event.actor,
      scope: event.scope,
      timestamp: event.timestamp,
    });
    const targetId = eventTargetId(event);
    const result = this.db().prepare(`
      INSERT INTO feedback_event_index (
        event_id, tenant_id, workspace_id, feedback_id, sequence,
        idempotency_key, command_fingerprint, kind, supersedes_event_id,
        checksum, event_json, legacy, rating, target_kind, target_id,
        session_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      this.scope.tenantId,
      this.scope.workspaceId,
      event.feedbackId,
      event.sequence,
      event.idempotencyKey,
      fingerprint,
      event.kind,
      event.supersedesEventId ?? null,
      event.checksum,
      canonicalJsonString(event),
      event.rating ?? null,
      event.targetKind,
      targetId,
      event.sessionId,
      event.timestamp,
    );
    const revision = Number(result.lastInsertRowid);
    if (event.kind === 'retracted') {
      this.db().prepare(`
        DELETE FROM effective_feedback
        WHERE tenant_id = ? AND workspace_id = ? AND feedback_id = ?
      `).run(
        this.scope.tenantId,
        this.scope.workspaceId,
        event.feedbackId,
      );
    } else {
      this.upsertEffective({
        feedbackId: event.feedbackId,
        currentEventId: event.eventId,
        sequence: event.sequence,
        legacy: false,
        runId: event.runId,
        runManifestId: event.runManifestId,
        sessionId: event.sessionId,
        rating: event.rating!,
        dimensions: event.dimensions ?? [],
        comment: event.comment,
        targetKind: event.targetKind,
        targetId,
        patternId: event.patternId,
        caseCandidateId: event.caseCandidateId,
        source: event.source,
        actor: event.actor,
        scope: this.scope,
        timestamp: event.timestamp,
      }, revision);
    }
    this.markTargetDirty(event.targetKind, targetId, revision);
    return revision;
  }

  private projectLegacyEntry(parsed: unknown, rawLine: string): number | undefined {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('feedback_legacy_entry_invalid');
    }
    const entry = parsed as Record<string, unknown>;
    const sessionId = typeof entry.sessionId === 'string'
      ? entry.sessionId
      : undefined;
    const rating = entry.rating === 'positive' || entry.rating === 'negative'
      ? entry.rating
      : undefined;
    if (!sessionId || !rating) throw new Error('feedback_legacy_entry_invalid');
    const storageScope = entry.storageScope;
    if (
      storageScope &&
      typeof storageScope === 'object' &&
      !Array.isArray(storageScope)
    ) {
      const legacyScope = storageScope as Record<string, unknown>;
      if (
        legacyScope.tenantId !== this.scope.tenantId ||
        legacyScope.workspaceId !== this.scope.workspaceId
      ) {
        throw new Error('feedback_log_scope_mismatch');
      }
    }
    const lineHash = hashText(`${scopeKey(this.scope)}\0${rawLine}`);
    const eventId = `legacy:${lineHash}`;
    const candidateId = typeof entry.caseCandidateId === 'string'
      ? entry.caseCandidateId
      : undefined;
    const acceptedCandidateFeedback =
      entry.legacyCandidateFeedbackAccepted === true;
    const feedbackId = candidateId
      ? `legacy-case:${hashText(`${candidateId}\0${sessionId}`)}`
      : `legacy:${lineHash}`;
    const targetKind: FeedbackTargetKind = candidateId
      ? 'case_candidate'
      : 'session';
    const targetId = candidateId ?? sessionId;
    const legacyEvent = {
      ...entry,
      eventId,
      feedbackId,
      legacy: true,
      targetKind,
      targetId,
    };
    const result = this.db().prepare(`
      INSERT OR IGNORE INTO feedback_event_index (
        event_id, tenant_id, workspace_id, feedback_id, sequence,
        idempotency_key, command_fingerprint, kind, supersedes_event_id,
        checksum, event_json, legacy, rating, target_kind, target_id,
        session_id, timestamp
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'created', NULL, NULL, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      this.scope.tenantId,
      this.scope.workspaceId,
      feedbackId,
      canonicalJsonString(legacyEvent),
      rating,
      targetKind,
      targetId,
      sessionId,
      typeof entry.timestamp === 'string'
        ? entry.timestamp
        : new Date(0).toISOString(),
    );
    if (result.changes !== 1) return undefined;
    const revision = Number(result.lastInsertRowid);
    if (candidateId && acceptedCandidateFeedback) {
      const existing = this.db().prepare(`
        SELECT 1
        FROM effective_feedback
        WHERE tenant_id = ? AND workspace_id = ? AND feedback_id = ?
      `).get(
        this.scope.tenantId,
        this.scope.workspaceId,
        feedbackId,
      );
      if (existing) return revision;
      this.upsertEffective({
        feedbackId,
        currentEventId: eventId,
        sequence: null,
        legacy: true,
        runId: typeof entry.runId === 'string' ? entry.runId : undefined,
        sessionId,
        rating,
        dimensions: [],
        comment: typeof entry.comment === 'string' ? entry.comment : undefined,
        targetKind,
        targetId,
        caseCandidateId: candidateId,
        source: LEGACY_SOURCE,
        actor: {},
        scope: this.scope,
        timestamp: typeof entry.timestamp === 'string'
          ? entry.timestamp
          : new Date(0).toISOString(),
      }, revision);
      this.markTargetDirty(targetKind, targetId, revision);
    }
    return revision;
  }

  private upsertEffective(
    feedback: EffectiveFeedbackV1,
    revision: number,
  ): void {
    this.db().prepare(`
      INSERT INTO effective_feedback (
        tenant_id, workspace_id, feedback_id, current_event_id,
        event_index_id, sequence, legacy, run_id, run_manifest_id,
        session_id, rating, dimensions_json, comment, target_kind,
        target_id, pattern_id, case_candidate_id, source, actor_json,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, feedback_id) DO UPDATE SET
        current_event_id = excluded.current_event_id,
        event_index_id = excluded.event_index_id,
        sequence = excluded.sequence,
        legacy = excluded.legacy,
        run_id = excluded.run_id,
        run_manifest_id = excluded.run_manifest_id,
        session_id = excluded.session_id,
        rating = excluded.rating,
        dimensions_json = excluded.dimensions_json,
        comment = excluded.comment,
        target_kind = excluded.target_kind,
        target_id = excluded.target_id,
        pattern_id = excluded.pattern_id,
        case_candidate_id = excluded.case_candidate_id,
        source = excluded.source,
        actor_json = excluded.actor_json,
        timestamp = excluded.timestamp
    `).run(
      this.scope.tenantId,
      this.scope.workspaceId,
      feedback.feedbackId,
      feedback.currentEventId,
      revision,
      feedback.sequence,
      feedback.legacy ? 1 : 0,
      feedback.runId ?? null,
      feedback.runManifestId ?? null,
      feedback.sessionId,
      feedback.rating,
      canonicalJsonString(feedback.dimensions),
      feedback.comment ?? null,
      feedback.targetKind,
      feedback.targetId,
      feedback.patternId ?? null,
      feedback.caseCandidateId ?? null,
      feedback.source,
      canonicalJsonString(feedback.actor),
      feedback.timestamp,
    );
  }

  private markTargetDirty(
    targetKind: FeedbackTargetKind,
    targetId: string,
    revision: number,
  ): void {
    this.db().prepare(`
      INSERT INTO feedback_projection_targets (
        tenant_id, workspace_id, target_kind, target_id, revision,
        applied_revision
      ) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(tenant_id, workspace_id, target_kind, target_id)
      DO UPDATE SET revision = excluded.revision
    `).run(
      this.scope.tenantId,
      this.scope.workspaceId,
      targetKind,
      targetId,
      revision,
    );
  }

  private appendLine(line: string): void {
    fs.mkdirSync(path.dirname(this.eventLogPath), {
      recursive: true,
      mode: 0o700,
    });
    const descriptor = fs.openSync(this.eventLogPath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${line}\n`, undefined, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = new Database(this.databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS feedback_event_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        feedback_id TEXT NOT NULL,
        sequence INTEGER,
        idempotency_key TEXT,
        command_fingerprint TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('created','replaced','retracted')),
        supersedes_event_id TEXT,
        checksum TEXT,
        event_json TEXT NOT NULL,
        legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
        rating TEXT CHECK(rating IN ('positive','negative') OR rating IS NULL),
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        UNIQUE(tenant_id, workspace_id, sequence),
        UNIQUE(tenant_id, workspace_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_event_scope_feedback
        ON feedback_event_index(tenant_id, workspace_id, feedback_id, id);

      CREATE TABLE IF NOT EXISTS effective_feedback (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        feedback_id TEXT NOT NULL,
        current_event_id TEXT NOT NULL,
        event_index_id INTEGER NOT NULL,
        sequence INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
        run_id TEXT,
        run_manifest_id TEXT,
        session_id TEXT NOT NULL,
        rating TEXT NOT NULL CHECK(rating IN ('positive','negative')),
        dimensions_json TEXT NOT NULL,
        comment TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        pattern_id TEXT,
        case_candidate_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('ui','cli','api')),
        actor_json TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY(tenant_id, workspace_id, feedback_id),
        FOREIGN KEY(current_event_id) REFERENCES feedback_event_index(event_id),
        FOREIGN KEY(event_index_id) REFERENCES feedback_event_index(id)
      );
      CREATE INDEX IF NOT EXISTS idx_effective_feedback_target
        ON effective_feedback(
          tenant_id, workspace_id, target_kind, target_id, sequence
        );

      CREATE TABLE IF NOT EXISTS feedback_projection_targets (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        applied_revision INTEGER,
        PRIMARY KEY(tenant_id, workspace_id, target_kind, target_id)
      );

      CREATE TABLE IF NOT EXISTS feedback_projection_offsets (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        log_path TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY(tenant_id, workspace_id, log_path)
      );
    `);
    return this.database;
  }
}

function immutableProperty<T>(value: T): PropertyDescriptor {
  return {
    configurable: false,
    enumerable: false,
    writable: false,
    value,
  };
}

Object.freeze(FeedbackEventStore.prototype);

const publicCurationStoreAppend = FeedbackEventStore.prototype.append;
const publicCurationStoreList =
  FeedbackEventStore.prototype.listEffectiveSnapshot;
const publicCurationStoreClose = FeedbackEventStore.prototype.close;

const canonicalPublicCurationSources = new WeakMap<object, {
  store: FeedbackEventStore;
  scope: RunManifestScope;
  eventLogPath: string;
  databasePath: string;
}>();

/**
 * Opaque provenance capability for M6 curation.
 *
 * A durable private store cannot be wrapped as this capability. Curation code
 * accepts only instances created by the canonical public-scoped factory, so
 * visibility is never inferred from a path or the word "durable".
 */
export class PublicFeedbackCurationSource {
  readonly #store: FeedbackEventStore;
  readonly provenance: FeedbackStoreProvenance = Object.freeze({
    visibility: 'public_scoped',
    durability: 'durable',
  });
  readonly scope: RunManifestScope;

  private constructor(
    store: FeedbackEventStore,
    scope: RunManifestScope,
  ) {
    this.#store = store;
    this.scope = Object.freeze({...scope});
  }

  static open(options: {scope: RunManifestScope}): PublicFeedbackCurationSource {
    return PublicFeedbackCurationSource.#create(options.scope);
  }

  static #create(scope: RunManifestScope): PublicFeedbackCurationSource {
    const eventLogPath = publicFeedbackLogPath(scope);
    const databasePath = publicFeedbackIndexPath();
    const store = new FeedbackEventStore({
      scope,
      eventLogPath,
      databasePath,
      storage: 'durable',
      visibility: 'public_scoped',
    });
    const source = new PublicFeedbackCurationSource(
      store,
      scope,
    );
    canonicalPublicCurationSources.set(source, {
      store,
      scope: Object.freeze({...scope}),
      eventLogPath,
      databasePath,
    });
    Object.freeze(source);
    return source;
  }

  async append(
    input: AppendFeedbackEventInput,
  ): Promise<AppendFeedbackEventResult> {
    return publicCurationStoreAppend.call(this.#store, input);
  }

  async listEffective(): Promise<EffectiveFeedbackV1[]> {
    return publicCurationStoreList.call(this.#store);
  }

  close(): void {
    publicCurationStoreClose.call(this.#store);
  }
}

Object.freeze(PublicFeedbackCurationSource.prototype);

export function isCanonicalPublicFeedbackCurationSource(
  value: unknown,
): value is PublicFeedbackCurationSource {
  const canonical = value && typeof value === 'object'
    ? canonicalPublicCurationSources.get(value)
    : undefined;
  const storeIdentity = canonical?.store as unknown as {
    scope: RunManifestScope;
    eventLogPath: string;
    databasePath: string;
    storage: AppendFeedbackEventResult['storage'];
  } | undefined;
  return !!value &&
    typeof value === 'object' &&
    !!canonical &&
    (value as PublicFeedbackCurationSource).provenance.visibility ===
      'public_scoped' &&
    (value as PublicFeedbackCurationSource).provenance.durability ===
      'durable' &&
    canonical.store.provenance.visibility ===
      'public_scoped' &&
    canonical.store.provenance.durability ===
      'durable' &&
    storeIdentity?.storage === 'durable' &&
    storeIdentity.eventLogPath === canonical.eventLogPath &&
    storeIdentity.databasePath === canonical.databasePath &&
    sameScope(storeIdentity.scope, canonical.scope);
}

export const feedbackEventStoreTesting = {
  checksumForEvent,
  commandFingerprint,
  eventTargetId,
  normalizedCommand,
  scopeKey,
};
