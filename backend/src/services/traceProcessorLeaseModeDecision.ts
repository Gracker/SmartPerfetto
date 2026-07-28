// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  TraceProcessorHolderType,
  TraceProcessorLeaseMode,
  TraceProcessorLeaseRecord,
} from './traceProcessorLeaseStore';
import type {
  TraceProcessorRamBudgetStats,
} from './traceProcessorRamBudget';
import type {
  TraceProcessorRuntimeStats,
} from './workingTraceProcessor';

export const TP_SLOW_QUERY_MS_ENV = 'SMARTPERFETTO_TP_SLOW_QUERY_MS';
export const TP_SHARED_QUEUE_THRESHOLD_ENV = 'SMARTPERFETTO_TP_SHARED_QUEUE_THRESHOLD';
export const TP_FRONTEND_ACTIVE_MS_ENV = 'SMARTPERFETTO_TP_FRONTEND_ACTIVE_MS';

const DEFAULT_SLOW_QUERY_MS = 5_000;
const DEFAULT_SHARED_QUEUE_THRESHOLD = 5;
const DEFAULT_FRONTEND_ACTIVE_MS = 30_000;

export type TraceProcessorLeaseModeDecisionReason =
  | 'frontend_interactive'
  | 'manual_register'
  | 'requested_shared'
  | 'requested_isolated'
  | 'quota_low_shared'
  | 'report_generation'
  | 'full_analysis'
  | 'heavy_skill'
  | 'estimated_slow_query'
  | 'shared_queue_backlog'
  | 'frontend_active_long_task'
  | 'fast_mode'
  | 'default_shared';

export interface TraceProcessorLeaseModeSignals {
  holderType: TraceProcessorHolderType;
  analysisMode?: string;
  requestedMode?: TraceProcessorLeaseMode;
  estimatedSqlMs?: number;
  heavySkill: boolean;
  longTask: boolean;
  sharedQueueLength: number;
  sharedQueueThreshold: number;
  frontendActive: boolean;
  frontendActiveWithinMs: number;
  slowQueryThresholdMs: number;
  quotaAvailableForNewLeaseBytes?: number;
  estimatedNewLeaseRssBytes?: number;
}

export interface TraceProcessorLeaseModeDecision {
  mode: TraceProcessorLeaseMode;
  reason: TraceProcessorLeaseModeDecisionReason;
  signals: TraceProcessorLeaseModeSignals;
}

export interface TraceProcessorLeaseModeDecisionInput {
  holderType: TraceProcessorHolderType;
  requestedMode?: TraceProcessorLeaseMode;
  analysisMode?: unknown;
  estimatedSqlMs?: unknown;
  heavySkill?: boolean;
  longTask?: boolean;
  sharedQueueLength?: number;
  frontendActive?: boolean;
  quotaAvailableForNewLeaseBytes?: number;
  estimatedNewLeaseRssBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TraceProcessorLeaseModeRuntimeInput extends Omit<
  TraceProcessorLeaseModeDecisionInput,
  'sharedQueueLength' | 'frontendActive' | 'quotaAvailableForNewLeaseBytes'
> {
  traceId: string;
  leases?: TraceProcessorLeaseRecord[];
  processors?: TraceProcessorRuntimeStats[];
  ramBudget?: TraceProcessorRamBudgetStats;
  now?: number;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeAnalysisMode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function resolveSlowQueryThresholdMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveNumber(env[TP_SLOW_QUERY_MS_ENV]) ?? DEFAULT_SLOW_QUERY_MS;
}

function resolveSharedQueueThreshold(env: NodeJS.ProcessEnv): number {
  return parsePositiveNumber(env[TP_SHARED_QUEUE_THRESHOLD_ENV]) ?? DEFAULT_SHARED_QUEUE_THRESHOLD;
}

function resolveFrontendActiveMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveNumber(env[TP_FRONTEND_ACTIVE_MS_ENV]) ?? DEFAULT_FRONTEND_ACTIVE_MS;
}

export function sharedQueueLengthForTrace(
  traceId: string,
  processors: TraceProcessorRuntimeStats[] = [],
): number {
  return processors
    .filter(processor => processor.traceId === traceId && (processor.leaseMode ?? 'shared') === 'shared')
    .reduce((sum, processor) => {
      const worker = processor.sqlWorker;
      if (!worker) return sum;
      return sum + worker.queuedP0 + worker.queuedP1 + worker.queuedP2;
    }, 0);
}

export function hasRecentFrontendHolder(
  leases: TraceProcessorLeaseRecord[] = [],
  now = Date.now(),
  activeWithinMs = DEFAULT_FRONTEND_ACTIVE_MS,
): boolean {
  const cutoff = now - activeWithinMs;
  return leases.some(lease => lease.mode === 'shared' && lease.holders.some(holder => {
    return holder.holderType === 'frontend_http_rpc'
      && holder.heartbeatAt !== null
      && holder.heartbeatAt >= cutoff;
  }));
}

export function buildTraceProcessorLeaseModeDecision(
  input: TraceProcessorLeaseModeRuntimeInput,
): TraceProcessorLeaseModeDecision {
  const env = input.env ?? process.env;
  const frontendActiveWithinMs = resolveFrontendActiveMs(env);
  const sharedQueueLength = sharedQueueLengthForTrace(input.traceId, input.processors);
  const frontendActive = hasRecentFrontendHolder(input.leases, input.now, frontendActiveWithinMs);
  return decideTraceProcessorLeaseMode({
    ...input,
    sharedQueueLength,
    frontendActive,
    quotaAvailableForNewLeaseBytes: input.ramBudget?.availableForNewLeaseBytes,
    env,
  });
}

export function decideTraceProcessorLeaseMode(
  input: TraceProcessorLeaseModeDecisionInput,
): TraceProcessorLeaseModeDecision {
  const env = input.env ?? process.env;
  const analysisMode = normalizeAnalysisMode(input.analysisMode);
  const estimatedSqlMs = parseNonNegativeNumber(input.estimatedSqlMs);
  const slowQueryThresholdMs = resolveSlowQueryThresholdMs(env);
  const sharedQueueThreshold = resolveSharedQueueThreshold(env);
  const frontendActiveWithinMs = resolveFrontendActiveMs(env);
  const sharedQueueLength = Math.max(0, Math.floor(input.sharedQueueLength ?? 0));
  const heavySkill = input.heavySkill === true;
  const fullAnalysis = analysisMode === 'full';
  const fastMode = analysisMode === 'fast';
  const estimatedSlowQuery =
    estimatedSqlMs !== undefined && estimatedSqlMs > slowQueryThresholdMs;
  const longTask = input.longTask === true ||
    input.holderType === 'report_generation' ||
    fullAnalysis ||
    heavySkill ||
    estimatedSlowQuery;
  const quotaAvailableForNewLeaseBytes = parseNonNegativeNumber(input.quotaAvailableForNewLeaseBytes);
  const estimatedNewLeaseRssBytes = parseNonNegativeNumber(input.estimatedNewLeaseRssBytes);
  const quotaLow = quotaAvailableForNewLeaseBytes !== undefined &&
    estimatedNewLeaseRssBytes !== undefined &&
    estimatedNewLeaseRssBytes > quotaAvailableForNewLeaseBytes;

  const signals: TraceProcessorLeaseModeSignals = {
    holderType: input.holderType,
    ...(analysisMode ? { analysisMode } : {}),
    ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
    ...(estimatedSqlMs !== undefined ? { estimatedSqlMs } : {}),
    heavySkill,
    longTask,
    sharedQueueLength,
    sharedQueueThreshold,
    frontendActive: input.frontendActive === true,
    frontendActiveWithinMs,
    slowQueryThresholdMs,
    ...(quotaAvailableForNewLeaseBytes !== undefined ? { quotaAvailableForNewLeaseBytes } : {}),
    ...(estimatedNewLeaseRssBytes !== undefined ? { estimatedNewLeaseRssBytes } : {}),
  };

  // Perfetto HTTP RPC sequence numbers are process-global. An explicitly
  // isolated frontend viewer must never be folded back onto the shared
  // interactive processor, otherwise two UI clients can corrupt each other's
  // RPC sequence.
  if (
    input.holderType === 'frontend_http_rpc' &&
    input.requestedMode === 'isolated'
  ) {
    return { mode: 'isolated', reason: 'requested_isolated', signals };
  }
  if (input.holderType === 'frontend_http_rpc') {
    return { mode: 'shared', reason: 'frontend_interactive', signals };
  }
  if (input.holderType === 'manual_register') {
    return { mode: 'shared', reason: 'manual_register', signals };
  }
  if (input.requestedMode === 'shared') {
    return { mode: 'shared', reason: 'requested_shared', signals };
  }
  if (quotaLow) {
    return { mode: 'shared', reason: 'quota_low_shared', signals };
  }
  if (input.requestedMode === 'isolated') {
    return { mode: 'isolated', reason: 'requested_isolated', signals };
  }
  if (input.holderType === 'report_generation') {
    return { mode: 'isolated', reason: 'report_generation', signals };
  }
  if (fullAnalysis) {
    return { mode: 'isolated', reason: 'full_analysis', signals };
  }
  if (heavySkill) {
    return { mode: 'isolated', reason: 'heavy_skill', signals };
  }
  if (estimatedSlowQuery) {
    return { mode: 'isolated', reason: 'estimated_slow_query', signals };
  }
  if (sharedQueueLength > sharedQueueThreshold) {
    return { mode: 'isolated', reason: 'shared_queue_backlog', signals };
  }
  if (input.frontendActive === true && longTask) {
    return { mode: 'isolated', reason: 'frontend_active_long_task', signals };
  }
  if (fastMode) {
    return { mode: 'shared', reason: 'fast_mode', signals };
  }

  return { mode: 'shared', reason: 'default_shared', signals };
}
