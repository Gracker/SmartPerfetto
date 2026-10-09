// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../../agentRuntime/analysisTurnIntent';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import { buildQuickRunReceipt, resolveQuickTurnBudget } from '../../agentRuntime/quickBudget';
import {sanitizeSourceReference, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';
import {captureEvidenceTable, type CapturedFieldSemantics} from '../evidence/evidenceCapture';
import {prepareClaimEvidence} from '../evidence/claimEvidencePreparation';
import type {EvidenceReadView} from '../evidence/evidenceReadView';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import { runClaimVerification } from '../verifier/claimVerificationRunner';
import {
  applyFinalResultQualityGate,
  completeFinalResultComparisonIdentity,
  assessFinalResultQuality,
  assessFinalResultQualityAssessment,
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


function resolvedIntent(overrides: Partial<AnalysisTurnIntent> = {}): AnalysisTurnIntent {
  return {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-test',
    taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
    recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new', ...overrides};
}

function finalizationContext(target: AnalysisResult): AnalysisDeliveryContext {
  const candidate = {candidateRef: 'candidate-test', runId: 'run-test', attemptId: 'attempt-test',
    conclusionFingerprint: analysisDeliveryFingerprint(target.conclusion)};
  return {entry: 'new_finalization', acceptedCandidate: candidate,
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'claude-agent-sdk', status: 'completed'},
    outputOrigin: 'sdk_final', turnIntent: resolvedIntent()};
}

function assessUnreviewedReport(input: Parameters<typeof assessFinalResultQuality>[0]) {
  const assessment = assessFinalResultQualityAssessment(input);
  expect(assessment.assurance.report).toBe('not_checked');
  return assessment.selectedIssue;
}

function capturedReadView(envelope: DataEnvelope, fields: Record<string, CapturedFieldSemantics>): EvidenceReadView {
  const store = new ArtifactStore();
  store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, fields),
    {meta: envelope.meta, display: envelope.display});
  return store.createEvidenceReadView({ownerKey: 'quality-capture',
    allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}]});
}

async function finalizeWithConsistentSemanticFixture(target: AnalysisResult, envelope: DataEnvelope,
  evidenceReadView: EvidenceReadView, sourceUse?: SourceUseDecisionV1) {
  const runId = 'quality-finalization';
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: runId});
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(target.conclusion)};
  attachFinalizationContext(target, {runId, sessionId: target.sessionId, deadlineMs: Date.now() + 600_000,
    strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a'},
    turnIntent: resolvedIntent({registryFingerprint: registry.registryFingerprint, taskKind: 'fact', evidenceAccess: 'existing_only'}),
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'}},
    evidenceReadView, sourceUse,
    dispatchText: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: target.conclusion.length}]},
      claims: target.conclusionContract?.claims?.map(claim => ({claimId: claim.id, consistency: 'consistent',
        contentLocations: [{start: 0, end: target.conclusion.length, text: target.conclusion}], issues: []})),
      omissions: [], requirements: []})}),
  });
  return finalizeAnalysisResult({result: target, context: takeFinalizationContext(target),
    owner: {runId, signal: new AbortController().signal, isCurrent: () => true, assertAuthorized: () => {}},
    query: 'What does the captured trace show?', dataEnvelopes: [envelope]});
}

describe('final result quality gate', () => {
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
      context: finalizationContext(target),
      query: '分析这个 trace',
    });

    expect(issue?.code).toBe('empty_conclusion');
    expect(target.partial).toBe(true);
    expect(target.confidence).toBe(0.55);
    expect(target.terminationReason).toBe('quality_gate_failed');
    expect(target.terminationMessage).toContain('当前候选没有可交付的正文');
  });

  it('appends the same quality issue only once across repeated projections', () => {
    const target = result({
      conclusion: '',
      partial: true,
      terminationMessage: 'runtime already degraded this result',
    });

    const issues = Array.from({length: 3}, () => applyFinalResultQualityGate({
      result: target,
      context: finalizationContext(target),
      query: '分析 IO 根因',
    }));

    expect(issues.every(issue => issue?.code === 'empty_conclusion')).toBe(true);
    expect(target.terminationMessage).toContain('runtime already degraded this result');
    const issueMessage = issues[0]!.message;
    expect(target.terminationMessage!.split(issueMessage)).toHaveLength(2);
  });

  it('does not infer SDK completion from process-like wording', () => {
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
    })).toBeUndefined();
  });

  it('does not infer SDK completion from missing final-report headings', () => {
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
    })).toBeUndefined();
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
      context: finalizationContext(target),
      query: '这条 trace 的滑动总帧数和 janky frame 数是多少？',
    });

    expect(issue?.code).toBe('verifier_contradicted_claim');
    expect(target.partial).toBe(true);
    expect(issue?.message.trim()).toBeTruthy();
    expect(target.terminationMessage).toBe(issue?.message);
  });

  it('does not reject a deliverable based on quick budget or report headings', () => {
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
      context: finalizationContext(target),
      query: '请完整诊断这次滑动卡顿的根因、优化方案和代码责任链',
    });

    expect(issue).toBeUndefined();
    expect(target.partial).not.toBe(true);
    expect(target.terminationMessage).toBeUndefined();
  });

  it('does not count carried prior-turn claims as current quick-report expansion', () => {
    const claims = Array.from({length: 12}, (_, index) => ({
      id: `claim-carried-${index}`,
      kind: 'numeric' as const,
      text: `上一轮已验证事实 ${index}`,
      references: [{
        evidenceRefId: `data:carried:${index}`,
        column: 'value',
        value: index,
      }],
      relationRefs: [],
    }));
    const target = result({
      conclusion: [
        '## 快速 Triage',
        '',
        '上一轮已经证明目标帧缺少当前 trace 可用的直接归因证据。',
        '',
        '## 逐句数据引用（结构化来源）',
        '',
        '- C1: 复用上一轮已验证的 evidence_ref_id=data:carried:0。',
        '- C2: 本轮没有调用新工具。',
        '- C3: 后续只有新增 trace capability 时才会增加信息。',
      ].join('\n'),
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims,
        uncertainties: [],
        nextSteps: [],
      },
      quickRun: {
        requestedMode: 'auto',
        resolvedMode: 'quick',
        profile: 'triage',
        targetTurns: 5,
        hardCapTurns: 50,
        actualTurns: 1,
        elapsedMs: 1000,
        enforcement: 'turn_cap',
        stopReason: 'answered',
        evidence: {
          frontendPrequeryInjected: 0,
          frontendPrequeryCited: 0,
          currentRunDataEnvelopes: 0,
          citedEvidenceRefs: 3,
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
      },
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: claims.length,
        unsupportedClaimCount: 0,
        claimResults: claims.map(claim => ({claimId: claim.id, status: 'verified'})),
        issues: [],
      },
    });

    expect(assessFinalResultQuality({
      result: target,
      query: '只基于上一轮已经验证的证据回答，不要调用新工具',
    })).toBeUndefined();
  });

  it('keeps report coverage unknown and leaves causal support to the joined claim verification', () => {
    // Relation evaluation of a draft's claimSupport is not a verdict: only the
    // finalizer's claim_verifier@2 join (finite proof plus semantic review) is.
    expect(assessUnreviewedReport({
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
    })).toBeUndefined();

    expect(assessUnreviewedReport({
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
    })).toBeUndefined();

    expect(assessUnreviewedReport({
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
    })).toBeUndefined();

    expect(assessUnreviewedReport({
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
    })).toBeUndefined();

    expect(assessUnreviewedReport({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '分析这个启动 trace',
    })).toBeUndefined();

    expect(assessUnreviewedReport({
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
      // A proven-unsupported claim outranks "the conclusion looks thin": the
      // verifier has a result, and hiding it behind sparseness loses that.
    })?.code).toBe('verifier_contradicted_claim');

    expect(assessUnreviewedReport({
      result: result({
        conclusion: '应用包名是 com.example.demo。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '这个 trace 的应用包名是什么？',
    })).toBeUndefined();

    expect(assessUnreviewedReport({
      result: result({
        conclusion: '最慢函数是 ChaosTask，self_ms=456ms。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '哪个函数最慢？',
    })).toBeUndefined();

    expect(assessUnreviewedReport({
      result: result({
        conclusion: 'TTID=1912ms，主要是主线程模拟负载。',
        findings: [],
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
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
    })).toBeUndefined();

    expect(assessUnreviewedReport({
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
    })).toBeUndefined();
  });

  it('does not count a deterministically verified overlap as causal evidence', async () => {
    const body = 'overlap causes the startup delay';
    const subject = {evidenceRefId: 'data:overlap-only', rowIndex: 0};
    const object = {evidenceRefId: 'data:overlap-only', rowIndex: 1};
    const declaration = parseConclusionContractDeclaration({
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-overlap-is-cause',
        kind: 'causal',
        text: body,
        references: [{
          evidenceRefId: 'data:overlap-only',
          rowIndex: 0,
          column: 'blocked_ms',
          value: 120,
        }],
        relationRefs: ['proposal:overlap-only'],
        // A valid causal declaration is expressible without a native rule that proves it.
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'causal.mechanism',
          polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [subject], objectRefs: [object]}},
      }],
      relationProposals: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'proposal:overlap-only',
        kind: 'overlap',
        direction: 'symmetric',
        subject,
        object,
      }],
      uncertainties: [],
      nextSteps: [],
    });
    expect(declaration.issues).toEqual([]);
    const conclusionContract = declaration.contract;
    if (!conclusionContract) throw new Error('Expected a valid overlap declaration');
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
    const origin = {kind: 'native_producer' as const, definitionFingerprint: 'overlap-fixture'};
    const evidenceReadView = capturedReadView(envelope, {
      ts: {unit: 'ns', timeRole: 'start', clock: 'trace_monotonic', origin},
      dur: {unit: 'ns', timeRole: 'duration', clock: 'trace_monotonic', origin},
      blocked_ms: {unit: 'ms', origin},
    });
    const relationCandidates = conclusionContract.relationProposals;
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, relationCandidates, evidenceReadView});
    const verified = runClaimVerification({
      conclusionContract,
      dataEnvelopes: [envelope],
      relationCandidates,
      preparedEvidence,
    });

    expect(verified.evidenceContract.relations[0].verificationStatus).toBe('verified');
    expect(verified.claimSupport[0].relationEvaluation).toBe('candidate');
    expect(verified.claimVerificationResult.claimResults[0]).toMatchObject({status: 'inference',
      deterministicProof: {kind: 'none', status: 'candidate', reason: 'unsupported_predicate'}});
    // Even a complete, agreeing semantic response cannot turn an overlap into a causal
    // proof: the finalizer asks the join what a perfect review would yield, finds no
    // reachable ✓, and sends no review at all.
    const finalized = await finalizeWithConsistentSemanticFixture(result({
      conclusion: body, conclusionContract,
    }), envelope, evidenceReadView);
    expect(finalized.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'not_required'});
    expect(finalized.result.claimSupport?.[0].relationEvaluation).toBe('candidate');
    expect(finalized.result.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', passed: false,
      status: 'partial', claimResults: [{claimId: 'claim-overlap-is-cause', status: 'partial',
        deterministicProof: {kind: 'none', status: 'candidate', reason: 'unsupported_predicate'}}]});
    expect(finalized.result.deliveryAssurance?.claims).toBe('coverage_incomplete');
  });

  it('does not infer report coverage from legacy prose: flags jank reports that pass evidence checks but omit scene-required sections', () => {
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

    expect(assessUnreviewedReport({
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
    })).toBeUndefined();
  });

  it('does not apply scene final-report contracts to factual scrolling questions', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: '应用包名是 com.example.demo。',
        findings: [],
        conclusionContract: undefined,
      }),
      query: '这个滑动 trace 的应用包名是什么？',
    })).toBeUndefined();
  });

  it('keeps focused follow-up accuracy gates but skips complete-report structure', () => {
    const focused = result({
      conclusion: [
        '最值得先修的是主线程同步 UI 工作。',
        '',
        '1. batch_frame_root_cause 显示主要掉帧与 UI→RenderThread 同步等待重叠。',
        '2. 代表帧的 Binder 与 Monitor 锁重叠均为 0ms，因此不应优先优化 Binder/锁。',
        '',
        '以上只复用上一轮已验证证据，没有重新扫描 trace。',
      ].join('\n'),
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [{conclusionId: 'c1', text: '复用上一轮 scrolling_analysis 证据'}],
        claims: [{
          id: 'claim-focus',
          text: '优先减少主线程同步 UI 工作',
          references: [{evidenceRefId: 'data:scrolling:prior'}],
        }],
        uncertainties: [],
        nextSteps: [],
        metadata: {sceneId: 'scrolling'},
      },
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{claimId: 'claim-focus', status: 'verified'}],
        issues: [],
      },
    });

    expect(assessFinalResultQuality({
      result: focused,
      query: '只基于上一轮证据回答，不要重新做全量分析',
    })).toBeUndefined();
  });

  it('records a quality-specific termination reason for a quality-only downgrade', () => {
    const qualityOnly = result({
      conclusion: '',
      terminationReason: undefined,
    });
    expect(applyFinalResultQualityGate({
      result: qualityOnly,
      context: finalizationContext(qualityOnly),
      query: '分析这个 trace',
    })).toBeDefined();
    expect(qualityOnly.partial).toBe(true);
    expect(qualityOnly.terminationReason).toBe('quality_gate_failed');
  });

  it('keeps pre-finalization drafts unmutated without a prose-length gate', () => {
    const pending = result({
      conclusion: '基于 120Hz，每帧预算约为 8.33ms。',
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims: [],
        uncertainties: [],
        nextSteps: [],
      },
      claimSupport: undefined,
      claimVerificationResult: undefined,
    });

    expect(applyFinalResultQualityGate({
      result: pending,
      context: {entry: 'runtime_draft'},
      query: '只基于上一条回答，不要重新分析',
    })).toBeUndefined();
    expect(pending.partial).not.toBe(true);

    expect(applyFinalResultQualityGate({
      result: pending,
      context: {entry: 'runtime_draft'},
      query: '只基于上一条回答，不要重新分析',
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: does not accept empty mentions as satisfying scene-required sections', () => {
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

    const issue = assessUnreviewedReport({
      result: result({
        conclusion: hollowReport,
        findings: [{ severity: 'critical', title: '长任务', description: 'CPU heavy', evidence: ['98.4%'] } as any],
      }),
      query: '分析滑动性能',
    });

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: uses conclusion contract scene metadata when the query is generic', () => {
    const issue = assessUnreviewedReport({
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

    expect(issue).toBeUndefined();
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

  it('does not infer report coverage from legacy prose: flags pipeline reports that omit rendering-stage and BufferQueue/Fence boundaries', () => {
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

    const issue = assessUnreviewedReport({
      result: result({
        conclusion: hollowPipelineReport,
        findings: [{ severity: 'warning', title: '管线边界缺失', description: 'no details', evidence: ['BufferQueue'] } as any],
      }),
      query: '分析渲染管线 BufferQueue fence',
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: routes pure graphics-memory pipeline gaps to the graphics boundary instead of BufferQueue/Fence', () => {
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

    const issue = assessUnreviewedReport({
      result: result({ conclusion: graphicsReportWithoutBoundary }),
      query: 'GraphicBuffer dma-buf 图形内存证据怎么分析',
    });

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags HWC/SF overlay pipeline reports that omit the conditional boundary', () => {
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

    const issue = assessUnreviewedReport({
      result: result({ conclusion: reportWithoutPolicyBoundary }),
      query: 'HWC overlay 怎么分析',
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags network reports that omit request-stage evidence boundaries', () => {
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

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags generic slow-network reports that omit packet-vs-request boundaries', () => {
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

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: rejects hollow network request-stage boundary mentions', () => {
    const hollowReport = [
      '# 网络分析报告',
      '',
      '## 请求阶段证据边界',
      '',
      '这里缺少 DNS/TLS/TTFB 的证据边界。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags network stack-policy reports that omit version and config boundaries', () => {
    const shortStackReport = [
      '# 网络分析报告',
      '',
      '## 综合结论',
      '',
      'Android 17 ECH 和 local network permission 导致请求失败。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags power reports that omit Job/Work/FGS governance boundaries for job quota questions', () => {
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

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags power reports that omit Alarm/Wakeup/Vitals boundaries for alarm and wakelock questions', () => {
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

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags memory reports that omit evidence scope and memory-type boundaries', () => {
    const shortMemoryReport = [
      '# 内存分析报告',
      '',
      '## 综合结论',
      '',
      'PSS 持续上涨，可能存在泄漏，需要优化内存。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags startup reports that omit user-requested diagnostic API boundaries', () => {
    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags memory reports that omit user-requested diagnostic API boundaries', () => {
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

    const issue = assessUnreviewedReport({
      result: result({ conclusion: richWithoutDiagnosticBoundary }),
      query: '用 ApplicationExitInfo REASON_LOW_MEMORY 和 ProfilingManager heap dump 分析 OOM',
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags ANR reports that omit user-requested diagnostic API boundaries', () => {
    const shortAnrReport = [
      '# ANR 分析报告',
      '',
      '## 综合结论',
      '',
      'ANR 发生在 5000ms 输入窗口，main thread Q4 Sleeping=82%，direct_blocker 是 Binder wait 1200ms。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags io reports that turn fsync into database root cause without boundaries', () => {
    const shortIoReport = [
      '# I/O 分析报告',
      '',
      '## 综合结论',
      '',
      '主线程 fsync 很慢，所以数据库是根因，需要优化 DB。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags interaction reports that omit ACK, focus/window, and display boundaries', () => {
    const shortInteractionReport = [
      '# 点击响应分析报告',
      '',
      '## 综合结论',
      '',
      '点击响应慢，主要是输入延迟 180ms，需要优化主线程。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: uses click_response conclusion metadata as the interaction final-report contract', () => {
    const issue = assessUnreviewedReport({
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

    expect(issue).toBeUndefined();
  });

  it('does not infer report coverage from legacy prose: flags scroll response reports that omit latency scope and frame-linkage confidence', () => {
    const shortScrollResponseReport = [
      '# 滑动响应分析报告',
      '',
      '## 综合结论',
      '',
      '滑动从 ACTION_MOVE 到首帧 120ms，端到端上屏慢，需要优化。',
    ].join('\n');

    const issue = assessUnreviewedReport({
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
    });

    expect(issue).toBeUndefined();
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
    })).toBeUndefined();
  });

  it('still checks empty conclusions in results already marked partial', () => {
    expect(assessFinalResultQuality({
      result: result({
        conclusion: '   ',
        partial: true,
        terminationMessage: 'runtime already degraded this result',
      }),
      query: '分析这个 trace',
    })?.code).toBe('empty_conclusion');
  });

  it('does not require package strings as a substitute for identity evidence', () => {
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

    expect(issue).toBeUndefined();
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

  // SP-CP-11: a runtime-inferred package is a hypothesis. Evidence resolving
  // another process must not fail the identity gate, and an appended identity
  // section must not present it as the authoritative target.
  it('never enforces or presents an auto-detected package as an expected comparison identity', () => {
    const resolution = (side: 'current' | 'reference', name: string) => ({
      version: 'identity_contract@1' as const, identityRefId: `identity-${side}`, status: 'verified' as const,
      target: {traceId: `trace-${side}`, traceSide: side, packageName: name, source: 'user_param' as const},
      processes: [{upid: 1, packageName: name, matchSources: ['process' as const], confidence: 1}],
      threads: [], warnings: [],
    });
    const identity = {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
      currentPackageName: 'com.inferred.current', referencePackageName: 'com.inferred.reference',
      currentResolution: resolution('current', 'com.actual.current'),
      referenceResolution: resolution('reference', 'com.actual.reference')};
    const assess = (sources: {currentPackageSource?: 'user' | 'auto_detected'; referencePackageSource?: 'user' | 'auto_detected'}) =>
      assessFinalResultQualityAssessment({result: result({conclusion: 'Left is slower.'}),
        comparisonIdentity: {...identity, ...sources}}).assurance.identity;

    expect(assess({currentPackageSource: 'auto_detected', referencePackageSource: 'auto_detected'})).toBe('passed');
    expect(assess({currentPackageSource: 'user', referencePackageSource: 'auto_detected'})).toBe('failed');
    // No provenance means an authoritative package (user or evidence pack).
    expect(assess({})).toBe('failed');

    const conclusion = completeFinalResultComparisonIdentity({
      conclusion: '左侧明显慢于右侧。',
      identity: {currentPackageName: 'com.user.app', referencePackageName: 'com.inferred.reference',
        currentPackageSource: 'user', referencePackageSource: 'auto_detected'},
      outputLanguage: 'zh-CN',
    });
    expect(conclusion).toContain('- 当前侧包名: `com.user.app`');
    expect(conclusion).toContain('- 参考侧包名（运行时推断）: `com.inferred.reference`');
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

  it('delivers a locate-only source claim unverified without failing or deleting verified trace conclusions', async () => {
    const sourceReference = sanitizeSourceReference({
      referenceId: 'lookup-1',
      codebaseId: 'app-source',
      filePath: 'src/main/Foo.kt',
      lookupKind: 'metadata' as const,
    })!;
    const sourceUse: SourceUseDecisionV1 = {
      schemaVersion: 'source_use_decision@1',
      codeAwareMode: 'metadata_only',
      selectedCodebaseIds: ['app-source'],
      status: 'located',
      attemptedTools: ['search_codebase'],
      queriedCodebaseIds: ['app-source'],
      usedCodebaseIds: ['app-source'],
      references: [sourceReference],
    };
    const body = 'The trace reports 120 ms blocked.';
    const reference = {evidenceRefId: 'data:trace-1', rowIndex: 0, column: 'blocked_ms', value: 120};
    const declaration = parseConclusionContractDeclaration({
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [{rank: 1, statement: body}],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        kind: 'numeric',
        text: body,
        references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [reference]},
          numeric: {operator: 'eq', value: 120, unit: 'ms'}},
      }],
      sourceUseDecision: sourceUse,
      sourceReferences: [sourceReference],
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['data:trace-1'],
      }],
      uncertainties: [],
      nextSteps: [],
    });
    expect(declaration.issues).toEqual([]);
    const sourceBoundResult = result({conclusion: body, conclusionContract: declaration.contract});
    const envelope = createDataEnvelope({columns: ['blocked_ms'], rows: [[120]]}, {
      type: 'sql_result', source: 'execute_sql', title: 'Trace blocking duration',
      evidenceRefId: 'data:trace-1', traceId: 'trace-a', traceSide: 'current', executionStatus: 'observed',
    });
    const evidenceReadView = capturedReadView(envelope, {
      blocked_ms: {unit: 'ms', origin: {kind: 'native_producer', definitionFingerprint: 'blocking-fixture'}},
    });
    const finalized = await finalizeWithConsistentSemanticFixture(sourceBoundResult, envelope, evidenceReadView, sourceUse);
    const verifiedResult = finalized.result;

    // Weaker than linked is unverified (`~`), not a failed gate: only an invalid reference fails.
    expect(finalized.qualityIssue?.code).not.toBe('source_claim_binding_invalid');
    expect(verifiedResult.partial).not.toBe(true);
    expect(verifiedResult.conclusion).toBe(body);
    expect(verifiedResult.claimSupport).toHaveLength(1);
    expect(verifiedResult.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'passed',
      passed: true, claimResults: [{claimId: 'claim-1', status: 'verified', deterministicProof: {status: 'proved'}}]});
    expect(verifiedResult.deliveryAssurance).toMatchObject({claims: 'passed', source: 'coverage_incomplete'});
    expect(verifiedResult.conclusionContract?.claims).toEqual(sourceBoundResult.conclusionContract?.claims);
    // The retired declared status is dropped at parse; the product computes the claim's standing.
    expect(verifiedResult.conclusionContract?.sourceClaimBindings?.[0]).not.toHaveProperty('mechanismStatus');
    expect(verifiedResult.sourceClaimVerificationResult).toMatchObject({schemaVersion: 'source_claim_verifier@2',
      status: 'partial', claims: [{claimId: 'claim-1', status: 'location_only'}]});
    expect(verifiedResult.sourceClaimVerificationResult?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_claim_location_only', severity: 'warning'}),
    ]));
  });
});

describe('quick-run triage budget follows the question boundary', () => {
  const BOUNDED_FOLLOW_UP = '刚才那个最慢的帧，主线程具体在哪个 slice 上耗时最多？';
  const SCENE_WIDE = '这个 trace 滑动为什么卡？';

  /** A scoped, fully cited drill answer that exceeds the triage char budget. */
  const boundedAnswer = [
    '**直接结论**：那一帧里主线程耗时最多的是 `CustomScrollAdapter_continuousLoad`（24.82ms）。',
    '',
    '| 主线程 slice | 耗时 (ms) |',
    '|---|---|',
    '| CustomScrollAdapter_continuousLoad | 24.82 |',
    '| Choreographer#doFrame 2199798 | 1.41 |',
    '',
    '补充口径：全 trace 主线程单次执行最长 slice 确为 continuousLoad 24.82ms。',
    'x'.repeat(2000),
    '',
    '## 逐句数据引用（结构化来源）',
    '- C1: 主线程最长 slice 为 CustomScrollAdapter_continuousLoad 24.82ms',
    '  - evidence_ref_id=data:sql_table:current:abc123:def456:aaa111; column=dur_ms; value=24.82',
  ].join('\n');

  function quickReceiptFor(query: string, conversationTurns: number, scope: 'bounded_question' | 'scene_wide' = 'bounded_question') {
    return buildQuickRunReceipt({
      requestedMode: 'auto',
      query,
      turnIntent: resolvedIntent({scope}),
      budget: resolveQuickTurnBudget(),
      actualTurns: 3,
      elapsedMs: 1200,
      stopReason: 'answered',
      evidence: {currentRunDataEnvelopes: 3, citedEvidenceRefs: 3},
      contextInjected: {conversationTurns},
      verifierStatus: 'passed',
    });
  }

  it('does not flag a bounded follow-up drill as an over-expanded quick report', () => {
    // Regression: the word 慢 alone used to force the triage profile, which
    // capped this answer at the triage budget and marked the run partial.
    expect(quickReceiptFor(BOUNDED_FOLLOW_UP, 2).profile).toBe('normal');
    expect(assessFinalResultQuality({
      result: result({
        conclusion: boundedAnswer,
        quickRun: quickReceiptFor(BOUNDED_FOLLOW_UP, 2),
      }),
      query: BOUNDED_FOLLOW_UP,
    })?.code).not.toBe('quick_full_report_shape');
  });

  it('keeps scene-wide triage telemetry separate from output acceptance', () => {
    expect(quickReceiptFor(SCENE_WIDE, 2, 'scene_wide').profile).toBe('triage');
    expect(assessFinalResultQuality({
      result: result({
        conclusion: boundedAnswer,
        quickRun: quickReceiptFor(SCENE_WIDE, 2, 'scene_wide'),
      }),
      query: SCENE_WIDE,
    })).toBeUndefined();
  });

  it('does not infer scene-wide scope from missing conversation history', () => {
    expect(quickReceiptFor(BOUNDED_FOLLOW_UP, 0).profile).toBe('normal');
  });
});

describe('unverified claims are not contradicted claims (Round 60 SP-E2E-09)', () => {
  const claimAssessment = (verification: Record<string, unknown>) => {
    const target = result({claimVerificationResult: verification as never});
    return assessFinalResultQualityAssessment({result: target, context: finalizationContext(target)});
  };
  const v2 = (overrides: Record<string, unknown>) => ({schemaVersion: 'claim_verifier@2', policy: 'record_only',
    passed: false, ...overrides});

  it('keeps an ineligible declaration with zero checked claims out of the contradiction gate', () => {
    // r60lockf_a1 / r60therf_a1 / r60wechat_a1 shape after classification
    const assessment = claimAssessment(v2({status: 'partial', checkedClaimCount: 0, unsupportedClaimCount: 0,
      notCheckedReason: 'invalid_declarations',
      claimResults: ['c1', 'c2'].map(claimId => ({claimId, status: 'not_checked', referenceCells: [{status: 'ineligible'}],
        deterministicProof: {kind: 'numeric_cell', status: 'not_checked', reason: 'binding_ineligible', anchorIds: [], evidenceRefIds: []}})),
      issues: ['c1', 'c2'].map(claimId => ({claimId, severity: 'warning', code: 'binding_ineligible', message: 'not admitted'}))}));
    expect(assessment.issues.map(issue => issue.code)).not.toContain('verifier_contradicted_claim');
    expect(assessment.assurance.claims).toBe('coverage_incomplete');
  });

  it('keeps unreadable evidence warnings out of the gate but still fails a real value mismatch', () => {
    const unreadable = {claimId: 'readable-later', status: 'partial', referenceCells: [{status: 'not_checked', message: 'display_transformation_unmapped'}]};
    const quiet = claimAssessment(v2({status: 'partial', checkedClaimCount: 1, unsupportedClaimCount: 0,
      claimResults: [unreadable],
      issues: [{claimId: 'readable-later', severity: 'warning', code: 'claim_reference_unverified', message: 'display_transformation_unmapped'}]}));
    expect(quiet.issues.map(issue => issue.code)).not.toContain('verifier_contradicted_claim');

    // r60anrst_a2 shape: 35 partial claims and one real mismatch still fail the gate
    const mismatch = claimAssessment(v2({status: 'failed', checkedClaimCount: 2, unsupportedClaimCount: 1,
      claimResults: [unreadable, {claimId: 'cl-render', status: 'unsupported', referenceCells: [{status: 'matched'}, {status: 'value_mismatch'}]}],
      issues: [{claimId: 'readable-later', severity: 'warning', code: 'claim_reference_unverified', message: 'display_transformation_unmapped'},
        {claimId: 'cl-render', severity: 'error', code: 'claim_reference_value_mismatch', message: 'value mismatch for ts'}]}));
    expect(mismatch.selectedIssue?.code).toBe('verifier_contradicted_claim');
    expect(mismatch.selectedIssue?.message).toBe('1 条断言的引用值与证据不符；不能作为已核验结论交付。');
    expect(mismatch.assurance.claims).toBe('failed');
  });
});

describe('a contradicted claim degrades full mode, not only quick mode', () => {
  function verification(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'claim_verifier@1',
      status: 'failed',
      policy: 'record_only',
      passed: false,
      checkedClaimCount: 2,
      unsupportedClaimCount: 1,
      claimResults: [
        {
          claimId: 'claim-dur',
          status: 'unsupported',
          referenceResults: [{
            evidenceRefId: 'data:sql_table:current:a:b:c',
            status: 'value_mismatch',
            message: 'value mismatch for dur_ms',
          }],
        },
        {claimId: 'claim-ok', status: 'verified', referenceResults: []},
      ],
      issues: [{
        claimId: 'claim-dur',
        severity: 'error',
        code: 'claim_reference_value_mismatch',
        message: 'value mismatch for dur_ms',
      }],
      ...overrides,
    };
  }

  it('refuses to deliver a full-mode conclusion whose number the data contradicts', () => {
    // Full mode is the authoritative surface — report, snapshot and comparison
    // all reuse it. Proving a number wrong and shipping it anyway makes the
    // verification pointless.
    const issue = assessFinalResultQuality({
      result: result({claimVerificationResult: verification() as never}),
      query: '分析这个启动 trace',
    });

    expect(issue?.code).toBe('verifier_contradicted_claim');
    expect(issue?.message).toContain('引用值与证据不符');
  });

  it('names an absent reference differently from a numeric disagreement', () => {
    const issue = assessFinalResultQuality({
      result: result({
        claimVerificationResult: verification({
          claimResults: [{
            claimId: 'claim-dur',
            status: 'unsupported',
            referenceResults: [{
              evidenceRefId: 'data:sql_table:current:a:b:c',
              status: 'missing',
              message: 'no value was found for dur_ms in the referenced evidence',
            }],
          }],
          issues: [{claimId: 'claim-dur', severity: 'error', code: 'claim_reference_missing',
            message: 'no value was found for dur_ms in the referenced evidence'}],
        }) as never,
      }),
      query: '分析这个启动 trace',
    });

    expect(issue?.code).toBe('verifier_contradicted_claim');
    expect(issue?.message).toContain('未找到');
  });

  function failedDiagnostic(overrides: Record<string, unknown>): string {
    const issue = assessFinalResultQuality({result: result({claimVerificationResult: verification(overrides) as never})});
    expect(issue?.code).toBe('verifier_contradicted_claim');
    return issue!.message;
  }

  it.each(['Evidence rows are missing', '引用值与证据不符', 'بيانات غير متاحة'])(
    'describes rejected declarations from typed state rather than diagnostic prose: %s', message => {
      const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', checkedClaimCount: 0, unsupportedClaimCount: 0,
        claimResults: [{claimId: 'declaration', status: 'not_checked',
          referenceCells: [{status: 'missing', message}],
          deterministicProof: {kind: 'none', status: 'rejected', reason: 'binding_ineligible', anchorIds: [], evidenceRefIds: []}}],
        issues: [{claimId: 'declaration', severity: 'error', code: 'binding_ineligible', message}]});
      expect(text).toBe('1 条断言的声明或绑定无效，相关断言未通过核验准入；不能作为已核验结论交付。');
    },
  );

  it('distinguishes a rejected proposition from absent or mismatched reference cells', () => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [{claimId: 'numeric', status: 'unsupported',
      referenceCells: [{status: 'matched'}],
      deterministicProof: {kind: 'numeric_cell', status: 'rejected', reason: 'numeric_operator_rejected', anchorIds: [], evidenceRefIds: []}}],
      issues: [{claimId: 'numeric', severity: 'error', code: 'numeric_operator_rejected', message: 'arbitrary provider wording'}]});
    expect(text).toBe('1 条断言的命题未通过确定性证明；不能作为已核验结论交付。');
  });

  it.each(['proof', 'reference'])('recognizes a typed binding rejection from %s without prose or issue hints', source => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', unsupportedClaimCount: 0, checkedClaimCount: 0,
      claimResults: [{claimId: 'binding', status: 'not_checked',
        referenceCells: [{status: source === 'reference' ? 'ineligible' : 'missing'}],
        ...(source === 'proof' ? {deterministicProof: {kind: 'none', status: 'rejected', reason: 'binding_ineligible',
          anchorIds: [], evidenceRefIds: []}} : {})}], issues: []});
    expect(text).toBe('1 条断言的声明或绑定无效，相关断言未通过核验准入；不能作为已核验结论交付。');
  });

  it.each(['', 'unassociated-claim'])('does not let global binding issue %s hide another claim failure', claimId => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [
      {claimId: 'absent', status: 'unsupported', referenceCells: [{status: 'missing'}]},
      {claimId: 'different', status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]},
    ], issues: [{claimId, severity: 'error', code: 'binding_ineligible', message: 'Rows are missing'}]});
    expect(text).toContain('声明或绑定校验存在未关联到具体断言的错误');
    expect(text).toContain('1 条断言的引用未找到所需证据');
    expect(text).toContain('1 条断言的引用值与证据不符');
    expect(text).not.toContain('条断言的声明或绑定无效');
  });

  it('suppresses only the bound claim compatibility missing status and preserves genuine mismatches', () => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [
      {claimId: 'bound', status: 'not_checked', referenceCells: [{status: 'missing'}, {status: 'value_mismatch'}]},
      {claimId: 'absent', status: 'unsupported', referenceCells: [{status: 'missing'}]},
    ], issues: [{claimId: 'bound', severity: 'error', code: 'binding_ineligible', message: 'arbitrary'},
      {claimId: 'bound', severity: 'error', code: 'claim_reference_value_mismatch', message: 'arbitrary'}]});
    expect(text).toContain('1 条断言的声明或绑定无效');
    expect(text).toContain('1 条断言的引用未找到所需证据');
    expect(text).toContain('1 条断言的引用值与证据不符');
    expect(text).not.toContain('2 条断言');
  });

  it.each([{referenceCells: []}, {referenceCells: [{status: 'matched'}]}])(
    'prefers present v2 referenceCells $referenceCells over compatibility aliases', ({referenceCells}) => {
      const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [{claimId: 'numeric', status: 'unsupported',
        referenceCells, referenceResults: [{status: 'missing'}, {status: 'value_mismatch'}],
        deterministicProof: {kind: 'numeric_cell', status: 'rejected', reason: 'numeric_operator_rejected', anchorIds: [], evidenceRefIds: []}}],
        issues: [{claimId: 'numeric', severity: 'error', code: 'numeric_operator_rejected', message: 'arbitrary'}]});
      expect(text).toBe('1 条断言的命题未通过确定性证明；不能作为已核验结论交付。');
    },
  );

  it('falls back to absent v2 referenceCells and counts claim IDs without duplicate reference inflation', () => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [{claimId: 'numeric', status: 'unsupported',
      referenceResults: [{status: 'value_mismatch'}, {status: 'value_mismatch'}]}]});
    expect(text).toBe('1 条断言的引用值与证据不符；不能作为已核验结论交付。');
  });

  it('keeps advisory reference findings out of the message and names only recorded failures', () => {
    // rooted_anr_input_a1 shape: warning-level mismatches on partial claims plus an undeclared assertion.
    const undeclaredOnly = failedDiagnostic({schemaVersion: 'claim_verifier@2', unsupportedClaimCount: 0, claimResults: [
      {claimId: 'c1', status: 'partial', referenceCells: [{status: 'matched'}, {status: 'value_mismatch'}]},
      {claimId: 'c2', status: 'partial', referenceCells: [{status: 'missing'}]},
    ], issues: [
      {claimId: 'c1', severity: 'warning', code: 'claim_reference_value_mismatch', message: 'value mismatch for ts'},
      {claimId: 'c2', severity: 'warning', code: 'claim_reference_missing', message: 'no captured value'},
      {claimId: '', severity: 'error', code: 'semantic_undeclared_claim', message: 'arbitrary'},
    ]});
    expect(undeclaredOnly).toBe('正文包含未声明的断言；不能作为已核验结论交付。');
    // A semantic contradiction does not turn its advisory reference mismatch into an evidence mismatch.
    const semantic = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [
      {claimId: 'c1', status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]},
    ], issues: [
      {claimId: 'c1', severity: 'warning', code: 'claim_reference_value_mismatch', message: 'value mismatch for ts'},
      {claimId: 'c1', severity: 'error', code: 'semantic_numeric_mismatch', message: 'arbitrary'},
    ]});
    expect(semantic).toBe('1 条断言的正文表述与其声明不一致；不能作为已核验结论交付。');
  });

  it('classifies semantic review inconsistencies per claim and body omissions', () => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', claimResults: [
      {claimId: 'c:ttid', status: 'unsupported', referenceCells: [{status: 'matched'}]},
    ], issues: [
      {claimId: 'c:ttid', severity: 'error', code: 'semantic_numeric_mismatch', message: 'arbitrary'},
      {claimId: 'c:ttid', severity: 'error', code: 'semantic_scope_mismatch', message: 'arbitrary'},
      {claimId: '', severity: 'error', code: 'semantic_undeclared_claim', message: 'arbitrary'},
    ]});
    expect(text).toBe('1 条断言的正文表述与其声明不一致；正文包含未声明的断言；不能作为已核验结论交付。');
  });

  it('describes unclassified failure without inventing a count or missing evidence', () => {
    const text = failedDiagnostic({schemaVersion: 'claim_verifier@2', checkedClaimCount: 0, unsupportedClaimCount: 9,
      claimResults: [], issues: [{claimId: '', severity: 'error', code: 'unknown_error_code', message: '引用的证据行或列未找到'}]});
    expect(text).toBe('断言核验存在未通过的检查，具体原因尚未归类；不能作为已核验结论交付。');
  });

  it('leaves a passing verification alone', () => {
    expect(assessFinalResultQuality({
      result: result({
        claimVerificationResult: verification({
          status: 'passed',
          passed: true,
          unsupportedClaimCount: 0,
          claimResults: [{claimId: 'claim-ok', status: 'verified', referenceResults: []}],
          issues: [],
        }) as never,
      }),
      query: '分析这个启动 trace',
    })?.code).not.toBe('verifier_contradicted_claim');
  });
});
