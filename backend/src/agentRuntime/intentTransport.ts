// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  runtimeOutcomeFromError,
  startRuntimeModelCall,
  type RuntimeModelCallPurpose,
  type RuntimeModelCallStart,
  type RuntimePerformanceRecorder,
} from './runtimePerformance';
import type {OpenAITextRequestPurpose} from '../services/providerManager/openAiChatCompletionsCompat';

export interface IntentTransportInput {
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
  /** Absolute epoch milliseconds, shared by setup and the one provider call. */
  deadlineMs: number;
  outputByteLimit: number;
  /** Timing and usage observer for internal performance receipts; never changes the result. */
  observer?: IntentTransportObserver;
}

export interface IntentTransportObserver {
  /** Whether the request carried a reasoning control (`disabled`) or left the provider default. */
  reasoning?(policy: 'provider_default' | 'disabled'): void;
  /** The first provider output of the reply (text, reasoning or tool call). */
  firstOutput?(): void;
  /** Provider-reported usage object, exactly as returned. */
  usage?(usage: unknown): void;
}

export type IntentTransportUnavailableReason =
  | 'timeout'
  | 'provider_error'
  | 'invalid_configuration'
  | 'invalid_response'
  | 'tool_use'
  | 'incomplete_output'
  | 'output_limit';

export type IntentTransportResult =
  | {status: 'ok'; text: string; actualModel?: string; finishReason?: string; attempts?: number}
  | {status: 'unavailable'; reason: IntentTransportUnavailableReason; httpStatus?: number; attempts?: number};

/**
 * The one closed mapping from a run's model-call purpose to the provider
 * controls a no-tool text request may carry. An answer turn has none: it keeps
 * the provider's own reasoning policy.
 */
const OPENAI_TEXT_REQUEST_PURPOSES: Readonly<Record<RuntimeModelCallPurpose, OpenAITextRequestPurpose | undefined>> =
  Object.freeze({
    classification: 'classification',
    review: 'final_semantic',
    declaration_repair: 'declaration_repair',
    continuation: 'continuation',
    answer_turn: undefined,
  });

export function openAiTextRequestPurposeFor(purpose: RuntimeModelCallPurpose): OpenAITextRequestPurpose | undefined {
  return OPENAI_TEXT_REQUEST_PURPOSES[purpose];
}

/** Error codes Node and undici give a request that ran out of time rather than failed. */
const TIMEOUT_ERROR_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT',
]);

/**
 * Whether a thrown transport error says the request timed out. Reads only the
 * error's structured name and code along its bounded cause chain, never its
 * message: a fetch that waited past undici's headers timeout (a long
 * non-streamed reply, ~300 s) is a timeout, not a provider failure.
 */
export function intentTransportErrorReason(error: unknown): 'timeout' | 'provider_error' {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as {name?: unknown; code?: unknown; cause?: unknown};
    if (candidate.name === 'TimeoutError') return 'timeout';
    if (typeof candidate.code === 'string' && TIMEOUT_ERROR_CODES.has(candidate.code)) return 'timeout';
    current = candidate.cause;
  }
  return 'provider_error';
}

/**
 * Why a Claude-protocol SDK `result` message (Claude Agent SDK, Qoder) is not
 * a usable success. The CLI reports a provider API error as a result with
 * `is_error: true`, and an execution failure as `error_during_execution`:
 * both are provider failures, read from the structured fields only. A refusal
 * or any other shape stays an invalid response.
 */
export function sdkResultFailureReason(message: {subtype?: unknown; is_error?: unknown; stop_reason?: unknown}):
  IntentTransportUnavailableReason {
  if (message.stop_reason === 'refusal') return 'invalid_response';
  if (message.subtype === 'error_during_execution') return 'provider_error';
  if (message.subtype === 'success' && message.is_error === true) return 'provider_error';
  return 'invalid_response';
}

type Cleanup = (signal: AbortSignal) => unknown | Promise<unknown>;
export interface IntentTransportScope {
  signal: AbortSignal;
  remainingMs(): number;
  throwIfInactive(): void;
  /** Late resources get their own cleanup window, even after this call returned. */
  onCleanup(cleanup: Cleanup): void;
}

export const INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS = 1000;

function cancellationError(): Error {
  const error = new Error('Intent classification cancelled');
  error.name = 'AbortError';
  return error;
}

async function runCleanups(cleanups: Cleanup[]): Promise<void> {
  if (cleanups.length === 0) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS);
  });
  // Start every cleanup even when another resource refuses to settle.
  const attempts = cleanups.reverse().map(cleanup => Promise.resolve()
    .then(() => cleanup(controller.signal)).catch(() => undefined));
  try {
    await Promise.race([Promise.all(attempts), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One bounded native operation; raw provider errors never become classifier output. */
export async function runIntentTransport(
  input: IntentTransportInput,
  execute: (scope: IntentTransportScope) => Promise<IntentTransportResult>,
): Promise<IntentTransportResult> {
  if (input.signal?.aborted) throw cancellationError();
  if (!Number.isFinite(input.deadlineMs)
    || !Number.isSafeInteger(input.outputByteLimit) || input.outputByteLimit <= 0) {
    return {status: 'unavailable', reason: 'invalid_configuration'};
  }
  if (Date.now() >= input.deadlineMs) return {status: 'unavailable', reason: 'timeout'};

  const controller = new AbortController();
  const cleanups: Cleanup[] = [];
  let finished = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
  const onParentAbort = () => {
    controller.abort(cancellationError());
    rejectAbort(cancellationError());
  };
  const scope: IntentTransportScope = {
    signal: controller.signal,
    remainingMs: () => Math.max(0, input.deadlineMs - Date.now()),
    throwIfInactive: () => {
      if (finished || controller.signal.aborted || Date.now() >= input.deadlineMs) {
        throw cancellationError();
      }
    },
    onCleanup: cleanup => {
      if (finished) void runCleanups([cleanup]);
      else cleanups.push(cleanup);
    },
  };
  input.signal?.addEventListener('abort', onParentAbort, {once: true});
  // The parent may have aborted between the initial check and listener setup.
  if (input.signal?.aborted) onParentAbort();
  const timeout = new Promise<IntentTransportResult>(resolve => {
    const expire = () => {
      const remaining = scope.remainingMs();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        return;
      }
      timedOut = true;
      controller.abort();
      resolve({status: 'unavailable', reason: 'timeout'});
    };
    timer = setTimeout(expire, Math.min(scope.remainingMs(), 2_147_483_647));
  });
  let result: IntentTransportResult = {status: 'unavailable', reason: 'provider_error'};
  try {
    const operation = Promise.resolve().then(() => {
      scope.throwIfInactive();
      return execute(scope);
    });
    result = await Promise.race([operation, timeout, aborted]);
    if (timedOut || Date.now() >= input.deadlineMs) {
      result = {status: 'unavailable', reason: 'timeout'};
    }
  } catch (error) {
    result = {status: 'unavailable', reason: timedOut || Date.now() >= input.deadlineMs
      ? 'timeout' : intentTransportErrorReason(error)};
  } finally {
    finished = true;
    clearTimeout(timer);
    if (result.status !== 'ok') controller.abort();
    await runCleanups(cleanups);
    input.signal?.removeEventListener('abort', onParentAbort);
  }
  // A cancellation during resource cleanup still belongs to the parent run.
  if (input.signal?.aborted) throw cancellationError();
  return result;
}

export function intentTransportTextResult(
  text: string,
  input: Pick<IntentTransportInput, 'outputByteLimit'>,
  receipt: {actualModel?: string; finishReason?: string} = {},
): IntentTransportResult {
  if (!text.trim()) return {status: 'unavailable', reason: 'invalid_response'};
  if (Buffer.byteLength(text, 'utf8') > input.outputByteLimit) {
    return {status: 'unavailable', reason: 'output_limit'};
  }
  return {status: 'ok', text, ...receipt};
}

/**
 * Dispatch one transport request inside an internal model-call record. Without
 * a recorder the request is passed through unchanged; with one, the only
 * addition is an observer that never changes the result.
 */
export async function dispatchWithModelCallRecord(
  recorder: RuntimePerformanceRecorder | undefined,
  call: RuntimeModelCallStart,
  input: IntentTransportInput,
  dispatch: (input: IntentTransportInput) => Promise<IntentTransportResult>,
): Promise<IntentTransportResult> {
  if (!recorder) return dispatch(input);
  const span = startRuntimeModelCall(recorder, call);
  let reasoning: 'provider_default' | 'disabled' | undefined;
  let usage: unknown;
  const observer: IntentTransportObserver = {
    firstOutput: () => span.recordFirstOutput(),
    usage: value => { usage = value; },
    reasoning: policy => { reasoning = policy; },
  };
  try {
    const result = await dispatch({...input, observer});
    span.end({outcome: result.status === 'ok' ? 'ok' : input.signal?.aborted ? 'cancelled' : 'error',
      ...(result.status === 'ok' && result.actualModel ? {model: result.actualModel} : {}),
      ...(reasoning ? {reasoning} : {}), usage});
    return result;
  } catch (error) {
    span.end({outcome: runtimeOutcomeFromError(error, input.signal), ...(reasoning ? {reasoning} : {}), usage});
    throw error;
  }
}
