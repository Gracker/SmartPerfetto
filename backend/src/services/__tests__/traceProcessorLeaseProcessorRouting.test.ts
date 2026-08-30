// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fsSync from 'fs';
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
  ExternalRpcProcessor,
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

  it('single-flights concurrent shared lease processor creation by processor key', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-singleflight-'));
    try {
      const traceId = 'trace-singleflight';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(traceId, 'trace-singleflight.trace', 11, tracePath);

      const created = fakeProcessor('created-once', traceId);
      const gate = deferred<TraceProcessor>();
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => gate.promise as Promise<any>);

      const first = service.ensureProcessorForLease(traceId, 'shared-lease-a', 'shared');
      const second = service.ensureProcessorForLease(traceId, 'shared-lease-a', 'shared');

      await Promise.resolve();
      expect(createSpy).toHaveBeenCalledTimes(1);

      gate.resolve(created);
      await expect(Promise.all([first, second])).resolves.toEqual([created, created]);
      expect((service as any).processors.get(traceId)).toBe(created);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('joins and discards default processor creation that resolves after trace deletion starts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-pending-create-'));
    try {
      const traceId = 'trace-delete-pending-create';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(
        traceId,
        'trace-delete-pending-create.trace',
        11,
        tracePath,
      );

      const created = fakeProcessor('created-after-delete', traceId);
      const gate = deferred<TraceProcessor>();
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => gate.promise as Promise<any>);
      const processed = jest.fn();
      const statusChanged = jest.fn();
      service.on('trace-processed', processed);
      service.on('trace-status-changed', statusChanged);

      const processing = service.completeUpload(traceId);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);

      let deletionSettled = false;
      const deletion = service.deleteTrace(traceId).then(() => {
        deletionSettled = true;
      });
      await flushPromises();
      const deletionJoinedCreation = !deletionSettled;

      gate.resolve(created);
      await Promise.all([processing, deletion]);

      expect(deletionJoinedCreation).toBe(true);
      expect(service.getTrace(traceId)).toBeUndefined();
      expect((service as any).processors.has(traceId)).toBe(false);
      expect(created.destroy).toHaveBeenCalledTimes(1);
      expect(processed).not.toHaveBeenCalled();
      expect(statusChanged.mock.calls.map(
        ([trace]) => (trace as {status: string}).status,
      )).toEqual(['processing']);
      await expect(fs.access(tracePath)).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('suppresses ready publication when deletion races default processor metadata extraction', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-pending-metadata-'));
    try {
      const traceId = 'trace-delete-pending-metadata';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(
        traceId,
        'trace-delete-pending-metadata.trace',
        11,
        tracePath,
      );

      const created = fakeProcessor('created-before-delete', traceId);
      const metadataGate = deferred<QueryResult>();
      created.query = jest.fn(async () => metadataGate.promise);
      jest.spyOn(TraceProcessorFactory, 'create').mockResolvedValue(created as any);
      const processed = jest.fn();
      const statusChanged = jest.fn();
      service.on('trace-processed', processed);
      service.on('trace-status-changed', statusChanged);

      const processing = service.completeUpload(traceId);
      for (let attempt = 0; attempt < 20 && !(created.query as jest.Mock).mock.calls.length; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(created.query).toHaveBeenCalledTimes(1);

      await service.deleteTrace(traceId);
      metadataGate.resolve(okResult('metadata-after-delete'));
      await processing;

      expect(service.getTrace(traceId)).toBeUndefined();
      expect((service as any).processors.has(traceId)).toBe(false);
      expect(created.destroy).toHaveBeenCalledTimes(1);
      expect(processed).not.toHaveBeenCalled();
      expect(statusChanged.mock.calls.map(
        ([trace]) => (trace as {status: string}).status,
      )).toEqual(['processing']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('restores a retryable trace registration when file deletion fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-unlink-failure-'));
    try {
      const traceId = 'trace-delete-unlink-failure';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(
        traceId,
        'trace-delete-unlink-failure.trace',
        11,
        tracePath,
      );
      jest.spyOn(fsSync, 'unlinkSync').mockImplementationOnce(() => {
        throw new Error('unlink denied');
      });

      await expect(service.deleteTrace(traceId)).rejects.toThrow('unlink denied');
      expect(service.getTrace(traceId)).toMatchObject({
        id: traceId,
        filePath: tracePath,
      });
      await expect(fs.access(tracePath)).resolves.toBeUndefined();

      await expect(service.deleteTrace(traceId)).resolves.toBeUndefined();
      expect(service.getTrace(traceId)).toBeUndefined();
      await expect(fs.access(tracePath)).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not treat another default trace key containing the lease delimiter as a child', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-exact-owner-'));
    try {
      const traceId = 'trace-owner';
      const delimiterTraceId = `${traceId}:lease:other-trace`;
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      const delimiterTracePath = path.join(tmpDir, `${delimiterTraceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      await fs.writeFile(delimiterTracePath, 'other trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(traceId, `${traceId}.trace`, 11, tracePath);
      await service.initializeUploadWithId(
        delimiterTraceId,
        `${delimiterTraceId}.trace`,
        17,
        delimiterTracePath,
      );

      const created = fakeProcessor('delimiter-trace-processor', delimiterTraceId);
      const gate = deferred<TraceProcessor>();
      jest.spyOn(TraceProcessorFactory, 'create').mockImplementation(
        async (_traceId, _tracePath, options) => {
          (TraceProcessorFactory as any).processors.set(options?.processorKey, created);
          return gate.promise as Promise<any>;
        },
      );
      const otherCreation = service.ensureProcessorForLease(
        delimiterTraceId,
        'shared-lease',
        'shared',
      );
      await flushPromises();

      let deletionSettled = false;
      const deletion = service.deleteTrace(traceId).then(() => {
        deletionSettled = true;
      });
      await flushPromises();
      const deletionIgnoredOtherTrace = deletionSettled;

      gate.resolve(created);
      await deletion;
      await expect(otherCreation).resolves.toBe(created);

      expect(deletionIgnoredOtherTrace).toBe(true);
      expect(created.destroy).not.toHaveBeenCalled();
      expect(service.getTrace(delimiterTraceId)).toBeDefined();
      expect((service as any).processors.get(delimiterTraceId)).toBe(created);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the same trace is reloaded while deletion joins old creation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-reload-barrier-'));
    try {
      const traceId = 'trace-delete-reload-barrier';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(
        traceId,
        'trace-delete-reload-barrier.trace',
        11,
        tracePath,
      );

      const created = fakeProcessor('created-before-reload', traceId);
      const gate = deferred<TraceProcessor>();
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => gate.promise as Promise<any>);

      const processing = service.completeUpload(traceId);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);

      const deletion = service.deleteTrace(traceId);
      await flushPromises();
      let reloadSettled = false;
      let reloadResult: Awaited<ReturnType<TraceProcessorService['getOrLoadTrace']>>;
      const reload = service.getOrLoadTrace(traceId).then(result => {
        reloadResult = result;
        reloadSettled = true;
      });
      for (let attempt = 0; attempt < 20 && !reloadSettled; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      const reloadFailedClosedBeforeCreationResolved = reloadSettled && reloadResult === undefined;

      gate.resolve(created);
      await Promise.allSettled([processing, deletion, reload]);

      expect(reloadFailedClosedBeforeCreationResolved).toBe(true);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(service.getTrace(traceId)).toBeUndefined();
      expect((service as any).processors.has(traceId)).toBe(false);
      await expect(fs.access(tracePath)).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('discards an external RPC registration that resolves after trace deletion starts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-external-register-'));
    try {
      const traceId = 'trace-delete-external-register';
      const service = new TraceProcessorService(tmpDir);
      const created = fakeProcessor('external-created-after-delete', traceId);
      const gate = deferred<TraceProcessor>();
      jest.spyOn(TraceProcessorFactory, 'createFromExternalRpc')
        .mockImplementation(async () => gate.promise as Promise<any>);
      const processed = jest.fn();
      service.on('trace-processed', processed);

      const registration = service.registerExternalRpc(traceId, 9816, 'external trace');
      await flushPromises();
      expect(service.getTrace(traceId)).toBeDefined();

      let deletionSettled = false;
      const deletion = service.deleteTrace(traceId).then(() => {
        deletionSettled = true;
      });
      await flushPromises();
      const deletionJoinedRegistration = !deletionSettled;

      gate.resolve(created);
      await expect(registration).rejects.toThrow(`Trace ${traceId} changed during processor creation`);
      await deletion;

      expect(deletionJoinedRegistration).toBe(true);
      expect(service.getTrace(traceId)).toBeUndefined();
      expect((service as any).processors.has(traceId)).toBe(false);
      expect(created.destroy).toHaveBeenCalledTimes(1);
      expect(processed).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('deletes one same-port external RPC alias without removing the other alias', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-external-alias-'));
    try {
      jest.spyOn(ExternalRpcProcessor.prototype, 'queryHealth')
        .mockResolvedValue({ok: true, durationMs: 1} as never);
      const service = new TraceProcessorService(tmpDir);
      await service.registerExternalRpc('trace-alias-a', 9817, 'alias a');
      const shared = TraceProcessorFactory.get('trace-alias-a')!;
      const destroySpy = jest.spyOn(shared, 'destroy');
      await service.registerExternalRpc('trace-alias-b', 9817, 'alias b');

      expect(TraceProcessorFactory.get('trace-alias-b')).toBe(shared);
      expect((service as any).processors.get('trace-alias-b')).toBe(shared);

      await service.deleteTrace('trace-alias-b');

      expect(service.getTrace('trace-alias-b')).toBeUndefined();
      expect((service as any).processors.has('trace-alias-b')).toBe(false);
      expect(TraceProcessorFactory.get('trace-alias-b')).toBeUndefined();
      expect(service.getTrace('trace-alias-a')).toBeDefined();
      expect((service as any).processors.get('trace-alias-a')).toBe(shared);
      expect(TraceProcessorFactory.get('trace-alias-a')).toBe(shared);
      expect(destroySpy).not.toHaveBeenCalled();

      await service.deleteTrace('trace-alias-a');
      expect(TraceProcessorFactory.get('trace-alias-a')).toBeUndefined();
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps the first external alias alive when deletion races second-alias publication', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-delete-external-alias-race-'));
    try {
      jest.spyOn(ExternalRpcProcessor.prototype, 'queryHealth')
        .mockResolvedValue({ok: true, durationMs: 1} as never);
      const service = new TraceProcessorService(tmpDir);
      await service.registerExternalRpc('trace-alias-race-a', 9818, 'alias race a');
      const shared = TraceProcessorFactory.get('trace-alias-race-a')!;
      const destroySpy = jest.spyOn(shared, 'destroy');
      const gate = deferred<TraceProcessor>();
      jest.spyOn(TraceProcessorFactory, 'createFromExternalRpc')
        .mockImplementationOnce(async traceId => {
          (TraceProcessorFactory as any).processors.set(traceId, shared);
          return gate.promise as Promise<any>;
        });

      const secondRegistration = service.registerExternalRpc(
        'trace-alias-race-b',
        9818,
        'alias race b',
      );
      await flushPromises();
      expect(TraceProcessorFactory.get('trace-alias-race-b')).toBe(shared);
      expect((service as any).processors.has('trace-alias-race-b')).toBe(false);

      const deletion = service.deleteTrace('trace-alias-race-b');
      await flushPromises();
      expect(TraceProcessorFactory.get('trace-alias-race-b')).toBeUndefined();
      expect(TraceProcessorFactory.get('trace-alias-race-a')).toBe(shared);

      gate.resolve(shared);
      await expect(secondRegistration).rejects.toThrow(
        'Trace trace-alias-race-b changed during processor creation',
      );
      await deletion;

      expect(service.getTrace('trace-alias-race-a')).toBeDefined();
      expect((service as any).processors.get('trace-alias-race-a')).toBe(shared);
      expect(TraceProcessorFactory.get('trace-alias-race-a')).toBe(shared);
      expect(destroySpy).not.toHaveBeenCalled();

      await service.deleteTrace('trace-alias-race-a');
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('canonicalizes different shared lease ids to one trace processor creation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-shared-lease-canonical-'));
    try {
      const traceId = 'trace-shared-canonical';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(traceId, 'trace-shared-canonical.trace', 11, tracePath);

      const created = fakeProcessor('shared-canonical', traceId);
      const gate = deferred<TraceProcessor>();
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => gate.promise as Promise<any>);

      const first = service.ensureProcessorForLease(traceId, 'shared-lease-a', 'shared');
      const second = service.ensureProcessorForLease(traceId, 'shared-lease-b', 'shared');

      await Promise.resolve();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(traceId, tracePath, expect.objectContaining({
        processorKey: traceId,
        leaseId: 'shared-lease-a',
        leaseMode: 'shared',
      }));

      gate.resolve(created);
      await expect(Promise.all([first, second])).resolves.toEqual([created, created]);
      expect((service as any).processors.get(traceId)).toBe(created);
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it('does not destroy an initializing processor before restarting the same lease key', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-restart-initializing-'));
    try {
      const traceId = 'trace-restart-initializing';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);
      const processorKey = `${traceId}:lease:${leaseId}`;

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [0],
        jitterMs: 0,
      });
      await service.initializeUploadWithId(traceId, 'trace-restart-initializing.trace', 11, tracePath);

      const initializing = fakeProcessor('initializing-processor', traceId);
      initializing.status = 'initializing';
      const replacement = fakeProcessor('replacement-processor', traceId);
      const initialGate = deferred<TraceProcessor>();
      let createCount = 0;
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async (_traceId, _tracePath, options) => {
          createCount += 1;
          if (createCount === 1) {
            (TraceProcessorFactory as any).processors.set(options?.processorKey, initializing);
            return initialGate.promise as Promise<any>;
          }
          return replacement as any;
        });

      const initialCreate = service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope);
      await Promise.resolve();
      expect(createSpy).toHaveBeenCalledTimes(1);

      const restart = service.restartLease(traceId, leaseId, 'isolated', scope);
      await Promise.resolve();
      expect(initializing.destroy).not.toHaveBeenCalled();

      initialGate.reject(new Error('initial spawn failed'));
      await expect(initialCreate).rejects.toThrow('initial spawn failed');
      await expect(restart).resolves.toBe(replacement);

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect((service as any).processors.get(processorKey)).toBe(replacement);
      expect(store.getLeaseById(scope, leaseId)).toMatchObject({
        id: leaseId,
        state: 'active',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('joins a successful ordinary retry that starts while restart observes a failed creation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-restart-retry-race-'));
    try {
      const traceId = 'trace-restart-retry-race';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);
      const processorKey = `${traceId}:lease:${leaseId}`;
      const restartGate = deferred<void>();
      let restartSleepCalled = false;

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [1],
        jitterMs: 0,
        sleep: async () => {
          restartSleepCalled = true;
          return restartGate.promise;
        },
      });
      await service.initializeUploadWithId(traceId, 'trace-restart-retry-race.trace', 11, tracePath);

      const generation1 = fakeProcessor('generation-1', traceId);
      generation1.status = 'initializing';
      const generation2 = fakeProcessor('generation-2', traceId);
      generation2.status = 'initializing';
      const generation1Gate = deferred<TraceProcessor>();
      const generation2Gate = deferred<TraceProcessor>();
      let createCount = 0;
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async (_traceId, _tracePath, options) => {
          createCount += 1;
          if (createCount === 1) {
            (TraceProcessorFactory as any).processors.set(options?.processorKey, generation1);
            return generation1Gate.promise as Promise<any>;
          }
          if (createCount === 2) {
            (TraceProcessorFactory as any).processors.set(options?.processorKey, generation2);
            return generation2Gate.promise as Promise<any>;
          }
          throw new Error(`unexpected generation ${createCount} for ${options?.processorKey}`);
        });

      const initialCreate = service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope);
      await Promise.resolve();
      expect(createSpy).toHaveBeenCalledTimes(1);

      const restart = service.restartLease(traceId, leaseId, 'isolated', scope);
      await Promise.resolve();
      expect(restartSleepCalled).toBe(true);
      const ordinaryRetry = initialCreate.catch(() =>
        service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope),
      );

      generation1Gate.reject(new Error('generation 1 failed'));
      await expect(initialCreate).rejects.toThrow('generation 1 failed');
      await flushPromises();

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(generation2.destroy).not.toHaveBeenCalled();

      restartGate.resolve();
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(2);

      generation2.status = 'ready';
      generation2Gate.resolve(generation2);

      await expect(ordinaryRetry).resolves.toBe(generation2);
      await expect(restart).resolves.toBe(generation2);

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(generation2.destroy).not.toHaveBeenCalled();
      expect((service as any).processors.get(processorKey)).toBe(generation2);
      expect(store.getLeaseById(scope, leaseId)).toMatchObject({
        id: leaseId,
        state: 'active',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cancels a claimed restart during cleanup without starting a replacement', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-cleanup-restart-'));
    try {
      const traceId = 'trace-cleanup-restart';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);
      const processorKey = `${traceId}:lease:${leaseId}`;
      const restartGate = deferred<void>();
      let restartSleepCalled = false;

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [1],
        jitterMs: 0,
        sleep: async () => {
          restartSleepCalled = true;
          return restartGate.promise;
        },
      });
      await service.initializeUploadWithId(traceId, 'trace-cleanup-restart.trace', 11, tracePath);

      const current = fakeProcessor('current-processor', traceId);
      current.status = 'error';
      const generation2 = fakeProcessor('generation-2', traceId);
      (service as any).processors.set(processorKey, current);
      (TraceProcessorFactory as any).processors.set(processorKey, current);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockResolvedValue(generation2 as any);

      const restart = service.restartLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(restartSleepCalled).toBe(true);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(true);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(true);

      const cleanupResult = service.cleanupLeaseProcessor(traceId, leaseId, 'isolated');

      expect(cleanupResult).toBe(true);
      expect(current.destroy).toHaveBeenCalledTimes(1);
      expect((service as any).processors.has(processorKey)).toBe(false);
      expect((TraceProcessorFactory as any).processors.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(true);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(true);

      const ensureDuringCleanup = service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(createSpy).not.toHaveBeenCalled();

      restartGate.resolve();
      await expect(restart).rejects.toThrow(/cancel/i);
      await expect(ensureDuringCleanup).rejects.toThrow(/cancel/i);

      expect(createSpy).not.toHaveBeenCalled();
      expect((service as any).processors.has(processorKey)).toBe(false);
      expect((TraceProcessorFactory as any).processors.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartCancelledOwnerTokens.has(processorKey)).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cancels a pending replacement restart after cleanup when creation resolves late', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-cleanup-pending-resolve-'));
    try {
      const traceId = 'trace-cleanup-pending-resolve';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);
      const processorKey = `${traceId}:lease:${leaseId}`;

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [0],
        jitterMs: 0,
      });
      await service.initializeUploadWithId(traceId, 'trace-cleanup-pending-resolve.trace', 11, tracePath);

      const current = fakeProcessor('current-processor', traceId);
      current.status = 'error';
      const generation2 = fakeProcessor('generation-2', traceId);
      const generation2Gate = deferred<TraceProcessor>();
      (service as any).processors.set(processorKey, current);
      (TraceProcessorFactory as any).processors.set(processorKey, current);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => generation2Gate.promise as Promise<any>);

      const restart = service.restartLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(current.destroy).toHaveBeenCalledTimes(1);
      expect((service as any).processors.has(processorKey)).toBe(false);

      expect(service.cleanupLeaseProcessor(traceId, leaseId, 'isolated')).toBe(true);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(true);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(true);
      const ensureDuringCleanup = service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);

      generation2.status = 'ready';
      generation2Gate.resolve(generation2);

      await expect(restart).rejects.toThrow(/cancel/i);
      await expect(ensureDuringCleanup).rejects.toThrow(/cancel/i);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(generation2.destroy).toHaveBeenCalledTimes(1);
      expect((service as any).processors.has(processorKey)).toBe(false);
      expect((TraceProcessorFactory as any).processors.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartCancelledOwnerTokens.has(processorKey)).toBe(false);
      expect(store.getLeaseById(scope, leaseId)).not.toMatchObject({ state: 'failed' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cancels a pending replacement restart after cleanup when creation rejects', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-lease-cleanup-pending-reject-'));
    try {
      const traceId = 'trace-cleanup-pending-reject';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      db = new Database(':memory:');
      applyEnterpriseMinimalSchema(db);
      seedEnterpriseGraph(db, traceId);
      const store = new TraceProcessorLeaseStore(db);
      setTraceProcessorLeaseStoreForTests(store);
      const leaseId = createActiveLease(store, traceId);
      const processorKey = `${traceId}:lease:${leaseId}`;

      const service = new TraceProcessorService(tmpDir, {
        backoffMs: [0],
        jitterMs: 0,
      });
      await service.initializeUploadWithId(traceId, 'trace-cleanup-pending-reject.trace', 11, tracePath);

      const current = fakeProcessor('current-processor', traceId);
      current.status = 'error';
      const generation2Gate = deferred<TraceProcessor>();
      (service as any).processors.set(processorKey, current);
      (TraceProcessorFactory as any).processors.set(processorKey, current);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async () => generation2Gate.promise as Promise<any>);

      const restart = service.restartLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(current.destroy).toHaveBeenCalledTimes(1);
      expect((service as any).processors.has(processorKey)).toBe(false);

      expect(service.cleanupLeaseProcessor(traceId, leaseId, 'isolated')).toBe(true);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(true);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(true);
      const ensureDuringCleanup = service.ensureProcessorForLease(traceId, leaseId, 'isolated', scope);
      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(1);

      generation2Gate.reject(new Error('spawn failed after cleanup'));

      await expect(restart).rejects.toThrow(/cancel/i);
      await expect(ensureDuringCleanup).rejects.toThrow(/cancel/i);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect((service as any).processors.has(processorKey)).toBe(false);
      expect((TraceProcessorFactory as any).processors.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartInProgress.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartOwnerTokens.has(processorKey)).toBe(false);
      expect((service as any).leaseRestartCancelledOwnerTokens.has(processorKey)).toBe(false);
      expect(store.getLeaseById(scope, leaseId)).not.toMatchObject({ state: 'failed' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
