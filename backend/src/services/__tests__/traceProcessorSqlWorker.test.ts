// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it } from '@jest/globals';
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
