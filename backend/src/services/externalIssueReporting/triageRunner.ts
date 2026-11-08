// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {runClaudeTriageQuery} from '../../agentRuntime/engines/claude/claudeAuxiliaryQueries';

import {buildChatCompletionsUrl} from '../../agentOpenAI/openAiComplexityClassifier';
import {
  hasOpenAICredentials,
  loadOpenAIConfig,
} from '../../agentOpenAI/openAiConfig';
import {
  createSdkEnv,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveRuntimeConfig,
} from '../../agentv3/claudeConfig';
import {extractFirstJsonObject} from '../evolutionLifecycle/reviewExecution';
import {getProviderService, type ProviderScope} from '../providerManager';
import {readPiAgentCoreModelConfig} from '../../agentRuntime/engines/pi/piAgentCoreConfig';
import {resolvePiModelRecord} from '../../agentRuntime/engines/pi/piAgentCoreProvider';
import {buildOpenAIChatCompletionsTokenLimit} from '../providerManager/openAiChatCompletionsCompat';
import type {
  ExternalIssueOpportunityV1,
  ExternalIssueReviewUnavailableReason,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';
import {resolveExternalIssueProviderPin} from './providerPin';
import {runtimeEnvFor} from '../providerManager/piProviderCatalog';
import {buildExternalIssueTriagePrompt} from './triagePrompt';
import {validateExternalIssueReview} from './reviewValidator';
import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 8192;

interface ChatCompletionsResponse {
  choices?: Array<{message?: {content?: string}}>;
}

interface OpenAICompatibleReviewConfig {
  apiKey?: string;
  baseURL: string;
  model: string;
}

export type ExternalIssueTriageExecutionResult =
  | {
      ok: true;
      value: Record<string, unknown>;
      model: string;
    }
  | {
      ok: false;
      reason: ExternalIssueReviewUnavailableReason | 'agent_invalid';
    };

export interface RunExternalIssueTriageOptions {
  timeoutMs?: number;
  complete?: (input: {
    prompt: string;
    runtime: AgentRuntimeKind;
    providerId: string | null;
    providerScope: ProviderScope;
    model?: string;
    timeoutMs: number;
  }) => Promise<{text: string; model: string}>;
}

export async function runExternalIssueTriage(input: {
  opportunity: ExternalIssueOpportunityV1;
  manifest: RunManifestV1;
  providerScope: ProviderScope;
  options?: RunExternalIssueTriageOptions;
}): Promise<ExternalIssueTriageExecutionResult> {
  try {
    let validationErrors: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pin = resolveExternalIssueProviderPin(
        input.manifest,
        input.providerScope,
      );
      if (!pin.ok) return pin;
      const prompt = buildExternalIssueTriagePrompt({
        opportunity: input.opportunity,
        manifest: input.manifest,
        ...(validationErrors ? {validationErrors} : {}),
      });
      const output = await (input.options?.complete ?? completeWithPinnedProvider)({
        prompt,
        runtime: pin.runtime,
        providerId: pin.providerId,
        providerScope: input.providerScope,
        model: pin.model,
        timeoutMs: input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const value = extractFirstJsonObject(output.text);
      if (!value) {
        validationErrors = ['review must contain one valid JSON object'];
        console.warn(
          `[ExternalIssueTriage] Invalid Agent review attempt ${attempt + 1}: ${validationErrors.join('; ')} (responseChars=${output.text.length}, openingBrace=${output.text.includes('{')}, closingBrace=${output.text.includes('}')})`,
        );
        continue;
      }
      const validated = validateExternalIssueReview({
        raw: value,
        opportunity: input.opportunity,
        manifest: input.manifest,
        source: 'agent',
        model: output.model,
      });
      if (validated.ok) return {ok: true, value, model: output.model};
      validationErrors = validated.errors;
      console.warn(
        `[ExternalIssueTriage] Invalid Agent review attempt ${attempt + 1}: ${validationErrors.join('; ')}`,
      );
    }
    return {ok: false, reason: 'agent_invalid'};
  } catch (error) {
    return {
      ok: false,
      reason: isCredentialError(error)
        ? 'provider_credentials_unavailable'
        : 'agent_invalid',
    };
  }
}

async function completeWithPinnedProvider(input: {
  prompt: string;
  runtime: AgentRuntimeKind;
  providerId: string | null;
  providerScope: ProviderScope;
  model?: string;
  timeoutMs: number;
}): Promise<{text: string; model: string}> {
  if (input.runtime === 'claude-agent-sdk') {
    return completeWithClaude(input);
  }
  if (input.runtime === 'openai-agents-sdk') {
    return completeWithOpenAI(input);
  }
  return completeWithPi({
    ...input,
  });
}

async function completeWithOpenAI(input: {
  prompt: string;
  providerId: string | null;
  providerScope: ProviderScope;
  model?: string;
  timeoutMs: number;
}): Promise<{text: string; model: string}> {
  if (!hasOpenAICredentials(input.providerId, input.providerScope)) {
    throw new Error('provider_credentials_unavailable');
  }
  const config = loadOpenAIConfig(input.providerId, input.providerScope);
  return completeWithOpenAICompatible({
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    config: {
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.openai.com/v1',
      model: input.model ?? config.lightModel,
    },
  });
}

async function completeWithPi(input: {
  prompt: string;
  providerId: string | null;
  providerScope: ProviderScope;
  model?: string;
  timeoutMs: number;
}): Promise<{text: string; model: string}> {
  const env = resolvePinnedPiEnv(input.providerId, input.providerScope);
  const config = await resolvePiReviewConfig(env, input.model);
  assertReviewCredentials(config);
  return completeWithOpenAICompatible({
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    config,
  });
}

async function completeWithOpenAICompatible(input: {
  prompt: string;
  timeoutMs: number;
  config: OpenAICompatibleReviewConfig;
}): Promise<{text: string; model: string}> {
  const {apiKey, baseURL, model} = input.config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const requestUrl = buildChatCompletionsUrl(baseURL);
    const isOfficialDeepSeek = new URL(requestUrl).hostname.toLowerCase()
      === 'api.deepseek.com';
    const requestCompletion = async (
      includeResponseFormat: boolean,
    ): Promise<{text: string; model: string}> => {
      const response = await fetch(requestUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey
            ? {Authorization: `Bearer ${apiKey}`}
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{role: 'user', content: input.prompt}],
          temperature: 0,
          ...(includeResponseFormat
            ? {response_format: {type: 'json_object'}}
            : {}),
          ...(isOfficialDeepSeek
            ? {thinking: {type: 'disabled'}}
            : {}),
          ...buildOpenAIChatCompletionsTokenLimit(model, MAX_OUTPUT_TOKENS),
        }),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        const responseFormatUnsupported = includeResponseFormat &&
          (response.status === 400 || response.status === 422) &&
          /response[_ -]?format|json[_ -]?mode/i.test(errorBody) &&
          /unsupported|unknown|unrecognized|invalid|not supported/i.test(errorBody);
        if (responseFormatUnsupported) {
          return requestCompletion(false);
        }
        throw new Error(`external_issue_triage_http_${response.status}`);
      }
      const data = await response.json() as ChatCompletionsResponse;
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        model,
      };
    };
    return requestCompletion(true);
  } finally {
    clearTimeout(timer);
  }
}

function resolvePinnedPiEnv(
  providerId: string | null,
  providerScope: ProviderScope,
): Record<string, string | undefined> {
  const providerService = getProviderService();
  const provider = typeof providerId === 'string'
    ? providerService.getRawProvider(providerId, providerScope)
    : undefined;
  if (typeof providerId === 'string' && !provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }
  if (provider && providerService.resolveAgentRuntime(provider) !== 'pi-agent-core') {
    throw new Error('provider_snapshot_changed');
  }
  const providerEnv = provider
    ? providerService.getEnvForProvider(provider.id, providerScope)
    : null;
  // An env-only Pi pin reads the model its Claude/OpenAI env maps to, as the runtime does.
  return runtimeEnvFor(process.env, providerEnv, 'pi-agent-core');
}

async function resolvePiReviewConfig(
  env: Record<string, string | undefined>,
  pinnedModel?: string,
): Promise<OpenAICompatibleReviewConfig> {
  const config = readPiAgentCoreModelConfig(env);
  if (!config) throw new Error('external_issue_triage_pi_model_config_incomplete');
  // One resolution path with the runtime; credential fields come from the parsed config.
  const modelJson: Record<string, unknown> = {...await resolvePiModelRecord(config),
    apiKey: config.apiKey, apiKeyEnv: config.apiKeyEnv};
  const api = readConfigString(modelJson.api);
  if (api !== 'openai-completions') {
    throw new Error(
      `external_issue_triage_runtime_not_supported:${api ?? 'unspecified'}`,
    );
  }
  const model = pinnedModel
    ?? readConfigString(modelJson.id)
    ?? readConfigString(modelJson.model)
    ?? readConfigString(modelJson.name);
  const baseURL = readConfigString(modelJson.baseUrl)
    ?? readConfigString(modelJson.baseURL)
    ?? env.OPENAI_BASE_URL;
  if (!model || !baseURL) {
    throw new Error('external_issue_triage_pi_model_config_incomplete');
  }
  return {
    model,
    baseURL,
    apiKey: resolveModelApiKey(modelJson, env),
  };
}

function readConfigString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function resolveModelApiKey(
  modelJson: Record<string, unknown>,
  env: Record<string, string | undefined>,
): string | undefined {
  const apiKeyEnv = readConfigString(modelJson.apiKeyEnv);
  const provider = readConfigString(modelJson.provider)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return readConfigString(modelJson.apiKey)
    ?? (apiKeyEnv ? env[apiKeyEnv]?.trim() : undefined)
    ?? (provider ? env[`${provider}_API_KEY`]?.trim() : undefined)
    ?? env.OPENAI_API_KEY?.trim();
}

function assertReviewCredentials(config: OpenAICompatibleReviewConfig): void {
  if (config.apiKey) return;
  try {
    const host = new URL(config.baseURL).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
      return;
    }
  } catch {
    // Invalid endpoints fail through the same credentials-safe path.
  }
  throw new Error('provider_credentials_unavailable');
}

async function completeWithClaude(input: {
  prompt: string;
  providerId: string | null;
  providerScope: ProviderScope;
  model?: string;
  timeoutMs: number;
}): Promise<{text: string; model: string}> {
  const env = createSdkEnv(input.providerId, input.providerScope);
  if (!hasClaudeCredentials(env)) {
    throw new Error('provider_credentials_unavailable');
  }
  const config = resolveRuntimeConfig(
    loadClaudeConfig(),
    input.providerId,
    input.providerScope,
  );
  const model = input.model ?? config.lightModel ?? config.model;
  const {timedOut, text} = await runClaudeTriageQuery({
    prompt: input.prompt,
    model,
    cwd: config.cwd,
    env,
    timeoutMs: input.timeoutMs,
  });
  if (timedOut) throw new Error('external_issue_triage_timeout');
  return {text, model};
}

function isCredentialError(error: unknown): boolean {
  return error instanceof Error &&
    error.message === 'provider_credentials_unavailable';
}

/** @internal Test seam. */
export const __testing = {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
};
