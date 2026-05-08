// backend/src/services/providerManager/providerService.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { v4 as uuidv4 } from 'uuid';
import { ProviderStore } from './providerStore';
import type {
  AgentRuntimeKind,
  DualSurfaceProviderType,
  OpenAIProtocol,
  ProviderConfig,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderType,
} from './types';

const SENSITIVE_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'openaiApiKey',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

const DUAL_SURFACE_PROVIDER_TYPES: DualSurfaceProviderType[] = [
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
];
const CLAUDE_RUNTIME_TYPES: ProviderType[] = ['anthropic', 'bedrock', 'vertex', ...DUAL_SURFACE_PROVIDER_TYPES, 'custom'];
const OPENAI_RUNTIME_TYPES: ProviderType[] = ['openai', 'ollama', ...DUAL_SURFACE_PROVIDER_TYPES, 'custom'];

function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}

function maskConnection(conn: ProviderConfig['connection']): ProviderConfig['connection'] {
  const masked = { ...conn };
  for (const field of SENSITIVE_FIELDS) {
    const val = masked[field];
    if (typeof val === 'string' && val) (masked as any)[field] = maskValue(val);
  }
  return masked;
}

function maskProvider(p: ProviderConfig): ProviderConfig {
  return { ...p, connection: maskConnection(p.connection) };
}

function isSupportedRuntimeForProvider(type: ProviderType, runtime: AgentRuntimeKind): boolean {
  return runtime === 'openai-agents-sdk'
    ? OPENAI_RUNTIME_TYPES.includes(type)
    : CLAUDE_RUNTIME_TYPES.includes(type);
}

function isDualSurfaceProviderType(type: ProviderType): type is DualSurfaceProviderType {
  return DUAL_SURFACE_PROVIDER_TYPES.includes(type as DualSurfaceProviderType);
}

function sharedKeyShouldUseClaudeAuthToken(type: ProviderType): boolean {
  return [
    'deepseek',
    'qwen',
    'qwen_coding',
    'kimi',
    'doubao',
    'minimax',
    'tencent_token_plan',
    'tencent_coding_plan',
    'hunyuan',
    'qianfan',
    'stepfun',
    'huawei',
  ].includes(type);
}

export class ProviderService {
  private store: ProviderStore;

  constructor(filePath: string) {
    this.store = new ProviderStore(filePath);
    this.store.load();
  }

  list(): ProviderConfig[] {
    return this.store.getAll().map(maskProvider);
  }

  get(id: string): ProviderConfig | undefined {
    const p = this.store.get(id);
    return p ? maskProvider(p) : undefined;
  }

  getRaw(id: string): ProviderConfig | undefined {
    return this.store.get(id);
  }

  private static VALID_TYPES: ProviderType[] = [
    'anthropic',
    'bedrock',
    'vertex',
    ...DUAL_SURFACE_PROVIDER_TYPES,
    'openai',
    'ollama',
    'custom',
  ];

  create(input: ProviderCreateInput): ProviderConfig {
    if (!input.name?.trim()) throw new Error('Provider name is required');
    if (!input.type) throw new Error('Provider type is required');
    if (!ProviderService.VALID_TYPES.includes(input.type as ProviderType)) {
      throw new Error(`Invalid provider type: ${input.type}. Must be one of: ${ProviderService.VALID_TYPES.join(', ')}`);
    }
    if (!input.models?.primary || !input.models?.light) {
      throw new Error('models.primary and models.light are required');
    }
    this.assertRuntimeSupported(input.type, input.connection.agentRuntime);

    const now = new Date().toISOString();
    const provider: ProviderConfig = {
      id: uuidv4(),
      name: input.name.trim(),
      category: input.category,
      type: input.type,
      isActive: false,
      createdAt: now,
      updatedAt: now,
      models: input.models,
      connection: input.connection,
      ...(input.tuning ? { tuning: input.tuning } : {}),
      ...(input.custom ? { custom: input.custom } : {}),
    };

    this.store.set(provider);
    return provider;
  }

  update(id: string, input: ProviderUpdateInput): ProviderConfig {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Provider not found: ${id}`);

    const updated: ProviderConfig = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updated.name = input.name.trim();
    if (input.models) updated.models = { ...existing.models, ...input.models };
    if (input.connection) {
      const merged = { ...existing.connection };
      for (const [key, val] of Object.entries(input.connection)) {
        if (val !== undefined && !String(val).startsWith('****')) {
          (merged as any)[key] = val;
        }
      }
      if (input.connection.agentRuntime !== undefined) {
        this.assertRuntimeSupported(existing.type, merged.agentRuntime);
      }
      updated.connection = merged;
    }
    if (input.tuning !== undefined) updated.tuning = input.tuning ?? undefined;
    if (input.custom !== undefined) updated.custom = input.custom ?? undefined;

    this.store.set(updated);
    return updated;
  }

  delete(id: string): void {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Provider not found: ${id}`);
    if (existing.isActive) throw new Error('Cannot delete the active provider. Deactivate or switch first.');
    this.store.delete(id);
  }

  activate(id: string): void {
    const target = this.store.get(id);
    if (!target) throw new Error(`Provider not found: ${id}`);

    const current = this.store.getActive();
    if (current && current.id !== id) {
      this.store.set({ ...current, isActive: false, updatedAt: new Date().toISOString() });
    }

    this.store.set({ ...target, isActive: true, updatedAt: new Date().toISOString() });
  }

  deactivateAll(): void {
    const current = this.store.getActive();
    if (current) {
      this.store.set({ ...current, isActive: false, updatedAt: new Date().toISOString() });
    }
  }

  switchAgentRuntime(id: string, runtime: AgentRuntimeKind): ProviderConfig {
    if (runtime !== 'claude-agent-sdk' && runtime !== 'openai-agents-sdk') {
      throw new Error(`Invalid agent runtime: ${runtime}`);
    }
    return this.update(id, { connection: { agentRuntime: runtime } });
  }

  getEffectiveEnv(): Record<string, string> | null {
    const active = this.store.getActive();
    if (!active) return null;
    return this.toEnvVars(active);
  }

  getEnvForProvider(id: string): Record<string, string> | null {
    const provider = this.store.get(id);
    if (!provider) return null;
    return this.toEnvVars(provider);
  }

  getRawEffectiveProvider(): ProviderConfig | undefined {
    return this.store.getActive();
  }

  getRawProvider(id: string): ProviderConfig | undefined {
    return this.store.get(id);
  }

  resolveAgentRuntime(provider?: ProviderConfig | null): AgentRuntimeKind {
    if (provider?.connection.agentRuntime) {
      if (
        provider.connection.agentRuntime !== 'claude-agent-sdk' &&
        provider.connection.agentRuntime !== 'openai-agents-sdk'
      ) {
        throw new Error(`Invalid agent runtime: ${provider.connection.agentRuntime}`);
      }
    }
    if (
      provider?.connection.agentRuntime === 'claude-agent-sdk' ||
      provider?.connection.agentRuntime === 'openai-agents-sdk'
    ) {
      this.assertRuntimeSupported(provider.type, provider.connection.agentRuntime);
      return provider.connection.agentRuntime;
    }
    switch (provider?.type as ProviderType | undefined) {
      case 'openai':
      case 'ollama':
        return 'openai-agents-sdk';
      case 'custom':
        if (provider?.connection.openaiProtocol || provider?.connection.openaiBaseUrl || provider?.connection.openaiApiKey) {
          const hasClaudeSurface = Boolean(
            provider.connection.claudeBaseUrl ||
            provider.connection.claudeApiKey ||
            provider.connection.claudeAuthToken,
          );
          return hasClaudeSurface ? 'claude-agent-sdk' : 'openai-agents-sdk';
        }
        return 'claude-agent-sdk';
      case 'anthropic':
      case 'bedrock':
      case 'vertex':
      default:
        return 'claude-agent-sdk';
    }
  }

  supportsAgentRuntime(provider: Pick<ProviderConfig, 'type'>, runtime: AgentRuntimeKind): boolean {
    return isSupportedRuntimeForProvider(provider.type, runtime);
  }

  private assertRuntimeSupported(type: ProviderType, runtime?: unknown): void {
    if (runtime === undefined || runtime === null) return;
    if (runtime !== 'claude-agent-sdk' && runtime !== 'openai-agents-sdk') {
      throw new Error(`Invalid agent runtime: ${String(runtime)}`);
    }
    if (!isSupportedRuntimeForProvider(type, runtime)) {
      throw new Error(`Provider type "${type}" does not support ${runtime}`);
    }
  }

  resolveOpenAIProtocol(provider?: ProviderConfig | null): OpenAIProtocol {
    if (provider?.connection.openaiProtocol) return provider.connection.openaiProtocol;
    if (provider?.type === 'openai') return 'responses';
    return 'chat_completions';
  }

  private getClaudeBaseUrl(provider: ProviderConfig, defaultBaseUrl?: string): string | undefined {
    return provider.connection.claudeBaseUrl || provider.connection.baseUrl || defaultBaseUrl;
  }

  private applyClaudeAuth(env: Record<string, string>, provider: ProviderConfig): void {
    if (provider.connection.claudeApiKey) env.ANTHROPIC_API_KEY = provider.connection.claudeApiKey;
    if (provider.connection.claudeAuthToken) env.ANTHROPIC_AUTH_TOKEN = provider.connection.claudeAuthToken;
    if (!provider.connection.claudeApiKey && !provider.connection.claudeAuthToken && provider.connection.apiKey) {
      if (sharedKeyShouldUseClaudeAuthToken(provider.type)) {
        env.ANTHROPIC_AUTH_TOKEN = provider.connection.apiKey;
      } else {
        env.ANTHROPIC_API_KEY = provider.connection.apiKey;
      }
    }
  }

  private getOpenAIBaseUrl(provider: ProviderConfig, defaultBaseUrl?: string): string | undefined {
    return provider.connection.openaiBaseUrl || provider.connection.baseUrl || defaultBaseUrl;
  }

  private getOpenAIApiKey(provider: ProviderConfig): string | undefined {
    return provider.connection.openaiApiKey || provider.connection.apiKey;
  }

  private applyOpenAIConnection(
    env: Record<string, string>,
    provider: ProviderConfig,
    defaultBaseUrl?: string,
  ): void {
    const baseUrl = this.getOpenAIBaseUrl(provider, defaultBaseUrl);
    const apiKey = this.getOpenAIApiKey(provider);
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    env.OPENAI_AGENTS_PROTOCOL = this.resolveOpenAIProtocol(provider);
  }

  private toEnvVars(provider: ProviderConfig): Record<string, string> {
    const env: Record<string, string> = {};
    const runtime = this.resolveAgentRuntime(provider);

    switch (provider.type as ProviderType) {
      case 'anthropic':
        this.applyClaudeAuth(env, provider);
        {
          const baseUrl = this.getClaudeBaseUrl(provider);
          if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
        }
        break;

      case 'bedrock':
        if (provider.connection.useBedrock !== false) {
          env.CLAUDE_CODE_USE_BEDROCK = '1';
        }
        if (provider.connection.awsRegion) env.AWS_REGION = provider.connection.awsRegion;
        if (provider.connection.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = provider.connection.baseUrl;
        this.applyClaudeAuth(env, provider);
        if (provider.connection.awsBearerToken) env.AWS_BEARER_TOKEN_BEDROCK = provider.connection.awsBearerToken;
        if (provider.connection.awsAccessKeyId) env.AWS_ACCESS_KEY_ID = provider.connection.awsAccessKeyId;
        if (provider.connection.awsSecretAccessKey) env.AWS_SECRET_ACCESS_KEY = provider.connection.awsSecretAccessKey;
        if (provider.connection.awsSessionToken) env.AWS_SESSION_TOKEN = provider.connection.awsSessionToken;
        if (provider.connection.awsProfile) env.AWS_PROFILE = provider.connection.awsProfile;
        break;

      case 'vertex':
        env.CLAUDE_CODE_USE_VERTEX = '1';
        if (provider.connection.gcpProjectId) env.ANTHROPIC_VERTEX_PROJECT_ID = provider.connection.gcpProjectId;
        if (provider.connection.gcpRegion) env.CLOUD_ML_REGION = provider.connection.gcpRegion;
        break;

      case 'deepseek':
      case 'glm':
      case 'qwen':
      case 'qwen_coding':
      case 'kimi_code':
      case 'kimi':
      case 'doubao':
      case 'minimax':
      case 'xiaomi':
      case 'tencent_token_plan':
      case 'tencent_coding_plan':
      case 'hunyuan':
      case 'qianfan':
      case 'stepfun':
      case 'siliconflow':
      case 'huawei':
        if (!isDualSurfaceProviderType(provider.type)) {
          break;
        }
        if (runtime === 'openai-agents-sdk') {
          env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
          this.applyOpenAIConnection(env, provider);
        } else {
          const baseUrl = this.getClaudeBaseUrl(provider);
          if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
          this.applyClaudeAuth(env, provider);
        }
        break;

      case 'openai':
        env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
        this.applyOpenAIConnection(env, provider, 'https://api.openai.com/v1');
        break;

      case 'ollama':
        env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
        this.applyOpenAIConnection(env, provider, 'http://localhost:11434/v1');
        env.OPENAI_API_KEY ??= 'ollama';
        break;

      case 'custom':
        env.SMARTPERFETTO_AGENT_RUNTIME = runtime;
        if (runtime === 'openai-agents-sdk') {
          this.applyOpenAIConnection(env, provider);
        } else {
          this.applyClaudeAuth(env, provider);
          const baseUrl = this.getClaudeBaseUrl(provider);
          if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
        }
        if (provider.custom?.envOverrides) Object.assign(env, provider.custom.envOverrides);
        break;
    }

    env.SMARTPERFETTO_AGENT_RUNTIME = runtime;
    if (runtime === 'openai-agents-sdk') {
      env.OPENAI_MODEL = provider.models.primary;
      env.OPENAI_LIGHT_MODEL = provider.models.light;
      if (provider.models.subAgent) env.OPENAI_SUB_AGENT_MODEL = provider.models.subAgent;
    } else {
      env.CLAUDE_MODEL = provider.models.primary;
      env.CLAUDE_LIGHT_MODEL = provider.models.light;
      if (provider.models.subAgent) env.CLAUDE_SUB_AGENT_MODEL = provider.models.subAgent;
    }

    const tuningPrefix = runtime === 'openai-agents-sdk' ? 'OPENAI' : 'CLAUDE';
    if (provider.tuning?.maxTurns) env[`${tuningPrefix}_MAX_TURNS`] = String(provider.tuning.maxTurns);
    if (provider.tuning?.effort) env[`${tuningPrefix}_EFFORT`] = provider.tuning.effort;
    if (provider.tuning?.maxBudgetUsd) env[`${tuningPrefix}_MAX_BUDGET_USD`] = String(provider.tuning.maxBudgetUsd);
    if (provider.tuning?.fullPerTurnMs) env[`${tuningPrefix}_FULL_PER_TURN_MS`] = String(provider.tuning.fullPerTurnMs);
    if (provider.tuning?.quickPerTurnMs) env[`${tuningPrefix}_QUICK_PER_TURN_MS`] = String(provider.tuning.quickPerTurnMs);
    if (provider.tuning?.verifierTimeoutMs) env[`${tuningPrefix}_VERIFIER_TIMEOUT_MS`] = String(provider.tuning.verifierTimeoutMs);
    if (provider.tuning?.classifierTimeoutMs) env[`${tuningPrefix}_CLASSIFIER_TIMEOUT_MS`] = String(provider.tuning.classifierTimeoutMs);
    if (provider.tuning?.enableSubAgents !== undefined) env[`${tuningPrefix}_ENABLE_SUB_AGENTS`] = String(provider.tuning.enableSubAgents);
    if (provider.tuning?.enableVerification !== undefined) env[`${tuningPrefix}_ENABLE_VERIFICATION`] = String(provider.tuning.enableVerification);

    return env;
  }
}
