// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentRuntimeAnalysisResult} from '../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {IdentityResolutionV1} from '../types/identityContract';
import {
  sameAnalysisCandidate,
  type AnalysisAssuranceStatus,
  type AnalysisDeliveryAssurance,
  type AnalysisDeliveryContext,
  type AnalysisRecoveryKind,
} from '../types/analysisDelivery';

export type FinalResultQualityIssueCode =
  | 'empty_conclusion'
  | 'plan_summary_fallback'
  | 'process_narration_conclusion'
  | 'missing_final_report_heading'
  | 'sparse_unverified_conclusion'
  | 'quick_full_report_shape'
  | 'quick_verifier_failed'
  | 'comparison_identity_incomplete'
  | 'source_claim_binding_invalid'
  | 'sdk_incomplete'
  | 'runtime_fallback'
  | 'completion_not_checked';

export interface FinalResultQualityIssue {
  code: FinalResultQualityIssueCode;
  message: string;
  recoveryKind?: AnalysisRecoveryKind;
}

export interface FinalResultComparisonIdentity {
  currentTraceId?: string;
  referenceTraceId?: string;
  currentPackageName?: string;
  referencePackageName?: string;
  /**
   * Where each package came from. `auto_detected` is a runtime focus-app
   * hypothesis, never an expected identity; absent means an authoritative
   * source (the user, or the comparison evidence pack).
   */
  currentPackageSource?: 'user' | 'auto_detected';
  referencePackageSource?: 'user' | 'auto_detected';
  currentResolution?: IdentityResolutionV1;
  referenceResolution?: IdentityResolutionV1;
}

function safeComparisonPackageName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f`]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function completeFinalResultComparisonIdentity(input: {
  conclusion: string;
  identity?: FinalResultComparisonIdentity;
  outputLanguage: OutputLanguage;
}): string {
  const currentPackageName = safeComparisonPackageName(input.identity?.currentPackageName);
  const referencePackageName = safeComparisonPackageName(input.identity?.referencePackageName);
  if (!currentPackageName || !referencePackageName) return input.conclusion;
  if (
    input.conclusion.includes(currentPackageName) &&
    input.conclusion.includes(referencePackageName)
  ) {
    return input.conclusion;
  }

  // An inferred package is labelled as such rather than presented as the
  // comparison's authoritative target.
  const inferred = (source: FinalResultComparisonIdentity['currentPackageSource']) =>
    source === 'auto_detected' ? localize(input.outputLanguage, '（运行时推断）', ' (runtime-inferred)') : '';
  const identitySection = [
    `## ${localize(input.outputLanguage, '对比对象', 'Comparison targets')}`,
    '',
    `- ${localize(input.outputLanguage, '当前侧包名', 'Current package')}${inferred(input.identity?.currentPackageSource)}: \`${currentPackageName}\``,
    `- ${localize(input.outputLanguage, '参考侧包名', 'Reference package')}${inferred(input.identity?.referencePackageSource)}: \`${referencePackageName}\``,
  ].join('\n');
  const conclusion = input.conclusion.trim();
  return conclusion ? `${conclusion}\n\n${identitySection}` : identitySection;
}

export interface FinalResultQualityInput {
  result: AgentRuntimeAnalysisResult;
  context?: AnalysisDeliveryContext;
  /** The user's question; prose and budget never establish a deliverable. */
  query?: string;
  comparisonIdentity?: FinalResultComparisonIdentity;
}

export interface FinalResultQualityAssessment {
  issues: FinalResultQualityIssue[];
  selectedIssue?: FinalResultQualityIssue;
  assurance: AnalysisDeliveryAssurance;
}

function comparisonIdentityStatus(
  identity: FinalResultComparisonIdentity | undefined,
): AnalysisAssuranceStatus {
  if (!identity) return 'not_applicable';
  // A runtime-inferred package is a hypothesis: evidence resolving a different
  // process is not an identity failure. Only an authoritative package is expected.
  const expected = (packageName: string | undefined, source: FinalResultComparisonIdentity['currentPackageSource']) =>
    source === 'auto_detected' ? undefined : packageName;
  const sides = [
    {role: 'current', traceId: identity.currentTraceId,
      expected: expected(identity.currentPackageName, identity.currentPackageSource), resolution: identity.currentResolution},
    {role: 'reference', traceId: identity.referenceTraceId,
      expected: expected(identity.referencePackageName, identity.referencePackageSource), resolution: identity.referenceResolution},
  ] as const;
  if (sides.some(side => side.resolution && side.resolution.status !== 'verified')) return 'failed';
  if (sides.some(side => !side.resolution || !side.traceId?.trim())) return 'not_checked';
  const valid = sides.every(({role, traceId, expected, resolution}) =>
    resolution?.target.traceSide === role && resolution.target.traceId === traceId &&
    resolution.processes.length > 0 &&
    (!expected || resolution.processes.some(process => process.packageName === expected)));
  return valid ? 'passed' : 'failed';
}

/** Body wording never proves or repairs process identity. */
export function assessFinalResultComparisonIdentity(
  _conclusion: string,
  identity: FinalResultComparisonIdentity | undefined,
): FinalResultQualityIssue | undefined {
  if (comparisonIdentityStatus(identity) !== 'failed') return undefined;
  return {
    code: 'comparison_identity_incomplete',
    message: '双 Trace 对比的两侧进程身份未通过结构化证据核验。',
    recoveryKind: 'correct_evidence',
  };
}

/**
 * Collect delivery failures before deciding which issue to display or recover.
 *
 * Model-authored declarations, their repair and the semantic review are
 * retired, so claim, report-coverage and investigation-coverage assurance have
 * no checking mechanism: a new finalization records them `not_applicable`.
 * Completion, comparison identity and the source citation annotation remain.
 */
export function assessFinalResultQualityAssessment(
  input: FinalResultQualityInput,
): FinalResultQualityAssessment {
  const {result} = input;
  // Compatibility callers are drafts. Only explicit finalization may persist a verdict.
  const context = input.context ?? {entry: 'runtime_draft' as const};
  const assurance: AnalysisDeliveryAssurance = {
    schemaVersion: 1, entry: context.entry, completion: 'not_checked', claims: 'not_applicable',
    source: 'not_checked', identity: 'not_applicable', report: 'not_applicable',
    investigation: 'not_applicable', investigationEvidence: 'not_applicable',
  };
  if (context.entry === 'historical_restore') {
    return {issues: [], assurance: result.deliveryAssurance ?? assurance};
  }
  const issues: FinalResultQualityIssue[] = [];
  // The finalizer stores the source citation check of this body only when it
  // applies; the gate maps that status and never classifies prose itself.
  const sourceStatus = result.sourceClaimVerificationResult?.status;
  if (sourceStatus) {
    // A citation the run's ledger cannot match is an advisory gap, never a failure.
    assurance.source = sourceStatus === 'passed' ? 'passed' : sourceStatus === 'partial' ? 'coverage_incomplete'
      : sourceStatus === 'failed' ? 'failed' : 'not_checked';
  } else if (context.entry === 'new_finalization') {
    // No source access, or access without any written citation: nothing to check.
    assurance.source = 'not_applicable';
  }
  const identity = input.comparisonIdentity;
  assurance.identity = comparisonIdentityStatus(identity);
  const identityIssue = assessFinalResultComparisonIdentity(result.conclusion, identity);
  if (identityIssue) issues.push(identityIssue);

  const candidateCurrent = sameAnalysisCandidate(context.acceptedCandidate, context.acceptedCandidate, result.conclusion);
  const completion = context.completion;
  const receiptCurrent = completion?.schemaVersion === 1 &&
    sameAnalysisCandidate(completion, context.acceptedCandidate, result.conclusion);
  if (!result.conclusion.trim()) issues.push({
    code: 'empty_conclusion', message: '当前候选没有可交付的正文。', recoveryKind: 'continue_output',
  });
  if (candidateCurrent && context.outputOrigin === 'runtime_fallback') {
    assurance.completion = 'failed';
    issues.push({code: 'runtime_fallback', message: '运行时降级内容不是已完成的模型正文。'});
  } else if (receiptCurrent && completion) {
    if (completion.status === 'completed') {
      if (context.outputOrigin === 'sdk_final' || context.outputOrigin === 'assistant_stream') {
        assurance.completion = 'passed';
      }
    } else if (completion.status !== 'unknown') {
      assurance.completion = 'failed';
      issues.push({
        code: 'sdk_incomplete',
        message: `当前候选未完成：${completion.reason ?? completion.status}。`,
        ...(completion.status === 'incomplete' ? {recoveryKind: 'continue_output' as const} : {}),
      });
    }
  }
  if (!result.conclusion.trim()) assurance.completion = 'failed';

  if (context.entry === 'new_finalization') {
    if (assurance.completion === 'not_checked') issues.push({
      code: 'completion_not_checked', message: '当前正文缺少匹配本次候选的服务器完成证明。',
    });
    if (assurance.identity === 'not_checked') issues.push({
      code: 'comparison_identity_incomplete', message: '双 Trace 对比尚缺两侧身份的核验证据。',
    });
  }
  return {issues, selectedIssue: issues[0], assurance};
}

/** Compatibility projection; callers needing assurance consume the full assessment. */
export function assessFinalResultQuality(input: FinalResultQualityInput): FinalResultQualityIssue | undefined {
  return assessFinalResultQualityAssessment(input).selectedIssue;
}

export function applyFinalResultQualityGate(input: FinalResultQualityInput): FinalResultQualityIssue | undefined {
  const assessment = assessFinalResultQualityAssessment(input);
  if (input.context?.entry !== 'new_finalization') return assessment.selectedIssue;
  const {result, context} = input;
  result.deliveryAssurance = assessment.assurance;
  const current = sameAnalysisCandidate(context.acceptedCandidate, context.acceptedCandidate, result.conclusion);
  result.completion = current && context.completion &&
    sameAnalysisCandidate(context.completion, context.acceptedCandidate, result.conclusion) ? context.completion : undefined;
  result.outputOrigin = current ? context.outputOrigin : undefined;
  result.turnIntent = current ? context.turnIntent : undefined;
  delete result.reportAssessment;
  // Record-only display of the investigation ledger; it carries no assurance status.
  result.investigationAssessment = current ? context.investigationAssessment : undefined;
  // Verification is independent annotation on the delivered body. Only an
  // actual delivery/lifecycle failure makes the analysis partial; a failed or
  // unavailable review must not discard the answer, alter native completion,
  // lower its finding confidence or present it as verified.
  const issue = assessment.issues.find(({code}) => code === 'empty_conclusion' ||
    code === 'sdk_incomplete' || code === 'runtime_fallback' || code === 'completion_not_checked');
  if (!issue) return undefined;
  result.partial = true;
  result.confidence = Math.min(result.confidence || 0, 0.55);
  result.terminationReason ??= 'quality_gate_failed';
  appendTerminationMessage(result, issue.message);
  return issue;
}

/** Add one explanation to a result's termination message without repeating it. */
export function appendTerminationMessage(result: Pick<AgentRuntimeAnalysisResult, 'terminationMessage'>, message: string): void {
  if (!result.terminationMessage) result.terminationMessage = message;
  else if (!result.terminationMessage.includes(message)) result.terminationMessage = `${result.terminationMessage}\n\n${message}`;
}
