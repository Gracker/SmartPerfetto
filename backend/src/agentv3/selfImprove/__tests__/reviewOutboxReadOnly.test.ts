// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {openReviewOutboxReadOnly} from '../reviewOutbox';
import {__testing as sqliteSnapshotTesting} from '../../../utils/sqliteReadSnapshot';

describe('openReviewOutboxReadOnly', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-review-outbox-ro-'));
    dbPath = path.join(root, 'nested', 'review.db');
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function sqliteFamily(): Map<string, Buffer> {
    if (!fs.existsSync(path.dirname(dbPath))) return new Map();
    return new Map(
      fs.readdirSync(path.dirname(dbPath))
        .filter((name) => name.startsWith(path.basename(dbPath)))
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(path.dirname(dbPath), name)),
        ]),
    );
  }

  /**
   * Seed a store with the schema the removed review-agent writer created, so
   * the read side is exercised against the data older installs still hold.
   */
  function openLegacyOutbox(): Database.Database {
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_jobs (
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
    `);
    return db;
  }

  function enqueue(db: Database.Database, id: string): void {
    const now = Date.now();
    db.prepare(`
      INSERT INTO review_jobs (id, state, dedupe_key, created_at, updated_at, payload_json)
      VALUES (?, 'pending', ?, ?, ?, '{}')
    `).run(id, id, now, now);
  }

  function snapshotDirectories(): string[] {
    return fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(sqliteSnapshotTesting.SNAPSHOT_PREFIX))
      .sort();
  }

  it('returns null without creating a directory or database', () => {
    expect(openReviewOutboxReadOnly({dbPath})).toBeNull();
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  it('reads an existing outbox without changing its SQLite family', () => {
    const writable = openLegacyOutbox();
    enqueue(writable, 'job-1');
    writable.close();
    const before = sqliteFamily();
    const snapshotsBefore = snapshotDirectories();

    const readonly = openReviewOutboxReadOnly({dbPath});
    expect(readonly?.countByState()).toEqual({
      pending: 1,
      leased: 0,
      done: 0,
      failed: 0,
    });
    expect(readonly?.dailyJobCount()).toBe(1);
    readonly?.close();

    expect(sqliteFamily()).toEqual(before);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });

  it('reads committed active-WAL rows without touching source sidecars', () => {
    const writable = openLegacyOutbox();
    enqueue(writable, 'wal-job');
    const before = sqliteFamily();
    expect([...before.keys()]).toContain(`${path.basename(dbPath)}-wal`);

    const readonly = openReviewOutboxReadOnly({dbPath});
    expect(readonly?.countByState().pending).toBe(1);
    readonly?.close();

    expect(sqliteFamily()).toEqual(before);
    writable.close();
  });

  it('reads through a query-only connection', () => {
    openLegacyOutbox().close();
    const readonly = openReviewOutboxReadOnly({dbPath});
    try {
      const connection = (readonly as unknown as {db: Database.Database}).db;
      expect(() => enqueue(connection, 'no-write')).toThrow(/readonly|query_only/i);
      expect(readonly?.countByState()).toEqual({
        pending: 0,
        leased: 0,
        done: 0,
        failed: 0,
      });
    } finally {
      readonly?.close();
    }
  });
});
