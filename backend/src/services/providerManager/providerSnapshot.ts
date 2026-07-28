// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import { mergeIsolatedProviderEnv } from './envIsolation';
import type { ProviderService } from './providerService';
import type { AgentRuntimeKind, ProviderConfig, ProviderScope, ProviderTuning } from './types';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProviderRuntimeSnapshot {
  version: 1;
  providerId: string | null;
  providerType: ProviderConfig['type'] | 'env';
  runtimeKind: AgentRuntimeKind;
  resolvedModels: {
    primary?: string;
    light?: string;
    subAgent?: string;
  };
  resolvedTimeouts: {
    fullPerTurnMs?: number;
    quickPerTurnMs?: number;
    verifierTimeoutMs?: number;
    classifierTimeoutMs?: number;
  };
  baseUrl?: string;
  openaiProtocol?: string;
  environment: Record<string, string>;
  secretVersion: string;
}

export interface ProviderRuntimeSnapshotResolution {
  snapshot: ProviderRuntimeSnapshot;
  snapshotHash: string;
}

const CLAUDE_SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

const OPENAI_SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'apiKey',
  'openaiApiKey',
];

const PI_AGENT_CORE_SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'piAgentCoreModelJson',
];

const OPENCODE_SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'apiKey',
  'openaiApiKey',
  'openCodeModelJson',
];

const QODER_SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'qoderAccessToken',
  'qoderSystemPrompt',
];

const CLAUDE_SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

const OPENAI_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
];

const PI_AGENT_CORE_SECRET_ENV_KEYS = [
  'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON',
  'SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT',
];

const OPENCODE_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
  'SMARTPERFETTO_OPENCODE_MODEL_JSON',
  'SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT',
  'SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON',
];

const QODER_SECRET_ENV_KEYS = [
  'QODER_PERSONAL_ACCESS_TOKEN',
  'SMARTPERFETTO_QODER_SYSTEM_PROMPT',
];

const CLAUDE_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'CLAUDE_MODEL',
  'CLAUDE_LIGHT_MODEL',
  'CLAUDE_SUB_AGENT_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'CLAUDE_MAX_TURNS',
  'CLAUDE_EFFORT',
  'CLAUDE_MAX_BUDGET_USD',
  'CLAUDE_FULL_PER_TURN_MS',
  'CLAUDE_QUICK_PER_TURN_MS',
  'CLAUDE_VERIFIER_TIMEOUT_MS',
  'CLAUDE_CLASSIFIER_TIMEOUT_MS',
  'CLAUDE_ENABLE_SUB_AGENTS',
  'CLAUDE_ENABLE_VERIFICATION',
];

const OPENAI_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'OPENAI_MODEL',
  'OPENAI_LIGHT_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_AGENTS_PROTOCOL',
  'OPENAI_MAX_TURNS',
  'OPENAI_FULL_PER_TURN_MS',
  'OPENAI_QUICK_PER_TURN_MS',
  'OPENAI_CLASSIFIER_TIMEOUT_MS',
];

const PI_AGENT_CORE_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH',
  'SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM',
];

const OPENCODE_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'OPENAI_MODEL',
  'OPENAI_LIGHT_MODEL',
  'OPENAI_BASE_URL',
  'SMARTPERFETTO_OPENCODE_MODEL',
  'SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH',
  'SMARTPERFETTO_OPENCODE_PROJECT_DIR',
  'SMARTPERFETTO_OPENCODE_SERVER_PORT',
  'SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS',
  'SMARTPERFETTO_OPENCODE_PROMPT_TIMEOUT_MS',
  'SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP',
  'SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS',
  'SMARTPERFETTO_OPENCODE_REAL_ANALYSIS',
];

const QODER_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'QODERCLI_PATH',
  'QODER_MODEL',
  'QODER_LIGHT_MODEL',
  'QODER_MAX_TURNS',
  'QODER_QUICK_MAX_TURNS',
  'QODER_FULL_PER_TURN_MS',
  'QODER_QUICK_PER_TURN_MS',
  'QODER_WORKER_RUNTIME_PATH',
];

type ResolvedTimeoutKey = keyof ProviderRuntimeSnapshot['resolvedTimeouts'];

const TIMEOUT_KEYS: ResolvedTimeoutKey[] = [
  'fullPerTurnMs',
  'quickPerTurnMs',
  'verifierTimeoutMs',
  'classifierTimeoutMs',
];

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeForJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeForJson(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeForJson((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

function hashSecretEntries(entries: Array<[string, string | undefined]>): string {
  const present = entries.filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (present.length === 0) return 'none';
  return `sha256:${sha256Hex(canonicalJson(present))}`;
}

function pickEnv(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') picked[key] = value;
  }
  return picked;
}

function parseRuntimeEnv(value: string | undefined): AgentRuntimeKind | undefined {
  switch (value) {
    case 'claude-agent-sdk':
    case 'openai-agents-sdk':
    case 'pi-agent-core':
    case 'opencode':
    case 'qoder-agent-sdk':
      return value;
    default:
      return undefined;
  }
}

function runtimeEnvironmentKeys(runtimeKind: AgentRuntimeKind): string[] {
  switch (runtimeKind) {
    case 'openai-agents-sdk':
      return OPENAI_RUNTIME_ENV_KEYS;
    case 'pi-agent-core':
      return PI_AGENT_CORE_RUNTIME_ENV_KEYS;
    case 'opencode':
      return OPENCODE_RUNTIME_ENV_KEYS;
    case 'qoder-agent-sdk':
      return QODER_RUNTIME_ENV_KEYS;
    case 'claude-agent-sdk':
    default:
      return CLAUDE_RUNTIME_ENV_KEYS;
  }
}

function runtimeSecretEnvKeys(runtimeKind: AgentRuntimeKind): string[] {
  switch (runtimeKind) {
    case 'openai-agents-sdk':
      return OPENAI_SECRET_ENV_KEYS;
    case 'pi-agent-core':
      return PI_AGENT_CORE_SECRET_ENV_KEYS;
    case 'opencode':
      return OPENCODE_SECRET_ENV_KEYS;
    case 'qoder-agent-sdk':
      return QODER_SECRET_ENV_KEYS;
    case 'claude-agent-sdk':
    default:
      return CLAUDE_SECRET_ENV_KEYS;
  }
}

function runtimeSensitiveConnectionFields(
  runtimeKind: AgentRuntimeKind,
): Array<keyof ProviderConfig['connection']> {
  switch (runtimeKind) {
    case 'openai-agents-sdk':
      return OPENAI_SENSITIVE_CONNECTION_FIELDS;
    case 'pi-agent-core':
      return PI_AGENT_CORE_SENSITIVE_CONNECTION_FIELDS;
    case 'opencode':
      return OPENCODE_SENSITIVE_CONNECTION_FIELDS;
    case 'qoder-agent-sdk':
      return QODER_SENSITIVE_CONNECTION_FIELDS;
    case 'claude-agent-sdk':
    default:
      return CLAUDE_SENSITIVE_CONNECTION_FIELDS;
  }
}

function pickResolvedTimeouts(
  tuning: ProviderTuning | undefined,
  runtimeKind: AgentRuntimeKind,
): ProviderRuntimeSnapshot['resolvedTimeouts'] {
  const resolved: ProviderRuntimeSnapshot['resolvedTimeouts'] = {};
  const keys = runtimeKind === 'qoder-agent-sdk'
    ? TIMEOUT_KEYS.filter((key) => key === 'fullPerTurnMs' || key === 'quickPerTurnMs')
    : runtimeKind === 'openai-agents-sdk'
      ? TIMEOUT_KEYS.filter((key) => key !== 'verifierTimeoutMs')
      : TIMEOUT_KEYS;
  for (const key of keys) {
    const value = tuning?.[key];
    if (typeof value === 'number') resolved[key] = value;
  }
  return resolved;
}

function inferBaseUrl(runtimeKind: AgentRuntimeKind, env: Record<string, string>): string | undefined {
  if (runtimeKind === 'openai-agents-sdk' || runtimeKind === 'opencode') {
    return env.OPENAI_BASE_URL;
  }
  if (runtimeKind === 'pi-agent-core') return undefined;
  return env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BEDROCK_BASE_URL;
}

function envRuntimeSnapshot(runtimeOverride?: AgentRuntimeKind): ProviderRuntimeSnapshot {
  const runtimeKind = runtimeOverride
    ?? parseRuntimeEnv(process.env.SMARTPERFETTO_AGENT_RUNTIME)
    ?? 'claude-agent-sdk';
  const env = process.env;
  const timeoutPrefix = runtimeKind === 'qoder-agent-sdk'
    ? 'QODER'
    : runtimeKind === 'openai-agents-sdk' || runtimeKind === 'opencode'
      ? 'OPENAI'
      : 'CLAUDE';
  const resolvedTimeouts: ProviderRuntimeSnapshot['resolvedTimeouts'] = {};
  const timeoutMap: Array<[keyof ProviderRuntimeSnapshot['resolvedTimeouts'], string]> = [
    ['fullPerTurnMs', `${timeoutPrefix}_FULL_PER_TURN_MS`],
    ['quickPerTurnMs', `${timeoutPrefix}_QUICK_PER_TURN_MS`],
  ];
  if (runtimeKind !== 'qoder-agent-sdk') {
    timeoutMap.push([
      'classifierTimeoutMs',
      `${timeoutPrefix}_CLASSIFIER_TIMEOUT_MS`,
    ]);
  }
  if (runtimeKind === 'claude-agent-sdk') {
    timeoutMap.push(['verifierTimeoutMs', 'CLAUDE_VERIFIER_TIMEOUT_MS']);
  }
  for (const [key, envKey] of timeoutMap) {
    const value = env[envKey];
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    if (Number.isFinite(parsed)) resolvedTimeouts[key] = parsed;
  }

  const modelPrefix = runtimeKind === 'qoder-agent-sdk'
    ? 'QODER'
    : runtimeKind === 'openai-agents-sdk' || runtimeKind === 'opencode'
      ? 'OPENAI'
      : runtimeKind === 'claude-agent-sdk'
        ? 'CLAUDE'
        : undefined;
  const nonSecretEnv = pickEnv(env, runtimeEnvironmentKeys(runtimeKind));
  return {
    version: 1,
    providerId: null,
    providerType: 'env',
    runtimeKind,
    resolvedModels: {
      primary: modelPrefix ? env[`${modelPrefix}_MODEL`] : undefined,
      light: modelPrefix ? env[`${modelPrefix}_LIGHT_MODEL`] : undefined,
      subAgent: runtimeKind === 'claude-agent-sdk'
        ? env.CLAUDE_SUB_AGENT_MODEL
        : undefined,
    },
    resolvedTimeouts,
    baseUrl: inferBaseUrl(runtimeKind, nonSecretEnv),
    openaiProtocol: runtimeKind === 'openai-agents-sdk' ? env.OPENAI_AGENTS_PROTOCOL : undefined,
    environment: nonSecretEnv,
    secretVersion: hashSecretEntries(runtimeSecretEnvKeys(runtimeKind).map((key) => [key, env[key]])),
  };
}

function providerSecretVersion(
  provider: ProviderConfig,
  runtimeKind: AgentRuntimeKind,
  env: Record<string, string | undefined>,
): string {
  return hashSecretEntries(
    [
      ...runtimeSensitiveConnectionFields(runtimeKind)
        .map((field) => [field, provider.connection[field] as string | undefined] as [string, string | undefined]),
      ...runtimeSecretEnvKeys(runtimeKind)
        .map((key) => [`env:${key}`, env[key]] as [string, string | undefined]),
    ],
  );
}

function providerRuntimeSnapshot(
  providerService: ProviderService,
  provider: ProviderConfig,
  providerScope?: ProviderScope,
): ProviderRuntimeSnapshot {
  const runtimeKind = providerService.resolveAgentRuntime(provider);
  const providerEnv = providerService.getEnvForProvider(provider.id, providerScope) ?? null;
  const env = mergeIsolatedProviderEnv(process.env, providerEnv);
  const nonSecretEnv = pickEnv(env, runtimeEnvironmentKeys(runtimeKind));
  const primaryModel = runtimeKind === 'qoder-agent-sdk'
    ? nonSecretEnv.QODER_MODEL
    : provider.models.primary;
  const lightModel = runtimeKind === 'qoder-agent-sdk'
    ? nonSecretEnv.QODER_LIGHT_MODEL
    : provider.models.light;
  return {
    version: 1,
    providerId: provider.id,
    providerType: provider.type,
    runtimeKind,
    resolvedModels: {
      primary: primaryModel,
      light: lightModel,
      subAgent: runtimeKind === 'claude-agent-sdk' ? provider.models.subAgent : undefined,
    },
    resolvedTimeouts: pickResolvedTimeouts(provider.tuning, runtimeKind),
    baseUrl: inferBaseUrl(runtimeKind, nonSecretEnv),
    openaiProtocol: runtimeKind === 'openai-agents-sdk'
      ? providerService.resolveOpenAIProtocol(provider)
      : undefined,
    environment: nonSecretEnv,
    secretVersion: providerSecretVersion(provider, runtimeKind, env),
  };
}

export function hashProviderRuntimeSnapshot(snapshot: ProviderRuntimeSnapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

export function resolveProviderRuntimeSnapshot(
  providerService: ProviderService,
  providerId: string | null,
  runtimeOverride?: AgentRuntimeKind,
  providerScope?: ProviderScope,
): ProviderRuntimeSnapshotResolution {
  const snapshot = typeof providerId === 'string'
    ? (() => {
        const provider = providerService.getRawProvider(providerId, providerScope);
        if (!provider) throw new Error(`Provider not found: ${providerId}`);
        return providerRuntimeSnapshot(providerService, provider, providerScope);
      })()
    : envRuntimeSnapshot(runtimeOverride);
  return {
    snapshot,
    snapshotHash: hashProviderRuntimeSnapshot(snapshot),
  };
}
