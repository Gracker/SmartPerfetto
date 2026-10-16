// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { runCaptureSuggestCommand } from '../capture';

jest.mock('../../bootstrap', () => ({
  ...jest.requireActual('../../bootstrap'),
  bootstrap: jest.fn(() => ({ paths: { root: '/tmp/smp', sessions: '/tmp/smp/sessions' } })),
}));

describe('runCaptureSuggestCommand', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  it('prints JSON proposal output without runtime/provider setup', async () => {
    const exitCode = await runCaptureSuggestCommand({
      request: 'debug startup jank',
      app: 'com.example.app',
      format: 'json',
    });

    expect(exitCode).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: true,
      type: 'trace_config_proposal',
      proposal: {
        source: 'deterministic',
        preset: 'startup',
        app: 'com.example.app',
      },
    });
  });

  it('selects the Camera preset for Camera-domain requests', async () => {
    const exitCode = await runCaptureSuggestCommand({
      request: '分析 Camera 打开到首帧预览延迟',
      app: 'com.example.camera',
      format: 'json',
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0] ?? '{}'));
    expect(payload.proposal).toMatchObject({
      preset: 'camera',
      intent: 'camera',
      app: 'com.example.camera',
    });
  });

  it('keeps text output side-effect free and includes the config preview', async () => {
    const exitCode = await runCaptureSuggestCommand({
      request: 'scrolling frame drops',
      app: 'com.example.app',
      format: 'text',
    });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy.mock.calls.flat().join('\n')).toContain('preset     scrolling');
    expect(String(stdoutWriteSpy.mock.calls[0]?.[0] ?? '')).toContain('SmartPerfetto capture preset: scrolling');
  });
});
