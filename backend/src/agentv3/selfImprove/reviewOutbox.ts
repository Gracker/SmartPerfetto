// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SQLite-backed outbox for the background review agent.
 *
 * The review agent runs asynchronously after every analysis: a backend
 * crash, deploy, or process restart in between must NOT lose review jobs.
 * Filesystem-based queues (one JSON file per state) lose race exclusivity
 * once two workers contend for the same job. SQLite + WAL gives us atomic
 * `UPDATE … WHERE state='pending' RETURNING …` lease semantics in a single
 * statement, plus partial unique indexes for `dedupe_key` so a flapping
 * caller can't enqueue the same job twice.
 *
 * The DB lives at `<cwd>/data/self_improve/self_improve.db` — separate from
 * the sessions DB so a corrupt outbox never takes the analysis path down
 * with it.
 *
 * See docs/architecture/self-improving-design.md "存储与安全".
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {backendDataPath} from '../../runtimePaths';
import {
  openSqliteReadSnapshot,
  type SqliteReadSnapshot,
} from '../../utils/sqliteReadSnapshot';

export type JobState = 'pending' | 'leased' | 'done' | 'failed';

export interface EnqueueInput {
  /**
   * Globally unique dedupe key. The recommended form is
   * `${sessionId}::${turnIndex}::${skillId}::${failureModeHash}` so the same
   * skill+failure combo on the same turn can't be enqueued twice while still
   * leaving room for legitimate retries on a different turn.
   */
  dedupeKey: string;
  /** Higher numbers run first. Default 0. */
  priority?: number;
  /** Arbitrary JSON-serializable payload — never mutated by the outbox. */
  payload: unknown;
}

export interface ReviewJob {
  id: string;
  state: JobState;
  dedupeKey: string;
  priority: number;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
  payload: unknown;
  lastError: string | null;
}

export interface OutboxOptions {
  /** Override default DB path for tests. Pass ':memory:' for an ephemeral store. */
  dbPath?: string;
}

export interface EnqueueResult {
  enqueued: boolean;
  jobId?: string;
  /** Latency of the enqueue insert in ms — surfaced for the metrics PR. */
  latencyMs: number;
  /**
   * Reason the enqueue was a no-op. `duplicate_active` means a pending or
   * leased job with the same dedupe key already exists.
   */
  reason?: 'duplicate_active' | 'error';
}

export interface ReviewOutboxReadHandle {
  countByState(): Record<JobState, number>;
  dailyJobCount(now?: number): number;
  close(): void;
}

/** Default lease + retry parameters; callers can override per-call. */
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

const SCHEMA_VERSION_LATEST = 1;

interface MigrationStep {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: ReadonlyArray<MigrationStep> = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE review_jobs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK(state IN ('pending','leased','done','failed')),
          dedupe_key TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_until INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          last_error TEXT
        );
        CREATE INDEX idx_review_jobs_state_priority ON review_jobs(state, priority DESC, created_at);
        CREATE UNIQUE INDEX idx_review_jobs_dedupe_active
          ON review_jobs(dedupe_key) WHERE state IN ('pending','leased');
      `);
    },
  },
];

function defaultDbPath(): string {
  return backendDataPath('self_improve', 'self_improve.db');
}

/**
 * Open the outbox DB, run migrations, and return a closure that exposes the
 * supported operations. The DB connection is owned by the caller — call
 * `close()` to release it.
 */
export function openReviewOutbox(opts: OutboxOptions = {}): ReviewOutboxHandle {
  const dbPath = opts.dbPath || defaultDbPath();

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initializeMigrationsTable(db);
  applyPendingMigrations(db);

  return new ReviewOutboxHandle(db);
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
  const appliedRows = db.prepare<unknown[], { version: number }>(
    'SELECT version FROM schema_migrations',
  ).all();
  const applied = new Set(appliedRows.map(r => r.version));

  const pending = MIGRATIONS.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  for (const step of pending) {
    const tx = db.transaction(() => {
      step.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        step.version,
        Date.now(),
      );
    });
    tx();
  }
}

function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function rowToJob(row: {
  id: string;
  state: JobState;
  dedupe_key: string;
  priority: number;
  attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  payload_json: string;
  last_error: string | null;
}): ReviewJob {
  return {
    id: row.id,
    state: row.state,
    dedupeKey: row.dedupe_key,
    priority: row.priority,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: JSON.parse(row.payload_json),
    lastError: row.last_error,
  };
}

export class ReviewOutboxHandle {
  constructor(private readonly db: Database.Database) {}

  /**
   * Enqueue a new job. Returns `{ enqueued: false, reason: 'duplicate_active' }`
   * if a pending or leased job with the same dedupe key already exists; this is
   * a successful no-op, not an error, so callers don't need a try/catch.
   */
  enqueue(input: EnqueueInput): EnqueueResult {
    const start = Date.now();
    const id = generateJobId();
    const now = Date.now();
    const priority = input.priority ?? 0;
    try {
      this.db.prepare(`
        INSERT INTO review_jobs (id, state, dedupe_key, priority, attempts, created_at, updated_at, payload_json)
        VALUES (?, 'pending', ?, ?, 0, ?, ?, ?)
      `).run(id, input.dedupeKey, priority, now, now, JSON.stringify(input.payload));
      return { enqueued: true, jobId: id, latencyMs: Date.now() - start };
    } catch (err) {
      // Partial unique index on (dedupe_key) WHERE state IN ('pending','leased')
      // surfaces SQLITE_CONSTRAINT_UNIQUE for active duplicates.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { enqueued: false, reason: 'duplicate_active', latencyMs: Date.now() - start };
      }
      console.error('[ReviewOutbox] enqueue failed:', (err as Error).message);
      return { enqueued: false, reason: 'error', latencyMs: Date.now() - start };
    }
  }

  /**
   * Atomically pick the highest-priority pending job and mark it leased.
   * Returns null if the queue is empty (or every pending job is gated by
   * attempts ≥ maxAttempts).
   *
   * The lease is owned by `workerOwner` until `lease_until` — past that the
   * caller should call `expireStaleLeases()` to recycle the job back to
   * pending.
   */
  leaseNext(input: {
    workerOwner: string;
    leaseDurationMs?: number;
    maxAttempts?: number;
  }): ReviewJob | null {
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const now = Date.now();
    const leaseUntil = now + leaseDurationMs;

    const tx = this.db.transaction((): unknown => {
      const candidate = this.db.prepare<unknown[], { id: string }>(`
        SELECT id FROM review_jobs
        WHERE state = 'pending' AND attempts < ?
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `).get(maxAttempts);
      if (!candidate) return null;

      this.db.prepare(`
        UPDATE review_jobs
        SET state = 'leased',
            lease_owner = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(input.workerOwner, leaseUntil, now, candidate.id);

      return this.db.prepare<unknown[], Parameters<typeof rowToJob>[0]>(
        'SELECT * FROM review_jobs WHERE id = ?',
      ).get(candidate.id);
    });
    const row = tx() as Parameters<typeof rowToJob>[0] | null;
    return row ? rowToJob(row) : null;
  }

  /** Mark a leased job as completed. Idempotent on a re-call (no-op). */
  markDone(jobId: string): void {
    this.db.prepare(`
      UPDATE review_jobs SET state = 'done', updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND state = 'leased'
    `).run(Date.now(), jobId);
  }

  /**
   * Mark a leased job failed. If `attempts < maxAttempts`, the job goes back
   * to pending so a future poll can retry; otherwise it lands in 'failed'
   * permanently. `lastError` is truncated to keep DB size bounded.
   */
  markFailed(jobId: string, lastError: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): void {
    const truncated = lastError.substring(0, 1000);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare<unknown[], { attempts: number }>(
        'SELECT attempts FROM review_jobs WHERE id = ?',
      ).get(jobId);
      if (!row) return;
      const nextState = row.attempts >= maxAttempts ? 'failed' : 'pending';
      this.db.prepare(`
        UPDATE review_jobs
        SET state = ?, last_error = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL
        WHERE id = ?
      `).run(nextState, truncated, now, jobId);
    });
    tx();
  }

  /**
   * Voluntarily release a lease without consuming an attempt. Used by the
   * worker when it leased a job but immediately determined the job has to
   * wait (cooldown, blocked dependency). The job goes back to pending and
   * keeps its existing attempts counter.
   */
  releaseLease(jobId: string): void {
    this.db.prepare(`
      UPDATE review_jobs
      SET state = 'pending', lease_owner = NULL, lease_until = NULL,
          attempts = MAX(0, attempts - 1), updated_at = ?
      WHERE id = ? AND state = 'leased'
    `).run(Date.now(), jobId);
  }

  /**
   * Recycle leased jobs whose lease has expired back to pending. Called by
   * the worker poll loop on each tick — cheap because the lease_until index
   * keeps the scan tight.
   */
  expireStaleLeases(now: number = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE review_jobs
      SET state = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE state = 'leased' AND lease_until < ?
    `).run(now, now);
    return result.changes;
  }

  /** Return counts grouped by state — used by the monitoring PR. */
  countByState(): Record<JobState, number> {
    const rows = this.db.prepare<unknown[], { state: JobState; n: number }>(
      'SELECT state, COUNT(*) as n FROM review_jobs GROUP BY state',
    ).all();
    const out: Record<JobState, number> = { pending: 0, leased: 0, done: 0, failed: 0 };
    for (const row of rows) {
      out[row.state] = row.n;
    }
    return out;
  }

  /**
   * Number of jobs created in the last 24h — feeds the daily-budget cap.
   * Uses created_at so retries/leases don't double-count.
   */
  dailyJobCount(now: number = Date.now()): number {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const row = this.db.prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) as n FROM review_jobs WHERE created_at >= ?',
    ).get(cutoff);
    return row?.n ?? 0;
  }

  /** Test helper — returns the full job row for assertions. */
  getJob(jobId: string): ReviewJob | null {
    const row = this.db.prepare<unknown[], Parameters<typeof rowToJob>[0]>(
      'SELECT * FROM review_jobs WHERE id = ?',
    ).get(jobId);
    return row ? rowToJob(row) : null;
  }

  /** Latest applied schema version — for migration tests. */
  schemaVersion(): number {
    const row = this.db.prepare<unknown[], { v: number | null }>(
      'SELECT MAX(version) as v FROM schema_migrations',
    ).get();
    return row?.v ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

class SnapshotReviewOutboxHandle extends ReviewOutboxHandle {
  private closed = false;

  constructor(
    db: Database.Database,
    private readonly snapshot: SqliteReadSnapshot,
  ) {
    super(db);
  }

  override close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      super.close();
    } finally {
      this.snapshot.cleanup();
    }
  }
}

/**
 * Open an existing review outbox without creating directories, migrating the
 * schema, or touching the source SQLite family. Monitoring callers use a
 * query-only temporary snapshot so active WAL rows remain visible without
 * creating or updating source `-wal/-shm` sidecars.
 */
export function openReviewOutboxReadOnly(
  opts: OutboxOptions = {},
): ReviewOutboxReadHandle | null {
  const dbPath = opts.dbPath || defaultDbPath();
  if (dbPath === ':memory:') return null;
  const snapshot = openSqliteReadSnapshot(dbPath);
  return snapshot
    ? new SnapshotReviewOutboxHandle(snapshot.database, snapshot)
    : null;
}

/** Surfaced for assertions without exporting the constants individually. */
export const __testing = { SCHEMA_VERSION_LATEST };
