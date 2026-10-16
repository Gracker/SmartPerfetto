// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Shared coercion helpers for trace_processor query result handling.
// Multiple services (criticalPathSemantics, criticalPathWakerChain,
// criticalPathQuantify, criticalPathAnalyzer, flamegraphAnalyzer, ...) had
// hand-rolled clones — this module centralizes them.

import type {
  QueryResult,
  TraceProcessorService,
  TraceProcessorServiceQueryOptions,
} from '../services/traceProcessorService';

export type QueryRow = Record<string, unknown>;

/**
 * One row keyed by column name. Object.fromEntries defines each key, so a
 * column aliased `__proto__` stays a column: assigning it onto `{}` would run
 * the inherited setter and drop it, or strip the row's prototype for NULL.
 */
export function rowObject(columns: readonly string[], row: readonly unknown[]): QueryRow {
  return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
}

export function rowsToObjects(result: QueryResult): QueryRow[] {
  return result.rows.map((row) => rowObject(result.columns, row));
}

/**
 * `TraceProcessorService.query` reports a failed statement in `result.error`
 * instead of throwing. A caller whose status, warnings or gates depend on
 * seeing that failure must pass the result through here, or a broken query
 * reads as an empty result.
 */
export function assertQuerySucceeded(result: QueryResult): QueryResult {
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Rows of a query that must succeed. `options.signal` cancels the statement
 * while it waits in, or runs on, the processor's worker.
 */
export async function queryRows(
  tp: TraceProcessorService,
  traceId: string,
  sql: string,
  options?: TraceProcessorServiceQueryOptions
): Promise<QueryRow[]> {
  return rowsToObjects(assertQuerySucceeded(await tp.query(traceId, sql, options)));
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : fallback;
  }
  return fallback;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const converted = toNumber(value, Number.NaN);
  return Number.isFinite(converted) ? converted : null;
}

export function toOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function toBool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  const numeric = toNullableNumber(value);
  return numeric === null ? null : numeric > 0;
}

export function nsToMs(value: number): number {
  return Math.round((value / 1e6) * 100) / 100;
}
