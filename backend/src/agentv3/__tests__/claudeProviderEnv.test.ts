// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createSdkEnv, getSdkBinaryOption, resolveRuntimeConfig, type ClaudeAgentConfig } from '../claudeConfig';
import { getProviderService, resetProviderService } from '../../services/providerManager';

const ORIGINAL_ENV = {
  PROVIDER_DATA_DIR_OVERRIDE: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CLAUDE_BINARY_PATH: process.env.CLAUDE_BINARY_PATH,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  CLAUDE_MAX_TURNS: process.env.CLAUDE_MAX_TURNS,
  CLAUDE_EFFORT: process.env.CLAUDE_EFFORT,
  CLAUDE_ENABLE_SUB_AGENTS: process.env.CLAUDE_ENABLE_SUB_AGENTS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('createSdkEnv provider isolation', () => {
  let dir: string;

  const baseConfig: ClaudeAgentConfig = {
    model: 'base-claude-model',
    lightModel: 'base-claude-light',
    maxTurns: 60,
    quickTargetTurns: 5,
    cwd: process.cwd(),
    effort: 'high',
    enableSubAgents: false,
    enableVerification: true,
    subAgentTimeoutMs: 120_000,
    fullPathPerTurnMs: 60_000,
    fullRequestTimeoutMs: 20 * 60_000,
    streamIdleTimeoutMs: 5 * 60_000,
    quickPathPerTurnMs: 40_000,
    verifierTimeoutMs: 60_000,
    classifierTimeoutMs: 30_000,
    outputLanguage: 'zh-CN',
  };

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `claude-provider-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    process.env.ANTHROPIC_API_KEY = 'sk-global-anthropic';
    process.env.ANTHROPIC_BASE_URL = 'https://global-anthropic.example';
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.CLAUDE_MODEL = 'global-claude-model';
    process.env.CLAUDE_MAX_TURNS = '99';
    process.env.CLAUDE_EFFORT = 'max';
    process.env.CLAUDE_ENABLE_SUB_AGENTS = 'true';

    const svc = getProviderService();
    const p = svc.create({
      name: 'DeepSeek Claude Surface',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://api.deepseek.com/anthropic',
      },
    });
    svc.activate(p.id);

    const env = createSdkEnv();

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBe('deepseek-v4-pro');

    const config = resolveRuntimeConfig(baseConfig);
    expect(config.model).toBe('deepseek-v4-pro');
    expect(config.lightModel).toBe('deepseek-v4-flash');
    expect(config.maxTurns).toBe(60);
    expect(config.effort).toBe('high');
    expect(config.enableSubAgents).toBe(false);
  });

  it('applies Claude provider tuning without inheriting global Claude env', () => {
    process.env.CLAUDE_MAX_TURNS = '99';
    process.env.CLAUDE_EFFORT = 'max';
    process.env.CLAUDE_ENABLE_SUB_AGENTS = 'true';

    const svc = getProviderService();
    const p = svc.create({
      name: 'Tuned Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'provider-main', light: 'provider-light', subAgent: 'sonnet' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeApiKey: 'sk-provider-anthropic',
      },
      tuning: {
        maxTurns: 7,
        effort: 'low',
        enableSubAgents: false,
        enableVerification: false,
        verifierTimeoutMs: 7000,
      },
    });
    svc.activate(p.id);

    const config = resolveRuntimeConfig(baseConfig);

    expect(config.model).toBe('provider-main');
    expect(config.lightModel).toBe('provider-light');
    expect(config.subAgentModel).toBe('sonnet');
    expect(config.maxTurns).toBe(7);
    expect(config.effort).toBe('low');
    expect(config.enableSubAgents).toBe(false);
    expect(config.enableVerification).toBe(false);
    expect(config.verifierTimeoutMs).toBe(7000);
  });

  it('ignores an active OpenAI provider when resolving Claude env without an explicit providerId', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-global-anthropic';
    process.env.ANTHROPIC_BASE_URL = 'https://global-anthropic.example';

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

    const env = createSdkEnv();
    const config = resolveRuntimeConfig(baseConfig);

    expect(env.ANTHROPIC_API_KEY).toBe('sk-global-anthropic');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://global-anthropic.example');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBeUndefined();
    expect(config.model).toBe('base-claude-model');
    expect(config.lightModel).toBe('base-claude-light');
  });

  it('ignores the active Claude provider when providerId is explicitly null', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-global-anthropic';
    process.env.ANTHROPIC_BASE_URL = 'https://global-anthropic.example';

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

    const env = createSdkEnv(null);
    const config = resolveRuntimeConfig(baseConfig, null);

    expect(env.ANTHROPIC_API_KEY).toBe('sk-global-anthropic');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://global-anthropic.example');
    expect(env.CLAUDE_MODEL).toBeUndefined();
    expect(config.model).toBe('base-claude-model');
    expect(config.lightModel).toBe('base-claude-light');
  });

  it('throws instead of falling back when explicit providerId is missing', () => {
    expect(() => createSdkEnv('missing-provider')).toThrow(
      'Provider not found: missing-provider',
    );
  });

  it('throws instead of falling back when explicit providerId targets an OpenAI runtime', () => {
    const svc = getProviderService();
    const p = svc.create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiApiKey: 'sk-provider-openai',
      },
    });

    expect(() => createSdkEnv(p.id)).toThrow(
      `Provider ${p.id} is configured for openai-agents-sdk, not claude-agent-sdk`,
    );
    expect(() => resolveRuntimeConfig(baseConfig, p.id)).toThrow(
      `Provider ${p.id} is configured for openai-agents-sdk, not claude-agent-sdk`,
    );
  });

  it('derives the SDK binary option from the same env object passed to the SDK', () => {
    process.env.CLAUDE_BINARY_PATH = '/global/claude';

    expect(getSdkBinaryOption({ CLAUDE_BINARY_PATH: '/provider/claude' })).toEqual({
      pathToClaudeCodeExecutable: '/provider/claude',
    });
    expect(getSdkBinaryOption({ CLAUDE_BINARY_PATH: '   ' })).toEqual({});
    expect(getSdkBinaryOption()).toEqual({
      pathToClaudeCodeExecutable: '/global/claude',
    });
  });
});
