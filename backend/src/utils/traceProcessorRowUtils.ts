// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Shared coercion helpers for trace_processor query result handling.
// Multiple services (criticalPathSemantics, criticalPathWakerChain,
// criticalPathQuantify, criticalPathAnalyzer, perfettoSqlSkill,
// flamegraphAnalyzer, ...) had hand-rolled byte-identical clones — this
// module centralizes them.

import type {QueryResult, TraceProcessorService} from '../services/traceProcessorService';

export type QueryRow = Record<string, unknown>;

export function rowObject(columns: string[], row: unknown[]): QueryRow {
  const out: QueryRow = {};
  columns.forEach((column, index) => {
    out[column] = row[index];
  });
  return out;
}

export function rowsToObjects(result: QueryResult): QueryRow[] {
  return result.rows.map((row) => rowObject(result.columns, row));
}

export async function queryRows(
  tp: TraceProcessorService,
  traceId: string,
  sql: string
): Promise<QueryRow[]> {
  const result = await tp.query(traceId, sql);
  return rowsToObjects(result);
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
