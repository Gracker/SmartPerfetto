// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {RagStore} from '../ragStore';
import {
  AospKnowledgeIngester,
  __TEST_ONLY__,
  type AospFetcher,
  type AospFile,
} from '../aospKnowledgeIngester';

let tmpDir: string;
let storagePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-ingester-test-'));
  storagePath = path.join(tmpDir, 'rag.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

class StubAospFetcher implements AospFetcher {
  constructor(private files: AospFile[] | Error) {}
  async fetchFiles(): Promise<AospFile[]> {
    if (this.files instanceof Error) throw this.files;
    return this.files;
  }
}

function makeFile(overrides: Partial<AospFile> = {}): AospFile {
  return {
    filePath: 'frameworks/base/services/.../HwcLayer.cpp',
    content: 'void HwcLayer::compose() {\n  // composition fallback path\n}\n',
    commitHash: 'abc1234',
    fetchedAt: 1714600000000,
    license: 'Apache-2.0',
    ...overrides,
  };
}

describe('AospKnowledgeIngester — happy path', () => {
  it('ingests a file and stores chunks under kind=aosp', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([makeFile()]),
    );
    const result = await ingester.ingest();
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    const stats = store.getStats();
    expect(stats.aosp.chunkCount).toBe(result.chunksAdded);
  });

  it('chunks carry the AOSP license stamp', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([makeFile()]),
    );
    await ingester.ingest();
    const search = store.search('compose composition fallback');
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0].chunk?.license).toBe('Apache-2.0');
  });

  it('chunkId is stable for re-ingestion', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([makeFile()]),
    );
    await ingester.ingest();
    const before = store.getStats().aosp.chunkCount;
    await ingester.ingest();
    const after = store.getStats().aosp.chunkCount;
    expect(after).toBe(before);
  });

  it('uses last path segment as title when not supplied', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([
        makeFile({filePath: 'frameworks/.../HwcLayer.cpp'}),
      ]),
    );
    await ingester.ingest();
    const search = store.search('composition');
    expect(search.results[0].chunk?.title).toBe('HwcLayer.cpp');
  });
});

describe('AospKnowledgeIngester — license gate', () => {
  it('rejects files without a license, recording in errors', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([makeFile({license: ''})]),
    );
    const result = await ingester.ingest();
    expect(result.chunksAdded).toBe(0);
    expect(result.chunksSkipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/license required/);
  });

  it('rejects whitespace-only license strings', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher([makeFile({license: '   '})]),
    );
    const result = await ingester.ingest();
    expect(result.chunksSkipped).toBe(1);
    expect(result.errors[0].reason).toMatch(/license/);
  });
});

describe('AospKnowledgeIngester — fetcher errors', () => {
  it('reports a fetcher error without throwing', async () => {
    const store = new RagStore(storagePath);
    const ingester = new AospKnowledgeIngester(
      store,
      new StubAospFetcher(new Error('manifest missing')),
    );
    const result = await ingester.ingest();
    expect(result.filesProcessed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toMatch(/manifest missing/);
  });
});

describe('AospKnowledgeIngester — chunkSource boundary detection', () => {
  it('splits at function boundaries when present', () => {
    const src = `// header comment
class Foo {
  void a() {
    // body of a
  }
  void b() {
    // body of b
  }
};`;
    const chunks = __TEST_ONLY__.chunkSource(src, 50);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('falls back to fixed-size when no boundaries match', () => {
    const src = 'plain text '.repeat(500);
    const chunks = __TEST_ONLY__.chunkSource(src, 200);
    // Expect each chunk to be at most ~2× max (the fallback bound).
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
  });

  it('returns empty for empty input', () => {
    expect(__TEST_ONLY__.chunkSource('', 100)).toEqual([]);
    expect(__TEST_ONLY__.chunkSource('   ', 100)).toEqual([]);
  });

  it('makeChunkId is deterministic per (path, offset)', () => {
    const a = __TEST_ONLY__.makeChunkId('frameworks/base/Hwc.cpp', 0);
    const b = __TEST_ONLY__.makeChunkId('frameworks/base/Hwc.cpp', 0);
    const c = __TEST_ONLY__.makeChunkId('frameworks/base/Hwc.cpp', 100);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
