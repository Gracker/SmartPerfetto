// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { buildChatCompletionsUrl } from '../agentOpenAI/openAiComplexityClassifier';
import {
  hasOpenAICredentials,
  loadOpenAIConfig,
} from '../agentOpenAI/openAiConfig';
import {
  createSdkEnv,
  getSdkBinaryOption,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveRuntimeConfig,
} from '../agentv3/claudeConfig';
import { parseOutputLanguage, outputLanguageDisplayName } from '../agentv3/outputLanguage';
import { loadPromptTemplate, renderTemplate } from '../agentv3/strategyLoader';
import { resolveAgentRuntimeSelection } from '../agentRuntime/runtimeSelection';
import { buildOpenAIChatCompletionsTokenLimit } from './providerManager/openAiChatCompletionsCompat';
import type {
  ComparisonConclusion,
  ComparisonResult,
} from '../types/multiTraceComparison';
import type { ProviderScope } from './providerManager';

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface ComparisonConclusionClientInput {
  prompt: string;
  providerId?: string | null;
  providerScope?: ProviderScope;
}

export interface ComparisonConclusionClientOutput {
  text: string;
  model?: string;
}

export interface ComparisonConclusionClient {
  complete(input: ComparisonConclusionClientInput): Promise<ComparisonConclusionClientOutput>;
}

export interface GenerateAiComparisonConclusionInput {
  result: ComparisonResult;
  query: string;
  providerId?: string | null;
  providerScope?: ProviderScope;
  client?: ComparisonConclusionClient;
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function buildPrompt(input: GenerateAiComparisonConclusionInput): string {
  const template = loadPromptTemplate('comparison-conclusion');
  if (!template) {
    throw new Error('comparison-conclusion prompt template is missing');
  }
  return renderTemplate(template, {
    query: input.query,
    outputLanguage: outputLanguageDisplayName(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE)),
    matrixJson: truncateForPrompt(JSON.stringify(input.result.matrix, null, 2), 40_000),
    deterministicFacts: input.result.conclusion.verifiedFacts.join('\n') || '(none)',
    uncertainty: input.result.conclusion.uncertainty.join('\n') || '(none)',
  });
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAiConclusion(
  text: string,
  fallback: ComparisonConclusion,
  model: string | undefined,
): ComparisonConclusion | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  const verifiedFacts = arrayOfStrings(parsed.verifiedFacts);
  const inferences = arrayOfStrings(parsed.inferences);
  const recommendations = arrayOfStrings(parsed.recommendations);
  const uncertainty = arrayOfStrings(parsed.uncertainty);
  if (
    verifiedFacts.length === 0 &&
    inferences.length === 0 &&
    recommendations.length === 0 &&
    uncertainty.length === 0
  ) {
    return null;
  }
  return {
    source: 'ai',
    ...(model ? { model } : {}),
    generatedAt: Date.now(),
    verifiedFacts: verifiedFacts.length > 0 ? verifiedFacts : fallback.verifiedFacts,
    inferences,
    recommendations,
    uncertainty: [...new Set([...fallback.uncertainty, ...uncertainty])],
  };
}

function fallbackConclusion(
  fallback: ComparisonConclusion,
  reason: string,
): ComparisonConclusion {
  return {
    ...fallback,
    source: 'deterministic',
    generatedAt: Date.now(),
    uncertainty: [...new Set([
      ...fallback.uncertainty,
      `AI comparison conclusion was not generated: ${reason}`,
    ])],
  };
}

async function completeWithOpenAI(input: ComparisonConclusionClientInput): Promise<ComparisonConclusionClientOutput> {
  const config = loadOpenAIConfig(input.providerId, input.providerScope);
  if (!hasOpenAICredentials(input.providerId, input.providerScope)) {
    throw new Error('OpenAI credentials are not configured');
  }
  const controller = new AbortController();
  const timeoutMs = config.classifierTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildChatCompletionsUrl(config.baseURL || 'https://api.openai.com/v1'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.lightModel,
        messages: [{ role: 'user', content: input.prompt }],
        temperature: 0.1,
        ...buildOpenAIChatCompletionsTokenLimit(config.lightModel, 1200),
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI comparison conclusion HTTP ${response.status}`);
    }
    const data = (await response.json()) as ChatCompletionsResponse;
    return {
      text: data.choices?.[0]?.message?.content || '',
      model: config.lightModel,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function completeWithClaude(input: ComparisonConclusionClientInput): Promise<ComparisonConclusionClientOutput> {
  const baseConfig = loadClaudeConfig();
  const config = resolveRuntimeConfig(baseConfig, input.providerId, input.providerScope);
  const env = createSdkEnv(input.providerId, input.providerScope);
  if (!hasClaudeCredentials(env)) {
    throw new Error('Claude credentials are not configured');
  }
  const binaryOption = getSdkBinaryOption(env);
  const stream = sdkQuery({
    prompt: input.prompt,
    options: {
      model: config.lightModel || config.model,
      maxTurns: 1,
      includePartialMessages: false,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd: config.cwd,
      effort: 'low',
      env,
      ...binaryOption,
      stderr: (data: string) => {
        console.warn(`[ComparisonConclusion] Claude SDK stderr: ${data.trimEnd()}`);
      },
    },
  });
  let text = '';
  for await (const message of stream) {
    if (message.type === 'assistant' && Array.isArray((message as any).message?.content)) {
      for (const block of (message as any).message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    }
    if (message.type === 'result' && typeof (message as any).result === 'string') {
      text = (message as any).result || text;
    }
  }
  return {
    text,
    model: config.lightModel || config.model,
  };
}

class DefaultComparisonConclusionClient implements ComparisonConclusionClient {
  async complete(input: ComparisonConclusionClientInput): Promise<ComparisonConclusionClientOutput> {
    const selection = resolveAgentRuntimeSelection(input.providerId, undefined, input.providerScope);
    if (selection.kind === 'openai-agents-sdk') {
      return completeWithOpenAI(input);
    }
    return completeWithClaude(input);
  }
}

export async function generateAiComparisonConclusion(
  input: GenerateAiComparisonConclusionInput,
): Promise<ComparisonConclusion> {
  const fallback = input.result.conclusion;
  if (process.env.SMARTPERFETTO_COMPARISON_AI_DISABLED === 'true') {
    return fallbackConclusion(fallback, 'disabled by SMARTPERFETTO_COMPARISON_AI_DISABLED');
  }

  let prompt: string;
  try {
    prompt = buildPrompt(input);
  } catch (error) {
    return fallbackConclusion(fallback, error instanceof Error ? error.message : String(error));
  }

  const client = input.client || new DefaultComparisonConclusionClient();
  try {
    const output = await client.complete({
      prompt,
      providerId: input.providerId,
      providerScope: input.providerScope,
    });
    const parsed = parseAiConclusion(output.text, fallback, output.model);
    if (!parsed) {
      return fallbackConclusion(fallback, 'AI response did not contain valid conclusion JSON');
    }
    return parsed;
  } catch (error) {
    return fallbackConclusion(fallback, error instanceof Error ? error.message : String(error));
  }
}
