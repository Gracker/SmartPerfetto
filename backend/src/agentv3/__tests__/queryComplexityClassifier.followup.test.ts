// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * queryComplexityClassifier follow-up unit tests
 *
 * Focus: keyword pre-filter (drill-down → full, confirm-short → quick) and hard rules.
 * The Haiku AI fallback is mocked to make tests deterministic and fast.
 *
 * Coverage (plan §9 testing strategy + Codex Q2 fix):
 *   - DRILL_DOWN_KEYWORDS positive cases (zh + en)
 *   - CONFIRM_KEYWORDS positive cases + length boundary
 *   - Hard rules (selection / comparison / findings / prior-full / deterministic scene)
 *   - Priority: keyword pre-filter runs before hard rules
 */

import { jest, describe, it, expect } from '@jest/globals';

// Mock the Claude Agent SDK so no real network calls happen.
// Returns 'full' from Haiku fallback — any test that does not short-circuit via
// keyword or hard rule will hit this mock instead of failing / hanging.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: JSON.stringify({ complexity: 'full', reason: 'ai-fallback-mock' }),
      };
    },
    close: jest.fn(),
  })),
}));

// Stub strategyLoader so loadPromptTemplate('prompt-complexity-classifier') does not hit disk.
jest.mock('../strategyLoader', () => ({
  loadPromptTemplate: jest.fn(() => null),
  renderTemplate: jest.fn((_tpl: unknown, vars: Record<string, string>) => `Classify: ${vars.query}`),
}));

import { classifyQueryComplexity } from '../queryComplexityClassifier';
import type { ComplexityClassifierInput } from '../types';

/** Build a ComplexityClassifierInput with sensible defaults; override only what the test cares about. */
function makeInput(override: Partial<ComplexityClassifierInput>): ComplexityClassifierInput {
  return {
    query: '',
    sceneType: 'general',
    hasSelectionContext: false,
    hasReferenceTrace: false,
    hasExistingFindings: false,
    hasPriorFullAnalysis: false,
    ...override,
  };
}

describe('classifyQueryComplexity — keyword pre-filter', () => {
  describe('DRILL_DOWN_KEYWORDS → full (source: hard_rule)', () => {
    const cases = [
      '为什么这帧卡',
      '根因是什么',
      '深入分析 GC',
      '进一步看看启动',
      '为啥 Binder 这么慢',
      'why is this slow',
      'explain the jank',
      'dig into the main thread',
    ];
    it.each(cases)('classifies %p as full', async (query) => {
      const result = await classifyQueryComplexity(makeInput({ query }));
      expect(result.complexity).toBe('full');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/drill-down keyword match/);
    });
  });

  describe('CONFIRM_KEYWORDS in short query (<20 chars) → quick', () => {
    const cases = [
      '谢谢',
      '好的',
      '明白了',
      '嗯',
      '收到',
      '知道了',
      'thanks',
      'ok',
      'got it',
    ];
    it.each(cases)('classifies %p as quick even when prior full analysis exists', async (query) => {
      // hasPriorFullAnalysis=true proves the keyword pre-filter wins over the multi-turn hard rule.
      const result = await classifyQueryComplexity(makeInput({ query, hasPriorFullAnalysis: true }));
      expect(result.complexity).toBe('quick');
      expect(result.source).toBe('hard_rule');
      expect(result.reason).toMatch(/confirm-like follow-up/);
    });
  });

  it('drill-down keyword wins over confirm when both appear', async () => {
    // Contains "谢谢" (confirm) AND "详细" (drill-down); drill-down is checked first.
    const result = await classifyQueryComplexity(makeInput({
      query: '谢谢,请详细分析一下',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/drill-down keyword match/);
  });

  it('long pure-confirm query (≥20 chars) skips confirm rule and falls through to hard rules', async () => {
    const query = '非常感谢你，你的解释真的非常清楚，我完全明白了'; // 23 chars
    expect(query.length).toBeGreaterThanOrEqual(20);
    const result = await classifyQueryComplexity(makeInput({
      query,
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('hard_rule');
    expect(result.reason).toMatch(/multi-turn continuity/);
  });
});

describe('classifyQueryComplexity — hard rules (no keyword match)', () => {
  const neutralQuery = '随便问问'; // No drill-down or confirm keywords

  it('UI selection context → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasSelectionContext: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.source).toBe('hard_rule');
    expect(result.reason).toMatch(/UI selection context/);
  });

  it('comparison mode (reference trace) → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasReferenceTrace: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/comparison mode/);
  });

  it('prior findings → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasExistingFindings: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/prior findings/);
  });

  it('prior full analysis (multi-turn continuity) → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/multi-turn continuity/);
  });

  it('deterministic scene (scrolling) → full', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('full');
    expect(result.reason).toMatch(/deterministic scene: scrolling/);
  });

  it('non-deterministic scene (memory) with no other hints → Haiku fallback', async () => {
    // memory / game / overview / touch-tracking are intentionally excluded from DETERMINISTIC_SCENES
    // so that "内存多少？" / "帧率多少？" can use the quick path.
    const result = await classifyQueryComplexity(makeInput({
      query: neutralQuery,
      sceneType: 'memory',
    }));
    expect(result.source).toBe('ai'); // Mocked Haiku returns 'full', but via AI path.
  });
});

describe('classifyQueryComplexity — priority ordering', () => {
  it('drill-down keyword overrides scrolling deterministic scene', async () => {
    const result = await classifyQueryComplexity(makeInput({
      query: '为什么滑动卡',
      sceneType: 'scrolling',
    }));
    expect(result.complexity).toBe('full');
    // Reason should be keyword-based, not scene-based.
    expect(result.reason).toMatch(/drill-down keyword match/);
  });

  it('confirm keyword overrides hasPriorFullAnalysis (Codex Q2 fix)', async () => {
    // Central fix: a pure "谢谢" follow-up must not inherit full mode from the previous turn.
    const result = await classifyQueryComplexity(makeInput({
      query: '谢谢',
      hasPriorFullAnalysis: true,
    }));
    expect(result.complexity).toBe('quick');
    expect(result.reason).toMatch(/confirm-like follow-up/);
  });
});
