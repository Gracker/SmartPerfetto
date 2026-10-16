// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import {
  assertDeviceSupportsCapturePreset,
  buildPerfettoBackgroundArgs,
  captureAndroidTrace,
  parseAdbDevices,
  parseBackgroundPid,
  resolveCaptureDurationMs,
  selectDevice,
  type AdbCommandRunner,
  type AdbRunOptions,
  type AdbRunResult,
} from '../androidCapture';

describe('android capture service', () => {
  it('parses devices and requires explicit serial for multiple connected devices', () => {
    const devices = parseAdbDevices([
      'List of devices attached',
      'abc123 device product:a model:A',
      'def456 offline',
      'ghi789 device product:g model:G',
      '',
    ].join('\n'));

    expect(devices.map((device) => device.serial)).toEqual(['abc123', 'def456', 'ghi789']);
    expect(() => selectDevice(devices)).toThrow('multiple adb devices');
    expect(selectDevice(devices, 'ghi789').serial).toBe('ghi789');
  });

  it('assembles direct device perfetto capture for API 29+', async () => {
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({
      probe: '33\narm64-v8a\nshell\n',
    });
    try {
      const out = path.join(temp.dir, 'trace.perfetto-trace');
      const result = await captureAndroidTrace({
        adbPath: temp.adb,
        configText: 'duration_ms: 3000\n',
        configDurationMs: 3000,
        app: 'com.example',
        preset: 'startup',
        out,
        runner,
        now: () => 1234,
      });

      expect(result.usedSideload).toBe(false);
      expect(result.device?.perfettoCommand).toBe('perfetto');
      const start = runner.calls.find((call) => call.args.includes('--background'));
      expect(start?.args).toEqual(buildPerfettoBackgroundArgs({
        perfettoCommand: 'perfetto',
        remotePath: result.remotePath,
      }));
      expect(start?.options?.stdin).toContain('duration_ms: 3000');
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it('sideloads tracebox for API levels before 29', async () => {
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({
      probe: '28\narm64-v8a\nshell\n',
    });
    try {
      const out = path.join(temp.dir, 'trace.perfetto-trace');
      const result = await captureAndroidTrace({
        adbPath: temp.adb,
        traceboxPath: temp.tracebox,
        configText: 'duration_ms: 3000\n',
        configDurationMs: 3000,
        out,
        runner,
        now: () => 1234,
      });

      expect(result.usedSideload).toBe(true);
      expect(result.device?.perfettoCommand).toBe('/data/local/tmp/smartperfetto-tracebox');
      expect(runner.calls.some((call) => call.args[0] === 'push' && call.args[1] === temp.tracebox)).toBe(true);
      expect(runner.calls.some((call) => call.args.join(' ').includes('chmod 755'))).toBe(true);
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['API 29 (no java_hprof)', '29\narm64-v8a\nshell\n', false, 'needs Android API 30+'],
    ['API 28 (would sideload tracebox)', '28\narm64-v8a\nshell\n', false, 'needs Android API 30+'],
    ['forced --sideload on API 33', '33\narm64-v8a\nshell\n', true, 'drop --sideload'],
  ])('fails memory-profile closed before touching the device on %s', async (_label, probe, sideload, message) => {
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({ probe });
    try {
      await expect(captureAndroidTrace({
        adbPath: temp.adb,
        traceboxPath: temp.tracebox,
        configText: 'duration_ms: 60000\n',
        app: 'com.example.app',
        preset: 'memory-profile',
        durationSeconds: 60,
        sideload,
        out: path.join(temp.dir, 'trace.perfetto-trace'),
        runner,
        now: () => 1234,
      })).rejects.toThrow(message);

      // Only the device listing and the probe ran: no preflight, push, or start.
      expect(runner.calls.map((call) => call.args[0] === 'shell' ? String(call.args[1]).split(' ')[0] : call.args[0]))
        .toEqual(['devices', 'getprop']);
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it('runs memory-profile on API 30+ with built-in perfetto and profileability preflight warnings', async () => {
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({ probe: '30\narm64-v8a\nshell\n' });
    try {
      const result = await captureAndroidTrace({
        adbPath: temp.adb,
        configText: 'duration_ms: 60000\n',
        app: 'com.example.app',
        preset: 'memory-profile',
        durationSeconds: 60,
        out: path.join(temp.dir, 'trace.perfetto-trace'),
        runner,
        now: () => 1234,
      });

      expect(result.usedSideload).toBe(false);
      expect(result.device?.perfettoCommand).toBe('perfetto');
      const warnings = result.preflight?.warnings.join('\n') ?? '';
      expect(warnings).toContain('profileable or debuggable');
      expect(warnings).toContain('pauses the app');
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it('keeps system-wide presets free of app-profiling gates and warnings', async () => {
    expect(() => assertDeviceSupportsCapturePreset('memory', { apiLevel: 23 }, { sideload: true })).not.toThrow();
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({ probe: '33\narm64-v8a\nshell\n' });
    try {
      const result = await captureAndroidTrace({
        adbPath: temp.adb,
        configText: 'duration_ms: 3000\n',
        configDurationMs: 3000,
        app: 'com.example.app',
        preset: 'memory',
        out: path.join(temp.dir, 'trace.perfetto-trace'),
        runner,
        now: () => 1234,
      });
      expect(result.preflight?.warnings).toEqual([]);
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });

  it('parses background pid and validates duration fallbacks', () => {
    expect(parseBackgroundPid('warning\n12345\n')).toBe('12345');
    expect(resolveCaptureDurationMs(2000, undefined)).toBe(2000);
    expect(resolveCaptureDurationMs(undefined, 3)).toBe(3000);
    expect(() => resolveCaptureDurationMs(undefined, undefined)).toThrow('duration_ms');
  });

  it('records preflight warnings and can kill stale tracing processes by request', async () => {
    const temp = makeTempTools();
    const runner = new FakeAdbRunner({
      probe: '33\narm64-v8a\nshell\n',
      staleProcesses: 'shell 123 1 perfetto\nshell 124 1 traced\n',
      selinux: 'Enforcing\n',
    });
    try {
      const out = path.join(temp.dir, 'trace.perfetto-trace');
      const result = await captureAndroidTrace({
        adbPath: temp.adb,
        configText: 'duration_ms: 3000\n',
        configDurationMs: 3000,
        out,
        killStale: true,
        runner,
        now: () => 1234,
      });

      expect(result.preflight?.staleProcessesDetected).toBe(true);
      expect(result.preflight?.killedStaleProcesses).toBe(true);
      expect(result.preflight?.selinux).toBe('Enforcing');
      expect(result.preflight?.warnings.join('\n')).toContain('SELinux is Enforcing');
      expect(runner.calls.some((call) => call.args.join(' ').includes('pkill -9 perfetto'))).toBe(true);
    } finally {
      fs.rmSync(temp.dir, { recursive: true, force: true });
    }
  });
});

class FakeAdbRunner implements AdbCommandRunner {
  readonly calls: Array<{ adbPath: string; serial: string | undefined; args: string[]; options?: AdbRunOptions }> = [];

  constructor(private readonly opts: { probe: string; staleProcesses?: string; selinux?: string }) {}

  async run(
    adbPath: string,
    serial: string | undefined,
    args: string[],
    options?: AdbRunOptions,
  ): Promise<AdbRunResult> {
    this.calls.push({ adbPath, serial, args, options });
    if (args[0] === 'devices') {
      return { stdout: 'List of devices attached\nserial-1 device product:p model:m\n', stderr: '' };
    }
    if (args[0] === 'shell' && String(args[1]).includes('getprop ro.build.version.sdk')) {
      return { stdout: this.opts.probe, stderr: '' };
    }
    if (args[0] === 'shell' && String(args[1]).includes('ps -A')) {
      return { stdout: this.opts.staleProcesses ?? '', stderr: '' };
    }
    if (args[0] === 'shell' && String(args[1]).includes('getenforce')) {
      return { stdout: this.opts.selinux ?? 'Permissive\n', stderr: '' };
    }
    if (args.includes('--background')) {
      return { stdout: '12345\n', stderr: '' };
    }
    if (args[0] === 'shell' && String(args[1]).includes('test -d /proc/12345')) {
      return { stdout: 'TERM\n', stderr: '' };
    }
    if (args[0] === 'pull') {
      fs.writeFileSync(args[2]!, 'trace', 'utf-8');
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

function makeTempTools(): { dir: string; adb: string; tracebox: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-android-capture-'));
  return {
    dir,
    adb: makeExecutable(dir, 'adb'),
    tracebox: makeExecutable(dir, 'tracebox'),
  };
}

function makeExecutable(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(file, 0o755);
  return file;
}
