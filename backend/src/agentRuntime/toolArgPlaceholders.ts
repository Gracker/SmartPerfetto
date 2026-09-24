// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const PLACEHOLDER_TOOL_STRINGS: ReadonlySet<string> = new Set(['', 'null', 'undefined', 'none']);

/**
 * A string a model sent to fill a tool field it meant to leave empty. Strict
 * tool schemas make a model fill every field, so these arrive in place of an
 * omitted optional argument.
 */
export function isPlaceholderToolString(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER_TOOL_STRINGS.has(value.trim().toLowerCase());
}
