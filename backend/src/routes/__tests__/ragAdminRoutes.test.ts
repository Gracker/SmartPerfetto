// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {createRagAdminRoutes} from '../ragAdminRoutes';
import {RagStore} from '../../services/ragStore';
import type {RagChunk} from '../../types/sparkContracts';
import {CodebaseRegistry} from '../../services/codebase/codebaseRegistry';
import {PathSecurityGate} from '../../services/codebase/pathSecurityGate';
import {NativeDirectoryPicker} from '../../services/codebase/nativeDirectoryPicker';
import {ExternalKnowledgeSourceRegistry} from '../../services/externalKnowledgeSourceRegistry';
import {AndroidInternalsWikiIngester} from '../../services/androidInternalsWiki/androidInternalsWikiIngester';

let tmpDir: string;
let store: RagStore;
let registry: CodebaseRegistry;
let externalKnowledgeRegistry: ExternalKnowledgeSourceRegistry;
let app: express.Express;
let directoryPicker: NativeDirectoryPicker;
let pickerSelectedRoot: string;
let pickerSelectionSequence: number;
let externalPickerDir: string | undefined;
const DEFAULT_SCOPE = {
  tenantId: 'default-dev-tenant',
  workspaceId: 'default-workspace',
  userId: 'dev-user-123',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-admin-test-'));
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  externalKnowledgeRegistry = new ExternalKnowledgeSourceRegistry(
    path.join(tmpDir, 'external-knowledge-sources.json'),
  );
  const gate = new PathSecurityGate({allowlistRoots: [tmpDir]});
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
  const wikiGate = new PathSecurityGate({
    allowlistRoots: [tmpDir],
    allowedExtensions: ['.md'],
  });
  const skillsPath = path.join(tmpDir, 'audit-skills');
  fs.mkdirSync(skillsPath, {recursive: true});
  fs.writeFileSync(path.join(skillsPath, 'handler.skill.yaml'), [
    'name: handler_callbacks',
    'meta:',
    '  tags: [handler]',
    'triggers:',
    '  keywords: [Handler]',
  ].join('\n'));
  const fixtureManifestPath = path.join(tmpDir, 'public-fixtures.yaml');
  fs.writeFileSync(fixtureManifestPath, [
    'fixtures:',
    '  - id: fixture-a',
    '    assertions:',
    '      - query_id: handler_callbacks/callbacks',
  ].join('\n'));
  const capabilityMapPath = path.join(tmpDir, 'capability-map.yaml');
  fs.writeFileSync(capabilityMapPath, [
    'version: 1',
    'domains:',
    '  - id: handler',
    '    terms: [handler]',
    '    skill_tags: [handler]',
    '    validations:',
    '      - skill_id: handler_callbacks',
    '        observable_claim: callback slices are observable',
    '        assertion_ref: backend/skills/public-fixtures.yaml#fixture-a:handler_callbacks/callbacks',
    '        article_paths: [src/article.md]',
  ].join('\n'));
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/rag', createRagAdminRoutes(store, {
    registry,
    gate,
    directoryPicker,
    externalKnowledgeRegistry,
    androidInternalsWikiIngester: new AndroidInternalsWikiIngester(
      store,
      externalKnowledgeRegistry,
      wikiGate,
    ),
    androidInternalsWikiAuditPaths: {
      capabilityMapPath,
      skillsPath,
      fixtureManifestPath,
    },
  } as any));
});

afterEach(() => {
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

function createCommittedWiki(rootName: string, body = 'Handler callback details'): string {
  const root = path.join(tmpDir, rootName);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'article.md'), [
    '---',
    'title: Android internals',
    'status: finalized',
    'confidence: high',
    'tags: [handler]',
    '---',
    '# Android internals',
    body,
  ].join('\n'));
  require('child_process').execFileSync('git', ['init', '-q', root]);
  require('child_process').execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  require('child_process').execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  require('child_process').execFileSync('git', ['-C', root, 'add', '.']);
  require('child_process').execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
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

describe('Android Internals Wiki routes', () => {
  it('previews the official article inventory without returning corpus prose', async () => {
    const root = path.join(tmpDir, 'wiki');
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'handler.md'), [
      '---',
      'title: Handler internals',
      'status: finalized',
      '---',
      '# Handler internals',
      'PRIVATE_WIKI_CANARY message queue details',
    ].join('\n'));
    require('child_process').execFileSync('git', ['init', '-q', root]);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    require('child_process').execFileSync('git', ['-C', root, 'add', '.']);
    require('child_process').execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

    const response = await request(app)
      .post('/api/rag/android-internals/preview')
      .send({rootPath: root});

    expect(response.status).toBe(200);
    expect(response.body.preview).toEqual(expect.objectContaining({
      totalArticles: 1,
      metadataErrorCount: 0,
      dirtyAcceptedArticleCount: 0,
      contentFingerprint: expect.any(String),
      revision: expect.any(String),
    }));
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_WIKI_CANARY');
  });

  it('registers a scoped source only after rights and provider consent are explicit', async () => {
    const root = path.join(tmpDir, 'registered-wiki');
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'handler.md'), [
      '---',
      'title: Handler internals',
      'status: finalized',
      '---',
      '# Handler internals',
      'Message queue details',
    ].join('\n'));
    require('child_process').execFileSync('git', ['init', '-q', root]);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    require('child_process').execFileSync('git', ['-C', root, 'add', '.']);
    require('child_process').execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

    const response = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({
        rootPath: root,
        displayName: 'Android Internals Wiki',
        rightsAcknowledged: true,
        sendToProvider: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.source).toEqual(expect.objectContaining({
      sourceId: expect.any(String),
      kind: 'android_internals_wiki',
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      revision: expect.any(String),
      contentFingerprint: expect.any(String),
    }));
    expect(response.body.source.rootRealpath).toBeUndefined();

    const listed = await request(app).get('/api/rag/android-internals/sources');
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([
      expect.objectContaining({sourceId: response.body.source.sourceId}),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(root);
  });

  it('reindexes a registered source and atomically activates its generation', async () => {
    const root = path.join(tmpDir, 'indexed-wiki');
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'handler.md'), [
      '---',
      'title: Handler internals',
      'status: finalized',
      'confidence: high',
      'tags: [handler]',
      '---',
      '# Handler internals',
      '消息队列 Handler callback execution details',
    ].join('\n'));
    require('child_process').execFileSync('git', ['init', '-q', root]);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    require('child_process').execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    require('child_process').execFileSync('git', ['-C', root, 'add', '.']);
    require('child_process').execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
    const registered = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: true});
    const sourceId = registered.body.source.sourceId;

    const response = await request(app)
      .post(`/api/rag/android-internals/sources/${sourceId}/reindex`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.result).toEqual(expect.objectContaining({
      sourceId,
      indexedArticleCount: 1,
      indexedChunkCount: expect.any(Number),
      generation: expect.any(String),
    }));
    expect(response.body.result.indexedChunkCount).toBeGreaterThan(0);
    expect(store.getStats(DEFAULT_SCOPE).android_internals_wiki.chunkCount).toBeGreaterThan(0);
  });

  it('revokes provider consent immediately for subsequent indexing', async () => {
    const root = createCommittedWiki('revoked-wiki');
    const registered = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: true});
    const sourceId = registered.body.source.sourceId;

    const revoked = await request(app)
      .patch(`/api/rag/android-internals/sources/${sourceId}/consent`)
      .send({sendToProvider: false});
    const reindex = await request(app)
      .post(`/api/rag/android-internals/sources/${sourceId}/reindex`)
      .send({});

    expect(revoked.status).toBe(200);
    expect(revoked.body.source).toEqual(expect.objectContaining({
      sourceId,
      sendToProvider: false,
    }));
    expect(reindex.status).toBe(400);
    expect(reindex.body.error).toBe('provider_send_not_consented');
  });

  it('clears every index generation without deleting source registration', async () => {
    const root = createCommittedWiki('cleared-wiki');
    const registered = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: true});
    const sourceId = registered.body.source.sourceId;
    await request(app)
      .post(`/api/rag/android-internals/sources/${sourceId}/reindex`)
      .send({});

    const cleared = await request(app)
      .delete(`/api/rag/android-internals/sources/${sourceId}/index`);

    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({
      success: true,
      removedChunkCount: expect.any(Number),
      source: expect.objectContaining({
        sourceId,
        indexedArticleCount: 0,
        indexedChunkCount: 0,
      }),
    });
    expect(cleared.body.removedChunkCount).toBeGreaterThan(0);
    expect(store.listChunks({kind: 'android_internals_wiki', scope: DEFAULT_SCOPE})).toHaveLength(0);
    expect(cleared.body.source.activeGeneration).toBeUndefined();
  });

  it('audits every registered article without returning article prose', async () => {
    const root = createCommittedWiki('audited-wiki', 'AUDIT_PRIVATE_WIKI_CANARY Handler details');
    const registered = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: false});
    const sourceId = registered.body.source.sourceId;

    const audited = await request(app)
      .get(`/api/rag/android-internals/sources/${sourceId}/audit`);

    expect(audited.status).toBe(200);
    expect(audited.body.audit.report).toEqual(expect.objectContaining({
      totalArticles: 1,
      counts: expect.objectContaining({validated_trace_skill: 1}),
      rows: [expect.objectContaining({
        relativePath: 'src/article.md',
        disposition: 'validated_trace_skill',
        observableClaim: 'callback slices are observable',
      })],
    }));
    expect(JSON.stringify(audited.body)).not.toContain('AUDIT_PRIVATE_WIKI_CANARY');
  });

  it('blocks audit when a registered root is replaced by a different realpath', async () => {
    const root = createCommittedWiki('audit-root-before-swap');
    const registered = await request(app)
      .post('/api/rag/android-internals/sources')
      .send({rootPath: root, rightsAcknowledged: true, sendToProvider: false});
    const sourceId = registered.body.source.sourceId;
    const replacement = createCommittedWiki(
      'audit-root-replacement',
      'AUDIT_REALPATH_DRIFT_PRIVATE_CANARY',
    );
    fs.rmSync(root, {recursive: true, force: true});
    fs.symlinkSync(replacement, root, 'dir');

    const audited = await request(app)
      .get(`/api/rag/android-internals/sources/${sourceId}/audit`);

    expect(audited.status).toBe(400);
    expect(audited.body.error).toBe('knowledge_root_realpath_drift');
    expect(JSON.stringify(audited.body)).not.toContain('AUDIT_REALPATH_DRIFT_PRIVATE_CANARY');
  });
});

describe('codebase routes', () => {
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
        rootAuthorization: 'native_picker',
      }),
    ]));
    const audit = await request(app)
      .get(`/api/rag/codebases/${registered.body.codebase.codebaseId}/audit`);
    expect(audit.body.audit).toMatchObject({
      rootAuthorization: 'native_picker',
    });

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

    const registered = await request(app)
      .post('/api/rag/codebases/register')
      .send({
        kind: 'app_source',
        displayName: 'HighPerformanceMini',
        rootPath: root,
        sendToProvider: true,
      });
    expect(registered.status).toBe(200);
    const codebaseId = registered.body.codebase.codebaseId;
    expect(registered.body.codebase.rootPath).toBeUndefined();

    const reindex = await request(app)
      .post(`/api/rag/codebases/${codebaseId}/reindex`)
      .send({});
    expect(reindex.status).toBe(200);
    expect(reindex.body.result.chunksAdded).toBeGreaterThan(0);

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

    const chunkId = search.body.result.results[0].chunkId;
    const excerpt = await request(app)
      .get(`/api/rag/codebases/${codebaseId}/excerpt`)
      .query({chunkId});
    expect(excerpt.status).toBe(200);
    expect(excerpt.body.excerpt.text).toContain('simulateHeavyLaunch()');
    expect(excerpt.body.excerpt.filePath).toBe('launch-aosp/src/main/java/com/example/MainActivity.kt');

    store.addChunk(makeChunk({
      chunkId: 'stale-generation',
      kind: 'app_source',
      uri: 'codebase://stale/MainActivity.kt',
      snippet: 'STALE_GENERATION_PRIVATE_CANARY',
      codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_0',
      filePath: 'MainActivity.kt',
      language: 'kotlin',
    }), DEFAULT_SCOPE);
    const staleExcerpt = await request(app)
      .get(`/api/rag/codebases/${codebaseId}/excerpt`)
      .query({chunkId: 'stale-generation'});
    expect(staleExcerpt.status).toBe(404);
    expect(JSON.stringify(staleExcerpt.body)).not.toContain('STALE_GENERATION_PRIVATE_CANARY');
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
      .mockRejectedValueOnce(new Error('codebase_reindex_in_progress'));

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
