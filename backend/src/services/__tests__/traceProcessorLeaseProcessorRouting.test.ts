// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { applyEnterpriseMinimalSchema } from '../enterpriseSchema';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import {
  setTraceProcessorLeaseStoreForTests,
  TraceProcessorLeaseStore,
} from '../traceProcessorLeaseStore';
import {
  TraceProcessorFactory,
  type QueryResult,
} from '../workingTraceProcessor';
import {
  TraceProcessorService,
  type TraceProcessor,
} from '../traceProcessorService';

function okResult(label: string): QueryResult {
  return {
    columns: ['source'],
    rows: [[label]],
    durationMs: 1,
  };
}

function fakeProcessor(id: string, traceId: string): TraceProcessor {
  return {
    id,
    traceId,
    status: 'ready',
    activeQueries: 0,
    query: jest.fn(async () => okResult(id)),
    queryRaw: jest.fn(async (body: Buffer) => Buffer.from(`${id}:${body.toString('utf8')}`)),
    destroy: jest.fn(),
  };
}

describe('TraceProcessorService lease processor routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    TraceProcessorFactory.cleanup();
    setTraceProcessorLeaseStoreForTests(null);
  });

  it('routes shared work by traceId and isolated work by lease processor key', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-routing-'));
    try {
      const traceId = 'trace-a';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(traceId, 'trace-a.trace', 11, tracePath);

      const shared = fakeProcessor('shared-processor', traceId);
      const isolated = fakeProcessor('isolated-processor', traceId);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async (_traceId, _tracePath, options) => {
          return (options?.leaseMode === 'isolated' ? isolated : shared) as any;
        });

      await service.ensureProcessorForLease(traceId, 'shared-lease', 'shared');
      await service.ensureProcessorForLease(traceId, 'isolated-lease', 'isolated');

      expect(createSpy).toHaveBeenNthCalledWith(1, traceId, tracePath, expect.objectContaining({
        processorKey: traceId,
        leaseId: 'shared-lease',
        leaseMode: 'shared',
      }));
      expect(createSpy).toHaveBeenNthCalledWith(2, traceId, tracePath, expect.objectContaining({
        processorKey: `${traceId}:lease:isolated-lease`,
        leaseId: 'isolated-lease',
        leaseMode: 'isolated',
      }));

      await expect(service.query(traceId, 'SELECT shared')).resolves.toMatchObject({
        rows: [['shared-processor']],
      });
      await expect(service.runWithLease(
        { traceId, leaseId: 'isolated-lease', mode: 'isolated' },
        () => service.query(traceId, 'SELECT isolated'),
      )).resolves.toMatchObject({
        rows: [['isolated-processor']],
      });
      await expect(service.queryRaw(traceId, Buffer.from('raw'), {
        leaseId: 'isolated-lease',
        leaseMode: 'isolated',
      })).resolves.toEqual(Buffer.from('isolated-processor:raw'));

      expect(shared.query).toHaveBeenCalledWith('SELECT shared', {});
      expect(isolated.query).toHaveBeenCalledWith('SELECT isolated', {});
      expect(isolated.queryRaw).toHaveBeenCalledWith(Buffer.from('raw'), {});
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('registers stored metadata lazily and cleans only the requested lease processor', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-cleanup-'));
    try {
      const traceId = 'trace-cleanup';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      const service = new TraceProcessorService(tmpDir);
      const createSpy = jest.spyOn(TraceProcessorFactory, 'create');

      expect(service.registerStoredTrace({
        id: traceId,
        filename: 'trace-cleanup.trace',
        size: 11,
        filePath: tracePath,
      })).toMatchObject({
        id: traceId,
        status: 'ready',
        filePath: tracePath,
      });
      expect(createSpy).not.toHaveBeenCalled();

      const first = fakeProcessor('first', traceId);
      const sibling = fakeProcessor('sibling', traceId);
      const firstKey = `${traceId}:lease:lease-first`;
      const siblingKey = `${traceId}:lease:lease-sibling`;
      (service as any).processors.set(firstKey, first);
      (service as any).processors.set(siblingKey, sibling);
      const removeSpy = jest
        .spyOn(TraceProcessorFactory, 'remove')
        .mockReturnValue(true);

      expect(service.cleanupLeaseProcessor(
        traceId,
        'lease-first',
        'isolated',
      )).toBe(true);
      expect(removeSpy).toHaveBeenCalledWith(firstKey);
      expect((service as any).processors.has(firstKey)).toBe(false);
      expect((service as any).processors.get(siblingKey)).toBe(sibling);
    } finally {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });
});

const scope: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

function seedEnterpriseGraph(db: Database.Database, traceId: string): void {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, local_path, status, created_at)
    VALUES
      (?, 'tenant-a', 'workspace-a', ?, 'ready', ?)
  `).run(traceId, `/tmp/${traceId}.pftrace`, now);
}

function createActiveLease(store: TraceProcessorLeaseStore, traceId: string): string {
  let lease = store.acquireHolder(scope, traceId, {
    holderType: 'agent_run',
    holderRef: 'run-a',
    runId: 'run-a',
  }, { mode: 'isolated', now: 1000 });
  store.markStarting(scope, lease.id);
  lease = store.markReady(scope, lease.id);
  return lease.id;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TraceProcessorService lease restart supervisor', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    jest.restoreAllMocks();
    TraceProcessorFactory.cleanup();
    setTraceProcessorLeaseStoreForTests(null);
    db?.close();
    db = null;
  });

  it('uses one supervisor restart for concurrent crashed lease holders and preserves the lease id', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-restart-'));
    try {
      const traceId = 'trace-restart';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [1000, 5000, 15000],
        jitterMs: 0,
        sleep: async () => undefined,
      });
      await service.initializeUploadWithId(traceId, 'trace-restart.trace', 11, tracePath);

      const dead = fakeProcessor('dead-processor', traceId);
      dead.status = 'error';
      (service as any).processors.set(`${traceId}:lease:${leaseId}`, dead);

      const restarted = fakeProcessor('restarted-processor', traceId);
      const gate = deferred<TraceProcessor>();
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => gate.promise as Promise<any>);

      const queryA = service.query(traceId, 'SELECT a', {
        leaseId,
        leaseMode: 'isolated',
        leaseScope: scope,
      });
      const queryB = service.query(traceId, 'SELECT b', {
        leaseId,
        leaseMode: 'isolated',
        leaseScope: scope,
      });

      await Promise.resolve();
      gate.resolve(restarted);

      await expect(queryA).resolves.toMatchObject({ rows: [['restarted-processor']] });
      await expect(queryB).resolves.toMatchObject({ rows: [['restarted-processor']] });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(traceId, tracePath, expect.objectContaining({
        processorKey: `${traceId}:lease:${leaseId}`,
        leaseId,
        leaseMode: 'isolated',
      }));
      expect(dead.destroy).toHaveBeenCalledTimes(1);
      expect(store.getLeaseById(scope, leaseId)).toMatchObject({
        id: leaseId,
        state: 'active',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows an explicit admin restart of a ready lease processor', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-admin-restart-'));
    try {
      const traceId = 'trace-admin-restart';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [0],
        jitterMs: 0,
      });
      await service.initializeUploadWithId(traceId, 'trace-admin-restart.trace', 11, tracePath);

      const current = fakeProcessor('current-processor', traceId);
      (service as any).processors.set(`${traceId}:lease:${leaseId}`, current);

      const restarted = fakeProcessor('restarted-processor', traceId);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockResolvedValue(restarted as any);

      await expect(service.restartLease(traceId, leaseId, 'isolated', scope))
        .resolves.toBe(restarted);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(traceId, tracePath, expect.objectContaining({
        processorKey: `${traceId}:lease:${leaseId}`,
        leaseId,
        leaseMode: 'isolated',
      }));
      expect(current.destroy).toHaveBeenCalledTimes(1);
      expect(store.getLeaseById(scope, leaseId)).toMatchObject({
        id: leaseId,
        state: 'active',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('marks the lease failed after the 1s/5s/15s backoff restart attempts all fail', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-restart-fail-'));
    try {
      const traceId = 'trace-restart-fail';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);

      const observedBackoff: number[] = [];
      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [1000, 5000, 15000],
        jitterMs: 0,
        sleep: async delayMs => {
          observedBackoff.push(delayMs);
        },
      });
      await service.initializeUploadWithId(traceId, 'trace-restart-fail.trace', 11, tracePath);

      const dead = fakeProcessor('dead-processor', traceId);
      dead.status = 'error';
      (service as any).processors.set(`${traceId}:lease:${leaseId}`, dead);

      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockRejectedValue(new Error('spawn failed') as never);

      await expect(service.query(traceId, 'SELECT a', {
        leaseId,
        leaseMode: 'isolated',
        leaseScope: scope,
      })).rejects.toThrow('spawn failed');

      expect(createSpy).toHaveBeenCalledTimes(3);
      expect(observedBackoff).toEqual([1000, 5000, 15000]);
      expect(store.getLeaseById(scope, leaseId)).toMatchObject({
        id: leaseId,
        state: 'failed',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
