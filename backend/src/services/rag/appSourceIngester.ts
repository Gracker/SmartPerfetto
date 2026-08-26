// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {RagStore} from '../ragStore';
import type {RagChunk} from '../../types/sparkContracts';
import {redactSecrets} from '../security/secretPatterns';
import {
  codebaseScopeFromRef,
  codebaseHasActiveIndex,
  type CodebaseIngestLeaseGuard,
  type CodebaseRef,
  type CodebaseRegistry,
  type CodebaseScope,
} from '../codebase/codebaseRegistry';
import {PathSecurityGate, readAcceptedTextFileSync} from '../codebase/pathSecurityGate';
import {SourceEnumerator} from '../codebase/sourceEnumerator';
import {
  chunkSourceBySymbols,
  detectSourceSymbol,
  estimateTokenCount,
  languageForPath,
  stableChunkId,
} from './baseIngester';
import {
  assertSourceFileUnchanged,
  enumerateRegisteredCodebaseRoot,
  inspectSourceGeneration,
  isCodebaseIngestLeaseLost,
  isSourceChunkLimitExceeded,
  resolveMaxChunkChars,
  resolveMaxSourceChunks,
  resolveSourcePathPrefix,
  selectEnumeratedSourceFiles,
  SOURCE_INGEST_WRITE_BATCH_SIZE,
  type SourceGenerationProvenance,
} from './sourceFileSelection';

const DEFAULT_MAX_CHUNK_CHARS = 2200;

export interface AppSourceIngestOptions {
  maxChunkChars?: number;
  maxChunks?: number;
  pathPrefix?: string;
  scope?: CodebaseScope;
}

export interface AppSourceIngestError {
  filePath: string;
  reason: string;
}

export interface AppSourceIngestResult {
  codebaseId: string;
  filesProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  blockedFileCount: number;
  redactionHitCount: number;
  errors: AppSourceIngestError[];
}

function makeChunkId(
  codebaseId: string,
  indexGeneration: number,
  operationId: string,
  relativePath: string,
  startLine: number,
): string {
  return createHash('sha256')
    .update(`${codebaseId}|${indexGeneration}|${operationId}|${relativePath}|${startLine}`)
    .digest('hex')
    .slice(0, 16);
}

const chunkSource = chunkSourceBySymbols;

export class AppSourceIngester {
  constructor(
    private readonly store: RagStore,
    private readonly registry: CodebaseRegistry,
    private readonly gate: PathSecurityGate = new PathSecurityGate(),
    private readonly enumerator: SourceEnumerator = new SourceEnumerator(),
  ) {}

  async ingest(codebaseId: string, opts: AppSourceIngestOptions = {}): Promise<AppSourceIngestResult> {
    const ref = this.registry.get(codebaseId, opts.scope);
    if (!ref) {
      throw new Error(`Codebase '${codebaseId}' not found`);
    }
    if (ref.kind !== 'app_source') {
      throw new Error(`Codebase '${codebaseId}' is kind=${ref.kind}; app source ingestion requires app_source`);
    }
    const effectiveScope = codebaseScopeFromRef(ref);
    return this.registry.withIngestLease(codebaseId, effectiveScope, lease =>
      this.ingestWithLease(codebaseId, ref, effectiveScope, opts, lease));
  }

  private async ingestWithLease(
    codebaseId: string,
    ref: CodebaseRef,
    effectiveScope: Required<CodebaseScope>,
    opts: AppSourceIngestOptions,
    lease: CodebaseIngestLeaseGuard,
  ): Promise<AppSourceIngestResult> {
    lease.assertHeld();
    const nextIndexGeneration = ref.indexGeneration + 1;
    const stagedChunkIds: string[] = [];
    const stagedChunks: RagChunk[] = [];
    const flushStagedChunks = (): void => {
      if (stagedChunks.length === 0) return;
      lease.assertHeld();
      const batch = stagedChunks.splice(0, SOURCE_INGEST_WRITE_BATCH_SIZE);
      this.store.addChunks(batch, effectiveScope);
    };

    let enumeration;
    try {
      enumeration = await enumerateRegisteredCodebaseRoot(this.gate, ref, this.enumerator);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lease.updateIngestStatus({
        lastIngestStatus: 'blocked_by_security',
        lastIngestAt: Date.now(),
        lastIngestError: reason,
        blockedFileCount: 0,
      });
      if (reason === 'codebase_root_realpath_drift') throw error;
      return {
        codebaseId,
        filesProcessed: 0,
        chunksAdded: 0,
        chunksSkipped: 0,
        blockedFileCount: 0,
        redactionHitCount: 0,
        errors: [{filePath: ref.displayName, reason}],
      };
    }
    lease.assertHeld();
    if (!enumeration.enumerationComplete || !enumeration.deterministic) {
      const reason = enumeration.incompleteReason ?? 'source_enumeration_incomplete';
      lease.updateIngestStatus({
        lastIngestStatus: 'failed',
        lastIngestAt: Date.now(),
        lastIngestError: reason,
        blockedFileCount: enumeration.skippedCount,
      });
      throw new Error(`codebase_reindex_incomplete:${reason}`);
    }

    const maxChars = resolveMaxChunkChars(opts.maxChunkChars, DEFAULT_MAX_CHUNK_CHARS);
    const maxChunks = resolveMaxSourceChunks(opts.maxChunks);
    const pathPrefix = resolveSourcePathPrefix(opts.pathPrefix);
    const sourceReadLimits = this.gate.getSourceReadLimits();
    const selection = selectEnumeratedSourceFiles(
      enumeration,
      ref,
      pathPrefix,
      maxChunks,
      sourceReadLimits.maxTotalBytes,
    );
    const selectedFiles = selection.files;
    let provenance: SourceGenerationProvenance;
    try {
      provenance = await inspectSourceGeneration(
        ref.rootRealpath,
        selectedFiles,
        (root, relativePath) => {
          lease.assertHeld();
          return readAcceptedTextFileSync(root, relativePath, sourceReadLimits.maxFileBytes);
        },
        sourceReadLimits.maxTotalBytes,
      );
    } catch (error) {
      if (isCodebaseIngestLeaseLost(error)) throw error;
      const ingestError = new Error('codebase_reindex_incomplete:1_file_errors');
      lease.updateIngestStatus({
        lastIngestStatus: 'failed',
        lastIngestAt: Date.now(),
        lastIngestError: `${ingestError.message}:${error instanceof Error ? error.message : String(error)}`,
      });
      throw ingestError;
    }
    const sourceGeneration = `codebase_${nextIndexGeneration}_${provenance.contentFingerprint.slice(0, 16)}_${stableChunkId([lease.operationId], 12)}`;
    const result: AppSourceIngestResult = {
      codebaseId,
      filesProcessed: 0,
      chunksAdded: 0,
      chunksSkipped: 0,
      blockedFileCount: enumeration.skippedCount,
      redactionHitCount: 0,
      errors: [],
    };

    for (const file of selectedFiles) {
      result.filesProcessed++;
      await new Promise<void>(r => setImmediate(r));
      try {
        lease.assertHeld();
        const content = readAcceptedTextFileSync(
          ref.rootRealpath,
          file.relativePath,
          sourceReadLimits.maxFileBytes,
        );
        assertSourceFileUnchanged(provenance, file.relativePath, content);
        const chunks = chunkSource(content, maxChars);
        if (chunks.length === 0) {
          result.chunksSkipped++;
          continue;
        }
        for (const chunk of chunks) {
          lease.assertHeld();
          const redaction = redactSecrets(chunk.text);
          result.redactionHitCount += redaction.redactedCount;
          const chunkId = makeChunkId(
            codebaseId,
            nextIndexGeneration,
            lease.operationId,
            file.relativePath,
            chunk.startLine,
          );
          stagedChunks.push({
            chunkId,
            kind: 'app_source',
            uri: `codebase://${codebaseId}/${file.relativePath}`,
            title: file.relativePath.split('/').pop(),
            snippet: redaction.text,
            tokenCount: estimateTokenCount(redaction.text),
            indexedAt: Date.now(),
            filePath: file.relativePath,
            lineRange: {start: chunk.startLine, end: chunk.endLine},
            ...(chunk.symbol ? {symbol: chunk.symbol} : {}),
            language: languageForPath(file.relativePath),
            ...(provenance.indexedRevision ? {commitHash: provenance.indexedRevision} : {}),
            contentFingerprint: provenance.contentFingerprint,
            sourceDirty: provenance.sourceDirty,
            commitProvenance: provenance.commitProvenance,
            ...(ref.vendor ? {vendor: ref.vendor} : {}),
            ...(ref.buildId ? {buildId: ref.buildId} : {}),
            codebaseId,
            registryOrigin: 'codebase_registry',
            sourceGeneration,
          });
          stagedChunkIds.push(chunkId);
          result.chunksAdded++;
          if (stagedChunks.length >= SOURCE_INGEST_WRITE_BATCH_SIZE) {
            flushStagedChunks();
          }
        }
      } catch (error) {
        if (isCodebaseIngestLeaseLost(error)) {
          this.store.removeCodebaseChunkIds(codebaseId, stagedChunkIds, effectiveScope);
          throw error;
        }
        if (isSourceChunkLimitExceeded(error)) {
          this.store.removeCodebaseChunkIds(codebaseId, stagedChunkIds, effectiveScope);
          lease.updateIngestStatus({
            lastIngestStatus: 'failed',
            lastIngestAt: Date.now(),
            lastIngestError: error.message,
          });
          throw error;
        }
        result.chunksSkipped++;
        result.errors.push({
          filePath: file.relativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      if (result.filesProcessed === 0) throw new Error('source_selection_empty');
      if (result.chunksAdded === 0) throw new Error('source_generation_empty');
      if (result.errors.length > 0) {
        throw new Error(`codebase_reindex_incomplete:${result.errors.length}_file_errors`);
      }
      while (stagedChunks.length > 0) flushStagedChunks();
      this.store.flush();
      lease.assertHeld();
      const stagedCount = this.store.countCodebaseGenerationChunks(
        codebaseId,
        sourceGeneration,
        effectiveScope,
      );
      if (stagedCount !== result.chunksAdded) {
        throw new Error(`staged_chunk_count_mismatch:${stagedCount}:${result.chunksAdded}`);
      }
      const coverage = {...selection.coverage, chunksIndexed: result.chunksAdded};
      const keepExistingComplete = coverage.truncated &&
        codebaseHasActiveIndex(ref) &&
        (ref.activeIndexCoverage?.complete ?? true);
      if (keepExistingComplete) {
        this.registry.setPendingGeneration(codebaseId, effectiveScope, ref.indexGeneration, {
          candidateGenerationId: sourceGeneration,
          coverage,
          contentFingerprint: provenance.contentFingerprint,
          chunkCount: result.chunksAdded,
          createdAt: Date.now(),
          indexedRevision: provenance.indexedRevision,
          indexedDirty: provenance.sourceDirty,
          commitProvenance: provenance.commitProvenance,
        });
      } else {
        lease.activateIndexGeneration(ref.indexGeneration, {
        lastIngestStatus: 'ok',
        lastIngestAt: Date.now(),
        lastIngestError: undefined,
        chunkCount: result.chunksAdded,
        blockedFileCount: result.blockedFileCount,
        redactionHitCount: result.redactionHitCount,
        activeGeneration: sourceGeneration,
        activeIndexCoverage: coverage,
        lastAttemptCoverage: coverage,
        contentFingerprint: provenance.contentFingerprint,
        indexedRevision: provenance.indexedRevision,
        indexedDirty: provenance.sourceDirty,
        commitProvenance: provenance.commitProvenance,
        });
      }
    } catch (error) {
      this.store.removeCodebaseChunkIds(codebaseId, stagedChunkIds, effectiveScope);
      if (!isCodebaseIngestLeaseLost(error)) {
        lease.updateIngestStatus({
          lastIngestStatus: 'failed',
          lastIngestAt: Date.now(),
          lastIngestError: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    try {
      lease.assertHeld();
      const current = this.registry.get(codebaseId, effectiveScope);
      const preserved = [current?.activeGeneration, current?.pendingGeneration?.candidateGenerationId]
        .filter((generation): generation is string => Boolean(generation));
      this.store.removeCodebaseChunksExceptGeneration(codebaseId, preserved, effectiveScope);
    } catch (error) {
      const reason = `inactive_chunk_cleanup_failed:${error instanceof Error ? error.message : String(error)}`;
      result.errors.push({filePath: ref.displayName, reason});
      lease.updateIngestStatus({
        lastIngestStatus: 'ok',
        lastIngestAt: Date.now(),
        lastIngestError: reason,
        maintenanceWarning: 'inactive_chunk_cleanup_failed',
      });
    }
    return result;
  }
}

export const __TEST_ONLY__ = {
  chunkSource,
  detectSymbol: detectSourceSymbol,
  makeChunkId,
  languageFor: languageForPath,
};
