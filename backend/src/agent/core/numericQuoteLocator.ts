// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

export interface NumericQuoteSpan {start: number; end: number}

/** Exact UTF-16, non-overlapping matches. Numeric token validation is separate. */
function* matches(body: string, text: string): Generator<NumericQuoteSpan> {
  if (!text.length) return;
  for (let start = body.indexOf(text); start >= 0; start = body.indexOf(text, start + text.length)) {
    yield {start, end: start + text.length};
  }
}

export function findQuoteOccurrence(body: string, text: string, occurrence?: number): NumericQuoteSpan | undefined {
  if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || occurrence < 0)) return undefined;
  let ordinal = 0, unique: NumericQuoteSpan | undefined;
  for (const span of matches(body, text)) {
    if (occurrence !== undefined) {
      if (ordinal === occurrence) return span;
    } else {
      if (unique) return undefined;
      unique = span;
    }
    ordinal++;
  }
  return occurrence === undefined ? unique : undefined;
}

export function quoteOccurrenceAtSpan(body: string, text: string, target: NumericQuoteSpan): number | undefined {
  let ordinal = 0;
  for (const span of matches(body, text)) {
    if (span.start === target.start && span.end === target.end) return ordinal;
    if (span.start >= target.start) return undefined;
    ordinal++;
  }
  return undefined;
}
