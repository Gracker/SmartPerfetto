// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonValue[]
  | {[key: string]: CanonicalJsonValue};

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical_json_non_finite_number:${path}`);
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new Error(`canonical_json_unsupported_value:${path}`);
  }
  if (typeof value !== 'object') {
    throw new Error(`canonical_json_unsupported_value:${path}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`canonical_json_cycle:${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        canonicalize(entry, `${path}[${index}]`, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`canonical_json_non_plain_object:${path}`);
    }
    const result: {[key: string]: CanonicalJsonValue} = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // Defined, not assigned: assigning an own `__proto__` key (JSON.parse
      // keeps one) would set the result's prototype and drop that key's data.
      Object.defineProperty(result, key, {
        value: canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  return canonicalize(value, '$', new Set());
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalContentHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonString(value), 'utf8')
    .digest('hex');
}

/**
 * The content hash of `value` as a JSON store keeps it: a round trip first
 * turns what canonicalization rejects (undefined, a Date, a non-finite
 * number) into what the store reads back, so the hash a writer computes is
 * the one a reader recomputes.
 */
export function storedJsonContentHash(value: object): string {
  return canonicalContentHash(JSON.parse(JSON.stringify(value)));
}

export function immutableCanonicalSnapshot<T>(value: T): T {
  const snapshot = canonicalJsonValue(value) as T;
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
