// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Structural reads of a source the Skills may only read through its
// normalizing fragment: a relation the SQL names, and a track it selects by a
// literal. It reads the tokens placeholder binding reads (sqlTemplate.ts, with
// qualified names joined by sqlStructure.ts), so quotes, comments and
// placeholders are cut the same way, and matches by
// operator rather than by the text around a column: `LOWER(t.name) =
// 'gpufreq'`, `alias_col IN ('gpufreq')`, `'gpufreq' = name`, a conditional
// aggregate (`CASE WHEN t.name = 'gpufreq'`, `CASE t.name WHEN 'gpufreq'`,
// `IIF(t.name = 'gpufreq', ...)`, `value * (t.name = 'gpufreq')`) and a
// GLOB/LIKE row filter select the track as surely as `WHERE name =
// 'gpufreq'`, while a label (`THEN 'gpufreq'`, `'gpufreq' AS name`), an
// exclusion (!=, NOT IN, NOT GLOB) or SQL that reads no track table does not.
// Outside a row filter a pattern selects only when it names the track and no
// longer name: `CASE WHEN name GLOB '*gpufreq*'` labels cooling devices such
// as thermal-gpufreq-0 (thermal_cooling_spans.sql), it does not read gpufreq.
//
// Accepted limits. Hiding a read on purpose: a name built by concatenation
// ('gpu' || 'freq'), a placeholder inside the literal, a pattern held in a
// column or a subquery, the function forms glob()/like(), REGEXP, instr() and
// range comparisons. A wildcard pattern outside a row filter
// (`MAX(CASE WHEN name GLOB '*gpufreq*' THEN value END)`): it cannot be told
// from a cooling-device label without resolving which rows reach the CASE. And a comparison of a column the Skill computed
// itself in SQL that also reads a track table: without resolving columns, a
// label compared to 'gpufreq' there reads as a selection, which fails closed.

import {sqliteGlobRegExp, sqliteLikeRegExp} from './sqlPatterns';
import {cteDefinitionAt, isNameToken, QUERY_START, structuralSqlTokens, tokenMatchers, unqualifiedName} from './sqlStructure';

/** What a Skill SQL text reads. */
export interface SqlReads {
  /** Whether the SQL reads `relation` as a table: names it anywhere it does not define or call it. */
  readsRelation(relation: string): boolean;
  /**
   * Whether the SQL reads a track table and selects the track named or typed
   * `value`: by an exact comparison anywhere (row filter, CASE, IIF, an
   * expression), by a GLOB/LIKE row filter whose pattern singles it out, or
   * elsewhere by a pattern that admits only that name.
   */
  selectsTrack(value: string): boolean;
  /**
   * The names the SQL reads, lower-cased (tables, columns, called functions; a
   * qualified name by its last part), without the names it gives its own
   * columns, tables and CTEs (`AS name`, `name AS (`): `... AS cooling_hint`
   * reads no cooling device.
   */
  readonly identifiers: readonly string[];
  /** The literals the SQL selects rows or values by: exact comparisons and non-negated whole GLOB/LIKE patterns, as written. */
  readonly selectionLiterals: readonly string[];
}

const TRACK_TABLES = ['track', 'counter_track', 'gpu_counter_track', 'counters'];
const CREATED_BY = ['VIEW', 'TABLE', 'FUNCTION', 'MACRO', 'INDEX'];
const FILTER_START = new Set(['WHERE', 'HAVING', 'ON']);
const FILTER_END = new Set(['GROUP', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'SELECT', 'VALUES', 'JOIN']);
/** Track names a selecting pattern must not admit: it names one track, not a family. */
const UNRELATED_TRACKS = ['cpufreq', 'gpu_mem', 'gpu_memory', 'gpu_counter', 'mem.rss', 'Temperature', 'batt.charge_uah', 'x'];
/** Longer names around a track name, which a pattern that names only the track does not admit. */
const containing = (value: string) => [`thermal-${value}-0`, `${value}-0`, `x${value}`];

interface Scope { filter: boolean; inList: boolean }

function analyze(sql: string): SqlReads {
  const tokens = structuralSqlTokens(sql);
  const {word, punct} = tokenMatchers(tokens);

  // Names read as tables: every name except a definition and a call (a
  // qualified name is one token, read by its last part). A name the SQL
  // defines itself (a CTE or a created view) shadows the stdlib relation of
  // that name, so reading it reads the definition.
  const read = new Set<string>();
  const defines = new Set<string>();
  /** Names the SQL gives its own columns, tables and CTEs. */
  const ownNames = new Set<string>();
  /** Functions, macros and table functions the SQL calls. */
  const called = new Set<string>();
  tokens.forEach((token, index) => {
    if (!isNameToken(token)) return;
    const cte = cteDefinitionAt(tokens, index) !== undefined;
    if (!cte && punct(index + 1, '(')) { called.add(unqualifiedName(token)); return; } // a call
    // `CREATE ... IF NOT EXISTS <name>` may leave the stdlib relation in place:
    // it neither reads nor shadows it.
    if (word(index - 1, 'EXISTS')) return;
    const name = unqualifiedName(token);
    const defined = cte || CREATED_BY.some(text => word(index - 1, text));
    (defined ? defines : read).add(name);
    if (defined || word(index - 1, 'AS')) ownNames.add(name);
  });
  for (const name of defines) read.delete(name);

  // Literals the SQL compares against: exactly, or as a whole GLOB/LIKE
  // pattern (in a row filter, or anywhere when it names one string).
  const exact: string[] = [];
  const patterns: Array<{regExp: RegExp; filter: boolean}> = [];
  const selectionLiterals: string[] = [];
  /** Per open parenthesis (and the statement): whether it is in a row filter, and whether it is an `IN (...)` list. */
  const scopes: Scope[] = [{filter: false, inList: false}];
  /** The token before `index`, skipping opening parentheses. */
  const before = (index: number) => { let at = index - 1; while (punct(at, '(')) at--; return at; };
  /** The token after `index`, skipping closing parentheses. */
  const after = (index: number) => { let at = index + 1; while (punct(at, ')')) at++; return at; };
  tokens.forEach((token, index) => {
    const scope = scopes[scopes.length - 1];
    if (token.kind === 'punct') {
      if (token.text === '(') {
        const opensQuery = tokens[index + 1]?.kind === 'word' && QUERY_START.has(tokens[index + 1].text);
        scopes.push({filter: !opensQuery && scope.filter, inList: word(index - 1, 'IN') && !word(index - 2, 'NOT')});
      } else if (token.text === ')' && scopes.length > 1) scopes.pop();
      else if (token.text === ';') scopes.splice(0, scopes.length, {filter: false, inList: false});
      return;
    }
    if (token.kind === 'word') {
      if (FILTER_START.has(token.text)) scope.filter = true;
      else if (FILTER_END.has(token.text) || (token.text === 'FROM' && !word(index - 1, 'DISTINCT'))) scope.filter = false;
      return;
    }
    if (token.kind !== 'string' || token.bound) return;
    const left = before(index);
    if (token.pattern) {
      // NOT sits before the operator.
      if (!word(left - 1, 'NOT')) {
        const {operator, escape} = token.pattern;
        const regExp = operator === 'like' ? sqliteLikeRegExp(token.text, escape) : sqliteGlobRegExp(token.text);
        patterns.push({regExp, filter: scope.filter});
        selectionLiterals.push(token.text);
      }
      return;
    }
    const right = after(index);
    const equalsLeft = punct(left, '=') || punct(left, '==')
      || word(left, 'WHEN') // a simple CASE compares its operand to this literal
      || (word(left, 'IN') && !word(left - 1, 'NOT')) // IN (('gpufreq'))
      || (word(left, 'IS') && !word(left - 1, 'NOT'))
      || (word(left, 'FROM') && word(left - 1, 'DISTINCT') && word(left - 2, 'NOT') && word(left - 3, 'IS'));
    const equalsRight = punct(right, '=') || punct(right, '==') || word(right, 'IN')
      || (word(right, 'IS') && !word(right + 1, 'NOT') && !word(right + 1, 'DISTINCT'))
      || (word(right, 'IS') && word(right + 1, 'NOT') && word(right + 2, 'DISTINCT') && word(right + 3, 'FROM'));
    const listed = scope.inList && (punct(index - 1, '(') || punct(index - 1, ','));
    if (equalsLeft || equalsRight || listed) {
      exact.push(token.text.toLowerCase());
      selectionLiterals.push(token.text);
    }
  });

  const readsTrackTable = TRACK_TABLES.some(table => read.has(table));
  return {
    identifiers: [...read, ...called].filter(name => !ownNames.has(name)),
    selectionLiterals,
    readsRelation: relation => read.has(relation.toLowerCase()),
    selectsTrack: value => readsTrackTable && (
      exact.includes(value.toLowerCase())
      || patterns.some(({regExp, filter}) => {
        // A wrapper may have changed the column's case: try both.
        const admits = (name: string) => regExp.test(name) || regExp.test(name.toUpperCase());
        return admits(value) && !UNRELATED_TRACKS.some(admits) && (filter || !containing(value).some(admits));
      })),
  };
}

const cache = new Map<string, SqlReads>();
const CACHE_LIMIT = 2048;

/** What `sql` reads. Skill SQL and fragments are a fixed set of texts, so the analysis is kept by text. */
export function sqlReads(sql: string): SqlReads {
  let reads = cache.get(sql);
  if (!reads) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    reads = analyze(sql);
    cache.set(sql, reads);
  }
  return reads;
}
