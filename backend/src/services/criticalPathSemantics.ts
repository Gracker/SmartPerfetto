// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 3 of critical-task analysis: enrich critical-path segments with
// structured events from Perfetto stdlib tables, not with regexes over slice
// names. Inputs on the pinned trace processor: android_binder_txns (both
// sides), android_monitor_contention, android_garbage_collection_events
// (gc_ts / gc_dur), thread_state (io_wait, blocked_function, the waker on the
// wakeup row), and linux.cpu.frequency. There is no stdlib I/O table, so I/O
// attribution reads thread_state; `criticalPathAnalyzer.real.test.ts` runs
// every query here on the pinned binary, so a renamed column fails a gate
// rather than a comment.
//
// The attribution SQL itself lives in backend/skills/fragments/segment_*.sql
// (plus the I/O family, thread-role and sleep wake-source fragments Skills
// share): this module only binds the segment windows, composes the fragments
// and maps rows. Every loader attaches an event to a segment on the half-open
// overlap and reports it clipped to the segment (`durMs`), with the whole event
// as `eventDurMs`.

import {
  queryRows,
  assertQuerySucceeded,
  nsToMs,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import {randomUUID} from 'crypto';
import {errorLine} from './criticalPathText';
import {composeFragmentSql} from './skillEngine/skillFragments';
import {rethrowIfTraceProcessorQueryCancelled} from './traceProcessorCancellation';
import {classifyTraceProcessorSqlError} from './traceProcessorSqlWorker';
import type {TraceProcessorService} from './traceProcessorService';
import type {
  BinderTxnSummary,
  CpuCompetitionSummary,
  CriticalPathWarning,
  GcEventSummary,
  IoSignal,
  MonitorContentionSummary,
  SegmentSemantics,
  SemanticSourceStatus,
  SemanticSources,
  WaitClass,
  WakeSource,
  WakeSourceSummary,
} from '../types/criticalPathContract';

export interface SegmentInput {
  utid: number;
  tid: number | null;
  upid: number | null;
  startTs: number;
  endTs: number;
  state?: string | null;
  /**
   * The thread whose wait this segment explains: the task for a top-level
   * segment, the parent segment's thread for a recursion child. Monitor
   * contention is attached from the owner's side only when its waiter is this
   * thread.
   */
  waiterUtid?: number | null;
}

export interface EnrichSegmentsOptions {
  /** Cancels every loader query. */
  signal?: AbortSignal;
}

export interface SemanticEnrichment {
  segments: Map<string, SegmentSemantics>;
  sources: SemanticSources;
  /** Each loader warning once. */
  warnings: CriticalPathWarning[];
}

interface QueryAttempt<T> {
  status: SemanticSourceStatus;
  rows: T[];
  warning?: CriticalPathWarning;
}

const STDLIB_MODULES = {
  binder: 'android.binder',
  monitor: 'android.monitor_contention',
  gc: 'android.garbage_collection',
  frequency: 'linux.cpu.frequency',
} as const;

/**
 * Rows each loader keeps per segment (longest clipped first), and the most rows
 * one loader returns for the whole chain. A loader that reaches the ceiling
 * keeps its longest rows and says so in a warning; per-segment ranking means a
 * long chain no longer starves its shortest segments of evidence.
 */
const ROWS_PER_SEGMENT = {binder: 8, monitor: 6, io: 4, gc: 3, cpu: 6, wakeSource: 6} as const;
const LOADER_ROW_CEILING = 4000;

function classifyError(error: unknown, module?: string): {status: SemanticSourceStatus; warning: CriticalPathWarning} {
  const message = errorLine(error);
  const kind = classifyTraceProcessorSqlError(message);
  // Only an unknown module means the stdlib lacks it; any other INCLUDE
  // failure (a table or column the module needs) is classified like a query.
  if (module !== undefined && kind === 'unknown_module') {
    return {status: 'stdlib_missing', warning: {code: 'include_failed', params: {module}}};
  }
  if (kind === 'missing_table') {
    return {status: 'stdlib_missing', warning: {code: 'stdlib_table_missing', params: {message}}};
  }
  if (kind === 'missing_column') {
    return {status: 'sql_error', warning: {code: 'schema_mismatch', params: {message}}};
  }
  return {status: 'sql_error', warning: {code: 'query_failed', params: {message}}};
}

type IncludeResult = {ok: true} | {ok: false; status: SemanticSourceStatus; warning: CriticalPathWarning};

async function includeModule(
  tp: TraceProcessorService,
  traceId: string,
  module: string
): Promise<IncludeResult> {
  try {
    assertQuerySucceeded(await tp.query(traceId, `INCLUDE PERFETTO MODULE ${module};`));
    return {ok: true};
  } catch (error: unknown) {
    rethrowIfTraceProcessorQueryCancelled(error);
    return {ok: false, ...classifyError(error, module)};
  }
}

export function segmentKeyOf(segment: {utid: number; startTs: number; endTs: number}): string {
  return `${segment.utid}|${segment.startTs}|${segment.endTs}`;
}

const isSleeping = (segment: SegmentInput): boolean => /^(?:S|I|D|DK)$/.test(segment.state ?? '');
const isRunnable = (segment: SegmentInput): boolean => /^R\+?$/.test(segment.state ?? '');

/**
 * The `segment_windows` input every segment fragment reads. `idx` is the
 * segment's position in `segments`; rows come back with that `segment_idx`.
 * Every value is numeric, so there is no string injection vector; the state is
 * passed as two flags rather than as trace-derived text.
 */
function segmentWindowsCte(segments: SegmentInput[]): string {
  const rows = segments.map((segment, idx) =>
    `(${idx}, ${segment.utid}, ${segment.tid ?? 'NULL'}, ${segment.upid ?? 'NULL'}, ` +
    `${segment.startTs}, ${segment.endTs}, ${isSleeping(segment) ? 1 : 0}, ${isRunnable(segment) ? 1 : 0}, ` +
    `${segment.waiterUtid ?? 'NULL'})`
  );
  return `segment_windows(idx, utid, tid, upid, ts_start, ts_end, sleeping, runnable, waiter_utid) AS (VALUES ${rows.join(', ')})`;
}

interface SegmentWindowsInput {
  /** The `segment_windows` CTE the loaders put first. */
  cte: string;
  /** Removes the table, if one was made; never throws. */
  drop(): Promise<void>;
}

/**
 * The windows as a table private to this enrichment (a unique name, dropped
 * afterwards). Where the processor cannot create one, the loaders fall back to
 * the inline VALUES CTE, which gives the same rows.
 */
async function materializeSegmentWindows(
  tp: TraceProcessorService,
  /** The processor without the analysis' cancellation, for the cleanup. */
  uncancellable: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[],
): Promise<SegmentWindowsInput> {
  const inline = segmentWindowsCte(segments);
  const table = `_smartperfetto_cp_windows_${randomUUID().replace(/-/g, '')}`;
  try {
    assertQuerySucceeded(
      await tp.query(traceId, `CREATE TABLE ${table} AS WITH ${inline} SELECT * FROM segment_windows;`),
    );
  } catch (error: unknown) {
    rethrowIfTraceProcessorQueryCancelled(error);
    return {cte: inline, drop: async () => undefined};
  }
  return {
    cte: `segment_windows AS (SELECT * FROM ${table})`,
    drop: async () => {
      try {
        // The table must go even when the analysis was cancelled.
        await uncancellable.query(traceId, `DROP TABLE IF EXISTS ${table};`);
      } catch {
        // A processor that is gone took the table with it.
      }
    },
  };
}

/** A loader row: the summary plus the `segment_idx` the query attached it to. */
interface Attributed<T> {
  segmentIdx: number;
  summary: T;
}

type LoaderResult<T> = QueryAttempt<Attributed<T>> & {capped?: boolean};

/** A thread_state row still open at trace end has dur -1, so clipped time is floored at 0. */
function clippedMs(value: unknown): number {
  return nsToMs(Math.max(0, toNumber(value)));
}

interface LoaderContext {
  tp: TraceProcessorService;
  traceId: string;
  windows: string;
}

/**
 * Run one composed fragment query: the top `perSegment` rows of each segment,
 * at most LOADER_ROW_CEILING rows in all (longest first).
 */
async function runLoader<T>(
  ctx: LoaderContext,
  input: {fragments: string[]; relation: string; perSegment: number; order: string; numbers?: Record<string, number>},
  mapRow: (row: QueryRow) => T
): Promise<LoaderResult<T>> {
  try {
    const sql = composeFragmentSql({
      leadingCtes: [ctx.windows],
      fragments: input.fragments,
      numbers: input.numbers,
      select: `SELECT * FROM ${input.relation} WHERE segment_rank <= ${input.perSegment} ` +
        `ORDER BY ${input.order} DESC LIMIT ${LOADER_ROW_CEILING + 1}`,
    });
    const rows = await queryRows(ctx.tp, ctx.traceId, sql);
    const capped = rows.length > LOADER_ROW_CEILING;
    const kept = capped ? rows.slice(0, LOADER_ROW_CEILING) : rows;
    if (kept.length === 0) return {status: 'empty', rows: []};
    return {
      status: 'present',
      rows: kept.map((row) => ({segmentIdx: toNumber(row.segment_idx), summary: mapRow(row)})),
      capped,
    };
  } catch (error: unknown) {
    // A cancelled analysis is not a missing table: let it stop the analysis.
    rethrowIfTraceProcessorQueryCancelled(error);
    const {status, warning} = classifyError(error);
    return {status, rows: [], warning};
  }
}

async function loadBinderTxns(ctx: LoaderContext): Promise<LoaderResult<BinderTxnSummary>> {
  const include = await includeModule(ctx.tp, ctx.traceId, STDLIB_MODULES.binder);
  if (!include.ok) return {rows: [], status: include.status, warning: include.warning};
  return runLoader(ctx, {
    fragments: ['segment_binder_txns.sql'],
    relation: 'segment_binder_txns',
    perSegment: ROWS_PER_SEGMENT.binder,
    order: 'dur_ns',
  }, (row) => ({
    binderTxnId: toNullableNumber(row.binder_txn_id),
    binderReplyId: toNullableNumber(row.binder_reply_id),
    side: (toOptionalString(row.side) ?? 'client') as BinderTxnSummary['side'],
    interfaceName: toOptionalString(row.interface),
    methodName: toOptionalString(row.method_name),
    isSync: toBool(row.is_sync),
    isMainThread: toBool(row.is_main_thread),
    clientProcess: toOptionalString(row.client_process),
    clientThread: toOptionalString(row.client_thread),
    serverProcess: toOptionalString(row.server_process),
    serverThread: toOptionalString(row.server_thread),
    clientUtid: toNullableNumber(row.client_utid),
    serverUtid: toNullableNumber(row.server_utid),
    clientTid: toNullableNumber(row.client_tid),
    serverTid: toNullableNumber(row.server_tid),
    durMs: clippedMs(row.dur_ns),
    eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
  }));
}

async function loadMonitorContention(ctx: LoaderContext): Promise<LoaderResult<MonitorContentionSummary>> {
  const include = await includeModule(ctx.tp, ctx.traceId, STDLIB_MODULES.monitor);
  if (!include.ok) return {rows: [], status: include.status, warning: include.warning};
  return runLoader(ctx, {
    fragments: ['segment_monitor_contention.sql'],
    relation: 'segment_monitor_contention',
    perSegment: ROWS_PER_SEGMENT.monitor,
    order: 'dur_ns',
  }, (row) => ({
    rowId: toNumber(row.id),
    side: toOptionalString(row.side) === 'owner' ? 'owner' : 'blocked',
    shortBlockedMethod: toOptionalString(row.short_blocked_method),
    shortBlockingMethod: toOptionalString(row.short_blocking_method),
    blockedThreadName: toOptionalString(row.blocked_thread_name),
    blockingThreadName: toOptionalString(row.blocking_thread_name),
    blockedTid: toNullableNumber(row.blocked_thread_tid),
    blockingTid: toNullableNumber(row.blocking_tid),
    blockedUtid: toNullableNumber(row.blocked_utid),
    blockingUtid: toNullableNumber(row.blocking_utid),
    durMs: clippedMs(row.dur_ns),
    eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
    isBlockedThreadMain: toBool(row.is_blocked_thread_main),
  }));
}

async function loadIoSignals(ctx: LoaderContext): Promise<LoaderResult<IoSignal>> {
  return runLoader(ctx, {
    fragments: ['io_blocked_function_families.sql', 'segment_io_signals.sql'],
    relation: 'segment_io_signals',
    perSegment: ROWS_PER_SEGMENT.io,
    order: 'dur_ns',
  }, (row) => {
    const ioWait = toBool(row.io_wait) === true;
    return {
      source: ioWait ? 'io_wait_flag' : 'blocked_function',
      blockedFunction: toOptionalString(row.blocked_function),
      durMs: clippedMs(row.dur_ns),
      eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
      ioWait,
    };
  });
}

async function loadWakeSources(ctx: LoaderContext, segments: SegmentInput[]): Promise<LoaderResult<WakeSourceSummary>> {
  // Only sleeping segments have a wake source worth attributing; a Runnable or
  // Running segment was never waiting on anybody.
  if (!segments.some(isSleeping)) return {rows: [], status: 'skipped'};
  return runLoader(ctx, {
    fragments: ['thread_role.sql', 'segment_wake_sources.sql', 'sleep_wake_source_labels.sql'],
    relation: 'segment_wake_sources',
    perSegment: ROWS_PER_SEGMENT.wakeSource,
    order: 'dur_ns',
  }, (row) => ({
    state: toOptionalString(row.state),
    durMs: clippedMs(row.dur_ns),
    eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
    threadName: toOptionalString(row.thread_name),
    threadRole: toOptionalString(row.thread_role) ?? 'other',
    wakerThreadName: toOptionalString(row.waker_thread_name),
    wakerProcessName: toOptionalString(row.waker_process_name),
    wakerRole: toOptionalString(row.waker_role) ?? 'unknown',
    irqContext: toBool(row.irq_context) === true,
    wakeSource: (toOptionalString(row.wake_source) ?? 'unknown') as WakeSource,
    waitClass: (toOptionalString(row.wait_class) ?? 'unknown') as WaitClass,
  }));
}

async function loadGcEvents(ctx: LoaderContext): Promise<LoaderResult<GcEventSummary>> {
  const include = await includeModule(ctx.tp, ctx.traceId, STDLIB_MODULES.gc);
  if (!include.ok) return {rows: [], status: include.status, warning: include.warning};
  return runLoader(ctx, {
    fragments: ['segment_gc_events.sql'],
    relation: 'segment_gc_events',
    perSegment: ROWS_PER_SEGMENT.gc,
    order: 'dur_ns',
  }, (row) => ({
    gcType: toOptionalString(row.gc_type),
    isMarkCompact: toBool(row.is_mark_compact),
    reclaimedMb: toNullableNumber(row.reclaimed_mb),
    durMs: clippedMs(row.dur_ns),
    eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
    thread: toOptionalString(row.thread_name),
    process: toOptionalString(row.process_name),
  }));
}

async function loadCpuCompetition(ctx: LoaderContext, segments: SegmentInput[]): Promise<LoaderResult<CpuCompetitionSummary>> {
  // Only meaningful for R/R+ states (waiting for CPU). For S/D the segment
  // wasn't on a CPU, so same-CPU competition is undefined.
  if (!segments.some(isRunnable)) return {rows: [], status: 'skipped'};
  // The frequency is an optional annotation; without the module the
  // competition itself is still attributed.
  const withFrequency = (await includeModule(ctx.tp, ctx.traceId, STDLIB_MODULES.frequency)).ok;
  const relation = withFrequency
    ? `(SELECT c.*, fq.cpu_max_freq FROM segment_cpu_competition AS c
        LEFT JOIN segment_cpu_max_freq AS fq ON fq.segment_idx = c.segment_idx AND fq.cpu = c.cpu)`
    : '(SELECT *, NULL AS cpu_max_freq FROM segment_cpu_competition)';
  return runLoader(ctx, {
    fragments: withFrequency
      ? ['segment_cpu_competition.sql', 'segment_cpu_frequency.sql']
      : ['segment_cpu_competition.sql'],
    relation,
    perSegment: ROWS_PER_SEGMENT.cpu,
    order: 'competing_dur_ns',
  }, (row) => ({
    cpu: toNumber(row.cpu),
    competingTid: toNullableNumber(row.competing_tid),
    competingUtid: toNullableNumber(row.competing_utid),
    competingThread: toOptionalString(row.competing_thread),
    competingProcess: toOptionalString(row.competing_process),
    competingState: toOptionalString(row.competing_state),
    competingDurMs: clippedMs(row.competing_dur_ns),
    eventDurMs: nsToMs(toNumber(row.event_dur_ns)),
    cpuMaxFreqKhz: toNullableNumber(row.cpu_max_freq),
  }));
}

function skippedSources(): SemanticSources {
  return {binder: 'skipped', monitor: 'skipped', io: 'skipped', gc: 'skipped', cpu: 'skipped', wakeSource: 'skipped'};
}

function emptySemantics(segment: SegmentInput, key: string): SegmentSemantics {
  return {
    segmentKey: key,
    utid: segment.utid,
    upid: segment.upid,
    startTs: segment.startTs,
    endTs: segment.endTs,
    binderTxns: [],
    monitorContention: [],
    ioSignals: [],
    gcEvents: [],
    cpuCompetition: [],
    wakeSources: [],
  };
}

/** The same service with `signal` attached to every query. */
function withSignal(tp: TraceProcessorService, signal: AbortSignal | undefined): TraceProcessorService {
  if (!signal) return tp;
  return {
    query: (traceId: string, sql: string, options?: Parameters<TraceProcessorService['query']>[2]) =>
      tp.query(traceId, sql, {...options, signal}),
  } as TraceProcessorService;
}

export async function enrichSegmentsWithSemantics(
  service: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[],
  options: EnrichSegmentsOptions = {}
): Promise<SemanticEnrichment> {
  const tp = withSignal(service, options.signal);
  const result = new Map<string, SegmentSemantics>();

  // Copies of one window would only fetch the same rows twice, so every loader
  // and distribute() share the index space of the unique windows.
  const unique = segments.filter((segment) => {
    const key = segmentKeyOf(segment);
    if (result.has(key)) return false;
    result.set(key, emptySemantics(segment, key));
    return true;
  });

  if (unique.length === 0) {
    return {segments: result, sources: skippedSources(), warnings: []};
  }

  // Queries on one processor run one at a time, so the loaders run in order.
  // The windows (up to thousands of rows) are written to a table once instead
  // of being pasted into all six loader statements.
  const windows = await materializeSegmentWindows(tp, service, traceId, unique);
  let loaded;
  try {
    const ctx: LoaderContext = {tp, traceId, windows: windows.cte};
    loaded = {
      binder: await loadBinderTxns(ctx),
      monitor: await loadMonitorContention(ctx),
      io: await loadIoSignals(ctx),
      gc: await loadGcEvents(ctx),
      cpu: await loadCpuCompetition(ctx, unique),
      wakeSource: await loadWakeSources(ctx, unique),
    };
  } finally {
    await windows.drop();
  }
  const {binder, monitor, io, gc, cpu, wakeSource} = loaded;

  const loaders = {binder, monitor, io, gc, cpu, wakeSource};
  const sources = Object.fromEntries(
    Object.entries(loaders).map(([name, loader]) => [name, loader.status])
  ) as SemanticSources;
  // Each distinct warning once (loaders can fail the same way).
  const warnings = [...new Map([
    ...Object.values(loaders).flatMap((loader) => (loader.warning ? [loader.warning] : [])),
    ...Object.entries(loaders).flatMap(([name, loader]): CriticalPathWarning[] =>
      loader.capped ? [{code: 'loader_row_cap', params: {source: name, cap: LOADER_ROW_CEILING}}] : []),
  ].map((warning) => [JSON.stringify(warning), warning])).values()];

  const distribute = <T>(rows: Attributed<T>[], list: (sem: SegmentSemantics) => T[]): void => {
    for (const {segmentIdx, summary} of rows) {
      const segment = unique[segmentIdx];
      const sem = segment && result.get(segmentKeyOf(segment));
      if (sem) list(sem).push(summary);
    }
  };

  distribute(binder.rows, (sem) => sem.binderTxns);
  distribute(monitor.rows, (sem) => sem.monitorContention);
  distribute(io.rows, (sem) => sem.ioSignals);
  distribute(gc.rows, (sem) => sem.gcEvents);
  distribute(cpu.rows, (sem) => sem.cpuCompetition);
  distribute(wakeSource.rows, (sem) => sem.wakeSources);

  return {segments: result, sources, warnings};
}

// Exported for unit-test reach into otherwise-private helpers.
export const __INTERNAL__ = {
  classifyError,
  segmentKeyOf,
  segmentWindowsCte,
};
