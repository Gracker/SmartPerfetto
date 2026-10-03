// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {SourceBudget} from '../sourceBudget';
import {
  loadSourceDepthPolicy,
  parseSourceDepthPolicy,
  resolveEffectiveSourceDepth,
} from '../sourceDepthPolicy';

const validPolicy = {
  schema_version: 'source_depth_policy@1',
  depths: {
    locate: {searches: 2, reads: 1, max_read_lines: 40, tokens: 100},
    mechanism: {searches: 4, reads: 3, max_read_lines: 80, tokens: 400},
  },
  knowledge: {tokens: 50},
};

describe('source depth policy', () => {
  it('loads the shipped policy with mechanism at least as large as locate', () => {
    const policy = loadSourceDepthPolicy();
    expect(policy.depths.locate).toEqual({searches: 4, reads: 3, maxReadLines: 80, tokens: 12_000});
    expect(policy.depths.mechanism.tokens).toBeGreaterThan(policy.depths.locate.tokens);
    expect(policy.knowledge.tokens).toBeGreaterThan(0);
  });

  it.each([
    [{...validPolicy, schema_version: 'source_depth_policy@0'}, 'source_depth_policy_invalid_root'],
    [{...validPolicy, extra: true}, 'source_depth_policy_invalid_root'],
    [{...validPolicy, depths: {...validPolicy.depths, locate: {...validPolicy.depths.locate, reads: 0}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, locate: {...validPolicy.depths.locate, locates: 1}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, mechanism: {...validPolicy.depths.mechanism, reads: 0.5}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, mechanism: {...validPolicy.depths.mechanism, searches: 1}}},
      'source_depth_policy_mechanism_below_locate'],
  ])('rejects a malformed policy (%#)', (policy, code) => {
    expect(() => parseSourceDepthPolicy(policy)).toThrow(code);
  });

  it.each([
    [{requested: 'mechanism', budgetMode: 'quick', codeAwareMode: 'provider_send'}, 'mechanism'],
    [{requested: 'locate', budgetMode: 'full', codeAwareMode: 'provider_send'}, 'locate'],
    [{requested: 'auto', budgetMode: 'full', codeAwareMode: 'provider_send'}, 'mechanism'],
    [{budgetMode: 'quick', codeAwareMode: 'provider_send'}, 'locate'],
    // Without a body there is no mechanism to read.
    [{requested: 'mechanism', budgetMode: 'full', codeAwareMode: 'metadata_only'}, 'locate'],
  ] as const)('resolves %j to %s', (input, depth) => {
    expect(resolveEffectiveSourceDepth(input)).toBe(depth);
  });
});

describe('SourceBudget', () => {
  const policy = parseSourceDepthPolicy(validPolicy);

  it('spends a call when it reaches the source and names the exhausted kind', () => {
    const budget = new SourceBudget('locate', policy);
    expect(budget.beginCall('search')).toBeUndefined();
    expect(budget.beginCall('search')).toBeUndefined();
    expect(budget.beginCall('search')).toBe('source_search_budget_exceeded');
    expect(budget.beginCall('read')).toBeUndefined();
    expect(budget.beginCall('read')).toBe('source_read_budget_exceeded');
    expect(budget.snapshot()).toEqual({searchesLeft: 0, readsLeft: 0, tokensLeft: 100});
    expect(budget.maxReadLines).toBe(40);
  });

  it('keeps source and knowledge tokens apart and never goes below zero', () => {
    const budget = new SourceBudget('mechanism', policy);
    budget.sourceTokens.spend(150);
    budget.knowledgeTokens.spend(80);
    budget.sourceTokens.spend(-10);
    expect(budget.sourceTokens.left()).toBe(250);
    expect(budget.knowledgeTokens.left()).toBe(0);
    expect(budget.snapshot()).toEqual({searchesLeft: 4, readsLeft: 3, tokensLeft: 250});
  });
});
