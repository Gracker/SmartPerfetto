// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const TRACE_PROCESSOR_QUERY_CANCELLED_CODE = 'TRACE_PROCESSOR_QUERY_CANCELLED';

export class TraceProcessorQueryCancelledError extends Error {
  readonly code = TRACE_PROCESSOR_QUERY_CANCELLED_CODE;

  constructor(message = 'Trace processor query cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function createTraceProcessorQueryCancelledError(reason?: unknown): TraceProcessorQueryCancelledError {
  if (reason instanceof TraceProcessorQueryCancelledError) return reason;
  if (reason instanceof Error && reason.message) {
    return new TraceProcessorQueryCancelledError(reason.message);
  }
  if (typeof reason === 'string' && reason.trim()) {
    return new TraceProcessorQueryCancelledError(reason);
  }
  return new TraceProcessorQueryCancelledError();
}

export function isTraceProcessorQueryCancelledError(error: unknown): error is TraceProcessorQueryCancelledError {
  const maybe = error as { name?: unknown; code?: unknown; message?: unknown };
  return error instanceof TraceProcessorQueryCancelledError
    || maybe?.code === TRACE_PROCESSOR_QUERY_CANCELLED_CODE
    || (
      maybe?.name === 'AbortError'
      && typeof maybe.message === 'string'
      && /cancel|abort/i.test(maybe.message)
    );
}

export function throwIfTraceProcessorQueryCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createTraceProcessorQueryCancelledError(signal.reason);
  }
}

export function rethrowIfTraceProcessorQueryCancelled(error: unknown): void {
  if (isTraceProcessorQueryCancelledError(error)) {
    throw error;
  }
}

export function raceWithTraceProcessorCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(createTraceProcessorQueryCancelledError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createTraceProcessorQueryCancelledError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
