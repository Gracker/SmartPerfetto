// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * OpenAI-side query complexity AI fallback.
 *
 * Mirrors the Haiku-based classifier in agentv3/queryComplexityClassifier.ts but uses
 * OpenAI's light model via /chat/completions. Kept in agentOpenAI/ so OpenAI-only users
 * don't drag in the Anthropic SDK at module-load time.
 *
 * Contract is provider-symmetric:
 *   render `prompt-complexity-classifier` template → single-turn LLM call → JSON parse →
 *   graceful fallback to 'full' on any failure.
 */

import { buildComplexityClassifierPrompt } from '../../../agentv3/queryComplexityPrompt';
import type { ComplexityClassifierInput, QueryComplexity } from '../../../agentv3/types';
import {
  buildOpenAIChatCompletionsTokenLimit,
  isOpenAIChatCompletionsOutputTruncated,
  readOpenAIChatCompletionsOutput,
  type OpenAIChatCompletionsOutput,
} from '../../../services/providerManager/openAiChatCompletionsCompat';
import type { OpenAIAgentConfig } from './openAiConfig';

/**
 * Output budget for the classification turn.
 *
 * The decision itself is ~50 tokens of JSON, but reasoning models bill hidden
 * reasoning tokens against the same completion budget. A budget sized for the
 * JSON alone returns empty content with `finish_reason: "length"`, which used to
 * degrade silently to 'full' — and it starves hardest on the scoped questions
 * that need the most scope reasoning, which are exactly the ones that should
 * classify as 'quick'. Measured need on a reasoning light model is 217-351
 * completion tokens; keep clear headroom above that.
 */
export const CLASSIFIER_OUTPUT_TOKENS = 2048;
/** Bounded single escalation for models that reason past the base budget. */
export const CLASSIFIER_RETRY_OUTPUT_TOKENS = 6144;
/** Below this remaining deadline a retry cannot finish, so don't start one. */
const MIN_RETRY_BUDGET_MS = 2_000;

interface ClassifierDecision {
  complexity: QueryComplexity;
  reason: string;
}

type ClassifierParse =
  | { decision: ClassifierDecision }
  /** No JSON object at all vs. one that is present but unparseable. */
  | { failure: 'absent' | 'malformed' };

/** Parse the model's JSON verdict, keeping the two failure shapes distinct. */
function parseClassifierJson(text: string): ClassifierParse {
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return { failure: 'absent' };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { complexity?: unknown; reason?: unknown };
    const complexity: QueryComplexity = parsed.complexity === 'quick' ? 'quick' : 'full';
    const reason = typeof parsed.reason === 'string' && parsed.reason.length > 0
      ? parsed.reason
      : 'AI classification';
    return { decision: { complexity, reason } };
  } catch {
    return { failure: 'malformed' };
  }
}

/** Fallback reason naming why no verdict was parsed, for the run log. */
function unparsedReason(
  output: OpenAIChatCompletionsOutput,
  requestedMaxTokens: number,
  failure: 'absent' | 'malformed',
): string {
  if (!isOpenAIChatCompletionsOutputTruncated(output, requestedMaxTokens)) {
    if (failure === 'malformed') return 'failed to parse OpenAI JSON response';
    return output.text.trim().length > 0
      ? 'no JSON in OpenAI response'
      : 'empty OpenAI classifier response';
  }
  const reasoning = output.reasoningTokens !== undefined
    ? `, ${output.reasoningTokens} of them reasoning tokens`
    : '';
  return `OpenAI classifier output truncated at the ${requestedMaxTokens}-token budget${reasoning}`;
}

/**
 * Build the chat-completions URL from the configured baseURL. Handles trailing
 * slash + custom path prefixes (e.g., Azure OpenAI deployments) by normalizing
 * the base to end with '/' before appending the relative endpoint.
 */
export function buildChatCompletionsUrl(baseUrl: string): URL {
  const normalized = baseUrl.replace(/\/?$/, '/');
  return new URL('chat/completions', normalized);
}

/**
 * Single-turn classification via OpenAI-compatible chat completions.
 * Uses config.lightModel (default `gpt-5.4-mini`). Compatible with OpenAI,
 * DeepSeek, Qwen, and most local LLM gateways that expose /chat/completions.
 *
 * At most two requests are made, and both share one total deadline: the retry
 * only spends whatever `classifierTimeoutMs` has left.
 */
export async function classifyQueryWithOpenAILightModel(
  input: string | ComplexityClassifierInput,
  config: Pick<OpenAIAgentConfig, 'baseURL' | 'apiKey' | 'lightModel' | 'classifierTimeoutMs'>,
  analysisSignal?: AbortSignal,
): Promise<ClassifierDecision> {
  if (!config.baseURL) {
    return { complexity: 'full', reason: 'OpenAI baseURL missing' };
  }

  const prompt = buildComplexityClassifierPrompt(input);
  const url = buildChatCompletionsUrl(config.baseURL);
  const controller = new AbortController();
  const abortFromAnalysis = () => controller.abort(analysisSignal?.reason);
  if (analysisSignal?.aborted) {
    abortFromAnalysis();
  } else {
    analysisSignal?.addEventListener('abort', abortFromAnalysis, { once: true });
  }
  const timeoutMs = config.classifierTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  async function requestVerdict(
    maxTokens: number,
  ): Promise<{ status: number } | { output: OpenAIChatCompletionsOutput }> {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.lightModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        ...buildOpenAIChatCompletionsTokenLimit(config.lightModel, maxTokens),
      }),
    });
    if (!res.ok) return { status: res.status };
    return { output: readOpenAIChatCompletionsOutput(await res.json()) };
  }

  try {
    const first = await requestVerdict(CLASSIFIER_OUTPUT_TOKENS);
    if ('status' in first) {
      return { complexity: 'full', reason: `OpenAI classifier HTTP ${first.status}` };
    }
    const firstParse = parseClassifierJson(first.output.text);
    if ('decision' in firstParse) return firstParse.decision;

    const budgetExhausted = isOpenAIChatCompletionsOutputTruncated(
      first.output,
      CLASSIFIER_OUTPUT_TOKENS,
    );
    if (!budgetExhausted || Date.now() + MIN_RETRY_BUDGET_MS >= deadline) {
      return {
        complexity: 'full',
        reason: unparsedReason(
          first.output,
          CLASSIFIER_OUTPUT_TOKENS,
          firstParse.failure,
        ),
      };
    }

    const retry = await requestVerdict(CLASSIFIER_RETRY_OUTPUT_TOKENS);
    if ('status' in retry) {
      return { complexity: 'full', reason: `OpenAI classifier HTTP ${retry.status}` };
    }
    const retryParse = parseClassifierJson(retry.output.text);
    if ('decision' in retryParse) return retryParse.decision;
    return {
      complexity: 'full',
      reason: unparsedReason(
        retry.output,
        CLASSIFIER_RETRY_OUTPUT_TOKENS,
        retryParse.failure,
      ),
    };
  } catch (err) {
    if (analysisSignal?.aborted) throw err;
    if (timedOut) {
      return { complexity: 'full', reason: `OpenAI classifier timed out after ${timeoutMs / 1000}s` };
    }
    return { complexity: 'full', reason: `OpenAI classifier failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
    analysisSignal?.removeEventListener('abort', abortFromAnalysis);
  }
}
