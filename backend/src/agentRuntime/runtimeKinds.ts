// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const CLAUDE_AGENT_RUNTIME_KIND = 'claude-agent-sdk' as const;
export const OPENAI_AGENT_RUNTIME_KIND = 'openai-agents-sdk' as const;
export const PI_AGENT_CORE_RUNTIME_KIND = 'pi-agent-core' as const;
export const OPENCODE_RUNTIME_KIND = 'opencode' as const;
export const QODER_AGENT_RUNTIME_KIND = 'qoder-agent-sdk' as const;
export const EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND = 'experimental-pi-agent-core' as const;
export const EXPERIMENTAL_OPENCODE_RUNTIME_KIND = 'experimental-opencode' as const;

export const PRODUCTION_RUNTIME_KINDS = [
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
] as const;

export type AgentRuntimeKind = typeof PRODUCTION_RUNTIME_KINDS[number];

export const EXPERIMENTAL_RUNTIME_KINDS = [
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
] as const;

export type ExperimentalAgentRuntimeKind = typeof EXPERIMENTAL_RUNTIME_KINDS[number];

export function listProductionRuntimeKinds(): readonly AgentRuntimeKind[] {
  return PRODUCTION_RUNTIME_KINDS;
}

export function isProductionAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return typeof value === 'string'
    && PRODUCTION_RUNTIME_KINDS.includes(value as AgentRuntimeKind);
}

export function listExperimentalRuntimeKinds(): readonly ExperimentalAgentRuntimeKind[] {
  return EXPERIMENTAL_RUNTIME_KINDS;
}

export function isExperimentalAgentRuntimeKind(value: unknown): value is ExperimentalAgentRuntimeKind {
  return typeof value === 'string'
    && EXPERIMENTAL_RUNTIME_KINDS.includes(value as ExperimentalAgentRuntimeKind);
}
