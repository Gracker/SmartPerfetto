// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A self-evolution error reaches admin responses, SSE events and persisted
 * actions as a code. Only an Error whose message already is one survives; any
 * other value or message, such as a parser quoting stored text, is the fallback.
 */
export function selfEvolutionErrorCode(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z0-9_:-]{1,160}$/.test(error.message) ? error.message : fallback;
}
