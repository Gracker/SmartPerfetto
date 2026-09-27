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
import { createRenderer, type OutputFormat } from '../repl/renderer';
import { startSession } from '../services/turnRunner';
import { CLI_INTERRUPTED_EXIT_CODE, isTurnInterrupted, processInterruptSource } from '../services/turnInterrupt';
import { assertAnalysisRuntimeReady } from '../services/runtimeGuard';
import { withConsoleLogToStderr } from '../io/stdio';
import type {CodeAwareMode} from '../../services/codebase/codeAwareFeature';
import type {CliAnalysisMode} from '../types';

export interface AnalyzeCommandArgs {
  trace: string;
  query: string;
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
  format?: OutputFormat;
  analysisMode?: CliAnalysisMode;
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
}

export async function runAnalyzeCommand(args: AnalyzeCommandArgs): Promise<number> {
  // Resolve tracePath against the *user's* cwd before bootstrap runs — bootstrap
  // pins cwd to the backend root for consistent service-layer path resolution,
  // which would otherwise change how a relative trace argument gets interpreted.
  const tracePath = path.resolve(args.trace);
  const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor, format: args.format });
  const lifecycle: { service?: CliAnalyzeService } = {};
  let exitCode = 0;

  try {
    await withConsoleLogToStderr(renderer.format !== 'text', async () => {
      const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir });
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      assertAnalysisRuntimeReady();
      const turn = await startSession({ paths, service, renderer, interruptSource: processInterruptSource() }, {
        tracePath,
        query: args.query,
        analysisMode: args.analysisMode,
        codeAwareMode: args.codeAwareMode,
        codebaseIds: args.codebaseIds,
        knowledgeSourceIds: args.knowledgeSourceIds,
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
