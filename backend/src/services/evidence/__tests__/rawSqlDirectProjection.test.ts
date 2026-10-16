// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  analyzeRawSqlDirectProjection,
  RAW_SQL_DIRECT_PROJECTION_LIMITS,
  resolveRawSqlDirectProjection,
} from '../rawSqlDirectProjection';
import {resolveRawSqlExpressionUnits} from '../rawSqlExpressionUnits';

const columns = ['id', 'ts', 'dur', 'name'];
const mapped = (sql: string, output: string[], schema: string[] = columns) =>
  resolveRawSqlDirectProjection(analyzeRawSqlDirectProjection(sql), output, schema);

describe('raw SQL direct projection', () => {
  const typedColumns = [{name: 'id', type: 'ID'}, {name: 'ts', type: 'TIMESTAMP'}, {name: 'dur', type: 'DURATION'}];
  it.each([
    ['COUNT(*)', 'count'], ['COUNT(DISTINCT id)', 'count'], ['SUM(dur)', 'ns'],
    ['MIN(dur)', 'ns'], ['MAX(dur)', 'ns'], ['AVG(dur)', 'ns'],
    ['dur / 1e6', 'ms'], ['SUM(dur) / 1000', 'us'], ['dur * 0.000000001', 's'],
    ['SUM(MIN(ts + dur, 100000000) - MAX(ts, 0))', 'ns'],
  ])('resolves typed quantity %s without supplying direct row correspondence', (expression, unit) => {
    const parsed = analyzeRawSqlDirectProjection(`SELECT ${expression} AS quantity FROM slice`);
    expect(parsed.pureRead).toBe(true);
    expect(resolveRawSqlExpressionUnits(parsed, ['quantity'], typedColumns)).toEqual({quantity: unit});
    expect(resolveRawSqlDirectProjection(parsed, ['quantity'], columns)).toBeUndefined();
  });

  it.each([
    '1 / 1000000', 'id / 1000000', 'dur / 2', 'dur / 42', 'dur / 0', 'ts + dur', 'SUM(ts)',
    'ts - 1000', 'dur + 1000', 'dur / 1000000 + dur', 'ABS(dur)', 'CAST(dur AS REAL)',
  ])('does not derive a duration or identity from an untyped expression: %s', expression => {
    expect(resolveRawSqlExpressionUnits(analyzeRawSqlDirectProjection(`SELECT ${expression} AS dur FROM slice`),
      ['dur'], typedColumns)).toEqual({});
  });
  it('validates actual aliases, output cardinality and qualified columns independently of unit propagation', () => {
    const parsed = analyzeRawSqlDirectProjection('SELECT SUM(s.dur) / 1000000 AS arbitrary FROM slice s');
    expect(resolveRawSqlExpressionUnits(parsed, ['arbitrary'], typedColumns)).toEqual({arbitrary: 'ms'});
    expect(resolveRawSqlExpressionUnits(parsed, ['dur_ms'], typedColumns)).toEqual({});
    expect(resolveRawSqlExpressionUnits(parsed, ['arbitrary', 'extra'], typedColumns)).toEqual({});
    expect(resolveRawSqlExpressionUnits(analyzeRawSqlDirectProjection('SELECT SUM(other.dur) AS quantity FROM slice s'),
      ['quantity'], typedColumns)).toEqual({});
  });
  it('maps an executed direct projection by formal source column and exact output alias', () => {
    const sql = 'SELECT s.dur AS elapsed, s.id FROM main.slice AS s WHERE s.id = 11140 ORDER BY s.ts DESC LIMIT 1 OFFSET 0;';
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed).toEqual({pureRead: true, relation: {schema: 'main', name: 'slice', alias: 's'}, projections: [
      {kind: 'column', qualifier: 's', column: 'dur', alias: 'elapsed'},
      {kind: 'column', qualifier: 's', column: 'id'},
    ]});
    expect(resolveRawSqlDirectProjection(parsed, ['elapsed', 'id'], columns)).toEqual([
      {outputColumn: 'elapsed', sourceColumn: 'dur'}, {outputColumn: 'id', sourceColumn: 'id'},
    ]);
    expect(sql).toContain('s.dur AS elapsed');
  });

  it.each(['SELECT * FROM slice', 'SELECT s.* FROM slice s', 'SELECT DISTINCT * FROM main.slice']) (
    'expands a single star against exact schema and actual output: %s', sql => {
      expect(mapped(sql, columns)).toEqual(columns.map(column => ({outputColumn: column, sourceColumn: column})));
      expect(mapped(sql, ['id', 'dur', 'ts', 'name'])).toBeUndefined();
      expect(mapped(sql, ['id', 'ts', 'dur'])).toBeUndefined();
    });

  it.each([
    'SeLeCt "S"."DUR" AS "Elapsed" FrOm "MAIN"."SLICE" "S"',
    'SELECT [S].[DUR] AS [Elapsed] FROM [main].[SLICE] AS [S]',
    'SELECT `S`.`DUR` AS `Elapsed` FROM `main`.`SLICE` `S`',
  ])('handles SQLite identifier case and quoting without rewriting aliases: %s', sql => {
    expect(mapped(sql, ['Elapsed'])).toEqual([{outputColumn: 'Elapsed', sourceColumn: 'dur'}]);
    expect(mapped(sql, ['elapsed'])).toBeUndefined();
  });

  it('decodes escaped quoted aliases while keeping SQL punctuation inside identifiers', () => {
    expect(mapped('SELECT dur AS "a""b; DROP TABLE slice" FROM slice', ['a"b; DROP TABLE slice']))
      .toEqual([{outputColumn: 'a"b; DROP TABLE slice', sourceColumn: 'dur'}]);
    expect(mapped('SELECT dur AS "__proto__" FROM slice', ['__proto__']))
      .toEqual([{outputColumn: '__proto__', sourceColumn: 'dur'}]);
  });

  it('handles comments and escaped string literals without treating their contents as SQL', () => {
    const sql = `/* SELECT run_metric('x'); */ SELECT s.dur -- DROP TABLE slice;
      FROM slice s WHERE s.name = 'it''s ; SELECT run_metric(''x'')' /* trailing */;
      -- INCLUDE PERFETTO MODULE dangerous;`;
    expect(mapped(sql, ['dur'])).toEqual([{outputColumn: 'dur', sourceColumn: 'dur'}]);
  });

  it.each([
    'SELECT dur FROM slice WHERE abs(dur) > 0 AND id BETWEEN 1 AND 10 ORDER BY ts ASC NULLS LAST, id DESC LIMIT -1 OFFSET 0',
    "SELECT dur FROM slice WHERE name NOT IN ('a', 'b') AND name LIKE 'a!_%' ESCAPE '!' LIMIT 2, 1",
    "SELECT dur FROM slice WHERE name IS NOT NULL OR name GLOB 'x*' ORDER BY name COLLATE NOCASE",
    'SELECT dur FROM slice WHERE id = ?1 AND dur > :minimum',
  ])('consumes the complete finite read-only tail: %s', sql => {
    expect(mapped(sql, ['dur'])).toEqual([{outputColumn: 'dur', sourceColumn: 'dur'}]);
  });

  it('retains direct source columns at their exact ordinals beside scalar expressions', () => {
    const sql = 'SELECT id, ts, dur, ts + dur AS end_ts FROM slice';
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed.projections).toEqual([
      {kind: 'column', column: 'id'}, {kind: 'column', column: 'ts'},
      {kind: 'column', column: 'dur'}, {kind: 'scalar', alias: 'end_ts'},
    ]);
    expect(mapped(sql, ['id', 'ts', 'dur', 'end_ts'])).toEqual([
      {outputColumn: 'id', sourceColumn: 'id'}, {outputColumn: 'ts', sourceColumn: 'ts'},
      {outputColumn: 'dur', sourceColumn: 'dur'},
    ]);
    expect(mapped(sql, ['id', 'ts', 'dur'])).toBeUndefined();
    expect(mapped(sql, ['id', 'ts', 'end_ts', 'dur'])).toBeUndefined();
    expect(mapped(sql, ['id', 'ts', 'dur', 'other'])).toBeUndefined();
    expect(mapped(sql, ['id', 'ts', 'dur', 'end_ts', 'extra'])).toBeUndefined();
  });

  it.each([
    ["SELECT 1 AS flag, s.dur AS elapsed, 'note' AS note FROM slice s", ['flag', 'elapsed', 'note'], 'elapsed'],
    ['SELECT abs(dur), dur FROM slice', ['abs(dur)', 'dur'], 'dur'],
    ['SELECT CAST(ts AS REAL) AS stamp, dur, coalesce(name, ?) AS label FROM slice', ['stamp', 'dur', 'label'], 'dur'],
    ['SELECT ts + dur, s.dur AS "Elapsed" FROM slice s', ['ts + dur', 'Elapsed'], 'Elapsed'],
    ["SELECT 'count(dur)' AS note, dur FROM slice /* max(ts) */", ['note', 'dur'], 'dur'],
  ] as Array<[string, string[], string]>)('maps only direct slots in a finite scalar mix: %s', (sql, output, direct) => {
    expect(mapped(sql, output)).toEqual([{outputColumn: direct, sourceColumn: 'dur'}]);
  });

  it.each([
    ['SELECT 11140 AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT id + 0 AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT (id) AS id, dur FROM slice', ['id', 'dur']],
    ['SELECT dur, dur / 1e6 AS elapsed FROM slice', ['dur', 'elapsed']],
    ['SELECT ts AS id, dur FROM slice', ['id', 'dur']],
  ] as Array<[string, string[]]>)('never guesses a native id or unit from a scalar output name: %s', (sql, output) => {
    const result = mapped(sql, output)!;
    expect(result).toContainEqual({outputColumn: 'dur', sourceColumn: 'dur'});
    expect(result.some(column => column.sourceColumn === 'id')).toBe(false);
    expect(result.some(column => column.outputColumn === 'elapsed')).toBe(false);
    if (sql.startsWith('SELECT ts AS id')) {
      expect(result).toContainEqual({outputColumn: 'id', sourceColumn: 'ts'});
    } else {
      expect(result.some(column => column.outputColumn === 'id')).toBe(false);
    }
  });

  it('expands a star at its ordinal between scalar expressions', () => {
    const sql = 'SELECT 1 AS flag, s.*, s.ts + s.dur AS end_ts FROM main.slice s';
    const output = ['flag', ...columns, 'end_ts'];
    expect(mapped(sql, output)).toEqual(columns.map(column => ({outputColumn: column, sourceColumn: column})));
    expect(mapped(sql, ['flag', 'id', 'dur', 'ts', 'name', 'end_ts'])).toBeUndefined();
    expect(mapped(sql, ['flag', ...columns])).toBeUndefined();
    expect(mapped(sql, [...columns, 'flag', 'end_ts'])).toBeUndefined();
  });

  it.each([
    'SELECT dur, COUNT(*) AS n FROM slice',
    'SELECT dur, sum(ts) AS total_ts FROM slice',
    'SELECT dur, avg(ts) AS avg_ts FROM slice',
    'SELECT dur, total(ts) AS total_ts FROM slice',
    'SELECT dur, min(ts, 0) AS minimum FROM slice',
    'SELECT dur, max(ts) AS maximum FROM slice',
    'SELECT dur, abs(sum(ts)) AS nested FROM slice',
    'SELECT dur FROM slice ORDER BY max(ts)',
    'SELECT dur FROM slice WHERE count(id) > 0',
    'SELECT dur FROM slice LIMIT min(id)',
    'SELECT dur, 1 AS flag FROM slice GROUP BY name',
    'SELECT dur, COUNT(*) AS n FROM slice HAVING count(*) > 0',
    'SELECT s.dur, 1 AS flag FROM slice s JOIN thread_track t ON s.track_id = t.id',
  ])('withholds all lineage for aggregates or changed row correspondence: %s', sql => {
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed.pureRead).toBe(true);
    expect(parsed.projections).toBeUndefined();
    expect(resolveRawSqlDirectProjection(parsed, ['dur', 'flag'], columns)).toBeUndefined();
  });

  it.each([
    'SELECT 1', 'SELECT 1 + 2 * 3', "SELECT 'text'", 'SELECT ?1',
    'SELECT COUNT(*) FROM slice', 'SELECT min(dur), MAX(dur) FROM slice',
    'SELECT count(DISTINCT track_id) FROM slice',
    'SELECT abs(dur), coalesce(name, ?) FROM slice', 'SELECT CAST(dur AS REAL) FROM slice',
    'SELECT dur / 1e6 AS dur FROM slice', 'SELECT dur + 0 AS dur FROM slice',
    'SELECT (dur) AS dur FROM slice',
    'SELECT track_id, sum(dur) FROM slice GROUP BY track_id HAVING sum(dur) > 0 ORDER BY track_id',
    'SELECT s.dur FROM slice s JOIN thread_track t ON s.track_id = t.id',
    'SELECT s.dur FROM slice s, thread t WHERE t.utid = 1',
    'SELECT s.dur FROM slice s LEFT OUTER JOIN thread_track t USING (id)',
  ])('recognizes a finite pure read without manufacturing direct lineage: %s', sql => {
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed.pureRead).toBe(true);
    expect(parsed.projections?.every(projection => projection.kind === 'scalar') ?? true).toBe(true);
    expect(resolveRawSqlDirectProjection(parsed, ['dur'], columns)).toBeUndefined();
  });

  it.each([
    ['SELECT dur AS same, id AS same FROM slice', ['same', 'same']],
    ['SELECT dur AS same, id AS SAME FROM slice', ['same', 'SAME']],
    ['SELECT *, dur FROM slice', [...columns, 'dur']],
    ['SELECT s.dur FROM slice', ['dur']],
    ['SELECT slice.dur FROM slice s', ['dur']],
    ['SELECT missing FROM slice', ['missing']],
    ['SELECT dur AS elapsed FROM slice', ['dur']],
    ['SELECT dur, id FROM slice', ['id', 'dur']],
    ['SELECT 1 AS same, dur AS same FROM slice', ['same', 'same']],
    ['SELECT 1 AS same, dur AS SAME FROM slice', ['same', 'SAME']],
    ['SELECT 1 AS same, dur AS same FROM slice', ['same', 'renamed']],
    ['SELECT 1 AS id, * FROM slice', ['id', ...columns]],
    ['SELECT 1 AS flag, s.dur FROM slice', ['flag', 'dur']],
    ['SELECT 1 AS flag, slice.dur FROM slice s', ['flag', 'dur']],
    ['SELECT 1 AS flag, s.* FROM slice', ['flag', ...columns]],
    ['SELECT 1 AS flag, missing FROM slice', ['flag', 'missing']],
    ['SELECT dur + 1 AS calculated, id FROM slice', ['id', 'calculated']],
  ] as Array<[string, string[]]>)('does not map ambiguous or mismatched output: %s', (sql, output) => {
    expect(mapped(sql, output)).toBeUndefined();
  });

  it('requires unique complete formal schema and output columns', () => {
    expect(mapped('SELECT dur FROM slice', ['dur'], ['dur', 'DUR'])).toBeUndefined();
    expect(mapped('SELECT dur FROM slice', ['dur'], ['id', 'ts'])).toBeUndefined();
    expect(mapped('SELECT dur FROM slice', [])).toBeUndefined();
    expect(mapped('SELECT dur FROM slice', ['dur'], [])).toBeUndefined();
    expect(mapped('SELECT dur FROM slice', ['dur'], [''])).toBeUndefined();
  });

  it.each([
    '', '-- SELECT 1', '/* SELECT 1 */',
    'SELECT dur FROM slice; DROP VIEW slice',
    "SELECT 1; SELECT run_metric('android/startup.sql')",
    'SELECT 1;;', 'SELECT 1; /* comment */ DELETE FROM slice',
    'WITH slice AS (SELECT 1 AS dur) SELECT dur FROM slice',
    'SELECT dur FROM (SELECT 1 AS dur)',
    'SELECT dur FROM slice UNION SELECT 1', 'SELECT dur FROM slice INTERSECT SELECT 1',
    'SELECT dur FROM slice EXCEPT SELECT 1',
    "SELECT run_metric('android/startup.sql')", 'SELECT RUN_METRIC(?)',
    'SELECT "run_metric"(?)', 'SELECT load_extension(?)', 'SELECT eval(?)',
    'SELECT abs(run_metric(?))', 'SELECT dur FROM slice WHERE run_metric(?) = 1',
    'SELECT dur FROM slice ORDER BY run_metric(?)', 'SELECT dur FROM slice LIMIT run_metric(?)',
    'SELECT dur FROM slice s JOIN thread t ON run_metric(?)',
    'SELECT unknown_function(dur) FROM slice', 'SELECT custom_macro!(dur) FROM slice',
    'SELECT dur FROM custom_table_function(?)',
    'SELECT dur FROM temp.slice', 'SELECT dur FROM other.slice',
    'SELECT main.slice.dur FROM main.slice',
    'SELECT * FROM slice INDEXED BY some_index',
    'SELECT dur FROM slice OFFSET 1', 'SELECT dur FROM slice ORDER BY ts unexpected',
    'SELECT dur FROM slice WHERE id IN other_table',
    'SELECT dur FROM slice WHERE name REGEXP ?',
    'SELECT dur FROM slice ORDER BY name COLLATE unknown_collation',
    'SELECT COUNT(*) FILTER (WHERE dur > 0) FROM slice',
    'SELECT row_number() OVER () FROM slice',
    'SELECT dur, count(*) OVER () FROM slice',
    'SELECT dur, unknown_function(ts) AS end_ts FROM slice',
    'SELECT dur, abs(unknown_function(ts)) AS end_ts FROM slice',
    'SELECT dur, 1 AS flag FROM slice UNION SELECT dur, 2 FROM slice',
    'SELECT * AS renamed FROM slice',
    'CREATE PERFETTO FUNCTION abs(x LONG) RETURNS LONG AS SELECT run_metric(?)',
    'CREATE TEMP TABLE slice AS SELECT 1 AS dur', 'DROP TABLE slice',
    'INCLUDE PERFETTO MODULE slices.with_context; SELECT dur FROM slice',
    'PRAGMA table_info(slice)', 'EXPLAIN SELECT dur FROM slice',
    'SELECT 1 /* unclosed', "SELECT 'unclosed", 'SELECT "unclosed', 'SELECT [dur]] FROM slice',
    'SELECT 1\0; SELECT 2', 'SELECT )1(', 'SELECT (((1)',
    'SEL/* middle */ECT dur FROM slice', "SELECT run_/* middle */metric('x')",
  ])('cannot establish pure-read status for unsupported or opaque SQL: %s', sql => {
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed.pureRead).toBe(false);
    expect(parsed.projections).toBeUndefined();
    expect(resolveRawSqlDirectProjection(parsed, ['dur'], columns)).toBeUndefined();
  });

  it.each([
    'SELECT (SELECT dur FROM slice)',
    'SELECT t.id AS track_id, t.name AS track_name, t.type AS track_type FROM track t WHERE t.id = (SELECT track_id FROM slice WHERE id = 50220)',
    'SELECT dur FROM slice WHERE id IN (SELECT id FROM slice WHERE dur > 0)',
    'SELECT dur FROM slice WHERE id NOT IN (SELECT id FROM slice WHERE dur < 0)',
    'SELECT dur, (SELECT ts FROM slice LIMIT 1) AS other_ts FROM slice',
    'SELECT dur FROM slice WHERE id = coalesce((SELECT id FROM slice LIMIT 1), 0)',
    'SELECT dur FROM slice WHERE id IN (SELECT id FROM slice WHERE id = (SELECT id FROM slice LIMIT 1))',
    `SELECT dur FROM slice WHERE id = (/* ) ; ( */ SELECT id FROM slice WHERE name = 'a); SELECT run_metric(''x'')' LIMIT 1)`,
    `SELECT dur FROM slice WHERE id = (SELECT id AS "x);(" FROM slice -- ) ;\nLIMIT 1)`,
  ])('admits a fully parsed benign subquery without assigning outer row or unit lineage: %s', sql => {
    const parsed = analyzeRawSqlDirectProjection(sql);
    expect(parsed).toMatchObject({pureRead: true, reason: 'projection_not_direct'});
    expect(parsed.projections).toBeUndefined();
    expect(resolveRawSqlDirectProjection(parsed, ['dur'], columns)).toBeUndefined();
  });

  it.each([
    'SELECT dur FROM slice WHERE id = (SELECT run_metric(?))',
    'SELECT dur FROM slice WHERE id IN (SELECT abs(run_metric(?)))',
    'SELECT dur FROM slice WHERE id = (SELECT unknown_function(id) FROM slice)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM custom_table_function(?))',
    'SELECT dur FROM slice WHERE id = (WITH x AS (SELECT 1) SELECT * FROM x)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice;)',
    'SELECT dur FROM slice WHERE id IN (SELECT id FROM slice; DROP TABLE slice)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice) ; SELECT run_metric(?)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice UNION SELECT id FROM slice)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice trailing tokens)',
    'SELECT dur FROM slice WHERE id = (SELECT id FROM slice',
    'SELECT dur FROM slice WHERE id IN (SELECT id FROM slice,)',
  ])('does not hide opaque or malformed operations inside subqueries: %s', sql => {
    expect(analyzeRawSqlDirectProjection(sql).pureRead).toBe(false);
  });

  it('retains global token/byte budgets and cumulative expression depth across nested parsers', () => {
    expect(analyzeRawSqlDirectProjection(`SELECT (SELECT '${'字'.repeat(RAW_SQL_DIRECT_PROJECTION_LIMITS.bytes / 2)}')`))
      .toEqual({pureRead: false, reason: 'sql_byte_budget'});
    expect(analyzeRawSqlDirectProjection(`SELECT (SELECT ${Array(5_000).fill('1').join(' + ')})`))
      .toEqual({pureRead: false, reason: 'sql_token_budget'});
    const depth = RAW_SQL_DIRECT_PROJECTION_LIMITS.depth;
    expect(analyzeRawSqlDirectProjection(`SELECT ${'(SELECT '.repeat(depth + 1)}1${')'.repeat(depth + 1)}`))
      .toEqual({pureRead: false, reason: 'sql_depth_budget'});
    expect(analyzeRawSqlDirectProjection(`SELECT ${'(SELECT - '.repeat(depth)}1${')'.repeat(depth)}`))
      .toEqual({pureRead: false, reason: 'sql_depth_budget'});
    expect(analyzeRawSqlDirectProjection(`SELECT ${'(SELECT '.repeat(depth)}1${')'.repeat(depth)}`).pureRead).toBe(true);
  });

  it('fails closed at UTF-8 byte, token and nested expression budgets', () => {
    expect(analyzeRawSqlDirectProjection(`SELECT '${'字'.repeat(RAW_SQL_DIRECT_PROJECTION_LIMITS.bytes / 2)}'`))
      .toEqual({pureRead: false, reason: 'sql_byte_budget'});
    expect(analyzeRawSqlDirectProjection(`SELECT ${Array(5_000).fill('1').join(' + ')}`))
      .toEqual({pureRead: false, reason: 'sql_token_budget'});
    const depth = RAW_SQL_DIRECT_PROJECTION_LIMITS.depth + 1;
    expect(analyzeRawSqlDirectProjection(`SELECT ${'('.repeat(depth)}1${')'.repeat(depth)}`))
      .toEqual({pureRead: false, reason: 'sql_depth_budget'});
    expect(analyzeRawSqlDirectProjection(`SELECT ${'- '.repeat(depth)}1`))
      .toEqual({pureRead: false, reason: 'sql_depth_budget'});
  });
});
