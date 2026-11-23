// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  buildSqlSchemaDiagnostic,
  SqlFailureRepeatMemory,
} from '../sqlSchemaDiagnostic';

// Error strings below are the exact diagnoses the pinned trace_processor_shell
// returns for these shapes (normalized by the SQL worker).
function diagnose(error: string, sql?: string, injectedModules?: string[], memory = new SqlFailureRepeatMemory()) {
  return buildSqlSchemaDiagnostic({error, sql, injectedModules}, memory);
}

describe('buildSqlSchemaDiagnostic', () => {
  // SmartPerfetto 742d1f907, pi-fresh50f SQL-FAILURES-FULL.json, original tool SQL.
  it.each([
    ["syntax error near 'THEN'", "SELECT sc.cpu, ROUND(SUM(CASE WHEN sc.ts < 77147748001355 THEN 77147748001355 ELSE sc.ts END - CASE WHEN sc.ts+sc.dur > 77160521248676 THEN 77160521248676 ELSE sc.ts+sc.dur END < 0 THEN 0 ELSE (CASE WHEN sc.ts+sc.dur > 77160521248676 THEN 77160521248676 ELSE sc.ts+sc.dur END - CASE WHEN sc.ts < 77147748001355 THEN 77147748001355 ELSE sc.ts END) END)/1e6,1) AS busy_ms FROM sched sc JOIN thread th ON sc.utid = th.utid WHERE th.is_idle = 0 AND sc.ts < 77160521248676 AND sc.ts + sc.dur > 77147748001355 GROUP BY sc.cpu ORDER BY sc.cpu", "each branch needs WHEN"],
    ["syntax error near '.0'", "SELECT s.name, COUNT(*) cnt, ROUND(SUM(s.dur)/1e6.0,1) total_ms, ROUND(AVG(s.dur)/1e6.0,2) avg_ms, ROUND(MAX(s.dur)/1e6.0,2) max_ms\nFROM slice s JOIN thread_track tt ON s.track_id = tt.id\nWHERE tt.utid = 722\nGROUP BY s.name ORDER BY SUM(s.dur) DESC LIMIT 30", "integer exponent"],
    ["misuse of window function LAG()", "SELECT s.name AS doframe_marker, COUNT(*) AS cnt,\n       ROUND(MAX(s.ts - LAG(s.ts) OVER (ORDER BY s.ts))/1e6, 2) AS max_interval_ms\nFROM slice s JOIN thread_track tt ON s.track_id = tt.id\nWHERE tt.utid = 1090 AND s.name GLOB '*doFrame*'\nGROUP BY s.name", "then filter or aggregate"],
    ["no such column: p.name", "WITH slow AS (\n  SELECT s.id, s.ts, s.dur FROM slice s JOIN thread_track tt ON s.track_id=tt.id\n  WHERE tt.utid=25 AND s.name='draw-VRI[HeavyLoadActivity]' AND s.depth=3\n  ORDER BY s.dur DESC LIMIT 1\n)\nSELECT p.name AS parent_name, c.name AS child_name, c.depth,\n       (c.ts - p.ts) AS child_offset_ns, c.dur/1e6 AS child_ms\nFROM slow p JOIN slice c ON c.track_id = (SELECT track_id FROM slice WHERE id=p.id)\n  AND c.ts >= p.ts AND c.ts < p.ts + p.dur AND c.depth > p.depth\nORDER BY c.ts LIMIT 40", "SELECT list of CTE slow"],
  ])('diagnoses captured structural failure: %s', (error, sql, hint) => {
    expect(diagnose(error, sql)).toMatchObject({absence: 'query_error_not_data_absence'});
    expect(diagnose(error, sql).hint).toContain(hint);
  });

  it('explains a documented slice column whose alias is only bound inside a CTE', () => {
    expect(diagnose('no such column: s.dur', `
      WITH df AS (SELECT s.dur FROM slice s), g AS (SELECT dur FROM df)
      SELECT s.dur/1e6 FROM g`
    ).hint).toContain('slice has dur, but s is bound inside a CTE');
  });

  it('uses the defining module when a table spelling was put in INCLUDE', () => {
    expect(diagnose("INCLUDE: unknown module 'android.garbage_collection_events'"))
      .toMatchObject({errorKind: 'unknown_module', closestSymbols: ['android.garbage_collection'],
        hint: expect.stringContaining('INCLUDE PERFETTO MODULE android.garbage_collection')});
  });

  it('names the stdlib table, its columns and the nearest ones for an unqualified missing column', () => {
    const result = diagnose(
      'no such column: ts (line 1, col 48)',
      'SELECT ts FROM android_binder_txns WHERE is_sync',
      ['android.binder'],
    );

    expect(result).toMatchObject({
      errorKind: 'missing_column',
      absence: 'query_error_not_data_absence',
      symbol: 'android_binder_txns',
      column: 'ts',
      stdlibModule: 'android.binder',
      moduleInjected: true,
      availableColumnsSource: 'bundled_stdlib_docs',
      repeatCount: 1,
    });
    expect(result.availableColumns).toEqual(expect.arrayContaining(['client_ts', 'server_ts', 'client_dur']));
    expect(result.closestColumns).toEqual(expect.arrayContaining(['client_ts', 'server_ts']));
  });

  it.each([
    ['SELECT ts FROM android_binder_txns ORDER BY ts', 'ts'],
    ['SELECT b.client_dur FROM android_binder_txns b ORDER BY b.ts', 'b.ts'],
    ['SELECT b.TS FROM android_binder_txns b', 'b.TS'],
    ['SELECT B.TS FROM "ANDROID_BINDER_TXNS" AS [B]', 'B.TS'],
  ])('lists documented binder timestamp candidates for %s', (sql, column) => {
    const result = diagnose(`no such column: ${column}`, sql);
    expect(result.hint).toContain('Related columns: aidl_ts, client_ts, server_ts.');
    expect(result.hint).toContain('Choose the event, side, or measurement');
    expect(result.hint).not.toMatch(/<!--|\{\{/);
    expect(result.absence).toBe('query_error_not_data_absence');
  });

  // These columns were verified by SELECT on the pinned trace processor.
  it.each([
    ['no such column: ts', 'SELECT ts FROM android_input_events', 'android_input_events',
      'android.input', 'dispatch_ts, receive_ts'],
    ['no such column: gc.ts', 'SELECT gc.ts FROM android_garbage_collection_events gc JOIN thread t USING(utid)',
      'android_garbage_collection_events', 'android.garbage_collection', 'gc_ts'],
    ['no such column: utid', 'SELECT utid FROM android_binder_txns',
      'android_binder_txns', 'android.binder', 'client_utid, server_utid'],
    ['no such column: upid', 'SELECT upid FROM android_binder_txns',
      'android_binder_txns', 'android.binder', 'client_upid, server_upid'],
  ])('uses documented columns for %s in %s', (error, sql, symbol, module, candidates) => {
    const result = diagnose(error, `INCLUDE PERFETTO MODULE ${module}; ${sql}`);
    expect(result).toMatchObject({
      errorKind: 'missing_column',
      absence: 'query_error_not_data_absence',
      symbol,
      stdlibModule: module,
      moduleInjected: true,
      availableColumnsSource: 'bundled_stdlib_docs',
    });
    expect(result.hint).toContain(`Related columns: ${candidates}.`);
  });

  it.each([
    ['SELECT ts FROM chrome_scroll_update_info_step_templates', 'ts'],
    ['SELECT s.ts FROM android_startups s', 's.ts'],
    ['SELECT id FROM android_input_events', 'id'],
    ['SELECT ts FROM unknown_relation', 'ts'],
    ['SELECT ts FROM android_binder_txns b JOIN android_startups s ON b.client_upid=s.upid', 'ts'],
    ['SELECT x.ts FROM android_binder_txns b', 'x.ts'],
    ['SELECT ts$x.ts FROM android_input_events', 'ts$x.ts'],
    ['SELECT i.ts FROM android_input_events i$other', 'i.ts'],
    ["SELECT android_input_events.ts FROM android_input_events AS 'i'", 'android_input_events.ts'],
    ['WITH gaps AS (VALUES(1)) SELECT ts FROM android_input_events JOIN gaps', 'ts'],
    ['SELECT ts FROM android_input_events JOIN (VALUES(1)) AS other', 'ts'],
    ['SELECT ts FROM android_input_events JOIN json_each(\'[]\') AS other', 'ts'],
    ['SELECT ts FROM (android_input_events) AS i', 'ts'],
    ['SELECT ts FROM android_input_events WHERE EXISTS (SELECT 1)', 'ts'],
    ['SELECT ts FROM android_input_events; SELECT 1', 'ts'],
    ['SELECT i.ts FROM android_input_events i JOIN android_input_events i', 'i.ts'],
    ['SELECT i.ts FROM android_input_events i JOIN thread t ON i.upid=t.upid, process i', 'i.ts'],
    ['SELECT i.ts FROM android_input_events i JOIN thread t USING(upid), process i', 'i.ts'],
    ['SELECT window.ts FROM android_input_events WINDOW w AS ()', 'window.ts'],
  ])('does not offer related columns for %s', (sql, column) => {
    expect(diagnose(`no such column: ${column}`, sql).hint).toBeUndefined();
  });

  it('withholds hints from prelude even when documented columns share the suffix', () => {
    const result = diagnose('no such column: ts', 'SELECT ts FROM process');
    expect(result).toMatchObject({
      symbol: 'process',
      availableColumns: expect.arrayContaining(['start_ts', 'end_ts']),
    });
    expect(result.hint).toBeUndefined();
  });

  it('resolves a qualified column through its alias', () => {
    const result = diagnose(
      'no such column: b.dur (line 1, col 8)',
      'SELECT b.dur, t.name FROM android_binder_txns AS b JOIN thread t ON t.utid = b.client_utid',
    );
    expect(result).toMatchObject({symbol: 'android_binder_txns', column: 'dur'});
    expect(result.closestColumns).toEqual(expect.arrayContaining(['client_dur', 'server_dur']));
    expect(result.hint).toContain('aidl_dur, client_dur, server_dur, client_monotonic_dur, server_monotonic_dur');
    expect(result.alternativeSymbols).toBeUndefined();
  });

  it('lists every queried table lacking an unqualified column, first one as the symbol', () => {
    const result = diagnose(
      'no such column: upid (line 1, col 8)',
      'SELECT upid FROM thread_state ts JOIN android_binder_txns b ON b.client_utid = ts.utid',
    );
    expect(result.symbol).toBe('thread_state');
    expect(result.stdlibModule).toBeUndefined();
    expect(result.availableColumns).toEqual(expect.arrayContaining(['utid', 'state']));
    expect(result.alternativeSymbols).toEqual(['android_binder_txns']);
  });

  it('reports the defining module of a missing stdlib table and whether it was loaded', () => {
    expect(diagnose(
      'no such table: android_monitor_contention (line 1, col 1)',
      'SELECT * FROM android_monitor_contention',
      [],
    )).toMatchObject({
      errorKind: 'missing_table',
      symbol: 'android_monitor_contention',
      stdlibModule: 'android.monitor_contention',
      moduleInjected: false,
    });

    // The query's own INCLUDE counts; a commented-out one does not.
    const error = 'no such table: android_monitor_contention (line 1, col 1)';
    expect(diagnose(
      error,
      'INCLUDE PERFETTO MODULE android.monitor_contention; SELECT * FROM android_monitor_contention',
    ).moduleInjected).toBe(true);
    expect(diagnose(
      error,
      '-- INCLUDE PERFETTO MODULE android.monitor_contention\nSELECT * FROM android_monitor_contention',
    ).moduleInjected).toBe(false);

    const typo = diagnose('no such table: android_monitor_contentionx (line 1, col 1)');
    expect(typo.stdlibModule).toBeUndefined();
    expect(typo.closestSymbols).toContain('android_monitor_contention');
  });

  it('suggests modules and gives ambiguous-column guidance', () => {
    const module = diagnose("INCLUDE: unknown module 'android.binderx'");
    expect(module).toMatchObject({errorKind: 'unknown_module', symbol: 'android.binderx'});
    expect(module.closestSymbols).toContain('android.binder');

    expect(diagnose('ambiguous column name: id (line 1, col 8)')).toMatchObject({
      errorKind: 'other',
      absence: 'query_error_not_data_absence',
      repeatCount: 1, hint: expect.stringContaining('Qualify the reported column'),
    });
  });

  it('counts repeats per run by kind, symbol and name, not by position or other runs', () => {
    const run = new SqlFailureRepeatMemory();
    const sql = 'SELECT ts FROM android_binder_txns';
    expect(diagnose('no such column: ts (line 1, col 8)', sql, [], run).repeatCount).toBe(1);
    expect(diagnose('no such column: ts (line 3, col 12)', `${sql} LIMIT 5`, [], run).repeatCount).toBe(2);
    expect(diagnose('no such column: dur (line 1, col 8)', 'SELECT dur FROM android_binder_txns', [], run).repeatCount)
      .toBe(1);
    expect(diagnose('no such column: ts (line 1, col 8)', sql, [], new SqlFailureRepeatMemory()).repeatCount).toBe(1);
  });
});
