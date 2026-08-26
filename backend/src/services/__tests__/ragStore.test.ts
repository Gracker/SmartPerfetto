// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {constants as bufferConstants} from 'buffer';

import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';

import {
  DEFAULT_LOCAL_RAG_SEARCH_MAX_BYTES,
  DEFAULT_LOCAL_RAG_SEARCH_MAX_CHUNKS,
  DEFAULT_LOCAL_RAG_STORAGE_MAX_BYTES,
  DEFAULT_LOCAL_RAG_STORAGE_MAX_CHUNKS,
  RagStore,
  getDefaultRagStore,
  privateKnowledgeScopeFingerprint,
  ragStoreRequiresLicense,
} from '../ragStore';
import {
  MAX_SOURCE_CHUNKS_PER_GENERATION,
  SOURCE_INGEST_WRITE_BATCH_SIZE,
} from '../rag/sourceFileSelection';
import type {RagChunk} from '../../types/sparkContracts';

let tmpDir: string;
let storagePath: string;
const PRIVATE_SCOPE = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const EXPECTED_SAFE_LOCAL_RAG_STORAGE_MAX_BYTES = 128 * 1024 * 1024;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-store-test-'));
  storagePath = path.join(tmpDir, 'store.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'sha256:test001',
    kind: 'androidperformance.com',
    uri: 'https://androidperformance.com/binder',
    snippet: 'binder transactions reveal cross-process latency',
    indexedAt: 1714600000000,
    ...overrides,
  };
}

function makeCodebaseGenerationChunk(
  generation: string,
  index: number,
  snippet = `${generation} generation source ${index}`,
): RagChunk {
  return makeChunk({
    chunkId: `${generation}-${index}`,
    kind: 'app_source',
    uri: `codebase://capacity-codebase/src/${generation}/${index}.kt`,
    snippet,
    codebaseId: 'capacity-codebase',
    registryOrigin: 'codebase_registry',
    sourceGeneration: generation,
    filePath: `src/${generation}/${index}.kt`,
  });
}

function addCodebaseGeneration(
  store: RagStore,
  generation: string,
  chunkCount: number,
  snippetChars?: number,
): void {
  for (let start = 0; start < chunkCount; start += SOURCE_INGEST_WRITE_BATCH_SIZE) {
    const batchSize = Math.min(SOURCE_INGEST_WRITE_BATCH_SIZE, chunkCount - start);
    store.addChunks(Array.from({length: batchSize}, (_, offset) => {
      const index = start + offset;
      const prefix = `${generation} generation source ${index}`;
      const snippet = snippetChars === undefined
        ? prefix
        : prefix.padEnd(snippetChars, 'x').slice(0, snippetChars);
      return makeCodebaseGenerationChunk(generation, index, snippet);
    }), PRIVATE_SCOPE);
  }
}

describe('RagStore — basic CRUD', () => {
  it('shares one default store between admin ingestion and runtime lookup', () => {
    expect(getDefaultRagStore()).toBe(getDefaultRagStore());
  });

  it('adds and reads back a chunk', () => {
    const store = new RagStore(storagePath);
    const chunk = makeChunk({chunkId: 'a'});
    store.addChunk(chunk);
    expect(store.getChunk('a')).toEqual({
      ...chunk,
      registryOrigin: 'legacy_plan55',
    });
  });

  it('returns undefined for an unknown chunkId', () => {
    const store = new RagStore(storagePath);
    expect(store.getChunk('nope')).toBeUndefined();
  });

  it('removeChunk returns true when present, false otherwise', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(store.removeChunk('a')).toBe(true);
    expect(store.removeChunk('a')).toBe(false);
  });

  it('replaces a chunk on re-add with the same chunkId', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a', snippet: 'old'}));
    store.addChunk(makeChunk({chunkId: 'a', snippet: 'new'}));
    expect(store.getChunk('a')?.snippet).toBe('new');
  });
});

describe('RagStore — codebase generation cleanup', () => {
  it('preserves both active and pending generations while removing superseded chunks', () => {
    const store = new RagStore(storagePath);
    store.addChunks(['active', 'pending', 'old'].map(generation => makeChunk({
      chunkId: `chunk-${generation}`,
      kind: 'app_source',
      uri: `codebase://cb-1/${generation}`,
      codebaseId: 'cb-1',
      registryOrigin: 'codebase_registry',
      sourceGeneration: generation,
    })), PRIVATE_SCOPE);

    store.removeCodebaseChunksExceptGeneration('cb-1', ['active', 'pending'], PRIVATE_SCOPE);

    expect(store.getChunk('chunk-active', PRIVATE_SCOPE)).toBeDefined();
    expect(store.getChunk('chunk-pending', PRIVATE_SCOPE)).toBeDefined();
    expect(store.getChunk('chunk-old', PRIVATE_SCOPE)).toBeUndefined();
  });
});

describe('RagStore — license gate', () => {
  it('rejects aosp chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({chunkId: 'a', kind: 'aosp'})),
    ).toThrow(/license/i);
  });

  it('rejects oem_sdk chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({chunkId: 'a', kind: 'oem_sdk'})),
    ).toThrow(/license/i);
  });

  it('rejects Android Internals Wiki chunks without a license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(makeChunk({
        chunkId: 'wiki-a',
        kind: 'android_internals_wiki' as RagChunk['kind'],
      })),
    ).toThrow(/license/i);
  });

  it('accepts aosp chunks with Apache-2.0 license', () => {
    const store = new RagStore(storagePath);
    expect(() =>
      store.addChunk(
        makeChunk({chunkId: 'a', kind: 'aosp', license: 'Apache-2.0'}),
      ),
    ).not.toThrow();
  });

  it('blog chunks are not gated by license', () => {
    const store = new RagStore(storagePath);
    expect(() => store.addChunk(makeChunk())).not.toThrow();
  });

  it('ragStoreRequiresLicense reports the right kinds', () => {
    expect(ragStoreRequiresLicense('aosp')).toBe(true);
    expect(ragStoreRequiresLicense('oem_sdk')).toBe(true);
    expect(ragStoreRequiresLicense('kernel_source')).toBe(true);
    expect(ragStoreRequiresLicense('androidperformance.com')).toBe(false);
    expect(ragStoreRequiresLicense('project_memory')).toBe(false);
    expect(ragStoreRequiresLicense('world_memory')).toBe(false);
    expect(ragStoreRequiresLicense('case_library')).toBe(false);
    expect(ragStoreRequiresLicense('app_source')).toBe(false);
  });
});

describe('RagStore — persistence', () => {
  it('decouples the default whole-store capacity from the local search budget', () => {
    expect(DEFAULT_LOCAL_RAG_SEARCH_MAX_CHUNKS).toBe(20_000);
    expect(DEFAULT_LOCAL_RAG_SEARCH_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_LOCAL_RAG_STORAGE_MAX_CHUNKS).toBe(50_000);
    expect(DEFAULT_LOCAL_RAG_STORAGE_MAX_CHUNKS)
      .toBeGreaterThan(MAX_SOURCE_CHUNKS_PER_GENERATION * 2);
    expect(DEFAULT_LOCAL_RAG_STORAGE_MAX_BYTES)
      .toBe(EXPECTED_SAFE_LOCAL_RAG_STORAGE_MAX_BYTES);
    expect(DEFAULT_LOCAL_RAG_STORAGE_MAX_BYTES * 3)
      .toBeLessThan(bufferConstants.MAX_STRING_LENGTH);
  });

  it('keeps a max-size active generation while staging and persisting its replacement', () => {
    const store = new RagStore(storagePath);
    addCodebaseGeneration(store, 'active', MAX_SOURCE_CHUNKS_PER_GENERATION, 2_200);
    store.flush();

    addCodebaseGeneration(store, 'pending', MAX_SOURCE_CHUNKS_PER_GENERATION, 2_200);

    expect(store.countCodebaseGenerationChunks(
      'capacity-codebase',
      'active',
      PRIVATE_SCOPE,
    )).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
    expect(store.countCodebaseGenerationChunks(
      'capacity-codebase',
      'pending',
      PRIVATE_SCOPE,
    )).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
    expect(store.search('active generation', {
      kinds: ['app_source'],
      codebaseIds: ['capacity-codebase'],
      activeCodebaseGenerations: {'capacity-codebase': 'active'},
      scope: PRIVATE_SCOPE,
      topK: 1,
    }).results).toHaveLength(1);

    store.flush();
    expect(fs.statSync(storagePath).size)
      .toBeGreaterThan(DEFAULT_LOCAL_RAG_STORAGE_MAX_BYTES * 0.75);
    expect(fs.statSync(storagePath).size)
      .toBeLessThanOrEqual(DEFAULT_LOCAL_RAG_STORAGE_MAX_BYTES);
    const reloaded = new RagStore(storagePath);
    expect(reloaded.listChunks({scope: PRIVATE_SCOPE})).toHaveLength(
      MAX_SOURCE_CHUNKS_PER_GENERATION * 2,
    );

    expect(reloaded.removeCodebaseChunksExceptGeneration(
      'capacity-codebase',
      'pending',
      PRIVATE_SCOPE,
    )).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
    expect(reloaded.countCodebaseGenerationChunks(
      'capacity-codebase',
      'pending',
      PRIVATE_SCOPE,
    )).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
  }, 60_000);

  it('honors an exact low byte override while active and pending generations coexist', () => {
    const active = makeCodebaseGenerationChunk('active-bytes', 0, 'a'.repeat(1024));
    const pending = makeCodebaseGenerationChunk('pending-bytes', 0, 'b'.repeat(1024));
    const third = makeCodebaseGenerationChunk('third-bytes', 0, 'c'.repeat(1024));
    const sizingStore = new RagStore(path.join(tmpDir, 'sizing.json'));
    sizingStore.addChunks([active, pending], PRIVATE_SCOPE);
    const normalized = sizingStore.listChunks({scope: PRIVATE_SCOPE});
    const exactTwoGenerationBytes = Buffer.byteLength(JSON.stringify({
      schemaVersion: 2,
      chunks: normalized,
    }), 'utf8');
    expect(normalized.every(chunk =>
      chunk.knowledgeScopeFingerprint === privateKnowledgeScopeFingerprint(PRIVATE_SCOPE)))
      .toBe(true);

    const bounded = new RagStore(path.join(tmpDir, 'bounded-generations.json'), {
      localStorageMaxChunks: 3,
      localStorageMaxBytes: exactTwoGenerationBytes,
    });
    bounded.addChunk(active, PRIVATE_SCOPE);
    bounded.flush();
    bounded.addChunk(pending, PRIVATE_SCOPE);
    bounded.flush();

    expect(new RagStore(path.join(tmpDir, 'bounded-generations.json'), {
      localStorageMaxChunks: 3,
      localStorageMaxBytes: exactTwoGenerationBytes,
    }).listChunks({scope: PRIVATE_SCOPE})).toHaveLength(2);
    expect(() => bounded.addChunk(third, PRIVATE_SCOPE))
      .toThrow('serialized size');
  });

  it('persists across instances at the same path', () => {
    const store1 = new RagStore(storagePath);
    store1.addChunk(makeChunk({chunkId: 'a', snippet: 'persisted'}));
    store1.flush();

    const store2 = new RagStore(storagePath);
    expect(store2.getChunk('a')?.snippet).toBe('persisted');
  });

  it('validates bulk storage incrementally and serializes the full corpus once at flush', () => {
    const store = new RagStore(storagePath);
    const serializeSpy = jest.spyOn(
      store as unknown as {serializeWithinStorageBudget(chunks: readonly RagChunk[]): string},
      'serializeWithinStorageBudget',
    );

    for (let batch = 0; batch < 4; batch++) {
      store.addChunks(Array.from({length: 25}, (_, offset) => makeChunk({
        chunkId: `bulk-${batch}-${offset}`,
        snippet: `batch ${batch}, item ${offset}`,
      })));
    }

    expect(serializeSpy).not.toHaveBeenCalled();
    store.flush();
    expect(serializeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf-8')).chunks).toHaveLength(100);
  });

  it('merges interleaved writers instead of overwriting a stale in-memory snapshot', () => {
    const first = new RagStore(storagePath);
    const second = new RagStore(storagePath);
    first.addChunk(makeChunk({chunkId: 'first', snippet: 'first writer'}));
    second.addChunk(makeChunk({chunkId: 'second', snippet: 'second writer'}));

    first.flush();
    second.flush();

    expect(new RagStore(storagePath).listChunks().map(chunk => chunk.chunkId).sort())
      .toEqual(['first', 'second']);
  });

  it('rejects an oversized concurrent-writer merge before stringifying the full envelope', () => {
    const firstChunk = makeChunk({chunkId: 'merge-first', snippet: 'a'.repeat(1024)});
    const secondChunk = makeChunk({chunkId: 'merge-second', snippet: 'b'.repeat(1024)});
    const sizingStore = new RagStore(path.join(tmpDir, 'merge-sizing.json'));
    sizingStore.addChunks([firstChunk, secondChunk]);
    const normalizedChunks = sizingStore.listChunks();
    const singleChunkEnvelopeBytes = Math.max(...normalizedChunks.map(chunk =>
      Buffer.byteLength(JSON.stringify({schemaVersion: 2, chunks: [chunk]}), 'utf8')));
    const limits = {
      localStorageMaxChunks: 10,
      localStorageMaxBytes: singleChunkEnvelopeBytes,
    };
    const first = new RagStore(storagePath, limits);
    const second = new RagStore(storagePath, limits);
    first.addChunk(firstChunk);
    second.addChunk(secondChunk);
    first.flush();
    const stringify = jest.spyOn(JSON, 'stringify');

    try {
      expect(() => second.flush()).toThrow('serialized size');
      const mergedEnvelopeCalls = stringify.mock.calls.filter(([value]) => {
        const envelope = value as {schemaVersion?: number; chunks?: unknown[]};
        return envelope?.schemaVersion === 2 && envelope.chunks?.length === 2;
      });
      expect(mergedEnvelopeCalls).toHaveLength(0);
    } finally {
      stringify.mockRestore();
    }
    expect(new RagStore(storagePath, limits).listChunks().map(chunk => chunk.chunkId))
      .toEqual(['merge-first']);
  });

  it('refreshes a warm reader after another instance adds and removes chunks', () => {
    const reader = new RagStore(storagePath);
    const writer = new RagStore(storagePath);
    expect(reader.listChunks()).toEqual([]);

    writer.addChunk(makeChunk({chunkId: 'cross-process', snippet: 'fresh'}));
    writer.flush();
    expect(reader.listChunks().map(chunk => chunk.chunkId)).toEqual(['cross-process']);

    writer.removeChunk('cross-process');
    expect(reader.listChunks()).toEqual([]);
  });

  it.each([
    ['corrupted JSON', 'not-json{'],
    ['an unsupported schema', JSON.stringify({schemaVersion: 99, chunks: []})],
  ])('fails closed when a warm private reader sees %s', (_label, invalidContent) => {
    const writer = new RagStore(storagePath);
    writer.addChunk(makeChunk({
      chunkId: 'private-warm-cache',
      kind: 'android_internals_wiki',
      uri: 'android-internals-wiki://source-a/private-warm-cache',
      snippet: 'PRIVATE_WARM_CACHE_CANARY Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: 'source-a',
      sourceGeneration: 'gen-1',
    }), PRIVATE_SCOPE);
    writer.flush();

    const reader = new RagStore(storagePath);
    const searchOptions = {
      kinds: ['android_internals_wiki'] as RagChunk['kind'][],
      knowledgeSourceIds: ['source-a'],
      activeSourceGenerations: {'source-a': 'gen-1'},
      scope: PRIVATE_SCOPE,
    };
    expect(reader.search('Handler', searchOptions).results).toHaveLength(1);

    fs.writeFileSync(storagePath, invalidContent, 'utf-8');

    expect(reader.search('Handler', searchOptions).results).toEqual([]);
    expect(JSON.stringify(reader.listChunks({scope: PRIVATE_SCOPE})))
      .not.toContain('PRIVATE_WARM_CACHE_CANARY');
  });

  it('persisted file is valid JSON with schemaVersion 2', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    store.flush();
    const raw = fs.readFileSync(storagePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.chunks).toHaveLength(1);
  });

  it('does not crash on a missing storage file', () => {
    const store = new RagStore(path.join(tmpDir, 'absent.json'));
    expect(store.getChunk('a')).toBeUndefined();
  });

  it('fails closed before reading an oversized local store', () => {
    fs.writeFileSync(storagePath, 'x'.repeat(1_024), 'utf8');
    const store = new RagStore(storagePath, {
      localStorageMaxBytes: 128,
    });

    const result = store.search('anything');

    expect(result.results).toEqual([]);
    expect(result.unsupportedReason).toContain('local_rag_storage_budget_exceeded');
  });

  it('enforces the safe default byte ceiling before parsing local JSON', () => {
    fs.writeFileSync(storagePath, '');
    fs.truncateSync(storagePath, EXPECTED_SAFE_LOCAL_RAG_STORAGE_MAX_BYTES + 1);
    const store = new RagStore(storagePath);

    const result = store.search('anything');

    expect(result.results).toEqual([]);
    expect(result.unsupportedReason).toContain('local_rag_storage_budget_exceeded');
    expect(result.unsupportedReason).toContain(
      `exceeds ${EXPECTED_SAFE_LOCAL_RAG_STORAGE_MAX_BYTES} bytes`,
    );
  });

  it('rejects a local write that would exceed the complete store chunk cap', () => {
    const store = new RagStore(storagePath, {
      localStorageMaxChunks: 2,
    });
    store.addChunks([
      makeChunk({chunkId: 'bounded-1'}),
      makeChunk({chunkId: 'bounded-2'}),
    ]);

    expect(() => store.addChunk(makeChunk({chunkId: 'bounded-3'})))
      .toThrow('chunk count 3 exceeds 2');
    expect(store.listChunks().map(chunk => chunk.chunkId))
      .toEqual(['bounded-1', 'bounded-2']);
  });

  it('survives a corrupted on-disk JSON without losing the file', () => {
    fs.writeFileSync(storagePath, 'not-json{', 'utf-8');
    const store = new RagStore(storagePath);
    expect(store.getChunk('a')).toBeUndefined();
    // Corrupted file is preserved for operator inspection.
    expect(fs.existsSync(storagePath)).toBe(true);
    // Pending writes can be staged in memory but cannot overwrite the corrupt
    // operator artifact until it is explicitly repaired.
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(store.getChunk('a')).toBeDefined();
    expect(() => store.flush()).toThrow('rag_store_invalid_storage_requires_recovery');
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe('not-json{');
  });

  it('does not overwrite an unsupported schema during a later flush', () => {
    const original = JSON.stringify({schemaVersion: 99, chunks: [{chunkId: 'operator-data'}]});
    fs.writeFileSync(storagePath, original, 'utf-8');
    const store = new RagStore(storagePath);

    store.addChunk(makeChunk({chunkId: 'pending'}));
    expect(() => store.flush()).toThrow('rag_store_invalid_storage_requires_recovery');
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe(original);
  });

  it('atomic write does not leave the temp file around on success', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({chunkId: 'a'}));
    expect(fs.existsSync(`${storagePath}.tmp`)).toBe(false);
  });

  it('backfills schemaVersion 1 legacy chunks with registryOrigin', () => {
    fs.writeFileSync(storagePath, JSON.stringify({
      schemaVersion: 1,
      chunks: [
        makeChunk({chunkId: 'blog-v1'}),
        makeChunk({chunkId: 'case-v1', kind: 'case_library'}),
      ],
    }), 'utf-8');
    const store = new RagStore(storagePath);
    expect(store.getChunk('blog-v1')?.registryOrigin).toBe('legacy_plan55');
    expect(store.getChunk('case-v1')?.registryOrigin).toBe('plan54_cases');
  });

  it('rejects code-aware chunks without codebase metadata', () => {
    const store = new RagStore(storagePath);
    expect(() => store.addChunk(makeChunk({
      chunkId: 'bad-app',
      kind: 'app_source',
      uri: 'src/MainActivity.kt',
      snippet: 'class MainActivity',
    }))).toThrow(/codebaseId/i);
  });
});

describe('RagStore — search', () => {
  function seed(store: RagStore): void {
    store.addChunk(
      makeChunk({
        chunkId: 'b1',
        kind: 'androidperformance.com',
        title: 'Binder transactions',
        snippet: 'binder transactions reveal cross-process latency',
      }),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'b2',
        kind: 'androidperformance.com',
        title: 'Frame timeline',
        snippet: 'frame timeline tells the truth about jank',
      }),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'a1',
        kind: 'aosp',
        license: 'Apache-2.0',
        title: 'HwcLayer',
        snippet: 'composition fallback path lives in HwcLayer',
      }),
    );
  }

  it('returns ranked hits matching the query tokens', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('binder transactions');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].chunkId).toBe('b1');
  });

  it('matches Chinese knowledge with Unicode-aware tokens', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'zh-handler',
      title: 'Looper 与消息队列',
      snippet: '主线程消息队列阻塞会推迟 Handler 分发',
    }));

    const result = store.search('消息队列阻塞');

    expect(result.results[0]?.chunkId).toBe('zh-handler');
  });

  it.each([
    ['camelCase', 'calculateFrameBudget'],
    ['snake_case', 'calculate_frame_budget'],
  ])('matches natural-language words against %s source identifiers', (_label, symbol) => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: `identifier-${_label}`,
      snippet: 'unrelated implementation details',
      symbol,
    }));

    expect(store.search('frame budget').results[0]?.chunkId).toBe(`identifier-${_label}`);
  });

  it('splits adjacent Latin and Han runs for mixed Android queries', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'mixed-handler',
      title: 'Android消息队列',
      snippet: 'Looper分发callback',
    }));

    expect(store.search('消息队列').results[0]?.chunkId).toBe('mixed-handler');
    expect(store.search('Android').results[0]?.chunkId).toBe('mixed-handler');
  });

  it('respects topK', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search(
      'binder transaction frame timeline composition',
      {topK: 1},
    );
    expect(result.results).toHaveLength(1);
  });

  it('bounds search amplification and rejects malformed search input', () => {
    const store = new RagStore(storagePath);
    for (let index = 0; index < 150; index++) {
      store.addChunk(makeChunk({
        chunkId: `bounded-${index}`,
        snippet: `binder transaction candidate ${index}`,
      }));
    }

    expect(store.search('binder transaction', {topK: 1_000_000_000}).results)
      .toHaveLength(100);
    expect(() => store.search('binder', {topK: Number.NaN})).toThrow('positive integer');
    expect(() => store.search('binder', {topK: -1})).toThrow('positive integer');
    expect(() => store.search('x'.repeat(8 * 1024 + 1))).toThrow('byte search limit');
    expect(() => store.search('binder', {
      codebaseIds: Array.from({length: 101}, (_, index) => `codebase-${index}`),
    })).toThrow('item search limit');
  });

  it('respects the kind filter', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('composition', {kinds: ['aosp']});
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(r => r.chunk?.kind === 'aosp')).toBe(true);
  });

  it('searches only the request-scoped active private knowledge generation', () => {
    const store = new RagStore(storagePath);
    const wiki = (overrides: Record<string, unknown>) => makeChunk({
      kind: 'android_internals_wiki' as RagChunk['kind'],
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry' as RagChunk['registryOrigin'],
      snippet: '消息队列 Handler callback',
      ...(overrides as Partial<RagChunk>),
    });
    store.addChunk(
      wiki({chunkId: 'old', knowledgeSourceId: 'source-a', sourceGeneration: 'gen-1'}),
      PRIVATE_SCOPE,
    );
    store.addChunk(
      wiki({chunkId: 'new', knowledgeSourceId: 'source-a', sourceGeneration: 'gen-2'}),
      PRIVATE_SCOPE,
    );
    store.addChunk(
      wiki({chunkId: 'other', knowledgeSourceId: 'source-b', sourceGeneration: 'gen-2'}),
      PRIVATE_SCOPE,
    );

    const result = store.search('Handler', {
      kinds: ['android_internals_wiki' as RagChunk['kind']],
      knowledgeSourceIds: ['source-a'],
      activeSourceGenerations: {'source-a': 'gen-2'},
      scope: PRIVATE_SCOPE,
    });

    expect(result.results.map(hit => hit.chunkId)).toEqual(['new']);
  });

  it('removes every generation for one private knowledge source in one operation', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('new', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('other', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();

    expect(store.removeKnowledgeSourceChunks('source-a', PRIVATE_SCOPE)).toBe(2);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual(['other']);
  });

  it('removes only inactive generations for one private knowledge source', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('active', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('other', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();

    expect(store.removeInactiveKnowledgeSourceChunks('source-a', 'gen-2', PRIVATE_SCOPE)).toBe(1);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual([
      'active',
      'other',
    ]);
  });

  it('removes only an exact private-chunk snapshot during fenced cleanup', () => {
    const store = new RagStore(storagePath);
    const wiki = (chunkId: string, sourceId: string, generation: string) => makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${sourceId}/${chunkId}`,
      snippet: 'Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: sourceId,
      sourceGeneration: generation,
    });
    store.addChunk(wiki('snapshot-old', 'source-a', 'gen-1'), PRIVATE_SCOPE);
    store.addChunk(wiki('later-active', 'source-a', 'gen-2'), PRIVATE_SCOPE);
    store.addChunk(wiki('same-id-other-source', 'source-b', 'gen-1'), PRIVATE_SCOPE);
    store.flush();
    const persist = jest.spyOn(store as any, 'persist');

    expect(store.removeKnowledgeSourceChunkIds(
      'source-a',
      ['snapshot-old', 'same-id-other-source'],
      PRIVATE_SCOPE,
    )).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.listChunks({scope: PRIVATE_SCOPE}).map(chunk => chunk.chunkId)).toEqual([
      'later-active',
      'same-id-other-source',
    ]);
  });

  it('fails closed across tenant, workspace, and user scope in the legacy store', () => {
    const store = new RagStore(storagePath);
    const chunk = makeChunk({
      chunkId: 'private-a',
      kind: 'android_internals_wiki',
      uri: 'android-internals-wiki://source-a/private-a',
      snippet: 'PRIVATE_SCOPE_CANARY Handler callback',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: 'source-a',
      sourceGeneration: 'gen-1',
    });
    store.addChunk(chunk, PRIVATE_SCOPE);

    const otherUser = {...PRIVATE_SCOPE, userId: 'user-b'};
    expect(store.getChunk('private-a', PRIVATE_SCOPE)?.snippet).toContain('PRIVATE_SCOPE_CANARY');
    expect(store.getChunk('private-a', otherUser)).toBeUndefined();
    expect(store.getChunk('private-a')).toBeUndefined();
    expect(store.listChunks({scope: otherUser})).toEqual([]);
    expect(store.getStats(otherUser).android_internals_wiki.chunkCount).toBe(0);
    expect(store.search('Handler', {
      kinds: ['android_internals_wiki'],
      knowledgeSourceIds: ['source-a'],
      activeSourceGenerations: {'source-a': 'gen-1'},
      scope: otherUser,
    }).results).toEqual([]);
  });

  it('supports codebase metadata filters and rank tiers', () => {
    const store = new RagStore(storagePath);
    store.addChunk(makeChunk({
      chunkId: 'app-main',
      kind: 'app_source',
      uri: 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt',
      snippet: 'simulate async network load during startup',
      codebaseId: 'codebase-1',
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_1',
      filePath: 'launch-aosp/src/main/java/com/example/launch/aosp/MainActivity.kt',
      lineRange: {start: 22, end: 140},
      symbol: 'MainActivity',
      language: 'kotlin',
    }), PRIVATE_SCOPE);
    store.addChunk(makeChunk({
      chunkId: 'app-load',
      kind: 'app_source',
      uri: 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt',
      snippet: 'Application init blocking load simulator',
      codebaseId: 'codebase-1',
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_1',
      filePath: 'launch-common/src/main/java/com/example/launch/common/LoadSimulator.kt',
      lineRange: {start: 1, end: 80},
      symbol: 'LoadSimulator',
      language: 'kotlin',
    }), PRIVATE_SCOPE);

    const result = store.search('startup load', {
      kinds: ['app_source'],
      codebaseIds: ['codebase-1'],
      activeCodebaseGenerations: {'codebase-1': 'codebase_1'},
      symbolExact: 'MainActivity',
      languages: ['kotlin'],
      scope: PRIVATE_SCOPE,
    });

    expect(result.results[0].chunkId).toBe('app-main');
    expect(result.results.every(hit => hit.chunk?.codebaseId === 'codebase-1')).toBe(true);
  });

  it('skips chunks with unsupportedReason', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({
        chunkId: 'blocked',
        snippet: 'binder transactions',
        unsupportedReason: 'license expired',
      }),
    );
    store.addChunk(
      makeChunk({chunkId: 'visible', snippet: 'binder transactions'}),
    );
    const result = store.search('binder transactions');
    expect(result.results.find(r => r.chunkId === 'blocked')).toBeUndefined();
    expect(result.results.find(r => r.chunkId === 'visible')).toBeDefined();
  });

  it('reports retrieval-level unsupportedReason for an empty index', () => {
    const store = new RagStore(storagePath);
    const result = store.search('anything');
    expect(result.unsupportedReason).toBe('index empty');
    expect(result.results).toHaveLength(0);
  });

  it('reports retrieval-level unsupportedReason when every chunk is blocked', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({
        chunkId: 'blocked-1',
        snippet: 'binder transactions',
        unsupportedReason: 'license expired',
      }),
    );
    const result = store.search('binder');
    expect(result.unsupportedReason).toBe(
      'all chunks blocked by unsupportedReason',
    );
    expect(result.results).toHaveLength(0);
  });

  it('zero-match legitimate query has no unsupportedReason', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('completely unrelated zzzqxzqq');
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.results).toHaveLength(0);
  });

  it('rejects an aggregate local selection before unbounded tokenization', () => {
    const bounded = new RagStore(path.join(tmpDir, 'bounded-rag.json'), {
      localSearchMaxChunks: 2,
      localSearchMaxBytes: 1_024,
      localStorageMaxChunks: 10,
      localStorageMaxBytes: 1024 * 1024,
    });
    bounded.addChunks([0, 1, 2].map(index => ({
      chunkId: `bounded-${index}`,
      kind: 'project_memory' as const,
      uri: `memory://bounded/${index}`,
      snippet: `shared performance token ${index}`,
      indexedAt: index + 1,
    })));

    const result = bounded.search('performance');

    expect(result.results).toEqual([]);
    expect(result.unsupportedReason).toContain('local_rag_search_budget_exceeded');
    expect(result.unsupportedReason).toContain('select fewer codebases/knowledge sources');
  });

  it('search result carries spark provenance and the query string', () => {
    const store = new RagStore(storagePath);
    seed(store);
    const result = store.search('binder');
    expect(result.schemaVersion).toBe(1);
    expect(result.source).toBe('ragStore.search');
    expect(result.createdAt).toBeGreaterThan(0);
    expect(result.retrievedAt).toBeGreaterThan(0);
    expect(result.query).toBe('binder');
  });
});

describe('RagStore — stats', () => {
  it('tracks per-kind chunk counts and lastIndexedAt', () => {
    const store = new RagStore(storagePath);
    store.addChunk(
      makeChunk({chunkId: 'b1', kind: 'androidperformance.com', indexedAt: 100}),
    );
    store.addChunk(
      makeChunk({chunkId: 'b2', kind: 'androidperformance.com', indexedAt: 200}),
    );
    store.addChunk(
      makeChunk({
        chunkId: 'a1',
        kind: 'aosp',
        license: 'Apache-2.0',
        indexedAt: 300,
      }),
    );
    const stats = store.getStats();
    expect(stats['androidperformance.com'].chunkCount).toBe(2);
    expect(stats['androidperformance.com'].lastIndexedAt).toBe(200);
    expect(stats.aosp.chunkCount).toBe(1);
    expect(stats.aosp.lastIndexedAt).toBe(300);
    expect(stats.oem_sdk.chunkCount).toBe(0);
    expect(stats.app_source.chunkCount).toBe(0);
    expect(stats.kernel_source.chunkCount).toBe(0);
  });
});
