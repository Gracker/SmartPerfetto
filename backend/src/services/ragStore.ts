// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * RagStore — local file-backed storage for RAG (Retrieval-Augmented
 * Generation) chunks. Serves Plan 55 (content RAG over blog / AOSP / OEM
 * SDK) and Plan 44 (project memory exposure as a RAG corpus).
 *
 * M0 scope (this file):
 * - JSON file persistence with atomic temp + rename writes
 * - In-memory cache as the source of truth between writes
 * - License gate at insert time for `aosp` / `oem_sdk` source kinds
 * - Token-overlap keyword search (no embeddings yet — M2 may switch to
 *   sqlite-vec when chunk count breaches the BM25 threshold; the
 *   `search()` shape is stable so a driver swap stays local)
 * - Retrieval-level `unsupportedReason` for the three distinguishable
 *   failure modes: empty index, all-blocked, and no-match (the last
 *   intentionally has no unsupportedReason so callers know the query
 *   itself didn't hit, not that the infrastructure failed)
 *
 * @module ragStore
 */

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {backendLogPath} from '../runtimePaths';
import {withFilesystemRegistryLock} from './filesystemRegistryLock';
import {tokenizeRagText} from './rag/searchTokens';

import {
  type RagChunk,
  type RagRetrievalHit,
  type RagRetrievalResult,
  type RagSourceKind,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  countScopedRagRecords,
  legacyKnowledgeFilesystemWritesEnabled,
  type KnowledgeScope,
  getScopedKnowledgeRecord,
  getScopedRagStats,
  listScopedKnowledgeRecords,
  removeScopedKnowledgeRecord,
  removeScopedKnowledgeRecords,
  removeScopedRagRecords,
  searchScopedRagKnowledgeRecords,
  upsertScopedKnowledgeRecords,
} from './scopedKnowledgeStore';

/** Source kinds that require a `license` field at ingestion time. */
const LICENSE_REQUIRED_KINDS: ReadonlySet<RagSourceKind> = new Set([
  'aosp',
  'oem_sdk',
  'kernel_source',
  'android_internals_wiki',
  'android_internals_pack',
]);

/** All RagSourceKind values. Kept here so getStats() can initialize a
 * complete record without reaching into the type system at runtime. When
 * the union in sparkContracts.ts grows, update this list and getStats()'s
 * initial accumulator will pick up the new kind automatically. */
const ALL_RAG_SOURCE_KINDS: readonly RagSourceKind[] = [
  'androidperformance.com',
  'aosp',
  'oem_sdk',
  'project_memory',
  'world_memory',
  'case_library',
  'app_source',
  'kernel_source',
  'android_internals_wiki',
];

/** Stable on-disk envelope. The schemaVersion is bumped when the layout
 * is no longer backward compatible — readers must skip on mismatch. */
interface StorageEnvelope {
  schemaVersion: 1 | 2;
  chunks: RagChunk[];
}

const KNOWLEDGE_KIND = 'rag_chunk';
const RAG_ROW_SCOPE_PREFIX = 'rag:';
export const DEFAULT_LOCAL_RAG_SEARCH_MAX_CHUNKS = 20_000;
export const DEFAULT_LOCAL_RAG_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_RAG_SEARCH_TOP_K = 100;
export const MAX_RAG_SEARCH_QUERY_BYTES = 8 * 1024;
export const MAX_RAG_SEARCH_FILTER_ITEMS = 100;

export interface RagStoreLimits {
  localSearchMaxChunks?: number;
  localSearchMaxBytes?: number;
  /** Hard cap for the complete legacy JSON store before it is read or written. */
  localStorageMaxChunks?: number;
  localStorageMaxBytes?: number;
}

export interface RagStoreSearchOptions {
  /** Maximum hits returned. Defaults to 5. */
  topK?: number;
  /** Restrict the search to a subset of source kinds. */
  kinds?: RagSourceKind[];
  /** Enterprise tenant/workspace scope. Ignored by legacy JSON storage. */
  scope?: KnowledgeScope;
  /** Restrict source-backed chunks to selected codebases. */
  codebaseIds?: string[];
  vendor?: string;
  buildId?: string;
  pathPrefix?: string;
  symbolExact?: string;
  filePathExact?: string;
  languages?: RagChunk['language'][];
  /** Request-scoped private knowledge source allowlist. */
  knowledgeSourceIds?: string[];
  /** Active generation per allowed private knowledge source. */
  activeSourceGenerations?: Record<string, string>;
  /** Active generation per allowed registered codebase. */
  activeCodebaseGenerations?: Record<string, string>;
}

export interface RagStoreListOptions {
  kind?: RagSourceKind;
  registryOrigin?: RagChunk['registryOrigin'];
  uriPrefix?: string;
  scope?: KnowledgeScope;
}

/** Per-kind index summary returned by `getStats()`. */
export type RagStoreStats = Record<
  RagSourceKind,
  {chunkCount: number; lastIndexedAt?: number}
>;

/** Tokenize Unicode words and emit overlapping Han bigrams so Chinese queries
 * can match a phrase embedded in a longer sentence without a segmenter or
 * provider dependency. The token set is intersected with the query token set
 * to score chunks. */
function isPrivateKnowledgeChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'android_internals_wiki' || chunk.registryOrigin === 'codebase_registry';
}

function isExternalPrivateKnowledgeChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'android_internals_wiki';
}

export function privateKnowledgeScopeFingerprint(scope?: KnowledgeScope): string | undefined {
  if (!scope?.tenantId || !scope.workspaceId || !scope.userId) return undefined;
  return createHash('sha256')
    .update(`${scope.tenantId}\0${scope.workspaceId}\0${scope.userId}`)
    .digest('hex');
}

function privateKnowledgeVisibleInScope(chunk: RagChunk, scope?: KnowledgeScope): boolean {
  if (!isPrivateKnowledgeChunk(chunk)) return true;
  const fingerprint = privateKnowledgeScopeFingerprint(scope);
  if (
    chunk.registryOrigin === 'codebase_registry' &&
    !chunk.knowledgeScopeFingerprint
  ) {
    return fingerprint === privateKnowledgeScopeFingerprint({
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
      userId: 'dev-user-123',
    });
  }
  return Boolean(fingerprint && chunk.knowledgeScopeFingerprint === fingerprint);
}

/** Build a fresh stats accumulator with every known source kind set to
 * zero. Callers iterate chunks to populate it. */
function emptyStats(): RagStoreStats {
  const stats = {} as RagStoreStats;
  for (const kind of ALL_RAG_SOURCE_KINDS) {
    stats[kind] = {chunkCount: 0};
  }
  return stats;
}

function defaultRegistryOrigin(kind: RagSourceKind): RagChunk['registryOrigin'] {
  switch (kind) {
    case 'androidperformance.com':
    case 'aosp':
    case 'oem_sdk':
      return 'legacy_plan55';
    case 'project_memory':
    case 'world_memory':
      return 'plan44_memory';
    case 'case_library':
      return 'plan54_cases';
    case 'app_source':
    case 'kernel_source':
      return 'codebase_registry';
    case 'android_internals_wiki':
      return 'external_knowledge_registry';
    case 'android_internals_pack':
      return 'built_in_knowledge_pack';
  }
}

function normalizeChunkForStorage(chunk: RagChunk): RagChunk {
  if (chunk.kind === 'android_internals_pack') {
    throw new Error(
      'Built-in Android Internals Pack chunks must use AndroidInternalsPackStore',
    );
  }
  const registryOrigin = chunk.registryOrigin ?? defaultRegistryOrigin(chunk.kind);
  if ((chunk.kind === 'app_source' || chunk.kind === 'kernel_source') && !chunk.codebaseId) {
    throw new Error(
      `Code-aware source chunk '${chunk.chunkId}' (${chunk.kind}) requires codebaseId`,
    );
  }
  if (registryOrigin === 'codebase_registry' && !chunk.codebaseId) {
    throw new Error(
      `Codebase registry chunk '${chunk.chunkId}' requires codebaseId`,
    );
  }
  return {
    ...chunk,
    registryOrigin,
  };
}

function backfillChunk(chunk: RagChunk): RagChunk {
  if (chunk.registryOrigin === 'codebase_registry' && !chunk.knowledgeScopeFingerprint) {
    return {
      ...chunk,
      knowledgeScopeFingerprint: privateKnowledgeScopeFingerprint({
        tenantId: 'default-dev-tenant',
        workspaceId: 'default-workspace',
        userId: 'dev-user-123',
      }),
    };
  }
  if (isExternalPrivateKnowledgeChunk(chunk) && !chunk.knowledgeScopeFingerprint) {
    return {
      ...chunk,
      unsupportedReason: chunk.unsupportedReason ?? 'pre_scope_private_knowledge_chunk',
    };
  }
  if (chunk.registryOrigin) return chunk;
  if (chunk.kind === 'app_source' || chunk.kind === 'kernel_source') {
    return {
      ...chunk,
      unsupportedReason: chunk.unsupportedReason ?? 'pre_v3_2_invalid_kind_origin_combo',
    };
  }
  return {
    ...chunk,
    registryOrigin: defaultRegistryOrigin(chunk.kind),
  };
}

/**
 * Local file-backed RAG store. Writers coordinate through the shared
 * filesystem registry lock and merge pending mutations with the latest
 * on-disk state before each atomic replacement.
 */
export class RagStore {
  private readonly storagePath: string;
  private readonly chunks = new Map<string, RagChunk>();
  private readonly pendingUpserts = new Set<string>();
  private readonly pendingDeletes = new Set<string>();
  private loaded = false;
  private loadedStorageSignature: string | undefined;
  private readonly serializedChunkBytes = new Map<string, number>();
  private serializedChunkBytesTotal = 0;
  private readonly localSearchMaxChunks: number;
  private readonly localSearchMaxBytes: number;
  private readonly localStorageMaxChunks: number;
  private readonly localStorageMaxBytes: number;

  constructor(storagePath: string, limits: RagStoreLimits = {}) {
    this.storagePath = storagePath;
    this.localSearchMaxChunks = limits.localSearchMaxChunks ?? DEFAULT_LOCAL_RAG_SEARCH_MAX_CHUNKS;
    this.localSearchMaxBytes = limits.localSearchMaxBytes ?? DEFAULT_LOCAL_RAG_SEARCH_MAX_BYTES;
    this.localStorageMaxChunks = limits.localStorageMaxChunks ?? this.localSearchMaxChunks;
    this.localStorageMaxBytes = limits.localStorageMaxBytes ?? this.localSearchMaxBytes;
    for (const [name, value] of Object.entries({
      localSearchMaxChunks: this.localSearchMaxChunks,
      localSearchMaxBytes: this.localSearchMaxBytes,
      localStorageMaxChunks: this.localStorageMaxChunks,
      localStorageMaxBytes: this.localStorageMaxBytes,
    })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  /** Idempotently load the on-disk store into memory. */
  load(): void {
    const signature = this.storageSignature();
    if (this.loaded && signature === this.loadedStorageSignature) return;
    const pendingUpserts = new Map<string, RagChunk>();
    for (const chunkId of this.pendingUpserts) {
      const chunk = this.chunks.get(chunkId);
      if (chunk) pendingUpserts.set(chunkId, chunk);
    }
    const diskChunks = new Map<string, RagChunk>();
    if (!fs.existsSync(this.storagePath)) {
      this.replaceWithPendingMutations(pendingUpserts);
      this.loaded = true;
      this.loadedStorageSignature = signature;
      return;
    }
    try {
      this.assertStorageFileWithinBudget();
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.chunks)) {
        // Schema mismatch: leave in-memory empty; do not delete the file
        // so the operator can inspect it.
        this.replaceWithPendingMutations(pendingUpserts);
        this.loaded = true;
        this.loadedStorageSignature = signature;
        return;
      }
      this.assertChunkCountWithinBudget(parsed.chunks.length);
      for (const c of parsed.chunks) {
        diskChunks.set(c.chunkId, backfillChunk(c));
      }
    } catch (error) {
      if (error instanceof LocalRagStorageBudgetError) throw error;
      // Corrupted JSON: same policy as schema mismatch — empty cache,
      // file preserved for inspection.
      this.replaceWithPendingMutations(pendingUpserts);
      this.loaded = true;
      this.loadedStorageSignature = signature;
      return;
    }
    for (const chunkId of this.pendingDeletes) diskChunks.delete(chunkId);
    for (const [chunkId, chunk] of pendingUpserts) diskChunks.set(chunkId, chunk);
    this.chunks.clear();
    for (const [chunkId, chunk] of diskChunks) this.chunks.set(chunkId, chunk);
    this.rebuildSerializedChunkAccounting();
    this.loaded = true;
    this.loadedStorageSignature = signature;
  }

  private replaceWithPendingMutations(pendingUpserts: ReadonlyMap<string, RagChunk>): void {
    this.chunks.clear();
    for (const [chunkId, chunk] of pendingUpserts) {
      if (!this.pendingDeletes.has(chunkId)) this.chunks.set(chunkId, chunk);
    }
    this.rebuildSerializedChunkAccounting();
  }

  private storageSignature(): string {
    try {
      const stat = fs.statSync(this.storagePath);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      return 'missing';
    }
  }

  private assertStorageFileWithinBudget(): void {
    const fileSize = fs.statSync(this.storagePath).size;
    if (fileSize > this.localStorageMaxBytes) {
      throw new LocalRagStorageBudgetError(
        `file size ${fileSize} exceeds ${this.localStorageMaxBytes} bytes`,
      );
    }
  }

  private assertChunkCountWithinBudget(chunkCount: number): void {
    if (chunkCount > this.localStorageMaxChunks) {
      throw new LocalRagStorageBudgetError(
        `chunk count ${chunkCount} exceeds ${this.localStorageMaxChunks}`,
      );
    }
  }

  private serializeWithinStorageBudget(chunks: readonly RagChunk[]): string {
    this.assertChunkCountWithinBudget(chunks.length);
    const serialized = JSON.stringify({schemaVersion: 2, chunks});
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > this.localStorageMaxBytes) {
      throw new LocalRagStorageBudgetError(
        `serialized size ${serializedBytes} exceeds ${this.localStorageMaxBytes} bytes`,
      );
    }
    return serialized;
  }

  private serializedChunkSize(chunk: RagChunk): number {
    return Buffer.byteLength(JSON.stringify(chunk), 'utf8');
  }

  private serializedEnvelopeSize(chunkCount: number, chunkBytes: number): number {
    return Buffer.byteLength('{"schemaVersion":2,"chunks":[]}', 'utf8') +
      chunkBytes + Math.max(0, chunkCount - 1);
  }

  private rebuildSerializedChunkAccounting(): void {
    this.serializedChunkBytes.clear();
    this.serializedChunkBytesTotal = 0;
    for (const [chunkId, chunk] of this.chunks) {
      const bytes = this.serializedChunkSize(chunk);
      this.serializedChunkBytes.set(chunkId, bytes);
      this.serializedChunkBytesTotal += bytes;
    }
  }

  private assertNormalizedChunksWithinStorageBudget(chunks: readonly RagChunk[]): void {
    let chunkCount = this.chunks.size;
    let chunkBytes = this.serializedChunkBytesTotal;
    const proposedSizes = new Map<string, number>();
    for (const chunk of chunks) {
      const previousBytes = proposedSizes.has(chunk.chunkId)
        ? proposedSizes.get(chunk.chunkId)
        : this.serializedChunkBytes.get(chunk.chunkId);
      const nextBytes = this.serializedChunkSize(chunk);
      if (previousBytes === undefined) chunkCount += 1;
      else chunkBytes -= previousBytes;
      chunkBytes += nextBytes;
      proposedSizes.set(chunk.chunkId, nextBytes);
    }
    this.assertChunkCountWithinBudget(chunkCount);
    const serializedBytes = this.serializedEnvelopeSize(chunkCount, chunkBytes);
    if (serializedBytes > this.localStorageMaxBytes) {
      throw new LocalRagStorageBudgetError(
        `serialized size ${serializedBytes} exceeds ${this.localStorageMaxBytes} bytes`,
      );
    }
  }

  private setLocalChunk(chunk: RagChunk): void {
    const previousBytes = this.serializedChunkBytes.get(chunk.chunkId);
    if (previousBytes !== undefined) this.serializedChunkBytesTotal -= previousBytes;
    const nextBytes = this.serializedChunkSize(chunk);
    this.serializedChunkBytes.set(chunk.chunkId, nextBytes);
    this.serializedChunkBytesTotal += nextBytes;
    this.chunks.set(chunk.chunkId, chunk);
  }

  private deleteLocalChunk(chunkId: string): boolean {
    if (!this.chunks.delete(chunkId)) return false;
    this.serializedChunkBytesTotal -= this.serializedChunkBytes.get(chunkId) ?? 0;
    this.serializedChunkBytes.delete(chunkId);
    return true;
  }

  /**
   * Add or replace a chunk. Throws when the kind requires a license and
   * the chunk lacks one — the caller is expected to surface this back
   * to the operator rather than silently dropping the chunk.
   */
  addChunk(chunk: RagChunk, scope?: KnowledgeScope): void {
    this.addChunks([chunk], scope);
  }

  /** Add one generation with bounded enterprise writes and one cache load. */
  addChunks(chunks: readonly RagChunk[], scope?: KnowledgeScope): void {
    if (chunks.length === 0) return;
    const filesystemWritesEnabled = legacyKnowledgeFilesystemWritesEnabled();
    if (filesystemWritesEnabled) this.load();
    const normalizedChunks = chunks.map(chunk => {
      let normalized = normalizeChunkForStorage(chunk);
      if (LICENSE_REQUIRED_KINDS.has(chunk.kind) && !chunk.license) {
        throw new Error(
          `License required for source kind '${chunk.kind}' but missing on chunk '${chunk.chunkId}'`,
        );
      }
      if (isPrivateKnowledgeChunk(normalized)) {
        const scopeFingerprint = privateKnowledgeScopeFingerprint(scope);
        if (!scopeFingerprint) {
          throw new Error(`Private knowledge chunk '${chunk.chunkId}' requires tenant/workspace/user scope`);
        }
        if (
          isExternalPrivateKnowledgeChunk(normalized) && (
            normalized.registryOrigin !== 'external_knowledge_registry' ||
            !normalized.knowledgeSourceId ||
            !normalized.sourceGeneration
          )
        ) {
          throw new Error(`Private knowledge chunk '${chunk.chunkId}' requires source registry metadata`);
        }
        normalized = {...normalized, knowledgeScopeFingerprint: scopeFingerprint};
      }
      return normalized;
    });
    if (filesystemWritesEnabled) {
      this.assertNormalizedChunksWithinStorageBudget(normalizedChunks);
    }
    if (enterpriseKnowledgeDbWritesEnabled()) {
      upsertScopedKnowledgeRecords(normalizedChunks.map(normalized => ({
        kind: KNOWLEDGE_KIND,
        externalId: normalized.chunkId,
        rowScope: ragRowScope(normalized.kind),
        record: normalized,
        options: {createdAt: normalized.indexedAt, updatedAt: normalized.indexedAt},
      })), scope);
    }
    if (filesystemWritesEnabled) {
      for (const normalized of normalizedChunks) {
        this.setLocalChunk(normalized);
        this.pendingUpserts.add(normalized.chunkId);
        this.pendingDeletes.delete(normalized.chunkId);
      }
    }
  }

  /** Remove a chunk. Returns whether anything was actually removed. */
  removeChunk(chunkId: string, scope?: KnowledgeScope): boolean {
    let removed = false;
    if (enterpriseKnowledgeDbWritesEnabled()) {
      removed = removeScopedKnowledgeRecord(KNOWLEDGE_KIND, chunkId, scope) || removed;
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.load();
      const existing = this.chunks.get(chunkId);
      const had = Boolean(existing && privateKnowledgeVisibleInScope(existing, scope));
      if (had) {
        this.deleteLocalChunk(chunkId);
        this.pendingDeletes.add(chunkId);
        this.pendingUpserts.delete(chunkId);
      }
      if (had) this.persist();
      removed = had || removed;
    }
    return removed;
  }

  /** Remove all staged and active generations belonging to one private source. */
  removeKnowledgeSourceChunks(sourceId: string, scope?: KnowledgeScope): number {
    const enterpriseRemoved = enterpriseKnowledgeDbWritesEnabled()
      ? removeScopedRagRecords(scope, {
          knowledgeSourceId: sourceId,
          scopeFingerprint: privateKnowledgeScopeFingerprint(scope),
        })
      : 0;
    const legacyRemoved = this.removeKnowledgeSourceChunksMatching(sourceId, scope, () => true, true);
    return Math.max(enterpriseRemoved, legacyRemoved);
  }

  /** Remove every staged, active, and superseded generation for one codebase. */
  removeCodebaseChunks(codebaseId: string, scope?: KnowledgeScope): number {
    const enterpriseRemoved = enterpriseKnowledgeDbWritesEnabled()
      ? removeScopedRagRecords(scope, {
          codebaseId,
          scopeFingerprint: privateKnowledgeScopeFingerprint(scope),
        })
      : 0;
    const legacyRemoved = this.removeCodebaseChunksMatching(
      codebaseId,
      scope,
      () => true,
      true,
    );
    return Math.max(enterpriseRemoved, legacyRemoved);
  }

  removeCodebaseChunksExceptGeneration(
    codebaseId: string,
    preservedGenerations: string | readonly string[],
    scope?: KnowledgeScope,
  ): number {
    const preserved = new Set(
      typeof preservedGenerations === 'string' ? [preservedGenerations] : preservedGenerations,
    );
    return this.removeCodebaseChunksMatching(
      codebaseId,
      scope,
      chunk => !chunk.sourceGeneration || !preserved.has(chunk.sourceGeneration),
    );
  }

  /** Keep only the chunks staged by the lease that just became active. */
  removeCodebaseChunksExceptIds(
    codebaseId: string,
    activeChunkIds: readonly string[],
    scope?: KnowledgeScope,
  ): number {
    const keep = new Set(activeChunkIds);
    return this.removeCodebaseChunksMatching(
      codebaseId,
      scope,
      chunk => !keep.has(chunk.chunkId),
    );
  }

  removeCodebaseChunkIds(
    codebaseId: string,
    chunkIds: readonly string[],
    scope?: KnowledgeScope,
  ): number {
    const enterpriseRemoved = enterpriseKnowledgeDbWritesEnabled()
      ? removeScopedKnowledgeRecords(KNOWLEDGE_KIND, chunkIds, scope)
      : 0;
    const remove = new Set(chunkIds);
    const legacyRemoved = this.removeCodebaseChunksMatching(
      codebaseId,
      scope,
      chunk => remove.has(chunk.chunkId),
      true,
    );
    return Math.max(enterpriseRemoved, legacyRemoved);
  }

  countCodebaseGenerationChunks(
    codebaseId: string,
    sourceGeneration: string,
    scope?: KnowledgeScope,
  ): number {
    if (enterpriseKnowledgeStoreEnabled()) {
      return countScopedRagRecords(scope, {
        codebaseId,
        sourceGeneration,
        scopeFingerprint: privateKnowledgeScopeFingerprint(scope),
      });
    }
    return this.listChunks({scope}).filter(chunk =>
      chunk.codebaseId === codebaseId &&
      chunk.registryOrigin === 'codebase_registry' &&
      chunk.sourceGeneration === sourceGeneration).length;
  }

  private removeCodebaseChunksMatching(
    codebaseId: string,
    scope: KnowledgeScope | undefined,
    shouldRemove: (chunk: RagChunk) => boolean,
    skipEnterprise = false,
  ): number {
    const removedIds = new Set<string>();
    if (enterpriseKnowledgeDbWritesEnabled() && !skipEnterprise) {
      const chunks = listScopedKnowledgeRecords<RagChunk>(
        KNOWLEDGE_KIND,
        scope,
        {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
      ).map(row => row.record);
      const enterpriseChunkIds = chunks.filter(chunk => {
        if (
          chunk.codebaseId !== codebaseId ||
          chunk.registryOrigin !== 'codebase_registry' ||
          !privateKnowledgeVisibleInScope(chunk, scope) ||
          !shouldRemove(chunk)
        ) return false;
        return true;
      }).map(chunk => chunk.chunkId);
      if (enterpriseChunkIds.length > 0) {
        removeScopedKnowledgeRecords(KNOWLEDGE_KIND, enterpriseChunkIds, scope);
        for (const chunkId of enterpriseChunkIds) removedIds.add(chunkId);
      }
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.load();
      let changed = false;
      for (const [chunkId, chunk] of this.chunks) {
        if (
          chunk.codebaseId !== codebaseId ||
          chunk.registryOrigin !== 'codebase_registry' ||
          !privateKnowledgeVisibleInScope(chunk, scope) ||
          !shouldRemove(chunk)
        ) continue;
        this.deleteLocalChunk(chunkId);
        this.pendingDeletes.add(chunkId);
        this.pendingUpserts.delete(chunkId);
        removedIds.add(chunkId);
        changed = true;
      }
      if (changed) this.persist();
    }
    return removedIds.size;
  }

  /** Remove an exact pre-activation snapshot without touching later generations. */
  removeKnowledgeSourceChunkIds(
    sourceId: string,
    chunkIds: readonly string[],
    scope?: KnowledgeScope,
  ): number {
    const enterpriseRemoved = enterpriseKnowledgeDbWritesEnabled()
      ? removeScopedKnowledgeRecords(KNOWLEDGE_KIND, chunkIds, scope)
      : 0;
    const remove = new Set(chunkIds);
    const legacyRemoved = this.removeKnowledgeSourceChunksMatching(
      sourceId,
      scope,
      chunk => remove.has(chunk.chunkId),
      true,
    );
    return Math.max(enterpriseRemoved, legacyRemoved);
  }

  /** Remove staged and superseded generations after a new generation is active. */
  removeInactiveKnowledgeSourceChunks(
    sourceId: string,
    activeGeneration: string,
    scope?: KnowledgeScope,
  ): number {
    const enterpriseRemoved = enterpriseKnowledgeDbWritesEnabled()
      ? removeScopedRagRecords(scope, {
          knowledgeSourceId: sourceId,
          excludeSourceGeneration: activeGeneration,
          scopeFingerprint: privateKnowledgeScopeFingerprint(scope),
        })
      : 0;
    const legacyRemoved = this.removeKnowledgeSourceChunksMatching(
      sourceId,
      scope,
      chunk => chunk.sourceGeneration !== activeGeneration,
      true,
    );
    return Math.max(enterpriseRemoved, legacyRemoved);
  }

  countKnowledgeSourceGenerationChunks(
    sourceId: string,
    sourceGeneration: string,
    scope?: KnowledgeScope,
  ): number {
    if (enterpriseKnowledgeStoreEnabled()) {
      return countScopedRagRecords(scope, {
        knowledgeSourceId: sourceId,
        sourceGeneration,
        scopeFingerprint: privateKnowledgeScopeFingerprint(scope),
      });
    }
    return this.listChunks({scope}).filter(chunk =>
      chunk.knowledgeSourceId === sourceId &&
      chunk.registryOrigin === 'external_knowledge_registry' &&
      chunk.sourceGeneration === sourceGeneration).length;
  }

  private removeKnowledgeSourceChunksMatching(
    sourceId: string,
    scope: KnowledgeScope | undefined,
    shouldRemove: (chunk: RagChunk) => boolean,
    skipEnterprise = false,
  ): number {
    const removedIds = new Set<string>();
    if (enterpriseKnowledgeDbWritesEnabled() && !skipEnterprise) {
      const chunks = listScopedKnowledgeRecords<RagChunk>(
        KNOWLEDGE_KIND,
        scope,
        {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
      ).map(row => row.record);
      const enterpriseChunkIds = chunks.filter(chunk => {
        if (
          chunk.knowledgeSourceId !== sourceId ||
          !privateKnowledgeVisibleInScope(chunk, scope) ||
          !shouldRemove(chunk)
        ) return false;
        return true;
      }).map(chunk => chunk.chunkId);
      if (enterpriseChunkIds.length > 0) {
        removeScopedKnowledgeRecords(KNOWLEDGE_KIND, enterpriseChunkIds, scope);
        for (const chunkId of enterpriseChunkIds) removedIds.add(chunkId);
      }
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.load();
      let changed = false;
      for (const [chunkId, chunk] of this.chunks) {
        if (
          chunk.knowledgeSourceId !== sourceId ||
          !privateKnowledgeVisibleInScope(chunk, scope) ||
          !shouldRemove(chunk)
        ) continue;
        this.deleteLocalChunk(chunkId);
        this.pendingDeletes.add(chunkId);
        this.pendingUpserts.delete(chunkId);
        removedIds.add(chunkId);
        changed = true;
      }
      if (changed) this.persist();
    }
    return removedIds.size;
  }

  /** Get a chunk by id, or undefined when absent. */
  getChunk(chunkId: string, scope?: KnowledgeScope): RagChunk | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      const chunk = getScopedKnowledgeRecord<RagChunk>(
        KNOWLEDGE_KIND,
        chunkId,
        scope,
      )?.record;
      return chunk && privateKnowledgeVisibleInScope(chunk, scope) ? chunk : undefined;
    }
    this.load();
    const chunk = this.chunks.get(chunkId);
    return chunk && privateKnowledgeVisibleInScope(chunk, scope) ? chunk : undefined;
  }

  /** List chunks for rebuild/maintenance callers without changing search semantics. */
  listChunks(opts: RagStoreListOptions = {}): RagChunk[] {
    const enterpriseStore = enterpriseKnowledgeStoreEnabled();
    if (!enterpriseStore) this.load();
    let chunks = enterpriseStore
      ? listScopedKnowledgeRecords<RagChunk>(
          KNOWLEDGE_KIND,
          opts.scope,
          {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
        ).map(row => row.record)
      : Array.from(this.chunks.values());
    chunks = chunks.filter(chunk => privateKnowledgeVisibleInScope(chunk, opts.scope));
    if (opts.kind) chunks = chunks.filter(chunk => chunk.kind === opts.kind);
    if (opts.registryOrigin) {
      chunks = chunks.filter(chunk => chunk.registryOrigin === opts.registryOrigin);
    }
    const uriPrefix = opts.uriPrefix;
    if (uriPrefix) {
      chunks = chunks.filter(chunk => chunk.uri.startsWith(uriPrefix));
    }
    chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    return chunks;
  }

  /** Per-kind chunk counts plus the freshest indexedAt seen for each. */
  getStats(scope?: KnowledgeScope): RagStoreStats {
    const enterpriseStore = enterpriseKnowledgeStoreEnabled();
    if (!enterpriseStore) this.load();
    const stats = emptyStats();
    if (enterpriseStore) {
      for (const row of getScopedRagStats(scope, privateKnowledgeScopeFingerprint(scope))) {
        if (!ALL_RAG_SOURCE_KINDS.includes(row.kind as RagSourceKind)) continue;
        stats[row.kind as RagSourceKind] = {
          chunkCount: row.chunkCount,
          ...(row.lastIndexedAt === undefined ? {} : {lastIndexedAt: row.lastIndexedAt}),
        };
      }
      return stats;
    }
    const chunks = enterpriseStore
      ? listScopedKnowledgeRecords<RagChunk>(
          KNOWLEDGE_KIND,
          scope,
          {rowScopePrefix: RAG_ROW_SCOPE_PREFIX, includeSystem: true},
        ).map(row => row.record)
      : Array.from(this.chunks.values());
    for (const c of chunks.filter(chunk => privateKnowledgeVisibleInScope(chunk, scope))) {
      const s = stats[c.kind];
      s.chunkCount++;
      if (s.lastIndexedAt === undefined || c.indexedAt > s.lastIndexedAt) {
        s.lastIndexedAt = c.indexedAt;
      }
    }
    return stats;
  }

  /**
   * Keyword search. Hits are ranked by token-overlap fraction relative
   * to the query token set. Chunks carrying `unsupportedReason` are
   * excluded — they live on for audit but the agent must not see them.
   *
   * Three retrieval-level failure modes carry an `unsupportedReason`:
   * (1) the index is empty; (2) every chunk in the probed kinds is
   * blocked / out of scope; the third — a legitimate zero-match query —
   * intentionally returns an empty `results` array with NO
   * `unsupportedReason`, so the agent can tell "I didn't find anything"
   * apart from "the infrastructure refused to answer".
   */
  search(query: string, opts: RagStoreSearchOptions = {}): RagRetrievalResult {
    const topK = normalizeRagSearchInput(query, opts);
    const kindFilter = opts.kinds ? new Set(opts.kinds) : null;
    const enterpriseSearchEnabled = enterpriseKnowledgeStoreEnabled();
    if (!enterpriseSearchEnabled) {
      try {
        this.load();
      } catch (error) {
        if (!(error instanceof LocalRagStorageBudgetError)) throw error;
        const unsupportedReason = `${error.code}: ${error.message}; ` +
          'reduce or quarantine the local knowledge store, or enable the enterprise knowledge store';
        return {
          ...makeSparkProvenance({source: 'ragStore.search', unsupportedReason}),
          query,
          results: [],
          probed: opts.kinds ? [...opts.kinds] : [...ALL_RAG_SOURCE_KINDS],
          retrievedAt: Date.now(),
        };
      }
    }
    const codebaseSelectionRequested = opts.codebaseIds !== undefined;
    const knowledgeSelectionRequested = opts.knowledgeSourceIds !== undefined;
    const enterpriseSelection = codebaseSelectionRequested && knowledgeSelectionRequested
      ? 'none'
      : codebaseSelectionRequested
        ? 'codebase'
        : knowledgeSelectionRequested
          ? 'knowledge'
          : 'public';
    const enterpriseSearch = enterpriseSearchEnabled
      ? searchScopedRagKnowledgeRecords<RagChunk>(KNOWLEDGE_KIND, opts.scope, {
          rowScopes: opts.kinds?.map(ragRowScope),
          selection: enterpriseSelection,
          codebaseGenerations: opts.codebaseIds?.flatMap(id => {
            const generation = opts.activeCodebaseGenerations?.[id];
            return generation ? [{id, generation}] : [];
          }),
          knowledgeSourceGenerations: opts.knowledgeSourceIds?.flatMap(id => {
            const generation = opts.activeSourceGenerations?.[id];
            return generation ? [{id, generation}] : [];
          }),
          scopeFingerprint: privateKnowledgeScopeFingerprint(opts.scope),
          queryTokens: tokenizeRagText(query),
          candidateLimit: Math.max(200, Math.min(2_000, topK * 50)),
          vendor: opts.vendor,
          buildId: opts.buildId,
          pathPrefix: opts.pathPrefix,
          symbolExact: opts.symbolExact,
          filePathExact: opts.filePathExact,
          languages: opts.languages?.filter((language): language is NonNullable<RagChunk['language']> =>
            Boolean(language)),
          includeSystem: true,
        })
      : undefined;
    const chunks = enterpriseSearch
      ? enterpriseSearch.records.map(row => row.record)
      : Array.from(this.chunks.values());
    const codebaseFilter = opts.codebaseIds ? new Set(opts.codebaseIds) : null;
    const knowledgeSourceFilter = opts.knowledgeSourceIds
      ? new Set(opts.knowledgeSourceIds)
      : null;
    const languageFilter = opts.languages ? new Set(opts.languages) : null;

    const probed = opts.kinds
      ? [...opts.kinds]
      : enterpriseSearch
        ? [...ALL_RAG_SOURCE_KINDS]
        : Array.from(new Set(chunks.map(c => c.kind)));

    const queryTokens = new Set(tokenizeRagText(query));
    const candidates: Array<{chunk: RagChunk; score: number; tier: number}> = [];
    let eligibleSeen = 0;
    let eligibleBytes = 0;

    for (const chunk of chunks) {
      if (!privateKnowledgeVisibleInScope(chunk, opts.scope)) continue;
      if (isExternalPrivateKnowledgeChunk(chunk) && !knowledgeSourceFilter) continue;
      if (chunk.registryOrigin === 'codebase_registry') {
        const activeGeneration = chunk.codebaseId
          ? opts.activeCodebaseGenerations?.[chunk.codebaseId]
          : undefined;
        if (!activeGeneration) continue;
        if (chunk.sourceGeneration && chunk.sourceGeneration !== activeGeneration) continue;
        if (!chunk.sourceGeneration && activeGeneration !== 'codebase_1') continue;
      }
      if (kindFilter && !kindFilter.has(chunk.kind)) continue;
      if (chunk.unsupportedReason) continue;
      if (codebaseFilter && (!chunk.codebaseId || !codebaseFilter.has(chunk.codebaseId))) continue;
      if (
        knowledgeSourceFilter &&
        (!chunk.knowledgeSourceId || !knowledgeSourceFilter.has(chunk.knowledgeSourceId))
      ) continue;
      if (knowledgeSourceFilter && chunk.knowledgeSourceId) {
        const activeGeneration = opts.activeSourceGenerations?.[chunk.knowledgeSourceId];
        if (!activeGeneration || chunk.sourceGeneration !== activeGeneration) continue;
      }
      if (opts.vendor && chunk.vendor !== opts.vendor) continue;
      if (opts.buildId && chunk.buildId !== opts.buildId) continue;
      if (opts.pathPrefix && !(chunk.filePath ?? chunk.uri).startsWith(opts.pathPrefix)) continue;
      if (opts.symbolExact && chunk.symbol !== opts.symbolExact) continue;
      if (opts.filePathExact && (chunk.filePath ?? chunk.uri) !== opts.filePathExact) continue;
      if (languageFilter && (!chunk.language || !languageFilter.has(chunk.language))) continue;
      eligibleSeen++;
      if (!enterpriseSearch) {
        eligibleBytes += Buffer.byteLength([
          chunk.snippet,
          chunk.title ?? '',
          chunk.symbol ?? '',
          chunk.filePath ?? '',
        ].join('\0'), 'utf8');
        if (
          eligibleSeen > this.localSearchMaxChunks ||
          eligibleBytes > this.localSearchMaxBytes
        ) {
          const unsupportedReason =
            'local_rag_search_budget_exceeded: selected knowledge exceeds the local JSON search budget; ' +
            'select fewer codebases/knowledge sources or enable the enterprise knowledge store';
          return {
            ...makeSparkProvenance({source: 'ragStore.search', unsupportedReason}),
            query,
            results: [],
            probed,
            retrievedAt: Date.now(),
          };
        }
      }
      const chunkTokens = new Set([
        ...tokenizeRagText(chunk.snippet),
        ...tokenizeRagText(chunk.title ?? ''),
        ...tokenizeRagText(chunk.symbol ?? ''),
        ...tokenizeRagText(chunk.filePath ?? ''),
      ]);
      let overlap = 0;
      for (const t of queryTokens) {
        if (chunkTokens.has(t)) overlap++;
      }
      const exactSymbol = Boolean(opts.symbolExact && chunk.symbol === opts.symbolExact);
      const exactFile = Boolean(opts.filePathExact && (chunk.filePath ?? chunk.uri) === opts.filePathExact);
      const pathPrefix = Boolean(opts.pathPrefix && (chunk.filePath ?? chunk.uri).startsWith(opts.pathPrefix));
      const tier = exactSymbol || exactFile ? 3 : pathPrefix ? 2 : 1;
      if (overlap === 0 && tier === 1) continue;
      const score = overlap / Math.max(queryTokens.size, 1);
      candidates.push({chunk, score, tier});
    }

    candidates.sort((a, b) => (b.tier - a.tier) || (b.score - a.score));
    const top = candidates.slice(0, topK);
    const results: RagRetrievalHit[] = top.map(c => ({
      chunkId: c.chunk.chunkId,
      score: c.score,
      chunk: c.chunk,
    }));

    let unsupportedReason: string | undefined;
    const indexEmpty = enterpriseSearch
      ? !enterpriseSearch.indexHasRows
      : chunks.length === 0;
    const noEligibleChunks = enterpriseSearch
      ? !enterpriseSearch.eligibleHasRows
      : eligibleSeen === 0;
    if (indexEmpty) {
      unsupportedReason = 'index empty';
    } else if (noEligibleChunks) {
      // Either every chunk in the probed kinds is blocked, or the kind
      // filter excluded every chunk. Both deserve a clear signal so the
      // agent does not invent content.
      unsupportedReason = kindFilter
        ? 'no eligible chunks for the requested kinds'
        : 'all chunks blocked by unsupportedReason';
    }
    // legitimate zero-match (eligibleSeen > 0, results empty) gets no
    // unsupportedReason — the index works, the query just didn't hit.

    return {
      ...makeSparkProvenance({
        source: 'ragStore.search',
        ...(unsupportedReason ? {unsupportedReason} : {}),
      }),
      query,
      results,
      probed,
      retrievedAt: Date.now(),
    };
  }

  /** Flush in-memory chunks to disk. Call once after a bulk ingest loop. */
  flush(): void {
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.persist();
    }
  }

  /** Atomic write: temp file + rename so a crashed process leaves the
   * existing on-disk file intact. */
  private persist(): void {
    withFilesystemRegistryLock(
      this.storagePath,
      'rag_store_busy',
      () => this.persistUnlocked(),
    );
  }

  private persistUnlocked(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const merged = new Map<string, RagChunk>();
    if (fs.existsSync(this.storagePath)) {
      try {
        this.assertStorageFileWithinBudget();
        const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8')) as StorageEnvelope;
        if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.chunks)) {
          throw new Error('unsupported_schema');
        }
        this.assertChunkCountWithinBudget(parsed.chunks.length);
        for (const chunk of parsed.chunks) merged.set(chunk.chunkId, backfillChunk(chunk));
      } catch (error) {
        if (error instanceof LocalRagStorageBudgetError) throw error;
        throw new Error(
          `rag_store_invalid_storage_requires_recovery:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const chunkId of this.pendingDeletes) merged.delete(chunkId);
    for (const chunkId of this.pendingUpserts) {
      const chunk = this.chunks.get(chunkId);
      if (chunk) merged.set(chunkId, chunk);
    }
    const serialized = this.serializeWithinStorageBudget(Array.from(merged.values()));
    this.chunks.clear();
    for (const [chunkId, chunk] of merged) this.chunks.set(chunkId, chunk);
    this.rebuildSerializedChunkAccounting();
    // Per-process unique tmp suffix — Codex round E P1#5 cross-process
    // collision guard. Single-process is the documented contract, but a
    // unique suffix costs nothing and removes the foot-gun.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, serialized, 'utf-8');
    fs.renameSync(tmp, this.storagePath);
    this.loadedStorageSignature = this.storageSignature();
    this.pendingUpserts.clear();
    this.pendingDeletes.clear();
  }
}

class LocalRagStorageBudgetError extends Error {
  readonly code = 'local_rag_storage_budget_exceeded';

  constructor(detail: string) {
    super(detail);
    this.name = 'LocalRagStorageBudgetError';
  }
}

export class RagSearchInputError extends Error {
  readonly code = 'invalid_rag_search_input';

  constructor(detail: string) {
    super(detail);
    this.name = 'RagSearchInputError';
  }
}

export function validateRagSearchInput(query: string, opts: RagStoreSearchOptions): void {
  normalizeRagSearchInput(query, opts);
}

function normalizeRagSearchInput(query: string, opts: RagStoreSearchOptions): number {
  if (typeof query !== 'string' || !query.trim()) {
    throw new RagSearchInputError('query must be a non-empty string');
  }
  if (Buffer.byteLength(query, 'utf8') > MAX_RAG_SEARCH_QUERY_BYTES) {
    throw new RagSearchInputError(
      `query exceeds the ${MAX_RAG_SEARCH_QUERY_BYTES}-byte search limit`,
    );
  }
  for (const [name, value] of Object.entries({
    kinds: opts.kinds,
    codebaseIds: opts.codebaseIds,
    languages: opts.languages,
    knowledgeSourceIds: opts.knowledgeSourceIds,
  })) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new RagSearchInputError(`${name} must be an array`);
    }
    if (value.length > MAX_RAG_SEARCH_FILTER_ITEMS) {
      throw new RagSearchInputError(
        `${name} exceeds the ${MAX_RAG_SEARCH_FILTER_ITEMS}-item search limit`,
      );
    }
  }

  const requestedTopK = opts.topK ?? 5;
  if (!Number.isFinite(requestedTopK) || !Number.isInteger(requestedTopK) || requestedTopK < 1) {
    throw new RagSearchInputError('topK must be a positive integer');
  }
  return Math.min(requestedTopK, MAX_RAG_SEARCH_TOP_K);
}

/** Whether the given source kind needs a `license` field at ingest time. */
export function ragStoreRequiresLicense(kind: RagSourceKind): boolean {
  return LICENSE_REQUIRED_KINDS.has(kind);
}

let defaultRagStore: RagStore | undefined;

/** Process-wide store shared by admin ingestion and runtime retrieval. */
export function getDefaultRagStore(): RagStore {
  defaultRagStore ??= new RagStore(backendLogPath('rag_store.json'));
  return defaultRagStore;
}

function ragRowScope(kind: RagSourceKind): string {
  return `${RAG_ROW_SCOPE_PREFIX}${kind}`;
}
