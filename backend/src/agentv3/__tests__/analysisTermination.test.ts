// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildMaxTurnsFallbackConclusion,
  buildMaxTurnsTerminationMessage,
  capPartialConfidence,
  isSdkMaxTurnsSubtype,
  prependPartialNotice,
} from '../analysisTermination';

describe('analysisTermination', () => {
  it('recognizes SDK max-turn subtype', () => {
    expect(isSdkMaxTurnsSubtype('error_max_turns')).toBe(true);
    expect(isSdkMaxTurnsSubtype('error_during_execution')).toBe(false);
  });

  it('builds mode-specific max-turn messages', () => {
    expect(buildMaxTurnsTerminationMessage({ mode: 'fast', turns: 5, maxTurns: 5 }))
      .toContain('快速模式达到轮次上限（5/5 turns）');
    expect(buildMaxTurnsTerminationMessage({ mode: 'full', turns: 30, maxTurns: 30 }))
      .toContain('完整模式达到轮次上限（30/30 turns）');
  });

  it('prepends a partial notice only once', () => {
    const conclusion = '## 结论\n\n已有分析内容';
    const message = buildMaxTurnsTerminationMessage({ mode: 'fast', turns: 5, maxTurns: 5 });
    const withNotice = prependPartialNotice(conclusion, message);

    expect(withNotice).toContain('> 注意: 快速模式达到轮次上限');
    expect(prependPartialNotice(withNotice, message)).toBe(withNotice);
  });

  it('creates fallback conclusions with retry guidance', () => {
    const conclusion = buildMaxTurnsFallbackConclusion({ mode: 'fast', turns: 5, maxTurns: 5 });

    expect(conclusion).toContain('## 分析未完整完成');
    expect(conclusion).toContain('CLAUDE_QUICK_MAX_TURNS');
    expect(conclusion).toContain('full 模式');
  });

  it('caps confidence for partial results', () => {
    expect(capPartialConfidence(0.9, true)).toBe(0.55);
    expect(capPartialConfidence(0.9, false)).toBe(0.25);
    expect(capPartialConfidence(0.4, true)).toBe(0.4);
  });
});
