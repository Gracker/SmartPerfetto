// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OpenAITextRequestPurpose} from '../../../services/providerManager/openAiChatCompletionsCompat';
import {
  intentTransportTextResult,
  runIntentTransport,
  type IntentTransportInput,
  type IntentTransportUnavailableReason,
} from '../../intentTransport';
import {getOpenCodeAssistantMessageId, getOpenCodeAssistantMessages} from './openCodeMessages';

export interface OpenCodeIntentModel {
  providerID: string;
  modelID: string;
}

interface SessionRequest {
  path: {id: string};
  query: {directory: string};
  signal: AbortSignal;
}

export interface OpenCodeClassifierHost {
  client: {
    session: {
      create(input: {body: {title: string}; query: {directory: string}; signal: AbortSignal}): Promise<unknown>;
      prompt(input: SessionRequest & {
        body: {
          model: OpenCodeIntentModel;
          agent: string;
          system: string;
          tools: Record<string, boolean>;
          parts: Array<{type: 'text'; text: string}>;
        };
      }): Promise<unknown>;
      messages(input: SessionRequest): Promise<unknown>;
      abort(input: SessionRequest): Promise<unknown>;
      delete?(input: SessionRequest): Promise<unknown>;
    };
  };
  projectDir: string;
  agentName: string;
  disabledTools: Readonly<Record<string, boolean>>;
  /** Owns this isolated server and all of its temporary directories. */
  close(signal: AbortSignal): void | Promise<void>;
}

export interface OpenCodeIntentTransportInput extends IntentTransportInput {
  model: OpenCodeIntentModel;
  /** Selects this call's provider controls; the closeout and empty-body continuation pass none. */
  purpose?: OpenAITextRequestPurpose;
  /**
   * Reuse the runtime's explicit-env launcher and hardened config. The fresh
   * host must disable built-ins, MCP, instructions, and extra agent steps.
   */
  createClassifierHost(input: {
    signal: AbortSignal;
    deadlineMs: number;
    model: OpenCodeIntentModel;
    purpose?: OpenAITextRequestPurpose;
  }): Promise<OpenCodeClassifierHost>;
  /** The run's authorization, checked after the host started, right before the prompt is sent. */
  beforeDispatch?: () => void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * OpenCode names a failed assistant message by its error type: an output cap
 * is an incomplete reply, a provider, auth or unknown error is the provider's.
 * Anything else stays an invalid response.
 */
function messageErrorReason(error: unknown): IntentTransportUnavailableReason {
  const name = object(error)?.name;
  if (name === 'MessageOutputLengthError') return 'incomplete_output';
  if (name === 'APIError' || name === 'ProviderAuthError' || name === 'UnknownError') return 'provider_error';
  return 'invalid_response';
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  const response = object(value);
  if (response?.error != null) return undefined;
  return response && 'data' in response ? object(response.data) : response;
}

export function runOpenCodeIntentTransport(input: OpenCodeIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    if (!input.model.providerID?.trim() || !input.model.modelID?.trim()) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const host = await input.createClassifierHost({
      signal: scope.signal, deadlineMs: input.deadlineMs, model: input.model, purpose: input.purpose,
    });
    let removeAbortListener: (() => void) | undefined;
    scope.onCleanup(async signal => {
      try { await host.close(signal); } finally { removeAbortListener?.(); }
    });
    scope.throwIfInactive();
    const disabledTools = {...host.disabledTools};
    if (!host.projectDir?.trim() || !host.agentName?.trim()
      || Object.keys(disabledTools).length === 0
      || Object.values(disabledTools).some(enabled => enabled !== false)
      || typeof host.client.session.abort !== 'function') {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const created = responseData(await host.client.session.create({
      body: {title: 'Intent classification'}, query: {directory: host.projectDir}, signal: scope.signal,
    }));
    if (typeof created?.id !== 'string' || !created.id.trim()) {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    const path = {id: created.id};
    const query = {directory: host.projectDir};
    let abortRequested = false;
    const abortSession = () => {
      if (abortRequested) return;
      abortRequested = true;
      scope.onCleanup(signal => host.client.session.abort({path, query, signal}));
    };
    scope.signal.addEventListener('abort', abortSession, {once: true});
    removeAbortListener = () => scope.signal.removeEventListener('abort', abortSession);
    if (scope.signal.aborted) abortSession();
    if (host.client.session.delete) {
      scope.onCleanup(signal => host.client.session.delete!({path, query, signal}));
    }
    scope.throwIfInactive();
    input.beforeDispatch?.();
    const message = responseData(await host.client.session.prompt({
      path, query, signal: scope.signal,
      body: {
        model: input.model, agent: host.agentName, system: input.systemPrompt,
        tools: disabledTools, parts: [{type: 'text', text: input.prompt}],
      },
    }));
    scope.throwIfInactive();
    const info = object(message?.info);
    const completedAt = object(info?.time)?.completed;
    if (info?.role === 'assistant' && info.error != null) {
      return {status: 'unavailable', reason: messageErrorReason(info.error)};
    }
    if (info?.role !== 'assistant'
      || typeof completedAt !== 'number' || !Number.isFinite(completedAt) || !Array.isArray(message?.parts)) {
      return {status: 'unavailable', reason: 'invalid_response'};
    }
    const finishReason = typeof info.finish === 'string' ? info.finish : undefined;
    const parts = message.parts.map(object);
    if (parts.some(part => part?.type === 'tool')
      || finishReason === 'tool-calls' || finishReason === 'tool_use') {
      return {status: 'unavailable', reason: 'tool_use'};
    }
    if (finishReason === 'length' || finishReason === 'error') {
      return {status: 'unavailable', reason: 'incomplete_output'};
    }
    // The prompt returns only the last step. Another assistant message means
    // OpenCode ran a step after a tool call, which a no-tool call never accepts.
    const history = await host.client.session.messages({path, query, signal: scope.signal});
    scope.throwIfInactive();
    const replies = getOpenCodeAssistantMessages(object(history)?.error == null ? history : undefined);
    if (typeof info.id !== 'string' || replies.length === 0) return {status: 'unavailable', reason: 'invalid_response'};
    if (replies.length > 1 || getOpenCodeAssistantMessageId(replies[0]!) !== info.id) {
      return {status: 'unavailable', reason: 'tool_use'};
    }
    const text = parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part!.text).join('');
    return intentTransportTextResult(text, input, {
      ...(typeof info.modelID === 'string' ? {actualModel: info.modelID} : {}),
      ...(finishReason ? {finishReason} : {}),
    });
  });
}
