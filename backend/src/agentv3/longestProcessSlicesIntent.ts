// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const DEFAULT_LONGEST_PROCESS_SLICE_ROWS = 5;
const MAX_QUICK_LONGEST_PROCESS_SLICE_ROWS = 20;

const LONGEST_PROCESS_SLICES_PATTERN = /(?:(?:top\s*[-_:]?\s*\d+|前\s*\d+\s*(?:个|条)?).{0,32}(?:long(?:est)?|duration|耗时|时长).{0,32}(?:process\s+)?(?:slices?|切片))|(?:(?:top\s*[-_:]?\s*\d+|前\s*\d+\s*(?:个|条)?).{0,32}(?:process\s+)?(?:slices?|切片).{0,20}(?:longest|duration|耗时|时长))|(?:(?:longest|耗时最长|时长最长|最长).{0,32}(?:process\s+)?(?:slices?|切片))/i;

export function matchesLongestProcessSlicesFactQuery(query: string): boolean {
  return LONGEST_PROCESS_SLICES_PATTERN.test(query.trim());
}

export function requestedLongestProcessSliceRows(query: string): number {
  const englishTop = query.match(/\btop\s*[-_:]?\s*(\d{1,3})\b/i);
  const chineseTop = query.match(/前\s*(\d{1,3})\s*(?:个|条)?/);
  const requested = Number(englishTop?.[1] ?? chineseTop?.[1] ?? DEFAULT_LONGEST_PROCESS_SLICE_ROWS);
  if (!Number.isFinite(requested)) return DEFAULT_LONGEST_PROCESS_SLICE_ROWS;
  return Math.min(MAX_QUICK_LONGEST_PROCESS_SLICE_ROWS, Math.max(1, Math.trunc(requested)));
}
