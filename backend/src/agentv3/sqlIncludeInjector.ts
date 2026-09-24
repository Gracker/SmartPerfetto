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
 * Source of truth: backend/data/perfettoStdlibSymbols.json, generated from the
 * Perfetto stdlib `.sql` source files. Source checkouts can still scan the live
 * stdlib tree via PERFETTO_STDLIB_PATH for maintainer debugging.
 */

import {
  clearModuleCache,
  getPerfettoStdlibSymbolIndex,
} from '../services/perfettoStdlibScanner';
import { analyzeSqlStdlibDependencies } from '../services/sqlStdlibDependencyAnalyzer';

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

/**
 * Lazily load the stdlib symbol index.
 * Called once per process; subsequent calls return the cache. Synchronous
 * I/O is fine here because it happens once and is invoked from MCP tool
 * handlers that are already async-boundaried.
 */
function getSymbolIndex(): SymbolIndex {
  if (cachedIndex) return cachedIndex;
  const index = getPerfettoStdlibSymbolIndex();
  cachedIndex = {
    tableToModule: index.tableToModule,
    builtins: index.builtins,
  };
  if (cachedIndex.tableToModule.size === 0) {
    console.warn(
      '[sqlIncludeInjector] Stdlib symbol index is empty. ' +
      'Auto-INCLUDE injection disabled; raw SQL must use explicit INCLUDE PERFETTO MODULE.'
    );
  }
  return cachedIndex;
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

  const analysis = analyzeSqlStdlibDependencies(sql, {includeIntrospectedNames: true});
  if (analysis.requiredModules.length === 0) return { sql, injected: [] };

  const sorted = analysis.requiredModules;
  const prefix = sorted.map(m => `INCLUDE PERFETTO MODULE ${m};`).join('\n');
  return { sql: `${prefix}\n${sql}`, injected: sorted };
}

// ---------------------------------------------------------------------------
// Test-only exports. Kept under `_` prefix to discourage production use.
// ---------------------------------------------------------------------------

export function _resetCacheForTesting(): void {
  cachedIndex = null;
  clearModuleCache();
}

export function _getSymbolIndexForTesting(): {
  tableToModule: ReadonlyMap<string, string>;
  builtins: ReadonlySet<string>;
} {
  return getSymbolIndex();
}
