// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import fs from 'fs/promises';
import nodeFs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {traceProcessorConfig} from '../../config';
import {getPortPool, resetPortPool} from '../portPool';
import {
  decodeQueryArgsSql,
  encodeQueryResult,
} from '../traceProcessorProtobuf';
import {
  TP_ADMISSION_CONTROL_ENV,
  TP_ESTIMATE_MULTIPLIER_ENV,
  TP_MIN_ESTIMATE_BYTES_ENV,
  TP_RAM_BUDGET_BYTES_ENV,
} from '../traceProcessorRamBudget';
import {
  ExternalRpcProcessor,
  QueryResult,
  TraceProcessorFactory,
  WorkingTraceProcessor,
} from '../workingTraceProcessor';
import {
  TraceProcessorService,
  type TraceProcessor,
} from '../traceProcessorService';
import * as managedSource from '../capabilityManifestRuntimeIdentity';
import * as nativeProvenance from '../evidence/rawSqlNativeProvenance';
import {TraceProcessorSqlWorker} from '../traceProcessorSqlWorker';

function okResult(rows: unknown[][] = []): QueryResult {
  return {
    columns: rows[0]?.map((_, index) => `c${index}`) ?? [],
    rows,
    durationMs: 1,
  };
}

function fakeServiceProcessor(id: string, traceId: string): TraceProcessor {
  return {
    id,
    traceId,
    status: 'ready',
    activeQueries: 0,
    query: jest.fn(async () => okResult([[id]])),
    queryRaw: jest.fn(async (body: Buffer) => Buffer.from(`${id}:${body.toString('utf8')}`)),
    destroy: jest.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('WorkingTraceProcessor enterprise isolation anchors', () => {
  const originalAdmissionEnv = {
    admission: process.env[TP_ADMISSION_CONTROL_ENV],
    budget: process.env[TP_RAM_BUDGET_BYTES_ENV],
    multiplier: process.env[TP_ESTIMATE_MULTIPLIER_ENV],
    minEstimate: process.env[TP_MIN_ESTIMATE_BYTES_ENV],
  };

  beforeEach(() => {
    TraceProcessorFactory.cleanup();
    resetPortPool();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    TraceProcessorFactory.cleanup();
    resetPortPool();
    restoreEnvValue(TP_ADMISSION_CONTROL_ENV, originalAdmissionEnv.admission);
    restoreEnvValue(TP_RAM_BUDGET_BYTES_ENV, originalAdmissionEnv.budget);
    restoreEnvValue(TP_ESTIMATE_MULTIPLIER_ENV, originalAdmissionEnv.multiplier);
    restoreEnvValue(TP_MIN_ESTIMATE_BYTES_ENV, originalAdmissionEnv.minEstimate);
  });

  it('defaults trace processor query timeout to 24 hours', () => {
    expect(traceProcessorConfig.queryTimeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it('does not destroy an owned processor when a single HTTP query hits the wall-clock timeout', async () => {
    jest.useFakeTimers();

    const request = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    }) as unknown as http.ClientRequest;
    const requestDestroy = (request as any).destroy as jest.Mock;

    jest.spyOn(http, 'request').mockImplementation((() => request) as any);

    const processor = new WorkingTraceProcessor('trace-timeout', '/tmp/missing.trace');
    (processor as any).status = 'ready';
    (processor as any).serverReady = true;
    (processor as any)._criticalModulesLoaded = true;
    const destroySpy = jest.spyOn(processor, 'destroy');

    const resultPromise = processor.query('SELECT 1');
    await flushPromises();
    jest.advanceTimersByTime(traceProcessorConfig.queryTimeoutMs + 1);

    await expect(resultPromise).resolves.toMatchObject({error: 'Query timeout'});
    expect(requestDestroy).toHaveBeenCalledTimes(1);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(processor.status).toBe('ready');

    processor.destroy();
  });

  it('applies the same wall-clock timeout to external raw RPC queries', async () => {
    jest.useFakeTimers();

    const request = Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    }) as unknown as http.ClientRequest;
    const requestDestroy = (request as any).destroy as jest.Mock;
    let requestOptions: any;

    jest.spyOn(http, 'request').mockImplementation(((options: any) => {
      requestOptions = options;
      return request;
    }) as any);

    const processor = new ExternalRpcProcessor('trace-external-timeout', 9814);
    const resultPromise = processor._execRaw('SELECT 1');
    await flushPromises();

    expect(requestOptions).toEqual(expect.objectContaining({
      port: 9814,
      timeout: traceProcessorConfig.queryTimeoutMs,
    }));

    jest.advanceTimersByTime(traceProcessorConfig.queryTimeoutMs + 1);

    await expect(resultPromise).rejects.toThrow('Query timeout');
    expect(requestDestroy).toHaveBeenCalledTimes(1);
  });

  it('runs health SELECT 1 on a dedicated channel outside the SQL worker queue', async () => {
    const processor = new ExternalRpcProcessor('trace-health', 9815);
    const enqueueRawSpy = jest.spyOn((processor as any).sqlWorker, 'enqueueRaw');
    const observedSql: string[] = [];

    jest.spyOn(http, 'request').mockImplementation(((options: any, callback: any) => {
      const request = Object.assign(new EventEmitter(), {
        destroy: jest.fn(),
        write: jest.fn((body: Buffer) => {
          observedSql.push(decodeQueryArgsSql(Buffer.from(body)));
        }),
        end: jest.fn(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(response);
          response.emit('data', encodeQueryResult({
            columnNames: ['ok'],
            rows: [[1]],
          }));
          response.emit('end');
        }),
      }) as unknown as http.ClientRequest;
      expect(options).toEqual(expect.objectContaining({
        port: 9815,
        path: '/query',
        timeout: traceProcessorConfig.healthQueryTimeoutMs,
      }));
      return request;
    }) as any);

    await expect(processor.queryHealth()).resolves.toMatchObject({ ok: true });
    expect(observedSql).toEqual(['SELECT 1']);
    expect(enqueueRawSpy).not.toHaveBeenCalled();
  });

  it('runs critical stdlib includes before the first external user query', async () => {
    const processor = new ExternalRpcProcessor('trace-external', 9811);
    const calls: string[] = [];
    jest.spyOn(processor as any, '_execRaw').mockImplementation((async (sql: string) => {
      calls.push(sql);
      return okResult([[sql]]);
    }) as any);

    await expect(processor.query('SELECT user_query')).resolves.toMatchObject({rows: [['SELECT user_query']]});

    expect(calls).toHaveLength(4);
    expect(calls.slice(0, 3).every(sql => sql.startsWith('INCLUDE PERFETTO MODULE '))).toBe(true);
    expect(calls[3]).toBe('SELECT user_query');
  });

  it('serializes external RPC user queries and tracks queued work as active', async () => {
    const processor = new ExternalRpcProcessor('trace-external', 9812);
    (processor as any)._criticalModulesLoaded = true;

    const first = deferred<QueryResult>();
    const second = deferred<QueryResult>();
    const calls: string[] = [];

    jest.spyOn(processor as any, '_execRaw').mockImplementation(((sql: string) => {
      calls.push(sql);
      if (sql === 'SELECT 1') return first.promise;
      return second.promise;
    }) as any);

    const firstQuery = processor.query('SELECT 1');
    const secondQuery = processor.query('SELECT 2');
    await flushPromises();

    expect(calls).toEqual(['SELECT 1']);
    expect(processor.activeQueries).toBe(2);

    first.resolve(okResult([[1]]));
    await expect(firstQuery).resolves.toMatchObject({rows: [[1]]});
    await flushPromises();

    expect(calls).toEqual(['SELECT 1', 'SELECT 2']);
    expect(processor.activeQueries).toBe(1);

    second.resolve(okResult([[2]]));
    await expect(secondQuery).resolves.toMatchObject({rows: [[2]]});
    expect(processor.activeQueries).toBe(0);
  });

  it('deduplicates external RPC wrappers by port and keeps aliases alive until the last remove', async () => {
    jest
      .spyOn(ExternalRpcProcessor.prototype, 'queryHealth')
      .mockResolvedValue({ ok: true, durationMs: 1 } as never);

    const first = await TraceProcessorFactory.createFromExternalRpc('trace-a', 9813);
    const destroySpy = jest.spyOn(first, 'destroy');
    const second = await TraceProcessorFactory.createFromExternalRpc('trace-b', 9813);

    expect(second).toBe(first);
    expect(TraceProcessorFactory.get('trace-a')).toBe(first);
    expect(TraceProcessorFactory.get('trace-b')).toBe(first);

    expect(TraceProcessorFactory.remove('trace-a')).toBe(true);
    expect(destroySpy).not.toHaveBeenCalled();
    expect(TraceProcessorFactory.get('trace-b')).toBe(first);

    expect(TraceProcessorFactory.remove('trace-b')).toBe(true);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects owned processor creation before spawn when RAM admission is over budget', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-tp-admission-'));
    const tracePath = path.join(tmpDir, 'trace-a.perfetto');
    await fs.writeFile(tracePath, Buffer.alloc(4096));
    process.env[TP_ADMISSION_CONTROL_ENV] = 'true';
    process.env[TP_RAM_BUDGET_BYTES_ENV] = '1';
    process.env[TP_ESTIMATE_MULTIPLIER_ENV] = '1';
    process.env[TP_MIN_ESTIMATE_BYTES_ENV] = '1024';

    try {
      await expect(TraceProcessorFactory.create('trace-admission', tracePath))
        .rejects.toMatchObject({ name: 'TraceProcessorAdmissionError' });
      expect(TraceProcessorFactory.get('trace-admission')).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('lets only one of two different groups reserve the last strict child slot while starting', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-slot-'));
    const tracePath = path.join(root, 'trace'); await fs.writeFile(tracePath, 'trace bytes');
    const previousMax = (TraceProcessorFactory as any).maxProcessors;
    (TraceProcessorFactory as any).maxProcessors = 1;
    process.env[TP_ADMISSION_CONTROL_ENV] = 'false';
    const gate = deferred<void>();
    const initialize = jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {
      await gate.promise; this.status = 'ready';
    });
    const first = TraceProcessorFactory.create('trace-a', tracePath, {processorKey: 'group-a-child', leaseId: 'group-a',
      leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true});
    try {
      expect(TraceProcessorFactory.get('group-a-child')?.status).toBe('initializing');
      await expect(TraceProcessorFactory.create('trace-b', tracePath, {processorKey: 'group-b-child', leaseId: 'group-b',
        leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true})).rejects.toMatchObject({code: 'native_child_slot_unavailable'});
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(TraceProcessorFactory.get('group-b-child')).toBeUndefined();
      gate.resolve(); const child = await first;
      expect(TraceProcessorFactory.isPrivateAnalysisPort(child.httpPort)).toBe(true);
    } finally {gate.resolve(); await first.catch(() => undefined); TraceProcessorFactory.cleanup();
      (TraceProcessorFactory as any).maxProcessors = previousMax; await fs.rm(root, {recursive: true, force: true});}
  });

  it('rechecks the strict slot on a port retry after another group wins the released slot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-retry-'));
    const tracePath = path.join(root, 'trace'); await fs.writeFile(tracePath, 'trace bytes');
    const previousMax = (TraceProcessorFactory as any).maxProcessors;
    (TraceProcessorFactory as any).maxProcessors = 1;
    process.env[TP_ADMISSION_CONTROL_ENV] = 'false';
    const gate = deferred<void>();
    const initialize = jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {
      if (this.traceId === 'trace-a') throw new Error(`PORT_IN_USE:${this.httpPort}`);
      await gate.promise; this.status = 'ready';
    });
    let competitor: Promise<WorkingTraceProcessor> | undefined;
    const pool = getPortPool(), originalBlock = pool.blockPort.bind(pool);
    jest.spyOn(pool, 'blockPort').mockImplementation(port => {
      originalBlock(port);
      competitor = TraceProcessorFactory.create('trace-b', tracePath, {processorKey: 'group-b-child', leaseId: 'group-b',
        leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true});
    });
    try {
      await expect(TraceProcessorFactory.create('trace-a', tracePath, {processorKey: 'group-a-child', leaseId: 'group-a',
        leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true})).rejects.toMatchObject({code: 'native_child_slot_unavailable'});
      expect(initialize).toHaveBeenCalledTimes(2); // A's failed port and B's reserved starting slot, no A replacement.
      expect(TraceProcessorFactory.get('group-a-child')).toBeUndefined();
      expect(TraceProcessorFactory.get('group-b-child')?.status).toBe('initializing');
      gate.resolve(); await competitor;
    } finally {gate.resolve(); await competitor?.catch(() => undefined); TraceProcessorFactory.cleanup();
      (TraceProcessorFactory as any).maxProcessors = previousMax; await fs.rm(root, {recursive: true, force: true});}
  });

  it('rechecks the strict child slot after an actual allocated listener synchronously starts another group', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-reentry-'));
    const tracePath = path.join(root, 'trace'); await fs.writeFile(tracePath, 'trace bytes');
    const previousMax = (TraceProcessorFactory as any).maxProcessors;
    (TraceProcessorFactory as any).maxProcessors = 1;
    process.env[TP_ADMISSION_CONTROL_ENV] = 'false';
    const gate = deferred<void>();
    const initialize = jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {
      await gate.promise; this.status = 'ready';
    });
    const destroy = jest.spyOn(WorkingTraceProcessor.prototype, 'destroy');
    const workerDestroy = jest.spyOn(TraceProcessorSqlWorker.prototype, 'destroy');
    const pool = getPortPool();
    let competitor: Promise<WorkingTraceProcessor> | undefined;
    pool.once('allocated', () => {
      competitor = TraceProcessorFactory.create('trace-b', tracePath, {processorKey: 'group-b-child', leaseId: 'group-b',
        leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true});
      void competitor.catch(() => undefined);
    });
    const first = TraceProcessorFactory.create('trace-a', tracePath, {processorKey: 'group-a-child', leaseId: 'group-a',
      leaseMode: 'isolated', analysisRunPrivate: true, strictChildSlot: true});
    void first.catch(() => undefined);
    try {
      expect([TraceProcessorFactory.get('group-a-child'), TraceProcessorFactory.get('group-b-child')].filter(Boolean)).toHaveLength(1);
      await expect(first).rejects.toMatchObject({code: 'native_child_slot_unavailable'});
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(initialize.mock.contexts[0]).toBe(TraceProcessorFactory.get('group-b-child'));
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy.mock.contexts[0]).toMatchObject({traceId: 'trace-a', status: 'error'});
      expect(workerDestroy).toHaveBeenCalledTimes(1);
      expect(pool.getPort('group-a-child')).toBeNull();
      expect(pool.getStats().allocated).toBe(1);
      gate.resolve(); const child = await competitor!;
      expect(pool.getPort('group-b-child')).toBe(child.httpPort);
    } finally {
      gate.resolve(); await Promise.allSettled([first, competitor]); TraceProcessorFactory.cleanup();
      (TraceProcessorFactory as any).maxProcessors = previousMax;
      await fs.rm(root, {recursive: true, force: true});
    }
    expect(pool.getStats().allocated).toBe(0);
  });

  it('keeps ordinary working soft-overage behavior when existing processors are leased', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'working-soft-slot-'));
    const tracePath = path.join(root, 'trace'); await fs.writeFile(tracePath, 'trace bytes');
    const previousMax = (TraceProcessorFactory as any).maxProcessors;
    (TraceProcessorFactory as any).maxProcessors = 1;
    process.env[TP_ADMISSION_CONTROL_ENV] = 'false';
    jest.spyOn(WorkingTraceProcessor.prototype, 'initialize').mockImplementation(async function(this: WorkingTraceProcessor) {this.status = 'ready';});
    try {
      const first = await TraceProcessorFactory.create('trace-a', tracePath, {leaseId: 'lease-a'});
      const second = await TraceProcessorFactory.create('trace-b', tracePath, {leaseId: 'lease-b'});
      expect(TraceProcessorFactory.get('trace-a')).toBe(first);
      expect(TraceProcessorFactory.get('trace-b')).toBe(second);
    } finally {TraceProcessorFactory.cleanup(); (TraceProcessorFactory as any).maxProcessors = previousMax;
      await fs.rm(root, {recursive: true, force: true});}
  });

  it.each(['stable', 'changed', 'cancelled', 'destroyed'] as const)
  ('publishes a managed pin only around the first actual loader completion: %s', async outcome => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'working-loaded-pin-'));
    const original = path.join(root, 'source'), finalPath = path.join(root, 'managed');
    await fs.writeFile(original, 'trace bytes');
    const grant = (await managedSource.copyManagedTraceInput({sourcePath: original, finalPath, traceId: 'trace'}))!;
    const binding = {grant, serviceOwner: {}, registration: {}, traceId: 'trace', finalPath};
    managedSource.bindManagedTraceInput(binding);
    const gate = deferred<void>(), entered = deferred<void>();
    let current = true;
    const context = {...binding, assertCurrent: () => {if (!current) throw new Error('PRIVATE_CANCEL_CAUSE');}};
    jest.spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    jest.spyOn(nativeProvenance, 'initializeRawSqlNativeProvenance').mockResolvedValue();
    jest.spyOn(nativeProvenance, 'revalidateRawSqlNativeProvenance').mockResolvedValue();
    jest.spyOn(managedSource, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled',
      gitRevision: 'a'.repeat(40), stdlibRevision: 'a'.repeat(40)});
    const sourceEligibility = jest.spyOn(WorkingTraceProcessor.prototype, 'getNativeProvenanceSnapshot')
      .mockReturnValue({status: 'trusted', nativeSchemaEligible: true});
    jest.spyOn(WorkingTraceProcessor.prototype as any, 'startHttpServer').mockImplementation(async () => {entered.resolve(); await gate.promise;});
    jest.spyOn(WorkingTraceProcessor.prototype as any, 'executeHttpQuery').mockResolvedValue(okResult([[1]]));
    const processor = new WorkingTraceProcessor('trace', finalPath, {managedTraceInput: context});
    const work = processor.initialize(); void work.catch(() => undefined);
    try {
      await entered.promise;
      expect(processor.getLoadedTraceSourcePin()).toBeUndefined();
      if (outcome === 'changed') await fs.writeFile(finalPath, 'replacement trace bytes');
      if (outcome === 'cancelled') current = false;
      if (outcome === 'destroyed') processor.destroy();
      gate.resolve();
      if (outcome === 'destroyed') await expect(work).rejects.toThrow('Processor destroyed during initialization');
      else await work;
      const pin = processor.getLoadedTraceSourcePin();
      if (outcome === 'stable') {
        expect(pin).toBeDefined();
        sourceEligibility.mockRestore();
        processor.invalidateNativeProvenance();
        expect(processor.getLoadedTraceSourcePin()).toBe(pin); // Source bytes do not rehabilitate SQL provenance.
        expect(processor.getNativeProvenanceSnapshot().status).toBe('tainted');
        await expect(managedSource.assertLoadedTraceSourcePinCurrent(pin!, context)).resolves.toBeUndefined();
      } else expect(pin).toBeUndefined();
      if (outcome !== 'destroyed') expect(processor.status).toBe('ready'); // Optional parent qualification is not a new load gate.
    } finally {gate.resolve(); await work.catch(() => undefined); processor.destroy(); await fs.rm(root, {recursive: true, force: true});}
  });

  it('keeps legacy parent loading and native provenance initialization without a materializer grant', async () => {
    jest.spyOn(nodeFs, 'existsSync').mockReturnValue(true);
    const initializeNative = jest.spyOn(nativeProvenance, 'initializeRawSqlNativeProvenance').mockResolvedValue();
    const revalidateNative = jest.spyOn(nativeProvenance, 'revalidateRawSqlNativeProvenance').mockResolvedValue();
    const sourceIdentity = jest.spyOn(managedSource, 'resolveCapabilityTraceProcessorIdentity');
    jest.spyOn(WorkingTraceProcessor.prototype as any, 'startHttpServer').mockResolvedValue(undefined);
    jest.spyOn(WorkingTraceProcessor.prototype as any, 'executeHttpQuery').mockResolvedValue(okResult([[1]]));
    const processor = new WorkingTraceProcessor('legacy', '/fixture/legacy.trace');
    try {
      await processor.initialize();
      expect(processor.status).toBe('ready');
      expect(initializeNative).toHaveBeenCalledTimes(1); expect(revalidateNative).toHaveBeenCalledTimes(1);
      expect(sourceIdentity).not.toHaveBeenCalled(); expect(processor.getLoadedTraceSourcePin()).toBeUndefined();
    } finally {processor.destroy();}
  });

  it('shares failed creation for one lease key while an independent key can install a processor', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-tp-create-failure-'));
    try {
      const traceId = 'trace-create-failure';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');

      const service = new TraceProcessorService(tmpDir);
      await service.initializeUploadWithId(traceId, 'trace-create-failure.trace', 11, tracePath);

      const failingGate = deferred<TraceProcessor>();
      const independent = fakeServiceProcessor('independent-processor', traceId);
      const replacement = fakeServiceProcessor('replacement-processor', traceId);
      const createSpy = jest
        .spyOn(TraceProcessorFactory, 'create')
        .mockImplementation(async (_traceId, _tracePath, options) => {
          if (options?.processorKey === `${traceId}:lease:lease-independent`) {
            return independent as any;
          }
          if (options?.processorKey === `${traceId}:lease:lease-failing`) {
            return failingGate.promise as Promise<any>;
          }
          throw new Error(`unexpected processor key ${options?.processorKey}`);
        });

      const firstFailure = service.ensureProcessorForLease(traceId, 'lease-failing', 'isolated');
      const secondFailure = service.ensureProcessorForLease(traceId, 'lease-failing', 'isolated');
      const independentCreate = service.ensureProcessorForLease(traceId, 'lease-independent', 'isolated');

      await flushPromises();
      expect(createSpy).toHaveBeenCalledTimes(2);
      await expect(independentCreate).resolves.toBe(independent);

      failingGate.reject(new Error('spawn failed'));
      await expect(firstFailure).rejects.toThrow('spawn failed');
      await expect(secondFailure).rejects.toThrow('spawn failed');

      createSpy.mockImplementation(async (_traceId, _tracePath, options) => {
        if (options?.processorKey === `${traceId}:lease:lease-failing`) {
          return replacement as any;
        }
        if (options?.processorKey === `${traceId}:lease:lease-independent`) {
          return independent as any;
        }
        throw new Error(`unexpected processor key ${options?.processorKey}`);
      });

      await expect(service.ensureProcessorForLease(traceId, 'lease-failing', 'isolated'))
        .resolves.toBe(replacement);

      expect((service as any).processors.get(`${traceId}:lease:lease-failing`)).toBe(replacement);
      expect((service as any).processors.get(`${traceId}:lease:lease-independent`)).toBe(independent);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
