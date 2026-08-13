// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const DEFAULT_FULL_REQUEST_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS = 2_000;
export const DEFAULT_ACCUMULATED_ANSWER_MAX_CHARS = 256 * 1024;
export const DEFAULT_OPENAI_HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export type RuntimeTimeoutKind = 'request' | 'stream_idle';

export function resolveFullRequestTimeoutMs(
  perTurnMs: number,
  maxTurns: number,
  hardLimitMs: number,
): number {
  return Math.min(perTurnMs * maxTurns, hardLimitMs);
}

function stringifyExternalValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[unserializable tool result]';
  }
}

export function summarizeExternalToolResult(
  value: unknown,
  maxChars = DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS,
): string {
  const serialized = stringifyExternalValue(value);
  if (serialized.length <= maxChars) return serialized;
  const marker = `\n[truncated external tool result; originalChars=${serialized.length}]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${serialized.slice(0, maxChars - marker.length)}${marker}`;
}

export function appendBoundedText(input: {
  current: string;
  chunk: string;
  maxChars?: number;
  alreadyTruncated?: boolean;
}): {text: string; truncated: boolean} {
  const maxChars = input.maxChars ?? DEFAULT_ACCUMULATED_ANSWER_MAX_CHARS;
  if (!input.chunk || input.alreadyTruncated) {
    return {text: input.current, truncated: input.alreadyTruncated === true};
  }
  if (input.current.length + input.chunk.length <= maxChars) {
    return {text: input.current + input.chunk, truncated: false};
  }
  const marker = '\n[truncated accumulated answer]';
  const keepChars = Math.max(0, maxChars - marker.length);
  return {
    text: `${input.current}${input.chunk}`.slice(0, keepChars) + marker.slice(0, maxChars),
    truncated: true,
  };
}

export function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface ResettableRuntimeTimeout {
  readonly promise: Promise<never>;
  reset(): void;
  clear(): void;
}

export function createResettableRuntimeTimeout(input: {
  timeoutMs: number;
  message: string;
  onTimeout: () => void;
}): ResettableRuntimeTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  let settled = false;
  const promise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    if (settled) return;
    clear();
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = undefined;
      input.onTimeout();
      rejectTimeout?.(new Error(input.message));
    }, input.timeoutMs);
  };
  reset();
  return {
    promise,
    reset,
    clear: () => {
      settled = true;
      clear();
    },
  };
}
