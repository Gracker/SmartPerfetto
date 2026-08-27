// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import { createDataEnvelope } from '../../types/dataContract';
import { runClaimVerification } from '../verifier/claimVerificationRunner';
import {
  applyFinalResultQualityGate,
  completeFinalResultComparisonIdentity,
  assessFinalResultQuality,
  hasDeliverableFinalReportHeading,
  looksLikePhaseSummaryFallback,
} from '../finalResultQualityGate';

function result(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    sessionId: 'session-final-quality',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '启动类型为冷启动，TTID=1912ms，TTFD=2200ms。',
      '',
      '## 阶段耗时分解',
      '',
      '- startup_detail 显示 bindApplication self_ms=120ms。',
      '',
      '## 关键证据链',
      '',
      '- 根因编号 A5 对应 DEX/类加载开销。',
      '',
      '## 优化建议',
      '',
      '- [App层] 延后非首屏初始化。',
      '- [系统/平台层] 无需处理。',
    ].join('\n'),
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 1000,
    ...overrides,
  };
}

describe('final result quality gate', () => {
  it('recognizes deliverable report headings without Chinese word-boundary false negatives', () => {
    expect(hasDeliverableFinalReportHeading('# 启动性能分析报告\n\n## 综合结论')).toBe(true);
    expect(hasDeliverableFinalReportHeading('## 综合结论\n\n冷启动 TTID=1912ms。')).toBe(true);
    expect(hasDeliverableFinalReportHeading('### Phase 1 关键发现记录\n\nTTID=1912ms。')).toBe(false);
  });

  it('detects phase-summary fallback text as non-final output', () => {
    const fallback = [
      '## 综合结论',
      '',
      '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重。',
      '',
      '## 分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
      '- 启动详情分析: 四象限：Q1=62.8%, Q4b=35.1%。',
      '- 综合结论: 完成综合结论输出。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(fallback)).toBe(true);
    expect(assessFinalResultQuality({
      result: result({ conclusion: fallback }),
      query: '分析这个启动 trace',
    })?.code).toBe('plan_summary_fallback');

    expect(looksLikePhaseSummaryFallback([
      '## 综合结论',
      '',
      '主要瓶颈来自 ChaosTask，证据 art-30。',
      '',
      '## 分阶段证据摘要',
      '',
      '- p1: 获取启动概览，证据 art-2。',
      '- p2: 输出结论，证据 data:sql_table:current:abc。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论',
      '',
      '完成综合结论输出。',
      '',
      '分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览。',
      '- 综合结论: 完成综合结论输出。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论：',
      '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重(A16)。',
      '',
      '分阶段证据摘要：',
      '启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
      '启动类型验证: 确认为冷启动。',
      '启动详情分析: 四象限：Q1=62.8%,Q4b=35.1%。',
      '综合结论: 完成综合结论输出。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '## Final Conclusion',
      '',
      'Completed final conclusion output.',
      '',
      '## Evidence Summary By Phase',
      '',
      '- Overview collection: TTID=1912ms.',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '## 综合结论',
      '',
      '完成综合结论输出。',
      '',
      '## 分阶段证据摘要',
      '',
      '- 启动概览采集: 获取启动概览。',
      '',
      '## 根因拆解',
      '',
      '主要来自启动阶段。',
      '',
      '## 优化建议',
      '',
      '建议优化启动任务。',
    ].join('\n'))).toBe(true);

    expect(looksLikePhaseSummaryFallback([
      '综合结论：完成综合结论输出。冷启动TTID=1912ms。',
      '分阶段证据摘要：启动概览采集: 获取启动概览：冷启动dur=1338ms。',
      '1. 启动详情分析: 四象限 Q1=62.8%。',
    ].join('\n'))).toBe(true);
  });

  it('does not flag a rich report that contains independent evidence sections', () => {
    const report = [
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '启动类型为冷启动，TTID=1912ms，TTFD=2200ms，主因是主线程模拟负载。ChaosTask self=456ms，LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 阶段耗时分解',
      '',
      '- 启动概览采集: 获取启动概览，TTID=1912ms。',
      '- startup_detail 启动详情分析: 四象限 Q1=62.8%、Q4b=35.1%，关键 self_ms=456ms。',
      '',
      '## 关键证据链',
      '',
      '- 根因编号 A5：主线程类加载/模拟负载开销。',
      '- startup_detail 对应证据 ID art-10。',
      '- hot_slice_states 对应 data:sql_table:current:abc。',
      '',
      '## 优化建议',
      '',
      '- [App层] 降低启动期主线程模拟负载。',
      '- [系统/平台层] 当前无系统侧阻塞证据。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(report)).toBe(false);
    expect(assessFinalResultQuality({
      result: result({ conclusion: report }),
      query: '分析这个启动 trace',
    })).toBeUndefined();

    const plainReport = [
      '综合结论：',
      '启动类型为冷启动，TTID=1912ms，TTFD=2200ms，主因是主线程模拟负载。',
      '',
      '阶段耗时分解：',
      'startup_detail 启动概览采集: 获取启动概览，TTID=1912ms，self_ms=456ms。',
      '',
      '关键证据链：',
      '根因编号 A5：主线程类加载/模拟负载开销。',
      'startup_detail 对应证据 ID art-10。',
      'hot_slice_states 对应 data:sql_table:current:abc。',
      '',
      '优化建议：',
      '[App层] 降低启动期主线程模拟负载。',
      '[系统/平台层] 当前无系统侧阻塞证据。',
    ].join('\n');

    expect(looksLikePhaseSummaryFallback(plainReport)).toBe(false);
    expect(assessFinalResultQuality({
      result: result({ conclusion: plainReport }),
      query: '分析这个启动 trace',
    })).toBeUndefined();
  });

  it('accepts startup reports that express phase timing as a root-cause tree and use spaced audience labels', () => {
    const report = [
      '## 综合结论',
      '',
      '启动类型为冷启动，dur=1338ms，TTID=1912ms，TTFD 不可用。',
      '',
      '### 根因分析树',
      '',
      '启动 1338ms (TTID=1912ms)',
      '├── [Phase 1] bindApplication = 576ms wall (self_ms=1.5ms)',
      '│   └── LoadSimulator_AppInit = 478ms wall (self_ms=207ms) ← A11',
      '├── [Phase 2] activityStart = 832ms wall (self_ms=5ms)',
      '│   └── SimulateInflation = 179ms (self_ms=175ms) ← A4',
      '└── [首帧后] MQ_Chain 阻塞器 = 573ms ← A17',
      '',
      '### 关键证据链',
      '',
      '- 根因编号 A11/A16/A4/A17 均有 data:skill:startup_detail:hot_slice_states 佐证。',
      '',
      '### 优化建议',
      '',
      '**[App 层]**',
      '',
      '- 延后 LoadSimulator 初始化。',
      '',
      '**[系统/平台层]**',
      '',
      '- 当前无系统侧阻塞证据。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: report }),
      query: '分析启动性能',
    })).toBeUndefined();
  });

  it('marks empty successful results as partial instead of normal completion', () => {
    const target = result({
      conclusion: '   ',
      confidence: 0.91,
    });

    const issue = applyFinalResultQualityGate({
      result: target,
      query: '分析这个 trace',
    });

    expect(issue?.code).toBe('empty_conclusion');
    expect(target.partial).toBe(true);
    expect(target.confidence).toBe(0.55);
    expect(target.terminationReason).toBe('plan_incomplete');
    expect(target.terminationMessage).toContain('最终结果质量闸门');
  });

  it('appends the same quality issue only once across repeated projections', () => {
    const target = result({
      conclusion: 'epoll_wait 证明磁盘 IO 是根因。',
      partial: true,
      terminationMessage: 'runtime already degraded this result',
    });

    const issues = Array.from({length: 3}, () => applyFinalResultQualityGate({
      result: target,
      query: '分析 IO 根因',
    }));

    expect(issues.every(issue => issue?.code === 'kernel_blocking_claim_boundary')).toBe(true);
    expect(target.terminationMessage).toContain('runtime already degraded this result');
    const issueMessage = issues[0]!.message;
    expect(target.terminationMessage!.split(issueMessage)).toHaveLength(2);
  });

  it('flags process narration that leaked into the final conclusion', () => {
    const leaked = [
      '1. **冷启动**，dur=1338.65ms，原分类warm已被重分类为cold（R009）',
      '2. **TTID=1912.20ms > dur=1338.65ms**，差距573.55ms（R008触发）',
      '',
      '现在完成Phase 1，进入Phase 1.5验证启动类型，然后进入Phase 2深钻。',
      'Phase 2 已获取关键概要数据。现在进入 Phase 2.5。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: leaked }),
      query: '分析启动性能',
    })?.code).toBe('process_narration_conclusion');
  });

  it('flags structured interim markdown that has no deliverable final-report heading', () => {
    const interim = [
      '### Phase 1 关键发现记录',
      '',
      '- 冷启动 dur=1338ms，TTID=1912ms。',
      '- 主线程 Running=63%。',
      '',
      '### Phase 2 待验证项',
      '',
      '- 继续检查内存压力、Binder 和 CPU 频率。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: interim }),
      query: '分析启动性能',
    })?.code).toBe('missing_final_report_heading');
  });

  it('does not require a deliverable final-report heading for quick-run answers', () => {
    const quickRun: NonNullable<AnalysisResult['quickRun']> = {
      requestedMode: 'fast',
      resolvedMode: 'quick',
      profile: 'normal',
      targetTurns: 5,
      hardCapTurns: 50,
      actualTurns: 0,
      elapsedMs: 1200,
      enforcement: 'turn_cap',
      stopReason: 'answered',
      evidence: {
        frontendPrequeryInjected: 1,
        frontendPrequeryCited: 1,
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
      contextInjected: {
        conversationTurns: 1,
        recentSqlResults: 0,
        sqlPitfallPairs: 0,
        patternHints: 0,
        negativePatternHints: 0,
        caseBackgroundCases: 0,
      },
      verifierStatus: 'passed',
    };
    const quickAnswer = [
      '## 快速回答',
      '',
      '- 总体 janky frame 数：21',
      '- drop rate：0.00%',
      '',
      '证据：data:frontend_prequery:current:abc123',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: quickAnswer,
        quickRun,
      }),
      query: '基于上一轮结果，只说总体 janky frame 数和 drop rate',
    })).toBeUndefined();
  });

  it('does not treat quick fact boundary disclaimers as full-report language', () => {
    const quickRun: NonNullable<AnalysisResult['quickRun']> = {
      requestedMode: 'auto',
      resolvedMode: 'quick',
      profile: 'normal',
      targetTurns: 5,
      hardCapTurns: 50,
      actualTurns: 0,
      elapsedMs: 64,
      enforcement: 'turn_cap',
      stopReason: 'answered',
      evidence: {
        frontendPrequeryInjected: 0,
        frontendPrequeryCited: 0,
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
      contextInjected: {
        conversationTurns: 0,
        recentSqlResults: 0,
        sqlPitfallPairs: 0,
        patternHints: 0,
        negativePatternHints: 0,
        caseBackgroundCases: 0,
      },
      verifierStatus: 'passed',
    };

    const quickFactAnswer = [
      '当前 trace 的常用数据清单包括：trace_bounds 录制时长 7.815673 秒；slice/track 时间线（slice=101278, track=771）；FrameTimeline（actual=697, expected=697）。这是基于常用 Perfetto 表/模块计数的快速清单，不等同于完整数据源枚举或问题诊断。',
      '',
      '## 逐句数据引用（结构化来源）',
      '- evidence_ref_id=`data:runtime_trace_fact:trace_data_inventory:current:abc123`',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: quickFactAnswer,
        quickRun,
      }),
      query: '这个 trace 采集了哪些数据？',
    })).toBeUndefined();
  });

  it('marks quick answers with failed claim verification as partial', () => {
    const quickRun: NonNullable<AnalysisResult['quickRun']> = {
      requestedMode: 'fast',
      resolvedMode: 'quick',
      profile: 'normal',
      targetTurns: 5,
      hardCapTurns: 50,
      actualTurns: 4,
      elapsedMs: 9000,
      enforcement: 'turn_cap',
      stopReason: 'answered',
      evidence: {
        frontendPrequeryInjected: 0,
        frontendPrequeryCited: 0,
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
      contextInjected: {
        conversationTurns: 0,
        recentSqlResults: 0,
        sqlPitfallPairs: 0,
        patternHints: 0,
        negativePatternHints: 0,
        caseBackgroundCases: 0,
      },
      verifierStatus: 'failed',
    };
    const target = result({
      quickRun,
      conclusion: '滑动总帧数 **347**，janky frame 数 **0**。证据：data:sql_summary:current:abc',
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'failed',
        policy: 'record_only',
        passed: false,
        checkedClaimCount: 1,
        unsupportedClaimCount: 1,
        claimResults: [{ claimId: 'claim-frames', status: 'unsupported' }],
        issues: [{
          claimId: 'claim-frames',
          severity: 'error',
          code: 'unsupported_claim',
          message: 'No evidence matched this claim',
        }],
      },
    });

    const issue = applyFinalResultQualityGate({
      result: target,
      query: '这条 trace 的滑动总帧数和 janky frame 数是多少？',
    });

    expect(issue?.code).toBe('quick_verifier_failed');
    expect(target.partial).toBe(true);
    expect(target.terminationMessage).toContain('未通过证据核对');
  });

  it('marks over-expanded quick triage reports as partial', () => {
    const quickRun: NonNullable<AnalysisResult['quickRun']> = {
      requestedMode: 'fast',
      resolvedMode: 'quick',
      profile: 'triage',
      targetTurns: 5,
      hardCapTurns: 50,
      actualTurns: 7,
      elapsedMs: 28_000,
      enforcement: 'turn_cap',
      stopReason: 'extended_answered',
      evidence: {
        frontendPrequeryInjected: 0,
        frontendPrequeryCited: 0,
        currentRunDataEnvelopes: 13,
        citedEvidenceRefs: 5,
      },
      contextInjected: {
        conversationTurns: 0,
        recentSqlResults: 0,
        sqlPitfallPairs: 0,
        patternHints: 0,
        negativePatternHints: 0,
        caseBackgroundCases: 0,
      },
      verifierStatus: 'passed',
    };
    const target = result({
      quickRun,
      conclusion: [
        '# 滑动卡顿完整诊断报告',
        '',
        '## 一、全景概览',
        '',
        '总帧数 347，掉帧 7。',
        '',
        '## 二、根因分析',
        '',
        '主因 A。',
        '',
        '## 三、代码责任链',
        '',
        '责任链 B。',
        '',
        '## 四、优化建议',
        '',
        '建议 C。',
      ].join('\n'),
    });

    const issue = applyFinalResultQualityGate({
      result: target,
      query: '请完整诊断这次滑动卡顿的根因、优化方案和代码责任链',
    });

    expect(issue?.code).toBe('quick_full_report_shape');
    expect(target.partial).toBe(true);
    expect(target.terminationMessage).toContain('快速模式');
  });

  it('flags sparse unverified analysis conclusions and keeps concise factual answers alone', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [{
            conclusionId: 'claim-strict-evidence-chain',
            text: '模型声称存在关系证据',
          }],
          claims: [{
            id: 'claim-strict-evidence-chain',
            kind: 'causal',
            text: '主线程模拟负载导致 TTID 变慢',
            references: [],
            relationRefs: ['missing-relation'],
          }],
          uncertainties: [],
          nextSteps: [],
        },
        claimSupport: [{
          claimId: 'claim-strict-evidence-chain',
          kind: 'causal',
          text: '主线程模拟负载导致 TTID 变慢',
          anchors: [],
          relations: [],
          relationEvaluation: 'missing',
          supportLevel: 'inference',
        } as any],
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claims: [{
            id: 'claim-invented-relation',
            kind: 'causal',
            text: '主线程模拟负载导致 TTID 变慢',
            references: [],
            relationRefs: ['model-invented-relation'],
          }],
          uncertainties: [],
          nextSteps: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claims: [{
            id: 'claim-strict-direct-ref',
            kind: 'causal',
            text: '主线程模拟负载导致 TTID 变慢',
            references: [{evidenceRefId: 'data:direct', column: 'ttid_ms', value: 1912}],
            relationRefs: ['missing-relation'],
          }],
          uncertainties: [],
          nextSteps: [],
        },
        claimSupport: [{
          claimId: 'claim-strict-direct-ref',
          kind: 'causal',
          text: '主线程模拟负载导致 TTID 变慢',
          anchors: [],
          relations: [],
          relationEvaluation: 'rejected',
          supportLevel: 'unsupported',
        } as any],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{claimId: 'claim-strict-direct-ref', status: 'verified'}],
          issues: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        claimSupport: [{
          claimId: 'claim-strict-causal',
          kind: 'causal',
          text: '主线程模拟负载导致 TTID 变慢',
          anchors: [],
          relations: [],
          relationEvaluation: 'missing',
          supportLevel: 'inference',
        } as any],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'partial',
          policy: 'record_only',
          passed: false,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{claimId: 'claim-strict-causal', status: 'inference'}],
          issues: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'failed',
          policy: 'block',
          passed: false,
          checkedClaimCount: 1,
          unsupportedClaimCount: 1,
          claimResults: [{ claimId: 'claim-ttid', status: 'unsupported' }],
          issues: [{
            claimId: 'claim-ttid',
            severity: 'error',
            code: 'unsupported_claim',
            message: 'No evidence matched this claim',
          }],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: '应用包名是 com.example.demo。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '这个 trace 的应用包名是什么？',
    })).toBeUndefined();

    expect(assessFinalResultQuality({
      result: result({
        conclusion: '最慢函数是 ChaosTask，self_ms=456ms。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '哪个函数最慢？',
    })).toBeUndefined();

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [{
            conclusionId: 'c1',
            text: 'startup_detail 显示 TTID=1912ms',
          }],
          claims: [{
            id: 'claim-ttid',
            text: 'TTID=1912ms',
            references: [{
              evidenceRefId: 'art-10',
              column: 'ttid_ms',
              value: 1912,
            }],
          }],
          uncertainties: [],
          nextSteps: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('scene_contract_incomplete');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'focused_answer',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          claims: [{
            id: 'claim-empty',
            text: 'TTID=1912ms',
            references: [],
          }],
          uncertainties: [],
          nextSteps: [],
        },
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');
  });

  it('does not count a deterministically verified overlap as causal evidence', () => {
    const conclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-overlap-is-cause',
        kind: 'causal',
        text: 'overlap causes the startup delay',
        references: [{
          evidenceRefId: 'data:overlap-only',
          rowIndex: 0,
          column: 'blocked_ms',
          value: 120,
        }],
        relationRefs: ['relation:overlap-only'],
      }],
      uncertainties: [],
      nextSteps: [],
    } as any;
    const envelope = createDataEnvelope({
      columns: ['ts', 'dur', 'blocked_ms'],
      rows: [[100, 50, 120], [125, 20, 0]],
    }, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'Overlap-only evidence',
      evidenceRefId: 'data:overlap-only',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const verified = runClaimVerification({
      conclusionContract,
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:overlap-only',
        kind: 'overlap',
        direction: 'symmetric',
        subject: {evidenceRefId: 'data:overlap-only', rowIndex: 0},
        object: {evidenceRefId: 'data:overlap-only', rowIndex: 1},
      }],
    });

    expect(verified.evidenceContract.relations[0].verificationStatus).toBe('verified');
    expect(verified.claimSupport[0].relationEvaluation).toBe('candidate');
    expect(verified.claimVerificationResult.claimResults[0].status).toBe('inference');
    expect(assessFinalResultQuality({
      result: result({
        conclusion: 'Main-thread work overlaps the slow startup window.',
        findings: [],
        conclusionContract,
        claimSupport: verified.claimSupport,
        claimVerificationResult: verified.claimVerificationResult,
      }),
      query: '分析这个启动 trace',
    })?.code).toBe('sparse_unverified_conclusion');
  });

  it('flags jank reports that pass evidence checks but omit scene-required sections', () => {
    const shortJankReport = [
      '## 综合结论',
      '',
      'com.example.demo 滑动性能一般：347帧中7帧真实掉帧（2.02%），最长帧62.73ms。',
      '',
      '### 根因拆解',
      '',
      '**[CRITICAL] animation 回调同步执行 CustomScroll_longFrameLoad（6帧，85.7%）**',
      '- 每次57-59ms纯CPU操作，CPU效率98.4%，无IO/锁/Binder参与。',
      '',
      '### 优化建议',
      '',
      '- 将 CustomScroll_longFrameLoad 异步化或分帧执行。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: shortJankReport,
        findings: [{
          severity: 'critical',
          title: 'animation 回调同步执行长任务',
          description: 'CustomScroll_longFrameLoad 造成掉帧',
          evidence: ['CPU效率98.4%'],
        } as any],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 3,
          unsupportedClaimCount: 0,
          claimResults: [{ claimId: 'claim-jank', status: 'verified' }],
          issues: [],
        },
      }),
      query: '分析滑动性能',
    })?.code).toBe('scene_contract_incomplete');
  });

  it('does not apply scene final-report contracts to factual scrolling questions', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: '应用包名是 com.example.demo。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '这个滑动 trace 的应用包名是什么？',
      sceneType: 'scrolling',
    })).toBeUndefined();
  });

  it('does not accept empty mentions as satisfying scene-required sections', () => {
    const hollowReport = [
      '## 综合结论',
      '',
      'com.example.demo 滑动性能一般：347帧中7帧真实掉帧，最长帧62.73ms。',
      '',
      '## 根因拆解',
      '',
      '- 已知需要补充全帧根因分布和代表帧分析，但当前结论没有展开。',
      '',
      '## 关键证据链',
      '',
      '- process_slice_cpu_hotspots 显示 CPU效率98.4%。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: hollowReport,
        findings: [{ severity: 'critical', title: '长任务', description: 'CPU heavy', evidence: ['98.4%'] } as any],
      }),
      query: '分析滑动性能',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('全帧根因分布');
    expect(issue?.message).toContain('代表帧分析');
  });

  it('uses conclusion contract scene metadata when the query is generic', () => {
    const issue = assessFinalResultQuality({
      result: result({
        conclusion: [
          '## 综合结论',
          '',
          '347帧中7帧真实掉帧，最长帧62.73ms，主因是 CustomScroll_longFrameLoad。',
          '',
          '## 根因拆解',
          '',
          '- CPU效率98.4%。',
        ].join('\n'),
        findings: [{ severity: 'critical', title: '长任务', description: 'CPU heavy', evidence: ['98.4%'] } as any],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          uncertainties: [],
          nextSteps: [],
          metadata: { sceneId: 'jank' },
        },
      }),
      query: '分析这个 trace',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
  });

  it('accepts jank reports that keep root-cause distribution and representative-frame sections', () => {
    const richJankReport = [
      '## 综合结论',
      '',
      'com.example.demo 滑动性能一般：347帧中7帧真实掉帧（2.02%），最长帧62.73ms，最长连续丢帧 vsync_missed=7。',
      '',
      '## 全帧根因分布',
      '',
      '| 根因 | 帧数 | 占比 | 四象限/频率特征 |',
      '| --- | ---: | ---: | --- |',
      '| workload_heavy | 6 | 85.7% | MainThread Running，CPU效率98.4% |',
      '| freq_ramp_slow | 1 | 14.3% | 960MHz -> 2400MHz |',
      '',
      '## 代表帧分析',
      '',
      '- 代表帧 frame_id=59665234：帧耗时62.73ms，超预算7.5x，vsync_missed=7，关键slice为 CustomScroll_longFrameLoad。',
      '- 代表帧 frame_id=59665037：帧耗时18.66ms，频率爬升慢。',
      '',
      '## 关键证据链',
      '',
      '- process_slice_cpu_hotspots 显示 CustomScroll_longFrameLoad count=6，avg_cpu_ms=55.10。',
      '',
      '## 优化建议',
      '',
      '- 将主线程 animation 回调里的长任务异步化或分帧。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richJankReport }),
      query: '分析滑动性能',
    })).toBeUndefined();
  });

  it('accepts localized representative-frame wording from OpenAI-compatible runtimes', () => {
    const localizedJankReport = [
      '## 综合结论',
      '',
      'com.example.demo 滑动性能一般：347 帧中 7 帧真实掉帧，最长帧 62.73ms。',
      '',
      '## 峰值与口径指标',
      '',
      '| 指标 | 数值 |',
      '| --- | --- |',
      '| 真实掉帧 / Buffer Stuffing 假阳性 | 7 / 14 |',
      '| 最长帧 | 62.73ms（frame_id=59665234，7.5× 预算） |',
      '',
      '## 全帧根因分布',
      '',
      '| 纠正后根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| ANIMATION 回调同步重计算 | 6 | 85.7% |',
      '| Shader Pipeline 编译 | 1 | 14.3% |',
      '',
      '## 代表帧分析',
      '',
      '### 帧 59665234（最严重）',
      '',
      '| 维度 | 详情 |',
      '| --- | --- |',
      '| 耗时 / 预算 | 62.73ms / 8.33ms（7.5×） |',
      '| VSync 丢失 | 7 |',
      '| 主线程 | animation 59.31ms -> CustomScroll_longFrameLoad 59.01ms |',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: localizedJankReport }),
      query: '分析滑动性能',
    })).toBeUndefined();
  });

  it('accepts reports that exclude epoll and prove separate app file IO', () => {
    const report = [
      '# ANR 根因分析报告',
      '',
      '## 综合结论',
      '',
      'do_epoll_wait 只是等待事件，本次不作为 IO 根因。',
      '独立的 SQLite file I/O slice 持续 200ms，Trace 证据 art-io-1 支持磁盘 IO 是本次阻塞根因。',
      '',
      '## 关键证据链',
      '',
      '- SQLite file I/O slice=200ms，主线程随后触发 ANR。',
      '',
      '## 优化建议',
      '',
      '- 将数据库写入移出主线程，并验证 art-io-1 对应区间。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: report,
        findings: [{
          severity: 'warning',
          title: 'SQLite main-thread IO',
          description: 'SQLite file I/O slice lasted 200ms',
          evidence: ['art-io-1'],
        } as any],
      }),
      query: '分析 ANR 根因',
      sceneType: 'anr',
    })).toBeUndefined();
  });

  it('flags pipeline reports that omit rendering-stage and BufferQueue/Fence boundaries', () => {
    const hollowPipelineReport = [
      '# 渲染管线分析报告',
      '',
      '## 阶段边界',
      '',
      '- 需要补充每个阶段的证据。',
      '',
      '## 同步边界',
      '',
      '- 需要补充同步证据。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: hollowPipelineReport,
        findings: [{ severity: 'warning', title: '管线边界缺失', description: 'no details', evidence: ['BufferQueue'] } as any],
      }),
      query: '分析渲染管线 BufferQueue fence',
      sceneType: 'pipeline',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('渲染/显示阶段拆分');
    expect(issue?.message).toContain('BufferQueue/Fence 边界');
  });

  it('does not require BufferQueue/Fence sections for generic pipeline-identification reports', () => {
    const genericPipelineReport = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 6.1ms | 主线程阶段正常 |',
      '| RenderThread | DrawFrame 4.3ms | RT 阶段正常 |',
      '| BufferQueue | queueBuffer 1.2ms | producer 提交阶段正常 |',
      '| SurfaceFlinger/SF | commit/composite 3.2ms | SF 合成阶段正常 |',
      '| HWC/display | VSync=16.67ms | display 阶段正常 |',
      '',
      '## 管线类型结论',
      '',
      '- 当前 trace 可按 Main/UI -> RenderThread -> BufferQueue -> SurfaceFlinger -> HWC/display 拆分。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: genericPipelineReport }),
      query: '分析渲染管线类型',
      sceneType: 'pipeline',
    })).toBeUndefined();
  });

  it('routes pure graphics-memory pipeline gaps to the graphics boundary instead of BufferQueue/Fence', () => {
    const graphicsReportWithoutBoundary = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 6.1ms | 主线程阶段正常 |',
      '| RenderThread | DrawFrame 4.3ms | RT 阶段正常 |',
      '| SurfaceFlinger/SF | commit/composite 3.2ms | SF 合成阶段正常 |',
      '| HWC/display | presentDisplay 5.1ms | display 阶段正常 |',
      '',
      '## 图形资源观察',
      '',
      '- GraphicBuffer 数量偏多，需要进一步确认。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({ conclusion: graphicsReportWithoutBoundary }),
      query: 'GraphicBuffer dma-buf 图形内存证据怎么分析',
      sceneType: 'pipeline',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('图形内存/刷新策略边界');
    expect(issue?.message).not.toContain('BufferQueue/Fence 边界');
  });

  it('flags HWC/SF overlay pipeline reports that omit the conditional boundary', () => {
    const reportWithoutPolicyBoundary = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 6.1ms | 主线程阶段正常 |',
      '| RenderThread | DrawFrame 4.3ms | RT 阶段正常 |',
      '| BufferQueue | queueBuffer 1.2ms | producer 提交阶段正常 |',
      '| SurfaceFlinger/SF | commit/composite 3.2ms | SF 合成阶段正常 |',
      '| HWC/display | HWC overlay 命中，presentDisplay 5.1ms | display 阶段正常 |',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({ conclusion: reportWithoutPolicyBoundary }),
      query: 'HWC overlay 怎么分析',
      sceneType: 'pipeline',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('图形内存/刷新策略边界');
    expect(issue?.message).not.toContain('BufferQueue/Fence 边界');
  });

  it('accepts graphics-memory pipeline reports without a BufferQueue/Fence section when no fence evidence is requested', () => {
    const graphicsOnlyReport = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 6.1ms | 主线程阶段正常 |',
      '| RenderThread | DrawFrame 4.3ms | RT 阶段正常 |',
      '| SurfaceFlinger/SF | commit/composite 3.2ms | SF 合成阶段正常 |',
      '| HWC/display | presentDisplay 5.1ms | display 阶段正常 |',
      '',
      '## 图形内存/刷新策略边界',
      '',
      '- GraphicBuffer/dma-buf 是图形物理内存证据，不能仅凭渲染 slice 判断。',
      '- SurfaceFlinger dumpsys 缺失，当前只能标注 evidence missing；confidence 为中等。',
      '- 本结论只覆盖 graphics memory 边界，不声明同步等待。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: graphicsOnlyReport }),
      query: 'GraphicBuffer dma-buf 图形内存证据怎么分析',
      sceneType: 'pipeline',
    })).toBeUndefined();
  });

  it('accepts HWC/SF policy pipeline reports that satisfy the conditional boundary', () => {
    const hwcPolicyReport = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 6.1ms | 主线程阶段正常 |',
      '| RenderThread | DrawFrame 4.3ms | RT 阶段正常 |',
      '| BufferQueue | queueBuffer 1.2ms | producer 提交阶段正常 |',
      '| SurfaceFlinger/SF | commit/composite 3.2ms | SF 合成阶段正常 |',
      '| HWC/display | HWC overlay policy 命中，presentDisplay 5.1ms | display 阶段正常 |',
      '',
      '## 图形内存/刷新策略边界',
      '',
      '- HWC overlay policy 属于 SurfaceFlinger/HWC 合成策略边界，不能等同 BufferQueue 或上屏完成。',
      '- 缺失 dumpsys SurfaceFlinger layer policy 时只能标注 evidence missing；confidence 为中等。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: hwcPolicyReport }),
      query: 'SurfaceFlinger HWC overlay policy 怎么分析',
      sceneType: 'pipeline',
    })).toBeUndefined();
  });

  it('accepts pipeline reports that split rendering stages and fence semantics', () => {
    const richPipelineReport = [
      '# 渲染管线分析报告',
      '',
      '## 渲染/显示阶段拆分',
      '',
      '| 阶段 | 证据 | 结论 |',
      '| --- | --- | --- |',
      '| Main/UI | Choreographer#doFrame 8.1ms | 主线程未超预算 |',
      '| RenderThread | DrawFrame 5.4ms | RT 正常提交 |',
      '| BufferQueue | queueBuffer 快、dequeueBuffer P95=9.2ms | producer 提交不慢，但复用 buffer 存在等待 |',
      '| SurfaceFlinger/SF | commit/composite 4.8ms，FrameTimeline present late 3帧 | SF 合成有轻微延迟 |',
      '| HWC/display | presentDisplay P95=7.1ms，VSync=8.33ms | 高刷新率预算下接近上限 |',
      '',
      '## BufferQueue/Fence 边界',
      '',
      '- queueBuffer 不等于上屏；它只证明 producer submission。',
      '- dequeueBuffer 等待更接近 release fence/backpressure。',
      '- acquire fence 影响 SF latch，present fence 只锚定显示栈提交边界、不证明用户实际看到，release fence 影响 producer 复用。',
      '- BLAST Transaction 到达和 SurfaceFlinger latch 是独立阶段，不能混用。',
      '',
      '## 图形内存/刷新策略边界',
      '',
      '- 当前没有 GraphicBuffer/dma-buf 图形内存证据，不能把 BufferQueue 槽位等待写成 graphics memory 泄漏。',
      '- refresh-rate policy 证据来自 VSYNC-sf，ARR/VRR 和 setFrameRate 只是策略 hint；缺失 SurfaceFlinger dumpsys 时置信度为中等。',
      '',
      '## 推荐路径',
      '',
      '- 继续用 fence_wait_decomposition、present_fence_timing、vsync_config 和 surfaceflinger_analysis 复核。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richPipelineReport }),
      query: '分析渲染管线 BufferQueue fence',
      sceneType: 'pipeline',
    })).toBeUndefined();
  });

  it('flags network reports that omit request-stage evidence boundaries', () => {
    const shortNetworkReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      '请求慢主要是 DNS/TLS/TTFB 慢，建议优化服务端和缓存。',
      '',
      '## 关键证据',
      '',
      '- network_analysis 显示网络包较多。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortNetworkReport,
        findings: [{
          severity: 'warning',
          title: '请求阶段候选',
          description: 'network_analysis packet activity overlaps slow request window',
          evidence: ['network_analysis active_window=620ms packet_count=420'],
        } as any],
      }),
      query: '分析 OkHttp EventListener DNS TLS TTFB 是否慢',
      sceneType: 'network',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('请求阶段证据边界');
    expect(issue?.message).not.toContain('网络栈/版本策略边界');
  });

  it('flags generic slow-network reports that omit packet-vs-request boundaries', () => {
    const shortNetworkReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      '网络慢，建议优化服务端。',
      '',
      '## 关键证据',
      '',
      '- network_analysis 显示 packet activity 存在。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortNetworkReport,
        findings: [{
          severity: 'warning',
          title: '网络慢候选',
          description: 'packet activity overlaps user-reported slow network window',
          evidence: ['network_analysis active_window=900ms packet_count=840'],
        } as any],
      }),
      query: '分析网络慢',
      sceneType: 'network',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('请求阶段证据边界');
  });

  it('rejects hollow network request-stage boundary mentions', () => {
    const hollowReport = [
      '# 网络分析报告',
      '',
      '## 请求阶段证据边界',
      '',
      '这里缺少 DNS/TLS/TTFB 的证据边界。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: hollowReport,
        findings: [{
          severity: 'warning',
          title: '空洞边界报告',
          description: 'Report mentions the boundary without evidence classes',
          evidence: ['network_analysis total_mb=1.2'],
        } as any],
      }),
      query: '分析 OkHttp EventListener DNS TLS TTFB 是否慢',
      sceneType: 'network',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('请求阶段证据边界');
  });

  it('accepts network request-stage reports without requiring stack-policy sections', () => {
    const richNetworkReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      '当前只能把 TTFB 写成中置信候选，不能从 packet-level trace 单独升级为 DNS/TLS 根因。',
      '',
      '## 请求阶段证据边界',
      '',
      '- packet-level / trace_direct:packet_activity 只证明接口、协议、远端端口、活跃时间窗和流量规模。',
      '- OkHttp EventListener request-level telemetry 与 request_id=req-42、trace_id=net-42 在 1200-1800ms 时间窗对齐。',
      '- 阶段拆分覆盖 DNS、connect、TLS、TTFB、request body、response body、decode、HTTPDNS cache 和 retry。',
      '- 接入层日志与 APM 只作为 external context；缺失 server log 时 confidence 保持中等，不能直接归因为服务端。',
      '',
      '## 采集建议',
      '',
      '- 后续补充 Cronet/HttpEngine event 或服务端 trace id 后再提高置信度。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richNetworkReport }),
      query: '分析 OkHttp EventListener DNS TLS TTFB 是否慢',
      sceneType: 'network',
    })).toBeUndefined();
  });

  it('flags network stack-policy reports that omit version and config boundaries', () => {
    const shortStackReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      'Android 17 ECH 和 local network permission 导致请求失败。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortStackReport,
        findings: [{
          severity: 'warning',
          title: '网络策略候选',
          description: 'User reports ECH failure but trace only has packet activity',
          evidence: ['network_analysis remote_port=443 packet_count=18'],
        } as any],
      }),
      query: '分析 Android 17 ECH Certificate Transparency local network permission dumpsys connectivity 失败',
      sceneType: 'network',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('网络栈/版本策略边界');
    expect(issue?.message).not.toContain('请求阶段证据边界');
  });

  it('accepts network stack-policy reports without requiring request-stage sections', () => {
    const richStackReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      '本次只能把 ECH / Certificate Transparency / local network permission 写成版本配置候选，不能从 packet 直接定因。',
      '',
      '## 网络栈/版本策略边界',
      '',
      '- client stack 为 Cronet/HttpEngine，涉及 HTTP/3、QUIC、ECH、Certificate Transparency、local network permission 和 ACCESS_LOCAL_NETWORK。',
      '- Android 17、API 37、targetSdk 37、Extension、server support、permission policy 与 Network Security Config 都是版本/配置能力边界。',
      '- trace_direct packet 只证明连接尝试和流量窗口；缺失 config、log、dumpsys connectivity 和 APM 时 confidence 为低到中等，不能写成确定根因。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richStackReport }),
      query: '分析 Android 17 ECH Certificate Transparency local network permission dumpsys connectivity 失败',
      sceneType: 'network',
    })).toBeUndefined();
  });

  it('does not require request-stage or stack-policy sections for generic traffic reports', () => {
    const genericNetworkReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      'network_analysis 显示 wlan0 received=12MB，TCP 流量集中在 443 端口。',
      '',
      '## 关键证据',
      '',
      '- android_network_packets 可用，packet_count=4200，active window=35s。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: genericNetworkReport,
        findings: [{
          severity: 'info',
          title: '网络流量',
          description: 'packet activity summary exists',
          evidence: ['android_network_packets packet_count=4200 total_mb=12'],
        } as any],
      }),
      query: '分析 network traffic is high',
      sceneType: 'network',
    })).toBeUndefined();
  });

  it('does not require stack-policy sections for generic bandwidth traffic reports', () => {
    const genericBandwidthReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      'network_analysis 显示 bandwidth usage 偏高，主要来自 wlan0 下行流量。',
      '',
      '## 关键证据',
      '',
      '- android_network_packets 可用，packet_count=5200，total_mb=26，active window=42s。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: genericBandwidthReport,
        findings: [{
          severity: 'info',
          title: '网络带宽',
          description: 'packet bandwidth usage summary exists',
          evidence: ['android_network_packets packet_count=5200 total_mb=26'],
        } as any],
      }),
      query: 'analyze network bandwidth usage high traffic',
      sceneType: 'network',
    })).toBeUndefined();
  });

  it('flags power reports that omit Job/Work/FGS governance boundaries for job quota questions', () => {
    const shortPowerReport = [
      '# 功耗分析报告',
      '',
      '## 综合结论',
      '',
      '后台任务耗电高，JobScheduler quota 可能异常，需要减少后台任务。',
      '',
      '## 关键证据链',
      '',
      '- android_job_scheduler_events 显示后台任务运行窗口较长。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortPowerReport,
        findings: [{
          severity: 'warning',
          title: '后台任务耗电',
          description: 'Job runtime overlapped with battery drain',
          evidence: ['android_job_scheduler_events dur_ms=540000'],
        } as any],
      }),
      query: '分析 JobScheduler runtime quota pending reason stop reason',
      sceneType: 'power',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('Job/Work/FGS 治理边界');
    expect(issue?.message).not.toContain('Alarm/Wakeup/Vitals 边界');
  });

  it('accepts Job/Work/FGS power reports without requiring alarm or Vitals sections', () => {
    const richPowerReport = [
      '# 功耗分析报告',
      '',
      '## 综合结论',
      '',
      '后台 Job 与掉电窗口重叠，但当前只能支持 background execution 候选，不能直接判定 Android 16 quota 是根因。',
      '',
      '## Job/Work/FGS 治理边界',
      '',
      '- JobScheduler/WorkManager/FGS/UIDT 需要分层：trace 中 android_job_scheduler_events 只证明 JobScheduler 执行窗口。',
      '- pending reason/getPendingJobReasons 解释为什么未运行；stop reason/getStopReason、JobParameters 和 WorkInfo 才解释为什么被停止。',
      '- Android 16 runtime quota、standby bucket 和 Foreground Service 并发规则属于版本敏感边界；当前缺失 logcat、dumpsys 和 app telemetry，因此 confidence 为中等。',
      '- FGS dataSync/mediaProcessing timeout 与 Service.onTimeout 需要服务类型和 Android 15+ 日志，当前不可直接宣称。',
      '',
      '## 优化建议',
      '',
      '- 补充 JobScheduler pending history、WorkInfo.stopReason、JobParameters.getStopReason 和 FGS service telemetry 后再提升置信度。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richPowerReport }),
      query: '分析 JobScheduler runtime quota pending reason stop reason',
      sceneType: 'power',
    })).toBeUndefined();
  });

  it('flags power reports that omit Alarm/Wakeup/Vitals boundaries for alarm and wakelock questions', () => {
    const shortWakeupReport = [
      '# 功耗分析报告',
      '',
      '## 综合结论',
      '',
      'wakeup 次数高，说明 exact alarm 和 wakelock 违规。',
      '',
      '## 关键证据链',
      '',
      '- wakeup_frequency_summary 显示 wakeups/min 偏高。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortWakeupReport,
        findings: [{
          severity: 'warning',
          title: 'wakeup high',
          description: 'wakeup rate high',
          evidence: ['wakeup_frequency_summary wakeups_per_min=2.4'],
        } as any],
      }),
      query: '分析 setExactAndAllowWhileIdle exact alarm wakeup Android vitals partial wakelock',
      sceneType: 'power',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('Alarm/Wakeup/Vitals 边界');
    expect(issue?.message).not.toContain('Job/Work/FGS 治理边界');
  });

  it('accepts Alarm/Wakeup/Vitals power reports without requiring Job/Work/FGS sections', () => {
    const richWakeupReport = [
      '# 功耗分析报告',
      '',
      '## 综合结论',
      '',
      '本地 trace 只证明 wakeup 与 wakelock 活跃，不能直接判定 exact alarm 权限或 Play vitals 违规。',
      '',
      '## Alarm/Wakeup/Vitals 边界',
      '',
      '- AlarmManager exact alarm / allow-while-idle / setExactAndAllowWhileIdle 需要 app API 或 dumpsys alarm 证据；当前 trace 只看到 android_wakeups。',
      '- Android vitals excessive partial wakelock 需要 24h 聚合，2h 总计参考；stuck partial wakelock 需要 1h 后台持有参考。本 trace window 只有局部 observed window。',
      '- android_kernel_wakelock 与 wakeups 只能支持局部候选；SCHEDULE_EXACT_ALARM permission、USE_EXACT_ALARM 和 external_aggregate 缺失，因此不能提升为政策违规结论。',
      '',
      '## 采集建议',
      '',
      '- 补充 dumpsys alarm、Play vitals 聚合、wakelock tag、app alarm scheduling log 后再判断。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richWakeupReport }),
      query: '分析 setExactAndAllowWhileIdle exact alarm wakeup Android vitals partial wakelock',
      sceneType: 'power',
    })).toBeUndefined();
  });

  it('does not require background-governance sections for generic power reports', () => {
    const genericPowerReport = [
      '# 功耗分析报告',
      '',
      '## 综合结论',
      '',
      'power_rails 可用，CPU rail=12.4mWh，GPU rail=1.2mWh，battery drain rate=3.1%/h，温控未触发。',
      '',
      '## 数据完整度判定',
      '',
      '- power_rails、battery_counters、cpu_freq_idle 可用；gpu_work_period 缺失。',
      '',
      '## 全局能量/掉电趋势',
      '',
      '- hardware_power_rails 显示 CPU 是主要能耗；Wattson thread estimate 与 CPU utilization 对齐。',
      '',
      '## 待机健康度',
      '',
      '- suspend 占比正常，screen-off CPU 未见异常，当前结论 confidence=中等。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: genericPowerReport }),
      query: '分析功耗和 thermal throttling',
      sceneType: 'power',
    })).toBeUndefined();
  });

  it('flags memory reports that omit evidence scope and memory-type boundaries', () => {
    const shortMemoryReport = [
      '# 内存分析报告',
      '',
      '## 综合结论',
      '',
      'PSS 持续上涨，可能存在泄漏，需要优化内存。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortMemoryReport,
        findings: [{
          severity: 'warning',
          title: '内存上涨',
          description: 'PSS trend increased',
          evidence: ['PSS +120MB'],
        } as any],
      }),
      query: '分析内存上涨和 GC 抖动',
      sceneType: 'memory',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('内存证据范围');
    expect(issue?.message).toContain('内存类型拆分');
    expect(issue?.message).toContain('置信度与缺失证据');
  });

  it('accepts memory reports that separate evidence source, memory type, and missing proof', () => {
    const richMemoryReport = [
      '# 内存分析报告',
      '',
      '## 综合结论',
      '',
      'PSS/RSS 在 60s 窗口内上涨 120MB，GC pause 频繁，但当前证据只能支持内存压力候选，不能直接判定泄漏。',
      '',
      '## 证据范围',
      '',
      '- 证据来源：PSS、RSS、Java Heap、GC、LMK 窗口统计可用；Native Heap、Graphics/dma-buf、heap graph 缺失。',
      '',
      '## 内存类型拆分',
      '',
      '- Java Heap 增长 80MB，GC churn 增加；Native Heap 和 Graphics-dma-buf 当前没有直接证据。',
      '- RSS/PSS 同步上涨，LMK/freezer/OOM 事件未在窗口内命中。',
      '',
      '## 置信度与缺失证据',
      '',
      '- 证据不足：没有 heap graph 和 dmabuf 采样，高内存不等于泄漏，LMK/freezer/OOM 需要区分。',
      '- 建议采集 heap graph、smaps/dmabuf 和更长窗口趋势后再提升置信度。',
      '',
      '## 优化建议',
      '',
      '- 先按 Java 分配热点和缓存生命周期排查，并补充 Native/Graphics 证据。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richMemoryReport }),
      query: '分析内存上涨和 GC 抖动',
      sceneType: 'memory',
    })).toBeUndefined();
  });

  it('flags startup reports that omit user-requested diagnostic API boundaries', () => {
    const issue = assessFinalResultQuality({
      result: result({
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{ claimId: 'claim-startup', status: 'verified' }],
          issues: [],
        },
      }),
      query: '用 ApplicationStartInfo STARTUP_STATE 和 App Performance Score 分析启动 TTID/TTFD',
      sceneType: 'startup',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('启动诊断 API/外部指标边界');
  });

  it('accepts startup reports that separate ApplicationStartInfo and external metrics from trace proof', () => {
    const richStartupReport = [
      '# 启动性能分析报告',
      '',
      '## 启动类型与 TTID/TTFD',
      '',
      '启动类型为冷启动，TTID=1912ms，TTFD=2200ms。',
      '',
      '## 阶段耗时分解',
      '',
      '- startup_detail phase breakdown 显示 bindApplication self_ms=120ms，activityStart self_ms=240ms。',
      '',
      '## 根因编号引用',
      '',
      '- 根因编号 A5 / B2 对应类加载与首帧后数据加载。',
      '',
      '## 启动诊断 API/外部指标边界',
      '',
      '- diagnostic_api: ApplicationStartInfo / getHistoricalProcessStartReasons 返回 STARTUP_STATE 和 START_REASON，API 35 / Android 15 可用；START_COMPONENT 属于 API 36。',
      '- record state 为 incomplete/in-progress 时只作候选；START_TIMESTAMP 使用独立 clock/timestamp，需要与 current trace window、TTID、TTFD 对齐。',
      '- external_aggregate / experiment: App Performance Score、Play Vitals、APM、A/B 需要 device、sample、activation 和 A/A sanity；缺失时 confidence 保持中等，不能替代本次 trace 根因。',
      '',
      '## 优化建议',
      '',
      '- [App层] 延后非首屏初始化。',
      '- [系统/平台层] 当前无系统侧阻塞证据。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richStartupReport }),
      query: '用 ApplicationStartInfo STARTUP_STATE 和 App Performance Score 分析启动 TTID/TTFD',
      sceneType: 'startup',
    })).toBeUndefined();
  });

  it('flags memory reports that omit user-requested diagnostic API boundaries', () => {
    const richWithoutDiagnosticBoundary = [
      '# 内存分析报告',
      '',
      '## 综合结论',
      '',
      'PSS/RSS 上涨 120MB，当前只能支持内存压力候选，不能直接判定泄漏。',
      '',
      '## 证据范围',
      '',
      '- 证据来源：PSS、RSS、Java Heap、Native Heap、Graphics/dma-buf、GC、LMK、heap graph 缺失和 missing evidence 均已列出。',
      '',
      '## 内存类型拆分',
      '',
      '- Java Heap 增长，Native Heap / Graphics-dma-buf 暂无证据；GC churn 存在，LMK/freezer/OOM 未命中，不能写成 leak。',
      '',
      '## 置信度与缺失证据',
      '',
      '- 证据不足：需要区分高内存与泄漏，missing heap graph 时 confidence 为中等，不能把缺失证据写成没有问题。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({ conclusion: richWithoutDiagnosticBoundary }),
      query: '用 ApplicationExitInfo REASON_LOW_MEMORY 和 ProfilingManager heap dump 分析 OOM',
      sceneType: 'memory',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('内存诊断 API/剖析产物边界');
  });

  it('accepts memory reports that separate ApplicationExitInfo and profiling artifacts', () => {
    const richMemoryDiagnosticReport = [
      '# 内存分析报告',
      '',
      '## 综合结论',
      '',
      'PSS/RSS 上涨 120MB，ApplicationExitInfo 只支持低内存退出背景，不能单独证明 Java leak。',
      '',
      '## 证据范围',
      '',
      '- 证据来源：PSS、RSS、Java Heap、Native Heap、Graphics/dma-buf、GC、LMK、heap graph missing evidence 均已列出。',
      '',
      '## 内存类型拆分',
      '',
      '- Java Heap 增长，Native Heap / Graphics-dma-buf 暂无证据；GC churn 存在，LMK/freezer/OOM 需要 ApplicationExitInfo 补证，不等于 leak。',
      '',
      '## 置信度与缺失证据',
      '',
      '- missing heap graph 与 smaps 时 confidence 为中等，不能把高内存直接写成泄漏。',
      '',
      '## 内存诊断 API/剖析产物边界',
      '',
      '- diagnostic_api: ApplicationExitInfo / getHistoricalProcessExitReasons 命中 REASON_LOW_MEMORY，API 30 / Android 11+，reason、process、pid/upid、timestamp 与 record 需要核对。',
      '- profiling_artifact: ProfilingManager / ProfilingTrigger Java heap dump 与 heap profile 需要 result file / artifact 路径和采样时间。',
      '- external_aggregate: KOOM/APM 只能作背景；必须和 current trace window align，对齐缺失时写 missing evidence，confidence 不提升，not prove leak。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richMemoryDiagnosticReport }),
      query: '用 ApplicationExitInfo REASON_LOW_MEMORY 和 ProfilingManager heap dump 分析 OOM',
      sceneType: 'memory',
    })).toBeUndefined();
  });

  it('flags ANR reports that omit user-requested diagnostic API boundaries', () => {
    const shortAnrReport = [
      '# ANR 分析报告',
      '',
      '## 综合结论',
      '',
      'ANR 发生在 5000ms 输入窗口，main thread Q4 Sleeping=82%，direct_blocker 是 Binder wait 1200ms。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortAnrReport,
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{ claimId: 'claim-anr', status: 'verified' }],
          issues: [],
        },
      }),
      query: '用 ApplicationExitInfo getAnrInfo 和 ProfilingTrigger ANR system trace 分析 ANR',
      sceneType: 'anr',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('ANR 诊断 API/外部聚合边界');
  });

  it('accepts ANR reports that separate diagnostic APIs, profiling artifacts, and Vitals', () => {
    const richAnrReport = [
      '# ANR 分析报告',
      '',
      '## 综合结论',
      '',
      '当前 trace 的 Perfetto ANR window 为 5000ms，direct_blocker 是 Binder wait 1200ms；外部记录只提升置信度。',
      '',
      '## ANR 诊断 API/外部聚合边界',
      '',
      '- system-confirmed / diagnostic_api: ApplicationExitInfo getAnrInfo REASON_ANR 在 API 37 / Android 17 才提供 ANR reason，timestamp 需要和 event window 对齐。',
      '- profiling_artifact: ProfilingManager / ProfilingTrigger TRIGGER_TYPE_ANR system trace artifact 只能补充采样窗口；trigger type、artifact 时间和 current trace 需要 align。',
      '- external_aggregate: Play Vitals / Android Vitals user-perceived ANR、client watchdog 和 SDK watchdog 是聚合/预警，不 replace Perfetto direct_blocker、logcat、Binder、lock 证据。',
      '- missing ApplicationExitInfo 或 artifact 时 confidence 不能提升，不能不可替代当前 trace 根因链。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richAnrReport }),
      query: '用 ApplicationExitInfo getAnrInfo 和 ProfilingTrigger ANR system trace 分析 ANR',
      sceneType: 'anr',
    })).toBeUndefined();
  });

  it('does not require diagnostic API sections for generic ANR reports', () => {
    const genericAnrReport = [
      '# ANR 分析报告',
      '',
      '## 综合结论',
      '',
      'ANR 窗口 5000ms，main thread Q4 Sleeping=82%，direct_blocker Binder wait=1200ms，logcat 与 Binder 对端证据对齐。',
      '',
      '## 关键证据链',
      '',
      '- anr_analysis 提供 freeze_verdict=app_specific、timeout_source=Perfetto、confidence=高。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: genericAnrReport,
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{ claimId: 'claim-anr-generic', status: 'verified' }],
          issues: [],
        },
      }),
      query: '分析 ANR direct blocker',
      sceneType: 'anr',
    })).toBeUndefined();
  });

  it('does not require diagnostic API sections for generic ANR system trace or stack trace reports', () => {
    const genericTraceReport = [
      '# ANR 分析报告',
      '',
      '## 综合结论',
      '',
      'system trace 与 stack trace 显示主线程 Binder wait 1200ms，Perfetto ANR window 和 logcat 事件窗口对齐。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({
        conclusion: genericTraceReport,
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          claimResults: [{ claimId: 'claim-anr-stack', status: 'verified' }],
          issues: [],
        },
      }),
      query: '分析 ANR system trace 和 stack trace 的 direct blocker',
      sceneType: 'anr',
    })).toBeUndefined();
  });

  it('flags io reports that turn fsync into database root cause without boundaries', () => {
    const shortIoReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      '主线程 fsync 很慢，所以数据库是根因，需要优化 DB。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortIoReport,
        findings: [{
          severity: 'warning',
          title: 'fsync stall',
          description: 'main thread fsync 120ms',
          evidence: ['blocked_function=do_fsync dur=120ms'],
        } as any],
      }),
      query: '分析 SQLite fsync 为什么导致卡顿',
      sceneType: 'io',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('I/O 证据类型');
    expect(issue?.message).toContain('文件/数据库/Provider 边界');
    expect(issue?.message).toContain('置信度与补证');
  });

  it('flags reports that treat epoll or poll blocked_function as IO root cause', () => {
    const misleadingPollReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      'blocked_function=epoll_wait 命中 120ms，说明主线程在磁盘 IO 阻塞，所以这是 IO 根因。',
      '',
      '## I/O 证据类型',
      '',
      '- epoll_wait 120ms 与卡顿窗口重叠。',
      '',
      '## 文件/数据库/Provider 边界',
      '',
      '- 后续优化数据库。',
      '',
      '## 置信度与补证',
      '',
      '- 置信度高。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: misleadingPollReport,
        findings: [{
          severity: 'warning',
          title: 'poll wait',
          description: 'main thread epoll_wait 120ms',
          evidence: ['blocked_function=epoll_wait dur=120ms'],
        } as any],
      }),
      query: '分析 IO 为什么导致卡顿',
      sceneType: 'io',
    });

    expect(issue?.code).toBe('kernel_blocking_claim_boundary');
    expect(issue?.message).toContain('epoll/poll');
  });

  it('flags poll IO claims that include decimal durations', () => {
    const issue = assessFinalResultQuality({
      result: result({
        conclusion: 'do_epoll_wait 持续 120.5ms，证明磁盘 IO 是根因。',
        findings: [{
          severity: 'warning',
          title: 'poll wait',
          description: 'do_epoll_wait lasted 120.5ms',
          evidence: ['blocked_function=do_epoll_wait dur=120.5ms'],
        } as any],
      }),
      query: '解释这段阻塞的 IO 根因',
    });

    expect(issue?.code).toBe('kernel_blocking_claim_boundary');
    expect(issue?.message).toContain('epoll/poll');
  });

  it('accepts explicit English poll root-cause boundaries', () => {
    for (const conclusion of [
      'epoll does not prove disk I/O as the root cause.',
      'epoll cannot directly prove disk I/O as the root cause.',
      'epoll alone is insufficient to establish disk I/O as the root cause.',
      'epoll does not imply that disk I/O was the root cause.',
      'epoll does not necessarily indicate that disk I/O caused the stall.',
      'epoll is insufficient evidence to prove disk I/O as the root cause.',
      'epoll cannot be used to prove disk I/O was the root cause.',
      'epoll is not sufficient evidence to establish disk I/O as the root cause.',
      'epoll cannot conclusively prove disk I/O as the root cause.',
      'epoll neither proves nor establishes disk I/O as the root cause.',
      'epoll 不足以证明磁盘 IO 是根因。',
      'epoll cannot prove disk I/O was the root cause; it only indicates a candidate.',
      'epoll cannot prove disk I/O was the root cause; this indicates storage I/O may be a candidate root cause.',
      'epoll cannot prove disk I/O was the root cause; it indicates possible storage I/O as a root-cause candidate.',
      'epoll 不能证明磁盘 IO 是根因；该信号表明存储 IO 可能只是根因候选。',
      'epoll 不能证明磁盘 IO 是根因；它说明存储 IO 仍需补证。',
      'epoll/poll 通常表示等待事件或空闲，但仍需要 IO 证据才能证明根因。',
    ]) {
      const issue = assessFinalResultQuality({
        result: result({
          conclusion,
          findings: [{
            severity: 'info',
            title: 'poll boundary',
            description: 'epoll is event wait evidence',
            evidence: ['blocked_function=epoll_wait'],
          } as any],
        }),
        query: 'Explain why epoll is not the root cause',
      });

      expect(issue).toBeUndefined();
    }
  });

  it('accepts reports that explicitly found no poll evidence or IO misclassification risk', () => {
    const baseReport = result({}).conclusion;
    for (const boundary of [
      '**内核等待语义自检**：两侧均未命中 `epoll`/`poll` 类 `blocked_function`；D 状态均 ≤1.7%，无 IO 误判风险。',
      'Kernel wait check: no epoll or poll match was found, so there is no disk I/O root-cause evidence.',
      '内核等待语义边界：epoll/poll 类 blocked_function 通常表示等待事件或空闲，只有 io_wait=1 或有明确文件/数据库证据时才可列为 IO 候选 — 当前二者均不具备；blocked_function 是 kernel wchan 单帧，非完整内核调用栈。',
      'thread_state.blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待。当前 trace 缺失此数据源，470ms Sleeping 无法归因到具体原因。',
      'blocked_function 能力边界内，blocked_functions 列为 `-`，Sleeping 状态的具体阻塞原因（epoll/poll/futex 等）无法确认。',
      'Q4b=470ms 因 `blocked_function` 缺失而无法追踪——可能是模拟 `Thread.sleep`、`epoll`/`poll` 事件等待或模拟 I/O 完成等待。**缺少证据不能将其定性为任何具体阻塞根因。**',
      'blocked_function 缺失；独立 SQLite file I/O slice=200ms 证明磁盘 IO 是根因；因此无法追踪 poll 阻塞源，可能为 epoll 事件等待。',
      'blocked_function is missing, and epoll_wait may indicate disk I/O only as a candidate; it is therefore unable to trace and may be an epoll event wait.',
      'blocked_function 缺失且无法追踪；epoll_wait 表明磁盘 IO 仅为候选根因，可能是 epoll 事件等待。当前没有 io_wait=1，也没有文件或数据库 I/O 证据。',
      'Sleeping 由 ChaosTask 系列切片中的主动 Thread.sleep 导致。blocked_functions 全为 null 进一步印证这是应用层主动等待（非系统 Binder/IO/epoll 阻塞）。TTID 滞后说明合成负载期间无新帧提交，SurfaceFlinger 未收到内容更新。',
    ]) {
      const issue = assessFinalResultQuality({
        result: result({
          conclusion: `${baseReport}\n\n## 内核等待语义自检\n\n${boundary}`,
        }),
        query: '对比两条 Trace 的启动根因',
      });

      expect(issue).toBeUndefined();
    }
  });

  it('accepts an explicit Sleeping/poll ambiguity boundary', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: `${result({}).conclusion}\n\nSleeping 状态不等于 I/O——当前无法区分 epoll 类事件等待、Thread.sleep 还是其他同步原语。`,
        partial: true,
      }),
      query: '分析内核等待证据边界',
    })).toBeUndefined();
  });

  it('still rejects poll root-cause claims when unrelated evidence is absent', () => {
    for (const conclusion of [
      '未发现其他证据，但 blocked_function=epoll_wait 证明磁盘 IO 是根因。',
      '当前无 IO 证据，但 epoll_wait 仍说明磁盘 IO 是根因。',
      'No other I/O evidence was found, but epoll proves disk I/O was the root cause.',
      '未发现 epoll 之外的其他证据，但 epoll_wait 证明磁盘 IO 是根因。',
      '没有命中 poll 以外的函数，poll_wait 说明磁盘 IO 是根因。',
      '未发现 epoll/poll 之外的其他证据，但 epoll_wait 证明磁盘 IO 是根因。',
      '未命中 epoll/poll 以外的函数，poll_wait 说明磁盘 IO 是根因。',
      'No epoll evidence other than this match was found, but epoll proves disk I/O was the root cause.',
      'epoll does not prove disk I/O as the root cause, but epoll proves storage I/O was the root cause.',
      'epoll 不能证明磁盘 IO 是根因，但 epoll 证明存储 IO 是根因。',
      'epoll 不但证明磁盘 IO 是根因，而且证明存储 IO 是根因。',
      'Although epoll does not prove disk I/O as the root cause, epoll proves storage I/O was the root cause.',
      '尽管 epoll 不能证明磁盘 IO 是根因，epoll 仍证明存储 IO 是根因。',
      'epoll does not prove disk I/O as the root cause; conversely epoll proves storage I/O was the root cause.',
      'epoll cannot prove disk I/O as the root cause; but it proves storage I/O was the root cause.',
      'epoll cannot prove disk I/O as the root cause; however, this proves storage I/O was the root cause.',
      'epoll 不能证明磁盘 IO 是根因；但它证明存储 IO 是根因。',
      'epoll 不能证明磁盘 IO 是根因；不过该信号证明存储 IO 是根因。',
      'epoll/poll 通常表示等待事件或空闲，但它证明磁盘 IO 是根因。',
      'epoll/poll 通常表示等待事件或空闲，但 epoll_wait 证明磁盘 IO 是根因。',
      'epoll/poll 通常表示等待事件或空闲，但仍证明磁盘 IO 是根因。',
      'epoll/poll 通常表示等待事件或空闲，因此证明磁盘 IO 是根因。',
      'epoll/poll usually represents an event wait, but still proves disk I/O was the root cause.',
      'epoll/poll 通常表示等待事件或空闲，可是仍证明磁盘 IO 是根因。',
      'epoll/poll 通常表示等待事件或空闲，尽管如此仍证明磁盘 IO 是根因。',
      'epoll usually represents an event wait, yet still proves disk I/O was the root cause.',
      'epoll 通常表示等待事件，但这个证据仍证明磁盘 IO 是根因。',
      'epoll usually represents an event wait, but this evidence still proves disk I/O was the root cause.',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，但它证明磁盘 IO 是根因。',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，但 epoll_wait 证明磁盘 IO 是根因。',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，并证明磁盘 IO 是根因。',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，并且证明磁盘 IO 是根因。',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，从而证明磁盘 IO 是根因。',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，由此证明磁盘 IO 是根因。',
      'epoll usually represents an event wait, and proves disk I/O was the root cause.',
      'epoll usually represents an event wait, thereby proves disk I/O was the root cause.',
      'Q4b=470ms 因 `blocked_function` 缺失而无法追踪——可能是模拟 `Thread.sleep`、`epoll`/`poll` 事件等待或模拟 I/O 完成等待，但 `epoll_wait` 仍证明磁盘 IO 是根因。',
      'blocked_function 缺失，但 epoll_wait 仍证明磁盘 IO 是根因；因此无法追踪，可能为 epoll 事件等待。',
      'blocked_function 缺失且无法追踪；epoll_wait 表明磁盘 IO 是根因，可能是 epoll 事件等待。',
      'blocked_function is missing, but epoll_wait proves disk I/O was the root cause; it is therefore unable to trace and may be an epoll event wait.',
      'blocked_function 缺失，但 epoll_wait 仍说明磁盘 IO 是根因；因此无法追踪，可能为 epoll 事件等待。',
      'blocked_function 缺失，但 epoll_wait 仍是磁盘 IO 根因；因此无法追踪，可能为 epoll 事件等待。',
      'blocked_function is missing, but epoll_wait is still the disk I/O root cause; it is therefore unable to trace and may be an epoll event wait.',
      'blocked_function 缺失，epoll_wait 证明磁盘 IO 是根因但仍需补证；因此无法追踪，可能为 epoll 事件等待。',
      'blocked_function is missing, but epoll_wait proves disk I/O was the root cause but needs more evidence; it is therefore unable to trace and may be an epoll event wait.',
      'blocked_function 缺失，CPU 候选仍需补证但 epoll_wait 证明磁盘 IO 是根因；因此无法追踪，可能为 epoll 事件等待。',
      'blocked_function is missing and unable to trace; epoll_wait may indicate disk I/O only as a candidate but epoll_wait proves disk I/O was the root cause and may be an epoll event wait.',
      'blocked_function is missing and unable to trace; epoll_wait does not prove disk I/O was the root cause but epoll_wait proves disk I/O was the root cause and may be an epoll event wait.',
      'Sleeping 状态不等于 I/O——当前无法区分 epoll 类事件等待，但 epoll_wait 仍证明磁盘 IO 是根因。',
      'Sleeping 状态不等于 I/O 却由 epoll_wait 证明磁盘 IO 是根因，当前无法区分 epoll 类事件等待。',
      'Sleeping 状态并非不等于 I/O——当前无法区分 epoll 类事件等待。',
      'blocked_functions 全为 null 进一步印证这是应用层主动等待（非系统 Binder/IO/epoll 阻塞），但 epoll_wait 仍证明磁盘 IO 是根因。',
      '并非 blocked_functions 全为 null 进一步印证这是应用层主动等待（非系统 Binder/IO/epoll 阻塞）。',
    ]) {
      const issue = assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析 IO 根因',
      });

      expect(issue?.code).toBe('kernel_blocking_claim_boundary');
    }
  });

  it('accepts independent app IO evidence after a qualified poll boundary', () => {
    for (const conclusion of [
      'epoll 通常表示等待事件；独立 SQLite file I/O trace 证明磁盘 IO 是根因。',
      'epoll usually represents an event wait; an independent SQLite file I/O trace proves disk I/O was the root cause.',
      'epoll 通常表示等待事件，但独立 SQLite file I/O trace 证明磁盘 IO 是根因。',
      'epoll 通常表示等待事件；fsync dur=100ms 证明磁盘 IO 是根因。',
      'epoll usually represents an event wait; fsync dur=100ms proves disk I/O was the root cause.',
      'epoll 不能证明磁盘 IO 是根因；CPU 饱和证明它才是根因。',
      'epoll cannot prove disk I/O was the root cause; CPU saturation proves it was the root cause.',
      'epoll usually represents an event wait, but lock contention proves it was the root cause.',
      'blocked_reason 记录内核 wchan，可区分 Binder、futex、IO、epoll 等待，并且 fsync dur=100ms 证明磁盘 IO 是根因。',
      'epoll usually represents an event wait, and fsync dur=100ms proves disk I/O was the root cause.',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析 IO 根因',
      })).toBeUndefined();
    }
  });

  it('accepts independent stack evidence after a qualified blocked-function boundary', () => {
    for (const conclusion of [
      'blocked_function is not a full call stack; other profiler data is a full kernel call stack.',
      'blocked_function 不是完整内核调用栈；其他 profiler 数据是完整内核调用栈。',
      'blocked_function 不是完整内核调用栈；unwinder 输出是完整内核调用栈。',
      'blocked_function is not a full kernel call stack; unwinder output is a full kernel call stack.',
      'blocked_function 不是完整内核调用栈；frame-pointer 重建结果是完整调用栈。',
      'blocked_function is not a full kernel call stack; frame-pointer reconstruction is a full call stack.',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析内核调用栈证据边界',
      })).toBeUndefined();
    }
  });

  it('accepts explicit D-state and blocked-function evidence boundaries', () => {
    for (const conclusion of [
      'D-state alone cannot prove disk I/O as the root cause.',
      'D 状态不能证明磁盘 IO 是根因。',
      'D 状态不能证明磁盘 IO 是根因，但仍需 IO 证据才能证明根因。',
      'D 状态只是不可中断等待，仍需 IO 证据才能证明根因。',
      'D 状态仅表示不可中断等待，需要 IO 证据后才能归因。',
      'Q4a（D 状态）仅 22.98ms，印证 IO 阻塞不显著。',
      '根因：合成负载在 performCreate 路径中密集运行 CPU 任务，主线程 100% 在大核上执行，无调度瓶颈（Q3 Runnable 仅 4.59ms / 0.3%），也非 IO 阻塞（Q4a D 状态仅 22.98ms / 1.7%）。瓶颈纯粹是同步计算量。',
      '也非 IO 阻塞；独立 SQLite file I/O slice 持续 200ms，Trace 证据 art-io-1 支持磁盘 IO 是本次阻塞根因；Q4a D 状态仅 22.98ms / 1.7%。',
      '也非 IO 阻塞；独立 fsync dur=200ms，Trace 证据 art-io-2 证明磁盘 IO 是本次阻塞根因；Q4a D 状态仅 22.98ms / 1.7%。',
      'Q4a (D-state) is only 22.98ms, confirming that I/O blocking is not significant.',
      'D-state only indicates uninterruptible sleep; it requires I/O evidence before root-cause attribution.',
      '| **Q4a** | D (不可中断睡眠) | 22.98ms | 1.7% | 125 次，blocked_function 缺失，**不能直接归为磁盘 IO**；仅表明存在短暂的不可中断等待，具体原因需 io_wait 或 blocked_function 信号确认 |',
      '| D 状态 → 磁盘 IO 根因 | **无法确认** | blocked_function 与 io_wait 均缺失；D 状态 22.98ms (1.7%) 仅表明存在不可中断等待，不能直接归因为磁盘 IO |',
      '| **D 状态根因** | 22.98ms (1.7%)，因 io_wait 和 blocked_function 均缺失，不能归因为磁盘 IO |',
      '| 主线程 IO 根因 | **无法确认** — D 状态 22.98ms (1.7%)，`blocked_function` 未采集 | 需 `sched_blocked_reason` |',
      '| StartupHooks.kt 磁盘 I/O | **trace 未证明** — 源码描述合成磁盘读，但 trace D 状态仅 22.98ms(1.7%)。源码提供候选机制，trace 证据才是判据 | `[PRIVATE_QUERY_REFERENCE]` + art-30 |',
      '| 磁盘 I/O（Q4a） | 无法归因 | D-state 仅 23ms(1.7%)；无 io_wait/IO 阻塞函数绑定（能力边界 + missing_evidence） |',
      '| D-state (Q4a) 归因 | 低 | 缺少 io_wait 和 IO 阻塞函数绑定，不可归因 I/O（能力边界） |',
      '| D-state (Q4a) 归因 | 低 | 缺少 io_wait 和 IO 阻塞函数绑定，不可归因 I/O；独立 SQLite file I/O slice=200ms 支持磁盘 IO 根因 |',
      '| 磁盘 I/O 根因 | D-state 23ms；缺 `io_wait`、page-cache wchan 绑定 | `missing_evidence` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function 为空 | `trace_direct` + `derived_metric` |',
      '| IO/磁盘阻塞 | 0 D-state + blocked_function = null | `trace_direct` |',
      '| IO/磁盘阻塞 | 0 D-state + blocked_function is null | `trace_direct` |',
      '| IO / page-cache | io_blocking 0 行，D/DK=0ms | 高 | trace_direct |',
      '| IO / page-cache 等待 | ✗ 排除 | 主线程无 D/DK 状态、无 io_wait、blocked_function 为空 |',
      '| **Q4a** | Uninterruptible Sleep (D) | 22.98 | 1.7% | ✅ 占比低，不足以标定 I/O 根因（缺 `io_wait`/page-cache 证据） |',
      '| D 状态 I/O 归因 | 不可用 | `io_wait` + `blocked_function` 信号均缺失，22.98ms D 状态只能标为"不可中断等待" |',
      '内核等待语义自检：`blocked_function` 字段全部 null，无法判定是 Binder 等待、epoll 空闲还是其它类型阻塞，不能将其归为 IO 根因。',
      '| **D/IO 阻塞** | Q4a（D 状态）仅 22.98ms / 1.7%，未达 >10% 干预阈值 |',
      '所有依赖 ANR 窗口的后续分析步骤（CPU 健康、内存压力、I/O D-state、futex 锁等待、系统冻结检测、Top CPU 进程、根因诊断）均因无 ANR 窗口而返回空结果。',
      '- **I/O 阻塞（D-state）**：未做不可中断等待（state=D）统计，无 process_name 与 uninterruptible_wait_ms 数据。',
      '| 主线程 IO 根因 | **无法确认** — 但独立 CPU 饱和仍是启动慢的根因；D 状态 22.98ms (1.7%) | 需 `sched_blocked_reason` |',
      '| 主线程 IO 根因 | **无法确认** — 独立 SQLite file I/O slice 持续 200ms，Trace 证据支持磁盘 IO 是根因；D 状态 22.98ms (1.7%) | 需 `sched_blocked_reason` |',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；独立 SQLite file I/O slice=200ms 证明磁盘 IO 是根因，因此不能将 epoll 归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；独立 CPU 饱和证明它才是启动慢根因，因此不能将 epoll 归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；独立 SQLite file I/O slice=200ms；它证明磁盘 IO 是根因，因此不能将 epoll 归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；独立 CPU 饱和；它证明 CPU 才是启动慢根因，因此不能将 epoll 归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；独立 SQLite file I/O slice=200ms；因此证明磁盘 IO 是根因，不能将 epoll 归为 IO 根因。',
      'D 状态并非证明磁盘 IO 是根因，因此不能归因为磁盘 IO。',
      'D 状态并不证明磁盘 IO 是根因，因此无法认定为磁盘 IO 根因。',
      'D 状态不是磁盘 IO 根因，无法归因为磁盘 IO。',
      'D-state 的 blocked_function 记录了具体阻塞根因。',
      'Q4a / D 状态自检: D=22.98ms (1.7%)，startup_slow_reasons 的 IO 检查未触发，blocking_chain_analysis 的 waker_chain 和 blocked_function_summary 均返回 0 行（trace 未记录 blocked_function 字段）。缺少 io_wait=1 或 IO/page-cache blocked_function 证据——D 状态在本报告中统一称为「不可中断等待」，无法归因 I/O。',
      '本次 trace 中 **未检测到任何 ANR 事件**。`anr_analysis` Skill 已完整执行了 ANR 检测、ANR 上下文提取、系统 CPU 健康度、内存压力（LMK）、I/O D-state 阻塞、futex 锁等待探针以及系统冻结检测共七个步骤，`android_anrs` 表查询返回 `total_anr_count=0`，所有依赖 ANR 窗口的后续分析均因无窗口而无数据。',
      '| I/O D-state 阻塞 | rowCount=0 | 无 ANR 窗口，跳过 |',
      'blocked_function is not a full call stack.',
      'blocked_function 不是完整调用栈。',
      'blocked_function 不是完整调用栈，但仍需 perf sample 才能证明完整调用栈。',
      '文件 IO：blocked_functions 不含 IO/page-cache 函数族，当前侧 D-state 仅 22ms（1.7%）不足以构成根因。参考侧 D-state <1ms。',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析内核等待证据边界',
      })).toBeUndefined();
    }
  });

  it('accepts D-state taxonomy labels in an ANR diagnostic inventory', () => {
    const baseReport = result({}).conclusion;
    for (const boundary of [
      'anr_analysis Skill 已完成全流水线执行——ANR 检测、ANR 上下文提取、系统 CPU 健康评估、内存压力检测、I/O D-state 不可中断等待分析、Futex 锁等待探针、系统冻结检测、Top CPU 进程排名及综合诊断——所有步骤均确认目标进程在 Trace 窗口内无 ANR。但需特别说明：Trace 采集配置中 android.anrs 表不存在，因此只能确认 Trace 未记录 ANR 事件，不能断言系统确实未发生 ANR。',
      'I/O D-state 不可中断等待分析、Binder 阻塞分析。',
      'I/O D-state 不可中断等待分析，Binder 阻塞分析。',
      'The ANR diagnostic inventory completed CPU, memory, I/O D-state uninterruptible sleep analysis, futex lock-wait probing, and freeze detection. No ANR window was recorded, so no disk I/O attribution is available.',
      'I/O D-state uninterruptible sleep analysis was skipped because no ANR window exists.',
    ]) {
      expect(assessFinalResultQuality({
        result: result({
          conclusion: `${baseReport}\n\n${boundary}`,
          partial: true,
        }),
        query: '分析 ANR 根因证据边界',
      })).toBeUndefined();
    }
  });

  it('still rejects positive IO attribution after a D-state taxonomy label', () => {
    for (const conclusion of [
      'I/O D-state 不可中断等待分析已执行，但 D-state 仍证明磁盘 IO 是根因。',
      'I/O D-state uninterruptible sleep analysis completed, but D-state still proves disk I/O was the root cause.',
      '不可中断睡眠证明磁盘 IO 是根因。',
      'D-state、磁盘 IO 阻塞仍是根因。',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析 ANR 根因证据边界',
      })?.code).toBe('kernel_blocking_claim_boundary');
    }
  });

  it('evaluates fenced diagnostic trees line by line', () => {
    const safeTree = [
      '```text',
      '左侧启动贡献：',
      '├─ 业务 DB I/O ─ 14ms',
      '│  └─ SqliteLoad',
      '└─ D-state（不可中断等待）── 23ms (1.7%)',
      '   └─ 无法归因 I/O（缺 io_wait / wchan 数据）',
      '```',
    ].join('\n');
    expect(assessFinalResultQuality({
      result: result({conclusion: `${result({}).conclusion}\n\n${safeTree}`, partial: true}),
      query: '分析内核等待证据边界',
    })).toBeUndefined();

    const unsafeTree = [
      '```text',
      '左侧启动贡献：',
      '├─ 业务 DB I/O ─ 14ms',
      '│  └─ SqliteLoad',
      '└─ D-state（不可中断等待）── 23ms (1.7%)，证明磁盘 IO 是根因',
      '```',
    ].join('\n');
    expect(assessFinalResultQuality({
      result: result({conclusion: `${result({}).conclusion}\n\n${unsafeTree}`, partial: true}),
      query: '分析内核等待证据边界',
    })?.code).toBe('kernel_blocking_claim_boundary');
  });

  it('rejects positive kernel claims after an unrelated negative boundary', () => {
    for (const conclusion of [
      'D-state alone cannot prove disk I/O as root cause. However D-state proves disk I/O was the root cause.',
      'D 状态不能证明磁盘 IO 是根因，但 D 状态证明磁盘 IO 是根因。',
      'D-state cannot prove disk I/O was the root cause, but still proves disk I/O was the root cause.',
      'D-state cannot prove disk I/O was the root cause, yet still proves disk I/O was the root cause.',
      'D 状态不能证明磁盘 IO 是根因，但仍证明磁盘 IO 是根因。',
      'D 状态不能不归因为磁盘 IO 根因。',
      'D 状态不能不认定磁盘 IO 是根因。',
      '| D 状态 → 磁盘 IO 根因 | 无法确认，但仍证明磁盘 IO 是根因 |',
      '| 主线程 IO 根因 | **无法确认** — D 状态仍证明磁盘 IO 是根因，22.98ms (1.7%) | 需 `sched_blocked_reason` |',
      '| StartupHooks.kt 磁盘 I/O | **trace 未证明** — 源码描述合成磁盘读，但 trace D 状态仍证明磁盘 IO 是根因 | `[PRIVATE_QUERY_REFERENCE]` + art-30 |',
      '| StartupHooks.kt 磁盘 I/O | **并非 trace 未证明** — trace D 状态仅 22.98ms(1.7%) | art-30 |',
      '| 主线程 IO 根因 | **无法确认** — 但仍证明磁盘 IO 是根因；D 状态 22.98ms (1.7%) | 需 `sched_blocked_reason` |',
      '| 磁盘 I/O（Q4a） | 无法归因 | D-state 仅 23ms；无 io_wait/IO 阻塞函数绑定，但 D-state 仍证明磁盘 IO 是根因 |',
      '| D-state (Q4a) 归因 | 低 | 缺少 io_wait 和 IO 阻塞函数绑定，不可归因 I/O，但它仍证明磁盘 IO 是根因 |',
      '| D-state (Q4a) 归因 | 低 | D-state 先证明磁盘 IO 是根因，后写缺少 io_wait 和 blocked_function，无法归因 I/O |',
      '| 磁盘 I/O 根因 | D-state 23ms，仍证明磁盘 IO 是根因；缺 `io_wait`、page-cache wchan 绑定 | `missing_evidence` |',
      '| 磁盘 I/O 根因 | D-state 23ms；缺 `io_wait`、page-cache wchan 绑定 | `confirmed` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function 为空，但 D-state 仍证明磁盘 IO 是根因 | `trace_direct` |',
      '| IO / page-cache | io_blocking 0 行，D/DK=0ms，但仍证明磁盘 IO 是根因 | 高 | trace_direct |',
      '| IO / page-cache 等待 | ✗ 排除 | D 状态仍证明磁盘 IO 是根因 |',
      '| IO / page-cache 等待 | 已确认 | ✗ 排除 | 主线程 D/DK=22ms |',
      '| D 状态 I/O 归因 | confirmed | ✗ 排除 |',
      '| IO / page-cache | io_blocking 0.5 行，D/DK=0ms | 高 | trace_direct |',
      '| IO / page-cache | io_blocking 0 行，D/DK=0.5ms | 高 | trace_direct |',
      '| IO/磁盘阻塞 | D/DK 状态 22ms + blocked_function 为空 | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function 不为空 | `trace_direct` |',
      '| IO/磁盘阻塞 | 并非零 D/DK 状态 + blocked_function 为空 | `trace_direct` |',
      '| IO/磁盘阻塞 | 预计零 D/DK 状态 + blocked_function 为空 | `trace_direct` |',
      '| IO/磁盘阻塞 | 可能为零 D/DK 状态 + blocked_function 为空 | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function 并非 null | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function 不为 null | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D/DK 状态 + blocked_function != null | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D-state + blocked_function is not null | `trace_direct` |',
      '| IO/磁盘阻塞 | 零 D-state + blocked_function <> null | `trace_direct` |',
      '| **Q4a** | Uninterruptible Sleep (D) | 22.98 | 1.7% | 占比低，并非不足以标定 I/O 根因（缺 `io_wait`/page-cache 证据） |',
      '| **Q4a** | Uninterruptible Sleep (D) | 22.98 | 1.7% | 占比低，不足以标定 I/O 根因，但 D-state 仍证明磁盘 IO 是根因 |',
      '| Q4a I/O 根因 | 已确认 | D 22.98，1.7%，占比低，不足以标定 I/O 根因（缺 io_wait/page-cache） |',
      '| Q4a I/O 根因 | confirmed | D 22.98，1.7%，占比低，不足以标定 I/O 根因（缺 io_wait/page-cache） |',
      '| D 状态 I/O 归因 | 不可用 | D 状态仍证明磁盘 IO 是根因，尽管 `io_wait` + `blocked_function` 信号均缺失 |',
      '| D 状态 I/O 根因 | 已确认 | 不可用 |',
      '| 磁盘 I/O（Q4a） | 并非无法归因 | D-state 仅 23ms；无 io_wait/IO 阻塞函数绑定 |',
      '内核等待语义自检：`blocked_function` 字段全部 null，无法判定是 Binder 等待、epoll 空闲还是其它类型阻塞，不能将其归为 IO 根因，但仍证明磁盘 IO 是根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定是 Binder 等待、epoll 空闲还是其它阻塞，但 epoll_wait 仍证明磁盘 IO 是根因，不过不能将其归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定是 Binder 等待、epoll 空闲还是其它阻塞，不能不将其归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定是 Binder 等待、epoll 空闲还是其它阻塞，并非不能将其归为 IO 根因。',
      '内核等待语义自检：`blocked_function` 全部 null，无法判定 epoll 空闲；epoll 并非不证明磁盘 IO 是根因，因此不能将其归为 IO 根因。',
      '内核等待语义自检：`blocked_function` null，无法判定 epoll，epoll 证明磁盘 IO 是根因，不能归为 IO 根因。',
      '内核等待语义自检：`blocked_function` null，无法判定 epoll，epoll 仍证明磁盘 IO 是根因，不能归为 IO 根因。',
      '| **D/IO 阻塞** | Q4a（D 状态）仅 22.98ms / 1.7%，未达 >10% 干预阈值，但仍证明磁盘 IO 是根因 |',
      '所有依赖 ANR 窗口的后续分析步骤（CPU 健康、内存压力、I/O D-state、futex 锁等待、系统冻结检测、Top CPU 进程、根因诊断）均因无 ANR 窗口而返回空结果，但 D-state 仍证明磁盘 IO 是根因。',
      'I/O D-state 仍证明磁盘 IO 是根因，但根因诊断因无 ANR 窗口而返回空结果。',
      'I/O D-state 根因诊断并非因无 ANR 窗口而返回空结果。',
      '- **I/O 阻塞（D-state）**：未做不可中断等待（state=D）统计，无 process_name 与 uninterruptible_wait_ms 数据，但 D-state 仍证明磁盘 IO 是根因。',
      '| **D/IO 阻塞** | Q4a（D 状态）为 22.98ms / 1.7%，并非未达 >10% 干预阈值 |',
      'D 状态证明磁盘 IO 是根因，但因证据不足不能归因为磁盘 IO。',
      'D 状态并非证明磁盘 IO 是根因，但 D 状态证明磁盘 IO 是根因，因此不能归因为磁盘 IO。',
      'D 状态并非证明磁盘 IO 是根因但 D 状态证明磁盘 IO 是根因因此不能归因为磁盘 IO。',
      'D 状态不能证明磁盘 IO 是根因但仍证明磁盘 IO 是根因因此不能归因为磁盘 IO。',
      '| I/O D-state 阻塞 | rowCount=0 | 但仍证明磁盘 IO 是根因 |',
      'D 状态证明磁盘 IO 是根因；另一检查 rowCount=0。',
      'Q4a / D 状态自检: D=22.98ms (1.7%)，startup_slow_reasons 的 IO 检查未触发，但 D 状态仍证明磁盘 IO 是根因。',
      'Q4a / D 状态自检: 预计 IO 检查未触发，blocking_chain_analysis 返回0行。',
      'Q4a / D 状态自检: IO 检查未触发并不成立，blocking_chain_analysis 返回0行。',
      '| I/O D-state 阻塞 | rowCount!=0 |',
      '| I/O D-state 阻塞 | 预计 rowCount=0 |',
      '| I/O D-state 阻塞 | 并非无 ANR 窗口 |',
      '| I/O D-state 阻塞 | 未跳过 |',
      '| I/O D-state 阻塞 | 不跳过 |',
      '| I/O D-state 阻塞 | 无需跳过 |',
      '| D 状态 → 磁盘 IO 根因 | 无法确认但仍证明磁盘 IO 是根因 |',
      '| D 状态 → 磁盘 IO 根因 | 并非 **无法确认** |',
      'D 状态并非 **不能归因** 为磁盘 IO 根因。',
      'D 状态只是不可中断等待，仍需 IO 证据，但仍证明磁盘 IO 是根因。',
      'Q4a（D 状态）为 22.98ms，印证 IO 阻塞显著，是启动慢的根因。',
      '文件 IO：blocked_functions 不含 IO/page-cache 函数族，但 D-state 仍证明磁盘 IO 是根因；当前侧 D-state 仅 22ms（1.7%）不足以构成根因。',
      '并非 blocked_functions 不含 IO/page-cache 函数族，当前侧 D-state 仅 22ms（1.7%）不足以构成根因。',
      'Q4a (D-state) is 22.98ms, confirming significant I/O blocking as the startup root cause.',
      'Q4a（D 状态）仅 22.98ms，IO 阻塞并非不显著，是启动慢的根因。',
      'D 状态证明磁盘 IO 是根因；也非 IO 阻塞（Q4a D 状态仅 22.98ms / 1.7%）。',
      '也非 IO 阻塞（Q4a D 状态仅 22.98ms / 1.7%），但仍证明磁盘 IO 是根因。',
      '也非 IO 阻塞，但 D 状态证明磁盘 IO 是根因，Q4a 仅 22.98ms / 1.7%。',
      '也非 IO 阻塞（Q4a D 状态证明磁盘 IO 是根因，仅 22.98ms / 1.7%）。',
      '并非非 IO 阻塞（Q4a D 状态仅 22.98ms / 1.7%）。',
      'Q4a（D 状态）仅 22.98ms，印证 IO 阻塞不显著，但仍导致启动慢。',
      'Q4a（D 状态）仅 22.98ms，印证 IO 阻塞不显著，然而是启动慢的根因。',
      'Q4a（D 状态）仅 22.98ms，印证 IO 阻塞不显著。它仍证明 IO 阻塞是启动慢的根因。',
      'Q4a（D 状态）仅 22.98ms，印证 IO 阻塞不显著。它仍导致启动慢。',
      'Q4a (D-state) is only 22.98ms, confirming that I/O blocking is not significant. It still causes startup slowdown.',
      'Q4a (D-state) is 22.98ms, confirming I/O blocking is not insignificant.',
      'Q4a (D-state) is 22.98ms, confirming I/O blocking is not negligible.',
      'Q4a (D-state) is 22.98ms, confirming I/O blocking is not not significant.',
      'blocked_function is not a full call stack. However sched_blocked_reason blocked_function is the full kernel call stack.',
      'blocked_function 不是完整调用栈，但 sched_blocked_reason blocked_function 是完整内核调用栈。',
      'blocked_function is not a full call stack, but still is a full kernel call stack.',
      'blocked_function is not a full call stack, yet still is a full kernel call stack.',
      'blocked_function 不是完整内核调用栈，但仍是完整内核调用栈。',
    ]) {
      expect({
        conclusion,
        code: assessFinalResultQuality({
          result: result({conclusion, partial: true}),
          query: '分析内核等待证据边界',
        })?.code,
      }).toEqual({
        conclusion,
        code: 'kernel_blocking_claim_boundary',
      });
    }
  });

  it('requires affirmative D-state IO evidence bound to the causal claim', () => {
    for (const conclusion of [
      'D 状态证明磁盘 IO 是根因。另有与该等待窗口无关的 SQLite file I/O slice=1ms。',
      'D 状态证明磁盘 IO 是根因。注意：没有 io_wait=1 时不能归因。',
      'D 状态证明磁盘 IO 是根因。后续需要采集 io_wait=1 或 filemap 证据。',
      'D-state proves disk I/O was the root cause. No io_wait=1 evidence was captured.',
      'D 状态证明磁盘 IO 是根因。另有 SQLite file I/O slice=1ms。',
      'D 状态证明磁盘 IO 是根因。两分钟后 SQLite file I/O slice=1ms。',
      'D 状态证明磁盘 IO 是根因。不同线程观测到 blocked_function=filemap_read dur=1ms。',
      'D 状态证明磁盘 IO 是根因。只有 io_wait=1 才可归因，当前不具备。',
      'D-state proves disk I/O was the root cause. We do not have io_wait=1 evidence.',
      'D-state proves disk I/O was the root cause. io_wait=1 may be present but is unverified.',
      'D 状态证明磁盘 IO 是根因。可能存在 io_wait=1，但尚未验证。',
      'D 状态证明磁盘 IO 是根因。假设 io_wait=1 命中。',
      'D-state proves disk I/O was the root cause. If io_wait=1 is observed, that would support it.',
      'D 状态证明磁盘 IO 是根因，另有 SQLite file I/O slice=1ms。',
      'D 状态证明磁盘 IO 是根因，同句记录 SQLite file I/O slice=1ms。',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析内核等待证据边界',
      })?.code).toBe('kernel_blocking_claim_boundary');
    }

    for (const conclusion of [
      '主线程 D 状态与 io_wait=1 在同一等待窗口命中，证明磁盘 IO 是根因。',
      'D 状态证明磁盘 IO 是根因。同一等待窗口观测到 blocked_function=filemap_read dur=120ms。',
    ]) {
      expect(assessFinalResultQuality({
        result: result({conclusion, partial: true}),
        query: '分析内核等待证据边界',
      })).toBeUndefined();
    }
  });

  it('returns the exact offending statement for targeted provider correction', () => {
    const unsafeClaim = 'D 状态证明磁盘 IO 是根因';
    const issue = assessFinalResultQuality({
      result: result({
        conclusion: `## 综合结论\n\n${unsafeClaim}。\n\n## 优化建议\n\n继续采集同窗口证据。`,
        partial: true,
      }),
      query: '分析内核等待证据边界',
    });

    expect(issue).toEqual(expect.objectContaining({
      code: 'kernel_blocking_claim_boundary',
      offendingStatement: unsafeClaim,
    }));
  });

  it('flags reports that turn D-state-only evidence into disk IO root cause', () => {
    const misleadingDStateReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      '主线程 D-state 占比 35%，证明磁盘 IO 是本次卡顿根因。',
      '',
      '## I/O 证据类型',
      '',
      '- D-state 35%。',
      '',
      '## 文件/数据库/Provider 边界',
      '',
      '- 需要优化所有数据库访问。',
      '',
      '## 置信度与补证',
      '',
      '- 置信度高。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: misleadingDStateReport,
        findings: [{
          severity: 'warning',
          title: 'D-state high',
          description: 'main thread D-state 35%',
          evidence: ['state=D pct=35'],
        } as any],
      }),
      query: '分析主线程 D-state 为什么导致卡顿',
      sceneType: 'io',
    });

	  expect(issue?.code).toBe('kernel_blocking_claim_boundary');
	  expect(issue?.message).toContain('不可中断等待');
	});

	it('flags non-IO blocked_function evidence when D-state is claimed as disk IO root cause', () => {
	  const misleadingBlockedFunctionReport = [
	    '# I/O 分析报告',
	    '',
	    '## 综合结论',
	    '',
	    '主线程 D-state 命中 blocked_function=futex_wait_queue，证明磁盘 IO 是本次卡顿根因。',
	    '',
	    '## I/O 证据类型',
	    '',
	    '- state=D blocked_function=futex_wait_queue dur=120ms。',
	    '',
	    '## 文件/数据库/Provider 边界',
	    '',
	    '- 当前没有应用侧补强信息或 Provider 补证。',
	    '',
	    '## 置信度与补证',
	    '',
	    '- 置信度高。',
	  ].join('\n');

	  const issue = assessFinalResultQuality({
	    result: result({
	      conclusion: misleadingBlockedFunctionReport,
	      findings: [{
	        severity: 'warning',
	        title: 'D-state high',
	        description: 'main thread D-state blocked_function=futex_wait_queue',
	        evidence: ['state=D blocked_function=futex_wait_queue dur=120ms'],
	      } as any],
	    }),
	    query: '分析主线程 D-state 为什么导致卡顿',
	    sceneType: 'io',
	  });

	  expect(issue?.code).toBe('kernel_blocking_claim_boundary');
	  expect(issue?.message).toContain('IO/page-cache blocked_function');
	});

	it('flags reports that describe blocked_function as a full kernel call stack', () => {
	  const misleadingBlockedFunctionReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      'blocked_function 是完整内核调用栈，filemap_read -> io_schedule 证明这是完整 off-CPU 调用路径。',
      '',
      '## I/O 证据类型',
      '',
      '- blocked_function=filemap_read+0x508。',
      '',
      '## 文件/数据库/Provider 边界',
      '',
      '- 文件读候选，业务路径未确认。',
      '',
      '## 置信度与补证',
      '',
      '- 需要补采样。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: misleadingBlockedFunctionReport,
        findings: [{
          severity: 'warning',
          title: 'filemap_read wait',
          description: 'main thread blocked_function=filemap_read',
          evidence: ['blocked_function=filemap_read+0x508 dur=120ms'],
        } as any],
      }),
      query: '分析 blocked_function filemap_read 为什么导致卡顿',
      sceneType: 'io',
    });

    expect(issue?.code).toBe('kernel_blocking_claim_boundary');
    expect(issue?.message).toContain('单帧');
  });

  it('accepts io reports that separate evidence class, API boundary, and missing proof', () => {
    const richIoReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      '主线程在窗口内出现 D-state 和 fsync 等待，但当前只能支持 I/O 等待候选，不能直接判定 SQLite 数据库是业务根因。',
      '',
      '## I/O 证据类型',
      '',
      '- 证据类型：D-state 主线程文件 I/O 命中 do_fsync 120ms；block I/O 队列等待可用，page fault 未见明显集中。',
      '',
      '## 文件/数据库/Provider 边界',
      '',
      '- File I/O 有 fsync 证据；SQLite/Room、SharedPreferences/QueuedWork、ContentProvider/CursorWindow/MediaProvider 证据缺失。',
      '- 需要区分路径栈证据和 DB slice；当前不能把 fsync 自动升级为 SQLite 根因。',
      '',
      '## 置信度与补证',
      '',
      '- 置信度中等：D-state/fsync 与卡顿窗口重叠，但业务根因需要 SQLite/数据库 stack 或 provider-side trace 补证。',
      '- 下一步建议采集 Java/native stack、SQLite/Room trace、block I/O 和路径信息。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richIoReport }),
      query: '分析 SQLite fsync 为什么导致卡顿',
      sceneType: 'io',
    })).toBeUndefined();
  });

  it('flags interaction reports that omit ACK, focus/window, and display boundaries', () => {
    const shortInteractionReport = [
      '# 点击响应分析报告',
      '',
      '## 综合结论',
      '',
      '点击响应慢，主要是输入延迟 180ms，需要优化主线程。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortInteractionReport,
        findings: [{
          severity: 'warning',
          title: 'input latency',
          description: 'total_latency_dur=180ms',
          evidence: ['android.input total_latency_dur=180ms'],
        } as any],
      }),
      query: '分析点击响应慢',
      sceneType: 'interaction',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('输入阶段拆分');
    expect(issue?.message).toContain('ACK/焦点/窗口边界');
    expect(issue?.message).toContain('置信度与缺失证据');
  });

  it('accepts interaction reports that separate input stages, queues, and present evidence', () => {
    const richInteractionReport = [
      '# 点击响应分析报告',
      '',
      '## 综合结论',
      '',
      '已完成 ACK 的点击事件平均 dispatch-to-ACK 为 180ms，当前不能直接写成上屏延迟。',
      '',
      '## 输入阶段拆分',
      '',
      '- dispatch=42ms，handling=96ms，ACK/FINISHED=42ms；FrameTimeline present 缺失，因此 display/上屏不适用。',
      '',
      '## ACK/焦点/窗口边界',
      '',
      '- 区分 iq/oq/wq、FINISHED ACK、stale、InputChannel、focused window 和 target window；当前 wait queue/wq 与 stale 日志缺失，不能把它们写成 App 业务根因。',
      '',
      '## 置信度与缺失证据',
      '',
      '- android.input completed-event 可用；dumpsys/logcat、WindowManager/InputDispatcher focus 和 FrameTimeline present 缺失。需要补证后才能提升置信度。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richInteractionReport }),
      query: '分析点击响应慢',
      sceneType: 'interaction',
    })).toBeUndefined();
  });

  it('uses click_response conclusion metadata as the interaction final-report contract', () => {
    const issue = assessFinalResultQuality({
      result: result({
        conclusion: [
          '# 点击响应分析报告',
          '',
          '## 综合结论',
          '',
          '点击响应慢，total_latency_dur=180ms。',
        ].join('\n'),
        findings: [{ severity: 'warning', title: 'input latency', description: '180ms' } as any],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          uncertainties: [],
          nextSteps: [],
          metadata: { sceneId: 'click_response' },
        },
      }),
      query: '分析这个 trace',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('interaction 场景 Final Report Contract');
  });

  it('flags scroll response reports that omit latency scope and frame-linkage confidence', () => {
    const shortScrollResponseReport = [
      '# 滑动响应分析报告',
      '',
      '## 综合结论',
      '',
      '滑动从 ACTION_MOVE 到首帧 120ms，端到端上屏慢，需要优化。',
    ].join('\n');

    const issue = assessFinalResultQuality({
      result: result({
        conclusion: shortScrollResponseReport,
        findings: [{
          severity: 'warning',
          title: 'scroll response latency',
          description: 'response_latency_ms=120',
          evidence: ['scroll_response_latency response_latency_ms=120'],
        } as any],
      }),
      query: '分析滑动响应慢',
      sceneType: 'scroll_response',
    });

    expect(issue?.code).toBe('scene_contract_incomplete');
    expect(issue?.message).toContain('响应延迟口径');
    expect(issue?.message).toContain('输入目标与队列边界');
    expect(issue?.message).toContain('FrameTimeline/上屏置信度');
  });

  it('accepts scroll response reports that state scope, queue boundaries, and frame confidence', () => {
    const richScrollResponseReport = [
      '# 滑动响应分析报告',
      '',
      '## 综合结论',
      '',
      '本次只证明 ACTION_MOVE-to-first-frame 候选响应为 120ms，不能直接写成 panel present。',
      '',
      '## 响应延迟口径',
      '',
      '- 已区分 dispatch-to-ACK、ACTION_MOVE 到 first frame/首帧候选、input-to-present；present 缺失，不能把候选首帧当真实上屏。',
      '',
      '## 输入目标与队列边界',
      '',
      '- target window/focused window、InputChannel、FINISHED ACK、iq/oq/wq 和 stale 均需要额外证据；当前缺失 dumpsys/logcat，因此不能定因窗口队列。',
      '',
      '## FrameTimeline/上屏置信度',
      '',
      '- FrameTimeline frame_id 关联缺失，RenderThread/SF present 链接缺失；当前只可作为 first-frame 候选，置信度中等。',
    ].join('\n');

    expect(assessFinalResultQuality({
      result: result({ conclusion: richScrollResponseReport }),
      query: '分析滑动响应慢',
      sceneType: 'scroll_response',
    })).toBeUndefined();
  });

  it('does not override runtime results that are already marked partial', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: '   ',
        partial: true,
        terminationMessage: 'runtime already degraded this result',
      }),
      query: '分析这个 trace',
    })).toBeUndefined();
  });

  it('still enforces kernel blocking claim boundaries for partial runtime results', () => {
    const issue = assessFinalResultQuality({
      result: result({
        partial: true,
        conclusion: [
          '# I/O 分析报告',
          '',
          '## 综合结论',
          'blocked_function 是完整内核调用栈，filemap_read -> io_schedule 证明这是完整 off-CPU 调用路径。',
          '',
          '## I/O 证据类型',
          '- blocked_function=filemap_read+0x508。',
          '',
          '## 文件/数据库/Provider 边界',
          '- 文件读候选，业务路径未确认。',
          '',
          '## 置信度与补证',
          '- 需要补采样。',
        ].join('\n'),
        findings: [{
          severity: 'warning',
          title: 'filemap_read wait',
          description: 'main thread blocked_function=filemap_read',
          evidence: ['blocked_function=filemap_read+0x508 dur=120ms'],
        } as any],
      }),
      query: '分析 blocked_function filemap_read 为什么导致卡顿',
      sceneType: 'io',
    });

    expect(issue?.code).toBe('kernel_blocking_claim_boundary');
  });

  it('requires every known dual-trace package identity in the deliverable conclusion', () => {
    const issue = assessFinalResultQuality({
      result: result({
        conclusion: [
          '# 双 Trace 对比分析报告',
          '',
          '## 综合结论',
          '',
          '当前侧 com.example.heavy 的主线程阻塞明显高于右侧 demo。',
        ].join('\n'),
      }),
      query: '对比两个 trace 的性能差异',
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    });

    expect(issue?.code).toBe('comparison_identity_incomplete');
    expect(issue?.message).toContain('com.example.demo');
  });

  it('accepts a dual-trace conclusion that explicitly names both package identities', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: [
          '# 双 Trace 对比分析报告',
          '',
          '## 综合结论',
          '',
          '当前侧 com.example.heavy 的主线程阻塞明显高于参考侧 com.example.demo。',
        ].join('\n'),
      }),
      query: '对比两个 trace 的性能差异',
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    })).toBeUndefined();
  });

  it('appends deterministic dual-trace identities when the provider omits them', () => {
    const conclusion = completeFinalResultComparisonIdentity({
      conclusion: '# 双 Trace 对比分析报告\n\n## 综合结论\n\n左侧明显慢于右侧。',
      identity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
      outputLanguage: 'zh-CN',
    });

    expect(conclusion).toContain('## 对比对象');
    expect(conclusion).toContain('`com.example.heavy`');
    expect(conclusion).toContain('`com.example.demo`');
    expect(assessFinalResultQuality({
      result: result({ conclusion }),
      query: '对比两个 trace 的性能差异',
      comparisonIdentity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
    })).toBeUndefined();
  });

  it('leaves a complete dual-trace conclusion unchanged', () => {
    const conclusion = '# Report\n\ncom.example.heavy vs com.example.demo';

    expect(completeFinalResultComparisonIdentity({
      conclusion,
      identity: {
        currentPackageName: 'com.example.heavy',
        referencePackageName: 'com.example.demo',
      },
      outputLanguage: 'en',
    })).toBe(conclusion);
  });

  it('surfaces source-binding downgrades without deleting verified trace conclusions', () => {
    const sourceReference = {
      id: 'source-ref-v1-aaaaaaaaaaaaaaaaaaaaaaaa',
      referenceId: 'lookup-1',
      codebaseId: 'app-source',
      filePath: 'src/main/Foo.kt',
      lookupKind: 'metadata' as const,
    };
    const sourceBoundResult = result({
      conclusion: 'compact verified trace conclusion',
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'Foo.run 与 trace 阻塞事件一致'}],
        clusters: [],
        evidenceChain: [],
        claims: [{
          id: 'claim-1',
          text: 'Foo.run 与 trace 阻塞事件一致',
          references: [{evidenceRefId: 'data:trace-1'}],
        }],
        sourceUseDecision: {
          schemaVersion: 'source_use_decision@1',
          codeAwareMode: 'metadata_only',
          selectedCodebaseIds: ['app-source'],
          status: 'located',
          attemptedTools: ['search_codebase'],
          queriedCodebaseIds: ['app-source'],
          usedCodebaseIds: ['app-source'],
          references: [sourceReference],
        },
        sourceReferences: [sourceReference],
        sourceClaimBindings: [{
          claimId: 'claim-1',
          mechanismStatus: 'corroborated',
          sourceReferenceIds: [sourceReference.id],
          traceEvidenceRefIds: ['data:trace-1'],
        }],
        uncertainties: [],
        nextSteps: [],
      },
      claimSupport: [{
        claimId: 'claim-1',
        kind: 'causal',
        text: 'Foo.run 与 trace 阻塞事件一致',
        anchors: [],
        supportLevel: 'verified',
      }],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{
          claimId: 'claim-1',
          status: 'verified',
          referenceResults: [{evidenceRefId: 'data:trace-1', status: 'matched'}],
        }],
        issues: [],
      },
    });
    sourceBoundResult.sourceUseDecision = sourceBoundResult.conclusionContract!.sourceUseDecision;
    sourceBoundResult.sourceReferences = sourceBoundResult.conclusionContract!.sourceReferences;

    const issue = applyFinalResultQualityGate({
      result: sourceBoundResult,
      query: 'what is Foo.run?',
    });

    expect(issue?.code).toBe('source_claim_binding_invalid');
    expect(sourceBoundResult.partial).toBe(true);
    expect(sourceBoundResult.conclusion).toBe('compact verified trace conclusion');
    expect(sourceBoundResult.claimSupport).toHaveLength(1);
    expect(sourceBoundResult.claimVerificationResult?.status).toBe('passed');
    expect(sourceBoundResult.conclusionContract?.sourceClaimBindings?.[0]?.mechanismStatus)
      .toBe('compatible');
    expect(sourceBoundResult.sourceClaimVerificationResult?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_strength_downgraded'}),
    ]));
  });
});
