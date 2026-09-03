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
  MAX_PLAN_ARCHITECTURE_REQUIREMENT_TOKENS,
  splitMethodologyTemplate,
  stripTemplateComments,
  MAX_PROMPT_TOKENS,
  MAX_SCENE_CORE_TOKENS,
  type PromptSegment,
} from '../claudeSystemPrompt';
import {loadPromptTemplate} from '../strategyLoader';
import fs from 'fs';
import path from 'path';

function loadStrategy(scene: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'strategies', `${scene}.strategy.md`),
    'utf-8',
  );
}

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
  it('keeps full planning evidence-driven instead of phase-transition driven', () => {
    const methodology = loadPromptTemplate('prompt-methodology');

    expect(methodology).toContain('Plan 是精简的证据契约，不是工作流叙事');
    expect(methodology).toContain('默认只建 2–3 个证据阶段');
    expect(methodology).toContain('不要为条件分支或最终报告单独创建空阶段');
    expect(methodology).toContain('常规阶段切换由下一阶段首个证据调用自动启动');
    expect(methodology).toContain('最终报告不是 plan 阶段');
    expect(methodology).toContain('`aggregate.complete=true` 只证明该 artifact 内行已聚合完整');
    expect(methodology).toContain('不等于覆盖全部 eligible 总体');
    expect(methodology).toContain('外推前先看 `evidence_scope` / `claim_boundary`');
    expect(methodology).not.toContain('`aggregate.complete=true` 可作为全表分布证据');
    expect(methodology).toContain('`claim_boundary` 是结果生产者声明的结论上限');
    expect(methodology).toContain('候选证据只有被独立证据明确绑定后');
    expect(methodology).toContain('禁止 schema lookup + 探索 SQL 循环');
    expect(methodology).not.toContain('阶段切换必须 `update_plan_phase`');
    expect(methodology).not.toContain('summary 不是完整证据');
  });

  it('tells the model that frame_timeline_to_buffer_tx_ratio is not a bounded coverage', () => {
    // The ratio is frame_timeline_frames / buffer_tx_produced_frames, two
    // independent sources, so it can exceed 1. A real run reported
    // "coverage_ratio=1.0024" which reads as 100.24% coverage. >1 actually
    // means BufferTX undercounted; clamping would destroy that signal.
    const strategy = loadStrategy('scrolling');
    expect(strategy).toContain('不是有界覆盖率');
    expect(strategy).toContain('> 1 说明 BufferTX 少计');
  });

  it('keeps internal identifiers out of the readable conclusion prose', () => {
    // Measured on 13 real GLM conclusions: 103 `art-N` artifact ids, 7
    // `execute_sql:N` refs and 4 raw tool names leaked into the text the user
    // reads. Nothing binds claims to those strings — verification uses the
    // structured evidence refs — so in prose they are pure plumbing.
    const outputFormat = loadPromptTemplate('prompt-output-format');

    expect(outputFormat).toContain('内部 ID');
    expect(outputFormat).toContain('只写进结构化引用段');
    // The finding format must not invite an artifact citation in prose.
    expect(outputFormat).not.toContain('artifact/SQL/Skill 来源');
    // The structured section stays the place where ids belong.
    expect(outputFormat).toContain('逐句数据引用（结构化来源）');
  });

  it('keeps the real quick prompt artifact rules summary-first instead of rows-first', () => {
    const quick = loadPromptTemplate('prompt-quick');

    expect(quick).toContain('## Artifact 读取规则');
    expect(quick).toContain('fetch_artifact(artifactId="art-N", detail="summary")');
    expect(quick).toContain('只读取解决该缺口所需的最少 rows');
    expect(quick).toContain('不要机械分页');
    expect(quick).toContain('__intrinsic_artifact_rows');
    expect(quick).toContain('这些都不是 SQL 表');
    expect(quick).toContain('detail="rows"');
    expect(quick).not.toMatch(/page through large datasets/);
    expect(quick).not.toMatch(/All data is accessible/);
  });

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

  it('keeps conditional skips and TextureView claim boundaries authoritative in the scrolling prompt', () => {
    const prompt = buildSystemPromptParts(makeWorstCaseContext('scrolling')).fullPrompt;

    expect(prompt).not.toContain('必须完整执行所有阶段');
    expect(prompt).toContain('条件项只在用户问题、plan 或 trace 证据命中 trigger 时强制');
    expect(prompt).toContain('`consumer_notification` cadence gap 只是时序候选');
    expect(prompt).toContain('不得称为 hidden jank、producer stall 或根因');
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

describe('architecture-conditional plan requirements survive the prompt budget', () => {
  it('keeps the requirement section in the worst-case scrolling prompt', () => {
    // The whole point is to stop the first submit_plan from being rejected by
    // construction; a section the budget can drop would silently restore that.
    const parts = buildSystemPromptParts(makeWorstCaseContext('scrolling'));
    const segment = parts.segments.find(
      item => item.label === 'plan_architecture_requirements',
    );

    expect(segment).toBeDefined();
    expect(segment?.droppable).not.toBe(true);
    expect(segment?.truncatable).not.toBe(true);
    expect(parts.droppedLabels).not.toContain('plan_architecture_requirements');
    expect(parts.truncatedLabels).not.toContain('plan_architecture_requirements');
    expect(parts.fullPrompt).toContain('计划强制项（当前架构）');
    // The concrete skill the gate will demand must be named, not just described.
    expect(parts.fullPrompt).toContain('flutter_scrolling_analysis');
    expect(estimatePromptTokens(parts.fullPrompt)).toBeLessThanOrEqual(MAX_PROMPT_TOKENS);
  });

  it('stays inside a tight token budget so it cannot crowd out other context', () => {
    // The section is non-droppable by design, so its cost is paid on every
    // full-mode run of this scene. Keep it small enough that it does not
    // compete with the droppable context sections.
    const unbudgeted = buildSystemPromptParts(makeWorstCaseContext('scrolling'), 1_000_000);
    const section = unbudgeted.segments.find(
      item => item.label === 'plan_architecture_requirements',
    );

    expect(section?.estimatedTokens).toBeGreaterThan(0);
    expect(section?.estimatedTokens).toBeLessThanOrEqual(
      MAX_PLAN_ARCHITECTURE_REQUIREMENT_TOKENS,
    );
  });

  it('omits the section entirely when no conditional branch is active', () => {
    const context = makeWorstCaseContext('scrolling');
    const parts = buildSystemPromptParts({
      ...context,
      // Neither the query nor the architecture names a conditional branch.
      query: '分析这个应用滑动掉帧的根因，并给出优化建议',
      architecture: {
        type: 'STANDARD',
        confidence: 0.9,
        evidence: [],
      },
    });

    expect(parts.segments.find(
      item => item.label === 'plan_architecture_requirements',
    )).toBeUndefined();
    expect(parts.fullPrompt).not.toContain('计划强制项（当前架构）');
  });
});

describe('methodology split ignores placeholders inside comments', () => {
  it('splits at the body placeholder, not the one documenting it', () => {
    const template = [
      '<!-- Variable "sceneStrategy" {{sceneStrategy}} documented here -->',
      '## 分析方法论',
      '### Plan Gate',
      'rules before the scene core',
      '{{sceneStrategy}}',
      '### SQL Discipline',
    ].join('\n');

    const parts = splitMethodologyTemplate(template);
    expect(parts.beforeSceneStrategy).toContain('### Plan Gate');
    expect(parts.beforeSceneStrategy).toContain('## 分析方法论');
    expect(parts.afterSceneStrategy).toBe('### SQL Discipline');
    // The documenting comment stays on the "before" side, never split through.
    expect(parts.beforeSceneStrategy).toContain('documented here -->');
  });

  it('falls back when the only placeholder sits inside a comment', () => {
    const template = '<!-- {{sceneStrategy}} -->\n## 分析方法论\n### Plan Gate';
    const parts = splitMethodologyTemplate(template);
    expect(parts.afterSceneStrategy).toBe('');
    expect(parts.beforeSceneStrategy).toContain('### Plan Gate');
  });

  it('treats an unterminated comment as swallowing the rest of the template', () => {
    const template = '## 分析方法论\n<!-- oops\n{{sceneStrategy}}\n### SQL Discipline';
    const parts = splitMethodologyTemplate(template);
    expect(parts.afterSceneStrategy).toBe('');
  });

  it('keeps the existing fallback when no placeholder exists at all', () => {
    const parts = splitMethodologyTemplate('## 分析方法论\n### Plan Gate');
    expect(parts.beforeSceneStrategy).toBe('## 分析方法论\n### Plan Gate');
    expect(parts.afterSceneStrategy).toBe('');
  });

  it('delivers the real scene core outside any comment, after the methodology preamble', () => {
    const prompt = buildSystemPromptParts(makeWorstCaseContext('scrolling')).fullPrompt;
    const sceneCore = prompt.indexOf('#### Scrolling Core Strategy');

    expect(sceneCore).toBeGreaterThan(-1);
    expect(prompt.indexOf('## 分析方法论')).toBeLessThan(sceneCore);
    expect(prompt.indexOf('### Plan Gate')).toBeLessThan(sceneCore);
    // The old split left this documentation line loose in the body, after the
    // comment had already been closed by the injected scene core.
    expect(prompt).not.toContain('Always-injected scene core from');
    // Assembly strips developer comments outright, so the scene core can no
    // longer be swallowed by an unclosed one.
    expect(prompt).not.toMatch(/<!--/);
    expect(prompt).not.toMatch(/-->/);
  });
});

describe('developer comments never reach the model', () => {
  it('removes comment blocks without welding the surrounding lines together', () => {
    const stripped = stripTemplateComments([
      '<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->',
      '<!-- Copyright (C) 2024-2026 -->',
      '## 输出格式',
      '',
      '- rule one',
      '<!-- inline note -->',
      '- rule two',
    ].join('\n'));

    expect(stripped).toBe('## 输出格式\n\n- rule one\n\n- rule two');
    expect(stripped).not.toContain('SPDX');
  });

  it('leaves marker-bearing content to its own loader, which runs first', () => {
    // The source-use loader extracts <!-- tool-description:* --> before the
    // text becomes a segment, so stripping at assembly cannot break it.
    const toolDescription = loadPromptTemplate('prompt-source-use-decision-zh');
    expect(toolDescription).toContain('tool-description:start');
    expect(stripTemplateComments(toolDescription ?? '')).not.toContain('tool-description:start');
  });

  it('keeps the real worst-case prompt free of comment tokens', () => {
    for (const scene of ['startup', 'scrolling'] as const) {
      const prompt = buildSystemPromptParts(makeWorstCaseContext(scene)).fullPrompt;
      expect(prompt).not.toMatch(/<!--/);
    }
  });
});
