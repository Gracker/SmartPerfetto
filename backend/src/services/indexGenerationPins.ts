// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The index generations one run pinned, and whether each can still be served.
 *
 * The analysis-context authorization fingerprint holds no index generation:
 * a rebuild elsewhere must not revoke a session or hide its history. So every
 * index entry point checks the generation its run pinned, before reading and
 * again right before delivering, and a change becomes an explicit tool
 * refusal, never an empty result. A generation serves only while its stored
 * data is whole: a registry that still names it proves nothing once its
 * chunks or file are gone. The policy depends on what a rebuild leaves behind:
 *
 * - `codebase`: a registered source index serves only the pinned generation
 *   while it is still the active one and the store still holds every chunk it
 *   was pinned with; the live root stays searchable.
 * - `document_collection`: a rebuild keeps the previous generation, so the
 *   pinned one serves while its file holds everything its manifest sealed.
 *
 * Authorization changes (consent, selection scope, deletion) still go through
 * the fingerprint and revoke the run; a generation change refuses one call.
 */

import {activeCodebaseGeneration, codebaseHasActiveIndex} from './codebase/codebaseRegistry';
import {sourceAccessRefusalAction} from './codebase/sourceAccessRefusal';
import type {AnalysisContextRegistrations} from './resolvedAnalysisContext';

export type IndexGenerationPolicy = 'codebase' | 'document_collection';

/**
 * The refusal each policy returns, as the tool result's payload. A codebase
 * names the codebase and points at on-demand search; a document collection
 * is unavailable, as when a read finds its file gone.
 */
const INDEX_GENERATION_REFUSALS = {
  codebase: {unsupportedReason: 'codebase_index_generation_changed',
    action: sourceAccessRefusalAction('codebase_index_generation_changed'), namesCodebase: true, isError: true},
  document_collection: {unsupportedReason: 'knowledge_index_unavailable',
    action: undefined, namesCodebase: false, isError: true},
} as const satisfies Record<IndexGenerationPolicy, {
  unsupportedReason: string; action: string | undefined; namesCodebase: boolean; isError: boolean;
}>;

export interface IndexGenerationRefusal {
  payload: {success: false; action_required?: string; codebaseId?: string; unsupportedReason: string};
  isError: boolean;
}

/** The refusal for one index of a policy whose pinned generation can no longer be served. */
export function indexGenerationRefusal(policy: IndexGenerationPolicy, id: string): IndexGenerationRefusal {
  const refusal = INDEX_GENERATION_REFUSALS[policy];
  return {
    payload: {success: false, ...(refusal.action ? {action_required: refusal.action} : {}),
      ...(refusal.namesCodebase ? {codebaseId: id} : {}), unsupportedReason: refusal.unsupportedReason},
    isError: refusal.isError,
  };
}

/** Where a pinned generation's data is stored, to tell whether it is still whole. */
export interface IndexGenerationStores {
  countCodebaseGenerationChunks(codebaseId: string, generation: string): number;
  /** Whether a document collection's generation file is there and holds all it sealed. */
  documentCollectionServes(sourceId: string, generation: string): boolean;
}

/**
 * A pinned generation and the chunks it held when pinned; `chunkCount` is
 * absent when it was not a usable index then (no content to lose).
 */
interface Pin {
  generation: string;
  chunkCount?: number;
}

export class IndexGenerationPins {
  private constructor(
    private readonly stores: IndexGenerationStores,
    private readonly codebases: ReadonlyMap<string, Pin>,
    /** Knowledge source id to its pinned generation; a collection's file says whether it is whole. */
    private readonly knowledge: ReadonlyMap<string, string>,
  ) {}

  /** Pin every selected index's active generation, once, at the start of a run. */
  static capture(registrations: AnalysisContextRegistrations, stores: IndexGenerationStores): IndexGenerationPins {
    const codebases = new Map([...registrations.codebases].flatMap(([codebaseId, ref]) => {
      const generation = ref ? activeCodebaseGeneration(ref) : undefined;
      return generation ? [[codebaseId, {generation,
        ...(codebaseHasActiveIndex(ref!) ? {chunkCount: ref!.chunkCount} : {})}] as const] : [];
    }));
    const knowledge = new Map([...registrations.knowledgeSources].flatMap(([sourceId, source]) =>
      source?.activeGeneration ? [[sourceId, source.activeGeneration] as const] : []));
    return new IndexGenerationPins(stores, codebases, knowledge);
  }

  /** The pinned generations of these codebases, for a search filter; unpinned ones are absent. */
  codebaseGenerations(codebaseIds: readonly string[]): Record<string, string> {
    return Object.fromEntries(codebaseIds.flatMap(codebaseId => {
      const pin = this.codebases.get(codebaseId);
      return pin ? [[codebaseId, pin.generation]] : [];
    }));
  }

  knowledgeGeneration(sourceId: string): string | undefined {
    return this.knowledge.get(sourceId);
  }

  /**
   * The refusal for the first of these indexes whose pinned generation can no
   * longer be served under `policy`, judged against `registrations` read at
   * this checkpoint; undefined when every one can. A codebase this run pinned
   * nothing for is not checked: no search reads it.
   */
  refusal(
    policy: IndexGenerationPolicy,
    ids: readonly string[],
    registrations: AnalysisContextRegistrations,
  ): IndexGenerationRefusal | undefined {
    const changed = ids.find(id => !this.servable(policy, id, registrations));
    return changed === undefined ? undefined : indexGenerationRefusal(policy, changed);
  }

  private servable(policy: IndexGenerationPolicy, id: string, registrations: AnalysisContextRegistrations): boolean {
    if (policy === 'codebase') {
      const pin = this.codebases.get(id);
      if (pin === undefined) return true;
      const ref = registrations.codebases.get(id);
      return Boolean(ref) && activeCodebaseGeneration(ref!) === pin.generation &&
        (pin.chunkCount === undefined || (codebaseHasActiveIndex(ref!) &&
          this.stores.countCodebaseGenerationChunks(id, pin.generation) >= pin.chunkCount));
    }
    const generation = this.knowledge.get(id);
    return generation !== undefined && this.stores.documentCollectionServes(id, generation);
  }
}
