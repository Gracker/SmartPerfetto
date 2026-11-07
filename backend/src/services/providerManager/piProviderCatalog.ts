// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {PI_AGENT_CORE_MODEL_JSON_ENV, piProviderApiKeyEnvNames} from '../../agentRuntime/engines/pi/piAgentCoreConfig';
import {PI_CATALOG_ROUTES} from './providerTypes';
import type {ProviderConfig, ProviderType} from './types';

type PiCatalogProviderType = keyof typeof PI_CATALOG_ROUTES;

export function isPiCatalogProviderType(type: ProviderType): type is PiCatalogProviderType {
  return Object.prototype.hasOwnProperty.call(PI_CATALOG_ROUTES, type);
}

/**
 * The Pi env for a catalog-backed provider without an explicit model JSON: a
 * deterministic catalog reference for the primary model on the provider's own
 * endpoint, the lowest supported reasoning level unless one is authored, and
 * the API key under Pi's own key env for that catalog provider (never
 * ANTHROPIC_* or OPENAI_*).
 */
export function piCatalogProviderEnv(provider: ProviderConfig): Record<string, string> | undefined {
  if (!isPiCatalogProviderType(provider.type)) return undefined;
  const route = PI_CATALOG_ROUTES[provider.type];
  const {connection} = provider;
  const baseUrl = route.surface === 'openai'
    ? connection.openaiBaseUrl || connection.baseUrl
    : connection.claudeBaseUrl || connection.baseUrl;
  const keyEnv = piProviderApiKeyEnvNames(route.catalogProviders[0])[0];
  const apiKey = connection.apiKey?.trim();
  return {
    [PI_AGENT_CORE_MODEL_JSON_ENV]: JSON.stringify({
      catalog: {
        providers: route.catalogProviders,
        id: provider.models.primary,
        ...(baseUrl ? {baseUrl} : {}),
        defaultThinkingLevel: 'lowest_supported',
      },
      apiKeyEnv: keyEnv,
    }),
    ...(apiKey ? {[keyEnv]: apiKey} : {}),
  };
}
