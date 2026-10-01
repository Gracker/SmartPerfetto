// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Key-sorted copy of a JSON-like value for stable hashing: object keys are
 * sorted and undefined members dropped; everything else is left for
 * JSON.stringify. Objects are built with Object.fromEntries, which defines
 * data properties: assigning `out[key]` would run the inherited `__proto__`
 * setter for the own `__proto__` key JSON.parse and js-yaml produce, and drop
 * that key and its content from the output.
 */
export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(input).sort()
    .filter(key => input[key] !== undefined)
    .map(key => [key, stableJsonValue(input[key])]));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}
