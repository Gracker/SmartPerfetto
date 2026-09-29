// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';
import { assertCliEnvironment, type CliEnvironmentArgs } from '../bootstrap';
import { invalidateStrategyCache, loadStrategies } from '../../agentv3/strategyLoader';

/**
 * Runtime self-check for the artifact being invoked.
 *
 * The strategy registry is read from the live `backend/strategies/` directory
 * by the same loader the analysis path uses, so this probe validates the exact
 * parser-plus-files pair a subsequent `analyze` in this artifact would run —
 * a source-tree validator cannot catch a stale `dist/` parser meeting new
 * strategy frontmatter, which kills every session at startup.
 */
export async function runProbeCommand(args: CliEnvironmentArgs = {}): Promise<number> {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : 'unknown';
  console.log('SmartPerfetto Runtime Probe');
  console.log(`entry     ${entry} (${__dirname})`);
  try {
    // The probe vouches for the env a batch run will use; it must not pass
    // when that env failed to load.
    assertCliEnvironment(args);
  } catch (error) {
    console.error(`env FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    // A one-shot process has no warm cache worth keeping; read current files.
    invalidateStrategyCache();
    const strategies = loadStrategies();
    console.log(`strategies OK ${strategies.size} scene(s)`);
    return 0;
  } catch (error) {
    console.error(`strategies FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
