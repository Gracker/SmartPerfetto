// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type OpenAIChatCompletionsTokenLimit =
  | { max_tokens: number }
  | { max_completion_tokens: number };

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
