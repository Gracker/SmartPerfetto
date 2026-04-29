#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto` CLI entry point.
 *
 * PR1 surface: `analyze <trace>` only. Commands `resume`/`list`/`show`/
 * `report` land in PR2; REPL (`smartperfetto` with no sub-command) in PR3.
 *
 * All async work routes through command handlers that return an exit code.
 * We call `process.exit(code)` explicitly to ensure the process terminates
 * even if some module has a stray setInterval / active handle we missed.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from './bootstrap';
import { createRenderer } from './repl/renderer';
import { CliAnalyzeService } from './services/cliAnalyzeService';
import { runRepl } from './repl';
import { runAnalyzeCommand } from './commands/analyze';
import { runResumeCommand } from './commands/resume';
import { runListCommand } from './commands/list';
import { runShowCommand } from './commands/show';
import { runReportCommand } from './commands/report';
import { runRmCommand } from './commands/rm';
import { DEFAULT_ANALYSIS_QUERY } from './constants';

interface GlobalOpts {
  sessionDir?: string;
  envFile?: string;
  verbose?: boolean;
  color?: boolean;
  resume?: string;
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function installFatalHandlers(): void {
  process.on('uncaughtException', (err) => {
    console.error(`Fatal: uncaught exception: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`Fatal: unhandled promise rejection: ${message}`);
    if (process.env.DEBUG && reason instanceof Error) console.error(reason.stack);
    process.exit(1);
  });

  process.once('SIGTERM', () => {
    process.exit(143);
  });
}

function main(): void {
  installFatalHandlers();

  const program = new Command();

  program
    .name('smartperfetto')
    .description('SmartPerfetto CLI — terminal-based Android Perfetto trace analysis')
    .version(readPackageVersion())
    .option('--session-dir <path>', 'override session storage root (default: ~/.smartperfetto)')
    .option('--env-file <path>', 'path to .env file (default: backend/.env)')
    .option('--verbose', 'show verbose event stream', false)
    .option('--no-color', 'disable ANSI colors')
    .option('--resume <sessionId>', 'start the REPL with this session already loaded');

  // Shared helper — commander stores --no-color as opts.color === false.
  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const runAndExit = async (fn: () => Promise<number>) => {
    process.exit(await fn());
  };

  program
    .command('analyze <trace>')
    .description('run one-shot analysis against a trace file')
    .option('-q, --query <question>', 'analysis question', DEFAULT_ANALYSIS_QUERY)
    .action(async (trace: string, opts: { query: string }) => {
      const g = globals();
      await runAndExit(() => runAnalyzeCommand({
        trace,
        query: opts.query,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
      }));
    });

  program
    .command('resume <sessionId>')
    .description('continue a prior session with a follow-up question')
    .requiredOption('-q, --query <question>', 'follow-up question')
    .action(async (sessionId: string, opts: { query: string }) => {
      const g = globals();
      await runAndExit(() => runResumeCommand({
        sessionId,
        query: opts.query,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
      }));
    });

  program
    .command('list')
    .description('list stored sessions (most recent first)')
    .option('--json', 'emit JSON instead of a table', false)
    .option('--limit <n>', 'show at most N entries', (v) => parseInt(v, 10))
    .option('--since <date>', 'only entries updated at or after this date (any Date.parse input)')
    .action(async (opts: { json: boolean; limit?: number; since?: string }) => {
      const g = globals();
      await runAndExit(() => runListCommand({
        json: opts.json,
        limit: opts.limit,
        since: opts.since,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        noColor: g.color === false,
      }));
    });

  program
    .command('show <sessionId>')
    .description('print a session\'s latest conclusion and report path')
    .option('--open', 'also open the HTML report in the default browser', false)
    .action(async (sessionId: string, opts: { open: boolean }) => {
      const g = globals();
      await runAndExit(() => runShowCommand({
        sessionId,
        open: opts.open,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  program
    .command('report <sessionId>')
    .description('print the HTML report path, optionally open it')
    .option('--open', 'open the report in the default browser', false)
    .action(async (sessionId: string, opts: { open: boolean }) => {
      const g = globals();
      await runAndExit(() => runReportCommand({
        sessionId,
        open: opts.open,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  program
    .command('rm <sessionId>')
    .description('delete a local session folder (confirmation required)')
    .option('-y, --yes', 'skip confirmation prompt', false)
    .action(async (sessionId: string, opts: { yes: boolean }) => {
      const g = globals();
      await runAndExit(() => runRmCommand({
        sessionId,
        yes: opts.yes,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  // Default: no sub-command → enter REPL. This is the Claude-Code-style
  // interactive path the user asked for; the subcommands above are for
  // scripted / one-shot use.
  program.action(async () => {
    const g = globals();
    const { paths } = bootstrap({ envFile: g.envFile, sessionDir: g.sessionDir });
    const renderer = createRenderer({ verbose: Boolean(g.verbose), useColor: g.color !== false });
    const service = new CliAnalyzeService();
    try {
      await runRepl({ paths, service, renderer }, g.resume);
      process.exit(0);
    } catch (err) {
      console.error(`Fatal: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      await service.shutdown();
    }
  });

  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(`Fatal: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(2);
  });
}

main();
