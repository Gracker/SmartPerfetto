// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveModelExecutionProfile, type ModelEffectiveSettings, type ReasoningEffort,
  type ResolveModelExecutionProfileInput, type ResolvedModelExecutionProfile, type SdkModelCapabilities} from './modelExecutionProfile';
import {resolveModelExecutionPolicy, type ModelExecutionPolicyReceipt} from '../../agentRuntime/modelExecutionPolicy';

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
  thinking?: {type: 'enabled' | 'disabled'};
  reasoning_effort?: ReasoningEffort;
  reasoning?: {effort: 'none' | ReasoningEffort};
  response_format?: {type: 'json_object'};
  text?: {format: {type: 'json_object'}};
};

/** Exact official origins for protocol compatibility; model capabilities live in modelExecutionProfile. */
const GLM_ORIGINS = new Set(['https://open.bigmodel.cn', 'https://api.z.ai']);

/** Parsed origins only: model names and gateway URL substrings do not grant GLM protocol semantics. */
export function isOfficialGlmOrigin(url: URL | string): boolean {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return parsed.protocol === 'https:' && GLM_ORIGINS.has(parsed.origin);
  } catch {return false;}
}

export interface OpenAITextRequestPurposeInput {
  requestUrl: URL;
  protocol: 'chat_completions' | 'responses';
  model: string | undefined;
  runtimeKind: 'openai-agents-sdk' | 'opencode';
  sdkCapabilities: SdkModelCapabilities;
  sdkIdentity?: ResolveModelExecutionProfileInput['sdk'];
  effective?: ModelEffectiveSettings;
  purpose?: OpenAITextRequestPurpose;
  outputOnly?: true;
}

/** Fixed failure: unsupported policy is configuration failure, never a retryable provider error. */
export class OpenAITextPolicyConfigurationError extends Error {
  constructor() {super('openai_text_policy_invalid_configuration');}
}

/** Metadata is separate from body options so callers cannot spread a fingerprint into the provider request. */
export function resolveOpenAITextRequestPurpose(input: OpenAITextRequestPurposeInput): {
  options: OpenAITextRequestPurposeOptions;
  profile: ResolvedModelExecutionProfile;
  policy?: ModelExecutionPolicyReceipt;
} {
  try {
    if (input.purpose !== undefined && !isOpenAITextRequestPurpose(input.purpose)) throw new OpenAITextPolicyConfigurationError();
    const profile = resolveModelExecutionProfile({runtimeKind: input.runtimeKind, protocol: input.protocol,
      modelId: input.model, baseUrl: input.requestUrl.toString(), sdkCapabilities: input.sdkCapabilities,
      sdk: input.sdkIdentity ?? {packageName: input.runtimeKind, version: 'unknown', adapterContractVersion: 'openai-purpose@1'},
      effective: input.effective ?? {}});
    const purpose = input.purpose === 'final_semantic' ? 'review' : input.purpose ?? 'answer_turn';
    const candidate = purpose === 'classification' || purpose === 'review' || purpose === 'declaration_repair' ||
      purpose === 'continuation' && input.outputOnly === true;
    const selected = resolveModelExecutionPolicy({profile, purpose, outputOnly: input.outputOnly,
      selection: candidate ? 'minimum_legal_candidate' : 'preserve'});
    if (selected.status === 'unsupported') throw new OpenAITextPolicyConfigurationError();
    const options: OpenAITextRequestPurposeOptions = {};
    const authored = profile.effective.authoredReasoning;
    // Authored settings are the caller's existing request configuration, not a guessed stage default.
    const setting = authored ?? (selected.receipt.mapped === 'unchanged' || selected.receipt.mapped === 'unknown'
      ? undefined : selected.receipt.mapped);
    if (setting) {
      const surface = profile.adapter.surface;
      if (profile.adapter.thinking === 'unknown' || surface === 'none') throw new OpenAITextPolicyConfigurationError();
      if (input.protocol === 'chat_completions') {
        options.thinking = {type: setting.mode};
        if (setting.mode === 'enabled' && setting.effort !== undefined) options.reasoning_effort = setting.effort;
      } else if (setting.mode === 'disabled') options.reasoning = {effort: 'none'};
      else if (setting.effort !== undefined) options.reasoning = {effort: setting.effort};
      else throw new OpenAITextPolicyConfigurationError();
    }
    const jsonPurpose = input.purpose === 'classification' || input.purpose === 'final_semantic' || input.purpose === 'declaration_repair';
    if (input.protocol === 'chat_completions' && profile.adapter.surface === 'openai_chat' &&
        jsonPurpose && profile.server.jsonOutput?.status === 'supported') {
      options.response_format = {type: profile.server.jsonOutput.value};
    }
    // Retain the existing DeepSeek review JSON syntax contract only for a recognized model/API.
    if (input.purpose === 'final_semantic' && profile.endpoint.family === 'deepseek' && profile.server.thinking.status === 'supported') {
      if (input.protocol === 'responses') options.text = {format: {type: 'json_object'}};
      else options.response_format = {type: 'json_object'};
    }
    return {options, profile, ...(input.purpose !== undefined ? {policy: selected.receipt} : {})};
  } catch {throw new OpenAITextPolicyConfigurationError();}
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
