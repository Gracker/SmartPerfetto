// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import http from 'http';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {traceProcessorConfig} from '../../config';
import {resetPortPool} from '../portPool';
import {
  ExternalRpcProcessor,
  QueryResult,
  TraceProcessorFactory,
  WorkingTraceProcessor,
} from '../workingTraceProcessor';

function okResult(rows: unknown[][] = []): QueryResult {
  return {
    columns: [],
    rows,
    durationMs: 1,
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

describe('WorkingTraceProcessor enterprise isolation anchors', () => {
  beforeEach(() => {
    TraceProcessorFactory.cleanup();
    resetPortPool();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    TraceProcessorFactory.cleanup();
    resetPortPool();
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
      .spyOn(ExternalRpcProcessor.prototype as any, '_execRaw')
      .mockResolvedValue(okResult([[1]]) as never);

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
});
