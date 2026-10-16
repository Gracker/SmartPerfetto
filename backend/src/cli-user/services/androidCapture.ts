// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  androidTraceboxPlatformKey,
  assertToolUsable,
  resolveAdbTool,
  resolveTraceboxTool,
} from './captureTools';
import { getCapturePreset, type CapturePresetRequirements } from './captureConfig';
import type {
  CapturePresetId,
  CaptureToolResolution,
  TraceCaptureResult,
} from '../types';

export interface AndroidCaptureInput {
  configText: string;
  configPath?: string;
  configDurationMs?: number;
  app?: string;
  preset?: CapturePresetId;
  durationSeconds?: number;
  out: string;
  serial?: string;
  sideload?: boolean;
  traceboxPath?: string;
  noGuardrails?: boolean;
  killStale?: boolean;
  adbPath?: string;
  backendRoot?: string;
  runner?: AdbCommandRunner;
  now?: () => number;
}

export interface AdbDevice {
  serial: string;
  state: string;
  description?: string;
}

export interface AndroidDeviceProbe {
  apiLevel: number;
  abi: string;
  shellUser?: string;
}

export interface AdbCommandRunner {
  run(adbPath: string, serial: string | undefined, args: string[], options?: AdbRunOptions): Promise<AdbRunResult>;
}

export interface AdbRunOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface AdbRunResult {
  stdout: string;
  stderr: string;
}

export class SpawnAdbCommandRunner implements AdbCommandRunner {
  run(
    adbPath: string,
    serial: string | undefined,
    args: string[],
    options: AdbRunOptions = {},
  ): Promise<AdbRunResult> {
    return new Promise((resolve, reject) => {
      const fullArgs = serial ? ['-s', serial, ...args] : args;
      const child = spawn(adbPath, fullArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = options.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
        settled = true;
        reject(new Error(`adb command timed out after ${timeoutMs / 1000}s: ${fullArgs.join(' ')}`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error((stderr || stdout || `adb exited with code ${code}`).trim()));
      });

      child.stdin.end(options.stdin ?? '');
    });
  }
}

export async function captureAndroidTrace(input: AndroidCaptureInput): Promise<TraceCaptureResult> {
  const outPath = path.resolve(input.out);
  const runner = input.runner ?? new SpawnAdbCommandRunner();
  const adb = input.adbPath
    ? {
        name: 'adb' as const,
        source: 'override' as const,
        path: path.resolve(input.adbPath),
        exists: fs.existsSync(path.resolve(input.adbPath)),
        executable: fs.existsSync(path.resolve(input.adbPath)),
      } satisfies CaptureToolResolution
    : resolveAdbTool({ backendRoot: input.backendRoot });
  assertToolUsable(adb);

  const devices = await listDevices(adb.path, runner);
  const device = selectDevice(devices, input.serial);
  const probe = await probeAndroidDevice(adb.path, device.serial, runner);
  const shouldSideload = Boolean(input.sideload || probe.apiLevel < 29);
  const presetRequirements = input.preset
    ? assertDeviceSupportsCapturePreset(input.preset, probe, { sideload: shouldSideload })
    : undefined;
  const tracebox = shouldSideload
    ? resolveTraceboxTool(input.traceboxPath, androidTraceboxPlatformKey(probe.abi), { backendRoot: input.backendRoot })
    : undefined;
  if (tracebox) assertToolUsable(tracebox);

  const durationMs = resolveCaptureDurationMs(input.configDurationMs, input.durationSeconds);
  const preflight = await runAndroidCapturePreflight(adb.path, device.serial, runner, {
    killStale: input.killStale,
  });
  preflight.warnings.push(...(presetRequirements?.notes ?? []).map((note) => note.en));
  const killAfterMs = input.configDurationMs ? undefined : durationMs;
  const hardTimeoutMs = durationMs + 120000;
  const startedAt = input.now?.() ?? Date.now();
  const stamp = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
  const remoteDir = shouldSideload ? '/data/local/tmp' : '/data/misc/perfetto-traces';
  const remotePath = `${remoteDir}/smartperfetto-${stamp}.perfetto-trace`;
  const remoteConfigPath = `${remoteDir}/smartperfetto-${stamp}.pbtxt`;
  const perfettoCommand = shouldSideload ? '/data/local/tmp/smartperfetto-tracebox' : 'perfetto';

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let pushedTracebox = false;
  let pushedConfig = false;
  let hostConfigPath: string | undefined;
  let pid: string | undefined;
  try {
    if (shouldSideload && tracebox) {
      await runner.run(adb.path, device.serial, ['push', tracebox.path, perfettoCommand], { timeoutMs: 120000 });
      await runner.run(adb.path, device.serial, ['shell', `chmod 755 ${shellQuote(perfettoCommand)}`], { timeoutMs: 10000 });
      pushedTracebox = true;
    }

    if (probe.apiLevel < 24) {
      hostConfigPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-capture-')),
        'config.pbtxt',
      );
      fs.writeFileSync(hostConfigPath, input.configText, 'utf-8');
      await runner.run(adb.path, device.serial, ['push', hostConfigPath, remoteConfigPath], { timeoutMs: 30000 });
      pushedConfig = true;
      pid = await startPerfettoWithDeviceConfig(adb.path, device.serial, runner, {
        perfettoCommand,
        remoteConfigPath,
        remotePath,
        noGuardrails: input.noGuardrails,
      });
    } else {
      pid = await startPerfettoWithStdin(adb.path, device.serial, runner, {
        perfettoCommand,
        remotePath,
        configText: input.configText,
        noGuardrails: input.noGuardrails,
      });
    }

    await waitForPerfettoExit(adb.path, device.serial, runner, {
      pid,
      killAfterMs,
      hardTimeoutMs,
    });
    await runner.run(adb.path, device.serial, ['pull', remotePath, outPath], { timeoutMs: 180000 });

    return {
      target: 'android',
      serial: device.serial,
      app: input.app,
      preset: input.preset,
      configPath: input.configPath,
      durationSeconds: durationMs / 1000,
      out: outPath,
      remotePath,
      usedSideload: shouldSideload,
      tools: {
        adb,
        ...(tracebox ? { tracebox } : {}),
      },
      device: {
        apiLevel: probe.apiLevel,
        abi: probe.abi,
        perfettoCommand,
      },
      preflight,
    };
  } finally {
    if (pid) {
      await runner.run(adb.path, device.serial, ['shell', `kill -TERM ${pid} >/dev/null 2>&1 || true`], { timeoutMs: 5000 })
        .catch(() => undefined);
    }
    await runner.run(adb.path, device.serial, ['shell', `rm -f ${shellQuote(remotePath)}`], { timeoutMs: 10000 })
      .catch(() => undefined);
    if (pushedConfig) {
      await runner.run(adb.path, device.serial, ['shell', `rm -f ${shellQuote(remoteConfigPath)}`], { timeoutMs: 10000 })
        .catch(() => undefined);
    }
    if (pushedTracebox) {
      await runner.run(adb.path, device.serial, ['shell', `rm -f ${shellQuote(perfettoCommand)}`], { timeoutMs: 10000 })
        .catch(() => undefined);
    }
    if (hostConfigPath) {
      await fs.promises.rm(path.dirname(hostConfigPath), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Fail closed before touching the device when a preset's data sources cannot
 * run there. App-profiling presets rely on platform profiler daemons, which
 * exist only in the device's own perfetto from their minimum API level on and
 * which a sideloaded tracebox does not provide.
 */
export function assertDeviceSupportsCapturePreset(
  presetId: CapturePresetId,
  probe: Pick<AndroidDeviceProbe, 'apiLevel'>,
  opts: { sideload: boolean },
): CapturePresetRequirements | undefined {
  const requirements = getCapturePreset(presetId).requirements;
  if (!requirements) return undefined;
  if (probe.apiLevel < requirements.minApiLevel) {
    throw new Error(
      `capture preset ${presetId} needs Android API ${requirements.minApiLevel}+ with the device's built-in perfetto; `
      + `the device reports API ${probe.apiLevel}`,
    );
  }
  if (opts.sideload) {
    throw new Error(
      `capture preset ${presetId} needs the device's built-in perfetto: its profilers are platform daemons `
      + 'that a sideloaded tracebox does not provide; drop --sideload',
    );
  }
  return requirements;
}

export async function runAndroidCapturePreflight(
  adbPath: string,
  serial: string,
  runner: AdbCommandRunner,
  opts: { killStale?: boolean } = {},
): Promise<NonNullable<TraceCaptureResult['preflight']>> {
  const warnings: string[] = [];
  let staleProcessesDetected = false;
  let killedStaleProcesses = false;

  const stale = await runner.run(
    adbPath,
    serial,
    ['shell', "ps -A | grep -E '(perfetto|simpleperf|traced)' | grep -v grep"],
    { timeoutMs: 5000 },
  ).catch(() => ({ stdout: '', stderr: '' }));
  const staleOutput = `${stale.stdout}\n${stale.stderr}`.trim();
  if (staleOutput) {
    staleProcessesDetected = true;
    if (opts.killStale) {
      await runner.run(
        adbPath,
        serial,
        ['shell', [
          'pkill -9 simpleperf >/dev/null 2>&1 || true',
          'pkill -9 perfetto >/dev/null 2>&1 || true',
          'pkill -9 traced >/dev/null 2>&1 || true',
          'pkill -9 traced_probes >/dev/null 2>&1 || true',
          'sleep 2',
        ].join('; ')],
        { timeoutMs: 8000 },
      ).catch(() => undefined);
      killedStaleProcesses = true;
      warnings.push('stale tracing processes were detected and --kill-stale was applied before capture');
    } else {
      warnings.push('stale perfetto/simpleperf/traced processes were detected; retry with --kill-stale if capture hangs');
    }
  }

  const selinux = await runner.run(adbPath, serial, ['shell', 'getenforce'], { timeoutMs: 5000 })
    .then((result) => `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]?.trim())
    .catch(() => undefined);
  if (selinux === 'Enforcing') {
    warnings.push('SELinux is Enforcing; on rooted engineering devices, adb root && adb shell setenforce 0 may help if trace output is denied');
  }

  return {
    warnings,
    selinux,
    staleProcessesDetected,
    killedStaleProcesses,
  };
}

export async function listDevices(adbPath: string, runner: AdbCommandRunner): Promise<AdbDevice[]> {
  const { stdout, stderr } = await runner.run(adbPath, undefined, ['devices', '-l'], { timeoutMs: 8000 });
  return parseAdbDevices(`${stdout}\n${stderr}`);
}

export function parseAdbDevices(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('* daemon') && !line.startsWith('List of devices'))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        serial: parts[0] || '',
        state: parts[1] || 'unknown',
        description: parts.slice(2).join(' ') || undefined,
      };
    })
    .filter((device) => device.serial.length > 0);
}

export function selectDevice(devices: AdbDevice[], serial?: string): AdbDevice {
  const ready = devices.filter((device) => device.state === 'device');
  if (serial) {
    const selected = ready.find((device) => device.serial === serial);
    if (!selected) throw new Error(`no connected adb device with serial ${serial}`);
    return selected;
  }
  if (ready.length === 1) return ready[0]!;
  if (ready.length === 0) throw new Error('no connected adb device');
  throw new Error(`multiple adb devices connected; pass --serial (${ready.map((device) => device.serial).join(', ')})`);
}

export async function probeAndroidDevice(
  adbPath: string,
  serial: string,
  runner: AdbCommandRunner,
): Promise<AndroidDeviceProbe> {
  const { stdout, stderr } = await runner.run(
    adbPath,
    serial,
    ['shell', 'getprop ro.build.version.sdk; getprop ro.product.cpu.abi; whoami'],
    { timeoutMs: 10000 },
  );
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('* daemon'));
  const apiLevel = Number.parseInt(lines[0] ?? '', 10);
  const abi = lines[1] ?? '';
  if (!Number.isFinite(apiLevel) || apiLevel <= 0) {
    throw new Error(`failed to read Android API level from ${serial}`);
  }
  if (!abi) throw new Error(`failed to read Android ABI from ${serial}`);
  return {
    apiLevel,
    abi,
    shellUser: lines[2],
  };
}

export function resolveCaptureDurationMs(configDurationMs?: number, cliDurationSeconds?: number): number {
  if (cliDurationSeconds !== undefined) {
    if (!Number.isFinite(cliDurationSeconds) || cliDurationSeconds <= 0) {
      throw new Error('--duration must be a positive number of seconds');
    }
    return Math.round(cliDurationSeconds * 1000);
  }
  if (configDurationMs !== undefined) return configDurationMs;
  throw new Error('capture config has no duration_ms; pass --duration <seconds> so SmartPerfetto knows when to stop it');
}

export function buildPerfettoBackgroundArgs(input: {
  perfettoCommand: string;
  remotePath: string;
  noGuardrails?: boolean;
}): string[] {
  return [
    'shell',
    input.perfettoCommand,
    '--background',
    '--txt',
    ...(input.noGuardrails ? ['--no-guardrails'] : []),
    '-o',
    input.remotePath,
    '-c',
    '-',
  ];
}

async function startPerfettoWithStdin(
  adbPath: string,
  serial: string,
  runner: AdbCommandRunner,
  input: {
    perfettoCommand: string;
    remotePath: string;
    configText: string;
    noGuardrails?: boolean;
  },
): Promise<string> {
  const result = await runner.run(
    adbPath,
    serial,
    buildPerfettoBackgroundArgs(input),
    { stdin: input.configText, timeoutMs: 30000 },
  );
  return parseBackgroundPid(`${result.stdout}\n${result.stderr}`);
}

async function startPerfettoWithDeviceConfig(
  adbPath: string,
  serial: string,
  runner: AdbCommandRunner,
  input: {
    perfettoCommand: string;
    remoteConfigPath: string;
    remotePath: string;
    noGuardrails?: boolean;
  },
): Promise<string> {
  const cmd = [
    `cat ${shellQuote(input.remoteConfigPath)}`,
    '|',
    shellQuote(input.perfettoCommand),
    '--background',
    '--txt',
    ...(input.noGuardrails ? ['--no-guardrails'] : []),
    '-o',
    shellQuote(input.remotePath),
    '-c',
    '-',
  ].join(' ');
  const result = await runner.run(adbPath, serial, ['shell', cmd], { timeoutMs: 30000 });
  return parseBackgroundPid(`${result.stdout}\n${result.stderr}`);
}

export function parseBackgroundPid(output: string): string {
  const match = output.match(/^(\d+)$/m);
  if (!match?.[1]) {
    throw new Error(`failed to read perfetto background pid from adb output: ${output.trim() || '(empty)'}`);
  }
  return match[1];
}

async function waitForPerfettoExit(
  adbPath: string,
  serial: string,
  runner: AdbCommandRunner,
  input: {
    pid: string;
    killAfterMs?: number;
    hardTimeoutMs: number;
  },
): Promise<void> {
  const started = Date.now();
  const killAt = input.killAfterMs !== undefined ? started + input.killAfterMs : undefined;
  const hardDeadline = started + input.hardTimeoutMs;
  let sentTerm = false;

  while (Date.now() < hardDeadline) {
    const poll = await runner.run(
      adbPath,
      serial,
      ['shell', `test -d /proc/${input.pid} && echo RUN || echo TERM`],
      { timeoutMs: 10000 },
    ).catch((err) => ({ stdout: '', stderr: (err as Error).message }));
    if (`${poll.stdout}\n${poll.stderr}`.includes('TERM')) return;
    if (killAt !== undefined && Date.now() >= killAt && !sentTerm) {
      sentTerm = true;
      await runner.run(adbPath, serial, ['shell', `kill -TERM ${input.pid}`], { timeoutMs: 5000 })
        .catch(() => undefined);
    }
    await sleep(500);
  }

  await runner.run(adbPath, serial, ['shell', `kill -KILL ${input.pid}`], { timeoutMs: 5000 })
    .catch(() => undefined);
  throw new Error(`perfetto did not finish within ${Math.round(input.hardTimeoutMs / 1000)}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
