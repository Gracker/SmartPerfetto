// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Skill SQL as the structural readers see it: the tokens placeholder binding
// reads (sqlTemplate.ts), with each qualified name as one token. The scanner
// cuts a quoted part out of a name, so `"p"."name"`, `p."name"` and `[p].name`
// arrive as two or three tokens; joined, each reads `P.NAME` like `p.name`.

import {skillSqlTokens, type SqlToken} from './sqlTemplate';

/** A name: a word or quoted identifier, not a code placeholder (an empty word). */
export const isNameToken = (token: SqlToken | undefined): token is SqlToken =>
  token !== undefined && (token.kind === 'word' || token.kind === 'identifier') && token.text !== '';

/** Words that open a query when they follow `(`: a subquery or a CTE body. */
export const QUERY_START: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES']);

/** Index-based matchers over `tokens`: `word(i, 'AS')`, `punct(i, '(')`. */
export function tokenMatchers(tokens: readonly SqlToken[]) {
  const is = (index: number, kind: SqlToken['kind'], text: string) => tokens[index]?.kind === kind && tokens[index].text === text;
  return {
    word: (index: number, text: string) => is(index, 'word', text),
    punct: (index: number, text: string) => is(index, 'punct', text),
  };
}

const cache = new Map<string, readonly SqlToken[]>();
const CACHE_LIMIT = 2048;

/**
 * The tokens of `sql` with every dot-joined run of names merged into one name
 * token (upper-cased like the rest: `P.NAME`). A merged token is a `word` when
 * every part was, an `identifier` when some part was quoted; either way it
 * holds a dot, so it never reads as a keyword.
 */
export function structuralSqlTokens(sql: string, options: {cache?: boolean} = {}): readonly SqlToken[] {
  const keep = options.cache !== false;
  let tokens = cache.get(sql);
  if (!tokens) {
    const merged: SqlToken[] = [];
    for (const token of skillSqlTokens(sql, {cache: keep})) {
      const last = merged[merged.length - 1];
      if (isNameToken(last) && isNameToken(token) && (last.text.endsWith('.') || token.text.startsWith('.'))) {
        merged[merged.length - 1] = {
          kind: last.kind === 'word' && token.kind === 'word' ? 'word' : 'identifier',
          text: last.text + token.text,
          written: (last.written ?? '') + (token.written ?? ''),
        };
      } else {
        merged.push(token);
      }
    }
    tokens = merged;
    if (keep) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(sql, tokens);
    }
  }
  return tokens;
}

/** The last segment of a (possibly qualified) name token, lower-cased: `MAIN.PROCESS` -> `process`. */
export const unqualifiedName = (token: SqlToken): string => token.text.toLowerCase().split('.').pop()!;

/** The qualifier of a name token, lower-cased, or '' when it has none: `P.NAME` -> `p`. */
export function nameQualifier(token: SqlToken): string {
  const parts = token.text.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

const isPunct = (token: SqlToken | undefined, text: string) => token?.kind === 'punct' && token.text === text;

/** The index of the `)` closing the `(` at `open`, or the last index when it is never closed. */
export function closingParen(tokens: readonly SqlToken[], open: number): number {
  for (let depth = 0, at = open; at < tokens.length; at++) {
    if (isPunct(tokens[at], '(')) depth++;
    else if (isPunct(tokens[at], ')') && --depth === 0) return at;
  }
  return tokens.length - 1;
}

/** The index of the `(` opening the `)` at `close`, or 0 when it is never opened. */
function openingParen(tokens: readonly SqlToken[], close: number): number {
  for (let depth = 0, at = close; at >= 0; at--) {
    if (isPunct(tokens[at], ')')) depth++;
    else if (isPunct(tokens[at], '(') && --depth === 0) return at;
  }
  return 0;
}

/** A value token: a name, a literal or a placeholder (a code placeholder is an empty word). */
const isValue = (token: SqlToken | undefined) =>
  token !== undefined && (token.kind === 'word' || token.kind === 'identifier' || token.kind === 'string');

/** Arithmetic and concatenation, which bind tighter than a comparison: `p.name || ':' = 'x'`. */
const BINARY_OPERATORS = new Set(['||', '+', '-', '*', '/', '%']);

/** The span of one term (a value, a parenthesized expression, or a call) ending at `end`. */
function termEndingAt(tokens: readonly SqlToken[], end: number): [number, number] | undefined {
  let last = end;
  if (tokens[last - 1]?.kind === 'word' && tokens[last - 1].text === 'COLLATE') last -= 2;
  const token = tokens[last];
  if (isPunct(token, ')')) {
    const open = openingParen(tokens, last);
    return [isNameToken(tokens[open - 1]) ? open - 1 : open, end];
  }
  return isValue(token) ? [last, end] : undefined;
}

/** The span of one term starting at `start`. */
function termStartingAt(tokens: readonly SqlToken[], start: number): [number, number] | undefined {
  const token = tokens[start];
  if (isPunct(token, '(')) return [start, closingParen(tokens, start)];
  if (!isValue(token)) return undefined;
  let end = isPunct(tokens[start + 1], '(') ? closingParen(tokens, start + 1) : start;
  if (tokens[end + 1]?.kind === 'word' && tokens[end + 1].text === 'COLLATE' && isNameToken(tokens[end + 2])) end += 2;
  return [start, end];
}

/**
 * The span [start, end] of the comparison operand that ends at `end`: terms
 * (values, parenthesized expressions, calls such as `LOWER(p.name)` or
 * `CAST(p.name AS TEXT)`, each through a `COLLATE <name>`) joined by
 * arithmetic or concatenation.
 */
export function operandEndingAt(tokens: readonly SqlToken[], end: number): [number, number] | undefined {
  let span = termEndingAt(tokens, end);
  while (span && tokens[span[0] - 1]?.kind === 'punct' && BINARY_OPERATORS.has(tokens[span[0] - 1].text)) {
    const previous = termEndingAt(tokens, span[0] - 2);
    if (!previous) break;
    span = [previous[0], span[1]];
  }
  return span;
}

/** The span [start, end] of the comparison operand that starts at `start`. */
export function operandStartingAt(tokens: readonly SqlToken[], start: number): [number, number] | undefined {
  let span = termStartingAt(tokens, start);
  while (span && tokens[span[1] + 1]?.kind === 'punct' && BINARY_OPERATORS.has(tokens[span[1] + 1].text)) {
    const next = termStartingAt(tokens, span[1] + 2);
    if (!next) break;
    span = [span[0], next[1]];
  }
  return span;
}

/** A common table expression the name at `index` defines: `name [(columns)] AS [NOT] [MATERIALIZED] (body)`. */
export interface CteDefinition {
  /** The column list, lower-cased, when the CTE declares one. */
  columns?: string[];
  /** Indexes of the body's `(` and `)`. */
  bodyStart: number;
  bodyEnd: number;
}

export function cteDefinitionAt(tokens: readonly SqlToken[], index: number): CteDefinition | undefined {
  const {word, punct} = tokenMatchers(tokens);
  let at = index + 1;
  let columns: string[] | undefined;
  if (punct(at, '(')) {
    const close = closingParen(tokens, at);
    columns = tokens.slice(at + 1, close).filter(isNameToken).map(unqualifiedName);
    at = close + 1;
  }
  if (!word(at, 'AS')) return undefined;
  at++;
  if (word(at, 'NOT')) at++;
  if (word(at, 'MATERIALIZED')) at++;
  return punct(at, '(') ? {columns, bodyStart: at, bodyEnd: closingParen(tokens, at)} : undefined;
}

/** Keywords a projection term never ends with as an alias: an ordering, a CASE end, a literal value. */
const NON_ALIAS_WORDS: ReadonlySet<string> = new Set(['ASC', 'DESC', 'END', 'NULL', 'TRUE', 'FALSE']);
/** A plain or once-qualified column name as written. */
const COLUMN_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_$]*)$/;
/** An alias name as written. */
const ALIAS_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * The result column names of SQL, as written, when its first query's
 * projection names them: each term's `AS` alias, a bare column (`ts`,
 * `s.dur`), or a trailing bare alias (`COUNT(*) cnt`). A term that names no
 * column (`*`, `COUNT(*)`, a CASE without an alias) has none. The first query
 * is the first `SELECT` outside parentheses, so a WITH query's main SELECT,
 * not a CTE body; its projection runs to the first FROM outside parentheses.
 */
export function sqlResultColumns(sql: string): string[] {
  const tokens = structuralSqlTokens(sql);
  const {word, punct} = tokenMatchers(tokens);
  let depth = 0;
  let select = -1;
  let end = tokens.length;
  for (let at = 0; at < tokens.length; at++) {
    if (punct(at, '(')) depth++;
    else if (punct(at, ')')) depth = Math.max(0, depth - 1);
    else if (depth === 0 && select < 0 && word(at, 'SELECT')) select = at;
    else if (depth === 0 && select >= 0 && word(at, 'FROM')) {
      end = at;
      break;
    }
  }
  if (select < 0) return [];
  const terms: SqlToken[][] = [[]];
  for (let at = select + 1, nesting = 0; at < end; at++) {
    if (punct(at, '(')) nesting++;
    else if (punct(at, ')')) nesting = Math.max(0, nesting - 1);
    if (nesting === 0 && punct(at, ',')) terms.push([]);
    else terms[terms.length - 1].push(tokens[at]);
  }
  const names = terms.map(term => {
    const last = term[term.length - 1];
    const written = isNameToken(last) ? last.written ?? '' : '';
    if (term.length >= 2 && term[term.length - 2].kind === 'word' && term[term.length - 2].text === 'AS'
      && isNameToken(last)) {
      return last.kind === 'identifier' || ALIAS_NAME.test(written) ? written : undefined;
    }
    if (term.length === 1) return COLUMN_NAME.exec(written)?.[1];
    return last?.kind === 'word' && ALIAS_NAME.test(written) && !NON_ALIAS_WORDS.has(last.text) ? written : undefined;
  });
  return [...new Set(names.filter((name): name is string => Boolean(name)))];
}

/**
 * Statements that write or change the connection, and the Perfetto functions
 * that define objects or run metric SQL (`RUN_METRIC(…)`, `CREATE_FUNCTION(…)`).
 */
const WRITING_WORDS: ReadonlySet<string> = new Set([
  'ALTER', 'ATTACH', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'INSERT', 'PRAGMA', 'REPLACE', 'UPDATE', 'VACUUM',
  'CREATE_FUNCTION', 'CREATE_VIEW_FUNCTION', 'RUN_METRIC',
]);

/**
 * Whether SQL only reads: after any leading `INCLUDE PERFETTO MODULE …;`
 * statements it is a query (SELECT or WITH), and no writing keyword appears
 * in its code (comments and string literals are not code). Conservative: a
 * writing keyword used as a bare name (a column called `pragma`) still reads
 * as the statement.
 */
export function sqlIsReadOnly(sql: string): boolean {
  const tokens = structuralSqlTokens(sql);
  const {word, punct} = tokenMatchers(tokens);
  let at = 0;
  while (word(at, 'INCLUDE') && word(at + 1, 'PERFETTO') && word(at + 2, 'MODULE')) {
    at += 3;
    while (at < tokens.length && !punct(at, ';')) at++;
    at++;
  }
  if (!word(at, 'SELECT') && !word(at, 'WITH')) return false;
  // `replace(…)` is the string function: the REPLACE statement and conflict
  // clause never put `(` after the word, while other writing words may
  // (`ATTACH ('x.db') AS y`), so the call form clears REPLACE alone.
  return !tokens.some((token, index) => token.kind === 'word' && WRITING_WORDS.has(token.text)
    && !(token.text === 'REPLACE' && punct(index + 1, '(')));
}
