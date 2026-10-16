// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {
  findThreadsWithSchedData,
  loadThreadStateOwner,
  MAX_THREAD_CANDIDATES,
  resolveCriticalPathThread,
  threadStateSelectorConflicts,
  type ThreadStateOwner,
} from '../criticalPathThreadResolver';
import {CriticalPathInputError} from '../criticalPathAnalyzer';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';
import {sqliteTraceProcessor} from '../../../tests/helpers/criticalPathTraceProcessorFixture';

const COLUMNS = ['utid', 'tid', 'thread_name', 'thread_upid', 'is_main_thread', 'pid', 'process_name'];

function threadRow(
  utid: number,
  tid: number,
  threadName: string,
  options: {upid?: number; pid?: number; processName?: string; main?: boolean} = {},
): unknown[] {
  return [
    utid,
    tid,
    threadName,
    options.upid ?? 7,
    options.main ? 1 : 0,
    options.pid ?? 1200,
    options.processName ?? 'com.example.app',
  ];
}

/**
 * The resolver runs one pass per process-name strategy, so a test fixture has to
 * answer per-query rather than per-call: the exact pass must be able to miss
 * while the prefix pass hits.
 */
function mockedService(responder: (sql: string) => unknown[][]): {
  service: TraceProcessorService;
  queries: string[];
} {
  const queries: string[] = [];
  const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
    queries.push(sql);
    return {columns: COLUMNS, rows: responder(sql), durationMs: 1} satisfies QueryResult;
  });
  return {service: {query} as unknown as TraceProcessorService, queries};
}

describe('resolveCriticalPathThread', () => {
  it('resolves a unique match and carries process identity back', async () => {
    const {service} = mockedService(() => [
      threadRow(42, 1200, 'com.example.app', {main: true}),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      mainThread: true,
    });

    expect(resolution).toEqual({
      status: 'resolved',
      thread: {
        utid: 42,
        tid: 1200,
        threadName: 'com.example.app',
        upid: 7,
        pid: 1200,
        processName: 'com.example.app',
        isMainThread: true,
      },
    });
  });

  it('scopes the main-thread selector in SQL rather than filtering afterwards', async () => {
    const {service, queries} = mockedService(() => [threadRow(42, 1200, 'com.example.app', {main: true})]);

    await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example.app', mainThread: true});

    expect(queries[0]).toContain('thread.is_main_thread = 1');
    expect(queries[0]).toContain("process.name = 'com.example.app'");
  });

  it('prefers the exact process over a longer one that shares its prefix', async () => {
    // `com.example.app:push` is a real sibling process. Resolving the parent
    // package to the push process would answer about the wrong app entirely.
    const {service, queries} = mockedService(sql =>
      sql.includes("process.name = 'com.example.app'")
        ? [threadRow(42, 1200, 'com.example.app', {main: true})]
        : [
          threadRow(42, 1200, 'com.example.app', {main: true}),
          threadRow(90, 1400, 'com.example.app', {upid: 9, pid: 1400, processName: 'com.example.app:push', main: true}),
        ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example.app'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {utid: 42}});
    // The prefix pass never ran, because the exact pass answered.
    expect(queries).toHaveLength(1);
  });

  it('falls back to a prefix match when no process matches exactly', async () => {
    const {service, queries} = mockedService(sql =>
      sql.includes("process.name = 'com.example'")
        ? []
        : [threadRow(42, 1200, 'com.example.app', {main: true})]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.example'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {processName: 'com.example.app'}});
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("process.name GLOB 'com.example*'");
  });

  it('matches a thread name as a prefix, because kernel comm is truncated to 15 characters', async () => {
    const {service, queries} = mockedService(() => [
      threadRow(55, 1301, 'OkHttp Dispatch', {processName: 'com.example.app'}),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      threadName: 'OkHttp',
    });

    expect(resolution).toMatchObject({status: 'resolved', thread: {threadName: 'OkHttp Dispatch'}});
    expect(queries[0]).toContain("thread.name GLOB 'OkHttp*'");
  });

  it('reports ambiguity instead of picking the first of several threads', async () => {
    const {service} = mockedService(() => [
      threadRow(61, 1401, 'pool-1-thread-1'),
      threadRow(62, 1402, 'pool-1-thread-2'),
      threadRow(63, 1403, 'pool-1-thread-3'),
    ]);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {
      processName: 'com.example.app',
      threadName: 'pool-1-thread',
    });

    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') throw new Error('expected ambiguity');
    expect(resolution.candidatesAtLeast).toBe(3);
    expect(resolution.candidates.map(candidate => candidate.utid)).toEqual([61, 62, 63]);
  });

  it('caps the candidate list it hands back', async () => {
    const {service, queries} = mockedService(() =>
      Array.from({length: MAX_THREAD_CANDIDATES + 1}, (_, index) =>
        threadRow(100 + index, 2000 + index, `pool-1-thread-${index}`)));

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool-1-thread'});

    if (resolution.status !== 'ambiguous') throw new Error('expected ambiguity');
    expect(resolution.candidates).toHaveLength(MAX_THREAD_CANDIDATES);
    // A lower bound, not a total: the query stopped at the cap plus one, so
    // this says "at least eleven", which is what `candidatesTruncated` reports.
    expect(resolution.candidatesAtLeast).toBe(MAX_THREAD_CANDIDATES + 1);
    expect(queries[0]).toContain(`LIMIT ${MAX_THREAD_CANDIDATES + 1}`);
  });

  it('reports not found when nothing matches either pass', async () => {
    const {service} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {processName: 'com.absent'}))
      .resolves.toEqual({status: 'not_found', reason: 'no_match'});
  });

  it('reports a missing selector without querying the trace', async () => {
    const {service, queries} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {}))
      .resolves.toEqual({status: 'not_found', reason: 'no_selector'});
    expect(queries).toHaveLength(0);
  });

  it('escapes a quote in a name rather than letting it close the literal', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {processName: "com.ex'ample"});

    expect(queries[0]).toContain("process.name = 'com.ex''ample'");
  });

  it('rejects a non-numeric integer selector with a typed input error', async () => {
    const {service} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {utid: '1 OR 1=1'}))
      .rejects.toMatchObject({name: 'CriticalPathInputError', code: 'invalid_integer',
        message: 'utid must be a non-negative integer'});
    await expect(resolveCriticalPathThread(service, 'trace-1', {pid: -1}))
      .rejects.toBeInstanceOf(CriticalPathInputError);
  });

  it('rejects a control character or an over-long name with invalid_name, before querying', async () => {
    const {service, queries} = mockedService(() => []);

    await expect(resolveCriticalPathThread(service, 'trace-1', {threadName: 'main\nDROP'}))
      .rejects.toMatchObject({code: 'invalid_name'});
    await expect(resolveCriticalPathThread(service, 'trace-1', {processName: 'x'.repeat(201)}))
      .rejects.toMatchObject({code: 'invalid_name'});
    expect(queries).toHaveLength(0);
  });

  // GLOB metacharacters are ordinary characters in a comm or process name, and
  // the prefix pass is the only place a pattern is built. Unescaped, `[` turned
  // the rest of the name into a character class and `*` matched anything.
  it('escapes GLOB metacharacters in a thread name instead of treating them as a pattern', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool[1]-*-?'});

    expect(queries[0]).toContain("thread.name GLOB 'pool[[]1]-[*]-[?]*'");
  });

  it('escapes GLOB metacharacters in a process name, but not in the exact pass', async () => {
    const {service, queries} = mockedService(() => []);

    await resolveCriticalPathThread(service, 'trace-1', {processName: 'com.ex[a]mple*'});

    // The exact pass compares with `=`, where the name is already a literal.
    expect(queries[0]).toContain("process.name = 'com.ex[a]mple*'");
    expect(queries[1]).toContain("process.name GLOB 'com.ex[[]a]mple[*]*'");
  });

  it('still matches the escaped name itself, not only its literal spelling', async () => {
    // Guards the direction the escape exists for: the pattern must select the
    // very thread whose name contains the metacharacters.
    const {service} = mockedService(sql =>
      sql.includes("thread.name GLOB 'pool[[]1]-thread*'")
        ? [threadRow(70, 1500, 'pool[1]-thread-3')]
        : []);

    const resolution = await resolveCriticalPathThread(service, 'trace-1', {threadName: 'pool[1]-thread'});

    expect(resolution).toMatchObject({status: 'resolved', thread: {threadName: 'pool[1]-thread-3'}});
  });
});

// Real SQL against the in-memory stand-in: com.demo (upid 7) has a main thread
// and a worker; system_server (upid 8) has a main thread; thread 4 of com.demo
// has no scheduling data at all.
const SCHED_SETUP = `
  INSERT INTO process(upid, name, pid) VALUES (7, 'com.demo', 1001), (8, 'system_server', 3001);
  INSERT INTO thread VALUES
    (1, 1001, 7, 'main'), (2, 1002, 7, 'OkHttp Dispatch'), (3, 3001, 8, 'main'), (4, 1004, 7, 'idle-worker');
  UPDATE trace_bounds SET end_ts = 1000;
  INSERT INTO thread_state(id, utid, ts, dur, state) VALUES
    (10, 1, 100, 50, 'S'), (11, 1, 150, 20, 'Running'),
    (12, 2, 100, 10, 'Running'), (13, 2, 110, 10, 'S'), (14, 2, 120, 10, 'R'),
    (15, 3, 900, -1, 'S');
`;

describe('thread_state_id consistency', () => {
  it('loads the owner of a row, reading an open row to the end of the trace', async () => {
    const {tp} = sqliteTraceProcessor(SCHED_SETUP);

    expect(await loadThreadStateOwner(tp, 'trace-1', 12)).toEqual({
      threadStateId: 12, utid: 2, tid: 1002, threadName: 'OkHttp Dispatch', upid: 7, pid: 1001,
      processName: 'com.demo', isMainThread: false, startTs: 100, endTs: 110,
    });
    expect(await loadThreadStateOwner(tp, 'trace-1', '15')).toMatchObject({utid: 3, endTs: 1000});
    expect(await loadThreadStateOwner(tp, 'trace-1', 99)).toBeNull();
    await expect(loadThreadStateOwner(tp, 'trace-1', 'null')).rejects.toMatchObject({code: 'invalid_thread_state_id'});
  });

  it('names every selector field the owner contradicts, matching names the way the resolver does', () => {
    const owner: ThreadStateOwner = {
      threadStateId: 12, utid: 2, tid: 1002, threadName: 'OkHttp Dispatch', upid: 7, pid: 1001,
      processName: 'com.demo:push', isMainThread: false, startTs: 100, endTs: 110,
    };

    expect(threadStateSelectorConflicts(owner, {utid: '2', upid: 7, threadName: 'OkHttp', processName: 'com.demo'},
      {startTs: 105, endTs: 200})).toEqual([]);
    expect(threadStateSelectorConflicts(owner, {utid: 56, tid: 1, pid: 2, mainThread: true, threadName: 'Render'},
      {startTs: 110, endTs: 200})).toEqual(['utid', 'tid', 'pid', 'thread_name', 'main_thread', 'window']);
  });
});

describe('findThreadsWithSchedData', () => {
  it('proposes the same process\'s threads with data, main thread first', async () => {
    const {tp} = sqliteTraceProcessor(SCHED_SETUP);

    const found = await findThreadsWithSchedData(tp, 'trace-1', {upid: 7, startTs: 100, endTs: 200});

    expect(found.processHasSchedData).toBe(true);
    expect(found.candidates.map((thread) => [thread.utid, thread.threadStateRows])).toEqual([[1, 2], [2, 3]]);
  });

  it('falls back to the main threads of other processes when the process has none in the window', async () => {
    const {tp} = sqliteTraceProcessor(SCHED_SETUP);

    const found = await findThreadsWithSchedData(tp, 'trace-1', {upid: 7, startTs: 950, endTs: 990});

    expect(found.processHasSchedData).toBe(false);
    expect(found.candidates).toEqual([expect.objectContaining({utid: 3, processName: 'system_server', threadStateRows: 1})]);
  });
});
