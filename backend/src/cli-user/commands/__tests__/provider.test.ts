// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runProviderTestCommand } from '../provider';
import { resetProviderService } from '../../../services/providerManager';
import { resetCliEnvironmentForTesting } from '../../bootstrap';

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
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.SMARTPERFETTO_OPENCODE_MODEL;
    delete process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.SMARTPERFETTO_AI_ENABLED;
    delete process.env.SMARTPERFETTO_QODER_SDK_MODULE_PATH;
    resetProviderService();
    resetCliEnvironmentForTesting();
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

  test.each([undefined, '   ', 'your_anthropic_api_key_here', 'sk-test'])(
    'system check requires credentials as well as an executable SDK (%s)', async (apiKey) => {
      process.env.CLAUDE_BINARY_PATH = process.execPath;
      process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/anthropic';
      if (apiKey !== undefined) process.env.ANTHROPIC_API_KEY = apiKey;
      const exitCode = await runProviderTestCommand({
        envFile, sessionDir: path.join(tmpDir, 'home'), format: 'json',
      });
      const lastCall = consoleLogSpy.mock.calls[consoleLogSpy.mock.calls.length - 1];
      const payload = JSON.parse(String(lastCall?.[0] ?? '{}'));
      const configured = apiKey === 'sk-test';
      expect(exitCode).toBe(configured ? 0 : 1);
      expect(payload).toMatchObject({ok: configured, diagnostics: {configured}});
      expect(payload.note).not.toContain('fallback');
      if (!configured) {
        expect(payload.note).toContain('smp config init');
        expect(payload.note).toContain('Providers');
        expect(payload.note).toContain('~/.smartperfetto/runtime/data/providers.json');
        expect(payload.note).toContain('backend/data/providers.json');
        expect(payload.note).toContain('SMARTPERFETTO_BACKEND_DATA_DIR');
        expect(payload.note).not.toContain('share the same Provider configuration');
      }
    },
  );

  test('system test uses Pi diagnostics and setup guidance instead of the Claude binary guard', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'pi-agent-core';
    delete process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    delete process.env.SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM;
    const exitCode = await runProviderTestCommand({envFile, sessionDir: path.join(tmpDir, 'home'), format: 'json'});
    const calls = consoleLogSpy.mock.calls;
    const payload = JSON.parse(String(calls[calls.length - 1]?.[0] ?? '{}'));
    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ok: false, diagnostics: {runtime: 'pi-agent-core', configured: false}});
    expect(payload.note).toContain('smp config init');
    expect(payload.note).toContain('~/.smartperfetto/runtime/data/providers.json');
    expect(payload.note).not.toContain('Claude Agent SDK native binary');
  });

  test.each([undefined, 'not-json', '{}'])(
    'system test rejects OpenCode without a parseable model configuration (%s)',
    async (modelJson) => {
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'opencode';
      if (modelJson !== undefined) process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON = modelJson;
      const exitCode = await runProviderTestCommand({
        envFile, sessionDir: path.join(tmpDir, 'home'), format: 'json',
      });
      const calls = consoleLogSpy.mock.calls;
      const payload = JSON.parse(String(calls[calls.length - 1]?.[0] ?? '{}'));
      expect(exitCode).toBe(1);
      expect(payload).toMatchObject({ok: false, diagnostics: {runtime: 'opencode'}});
      expect(payload.note).toContain('SMARTPERFETTO_OPENCODE_MODEL_JSON');
      expect(payload.note).toContain('smp config init');
    },
  );

  test('system test accepts complete OpenCode OpenAI-compatible model configuration', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'opencode';
    process.env.OPENAI_MODEL = 'openai-compatible-model';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
    const exitCode = await runProviderTestCommand({
      envFile, sessionDir: path.join(tmpDir, 'home'), format: 'json',
    });
    const calls = consoleLogSpy.mock.calls;
    const payload = JSON.parse(String(calls[calls.length - 1]?.[0] ?? '{}'));
    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      diagnostics: {runtime: 'opencode', modelConfigured: true},
      note: 'OpenCode model configuration detected.',
    });
  });

  test('system test does not expose malformed OpenCode model JSON', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'opencode';
    process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON = '{"apiKey":"sk-opencode-secret",';
    const exitCode = await runProviderTestCommand({
      envFile, sessionDir: path.join(tmpDir, 'home'), format: 'json',
    });
    const calls = consoleLogSpy.mock.calls;
    const payloadText = String(calls[calls.length - 1]?.[0] ?? '{}');
    const payload = JSON.parse(payloadText);
    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ok: false, diagnostics: {runtime: 'opencode', configured: false}});
    expect(payload.note).toContain('invalid or incomplete');
    expect(payloadText).not.toContain('sk-opencode-secret');
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
    // Force "not installed" instead of inferring it from this machine: the
    // detector short-circuits on a configured module path, so a nonexistent one
    // gives the same answer whether or not `npm run qoder:install` has been run.
    process.env.SMARTPERFETTO_QODER_SDK_MODULE_PATH = path.join(tmpDir, 'absent-qoder-sdk.js');

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
