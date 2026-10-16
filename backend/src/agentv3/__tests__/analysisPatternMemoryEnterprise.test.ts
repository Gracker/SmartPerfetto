// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import Database from 'better-sqlite3';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import * as enterpriseDb from '../../services/enterpriseDb';
import {ENTERPRISE_DB_PATH_ENV} from '../../services/enterpriseDb';
import {
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
} from '../../services/enterpriseMigration';
import {
  getScopedKnowledgeRecord,
  mutateScopedKnowledgeRecord,
  resolveKnowledgeScope,
  scopedKnowledgeRowId,
  type KnowledgeScope,
} from '../../services/scopedKnowledgeStore';
import type {AnalysisPatternEntry, NegativePatternEntry} from '../types';
import {resolveDurableLearningPermission, withDurableLearningPermission} from '../../services/security/durableLearning';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {
  buildNegativePatternSection,
  buildPatternContextSection,
  matchNegativePatterns,
  matchPatterns,
  matchQuickPatternsAsBackup,
  readPatternBucketCensus,
  type PatternBucketId,
  saveAnalysisPattern,
  setSupersedeStoreForTesting,
  sweepAllPatternMemoryPartitions,
} from '../analysisPatternMemory';

const ADMISSION = {version: 1 as const, basis: 'public_run' as const, runId: 'run-public-learning', admittedAt: 1};

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  cutoverConfirmed: process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV],
  databasePath: process.env[ENTERPRISE_DB_PATH_ENV],
};

const scopeA: KnowledgeScope = {
  tenantId: 'tenant-pattern-a',
  workspaceId: 'workspace-pattern-a',
  userId: 'user-a',
};
const scopeB: KnowledgeScope = {
  tenantId: 'tenant-pattern-b',
  workspaceId: 'workspace-pattern-b',
  userId: 'user-b',
};

let tempDir: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function seededPatterns(scope: KnowledgeScope, prefix: string): AnalysisPatternEntry[] {
  const tenantId = scope.tenantId!;
  const workspaceId = scope.workspaceId!;
  return Array.from({length: 200}, (_, index) => ({
    id: `${prefix}-${index}`,
    traceFeatures: [`arch:${prefix}-${index}`, `scene:${prefix}-${index}`],
    sceneType: `${prefix}-${index}`,
    keyInsights: [`${prefix} insight ${index}`],
    confidence: 0.8,
    createdAt: Date.now() - 10_000 - index,
    matchCount: 0,
    status: 'confirmed',
    provenance: {
      sourceTenantId: tenantId,
      sourceWorkspaceId: workspaceId,
    },
    learningAdmission: ADMISSION,
  }));
}

function readPositiveBucket(scope: KnowledgeScope): AnalysisPatternEntry[] {
  return getScopedKnowledgeRecord<AnalysisPatternEntry[]>(
    'analysis_pattern_bucket',
    'positive',
    scope,
  )?.record ?? [];
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-memory-enterprise-'));
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'cutover';
  process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tempDir, 'enterprise.sqlite');
  setSupersedeStoreForTesting(null);
});

afterEach(() => {
  restoreEnv(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnv(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  restoreEnv(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV, originalEnv.cutoverConfirmed);
  restoreEnv(ENTERPRISE_DB_PATH_ENV, originalEnv.databasePath);
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('analysis pattern memory enterprise buckets', () => {
  it('auto-confirms ripe entries in every enterprise partition', async () => {
    const now = Date.now();
    for (const [scope, prefix] of [[scopeA, 'a'], [scopeB, 'b']] as const) {
      mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
        'analysis_pattern_bucket',
        'positive',
        scope,
        () => [{
          ...seededPatterns(scope, prefix)[0],
          status: 'provisional',
          createdAt: now - 8 * 24 * 60 * 60 * 1000,
        }],
        {rowScope: 'pattern-memory:positive'},
      );
    }

    const result = await sweepAllPatternMemoryPartitions(now);

    expect(result.totalPromoted).toBe(2);
    expect(readPositiveBucket(scopeA)[0]?.status).toBe('confirmed');
    expect(readPositiveBucket(scopeB)[0]?.status).toBe('confirmed');
  });

  it('auto-confirms the whole legacy file and every DB partition during dual write', async () => {
    const originalLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
    process.env.SMARTPERFETTO_BACKEND_LOG_DIR = tempDir;
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    try {
      const now = Date.now();
      const ripe = (scope: KnowledgeScope, prefix: string): AnalysisPatternEntry => ({
        ...seededPatterns(scope, prefix)[0],
        status: 'provisional',
        createdAt: now - 8 * 24 * 60 * 60 * 1000,
      });
      for (const [scope, prefix] of [[scopeA, 'a'], [scopeB, 'b']] as const) {
        mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
          'analysis_pattern_bucket', 'positive', scope,
          () => [ripe(scope, prefix)], {rowScope: 'pattern-memory:positive'},
        );
      }
      // Written before dual write: no DB row, no partition provenance.
      const {provenance: _none, ...unpartitioned} = ripe(scopeA, 'legacy');
      fs.writeFileSync(path.join(tempDir, 'analysis_patterns.json'), JSON.stringify([unpartitioned]));

      const result = await sweepAllPatternMemoryPartitions(now);

      // The legacy file stays authoritative during dual write: one pass over all of it.
      expect(result.positivePromoted).toBe(1);
      const file = JSON.parse(fs.readFileSync(path.join(tempDir, 'analysis_patterns.json'), 'utf-8'));
      expect(file.map((entry: AnalysisPatternEntry) => entry.status)).toEqual(['confirmed']);
      expect(readPositiveBucket(scopeA)[0]?.status).toBe('confirmed');
      expect(readPositiveBucket(scopeB)[0]?.status).toBe('confirmed');
    } finally {
      restoreEnv('SMARTPERFETTO_BACKEND_LOG_DIR', originalLogDir);
    }
  });

  it('counts one partition, splitting admitted from quarantined entries', () => {
    const [admitted, other] = seededPatterns(scopeA, 'a');
    const {learningAdmission: _dropped, ...unadmitted} = other;
    mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
      'analysis_pattern_bucket', 'positive', scopeA,
      () => [admitted, unadmitted], {rowScope: 'pattern-memory:positive'},
    );
    mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
      'analysis_pattern_bucket', 'positive', scopeB,
      () => seededPatterns(scopeB, 'b').slice(0, 3), {rowScope: 'pattern-memory:positive'},
    );

    const census = readPatternBucketCensus('positive', scopeA);

    expect(census.admitted.map(entry => entry.id)).toEqual([admitted.id]);
    expect(census.quarantined).toBe(1);
    expect(readPatternBucketCensus('negative', scopeA)).toEqual({admitted: [], quarantined: 0});
  });

  it('enforces retention per workspace without noisy-neighbor eviction', async () => {
    const scopeASeed = seededPatterns(scopeA, 'a');
    const scopeBSeed = seededPatterns(scopeB, 'b');
    for (const [scope, entries] of [[scopeA, scopeASeed], [scopeB, scopeBSeed]] as const) {
      mutateScopedKnowledgeRecord<AnalysisPatternEntry[]>(
        'analysis_pattern_bucket',
        'positive',
        scope,
        () => entries,
        {rowScope: 'pattern-memory:positive'},
      );
    }

    const newFeatures = ['arch:new-a', 'scene:new-a'];
    await saveAnalysisPattern(
      newFeatures,
      ['new tenant-a insight'],
      'new-a',
      'new-a',
      0.95,
      {learning: resolveDurableLearningPermission(
        withDurableLearningPermission({runId: 'run-public-learning'}, NO_PRIVATE_CONTEXT))!, knowledgeScope: scopeA},
    );

    const bucketA = readPositiveBucket(scopeA);
    const bucketB = readPositiveBucket(scopeB);
    expect(bucketA).toHaveLength(200);
    expect(bucketA.some(entry => entry.keyInsights.includes('new tenant-a insight'))).toBe(true);
    expect(bucketB).toHaveLength(200);
    expect(bucketB.map(entry => entry.id)).toEqual(scopeBSeed.map(entry => entry.id));
    expect(matchPatterns(newFeatures, scopeA)[0]?.keyInsights).toContain('new tenant-a insight');
    expect(matchPatterns(newFeatures, scopeB)).toHaveLength(0);
  });
});

// `recall_patterns` and the prompt prefetch read pattern memory on every run;
// in the knowledge database that read must never create, migrate or write it.
describe('pattern recall from the knowledge database', () => {
  const features = ['arch:a-0', 'scene:a-0'];
  const databasePath = () => enterpriseDb.resolveEnterpriseDbPath();
  const negativeEntry: NegativePatternEntry = {
    id: 'negative-a',
    traceFeatures: features,
    sceneType: 'a-0',
    failedApproaches: [{type: 'sql_error', approach: 'naive_join', reason: 'Cartesian blowup on large traces'}],
    createdAt: Date.now() - 1_000,
    matchCount: 0,
    status: 'confirmed',
    provenance: {sourceTenantId: scopeA.tenantId!, sourceWorkspaceId: scopeA.workspaceId!},
    learningAdmission: ADMISSION,
  };
  const seedBucket = (bucket: PatternBucketId, record: unknown[]) =>
    mutateScopedKnowledgeRecord<unknown[]>('analysis_pattern_bucket', bucket, scopeA, () => record,
      {rowScope: `pattern-memory:${bucket}`});

  /** Runs `recall` and asserts it opened no writable connection. */
  function recallReadOnly<T>(recall: () => T): T {
    const writable = jest.spyOn(enterpriseDb, 'openEnterpriseDb');
    try {
      const result = recall();
      expect(writable).not.toHaveBeenCalled();
      return result;
    } finally {
      writable.mockRestore();
    }
  }

  it('reads every bucket, commits still in the WAL included, without writing a byte', () => {
    // While one connection stays open, the seed commits stay in the WAL, as on a live server.
    const writer = enterpriseDb.openEnterpriseDb();
    try {
      seedBucket('positive', seededPatterns(scopeA, 'a').slice(0, 1));
      seedBucket('negative', [negativeEntry]);
      seedBucket('quick', [{...seededPatterns(scopeA, 'q')[0], traceFeatures: features}]);
      const files = () => [databasePath(), `${databasePath()}-wal`].map(file => fs.readFileSync(file));
      const before = files();
      expect(before[1].length).toBeGreaterThan(0);

      const recalled = recallReadOnly(() => ({
        positive: matchPatterns(features, scopeA).map(match => match.id),
        quick: matchQuickPatternsAsBackup(features, scopeA).map(match => match.id),
        negative: matchNegativePatterns(features, scopeA).map(match => match.id),
        prompt: [buildPatternContextSection(features, scopeA), buildNegativePatternSection(features, scopeA)],
      }));

      expect(recalled).toMatchObject({
        positive: ['a-0'], quick: ['q-0'], negative: ['negative-a'], prompt: [expect.any(String), expect.any(String)],
      });
      files().forEach((file, index) => expect(file.equals(before[index])).toBe(true));
    } finally {
      writer.close();
    }
  });

  it('reads nothing and creates no database before one exists', () => {
    expect(recallReadOnly(() => matchPatterns(features, scopeA))).toEqual([]);
    expect(fs.existsSync(databasePath())).toBe(false);
  });

  it('reads nothing from a database without the knowledge table, and adds none', () => {
    new Database(databasePath()).close();

    let matches: unknown;
    expect(() => {
      matches = recallReadOnly(() => matchPatterns(features, scopeA));
    }).not.toThrow();
    expect(matches).toEqual([]);

    const tables = new Database(databasePath(), {readonly: true});
    try {
      expect(tables.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([]);
    } finally {
      tables.close();
    }
  });

  it('reads a knowledge table from before the RAG columns were added', () => {
    const old = new Database(databasePath());
    try {
      old.exec(`CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        source_run_id TEXT, content_json TEXT NOT NULL, embedding_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      const scope = resolveKnowledgeScope(scopeA);
      old.prepare(`INSERT INTO memory_entries (id, tenant_id, workspace_id, scope, content_json, created_at, updated_at)
        VALUES (?, ?, ?, 'pattern-memory:positive', ?, 1, 1)`).run(
        scopedKnowledgeRowId('analysis_pattern_bucket', 'positive', scope), scope.tenantId, scope.workspaceId,
        JSON.stringify({schemaVersion: 1, kind: 'analysis_pattern_bucket', externalId: 'positive',
          sourceTenantId: scope.tenantId, sourceWorkspaceId: scope.workspaceId,
          record: seededPatterns(scopeA, 'a').slice(0, 1)}));
    } finally {
      old.close();
    }

    expect(recallReadOnly(() => matchPatterns(features, scopeA)).map(match => match.id)).toEqual(['a-0']);
  });
});
