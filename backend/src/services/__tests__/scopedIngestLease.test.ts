// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';
import {
  type ScopedIngestLease,
  type ScopedIngestLeaseConfig,
  withScopedIngestLease,
} from '../scopedIngestLease';
import {
  getScopedKnowledgeRecord,
  mutateScopedKnowledgeRecord,
} from '../scopedKnowledgeStore';

const TTL_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const BASE_TIME = 2_000_000_000_000;
/** The configured errors are thrown as built, so a caller can classify them by type. */
class TestLeaseBusyError extends Error {}
class TestLeaseLostError extends Error {}
const IN_PROGRESS = 'test_reindex_in_progress';
const LEASE_LOST = 'test_reindex_lease_lost';
const CONFIG: ScopedIngestLeaseConfig = {
  kind: 'test_ingest_lease',
  rowScope: 'test-ingest-lease',
  ttlMs: TTL_MS,
  heartbeatMs: HEARTBEAT_MS,
  inProgressError: () => new TestLeaseBusyError(IN_PROGRESS),
  lostError: () => new TestLeaseLostError(LEASE_LOST),
  logPrefix: 'TestRegistry',
};

async function expectLeaseBusy(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(TestLeaseBusyError);
  expect((error as Error).message).toBe(IN_PROGRESS);
}
const SCOPE = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
const RECORD_ID = 'record-1';

let tmpDir: string;

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function lockFor(): {registryPath: string; key: string} {
  return {registryPath: path.join(tmpDir, 'registry.json'), key: RECORD_ID};
}

function withLease<T>(
  operation: (lease: ScopedIngestLease) => Promise<T> | T,
  config: ScopedIngestLeaseConfig = CONFIG,
): Promise<T> {
  return withScopedIngestLease(config, RECORD_ID, SCOPE, lockFor(), operation);
}

function leaseRow(): {ownerToken: string; expiresAt: number} | undefined {
  return getScopedKnowledgeRecord<{ownerToken: string; expiresAt: number}>(
    CONFIG.kind,
    RECORD_ID,
    SCOPE,
  )?.record;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-ingest-lease-'));
  delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
  delete process.env[ENTERPRISE_DB_PATH_ENV];
  delete process.env[ENTERPRISE_MIGRATION_PHASE_ENV];
});

afterEach(() => {
  restoreEnv(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnv(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnv(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('withScopedIngestLease (enterprise DB lease row)', () => {
  let clock: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    clock = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);
  });

  it('rejects a second holder while the lease is unexpired and admits one after release', async () => {
    await withLease(async lease => {
      expect(lease.distributed).toBe(true);
      await expectLeaseBusy(withLease(() => 'second'));
    });

    expect(leaseRow()?.expiresAt).toBe(0);
    await expect(withLease(() => 'after-release')).resolves.toBe('after-release');
  });

  it('skips the durable write inside the heartbeat window unless forced', async () => {
    await withLease(lease => {
      lease.assertHeld();
      expect(leaseRow()?.expiresAt).toBe(BASE_TIME + TTL_MS);

      clock.mockReturnValue(BASE_TIME + HEARTBEAT_MS - 1);
      lease.assertHeld();
      expect(leaseRow()?.expiresAt).toBe(BASE_TIME + TTL_MS);

      lease.assertHeld(true);
      expect(leaseRow()?.expiresAt).toBe(BASE_TIME + HEARTBEAT_MS - 1 + TTL_MS);
    });
  });

  it('renews on every check when the heartbeat is zero', async () => {
    await withLease(lease => {
      for (let step = 1; step <= 3; step += 1) {
        clock.mockReturnValue(BASE_TIME + step);
        lease.assertHeld();
        expect(leaseRow()?.expiresAt).toBe(BASE_TIME + step + TTL_MS);
      }
    }, {...CONFIG, heartbeatMs: 0});
  });

  it('fences forced checks and paired writes against a replaced owner', async () => {
    await expect(withLease(lease => {
      lease.assertHeld();
      mutateScopedKnowledgeRecord(
        CONFIG.kind,
        RECORD_ID,
        SCOPE,
        () => ({ownerToken: 'intruder', expiresAt: BASE_TIME + TTL_MS}),
        {rowScope: CONFIG.rowScope},
      );
      // A non-forced check inside the heartbeat window is the accepted gap.
      expect(() => lease.assertHeld()).not.toThrow();
      expect(() => lease.assertHeld(true)).toThrow(TestLeaseLostError);
      if (!lease.distributed) throw new Error('expected a distributed lease');
      lease.mutateFenced<{value: string}>({
        kind: 'test_protected_record',
        externalId: RECORD_ID,
        options: {rowScope: 'test-protected-record'},
        mutate: () => ({value: 'stale-write'}),
      });
    })).rejects.toThrow(TestLeaseLostError);

    expect(getScopedKnowledgeRecord('test_protected_record', RECORD_ID, SCOPE)).toBeUndefined();
    expect(leaseRow()?.ownerToken).toBe('intruder');
  });

  it('releases the lease and surfaces the original error when the operation fails', async () => {
    await expect(withLease(() => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');

    expect(leaseRow()?.expiresAt).toBe(0);
  });

  it('detects a takeover after expiry and leaves the successor row live on release', async () => {
    let successorToken: string | undefined;
    let releaseSuccessor!: () => void;
    const successorHeld = new Promise<void>(resolve => {
      releaseSuccessor = resolve;
    });
    let successorRun: Promise<void> | undefined;

    await withLease(lease => {
      lease.assertHeld();
      clock.mockReturnValue(BASE_TIME + TTL_MS + 1);
      successorRun = withLease(async next => {
        successorToken = next.ownerToken;
        await successorHeld;
      });
      // Takeover needs an expired lease, which is always past the heartbeat
      // window, so even a non-forced check reaches the lease row.
      expect(() => lease.assertHeld()).toThrow(TestLeaseLostError);
    });

    expect(leaseRow()).toEqual({
      ownerToken: successorToken,
      expiresAt: BASE_TIME + TTL_MS + 1 + TTL_MS,
    });
    releaseSuccessor();
    await successorRun;
    expect(leaseRow()).toEqual({ownerToken: successorToken, expiresAt: 0});
  });

  it('rejects a heartbeat that is not below the TTL', async () => {
    await expect(withLease(() => undefined, {...CONFIG, heartbeatMs: TTL_MS}))
      .rejects.toThrow('TestRegistry ingest lease heartbeat must be below its TTL');
  });
});

describe('withScopedIngestLease (filesystem lock)', () => {
  it('maps a lost filesystem lock to the configured lost error', async () => {
    await withLease(async lease => {
      expect(lease.distributed).toBe(false);
      await expectLeaseBusy(withLease(() => 'second'));
      const lockName = fs.readdirSync(tmpDir).find(name =>
        name.startsWith('registry.json.ingest.') && name.endsWith('.lock'));
      expect(lockName).toBeDefined();
      fs.writeFileSync(
        path.join(tmpDir, lockName!, 'owner.json'),
        JSON.stringify({token: 'intruder'}),
      );
      expect(() => lease.assertHeld(true)).toThrow(TestLeaseLostError);
    });
  });
});
