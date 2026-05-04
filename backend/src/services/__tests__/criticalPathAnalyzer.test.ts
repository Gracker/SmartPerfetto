// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {analyzeCriticalPath} from '../criticalPathAnalyzer';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return {columns, rows, durationMs: 1};
}

const EMPTY = queryResult([], []);

interface SqlRule {
  match: RegExp;
  responder: (sql: string) => QueryResult;
}

function patternMockedService(rules: SqlRule[]): TraceProcessorService {
  const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async (_traceId, sql) => {
    for (const rule of rules) {
      if (rule.match.test(sql)) {
        return rule.responder(sql);
      }
    }
    // INCLUDE PERFETTO MODULE always succeeds with an empty result by default.
    if (/^\s*INCLUDE\s+PERFETTO\s+MODULE/i.test(sql)) {
      return EMPTY;
    }
    // Schema lookups for tid/upid via thread table.
    if (/SELECT tid, upid FROM thread/i.test(sql)) {
      return EMPTY;
    }
    return EMPTY;
  });
  return {query} as unknown as TraceProcessorService;
}

describe('critical path analyzer', () => {
  const taskColumns = [
    'thread_state_id',
    'ts',
    'dur',
    'utid',
    'state',
    'blocked_function',
    'io_wait',
    'cpu',
    'waker_id',
    'irq_context',
    'tid',
    'thread_upid',
    'thread_name',
    'process_name',
    'waker_utid',
    'waker_state',
    'waker_thread_name',
    'waker_process_name',
  ];

  const stackColumns = [
    'id',
    'ts',
    'dur',
    'utid',
    'stack_depth',
    'name',
    'table_name',
    'root_utid',
    'thread_name',
    'process_name',
  ];

  const wakerColumns = [
    'target_id',
    'target_ts',
    'waker_id',
    'target_irq_context',
    'waker_id_resolved',
    'waker_utid',
    'waker_state',
    'waker_cpu',
    'waker_irq_context',
    'waker_tid',
    'waker_thread_name',
    'waker_process_name',
  ];

  it('summarizes wakeup chain and surfaces stdlib-derived modules when L3 reports binder/monitor signals', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [
              101,
              1_000_000_000,
              20_000_000,
              1,
              'S',
              null,
              0,
              null,
              55,
              0,
              1001,
              7,
              'main',
              'com.demo',
              2,
              'D',
              'binder:system',
              'system_server',
            ],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 1_000_000_000, 12_000_000, 2, 8, 'blocking thread_state: D', 'thread_state', 1, 'binder:system', 'system_server'],
            [1, 1_000_000_000, 12_000_000, 2, 9, 'blocking process_name: system_server', 'thread_state', 1, 'binder:system', 'system_server'],
            [1, 1_000_000_000, 12_000_000, 2, 10, 'blocking thread_name: binder:system', 'thread_state', 1, 'binder:system', 'system_server'],
            [3, 1_012_000_000, 5_000_000, 3, 8, 'blocking thread_state: R+', 'thread_state', 1, 'RenderThread', 'com.demo'],
            [3, 1_012_000_000, 5_000_000, 3, 10, 'blocking thread_name: RenderThread', 'thread_state', 1, 'RenderThread', 'com.demo'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () =>
          queryResult(wakerColumns, [
            [101, 1_000_000_000, 55, 0, 55, 2, 'D', 0, 0, 3001, 'binder:system', 'system_server'],
          ]),
      },
      {
        match: /FROM segs\s+JOIN android_binder_txns/i,
        responder: () =>
          queryResult(
            [
              'segment_idx',
              'binder_txn_id',
              'binder_reply_id',
              'side',
              'interface',
              'method_name',
              'is_sync',
              'is_main_thread',
              'client_process',
              'client_thread',
              'server_process',
              'server_thread',
              'client_utid',
              'server_utid',
              'client_tid',
              'server_tid',
              'dur_ns',
            ],
            [
              [
                0,
                42,
                7,
                'client',
                'IBinder',
                'doSomething',
                1,
                1,
                'com.demo',
                'main',
                'system_server',
                'binder:system',
                1,
                2,
                1001,
                3001,
                12_000_000,
              ],
            ]
          ),
      },
      // monitor + io + gc + cpu + frames all empty
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 101});

    expect(analysis.available).toBe(true);
    expect(analysis.task.threadName).toBe('main');
    expect(analysis.task.processName).toBe('com.demo');
    expect(analysis.task.upid).toBe(7);
    expect(analysis.wakeupChain).toHaveLength(2);
    // The first segment should now carry stdlib-derived 'Binder / IPC' module
    // — proof that L3 enrichment overrode the regex fallback.
    expect(analysis.wakeupChain[0].modules).toContain('Binder / IPC');
    expect(analysis.wakeupChain[0].semantics?.binderTxns).toHaveLength(1);
    expect(analysis.directWaker).not.toBeNull();
    expect(analysis.directWaker?.kind).toBe('thread');
    expect(analysis.quantification).toBeDefined();
    expect(analysis.semanticSources?.binder).toBe('present');
    // Hypothesis SQL must contain only numeric IDs, never raw method names
    // — verify by ensuring no apostrophes (which would indicate a string literal).
    for (const hypothesis of analysis.quantification?.hypotheses ?? []) {
      expect(hypothesis.verificationSql.includes("'")).toBe(false);
    }
  });

  it('short-circuits to a "Running 状态：无等待链可分析" finding when the task is Running', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target/i,
        responder: () =>
          queryResult(taskColumns, [
            [102, 2_000_000_000, 4_000_000, 1, 'Running', null, 0, 3, null, null, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 102});

    expect(analysis.available).toBe(false);
    expect(analysis.wakeupChain).toEqual([]);
    expect(analysis.anomalies[0].title).toBe('Running 状态：无等待链可分析');
    expect(analysis.recommendations[0]).toContain('callstack');
  });

  it('returns "no critical path stack" when stack query yields zero rows for a non-Running task', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [103, 3_000_000_000, 6_000_000, 1, 'S', null, 0, null, null, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () => queryResult(stackColumns, []),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 103});

    expect(analysis.available).toBe(false);
    expect(analysis.anomalies[0].title).toBe('没有取到 critical path stack');
  });

  it('annotates IRQ-context waker as kind="irq" with no upstream chain', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [104, 4_000_000_000, 10_000_000, 1, 'S', null, 0, null, 7, 1, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 4_000_000_000, 5_000_000, 2, 8, 'blocking thread_state: R', 'thread_state', 1, 'kworker/0', 'kworker'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () =>
          queryResult(wakerColumns, [
            // target_irq_context=1, waker resolved as kworker but irq_context flag wins
            [104, 4_000_000_000, 7, 1, 7, 2, 'R', 0, 0, 0, 'kworker/0', null],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 104});

    expect(analysis.directWaker).not.toBeNull();
    expect(analysis.directWaker?.irqContext).toBe(true);
    expect(analysis.directWaker?.kind).toBe('irq');
  });

  it('range mode (utid+startTs+dur) splits a multi-state selection into per-slice findings', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread\s+LEFT JOIN process USING\(upid\)\s+WHERE thread\.utid =/i,
        responder: () =>
          queryResult(['utid', 'tid', 'thread_upid', 'thread_name', 'process_name'], [[1, 1001, 7, 'main', 'com.demo']]),
      },
      {
        match: /FROM thread_state\s+WHERE utid =/i,
        responder: () =>
          queryResult(['id', 'ts', 'dur', 'state', 'blocked_function', 'io_wait', 'cpu'], [
            [201, 5_000_000_000, 8_000_000, 'S', null, 0, null],
            [202, 5_008_000_000, 6_000_000, 'D', 'io_schedule', 1, null],
            [203, 5_014_000_000, 2_000_000, 'Running', null, 0, 4],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 5_000_000_000, 7_000_000, 2, 8, 'blocking thread_state: D', 'thread_state', 1, 'binder:system', 'system_server'],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {
      utid: 1,
      startTs: 5_000_000_000,
      dur: 16_000_000,
    });

    expect(analysis.slices).toBeDefined();
    expect(analysis.slices?.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['sleeping', 'uninterruptible', 'running'])
    );
    // Dominant state should pick the longest slice (sleeping, 8ms).
    expect(analysis.task.state).toBe('S');
  });

  it('exposes semanticSources status when stdlib include succeeds but table is empty', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [105, 6_000_000_000, 18_000_000, 1, 'S', null, 0, null, 99, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 6_000_000_000, 12_000_000, 2, 8, 'blocking thread_state: S', 'thread_state', 1, 'other', 'svc'],
          ]),
      },
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread_state AS waker/i,
        responder: () => queryResult(wakerColumns, []),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 105});

    expect(analysis.semanticSources).toBeDefined();
    // All semantic sources came back empty (no rules matched) — must not be 'present'.
    for (const status of Object.values(analysis.semanticSources ?? {})) {
      expect(['empty', 'skipped', 'stdlib_missing', 'sql_error']).toContain(status);
    }
  });

  it('counterfactual upper bound is task.dur - longest external segment, never below zero', async () => {
    const service = patternMockedService([
      {
        match: /FROM thread_state AS target\s+LEFT JOIN thread USING\(utid\)/i,
        responder: () =>
          queryResult(taskColumns, [
            [106, 7_000_000_000, 30_000_000, 1, 'S', null, 0, null, null, 0, 1001, 7, 'main', 'com.demo', null, null, null, null],
          ]),
      },
      {
        match: /FROM _critical_path_stack/i,
        responder: () =>
          queryResult(stackColumns, [
            [1, 7_000_000_000, 22_000_000, 2, 8, 'blocking thread_state: S', 'thread_state', 1, 'svc', 'svc_proc'],
          ]),
      },
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 106});

    expect(analysis.quantification?.counterfactual?.longestSegmentDurMs).toBeCloseTo(22, 1);
    expect(analysis.quantification?.counterfactual?.upperBoundMs).toBeCloseTo(8, 1);
    expect(analysis.quantification?.counterfactual?.note).toMatch(/UPPER BOUND/);
  });
});
