// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import {
  getProviderService,
  ProviderStoreUnreadableError,
  type AgentRuntimeKind,
  type ProviderConfig,
  type ProviderScope,
} from '../services/providerManager';
import { PI_AGENT_CORE_RUNTIME_KIND, type ExperimentalAgentRuntimeKind, type RecordedRuntimeKind } from './runtimeKinds';
import { createRuntimeFactoryEnv } from './runtimeFactoryEnv';
import {
  agentRuntimeFromEnv,
  effectiveAgentRuntimeKind,
  legacyAgentRuntimeFallback,
  warnRetiredExperimentalRuntimeEnv,
} from './legacyRuntimeFallback';
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
  /** A recorded runtime pin (session snapshot, CLI session); it re-resolves to the effective runtime. */
  runtimeOverride?: RecordedRuntimeKind;
  providerScope?: ProviderScope;
  aiFeature?: AiCapabilityFeature;
}

export function resolveAgentRuntimeSelection(
  providerId?: string | null,
  runtimeOverride?: RecordedRuntimeKind,
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
  return selectRuntimeForProvider(provider, runtimeOverride);
}

/**
 * The selection a health or doctor report describes: the one an analysis
 * without an explicit provider would use. While providers.json is unreadable
 * such an analysis is refused, so this reports the refusal beside the
 * env/default selection instead of throwing from a status surface.
 */
export function resolveAgentRuntimeSelectionForDiagnostics(): {
  selection: RuntimeSelection;
  providerStoreError?: ProviderStoreUnreadableError;
} {
  try {
    return {selection: resolveAgentRuntimeSelection()};
  } catch (error) {
    if (!(error instanceof ProviderStoreUnreadableError)) throw error;
    return {selection: resolveAgentRuntimeSelection(null), providerStoreError: error};
  }
}

/**
 * The runtime selection for a provider record already read from the store
 * (undefined: no provider applies), so a caller that also needs the record's
 * env reads the store once. The source keeps its precedence (provider record,
 * recorded pin, env, default), and every source resolves to the one effective
 * runtime: Pi Agent Core, or the hidden legacy opt-in when it is set. A
 * recorded retired label keeps its provenance; its execution re-resolves here.
 */
export function selectRuntimeForProvider(
  provider: ProviderConfig | undefined,
  runtimeOverride?: RecordedRuntimeKind,
): RuntimeSelection {
  const providerSvc = getProviderService();
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
    return { kind: effectiveAgentRuntimeKind(), source: 'snapshot' };
  }

  const envRuntime = agentRuntimeFromEnv();
  if (envRuntime) {
    return { kind: envRuntime, source: 'env' };
  }
  warnRetiredExperimentalRuntimeEnv();
  const legacyRuntime = legacyAgentRuntimeFallback();
  return legacyRuntime ? { kind: legacyRuntime, source: 'env' } : { kind: PI_AGENT_CORE_RUNTIME_KIND, source: 'default' };
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
