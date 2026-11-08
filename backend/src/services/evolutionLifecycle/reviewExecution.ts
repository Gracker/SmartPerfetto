// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {runClaudeStructuredReviewQuery} from '../../agentRuntime/engines/claude/claudeAuxiliaryQueries';

export type StructuredReviewExecutionResult =
  | {ok: true; value: Record<string, unknown>}
  | {
      ok: false;
      reason: 'sdk_timeout' | 'sdk_error' | 'sdk_invalid';
      details: string;
    };

export interface StructuredReviewExecutionOptions {
  prompt: string;
  logPrefix: string;
  defaultModel: string;
  timeoutMs: number;
  maxTurns: number;
  model?: string;
}

/**
 * Shared no-tool structured review execution for learning pipelines.
 */
export async function executeStructuredReview(
  input: StructuredReviewExecutionOptions,
): Promise<StructuredReviewExecutionResult> {
  const model = input.model ??
    process.env.CLAUDE_LIGHT_MODEL ??
    input.defaultModel;
  const outcome = await runClaudeStructuredReviewQuery({
    prompt: input.prompt,
    logPrefix: input.logPrefix,
    model,
    maxTurns: input.maxTurns,
    timeoutMs: input.timeoutMs,
  });
  if (outcome.kind === 'timeout') {
    return {
      ok: false,
      reason: 'sdk_timeout',
      details: `${input.timeoutMs}ms budget exhausted`,
    };
  }
  if (outcome.kind === 'error') {
    return {ok: false, reason: 'sdk_error', details: errorMessage(outcome.error)};
  }
  const parsed = extractFirstJsonObject(outcome.text);
  return parsed
    ? {ok: true, value: parsed}
    : {
        ok: false,
        reason: 'sdk_invalid',
        details: 'no JSON object in agent response',
      };
}

export function extractFirstJsonObject(
  text: string,
): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (character === '\\') {
        escape = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
