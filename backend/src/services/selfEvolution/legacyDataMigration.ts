// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {randomUUID} from 'crypto';
import Database from 'better-sqlite3';

import type {
  LegacySelfImproveMigrationResult,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {openSqliteReadSnapshot} from '../../utils/sqliteReadSnapshot';

const MIGRATION_MARKER = '.legacy-self-improve-migration-v1.json';
const MIGRATION_LOCK = '.self_improve-migration-lock.sqlite';
const SQLITE_DATABASE_NAME = /\.(?:db|sqlite|sqlite3)$/i;
const SQLITE_SIDECAR_NAME = /\.(?:db|sqlite|sqlite3)-(?:wal|shm)$/i;
const STABLE_COPY_ATTEMPTS = 3;

export interface MigrateLegacySelfImproveDataOptions {
  persistence: SelfEvolutionPersistenceCapability;
  destinationPath?: string;
  sourceCandidates?: readonly string[];
  now?: () => Date;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) return code;
  return error instanceof Error && error.message
    ? error.message
    : 'unknown_error';
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), {code});
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function containsSymbolicLink(root: string): boolean {
  if (fs.lstatSync(root).isSymbolicLink()) return true;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory()) pending.push(entryPath);
    }
  }
  return false;
}

interface LockFileIdentity {
  device: bigint;
  inode: bigint;
}

function lockFileIdentity(lockPath: string): LockFileIdentity {
  const stat = fs.lstatSync(lockPath, {bigint: true});
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw codedError('migration_lock_path_not_regular');
  }
  return {device: stat.dev, inode: stat.ino};
}

function sameLockFile(
  left: LockFileIdentity,
  right: LockFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function prepareMigrationLockFile(lockPath: string): LockFileIdentity {
  try {
    return lockFileIdentity(lockPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return lockFileIdentity(lockPath);
}

function acquireMigrationLock(lockPath: string): Database.Database {
  let database: Database.Database | null = null;
  try {
    const expectedIdentity = prepareMigrationLockFile(lockPath);
    database = new Database(lockPath, {
      timeout: 0,
      fileMustExist: true,
    });
    if (!sameLockFile(expectedIdentity, lockFileIdentity(lockPath))) {
      throw codedError('migration_lock_path_changed');
    }
    database.pragma('busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
    database.exec(`
      CREATE TABLE IF NOT EXISTS migration_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_owner_pid INTEGER NOT NULL,
        last_acquired_at TEXT NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO migration_lock_metadata(singleton, last_owner_pid, last_acquired_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        last_owner_pid = excluded.last_owner_pid,
        last_acquired_at = excluded.last_acquired_at
    `).run(process.pid, new Date().toISOString());
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Closing releases any partially acquired SQLite lock.
    }
    const code = errorCode(error);
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      throw codedError('migration_lock_held');
    }
    throw error;
  }
}

function releaseMigrationLock(database: Database.Database): void {
  try {
    if (database.inTransaction) database.exec('COMMIT');
  } finally {
    database.close();
  }
}

function candidatePaths(packageRoot: string): string[] {
  return [
    path.join(packageRoot, 'backend', 'data', 'self_improve'),
    path.join(packageRoot, 'data', 'self_improve'),
  ];
}

function findSource(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw codedError('legacy_migration_symlink_not_allowed');
      }
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
  }
  return null;
}

interface StableFileStamp {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

function stableFileStamp(filePath: string): StableFileStamp {
  const stat = fs.lstatSync(filePath, {bigint: true});
  if (!stat.isFile()) throw codedError('legacy_migration_non_regular_file');
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs,
  };
}

function sameStableFile(
  left: StableFileStamp,
  right: StableFileStamp,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  );
}

function copyStableRegularFile(sourcePath: string, destinationPath: string): void {
  for (let attempt = 0; attempt < STABLE_COPY_ATTEMPTS; attempt++) {
    const temporaryPath = `${destinationPath}.partial-${attempt}-${randomUUID()}`;
    const before = stableFileStamp(sourcePath);
    try {
      fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      const after = stableFileStamp(sourcePath);
      if (sameStableFile(before, after)) {
        fs.renameSync(temporaryPath, destinationPath);
        return;
      }
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }
  }
  throw codedError('legacy_migration_source_changed_during_copy');
}

function copySqliteSnapshot(sourcePath: string, destinationPath: string): void {
  const sourceBefore = stableFileStamp(sourcePath);
  const snapshot = openSqliteReadSnapshot(sourcePath);
  if (!snapshot) throw codedError('legacy_migration_source_disappeared');
  let descriptor: number | undefined;
  try {
    const sourceAfter = stableFileStamp(sourcePath);
    if (!sameStableFile(sourceBefore, sourceAfter)) {
      throw codedError('legacy_migration_source_changed_during_copy');
    }
    const quickCheck = snapshot.database.pragma('quick_check', {simple: true});
    if (quickCheck !== 'ok') throw codedError('legacy_migration_sqlite_integrity_failed');
    const image = snapshot.database.serialize();
    descriptor = fs.openSync(destinationPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, image);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      snapshot.database.close();
    } finally {
      snapshot.cleanup();
    }
  }
}

interface LegacyTreeEntry {
  sourcePath: string;
  relativePath: string;
  kind: 'directory' | 'regular' | 'sqlite';
}

function inventoryLegacyTree(root: string): LegacyTreeEntry[] {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw codedError('legacy_migration_symlink_not_allowed');
  }
  if (!rootStat.isDirectory()) {
    throw codedError('legacy_migration_source_not_directory');
  }

  const entries: LegacyTreeEntry[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() as string;
    const sourceDirectory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(sourceDirectory, {withFileTypes: true})) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const sourcePath = path.join(root, relativePath);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        throw codedError('legacy_migration_symlink_not_allowed');
      }
      if (stat.isDirectory()) {
        entries.push({sourcePath, relativePath, kind: 'directory'});
        pending.push(relativePath);
      } else if (stat.isFile() && !SQLITE_SIDECAR_NAME.test(entry.name)) {
        entries.push({
          sourcePath,
          relativePath,
          kind: SQLITE_DATABASE_NAME.test(entry.name) ? 'sqlite' : 'regular',
        });
      } else if (!stat.isFile()) {
        throw codedError('legacy_migration_non_regular_file');
      }
    }
  }
  return entries;
}

function copyLegacyTree(sourceRoot: string, stagingRoot: string): void {
  const entries = inventoryLegacyTree(sourceRoot);
  fs.mkdirSync(stagingRoot, {mode: 0o700});
  for (const entry of entries) {
    const destinationPath = path.join(stagingRoot, entry.relativePath);
    if (entry.kind === 'directory') {
      fs.mkdirSync(destinationPath, {mode: 0o700});
    } else if (entry.kind === 'sqlite') {
      copySqliteSnapshot(entry.sourcePath, destinationPath);
    } else {
      copyStableRegularFile(entry.sourcePath, destinationPath);
    }
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isCompletedMigration(destinationPath: string): boolean {
  const markerPath = path.join(destinationPath, MIGRATION_MARKER);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return (
      marker?.schemaVersion === 1 &&
      typeof marker?.sourcePath === 'string' &&
      typeof marker?.migratedAt === 'string'
    );
  } catch {
    return false;
  }
}

export function migrateLegacySelfImproveData(
  options: MigrateLegacySelfImproveDataOptions,
): LegacySelfImproveMigrationResult {
  const {persistence} = options;
  if (persistence.persistence !== 'available') {
    return {status: 'not_attempted_persistence_unavailable'};
  }

  const destinationPath = path.resolve(
    options.destinationPath ?? path.join(persistence.dataRoot, 'self_improve'),
  );
  let sourcePath: string | null;
  try {
    sourcePath = findSource(
      options.sourceCandidates ?? candidatePaths(persistence.packageRoot),
    );
  } catch (error) {
    return {
      status: 'failed',
      destinationPath,
      errorCode: errorCode(error),
    };
  }
  if (!sourcePath) {
    return {status: 'source_not_found', destinationPath};
  }
  if (sourcePath === destinationPath) {
    return {
      status: 'source_matches_destination',
      sourcePath,
      destinationPath,
    };
  }
  if (fs.existsSync(destinationPath)) {
    return {
      status: isCompletedMigration(destinationPath)
        ? 'already_migrated'
        : 'blocked_destination_exists',
      sourcePath,
      destinationPath,
    };
  }

  const destinationParent = path.dirname(destinationPath);
  const now = options.now ?? (() => new Date());
  const migrationId = `${process.pid}-${now().getTime()}-${randomUUID()}`;
  const stagingPath = path.join(destinationParent, `.self_improve-migration-${migrationId}`);
  const lockPath = path.join(destinationParent, MIGRATION_LOCK);
  let migrationLock: Database.Database | null = null;
  try {
    fs.mkdirSync(destinationParent, {recursive: true, mode: 0o700});
    migrationLock = acquireMigrationLock(lockPath);
    if (fs.existsSync(destinationPath)) {
      return {
        status: isCompletedMigration(destinationPath)
          ? 'already_migrated'
          : 'blocked_destination_exists',
        sourcePath,
        destinationPath,
      };
    }
    if (containsSymbolicLink(sourcePath)) {
      throw codedError('legacy_migration_symlink_not_allowed');
    }

    copyLegacyTree(sourcePath, stagingPath);
    if (containsSymbolicLink(stagingPath)) {
      throw codedError('legacy_migration_symlink_not_allowed');
    }
    fs.writeFileSync(
      path.join(stagingPath, MIGRATION_MARKER),
      `${JSON.stringify({
        schemaVersion: 1,
        sourcePath,
        migratedAt: now().toISOString(),
      }, null, 2)}\n`,
      {encoding: 'utf8', mode: 0o600, flag: 'wx'},
    );
    fs.renameSync(stagingPath, destinationPath);
    return {
      status: 'migrated',
      sourcePath,
      destinationPath,
    };
  } catch (error) {
    try {
      if (pathExists(stagingPath)) {
        fs.rmSync(stagingPath, {recursive: true, force: true});
      }
    } catch {
      // The migration remains failed; never touch the legacy source.
    }
    return {
      status: 'failed',
      sourcePath,
      destinationPath,
      errorCode: errorCode(error),
    };
  } finally {
    if (migrationLock) {
      try {
        releaseMigrationLock(migrationLock);
      } catch {
        // Closing the database releases the OS lock even if commit failed.
      }
    }
  }
}

export const __testing = {
  MIGRATION_LOCK,
  MIGRATION_MARKER,
  containsSymbolicLink,
  copyLegacyTree,
  candidatePaths,
  findSource,
};
