// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ArchitectureInfo} from '../agent/detectors/types';

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

/** A restored observation is reusable only by the detector contract and trace that produced it. */
export function restoreArchitectureObservation(
  cache: Map<string, ArchitectureInfo>,
  traceId: string,
  observation: ArchitectureInfo,
): void {
  const scope = observation.detectorScope;
  if (scope?.version === 1 && scope.traceId === traceId &&
      (scope.packageName === null || typeof scope.packageName === 'string')) {
    setLruCacheEntry(cache, traceId, observation);
  }
}

export function architectureForPackage(
  cache: Map<string, ArchitectureInfo>,
  traceId: string,
  packageName?: string,
): ArchitectureInfo | undefined {
  const observation = getLruCacheEntry(cache, traceId);
  if (observation?.detectorScope?.packageName === (packageName || null)) return observation;
  // A failed redetection must not leave the previous package in the session snapshot.
  cache.delete(traceId);
  return undefined;
}
