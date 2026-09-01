// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  boundedAnalysisSourceUsePolicy,
  loadAnalysisSourceActivationPolicy,
  parseAnalysisSourceActivationPolicy,
  projectPrimaryAnalysisOptions,
  resolveAnalysisSourceActivation,
} from '../analysisSourceActivationPolicy';

const authorized = {
  codeAwareMode: 'provider_send' as const,
  codebaseIds: ['app'],
};

describe('analysis source activation policy', () => {
  it('loads the bounded budget from the strategy asset', () => {
    expect(loadAnalysisSourceActivationPolicy().boundedExplicit).toEqual({
      maxSearchCalls: 1,
      maxReadCalls: 2,
      maxDurationMs: 6_000,
    });
    expect(loadAnalysisSourceActivationPolicy().safeReplay).toEqual({
      maxTurns: 6,
      maxCharsPerEntry: 1200,
    });
    expect(boundedAnalysisSourceUsePolicy()).toEqual({
      phase: 'explicit',
      maxSearchCalls: 1,
      maxReadCalls: 2,
      maxDurationMs: 6_000,
    });
  });

  it.each(['fast', 'auto', 'full'] as const)(
    'keeps ordinary %s analysis source-dormant after authorization',
    analysisMode => {
      expect(resolveAnalysisSourceActivation({
        ...authorized,
        analysisMode,
        query: '分析这段 trace 的卡顿根因',
      })).toBe('dormant');
    },
  );

  it.each([
    '这类卡顿用什么分析方法',
    '应该用什么方法分析掉帧',
    '这类问题怎么排查',
  ])('keeps ordinary Chinese analysis wording source-dormant: %s', query => {
    for (const analysisMode of ['fast', 'auto', 'full'] as const) {
      expect(resolveAnalysisSourceActivation({
        ...authorized,
        analysisMode,
        query,
      })).toBe('dormant');
    }
  });

  it.each([
    '定位到具体函数和调用链',
    '这段逻辑在哪个源码文件',
    '哪个函数负责处理这个回调',
    'Foo::bar 的实现在哪里',
  ])('keeps explicit source wording active: %s', query => {
    expect(resolveAnalysisSourceActivation({
      ...authorized,
      analysisMode: 'fast',
      query,
    })).toBe('bounded_explicit');
  });

  it.each(['fast', 'auto', 'full'] as const)(
    'uses the bounded source path for explicit %s source questions',
    analysisMode => {
      expect(resolveAnalysisSourceActivation({
        ...authorized,
        analysisMode,
        query: '定位到具体函数和调用链',
      })).toBe('bounded_explicit');
    },
  );

  it('admits deep source review only for an explicitly full request', () => {
    expect(resolveAnalysisSourceActivation({
      ...authorized,
      analysisMode: 'full',
      query: '完整审查整个源码并给出结论',
    })).toBe('deep_supplement');
    expect(resolveAnalysisSourceActivation({
      ...authorized,
      analysisMode: 'auto',
      query: '完整审查整个源码并给出结论',
    })).toBe('bounded_explicit');
  });

  it('keeps every request dormant without an authorized codebase', () => {
    expect(resolveAnalysisSourceActivation({
      analysisMode: 'full',
      query: '完整审查整个源码',
      codeAwareMode: 'off',
      codebaseIds: ['app'],
    })).toBe('dormant');
  });

  it('removes source capability from dormant and deep primary runs', () => {
    const options = {
      analysisMode: 'full' as const,
      ...authorized,
      knowledgeSourceIds: ['wiki'],
      analysisContextFingerprint: 'authorization',
    };
    for (const activation of ['dormant', 'deep_supplement'] as const) {
      expect(projectPrimaryAnalysisOptions(options, activation)).toEqual({
        analysisMode: 'full',
        codeAwareMode: 'off',
        codebaseIds: undefined,
        knowledgeSourceIds: ['wiki'],
        sourceUsePolicy: undefined,
        analysisContextFingerprint: undefined,
      });
    }
  });

  it('preserves authorization only for bounded explicit primary runs', () => {
    expect(projectPrimaryAnalysisOptions({
      analysisMode: 'full',
      ...authorized,
      analysisContextFingerprint: 'authorization',
    }, 'bounded_explicit')).toMatchObject({
      analysisMode: 'full',
      ...authorized,
      analysisContextFingerprint: 'authorization',
      sourceUsePolicy: {
        phase: 'explicit',
        maxSearchCalls: 1,
        maxReadCalls: 2,
        maxDurationMs: 6_000,
      },
    });
  });

  it('fails closed on malformed policy budgets and regexes', () => {
    expect(() => parseAnalysisSourceActivationPolicy({
      schema_version: 'analysis_source_activation_policy@1',
      bounded_explicit: {
        max_search_calls: 0,
        max_read_calls: 2,
        max_duration_ms: 6000,
      },
      safe_replay: {max_turns: 6, max_chars_per_entry: 1200},
      intent: {
        explicit_patterns: ['source'],
        explicit_case_sensitive_patterns: ['Foo::bar'],
        deep_patterns: ['deep'],
      },
    })).toThrow('analysis_source_activation_policy_invalid_budget');
    expect(() => parseAnalysisSourceActivationPolicy({
      schema_version: 'analysis_source_activation_policy@1',
      bounded_explicit: {
        max_search_calls: 1,
        max_read_calls: 2,
        max_duration_ms: 6000,
      },
      safe_replay: {max_turns: 6, max_chars_per_entry: 1200},
      intent: {
        explicit_patterns: ['['],
        explicit_case_sensitive_patterns: ['Foo::bar'],
        deep_patterns: ['deep'],
      },
    })).toThrow('analysis_source_activation_policy_invalid_explicit_patterns');
  });
});
