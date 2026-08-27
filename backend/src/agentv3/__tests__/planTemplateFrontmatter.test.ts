// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 2.1 of v2.1 — verify the strategy-frontmatter `plan_template:`
 * pipeline.
 *
 * `getScenePlanTemplate(scene)` is dual-read: it prefers a template
 * declared in the strategy's frontmatter and falls back to the legacy
 * hardcoded `SCENE_PLAN_TEMPLATES` map. Once every strategy migrates,
 * the legacy map can be removed; until then both shapes must coexist
 * without surprise.
 */

import { describe, it, expect } from '@jest/globals';
import {
  getScenePlanTemplate,
  validatePlanAgainstSceneTemplate,
} from '../scenePlanTemplates';
import {loadSourceInvestigationPolicy} from '../sourceInvestigationPolicy';
import { getPlanTemplate, invalidateStrategyCache, getRegisteredScenes } from '../strategyLoader';

describe('plan_template frontmatter pipeline', () => {
  beforeAll(() => invalidateStrategyCache());

  it('loads scrolling plan_template from strategy.md frontmatter', () => {
    const tpl = getPlanTemplate('scrolling');
    expect(tpl).not.toBeNull();
    expect(tpl!.mandatoryAspects.length).toBeGreaterThan(0);
    // Frontmatter aspects carry stable ids, unlike legacy entries.
    for (const aspect of tpl!.mandatoryAspects) {
      expect(aspect.id.length).toBeGreaterThan(0);
      expect(aspect.matchKeywords.length).toBeGreaterThan(0);
      expect(aspect.suggestion.trim().length).toBeGreaterThan(0);
    }
    const architectureAspect = tpl!.mandatoryAspects.find(
      aspect => aspect.id === 'architecture_specific_jank',
    );
    expect(architectureAspect?.conditionalRequiredExpectedCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        triggerKeywords: expect.arrayContaining(['TextureView', 'TEXTUREVIEW_STANDARD']),
        requiredExpectedCalls: [
          { tool: 'invoke_skill', skillId: 'textureview_producer_frame_timing' },
        ],
      }),
    ]));
  });

  it('returns null for scenes that have no frontmatter plan_template (e.g. general)', () => {
    expect(getPlanTemplate('general')).toBeNull();
  });

  it('loads interaction plan_template from strategy.md frontmatter', () => {
    const tpl = getPlanTemplate('interaction');
    expect(tpl).not.toBeNull();
    expect(tpl!.mandatoryAspects.map(aspect => aspect.id)).toEqual(expect.arrayContaining([
      'input_latency_stage_breakdown',
      'focus_stale_channel_boundary',
    ]));
  });

  it('keeps conditional BufferQueue/Fence and refresh-policy boundaries out of pipeline plan hard gates', () => {
    const tpl = getPlanTemplate('pipeline');
    expect(tpl).not.toBeNull();
    const ids = tpl!.mandatoryAspects.map(aspect => aspect.id);
    expect(ids).toEqual(expect.arrayContaining([
      'architecture_detection',
      'pipeline_skill_invocation',
    ]));
    expect(ids).not.toContain('buffer_fence_lifecycle');
    expect(ids).not.toContain('refresh_policy_budget');
  });

  it('returns null for unknown scenes', () => {
    expect(getPlanTemplate('this-scene-does-not-exist')).toBeNull();
  });

  it('every migrated scene exposes ids that round-trip through getScenePlanTemplate()', () => {
    // Scenes that were migrated to frontmatter should expose `id` on every
    // aspect; scenes that still rely on the legacy map have `id` undefined.
    const migrated = [
      'scrolling', 'startup', 'anr', 'teaching', 'scroll_response',
      'pipeline', 'memory', 'io', 'interaction', 'game', 'overview', 'touch_tracking',
    ];
    for (const scene of migrated) {
      const tpl = getScenePlanTemplate(scene);
      expect(tpl).toBeDefined();
      expect(tpl!.mandatoryAspects.length).toBeGreaterThan(0);
      for (const aspect of tpl!.mandatoryAspects) {
        expect(aspect.id).toBeTruthy();
      }
    }
  });

  it('does not break for opt-out scenes when a plan is submitted against them', () => {
    expect(getScenePlanTemplate('general')).toBeUndefined();
  });

  it('frontmatter-sourced templates contain the same matchKeywords as the legacy map (migration parity)', () => {
    // Spot-check scrolling: its frontmatter aspects must mention the same
    // critical keywords that the legacy map carried, otherwise the
    // hard-gate behaviour silently changed during migration.
    const scrollingTpl = getScenePlanTemplate('scrolling');
    expect(scrollingTpl).toBeDefined();
    const allKeywords = scrollingTpl!.mandatoryAspects.flatMap(a => a.matchKeywords.map(k => k.toLowerCase()));
    for (const required of ['frame', 'jank', 'scrolling_analysis', 'jank_frame_detail']) {
      expect(allKeywords).toContain(required);
    }
  });

  it('keeps Chrome scroll jank as a conditional hint, not a generic scrolling plan gate', () => {
    const scrollingTpl = getScenePlanTemplate('scrolling');
    expect(scrollingTpl).toBeDefined();
    const ids = scrollingTpl!.mandatoryAspects.map(a => a.id);
    expect(ids).not.toContain('chrome_scroll_jank');
    expect(ids).not.toContain('display_pipeline_boundary');
  });

  it('every registered scene resolves through dual-read without throwing', () => {
    for (const def of getRegisteredScenes()) {
      // Either frontmatter, or legacy fallback, or undefined (opt-out) — all OK.
      expect(() => getScenePlanTemplate(def.scene)).not.toThrow();
    }
  });

  it('keeps trace-only plan validation byte-for-behavior unchanged for every discovered scene', () => {
    const phases = [{
      name: 'Trace evidence',
      goal: 'Collect the scene-specific trace evidence required by the existing template',
      expectedTools: ['invoke_skill'],
    }];
    const beforePolicyLoad = getRegisteredScenes().map(definition => ({
      scene: definition.scene,
      result: validatePlanAgainstSceneTemplate(phases, definition.scene),
    }));

    loadSourceInvestigationPolicy();

    const afterPolicyLoad = getRegisteredScenes().map(definition => ({
      scene: definition.scene,
      result: validatePlanAgainstSceneTemplate(phases, definition.scene),
    }));
    expect(JSON.stringify(afterPolicyLoad)).toBe(JSON.stringify(beforePolicyLoad));
    expect(JSON.stringify(afterPolicyLoad)).not.toContain('source_investigation_decision');
    expect(validatePlanAgainstSceneTemplate([], 'general')).toEqual({
      warnings: [],
      missingAspectIds: [],
    });
  });

  it('adds one non-waivable source-decision aspect only for code-aware Full plans', () => {
    for (const definition of getRegisteredScenes()) {
      const result = validatePlanAgainstSceneTemplate(
        [],
        definition.scene,
        [{
          aspectId: 'source_investigation_decision',
          reason: 'The source phase is intentionally omitted despite being required by this code-aware Full plan.',
        }],
        {sourceInvestigation: {mode: 'code_aware_full'}},
      );
      expect(result.missingAspectIds.filter(
        aspectId => aspectId === 'source_investigation_decision',
      )).toHaveLength(1);
      expect(result.nonWaivableMissingAspectIds).toContain(
        'source_investigation_decision',
      );
    }
  });

  it('accepts either a source lookup path or an explicit decision record', () => {
    const lookupPath = validatePlanAgainstSceneTemplate(
      [{
        name: 'Source lookup',
        goal: 'Use search_codebase to investigate the trace-supported candidate',
        expectedTools: ['search_codebase'],
        expectedCalls: [{tool: 'search_codebase'}],
      }],
      'general',
      undefined,
      {sourceInvestigation: {mode: 'code_aware_full'}},
    );
    expect(lookupPath.missingAspectIds).not.toContain('source_investigation_decision');

    const explicitDecision = validatePlanAgainstSceneTemplate(
      [{
        name: 'Trace conclusion',
        goal: 'Conclude after a separately recorded source-use decision',
        expectedTools: [],
      }],
      'general',
      undefined,
      {sourceInvestigation: {
        mode: 'code_aware_full',
        decision: {
          status: 'not_needed',
          reason: 'The trace evidence is conclusive and exposes no implementation question requiring source investigation.',
        },
      }},
    );
    expect(explicitDecision.missingAspectIds).not.toContain(
      'source_investigation_decision',
    );
  });

  it.each([
    'read_or_indexed_lookup',
    'resolve_symbol',
    'code_pinpoint',
  ])('does not accept invoke_skill fallback guidance as source lookup: %s', skillId => {
    const result = validatePlanAgainstSceneTemplate(
      [{
        name: 'Trace anchor only',
        goal: `Invoke ${skillId} without performing a source lookup`,
        expectedTools: ['invoke_skill'],
        expectedCalls: [{tool: 'invoke_skill', skillId}],
      }],
      'general',
      undefined,
      {sourceInvestigation: {mode: 'code_aware_full'}},
    );
    expect(result.missingAspectIds).toContain('source_investigation_decision');
    expect(result.nonWaivableMissingAspectIds).toContain(
      'source_investigation_decision',
    );
  });

  it.each([
    ['not_needed', 'record_source_use_decision'],
    ['unverified', 'record_source_use_decision'],
    ['read_or_indexed_lookup', 'read_or_indexed_lookup'],
    ['code_pinpoint', 'code_pinpoint'],
  ])('does not accept policy vocabulary or fake raw tools: %s', (keyword, fakeTool) => {
    const result = validatePlanAgainstSceneTemplate(
      [{
        name: 'Trace only',
        goal: `Mention ${keyword} without declaring a source lookup or decision record`,
        expectedTools: [fakeTool],
        expectedCalls: [{tool: fakeTool}],
      }],
      'general',
      undefined,
      {sourceInvestigation: {mode: 'code_aware_full'}},
    );
    expect(result.missingAspectIds).toContain('source_investigation_decision');
  });

  it('rejects an underspecified explicit decision record', () => {
    const result = validatePlanAgainstSceneTemplate(
      [],
      'general',
      undefined,
      {sourceInvestigation: {
        mode: 'code_aware_full',
        decision: {status: 'not_needed', reason: 'too short'},
      }},
    );
    expect(result.missingAspectIds).toContain('source_investigation_decision');
  });

  it('accepts a policy-backed disallowed decision with a bounded explicit reason', () => {
    const result = validatePlanAgainstSceneTemplate(
      [],
      'general',
      undefined,
      {sourceInvestigation: {
        mode: 'code_aware_full',
        decision: {
          status: 'disallowed',
          reason: 'Provider consent does not authorize source-body access for this bounded analysis run.',
        },
      }},
    );

    expect(result.missingAspectIds).not.toContain('source_investigation_decision');
    expect(result.nonWaivableMissingAspectIds ?? []).not.toContain('source_investigation_decision');
  });

  it('re-applies the source-decision hard gate when a revised plan drops the phase', () => {
    const initial = validatePlanAgainstSceneTemplate(
      [{
        name: 'Source decision',
        goal: 'Search source after checking the trace anchors',
        expectedTools: ['search_codebase'],
        expectedCalls: [{tool: 'search_codebase'}],
      }],
      'general',
      undefined,
      {sourceInvestigation: {mode: 'code_aware_full'}},
    );
    expect(initial.missingAspectIds).not.toContain('source_investigation_decision');

    const revised = validatePlanAgainstSceneTemplate(
      [{
        name: 'Trace conclusion',
        goal: 'Summarize trace evidence without the required source decision phase',
        expectedTools: [],
      }],
      'general',
      undefined,
      {sourceInvestigation: {mode: 'code_aware_full'}},
    );
    expect(revised.missingAspectIds).toContain('source_investigation_decision');
    expect(revised.nonWaivableMissingAspectIds).toContain(
      'source_investigation_decision',
    );
  });
});
