// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RagStore} from '../ragStore';
import type {RagChunk} from '../../types/sparkContracts';
import {
  codebaseScopeFromRef,
  type CodebaseIngestLeaseGuard,
  type CodebaseRef,
  type CodebaseRegistry,
  type CodebaseScope,
} from '../codebase/codebaseRegistry';
import {PathSecurityGate, readAcceptedTextFileSync} from '../codebase/pathSecurityGate';
import {redactSecrets} from '../security/secretPatterns';
import {
  chunkSourceBySymbols,
  estimateTokenCount,
  languageForPath,
  stableChunkId,
} from './baseIngester';
import {
  assertCodebaseRootIdentity,
  assertSourceFileUnchanged,
  inspectSourceGeneration,
  isCodebaseIngestLeaseLost,
  isSourceChunkLimitExceeded,
  previewRegisteredCodebaseRoot,
  resolveMaxChunkChars,
  resolveMaxSourceChunks,
  resolveSourcePathPrefix,
  selectCodebasePreviewFiles,
  SOURCE_INGEST_WRITE_BATCH_SIZE,
  type SourceGenerationProvenance,
} from './sourceFileSelection';

const DEFAULT_MAX_CHUNK_CHARS = 1800;
const UNKNOWN_LICENSE = 'UNKNOWN';

export interface KernelSourceIngestOptions {
  maxChunkChars?: number;
  maxChunks?: number;
  pathPrefix?: string;
  scope?: CodebaseScope;
}

export interface KernelSourceIngestError {
  filePath: string;
  reason: string;
}

export interface KernelSourceIngestResult {
  codebaseId: string;
  filesProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  blockedFileCount: number;
  redactionHitCount: number;
  errors: KernelSourceIngestError[];
}

function spdxLicense(content: string): string | undefined {
  const header = content.split(/\r?\n/).slice(0, 12).join('\n');
  const match = header.match(/SPDX-License-Identifier:\s*([A-Za-z0-9+_.()-]+(?:\s+(?:WITH|OR|AND)\s+[A-Za-z0-9+_.()-]+)*)/);
  return match?.[1]?.trim();
}

export class KernelSourceIngester {
  constructor(
    private readonly store: RagStore,
    private readonly registry: CodebaseRegistry,
    private readonly gate: PathSecurityGate = new PathSecurityGate(),
  ) {}

  async ingest(codebaseId: string, opts: KernelSourceIngestOptions = {}): Promise<KernelSourceIngestResult> {
    const ref = this.registry.get(codebaseId, opts.scope);
    if (!ref) {
      throw new Error(`Codebase '${codebaseId}' not found`);
    }
    if (ref.kind !== 'kernel_source') {
      throw new Error(`Codebase '${codebaseId}' is kind=${ref.kind}; kernel ingestion requires kernel_source`);
    }
    if (!ref.vendor) {
      throw new Error(`Kernel codebase '${codebaseId}' requires vendor`);
    }
    const pathPrefix = resolveSourcePathPrefix(opts.pathPrefix);
    if ((ref.pathFilters ?? []).length === 0 && !pathPrefix) {
      throw new Error(`Kernel codebase '${codebaseId}' requires pathFilters or pathPrefix`);
    }
    const effectiveScope = codebaseScopeFromRef(ref);
    return this.registry.withIngestLease(codebaseId, effectiveScope, lease =>
      this.ingestWithLease(codebaseId, ref, effectiveScope, opts, lease));
  }

  private async ingestWithLease(
    codebaseId: string,
    ref: CodebaseRef,
    effectiveScope: Required<CodebaseScope>,
    opts: KernelSourceIngestOptions,
    lease: CodebaseIngestLeaseGuard,
  ): Promise<KernelSourceIngestResult> {
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

    const preview = await previewRegisteredCodebaseRoot(this.gate, ref);
    lease.assertHeld();
    if (preview.blocked) {
      lease.updateIngestStatus({
        lastIngestStatus: 'blocked_by_security',
        lastIngestAt: Date.now(),
        lastIngestError: preview.blockedReason,
        blockedFileCount: preview.skippedFileCount,
      });
      return {
        codebaseId,
        filesProcessed: 0,
        chunksAdded: 0,
        chunksSkipped: 0,
        blockedFileCount: preview.skippedFileCount,
        redactionHitCount: 0,
        errors: [{filePath: ref.displayName, reason: preview.blockedReason ?? 'blocked'}],
      };
    }
    try {
      assertCodebaseRootIdentity(ref.rootRealpath, preview.rootRealpath);
    } catch (error) {
      lease.updateIngestStatus({
        lastIngestStatus: 'blocked_by_security',
        lastIngestAt: Date.now(),
        lastIngestError: 'codebase_root_realpath_drift',
        blockedFileCount: preview.skippedFileCount,
      });
      throw error;
    }

    const result: KernelSourceIngestResult = {
      codebaseId,
      filesProcessed: 0,
      chunksAdded: 0,
      chunksSkipped: 0,
      blockedFileCount: preview.skippedFileCount,
      redactionHitCount: 0,
      errors: [],
    };
    const maxChars = resolveMaxChunkChars(opts.maxChunkChars, DEFAULT_MAX_CHUNK_CHARS);
    const maxChunks = resolveMaxSourceChunks(opts.maxChunks);
    const pathPrefix = resolveSourcePathPrefix(opts.pathPrefix);
    const selectedFiles = selectCodebasePreviewFiles(preview, ref, pathPrefix);
    const sourceReadLimits = this.gate.getSourceReadLimits();
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
        const license = ref.licenseTag ?? spdxLicense(content);
        const chunks = chunkSourceBySymbols(content, maxChars);
        if (chunks.length === 0) {
          result.chunksSkipped++;
          continue;
        }
        if (result.chunksAdded + chunks.length > maxChunks) {
          throw new Error(`source_chunk_limit_exceeded:${maxChunks}`);
        }
        for (const chunk of chunks) {
          lease.assertHeld();
          const redaction = redactSecrets(chunk.text);
          result.redactionHitCount += redaction.redactedCount;
          const chunkId = stableChunkId([
            codebaseId,
            nextIndexGeneration,
            lease.operationId,
            file.relativePath,
            chunk.startLine,
          ]);
          stagedChunks.push({
            chunkId,
            kind: 'kernel_source',
            uri: `codebase://${codebaseId}/${file.relativePath}`,
            title: file.relativePath.split('/').pop(),
            snippet: redaction.text,
            tokenCount: estimateTokenCount(redaction.text),
            license: license ?? UNKNOWN_LICENSE,
            indexedAt: Date.now(),
            filePath: file.relativePath,
            lineRange: {start: chunk.startLine, end: chunk.endLine},
            ...(chunk.symbol ? {symbol: chunk.symbol} : {}),
            language: languageForPath(file.relativePath),
            ...(provenance.indexedRevision ? {commitHash: provenance.indexedRevision} : {}),
            contentFingerprint: provenance.contentFingerprint,
            sourceDirty: provenance.sourceDirty,
            commitProvenance: provenance.commitProvenance,
            vendor: ref.vendor,
            ...(ref.buildId ? {buildId: ref.buildId} : {}),
            codebaseId,
            registryOrigin: 'codebase_registry',
            sourceGeneration,
            ...(!license ? {unsupportedReason: 'license_unknown'} : {}),
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
      lease.activateIndexGeneration(ref.indexGeneration, {
        lastIngestStatus: 'ok',
        lastIngestAt: Date.now(),
        lastIngestError: undefined,
        chunkCount: result.chunksAdded,
        blockedFileCount: result.blockedFileCount,
        redactionHitCount: result.redactionHitCount,
        activeGeneration: sourceGeneration,
        contentFingerprint: provenance.contentFingerprint,
        indexedRevision: provenance.indexedRevision,
        indexedDirty: provenance.sourceDirty,
        commitProvenance: provenance.commitProvenance,
      });
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
      this.store.removeCodebaseChunksExceptGeneration(codebaseId, sourceGeneration, effectiveScope);
    } catch (error) {
      const reason = `inactive_chunk_cleanup_failed:${error instanceof Error ? error.message : String(error)}`;
      result.errors.push({filePath: ref.displayName, reason});
      lease.updateIngestStatus({
        lastIngestStatus: 'partial',
        lastIngestAt: Date.now(),
        lastIngestError: reason,
      });
    }
    return result;
  }
}

export const __TEST_ONLY__ = {
  spdxLicense,
  filterPreviewFiles: selectCodebasePreviewFiles,
};
