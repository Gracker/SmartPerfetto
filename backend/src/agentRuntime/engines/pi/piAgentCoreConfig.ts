// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Credential} from '@earendil-works/pi-ai';

export type PiAgentCoreEnv = Record<string, string | undefined>;

export interface PiAgentCoreModelConfig {
  model: Record<string, unknown>;
  apiKey?: string;
  apiKeyEnv?: string;
  credential?: Credential;
  maxRetryDelayMs?: number;
  transport?: string;
  thinkingLevel?: string;
  thinkingBudgets?: Record<string, number>;
}

export interface PiRuntimeFingerprintInput {
  modelJson?: string;
  entries: Array<[string, string]>;
}

const PI_API_KEY_ENV_BY_PROVIDER: Record<string, readonly string[]> = {
  'amazon-bedrock': [
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_CONFIG_FILE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_EC2_METADATA_DISABLED',
    'AWS_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
  ],
  'ant-ling': ['ANT_LING_API_KEY'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': [
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
  ],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'],
  'kimi-coding': ['KIMI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
};

const PI_STREAM_ENV_BY_API: Record<string, readonly string[]> = {
  'azure-openai-responses': [
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
    'AZURE_OPENAI_RESOURCE_NAME',
  ],
  'bedrock-converse-stream': [
    'AWS_ACCESS_KEY_ID',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_BEDROCK_FORCE_CACHE',
    'AWS_BEDROCK_FORCE_HTTP1',
    'AWS_BEDROCK_SKIP_AUTH',
    'AWS_CONFIG_FILE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_DEFAULT_REGION',
    'AWS_EC2_METADATA_DISABLED',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ],
  'google-vertex': [
    'GCLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_PROJECT',
  ],
};

function normalizeProviderEnvName(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

export function piProviderApiKeyEnvNames(provider: string, explicit?: string): string[] {
  return [...new Set([
    explicit,
    ...(PI_API_KEY_ENV_BY_PROVIDER[provider] ?? [
      `${normalizeProviderEnvName(provider)}_API_KEY`,
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate)))];
}

export function piStreamEnvKeys(api: string): string[] {
  return ['PI_CACHE_RETENTION', ...(PI_STREAM_ENV_BY_API[api] ?? [])];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function thinkingBudgets(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const budgets = Object.fromEntries(
    Object.entries(value)
      .map(([key, nested]) => [key, optionalNumber(nested)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
  return Object.keys(budgets).length > 0 ? budgets : undefined;
}

export function parsePiAgentCoreModelConfig(rawModel: string): PiAgentCoreModelConfig {
  const parsed = JSON.parse(rawModel) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model JSON must be an object');
  }
  const {
    apiKey,
    apiKeyEnv,
    credential,
    maxRetryDelayMs,
    transport,
    thinkingLevel,
    thinkingBudgets: rawThinkingBudgets,
    ...model
  } = parsed as Record<string, unknown>;
  return {
    model,
    apiKey: optionalString(apiKey),
    apiKeyEnv: optionalString(apiKeyEnv),
    credential: credential as Credential | undefined,
    maxRetryDelayMs: optionalNumber(maxRetryDelayMs),
    transport: optionalString(transport),
    thinkingLevel: optionalString(thinkingLevel),
    thinkingBudgets: thinkingBudgets(rawThinkingBudgets),
  };
}

function configuredModelString(model: Record<string, unknown>, field: string): string | undefined {
  return optionalString(model[field]);
}

export function piRuntimeFingerprintInput(
  env: PiAgentCoreEnv,
  customEnvOverrides?: Record<string, string>,
): PiRuntimeFingerprintInput {
  const modelJson = optionalString(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON);
  if (!modelJson) return {entries: []};

  const customKeys = Object.keys(customEnvOverrides ?? {});
  const entries: Array<[string, string]> = [];
  const addSelectedEnv = (keys: Iterable<string>) => {
    for (const key of [...new Set(keys)].sort()) {
      const value = env[key];
      if (value !== undefined && value !== '') entries.push([`env:${key}`, value]);
    }
  };

  let config: PiAgentCoreModelConfig;
  try {
    config = parsePiAgentCoreModelConfig(modelJson);
  } catch {
    addSelectedEnv(customKeys);
    return {modelJson, entries};
  }
  const provider = configuredModelString(config.model, 'provider');
  const api = configuredModelString(config.model, 'api');
  const selectedKeys = new Set<string>([
    ...(provider ? piProviderApiKeyEnvNames(provider, config.apiKeyEnv) : []),
    ...(api ? piStreamEnvKeys(api) : []),
    ...Object.keys(config.credential?.type === 'api_key' ? config.credential.env ?? {} : {}),
    ...customKeys,
  ]);
  if (config.apiKey) entries.push(['config:apiKey', config.apiKey]);
  if (config.credential) entries.push(['config:credential', JSON.stringify(config.credential)]);
  addSelectedEnv(selectedKeys);
  return {modelJson, entries};
}
