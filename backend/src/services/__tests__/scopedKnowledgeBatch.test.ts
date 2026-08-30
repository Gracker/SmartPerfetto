// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {createHash} from 'crypto';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

jest.mock('../enterpriseDb', () => {
  const actual = jest.requireActual<typeof import('../enterpriseDb')>('../enterpriseDb');
  return {
    ...actual,
    openEnterpriseDb: jest.fn((...args: Parameters<typeof actual.openEnterpriseDb>) => (
      actual.openEnterpriseDb(...args)
    )),
  };
});

import {ENTERPRISE_DB_PATH_ENV, openEnterpriseDb} from '../enterpriseDb';
import {
  SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE,
  countScopedRagRecords,
  removeScopedKnowledgeRecords,
  removeScopedRagRecords,
  searchScopedRagKnowledgeRecords,
  upsertScopedKnowledgeRecords,
} from '../scopedKnowledgeStore';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
let tmpDir: string;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-knowledge-batch-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
  jest.mocked(openEnterpriseDb).mockClear();
});

afterEach(() => {
  if (originalDbPath === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
  else process.env[ENTERPRISE_DB_PATH_ENV] = originalDbPath;
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('scoped knowledge bulk writes', () => {
  it('writes and removes a 20k generation with one connection per operation', () => {
    const entryCount = 20_000;
    const scope = {tenantId: 'tenant-batch', workspaceId: 'workspace-batch', userId: 'user-batch'};
    const entries = Array.from({length: entryCount}, (_, index) => ({
      kind: 'rag_chunk',
      externalId: `chunk-${index}`,
      rowScope: 'rag:android_internals_wiki',
      record: {
        chunkId: `chunk-${index}`,
        kind: 'android_internals_wiki',
        registryOrigin: 'external_knowledge_registry',
        knowledgeSourceId: `source-${Math.floor(index / 100)}`,
        sourceGeneration: 'generation-1',
        knowledgeScopeFingerprint: createHash('sha256')
          .update(`${scope.tenantId}\0${scope.workspaceId}\0${scope.userId}`)
          .digest('hex'),
        snippet: `shared retrieval token document ${index}`,
      },
    }));

    upsertScopedKnowledgeRecords(entries, scope);
    expect(openEnterpriseDb).toHaveBeenCalledTimes(1);
    expect(Math.ceil(entryCount / SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE)).toBe(20);

    const selected = searchScopedRagKnowledgeRecords<any>('rag_chunk', scope, {
      rowScopes: ['rag:android_internals_wiki'],
      selection: 'knowledge',
      knowledgeSourceGenerations: [{id: 'source-42', generation: 'generation-1'}],
      scopeFingerprint: entries[0].record.knowledgeScopeFingerprint,
      queryTokens: ['shared', 'retrieval'],
      candidateLimit: 500,
      includeSystem: true,
    });
    expect(openEnterpriseDb).toHaveBeenCalledTimes(2);
    expect(selected.indexHasRows).toBe(true);
    expect(selected.eligibleHasRows).toBe(true);
    expect(selected.records).toHaveLength(100);
    expect(selected.records.every(row => row.record.knowledgeSourceId === 'source-42')).toBe(true);

    const removed = removeScopedKnowledgeRecords(
      'rag_chunk',
      entries.map(entry => entry.externalId),
      scope,
    );
    expect(removed).toBe(entryCount);
    expect(openEnterpriseDb).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('treats SQL LIKE metacharacters in path prefixes as literal characters', () => {
    const scope = {tenantId: 'tenant-path', workspaceId: 'workspace-path', userId: 'user-path'};
    const fingerprint = createHash('sha256')
      .update(`${scope.tenantId}\0${scope.workspaceId}\0${scope.userId}`)
      .digest('hex');
    const makeEntry = (externalId: string, filePath: string) => ({
      kind: 'rag_chunk',
      externalId,
      rowScope: 'rag:app_source' as const,
      record: {
        chunkId: externalId,
        kind: 'app_source',
        registryOrigin: 'codebase_registry',
        codebaseId: 'codebase-path',
        sourceGeneration: 'codebase_1',
        knowledgeScopeFingerprint: fingerprint,
        filePath,
        uri: filePath,
        snippet: 'path prefix token',
      },
    });
    upsertScopedKnowledgeRecords([
      ...Array.from({length: 2_100}, (_, index) => (
        makeEntry(`underscore-noise-${index}`, `src/my${index}app/noise.ts`)
      )),
      makeEntry('underscore-target', 'src/my_app/target.ts'),
      makeEntry('percent-noise', 'src/percentXdir/noise.ts'),
      makeEntry('percent-target', 'src/percent%dir/target.ts'),
    ], scope);

    const commonOptions = {
      rowScopes: ['rag:app_source'],
      selection: 'codebase' as const,
      codebaseGenerations: [{id: 'codebase-path', generation: 'codebase_1'}],
      scopeFingerprint: fingerprint,
      candidateLimit: 2_000,
    };
    const underscore = searchScopedRagKnowledgeRecords<any>('rag_chunk', scope, {
      ...commonOptions,
      pathPrefix: 'src/my_app',
    });
    const percent = searchScopedRagKnowledgeRecords<any>('rag_chunk', scope, {
      ...commonOptions,
      pathPrefix: 'src/percent%dir',
    });

    expect(underscore.records.map(row => row.record.filePath)).toEqual(['src/my_app/target.ts']);
    expect(percent.records.map(row => row.record.filePath)).toEqual(['src/percent%dir/target.ts']);
  });

  it('keeps legacy rolling-writer rows eligible for canonical JavaScript token scoring', () => {
    const scope = {tenantId: 'tenant-legacy', workspaceId: 'workspace-legacy', userId: 'user-legacy'};
    const fingerprint = createHash('sha256')
      .update(`${scope.tenantId}\0${scope.workspaceId}\0${scope.userId}`)
      .digest('hex');
    upsertScopedKnowledgeRecords([{
      kind: 'rag_chunk',
      externalId: 'canonical-seed',
      rowScope: 'rag:app_source',
      record: {
        chunkId: 'canonical-seed',
        kind: 'app_source',
        registryOrigin: 'codebase_registry',
        codebaseId: 'legacy-codebase',
        sourceGeneration: 'generation-1',
        knowledgeScopeFingerprint: fingerprint,
        filePath: 'src/Seed.kt',
        snippet: 'canonical seed',
      },
    }], scope);

    const db = openEnterpriseDb();
    try {
      db.prepare(`
        INSERT INTO memory_entries(
          id, tenant_id, workspace_id, scope, content_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'rag:app_source', ?, 1, 2)
      `).run(
        'legacy-writer-row',
        scope.tenantId,
        scope.workspaceId,
        JSON.stringify({
          schemaVersion: 1,
          kind: 'rag_chunk',
          externalId: 'legacy-writer-row',
          sourceTenantId: scope.tenantId,
          sourceWorkspaceId: scope.workspaceId,
          record: {
            chunkId: 'legacy-writer-row',
            kind: 'app_source',
            registryOrigin: 'codebase_registry',
            codebaseId: 'legacy-codebase',
            sourceGeneration: 'generation-1',
            knowledgeScopeFingerprint: fingerprint,
            filePath: 'src/LegacyWriter.kt',
            snippet: '性能分析 LegacyWriter',
          },
        }),
      );
      expect(db.prepare(`
        SELECT rag_index_state AS state FROM memory_entries WHERE id = 'legacy-writer-row'
      `).get()).toEqual({state: 'legacy_pending'});
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM rag_knowledge_fts WHERE entry_id = 'legacy-writer-row'
      `).get()).toEqual({count: 0});
    } finally {
      db.close();
    }

    const selected = searchScopedRagKnowledgeRecords<any>('rag_chunk', scope, {
      rowScopes: ['rag:app_source'],
      selection: 'codebase',
      codebaseGenerations: [{id: 'legacy-codebase', generation: 'generation-1'}],
      scopeFingerprint: fingerprint,
      queryTokens: ['性能', 'writer'],
      candidateLimit: 20,
    });
    expect(selected.records.map(row => row.record.chunkId))
      .toContain('legacy-writer-row');
  });

  it('counts and deletes generations without crossing owner or user fingerprints', () => {
    const scopeA = {tenantId: 'tenant-maint', workspaceId: 'workspace-maint', userId: 'user-a'};
    const scopeB = {...scopeA, userId: 'user-b'};
    const fingerprint = (scope: typeof scopeA) => createHash('sha256')
      .update(`${scope.tenantId}\0${scope.workspaceId}\0${scope.userId}`)
      .digest('hex');
    const entry = (
      externalId: string,
      codebaseId: string,
      sourceGeneration: string,
      scope: typeof scopeA,
    ) => ({
      kind: 'rag_chunk',
      externalId,
      rowScope: 'rag:app_source',
      record: {
        chunkId: externalId,
        kind: 'app_source',
        registryOrigin: 'codebase_registry',
        codebaseId,
        sourceGeneration,
        knowledgeScopeFingerprint: fingerprint(scope),
        uri: `codebase://${codebaseId}/${externalId}.ts`,
        snippet: `maintenance ${externalId}`,
      },
    });
    upsertScopedKnowledgeRecords([
      entry('a-active', 'codebase-a', 'generation-active', scopeA),
      entry('a-stale', 'codebase-a', 'generation-stale', scopeA),
      entry('other-codebase', 'codebase-b', 'generation-stale', scopeA),
    ], scopeA);
    upsertScopedKnowledgeRecords([
      entry('other-user', 'codebase-a', 'generation-stale', scopeB),
    ], scopeB);

    expect(countScopedRagRecords(scopeA, {
      codebaseId: 'codebase-a',
      sourceGeneration: 'generation-stale',
      scopeFingerprint: fingerprint(scopeA),
    })).toBe(1);
    expect(removeScopedRagRecords(scopeA, {
      codebaseId: 'codebase-a',
      excludeSourceGeneration: 'generation-active',
      scopeFingerprint: fingerprint(scopeA),
    })).toBe(1);
    expect(countScopedRagRecords(scopeA, {
      codebaseId: 'codebase-a',
      sourceGeneration: 'generation-active',
      scopeFingerprint: fingerprint(scopeA),
    })).toBe(1);
    expect(countScopedRagRecords(scopeA, {
      codebaseId: 'codebase-b',
      sourceGeneration: 'generation-stale',
      scopeFingerprint: fingerprint(scopeA),
    })).toBe(1);
    expect(countScopedRagRecords(scopeB, {
      codebaseId: 'codebase-a',
      sourceGeneration: 'generation-stale',
      scopeFingerprint: fingerprint(scopeB),
    })).toBe(1);

    const db = openEnterpriseDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM rag_knowledge_fts').get())
        .toEqual({count: 3});
    } finally {
      db.close();
    }
    expect(() => countScopedRagRecords(scopeA, {})).toThrow('Exactly one');
    expect(() => removeScopedRagRecords(scopeA, {
      codebaseId: 'codebase-a',
      knowledgeSourceId: 'source-a',
    })).toThrow('Exactly one');
  });
});

describe('SQL knowledge singleton initialization', () => {
  it('waits on the same in-flight extended knowledge initialization for concurrent first callers', async () => {
    await jest.isolateModulesAsync(async () => {
      const sqlKnowledge = await import('../sqlKnowledgeBase');
      const initializeGate = createDeferred<void>();
      let initializeCalls = 0;
      jest.spyOn(sqlKnowledge.ExtendedSqlKnowledgeBase.prototype, 'initialize')
        .mockImplementation(async () => {
          initializeCalls += 1;
          await initializeGate.promise;
        });

      let secondResolved = false;
      const first = sqlKnowledge.getExtendedKnowledgeBase();
      const second = sqlKnowledge.getExtendedKnowledgeBase()
        .then(() => {
          secondResolved = true;
        });

      await Promise.resolve();

      expect(initializeCalls).toBe(1);
      expect(secondResolved).toBe(false);

      initializeGate.resolve();
      await expect(Promise.all([first, second])).resolves.toBeDefined();
      expect(secondResolved).toBe(true);
    });
  });

  it('clears failed extended knowledge initialization so the next caller retries', async () => {
    await jest.isolateModulesAsync(async () => {
      const sqlKnowledge = await import('../sqlKnowledgeBase');
      let initializeCalls = 0;
      jest.spyOn(sqlKnowledge.ExtendedSqlKnowledgeBase.prototype, 'initialize')
        .mockImplementation(async () => {
          initializeCalls += 1;
          if (initializeCalls === 1) {
            throw new Error('synthetic knowledge init failure');
          }
        });

      await expect(sqlKnowledge.getExtendedKnowledgeBase())
        .rejects.toThrow('synthetic knowledge init failure');
      await expect(sqlKnowledge.getExtendedKnowledgeBase())
        .resolves.toBeInstanceOf(sqlKnowledge.ExtendedSqlKnowledgeBase);
      expect(initializeCalls).toBe(2);
    });
  });
});
