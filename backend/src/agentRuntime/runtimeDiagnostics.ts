// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {providerConfigurationHelp} from '../services/providerManager/providerConfigurationHelp';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import { getProductionRuntimeDescriptor } from './runtimeDescriptors';
import type { RuntimeDiagnosticsPayload } from './runtimeDescriptorTypes';
import type { RuntimeSelection } from './runtimeSelection';
import {
  PI_AGENT_CORE_RUNTIME_KIND,
  isProductionAgentRuntimeKind,
} from './runtimeKinds';

export interface GetRuntimeDiagnosticsInput {
  env?: Record<string, string | undefined>;
  selectedProviderId?: string | null;
}

function providerIdFromSelection(selection: Pick<RuntimeSelection<string>, 'source' | 'providerId'>): string | null {
  return selection.source === 'provider' ? selection.providerId ?? null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asRuntimeDiagnosticsPayload(
  value: unknown,
  kind: string,
  env: Record<string, string | undefined> = process.env,
): RuntimeDiagnosticsPayload {
  if (!isRecord(value)) {
    throw new Error(`Runtime diagnostics for ${kind} must return an object`);
  }
  if (typeof value.runtime !== 'string') {
    throw new Error(`Runtime diagnostics for ${kind} must include a string runtime`);
  }
  if (typeof value.configured !== 'boolean') {
    throw new Error(`Runtime diagnostics for ${kind} must include a boolean configured flag`);
  }
  if (!value.configured) {
    const help = providerConfigurationHelp(parseOutputLanguage(env.SMARTPERFETTO_OUTPUT_LANGUAGE));
    const detail = typeof value.configHint === 'string' && value.configHint !== help
      ? `\n\n${value.configHint}`
      : '';
    return {...value, runtime: value.runtime, configured: value.configured, configHint: help + detail};
  }
  return value as RuntimeDiagnosticsPayload;
}

export function getRuntimeDiagnostics(
  selection: Pick<RuntimeSelection<string>, 'kind' | 'source' | 'providerId'>,
  input: GetRuntimeDiagnosticsInput = {},
): RuntimeDiagnosticsPayload {
  if (!isProductionAgentRuntimeKind(selection.kind)) {
    throw new Error(`Unsupported agent runtime diagnostics: ${selection.kind}`);
  }
  const selectedProviderId = input.selectedProviderId !== undefined
    ? input.selectedProviderId
    : providerIdFromSelection(selection);
  // A selected provider's runtime config lives in its provider env, as for the runtime itself.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {createRuntimeFactoryEnv} = require('./runtimeFactoryEnv') as typeof import('./runtimeFactoryEnv');
  const env = selectedProviderId
    ? createRuntimeFactoryEnv({source: 'provider', providerId: selectedProviderId}, undefined, input.env ?? process.env)
    : createRuntimeFactoryEnv({source: selection.source, kind: selection.kind}, undefined, input.env ?? process.env);

  const descriptor = getProductionRuntimeDescriptor(selection.kind);
  return asRuntimeDiagnosticsPayload(
    descriptor.getDiagnostics({
      env,
      kind: descriptor.kind,
      selectedProviderId,
    }),
    descriptor.kind,
    env,
  );
}

export function getRuntimeDiagnosticModel(diagnostics: RuntimeDiagnosticsPayload): string {
  if (typeof diagnostics.model === 'string') return diagnostics.model;

  // Pi reports no model id of its own; a configured Pi model is named by the runtime.
  return diagnostics.runtime === PI_AGENT_CORE_RUNTIME_KIND && diagnostics.modelConfigured === true
    ? PI_AGENT_CORE_RUNTIME_KIND : '';
}

export function getRuntimeDiagnosticProviderMode(diagnostics: RuntimeDiagnosticsPayload): string {
  return typeof diagnostics.providerMode === 'string'
    ? diagnostics.providerMode
    : diagnostics.runtime;
}
