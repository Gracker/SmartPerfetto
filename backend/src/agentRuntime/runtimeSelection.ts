// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import { getProviderService, type AgentRuntimeKind, type ProviderScope } from '../services/providerManager';
import { isProductionAgentRuntimeKind } from './runtimeKinds';
import {
  type ExperimentalAgentRuntimeKind,
  resolveExperimentalAgentRuntimeSelection,
} from './experimentalRuntime';
import { createRuntimeFactoryEnv } from './runtimeFactoryEnv';
import { createRuntimeRegistryForSelection } from './runtimeRegistry';
import {
  assertAiFeatureEnabled,
  type AiCapabilityFeature,
} from '../services/aiCapabilityPolicy';

export type BackendAgentRuntimeKind = AgentRuntimeKind;
export type ResolvedAgentRuntimeKind = BackendAgentRuntimeKind | ExperimentalAgentRuntimeKind;

export interface RuntimeSelection<K extends string = ResolvedAgentRuntimeKind> {
  kind: K;
  source: 'provider' | 'snapshot' | 'env' | 'default';
  providerId?: string;
  providerName?: string;
  providerType?: string;
}

export interface CreateAgentOrchestratorInput {
  traceProcessorService: TraceProcessorService;
  /**
   * undefined = resolve current active provider.
   * string = use that provider.
   * null = pin to env/default fallback and ignore Provider Manager.
   */
  providerId?: string | null;
  runtimeOverride?: BackendAgentRuntimeKind;
  providerScope?: ProviderScope;
  aiFeature?: AiCapabilityFeature;
}

function parseRuntimeEnv(value: string | undefined): BackendAgentRuntimeKind | undefined {
  return isProductionAgentRuntimeKind(value) ? value : undefined;
}

export function resolveAgentRuntimeSelection(
  providerId?: string | null,
  runtimeOverride?: BackendAgentRuntimeKind,
  providerScope?: ProviderScope,
): RuntimeSelection {
  const providerSvc = getProviderService();
  const provider = typeof providerId === 'string'
    ? providerSvc.getRawProvider(providerId, providerScope)
    : providerId === null || runtimeOverride
      ? undefined
      : providerSvc.getRawEffectiveProvider(providerScope);

  if (typeof providerId === 'string' && !provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  if (provider) {
    return {
      kind: providerSvc.resolveAgentRuntime(provider),
      source: 'provider',
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
    };
  }

  if (runtimeOverride) {
    return { kind: runtimeOverride, source: 'snapshot' };
  }

  const explicitRuntime = parseRuntimeEnv(process.env.SMARTPERFETTO_AGENT_RUNTIME);
  if (explicitRuntime) {
    return { kind: explicitRuntime, source: 'env' };
  }
  if (process.env.SMARTPERFETTO_AGENT_RUNTIME) {
    throw new Error(
      `Unsupported SMARTPERFETTO_AGENT_RUNTIME="${process.env.SMARTPERFETTO_AGENT_RUNTIME}". ` +
      'Use "claude-agent-sdk", "openai-agents-sdk", "pi-agent-core", "opencode", or "qoder-agent-sdk".'
    );
  }

  const experimentalRuntime = resolveExperimentalAgentRuntimeSelection();
  if (experimentalRuntime) {
    return experimentalRuntime;
  }

  return { kind: 'claude-agent-sdk', source: 'default' };
}

export function createAgentOrchestrator(input: CreateAgentOrchestratorInput): IOrchestrator {
  assertAiFeatureEnabled(input.aiFeature ?? 'agent_analyze');
  const selection = resolveAgentRuntimeSelection(input.providerId, input.runtimeOverride, input.providerScope);
  const registry = createRuntimeRegistryForSelection(selection.kind);
  return registry.createOrchestrator(selection.kind, {
    traceProcessorService: input.traceProcessorService,
    selection,
    env: createRuntimeFactoryEnv(selection, input.providerScope),
    providerScope: input.providerScope,
  });
}
