// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createOpenAIEnv } from '../openAiConfig';
import { getProviderService, resetProviderService } from '../../services/providerManager';

const ORIGINAL_ENV = {
  PROVIDER_DATA_DIR_OVERRIDE: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('createOpenAIEnv', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `openai-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    resetProviderService();
  });

  afterEach(async () => {
    restoreEnv();
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('isolates active provider env from unrelated global LLM credentials', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-anthropic';
    process.env.CLAUDE_MODEL = 'global-claude-model';

    const svc = getProviderService();
    const p = svc.create({
      name: 'DeepSeek OpenAI Surface',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
        openaiProtocol: 'chat_completions',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv();

    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBeUndefined();
  });

  it('ignores an active Claude provider when resolving OpenAI env without an explicit providerId', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';

    const svc = getProviderService();
    const p = svc.create({
      name: 'Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-provider-model', light: 'claude-provider-light' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://provider-anthropic.example',
        claudeApiKey: 'sk-provider-anthropic',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv();

    expect(env.OPENAI_API_KEY).toBe('sk-global-openai');
    expect(env.OPENAI_BASE_URL).toBe('https://global-openai.example/v1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBeUndefined();
  });

  it('ignores the active OpenAI provider when providerId is explicitly null', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';

    const svc = getProviderService();
    const p = svc.create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://provider-openai.example/v1',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv(null);

    expect(env.OPENAI_API_KEY).toBe('sk-global-openai');
    expect(env.OPENAI_BASE_URL).toBe('https://global-openai.example/v1');
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it('throws instead of falling back when explicit providerId is missing', () => {
    expect(() => createOpenAIEnv('missing-provider')).toThrow(
      'Provider not found: missing-provider',
    );
  });

  it('throws instead of falling back when explicit providerId targets a Claude runtime', () => {
    const svc = getProviderService();
    const p = svc.create({
      name: 'Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-provider-model', light: 'claude-provider-light' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeApiKey: 'sk-provider-anthropic',
      },
    });

    expect(() => createOpenAIEnv(p.id)).toThrow(
      `Provider ${p.id} is configured for claude-agent-sdk, not openai-agents-sdk`,
    );
  });
});
