// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Runtime delivery diagnostics shared by the five agent engines.
 * Only server-owned terminal receipts, submitted obligations and explicitly
 * bound report assessments are evaluated here. Content meaning and evidence
 * support belong to the shared final semantic assessment and finalizer.
 */

import type {Finding} from '../../../agent/types';
import type {VerificationResult, VerificationIssue, AnalysisPlanV3, Hypothesis} from '../../../agentv3/types';
import {formatExpectedCall} from '../../../agentv3/types';
import {getPhaseToolEvidenceStatus} from '../../../agentv3/planToolCallRecorder';
import {getAnalysisPlanCompletionStatus} from '../../../agentv3/planCompletionStatus';
import {hasValidPlanSkipDisposition} from '../../../agentv3/planPhaseSemantics';
import {DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage} from '../../../agentv3/outputLanguage';
import {assessFinalReportContract} from '../../../services/finalReportContractGate';
import {sameAnalysisCandidate, type AnalysisDeliveryContext} from '../../../types/analysisDelivery';
import {renderRequiredLocalizedStrategyTemplate} from '../../../agentv3/localizedStrategyTemplate';
import {isProductionAgentRuntimeKind} from '../../runtimeKinds';

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonemptyString(value);
}

/** Reject malformed state; replacing a damaged log with [] would hide its provenance. */
function validSubmittedPlanShape(plan: AnalysisPlanV3): boolean {
  return typeof plan === 'object' && Array.isArray(plan.phases) && plan.phases.length > 0 &&
    plan.phases.every(phase => phase && typeof phase === 'object' &&
      nonemptyString(phase.id) && nonemptyString(phase.name) && nonemptyString(phase.goal) &&
      ['pending', 'in_progress', 'completed', 'skipped'].includes(phase.status) &&
      (phase.expectedTools === undefined || (Array.isArray(phase.expectedTools) && phase.expectedTools.every(nonemptyString))) &&
      (phase.expectedCalls === undefined || (Array.isArray(phase.expectedCalls) && phase.expectedCalls.every(call =>
        call && typeof call === 'object' && nonemptyString(call.tool) && optionalString(call.skillId))))) &&
    Array.isArray(plan.toolCallLog) && plan.toolCallLog.every(call => call && typeof call === 'object' &&
      nonemptyString(call.toolName) && typeof call.timestamp === 'number' && Number.isFinite(call.timestamp) &&
      (call.success === undefined || typeof call.success === 'boolean') &&
      optionalString(call.toolCallId) && optionalString(call.matchedPhaseId) &&
      // Failed requests may retain an invalid (including empty) string skill argument.
      // That is an auditable outcome, not a malformed receipt or successful evidence.
      (call.skillId === undefined || typeof call.skillId === 'string'));
}

/**
 * Verify plan adherence — check if Claude completed all planned phases.
 * Returns issues for skipped phases that weren't explicitly marked as skipped.
 */
export function verifyPlanAdherence(plan: AnalysisPlanV3 | null): VerificationIssue[] {
  if (plan === null || plan === undefined) return [];
  if (!validSubmittedPlanShape(plan)) {
    return [{type: 'plan_deviation', severity: 'error', message: 'Submitted plan structure is invalid.'}];
  }
  const completion = getAnalysisPlanCompletionStatus(plan);
  if (!Array.isArray(plan.phases) || plan.phases.length === 0 ||
    (completion.hasPlan && !completion.complete && completion.pendingPhases.length === 0)) {
    return [{type: 'plan_deviation', severity: 'error', message: 'Submitted plan structure is invalid.'}];
  }
  const issues: VerificationIssue[] = [];
  for (const phase of plan.phases) {
    const evidence = getPhaseToolEvidenceStatus(plan, phase);
    const missing = [
      ...evidence.missingExpectedCalls.map(formatExpectedCall),
      ...evidence.missingExpectedTools,
    ];
    if (phase.status === 'skipped') {
      const validDisposition = hasValidPlanSkipDisposition(plan, phase);
      if (!validDisposition || missing.length > 0) {
        issues.push({
          type: 'plan_deviation', severity: validDisposition ? 'warning' : 'error',
          message: `Phase "${phase.name}" (${phase.id}) is skipped (${phase.skipDisposition?.kind ?? 'missing disposition'}); unresolved calls: ${missing.join(', ') || 'none'}. Skipping is not successful evidence.`,
        });
      }
      continue;
    }
    if (!evidence.satisfied || phase.status !== 'completed') {
      issues.push({
        type: 'plan_deviation', severity: evidence.satisfied ? 'warning' : 'error',
        message: `Phase "${phase.name}" (${phase.id}) status=${phase.status}; missing successful phase-bound calls: ${missing.join(', ') || 'none'}.`,
      });
    }
  }
  return issues;
}

/** Hypothesis lifecycle is explicit; its wording cannot resolve or reject it. */
export function verifyHypotheses(hypotheses: Hypothesis[]): VerificationIssue[] {
  if (!Array.isArray(hypotheses) || hypotheses.some(hypothesis => !hypothesis ||
    typeof hypothesis !== 'object' || !nonemptyString(hypothesis.id) || !nonemptyString(hypothesis.statement) ||
    !['formed', 'confirmed', 'rejected'].includes(hypothesis.status)) ||
    new Set(hypotheses.map(hypothesis => hypothesis.id)).size !== hypotheses.length) {
    return [{type: 'unresolved_hypothesis', severity: 'error', message: 'Hypothesis state is invalid.'}];
  }
  const unresolved = hypotheses.filter(hypothesis => hypothesis.status === 'formed');
  if (unresolved.length === 0) return [];
  return [{type: 'unresolved_hypothesis', severity: 'error',
    message: `Unresolved hypothesis state: ${unresolved.map(hypothesis => hypothesis.id).join(', ')}.`}];
}

/**
 * Compatibility helper for callers migrating to terminal receipts. Text alone
 * establishes only an empty body; style cannot establish SDK completion.
 */
export function isConclusionIncomplete(
  conclusion: string,
  context?: AnalysisDeliveryContext,
): boolean {
  if (!conclusion.trim()) return true;
  if (!context || context.entry === 'historical_restore') return false;
  return context.completion?.schemaVersion === 1 &&
    sameAnalysisCandidate(context.completion, context.acceptedCandidate, conclusion) &&
    context.completion.status === 'incomplete';
}

/** All controller inputs remain structured, regardless of message language. */
export function generateCorrectionPrompt(
  issues: readonly VerificationIssue[],
  originalConclusion: string,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  const errors = issues.filter(issue => issue.severity === 'error');
  const missingSections = new Map(errors
    .filter(issue => issue.recoveryKind === 'complete_report_content')
    .flatMap(issue => issue.missingSections ?? [])
    .map(section => [section.id, section]));
  return renderRequiredLocalizedStrategyTemplate('prompt-analysis-correction', outputLanguage, {
    correction_context: JSON.stringify({
      recoveryKinds: [...new Set(errors.flatMap(issue => issue.recoveryKind ? [issue.recoveryKind] : []))],
      missingSections: [...missingSections.values()],
      issues: issues.map(({type, severity, message, recoveryKind}) => ({type, severity, message, recoveryKind})),
    }, null, 2),
    original_conclusion: originalConclusion,
  });
}

/** A missing terminal record does not authorize a continuation or a report rewrite. */
function assessDeliveryIssues(
  conclusion: string,
  context: AnalysisDeliveryContext | undefined,
  conclusionContract: unknown,
  outputLanguage: OutputLanguage,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const current = context && context.entry !== 'historical_restore' ? context : undefined;
  const completion = current?.completion;
  const origin = current?.outputOrigin;
  const supportedOrigin = origin === 'sdk_final' || origin === 'assistant_stream' ||
    origin === 'evidence_rendered' || origin === 'runtime_fallback';
  const nativeKnown = completion?.schemaVersion === 1 &&
    isProductionAgentRuntimeKind(completion.runtimeKind) &&
    sameAnalysisCandidate(completion, current?.acceptedCandidate, conclusion) && supportedOrigin &&
    ['completed', 'incomplete', 'failed', 'cancelled'].includes(completion.status);
  const modelBody = origin === 'sdk_final' || origin === 'assistant_stream';
  const canContinue = nativeKnown && modelBody &&
    (completion?.status === 'completed' || completion?.status === 'incomplete');

  if (!nativeKnown) issues.push({
    type: 'missing_check', severity: 'error',
    message: localize(outputLanguage,
      '当前候选缺少匹配的完成记录或内容来源，完成状态尚未确认。',
      'The current candidate lacks a matching terminal record or output origin; completion is unconfirmed.'),
  });
  if (!conclusion.trim()) issues.push({
    type: 'missing_reasoning', severity: 'error',
    message: localize(outputLanguage, '当前候选没有可交付的正文。', 'The current candidate has no deliverable body.'),
    ...(canContinue ? {recoveryKind: 'continue_output' as const} : {}),
  });
  if (nativeKnown && completion) {
    if (origin === 'runtime_fallback') {
      issues.push({type: 'missing_reasoning', severity: 'error',
        message: localize(outputLanguage,
          '运行时降级说明不能证明模型正文已完成。',
          'A runtime fallback cannot establish completion of the model body.'),
      });
    } else if (completion.status !== 'completed') {
      issues.push({
        type: completion.status === 'incomplete' ? 'truncation' : 'missing_reasoning',
        severity: 'error',
        message: localize(outputLanguage,
          `当前候选的运行结束状态为 ${completion.reason ?? completion.status}。`,
          `The current candidate ended with ${completion.reason ?? completion.status}.`),
        ...(completion.status === 'incomplete' && modelBody ? {recoveryKind: 'continue_output' as const} : {}),
      });
    }
  }
  // This consumes the shared assessment's full binding, never section words or query guesses.
  const report = assessFinalReportContract({conclusion, conclusionContract, context});
  if (report.missingSections.length > 0) issues.push({
    type: 'missing_reasoning', severity: 'error',
    ...(nativeKnown && modelBody && completion?.status === 'completed'
      ? {recoveryKind: 'complete_report_content' as const} : {}),
    missingSections: report.missingSections.map(({id, label, description}) => ({id, label, description})),
    message: localize(outputLanguage,
      '语义评估确认当前报告缺少已适用的内容要求。',
      'The semantic assessment confirmed missing applicable report content.'),
  });
  return issues;
}

/**
 * Evaluate runtime state only. This result does not certify claim truth, source
 * use or semantic coverage; the shared finalizer owns those judgments. It emits
 * nothing and writes no terminal state: runtimes read it through
 * `agentRuntime/runtimeDraftDiagnostics.ts` to decide a same-run repair only.
 * The historical heuristicIssues field carries these runtime diagnostics.
 */
export async function verifyConclusion(
  _findings: Finding[],
  conclusion: string,
  options: {
    plan?: AnalysisPlanV3 | null;
    hypotheses?: Hypothesis[];
    outputLanguage?: OutputLanguage;
    deliveryContext?: AnalysisDeliveryContext;
    conclusionContract?: unknown;
  } = {},
): Promise<VerificationResult> {
  const startTime = Date.now();
  const outputLanguage = options.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const heuristicIssues = [
    ...verifyPlanAdherence(options.plan ?? null),
    ...(options.hypotheses === undefined ? [] : verifyHypotheses(options.hypotheses)),
    ...assessDeliveryIssues(conclusion, options.deliveryContext, options.conclusionContract, outputLanguage),
  ];
  return {
    passed: !heuristicIssues.some(issue => issue.severity === 'error'),
    heuristicIssues,
    durationMs: Date.now() - startTime,
  };
}
