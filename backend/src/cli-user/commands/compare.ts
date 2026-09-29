// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { bootstrap, resolveInvocationPath } from '../bootstrap';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { createRenderer, type OutputFormat } from '../repl/renderer';
import { startSession } from '../services/turnRunner';
import { CLI_INTERRUPTED_EXIT_CODE, isTurnInterrupted, processInterruptSource } from '../services/turnInterrupt';
import { assertAnalysisRuntimeReady } from '../services/runtimeGuard';
import { withConsoleLogToStderr } from '../io/stdio';
import type {CliAnalysisMode} from '../types';

export interface CompareCommandArgs {
  currentTrace: string;
  referenceTrace: string;
  query: string;
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
  format?: OutputFormat;
  analysisMode?: CliAnalysisMode;
}

export async function runCompareCommand(args: CompareCommandArgs): Promise<number> {
  const currentTracePath = resolveInvocationPath(args.currentTrace);
  const referenceTracePath = resolveInvocationPath(args.referenceTrace);
  const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor, format: args.format });
  const lifecycle: { service?: CliAnalyzeService } = {};
  let exitCode = 0;

  try {
    await withConsoleLogToStderr(renderer.format !== 'text', async () => {
      const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir });
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      assertAnalysisRuntimeReady({ aiFeature: 'agent_analyze' });
      const turn = await startSession({ paths, service, renderer, interruptSource: processInterruptSource() }, {
        tracePath: currentTracePath,
        referenceTracePath,
        query: args.query.trim(),
        analysisMode: args.analysisMode,
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
