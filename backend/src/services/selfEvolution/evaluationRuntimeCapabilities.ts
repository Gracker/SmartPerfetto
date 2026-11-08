// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  isRecordedProductionRuntimeKind,
  type RecordedRuntimeKind,
} from '../../agentRuntime/runtimeKinds';
import type {
  EvaluationRuntimeCapabilitiesV1,
  TraceProcessorCpuCapability,
} from './evaluationTelemetry';

/** Every production engine observes token use from provider responses, after the fact. */
const TOKEN_CAPABILITY: EvaluationRuntimeCapabilitiesV1['tokens'] = 'soft_response_observed';

function traceProcessorCpuCapability(
  platform: NodeJS.Platform,
): TraceProcessorCpuCapability {
  return platform === 'darwin'
    || platform === 'linux'
    || platform === 'win32'
    ? 'sampled_bounded'
    : 'unavailable';
}

export function evaluationRuntimeCapabilities(input: {
  runtime: RecordedRuntimeKind;
  platform?: NodeJS.Platform;
}): EvaluationRuntimeCapabilitiesV1 {
  if (!isRecordedProductionRuntimeKind(input.runtime)) {
    throw new Error('evaluation_runtime_unsupported');
  }
  return Object.freeze({
    schemaVersion: 1,
    runtime: input.runtime,
    tokens: TOKEN_CAPABILITY,
    toolCalls: 'hard_realtime',
    wallclock: 'hard_realtime',
    traceProcessorCpu: traceProcessorCpuCapability(
      input.platform ?? process.platform,
    ),
    exposure: 'sdk_handoff_observed',
  });
}
