// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { ArchitectureInfo } from '../../agent/detectors/types';
import type {
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  TraceCompleteness,
} from '../types';
import {
  buildSelectionContextSection,
  buildSystemPromptParts,
  estimatePromptTokens,
  MAX_PROMPT_TOKENS,
  MAX_SCENE_CORE_TOKENS,
  type PromptSegment,
} from '../claudeSystemPrompt';

const M2_TOKEN_GATES = {
  fullPromptTokens: MAX_PROMPT_TOKENS,
  sceneCoreTokens: MAX_SCENE_CORE_TOKENS,
};

function makeArchitecture(): ArchitectureInfo {
  return {
    type: 'FLUTTER',
    confidence: 0.94,
    evidence: [{ type: 'thread', value: '1.ui / 1.raster', weight: 0.9 }],
    flutter: {
      engine: 'IMPELLER',
      surfaceType: 'TEXTUREVIEW',
      versionHint: '3.29+',
      newThreadModel: true,
    },
    compose: {
      hasRecomposition: true,
      hasLazyLists: true,
      isHybridView: true,
      features: ['LazyColumn', 'AndroidView bridge'],
    },
    webview: {
      engine: 'CHROMIUM',
      surfaceType: 'TEXTUREVIEW',
      multiProcess: true,
    },
  };
}

describe('selection strategy evidence ownership', () => {
  it('requires backend evidence queries for selected-event descriptive facts', () => {
    const section = buildSelectionContextSection({
      kind: 'track_event',
      source: 'track_event_selection',
      trackUri: '/process_1/actual_frames',
      eventId: 42,
      ts: 1_500_000_000,
      dur: 16_000_000,
    });

    expect(section).toContain('/process_1/actual_frames');
    expect(section).toContain('先查询');
    expect(section).not.toContain('已由前端预查询');
    expect(section).not.toContain('前端预查询 Trace 数据');
  });

  it('does not instruct area analysis to reuse hidden frontend datasets', () => {
    const section = buildSelectionContextSection({
      kind: 'area',
      source: 'area_selection',
      startNs: 100,
      endNs: 200,
      durationNs: 100,
      tracks: [{uri: '/cpu_6', cpu: 6, kind: 'cpu_slice'}],
    });

    expect(section).toContain('cpu=6');
    expect(section).not.toContain('traceContext');
    expect(section).not.toContain('预取');
  });
});

function makeTraceCompleteness(): TraceCompleteness {
  return {
    available: [
      {
        id: 'frame_timeline',
        displayName: 'FrameTimeline',
        status: 'available',
        primaryTable: 'actual_frame_timeline_slice',
        rowEstimate: 240,
      },
      {
        id: 'startup',
        displayName: 'Android startup stdlib',
        status: 'available',
        primaryTable: 'android_startups',
        rowEstimate: 3,
      },
    ],
    missingConfig: [
      {
        id: 'gpu_work_period',
        displayName: 'GPU work period',
        status: 'missing_config_suspected',
        primaryTable: 'gpu_work_period',
        reason: 'GPU work period table is absent in this trace.',
      },
    ],
    notApplicable: [
      {
        id: 'power_rails',
        displayName: 'Power rails',
        status: 'not_applicable',
        primaryTable: 'counter',
        reason: 'Device did not expose rail counters.',
      },
    ],
    insufficient: [
      {
        id: 'thermal_throttling',
        displayName: 'Thermal throttling',
        status: 'insufficient_or_scene_absent',
        primaryTable: 'thermal_throttling',
        rowEstimate: 0,
        reason: 'Trace window is too short to establish thermal state.',
      },
    ],
    diagnosedAt: 1,
  };
}

function makePlan(index: number): AnalysisPlanV3 {
  return {
    phases: [
      {
        id: `p${index}-1`,
        name: '数据收集',
        goal: '获取场景概览、身份和关键指标',
        expectedTools: ['detect_architecture', 'invoke_skill', 'execute_sql', 'fetch_artifact'],
        expectedCalls: [{ tool: 'invoke_skill', skillId: index % 2 === 0 ? 'startup_analysis' : 'scrolling_analysis' }],
        status: 'completed',
        summary: '已获取概览指标与 artifact 摘要。',
      },
      {
        id: `p${index}-2`,
        name: '根因深钻',
        goal: '对 CRITICAL/HIGH 证据执行代表样本深钻',
        expectedTools: ['lookup_sql_schema', 'invoke_skill', 'execute_sql', 'fetch_artifact'],
        expectedCalls: [
          { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
          { tool: 'invoke_skill', skillId: 'blocking_chain_analysis' },
        ],
        status: index === 1 ? 'in_progress' : 'completed',
        summary: index === 1 ? undefined : '已完成阻塞链和代表帧深钻。',
      },
      {
        id: `p${index}-3`,
        name: '综合结论',
        goal: '汇总证据、边界和建议',
        expectedTools: [],
        status: 'pending',
      },
    ],
    successCriteria: '最终报告必须给出直接证据、根因归属、缺失证据边界和可执行建议。',
    submittedAt: index,
    toolCallLog: [],
  };
}

function makeWorstCaseContext(sceneType: 'startup' | 'scrolling'): ClaudeAnalysisContext {
  return {
    query: sceneType === 'startup'
      ? '分析这个应用启动慢的根因，并对比参考 trace，结合源码线索给出建议'
      : '分析这个 Flutter 滑动卡顿的根因，并对比参考 trace，结合源码线索给出建议',
    sceneType,
    architecture: makeArchitecture(),
    packageName: 'com.example.smartperfetto.demo',
    focusApps: [
      { packageName: 'com.example.smartperfetto.demo', totalDurationNs: 8_500_000_000, switchCount: 180 },
      { packageName: 'com.android.systemui', totalDurationNs: 1_100_000_000, switchCount: 12 },
    ],
    focusMethod: 'frame_timeline',
    traceCompleteness: makeTraceCompleteness(),
    selectionContext: {
      kind: 'area',
      source: 'visible_window',
      startNs: 1_000_000_000,
      endNs: 4_500_000_000,
      durationNs: 3_500_000_000,
      trackCount: 4,
      tracks: [
        { uri: 'track://main', upid: 100, utid: 101, kind: 'thread_slice' },
        { uri: 'track://rt', upid: 100, utid: 102, kind: 'thread_slice' },
        { uri: 'track://raster', upid: 100, utid: 103, kind: 'thread_slice' },
        { uri: 'track://cpu0', cpu: 0 },
      ],
    },
    comparison: {
      referenceTraceId: 'trace-reference-token-baseline',
      referencePackageName: 'com.example.smartperfetto.demo',
      referenceArchitecture: { type: 'STANDARD', confidence: 0.82, evidence: [] },
      commonCapabilities: ['frame_timeline', 'startup', 'cpu_scheduling', 'binder_ipc'],
      capabilityDiff: {
        currentOnly: ['flutter_frame_timeline', 'gpu_work_period'],
        referenceOnly: ['android_frame_stats'],
      },
      compareAnchor: {
        type: 'interaction_window',
        currentRange: { startNs: 1_000_000_000, endNs: 4_500_000_000 },
        referenceRange: { startNs: 900_000_000, endNs: 4_400_000_000 },
      },
    },
    codeAwareMode: 'metadata_only',
    codebaseIds: ['demo-app', 'android-framework'],
    planHistory: [makePlan(1), makePlan(2), makePlan(3)],
    previousPlan: makePlan(4),
    knowledgeBaseContext: [
      '- android_frames: frame timeline view for jank attribution',
      '- android_startups: startup event overview',
      '- thread_slice: joined slice/thread/process view',
      '- android_binder_txns: binder client/server breakdown',
    ].join('\n'),
    patternContext: '## 历史分析经验\n\n类似 trace 中 RenderThread 与 GPU completion 的重叠常解释 TextureView 卡顿。',
    negativePatternContext: '## 历史踩坑记录\n\n不要把 fetch_artifact 摘要当作完整逐行证据。',
    availableAgents: ['system-expert', 'frame-expert'],
  };
}

function segmentTokens(segments: PromptSegment[], label: string): number {
  return segments
    .filter(segment => segment.label === label)
    .reduce((sum, segment) => sum + segment.estimatedTokens, 0);
}

function buildTokenReport(sceneType: 'startup' | 'scrolling') {
  const parts = buildSystemPromptParts(makeWorstCaseContext(sceneType));
  const baseMethodologyTokens =
    segmentTokens(parts.segments, 'base_methodology')
    + segmentTokens(parts.segments, 'base_methodology_reference');

  return {
    sceneType,
    mode: 'M2_HARD_GATE',
    targets: M2_TOKEN_GATES,
    fullPromptTokens: estimatePromptTokens(parts.fullPrompt),
    stablePrefixTokens: estimatePromptTokens(parts.stablePrefix),
    volatileSuffixTokens: estimatePromptTokens(parts.volatileSuffix),
    methodology: {
      baseMethodologyTokens,
      sceneCoreTokens: segmentTokens(parts.segments, 'scene_strategy_core'),
      reportContractTokens: segmentTokens(parts.segments, 'report_contract'),
    },
    droppedLabels: parts.droppedLabels,
    truncatedLabels: parts.truncatedLabels,
    segments: parts.segments.map(segment => ({
      label: segment.label,
      tier: segment.tier,
      tokens: segment.estimatedTokens,
      chars: segment.charCount,
      droppable: segment.droppable,
      truncatable: segment.truncatable === true,
    })),
  };
}

describe('system prompt token regression with real strategy files', () => {
  it.each(['startup', 'scrolling'] as const)(
    'enforces M2 full-mode token hard gate for %s without mocking strategyLoader',
    sceneType => {
      const report = buildTokenReport(sceneType);
      const labels = report.segments.map(segment => segment.label);

      for (const label of ['role', 'output_language', 'output_format', 'base_methodology', 'scene_strategy_core', 'report_contract']) {
        expect(labels).toContain(label);
      }
      for (const droppedLabel of report.droppedLabels) {
        expect(['base_methodology', 'scene_strategy_core', 'report_contract']).not.toContain(droppedLabel);
      }
      expect(report.truncatedLabels).toEqual([]);
      expect(report.fullPromptTokens).toBeLessThanOrEqual(M2_TOKEN_GATES.fullPromptTokens);
      expect(report.methodology.sceneCoreTokens).toBeLessThanOrEqual(M2_TOKEN_GATES.sceneCoreTokens);
      expect(report.methodology.reportContractTokens).toBeGreaterThan(0);

      console.info(`[SystemPromptTokenGate] ${JSON.stringify(report)}`);
    },
  );

  it('injects only startup core while keeping detail out of the system prompt', () => {
    const parts = buildSystemPromptParts(makeWorstCaseContext('startup'));
    const sceneCore = parts.segments.find(segment => segment.label === 'scene_strategy_core');
    const reportContract = parts.segments.find(segment => segment.label === 'report_contract');

    expect(parts.truncatedLabels).toEqual([]);
    expect(sceneCore?.truncatable).toBe(true);
    expect(sceneCore?.estimatedTokens).toBeLessThanOrEqual(M2_TOKEN_GATES.sceneCoreTokens);
    expect(reportContract?.droppable).toBe(false);
    expect(reportContract?.truncatable).toBeFalsy();
    expect(parts.fullPrompt).toContain('Startup Core Strategy');
    expect(parts.fullPrompt).toContain('startup:overview_timing');
    expect(parts.fullPrompt).not.toContain('启动场景关键 Stdlib 表');
    expect(parts.fullPrompt).toContain('Final Report Contract');
    expect(parts.fullPrompt).toContain('启动类型与 TTID/TTFD');
  });

  it('renders the immutable hypothesis resolution contract into the real system prompt', () => {
    const prompt = buildSystemPromptParts(makeWorstCaseContext('scrolling')).fullPrompt;

    expect(prompt).toContain('原始且不可变的假设命题');
    expect(prompt).toContain('先 rejected 原命题，再 submit_hypothesis');
  });

  it('keeps report contract when scene core is forcibly truncated under an artificial budget', () => {
    const parts = buildSystemPromptParts(
      makeWorstCaseContext('startup'),
      9_000,
      { truncateSceneCore: true },
    );
    const sceneCore = parts.segments.find(segment => segment.label === 'scene_strategy_core');
    const reportContract = parts.segments.find(segment => segment.label === 'report_contract');

    expect(parts.truncatedLabels).toEqual(expect.arrayContaining(['scene_strategy_core']));
    expect(parts.truncatedLabels.every(label => (
      label === 'scene_strategy_core' || label === 'selection_context'
    ))).toBe(true);
    expect(estimatePromptTokens(parts.fullPrompt)).toBeLessThanOrEqual(9_000);
    expect(sceneCore?.truncated).toBe(true);
    expect(sceneCore?.originalEstimatedTokens).toBeGreaterThan(sceneCore?.estimatedTokens ?? 0);
    expect(reportContract?.droppable).toBe(false);
    expect(reportContract?.truncatable).toBeFalsy();
    expect(parts.fullPrompt).toContain('Final Report Contract');
    expect(parts.fullPrompt).toContain('启动类型与 TTID/TTFD');
  });

  it.each([
    ['zh-CN', '最终报告必须显式写出两侧完整包名'],
    ['en', 'The final report must explicitly state the full package name for both sides'],
  ] as const)('keeps the dual-trace identity delivery rule in the real %s prompt', (outputLanguage, rule) => {
    const context = makeWorstCaseContext('scrolling');
    context.outputLanguage = outputLanguage;
    context.comparison = {
      ...context.comparison!,
      referencePackageName: 'com.example.reference',
    };

    const prompt = buildSystemPromptParts(context).fullPrompt;

    expect(prompt).toContain('com.example.smartperfetto.demo');
    expect(prompt).toContain('com.example.reference');
    expect(prompt).toContain(rule);
  });
});
