// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {analyzeCriticalPath, CriticalPathInputError} from '../criticalPathAnalyzer';
import {resolveDirectWaker} from '../criticalPathWakerChain';
import type {QueryResult, TraceProcessorService} from '../traceProcessorService';
import {queryResult, sqliteTraceProcessor, type SqlRule} from '../../../tests/helpers/criticalPathTraceProcessorFixture';

const MS = 1_000_000;

// The columns the analyzer's stack query selects (tid/upid come from its own thread join).
const STACK_COLUMNS = ['id', 'ts', 'dur', 'utid', 'name', 'table_name', 'tid', 'upid', 'thread_name', 'process_name'];

interface StackSegment {
  ts: number;
  dur: number;
  utid: number;
  state: string;
  thread: string;
  process: string;
  tid?: number;
  upid?: number;
  /** The blocking thread_state row id. */
  stateId?: number;
  blockedFunction?: string;
  slices?: string[];
}

/** The rows the stack query returns for external segments (the root's own rows are filtered in SQL). */
function stackResult(segments: StackSegment[]): QueryResult {
  const rows: unknown[][] = [];
  for (const segment of segments) {
    const row = (name: string, table: string, id: number | null = null): unknown[] => [
      id,
      segment.ts,
      segment.dur,
      segment.utid,
      name,
      table,
      segment.tid ?? null,
      segment.upid ?? null,
      segment.thread,
      segment.process,
    ];
    rows.push(row(`blocking thread_state: ${segment.state}`, 'thread_state', segment.stateId ?? null));
    if (segment.blockedFunction) {
      rows.push(row(`blocking kernel_function: ${segment.blockedFunction}`, 'thread_state'));
    }
    for (const slice of segment.slices ?? []) rows.push(row(slice, 'slice'));
  }
  return queryResult(STACK_COLUMNS, rows);
}

/** The root utid a `_critical_path_stack` call was made for. */
function stackRoot(sql: string): number {
  const match = /_critical_path_stack\((\d+), (\d+), (\d+),/.exec(sql);
  if (!match) throw new Error('not a critical path stack query');
  return Number(match[1]);
}

const stackCalls = (sqls: string[]): string[] => sqls.filter((sql) => /FROM _critical_path_stack/.test(sql));

// Thread 1 (com.demo main) waits; thread 2 (system_server binder:system) serves it.
const BASE_THREADS = `
  INSERT INTO process(upid, name) VALUES (7, 'com.demo'), (8, 'system_server');
  INSERT INTO thread VALUES
    (1, 1001, 7, 'main'),
    (2, 3001, 8, 'binder:system'),
    (3, 1003, 7, 'RenderThread'),
    (5, 0, NULL, 'kworker/0');
`;

describe('critical path analyzer', () => {
  it('resolves the waker from the wakeup row and replaces keyword modules with the stdlib binder signal', async () => {
    // Thread 1 sleeps [1000, 1020) ms; its wakeup row at 1020 ms names thread 2.
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, waker_id, irq_context) VALUES
        (101, 1, ${1000 * MS}, ${20 * MS}, 'S', NULL, NULL, NULL),
        (102, 1, ${1020 * MS}, ${1 * MS}, 'R', 2, 55, 0),
        (55, 2, ${1015 * MS}, ${6 * MS}, 'Running', NULL, NULL, 0);
      INSERT INTO android_binder_txns VALUES
        (42, 43, 'IDemo', 'doSomething', 1, 1, 'com.demo', 'main', 'system_server', 'binder:system',
         1, 2, 1001, 3001, ${999 * MS}, ${14 * MS}, ${1000 * MS}, ${12 * MS});
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {ts: 1000 * MS, dur: 12 * MS, utid: 2, state: 'D', thread: 'binder:system', process: 'system_server'},
              {ts: 1012 * MS, dur: 5 * MS, utid: 3, state: 'R+', thread: 'RenderThread', process: 'com.demo'},
            ]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 101});

    expect(analysis.available).toBe(true);
    expect(analysis.task.threadName).toBe('main');
    expect(analysis.task.processName).toBe('com.demo');
    expect(analysis.task.upid).toBe(7);
    expect(analysis.wakeupChain).toHaveLength(2);
    // The stdlib signal replaces the keyword labels outright.
    expect(analysis.wakeupChain[0].modules).toEqual(['Binder / IPC']);
    expect(analysis.wakeupChain[0].semantics?.binderTxns).toEqual([
      expect.objectContaining({binderTxnId: 42, side: 'server', durMs: 12}),
    ]);
    expect(analysis.directWaker).toMatchObject({
      kind: 'thread', utid: 2, threadName: 'binder:system', processName: 'system_server',
      state: 'Running', threadStateId: 55, irqContext: false,
    });
    // The waker is reported once, as directWaker; the task carries no copy of it.
    expect(analysis.task).not.toHaveProperty('waker');
    expect(analysis.summary).toContain('直接唤醒来源：system_server / binder:system');
    expect(analysis.semanticSources?.binder).toBe('present');
    expect(analysis.anomalies.map((a) => a.title)).toContain('等待链涉及 Binder / IPC');
    expect(analysis.quantification).toBeDefined();
    // Hypothesis SQL must contain only numeric IDs, never raw method names
    // — verify by ensuring no apostrophes (which would indicate a string literal).
    for (const hypothesis of analysis.quantification?.hypotheses ?? []) {
      expect(hypothesis.verificationSql.includes("'")).toBe(false);
    }
  });

  it('short-circuits a selected Running row with unavailableReason task_state_running', async () => {
    const {tp, sqls} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, cpu) VALUES (102, 1, ${2000 * MS}, ${4 * MS}, 'Running', 3);
    `);

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 102});

    expect(analysis.available).toBe(false);
    expect(analysis.unavailableReason).toBe('task_state_running');
    expect(analysis.wakeupChain).toEqual([]);
    expect(analysis.anomalies[0].title).toBe('Running 状态：无等待链可分析');
    expect(analysis.recommendations[0]).toContain('callstack');
    expect(stackCalls(sqls)).toHaveLength(0);
  });

  it('reports no_critical_path_stack and still reports the waker lookup when the stack is empty', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (103, 1, ${3000 * MS}, ${6 * MS}, 'S');
      `,
      {rules: [{match: /FROM _critical_path_stack/i, responder: () => queryResult(STACK_COLUMNS, [])}]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 103});

    expect(analysis.available).toBe(false);
    expect(analysis.unavailableReason).toBe('no_critical_path_stack');
    expect(analysis.anomalies[0].title).toBe('没有取到 critical path 等待链');
    expect(analysis.directWaker).toBeNull();
    expect(analysis.warningCodes).toContainEqual({code: 'no_recorded_waker'});
    expect(analysis.warnings).toContain('唤醒行上没有记录 waker（waker_utid 为 NULL）');
  });

  it('takes IRQ context from the wakeup row only', async () => {
    const stack: SqlRule = {
      match: /FROM _critical_path_stack/i,
      responder: () =>
        stackResult([{ts: 4000 * MS, dur: 5 * MS, utid: 5, state: 'R', thread: 'kworker/0', process: 'kworker'}]),
    };
    // The wakeup row is in IRQ context; the waker's own row is not.
    const irq = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, waker_id, irq_context) VALUES
        (104, 1, ${4000 * MS}, ${10 * MS}, 'S', NULL, NULL, NULL),
        (105, 1, ${4010 * MS}, ${1 * MS}, 'R', 5, 7, 1),
        (7, 5, ${4008 * MS}, ${2 * MS}, 'Running', NULL, NULL, 0);
      `,
      {rules: [stack]}
    );
    const irqAnalysis = await analyzeCriticalPath(irq.tp, 'trace-1', {threadStateId: 104});
    expect(irqAnalysis.directWaker).toMatchObject({irqContext: true, kind: 'irq', utid: 5});
    expect(irqAnalysis.directWaker?.hintCodes).toContain('irq_wakeup');

    // The waker's own row carries irq_context=1; the wakeup itself was not in IRQ context.
    const notIrq = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, waker_id, irq_context) VALUES
        (104, 1, ${4000 * MS}, ${10 * MS}, 'S', NULL, NULL, NULL),
        (105, 1, ${4010 * MS}, ${1 * MS}, 'R', 2, 7, 0),
        (7, 2, ${4008 * MS}, ${2 * MS}, 'Running', NULL, NULL, 1);
      `,
      {rules: [stack]}
    );
    const notIrqAnalysis = await analyzeCriticalPath(notIrq.tp, 'trace-1', {threadStateId: 104});
    expect(notIrqAnalysis.directWaker).toMatchObject({irqContext: false, kind: 'thread', utid: 2});
  });

  it('range mode splits a multi-state selection on half-open slice bounds', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, blocked_function, io_wait, cpu) VALUES
        (200, 1, ${4990 * MS}, ${10 * MS}, 'Running', NULL, 0, 2),
        (201, 1, ${5000 * MS}, ${8 * MS}, 'S', NULL, 0, NULL),
        (202, 1, ${5008 * MS}, ${6 * MS}, 'D', 'io_schedule', 1, NULL),
        (203, 1, ${5014 * MS}, ${2 * MS}, 'Running', NULL, 0, 4),
        (204, 1, ${5016 * MS}, ${3 * MS}, 'S', NULL, 0, NULL);
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 5000 * MS, dur: 7 * MS, utid: 2, state: 'D', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 1, startTs: 5000 * MS, dur: 16 * MS});

    // Rows ending exactly at the window start or starting exactly at its end are not part of it.
    expect(analysis.slices?.map((s) => s.threadStateId)).toEqual([201, 202, 203]);
    expect(analysis.slices?.map((s) => s.kind)).toEqual(['sleeping', 'uninterruptible', 'running']);
    // Dominant state is the longest waiting slice (sleeping, 8ms).
    expect(analysis.task.state).toBe('S');
  });

  it('analyses a range whose longest slice is Running when waiting time dominates, resolving the longest wait', async () => {
    // Running 20 ms, then S 9 ms woken by thread 2, R 7 ms, D 8 ms: 24 ms of waiting.
    const {tp, sqls} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, waker_id, irq_context) VALUES
        (300, 1, ${6000 * MS}, ${20 * MS}, 'Running', NULL, NULL, NULL),
        (301, 1, ${6020 * MS}, ${9 * MS}, 'S', NULL, NULL, NULL),
        (302, 1, ${6029 * MS}, ${7 * MS}, 'R', 2, NULL, 0),
        (303, 1, ${6036 * MS}, ${8 * MS}, 'D', NULL, NULL, NULL);
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 6020 * MS, dur: 9 * MS, utid: 2, state: 'Running', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 1, startTs: 6000 * MS, dur: 44 * MS});

    expect(analysis.available).toBe(true);
    expect(analysis.unavailableReason).toBeUndefined();
    expect(analysis.task.state).toBe('S');
    expect(analysis.blockingMs).toBeCloseTo(9, 2);
    expect(stackCalls(sqls)[0]).toContain('_critical_path_stack(1, 6000000000, 44000000, 1, 1, 0, 1)');
    // waker_id is NULL on the wakeup row; the waker is still named through waker_utid.
    expect(analysis.directWaker).toMatchObject({utid: 2, threadName: 'binder:system', kind: 'thread'});
    expect(analysis.directWaker?.hintCodes).toContain('range_longest_waiting_slice');
  });

  it('returns no_waiting_time for a range without S/D/R time and never queries the stack', async () => {
    const {tp, sqls} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, cpu) VALUES
        (400, 1, ${7000 * MS}, ${10 * MS}, 'Running', 1),
        (401, 1, ${7010 * MS}, ${10 * MS}, 'Running', 2);
    `);

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 1, startTs: 7000 * MS, dur: 20 * MS});

    expect(analysis.available).toBe(false);
    expect(analysis.unavailableReason).toBe('no_waiting_time');
    expect(analysis.anomalies[0].title).toBe('选区内没有等待时间');
    expect(analysis.task.state).toBe('Running');
    expect(stackCalls(sqls)).toHaveLength(0);
  });

  it('exposes semanticSources from the enrichment when every stdlib table is empty', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (105, 1, ${6000 * MS}, ${18 * MS}, 'S');
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 6000 * MS, dur: 12 * MS, utid: 2, state: 'S', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 105});

    expect(analysis.semanticSources).toEqual({
      binder: 'empty',
      monitor: 'empty',
      io: 'empty',
      gc: 'empty',
      cpu: 'skipped',
      wakeSource: 'empty',
    });
  });

  it('counterfactual best case is task.dur - longest attributable segment, never below zero', async () => {
    // The 22 ms Running segment is the longest attributable one; the longer
    // event-wait leaf after it is another thread's sleep and is never the cost.
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (106, 1, ${7000 * MS}, ${60 * MS}, 'S');
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {ts: 7000 * MS, dur: 22 * MS, utid: 2, state: 'Running', thread: 'svc', process: 'svc_proc'},
              {ts: 7022 * MS, dur: 30 * MS, utid: 3, state: 'S', thread: 'RenderThread', process: 'com.demo'},
            ]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 106});

    const counterfactual = analysis.quantification?.counterfactual;
    expect(counterfactual?.longestSegmentKey).toBe(`2|${7000 * MS}|${7022 * MS}`);
    expect(counterfactual?.longestSegmentDurMs).toBeCloseTo(22, 1);
    expect(counterfactual?.bestCaseDurationMs).toBeCloseTo(38, 1);
    expect(analysis.longestSegment).toMatchObject({threadName: 'svc', durationMs: 22});
    expect(counterfactual?.maxSavingMs).toBeCloseTo(22, 1);
    expect(counterfactual).not.toHaveProperty('upperBoundMs');
    expect(counterfactual?.noteCode).toBe('best_case_only');
    expect(counterfactual?.note).toMatch(/仅为最好情况/);
  });
});

describe('critical path analyzer module classification', () => {
  const IO_LABEL = 'IO / 页缓存 / 文件系统候选';
  const IO_ANOMALY = '等待链涉及 IO/page-cache 候选';

  it('never derives IO or lock labels from thread names', async () => {
    const {tp} = sqliteTraceProcessor(
      `INSERT INTO process(upid, name) VALUES (7, 'com.demo');
      INSERT INTO thread VALUES (1, 1001, 7, 'main'), (3, 1003, 7, 'RenderThread'),
        (4, 1004, 7, 'pool-1-thread-1'), (6, 1006, 7, 'Thread-3');
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (110, 1, ${8000 * MS}, ${40 * MS}, 'S');
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {ts: 8000 * MS, dur: 10 * MS, utid: 3, state: 'S', thread: 'RenderThread', process: 'com.demo'},
              {ts: 8010 * MS, dur: 10 * MS, utid: 4, state: 'S', thread: 'pool-1-thread-1', process: 'com.demo'},
              {ts: 8020 * MS, dur: 10 * MS, utid: 6, state: 'S', thread: 'Thread-3', process: 'com.demo'},
            ]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 110, recursionEnabled: false});

    const labels = analysis.wakeupChain.flatMap((segment) => segment.modules);
    expect(labels).not.toContain(IO_LABEL);
    expect(labels).not.toContain('锁 / Futex');
    // A role label may still come from a name.
    expect(analysis.wakeupChain[0].modules).toEqual(['图形渲染 / Surface']);
    expect(analysis.anomalies.map((a) => a.title)).not.toContain(IO_ANOMALY);
    expect(analysis.recommendations.join('\n')).not.toContain('同步 IO');
  });

  it('keeps the IO fallback label from wait evidence but raises no IO finding from the label alone', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (111, 1, ${9000 * MS}, ${20 * MS}, 'S');
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {
                ts: 9000 * MS,
                dur: 10 * MS,
                utid: 2,
                state: 'D',
                thread: 'binder:system',
                process: 'system_server',
                blockedFunction: 'filemap_fault',
              },
            ]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 111, recursionEnabled: false});

    // No stdlib IO row exists (the D row is a stack fixture), so the fallback label stays…
    expect(analysis.wakeupChain[0].modules).toContain(IO_LABEL);
    // …but a label alone raises no anomaly: that needs io_wait or a typed IO signal.
    expect(analysis.anomalies.map((a) => a.title)).not.toContain(IO_ANOMALY);
    expect(analysis.recommendations.join('\n')).not.toContain('同步 IO');
  });

  it('raises the IO anomaly and recommendation from a typed IO signal', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, blocked_function, io_wait) VALUES
        (112, 1, ${9100 * MS}, ${20 * MS}, 'S', NULL, 0),
        (113, 2, ${9100 * MS}, ${10 * MS}, 'D', 'filemap_fault', 1);
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 9100 * MS, dur: 10 * MS, utid: 2, state: 'D', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 112, recursionEnabled: false});

    expect(analysis.wakeupChain[0].modules).toEqual(['IO / 文件系统']);
    expect(analysis.anomalies.map((a) => a.title)).toContain(IO_ANOMALY);
    expect(analysis.recommendations.join('\n')).toContain('同步 IO');
  });

  it('keeps both Binder and Monitor anomalies when one segment carries both signals, counting it once in the breakdown', async () => {
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (120, 1, ${10000 * MS}, ${30 * MS}, 'S');
      INSERT INTO android_binder_txns VALUES
        (42, 43, 'IDemo', 'doSomething', 1, 1, 'com.demo', 'main', 'system_server', 'binder:system',
         1, 2, 1001, 3001, ${9999 * MS}, ${16 * MS}, ${10000 * MS}, ${14 * MS});
      INSERT INTO android_monitor_contention VALUES
        (9, ${10002 * MS}, ${6 * MS}, 2, 3, 3001, 1003, 'binder:system', 'RenderThread', 'a()', 'b()', 0);
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {ts: 10000 * MS, dur: 20 * MS, utid: 2, state: 'S', thread: 'binder:system', process: 'system_server'},
              {ts: 10020 * MS, dur: 5 * MS, utid: 3, state: 'S', thread: 'RenderThread', process: 'com.demo'},
            ]),
        },
      ]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 120, recursionEnabled: false});

    const titles = analysis.anomalies.map((a) => a.title);
    expect(titles).toContain('等待链涉及 Binder / IPC');
    expect(titles).toContain('等待链涉及 Java 锁竞争');
    expect(analysis.anomalies.find((a) => a.title === '等待链涉及 Binder / IPC')?.detail).toContain('14.00 ms');
    expect(analysis.anomalies.find((a) => a.title === '等待链涉及 Java 锁竞争')?.detail).toContain('6.00 ms');
    const recommendations = analysis.recommendations.join('\n');
    expect(recommendations).toContain('Binder / IPC');
    expect(recommendations).toContain('monitor_contention_chain');
    // The primary module is the longer signal; the segment is counted once.
    expect(analysis.wakeupChain[0].modules).toEqual(['Binder / IPC', '锁 / Monitor']);
    expect(analysis.moduleBreakdown.map((item) => item.module)).not.toContain('锁 / Monitor');
    const shares = analysis.moduleBreakdown.reduce((sum, item) => sum + item.percentage, 0);
    expect(shares).toBeLessThanOrEqual(100);
    expect(analysis.moduleBreakdown.reduce((sum, item) => sum + item.segmentCount, 0)).toBe(2);
  });

  it('produces h-monitor-blocking when the chain runs through the lock owner of the task\'s wait', async () => {
    // The task (thread 1) waits [13000, 13010) for a monitor thread 2 holds;
    // the chain is thread 2 running while it holds the lock. Thread 3 waits on
    // the same owner and must not be attached.
    const {tp} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (135, 1, ${13000 * MS}, ${10 * MS}, 'S');
      INSERT INTO android_monitor_contention VALUES
        (77, ${13000 * MS}, ${10 * MS}, 1, 2, 1001, 3001, 'main', 'binder:system', 'wait()', 'hold()', 1),
        (78, ${13001 * MS}, ${8 * MS}, 3, 2, 1003, 3001, 'RenderThread', 'binder:system', 'other()', 'hold()', 0);
      `,
      {rules: [{
        match: /FROM _critical_path_stack/i,
        responder: () => stackResult([
          {ts: 13000 * MS, dur: 10 * MS, utid: 2, tid: 3001, upid: 8, state: 'Running', thread: 'binder:system', process: 'system_server'},
        ]),
      }]}
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 135, recursionEnabled: false});

    expect(analysis.wakeupChain[0].semantics?.monitorContention).toEqual([
      expect.objectContaining({rowId: 77, side: 'owner', blockedUtid: 1, durMs: 10}),
    ]);
    expect(analysis.quantification?.hypotheses.map((hypothesis) => hypothesis.id)).toContain('h-monitor-blocking');
    expect(analysis.anomalies.map((anomaly) => anomaly.title)).toContain('等待链涉及 Java 锁竞争');
  });

  it('raises the CPU-contention anomaly only from typed competition, not from a Running blocker', async () => {
    const running = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (130, 1, ${11000 * MS}, ${20 * MS}, 'S');
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 11000 * MS, dur: 10 * MS, utid: 2, state: 'Running', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );
    const runningAnalysis = await analyzeCriticalPath(running.tp, 'trace-1', {threadStateId: 130, recursionEnabled: false});
    expect(runningAnalysis.anomalies.map((a) => a.title)).not.toContain('存在调度或 CPU 竞争迹象');

    // Thread 2 is runnable [12000, 12010) and then runs on CPU 3; thread 3 holds CPU 3 meanwhile.
    const contended = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, cpu) VALUES
        (131, 1, ${12000 * MS}, ${20 * MS}, 'S', NULL),
        (132, 2, ${12000 * MS}, ${10 * MS}, 'R', NULL),
        (133, 2, ${12010 * MS}, ${5 * MS}, 'Running', 3),
        (134, 3, ${12002 * MS}, ${7 * MS}, 'Running', 3);
      INSERT INTO sched(ts, dur, cpu, utid) VALUES (${12002 * MS}, ${7 * MS}, 3, 3), (${12010 * MS}, ${5 * MS}, 3, 2);
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([{ts: 12000 * MS, dur: 10 * MS, utid: 2, state: 'R', thread: 'binder:system', process: 'system_server'}]),
        },
      ]}
    );
    const contendedAnalysis = await analyzeCriticalPath(contended.tp, 'trace-1', {threadStateId: 131, recursionEnabled: false});
    const cpu = contendedAnalysis.anomalies.find((a) => a.title === '存在调度或 CPU 竞争迹象');
    expect(cpu?.detail).toContain('7.00 ms');
    expect(cpu?.evidence).toEqual(['CPU 3: com.demo / RenderThread']);
  });
});

describe('critical path analyzer truncation and recursion', () => {
  const chainOf = (count: number, startMs: number, durMs: number, state = 'S'): StackSegment[] =>
    Array.from({length: count}, (_, index) => ({
      ts: (startMs + index * durMs) * MS,
      dur: durMs * MS,
      utid: 100 + index,
      state,
      thread: `worker-${index}`,
      process: 'com.demo',
    }));

  const taskSetup = (id: number, startMs: number, durMs: number): string => `${BASE_THREADS}
    INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (${id}, 1, ${startMs * MS}, ${durMs * MS}, 'S');
  `;

  it('excludes self rows in SQL and computes totals over the whole chain when only the display is cut', async () => {
    const chain = chainOf(25, 20000, 2);
    const {tp, sqls} = sqliteTraceProcessor(taskSetup(140, 20000, 60), {rules: [
      {match: /FROM _critical_path_stack/i, responder: () => stackResult(chain)},
    ]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 140, maxSegments: 20, recursionEnabled: false});

    const stackSql = stackCalls(sqls)[0];
    expect(stackSql).toContain('_critical_path_stack(1, 20000000000, 60000000, 1, 1, 0, 1)');
    expect(stackSql).toMatch(/utid != root_utid/);
    expect(analysis.truncated).toBe(true);
    expect(analysis.wakeupChain).toHaveLength(20);
    expect(analysis.blockingMs).toBeCloseTo(50, 2);
    expect(analysis.selfMs).toBeCloseTo(10, 2);
    expect(analysis.moduleBreakdown.reduce((sum, item) => sum + item.segmentCount, 0)).toBe(25);
    expect(analysis.chainSegmentCount).toBe(25);
    expect(Object.values(analysis.waitClassTotalsMs ?? {}).reduce((sum, ms) => sum + ms, 0))
      .toBeCloseTo(analysis.chainWaitMs ?? 0, 2);
    expect(analysis.warnings).toContain(
      'critical path 共 25 个链路段，仅展示前 20 个；阻塞时长、模块占比与反事实估计按完整链路计算。'
    );
  });

  it('flags totals as partial when the chain exceeds its segment cap, however many slice rows each segment has', async () => {
    // Slice rows no longer spend the budget: the cap counts segments.
    const chain = chainOf(101, 30000, 1).map((segment) => ({...segment, slices: ['a', 'b', 'c', 'd', 'e', 'f']}));
    const {tp, sqls} = sqliteTraceProcessor(taskSetup(141, 30000, 120), {rules: [
      {match: /FROM _critical_path_stack/i, responder: () => stackResult(chain)},
    ]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {
      threadStateId: 141, maxSegments: 20, maxChainSegments: 100, recursionEnabled: false,
    });

    expect(stackCalls(sqls)[0]).toContain('segment_rank <= 101');
    expect(analysis.truncated).toBe(true);
    expect(analysis.wakeupChain).toHaveLength(20);
    // The first 100 segments are kept; totals cover exactly those.
    expect(analysis.chainSegmentCount).toBe(100);
    expect(analysis.blockingMs).toBeCloseTo(100, 2);
    expect(analysis.warnings).toContain(
      'critical path 超过 100 个原始链路段上限，已截断（合并后 100 段，展示前 20 段）；阻塞时长、模块占比与反事实估计只覆盖截断前的部分。'
    );
  });

  it('sums durations in ns so the external share cannot exceed 100% through rounding', async () => {
    // Three 0.3349 ms segments fill a 1.0047 ms task exactly; their rounded ms
    // (0.33 each) would sum below it, and rounding up would overshoot it.
    const chain = Array.from({length: 3}, (_, index) => ({
      ts: 70000 * MS + index * 334_900, dur: 334_900, utid: 100 + index, state: 'S',
      thread: `worker-${index}`, process: 'com.demo',
    }));
    const {tp} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (142, 1, ${70000 * MS}, 1004700, 'S');
    `, {rules: [{match: /FROM _critical_path_stack/i, responder: () => stackResult(chain)}]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 142, recursionEnabled: false});

    expect(analysis.blockingMs).toBe(1);
    expect(analysis.externalBlockingPercentage).toBe(100);
    expect(analysis.selfMs).toBe(0);
    expect(analysis.moduleBreakdown.reduce((sum, item) => sum + item.percentage, 0)).toBeLessThanOrEqual(100);
  });

  it('still recurses into a chain of 16+ segments', async () => {
    // Only work segments are expanded; see the next test for the leaves.
    const chain = chainOf(18, 40000, 2, 'Running');
    chain[5] = {...chain[5], dur: 8 * MS};
    for (let index = 6; index < chain.length; index += 1) chain[index] = {...chain[index], ts: chain[index].ts + 6 * MS};
    const {tp, sqls} = sqliteTraceProcessor(taskSetup(150, 40000, 60), {rules: [
      {
        match: /FROM _critical_path_stack/i,
        responder: (sql) =>
          stackRoot(sql) === 1
            ? stackResult(chain)
            : stackResult([
                {ts: chain[5].ts, dur: 3 * MS, utid: 900, state: 'S', thread: 'upstream', process: 'svc'},
              ]),
      },
    ]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 150});

    expect(stackCalls(sqls).map(stackRoot)).toEqual([1, 105]);
    expect(analysis.wakeupChain[5].children).toEqual([expect.objectContaining({utid: 900, threadName: 'upstream'})]);
    expect(analysis.warnings.some((warning) => warning.startsWith('critical path recursion'))).toBe(false);
    // Totals cover the top-level chain only: the child (a 3 ms sleep) covers
    // the same wall time as its parent and must not be counted again.
    expect(analysis.chainSegmentCount).toBe(18);
    expect(analysis.chainWaitMs).toBe(0);
    expect(analysis.totalsNs?.work).toBe((17 * 2 + 8) * MS);
    expect(analysis.attributableMs).toBeCloseTo(17 * 2 + 8, 2);
  });

  it('never recurses into event-wait, device-wait or runnable segments: they end the chain', async () => {
    const chain: StackSegment[] = [
      {ts: 41000 * MS, dur: 10 * MS, utid: 101, state: 'S', thread: 'net', process: 'com.demo'},
      {ts: 41010 * MS, dur: 10 * MS, utid: 102, state: 'D', thread: 'io', process: 'com.demo'},
      {ts: 41020 * MS, dur: 10 * MS, utid: 103, state: 'R', thread: 'queued', process: 'com.demo'},
      {ts: 41030 * MS, dur: 10 * MS, utid: 104, state: 'I', thread: 'kworker/1:1', process: 'kworker'},
      {ts: 41040 * MS, dur: 6 * MS, utid: 105, state: 'Running', thread: 'owner', process: 'com.demo'},
    ];
    const {tp, sqls} = sqliteTraceProcessor(taskSetup(152, 41000, 50), {rules: [
      {
        match: /FROM _critical_path_stack/i,
        responder: (sql) => (stackRoot(sql) === 1 ? stackResult(chain) : queryResult(STACK_COLUMNS, [])),
      },
    ]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 152, recursionDepth: 2});

    expect(stackCalls(sqls).map(stackRoot)).toEqual([1, 105]);
    expect(analysis.wakeupChain.map((segment) => segment.pathRole))
      .toEqual(['event_wait', 'device_wait', 'runnable', 'event_wait', 'work']);
  });

  it('warns when a recursion stack is cut at its segment cap', async () => {
    const chain = chainOf(2, 45000, 10, 'Running');
    const {tp} = sqliteTraceProcessor(taskSetup(151, 45000, 30), {rules: [
      {
        match: /FROM _critical_path_stack/i,
        responder: (sql) =>
          stackRoot(sql) === 1
            ? stackResult(chain)
            : stackResult(Array.from({length: 25}, (_, index) => ({
                ts: (45000 + index * 0.2) * MS, dur: 0.2 * MS, utid: 800 + index, state: 'S',
                thread: `up-${index}`, process: 'svc',
              }))),
      },
    ]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 151, maxSegments: 20, recursionDepth: 1});

    expect(analysis.wakeupChain[0].children).toHaveLength(20);
    expect(analysis.warningCodes).toContainEqual({code: 'recursion_cut', params: {utid: 100, cap: 20}});
  });

  it('warns when the recursion budget stops an expansion and when a recursion stack query fails', async () => {
    const chain = chainOf(3, 50000, 10, 'Running');
    const budget = sqliteTraceProcessor(taskSetup(160, 50000, 40), {rules: [
      {
        match: /FROM _critical_path_stack/i,
        responder: (sql) => {
          const root = stackRoot(sql);
          if (root === 1) return stackResult(chain);
          // Every expansion yields five 5 ms segments: enough to exhaust a budget of 4.
          return stackResult(
            Array.from({length: 5}, (_, index) => ({
              ts: (50000 + index * 5) * MS,
              dur: 5 * MS,
              utid: root * 10 + index,
              state: 'Running',
              thread: `up-${root}-${index}`,
              process: 'svc',
            }))
          );
        },
      },
    ]});

    const budgetAnalysis = await analyzeCriticalPath(budget.tp, 'trace-1', {threadStateId: 160, segmentBudget: 4});

    expect(budgetAnalysis.warningCodes).toContainEqual({code: 'recursion_budget', params: {budget: 4}});

    const failing = sqliteTraceProcessor(taskSetup(161, 50000, 40), {rules: [
      {
        match: /FROM _critical_path_stack/i,
        responder: (sql) => {
          if (stackRoot(sql) === 1) return stackResult(chain);
          throw new Error('stack exploded\nsecond line');
        },
      },
    ]});

    const failingAnalysis = await analyzeCriticalPath(failing.tp, 'trace-1', {threadStateId: 161});

    expect(failingAnalysis.available).toBe(true);
    expect(failingAnalysis.warningCodes).toContainEqual(
      {code: 'recursion_failed', params: {utid: 100, message: 'stack exploded'}});
  });
});

describe('critical path analyzer warnings and input errors', () => {
  it('takes tid/upid from the stack rows and hoists L3 warnings once', async () => {
    const {tp, sqls} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (170, 1, ${60000 * MS}, ${20 * MS}, 'S');
      `,
      {
        queryErrors: [[/android_monitor_contention/, 'no such column: mc.bogus']],
        rules: [
          {
            match: /FROM _critical_path_stack/i,
            responder: () =>
              stackResult([
                {ts: 60000 * MS, dur: 5 * MS, utid: 2, tid: 3001, upid: 8, state: 'S', thread: 'binder:system', process: 'system_server'},
                {ts: 60005 * MS, dur: 5 * MS, utid: 3, tid: 1003, upid: 7, state: 'S', thread: 'RenderThread', process: 'com.demo'},
              ]),
          },
        ],
      }
    );

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 170, recursionEnabled: false});

    expect(analysis.wakeupChain.map((segment) => [segment.tid, segment.upid])).toEqual([[3001, 8], [1003, 7]]);
    expect(sqls.some((sql) => /FROM thread WHERE utid IN/.test(sql))).toBe(false);
    expect(analysis.semanticSources?.gc).toBe('empty');
    expect(analysis.semanticSources?.monitor).toBe('sql_error');
    expect(analysis.warningCodes.filter((warning) => warning.code === 'schema_mismatch')).toEqual([
      {code: 'schema_mismatch', params: {message: 'no such column: mc.bogus'}},
    ]);
  });

  it('stops at the next stage when the signal aborts, and rethrows the cancellation', async () => {
    const controller = new AbortController();
    const {tp, sqls} = sqliteTraceProcessor(
      `${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (171, 1, ${61000 * MS}, ${20 * MS}, 'S');
      `,
      {rules: [{
        match: /FROM _critical_path_stack/i,
        responder: () => {
          controller.abort();
          return stackResult([{ts: 61000 * MS, dur: 5 * MS, utid: 2, state: 'S', thread: 'binder:system', process: 'system_server'}]);
        },
      }]}
    );

    await expect(analyzeCriticalPath(tp, 'trace-1', {threadStateId: 171, signal: controller.signal}))
      .rejects.toMatchObject({name: 'AbortError'});
    // Nothing after the stack query ran: no recursion, no L3, no L5.
    expect(sqls.some((sql) => /android_binder_txns|expected_frame_timeline_slice/.test(sql))).toBe(false);
    expect(stackCalls(sqls)).toHaveLength(1);
  });

  it('throws CriticalPathInputError with a code for each caller-input failure', async () => {
    const {tp} = sqliteTraceProcessor(BASE_THREADS);
    const codeOf = async (options: Parameters<typeof analyzeCriticalPath>[2]): Promise<string | undefined> => {
      try {
        await analyzeCriticalPath(tp, 'trace-1', options);
        return undefined;
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CriticalPathInputError);
        return (error as CriticalPathInputError).code;
      }
    };

    expect(await codeOf({threadStateId: 'abc'})).toBe('invalid_thread_state_id');
    expect(await codeOf({threadStateId: -3})).toBe('invalid_thread_state_id');
    expect(await codeOf({threadStateId: 999})).toBe('thread_state_not_found');
    expect(await codeOf({})).toBe('missing_selector');
    expect(await codeOf({utid: 'x', startTs: 1, dur: 1})).toBe('invalid_integer');
    expect(await codeOf({utid: 1, startTs: 5, dur: 0})).toBe('non_positive_duration');
  });
});

describe('resolveDirectWaker', () => {
  const service = (rows: string) =>
    sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, waker_id, irq_context) VALUES ${rows};
    `).tp;

  it('reads the waker from the successor R row when the selected S row has none', async () => {
    const tp = service(`
      (1, 1, 100, 50, 'S', NULL, NULL, NULL),
      (2, 1, 150, 10, 'R', 2, 9, 0),
      (9, 2, 140, 20, 'Running', NULL, NULL, 0)
    `);

    const result = await resolveDirectWaker(tp, 'trace-1', {threadStateId: 1});

    expect(result.hop).toMatchObject({utid: 2, threadStateId: 9, threadName: 'binder:system', processName: 'system_server', state: 'Running', kind: 'thread', irqContext: false});
    expect(result.warnings).toEqual([]);
  });

  it('reads a selected R row directly', async () => {
    const tp = service(`
      (1, 1, 100, 50, 'S', NULL, NULL, NULL),
      (2, 1, 150, 10, 'R', 2, NULL, 0)
    `);

    const result = await resolveDirectWaker(tp, 'trace-1', {threadStateId: 2});

    expect(result.hop).toMatchObject({utid: 2, threadStateId: null, threadName: 'binder:system'});
  });

  it('ignores a successor that is not R/R+ or carries no waker, and a row that is not adjacent', async () => {
    const tp = service(`
      (1, 1, 100, 50, 'S', NULL, NULL, NULL),
      (2, 1, 150, 10, 'D', 2, NULL, 0),
      (3, 1, 200, 10, 'S', NULL, NULL, NULL),
      (4, 1, 210, 10, 'R', NULL, NULL, 0),
      (5, 1, 300, 10, 'S', NULL, NULL, NULL),
      (6, 1, 311, 10, 'R', 2, NULL, 0)
    `);

    for (const threadStateId of [1, 3, 5]) {
      const result = await resolveDirectWaker(tp, 'trace-1', {threadStateId});
      expect(result.hop).toBeNull();
      expect(result.warnings).toEqual([{code: 'no_recorded_waker'}]);
    }
  });

  it('reads a Running row\'s waker from the wakeup row that ends where it starts', async () => {
    const tp = service(`
      (1, 1, 100, 50, 'S', NULL, NULL, NULL),
      (2, 1, 150, 10, 'R', 2, 9, 1),
      (3, 1, 160, 40, 'Running', NULL, NULL, 0),
      (9, 2, 140, 20, 'Running', NULL, NULL, 0)
    `);

    const result = await resolveDirectWaker(tp, 'trace-1', {threadStateId: 3});

    // irq_context comes from the wakeup row, not from the Running row.
    expect(result.hop).toMatchObject({utid: 2, threadStateId: 9, threadName: 'binder:system', kind: 'irq', irqContext: true});
    expect(result.warnings).toEqual([]);
  });

  it('reports no waker for a Running row after a preemption or with no adjacent wakeup row', async () => {
    const tp = service(`
      (1, 1, 100, 50, 'Running', NULL, NULL, 0),
      (2, 1, 150, 10, 'R+', NULL, NULL, 0),
      (3, 1, 160, 40, 'Running', NULL, NULL, 0),
      (4, 1, 300, 10, 'R', 2, NULL, 0),
      (5, 1, 311, 10, 'Running', NULL, NULL, 0)
    `);

    for (const threadStateId of [3, 5]) {
      const result = await resolveDirectWaker(tp, 'trace-1', {threadStateId});
      expect(result.hop).toBeNull();
      expect(result.warnings).toEqual([{code: 'no_recorded_waker'}]);
    }
  });

  it('reports a missing row as unavailable', async () => {
    const result = await resolveDirectWaker(service(`(1, 1, 100, 50, 'S', NULL, NULL, NULL)`), 'trace-1', {threadStateId: 42});

    expect(result).toEqual({hop: null, warnings: [{code: 'thread_state_not_found', params: {id: 42}}]});
  });
});

// Android emits sched_blocked_reason only for D state, so every S-state wait on
// the critical path arrives with blocked_function NULL. The wake-source layer is
// the only kernel signal those waits have, and it is decided in TypeScript here
// and in SQL in fragments/sleep_wake_source.sql.
describe('wake-source attribution of S-state waits', () => {
  // Three sleeping segments on one chain: a short hand-off (thread 11), a long
  // IRQ-woken receive candidate (thread 12), and a longer hand-off (thread 13).
  // Each wake sits on the R row that starts where the sleep ends.
  const SHORT_HANDOFF_WAKE = `(311, 11, ${7004 * MS}, ${1 * MS}, 'R', 14, 0)`;
  const NETWORK_WAKE = `(312, 12, ${7035 * MS}, ${1 * MS}, 'R', 15, 1)`;
  const LONG_HANDOFF_WAKE = `(313, 13, ${7048 * MS}, ${1 * MS}, 'R', 14, 0)`;

  /** Recursion is off so the flat segment list is exactly the three segments. */
  function wakeChainService(wakes: string[], networkSlices: string[] = []): TraceProcessorService {
    return sqliteTraceProcessor(
      `INSERT INTO process(upid, pid, name) VALUES (7, 1001, 'com.demo');
      INSERT INTO thread VALUES
        (1, 1001, 7, 'main'),
        (11, 5100, 7, 'pool-1-thread-1'),
        (12, 5200, 7, 'OkHttp Dispatch'),
        (13, 5300, 7, 'pool-1-thread-2'),
        (14, 5900, 7, 'pool-2-thread-9'),
        (15, 300, NULL, 'kworker/u16:3');
      INSERT INTO thread_state(id, utid, ts, dur, state, waker_utid, irq_context) VALUES
        (301, 1, ${7000 * MS}, ${50 * MS}, 'S', NULL, NULL),
        (302, 11, ${7000 * MS}, ${4 * MS}, 'S', NULL, NULL),
        (303, 12, ${7005 * MS}, ${30 * MS}, 'S', NULL, NULL),
        (304, 13, ${7036 * MS}, ${12 * MS}, 'S', NULL, NULL)
        ${wakes.map((wake) => `, ${wake}`).join('')};
      `,
      {rules: [
        {
          match: /FROM _critical_path_stack/i,
          responder: () =>
            stackResult([
              {ts: 7000 * MS, dur: 4 * MS, utid: 11, state: 'S', thread: 'pool-1-thread-1', process: 'com.demo'},
              {
                ts: 7005 * MS, dur: 30 * MS, utid: 12, state: 'S', thread: 'OkHttp Dispatch', process: 'com.demo',
                slices: networkSlices,
              },
              {ts: 7036 * MS, dur: 12 * MS, utid: 13, state: 'S', thread: 'pool-1-thread-2', process: 'com.demo'},
            ]),
        },
      ]}
    ).tp;
  }

  it('labels an IRQ-woken S wait on a network thread as a receive candidate', async () => {
    const analysis = await analyzeCriticalPath(wakeChainService([NETWORK_WAKE]), 'trace-1', {
      threadStateId: 301,
      recursionEnabled: false,
    });

    expect(analysis.semanticSources?.wakeSource).toBe('present');
    const segment = analysis.wakeupChain.find(entry => entry.threadName === 'OkHttp Dispatch');
    expect(segment?.wakeSourceClass).toBe('network_receive_candidate');
    expect(segment?.modules).toContain('网络收包等待候选');
    // The wake source itself stays IRQ; only the sleeper's role narrows it.
    expect(segment?.semantics?.wakeSources[0]).toMatchObject({
      wakeSource: 'irq_or_softirq', threadRole: 'network', irqContext: true, durMs: 30, eventDurMs: 30,
    });
    const anomaly = analysis.anomalies.find(entry => entry.title === '等待链涉及网络收包等待候选');
    expect(anomaly?.severity).toBe('info');
    expect(anomaly?.evidence).toEqual(['com.demo / OkHttp Dispatch', '30.00 ms']);
    // A candidate, never a cause: the detail has to say so.
    expect(anomaly?.detail).toContain('定时器到期');
  });

  it('labels a same-process non-binder waker as a worker hand-off', async () => {
    const analysis = await analyzeCriticalPath(wakeChainService([SHORT_HANDOFF_WAKE]), 'trace-1', {
      threadStateId: 301,
      recursionEnabled: false,
    });

    const segment = analysis.wakeupChain.find(entry => entry.threadName === 'pool-1-thread-1');
    expect(segment?.wakeSourceClass).toBe('worker_handoff');
    expect(segment?.modules).toContain('worker 交接等待');
    expect(segment?.semantics?.wakeSources[0]).toMatchObject({
      wakeSource: 'same_process_thread', wakerRole: 'worker', irqContext: false,
    });
    expect(analysis.anomalies.some(entry => entry.title === '等待链涉及网络收包等待候选')).toBe(false);
  });

  // Reporting the first segment of either class meant a 4 ms hand-off ahead of
  // a 30 ms receive candidate hid the segment worth opening, and whichever
  // class lost the race went unmentioned.
  it('reports both wait classes, each naming its own longest segment', async () => {
    const analysis = await analyzeCriticalPath(
      wakeChainService([SHORT_HANDOFF_WAKE, NETWORK_WAKE, LONG_HANDOFF_WAKE]),
      'trace-1',
      {threadStateId: 301, recursionEnabled: false},
    );

    expect(analysis.wakeupChain.map(entry => entry.wakeSourceClass)).toEqual([
      'worker_handoff', 'network_receive_candidate', 'worker_handoff',
    ]);
    const wakeAnomalies = analysis.anomalies.filter(entry =>
      entry.title === '等待链涉及网络收包等待候选' || entry.title === '等待链涉及 worker 交接等待');
    expect(wakeAnomalies.map(entry => ({title: entry.title, evidence: entry.evidence}))).toEqual([
      {title: '等待链涉及网络收包等待候选', evidence: ['com.demo / OkHttp Dispatch', '30.00 ms']},
      {title: '等待链涉及 worker 交接等待', evidence: ['com.demo / pool-1-thread-2', '12.00 ms']},
    ]);
  });

  it('keeps a wake-source candidate behind the labels the segment already has', async () => {
    // The network segment's only L3 signal is its wake source, a candidate
    // rather than timed evidence: its keyword label stays first, the candidate
    // follows, and the breakdown books the segment under the keyword label.
    const analysis = await analyzeCriticalPath(
      wakeChainService([NETWORK_WAKE], ['binder transaction']),
      'trace-1',
      {threadStateId: 301, recursionEnabled: false},
    );

    const segment = analysis.wakeupChain.find(entry => entry.threadName === 'OkHttp Dispatch');
    expect(segment?.modules).toEqual(['Binder / IPC', '网络收包等待候选']);
    expect(analysis.moduleBreakdown.find((item) => item.module === 'Binder / IPC')?.durationMs).toBe(30);
    expect(analysis.moduleBreakdown.some((item) => item.module === '网络收包等待候选')).toBe(false);
  });
});

// Perfetto ends a wake chain at every S/I/D segment of another thread (its wake
// came from an IRQ, the idle task or an io_wait), so those segments are the
// waker's own interrupt-ended sleep: leaves, never cost by themselves.
describe('attributable accounting of chain leaves', () => {
  // The task (thread 1) sleeps 3010 ms; the chain is a 3000 ms S leaf of
  // another thread plus 8 ms of work, runnable and device time.
  const LEAF_CHAIN: StackSegment[] = [
    {ts: 90000 * MS, dur: 3000 * MS, utid: 2, state: 'S', thread: 'binder:system', process: 'system_server'},
    {ts: 93000 * MS, dur: 5 * MS, utid: 3, state: 'Running', thread: 'RenderThread', process: 'com.demo'},
    {ts: 93005 * MS, dur: 1 * MS, utid: 3, state: 'R', thread: 'RenderThread', process: 'com.demo'},
    {ts: 93006 * MS, dur: 2 * MS, utid: 5, state: 'D', thread: 'kworker/0', process: 'kworker'},
  ];
  const leafSetup = (extra = ''): string => `${BASE_THREADS}
    INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (170, 1, ${90000 * MS}, ${3010 * MS}, 'S');
    ${extra}
  `;
  const leafRules = (): SqlRule[] => [{
    match: /FROM _critical_path_stack/i,
    responder: (sql) => (stackRoot(sql) === 1 ? stackResult(LEAF_CHAIN) : queryResult(STACK_COLUMNS, [])),
  }];

  it('counts only work, runnable and device time as attributable and names the leaf separately', async () => {
    const {tp, sqls} = sqliteTraceProcessor(leafSetup(), {rules: leafRules()});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 170});
    const totals = analysis.totalsNs!;

    expect(totals).toMatchObject({
      work: 5 * MS, runnable: 1 * MS, deviceWait: 2 * MS, eventWait: 3000 * MS, other: 0,
      attributable: 8 * MS, blocking: 3008 * MS, chainWait: 3002 * MS,
    });
    // One accounting: the roles add up to the path coverage.
    expect(totals.work + totals.runnable + totals.deviceWait + totals.eventWait + totals.other).toBe(totals.blocking);
    expect(totals.deviceWait + totals.eventWait).toBe(totals.chainWait);
    expect(analysis.blockingMs).toBe(3008);
    expect(analysis.attributableMs).toBe(8);
    expect(analysis.eventWaitMs).toBe(3000);
    expect(analysis.longestEventWait).toMatchObject({utid: 2, threadName: 'binder:system', durationMs: 3000});
    // The leaf is not the longest cost, nor what the counterfactual removes.
    expect(analysis.longestSegment).toMatchObject({threadName: 'RenderThread', durationMs: 5});
    expect(analysis.quantification?.counterfactual?.maxSavingMs).toBe(5);
    const ids = analysis.anomalies.map((anomaly) => anomaly.id);
    expect(ids).not.toContain('external_share_high');
    // The thread has no slices at all: the trace cannot call the wait idle, so
    // a chain that ends in a peer's sleep is reported as that peer's blocker.
    expect(analysis.rootWait).toMatchObject({threadStateId: 170, context: 'no_slice_data', enclosingSlice: null});
    expect(ids).toContain('peer_event_wait');
    expect(analysis.anomalies.find((anomaly) => anomaly.id === 'peer_event_wait')).toMatchObject({
      severity: 'warning', params: expect.objectContaining({thread: 'binder:system', leafMs: 3000}),
    });
    expect(analysis.recommendationIds).toContain('follow_peer_event_wait');
    // Only the work segment is expanded; the leaves are never queried again.
    expect(stackCalls(sqls).map(stackRoot)).toEqual([1, 3]);
  });

  it('calls a wait between the thread\'s own slices with little attributable time idle, and nothing else', async () => {
    const {tp} = sqliteTraceProcessor(leafSetup(`
      INSERT INTO thread_track(id, utid) VALUES (40, 1);
      INSERT INTO slice(id, ts, dur, depth, name, track_id) VALUES
        (1, ${89990 * MS}, ${5 * MS}, 0, 'doFrame', 40),
        (2, ${93020 * MS}, ${5 * MS}, 0, 'dispatchInputEvent', 40);
    `), {rules: leafRules()});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 170});
    const ids = analysis.anomalies.map((anomaly) => anomaly.id);

    expect(analysis.rootWait).toMatchObject({context: 'between_slices', enclosingSlice: null});
    expect(ids).toContain('idle_wait');
    // An idle wait is long by nature: no duration finding, no peer blocker.
    expect(ids).not.toContain('task_too_long');
    expect(ids).not.toContain('peer_event_wait');
    expect(analysis.recommendationIds).toContain('choose_active_window');
    expect(analysis.summary).toContain('更像线程空闲');
  });

  it('keeps an in-slice wait whose chain ends in a peer\'s sleep a blocker, never idle', async () => {
    const {tp} = sqliteTraceProcessor(leafSetup(`
      INSERT INTO thread_track(id, utid) VALUES (40, 1);
      INSERT INTO slice(id, ts, dur, depth, name, track_id) VALUES
        (1, ${89990 * MS}, ${3100 * MS}, 0, 'Choreographer#doFrame', 40),
        (2, ${89995 * MS}, ${3050 * MS}, 1, 'Lock contention on a monitor lock', 40);
    `), {rules: leafRules()});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 170});
    const ids = analysis.anomalies.map((anomaly) => anomaly.id);

    expect(analysis.rootWait).toMatchObject({
      context: 'in_slice',
      enclosingSlice: {name: 'Lock contention on a monitor lock', depth: 1},
    });
    expect(ids).toContain('peer_event_wait');
    expect(ids).not.toContain('idle_wait');
    expect(ids).toContain('task_too_long');
  });

  it('reads I as a sleep: an event wait, not an unknown state', async () => {
    const {tp} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES
        (180, 1, ${95000 * MS}, ${4 * MS}, 'Running'),
        (181, 1, ${95004 * MS}, ${6 * MS}, 'I');
    `, {rules: [{match: /FROM _critical_path_stack/i, responder: () => queryResult(STACK_COLUMNS, [])}]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 1, startTs: 95000 * MS, dur: 10 * MS});

    expect(analysis.slices?.map((slice) => slice.kind)).toEqual(['running', 'sleeping']);
    // The I slice is the window's waiting time, so the range is analyzed.
    expect(analysis.unavailableReason).toBe('no_critical_path_stack');
    expect(analysis.totalsNs?.waiting).toBe(6 * MS);
  });
});

describe('selected rows and windows the engine must not misread', () => {
  it('treats thread_state id 0 as a real row, not as an absent selector', async () => {
    const {tp, sqls} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (0, 3, ${96000 * MS}, ${2 * MS}, 'Running');
    `);

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: '0'});

    expect(analysis.task).toMatchObject({threadStateId: 0, utid: 3});
    expect(analysis.unavailableReason).toBe('task_state_running');
    expect(sqls.some((sql) => /WHERE target\.id = 0\b/.test(sql))).toBe(true);
  });

  it('reads a wait still open at the end of the trace up to that end, and says so', async () => {
    const stack = stackResult([
      {ts: 97000 * MS, dur: 40 * MS, utid: 2, state: 'Running', thread: 'binder:system', process: 'system_server'},
    ]);
    const {tp} = sqliteTraceProcessor(`${BASE_THREADS}
      UPDATE trace_bounds SET end_ts = ${97050 * MS};
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (190, 1, ${97000 * MS}, -1, 'S');
    `, {rules: [{match: /FROM _critical_path_stack/i, responder: () => stack}]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 190});

    expect(analysis.available).toBe(true);
    expect(analysis.task.dur).toBe(50 * MS);
    expect(analysis.warningCodes).toContainEqual({code: 'wait_open_at_trace_end', params: {ms: 50}});
  });

  it('names an open wait with no chain wait_open_at_trace_end, not a missing stack', async () => {
    const {tp} = sqliteTraceProcessor(`${BASE_THREADS}
      UPDATE trace_bounds SET end_ts = ${98050 * MS};
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES
        (191, 1, ${98000 * MS}, -1, 'S'),
        (192, 1, ${98050 * MS}, -1, 'S');
    `, {rules: [{match: /FROM _critical_path_stack/i, responder: () => queryResult(STACK_COLUMNS, [])}]});

    const open = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 191});
    expect(open).toMatchObject({available: false, unavailableReason: 'wait_open_at_trace_end'});
    expect(open.recommendationIds).toEqual(['inspect_unfinished_wait']);

    // A row that opened exactly at the end of the trace has nothing to read,
    // which is still not a caller error.
    const atEnd = await analyzeCriticalPath(tp, 'trace-1', {threadStateId: 192});
    expect(atEnd).toMatchObject({available: false, unavailableReason: 'wait_open_at_trace_end'});
  });

  it('answers a range with no thread_state rows no_thread_state_in_window, never no_waiting_time', async () => {
    const {tp, sqls} = sqliteTraceProcessor(`${BASE_THREADS}
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (193, 1, ${99000 * MS}, ${5 * MS}, 'S');
    `);

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 3, startTs: 99000 * MS, dur: 10 * MS});

    expect(analysis).toMatchObject({available: false, unavailableReason: 'no_thread_state_in_window'});
    expect(analysis.recommendationIds).toEqual(['choose_thread_with_sched_data']);
    expect(analysis.anomalies[0].title).toBe('该线程在选区内没有调度数据');
    expect(stackCalls(sqls)).toHaveLength(0);
  });

  it('includes a range row still open at the end of the trace', async () => {
    const {tp} = sqliteTraceProcessor(`${BASE_THREADS}
      UPDATE trace_bounds SET end_ts = ${99600 * MS};
      INSERT INTO thread_state(id, utid, ts, dur, state) VALUES (194, 1, ${99500 * MS}, -1, 'S');
    `, {rules: [{match: /FROM _critical_path_stack/i, responder: () => queryResult(STACK_COLUMNS, [])}]});

    const analysis = await analyzeCriticalPath(tp, 'trace-1', {utid: 1, startTs: 99550 * MS, dur: 20 * MS});

    expect(analysis.slices).toEqual([expect.objectContaining({threadStateId: 194, durationMs: 20})]);
    expect(analysis.unavailableReason).toBe('wait_open_at_trace_end');
  });
});
