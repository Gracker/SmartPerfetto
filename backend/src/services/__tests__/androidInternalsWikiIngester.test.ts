// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {AndroidInternalsWikiIngester} from '../androidInternalsWiki/androidInternalsWikiIngester';
import {scanAndroidInternalsWiki} from '../androidInternalsWiki/androidInternalsWikiCorpus';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {RagStore} from '../ragStore';

let tmpDir: string;

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-internals-ingester-'));
  delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
  delete process.env[ENTERPRISE_DB_PATH_ENV];
  delete process.env[ENTERPRISE_MIGRATION_PHASE_ENV];
});

afterEach(() => {
  restoreEnv(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnv(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnv(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function writeArticle(root: string, name: string, status: string, body: string): void {
  const filePath = path.join(root, 'src', name);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, [
    '---',
    `title: ${name}`,
    `status: ${status}`,
    'confidence: high',
    'last_verified_against: Android 17',
    'tags: [handler, looper]',
    '---',
    `# ${name}`,
    body,
  ].join('\n'), 'utf8');
}

describe('AndroidInternalsWikiIngester', () => {
  it('provides the external corpus ingester', async () => {
    const modulePath = '../androidInternalsWiki/androidInternalsWikiIngester';

    await expect(import(modulePath)).resolves.toHaveProperty('AndroidInternalsWikiIngester');
  });

  it('stages and activates only mature strict-metadata articles with attribution', async () => {
    const wikiRoot = path.join(tmpDir, 'wiki');
    writeArticle(wikiRoot, 'handler.md', 'finalized', '消息队列 Handler callback 执行区间。');
    writeArticle(wikiRoot, 'review.md', 'ready-for-review', '尚未验证的 review only 内容。');
    execFileSync('git', ['init', '-q', wikiRoot]);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', wikiRoot, 'add', '.']);
    execFileSync('git', ['-C', wikiRoot, 'commit', '-qm', 'fixture']);
    const revision = execFileSync('git', ['-C', wikiRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const corpus = scanAndroidInternalsWiki(wikiRoot);
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: fs.realpathSync(wikiRoot),
      revision,
      contentFingerprint: corpus.contentFingerprint,
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const store = new RagStore(path.join(tmpDir, 'rag.json'));
    const Ingester = AndroidInternalsWikiIngester as any;
    const ingester = new Ingester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']}),
    );

    const result = await ingester.ingest(source.sourceId, scope);
    const active = registry.get(source.sourceId, scope)!;
    const search = store.search('消息队列 Handler', {
      kinds: ['android_internals_wiki'],
      knowledgeSourceIds: [source.sourceId],
      activeSourceGenerations: {[source.sourceId]: active.activeGeneration!},
      scope,
    });

    expect(result).toEqual(expect.objectContaining({indexedArticleCount: 1}));
    expect(result.cleanup).toEqual({status: 'completed', removedChunkCount: 0});
    expect(result.indexedChunkCount).toBeGreaterThan(0);
    expect(search.results[0]?.chunk).toEqual(expect.objectContaining({
      knowledgeSourceId: source.sourceId,
      sourceGeneration: active.activeGeneration,
      sourceStatus: 'finalized',
      sourceConfidence: 'high',
      lastVerifiedAgainst: 'Android 17',
      license: 'CC-BY-NC-SA-4.0',
      attribution: 'Android Internals Wiki by Gracker (CC BY-NC-SA 4.0)',
      commitHash: revision,
      contentFingerprint: corpus.contentFingerprint,
      filePath: 'src/handler.md',
    }));
    // Article tags had no reader; chunks no longer carry them.
    expect(search.results[0]?.chunk).not.toHaveProperty('sourceTags');
    expect(store.search('review only', {
      kinds: ['android_internals_wiki'],
      knowledgeSourceIds: [source.sourceId],
      activeSourceGenerations: {[source.sourceId]: active.activeGeneration!},
      scope,
    }).results).toHaveLength(0);

    const handlerPath = path.join(wikiRoot, 'src/handler.md');
    fs.writeFileSync(
      handlerPath,
      fs.readFileSync(handlerPath, 'utf8').replace('confidence: high', 'confidence: medium'),
      'utf8',
    );
    const stagedCountFailure = jest.spyOn(store, 'countKnowledgeSourceGenerationChunks').mockReturnValueOnce(0);
    await expect(ingester.ingest(source.sourceId, scope)).rejects.toThrow('staged_chunk_count_mismatch');
    stagedCountFailure.mockRestore();
    expect(registry.get(source.sourceId, scope)?.activeGeneration).toBe(result.generation);

    fs.writeFileSync(
      handlerPath,
      fs.readFileSync(handlerPath, 'utf8').replace('status: finalized', 'status: draft'),
      'utf8',
    );
    await expect(ingester.ingest(source.sourceId, scope))
      .rejects.toThrow('source_generation_empty');
    const retainedSource = registry.get(source.sourceId, scope)!;

    expect(retainedSource.activeGeneration).toBe(result.generation);
    expect(store.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk => chunk.sourceGeneration === result.generation)).not.toHaveLength(0);
    expect(store.search('消息队列 Handler', {
      kinds: ['android_internals_wiki'],
      knowledgeSourceIds: [source.sourceId],
      activeSourceGenerations: {[source.sourceId]: retainedSource.activeGeneration!},
      scope,
    }).results).toHaveLength(1);
  });

  it('keeps a newly activated generation when inactive cleanup fails', async () => {
    const wikiRoot = path.join(tmpDir, 'wiki-cleanup-failure');
    writeArticle(wikiRoot, 'handler.md', 'finalized', 'Handler callback execution.');
    execFileSync('git', ['init', '-q', wikiRoot]);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', wikiRoot, 'add', '.']);
    execFileSync('git', ['-C', wikiRoot, 'commit', '-qm', 'fixture']);
    const corpus = scanAndroidInternalsWiki(wikiRoot);
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources-failure.json'));
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: fs.realpathSync(wikiRoot),
      revision: execFileSync('git', ['-C', wikiRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      contentFingerprint: corpus.contentFingerprint,
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const store = new RagStore(path.join(tmpDir, 'rag-failure.json'));
    jest.spyOn(store, 'removeInactiveKnowledgeSourceChunks').mockImplementation(() => {
      throw new Error('cleanup unavailable');
    });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ingester = new AndroidInternalsWikiIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']}),
    );

    const result = await ingester.ingest(source.sourceId, scope);

    expect(result.cleanup).toEqual({
      status: 'failed',
      removedChunkCount: 0,
      error: 'cleanup unavailable',
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('cleanup unavailable'));
    warning.mockRestore();
    expect(registry.get(source.sourceId, scope)?.activeGeneration).toBe(result.generation);
  });

  it('rejects an oversized generation before activation', async () => {
    const wikiRoot = path.join(tmpDir, 'wiki-chunk-limit');
    writeArticle(wikiRoot, 'large.md', 'finalized', 'A'.repeat(4_000));
    execFileSync('git', ['init', '-q', wikiRoot]);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', wikiRoot, 'add', '.']);
    execFileSync('git', ['-C', wikiRoot, 'commit', '-qm', 'fixture']);
    const corpus = scanAndroidInternalsWiki(wikiRoot);
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources-limit.json'));
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: fs.realpathSync(wikiRoot),
      revision: execFileSync('git', ['-C', wikiRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      contentFingerprint: corpus.contentFingerprint,
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const store = new RagStore(path.join(tmpDir, 'rag-limit.json'));
    const ingester = new AndroidInternalsWikiIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']}),
    );

    await expect(ingester.ingest(source.sourceId, scope, {maxChunks: 1}))
      .rejects.toThrow('source_chunk_limit_exceeded:1');
    expect(registry.get(source.sourceId, scope)?.activeGeneration).toBeUndefined();
    expect(store.listChunks({scope})).toEqual([]);
  });

  it('rejects an interleaved reindex before it can delete the active generation', async () => {
    const wikiRoot = path.join(tmpDir, 'wiki-concurrent-reindex');
    writeArticle(wikiRoot, 'handler.md', 'finalized', 'Handler callback execution.');
    execFileSync('git', ['init', '-q', wikiRoot]);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', wikiRoot, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', wikiRoot, 'add', '.']);
    execFileSync('git', ['-C', wikiRoot, 'commit', '-qm', 'fixture']);
    const corpus = scanAndroidInternalsWiki(wikiRoot);
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources-concurrent.json'));
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: fs.realpathSync(wikiRoot),
      revision: execFileSync('git', ['-C', wikiRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      contentFingerprint: corpus.contentFingerprint,
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const store = new RagStore(path.join(tmpDir, 'rag-concurrent.json'));
    const gate = new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']});
    const ingester = new AndroidInternalsWikiIngester(store, registry, gate);
    const originalPreview = gate.preview.bind(gate);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => {
      entered = resolve;
    });
    const previewSpy = jest.spyOn(gate, 'preview').mockImplementationOnce(async rootPath => {
      entered();
      await held;
      return originalPreview(rootPath);
    });

    const first = ingester.ingest(source.sourceId, scope);
    await acquired;
    await expect(ingester.ingest(source.sourceId, scope))
      .rejects.toThrow('external_knowledge_reindex_in_progress');
    release();
    const result = await first;
    previewSpy.mockRestore();

    expect(registry.get(source.sourceId, scope)?.activeGeneration).toBe(result.generation);
    expect(store.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk => chunk.sourceGeneration === result.generation)).toHaveLength(
      result.indexedChunkCount,
    );
  });

  it('fences an expired enterprise lease before stale activation and cleanup', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-fencing.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const activeRoot = path.join(tmpDir, 'wiki-active');
    const staleRoot = path.join(tmpDir, 'wiki-stale');
    writeArticle(activeRoot, 'handler.md', 'finalized', 'ACTIVE_GENERATION Handler callback.');
    writeArticle(staleRoot, 'handler.md', 'finalized', 'STALE_GENERATION Handler callback.');
    for (const root of [activeRoot, staleRoot]) {
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
    }
    const activeCorpus = scanAndroidInternalsWiki(activeRoot);
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const firstRegistry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'first-fencing.json'));
    const secondRegistry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'second-fencing.json'));
    const source = firstRegistry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: fs.realpathSync(activeRoot),
      revision: execFileSync('git', ['-C', activeRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      contentFingerprint: activeCorpus.contentFingerprint,
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const store = new RagStore(path.join(tmpDir, 'rag-fencing.json'));
    const staleGate = new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']});
    const activeGate = new PathSecurityGate({allowlistRoots: [tmpDir], allowedExtensions: ['.md']});
    const originalStalePreview = staleGate.preview.bind(staleGate);
    let releaseStale!: () => void;
    const held = new Promise<void>(resolve => {
      releaseStale = resolve;
    });
    let staleEntered!: () => void;
    const acquired = new Promise<void>(resolve => {
      staleEntered = resolve;
    });
    jest.spyOn(staleGate, 'preview').mockImplementationOnce(async () => {
      const preview = await originalStalePreview(staleRoot);
      staleEntered();
      await held;
      return preview;
    });
    const staleIngester = new AndroidInternalsWikiIngester(store, firstRegistry, staleGate);
    const activeIngester = new AndroidInternalsWikiIngester(store, secondRegistry, activeGate);
    const clock = jest.spyOn(Date, 'now');
    const baseTime = 2_000_000_000_000;
    clock.mockReturnValue(baseTime);

    const staleRun = staleIngester.ingest(source.sourceId, scope);
    await acquired;
    clock.mockReturnValue(baseTime + 10 * 60 * 1000 + 1);
    const activeResult = await activeIngester.ingest(source.sourceId, scope);
    releaseStale();

    await expect(staleRun).rejects.toThrow('external_knowledge_reindex_lease_lost');
    const activeSource = secondRegistry.get(source.sourceId, scope)!;
    const activeChunks = store.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk => chunk.sourceGeneration === activeSource.activeGeneration);
    expect(activeSource.activeGeneration).toBe(activeResult.generation);
    expect(activeChunks).toHaveLength(activeResult.indexedChunkCount);
    expect(activeChunks.every(chunk => chunk.snippet.includes('ACTIVE_GENERATION'))).toBe(true);
  });
});
