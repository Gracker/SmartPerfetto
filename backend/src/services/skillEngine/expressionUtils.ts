// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Expression Utilities
 *
 * Shared helpers for extracting variable references from JS/condition expressions.
 * Used by skillValidator (load-time checks), skillExecutor (runtime evaluation),
 * and CLI validate command.
 */

/**
 * JavaScript built-in identifiers that should be ignored when extracting
 * user-defined variable references from condition expressions.
 */
export const JS_BUILTINS = new Set([
  // Literals & keywords
  'true', 'false', 'null', 'undefined',
  'if', 'else', 'return', 'function', 'var', 'let', 'const',
  'new', 'this', 'typeof', 'instanceof', 'in', 'of',
  'for', 'while', 'do', 'break', 'continue',
  'switch', 'case', 'default',
  'try', 'catch', 'finally', 'throw',
  'async', 'await', 'class', 'extends', 'super',
  'import', 'export', 'void', 'delete', 'yield',
  // Built-in globals
  'NaN', 'Infinity', 'Math', 'JSON', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Map', 'Set',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'console', 'window', 'globalThis',
]);

/**
 * Extract root variable names from a JS-like expression string.
 *
 * Examples:
 *   "performance_summary.data[0]?.app_jank_rate > 10" => ["performance_summary"]
 *   "jank_stats.data.find(j => j.jank_type)"          => ["jank_stats", "j"]
 *   "typeof foo !== 'undefined' && bar > 0"            => ["foo", "bar"]
 *
 * Variables that appear after a `.` (property access) are filtered out.
 * JS keywords and built-in globals are excluded via {@link JS_BUILTINS}.
 */
export function extractRootVariables(expr: string): string[] {
  return Array.from(new Set(rootIdentifierOccurrences(expr).map(occurrence => occurrence.name)));
}

export interface RootIdentifierOccurrence {
  name: string;
  /** Offset just past the identifier in {@link blankStringLiterals}(expr). */
  end: number;
}

/**
 * Every root identifier occurrence in an expression, in order: names that are
 * not property accesses, keywords or {@link JS_BUILTINS}. String literals are
 * blanked first so identifiers inside quotes are not reported.
 */
export function rootIdentifierOccurrences(expr: string): RootIdentifierOccurrence[] {
  const stripped = blankStringLiterals(expr);
  const occurrences: RootIdentifierOccurrence[] = [];
  const identifierRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;

  let match;
  while ((match = identifierRegex.exec(stripped)) !== null) {
    const name = match[1];
    if (JS_BUILTINS.has(name)) continue;
    // Preceded by `.`: a property access, not a root variable
    if (/\.\s*$/.test(stripped.substring(0, match.index))) continue;
    occurrences.push({name, end: match.index + name.length});
  }

  return occurrences;
}

/**
 * Replaces each quoted string literal (escapes included) with `""`,
 * e.g. status === 'it\'s' → status === "".
 */
export function blankStringLiterals(expr: string): string {
  return expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * The root identifier occurrences an expression reads from its scope: those of
 * {@link rootIdentifierOccurrences} that are neither parameters of an
 * enclosing arrow function nor destructuring keys. A parameter binds from its
 * parameter list to the end of the arrow body; a destructuring default
 * (`({v = other.data[0]}) => ...`) is a read, not a binding.
 * `rows.data.find(({dur_ms}) => dur_ms > 0) && other.data` reads `rows` and
 * `other`, never `dur_ms`.
 */
export function freeRootOccurrences(expr: string): RootIdentifierOccurrence[] {
  const blanked = blankStringLiterals(expr);
  const scopes: Array<{params: Set<string>; start: number; end: number}> = [];
  const keyEnds = new Set<number>();
  for (const arrow of blanked.matchAll(/=>/g)) {
    const params = arrowParameters(blanked, arrow.index);
    if (!params) continue;
    scopes.push({params: params.bindings, start: params.start, end: arrowBodyEnd(blanked, arrow.index + 2)});
    params.keyEnds.forEach(end => keyEnds.add(end));
  }
  return rootIdentifierOccurrences(expr).filter(({name, end}) => !keyEnds.has(end) && !scopes.some(scope =>
    scope.params.has(name) && scope.start <= end - name.length && end <= scope.end));
}

/** The parameters of the arrow whose `=>` is at `arrow`: a balanced `(...)` list or one identifier. */
function arrowParameters(
  text: string,
  arrow: number,
): {bindings: Set<string>; keyEnds: Set<number>; start: number} | undefined {
  let close = arrow - 1;
  while (close >= 0 && /\s/.test(text[close])) close--;
  if (text[close] === ')') {
    let depth = 0;
    for (let open = close; open >= 0; open--) {
      if (text[open] === ')') depth++;
      else if (text[open] === '(' && --depth === 0) {
        return {...parameterBindings(text.slice(open + 1, close), open + 1), start: open};
      }
    }
    return undefined;
  }
  const name = text.slice(0, close + 1).match(/[a-zA-Z_][a-zA-Z0-9_]*$/)?.[0];
  return name ? {bindings: new Set([name]), keyEnds: new Set(), start: close + 1 - name.length} : undefined;
}

/**
 * The names a parenthesized parameter list binds, and the end offsets (from
 * `offset`) of its destructuring keys. A key (`column:`) binds nothing; a
 * computed key (`[expr]:`) and a default value expression are skipped, so
 * their reads stay free; `...rest` binds `rest`.
 */
function parameterBindings(list: string, offset: number): {bindings: Set<string>; keyEnds: Set<number>} {
  const bindings = new Set<string>();
  const keyEnds = new Set<number>();
  const identifier = /[a-zA-Z_][a-zA-Z0-9_]*/y;
  const brackets: string[] = [];
  // While >= 0, a default value or computed key is being skipped; it ends when
  // the bracket depth falls below this or, for a default, at a comma on it.
  let skipDepth = -1;
  let skippingDefault = false;
  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if ('([{'.includes(char)) {
      const before = list.slice(0, i).trimEnd().slice(-1);
      if (skipDepth < 0 && char === '[' && brackets[brackets.length - 1] === '{' && (before === '{' || before === ',')) {
        skipDepth = brackets.length + 1;
        skippingDefault = false;
      }
      brackets.push(char);
    } else if (')]}'.includes(char)) {
      brackets.pop();
      if (skipDepth >= 0 && brackets.length < skipDepth) skipDepth = -1;
    } else if (skipDepth >= 0) {
      if (skippingDefault && char === ',' && brackets.length === skipDepth) skipDepth = -1;
    } else if (char === '=') {
      skipDepth = brackets.length;
      skippingDefault = true;
    } else {
      identifier.lastIndex = i;
      const name = identifier.exec(list)?.[0];
      const before = list.slice(0, i);
      if (!name || /[\w$]$/.test(before) || (/\.$/.test(before) && !/\.\.\.$/.test(before))) continue;
      const end = i + name.length;
      if (/^\s*:/.test(list.slice(end))) keyEnds.add(offset + end);
      else bindings.add(name);
      i = end - 1;
    }
  }
  return {bindings, keyEnds};
}

/**
 * Offset where an arrow body starting at `from` ends: an unmatched closing
 * bracket, a top-level comma, or the `:` of a ternary the body did not open.
 */
function arrowBodyEnd(text: string, from: number): number {
  let depth = 0;
  let openTernaries = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && char === ',') {
      return i;
    } else if (depth === 0 && char === '?') {
      if (text[i + 1] === '?') i++; // `??`
      else if (text[i + 1] !== '.') openTernaries++; // not `?.`
    } else if (depth === 0 && char === ':') {
      if (openTernaries === 0) return i;
      openTernaries--;
    }
  }
  return text.length;
}

// =============================================================================
// Diagnostic evidence fields
// =============================================================================

type EvidenceLiteral = string | number | boolean | null;
type EvidenceOperator = '===' | '!==' | '==' | '!=' | '>=' | '<=' | '>' | '<';

export type EvidenceAccess =
  | {kind: 'property'; name: string}
  | {kind: 'index'; index: number}
  | {kind: 'find' | 'filter'; column: string; operator: EvidenceOperator; literal: EvidenceLiteral};

/** A parsed evidence field: `root.data` followed by read-only accesses. */
export interface EvidenceFieldPath {
  root: string;
  accesses: EvidenceAccess[];
}

const IDENT = '[a-zA-Z_][a-zA-Z0-9_]*';
const LITERAL = `-?\\d+(?:\\.\\d+)?|'[^'\\\\]*'|"[^"\\\\]*"|true|false|null`;
const EVIDENCE_ROOT = new RegExp(`^\\s*(${IDENT})\\s*\\??\\.\\s*data(?![\\w$])`);
const EVIDENCE_PREDICATE = new RegExp(
  `^\\??\\.\\s*(find|filter)\\s*\\(\\s*(${IDENT})\\s*=>\\s*\\2\\s*\\.\\s*(${IDENT})\\s*`
  + `(===|!==|==|!=|>=|<=|>|<)\\s*(${LITERAL})\\s*\\)`);
const EVIDENCE_INDEX = /^(?:\?\.)?\[\s*(\d+)\s*\]/;
const EVIDENCE_PROPERTY = new RegExp(`^\\??\\.\\s*(${IDENT})(?![\\w$])`);
/** Inherited members a property access must never reach. */
const EVIDENCE_FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses a diagnostic `evidence_fields` entry. The grammar is the read-only
 * part of the condition dialect the Skills use: `name.data` (or `name?.data`)
 * followed by `.column`, `[n]`, `.length` and `.find(r => r.column OP literal)`
 * / `.filter(...)`, each optionally with `?.`. Anything else, including a call
 * or an assignment, is not an evidence field.
 */
export function parseEvidenceField(field: string): EvidenceFieldPath | undefined {
  const root = field.match(EVIDENCE_ROOT);
  if (!root) return undefined;
  const accesses: EvidenceAccess[] = [];
  let rest = field.slice(root[0].length).trim();
  while (rest) {
    let match: RegExpMatchArray | null;
    if ((match = rest.match(EVIDENCE_PREDICATE))) {
      if (EVIDENCE_FORBIDDEN_PROPERTIES.has(match[3])) return undefined;
      accesses.push({kind: match[1] as 'find' | 'filter', column: match[3],
        operator: match[4] as EvidenceOperator, literal: parseEvidenceLiteral(match[5])});
    } else if ((match = rest.match(EVIDENCE_INDEX))) {
      accesses.push({kind: 'index', index: Number(match[1])});
    } else if ((match = rest.match(EVIDENCE_PROPERTY)) && !EVIDENCE_FORBIDDEN_PROPERTIES.has(match[1])) {
      accesses.push({kind: 'property', name: match[1]});
    } else {
      return undefined;
    }
    rest = rest.slice(match[0].length).trim();
  }
  return {root: root[1], accesses};
}

function parseEvidenceLiteral(text: string): EvidenceLiteral {
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === 'null') return null;
  if (text.startsWith("'") || text.startsWith('"')) return text.slice(1, -1);
  return Number(text);
}

/**
 * Reads an evidence field from `data`, the value `root.data` holds. It walks
 * plain data only: every read is an own data property (no getter, nothing
 * inherited, no function value), `find`/`filter` iterate the rows by index
 * instead of calling the array's methods, and a predicate compares scalars
 * only, so no conversion runs. Every access is null-safe.
 */
export function readEvidenceField(path: EvidenceFieldPath, data: unknown): unknown {
  let value = data;
  for (const access of path.accesses) {
    if (value === null || value === undefined) return undefined;
    switch (access.kind) {
      case 'index':
        value = Array.isArray(value) ? ownDataValue(value, String(access.index)) : undefined;
        break;
      case 'property':
        value = typeof value === 'string' && access.name === 'length'
          ? value.length
          : ownDataValue(value, access.name);
        break;
      default: {
        if (!Array.isArray(value)) return undefined;
        const rows: unknown[] = [];
        for (let index = 0; index < value.length && !(access.kind === 'find' && rows.length > 0); index++) {
          const row = ownDataValue(value, String(index));
          if (matchesEvidencePredicate(ownDataValue(row, access.column), access.operator, access.literal)) rows.push(row);
        }
        value = access.kind === 'find' ? rows[0] : rows;
      }
    }
  }
  return value;
}

/** An own data property that is not a function; undefined otherwise. Never runs a getter. */
export function ownDataValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value !== 'function' ? descriptor.value : undefined;
}

/** Compares a scalar column with the literal; an object, array or missing value never matches. */
function matchesEvidencePredicate(left: unknown, operator: EvidenceOperator, right: EvidenceLiteral): boolean {
  if (left !== null && typeof left === 'object') return false;
  if (left === undefined || typeof left === 'function' || typeof left === 'symbol') return false;
  const l = left as string | number | boolean | bigint | null;
  const r = right as any;
  switch (operator) {
    case '===': return l === right;
    case '!==': return l !== right;
    case '==': return l == right;
    case '!=': return l != right;
    case '>=': return (l as any) >= r;
    case '<=': return (l as any) <= r;
    case '>': return (l as any) > r;
    case '<': return (l as any) < r;
  }
}
