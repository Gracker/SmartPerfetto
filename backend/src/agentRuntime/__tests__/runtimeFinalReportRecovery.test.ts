// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import {
  findTruncationVerificationIssue,
  isTruncationVerificationIssue,
  recoverInterruptedFinalReport,
  repairTruncatedFinalReport,
} from '../runtimeFinalReportRecovery';
import { verifyHeuristic } from '../engines/claude/claudeVerifier';
import type { AnalysisPlanV3, Hypothesis, PlanPhase } from '../../agentv3/types';
import { assessFinalReportContractCompleteness } from '../../services/finalReportContractGate';

function makePlan(): AnalysisPlanV3 {
  const phases: PlanPhase[] = [
    {
      id: 'p1',
      name: '概览采集',
      goal: '获取帧统计',
      expectedTools: ['invoke_skill'],
      status: 'completed',
      summary: '347帧，7帧真实掉帧(2.02%)，最长帧62.73ms，证据来自 art-4 和 art-17。',
    },
    {
      id: 'p2',
      name: '根因深钻',
      goal: '执行 jank_frame_detail、frame_blocking_calls、blocking_chain_analysis',
      expectedTools: ['invoke_skill'],
      status: 'completed',
      summary: 'CustomScroll_longFrameLoad 在 animation 回调内同步执行 47-60ms；Binder/GC/锁/IO 无重叠证据。',
    },
    {
      id: 'p3',
      name: '综合结论',
      goal: '输出最终报告',
      expectedTools: [],
      status: 'completed',
      summary: '主要根因为 app 层同步长任务，次要根因为首帧 shader 编译。',
    },
  ];
  return {
    phases,
    successCriteria: '完整报告',
    submittedAt: Date.now(),
    toolCallLog: [],
  };
}

function makeHypotheses(): Hypothesis[] {
  return [
    {
      id: 'h1',
      statement: 'CustomScroll_longFrameLoad 同步执行导致 6 帧 workload_heavy 掉帧',
      status: 'confirmed',
      basis: 'frame_blocking_calls',
      evidence: 'animation 分别占用 59.31/58.84/56.28/57.77/58.04/47.91ms。',
      formedAt: Date.now(),
      resolvedAt: Date.now(),
    },
  ];
}

describe('runtime final report truncation recovery', () => {
  it('requires an existing streamed conclusion before interruption recovery', () => {
    expect(recoverInterruptedFinalReport({
      partialConclusion: '',
      plan: makePlan(),
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
    })).toBeUndefined();
  });

  it('repairs an evidence-backed streamed conclusion without replacing it with plan text', () => {
    const recovered = recoverInterruptedFinalReport({
      partialConclusion: '## 综合结论\n\n冷启动 TTID=1912ms，证据来自 art-1。\n\n未完成的建议',
      plan: makePlan(),
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
    });

    expect(recovered).toContain('冷启动 TTID=1912ms，证据来自 art-1');
    expect(recovered).toContain('未完成的建议');
    expect(recovered).toContain('## 截断恢复补充');
  });

  it('recognizes verifier truncation issues', () => {
    expect(isTruncationVerificationIssue({
      type: 'truncation',
      message: '结论文本被截断',
    })).toBe(true);
    expect(isTruncationVerificationIssue({
      type: 'missing_evidence',
      message: '缺少证据',
    })).toBe(false);
    expect(findTruncationVerificationIssue([
      { type: 'missing_evidence', message: '先报告的其他错误' },
      { type: 'truncation', message: '结论文本被截断' },
    ])).toMatchObject({ type: 'truncation' });
  });

  it('repairs only the incomplete final line while preserving the evidence-rich body', () => {
    const truncated = [
      '## 综合结论',
      '',
      '这份报告已经包含证据链，CustomScroll_longFrameLoad 耗时 59.31ms。',
      '',
      '## 优化建议',
      '',
      '- P0: 拆分 CustomScroll_longFrameLoad 内部添加 app-level trace section 做子步骤归因',
    ].join('\n');

    const repaired = repairTruncatedFinalReport({
      conclusion: truncated,
      plan: makePlan(),
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
      missingContractSections: [
        { id: 'peak_and_semantic_metrics', label: '峰值/口径指标' },
      ],
    });

    expect(repaired).toBeTruthy();
    expect(repaired).toContain('CustomScroll_longFrameLoad 耗时 59.31ms');
    expect(repaired).not.toContain('添加 app-level trace section 做子步骤归因');
    expect(repaired).toContain('## 截断恢复补充');
    expect(repaired).toContain('### 峰值/口径指标');
    expect(repaired).toContain('347帧，7帧真实掉帧(2.02%)，最长帧62.73ms');
    expect(repaired).toContain('## 置信度/限制');
    expect(repaired).toContain('confirmed: CustomScroll_longFrameLoad 同步执行导致 6 帧 workload_heavy 掉帧');

    const truncationIssues = verifyHeuristic([], repaired || '')
      .filter(issue => issue.type === 'truncation');
    expect(truncationIssues).toHaveLength(0);
  });

  it('renders recovered contract headings in the requested output language', () => {
    const repaired = repairTruncatedFinalReport({
      conclusion: '## Final Report\n\nEvidence-backed body.\n\nIncomplete closing sentence',
      plan: makePlan(),
      hypotheses: makeHypotheses(),
      outputLanguage: 'en',
      missingContractSections: [
        { id: 'peak_and_semantic_metrics', label: '峰值/口径指标' },
      ],
    });

    expect(repaired).toContain('### Peak And Semantic Metrics');
    expect(repaired).not.toContain('### 峰值/口径指标');
  });

  it('repairs a complete but structurally incomplete report without claiming truncation', () => {
    const completeBody = [
      '## 综合结论',
      '',
      '左侧启动耗时明显更高，已有双 Trace 证据支持。',
      '',
      '最后一行是完整的证据说明',
    ].join('\n');

    const repaired = repairTruncatedFinalReport({
      conclusion: completeBody,
      plan: makePlan(),
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
      recoveryKind: 'missing_contract',
      missingContractSections: [
        { id: 'phase_breakdown', label: '阶段耗时分解' },
      ],
    });

    expect(repaired).toContain('最后一行是完整的证据说明');
    expect(repaired).toContain('## 结构恢复补充');
    expect(repaired).not.toContain('截断恢复补充');
    expect(repaired).toContain('### 阶段耗时分解');
  });

  it('recovers scrolling metric semantics when the model uses near-synonym wording', () => {
    const scrollingPlan = makePlan();
    scrollingPlan.phases[0].summary =
      '347 帧中 7 帧用户可感知卡顿(2.02%)，最长单帧 62.73ms，最长连续丢 7 个 VSync。';
    const conclusion = [
      '## 综合结论',
      '',
      '### 概览',
      '',
      '共 347 帧，7 帧用户可感知卡顿，最长单帧 62.73ms，最长连续丢 7 个 VSync。',
      '',
      '### 全帧根因分布',
      '',
      '| reason_code | 帧数 | 占比 |',
      '|---|---:|---:|',
      '| workload_heavy | 6 | 85.7% |',
      '',
      '### 代表帧分析',
      '',
      'Frame 59665234 帧耗时 62.73ms，超预算 7.5x，丢失 7 VSync。',
    ].join('\n');
    const missing = assessFinalReportContractCompleteness({
      conclusion,
      query: '分析滑动性能',
      sceneType: 'scrolling',
    });

    expect(missing?.missingSections.map(section => section.id)).toEqual([
      'peak_and_semantic_metrics',
    ]);

    const repaired = repairTruncatedFinalReport({
      conclusion,
      plan: scrollingPlan,
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
      recoveryKind: 'missing_contract',
      missingContractSections: missing?.missingSections,
    });

    expect(repaired).toContain('### 峰值/口径指标');
    expect(assessFinalReportContractCompleteness({
      conclusion: repaired || '',
      query: '分析滑动性能',
      sceneType: 'scrolling',
    })).toBeUndefined();
  });

  it('uses the scene-owned contract description to recover grouped startup sections', () => {
    const startupPlan = makePlan();
    startupPlan.phases[0].summary = '已确认 cold start，TTID 1912.2ms，TTFD 在 trace 中不可用。';
    startupPlan.phases[1].summary = 'startup_detail 显示 bindApplication self_ms 568.8ms，SR12 为已验证根因。';
    const conclusion = [
      '## 综合结论',
      '',
      '冷启动 TTID 1912.2ms，startup_detail 显示 bindApplication self_ms 568.8ms，对应 SR12。',
    ].join('\n');
    const missing = assessFinalReportContractCompleteness({
      conclusion,
      query: '分析启动性能',
      sceneType: 'startup',
    });

    expect(missing?.missingSections.map(section => section.id)).toContain('audience_recommendations');
    const repaired = repairTruncatedFinalReport({
      conclusion,
      plan: startupPlan,
      hypotheses: makeHypotheses(),
      outputLanguage: 'zh-CN',
      recoveryKind: 'missing_contract',
      missingContractSections: missing?.missingSections,
    });

    expect(repaired).toContain('App 层：仅对已完成阶段证据直接指向的应用瓶颈实施优化');
    expect(repaired).toContain('系统/平台层：若已完成阶段没有平台归因证据');
    expect(assessFinalReportContractCompleteness({
      conclusion: repaired || '',
      query: '分析启动性能',
      sceneType: 'startup',
    })).toBeUndefined();
    expect(repaired).not.toContain('用户可见长帧');
    expect(repaired).not.toContain('刷新率预算');
  });
});
