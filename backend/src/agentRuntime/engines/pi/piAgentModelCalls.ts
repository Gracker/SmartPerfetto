// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AssistantMessage, AssistantMessageEventStream, Usage} from '@earendil-works/pi-ai';
import type {ModelExecutionPolicyReceipt} from '../../modelExecutionPolicy';
import type {AGENT_REQUEST_PURPOSES} from '../../investigation/investigationReceipt';
import {
  runtimeOutcomeFromError,
  type RuntimeModelCallEnd,
  type RuntimeModelCallSpan,
  type RuntimeModelCallStart,
  type RuntimeModelCallUsageV1,
  type RuntimePerformanceOutcome,
} from '../../runtimePerformance';

type PiReasoning = Pick<RuntimeModelCallEnd, 'reasoning' | 'reasoningEffort'>;

/** The reasoning setting the Pi SDK actually selected for one call, if known. */
export function piReasoningFromPolicyReceipt(receipt: ModelExecutionPolicyReceipt): PiReasoning {
  const setting = receipt.sdkEffective === 'unknown' ? undefined : receipt.sdkEffective;
  if (setting?.mode === 'disabled') return {reasoning: 'disabled'};
  if (setting?.mode === 'enabled') return {reasoning: 'enabled', reasoningEffort: setting.effort};
  return {};
}

/** pi-ai `Usage.input` excludes cache reads and writes; `reasoning` is part of `output`. */
export function piUsageToModelCallUsage(usage: Usage | undefined): RuntimeModelCallUsageV1 | undefined {
  if (!usage) return undefined;
  return {inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead, ...(usage.reasoning !== undefined ? {reasoningTokens: usage.reasoning} : {})};
}

/** The model-call end facts of a finished Pi assistant message. */
export function piAssistantModelCallEnd(message: AssistantMessage): RuntimeModelCallEnd {
  const outcome: RuntimePerformanceOutcome = message.stopReason === 'aborted' ? 'cancelled'
    : message.stopReason === 'error' || message.errorMessage ? 'error' : 'ok';
  return {outcome, usage: piUsageToModelCallUsage(message.usage),
    ...(message.responseModel ? {model: message.responseModel, modelSource: 'provider_reported' as const}
      : {model: message.model})};
}

/** The native Agent request purposes; each must also be a dispatch purpose, or `startModelCall` fails to compile. */
type AgentModelCallPurpose = typeof AGENT_REQUEST_PURPOSES[number];

export interface PiAgentModelCallTracker {
  /**
   * Record one native Agent stream dispatch until its final assistant message.
   * `requestIndex` is the prepared native request this dispatch answers.
   */
  dispatch(
    purpose: AgentModelCallPurpose,
    open: (onExecutionPolicy: (receipt: ModelExecutionPolicyReceipt) => void) => AssistantMessageEventStream,
    requestIndex?: number,
  ): AssistantMessageEventStream;
  /** The call in flight produced visible output. */
  recordFirstOutput(): void;
}

/**
 * Model-call records for the native Pi Agent loop. Intent-transport calls
 * (classification, review, closeouts) record themselves and never pass here.
 */
export function createPiAgentModelCallTracker(
  startModelCall: (input: RuntimeModelCallStart) => RuntimeModelCallSpan,
  base: Pick<RuntimeModelCallStart, 'model' | 'providerOrigin'>,
  signal: AbortSignal,
): PiAgentModelCallTracker {
  let current: RuntimeModelCallSpan | undefined;
  return {
    dispatch(purpose, open, requestIndex) {
      const span = startModelCall({purpose, ...base, ...(requestIndex !== undefined ? {requestIndex} : {})});
      current = span;
      let reasoning: PiReasoning = {};
      const settle = (end: RuntimeModelCallEnd) => {
        span.end({...reasoning, ...end});
        if (current === span) current = undefined;
      };
      let stream: AssistantMessageEventStream;
      try {
        stream = open(receipt => { reasoning = piReasoningFromPolicyReceipt(receipt); });
      } catch (error) {
        settle({outcome: runtimeOutcomeFromError(error, signal)});
        throw error;
      }
      // Observation only: the Agent consumes the same stream and its result.
      void Promise.resolve().then(() => stream.result()).then(message => settle(piAssistantModelCallEnd(message)),
        error => settle({outcome: runtimeOutcomeFromError(error, signal)}));
      return stream;
    },
    recordFirstOutput() {
      current?.recordFirstOutput();
    },
  };
}
