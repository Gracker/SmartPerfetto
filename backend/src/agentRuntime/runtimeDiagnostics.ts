// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getProductionRuntimeDescriptor } from './runtimeDescriptors';
import type {
  RuntimeDiagnosticsInput,
  RuntimeDiagnosticsPayload,
} from './runtimeDescriptorTypes';
import type { RuntimeSelection } from './runtimeSelection';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
  isProductionAgentRuntimeKind,
  type ExperimentalAgentRuntimeKind,
} from './runtimeKinds';

type RuntimeDiagnosticsResolver<K extends string = string> =
  (input: RuntimeDiagnosticsInput<K>) => RuntimeDiagnosticsPayload;

const EXPERIMENTAL_RUNTIME_DIAGNOSTICS: Record<ExperimentalAgentRuntimeKind, RuntimeDiagnosticsResolver> = {
  [EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND]: ({ env, kind }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getPiAgentCoreRuntimeDiagnostics } = require('./engines/pi/piAgentCoreRuntime') as typeof import('./engines/pi/piAgentCoreRuntime');
    return getPiAgentCoreRuntimeDiagnostics(
      env,
      kind as Parameters<typeof getPiAgentCoreRuntimeDiagnostics>[1],
    );
  },
  [EXPERIMENTAL_OPENCODE_RUNTIME_KIND]: ({ env, kind }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getOpenCodeRuntimeDiagnostics } = require('./engines/opencode/openCodeRuntime') as typeof import('./engines/opencode/openCodeRuntime');
    return getOpenCodeRuntimeDiagnostics(
      env,
      kind as Parameters<typeof getOpenCodeRuntimeDiagnostics>[1],
    );
  },
};

const MODEL_FALLBACK_BY_RUNTIME: Record<string, { model: string; requiresModelConfigured?: boolean }> = {
  [PI_AGENT_CORE_RUNTIME_KIND]: { model: 'pi-agent-core', requiresModelConfigured: true },
  [EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND]: { model: 'pi-agent-core', requiresModelConfigured: true },
  [OPENCODE_RUNTIME_KIND]: { model: 'opencode' },
  [EXPERIMENTAL_OPENCODE_RUNTIME_KIND]: { model: 'opencode' },
  [QODER_AGENT_RUNTIME_KIND]: { model: 'qoder' },
};

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
  return value as RuntimeDiagnosticsPayload;
}

export function getRuntimeDiagnostics(
  selection: Pick<RuntimeSelection<string>, 'kind' | 'source' | 'providerId'>,
  input: GetRuntimeDiagnosticsInput = {},
): RuntimeDiagnosticsPayload {
  const env = input.env ?? process.env;
  const selectedProviderId = input.selectedProviderId !== undefined
    ? input.selectedProviderId
    : providerIdFromSelection(selection);

  if (isProductionAgentRuntimeKind(selection.kind)) {
    const descriptor = getProductionRuntimeDescriptor(selection.kind);
    return asRuntimeDiagnosticsPayload(
      descriptor.getDiagnostics({
        env,
        kind: descriptor.kind,
        selectedProviderId,
      }),
      descriptor.kind,
    );
  }

  const resolver = EXPERIMENTAL_RUNTIME_DIAGNOSTICS[selection.kind as ExperimentalAgentRuntimeKind];
  if (!resolver) {
    throw new Error(`Unsupported agent runtime diagnostics: ${selection.kind}`);
  }
  return asRuntimeDiagnosticsPayload(
    resolver({
      env,
      kind: selection.kind,
      selectedProviderId,
    }),
    selection.kind,
  );
}

export function getRuntimeDiagnosticModel(diagnostics: RuntimeDiagnosticsPayload): string {
  if (typeof diagnostics.model === 'string') return diagnostics.model;

  const fallback = MODEL_FALLBACK_BY_RUNTIME[diagnostics.runtime];
  if (!fallback) return '';
  if (fallback.requiresModelConfigured && diagnostics.modelConfigured !== true) return '';
  return fallback.model;
}

export function getRuntimeDiagnosticProviderMode(diagnostics: RuntimeDiagnosticsPayload): string {
  return typeof diagnostics.providerMode === 'string'
    ? diagnostics.providerMode
    : diagnostics.runtime;
}
