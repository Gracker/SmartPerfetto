// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type OpenAIChatCompletionsTokenLimit =
  | { max_tokens: number }
  | { max_completion_tokens: number };

/** Closed set of no-tool request purposes that may carry provider controls. */
export type OpenAITextRequestPurpose = 'classification' | 'final_semantic' | 'declaration_repair' | 'continuation';

export const OPENAI_TEXT_REQUEST_PURPOSES: readonly OpenAITextRequestPurpose[] =
  Object.freeze(['classification', 'final_semantic', 'declaration_repair', 'continuation']);

export function isOpenAITextRequestPurpose(value: unknown): value is OpenAITextRequestPurpose {
  return typeof value === 'string' && (OPENAI_TEXT_REQUEST_PURPOSES as readonly string[]).includes(value);
}

export type OpenAITextRequestPurposeOptions = {
  thinking?: {type: 'disabled'};
  reasoning?: {effort: 'none'};
  response_format?: {type: 'json_object'};
  text?: {format: {type: 'json_object'}};
};

/** Official Zhipu GLM origins (mainland and international). Their chat
 * completions think by default; a classification prompt then spent ~1.5k
 * reasoning tokens and 28-30 s on glm-5.3-flash, at the 30 s classifier
 * budget, versus ~4.5 s with thinking disabled.
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
 */
const GLM_ORIGINS = new Set(['https://open.bigmodel.cn', 'https://api.z.ai']);

/** Apply purpose-specific controls only to the exact official origin.
 * Every no-tool delivery purpose (classification, final semantic review,
 * declaration repair, continuation) disables default thinking: a GLM or
 * DeepSeek review that reasoned first took minutes (median ~400 s) and often
 * outlasted its budget. Final semantic review also requests JSON syntax.
 * Gateways own their protocol semantics.
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * https://api-docs.deepseek.com/guides/json_mode/
 */
export function buildOpenAITextRequestPurposeOptions(input: {
  requestUrl: URL;
  protocol: 'chat_completions' | 'responses';
  purpose?: OpenAITextRequestPurpose;
}): OpenAITextRequestPurposeOptions {
  if (!isOpenAITextRequestPurpose(input.purpose)) return {};
  if (GLM_ORIGINS.has(input.requestUrl.origin)) {
    // GLM serves chat completions only; its JSON mode is not relied on here.
    return input.protocol === 'chat_completions' ? {thinking: {type: 'disabled'}} : {};
  }
  if (input.requestUrl.origin !== 'https://api.deepseek.com') return {};
  const reasoning: OpenAITextRequestPurposeOptions = input.protocol === 'responses'
    ? {reasoning: {effort: 'none'}} : {thinking: {type: 'disabled'}};
  if (input.purpose !== 'final_semantic') return reasoning;
  return input.protocol === 'responses'
    ? {...reasoning, text: {format: {type: 'json_object'}}}
    : {...reasoning, response_format: {type: 'json_object'}};
}

const MAX_COMPLETION_TOKENS_MODEL_PATTERNS = [
  /^gpt-5\.6(?:$|-)/,
];

function normalizeModelId(model: string): string {
  const pathSegments = model.trim().toLowerCase().split('/').filter(Boolean);
  return pathSegments[pathSegments.length - 1] ?? '';
}

/**
 * Selects the token-limit field accepted by the concrete Chat Completions model.
 *
 * Compatible gateways still commonly implement the legacy `max_tokens` field,
 * while GPT-5.6 Chat Completions rejects it in favor of
 * `max_completion_tokens`. Keep that capability decision at the provider
 * protocol boundary so every Chat Completions caller stays consistent.
 */
export function buildOpenAIChatCompletionsTokenLimit(
  model: string,
  maxTokens: number,
): OpenAIChatCompletionsTokenLimit {
  const normalizedModel = normalizeModelId(model);
  const requiresMaxCompletionTokens = MAX_COMPLETION_TOKENS_MODEL_PATTERNS.some(
    pattern => pattern.test(normalizedModel),
  );
  return requiresMaxCompletionTokens
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export interface OpenAIChatCompletionsOutput {
  /** Assistant message content, or '' when the model emitted none. */
  text: string;
  /** Provider-reported stop reason, when the gateway supplies one. */
  finishReason?: string;
  /** Total completion tokens billed, including reasoning tokens. */
  completionTokens?: number;
  /** Reasoning tokens consumed inside the completion budget, when reported. */
  reasoningTokens?: number;
}

interface ChatCompletionsResponseShape {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Normalize a Chat Completions body into the fields every caller needs to tell
 * "the model answered" from "the model ran out of output budget".
 *
 * Reasoning models spend the same completion budget on hidden reasoning tokens,
 * so a budget that is generous for a plain model can return empty content with
 * `finish_reason: "length"`. Keep that protocol knowledge here rather than in
 * each caller's private response interface.
 */
export function readOpenAIChatCompletionsOutput(
  data: unknown,
): OpenAIChatCompletionsOutput {
  const body = (data ?? {}) as ChatCompletionsResponseShape;
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  const completionTokens = finiteNonNegative(body.usage?.completion_tokens);
  const reasoningTokens = finiteNonNegative(
    body.usage?.completion_tokens_details?.reasoning_tokens,
  );
  return {
    text: typeof content === 'string' ? content : '',
    ...(typeof choice?.finish_reason === 'string'
      ? { finishReason: choice.finish_reason }
      : {}),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/**
 * Fraction of the requested cap at which a usage-only response counts as
 * budget-exhausted. Gateways that omit `finish_reason` still report usage, and
 * providers may bill one or two tokens below the cap on a truncated turn.
 */
const OUTPUT_BUDGET_EXHAUSTED_RATIO = 0.98;

/**
 * True when the response stopped because it hit the requested output cap.
 * Prefers the provider's own `finish_reason`, and falls back to usage against
 * the cap for gateways that omit it.
 */
export function isOpenAIChatCompletionsOutputTruncated(
  output: OpenAIChatCompletionsOutput,
  requestedMaxTokens: number,
): boolean {
  if (output.finishReason === 'length') return true;
  if (output.finishReason !== undefined) return false;
  if (!Number.isFinite(requestedMaxTokens) || requestedMaxTokens <= 0) return false;
  return output.completionTokens !== undefined
    && output.completionTokens >= requestedMaxTokens * OUTPUT_BUDGET_EXHAUSTED_RATIO;
}
