// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import {
  findTruncationVerificationIssue,
  isTruncationVerificationIssue,
  recoverInterruptedFinalReport,
  recoverFinalReport,
  repairTruncatedFinalReport,
} from '../runtimeFinalReportRecovery';
import type { AnalysisPlanV3, Hypothesis, PlanPhase } from '../../agentv3/types';
import {assessFinalReportContract} from '../../services/finalReportContractGate';
import {
  analysisDeliveryFingerprint,
  reportRequirementsFingerprint,
  type AnalysisDeliveryContext,
  type AnalysisCompletion,
} from '../../types/analysisDelivery';

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

  it('preserves the exact legacy partial body without certifying a repair', () => {
    const body = '  冷启动 TTID=1912ms\n末尾没有标点也必须保留  ';
    expect(recoverInterruptedFinalReport({
      partialConclusion: body, plan: makePlan(), hypotheses: makeHypotheses(), outputLanguage: 'zh-CN',
    })).toBe(body);
    expect(repairTruncatedFinalReport({
      conclusion: body, plan: makePlan(), hypotheses: makeHypotheses(), outputLanguage: 'zh-CN',
      recoveryKind: 'missing_contract',
      missingContractSections: [{id: 'a', label: 'Summary', recoveryText: {zh: ['invented'], en: ['invented']}}],
    })).toBeUndefined();
  });

  it('dispatches continuation only from typed recovery, not issue names or localized messages', () => {
    for (const message of ['结论文本被截断', 'the conclusion was truncated', '任意诊断文本', '']) {
      expect(isTruncationVerificationIssue({type: 'missing_evidence', message})).toBe(false);
      expect(isTruncationVerificationIssue({type: 'truncation', message})).toBe(false);
      expect(isTruncationVerificationIssue({type: 'missing_reasoning', message, recoveryKind: 'continue_output'})).toBe(true);
    }
    const issue = {type: 'missing_reasoning', recoveryKind: 'continue_output' as const};
    expect(findTruncationVerificationIssue([{type: 'truncation'}, issue])).toBe(issue);
  });

  it.each(['未加标点的最终一句', 'A short answer', '# Heading\n\nThe final sentence has no punctuation', '|a|b|', '```\ncode\n```'])(
    'preserves an interrupted body byte for byte: %s', body => {
      const context = deliveryContext(body, 'incomplete');
      const result = recoverFinalReport({conclusion: body, deliveryContext: context,
        recoveryKind: 'continue_output', outputLanguage: 'zh-CN'});
      expect(result?.conclusion).toBe(body);
      expect(result?.completion).toEqual(context.completion);
      expect(result?.runtimeAppendix).toMatchObject({
        schemaVersion: 1, origin: 'runtime_fallback', sourceCandidate: context.acceptedCandidate, reason: 'output_limit',
      });
      expect(result?.runtimeAppendix.text).toBeTruthy();
      expect(Object.keys(result ?? {}).sort()).toEqual(['completion', 'conclusion', 'runtimeAppendix']);
    },
  );

  it('cannot invent interruption, repair evidence, or promote a stale receipt', () => {
    const body = 'This line ends mid sentence';
    const context = deliveryContext(body, 'completed');
    const input = {conclusion: body, deliveryContext: context, recoveryKind: 'continue_output' as const, outputLanguage: 'en' as const};
    expect(recoverFinalReport(input)).toBeUndefined();
    expect(recoverFinalReport({...input, recoveryKind: 'correct_evidence'})).toBeUndefined();
    for (const mutation of [
      {status: 'unknown' as const}, {status: 'cancelled' as const}, {status: 'failed' as const},
      {status: 'incomplete' as const, runId: 'previous-run'},
      {status: 'incomplete' as const, attemptId: 'previous-attempt'},
      {status: 'incomplete' as const, candidateRef: 'other-candidate'},
      {status: 'incomplete' as const, conclusionFingerprint: analysisDeliveryFingerprint('other body')},
    ]) {
      expect(recoverFinalReport({...input, deliveryContext: {...context,
        completion: {...context.completion!, ...mutation}}})).toBeUndefined();
    }
    expect(recoverFinalReport({...input, deliveryContext: {entry: 'historical_restore'}})).toBeUndefined();
    expect(recoverFinalReport({...input, deliveryContext: {...deliveryContext(body, 'incomplete'),
      outputOrigin: 'runtime_fallback'}})).toBeUndefined();
  });

  it('adds a separate note for bound missing content while keeping the report missing', () => {
    const body = 'The measured value is available without headings';
    const context = deliveryContext(body, 'completed');
    addMissingReportAssessment(context);
    const before = assessFinalReportContract({conclusion: body, context});
    expect(before.status).toBe('failed');
    const result = recoverFinalReport({conclusion: body, deliveryContext: context,
      recoveryKind: 'complete_report_content', outputLanguage: 'en'});
    expect(result?.conclusion).toBe(body);
    expect(result?.completion).toEqual(context.completion);
    expect(result?.runtimeAppendix.origin).toBe('runtime_fallback');
    expect(assessFinalReportContract({conclusion: result!.conclusion, context})).toEqual(before);
  });

  it('cannot invent missing content from labels or an unavailable assessment', () => {
    const body = 'Answer';
    const context = deliveryContext(body, 'completed');
    const input = {conclusion: body, deliveryContext: context, recoveryKind: 'complete_report_content' as const,
      outputLanguage: 'en' as const, missingSections: [{id: 'not-declared', label: 'Invented'}]};
    expect(recoverFinalReport(input)).toBeUndefined();
    addMissingReportAssessment(context);
    expect(recoverFinalReport(input)).toBeUndefined();
    context.reportAssessment!.status = 'unavailable';
    expect(recoverFinalReport({...input, missingSections: undefined})).toBeUndefined();
  });
});

type CurrentContext = Exclude<AnalysisDeliveryContext, {entry: 'historical_restore'}>;

function deliveryContext(body: string, status: AnalysisCompletion['status']): CurrentContext {
  const candidate = {candidateRef: 'candidate-1', runId: 'run-1', attemptId: 'attempt-1',
    conclusionFingerprint: analysisDeliveryFingerprint(body)};
  return {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'pi-agent-core', status,
      ...(status === 'incomplete' ? {reason: 'output_limit'} : {})},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry',
      taskKind: 'investigation', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
      deliverable: 'report', evidenceAccess: 'existing_only'},
    evidenceFingerprint: 'evidence-v1',
  };
}

function addMissingReportAssessment(context: CurrentContext): void {
  context.reportRequirements = {sceneId: 'general', registryFingerprint: 'registry', requirements: [
    {id: 'measurement', label: 'Measurement semantics', description: 'State the unit and denominator', required: true},
  ]};
  context.reportAssessment = {schemaVersion: 1, status: 'checked', binding: {
    ...context.acceptedCandidate!, registryFingerprint: 'registry',
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    conclusionContractFingerprint: analysisDeliveryFingerprint(undefined), evidenceFingerprint: 'evidence-v1',
    requirementsFingerprint: reportRequirementsFingerprint(context.reportRequirements),
  }, requirements: [{requirementId: 'measurement', applicability: 'applicable', coverage: 'missing'}]};
}
