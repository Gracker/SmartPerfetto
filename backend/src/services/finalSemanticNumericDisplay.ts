// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Whether the number a `numeric_mismatch` points at is the declared exact value
// rounded at its displayed precision. The semantic review reports a bare
// rounding (`5,844.24 ms` for a declared `5844240564 ns`) as a mismatch; that is
// a presentation defect, not a contradicted value, so finalization records it
// apart from real mismatches.
//
// The location only selects the number. It is judged in its whole line: a
// quote of `45 ms` inside `145 ms`, `60–45 ms`, `超过 45 ms` or `−45 ms` must
// not be read without what surrounds it. The check fails closed on anything it
// cannot read exactly — an unknown unit or magnitude word, a range or list, a
// comparison, malformed digits, a non-zero value shown as zero. Exact rationals
// and the review template's closed unit mapping only.

import {exactNumber, type Rational} from '../utils/exactDecimal';

interface UnitScale {family: string; factor: bigint}

const pow = (base: bigint, exponent: number): bigint => base ** BigInt(exponent);

/** Base-unit factor per unit, mirroring prompt-final-semantic-assessment's closed mapping. */
const UNIT_SCALES: Readonly<Record<string, UnitScale>> = {
  ns: {family: 'time', factor: 1n},
  us: {family: 'time', factor: 1_000n},
  'µs': {family: 'time', factor: 1_000n},
  'μs': {family: 'time', factor: 1_000n},
  ms: {family: 'time', factor: 1_000_000n},
  s: {family: 'time', factor: 1_000_000_000n},
  Hz: {family: 'frequency', factor: 1n},
  kHz: {family: 'frequency', factor: 1_000n},
  MHz: {family: 'frequency', factor: 1_000_000n},
  GHz: {family: 'frequency', factor: 1_000_000_000n},
  B: {family: 'bytes', factor: 1n},
  bytes: {family: 'bytes', factor: 1n},
  KiB: {family: 'bytes', factor: pow(1024n, 1)},
  MiB: {family: 'bytes', factor: pow(1024n, 2)},
  GiB: {family: 'bytes', factor: pow(1024n, 3)},
  ratio: {family: 'ratio', factor: 100n},
  '%': {family: 'ratio', factor: 1n},
  percent: {family: 'ratio', factor: 1n},
  count: {family: 'count', factor: 1n},
  frame: {family: 'frames', factor: 1n},
  frames: {family: 'frames', factor: 1n},
  event: {family: 'events', factor: 1n},
  events: {family: 'events', factor: 1n},
};

/** Families a bare number (no unit word) can belong to. */
const UNITLESS_FAMILIES: ReadonlySet<string> = new Set(['count', 'frames', 'events']);

/** A comparison or tolerance changes the proposition, not its precision. */
const QUALIFIER =
  /±|[<>≤≥]=?|超过|超出|不到|不足|不止|以上|以下|大于|小于|高于|低于|少于|多于|至少|至多|最多|最少|接近|将近|逾|\b(?:over|under|above|below|less than|more than|greater than|fewer than|at least|at most|up to|within|exceed(?:s|ed|ing)?)\b/i;
// Emphasis is blanked, not removed, so offsets into the line stay valid.
const EMPHASIS = /[*_`]/g;
// Not part of a Latin identifier or a longer number: `P90`, `v1.2`, `utid630`
// stay out. A CJK character right before a number (`偏差−45`, `耗时60`) is prose.
const NUMBER = /(?<![A-Za-z0-9_.,])([-−－]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![\d.,]?\d)/gu;
// Any run of spaces, including the non-breaking ones aligned tables use.
const UNIT_AFTER =
  /^[\s  ]*(?:(%)|(ns|us|µs|μs|ms|s|Hz|kHz|MHz|GHz|B|bytes|KiB|MiB|GiB|percent|frames|frame|events|event|count)(?![\p{L}\p{N}]))/u;
// A unit or magnitude outside the closed mapping right after the number: a Latin
// word (`sec`, `GB`, `S`), a symbol, or a CJK unit or magnitude word. An ordinary
// CJK word after a bare integer (`33 段`, `3 约`) is prose, not a unit.
const UNKNOWN_UNIT_AFTER =
  /^[\s  ]*(?:[A-Za-zµμ％‰°]|毫秒|微秒|纳秒|秒|分钟|小时|赫兹|兆赫|千赫|字节|千字节|兆字节|百|千|万|兆|亿|倍|成|折|帧)/u;
// Only separators between two numbers: a range or a list, not one value.
const RANGE_OR_LIST = /^\s*(?:[-–—~～/、,，]|至|到|和|或|or|and)\s*$/i;
// Digits joined by a separator: every such run must lie inside one parsed number.
const JOINED_DIGITS = /\d[.,]\d/g;
// A dash right before a number that was not read as its sign.
const DASH = /[-−－–—]/u;
// Where a clause ends; a comparison word applies within its clause.
const CLAUSE_BREAK = /[，。；;！？!?：:|\n]/u;

interface Token {
  rational?: Rational;
  decimals: number;
  unit?: string;
  unknownUnit: boolean;
  start: number;
  end: number;
}

function tokenizeLine(line: string): {tokens: Token[]; malformed: Array<[number, number]>} {
  const tokens: Token[] = [];
  for (const match of line.matchAll(NUMBER)) {
    const [literal, sign, whole, fraction = ''] = match;
    const start = match.index ?? 0;
    let end = start + literal.length;
    const rest = line.slice(end);
    const unitMatch = UNIT_AFTER.exec(rest);
    if (unitMatch) end += unitMatch[0].length;
    tokens.push({
      rational: exactNumber(`${sign ? '-' : ''}${whole.replace(/,/g, '')}${fraction}`),
      decimals: Math.max(0, fraction.length - 1),
      unit: unitMatch?.[1] ?? unitMatch?.[2],
      unknownUnit: !unitMatch && UNKNOWN_UNIT_AFTER.test(rest),
      start,
      end,
    });
  }
  // `1,2345` or a European `12,5` cannot be split into numbers.
  const malformed: Array<[number, number]> = [];
  for (const joined of line.matchAll(JOINED_DIGITS)) {
    const at = joined.index ?? 0;
    if (!tokens.some(token => token.start <= at && at + joined[0].length <= token.end)) {
      malformed.push([at, at + joined[0].length]);
    }
  }
  return {tokens, malformed};
}

/** Half-up rounding of `value` to `decimals`, scaled by 10^decimals. */
function roundedScaled(value: Rational, decimals: number): bigint {
  const scaled = value.numerator * pow(10n, decimals);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const rounded = (magnitude * 2n + value.denominator) / (value.denominator * 2n);
  return negative ? -rounded : rounded;
}

/** The clause around [start, end): from the previous clause break to the next. */
function clauseAround(line: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !CLAUSE_BREAK.test(line[from - 1])) from -= 1;
  let to = end;
  while (to < line.length && !CLAUSE_BREAK.test(line[to])) to += 1;
  return line.slice(from, to);
}

const overlaps = (start: number, end: number, from: number, to: number): boolean => start < to && from < end;

/**
 * True when every number the locations select that belongs to the declared
 * unit's family is the declared exact `eq` value rounded half-up at its
 * displayed decimal places, at least one such number exists, and nothing in
 * its line could change the proposition.
 */
export function locatedNumbersShowDeclaredRounding(
  body: string,
  locations: readonly {start: number; end: number}[],
  numeric: {operator: string; value: number | string; unit: string} | undefined,
): boolean {
  if (!numeric || numeric.operator !== 'eq' || locations.length === 0) return false;
  const declared = exactNumber(numeric.value);
  const declaredScale = UNIT_SCALES[numeric.unit.trim()];
  if (!declared || !declaredScale) return false;
  const countFamily = UNITLESS_FAMILIES.has(declaredScale.family);
  let matched = 0;
  for (const location of locations) {
    if (!(location.start >= 0 && location.end > location.start && location.end <= body.length)) return false;
    const lineStart = body.lastIndexOf('\n', location.start - 1) + 1;
    const lineBreak = body.indexOf('\n', location.end);
    const lineEnd = lineBreak < 0 ? body.length : lineBreak;
    const line = body.slice(lineStart, lineEnd).replace(EMPHASIS, ' ');
    const from = location.start - lineStart;
    const to = location.end - lineStart;
    const {tokens, malformed} = tokenizeLine(line);
    if (malformed.some(([start, end]) => overlaps(start, end, from, to))) return false;
    const targets = tokens.filter(token => overlaps(token.start, token.end, from, to));
    if (targets.length === 0) return false;
    for (const token of targets) {
      if (token.unknownUnit || !token.rational) return false;
      // A bare decimal is almost never a count: it is a value whose unit was left out.
      if (!token.unit && !countFamily && token.decimals > 0) return false;
      const scale = token.unit ? UNIT_SCALES[token.unit] : countFamily ? declaredScale : undefined;
      if (!scale || scale.family !== declaredScale.family) continue;
      const index = tokens.indexOf(token);
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if (previous && RANGE_OR_LIST.test(line.slice(previous.end, token.start))) return false;
      if (next && RANGE_OR_LIST.test(line.slice(token.end, next.start))) return false;
      if (QUALIFIER.test(clauseAround(line, token.start, token.end))) return false;
      if (token.start > 0 && DASH.test(line[token.start - 1])) return false;
      // The declared value expressed in the displayed unit.
      const shown: Rational = {
        numerator: declared.numerator * declaredScale.factor,
        denominator: declared.denominator * scale.factor,
      };
      const displayed = roundedScaled(token.rational, token.decimals);
      // A non-zero value displayed as 0 asserts absence, not a rounding.
      if (displayed === 0n && declared.numerator !== 0n) return false;
      if (roundedScaled(shown, token.decimals) !== displayed) return false;
      matched += 1;
    }
  }
  return matched > 0;
}
