// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  commitEvaluationExposureSince,
  currentEvaluationInjectionContract,
} from './evaluationInjectionContext';
import {
  currentEvaluationTelemetryActive,
  recordEvaluationObservedUsageDelta,
  recordEvaluationObservedTokenTotal,
  type EvaluationObservedUsageSample,
} from './evaluationTelemetry';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberField(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function extractObservedTokenCount(value: unknown): number | undefined {
  return extractObservedTokenUsage(value)?.total;
}

export function extractObservedTokenUsage(
  value: unknown,
): EvaluationObservedUsageSample | undefined {
  const root = record(value);
  if (!root) return undefined;
  const directTotal = numberField(root, [
    'totalTokens',
    'total_tokens',
  ]);
  const reasoning = numberField(root, [
    'reasoningTokens',
    'reasoning_tokens',
  ]);
  const input = numberField(root, [
    'inputTokens',
    'input_tokens',
    'input',
    'promptTokens',
    'prompt_tokens',
  ]);
  const output = numberField(root, [
    'outputTokens',
    'output_tokens',
    'output',
    'completionTokens',
    'completion_tokens',
  ]);
  const cacheRead = numberField(root, [
    'cacheReadTokens',
    'cache_read_tokens',
    'cache_read_input_tokens',
    'cacheRead',
  ]);
  const cacheWrite = numberField(root, [
    'cacheWriteTokens',
    'cache_write_tokens',
    'cache_creation_input_tokens',
    'cacheWrite',
  ]);
  if (
    input !== undefined
    || output !== undefined
    || cacheRead !== undefined
    || cacheWrite !== undefined
  ) {
    const classified = (input ?? 0)
      + (output ?? 0)
      + (cacheRead ?? 0)
      + (cacheWrite ?? 0);
    const total = directTotal ?? classified;
    return {
      total,
      ...(classified > total ? {} : {
        ...(input === undefined ? {} : {input}),
        ...(output === undefined ? {} : {output}),
        ...(cacheRead === undefined ? {} : {cacheRead}),
        ...(cacheWrite === undefined ? {} : {cacheWrite}),
      }),
      ...(reasoning === undefined ? {} : {reasoning}),
    };
  }
  if (directTotal !== undefined) return {total: directTotal};
  if (reasoning !== undefined) return {total: reasoning, reasoning};
  for (const key of ['usage', 'tokens', 'message', 'result', 'info']) {
    const nested = extractObservedTokenUsage(root[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function commitEvaluationSdkHandoffIfActive(): void {
  if (!currentEvaluationInjectionContract()) return;
  commitEvaluationExposureSince(0, 'sdk_handoff_observed');
}

export function recordEvaluationTokenDeltaIfPresent(value: unknown): void {
  if (!currentEvaluationTelemetryActive()) return;
  const usage = extractObservedTokenUsage(value);
  if (usage !== undefined) recordEvaluationObservedUsageDelta(usage);
}

export function recordEvaluationTokenTotalIfPresent(value: unknown): void {
  if (!currentEvaluationTelemetryActive()) return;
  const tokens = extractObservedTokenCount(value);
  if (tokens !== undefined) recordEvaluationObservedTokenTotal(tokens);
}
