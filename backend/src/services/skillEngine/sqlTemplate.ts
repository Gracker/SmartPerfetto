// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The one reader of `${path|default}` placeholders in Skill SQL and fragments,
// and the rules that keep a bound value data rather than SQL. A value is
// written where its placeholder sits, so the scanner tokenizes the SQL once and
// tells each binder that place: SQL code, a single-quoted literal (and whether
// that literal is the whole pattern of GLOB or LIKE), a comment, or a quoted
// identifier. Perfetto-Skills' render_sql_template applies the same rules.

import {SKILL_PLACEHOLDER} from './expressionUtils';

/** Where a placeholder sits in SQL text. */
type SqlPlaceholderContext = 'code' | 'string' | 'comment' | 'identifier';

/**
 * A string literal that is the whole pattern operand of GLOB or LIKE: the text
 * bound into it must match itself, not act as wildcards.
 */
export interface SqlPatternLiteral {
  operator: 'glob' | 'like';
  /** The LIKE `ESCAPE` character, when the clause names exactly one. */
  escape?: string;
}

/** One `${path}` or `${path|default}` placeholder found in SQL. */
export interface SqlPlaceholder {
  /** The whole token, e.g. `${max_rows|50}`. */
  match: string;
  path: string;
  /** The text after `|`, when the placeholder declares one. */
  defaultValue?: string;
  /** Code or a string literal; comment placeholders are never bound. */
  context: 'code' | 'string';
  /** Set when the enclosing literal is the whole GLOB/LIKE pattern. */
  pattern?: SqlPatternLiteral;
}

/**
 * One token of Skill SQL. A placeholder in code is a `word` with empty text;
 * one inside a literal sets `bound` and is not part of `text`.
 */
export interface SqlToken {
  kind: 'word' | 'identifier' | 'string' | 'punct';
  /** Upper-cased word or quoted name, the punctuation, or the decoded literal text. */
  text: string;
  /** This string literal is the whole GLOB/LIKE pattern. */
  pattern?: SqlPatternLiteral;
  /** Inside a GLOB/LIKE/REGEXP/MATCH operand, but not as its only string literal. */
  inPatternExpression?: boolean;
  /** A string literal with a placeholder in it. */
  bound?: boolean;
}
type Token = SqlToken;

interface ScannedPlaceholder {
  start: number;
  match: string;
  context: SqlPlaceholderContext;
  /** The code token or string literal holding the placeholder. */
  token?: Token;
  /** In a string literal: the author's text before the placeholder. */
  literalPrefix?: string;
}

const PATTERN_OPERATORS = new Set(['GLOB', 'LIKE', 'REGEXP', 'MATCH']);
// Words that end an operand at its own nesting depth.
const OPERAND_END_WORDS = new Set([
  'AND', 'OR', 'NOT', 'IS', 'IN', 'BETWEEN', 'ESCAPE', 'THEN', 'WHEN', 'ELSE', 'END',
  'FROM', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT',
  'AS', 'ON', 'JOIN',
]);
const COMPARISON = /^[=<>!]+$/;
const WORD_AT = /(?:[\w.]|\$(?!\{))+/y;
const OPERATOR_AT = /[=<>!]+|\|+|[^]/y;
// SQLite's identifier quotes and the character that closes each.
const IDENTIFIER_CLOSE: Record<string, string> = {'"': '"', '`': '`', '[': ']'};

/** The path and optional `|default` written inside `${...}`. */
export function readPlaceholderBody(body: string): {path: string; defaultValue?: string} {
  const raw = body.trim();
  const pipe = raw.indexOf('|');
  return pipe >= 0 ? {path: raw.slice(0, pipe).trim(), defaultValue: raw.slice(pipe + 1).trim()} : {path: raw};
}

// Skill SQL and fragments are a fixed set of texts, each substituted on every
// run; the scan depends only on the text.
const scanCache = new Map<string, {placeholders: ScannedPlaceholder[]; tokens: Token[]}>();
const SCAN_CACHE_LIMIT = 1024;

/**
 * Every placeholder in `sql` with where it sits. Placeholders are opaque: a
 * quote or comment marker inside `${...}` (a `|'x'` default) is not SQL.
 */
function scanSqlPlaceholders(sql: string): ScannedPlaceholder[] {
  return scanSql(sql).placeholders;
}

/**
 * Skill SQL as tokens, comments dropped, each GLOB/LIKE pattern literal marked
 * (`pattern`): the scan placeholder binding reads, for readers that need the
 * SQL structure. Callers must not modify the tokens.
 */
export function skillSqlTokens(sql: string, options: {cache?: boolean} = {}): readonly SqlToken[] {
  return scanSql(sql, options.cache !== false).tokens;
}

/** The scan of `sql`, kept by text when `cache` (Skill SQL is a fixed set of texts). */
function scanSql(sql: string, cache = true): {placeholders: ScannedPlaceholder[]; tokens: Token[]} {
  const cached = scanCache.get(sql);
  if (cached) return cached;
  const at = new Map<number, string>();
  for (const m of sql.matchAll(SKILL_PLACEHOLDER)) at.set(m.index, m[0]);
  const placeholders: ScannedPlaceholder[] = [];
  const tokens: Token[] = [];
  const record = (i: number, context: SqlPlaceholderContext, token?: Token): number => {
    const match = at.get(i)!;
    if (context === 'string' && token) {
      token.bound = true;
      placeholders.push({start: i, match, context, token, literalPrefix: token.text});
    } else {
      placeholders.push({start: i, match, context, token});
    }
    return i + match.length;
  };
  // Scan a quoted span from just after its opening quote; returns the index past
  // the close. A doubled close quote is one quote, except in `[...]`.
  const quoted = (i: number, quote: string, context: SqlPlaceholderContext, token?: Token): number => {
    while (i < sql.length) {
      if (at.has(i)) { i = record(i, context, token); continue; }
      if (sql[i] === quote) {
        if (quote === ']' || sql[i + 1] !== quote) return i + 1;
        if (token) token.text += quote;
        i += 2;
        continue;
      }
      if (token) token.text += sql[i];
      i++;
    }
    return i;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (at.has(i)) {
      const token: Token = {kind: 'word', text: ''};
      tokens.push(token);
      i = record(i, 'code', token);
    } else if (/\s/.test(ch)) {
      i++;
    } else if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      const close = ch === '-' ? '\n' : '*/';
      const found = sql.indexOf(close, i + 2);
      const end = found < 0 ? sql.length : found + close.length;
      for (i += 2; i < end;) i = at.has(i) ? record(i, 'comment') : i + 1;
    } else if (ch === "'") {
      const token: Token = {kind: 'string', text: ''};
      tokens.push(token);
      i = quoted(i + 1, "'", 'string', token);
    } else if (ch in IDENTIFIER_CLOSE) {
      // A quoted name is never a keyword, but `"glob"(...)` still calls GLOB.
      const token: Token = {kind: 'identifier', text: ''};
      tokens.push(token);
      i = quoted(i + 1, IDENTIFIER_CLOSE[ch], 'identifier', token);
      token.text = token.text.toUpperCase();
    } else {
      WORD_AT.lastIndex = i;
      const word = WORD_AT.exec(sql)?.[0];
      OPERATOR_AT.lastIndex = i;
      const text = word ?? OPERATOR_AT.exec(sql)![0];
      tokens.push(word ? {kind: 'word', text: word.toUpperCase()} : {kind: 'punct', text});
      i += text.length;
    }
  }
  markPatternOperands(tokens);
  const scanned = {placeholders, tokens};
  if (cache) {
    if (scanCache.size >= SCAN_CACHE_LIMIT) scanCache.clear();
    scanCache.set(sql, scanned);
  }
  return scanned;
}

const isPunct = (token: Token | undefined, text: string) => token?.kind === 'punct' && token.text === text;
const isWord = (token: Token | undefined, text: string) => token?.kind === 'word' && token.text === text;

/** The index just past the expression that starts at `start`: CASE ... END nests like parentheses. */
function operandEnd(tokens: Token[], start: number): number {
  let end = start;
  for (let depth = 0; end < tokens.length; end++) {
    const t = tokens[end];
    if (isPunct(t, '(') || isWord(t, 'CASE')) depth++;
    else if (isPunct(t, ')') || isWord(t, 'END')) { if (depth-- === 0) break; }
    else if (depth === 0 && t.kind === 'punct' && (t.text === ',' || t.text === ';' || COMPARISON.test(t.text))) break;
    else if (depth === 0 && t.kind === 'word' && OPERAND_END_WORDS.has(t.text)) break;
  }
  return end;
}

/** The one token `first..last` amounts to, through wrapping parentheses and postfix COLLATE. */
function soleToken(tokens: Token[], first: number, last: number): Token | undefined {
  for (;;) {
    if (last - first >= 2 && isWord(tokens[last - 1], 'COLLATE')) last -= 2;
    else if (last > first && isPunct(tokens[first], '(') && isPunct(tokens[last], ')') && closes(tokens, first, last)) {
      first++;
      last--;
    } else {
      return first === last ? tokens[first] : undefined;
    }
  }
}

/**
 * Tag the tokens of each GLOB/LIKE/REGEXP/MATCH right operand. Only a string
 * literal that is the whole GLOB/LIKE pattern, with no ESCAPE or a fixed
 * one-character ESCAPE literal, can take a value; anything else in the
 * operand or the ESCAPE clause is a pattern expression.
 */
function markPatternOperands(tokens: Token[]): void {
  tokens.forEach((token, k) => {
    const operator = PATTERN_OPERATORS.has(token.text)
      && (token.kind === 'word' || (token.kind === 'identifier' && isPunct(tokens[k + 1], '(')));
    if (!operator) return;
    const end = operandEnd(tokens, k + 1);
    let escape: string | undefined;
    let escapeFixed = true;
    if (isWord(tokens[end], 'ESCAPE')) {
      const escapeEnd = operandEnd(tokens, end + 1);
      const literal = soleToken(tokens, end + 1, escapeEnd - 1);
      escapeFixed = token.text === 'LIKE' && literal?.kind === 'string' && !literal.bound && [...literal.text].length === 1;
      if (escapeFixed) escape = literal!.text;
      for (let t = end + 1; t < escapeEnd; t++) tokens[t].inPatternExpression = true;
    }
    const pattern = soleToken(tokens, k + 1, end - 1);
    if (escapeFixed && pattern?.kind === 'string' && (token.text === 'GLOB' || token.text === 'LIKE')) {
      pattern.pattern = token.text === 'GLOB' ? {operator: 'glob'} : {operator: 'like', ...(escape ? {escape} : {})};
    } else {
      for (let t = k + 1; t < end; t++) tokens[t].inPatternExpression = true;
    }
  });
}

/** Whether a GLOB pattern's author text leaves the next character inside a `[...]` class. */
function insideGlobClass(text: string): boolean {
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (open < 0) {
      if (text[i] === '[') open = i;
    } else if (text[i] === ']' && i > open + (text[open + 1] === '^' ? 2 : 1)) {
      open = -1;
    }
  }
  return open >= 0;
}

/** Whether `text` ends in an odd run of `escape`, which escapes the next character. */
function endsEscaping(text: string, escape: string): boolean {
  let run = 0;
  for (const ch of [...text].reverse()) {
    if (ch !== escape) break;
    run++;
  }
  return run % 2 === 1;
}

/** Whether the `(` at `open` is closed by the `)` at `close`. */
function closes(tokens: Token[], open: number, close: number): boolean {
  let depth = 0;
  for (let t = open; t <= close; t++) {
    if (isPunct(tokens[t], '(')) depth++;
    else if (isPunct(tokens[t], ')') && --depth === 0) return t === close;
  }
  return false;
}

/**
 * The placeholders SQL would bind, comments excluded. A static read: unlike
 * substitution, it does not refuse a placeholder no escaping can bind.
 */
export function boundSqlPlaceholders(sql: string): Array<{match: string; path: string; defaultValue?: string}> {
  return scanSqlPlaceholders(sql)
    .filter(p => p.context !== 'comment')
    .map(p => ({match: p.match, ...readPlaceholderBody(p.match.slice(2, -1))}));
}

/** The paths of the placeholders SQL would bind, comments excluded. */
export function boundSqlPlaceholderPaths(sql: string): string[] {
  return boundSqlPlaceholders(sql).map(p => p.path);
}

/**
 * SQL text for a placeholder whose value is absent: its `|default` (author text,
 * inserted as written), else '' inside a string literal and NULL in code.
 */
export function absentPlaceholderSql(placeholder: SqlPlaceholder): string {
  if (placeholder.defaultValue !== undefined) return placeholder.defaultValue;
  return placeholder.context === 'string' ? '' : 'NULL';
}

/**
 * The one placeholder substitution for Skill SQL and fragments. Placeholders
 * in comments stay as written; one inside a quoted identifier, or inside a
 * pattern expression other than as its only string literal, is refused,
 * because no escaping keeps a value data there. Every other placeholder is
 * handed to `resolve`, which returns its SQL text or throws.
 */
export function substituteSqlPlaceholders(sql: string, resolve: (placeholder: SqlPlaceholder) => string): string {
  let out = '';
  let from = 0;
  for (const scanned of scanSqlPlaceholders(sql)) {
    if (scanned.context === 'comment') continue;
    if (scanned.context === 'identifier') {
      throw new Error(`SQL placeholder ${scanned.match} cannot be bound inside a quoted identifier`);
    }
    if (scanned.token?.inPatternExpression) {
      throw new Error(`SQL placeholder ${scanned.match} is part of a GLOB/LIKE/REGEXP/MATCH pattern expression; `
        + `bind it as the pattern's only string literal, or compare with instr()`);
    }
    const pattern = scanned.token?.pattern;
    const prefix = scanned.literalPrefix ?? '';
    if (pattern?.operator === 'glob' && insideGlobClass(prefix)) {
      throw new Error(`SQL placeholder ${scanned.match} sits inside a GLOB character class`);
    }
    if (pattern?.escape && endsEscaping(prefix, pattern.escape)) {
      throw new Error(`SQL placeholder ${scanned.match} follows the pattern's ESCAPE character`);
    }
    let text = resolve({
      match: scanned.match,
      ...readPlaceholderBody(scanned.match.slice(2, -1)),
      context: scanned.context,
      ...(pattern ? {pattern: {...pattern}} : {}),
    });
    // `1-${v}` with v = -1 must not become the comment `1--1`.
    if (scanned.context === 'code' && text.startsWith('-')) text = ` ${text}`;
    out += sql.slice(from, scanned.start) + text;
    from = scanned.start + scanned.match.length;
  }
  return out + sql.slice(from);
}

/**
 * A value as literal GLOB text. Names can contain `*`, `?` and `[`
 * (`pool[1]-thread`), which would otherwise stop matching themselves or match
 * everything. GLOB has no escape character, so a one-character class is the
 * escape: `*` becomes `[*]`. Each character is mapped once, so a bracket the mapping adds
 * is not mapped again.
 */
export function globEscape(value: string): string {
  return value.replace(/[*?[]/g, ch => `[${ch}]`);
}

/**
 * The text of a value bound inside a single-quoted literal: quotes doubled,
 * and in a pattern literal the value's own wildcards made to match themselves
 * (see globEscape). LIKE without an ESCAPE clause cannot escape, so `%` or `_` is refused.
 */
export function sqlStringLiteralText(value: unknown, placeholder: SqlPlaceholder): string {
  let text = String(value);
  const pattern = placeholder.pattern;
  if (pattern?.operator === 'glob') {
    text = globEscape(text);
  } else if (pattern?.operator === 'like') {
    const escape = pattern.escape;
    if (escape) {
      text = [...text].map(ch => (ch === '%' || ch === '_' || ch === escape ? escape + ch : ch)).join('');
    } else if (/[%_]/.test(text)) {
      throw new Error(`SQL placeholder ${placeholder.match} binds a LIKE pattern without ESCAPE; `
        + `its value cannot contain % or _`);
    }
  }
  return text.replace(/'/g, "''");
}

const SQL_NUMBER = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const SQL_STRING = String.raw`'(?:[^']|'')*'`;
const SQL_LITERAL_LIST = new RegExp(
  String.raw`^\s*(?:${SQL_NUMBER}|${SQL_STRING})(?:\s*,\s*(?:${SQL_NUMBER}|${SQL_STRING}))*\s*$`,
);

/**
 * A scalar written as SQL. A string is a single-quoted literal; a value that
 * is not finite has no SQL form.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL values cannot be NaN or infinite');
    return String(value);
  }
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A SQL identifier, double-quoted so a column name cannot end it. */
export function sqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The text of a scalar bound outside any literal, where it is SQL code: a
 * finite number, a boolean, or a string that is already a number or a comma
 * list of number and single-quoted string literals (list inputs such as
 * `cpu_ids` and `slice_names`). Anything else would be SQL chosen by whoever
 * supplied the value.
 */
export function sqlCodeText(value: unknown, placeholder: SqlPlaceholder): string {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return sqlLiteral(value);
  if (typeof value === 'string' && SQL_LITERAL_LIST.test(value)) return value;
  throw new Error(`SQL placeholder ${placeholder.match} sits outside a string literal; `
    + `its value must be a number or a list of SQL literals`);
}
