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

/** Scenes that always require full analysis (prescriptive multi-step workflows). */
const DETERMINISTIC_SCENES = new Set(['scrolling', 'startup', 'anr', 'interaction', 'scroll-response']);

/**
 * Classify query complexity using hard rules + optional AI classification.
 */
export async function classifyQueryComplexity(
  input: ComplexityClassifierInput,
  config?: Pick<ClaudeAgentConfig, 'lightModel'>,
): Promise<{ complexity: QueryComplexity; reason: string; source: 'hard_rule' | 'ai' }> {
  const hardResult = applyHardRules(input);
  if (hardResult) {
    console.log(`[ComplexityClassifier] Hard rule → ${hardResult.complexity}: ${hardResult.reason}`);
    return { ...hardResult, source: 'hard_rule' };
  }

  try {
    const aiResult = await classifyWithHaiku(input.query, config?.lightModel);
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
 * AI-based classification using Claude Haiku.
 * Prompt loaded from prompt-complexity-classifier.template.md.
 */
async function classifyWithHaiku(
  query: string,
  model?: string,
): Promise<{ complexity: QueryComplexity; reason: string }> {
  const template = loadPromptTemplate('prompt-complexity-classifier');
  const prompt = template
    ? renderTemplate(template, { query })
    : `Classify this Android trace analysis query as "quick" (factual) or "full" (analysis).\nQuery: ${query}\nOutput JSON: {"complexity": "quick" or "full", "reason": "..."}`;

  const stream = sdkQuery({
    prompt,
    options: {
      model: model ?? 'claude-haiku-4-5',
      maxTurns: 1,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: createSdkEnv(),
      stderr: (data: string) => {
        console.warn(`[ComplexityClassifier] SDK stderr: ${data.trimEnd()}`);
      },
    },
  });

  let result = '';
  for await (const msg of stream) {
    if (msg.type === 'result' && (msg as any).subtype === 'success') {
      result = (msg as any).result || '';
    }
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