// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Persistent store for supersede markers (PR9b).
 *
 * Each marker records a `failureModeHash` whose root cause has supposedly
 * been fixed by a strategy patch. Future occurrences of the same hash get
 * downweighted at injection time so the agent doesn't keep tripping over
 * a failure mode the system already addressed.
 *
 * The state machine intentionally splits "patch landed on main"
 * (`active_canary`) from "patch survived the observation window" (`active`)
 * — recurrence during the canary period flips the marker to `failed` and
 * restores the old negative-pattern weight. This is the §12 design point
 * Codex flagged in Round 4: a green CI is not the same as a real fix.
 *
 * See docs/architecture/self-improving-design.md "组件级 Review 与 Patch 边界".
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {backendDataPath} from '../../runtimePaths';
import {
  openSqliteReadSnapshot,
  type SqliteReadSnapshot,
} from '../../utils/sqliteReadSnapshot';

export type SupersedeState =
  | 'pending_review'
  | 'active_canary'
  | 'active'
  | 'failed'
  | 'rejected'
  | 'drifted'
  | 'reverted';

export interface SupersedeMarker {
  id: string;
  failureModeHash: string;
  strategyFile: string;
  strategyContentHash: string;
  patchFingerprint: string;
  phaseHintId: string | null;
  gitCommit: string | null;
  prNumber: number | null;
  state: SupersedeState;
  createdAt: number;
  updatedAt: number;
  observationStartedAt: number | null;
  observationDays: number;
  observationCount: number;
  observationCountTarget: number;
  recurrenceCount: number;
  lastError: string | null;
}

export interface UpsertMarkerInput {
  failureModeHash: string;
  strategyFile: string;
  strategyContentHash: string;
  patchFingerprint: string;
  phaseHintId?: string;
  gitCommit?: string;
  prNumber?: number;
  observationDays?: number;
  observationCountTarget?: number;
}

export interface SupersedeStoreOptions {
  dbPath?: string;
}

export interface SupersedeStoreReadHandle {
  findActiveByHash(failureModeHash: string): SupersedeMarker | null;
  countByState(): Record<SupersedeState, number>;
  close(): void;
}

const DEFAULT_OBSERVATION_DAYS = 7;
const DEFAULT_OBSERVATION_COUNT_TARGET = 5;

interface MigrationStep {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: ReadonlyArray<MigrationStep> = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE supersede_markers (
          id TEXT PRIMARY KEY,
          failure_mode_hash TEXT NOT NULL,
          strategy_file TEXT NOT NULL,
          strategy_content_hash TEXT NOT NULL,
          patch_fingerprint TEXT NOT NULL,
          phase_hint_id TEXT,
          git_commit TEXT,
          pr_number INTEGER,
          state TEXT NOT NULL CHECK(state IN (
            'pending_review','active_canary','active',
            'failed','rejected','drifted','reverted'
          )),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          observation_started_at INTEGER,
          observation_days INTEGER NOT NULL DEFAULT 7,
          observation_count INTEGER NOT NULL DEFAULT 0,
          observation_count_target INTEGER NOT NULL DEFAULT 5,
          recurrence_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        CREATE INDEX idx_supersede_hash ON supersede_markers(failure_mode_hash);
        CREATE INDEX idx_supersede_state ON supersede_markers(state);
        CREATE UNIQUE INDEX idx_supersede_active_per_hash
          ON supersede_markers(failure_mode_hash)
          WHERE state IN ('pending_review','active_canary','active','drifted');
      `);
    },
  },
];

function defaultDbPath(): string {
  return backendDataPath('self_improve', 'supersede.db');
}

export function openSupersedeStore(opts: SupersedeStoreOptions = {}): SupersedeStoreHandle {
  const dbPath = opts.dbPath || defaultDbPath();

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare<unknown[], { version: number }>('SELECT version FROM schema_migrations').all().map(r => r.version),
  );
  for (const step of MIGRATIONS) {
    if (applied.has(step.version)) continue;
    const tx = db.transaction(() => {
      step.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(step.version, Date.now());
    });
    tx();
  }

  return new SupersedeStoreHandle(db);
}

interface MarkerRow {
  id: string;
  failure_mode_hash: string;
  strategy_file: string;
  strategy_content_hash: string;
  patch_fingerprint: string;
  phase_hint_id: string | null;
  git_commit: string | null;
  pr_number: number | null;
  state: SupersedeState;
  created_at: number;
  updated_at: number;
  observation_started_at: number | null;
  observation_days: number;
  observation_count: number;
  observation_count_target: number;
  recurrence_count: number;
  last_error: string | null;
}

function rowToMarker(row: MarkerRow): SupersedeMarker {
  return {
    id: row.id,
    failureModeHash: row.failure_mode_hash,
    strategyFile: row.strategy_file,
    strategyContentHash: row.strategy_content_hash,
    patchFingerprint: row.patch_fingerprint,
    phaseHintId: row.phase_hint_id,
    gitCommit: row.git_commit,
    prNumber: row.pr_number,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observationStartedAt: row.observation_started_at,
    observationDays: row.observation_days,
    observationCount: row.observation_count,
    observationCountTarget: row.observation_count_target,
    recurrenceCount: row.recurrence_count,
    lastError: row.last_error,
  };
}

export class SupersedeStoreHandle {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new marker in `pending_review` state, or return null if a
   * marker for the same hash already exists in an active state. Callers
   * decide whether the duplicate is a problem; this returns null silently
   * so the caller can branch without try/catch.
   */
  createPendingReview(input: UpsertMarkerInput): SupersedeMarker | null {
    const id = `sup-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO supersede_markers (
          id, failure_mode_hash, strategy_file, strategy_content_hash,
          patch_fingerprint, phase_hint_id, git_commit, pr_number, state,
          created_at, updated_at, observation_days, observation_count_target
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?)
      `).run(
        id,
        input.failureModeHash,
        input.strategyFile,
        input.strategyContentHash,
        input.patchFingerprint,
        input.phaseHintId ?? null,
        input.gitCommit ?? null,
        input.prNumber ?? null,
        now,
        now,
        input.observationDays ?? DEFAULT_OBSERVATION_DAYS,
        input.observationCountTarget ?? DEFAULT_OBSERVATION_COUNT_TARGET,
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return null;
      }
      throw err;
    }
    return this.getById(id);
  }

  /**
   * Promote a pending_review marker to active_canary because its PR merged.
   * No-op (returns null) if the marker is not in pending_review state, so
   * callers can safely retry without compensating logic.
   */
  startCanaryObservation(input: {
    failureModeHash: string;
    strategyContentHash?: string;
    patchFingerprint?: string;
    gitCommit?: string;
  }): SupersedeMarker | null {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.findActiveByHash(input.failureModeHash);
      if (!row || row.state !== 'pending_review') return null;
      this.db.prepare(`
        UPDATE supersede_markers
        SET state = 'active_canary',
            observation_started_at = ?,
            updated_at = ?,
            strategy_content_hash = COALESCE(?, strategy_content_hash),
            patch_fingerprint = COALESCE(?, patch_fingerprint),
            git_commit = COALESCE(?, git_commit)
        WHERE id = ?
      `).run(
        now, now,
        input.strategyContentHash ?? null,
        input.patchFingerprint ?? null,
        input.gitCommit ?? null,
        row.id,
      );
      return this.getById(row.id);
    });
    return tx();
  }

  /**
   * Record one full-path analysis observation against the active_canary
   * marker for `failureModeHash` and return the (possibly transitioned)
   * marker. Once `observationCount` reaches `observationCountTarget` and
   * the elapsed time exceeds `observationDays`, the marker auto-promotes
   * to `active`.
   */
  recordObservation(failureModeHash: string, now: number = Date.now()): SupersedeMarker | null {
    const tx = this.db.transaction(() => {
      const row = this.findActiveByHash(failureModeHash);
      if (!row || row.state !== 'active_canary') return null;
      this.db.prepare(`
        UPDATE supersede_markers
        SET observation_count = observation_count + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      const updated = this.getById(row.id)!;
      if (
        updated.observationCount >= updated.observationCountTarget &&
        updated.observationStartedAt !== null &&
        now - updated.observationStartedAt >= updated.observationDays * 24 * 60 * 60 * 1000
      ) {
        this.db.prepare(`
          UPDATE supersede_markers SET state = 'active', updated_at = ? WHERE id = ?
        `).run(now, updated.id);
        return this.getById(updated.id);
      }
      return updated;
    });
    return tx();
  }

  /**
   * Recurrence detected — flip an active_canary marker back to `failed` so
   * the old negative-pattern weight is restored. Returns the marker that
   * was failed (null if there was nothing to fail).
   */
  recordRecurrence(failureModeHash: string): SupersedeMarker | null {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.findActiveByHash(failureModeHash);
      if (!row || row.state !== 'active_canary') return null;
      this.db.prepare(`
        UPDATE supersede_markers
        SET state = 'failed',
            recurrence_count = recurrence_count + 1,
            updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      return this.getById(row.id);
    });
    return tx();
  }

  /** Mark the marker `rejected` because the PR was closed without merge. */
  markRejected(failureModeHash: string): SupersedeMarker | null {
    return this.transitionTo(failureModeHash, 'rejected', { allowedFrom: ['pending_review'] });
  }

  /** Drift transition (pure write — caller has already detected drift). */
  markDrifted(failureModeHash: string): SupersedeMarker | null {
    return this.transitionTo(failureModeHash, 'drifted', { allowedFrom: ['active_canary', 'active'] });
  }

  /** Patch was reverted on main — restore old weights. */
  markReverted(failureModeHash: string): SupersedeMarker | null {
    return this.transitionTo(failureModeHash, 'reverted', { allowedFrom: ['active_canary', 'active', 'drifted'] });
  }

  /**
   * Returns the currently active (or canary) marker for a failure-mode hash,
   * or null. "Active" here means any state in which the marker still
   * influences injection weights (i.e. excludes `failed`, `rejected`,
   * `reverted`).
   */
  findActiveByHash(failureModeHash: string): SupersedeMarker | null {
    const row = this.db.prepare<unknown[], MarkerRow>(`
      SELECT * FROM supersede_markers
      WHERE failure_mode_hash = ?
      AND state IN ('pending_review','active_canary','active','drifted')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(failureModeHash);
    return row ? rowToMarker(row) : null;
  }

  getById(id: string): SupersedeMarker | null {
    const row = this.db.prepare<unknown[], MarkerRow>(
      'SELECT * FROM supersede_markers WHERE id = ?',
    ).get(id);
    return row ? rowToMarker(row) : null;
  }

  /** Used by tests + the monitoring PR. */
  countByState(): Record<SupersedeState, number> {
    const rows = this.db.prepare<unknown[], { state: SupersedeState; n: number }>(
      'SELECT state, COUNT(*) as n FROM supersede_markers GROUP BY state',
    ).all();
    const result: Record<SupersedeState, number> = {
      pending_review: 0,
      active_canary: 0,
      active: 0,
      failed: 0,
      rejected: 0,
      drifted: 0,
      reverted: 0,
    };
    for (const r of rows) result[r.state] = r.n;
    return result;
  }

  schemaVersion(): number {
    const row = this.db.prepare<unknown[], { v: number | null }>(
      'SELECT MAX(version) as v FROM schema_migrations',
    ).get();
    return row?.v ?? 0;
  }

  close(): void {
    this.db.close();
  }

  private transitionTo(
    failureModeHash: string,
    target: SupersedeState,
    constraints: { allowedFrom: SupersedeState[] },
  ): SupersedeMarker | null {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const row = this.findActiveByHash(failureModeHash);
      if (!row || !constraints.allowedFrom.includes(row.state)) return null;
      this.db.prepare(`
        UPDATE supersede_markers SET state = ?, updated_at = ? WHERE id = ?
      `).run(target, now, row.id);
      return this.getById(row.id);
    });
    return tx();
  }
}

class SnapshotSupersedeStoreHandle extends SupersedeStoreHandle {
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
 * Read-only handle factory for callers (recall_patterns and the
 * future stdio MCP host) that must NOT create / migrate / mutate
 * the supersede store.
 *
 * Returns null when the store does not yet exist on disk, signalling
 * the caller to fall back to the no-marker default (weight 1.0).
 * This is the prerequisite from Plan 41 M1a for upgrading
 * `recall_patterns` from `internal` back to `public-readonly`
 * exposure: `openSupersedeStore` triggers `mkdir` + sqlite migration
 * which is incompatible with read-only classification, while this
 * adapter performs no writes.
 *
 * The adapter reads a query-only temporary snapshot, including committed WAL
 * frames. SQLite never opens the source family, so monitoring and recall do
 * not create or update source sidecars.
 */
export function openSupersedeStoreReadOnly(
  opts: SupersedeStoreOptions = {},
): SupersedeStoreReadHandle | null {
  const dbPath = opts.dbPath || defaultDbPath();
  if (dbPath === ':memory:') {
    // :memory: stores are caller-private; a read-only adapter has no
    // shared state to surface. Tell the caller "no data" rather than
    // returning a handle that is guaranteed empty.
    return null;
  }
  const snapshot = openSqliteReadSnapshot(dbPath);
  return snapshot
    ? new SnapshotSupersedeStoreHandle(snapshot.database, snapshot)
    : null;
}

/**
 * Injection-time weight modifier for a failure mode. Returns 1.0 when no
 * marker is active, the §4 weight otherwise. Pure read-only — callers are
 * the negative-pattern injection path and the monitoring dashboard.
 */
export function injectionWeightForSupersede(marker: SupersedeMarker | null): number {
  if (!marker) return 1.0;
  switch (marker.state) {
    case 'active': return 0.1;
    case 'active_canary': return 0.5;
    case 'drifted': return 0.5;
    case 'pending_review': return 1.0;       // PR not merged yet
    case 'failed': return 1.0;               // restored
    case 'rejected': return 1.0;             // restored
    case 'reverted': return 1.0;             // restored
  }
}

export const __testing = { DEFAULT_OBSERVATION_DAYS, DEFAULT_OBSERVATION_COUNT_TARGET };
