// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';
import {IndexGenerationPins} from '../indexGenerationPins';
import {RagStore} from '../ragStore';
import {readAnalysisContextRegistrations} from '../resolvedAnalysisContext';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

const COLLECTION_GENERATION = 'dc_' + '1'.repeat(32);

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-generation-pins-'));
  roots.push(root);
  const codebaseRegistry = new CodebaseRegistry(path.join(root, 'codebases.json'));
  const knowledgeRegistry = new ExternalKnowledgeSourceRegistry(path.join(root, 'knowledge.json'));
  const store = new RagStore(path.join(root, 'rag.json'));
  const indexed = codebaseRegistry.register({kind: 'app_source', displayName: 'App', rootPath: root, ...scope});
  const unindexed = codebaseRegistry.register({kind: 'app_source', displayName: 'Other', rootPath: root, ...scope});
  const activateCodebase = (generation: string, chunkCount = 2) => {
    const current = codebaseRegistry.get(indexed.codebaseId, scope)!;
    codebaseRegistry.activateIndexGeneration(indexed.codebaseId, scope, current.indexGeneration, {lastIngestStatus: 'ok',
      activeGeneration: generation, contentFingerprint: 'a'.repeat(64), chunkCount});
  };
  activateCodebase('codebase-gen-1');
  for (const line of [1, 10]) {
    store.addChunk({chunkId: `code-${line}`, kind: 'app_source', registryOrigin: 'codebase_registry',
      codebaseId: indexed.codebaseId, sourceGeneration: 'codebase-gen-1', uri: `codebase://${indexed.codebaseId}/A.kt`,
      filePath: 'A.kt', lineRange: {start: line, end: line + 5}, snippet: `fun a${line}() {}`, indexedAt: 1}, scope);
  }
  const common = {rootRealpath: root, revision: 'r', contentFingerprint: 'f', dirty: false,
    rightsAcknowledged: true, sendToProvider: true, consentedBy: scope.userId, scope};
  const wikiId = knowledgeRegistry.register({...common, kind: 'android_internals_wiki', displayName: 'Wiki',
    license: 'internal'}).sourceId;
  const collectionId = knowledgeRegistry.register({...common, kind: 'document_collection', displayName: 'Docs'}).sourceId;
  const activateKnowledge = (sourceId: string, generation: string) => knowledgeRegistry.withIngestLease(sourceId, scope,
    lease => lease.activateGeneration({generation, revision: 'r', contentFingerprint: generation, dirty: false,
      indexedArticleCount: 1, indexedChunkCount: 1}));
  await activateKnowledge(wikiId, 'wiki_gen_1');
  store.addChunk({chunkId: 'wiki-chunk', kind: 'android_internals_wiki', registryOrigin: 'external_knowledge_registry',
    knowledgeSourceId: wikiId, sourceGeneration: 'wiki_gen_1', uri: `android-internals-wiki://${wikiId}/a`,
    snippet: 'Handler dispatch.', indexedAt: 1, license: 'internal'}, scope);
  await activateKnowledge(collectionId, COLLECTION_GENERATION);
  const files = new Set([COLLECTION_GENERATION]);
  const selection = {codebaseIds: [indexed.codebaseId, unindexed.codebaseId], knowledgeSourceIds: [wikiId, collectionId]};
  const registrations = () => readAnalysisContextRegistrations(selection, scope, {codebaseRegistry, knowledgeRegistry});
  const pins = IndexGenerationPins.capture(registrations(), {
    countCodebaseGenerationChunks: (codebaseId, generation) => store.countCodebaseGenerationChunks(codebaseId, generation, scope),
    countKnowledgeSourceGenerationChunks: (sourceId, generation) =>
      store.countKnowledgeSourceGenerationChunks(sourceId, generation, scope),
    documentCollectionServes: (_sourceId, generation) => files.has(generation),
  });
  return {pins, registrations, store, indexedId: indexed.codebaseId, unindexedId: unindexed.codebaseId, wikiId,
    collectionId, activateCodebase, activateKnowledge, files};
}

describe('IndexGenerationPins', () => {
  it('pins each selected index once and filters a search to the pinned generations', async () => {
    const {pins, indexedId, unindexedId, wikiId, collectionId, activateCodebase} = await fixture();
    activateCodebase('codebase-gen-2');
    expect(pins.codebaseGenerations([indexedId, unindexedId])).toEqual({[indexedId]: 'codebase-gen-1'});
    expect(pins.knowledgeGeneration(wikiId)).toBe('wiki_gen_1');
    expect(pins.knowledgeGeneration(collectionId)).toBe(COLLECTION_GENERATION);
  });

  it('refuses a codebase once its active generation moves or goes, and never checks an unpinned one', async () => {
    const {pins, registrations, indexedId, unindexedId, activateCodebase} = await fixture();
    expect(pins.refusal('codebase', [indexedId, unindexedId], registrations())).toBeUndefined();
    activateCodebase('codebase-gen-2');
    expect(pins.refusal('codebase', [unindexedId, indexedId], registrations())).toEqual({isError: true, payload: {
      success: false, action_required: 'use_search_codebase', codebaseId: indexedId,
      unsupportedReason: 'codebase_index_generation_changed'}});
  });

  it('refuses a pinned codebase index that lost its content under the same generation name', async () => {
    const {pins, registrations, indexedId, activateCodebase} = await fixture();
    activateCodebase('codebase-gen-1', 0);
    expect(pins.refusal('codebase', [indexedId], registrations())?.payload)
      .toMatchObject({unsupportedReason: 'codebase_index_generation_changed'});
  });

  it('refuses a pinned codebase whose stored chunks were lost while the registry still names its generation', async () => {
    const {pins, registrations, store, indexedId} = await fixture();
    expect(pins.refusal('codebase', [indexedId], registrations())).toBeUndefined();
    // One chunk of two is gone: a partial generation is not served as fewer hits.
    store.removeCodebaseChunkIds(indexedId, ['code-10'], scope);
    expect(pins.refusal('codebase', [indexedId], registrations())?.payload).toEqual({success: false,
      action_required: 'use_search_codebase', codebaseId: indexedId, unsupportedReason: 'codebase_index_generation_changed'});
  });

  it('refuses a Wiki on any change, since its rebuild deletes the older generation', async () => {
    const {pins, registrations, wikiId, activateKnowledge} = await fixture();
    expect(pins.refusal('wiki', [wikiId], registrations())).toBeUndefined();
    await activateKnowledge(wikiId, 'wiki_gen_2');
    expect(pins.refusal('wiki', [wikiId], registrations())).toEqual({isError: false, payload: {success: false,
      action_required: 'continue_without_private_knowledge', unsupportedReason: 'knowledge_index_generation_changed'}});
  });

  it('refuses a Wiki whose stored chunks were lost while the registry still names its generation', async () => {
    const {pins, registrations, store, wikiId} = await fixture();
    store.removeKnowledgeSourceChunks(wikiId, scope);
    expect(pins.refusal('wiki', [wikiId], registrations())?.payload)
      .toMatchObject({unsupportedReason: 'knowledge_index_generation_changed'});
  });

  it('serves a document collection while its pinned generation serves, whatever is active', async () => {
    const {pins, registrations, collectionId, activateKnowledge, files} = await fixture();
    await activateKnowledge(collectionId, 'dc_' + '2'.repeat(32));
    expect(pins.refusal('document_collection', [collectionId], registrations())).toBeUndefined();
    files.clear();
    expect(pins.refusal('document_collection', [collectionId], registrations())).toEqual({isError: true,
      payload: {success: false, unsupportedReason: 'knowledge_index_unavailable'}});
    // A source the run pinned nothing for is never served.
    expect(pins.refusal('document_collection', ['eks_' + '0'.repeat(24)], registrations())?.payload)
      .toMatchObject({unsupportedReason: 'knowledge_index_unavailable'});
  });
});
