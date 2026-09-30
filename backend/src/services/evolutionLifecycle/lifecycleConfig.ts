// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

/**
 * Shared, fail-closed environment reader for learning lifecycles.
 *
 * Case retrieval and Self-Evolution read every enablement flag through this
 * parser, and the run manifest records them through the same loaders, so the
 * record cannot drift from the gate.
 */
export class LifecycleConfigReader {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  boolean(key: string): boolean {
    const value = this.env[key];
    return typeof value === 'string' &&
      TRUE_VALUES.has(value.trim().toLowerCase());
  }
}
