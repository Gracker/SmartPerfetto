// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import type {QueryResult, TraceProcessorService} from '../../src/services/traceProcessorService';

export function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return {columns, rows, durationMs: 1};
}

export const EMPTY = queryResult([], []);

export interface SqlRule {
  match: RegExp;
  responder: (sql: string) => QueryResult;
}

export interface SqliteTraceProcessorOptions {
  /** Checked first, in order; the first matching rule answers the query. */
  rules?: SqlRule[];
  /**
   * `INCLUDE PERFETTO MODULE <module>` resolves with this message in `error`,
   * as the production service reports a failed INCLUDE; every other INCLUDE
   * succeeds.
   */
  includeErrors?: Record<string, string>;
  /** A query matching the pattern resolves with this message in `error`. */
  queryErrors?: Array<[RegExp, string]>;
}

// The stdlib tables and columns the critical-path engine reads: task, range,
// waker, the L3 fragments (including the wake-source thread roles, which need
// `process.pid`, and CPU competition on `sched`) and the frame-impact join.
const SCHEMA = `
  CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT, pid INTEGER);
  -- Fixture convention: a thread named 'main' is its process's main thread.
  CREATE TABLE thread(
    utid INTEGER PRIMARY KEY, tid INTEGER, upid INTEGER, name TEXT,
    is_main_thread INTEGER GENERATED ALWAYS AS (CASE WHEN name = 'main' THEN 1 ELSE 0 END) VIRTUAL
  );
  CREATE TABLE thread_state(
    id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, state TEXT,
    blocked_function TEXT, io_wait INTEGER, cpu INTEGER,
    waker_utid INTEGER, waker_id INTEGER, irq_context INTEGER
  );
  CREATE TABLE android_binder_txns(
    binder_txn_id INTEGER, binder_reply_id INTEGER, interface TEXT, method_name TEXT,
    is_sync INTEGER, is_main_thread INTEGER, client_process TEXT, client_thread TEXT,
    server_process TEXT, server_thread TEXT, client_utid INTEGER, server_utid INTEGER,
    client_tid INTEGER, server_tid INTEGER, client_ts INTEGER, client_dur INTEGER,
    server_ts INTEGER, server_dur INTEGER
  );
  CREATE TABLE android_monitor_contention(
    id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, blocked_utid INTEGER, blocking_utid INTEGER,
    blocked_thread_tid INTEGER, blocking_tid INTEGER, blocked_thread_name TEXT,
    blocking_thread_name TEXT, short_blocked_method TEXT, short_blocking_method TEXT,
    is_blocked_thread_main INTEGER
  );
  CREATE TABLE android_garbage_collection_events(
    upid INTEGER, gc_ts INTEGER, gc_dur INTEGER, gc_type TEXT, is_mark_compact INTEGER,
    reclaimed_mb REAL, thread_name TEXT, process_name TEXT
  );
  CREATE TABLE sched(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER, utid INTEGER, priority INTEGER);
  CREATE TABLE cpu_frequency_counters(cpu INTEGER, ts INTEGER, dur INTEGER, freq INTEGER);
  CREATE TABLE expected_frame_timeline_slice(
    ts INTEGER, dur INTEGER, upid INTEGER, display_frame_token INTEGER, layer_name TEXT
  );
  CREATE TABLE actual_frame_timeline_slice(
    display_frame_token INTEGER, upid INTEGER, jank_type TEXT, present_type TEXT
  );
  CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
  CREATE TABLE slice(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, depth INTEGER, name TEXT, track_id INTEGER);
  CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
  -- A setup that needs a real trace end (open thread_state rows) updates this row.
  INSERT INTO trace_bounds VALUES (0, 9000000000000000);
`;

/**
 * An in-memory SQLite stand-in for trace_processor. Every query the engine
 * sends runs as real SQL against `SCHEMA` plus `setup`, so overlap predicates
 * and clipping are executed, except what the option hooks answer first.
 * `_critical_path_stack` is a stdlib table function SQLite lacks, so a test
 * that reaches it supplies a rule. Like the production service, a statement
 * SQLite rejects resolves with `error` and no rows instead of throwing.
 */
export function sqliteTraceProcessor(
  setup: string,
  options: SqliteTraceProcessorOptions = {}
): {tp: TraceProcessorService; sqls: string[]} {
  const db = new Database(':memory:');
  db.exec(`${SCHEMA}${setup}`);
  const sqls: string[] = [];
  const query = async (_traceId: string, sql: string): Promise<QueryResult> => {
    sqls.push(sql);
    for (const rule of options.rules ?? []) {
      if (rule.match.test(sql)) return rule.responder(sql);
    }
    const include = /^\s*INCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)/i.exec(sql);
    if (include) {
      const error = options.includeErrors?.[include[1]];
      return error ? {...EMPTY, error} : EMPTY;
    }
    for (const [pattern, error] of options.queryErrors ?? []) {
      if (pattern.test(sql)) return {...EMPTY, error};
    }
    try {
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      return queryResult(columns, statement.raw(true).all() as unknown[][]);
    } catch (error: unknown) {
      return {...EMPTY, error: error instanceof Error ? error.message : String(error)};
    }
  };
  return {tp: {query} as unknown as TraceProcessorService, sqls};
}
