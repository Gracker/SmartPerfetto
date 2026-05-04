// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 1 + Layer 4 orchestrator for critical-task analysis.
//
// Layered design:
//   L1 — state-aware dispatch (S/D/R/Running) + multi-thread_state-slice splitting
//   L2 — direct waker annotation                          (criticalPathWakerChain.ts)
//   L3 — semantic enrichment via Perfetto stdlib table joins (criticalPathSemantics.ts)
//   L4 — recursive _critical_path_stack on long external segments (this file, depth=2)
//   L5 — counterfactual upper-bound + frame impact + hypotheses  (criticalPathQuantify.ts)
//
// Schema is backward-compatible: all old CriticalPathAnalysis top-level fields
// are preserved, with new fields ADDED. Old consumers will keep working.

import {
  enrichSegmentsWithSemantics,
  type SegmentInput as SemanticSegmentInput,
  type SegmentSemantics,
  type SemanticSourceStatus,
} from './criticalPathSemantics';
import {resolveDirectWaker, type WakerHop} from './criticalPathWakerChain';
import {
  quantifyCriticalPath,
  type CriticalPathQuantification,
  type QuantifySegmentInput,
} from './criticalPathQuantify';
import {
  nsToMs,
  queryRows,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';

export interface CriticalPathAnalyzeOptions {
  threadStateId?: number | string;
  utid?: number | string;
  startTs?: number | string;
  dur?: number | string;
  endTs?: number | string;
  maxSegments?: number;
  recursionDepth?: number;
  recursionEnabled?: boolean;
  segmentBudget?: number;
}

// === Backward-compatible types (do NOT remove fields) ===

export interface CriticalPathTaskInfo {
  threadStateId?: number;
  utid: number;
  tid?: number | null;
  upid?: number | null;
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
  tid?: number | null;
  upid?: number | null;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: string[];
  modules: string[];
  reasons: string[];
  semantics?: SegmentSemantics;
  recursionDepth?: number;
  // Children: result of recursing _critical_path_stack on this segment.
  children?: CriticalPathSegment[];
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

// === New types (additive) ===

export type SliceKind = 'sleeping' | 'uninterruptible' | 'runnable' | 'running' | 'unknown';

export interface SliceFinding {
  threadStateId: number | null;
  startTs: number;
  endTs: number;
  durationMs: number;
  state: string | null;
  kind: SliceKind;
  cpu: number | null;
  blockedFunction: string | null;
  ioWait: boolean | null;
  // For Running/short slices we may skip critical-path stack lookup.
  skippedReason?: string;
  segmentCount: number;
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
  // Additive fields:
  slices?: SliceFinding[];
  directWaker?: WakerHop | null;
  quantification?: CriticalPathQuantification;
  semanticSources?: Record<string, SemanticSourceStatus>;
}

// === Helpers ===

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

function classifySlice(state: string | null): SliceKind {
  if (!state) return 'unknown';
  if (state === 'Running') return 'running';
  const first = state[0];
  if (first === 'S') return 'sleeping';
  if (first === 'D') return 'uninterruptible';
  if (first === 'R') return 'runnable';
  return 'unknown';
}

function stripPrefix(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const stripped = value.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : null;
}

// Fallback module classifier — only used when stdlib tables yielded no signal.
function classifyModulesFromText(texts: string[]): string[] {
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

  return modules;
}

function modulesFromSemantics(semantics?: SegmentSemantics): string[] {
  if (!semantics) return [];
  const modules: string[] = [];
  if (semantics.binderTxns.length > 0) modules.push('Binder / IPC');
  if (semantics.monitorContention.length > 0) modules.push('锁 / Monitor');
  if (semantics.ioSignals.length > 0) modules.push('IO / 文件系统');
  if (semantics.gcEvents.length > 0) modules.push('ART / GC');
  if (semantics.cpuCompetition.length > 0) modules.push('调度 / CPU 竞争');
  return modules;
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

function buildSegments(
  rows: CriticalPathStackRow[],
  task: CriticalPathTaskInfo
): CriticalPathSegment[] {
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
    if (processName) segment.processName = processName;

    const threadName = stripPrefix(name, 'blocking thread_name:');
    if (threadName) segment.threadName = threadName;

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
      // Initial pass uses text-based modules only; modulesFromSemantics() will
      // overwrite this once L3 enrichment runs.
      const modules = classifyModulesFromText(evidence);
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

function buildModuleBreakdown(
  segments: CriticalPathSegment[],
  totalMs: number
): CriticalPathModuleStat[] {
  const stats = new Map<
    string,
    {durationMs: number; segmentCount: number; examples: Set<string>}
  >();
  for (const segment of segments) {
    const modules = segment.modules.length > 0 ? segment.modules : ['未归类'];
    for (const module of modules) {
      const current =
        stats.get(module) ?? {durationMs: 0, segmentCount: 0, examples: new Set<string>()};
      current.durationMs += segment.durationMs;
      current.segmentCount += 1;
      const example = [
        segment.processName,
        segment.threadName,
        segment.blockedFunction ?? segment.slices[0],
      ]
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

  const ioSegment = segments.find(
    (segment) => segment.ioWait || segment.modules.includes('IO / 文件系统')
  );
  if (ioSegment) {
    anomalies.push({
      severity: 'warning',
      title: '等待链涉及 IO 或文件系统',
      detail:
        'critical path 中出现 IO wait、文件系统或存储相关信号，需要确认是否有同步读写、fsync、SQLite/WAL 或 block 层等待。',
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

  const monitor = moduleBreakdown.find((item) => item.module === '锁 / Monitor');
  if (monitor && monitor.durationMs >= 2) {
    anomalies.push({
      severity: monitor.durationMs >= 8 ? 'warning' : 'info',
      title: '等待链涉及 Java 锁竞争',
      detail: `Java monitor 锁在 critical path 中累计 ${monitor.durationMs.toFixed(2)} ms。`,
      evidence: monitor.examples,
    });
  }

  const gc = moduleBreakdown.find((item) => item.module === 'ART / GC');
  if (gc && gc.durationMs >= 2) {
    anomalies.push({
      severity: gc.durationMs >= 8 ? 'warning' : 'info',
      title: 'GC 与等待链重叠',
      detail: `ART / GC 在 critical path 中累计 ${gc.durationMs.toFixed(2)} ms，可能阻塞 mutator。`,
      evidence: gc.examples,
    });
  }

  const runnable = segments.find(
    (segment) => /R|\+|Runnable|Running/.test(segment.state ?? '') || segment.modules.includes('调度 / CPU 竞争')
  );
  if (runnable && blockingMs >= 4) {
    anomalies.push({
      severity: 'info',
      title: '存在调度或 CPU 竞争迹象',
      detail:
        'critical path 中出现 Runnable/Running/CPU 相关段，建议结合 CPU 轨道看同一时间是否有高优先级线程、RT 线程或大核竞争。',
      evidence: [`${runnable.processName ?? '-'} / ${runnable.threadName ?? '-'}`, ...runnable.reasons].slice(0, 5),
    });
  }

  if (anomalies.length === 0) {
    anomalies.push({
      severity: 'info',
      title: '未发现明显异常',
      detail:
        '从 critical path stack 看，没有出现长外部等待、IO wait、Binder 长等待或明显 CPU 竞争信号。',
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
  if (modules.has('锁 / Monitor') || modules.has('锁 / Futex')) {
    recommendations.push('结合 monitor_contention_chain / futex 相关 slice 和调用栈采样，定位持锁线程以及锁竞争入口。');
  }
  if (modules.has('图形渲染 / Surface')) {
    recommendations.push('把 critical path 与 Choreographer、RenderThread、SurfaceFlinger、BufferQueue/BLAST 时间线对齐，确认卡点在 App 绘制还是系统合成。');
  }
  if (modules.has('调度 / CPU 竞争')) {
    recommendations.push('查看同一时间 CPU 轨道和线程优先级，确认是否被高优先级线程、RT 线程或频率/大小核调度影响。');
  }
  if (modules.has('ART / GC')) {
    recommendations.push('查 GC 类型与频率，关注 mark-compact GC 是否阻塞 mutator；考虑触发条件（堆压力、显式 System.gc）。');
  }

  if (recommendations.length === 0 || anomalies.some((item) => item.severity !== 'info')) {
    recommendations.push('优先从最长 critical path 段入手，而不是只看选中线程自己的 slice；等待链上的外部线程才可能是直接原因。');
  }

  return Array.from(new Set(recommendations)).slice(0, 6);
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
  const highestSeverity =
    anomalies.find((item) => item.severity === 'critical') ??
    anomalies.find((item) => item.severity === 'warning');
  const lines = [
    `选中 task 位于 ${task.processName ?? '-'} / ${task.threadName ?? '-'}，状态 ${stateLabel(task.state)}，持续 ${task.durationMs.toFixed(2)} ms。`,
    `critical path 外部链路累计 ${blockingMs.toFixed(2)} ms，占 ${pct(blockingMs, task.durationMs).toFixed(2)}%。`,
  ];

  if (topSegment) {
    lines.push(
      `最长外部段是 ${topSegment.processName ?? '-'} / ${topSegment.threadName ?? '-'}，持续 ${topSegment.durationMs.toFixed(2)} ms，关联 ${topSegment.modules.join('、') || '未归类'}。`
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

function buildEmptyAnalysis(
  task: CriticalPathTaskInfo,
  warnings: string[],
  reason?: 'task_state_running' | 'no_critical_path_stack'
): CriticalPathAnalysis {
  const isRunning = reason === 'task_state_running';
  const anomalies = [
    {
      severity: 'info' as const,
      title: isRunning ? 'Running 状态：无等待链可分析' : '没有取到 critical path stack',
      detail: isRunning
        ? '选中 task 的 thread_state 是 Running —— 没有等待链可分析。建议查 callstack samples、slice 树或同时段 CPU 占用。'
        : 'Perfetto 没有返回 selected task 范围内的 critical path stack。常见原因是 trace 缺少 sched_wakeup / thread_state 数据，或选中区间没有可追踪的等待链。',
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
    recommendations: isRunning
      ? ['对于 Running 状态的选区，推荐查 perf/简单采样的 callstack、CPU 占用与频率，而非 critical path。']
      : ['确认录制配置包含 sched/sched_switch、sched/sched_wakeup、sched/sched_blocked_reason；如果只是想看整体线程链路，可改用区域选择后再分析。'],
    warnings,
    rawRows: 0,
    truncated: false,
  };
}

// Resolve task metadata + (when applicable) split a range selection into the
// underlying thread_state slices. Returns at least one entry; the first entry
// is the canonical task summary.
async function loadTask(
  tp: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions
): Promise<{primary: CriticalPathTaskInfo; slices: SliceFinding[]}> {
  const threadStateId = normalizeIntegerSql(options.threadStateId, 'threadStateId');
  if (threadStateId) {
    const rows = await queryRows(
      tp,
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
        thread.upid AS thread_upid,
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
    const startTs = toNumber(row.ts);
    const state = toOptionalString(row.state);
    const primary: CriticalPathTaskInfo = {
      threadStateId: toNumber(row.thread_state_id),
      utid: toNumber(row.utid),
      tid: toNullableNumber(row.tid),
      upid: toNullableNumber(row.thread_upid),
      startTs,
      dur,
      durationMs: nsToMs(dur),
      state,
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
    const slice: SliceFinding = {
      threadStateId: primary.threadStateId ?? null,
      startTs,
      endTs: startTs + dur,
      durationMs: nsToMs(dur),
      state,
      kind: classifySlice(state),
      cpu: toNullableNumber(row.cpu),
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      segmentCount: 0,
    };
    return {primary, slices: [slice]};
  }

  // Range mode: utid + startTs + dur
  const utid = normalizeIntegerSql(options.utid, 'utid');
  const startTsRaw = normalizeIntegerSql(options.startTs, 'startTs');
  const durRaw = normalizeIntegerSql(
    options.dur ??
      (options.endTs !== undefined && options.startTs !== undefined
        ? String(toNumber(options.endTs) - toNumber(options.startTs))
        : undefined),
    'dur'
  );
  if (!utid || !startTsRaw || !durRaw) {
    throw new Error('threadStateId or utid/startTs/dur is required');
  }

  const taskStart = toNumber(startTsRaw);
  const taskDur = toNumber(durRaw);
  const taskEnd = taskStart + taskDur;

  const threadRows = await queryRows(
    tp,
    traceId,
    `
    SELECT
      thread.utid,
      thread.tid,
      thread.upid AS thread_upid,
      thread.name AS thread_name,
      process.name AS process_name
    FROM thread
    LEFT JOIN process USING(upid)
    WHERE thread.utid = ${utid}
    LIMIT 1
  `
  );
  const threadRow = threadRows[0] ?? {};

  // Pull all overlapping thread_state slices to drive multi-slice splitting.
  const sliceRows = await queryRows(
    tp,
    traceId,
    `
    SELECT id, ts, dur, state, blocked_function, io_wait, cpu
    FROM thread_state
    WHERE utid = ${utid}
      AND ts <= ${taskEnd}
      AND ts + dur >= ${taskStart}
    ORDER BY ts ASC
  `
  );

  const slices: SliceFinding[] = sliceRows.map((row) => {
    const sliceStart = Math.max(taskStart, toNumber(row.ts));
    const sliceEnd = Math.min(taskEnd, toNumber(row.ts) + toNumber(row.dur));
    const sliceDur = Math.max(0, sliceEnd - sliceStart);
    const state = toOptionalString(row.state);
    return {
      threadStateId: toNullableNumber(row.id),
      startTs: sliceStart,
      endTs: sliceEnd,
      durationMs: nsToMs(sliceDur),
      state,
      kind: classifySlice(state),
      cpu: toNullableNumber(row.cpu),
      blockedFunction: toOptionalString(row.blocked_function),
      ioWait: toBool(row.io_wait),
      segmentCount: 0,
    };
  });

  // Pick a representative state for the primary task summary — the one that
  // covers the largest fraction of the selected window.
  const dominant = slices.reduce<SliceFinding | null>((best, slice) => {
    if (!best || slice.durationMs > best.durationMs) return slice;
    return best;
  }, null);

  const primary: CriticalPathTaskInfo = {
    utid: toNumber(utid),
    tid: toNullableNumber(threadRow.tid),
    upid: toNullableNumber(threadRow.thread_upid),
    startTs: taskStart,
    dur: taskDur,
    durationMs: nsToMs(taskDur),
    state: dominant?.state ?? null,
    blockedFunction: dominant?.blockedFunction ?? null,
    ioWait: dominant?.ioWait ?? null,
    cpu: dominant?.cpu ?? null,
    threadName: toOptionalString(threadRow.thread_name),
    processName: toOptionalString(threadRow.process_name),
  };

  return {primary, slices};
}

// Shared budget counter — passed by reference so parallel sibling fetches
// at the same recursion level see each other's increments.
interface BudgetRef {
  consumed: number;
}

interface RecursionContext {
  visited: Set<string>;
  depthLimit: number;
  segmentBudget: number;
  budget: BudgetRef;
}

async function fetchCriticalPathStack(
  tp: TraceProcessorService,
  traceId: string,
  utid: number,
  startTs: number,
  dur: number,
  maxRows: number
): Promise<{rows: CriticalPathStackRow[]; raw: number; truncated: boolean}> {
  const rows = await queryRows(
    tp,
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
    FROM _critical_path_stack(${Math.trunc(utid)}, ${Math.trunc(startTs)}, ${Math.trunc(dur)}, 1, 1, 1, 1) AS cr
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE cr.name IS NOT NULL
    ORDER BY cr.ts ASC, cr.stack_depth ASC, cr.utid ASC
    LIMIT ${Math.trunc(maxRows) + 1}
  `
  );
  const truncated = rows.length > maxRows;
  return {
    rows: normalizeStackRows(truncated ? rows.slice(0, maxRows) : rows),
    raw: rows.length,
    truncated,
  };
}

function pickRecursionTargets(
  segments: CriticalPathSegment[],
  ctx: RecursionContext
): CriticalPathSegment[] {
  const candidates = [...segments].sort((a, b) => b.durationMs - a.durationMs);
  const picks: CriticalPathSegment[] = [];
  for (const segment of candidates) {
    if (picks.length >= 3) break;
    if (segment.durationMs < 4) break;
    const key = `${segment.utid}|${segment.startTs}|${segment.dur}`;
    if (ctx.visited.has(key)) continue;
    if (ctx.budget.consumed >= ctx.segmentBudget) break;
    picks.push(segment);
  }
  return picks;
}

async function recurseCriticalPath(
  tp: TraceProcessorService,
  traceId: string,
  task: CriticalPathTaskInfo,
  segments: CriticalPathSegment[],
  ctx: RecursionContext,
  maxRowsPerCall: number
): Promise<void> {
  if (ctx.depthLimit <= 0) return;
  const targets = pickRecursionTargets(segments, ctx);
  // Reserve dedup keys upfront so concurrent siblings don't both walk the same node.
  for (const target of targets) {
    ctx.visited.add(`${target.utid}|${target.startTs}|${target.dur}`);
  }

  // Fetch siblings at this level concurrently — they share `ctx.visited` and
  // `ctx.budget` (BudgetRef) but have no dependency on one another's results.
  const fetched = await Promise.all(
    targets.map((target) =>
      fetchCriticalPathStack(tp, traceId, target.utid, target.startTs, target.dur, maxRowsPerCall).then(
        (stack) => ({target, stack}),
        () => ({target, stack: null})
      )
    )
  );

  const recursionFollowups: Array<Promise<void>> = [];
  for (const {target, stack} of fetched) {
    if (!stack) continue;
    const childTask: CriticalPathTaskInfo = {
      utid: target.utid,
      tid: target.tid ?? null,
      upid: target.upid ?? null,
      startTs: target.startTs,
      dur: target.dur,
      durationMs: target.durationMs,
      state: target.state,
      threadName: target.threadName,
      processName: target.processName,
    };
    const children = mergeAdjacentSegments(buildSegments(stack.rows, childTask));
    if (children.length === 0) continue;

    target.children = children;
    target.recursionDepth = (target.recursionDepth ?? 0) + 1;
    ctx.budget.consumed += children.length;

    if (ctx.budget.consumed < ctx.segmentBudget) {
      const subCtx: RecursionContext = {
        visited: ctx.visited,
        depthLimit: ctx.depthLimit - 1,
        segmentBudget: ctx.segmentBudget,
        budget: ctx.budget,
      };
      recursionFollowups.push(
        recurseCriticalPath(tp, traceId, childTask, children, subCtx, maxRowsPerCall)
      );
    }
  }

  await Promise.all(recursionFollowups);
}

function applySemanticsToSegments(
  segments: CriticalPathSegment[],
  semantics: Map<string, SegmentSemantics>
): void {
  for (const segment of segments) {
    const key = `${segment.utid}|${segment.startTs}|${segment.startTs + segment.dur}`;
    const sem = semantics.get(key);
    if (!sem) continue;
    segment.semantics = sem;
    const semModules = modulesFromSemantics(sem);
    if (semModules.length > 0) {
      // Replace text-based modules with stdlib-derived ones; merge text as
      // a secondary signal.
      segment.modules = Array.from(new Set([...semModules, ...segment.modules]));
    }
    // Push concrete reasons from semantics.
    for (const txn of sem.binderTxns.slice(0, 2)) {
      const label = `binder: ${txn.serverProcess ?? '-'} ${txn.methodName ?? ''}`.trim();
      segment.reasons = Array.from(new Set([...segment.reasons, label])).slice(0, 8);
    }
    for (const mc of sem.monitorContention.slice(0, 2)) {
      const label = `lock: ${mc.shortBlockingMethod ?? '-'}`;
      segment.reasons = Array.from(new Set([...segment.reasons, label])).slice(0, 8);
    }
    if (sem.gcEvents.length > 0) {
      segment.reasons = Array.from(new Set([...segment.reasons, 'GC event in window'])).slice(0, 8);
    }
    if (sem.cpuCompetition.length > 0) {
      segment.reasons = Array.from(new Set([...segment.reasons, `cpu ${sem.cpuCompetition[0].cpu} competition`])).slice(0, 8);
    }
  }
}

export async function analyzeCriticalPath(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions = {}
): Promise<CriticalPathAnalysis> {
  const {primary: task, slices} = await loadTask(traceProcessorService, traceId, options);
  const maxSegments = normalizePositiveInt(options.maxSegments, 160, 20, 1000);
  const recursionDepth = normalizePositiveInt(options.recursionDepth, 2, 0, 2);
  const recursionEnabled = options.recursionEnabled !== false;
  const segmentBudget = normalizePositiveInt(options.segmentBudget, 16, 4, 32);
  const warnings: string[] = [];

  if (task.dur <= 0) {
    throw new Error('Selected task duration must be positive');
  }

  // L1 dispatch: Running state has no wait chain.
  if (task.state === 'Running' || (slices.length === 1 && slices[0].kind === 'running')) {
    return {
      ...buildEmptyAnalysis(task, warnings, 'task_state_running'),
      slices,
    };
  }

  await traceProcessorService.query(
    traceId,
    'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;'
  );

  const stack = await fetchCriticalPathStack(
    traceProcessorService,
    traceId,
    task.utid,
    task.startTs,
    task.dur,
    maxSegments * 20
  );
  if (stack.truncated) {
    warnings.push(`critical path stack 结果较大，已按前 ${maxSegments} 个链路段截断展示。`);
  }

  const segments = mergeAdjacentSegments(buildSegments(stack.rows, task)).slice(0, maxSegments);
  if (segments.length === 0) {
    return {
      ...buildEmptyAnalysis(task, warnings, 'no_critical_path_stack'),
      slices,
    };
  }

  // L2 + L4 run in parallel — neither depends on the other's result. The
  // waker query reads `target.waker_id` from a single thread_state row, while
  // recursion fans out into _critical_path_stack calls on external segments.
  const wakerPromise =
    typeof task.threadStateId === 'number'
      ? resolveDirectWaker(traceProcessorService, traceId, {threadStateId: task.threadStateId})
      : Promise.resolve(null);

  const recursionPromise =
    recursionEnabled && recursionDepth > 0
      ? recurseCriticalPath(
          traceProcessorService,
          traceId,
          task,
          segments,
          {
            visited: new Set([`${task.utid}|${task.startTs}|${task.dur}`]),
            depthLimit: recursionDepth,
            segmentBudget,
            budget: {consumed: segments.length},
          },
          maxSegments * 5
        )
      : Promise.resolve();

  const [wakerResult] = await Promise.all([wakerPromise, recursionPromise]);

  let directWaker: WakerHop | null = null;
  if (wakerResult) {
    directWaker = wakerResult.hop;
    warnings.push(...wakerResult.warnings);
  }

  // L3 — Semantic enrichment for ALL segments (top-level + recursed children).
  const flatSegments: CriticalPathSegment[] = [];
  const collectFlat = (list: CriticalPathSegment[]): void => {
    for (const segment of list) {
      flatSegments.push(segment);
      if (segment.children) collectFlat(segment.children);
    }
  };
  collectFlat(segments);

  // Batch the tid/upid lookup into a single SQL query (replaces the previous
  // per-segment N+1 SELECT). All segments needing resolution share one round trip.
  const segmentsNeedingThreadInfo = flatSegments.filter(
    (segment) => segment.tid === null || segment.tid === undefined || segment.upid === null || segment.upid === undefined
  );
  if (segmentsNeedingThreadInfo.length > 0) {
    const utidSet = new Set(segmentsNeedingThreadInfo.map((segment) => segment.utid));
    const utidList = Array.from(utidSet).join(', ');
    try {
      const rows = await queryRows(
        traceProcessorService,
        traceId,
        `SELECT utid, tid, upid FROM thread WHERE utid IN (${utidList})`
      );
      const map = new Map<number, {tid: number | null; upid: number | null}>();
      for (const row of rows) {
        const utid = toNullableNumber(row.utid);
        if (utid === null) continue;
        map.set(utid, {tid: toNullableNumber(row.tid), upid: toNullableNumber(row.upid)});
      }
      for (const segment of segmentsNeedingThreadInfo) {
        const info = map.get(segment.utid);
        if (info) {
          segment.tid = info.tid;
          segment.upid = info.upid;
        } else {
          segment.tid = null;
          segment.upid = null;
        }
      }
    } catch {
      // best-effort: leave tid/upid null and let downstream tolerate it
    }
  }

  const semanticInputs: SemanticSegmentInput[] = flatSegments.map((segment) => ({
    utid: segment.utid,
    tid: segment.tid ?? null,
    upid: segment.upid ?? null,
    startTs: segment.startTs,
    endTs: segment.startTs + segment.dur,
    state: segment.state ?? null,
  }));

  const semantics = await enrichSegmentsWithSemantics(
    traceProcessorService,
    traceId,
    semanticInputs
  );
  applySemanticsToSegments(flatSegments, semantics);

  const blockingMs =
    Math.round(segments.reduce((sum, segment) => sum + segment.durationMs, 0) * 100) / 100;
  const selfMs = Math.max(0, Math.round((task.durationMs - blockingMs) * 100) / 100);
  const moduleBreakdown = buildModuleBreakdown(segments, task.durationMs);
  const anomalies = buildAnomalies(task, segments, moduleBreakdown, blockingMs);
  const recommendations = buildRecommendations(anomalies, moduleBreakdown);

  // L5 — Quantification.
  const quantification = await quantifyCriticalPath(
    traceProcessorService,
    traceId,
    {
      utid: task.utid,
      upid: task.upid ?? null,
      startTs: task.startTs,
      endTs: task.startTs + task.dur,
      durMs: task.durationMs,
    },
    segments.map((segment): QuantifySegmentInput => ({
      segmentKey: `${segment.utid}|${segment.startTs}|${segment.startTs + segment.dur}`,
      durMs: segment.durationMs,
    })),
    flatSegments.map((segment) => segment.semantics).filter((sem): sem is SegmentSemantics => sem !== undefined)
  );
  warnings.push(...quantification.warnings);

  // Per-source status is identical across every segment (set once globally
  // by enrichSegmentsWithSemantics), so a single read suffices.
  const semanticSources: Record<string, SemanticSourceStatus> = {};
  const firstSemantic = semantics.values().next().value;
  if (firstSemantic) {
    for (const [source, status] of Object.entries(firstSemantic.sources)) {
      semanticSources[source] = status;
    }
  }

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
    rawRows: stack.raw,
    truncated: stack.truncated,
    slices,
    directWaker,
    quantification,
    semanticSources,
  };
}
