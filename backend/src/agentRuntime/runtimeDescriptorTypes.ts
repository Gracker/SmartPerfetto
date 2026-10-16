// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import type { TraceProcessorService } from '../services/traceProcessorService';
import type { RuntimeSelection } from './runtimeSelection';
import type { AgentRuntimeKind } from './runtimeKinds';
import type { ProviderScope } from '../services/providerManager';

export interface EngineCapabilities {
  kind: string;
  displayName: string;
  production: boolean;
  publicRuntime: boolean;
  promptCache: {
    /** Supports SDK-level split between cacheable system prompt prefix and dynamic suffix. */
    systemPromptDynamicBoundary: boolean;
  };
  /**
   * Streams a display-only answer draft under the reset contract in
   * agentRuntime/answerDraftStream.ts: every token carries runId + attempt and
   * an `answer_segment_reset` revokes shown text at each response start, tool
   * boundary and continuation/retry. Only runtimes that implement and test that
   * contract may set this; product surfaces forward drafts for no other runtime.
   */
  draftAnswerStreaming: boolean;
}

export interface RuntimeFactoryInput {
  traceProcessorService: TraceProcessorService;
  selection: RuntimeSelection<string>;
  env?: Record<string, string | undefined>;
  providerScope?: ProviderScope;
}

export interface RuntimeEngineDefinition {
  kind: string;
  capabilities: EngineCapabilities;
  createOrchestrator(input: RuntimeFactoryInput): IOrchestrator;
}

export interface RuntimeDiagnosticsPayload {
  runtime: string;
  configured: boolean;
  model?: unknown;
  providerMode?: unknown;
  modelConfigured?: unknown;
  sdkBinary?: unknown;
  [key: string]: unknown;
}

export interface RuntimeDiagnosticsInput<K extends string = string> {
  env: Record<string, string | undefined>;
  kind: K;
  selectedProviderId?: string | null;
}

export interface RuntimeEngineDescriptor<K extends AgentRuntimeKind = AgentRuntimeKind>
  extends RuntimeEngineDefinition {
  kind: K;
  displayName: string;
  production: true;
  publicRuntime: true;
  providerTypes: readonly string[];
  capabilities: EngineCapabilities & {
    kind: K;
    production: true;
    publicRuntime: true;
  };
  getDiagnostics(input: RuntimeDiagnosticsInput<K>): RuntimeDiagnosticsPayload;
}
