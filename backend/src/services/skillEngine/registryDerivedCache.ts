// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A bounded cache of state derived from a whole Skill registry, keyed by
 * skillRegistryCacheKey: a changed registry is a different key, so nothing is
 * invalidated by hand. The few registries a process holds at once (built-in,
 * a workspace's effective one, a proposal's candidate) stay resident; the
 * least recently used goes first.
 */
export class RegistryDerivedCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit = 8) {}

  get(key: string, compute: () => T): T {
    if (this.entries.has(key)) {
      const value = this.entries.get(key) as T;
      this.entries.delete(key);
      this.entries.set(key, value);
      return value;
    }
    const value = compute();
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }
}
