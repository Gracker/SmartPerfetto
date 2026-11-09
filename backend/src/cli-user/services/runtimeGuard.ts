// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { providerConfigurationHelp } from '../../services/providerManager/providerConfigurationHelp';
import { parseOutputLanguage } from '../../agentv3/outputLanguage';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import {
  resolveAgentRuntimeSelection,
  resolveAgentRuntimeSelectionForDiagnostics,
  type RuntimeSelection,
} from '../../agentRuntime/runtimeSelection';
import {
  getRuntimeDiagnostics,
} from '../../agentRuntime/runtimeDiagnostics';
import { runtimeDeprecationNotices } from '../../agentRuntime/legacyRuntimeFallback';
import type { RuntimeDiagnosticsPayload } from '../../agentRuntime/runtimeDescriptorTypes';
import type { RecordedRuntimeKind } from '../../agentRuntime/runtimeKinds';
import { PI_AGENT_CORE_RUNTIME_KIND } from '../../agentRuntime/runtimeKinds';
import { hasOpenAICredentials } from '../../agentOpenAI/openAiConfig';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { getProviderService } from '../../services/providerManager';
import {
  assertAiFeatureEnabled,
  getAiCapabilityPolicy,
  type AiCapabilityFeature,
  type AiCapabilityPolicyV1,
} from '../../services/aiCapabilityPolicy';
import { parseAdbDevices } from './androidCapture';
import { resolveAdbTool, resolveTraceboxTool } from './captureTools';
import type { CaptureToolResolution } from '../types';

export interface RuntimeGuardResult {
  selection: RuntimeSelection;
  diagnostics: RuntimeDiagnosticsPayload;
}

export interface RuntimeGuardOptions {
  providerId?: string | null;
  runtimeOverride?: RecordedRuntimeKind;
  aiFeature?: AiCapabilityFeature;
}

function providerIdFor(selection: RuntimeSelection): string | null {
  return selection.source === 'provider' ? selection.providerId ?? null : null;
}

function chosenSdkBinaryPath(sdkBinary: unknown): string | undefined {
  if (typeof sdkBinary !== 'object' || sdkBinary === null) return undefined;
  const chosenPath = (sdkBinary as { chosenPath?: unknown }).chosenPath;
  return typeof chosenPath === 'string' ? chosenPath : undefined;
}

function buildSqliteNativeCheck(): DoctorCheck {
  try {
    const Database = (require('../../services/sqliteDatabase') as typeof import('../../services/sqliteDatabase')).default;
    const database = new Database(':memory:');
    try {
      const row = database.prepare('SELECT 1 AS value').get() as {value: number} | undefined;
      if (row?.value !== 1) throw new Error('SQLite native probe returned an unexpected result');
    } finally {
      database.close();
    }
    return {
      name: 'sqlite_native',
      ok: true,
      status: 'ok',
      message: 'SQLite native binding can open, query and close an in-memory database',
    };
  } catch (error) {
    return {
      name: 'sqlite_native',
      ok: false,
      status: 'error',
      message: 'SQLite native binding is unavailable on this platform. Use Node.js 24 on a supported platform, or rebuild better-sqlite3; see docs/reference/cli.md.',
      details: {error: error instanceof Error ? error.message : String(error)},
    };
  }
}

const PI_SETUP_HINT =
  'Configure an active provider (any template or custom), set the Anthropic/OpenAI/Bedrock/Vertex env your endpoint uses, ' +
  'or set SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON.';

function piSetupHint(diagnostics: RuntimeDiagnosticsPayload): string {
  return typeof diagnostics.modelUnavailableReason === 'string' && typeof diagnostics.configHint === 'string'
    ? diagnostics.configHint
    : PI_SETUP_HINT;
}

function runtimeNotReadyError(problem: string, remedy: string): Error {
  return new Error([
    problem,
    remedy,
    providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli'),
    'Run `smp doctor --format text` for the resolved runtime and provider details.',
  ].join(' '));
}

export function assertAnalysisRuntimeReady(options: RuntimeGuardOptions = {}): RuntimeGuardResult {
  assertAiFeatureEnabled(options.aiFeature ?? 'agent_analyze');
  const selection = resolveAgentRuntimeSelection(options.providerId, options.runtimeOverride);
  const providerId = providerIdFor(selection);
  const diagnostics = getRuntimeDiagnostics(selection);

  if (selection.kind === 'openai-agents-sdk') {
    if (!hasOpenAICredentials(providerId)) {
      throw runtimeNotReadyError(
        'OpenAI runtime is selected but no usable OpenAI-compatible credentials were found.',
        'Set OPENAI_API_KEY, configure an active OpenAI/Ollama provider, or use a localhost OpenAI-compatible endpoint.',
      );
    }
    return { selection, diagnostics };
  }

  if (selection.kind === PI_AGENT_CORE_RUNTIME_KIND) {
    if (diagnostics.configured !== true) {
      throw runtimeNotReadyError('Pi Agent Core runtime is selected but no Pi model is configured.', piSetupHint(diagnostics));
    }
    return { selection, diagnostics };
  }

  if (!isClaudeSdkBinaryUsable(diagnostics.sdkBinary)) {
    const chosenPath = chosenSdkBinaryPath(diagnostics.sdkBinary);
    throw new Error(
      [
        'Claude Agent SDK runtime is selected but its native binary is not executable.',
        chosenPath
          ? `Resolved binary: ${chosenPath}`
          : 'No SDK native binary was resolved.',
        'Reinstall backend dependencies, or set CLAUDE_BINARY_PATH to an executable Claude Agent SDK binary.',
      ].join(' '),
    );
  }

  if (!diagnostics.configured) {
    throw new Error(
      `Claude Agent SDK has no configured credentials. ${providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli')}`,
    );
  }
  return { selection, diagnostics };
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  node: {
    version: string;
    expected: string;
    ok: boolean;
  };
  cliHome: string;
  aiPolicy: AiCapabilityPolicyV1;
  runtime: RuntimeSelection;
  runtimeDiagnostics: RuntimeDiagnosticsPayload;
  traceProcessor: {
    path: string;
    exists: boolean;
    executable: boolean;
  };
  captureTools: {
    adb: CaptureToolResolution;
    tracebox: CaptureToolResolution;
    devices: {
      count: number;
      readyCount: number;
      serials: string[];
    };
  };
  providers: {
    count: number;
    active?: {
      id: string;
      name: string;
      type: string;
    };
  };
  checks: DoctorCheck[];
}

export function collectDoctorReport(cliHome: string): DoctorReport {
  const aiPolicy = getAiCapabilityPolicy();
  const {selection, providerStoreError} = resolveAgentRuntimeSelectionForDiagnostics();
  const runtimeDiagnostics = getRuntimeDiagnostics(selection);
  const traceProcessorPath = getTraceProcessorPath();
  const traceProcessorExists = fs.existsSync(traceProcessorPath);
  const traceProcessorExecutable = traceProcessorExists && isExecutable(traceProcessorPath);
  const adb = resolveAdbTool();
  const tracebox = resolveTraceboxTool();
  const adbDevices = collectAdbDevices(adb);
  const providerSvc = getProviderService();
  const providers = providerSvc.list();
  const active = providers.find((p) => p.isActive);
  const nodeMajor = Number.parseInt(process.version.replace(/^v/, '').split('.')[0] || '0', 10);

  // Analyses following the active provider are refused while providers.json is unreadable.
  const runtimeConfigured = !providerStoreError && runtimeDiagnostics.configured;
  const runtimeStatus: DoctorCheck['status'] = aiPolicy.aiEnabled
    ? runtimeConfigured ? 'ok' : 'error'
    : 'warn';
  const runtimeOk = aiPolicy.aiEnabled ? runtimeConfigured : true;
  const runtimeMessage = aiPolicy.aiEnabled
    ? providerStoreError
      ? providerStoreError.message
      : runtimeDiagnostics.configured
      ? `${selection.kind} credentials/configuration detected`
      : selection.kind === 'claude-agent-sdk'
        ? 'Claude SDK has no configured credentials.'
        : selection.kind === PI_AGENT_CORE_RUNTIME_KIND
          ? piSetupHint(runtimeDiagnostics)
          : 'OpenAI runtime needs OPENAI_API_KEY or a localhost/OpenAI-compatible provider'
    : 'AI is disabled; runtime credentials are not required for deterministic CLI flows';

  const deprecationNotices = runtimeDeprecationNotices();
  const checks: DoctorCheck[] = [
    {
      name: 'node',
      ok: nodeMajor >= 24 && nodeMajor < 25,
      status: nodeMajor >= 24 && nodeMajor < 25 ? 'ok' : 'error',
      message: `Node.js ${process.version} (expected >=24 <25)`,
    },
    buildSqliteNativeCheck(),
    {
      name: 'ai_policy',
      ok: aiPolicy.aiEnabled || aiPolicy.env?.valid === true,
      status: aiPolicy.aiEnabled ? 'ok' : aiPolicy.env?.valid === false ? 'error' : 'warn',
      message: aiPolicy.aiEnabled
        ? 'AI-backed analysis is enabled'
        : aiPolicy.disabledReason ?? 'AI-backed analysis is disabled',
      details: {
        source: aiPolicy.source,
        envValid: aiPolicy.env?.valid ?? null,
      },
    },
    {
      name: 'runtime',
      ok: runtimeOk,
      status: runtimeStatus,
      message: aiPolicy.aiEnabled &&
        !providerStoreError &&
        !runtimeDiagnostics.configured
        ? `${runtimeMessage} ${providerConfigurationHelp(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE), 'cli')}`
        : runtimeMessage,
      details: {
        source: selection.source,
        providerId: selection.providerId,
        providerName: selection.providerName,
        ...(providerStoreError ? {code: providerStoreError.code} : {}),
      },
    },
    ...(deprecationNotices.length > 0
      ? [{
          name: 'runtime_deprecation',
          ok: true,
          status: 'warn' as const,
          message: deprecationNotices.join(' '),
        }]
      : []),
    ...(aiPolicy.aiEnabled && selection.kind === 'claude-agent-sdk'
      ? [buildClaudeSdkBinaryCheck(runtimeDiagnostics.sdkBinary)]
      : []),
    {
      name: 'trace_processor_shell',
      ok: traceProcessorExists && traceProcessorExecutable,
      status: traceProcessorExists && traceProcessorExecutable ? 'ok' : 'warn',
      message: traceProcessorExists
        ? traceProcessorExecutable
          ? 'trace_processor_shell is present and executable'
          : 'trace_processor_shell exists but is not executable'
        : 'trace_processor_shell is missing; CLI will download the pinned binary on first trace command',
      details: { path: traceProcessorPath },
    },
    {
      name: 'adb',
      ok: adb.exists && adb.executable,
      status: adb.exists && adb.executable ? 'ok' : 'warn',
      message: adb.exists && adb.executable
        ? `adb is available (${adb.source})`
        : 'adb is not available; Android capture needs ADB_PATH, bundled adb, or adb on PATH',
      details: { path: adb.path, source: adb.source, devices: adbDevices.readyCount },
    },
    {
      name: 'tracebox',
      ok: tracebox.exists && tracebox.executable,
      status: tracebox.exists && tracebox.executable ? 'ok' : 'warn',
      message: tracebox.exists && tracebox.executable
        ? `tracebox is available for sideload capture (${tracebox.source})`
        : 'tracebox is not bundled; sideload capture requires --tracebox or an approved packaged binary',
      details: { path: tracebox.path, source: tracebox.source },
    },
  ];

  return {
    ok: checks.every((c) => c.status !== 'error'),
    generatedAt: new Date().toISOString(),
    node: {
      version: process.version,
      expected: '>=24.0.0 <25.0.0',
      ok: nodeMajor >= 24 && nodeMajor < 25,
    },
    cliHome,
    aiPolicy,
    runtime: selection,
    runtimeDiagnostics,
    traceProcessor: {
      path: traceProcessorPath,
      exists: traceProcessorExists,
      executable: traceProcessorExecutable,
    },
    captureTools: {
      adb,
      tracebox,
      devices: adbDevices,
    },
    providers: {
      count: providers.length,
      ...(active ? { active: { id: active.id, name: active.name, type: active.type } } : {}),
    },
    checks,
  };
}

function collectAdbDevices(adb: CaptureToolResolution): DoctorReport['captureTools']['devices'] {
  if (!adb.exists || !adb.executable) {
    return { count: 0, readyCount: 0, serials: [] };
  }
  const result = spawnSync(adb.path, ['devices', '-l'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    return { count: 0, readyCount: 0, serials: [] };
  }
  const devices = parseAdbDevices(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const ready = devices.filter((device) => device.state === 'device');
  return {
    count: devices.length,
    readyCount: ready.length,
    serials: ready.map((device) => device.serial),
  };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface ClaudeSdkBinaryDiagnostic {
  chosenPath?: unknown;
  source?: unknown;
  detectedPlatformKey?: unknown;
  fallbackUsed?: unknown;
}

function readClaudeSdkBinaryDiagnostic(sdkBinary: unknown): ClaudeSdkBinaryDiagnostic {
  return sdkBinary && typeof sdkBinary === 'object'
    ? sdkBinary as ClaudeSdkBinaryDiagnostic
    : {};
}

export function isClaudeSdkBinaryUsable(sdkBinary: unknown): boolean {
  const diagnostic = readClaudeSdkBinaryDiagnostic(sdkBinary);
  if (typeof diagnostic.chosenPath !== 'string' || diagnostic.source === 'none') return false;
  return isExecutable(diagnostic.chosenPath);
}

function buildClaudeSdkBinaryCheck(sdkBinary: unknown): DoctorCheck {
  const diagnostic = readClaudeSdkBinaryDiagnostic(sdkBinary);
  const usable = isClaudeSdkBinaryUsable(sdkBinary);
  return {
    name: 'claude_sdk_binary',
    ok: usable,
    status: usable ? 'ok' : 'error',
    message: usable
      ? 'Claude Agent SDK native binary is present and executable'
      : 'Claude Agent SDK native binary is missing or not executable',
    details: {
      path: typeof diagnostic.chosenPath === 'string' ? diagnostic.chosenPath : null,
      source: typeof diagnostic.source === 'string' ? diagnostic.source : 'none',
      detectedPlatformKey: typeof diagnostic.detectedPlatformKey === 'string' ? diagnostic.detectedPlatformKey : null,
      fallbackUsed: diagnostic.fallbackUsed === true,
    },
  };
}
