// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto resume <sessionId> --query <...>` — continue a prior session.
 *
 * Thin wrapper: shares `turnRunner.continueSession` with the REPL. The
 * three-level degradation (Level 1/2 trace reload, Level 3 fresh-load +
 * preamble) lives in the runner, not here — keep this file boring.
 */

import { bootstrap } from '../bootstrap';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { createRenderer, type OutputFormat } from '../repl/renderer';
import { continueSession } from '../services/turnRunner';
import { CLI_INTERRUPTED_EXIT_CODE, isTurnInterrupted, processInterruptSource } from '../services/turnInterrupt';
import { assertAnalysisRuntimeReady } from '../services/runtimeGuard';
import { withConsoleLogToStderr } from '../io/stdio';
import { loadSession } from '../io/sessionStore';

export interface ResumeCommandArgs {
  sessionId: string;
  query: string;
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
  format?: OutputFormat;
}

export async function runResumeCommand(args: ResumeCommandArgs): Promise<number> {
  const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor, format: args.format });
  const lifecycle: { service?: CliAnalyzeService } = {};
  let exitCode = 0;

  try {
    await withConsoleLogToStderr(renderer.format !== 'text', async () => {
      const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir });
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      const { config } = loadSession(paths, args.sessionId);
      assertAnalysisRuntimeReady(config
        ? { providerId: config.providerId, runtimeOverride: config.agentRuntimeKind, aiFeature: 'agent_resume' }
        : { aiFeature: 'agent_resume' });
      const turn = await continueSession({ paths, service, renderer, interruptSource: processInterruptSource() }, {
        sessionId: args.sessionId,
        query: args.query,
      });
      exitCode = turn.success ? 0 : 1;
    });
    return exitCode;
  } catch (err) {
    renderer.printError((err as Error).message);
    return isTurnInterrupted(err) ? CLI_INTERRUPTED_EXIT_CODE : 1;
  } finally {
    await lifecycle.service?.shutdown();
  }
}
