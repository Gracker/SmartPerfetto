// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

let generation = 0;

/**
 * Counts this process's writes to the registries an analysis-context
 * authorization reads (codebases and external knowledge sources). A read that
 * a run fence shares within one event-loop turn stays valid only while this
 * count is unchanged, so an in-process consent change or delete is never
 * hidden behind it. A number in memory; no I/O.
 */
export function noteAuthorizationRegistryWrite(): void {
  generation += 1;
}

export function authorizationRegistryWriteGeneration(): number {
  return generation;
}
