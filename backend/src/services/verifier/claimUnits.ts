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
