// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { backendDataPath } from '../../runtimePaths';
import type { CaseCandidate, CaseCandidateReview, CaseCandidateState } from '../../types/caseEvolution';
import type {EffectiveFeedbackV1} from '../../types/selfEvolution';
import {resolveKnowledgeScope} from '../scopedKnowledgeStore';
import type {KnowledgeScope} from '../scopedKnowledgeStore';
import {
  ScopedOutbox,
  type ScopedLeaseFence,
} from '../evolutionLifecycle/scopedOutbox';
import {caseCandidateKnowledgeScope} from './caseCandidateBuilder';

export interface CaseCandidateOutboxOptions {
  dbPath?: string;
}

export interface EnqueueCaseCandidateOptions {
  dedupeKey: string;
  priority?: number;
  queueMax?: number;
}

export interface EnqueueCaseCandidateResult {
  enqueued: boolean;
  candidateId?: string;
  latencyMs: number;
  reason?: 'duplicate_active' | 'queue_full' | 'error';
}

export interface LeasedCaseCandidate {
  candidateId: string;
  state: CaseCandidateState;
  intrinsicState: CaseCandidateState;
  feedbackProjectionRejected: boolean;
  dedupeKey: string;
  priority: number;
  attempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  lease: ScopedLeaseFence | null;
  createdAt: number;
  updatedAt: number;
  supportingEvidence: number;
  contradictingEvidence: number;
  maintainerPromoted: number;
  supported: number;
  learnedCaseId: string | null;
  candidate: CaseCandidate;
  review: CaseCandidateReview | null;
  notePath: string | null;
  lastError: string | null;
}

export interface AddCandidateFeedbackInput {
  sourceSessionId: string;
  sourceAnalysisRunId?: string;
  rating: 'positive' | 'negative';
  receivedAt?: number;
  receivedWithinSeconds?: number;
  withinTimeWindow?: 'mis_tap' | 'short' | 'long' | 'audit_only';
  metadata?: Record<string, unknown>;
}

export interface AddCandidateFeedbackResult {
  added: boolean;
  reason?: 'duplicate' | 'error' | 'legacy_read_only';
}

export interface CandidateFeedbackProjectionResult {
  found: boolean;
  supportingEvidence: number;
  contradictingEvidence: number;
  rejected: boolean;
  supported: boolean;
}

export interface AcceptedLegacyCandidateFeedback {
  sourceRowId: number;
  candidateId: string;
  sourceSessionId: string;
  sourceAnalysisRunId?: string;
  rating: 'positive' | 'negative';
  receivedAt: number;
}

interface CaseLeaseCompletion {
  state: 'reviewed' | 'rejected';
  review?: CaseCandidateReview;
  notePath?: string | null;
  learnedCaseId?: string | null;
  reason?: string;
}

interface CaseLeaseFailure {
  reason: string;
  maxAttempts: number;
}

const SCHEMA_VERSION_LATEST = 4;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

function defaultDbPath(): string {
  return backendDataPath('self_improve', 'case_evolution.db');
}

export function openCaseCandidateOutbox(opts: CaseCandidateOutboxOptions = {}): CaseCandidateOutboxHandle {
  const dbPath = opts.dbPath || defaultDbPath();
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initializeMigrationsTable(db);
  applyPendingMigrations(db);

  return new CaseCandidateOutboxHandle(db);
}

function initializeMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function applyPendingMigrations(db: Database.Database): void {
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{version: number}>;
  const applied = new Set(appliedRows.map(row => row.version));
  if (!applied.has(1)) {
    const createSchema = db.transaction(() => {
    db.exec(`
      CREATE TABLE case_candidates (
        candidate_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('pending_review','reviewed','rejected','archived')) DEFAULT 'pending_review',
        dedupe_key TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        supporting_evidence INTEGER NOT NULL DEFAULT 0,
        contradicting_evidence INTEGER NOT NULL DEFAULT 0,
        maintainer_promoted INTEGER NOT NULL DEFAULT 0,
        supported INTEGER GENERATED ALWAYS AS
          (CASE WHEN (maintainer_promoted = 1 OR supporting_evidence >= 3)
                    AND state = 'reviewed'
                THEN 1 ELSE 0 END) STORED,
        learned_case_id TEXT,
        payload_json TEXT NOT NULL,
        review_json TEXT,
        note_path TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_candidates_state_priority
        ON case_candidates(state, priority DESC, created_at);
      CREATE INDEX idx_candidates_supported
        ON case_candidates(supported) WHERE supported = 1;
      CREATE UNIQUE INDEX idx_candidates_dedupe_active
        ON case_candidates(dedupe_key)
        WHERE state IN ('pending_review','reviewed');

      CREATE TABLE candidate_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_analysis_run_id TEXT,
        rating TEXT NOT NULL CHECK(rating IN ('positive','negative')),
        received_at INTEGER NOT NULL,
        received_within_seconds INTEGER,
        within_time_window TEXT NOT NULL CHECK(within_time_window IN ('mis_tap','short','long','audit_only')),
        metadata_json TEXT,
        FOREIGN KEY (candidate_id) REFERENCES case_candidates(candidate_id)
          ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_feedback_dedupe
        ON candidate_feedback(candidate_id, source_session_id);
      CREATE INDEX idx_feedback_candidate ON candidate_feedback(candidate_id);
    `);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      1,
      Date.now(),
    );
    });
    createSchema();
  }
  if (!applied.has(2)) migrateLegacyCandidateScopes(db);
  if (!applied.has(3)) migrateCandidateFeedbackProjection(db);
  if (!applied.has(4)) migrateScopedLeaseFencing(db);
}

function migrateLegacyCandidateScopes(db: Database.Database): void {
  const defaultScope = resolveKnowledgeScope();
  const rows = db.prepare(`
    SELECT candidate_id, dedupe_key, payload_json
    FROM case_candidates
    ORDER BY candidate_id
  `).all() as Array<{candidate_id: string; dedupe_key: string; payload_json: string}>;

  const migrate = db.transaction(() => {
    const update = db.prepare(`
      UPDATE case_candidates
      SET payload_json = ?, dedupe_key = ?, updated_at = ?
      WHERE candidate_id = ?
    `);
    for (const row of rows) {
      let payload: any;
      try {
        payload = JSON.parse(row.payload_json);
      } catch (error) {
        throw new Error(
          `Cannot migrate case candidate ${row.candidate_id}: invalid payload_json: ${(error as Error).message}`,
        );
      }
      const provenance = payload?.provenance;
      const cluster = payload?.cluster;
      if (
        !provenance ||
        typeof provenance.traceContentHash !== 'string' ||
        typeof provenance.sceneType !== 'string' ||
        !cluster ||
        typeof cluster.rootCause !== 'string'
      ) {
        throw new Error(
          `Cannot migrate case candidate ${row.candidate_id}: legacy provenance is incomplete`,
        );
      }

      const originScope = provenance.originScope;
      const hasValidScope = originScope &&
        typeof originScope.tenantId === 'string' && originScope.tenantId.trim() &&
        typeof originScope.workspaceId === 'string' && originScope.workspaceId.trim();
      if (!hasValidScope) {
        provenance.originScope = {
          tenantId: defaultScope.tenantId,
          workspaceId: defaultScope.workspaceId,
        };
      }
      payload.schemaVersion = 'case_candidate@2';
      const scope = provenance.originScope as {tenantId: string; workspaceId: string};
      const dedupeKey = [
        scope.tenantId,
        scope.workspaceId,
        provenance.traceContentHash,
        provenance.sceneType,
        cluster.rootCause,
      ].join('::');
      update.run(JSON.stringify(payload), dedupeKey, Date.now(), row.candidate_id);
    }
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(2, Date.now());
  });
  migrate();
}

function migrateCandidateFeedbackProjection(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = db.pragma('table_info(case_candidates)') as Array<{name: string}>;
    if (!columns.some(column => column.name === 'feedback_projection_rejected')) {
      db.exec(`
        ALTER TABLE case_candidates
        ADD COLUMN feedback_projection_rejected INTEGER NOT NULL DEFAULT 0
          CHECK(feedback_projection_rejected IN (0,1));
      `);
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_candidates_dedupe_active;
      CREATE UNIQUE INDEX idx_candidates_dedupe_active
        ON case_candidates(dedupe_key)
        WHERE state IN ('pending_review','reviewed');
      CREATE INDEX IF NOT EXISTS idx_candidates_feedback_projection
        ON case_candidates(feedback_projection_rejected, state);
    `);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      3,
      Date.now(),
    );
  });
  migrate();
}

function migrateScopedLeaseFencing(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = db.pragma('table_info(case_candidates)') as Array<{name: string}>;
    if (!columns.some(column => column.name === 'tenant_id')) {
      db.exec('ALTER TABLE case_candidates ADD COLUMN tenant_id TEXT');
    }
    if (!columns.some(column => column.name === 'workspace_id')) {
      db.exec('ALTER TABLE case_candidates ADD COLUMN workspace_id TEXT');
    }
    if (!columns.some(column => column.name === 'lease_token')) {
      db.exec('ALTER TABLE case_candidates ADD COLUMN lease_token TEXT');
    }

    const rows = db.prepare(`
      SELECT candidate_id, payload_json
      FROM case_candidates
      WHERE tenant_id IS NULL OR workspace_id IS NULL
      ORDER BY candidate_id
    `).all() as Array<{candidate_id: string; payload_json: string}>;
    const updateScope = db.prepare(`
      UPDATE case_candidates
      SET tenant_id = ?, workspace_id = ?, updated_at = ?
      WHERE candidate_id = ?
    `);
    for (const row of rows) {
      let candidate: CaseCandidate;
      try {
        candidate = JSON.parse(row.payload_json) as CaseCandidate;
      } catch (error) {
        throw new Error(
          `Cannot migrate case candidate ${row.candidate_id}: invalid payload_json: ${(error as Error).message}`,
        );
      }
      const scope = caseCandidateKnowledgeScope(candidate);
      if (!scope) {
        throw new Error(
          `Cannot migrate case candidate ${row.candidate_id}: origin scope is missing`,
        );
      }
      updateScope.run(
        scope.tenantId,
        scope.workspaceId,
        Date.now(),
        row.candidate_id,
      );
    }
    // A pre-v4 lease has no fencing token and cannot be safely honored by the
    // new worker. Migrations run before workers start, so invalidate those
    // legacy leases and let a fenced worker reclaim the pending row.
    db.exec(`
      UPDATE case_candidates
      SET lease_owner = NULL,
          lease_until = NULL
      WHERE lease_token IS NULL
        AND lease_owner IS NOT NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_candidates_scope_state_priority
        ON case_candidates(
          tenant_id,
          workspace_id,
          state,
          priority DESC,
          created_at
        );
    `);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      4,
      Date.now(),
    );
  });
  migrate();
}

function rowToCandidate(row: Record<string, unknown>): LeasedCaseCandidate {
  const candidate = JSON.parse(String(row.payload_json)) as CaseCandidate;
  const intrinsicState = row.state as CaseCandidateState;
  const feedbackProjectionRejected =
    Number(row.feedback_projection_rejected || 0) === 1;
  const leaseOwner = row.lease_owner as string | null;
  const leaseToken = row.lease_token as string | null;
  const leaseUntil = row.lease_until as number | null;
  const candidateScope = caseCandidateKnowledgeScope(candidate);
  const scope = candidateScope ? resolveKnowledgeScope(candidateScope) : null;
  const lease = leaseOwner && leaseToken && leaseUntil && scope
    ? {
        scope,
        jobId: String(row.candidate_id),
        owner: leaseOwner,
        token: leaseToken,
        leaseUntil,
      }
    : null;
  return {
    candidateId: String(row.candidate_id),
    state: feedbackProjectionRejected ? 'rejected' : intrinsicState,
    intrinsicState,
    feedbackProjectionRejected,
    dedupeKey: String(row.dedupe_key),
    priority: Number(row.priority || 0),
    attempts: Number(row.attempts || 0),
    leaseOwner,
    leaseToken,
    leaseUntil,
    lease,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    supportingEvidence: Number(row.supporting_evidence || 0),
    contradictingEvidence: Number(row.contradicting_evidence || 0),
    maintainerPromoted: Number(row.maintainer_promoted || 0),
    supported: feedbackProjectionRejected ? 0 : Number(row.supported || 0),
    learnedCaseId: row.learned_case_id as string | null,
    candidate,
    review: row.review_json ? JSON.parse(String(row.review_json)) as CaseCandidateReview : null,
    notePath: row.note_path as string | null,
    lastError: row.last_error as string | null,
  };
}

function truncateError(reason: string): string {
  return reason.length > 1000 ? reason.slice(0, 1000) : reason;
}

export class CaseCandidateOutboxHandle {
  private readonly lifecycle: ScopedOutbox<
    Record<string, unknown>,
    CaseLeaseCompletion,
    CaseLeaseFailure
  >;

  constructor(private readonly db: Database.Database) {
    this.lifecycle = new ScopedOutbox({
      claim: input => this.claimLease(input),
      assertActive: (fence, now) => this.assertLease(fence, now),
      renew: (fence, now, leaseUntil) =>
        this.renewLeaseRow(fence, now, leaseUntil),
      complete: (fence, completion, now) =>
        this.completeLeaseRow(fence, completion, now),
      fail: (fence, failure, now) =>
        this.failLeaseRow(fence, failure, now),
      release: (fence, now) => this.releaseLeaseRow(fence, now),
    });
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {version: number | null};
    return row.version || 0;
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.pragma('foreign_keys', {simple: true}) as number;
    return row === 1;
  }

  enqueue(candidate: CaseCandidate, opts: EnqueueCaseCandidateOptions): EnqueueCaseCandidateResult {
    const start = Date.now();
    try {
      // Legacy/test callers may still enqueue an unscoped payload. Keep the
      // row in the default partition so the worker can reject it explicitly;
      // new capture paths always provide immutable originScope.
      const scope = caseCandidateKnowledgeScope(candidate) ??
        resolveKnowledgeScope();
      if (opts.queueMax !== undefined && this.pendingCount() >= opts.queueMax) {
        return {enqueued: false, reason: 'queue_full', latencyMs: Date.now() - start};
      }
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO case_candidates (
          candidate_id, tenant_id, workspace_id, state, dedupe_key, priority,
          attempts, created_at, updated_at, payload_json
        ) VALUES (?, ?, ?, 'pending_review', ?, ?, 0, ?, ?, ?)
      `).run(
        candidate.candidateId,
        scope.tenantId,
        scope.workspaceId,
        opts.dedupeKey,
        opts.priority ?? 0,
        now,
        now,
        JSON.stringify(candidate),
      );
      return {enqueued: true, candidateId: candidate.candidateId, latencyMs: Date.now() - start};
    } catch (err) {
      if ((err as {code?: string}).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return {enqueued: false, reason: 'duplicate_active', latencyMs: Date.now() - start};
      }
      console.error('[CaseCandidateOutbox] enqueue failed:', (err as Error).message);
      return {enqueued: false, reason: 'error', latencyMs: Date.now() - start};
    }
  }

  leaseNext(input: {
    candidateId?: string;
    workerOwner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
    now?: number;
  }): LeasedCaseCandidate | null {
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const claimed = this.lifecycle.claim({
      owner: input.workerOwner,
      jobId: input.candidateId,
      leaseDurationMs,
      maxAttempts,
      now: input.now,
    });
    if (!claimed) return null;
    try {
      return {
        ...rowToCandidate(claimed.job),
        lease: claimed.fence,
        leaseOwner: claimed.fence.owner,
        leaseToken: claimed.fence.token,
        leaseUntil: claimed.fence.leaseUntil,
      };
    } catch (err) {
      this.lifecycle.complete(claimed.fence, {
        state: 'rejected',
        reason: `invalid payload_json: ${(err as Error).message}`,
      });
      return null;
    }
  }

  assertLeaseActive(fence: ScopedLeaseFence, now: number = Date.now()): void {
    this.lifecycle.assertActive(fence, now);
  }

  renewLease(
    fence: ScopedLeaseFence,
    leaseDurationMs: number = DEFAULT_LEASE_MS,
    now: number = Date.now(),
  ): ScopedLeaseFence {
    return this.lifecycle.renew(fence, leaseDurationMs, now);
  }

  completeReviewedLease(
    fence: ScopedLeaseFence,
    input: {
      review: CaseCandidateReview;
      notePath?: string | null;
      learnedCaseId?: string | null;
    },
    now: number = Date.now(),
  ): void {
    this.lifecycle.complete(fence, {
      state: 'reviewed',
      review: input.review,
      notePath: input.notePath ?? null,
      learnedCaseId: input.learnedCaseId ?? null,
    }, now);
  }

  rejectLease(
    fence: ScopedLeaseFence,
    reason: string,
    now: number = Date.now(),
  ): void {
    this.lifecycle.complete(fence, {
      state: 'rejected',
      reason,
    }, now);
  }

  failLease(
    fence: ScopedLeaseFence,
    reason: string,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    now: number = Date.now(),
  ): void {
    this.lifecycle.fail(fence, {reason, maxAttempts}, now);
  }

  releaseFencedLease(
    fence: ScopedLeaseFence,
    now: number = Date.now(),
  ): void {
    this.lifecycle.release(fence, now);
  }

  setLearnedCaseId(candidateId: string, learnedCaseId: string | null): void {
    this.db.prepare(`
      UPDATE case_candidates
      SET learned_case_id = ?, updated_at = ?
      WHERE candidate_id = ?
    `).run(learnedCaseId, Date.now(), candidateId);
  }

  /**
   * Explicit post-review governance transition. This is not a worker terminal
   * operation: it only applies to an already reviewed, unleased row.
   */
  rejectReviewedForGovernance(candidateId: string, reason: string): void {
    const result = this.db.prepare(`
      UPDATE case_candidates
      SET state = 'rejected',
          updated_at = ?,
          last_error = ?
      WHERE candidate_id = ?
        AND state = 'reviewed'
        AND lease_owner IS NULL
        AND lease_token IS NULL
    `).run(Date.now(), truncateError(reason), candidateId);
    if (result.changes !== 1) {
      throw new Error(`case_governance_transition_rejected:${candidateId}`);
    }
  }

  expireStaleLeases(now: number = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE case_candidates
      SET lease_owner = NULL, lease_token = NULL, lease_until = NULL,
          updated_at = ?
      WHERE state = 'pending_review' AND lease_owner IS NOT NULL AND lease_until <= ?
    `).run(now, now);
    return result.changes;
  }

  addFeedback(candidateId: string, input: AddCandidateFeedbackInput): AddCandidateFeedbackResult {
    void candidateId;
    void input;
    return {added: false, reason: 'legacy_read_only'};
  }

  applyFeedbackProjection(
    candidateId: string,
    feedback: readonly Pick<EffectiveFeedbackV1, 'rating'>[],
  ): CandidateFeedbackProjectionResult {
    const supportingEvidence = feedback.reduce(
      (count, row) => count + (row.rating === 'positive' ? 1 : 0),
      0,
    );
    const contradictingEvidence = feedback.length - supportingEvidence;
    const rejected = contradictingEvidence >= 2;
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT state, maintainer_promoted
        FROM case_candidates
        WHERE candidate_id = ?
      `).get(candidateId) as {
        state: CaseCandidateState;
        maintainer_promoted: number;
      } | undefined;
      if (!row) {
        return {
          found: false,
          supportingEvidence: 0,
          contradictingEvidence: 0,
          rejected: false,
          supported: false,
        };
      }
      this.db.prepare(`
        UPDATE case_candidates
        SET supporting_evidence = ?,
            contradicting_evidence = ?,
            feedback_projection_rejected = ?,
            lease_owner = CASE WHEN ? = 1 THEN NULL ELSE lease_owner END,
            lease_token = CASE WHEN ? = 1 THEN NULL ELSE lease_token END,
            lease_until = CASE WHEN ? = 1 THEN NULL ELSE lease_until END,
            updated_at = ?
        WHERE candidate_id = ?
      `).run(
        supportingEvidence,
        contradictingEvidence,
        rejected ? 1 : 0,
        rejected ? 1 : 0,
        rejected ? 1 : 0,
        rejected ? 1 : 0,
        Date.now(),
        candidateId,
      );
      const supported = !rejected &&
        row.state === 'reviewed' &&
        (row.maintainer_promoted === 1 || supportingEvidence >= 3);
      return {
        found: true,
        supportingEvidence,
        contradictingEvidence,
        rejected,
        supported,
      };
    })();
  }

  getCandidate(candidateId: string): LeasedCaseCandidate | null {
    const row = this.db.prepare('SELECT * FROM case_candidates WHERE candidate_id = ?').get(candidateId) as Record<string, unknown> | undefined;
    return row ? rowToCandidate(row) : null;
  }

  listCandidates(opts: {states?: CaseCandidateState[]} = {}): LeasedCaseCandidate[] {
    const rows = this.db.prepare(
      'SELECT * FROM case_candidates ORDER BY candidate_id',
    ).all() as Array<Record<string, unknown>>;
    const candidates = rows.map(rowToCandidate);
    return opts.states && opts.states.length > 0
      ? candidates.filter(candidate => opts.states!.includes(candidate.state))
      : candidates;
  }

  countCandidatesByState(): Record<CaseCandidateState, number> {
    const counts: Record<CaseCandidateState, number> = {
      pending_review: 0,
      reviewed: 0,
      rejected: 0,
      archived: 0,
    };
    for (const candidate of this.listCandidates()) counts[candidate.state] += 1;
    return counts;
  }

  countSupported(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM case_candidates
      WHERE supported = 1 AND feedback_projection_rejected = 0
    `).get() as {count: number};
    return row.count;
  }

  dailyCounts(now: number = Date.now()): {todayEnqueued: number; todayReviewed: number; todayIngested: number; todayFailed: number} {
    const since = now - 24 * 60 * 60 * 1000;
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS todayEnqueued,
        SUM(CASE WHEN state = 'reviewed' AND updated_at >= ? THEN 1 ELSE 0 END) AS todayReviewed,
        SUM(CASE WHEN learned_case_id IS NOT NULL AND updated_at >= ? THEN 1 ELSE 0 END) AS todayIngested,
        SUM(CASE WHEN (state = 'rejected' OR feedback_projection_rejected = 1)
          AND updated_at >= ? THEN 1 ELSE 0 END) AS todayFailed
      FROM case_candidates
    `).get(since, since, since, since) as {todayEnqueued: number | null; todayReviewed: number | null; todayIngested: number | null; todayFailed: number | null};
    return {
      todayEnqueued: row.todayEnqueued || 0,
      todayReviewed: row.todayReviewed || 0,
      todayIngested: row.todayIngested || 0,
      todayFailed: row.todayFailed || 0,
    };
  }

  workerHealth(): {pending: number; leased: number; attemptsHistogram: Record<number, number>} {
    const attemptsHistogram: Record<number, number> = {};
    const rows = this.db.prepare('SELECT attempts, COUNT(*) AS count FROM case_candidates GROUP BY attempts').all() as Array<{attempts: number; count: number}>;
    for (const row of rows) attemptsHistogram[row.attempts] = row.count;
    const leased = this.db.prepare(`
      SELECT COUNT(*) AS count FROM case_candidates
      WHERE state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner IS NOT NULL
    `).get() as {count: number};
    return {
      pending: this.pendingCount(),
      leased: leased.count,
      attemptsHistogram,
    };
  }

  legacyFeedbackStats(): {totalPositive: number; totalNegative: number; distinctSessions: number} {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN rating = 'positive' THEN 1 ELSE 0 END) AS totalPositive,
        SUM(CASE WHEN rating = 'negative' THEN 1 ELSE 0 END) AS totalNegative,
        COUNT(DISTINCT source_session_id) AS distinctSessions
      FROM candidate_feedback
    `).get() as {totalPositive: number | null; totalNegative: number | null; distinctSessions: number | null};
    return {
      totalPositive: row.totalPositive || 0,
      totalNegative: row.totalNegative || 0,
      distinctSessions: row.distinctSessions || 0,
    };
  }

  listAcceptedLegacyFeedback(
    scope: KnowledgeScope,
  ): AcceptedLegacyCandidateFeedback[] {
    const requestedScope = resolveKnowledgeScope(scope);
    const rows = this.db.prepare(`
      SELECT
        feedback.id AS sourceRowId,
        feedback.candidate_id AS candidateId,
        feedback.source_session_id AS sourceSessionId,
        feedback.source_analysis_run_id AS sourceAnalysisRunId,
        feedback.rating,
        feedback.received_at AS receivedAt,
        candidates.payload_json AS candidateJson
      FROM candidate_feedback AS feedback
      JOIN case_candidates AS candidates
        ON candidates.candidate_id = feedback.candidate_id
      WHERE feedback.within_time_window = 'short'
      ORDER BY feedback.id
    `).all() as Array<
      AcceptedLegacyCandidateFeedback & {candidateJson: string}
    >;
    return rows.flatMap(row => {
      let candidate: CaseCandidate;
      try {
        candidate = JSON.parse(row.candidateJson) as CaseCandidate;
      } catch {
        return [];
      }
      const candidateScope = caseCandidateKnowledgeScope(candidate);
      if (
        !candidateScope ||
        candidateScope.tenantId !== requestedScope.tenantId ||
        candidateScope.workspaceId !== requestedScope.workspaceId
      ) {
        return [];
      }
      const {
        candidateJson: _candidateJson,
        sourceAnalysisRunId,
        ...accepted
      } = row;
      return [{
        ...accepted,
        ...(sourceAnalysisRunId ? {sourceAnalysisRunId} : {}),
      }];
    });
  }

  close(): void {
    this.db.close();
  }

  private claimLease(input: {
    jobId?: string;
    owner: string;
    token: string;
    now: number;
    leaseUntil: number;
    maxAttempts: number;
  }) {
    return this.db.transaction(() => {
      const selected = this.db.prepare(`
        SELECT candidate_id, tenant_id, workspace_id
        FROM case_candidates
        WHERE state = 'pending_review'
          AND (? IS NULL OR candidate_id = ?)
          AND feedback_projection_rejected = 0
          AND lease_owner IS NULL
          AND lease_token IS NULL
          AND attempts < ?
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `).get(
        input.jobId ?? null,
        input.jobId ?? null,
        input.maxAttempts,
      ) as {
        candidate_id: string;
        tenant_id: string;
        workspace_id: string;
      } | undefined;
      if (!selected) return {changes: 0};
      const claim = this.db.prepare(`
        UPDATE case_candidates
        SET lease_owner = ?,
            lease_token = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE candidate_id = ?
          AND tenant_id = ?
          AND workspace_id = ?
          AND state = 'pending_review'
          AND feedback_projection_rejected = 0
          AND lease_owner IS NULL
          AND lease_token IS NULL
      `).run(
        input.owner,
        input.token,
        input.leaseUntil,
        input.now,
        selected.candidate_id,
        selected.tenant_id,
        selected.workspace_id,
      );
      if (claim.changes !== 1) return {changes: claim.changes};
      const job = this.db.prepare(`
        SELECT * FROM case_candidates
        WHERE candidate_id = ?
          AND tenant_id = ?
          AND workspace_id = ?
      `).get(
        selected.candidate_id,
        selected.tenant_id,
        selected.workspace_id,
      ) as Record<string, unknown> | undefined;
      return {
        changes: claim.changes,
        job,
        scope: {
          tenantId: selected.tenant_id,
          workspaceId: selected.workspace_id,
        },
        jobId: selected.candidate_id,
      };
    })();
  }

  private assertLease(fence: ScopedLeaseFence, now: number): number {
    return this.db.prepare(`
      UPDATE case_candidates
      SET updated_at = updated_at
      WHERE candidate_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_until > ?
    `).run(
      fence.jobId,
      fence.scope.tenantId,
      fence.scope.workspaceId,
      fence.owner,
      fence.token,
      now,
    ).changes;
  }

  private renewLeaseRow(
    fence: ScopedLeaseFence,
    now: number,
    leaseUntil: number,
  ): number {
    return this.db.prepare(`
      UPDATE case_candidates
      SET lease_until = ?, updated_at = ?
      WHERE candidate_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_until > ?
    `).run(
      leaseUntil,
      now,
      fence.jobId,
      fence.scope.tenantId,
      fence.scope.workspaceId,
      fence.owner,
      fence.token,
      now,
    ).changes;
  }

  private completeLeaseRow(
    fence: ScopedLeaseFence,
    completion: CaseLeaseCompletion,
    now: number,
  ): number {
    if (completion.state === 'reviewed') {
      if (!completion.review) {
        throw new Error('case_outbox_review_required');
      }
      return this.db.prepare(`
        UPDATE case_candidates
        SET state = 'reviewed',
            review_json = ?,
            note_path = ?,
            learned_case_id = ?,
            lease_owner = NULL,
            lease_token = NULL,
            lease_until = NULL,
            updated_at = ?,
            last_error = NULL
        WHERE candidate_id = ?
          AND tenant_id = ?
          AND workspace_id = ?
          AND state = 'pending_review'
          AND feedback_projection_rejected = 0
          AND lease_owner = ?
          AND lease_token = ?
          AND lease_until > ?
      `).run(
        JSON.stringify(completion.review),
        completion.notePath ?? null,
        completion.learnedCaseId ?? null,
        now,
        fence.jobId,
        fence.scope.tenantId,
        fence.scope.workspaceId,
        fence.owner,
        fence.token,
        now,
      ).changes;
    }
    return this.db.prepare(`
      UPDATE case_candidates
      SET state = 'rejected',
          lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          updated_at = ?,
          last_error = ?
      WHERE candidate_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_until > ?
    `).run(
      now,
      truncateError(completion.reason ?? 'rejected'),
      fence.jobId,
      fence.scope.tenantId,
      fence.scope.workspaceId,
      fence.owner,
      fence.token,
      now,
    ).changes;
  }

  private failLeaseRow(
    fence: ScopedLeaseFence,
    failure: CaseLeaseFailure,
    now: number,
  ): number {
    return this.db.prepare(`
      UPDATE case_candidates
      SET state = CASE
            WHEN attempts >= ? THEN 'rejected'
            ELSE 'pending_review'
          END,
          lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          updated_at = ?,
          last_error = ?
      WHERE candidate_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_until > ?
    `).run(
      failure.maxAttempts,
      now,
      truncateError(failure.reason),
      fence.jobId,
      fence.scope.tenantId,
      fence.scope.workspaceId,
      fence.owner,
      fence.token,
      now,
    ).changes;
  }

  private releaseLeaseRow(fence: ScopedLeaseFence, now: number): number {
    return this.db.prepare(`
      UPDATE case_candidates
      SET lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          updated_at = ?
      WHERE candidate_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner = ?
        AND lease_token = ?
        AND lease_until > ?
    `).run(
      now,
      fence.jobId,
      fence.scope.tenantId,
      fence.scope.workspaceId,
      fence.owner,
      fence.token,
      now,
    ).changes;
  }

  private pendingCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM case_candidates
      WHERE state = 'pending_review'
        AND feedback_projection_rejected = 0
        AND lease_owner IS NULL
    `).get() as {count: number};
    return row.count;
  }
}

export const __testing = {
  SCHEMA_VERSION_LATEST,
};
