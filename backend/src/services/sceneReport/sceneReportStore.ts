// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SceneReportStore — 7-day disk cache for SceneReport JSON.
 *
 * On-disk layout
 * --------------
 *   {reportDir}/index.json           — single index, see IndexFile
 *   {reportDir}/{reportId}.json      — one file per report (atomic write)
 *
 * The index is the source of truth for `loadByHash` and `cleanupExpired`;
 * a stray .json file with no index entry is harmless and will be picked
 * up by the next save that happens to assign a colliding reportId (vanishingly
 * unlikely with uuid v4) or by future hard-size cleanup work.
 *
 * Concurrency
 * -----------
 * All mutating operations (`save`, `delete`, `cleanupExpired`) go through a
 * single-writer promise chain (`writeQueue`). Reads (`loadById`,
 * `loadByHash`) go directly to disk and may observe an older snapshot —
 * that's fine because the index is rewritten atomically via `fs.rename`,
 * so a reader either sees the pre- or post-state, never a torn one.
 *
 * Deployment assumption: this guarantee holds only for a *single* Node
 * process owning the `reportDir`. If the backend is ever scaled to multiple
 * worker processes / instances sharing the same directory, the writeQueue
 * lock disappears and concurrent writers can race on the index. A future
 * cluster deployment would need a file lock (or external coordination)
 * around `save`/`delete`/`cleanupExpired`.
 *
 * Atomicity
 * ---------
 * Each write goes to a unique `.tmp.{pid}.{ts}` file then `fs.rename` into
 * place. POSIX guarantees `rename` is atomic on the same filesystem, which
 * is exactly what we need so a crashed backend can never leave a half-
 * written index.json behind.
 *
 * Schema versioning
 * -----------------
 * `loadById` checks `report.generatedBy.pipelineVersion === 'v2'` and
 * returns null on mismatch. This means a Stage1/Stage2 contract change
 * (bump to 'v3') invalidates the cache without requiring a migration.
 */

import path from 'path';
import { promises as fsp } from 'fs';
import { atomicWriteFile } from '../../utils/atomicFileWriter';
import type { SceneReport } from '../../agent/scene/types';
import type { SceneRouteProfile } from '../../agent/config/domainManifest';
import { logStoredReadFailure, parseStoredJson } from '../../utils/storedData';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-report bookkeeping. Kept lean so the index file stays small even at
 * thousands of entries.
 */
interface IndexEntry {
  /** sha256 of trace content; null when the report came from an external RPC trace. */
  hash: string | null;
  /**
   * Wall-clock ms cutoff after which loadByHash/loadById return null.
   * `null` means "never expires"; `cleanupExpired` does NOT garbage-collect
   * null-expiry entries, so the disk store will only see them if a future
   * caller deliberately decides external_rpc reports should also live on
   * disk. Today only file-backed traces flow into the store and they
   * always have a numeric expiresAt.
   */
  expiresAt: number | null;
  createdAt: number;
  filename: string;
  /** Cache profile. Stored in index metadata, not in SceneReport JSON. */
  routeProfile?: SceneRouteProfile;
}

interface IndexFile {
  version: 1;
  byHash: Record<string, string>;     // hash → reportId
  byReport: Record<string, IndexEntry>;
}

export interface SceneReportStore {
  save(
    report: SceneReport,
    routeProfile?: SceneRouteProfile,
    options?: { indexByHash?: boolean },
  ): Promise<void>;
  loadById(reportId: string): Promise<SceneReport | null>;
  loadByHash(hash: string, routeProfile?: SceneRouteProfile): Promise<SceneReport | null>;
  delete(reportId: string): Promise<boolean>;
  cleanupExpired(nowMs: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_FILENAME = 'index.json';
const REPORT_EXT = '.json';
const SUPPORTED_PIPELINE_VERSION: SceneReport['generatedBy']['pipelineVersion'] = 'v2';

function hashProfileKey(hash: string, routeProfile: SceneRouteProfile): string {
  return `${hash}::${routeProfile}`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FileSystemSceneReportStore implements SceneReportStore {
  /** Single-writer chain — every mutation `await`s the previous one. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly reportDir: string) {}

  // -- path helpers ---------------------------------------------------------

  private get indexPath(): string {
    return path.join(this.reportDir, INDEX_FILENAME);
  }

  private reportPath(reportId: string): string {
    return path.join(this.reportDir, `${reportId}${REPORT_EXT}`);
  }

  // -- low-level I/O --------------------------------------------------------

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.reportDir, { recursive: true });
  }

  private emptyIndex(): IndexFile {
    return { version: 1, byHash: {}, byReport: {} };
  }

  /**
   * Read+parse the index. Returns an empty index when:
   *  - The file doesn't exist (first-ever save).
   *  - The JSON is corrupted (rare, but recoverable — the next save rewrites it).
   *  - The version is unrecognised.
   *
   * Logs a warning on corruption so we notice in CI/dev.
   */
  private async readIndex(): Promise<IndexFile> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8');
      const parsed = parseStoredJson<Partial<IndexFile>>(raw, 'scene report index');
      if (
        parsed.version !== 1 ||
        typeof parsed.byHash !== 'object' || parsed.byHash === null ||
        typeof parsed.byReport !== 'object' || parsed.byReport === null
      ) {
        console.warn('[SceneReportStore] index.json structure unexpected, resetting');
        return this.emptyIndex();
      }
      return parsed as IndexFile;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') logStoredReadFailure('[SceneReportStore] index.json unreadable, resetting', err);
      return this.emptyIndex();
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await atomicWriteFile(this.indexPath, JSON.stringify(index));
  }

  /**
   * Schedule `op` after every previously enqueued mutation. The continuation
   * stored back into `writeQueue` deliberately swallows the result and any
   * error so a single failing op cannot poison every subsequent write — the
   * caller still receives the original promise (with the original rejection).
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(() => op());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // -- public API -----------------------------------------------------------

  async save(
    report: SceneReport,
    routeProfile: SceneRouteProfile = 'legacy',
    options: { indexByHash?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureDir();
      const filename = `${report.reportId}${REPORT_EXT}`;
      const reportFilePath = path.join(this.reportDir, filename);

      // 1) Write the report file atomically.
      await atomicWriteFile(reportFilePath, JSON.stringify(report));

      // 2) Update the index in-place.
      const index = await this.readIndex();

      // If the same hash was already pointing at a different reportId, drop
      // the stale byReport entry so future loadByHash returns the new one.
      // We deliberately don't unlink the old report file here — a concurrent
      // caller may still hold the old reportId for a loadById; the next
      // cleanupExpired sweep will pick it up via TTL.
      const indexByHash = options.indexByHash !== false;
      if (indexByHash && report.traceHash) {
        const profileKey = hashProfileKey(report.traceHash, routeProfile);
        const previousId = index.byHash[profileKey];
        if (previousId && previousId !== report.reportId) {
          delete index.byReport[previousId];
        }
      }

      index.byReport[report.reportId] = {
        hash: report.traceHash,
        expiresAt: report.expiresAt,
        createdAt: report.createdAt,
        filename,
        routeProfile,
      };
      if (indexByHash && report.traceHash) {
        index.byHash[hashProfileKey(report.traceHash, routeProfile)] = report.reportId;
      }

      await this.writeIndex(index);
    });
  }

  async loadById(reportId: string): Promise<SceneReport | null> {
    try {
      const raw = await fsp.readFile(this.reportPath(reportId), 'utf8');
      const report = parseStoredJson<SceneReport>(raw, 'scene report');
      if (report?.generatedBy?.pipelineVersion !== SUPPORTED_PIPELINE_VERSION) {
        return null;
      }
      // TTL gate at read time. Mirrors loadByHash so a direct
      // `GET /scene-reconstruct/report/:id` call cannot return an
      // expired report between cleanup sweeps.
      if (report.expiresAt !== null && report.expiresAt < Date.now()) {
        return null;
      }
      return report;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') logStoredReadFailure('[SceneReportStore] Report unreadable', err, {reportId});
      return null;
    }
  }

  async loadByHash(
    hash: string,
    routeProfile: SceneRouteProfile = 'legacy',
  ): Promise<SceneReport | null> {
    const index = await this.readIndex();
    const reportId = index.byHash[hashProfileKey(hash, routeProfile)]
      // Backward compatibility for pre-profile legacy cache entries.
      ?? (routeProfile === 'legacy' ? index.byHash[hash] : undefined);
    if (!reportId) return null;

    const entry = index.byReport[reportId];
    if (!entry) return null;

    // TTL gate at read time — expired entries return null and will be
    // garbage-collected by the next cleanupExpired sweep.
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      return null;
    }

    return this.loadById(reportId);
  }

  async delete(reportId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      const entry = index.byReport[reportId];
      if (!entry) return false;

      delete index.byReport[reportId];
      if (entry.hash && index.byHash[entry.hash] === reportId) {
        delete index.byHash[entry.hash];
      }
      if (entry.hash) {
        const profileKey = hashProfileKey(entry.hash, entry.routeProfile ?? 'legacy');
        if (index.byHash[profileKey] === reportId) {
          delete index.byHash[profileKey];
        }
      }
      await this.writeIndex(index);

      try {
        await fsp.unlink(this.reportPath(reportId));
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          console.warn(
            `[SceneReportStore] failed to unlink report ${reportId}:`,
            err?.message ?? err,
          );
        }
      }
      return true;
    });
  }

  async cleanupExpired(nowMs: number): Promise<number> {
    return this.enqueue(async () => {
      const index = await this.readIndex();

      const expiredIds: string[] = [];
      for (const [reportId, entry] of Object.entries(index.byReport)) {
        if (entry.expiresAt !== null && entry.expiresAt < nowMs) {
          expiredIds.push(reportId);
        }
      }
      if (expiredIds.length === 0) return 0;

      for (const reportId of expiredIds) {
        const entry = index.byReport[reportId];
        delete index.byReport[reportId];
        if (entry?.hash && index.byHash[entry.hash] === reportId) {
          delete index.byHash[entry.hash];
        }
        if (entry?.hash) {
          const profileKey = hashProfileKey(entry.hash, entry.routeProfile ?? 'legacy');
          if (index.byHash[profileKey] === reportId) {
            delete index.byHash[profileKey];
          }
        }
        try {
          await fsp.unlink(this.reportPath(reportId));
        } catch (err: any) {
          if (err?.code !== 'ENOENT') {
            console.warn(
              `[SceneReportStore] cleanup failed to unlink ${reportId}:`,
              err?.message ?? err,
            );
          }
        }
      }

      await this.writeIndex(index);
      return expiredIds.length;
    });
  }
}
