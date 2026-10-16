// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Deletes any external knowledge source with its index, whatever its kind:
 * the one removal the `/knowledge` route and `smp knowledge remove` share. A
 * document collection takes its generation files with it; a record of the
 * retired Wiki connector has only RagStore chunks to clear.
 */

import type {RagStore} from '../ragStore';
import type {
  ExternalKnowledgeKind,
  ExternalKnowledgeScope,
  ExternalKnowledgeSourceRegistry,
  KnowledgeCleanupFence,
} from '../externalKnowledgeSourceRegistry';
import type {DocumentCollectionIngester} from './documentCollectionIngester';

export interface KnowledgeSourceRemovalServices {
  registry: ExternalKnowledgeSourceRegistry;
  collections: Pick<DocumentCollectionIngester, 'removeIndex'>;
  ragStore: Pick<RagStore, 'removeKnowledgeSourceChunks'>;
}

/** Delete one source through the registry's fenced removal; running it again finishes a deletion that stopped half way. */
export async function removeKnowledgeSource(
  services: KnowledgeSourceRemovalServices,
  sourceId: string,
  scope: ExternalKnowledgeScope,
  actor: string,
): Promise<void> {
  /** How each kind's index goes; the Record type covers every kind. */
  const removeIndexByKind: Readonly<Record<
    ExternalKnowledgeKind,
    (fence: KnowledgeCleanupFence) => Promise<void> | void
  >> = {
    android_internals_wiki: () => {
      services.ragStore.removeKnowledgeSourceChunks(sourceId, scope);
    },
    document_collection: fence => services.collections.removeIndex(scope, sourceId, fence),
  };
  await services.registry.remove(sourceId, scope, actor, (tombstone, fence) => {
    // A stored record of a kind this build does not know keeps its tombstone.
    const removeIndex = removeIndexByKind[tombstone.kind] as typeof removeIndexByKind[ExternalKnowledgeKind] | undefined;
    if (!removeIndex) throw new Error('Unknown external knowledge kind');
    return removeIndex(fence);
  });
}
