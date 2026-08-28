#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto` CLI entry point.
 *
 * All async work routes through command handlers that return an exit code.
 * We call `process.exit(code)` explicitly to ensure the process terminates
 * even if some module has a stray setInterval / active handle we missed.
 */

import {Command, Option} from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from './bootstrap';
import { createRenderer, parseOutputFormat, parseTextJsonFormat, type OutputFormat } from './repl/renderer';
import { CliAnalyzeService } from './services/cliAnalyzeService';
import { runRepl } from './repl';
import { runAnalyzeCommand } from './commands/analyze';
import { runResumeCommand } from './commands/resume';
import { runListCommand } from './commands/list';
import { runShowCommand } from './commands/show';
import { runReportCommand, runReportExportCommand } from './commands/report';
import { runRmCommand } from './commands/rm';
import { runDoctorCommand } from './commands/doctor';
import { runConfigInitCommand } from './commands/config';
import { runProviderListCommand, runProviderTestCommand } from './commands/provider';
import { runQueryCommand } from './commands/query';
import { runSkillCommand } from './commands/skill';
import { runBatchSkillCommand } from './commands/batch';
import { runCompareCommand } from './commands/compare';
import {
  runCaptureAndroidCommand,
  runCaptureConfigCommand,
  runCapturePresetsCommand,
  runCaptureSuggestCommand,
} from './commands/capture';
import { isCapturePresetId } from './services/captureConfig';
import {
  runCodebaseAuditCommand,
  runCodebaseAuthorizeExtensionsCommand,
  runCodebaseAuthorizeSelectionCommand,
  runCodebaseConsentCommand,
  runCodebaseDeleteCommand,
  runCodebaseListCommand,
  runCodebasePendingCommand,
  runCodebasePreviewCommand,
  runCodebaseRegisterCommand,
  runCodebaseReindexCommand,
  runCodebaseSelectionCommand,
  runCodebaseSymbolsCommand,
} from './commands/codebase';
import type {CodebaseOutputFormat} from './commands/codebase';
import {
  runKnowledgePackStatusCommand,
  runKnowledgePackUpdateCommand,
} from './commands/knowledgePack';
import {runUpdateCheckCommand} from './commands/update';
import {beginCliUpdateNotice} from './updateNotice';
import { DEFAULT_ANALYSIS_QUERY } from './constants';
import type {CodeAwareMode} from '../services/codebase/codeAwareFeature';
import type {CapturePresetId, CliAnalysisMode} from './types';

interface GlobalOpts {
  file?: string;
  prompt?: string;
  query?: string;
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

function programName(): string {
  const invoked = path.basename(process.argv[1] || '');
  if (!invoked || invoked === 'bin.js' || invoked === 'bin.ts') return 'smp';
  return invoked;
}

function main(): void {
  installFatalHandlers();

  const program = new Command();

  program
    .name(programName())
    .description('SmartPerfetto CLI — terminal-based Android Perfetto trace analysis')
    .version(readPackageVersion())
    .option('-f, --file <trace>', 'trace file to analyze (shortcut for `analyze <trace>`)')
    .option('-p, --prompt <question>', 'analysis prompt (shortcut for --query)')
    .option('-q, --query <question>', 'analysis question (alias for --prompt)')
    .option('--session-dir <path>', 'override session storage root (default: ~/.smartperfetto)')
    .option('--env-file <path>', 'path to explicit .env file (skips default env chain)')
    .option('--verbose', 'show verbose event stream', false)
    .option('--no-color', 'disable ANSI colors')
    .option('--resume <sessionId>', 'start the REPL with this session already loaded');

  // Shared helper — commander stores --no-color as opts.color === false.
  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const format = (commandFormat?: string): OutputFormat => parseOutputFormat(commandFormat);
  const textJsonFormat = (commandFormat?: string) => parseTextJsonFormat(commandFormat);
  const runAndExit = async (fn: () => Promise<number>) => {
    const g = globals();
    const notice = beginCliUpdateNotice({
      bootstrapOptions: {envFile: g.envFile, sessionDir: g.sessionDir},
    });
    const exitCode = await fn();
    notice.flush();
    process.exit(exitCode);
  };
  const collectRepeatedOption = (value: string, previous: string[] = []): string[] => [...previous, value];
  const codeAwareMode = (value?: string): CodeAwareMode | undefined => {
    if (!value) return undefined;
    if (value === 'off' || value === 'metadata_only' || value === 'provider_send') return value;
    throw new Error(`Invalid code-aware mode: ${value}. Expected off, metadata_only, or provider_send.`);
  };

  program
    .command('run <trace> [question...]')
    .description('run one-shot analysis against a trace file')
    .option('--format <format>', 'output format: text, json, ndjson')
    .option('--mode <mode>', 'analysis mode: fast, full, auto')
    .option('--code-aware <mode>', 'code-aware mode: off, metadata_only, provider_send')
    .option('--codebase-id <id>', 'registered codebase id to expose to the analysis session', collectRepeatedOption, [])
    .option('--knowledge-source-id <id>', 'registered private knowledge source id to expose', collectRepeatedOption, [])
    .action(async (trace: string, question: string[] | undefined, opts: { format?: string; mode?: string; codeAware?: string; codebaseId?: string[]; knowledgeSourceId?: string[] }) => {
      const g = globals();
      await runAndExit(() => runAnalyzeCommand({
        trace,
        query: joinQuestion(question, DEFAULT_ANALYSIS_QUERY),
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
        analysisMode: parseAnalysisMode(opts.mode),
        codeAwareMode: codeAwareMode(opts.codeAware),
        codebaseIds: opts.codebaseId,
        knowledgeSourceIds: opts.knowledgeSourceId,
      }));
    });

  program
    .command('analyze <trace>')
    .description('run one-shot analysis against a trace file')
    .option('-q, --query <question>', 'analysis question', DEFAULT_ANALYSIS_QUERY)
    .option('--format <format>', 'output format: text, json, ndjson')
    .option('--mode <mode>', 'analysis mode: fast, full, auto')
    .option('--code-aware <mode>', 'code-aware mode: off, metadata_only, provider_send')
    .option('--codebase-id <id>', 'registered codebase id to expose to the analysis session', collectRepeatedOption, [])
    .option('--knowledge-source-id <id>', 'registered private knowledge source id to expose', collectRepeatedOption, [])
    .action(async (trace: string, opts: { query?: string; format?: string; mode?: string; codeAware?: string; codebaseId?: string[]; knowledgeSourceId?: string[] }) => {
      const g = globals();
      const query = g.prompt ?? g.query ?? opts.query ?? DEFAULT_ANALYSIS_QUERY;
      await runAndExit(() => runAnalyzeCommand({
        trace,
        query,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
        analysisMode: parseAnalysisMode(opts.mode),
        codeAwareMode: codeAwareMode(opts.codeAware),
        codebaseIds: opts.codebaseId,
        knowledgeSourceIds: opts.knowledgeSourceId,
      }));
    });

  program
    .command('ask <sessionId> <question...>')
    .description('continue a prior session with a follow-up question')
    .option('--format <format>', 'output format: text, json, ndjson')
    .action(async (sessionId: string, question: string[], opts: { format?: string }) => {
      const g = globals();
      await runAndExit(() => runResumeCommand({
        sessionId,
        query: joinQuestion(question, ''),
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
      }));
    });

  program
    .command('resume <sessionId>')
    .description('continue a prior session with a follow-up question')
    .option('-q, --query <question>', 'follow-up question')
    .option('--format <format>', 'output format: text, json, ndjson')
    .action(async (sessionId: string, opts: { query?: string; format?: string }) => {
      const g = globals();
      const query = opts.query ?? g.query ?? g.prompt;
      if (!query?.trim()) {
        console.error('Fatal: resume requires --query <question>.');
        process.exit(2);
      }
      await runAndExit(() => runResumeCommand({
        sessionId,
        query,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
      }));
    });

  program
    .command('repl')
    .description('start the SmartPerfetto interactive CLI')
    .option('--resume <sessionId>', 'start with this session already loaded')
    .action(async (opts: { resume?: string }) => {
      const g = globals();
      await runAndExit(() => runReplCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        resume: opts.resume ?? g.resume,
      }));
    });

  program
    .command('doctor')
    .description('diagnose CLI runtime, provider, and trace processor setup')
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: { format?: string }) => {
      const g = globals();
      await runAndExit(() => runDoctorCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });

  const configCmd = program.command('config').description('manage SmartPerfetto CLI configuration');
  configCmd
    .command('init')
    .description('create ~/.smartperfetto/env template')
    .option('--force', 'overwrite existing config', false)
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: { force: boolean; format?: string }) => {
      const g = globals();
      await runAndExit(() => runConfigInitCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        force: opts.force,
        format: textJsonFormat(opts.format),
      }));
    });

  const providerCmd = program.command('provider').description('inspect and test configured providers');
  providerCmd
    .command('list')
    .description('list configured providers')
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: { format?: string }) => {
      const g = globals();
      await runAndExit(() => runProviderListCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });
  providerCmd
    .command('test [target]')
    .description('test a provider id, or the resolved system runtime')
    .option('--format <format>', 'output format: text or json')
    .action(async (target: string | undefined, opts: { format?: string }) => {
      const g = globals();
      await runAndExit(() => runProviderTestCommand({
        target,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });

  program
    .command('list')
    .description('list stored sessions (most recent first)')
    .option('--json', 'emit JSON instead of a table', false)
    .option('--format <format>', 'output format: text or json')
    .option('--limit <n>', 'show at most N entries', (v) => parseInt(v, 10))
    .option('--since <date>', 'only entries updated at or after this date (any Date.parse input)')
    .action(async (opts: { json: boolean; format?: string; limit?: number; since?: string }) => {
      const g = globals();
      const outputFormat = textJsonFormat(opts.format);
      await runAndExit(() => runListCommand({
        json: opts.json || outputFormat !== 'text',
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

  const reportCmd = program
    .command('report')
    .description('print the HTML report path, optionally open it')
    .argument('[sessionId]', 'session id')
    .option('--open', 'open the report in the default browser', false)
    .option('--turn <number>', 'print/open an immutable per-turn HTML report', parsePositiveInteger)
    .action(async (sessionId: string | undefined, opts: { open: boolean; turn?: number }, command: Command) => {
      if (!sessionId) {
        command.help({ error: true });
        return;
      }
      const g = globals();
      await runAndExit(() => runReportCommand({
        sessionId,
        open: opts.open,
        turn: opts.turn,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });
  reportCmd
    .command('export <sessionId>')
    .description('export a session report as html, markdown, or json')
    .requiredOption('--format <format>', 'export format: html, md, json')
    .requiredOption('--out <path>', 'output file path')
    .option('--turn <number>', 'export an immutable per-turn report snapshot', parsePositiveInteger)
    .action(async (sessionId: string, opts: { format: string; out: string; turn?: number }, command: Command) => {
      const g = globals();
      const exportFormat = parseReportExportFormat(opts.format);
      const parentTurn = command.parent?.opts<{ turn?: number }>().turn;
      await runAndExit(() => runReportExportCommand({
        sessionId,
        format: exportFormat,
        out: opts.out,
        turn: opts.turn ?? parentTurn,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  const codebaseCmd = program.command('codebase').description('manage local codebases for code-aware analysis');
  codebaseCmd
    .command('list')
    .description('list registered codebases')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (opts: {format: CodebaseOutputFormat}) => {
      const g = globals();
      await runAndExit(() => runCodebaseListCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: opts.format,
      }));
    });

  const knowledgePackCmd = program
    .command('knowledge-pack')
    .description('inspect or update the signed Android Internals Knowledge Pack');
  knowledgePackCmd
    .command('status')
    .description('show the active, bundled, and signed-channel Pack state')
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: {format?: string}) => {
      const g = globals();
      await runAndExit(() => runKnowledgePackStatusCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format) === 'json' ? 'json' : 'text',
      }));
    });

  const updateCmd = program
    .command('update')
    .description('check for a newer SmartPerfetto CLI release');
  updateCmd
    .command('check')
    .description('check npm for the latest stable SmartPerfetto version')
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: {format?: string}) => {
      const g = globals();
      await runAndExit(() => runUpdateCheckCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });
  knowledgePackCmd
    .command('update')
    .description('refresh TUF metadata and atomically install the stable Pack')
    .option('--check', 'check for an update without installing it', false)
    .option('--format <format>', 'output format: text or json')
    .action(async (opts: {check?: boolean; format?: string}) => {
      const g = globals();
      await runAndExit(() => runKnowledgePackUpdateCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        checkOnly: opts.check,
        format: textJsonFormat(opts.format) === 'json' ? 'json' : 'text',
      }));
    });

  codebaseCmd
    .command('preview <rootPath>')
    .description('preview files accepted by the path security gate')
    .option('--kind <kind>', 'codebase kind: app_source, aosp, kernel_source, oem_sdk', 'app_source')
    .option('--path-filter <prefix>', 'relative path prefix; repeatable', collectRepeatedOption, [])
    .option('--exclude-glob <glob>', 'relative exclusion glob; repeatable', collectRepeatedOption, [])
    .action(async (rootPath: string, opts: {
      kind?: string;
      pathFilter?: string[];
      excludeGlob?: string[];
    }) => {
      const g = globals();
      await runAndExit(() => runCodebasePreviewCommand({
        rootPath,
        kind: parseCodebaseKind(opts.kind),
        pathFilters: opts.pathFilter,
        excludeGlobs: opts.excludeGlob,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('register <rootPath>')
    .description('register a local app/AOSP/kernel source codebase')
    .option('--kind <kind>', 'codebase kind: app_source, aosp, kernel_source, oem_sdk', 'app_source')
    .option('--name <name>', 'display name')
    .option('--send-to-provider', 'allow snippets to be sent when the session also uses provider_send mode', false)
    .option('--path-filter <prefix>', 'relative path prefix to ingest; repeatable', collectRepeatedOption, [])
    .option('--exclude-glob <glob>', 'relative exclusion glob; repeatable', collectRepeatedOption, [])
    .option('--vendor <vendor>', 'vendor id for kernel/OEM codebases')
    .option('--build-id <id>', 'build id for source/symbol matching')
    .option('--commit <hash>', 'commit hash pinned to the registered source tree')
    .option('--license <id>', 'license tag for source chunks, for example Apache-2.0 or GPL-2.0-only')
    .option('--dry-run', 'preview the registration without writing registry state', false)
    .action(async (rootPath: string, opts: {
      kind?: string;
      name?: string;
      sendToProvider?: boolean;
      pathFilter?: string[];
      excludeGlob?: string[];
      vendor?: string;
      buildId?: string;
      commit?: string;
      license?: string;
      dryRun?: boolean;
    }) => {
      const g = globals();
      const kind = parseCodebaseKind(opts.kind);
      await runAndExit(() => runCodebaseRegisterCommand({
        rootPath,
        kind,
        name: opts.name,
        sendToProvider: opts.sendToProvider,
        pathFilters: opts.pathFilter,
        excludeGlobs: opts.excludeGlob,
        vendor: opts.vendor,
        buildId: opts.buildId,
        commitHash: opts.commit,
        licenseTag: opts.license,
        dryRun: opts.dryRun,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('selection <codebaseId>')
    .description('replace the registered source selection policy')
    .option('--path-filter <prefix>', 'replacement relative path prefix; repeatable', collectRepeatedOption)
    .option('--exclude-glob <glob>', 'replacement relative exclusion glob; repeatable', collectRepeatedOption)
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {
      pathFilter?: string[];
      excludeGlob?: string[];
      format: CodebaseOutputFormat;
    }) => {
      const g = globals();
      await runAndExit(() => runCodebaseSelectionCommand({
        codebaseId,
        pathFilters: opts.pathFilter,
        excludeGlobs: opts.excludeGlob,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('consent <codebaseId>')
    .description('enable or disable provider-send consent')
    .addOption(new Option('--enable', 'enable provider-send consent').conflicts('disable'))
    .addOption(new Option('--disable', 'disable provider-send consent').conflicts('enable'))
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {
      enable?: boolean;
      disable?: boolean;
      format: CodebaseOutputFormat;
    }) => {
      const g = globals();
      await runAndExit(() => runCodebaseConsentCommand({
        codebaseId,
        enable: opts.enable,
        disable: opts.disable,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('authorize-extensions <codebaseId>')
    .description('authorize every currently available source extension')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {format: CodebaseOutputFormat}) => {
      const g = globals();
      await runAndExit(() => runCodebaseAuthorizeExtensionsCommand({
        codebaseId,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('authorize-selection <codebaseId>')
    .description('authorize the current source path selection')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {format: CodebaseOutputFormat}) => {
      const g = globals();
      await runAndExit(() => runCodebaseAuthorizeSelectionCommand({
        codebaseId,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('pending <codebaseId>')
    .description('accept or reject an exact staged index candidate')
    .addOption(new Option('--accept', 'accept the staged candidate').conflicts('reject'))
    .addOption(new Option('--reject', 'reject the staged candidate').conflicts('accept'))
    .requiredOption('--candidate <id>', 'exact pending candidate generation id')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {
      accept?: boolean;
      reject?: boolean;
      candidate: string;
      format: CodebaseOutputFormat;
    }) => {
      const g = globals();
      await runAndExit(() => runCodebasePendingCommand({
        codebaseId,
        accept: opts.accept,
        reject: opts.reject,
        candidateId: opts.candidate,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('audit <codebaseId>')
    .description('show safe codebase lifecycle and index audit state')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {format: CodebaseOutputFormat}) => {
      const g = globals();
      await runAndExit(() => runCodebaseAuditCommand({
        codebaseId,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('delete <codebaseId>')
    .description('delete a codebase registration and every indexed generation')
    .requiredOption('--yes', 'confirm permanent codebase deletion')
    .option('--format <format>', 'output format: table or json', parseCodebaseOutputFormat, 'table')
    .action(async (codebaseId: string, opts: {yes: boolean; format: CodebaseOutputFormat}) => {
      const g = globals();
      await runAndExit(() => runCodebaseDeleteCommand({
        codebaseId,
        yes: opts.yes,
        format: opts.format,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('reindex <codebaseId>')
    .description('index registered app source files into the RAG store')
    .action(async (codebaseId: string) => {
      const g = globals();
      await runAndExit(() => runCodebaseReindexCommand({
        codebaseId,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  codebaseCmd
    .command('symbols <symbol>')
    .description('resolve a symbol against indexed app source chunks')
    .option('--codebase-id <id>', 'restrict to one registered codebase id')
    .action(async (symbol: string, opts: {codebaseId?: string}) => {
      const g = globals();
      await runAndExit(() => runCodebaseSymbolsCommand({
        symbol,
        codebaseId: opts.codebaseId,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
      }));
    });

  program
    .command('query <trace>')
    .description('run SQL against a trace using trace_processor_shell')
    .requiredOption('--sql <sql>', 'SQL to execute')
    .option('--format <format>', 'output format: text, json, ndjson')
    .action(async (trace: string, opts: { sql: string; format?: string }) => {
      const g = globals();
      await runAndExit(() => runQueryCommand({
        trace,
        sql: opts.sql,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: format(opts.format),
      }));
    });

  program
    .command('skill <trace> <skillId>')
    .description('execute a SmartPerfetto skill against a trace')
    .option('--params <json>', 'skill params as a JSON object')
    .option('--format <format>', 'output format: text, json, ndjson')
    .action(async (trace: string, skillId: string, opts: { params?: string; format?: string }) => {
      const g = globals();
      await runAndExit(() => runSkillCommand({
        trace,
        skillId,
        params: opts.params,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: format(opts.format),
      }));
    });

  const batchCmd = program.command('batch').description('run deterministic batch workflows');
  batchCmd
    .command('skill <skillId> [trace...]')
    .description('execute a SmartPerfetto skill across a bounded local trace set')
    .option('--trace-list <file>', 'file containing one trace path per line')
    .option('--params <json>', 'skill params as a JSON object')
    .option('--concurrency <n>', 'max local trace concurrency')
    .option('--format <format>', 'output format: text, json, ndjson')
    .option('--out <html>', 'write HTML report to this path')
    .option('--json-out <json>', 'write JSON result to this path')
    .action(async (skillId: string, traces: string[] | undefined, opts: {
      traceList?: string;
      params?: string;
      concurrency?: string;
      format?: string;
      out?: string;
      jsonOut?: string;
    }) => {
      const g = globals();
      await runAndExit(() => runBatchSkillCommand({
        skillId,
        traces: traces ?? [],
        traceList: opts.traceList,
        params: opts.params,
        concurrency: opts.concurrency,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: format(opts.format),
        out: opts.out,
        jsonOut: opts.jsonOut,
      }));
    });

  program
    .command('compare <currentTrace> <referenceTrace>')
    .description('compare two traces with AI-assisted analysis')
    .option('-q, --query <question>', 'comparison question')
    .option('--format <format>', 'output format: text, json, ndjson')
    .option('--mode <mode>', 'analysis mode: fast, full, auto')
    .action(async (currentTrace: string, referenceTrace: string, opts: { query?: string; format?: string; mode?: string }) => {
      const g = globals();
      const query = opts.query ?? g.query;
      if (!query?.trim()) {
        console.error('Fatal: compare requires --query <question>.');
        process.exit(2);
      }
      await runAndExit(() => runCompareCommand({
        currentTrace,
        referenceTrace,
        query,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
        analysisMode: parseAnalysisMode(opts.mode),
      }));
    });

  const captureCmd = program.command('capture').description('capture traces from local devices');
  captureCmd
    .command('presets')
    .description('list built-in trace capture presets')
    .option('--format <format>', 'output format: text, json')
    .action(async (opts: { format?: string }) => {
      const g = globals();
      await runAndExit(() => runCapturePresetsCommand({
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });
  captureCmd
    .command('suggest <request...>')
    .description('suggest a side-effect-free Android trace config proposal')
    .option('--app <package>', 'target Android package name or *', '*')
    .option('--duration <seconds>', 'capture duration in seconds', (v) => Number.parseFloat(v))
    .option('--categories <category...>', 'additional atrace categories to include in the proposal')
    .option('--cuj <name>', 'optional CUJ name to annotate generated config metadata')
    .option('--format <format>', 'output format: text, json')
    .action(async (requestParts: string[], opts: { app?: string; duration?: number; categories?: string[]; cuj?: string; format?: string }) => {
      const g = globals();
      await runAndExit(() => runCaptureSuggestCommand({
        request: requestParts.join(' '),
        app: opts.app,
        durationSeconds: opts.duration,
        categories: opts.categories,
        cuj: opts.cuj,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });
  captureCmd
    .command('config')
    .description('render a built-in Android Perfetto trace config')
    .requiredOption('--preset <preset>', 'capture preset', parseCapturePreset)
    .option('--app <package>', 'target Android package name or *', '*')
    .option('--duration <seconds>', 'capture duration in seconds', (v) => Number.parseFloat(v))
    .option('--out <file>', 'write config to a file instead of stdout')
    .option('--categories <category...>', 'additional atrace categories to inject')
    .option('--cuj <name>', 'optional CUJ name to annotate generated config metadata')
    .option('--format <format>', 'output format: text, json')
    .action(async (opts: { preset: CapturePresetId; app?: string; duration?: number; out?: string; categories?: string[]; cuj?: string; format?: string }) => {
      const g = globals();
      await runAndExit(() => runCaptureConfigCommand({
        preset: opts.preset,
        app: opts.app,
        durationSeconds: opts.duration,
        out: opts.out,
        categories: opts.categories,
        cuj: opts.cuj,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        format: textJsonFormat(opts.format),
      }));
    });
  captureCmd
    .command('android')
    .description('capture an Android Perfetto trace from a connected adb device')
    .option('--preset <preset>', 'capture preset: startup, scrolling, camera, anr, game, memory, cpu, power, overview, full', parseCapturePreset)
    .option('--config <pbtxt>', 'existing Perfetto textproto config file')
    .option('--app <package>', 'target Android package name or *')
    .requiredOption('--out <file>', 'output trace file path')
    .option('--duration <seconds>', 'capture duration in seconds', (v) => Number.parseFloat(v))
    .option('--serial <serial>', 'adb device serial when multiple devices are connected')
    .option('--sideload', 'force sideloading tracebox instead of using device perfetto', false)
    .option('--tracebox <path>', 'tracebox binary to sideload when needed')
    .option('--adb <path>', 'adb binary path for this command (overrides ADB_PATH)')
    .option('--no-guardrails', 'pass --no-guardrails to perfetto')
    .option('--kill-stale', 'kill stale perfetto/simpleperf/traced processes before capture', false)
    .option('--analyze', 'run SmartPerfetto AI analysis after capture', false)
    .option('-q, --query <question>', 'analysis question when --analyze is set')
    .option('--mode <mode>', 'analysis mode for --analyze: fast, full, auto')
    .option('--categories <category...>', 'additional atrace categories to inject into generated or textproto config')
    .option('--cuj <name>', 'optional CUJ name to annotate generated config metadata')
    .option('--format <format>', 'output format: text, json, ndjson')
    .action(async (opts: {
      preset?: CapturePresetId;
      config?: string;
      app?: string;
      out: string;
      duration?: number;
      serial?: string;
      sideload?: boolean;
      tracebox?: string;
      adb?: string;
      guardrails?: boolean;
      killStale?: boolean;
      analyze?: boolean;
      query?: string;
      mode?: string;
      categories?: string[];
      cuj?: string;
      format?: string;
    }) => {
      const g = globals();
      await runAndExit(() => runCaptureAndroidCommand({
        app: opts.app,
        preset: opts.preset,
        config: opts.config,
        durationSeconds: opts.duration,
        out: opts.out,
        serial: opts.serial,
        sideload: opts.sideload,
        tracebox: opts.tracebox,
        adb: opts.adb,
        noGuardrails: opts.guardrails === false,
        killStale: opts.killStale,
        analyze: opts.analyze,
        query: opts.query ?? g.query ?? g.prompt,
        analysisMode: parseAnalysisMode(opts.mode),
        categories: opts.categories,
        cuj: opts.cuj,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(opts.format),
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
    if (g.file) {
      await runAndExit(() => runAnalyzeCommand({
        trace: g.file!,
        query: g.prompt || g.query || DEFAULT_ANALYSIS_QUERY,
        envFile: g.envFile,
        sessionDir: g.sessionDir,
        verbose: Boolean(g.verbose),
        noColor: g.color === false,
        format: format(),
      }));
      return;
    }
    if (g.prompt || g.query) {
      console.error('Fatal: --prompt/--query requires --file <trace> for one-shot analysis.');
      process.exit(2);
    }

    await runAndExit(() => runReplCommand({
      envFile: g.envFile,
      sessionDir: g.sessionDir,
      verbose: Boolean(g.verbose),
      noColor: g.color === false,
      resume: g.resume,
    }));
  });

  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(`Fatal: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(2);
  });
}

async function runReplCommand(args: {
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
  resume?: string;
}): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir });
  const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor, format: 'text' });
  const service = new CliAnalyzeService();
  try {
    await runRepl({ paths, service, renderer }, args.resume);
    return 0;
  } catch (err) {
    console.error(`Fatal: ${(err as Error).message}`);
    return 1;
  } finally {
    await service.shutdown();
  }
}

function joinQuestion(parts: string[] | undefined, fallback: string): string {
  const joined = (parts ?? []).join(' ').trim();
  return joined || fallback;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function parseReportExportFormat(format: string): 'html' | 'md' | 'json' {
  if (format === 'html' || format === 'md' || format === 'json') return format;
  throw new Error(`Invalid report export format: ${format}. Expected html, md, or json.`);
}

function parseAnalysisMode(mode: string | undefined): CliAnalysisMode | undefined {
  if (!mode) return undefined;
  if (mode === 'fast' || mode === 'full' || mode === 'auto') return mode;
  throw new Error(`Invalid analysis mode: ${mode}. Expected fast, full, or auto.`);
}

function parseCapturePreset(preset: string): CapturePresetId {
  if (isCapturePresetId(preset)) return preset;
  throw new Error(`Invalid capture preset: ${preset}. Expected startup, scrolling, camera, anr, game, memory, cpu, power, overview, or full.`);
}

function parseCodebaseKind(kind: string | undefined): 'app_source' | 'aosp' | 'kernel_source' | 'oem_sdk' {
  if (kind === 'app_source' || kind === 'aosp' || kind === 'kernel_source' || kind === 'oem_sdk') return kind;
  throw new Error(`Invalid codebase kind: ${kind}. Expected app_source, aosp, kernel_source, or oem_sdk.`);
}

function parseCodebaseOutputFormat(format: string): CodebaseOutputFormat {
  if (format === 'table' || format === 'json') return format;
  throw new Error(`Invalid codebase output format: ${format}. Expected table or json.`);
}

main();
