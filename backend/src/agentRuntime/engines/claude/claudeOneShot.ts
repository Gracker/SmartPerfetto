// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The Claude Agent SDK branch of the shared one-shot model call
// (`services/oneShotModelCall.ts`), which owns the gates, the provider read and
// the reason codes. This file owns only what is specific to the SDK: the
// isolated query options and reading its message stream.

import type {Options} from '@anthropic-ai/claude-agent-sdk';
import {claudeSdkQuery as sdkQuery} from './claudeSdkQuery';
import {claudeMessageHasToolUse} from './claudeSdkMessageGuards';
import {
  getSdkBinaryOption,
  hasClaudeCredentials,
  resolveClaudeSdkPermissionOptions,
  type ClaudeAgentConfig,
  type EffortLevel,
} from './claudeConfig';
import {isPlainObject} from '../../../utils/llmJson';
import {effectiveOneShotTimeoutMs, type OneShotCallInput, type OneShotResult} from '../../oneShotContract';

/** The Claude SDK env and config of the resolved provider, read once. */
export interface ClaudeOneShotContext {
  env: Record<string, string | undefined>;
  config: ClaudeAgentConfig;
}

/**
 * SDK options for a one-shot call over untrusted, trace-derived text: one turn,
 * no tools, skills, plugins or MCP servers, no user settings, nothing persisted.
 */
export function isolatedClaudeOneShotOptions(input: {
  model: string;
  env: Record<string, string | undefined>;
  stderr: (data: string) => void;
  cwd?: string;
  effort?: EffortLevel;
  abortController?: AbortController;
}): Options {
  return {
    ...getSdkBinaryOption(input.env),
    model: input.model,
    ...(input.cwd ? {cwd: input.cwd} : {}),
    ...(input.effort ? {effort: input.effort} : {}),
    env: input.env,
    maxTurns: 1,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    persistSession: false,
    ...resolveClaudeSdkPermissionOptions(),
    ...(input.abortController ? {abortController: input.abortController} : {}),
    stderr: input.stderr,
  };
}

export interface OneShotClaudeInput extends OneShotCallInput {
  /** From `resolveOneShotProvider`; no further provider reads happen here. */
  claude: ClaudeOneShotContext;
}

/**
 * One isolated Claude call with an already-resolved provider. Never throws for
 * model or cancellation failures; the reason says what happened.
 */
export async function runIsolatedClaudeOneShot(input: OneShotClaudeInput): Promise<OneShotResult> {
  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected'};
  const {env, config} = input.claude;
  const model = input.tier === 'light' ? (config.lightModel || config.model) : config.model;
  if (!hasClaudeCredentials(env)) return {ok: false, reason: 'credentials_missing', model};

  // One controller owns the SDK subprocess; the caller's cancellation and the
  // deadline both stop it through the same path.
  const abortController = new AbortController();
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const stop = (): void => {
    abortController.abort();
    try {
      stream?.close();
    } catch {
      // ignore
    }
  };
  input.signal?.addEventListener('abort', stop, {once: true});
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, effectiveOneShotTimeoutMs(input.timeoutMs));

  let text = '';
  let failed = false;
  try {
    stream = sdkQuery({
      prompt: input.prompt,
      options: isolatedClaudeOneShotOptions({
        model,
        env,
        cwd: config.cwd,
        effort: input.effort,
        abortController,
        stderr: (data: string) => console.warn(`[${input.logLabel}] SDK stderr: ${data.trimEnd()}`),
      }),
    });
    for await (const entry of stream) {
      if (abortController.signal.aborted) break;
      if (!isPlainObject(entry)) continue;
      const message = entry;
      if (claudeMessageHasToolUse(message) || (message.type === 'result' && message.stop_reason === 'tool_use')) {
        console.warn(`[${input.logLabel}] Model attempted a tool call in a tool-less one-shot call`);
        failed = true;
        break;
      }
      if (message.type === 'system'
        && (message.subtype === 'model_refusal_fallback' || message.subtype === 'model_refusal_no_fallback')) {
        failed = true;
        break;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error === true || message.stop_reason === 'refusal') {
          failed = true;
          break;
        }
        text = typeof message.result === 'string' ? message.result : '';
      }
    }
  } catch (error: unknown) {
    if (!abortController.signal.aborted) {
      console.warn(`[${input.logLabel}] Model call failed:`, error);
      failed = true;
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', stop);
    try {
      stream?.close();
    } catch {
      // ignore
    }
  }

  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected', model};
  if (timedOut) return {ok: false, reason: 'timed_out', model};
  if (failed) return {ok: false, reason: 'failed', model};
  if (!text.trim()) return {ok: false, reason: 'empty_response', model};
  return {ok: true, text: text.trim(), model};
}
