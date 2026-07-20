// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  getProviderTypesForRuntime,
  isProductionAgentRuntimeKind,
  supportsRuntimeProviderType,
} from '../../agentRuntime/runtimeDescriptors';
import type {
  AgentRuntimeKind,
  DualSurfaceProviderType,
  ProviderConfig,
  ProviderType,
} from './types';
import { DUAL_SURFACE_PROVIDER_TYPES } from './providerTypes';

export { DUAL_SURFACE_PROVIDER_TYPES };

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return isProductionAgentRuntimeKind(value);
}

export function isDualSurfaceProviderType(type: ProviderType): type is DualSurfaceProviderType {
  return DUAL_SURFACE_PROVIDER_TYPES.includes(type as DualSurfaceProviderType);
}

export function supportsAgentRuntimeType(type: ProviderType, runtime: AgentRuntimeKind): boolean {
  return supportsRuntimeProviderType(type, runtime);
}

export function assertAgentRuntimeSupported(type: ProviderType, runtime?: unknown): asserts runtime is AgentRuntimeKind | undefined {
  if (runtime === undefined || runtime === null) return;
  if (!isAgentRuntimeKind(runtime)) {
    throw new Error(`Invalid agent runtime: ${String(runtime)}`);
  }
  if (!getProviderTypesForRuntime(runtime).includes(type)) {
    throw new Error(`Provider type "${type}" does not support ${runtime}`);
  }
}

export function resolveProviderAgentRuntime(
  provider?: Pick<ProviderConfig, 'type' | 'connection'> | null,
): AgentRuntimeKind {
  const explicitRuntime = provider?.connection.agentRuntime;
  assertAgentRuntimeSupported(provider?.type ?? 'custom', explicitRuntime);
  if (explicitRuntime) return explicitRuntime;

  switch (provider?.type as ProviderType | undefined) {
    case 'openai':
    case 'ollama':
      return 'openai-agents-sdk';
    case 'custom':
      if (
        provider?.connection.openCodeModelJson ||
        provider?.connection.openCodeSdkModulePath
      ) {
        return 'opencode';
      }
      if (
        provider?.connection.qoderAccessToken ||
        provider?.connection.qoderCliPath
      ) {
        return 'qoder-agent-sdk';
      }
      if (
        provider?.connection.openaiProtocol ||
        provider?.connection.openaiBaseUrl ||
        provider?.connection.openaiApiKey
      ) {
        const hasClaudeSurface = Boolean(
          provider.connection.claudeBaseUrl ||
          provider.connection.claudeApiKey ||
          provider.connection.claudeAuthToken,
        );
        return hasClaudeSurface ? 'claude-agent-sdk' : 'openai-agents-sdk';
      }
      return 'claude-agent-sdk';
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
    default:
      return 'claude-agent-sdk';
  }
}

export function sharedKeyShouldUseClaudeAuthToken(type: ProviderType): boolean {
  return isDualSurfaceProviderType(type);
}

/**
 * Bedrock cross-region inference model IDs keyed by Anthropic-style short name.
 *
 * Bedrock rejects short names like 'claude-sonnet-5' with HTTP 400 invalid
 * model identifier; it requires the cross-region format
 * (for example us.anthropic.<model>). Kept in one place so the provider env
 * builder and the connection tester agree. See GitHub issue #179.
 */
export const BEDROCK_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-5': 'us.anthropic.claude-sonnet-5',
  'claude-opus-4-6': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

/**
 * Normalize a model ID for Bedrock. Short Anthropic names are mapped to their
 * cross-region IDs; anything that already looks like a Bedrock ID (contains a
 * '.') is passed through unchanged so user-provided region prefixes
 * (us./eu./apac.) and direct IDs are preserved — keeping Provider
 * Manager/runtime provider pinning semantics intact.
 */
export function normalizeBedrockModelId(model: string): string {
  if (model.includes('.')) return model;
  return BEDROCK_MODEL_MAP[model] ?? model;
}
