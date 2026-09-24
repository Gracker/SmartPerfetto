// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { createRenderer } from '../repl/renderer';
import { withConsoleLogToStderr } from '../io/stdio';
import { assertAnalysisRuntimeReady } from '../services/runtimeGuard';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { startSession } from '../services/turnRunner';
import {
  addAtraceCategories,
  getCapturePreset,
  isCapturePresetId,
  listCapturePresets,
  readTraceConfigFile,
  renderAndroidTraceConfig,
} from '../services/captureConfig';
import { buildTraceConfigProposal } from '../../services/traceConfigProposal';
import {
  captureAndroidTrace,
  type AdbCommandRunner,
} from '../services/androidCapture';
import type {
  CapturePresetId,
  CliAnalysisMode,
  TraceCaptureResult,
} from '../types';
import { DEFAULT_ANALYSIS_QUERY } from '../constants';

export interface CaptureAndroidCommandArgs {
  app?: string;
  preset?: CapturePresetId;
  config?: string;
  durationSeconds?: number;
  out: string;
  serial?: string;
  sideload?: boolean;
  tracebox?: string;
  adb?: string;
  noGuardrails?: boolean;
  killStale?: boolean;
  analyze?: boolean;
  query?: string;
  analysisMode?: CliAnalysisMode;
  categories?: string[];
  cuj?: string;
  envFile?: string;
  sessionDir?: string;
  verbose: boolean;
  noColor: boolean;
  format?: OutputFormat;
  runner?: AdbCommandRunner;
}

export interface CaptureConfigCommandArgs {
  preset: CapturePresetId;
  app?: string;
  durationSeconds?: number;
  out?: string;
  cuj?: string;
  categories?: string[];
  format?: OutputFormat;
  envFile?: string;
  sessionDir?: string;
}

export interface CapturePresetsCommandArgs {
  format?: OutputFormat;
  envFile?: string;
  sessionDir?: string;
}

export interface CaptureSuggestCommandArgs {
  request: string;
  app?: string;
  durationSeconds?: number;
  categories?: string[];
  cuj?: string;
  format?: OutputFormat;
  envFile?: string;
  sessionDir?: string;
}

export async function runCaptureAndroidCommand(args: CaptureAndroidCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  const outPath = path.resolve(args.out);
  const lifecycle: { service?: CliAnalyzeService } = {};

  try {
    if (args.analyze) {
      await withConsoleLogToStderr(format !== 'text', async () => {
        assertAnalysisRuntimeReady({ aiFeature: 'capture_analyze' });
      });
    }
    const configInput = resolveAndroidConfigInput(args);
    if (format === 'text') {
      const preset = configInput.preset ? ` preset=${configInput.preset}` : '';
      const source = configInput.configPath ? ` config=${configInput.configPath}` : preset;
      console.log(`capturing Android trace${source} -> ${outPath}`);
    } else if (format === 'ndjson') {
      console.log(JSON.stringify({
        type: 'capture_start',
        target: 'android',
        preset: configInput.preset,
        configPath: configInput.configPath,
        out: outPath,
      }));
    }

    const capture = await captureAndroidTrace({
      configText: configInput.configText,
      configPath: configInput.configPath,
      configDurationMs: configInput.configDurationMs,
      app: args.app,
      preset: configInput.preset,
      durationSeconds: configInput.durationSeconds,
      out: outPath,
      serial: args.serial,
      sideload: args.sideload,
      traceboxPath: args.tracebox,
      noGuardrails: args.noGuardrails,
      adbPath: args.adb,
      killStale: args.killStale,
      backendRoot: process.cwd(),
      runner: args.runner,
    });

    if (!args.analyze) {
      printCaptureResult(format, capture);
      return 0;
    }
    printPreflightWarnings(format, capture);

    const renderer = createRenderer({ verbose: args.verbose, useColor: !args.noColor, format });
    const query = args.query?.trim() || DEFAULT_ANALYSIS_QUERY;
    let exitCode = 0;
    await withConsoleLogToStderr(renderer.format !== 'text', async () => {
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      const turn = await startSession({ paths, service, renderer }, {
        tracePath: capture.out,
        query,
        analysisMode: args.analysisMode,
        capture,
      });
      capture.analysis = {
        sessionId: turn.sessionId,
        sessionDir: turn.sessionDir,
        turn: turn.turn,
        success: turn.success,
      };
      exitCode = turn.success ? 0 : 1;
    });
    return exitCode;
  } catch (err) {
    printError(format, (err as Error).message);
    return 1;
  } finally {
    await lifecycle.service?.shutdown();
  }
}

export async function runCapturePresetsCommand(args: CapturePresetsCommandArgs): Promise<number> {
  bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  const presets = listCapturePresets();
  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify({ ok: true, presets }, null, format === 'json' ? 2 : 0));
    return 0;
  }
  console.log('SmartPerfetto capture presets');
  const idWidth = Math.max(10, ...presets.map((preset) => preset.id.length));
  for (const preset of presets) {
    console.log(`${preset.id.padEnd(idWidth)} ${preset.label} (${preset.defaultDurationSeconds}s)`);
    console.log(`  ${preset.description}`);
  }
  return 0;
}

export async function runCaptureConfigCommand(args: CaptureConfigCommandArgs): Promise<number> {
  bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  try {
    const preset = getCapturePreset(args.preset);
    const durationSeconds = args.durationSeconds ?? preset.defaultDurationSeconds;
    const configText = renderAndroidTraceConfig({
      target: 'android',
      preset: args.preset,
      app: args.app,
      durationSeconds,
      cuj: args.cuj,
      extraAtraceCategories: args.categories,
    });
    if (args.out) {
      const outPath = path.resolve(args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, configText, 'utf-8');
      if (format === 'json' || format === 'ndjson') {
        console.log(JSON.stringify({ ok: true, preset: args.preset, out: outPath }, null, format === 'json' ? 2 : 0));
      } else {
        console.log(outPath);
      }
    } else {
      if (format === 'json' || format === 'ndjson') {
        console.log(JSON.stringify({ ok: true, preset: args.preset, config: configText }, null, format === 'json' ? 2 : 0));
      } else {
        process.stdout.write(configText);
      }
    }
    return 0;
  } catch (err) {
    printError(format, (err as Error).message);
    return 1;
  }
}

export async function runCaptureSuggestCommand(args: CaptureSuggestCommandArgs): Promise<number> {
  bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const format = args.format ?? 'text';
  try {
    const proposal = buildTraceConfigProposal({
      request: args.request,
      app: args.app,
      durationSeconds: args.durationSeconds,
      categories: args.categories,
      cuj: args.cuj,
    });
    if (format === 'json' || format === 'ndjson') {
      console.log(JSON.stringify({ ok: true, type: 'trace_config_proposal', proposal }, null, format === 'json' ? 2 : 0));
      return 0;
    }
    printTraceConfigProposal(proposal);
    return 0;
  } catch (err) {
    printError(format, (err as Error).message);
    return 1;
  }
}

function resolveAndroidConfigInput(args: CaptureAndroidCommandArgs): {
  configText: string;
  configPath?: string;
  configDurationMs?: number;
  preset?: CapturePresetId;
  durationSeconds?: number;
} {
  if (args.config) {
    const config = readTraceConfigFile(args.config, { durationSeconds: args.durationSeconds });
    const configText = addAtraceCategories(config.textproto, args.categories ?? []);
    return {
      configText,
      configPath: config.path,
      configDurationMs: extractDurationFromText(configText, config.durationMs),
      durationSeconds: args.durationSeconds,
    };
  }

  if (!args.app?.trim()) {
    throw new Error('--app <package|*> is required when --config is not provided');
  }
  const preset = args.preset ?? 'overview';
  if (!isCapturePresetId(preset)) {
    throw new Error(`invalid --preset ${preset}`);
  }
  const definition = getCapturePreset(preset);
  const durationSeconds = args.durationSeconds ?? definition.defaultDurationSeconds;
  return {
    configText: renderAndroidTraceConfig({
      target: 'android',
      preset,
      app: args.app,
      durationSeconds,
      extraAtraceCategories: args.categories,
      cuj: args.cuj,
    }),
    preset,
    durationSeconds,
  };
}

function printCaptureResult(format: OutputFormat, capture: TraceCaptureResult): void {
  printPreflightWarnings(format, capture);
  if (format === 'json' || format === 'ndjson') {
    console.log(JSON.stringify({ ok: true, type: 'capture_complete', capture }, null, format === 'json' ? 2 : 0));
    return;
  }
  console.log(capture.out);
}

function printPreflightWarnings(format: OutputFormat, capture: TraceCaptureResult): void {
  if (format !== 'text') return;
  for (const warning of capture.preflight?.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }
}

function printTraceConfigProposal(proposal: ReturnType<typeof buildTraceConfigProposal>): void {
  console.log('SmartPerfetto trace config proposal');
  console.log(`preset     ${proposal.preset} (${proposal.presetLabel})`);
  console.log(`confidence ${proposal.confidence}`);
  console.log(`app        ${proposal.app}`);
  console.log(`duration   ${proposal.config.durationSeconds}s`);
  console.log(`config     ${formatCommand(proposal.command.config)}`);
  console.log(`capture    ${formatCommand(proposal.command.capture)}`);
  if (proposal.warnings.length > 0) {
    console.log('');
    console.log('Warnings');
    for (const warning of proposal.warnings) console.log(`- ${warning}`);
  }
  console.log('');
  console.log('Rationale');
  for (const rationale of proposal.rationale) console.log(`- ${rationale}`);
  console.log('');
  process.stdout.write(proposal.config.textproto);
}

function extractDurationFromText(textproto: string, fallback?: number): number | undefined {
  const match = [...textproto.matchAll(/^\s*duration_ms\s*:\s*(\d+)\s*$/gm)];
  const last = match[match.length - 1]?.[1];
  if (!last) return fallback;
  const value = Number.parseInt(last, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function printError(format: OutputFormat, message: string): void {
  if (format === 'json' || format === 'ndjson') {
    console.error(JSON.stringify({ ok: false, type: 'error', error: message }));
    return;
  }
  console.error(`Error: ${message}`);
}

function formatCommand(args: string[]): string {
  return args.map(formatCommandArg).join(' ');
}

function formatCommandArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
