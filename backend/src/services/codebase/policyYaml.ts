// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Strict readers shared by the policy YAML parsers under backend/strategies. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** A regular expression from policy text; an invalid one fails with the policy's own code. */
export function compilePattern(source: unknown, errorCode: string): RegExp {
  if (typeof source !== 'string' || !source) throw new Error(errorCode);
  try {
    return new RegExp(source);
  } catch {
    throw new Error(errorCode);
  }
}

export function positiveInteger(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(errorCode);
  return Number(value);
}
