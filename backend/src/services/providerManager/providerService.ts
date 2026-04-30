// backend/src/services/providerManager/providerService.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { v4 as uuidv4 } from 'uuid';
import { ProviderStore } from './providerStore';
import type {
  ProviderConfig,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderType,
} from './types';

const SENSITIVE_FIELDS: (keyof ProviderConfig['connection'])[] = [
  'apiKey', 'awsBearerToken', 'awsAccessKeyId', 'awsSecretAccessKey', 'awsSessionToken',
];

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

  private static VALID_TYPES: ProviderType[] = ['anthropic', 'bedrock', 'vertex', 'deepseek', 'openai', 'ollama', 'custom'];

  create(input: ProviderCreateInput): ProviderConfig {
    if (!input.name?.trim()) throw new Error('Provider name is required');
    if (!input.type) throw new Error('Provider type is required');
    if (!ProviderService.VALID_TYPES.includes(input.type as ProviderType)) {
      throw new Error(`Invalid provider type: ${input.type}. Must be one of: ${ProviderService.VALID_TYPES.join(', ')}`);
    }
    if (!input.models?.primary || !input.models?.light) {
      throw new Error('models.primary and models.light are required');
    }

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

  private toEnvVars(provider: ProviderConfig): Record<string, string> {
    const env: Record<string, string> = {};

    switch (provider.type as ProviderType) {
      case 'anthropic':
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
        break;

      case 'bedrock':
        if (provider.connection.useBedrock !== false) {
          env.CLAUDE_CODE_USE_BEDROCK = '1';
        }
        if (provider.connection.awsRegion) env.AWS_REGION = provider.connection.awsRegion;
        if (provider.connection.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = provider.connection.baseUrl;
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
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
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.deepseek.com';
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        break;

      case 'openai':
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'https://api.openai.com/v1';
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        break;

      case 'ollama':
        env.ANTHROPIC_BASE_URL = provider.connection.baseUrl || 'http://localhost:11434/v1';
        env.ANTHROPIC_API_KEY = 'ollama';
        break;

      case 'custom':
        if (provider.connection.apiKey) env.ANTHROPIC_API_KEY = provider.connection.apiKey;
        if (provider.connection.baseUrl) env.ANTHROPIC_BASE_URL = provider.connection.baseUrl;
        if (provider.custom?.envOverrides) Object.assign(env, provider.custom.envOverrides);
        break;
    }

    env.CLAUDE_MODEL = provider.models.primary;
    env.CLAUDE_LIGHT_MODEL = provider.models.light;
    if (provider.models.subAgent) env.CLAUDE_SUB_AGENT_MODEL = provider.models.subAgent;

    if (provider.tuning?.maxTurns) env.CLAUDE_MAX_TURNS = String(provider.tuning.maxTurns);
    if (provider.tuning?.effort) env.CLAUDE_EFFORT = provider.tuning.effort;
    if (provider.tuning?.maxBudgetUsd) env.CLAUDE_MAX_BUDGET_USD = String(provider.tuning.maxBudgetUsd);
    if (provider.tuning?.fullPerTurnMs) env.CLAUDE_FULL_PER_TURN_MS = String(provider.tuning.fullPerTurnMs);
    if (provider.tuning?.quickPerTurnMs) env.CLAUDE_QUICK_PER_TURN_MS = String(provider.tuning.quickPerTurnMs);
    if (provider.tuning?.verifierTimeoutMs) env.CLAUDE_VERIFIER_TIMEOUT_MS = String(provider.tuning.verifierTimeoutMs);
    if (provider.tuning?.classifierTimeoutMs) env.CLAUDE_CLASSIFIER_TIMEOUT_MS = String(provider.tuning.classifierTimeoutMs);
    if (provider.tuning?.enableSubAgents !== undefined) env.CLAUDE_ENABLE_SUB_AGENTS = String(provider.tuning.enableSubAgents);
    if (provider.tuning?.enableVerification !== undefined) env.CLAUDE_ENABLE_VERIFICATION = String(provider.tuning.enableVerification);

    return env;
  }
}
