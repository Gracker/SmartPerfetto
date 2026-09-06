// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { buildRuntimeHealthPayload } from '../runtimeHealth';
import { getProviderService, resetProviderService } from '../../services/providerManager';

const ENV_KEYS = [
  'PROVIDER_DATA_DIR_OVERRIDE',
  'SMARTPERFETTO_AI_ENABLED',
  'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_API_KEY',
  'SMARTPERFETTO_ENTERPRISE',
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_MODEL',
  'CLAUDE_LIGHT_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_AGENTS_PROTOCOL',
  'OPENAI_MODEL',
  'OPENAI_LIGHT_MODEL',
  'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON',
  'SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH',
  'SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM',
  'SMARTPERFETTO_OPENCODE_MODEL_JSON',
  'SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH',
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_KEYS.map(key => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Start each case from no provider environment at all.
 *
 * Restoring the ambient values here instead would let the developer's own
 * configuration decide the assertion: a machine with `ANTHROPIC_BASE_URL` set
 * — pointing Claude at a compatible gateway is an ordinary local setup —
 * reports `anthropic_compatible_proxy` where this suite expects
 * `anthropic_direct`, and adds `anthropic_base_url` to every runtime's
 * credential-source list. Each case sets exactly the variables it is about;
 * the real environment comes back in `afterEach`.
 */
function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function expectRuntimeDiagnosticsShape(payload: any, runtime: string): void {
  expect(payload.aiEngine.diagnostics).toMatchObject({
    runtime,
    configured: expect.any(Boolean),
  });
  expect(typeof payload.aiEngine.model).toBe('string');
  expect(typeof payload.aiEngine.providerMode).toBe('string');
}

describe('buildRuntimeHealthPayload', () => {
  let dir: string;

  beforeEach(async () => {
    clearEnv();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-runtime-health-'));
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    resetProviderService();
  });

  afterEach(async () => {
    restoreEnv();
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reports default Claude runtime diagnostics without leaking credentials', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-claude-secret';
    process.env.CLAUDE_MODEL = 'claude-test';
    process.env.CLAUDE_LIGHT_MODEL = 'claude-light';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expectRuntimeDiagnosticsShape(payload, 'claude-agent-sdk');
    expect(payload.aiEngine).toMatchObject({
      runtime: 'claude-agent-sdk',
      model: 'claude-test',
      providerMode: 'anthropic_direct',
      aiEnabled: true,
      configured: true,
      source: 'default',
      credentialSource: 'env-or-default',
      envCredentialSources: ['anthropic_api_key'],
      providerOverridesEnv: false,
    });
    expect(payload.aiEngine.diagnostics).toMatchObject({
      runtime: 'claude-agent-sdk',
      providerMode: 'anthropic_direct',
      lightModel: 'claude-light',
      credentialSources: ['anthropic_api_key'],
    });
    expect(JSON.stringify(payload)).not.toContain('sk-claude-secret');
  });

  it('reports AI disabled policy without requiring runtime credentials', () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expect(payload.aiPolicy).toMatchObject({
      schemaVersion: 1,
      aiEnabled: false,
      source: 'env',
      env: {
        key: 'SMARTPERFETTO_AI_ENABLED',
        rawValue: 'false',
        valid: true,
      },
    });
    expect(payload.aiEngine).toMatchObject({
      runtime: 'openai-agents-sdk',
      aiEnabled: false,
      disabledReason: 'AI is disabled by SMARTPERFETTO_AI_ENABLED=false',
    });
  });

  it('reports invalid AI policy env values as fail-closed', () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'maybe';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expect(payload.aiPolicy).toMatchObject({
      aiEnabled: false,
      env: {
        key: 'SMARTPERFETTO_AI_ENABLED',
        rawValue: 'maybe',
        valid: false,
      },
    });
    expect(payload.aiEngine.aiEnabled).toBe(false);
    expect(payload.aiEngine.disabledReason).toContain('invalid value');
  });

  it('reports effective OpenAI env fallback details without leaking URL secrets', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    process.env.OPENAI_API_KEY = 'sk-env-secret';
    process.env.OPENAI_BASE_URL = 'https://user:pass@env.example/v1?token=secret#hash';
    process.env.OPENAI_AGENTS_PROTOCOL = 'chat_completions';
    process.env.OPENAI_MODEL = 'glm-5.1';
    process.env.OPENAI_LIGHT_MODEL = 'glm-4.5-air';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expectRuntimeDiagnosticsShape(payload, 'openai-agents-sdk');
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.aiEngine).toMatchObject({
      runtime: 'openai-agents-sdk',
      model: 'glm-5.1',
      providerMode: 'openai_chat_completions_compatible',
      configured: true,
      source: 'env',
      credentialSource: 'env-or-default',
      envCredentialSources: ['openai_api_key', 'openai_base_url'],
      providerOverridesEnv: false,
    });
    expect(payload.aiEngine.diagnostics).toMatchObject({
      runtime: 'openai-agents-sdk',
      configured: true,
      protocol: 'chat_completions',
      baseUrl: 'https://env.example/v1',
      lightModel: 'glm-4.5-air',
      credentialSources: ['openai_api_key', 'openai_base_url'],
    });
    expect(JSON.stringify(payload)).not.toContain('sk-env-secret');
    expect(JSON.stringify(payload)).not.toContain('user:pass');
    expect(JSON.stringify(payload)).not.toContain('token=secret');
  });

  it('reports active provider details and marks env credentials as overridden', () => {
    process.env.OPENAI_API_KEY = 'sk-env-secret';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';

    const svc = getProviderService();
    const provider = svc.create({
      name: 'GLM Provider',
      category: 'official',
      type: 'glm',
      models: { primary: 'glm-5.1', light: 'glm-4.5-air' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://user:pass@provider.example/api/paas/v4?token=secret#hash',
        openaiApiKey: 'sk-provider-secret',
        openaiProtocol: 'chat_completions',
      },
    });
    svc.activate(provider.id);

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expectRuntimeDiagnosticsShape(payload, 'openai-agents-sdk');
    expect(payload.aiEngine).toMatchObject({
      runtime: 'openai-agents-sdk',
      model: 'glm-5.1',
      source: 'provider',
      credentialSource: 'provider-manager',
      providerOverridesEnv: true,
      activeProvider: {
        id: provider.id,
        name: 'GLM Provider',
        type: 'glm',
      },
    });
    expect(payload.aiEngine.envCredentialSources).toEqual(['openai_api_key', 'openai_base_url']);
    expect(payload.aiEngine.diagnostics).toMatchObject({
      runtime: 'openai-agents-sdk',
      configured: true,
      baseUrl: 'https://provider.example/api/paas/v4',
      protocol: 'chat_completions',
      lightModel: 'glm-4.5-air',
    });
    expect(JSON.stringify(payload)).not.toContain('sk-provider-secret');
    expect(JSON.stringify(payload)).not.toContain('sk-env-secret');
    expect(JSON.stringify(payload)).not.toContain('user:pass');
    expect(JSON.stringify(payload)).not.toContain('token=secret');
  });

  it('reports public Pi agent-core runtime diagnostics without leaking model JSON', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'pi-agent-core';
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON =
      '{"id":"pi-test","provider":"test","apiKey":"sk-pi-secret"}';
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH =
      '/tmp/pi-agent-core/dist/index.js';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expectRuntimeDiagnosticsShape(payload, 'pi-agent-core');
    expect(payload.aiEngine).toMatchObject({
      runtime: 'pi-agent-core',
      model: 'pi-agent-core',
      providerMode: 'pi-agent-core',
      configured: true,
      source: 'env',
      credentialSource: 'env-or-default',
      envCredentialSources: [
        'pi_agent_core_model_json',
        'pi_agent_core_module_path',
      ],
      providerOverridesEnv: false,
    });
    expect(payload.aiEngine.diagnostics).toMatchObject({
      runtime: 'pi-agent-core',
      configured: true,
      experimental: false,
      modelConfigured: true,
      modulePath: '/tmp/pi-agent-core/dist/index.js',
    });
    expect(JSON.stringify(payload)).not.toContain('sk-pi-secret');
  });

  it('reports public OpenCode runtime diagnostics without leaking model JSON', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'opencode';
    process.env.SMARTPERFETTO_OPENCODE_MODEL_JSON =
      '{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-secret"}';
    process.env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH =
      '/tmp/opencode-sdk/dist/index.js';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

    expectRuntimeDiagnosticsShape(payload, 'opencode');
    expect(payload.aiEngine).toMatchObject({
      runtime: 'opencode',
      model: 'opencode',
      providerMode: 'opencode',
      configured: true,
      source: 'env',
      credentialSource: 'env-or-default',
      envCredentialSources: [
        'opencode_model_json',
        'opencode_sdk_module_path',
      ],
      providerOverridesEnv: false,
    });
    expect(payload.aiEngine.diagnostics).toMatchObject({
      runtime: 'opencode',
      configured: true,
      experimental: false,
      modelConfigured: true,
      modulePath: '/tmp/opencode-sdk/dist/index.js',
    });
    expect(JSON.stringify(payload)).not.toContain('sk-opencode-secret');
  });

  it('routes health diagnostics through the shared runtime diagnostics resolver', async () => {
    const source = await fsp.readFile(path.resolve(__dirname, '..', 'runtimeHealth.ts'), 'utf8');

    expect(source).toContain('getRuntimeDiagnostics');
    expect(source).not.toMatch(/getClaudeRuntimeDiagnostics/);
    expect(source).not.toMatch(/getOpenAIRuntimeDiagnostics/);
    expect(source).not.toMatch(/getPiAgentCoreRuntimeDiagnostics/);
    expect(source).not.toMatch(/getOpenCodeRuntimeDiagnostics/);
    expect(source).not.toMatch(/EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND|EXPERIMENTAL_OPENCODE_RUNTIME_KIND/);
  });
});
