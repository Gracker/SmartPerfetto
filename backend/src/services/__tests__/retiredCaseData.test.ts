// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {createCaseRoutes} from '../../routes/caseRoutes';
import type {CaseEdge, CaseNode, RagChunk} from '../../types/sparkContracts';
import {buildCaseBackgroundContext} from '../caseEvolution/caseBackgroundContext';
import {createCaseRetriever} from '../caseEvolution/caseRecommendationRetriever';
import {CaseGraph} from '../caseGraph';
import {CaseLibrary} from '../caseLibrary';
import {ENTERPRISE_DB_PATH_ENV, openEnterpriseDb} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';
import {buildTenantExportBundle} from '../enterpriseTenantExportService';
import {RagStore} from '../ragStore';
import * as retiredCaseData from '../retiredCaseData';
import {isRetiredRagChunk, RETIRED_RAG_CHUNK_SQL} from '../retiredCaseData';
import {upsertScopedKnowledgeRecord, type KnowledgeScope} from '../scopedKnowledgeStore';
import {caseCurationGrantForMarkdownIngest} from '../security/caseCuration';

const curator = caseCurationGrantForMarkdownIngest();

const ENV_KEYS = [
  ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_DB_PATH_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_API_KEY',
  'SMARTPERFETTO_SSO_TRUSTED_HEADERS',
] as const;
const OPERATOR_KEY = 'retired-case-test-operator-key';
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

const TENANT = 'tenant-a';
const WORKSPACE = 'workspace-a';
const scope: KnowledgeScope = {tenantId: TENANT, workspaceId: WORKSPACE, userId: 'user-a'};
/** Retired by its id. */
const LEARNED = 'learned:0123456789abcdef';
/** Retired by its source only: an ordinary id. */
const DISGUISED = 'case-disguised';
/** A learned case's chunk after a Markdown round trip: `case://learned:<id>`. */
const LAUNDERED = 'learned:fedcba9876543210';

const PHASES = [
  {name: 'file-only (legacy)', phase: undefined},
  {name: 'dual-write', phase: 'dual-write'},
  {name: 'DB-only (retired)', phase: 'retired'},
] as const;
type Phase = (typeof PHASES)[number];

/**
 * Run `write` as a release before the learned-case retirement would: through
 * the stores' own write paths with the retirement's write ban lifted, so the
 * retired data lands in exactly the shape each storage phase keeps.
 */
function writeAsBeforeRetirement<T>(write: () => T): T {
  const ban = jest.spyOn(retiredCaseData, 'assertNotRetiredCaseWrite')
    .mockImplementation(() => undefined);
  try {
    return write();
  } finally {
    ban.mockRestore();
  }
}

/** A reviewed scrolling case about shader compilation, as a curator writes it. */
function scrollingCase(caseId: string, overrides: Partial<CaseNode> = {}): CaseNode {
  return {
    schemaVersion: 1,
    source: 'curated_markdown_case',
    createdAt: 1,
    caseId,
    title: `${caseId} shader compile jank`,
    status: 'reviewed',
    redactionState: 'redacted',
    tags: ['scrolling', 'shader_compile'],
    findings: [{id: 'finding-1', title: 'Shader compile overlaps jank', severity: 'warning'}],
    knowledge: {
      sourceFile: `cases/${caseId}.md`,
      body: 'body',
      quality: 'curated',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: {architectureType: 'android'},
      evidenceSignatures: {
        required: [{field: 'reason_code', op: 'eq', value: 'shader_compile'}],
        supportive: [],
      },
      recommendations: {
        app: [{id: 'app-1', priority: 'P1', action: 'Warm shaders', applies_when: 'shader_compile', risks: 'risk'}],
        oem: [],
      },
    },
    ...overrides,
  };
}

/** A case as the retired learned-case ingester wrote it. */
function learnedCase(caseId: string): CaseNode {
  return scrollingCase(caseId, {
    source: 'runtime_analysis_candidate',
    tags: ['scrolling', 'shader_compile', 'learned'],
  });
}

/**
 * A case's RAG summary. The learned ingester wrote `case://learned/<id>`; a
 * learned case exported to Markdown and imported again got `case://<id>`,
 * which for a `learned:` id reads `case://learned:<id>`.
 */
function caseChunk(caseId: string, uri = `case://${caseId}`, snippet?: string): RagChunk {
  return {
    chunkId: `case:${caseId}:summary`,
    kind: 'case_library',
    uri,
    title: caseId,
    snippet: snippet ?? `${caseId} shader compile makePipeline jank`,
    indexedAt: 1,
    registryOrigin: 'plan54_cases',
  };
}

function caseEdge(edgeId: string, fromCaseId: string, toCaseId: string, weight = 0.5): CaseEdge {
  return {edgeId, fromCaseId, toCaseId, relation: 'similar_root_cause', weight};
}

/** DELETE /api/cases/:caseId as a curator; the operator key reads its partition from headers in every phase. */
async function deleteThroughApi(library: CaseLibrary, graph: CaseGraph, caseId: string) {
  process.env.SMARTPERFETTO_API_KEY = OPERATOR_KEY;
  const app = express();
  app.use(express.json());
  app.use('/api/cases', createCaseRoutes(library, graph));
  return request(app).delete(`/api/cases/${caseId}`)
    .set('Authorization', `Bearer ${OPERATOR_KEY}`)
    .set('x-tenant-id', TENANT)
    .set('x-workspace-id', WORKSPACE);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-retired-case-'));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function usePhase(phase: Phase): void {
  if (!phase.phase) return;
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = phase.phase;
}

function openStores() {
  const library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
  const rag = new RagStore(path.join(tmpDir, 'rag_store.json'));
  const graph = new CaseGraph(path.join(tmpDir, 'case_graph.json'), library);
  return {library, rag, graph};
}

/** Two curated cases, plus what the retired pipeline and its round trips left. */
function seedStores() {
  const stores = openStores();
  const {library, rag, graph} = stores;
  library.saveCase(scrollingCase('case-a'), curator, scope);
  library.saveCase(scrollingCase('case-b'), curator, scope);
  rag.addChunks([caseChunk('case-a'), caseChunk('case-b')], scope);
  graph.addEdge(caseEdge('edge-ab', 'case-a', 'case-b', 0.1), scope);
  writeAsBeforeRetirement(() => {
    library.saveCase(learnedCase(LEARNED), curator, scope);
    library.saveCase(learnedCase(DISGUISED), curator, scope);
    rag.addChunks([
      caseChunk(LEARNED, `case://learned/${LEARNED}`),
      caseChunk(LAUNDERED),
    ], scope);
    // Heavier than edge-ab, so each would sort first in findRelated.
    graph.addEdge(caseEdge('case-learned-edge:0001', 'case-a', 'case-c', 0.9), scope);
    graph.addEdge(caseEdge('edge-a-learned', 'case-a', LEARNED, 0.8), scope);
    graph.addEdge(caseEdge('edge-a-disguised', 'case-a', DISGUISED, 0.7), scope);
  });
  rag.flush();
  return stores;
}

describe.each(PHASES)('retired learned cases in $name storage', phase => {
  beforeEach(() => usePhase(phase));

  it('are absent from every case, chunk and edge read', () => {
    const {library, rag, graph} = seedStores();

    expect([LEARNED, DISGUISED, 'case-a'].map(id => library.getCase(id, scope)?.caseId))
      .toEqual([undefined, undefined, 'case-a']);
    expect(library.listCases({}, scope).map(c => c.caseId).sort()).toEqual(['case-a', 'case-b']);
    expect(library.listCases({status: 'reviewed'}, scope).map(c => c.caseId).sort())
      .toEqual(['case-a', 'case-b']);
    expect(library.getStats(scope).reviewed).toBe(2);
    expect([...library.retiredCaseIds(scope)].sort()).toEqual([DISGUISED, LEARNED].sort());

    expect([LEARNED, LAUNDERED, 'case-a'].map(id => rag.getChunk(`case:${id}:summary`, scope)?.chunkId))
      .toEqual([undefined, undefined, 'case:case-a:summary']);
    expect(rag.listChunks({scope}).map(chunk => chunk.chunkId).sort())
      .toEqual(['case:case-a:summary', 'case:case-b:summary']);
    expect(rag.getStats(scope).case_library.chunkCount).toBe(2);
    expect(rag.search('shader compile makePipeline', {scope}).results.map(hit => hit.chunkId).sort())
      .toEqual(['case:case-a:summary', 'case:case-b:summary']);

    expect(graph.listEdges(scope).map(edge => edge.edgeId)).toEqual(['edge-ab']);
    expect(graph.size(scope)).toBe(1);
    expect(graph.getEdgesFrom('case-a', scope).map(edge => edge.edgeId)).toEqual(['edge-ab']);
    expect(graph.getEdgesTo(DISGUISED, scope)).toEqual([]);
    // Filtered before ranking and truncation: the heavier retired edges
    // cannot take the one slot.
    expect(graph.findRelated('case-a', {knowledgeScope: scope, topK: 1}).map(hit => hit.caseId))
      .toEqual(['case-b']);
  });

  it('never reach an analysis through recall or the background prompt', () => {
    const {library, rag} = seedStores();

    const hits = createCaseRetriever({library, ragStore: rag, scope}).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      audiences: ['app'],
      evidenceSignatures: {reason_code: 'shader_compile'},
      textQuery: 'shader compile makePipeline',
      includeStatuses: ['reviewed'],
    });
    expect(hits.map(hit => hit.caseId).sort()).toEqual(['case-a', 'case-b']);

    const background = buildCaseBackgroundContext('scrolling', 'android', scope, {
      library,
      config: {retrieveEnabled: true, promptInjectEnabled: true},
      topK: 10,
    });
    expect(background).toContain('case-a');
    expect(background).not.toContain(LEARNED);
    expect(background).not.toContain(DISGUISED);
  });

  it('cannot be written again, though they can still be removed', () => {
    const {library, rag, graph} = seedStores();
    const refused = /retired_case_data_write_refused/;

    expect(() => library.saveCase(learnedCase('learned:new'), curator, scope)).toThrow(refused);
    expect(() => library.saveCase(learnedCase('case-new'), curator, scope)).toThrow(refused);
    expect(() => library.publishCase(LEARNED, {reviewer: 'curator'}, curator, scope)).toThrow(/not found/);
    expect(() => library.archiveCase(DISGUISED, {reason: 'stale'}, curator, scope)).toThrow(/not found/);
    expect(() => rag.addChunk(caseChunk('learned:new'), scope)).toThrow(refused);
    expect(() => rag.addChunk(caseChunk('case-new', 'case://learned/case-new'), scope)).toThrow(refused);
    expect(() => graph.addEdge(caseEdge('case-learned-edge:new', 'case-a', 'case-b'), scope)).toThrow(refused);
    expect(() => graph.addEdge(caseEdge('edge-new', 'learned:new', 'case-b'), scope)).toThrow(refused);
    expect(() => graph.addEdge(caseEdge('edge-new', 'case-b', DISGUISED), scope)).toThrow(refused);

    expect(library.removeCase(LEARNED, scope)).toBe(true);
    expect(library.retiredCaseIds(scope)).toEqual(new Set([DISGUISED]));
  });

  it('take their ordinary edges with them when removed through the API', async () => {
    const {library, graph} = seedStores();

    const res = await deleteThroughApi(library, graph, DISGUISED);

    expect(res.status).toBe(200);
    expect(library.retiredCaseIds(scope)).toEqual(new Set([LEARNED]));
    // Without the case, nothing would mark edge-a-disguised as retired.
    expect(graph.listEdges(scope).map(edge => edge.edgeId)).toEqual(['edge-ab']);
  });

  it('take only their own edges when an ordinary edge shares an edge id', async () => {
    const {library, graph} = seedStores();
    graph.addEdge({...caseEdge('shared-id', 'case-a', 'case-b'), relation: 'same_app'}, scope);
    writeAsBeforeRetirement(() => graph.addEdge(caseEdge('shared-id', 'case-a', DISGUISED), scope));

    expect((await deleteThroughApi(library, graph, DISGUISED)).status).toBe(200);

    expect(graph.listEdges(scope).map(edge => `${edge.edgeId} ${edge.toCaseId}`).sort())
      .toEqual(['edge-ab case-b', 'shared-id case-b']);
  });

  it('refuse the removal and keep the case when the graph cannot be read', async () => {
    const {library, graph} = seedStores();
    if (phase.phase === 'retired') {
      const db = openEnterpriseDb(path.join(tmpDir, 'enterprise.sqlite'));
      try {
        db.prepare(`UPDATE memory_entries SET content_json = '{'
          WHERE scope LIKE 'case_edge:%' AND json_extract(content_json, '$.record.edgeId') = 'edge-ab'`).run();
      } finally {
        db.close();
      }
    } else {
      fs.writeFileSync(path.join(tmpDir, 'case_graph.json'), '{"schemaVersion": 1, "edges": [SECRET');
    }

    const res = await deleteThroughApi(library, graph, DISGUISED);

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('SECRET');
    expect(library.retiredCaseIds(scope)).toEqual(new Set([DISGUISED, LEARNED]));
  });

  it('keep every graph read closed when the case store cannot be read', () => {
    const {graph} = seedStores();
    if (phase.phase === 'retired') {
      const db = openEnterpriseDb(path.join(tmpDir, 'enterprise.sqlite'));
      try {
        db.prepare(`UPDATE memory_entries SET content_json = '{'
          WHERE scope LIKE 'case:%' AND json_extract(content_json, '$.record.caseId') = ?`).run(DISGUISED);
      } finally {
        db.close();
      }
    } else {
      fs.writeFileSync(path.join(tmpDir, 'case_library.json'), '{"schemaVersion": 1, "cases": [SECRET');
    }
    const unreadable = phase.phase === 'retired' ? 'knowledge_record_unreadable' : 'case_library_unreadable';

    expect(() => graph.listEdges(scope)).toThrow(unreadable);
    expect(() => graph.findRelated('case-a', {knowledgeScope: scope, topK: 1})).toThrow(unreadable);
    expect(() => graph.addEdge(caseEdge('edge-new', 'case-a', 'case-b'), scope)).toThrow(unreadable);
    // The error names the failure, not the stored text.
    try {
      graph.listEdges(scope);
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });

  it('leave a store holding nothing else reading as an empty index', () => {
    const {rag} = openStores();
    writeAsBeforeRetirement(() => rag.addChunks([
      caseChunk(LEARNED, `case://learned/${LEARNED}`),
      caseChunk(LAUNDERED),
    ], scope));
    rag.flush();

    const result = rag.search('shader compile', {scope});
    expect(result.results).toEqual([]);
    expect(result.unsupportedReason).toBe('index empty');
    expect(rag.getStats(scope).case_library.chunkCount).toBe(0);
  });

  if (phase.phase) {
    it('are not exported with the tenant', async () => {
      seedStores();
      const db = openEnterpriseDb(path.join(tmpDir, 'enterprise.sqlite'));
      try {
        const {bundle} = await buildTenantExportBundle(db, {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'user-a',
          authType: 'dev',
          roles: [],
          scopes: [],
          requestId: 'request-1',
        });
        const exportedChunks = bundle.knowledge.memoryEntries
          .filter(entry => String(entry.scope).startsWith('rag:') && entry.content !== null)
          .map(entry => (entry.content as unknown as {record: RagChunk}).record.chunkId)
          .sort();
        expect(exportedChunks).toEqual(['case:case-a:summary', 'case:case-b:summary']);
      } finally {
        db.close();
      }
    });
  }
});

describe('removing a retired case in dual-write', () => {
  beforeEach(() => usePhase(PHASES[1]));

  it('also removes the edges only the database copy holds', async () => {
    const {library, graph} = seedStores();
    // An edge the file copy never received: dual-write copies can diverge.
    const dbOnly = caseEdge('edge-db-only', 'case-b', DISGUISED);
    upsertScopedKnowledgeRecord('case_edge', `canonical:case-b|${DISGUISED}|similar_root_cause`,
      'case_edge:similar_root_cause', dbOnly, scope);

    expect((await deleteThroughApi(library, graph, DISGUISED)).status).toBe(200);

    // Read the database copy as the next phase will.
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    expect(graph.listEdges(scope).map(edge => edge.edgeId)).toEqual(['edge-ab']);
  });
});

describe('retired chunks in the SQL search', () => {
  beforeEach(() => usePhase(PHASES[2]));

  it('never take a candidate slot from a curated chunk', () => {
    const {rag} = openStores();
    // One curated chunk, long enough to rank below every retired one.
    rag.addChunk(caseChunk('case-a', 'case://case-a',
      `shader compile makePipeline ${'unrelated filler text '.repeat(200)}`), scope);
    writeAsBeforeRetirement(() => rag.addChunks(
      Array.from({length: 250}, (_, index) =>
        caseChunk(`learned:${String(index).padStart(16, '0')}`, undefined, 'shader compile makePipeline')),
      scope,
    ));

    expect(rag.search('shader compile makePipeline', {scope, topK: 1}).results.map(hit => hit.chunkId))
      .toEqual(['case:case-a:summary']);
    // The exact-location branch filters the same way.
    expect(rag.search('shader', {scope, filePathExact: 'case://learned:0000000000000000'}).results)
      .toEqual([]);
  });
});

describe('RETIRED_RAG_CHUNK_SQL', () => {
  it('agrees with isRetiredRagChunk, including case, missing fields and non-strings', () => {
    const chunks: Array<Record<string, unknown>> = [
      {kind: 'case_library', chunkId: 'case:learned:a:summary', uri: 'case://learned/a'},
      {kind: 'case_library', chunkId: 'case:a:summary', uri: 'case://learned/a'},
      {kind: 'case_library', chunkId: 'case:a:summary', uri: 'case://learned:a'},
      {kind: 'case_library', chunkId: 'case:learned:a:summary', uri: 'case://a'},
      {kind: 'case_library', chunkId: 'case:a:summary', uri: 'case://a'},
      {kind: 'case_library', chunkId: 'CASE:LEARNED:a', uri: 'CASE://LEARNED/a'},
      {kind: 'case_library', chunkId: 'x-case:learned:a', uri: 'x-case://learned/a'},
      {kind: 'case_library', chunkId: 'case:learned', uri: 'case://learned'},
      {kind: 'case_library'},
      {kind: 'case_library', chunkId: null, uri: null},
      {kind: 'case_library', chunkId: 7, uri: 7},
      {kind: 'androidperformance.com', chunkId: 'case:learned:a:summary', uri: 'case://learned/a'},
    ];
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, scope TEXT, content_json TEXT)');
      const insert = db.prepare('INSERT INTO memory_entries (id, scope, content_json) VALUES (?, ?, ?)');
      chunks.forEach((chunk, index) =>
        insert.run(index, `rag:${String(chunk.kind)}`, JSON.stringify({kind: 'rag_chunk', record: chunk})));
      const sql = db.prepare<[number], {retired: number}>(
        `SELECT (${RETIRED_RAG_CHUNK_SQL}) AS retired FROM memory_entries WHERE id = ?`);

      const verdicts = chunks.map((chunk, index) => ({
        chunk,
        js: isRetiredRagChunk(chunk),
        sql: sql.get(index)?.retired === 1,
      }));
      expect(verdicts.filter(verdict => verdict.js !== verdict.sql)).toEqual([]);
      expect(verdicts.map(verdict => verdict.js))
        .toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
    } finally {
      db.close();
    }
  });
});
