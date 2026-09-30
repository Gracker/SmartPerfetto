// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, it, expect, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  backfillPatternEntries,
  backfillNegativeEntries,
  runFailureModeHashMigration,
} from '../migrateFailureModeHash';
import type { AnalysisPatternEntry, NegativePatternEntry } from '../../types';
import {matchPatterns, readPatternBucketCensus} from '../../analysisPatternMemory';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../../config';
import * as enterpriseDb from '../../../services/enterpriseDb';
import {
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
} from '../../../services/enterpriseMigration';
import {
  getScopedKnowledgeRecord,
  mutateScopedKnowledgeRecord,
} from '../../../services/scopedKnowledgeStore';

const baseEntry: AnalysisPatternEntry = {
  id: 'p1',
  traceFeatures: ['arch:FLUTTER', 'scene:scrolling'],
  sceneType: 'scrolling',
  keyInsights: [],
  architectureType: 'FLUTTER',
  confidence: 0.8,
  createdAt: 1700000000000,
  matchCount: 1,
};

const baseNegative: NegativePatternEntry = {
  id: 'n1',
  traceFeatures: ['arch:STANDARD', 'scene:startup'],
  sceneType: 'startup',
  failedApproaches: [],
  architectureType: 'STANDARD',
  createdAt: 1700000000000,
  matchCount: 1,
};

describe('backfillPatternEntries', () => {
  it('returns the same entry shape with failureModeHash filled in', () => {
    const { entries, report } = backfillPatternEntries([baseEntry]);
    expect(entries).toHaveLength(1);
    expect(entries[0].failureModeHash).toMatch(/^[a-f0-9]{16}$/);
    expect(report.total).toBe(1);
    expect(report.newlyHashed).toBe(1);
  });

  it('preserves existing failureModeHash and counts as alreadyHashed', () => {
    const seeded = { ...baseEntry, failureModeHash: 'deadbeefdeadbeef' };
    const { entries, report } = backfillPatternEntries([seeded]);
    expect(entries[0].failureModeHash).toBe('deadbeefdeadbeef');
    expect(report.alreadyHashed).toBe(1);
    expect(report.newlyHashed).toBe(0);
  });

  it('infers category=unknown when keyInsights are empty', () => {
    const { report } = backfillPatternEntries([baseEntry]);
    expect(report.byCategory.unknown).toBe(1);
  });

  it('classifies entries with diagnostic insights', () => {
    const e = { ...baseEntry, keyInsights: ['detected VSync misdiagnosis on VRR boundary'] };
    const { report } = backfillPatternEntries([e]);
    expect(report.byCategory.misdiagnosis_vsync_vrr).toBe(1);
  });

  it('captures up to 3 samples per category', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      ...baseEntry,
      id: `p${i}`,
      keyInsights: [`no such table: t${i}`],
    }));
    const { report } = backfillPatternEntries(entries);
    expect(report.byCategory.sql_missing_table).toBe(5);
    expect(report.samples.sql_missing_table.length).toBe(3);
  });

  it('produces same hash for entries that share scene/arch/category', () => {
    const a = { ...baseEntry, id: 'a', keyInsights: ['no such table: x'] };
    const b = { ...baseEntry, id: 'b', keyInsights: ['no such table: y'] };
    const { entries } = backfillPatternEntries([a, b]);
    expect(entries[0].failureModeHash).toBe(entries[1].failureModeHash);
  });
});

describe('backfillNegativeEntries', () => {
  it('hashes each FailedApproach individually + entry overall', () => {
    const entry: NegativePatternEntry = {
      ...baseNegative,
      failedApproaches: [
        { type: 'sql_error', approach: 'SELECT *', reason: 'no such table: android_frames' },
        { type: 'tool_failure', approach: 'execute_sql', reason: 'connection timeout' },
      ],
    };
    const { entries, report } = backfillNegativeEntries([entry]);
    expect(entries[0].failureModeHash).toMatch(/^[a-f0-9]{16}$/);
    for (const a of entries[0].failedApproaches) {
      expect(a.failureModeHash).toMatch(/^[a-f0-9]{16}$/);
    }
    // The two approaches have different inferred categories, so distinct hashes.
    const hashes = new Set(entries[0].failedApproaches.map(a => a.failureModeHash));
    expect(hashes.size).toBe(2);
    expect(report.newlyHashed).toBe(1);
  });

  it('preserves existing approach-level hashes', () => {
    const entry: NegativePatternEntry = {
      ...baseNegative,
      failedApproaches: [
        { type: 'sql_error', approach: 'SELECT *', reason: 'no such table', failureModeHash: 'cafebabecafebabe' },
      ],
    };
    const { entries } = backfillNegativeEntries([entry]);
    expect(entries[0].failedApproaches[0].failureModeHash).toBe('cafebabecafebabe');
  });

  it('classifies negative entries with sql_missing_column reason', () => {
    const entry: NegativePatternEntry = {
      ...baseNegative,
      failedApproaches: [
        { type: 'sql_error', approach: 'SELECT bad', reason: 'no such column: bad' },
      ],
    };
    const { report } = backfillNegativeEntries([entry]);
    expect(report.byCategory.sql_missing_column).toBe(1);
  });

  it('counts already-hashed negative entries without re-hashing', () => {
    const entry: NegativePatternEntry = {
      ...baseNegative,
      failureModeHash: 'feedfacefeedface',
      failedApproaches: [],
    };
    const { entries, report } = backfillNegativeEntries([entry]);
    expect(entries[0].failureModeHash).toBe('feedfacefeedface');
    expect(report.alreadyHashed).toBe(1);
    expect(report.newlyHashed).toBe(0);
  });
});

describe('runFailureModeHashMigration', () => {
  const ADMISSION = {version: 1 as const, basis: 'public_run' as const, runId: 'run-public', admittedAt: 1};
  const ENV_NAMES = [
    'SMARTPERFETTO_BACKEND_LOG_DIR',
    ENTERPRISE_FEATURE_FLAG_ENV,
    ENTERPRISE_MIGRATION_PHASE_ENV,
    ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
    enterpriseDb.ENTERPRISE_DB_PATH_ENV,
  ];
  const originalEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  let tmp: string;

  const admitted: AnalysisPatternEntry = {
    ...baseEntry,
    id: 'admitted',
    keyInsights: ['Choreographer doFrame 超时 due to binder'],
    learningAdmission: ADMISSION,
  };
  const quarantined: AnalysisPatternEntry = {
    ...baseEntry,
    id: 'quarantined',
    keyInsights: ['SECRET-UNADMITTED-TEXT lock contention on main thread'],
  };
  const patternsFile = () => path.join(tmp, 'analysis_patterns.json');
  const readFile = (): AnalysisPatternEntry[] => JSON.parse(fs.readFileSync(patternsFile(), 'utf-8'));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-migrate-fmh-'));
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = tmp;
    delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('reports admitted entries only and leaves the store untouched on a dry run', async () => {
    fs.writeFileSync(patternsFile(), JSON.stringify([admitted, quarantined]));
    const before = fs.readFileSync(patternsFile(), 'utf-8');

    const {positive} = await runFailureModeHashMigration({apply: false});

    expect(positive).toMatchObject({total: 1, quarantined: 1, newlyHashed: 1});
    expect(JSON.stringify(positive.samples)).not.toContain('SECRET-UNADMITTED-TEXT');
    expect(JSON.stringify(positive.samples)).toContain('Choreographer');
    expect(fs.readFileSync(patternsFile(), 'utf-8')).toBe(before);
  });

  it('applies to admitted entries in place and keeps unadmitted ones as they were', async () => {
    fs.writeFileSync(patternsFile(), JSON.stringify([quarantined, admitted]));

    const {positive} = await runFailureModeHashMigration({apply: true});

    expect(positive).toMatchObject({total: 1, quarantined: 1, newlyHashed: 1});
    const [kept, hashed] = readFile();
    expect(kept).toEqual(quarantined);
    expect(hashed.id).toBe('admitted');
    expect(hashed.failureModeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readdirSync(tmp).filter(name => name.includes('.tmp'))).toEqual([]);
  });

  const partition = {tenantId: 'tenant-m', workspaceId: 'workspace-m'};
  const partitionProvenance = {sourceTenantId: 'tenant-m', sourceWorkspaceId: 'workspace-m'};
  const useEnterprisePhase = (phase: 'cutover' | 'dual-write'): string => {
    const dbPath = path.join(tmp, 'enterprise.sqlite');
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = phase;
    process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] = 'true';
    process.env[enterpriseDb.ENTERPRISE_DB_PATH_ENV] = dbPath;
    return dbPath;
  };
  const seedPartition = (entries: AnalysisPatternEntry[]) => mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
    'analysis_pattern_bucket', 'positive', partition,
    () => entries.map(entry => ({...entry, provenance: partitionProvenance})), {rowScope: 'pattern-memory:positive'});
  const storedPartition = () => getScopedKnowledgeRecord<AnalysisPatternEntry[]>(
    'analysis_pattern_bucket', 'positive', partition)?.record ?? [];

  it('writes the authoritative DB partition, not the legacy file, after cutover', async () => {
    useEnterprisePhase('cutover');
    seedPartition([quarantined, admitted]);
    fs.writeFileSync(patternsFile(), JSON.stringify([admitted]));
    const legacyBefore = fs.readFileSync(patternsFile(), 'utf-8');

    const {positive} = await runFailureModeHashMigration({apply: true});

    expect(positive).toMatchObject({total: 1, quarantined: 1, newlyHashed: 1});
    const stored = storedPartition();
    expect(stored[0]).toEqual({...quarantined, provenance: partitionProvenance});
    expect(stored[1].failureModeHash).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readFileSync(patternsFile(), 'utf-8')).toBe(legacyBefore);
  });

  it('reads the database without creating, migrating or writing it', async () => {
    const dbPath = useEnterprisePhase('cutover');
    // No database yet: nothing to read, and none is created.
    expect((await runFailureModeHashMigration({apply: false})).positive).toMatchObject({total: 0, quarantined: 0});
    expect(readPatternBucketCensus('positive', partition)).toEqual({admitted: [], quarantined: 0});
    expect(fs.existsSync(dbPath)).toBe(false);

    // A database whose schema was never applied stays as it was.
    const bare = new Database(dbPath);
    bare.exec('CREATE TABLE unrelated (x)');
    bare.close();
    const bareBefore = fs.readFileSync(dbPath);
    // better-sqlite3 keeps the SqliteError class of the first test realm that
    // loaded it, which toThrow() does not recognize as an Error; read the reason.
    const failure = await runFailureModeHashMigration({apply: false}).then(() => undefined, (err: Error) => err);
    expect(failure?.message).toBe('no such table: memory_entries');
    expect(fs.readFileSync(dbPath).equals(bareBefore)).toBe(true);
    fs.rmSync(dbPath);

    // A current database is read through a read-only connection only.
    seedPartition([quarantined, admitted]);
    const before = fs.readFileSync(dbPath);
    const writableOpen = jest.spyOn(enterpriseDb, 'openEnterpriseDb');
    try {
      expect((await runFailureModeHashMigration({apply: false})).positive).toMatchObject({total: 1, quarantined: 1});
      expect(readPatternBucketCensus('positive', partition)).toMatchObject({quarantined: 1});
      expect(writableOpen).not.toHaveBeenCalled();
    } finally {writableOpen.mockRestore();}
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  const envelope = (overrides: object) => JSON.stringify({
    schemaVersion: 1, kind: 'analysis_pattern_bucket', externalId: 'positive', record: [], ...overrides});
  it.each([
    ['corrupt JSON', '{'],
    ['an envelope of another version', envelope({schemaVersion: 2})],
    ['a bucket that is not a list', envelope({record: {entries: []}})],
  ])('reports a DB partition holding %s instead of counting it empty', async (_label, content) => {
    const dbPath = useEnterprisePhase('cutover');
    seedPartition([admitted]);
    const db = new Database(dbPath);
    db.prepare("UPDATE memory_entries SET content_json = ? WHERE scope = 'pattern-memory:positive'").run(content);
    db.close();
    const unreadable = 'analysis patterns store has an unreadable partition (tenant-m/workspace-m)';

    const failure = await runFailureModeHashMigration({apply: false}).then(() => undefined, (err: Error) => err);
    expect(failure?.message).toBe(unreadable);
    expect(() => readPatternBucketCensus('positive', partition)).toThrow(unreadable);
    // A run's read still takes it as an empty bucket, so no analysis breaks on it.
    expect(matchPatterns(admitted.traceFeatures, partition)).toEqual([]);
  });

  it('reports an unreadable store without quoting it', async () => {
    // An unquoted token makes the parser quote the text around it.
    fs.writeFileSync(patternsFile(), '[{"keyInsights":[SECRET-UNADMITTED-TEXT lock]}]');
    const failure = await runFailureModeHashMigration({apply: false}).then(() => undefined, (err: Error) => err);
    expect(failure?.message).toBe('analysis patterns store is not valid JSON');
    expect(() => readPatternBucketCensus('positive')).toThrow('analysis patterns store is not valid JSON');

    // A rewrite moves the unreadable store aside, and its log quotes nothing either.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runFailureModeHashMigration({apply: true});
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET');
    } finally {logged.mockRestore();}
  });

  it('fails a rewrite the authoritative file did not take, before the DB copy changes', async () => {
    useEnterprisePhase('dual-write');
    seedPartition([admitted]);
    fs.writeFileSync(patternsFile(), JSON.stringify([{...admitted, provenance: partitionProvenance}]));
    const fileBefore = fs.readFileSync(patternsFile(), 'utf-8');
    const noSpace = Object.assign(new Error('ENOSPC: no space left on device'), {code: 'ENOSPC'});
    const write = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(noSpace);
    try {
      await expect(runFailureModeHashMigration({apply: true})).rejects.toMatchObject({
        message: 'analysis_pattern_store_write_unavailable', cause: noSpace});
    } finally {write.mockRestore();}
    expect(fs.readFileSync(patternsFile(), 'utf-8')).toBe(fileBefore);
    expect(storedPartition()[0].failureModeHash).toBeUndefined();
  });
});
