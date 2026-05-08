// backend/src/services/providerManager/__tests__/providerService.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderService } from '../providerService';
import type { ProviderCreateInput } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('ProviderService', () => {
  let dir: string;
  let svc: ProviderService;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    svc = new ProviderService(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const validInput: ProviderCreateInput = {
    name: 'My Anthropic',
    category: 'official',
    type: 'anthropic',
    models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    connection: { apiKey: 'sk-ant-test123456' },
  };

  describe('create', () => {
    it('creates a provider with generated id and timestamps', () => {
      const result = svc.create(validInput);
      expect(result.id).toBeDefined();
      expect(result.name).toBe('My Anthropic');
      expect(result.isActive).toBe(false);
      expect(result.createdAt).toBeDefined();
    });

    it('throws on missing name', () => {
      expect(() => svc.create({ ...validInput, name: '' })).toThrow();
    });
  });

  describe('list (masked)', () => {
    it('masks apiKey in returned list', () => {
      svc.create(validInput);
      const list = svc.list();
      expect(list[0].connection.apiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.apiKey).not.toBe('sk-ant-test123456');
    });

    it('masks runtime-specific credentials in returned list', () => {
      svc.create({
        ...validInput,
        connection: {
          claudeApiKey: 'sk-ant-runtime123456',
          claudeAuthToken: 'provider-token-123456',
          openaiApiKey: 'sk-openai-runtime123456',
        },
      });
      const list = svc.list();
      expect(list[0].connection.claudeApiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.claudeAuthToken).toMatch(/^\*{4}/);
      expect(list[0].connection.openaiApiKey).toMatch(/^\*{4}/);
    });
  });

  describe('activate', () => {
    it('sets provider as active and deactivates others', () => {
      const p1 = svc.create({ ...validInput, name: 'P1' });
      const p2 = svc.create({ ...validInput, name: 'P2' });
      svc.activate(p1.id);
      expect(svc.get(p1.id)!.isActive).toBe(true);
      svc.activate(p2.id);
      expect(svc.get(p1.id)!.isActive).toBe(false);
      expect(svc.get(p2.id)!.isActive).toBe(true);
    });

    it('throws on nonexistent id', () => {
      expect(() => svc.activate('fake-id')).toThrow();
    });
  });

  describe('delete', () => {
    it('deletes inactive provider', () => {
      const p = svc.create(validInput);
      svc.delete(p.id);
      expect(svc.list()).toHaveLength(0);
    });

    it('throws when deleting active provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      expect(() => svc.delete(p.id)).toThrow(/active/i);
    });
  });

  describe('getEffectiveEnv', () => {
    it('returns null when no active provider', () => {
      expect(svc.getEffectiveEnv()).toBeNull();
    });

    it('returns env vars for active anthropic provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
      expect(env.CLAUDE_MODEL).toBe('claude-sonnet-4-6');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('claude-haiku-4-5');
    });

    it('returns bedrock env vars', () => {
      const p = svc.create({
        ...validInput,
        type: 'bedrock',
        connection: { awsRegion: 'us-west-2', awsBearerToken: 'tok123' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.AWS_REGION).toBe('us-west-2');
      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('tok123');
    });

    it('uses DeepSeek Anthropic-compatible endpoint by default', () => {
      const p = svc.create({
        ...validInput,
        type: 'deepseek',
        models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
        connection: {
          apiKey: 'sk-deepseek-test',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-deepseek-test');
      expect(env.CLAUDE_MODEL).toBe('deepseek-v4-pro');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('deepseek-v4-flash');
    });

    it('uses DeepSeek OpenAI-compatible endpoint when runtime is OpenAI Agents SDK', () => {
      const p = svc.create({
        ...validInput,
        type: 'deepseek',
        models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
        connection: {
          apiKey: 'sk-deepseek-test',
          agentRuntime: 'openai-agents-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
          openaiProtocol: 'chat_completions',
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
      expect(env.OPENAI_API_KEY).toBe('sk-deepseek-test');
      expect(env.OPENAI_AGENTS_PROTOCOL).toBe('chat_completions');
      expect(env.OPENAI_MODEL).toBe('deepseek-v4-pro');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.CLAUDE_MODEL).toBeUndefined();
    });

    it('switches an existing dual-surface provider runtime explicitly', () => {
      const p = svc.create({
        ...validInput,
        type: 'deepseek',
        models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
        connection: {
          apiKey: 'sk-deepseek-test',
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
          openaiProtocol: 'chat_completions',
        },
      });

      svc.switchAgentRuntime(p.id, 'openai-agents-sdk');
      const env = svc.getEnvForProvider(p.id)!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('supports OpenAI runtime for non-DeepSeek dual-surface provider types', () => {
      const p = svc.create({
        ...validInput,
        type: 'xiaomi',
        models: { primary: 'mimo-v2.5-pro', light: 'mimo-v2.5-pro' },
        connection: {
          apiKey: 'sk-xiaomi-test',
          agentRuntime: 'openai-agents-sdk',
          claudeBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
          openaiBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
          openaiProtocol: 'chat_completions',
        },
      });
      const env = svc.getEnvForProvider(p.id)!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(env.OPENAI_BASE_URL).toBe('https://token-plan-sgp.xiaomimimo.com/v1');
      expect(env.OPENAI_API_KEY).toBe('sk-xiaomi-test');
      expect(env.OPENAI_MODEL).toBe('mimo-v2.5-pro');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('rejects switching Claude-only providers to OpenAI runtime', () => {
      const p = svc.create(validInput);

      expect(() => svc.switchAgentRuntime(p.id, 'openai-agents-sdk')).toThrow(
        /does not support openai-agents-sdk/,
      );
    });

    it('rejects creating OpenAI-only providers with Claude runtime', () => {
      expect(() => svc.create({
        ...validInput,
        type: 'openai',
        models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
        connection: { agentRuntime: 'claude-agent-sdk', openaiApiKey: 'sk-openai-test' },
      })).toThrow(/does not support claude-agent-sdk/);
    });

    it('rejects stale non-SDK runtime overrides on providers', () => {
      expect(() => svc.resolveAgentRuntime({
        ...validInput,
        id: 'stale-runtime',
        type: 'deepseek',
        connection: { agentRuntime: 'agentv2' as any },
      } as any)).toThrow(/Invalid agent runtime: agentv2/);
    });

    it('returns OpenAI Agents SDK env vars for active OpenAI provider', () => {
      const p = svc.create({
        ...validInput,
        type: 'openai',
        models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
        connection: { openaiApiKey: 'sk-openai-test', openaiBaseUrl: 'https://api.openai.com/v1' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
      expect(env.OPENAI_API_KEY).toBe('sk-openai-test');
      expect(env.OPENAI_AGENTS_PROTOCOL).toBe('responses');
      expect(env.OPENAI_MODEL).toBe('gpt-5.5');
      expect(env.OPENAI_LIGHT_MODEL).toBe('gpt-5.4-mini');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.CLAUDE_MODEL).toBeUndefined();
    });

    it('maps OpenAI provider tuning to OpenAI runtime env vars', () => {
      const p = svc.create({
        ...validInput,
        type: 'openai',
        models: { primary: 'gpt-5.5', light: 'gpt-5.4-mini' },
        connection: { openaiApiKey: 'sk-openai-test' },
        tuning: {
          maxTurns: 80,
          fullPerTurnMs: 90000,
          quickPerTurnMs: 45000,
          classifierTimeoutMs: 15000,
          enableVerification: false,
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.OPENAI_MAX_TURNS).toBe('80');
      expect(env.OPENAI_FULL_PER_TURN_MS).toBe('90000');
      expect(env.OPENAI_QUICK_PER_TURN_MS).toBe('45000');
      expect(env.OPENAI_CLASSIFIER_TIMEOUT_MS).toBe('15000');
      expect(env.OPENAI_ENABLE_VERIFICATION).toBe('false');
      expect(env.CLAUDE_MAX_TURNS).toBeUndefined();
    });

    it('does not allow custom env overrides to flip the selected SDK runtime', () => {
      const p = svc.create({
        ...validInput,
        type: 'custom',
        models: { primary: 'custom-openai-main', light: 'custom-openai-light' },
        connection: {
          agentRuntime: 'openai-agents-sdk',
          openaiBaseUrl: 'https://gateway.example/v1',
          openaiProtocol: 'chat_completions',
        },
        custom: {
          envOverrides: {
            SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
          },
        },
      });

      const env = svc.getEnvForProvider(p.id)!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('openai-agents-sdk');
      expect(env.OPENAI_MODEL).toBe('custom-openai-main');
    });
  });

  describe('getEnvForProvider', () => {
    it('returns env for a specific provider by id', () => {
      const p = svc.create(validInput);
      const env = svc.getEnvForProvider(p.id)!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });

    it('returns null for nonexistent id', () => {
      expect(svc.getEnvForProvider('nope')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates name without touching credentials', () => {
      const p = svc.create(validInput);
      svc.update(p.id, { name: 'Renamed' });
      expect(svc.get(p.id)!.name).toBe('Renamed');
      expect(svc.getEnvForProvider(p.id)!.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });
  });
});
