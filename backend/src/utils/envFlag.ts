// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The full spelling set for on/off environment switches: `true` for
 * 1/true/yes/on/enabled, `false` for 0/false/no/off/disabled (case-insensitive,
 * trimmed), `null` when the value is unset or not one of them. Callers decide
 * what unset and unrecognized mean. A switch that accepts this set reads it
 * here rather than keeping a copy; a few single-reader switches deliberately
 * accept less and say so where they are read. Kept free of imports so leaf
 * modules can use it without loading config, which validates the auth
 * environment at import time.
 */
export function parseFlagValue(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return null;
}
