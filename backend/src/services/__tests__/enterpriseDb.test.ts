// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  openEnterpriseDb,
  resolveEnterpriseDbPath,
  ENTERPRISE_DB_PATH_ENV,
} from '../enterpriseDb';

describe('enterprise SQLite WAL database', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test('resolves the configured database path', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-db-'));
    const configuredPath = path.join(tmpDir, 'enterprise.sqlite');

    expect(resolveEnterpriseDbPath({
      [ENTERPRISE_DB_PATH_ENV]: configuredPath,
    } as NodeJS.ProcessEnv)).toBe(configuredPath);
  });

  test('places the default database under the configured backend data directory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-db-'));

    expect(resolveEnterpriseDbPath({
      SMARTPERFETTO_BACKEND_DATA_DIR: tmpDir,
    } as NodeJS.ProcessEnv)).toBe(path.join(tmpDir, 'sessions', 'sessions.db'));
  });

  test('opens SQLite with WAL, foreign keys, busy timeout, and schema migrations', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-db-'));
    const dbPath = path.join(tmpDir, 'enterprise.sqlite');
    const db = openEnterpriseDb(dbPath);

    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);

      const rows = db.prepare<unknown[], { version: number }>(
        'SELECT version FROM enterprise_schema_migrations ORDER BY version',
      ).all();
      expect(rows).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
      ]);
    } finally {
      db.close();
    }
  });

  test('allows a writer to commit while another WAL connection holds a read transaction', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-db-'));
    const dbPath = path.join(tmpDir, 'enterprise.sqlite');
    const reader = openEnterpriseDb(dbPath);
    const writer = openEnterpriseDb(dbPath);

    try {
      reader.prepare('BEGIN').run();
      expect(reader.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 0 });

      writer.prepare(`
        INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
        VALUES ('tenant-wal', 'Tenant WAL', 'active', 'enterprise', 1, 1)
      `).run();

      expect(writer.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });
      expect(reader.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 0 });

      reader.prepare('COMMIT').run();
      expect(reader.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });
    } finally {
      try {
        reader.prepare('ROLLBACK').run();
      } catch {
        // Transaction may already be committed.
      }
      reader.close();
      writer.close();
    }
  });
});
