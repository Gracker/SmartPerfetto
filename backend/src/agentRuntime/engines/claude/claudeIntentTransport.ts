// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Options} from '@anthropic-ai/claude-agent-sdk';
import type {ClaudeAgentConfig} from './claudeConfig';
import {
  intentTransportTextResult,
  runIntentTransport,
  sdkResultFailureReason,
  type IntentTransportInput,
} from '../../intentTransport';
import type {RuntimeModelCallPurpose} from '../../runtimePerformance';
import {isPlainObject} from '../../../utils/llmJson';
import {claudeMessageHasToolUse} from './claudeSdkMessageGuards';

interface ClaudeClassifierQuery extends AsyncIterable<unknown> {
  close(): void | Promise<void>;
}

export interface ClaudeIntentSdk {
  query(input: {prompt: string; options: Options}): ClaudeClassifierQuery;
}

export interface ClaudeIntentTransportInput extends IntentTransportInput {
  config: Pick<ClaudeAgentConfig, 'lightModel' | 'cwd'>;
  /** Already resolved by createSdkEnv for the current provider scope. */
  sdkEnv: Record<string, string | undefined>;
  /** Already resolved by getSdkBinaryOption using that same scoped environment. */
  sdkBinaryOptions: Pick<Options, 'pathToClaudeCodeExecutable'>;
  loadSdk(): Promise<ClaudeIntentSdk>;
  /** Selects the call's deliberation (`claudeEffortForPurpose`); omitted, the SDK default. */
  purpose?: RuntimeModelCallPurpose;
}

/**
 * Classification, the final semantic review and a declaration repair need no
 * deliberation. The CLI drops `thinking: disabled`, and a thinking-by-default
 * gateway (GLM) then spent 30-40 s on a classification prompt and minutes on
 * a review; low effort is what the CLI forwards. Answer turns and closeout or
 * continuation calls keep the run's own effort.
 */
export function claudeEffortForPurpose(purpose: RuntimeModelCallPurpose | undefined): Options['effort'] | undefined {
  return purpose === 'classification' || purpose === 'review' || purpose === 'declaration_repair' ? 'low' : undefined;
}

/** Uses the caller's pinned Claude environment for one isolated classification query. */
export function runClaudeIntentTransport(input: ClaudeIntentTransportInput) {
  return runIntentTransport(input, async scope => {
    if (!input.config.lightModel?.trim() || !input.config.cwd?.trim()) {
      return {status: 'unavailable', reason: 'invalid_configuration'};
    }
    const sdk = await input.loadSdk();
    scope.throwIfInactive();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    scope.signal.addEventListener('abort', onAbort, {once: true});
    let queryHasClose = false;
    scope.onCleanup(() => {
      if (!queryHasClose) scope.signal.removeEventListener('abort', onAbort);
    });
    if (scope.signal.aborted) onAbort();
    const effort = claudeEffortForPurpose(input.purpose);
    const query = sdk.query({
      prompt: input.prompt,
      options: {
        ...input.sdkBinaryOptions,
        model: input.config.lightModel,
        cwd: input.config.cwd,
        env: input.sdkEnv,
        systemPrompt: input.systemPrompt,
        ...(effort ? {effort} : {}),
        maxTurns: 1,
        tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], persistSession: false,
        permissionMode: 'dontAsk',
        abortController,
        stderr: () => undefined,
      },
    });
    queryHasClose = true;
    scope.onCleanup(async () => {
      try { await query.close(); } finally { scope.signal.removeEventListener('abort', onAbort); }
    });
    scope.throwIfInactive();
    const iterator = query[Symbol.asyncIterator]();
    while (true) {
      const entry = await iterator.next();
      scope.throwIfInactive();
      if (entry.done) return {status: 'unavailable', reason: 'invalid_response'};
      const message = isPlainObject(entry.value) ? entry.value : undefined;
      if (!message) continue;
      if (claudeMessageHasToolUse(message)) return {status: 'unavailable', reason: 'tool_use'};
      if (message.type === 'system'
        && (message.subtype === 'model_refusal_fallback' || message.subtype === 'model_refusal_no_fallback')) {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error !== false || message.stop_reason === 'refusal') {
        return {status: 'unavailable', reason: sdkResultFailureReason(message)};
      }
      if (message.stop_reason === 'tool_use') return {status: 'unavailable', reason: 'tool_use'};
      if (message.stop_reason === 'max_tokens') return {status: 'unavailable', reason: 'incomplete_output'};
      // Some SDK success producers omit the raw provider stop reason or emit null.
      if (message.stop_reason != null && message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
        return {status: 'unavailable', reason: 'invalid_response'};
      }
      const models = isPlainObject(message.modelUsage) ? Object.keys(message.modelUsage) : [];
      return intentTransportTextResult(typeof message.result === 'string' ? message.result : '', input, {
        ...(models.length === 1 ? {actualModel: models[0]} : {}),
        ...(typeof message.stop_reason === 'string' ? {finishReason: message.stop_reason} : {}),
      });
    }
  });
}
