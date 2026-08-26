// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry, activeCodebaseGeneration} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {AospSourceIngester} from '../rag/aospSourceIngester';
import {RagStore} from '../ragStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-source-ingester-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('AospSourceIngester', () => {
  it('indexes an AOSP registration through the active generation contract', async () => {
    const root = path.join(tmpDir, 'aosp');
    const sourcePath = path.join(root, 'frameworks', 'base', 'core', 'java', 'android');
    fs.mkdirSync(sourcePath, {recursive: true});
    fs.writeFileSync(
      path.join(sourcePath, 'TraceHooks.java'),
      'package android;\nfinal class TraceHooks { void installTracing() {} }\n',
    );
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
    const ref = registry.register({
      kind: 'aosp',
      displayName: 'AOSP',
      rootPath: root,
      pathFilters: ['frameworks/base'],
      licenseTag: 'Apache-2.0',
    });
    const store = new RagStore(path.join(tmpDir, 'rag.json'));

    const result = await new AospSourceIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [root]}),
    ).ingest(ref.codebaseId);

    const active = registry.get(ref.codebaseId)!;
    expect(result).toEqual(expect.objectContaining({
      filesProcessed: 1,
      chunksAdded: expect.any(Number),
      errors: [],
    }));
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(active.lastIngestStatus).toBe('ok');
    expect(activeCodebaseGeneration(active)).toBe(active.activeGeneration);
  });

  it('does not traverse the AOSP .repo object store during reindex', async () => {
    const root = path.join(tmpDir, 'large-aosp');
    const sourcePath = path.join(root, 'frameworks', 'base');
    const objectPath = path.join(root, '.repo', 'projects', 'frameworks', 'base.git', 'objects');
    fs.mkdirSync(sourcePath, {recursive: true});
    fs.mkdirSync(objectPath, {recursive: true});
    fs.writeFileSync(path.join(sourcePath, 'Main.java'), 'class Main {}\n');
    for (let index = 0; index < 12; index += 1) {
      fs.writeFileSync(path.join(objectPath, `object-${index}.java`), 'class Secret {}\n');
    }
    const registry = new CodebaseRegistry(path.join(tmpDir, 'large-registry.json'));
    const ref = registry.register({
      kind: 'aosp',
      displayName: 'Large AOSP',
      rootPath: root,
      pathFilters: ['frameworks/base'],
      licenseTag: 'Apache-2.0',
    });

    const result = await new AospSourceIngester(
      new RagStore(path.join(tmpDir, 'large-rag.json')),
      registry,
      new PathSecurityGate({allowlistRoots: [root], maxVisitedEntries: 4}),
    ).ingest(ref.codebaseId);

    expect(result.errors).toEqual([]);
    expect(result.filesProcessed).toBe(1);
    expect(registry.get(ref.codebaseId)?.lastIngestStatus).toBe('ok');
  });

  it('fails before staging a source file that exceeds the chunk budget', async () => {
    const root = path.join(tmpDir, 'chunk-budget-aosp');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Many.java'), [
      'class One { void a() {} }',
      'class Two { void b() {} }',
    ].join('\n'.repeat(300)));
    const registry = new CodebaseRegistry(path.join(tmpDir, 'chunk-budget-registry.json'));
    const ref = registry.register({
      kind: 'aosp',
      displayName: 'AOSP',
      rootPath: root,
      licenseTag: 'Apache-2.0',
    });
    const store = new RagStore(path.join(tmpDir, 'chunk-budget-rag.json'));

    await expect(new AospSourceIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [root]}),
    ).ingest(ref.codebaseId, {maxChunkChars: 256, maxChunks: 1}))
      .rejects.toThrow('source_chunk_limit_exceeded:1');
    expect(store.listChunks({scope: ref})).toHaveLength(0);
  });
});
