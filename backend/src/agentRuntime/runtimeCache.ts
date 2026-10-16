// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const DEFAULT_RUNTIME_CACHE_LIMIT = 50;

export function getLruCacheEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

export function setLruCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = DEFAULT_RUNTIME_CACHE_LIMIT,
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const first = cache.keys().next();
    if (first.done) break;
    cache.delete(first.value);
  }
}
