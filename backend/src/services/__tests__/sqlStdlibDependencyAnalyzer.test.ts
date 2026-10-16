// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  analyzeSqlStdlibDependencySequence,
  analyzeSqlStdlibDependencies,
  extractExternalTableBindings,
  extractExternalTableReferences,
  extractLocalSqlSymbols,
  moduleCoveredByStdlibDeclaration,
} from '../sqlStdlibDependencyAnalyzer';

describe('sqlStdlibDependencyAnalyzer', () => {
  it('detects stdlib table dependencies', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT id, self_dur
      FROM slice_self_dur
      ORDER BY self_dur DESC
    `);

    expect(analysis.dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
    expect(analysis.requiredModules).toEqual(['slices.self_dur']);
  });

  it('detects stdlib macro dependencies', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT *
      FROM counter_leading_intervals!(counter, value)
    `);

    expect(analysis.dependencies).toEqual(
      expect.arrayContaining([
        { symbol: 'counter_leading_intervals', module: 'counters.intervals', usage: 'macro' },
      ]),
    );
    expect(analysis.requiredModules).toContain('counters.intervals');
  });

  it('detects stdlib function dependencies', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT *
      FROM cpu_thread_utilization_in_interval(0, 1000000000)
    `);

    expect(analysis.dependencies.some(dep =>
      dep.symbol === 'cpu_thread_utilization_in_interval'
      && dep.usage === 'function'
      && dep.module.startsWith('linux.cpu.utilization.')
    )).toBe(true);
    expect(analysis.requiredModules.some(module => module.startsWith('linux.cpu.utilization.'))).toBe(true);
  });

  it('does not require already included modules', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      INCLUDE PERFETTO MODULE slices.self_dur;
      SELECT * FROM slice_self_dur
    `);

    expect(analysis.dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('treats stdlib_docs transitive includes as covering dependencies', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      INCLUDE PERFETTO MODULE android.frames.timeline;
      SELECT id, thread_name
      FROM thread_slice
    `);

    expect(analysis.dependencies).toEqual([
      { symbol: 'thread_slice', module: 'slices.with_context', usage: 'table' },
    ]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('keeps INCLUDE statements order-sensitive across SQL statements', () => {
    const includedFirst = analyzeSqlStdlibDependencies(`
      INCLUDE PERFETTO MODULE slices.self_dur;
      SELECT * FROM slice_self_dur;
    `);
    const includedAfterUse = analyzeSqlStdlibDependencies(`
      SELECT * FROM slice_self_dur;
      INCLUDE PERFETTO MODULE slices.self_dur;
    `);

    expect(includedFirst.requiredModules).toEqual([]);
    expect(includedAfterUse.requiredModules).toEqual(['slices.self_dur']);
  });

  it('treats parent module declarations as covering descendants', () => {
    expect(moduleCoveredByStdlibDeclaration('android.startup.startups', ['android.startup'])).toBe(true);
    expect(moduleCoveredByStdlibDeclaration('android.startup.startups', ['android'])).toBe(true);
    expect(moduleCoveredByStdlibDeclaration('android.startup.startups', [' android.startup '])).toBe(true);
    expect(moduleCoveredByStdlibDeclaration('android.startup.startups', ['linux.cpu'])).toBe(false);
  });

  it('ignores local CTEs and local created objects that shadow stdlib symbols', () => {
    const sql = `
      CREATE PERFETTO VIEW local_view AS SELECT * FROM slice;
      WITH slice_self_dur AS (
        SELECT * FROM slice
      )
      SELECT * FROM slice_self_dur JOIN local_view USING (id)
    `;
    const analysis = analyzeSqlStdlibDependencies(sql);

    expect(extractLocalSqlSymbols(sql)).toEqual(['local_view', 'slice_self_dur']);
    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('accepts extra local symbols for multi-step skill validation', () => {
    const analysis = analyzeSqlStdlibDependencies(
      'SELECT * FROM slice_self_dur',
      { extraLocalSymbols: ['slice_self_dur'] },
    );

    expect(analysis.dependencies).toEqual([]);
  });

  it('ignores comments and string literals', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      -- FROM slice_self_dur
      SELECT 'counter_leading_intervals!(counter, value)' AS literal
      FROM slice
    `);

    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('ignores function-like stdlib names inside quoted identifiers and double-quoted literals', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT "cpu_thread_utilization_in_interval(0, 1)" AS literalish
      FROM slice
    `);

    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('normalizes quoted local symbols that shadow stdlib names', () => {
    const sql = `
      WITH "slice_self_dur" AS (
        SELECT * FROM slice
      )
      SELECT * FROM "slice_self_dur"
    `;
    const analysis = analyzeSqlStdlibDependencies(sql);

    expect(extractLocalSqlSymbols(sql)).toEqual(['slice_self_dur']);
    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('recognizes CTE column lists when local CTEs shadow stdlib names', () => {
    const sql = `
      WITH seed AS (SELECT 1 AS id),
           slice_self_dur(id) AS (
             SELECT id FROM seed
           ),
           counter_leading_intervals AS MATERIALIZED (
             SELECT id FROM seed
           )
      SELECT * FROM slice_self_dur JOIN counter_leading_intervals USING (id)
    `;
    const analysis = analyzeSqlStdlibDependencies(sql);

    expect(extractLocalSqlSymbols(sql)).toEqual(['counter_leading_intervals', 'seed', 'slice_self_dur']);
    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('detects comma joins after table-valued functions', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT *
      FROM cpu_thread_utilization_in_interval(0, 1000000000) util,
           slice_self_dur s
      WHERE s.id = util.utid
    `);

    expect(analysis.dependencies).toEqual(
      expect.arrayContaining([
        { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
      ]),
    );
    expect(analysis.dependencies.some(dep =>
      dep.symbol === 'cpu_thread_utilization_in_interval'
      && dep.usage === 'function'
      && dep.module.startsWith('linux.cpu.utilization.')
    )).toBe(true);
  });

  it('keeps multi-fragment local symbols order-sensitive', () => {
    const analyses = analyzeSqlStdlibDependencySequence([
      'SELECT * FROM slice_self_dur',
      'CREATE PERFETTO VIEW slice_self_dur AS SELECT * FROM slice',
    ]);

    expect(analyses[0].dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
    expect(analyses[1].dependencies).toEqual([]);
  });

  it('keeps multi-statement local symbols order-sensitive inside one fragment', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      SELECT * FROM slice_self_dur;
      CREATE PERFETTO VIEW slice_self_dur AS SELECT * FROM slice;
    `);

    expect(analysis.dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
    expect(analysis.requiredModules).toEqual(['slices.self_dur']);
  });

  it('allows earlier local symbols in the same fragment to shadow later stdlib names', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      CREATE PERFETTO VIEW slice_self_dur AS SELECT * FROM slice;
      SELECT * FROM slice_self_dur;
    `);

    expect(analysis.dependencies).toEqual([]);
    expect(analysis.requiredModules).toEqual([]);
  });

  it('does not leak CTE symbols into later statements in the same fragment', () => {
    const analysis = analyzeSqlStdlibDependencies(`
      WITH slice_self_dur AS (
        SELECT * FROM slice
      )
      SELECT * FROM slice_self_dur;
      SELECT * FROM slice_self_dur;
    `);

    expect(analysis.dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
    expect(analysis.requiredModules).toEqual(['slices.self_dur']);
  });

  it('allows earlier local symbols to shadow later stdlib names', () => {
    const analyses = analyzeSqlStdlibDependencySequence([
      'CREATE PERFETTO VIEW slice_self_dur AS SELECT * FROM slice',
      'SELECT * FROM slice_self_dur',
    ]);

    expect(analyses[0].dependencies).toEqual([]);
    expect(analyses[1].dependencies).toEqual([]);
  });

  it('does not leak CTE symbols into later fragments', () => {
    const analyses = analyzeSqlStdlibDependencySequence([
      'WITH slice_self_dur AS (SELECT * FROM slice) SELECT * FROM slice_self_dur',
      'SELECT * FROM slice_self_dur',
    ]);

    expect(analyses[0].dependencies).toEqual([]);
    expect(analyses[1].dependencies).toEqual([
      { symbol: 'slice_self_dur', module: 'slices.self_dur', usage: 'table' },
    ]);
  });

  it('binds external tables to the aliases they are read under', () => {
    expect(extractExternalTableBindings(`
      WITH recent AS (SELECT * FROM slice)
      SELECT b.client_ts
      FROM android_binder_txns AS b, "process"
      JOIN thread t ON t.utid = b.client_utid
      LEFT JOIN recent r USING (ts)
    `)).toEqual([
      {table: 'slice'},
      {table: 'android_binder_txns', alias: 'b'},
      {table: 'process'},
      {table: 'thread', alias: 't'},
    ]);
    expect(extractExternalTableReferences('SELECT * FROM slice s JOIN slice p ON p.id = s.parent_id'))
      .toEqual(['slice']);
  });

  it('reports literal schema introspection only when asked', () => {
    const sql = "SELECT name FROM pragma_table_info('android_monitor_contention')";
    expect(analyzeSqlStdlibDependencies(sql).dependencies).toEqual([]);
    expect(analyzeSqlStdlibDependencies(sql, {includeIntrospectedNames: true}).dependencies).toEqual([
      {symbol: 'android_monitor_contention', module: 'android.monitor_contention', usage: 'introspection'},
    ]);
  });
});
