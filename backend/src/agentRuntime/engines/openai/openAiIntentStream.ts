// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isPlainObject} from '../../../utils/llmJson';

/**
 * Streamed replies for the one-shot intent and final-semantic requests.
 *
 * A non-streamed reply sends its headers only after generation ends, and a
 * reasoning model can think for longer than fetch's default five-minute
 * headers timeout: a measured GLM semantic review first emitted answer text at
 * 496 s. Streaming keeps bytes flowing, so the run deadline, not a transport
 * default, decides when the request stops. Each reply is folded back into the
 * non-streamed body shape, role, tool calls and refusal included, and judged by
 * the same validators; what only a stream can express (a second choice, text
 * after the finish, two finish reasons) is kept as a protocol error rather than
 * normalized away.
 */

/** Bound on one undelivered event, including every buffered data line. */
export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
/**
 * After a terminal marker, how long in total to keep reading what follows. The
 * trailing usage chunk and `[DONE]` arrive back to back, so this still catches
 * text after the finish, yet a server that omits `[DONE]` and keeps the
 * connection alive cannot hold a complete answer until the run deadline.
 */
export const SSE_DRAIN_MS = 1000;

/** `drain` marks a terminal event: read on only while more arrives within the drain window. */
export type SseDataVerdict = 'continue' | 'stop' | 'drain';

export type StreamOutcome =
  | {kind: 'body'; body: Record<string, unknown>}
  | {kind: 'unavailable'; reason: 'provider_error' | 'invalid_response' | 'output_limit'};

/** A stream that closed before its terminal event: a dropped connection, retried like one. */
export class IntentStreamTruncatedError extends Error {
  constructor() {
    super('intent stream ended before its terminal event');
    this.name = 'IntentStreamTruncatedError';
  }
}

const INVALID: StreamOutcome = {kind: 'unavailable', reason: 'invalid_response'};

function parseEvent(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return isPlainObject(value) ? value : undefined;
  } catch { return undefined; }
}

/**
 * WHATWG event-stream framing: CR, LF or CRLF line ends, multi-line data joined
 * by LF, comment lines skipped, UTF-8 (and a leading BOM) decoded across chunk
 * boundaries, an unterminated trailing event discarded. Returns false when one
 * event outgrows `maxEventBytes`.
 */
export async function readSseData(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => SseDataVerdict,
  maxEventBytes = MAX_SSE_EVENT_BYTES,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let pendingBytes = 0;
  let data: string[] = [];
  let eventBytes = 0;
  // Fixed when the terminal arrives, so heartbeats cannot renew it.
  let drainUntil: number | undefined;
  // A CR ends its line at once; an LF opening the next chunk completes that CRLF.
  let afterCr = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drainExpired = Symbol('drain');
  /** True when reading should stop. */
  const takeLine = (line: string): boolean => {
    if (line === '') {
      const dispatch = data.length > 0 ? data.join('\n') : undefined;
      data = []; eventBytes = 0;
      if (dispatch === undefined) return false;
      const verdict = onData(dispatch);
      if (verdict === 'drain' && drainUntil === undefined) drainUntil = Date.now() + SSE_DRAIN_MS;
      return verdict === 'stop';
    }
    if (line.startsWith(':')) return false;
    const colon = line.indexOf(':');
    if ((colon < 0 ? line : line.slice(0, colon)) !== 'data') return false;
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    eventBytes += Buffer.byteLength(value, 'utf8') + 1;
    data.push(value);
    return false;
  };
  try {
    for (;;) {
      const remaining = drainUntil === undefined ? undefined : drainUntil - Date.now();
      if (remaining !== undefined && remaining <= 0) return true;
      const next = remaining === undefined ? await reader.read() : await Promise.race([reader.read(),
        new Promise<typeof drainExpired>(resolve => {drainTimer = setTimeout(() => resolve(drainExpired), remaining);})]);
      clearTimeout(drainTimer);
      if (next === drainExpired) return true;
      const {done, value} = next;
      let text = done ? decoder.decode() : decoder.decode(value, {stream: true});
      if (afterCr && text.length > 0) {
        if (text.startsWith('\n')) text = text.slice(1);
        afterCr = false;
      }
      // Earlier text holds no line end, so scan only what just arrived.
      const lineEnd = /\r\n|\r|\n/g;
      lineEnd.lastIndex = pending.length;
      pending += text;
      pendingBytes += Buffer.byteLength(text, 'utf8');
      let consumed = 0;
      let match: RegExpExecArray | null;
      while ((match = lineEnd.exec(pending)) !== null) {
        const line = pending.slice(consumed, match.index);
        consumed = match.index + match[0].length;
        afterCr = match[0] === '\r' && consumed === pending.length;
        if (takeLine(line)) return true;
        if (eventBytes > maxEventBytes) return false;
      }
      if (consumed > 0) {
        pending = pending.slice(consumed);
        pendingBytes = Buffer.byteLength(pending, 'utf8');
      }
      if (pendingBytes + eventBytes > maxEventBytes) return false;
      if (done) return true;
    }
  } finally {
    clearTimeout(drainTimer);
    // Never leave an open connection behind: the server may keep it alive after its terminal event.
    void reader.cancel().catch(() => undefined);
  }
}

/** Called once, at the first provider output (text, reasoning or tool call); timing only. */
export type IntentStreamFirstOutputObserver = () => void;

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** Fold a streamed Chat Completion into the non-streamed body shape. */
export async function readChatCompletionStream(body: ReadableStream<Uint8Array>, outputByteLimit: number,
  onFirstOutput?: IntentStreamFirstOutputObserver): Promise<StreamOutcome> {
  const message: {role: unknown; content: string; refusal: string; tool_calls: unknown[]; function_call?: unknown} =
    {role: 'assistant', content: '', refusal: '', tool_calls: []};
  let model: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let sawOutput = false;
  let contentBytes = 0;
  let finishReason: string | undefined;
  let outcome: StreamOutcome | undefined;
  let sawDone = false;
  const invalid = (): SseDataVerdict => {outcome = INVALID; return 'stop';};
  const framed = await readSseData(body, data => {
    if (data === '[DONE]') {sawDone = true; return 'stop';}
    const chunk = parseEvent(data);
    if (!chunk) return invalid();
    if (chunk.error != null) {outcome = {kind: 'unavailable', reason: 'provider_error'}; return 'stop';}
    if (typeof chunk.model === 'string' && model === undefined) model = chunk.model;
    if (isPlainObject(chunk.usage)) usage = chunk.usage;
    const verdict = (): SseDataVerdict => finishReason === undefined ? 'continue' : 'drain';
    // A usage-only chunk omits choices or carries an empty list; two choices cannot become one answer.
    if (chunk.choices === undefined || (Array.isArray(chunk.choices) && chunk.choices.length === 0)) return verdict();
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) return invalid();
    const choice = chunk.choices[0];
    if (!isPlainObject(choice) || (choice.index !== undefined && choice.index !== 0)) return invalid();
    const delta = choice.delta ?? {};
    if (!isPlainObject(delta)) return invalid();
    if (!sawOutput && (nonEmptyString(delta.content) || nonEmptyString(delta.reasoning_content) ||
      nonEmptyString(delta.reasoning) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))) {
      sawOutput = true;
      try { onFirstOutput?.(); } catch { /* Timing observers never change the reply. */ }
    }
    if (delta.role != null && message.role === 'assistant') message.role = delta.role;
    if (delta.content != null) {
      if (typeof delta.content !== 'string' || (delta.content && finishReason !== undefined)) return invalid();
      message.content += delta.content;
      contentBytes += Buffer.byteLength(delta.content, 'utf8');
      if (contentBytes > outputByteLimit) {outcome = {kind: 'unavailable', reason: 'output_limit'}; return 'stop';}
    }
    // Only their presence is judged, so keep one marker rather than an unbounded accumulation.
    const calls = delta.tool_calls;
    if (calls != null && (!Array.isArray(calls) || calls.length > 0) && !message.tool_calls.length) message.tool_calls.push(true);
    if (delta.function_call != null) message.function_call ??= delta.function_call;
    if (delta.refusal != null) {
      if (typeof delta.refusal !== 'string') return invalid();
      message.refusal ||= delta.refusal;
    }
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== 'string' || (finishReason !== undefined && finishReason !== choice.finish_reason)) {
        return invalid();
      }
      finishReason = choice.finish_reason;
    }
    return verdict();
  });
  if (!framed) return INVALID;
  if (outcome) return outcome;
  // Gateways differ on sending `[DONE]`; a finish reason or `[DONE]` both close the reply.
  if (!sawDone && finishReason === undefined) throw new IntentStreamTruncatedError();
  return {kind: 'body', body: {...(model !== undefined ? {model} : {}),
    choices: [{message, ...(finishReason !== undefined ? {finish_reason: finishReason} : {})}],
    ...(usage !== undefined ? {usage} : {})}};
}

const RESPONSES_TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/** Take the complete response a Responses stream ends with, bounding answer text as it arrives. */
export async function readResponsesStream(body: ReadableStream<Uint8Array>, outputByteLimit: number,
  onFirstOutput?: IntentStreamFirstOutputObserver): Promise<StreamOutcome> {
  const commentary = new Set<string>();
  let answerBytes = 0;
  let outcome: StreamOutcome | undefined;
  let sawOutput = false;
  const framed = await readSseData(body, data => {
    const event = parseEvent(data);
    if (!event || typeof event.type !== 'string') {outcome = INVALID; return 'stop';}
    if (!sawOutput && event.type.endsWith('.delta') && nonEmptyString(event.delta)) {
      sawOutput = true;
      try { onFirstOutput?.(); } catch { /* Timing observers never change the reply. */ }
    }
    if (event.type === 'error') {outcome = {kind: 'unavailable', reason: 'provider_error'}; return 'stop';}
    if (event.type === 'response.output_item.added') {
      const item = event.item;
      if (isPlainObject(item) && item.type === 'message' && item.phase === 'commentary' && typeof item.id === 'string') commentary.add(item.id);
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (!commentary.has(String(event.item_id))) {
        answerBytes += Buffer.byteLength(event.delta, 'utf8');
        if (answerBytes > outputByteLimit) {outcome = {kind: 'unavailable', reason: 'output_limit'}; return 'stop';}
      }
    } else if (RESPONSES_TERMINAL_EVENTS.has(event.type)) {
      outcome = isPlainObject(event.response) ? {kind: 'body', body: event.response} : INVALID;
      return 'stop';
    }
    return 'continue';
  });
  if (!framed) return INVALID;
  if (!outcome) throw new IntentStreamTruncatedError();
  return outcome;
}
