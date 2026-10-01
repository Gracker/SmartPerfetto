// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';

import {withFilesystemRegistryLockAsync} from './filesystemRegistryLock';
import {
  enterpriseKnowledgeDbWritesEnabled,
  type KnowledgeScope,
  mutateScopedKnowledgeRecord,
  mutateScopedKnowledgeRecordPair,
  type ScopedKnowledgeMutation,
} from './scopedKnowledgeStore';

interface IngestLeaseRecord {
  ownerToken: string;
  expiresAt: number;
}

export interface ScopedIngestLeaseConfig {
  /** Lease row identity in the enterprise knowledge store. */
  kind: string;
  rowScope: string;
  ttlMs: number;
  /**
   * Non-forced `assertHeld` calls within this window of the last durable check
   * return without a write. It must stay below `ttlMs`: another instance can
   * only take the lease once it expired, which is always past this window, so
   * the check that follows a legitimate takeover is durable. Defaults to `0`,
   * which makes every check durable.
   */
  heartbeatMs?: number;
  inProgressError: string;
  lostError: string;
  logPrefix: string;
}

interface IngestLeaseBase {
  /** Unique per operation; registries seed staged generation ids with it. */
  readonly ownerToken: string;
  /** Renews the lease, or throws `lostError` once ownership has changed. */
  assertHeld(forceDurableCheck?: boolean): void;
}

interface FilesystemIngestLease extends IngestLeaseBase {
  readonly distributed: false;
}

export interface DistributedIngestLease extends IngestLeaseBase {
  readonly distributed: true;
  /**
   * Renews the lease and applies `mutation` in one IMMEDIATE transaction, so
   * the protected write cannot land after ownership moved to another instance.
   */
  mutateFenced<T>(mutation: ScopedKnowledgeMutation<T>): T;
}

export type ScopedIngestLease = FilesystemIngestLease | DistributedIngestLease;

function throttledCheck(
  heartbeatMs: number,
  check: () => void,
): (forceDurableCheck?: boolean) => void {
  let lastDurableCheckAt = 0;
  return (forceDurableCheck = false) => {
    const startedAt = Date.now();
    if (!forceDurableCheck && startedAt - lastDurableCheckAt < heartbeatMs) return;
    check();
    lastDurableCheckAt = startedAt;
  };
}

/**
 * Serializes one registry record's generation changes. Enterprise DB writes
 * fence through a lease row shared by every instance; otherwise a filesystem
 * lock next to the registry file serializes local processes.
 */
export async function withScopedIngestLease<T>(
  config: ScopedIngestLeaseConfig,
  externalId: string,
  scope: KnowledgeScope,
  filesystemLock: {registryPath: string; key: string},
  operation: (lease: ScopedIngestLease) => Promise<T> | T,
): Promise<T> {
  const heartbeatMs = config.heartbeatMs ?? 0;
  if (!(heartbeatMs >= 0 && heartbeatMs < config.ttlMs)) {
    throw new Error(`${config.logPrefix} ingest lease heartbeat must be below its TTL`);
  }
  const ownerToken = randomUUID();
  if (!enterpriseKnowledgeDbWritesEnabled()) {
    const lockPath = `${filesystemLock.registryPath}.ingest.${createHash('sha256')
      .update(filesystemLock.key)
      .digest('hex')
      .slice(0, 24)}`;
    return withFilesystemRegistryLockAsync(
      lockPath,
      config.inProgressError,
      filesystemLease => operation({
        ownerToken,
        distributed: false,
        assertHeld: throttledCheck(heartbeatMs, () => {
          try {
            filesystemLease.assertHeld();
          } catch {
            throw new Error(config.lostError);
          }
        }),
      }),
      config.ttlMs,
    );
  }

  const options = {rowScope: config.rowScope};
  const renewal: ScopedKnowledgeMutation<IngestLeaseRecord> = {
    kind: config.kind,
    externalId,
    options,
    mutate: current => {
      const now = Date.now();
      if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
        throw new Error(config.lostError);
      }
      return {...current, expiresAt: now + config.ttlMs};
    },
  };

  mutateScopedKnowledgeRecord<IngestLeaseRecord>(
    config.kind,
    externalId,
    scope,
    current => {
      const now = Date.now();
      if (current && current.expiresAt > now) {
        throw new Error(config.inProgressError);
      }
      return {ownerToken, expiresAt: now + config.ttlMs};
    },
    options,
  );
  const lease: DistributedIngestLease = {
    ownerToken,
    distributed: true,
    assertHeld: throttledCheck(heartbeatMs, () => {
      mutateScopedKnowledgeRecord(config.kind, externalId, scope, renewal.mutate, options);
    }),
    mutateFenced: mutation =>
      mutateScopedKnowledgeRecordPair(renewal, mutation, scope).second,
  };
  try {
    return await operation(lease);
  } finally {
    try {
      mutateScopedKnowledgeRecord<IngestLeaseRecord>(
        config.kind,
        externalId,
        scope,
        current => current?.ownerToken === ownerToken
          ? {...current, expiresAt: 0}
          : current ?? {ownerToken: 'released', expiresAt: 0},
        options,
      );
    } catch (error) {
      console.warn(
        `[${config.logPrefix}] Lease release failed for ${externalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
