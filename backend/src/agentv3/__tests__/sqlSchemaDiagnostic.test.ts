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
    ['WITH gaps AS (SELECT dispatch_ts AS start_ts FROM android_input_events) SELECT gaps.ts FROM gaps', 'gaps.ts'],
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

  it('suggests modules for an unknown module and keeps other errors kind-only', () => {
    const module = diagnose("INCLUDE: unknown module 'android.binderx'");
    expect(module).toMatchObject({errorKind: 'unknown_module', symbol: 'android.binderx'});
    expect(module.closestSymbols).toContain('android.binder');

    expect(diagnose('ambiguous column name: id (line 1, col 8)')).toEqual({
      errorKind: 'other',
      absence: 'query_error_not_data_absence',
      repeatCount: 1,
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
