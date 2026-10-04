// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentRuntimeAnalysisResult} from '../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {assessFinalReportContract, type FinalReportContractAssessmentResult} from './finalReportContractGate';
import {assessFinalInvestigationContract, type FinalInvestigationContractResult} from './finalInvestigationContractGate';
import type {StoredSourceClaimVerificationResult} from './codebase/sourceClaimVerifier';
import {isUnusedSourceDecision} from './codebase/sourceUseDecision';
import {isSemanticClaimIssueCode, SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE} from './finalSemanticIssueCodes';
import {claimReferences} from './analysisInvestigationPresentation';
import type {IdentityResolutionV1} from '../types/identityContract';
import {
  analysisDeliveryFingerprint,
  sameAnalysisCandidate,
  type AnalysisAssuranceStatus,
  type AnalysisDeliveryAssurance,
  type AnalysisDeliveryContext,
  type AnalysisRecoveryKind,
  type AnalysisMissingReportSection,
  type AnalysisVerificationBinding,
} from '../types/analysisDelivery';

export type FinalResultQualityIssueCode =
  | 'empty_conclusion'
  | 'plan_summary_fallback'
  | 'process_narration_conclusion'
  | 'missing_final_report_heading'
  | 'sparse_unverified_conclusion'
  | 'quick_full_report_shape'
  | 'quick_verifier_failed'
  | 'verifier_contradicted_claim'
  | 'scene_contract_incomplete'
  | 'comparison_identity_incomplete'
  | 'source_claim_binding_invalid'
  | 'sdk_incomplete'
  | 'runtime_fallback'
  | 'completion_not_checked'
  | 'report_assessment_not_checked';

export interface FinalResultQualityIssue {
  code: FinalResultQualityIssueCode;
  message: string;
  recoveryKind?: AnalysisRecoveryKind;
  missingSections?: AnalysisMissingReportSection[];
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

/** Describe typed failures without treating rejected declarations as missing evidence. */
function describeContradictedClaims(
  verification: NonNullable<AgentRuntimeAnalysisResult['claimVerificationResult']>,
): string {
  const results = verification.claimResults || [];
  const claimIds = new Set(results.map(claim => claim.claimId).filter(id => typeof id === 'string' && id.trim().length > 0));
  const bindingIssues = verification.issues.filter(issue => issue.severity === 'error' && issue.code === 'binding_ineligible');
  const bindingIds = new Set(bindingIssues.filter(issue => claimIds.has(issue.claimId)).map(issue => issue.claimId));
  let globalBindingFailure = bindingIssues.some(issue => !claimIds.has(issue.claimId));
  const mismatchedIds = new Set<string>();
  const missingIds = new Set<string>();
  const rejectedPropositionIds = new Set<string>();
  // A reference status is a failure only when the verifier recorded it as an
  // error for that claim. Advisory (warning) mismatches stay out of the `!`
  // message; a claim whose unsupported status no issue of its own explains
  // (older shapes) still falls back to its reference statuses.
  const errorCodesByClaim = new Map<string, Set<string>>();
  for (const issue of verification.issues) {
    if (issue.severity !== 'error' || !claimIds.has(issue.claimId)) continue;
    const codes = errorCodesByClaim.get(issue.claimId) ?? new Set<string>();
    codes.add(issue.code);
    errorCodesByClaim.set(issue.claimId, codes);
  }
  const referenceFailureCounts = (claim: (typeof results)[number], status: 'value_mismatch' | 'missing') => {
    const codes = errorCodesByClaim.get(claim.claimId);
    return codes ? codes.has(`claim_reference_${status}`) : claim.status === 'unsupported';
  };
  for (const claim of results) {
    const references = claimReferences(verification, claim);
    const proof = claim.deterministicProof;
    const bindingFailure = bindingIds.has(claim.claimId) || references.some(ref => ref.status === 'ineligible') ||
      (proof?.status === 'rejected' && proof.reason === 'binding_ineligible');
    if (bindingFailure) {
      if (claimIds.has(claim.claimId)) bindingIds.add(claim.claimId);
      else globalBindingFailure = true;
    }
    if (!claimIds.has(claim.claimId)) continue;
    if (references.some(ref => ref.status === 'value_mismatch') && referenceFailureCounts(claim, 'value_mismatch')) {
      mismatchedIds.add(claim.claimId);
    }
    // A binding rejection can retain a compatibility "missing" reference; it
    // never establishes absence, nor hides a separate recorded value mismatch.
    if (!bindingFailure && references.some(ref => ref.status === 'missing') && referenceFailureCounts(claim, 'missing')) {
      missingIds.add(claim.claimId);
    }
    if (proof?.status === 'rejected' && proof.reason !== 'binding_ineligible') rejectedPropositionIds.add(claim.claimId);
  }
  for (const id of bindingIds) missingIds.delete(id);
  const semanticInconsistentIds = new Set(verification.issues
    .filter(issue => issue.severity === 'error' && isSemanticClaimIssueCode(issue.code) && claimIds.has(issue.claimId))
    .map(issue => issue.claimId));
  // A warning since undeclared assertions stopped failing the gate on their
  // own; still named when another check fails.
  const undeclaredAssertions = verification.issues.some(issue => issue.code === SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE);
  const details = [
    ...(bindingIds.size ? [`${bindingIds.size} 条断言的声明或绑定无效，相关断言未通过核验准入`] : []),
    ...(globalBindingFailure ? ['声明或绑定校验存在未关联到具体断言的错误'] : []),
    ...(mismatchedIds.size ? [`${mismatchedIds.size} 条断言的引用值与证据不符`] : []),
    ...(rejectedPropositionIds.size ? [`${rejectedPropositionIds.size} 条断言的命题未通过确定性证明`] : []),
    ...(missingIds.size ? [`${missingIds.size} 条断言的引用未找到所需证据`] : []),
    ...(semanticInconsistentIds.size ? [`${semanticInconsistentIds.size} 条断言的正文表述与其声明不一致`] : []),
    ...(undeclaredAssertions ? ['正文包含未声明的断言'] : []),
  ];
  return `${details.length ? details.join('；') : '断言核验存在未通过的检查，具体原因尚未归类'}；不能作为已核验结论交付。`;
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
  report: FinalReportContractAssessmentResult;
  investigation?: FinalInvestigationContractResult;
  sourceClaimVerification?: StoredSourceClaimVerificationResult;
}

function verifiedEvidenceRenderedOutput(
  result: AgentRuntimeAnalysisResult,
  context: Exclude<AnalysisDeliveryContext, {entry: 'historical_restore'}>,
): boolean {
  const proof = context.evidenceRenderedProof;
  if (!proof || !sameAnalysisCandidate(proof.candidate, context.acceptedCandidate, result.conclusion)) return false;
  const claims = result.conclusionContract?.claims ?? [];
  if (proof.kind === 'acknowledgement') {
    return context.turnIntent?.status === 'resolved' &&
      context.turnIntent.taskKind === 'acknowledgement' &&
      context.turnIntent.deliverable === 'answer' &&
      proof.intentFingerprint === analysisDeliveryFingerprint(context.turnIntent) &&
      proof.evidence === 'not_applicable' && claims.length === 0 &&
      (result.claimSupport?.length ?? 0) === 0 && result.findings.length === 0 &&
      (result.claimVerificationResult?.checkedClaimCount ?? 0) === 0 &&
      (result.claimVerificationResult?.unsupportedClaimCount ?? 0) === 0 &&
      result.claimVerificationResult?.status !== 'failed';
  }
  const verification = result.claimVerificationResult;
  if (!context.evidenceFingerprint || proof.evidenceFingerprint !== context.evidenceFingerprint ||
    proof.claimsFingerprint !== analysisDeliveryFingerprint(claims) ||
    proof.verificationFingerprint !== analysisDeliveryFingerprint(verification) ||
    claims.length === 0 || new Set(proof.claimIds).size !== claims.length ||
    proof.claimIds.length !== claims.length || !claims.every(claim =>
      typeof claim.id === 'string' && claim.id.trim().length > 0 && proof.claimIds.includes(claim.id)) ||
    verification?.status !== 'passed' || verification.checkedClaimCount !== claims.length ||
    verification.unsupportedClaimCount !== 0 || verification.claimResults.length !== claims.length
  ) return false;
  return claims.every(claim => {
    const checked = verification.claimResults.filter(item => item.claimId === claim.id);
    return checked.length === 1 && checked[0].status === 'verified' &&
      checked[0].referenceResults?.some(reference => reference.status === 'matched') &&
      (claim.kind !== 'causal' || result.claimSupport?.some(support =>
        support.claimId === claim.id && support.relationEvaluation === 'verified'));
  });
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

function currentVerificationBinding(
  result: AgentRuntimeAnalysisResult,
  context: Exclude<AnalysisDeliveryContext, {entry: 'historical_restore'}>,
  binding: AnalysisVerificationBinding | undefined,
  verification: unknown,
): boolean {
  return Boolean(binding && context.evidenceFingerprint &&
    sameAnalysisCandidate(binding.candidate, context.acceptedCandidate, result.conclusion) &&
    binding.claimsFingerprint === analysisDeliveryFingerprint(result.conclusionContract?.claims ?? []) &&
    binding.evidenceFingerprint === context.evidenceFingerprint &&
    binding.verificationFingerprint === analysisDeliveryFingerprint(verification));
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

/** Collect evidence failures before deciding which issue to display or recover. */
export function assessFinalResultQualityAssessment(
  input: FinalResultQualityInput,
): FinalResultQualityAssessment {
  const {result} = input;
  // Compatibility callers are drafts. Only explicit finalization may persist a verdict.
  const context = input.context ?? {entry: 'runtime_draft' as const};
  const assurance: AnalysisDeliveryAssurance = {
    schemaVersion: 1, entry: context.entry, completion: 'not_checked', claims: 'not_checked',
    source: 'not_checked', identity: 'not_applicable', report: 'not_checked',
  };
  const emptyReport: FinalReportContractAssessmentResult = {
    status: 'not_checked', requirements: [], missingSections: [],
  };
  if (context.entry === 'historical_restore') {
    return {issues: [], assurance: result.deliveryAssurance ?? assurance, report: emptyReport};
  }
  const issues: FinalResultQualityIssue[] = [];
  // The finalizer joins claim_verifier@2 (finite proof plus the one semantic
  // review) and the source verifier before it calls this gate; the gate reads
  // those results and never classifies prose itself.
  const currentTypedVerification = result.claimVerificationResult?.schemaVersion === 'claim_verifier@2';
  const sourceClaimVerification = result.sourceClaimVerificationResult;
  const claimVerificationCurrent = currentVerificationBinding(
    result, context, context.claimVerificationBinding, result.claimVerificationResult,
  );
  const sourceBinding = context.sourceVerificationBinding;
  const sourceVerificationCurrent = claimVerificationCurrent &&
    currentVerificationBinding(result, context, sourceBinding, sourceClaimVerification) &&
    sourceBinding?.conclusionContractFingerprint === analysisDeliveryFingerprint(result.conclusionContract) &&
    Boolean(context.sourceUseFingerprint) && sourceBinding?.sourceUseFingerprint === context.sourceUseFingerprint &&
    sourceBinding?.sourceUseFingerprint === analysisDeliveryFingerprint(result.sourceUseDecision);
  if (sourceClaimVerification) {
    // A weaker-than-linked source claim is delivered but not fully verified
    // (`coverage_incomplete`, a `~`); only an error, a reference this run never
    // issued or Trace evidence of another claim, fails the gate.
    assurance.source = sourceClaimVerification.status === 'partial' ? 'coverage_incomplete' :
      sourceClaimVerification.status === 'passed' ? sourceVerificationCurrent ? 'passed' : 'not_checked' :
      sourceClaimVerification.status === 'failed' ? 'failed' : 'not_checked';
    for (const issue of sourceClaimVerification.issues.filter(issue => issue.severity === 'error')) issues.push({
      code: 'source_claim_binding_invalid',
      message: `源码引用绑定无效：${issue.message}`,
      recoveryKind: 'correct_evidence',
    });
  }
  if (context.entry === 'new_finalization' && context.sourceApplicability === 'not_applicable' &&
    currentTypedVerification && sourceVerificationCurrent && sourceClaimVerification?.status === 'not_checked' &&
    Boolean(context.sourceScopeFingerprint) && sourceBinding?.sourceScopeFingerprint === context.sourceScopeFingerprint &&
    sourceClaimVerification.bindings.length === 0 && sourceClaimVerification.issues.length === 0 &&
    isUnusedSourceDecision(result.sourceUseDecision) &&
    (result.sourceReferences === undefined || Array.isArray(result.sourceReferences) && result.sourceReferences.length === 0)) {
    assurance.source = 'not_applicable';
  }
  const claimVerification = result.claimVerificationResult;
  if (claimVerification) {
    const sourceProofCurrent = !claimVerification.claimResults.some(claim =>
      claim.deterministicProof?.kind === 'source_location') || sourceVerificationCurrent;
    assurance.claims = claimVerification.status === 'partial' ? 'coverage_incomplete' :
      claimVerification.status === 'passed' ? claimVerificationCurrent && sourceProofCurrent ? 'passed' : 'not_checked' :
      claimVerification.status === 'failed' ? 'failed' : 'not_checked';
    if (claimVerification.status === 'failed' || claimVerification.unsupportedClaimCount > 0 ||
      claimVerification.claimResults.some(claim => claim.status === 'unsupported')) {
      assurance.claims = 'failed';
      const errors = claimVerification.issues.filter(issue => issue.severity === 'error');
      for (const message of [describeContradictedClaims(claimVerification), ...errors.map(issue => issue.message)]) {
        issues.push({code: 'verifier_contradicted_claim', message, recoveryKind: 'correct_evidence'});
      }
    }
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
      } else if (context.outputOrigin === 'evidence_rendered' && verifiedEvidenceRenderedOutput(result, context)) {
        assurance.completion = 'passed';
        if (context.evidenceRenderedProof?.kind === 'acknowledgement') assurance.claims = 'not_applicable';
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

  const report = assessFinalReportContract({
    conclusion: result.conclusion, conclusionContract: result.conclusionContract, context,
  });
  assurance.report = report.status;
  const investigation = assessFinalInvestigationContract({
    conclusion: result.conclusion, conclusionContract: result.conclusionContract, context,
  });
  assurance.investigation = investigation.status;
  assurance.investigationEvidence = investigation.evidenceStatus;
  // Investigation gaps are independent assurance. They never restart the runtime
  // or manufacture an incomplete SDK receipt after a delivered answer.
  if (report.missingSections.length > 0) issues.push({
    code: 'scene_contract_incomplete',
    message: '语义评估确认当前报告缺少已适用的内容要求。',
    recoveryKind: 'complete_report_content',
    missingSections: report.missingSections,
  });
  if (context.entry === 'new_finalization') {
    if (assurance.completion === 'not_checked') issues.push({
      code: 'completion_not_checked', message: '当前正文缺少匹配本次候选的服务器完成证明。',
    });
    if (context.turnIntent?.status === 'resolved' && context.turnIntent.deliverable === 'report' &&
      ['not_checked', 'unavailable', 'coverage_incomplete'].includes(report.status)) issues.push({
      code: 'report_assessment_not_checked', message: '当前报告的语义覆盖尚未完整核验。',
    });
    if (assurance.identity === 'not_checked') issues.push({
      code: 'comparison_identity_incomplete', message: '双 Trace 对比尚缺两侧身份的核验证据。',
    });
  }
  return {issues, selectedIssue: issues[0], assurance, report, investigation, sourceClaimVerification};
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
  result.reportAssessment = current ? assessment.report.acceptedAssessment : undefined;
  result.investigationAssessment = current ? assessment.investigation?.acceptedAssessment : undefined;
  if (assessment.sourceClaimVerification) {
    result.sourceClaimVerificationResult = assessment.sourceClaimVerification;
  }
  const issue = assessment.selectedIssue;
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
