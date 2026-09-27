// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OpenAIAgentConfig} from './openAiConfig';
import {
  buildOpenAIChatCompletionsTokenLimit,
  buildOpenAITextRequestPurposeOptions,
  readOpenAIChatCompletionsOutput,
  type OpenAITextRequestPurpose,
} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {
  intentTransportTextResult,
  runIntentTransport,
  type IntentTransportInput,
  type IntentTransportResult,
  type IntentTransportScope,
} from '../../intentTransport';
import {readChatCompletionStream, readResponsesStream} from './openAiIntentStream';

export interface OpenAiIntentTransportInput extends IntentTransportInput {
  config: Pick<OpenAIAgentConfig, 'baseURL' | 'apiKey' | 'lightModel' | 'protocol'>;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  purpose?: OpenAITextRequestPurpose;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function chatResult(body: Record<string, unknown>, input: OpenAiIntentTransportInput): IntentTransportResult {
  if (!Array.isArray(body.choices) || body.choices.length !== 1) {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  const message = object(object(body.choices[0])?.message);
  if (!message || (message.role !== undefined && message.role !== 'assistant')) {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  if ((message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
    || message.function_call != null) {
    return {status: 'unavailable', reason: 'tool_use'};
  }
  if (message.refusal != null && message.refusal !== '') {
    return {status: 'unavailable', reason: 'invalid_response'};
  }
  const output = readOpenAIChatCompletionsOutput(body);
  if (output.finishReason !== 'stop') {
    return {status: 'unavailable', reason: output.finishReason === 'length' ? 'incomplete_output' : 'invalid_response'};
  }
  return intentTransportTextResult(output.text, input, {
    ...(typeof body.model === 'string' ? {actualModel: body.model} : {}),
    finishReason: output.finishReason,
  });
}

function responsesResult(body: Record<string, unknown>, input: OpenAiIntentTransportInput): IntentTransportResult {
  if (body.status !== 'completed' || body.incomplete_details != null || !Array.isArray(body.output)) {
    return {status: 'unavailable', reason: body.status === 'incomplete' ? 'incomplete_output' : 'invalid_response'};
  }
  const text: string[] = [];
  for (const rawItem of body.output) {
    const item = object(rawItem);
    if (!item) return {status: 'unavailable', reason: 'invalid_response'};
    if (item.type === 'reasoning') {
      if (item.status !== undefined && item.status !== 'completed') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      continue;
    }
    if (item.type !== 'message') return {status: 'unavailable', reason: 'tool_use'};
    if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    if (item.phase !== undefined && item.phase !== null && item.phase !== 'commentary' && item.phase !== 'final_answer') {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part?.type !== 'output_text' || typeof part.text !== 'string') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      if (item.phase !== 'commentary') text.push(part.text);
    }
  }
  return intentTransportTextResult(text.join(''), input, {
    ...(typeof body.model === 'string' ? {actualModel: body.model} : {}),
    finishReason: body.status,
  });
}

/** One bounded retry for transient provider failures; protocol errors never repeat. */
const PROVIDER_ERROR_RETRY_BACKOFF_MS = 2_000;
/** Only retry while enough of the shared deadline remains for a full second call. */
const PROVIDER_ERROR_RETRY_MIN_REMAINING_MS = 15_000;

/**
 * Only statuses that say "try again later" are transient. Auth, routing and
 * request-shape errors (400/401/403/404/422) answer the same way on a second
 * call, and a 200 carrying a parseable error body gives no evidence of
 * transience. A body that fails to read or parse throws, and is retried like
 * a dropped connection because the two cannot be told apart.
 */
function isTransientHttpStatus(status: number | undefined): boolean {
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, {once: true});
  });
}

/** Config fields the request builder may treat as defined; validated by the caller. */
type ValidatedIntentConfig = {
  baseURL: string;
  apiKey?: string;
  lightModel: string;
  protocol: 'chat_completions' | 'responses';
};

/**
 * One request in the pinned native protocol; truncation never starts another
 * call. A transient provider failure (5xx, 408/425/429, a thrown connection
 * error, a stream closed before its terminal event) is retried once inside the
 * same deadline, so the single semantic-review call
 * per captured context survives endpoint hiccups without ever extending the
 * run budget.
 */
export function runOpenAiIntentTransport(input: OpenAiIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    const {config} = input;
    if (!config.baseURL || !config.lightModel?.trim()
      || (input.purpose !== undefined && input.purpose !== 'classification' && input.purpose !== 'final_semantic')
      || (input.maxOutputTokens !== undefined
        && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0))
      || (config.protocol !== 'chat_completions' && config.protocol !== 'responses')) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const validated: ValidatedIntentConfig = {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      lightModel: config.lightModel,
      protocol: config.protocol,
    };
    for (let attempt = 1; ; attempt++) {
      // A thrown fetch error (connection reset, gateway drop) is as transient
      // as a 5xx; runIntentTransport's outer catch would otherwise swallow it
      // without retry or diagnostics. Cancellation still propagates.
      let result: IntentTransportResult;
      let transient: boolean;
      try {
        result = await dispatchOneRequest(input, validated, scope);
        transient = result.status === 'unavailable' && result.reason === 'provider_error'
          && isTransientHttpStatus(result.httpStatus);
      } catch (error) {
        if (scope.signal.aborted || input.signal?.aborted) throw error;
        result = {status: 'unavailable', reason: 'provider_error'};
        transient = true;
      }
      if (!transient || attempt > 1 || scope.remainingMs() < PROVIDER_ERROR_RETRY_MIN_REMAINING_MS) {
        // `attempts` is diagnostic only; attach it when a retry actually ran.
        return attempt > 1 ? {...result, attempts: attempt} : result;
      }
      await abortableDelay(PROVIDER_ERROR_RETRY_BACKOFF_MS, scope.signal);
      scope.throwIfInactive();
    }
  });
}

async function dispatchOneRequest(
  input: OpenAiIntentTransportInput,
  config: ValidatedIntentConfig,
  scope: IntentTransportScope,
): Promise<IntentTransportResult> {
  const endpoint = config.protocol === 'responses' ? 'responses' : 'chat/completions';
  const url = new URL(endpoint, config.baseURL.replace(/\/?$/, '/'));
  const purposeOptions = buildOpenAITextRequestPurposeOptions({requestUrl: url, protocol: config.protocol, purpose: input.purpose});
  try {
    input.observer?.reasoning?.('thinking' in purposeOptions || 'reasoning' in purposeOptions ? 'disabled' : 'provider_default');
  } catch { /* Observers never change the request. */ }
  const body = config.protocol === 'responses' ? {
    model: config.lightModel,
    instructions: input.systemPrompt,
    input: [{role: 'user', content: input.prompt}],
    tools: [], store: false, stream: true,
    ...purposeOptions,
    ...(input.maxOutputTokens !== undefined ? {max_output_tokens: input.maxOutputTokens} : {}),
  } : {
    model: config.lightModel,
    messages: [{role: 'system', content: input.systemPrompt}, {role: 'user', content: input.prompt}],
    temperature: 0, stream: true,
    ...purposeOptions,
    ...(input.maxOutputTokens !== undefined
      ? buildOpenAIChatCompletionsTokenLimit(config.lightModel, input.maxOutputTokens) : {}),
  };
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST', signal: scope.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? {Authorization: `Bearer ${config.apiKey}`} : {}),
    },
    body: JSON.stringify(body),
  });
  scope.throwIfInactive();
  if (!response.ok) return {status: 'unavailable', reason: 'provider_error',
    // Only 4xx/5xx carry triage value; anything else stays codeless so exact
    // result contracts are unchanged for ordinary gateways.
    ...(response.status >= 400 ? {httpStatus: response.status} : {})};
  let output: Record<string, unknown> | undefined;
  // A gateway that ignores `stream` still answers with one JSON body.
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    if (!response.body) return {status: 'unavailable', reason: 'invalid_response'};
    const onFirstOutput = input.observer?.firstOutput ? () => input.observer?.firstOutput?.() : undefined;
    const streamed = config.protocol === 'responses'
      ? await readResponsesStream(response.body, input.outputByteLimit, onFirstOutput)
      : await readChatCompletionStream(response.body, input.outputByteLimit, onFirstOutput);
    if (streamed.kind === 'unavailable') return {status: 'unavailable', reason: streamed.reason};
    output = streamed.body;
  } else {
    output = object(await response.json());
  }
  scope.throwIfInactive();
  if (!output || output.error != null) return {status: 'unavailable', reason: 'provider_error'};
  if (output.usage !== undefined) {
    try { input.observer?.usage?.(output.usage); } catch { /* Usage observers never change the reply. */ }
  }
  return config.protocol === 'responses' ? responsesResult(output, input) : chatResult(output, input);
}
