// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {PathSecurityGate} from '../codebase/pathSecurityGate';
import {
  type ExternalKnowledgeScope,
  type ExternalKnowledgeSource,
  type ExternalKnowledgeSourceRegistry,
  externalKnowledgeSourceHasActiveIndex,
  type KnowledgeCleanupFence,
  KnowledgeSourceRequestError,
} from '../externalKnowledgeSourceRegistry';
import {
  createDocumentCollectionGate,
  type DocumentCollectionReadSummary,
  readDocumentCollection,
} from './documentCollectionCorpus';
import {
  type DocumentCollectionSearchHit,
  DocumentCollectionStore,
  KnowledgeIndexUnavailableError,
} from './documentCollectionStore';

export interface DocumentCollectionPreview {
  rootRealpath: string;
  summary: DocumentCollectionReadSummary;
}

export interface DocumentCollectionIngestResult {
  sourceId: string;
  generation: string;
  contentFingerprint: string;
  documentCount: number;
  sectionCount: number;
  chunkCount: number;
  skipped: DocumentCollectionReadSummary['skipped'];
  cleanup: {status: 'completed' | 'failed'; removedFileCount: number; failedFileCount: number};
}

function knowledgeRootBlockedError(blockedReason: string | undefined): KnowledgeSourceRequestError {
  return new KnowledgeSourceRequestError('KNOWLEDGE_ROOT_BLOCKED',
    'The knowledge folder is blocked by the path policy', 400,
    {blockedReason: blockedReason ?? 'knowledge_root_blocked'});
}

/** A folder with nothing to index is refused, at preview and at every reindex. */
function documentCollectionEmptyError(
  skipped: DocumentCollectionReadSummary['skipped'],
): KnowledgeSourceRequestError {
  return new KnowledgeSourceRequestError('KNOWLEDGE_COLLECTION_EMPTY',
    'The folder holds no indexable documents', 400, skipped as Record<string, number>);
}

/**
 * Preview, index, search and delete document collections. Indexing reads
 * through the knowledge gate in yielding batches under the source's ingest
 * lease and activates a fully written generation file; it needs rights, not
 * provider-send consent, since nothing leaves the machine.
 */
export class DocumentCollectionIngester {
  constructor(
    private readonly registry: ExternalKnowledgeSourceRegistry,
    private readonly store: DocumentCollectionStore = new DocumentCollectionStore(),
    private readonly gate: PathSecurityGate = createDocumentCollectionGate(),
  ) {}

  /** What a folder would index; a blocked or empty folder is refused. */
  async previewIndexable(rootPath: string): Promise<DocumentCollectionPreview> {
    const preview = await this.gate.preview(rootPath);
    if (preview.blocked) throw knowledgeRootBlockedError(preview.blockedReason);
    const summary = await readDocumentCollection(preview, this.gate.getSourceReadLimits());
    if (summary.documentCount === 0) throw documentCollectionEmptyError(summary.skipped);
    return {rootRealpath: preview.rootRealpath, summary};
  }

  async ingest(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    options: {signal?: AbortSignal} = {},
  ): Promise<DocumentCollectionIngestResult> {
    // Checked before the lease too, so an unknown id never creates a lease record.
    this.requireCollection(sourceId, scope);
    return this.registry.withIngestLease(sourceId, scope, async lease => {
      const source = this.requireCollection(sourceId, scope);
      const preview = await this.gate.preview(source.rootRealpath);
      if (preview.blocked) throw knowledgeRootBlockedError(preview.blockedReason);
      if (preview.rootRealpath !== source.rootRealpath) throw new Error('knowledge_root_realpath_drift');
      lease.assertHeld();

      const generation = `dc_${createHash('sha256')
        .update(`${sourceId}\0${lease.operationId}`)
        .digest('hex')
        .slice(0, 32)}`;
      const writer = this.store.beginGeneration(scope, sourceId, generation);
      let summary: DocumentCollectionReadSummary;
      try {
        summary = await readDocumentCollection(preview, this.gate.getSourceReadLimits(), {
          beforeBatch: () => {
            if (options.signal?.aborted) throw new Error('knowledge_ingest_cancelled');
            lease.assertHeld();
          },
          onBatch: documents => writer.writeBatch(documents),
        });
        if (summary.documentCount === 0) throw documentCollectionEmptyError(summary.skipped);
        lease.assertHeld();
        writer.commit(summary);
      } catch (error) {
        writer.abort();
        throw error;
      }

      try {
        lease.activateGeneration({
          generation,
          revision: `content-${summary.contentFingerprint.slice(0, 40)}`,
          contentFingerprint: summary.contentFingerprint,
          dirty: false,
          indexedArticleCount: summary.documentCount,
          indexedChunkCount: summary.chunkCount,
        });
      } catch (error) {
        // The pointer write may have landed on one store side before failing:
        // keep the file while either side names it, else it is an orphan.
        try {
          if (!this.registry.referencedGenerations(sourceId, scope).has(generation)) {
            this.store.removeGeneration(scope, sourceId, generation, lease);
          }
        } catch {
          // Unreadable pointers or a lost lease keep the file; a later collection decides.
        }
        throw error;
      }

      let cleanup: DocumentCollectionIngestResult['cleanup'];
      try {
        const collected = await this.store.collectGarbage(
          scope,
          sourceId,
          this.registry.referencedGenerations(sourceId, scope),
          lease,
        );
        cleanup = {
          status: collected.failed === 0 ? 'completed' : 'failed',
          removedFileCount: collected.removed,
          failedFileCount: collected.failed,
        };
      } catch {
        cleanup = {status: 'failed', removedFileCount: 0, failedFileCount: 0};
      }
      return {
        sourceId,
        generation,
        contentFingerprint: summary.contentFingerprint,
        documentCount: summary.documentCount,
        sectionCount: summary.sectionCount,
        chunkCount: summary.chunkCount,
        skipped: summary.skipped,
        cleanup,
      };
    });
  }

  /** The owner's check that a collection's active generation answers queries. */
  search(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    query: string,
    topK: number,
  ): {generation: string; hits: DocumentCollectionSearchHit[]} {
    const source = this.requireCollection(sourceId, scope);
    if (!source.activeGeneration || !externalKnowledgeSourceHasActiveIndex(source)) {
      throw new KnowledgeIndexUnavailableError();
    }
    return {
      generation: source.activeGeneration,
      hits: this.store.search(scope, sourceId, source.activeGeneration, query, topK),
    };
  }

  /** Every index file of a source; the registry's `remove` calls it after the tombstone, under its lease. */
  removeIndex(scope: ExternalKnowledgeScope, sourceId: string, fence: KnowledgeCleanupFence): Promise<void> {
    return this.store.removeSource(scope, sourceId, fence);
  }

  private requireCollection(sourceId: string, scope: ExternalKnowledgeScope): ExternalKnowledgeSource {
    const source = this.registry.requireIndexAccess(sourceId, scope);
    if (source.kind !== 'document_collection') {
      throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_KIND_MISMATCH',
        `External knowledge source '${sourceId}' is not a document collection`);
    }
    return source;
  }
}
