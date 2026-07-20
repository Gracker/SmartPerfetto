// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { DUAL_SURFACE_PROVIDER_TYPES } from '../services/providerManager/providerTypes';
import type { AgentRuntimeKind } from './runtimeKinds';
import {
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
  isProductionAgentRuntimeKind,
  listProductionRuntimeKinds,
} from './runtimeKinds';
import type {
  EngineCapabilities,
  RuntimeDiagnosticsInput,
  RuntimeDiagnosticsPayload,
  RuntimeEngineDescriptor,
} from './runtimeDescriptorTypes';
import type { RuntimeSelection } from './runtimeSelection';

const CLAUDE_PROVIDER_TYPES = [
  'anthropic',
  'bedrock',
  'vertex',
  ...DUAL_SURFACE_PROVIDER_TYPES,
  'custom',
] as const;

const OPENAI_PROVIDER_TYPES = [
  'openai',
  'ollama',
  ...DUAL_SURFACE_PROVIDER_TYPES,
  'custom',
] as const;

const CUSTOM_ONLY_PROVIDER_TYPES = ['custom'] as const;

function createCapabilities<K extends AgentRuntimeKind>(
  kind: K,
  displayName: string,
  systemPromptDynamicBoundary: boolean,
): RuntimeEngineDescriptor<K>['capabilities'] {
  return {
    kind,
    displayName,
    production: true,
    publicRuntime: true,
    promptCache: { systemPromptDynamicBoundary },
  };
}

export const PRODUCTION_RUNTIME_DESCRIPTORS = [
  {
    kind: CLAUDE_AGENT_RUNTIME_KIND,
    displayName: 'Claude Agent SDK',
    production: true,
    publicRuntime: true,
    providerTypes: CLAUDE_PROVIDER_TYPES,
    capabilities: createCapabilities(CLAUDE_AGENT_RUNTIME_KIND, 'Claude Agent SDK', true),
    createOrchestrator: ({ traceProcessorService, selection }) => {
      // Lazy load to keep providerManager runtime matrix imports cycle-free.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClaudeRuntime } = require('./engines/claude') as typeof import('./engines/claude');
      return createClaudeRuntime(
        traceProcessorService,
        undefined,
        selection as RuntimeSelection<AgentRuntimeKind>,
      );
    },
    getDiagnostics: ({ selectedProviderId }: RuntimeDiagnosticsInput<typeof CLAUDE_AGENT_RUNTIME_KIND>) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getClaudeRuntimeDiagnostics } = require('./engines/claude/claudeConfig') as typeof import('./engines/claude/claudeConfig');
      return getClaudeRuntimeDiagnostics(selectedProviderId ?? null);
    },
  },
  {
    kind: OPENAI_AGENT_RUNTIME_KIND,
    displayName: 'OpenAI Agents SDK',
    production: true,
    publicRuntime: true,
    providerTypes: OPENAI_PROVIDER_TYPES,
    capabilities: createCapabilities(OPENAI_AGENT_RUNTIME_KIND, 'OpenAI Agents SDK', false),
    createOrchestrator: ({ traceProcessorService, selection }) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createOpenAIRuntime } = require('./engines/openai') as typeof import('./engines/openai');
      return createOpenAIRuntime(
        traceProcessorService,
        selection as RuntimeSelection<AgentRuntimeKind>,
      );
    },
    getDiagnostics: ({ selectedProviderId }: RuntimeDiagnosticsInput<typeof OPENAI_AGENT_RUNTIME_KIND>) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getOpenAIRuntimeDiagnostics } = require('./engines/openai/openAiConfig') as typeof import('./engines/openai/openAiConfig');
      return getOpenAIRuntimeDiagnostics(selectedProviderId ?? null);
    },
  },
  {
    kind: PI_AGENT_CORE_RUNTIME_KIND,
    displayName: 'Pi Agent Core',
    production: true,
    publicRuntime: true,
    providerTypes: CUSTOM_ONLY_PROVIDER_TYPES,
    capabilities: createCapabilities(PI_AGENT_CORE_RUNTIME_KIND, 'Pi Agent Core', false),
    createOrchestrator: input => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createPiAgentCoreRuntime } = require('./engines/pi/piAgentCoreRuntime') as typeof import('./engines/pi/piAgentCoreRuntime');
      return createPiAgentCoreRuntime(input);
    },
    getDiagnostics: ({ env, kind }: RuntimeDiagnosticsInput<typeof PI_AGENT_CORE_RUNTIME_KIND>) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getPiAgentCoreRuntimeDiagnostics } = require('./engines/pi/piAgentCoreRuntime') as typeof import('./engines/pi/piAgentCoreRuntime');
      return getPiAgentCoreRuntimeDiagnostics(env, kind);
    },
  },
  {
    kind: OPENCODE_RUNTIME_KIND,
    displayName: 'OpenCode',
    production: true,
    publicRuntime: true,
    providerTypes: CUSTOM_ONLY_PROVIDER_TYPES,
    capabilities: createCapabilities(OPENCODE_RUNTIME_KIND, 'OpenCode', false),
    createOrchestrator: input => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { OpenCodeRuntime } = require('./engines/opencode/openCodeRuntime') as typeof import('./engines/opencode/openCodeRuntime');
      return new OpenCodeRuntime(input, { env: input.env });
    },
    getDiagnostics: ({ env, kind }: RuntimeDiagnosticsInput<typeof OPENCODE_RUNTIME_KIND>) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getOpenCodeRuntimeDiagnostics } = require('./engines/opencode/openCodeRuntime') as typeof import('./engines/opencode/openCodeRuntime');
      return getOpenCodeRuntimeDiagnostics(env, kind);
    },
  },
  {
    kind: QODER_AGENT_RUNTIME_KIND,
    displayName: 'Qoder Agent SDK',
    production: true,
    publicRuntime: true,
    providerTypes: CUSTOM_ONLY_PROVIDER_TYPES,
    capabilities: createCapabilities(QODER_AGENT_RUNTIME_KIND, 'Qoder Agent SDK', false),
    createOrchestrator: input => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { QoderRuntime } = require('./engines/qoder/qoderRuntime') as typeof import('./engines/qoder/qoderRuntime');
      return new QoderRuntime(input);
    },
    getDiagnostics: ({ env, kind }: RuntimeDiagnosticsInput<typeof QODER_AGENT_RUNTIME_KIND>) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getQoderRuntimeDiagnostics } = require('./engines/qoder/qoderConfig') as typeof import('./engines/qoder/qoderConfig');
      return getQoderRuntimeDiagnostics(env, kind);
    },
  },
] as const satisfies readonly RuntimeEngineDescriptor[];

export {
  isProductionAgentRuntimeKind,
  listProductionRuntimeKinds,
  type AgentRuntimeKind,
  type EngineCapabilities,
  type RuntimeDiagnosticsInput,
  type RuntimeDiagnosticsPayload,
  type RuntimeEngineDescriptor,
};

export function getProductionRuntimeDescriptor(kind: AgentRuntimeKind): RuntimeEngineDescriptor {
  const descriptor = PRODUCTION_RUNTIME_DESCRIPTORS.find(candidate => candidate.kind === kind);
  if (!descriptor) {
    throw new Error(`Unsupported agent runtime descriptor: ${kind}`);
  }
  return descriptor;
}

export function getProductionEngineCapabilities(kind: string): EngineCapabilities {
  if (!isProductionAgentRuntimeKind(kind)) {
    throw new Error(`Unsupported agent runtime capabilities: ${kind}`);
  }
  return getProductionRuntimeDescriptor(kind).capabilities;
}

export function getProviderTypesForRuntime(kind: AgentRuntimeKind): readonly string[] {
  return getProductionRuntimeDescriptor(kind).providerTypes;
}

export function supportsRuntimeProviderType(type: string, runtime: AgentRuntimeKind): boolean {
  return getProviderTypesForRuntime(runtime).includes(type);
}
