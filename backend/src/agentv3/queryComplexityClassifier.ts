// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Query Complexity Classifier — routes queries to quick vs full analysis pipeline.
 *
 * Two-stage classification:
 * 1. Local rules (instant, no LLM): comparison → full,
 *    then pure confirmation keywords for short acknowledgement follow-ups
 * 2. AI classification (Haiku, ~1-2s): for remaining queries, determine if the question
 *    is a simple factual lookup or requires multi-step analysis, using recent turn context
 *
 * Graceful degradation: if Haiku call fails, defaults to 'full' (safe fallback).
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, getSdkBinaryOption, type ClaudeAgentConfig } from './claudeConfig';
import { buildComplexityClassifierPrompt } from './queryComplexityPrompt';
import type { ComplexityClassifierInput, QueryComplexity } from './types';

/** Confirm-like keywords force 'quick' when the query is short — covers "谢谢"/"ok" style follow-ups. */
const CONFIRM_KEYWORDS = [
  // 中文
  '谢谢', '好的', '明白了', '嗯', '收到', '知道了', '了解',
  // 英文
  'thanks', 'thank you', 'ok', 'okay', 'got it', 'understood',
];

/** Upper bound for treating CONFIRM_KEYWORDS as a pure confirmation.
 *  Longer queries (e.g., "谢谢你，但具体第几帧最卡") mix confirmation with real follow-up intent. */
const CONFIRM_MAX_LENGTH = 20;

/**
 * Local-only classification using non-negotiable scope and acknowledgement rules.
 * Returns null when no local rule matches, so callers can decide their own
 * AI fallback. Provider-agnostic: zero LLM/SDK dependency.
 */
export function classifyQueryComplexityLocal(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string; source: 'hard_rule' } | null {
  const scopeResult = applyScopeHardRules(input);
  if (scopeResult) {
    console.log(`[ComplexityClassifier] Scope rule → ${scopeResult.complexity}: ${scopeResult.reason}`);
    return { ...scopeResult, source: 'hard_rule' };
  }

  const acknowledgementResult = applyAcknowledgementRule(input.query);
  if (acknowledgementResult) {
    console.log(
      `[ComplexityClassifier] Acknowledgement rule → ${acknowledgementResult.complexity}: ${acknowledgementResult.reason}`,
    );
    return { ...acknowledgementResult, source: 'hard_rule' };
  }

  return null;
}

/** Classify query complexity using local safety rules + semantic AI classification. */
export async function classifyQueryComplexity(
  input: ComplexityClassifierInput,
  config?: Pick<ClaudeAgentConfig, 'lightModel' | 'classifierTimeoutMs'>,
): Promise<{ complexity: QueryComplexity; reason: string; source: 'hard_rule' | 'ai' }> {
  const local = classifyQueryComplexityLocal(input);
  if (local) return local;

  try {
    const aiResult = await classifyWithHaiku(input, config?.lightModel, config?.classifierTimeoutMs);
    console.log(`[ComplexityClassifier] AI → ${aiResult.complexity}: ${aiResult.reason}`);
    return { ...aiResult, source: 'ai' };
  } catch (err) {
    console.warn('[ComplexityClassifier] Haiku classification failed, defaulting to full:', (err as Error).message);
    return { complexity: 'full', reason: 'AI classification failed (graceful degradation)', source: 'ai' };
  }
}

/**
 * Scope rules that route before semantic classification.
 * Keep this list minimal: selection is a range signal, not a complexity
 * signal, so selection-aware quick/full decisions belong in the shared
 * classifier prompt rather than a local hard lock.
 */
function applyScopeHardRules(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string } | null {
  if (input.hasReferenceTrace) {
    return { complexity: 'full', reason: 'comparison mode' };
  }
  return null;
}

/**
 * Acknowledgement pre-filter (runs after scope rules, before semantic AI classification).
 * Keep this intentionally narrow: "why/root cause/deep" needs semantic scope judgment,
 * because it may refer to a specific thread/slice/range rather than a whole-scene diagnosis.
 * - Confirm-like keywords in short queries → force quick (pure acknowledgement follow-ups)
 * Returns null when nothing matches, so Haiku still gets a turn.
 */
function applyAcknowledgementRule(
  query: string,
): { complexity: QueryComplexity; reason: string } | null {
  const normalizedQuery = normalizeAcknowledgement(query);
  if (query.length < CONFIRM_MAX_LENGTH) {
    for (const kw of CONFIRM_KEYWORDS) {
      if (normalizedQuery === normalizeAcknowledgement(kw)) {
        return { complexity: 'quick', reason: `confirm-like follow-up: "${kw}"` };
      }
    }
  }
  return null;
}

function normalizeAcknowledgement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s,，.。!！?？~～…]+/g, '');
}

/**
 * AI-based classification using Claude Haiku.
 * Prompt loaded from prompt-complexity-classifier.template.md.
 */
async function classifyWithHaiku(
  input: ComplexityClassifierInput,
  model?: string,
  timeoutMs?: number,
): Promise<{ complexity: QueryComplexity; reason: string }> {
  const prompt = buildComplexityClassifierPrompt(input);

  // Default 30s; Haiku usually finishes in 1-2s, but non-Haiku light models can need longer.
  const CLASSIFY_TIMEOUT_MS = timeoutMs ?? 30_000;
  const sdkEnv = createSdkEnv();
  const stream = sdkQuery({
    prompt,
    options: {
      model: model ?? 'claude-haiku-4-5',
      maxTurns: 1,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      stderr: (data: string) => {
        console.warn(`[ComplexityClassifier] SDK stderr: ${data.trimEnd()}`);
      },
      ...getSdkBinaryOption(sdkEnv),
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(`[ComplexityClassifier] Classification timed out after ${CLASSIFY_TIMEOUT_MS / 1000}s`);
    try { stream.close(); } catch { /* ignore */ }
  }, CLASSIFY_TIMEOUT_MS);

  try {
    for await (const msg of stream) {
      if (timedOut) break;
      if (msg.type === 'result' && (msg as any).subtype === 'success') {
        result = (msg as any).result || '';
      }
    }
  } finally {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
  }

  if (timedOut) {
    return { complexity: 'full', reason: 'classification timed out (graceful degradation)' };
  }

  const jsonMatch = result.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const complexity: QueryComplexity = parsed.complexity === 'quick' ? 'quick' : 'full';
      return { complexity, reason: parsed.reason || 'AI classification' };
    } catch {
      return { complexity: 'full', reason: 'failed to parse AI JSON response' };
    }
  }

  return { complexity: 'full', reason: 'no JSON in AI response' };
}
