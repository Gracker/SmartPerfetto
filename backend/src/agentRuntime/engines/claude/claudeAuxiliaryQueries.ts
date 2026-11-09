// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The Claude Agent SDK query of external-issue triage
// (`services/externalIssueReporting/triageRunner.ts`), which runs outside an
// analysis. The feature keeps its model choice, provider pin and result
// contract; this function owns only the SDK options and reading the stream.

import {claudeSdkQuery as sdkQuery} from './claudeSdkQuery';
import {getSdkBinaryOption} from './claudeConfig';

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
