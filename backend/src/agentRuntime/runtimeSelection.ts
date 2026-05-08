// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import { createClaudeRuntime } from '../agentv3';
import { getProviderService, type AgentRuntimeKind } from '../services/providerManager';

export type BackendAgentRuntimeKind = AgentRuntimeKind;

export interface RuntimeSelection {
  kind: BackendAgentRuntimeKind;
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
}

function parseRuntimeEnv(value: string | undefined): BackendAgentRuntimeKind | undefined {
  switch (value) {
    case 'claude-agent-sdk':
    case 'openai-agents-sdk':
      return value;
    default:
      return undefined;
  }
}

export function resolveAgentRuntimeSelection(
  providerId?: string | null,
  runtimeOverride?: BackendAgentRuntimeKind,
): RuntimeSelection {
  const providerSvc = getProviderService();
  const provider = typeof providerId === 'string'
    ? providerSvc.getRawProvider(providerId)
    : providerId === null || runtimeOverride
      ? undefined
      : providerSvc.getRawEffectiveProvider();

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
      'Use "claude-agent-sdk" or "openai-agents-sdk".'
    );
  }

  return { kind: 'claude-agent-sdk', source: 'default' };
}

export function createAgentOrchestrator(input: CreateAgentOrchestratorInput): IOrchestrator {
  const selection = resolveAgentRuntimeSelection(input.providerId, input.runtimeOverride);
  switch (selection.kind) {
    case 'openai-agents-sdk': {
      // Lazy import keeps the OpenAI runtime isolated from Claude-only startup
      // paths and avoids circular imports while both SDKs remain first-class.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createOpenAIRuntime } = require('../agentOpenAI');
      return createOpenAIRuntime(input.traceProcessorService);
    }
    case 'claude-agent-sdk':
    default:
      return createClaudeRuntime(input.traceProcessorService);
  }
}
