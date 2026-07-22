// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertAnalysisRuntimeReady, collectDoctorReport } from '../runtimeGuard';
import { resetProviderService } from '../../../services/providerManager';

describe('runtime guard', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-runtime-guard-'));
    process.env = { ...originalEnv, PROVIDER_DATA_DIR_OVERRIDE: tmpDir };
    delete process.env.SMARTPERFETTO_AI_ENABLED;
    delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM;
    delete process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_BINARY_PATH;
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODERCLI_PATH;
    resetProviderService();
  });

  afterEach(() => {
    resetProviderService();
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  test('allows Claude runtime without explicit env credentials for local auth fallback', () => {
    process.env.CLAUDE_BINARY_PATH = createExecutableStub(tmpDir);
    const result = assertAnalysisRuntimeReady();
    expect(result.selection.kind).toBe('claude-agent-sdk');
    expect(result.diagnostics).toMatchObject({
      runtime: 'claude-agent-sdk',
      configured: expect.any(Boolean),
    });
  });

  test('rejects Claude runtime when explicit SDK binary path is not executable', () => {
    process.env.CLAUDE_BINARY_PATH = path.join(tmpDir, 'missing-claude-binary');
    expect(() => assertAnalysisRuntimeReady()).toThrow('native binary is not executable');
  });

  test('fails analysis guard with AI_DISABLED before runtime credential checks', () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    expect(() => assertAnalysisRuntimeReady()).toThrow('AI is disabled by SMARTPERFETTO_AI_ENABLED=false');
  });

  test('doctor discloses disabled AI without requiring selected runtime credentials', () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    const report = collectDoctorReport(tmpDir);

    expect(report.ok).toBe(true);
    expect(report.aiPolicy).toMatchObject({
      aiEnabled: false,
      env: {
        key: 'SMARTPERFETTO_AI_ENABLED',
        rawValue: 'false',
        valid: true,
      },
    });
    expect(report.checks.find(check => check.name === 'runtime')).toMatchObject({
      ok: true,
      status: 'warn',
      message: 'AI is disabled; runtime credentials are not required for deterministic CLI flows',
    });
  });

  test('doctor reports invalid AI policy env as a configuration error', () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'sometimes';

    const report = collectDoctorReport(tmpDir);

    expect(report.ok).toBe(false);
    expect(report.aiPolicy.env).toMatchObject({
      rawValue: 'sometimes',
      valid: false,
    });
    expect(report.checks.find(check => check.name === 'ai_policy')).toMatchObject({
      ok: false,
      status: 'error',
    });
  });

  test('rejects OpenAI runtime without an API key or local endpoint', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    expect(() => assertAnalysisRuntimeReady()).toThrow('OpenAI runtime is selected');
  });

  test('allows OpenAI runtime with a localhost endpoint', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    const result = assertAnalysisRuntimeReady();
    expect(result.selection.kind).toBe('openai-agents-sdk');
    expect(result.diagnostics).toMatchObject({
      runtime: 'openai-agents-sdk',
      configured: true,
    });
  });

  test('does not treat the hidden experimental runtime as Claude SDK', () => {
    process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME = '1';
    process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME = 'experimental-pi-agent-core';
    process.env.SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM = '1';
    const result = assertAnalysisRuntimeReady({ providerId: null });
    expect(result.selection.kind).toBe('experimental-pi-agent-core');
    expect(result.diagnostics).toMatchObject({
      runtime: 'experimental-pi-agent-core',
      configured: true,
      experimental: true,
      package: '@earendil-works/pi-agent-core',
    });
  });

  test('allows public Pi agent-core runtime with explicit model JSON', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'pi-agent-core';
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = '{"id":"pi-test","provider":"test"}';

    const result = assertAnalysisRuntimeReady({ providerId: null });
    expect(result.selection.kind).toBe('pi-agent-core');
    expect(result.diagnostics).toMatchObject({
      runtime: 'pi-agent-core',
      configured: true,
      experimental: false,
      modelConfigured: true,
      package: '@earendil-works/pi-agent-core',
    });
  });

  test('reports the missing opt-in Qoder SDK instead of applying the Claude binary guard', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'qoder-agent-sdk';

    expect(() => assertAnalysisRuntimeReady({ providerId: null })).toThrow(
      'Qoder Agent SDK runtime is selected but @qoder-ai/qoder-agent-sdk is not installed',
    );
  });

  test('doctor reports the opt-in Qoder SDK as missing', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'qoder-agent-sdk';

    const report = collectDoctorReport(tmpDir);

    expect(report.checks.find(check => check.name === 'runtime')).toMatchObject({
      ok: false,
      status: 'error',
      message: 'Qoder Agent SDK is not installed; review its terms and install the optional SDK explicitly',
    });
  });

  test('uses saved session runtime override instead of current env selection', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    process.env.CLAUDE_BINARY_PATH = createExecutableStub(tmpDir);
    const result = assertAnalysisRuntimeReady({
      providerId: null,
      runtimeOverride: 'claude-agent-sdk',
    });
    expect(result.selection.kind).toBe('claude-agent-sdk');
    expect(result.selection.source).toBe('snapshot');
    expect(result.diagnostics).toMatchObject({
      runtime: 'claude-agent-sdk',
      configured: expect.any(Boolean),
    });
  });
});

function createExecutableStub(dir: string): string {
  const file = path.join(dir, 'claude-stub');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(file, 0o755);
  return file;
}
