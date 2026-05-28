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

describe('buildRuntimeHealthPayload', () => {
  let dir: string;

  beforeEach(async () => {
    restoreEnv();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-runtime-health-'));
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    resetProviderService();
  });

  afterEach(async () => {
    restoreEnv();
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reports effective OpenAI env fallback details without leaking URL secrets', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    process.env.OPENAI_API_KEY = 'sk-env-secret';
    process.env.OPENAI_BASE_URL = 'https://user:pass@env.example/v1?token=secret#hash';
    process.env.OPENAI_AGENTS_PROTOCOL = 'chat_completions';
    process.env.OPENAI_MODEL = 'glm-5.1';
    process.env.OPENAI_LIGHT_MODEL = 'glm-4.5-air';

    const payload = buildRuntimeHealthPayload(new Date('2026-05-20T00:00:00.000Z'));

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
      baseUrl: 'https://provider.example/api/paas/v4',
      protocol: 'chat_completions',
      lightModel: 'glm-4.5-air',
    });
    expect(JSON.stringify(payload)).not.toContain('sk-provider-secret');
    expect(JSON.stringify(payload)).not.toContain('sk-env-secret');
    expect(JSON.stringify(payload)).not.toContain('user:pass');
    expect(JSON.stringify(payload)).not.toContain('token=secret');
  });
});
