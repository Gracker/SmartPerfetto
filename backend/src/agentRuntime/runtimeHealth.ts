// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { isKeylessLocalMode, serverConfig } from '../config';
import { collectEnvCredentialSources } from './envCredentialSources';
import { resolveAgentRuntimeSelectionForDiagnostics } from './runtimeSelection';
import { getProviderService } from '../services/providerManager';
import { getSmartPerfettoVersion } from '../version';
import {
  getRuntimeDiagnosticModel,
  getRuntimeDiagnosticProviderMode,
  getRuntimeDiagnostics,
} from './runtimeDiagnostics';
import { getAiCapabilityPolicy } from '../services/aiCapabilityPolicy';

export function buildRuntimeHealthPayload(now: Date = new Date()) {
  const aiPolicy = getAiCapabilityPolicy();
  const {selection: runtimeSelection, providerStoreError} = resolveAgentRuntimeSelectionForDiagnostics();
  const providerSvc = getProviderService();
  const activeProvider = providerSvc.list().find(p => p.isActive);
  const selectedDiagnostics = getRuntimeDiagnostics(runtimeSelection, {
    env: process.env,
  });
  const selectedModel = getRuntimeDiagnosticModel(selectedDiagnostics);
  const selectedProviderMode = getRuntimeDiagnosticProviderMode(selectedDiagnostics);
  const envSources = collectEnvCredentialSources(process.env, 'health');
  const providerOverridesEnv = runtimeSelection.source === 'provider' && envSources.length > 0;

  return {
    status: 'OK',
    timestamp: now.toISOString(),
    environment: serverConfig.nodeEnv,
    version: getSmartPerfettoVersion(),
    aiPolicy,
    aiEngine: {
      runtime: runtimeSelection.kind,
      model: selectedModel,
      providerMode: selectedProviderMode,
      aiEnabled: aiPolicy.aiEnabled,
      ...(aiPolicy.disabledReason ? { disabledReason: aiPolicy.disabledReason } : {}),
      // An analysis that follows the active provider is refused while
      // providers.json is unreadable, whatever env would configure.
      configured: selectedDiagnostics.configured && !providerStoreError,
      source: runtimeSelection.source,
      credentialSource: providerStoreError
        ? 'provider-store-unreadable'
        : runtimeSelection.source === 'provider'
          ? 'provider-manager'
          : 'env-or-default',
      ...(providerStoreError
        ? {providerStore: {status: 'unreadable', code: providerStoreError.code}}
        : {}),
      envCredentialSources: envSources,
      providerOverridesEnv,
      ...(activeProvider ? {
        activeProvider: {
          id: activeProvider.id,
          name: activeProvider.name,
          type: activeProvider.type,
        },
      } : {}),
      authRequired: !isKeylessLocalMode(),
      diagnostics: selectedDiagnostics,
    },
  };
}
