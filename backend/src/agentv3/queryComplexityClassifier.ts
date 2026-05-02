// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Query Complexity Classifier — routes queries to quick vs full analysis pipeline.
 *
 * Two-stage classification:
 * 1. Hard rules (instant, no LLM): selection context, comparison mode, drill-down,
 *    deterministic scenes → force 'full'
 * 2. AI classification (Haiku, ~1-2s): for remaining queries, determine if the question
 *    is a simple factual lookup or requires multi-step analysis
 *
 * Graceful degradation: if Haiku call fails, defaults to 'full' (safe fallback).
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, type ClaudeAgentConfig } from './claudeConfig';
import { loadPromptTemplate, renderTemplate } from './strategyLoader';
import type { ComplexityClassifierInput, QueryComplexity } from './types';

/** Drill-down keywords force 'full' — user explicitly wants deeper analysis even as follow-up.
 *  These short-circuit Haiku classification to save 1-2s latency on obvious drill-downs. */
const DRILL_DOWN_KEYWORDS = [
  // 中文
  '为什么', '根因', '原因', '深入', '进一步', '详细分析',
  '具体看看', '哪里慢', '细说', '为啥',
  // 英文 (matched case-insensitive)
  'why', 'root cause', 'deeper', 'drill down', 'investigate', 'detail', 'explain', 'dig into',
];

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

/** Scenes that always require full analysis (prescriptive multi-step workflows).
 *  Note: memory/game/overview/touch-tracking are intentionally NOT included — they have
 *  valid quick-query use cases (e.g., "内存多少？", "帧率是多少？"). Only `general` uses Haiku fallback. */
const DETERMINISTIC_SCENES = new Set([
  'scrolling', 'startup', 'anr', 'interaction', 'scroll_response',
  'teaching', 'pipeline',
]);

/**
 * Classify query complexity using hard rules + optional AI classification.
 */
export async function classifyQueryComplexity(
  input: ComplexityClassifierInput,
  config?: Pick<ClaudeAgentConfig, 'lightModel' | 'classifierTimeoutMs'>,
): Promise<{ complexity: QueryComplexity; reason: string; source: 'hard_rule' | 'ai' }> {
  const kwResult = applyKeywordRules(input.query);
  if (kwResult) {
    console.log(`[ComplexityClassifier] Keyword → ${kwResult.complexity}: ${kwResult.reason}`);
    return { ...kwResult, source: 'hard_rule' };
  }

  const hardResult = applyHardRules(input);
  if (hardResult) {
    console.log(`[ComplexityClassifier] Hard rule → ${hardResult.complexity}: ${hardResult.reason}`);
    return { ...hardResult, source: 'hard_rule' };
  }

  try {
    const aiResult = await classifyWithHaiku(input.query, config?.lightModel, config?.classifierTimeoutMs);
    console.log(`[ComplexityClassifier] AI → ${aiResult.complexity}: ${aiResult.reason}`);
    return { ...aiResult, source: 'ai' };
  } catch (err) {
    console.warn('[ComplexityClassifier] Haiku classification failed, defaulting to full:', (err as Error).message);
    return { complexity: 'full', reason: 'AI classification failed (graceful degradation)', source: 'ai' };
  }
}

/**
 * Hard rules that force 'full' without needing AI.
 * Returns null if no hard rule matches (proceed to AI classification).
 */
function applyHardRules(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string } | null {
  if (input.hasSelectionContext) {
    return { complexity: 'full', reason: 'UI selection context present' };
  }
  if (input.hasReferenceTrace) {
    return { complexity: 'full', reason: 'comparison mode' };
  }
  if (input.hasExistingFindings) {
    return { complexity: 'full', reason: 'prior findings exist' };
  }
  if (input.hasPriorFullAnalysis) {
    return { complexity: 'full', reason: 'multi-turn continuity' };
  }
  if (DETERMINISTIC_SCENES.has(input.sceneType)) {
    return { complexity: 'full', reason: `deterministic scene: ${input.sceneType}` };
  }
  return null;
}

/**
 * Keyword-based pre-filter (runs before applyHardRules).
 * - Drill-down keywords → force full (user explicitly wants depth even as follow-up)
 * - Confirm-like keywords in short queries → force quick (pure acknowledgement follow-ups)
 * Returns null when nothing matches, so hard rules + Haiku still get a turn.
 */
function applyKeywordRules(
  query: string,
): { complexity: QueryComplexity; reason: string } | null {
  const lower = query.toLowerCase();
  for (const kw of DRILL_DOWN_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return { complexity: 'full', reason: `drill-down keyword match: "${kw}"` };
    }
  }
  if (query.length < CONFIRM_MAX_LENGTH) {
    for (const kw of CONFIRM_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        return { complexity: 'quick', reason: `confirm-like follow-up: "${kw}"` };
      }
    }
  }
  return null;
}

/**
 * AI-based classification using Claude Haiku.
 * Prompt loaded from prompt-complexity-classifier.template.md.
 */
async function classifyWithHaiku(
  query: string,
  model?: string,
  timeoutMs?: number,
): Promise<{ complexity: QueryComplexity; reason: string }> {
  const template = loadPromptTemplate('prompt-complexity-classifier');
  const prompt = template
    ? renderTemplate(template, { query })
    : `Classify this Android trace analysis query as "quick" (factual) or "full" (analysis).\nQuery: ${query}\nOutput JSON: {"complexity": "quick" or "full", "reason": "..."}`;

  // Default 30s; Haiku usually finishes in 1-2s, but non-Haiku light models can need longer.
  const CLASSIFY_TIMEOUT_MS = timeoutMs ?? 30_000;
  const stream = sdkQuery({
    prompt,
    options: {
      model: model ?? 'claude-haiku-4-5',
      maxTurns: 1,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: createSdkEnv(),
      stderr: (data: string) => {
        console.warn(`[ComplexityClassifier] SDK stderr: ${data.trimEnd()}`);
      },
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
