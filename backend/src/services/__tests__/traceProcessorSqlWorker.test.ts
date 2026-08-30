// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {createHash} from 'crypto';
import {performance as nodePerformance} from 'perf_hooks';
import http from 'http';
import {
  decodeQueryArgsSql,
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
    runtime: 'qoder-agent-sdk',
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
