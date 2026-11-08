// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {providerConfigurationHelp} from '../services/providerManager/providerConfigurationHelp';
import {localize, parseOutputLanguage} from '../agentv3/outputLanguage';
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
    if (value.runtime === QODER_AGENT_RUNTIME_KIND) {
      // Qoder's `configured` flag records an explicit PAT/CLI path, not runtime
      // readiness: an installed SDK may authenticate through local qodercli.
      const language = parseOutputLanguage(env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      const help = value.sdkInstalled === true
        ? localize(
          language,
          'Qoder Agent SDK 已安装；可以使用本机 qodercli 登录态，认证会在分析时验证。也可显式设置 QODER_PERSONAL_ACCESS_TOKEN 或 QODERCLI_PATH。',
          'Qoder Agent SDK is installed; it may use the local qodercli login, which is verified during analysis. You can alternatively set QODER_PERSONAL_ACCESS_TOKEN or QODERCLI_PATH.',
        )
        : localize(
          language,
          'Qoder Agent SDK 未安装；请先审阅其条款并显式安装可选 SDK，再使用本机 qodercli 登录态、QODER_PERSONAL_ACCESS_TOKEN 或 QODERCLI_PATH。',
          'Qoder Agent SDK is not installed. Review its terms and explicitly install the optional SDK, then use the local qodercli login, QODER_PERSONAL_ACCESS_TOKEN, or QODERCLI_PATH.',
        );
      const detail = typeof value.configHint === 'string' && value.configHint !== help
        ? `\n\n${value.configHint}`
        : '';
      return {...value, runtime: value.runtime, configured: value.configured, configHint: help + detail};
    }
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
  const selectedProviderId = input.selectedProviderId !== undefined
    ? input.selectedProviderId
    : providerIdFromSelection(selection);
  // A selected provider's runtime config lives in its provider env, as for the runtime itself.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {createRuntimeFactoryEnv} = require('./runtimeFactoryEnv') as typeof import('./runtimeFactoryEnv');
  const env = selectedProviderId
    ? createRuntimeFactoryEnv({source: 'provider', providerId: selectedProviderId}, undefined, input.env ?? process.env)
    : createRuntimeFactoryEnv({source: selection.source, kind: selection.kind}, undefined, input.env ?? process.env);

  if (isProductionAgentRuntimeKind(selection.kind)) {
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
    env,
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
