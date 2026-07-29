// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {PRODUCTION_RUNTIME_KINDS} from '../../agentRuntime/runtimeKinds';
import type {
  EvaluationRuntimeCapabilitiesV1,
  TraceProcessorCpuCapability,
} from './evaluationTelemetry';

const TOKEN_CAPABILITIES: Readonly<
  Record<AgentRuntimeKind, EvaluationRuntimeCapabilitiesV1['tokens']>
> = Object.freeze({
  'claude-agent-sdk': 'soft_response_observed',
  'openai-agents-sdk': 'soft_response_observed',
  'pi-agent-core': 'soft_response_observed',
  opencode: 'soft_response_observed',
  'qoder-agent-sdk': 'soft_response_observed',
});

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
  runtime: AgentRuntimeKind;
  platform?: NodeJS.Platform;
}): EvaluationRuntimeCapabilitiesV1 {
  if (!PRODUCTION_RUNTIME_KINDS.includes(input.runtime)) {
    throw new Error('evaluation_runtime_unsupported');
  }
  return Object.freeze({
    schemaVersion: 1,
    runtime: input.runtime,
    tokens: TOKEN_CAPABILITIES[input.runtime],
    toolCalls: 'hard_realtime',
    wallclock: 'hard_realtime',
    traceProcessorCpu: traceProcessorCpuCapability(
      input.platform ?? process.platform,
    ),
    exposure: 'sdk_handoff_observed',
  });
}
