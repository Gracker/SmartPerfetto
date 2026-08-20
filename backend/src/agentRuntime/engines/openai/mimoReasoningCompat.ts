// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { TextDecoder, TextEncoder } from 'util';
import type { OpenAIAgentConfig } from './openAiConfig';

type JsonRecord = Record<string, any>;
type FetchLike = typeof fetch;
type FetchInput = Parameters<FetchLike>[0];
type FetchInit = Parameters<FetchLike>[1];
type FetchResult = Awaited<ReturnType<FetchLike>>;
type RequestSummary = {
  model?: unknown;
  stream?: unknown;
  messages?: Array<Record<string, unknown>>;
  toolCount?: number;
};

const CHAT_COMPLETIONS_PATH = /\/chat\/completions(?:[?#]|$)/;
const MIMO_BASE_URL_PATTERN = /xiaomimimo\.com/i;
const MIMO_MODEL_PATTERN = /\bmimo-v/i;
const DEEPSEEK_BASE_URL_PATTERN = /api\.deepseek\.com/i;
const DEEPSEEK_MODEL_PATTERN = /\bdeepseek-/i;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasToolCalls(message: JsonRecord): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function hasContent(message: JsonRecord): boolean {
  const content = message.content;
  return Array.isArray(content)
    ? content.length > 0
    : content !== undefined && content !== null && content !== '';
}

function mergePreviousAssistantMessage(previous: JsonRecord, message: JsonRecord): boolean {
  let merged = false;

  if (!hasNonEmptyString(message.reasoning_content) && hasNonEmptyString(previous.reasoning_content)) {
    message.reasoning_content = previous.reasoning_content;
    merged = true;
  }

  if (!hasContent(message) && hasContent(previous)) {
    message.content = previous.content;
    merged = true;
  } else if (typeof previous.content === 'string' && typeof message.content === 'string') {
    message.content = `${previous.content}\n${message.content}`;
    merged = true;
  }

  return merged || !hasContent(previous);
}

function summarizeContent(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') return { contentType: 'string', contentLength: content.length };
  if (Array.isArray(content)) return { contentType: 'array', contentParts: content.length };
  if (content === null) return { contentType: 'null' };
  return { contentType: typeof content };
}

function summarizeMimoChatRequestPayload(payload: unknown): RequestSummary | undefined {
  if (!isRecord(payload)) return undefined;
  return {
    model: payload.model,
    stream: payload.stream,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    messages: Array.isArray(payload.messages)
      ? payload.messages.map((message, index) => {
          if (!isRecord(message)) return { index, type: typeof message };
          return {
            index,
            role: message.role,
            ...summarizeContent(message.content),
            toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
            hasReasoning: hasNonEmptyString(message.reasoning),
            reasoningLength: hasNonEmptyString(message.reasoning) ? message.reasoning.length : 0,
            hasReasoningContent: hasNonEmptyString(message.reasoning_content),
            reasoningContentLength: hasNonEmptyString(message.reasoning_content)
              ? message.reasoning_content.length
              : 0,
            toolCallId: typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined,
          };
        })
      : undefined,
  };
}

function getRequestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const maybeUrl = (input as { url?: unknown })?.url;
  return typeof maybeUrl === 'string' ? maybeUrl : '';
}

function headersWithoutContentLength(headers: unknown): unknown {
  if (!headers) return headers;
  const HeadersCtor = (globalThis as any).Headers;
  if (!HeadersCtor) return headers;
  const copied = new HeadersCtor(headers as any);
  copied.delete('content-length');
  return copied;
}

function isRequestInput(input: FetchInput): input is Request {
  const RequestCtor = (globalThis as any).Request;
  return !!RequestCtor && input instanceof RequestCtor;
}

export function shouldUseMimoReasoningContentCompat(
  config: Pick<OpenAIAgentConfig, 'protocol' | 'baseURL' | 'model' | 'lightModel'>,
): boolean {
  if (config.protocol !== 'chat_completions') return false;
  const baseURL = config.baseURL || '';
  const models = `${config.model || ''} ${config.lightModel || ''}`;
  return MIMO_BASE_URL_PATTERN.test(baseURL)
    || MIMO_MODEL_PATTERN.test(models)
    || DEEPSEEK_BASE_URL_PATTERN.test(baseURL)
    || DEEPSEEK_MODEL_PATTERN.test(models);
}

export function normalizeMimoChatRequestPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return false;
  let changed = false;
  const normalizedMessages: unknown[] = [];

  for (const message of payload.messages) {
    if (!isRecord(message) || message.role !== 'assistant') {
      normalizedMessages.push(message);
      continue;
    }

    const reasoning = hasNonEmptyString(message.reasoning)
      ? message.reasoning
      : hasNonEmptyString(message.reasoning_content)
        ? message.reasoning_content
        : undefined;
    if (message.reasoning_content !== reasoning) {
      if (reasoning) {
        message.reasoning_content = reasoning;
        changed = true;
      }
    }
    if ('reasoning' in message) {
      delete message.reasoning;
      changed = true;
    }

    const previous = normalizedMessages[normalizedMessages.length - 1];
    if (isRecord(previous) && previous.role === 'assistant' && !hasToolCalls(previous)) {
      if (mergePreviousAssistantMessage(previous, message)) {
        normalizedMessages.pop();
        changed = true;
      }
    }

    normalizedMessages.push(message);
  }

  if (normalizedMessages.length !== payload.messages.length) {
    payload.messages = normalizedMessages;
    changed = true;
  }

  return changed;
}

export function normalizeMimoChatCompletionPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  let changed = false;

  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    for (const key of ['delta', 'message'] as const) {
      const message = choice[key];
      if (!isRecord(message)) continue;
      if (hasNonEmptyString(message.reasoning_content) && message.reasoning !== message.reasoning_content) {
        message.reasoning = message.reasoning_content;
        changed = true;
      }
    }
  }

  return changed;
}

function decodeRequestBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return undefined;
}

function normalizeRequestBody(body: unknown): { body: unknown; changed: boolean; summary?: RequestSummary } {
  const text = decodeRequestBody(body);
  if (text === undefined) return { body, changed: false };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return { body, changed: false };

  try {
    const payload = JSON.parse(text);
    const changed = normalizeMimoChatRequestPayload(payload);
    const summary = summarizeMimoChatRequestPayload(payload);
    return changed
      ? { body: JSON.stringify(payload), changed, summary }
      : { body, changed: false, summary };
  } catch {
    return { body, changed: false };
  }
}

async function normalizeRequestInputBody(
  input: Request,
): Promise<{ input: FetchInput; changed: boolean; summary?: RequestSummary }> {
  if (input.bodyUsed) return { input, changed: false };

  try {
    const body = await input.clone().text();
    const normalized = normalizeRequestBody(body);
    if (!normalized.changed) return { input, changed: false, summary: normalized.summary };

    const RequestCtor = (globalThis as any).Request;
    return {
      input: new RequestCtor(input, {
        body: normalized.body as any,
        headers: headersWithoutContentLength(input.headers) as any,
      }),
      changed: true,
      summary: normalized.summary,
    };
  } catch {
    return { input, changed: false };
  }
}

async function normalizeFetchRequest(
  input: FetchInput,
  init: FetchInit,
): Promise<{ input: FetchInput; init: FetchInit; isChatCompletions: boolean; summary?: RequestSummary }> {
  const isChatCompletions = CHAT_COMPLETIONS_PATH.test(getRequestUrl(input));
  if (!isChatCompletions) return { input, init, isChatCompletions };

  const normalized = normalizeRequestBody(init?.body);
  if (!normalized.changed) {
    if (isRequestInput(input) && !init?.body) {
      const normalizedInput = await normalizeRequestInputBody(input);
      if (normalizedInput.changed) {
        return {
          input: normalizedInput.input,
          init: init
            ? {
                ...init,
                headers: headersWithoutContentLength(init.headers) as any,
              }
            : init,
          isChatCompletions,
          summary: normalizedInput.summary,
        };
      }
    }
    return { input, init, isChatCompletions, summary: normalized.summary };
  }

  return {
    input,
    init: {
      ...init,
      body: normalized.body as any,
      headers: headersWithoutContentLength(init?.headers) as any,
    },
    isChatCompletions,
    summary: normalized.summary,
  };
}

function transformSseLine(line: string): string {
  if (!line.startsWith('data:')) return line;
  const prefixMatch = line.match(/^data:\s*/);
  const prefix = prefixMatch?.[0] ?? 'data: ';
  const data = line.slice(prefix.length);
  if (!data || data.trim() === '[DONE]') return line;

  try {
    const payload = JSON.parse(data);
    return normalizeMimoChatCompletionPayload(payload)
      ? `${prefix}${JSON.stringify(payload)}`
      : line;
  } catch {
    return line;
  }
}

export function normalizeMimoSseText(text: string): string {
  return text
    .split('\n')
    .map((line) => transformSseLine(line))
    .join('\n');
}

function createNormalizedSseBody(body: any): any {
  const TransformStreamCtor = (globalThis as any).TransformStream;
  if (!body || !TransformStreamCtor) return undefined;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';

  return body.pipeThrough(new TransformStreamCtor({
    transform(chunk: Uint8Array, controller: any) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(`${normalizeMimoSseText(lines.join('\n'))}\n`));
      }
    },
    flush(controller: any) {
      pending += decoder.decode();
      if (pending) {
        controller.enqueue(encoder.encode(normalizeMimoSseText(pending)));
      }
    },
  }));
}

async function normalizeFetchResponse(response: FetchResult): Promise<FetchResult> {
  const contentType = response.headers.get('content-type') || '';
  const ResponseCtor = (globalThis as any).Response;
  if (!ResponseCtor) return response;

  const headers = headersWithoutContentLength(response.headers) as any;
  if (contentType.includes('text/event-stream')) {
    const body = createNormalizedSseBody(response.body);
    return body
      ? new ResponseCtor(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      : response;
  }

  if (!contentType.includes('application/json')) return response;

  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    const changed = normalizeMimoChatCompletionPayload(payload);
    return new ResponseCtor(changed ? JSON.stringify(payload) : text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new ResponseCtor(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export function createMimoReasoningContentFetch(baseFetch: FetchLike = fetch): FetchLike {
  return (async (input: FetchInput, init?: FetchInit): Promise<FetchResult> => {
    const normalizedRequest = await normalizeFetchRequest(input, init);
    const response = await baseFetch(normalizedRequest.input, normalizedRequest.init);
    if (normalizedRequest.isChatCompletions && response.status >= 400) {
      let responsePreview: string | undefined;
      try {
        responsePreview = (await response.clone().text()).slice(0, 500);
      } catch {
        responsePreview = undefined;
      }
      console.warn('[ReasoningContentCompat] Chat completions request failed', {
        status: response.status,
        statusText: response.statusText,
        request: normalizedRequest.summary,
        responsePreview,
      });
    }
    return normalizedRequest.isChatCompletions
      ? normalizeFetchResponse(response)
      : response;
  }) as FetchLike;
}
