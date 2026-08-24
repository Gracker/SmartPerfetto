// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';

import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';

export type EvaluationBudgetGuarantee =
  | 'hard'
  | 'soft_observed'
  | 'unavailable';

export type EvaluationTokenCapability =
  | 'hard_request_bound'
  | 'soft_response_observed'
  | 'unavailable';

export type TraceProcessorCpuCapability =
  | 'hard_os'
  | 'sampled_bounded'
  | 'unavailable';

export interface EvaluationBudgetLimitsV1 {
  schemaVersion: 1;
  maxTokens: number;
  maxToolCalls: number;
  maxWallclockMs: number;
  maxTraceProcessorCpuMs: number;
}

export interface EvaluationRuntimeCapabilitiesV1 {
  schemaVersion: 1;
  runtime: AgentRuntimeKind;
  tokens: EvaluationTokenCapability;
  toolCalls: 'hard_realtime';
  wallclock: 'hard_realtime';
  traceProcessorCpu: TraceProcessorCpuCapability;
  exposure:
    | 'provider_request_observed'
    | 'sdk_handoff_observed'
    | 'unavailable';
}

export interface EvaluationUsageReceiptV1 {
  schemaVersion: 1;
  tokens: {
    used: number;
    reserved: number;
    guarantee: EvaluationBudgetGuarantee;
    capability: EvaluationTokenCapability;
    breakdown?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      unclassified: number;
    };
  };
  toolCalls: {
    used: number;
    guarantee: 'hard';
  };
  wallclock: {
    usedMs: number;
    guarantee: 'hard';
  };
  traceProcessorCpu: {
    usedMs: number;
    guarantee: EvaluationBudgetGuarantee;
    capability: TraceProcessorCpuCapability;
    platform: NodeJS.Platform;
    sampleIntervalMs?: number;
    staleThresholdMs?: number;
    logicalCpuCount?: number;
    maxTheoreticalOvershootMs?: number;
  };
  exceeded:
    | 'tokens'
    | 'tool_calls'
    | 'wallclock'
    | 'trace_processor_cpu'
    | null;
  firstOutput?: {
    usedMs?: number;
    guarantee: 'observed' | 'unavailable' | 'not_applicable';
  };
  termination?: {
    reason: string;
    guarantee: 'observed';
  };
  contentHash: string;
}

export interface EvaluationObservedUsageSample {
  total: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface EvaluationUsageReceiptCarrier {
  evaluationUsageReceipt: EvaluationUsageReceiptV1;
}

export interface EvaluationBudgetPreflight {
  status: 'ready' | 'inconclusive';
  reasons: string[];
}

interface EvaluationTelemetryState {
  limits: EvaluationBudgetLimitsV1;
  capabilities: EvaluationRuntimeCapabilitiesV1;
  signal: AbortSignal;
  startedAt: number;
  now: () => number;
  isAuthoritative: () => boolean;
  tokensUsed: number;
  reportedTokenTotal: number;
  tokenObservationCount: number;
  tokensReserved: number;
  tokenBreakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    unclassified: number;
  };
  toolCalls: number;
  traceProcessorCpuMs: number;
  traceProcessorCpuObservationCount: number;
  cpuSampling?: Omit<
    EvaluationUsageReceiptV1['traceProcessorCpu'],
    'usedMs' | 'guarantee' | 'capability'
  >;
  exceeded: EvaluationUsageReceiptV1['exceeded'];
  firstOutputMs?: number;
  firstOutputNotApplicable?: boolean;
  terminationReason?: string;
}

const telemetryContext = new AsyncLocalStorage<EvaluationTelemetryState>();

function nonnegativeFinite(value: number, error: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(error);
  return value;
}

function positiveFinite(value: number, error: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(error);
  return value;
}

export function normalizeEvaluationBudgetLimits(
  value: EvaluationBudgetLimitsV1,
): EvaluationBudgetLimitsV1 {
  if (value.schemaVersion !== 1) {
    throw new Error('evaluation_budget_schema_invalid');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    maxTokens: positiveFinite(value.maxTokens, 'evaluation_budget_tokens_invalid'),
    maxToolCalls: positiveFinite(
      value.maxToolCalls,
      'evaluation_budget_tool_calls_invalid',
    ),
    maxWallclockMs: positiveFinite(
      value.maxWallclockMs,
      'evaluation_budget_wallclock_invalid',
    ),
    maxTraceProcessorCpuMs: positiveFinite(
      value.maxTraceProcessorCpuMs,
      'evaluation_budget_trace_cpu_invalid',
    ),
  });
}

export function preflightEvaluationBudgets(input: {
  capabilities: EvaluationRuntimeCapabilitiesV1;
  strict: boolean;
}): EvaluationBudgetPreflight {
  const reasons: string[] = [];
  if (
    input.strict
    && input.capabilities.tokens !== 'hard_request_bound'
  ) {
    reasons.push('token_budget_not_hard_bounded');
  }
  if (
    input.strict
    && input.capabilities.traceProcessorCpu !== 'hard_os'
  ) {
    reasons.push('trace_processor_cpu_not_hard_bounded');
  }
  if (
    input.strict
    && input.capabilities.exposure !== 'provider_request_observed'
  ) {
    reasons.push('provider_request_exposure_not_observable');
  }
  return {
    status: reasons.length === 0 ? 'ready' : 'inconclusive',
    reasons,
  };
}

function requireState(): EvaluationTelemetryState {
  const state = telemetryContext.getStore();
  if (!state) throw new Error('evaluation_telemetry_context_missing');
  if (!state.isAuthoritative()) {
    throw new Error('evaluation_execution_fence_lost');
  }
  if (state.signal.aborted) throw new Error('evaluation_cancelled');
  return state;
}

function failIfExceeded(state: EvaluationTelemetryState): void {
  if (state.exceeded) {
    throw new Error(`evaluation_budget_exceeded:${state.exceeded}`);
  }
  const wallclockMs = Math.max(0, state.now() - state.startedAt);
  if (wallclockMs > state.limits.maxWallclockMs) {
    state.exceeded = 'wallclock';
  } else if (
    state.tokensUsed + state.tokensReserved > state.limits.maxTokens
  ) {
    state.exceeded = 'tokens';
  } else if (state.toolCalls > state.limits.maxToolCalls) {
    state.exceeded = 'tool_calls';
  } else if (
    state.traceProcessorCpuMs > state.limits.maxTraceProcessorCpuMs
  ) {
    state.exceeded = 'trace_processor_cpu';
  }
  if (state.exceeded) {
    throw new Error(`evaluation_budget_exceeded:${state.exceeded}`);
  }
}

export function reserveEvaluationTokens(tokens: number): void {
  const state = requireState();
  if (state.capabilities.tokens !== 'hard_request_bound') {
    throw new Error('evaluation_token_reservation_not_supported');
  }
  state.tokensReserved += nonnegativeFinite(
    tokens,
    'evaluation_token_reservation_invalid',
  );
  failIfExceeded(state);
}

export function settleEvaluationTokens(input: {
  reserved?: number;
  used: number;
}): void {
  const state = requireState();
  const reserved = nonnegativeFinite(
    input.reserved ?? 0,
    'evaluation_token_reservation_invalid',
  );
  state.tokensReserved = Math.max(0, state.tokensReserved - reserved);
  const used = nonnegativeFinite(
    input.used,
    'evaluation_token_usage_invalid',
  );
  state.tokensUsed += used;
  state.tokenBreakdown.unclassified += used;
  failIfExceeded(state);
}

export function recordEvaluationObservedTokenTotal(total: number): void {
  const state = requireState();
  const normalized = nonnegativeFinite(
    total,
    'evaluation_token_usage_invalid',
  );
  if (normalized < state.reportedTokenTotal) {
    throw new Error('evaluation_token_usage_not_monotonic');
  }
  const delta = normalized - state.reportedTokenTotal;
  state.tokensUsed += delta;
  state.tokenBreakdown.unclassified += delta;
  state.reportedTokenTotal = normalized;
  state.tokenObservationCount += 1;
  failIfExceeded(state);
}

export function recordEvaluationObservedTokenDelta(tokens: number): void {
  recordEvaluationObservedUsageDelta({total: tokens});
}

export function recordEvaluationObservedUsageDelta(
  sample: EvaluationObservedUsageSample,
): void {
  const state = requireState();
  const total = nonnegativeFinite(
    sample.total,
    'evaluation_token_usage_invalid',
  );
  const input = nonnegativeFinite(
    sample.input ?? 0,
    'evaluation_token_usage_invalid',
  );
  const output = nonnegativeFinite(
    sample.output ?? 0,
    'evaluation_token_usage_invalid',
  );
  const cacheRead = nonnegativeFinite(
    sample.cacheRead ?? 0,
    'evaluation_token_usage_invalid',
  );
  const cacheWrite = nonnegativeFinite(
    sample.cacheWrite ?? 0,
    'evaluation_token_usage_invalid',
  );
  const reasoning = nonnegativeFinite(
    sample.reasoning ?? 0,
    'evaluation_token_usage_invalid',
  );
  const classified = input + output + cacheRead + cacheWrite;
  if (classified > total) {
    throw new Error('evaluation_token_breakdown_exceeds_total');
  }
  state.tokensUsed += total;
  state.reportedTokenTotal = state.tokensUsed;
  state.tokenObservationCount += 1;
  state.tokenBreakdown.input += input;
  state.tokenBreakdown.output += output;
  state.tokenBreakdown.cacheRead += cacheRead;
  state.tokenBreakdown.cacheWrite += cacheWrite;
  state.tokenBreakdown.reasoning += reasoning;
  state.tokenBreakdown.unclassified += total - classified;
  failIfExceeded(state);
}

export function recordEvaluationFirstOutput(): void {
  const state = requireState();
  if (state.firstOutputMs === undefined) {
    state.firstOutputMs = Math.max(0, state.now() - state.startedAt);
  }
  failIfExceeded(state);
}

export function recordEvaluationFirstOutputNotApplicable(): void {
  const state = requireState();
  if (state.firstOutputMs === undefined) {
    state.firstOutputNotApplicable = true;
  }
}

export function recordEvaluationTermination(reason: string): void {
  const state = requireState();
  if (!reason.trim()) throw new Error('evaluation_termination_reason_invalid');
  if (state.terminationReason && state.terminationReason !== reason) {
    throw new Error('evaluation_termination_reason_conflict');
  }
  state.terminationReason = reason;
}

export function recordEvaluationToolCall(): void {
  const state = requireState();
  state.toolCalls += 1;
  failIfExceeded(state);
}

export function recordTraceProcessorCpuSample(input: {
  cumulativeCpuMs: number;
  platform?: NodeJS.Platform;
  sampleIntervalMs?: number;
  staleThresholdMs?: number;
  logicalCpuCount?: number;
}): void {
  const state = requireState();
  const cumulativeCpuMs = nonnegativeFinite(
    input.cumulativeCpuMs,
    'evaluation_trace_cpu_sample_invalid',
  );
  if (cumulativeCpuMs < state.traceProcessorCpuMs) {
    throw new Error('evaluation_trace_cpu_sample_not_monotonic');
  }
  state.traceProcessorCpuMs = cumulativeCpuMs;
  state.traceProcessorCpuObservationCount += 1;
  const platform = input.platform ?? process.platform;
  state.cpuSampling = {
    platform,
    ...(input.sampleIntervalMs === undefined
      ? {}
      : {sampleIntervalMs: input.sampleIntervalMs}),
    ...(input.staleThresholdMs === undefined
      ? {}
      : {staleThresholdMs: input.staleThresholdMs}),
    ...(input.logicalCpuCount === undefined
      ? {}
      : {logicalCpuCount: input.logicalCpuCount}),
    ...(input.staleThresholdMs === undefined
      || input.logicalCpuCount === undefined
      ? {}
      : {
          maxTheoreticalOvershootMs:
            input.staleThresholdMs * input.logicalCpuCount,
        }),
  };
  failIfExceeded(state);
}

export function checkEvaluationBudgets(): void {
  failIfExceeded(requireState());
}

function tokenGuarantee(
  capability: EvaluationTokenCapability,
  observationCount: number,
): EvaluationBudgetGuarantee {
  if (observationCount === 0) return 'unavailable';
  if (capability === 'hard_request_bound') return 'hard';
  if (capability === 'soft_response_observed') return 'soft_observed';
  return 'unavailable';
}

function cpuGuarantee(
  capability: TraceProcessorCpuCapability,
  observationCount: number,
): EvaluationBudgetGuarantee {
  if (observationCount === 0) return 'unavailable';
  if (capability === 'hard_os') return 'hard';
  if (capability === 'sampled_bounded') return 'soft_observed';
  return 'unavailable';
}

function snapshotState(
  state: EvaluationTelemetryState,
): EvaluationUsageReceiptV1 {
  try {
    failIfExceeded(state);
  } catch {
    // The receipt must still describe the exact exceeded dimension.
  }
  const withoutHash: Omit<EvaluationUsageReceiptV1, 'contentHash'> = {
    schemaVersion: 1,
    tokens: {
      used: state.tokensUsed,
      reserved: state.tokensReserved,
      guarantee: tokenGuarantee(
        state.capabilities.tokens,
        state.tokenObservationCount,
      ),
      capability: state.capabilities.tokens,
      breakdown: {...state.tokenBreakdown},
    },
    toolCalls: {
      used: state.toolCalls,
      guarantee: 'hard',
    },
    wallclock: {
      usedMs: Math.max(0, state.now() - state.startedAt),
      guarantee: 'hard',
    },
    traceProcessorCpu: {
      usedMs: state.traceProcessorCpuMs,
      guarantee: cpuGuarantee(
        state.capabilities.traceProcessorCpu,
        state.traceProcessorCpuObservationCount,
      ),
      capability: state.capabilities.traceProcessorCpu,
      platform: state.cpuSampling?.platform ?? process.platform,
      ...(state.cpuSampling?.sampleIntervalMs === undefined
        ? {}
        : {sampleIntervalMs: state.cpuSampling.sampleIntervalMs}),
      ...(state.cpuSampling?.staleThresholdMs === undefined
        ? {}
        : {staleThresholdMs: state.cpuSampling.staleThresholdMs}),
      ...(state.cpuSampling?.logicalCpuCount === undefined
        ? {}
        : {logicalCpuCount: state.cpuSampling.logicalCpuCount}),
      ...(state.cpuSampling?.maxTheoreticalOvershootMs === undefined
        ? {}
        : {
            maxTheoreticalOvershootMs:
              state.cpuSampling.maxTheoreticalOvershootMs,
          }),
    },
    exceeded: state.exceeded,
    firstOutput: state.firstOutputMs === undefined
      ? {
          guarantee: state.firstOutputNotApplicable
            ? 'not_applicable'
            : 'unavailable',
        }
      : {usedMs: state.firstOutputMs, guarantee: 'observed'},
    ...(state.terminationReason
      ? {
          termination: {
            reason: state.terminationReason,
            guarantee: 'observed',
          },
        }
      : {}),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function snapshotEvaluationUsageReceipt():
EvaluationUsageReceiptV1 {
  return snapshotState(requireState());
}

export async function withEvaluationTelemetry<T>(input: {
  limits: EvaluationBudgetLimitsV1;
  capabilities: EvaluationRuntimeCapabilitiesV1;
  signal: AbortSignal;
  isAuthoritative: () => boolean;
  now?: () => number;
}, callback: () => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const state: EvaluationTelemetryState = {
    limits: normalizeEvaluationBudgetLimits(input.limits),
    capabilities: immutableCanonicalSnapshot(input.capabilities),
    signal: input.signal,
    startedAt: now(),
    now,
    isAuthoritative: input.isAuthoritative,
    tokensUsed: 0,
    reportedTokenTotal: 0,
    tokenObservationCount: 0,
    tokensReserved: 0,
    tokenBreakdown: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      unclassified: 0,
    },
    toolCalls: 0,
    traceProcessorCpuMs: 0,
    traceProcessorCpuObservationCount: 0,
    exceeded: null,
  };
  return telemetryContext.run(state, async () => {
    try {
      return await callback();
    } catch (error) {
      const budgetMatch = (
        error instanceof Error ? error.message : String(error)
      ).match(
        /^evaluation_budget_exceeded:(tokens|tool_calls|wallclock|trace_processor_cpu)$/,
      );
      if (budgetMatch && state.exceeded === null) {
        state.exceeded = budgetMatch[1] as NonNullable<
          EvaluationUsageReceiptV1['exceeded']
        >;
      }
      const receipt = snapshotState(state);
      if (error && typeof error === 'object') {
        try {
          Object.defineProperty(error, 'evaluationUsageReceipt', {
            configurable: true,
            enumerable: false,
            value: receipt,
          });
          throw error;
        } catch (attachmentError) {
          if (attachmentError === error) throw error;
        }
      }
      const wrapped = new Error(
        error instanceof Error ? error.message : String(error),
      ) as Error
        & EvaluationUsageReceiptCarrier;
      wrapped.evaluationUsageReceipt = receipt;
      throw wrapped;
    }
  });
}

export function currentEvaluationTelemetryActive(): boolean {
  return telemetryContext.getStore() !== undefined;
}

export function evaluationUsageReceiptFromError(
  error: unknown,
): EvaluationUsageReceiptV1 | undefined {
  if (
    error
    && typeof error === 'object'
    && 'evaluationUsageReceipt' in error
  ) {
    return (error as Partial<EvaluationUsageReceiptCarrier>)
      .evaluationUsageReceipt;
  }
  return undefined;
}
