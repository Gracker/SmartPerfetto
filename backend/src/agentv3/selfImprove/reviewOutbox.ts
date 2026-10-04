// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Read-only view of the legacy review-agent outbox.
 *
 * The background review agent that wrote this SQLite store was never wired
 * into application startup and has been removed. Older installs may still
 * hold a `review_jobs` table at `<data>/self_improve/self_improve.db`; the
 * metrics dashboard keeps reporting its counts, so only the read side
 * remains. Nothing in the product creates, migrates, or writes this store.
 *
 * See docs/architecture/self-improving-design.md "存储与安全".
 */

import type Database from 'better-sqlite3';
import {backendDataPath} from '../../runtimePaths';
import {
  openSqliteReadSnapshot,
  type SqliteReadSnapshot,
} from '../../utils/sqliteReadSnapshot';

export type JobState = 'pending' | 'leased' | 'done' | 'failed';

export interface OutboxOptions {
  /** Override default DB path for tests. Pass ':memory:' for an ephemeral store. */
  dbPath?: string;
}

export interface ReviewOutboxReadHandle {
  countByState(): Record<JobState, number>;
  dailyJobCount(now?: number): number;
  close(): void;
}

function defaultDbPath(): string {
  return backendDataPath('self_improve', 'self_improve.db');
}

class SnapshotReviewOutboxHandle implements ReviewOutboxReadHandle {
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly snapshot: SqliteReadSnapshot,
  ) {}

  /** Return counts grouped by state. */
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

  /** Number of jobs created in the last 24h; retries never double-count. */
  dailyJobCount(now: number = Date.now()): number {
    const cutoff = now - 24 * 60 * 60 * 1000;
    const row = this.db.prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) as n FROM review_jobs WHERE created_at >= ?',
    ).get(cutoff);
    return row?.n ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
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
