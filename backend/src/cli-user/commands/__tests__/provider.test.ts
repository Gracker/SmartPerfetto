// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProviderTestCommand } from '../provider';
import { resetProviderService } from '../../../services/providerManager';

describe('provider CLI command', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let tmpDir: string;
  let envFile: string;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-provider-cli-'));
    envFile = path.join(tmpDir, 'empty.env');
    fs.writeFileSync(envFile, '', 'utf-8');
    process.env = {
      ...originalEnv,
      PROVIDER_DATA_DIR_OVERRIDE: path.join(tmpDir, 'providers'),
      SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
      CLAUDE_BINARY_PATH: path.join(tmpDir, 'missing-claude-binary'),
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.SMARTPERFETTO_AI_ENABLED;
    resetProviderService();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetProviderService();
    process.env = originalEnv;
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('system test fails when Claude runtime binary is not executable', async () => {
    const exitCode = await runProviderTestCommand({
      envFile,
      sessionDir: path.join(tmpDir, 'home'),
      format: 'json',
    });

    expect(exitCode).toBe(1);
    const lastCall = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1];
    const payload = JSON.parse(String(lastCall?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: false,
      target: 'system',
      note: 'Claude Agent SDK native binary is missing or not executable.',
    });
  });

  test('provider test is blocked before runtime or provider network checks when AI is disabled', async () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const exitCode = await runProviderTestCommand({
      envFile,
      sessionDir: path.join(tmpDir, 'home'),
      format: 'json',
    });

    expect(exitCode).toBe(1);
    const lastCall = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1];
    const payload = JSON.parse(String(lastCall?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: false,
      success: false,
      code: 'AI_DISABLED',
      target: 'system',
      feature: 'cli_provider_test',
    });
    expect(payload.error).toContain('AI is disabled by SMARTPERFETTO_AI_ENABLED=false');
  });

  test('system test reports the missing opt-in Qoder SDK without applying the Claude binary guard', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'qoder-agent-sdk';
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODERCLI_PATH;

    const exitCode = await runProviderTestCommand({
      envFile,
      sessionDir: path.join(tmpDir, 'home'),
      format: 'json',
    });

    expect(exitCode).toBe(1);
    const lastCall = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1];
    const payload = JSON.parse(String(lastCall?.[0] ?? '{}'));
    expect(payload).toMatchObject({
      ok: false,
      target: 'system',
      runtime: { kind: 'qoder-agent-sdk' },
      diagnostics: { runtime: 'qoder-agent-sdk', configured: false, sdkInstalled: false },
    });
    expect(payload.note).toContain('not installed');
  });
});
