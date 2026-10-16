// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * One-directional unit-dimension equivalence shared by the finite claim
 * verifier and the agent SSE fact gate: a declaration written with the
 * generic counted unit `count` accepts any concrete counted producer
 * dimension (`frames`/`events`) at 1:1, never the other way around and never
 * across non-counted families (time, bytes, ratio, frequency).
 *
 * This is the only such vocabulary: consumers resolve unit tokens to
 * dimensions here instead of keeping a private, drifting copy.
 */

/** Producer dimensions a generic `count` declaration accepts at face value. */
export const COUNTED_PRODUCER_DIMENSIONS: ReadonlySet<string> = new Set(['frames', 'events']);

const countedDimensionsByToken: Readonly<Record<string, string>> = Object.freeze({
  count: 'count',
  frame: 'frames',
  frames: 'frames',
  event: 'events',
  events: 'events',
});

/**
 * Resolves a unit token to its counted dimension (`count`, `frames`,
 * `events`), including the singular aliases. Non-counted or unknown tokens
 * resolve to undefined; time, bytes, ratio and frequency stay outside this
 * vocabulary because no leniency rule ever crosses those families.
 */
export function countedUnitDimension(unit: string | undefined): string | undefined {
  return unit !== undefined && Object.prototype.hasOwnProperty.call(countedDimensionsByToken, unit)
    ? countedDimensionsByToken[unit]
    : undefined;
}

/**
 * Declared-generic `count` accepts any counted producer dimension at 1:1.
 * One-directional by design: `frames` rejects `count`/`events` producers,
 * `events` rejects `count`/`frames`, and `count` never accepts a non-counted
 * producer dimension.
 */
export function declaredUnitAcceptsProducerDimension(declaredUnit: string, producerDimension: string): boolean {
  return countedUnitDimension(declaredUnit) === 'count' && COUNTED_PRODUCER_DIMENSIONS.has(producerDimension);
}

/** Exact scales shared by proposition proof and explicit numeric presentation. */
export type ClaimUnit = {readonly dimension: string; readonly numerator: bigint; readonly denominator: bigint};

// These are explicit unit definitions, not aliases inferred from a column name.
const units: Readonly<Record<string, ClaimUnit>> = {
  ns: {dimension: 'time', numerator: 1n, denominator: 1n},
  us: {dimension: 'time', numerator: 1000n, denominator: 1n},
  'µs': {dimension: 'time', numerator: 1000n, denominator: 1n},
  'μs': {dimension: 'time', numerator: 1000n, denominator: 1n},
  ms: {dimension: 'time', numerator: 1000000n, denominator: 1n},
  s: {dimension: 'time', numerator: 1000000000n, denominator: 1n},
  count: {dimension: 'count', numerator: 1n, denominator: 1n},
  frame: {dimension: 'frames', numerator: 1n, denominator: 1n},
  frames: {dimension: 'frames', numerator: 1n, denominator: 1n},
  event: {dimension: 'events', numerator: 1n, denominator: 1n},
  events: {dimension: 'events', numerator: 1n, denominator: 1n},
  fps: {dimension: 'frame_rate', numerator: 1n, denominator: 1n},
  'frames/s': {dimension: 'frame_rate', numerator: 1n, denominator: 1n},
  ratio: {dimension: 'ratio', numerator: 1n, denominator: 1n},
  '%': {dimension: 'ratio', numerator: 1n, denominator: 100n},
  percent: {dimension: 'ratio', numerator: 1n, denominator: 100n},
  B: {dimension: 'bytes', numerator: 1n, denominator: 1n},
  bytes: {dimension: 'bytes', numerator: 1n, denominator: 1n},
  KiB: {dimension: 'bytes', numerator: 1024n, denominator: 1n},
  MiB: {dimension: 'bytes', numerator: 1048576n, denominator: 1n},
  GiB: {dimension: 'bytes', numerator: 1073741824n, denominator: 1n},
  Hz: {dimension: 'frequency', numerator: 1n, denominator: 1n},
  kHz: {dimension: 'frequency', numerator: 1000n, denominator: 1n},
  MHz: {dimension: 'frequency', numerator: 1000000n, denominator: 1n},
  GHz: {dimension: 'frequency', numerator: 1000000000n, denominator: 1n},
};

export function claimUnitFor(unit: string | undefined): ClaimUnit | undefined {
  return unit !== undefined && Object.prototype.hasOwnProperty.call(units, unit) ? units[unit] : undefined;
}
