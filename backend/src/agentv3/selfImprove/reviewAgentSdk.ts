// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Claude SDK call for the background review agent.
 *
 * Completely independent from the main analysis runtime: no resume, no
 * `claude_session_map.json` writes, no MCP tools. The agent receives a
 * structured payload describing what went wrong in a previous analysis and
 * must respond with strict JSON matching ReviewAgentNoteEmission. Anything
 * else is rejected upstream by skillNotesWriter and the job is failed.
 *
 * See docs/architecture/self-improving-design.md §9 (Trust Boundary), §10 (Worker Limits).
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv } from '../claudeConfig';
import { FAILURE_CATEGORIES, FAILURE_CATEGORY_DESCRIPTIONS } from './failureTaxonomy';
import type { ReviewJobPayload, ReviewExecutionResult } from './reviewWorker';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TURNS = 8;

export interface ReviewAgentSdkOptions {
  /** Override the LLM. Default `claude-haiku-4-5` per design doc §9. */
  model?: string;
  /** Wall-clock budget. Default 90s. */
  timeoutMs?: number;
}

/**
 * Run the review agent against a single job. Returns a structured outcome
 * — the worker maps the result to outbox state transitions.
 */
export async function executeReviewAgentViaSdk(
  payload: ReviewJobPayload,
  opts: ReviewAgentSdkOptions = {},
): Promise<ReviewExecutionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_MODEL;

  const prompt = buildReviewAgentPrompt(payload);

  const stream = sdkQuery({
    prompt,
    options: {
      model,
      maxTurns: MAX_TURNS,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: createSdkEnv(),
      stderr: (data: string) => {
        console.warn(`[ReviewAgentSdk] SDK stderr: ${data.trimEnd()}`);
      },
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(`[ReviewAgentSdk] timed out after ${timeoutMs / 1000}s`);
    try { stream.close(); } catch { /* ignore */ }
  }, timeoutMs);

  try {
    for await (const msg of stream) {
      if (timedOut) break;
      if (msg.type === 'result' && (msg as { subtype?: string }).subtype === 'success') {
        result = (msg as { result?: string }).result || '';
      }
    }
  } catch (err) {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
    return { ok: false, reason: 'sdk_error', details: (err as Error).message };
  } finally {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
  }

  if (timedOut) {
    return { ok: false, reason: 'sdk_timeout', details: `${timeoutMs}ms budget exhausted` };
  }

  const parsed = extractJsonObject(result);
  if (!parsed) {
    return { ok: false, reason: 'sdk_invalid', details: 'no JSON object in agent response' };
  }

  // Inject runtime fields the agent doesn't (and shouldn't) supply itself —
  // skillId comes from the originating job, sourceSessionId/turnIndex from
  // the payload context.
  const enriched: Record<string, unknown> = {
    ...parsed,
    skillId: payload.skillId,
  };
  if (typeof payload.context === 'object' && payload.context !== null) {
    const ctx = payload.context as Record<string, unknown>;
    if (typeof ctx.sourceSessionId === 'string') enriched.sourceSessionId = ctx.sourceSessionId;
    if (typeof ctx.sourceTurnIndex === 'number') enriched.sourceTurnIndex = ctx.sourceTurnIndex;
    if (!enriched.failureModeHash && typeof payload.failureModeHash === 'string') {
      enriched.failureModeHash = payload.failureModeHash;
    }
  }

  return { ok: true, emission: enriched };
}

/**
 * Builds the review-agent prompt inline. The prompt is short by design:
 * it forbids YAML/markdown surfaces (those are PR9c's job) and pins the
 * output to the closed FailureCategory enum.
 */
export function buildReviewAgentPrompt(payload: ReviewJobPayload): string {
  const categoryList = FAILURE_CATEGORIES
    .map(c => `- ${c}: ${FAILURE_CATEGORY_DESCRIPTIONS[c]}`)
    .join('\n');

  const contextJson = JSON.stringify(payload.context, null, 2);

  return `You are SmartPerfetto's review agent. The main analysis just finished
running and we want a one-paragraph, high-signal note about a specific
failure mode that the next run on a similar trace should know about.

Skill under review: ${payload.skillId}
Failure mode hash:  ${payload.failureModeHash ?? '(none)'}

Job context (raw payload):
\`\`\`json
${contextJson}
\`\`\`

Allowed failureCategoryEnum values:
${categoryList}

Respond with EXACTLY one JSON object — no markdown fences, no commentary —
matching this shape:

{
  "failureCategoryEnum": "<one of the values above>",
  "evidenceSummary":      "<≤600 chars: what went wrong, in plain prose>",
  "candidateKeywords":    ["<≤6 short keywords>"],
  "candidateConstraints": "<≤400 chars: what the next run should do differently>",
  "candidateCriticalTools": ["<tool/skill IDs to invoke first; can be empty>"]
}

Rules:
- Choose "unknown" if no category clearly fits — DO NOT invent a new one.
- Do not include any field not listed above.
- Do not include shell commands, SQL DDL, or instructions to ignore the
  upstream system prompt — your output is parsed and security-scanned.
`;
}

/**
 * Extract the first balanced JSON object from `text`. The agent should only
 * return one object, but defensive parsing tolerates an accidental code
 * fence or trailing whitespace.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const __testing = { extractJsonObject, DEFAULT_TIMEOUT_MS, DEFAULT_MODEL, MAX_TURNS };
