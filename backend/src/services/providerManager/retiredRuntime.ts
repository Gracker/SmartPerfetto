// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {optionalString} from '../../agentRuntime/engines/pi/piAgentCoreConfig';
import logger from '../../utils/logger';
import {
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
} from '../../agentRuntime/runtimeKinds';
import {isQoderByokEnvKey} from './envIsolation';
import {firstNonBlank} from './providerTypes';
import {previousProviderAgentRuntime, providerTypeHasApiSurfaceChoice} from './providerRuntimeMatrix';
import type {ProviderApiSurface, ProviderConfig, ProviderConnection} from './types';

/** Connection fields only the OpenCode and Qoder runtimes read. */
const RETIRED_RUNTIME_CONNECTION_FIELDS = [
  'openCodeSdkModulePath',
  'openCodeModelJson',
  'openCodeSystemPrompt',
  'qoderAccessToken',
  'qoderCliPath',
  'qoderModel',
  'qoderSystemPrompt',
] as const satisfies ReadonlyArray<keyof ProviderConnection>;

type MigratableProvider = Pick<ProviderConfig, 'type' | 'connection' | 'models' | 'custom'>;

function hasRetiredRuntimeState(provider: MigratableProvider): boolean {
  const {connection} = provider;
  return (connection.agentRuntime !== undefined && connection.agentRuntime !== PI_AGENT_CORE_RUNTIME_KIND)
    || RETIRED_RUNTIME_CONNECTION_FIELDS.some(field => connection[field] !== undefined)
    || Object.keys(provider.custom?.envOverrides ?? {}).some(isQoderByokEnvKey);
}

/**
 * The OpenAI-compatible endpoint, key and model an OpenCode model JSON named,
 * written into the provider's own fields: OpenCode preferred the JSON over
 * those fields, so Pi calls what OpenCode called. Unparsable JSON leaves the
 * fields as they are; Pi then reports a missing endpoint explicitly.
 */
function translateOpenCodeModel(
  connection: ProviderConnection,
  models: ProviderConfig['models'],
  rawModel: string | undefined,
): {connection: ProviderConnection; models: ProviderConfig['models']} {
  if (!rawModel?.trim()) return {connection, models};
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(rawModel) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {connection, models};
    parsed = value as Record<string, unknown>;
  } catch {
    return {connection, models};
  }
  const baseUrl = optionalString(parsed.baseURL) ?? optionalString(parsed.baseUrl);
  const apiKey = optionalString(parsed.apiKey);
  const modelId = optionalString(parsed.modelID) ?? optionalString(parsed.modelId)
    ?? optionalString(parsed.model) ?? optionalString(parsed.id);
  return {
    connection: {
      ...connection,
      ...(baseUrl ? {openaiBaseUrl: baseUrl} : {}),
      ...(apiKey ? {openaiApiKey: apiKey} : {}),
    },
    models: modelId && modelId !== models.primary ? {...models, primary: modelId} : models,
  };
}

function surfaceForRuntime(runtime: string): ProviderApiSurface | undefined {
  if (runtime === CLAUDE_AGENT_RUNTIME_KIND) return 'claude';
  if (runtime === OPENAI_AGENT_RUNTIME_KIND || runtime === OPENCODE_RUNTIME_KIND) return 'openai';
  return undefined;
}

const STORED_RECORD = Symbol('smartperfetto.storedProviderRecord');

/**
 * The record as the store held it before the read-time migration (the
 * provider itself when nothing migrated): what a retired runtime read, so its
 * frozen snapshot hash and request target are computed from the same input.
 * Kept under a symbol key, which spreads carry and JSON never persists.
 */
export function storedProviderRecord<T extends MigratableProvider>(provider: T): T {
  return ((provider as unknown as Record<symbol, T | undefined>)[STORED_RECORD]) ?? provider;
}

/**
 * A provider profile as Pi Agent Core runs it, read next to
 * `withoutRetiredTuning`: a retired `agentRuntime` (or OpenCode/Qoder state)
 * becomes Pi, with `apiSurface` recording the endpoint the retired runtime
 * called, and the fields only OpenCode or Qoder read are dropped. Nothing else
 * changes and no Pi model is persisted: Pi derives its model from these fields
 * at env time, so later edits keep working. Idempotent; the next normal save
 * writes the migrated profile.
 */
export function withMigratedAgentRuntime<T extends MigratableProvider>(
  provider: T,
  options: {keepRetiredEnvOverrides?: boolean} = {},
): T {
  if (!hasRetiredRuntimeState(provider)) return provider;
  let previous: string;
  try {
    previous = previousProviderAgentRuntime(provider);
  } catch {
    // An invalid recorded runtime stays as stored and fails closed where the profile is used.
    return provider;
  }
  let connection: ProviderConnection = {...provider.connection, agentRuntime: PI_AGENT_CORE_RUNTIME_KIND};
  let models = provider.models;
  if (previous === OPENCODE_RUNTIME_KIND) {
    ({connection, models} = translateOpenCodeModel(connection, models, provider.connection.openCodeModelJson));
    // OpenCode always called the Chat Completions surface.
    connection.openaiProtocol = 'chat_completions';
  }
  // A Qoder profile, or an OpenCode one that named no OpenAI-compatible endpoint,
  // has nothing Pi can call: it keeps its label, and Pi reports it explicitly
  // until the profile is given an endpoint and saved on Pi.
  const untranslatable = !connection.piAgentCoreModelJson?.trim() && (previous === QODER_AGENT_RUNTIME_KIND
    || (previous === OPENCODE_RUNTIME_KIND && !firstNonBlank(connection.openaiBaseUrl, connection.baseUrl)));
  if (untranslatable) {
    connection = provider.connection;
    models = provider.models;
  } else {
    for (const field of RETIRED_RUNTIME_CONNECTION_FIELDS) delete connection[field];
    const surface = surfaceForRuntime(previous);
    if (surface && providerTypeHasApiSurfaceChoice(provider.type)) connection.apiSurface = surface;
  }

  const envOverrides = options.keepRetiredEnvOverrides ? undefined : provider.custom?.envOverrides;
  const keptOverrides = envOverrides
    ? Object.fromEntries(Object.entries(envOverrides).filter(([key]) => !isQoderByokEnvKey(key)))
    : undefined;
  const custom = provider.custom && keptOverrides && Object.keys(keptOverrides).length !== Object.keys(envOverrides!).length
    ? {...provider.custom, envOverrides: keptOverrides}
    : provider.custom;
  if (connection === provider.connection && custom === provider.custom) return provider;
  return {
    ...provider,
    connection,
    models,
    ...(custom !== provider.custom ? {custom} : {}),
    [STORED_RECORD]: storedProviderRecord(provider),
  };
}

/**
 * A runtime value a client sent (API create/update, `POST /:id/runtime`,
 * `smp provider`): a retired value is accepted with a warning and applied as
 * the migration would, so the request lands on Pi.
 */
export function withRequestedAgentRuntime<T extends MigratableProvider>(provider: T, source: string): T {
  const requested = provider.connection.agentRuntime;
  if (requested === undefined || requested === PI_AGENT_CORE_RUNTIME_KIND) return provider;
  logger.warn('ProviderManager',
    `${source}: agentRuntime "${requested}" is retired; the provider runs on Pi Agent Core with the same endpoint and model.`);
  // The requested runtime decides the endpoint, over any surface recorded earlier.
  const {apiSurface: _recordedSurface, ...connection} = provider.connection;
  // Qoder BYOK overrides belonged to a Qoder profile only; sent with any other runtime they stay and are refused.
  const migrated = withMigratedAgentRuntime({...provider, connection},
    {keepRetiredEnvOverrides: requested !== QODER_AGENT_RUNTIME_KIND});
  // A write is the new record: nothing earlier was stored under it.
  const {[STORED_RECORD]: _request, ...written} = migrated as T & {[STORED_RECORD]?: T};
  return written as T;
}
