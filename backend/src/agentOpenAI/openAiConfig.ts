// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { DEFAULT_OUTPUT_LANGUAGE, outputLanguageDisplayName, parseOutputLanguage, type OutputLanguage } from '../agentv3/outputLanguage';
import { getProviderService, type OpenAIProtocol } from '../services/providerManager';
import { mergeIsolatedProviderEnv } from '../services/providerManager/envIsolation';

export interface OpenAIAgentConfig {
  model: string;
  lightModel: string;
  maxTurns: number;
  quickMaxTurns: number;
  baseURL?: string;
  apiKey?: string;
  protocol: OpenAIProtocol;
  cwd: string;
  fullPathPerTurnMs: number;
  quickPathPerTurnMs: number;
  classifierTimeoutMs: number;
  outputLanguage: OutputLanguage;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_LIGHT_MODEL = 'gpt-5.4-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_QUICK_MAX_TURNS = 10;

function parsePositiveIntEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProtocol(value: string | undefined): OpenAIProtocol {
  return value === 'chat_completions' ? 'chat_completions' : 'responses';
}

export function createOpenAIEnv(providerId?: string | null): Record<string, string | undefined> {
  const svc = getProviderService();
  const provider = typeof providerId === 'string'
    ? svc.getRawProvider(providerId)
    : providerId === null
      ? undefined
    : svc.getRawEffectiveProvider();

  if (typeof providerId === 'string' && !provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  const providerRuntime = provider ? svc.resolveAgentRuntime(provider) : undefined;
  if (typeof providerId === 'string' && providerRuntime !== 'openai-agents-sdk') {
    throw new Error(`Provider ${providerId} is configured for ${providerRuntime}, not openai-agents-sdk`);
  }

  const providerEnv = providerRuntime === 'openai-agents-sdk' && provider
    ? svc.getEnvForProvider(provider.id)
    : null;
  return mergeIsolatedProviderEnv(process.env, providerEnv);
}

export function loadOpenAIConfig(providerId?: string | null): OpenAIAgentConfig {
  const env = createOpenAIEnv(providerId);
  return {
    model: env.OPENAI_MODEL || DEFAULT_MODEL,
    lightModel: env.OPENAI_LIGHT_MODEL || DEFAULT_LIGHT_MODEL,
    maxTurns: parsePositiveIntEnv(env, 'OPENAI_MAX_TURNS',
      parsePositiveIntEnv(env, 'CLAUDE_MAX_TURNS', DEFAULT_MAX_TURNS)),
    quickMaxTurns: parsePositiveIntEnv(env, 'OPENAI_QUICK_MAX_TURNS',
      parsePositiveIntEnv(env, 'CLAUDE_QUICK_MAX_TURNS', DEFAULT_QUICK_MAX_TURNS)),
    baseURL: env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
    protocol: parseProtocol(env.OPENAI_AGENTS_PROTOCOL),
    cwd: env.OPENAI_CWD || env.CLAUDE_CWD || process.cwd(),
    fullPathPerTurnMs: parsePositiveIntEnv(env, 'OPENAI_FULL_PER_TURN_MS',
      parsePositiveIntEnv(env, 'CLAUDE_FULL_PER_TURN_MS', 60_000)),
    quickPathPerTurnMs: parsePositiveIntEnv(env, 'OPENAI_QUICK_PER_TURN_MS',
      parsePositiveIntEnv(env, 'CLAUDE_QUICK_PER_TURN_MS', 40_000)),
    classifierTimeoutMs: parsePositiveIntEnv(env, 'OPENAI_CLASSIFIER_TIMEOUT_MS',
      parsePositiveIntEnv(env, 'CLAUDE_CLASSIFIER_TIMEOUT_MS', 30_000)),
    outputLanguage: parseOutputLanguage(env.SMARTPERFETTO_OUTPUT_LANGUAGE),
  };
}

export function hasOpenAICredentials(providerId?: string | null): boolean {
  const env = createOpenAIEnv(providerId);
  const baseUrl = env.OPENAI_BASE_URL || '';
  return Boolean(
    env.OPENAI_API_KEY
    || baseUrl.includes('localhost')
    || baseUrl.includes('127.0.0.1')
    || baseUrl.includes('0.0.0.0'),
  );
}

export function getOpenAIRuntimeDiagnostics(providerId?: string | null) {
  const config = loadOpenAIConfig(providerId);
  const credentialSources: string[] = [];
  if (config.apiKey) credentialSources.push('openai_api_key');
  if (config.baseURL) credentialSources.push('openai_base_url');

  return {
    runtime: 'openai-agents-sdk',
    providerMode: config.protocol === 'responses'
      ? 'openai_responses'
      : 'openai_chat_completions_compatible',
    model: config.model,
    lightModel: config.lightModel,
    protocol: config.protocol,
    baseUrlConfigured: !!config.baseURL,
    configured: hasOpenAICredentials(providerId),
    credentialSources,
    outputLanguage: {
      value: config.outputLanguage,
      displayName: outputLanguageDisplayName(config.outputLanguage),
      env: 'SMARTPERFETTO_OUTPUT_LANGUAGE',
      default: DEFAULT_OUTPUT_LANGUAGE,
    },
    configHint: config.protocol === 'responses'
      ? 'Using OpenAI Responses API through the OpenAI Agents SDK. Set OPENAI_API_KEY, OPENAI_MODEL, and optionally OPENAI_BASE_URL.'
      : 'Using an OpenAI-compatible Chat Completions endpoint through the OpenAI Agents SDK. Ensure the endpoint supports streaming function/tool calls.',
  };
}
