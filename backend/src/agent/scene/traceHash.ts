// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * traceHash — content addressing for file-backed traces.
 *
 * The Scene Story disk cache keys reports by sha256 of the trace file
 * contents, so reopening the same trace produces the same lookup key
 * regardless of which `traceId` the upload was assigned. External RPC
 * traces (registered via TraceProcessorService.registerExternalRpc) have
 * no file on disk and therefore no content hash — those flow into the
 * memory cache instead, see `SceneReportMemoryCache`.
 */

import crypto from 'crypto';
import fs from 'fs';
import type { TraceProcessorService } from '../../services/traceProcessorService';

/**
 * Compute the sha256 hex digest of the on-disk trace file.
 *
 * Returns `null` when:
 *  - The trace is external RPC (no file on disk to hash).
 *  - The file is missing (e.g. trace was deleted between cache check and hash).
 *  - The stream errors out mid-read.
 *
 * Streams the read in chunks so multi-GB traces don't blow up memory.
 * Tradeoff: hashing 1 GB on a fast SSD takes ~5-10s, so callers must
 * `await` this off any latency-sensitive code path.
 */
export async function computeTraceContentHash(
  tps: TraceProcessorService,
  traceId: string,
): Promise<string | null> {
  const filePath = tps.getTraceFilePath(traceId);

  // Skip the pre-check `existsSync` — the stream error handler already
  // covers ENOENT (file deleted between check and open is a classic TOCTOU
  // race). This saves one syscall per call.
  return new Promise<string | null>((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT is expected for external-RPC traces (no file on disk) —
      // resolve null silently. Other errors get a warning.
      if (err.code !== 'ENOENT') {
        console.warn(
          `[traceHash] Failed to stream-hash trace ${traceId}:`,
          err?.message ?? err,
        );
      }
      resolve(null);
    });
  });
}
