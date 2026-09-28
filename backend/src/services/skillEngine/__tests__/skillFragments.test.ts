// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {composeFragmentSql, injectFragmentCtes, substituteSqlPlaceholders} from '../skillFragments';

describe('substituteSqlPlaceholders', () => {
  it('parses the path, the default and whether the token sits inside a string literal', () => {
    const seen: unknown[] = [];
    const sql = substituteSqlPlaceholders("SELECT ${a}, '${b|x}', 'it''s ${c}', ${d | 5}", (placeholder) => {
      seen.push(placeholder);
      return 'v';
    });

    expect(sql).toBe("SELECT v, 'v', 'it''s v', v");
    expect(seen).toEqual([
      {match: '${a}', path: 'a', insideQuotes: false},
      {match: '${b|x}', path: 'b', defaultValue: 'x', insideQuotes: true},
      {match: '${c}', path: 'c', insideQuotes: true},
      {match: '${d | 5}', path: 'd', defaultValue: '5', insideQuotes: false},
    ]);
  });

  const quoting = (sql: string) => {
    const seen: Record<string, boolean> = {};
    substituteSqlPlaceholders(sql, ({path, insideQuotes}) => {
      seen[path] = insideQuotes;
      return 'v';
    });
    return seen;
  };

  it('ignores apostrophes in line and block comments', () => {
    expect(quoting([
      "-- the target process's deliveries",
      'WHERE (${start_ts} IS NULL OR ts >= ${start_ts})',
      "  AND name = '${package}' /* it's the app */ AND ${end_ts} > 0",
      "/* a block comment's",
      "   spanning lines */ AND upid = ${upid}",
    ].join('\n'))).toEqual({start_ts: false, package: true, end_ts: false, upid: false});
  });

  it('does not start a comment inside a string literal', () => {
    expect(quoting("SELECT '--', ${a}, '/*', ${b}, 'x -- y ${c}', '--''s ${d}'"))
      .toEqual({a: false, b: false, c: true, d: true});
  });

  it('reads a placeholder inside a comment as unquoted, and an unterminated comment as running to the end', () => {
    expect(quoting("SELECT 1 -- it's ${a}\n/* it's ${b} */ /* it's ${c}"))
      .toEqual({a: false, b: false, c: false});
  });
});

describe('injectFragmentCtes', () => {
  it('joins bodies after an existing WITH, keeping leading comments, or opens one', () => {
    expect(injectFragmentCtes('-- head\nWITH own AS (SELECT 1) SELECT * FROM own', ['a AS (SELECT 2) -- tail']))
      .toBe('-- head\nWITH\na AS (SELECT 2) -- tail\n,\nown AS (SELECT 1) SELECT * FROM own');
    expect(injectFragmentCtes('SELECT 1', ['a AS (SELECT 2)', 'b AS (SELECT 3)']))
      .toBe('WITH\na AS (SELECT 2)\n,\nb AS (SELECT 3)\nSELECT 1');
    expect(injectFragmentCtes('SELECT 1', [])).toBe('SELECT 1');
  });
});

describe('composeFragmentSql', () => {
  it('binds numbers and numeric defaults, and refuses anything left unbound', () => {
    let text = 'f AS (SELECT ${k} AS k, ${n|7} AS n)';
    const compose = (numbers?: Record<string, number>) =>
      composeFragmentSql({leadingCtes: ['w AS (SELECT 1)'], fragments: ['f.sql'], select: 'SELECT * FROM f',
        numbers, load: () => text});

    expect(compose({k: 3})).toBe('WITH\nw AS (SELECT 1)\n,\nf AS (SELECT 3 AS k, 7 AS n)\nSELECT * FROM f');
    expect(() => compose()).toThrow('fragment f.sql needs a numeric ${k}');

    text = "f AS (SELECT ${label|'x'})";
    expect(() => compose()).toThrow("needs a numeric ${label|'x'}");

    text = 'f AS (SELECT * FROM process WHERE upid = ${__process_scope.upid})';
    expect(() => compose()).toThrow('needs a numeric ${__process_scope.upid}');
  });
});
