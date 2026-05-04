// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {analyzeCriticalPath} from '../criticalPathAnalyzer';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return {columns, rows, durationMs: 1};
}

function mockTraceProcessorService(results: QueryResult[]): TraceProcessorService {
  const query = jest.fn<TraceProcessorService['query']>().mockImplementation(async () => {
    const result = results.shift();
    if (!result) {
      throw new Error('Unexpected query');
    }
    return result;
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

  it('summarizes wakeup chain, abnormal segments, and related modules', async () => {
    const service = mockTraceProcessorService([
      queryResult(taskColumns, [
        [101, 1_000_000_000, 20_000_000, 1, 'R', null, 0, null, 55, 0, 1001, 'main', 'com.demo', 2, 'D', 'binder:system', 'system_server'],
      ]),
      queryResult([], []),
      queryResult(stackColumns, [
        [1, 1_000_000_000, 12_000_000, 2, 8, 'blocking thread_state: D', 'thread_state', 1, 'binder:system', 'system_server'],
        [1, 1_000_000_000, 12_000_000, 2, 9, 'blocking process_name: system_server', 'thread_state', 1, 'binder:system', 'system_server'],
        [1, 1_000_000_000, 12_000_000, 2, 10, 'blocking thread_name: binder:system', 'thread_state', 1, 'binder:system', 'system_server'],
        [1, 1_000_000_000, 12_000_000, 2, 11, 'blocking kernel_function: binder_wait_for_work', 'thread_state', 1, 'binder:system', 'system_server'],
        [1, 1_000_000_000, 12_000_000, 2, 12, 'blocking io_wait: 0', 'thread_state', 1, 'binder:system', 'system_server'],
        [2, 1_000_000_000, 12_000_000, 2, 13, 'binder transaction', 'slice', 1, 'binder:system', 'system_server'],
        [3, 1_012_000_000, 5_000_000, 3, 8, 'blocking thread_state: R+', 'thread_state', 1, 'RenderThread', 'com.demo'],
        [3, 1_012_000_000, 5_000_000, 3, 9, 'blocking process_name: com.demo', 'thread_state', 1, 'RenderThread', 'com.demo'],
        [3, 1_012_000_000, 5_000_000, 3, 10, 'blocking thread_name: RenderThread', 'thread_state', 1, 'RenderThread', 'com.demo'],
        [4, 1_012_000_000, 5_000_000, 3, 11, 'DrawFrame', 'slice', 1, 'RenderThread', 'com.demo'],
        [5, 1_012_000_000, 5_000_000, 3, 12, 'cpu: 6', 'thread_state', 1, 'RenderThread', 'com.demo'],
      ]),
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 101});

    expect(analysis.available).toBe(true);
    expect(analysis.task).toMatchObject({
      threadStateId: 101,
      threadName: 'main',
      processName: 'com.demo',
      durationMs: 20,
    });
    expect(analysis.blockingMs).toBe(17);
    expect(analysis.externalBlockingPercentage).toBe(85);
    expect(analysis.wakeupChain).toHaveLength(2);
    expect(analysis.wakeupChain[0]).toMatchObject({
      processName: 'system_server',
      threadName: 'binder:system',
      durationMs: 12,
    });
    expect(analysis.moduleBreakdown.map((item) => item.module)).toEqual(
      expect.arrayContaining(['Binder / IPC', '图形渲染 / Surface', '调度 / CPU 竞争'])
    );
    expect(analysis.anomalies.map((item) => item.title)).toEqual(
      expect.arrayContaining(['选中 task 超过单帧预算', '外部 critical path 占比过高', '等待链涉及 Binder / IPC'])
    );
    expect(analysis.summary).toContain('critical path 外部链路累计 17.00 ms');
    expect(analysis.summary).toContain('直接唤醒来源：system_server / binder:system');
  });

  it('returns an unsupported-style analysis when Perfetto returns no critical path stack', async () => {
    const service = mockTraceProcessorService([
      queryResult(taskColumns, [
        [102, 2_000_000_000, 4_000_000, 1, 'Running', null, 0, 3, null, null, 1001, 'main', 'com.demo', null, null, null, null],
      ]),
      queryResult([], []),
      queryResult(stackColumns, []),
    ]);

    const analysis = await analyzeCriticalPath(service, 'trace-1', {threadStateId: 102});

    expect(analysis.available).toBe(false);
    expect(analysis.wakeupChain).toEqual([]);
    expect(analysis.anomalies[0].title).toBe('没有取到 critical path stack');
    expect(analysis.recommendations[0]).toContain('sched_wakeup');
  });
});
