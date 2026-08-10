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
  invalidateStrategyCache,
  loadPromptTemplate,
} from '../strategyLoader';

describe('strategyLoader tolerates leading SPDX HTML comments', () => {
  beforeAll(() => {
    invalidateStrategyCache();
  });

  it('loads at least 12 scenes from disk', () => {
    expect(getRegisteredScenes().length).toBeGreaterThanOrEqual(12);
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
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'ApplicationStartInfo|getHistoricalProcessStartReasons|STARTUP_STATE|START_TIMESTAMP|START_REASON|START_COMPONENT',
    ]));

    expect(getFinalReportContract('memory')?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'memory_evidence_scope',
      'memory_type_breakdown',
      'memory_confidence_boundary',
      'memory_diagnostic_api_boundary',
    ]));
    expect(getFinalReportContract('memory')?.requiredSections.find(section =>
      section.id === 'memory_diagnostic_api_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'ApplicationExitInfo|getHistoricalProcessExitReasons|REASON_LOW_MEMORY|REASON_FREEZER|REASON_EXCESSIVE_RESOURCE_USAGE',
    ]));

    const anrContract = getFinalReportContract('anr');
    expect(anrContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'anr_diagnostic_api_boundary',
    ]));
    expect(anrContract?.requiredSections.find(section =>
      section.id === 'anr_diagnostic_api_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'ApplicationExitInfo|getHistoricalProcessExitReasons|getAnrInfo|REASON_ANR',
      'ProfilingManager|ProfilingTrigger|TRIGGER_TYPE_ANR',
    ]));

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
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'GraphicBuffer|dma[-_ ]?buf|graphics\\s+memory|图形内存|GPU memory',
    ]));
    expect(pipelineContract?.requiredSections.find(section =>
      section.id === 'buffer_fence_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'BufferQueue|BLAST|queueBuffer|dequeueBuffer',
    ]));

    const networkContract = getFinalReportContract('network');
    expect(networkContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'request_stage_evidence_boundary',
      'network_stack_policy_boundary',
    ]));
    expect(networkContract?.requiredSections.find(section =>
      section.id === 'request_stage_evidence_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      '(网络|network).*(慢|延迟|latency|slow|请求慢|request.*slow)|(请求|request).*(慢|耗时|延迟|latency|slow)',
      'DNS|TTFB|HTTPDNS|OkHttp|Cronet|HttpEngine|EventListener|request[- ]stage|首包|首字节|secureConnect|responseHeadersStart',
      'TLS|handshake|\\bconnect(?:Start|End)?\\b|request body|response body|body transfer|decode|server log|access[- ]layer|APM',
    ]));
    expect(networkContract?.requiredSections.find(section =>
      section.id === 'network_stack_policy_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'NetworkCallback|NetworkCapabilities|validated internet|metered|estimated bandwidth|bandwidth estimate|local network permission|ACCESS_LOCAL_NETWORK|satellite|constrained network',
    ]));

    const powerContract = getFinalReportContract('power');
    expect(powerContract?.requiredSections.map(section => section.id)).toEqual(expect.arrayContaining([
      'job_work_fgs_governance_boundary',
      'alarm_wakeup_vitals_boundary',
    ]));
    expect(powerContract?.requiredSections.find(section =>
      section.id === 'job_work_fgs_governance_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'JobScheduler|WorkManager|Foreground Service|\\bFGS\\b|foreground worker|JobParameters|WorkInfo|UIDT|user[- ]initiated data transfer',
    ]));
    expect(powerContract?.requiredSections.find(section =>
      section.id === 'alarm_wakeup_vitals_boundary',
    )?.triggerPatterns).toEqual(expect.arrayContaining([
      'allow[- ]while[- ]idle|setExactAndAllowWhileIdle|exact alarm|AlarmManager|wakeup alarm|excessive wakeups',
    ]));
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
    expect(scrollingHints.find(hint => hint.id === 'display_pipeline_boundary')?.criticalTools).toContain('present_fence_timing');
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

  it('keeps the AgentV3 output template wired for machine-parseable claim provenance', () => {
    const content = loadPromptTemplate('prompt-output-format');
    expect(content).toContain('## 逐句数据引用（结构化来源）');
    expect(content).toContain('evidence_ref_id=<data:* 或 ev_* 证据 ID>');
    expect(content).toContain('source_tool_call_id=<工具调用 ID，如可见>');
    expect(content).toContain('row_index=<0-based 行号，如可见>');
  });

  it('loads the evidence provenance knowledge topic and global evidence contract', () => {
    const outputFormat = loadPromptTemplate('prompt-output-format');
    expect(outputFormat).toContain('证据来源、置信度与版本边界');
    expect(outputFormat).toContain('trace_direct');
    expect(outputFormat).toContain('missing_evidence');
    expect(outputFormat).toContain('thread-state-blocked-reason');

    const methodology = loadPromptTemplate('prompt-methodology');
    expect(methodology).toContain('lookup_knowledge("evidence-provenance")');
    expect(methodology).toContain('packet-level 网络 trace');
    expect(methodology).toContain('原始且不可变的假设命题');
    expect(methodology).toContain('先 rejected 原命题，再 submit_hypothesis');

    const knowledge = loadPromptTemplate('knowledge-evidence-provenance');
    expect(knowledge).toContain('## 证据来源与置信度边界');
    expect(knowledge).toContain('external_aggregate');
    expect(knowledge).toContain('版本敏感能力');

    const networkKnowledge = loadPromptTemplate('knowledge-network-evidence');
    expect(networkKnowledge).toContain('Network Evidence Boundaries');
    expect(networkKnowledge).toContain('request_telemetry');
    expect(networkKnowledge).toContain('local-network permission');

    const observabilityKnowledge = loadPromptTemplate('knowledge-observability-diagnostics');
    expect(observabilityKnowledge).toContain('ApplicationExitInfo');
    expect(observabilityKnowledge).toContain('ApplicationStartInfo');
    expect(observabilityKnowledge).toContain('ProfilingManager');
    expect(observabilityKnowledge).toContain('Play Vitals');
    expect(observabilityKnowledge).toContain('App Performance Score');

    const blockedReasonKnowledge = loadPromptTemplate('knowledge-thread-state-blocked-reason');
    expect(blockedReasonKnowledge).toContain('sched/sched_blocked_reason');
    expect(blockedReasonKnowledge).toContain('single frame');
    expect(blockedReasonKnowledge).toContain('filemap_read');
  });

  it('keeps the quick prompt wired for machine-parseable claim provenance', () => {
    const content = loadPromptTemplate('prompt-quick');
    expect(content).toContain('## 逐句数据引用（结构化来源）');
    expect(content).toContain('evidence_ref_id=<data:* 或 ev_* 证据 ID>');
    expect(content).toContain('source_ref=<表 1/摘要 1>');
    expect(content).toContain('column=<列名>; value=<原始值>');
  });

  it('keeps the quick prompt wired to fetch Skill artifacts instead of querying pseudo-tables', () => {
    const content = loadPromptTemplate('prompt-quick');
    expect(content).toContain('## Artifact 读取规则');
    expect(content).toContain('fetch_artifact(artifactId="art-N", detail="rows", offset=0, limit=50)');
    expect(content).toContain('__intrinsic_artifact_rows');
    expect(content).toContain('这些都不是 SQL 表');
  });

  it('keeps the quick prompt routed through scrolling_analysis for scroll/jank overviews', () => {
    const content = loadPromptTemplate('prompt-quick');
    expect(content).toContain('## 快速工具路由');
    expect(content).toContain('invoke_skill("scrolling_analysis", ...)');
    expect(content).toContain('enable_frame_details');
    expect(content).toContain('不要把 FrameTimeline 原始 SQL 作为滑动概览的第一步');
    expect(content).toContain('不是 `dur_ns`');
  });
});
