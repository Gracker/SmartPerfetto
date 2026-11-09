// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  supportsRuntimeProviderType,
} from '../../agentRuntime/runtimeDescriptors';
import {
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
  SELECTABLE_RUNTIME_KINDS,
  isProductionAgentRuntimeKind,
  isRecordedProductionRuntimeKind,
  type RecordedProductionRuntimeKind,
  type SelectableAgentRuntimeKind,
} from '../../agentRuntime/runtimeKinds';
import {legacyAgentRuntimeFallback} from '../../agentRuntime/legacyRuntimeFallback';
import type {
  AgentRuntimeKind,
  DualSurfaceProviderType,
  ProviderConfig,
  ProviderConnection,
  ProviderType,
} from './types';
import { DUAL_SURFACE_PROVIDER_TYPES, PI_CATALOG_ROUTES, firstNonBlank } from './providerTypes';
import { invalidProviderRequest } from './providerRequestError';

export { DUAL_SURFACE_PROVIDER_TYPES };

export function isDualSurfaceProviderType(type: ProviderType): type is DualSurfaceProviderType {
  return DUAL_SURFACE_PROVIDER_TYPES.includes(type as DualSurfaceProviderType);
}

/** Types with both an Anthropic-compatible and an OpenAI-compatible endpoint to choose from. */
export function providerTypeHasApiSurfaceChoice(type: ProviderType): boolean {
  return type === 'custom' || isDualSurfaceProviderType(type);
}

export function supportsAgentRuntimeType(type: ProviderType, runtime: AgentRuntimeKind): boolean {
  return supportsRuntimeProviderType(type, runtime);
}

/** The runtimes a provider of this type may select: only selectable kinds its descriptors accept. */
export function supportedAgentRuntimesForType(type: ProviderType): SelectableAgentRuntimeKind[] {
  return SELECTABLE_RUNTIME_KINDS.filter(runtime => supportsAgentRuntimeType(type, runtime));
}

/** A provider-shaped API object with the runtimes its type may select, so clients need no type table. */
export function withSupportedRuntimes<T extends {type: ProviderType}>(value: T): T & {supportedRuntimes: SelectableAgentRuntimeKind[]} {
  return {...value, supportedRuntimes: supportedAgentRuntimesForType(value.type)};
}

function piCatalogRouteSurfaces(type: ProviderType): string[] {
  return Object.prototype.hasOwnProperty.call(PI_CATALOG_ROUTES, type)
    ? [PI_CATALOG_ROUTES[type as keyof typeof PI_CATALOG_ROUTES].surface]
    : [];
}

/**
 * A `/templates` entry with the API-surface facts of its type, read from the
 * tables Pi resolves routes from so clients need no copy of them.
 */
export function withTemplateApiSurfaces<T extends {type: ProviderType}>(value: T): T & {
  supportedRuntimes: SelectableAgentRuntimeKind[];
  piCatalogRouteSurfaces: string[];
  defaultApiSurface: string;
} {
  return {
    ...withSupportedRuntimes(value),
    piCatalogRouteSurfaces: piCatalogRouteSurfaces(value.type),
    defaultApiSurface: defaultRuntimeForType(value.type) === OPENAI_AGENT_RUNTIME_KIND ? 'openai' : 'claude',
  };
}

/**
 * A runtime value recorded for, or requested by, a provider of this type: Pi,
 * or a retired runtime the type supported (it maps to Pi). Anything else is
 * invalid.
 */
export function assertAgentRuntimeSupported(type: ProviderType, runtime?: unknown): asserts runtime is RecordedProductionRuntimeKind | undefined {
  if (runtime === undefined || runtime === null) return;
  if (!isRecordedProductionRuntimeKind(runtime)) {
    throw invalidProviderRequest(`Invalid agent runtime: ${String(runtime)}`);
  }
  // The removed OpenCode and Qoder engines ran custom providers only.
  const supported = isProductionAgentRuntimeKind(runtime) ? supportsAgentRuntimeType(type, runtime) : type === 'custom';
  if (!supported) {
    throw invalidProviderRequest(`Provider type "${type}" does not support ${runtime}`);
  }
}

/** The endpoint family a type speaks when its record names none; Claude for all but the OpenAI-native types. */
function defaultRuntimeForType(type: ProviderType): typeof CLAUDE_AGENT_RUNTIME_KIND | typeof OPENAI_AGENT_RUNTIME_KIND {
  return type === 'openai' || type === 'ollama' ? OPENAI_AGENT_RUNTIME_KIND : CLAUDE_AGENT_RUNTIME_KIND;
}

/** A provider record with the facts clients need to edit it: its runtimes and the surface it really uses. */
export function withProviderRecordFacts<T extends Pick<ProviderConfig, 'type' | 'connection'>>(value: T) {
  const previous = previousProviderAgentRuntime(value);
  const effectiveApiSurface = previous === CLAUDE_AGENT_RUNTIME_KIND ? 'claude' as const
    : previous === OPENAI_AGENT_RUNTIME_KIND ? 'openai' as const : undefined;
  return {...withSupportedRuntimes(value), ...(effectiveApiSurface ? {effectiveApiSurface} : {})};
}

function surfaceRuntime(surface: ProviderConnection['apiSurface']): AgentRuntimeKind | undefined {
  if (surface === 'claude') return CLAUDE_AGENT_RUNTIME_KIND;
  if (surface === 'openai') return OPENAI_AGENT_RUNTIME_KIND;
  return undefined;
}

/**
 * The runtime this record ran on before Pi Agent Core became the only runtime,
 * which decides the endpoint, protocol, model and credential form Pi keeps:
 * the recorded `apiSurface`; a retired value still stored (a record read
 * before its next save); Pi itself for a profile that already ran on Pi (an
 * explicit model JSON or a frozen catalog route); otherwise the type's former
 * default.
 */
export function previousProviderAgentRuntime(
  provider?: Pick<ProviderConfig, 'type' | 'connection'> | null,
): RecordedProductionRuntimeKind {
  const type = (provider?.type ?? 'custom') as ProviderType;
  const connection = provider?.connection ?? {};
  const storedRuntime = connection.agentRuntime;
  assertAgentRuntimeSupported(type, storedRuntime);
  const surface = providerTypeHasApiSurfaceChoice(type) ? surfaceRuntime(connection.apiSurface) : undefined;
  if (surface) return surface;
  if (storedRuntime && storedRuntime !== PI_AGENT_CORE_RUNTIME_KIND) return storedRuntime;
  if (storedRuntime === PI_AGENT_CORE_RUNTIME_KIND
    && (connection.piAgentCoreModelJson?.trim() || Object.prototype.hasOwnProperty.call(PI_CATALOG_ROUTES, type))) {
    return PI_AGENT_CORE_RUNTIME_KIND;
  }

  if (type === 'custom') {
    // OpenCode/Qoder fields named the runtime only for a record that recorded none.
    if (!storedRuntime && (connection.openCodeModelJson || connection.openCodeSdkModulePath)) return OPENCODE_RUNTIME_KIND;
    if (!storedRuntime && (connection.qoderAccessToken || connection.qoderCliPath)) return QODER_AGENT_RUNTIME_KIND;
    if (connection.openaiProtocol || firstNonBlank(connection.openaiBaseUrl) || connection.openaiApiKey) {
      const hasClaudeSurface = Boolean(firstNonBlank(connection.claudeBaseUrl) || connection.claudeApiKey || connection.claudeAuthToken);
      return hasClaudeSurface ? CLAUDE_AGENT_RUNTIME_KIND : OPENAI_AGENT_RUNTIME_KIND;
    }
  }
  return defaultRuntimeForType(type);
}

/**
 * The runtime a provider runs on now. The hidden legacy opt-in restores only
 * the engine a record actually ran on: a record whose previous runtime is a
 * different engine runs on Pi, whose route preserves that record's own
 * endpoint and credential, so the opt-in can never move a key to another host.
 * The recorded value is still validated, so a corrupt record fails closed.
 */
export function resolveProviderAgentRuntime(
  provider?: Pick<ProviderConfig, 'type' | 'connection'> | null,
): AgentRuntimeKind {
  const previous = previousProviderAgentRuntime(provider);
  const legacy = legacyAgentRuntimeFallback();
  return legacy && previous === legacy ? legacy : PI_AGENT_CORE_RUNTIME_KIND;
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
