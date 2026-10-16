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

  it('resolves a qualified column through its alias', () => {
    const result = diagnose(
      'no such column: b.dur (line 1, col 8)',
      'SELECT b.dur, t.name FROM android_binder_txns AS b JOIN thread t ON t.utid = b.client_utid',
    );
    expect(result).toMatchObject({symbol: 'android_binder_txns', column: 'dur'});
    expect(result.closestColumns).toEqual(expect.arrayContaining(['client_dur', 'server_dur']));
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
