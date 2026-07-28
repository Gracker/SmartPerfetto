// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import type {SelfEvolutionPersistenceCapability} from '../../../types/selfEvolution';
import {
  __testing,
  migrateLegacySelfImproveData,
} from '../legacyDataMigration';

describe('migrateLegacySelfImproveData', () => {
  let root: string;
  let packageRoot: string;
  let dataRoot: string;
  let sourcePath: string;
  let destinationPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-self-evolution-migration-'));
    packageRoot = path.join(root, 'package');
    dataRoot = path.join(root, 'external-data');
    sourcePath = path.join(packageRoot, 'backend', 'data', 'self_improve');
    destinationPath = path.join(dataRoot, 'self_improve');
    fs.mkdirSync(sourcePath, {recursive: true});
    const database = new Database(path.join(sourcePath, 'case_evolution.db'));
    database.exec('CREATE TABLE legacy_state(value TEXT NOT NULL)');
    database.prepare('INSERT INTO legacy_state(value) VALUES (?)').run('legacy-db');
    database.close();
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function capability(
    state: 'available' | 'unavailable' = 'available',
  ): SelfEvolutionPersistenceCapability {
    return {
      persistence: state,
      ...(state === 'unavailable'
        ? {reason: 'data_root_inside_package' as const}
        : {}),
      configured: true,
      writable: true,
      outsidePackage: state === 'available',
      externalMount: false,
      dataRoot,
      packageRoot,
      checkedAt: 1,
    };
  }

  function readLegacyValues(databasePath: string): string[] {
    const database = new Database(databasePath, {readonly: true});
    try {
      return database.prepare<unknown[], {value: string}>(
        'SELECT value FROM legacy_state ORDER BY rowid',
      ).all().map((row) => row.value);
    } finally {
      database.close();
    }
  }

  it('does not stage, copy, or mark anything while persistence is unavailable', () => {
    const result = migrateLegacySelfImproveData({
      persistence: capability('unavailable'),
      destinationPath,
      sourceCandidates: [sourcePath],
    });
    expect(result.status).toBe('not_attempted_persistence_unavailable');
    expect(fs.existsSync(dataRoot)).toBe(false);
    expect(readLegacyValues(path.join(sourcePath, 'case_evolution.db')))
      .toEqual(['legacy-db']);
  });

  it('copies legacy state atomically and preserves the legacy source', () => {
    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
      now: () => new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(result.status).toBe('migrated');
    expect(readLegacyValues(path.join(destinationPath, 'case_evolution.db')))
      .toEqual(['legacy-db']);
    expect(fs.existsSync(path.join(destinationPath, __testing.MIGRATION_MARKER))).toBe(true);
    expect(readLegacyValues(path.join(sourcePath, 'case_evolution.db')))
      .toEqual(['legacy-db']);
    expect(fs.existsSync(path.join(dataRoot, __testing.MIGRATION_LOCK))).toBe(true);
  });

  it('recognizes a completed copy without writing it again', () => {
    const first = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });
    expect(first.status).toBe('migrated');
    const before = fs.statSync(
      path.join(destinationPath, __testing.MIGRATION_MARKER),
    ).mtimeMs;

    const second = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });
    expect(second.status).toBe('already_migrated');
    expect(fs.statSync(
      path.join(destinationPath, __testing.MIGRATION_MARKER),
    ).mtimeMs).toBe(before);
  });

  it('never overwrites an unrecognized destination', () => {
    fs.mkdirSync(destinationPath, {recursive: true});
    fs.writeFileSync(path.join(destinationPath, 'existing.db'), 'keep-me');
    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });
    expect(result.status).toBe('blocked_destination_exists');
    expect(fs.readFileSync(path.join(destinationPath, 'existing.db'), 'utf8'))
      .toBe('keep-me');
    expect(fs.existsSync(path.join(destinationPath, 'case_evolution.db'))).toBe(false);
  });

  it('fails closed while another process holds the SQLite migration lock', () => {
    fs.mkdirSync(dataRoot, {recursive: true});
    const lockPath = path.join(dataRoot, __testing.MIGRATION_LOCK);
    const holder = new Database(lockPath);
    holder.exec('BEGIN EXCLUSIVE');

    try {
      const result = migrateLegacySelfImproveData({
        persistence: capability(),
        destinationPath,
        sourceCandidates: [sourcePath],
      });
      expect(result).toMatchObject({
        status: 'failed',
        errorCode: 'migration_lock_held',
      });
      expect(fs.existsSync(destinationPath)).toBe(false);
    } finally {
      holder.close();
    }
  });

  it('recovers automatically after a lock holder exits without committing', () => {
    fs.mkdirSync(dataRoot, {recursive: true});
    const lockPath = path.join(dataRoot, __testing.MIGRATION_LOCK);
    const holder = new Database(lockPath);
    holder.exec('BEGIN EXCLUSIVE');
    holder.close();

    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });

    expect(result.status).toBe('migrated');
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readLegacyValues(path.join(destinationPath, 'case_evolution.db')))
      .toEqual(['legacy-db']);
  });

  it('rejects a migration lock symlink without modifying its target database', () => {
    fs.mkdirSync(dataRoot, {recursive: true});
    const sentinelPath = path.join(root, 'sentinel.db');
    const sentinel = new Database(sentinelPath);
    sentinel.exec('CREATE TABLE sentinel(value TEXT)');
    sentinel.close();
    fs.symlinkSync(
      sentinelPath,
      path.join(dataRoot, __testing.MIGRATION_LOCK),
    );

    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'migration_lock_path_not_regular',
    });
    const inspected = new Database(sentinelPath, {readonly: true});
    try {
      expect(inspected.prepare<unknown[], {name: string}>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all()).toEqual([{name: 'sentinel'}]);
    } finally {
      inspected.close();
    }
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('rejects symlinks instead of persisting references into the old package', () => {
    fs.symlinkSync(
      path.join(sourcePath, 'case_evolution.db'),
      path.join(sourcePath, 'linked.db'),
    );

    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'legacy_migration_symlink_not_allowed',
    });
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(path.join(sourcePath, 'case_evolution.db'))).toBe(true);
  });

  it('rejects a source root that is itself a symlink', () => {
    const realSourcePath = `${sourcePath}-real`;
    fs.renameSync(sourcePath, realSourcePath);
    fs.symlinkSync(realSourcePath, sourcePath);

    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [sourcePath],
    });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'legacy_migration_symlink_not_allowed',
    });
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(readLegacyValues(path.join(realSourcePath, 'case_evolution.db')))
      .toEqual(['legacy-db']);
  });

  it('fails closed when a source candidate errors for reasons other than absence', () => {
    const inaccessibleCandidate = path.join(root, 'x'.repeat(5_000));
    const result = migrateLegacySelfImproveData({
      persistence: capability(),
      destinationPath,
      sourceCandidates: [inaccessibleCandidate, sourcePath],
    });

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'ENAMETOOLONG',
    });
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('copies a consistent committed SQLite snapshot while the legacy writer stays open', () => {
    const sourceDatabasePath = path.join(sourcePath, 'case_evolution.db');
    const writer = new Database(sourceDatabasePath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO legacy_state(value) VALUES (?)').run('committed-in-wal');

    try {
      const result = migrateLegacySelfImproveData({
        persistence: capability(),
        destinationPath,
        sourceCandidates: [sourcePath],
      });
      expect(result.status).toBe('migrated');
      expect(readLegacyValues(path.join(destinationPath, 'case_evolution.db')))
        .toEqual(['legacy-db', 'committed-in-wal']);

      writer.prepare('INSERT INTO legacy_state(value) VALUES (?)').run('after-migration');
      expect(readLegacyValues(path.join(destinationPath, 'case_evolution.db')))
        .toEqual(['legacy-db', 'committed-in-wal']);
    } finally {
      writer.close();
    }
  });
});
