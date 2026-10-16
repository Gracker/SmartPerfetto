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
    locate: {searches: 2, reads: 1, locates: 1, max_read_lines: 40, tokens: 100},
    mechanism: {searches: 4, reads: 3, locates: 2, max_read_lines: 80, tokens: 400},
  },
  knowledge: {tokens: 50, searches: 1, reads: 2, part_chars: 100},
};

describe('source depth policy', () => {
  it('loads the shipped policy with mechanism at least as large as locate', () => {
    const policy = loadSourceDepthPolicy();
    expect(policy.depths.locate).toEqual({searches: 4, reads: 3, locates: 2, maxReadLines: 80, tokens: 12_000});
    expect(policy.depths.mechanism.tokens).toBeGreaterThan(policy.depths.locate.tokens);
    expect(policy.knowledge.tokens).toBeGreaterThan(0);
    expect(policy.knowledge.partChars).toBeGreaterThan(0);
  });

  it.each([
    [{...validPolicy, schema_version: 'source_depth_policy@0'}, 'source_depth_policy_invalid_root'],
    [{...validPolicy, extra: true}, 'source_depth_policy_invalid_root'],
    [{...validPolicy, depths: {...validPolicy.depths, locate: {...validPolicy.depths.locate, reads: 0}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, locate: {...validPolicy.depths.locate, finds: 1}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, locate: (({locates: _omit, ...rest}) => rest)(validPolicy.depths.locate)}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, mechanism: {...validPolicy.depths.mechanism, reads: 0.5}}},
      'source_depth_policy_invalid_depth'],
    [{...validPolicy, depths: {...validPolicy.depths, mechanism: {...validPolicy.depths.mechanism, searches: 1}}},
      'source_depth_policy_mechanism_below_locate'],
    [{...validPolicy, knowledge: {tokens: 50}}, 'source_depth_policy_invalid_root'],
    [{...validPolicy, knowledge: {...validPolicy.knowledge, part_chars: 0}}, 'source_depth_policy_invalid_knowledge'],
  ])('rejects a malformed policy (%#)', (policy, code) => {
    expect(() => parseSourceDepthPolicy(policy)).toThrow(code);
  });

  it.each([
    // An explicit choice wins over the intent and the budget.
    [{requested: 'mechanism', sourceNeed: 'none', budgetMode: 'quick', codeAwareMode: 'provider_send'},
      {requested: 'mechanism', effective: 'mechanism', origin: 'requested'}],
    [{requested: 'locate', sourceNeed: 'mechanism', budgetMode: 'full', codeAwareMode: 'provider_send'},
      {requested: 'locate', effective: 'locate', origin: 'requested'}],
    // Auto follows the intent's source need, whatever the budget.
    [{requested: 'auto', sourceNeed: 'mechanism', budgetMode: 'quick', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'mechanism', origin: 'intent'}],
    [{requested: 'auto', sourceNeed: 'locate', budgetMode: 'full', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'locate', origin: 'intent'}],
    [{sourceNeed: 'none', budgetMode: 'full', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'locate', origin: 'intent'}],
    // Without a source need, the budget decides and says why.
    [{requested: 'auto', budgetMode: 'full', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'mechanism', origin: 'budget', fallbackReason: 'source_need_missing'}],
    [{budgetMode: 'quick', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'locate', origin: 'budget', fallbackReason: 'source_need_missing'}],
    [{sourceNeedMissing: 'intent_unavailable', budgetMode: 'full', codeAwareMode: 'provider_send'},
      {requested: 'auto', effective: 'mechanism', origin: 'budget', fallbackReason: 'intent_unavailable'}],
    // Without a body there is no mechanism to read; the cap is recorded.
    [{requested: 'mechanism', budgetMode: 'full', codeAwareMode: 'metadata_only'},
      {requested: 'mechanism', effective: 'locate', origin: 'requested', cap: 'metadata_only'}],
    [{sourceNeed: 'locate', budgetMode: 'full', codeAwareMode: 'metadata_only'},
      {requested: 'auto', effective: 'locate', origin: 'intent'}],
  ] as const)('resolves %j', (input, decision) => {
    expect(resolveEffectiveSourceDepth(input)).toEqual(decision);
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
    expect(budget.beginCall('locate')).toBeUndefined();
    expect(budget.beginCall('locate')).toBe('source_locate_budget_exceeded');
    expect(budget.snapshot()).toEqual({searchesLeft: 0, readsLeft: 0, locatesLeft: 0, tokensLeft: 100});
    expect(budget.maxReadLines).toBe(40);
  });

  it('keeps source and knowledge tokens apart and never goes below zero', () => {
    const budget = new SourceBudget('mechanism', policy);
    budget.sourceTokens.spend(150);
    budget.knowledgeTokens.spend(80);
    budget.sourceTokens.spend(-10);
    expect(budget.sourceTokens.left()).toBe(250);
    expect(budget.knowledgeTokens.left()).toBe(0);
    expect(budget.snapshot()).toEqual({searchesLeft: 4, readsLeft: 3, locatesLeft: 2, tokensLeft: 250});
  });

  it('counts knowledge calls apart from source calls, whatever the depth', () => {
    const budget = new SourceBudget('locate', policy);
    expect(budget.beginKnowledgeCall('search')).toBeUndefined();
    expect(budget.beginKnowledgeCall('search')).toBe('knowledge_search_budget_exceeded');
    expect(budget.beginKnowledgeCall('read')).toBeUndefined();
    expect(budget.beginKnowledgeCall('read')).toBeUndefined();
    expect(budget.beginKnowledgeCall('read')).toBe('knowledge_read_budget_exceeded');
    expect(budget.knowledgeSnapshot()).toEqual({searchesLeft: 0, readsLeft: 0, tokensLeft: 50});
    expect(budget.snapshot()).toEqual({searchesLeft: 2, readsLeft: 1, locatesLeft: 1, tokensLeft: 100});
    expect(budget.knowledgePartChars).toBe(100);
  });
});
