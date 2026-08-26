// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {activeCodebaseGeneration, CodebaseRegistry} from '../codebase/codebaseRegistry';
import {
  PathSecurityGate,
  readAcceptedTextFileSync,
  readOpenedTextFileBoundedSync,
} from '../codebase/pathSecurityGate';
import {SourceEnumerator} from '../codebase/sourceEnumerator';
import {AppSourceIngester} from '../rag/appSourceIngester';
import {stableChunkId} from '../rag/baseIngester';
import {inspectSourceGeneration} from '../rag/sourceFileSelection';
import {RagStore} from '../ragStore';
import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-source-ingester-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function makeIngester(root: string, sendToProvider = true) {
  const store = new RagStore(path.join(tmpDir, 'rag.json'));
  const registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  const ref = registry.register({
    kind: 'app_source',
    displayName: 'App',
    rootPath: root,
    sendToProvider,
    buildId: 'debug',
  });
  const ingester = new AppSourceIngester(store, registry, new PathSecurityGate({allowlistRoots: [root]}));
  return {store, registry, ref, ingester};
}

describe('AppSourceIngester', () => {
  it('reuses only the registered native-picker root authorization during reindex', async () => {
    const selectedRoot = path.join(tmpDir, 'native-selected-source');
    fs.mkdirSync(selectedRoot);
    fs.writeFileSync(path.join(selectedRoot, 'Main.kt'), 'class NativeSelected\n');
    const store = new RagStore(path.join(tmpDir, 'native-picker-rag.json'));
    const registry = new CodebaseRegistry(path.join(tmpDir, 'native-picker-codebases.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Native selected source',
      rootPath: selectedRoot,
      rootAuthorization: 'native_picker',
    });
    const gate = new PathSecurityGate({
      allowlistRoots: [path.join(tmpDir, 'configured-only')],
    });
    const ingester = new AppSourceIngester(store, registry, gate);

    await expect(ingester.ingest(ref.codebaseId)).resolves.toMatchObject({
      filesProcessed: 1,
      chunksAdded: 1,
    });
    await expect(gate.preview(selectedRoot)).resolves.toMatchObject({
      blocked: true,
      blockedReason: 'root_outside_allowlist',
    });
  });

  it('fails closed across dual-write registries when consent persistence fails', () => {
    const previous = {
      enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
      database: process.env[ENTERPRISE_DB_PATH_ENV],
      phase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
    };
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'codebase-dual-consent.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const root = path.join(tmpDir, 'dual-codebase');
    const registryPath = path.join(tmpDir, 'dual-codebases.json');
    fs.mkdirSync(root, {recursive: true});
    try {
      const first = new CodebaseRegistry(registryPath);
      const second = new CodebaseRegistry(registryPath);
      const ref = first.register({
        kind: 'app_source',
        displayName: 'Dual App',
        rootPath: root,
        sendToProvider: true,
      });
      jest.spyOn(first as any, 'persist').mockImplementationOnce(() => {
        throw new Error('simulated_filesystem_persist_failure');
      });

      expect(() => first.setProviderConsent(ref.codebaseId, ref, false, 'user-1'))
        .toThrow('simulated_filesystem_persist_failure');
      expect(second.get(ref.codebaseId, ref)?.consent.sendToProvider).toBe(false);
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore(ENTERPRISE_FEATURE_FLAG_ENV, previous.enterprise);
      restore(ENTERPRISE_DB_PATH_ENV, previous.database);
      restore(ENTERPRISE_MIGRATION_PHASE_ENV, previous.phase);
    }
  });

  it('bounds a source read even when the file grows after fstat', () => {
    const root = path.join(tmpDir, 'growing-source');
    const sourcePath = path.join(root, 'Growing.kt');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(sourcePath, 'class Growing\n');
    const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY);
    const opened = fs.fstatSync(descriptor);
    fs.appendFileSync(sourcePath, Buffer.alloc(2_048, 0x61));

    try {
      expect(() => readOpenedTextFileBoundedSync(descriptor, opened, 1_024))
        .toThrow('source_file_changed_or_too_large');
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it('enforces the actual generation byte budget after previewed files grow', async () => {
    const root = path.join(tmpDir, 'growing-generation');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'First.kt'), 'a');
    fs.writeFileSync(path.join(root, 'Second.kt'), 'b');
    const gate = new PathSecurityGate({
      allowlistRoots: [root],
      maxFileBytes: 16,
      maxTotalBytes: 5,
    });
    const preview = await gate.preview(root);
    expect(preview.blocked).toBe(false);
    expect(preview.acceptedFiles.map(file => file.sizeBytes)).toEqual([1, 1]);
    fs.writeFileSync(path.join(root, 'First.kt'), 'aaaa');
    fs.writeFileSync(path.join(root, 'Second.kt'), 'bbbb');
    const limits = gate.getSourceReadLimits();

    await expect(inspectSourceGeneration(
      preview.rootRealpath,
      preview.acceptedFiles,
      (acceptedRoot, relativePath) => readAcceptedTextFileSync(
        acceptedRoot,
        relativePath,
        limits.maxFileBytes,
      ),
      limits.maxTotalBytes,
    )).rejects.toThrow('source_total_bytes_exceeded:5');
  });

  it('indexes Java/Kotlin source with codebase metadata and symbols', async () => {
    const root = path.join(tmpDir, 'app');
    fs.mkdirSync(path.join(root, 'src/main/java/com/example'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src/main/java/com/example/MainActivity.kt'), [
      'package com.example',
      'class MainActivity {',
      '  fun onCreate() {',
      '    val api_key = "1234567890"',
      '  }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'README.md'), '# ignored\n');

    const {store, ref, ingester, registry} = makeIngester(root);
    const result = await ingester.ingest(ref.codebaseId);

    expect(result.filesProcessed).toBe(1);
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(result.redactionHitCount).toBe(1);
    const activeRef = registry.get(ref.codebaseId)!;
    const search = store.search('MainActivity', {
      kinds: ['app_source'] as Array<'app_source'>,
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {[ref.codebaseId]: activeCodebaseGeneration(activeRef)!},
      scope: ref,
    });
    expect(search.results[0]?.chunk).toEqual(expect.objectContaining({
      kind: 'app_source',
      registryOrigin: 'codebase_registry',
      codebaseId: ref.codebaseId,
      filePath: 'src/main/java/com/example/MainActivity.kt',
      language: 'kotlin',
      buildId: 'debug',
    }));
    expect(registry.get(ref.codebaseId)?.lastIngestStatus).toBe('ok');
  });

  it('pins actual clean and dirty Git provenance instead of trusting registration metadata', async () => {
    const root = path.join(tmpDir, 'git-app');
    fs.mkdirSync(root, {recursive: true});
    const sourcePath = path.join(root, 'Main.kt');
    fs.writeFileSync(sourcePath, 'class CleanRevision\n');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'SmartPerfetto Test']);
    execFileSync('git', ['-C', root, 'add', 'Main.kt']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'initial']);
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const store = new RagStore(path.join(tmpDir, 'git-rag.json'));
    const registry = new CodebaseRegistry(path.join(tmpDir, 'git-codebases.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Git App',
      rootPath: root,
      commitHash: 'unverified-registration-value',
      sendToProvider: true,
    });
    const ingester = new AppSourceIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [root]}),
    );

    await ingester.ingest(ref.codebaseId);
    const clean = registry.get(ref.codebaseId)!;
    expect(clean).toMatchObject({
      indexedRevision: revision,
      indexedDirty: false,
      commitProvenance: 'clean_git_revision',
    });
    const cleanFingerprint = clean.contentFingerprint;

    fs.writeFileSync(sourcePath, 'class DirtyWorktreeRevision\n');
    await ingester.ingest(ref.codebaseId);
    const dirty = registry.get(ref.codebaseId)!;
    expect(dirty).toMatchObject({
      indexedRevision: revision,
      indexedDirty: true,
      commitProvenance: 'dirty_git_worktree',
    });
    expect(dirty.contentFingerprint).not.toBe(cleanFingerprint);
    const hit = store.search('DirtyWorktreeRevision', {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {[ref.codebaseId]: activeCodebaseGeneration(dirty)!},
      scope: dirty,
    }).results[0]?.chunk;
    expect(hit).toMatchObject({
      commitHash: revision,
      sourceDirty: true,
      commitProvenance: 'dirty_git_worktree',
      contentFingerprint: dirty.contentFingerprint,
    });
  });

  it('honors registered path filters and exclude globs', async () => {
    const root = path.join(tmpDir, 'filtered');
    fs.mkdirSync(path.join(root, 'app'), {recursive: true});
    fs.mkdirSync(path.join(root, 'tools'), {recursive: true});
    fs.writeFileSync(path.join(root, 'app', 'Wanted.kt'), 'class Wanted\n');
    fs.writeFileSync(path.join(root, 'tools', 'Ignored.kt'), 'class Ignored\n');
    const store = new RagStore(path.join(tmpDir, 'rag-filtered.json'));
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry-filtered.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Filtered',
      rootPath: root,
      pathFilters: ['app/'],
      excludeGlobs: ['**/Ignored*.kt'],
    });

    fs.writeFileSync(path.join(root, 'app', 'IgnoredInApp.kt'), 'class IgnoredInApp\n');
    await new AppSourceIngester(store, registry, new PathSecurityGate({allowlistRoots: [root]})).ingest(ref.codebaseId);
    const active = activeCodebaseGeneration(registry.get(ref.codebaseId)!)!;
    const searchOptions: Parameters<RagStore['search']>[1] = {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {[ref.codebaseId]: active},
      scope: ref,
    };
    expect(store.search('Wanted', searchOptions).results).toHaveLength(1);
    expect(store.search('Ignored', searchOptions).results).toHaveLength(0);
  });

  it('marks ingestion blocked when the root is outside the security allowlist', async () => {
    const root = path.join(tmpDir, 'blocked');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'MainActivity.kt'), 'class MainActivity\n');
    const {ref, registry} = makeIngester(root);
    const blocked = await new AppSourceIngester(
      new RagStore(path.join(tmpDir, 'rag-blocked.json')),
      registry,
      new PathSecurityGate({allowlistRoots: [path.join(tmpDir, 'other')]}),
    ).ingest(ref.codebaseId);

    expect(blocked.errors[0]?.reason).toBe('root_outside_allowlist');
    expect(registry.get(ref.codebaseId)?.lastIngestStatus).toBe('blocked_by_security');
  });

  it('rejects a registered physical root that is replaced by an allowlisted symlink', async () => {
    if (process.platform === 'win32') return;
    const root = path.join(tmpDir, 'registered-root');
    const originalRoot = path.join(tmpDir, 'registered-root-original');
    const replacementRoot = path.join(tmpDir, 'replacement-root');
    fs.mkdirSync(root);
    fs.mkdirSync(replacementRoot);
    fs.writeFileSync(path.join(root, 'Original.kt'), 'class Original\n');
    fs.writeFileSync(path.join(replacementRoot, 'Replacement.kt'), 'class Replacement\n');
    const {ref, registry, store} = makeIngester(root);
    fs.renameSync(root, originalRoot);
    fs.symlinkSync(replacementRoot, root, 'dir');
    const ingester = new AppSourceIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [tmpDir]}),
    );

    await expect(ingester.ingest(ref.codebaseId)).rejects.toThrow('codebase_root_realpath_drift');
    expect(registry.get(ref.codebaseId)).toMatchObject({
      lastIngestStatus: 'blocked_by_security',
      lastIngestError: 'codebase_root_realpath_drift',
      indexGeneration: ref.indexGeneration,
    });
    expect(store.listChunks({scope: ref})).toEqual([]);
  });

  it('rejects overlapping reindex work before either run can share staged chunks', async () => {
    const root = path.join(tmpDir, 'concurrent');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'MainActivity.kt'), 'class MainActivity\n');
    const {store, ref, registry} = makeIngester(root);
    const gate = new PathSecurityGate({allowlistRoots: [root]});
    const enumerator = new SourceEnumerator();
    const originalEnumerate = enumerator.enumerate.bind(enumerator);
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    jest.spyOn(enumerator, 'enumerate').mockImplementationOnce(async input => {
      markEntered();
      await held;
      return originalEnumerate(input);
    });
    const ingester = new AppSourceIngester(store, registry, gate, enumerator);
    const first = ingester.ingest(ref.codebaseId);
    await entered;

    await expect(ingester.ingest(ref.codebaseId)).rejects.toThrow('codebase_reindex_in_progress');
    releaseFirst();
    await expect(first).resolves.toMatchObject({chunksAdded: 1});

    const activeRef = registry.get(ref.codebaseId)!;
    expect(store.search('MainActivity', {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {
        [ref.codebaseId]: activeCodebaseGeneration(activeRef)!,
      },
      scope: activeRef,
    }).results).toHaveLength(1);
  });

  it('rejects chunk sizes that could stall the chunking loop', async () => {
    const root = path.join(tmpDir, 'invalid-chunk-size');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'MainActivity.kt'), 'class MainActivity\n');
    const {ref, ingester} = makeIngester(root);

    await expect(ingester.ingest(ref.codebaseId, {maxChunkChars: 0}))
      .rejects.toThrow('maxChunkChars must be an integer between 256 and 65536');
  });

  it('does not truncate inside a selected file by treating chunk count as a separate budget', async () => {
    const root = path.join(tmpDir, 'chunk-budget');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Many.kt'), [
      'class One { fun a() = 1 }',
      'class Two { fun b() = 2 }',
    ].join('\n'.repeat(300)));
    const {store, ref, registry, ingester} = makeIngester(root);
    const generationBefore = registry.get(ref.codebaseId)!.indexGeneration;

    const result = await ingester.ingest(ref.codebaseId, {maxChunkChars: 256, maxChunks: 1});

    expect(result.chunksAdded).toBe(2);
    expect(registry.get(ref.codebaseId)).toMatchObject({
      indexGeneration: generationBefore + 1,
      lastIngestStatus: 'ok',
    });
    expect(store.listChunks({scope: ref})).toHaveLength(2);
  });

  it('keeps a complete active generation and stages deterministic truncation as pending', async () => {
    const root = path.join(tmpDir, 'pending-generation');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'A.kt'), 'class CompleteActive\n');
    const {store, ref, registry, ingester} = makeIngester(root);
    await ingester.ingest(ref.codebaseId);
    const activeBefore = registry.get(ref.codebaseId)!;
    fs.writeFileSync(path.join(root, 'B.kt'), 'class PendingCandidate\n');

    await ingester.ingest(ref.codebaseId, {maxChunks: 1});

    const after = registry.get(ref.codebaseId)!;
    expect(activeCodebaseGeneration(after)).toBe(activeCodebaseGeneration(activeBefore));
    expect(after.pendingGeneration).toEqual(expect.objectContaining({
      coverage: expect.objectContaining({
        truncated: true,
        truncationReason: 'file_budget',
      }),
    }));
    expect(store.countCodebaseGenerationChunks(
      ref.codebaseId,
      after.pendingGeneration!.candidateGenerationId,
      after,
    )).toBeGreaterThan(0);
  });

  it('does not let a stale run overwrite a newer activated generation', async () => {
    const root = path.join(tmpDir, 'stale-lease');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class NewGeneration\n');
    const storePath = path.join(tmpDir, 'rag-stale.json');
    const registryPath = path.join(tmpDir, 'registry-stale.json');
    const registryA = new CodebaseRegistry(registryPath);
    const ref = registryA.register({kind: 'app_source', displayName: 'App', rootPath: root});
    const registryB = new CodebaseRegistry(registryPath);
    const storeB = new RagStore(storePath);
    const gateA = new PathSecurityGate({allowlistRoots: [root]});
    const enumeratorA = new SourceEnumerator();
    const originalEnumerate = enumeratorA.enumerate.bind(enumeratorA);
    const newerRun = new AppSourceIngester(
      storeB,
      registryB,
      new PathSecurityGate({allowlistRoots: [root]}),
    );
    let leaseValid = true;
    jest.spyOn(registryA, 'withIngestLease').mockImplementation(async (_id, _scope, operation) =>
      operation({
        operationId: 'stale-operation',
        assertHeld: () => {
          if (!leaseValid) throw new Error('codebase_reindex_lease_lost');
        },
        updateIngestStatus: () => {
          throw new Error('stale status update must not run');
        },
        activateIndexGeneration: () => {
          throw new Error('stale activation must not run');
        },
        beginDeletion: () => {
          throw new Error('stale deletion must not run');
        },
        deleteRegistration: () => {
          throw new Error('stale deletion must not run');
        },
      }));
    jest.spyOn(enumeratorA, 'enumerate').mockImplementationOnce(async input => {
      const enumeration = await originalEnumerate(input);
      await newerRun.ingest(ref.codebaseId);
      leaseValid = false;
      return enumeration;
    });

    await expect(new AppSourceIngester(
      new RagStore(storePath),
      registryA,
      gateA,
      enumeratorA,
    ).ingest(ref.codebaseId)).rejects.toThrow('codebase_reindex_lease_lost');

    expect(registryB.get(ref.codebaseId)).toMatchObject({
      indexGeneration: ref.indexGeneration + 1,
      lastIngestStatus: 'ok',
    });
  });

  it('keeps the activated generation readable when stale cleanup fails', async () => {
    const root = path.join(tmpDir, 'cleanup-failure');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'MainActivity.kt'), 'class MainActivity\n');
    const {store, ref, registry, ingester} = makeIngester(root);
    jest.spyOn(store, 'removeCodebaseChunksExceptGeneration').mockImplementationOnce(() => {
      throw new Error('simulated cleanup failure');
    });

    const result = await ingester.ingest(ref.codebaseId);
    const activeRef = registry.get(ref.codebaseId)!;

    expect(result.errors[0]?.reason).toContain('inactive_chunk_cleanup_failed');
    expect(activeRef.lastIngestStatus).toBe('ok');
    expect(activeRef.maintenanceWarning).toBe('inactive_chunk_cleanup_failed');
    expect(store.search('MainActivity', {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {
        [ref.codebaseId]: activeCodebaseGeneration(activeRef)!,
      },
      scope: activeRef,
    }).results).toHaveLength(1);
  });

  it('isolates a retry from chunks orphaned by a crashed lease', async () => {
    const root = path.join(tmpDir, 'crash-retry');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class CrashSafeRetry\n');
    const {store, ref, registry, ingester} = makeIngester(root);
    const gate = new PathSecurityGate({allowlistRoots: [root]});
    const preview = await gate.preview(root);
    const provenance = await inspectSourceGeneration(
      preview.rootRealpath,
      preview.acceptedFiles,
      readAcceptedTextFileSync,
    );
    const nextIndexGeneration = ref.indexGeneration + 1;
    const orphanedGeneration = [
      `codebase_${nextIndexGeneration}`,
      provenance.contentFingerprint.slice(0, 16),
      stableChunkId(['expired-operation'], 12),
    ].join('_');
    store.addChunk({
      chunkId: 'orphaned-crash-chunk',
      kind: 'app_source',
      uri: `codebase://${ref.codebaseId}/Main.kt`,
      snippet: 'class OrphanedCrashChunk',
      tokenCount: 4,
      indexedAt: Date.now(),
      filePath: 'Main.kt',
      lineRange: {start: 1, end: 1},
      language: 'kotlin',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: orphanedGeneration,
      contentFingerprint: provenance.contentFingerprint,
      sourceDirty: provenance.sourceDirty,
      commitProvenance: provenance.commitProvenance,
    }, ref);
    store.flush();

    await expect(ingester.ingest(ref.codebaseId)).resolves.toMatchObject({
      chunksAdded: 1,
    });

    const activeRef = registry.get(ref.codebaseId)!;
    const activeGeneration = activeCodebaseGeneration(activeRef);
    expect(activeGeneration).not.toBe(orphanedGeneration);
    expect(activeGeneration).toMatch(
      new RegExp(`^codebase_${nextIndexGeneration}_[a-f0-9]{16}_[a-f0-9]{12}$`),
    );
    expect(store.listChunks({scope: activeRef})).toEqual([
      expect.objectContaining({
        snippet: expect.stringContaining('CrashSafeRetry'),
        sourceGeneration: activeGeneration,
      }),
    ]);
  });

  it('keeps the previous generation active when a later reindex cannot read every file', async () => {
    const root = path.join(tmpDir, 'failed-reindex');
    fs.mkdirSync(root, {recursive: true});
    const stablePath = path.join(root, 'Stable.kt');
    const failingPath = path.join(root, 'Failing.kt');
    fs.writeFileSync(stablePath, 'class StableGenerationOne\n');
    const {store, ref, registry} = makeIngester(root);
    const gate = new PathSecurityGate({allowlistRoots: [root]});
    const enumerator = new SourceEnumerator();
    const ingester = new AppSourceIngester(store, registry, gate, enumerator);
    await ingester.ingest(ref.codebaseId);
    const firstGeneration = registry.get(ref.codebaseId)!.indexGeneration;

    fs.writeFileSync(stablePath, 'class StableGenerationTwo\n');
    fs.writeFileSync(failingPath, 'class UnreadableGenerationTwo\n');
    const originalEnumerate = enumerator.enumerate.bind(enumerator);
    jest.spyOn(enumerator, 'enumerate').mockImplementationOnce(async input => {
      const enumeration = await originalEnumerate(input);
      fs.rmSync(failingPath);
      return enumeration;
    });

    await expect(ingester.ingest(ref.codebaseId)).rejects.toThrow(
      'codebase_reindex_incomplete:1_file_errors',
    );
    const activeRef = registry.get(ref.codebaseId)!;
    const searchOptions: Parameters<RagStore['search']>[1] = {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {
        [ref.codebaseId]: activeCodebaseGeneration(activeRef)!,
      },
      scope: activeRef,
    };

    expect(activeRef.indexGeneration).toBe(firstGeneration);
    expect(activeRef.lastIngestStatus).toBe('failed');
    expect(store.search('StableGenerationOne', searchOptions).results).toHaveLength(1);
    expect(store.search('StableGenerationTwo', searchOptions).results.some(
      hit => hit.chunk?.snippet.includes('StableGenerationTwo'),
    )).toBe(false);
    expect(store.search('UnreadableGenerationTwo', searchOptions).results.some(
      hit => hit.chunk?.snippet.includes('UnreadableGenerationTwo'),
    )).toBe(false);
  });

  it('keeps the previous generation when a request prefix selects no source files', async () => {
    const root = path.join(tmpDir, 'empty-selection');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Stable.kt'), 'class StableIndexedSource\n');
    const {store, ref, registry, ingester} = makeIngester(root);
    await ingester.ingest(ref.codebaseId);
    const activeBefore = registry.get(ref.codebaseId)!;

    await expect(ingester.ingest(ref.codebaseId, {pathPrefix: 'missing/path'}))
      .rejects.toThrow('source_selection_empty');

    const activeAfter = registry.get(ref.codebaseId)!;
    expect(activeAfter.indexGeneration).toBe(activeBefore.indexGeneration);
    expect(activeAfter.lastIngestStatus).toBe('failed');
    expect(store.search('StableIndexedSource', {
      kinds: ['app_source'],
      codebaseIds: [ref.codebaseId],
      activeCodebaseGenerations: {[ref.codebaseId]: activeCodebaseGeneration(activeAfter)!},
      scope: activeAfter,
    }).results).toHaveLength(1);
  });
});
