// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Regression guard for a P0 hidden bug introduced by commit b8ad6fe
 * ("add AGPL v3 SPDX headers to 609 source files").
 *
 * That commit prepended an HTML SPDX comment block to every
 * `*.strategy.md` file. The frontmatter regex previously required the
 * file to begin with `---\n`, so `parseStrategyFile()` started returning
 * `null` for every strategy — silently disabling the entire scene-
 * strategy system until v2.1 Phase 0.2 caught it. All existing
 * `__tests__` mocked `strategyLoader`, so no test caught the regression.
 *
 * This suite intentionally exercises the real loader (no mock) against
 * the on-disk strategy files to ensure scenes load even when the files
 * carry leading SPDX/license comments.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  getAllVerifierMisdiagnosisPatterns,
  getFinalReportContract,
  getRegisteredScenes,
  getStrategyContent,
  getVerifierMisdiagnosisPatterns,
  getPhaseHints,
  parseFinalReportContract,
  invalidateStrategyCache,
  loadPromptTemplate,
} from '../strategyLoader';

describe('strategyLoader tolerates leading SPDX HTML comments', () => {
  beforeAll(() => {
    invalidateStrategyCache();
  });

  it('loads semantic ID and description requirements without regex patterns', () => {
    const contract = parseFinalReportContract({required_sections: [{
      id: 'startup_metrics', description: 'Explain measured TTID and TTFD and the evidence boundary.',
    }]});
    expect(contract?.requiredSections).toEqual([{
      id: 'startup_metrics', label: 'startup_metrics',
      description: 'Explain measured TTID and TTFD and the evidence boundary.',
      required: true, triggerPatterns: [], patterns: [], patternGroups: [],
      recoveryText: {zh: [], en: []},
    }]);
    expect(parseFinalReportContract({required_sections: [null, {description: 'No stable identity'}]})
      ?.requiredSections).toEqual([]);
    expect(parseFinalReportContract({required_sections: [{id: 'optional_scope',
      condition: {kind: 'semantic', description: 'Only when the requested scope includes launch.'}}]})
      ?.requiredSections[0].condition).toEqual({kind: 'semantic', description: 'Only when the requested scope includes launch.'});
  });

  it('loads at least 12 scenes from disk', () => {
    expect(getRegisteredScenes().length).toBeGreaterThanOrEqual(12);
  });

  it('keeps legacy or invalid conditions unresolved instead of requiring them unconditionally', () => {
    // `strong_case_retrieval` is retired: case retrieval never decides a report requirement.
    for (const declaration of [{trigger_patterns: ['case']}, {condition: null},
      {condition: {kind: 'semantic', description: ''}}, {condition: {kind: 'unknown'}},
      {condition: {kind: 'strong_case_retrieval'}}]) {
      const condition = parseFinalReportContract({required_sections: [{id: 'conditional', ...declaration}]})
        ?.requiredSections[0].condition;
      expect(condition).toEqual({kind: 'unresolved',
        reason: 'trigger_patterns' in declaration ? 'legacy_trigger_patterns' : 'invalid_condition'});
    }
  });

  it('ships semantic conditions instead of unresolved lexical report triggers', () => {
    for (const definition of getRegisteredScenes()) {
      const sections = getFinalReportContract(definition.scene)?.requiredSections ?? [];
      expect(new Set(sections.map(section => section.id)).size).toBe(sections.length);
      for (const section of sections) {
        expect(section.triggerPatterns).toEqual([]);
        expect(section.condition?.kind).not.toBe('unresolved');
        if (section.condition?.kind === 'semantic') expect(section.condition.description.trim().length).toBeGreaterThan(0);
      }
    }
    // Case recommendations reach a report from the server's retrieval, never as a content obligation.
    expect(getFinalReportContract('scrolling')?.requiredSections.map(section => section.id))
      .not.toContain('case_recommendations');
  });

  it('returns non-empty content for known scenes', () => {
    for (const scene of ['scrolling', 'startup', 'anr', 'memory', 'io', 'general']) {
      const content = getStrategyContent(scene);
      expect(content).toBeDefined();
      expect((content || '').length).toBeGreaterThan(100);
    }
  });

  it('returns parsed phase_hints for scenes that declare them', () => {
    // Use ranges, not exact counts, so that strategy edits that add or remove
    // hints do not break this regression test (which only asserts that the
    // SPDX-tolerant parser still recognises phase_hints at all).
    expect(getPhaseHints('scrolling').length).toBeGreaterThan(0);
    expect(getPhaseHints('startup').length).toBeGreaterThan(0);
    expect(getPhaseHints('anr').length).toBeGreaterThan(0);
  });

  it('keeps network packet data optional so missing-data guidance can still run', () => {
    const network = getRegisteredScenes().find(scene => scene.scene === 'network');
    expect(network?.requiredCapabilities).not.toContain('network_packets');
    expect(network?.optionalCapabilities).toContain('network_packets');
  });

  it('loads declarative final report contracts from strategy frontmatter', () => {
    const contract = getFinalReportContract('scrolling');
    expect(contract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'root_cause_distribution',
      'representative_frames',
      'peak_and_semantic_metrics',
    ]));
    expect(contract?.requiredSections.find(section =>
      section.id === 'representative_frames',
    )?.patternGroups.length).toBeGreaterThan(1);

    expect(getFinalReportContract('startup')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'startup_type_and_metrics',
      'phase_breakdown',
      'root_cause_references',
      'audience_recommendations',
      'startup_diagnostic_api_boundary',
    ]));
    expect(getFinalReportContract('startup')?.requiredSections.find(section =>
      section.id === 'startup_diagnostic_api_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));

    expect(getFinalReportContract('memory')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'memory_evidence_scope',
      'memory_type_breakdown',
      'memory_confidence_boundary',
      'memory_diagnostic_api_boundary',
    ]));
    expect(getFinalReportContract('memory')?.requiredSections.find(section =>
      section.id === 'memory_diagnostic_api_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));

    const anrContract = getFinalReportContract('anr');
    expect(anrContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'anr_diagnostic_api_boundary',
    ]));
    expect(anrContract?.requiredSections.find(section =>
      section.id === 'anr_diagnostic_api_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));

    expect(getFinalReportContract('io')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'io_evidence_class',
      'app_api_boundary',
      'io_confidence_boundary',
    ]));

    expect(getFinalReportContract('interaction')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'input_stage_breakdown',
      'ack_focus_window_boundary',
      'input_confidence_boundary',
    ]));

    expect(getFinalReportContract('scroll_response')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'scroll_response_scope',
      'scroll_input_target_boundary',
      'frame_timeline_confidence',
    ]));

    const pipelineContract = getFinalReportContract('pipeline');
    expect(pipelineContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'rendering_stage_split',
      'buffer_fence_boundary',
      'graphics_memory_policy_boundary',
    ]));
    expect(pipelineContract?.requiredSections.find(section =>
      section.id === 'graphics_memory_policy_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));
    expect(pipelineContract?.requiredSections.find(section =>
      section.id === 'buffer_fence_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));

    const networkContract = getFinalReportContract('network');
    expect(networkContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'request_stage_evidence_boundary',
      'network_stack_policy_boundary',
    ]));
    expect(networkContract?.requiredSections.find(section =>
      section.id === 'request_stage_evidence_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));
    expect(networkContract?.requiredSections.find(section =>
      section.id === 'network_stack_policy_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));

    const powerContract = getFinalReportContract('power');
    expect(powerContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'job_work_fgs_governance_boundary',
      'alarm_wakeup_vitals_boundary',
    ]));
    expect(powerContract?.requiredSections.find(section =>
      section.id === 'job_work_fgs_governance_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));
    expect(powerContract?.requiredSections.find(section =>
      section.id === 'alarm_wakeup_vitals_boundary',
    )?.condition).toEqual(expect.objectContaining({kind: 'semantic', description: expect.any(String)}));
  });

  it('loads verifier misdiagnosis patterns with scene and global scopes', () => {
    const all = getAllVerifierMisdiagnosisPatterns();
    expect(all.map(pattern => pattern.id)).toEqual(expect.arrayContaining([
      'vsync_vrr_alignment_false_positive',
      'buffer_stuffing_not_app_jank',
      'single_frame_critical_false_positive',
    ]));
    expect(all).toHaveLength(3);
    expect(all.every(pattern => pattern.type === 'known_misdiagnosis')).toBe(true);
    expect(all.every(pattern => pattern.severity === 'warning' || pattern.severity === 'info')).toBe(true);

    const pipeline = getVerifierMisdiagnosisPatterns('pipeline').map(pattern => pattern.id);
    expect(pipeline).toEqual(expect.arrayContaining([
      'vsync_vrr_alignment_false_positive',
      'buffer_stuffing_not_app_jank',
      'single_frame_critical_false_positive',
    ]));

    const startup = getVerifierMisdiagnosisPatterns('startup').map(pattern => pattern.id);
    expect(startup).toEqual(['single_frame_critical_false_positive']);

    const scrollResponse = getVerifierMisdiagnosisPatterns('scroll_response').map(pattern => pattern.id);
    expect(scrollResponse).toEqual(expect.arrayContaining([
      'vsync_vrr_alignment_false_positive',
      'single_frame_critical_false_positive',
    ]));
    expect(scrollResponse).not.toContain('buffer_stuffing_not_app_jank');

    const interaction = getVerifierMisdiagnosisPatterns('interaction').map(pattern => pattern.id);
    expect(interaction).toEqual(expect.arrayContaining([
      'vsync_vrr_alignment_false_positive',
      'single_frame_critical_false_positive',
    ]));
    expect(interaction).not.toContain('buffer_stuffing_not_app_jank');
  });

  it('keeps contract-only smart strategy out of normal scene registration', () => {
    const scenes = getRegisteredScenes();
    expect(scenes).not.toContain('smart');
    expect(getStrategyContent('smart')).toBeUndefined();
    expect(getPhaseHints('smart')).toEqual([]);

    const contract = getFinalReportContract('smart');
    expect(contract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'scene_timeline',
      'per_scene_summary',
      'cross_scene_narrative',
      'bottleneck_ranking',
    ]));
  });

  it('returns empty phase_hints array for scenes without hints', () => {
    expect(getPhaseHints('general')).toEqual([]);
  });

  it('loads memory phase_hints for evidence-boundary reminders', () => {
    const hints = getPhaseHints('memory');
    expect(hints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'memory_evidence_gate',
      'lmk_freezer_oom_boundary',
      'gc_churn_boundary',
      'memory_diagnostic_api_boundary',
    ]));
    expect(hints.find(hint => hint.id === 'memory_evidence_gate')?.criticalTools).toContain('memory_analysis');
    expect(hints.find(hint => hint.id === 'memory_diagnostic_api_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'memory_analysis',
      'lookup_knowledge',
    ]));
  });

  it('loads startup and ANR phase_hints for diagnostic API evidence boundaries', () => {
    const startupHints = getPhaseHints('startup');
    expect(startupHints.map(hint => hint.id)).toContain('startup_diagnostic_api_boundary');
    expect(startupHints.find(hint => hint.id === 'startup_diagnostic_api_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'startup_analysis',
      'lookup_knowledge',
    ]));

    const startupDetailHint = startupHints.find(hint => hint.id === 'detail_breakdown');
    expect(startupDetailHint?.constraints).toMatch(/start_ts.*end_ts.*dur_ms.*startup_type/);
    expect(startupDetailHint?.constraints).not.toMatch(/ttid_ts|ttfd_ts/);

    const anrHints = getPhaseHints('anr');
    expect(anrHints.map(hint => hint.id)).toContain('anr_diagnostic_api_boundary');
    expect(anrHints.find(hint => hint.id === 'anr_diagnostic_api_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'anr_analysis',
      'lookup_knowledge',
    ]));
  });

  it('loads io phase_hints for storage evidence boundaries', () => {
    const hints = getPhaseHints('io');
    expect(hints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'io_evidence_ladder',
      'sqlite_sharedprefs_provider_boundary',
    ]));
    expect(hints.find(hint => hint.id === 'io_evidence_ladder')?.criticalTools).toContain('block_io_analysis');
  });

  it('loads interaction phase_hints for input ACK and focus/window boundaries', () => {
    const hints = getPhaseHints('interaction');
    expect(hints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'input_ack_queue_boundary',
      'focus_window_stale_boundary',
      'display_present_boundary',
    ]));
    expect(hints.find(hint => hint.id === 'input_ack_queue_boundary')?.criticalTools).toContain('click_response_analysis');
  });

  it('loads rendering pipeline phase_hints for BufferQueue, fence, and refresh policy boundaries', () => {
    const pipelineHints = getPhaseHints('pipeline');
    expect(pipelineHints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'buffer_fence_lifecycle',
      'refresh_policy_boundary',
      'graphics_memory_boundary',
    ]));
    expect(pipelineHints.find(hint => hint.id === 'buffer_fence_lifecycle')?.criticalTools).toContain('fence_wait_decomposition');

    const scrollingHints = getPhaseHints('scrolling');
    expect(scrollingHints.map(hint => hint.id)).toContain('display_pipeline_boundary');
    const displayBoundary = scrollingHints.find(hint => hint.id === 'display_pipeline_boundary');
    // The boundary decomposition tools stay declared...
    expect(displayBoundary?.criticalTools).toEqual(
      expect.arrayContaining(['surfaceflinger_analysis', 'buffer_transaction_lifecycle', 'fence_wait_decomposition']),
    );
    // ...but optional supplementary tools must NOT be pre-declared as
    // unconditional expectedCalls. The hint's own constraints say to reuse the
    // scrolling_analysis vsync_config artifact and only call the standalone
    // tools when that evidence is missing.
    expect(displayBoundary?.criticalTools).not.toContain('vsync_config');
    expect(displayBoundary?.criticalTools).not.toContain('present_fence_timing');
  });

  it('loads network phase_hints for request-stage and stack-policy boundaries', () => {
    const hints = getPhaseHints('network');
    expect(hints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'network_packets',
      'request_stage_boundary',
      'network_state_policy_boundary',
    ]));
    expect(hints.find(hint => hint.id === 'request_stage_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'network_analysis',
      'lookup_knowledge',
    ]));
    expect(hints.find(hint => hint.id === 'network_state_policy_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'network_analysis',
      'lookup_knowledge',
    ]));
  });

  it('loads power phase_hints for background execution and alarm wakeup boundaries', () => {
    const hints = getPhaseHints('power');
    expect(hints.map(hint => hint.id)).toEqual(expect.arrayContaining([
      'background_execution_governance',
      'alarm_wakeup_boundary',
    ]));
    expect(hints.find(hint => hint.id === 'background_execution_governance')?.criticalTools).toEqual(expect.arrayContaining([
      'android_job_scheduler_events',
      'suspend_wakeup_analysis',
      'lookup_knowledge',
    ]));
    expect(hints.find(hint => hint.id === 'alarm_wakeup_boundary')?.criticalTools).toEqual(expect.arrayContaining([
      'wakeup_frequency_summary',
      'android_kernel_wakelock_summary',
    ]));
  });

  it('removes retired prompt assets instead of leaving an alternate output contract', () => {
    for (const name of ['prompt-role', 'prompt-quick', 'prompt-quick-sql-definitions', 'code-aware',
      'prompt-output-format', 'prompt-methodology', 'comparison-context', 'comparison-context-en',
      'comparison-methodology', 'comparison-result-methodology', 'arch-compose', 'arch-flutter',
      'arch-standard', 'arch-webview', 'selection-area', 'selection-slice']) {
      expect(loadPromptTemplate(name)).toBeUndefined();
    }
  });

  it('loads evidence provenance and dimension-specific knowledge independently from the retired output template', () => {
    const knowledge = loadPromptTemplate('knowledge-evidence-provenance');
    for (const fact of ['trace_direct', 'derived_metric', 'external_aggregate', 'missing_evidence',
      '版本敏感能力', 'claim_boundary', 'evidence_scope', 'aggregate.complete=true']) {
      expect(knowledge).toContain(fact);
    }
    const network = loadPromptTemplate('knowledge-network-evidence');
    expect(network).toContain('request_telemetry');
    expect(network).toContain('local-network permission');
    const observability = loadPromptTemplate('knowledge-observability-diagnostics');
    for (const api of ['ApplicationExitInfo', 'ApplicationStartInfo', 'ProfilingManager', 'Play Vitals',
      'App Performance Score']) expect(observability).toContain(api);
    const blocked = loadPromptTemplate('knowledge-thread-state-blocked-reason');
    for (const anchor of ['sched/sched_blocked_reason', 'single frame', 'filemap_read']) {
      expect(blocked).toContain(anchor);
    }
  });

  it('loads schema discovery and intentional SQL matching guidance from the live knowledge asset', () => {
    const sql = loadPromptTemplate('knowledge-perfetto-sql');
    expect(sql).toContain('__intrinsic_stdlib_objects');
    expect(sql).toContain('Read candidate summary/schema before querying');
    expect(sql).toContain("regexp(pattern, input, 'i')");
    expect(sql).toContain('Exact matching uses =');
    expect(sql).toContain('matching uses GLOB');
    expect(sql).toContain('Trace ts/dur filters use nanoseconds');
    expect(loadPromptTemplate('prompt-sql-evidence-guidance')).toContain('fetch_artifact, not VALUES');
  });
  it('keeps selection and comparison evidence boundaries in discoverable knowledge assets', () => {
    const selection = loadPromptTemplate('knowledge-selection-scope');
    expect(selection).toContain('lookup input, not a');
    expect(selection).toContain('different namespaces');
    expect(selection).toContain('selection grants no new read');
    expect(selection).toContain('Overlapping parent/child durations cannot');
    const comparison = loadPromptTemplate('knowledge-trace-comparison');
    expect(comparison).toContain('currentParams/referenceParams');
    expect(comparison).toContain('one side does not collect evidence from both');
    expect(comparison).toContain('Do not recover numbers from report prose');
    expect(comparison).toContain('zero or');
    expect(comparison).toContain('missing baseline does not support percentage change');
  });

  it('preserves summary-first artifact access without reducing final conclusion coverage', () => {
    const guidance = loadPromptTemplate('prompt-artifact-result-guidance');
    expect(guidance).toContain('forbidRows={{forbidRows}}');
    expect(guidance).toContain('requireSummaryBeforeRows={{requireSummaryBeforeRows}}');
    expect(guidance).toContain('fetch detail="summary" first');
    expect(guidance).toContain('Previews do not limit conclusion coverage');
    expect(guidance).toContain('do not end analysis or drop findings');
  });

});
