// backend/src/services/providerManager/providerService.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { uuidv4 } from '../../utils/uuid';
import logger from '../../utils/logger';
import { ProviderStore } from './providerStore';
import type {
  AgentRuntimeKind,
  OpenAIProtocol,
  ProviderConfig,
  ProviderCreateInput,
  ProviderScope,
  ProviderUpdateInput,
  ProviderType,
} from './types';
import {
  assertAgentRuntimeSupported,
  DUAL_SURFACE_PROVIDER_TYPES,
  isAgentRuntimeKind,
  isDualSurfaceProviderType,
  normalizeBedrockModelId,
  resolveProviderAgentRuntime,
  sharedKeyShouldUseClaudeAuthToken,
  supportsAgentRuntimeType,
} from './providerRuntimeMatrix';

const SENSITIVE_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'openaiApiKey',
  'piAgentCoreModelJson',
  'openCodeModelJson',
  'qoderAccessToken',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];
const ENDPOINT_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'baseUrl',
  'claudeBaseUrl',
  'openaiBaseUrl',
];
const NETWORK_CREDENTIAL_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'openaiApiKey',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

const ALLOWED_CUSTOM_ENV_OVERRIDES = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLOUD_ML_REGION',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_AGENTS_PROTOCOL',
]);

function assertSafeCustomEnvOverrides(custom: ProviderConfig['custom']): void {
  for (const key of Object.keys(custom?.envOverrides ?? {})) {
    if (!ALLOWED_CUSTOM_ENV_OVERRIDES.has(key)) {
      throw new Error(`Custom provider env override is not allowed: ${key}`);
    }
  }
}

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

function isSensitiveCustomKey(key: string): boolean {
  return /(?:api[_-]?key|auth(?:orization)?|bearer|token|secret|password|access[_-]?key|session[_-]?token|credential)/i
    .test(key);
}

function maskSensitiveRecordValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const masked = { ...record };
  for (const [key, value] of Object.entries(masked)) {
    if (value && isSensitiveCustomKey(key)) masked[key] = maskValue(value);
  }
  return masked;
}

function maskCustom(custom: ProviderConfig['custom']): ProviderConfig['custom'] {
  if (!custom) return undefined;
  return {
    ...custom,
    headers: maskSensitiveRecordValues(custom.headers),
    envOverrides: maskSensitiveRecordValues(custom.envOverrides),
  };
}

function maskProvider(p: ProviderConfig): ProviderConfig {
  return {
    ...p,
    connection: maskConnection(p.connection),
    custom: maskCustom(p.custom),
  };
}

function endpointOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return `invalid:${value.trim()}`;
  }
}

function connectionEndpointOriginChanged(
  existing: ProviderConfig['connection'],
  input: Partial<ProviderConfig['connection']>,
): boolean {
  return ENDPOINT_FIELDS.some(field => {
    const next = input[field];
    return next !== undefined
      && !String(next).startsWith('****')
      && endpointOrigin(existing[field]) !== endpointOrigin(next);
  });
}

function assertCredentialsReconfirmedForEndpointChange(
  existing: ProviderConfig['connection'],
  input: Partial<ProviderConfig['connection']>,
): void {
  if (!connectionEndpointOriginChanged(existing, input)) return;
  for (const field of NETWORK_CREDENTIAL_FIELDS) {
    if (!existing[field]) continue;
    const replacement = input[field];
    if (replacement === undefined || String(replacement).startsWith('****')) {
      throw new Error(
        `Provider endpoint origin changed; re-enter or clear credential field '${field}'`,
      );
    }
  }
}

export class ProviderService {
  private store: ProviderStore;

  constructor(filePath: string) {
    this.store = new ProviderStore(filePath);
    this.store.load();
  }

  list(scope?: ProviderScope): ProviderConfig[] {
    return this.store.getAll(scope).map(maskProvider);
  }

  get(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    const p = this.store.get(id, scope);
    return p ? maskProvider(p) : undefined;
  }

  getRaw(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    return this.store.get(id, scope);
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

  create(input: ProviderCreateInput, scope?: ProviderScope): ProviderConfig {
    if (!input.name?.trim()) throw new Error('Provider name is required');
    if (!input.type) throw new Error('Provider type is required');
    if (!ProviderService.VALID_TYPES.includes(input.type as ProviderType)) {
      throw new Error(`Invalid provider type: ${input.type}. Must be one of: ${ProviderService.VALID_TYPES.join(', ')}`);
    }
    if (!input.models?.primary || !input.models?.light) {
      throw new Error('models.primary and models.light are required');
    }
    this.assertRuntimeSupported(input.type, input.connection.agentRuntime);
    assertSafeCustomEnvOverrides(input.custom);

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

    this.store.set(provider, scope);
    return provider;
  }

  update(id: string, input: ProviderUpdateInput, scope?: ProviderScope): ProviderConfig {
    const existing = this.store.get(id, scope);
    if (!existing) throw new Error(`Provider not found: ${id}`);

    const updated: ProviderConfig = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };

    if (input.name !== undefined) updated.name = input.name.trim();
    if (input.models) updated.models = { ...existing.models, ...input.models };
    if (input.connection) {
      assertCredentialsReconfirmedForEndpointChange(existing.connection, input.connection);
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
    if (input.custom !== undefined) {
      assertSafeCustomEnvOverrides(input.custom ?? undefined);
      updated.custom = input.custom ?? undefined;
    }

    this.store.set(updated, scope);
    return updated;
  }

  delete(id: string, scope?: ProviderScope): void {
    const existing = this.store.get(id, scope);
    if (!existing) throw new Error(`Provider not found: ${id}`);
    if (existing.isActive) throw new Error('Cannot delete the active provider. Deactivate or switch first.');
    this.store.delete(id, scope);
  }

  rotateSecret(id: string, scope?: ProviderScope): number {
    const existing = this.store.get(id, scope);
    if (!existing) throw new Error(`Provider not found: ${id}`);
    const version = this.store.rotateSecret(id, scope);
    if (version === undefined) {
      throw new Error('Secret rotation is only available for the enterprise provider store');
    }
    return version;
  }

  activate(id: string, scope?: ProviderScope): void {
    const target = this.store.get(id, scope);
    if (!target) throw new Error(`Provider not found: ${id}`);

    const current = this.store.getActivePeer(id, scope);
    if (current && current.id !== id) {
      this.store.set({ ...current, isActive: false, updatedAt: new Date().toISOString() }, scope);
    }

    this.store.set({ ...target, isActive: true, updatedAt: new Date().toISOString() }, scope);
  }

  deactivateAll(scope?: ProviderScope): void {
    const current = this.store.getActiveWriteScope(scope);
    if (current) {
      this.store.set({ ...current, isActive: false, updatedAt: new Date().toISOString() }, scope);
    }
  }

  switchAgentRuntime(id: string, runtime: AgentRuntimeKind, scope?: ProviderScope): ProviderConfig {
    if (!isAgentRuntimeKind(runtime)) {
      throw new Error(`Invalid agent runtime: ${runtime}`);
    }
    return this.update(id, { connection: { agentRuntime: runtime } }, scope);
  }

  getEffectiveEnv(scope?: ProviderScope): Record<string, string> | null {
    const active = this.store.getActive(scope);
    if (!active) return null;
    return this.toEnvVars(active);
  }

  getEnvForProvider(id: string, scope?: ProviderScope): Record<string, string> | null {
    const provider = this.store.get(id, scope);
    if (!provider) return null;
    return this.toEnvVars(provider);
  }

  getRawEffectiveProvider(scope?: ProviderScope): ProviderConfig | undefined {
    return this.store.getActive(scope);
  }

  getRawProvider(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    return this.store.get(id, scope);
  }

  resolveAgentRuntime(provider?: ProviderConfig | null): AgentRuntimeKind {
    return resolveProviderAgentRuntime(provider);
  }

  supportsAgentRuntime(provider: Pick<ProviderConfig, 'type'>, runtime: AgentRuntimeKind): boolean {
    return supportsAgentRuntimeType(provider.type, runtime);
  }

  private assertRuntimeSupported(type: ProviderType, runtime?: unknown): void {
    assertAgentRuntimeSupported(type, runtime);
  }

  resolveOpenAIProtocol(provider?: ProviderConfig | null): OpenAIProtocol {
    if (provider?.connection.openaiProtocol) return provider.connection.openaiProtocol;
    if (provider?.type === 'openai') return 'responses';
    return 'chat_completions';
  }

  private getClaudeBaseUrl(provider: ProviderConfig, defaultBaseUrl?: string): string | undefined {
    return provider.connection.claudeBaseUrl || provider.connection.baseUrl || defaultBaseUrl;
  }

  /**
   * Normalize a bedrock provider's model ID, warning when a short Anthropic
   * name had to be mapped to a Bedrock cross-region ID. Delegates the actual
   * mapping to normalizeBedrockModelId so the provider env builder and the
   * connection tester agree. See GitHub issue #179.
   */
  private normalizeBedrockModelWithWarn(model: string, providerName: string): string {
    const normalized = normalizeBedrockModelId(model);
    if (normalized !== model) {
      logger.warn(
        'ProviderManager',
        `Bedrock provider "${providerName}": model "${model}" is not a valid Bedrock ID; ` +
          `normalizing to "${normalized}". Set a Bedrock model ID (e.g. us.anthropic.claude-sonnet-5) to silence this.`,
      );
    }
    return normalized;
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

  private applyPiAgentCoreConnection(env: Record<string, string>, provider: ProviderConfig): void {
    if (provider.connection.piAgentCoreModulePath) {
      env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH = provider.connection.piAgentCoreModulePath;
    }
    if (provider.connection.piAgentCoreModelJson) {
      env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON = provider.connection.piAgentCoreModelJson;
    }
    if (provider.connection.piAgentCoreSystemPrompt) {
      env.SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT = provider.connection.piAgentCoreSystemPrompt;
    }
  }

  private applyOpenCodeConnection(env: Record<string, string>, provider: ProviderConfig): void {
    this.applyOpenAIConnection(env, provider);
    if (provider.connection.openCodeSdkModulePath) {
      env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH = provider.connection.openCodeSdkModulePath;
    }
    if (provider.connection.openCodeModelJson) {
      env.SMARTPERFETTO_OPENCODE_MODEL_JSON = provider.connection.openCodeModelJson;
    }
    if (provider.connection.openCodeSystemPrompt) {
      env.SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT = provider.connection.openCodeSystemPrompt;
    }
  }

  private applyQoderConnection(env: Record<string, string>, provider: ProviderConfig): void {
    if (provider.connection.qoderAccessToken) {
      env.QODER_PERSONAL_ACCESS_TOKEN = provider.connection.qoderAccessToken;
    }
    if (provider.connection.qoderCliPath) {
      env.QODERCLI_PATH = provider.connection.qoderCliPath;
    }
    if (provider.connection.qoderSystemPrompt) {
      env.SMARTPERFETTO_QODER_SYSTEM_PROMPT = provider.connection.qoderSystemPrompt;
    }
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
        } else if (runtime === 'pi-agent-core') {
          this.applyPiAgentCoreConnection(env, provider);
        } else if (runtime === 'opencode') {
          this.applyOpenCodeConnection(env, provider);
        } else if (runtime === 'qoder-agent-sdk') {
          this.applyQoderConnection(env, provider);
        } else {
          this.applyClaudeAuth(env, provider);
          const baseUrl = this.getClaudeBaseUrl(provider);
          if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
        }
        if (provider.custom?.envOverrides) Object.assign(env, provider.custom.envOverrides);
        break;
    }

    env.SMARTPERFETTO_AGENT_RUNTIME = runtime;
    if (runtime === 'pi-agent-core') {
      // Pi agent-core uses its own model JSON; keep Claude/OpenAI model env
      // variables unset so downstream diagnostics cannot misclassify it.
    } else if (runtime === 'opencode') {
      if (!provider.connection.openCodeModelJson) {
        env.OPENAI_MODEL = provider.models.primary;
        env.OPENAI_LIGHT_MODEL = provider.models.light;
      }
    } else if (runtime === 'qoder-agent-sdk') {
      env.QODER_MODEL = provider.connection.qoderModel || provider.models.primary;
    } else if (runtime === 'openai-agents-sdk') {
      env.OPENAI_MODEL = provider.models.primary;
      env.OPENAI_LIGHT_MODEL = provider.models.light;
    } else {
      // Bedrock requires cross-region inference model IDs; normalize short
      // Anthropic names so an existing bedrock provider configured with a
      // short name (e.g. via API or before the template fix) still works.
      // See normalizeBedrockModelId for the full rationale.
      const isBedrock = provider.type === 'bedrock';
      const primary = isBedrock
        ? this.normalizeBedrockModelWithWarn(provider.models.primary, provider.name)
        : provider.models.primary;
      const light = isBedrock
        ? this.normalizeBedrockModelWithWarn(provider.models.light, provider.name)
        : provider.models.light;
      env.CLAUDE_MODEL = primary;
      env.CLAUDE_LIGHT_MODEL = light;
      if (provider.models.subAgent) env.CLAUDE_SUB_AGENT_MODEL = provider.models.subAgent;
    }

    if (runtime === 'pi-agent-core') {
      // Runtime-specific Pi tuning is intentionally not mapped to Claude/OpenAI
      // knobs. Add explicit Pi knobs here only after the adapter supports them.
    } else if (runtime === 'opencode') {
      // OpenCode tuning is runtime-specific and intentionally not mapped to
      // Claude/OpenAI loop knobs.
    } else if (runtime === 'qoder-agent-sdk') {
      if (provider.tuning?.maxTurns) env.QODER_MAX_TURNS = String(provider.tuning.maxTurns);
      if (provider.tuning?.fullPerTurnMs) env.QODER_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
      if (provider.tuning?.quickPerTurnMs) env.QODER_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
    } else if (runtime === 'openai-agents-sdk') {
      if (provider.tuning?.maxTurns) env.OPENAI_MAX_TURNS = String(provider.tuning.maxTurns);
      if (provider.tuning?.fullPerTurnMs) env.OPENAI_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
      if (provider.tuning?.quickPerTurnMs) env.OPENAI_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
      if (provider.tuning?.classifierTimeoutMs) env.OPENAI_CLASSIFIER_TIMEOUT_MS = String(provider.tuning.classifierTimeoutMs);
    } else {
      if (provider.tuning?.maxTurns) env.CLAUDE_MAX_TURNS = String(provider.tuning.maxTurns);
      if (provider.tuning?.effort) env.CLAUDE_EFFORT = provider.tuning.effort;
      if (provider.tuning?.maxBudgetUsd) env.CLAUDE_MAX_BUDGET_USD = String(provider.tuning.maxBudgetUsd);
      if (provider.tuning?.fullPerTurnMs) env.CLAUDE_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
      if (provider.tuning?.quickPerTurnMs) env.CLAUDE_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
      if (provider.tuning?.verifierTimeoutMs) env.CLAUDE_VERIFIER_TIMEOUT_MS = String(provider.tuning.verifierTimeoutMs);
      if (provider.tuning?.classifierTimeoutMs) env.CLAUDE_CLASSIFIER_TIMEOUT_MS = String(provider.tuning.classifierTimeoutMs);
      if (provider.tuning?.enableSubAgents !== undefined) env.CLAUDE_ENABLE_SUB_AGENTS = String(provider.tuning.enableSubAgents);
      if (provider.tuning?.enableVerification !== undefined) env.CLAUDE_ENABLE_VERIFICATION = String(provider.tuning.enableVerification);
    }

    return env;
  }
}
