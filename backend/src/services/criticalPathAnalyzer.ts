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
//   L5 — counterfactual best case + frame impact + hypotheses    (criticalPathQuantify.ts)
//
// Schema is backward-compatible: all old CriticalPathAnalysis top-level fields
// are preserved, with new fields ADDED. Old consumers will keep working.
//
// The engine records stable ids (modules, anomalies, recommendations,
// warnings, reasons) with their parameters. Display text is rendered from
// them by criticalPathLocalization.ts; the engine's own result is rendered in
// zh-CN, and a projection renders any other language from the same ids.

import {enrichSegmentsWithSemantics, segmentKeyOf, type SegmentInput as SemanticSegmentInput} from './criticalPathSemantics';
import {hintText} from './criticalPathText';
import {resolveDirectWaker, type WakerChainResult} from './criticalPathWakerChain';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from './traceProcessorCancellation';
import {quantifyCriticalPath, type QuantifySegmentInput} from './criticalPathQuantify';
import {
  nsToMs,
  assertQuerySucceeded,
  queryRows,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';
import {errorLine, reasonKey, reasonText} from './criticalPathText';
import {renderCriticalPathAnalysis} from './criticalPathLocalization';
import type {
  CriticalPathAnalysis,
  CriticalPathAnomaly,
  CriticalPathAnomalyId,
  CriticalPathEvidence,
  CriticalPathInputErrorCode,
  CriticalPathLongestSegment,
  CriticalPathModuleId,
  CriticalPathModuleStat,
  CriticalPathQuantification,
  CriticalPathLeafWait,
  CriticalPathReason,
  CriticalPathRecommendationId,
  CriticalPathRole,
  CriticalPathRootWait,
  CriticalPathSegment,
  CriticalPathTaskInfo,
  CriticalPathTotalsNs,
  CriticalPathUnavailableReason,
  CriticalPathWarning,
  SegmentSemantics,
  SemanticSourceStatus,
  SliceFinding,
  SliceKind,
  TextParams,
  WaitClass,
  WakeSourceSummary,
  WakerHop,
} from '../types/criticalPathContract';

/**
 * Version of what the engine's numbers mean. Evidence captures fingerprint
 * their field semantics with it: bump it when a captured field changes meaning
 * or exactness, so claims verified against the old definition do not carry over.
 */
export const CRITICAL_PATH_ENGINE_VERSION = 'critical-path-engine@4';

export interface CriticalPathProfile {
  /** Segments of the chain displayed (and recursed into); totals always cover the whole chain. */
  maxSegments: number;
  /** Levels of L4 recursion into the longest segments of other threads. */
  recursionDepth: number;
  /** Most child segments all recursion levels together may add. */
  segmentBudget: number;
}

/**
 * The engine's own defaults, per caller. `ui` is the interactive drawer (and
 * any caller that passes nothing); `agent` is the `analyze_wait_chain` tool.
 *
 * Agent recursion depth, measured on 48 of the longest main-thread waits of
 * four canonical traces (2026-09-23): depth 1 and depth 2 took the same time
 * (e.g. 1044-1193 ms vs 1061-1193 ms on lacunh_heavy, 742-787 ms vs 737-799 ms
 * on the customer scroll trace) because recursion expanded nothing at either
 * depth; each recursion level costs 40-150 ms of empty `_critical_path_stack`
 * calls (depth 0 vs 1). Depth 1 keeps the capability at the lower cost.
 * The agent displays 200 segments, as the tool always has.
 */
export const CRITICAL_PATH_DEFAULTS = {
  ui: {maxSegments: 160, recursionDepth: 2, segmentBudget: 16},
  agent: {maxSegments: 200, recursionDepth: 1, segmentBudget: 16},
} as const satisfies Record<'ui' | 'agent', CriticalPathProfile>;

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
  /**
   * Most critical-path stack segments (before adjacent rows of one thread are
   * merged) read for the whole chain that totals, breakdown and anomalies use.
   * Beyond it the analysis is marked truncated and says so.
   */
  maxChainSegments?: number;
  /** Cancels every query the analysis issues; checked between stages too. */
  signal?: AbortSignal;
}

/** A caller-input failure; callers map `code` to a 4xx response. */
export class CriticalPathInputError extends Error {
  readonly code: CriticalPathInputErrorCode;

  constructor(code: CriticalPathInputErrorCode, message: string) {
    super(message);
    this.name = 'CriticalPathInputError';
    this.code = code;
  }
}

// The result types live in types/criticalPathContract.ts (additive only:
// consumers of the legacy fields keep working).

// === Helpers ===

interface CriticalPathStackRow {
  id: number | null;
  ts: number;
  dur: number;
  utid: number;
  tid: number | null;
  upid: number | null;
  name: string;
  tableName?: string | null;
  threadName?: string | null;
  processName?: string | null;
}

interface SegmentAccumulator {
  startTs: number;
  dur: number;
  utid: number;
  tid: number | null;
  upid: number | null;
  threadStateId?: number | null;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: Set<string>;
  reasons: Map<string, CriticalPathReason>;
}

function normalizeIntegerSql(
  value: unknown,
  fieldName: string,
  code: CriticalPathInputErrorCode = 'invalid_integer'
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new CriticalPathInputError(code, `${fieldName} must be an integer`);
  }
  return raw;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/** `value` as a percentage of `total`, to two decimals. */
export function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value * 10_000) / total) / 100;
}

/**
 * The one reading of a thread_state state the engine and its consumers share.
 * `I` (TASK_IDLE: a kernel thread parked until there is work) is a sleep: it
 * ends on an event, not on a device, and is not load.
 */
export function classifySlice(state: string | null | undefined): SliceKind {
  if (!state) return 'unknown';
  if (state === 'Running') return 'running';
  const first = state[0];
  if (first === 'S' || first === 'I') return 'sleeping';
  if (first === 'D') return 'uninterruptible';
  if (first === 'R') return 'runnable';
  return 'unknown';
}

const PATH_ROLE_BY_KIND: Record<SliceKind, CriticalPathRole> = {
  running: 'work',
  runnable: 'runnable',
  uninterruptible: 'device_wait',
  sleeping: 'event_wait',
  unknown: 'other',
};

/** What a chain segment in `state` means for the task (see `CriticalPathRole`). */
export function pathRoleOf(state: string | null | undefined): CriticalPathRole {
  return PATH_ROLE_BY_KIND[classifySlice(state)];
}

/** The roles whose time another thread's execution or device wait accounts for. */
export function isAttributableRole(role: CriticalPathRole | undefined): boolean {
  return role === 'work' || role === 'runnable' || role === 'device_wait';
}

/** The S/I/D roles: a wait that ends the chain (`chainWait`). */
export function isChainLeafRole(role: CriticalPathRole | undefined): boolean {
  return role === 'event_wait' || role === 'device_wait';
}

/** A segment's role, read from its state when the segment carries none. */
export function segmentPathRole(segment: Pick<CriticalPathSegment, 'pathRole' | 'state'>): CriticalPathRole {
  return segment.pathRole ?? pathRoleOf(segment.state);
}

/** The non-empty strings among `items`. */
function present(items: Array<string | null | undefined>): string[] {
  return items.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function stripPrefix(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const stripped = value.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : null;
}

// Keyword fallback: applies only while a segment has no stdlib signal —
// applySemanticsToSegments replaces these labels when L3 finds one.
// Wait-type classes (locks, IO, scheduling) read only wait evidence (state,
// blocked_function, slices, reasons) on word boundaries: a thread or process
// name ("RenderThread", "pool-1-thread-1") says what a thread is, not what it
// waited on. Role classes may also read names. Order is priority: the first
// label is the segment's primary module.
const TEXT_MODULES: Array<{id: CriticalPathModuleId; waitOnly: boolean; pattern: RegExp}> = [
  {id: 'binder_ipc', waitOnly: false, pattern: /\bbinder|hwbinder|ipc(threadstate|transaction)|transact/},
  {
    id: 'lock_futex',
    waitOnly: true,
    pattern: /\b_*(?:futex|rt_mutex|mutex|rwsem|percpu_rwsem)\w*|\bsem_wait\b|\bmonitor\b|\block\b|\bcontention\b|\bcondition\b/,
  },
  {
    id: 'io_candidate',
    waitOnly: true,
    pattern:
      /\bio_wait\b|\bi\/o\b|\bfsync\b|\bfdatasync\b|\bread\b|\bwrite\b|\bpread64\b|\bpwrite64\b|\bsqlite\w*|\bwal\b|\bjournal\b|\b_*(?:io_schedule|wait_on_page|folio_wait|wait_on_buffer|submit_bio|filemap|do_page_fault|page_fault|ext4|f2fs|erofs|jbd2|blk|mmc|ufshcd)\w*/,
  },
  {id: 'sched_cpu', waitOnly: true, pattern: /\brunnable\b|\bpreempt\w*/},
  {
    id: 'graphics_surface',
    waitOnly: false,
    pattern: /renderthread|surfaceflinger|blast|bufferqueue|queuebuffer|dequeuebuffer|doframe|drawframe|traversal|hwui|skia|egl|vulkan|opengl/,
  },
  {id: 'input', waitOnly: false, pattern: /inputdispatcher|inputreader|motionevent|touch|gesture/},
  {id: 'art_gc', waitOnly: false, pattern: /\bgc\b|garbage|art::|dalvik|jit|dex2oat/},
  {id: 'kernel_irq', waitOnly: false, pattern: /\birq\/|kworker|softirq|workqueue|rcu|kernel|interrupt/},
  {id: 'power_wakeup', waitOnly: false, pattern: /wakeup|wakelock|suspend|cpuidle|power/},
];

function classifyModulesFromText(waitTexts: string[], roleTexts: string[]): CriticalPathModuleId[] {
  const waitJoined = waitTexts.join('\n').toLowerCase();
  const allJoined = [...waitTexts, ...roleTexts].join('\n').toLowerCase();
  return TEXT_MODULES.filter(({waitOnly, pattern}) => pattern.test(waitOnly ? waitJoined : allJoined)).map(
    ({id}) => id
  );
}

/** Attributable ms of each stdlib signal on one segment, capped at the segment's duration. */
interface SegmentSignalMs {
  binder: number;
  monitor: number;
  io: number;
  gc: number;
  cpu: number;
}

function segmentSignalMs(segment: CriticalPathSegment): SegmentSignalMs {
  const sem = segment.semantics;
  const sum = <T>(items: T[] | undefined, durMs: (item: T) => number): number =>
    Math.min(segment.durationMs, (items ?? []).reduce((total, item) => total + durMs(item), 0));
  return {
    binder: sum(sem?.binderTxns, (txn) => txn.durMs),
    monitor: sum(sem?.monitorContention, (mc) => mc.durMs),
    io: sum(sem?.ioSignals, (io) => io.durMs),
    gc: sum(sem?.gcEvents, (gc) => gc.durMs),
    cpu: sum(sem?.cpuCompetition, (cpu) => cpu.competingDurMs),
  };
}

// Stdlib-derived modules, longest attributable signal first so the first
// label is the segment's primary module.
function modulesFromSemantics(segment: CriticalPathSegment): CriticalPathModuleId[] {
  const semantics = segment.semantics;
  if (!semantics) return [];
  const ms = segmentSignalMs(segment);
  const signals: Array<[CriticalPathModuleId, boolean, number]> = [
    ['binder_ipc', semantics.binderTxns.length > 0, ms.binder],
    ['lock_monitor', semantics.monitorContention.length > 0, ms.monitor],
    ['io_filesystem', semantics.ioSignals.length > 0, ms.io],
    ['art_gc', semantics.gcEvents.length > 0, ms.gc],
    ['sched_cpu', semantics.cpuCompetition.length > 0, ms.cpu],
  ];
  // GC is matched per process, so a concurrent background collection can
  // overlap a segment that was really waiting on a lock or a file. Thread-level
  // signals therefore rank ahead of GC; GC leads only when it stands alone.
  const processLevel = (id: CriticalPathModuleId): number => (id === 'art_gc' ? 1 : 0);
  return signals
    .filter(([, isPresent]) => isPresent)
    .sort((a, b) => processLevel(a[0]) - processLevel(b[0]) || b[2] - a[2])
    .map(([id]) => id);
}

// S-state waits carry no blocked_function on Android, so their only kernel
// signal is who woke the thread. These labels are candidates, not timed
// evidence: they follow the ms-ranked signals and never displace a keyword
// label on their own.
function wakeCandidateModules(semantics: SegmentSemantics): CriticalPathModuleId[] {
  const modules: CriticalPathModuleId[] = [];
  if (semantics.wakeSources.some((wake) => wake.waitClass === 'network_receive_candidate')) {
    modules.push('network_receive_candidate');
  }
  if (semantics.wakeSources.some((wake) => wake.waitClass === 'worker_handoff')) {
    modules.push('worker_handoff');
  }
  return modules;
}

function addReason(reasons: Map<string, CriticalPathReason>, reason: CriticalPathReason): void {
  reasons.set(reasonKey(reason), reason);
}

/** Reasons in first-seen order, de-duplicated, at most `limit`. */
function mergeReasons(limit: number, ...lists: CriticalPathReason[][]): CriticalPathReason[] {
  const merged = new Map<string, CriticalPathReason>();
  for (const reason of lists.flat()) merged.set(reasonKey(reason), reason);
  return Array.from(merged.values()).slice(0, limit);
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
      tid: row.tid,
      upid: row.upid,
      processName: row.processName,
      threadName: row.threadName,
      slices: new Set<string>(),
      reasons: new Map<string, CriticalPathReason>(),
    };
    segments.set(key, segment);
  }
  segment.processName ??= row.processName;
  segment.threadName ??= row.threadName;
  return segment;
}

// The stack query already drops the root thread's own rows, so every row
// here describes an external segment.
function normalizeStackRows(rows: QueryRow[]): CriticalPathStackRow[] {
  return rows
    .map((row) => ({
      id: toNullableNumber(row.id),
      ts: toNumber(row.ts),
      dur: toNumber(row.dur),
      utid: toNumber(row.utid),
      tid: toNullableNumber(row.tid),
      upid: toNullableNumber(row.upid),
      name: String(row.name ?? ''),
      tableName: toOptionalString(row.table_name),
      threadName: toOptionalString(row.thread_name),
      processName: toOptionalString(row.process_name),
    }))
    .filter((row) => row.dur > 0 && row.name.length > 0);
}

function buildSegments(
  rows: CriticalPathStackRow[],
  task: ChainWindow
): CriticalPathSegment[] {
  const segments = new Map<string, SegmentAccumulator>();

  for (const row of rows) {
    const segment = getSegment(segments, row);
    const name = row.name;

    const state = stripPrefix(name, 'blocking thread_state:');
    if (state) {
      segment.state = state;
      segment.threadStateId ??= row.id;
      addReason(segment.reasons, {kind: 'state', state});
    }

    const processName = stripPrefix(name, 'blocking process_name:');
    if (processName) segment.processName = processName;

    const threadName = stripPrefix(name, 'blocking thread_name:');
    if (threadName) segment.threadName = threadName;

    const kernelFunction = stripPrefix(name, 'blocking kernel_function:');
    if (kernelFunction) {
      segment.blockedFunction = kernelFunction;
      addReason(segment.reasons, {kind: 'kernel_function', name: kernelFunction});
    }

    const ioWait = stripPrefix(name, 'blocking io_wait:');
    if (ioWait) {
      segment.ioWait = ioWait === '1' || ioWait.toLowerCase() === 'true';
      if (segment.ioWait) addReason(segment.reasons, {kind: 'io_wait'});
    }

    const cpu = stripPrefix(name, 'cpu:');
    if (cpu) {
      segment.cpu = toNullableNumber(cpu);
      addReason(segment.reasons, {kind: 'cpu', cpu: segment.cpu});
    }

    if (row.tableName === 'slice' && !name.startsWith('blocking ') && name !== task.threadName) {
      segment.slices.add(name);
      addReason(segment.reasons, {kind: 'slice', name});
    }
  }

  return Array.from(segments.values())
    .map((segment) => {
      const reasonItems = Array.from(segment.reasons.values()).slice(0, 8);
      // The matcher reads reasons in the engine's neutral (English) spelling.
      const waitTexts = present([
        segment.state,
        segment.blockedFunction,
        ...Array.from(segment.slices).slice(0, 6),
        ...reasonItems.slice(0, 6).map((reason) => reasonText(reason, 'en')),
      ]);
      const roleTexts = present([segment.processName, segment.threadName]);
      return {
        startTs: segment.startTs,
        dur: segment.dur,
        startOffsetMs: nsToMs(segment.startTs - task.startTs),
        durationMs: nsToMs(segment.dur),
        utid: segment.utid,
        tid: segment.tid,
        upid: segment.upid,
        threadStateId: segment.threadStateId ?? null,
        processName: segment.processName,
        threadName: segment.threadName,
        state: segment.state,
        blockedFunction: segment.blockedFunction,
        ioWait: segment.ioWait,
        cpu: segment.cpu,
        slices: Array.from(segment.slices).slice(0, 8),
        // Text-based fallback; applySemanticsToSegments() replaces it when L3
        // finds a stdlib signal for this segment.
        moduleIds: classifyModulesFromText(waitTexts, roleTexts),
        modules: [],
        reasonItems,
        reasons: [],
        pathRole: pathRoleOf(segment.state),
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
    previous.moduleIds = Array.from(new Set([...previous.moduleIds, ...segment.moduleIds]));
    previous.reasonItems = mergeReasons(8, previous.reasonItems, segment.reasonItems);
  }
  return merged;
}

function buildModuleBreakdown(
  segments: CriticalPathSegment[],
  taskDurNs: number
): CriticalPathModuleStat[] {
  const stats = new Map<
    CriticalPathModuleId,
    {durNs: number; segmentCount: number; examples: Set<string>}
  >();
  // Each segment counts once, under its primary module, so shares of the
  // non-overlapping top-level chain sum to at most 100%. Durations are summed
  // in ns and converted once: summing rounded ms can overshoot the task.
  for (const segment of segments) {
    const moduleId = segment.moduleIds[0] ?? 'unclassified';
    const current =
      stats.get(moduleId) ?? {durNs: 0, segmentCount: 0, examples: new Set<string>()};
    current.durNs += segment.dur;
    current.segmentCount += 1;
    const example = segmentExample(segment);
    if (example) current.examples.add(example);
    stats.set(moduleId, current);
  }

  return Array.from(stats.entries())
    .map(([moduleId, value]) => ({
      moduleId,
      module: '',
      durationMs: nsToMs(value.durNs),
      percentage: pct(value.durNs, taskDurNs),
      segmentCount: value.segmentCount,
      examples: Array.from(value.examples).slice(0, 3),
    }))
    .sort((a, b) => b.durationMs - a.durationMs || a.moduleId.localeCompare(b.moduleId));
}

/** The longest segment of the chain (the earliest wins a tie). */
function longestSegment(segments: CriticalPathSegment[]): CriticalPathSegment | undefined {
  return segments.reduce<CriticalPathSegment | undefined>(
    (best, segment) => (!best || segment.durationMs > best.durationMs ? segment : best),
    undefined
  );
}

function segmentExample(segment: CriticalPathSegment): string {
  return present([segment.processName, segment.threadName, segment.blockedFunction ?? segment.slices[0]]).join(' / ');
}

// Signals below this many attributable ms raise neither an anomaly nor a
// recommendation.
const MIN_SIGNAL_MS = 2;

interface ChainSignal {
  ms: number;
  evidence: string[];
}

/**
 * Typed L3 evidence summed over the top-level chain. Anomalies and
 * recommendations read these sums, never module labels, so a keyword label
 * cannot raise a finding on its own.
 */
interface ChainSignals {
  binder: ChainSignal;
  monitor: ChainSignal;
  gc: ChainSignal;
  cpu: ChainSignal;
  /** First segment with an io_wait flag or an IO signal. */
  ioSegment: CriticalPathSegment | undefined;
  /**
   * The longest segment of each reported wake-source class, in report order.
   * The longest, not the first: a 0.4 ms hand-off ahead of a 30 ms receive
   * candidate would otherwise hide the segment worth looking at.
   */
  wakeSegments: Array<[ReportedWaitClass, CriticalPathSegment]>;
}

const REPORTED_WAIT_CLASSES = ['network_receive_candidate', 'worker_handoff'] as const;
type ReportedWaitClass = (typeof REPORTED_WAIT_CLASSES)[number];

/** One evidence label and the ms that rank it. */
interface WeightedEvidence {
  label: string;
  ms: number;
}

function collectChainSignals(segments: CriticalPathSegment[]): ChainSignals {
  const sums = segments.map(segmentSignalMs);
  // `evidenceOf` lists a segment's evidence; the three heaviest distinct
  // labels across the chain are kept.
  const signal = (
    key: keyof SegmentSignalMs,
    evidenceOf: (segment: CriticalPathSegment, ms: number) => WeightedEvidence[]
  ): ChainSignal => {
    const evidence = segments
      .flatMap((segment, index) => evidenceOf(segment, sums[index][key]))
      .sort((a, b) => b.ms - a.ms);
    return {
      ms: Math.round(sums.reduce((total, ms) => total + ms[key], 0) * 100) / 100,
      evidence: Array.from(new Set(present(evidence.map(({label}) => label)))).slice(0, 3),
    };
  };
  // A segment that carries the signal is its own evidence.
  const carrier = (segment: CriticalPathSegment, ms: number): WeightedEvidence[] =>
    ms > 0 ? [{label: segmentExample(segment), ms}] : [];
  return {
    binder: signal('binder', carrier),
    monitor: signal('monitor', carrier),
    gc: signal('gc', carrier),
    // Each competitor is evidence, ranked by its own running time.
    cpu: signal('cpu', (segment) =>
      (segment.semantics?.cpuCompetition ?? []).map((competitor) => ({
        label: `CPU ${competitor.cpu}: ${competitor.competingProcess ?? '-'} / ${competitor.competingThread ?? '-'}`,
        ms: competitor.competingDurMs,
      }))
    ),
    ioSegment: segments.find((segment) => segment.ioWait || (segment.semantics?.ioSignals.length ?? 0) > 0),
    wakeSegments: REPORTED_WAIT_CLASSES.flatMap((waitClass): Array<[ReportedWaitClass, CriticalPathSegment]> => {
      const longest = longestSegment(segments.filter((segment) => segment.wakeSourceClass === waitClass));
      return longest ? [[waitClass, longest]] : [];
    }),
  };
}

/** Share of the window attributable time must reach to call other threads the main cost. */
const EXTERNAL_SHARE_HIGH_PERCENT = 70;
/** Share of the window event-wait leaves must reach to say the chain ends in a peer's wait. */
const PEER_EVENT_WAIT_PERCENT = 50;
/** Attributable share below which a wait between slices reads as idle. */
const IDLE_ATTRIBUTABLE_MAX_PERCENT = 20;

/** The whole-chain facts the anomalies read beside the typed L3 signals. */
interface ChainAccounting {
  totals: ChainPathTotals;
  /** The longest attributable segment: what `long_segment` and the counterfactual name. */
  longestAttributable: CriticalPathSegment | undefined;
  /** The longest event-wait leaf. */
  longestLeaf: CriticalPathSegment | undefined;
  rootWait: CriticalPathRootWait | null;
  directWaker: WakerHop | null;
}

/** The threads whose event-wait leaves end the chain, most leaf time first. */
function leafThreadEvidence(segments: readonly CriticalPathSegment[], limit: number): CriticalPathEvidence[] {
  const byUtid = new Map<number, {ns: number; longest: CriticalPathSegment}>();
  for (const segment of segments) {
    if (segmentPathRole(segment) !== 'event_wait') continue;
    const entry = byUtid.get(segment.utid);
    if (!entry) {
      byUtid.set(segment.utid, {ns: segment.dur, longest: segment});
      continue;
    }
    entry.ns += segment.dur;
    if (segment.dur > entry.longest.dur) entry.longest = segment;
  }
  return [...byUtid.values()]
    .sort((a, b) => b.ns - a.ns || a.longest.utid - b.longest.utid)
    .slice(0, limit)
    .map(({ns, longest}): CriticalPathEvidence => ({
      kind: 'leaf_wait',
      process: longest.processName ?? null,
      thread: longest.threadName ?? null,
      ms: nsToMs(ns),
      waitClass: longest.wakeSourceClass ?? null,
    }));
}

function buildAnomalies(
  task: CriticalPathTaskInfo,
  chain: readonly CriticalPathSegment[],
  accounting: ChainAccounting,
  signals: ChainSignals
): CriticalPathAnomaly[] {
  const anomalies: CriticalPathAnomaly[] = [];
  const add = (
    id: CriticalPathAnomalyId,
    severity: CriticalPathAnomaly['severity'],
    params: TextParams | undefined,
    evidenceItems: CriticalPathEvidence[]
  ): void => {
    anomalies.push({id, severity, ...(params ? {params} : {}), title: '', detail: '', evidenceItems, evidence: []});
  };
  const text = (items: string[]): CriticalPathEvidence[] => items.map((item) => ({kind: 'text', text: item}));
  const totalMs = task.durationMs;
  const {totals, longestAttributable: longest, longestLeaf, rootWait, directWaker} = accounting;
  const attributableMs = nsToMs(totals.attributable);
  const attributablePct = pct(totals.attributable, task.dur);
  const eventWaitPct = pct(totals.eventWait, task.dur);

  // Idle is claimed only from where the thread's own wait sat — between its
  // slices — and only when little of the window is attributable. A chain that
  // merely ends in event waits is not idle: the peer that sleeps may hold the
  // lock the task waits for.
  const idle = rootWait?.context === 'between_slices' && attributablePct < IDLE_ATTRIBUTABLE_MAX_PERCENT;
  if (idle && rootWait) {
    add('idle_wait', 'info', {
      state: rootWait.state ?? '-',
      ms: rootWait.durationMs,
      percent: attributablePct,
      waker: directWaker?.kind ?? 'unknown',
      wakerThread: directWaker?.threadName ?? '-',
    }, [
      {kind: 'root_wait', state: rootWait.state, ms: rootWait.durationMs},
      {kind: 'attributable_path', ms: attributableMs},
    ]);
  } else if (totalMs >= 50) {
    // An idle wait is long by nature; its length says nothing about jank, so
    // the duration findings apply only to a wait that is not idle.
    add('task_too_long', 'critical', {ms: totalMs}, [
      {kind: 'task', process: task.processName ?? null, thread: task.threadName ?? null},
      {kind: 'state', state: task.state ?? null},
    ]);
  } else if (totalMs >= 16.67) {
    add('task_over_frame_budget', 'warning', {ms: totalMs}, [{kind: 'state', state: task.state ?? null}]);
  }

  if (attributablePct >= EXTERNAL_SHARE_HIGH_PERCENT && attributableMs >= 8) {
    add('external_share_high', 'warning', {ms: attributableMs, percent: attributablePct}, longest
      ? [{kind: 'longest_segment', process: longest.processName ?? null, thread: longest.threadName ?? null, ms: longest.durationMs}]
      : []);
  }

  // The chain ends in a peer that slept until an external event while the
  // task was inside traced work (or the trace cannot tell): what that peer
  // waited for — network, timer, device — is the blocker to report.
  if (!idle && longestLeaf && rootWait?.context !== 'between_slices' && eventWaitPct >= PEER_EVENT_WAIT_PERCENT) {
    add('peer_event_wait', 'warning', {
      ms: nsToMs(totals.eventWait),
      percent: eventWaitPct,
      process: longestLeaf.processName ?? '-',
      thread: longestLeaf.threadName ?? '-',
      leafMs: longestLeaf.durationMs,
      waitClass: longestLeaf.wakeSourceClass ?? 'unknown',
    }, leafThreadEvidence(chain, 3));
  }

  if (longest && longest.durationMs >= 8) {
    add(
      'long_segment',
      longest.durationMs >= 16.67 ? 'warning' : 'info',
      {process: longest.processName ?? '-', thread: longest.threadName ?? '-', ms: longest.durationMs},
      [
        ...longest.moduleIds.map((id): CriticalPathEvidence => ({kind: 'module', id})),
        ...longest.reasonItems.map((reason): CriticalPathEvidence => ({kind: 'reason', reason})),
      ].slice(0, 5)
    );
  }

  const ioSegment = signals.ioSegment;
  if (ioSegment) {
    add('io_candidate', 'warning', undefined, [
      ...text(present([
        ioSegment.blockedFunction ?? ioSegment.semantics?.ioSignals[0]?.blockedFunction,
        ...ioSegment.slices,
      ])),
      {kind: 'duration', ms: ioSegment.durationMs},
    ]);
  }

  // S-state waits have no blocked_function on Android, so the IO check above
  // cannot see them at all. This is their counterpart: it reports what woke the
  // thread and says plainly that the wake source alone cannot name the cause.
  // One finding per wait class, each naming its own longest segment.
  for (const [waitClass, wakeSegment] of signals.wakeSegments) {
    add(waitClass === 'network_receive_candidate' ? 'network_receive_wait' : 'worker_handoff_wait', 'info', undefined, [
      {kind: 'text', text: `${wakeSegment.processName ?? '-'} / ${wakeSegment.threadName ?? '-'}`},
      {kind: 'duration', ms: wakeSegment.durationMs},
    ]);
  }

  if (signals.binder.ms >= MIN_SIGNAL_MS) {
    add('binder_ipc', signals.binder.ms >= 8 ? 'warning' : 'info', {ms: signals.binder.ms}, text(signals.binder.evidence));
  }
  if (signals.monitor.ms >= MIN_SIGNAL_MS) {
    add('java_monitor', signals.monitor.ms >= 8 ? 'warning' : 'info', {ms: signals.monitor.ms}, text(signals.monitor.evidence));
  }
  if (signals.gc.ms >= MIN_SIGNAL_MS) {
    add('gc_overlap', signals.gc.ms >= 8 ? 'warning' : 'info', {ms: signals.gc.ms}, text(signals.gc.evidence));
  }

  // Only typed competition counts: a Running blocker is the thread doing the
  // work, not evidence that the chain waited for a CPU.
  if (signals.cpu.evidence.length > 0 && attributableMs >= 4) {
    add('cpu_contention', 'info', {ms: signals.cpu.ms}, text(signals.cpu.evidence));
  }

  if (anomalies.length === 0) {
    add('no_clear_anomaly', 'info', undefined, [
      {kind: 'selected_task', ms: totalMs},
      {kind: 'attributable_path', ms: attributableMs},
    ]);
  }

  return anomalies;
}

function buildRecommendations(
  anomalies: CriticalPathAnomaly[],
  moduleBreakdown: CriticalPathModuleStat[],
  signals: ChainSignals
): CriticalPathRecommendationId[] {
  const recommendations: CriticalPathRecommendationId[] = [];
  const modules = new Set(moduleBreakdown.slice(0, 4).map((item) => item.moduleId));

  // Binder / IO / Monitor / GC follow the same typed signals as their
  // anomalies; the remaining classes have no typed source and use the
  // primary-module breakdown.
  if (signals.binder.ms >= MIN_SIGNAL_MS) recommendations.push('follow_binder');
  if (signals.ioSegment) recommendations.push('inspect_io');
  if (signals.monitor.ms >= MIN_SIGNAL_MS || modules.has('lock_futex')) recommendations.push('inspect_locks');
  if (modules.has('graphics_surface')) recommendations.push('align_rendering');
  if (modules.has('sched_cpu')) recommendations.push('inspect_scheduling');
  if (signals.gc.ms >= MIN_SIGNAL_MS) recommendations.push('inspect_gc');
  if (anomalies.some((item) => item.id === 'peer_event_wait')) recommendations.push('follow_peer_event_wait');
  if (anomalies.some((item) => item.id === 'idle_wait')) recommendations.push('choose_active_window');

  if (recommendations.length === 0 || anomalies.some((item) => item.severity !== 'info')) {
    recommendations.push('start_longest_segment');
  }

  return Array.from(new Set(recommendations)).slice(0, 6);
}

const EMPTY_ANALYSIS_RECOMMENDATION: Record<CriticalPathUnavailableReason, CriticalPathRecommendationId> = {
  task_state_running: 'running_selection',
  no_waiting_time: 'no_waiting_selection',
  no_critical_path_stack: 'record_sched_events',
  no_thread_state_in_window: 'choose_thread_with_sched_data',
  wait_open_at_trace_end: 'inspect_unfinished_wait',
};

/** The thread's own S/I/D time in the window, exact (slices are clipped to it). */
function sliceWaitNs(slices: readonly SliceFinding[]): number {
  return slices
    .filter((slice) => slice.kind === 'sleeping' || slice.kind === 'uninterruptible')
    .reduce((sum, slice) => sum + Math.max(0, slice.endTs - slice.startTs), 0);
}

function buildEmptyAnalysis(
  task: CriticalPathTaskInfo,
  warnings: CriticalPathWarning[],
  reason: CriticalPathUnavailableReason,
  slices: SliceFinding[]
): CriticalPathAnalysis {
  return {
    available: false,
    task,
    totalMs: task.durationMs,
    blockingMs: 0,
    selfMs: task.durationMs,
    externalBlockingPercentage: 0,
    wakeupChain: [],
    moduleBreakdown: [],
    anomalies: [{
      id: reason,
      severity: 'info',
      title: '',
      detail: '',
      evidenceItems: [{kind: 'task_duration', ms: task.durationMs}, {kind: 'utid', utid: task.utid}],
      evidence: [],
    }],
    summary: '',
    recommendationIds: [EMPTY_ANALYSIS_RECOMMENDATION[reason]],
    recommendations: [],
    warningCodes: uniqueWarnings(warnings),
    warnings: [],
    rawRows: 0,
    truncated: false,
    longestSegment: null,
    unavailableReason: reason,
    attributableMs: 0,
    attributablePercentage: 0,
    eventWaitMs: 0,
    eventWaitPercentage: 0,
    rootWait: null,
    longestEventWait: null,
    chainSegmentCount: 0,
    chainWaitMs: 0,
    waitClassTotalsMs: {},
    slices,
    totalsNs: totalsNsOf(chainPathTotals([]), sliceWaitNs(slices)),
  };
}

/** Each distinct warning once, in first-seen order. */
function uniqueWarnings(warnings: CriticalPathWarning[]): CriticalPathWarning[] {
  return [...new Map(warnings.map((warning) => [JSON.stringify(warning), warning])).values()];
}

/**
 * The one accounting of a chain, by `CriticalPathRole`: every
 * `CriticalPathTotalsNs` field except the thread's own `waiting`, plus
 * `chainWait` split by wake-source class (`unknown` when a wait has none).
 */
type ChainPathTotals = Omit<CriticalPathTotalsNs, 'waiting'> & {waitClassNs: Record<string, number>};

const ROLE_TOTAL_KEY = {
  work: 'work',
  runnable: 'runnable',
  device_wait: 'deviceWait',
  event_wait: 'eventWait',
  other: 'other',
} as const satisfies Record<CriticalPathRole, keyof CriticalPathTotalsNs>;

// Waiting means an S, I or D state (`classifySlice`), the same reading applied
// to `slices`; each wait is credited to its wake-source class or to `unknown`.
// The engine passes the top-level chain only (see `CriticalPathAnalysis`): a
// recursion child covers its parent's wall time and would count it twice.
function chainPathTotals(segments: readonly CriticalPathSegment[]): ChainPathTotals {
  const totals: ChainPathTotals = {
    blocking: 0, chainWait: 0, work: 0, runnable: 0, deviceWait: 0, eventWait: 0, other: 0, attributable: 0,
    waitClassNs: {},
  };
  for (const segment of segments) {
    const role = segmentPathRole(segment);
    totals[ROLE_TOTAL_KEY[role]] += segment.dur;
    totals.blocking += segment.dur;
    if (isAttributableRole(role)) totals.attributable += segment.dur;
    if (isChainLeafRole(role)) {
      totals.chainWait += segment.dur;
      const key = segment.wakeSourceClass ?? 'unknown';
      totals.waitClassNs[key] = (totals.waitClassNs[key] ?? 0) + segment.dur;
    }
  }
  return totals;
}

function nsRecordToMs(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, ns]) => [key, nsToMs(ns)]));
}

/** The chain's S/I/D time by wake-source class, in ms. */
export function waitClassTotalsMs(segments: readonly CriticalPathSegment[]): Record<string, number> {
  return nsRecordToMs(chainPathTotals(segments).waitClassNs);
}

function totalsNsOf({waitClassNs: _waitClassNs, ...chainTotals}: ChainPathTotals, waitingNs: number): CriticalPathTotalsNs {
  return {...chainTotals, waiting: waitingNs};
}

/**
 * The end of a thread_state row. A row whose state never ended before the
 * trace did has `dur = -1`; it is read up to the end of the trace: for an ANR
 * that open wait is the finding, not a malformed row. The one rule every
 * critical-path query reads a row's end by.
 */
export function openRowEndSql(alias: string): string {
  return `CASE WHEN ${alias}.dur < 0 THEN (SELECT end_ts FROM trace_bounds) ELSE ${alias}.ts + ${alias}.dur END`;
}

/** A thread_state row's duration under `openRowEndSql`. */
function openRowDurSql(alias: string): string {
  return `(${openRowEndSql(alias)}) - ${alias}.ts`;
}

interface LoadedTask {
  primary: CriticalPathTaskInfo;
  slices: SliceFinding[];
  /** The longest waiting slice (`longestWaitingSlice`), or null when the slices hold no waiting time. */
  dominantWait: SliceFinding | null;
  /** The wait the analysis explains is still open at the end of the trace. */
  openAtTraceEnd: boolean;
}

// Resolve task metadata + (when applicable) split a range selection into the
// underlying thread_state slices. Returns at least one entry; the first entry
// is the canonical task summary.
async function loadTask(
  tp: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions
): Promise<LoadedTask> {
  const queryOptions = {signal: options.signal};
  const threadStateId = normalizeIntegerSql(
    options.threadStateId,
    'threadStateId',
    'invalid_thread_state_id'
  );
  if (threadStateId?.startsWith('-')) {
    throw new CriticalPathInputError('invalid_thread_state_id', 'threadStateId must be a non-negative integer');
  }
  // `0` is a real row id, so presence is the test, never truthiness.
  if (threadStateId !== undefined) {
    const rows = await queryRows(
      tp,
      traceId,
      `
      SELECT
        target.id AS thread_state_id,
        target.ts,
        ${openRowDurSql('target')} AS dur,
        target.dur < 0 AS open_at_trace_end,
        target.utid,
        target.state,
        target.blocked_function,
        target.io_wait,
        target.cpu,
        thread.tid,
        thread.upid AS thread_upid,
        thread.name AS thread_name,
        process.name AS process_name
      FROM thread_state AS target
      LEFT JOIN thread USING(utid)
      LEFT JOIN process USING(upid)
      WHERE target.id = ${threadStateId}
      LIMIT 1
    `,
      queryOptions
    );
    const row = rows[0];
    if (!row) {
      throw new CriticalPathInputError('thread_state_not_found', `thread_state ${threadStateId} not found`);
    }
    const dur = Math.max(0, toNumber(row.dur));
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
    };
    return {
      primary,
      slices: [slice],
      dominantWait: longestWaitingSlice([slice]),
      openAtTraceEnd: toBool(row.open_at_trace_end) === true,
    };
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
    throw new CriticalPathInputError('missing_selector', 'threadStateId or utid/startTs/dur is required');
  }

  const taskStart = toNumber(startTsRaw);
  const taskDur = toNumber(durRaw);
  const taskEnd = taskStart + taskDur;
  if (taskDur <= 0) {
    throw new CriticalPathInputError('non_positive_duration', 'Selected task duration must be positive');
  }

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
  `,
    queryOptions
  );
  const threadRow = threadRows[0] ?? {};

  // Pull all overlapping thread_state slices to drive multi-slice splitting.
  // Half-open: a row that ends exactly at the window start (or starts exactly
  // at its end) contributes no time and is not part of the selection. A row
  // still open at the end of the trace runs to that end.
  const sliceRows = await queryRows(
    tp,
    traceId,
    `
    SELECT id, ts, dur, open_at_trace_end, state, blocked_function, io_wait, cpu
    FROM (
      SELECT ts_row.id, ts_row.ts, ${openRowDurSql('ts_row')} AS dur, ts_row.dur < 0 AS open_at_trace_end,
        ts_row.state, ts_row.blocked_function, ts_row.io_wait, ts_row.cpu
      FROM thread_state AS ts_row
      WHERE ts_row.utid = ${utid}
        AND ts_row.ts < ${taskEnd}
    )
    WHERE ts + dur > ${taskStart}
    ORDER BY ts ASC
  `,
    queryOptions
  );
  const openIds = new Set(
    sliceRows.filter((row) => toBool(row.open_at_trace_end) === true).map((row) => toNullableNumber(row.id))
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
    };
  });

  // The task summary describes the longest waiting slice: that is what the
  // wait chain explains. A window without waiting time falls back to its
  // longest slice so the unavailable result still names the state it saw.
  const dominantWait = longestWaitingSlice(slices);
  const dominant = dominantWait ?? longestSlice(slices);

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

  return {
    primary,
    slices,
    dominantWait,
    openAtTraceEnd: dominantWait !== null && openIds.has(dominantWait.threadStateId),
  };
}

const WAITING_KINDS: ReadonlySet<SliceKind> = new Set<SliceKind>(['sleeping', 'uninterruptible', 'runnable']);

/** The longest slice `keep` accepts (the earliest wins a tie), or null. */
function longestSlice(
  slices: SliceFinding[],
  keep: (slice: SliceFinding) => boolean = () => true
): SliceFinding | null {
  const length = (slice: SliceFinding): number => slice.endTs - slice.startTs;
  return slices.reduce<SliceFinding | null>(
    (best, slice) => (keep(slice) && (!best || length(slice) > length(best)) ? slice : best),
    null
  );
}

/** The longest S/D/DK/R/R+ slice, or null when the slices hold no waiting time. */
function longestWaitingSlice(slices: SliceFinding[]): SliceFinding | null {
  return longestSlice(slices, (slice) => WAITING_KINDS.has(slice.kind) && slice.endTs > slice.startTs);
}

// L2 — the one waker resolution. Thread-state-id mode resolves the selected
// row; range mode resolves the longest waiting slice. Returns null when there
// is no row to resolve.
async function resolveTaskWaker(
  tp: TraceProcessorService,
  traceId: string,
  task: CriticalPathTaskInfo,
  dominantWait: SliceFinding | null,
  signal: AbortSignal | undefined
): Promise<WakerChainResult | null> {
  if (typeof task.threadStateId === 'number') {
    return resolveDirectWaker(tp, traceId, {threadStateId: task.threadStateId, signal});
  }
  if (dominantWait?.threadStateId === null || dominantWait?.threadStateId === undefined) return null;
  const result = await resolveDirectWaker(tp, traceId, {threadStateId: dominantWait.threadStateId, signal});
  if (result.hop) {
    result.hop.hintCodes.push('range_longest_waiting_slice');
    result.hop.hints.push(hintText('range_longest_waiting_slice', 'zh-CN'));
  }
  return result;
}

interface RecursionContext {
  visited: Set<string>;
  segmentBudget: number;
  // Counts child segments produced by recursion only; the top-level chain is
  // not charged, so a long chain still recurses.
  consumed: number;
  maxSegmentsPerCall: number;
  // The analysis' own warning list; skipped, cut or failed expansions are
  // reported, never silent.
  warnings: CriticalPathWarning[];
  signal: AbortSignal | undefined;
}

/** Slice names kept per segment; the analysis shows at most this many. */
const MAX_SLICES_PER_SEGMENT = 8;

/**
 * Default `maxChainSegments`. Measured on the customer scroll trace: a 3 s main
 * thread window has more than 5000 stack segments (911 once merged) and takes
 * about 0.8 s end to end, most of it in `_critical_path_stack` itself, which
 * does not depend on the cap.
 */
const DEFAULT_MAX_CHAIN_SEGMENTS = 5000;

/** The thread and window a chain is read for. */
export interface ChainWindow {
  utid: number;
  startTs: number;
  dur: number;
  /** The thread's own name; a slice of that name is not reported as a wait. */
  threadName?: string | null;
}

export interface CriticalPathChain {
  /** Merged segments of other threads, in time order. */
  segments: CriticalPathSegment[];
  /** Rows the stack query returned. */
  rawRows: number;
  /** The stack held more than `maxSegments` segments; `segments` is the part before the cut. */
  truncated: boolean;
}

/**
 * L1 alone: the critical-path stack of one thread over one window, turned into
 * merged segments. Everything else the engine reports starts from this chain;
 * a caller that needs only the chain (the teaching flow) reads it here rather
 * than querying `_critical_path_stack` itself.
 */
export async function loadCriticalPathChain(
  tp: TraceProcessorService,
  traceId: string,
  window: ChainWindow,
  options: {maxSegments?: number; signal?: AbortSignal} = {}
): Promise<CriticalPathChain> {
  const {signal} = options;
  assertQuerySucceeded(
    await tp.query(traceId, 'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;', {signal})
  );
  const stack = await fetchCriticalPathStack(
    tp,
    traceId,
    {utid: window.utid, startTs: window.startTs, dur: window.dur},
    options.maxSegments ?? DEFAULT_MAX_CHAIN_SEGMENTS,
    signal
  );
  return {
    segments: mergeAdjacentSegments(buildSegments(stack.rows, window)),
    rawRows: stack.raw,
    truncated: stack.truncated,
  };
}

interface CriticalPathStack {
  rows: CriticalPathStackRow[];
  /** Rows returned by the stack query. */
  raw: number;
  /** More than `maxSegments` distinct segments existed; `rows` holds the first ones. */
  truncated: boolean;
}

/**
 * The external segments of one critical path, trimmed in SQL: rows are ranked
 * per segment (ts, dur, utid), slice rows beyond MAX_SLICES_PER_SEGMENT (the
 * shallowest are kept, as before) are dropped, and only the first
 * `maxSegments + 1` segments are returned. A row budget would instead be spent
 * on slice ancestry: on a real launch trace 4000 rows held only 26 segments.
 */
async function fetchCriticalPathStack(
  tp: TraceProcessorService,
  traceId: string,
  window: {utid: number; startTs: number; dur: number},
  maxSegments: number,
  signal: AbortSignal | undefined
): Promise<CriticalPathStack> {
  const cap = Math.max(1, Math.trunc(maxSegments));
  const rows = await queryRows(
    tp,
    traceId,
    `
    WITH cr AS (
      SELECT id, ts, dur, utid, name, table_name, stack_depth,
        COALESCE(table_name = 'slice' AND name NOT GLOB 'blocking *', 0) AS is_slice
      FROM _critical_path_stack(${Math.trunc(window.utid)}, ${Math.trunc(window.startTs)}, ${Math.trunc(window.dur)}, 1, 1, 0, 1)
      WHERE name IS NOT NULL
        AND utid != root_utid
        AND dur > 0
    ),
    ranked AS (
      SELECT cr.*,
        DENSE_RANK() OVER (ORDER BY ts, dur, utid) AS segment_rank,
        ROW_NUMBER() OVER (PARTITION BY ts, dur, utid, is_slice ORDER BY stack_depth, name) AS kind_rank
      FROM cr
    )
    SELECT
      ranked.id,
      ranked.ts,
      ranked.dur,
      ranked.utid,
      ranked.name,
      ranked.table_name,
      ranked.segment_rank,
      thread.tid,
      thread.upid,
      thread.name AS thread_name,
      process.name AS process_name
    FROM ranked
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE ranked.segment_rank <= ${cap + 1}
      AND (NOT ranked.is_slice OR ranked.kind_rank <= ${MAX_SLICES_PER_SEGMENT})
    ORDER BY ranked.ts ASC, ranked.stack_depth ASC, ranked.utid ASC
  `,
    {signal}
  );
  const normalized = normalizeStackRows(rows);
  // Keep the first `cap` segments in time order. Ranking again here keeps the
  // cut exact even for rows that arrive without `segment_rank`.
  const keys = Array.from(new Set(normalized.map(segmentRowKey)));
  const truncated = keys.length > cap;
  const kept = truncated ? new Set(keys.slice(0, cap)) : undefined;
  return {
    rows: kept ? normalized.filter((row) => kept.has(segmentRowKey(row))) : normalized,
    raw: rows.length,
    truncated,
  };
}

function segmentRowKey(row: {ts: number; dur: number; utid: number}): string {
  return `${row.ts}|${row.dur}|${row.utid}`;
}

function recursionKey(segment: CriticalPathSegment): string {
  return `${segment.utid}|${segment.startTs}|${segment.dur}`;
}

// Only work segments are expanded. A sleeping or uninterruptible segment of
// another thread is a chain leaf — Perfetto ended the chain there because an
// interrupt, the idle task or an io_wait woke it — so its stack is always
// empty (33 of 33 real calls, up to 16 s each); a runnable segment waited for a
// CPU, not for another thread.
function pickRecursionTargets(
  segments: CriticalPathSegment[],
  ctx: RecursionContext
): CriticalPathSegment[] {
  const candidates = segments
    .filter((segment) => segmentPathRole(segment) === 'work')
    .sort((a, b) => b.durationMs - a.durationMs);
  const picks: CriticalPathSegment[] = [];
  for (const segment of candidates) {
    if (picks.length >= 3) break;
    if (segment.durationMs < 4) break;
    if (ctx.visited.has(recursionKey(segment))) continue;
    if (ctx.consumed >= ctx.segmentBudget) {
      ctx.warnings.push({code: 'recursion_budget', params: {budget: ctx.segmentBudget}});
      break;
    }
    picks.push(segment);
  }
  return picks;
}

// L4 — expand the longest external segments level by level: every pick of a
// level is fetched before any child level, so a deep branch cannot spend the
// budget its siblings were picked with. Queries on one processor run one at a
// time anyway, so the expansion is sequential.
async function recurseCriticalPath(
  tp: TraceProcessorService,
  traceId: string,
  segments: CriticalPathSegment[],
  ctx: RecursionContext,
  depthLeft: number
): Promise<void> {
  if (depthLeft <= 0) return;
  const expanded: CriticalPathSegment[] = [];
  for (const target of pickRecursionTargets(segments, ctx)) {
    ctx.visited.add(recursionKey(target));
    throwIfTraceProcessorQueryCancelled(ctx.signal);
    let stack: CriticalPathStack;
    try {
      stack = await fetchCriticalPathStack(
        tp,
        traceId,
        {utid: target.utid, startTs: target.startTs, dur: target.dur},
        ctx.maxSegmentsPerCall,
        ctx.signal
      );
    } catch (error: unknown) {
      rethrowIfTraceProcessorQueryCancelled(error);
      ctx.warnings.push({code: 'recursion_failed', params: {utid: target.utid, message: errorLine(error)}});
      continue;
    }
    if (stack.truncated) {
      ctx.warnings.push({code: 'recursion_cut', params: {utid: target.utid, cap: ctx.maxSegmentsPerCall}});
    }
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
    ctx.consumed += children.length;
    expanded.push(target);
  }

  // The next level checks the budget itself, so an exhausted budget is
  // reported there rather than silently skipped here.
  for (const target of expanded) {
    await recurseCriticalPath(tp, traceId, target.children ?? [], ctx, depthLeft - 1);
  }
}

/** The segment's entity + window, in the shape `segmentKeyOf` and L3 inputs use. */
function segmentWindow(segment: CriticalPathSegment): {utid: number; startTs: number; endTs: number} {
  return {utid: segment.utid, startTs: segment.startTs, endTs: segment.startTs + segment.dur};
}

function applySemanticsToSegments(
  segments: CriticalPathSegment[],
  semantics: Map<string, SegmentSemantics>
): void {
  for (const segment of segments) {
    const sem = semantics.get(segmentKeyOf(segmentWindow(segment)));
    if (!sem) continue;
    segment.semantics = sem;
    const semModules = modulesFromSemantics(segment);
    // A stdlib signal replaces the keyword fallback outright; wake-source
    // candidates only follow whichever labels the segment has.
    segment.moduleIds = Array.from(
      new Set([...(semModules.length > 0 ? semModules : segment.moduleIds), ...wakeCandidateModules(sem)])
    );
    // Concrete reasons from semantics.
    const added: CriticalPathReason[] = [
      ...sem.binderTxns.slice(0, 2).map((txn): CriticalPathReason =>
        ({kind: 'binder', process: txn.serverProcess, method: txn.methodName})),
      ...sem.monitorContention.slice(0, 2).map((mc): CriticalPathReason =>
        ({kind: 'lock', method: mc.shortBlockingMethod})),
      ...(sem.gcEvents.length > 0 ? [{kind: 'gc_in_window'} as const] : []),
      ...(sem.cpuCompetition.length > 0 ? [{kind: 'cpu_competition', cpu: sem.cpuCompetition[0].cpu} as const] : []),
    ];
    // Longest wait decides the segment's label; a segment can contain several
    // short sleeps with different wake sources.
    const dominantWake = sem.wakeSources.reduce<WakeSourceSummary | undefined>(
      (longest, wake) => (longest === undefined || wake.durMs > longest.durMs ? wake : longest),
      undefined
    );
    if (dominantWake) {
      segment.wakeSourceClass = dominantWake.waitClass;
      added.push({kind: 'wake_class', waitClass: dominantWake.waitClass});
    }
    segment.reasonItems = mergeReasons(8, segment.reasonItems, added);
  }
}

/**
 * Where the thread's own wait sat relative to its slices (see
 * `CriticalPathRootWaitContext`), in one query over the thread's tracks.
 * "Between slices" needs slices on both sides: a thread with none on one side
 * (app atrace categories not recorded) cannot tell idleness from work.
 */
async function loadRootWait(
  tp: TraceProcessorService,
  traceId: string,
  utid: number,
  wait: SliceFinding,
  warnings: CriticalPathWarning[],
  signal: AbortSignal | undefined
): Promise<CriticalPathRootWait | null> {
  const waitStart = Math.trunc(wait.startTs);
  let row: QueryRow | undefined;
  try {
    const rows = await queryRows(
      tp,
      traceId,
      `
      WITH own AS (
        SELECT s.ts, s.dur, s.depth, s.name
        FROM slice AS s
        JOIN thread_track AS tt ON s.track_id = tt.id
        WHERE tt.utid = ${Math.trunc(utid)}
      ),
      enclosing AS (
        SELECT name, ts, dur, depth FROM own
        WHERE ts <= ${waitStart} AND (dur < 0 OR ts + dur > ${waitStart})
        ORDER BY depth DESC, ts DESC
        LIMIT 1
      )
      SELECT
        (SELECT name FROM enclosing) AS enclosing_name,
        (SELECT ts FROM enclosing) AS enclosing_ts,
        (SELECT dur FROM enclosing) AS enclosing_dur,
        (SELECT depth FROM enclosing) AS enclosing_depth,
        EXISTS (SELECT 1 FROM own WHERE ts < ${waitStart}) AS has_before,
        EXISTS (SELECT 1 FROM own WHERE ts > ${waitStart}) AS has_after
    `,
      {signal}
    );
    row = rows[0];
  } catch (error: unknown) {
    rethrowIfTraceProcessorQueryCancelled(error);
    warnings.push({code: 'root_wait_query_failed', params: {message: errorLine(error)}});
    return null;
  }
  const enclosingName = row ? toOptionalString(row.enclosing_name) : null;
  const enclosingSlice = row && enclosingName !== null && enclosingName !== undefined
    ? {
        name: enclosingName,
        startTs: toNumber(row.enclosing_ts),
        dur: toNumber(row.enclosing_dur),
        depth: toNumber(row.enclosing_depth),
      }
    : null;
  const context = enclosingSlice
    ? 'in_slice'
    : row && toBool(row.has_before) === true && toBool(row.has_after) === true
      ? 'between_slices'
      : 'no_slice_data';
  return {
    threadStateId: wait.threadStateId,
    state: wait.state,
    startTs: wait.startTs,
    endTs: wait.endTs,
    durationMs: wait.durationMs,
    context,
    enclosingSlice,
  };
}

function leafWaitOf(segment: CriticalPathSegment | undefined): CriticalPathLeafWait | null {
  if (!segment) return null;
  return {
    utid: segment.utid,
    processName: segment.processName ?? null,
    threadName: segment.threadName ?? null,
    state: segment.state ?? null,
    durationMs: segment.durationMs,
    wakeSourceClass: segment.wakeSourceClass ?? null,
  };
}

export async function analyzeCriticalPath(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: CriticalPathAnalyzeOptions = {}
): Promise<CriticalPathAnalysis> {
  const {signal} = options;
  const {primary: task, slices, dominantWait, openAtTraceEnd} = await loadTask(traceProcessorService, traceId, options);
  const defaults = CRITICAL_PATH_DEFAULTS.ui;
  const maxSegments = normalizePositiveInt(options.maxSegments, defaults.maxSegments, 20, 1000);
  const maxChainSegments = normalizePositiveInt(options.maxChainSegments, DEFAULT_MAX_CHAIN_SEGMENTS, maxSegments, 5000);
  const recursionDepth = normalizePositiveInt(options.recursionDepth, defaults.recursionDepth, 0, 2);
  const recursionEnabled = options.recursionEnabled !== false;
  const segmentBudget = normalizePositiveInt(options.segmentBudget, defaults.segmentBudget, 4, 32);
  const warnings: CriticalPathWarning[] = [];
  // The engine's own result is rendered in zh-CN; a projection renders any
  // other language from the same ids.
  const render = (analysis: CriticalPathAnalysis): CriticalPathAnalysis =>
    renderCriticalPathAnalysis(analysis, 'zh-CN');

  if (task.dur <= 0) {
    // A wait that opened exactly at the end of the trace has nothing to read.
    if (openAtTraceEnd) return render(buildEmptyAnalysis(task, warnings, 'wait_open_at_trace_end', slices));
    throw new CriticalPathInputError('non_positive_duration', 'Selected task duration must be positive');
  }
  if (openAtTraceEnd) warnings.push({code: 'wait_open_at_trace_end', params: {ms: task.durationMs}});

  // L1 dispatch on waiting time, not on the longest slice: a window whose
  // longest slice is Running can still spend most of its time waiting.
  if (typeof task.threadStateId === 'number') {
    if (slices.every((slice) => slice.kind === 'running')) {
      return render(buildEmptyAnalysis(task, warnings, 'task_state_running', slices));
    }
  } else if (slices.length === 0) {
    // No scheduling data at all is not idleness: the thread is not in the
    // window, or its sched events were not recorded.
    return render(buildEmptyAnalysis(task, warnings, 'no_thread_state_in_window', slices));
  } else if (dominantWait === null) {
    return render(buildEmptyAnalysis(task, warnings, 'no_waiting_time', slices));
  }

  // L2 — direct waker, resolved before the stack so an empty chain still
  // reports who woke the task.
  throwIfTraceProcessorQueryCancelled(signal);
  const wakerResult = await resolveTaskWaker(traceProcessorService, traceId, task, dominantWait, signal);
  const directWaker = wakerResult?.hop ?? null;
  if (wakerResult) warnings.push(...wakerResult.warnings);

  // The wait the chain explains: the selected row, or the longest waiting
  // slice of the window (the same one L2 resolved the waker for).
  throwIfTraceProcessorQueryCancelled(signal);
  const rootWaitSlice = typeof task.threadStateId === 'number' ? slices[0] : dominantWait;
  const rootWait = rootWaitSlice
    ? await loadRootWait(traceProcessorService, traceId, task.utid, rootWaitSlice, warnings, signal)
    : null;

  throwIfTraceProcessorQueryCancelled(signal);
  const stack = await loadCriticalPathChain(traceProcessorService, traceId, task, {
    maxSegments: maxChainSegments,
    signal,
  });

  // `chain` is the whole merged chain: totals, breakdown, anomalies and the
  // counterfactual are computed on it. `segments` is the displayed prefix.
  const chain = stack.segments;
  const segments = chain.slice(0, maxSegments);
  const truncated = stack.truncated || chain.length > maxSegments;
  if (stack.truncated) {
    warnings.push({code: 'chain_cut', params: {cap: maxChainSegments, merged: chain.length, shown: segments.length}});
  } else if (chain.length > maxSegments) {
    warnings.push({code: 'display_cut', params: {total: chain.length, shown: segments.length}});
  }

  if (segments.length === 0) {
    // A wait still open at the end of the trace has no waker: nothing woke it
    // before the recording stopped, which is itself the finding.
    return render({
      ...buildEmptyAnalysis(task, warnings, openAtTraceEnd ? 'wait_open_at_trace_end' : 'no_critical_path_stack', slices),
      directWaker,
      rootWait,
    });
  }

  // L4 — recursion fans out into _critical_path_stack calls on external segments.
  if (recursionEnabled && recursionDepth > 0) {
    await recurseCriticalPath(
      traceProcessorService,
      traceId,
      segments,
      {
        visited: new Set([`${task.utid}|${task.startTs}|${task.dur}`]),
        segmentBudget,
        consumed: 0,
        maxSegmentsPerCall: maxSegments,
        warnings,
        signal,
      },
      recursionDepth
    );
  }

  // L3 — Semantic enrichment for ALL segments (whole top-level chain +
  // recursed children of the displayed prefix). tid/upid come from the stack
  // query's own thread join.
  // Each segment explains a wait of the thread above it: the task for the
  // top-level chain, the expanded segment's thread for its children.
  const flatSegments: CriticalPathSegment[] = [];
  const semanticInputs: SemanticSegmentInput[] = [];
  const collectFlat = (list: CriticalPathSegment[], waiterUtid: number): void => {
    for (const segment of list) {
      flatSegments.push(segment);
      semanticInputs.push({
        ...segmentWindow(segment),
        tid: segment.tid ?? null,
        upid: segment.upid ?? null,
        state: segment.state ?? null,
        waiterUtid,
      });
      if (segment.children) collectFlat(segment.children, segment.utid);
    }
  };
  collectFlat(chain, task.utid);

  throwIfTraceProcessorQueryCancelled(signal);
  const enrichment = await enrichSegmentsWithSemantics(
    traceProcessorService,
    traceId,
    semanticInputs,
    {signal}
  );
  applySemanticsToSegments(flatSegments, enrichment.segments);
  warnings.push(...enrichment.warnings);

  // Summed in ns and converted once: rounded per-segment ms can overshoot the task.
  const totals = chainPathTotals(chain);
  const blockingNs = totals.blocking;
  const blockingMs = nsToMs(blockingNs);
  const selfNs = Math.max(0, task.dur - blockingNs);
  const selfMs = nsToMs(selfNs);
  const moduleBreakdown = buildModuleBreakdown(chain, task.dur);
  const signals = collectChainSignals(chain);
  // Only attributable time can be saved by making another thread faster; an
  // event-wait leaf is reported beside it, never as the longest cost.
  const attributable = chain.filter((segment) => isAttributableRole(segmentPathRole(segment)));
  const longest = longestSegment(attributable);
  const longestLeaf = longestSegment(chain.filter((segment) => segmentPathRole(segment) === 'event_wait'));
  const anomalies = buildAnomalies(task, chain, {
    totals,
    longestAttributable: longest,
    longestLeaf,
    rootWait,
    directWaker,
  }, signals);

  // L5 — Quantification.
  throwIfTraceProcessorQueryCancelled(signal);
  const quantification = await quantifyCriticalPath(
    traceProcessorService,
    traceId,
    {
      upid: task.upid ?? null,
      startTs: task.startTs,
      endTs: task.startTs + task.dur,
    },
    attributable.map((segment): QuantifySegmentInput => ({
      segmentKey: segmentKeyOf(segmentWindow(segment)),
      durNs: segment.dur,
    })),
    flatSegments.map((segment) => segment.semantics).filter((sem): sem is SegmentSemantics => sem !== undefined),
    signal
  );
  warnings.push(...quantification.warnings);

  return render({
    available: true,
    task,
    totalMs: task.durationMs,
    blockingMs,
    selfMs,
    externalBlockingPercentage: pct(blockingNs, task.dur),
    attributableMs: nsToMs(totals.attributable),
    attributablePercentage: pct(totals.attributable, task.dur),
    eventWaitMs: nsToMs(totals.eventWait),
    eventWaitPercentage: pct(totals.eventWait, task.dur),
    rootWait,
    longestEventWait: leafWaitOf(longestLeaf),
    wakeupChain: segments,
    moduleBreakdown,
    anomalies,
    summary: '',
    recommendationIds: buildRecommendations(anomalies, moduleBreakdown, signals),
    recommendations: [],
    warningCodes: uniqueWarnings(warnings),
    warnings: [],
    rawRows: stack.rawRows,
    truncated,
    longestSegment: longest
      ? {
          processName: longest.processName ?? null,
          threadName: longest.threadName ?? null,
          durationMs: longest.durationMs,
          moduleIds: longest.moduleIds,
        }
      : null,
    slices,
    directWaker,
    quantification,
    semanticSources: enrichment.sources,
    chainSegmentCount: chain.length,
    chainWaitMs: nsToMs(totals.chainWait),
    waitClassTotalsMs: nsRecordToMs(totals.waitClassNs),
    totalsNs: totalsNsOf(totals, sliceWaitNs(slices)),
  });
}
