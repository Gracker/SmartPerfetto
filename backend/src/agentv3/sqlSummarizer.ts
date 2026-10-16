// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SQL result summarizer for token-efficient context injection.
 * When Claude requests summary=true, returns column statistics + sample rows
 * instead of full 200-row result sets, saving ~85% tokens per query.
 *
 * The full data is still sent to the frontend via DataEnvelope for interactive tables.
 */

import {INDEXED_ROW_SHAPE, indexEvidenceRowsAt, type IndexedEvidenceRow} from '../services/evidence/evidenceCapture';

export interface ColumnStat {
  column: string;
  type: 'numeric' | 'string';
  /** Numeric stats — only present for numeric columns */
  min?: number;
  max?: number;
  avg?: number;
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
  /** String stats — only present for string columns */
  topValues?: Array<{ value: string; count: number }>;
  nullCount: number;
}

export interface SqlSummary {
  totalRows: number;
  columnStats: ColumnStat[];
  rowShape: typeof INDEXED_ROW_SHAPE;
  /** Sample rows in interest order, each with its original row index. */
  sampleRows: IndexedEvidenceRow[];
  columns: string[];
}

/**
 * Summarize SQL query results into compact column statistics + sample rows.
 * Sample rows are selected by picking the most "interesting" rows — sorted
 * by descending values in duration/latency/jank-related columns.
 */
export function summarizeSqlResult(
  columns: string[],
  rows: any[][],
): SqlSummary {
  const columnStats = columns.map((col, colIdx) => computeColumnStat(col, colIdx, rows));
  return {
    totalRows: rows.length,
    columnStats,
    rowShape: INDEXED_ROW_SHAPE,
    sampleRows: indexEvidenceRowsAt(rows, selectSampleRowIndices(columns, rows, 10)),
    columns,
  };
}

function computeColumnStat(column: string, colIdx: number, rows: any[][]): ColumnStat {
  const values = rows.map(r => r[colIdx]);
  const nonNull = values.filter(v => v !== null && v !== undefined);
  const nullCount = values.length - nonNull.length;

  // Determine if numeric by checking first non-null values
  const isNumeric = nonNull.length > 0 && nonNull.slice(0, 10).every(v => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v.trim() !== ''));

  if (isNumeric && nonNull.length > 0) {
    const nums = nonNull.map(Number).sort((a, b) => a - b);
    return {
      column,
      type: 'numeric',
      min: nums[0],
      max: nums[nums.length - 1],
      avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
      p50: percentile(nums, 50),
      p90: percentile(nums, 90),
      p95: percentile(nums, 95),
      p99: percentile(nums, 99),
      nullCount,
    };
  }

  // String column — top 5 value distribution
  const freqMap = new Map<string, number>();
  for (const v of nonNull) {
    const key = String(v);
    freqMap.set(key, (freqMap.get(key) || 0) + 1);
  }
  const topValues = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));

  return { column, type: 'string', topValues, nullCount };
}

/**
 * Select the most "interesting" rows as samples.
 * Prioritizes rows with high values in columns that look like duration/latency/jank metrics.
 */
function selectSampleRowIndices(columns: string[], rows: any[][], maxSamples: number): number[] {
  if (rows.length <= maxSamples) return rows.map((_, index) => index);

  // Find the best "interest" column (dur, latency, jank, count, etc.)
  const interestColIdx = findInterestColumn(columns);

  if (interestColIdx >= 0) {
    // Sort by interest column descending, take top samples
    const indexed = rows.map((row, idx) => ({ idx, val: Number(row[interestColIdx]) || 0 }));
    indexed.sort((a, b) => b.val - a.val);
    return indexed.slice(0, maxSamples).map(i => i.idx);
  }

  // No clear interest column — take evenly spaced samples
  const step = Math.max(1, Math.floor(rows.length / maxSamples));
  const samples: number[] = [];
  for (let i = 0; i < rows.length && samples.length < maxSamples; i += step) {
    samples.push(i);
  }
  return samples;
}

/** Find column index most likely to represent "interestingness" (duration, jank count, etc.) */
function findInterestColumn(columns: string[]): number {
  const priorities = ['dur_ms', 'dur', 'duration', 'latency', 'jank', 'vsync_missed', 'count', 'total', 'delay'];
  for (const keyword of priorities) {
    const idx = columns.findIndex(c => c.toLowerCase().includes(keyword));
    if (idx >= 0) return idx;
  }
  return -1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(sorted[lo]);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}