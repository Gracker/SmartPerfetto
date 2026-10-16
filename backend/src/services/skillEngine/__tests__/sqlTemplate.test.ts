// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {
  type SqlPlaceholder, sqlCodeText, sqlStringLiteralText, substituteSqlPlaceholders,
} from '../sqlTemplate';

const seen = (sql: string) => {
  const placeholders: SqlPlaceholder[] = [];
  const out = substituteSqlPlaceholders(sql, (placeholder) => {
    placeholders.push(placeholder);
    return 'v';
  });
  return {out, placeholders};
};
const contexts = (sql: string) =>
  Object.fromEntries(seen(sql).placeholders.map(p => [p.path, p.pattern ? `${p.context}:${p.pattern.operator}` : p.context]));

describe('substituteSqlPlaceholders', () => {
  it('parses the path and default and says whether the token sits in code or a string literal', () => {
    const {out, placeholders} = seen("SELECT ${a}, '${b|x}', 'it''s ${c}', ${d | 5}");
    expect(out).toBe("SELECT v, 'v', 'it''s v', v");
    expect(placeholders).toEqual([
      {match: '${a}', path: 'a', context: 'code'},
      {match: '${b|x}', path: 'b', defaultValue: 'x', context: 'string'},
      {match: '${c}', path: 'c', context: 'string'},
      {match: '${d | 5}', path: 'd', defaultValue: '5', context: 'code'},
    ]);
  });

  it('ignores apostrophes in line and block comments', () => {
    expect(contexts([
      "-- the target process's deliveries",
      'WHERE (${start_ts} IS NULL OR ts >= ${start_ts})',
      "  AND name = '${package}' /* it's the app */ AND ${end_ts} > 0",
      "/* a block comment's",
      '   spanning lines */ AND upid = ${upid}',
    ].join('\n'))).toEqual({start_ts: 'code', package: 'string', end_ts: 'code', upid: 'code'});
  });

  it('does not start a comment inside a string literal', () => {
    expect(contexts("SELECT '--', ${a}, '/*', ${b}, 'x -- y ${c}', '--''s ${d}'"))
      .toEqual({a: 'code', b: 'code', c: 'string', d: 'string'});
  });

  it('leaves comment placeholders as written, so a value cannot end the comment', () => {
    const sql = "SELECT 1 -- it's ${a}\n/* it's ${b} */ /* it's ${c}";
    const {out, placeholders} = seen(sql);
    expect(out).toBe(sql);
    expect(placeholders).toEqual([]);
  });

  it('reads a placeholder as one token, so quotes in its default are not SQL', () => {
    expect(contexts("SELECT ${label|'it'}, '${x}', ${y}")).toEqual({label: 'code', x: 'string', y: 'code'});
    expect(contexts('SELECT t${n} FROM x')).toEqual({n: 'code'});
    expect(contexts('SELECT "--", ${n}')).toEqual({n: 'code'});
  });

  it('marks the literal that is the whole GLOB or LIKE pattern, however it is spelled', () => {
    expect(contexts([
      "WHERE p.name GLOB '${a}:*' OR p.name NOT glob '${b}'",
      "  OR x GLOB /* note */ ('${c}') COLLATE BINARY",
      "  OR y LIKE 'TX - ${d}%' ESCAPE '\\' OR z LIKE '${e}'",
      "  AND w = '${f}' AND v GLOB 'literal*'",
    ].join('\n'))).toEqual({
      a: 'string:glob', b: 'string:glob', c: 'string:glob', d: 'string:like', e: 'string:like', f: 'string',
    });
    expect(seen("y LIKE '${d}%' ESCAPE '\\'").placeholders[0].pattern).toEqual({operator: 'like', escape: '\\'});
  });

  it('refuses a placeholder anywhere else in a pattern expression', () => {
    for (const sql of [
      "t.name GLOB '*' || LOWER('${x}') || '*'",
      "msg LIKE '%' ||\n  '${x}'\n  || '%'",
      "name GLOB LOWER('${x}')",
      "name GLOB ${x}",
      "name REGEXP '${x}'",
      "name MATCH '${x}'",
      "glob('${x}', name)",
      "name LIKE 'a%' ESCAPE '${x}'",
    ]) {
      expect(() => seen(sql)).toThrow('pattern expression');
    }
    // The operand ends where the comparison does.
    expect(contexts("a GLOB 'x*' AND b = '${x}' OR c LIKE 'y' || 'z' THEN '${y}'"))
      .toEqual({x: 'string', y: 'string'});
  });

  it('closes the review bypasses: CASE, COLLATE concatenation, quoted function names, ESCAPE operands', () => {
    for (const sql of [
      "name GLOB CASE WHEN 1 THEN '${x}' ELSE '' END",
      "name GLOB '${x}' COLLATE BINARY || '${y}'",
      `"glob"('\${x}', name)`,
      "`like`('${x}', name)",
      "name LIKE '${x}' ESCAPE ${e}",
      "name GLOB '${x}' ESCAPE '\\'",
    ]) {
      expect(() => seen(sql)).toThrow('pattern expression');
    }
    expect(contexts("a GLOB '${x}' COLLATE NOCASE AND b = CASE WHEN c THEN '${y}' END"))
      .toEqual({x: 'string:glob', y: 'string'});
    expect(seen("name LIKE '${x}' ESCAPE ('1')").placeholders[0].pattern).toEqual({operator: 'like', escape: '1'});
    // A quoted name is never a keyword: "END" does not close the CASE, and a column called "glob" is not GLOB.
    expect(() => seen(`name GLOB CASE WHEN "END" THEN '\${x}' ELSE '' END`)).toThrow('pattern expression');
    expect(() => seen("name GLOB CASE WHEN [END] THEN '${x}' ELSE '' END")).toThrow('pattern expression');
    expect(contexts(`SELECT "glob" || '\${x}' FROM names`)).toEqual({x: 'string'});
  });

  it('refuses a value the author\'s own pattern syntax would reinterpret', () => {
    expect(() => seen("name GLOB '[${x}]'")).toThrow('character class');
    expect(() => seen("name GLOB '[^]${x}'")).toThrow('character class');
    expect(() => seen("name LIKE '\\${x}%' ESCAPE '\\'")).toThrow('ESCAPE character');
    expect(contexts("a GLOB '[ab]${x}*' OR b LIKE '\\\\${y}%' ESCAPE '\\'"))
      .toEqual({x: 'string:glob', y: 'string:like'});
  });

  it('keeps a negative code value from joining a minus into a comment', () => {
    const out = substituteSqlPlaceholders('SELECT 1-${v} AND x = 1', () => '-1');
    expect(out).toBe('SELECT 1- -1 AND x = 1');
  });

  it('hands each caller its own copy of cached pattern metadata', () => {
    const sql = "name GLOB '${v}'";
    substituteSqlPlaceholders(sql, (p) => {
      (p.pattern as {operator: string}).operator = 'like';
      return '';
    });
    expect(seen(sql).placeholders[0].pattern).toEqual({operator: 'glob'});
  });

  it('refuses a placeholder inside a quoted identifier', () => {
    for (const sql of ['SELECT "${x}" FROM t', 'SELECT `${x}` FROM t', 'SELECT [${x}] FROM t']) {
      expect(() => seen(sql)).toThrow('quoted identifier');
    }
  });
});

const placeholder = (pattern?: SqlPlaceholder['pattern']): SqlPlaceholder =>
  ({match: '${v}', path: 'v', context: 'string', ...(pattern ? {pattern} : {})});

describe('sqlStringLiteralText', () => {
  it('doubles quotes and makes a GLOB value match itself, mapping each character once', () => {
    expect(sqlStringLiteralText("it's", placeholder())).toBe("it''s");
    expect(sqlStringLiteralText("a*b?[c]'", placeholder({operator: 'glob'}))).toBe("a[*]b[?][[]c]''");
    expect(sqlStringLiteralText('[*]', placeholder({operator: 'glob'}))).toBe('[[][*]]');
  });

  it('escapes LIKE wildcards with the ESCAPE character and refuses them without one', () => {
    expect(sqlStringLiteralText('a_b%c\\', placeholder({operator: 'like', escape: '\\'}))).toBe('a\\_b\\%c\\\\');
    expect(sqlStringLiteralText('com.foo', placeholder({operator: 'like'}))).toBe('com.foo');
    expect(() => sqlStringLiteralText('com_foo', placeholder({operator: 'like'}))).toThrow('without ESCAPE');
    expect(() => sqlStringLiteralText('com%', placeholder({operator: 'like'}))).toThrow('without ESCAPE');
  });

  it('matches only the literal value in SQLite', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE names (name TEXT)');
    const names = ['com.foo', 'com.foo:remote', 'com.foox', 'com.foo*', 'com.foo*:push', 'com.f[o]o', 'com.fo_'];
    for (const name of names) db.prepare('INSERT INTO names VALUES (?)').run(name);
    const matching = (predicate: string, value: string) => {
      const where = substituteSqlPlaceholders(predicate, p => sqlStringLiteralText(value, p));
      return (db.prepare(`SELECT name FROM names WHERE ${where} ORDER BY rowid`).all() as Array<{name: string}>)
        .map(row => row.name);
    };
    const scope = "name = '${v}' OR name GLOB '${v}:*'";
    expect(matching(scope, 'com.foo')).toEqual(['com.foo', 'com.foo:remote']);
    expect(matching(scope, 'com.foo*')).toEqual(['com.foo*', 'com.foo*:push']);
    expect(matching(scope, 'com.f[o]o')).toEqual(['com.f[o]o']);
    expect(matching("name GLOB '*${v}*'", '?')).toEqual([]);
    expect(matching("name LIKE 'com.f${v}' ESCAPE '\\'", 'o_')).toEqual(['com.fo_']);
    expect(matching("name LIKE 'com.f${v}' ESCAPE '\\'", 'oo')).toEqual(['com.foo']);
    expect(matching("name LIKE '${v}' ESCAPE ('o')", 'com.fo_')).toEqual(['com.fo_']);
    // The negative-number guard keeps the filter after the placeholder alive.
    const where = substituteSqlPlaceholders("1-${n} AND name = 'com.foo'", () => '-1');
    expect((db.prepare(`SELECT name FROM names WHERE ${where}`).all() as Array<{name: string}>).map(r => r.name))
      .toEqual(['com.foo']);
    db.close();
  });
});

describe('sqlCodeText', () => {
  const code: SqlPlaceholder = {match: '${v}', path: 'v', context: 'code'};

  it('writes numbers, booleans and SQL literal lists', () => {
    for (const [value, text] of [
      [42, '42'], [-1.5, '-1.5'], [true, 'true'], ['10001', '10001'], ['4,5,6,7', '4,5,6,7'],
      ["'Choreographer#doFrame','DrawFrame'", "'Choreographer#doFrame','DrawFrame'"],
      ["'x'' OR 1=1 --'", "'x'' OR 1=1 --'"],
    ] as const) {
      expect(sqlCodeText(value, code)).toBe(text);
    }
  });

  it('refuses any other value, which would be SQL written by the caller', () => {
    for (const value of [
      '1 OR 1=1', '1); DROP TABLE x; --', "'a', b", '', 'sess-123', "'a'\n-- x", {}, Symbol('x'),
    ]) {
      expect(() => sqlCodeText(value, code)).toThrow('outside a string literal');
    }
    for (const value of [Number.NaN, Infinity]) expect(() => sqlCodeText(value, code)).toThrow('NaN or infinite');
  });
});

describe('Skill SQL placeholder contract', () => {
  const skillsDir = path.resolve(__dirname, '../../../../skills');
  const files = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true})
    .flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const sqlTexts: Array<[string, string]> = [];
  const collect = (where: string, node: unknown): void => {
    if (Array.isArray(node)) node.forEach((x, i) => collect(`${where}[${i}]`, x));
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'sql' || key === 'exact_sql') && typeof value === 'string') sqlTexts.push([`${where}.${key}`, value]);
        else collect(`${where}.${key}`, value);
      }
    }
  };
  for (const file of files(skillsDir)) {
    const rel = path.relative(skillsDir, file);
    if (rel.startsWith('_template')) continue;
    if (file.endsWith('.sql')) sqlTexts.push([rel, fs.readFileSync(file, 'utf-8')]);
    else if (file.endsWith('.yaml')) yaml.loadAll(fs.readFileSync(file, 'utf-8'), doc => collect(rel, doc));
  }

  it('binds every placeholder only where escaping keeps it data', () => {
    expect(sqlTexts.length).toBeGreaterThan(500);
    const refused: string[] = [];
    for (const [where, sql] of sqlTexts) {
      try {
        seen(sql);
      } catch (error) {
        refused.push(`${where}: ${(error as Error).message}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it('gives every placeholder in a LIKE pattern an ESCAPE clause', () => {
    const unescaped = sqlTexts.flatMap(([where, sql]) => seen(sql).placeholders
      .filter(p => p.pattern?.operator === 'like' && !p.pattern.escape)
      .map(p => `${where}: ${p.match}`));
    expect(unescaped).toEqual([]);
  });
});
