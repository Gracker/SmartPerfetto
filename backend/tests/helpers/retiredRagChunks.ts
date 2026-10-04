// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';

import {privateKnowledgeScopeFingerprint} from '../../src/services/ragStore';
import type {KnowledgeScope} from '../../src/services/scopedKnowledgeStore';
import type {RagChunk} from '../../src/types/sparkContracts';

export interface RetiredWikiChunkSeed {
  chunkId: string;
  knowledgeSourceId: string;
  sourceGeneration: string;
  snippet?: string;
  title?: string;
  filePath?: string;
}

/**
 * Places Android Internals Wiki chunks in a local RAG store file as the
 * retired connector left them. No writer stores the kind any more, so a test
 * of the list, stats and delete paths that still serve them seeds the file
 * directly, merged with what the file already holds.
 */
export function seedRetiredWikiChunks(
  storagePath: string,
  chunks: readonly RetiredWikiChunkSeed[],
  scope: KnowledgeScope,
): void {
  const existing: RagChunk[] = fs.existsSync(storagePath)
    ? (JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as {chunks: RagChunk[]}).chunks
    : [];
  const knowledgeScopeFingerprint = privateKnowledgeScopeFingerprint(scope);
  const seeded: RagChunk[] = chunks.map(chunk => ({
    chunkId: chunk.chunkId,
    kind: 'android_internals_wiki',
    uri: `android-internals-wiki://${chunk.knowledgeSourceId}/${chunk.chunkId}`,
    snippet: chunk.snippet ?? 'Handler callback',
    indexedAt: 1714600000000,
    license: 'CC-BY-NC-SA-4.0',
    registryOrigin: 'external_knowledge_registry',
    knowledgeSourceId: chunk.knowledgeSourceId,
    sourceGeneration: chunk.sourceGeneration,
    knowledgeScopeFingerprint,
    ...(chunk.title ? {title: chunk.title} : {}),
    ...(chunk.filePath ? {filePath: chunk.filePath} : {}),
  }));
  fs.writeFileSync(storagePath, JSON.stringify({schemaVersion: 2, chunks: [...existing, ...seeded]}), 'utf-8');
}
