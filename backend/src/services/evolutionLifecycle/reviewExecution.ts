// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {runResolvedOneShot} from '../oneShotModelCall';

const NO_JSON_DETAILS = 'no JSON object in agent response';

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
  timeoutMs: number;
}

/**
 * Shared no-tool structured review execution for learning pipelines, on the
 * active provider's runtime. Details carry a reason code, never model output.
 */
export async function executeStructuredReview(
  input: StructuredReviewExecutionOptions,
): Promise<StructuredReviewExecutionResult> {
  const outcome = await runResolvedOneShot({
    prompt: input.prompt,
    tier: 'light',
    timeoutMs: input.timeoutMs,
    logLabel: input.logPrefix,
  });
  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'timed_out':
        return {
          ok: false,
          reason: 'sdk_timeout',
          details: `${input.timeoutMs}ms budget exhausted`,
        };
      case 'empty_response':
        return {ok: false, reason: 'sdk_invalid', details: NO_JSON_DETAILS};
      case 'runtime_not_supported':
        return {
          ok: false,
          reason: 'sdk_error',
          details: `runtime_not_supported: ${outcome.runtime ?? 'unknown'}`,
        };
      default:
        return {ok: false, reason: 'sdk_error', details: outcome.reason};
    }
  }
  const parsed = extractFirstJsonObject(outcome.text);
  return parsed
    ? {ok: true, value: parsed}
    : {ok: false, reason: 'sdk_invalid', details: NO_JSON_DETAILS};
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
