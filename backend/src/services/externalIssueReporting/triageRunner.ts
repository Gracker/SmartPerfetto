// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';

import {buildChatCompletionsUrl} from '../../agentOpenAI/openAiComplexityClassifier';
import {
  hasOpenAICredentials,
  loadOpenAIConfig,
} from '../../agentOpenAI/openAiConfig';
import {
  createSdkEnv,
  getSdkBinaryOption,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveRuntimeConfig,
} from '../../agentv3/claudeConfig';
import {extractFirstJsonObject} from '../evolutionLifecycle/reviewExecution';
import type {ProviderScope} from '../providerManager';
import {buildOpenAIChatCompletionsTokenLimit} from '../providerManager/openAiChatCompletionsCompat';
import type {
  ExternalIssueOpportunityV1,
  ExternalIssueReviewUnavailableReason,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';
import {resolveExternalIssueProviderPin} from './providerPin';
import {buildExternalIssueTriagePrompt} from './triagePrompt';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 1800;

interface ChatCompletionsResponse {
  choices?: Array<{message?: {content?: string}}>;
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
    runtime: 'openai-agents-sdk' | 'claude-agent-sdk';
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
  const pin = resolveExternalIssueProviderPin(
    input.manifest,
    input.providerScope,
  );
  if (!pin.ok) return pin;

  let prompt: string;
  try {
    prompt = buildExternalIssueTriagePrompt({
      opportunity: input.opportunity,
      manifest: input.manifest,
    });
  } catch {
    return {ok: false, reason: 'agent_invalid'};
  }

  try {
    const output = await (input.options?.complete ?? completeWithPinnedProvider)({
      prompt,
      runtime: pin.runtime,
      providerId: pin.providerId,
      providerScope: input.providerScope,
      model: pin.model,
      timeoutMs: input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const value = extractFirstJsonObject(output.text);
    return value
      ? {ok: true, value, model: output.model}
      : {ok: false, reason: 'agent_invalid'};
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
  runtime: 'openai-agents-sdk' | 'claude-agent-sdk';
  providerId: string | null;
  providerScope: ProviderScope;
  model?: string;
  timeoutMs: number;
}): Promise<{text: string; model: string}> {
  return input.runtime === 'openai-agents-sdk'
    ? completeWithOpenAI(input)
    : completeWithClaude(input);
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
  const model = input.model ?? config.lightModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(
      buildChatCompletionsUrl(
        config.baseURL ?? 'https://api.openai.com/v1',
      ),
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? {Authorization: `Bearer ${config.apiKey}`}
            : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{role: 'user', content: input.prompt}],
          temperature: 0,
          ...buildOpenAIChatCompletionsTokenLimit(model, MAX_OUTPUT_TOKENS),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`external_issue_triage_http_${response.status}`);
    }
    const data = await response.json() as ChatCompletionsResponse;
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      model,
    };
  } finally {
    clearTimeout(timer);
  }
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
  const stream = sdkQuery({
    prompt: input.prompt,
    options: {
      model,
      maxTurns: 1,
      includePartialMessages: false,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd: config.cwd,
      effort: 'low',
      env,
      ...getSdkBinaryOption(env),
    },
  });
  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      stream.close();
    } catch {
      // Best-effort cancellation.
    }
  }, input.timeoutMs);
  try {
    for await (const message of stream) {
      if (timedOut) break;
      if (
        message.type === 'result' &&
        typeof (message as {result?: unknown}).result === 'string'
      ) {
        result = (message as {result: string}).result;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      stream.close();
    } catch {
      // The captured result remains authoritative.
    }
  }
  if (timedOut) throw new Error('external_issue_triage_timeout');
  return {text: result, model};
}

function isCredentialError(error: unknown): boolean {
  return error instanceof Error &&
    error.message === 'provider_credentials_unavailable';
}

export const __testing = {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
};
