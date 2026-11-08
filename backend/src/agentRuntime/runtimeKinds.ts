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

export function isProductionAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return typeof value === 'string'
    && PRODUCTION_RUNTIME_KINDS.includes(value as AgentRuntimeKind);
}

export function listExperimentalRuntimeKinds(): readonly ExperimentalAgentRuntimeKind[] {
  return EXPERIMENTAL_RUNTIME_KINDS;
}

/**
 * The runtimes a provider, template, API client or `smp provider` may select.
 * Pi Agent Core is the only one; every other kind maps to it when read.
 */
export const SELECTABLE_RUNTIME_KINDS = [PI_AGENT_CORE_RUNTIME_KIND] as const;

export type SelectableAgentRuntimeKind = typeof SELECTABLE_RUNTIME_KINDS[number];

export function isSelectableAgentRuntimeKind(value: unknown): value is SelectableAgentRuntimeKind {
  return typeof value === 'string'
    && SELECTABLE_RUNTIME_KINDS.includes(value as SelectableAgentRuntimeKind);
}

/**
 * Every runtime label SmartPerfetto has written into a record (provider
 * profiles, session snapshots, conversation descriptors, run manifests,
 * evaluation pins). Readers accept these as provenance; execution re-resolves
 * a retired one through the effective runtime.
 */
export const RECORDED_RUNTIME_KINDS = [
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
] as const;

export type RecordedRuntimeKind = typeof RECORDED_RUNTIME_KINDS[number];

export function isRecordedRuntimeKind(value: unknown): value is RecordedRuntimeKind {
  return typeof value === 'string'
    && RECORDED_RUNTIME_KINDS.includes(value as RecordedRuntimeKind);
}

/** A recorded label that no longer selects its own runtime. */
export function isRetiredRuntimeKind(value: unknown): value is Exclude<RecordedRuntimeKind, SelectableAgentRuntimeKind> {
  return isRecordedRuntimeKind(value) && !isSelectableAgentRuntimeKind(value);
}
