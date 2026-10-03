// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {composeFragmentSql, injectFragmentCtes} from '../skillFragments';

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
