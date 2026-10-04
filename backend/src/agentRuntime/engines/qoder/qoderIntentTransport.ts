// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isAbsolute} from 'node:path';
import {QODER_BYOK_API_KEY_ENV, type QoderRuntimeConfig} from './qoderConfig';
import type {QoderSdkModule} from './qoderSdkLoader';
import {
  INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS,
  intentTransportTextResult,
  runIntentTransport,
  type IntentTransportInput,
} from '../../intentTransport';

interface ClassifierQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface QoderIntentTransportInput extends IntentTransportInput {
  loadSdk(): Promise<QoderSdkModule>;
  resolveAuth(sdk: QoderSdkModule): unknown | Promise<unknown>;
  config: Pick<QoderRuntimeConfig, 'model' | 'lightModel' | 'byok' | 'cliPath'>;
  scopedEnv: Record<string, string | undefined>;
  isolatedClassifierDirectory: string;
  /** The run's authorization, checked after the SDK and auth resolved, right before `query`. */
  beforeQuery?: () => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function hasToolUse(message: Record<string, unknown>): boolean {
  const content = object(message.message)?.content;
  const event = object(message.event);
  const isToolBlock = (value: unknown) => {
    const type = object(value)?.type;
    return type === 'tool_use' || type === 'tool_result';
  };
  return (Array.isArray(content) && content.some(isToolBlock))
    || (event?.type === 'content_block_start' && isToolBlock(event.content_block))
    || message.tool_use_result !== undefined
    || message.deferred_tool_use != null
    || (Array.isArray(message.permission_denials) && message.permission_denials.length > 0)
    || (message.type === 'system' && message.subtype === 'permission_denied');
}

/** A separate one-turn Qoder query; classifier output never comes from a draft. */
export function runQoderIntentTransport(input: QoderIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    if (!isAbsolute(input.isolatedClassifierDirectory)) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const model = input.config.lightModel ?? input.config.model;
    const byok = input.config.byok;
    const byokRequested = Boolean(byok.apiKey || byok.provider || byok.baseUrl || byok.style);
    if (byokRequested && (!byok.apiKey || !byok.provider || !model)) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const sdk = await input.loadSdk();
    scope.throwIfInactive();
    const auth = await input.resolveAuth(sdk);
    scope.throwIfInactive();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    scope.signal.addEventListener('abort', onAbort, {once: true});
    let queryHasClose = false;
    scope.onCleanup(() => {
      if (!queryHasClose) scope.signal.removeEventListener('abort', onAbort);
    });
    if (scope.signal.aborted) onAbort();
    input.beforeQuery?.();
    const candidate = sdk.query({
      prompt: input.prompt,
      options: {
        auth,
        cwd: input.isolatedClassifierDirectory,
        systemPrompt: input.systemPrompt,
        maxTurns: 1,
        closeGraceMs: INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS / 2,
        controlRequestTimeoutMs: Math.max(1, Math.min(scope.remainingMs(), INTENT_TRANSPORT_CLEANUP_TIMEOUT_MS)),
        ...(model ? {model} : {}),
        ...(input.config.cliPath ? {pathToQoderCLIExecutable: input.config.cliPath} : {}),
        tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], promptSuggestions: false,
        permissionMode: 'dontAsk',
        abortController,
        env: Object.fromEntries(Object.entries(input.scopedEnv).filter(([key]) => key !== QODER_BYOK_API_KEY_ENV)),
        ...(byokRequested ? {
          resolveModel: () => ({model: {
            provider: byok.provider, api_key: byok.apiKey, model,
            ...(byok.baseUrl ? {url: byok.baseUrl} : {}),
            ...(byok.style ? {style: byok.style} : {}),
          }}),
        } : {}),
      },
    }) as Partial<ClassifierQuery> | null;
    if (typeof candidate?.close !== 'function') {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    queryHasClose = true;
    let interruptRequested = false;
    const interrupt = () => {
      if (interruptRequested || typeof candidate.interrupt !== 'function') return;
      interruptRequested = true;
      scope.onCleanup(() => candidate.interrupt!());
    };
    scope.onCleanup(async () => {
      try { await candidate.close!(); } finally {
        scope.signal.removeEventListener('abort', interrupt);
        scope.signal.removeEventListener('abort', onAbort);
      }
    });
    scope.signal.addEventListener('abort', interrupt, {once: true});
    if (scope.signal.aborted) interrupt();
    scope.throwIfInactive();
    if (typeof candidate[Symbol.asyncIterator] !== 'function' || typeof candidate.interrupt !== 'function') {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    const iterator = candidate[Symbol.asyncIterator]!();
    while (true) {
      const entry = await iterator.next();
      scope.throwIfInactive();
      if (entry.done) return {status: 'unavailable', reason: 'invalid_response'};
      const message = object(entry.value);
      if (!message) continue;
      if (hasToolUse(message)) return {status: 'unavailable', reason: 'tool_use'};
      if (message.type === 'system'
        && (message.subtype === 'model_refusal_fallback' || message.subtype === 'model_refusal_no_fallback')) {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error !== false) {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      if (message.stop_reason === 'tool_use') return {status: 'unavailable', reason: 'tool_use'};
      if (message.stop_reason === 'max_tokens') return {status: 'unavailable', reason: 'incomplete_output'};
      // Qoder's native success envelope may retain its nullable default stop reason.
      if (message.stop_reason != null && message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      const structured = object(message.structured_output);
      if (message.structured_output !== undefined && !structured) {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      const text = structured ? JSON.stringify(structured)
        : typeof message.result === 'string' ? message.result : '';
      const reportedModels = Object.keys(object(message.modelUsage) ?? {});
      return intentTransportTextResult(text, input, {
        ...(reportedModels.length === 1 ? {actualModel: reportedModels[0]} : {}),
        ...(typeof message.stop_reason === 'string' ? {finishReason: message.stop_reason} : {}),
      });
    }
  });
}
