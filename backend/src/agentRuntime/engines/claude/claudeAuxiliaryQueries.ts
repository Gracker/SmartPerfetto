// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The Claude Agent SDK queries of two product features that run outside an
// analysis: the learning pipelines' structured review
// (`services/evolutionLifecycle/reviewExecution.ts`) and external-issue triage
// (`services/externalIssueReporting/triageRunner.ts`). Each feature keeps its
// model choice, provider pin and result contract; these functions own only the
// SDK options and reading the SDK message stream.

import {claudeSdkQuery as sdkQuery} from './claudeSdkQuery';
import {createSdkEnv, getSdkBinaryOption} from './claudeConfig';

export type ClaudeStructuredReviewQueryOutcome =
  | {kind: 'text'; text: string}
  | {kind: 'timeout'}
  | {kind: 'error'; error: unknown};

/**
 * One no-tool review query on the active provider's Claude env. The text is the
 * last successful result; a failure to build the env or to read the stream is
 * an `error`, and the deadline wins over both.
 */
export async function runClaudeStructuredReviewQuery(input: {
  prompt: string;
  logPrefix: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
}): Promise<ClaudeStructuredReviewQueryOutcome> {
  let sdkEnv: ReturnType<typeof createSdkEnv>;
  try {
    // Follows the active provider, which an unreadable providers.json leaves
    // unknown; report that as this review's failure rather than rejecting.
    sdkEnv = createSdkEnv();
  } catch (error) {
    return {kind: 'error', error};
  }
  const stream = sdkQuery({
    prompt: input.prompt,
    options: {
      model: input.model,
      maxTurns: input.maxTurns,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      stderr: (data: string) => {
        console.warn(`[${input.logPrefix}] SDK stderr: ${data.trimEnd()}`);
      },
      ...getSdkBinaryOption(sdkEnv),
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(
      `[${input.logPrefix}] timed out after ${input.timeoutMs / 1000}s`,
    );
    try {
      stream.close();
    } catch {
      // Best-effort cancellation; the timeout result remains authoritative.
    }
  }, input.timeoutMs);

  try {
    for await (const message of stream) {
      if (timedOut) break;
      if (
        message.type === 'result' &&
        (message as {subtype?: string}).subtype === 'success'
      ) {
        result = (message as {result?: string}).result ?? '';
      }
    }
  } catch (error) {
    return timedOut ? {kind: 'timeout'} : {kind: 'error', error};
  } finally {
    clearTimeout(timer);
    try {
      stream.close();
    } catch {
      // The execution result above remains authoritative.
    }
  }

  return timedOut ? {kind: 'timeout'} : {kind: 'text', text: result};
}

/**
 * One single-turn, low-effort triage query with the pinned provider's
 * already-resolved env, model and working directory. The text is the last
 * string result. Stream errors propagate; `timedOut` reports the deadline.
 */
export async function runClaudeTriageQuery(input: {
  prompt: string;
  model: string;
  cwd: string | undefined;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{timedOut: boolean; text: string}> {
  const stream = sdkQuery({
    prompt: input.prompt,
    options: {
      model: input.model,
      maxTurns: 1,
      includePartialMessages: false,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd: input.cwd,
      effort: 'low',
      env: input.env,
      ...getSdkBinaryOption(input.env),
    },
  });
  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      stream.close();
    } catch {
      // Best-effort cancellation.
    }
  }, input.timeoutMs);
  try {
    for await (const message of stream) {
      if (timedOut) break;
      if (
        message.type === 'result' &&
        typeof (message as {result?: unknown}).result === 'string'
      ) {
        result = (message as {result: string}).result;
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      stream.close();
    } catch {
      // The captured result remains authoritative.
    }
  }
  return {timedOut, text: result};
}
