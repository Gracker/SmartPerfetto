// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  runCaptureAndroidCommand,
  runCaptureConfigCommand,
  runCapturePresetsCommand,
} from '../capture';
import type { AdbCommandRunner } from '../../services/androidCapture';

jest.mock('../../bootstrap', () => ({
  bootstrap: jest.fn(() => ({ paths: { root: '/tmp/smp', sessions: '/tmp/smp/sessions' } })),
}));

describe('capture CLI command', () => {
  const originalEnv = { ...process.env };
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, SMARTPERFETTO_AI_ENABLED: 'false' };
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('blocks capture android --analyze before starting adb capture work when AI is disabled', async () => {
    const runner: AdbCommandRunner = {
      run: jest.fn(async () => ({ stdout: '', stderr: '' })),
    };

    const exitCode = await runCaptureAndroidCommand({
      preset: 'startup',
      app: 'com.example.app',
      out: '/tmp/smartperfetto-disabled-policy-smoke.pftrace',
      analyze: true,
      verbose: false,
      noColor: true,
      format: 'json',
      runner,
    });

    expect(exitCode).toBe(1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: false,
      type: 'error',
    });
    expect(payload.error).toContain('AI is disabled by SMARTPERFETTO_AI_ENABLED=false');
  });

  it.each(['*', undefined])('rejects capture android --preset memory-profile with app %p before adb work', async (app) => {
    const runner: AdbCommandRunner = {
      run: jest.fn(async () => ({ stdout: '', stderr: '' })),
    };

    const exitCode = await runCaptureAndroidCommand({
      preset: 'memory-profile',
      app,
      out: '/tmp/smartperfetto-memory-profile-smoke.pftrace',
      verbose: false,
      noColor: true,
      format: 'json',
      runner,
    });

    expect(exitCode).toBe(1);
    expect(runner.run).not.toHaveBeenCalled();
    const payload = JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload).toMatchObject({ ok: false, type: 'error' });
    expect(payload.error).toMatch(/--app/);
  });

  it('rejects capture config --preset memory-profile with the default --app *', async () => {
    const exitCode = await runCaptureConfigCommand({
      preset: 'memory-profile',
      app: '*',
      format: 'json',
    });

    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload.error).toContain("capture preset memory-profile profiles one app process; pass a concrete --app <package> (not '*')");
  });

  it('renders capture config --preset memory-profile for a concrete app at its default duration', async () => {
    const exitCode = await runCaptureConfigCommand({
      preset: 'memory-profile',
      app: 'com.example.app',
      format: 'json',
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload).toMatchObject({ ok: true, preset: 'memory-profile' });
    expect(payload.config).toContain('name: "android.java_hprof"');
    expect(payload.config).toContain('duration_ms: 60000');
  });

  it('lists memory-profile in capture presets without changing the other entries', async () => {
    const exitCode = await runCapturePresetsCommand({ format: 'json' });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0] ?? '{}'));
    const ids = payload.presets.map((preset: { id: string }) => preset.id);
    expect(ids).toEqual([
      'startup', 'scrolling', 'camera', 'anr', 'game', 'memory', 'memory-profile', 'cpu', 'power', 'overview', 'full',
    ]);
    for (const preset of payload.presets) {
      const keys = Object.keys(preset).sort();
      const baseKeys = [
        'atraceCategories', 'bufferSizeKb', 'dataSources', 'defaultDurationSeconds', 'description',
        'descriptionZh', 'ftraceEvents', 'id', 'intent', 'label',
      ];
      expect(keys).toEqual(preset.id === 'memory-profile' ? [...baseKeys, 'requirements'].sort() : baseKeys);
    }
  });
});
