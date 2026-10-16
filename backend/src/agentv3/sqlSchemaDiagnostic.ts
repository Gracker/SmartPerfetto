// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Structured schema facts for a failed raw SQL query.
 *
 * A failed `execute_sql` used to return the trace_processor message and a
 * generic retry hint. Models then guessed the next column name: in one corpus
 * `android_binder_txns` was queried with `ts`, `dur`, `upid` and `id` eleven
 * times across ten sessions, while its real columns are `client_ts`,
 * `server_ts`, `client_dur`, `client_upid`, ... This module says which symbol
 * the error concerns, which module defines it, its columns and the nearest
 * ones, and how often this run has already hit the same error.
 *
 * Every schema fact comes from the generated, bundled stdlib docs and symbol
 * index. Nothing here queries the trace: a `pragma_table_info` fallback would
 * not be a pure read and would taint native provenance on the processor.
 */

import {getPerfettoStdlibModules, getPerfettoStdlibSymbolIndex} from '../services/perfettoStdlibScanner';
import {loadPerfettoSqlDocsAsset} from '../services/perfettoSqlDocs';
import {
  analyzeSqlStdlibDependencies,
  extractExternalTableBindings,
  moduleCoveredByStdlibDeclaration,
} from '../services/sqlStdlibDependencyAnalyzer';
import {
  classifyTraceProcessorSqlError,
  normalizeTraceProcessorSqlError,
  type TraceProcessorSqlErrorKind,
} from '../services/traceProcessorSqlWorker';

const MAX_AVAILABLE_COLUMNS = 48;
const MAX_CLOSEST = 5;
const MAX_ALTERNATIVE_SYMBOLS = 3;
const MAX_REPEAT_KEYS = 256;

export interface SqlSchemaDiagnosticV1 {
  errorKind: TraceProcessorSqlErrorKind;
  /** A failed query says nothing about whether the trace holds the data. */
  absence: 'query_error_not_data_absence';
  /** The table, view, function or module the error names or resolves to. */
  symbol?: string;
  /** The missing column, without its qualifier. */
  column?: string;
  /** The missing function. */
  function?: string;
  /** The stdlib module defining `symbol`; absent for prelude built-ins. */
  stdlibModule?: string;
  /** Whether this query already loaded `stdlibModule` (auto-INCLUDE or its own INCLUDE). */
  moduleInjected?: boolean;
  /** Columns of `symbol` from the bundled stdlib docs, in declared order. */
  availableColumns?: string[];
  availableColumnsTruncated?: boolean;
  availableColumnsSource?: 'bundled_stdlib_docs';
  /** Existing columns nearest to the missing one. */
  closestColumns?: string[];
  /** Existing symbols or modules nearest to a missing one. */
  closestSymbols?: string[];
  /** Other queried tables that also lack an unqualified missing column. */
  alternativeSymbols?: string[];
  /** Times this run has now failed with the same kind, symbol and name (1 = first). */
  repeatCount: number;
}

export interface SqlSchemaDiagnosticInput {
  error: string;
  /** The SQL as the model wrote it (after normalization), without injected INCLUDEs. */
  sql?: string;
  /** Modules auto-INCLUDEd for this query. */
  injectedModules?: readonly string[];
}

interface DocsTable {
  columns: string[];
  module: string;
}

interface DocsIndex {
  tables: Map<string, DocsTable>;
  functions: string[];
}

let docsIndexCache: DocsIndex | undefined;
let knownTableNamesCache: string[] | undefined;

function docsIndex(): DocsIndex {
  if (!docsIndexCache) {
    const tables = new Map<string, DocsTable>();
    const functions = new Set<string>();
    for (const entry of loadPerfettoSqlDocsAsset()?.entries ?? []) {
      const name = entry.name.toLowerCase();
      if (entry.type === 'table' || entry.type === 'view') {
        if (!tables.has(name) && entry.columns?.length) {
          tables.set(name, {
            columns: entry.columns.map(column => column.name),
            module: entry.module,
          });
        }
      } else if (entry.type === 'function' || entry.type === 'table_function' || entry.type === 'macro') {
        functions.add(name);
      }
    }
    docsIndexCache = {tables, functions: [...functions]};
  }
  return docsIndexCache;
}

function knownTableNames(): string[] {
  knownTableNamesCache ??= [...new Set([
    ...docsIndex().tables.keys(),
    ...getPerfettoStdlibSymbolIndex().tableToModule.keys(),
  ])].filter(name => !name.startsWith('_'));
  return knownTableNamesCache;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({length: right.length + 1}, (_value, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * Candidates nearest to `target`. A candidate containing every `_`-separated
 * token of the target ranks first (`ts` -> `client_ts`, `upid` ->
 * `client_upid`), then one sharing a token of three or more characters, then a
 * small edit distance. Ties keep the shorter name, then the declared order.
 */
function closest(target: string, candidates: readonly string[]): string[] {
  const wanted = target.toLowerCase();
  const tokens = wanted.split('_').filter(Boolean);
  const maxDistance = Math.max(2, Math.floor(wanted.length / 3));
  const scored: Array<{name: string; score: number; order: number}> = [];
  candidates.forEach((name, order) => {
    const lower = name.toLowerCase();
    if (lower === wanted) return;
    const parts = lower.split('_');
    if (tokens.length > 0 && tokens.every(token => parts.includes(token))) {
      scored.push({name, score: lower.length - wanted.length, order});
      return;
    }
    // Shares a meaningful token: `process_name` -> `client_process`.
    const shared = tokens.filter(token => token.length >= 3 && parts.includes(token)).length;
    if (shared > 0) {
      scored.push({name, score: 500 + tokens.length - shared, order});
      return;
    }
    const distance = editDistance(wanted, lower);
    if (distance <= maxDistance) scored.push({name, score: 1_000 + distance, order});
  });
  return scored
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.order - b.order)
    .slice(0, MAX_CLOSEST)
    .map(entry => entry.name);
}

function stdlibModuleOf(symbol: string): string | undefined {
  return getPerfettoStdlibSymbolIndex().tableToModule.get(symbol.toLowerCase());
}

function moduleWasLoaded(module: string, sql: string | undefined, injected: readonly string[]): boolean {
  // The analyzer masks comments and strings, so a commented-out INCLUDE does not count.
  const declared = [...injected, ...(sql ? analyzeSqlStdlibDependencies(sql).includes : [])];
  return moduleCoveredByStdlibDeclaration(module, declared);
}

function symbolFacts(
  symbol: string,
  input: SqlSchemaDiagnosticInput,
): Pick<SqlSchemaDiagnosticV1, 'symbol' | 'stdlibModule' | 'moduleInjected' | 'availableColumns' |
  'availableColumnsTruncated' | 'availableColumnsSource'> {
  const stdlibModule = stdlibModuleOf(symbol);
  const columns = docsIndex().tables.get(symbol.toLowerCase())?.columns;
  return {
    symbol,
    ...(stdlibModule ? {
      stdlibModule,
      moduleInjected: moduleWasLoaded(stdlibModule, input.sql, input.injectedModules ?? []),
    } : {}),
    ...(columns ? {
      availableColumns: columns.slice(0, MAX_AVAILABLE_COLUMNS),
      ...(columns.length > MAX_AVAILABLE_COLUMNS ? {availableColumnsTruncated: true} : {}),
      availableColumnsSource: 'bundled_stdlib_docs' as const,
    } : {}),
  };
}

type Resolution = Omit<SqlSchemaDiagnosticV1, 'errorKind' | 'absence' | 'repeatCount'>;

function resolveMissingColumn(
  qualifier: string | undefined,
  column: string,
  input: SqlSchemaDiagnosticInput,
): Resolution {
  const bindings = input.sql ? extractExternalTableBindings(input.sql) : [];
  const {tables} = docsIndex();
  const wanted = column.toLowerCase();
  let candidates: string[];
  if (qualifier !== undefined) {
    const lower = qualifier.toLowerCase();
    const bound = bindings.find(binding => binding.alias === lower) ??
      bindings.find(binding => binding.alias === undefined && binding.table === lower);
    candidates = bound ? [bound.table] : [];
  } else {
    candidates = [...new Set(bindings.map(binding => binding.table))].filter(table => {
      const columns = tables.get(table)?.columns;
      return columns !== undefined && !columns.some(name => name.toLowerCase() === wanted);
    });
  }
  const [symbol, ...alternatives] = candidates;
  if (symbol === undefined) return {column};
  const facts = symbolFacts(symbol, input);
  const closestColumns = facts.availableColumns
    ? closest(column, tables.get(symbol)?.columns ?? [])
    : [];
  return {
    ...facts,
    column,
    ...(closestColumns.length > 0 ? {closestColumns} : {}),
    ...(alternatives.length > 0 ? {alternativeSymbols: alternatives.slice(0, MAX_ALTERNATIVE_SYMBOLS)} : {}),
  };
}

function resolve(message: string, errorKind: TraceProcessorSqlErrorKind, input: SqlSchemaDiagnosticInput): Resolution {
  if (errorKind === 'missing_column') {
    const column = /no such column:\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)/i.exec(message);
    if (column) return resolveMissingColumn(column[1], column[2], input);
    const fn = /no such function:\s*([A-Za-z_]\w*)/i.exec(message);
    if (fn) {
      const name = fn[1];
      const stdlibModule = stdlibModuleOf(name);
      const closestSymbols = closest(name, docsIndex().functions);
      return {
        function: name,
        ...(stdlibModule ? {
          symbol: name,
          stdlibModule,
          moduleInjected: moduleWasLoaded(stdlibModule, input.sql, input.injectedModules ?? []),
        } : {}),
        ...(closestSymbols.length > 0 ? {closestSymbols} : {}),
      };
    }
    return {};
  }
  if (errorKind === 'missing_table') {
    const table = /no such table:\s*(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)/i.exec(message);
    if (!table) return {};
    const facts = symbolFacts(table[1], input);
    const closestSymbols = facts.stdlibModule ? [] : closest(table[1], knownTableNames());
    return {...facts, ...(closestSymbols.length > 0 ? {closestSymbols} : {})};
  }
  if (errorKind === 'unknown_module') {
    const module = /unknown module\s*'?([\w.]+)'?/i.exec(message);
    if (!module) return {};
    const closestSymbols = closest(module[1], getPerfettoStdlibModules());
    return {symbol: module[1], ...(closestSymbols.length > 0 ? {closestSymbols} : {})};
  }
  return {};
}

/**
 * Per-run memory of SQL failures. One instance belongs to one MCP server, and
 * the runtimes build one server per analysis run, so counts never cross runs or
 * sessions. Bounded: the oldest key is forgotten first.
 */
export class SqlFailureRepeatMemory {
  private readonly counts = new Map<string, number>();

  record(key: string): number {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, count);
    while (this.counts.size > MAX_REPEAT_KEYS) {
      const oldest = this.counts.keys().next().value;
      if (oldest === undefined) break;
      this.counts.delete(oldest);
    }
    return count;
  }
}

function repeatKey(errorKind: TraceProcessorSqlErrorKind, resolution: Resolution, message: string): string {
  const name = resolution.column ?? resolution.function;
  if (resolution.symbol !== undefined || name !== undefined) {
    return [errorKind, resolution.symbol ?? '', name ?? ''].join('\n').toLowerCase();
  }
  // Nothing resolved: the diagnosis itself, without its position.
  return [errorKind, message.replace(/\s*\(line \d+, col \d+\)\s*$/, '')].join('\n').toLowerCase();
}

export function buildSqlSchemaDiagnostic(
  input: SqlSchemaDiagnosticInput,
  memory: SqlFailureRepeatMemory,
): SqlSchemaDiagnosticV1 {
  const message = normalizeTraceProcessorSqlError(input.error ?? '');
  const errorKind = classifyTraceProcessorSqlError(message);
  let resolution: Resolution;
  try {
    resolution = resolve(message, errorKind, input);
  } catch {
    // Diagnostics are advisory; a parser surprise must not hide the failure itself.
    resolution = {};
  }
  return {
    errorKind,
    absence: 'query_error_not_data_absence',
    ...resolution,
    repeatCount: memory.record(repeatKey(errorKind, resolution, message)),
  };
}
