// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import { spawnSync } from 'child_process';
import {
  resolveAgentRuntimeSelection,
  type BackendAgentRuntimeKind,
  type RuntimeSelection,
} from '../../agentRuntime/runtimeSelection';
import {
  getRuntimeDiagnostics,
} from '../../agentRuntime/runtimeDiagnostics';
import type { RuntimeDiagnosticsPayload } from '../../agentRuntime/runtimeDescriptorTypes';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  QODER_AGENT_RUNTIME_KIND,
} from '../../agentRuntime/runtimeKinds';
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
import {
  getAndroidInternalsPackStatus,
} from '../../services/androidInternalsPack/knowledgePackStatus';
import type {
  AndroidInternalsPackStatus,
} from '../../services/androidInternalsPack/types';

export interface RuntimeGuardResult {
  selection: RuntimeSelection;
  diagnostics: RuntimeDiagnosticsPayload;
}

export interface RuntimeGuardOptions {
  providerId?: string | null;
  runtimeOverride?: BackendAgentRuntimeKind;
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

export function assertAnalysisRuntimeReady(options: RuntimeGuardOptions = {}): RuntimeGuardResult {
  assertAiFeatureEnabled(options.aiFeature ?? 'agent_analyze');
  const selection = resolveAgentRuntimeSelection(options.providerId, options.runtimeOverride);
  const providerId = providerIdFor(selection);
  const diagnostics = getRuntimeDiagnostics(selection);

  if (selection.kind === 'openai-agents-sdk') {
    if (!hasOpenAICredentials(providerId)) {
      throw new Error(
        [
          'OpenAI runtime is selected but no usable OpenAI-compatible credentials were found.',
          'Set OPENAI_API_KEY, configure an active OpenAI/Ollama provider, or use a localhost OpenAI-compatible endpoint.',
          'Run `smp doctor --format text` for the resolved runtime and provider details.',
        ].join(' '),
      );
    }
    return { selection, diagnostics };
  }

  if (
    selection.kind === EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND ||
    selection.kind === PI_AGENT_CORE_RUNTIME_KIND
  ) {
    return { selection, diagnostics };
  }

  if (selection.kind === EXPERIMENTAL_OPENCODE_RUNTIME_KIND || selection.kind === OPENCODE_RUNTIME_KIND) {
    return { selection, diagnostics };
  }

  if (selection.kind === QODER_AGENT_RUNTIME_KIND) {
    if (diagnostics.sdkInstalled !== true) {
      throw new Error(
        'Qoder Agent SDK runtime is selected but @qoder-ai/qoder-agent-sdk is not installed. Review its terms, then install the optional SDK explicitly.',
      );
    }
    // Qoder supports an explicit PAT/CLI path or the local qodercli login.
    // Let the SDK surface a precise authentication error when that login is
    // unavailable instead of applying the Claude native-binary guard.
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

  // Claude Agent SDK can use API/proxy credentials, Bedrock/Vertex env, or a
  // local Claude Code login. Do not reject the local-auth fallback here; the SDK
  // will surface a precise auth error if the local account is unavailable.
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
  knowledgePack: AndroidInternalsPackStatus;
  checks: DoctorCheck[];
}

export function collectDoctorReport(cliHome: string): DoctorReport {
  const aiPolicy = getAiCapabilityPolicy();
  const selection = resolveAgentRuntimeSelection();
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
  const knowledgePack = getAndroidInternalsPackStatus();

  const qoderSdkInstalled = selection.kind !== QODER_AGENT_RUNTIME_KIND ||
    runtimeDiagnostics.sdkInstalled === true;
  const runtimeConfigured = qoderSdkInstalled && (
    runtimeDiagnostics.configured ||
    selection.kind === 'claude-agent-sdk' ||
    selection.kind === QODER_AGENT_RUNTIME_KIND
  );
  const runtimeStatus: DoctorCheck['status'] = aiPolicy.aiEnabled
    ? runtimeConfigured
      ? runtimeDiagnostics.configured
        ? 'ok'
        : 'warn'
      : 'error'
    : 'warn';
  const runtimeOk = aiPolicy.aiEnabled ? runtimeConfigured : true;
  const runtimeMessage = aiPolicy.aiEnabled
    ? runtimeDiagnostics.configured
      ? `${selection.kind} credentials/configuration detected`
      : selection.kind === QODER_AGENT_RUNTIME_KIND && !qoderSdkInstalled
        ? 'Qoder Agent SDK is not installed; review its terms and install the optional SDK explicitly'
        : selection.kind === 'claude-agent-sdk'
        ? 'Claude SDK has no explicit credentials; local Claude login fallback will be used if available'
        : selection.kind === QODER_AGENT_RUNTIME_KIND
          ? 'Qoder SDK has no explicit PAT or CLI path; local qodercli login fallback will be used if available'
        : selection.kind === PI_AGENT_CORE_RUNTIME_KIND ||
            selection.kind === EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND
          ? 'Pi agent-core runtime needs SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON or a configured custom provider'
          : selection.kind === EXPERIMENTAL_OPENCODE_RUNTIME_KIND ||
            selection.kind === OPENCODE_RUNTIME_KIND
            ? 'OpenCode runtime needs @opencode-ai/sdk and opencode-ai available, plus OpenAI-compatible model configuration'
            : 'OpenAI runtime needs OPENAI_API_KEY or a localhost/OpenAI-compatible provider'
    : 'AI is disabled; runtime credentials are not required for deterministic CLI flows';

  const checks: DoctorCheck[] = [
    {
      name: 'node',
      ok: nodeMajor >= 24 && nodeMajor < 25,
      status: nodeMajor >= 24 && nodeMajor < 25 ? 'ok' : 'error',
      message: `Node.js ${process.version} (expected >=24 <25)`,
    },
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
      message: runtimeMessage,
      details: {
        source: selection.source,
        providerId: selection.providerId,
        providerName: selection.providerName,
      },
    },
    ...(aiPolicy.aiEnabled && selection.kind === 'claude-agent-sdk'
      ? [buildClaudeSdkBinaryCheck(runtimeDiagnostics.sdkBinary)]
      : []),
    {
      name: 'android_internals_pack',
      ok: knowledgePack.availability === 'available' || knowledgePack.availability === 'disabled',
      status: knowledgePack.availability === 'available'
        ? 'ok'
        : knowledgePack.availability === 'disabled'
          ? 'warn'
          : knowledgePack.availability === 'revoked' || knowledgePack.availability === 'invalid'
            ? 'error'
            : 'warn',
      message: knowledgePack.active
        ? `${knowledgePack.active.contentVersion} (${knowledgePack.active.origin}, ${knowledgePack.licenseExpression})`
        : `Knowledge Pack is ${knowledgePack.availability}`,
      details: {
        version: knowledgePack.active?.contentVersion ?? null,
        fingerprint: knowledgePack.active?.contentFingerprint ?? null,
        sourceRevision: knowledgePack.active?.sourceRevision ?? null,
        license: knowledgePack.licenseExpression,
        lastError: knowledgePack.lastError ?? null,
      },
    },
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
    knowledgePack,
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
