// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from './traceProcessorService';

export interface CriticalPathAnalyzeOptions {
  threadStateId?: number | string;
  utid?: number | string;
  startTs?: number | string;
  dur?: number | string;
  endTs?: number | string;
  maxSegments?: number;
}

export interface CriticalPathTaskInfo {
  threadStateId?: number;
  utid: number;
  tid?: number | null;
  startTs: number;
  dur: number;
  durationMs: number;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  threadName?: string | null;
  processName?: string | null;
  waker?: {
    threadStateId?: number | null;
    utid?: number | null;
    threadName?: string | null;
    processName?: string | null;
    state?: string | null;
    interruptContext?: boolean | null;
  };
}

export interface CriticalPathSegment {
  startTs: number;
  dur: number;
  startOffsetMs: number;
  durationMs: number;
  utid: number;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: string[];
  modules: string[];
  reasons: string[];
}

export interface CriticalPathModuleStat {
  module: string;
  durationMs: number;
  percentage: number;
  segmentCount: number;
  examples: string[];
}

export interface CriticalPathAnomaly {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  evidence: string[];
}

export interface CriticalPathAnalysis {
  available: boolean;
  task: CriticalPathTaskInfo;
  totalMs: number;
  blockingMs: number;
  selfMs: number;
  externalBlockingPercentage: number;
  wakeupChain: CriticalPathSegment[];
  moduleBreakdown: CriticalPathModuleStat[];
  anomalies: CriticalPathAnomaly[];
  summary: string;
  recommendations: string[];
  warnings: string[];
  rawRows: number;
  truncated: boolean;
}

interface CriticalPathStackRow {
  ts: number;
  dur: number;
  utid: number;
  rootUtid: number;
  stackDepth: number;
  name: string;
  tableName?: string | null;
  threadName?: string | null;
  processName?: string | null;
}

interface SegmentAccumulator {
  startTs: number;
  dur: number;
  utid: number;
  rootUtid: number;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: Set<string>;
  modules: Set<string>;
  reasons: Set<string>;
}

interface QueryRow {
  [key: string]: unknown;
}

function rowObject(columns: string[], row: unknown[]): QueryRow {
  const out: QueryRow = {};
  columns.forEach((column, index) => {
    out[column] = row[index];
  });
  return out;
}

async function queryRows(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  sql: string
): Promise<QueryRow[]> {
  const result = await traceProcessorService.query(traceId, sql);
  return result.rows.map((row) => rowObject(result.columns, row));
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const converted = toNumber(value, Number.NaN);
  return Number.isFinite(converted) ? converted : null;
}

function toOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toBool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  const numeric = toNullableNumber(value);
  return numeric === null ? null : numeric > 0;
}

function normalizeIntegerSql(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return raw;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function nsToMs(value: number): number {
  return Math.round((value / 1e6) * 100) / 100;
}

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value * 10_000) / total) / 100;
}

function stateLabel(state?: string | null): string {
  if (!state) return '未知状态';
  const first = state[0];
  const labels: Record<string, string> = {
    R: state.includes('+') ? 'Runnable + Preempted' : 'Runnable',
    S: 'Sleeping',
    D: 'Uninterruptible Sleep',
    T: 'Stopped',
    t: 'Traced',
    X: 'Exit Dead',
    Z: 'Zombie',
    I: 'Idle',
    K: 'Wake Kill',
    W: 'Waking',
    P: 'Parked',
    Running: 'Running',
  };
  return labels[state] ?? labels[first] ?? state;
}

function stripPrefix(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const stripped = value.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : null;
}

function classifyModules(texts: string[]): string[] {
  const joined = texts.join(' ').toLowerCase();
  const modules: string[] = [];

  const add = (label: string, pattern: RegExp) => {
    if (pattern.test(joined)) modules.push(label);
  };

  add('Binder / IPC', /\bbinder\b|hwbinder|ipc(threadstate|transaction)|transact/);
  add('锁 / Futex', /futex|mutex|monitor|lock|rwsem|sem_wait|condition/);
  add('IO / 文件系统', /io_wait|i\/o|fsync|read|write|ext4|f2fs|block|mmc|ufs|sqlite|wal|journal/);
  add('调度 / CPU 竞争', /runnable|preempt|__schedule|schedule_timeout|cpu:\s*\d+|sched/);
  add('图形渲染 / Surface', /renderthread|surfaceflinger|blast|bufferqueue|queuebuffer|dequeuebuffer|doframe|drawframe|traversal|hwui|skia|egl|vulkan|opengl/);
  add('输入链路', /inputdispatcher|inputreader|motionevent|touch|gesture/);
  add('ART / GC', /\bgc\b|garbage|art::|dalvik|jit|dex2oat/);
  add('Kernel / IRQ / Workqueue', /\birq\/|kworker|softirq|workqueue|rcu|kernel|interrupt/);
  add('电源 / 唤醒', /wakeup|wakelock|suspend|cpuidle|power/);

  return modules.length > 0 ? modules : ['未归类'];
}

function addReason(segment: SegmentAccumulator, reason: string | null | undefined): void {
  if (reason && reason.trim()) {
    segment.reasons.add(reason.trim());
  }
}

function getSegment(
  segments: Map<string, SegmentAccumulator>,
  row: CriticalPathStackRow
): SegmentAccumulator {
  const key = `${row.ts}|${row.dur}|${row.utid}`;
  let segment = segments.get(key);
  if (!segment) {
    segment = {
      startTs: row.ts,
      dur: row.dur,
      utid: row.utid,
      rootUtid: row.rootUtid,
      processName: row.processName,
      threadName: row.threadName,
      slices: new Set<string>(),
      modules: new Set<string>(),
      reasons: new Set<string>(),
    };
    segments.set(key, segment);
  }
  segment.processName ??= row.processName;
  segment.threadName ??= row.threadName;
  return segment;
}

function normalizeStackRows(rows: QueryRow[]): CriticalPathStackRow[] {
  return rows
    .map((row) => ({
      ts: toNumber(row.ts),
      dur: toNumber(row.dur),
      utid: toNumber(row.utid),
      rootUtid: toNumber(row.root_utid),
      stackDepth: toNumber(row.stack_depth),
      name: String(row.name ?? ''),
      tableName: toOptionalString(row.table_name),
      threadName: toOptionalString(row.thread_name),
      processName: toOptionalString(row.process_name),
    }))
    .filter((row) => row.dur > 0 && row.name.length > 0 && row.utid !== row.rootUtid);
}

function buildSegments(rows: CriticalPathStackRow[], task: CriticalPathTaskInfo): CriticalPathSegment[] {
  const segments = new Map<string, SegmentAccumulator>();

  for (const row of rows) {
    const segment = getSegment(segments, row);
    const name = row.name;

    const state = stripPrefix(name, 'blocking thread_state:');
    if (state) {
      segment.state = state;
      addReason(segment, stateLabel(state));
    }

    const processName = stripPrefix(name, 'blocking process_name:');
    if (processName) {
      segment.processName = processName;
    }

    const threadName = stripPrefix(name, 'blocking thread_name:');
    if (threadName) {
      segment.threadName = threadName;
    }

    const kernelFunction = stripPrefix(name, 'blocking kernel_function:');
    if (kernelFunction) {
      segment.blockedFunction = kernelFunction;
      addReason(segment, kernelFunction);
    }

    const ioWait = stripPrefix(name, 'blocking io_wait:');
    if (ioWait) {
      segment.ioWait = ioWait === '1' || ioWait.toLowerCase() === 'true';
      if (segment.ioWait) addReason(segment, 'io_wait');
    }

    const cpu = stripPrefix(name, 'cpu:');
    if (cpu) {
      segment.cpu = toNullableNumber(cpu);
      addReason(segment, `CPU ${cpu}`);
    }

    if (row.tableName === 'slice' && !name.startsWith('blocking ') && name !== task.threadName) {
      segment.slices.add(name);
      addReason(segment, name);
    }
  }

  return Array.from(segments.values())
    .map((segment) => {
      const evidence = [
        segment.processName,
        segment.threadName,
        segment.state,
        segment.blockedFunction,
        ...Array.from(segment.slices).slice(0, 6),
        ...Array.from(segment.reasons).slice(0, 6),
      ].filter((item): item is string => typeof item === 'string' && item.length > 0);
      const modules = classifyModules(evidence);
      modules.forEach((module) => segment.modules.add(module));
      return {
        startTs: segment.startTs,
        dur: segment.dur,
        startOffsetMs: nsToMs(segment.startTs - task.startTs),
        durationMs: nsToMs(segment.dur),
        utid: segment.utid,
        processName: segment.processName,
        threadName: segment.threadName,
        state: segment.state,
        blockedFunction: segment.blockedFunction,
        ioWait: segment.ioWait,
        cpu: segment.cpu,
        slices: Array.from(segment.slices).slice(0, 8),
        modules: Array.from(segment.modules),
        reasons: Array.from(segment.reasons).slice(0, 8),
      };
    })
    .sort((a, b) => a.startTs - b.startTs || b.dur - a.dur);
}

function mergeAdjacentSegments(segments: CriticalPathSegment[]): CriticalPathSegment[] {
  const merged: CriticalPathSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const sameOwner =
      previous &&
      previous.utid === segment.utid &&
      previous.processName === segment.processName &&
      previous.threadName === segment.threadName &&
      previous.state === segment.state &&
      previous.startTs + previous.dur === segment.startTs;

    if (!sameOwner) {
      merged.push({...segment});
      continue;
    }

    previous.dur += segment.dur;
    previous.durationMs = nsToMs(previous.dur);
    previous.slices = Array.from(new Set([...previous.slices, ...segment.slices])).slice(0, 8);
    previous.modules = Array.from(new Set([...previous.modules, ...segment.modules]));
    previous.reasons = Array.from(new Set([...previous.reasons, ...segment.reasons])).slice(0, 8);
  }
  return merged;
}

function buildModuleBreakdown(segments: CriticalPathSegment[], totalMs: number): CriticalPathModuleStat[] {
  const stats = new Map<string, { durationMs: number; segmentCount: number; examples: Set<string> }>();
  for (const segment of segments) {
    const modules = segment.modules.length > 0 ? segment.modules : ['未归类'];
    for (const module of modules) {
      const current = stats.get(module) ?? { durationMs: 0, segmentCount: 0, examples: new Set<string>() };
      current.durationMs += segment.durationMs;
      current.segmentCount += 1;
      const example = [segment.processName, segment.threadName, segment.blockedFunction ?? segment.slices[0]]
        .filter(Boolean)
        .join(' / ');
      if (example) current.examples.add(example);
      stats.set(module, current);
    }
  }

  return Array.from(stats.entries())
    .map(([module, value]) => ({
      module,
      durationMs: Math.round(value.durationMs * 100) / 100,
      percentage: pct(value.durationMs, totalMs),
      segmentCount: value.segmentCount,
      examples: Array.from(value.examples).slice(0, 3),
    }))
    .sort((a, b) => b.durationMs - a.durationMs || a.module.localeCompare(b.module));
}

function buildAnomalies(
  task: CriticalPathTaskInfo,
  segments: CriticalPathSegment[],
  moduleBreakdown: CriticalPathModuleStat[],
  blockingMs: number
): CriticalPathAnomaly[] {
  const anomalies: CriticalPathAnomaly[] = [];
  const totalMs = task.durationMs;
  const blockingPct = pct(blockingMs, totalMs);
  const longest = segments[0] ? [...segments].sort((a, b) => b.durationMs - a.durationMs)[0] : undefined;

  if (totalMs >= 50) {
    anomalies.push({
      severity: 'critical',
      title: '选中 task 本身耗时过长',
      detail: `选中区间持续 ${totalMs.toFixed(2)} ms，已经超过 50 ms，足以造成明显交互卡顿或启动阶段长尾。`,
      evidence: [`task=${task.processName ?? '-'} / ${task.threadName ?? '-'}`, `state=${stateLabel(task.state)}`],
    });
  } else if (totalMs >= 16.67) {
    anomalies.push({
      severity: 'warning',
      title: '选中 task 超过单帧预算',
      detail: `选中区间持续 ${totalMs.toFixed(2)} ms，超过 60Hz 单帧 16.67 ms 预算。`,
      evidence: [`state=${stateLabel(task.state)}`],
    });
  }

  if (blockingPct >= 70 && blockingMs >= 8) {
    anomalies.push({
      severity: 'warning',
      title: '外部 critical path 占比过高',
      detail: `外部线程/模块贡献 ${blockingMs.toFixed(2)} ms，占选中区间 ${blockingPct.toFixed(2)}%。这通常不是单点函数慢，而是等待链或调度链拖慢。`,
      evidence: longest
        ? [`最长外部段=${longest.processName ?? '-'} / ${longest.threadName ?? '-'} ${longest.durationMs.toFixed(2)} ms`]
        : [],
    });
  }

  if (longest && longest.durationMs >= 8) {
    anomalies.push({
      severity: longest.durationMs >= 16.67 ? 'warning' : 'info',
      title: '存在长 critical path 段',
      detail: `${longest.processName ?? '-'} / ${longest.threadName ?? '-'} 在 critical path 上持续 ${longest.durationMs.toFixed(2)} ms。`,
      evidence: [...longest.modules, ...longest.reasons].slice(0, 5),
    });
  }

  const ioSegment = segments.find((segment) => segment.ioWait || segment.modules.includes('IO / 文件系统'));
  if (ioSegment) {
    anomalies.push({
      severity: 'warning',
      title: '等待链涉及 IO 或文件系统',
      detail: 'critical path 中出现 IO wait、文件系统或存储相关信号，需要确认是否有同步读写、fsync、SQLite/WAL 或 block 层等待。',
      evidence: [ioSegment.blockedFunction, ...ioSegment.slices, `${ioSegment.durationMs.toFixed(2)} ms`].filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      ),
    });
  }

  const binder = moduleBreakdown.find((item) => item.module === 'Binder / IPC');
  if (binder && binder.durationMs >= 2) {
    anomalies.push({
      severity: binder.durationMs >= 8 ? 'warning' : 'info',
      title: '等待链涉及 Binder / IPC',
      detail: `Binder / IPC 在 critical path 中累计 ${binder.durationMs.toFixed(2)} ms，可能是跨进程服务调用、系统服务或回调链路导致。`,
      evidence: binder.examples,
    });
  }

  const runnable = segments.find((segment) => /R|\+|Runnable|Running/.test(segment.state ?? '') || segment.modules.includes('调度 / CPU 竞争'));
  if (runnable && blockingMs >= 4) {
    anomalies.push({
      severity: 'info',
      title: '存在调度或 CPU 竞争迹象',
      detail: 'critical path 中出现 Runnable/Running/CPU 相关段，建议结合 CPU 轨道看同一时间是否有高优先级线程、RT 线程或大核竞争。',
      evidence: [`${runnable.processName ?? '-'} / ${runnable.threadName ?? '-'}`, ...runnable.reasons].slice(0, 5),
    });
  }

  if (anomalies.length === 0) {
    anomalies.push({
      severity: 'info',
      title: '未发现明显异常',
      detail: '从 critical path stack 看，没有出现长外部等待、IO wait、Binder 长等待或明显 CPU 竞争信号。',
      evidence: [`选中 task=${totalMs.toFixed(2)} ms`, `外部 critical path=${blockingMs.toFixed(2)} ms`],
    });
  }

  return anomalies;
}

function buildRecommendations(
  anomalies: CriticalPathAnomaly[],
  moduleBreakdown: CriticalPathModuleStat[]
): string[] {
  const recommendations: string[] = [];
  const modules = new Set(moduleBreakdown.slice(0, 4).map((item) => item.module));

  if (modules.has('Binder / IPC')) {
    recommendations.push('沿 Binder / IPC 相关线程继续看调用方与被调服务，确认是否同步跨进程调用阻塞了目标线程。');
  }
  if (modules.has('IO / 文件系统')) {
    recommendations.push('排查选中区间附近的同步 IO、fsync、SQLite/WAL、资源加载或 block 层等待，必要时补充 ftrace block/ext4/f2fs 事件。');
  }
  if (modules.has('锁 / Futex')) {
    recommendations.push('结合 futex/monitor/lock 相关 slice 和调用栈采样，定位持锁线程以及锁竞争入口。');
  }
  if (modules.has('图形渲染 / Surface')) {
    recommendations.push('把 critical path 与 Choreographer、RenderThread、SurfaceFlinger、BufferQueue/BLAST 时间线对齐，确认卡点在 App 绘制还是系统合成。');
  }
  if (modules.has('调度 / CPU 竞争')) {
    recommendations.push('查看同一时间 CPU 轨道和线程优先级，确认是否被高优先级线程、RT 线程或频率/大小核调度影响。');
  }

  if (recommendations.length === 0 || anomalies.some((item) => item.severity !== 'info')) {
    recommendations.push('优先从最长 critical path 段入手，而不是只看选中线程自己的 slice；等待链上的外部线程才可能是直接原因。');
  }

  return Array.from(new Set(recommendations)).slice(0, 5);
}

function buildSummary(
  task: CriticalPathTaskInfo,
  segments: CriticalPathSegment[],
  moduleBreakdown: CriticalPathModuleStat[],
  anomalies: CriticalPathAnomaly[],
  blockingMs: number
): string {
  const topModules = moduleBreakdown
    .slice(0, 3)
    .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
    .join('、');
  const topSegment = segments.length > 0 ? [...segments].sort((a, b) => b.durationMs - a.durationMs)[0] : undefined;
  const highestSeverity = anomalies.find((item) => item.severity === 'critical') ?? anomalies.find((item) => item.severity === 'warning');
  const lines = [
    `选中 task 位于 ${task.processName ?? '-'} / ${task.threadName ?? '-'}，状态 ${stateLabel(task.state)}，持续 ${task.durationMs.toFixed(2)} ms。`,
    `critical path 外部链路累计 ${blockingMs.toFixed(2)} ms，占 ${pct(blockingMs, task.durationMs).toFixed(2)}%。`,
  ];

  if (topSegment) {
    lines.push(
      `最长外部段是 ${topSegment.processName ?? '-'} / ${topSegment.threadName ?? '-'}，持续 ${topSegment.durationMs.toFixed(2)} ms，关联 ${topSegment.modules.join('、')}。`
    );
  }
  if (topModules) {
    lines.push(`主要关联模块：${topModules}。`);
  }
  if (highestSeverity) {
    lines.push(`异常判断：${highestSeverity.title}。${highestSeverity.detail}`);
  }
  if (task.waker?.threadName || task.waker?.interruptContext) {
    const waker = task.waker.interruptContext
      ? 'Interrupt'
      : `${task.waker.processName ?? '-'} / ${task.waker.threadName ?? '-'}`;
    lines.push(`直接唤醒来源：${waker}。`);
  }

  return lines.join('\n');
}

function buildEmptyAnalysis(task: CriticalPathTaskInfo, warnings: string[]): CriticalPathAnalysis {
  const anomalies = [
    {
      severity: 'info' as const,
      title: '没有取到 critical path stack',
      detail: 'Perfetto 没有返回 selected task 范围内的 critical path stack。常见原因是 trace 缺少 sched_wakeup / thread_state 数据，或选中区间没有可追踪的等待链。',
      evidence: [`task=${task.durationMs.toFixed(2)} ms`, `utid=${task.utid}`],
    },
  ];
  return {
    available: false,
    task,
    totalMs: task.durationMs,
    blockingMs: 0,
    selfMs: task.durationMs,
    externalBlockingPercentage: 0,
    wakeupChain: [],
    moduleBreakdown: [],
    anomalies,
    summary: buildSummary(task, [], [], anomalies, 0),
    recommendations: ['确认录制配置包含 sched/sched_switch、sched/sched_wakeup、sched/sched_blocked_reason；如果只是想看整体线程链路，可改用区域选择后再分析。'],
    warnings,
    rawRows: 0,
    truncated: false,
  };
}

async function loadTaskInfo(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions
): Promise<CriticalPathTaskInfo> {
  const threadStateId = normalizeIntegerSql(options.threadStateId, 'threadStateId');
  if (threadStateId) {
    const rows = await queryRows(
      traceProcessorService,
      traceId,
      `
      SELECT
        target.id AS thread_state_id,
        target.ts,
        target.dur,
        target.utid,
        target.state,
        target.blocked_function,
        target.io_wait,
        target.cpu,
        target.waker_id,
        target.irq_context,
        thread.tid,
        thread.name AS thread_name,
        process.name AS process_name,
        waker_state.utid AS waker_utid,
        waker_state.state AS waker_state,
        waker_thread.name AS waker_thread_name,
        waker_process.name AS waker_process_name
      FROM thread_state AS target
      LEFT JOIN thread USING(utid)
      LEFT JOIN process USING(upid)
      LEFT JOIN thread_state AS waker_state ON target.waker_id = waker_state.id
      LEFT JOIN thread AS waker_thread ON waker_state.utid = waker_thread.utid
      LEFT JOIN process AS waker_process ON waker_thread.upid = waker_process.upid
      WHERE target.id = ${threadStateId}
      LIMIT 1
    `
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`thread_state ${threadStateId} not found`);
    }
    const dur = toNumber(row.dur);
    return {
      threadStateId: toNumber(row.thread_state_id),
      utid: toNumber(row.utid),
      tid: toNullableNumber(row.tid),
      startTs: toNumber(row.ts),
      dur,
      durationMs: nsToMs(dur),
      state: toOptionalString(row.state),
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      cpu: toNullableNumber(row.cpu),
      threadName: toOptionalString(row.thread_name),
      processName: toOptionalString(row.process_name),
      waker: {
        threadStateId: toNullableNumber(row.waker_id),
        utid: toNullableNumber(row.waker_utid),
        threadName: toOptionalString(row.waker_thread_name),
        processName: toOptionalString(row.waker_process_name),
        state: toOptionalString(row.waker_state),
        interruptContext: toBool(row.irq_context),
      },
    };
  }

  const utid = normalizeIntegerSql(options.utid, 'utid');
  const startTs = normalizeIntegerSql(options.startTs, 'startTs');
  const dur = normalizeIntegerSql(
    options.dur ??
      (options.endTs !== undefined && options.startTs !== undefined
        ? String(toNumber(options.endTs) - toNumber(options.startTs))
        : undefined),
    'dur'
  );
  if (!utid || !startTs || !dur) {
    throw new Error('threadStateId or utid/startTs/dur is required');
  }

  const taskDur = toNumber(dur);
  const rows = await queryRows(
    traceProcessorService,
    traceId,
    `
    SELECT
      thread.utid,
      thread.tid,
      thread.name AS thread_name,
      process.name AS process_name
    FROM thread
    LEFT JOIN process USING(upid)
    WHERE thread.utid = ${utid}
    LIMIT 1
  `
  );
  const row = rows[0] ?? {};
  return {
    utid: toNumber(utid),
    tid: toNullableNumber(row.tid),
    startTs: toNumber(startTs),
    dur: taskDur,
    durationMs: nsToMs(taskDur),
    threadName: toOptionalString(row.thread_name),
    processName: toOptionalString(row.process_name),
  };
}

export async function analyzeCriticalPath(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions = {}
): Promise<CriticalPathAnalysis> {
  const task = await loadTaskInfo(traceProcessorService, traceId, options);
  const maxSegments = normalizePositiveInt(options.maxSegments, 160, 20, 1000);
  const warnings: string[] = [];

  if (task.dur <= 0) {
    throw new Error('Selected task duration must be positive');
  }

  await traceProcessorService.query(traceId, 'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;');
  const rows = await queryRows(
    traceProcessorService,
    traceId,
    `
    SELECT
      cr.id,
      cr.ts,
      cr.dur,
      cr.utid,
      cr.stack_depth,
      cr.name,
      cr.table_name,
      cr.root_utid,
      thread.name AS thread_name,
      process.name AS process_name
    FROM _critical_path_stack(${task.utid}, ${Math.trunc(task.startTs)}, ${Math.trunc(task.dur)}, 1, 1, 1, 1) AS cr
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE cr.name IS NOT NULL
    ORDER BY cr.ts ASC, cr.stack_depth ASC, cr.utid ASC
    LIMIT ${maxSegments * 20 + 1}
  `
  );

  const truncated = rows.length > maxSegments * 20;
  if (truncated) {
    warnings.push(`critical path stack 结果较大，已按前 ${maxSegments} 个链路段截断展示。`);
  }

  const stackRows = normalizeStackRows(truncated ? rows.slice(0, maxSegments * 20) : rows);
  const segments = mergeAdjacentSegments(buildSegments(stackRows, task)).slice(0, maxSegments);
  if (segments.length === 0) {
    return buildEmptyAnalysis(task, warnings);
  }

  const blockingMs = Math.round(
    segments.reduce((sum, segment) => sum + segment.durationMs, 0) * 100
  ) / 100;
  const selfMs = Math.max(0, Math.round((task.durationMs - blockingMs) * 100) / 100);
  const moduleBreakdown = buildModuleBreakdown(segments, task.durationMs);
  const anomalies = buildAnomalies(task, segments, moduleBreakdown, blockingMs);
  const recommendations = buildRecommendations(anomalies, moduleBreakdown);

  return {
    available: true,
    task,
    totalMs: task.durationMs,
    blockingMs,
    selfMs,
    externalBlockingPercentage: pct(blockingMs, task.durationMs),
    wakeupChain: segments,
    moduleBreakdown,
    anomalies,
    summary: buildSummary(task, segments, moduleBreakdown, anomalies, blockingMs),
    recommendations,
    warnings,
    rawRows: rows.length,
    truncated,
  };
}
