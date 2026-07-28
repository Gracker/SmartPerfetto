// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SNAPSHOT_PREFIX = 'smartperfetto-sqlite-read-';
const DEFAULT_MAX_ATTEMPTS = 3;

interface FileStamp {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface SqliteFamilyStamp {
  database: FileStamp | null;
  wal: FileStamp | null;
  shm: FileStamp | null;
}

export interface SqliteReadSnapshot {
  database: Database.Database;
  cleanup: () => void;
}

function fileStamp(filePath: string): FileStamp | null {
  try {
    const stat = fs.statSync(filePath, {bigint: true});
    return {
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function familyStamp(dbPath: string): SqliteFamilyStamp {
  return {
    database: fileStamp(dbPath),
    wal: fileStamp(`${dbPath}-wal`),
    shm: fileStamp(`${dbPath}-shm`),
  };
}

function sameStamp(left: FileStamp | null, right: FileStamp | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFamily(
  left: SqliteFamilyStamp,
  right: SqliteFamilyStamp,
): boolean {
  return (
    sameStamp(left.database, right.database) &&
    sameStamp(left.wal, right.wal) &&
    sameStamp(left.shm, right.shm)
  );
}

function removeSnapshotDirectory(directory: string): void {
  fs.rmSync(directory, {recursive: true, force: true});
}

/**
 * Open a point-in-time SQLite copy for monitoring reads.
 *
 * SQLite's regular `readonly` open may still create or update `-wal/-shm`
 * files beside the source database. Copying the stable database family first
 * keeps all recovery and locking writes in a private temporary directory. The
 * WAL is copied so committed rows that have not been checkpointed remain
 * visible; SHM is deliberately rebuilt because it is an ephemeral WAL index.
 */
export function openSqliteReadSnapshot(
  dbPath: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): SqliteReadSnapshot | null {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = familyStamp(dbPath);
    if (!before.database) return null;

    const snapshotDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), SNAPSHOT_PREFIX),
    );
    fs.chmodSync(snapshotDirectory, 0o700);
    const snapshotPath = path.join(snapshotDirectory, 'snapshot.db');
    let database: Database.Database | null = null;
    try {
      fs.copyFileSync(dbPath, snapshotPath);
      if (before.wal) {
        fs.copyFileSync(`${dbPath}-wal`, `${snapshotPath}-wal`);
      }

      if (!sameFamily(before, familyStamp(dbPath))) {
        removeSnapshotDirectory(snapshotDirectory);
        continue;
      }

      database = new Database(snapshotPath, {fileMustExist: true});
      database.pragma('query_only = ON');
      database.pragma('busy_timeout = 5000');
      let cleaned = false;
      return {
        database,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          removeSnapshotDirectory(snapshotDirectory);
        },
      };
    } catch (error) {
      try {
        if (database?.open) database.close();
      } catch {
        // The source family was never opened; cleanup remains best effort.
      } finally {
        removeSnapshotDirectory(snapshotDirectory);
      }
      if (attempt === maxAttempts) throw error;
    }
  }
  throw new Error('sqlite_snapshot_changed_during_copy');
}

export const __testing = {
  SNAPSHOT_PREFIX,
  familyStamp,
  sameFamily,
};
