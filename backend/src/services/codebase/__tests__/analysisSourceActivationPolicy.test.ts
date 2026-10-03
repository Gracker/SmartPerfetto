// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  loadAnalysisSourceActivationPolicy,
  parseAnalysisSourceActivationPolicy,
  projectPrimaryAnalysisOptions,
  resolveAnalysisSourceActivation,
} from '../analysisSourceActivationPolicy';

const authorized = {
  codeAwareMode: 'provider_send' as const,
  codebaseIds: ['app'],
};

const validPolicy = {
  schema_version: 'analysis_source_activation_policy@3',
  safe_replay: {max_turns: 6, max_chars_per_entry: 1200},
};

describe('analysis source activation policy', () => {
  it('loads safe replay limits without an intent controller or a source budget', () => {
    // Source budgets are per-run depth limits in source-depth-policy.yaml.
    expect(loadAnalysisSourceActivationPolicy()).toEqual({
      schemaVersion: 'analysis_source_activation_policy@3',
      safeReplay: {maxTurns: 6, maxCharsPerEntry: 1200},
    });
  });

  it.each(['fast', 'auto', 'full'] as const)(
    'keeps authorized source available in the primary %s run regardless of wording',
    analysisMode => {
      for (const query of [
        '分析这段 trace 的卡顿根因',
        '这类卡顿用什么分析方法',
        '这段逻辑在哪个源码文件',
        'Foo::bar 的实现在哪里',
        '完整审查整个源码并给出结论',
        'What caused this delay?',
        '',
      ]) {
        expect(resolveAnalysisSourceActivation({...authorized, analysisMode, query})).toBe('bounded_explicit');
      }
    },
  );

  it.each([
    {codeAwareMode: 'off' as const, codebaseIds: ['app'], hasAuthorizedCodebase: true},
    {codeAwareMode: 'provider_send' as const, codebaseIds: [], hasAuthorizedCodebase: true},
    {codebaseIds: ['app'], hasAuthorizedCodebase: true},
    {codeAwareMode: 'metadata_only' as const, hasAuthorizedCodebase: true},
    {...authorized, hasAuthorizedCodebase: false},
    {},
  ])('does not authorize source from prose or a boolean alone: %j', selection => {
    expect(resolveAnalysisSourceActivation({
      ...selection, analysisMode: 'full', query: '完整审查整个源码 Foo::bar',
    })).toBe('dormant');
  });

  it('keeps metadata-only source available without granting provider-send access', () => {
    expect(resolveAnalysisSourceActivation({
      codeAwareMode: 'metadata_only', codebaseIds: ['app'], query: '继续',
    })).toBe('bounded_explicit');
  });

  it.each(['dormant', 'bounded_explicit', 'deep_supplement'] as const)(
    'preserves caller authorization and policy for the %s historical activation value',
    activation => {
      const options = {
        analysisMode: 'full' as const,
        ...authorized,
        knowledgeSourceIds: ['wiki'],
        analysisContextFingerprint: 'authorization',
        sourceUsePolicy: {phase: 'explicit' as const},
        taskTimeoutMs: 27_000,
      };
      expect(projectPrimaryAnalysisOptions(options, activation)).toBe(options);
      expect(projectPrimaryAnalysisOptions(options, activation).sourceUsePolicy).toBe(options.sourceUsePolicy);
    },
  );

  it('does not inject a source policy that would narrow the MCP tool surface', () => {
    const options = {...authorized, analysisContextFingerprint: 'authorization'};
    expect(projectPrimaryAnalysisOptions(options, 'bounded_explicit')).toBe(options);
    expect(projectPrimaryAnalysisOptions(options, 'bounded_explicit')).not.toHaveProperty('sourceUsePolicy');
  });

  it('rejects replay limits, old schemas, a retired budget, and lexical controller fields', () => {
    expect(() => parseAnalysisSourceActivationPolicy({
      ...validPolicy, bounded_explicit: {max_search_calls: 1, max_read_calls: 2, max_duration_ms: 6000},
    })).toThrow('analysis_source_activation_policy_invalid_root');
    expect(() => parseAnalysisSourceActivationPolicy({
      ...validPolicy, safe_replay: {...validPolicy.safe_replay, max_turns: 0},
    })).toThrow('analysis_source_activation_policy_invalid_safe_replay');
    expect(() => parseAnalysisSourceActivationPolicy({
      ...validPolicy, schema_version: 'analysis_source_activation_policy@2',
    })).toThrow('analysis_source_activation_policy_invalid_root');
    expect(() => parseAnalysisSourceActivationPolicy({
      ...validPolicy, intent: {explicit_patterns: ['source']},
    })).toThrow('analysis_source_activation_policy_invalid_root');
  });
});
