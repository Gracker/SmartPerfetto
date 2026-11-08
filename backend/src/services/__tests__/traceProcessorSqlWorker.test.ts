// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {createHash} from 'crypto';
import {performance as nodePerformance} from 'perf_hooks';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {
  decodeQueryArgsSql,
  encodeQueryArgs,
  encodeQueryResult,
} from '../traceProcessorProtobuf';
import {
  normalizeTraceProcessorQueryPriority,
  TraceProcessorSqlDeadlineExceededError,
  TraceProcessorSqlQueueOverloadedError,
  TraceProcessorSqlWorker,
} from '../traceProcessorSqlWorker';
import { isTraceProcessorQueryCancelledError } from '../traceProcessorCancellation';
import {
  RunManifestLifecycle,
  withRunManifestLifecycle,
} from '../selfEvolution/runManifestLifecycle';
import type {RunManifestStore} from '../selfEvolution/runManifestStore';
import {normalizeTraceProcessorSqlError} from '../traceProcessorSqlWorker';
import * as nativeIdentity from '../capabilityManifestRuntimeIdentity';
import * as nativeDocs from '../perfettoSqlDocs';
import {createRawSqlNativeProvenance, initializeRawSqlNativeProvenance,
  invalidateRawSqlNativeProvenance, readRawSqlCaptureFields} from '../evidence/rawSqlNativeProvenance';

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

function encodedSqlResult(sql: string): Buffer {
  return encodeQueryResult({
    columnNames: ['sql'],
    rows: [[sql]],
  });
}

function expectedRuntimeHash(value: string, salt = ''): string {
  return `sha256:${createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value.trim())
    .digest('hex')
    .slice(0, 32)}`;
}

function runManifestLifecycle(runId: string): RunManifestLifecycle {
  const store = {
    append: jest.fn(),
    pin: jest.fn(),
    unpin: jest.fn(),
  } as unknown as RunManifestStore;
  return new RunManifestLifecycle({
    runId,
    sessionId: `session-${runId}`,
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    runtime: 'pi-agent-core',
    providerId: null,
    outputLanguage: 'en',
    analysisMode: 'auto',
    skillRegistry: {
      registryFingerprint: 'registry-a',
      skills: [],
    },
    store,
  });
}

async function expectCancelled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isTraceProcessorQueryCancelledError(error)).toBe(true);
    return;
  }
  throw new Error('Expected promise to reject with trace processor cancellation');
}

describe('TraceProcessorSqlWorker', () => {
  let worker: TraceProcessorSqlWorker | null = null;

  afterEach(() => {
    worker?.destroy();
    worker = null;
    jest.restoreAllMocks();
  });

  it('signs typed SQL inside its queue task and invalidates opaque QueryArgs before transport', async () => {
    const revision = 'a'.repeat(40);
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    const native = createRawSqlNativeProvenance('typed-worker', []);
    await initializeRawSqlNativeProvenance(native.provenance, {source: 'local_binary', selectedPath: '/pinned', selectionOrigin: 'default'});
    const response = encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    worker = new TraceProcessorSqlWorker({processorId: 'typed-worker', traceId: 'trace-a', port: 1,
      nativeProvenance: native.provenance, rawExecutor: async () => response});
    expect(readRawSqlCaptureFields(await worker.query('SELECT dur FROM slice'))?.dur.unit).toBe('ns');
    expect(readRawSqlCaptureFields(await worker.queryBounded('SELECT dur FROM slice', {maxRows: 10, maxResponseBytes: 1000}))?.dur.unit).toBe('ns');
    await worker.enqueueRaw(encodeQueryArgs('SELECT dur FROM slice'));
    expect(readRawSqlCaptureFields(await worker.query('SELECT dur FROM slice'))).toBeUndefined();
  });

  it.each(['queued mutation', 'external epoch change'])('checks %s at the actual queue execution boundary', async cause => {
    const revision = 'a'.repeat(40);
    jest.spyOn(nativeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(nativeDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '', columns: [{name: 'dur', type: 'DURATION'}]}]});
    const native = createRawSqlNativeProvenance('epoch-worker', []);
    await initializeRawSqlNativeProvenance(native.provenance, {source: 'local_binary', selectedPath: '/pinned', selectionOrigin: 'default'});
    const first = deferred<Buffer>();
    const calls: string[] = [];
    const response = encodeQueryResult({columnNames: ['dur'], rows: [[42]]});
    worker = new TraceProcessorSqlWorker({processorId: 'epoch-worker', traceId: 'trace-a', port: 1,
      nativeProvenance: native.provenance, rawExecutor: async input => {
        calls.push(decodeQueryArgsSql(input.body));
        return calls.length === 1 ? first.promise : response;
      }});
    const pending = worker.query('SELECT dur FROM slice');
    await flushPromises();
    const afterMutation = worker.query('SELECT dur FROM slice', {priority: 'p2'});
    const mutation = worker.query('CREATE TEMP VIEW slice AS SELECT 42 AS dur', {priority: 'p0'});
    if (cause === 'external epoch change') invalidateRawSqlNativeProvenance(native.provenance);
    first.resolve(response);
    const firstFields = readRawSqlCaptureFields(await pending);
    if (cause === 'external epoch change') expect(firstFields).toBeUndefined();
    else expect(firstFields?.dur.unit).toBe('ns');
    await mutation;
    expect(readRawSqlCaptureFields(await afterMutation)).toBeUndefined();
    expect(calls).toEqual(['SELECT dur FROM slice', 'CREATE TEMP VIEW slice AS SELECT 42 AS dur', 'SELECT dur FROM slice']);
  });

  it('does not preempt the running query, but runs queued P0 before queued P1/P2', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-a',
      traceId: 'trace-a',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const p2 = worker.query('SELECT p2', { priority: 'p2' });
    await flushPromises();
    expect(started).toEqual(['SELECT p2']);

    const p1 = worker.query('SELECT p1', { priority: 'p1' });
    const p0 = worker.query('SELECT p0', { priority: 'p0' });
    await flushPromises();
    expect(started).toEqual(['SELECT p2']);
    expect(worker.getStats()).toMatchObject({
      running: true,
      queuedP0: 1,
      queuedP1: 1,
      queuedP2: 0,
    });

    gates.get('SELECT p2')!.resolve(encodedSqlResult('SELECT p2'));
    await expect(p2).resolves.toMatchObject({ rows: [['SELECT p2']] });
    await flushPromises();
    expect(started).toEqual(['SELECT p2', 'SELECT p0']);

    gates.get('SELECT p0')!.resolve(encodedSqlResult('SELECT p0'));
    await expect(p0).resolves.toMatchObject({ rows: [['SELECT p0']] });
    await flushPromises();
    expect(started).toEqual(['SELECT p2', 'SELECT p0', 'SELECT p1']);

    gates.get('SELECT p1')!.resolve(encodedSqlResult('SELECT p1'));
    await expect(p1).resolves.toMatchObject({ rows: [['SELECT p1']] });
  });

  it('keeps FIFO order inside the same priority level', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-b',
      traceId: 'trace-b',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const first = worker.query('SELECT first', { priority: 'p1' });
    await flushPromises();
    const second = worker.query('SELECT second', { priority: 'p1' });
    await flushPromises();
    expect(started).toEqual(['SELECT first']);

    gates.get('SELECT first')!.resolve(encodedSqlResult('SELECT first'));
    await expect(first).resolves.toMatchObject({ rows: [['SELECT first']] });
    await flushPromises();
    expect(started).toEqual(['SELECT first', 'SELECT second']);

    gates.get('SELECT second')!.resolve(encodedSqlResult('SELECT second'));
    await expect(second).resolves.toMatchObject({ rows: [['SELECT second']] });
  });

  it('bounds queued task count and retained request bytes', async () => {
    const gate = deferred<Buffer>();
    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-bounded',
      traceId: 'trace-bounded',
      port: 1,
      forceInline: true,
      maxQueuedTasks: 1,
      maxQueuedBytes: 4,
      rawExecutor: async () => gate.promise,
    });

    const running = worker.enqueueRaw(Buffer.from([1]));
    await flushPromises();
    const queued = worker.enqueueRaw(Buffer.from([2, 3, 4, 5]));
    await expect(worker.enqueueRaw(Buffer.from([6]))).rejects.toBeInstanceOf(
      TraceProcessorSqlQueueOverloadedError,
    );
    expect(worker.getStats()).toMatchObject({queuedP1: 1, queuedBytes: 4});

    worker.destroy();
    gate.resolve(Buffer.from([7]));
    await expect(running).resolves.toEqual(Buffer.from([7]));
    await expect(queued).rejects.toThrow(/destroyed/);
    worker = null;
  });

  it('enforces bounded query row and response-byte limits', async () => {
    const encoded = encodeQueryResult({
      columnNames: ['value'],
      rows: [[1], [2]],
    });
    const observedLimits: Array<number | undefined> = [];
    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-bounded-result',
      traceId: 'trace-bounded-result',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        observedLimits.push(request.maxResponseBytes);
        return encoded;
      },
    });

    await expect(worker.queryBounded('SELECT value', {
      maxRows: 1,
      maxResponseBytes: 1024,
    })).resolves.toMatchObject({
      rows: [],
      error: 'trace_processor_row_budget_exceeded',
    });
    expect(observedLimits).toEqual([1024]);

    await expect(worker.queryBounded('SELECT value', {
      maxRows: Number.NaN,
      maxResponseBytes: 1024,
    })).resolves.toMatchObject({
      rows: [],
      error: 'trace_processor_query_budget_invalid',
    });
    await expect(worker.queryBounded('SELECT value', {
      maxRows: 10,
      maxResponseBytes: -1,
    })).resolves.toMatchObject({
      rows: [],
      error: 'trace_processor_query_budget_invalid',
    });
    expect(observedLimits).toEqual([1024]);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/x-protobuf'});
      res.end(encoded);
    });
    await new Promise<void>(resolve =>
      server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test HTTP server did not bind to a port');
    }
    worker.destroy();
    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-bounded-response',
      traceId: 'trace-bounded-response',
      port: address.port,
      forceInline: true,
    });
    try {
      await expect(worker.queryBounded('SELECT value', {
        maxRows: 10,
        maxResponseBytes: encoded.byteLength - 1,
      })).resolves.toMatchObject({
        rows: [],
        error: 'trace_processor_response_budget_exceeded',
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('applies the query deadline while a task is waiting in the queue', async () => {
    const gate = deferred<Buffer>();
    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-deadline',
      traceId: 'trace-deadline',
      port: 1,
      forceInline: true,
      rawExecutor: async () => gate.promise,
    });

    const running = worker.enqueueRaw(Buffer.from([1]), {timeoutMs: 5_000});
    await flushPromises();
    const queued = worker.enqueueRaw(Buffer.from([2]), {timeoutMs: 10});
    await expect(queued).rejects.toBeInstanceOf(TraceProcessorSqlDeadlineExceededError);
    expect(worker.getStats()).toMatchObject({queuedP1: 0, queuedBytes: 0});

    gate.resolve(Buffer.from([3]));
    await expect(running).resolves.toEqual(Buffer.from([3]));
  });

  it('normalizes public priority names', () => {
    expect(normalizeTraceProcessorQueryPriority('interactive')).toBe('p0');
    expect(normalizeTraceProcessorQueryPriority('agent')).toBe('p1');
    expect(normalizeTraceProcessorQueryPriority('report')).toBe('p2');
    expect(normalizeTraceProcessorQueryPriority('unknown', 'p2')).toBe('p2');
  });

  it('cancels queued tasks before they start', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-cancel-queued',
      traceId: 'trace-cancel-queued',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const first = worker.query('SELECT first', { priority: 'p1' });
    await flushPromises();
    expect(started).toEqual(['SELECT first']);

    const controller = new AbortController();
    const queued = worker.query('SELECT queued', {
      priority: 'p1',
      signal: controller.signal,
    });
    await flushPromises();
    expect(worker.getStats()).toMatchObject({ running: true, queuedP1: 1 });

    controller.abort();
    await expectCancelled(queued);
    expect(worker.getStats()).toMatchObject({ running: true, queuedP1: 0 });
    expect(started).toEqual(['SELECT first']);

    gates.get('SELECT first')!.resolve(encodedSqlResult('SELECT first'));
    await expect(first).resolves.toMatchObject({ rows: [['SELECT first']] });
  });

  it('attributes SQL queue and execution timing to the run active at enqueue time', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const runA = runManifestLifecycle('run-sql-performance-a');
    const runB = runManifestLifecycle('run-sql-performance-b');

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-performance',
      traceId: 'trace-performance',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const first = withRunManifestLifecycle(runA, () =>
      worker!.query('SELECT run_a', {priority: 'p2'}));
    await flushPromises();
    const second = withRunManifestLifecycle(runB, () =>
      worker!.query('SELECT run_b', {priority: 'p0'}));
    await flushPromises();

    expect(started).toEqual(['SELECT run_a']);
    gates.get('SELECT run_a')!.resolve(encodedSqlResult('SELECT run_a'));
    await expect(first).resolves.toMatchObject({rows: [['SELECT run_a']]});
    await flushPromises();
    expect(started).toEqual(['SELECT run_a', 'SELECT run_b']);
    gates.get('SELECT run_b')!.resolve(encodedSqlResult('SELECT run_b'));
    await expect(second).resolves.toMatchObject({rows: [['SELECT run_b']]});

    const manifestA = runA.sealOnceAndPersist();
    const manifestB = runB.sealOnceAndPersist();

    expect(manifestA.performance?.sql).toEqual([
      expect.objectContaining({
        processorKeyHash: expectedRuntimeHash('trace-performance'),
        priority: 'p2',
        outcome: 'ok',
      }),
    ]);
    expect(manifestB.performance?.sql).toEqual([
      expect.objectContaining({
        processorKeyHash: expectedRuntimeHash('trace-performance'),
        priority: 'p0',
        outcome: 'ok',
      }),
    ]);
    const sqlA = manifestA.performance?.sql[0];
    const sqlB = manifestB.performance?.sql[0];
    expect(sqlA?.queueWaitMs).toEqual(expect.any(Number));
    expect(sqlA?.executionMs).toEqual(expect.any(Number));
    expect(sqlB?.queueWaitMs).toEqual(expect.any(Number));
    expect(sqlB?.executionMs).toEqual(expect.any(Number));
    expect(sqlA?.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(sqlA?.executionMs).toBeGreaterThanOrEqual(0);
    expect(sqlB?.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(sqlB?.executionMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(manifestA.performance)).not.toContain('processor-performance');
    expect(JSON.stringify(manifestA.performance)).not.toContain('trace-performance');
    expect(JSON.stringify(manifestB.performance)).not.toContain('SELECT run');
    runA.dispose();
    runB.dispose();
  });

  it('records distinct queued wait and execution durations from monotonic boundaries', async () => {
    let monotonicNow = 100;
    const nowSpy = jest.spyOn(nodePerformance, 'now').mockImplementation(() => monotonicNow);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const run = runManifestLifecycle('run-sql-controlled-timing');

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-controlled-timing',
      traceId: 'trace-controlled-timing',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    try {
      const first = withRunManifestLifecycle(run, () =>
        worker!.query('SELECT first', {priority: 'p2'}));
      await flushPromises();
      expect(started).toEqual(['SELECT first']);

      monotonicNow = 150;
      const second = withRunManifestLifecycle(run, () =>
        worker!.query('SELECT second', {priority: 'p2'}));
      await flushPromises();
      expect(started).toEqual(['SELECT first']);

      monotonicNow = 250;
      gates.get('SELECT first')!.resolve(encodedSqlResult('SELECT first'));
      await expect(first).resolves.toMatchObject({rows: [['SELECT first']]});
      await flushPromises();
      expect(started).toEqual(['SELECT first', 'SELECT second']);

      monotonicNow = 290;
      gates.get('SELECT second')!.resolve(encodedSqlResult('SELECT second'));
      await expect(second).resolves.toMatchObject({rows: [['SELECT second']]});

      const receipt = run.sealOnceAndPersist().performance?.sql ?? [];
      expect(receipt).toHaveLength(2);
      expect(receipt[1]).toEqual(expect.objectContaining({
        queueWaitMs: 100,
        executionMs: 40,
        outcome: 'ok',
      }));
      expect(receipt[1].queueWaitMs).not.toBe(receipt[1].executionMs);
    } finally {
      nowSpy.mockRestore();
      run.dispose();
    }
  });

  it('records queued SQL cancellation without executing the cancelled query', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const run = runManifestLifecycle('run-sql-performance-cancel');

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-performance-cancel',
      traceId: 'trace-performance-cancel',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const first = withRunManifestLifecycle(run, () =>
      worker!.query('SELECT running'));
    await flushPromises();
    const controller = new AbortController();
    const queued = withRunManifestLifecycle(run, () =>
      worker!.query('SELECT cancelled', {signal: controller.signal}));
    await flushPromises();

    controller.abort();
    await expectCancelled(queued);
    gates.get('SELECT running')!.resolve(encodedSqlResult('SELECT running'));
    await expect(first).resolves.toMatchObject({rows: [['SELECT running']]});

    const manifest = run.sealOnceAndPersist();

    expect(started).toEqual(['SELECT running']);
    expect(manifest.performance?.sql).toEqual([
      expect.objectContaining({outcome: 'cancelled', executionMs: 0}),
      expect.objectContaining({outcome: 'ok'}),
    ]);
    for (const sql of manifest.performance?.sql ?? []) {
      expect(sql.queueWaitMs).toEqual(expect.any(Number));
      expect(sql.executionMs).toEqual(expect.any(Number));
      expect(sql.queueWaitMs).toBeGreaterThanOrEqual(0);
      expect(sql.executionMs).toBeGreaterThanOrEqual(0);
    }
    run.dispose();
  });

  it('records isolated and shared processor key hashes from the exact canonical owner keys', async () => {
    const run = runManifestLifecycle('run-sql-performance-keys');
    const sharedWorker = new TraceProcessorSqlWorker({
      processorId: 'processor-shared',
      traceId: 'trace-shared',
      processorKey: 'trace-shared',
      port: 1,
      forceInline: true,
      rawExecutor: async request =>
        encodedSqlResult(decodeQueryArgsSql(request.body)),
    });
    const isolatedWorker = new TraceProcessorSqlWorker({
      processorId: 'processor-isolated',
      traceId: 'trace-isolated',
      processorKey: 'trace-isolated:lease:lease-a',
      port: 1,
      forceInline: true,
      rawExecutor: async request =>
        encodedSqlResult(decodeQueryArgsSql(request.body)),
    });

    await withRunManifestLifecycle(run, () =>
      sharedWorker.query('SELECT shared'));
    await withRunManifestLifecycle(run, () =>
      isolatedWorker.query('SELECT isolated'));

    const manifest = run.sealOnceAndPersist();

    expect(manifest.performance?.sql.map(item => item.processorKeyHash)).toEqual([
      expectedRuntimeHash('trace-shared'),
      expectedRuntimeHash('trace-isolated:lease:lease-a'),
    ]);
    expect(JSON.stringify(manifest.performance)).not.toContain('processor-shared');
    expect(JSON.stringify(manifest.performance)).not.toContain('processor-isolated');
    expect(JSON.stringify(manifest.performance)).not.toContain('trace-shared');
    expect(JSON.stringify(manifest.performance)).not.toContain('trace-isolated');
    expect(JSON.stringify(manifest.performance)).not.toContain('lease-a');
    sharedWorker.destroy();
    isolatedWorker.destroy();
    run.dispose();
  });

  it('rejects a running task on abort and drains the next task', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Buffer>>>();

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-cancel-running',
      traceId: 'trace-cancel-running',
      port: 1,
      forceInline: true,
      rawExecutor: async request => {
        const sql = decodeQueryArgsSql(request.body);
        started.push(sql);
        const gate = gates.get(sql) || deferred<Buffer>();
        gates.set(sql, gate);
        return gate.promise;
      },
    });

    const controller = new AbortController();
    const running = worker.query('SELECT slow', { signal: controller.signal });
    await flushPromises();
    expect(started).toEqual(['SELECT slow']);

    controller.abort();
    await expectCancelled(running);
    await flushPromises();
    expect(worker.getStats()).toMatchObject({ running: false, queuedP1: 0 });

    const next = worker.query('SELECT next');
    await flushPromises();
    expect(started).toEqual(['SELECT slow', 'SELECT next']);
    gates.get('SELECT next')!.resolve(encodedSqlResult('SELECT next'));
    await expect(next).resolves.toMatchObject({ rows: [['SELECT next']] });

    gates.get('SELECT slow')!.resolve(encodedSqlResult('SELECT slow'));
  });

  it('starts the source worker when the main Node starts with an ESM preload, queries, and tears down', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-worker-preload-'));
    const preloadPath = path.join(fixtureRoot, 'preload.mjs');
    const markerPath = path.join(fixtureRoot, 'main-preload.json');
    const childPath = path.join(fixtureRoot, 'probe.cjs');
    fs.writeFileSync(preloadPath, [
      'import {isMainThread, threadId} from "node:worker_threads";',
      'import {writeFileSync} from "node:fs";',
      `if (isMainThread) writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({isMainThread, threadId}));`,
    ].join('\n'));
    fs.writeFileSync(childPath, [
      'require(process.argv[2]);',
      'const {Worker} = require("node:worker_threads");',
      'const {once} = require("node:events");',
      'const {TraceProcessorSqlWorker} = require(process.argv[3]);',
      'const worker = new TraceProcessorSqlWorker({processorId: "source-worker-preload", traceId: "trace-preload", port: Number(process.argv[4]), forceInline: false});',
      '(async () => {',
      '  try {',
      '    const result = await worker.query("SELECT 1 AS test", {timeoutMs: 5000});',
      '    if (result.error) throw new Error(result.error);',
      '    const usesWorkerThread = worker.getStats().usesWorkerThread;',
      // Test-only probe of the actual runtime object; do not add a product API
      // or mistake usesWorkerThread's configuration flag for execution evidence.
      '    const thread = worker.worker;',
      '    if (!(thread instanceof Worker) || thread.threadId <= 0) throw new Error("SQL worker thread did not start");',
      '    const workerThreadId = thread.threadId;',
      '    const exited = once(thread, "exit");',
      '    worker.destroy();',
      '    await exited;',
      '    let destroyedRejected = false;',
      '    try { await worker.enqueueRaw(Buffer.from([1]), {timeoutMs: 1000}); }',
      '    catch (error) { destroyedRejected = /destroyed/.test(error.message); }',
      '    console.log("WORKER_PROBE=" + JSON.stringify({result, usesWorkerThread, workerThreadId, threadExited: true, destroyedRejected}));',
      '  } finally { worker.destroy(); }',
      '})().catch(error => { console.error(error.message); process.exitCode = 1; });',
    ].join('\n'));
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.writeHead(200, {'Content-Type': 'application/x-protobuf'});
        res.end(encodedSqlResult(decodeQueryArgsSql(Buffer.concat(chunks))));
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      // Node parses NODE_OPTIONS preloads at process startup, not when a running
      // Jest process mutates process.env. Exercise that exact startup boundary.
      const probe = await new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
        const child = spawn(process.execPath, [childPath, require.resolve('tsx/cjs'),
          path.resolve(__dirname, '../traceProcessorSqlWorker.ts'), String(address.port)], {
          env: {...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preloadPath).href}`.trim()},
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => {stdout += chunk.toString();});
        child.stderr.on('data', chunk => {stderr += chunk.toString();});
        const timeout = setTimeout(() => child.kill('SIGTERM'), 10_000);
        child.once('error', error => {clearTimeout(timeout); reject(error);});
        child.once('close', code => {clearTimeout(timeout); resolve({code, stdout, stderr});});
      });
      expect(probe).toMatchObject({code: 0, stderr: ''});
      const payload = probe.stdout.split('\n').find(line => line.startsWith('WORKER_PROBE='));
      expect(payload).toBeDefined();
      const result = JSON.parse(payload!.slice('WORKER_PROBE='.length));
      expect(result).toMatchObject({result: {rows: [['SELECT 1 AS test']]}, usesWorkerThread: true,
        threadExited: true, destroyedRejected: true});
      expect(result.workerThreadId).toBeGreaterThan(0);
      const preload = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(preload).toEqual({isMainThread: true, threadId: 0});
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(fixtureRoot, {recursive: true, force: true});
    }
  }, 15_000);

  it('cancels pending worker-thread HTTP requests and ignores late responses', async () => {
    const requestStarted = deferred<void>();
    const requestClosed = deferred<void>();
    const server = http.createServer((req, res) => {
      req.on('close', () => requestClosed.resolve());
      requestStarted.resolve();
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
          res.end(encodedSqlResult('SELECT worker'));
        }
      }, 50);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test HTTP server did not bind to a port');
    }

    worker = new TraceProcessorSqlWorker({
      processorId: 'processor-worker-cancel',
      traceId: 'trace-worker-cancel',
      port: address.port,
      forceInline: false,
    });

    const controller = new AbortController();
    const pending = worker.enqueueRaw(Buffer.from([1, 2, 3]), {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    await requestStarted.promise;

    controller.abort();
    await expectCancelled(pending);
    await requestClosed.promise;
    expect(worker.getStats()).toMatchObject({ running: false, queuedP0: 0, queuedP1: 0, queuedP2: 0 });

    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});

describe('normalizeTraceProcessorSqlError', () => {
  /**
   * `smp query` printed this verbatim: a Python-shaped traceback whose only
   * frame is `File "stdin"`, wrapping one line of actual diagnosis.
   */
  it('keeps the diagnosis and position, drops the fake traceback', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "stdin" line 1 col 1',
      '    select bogus from nowhere',
      '    ^',
      'no such table: nowhere',
    ].join('\n');
    expect(normalizeTraceProcessorSqlError(raw)).toBe('no such table: nowhere (line 1, col 1)');
  });

  it('passes through errors that are not in that shape', () => {
    expect(normalizeTraceProcessorSqlError('Query timeout')).toBe('Query timeout');
    expect(normalizeTraceProcessorSqlError('')).toBe('');
  });

  it('still returns the diagnosis when no position is present', () => {
    const raw = 'Traceback (most recent call last):\nsomething broke';
    expect(normalizeTraceProcessorSqlError(raw)).toBe('something broke');
  });
});
