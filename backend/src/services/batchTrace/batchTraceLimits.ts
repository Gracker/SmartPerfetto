// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { BatchTraceSurface } from './batchTraceTypes';
import { BatchTraceRequestError, invalidBatchTraceRequest } from './batchTraceRequestError';

export interface BatchTraceLimits {
  maxTraceCount: number;
  defaultConcurrency: number;
  maxCliConcurrency: number;
  maxApiConcurrency: number;
}

export interface BatchTraceApiExecutionLimits {
  maxSyncTraceCount: number;
  maxInFlightRuns: number;
}

export type BatchTraceApiRunAcquireResult =
  | {
    acquired: true;
    activeRuns: number;
    maxInFlightRuns: number;
    release: () => void;
  }
  | {
    acquired: false;
    activeRuns: number;
    maxInFlightRuns: number;
  };

const DEFAULT_LIMITS: BatchTraceLimits = {
  maxTraceCount: 100,
  defaultConcurrency: 2,
  maxCliConcurrency: 4,
  maxApiConcurrency: 2,
};

const DEFAULT_API_EXECUTION_LIMITS: BatchTraceApiExecutionLimits = {
  maxSyncTraceCount: 20,
  maxInFlightRuns: 2,
};

let activeApiBatchRuns = 0;

function parsePositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  errorCode: string,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${errorCode}:${name}`);
  }
  return parsed;
}

export function resolveBatchTraceLimits(env: NodeJS.ProcessEnv = process.env): BatchTraceLimits {
  const maxTraceCount = parsePositiveInteger(
    env,
    'SMARTPERFETTO_BATCH_TRACE_MAX_TRACES',
    DEFAULT_LIMITS.maxTraceCount,
    'invalid_batch_trace_limit',
  );
  const defaultConcurrency = parsePositiveInteger(
    env,
    'SMARTPERFETTO_BATCH_TRACE_DEFAULT_CONCURRENCY',
    DEFAULT_LIMITS.defaultConcurrency,
    'invalid_batch_trace_concurrency',
  );
  const maxCliConcurrency = parsePositiveInteger(
    env,
    'SMARTPERFETTO_BATCH_TRACE_MAX_CLI_CONCURRENCY',
    DEFAULT_LIMITS.maxCliConcurrency,
    'invalid_batch_trace_concurrency',
  );
  const maxApiConcurrency = parsePositiveInteger(
    env,
    'SMARTPERFETTO_BATCH_TRACE_MAX_API_CONCURRENCY',
    DEFAULT_LIMITS.maxApiConcurrency,
    'invalid_batch_trace_concurrency',
  );

  if (defaultConcurrency > Math.max(maxCliConcurrency, maxApiConcurrency)) {
    throw new Error('invalid_batch_trace_concurrency:SMARTPERFETTO_BATCH_TRACE_DEFAULT_CONCURRENCY');
  }

  return {
    maxTraceCount,
    defaultConcurrency,
    maxCliConcurrency,
    maxApiConcurrency,
  };
}

export function resolveBatchTraceApiExecutionLimits(
  env: NodeJS.ProcessEnv = process.env,
): BatchTraceApiExecutionLimits {
  return {
    maxSyncTraceCount: parsePositiveInteger(
      env,
      'SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES',
      DEFAULT_API_EXECUTION_LIMITS.maxSyncTraceCount,
      'invalid_batch_trace_limit',
    ),
    maxInFlightRuns: parsePositiveInteger(
      env,
      'SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS',
      DEFAULT_API_EXECUTION_LIMITS.maxInFlightRuns,
      'invalid_batch_trace_concurrency',
    ),
  };
}

export function maxConcurrencyForSurface(limits: BatchTraceLimits, surface: BatchTraceSurface): number {
  return surface === 'api' ? limits.maxApiConcurrency : limits.maxCliConcurrency;
}

export function resolveBatchTraceConcurrency(input: {
  requested?: number;
  surface: BatchTraceSurface;
  limits: BatchTraceLimits;
}): number {
  const requested = input.requested ?? input.limits.defaultConcurrency;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('invalid_batch_trace_concurrency:requested');
  }
  return Math.min(requested, maxConcurrencyForSurface(input.limits, input.surface));
}

export function assertBatchTraceCount(count: number, limit: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw invalidBatchTraceRequest('batch trace run requires at least one trace');
  }
  if (count > limit) {
    throw new BatchTraceRequestError('invalid_batch_trace_limit', `invalid_batch_trace_limit:trace_count:${count}>${limit}`);
  }
}

export function assertBatchTraceApiSyncTraceCount(
  count: number,
  limits: BatchTraceApiExecutionLimits,
): void {
  assertBatchTraceCount(count, limits.maxSyncTraceCount);
}

export function tryAcquireBatchTraceApiRun(
  limits: BatchTraceApiExecutionLimits,
): BatchTraceApiRunAcquireResult {
  if (activeApiBatchRuns >= limits.maxInFlightRuns) {
    return {
      acquired: false,
      activeRuns: activeApiBatchRuns,
      maxInFlightRuns: limits.maxInFlightRuns,
    };
  }
  activeApiBatchRuns += 1;
  let released = false;
  return {
    acquired: true,
    activeRuns: activeApiBatchRuns,
    maxInFlightRuns: limits.maxInFlightRuns,
    release: () => {
      if (released) return;
      released = true;
      activeApiBatchRuns = Math.max(0, activeApiBatchRuns - 1);
    },
  };
}
