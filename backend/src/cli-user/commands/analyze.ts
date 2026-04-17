// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto analyze <trace>` — one-shot analysis.
 *
 * Thin wrapper: owns the CLI process lifecycle (bootstrap, service
 * construction, shutdown) and delegates the actual work to
 * `turnRunner.startSession`. The same runner is shared by `resume`
 * (via continueSession) and the REPL.
 */

import * as path from 'path';
import { bootstrap } from '../bootstrap';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { createRenderer } from '../repl/renderer';
import { startSession } from '../services/turnRunner';

export interface AnalyzeCommandArgs {
  trace: string;
  query: string;
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
}

export async function runAnalyzeCommand(args: AnalyzeCommandArgs): Promise<number> {
  // Resolve tracePath against the *user's* cwd before bootstrap runs — bootstrap
  // pins cwd to the backend root for consistent service-layer path resolution,
  // which would otherwise change how a relative trace argument gets interpreted.
  const tracePath = path.resolve(args.trace);
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir });
  const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor });
  const service = new CliAnalyzeService();

  try {
    await startSession({ paths, service, renderer }, {
      tracePath,
      query: args.query,
    });
    return 0;
  } catch (err) {
    renderer.printError((err as Error).message);
    return 1;
  } finally {
    await service.shutdown();
  }
}
