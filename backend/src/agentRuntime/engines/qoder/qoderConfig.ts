// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import { redactUrlForDiagnostics } from '../../envCredentialSources';
import { QODER_AGENT_RUNTIME_KIND } from '../../runtimeKinds';
import type { EngineCapabilities, RuntimeDiagnosticsPayload } from '../../runtimeDescriptorTypes';

export const QODER_PERSONAL_ACCESS_TOKEN_ENV = 'QODER_PERSONAL_ACCESS_TOKEN';
export const QODER_CLI_PATH_ENV = 'QODERCLI_PATH';
export const QODER_MODEL_ENV = 'QODER_MODEL';
export const QODER_LIGHT_MODEL_ENV = 'QODER_LIGHT_MODEL';
export const QODER_SYSTEM_PROMPT_ENV = 'SMARTPERFETTO_QODER_SYSTEM_PROMPT';
export const QODER_MAX_TURNS_ENV = 'QODER_MAX_TURNS';
export const QODER_QUICK_MAX_TURNS_ENV = 'QODER_QUICK_MAX_TURNS';
export const QODER_FULL_PER_TURN_MS_ENV = 'QODER_FULL_PER_TURN_MS';
export const QODER_QUICK_PER_TURN_MS_ENV = 'QODER_QUICK_PER_TURN_MS';
export const QODER_WORKER_RUNTIME_PATH_ENV = 'QODER_WORKER_RUNTIME_PATH';
export const QODER_SDK_MODULE_PATH_ENV = 'SMARTPERFETTO_QODER_SDK_MODULE_PATH';
export const QODER_BYOK_API_KEY_ENV = 'QODER_BYOK_API_KEY';
export const QODER_BYOK_PROVIDER_ENV = 'QODER_BYOK_PROVIDER';
export const QODER_BYOK_BASE_URL_ENV = 'QODER_BYOK_BASE_URL';
export const QODER_BYOK_STYLE_ENV = 'QODER_BYOK_STYLE';

type EnvLike = Record<string, string | undefined>;

export function getLocalQoderSdkModulePath(): string {
  return path.resolve(
    __dirname,
    '../../../../.qoder-sdk/node_modules/@qoder-ai/qoder-agent-sdk/dist/index.js',
  );
}

function qoderSdkInstalled(env: EnvLike): boolean {
  const configuredPath = env[QODER_SDK_MODULE_PATH_ENV]?.trim();
  if (configuredPath) return fs.existsSync(configuredPath);

  try {
    require.resolve('@qoder-ai/qoder-agent-sdk');
    return true;
  } catch {
    return fs.existsSync(getLocalQoderSdkModulePath());
  }
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function numericEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function getQoderEngineCapabilities(
  kind: string = QODER_AGENT_RUNTIME_KIND,
): EngineCapabilities {
  return {
    kind,
    displayName: 'Qoder Agent SDK',
    production: true,
    publicRuntime: true,
    promptCache: { systemPromptDynamicBoundary: false },
  };
}

export function getQoderRuntimeDiagnostics(
  env: EnvLike = process.env,
  kind: string = QODER_AGENT_RUNTIME_KIND,
): RuntimeDiagnosticsPayload {
  const token = env[QODER_PERSONAL_ACCESS_TOKEN_ENV]?.trim();
  const cliPath = env[QODER_CLI_PATH_ENV]?.trim();
  const model = env[QODER_MODEL_ENV]?.trim();
  const workerRuntimePath = env[QODER_WORKER_RUNTIME_PATH_ENV]?.trim();
  const sdkModulePath = env[QODER_SDK_MODULE_PATH_ENV]?.trim();
  const systemPrompt = env[QODER_SYSTEM_PROMPT_ENV]?.trim();
  const byokApiKey = env[QODER_BYOK_API_KEY_ENV]?.trim();
  const byokProvider = env[QODER_BYOK_PROVIDER_ENV]?.trim();
  const byokBaseUrl = env[QODER_BYOK_BASE_URL_ENV]?.trim();
  const byokStyle = env[QODER_BYOK_STYLE_ENV]?.trim();
  const byokRequested = Boolean(byokApiKey || byokProvider || byokBaseUrl || byokStyle);
  const byokConfigured = Boolean(byokApiKey && byokProvider && model);
  const localSdkModulePath = getLocalQoderSdkModulePath();

  return {
    runtime: kind,
    configured: Boolean(token) || Boolean(cliPath),
    sdkInstalled: qoderSdkInstalled(env),
    model: model || undefined,
    providerMode: byokConfigured
      ? 'qoder-byok'
      : byokRequested
        ? 'qoder-byok-incomplete'
        : 'qoder',
    modelConfigured: Boolean(model),
    sdkBinary: cliPath || undefined,
    sdkModule: sdkModulePath || (fs.existsSync(localSdkModulePath) ? localSdkModulePath : undefined),
    hasAccessToken: Boolean(token),
    hasWorkerRuntime: Boolean(workerRuntimePath),
    hasSystemPrompt: Boolean(systemPrompt),
    byokConfigured,
    byokApiKeyConfigured: Boolean(byokApiKey),
    byokProvider: byokProvider || undefined,
    byokBaseUrl: redactUrlForDiagnostics(byokBaseUrl),
    byokStyle: byokStyle || undefined,
    maxTurns: numericEnv(env[QODER_MAX_TURNS_ENV]),
    quickMaxTurns: numericEnv(env[QODER_QUICK_MAX_TURNS_ENV]),
  };
}

export interface QoderByokConfig {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  style?: string;
}

export interface QoderRuntimeConfig {
  maxTurns: number;
  quickMaxTurns: number;
  fullPerTurnMs: number;
  quickPerTurnMs: number;
  model?: string;
  lightModel?: string;
  systemPrompt?: string;
  hasAccessToken: boolean;
  cliPath?: string;
  workerRuntimePath?: string;
  byok: QoderByokConfig;
}

export function resolveQoderRuntimeConfig(env: EnvLike = process.env): QoderRuntimeConfig {
  return {
    maxTurns: numericEnv(env[QODER_MAX_TURNS_ENV]) ?? 100,
    quickMaxTurns: numericEnv(env[QODER_QUICK_MAX_TURNS_ENV]) ?? 50,
    fullPerTurnMs: numericEnv(env[QODER_FULL_PER_TURN_MS_ENV]) ?? 60_000,
    quickPerTurnMs: numericEnv(env[QODER_QUICK_PER_TURN_MS_ENV]) ?? 40_000,
    model: env[QODER_MODEL_ENV]?.trim() || undefined,
    lightModel: env[QODER_LIGHT_MODEL_ENV]?.trim() || undefined,
    systemPrompt: env[QODER_SYSTEM_PROMPT_ENV]?.trim() || undefined,
    hasAccessToken: Boolean(env[QODER_PERSONAL_ACCESS_TOKEN_ENV]?.trim()),
    cliPath: env[QODER_CLI_PATH_ENV]?.trim() || undefined,
    workerRuntimePath: env[QODER_WORKER_RUNTIME_PATH_ENV]?.trim() || undefined,
    byok: {
      apiKey: env[QODER_BYOK_API_KEY_ENV]?.trim() || undefined,
      provider: env[QODER_BYOK_PROVIDER_ENV]?.trim() || undefined,
      baseUrl: env[QODER_BYOK_BASE_URL_ENV]?.trim() || undefined,
      style: env[QODER_BYOK_STYLE_ENV]?.trim() || undefined,
    },
  };
}

export { truthyEnv, numericEnv, type EnvLike };
