// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';
import {types as utilTypes} from 'util';

import express from 'express';
import request from 'supertest';

import {createRagAdminRoutes} from '../ragAdminRoutes';
import {RagStore} from '../../services/ragStore';
import type {RagChunk} from '../../types/sparkContracts';
import {
  CodebaseRegistry,
  PENDING_GENERATION_TTL_MS,
} from '../../services/codebase/codebaseRegistry';
import {PathSecurityGate} from '../../services/codebase/pathSecurityGate';
import {NativeDirectoryPicker} from '../../services/codebase/nativeDirectoryPicker';
import {SourceEnumerator} from '../../services/codebase/sourceEnumerator';
import {CodebaseManagementService} from '../../services/codebase/codebaseManagementService';
import {CodebaseStateError} from '../../services/codebase/codebaseRequestError';
import {
  ExternalKnowledgeSourceRegistry,
  type RegisterExternalKnowledgeSourceInput,
} from '../../services/externalKnowledgeSourceRegistry';
import {DocumentCollectionIngester} from '../../services/knowledge/documentCollectionIngester';
import {DocumentCollectionStore} from '../../services/knowledge/documentCollectionStore';

let tmpDir: string;
let store: RagStore;
let registry: CodebaseRegistry;
let externalKnowledgeRegistry: ExternalKnowledgeSourceRegistry;
let app: express.Express;
let directoryPicker: NativeDirectoryPicker;
let codebaseManagementService: CodebaseManagementService;
let pickerSelectedRoot: string;
let pickerSelectionSequence: number;
let externalPickerDir: string | undefined;
const originalKnowledgeRoots = process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS;
const DEFAULT_SCOPE = {
  tenantId: 'default-dev-tenant',
  workspaceId: 'default-workspace',
  userId: 'dev-user-123',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-admin-test-'));
  process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = tmpDir;
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  externalKnowledgeRegistry = new ExternalKnowledgeSourceRegistry(
    path.join(tmpDir, 'external-knowledge-sources.json'),
  );
  const gate = new PathSecurityGate({allowlistRoots: [tmpDir]});
  codebaseManagementService = new CodebaseManagementService({
    registry,
    store,
    gate,
    sourceEnumerator: new SourceEnumerator(),
  });
  pickerSelectedRoot = tmpDir;
  pickerSelectionSequence = 0;
  directoryPicker = new NativeDirectoryPicker({
    platform: 'linux',
    env: {DISPLAY: ':0', PATH: '/usr/bin'},
    distribution: 'source',
    enterprise: false,
    bindHost: '127.0.0.1',
    findExecutable: name => name === 'zenity' ? '/usr/bin/zenity' : undefined,
    runCommand: async () => ({stdout: `${pickerSelectedRoot}\n`, stderr: ''}),
    idGenerator: () => `picker-selection-${++pickerSelectionSequence}`,
  });
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/rag', createRagAdminRoutes(store, {
    registry,
    gate,
    codebaseManagementService,
    directoryPicker,
    externalKnowledgeRegistry,
    documentCollectionIngester: new DocumentCollectionIngester(
      externalKnowledgeRegistry,
      new DocumentCollectionStore(path.join(tmpDir, 'knowledge-index')),
    ),
  } as any));
});

afterEach(() => {
  if (originalKnowledgeRoots === undefined) delete process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS;
  else process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = originalKnowledgeRoots;
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
  if (externalPickerDir && fs.existsSync(externalPickerDir)) {
    fs.rmSync(externalPickerDir, {recursive: true, force: true});
  }
  externalPickerDir = undefined;
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'c-001',
    kind: 'androidperformance.com',
    uri: 'https://androidperformance.com/x',
    snippet: 'binder transactions',
    indexedAt: 1714600000000,
    ...overrides,
  };
}

/**
 * A source the retired Android Internals Wiki connector registered and
 * indexed: registration no longer types the kind, so the cast stands in for
 * that stored state. Its RagStore chunks are written as the connector did.
 */
async function seedRetiredWikiSource(rootName: string, chunkIds: readonly string[] = ['wiki-a', 'wiki-b']) {
  const root = path.join(tmpDir, rootName);
  fs.mkdirSync(root, {recursive: true});
  const source = externalKnowledgeRegistry.register({
    kind: 'android_internals_wiki',
    displayName: 'Android Internals Wiki',
    rootRealpath: root,
    revision: 'a'.repeat(40),
    contentFingerprint: 'b'.repeat(64),
    dirty: false,
    license: 'CC-BY-NC-SA-4.0',
    rightsAcknowledged: true,
    sendToProvider: true,
    consentedBy: DEFAULT_SCOPE.userId,
    scope: DEFAULT_SCOPE,
  } as unknown as RegisterExternalKnowledgeSourceInput);
  await externalKnowledgeRegistry.withIngestLease(source.sourceId, DEFAULT_SCOPE, lease => lease.activateGeneration({
    generation: 'wiki-generation-1', revision: source.revision, contentFingerprint: source.contentFingerprint,
    dirty: false, indexedArticleCount: 1, indexedChunkCount: chunkIds.length,
  }));
  for (const chunkId of chunkIds) {
    store.addChunk(makeChunk({
      chunkId,
      kind: 'android_internals_wiki',
      uri: `android-internals-wiki://${source.sourceId}/${chunkId}`,
      snippet: 'RETIRED_WIKI_SNIPPET Handler queue',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: source.sourceId,
      sourceGeneration: 'wiki-generation-1',
      filePath: 'src/article.md',
    }), DEFAULT_SCOPE);
  }
  return {root, sourceId: source.sourceId};
}

describe('GET /api/rag/stats', () => {
  it('returns per-kind counts', async () => {
    store.addChunk(makeChunk({chunkId: 'a'}));
    store.addChunk(
      makeChunk({chunkId: 'b', kind: 'aosp', license: 'Apache-2.0'}),
    );
    const res = await request(app).get('/api/rag/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats['androidperformance.com'].chunkCount).toBe(1);
    expect(res.body.stats.aosp.chunkCount).toBe(1);
  });
});

describe('GET / DELETE /api/rag/chunks/:chunkId', () => {
  it('returns a known chunk', async () => {
    store.addChunk(makeChunk({chunkId: 'a'}));
    const res = await request(app).get('/api/rag/chunks/a');
    expect(res.status).toBe(200);
    expect(res.body.chunk.chunkId).toBe('a');
  });

  it('sanitizes registry-owned source reads and blocks generic deletion', async () => {
    const root = path.join(tmpDir, 'repo');
    fs.mkdirSync(root);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Repo',
      rootPath: root,
    });
    store.addChunk(makeChunk({
      chunkId: 'source-a',
      kind: 'app_source',
      uri: 'codebase://source-a/MainActivity.kt',
      snippet: 'class MainActivity { fun secretLaunch() {} }',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: `codebase_${ref.indexGeneration}`,
      filePath: 'MainActivity.kt',
      language: 'kotlin',
    }), DEFAULT_SCOPE);

    const read = await request(app).get('/api/rag/chunks/source-a');
    const remove = await request(app).delete('/api/rag/chunks/source-a');

    expect(read.status).toBe(200);
    expect(read.body.chunk.snippet).toBeUndefined();
    expect(read.body.chunk.snippetHash).toEqual(expect.any(String));
    expect(remove.status).toBe(404);
    expect(store.getChunk('source-a', DEFAULT_SCOPE)).toBeDefined();
    expect(JSON.stringify({read: read.body, remove: remove.body}))
      .not.toContain('secretLaunch');
  });

  it('keeps private wiki chunks off generic admin chunk and search endpoints', async () => {
    store.addChunk(makeChunk({
      chunkId: 'wiki-private',
      kind: 'android_internals_wiki',
      uri: 'android-internals-wiki://source-a/article',
      title: 'PRIVATE_WIKI_TITLE',
      snippet: 'PRIVATE_WIKI_SNIPPET Handler queue',
      license: 'CC-BY-NC-SA-4.0',
      registryOrigin: 'external_knowledge_registry',
      knowledgeSourceId: 'source-a',
      sourceGeneration: 'generation-a',
      filePath: 'src/article.md',
    }), DEFAULT_SCOPE);

    const chunkResponse = await request(app).get('/api/rag/chunks/wiki-private');
    const searchResponse = await request(app)
      .post('/api/rag/search')
      .send({query: 'Handler queue', kinds: ['android_internals_wiki']});

    expect(chunkResponse.status).toBe(404);
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.result.results).toEqual([]);
    expect(JSON.stringify({chunkResponse: chunkResponse.body, searchResponse: searchResponse.body}))
      .not.toMatch(/PRIVATE_WIKI|knowledgeScopeFingerprint|src\/article\.md/);
  });

  it('404 on missing chunkId', async () => {
    const res = await request(app).get('/api/rag/chunks/missing');
    expect(res.status).toBe(404);
  });

  it('DELETE removes the chunk', async () => {
    store.addChunk(makeChunk({chunkId: 'a'}));
    const res = await request(app).delete('/api/rag/chunks/a');
    expect(res.status).toBe(200);
    expect(store.getChunk('a')).toBeUndefined();
  });

  it('DELETE returns 404 for missing chunk', async () => {
    const res = await request(app).delete('/api/rag/chunks/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/rag/search', () => {
  beforeEach(() => {
    store.addChunk(
      makeChunk({chunkId: 'a', snippet: 'binder transactions reveal latency'}),
    );
    store.addChunk(
      makeChunk({chunkId: 'b', snippet: 'frame timeline tells the truth'}),
    );
  });

  it('runs a search and returns ranked hits', async () => {
    const res = await request(app)
      .post('/api/rag/search')
      .send({query: 'binder transactions'});
    expect(res.status).toBe(200);
    expect(res.body.result.results.length).toBeGreaterThan(0);
    expect(res.body.result.results[0].chunkId).toBe('a');
  });

  it('respects kinds filter', async () => {
    const res = await request(app)
      .post('/api/rag/search')
      .send({query: 'binder', kinds: ['aosp']});
    expect(res.body.result.results).toHaveLength(0);
  });

  it('400 on missing query', async () => {
    const res = await request(app).post('/api/rag/search').send({});
    expect(res.status).toBe(400);
  });

  it.each([
    [{query: 'binder', topK: -1}, 'topK'],
    [{query: 'x'.repeat(8 * 1024 + 1)}, 'query'],
    [{query: 'binder', kinds: Array.from({length: 101}, () => 'aosp')}, 'kinds'],
    [{query: 'binder', codebaseIds: Array.from({length: 101}, (_, index) => `cb-${index}`)}, 'codebaseIds'],
  ])('400 on bounded search input violations', async (body, field) => {
    const res = await request(app).post('/api/rag/search').send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_rag_search_input');
    expect(res.body.error).toContain(field);
  });
});

describe('retired Android Internals Wiki connector', () => {
  it.each([
    ['post', '/api/rag/android-internals/preview'],
    ['post', '/api/rag/android-internals/sources'],
    ['get', '/api/rag/android-internals/sources'],
    ['post', '/api/rag/android-internals/sources/eks_000000000000000000000000/reindex'],
    ['patch', '/api/rag/android-internals/sources/eks_000000000000000000000000/consent'],
    ['delete', '/api/rag/android-internals/sources/eks_000000000000000000000000/index'],
    ['get', '/api/rag/android-internals/sources/eks_000000000000000000000000/audit'],
    ['get', '/api/rag/android-internals/anything/else'],
  ] as const)('answers %s %s with 410 and points to /api/rag/knowledge', async (method, url) => {
    const response = await request(app)[method](url).send({rootPath: tmpDir, rightsAcknowledged: true});
    expect(response.status).toBe(410);
    expect(response.headers.deprecation).toBe('true');
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      migration: {successor: null, fallback: '/api/rag/knowledge'},
    }));
    expect(JSON.stringify(response.body)).not.toContain(tmpDir);
  });

  it('touches no stored source: a retired record stays as it was and its chunks stay in place', async () => {
    const {sourceId} = await seedRetiredWikiSource('untouched-wiki');
    for (const [method, url] of [
      ['patch', `/api/rag/android-internals/sources/${sourceId}/consent`],
      ['delete', `/api/rag/android-internals/sources/${sourceId}/index`],
      ['post', `/api/rag/android-internals/sources/${sourceId}/reindex`],
    ] as const) {
      expect((await request(app)[method](url).send({sendToProvider: false})).status).toBe(410);
    }
    expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)).toEqual(expect.objectContaining({
      sendToProvider: true, activeGeneration: 'wiki-generation-1'}));
    expect(store.listChunks({kind: 'android_internals_wiki', scope: DEFAULT_SCOPE})).toHaveLength(2);
  });

  it('lists a stored retired record as retired under /knowledge, lets its consent be revoked, never granted', async () => {
    const {root, sourceId} = await seedRetiredWikiSource('listed-wiki');
    const listed = await request(app).get('/api/rag/knowledge');
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([expect.objectContaining({
      sourceId, kind: 'android_internals_wiki', retired: true, sendToProvider: true, hasActiveIndex: true})]);
    expect(JSON.stringify(listed.body)).not.toContain(root);
    expect(externalKnowledgeRegistry.evaluateAccess(sourceId, DEFAULT_SCOPE, [sourceId]))
      .toEqual({allowed: false, reason: 'knowledge_kind_retired'});

    const revoked = await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`).send({sendToProvider: false});
    expect(revoked.status).toBe(200);
    expect(revoked.body.source).toEqual(expect.objectContaining({sourceId, sendToProvider: false, retired: true}));
    expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)?.sendToProvider).toBe(false);
    // A consent the kind can never use is refused, and nothing is written.
    const granted = await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`).send({sendToProvider: true});
    expect(granted.status).toBe(409);
    expect(granted.body.code).toBe('KNOWLEDGE_SOURCE_RETIRED');
    expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)?.sendToProvider).toBe(false);
  });
});

/** Every console.error and console.warn line while `act` runs, for asserting what the logs may contain. */
async function logsDuring(act: () => Promise<void>): Promise<string> {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await act();
    return JSON.stringify([...error.mock.calls, ...warn.mock.calls], (_key, value) =>
      value instanceof Error || utilTypes.isNativeError(value)
        ? {...value, message: (value as Error).message, stack: (value as Error).stack} : value);
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
}

/** Removes `directory` just before the gate opens it, as a concurrent deletion would. */
function removeWhenOpened(directory: string) {
  const fsPromises = require('fs/promises') as typeof import('fs/promises');
  const original = fsPromises.opendir;
  return jest.spyOn(fsPromises, 'opendir').mockImplementation(async (target, ...rest) => {
    if (String(target) === fs.realpathSync(path.dirname(directory)) + path.sep + path.basename(directory)) {
      fs.rmSync(directory, {recursive: true, force: true});
    }
    return original(target, ...rest);
  });
}

describe('document collection routes', () => {
  function collection(name: string, files: Record<string, string>): string {
    const root = path.join(tmpDir, name);
    for (const [relativePath, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relativePath)), {recursive: true});
      fs.writeFileSync(path.join(root, relativePath), content);
    }
    return root;
  }

  function expectNoRoot(body: unknown, root: string): void {
    const text = JSON.stringify(body);
    expect(text).not.toContain(root);
    expect(text).not.toContain(fs.realpathSync(root));
  }

  it('previews counts and skip reasons and refuses a folder with nothing indexable', async () => {
    const root = collection('docs-preview', {
      'guide.md': '# Guide\nRenderThread notes\n',
      'blank.txt': '  \n',
      'image.png': 'binary',
    });
    const preview = await request(app).post('/api/rag/knowledge/preview').send({rootPath: root});
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toEqual(expect.objectContaining({
      documentCount: 1,
      skipped: {empty_text: 1, extension_not_allowed: 1},
      contentFingerprint: expect.any(String),
    }));
    expectNoRoot(preview.body, root);
    expect(JSON.stringify(preview.body)).not.toContain('RenderThread notes');

    const empty = collection('docs-empty', {'blank.md': '\n', 'data.json': '{}'});
    const refused = await request(app).post('/api/rag/knowledge/preview').send({rootPath: empty});
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(expect.objectContaining({
      code: 'KNOWLEDGE_COLLECTION_EMPTY',
      details: {empty_text: 1, extension_not_allowed: 1},
    }));
    const registerEmpty = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: empty, rightsAcknowledged: true});
    expect(registerEmpty.status).toBe(400);
    expect(registerEmpty.body.code).toBe('KNOWLEDGE_COLLECTION_EMPTY');

    const outside = await request(app).post('/api/rag/knowledge/preview').send({rootPath: os.tmpdir()});
    expect(outside.status).toBe(400);
    expect(outside.body).toEqual(expect.objectContaining({
      code: 'KNOWLEDGE_ROOT_BLOCKED',
      details: {blockedReason: 'root_outside_allowlist'},
    }));
  });

  it('registers, reindexes, searches and lists a collection without provider consent', async () => {
    const root = collection('docs-team', {
      'render/compositor.md': '# 渲染线程\nXRenderCompositorWorker 负责合成每一帧。\n',
      'site/index.html': '<h1>Binder</h1><p>binder transactions</p>',
    });
    const missingRights = await request(app).post('/api/rag/knowledge/register').send({rootPath: root});
    expect(missingRights.status).toBe(400);
    expect(missingRights.body.code).toBe('KNOWLEDGE_SOURCE_RIGHTS_REQUIRED');
    const tooLong = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true, description: 'x'.repeat(281)});
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('KNOWLEDGE_SOURCE_METADATA_INVALID');

    const registered = await request(app).post('/api/rag/knowledge/register').send({
      rootPath: root,
      displayName: 'Team docs',
      description: 'Internal render framework and trace tags',
      attribution: 'Render team',
      rightsAcknowledged: true,
    });
    expect(registered.status).toBe(200);
    expect(registered.body.source).toEqual(expect.objectContaining({
      kind: 'document_collection',
      displayName: 'Team docs',
      description: 'Internal render framework and trace tags',
      attribution: 'Render team',
      sendToProvider: false,
      documentCount: 0,
      hasActiveIndex: false,
    }));
    expectNoRoot(registered.body, root);
    const sourceId = registered.body.source.sourceId;

    const reindex = await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});
    expect(reindex.status).toBe(200);
    expect(reindex.body.result).toEqual(expect.objectContaining({sourceId, documentCount: 2}));
    expectNoRoot(reindex.body, root);

    const search = await request(app).post(`/api/rag/knowledge/${sourceId}/search`)
      .send({query: 'XRenderCompositorWorker'});
    expect(search.status).toBe(200);
    expect(search.body).toEqual(expect.objectContaining({
      success: true,
      generation: reindex.body.result.generation,
    }));
    expect(search.body.hits[0]).toEqual(expect.objectContaining({
      relativePath: 'render/compositor.md',
      title: '渲染线程',
      headingPath: ['渲染线程'],
      startLine: 1,
      endLine: 2,
      snippet: expect.stringContaining('XRenderCompositorWorker'),
    }));
    const cjk = await request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: '合成'});
    expect(cjk.body.hits[0].relativePath).toBe('render/compositor.md');
    const badQuery = await request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: ' '});
    expect(badQuery.status).toBe(400);

    const listed = await request(app).get('/api/rag/knowledge');
    expect(listed.body.sources).toEqual([expect.objectContaining({
      sourceId,
      kind: 'document_collection',
      description: 'Internal render framework and trace tags',
      documentCount: 2,
      hasActiveIndex: true,
    })]);
    expectNoRoot(listed.body, root);
  });

  it('re-registration keeps consent when omitted and revokes it only when explicit', async () => {
    const root = collection('docs-consent', {'a.md': '# A\nalpha\n'});
    const first = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: true});
    expect(first.body.source.sendToProvider).toBe(true);
    const omitted = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true});
    expect(omitted.body.source.sendToProvider).toBe(true);
    const revoked = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: false});
    expect(revoked.body.source.sendToProvider).toBe(false);
    const invalid = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: 'yes'});
    expect(invalid.status).toBe(400);
  });

  it('keeps every collection route inside the caller workspace', async () => {
    const root = collection('docs-scoped', {'a.md': '# A\nalpha\n'});
    const registered = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true});
    const sourceId = registered.body.source.sourceId;
    await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});

    const other = (req: request.Test) => req.set('X-Workspace-Id', 'workspace-b');
    expect((await other(request(app).get('/api/rag/knowledge'))).body.sources).toEqual([]);
    for (const response of [
      await other(request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: 'alpha'})),
      await other(request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({})),
      await other(request(app).delete(`/api/rag/knowledge/${sourceId}`)),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('KNOWLEDGE_SOURCE_NOT_FOUND');
    }
    const search = await request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: 'alpha'});
    expect(search.body.hits).toHaveLength(1);
  });

  it('deletes a collection with its index files, and deletes a retired Wiki source with its chunks', async () => {
    const root = collection('docs-delete', {'a.md': '# A\nalpha\n'});
    const registered = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true});
    const sourceId = registered.body.source.sourceId;
    await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});
    const indexRoot = path.join(tmpDir, 'knowledge-index');
    const indexFiles = () => fs.readdirSync(indexRoot, {recursive: true}).filter(entry =>
      String(entry).endsWith('.sqlite'));
    expect(indexFiles()).toHaveLength(1);

    const deleted = await request(app).delete(`/api/rag/knowledge/${sourceId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual(expect.objectContaining({success: true, sourceId, deleted: true}));
    expect(indexFiles()).toHaveLength(0);
    expect((await request(app).get('/api/rag/knowledge')).body.sources).toEqual([]);
    const searchAfter = await request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: 'alpha'});
    expect(searchAfter.status).toBe(404);
    const again = await request(app).delete(`/api/rag/knowledge/${sourceId}`);
    expect(again.status).toBe(404);

    const {sourceId: wikiId} = await seedRetiredWikiSource('deleted-wiki');
    // Another source's chunk of the same kind is not this deletion's to clear.
    store.addChunk(makeChunk({
      chunkId: 'other-wiki', kind: 'android_internals_wiki', uri: 'android-internals-wiki://other/x',
      license: 'CC-BY-NC-SA-4.0', registryOrigin: 'external_knowledge_registry', knowledgeSourceId: `eks_${'9'.repeat(24)}`,
      sourceGeneration: 'other-generation',
    }), DEFAULT_SCOPE);
    expect(store.listChunks({kind: 'android_internals_wiki', scope: DEFAULT_SCOPE})).toHaveLength(3);
    const otherWorkspace = await request(app).delete(`/api/rag/knowledge/${wikiId}`).set('X-Workspace-Id', 'workspace-b');
    expect(otherWorkspace.status).toBe(404);
    expect(store.listChunks({kind: 'android_internals_wiki', scope: DEFAULT_SCOPE})).toHaveLength(3);
    const wikiDeleted = await request(app).delete(`/api/rag/knowledge/${wikiId}`);
    expect(wikiDeleted.status).toBe(200);
    expect(wikiDeleted.body).toEqual(expect.objectContaining({success: true, sourceId: wikiId, deleted: true}));
    expect(store.listChunks({kind: 'android_internals_wiki', scope: DEFAULT_SCOPE}).map(chunk => chunk.chunkId))
      .toEqual(['other-wiki']);
    expect(externalKnowledgeRegistry.get(wikiId, DEFAULT_SCOPE)).toBeUndefined();
    expect((await request(app).get('/api/rag/knowledge')).body.sources).toEqual([]);
  });

  describe('directory picker registration', () => {
    const ORIGIN = 'http://127.0.0.1:10000';
    const local = (req: request.Test) => req.set('Origin', ORIGIN);

    function pickedCollection(): string {
      // Outside SMARTPERFETTO_KNOWLEDGE_ROOTS (tmpDir): only the picker can admit it.
      externalPickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-knowledge-root-'));
      fs.writeFileSync(path.join(externalPickerDir, 'guide.md'), '# Guide\nPickedFolderCanary notes\n');
      pickerSelectedRoot = externalPickerDir;
      return externalPickerDir;
    }

    async function pick(): Promise<string> {
      const selection = await local(request(app).post('/api/rag/codebases/directory-picker')).send({purpose: 'knowledge'});
      expect(selection.status).toBe(200);
      return selection.body.directorySelectionId;
    }

    it('previews without using the selection up, registers once, and trusts only that source\'s own root', async () => {
      const root = pickedCollection();
      const badPurpose = await local(request(app).post('/api/rag/codebases/directory-picker')).send({purpose: 'other'});
      expect(badPurpose.status).toBe(400);
      const selectionId = await pick();

      const raw = await request(app).post('/api/rag/knowledge/preview').send({rootPath: root});
      expect(raw.body).toEqual(expect.objectContaining({
        code: 'KNOWLEDGE_ROOT_BLOCKED', details: {blockedReason: 'root_outside_allowlist'}}));
      for (const refused of [
        await request(app).post('/api/rag/knowledge/preview').send({rootPath: root, directorySelectionId: selectionId}),
        await request(app).post('/api/rag/knowledge/preview')
          .set('Host', 'smartperfetto.example.com').set('Origin', 'https://smartperfetto.example.com')
          .send({rootPath: root, directorySelectionId: selectionId}),
      ]) {
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('DIRECTORY_PICKER_UNAVAILABLE');
      }
      const mismatch = await local(request(app).post('/api/rag/knowledge/preview'))
        .send({rootPath: tmpDir, directorySelectionId: selectionId});
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.code).toBe('DIRECTORY_SELECTION_PATH_MISMATCH');
      const otherWorkspace = await local(request(app).post('/api/rag/knowledge/preview'))
        .set('X-Workspace-Id', 'workspace-b').send({rootPath: root, directorySelectionId: selectionId});
      expect(otherWorkspace.status).toBe(403);
      expect(otherWorkspace.body.code).toBe('DIRECTORY_SELECTION_SCOPE_MISMATCH');
      for (let attempt = 0; attempt < 2; attempt++) {
        const preview = await local(request(app).post('/api/rag/knowledge/preview'))
          .send({rootPath: root, directorySelectionId: selectionId});
        expect(preview.status).toBe(200);
        expect(preview.body.preview.documentCount).toBe(1);
        expectNoRoot(preview.body, root);
      }

      // A registration that fails after taking the selection gives it back.
      const noRights = await local(request(app).post('/api/rag/knowledge/register'))
        .send({rootPath: root, directorySelectionId: selectionId});
      expect(noRights.body.code).toBe('KNOWLEDGE_SOURCE_RIGHTS_REQUIRED');
      const registered = await local(request(app).post('/api/rag/knowledge/register'))
        .send({rootPath: root, directorySelectionId: selectionId, rightsAcknowledged: true});
      expect(registered.status).toBe(200);
      expectNoRoot(registered.body, root);
      expect(JSON.stringify(registered.body)).not.toContain('rootAuthorization');
      const sourceId = registered.body.source.sourceId;
      expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)?.rootAuthorization).toBe('native_picker');
      const replay = await local(request(app).post('/api/rag/knowledge/register'))
        .send({rootPath: root, directorySelectionId: selectionId, rightsAcknowledged: true});
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('DIRECTORY_SELECTION_NOT_FOUND');

      // The source's own root is trusted for its reindex, and nothing else is.
      const reindex = await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});
      expect(reindex.status).toBe(200);
      expectNoRoot(reindex.body, root);
      const search = await request(app).post(`/api/rag/knowledge/${sourceId}/search`).send({query: 'PickedFolderCanary'});
      expect(search.body.hits).toHaveLength(1);
      for (const rawAgain of [
        await request(app).post('/api/rag/knowledge/preview').send({rootPath: root}),
        await request(app).post('/api/rag/knowledge/register').send({rootPath: root, rightsAcknowledged: true}),
        await request(app).post('/api/rag/knowledge/preview').set('X-Workspace-Id', 'workspace-b').send({rootPath: root}),
      ]) {
        expect(rawAgain.body.code).toBe('KNOWLEDGE_ROOT_BLOCKED');
      }
      expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)?.rootAuthorization).toBe('native_picker');

      // Deleting the source revokes the channel with it.
      expect((await request(app).delete(`/api/rag/knowledge/${sourceId}`)).status).toBe(200);
      const afterDelete = await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.body.code).toBe('KNOWLEDGE_SOURCE_NOT_FOUND');
    });

    it('gives a source registered by its raw path no channel: its reindex follows the configured allowlist', async () => {
      const root = collection('docs-allowlisted', {'a.md': '# A\nalpha\n'});
      const registered = await request(app).post('/api/rag/knowledge/register').send({rootPath: root, rightsAcknowledged: true});
      const sourceId = registered.body.source.sourceId;
      expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)).not.toHaveProperty('rootAuthorization');
      expect((await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({})).status).toBe(200);
      process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = path.join(tmpDir, 'elsewhere');
      const blocked = await request(app).post(`/api/rag/knowledge/${sourceId}/reindex`).send({});
      expect(blocked.body).toEqual(expect.objectContaining({
        code: 'KNOWLEDGE_ROOT_BLOCKED', details: {blockedReason: 'root_outside_allowlist'}}));
    });

    const canReadOnlyAsOwner = typeof process.getuid === 'function' && process.getuid() !== 0;
    (canReadOnlyAsOwner ? it : it.skip)('keeps the picked folder out of responses and logs when a subdirectory cannot be read', async () => {
      const root = pickedCollection();
      const locked = path.join(root, 'locked');
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, 'inside.md'), '# Inside\n');
      const selectionId = await pick();
      fs.chmodSync(locked, 0o000);
      try {
        const responses: request.Response[] = [];
        const logs = await logsDuring(async () => {
          responses.push(await local(request(app).post('/api/rag/knowledge/preview'))
            .send({rootPath: root, directorySelectionId: selectionId}));
          responses.push(await local(request(app).post('/api/rag/knowledge/register'))
            .send({rootPath: root, directorySelectionId: selectionId, rightsAcknowledged: true}));
        });
        expect(responses.map(response => [response.status, response.body.code])).toEqual([
          [500, 'KNOWLEDGE_COLLECTION_PREVIEW_FAILED'],
          [500, 'KNOWLEDGE_COLLECTION_REGISTER_FAILED'],
        ]);
        for (const response of responses) {
          expect(response.body.requestId).toEqual(expect.any(String));
          expectNoRoot(response.body, root);
        }
        expect(logs).toContain('EACCES');
        expect(logs).toContain('opendir');
        expect(logs).not.toContain(root);
        expect(logs).not.toContain(fs.realpathSync(root));

        // The failed registration gave the selection back; the reindex of the registered source logs no path either.
        fs.chmodSync(locked, 0o755);
        const registered = await local(request(app).post('/api/rag/knowledge/register'))
          .send({rootPath: root, directorySelectionId: selectionId, rightsAcknowledged: true});
        expect(registered.status).toBe(200);
        fs.chmodSync(locked, 0o000);
        let reindex!: request.Response;
        const reindexLogs = await logsDuring(async () => {
          reindex = await request(app).post(`/api/rag/knowledge/${registered.body.source.sourceId}/reindex`).send({});
        });
        expect(reindex.status).toBe(500);
        expect(reindex.body.code).toBe('KNOWLEDGE_COLLECTION_REINDEX_FAILED');
        expectNoRoot(reindex.body, root);
        expect(reindexLogs).toContain('EACCES');
        expect(reindexLogs).not.toContain(fs.realpathSync(root));
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });

    it('keeps the picked folder out of responses and logs when a subdirectory disappears mid-read', async () => {
      const root = pickedCollection();
      const vanishing = path.join(root, 'vanishing');
      fs.mkdirSync(vanishing);
      fs.writeFileSync(path.join(vanishing, 'gone.md'), '# Gone\n');
      const selectionId = await pick();
      const opendir = removeWhenOpened(vanishing);
      let response!: request.Response;
      try {
        const logs = await logsDuring(async () => {
          response = await local(request(app).post('/api/rag/knowledge/preview'))
            .send({rootPath: root, directorySelectionId: selectionId});
        });
        expect(response.status).toBe(500);
        expect(response.body.code).toBe('KNOWLEDGE_COLLECTION_PREVIEW_FAILED');
        expectNoRoot(response.body, root);
        expect(logs).toContain('ENOENT');
        expect(logs).not.toContain(fs.realpathSync(root));
      } finally {
        opendir.mockRestore();
      }
    });

    it('lets exactly one of two concurrent registrations use a selection', async () => {
      const root = pickedCollection();
      const selectionId = await pick();
      const body = {rootPath: root, directorySelectionId: selectionId, rightsAcknowledged: true};
      const responses = await Promise.all([
        local(request(app).post('/api/rag/knowledge/register')).send(body),
        local(request(app).post('/api/rag/knowledge/register')).send(body),
      ]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
      expect(responses.find(response => response.status === 400)!.body.code).toBe('DIRECTORY_SELECTION_NOT_FOUND');
    });
  });

  it('sets a collection\'s provider consent under /knowledge', async () => {
    const root = collection('docs-consent-route', {'a.md': '# A\nalpha\n'});
    const registered = await request(app).post('/api/rag/knowledge/register')
      .send({rootPath: root, rightsAcknowledged: true});
    const sourceId = registered.body.source.sourceId;
    const granted = await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`).send({sendToProvider: true});
    expect(granted.status).toBe(200);
    expect(granted.body.source).toEqual(expect.objectContaining({
      sourceId, kind: 'document_collection', sendToProvider: true, documentCount: 0, hasActiveIndex: false}));
    expectNoRoot(granted.body, root);
    expect(externalKnowledgeRegistry.evaluateAccess(sourceId, DEFAULT_SCOPE, [sourceId]).allowed).toBe(true);
    const revoked = await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`).send({sendToProvider: false});
    expect(revoked.status).toBe(200);
    expect(revoked.body.source.sendToProvider).toBe(false);
    expect((await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`).send({sendToProvider: 'yes'})).status)
      .toBe(400);
    const otherWorkspace = await request(app).patch(`/api/rag/knowledge/${sourceId}/consent`)
      .set('X-Workspace-Id', 'workspace-b').send({sendToProvider: true});
    expect(otherWorkspace.status).toBe(404);
    expect(externalKnowledgeRegistry.get(sourceId, DEFAULT_SCOPE)?.sendToProvider).toBe(false);
  });

});

describe('codebase routes', () => {
  it('uses the same safe preview projection as the management service', async () => {
    const root = path.join(tmpDir, 'aosp-parity');
    fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
    fs.mkdirSync(path.join(root, 'frameworks/base'), {recursive: true});
    fs.writeFileSync(path.join(root, 'frameworks/base/Foo.java'), 'class Foo {}\n');
    fs.writeFileSync(path.join(root, '.repo/manifest.xml'), [
      '<manifest>',
      '  <project name="platform/frameworks/base" path="frameworks/base" groups="default,pdk" />',
      '</manifest>',
    ].join('\n'));

    const expected = await codebaseManagementService.preview({
      rootPath: root,
      kind: 'aosp',
    }, DEFAULT_SCOPE);
    const response = await request(app)
      .post('/api/rag/codebases/preview')
      .send({rootPath: root, kind: 'aosp'});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({success: true, preview: expected});
    expect(JSON.stringify(response.body)).not.toContain(root);
  });

  it('sanitizes manifest degradation reasons while keeping known codes and root drift', async () => {
    const root = path.join(tmpDir, 'aosp-manifest-reason');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Foo.java'), 'class Foo {}\n');
    const requestPreview = async (reason: string | Error) => {
      const previewGate = new PathSecurityGate({allowlistRoots: [tmpDir]});
      const previewService = new CodebaseManagementService({
        registry,
        store,
        gate: previewGate,
        sourceEnumerator: new SourceEnumerator(),
        readAospManifestProjects: async () => {
          throw typeof reason === 'string' ? new Error(reason) : reason;
        },
      });
      const previewApp = express();
      previewApp.use(express.json());
      previewApp.use('/api/rag', createRagAdminRoutes(store, {
        registry,
        gate: previewGate,
        codebaseManagementService: previewService,
        directoryPicker,
        externalKnowledgeRegistry,
      }));
      return request(previewApp)
        .post('/api/rag/codebases/preview')
        .send({rootPath: root, kind: 'aosp'});
    };

    const secretCanary = 'secret_token_canary';
    const unknown = await requestPreview(secretCanary);
    expect(unknown.status).toBe(200);
    expect(unknown.body.preview.manifestUnavailableReason)
      .toBe('aosp_manifest_discovery_failed');
    expect(JSON.stringify(unknown.body)).not.toContain(secretCanary);

    const known = await requestPreview('source_metadata_too_large');
    expect(known.status).toBe(200);
    expect(known.body.preview.manifestUnavailableReason).toBe('source_metadata_too_large');

    const drift = await requestPreview(new CodebaseStateError('codebase_root_realpath_drift'));
    expect(drift.status).toBe(400);
    expect(drift.body.error).toBe('codebase_root_realpath_drift');
  });

  it('independently sanitizes token-shaped diagnostics in list, detail, and audit JSON', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Diagnostic Route',
      rootPath: tmpDir,
      rootRealpath: tmpDir,
      ...DEFAULT_SCOPE,
    });
    const tokenCanary = 'ROUTE_TOKEN_SECRET_CANARY_123456';
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'failed',
      lastIngestError: tokenCanary,
    }, DEFAULT_SCOPE);

    const list = await request(app).get('/api/rag/codebases');
    const detail = await request(app).get(`/api/rag/codebases/${ref.codebaseId}`);
    const audit = await request(app).get(`/api/rag/codebases/${ref.codebaseId}/audit`);
    const unknown = JSON.stringify({list: list.body, detail: detail.body, audit: audit.body});

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(audit.status).toBe(200);
    expect(unknown).not.toContain(tokenCanary);
    expect(unknown).not.toContain('rootAuthorization');
    expect(unknown).toContain('codebase_operation_failed');

    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'blocked_by_security',
      lastIngestError: 'codebase_root_realpath_drift',
    }, DEFAULT_SCOPE);
    const knownAudit = await request(app).get(`/api/rag/codebases/${ref.codebaseId}/audit`);
    expect(knownAudit.body.audit.lastIngestError).toBe('codebase_root_realpath_drift');
    expect(JSON.stringify(knownAudit.body)).not.toContain(tokenCanary);
  });

  it('keeps AOSP preview available when optional manifest metadata is too large', async () => {
    const root = path.join(tmpDir, 'aosp-large-manifest');
    fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.java'), 'class Main {}\n');
    fs.writeFileSync(
      path.join(root, '.repo', 'manifest.xml'),
      `<manifest>${' '.repeat(4 * 1024 * 1024)}</manifest>`,
    );

    const response = await request(app)
      .post('/api/rag/codebases/preview')
      .send({rootPath: root, kind: 'aosp'});

    expect(response.status).toBe(200);
    expect(response.body.preview).toEqual(expect.objectContaining({
      acceptedFileCount: 1,
      manifestUnavailableReason: 'source_metadata_too_large',
    }));
  });

  it('keeps the empty-selection error stable and adds a human-readable hint', async () => {
    const root = path.join(tmpDir, 'empty-codebase');
    fs.mkdirSync(root, {recursive: true});

    const response = await request(app)
      .post('/api/rag/codebases/register')
      .send({rootPath: root, kind: 'app_source'});

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      error: 'effective_source_selection_empty',
      message: expect.stringMatching(/no source files/i),
      hint: expect.stringMatching(/filter|path|extension/i),
    }));
  });

  it('selects, previews, and registers a local folder outside the configured allowlist', async () => {
    externalPickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-selected-root-'));
    fs.writeFileSync(path.join(externalPickerDir, 'Main.kt'), 'class SelectedMain\n');
    pickerSelectedRoot = externalPickerDir;

    const capability = await request(app)
      .get('/api/rag/codebases/directory-picker')
      .set('Origin', 'http://127.0.0.1:10000');
    expect(capability.status).toBe(200);
    expect(capability.body.capability).toMatchObject({
      available: true,
      provider: 'zenity',
    });

    const selection = await request(app)
      .post('/api/rag/codebases/directory-picker')
      .set('Origin', 'http://127.0.0.1:10000')
      .send({});
    expect(selection.status).toBe(200);
    expect(selection.body).toMatchObject({
      selected: true,
      rootPath: fs.realpathSync(externalPickerDir),
      directorySelectionId: 'picker-selection-1',
    });

    const blockedWithoutSelection = await request(app)
      .post('/api/rag/codebases/preview')
      .send({rootPath: externalPickerDir});
    expect(blockedWithoutSelection.body.preview).toMatchObject({
      blocked: true,
      blockedReason: 'root_outside_allowlist',
    });

    const preview = await request(app)
      .post('/api/rag/codebases/preview')
      .set('Origin', 'http://127.0.0.1:10000')
      .send({
        rootPath: externalPickerDir,
        directorySelectionId: selection.body.directorySelectionId,
      });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({
      blocked: false,
      acceptedFileCount: 1,
    });

    const registered = await request(app)
      .post('/api/rag/codebases/register')
      .set('Origin', 'http://127.0.0.1:10000')
      .send({
        kind: 'app_source',
        rootPath: externalPickerDir,
        directorySelectionId: selection.body.directorySelectionId,
        sendToProvider: false,
      });
    expect(registered.status).toBe(200);
    expect(registered.body.codebase).toMatchObject({
      displayName: path.basename(externalPickerDir),
    });
    expect(registered.body.codebase.rootPath).toBeUndefined();
    expect(registered.body.codebase.rootAuthorization).toBeUndefined();
    expect(registry.get(registered.body.codebase.codebaseId, DEFAULT_SCOPE))
      .toMatchObject({rootAuthorization: 'native_picker'});
    const listed = await request(app).get('/api/rag/codebases');
    expect(listed.body.codebases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        codebaseId: registered.body.codebase.codebaseId,
      }),
    ]));
    expect(listed.body.codebases).toEqual(await codebaseManagementService.list(DEFAULT_SCOPE));
    expect(JSON.stringify(listed.body)).not.toContain('rootAuthorization');
    const audit = await request(app)
      .get(`/api/rag/codebases/${registered.body.codebase.codebaseId}/audit`);
    expect(audit.body.audit).toEqual(
      codebaseManagementService.audit(registered.body.codebase.codebaseId, DEFAULT_SCOPE),
    );
    expect(JSON.stringify(audit.body)).not.toContain('rootAuthorization');

    const reused = await request(app)
      .post('/api/rag/codebases/register')
      .set('Origin', 'http://127.0.0.1:10000')
      .send({
        kind: 'app_source',
        rootPath: externalPickerDir,
        directorySelectionId: selection.body.directorySelectionId,
      });
    expect(reused.status).toBe(400);
    expect(reused.body.code).toBe('DIRECTORY_SELECTION_NOT_FOUND');
  });

  it('keeps a picked source folder out of codebase responses and logs when enumeration fails on the filesystem', async () => {
    externalPickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-codebase-leak-'));
    fs.writeFileSync(path.join(externalPickerDir, 'Main.kt'), 'class Main\n');
    pickerSelectedRoot = externalPickerDir;
    const pickedRoot = fs.realpathSync(externalPickerDir);
    // What a traversal that loses a directory throws: the absolute path in the message and fields.
    const fsError = Object.assign(new Error(`EACCES: permission denied, opendir '${pickedRoot}/feature'`), {
      code: 'EACCES', errno: -13, syscall: 'opendir', path: `${pickedRoot}/feature`});
    const enumerate = jest.spyOn(SourceEnumerator.prototype, 'enumerate').mockRejectedValue(fsError);
    try {
      for (const route of ['preview', 'register'] as const) {
        const selection = await request(app).post('/api/rag/codebases/directory-picker')
          .set('Origin', 'http://127.0.0.1:10000').send({});
        let response!: request.Response;
        const logs = await logsDuring(async () => {
          response = await request(app).post(`/api/rag/codebases/${route}`)
            .set('Origin', 'http://127.0.0.1:10000')
            .send({rootPath: externalPickerDir, directorySelectionId: selection.body.directorySelectionId});
        });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body.code).toBe(route === 'preview' ? 'CODEBASE_PREVIEW_FAILED' : 'CODEBASE_REGISTER_FAILED');
        expect(JSON.stringify(response.body)).not.toContain(pickedRoot);
        // The management preview answers its own fixed failure without logging; registration logs the errno.
        if (route === 'register') expect(logs).toContain('EACCES');
        expect(logs).not.toContain(pickedRoot);
      }
    } finally {
      enumerate.mockRestore();
    }
  });

  describe('codebase registration with a directory selection', () => {
    let clock: number;
    let enumerations: number;
    let releaseEnumeration: (() => void) | undefined;
    let pickerApp: express.Express;

    beforeEach(() => {
      externalPickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-codebase-register-'));
      fs.writeFileSync(path.join(externalPickerDir, 'Main.kt'), 'class Main\n');
      pickerSelectedRoot = externalPickerDir;
      clock = 1_000;
      enumerations = 0;
      releaseEnumeration = undefined;
      const realEnumerator = new SourceEnumerator();
      const picker = new NativeDirectoryPicker({
        platform: 'linux',
        env: {DISPLAY: ':0', PATH: '/usr/bin'},
        distribution: 'source',
        enterprise: false,
        bindHost: '127.0.0.1',
        findExecutable: name => name === 'zenity' ? '/usr/bin/zenity' : undefined,
        runCommand: async () => ({stdout: `${pickerSelectedRoot}\n`, stderr: ''}),
        now: () => clock,
        selectionTtlMs: 5_000,
        idGenerator: () => `ttl-selection-${++pickerSelectionSequence}`,
      });
      pickerApp = express();
      pickerApp.use(express.json());
      pickerApp.use('/api/rag', createRagAdminRoutes(store, {
        registry,
        gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
        codebaseManagementService,
        directoryPicker: picker,
        externalKnowledgeRegistry,
        sourceEnumerator: {
          enumerate: async (input: Parameters<SourceEnumerator['enumerate']>[0]) => {
            enumerations += 1;
            if (releaseEnumeration === undefined) {
              await new Promise<void>(resolve => { releaseEnumeration = resolve; });
            }
            return realEnumerator.enumerate(input);
          },
        } as unknown as SourceEnumerator,
      }));
    });

    const pickFolder = async () => (await request(pickerApp).post('/api/rag/codebases/directory-picker')
      .set('Origin', 'http://127.0.0.1:10000').send({})).body.directorySelectionId as string;
    const register = (selectionId: string, extra: Record<string, unknown> = {}) => request(pickerApp)
      .post('/api/rag/codebases/register').set('Origin', 'http://127.0.0.1:10000')
      .send({kind: 'app_source', rootPath: externalPickerDir, directorySelectionId: selectionId, ...extra});

    it('holds the selection for the whole registration: a concurrent replay never enumerates', async () => {
      const selectionId = await pickFolder();
      const first = register(selectionId).then(response => response);
      try {
        // Wait until the first registration is enumerating, holding the selection.
        while (releaseEnumeration === undefined) await new Promise(resolve => setImmediate(resolve));
        const replay = await register(selectionId);
        expect(replay.status).toBe(400);
        expect(replay.body.code).toBe('DIRECTORY_SELECTION_NOT_FOUND');
        expect(enumerations).toBe(1);
      } finally {
        releaseEnumeration?.();
      }
      expect((await first).status).toBe(200);
      expect(registry.list(DEFAULT_SCOPE)).toHaveLength(1);
    });

    it('gives a failed registration\'s selection back until it expires, and not after', async () => {
      releaseEnumeration = () => undefined;
      // An empty selection fails after the selection was taken: it comes back for a retry.
      fs.mkdirSync(path.join(externalPickerDir!, 'docs'));
      fs.writeFileSync(path.join(externalPickerDir!, 'docs', 'notes.txt'), 'not source\n');
      const selectionId = await pickFolder();
      const empty = await register(selectionId, {pathFilters: ['docs']});
      expect(empty.status).toBe(400);
      expect(empty.body.error).toBe('effective_source_selection_empty');
      clock = 5_999;
      const retried = await register(selectionId);
      expect(retried.status).toBe(200);
      expect(retried.body.codebase).toMatchObject({displayName: path.basename(externalPickerDir!)});

      // A failure that ends after the expiry does not give it back.
      const late = await pickFolder();
      const failing = jest.spyOn(registry, 'register').mockImplementationOnce(() => {
        clock += 10_000;
        throw new Error('registry_write_failed');
      });
      const failed = await register(late);
      failing.mockRestore();
      expect(failed.status).toBe(500);
      const afterExpiry = await register(late);
      expect(afterExpiry.status).toBe(400);
      expect(afterExpiry.body.code).toBe('DIRECTORY_SELECTION_NOT_FOUND');

      // At the boundary the selection has expired.
      const boundary = await pickFolder();
      clock += 5_000;
      const expired = await register(boundary);
      expect(expired.body.code).toBe('DIRECTORY_SELECTION_EXPIRED');
    });
  });

  it('refuses provider-send consent at registration without registering or using the selection', async () => {
    externalPickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-consent-refused-'));
    fs.writeFileSync(path.join(externalPickerDir, 'Main.kt'), 'class Main\n');
    pickerSelectedRoot = externalPickerDir;
    const selection = await request(app).post('/api/rag/codebases/directory-picker')
      .set('Origin', 'http://127.0.0.1:10000').send({});
    const body = {kind: 'app_source', rootPath: externalPickerDir, directorySelectionId: selection.body.directorySelectionId};

    const refused = await request(app).post('/api/rag/codebases/register')
      .set('Origin', 'http://127.0.0.1:10000').send({...body, sendToProvider: true});
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual(expect.objectContaining({success: false, code: 'CODEBASE_CONSENT_DISCLOSURE_REQUIRED'}));
    expect(refused.body.error).toContain('authorizeContent');
    expect(JSON.stringify(refused.body)).not.toContain(externalPickerDir);
    expect(registry.list(DEFAULT_SCOPE)).toEqual([]);
    // The selection is still there: the registration it was meant for goes ahead, without consent.
    expect(() => directoryPicker.validateSelection(selection.body.directorySelectionId, externalPickerDir!, DEFAULT_SCOPE))
      .not.toThrow();
    const registered = await request(app).post('/api/rag/codebases/register')
      .set('Origin', 'http://127.0.0.1:10000').send({...body, sendToProvider: false});
    expect(registered.status).toBe(200);
    const codebaseId = registered.body.codebase.codebaseId;
    expect(registry.get(codebaseId, DEFAULT_SCOPE)!.consent.sendToProvider).toBe(false);

    // Consent comes from the disclosure the registration returned.
    const granted = await request(app).patch(`/api/rag/codebases/${codebaseId}/consent`)
      .send({authorizeContent: true, contentDisclosureToken: registered.body.codebase.contentDisclosure.token});
    expect(granted.status).toBe(200);
    expect(registry.get(codebaseId, DEFAULT_SCOPE)!.consent.sendToProvider).toBe(true);
  });

  it('rejects remote directory-picker requests and cross-workspace selection reuse', async () => {
    const missingOriginPick = await request(app)
      .post('/api/rag/codebases/directory-picker')
      .send({});
    expect(missingOriginPick.status).toBe(403);

    const remoteCapability = await request(app)
      .get('/api/rag/codebases/directory-picker')
      .set('Host', 'smartperfetto.example.com')
      .set('Origin', 'https://smartperfetto.example.com');
    expect(remoteCapability.status).toBe(200);
    expect(remoteCapability.body.capability).toMatchObject({
      available: false,
      reason: 'remote_request',
    });

    const remotePick = await request(app)
      .post('/api/rag/codebases/directory-picker')
      .set('Host', 'smartperfetto.example.com')
      .set('Origin', 'https://smartperfetto.example.com')
      .send({});
    expect(remotePick.status).toBe(403);

    const selection = await request(app)
      .post('/api/rag/codebases/directory-picker')
      .set('Origin', 'http://127.0.0.1:10000')
      .send({});
    const mismatch = await request(app)
      .post('/api/rag/codebases/preview')
      .set('Origin', 'http://127.0.0.1:10000')
      .set('X-Workspace-Id', 'workspace-b')
      .send({
        rootPath: pickerSelectedRoot,
        directorySelectionId: selection.body.directorySelectionId,
      });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe('DIRECTORY_SELECTION_SCOPE_MISMATCH');
  });

  it('validates metadata only when the selected source type requires it', async () => {
    const root = path.join(tmpDir, 'metadata-validation-repo');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Main.c'), 'int main(void) { return 0; }\n');

    const missingKernelVendor = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'kernel_source',
        rootPath: root,
        pathFilters: ['drivers/'],
      });
    expect(missingKernelVendor.status).toBe(400);
    expect(missingKernelVendor.body.error).toContain('`vendor` is required');

    const missingKernelScope = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'kernel_source',
        rootPath: root,
        vendor: 'qualcomm',
      });
    expect(missingKernelScope.status).toBe(400);
    expect(missingKernelScope.body.error).toContain('`pathFilters` is required');

    const missingAospLicense = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'aosp',
        rootPath: root,
      });
    expect(missingAospLicense.status).toBe(400);
    expect(missingAospLicense.body.error).toContain('`licenseTag` is required');

    const appSource = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'app_source',
        rootPath: root,
      });
    expect(appSource.status).toBe(200);
    expect(appSource.body.codebase.displayName).toBe('metadata-validation-repo');
  });

  it('lazily expires pending generations and removes their staged chunks on list', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Expired Candidate',
      rootPath: tmpDir,
      ...DEFAULT_SCOPE,
    });
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'expired-generation',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      contentFingerprint: 'expired-fingerprint',
      chunkCount: 1,
      createdAt: Date.now() - PENDING_GENERATION_TTL_MS - 1,
    });
    store.addChunk(makeChunk({
      chunkId: 'expired-generation-chunk',
      kind: 'app_source',
      uri: 'codebase://expired/Expired.kt',
      codebaseId: ref.codebaseId,
      sourceGeneration: 'expired-generation',
      registryOrigin: 'codebase_registry',
      filePath: 'Expired.kt',
      snippet: 'class Expired',
    }), DEFAULT_SCOPE);

    const listed = await request(app).get('/api/rag/codebases');

    expect(listed.status).toBe(200);
    expect(listed.body.codebases[0]).toMatchObject({
      codebaseId: ref.codebaseId,
      maintenanceWarning: 'pending_generation_expired',
    });
    expect(listed.body.codebases[0].pendingGeneration).toBeUndefined();
    expect(store.countCodebaseGenerationChunks(ref.codebaseId, 'expired-generation', DEFAULT_SCOPE)).toBe(0);
  });

  it('records and retries inactive chunk cleanup without failing list reads', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Cleanup retry',
      rootPath: tmpDir,
      ...DEFAULT_SCOPE,
    });
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'expired-cleanup-candidate',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      contentFingerprint: 'expired-cleanup',
      chunkCount: 1,
      createdAt: Date.now() - PENDING_GENERATION_TTL_MS - 1,
    });
    store.addChunk(makeChunk({
      chunkId: 'expired-cleanup-chunk',
      kind: 'app_source',
      uri: 'codebase://expired/Cleanup.kt',
      codebaseId: ref.codebaseId,
      sourceGeneration: 'expired-cleanup-candidate',
      registryOrigin: 'codebase_registry',
      filePath: 'Cleanup.kt',
    }), DEFAULT_SCOPE);
    const cleanup = jest.spyOn(store, 'removeCodebaseChunksExceptGeneration')
      .mockImplementationOnce(() => {
        throw new Error('simulated_cleanup_failure');
      });

    const first = await request(app).get('/api/rag/codebases');
    expect(first.status).toBe(200);
    expect(first.body.codebases.find((entry: any) => entry.codebaseId === ref.codebaseId))
      .toMatchObject({maintenanceWarning: 'inactive_chunk_cleanup_failed'});
    expect(store.getChunk('expired-cleanup-chunk', DEFAULT_SCOPE)).toBeDefined();

    const second = await request(app).get('/api/rag/codebases');
    expect(second.status).toBe(200);
    expect(store.getChunk('expired-cleanup-chunk', DEFAULT_SCOPE)).toBeUndefined();
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.maintenanceWarning).toBeUndefined();
    cleanup.mockRestore();
  });

  it('does not delete chunks staged by an in-flight reindex during cleanup', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Concurrent cleanup',
      rootPath: tmpDir,
      ...DEFAULT_SCOPE,
    });
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'ok',
      maintenanceWarning: 'inactive_chunk_cleanup_failed',
    }, DEFAULT_SCOPE);
    store.addChunk(makeChunk({
      chunkId: 'in-flight-reindex-chunk',
      kind: 'app_source',
      uri: 'codebase://in-flight/Main.kt',
      codebaseId: ref.codebaseId,
      sourceGeneration: 'in-flight-reindex-generation',
      registryOrigin: 'codebase_registry',
      filePath: 'Main.kt',
    }), DEFAULT_SCOPE);

    let releaseLease!: () => void;
    let markLeaseHeld!: () => void;
    const leaseHeld = new Promise<void>(resolve => {
      markLeaseHeld = resolve;
    });
    const release = new Promise<void>(resolve => {
      releaseLease = resolve;
    });
    const inFlightReindex = registry.withIngestLease(
      ref.codebaseId,
      DEFAULT_SCOPE,
      async () => {
        markLeaseHeld();
        await release;
      },
    );
    await leaseHeld;

    const response = await request(app).get('/api/rag/codebases');

    expect(response.status).toBe(200);
    expect(store.getChunk('in-flight-reindex-chunk', DEFAULT_SCOPE)).toBeDefined();
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.maintenanceWarning)
      .toBe('inactive_chunk_cleanup_failed');
    releaseLease();
    await inFlightReindex;
  });

  it('preserves omitted selection fields and rejects empty, unchanged, or invalid final policies', async () => {
    const appRef = registry.register({
      kind: 'app_source',
      displayName: 'Scoped App',
      rootPath: tmpDir,
      pathFilters: ['src'],
      ...DEFAULT_SCOPE,
    });
    const updated = await request(app)
      .patch(`/api/rag/codebases/${appRef.codebaseId}/selection`)
      .send({excludeGlobs: ['**/generated/**']});

    expect(updated.status).toBe(200);
    expect(updated.body.codebase).toMatchObject({
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
      selectionPolicyRevision: 2,
      indexGeneration: appRef.indexGeneration + 1,
    });

    const empty = await request(app)
      .patch(`/api/rag/codebases/${appRef.codebaseId}/selection`)
      .send({});
    const unchanged = await request(app)
      .patch(`/api/rag/codebases/${appRef.codebaseId}/selection`)
      .send({excludeGlobs: ['**/generated/**', '**/generated/**']});
    expect(empty.status).toBe(400);
    expect(unchanged.status).toBe(400);
    expect(registry.get(appRef.codebaseId, DEFAULT_SCOPE)).toMatchObject({
      selectionPolicyRevision: 2,
      indexGeneration: appRef.indexGeneration + 1,
    });

    const kernel = registry.register({
      kind: 'kernel_source',
      displayName: 'Kernel',
      rootPath: tmpDir,
      vendor: 'qualcomm',
      pathFilters: ['drivers/android'],
      ...DEFAULT_SCOPE,
    });
    const invalidKernel = await request(app)
      .patch(`/api/rag/codebases/${kernel.codebaseId}/selection`)
      .send({pathFilters: []});
    expect(invalidKernel.status).toBe(400);
    expect(registry.get(kernel.codebaseId, DEFAULT_SCOPE)?.pathFilters)
      .toEqual(['drivers/android']);
  });

  it('returns top-level grant revision and supports pending accept and reject contracts', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Pending',
      rootPath: tmpDir,
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });
    const coverage = {
      selectionPolicyRevision: 1,
      enumerationBackend: 'ripgrep' as const,
      backendFidelity: 'exact' as const,
      enumerationComplete: true,
      deterministic: true,
      filesEnumerated: 2,
      filesSelected: 1,
      bytesSelected: 10,
      chunksIndexed: 1,
      truncated: true,
      complete: false,
      truncationReason: 'file_budget' as const,
    };
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'candidate-accept',
      coverage,
      contentFingerprint: 'candidate-accept-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    store.addChunk(makeChunk({
      chunkId: 'candidate-accept-chunk',
      kind: 'app_source',
      uri: 'codebase://pending/Candidate.kt',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'candidate-accept',
      filePath: 'Candidate.kt',
    }), DEFAULT_SCOPE);

    const detail = await request(app).get(`/api/rag/codebases/${ref.codebaseId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.codebase.grantRevision).toBe(1);
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'candidate-replacement',
      coverage,
      contentFingerprint: 'candidate-replacement-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    store.addChunk(makeChunk({
      chunkId: 'candidate-replacement-chunk',
      kind: 'app_source',
      uri: 'codebase://pending/Replacement.kt',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'candidate-replacement',
      filePath: 'Replacement.kt',
    }), DEFAULT_SCOPE);
    const staleAccepted = await request(app)
      .post(`/api/rag/codebases/${ref.codebaseId}/pending/accept`)
      .send({
        selectionPolicyRevision: 1,
        grantRevision: 1,
        candidateGenerationId: 'candidate-accept',
      });
    expect(staleAccepted.status).toBe(409);
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.pendingGeneration?.candidateGenerationId)
      .toBe('candidate-replacement');
    const accepted = await request(app)
      .post(`/api/rag/codebases/${ref.codebaseId}/pending/accept`)
      .send({
        selectionPolicyRevision: 1,
        grantRevision: 1,
        candidateGenerationId: 'candidate-replacement',
      });
    expect(accepted.status).toBe(200);
    expect(accepted.body.codebase).toMatchObject({
      activeGeneration: 'candidate-replacement',
      grantRevision: 1,
    });

    const afterAccept = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, afterAccept.indexGeneration, {
      candidateGenerationId: 'candidate-reject-a',
      coverage,
      contentFingerprint: 'candidate-reject-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    store.addChunk(makeChunk({
      chunkId: 'candidate-reject-chunk',
      kind: 'app_source',
      uri: 'codebase://pending/Rejected.kt',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'candidate-reject-a',
      filePath: 'Rejected.kt',
    }), DEFAULT_SCOPE);
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, afterAccept.indexGeneration, {
      candidateGenerationId: 'candidate-reject-b',
      coverage,
      contentFingerprint: 'candidate-reject-b-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    const staleRejected = await request(app)
      .post(`/api/rag/codebases/${ref.codebaseId}/pending/reject`)
      .send({candidateGenerationId: 'candidate-reject-a'});
    expect(staleRejected.status).toBe(409);
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.pendingGeneration?.candidateGenerationId)
      .toBe('candidate-reject-b');
    const rejected = await request(app)
      .post(`/api/rag/codebases/${ref.codebaseId}/pending/reject`)
      .send({candidateGenerationId: 'candidate-reject-b'});
    expect(rejected.status).toBe(200);
    expect(rejected.body.codebase.pendingGeneration).toBeUndefined();
    expect(store.getChunk('candidate-reject-chunk', DEFAULT_SCOPE)).toBeUndefined();
    expect(store.getChunk('candidate-accept-chunk', DEFAULT_SCOPE)).toBeUndefined();
    expect(store.getChunk('candidate-replacement-chunk', DEFAULT_SCOPE)).toBeDefined();
  });

  it('does not let new-language authorization create provider-send consent', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Metadata only',
      rootPath: tmpDir,
      sendToProvider: false,
      ...DEFAULT_SCOPE,
    });

    const response = await request(app)
      .patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeAvailableExtensions: true});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('provider_send_consent_required');
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.consent.sendToProvider).toBe(false);

    registry.setProviderConsent(ref.codebaseId, DEFAULT_SCOPE, true, DEFAULT_SCOPE.userId);
    const ambiguous = await request(app)
      .patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeAvailableExtensions: true, sendToProvider: false});
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain('mutually exclusive');
  });

  it('explicitly authorizes the current selection scope and rejects ambiguous consent actions', async () => {
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Expanded selection',
      rootPath: tmpDir,
      pathFilters: ['app', 'lib'],
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });
    // A grant narrower than its selection, as a record from an older version holds it.
    const registryPath = path.join(tmpDir, 'codebases.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));

    const response = await request(app)
      .patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeCurrentSelection: true});
    const ambiguous = await request(app)
      .patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeCurrentSelection: true, authorizeAvailableExtensions: true});
    const ambiguousContent = await request(app)
      .patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeContent: true, sendToProvider: true});

    expect(response.status).toBe(200);
    expect(response.body.codebase).toMatchObject({providerGrantScopeCurrent: true});
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.consent.grant).toMatchObject({
      includePrefixes: ['app', 'lib'],
      excludeGlobs: [],
    });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain('mutually exclusive');
    expect(ambiguousContent.status).toBe(400);
    expect(ambiguousContent.body.error).toContain('mutually exclusive');
  });

  it('grants the current selection and every language in one idempotent consent action', async () => {
    const ref = registry.register({
      kind: 'app_source', displayName: 'Content consent', rootPath: tmpDir, pathFilters: ['app', 'lib'],
      sendToProvider: false, ...DEFAULT_SCOPE,
    });
    const registryPath = path.join(tmpDir, 'codebases.json');
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app'];
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));

    // The narrow actions keep their precondition: no consent, no grant.
    const narrow = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeCurrentSelection: true});
    expect(narrow.status).toBe(409);
    expect(narrow.body.error).toBe('provider_send_consent_required');

    // The combined grant needs the token of the scope the caller disclosed.
    const enabled = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({sendToProvider: true});
    expect(enabled.status).toBe(400);
    expect(enabled.body).toEqual(expect.objectContaining({success: false, code: 'CODEBASE_CONSENT_DISCLOSURE_REQUIRED'}));
    expect(enabled.body.error).toContain('authorizeContent');
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)!.consent.sendToProvider).toBe(false);
    const untokened = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeContent: true});
    expect(untokened.status).toBe(400);
    expect(untokened.body.code).toBe('CODEBASE_CONSENT_DISCLOSURE_REQUIRED');
    const detail = await request(app).get(`/api/rag/codebases/${ref.codebaseId}`);
    const listed = await request(app).get('/api/rag/codebases');
    const token = detail.body.codebase.contentDisclosure.token;
    expect(token).toMatch(/^cd1:/);
    expect(detail.body.codebase).not.toHaveProperty('contentDisclosureToken');
    expect(listed.body.codebases.find((item: {codebaseId: string}) => item.codebaseId === ref.codebaseId)
      .contentDisclosure.token).toBe(token);

    const granted = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeContent: true, contentDisclosureToken: token});
    expect(granted.status).toBe(200);
    expect(granted.body.codebase).toMatchObject({eligibleForSendToProvider: true, providerGrantScopeCurrent: true,
      availableNotConsentedExtensions: []});
    const repeated = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeContent: true, contentDisclosureToken: token});
    expect(repeated.body.codebase.consent).toEqual(granted.body.codebase.consent);
    expect(JSON.stringify(granted.body)).not.toContain(tmpDir);
    // Revoking with an explicit false is unchanged.
    const revoked = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({sendToProvider: false});
    expect(revoked.status).toBe(200);
    expect(revoked.body.codebase.eligibleForSendToProvider).toBe(false);

    // A selection edited after the disclosure refuses the old token and grants nothing.
    registry.updateSelectionPolicy(ref.codebaseId, DEFAULT_SCOPE, {pathFilters: ['app', 'lib', 'tools']});
    const afterEdit = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    const stale = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/consent`)
      .send({authorizeContent: true, contentDisclosureToken: token});
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({code: 'CODEBASE_CONSENT_DISCLOSURE_STALE', error: 'consent_disclosure_stale'});
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)).toEqual(afterEdit);
  });

  it('previews a selection edit with relative paths and refuses saving a proven empty or stale selection', async () => {
    const root = path.join(tmpDir, 'selection-preview-repo');
    fs.mkdirSync(path.join(root, 'feature'), {recursive: true});
    fs.writeFileSync(path.join(root, 'feature', 'A.kt'), 'class A\n');
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    const ref = registry.register({kind: 'app_source', displayName: 'Preview', rootPath: root, ...DEFAULT_SCOPE});

    const preview = await request(app).post(`/api/rag/codebases/${ref.codebaseId}/selection/preview`)
      .send({pathFilters: ['feature']});
    expect(preview.status).toBe(200);
    expect(preview.body.selectionPreview).toMatchObject({status: 'complete', selectionPolicyRevision: 1,
      preview: {acceptedFileCount: 1, acceptedFiles: [{relativePath: 'feature/A.kt'}]}});
    expect(JSON.stringify(preview.body)).not.toContain(root);

    const empty = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/selection`)
      .send({excludeGlobs: ['**/*.kt']});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('CODEBASE_SELECTION_EMPTY_MATCH');

    const saved = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/selection`)
      .send({pathFilters: ['feature'], expectedSelectionPolicyRevision: 1});
    expect(saved.status).toBe(200);
    const stale = await request(app).patch(`/api/rag/codebases/${ref.codebaseId}/selection`)
      .send({pathFilters: [], expectedSelectionPolicyRevision: 1});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CODEBASE_SELECTION_STALE');

    const missing = await request(app).post('/api/rag/codebases/cb_missing/selection/preview').send({});
    expect(missing.status).toBe(404);
  });

  it('rejects ambiguous provider consent and unsafe path filters', async () => {
    const root = path.join(tmpDir, 'validation-repo');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');

    const ambiguousConsent = await request(app)
      .post('/api/rag/codebases/register')
      .send({displayName: 'Repo', rootPath: root, sendToProvider: 'false'});
    const traversalFilter = await request(app)
      .post('/api/rag/codebases/register')
      .send({displayName: 'Repo', rootPath: root, pathFilters: ['../private']});

    expect(ambiguousConsent.status).toBe(400);
    expect(ambiguousConsent.body.error).toContain('explicit boolean');
    expect(traversalFilter.status).toBe(400);
    expect(traversalFilter.body.error).toContain('must not traverse parent directories');
    expect(registry.list(DEFAULT_SCOPE)).toHaveLength(0);
  });

  it('previews, registers, reindexes, and resolves app source symbols', async () => {
    const root = path.join(tmpDir, 'HighPerformanceMini');
    fs.mkdirSync(path.join(root, 'launch-aosp/src/main/java/com/example'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'launch-aosp/src/main/java/com/example/MainActivity.kt'),
      'package com.example\nclass MainActivity { fun simulateHeavyLaunch() {} }\n',
    );

    const preview = await request(app)
      .post('/api/rag/codebases/preview')
      .send({rootPath: root});
    expect(preview.status).toBe(200);
    expect(preview.body.preview.acceptedFileCount).toBe(1);
    expect(preview.body.preview).toMatchObject({
      enumerationComplete: true,
      filesEnumerated: 1,
      filesSelected: 1,
      bytesSelected: expect.any(Number),
    });

    const registered = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'app_source',
        displayName: 'HighPerformanceMini',
        rootPath: root,
      });
    expect(registered.status).toBe(200);
    const codebaseId = registered.body.codebase.codebaseId;
    expect(registered.body.codebase.rootPath).toBeUndefined();

    const reindex = await request(app)
      .post(`/api/rag/codebases/${codebaseId}/reindex`)
      .send({});
    expect(reindex.status).toBe(200);
    expect(reindex.body.result.chunksAdded).toBeGreaterThan(0);
    expect(reindex.body.result).toMatchObject({
      activationDisposition: 'active',
      coverage: expect.objectContaining({
        enumerationComplete: true,
        complete: true,
        chunksIndexed: expect.any(Number),
      }),
    });

    const symbols = await request(app)
      .get(`/api/rag/codebases/${codebaseId}/symbols`)
      .query({symbol: 'MainActivity'});
    expect(symbols.status).toBe(200);
    expect(symbols.body.result.success).toBe(true);
    expect(symbols.body.result.candidates[0]).toEqual(expect.objectContaining({
      codebaseId,
      filePath: 'launch-aosp/src/main/java/com/example/MainActivity.kt',
    }));

    const search = await request(app)
      .post('/api/rag/search')
      .send({query: 'simulateHeavyLaunch', kinds: ['app_source'], codebaseIds: [codebaseId]});
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain('simulateHeavyLaunch()');
    expect(search.body.result.results[0].chunk.snippetHash).toEqual(expect.any(String));

    // No route returns an indexed chunk's raw text.
    const excerpt = await request(app)
      .get(`/api/rag/codebases/${codebaseId}/excerpt`)
      .query({chunkId: search.body.result.results[0].chunkId});
    expect(excerpt.status).toBe(404);
    expect(JSON.stringify(excerpt.body)).not.toContain('simulateHeavyLaunch()');
  });

  it('uses the injected source enumerator for registration and reindex', async () => {
    const root = path.join(tmpDir, 'injected-enumerator');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class InjectedEnumerator\n');
    const enumerator = new SourceEnumerator();
    const enumerate = jest.spyOn(enumerator, 'enumerate');
    const isolated = express();
    isolated.use(express.json());
    isolated.use('/api/rag', createRagAdminRoutes(store, {
      registry,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: enumerator,
      directoryPicker,
      externalKnowledgeRegistry,
    } as any));

    const registered = await request(isolated)
      .post('/api/rag/codebases/register')
      .send({kind: 'app_source', rootPath: root, sendToProvider: false});
    expect(registered.status).toBe(200);
    const reindexed = await request(isolated)
      .post(`/api/rag/codebases/${registered.body.codebase.codebaseId}/reindex`)
      .send({});
    expect(reindexed.status).toBe(200);
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it('returns a structured failure when reindex is blocked by the path gate', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-reindex-outside-'));
    fs.writeFileSync(path.join(outside, 'Main.kt'), 'class Outside\n');
    try {
      const ref = registry.register({
        kind: 'app_source',
        displayName: 'Outside',
        rootPath: outside,
        ...DEFAULT_SCOPE,
      });

      const response = await request(app)
        .post(`/api/rag/codebases/${ref.codebaseId}/reindex`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: expect.stringMatching(/root_outside_allowlist|blocked_by_security/),
        code: 'CODEBASE_INDEX_FAILED',
        onDemandAvailable: false,
      });
    } finally {
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });

  it('reports optional-index capacity separately from live on-demand access', async () => {
    const root = path.join(tmpDir, 'index-capacity');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main {\n' + '  fun next() = Unit\n'.repeat(400) + '}\n');
    const ref = registry.register({kind: 'app_source', displayName: 'Capacity', rootPath: root, ...DEFAULT_SCOPE});
    const response = await request(app).post(`/api/rag/codebases/${ref.codebaseId}/reindex`).send({maxChunks: 1});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false, code: 'CODEBASE_INDEX_CAPACITY_EXCEEDED', onDemandAvailable: true,
    });
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.activeGeneration).toBeUndefined();
  });

  it('deletes only the scoped codebase and every indexed generation', async () => {
    const root = path.join(tmpDir, 'delete-repo');
    fs.mkdirSync(root);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Delete Me',
      rootPath: root,
      ...DEFAULT_SCOPE,
    });
    const otherScope = {
      tenantId: 'other-tenant',
      workspaceId: 'other-workspace',
      userId: 'other-user',
    };
    const other = registry.register({
      kind: 'app_source',
      displayName: 'Keep Me',
      rootPath: root,
      ...otherScope,
    });
    store.addChunk(makeChunk({
      chunkId: 'delete-active',
      kind: 'app_source',
      uri: `codebase://${ref.codebaseId}/Main.kt`,
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_2_active',
    }), DEFAULT_SCOPE);
    store.addChunk(makeChunk({
      chunkId: 'delete-staged',
      kind: 'app_source',
      uri: `codebase://${ref.codebaseId}/Staged.kt`,
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_3_staged',
    }), DEFAULT_SCOPE);
    store.addChunk(makeChunk({
      chunkId: 'keep-other-tenant',
      kind: 'app_source',
      uri: `codebase://${other.codebaseId}/Other.kt`,
      codebaseId: other.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_2_active',
    }), otherScope);

    const forbidden = await request(app).delete(`/api/rag/codebases/${other.codebaseId}`);
    expect(forbidden.status).toBe(200);
    expect(forbidden.body).toMatchObject({success: true, alreadyDeleted: true});
    expect(registry.get(other.codebaseId, otherScope)).toBeDefined();
    expect(store.getChunk('keep-other-tenant', otherScope)).toBeDefined();

    const deleted = await request(app).delete(`/api/rag/codebases/${ref.codebaseId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({
      success: true,
      codebaseId: ref.codebaseId,
      removedChunkCount: 2,
    });
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)).toBeUndefined();
    expect(store.getChunk('delete-active', DEFAULT_SCOPE)).toBeUndefined();
    expect(store.getChunk('delete-staged', DEFAULT_SCOPE)).toBeUndefined();
    expect(registry.get(other.codebaseId, otherScope)).toBeDefined();
    expect(store.getChunk('keep-other-tenant', otherScope)).toBeDefined();
  });

  it('returns a retryable conflict instead of deleting during reindex', async () => {
    const root = path.join(tmpDir, 'busy-delete-repo');
    fs.mkdirSync(root);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Busy App',
      rootPath: root,
      ...DEFAULT_SCOPE,
    });
    const leaseSpy = jest.spyOn(registry, 'withIngestLease')
      .mockRejectedValueOnce(new CodebaseStateError('codebase_reindex_in_progress'));

    const response = await request(app).delete(`/api/rag/codebases/${ref.codebaseId}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({success: false, code: 'CODEBASE_BUSY'});
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)).toBeDefined();
    leaseSpy.mockRestore();
  });

  it('retires retrieval before cleanup and resumes an interrupted delete idempotently', async () => {
    const root = path.join(tmpDir, 'retry-delete-repo');
    fs.mkdirSync(root);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Retry Delete',
      rootPath: root,
      sendToProvider: true,
      ...DEFAULT_SCOPE,
    });
    store.addChunk(makeChunk({
      chunkId: 'retry-delete-chunk',
      kind: 'app_source',
      uri: `codebase://${ref.codebaseId}/Main.kt`,
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_2_active',
    }), DEFAULT_SCOPE);
    const removeSpy = jest.spyOn(store, 'removeCodebaseChunks')
      .mockImplementationOnce(() => {
        throw new Error('simulated_cleanup_failure');
      });

    const interrupted = await request(app).delete(`/api/rag/codebases/${ref.codebaseId}`);

    expect(interrupted.status).toBe(500);
    expect(interrupted.body).toMatchObject({
      success: false,
      code: 'CODEBASE_DELETE_INCOMPLETE',
    });
    const retired = registry.get(ref.codebaseId, DEFAULT_SCOPE);
    expect(retired).toMatchObject({
      lifecycleState: 'deleting',
      chunkCount: 0,
      consent: {sendToProvider: false},
    });
    expect(retired?.activeGeneration).toMatch(/^deleted_/);
    expect(retired?.contentFingerprint).toBeUndefined();
    expect(store.getChunk('retry-delete-chunk', DEFAULT_SCOPE)).toBeDefined();

    const reindex = await request(app)
      .post(`/api/rag/codebases/${ref.codebaseId}/reindex`)
      .send({});
    expect(reindex.status).toBe(400);
    expect(reindex.body.error).toBe('codebase_deleting');

    removeSpy.mockRestore();
    const retried = await request(app).delete(`/api/rag/codebases/${ref.codebaseId}`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      success: true,
      codebaseId: ref.codebaseId,
      removedChunkCount: 1,
    });
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)).toBeUndefined();

    const repeated = await request(app).delete(`/api/rag/codebases/${ref.codebaseId}`);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({
      success: true,
      codebaseId: ref.codebaseId,
      removedChunkCount: 0,
      alreadyDeleted: true,
    });
  });
});
