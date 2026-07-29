// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

/**
 * Shared, fail-closed environment reader for learning lifecycles.
 *
 * Case Evolution and Self Evolution deliberately share this parser so their
 * enablement and bounded worker settings cannot drift into parallel config
 * semantics.
 */
export class LifecycleConfigReader {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  boolean(key: string): boolean {
    const value = this.env[key];
    return typeof value === 'string' &&
      TRUE_VALUES.has(value.trim().toLowerCase());
  }

  positiveInteger(
    key: string,
    fallback: number,
    options: {min?: number; max?: number} = {},
  ): number {
    const value = this.env[key];
    if (typeof value !== 'string' || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const integer = Math.floor(parsed);
    const minimum = options.min ?? 1;
    if (integer < minimum) return fallback;
    return typeof options.max === 'number'
      ? Math.min(integer, options.max)
      : integer;
  }
}
