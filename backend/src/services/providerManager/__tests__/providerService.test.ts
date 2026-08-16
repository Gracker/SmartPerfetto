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
    models: { primary: 'claude-sonnet-5', light: 'claude-haiku-4-5' },
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
          piAgentCoreModelJson: '{"apiKey":"sk-pi-runtime123456","id":"pi-test"}',
          openCodeModelJson: '{"apiKey":"sk-opencode-runtime123456","modelID":"opencode-test"}',
        },
      });
      const list = svc.list();
      expect(list[0].connection.claudeApiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.claudeAuthToken).toMatch(/^\*{4}/);
      expect(list[0].connection.openaiApiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.piAgentCoreModelJson).toMatch(/^\*{4}/);
      expect(list[0].connection.openCodeModelJson).toMatch(/^\*{4}/);
    });

    it('masks sensitive custom headers and env overrides in returned providers', () => {
      const created = svc.create({
        ...validInput,
        type: 'custom',
        connection: {
          agentRuntime: 'openai-agents-sdk',
          openaiBaseUrl: 'https://gateway.example/v1',
          openaiProtocol: 'chat_completions',
        },
        custom: {
          headers: {
            Authorization: 'Bearer provider-secret-token',
            'x-request-id': 'public-request-id',
            'x-api-key': 'sk-header-secret123456',
          },
          envOverrides: {
            OPENAI_API_KEY: 'sk-env-secret123456',
            ANTHROPIC_AUTH_TOKEN: 'anthropic-token-123456',
            OPENAI_BASE_URL: 'https://gateway.example/v1',
          },
        },
      });

      const listed = svc.list()[0];
      const fetched = svc.get(created.id)!;

      expect(listed.custom?.headers?.Authorization).toMatch(/^\*{4}/);
      expect(listed.custom?.headers?.['x-api-key']).toMatch(/^\*{4}/);
      expect(listed.custom?.headers?.['x-request-id']).toBe('public-request-id');
      expect(listed.custom?.envOverrides?.OPENAI_API_KEY).toMatch(/^\*{4}/);
      expect(listed.custom?.envOverrides?.ANTHROPIC_AUTH_TOKEN).toMatch(/^\*{4}/);
      expect(listed.custom?.envOverrides?.OPENAI_BASE_URL).toBe('https://gateway.example/v1');
      expect(fetched.custom?.envOverrides?.OPENAI_API_KEY).toMatch(/^\*{4}/);
      expect(svc.getEnvForProvider(created.id)?.OPENAI_API_KEY).toBe('sk-env-secret123456');
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

  describe('endpoint credential boundary', () => {
    it('does not forward a stored credential to a newly configured origin', () => {
      const provider = svc.create({
        ...validInput,
        connection: {
          apiKey: 'sk-existing-secret',
          openaiBaseUrl: 'https://trusted.example/v1',
        },
      });

      expect(() => svc.update(provider.id, {
        connection: {openaiBaseUrl: 'https://attacker.example/v1'},
      })).toThrow(/re-enter or clear credential field 'apiKey'/);
      expect(svc.getRaw(provider.id)?.connection.openaiBaseUrl)
        .toBe('https://trusted.example/v1');
    });

    it('allows an origin change only when credentials are explicitly replaced or cleared', () => {
      const provider = svc.create({
        ...validInput,
        connection: {
          apiKey: 'sk-existing-secret',
          openaiBaseUrl: 'https://trusted.example/v1',
        },
      });

      svc.update(provider.id, {
        connection: {
          openaiBaseUrl: 'https://replacement.example/v1',
          apiKey: 'sk-replacement-secret',
        },
      });
      expect(svc.getRaw(provider.id)?.connection.apiKey).toBe('sk-replacement-secret');
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
      expect(env.CLAUDE_MODEL).toBe('claude-sonnet-5');
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

    it('normalizes short Anthropic model IDs to Bedrock cross-region IDs', () => {
      // Bedrock rejects 'claude-sonnet-5' with 400 invalid model identifier.
      // An existing bedrock provider that still holds a short name must be
      // normalized at env-build time. See GitHub issue #179.
      const p = svc.create({
        ...validInput,
        type: 'bedrock',
        connection: { awsRegion: 'us-west-2', awsBearerToken: 'tok123' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.CLAUDE_MODEL).toBe('us.anthropic.claude-sonnet-5');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    });

    it('preserves an explicit Bedrock model ID without re-normalizing', () => {
      // A user-provided Bedrock ID (any region prefix / direct ID) must pass
      // through unchanged so Provider Manager/runtime pinning semantics stay intact.
      const p = svc.create({
        ...validInput,
        type: 'bedrock',
        models: {
          primary: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
          light: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        },
        connection: { awsRegion: 'eu-west-1', awsBearerToken: 'tok123' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.CLAUDE_MODEL).toBe('eu.anthropic.claude-sonnet-4-5-20250929-v1:0');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('eu.anthropic.claude-haiku-4-5-20251001-v1:0');
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

    it('uses bearer auth for every dual-surface provider on the Claude runtime', () => {
      const providerTypes = [
        'deepseek',
        'glm',
        'qwen',
        'qwen_coding',
        'kimi_code',
        'kimi',
        'doubao',
        'minimax',
        'xiaomi',
        'tencent_token_plan',
        'tencent_coding_plan',
        'hunyuan',
        'qianfan',
        'stepfun',
        'siliconflow',
        'huawei',
      ] as const;

      for (const type of providerTypes) {
        const env = svc.getEnvForProvider(svc.create({
          ...validInput,
          name: `Dual ${type}`,
          type,
          models: { primary: `${type}-primary`, light: `${type}-light` },
          connection: {
            apiKey: `sk-${type}-test`,
            agentRuntime: 'claude-agent-sdk',
            claudeBaseUrl: `https://${type}.example.test/anthropic`,
            openaiBaseUrl: `https://${type}.example.test/v1`,
          },
        }).id)!;

        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(`sk-${type}-test`);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      }
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

    it('rejects public Pi runtime for non-custom provider types', () => {
      expect(() => svc.create({
        ...validInput,
        type: 'deepseek',
        connection: {
          apiKey: 'sk-deepseek-test',
          agentRuntime: 'pi-agent-core',
          piAgentCoreModelJson: '{"id":"pi-test","provider":"test"}',
        },
      })).toThrow(/does not support pi-agent-core/);
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

    it('returns Pi agent-core env vars for custom Pi providers without Claude/OpenAI model env', () => {
      const p = svc.create({
        ...validInput,
        type: 'custom',
        models: { primary: 'pi-model', light: 'pi-light' },
        connection: {
          agentRuntime: 'pi-agent-core',
          piAgentCoreModulePath: '/tmp/pi-agent-core/dist/index.js',
          piAgentCoreModelJson: '{"id":"pi-test","provider":"test","apiKey":"sk-pi-secret"}',
          piAgentCoreSystemPrompt: 'Runtime-only Pi prompt',
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('pi-agent-core');
      expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH).toBe('/tmp/pi-agent-core/dist/index.js');
      expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBe('{"id":"pi-test","provider":"test","apiKey":"sk-pi-secret"}');
      expect(env.SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT).toBe('Runtime-only Pi prompt');
      expect(env.OPENAI_MODEL).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CLAUDE_MODEL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('returns OpenCode env vars for custom OpenCode providers', () => {
      const p = svc.create({
        ...validInput,
        type: 'custom',
        models: { primary: 'opencode-primary', light: 'opencode-light' },
        connection: {
          agentRuntime: 'opencode',
          openaiBaseUrl: 'https://example.test/v1',
          openaiApiKey: 'sk-opencode-openai',
          openCodeSdkModulePath: '/tmp/opencode-sdk/dist/index.js',
          openCodeModelJson: '{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-secret"}',
          openCodeSystemPrompt: 'Runtime-only OpenCode prompt',
          openaiProtocol: 'chat_completions',
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('opencode');
      expect(env.OPENAI_BASE_URL).toBe('https://example.test/v1');
      expect(env.OPENAI_API_KEY).toBe('sk-opencode-openai');
      expect(env.OPENAI_AGENTS_PROTOCOL).toBe('chat_completions');
      expect(env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH).toBe('/tmp/opencode-sdk/dist/index.js');
      expect(env.SMARTPERFETTO_OPENCODE_MODEL_JSON).toBe('{"providerID":"smartperfetto","modelID":"opencode-test","apiKey":"sk-opencode-secret"}');
      expect(env.SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT).toBe('Runtime-only OpenCode prompt');
      expect(env.OPENAI_MODEL).toBeUndefined();
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
          maxBudgetUsd: 12,
          effort: 'max',
          fullPerTurnMs: 90000,
          quickPerTurnMs: 45000,
          verifierTimeoutMs: 70000,
          classifierTimeoutMs: 15000,
          enableSubAgents: true,
          enableVerification: false,
        },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;

      expect(env.OPENAI_MAX_TURNS).toBe('80');
      expect(env.OPENAI_FULL_PER_TURN_MS).toBe('90000');
      expect(env.OPENAI_QUICK_PER_TURN_MS).toBe('45000');
      expect(env.OPENAI_CLASSIFIER_TIMEOUT_MS).toBe('15000');
      expect(env.OPENAI_MAX_BUDGET_USD).toBeUndefined();
      expect(env.OPENAI_EFFORT).toBeUndefined();
      expect(env.OPENAI_VERIFIER_TIMEOUT_MS).toBeUndefined();
      expect(env.OPENAI_ENABLE_SUB_AGENTS).toBeUndefined();
      expect(env.OPENAI_ENABLE_VERIFICATION).toBeUndefined();
      expect(env.CLAUDE_MAX_TURNS).toBeUndefined();
    });

    it.each([
      ['SMARTPERFETTO_AGENT_RUNTIME', 'claude-agent-sdk'],
      ['SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON', '["/bin/sh","-c","id"]'],
      ['SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH', '/tmp/hostile-sdk.mjs'],
      ['PI_NODE_OPTIONS', '--require=/tmp/hostile-pi.cjs'],
      ['NODE_OPTIONS', '--require=/tmp/hostile.cjs'],
    ])('rejects process-control custom env override %s', (key, value) => {
      expect(() => svc.create({
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
            [key]: value,
          },
        },
      })).toThrow(`Custom provider env override is not allowed: ${key}`);
    });

    it('allows only scoped Qoder BYOK overrides on a Qoder custom provider', () => {
      const provider = svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-main', light: 'deepseek-light'},
        connection: {agentRuntime: 'qoder-agent-sdk'},
        custom: {
          envOverrides: {
            QODER_BYOK_API_KEY: 'managed-deepseek-key',
            QODER_BYOK_PROVIDER: 'deepseek',
            QODER_BYOK_BASE_URL: 'https://api.deepseek.com/v1',
            QODER_BYOK_STYLE: 'openai',
          },
        },
      });

      expect(svc.getEnvForProvider(provider.id)).toMatchObject({
        QODER_BYOK_API_KEY: 'managed-deepseek-key',
        QODER_BYOK_PROVIDER: 'deepseek',
        QODER_BYOK_BASE_URL: 'https://api.deepseek.com/v1',
        QODER_BYOK_STYLE: 'openai',
      });
      expect(svc.get(provider.id)?.custom?.envOverrides?.QODER_BYOK_API_KEY)
        .toMatch(/^\*{4}/);
    });

    it.each([
      'https://user:password@api.deepseek.com/v1',
      'https://api.deepseek.com/v1?api_key=secret',
      'https://api.deepseek.com/v1#secret',
      'ftp://api.deepseek.com/v1',
      'not-a-url',
    ])('rejects unsafe Qoder BYOK base URL %s', (baseUrl) => {
      expect(() => svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-main', light: 'deepseek-light'},
        connection: {agentRuntime: 'qoder-agent-sdk'},
        custom: {envOverrides: {QODER_BYOK_BASE_URL: baseUrl}},
      })).toThrow('QODER_BYOK_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    });

    it.each([
      ['QODER_BYOK_API_KEY', 'managed-deepseek-key'],
      ['QODER_BYOK_PROVIDER', 'deepseek'],
      ['QODER_BYOK_BASE_URL', 'https://api.deepseek.com/v1'],
      ['QODER_BYOK_STYLE', 'openai'],
    ])('rejects Qoder BYOK override %s for a non-Qoder runtime', (key, value) => {
      expect(() => svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'custom-openai-main', light: 'custom-openai-light'},
        connection: {agentRuntime: 'openai-agents-sdk'},
        custom: {envOverrides: {[key]: value}},
      })).toThrow(`Custom provider env override is not allowed: ${key}`);
    });

    it('rejects switching away from Qoder while Qoder BYOK overrides remain', () => {
      const provider = svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-main', light: 'deepseek-light'},
        connection: {agentRuntime: 'qoder-agent-sdk'},
        custom: {
          envOverrides: {
            QODER_BYOK_API_KEY: 'managed-deepseek-key',
            QODER_BYOK_PROVIDER: 'deepseek',
          },
        },
      });

      expect(() => svc.switchAgentRuntime(provider.id, 'opencode')).toThrow(
        'Custom provider env override is not allowed: QODER_BYOK_API_KEY',
      );
      expect(svc.getRawProvider(provider.id)?.connection.agentRuntime).toBe('qoder-agent-sdk');
    });

    it.each([
      ['QODERCLI_PATH', '/tmp/hostile-qodercli'],
      ['SMARTPERFETTO_QODER_SDK_MODULE_PATH', '/tmp/hostile-sdk.mjs'],
      ['QODER_WORKER_RUNTIME_PATH', '/tmp/hostile-worker.mjs'],
    ])('rejects Qoder process-control override %s even for Qoder providers', (key, value) => {
      expect(() => svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'qoder-main', light: 'qoder-light'},
        connection: {agentRuntime: 'qoder-agent-sdk'},
        custom: {envOverrides: {[key]: value}},
      })).toThrow(`Custom provider env override is not allowed: ${key}`);
    });

    it('allows Pi provider-scoped credentials on a Pi custom provider', () => {
      const provider = svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          agentRuntime: 'pi-agent-core',
          piAgentCoreModelJson: '{"id":"deepseek-chat","provider":"deepseek"}',
        },
        custom: {
          envOverrides: {
            DEEPSEEK_API_KEY: 'managed-deepseek-key',
            GOOGLE_APPLICATION_CREDENTIALS: '/managed/google.json',
          },
        },
      });

      expect(svc.getEnvForProvider(provider.id)).toMatchObject({
        DEEPSEEK_API_KEY: 'managed-deepseek-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/managed/google.json',
      });
    });

    it('rejects Pi-only provider credentials for non-Pi custom runtimes', () => {
      expect(() => svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'custom-openai-main', light: 'custom-openai-light'},
        connection: {
          agentRuntime: 'openai-agents-sdk',
          openaiBaseUrl: 'https://gateway.example/v1',
          openaiProtocol: 'chat_completions',
        },
        custom: {
          envOverrides: {
            GOOGLE_APPLICATION_CREDENTIALS: '/managed/google.json',
          },
        },
      })).toThrow(
        'Custom provider env override is not allowed: GOOGLE_APPLICATION_CREDENTIALS',
      );
    });

    it('allows adding Pi-only provider credentials while updating a Pi runtime', () => {
      const provider = svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          agentRuntime: 'pi-agent-core',
          piAgentCoreModelJson: '{"id":"deepseek-chat","provider":"deepseek"}',
        },
      });

      expect(() => svc.update(provider.id, {
        custom: {envOverrides: {DEEPSEEK_API_KEY: 'managed-deepseek-key'}},
      })).not.toThrow();
    });

    it('rejects switching away from Pi while Pi-only provider credentials remain', () => {
      const provider = svc.create({
        ...validInput,
        type: 'custom',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          agentRuntime: 'pi-agent-core',
          piAgentCoreModelJson: '{"id":"deepseek-chat","provider":"deepseek"}',
        },
        custom: {envOverrides: {DEEPSEEK_API_KEY: 'managed-deepseek-key'}},
      });

      expect(() => svc.switchAgentRuntime(provider.id, 'opencode')).toThrow(
        'Custom provider env override is not allowed: DEEPSEEK_API_KEY',
      );
      expect(svc.getRawProvider(provider.id)?.connection.agentRuntime).toBe('pi-agent-core');
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
