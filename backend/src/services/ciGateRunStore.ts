// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CiGateRunStore — durable, SQLite-backed log of every CI gate
 * evaluation (Plan 51 first slice).
 *
 * SQLite (rather than JSON) because CI runs are append-heavy, queried
 * by gate/status/source/createdAt, and referenced by IM/Bug/PR
 * adapters that need a durable index. The schema is intentionally
 * narrow — full record JSON in a `payload` column, indexed columns
 * carry only what the list/filter API needs. That keeps migrations
 * cheap and lets new fields land without breaking older readers.
 *
 * Retention: a 90-day window enforced inside the same transaction as
 * each insert, so a long-lived process never lets old rows grow
 * unbounded.
 */

import * as fs from 'fs';
import * as path from 'path';

import Database from './sqliteDatabase';

import {backendDataPath} from '../runtimePaths';
import type {CiGateRunRecord} from '../types/ciGateContracts';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface MigrationStep {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    up: db => {
      db.exec(`
        CREATE TABLE ci_gate_runs (
          run_id TEXT PRIMARY KEY,
          gate_id TEXT NOT NULL,
          baseline_id TEXT NOT NULL,
          ci_source TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE INDEX idx_ci_gate_runs_created_at ON ci_gate_runs(created_at);
        CREATE INDEX idx_ci_gate_runs_gate_created ON ci_gate_runs(gate_id, created_at);
        CREATE INDEX idx_ci_gate_runs_status_created ON ci_gate_runs(status, created_at);
        CREATE INDEX idx_ci_gate_runs_source ON ci_gate_runs(ci_source);
      `);
    },
  },
];

export interface CiGateRunStoreOptions {
  /** Override the on-disk database path. `:memory:` for ephemeral tests. */
  dbPath?: string;
  /** Override the retention window for tests. */
  retentionMs?: number;
}

function defaultDbPath(): string {
  return backendDataPath('ci_gate', 'ci_gate_runs.db');
}

export interface CiGateRunListOptions {
  gateId?: string;
  status?: CiGateRunRecord['result']['status'];
  ciSource?: string;
  /** Newest-first cap; defaults to 50, hard ceiling 200. */
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * SQLite-backed store. Wraps a single connection — single-process
 * writers only, mirroring `BaselineStore`. Tests should construct
 * with `dbPath: ':memory:'` so each suite gets an isolated store.
 */
export class CiGateRunStore {
  private readonly db: Database.Database;
  private readonly retentionMs: number;
  // Prepared statements are compiled once at construction. better-sqlite3
  // does not cache `prepare()` calls, so re-preparing on every recordRun
  // would burn parser time on the CI hot path.
  private readonly insertStmt: Database.Statement<unknown[]>;
  private readonly evictStmt: Database.Statement<unknown[]>;
  private readonly getStmt: Database.Statement<unknown[]>;

  constructor(opts: CiGateRunStoreOptions = {}) {
    const dbPath = opts.dbPath ?? defaultDbPath();
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.applyMigrations();
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.insertStmt = this.db.prepare(`
      INSERT INTO ci_gate_runs
        (run_id, gate_id, baseline_id, ci_source, status, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.evictStmt = this.db.prepare(
      'DELETE FROM ci_gate_runs WHERE created_at < ?',
    );
    this.getStmt = this.db.prepare(
      'SELECT payload FROM ci_gate_runs WHERE run_id = ?',
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Append a run. Eviction of expired rows runs inside the same
   * transaction so a long-lived process never accumulates beyond the
   * retention window — an important property for the tests that
   * exercise this through the route layer.
   */
  recordRun(record: CiGateRunRecord): void {
    const cutoff = Date.now() - this.retentionMs;
    const tx = this.db.transaction(() => {
      this.insertStmt.run(
        record.runId,
        record.gateId,
        record.baselineId,
        record.ciSource,
        record.result.status,
        record.createdAt,
        JSON.stringify(record),
      );
      this.evictStmt.run(cutoff);
    });
    tx();
  }

  getRun(runId: string): CiGateRunRecord | undefined {
    const row = this.getStmt.get(runId) as {payload: string} | undefined;
    if (!row) return undefined;
    return safeParse(row.payload);
  }

  listRuns(opts: CiGateRunListOptions = {}): CiGateRunRecord[] {
    const limit = clampLimit(opts.limit);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.gateId) {
      where.push('gate_id = ?');
      params.push(opts.gateId);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.ciSource) {
      where.push('ci_source = ?');
      params.push(opts.ciSource);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql =
      `SELECT payload FROM ci_gate_runs ${whereSql} ` +
      'ORDER BY created_at DESC, run_id DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{payload: string}>;
    return rows
      .map(r => safeParse(r.payload))
      .filter((r): r is CiGateRunRecord => Boolean(r));
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      this.db
        .prepare<unknown[], {version: number}>(
          'SELECT version FROM schema_migrations',
        )
        .all()
        .map(r => r.version),
    );
    for (const step of MIGRATIONS) {
      if (applied.has(step.version)) continue;
      const tx = this.db.transaction(() => {
        step.up(this.db);
        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          )
          .run(step.version, Date.now());
      });
      tx();
    }
  }
}

function clampLimit(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_LIST_LIMIT;
  }
  if (requested < 1) return 1;
  if (requested > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return Math.floor(requested);
}

function safeParse(payload: string): CiGateRunRecord | undefined {
  try {
    return JSON.parse(payload) as CiGateRunRecord;
  } catch {
    return undefined;
  }
}
