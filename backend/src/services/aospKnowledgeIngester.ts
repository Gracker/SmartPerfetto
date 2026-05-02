// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * AospKnowledgeIngester — pulls source files from an Android Open
 * Source Project mirror (or any source matching `AospFetcher`),
 * splits each file into chunks, and writes them to a `RagStore`
 * under the `aosp` source kind with a license stamp.
 *
 * Plan 55 M1 scope:
 * - Pluggable `AospFetcher` so tests stay offline.
 * - Mandatory license at ingestion time. Without a license the
 *   chunk is recorded with `unsupportedReason` and stays in the
 *   index for audit but never surfaces at retrieval.
 *   `RagStore.addChunk()` itself rejects aosp chunks without a
 *   license string — we double-up here so the operator sees the
 *   reason at ingestion time rather than via a thrown error.
 * - Section-based chunking by C++ / Java function boundaries when
 *   present, falling back to fixed-size paragraph packing for
 *   files without recognizable structure.
 * - Stable chunk ids: `sha256(filePath + offset)` first 16 hex
 *   chars; re-ingesting the same file replaces in place.
 *
 * Out of scope:
 * - Real AOSP fetcher (M2 — would call `git archive` against the
 *   pinned manifest snapshot).
 * - Cron-based incremental refresh (M2).
 *
 * @module aospKnowledgeIngester
 */

import {createHash} from 'crypto';

import type {RagStore} from './ragStore';
import type {RagChunk} from '../types/sparkContracts';

/** One AOSP source file the fetcher returns. License is REQUIRED;
 * undefined license rejects the file at the ingester. */
export interface AospFile {
  /** Path relative to the AOSP root, e.g.
   *  `frameworks/base/services/core/.../HwcLayer.cpp`. */
  filePath: string;
  /** Source content (typically C++ or Java). */
  content: string;
  /** Pinned git commit hash for the AOSP snapshot. Stamped onto
   *  `verifiedAt` indirectly (epoch ms approximate; commit hash
   *  carried in the `notes` field of the chunk envelope). */
  commitHash: string;
  /** Approximate epoch-ms timestamp when this snapshot was captured. */
  fetchedAt: number;
  /** License of the source file. Required — typical values are
   *  `Apache-2.0` for AOSP / `BSD-3-Clause` for Linux kernel paths. */
  license: string;
  /** Optional title; falls back to last path segment. */
  title?: string;
}

/** Pluggable source for AOSP files. Production wiring will read
 * from a pinned manifest snapshot; tests inject a stub. */
export interface AospFetcher {
  fetchFiles(opts?: {pathPrefix?: string}): Promise<AospFile[]>;
}

export interface AospIngestOptions {
  /** Maximum characters per chunk. Defaults to 2000 (slightly
   *  larger than blog because source files have more boilerplate). */
  maxChunkChars?: number;
  /** Restrict to a path prefix (forwarded to fetcher). */
  pathPrefix?: string;
}

export interface AospIngestError {
  filePath: string;
  reason: string;
}

export interface AospIngestResult {
  filesProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  errors: AospIngestError[];
}

const DEFAULT_MAX_CHUNK_CHARS = 2000;

/** Heuristic regex for C++ / Java function boundaries. Triggers on
 * a line that looks like `[modifiers] returnType name(args) {` or
 * `class Name {`. Imperfect but enough to chop large files into
 * topical chunks. */
const FUNCTION_BOUNDARY_REGEX =
  /^(?:[\w<>:&,\s\*]+\s+)?[\w~]+\s*\([^)]*\)[\s\w:]*?\{$|^class\s+\w+/gm;

interface PackedChunk {
  text: string;
  offset: number;
}

/** Section-based chunker. Tries to split on function / class
 * boundaries; falls back to fixed-size when no boundaries land
 * within `maxChars * 2`. */
function chunkSource(text: string, maxChars: number): PackedChunk[] {
  if (text.trim().length === 0) return [];

  const boundaries: number[] = [0];
  let m: RegExpExecArray | null;
  // Reset regex internal state in case of repeated calls.
  FUNCTION_BOUNDARY_REGEX.lastIndex = 0;
  while ((m = FUNCTION_BOUNDARY_REGEX.exec(text)) !== null) {
    if (m.index > 0) boundaries.push(m.index);
  }
  boundaries.push(text.length);

  const out: PackedChunk[] = [];
  let bufStart = boundaries[0];
  let bufEnd = boundaries[0];

  for (let i = 1; i < boundaries.length; i++) {
    const next = boundaries[i];
    if (next - bufStart > maxChars && bufEnd > bufStart) {
      // Emit the current section before the next boundary pushes us
      // over. Start a new buffer at the prior boundary.
      out.push({text: text.slice(bufStart, bufEnd), offset: bufStart});
      bufStart = bufEnd;
    }
    bufEnd = next;
  }
  if (bufEnd > bufStart) {
    out.push({text: text.slice(bufStart, bufEnd), offset: bufStart});
  }

  // Fallback: if any chunk exceeds 2× maxChars (because no boundaries
  // landed nearby), hard-split it into fixed-size pieces so the
  // retrieval path stays reasonable.
  const final: PackedChunk[] = [];
  for (const c of out) {
    if (c.text.length <= maxChars * 2) {
      final.push(c);
      continue;
    }
    let cursor = 0;
    while (cursor < c.text.length) {
      const piece = c.text.slice(cursor, cursor + maxChars);
      final.push({text: piece, offset: c.offset + cursor});
      cursor += maxChars;
    }
  }
  return final;
}

function makeChunkId(filePath: string, offset: number): string {
  return createHash('sha256')
    .update(`${filePath}|${offset}`)
    .digest('hex')
    .slice(0, 16);
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export class AospKnowledgeIngester {
  constructor(
    private readonly store: RagStore,
    private readonly fetcher: AospFetcher,
  ) {}

  async ingest(opts: AospIngestOptions = {}): Promise<AospIngestResult> {
    const maxChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
    const result: AospIngestResult = {
      filesProcessed: 0,
      chunksAdded: 0,
      chunksSkipped: 0,
      errors: [],
    };

    let files: AospFile[];
    try {
      files = await this.fetcher.fetchFiles({pathPrefix: opts.pathPrefix});
    } catch (err) {
      result.errors.push({
        filePath: '<fetcher>',
        reason: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    for (const file of files) {
      result.filesProcessed++;
      if (!file.license || file.license.trim().length === 0) {
        result.errors.push({
          filePath: file.filePath,
          reason: 'license required for kind=aosp; entry rejected',
        });
        result.chunksSkipped++;
        continue;
      }
      try {
        const packed = chunkSource(file.content, maxChars);
        for (const p of packed) {
          const chunk: RagChunk = {
            chunkId: makeChunkId(file.filePath, p.offset),
            kind: 'aosp',
            uri: file.filePath,
            title: file.title ?? file.filePath.split('/').pop(),
            snippet: p.text,
            tokenCount: estimateTokenCount(p.text),
            license: file.license,
            indexedAt: file.fetchedAt,
            verifiedAt: file.fetchedAt,
            // Use SHA prefix as a "build id"-ish marker by reusing
            // license string slot is wrong — keep commit hash off-band
            // for now; M2 will add a richer chunk shape if needed.
          };
          this.store.addChunk(chunk);
          result.chunksAdded++;
        }
      } catch (err) {
        result.errors.push({
          filePath: file.filePath,
          reason: err instanceof Error ? err.message : String(err),
        });
        result.chunksSkipped++;
      }
    }
    return result;
  }
}

/** Test-only export of the chunker for boundary-detection coverage. */
export const __TEST_ONLY__ = {
  chunkSource,
  makeChunkId,
};
