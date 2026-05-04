// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 3 of critical-task analysis: enrich raw thread_state segments with
// structured semantic events from Perfetto stdlib tables (NOT regex on slice
// names — see commit history rationale).
//
// Schema confirmed via backend/test-output/stdlib-schema-probe.json against
// 6 real test traces on perfetto v54:
//   ✅ android_binder_txns   (client_*/server_*, binder_txn_id, is_sync, method_name)
//   ✅ android_monitor_contention (blocked_utid/blocking_utid, ts/dur, short_*_method)
//   ❌ android_io / android_io_long_tasks — DO NOT EXIST in v54
//      → fallback uses thread_state.io_wait + blocked_function text
//   ✅ android_garbage_collection_events (gc_ts / gc_dur / reclaimed_mb — NOT ts/dur/reclaimed_bytes)
//   ❌ cpu_utilization_per_thread — DOES NOT EXIST in v54
//      → R/R+ CPU competition: query same-CPU thread_state directly + cpu_frequency_counters

import {
  nsToMs,
  rowObject,
  toBool,
  toNullableNumber,
  toNumber,
  toOptionalString,
  type QueryRow,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';

export interface SegmentInput {
  utid: number;
  tid: number | null;
  upid: number | null;
  startTs: number;
  endTs: number;
  state?: string | null;
}

export type SemanticSourceStatus =
  | 'present'
  | 'empty'
  | 'stdlib_missing'
  | 'sql_error'
  | 'skipped';

export interface BinderTxnSummary {
  binderTxnId: number | null;
  binderReplyId: number | null;
  side: 'client' | 'server' | 'both';
  interfaceName: string | null;
  methodName: string | null;
  isSync: boolean | null;
  isMainThread: boolean | null;
  clientProcess: string | null;
  clientThread: string | null;
  serverProcess: string | null;
  serverThread: string | null;
  clientUtid: number | null;
  serverUtid: number | null;
  clientTid: number | null;
  serverTid: number | null;
  durMs: number;
}

export interface MonitorContentionSummary {
  rowId: number;
  shortBlockedMethod: string | null;
  shortBlockingMethod: string | null;
  blockedThreadName: string | null;
  blockingThreadName: string | null;
  blockedTid: number | null;
  blockingTid: number | null;
  blockedUtid: number | null;
  blockingUtid: number | null;
  durMs: number;
  isBlockedThreadMain: boolean | null;
}

export interface IoSignal {
  source: 'io_wait_flag' | 'blocked_function';
  blockedFunction: string | null;
  durMs: number;
  ioWait: boolean;
}

export interface GcEventSummary {
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
  thread: string | null;
  process: string | null;
}

export interface CpuCompetitionSummary {
  cpu: number;
  competingTid: number | null;
  competingUtid: number | null;
  competingThread: string | null;
  competingProcess: string | null;
  competingState: string | null; // R / Running / R+
  competingDurMs: number;
  cpuMaxFreqKhz: number | null;
}

export interface SegmentSemantics {
  segmentKey: string;
  binderTxns: BinderTxnSummary[];
  monitorContention: MonitorContentionSummary[];
  ioSignals: IoSignal[];
  gcEvents: GcEventSummary[];
  cpuCompetition: CpuCompetitionSummary[];
  sources: {
    binder: SemanticSourceStatus;
    monitor: SemanticSourceStatus;
    io: SemanticSourceStatus;
    gc: SemanticSourceStatus;
    cpu: SemanticSourceStatus;
  };
  warnings: string[];
}

interface QueryAttempt<T> {
  status: SemanticSourceStatus;
  rows: T[];
  warning?: string;
}

const STDLIB_MODULES = {
  binder: 'android.binder',
  monitor: 'android.monitor_contention',
  gc: 'android.garbage_collection',
  frequency: 'linux.cpu.frequency',
} as const;

function classifyError(error: unknown): {status: SemanticSourceStatus; warning: string} {
  const message = error instanceof Error ? error.message : String(error);
  // Perfetto trace_processor returns "no such table: X" / "no such column: Y"
  if (/no such table/i.test(message)) {
    return {status: 'stdlib_missing', warning: `stdlib table missing: ${message.split('\n')[0]}`};
  }
  if (/no such column|no such function/i.test(message)) {
    return {status: 'sql_error', warning: `schema mismatch: ${message.split('\n')[0]}`};
  }
  return {status: 'sql_error', warning: `query failed: ${message.split('\n')[0]}`};
}

async function tryQuery<T>(
  tp: TraceProcessorService,
  traceId: string,
  sql: string,
  mapRow: (row: QueryRow) => T
): Promise<QueryAttempt<T>> {
  try {
    const result = await tp.query(traceId, sql);
    if (result.rows.length === 0) {
      return {status: 'empty', rows: []};
    }
    const rows = result.rows.map((row) => mapRow(rowObject(result.columns, row)));
    return {status: 'present', rows};
  } catch (error: unknown) {
    const {status, warning} = classifyError(error);
    return {status, rows: [], warning};
  }
}

async function includeModule(
  tp: TraceProcessorService,
  traceId: string,
  module: string
): Promise<{ok: boolean; warning?: string}> {
  try {
    await tp.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
    return {ok: true};
  } catch (error: unknown) {
    const {warning} = classifyError(error);
    return {ok: false, warning: warning ?? `INCLUDE ${module} failed`};
  }
}

function segmentKeyOf(segment: SegmentInput): string {
  return `${segment.utid}|${segment.startTs}|${segment.endTs}`;
}

function buildSegmentValuesCte(segments: SegmentInput[]): string {
  // VALUES (idx, utid, tid_or_null, upid_or_null, ts_start, ts_end)
  // All numeric — no string injection vector.
  return segments
    .map(
      (segment, idx) =>
        `(${idx}, ${segment.utid}, ${segment.tid ?? 'NULL'}, ${segment.upid ?? 'NULL'}, ${segment.startTs}, ${segment.endTs})`
    )
    .join(', ');
}

interface BinderRow {
  segmentIdx: number;
  binderTxnId: number | null;
  binderReplyId: number | null;
  side: 'client' | 'server' | 'both';
  interfaceName: string | null;
  methodName: string | null;
  isSync: boolean | null;
  isMainThread: boolean | null;
  clientProcess: string | null;
  clientThread: string | null;
  serverProcess: string | null;
  serverThread: string | null;
  clientUtid: number | null;
  serverUtid: number | null;
  clientTid: number | null;
  serverTid: number | null;
  durMs: number;
}

async function loadBinderTxns(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: BinderRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.binder);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // NOTE: client_ts/dur OR server_ts/dur — either side overlapping the segment
  // window counts. binder_txn_id may be 0 for some events; we keep it for
  // dedup/cross-reference but do not treat 0 as missing.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      txn.binder_txn_id,
      txn.binder_reply_id,
      CASE
        WHEN txn.client_utid = segs.utid AND txn.server_utid = segs.utid THEN 'both'
        WHEN txn.client_utid = segs.utid THEN 'client'
        WHEN txn.server_utid = segs.utid THEN 'server'
        ELSE 'client'
      END AS side,
      txn.interface,
      txn.method_name,
      txn.is_sync,
      txn.is_main_thread,
      txn.client_process,
      txn.client_thread,
      txn.server_process,
      txn.server_thread,
      txn.client_utid,
      txn.server_utid,
      txn.client_tid,
      txn.server_tid,
      MAX(
        COALESCE(txn.client_dur, 0),
        COALESCE(txn.server_dur, 0)
      ) AS dur_ns
    FROM segs
    JOIN android_binder_txns AS txn ON
      (
        (txn.client_utid = segs.utid
          AND txn.client_ts <= segs.ts_end
          AND txn.client_ts + COALESCE(txn.client_dur, 0) >= segs.ts_start)
        OR
        (txn.server_utid = segs.utid
          AND txn.server_ts <= segs.ts_end
          AND txn.server_ts + COALESCE(txn.server_dur, 0) >= segs.ts_start)
      )
    ORDER BY dur_ns DESC
    LIMIT ${Math.min(segments.length * 8, 200)};
  `;
  const attempt = await tryQuery<BinderRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    binderTxnId: toNullableNumber(row.binder_txn_id),
    binderReplyId: toNullableNumber(row.binder_reply_id),
    side: (toOptionalString(row.side) ?? 'client') as BinderRow['side'],
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
    durMs: nsToMs(toNumber(row.dur_ns)),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface MonitorRow {
  segmentIdx: number;
  rowId: number;
  shortBlockedMethod: string | null;
  shortBlockingMethod: string | null;
  blockedThreadName: string | null;
  blockingThreadName: string | null;
  blockedTid: number | null;
  blockingTid: number | null;
  blockedUtid: number | null;
  blockingUtid: number | null;
  durMs: number;
  isBlockedThreadMain: boolean | null;
}

async function loadMonitorContention(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: MonitorRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.monitor);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // android_monitor_contention.blocked_utid is the thread that's stuck waiting
  // for the lock. We match against the segment's utid.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      mc.id,
      mc.short_blocked_method,
      mc.short_blocking_method,
      mc.blocked_thread_name,
      mc.blocking_thread_name,
      mc.blocked_thread_tid,
      mc.blocking_tid,
      mc.blocked_utid,
      mc.blocking_utid,
      mc.dur,
      mc.is_blocked_thread_main
    FROM segs
    JOIN android_monitor_contention AS mc
      ON mc.blocked_utid = segs.utid
     AND mc.ts <= segs.ts_end
     AND mc.ts + mc.dur >= segs.ts_start
    ORDER BY mc.dur DESC
    LIMIT ${Math.min(segments.length * 6, 120)};
  `;
  const attempt = await tryQuery<MonitorRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    rowId: toNumber(row.id),
    shortBlockedMethod: toOptionalString(row.short_blocked_method),
    shortBlockingMethod: toOptionalString(row.short_blocking_method),
    blockedThreadName: toOptionalString(row.blocked_thread_name),
    blockingThreadName: toOptionalString(row.blocking_thread_name),
    blockedTid: toNullableNumber(row.blocked_thread_tid),
    blockingTid: toNullableNumber(row.blocking_tid),
    blockedUtid: toNullableNumber(row.blocked_utid),
    blockingUtid: toNullableNumber(row.blocking_utid),
    durMs: nsToMs(toNumber(row.dur)),
    isBlockedThreadMain: toBool(row.is_blocked_thread_main),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface IoRow {
  segmentIdx: number;
  blockedFunction: string | null;
  ioWait: boolean;
  durMs: number;
}

async function loadIoSignals(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: IoRow[]; status: SemanticSourceStatus; warning?: string}> {
  // No stdlib io table in v54 — use thread_state.io_wait + blocked_function
  // text patterns (block layer / fs / mmc / ufs) as fallback.
  const cte = buildSegmentValuesCte(segments);
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      ts.blocked_function,
      ts.io_wait,
      ts.dur
    FROM segs
    JOIN thread_state AS ts
      ON ts.utid = segs.utid
     AND ts.ts <= segs.ts_end
     AND ts.ts + ts.dur >= segs.ts_start
    WHERE ts.state = 'D'
      AND (
        ts.io_wait = 1
        OR ts.blocked_function LIKE '%io_schedule%'
        OR ts.blocked_function LIKE '%wait_on_buffer%'
        OR ts.blocked_function LIKE '%submit_bio%'
        OR ts.blocked_function LIKE '%filemap_fault%'
        OR ts.blocked_function LIKE '%ext4_%'
        OR ts.blocked_function LIKE '%f2fs_%'
        OR ts.blocked_function LIKE '%mmc_%'
        OR ts.blocked_function LIKE '%ufshcd_%'
        OR ts.blocked_function LIKE '%blk_mq_%'
      )
    ORDER BY ts.dur DESC
    LIMIT ${Math.min(segments.length * 4, 80)};
  `;
  const attempt = await tryQuery<IoRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    blockedFunction: toOptionalString(row.blocked_function),
    ioWait: toBool(row.io_wait) === true,
    durMs: nsToMs(toNumber(row.dur)),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface GcRow {
  segmentIdx: number;
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
  thread: string | null;
  process: string | null;
}

async function loadGcEvents(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: GcRow[]; status: SemanticSourceStatus; warning?: string}> {
  const include = await includeModule(tp, traceId, STDLIB_MODULES.gc);
  if (!include.ok) {
    return {rows: [], status: 'stdlib_missing', warning: include.warning};
  }
  const cte = buildSegmentValuesCte(segments);
  // gc.upid OR gc.utid overlap. GC blocks the whole process, so a non-task
  // thread's GC can stall the segment indirectly. We match on upid.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte})
    SELECT
      segs.idx AS segment_idx,
      gc.gc_type,
      gc.is_mark_compact,
      gc.reclaimed_mb,
      gc.gc_dur,
      gc.thread_name,
      gc.process_name
    FROM segs
    JOIN android_garbage_collection_events AS gc
      ON segs.upid IS NOT NULL
     AND gc.upid = segs.upid
     AND gc.gc_ts <= segs.ts_end
     AND gc.gc_ts + gc.gc_dur >= segs.ts_start
    ORDER BY gc.gc_dur DESC
    LIMIT ${Math.min(segments.length * 3, 60)};
  `;
  const attempt = await tryQuery<GcRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    gcType: toOptionalString(row.gc_type),
    isMarkCompact: toBool(row.is_mark_compact),
    reclaimedMb: toNullableNumber(row.reclaimed_mb),
    durMs: nsToMs(toNumber(row.gc_dur)),
    thread: toOptionalString(row.thread_name),
    process: toOptionalString(row.process_name),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

interface CpuRow {
  segmentIdx: number;
  cpu: number;
  competingTid: number | null;
  competingUtid: number | null;
  competingThread: string | null;
  competingProcess: string | null;
  competingState: string | null;
  competingDurMs: number;
  cpuMaxFreqKhz: number | null;
}

async function loadCpuCompetition(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<{rows: CpuRow[]; status: SemanticSourceStatus; warning?: string}> {
  // Only meaningful for R/R+ states (waiting for CPU). For S/D the segment
  // wasn't on a CPU, so same-CPU competition is undefined.
  const runnable = segments.filter((s) => /^R\+?$/.test(s.state ?? ''));
  if (runnable.length === 0) {
    return {rows: [], status: 'skipped'};
  }
  const cte = buildSegmentValuesCte(runnable);

  // Prefer freq module if available, but tolerate its absence.
  const includeFreq = await includeModule(tp, traceId, STDLIB_MODULES.frequency);

  // Two-step: 1) find the CPU the runnable thread eventually ran on (or was
  // queued on); 2) list other Running threads on that same CPU during the
  // overlap. We use thread_state.cpu of the matching segment row directly.
  const sql = `
    WITH segs(idx, utid, tid, upid, ts_start, ts_end) AS (VALUES ${cte}),
    target_cpu AS (
      SELECT segs.idx AS segment_idx,
             ts.cpu,
             segs.ts_start,
             segs.ts_end
      FROM segs
      JOIN thread_state AS ts
        ON ts.utid = segs.utid
       AND ts.ts <= segs.ts_end
       AND ts.ts + ts.dur >= segs.ts_start
      WHERE ts.cpu IS NOT NULL
      GROUP BY segs.idx, ts.cpu
    )
    SELECT
      tc.segment_idx,
      tc.cpu,
      thr.tid AS competing_tid,
      ts.utid AS competing_utid,
      thr.name AS competing_thread,
      proc.name AS competing_process,
      ts.state AS competing_state,
      ts.dur AS competing_dur_ns
      ${includeFreq.ok ? `,(SELECT MAX(freq) FROM cpu_frequency_counters f WHERE f.cpu = tc.cpu AND f.ts + f.dur >= tc.ts_start AND f.ts <= tc.ts_end) AS cpu_max_freq` : ',NULL AS cpu_max_freq'}
    FROM target_cpu AS tc
    JOIN thread_state AS ts
      ON ts.cpu = tc.cpu
     AND ts.state = 'Running'
     AND ts.ts <= tc.ts_end
     AND ts.ts + ts.dur >= tc.ts_start
    LEFT JOIN thread AS thr ON thr.utid = ts.utid
    LEFT JOIN process AS proc ON proc.upid = thr.upid
    WHERE ts.utid != (SELECT utid FROM segs WHERE idx = tc.segment_idx)
    ORDER BY ts.dur DESC
    LIMIT ${Math.min(runnable.length * 6, 120)};
  `;
  const attempt = await tryQuery<CpuRow>(tp, traceId, sql, (row) => ({
    segmentIdx: toNumber(row.segment_idx),
    cpu: toNumber(row.cpu),
    competingTid: toNullableNumber(row.competing_tid),
    competingUtid: toNullableNumber(row.competing_utid),
    competingThread: toOptionalString(row.competing_thread),
    competingProcess: toOptionalString(row.competing_process),
    competingState: toOptionalString(row.competing_state),
    competingDurMs: nsToMs(toNumber(row.competing_dur_ns)),
    cpuMaxFreqKhz: toNullableNumber(row.cpu_max_freq),
  }));
  return {rows: attempt.rows, status: attempt.status, warning: attempt.warning};
}

export async function enrichSegmentsWithSemantics(
  tp: TraceProcessorService,
  traceId: string,
  segments: SegmentInput[]
): Promise<Map<string, SegmentSemantics>> {
  const result = new Map<string, SegmentSemantics>();

  if (segments.length === 0) return result;

  // Initialize empty buckets for every segment so callers always get a slot.
  for (const segment of segments) {
    const key = segmentKeyOf(segment);
    result.set(key, {
      segmentKey: key,
      binderTxns: [],
      monitorContention: [],
      ioSignals: [],
      gcEvents: [],
      cpuCompetition: [],
      sources: {
        binder: 'skipped',
        monitor: 'skipped',
        io: 'skipped',
        gc: 'skipped',
        cpu: 'skipped',
      },
      warnings: [],
    });
  }

  // Run all five queries concurrently — each is independent.
  const [binder, monitor, io, gc, cpu] = await Promise.all([
    loadBinderTxns(tp, traceId, segments),
    loadMonitorContention(tp, traceId, segments),
    loadIoSignals(tp, traceId, segments),
    loadGcEvents(tp, traceId, segments),
    loadCpuCompetition(tp, traceId, segments),
  ]);

  const distribute = <T extends {segmentIdx: number}>(
    rows: T[],
    pick: (sem: SegmentSemantics, row: T) => void
  ): void => {
    for (const row of rows) {
      const segment = segments[row.segmentIdx];
      if (!segment) continue;
      const sem = result.get(segmentKeyOf(segment));
      if (!sem) continue;
      pick(sem, row);
    }
  };

  distribute(binder.rows, (sem, row) =>
    sem.binderTxns.push({
      binderTxnId: row.binderTxnId,
      binderReplyId: row.binderReplyId,
      side: row.side,
      interfaceName: row.interfaceName,
      methodName: row.methodName,
      isSync: row.isSync,
      isMainThread: row.isMainThread,
      clientProcess: row.clientProcess,
      clientThread: row.clientThread,
      serverProcess: row.serverProcess,
      serverThread: row.serverThread,
      clientUtid: row.clientUtid,
      serverUtid: row.serverUtid,
      clientTid: row.clientTid,
      serverTid: row.serverTid,
      durMs: row.durMs,
    })
  );

  distribute(monitor.rows, (sem, row) =>
    sem.monitorContention.push({
      rowId: row.rowId,
      shortBlockedMethod: row.shortBlockedMethod,
      shortBlockingMethod: row.shortBlockingMethod,
      blockedThreadName: row.blockedThreadName,
      blockingThreadName: row.blockingThreadName,
      blockedTid: row.blockedTid,
      blockingTid: row.blockingTid,
      blockedUtid: row.blockedUtid,
      blockingUtid: row.blockingUtid,
      durMs: row.durMs,
      isBlockedThreadMain: row.isBlockedThreadMain,
    })
  );

  distribute(io.rows, (sem, row) =>
    sem.ioSignals.push({
      source: row.ioWait ? 'io_wait_flag' : 'blocked_function',
      blockedFunction: row.blockedFunction,
      durMs: row.durMs,
      ioWait: row.ioWait,
    })
  );

  distribute(gc.rows, (sem, row) =>
    sem.gcEvents.push({
      gcType: row.gcType,
      isMarkCompact: row.isMarkCompact,
      reclaimedMb: row.reclaimedMb,
      durMs: row.durMs,
      thread: row.thread,
      process: row.process,
    })
  );

  distribute(cpu.rows, (sem, row) =>
    sem.cpuCompetition.push({
      cpu: row.cpu,
      competingTid: row.competingTid,
      competingUtid: row.competingUtid,
      competingThread: row.competingThread,
      competingProcess: row.competingProcess,
      competingState: row.competingState,
      competingDurMs: row.competingDurMs,
      cpuMaxFreqKhz: row.cpuMaxFreqKhz,
    })
  );

  // Set per-source status + warnings on every segment, even if it received 0 rows.
  for (const sem of result.values()) {
    sem.sources = {
      binder: binder.status,
      monitor: monitor.status,
      io: io.status,
      gc: gc.status,
      cpu: cpu.status,
    };
    for (const w of [binder.warning, monitor.warning, io.warning, gc.warning, cpu.warning]) {
      if (w) sem.warnings.push(w);
    }
  }

  return result;
}

// Exported for unit-test reach into otherwise-private helpers.
export const __INTERNAL__ = {
  classifyError,
  segmentKeyOf,
  buildSegmentValuesCte,
};
