// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { ProviderService } from './providerService';
import type { AgentRuntimeKind, ProviderConfig, ProviderTuning } from './types';

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

const SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConfig['connection']> = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'openaiApiKey',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

const SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

const PROVIDER_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_AGENT_RUNTIME',
  'CLAUDE_MODEL',
  'CLAUDE_LIGHT_MODEL',
  'CLAUDE_SUB_AGENT_MODEL',
  'OPENAI_MODEL',
  'OPENAI_LIGHT_MODEL',
  'OPENAI_SUB_AGENT_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_AGENTS_PROTOCOL',
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
  'OPENAI_MAX_TURNS',
  'OPENAI_EFFORT',
  'OPENAI_MAX_BUDGET_USD',
  'OPENAI_FULL_PER_TURN_MS',
  'OPENAI_QUICK_PER_TURN_MS',
  'OPENAI_VERIFIER_TIMEOUT_MS',
  'OPENAI_CLASSIFIER_TIMEOUT_MS',
  'OPENAI_ENABLE_SUB_AGENTS',
  'OPENAI_ENABLE_VERIFICATION',
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
      return value;
    default:
      return undefined;
  }
}

function pickResolvedTimeouts(tuning?: ProviderTuning): ProviderRuntimeSnapshot['resolvedTimeouts'] {
  const resolved: ProviderRuntimeSnapshot['resolvedTimeouts'] = {};
  for (const key of TIMEOUT_KEYS) {
    const value = tuning?.[key];
    if (typeof value === 'number') resolved[key] = value;
  }
  return resolved;
}

function inferBaseUrl(runtimeKind: AgentRuntimeKind, env: Record<string, string>): string | undefined {
  if (runtimeKind === 'openai-agents-sdk') {
    return env.OPENAI_BASE_URL;
  }
  return env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BEDROCK_BASE_URL;
}

function envRuntimeSnapshot(runtimeOverride?: AgentRuntimeKind): ProviderRuntimeSnapshot {
  const runtimeKind = runtimeOverride
    ?? parseRuntimeEnv(process.env.SMARTPERFETTO_AGENT_RUNTIME)
    ?? 'claude-agent-sdk';
  const env = pickEnv(process.env, [...PROVIDER_RUNTIME_ENV_KEYS, ...SECRET_ENV_KEYS]);
  const timeoutPrefix = runtimeKind === 'openai-agents-sdk' ? 'OPENAI' : 'CLAUDE';
  const resolvedTimeouts: ProviderRuntimeSnapshot['resolvedTimeouts'] = {};
  const timeoutMap: Array<[keyof ProviderRuntimeSnapshot['resolvedTimeouts'], string]> = [
    ['fullPerTurnMs', `${timeoutPrefix}_FULL_PER_TURN_MS`],
    ['quickPerTurnMs', `${timeoutPrefix}_QUICK_PER_TURN_MS`],
    ['verifierTimeoutMs', `${timeoutPrefix}_VERIFIER_TIMEOUT_MS`],
    ['classifierTimeoutMs', `${timeoutPrefix}_CLASSIFIER_TIMEOUT_MS`],
  ];
  for (const [key, envKey] of timeoutMap) {
    const value = env[envKey];
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    if (Number.isFinite(parsed)) resolvedTimeouts[key] = parsed;
  }

  const modelPrefix = runtimeKind === 'openai-agents-sdk' ? 'OPENAI' : 'CLAUDE';
  const nonSecretEnv = pickEnv(process.env, PROVIDER_RUNTIME_ENV_KEYS);
  return {
    version: 1,
    providerId: null,
    providerType: 'env',
    runtimeKind,
    resolvedModels: {
      primary: env[`${modelPrefix}_MODEL`],
      light: env[`${modelPrefix}_LIGHT_MODEL`],
      subAgent: env[`${modelPrefix}_SUB_AGENT_MODEL`],
    },
    resolvedTimeouts,
    baseUrl: inferBaseUrl(runtimeKind, nonSecretEnv),
    openaiProtocol: runtimeKind === 'openai-agents-sdk' ? env.OPENAI_AGENTS_PROTOCOL : undefined,
    environment: nonSecretEnv,
    secretVersion: hashSecretEntries(SECRET_ENV_KEYS.map((key) => [key, process.env[key]])),
  };
}

function providerSecretVersion(provider: ProviderConfig): string {
  return hashSecretEntries(
    SENSITIVE_CONNECTION_FIELDS.map((field) => [field, provider.connection[field] as string | undefined]),
  );
}

function providerRuntimeSnapshot(
  providerService: ProviderService,
  provider: ProviderConfig,
): ProviderRuntimeSnapshot {
  const runtimeKind = providerService.resolveAgentRuntime(provider);
  const env = providerService.getEnvForProvider(provider.id) ?? {};
  const nonSecretEnv = pickEnv(env, PROVIDER_RUNTIME_ENV_KEYS);
  return {
    version: 1,
    providerId: provider.id,
    providerType: provider.type,
    runtimeKind,
    resolvedModels: {
      primary: provider.models.primary,
      light: provider.models.light,
      subAgent: provider.models.subAgent,
    },
    resolvedTimeouts: pickResolvedTimeouts(provider.tuning),
    baseUrl: inferBaseUrl(runtimeKind, nonSecretEnv),
    openaiProtocol: runtimeKind === 'openai-agents-sdk'
      ? providerService.resolveOpenAIProtocol(provider)
      : undefined,
    environment: nonSecretEnv,
    secretVersion: providerSecretVersion(provider),
  };
}

export function hashProviderRuntimeSnapshot(snapshot: ProviderRuntimeSnapshot): string {
  return sha256Hex(canonicalJson(snapshot));
}

export function resolveProviderRuntimeSnapshot(
  providerService: ProviderService,
  providerId: string | null,
  runtimeOverride?: AgentRuntimeKind,
): ProviderRuntimeSnapshotResolution {
  const snapshot = typeof providerId === 'string'
    ? (() => {
        const provider = providerService.getRawProvider(providerId);
        if (!provider) throw new Error(`Provider not found: ${providerId}`);
        return providerRuntimeSnapshot(providerService, provider);
      })()
    : envRuntimeSnapshot(runtimeOverride);
  return {
    snapshot,
    snapshotHash: hashProviderRuntimeSnapshot(snapshot),
  };
}
