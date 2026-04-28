// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Auto-injects `INCLUDE PERFETTO MODULE ...;` for stdlib tables/functions
 * referenced in raw SQL submitted via the `execute_sql` / `execute_sql_on`
 * MCP tools.
 *
 * Background: 9d313df (4/1) shrank `CRITICAL_STDLIB_MODULES` from 22 to 3 to
 * fix socket hang ups on large traces; the commit promised that
 * `execute_sql` would auto-inject critical INCLUDEs, but that piece was
 * never implemented. Skill SQL has its own `buildSqlWithModuleIncludes`
 * (skillExecutor.ts:1187); this module is the equivalent for raw SQL.
 *
 * Source of truth: the Perfetto stdlib `.sql` source files
 * (`perfetto/src/trace_processor/perfetto_sql/stdlib/**`). We do NOT use
 * `perfettoSqlIndex.json` because its `sql` field is truncated and parsing
 * it would silently miss core tables like `android_frames` /
 * `android_startups`.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  STDLIB_PATH,
  STDLIB_PRELUDE_DIR,
  walkStdlibSqlFiles,
} from '../services/perfettoStdlibScanner';

export interface InjectionResult {
  /** Final SQL with any required INCLUDE statements prepended (alphabetical, deterministic). */
  sql: string;
  /** Modules that were auto-injected for this query (empty if no injection happened). */
  injected: string[];
}

interface SymbolIndex {
  /** lower-case stdlib symbol name to module path (e.g. `slice_self_dur` -> `slices.self_dur`) */
  tableToModule: Map<string, string>;
  /** lower-case prelude/built-in symbols that are always available without INCLUDE */
  builtins: Set<string>;
}

let cachedIndex: SymbolIndex | null = null;

// Match a stdlib symbol declaration: `CREATE [OR REPLACE] PERFETTO
// (TABLE|VIEW|FUNCTION|MACRO) <name>`. Anchored at the start of a line
// (after optional whitespace) and requires the `PERFETTO` keyword, which
// excludes both inline-comment text and trace_processor-internal `CREATE
// TABLE _foo` helpers. INDEX is not a queryable name, so it is excluded.
const CREATE_REGEX =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PERFETTO\s+(?:TABLE|VIEW|FUNCTION|MACRO)\s+([A-Za-z_][A-Za-z0-9_]*)/gim;

function isInternalSymbol(name: string): boolean {
  return name.startsWith('_');
}

function relPathToModulePath(relPath: string): string {
  // e.g. "slices/self_dur.sql" -> "slices.self_dur"
  return relPath.replace(/\\/g, '/').replace(/\.sql$/, '').replace(/\//g, '.');
}

function parseSymbols(sql: string): string[] {
  const out: string[] = [];
  for (const match of sql.matchAll(CREATE_REGEX)) {
    const name = match[1];
    if (!isInternalSymbol(name)) out.push(name.toLowerCase());
  }
  return out;
}

/**
 * Lazily build the symbol index by scanning the Perfetto stdlib source tree.
 * Called once per process; subsequent calls return the cache. Synchronous
 * I/O is fine here because (1) it happens once, (2) ~250 small files, and
 * (3) it's invoked from MCP tool handlers that are already async-boundaried.
 */
function getSymbolIndex(): SymbolIndex {
  if (cachedIndex) return cachedIndex;

  const tableToModule = new Map<string, string>();
  const builtins = new Set<string>();

  if (!fs.existsSync(STDLIB_PATH)) {
    console.warn(
      `[sqlIncludeInjector] Stdlib path not found: ${STDLIB_PATH}. ` +
      `Auto-INCLUDE injection disabled; raw SQL must use explicit INCLUDE PERFETTO MODULE.`
    );
    cachedIndex = { tableToModule, builtins };
    return cachedIndex;
  }

  const startTime = Date.now();
  walkStdlibSqlFiles((abs, rel) => {
    const isPrelude = rel.split(path.sep)[0] === STDLIB_PRELUDE_DIR;
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      return;
    }
    const symbols = parseSymbols(content);
    if (symbols.length === 0) return;
    if (isPrelude) {
      for (const sym of symbols) builtins.add(sym);
    } else {
      const modulePath = relPathToModulePath(rel);
      for (const sym of symbols) {
        // First-writer wins. Stdlib should not double-define names; if it
        // does, the first parsed file owns the name.
        if (!tableToModule.has(sym)) tableToModule.set(sym, modulePath);
      }
    }
  }, { includePrelude: true });

  const elapsed = Date.now() - startTime;
  console.log(
    `[sqlIncludeInjector] Indexed ${tableToModule.size} stdlib symbols + ` +
    `${builtins.size} prelude builtins in ${elapsed}ms`
  );

  cachedIndex = { tableToModule, builtins };
  return cachedIndex;
}

// Strip line comments and SQL string literals so the FROM/JOIN/function/macro
// regexes don't see tokens hidden inside them. We do NOT strip double-quoted
// regions because in SQLite (and Perfetto SQL) `"foo"` is a quoted identifier
// first; `SELECT * FROM "slice_self_dur"` should still trigger injection.
// Masked regions are replaced with whitespace of the same length to preserve
// byte offsets, which keeps the transformation reversible for debugging.
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < len && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      out += ' ';
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { // SQL doubled-quote escape: ''
            out += '  ';
            i += 2;
            continue;
          }
          out += ' ';
          i++;
          break;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const FUNCTION_CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

// Perfetto SQL macros are called as `name!(...)`, distinct from function
// calls `name(...)` and from the inequality operator `name != x`.
const MACRO_INVOCATION_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*!\s*\(/g;

const ALREADY_INCLUDED_REGEX = /\bINCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)/gi;

// Tokens we care about for FROM/JOIN parsing: identifiers, double-quoted
// identifiers, parens, commas, and semicolons. Quoted identifiers are
// emitted with the surrounding double-quotes intact so the parser can
// detect and strip them.
const TOKEN_REGEX = /"[^"\n]+"|[A-Za-z_][A-Za-z0-9_]*|[(),;]/g;

function unquoteIdentifier(token: string): string {
  return token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

// Keywords that signal the FROM clause has ended (so the next identifier is
// not a comma-continuation table). Aliases (with or without AS) are eaten
// only when the next token is NOT one of these.
const FROM_CLAUSE_TERMINATORS = new Set([
  'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'LIMIT', 'HAVING',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'FULL', 'NATURAL',
  'UNION', 'EXCEPT', 'INTERSECT',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'BETWEEN', 'LIKE', 'GLOB',
  'OFFSET', 'FETCH', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'ASC', 'DESC', 'NULL', 'TRUE', 'FALSE',
  'SELECT', 'FROM',
]);

function isIdentifierToken(tok: string): boolean {
  return /^[A-Za-z_]/.test(tok) || tok.startsWith('"');
}

// Tokenize a stripped SQL string and walk for FROM/JOIN clauses, emitting
// each table name (skipping aliases). Comma-separated tables share the
// same FROM clause: `FROM t1 a1, t2 a2, t3` -> [t1, t2, t3]. Double-quoted
// identifiers (`FROM "slice_self_dur"`) are unquoted before lookup.
function extractFromJoinTables(strippedSql: string): string[] {
  const tokens = strippedSql.match(TOKEN_REGEX) || [];
  const tables: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const upper = tokens[i].toUpperCase();
    if (upper !== 'FROM' && upper !== 'JOIN') {
      i++;
      continue;
    }
    i++;
    while (i < tokens.length) {
      const ident = tokens[i];
      // `FROM (subquery ...)`: break; the inner FROM/JOIN is parsed by
      // the outer iteration since tokens are flat.
      if (ident === '(' || !isIdentifierToken(ident)) break;
      tables.push(unquoteIdentifier(ident).toLowerCase());
      i++;
      if (i < tokens.length && tokens[i].toUpperCase() === 'AS') {
        i++;
        if (i < tokens.length && isIdentifierToken(tokens[i])) i++;
      } else if (
        i < tokens.length
        && isIdentifierToken(tokens[i])
        && !FROM_CLAUSE_TERMINATORS.has(tokens[i].toUpperCase())
      ) {
        i++;
      }
      if (i < tokens.length && tokens[i] === ',') {
        i++;
        continue;
      }
      break;
    }
  }
  return tables;
}

function extractReferencedIdentifiers(strippedSql: string): Set<string> {
  const refs = new Set<string>();
  for (const t of extractFromJoinTables(strippedSql)) refs.add(t);
  // Function calls and macro invocations. SQLite built-ins (COUNT, SUM,
  // CAST, ...) and user-defined CTE names are matched too, but harmlessly
  // skipped at lookup time because they are not in the stdlib map.
  for (const match of strippedSql.matchAll(FUNCTION_CALL_REGEX)) {
    refs.add(match[1].toLowerCase());
  }
  for (const match of strippedSql.matchAll(MACRO_INVOCATION_REGEX)) {
    refs.add(match[1].toLowerCase());
  }
  return refs;
}

function extractAlreadyIncluded(sql: string): Set<string> {
  const set = new Set<string>();
  for (const match of sql.matchAll(ALREADY_INCLUDED_REGEX)) {
    set.add(match[1].toLowerCase());
  }
  return set;
}

/**
 * Returns `sql` unchanged if no stdlib references need INCLUDE, or
 * returns a new SQL string with the required INCLUDE statements prepended
 * in alphabetical order (deterministic for caching/logging).
 *
 * trace_processor treats repeated `INCLUDE PERFETTO MODULE x;` as a
 * no-op, so we are free to inject even when the module might already be
 * preloaded by the Tier-0 fire-and-forget loader (workingTraceProcessor).
 * This avoids a race where the first raw SQL after upload arrives before
 * Tier-0 finishes loading.
 */
export function injectStdlibIncludes(sql: string): InjectionResult {
  if (!sql || typeof sql !== 'string') return { sql, injected: [] };

  const index = getSymbolIndex();
  if (index.tableToModule.size === 0) return { sql, injected: [] };

  const stripped = stripCommentsAndStrings(sql);
  const refs = extractReferencedIdentifiers(stripped);
  if (refs.size === 0) return { sql, injected: [] };

  const already = extractAlreadyIncluded(stripped);
  const needed = new Set<string>();

  for (const ref of refs) {
    if (index.builtins.has(ref)) continue;
    const module = index.tableToModule.get(ref);
    if (!module) continue;
    if (already.has(module.toLowerCase())) continue;
    needed.add(module);
  }

  if (needed.size === 0) return { sql, injected: [] };

  const sorted = Array.from(needed).sort();
  const prefix = sorted.map(m => `INCLUDE PERFETTO MODULE ${m};`).join('\n');
  return { sql: `${prefix}\n${sql}`, injected: sorted };
}

// ---------------------------------------------------------------------------
// Test-only exports. Kept under `_` prefix to discourage production use.
// ---------------------------------------------------------------------------

export function _resetCacheForTesting(): void {
  cachedIndex = null;
}

export function _getSymbolIndexForTesting(): {
  tableToModule: ReadonlyMap<string, string>;
  builtins: ReadonlySet<string>;
} {
  return getSymbolIndex();
}
