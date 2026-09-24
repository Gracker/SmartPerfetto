// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Resolve a `utid` from the selectors a model actually has.
//
// `analyzeCriticalPath` addresses a thread by `threadStateId` or `utid`, which
// is what the UI already holds when the user clicks a slice. An agent asking
// "why was this page slow" has a package name and maybe a thread name instead,
// and nothing in the critical-path modules turned those into a utid. This does,
// and it reports ambiguity rather than silently picking the first row: two
// processes of the same package (`:push`, `:remote`) or a thread pool with
// sixteen `pool-1-thread-*` members are ordinary, and answering about the wrong
// one is worse than asking which.

import {
  queryRows,
  toNullableNumber,
  toNumber,
  toOptionalString,
} from '../utils/traceProcessorRowUtils';
import {CriticalPathInputError, openRowEndSql} from './criticalPathAnalyzer';
import type {CriticalPathInputErrorCode} from '../types/criticalPathContract';
import type {TraceProcessorService} from './traceProcessorService';

export interface CriticalPathThreadSelector {
  utid?: number | string;
  upid?: number | string;
  pid?: number | string;
  processName?: string;
  tid?: number | string;
  threadName?: string;
  mainThread?: boolean;
}

export interface ResolvedCriticalPathThread {
  utid: number;
  tid: number | null;
  threadName: string | null;
  upid: number | null;
  pid: number | null;
  processName: string | null;
  isMainThread: boolean | null;
}

export type CriticalPathThreadResolution =
  | {status: 'resolved'; thread: ResolvedCriticalPathThread}
  /**
   * `candidatesAtLeast` is a lower bound, not a total: the query stops at
   * `MAX_THREAD_CANDIDATES + 1` rows, so a process with sixty `pool-1-thread-*`
   * members reports eleven. Naming it a total invited the caller — and the
   * model reading the refusal — to treat it as the size of the ambiguity.
   */
  | {status: 'ambiguous'; candidates: ResolvedCriticalPathThread[]; candidatesAtLeast: number}
  | {status: 'not_found'; reason: 'no_selector' | 'no_match'};

/** How many candidates a caller is shown before it has to narrow the selector. */
export const MAX_THREAD_CANDIDATES = 10;

/** `value` as non-negative integer SQL text; anything else is the caller's `code` error. */
function nonNegativeIntegerSql(
  value: unknown,
  field: string,
  code: CriticalPathInputErrorCode = 'invalid_integer',
): string {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new CriticalPathInputError(code, `${field} must be a non-negative integer`);
  }
  return raw;
}

function integerPredicate(column: string, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return `${column} = ${nonNegativeIntegerSql(value, field)}`;
}

/**
 * Trace-processor takes SQL as text, so a name reaches it as a literal. Doubling
 * the quote is the SQLite escape; a NUL or newline has no business in a comm
 * name and would only be there to break out of one.
 */
function sqlStringLiteral(value: string, field: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new CriticalPathInputError('invalid_name', `${field} must not contain control characters`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQLite GLOB reads `*`, `?` and `[` as pattern syntax, and a comm or process
 * name can legitimately contain all three: `pool[1]-thread` would silently stop
 * matching itself, and a name ending in `*` would match everything. GLOB has no
 * backslash escape, so a one-character class is the escape — `*` becomes `[*]`.
 * The exact-match pass needs none of this; only the prefix pass builds a pattern.
 */
function globEscape(value: string): string {
  return value.replace(/[*?[]/g, (char) => `[${char}]`);
}

function trimmedName(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 200) throw new CriticalPathInputError('invalid_name', `${field} must be at most 200 characters`);
  return text;
}

function rowToThread(row: Record<string, unknown>): ResolvedCriticalPathThread {
  const isMainThread = toNullableNumber(row.is_main_thread);
  return {
    utid: toNumber(row.utid),
    tid: toNullableNumber(row.tid),
    threadName: toOptionalString(row.thread_name),
    upid: toNullableNumber(row.thread_upid),
    pid: toNullableNumber(row.pid),
    processName: toOptionalString(row.process_name),
    isMainThread: isMainThread === null ? null : isMainThread === 1,
  };
}

async function selectThreads(
  tp: TraceProcessorService,
  traceId: string,
  predicates: string[],
  signal: AbortSignal | undefined,
): Promise<ResolvedCriticalPathThread[]> {
  const rows = await queryRows(
    tp,
    traceId,
    `
    SELECT
      thread.utid,
      thread.tid,
      thread.name AS thread_name,
      thread.upid AS thread_upid,
      thread.is_main_thread AS is_main_thread,
      process.pid AS pid,
      process.name AS process_name
    FROM thread
    LEFT JOIN process USING(upid)
    WHERE ${predicates.join(' AND ')}
    ORDER BY thread.utid ASC
    LIMIT ${MAX_THREAD_CANDIDATES + 1}
  `,
    {signal},
  );
  return rows.map(rowToThread);
}

/**
 * Resolve one thread from a mix of process and thread selectors.
 *
 * `processName` is tried as an exact match first and only then as a prefix:
 * `com.example.app` must not resolve to `com.example.app:push` while the exact
 * process exists. `threadName` is always a prefix match, because the kernel
 * stores `comm` truncated to 15 characters and a thread-pool name carries its
 * index in the suffix.
 */
export async function resolveCriticalPathThread(
  tp: TraceProcessorService,
  traceId: string,
  selector: CriticalPathThreadSelector,
  options: {signal?: AbortSignal} = {},
): Promise<CriticalPathThreadResolution> {
  const base: string[] = [];
  const utid = integerPredicate('thread.utid', selector.utid, 'utid');
  if (utid) base.push(utid);
  const upid = integerPredicate('thread.upid', selector.upid, 'upid');
  if (upid) base.push(upid);
  const pid = integerPredicate('process.pid', selector.pid, 'pid');
  if (pid) base.push(pid);
  const tid = integerPredicate('thread.tid', selector.tid, 'tid');
  if (tid) base.push(tid);
  if (selector.mainThread === true) base.push('thread.is_main_thread = 1');

  const threadName = trimmedName(selector.threadName, 'thread_name');
  if (threadName) {
    base.push(`thread.name GLOB ${sqlStringLiteral(`${globEscape(threadName)}*`, 'thread_name')}`);
  }

  const processName = trimmedName(selector.processName, 'process_name');
  if (base.length === 0 && !processName) return {status: 'not_found', reason: 'no_selector'};

  const passes = processName
    ? [
        [...base, `process.name = ${sqlStringLiteral(processName, 'process_name')}`],
        [...base, `process.name GLOB ${sqlStringLiteral(`${globEscape(processName)}*`, 'process_name')}`],
      ]
    : [base];

  for (const predicates of passes) {
    const candidates = await selectThreads(tp, traceId, predicates, options.signal);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) return {status: 'resolved', thread: candidates[0]};
    return {
      status: 'ambiguous',
      candidates: candidates.slice(0, MAX_THREAD_CANDIDATES),
      candidatesAtLeast: candidates.length,
    };
  }
  return {status: 'not_found', reason: 'no_match'};
}

// ── thread_state_id consistency ─────────────────────────────────────────────

/** The thread and time span a thread_state row belongs to. */
export interface ThreadStateOwner extends ResolvedCriticalPathThread {
  threadStateId: number;
  startTs: number;
  /** A row still open at the end of the trace ends there. */
  endTs: number;
}

/**
 * The owner of a thread_state row, or null when no row has that id. A
 * malformed id is the caller's error, reported as the engine reports it.
 */
export async function loadThreadStateOwner(
  tp: TraceProcessorService,
  traceId: string,
  threadStateId: number | string,
  options: {signal?: AbortSignal} = {},
): Promise<ThreadStateOwner | null> {
  const raw = nonNegativeIntegerSql(threadStateId, 'threadStateId', 'invalid_thread_state_id');
  const rows = await queryRows(
    tp,
    traceId,
    `
    SELECT
      target.id AS thread_state_id,
      target.ts,
      ${openRowEndSql('target')} AS end_ts,
      thread.utid,
      thread.tid,
      thread.name AS thread_name,
      thread.upid AS thread_upid,
      thread.is_main_thread AS is_main_thread,
      process.pid AS pid,
      process.name AS process_name
    FROM thread_state AS target
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE target.id = ${raw}
    LIMIT 1
  `,
    {signal: options.signal},
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...rowToThread(row),
    threadStateId: toNumber(row.thread_state_id),
    startTs: toNumber(row.ts),
    endTs: toNumber(row.end_ts),
  };
}

/** A selector field a thread_state row's owner can disagree with. */
export type ThreadStateSelectorField =
  | 'utid' | 'tid' | 'upid' | 'pid' | 'thread_name' | 'process_name' | 'main_thread' | 'window';

const sameInteger = (value: number | string | undefined, actual: number | null): boolean =>
  value === undefined || (actual !== null && String(value).trim() === String(actual));

/**
 * The selector fields the row's owner contradicts, empty when the row belongs
 * to the requested thread and overlaps the requested window. Names match the
 * way the resolver matches them: a thread name as a prefix (comm is truncated),
 * a process name exactly or as a prefix.
 */
export function threadStateSelectorConflicts(
  owner: ThreadStateOwner,
  selector: CriticalPathThreadSelector,
  window?: {startTs: number; endTs: number},
): ThreadStateSelectorField[] {
  const conflicts: ThreadStateSelectorField[] = [];
  if (!sameInteger(selector.utid, owner.utid)) conflicts.push('utid');
  if (!sameInteger(selector.tid, owner.tid)) conflicts.push('tid');
  if (!sameInteger(selector.upid, owner.upid)) conflicts.push('upid');
  if (!sameInteger(selector.pid, owner.pid)) conflicts.push('pid');
  const threadName = selector.threadName?.trim();
  if (threadName && !(owner.threadName ?? '').startsWith(threadName)) conflicts.push('thread_name');
  const processName = selector.processName?.trim();
  if (processName && !(owner.processName ?? '').startsWith(processName)) conflicts.push('process_name');
  if (selector.mainThread === true && owner.isMainThread !== true) conflicts.push('main_thread');
  if (window && !(owner.startTs < window.endTs && owner.endTs > window.startTs)) conflicts.push('window');
  return conflicts;
}

// ── Threads with scheduling data ────────────────────────────────────────────

/** How many threads with scheduling data a no-data refusal proposes. */
export const MAX_SCHED_DATA_CANDIDATES = 5;

export interface SchedDataThread extends ResolvedCriticalPathThread {
  /** thread_state rows of this thread overlapping the window. */
  threadStateRows: number;
}

/**
 * Threads that do have thread_state rows in the window, for a caller whose
 * chosen thread has none: the same process first (main thread, then most
 * rows); when that process has none, the main threads of other processes.
 * `processHasSchedData` is null when no process was given.
 */
export async function findThreadsWithSchedData(
  tp: TraceProcessorService,
  traceId: string,
  window: {upid: number | null; startTs: number; endTs: number},
  options: {signal?: AbortSignal} = {},
): Promise<{processHasSchedData: boolean | null; candidates: SchedDataThread[]}> {
  const select = async (predicate: string): Promise<SchedDataThread[]> => {
    const rows = await queryRows(
      tp,
      traceId,
      `
      SELECT
        thread.utid,
        thread.tid,
        thread.name AS thread_name,
        thread.upid AS thread_upid,
        thread.is_main_thread AS is_main_thread,
        process.pid AS pid,
        process.name AS process_name,
        COUNT(1) AS thread_state_rows
      FROM thread_state AS tstate
      JOIN thread USING(utid)
      LEFT JOIN process USING(upid)
      WHERE tstate.ts < ${Math.trunc(window.endTs)}
        AND ${openRowEndSql('tstate')} > ${Math.trunc(window.startTs)}
        AND ${predicate}
      GROUP BY thread.utid
      ORDER BY COALESCE(thread.is_main_thread, 0) DESC, thread_state_rows DESC, thread.utid ASC
      LIMIT ${MAX_SCHED_DATA_CANDIDATES}
    `,
      {signal: options.signal},
    );
    return rows.map((row) => ({...rowToThread(row), threadStateRows: toNumber(row.thread_state_rows)}));
  };

  if (window.upid !== null) {
    const sameProcess = await select(`thread.upid = ${Math.trunc(window.upid)}`);
    if (sameProcess.length > 0) return {processHasSchedData: true, candidates: sameProcess};
  }
  const mainThreads = await select('thread.is_main_thread = 1');
  return {processHasSchedData: window.upid === null ? null : false, candidates: mainThreads};
}
