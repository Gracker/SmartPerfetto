// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {resolveRuntimeTurnPolicy, usesLightweightToolCatalog} from '../runtimeTurnPolicy';

const intent: AnalysisTurnIntent = Object.freeze({
  schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'test',
  taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'read_new',
});

describe('runtime turn policy', () => {
  it('uses Full for budget without imposing memory prefetch or a report on a bounded answer', () => {
    expect(resolveRuntimeTurnPolicy(intent, 'full')).toEqual({
      budgetMode: 'full', onDemandContext: true, allowNewEvidence: true,
      preflight: 'trace_facts', allowAutomaticPrefetch: false, requiresReport: false,
      sourceNeedMissing: 'source_need_missing',
    });
  });

  it('carries a resolved source need, or says why there is none', () => {
    expect(resolveRuntimeTurnPolicy({...intent, sourceNeed: 'mechanism'})).toMatchObject({sourceNeed: 'mechanism'});
    expect(resolveRuntimeTurnPolicy({...intent, sourceNeed: 'mechanism'})).not.toHaveProperty('sourceNeedMissing');
    // An unavailable intent's fallback fields decide nothing about source.
    expect(resolveRuntimeTurnPolicy({...intent, status: 'unavailable', source: 'fallback', sourceNeed: 'mechanism'}))
      .toMatchObject({sourceNeedMissing: 'intent_unavailable'});
    expect(resolveRuntimeTurnPolicy({...intent, source: 'product'})).toMatchObject({sourceNeedMissing: 'product_run'});
  });

  it('preserves evidence and report requirements when the user selects Fast', () => {
    const report = {...intent, taskKind: 'comparison' as const, scope: 'scene_wide' as const, deliverable: 'report' as const};
    const fast = resolveRuntimeTurnPolicy(report, 'fast');
    const full = resolveRuntimeTurnPolicy(report, 'full');
    expect(fast).toEqual({...full, budgetMode: 'quick'});
    expect(fast).toMatchObject({allowNewEvidence: true, preflight: 'full', allowAutomaticPrefetch: true, requiresReport: true});
    expect(Object.isFrozen(fast)).toBe(true);
  });

  it.each(['fast', 'full', 'auto'] as const)('never prefetches for existing_only with %s budget', mode => {
    const policy = resolveRuntimeTurnPolicy({...intent, scope: 'scene_wide', evidenceAccess: 'existing_only'}, mode);
    expect(policy.allowNewEvidence).toBe(false);
    expect(policy.preflight).toBe('none');
    expect(policy.allowAutomaticPrefetch).toBe(false);
  });

  // A narrow question is a reason to skip scene-wide memory lookups, not a
  // reason to answer "why is this page slow" without knowing which app is in
  // focus, what it renders with, or what the capture contains.
  it.each([
    ['resolved scene_wide read_new', {scope: 'scene_wide'} as const, 'full'],
    ['bounded question', {} as const, 'trace_facts'],
    ['unavailable classification', {status: 'unavailable', source: 'fallback', scope: 'scene_wide'} as const, 'trace_facts'],
    ['existing_only', {scope: 'scene_wide', evidenceAccess: 'existing_only'} as const, 'none'],
  ])('resolves %s to preflight %s', (_label, overrides, expected) => {
    const policy = resolveRuntimeTurnPolicy({...intent, ...overrides});
    expect(policy.preflight).toBe(expected);
    expect(policy.allowAutomaticPrefetch).toBe(expected === 'full');
  });

  it.each([
    ['full scene investigation keeps the complete catalog', {scope: 'scene_wide'} as const, 'full' as const, false],
    ['a quick scene investigation still keeps it', {scope: 'scene_wide'} as const, 'fast' as const, false],
    ['a quick bounded question compacts it', {} as const, 'fast' as const, true],
    ['a full bounded question keeps it', {} as const, 'full' as const, false],
    // The unavailable fallback recommends quick, so Full is the only way this
    // turn gets the complete catalog it could never earn from classification.
    ['an unavailable classification under Full keeps it',
      {status: 'unavailable', source: 'fallback', recommendedComplexity: 'quick'} as const, 'full' as const, false],
    ['an unavailable classification on auto compacts it',
      {status: 'unavailable', source: 'fallback', recommendedComplexity: 'quick'} as const, 'auto' as const, true],
  ])('%s', (_label, overrides, mode, expected) => {
    expect(usesLightweightToolCatalog(resolveRuntimeTurnPolicy({...intent, ...overrides}, mode))).toBe(expected);
  });

  it('keeps unavailable classification on demand even with explicit Full', () => {
    const policy = resolveRuntimeTurnPolicy({...intent, status: 'unavailable', source: 'fallback'}, 'full');
    expect(policy).toMatchObject({budgetMode: 'full', onDemandContext: true,
      preflight: 'trace_facts', allowAutomaticPrefetch: false, requiresReport: false});
  });

  it('does not let explanatory text change policy', () => {
    const expected = resolveRuntimeTurnPolicy(intent);
    for (const reason of ['full report', 'do not inspect anything', 'confirm-like follow-up: thanks']) {
      expect(resolveRuntimeTurnPolicy({...intent, reason})).toEqual(expected);
    }
  });
});
