// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'node:crypto';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import type {ConclusionBindingEligibility, ConclusionContract} from '../agent/core/conclusionContract';
import {
  isIssuedFinalizationContext,
  takeRunDeliveryRecord,
  type RuntimeFinalizationContext,
} from '../agentRuntime/analysisFinalizationContext';
import type {ComparisonReportSection} from '../agentv3/sessionStateSnapshot';
import type {ClaimSupportV1} from '../types/evidenceContract';
import {getFinalReportContract} from '../agentv3/strategyLoader';
import type {DataEnvelope} from '../types/dataContract';
import {analysisDeliveryFingerprint, reportRequirementsFingerprint, sameAnalysisCandidate,
  type AnalysisCandidateIdentity, type AnalysisDeliveryContext,
  type FinalReportAssessment, type PinnedAnalysisReportRequirements} from '../types/analysisDelivery';
import type {CaseKnowledgeReportRecommendation} from '../types/caseKnowledge';
import type {ClaimSemanticReviewTrace, ClaimVerificationResult, ClaimVerificationClaimResult, ClaimVerificationIssue} from '../types/claimVerification';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection} from './canonicalAnalysisResult';
import {attachSourceUseToAnalysisResult, verifySourceClaimBindings} from './codebase/sourceClaimVerifier';
import {buildKnowledgeUse} from './knowledge/knowledgeUse';
import {prepareAnalysisRelations} from './evidence/analysisRelationPreparation';
import {prepareClaimEvidence, preparedClaimEvidenceSnapshot, preparedIdentityResolutions} from './evidence/claimEvidencePreparation';
import {runClaimVerification, collectMatchedTraceEvidenceRefIdsByClaimId} from './verifier/claimVerificationRunner';
import {assessFinalSemantics, buildFinalSemanticPrompt, FINAL_SEMANTIC_INPUT_BYTE_LIMIT, FINAL_SEMANTIC_RULE_VERSION,
  semanticReviewNotRequired, type FinalSemanticAssessment, type FinalSemanticSnapshot,
  type SemanticClaimAssessment} from './finalSemanticAssessment';
import {SEMANTIC_NUMERIC_DISPLAY_ROUNDING_ISSUE_CODE, SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE, semanticClaimIssueCode} from './finalSemanticIssueCodes';
import {countLocatedNumbersShowingRounding, locatedNumbersShowDeclaredRounding} from './finalSemanticNumericDisplay';
import {appendTerminationMessage, applyFinalResultQualityGate, type FinalResultComparisonIdentity,
  type FinalResultQualityIssue} from './finalResultQualityGate';
import {withOwnerCodeAwareProjection} from './security/codeAwareOutputRegistry';
import {projectConclusionSemanticInput} from './security/conclusionProtocolProjection';
import {projectStoredConclusionSourceMetadata} from './security/analysisDeliveryProjection';
import {getCapturedAnchorFacts} from './evidence/evidenceCapture';
import {compactSemanticEvidenceSnapshot} from './evidence/semanticEvidenceSnapshot';
import {compactSemanticSourceSnapshot} from './evidence/semanticSourceSnapshot';
import {compactInvestigationEvidenceForSemantic, investigationEvidenceSemanticBudgets} from './evidence/investigationEvidenceLedger';
import {isUnusedSourceDecision, type SourceExecutionScopeV1, type SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {projectOwnerClaimVerification, projectOwnerClaimSupport,
  projectOwnerConclusionContract} from './security/privateAnalysisProjection';
import {resolveAnalysisInvestigationRequirements} from '../agentRuntime/analysisInvestigationRequirements';
import {assessInvestigationAcquisition, assessLedgerAcquisition,
  investigationRequirementNeedsReview} from './finalInvestigationContractGate';
import type {ResolvedAnalysisInvestigationRequirements} from '../types/analysisInvestigation';
import type {FinalInvestigationAssessment} from '../types/analysisInvestigationAssessment';
import {consumeSceneRuntimeSeal, type SceneRuntimeSeal} from '../agent/scene/sceneRuntimeBinding';
import {assessSceneTimeline} from '../agent/scene/sceneTimelineAssessment';
import {projectSceneTimelineForOwner} from '../agent/scene/sceneTimelineProjection';
import type {SceneScope} from '../agent/scene/sceneTimelineContract';
import {issueSceneTimelinePublication, type SceneTimelinePublication} from '../agent/scene/sceneTimelinePublication';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {FinalizationProgressEvent, FinalizationProgressObserver} from './finalizationProgress';
import {currentRuntimePerformanceRecorder} from './selfEvolution/runManifestLifecycle';
import {recordRuntimeFinalReview, type RuntimeFinalReviewTrigger} from '../agentRuntime/runtimePerformance';

export interface AnalysisFinalizationOwner {
  runId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  assertAuthorized(): void;
  /** Original selection pin, captured before analyze(), not a mutable session value. */
  analysisContextFingerprint?: string;
}

export interface FinalizeAnalysisResultInput {
  result: AnalysisResult;
  context?: RuntimeFinalizationContext;
  owner: AnalysisFinalizationOwner;
  query: string;
  dataEnvelopes?: readonly DataEnvelope[];
  comparisonReportSection?: ComparisonReportSection;
  comparisonIdentity?: FinalResultComparisonIdentity;
  /** Curated-case hits the server retrieved for this run. */
  caseRecommendations?: readonly CaseKnowledgeReportRecommendation[];
  conversation?: NonNullable<Parameters<typeof canonicalizeAnalysisResult>[1]>['conversation'];
  /** Issued product sidecar, separate from a provider's accepted body or result JSON. */
  scene?: {seal: SceneRuntimeSeal; scope: SceneScope; outputLanguage: OutputLanguage; providerId?: string | null};
  /**
   * Live progress for the one semantic review: `final_review_started` only when
   * a provider request is actually sent, then exactly one `final_review_finished`.
   * Observer failures are ignored; they never change finalization.
   */
  onProgress?: FinalizationProgressObserver;
  /**
   * Deliver first, verify after. Called at most once, synchronously, at the
   * moment the single semantic review is dispatched, with the canonical body
   * exactly as the review sees it. The review cannot rewrite that body, so a
   * surface may show it at once as an answer whose verdict is pending; the
   * verdict and any appended notices arrive with the finalized result. Never
   * called for scene runs, when no review is dispatched, or for an empty body.
   * The payload is unprojected: each surface applies its own owner projection.
   * Return `false` when the surface did not actually deliver it (for example the
   * run no longer owns its stream); the review-started progress then does not
   * claim the answer is readable. Observer failures count as not delivered.
   */
  onProvisionalAnswer?: (answer: ProvisionalAnalysisAnswer) => boolean | void;
  /**
   * Stops the semantic review only. Finalization continues and records the
   * review as `not_checked` / `cancelled_by_user`; `owner.signal` still cancels
   * the whole finalization.
   */
  reviewStopSignal?: AbortSignal;
}

export interface ProvisionalAnalysisAnswer {
  /** Canonical, sidecar-free body; the review is bound to exactly this text. */
  readonly conclusion: string;
}

export interface FinalizedAnalysisResult {
  result: AnalysisResult;
  qualityIssue?: FinalResultQualityIssue;
  conversationOutcome?: ReturnType<typeof canonicalizeAnalysisResult>['conversationOutcome'];
  /** Diagnostic receipt stays private; persistence consumes result only. */
  semanticAssessment?: FinalSemanticAssessment;
  scenePublication?: SceneTimelinePublication;
}

const consumedContexts = new WeakSet<RuntimeFinalizationContext>();

/** Inspect the original declaration, including malformed fields a typed parser may omit. */
function hasNoSourceDeclarations(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const declaration = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(declaration, 'sourceUseDecision')) return false;
  for (const key of ['sourceReferences', 'sourceClaimBindings']) {
    if (Object.prototype.hasOwnProperty.call(declaration, key) &&
      (!Array.isArray(declaration[key]) || declaration[key].length !== 0)) return false;
  }
  if (declaration.claims === undefined) return true;
  if (!Array.isArray(declaration.claims)) return false;
  return declaration.claims.every(claim => {
    const semantics = claim?.semantics;
    return !semantics || !Object.prototype.hasOwnProperty.call(semantics, 'source') &&
      !(typeof semantics.predicate === 'string' && semantics.predicate.startsWith('source.')) &&
      semantics.scope?.population !== 'codebase';
  });
}

function sourceScopeHasNoAccess(scope: Readonly<SourceExecutionScopeV1> | undefined,
  sourceUse: SourceUseDecisionV1 | undefined): boolean {
  if (!scope || !['off', 'metadata_only', 'provider_send'].includes(scope.codeAwareMode) ||
    typeof scope.analysisContextFingerprint !== 'string' || !scope.analysisContextFingerprint.trim() || !Array.isArray(scope.selectedCodebaseIds) ||
    scope.selectedCodebaseIds.some(id => typeof id !== 'string' || !id.trim()) ||
    new Set(scope.selectedCodebaseIds).size !== scope.selectedCodebaseIds.length ||
    scope.hasCodebaseAccess !== (scope.codeAwareMode !== 'off' && scope.selectedCodebaseIds.length > 0)) return false;
  if (!scope.hasCodebaseAccess) return sourceUse === undefined;
  return Boolean(sourceUse && isUnusedSourceDecision(sourceUse) && sourceUse.codeAwareMode === scope.codeAwareMode &&
    Array.isArray(sourceUse.selectedCodebaseIds) &&
    sourceUse.selectedCodebaseIds.length === scope.selectedCodebaseIds.length &&
    scope.selectedCodebaseIds.every(id => sourceUse.selectedCodebaseIds.includes(id)));
}

function frozenSnapshot<T>(input: T): T {
  const snapshot = structuredClone(input);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

function assertOwner(owner: AnalysisFinalizationOwner): void {
  owner.signal.throwIfAborted();
  if (!owner.isCurrent()) throw new DOMException('Analysis run is no longer current', 'AbortError');
  owner.assertAuthorized();
}

function pinnedRequirements(context: RuntimeFinalizationContext): PinnedAnalysisReportRequirements | undefined {
  if (context.turnIntent.status !== 'resolved' || context.turnIntent.deliverable !== 'report') return undefined;
  const contract = getFinalReportContract(context.turnIntent.sceneId, context.strategyRegistry);
  if (!contract) return undefined;
  return {sceneId: context.turnIntent.sceneId, registryFingerprint: context.strategyRegistry.registryFingerprint,
    requirements: contract.requiredSections.map(({id, label, description, required, condition}) => ({
      id, label, description, required, condition,
    }))};
}

/** Located body offsets of one claim's review, each with a short hash of the text it covers. */
function semanticReviewTrace(review: SemanticClaimAssessment, body: string): ClaimSemanticReviewTrace {
  return {consistency: review.consistency, contentLocations: review.contentLocations.map(({start, end}) => ({start, end,
    textHash: createHash('sha256').update(body.slice(start, end)).digest('hex').slice(0, 16)}))};
}

/**
 * The one protocol-legal path from a review `numeric_mismatch` to the
 * display-rounding warning (plan 2 D), fail-closed on every condition: the
 * claim is a `captured.cell` proposition with exactly one subjectRef; exactly
 * one anchor cell of that claim matches the subjectRef's evidenceRefId,
 * rowIndex and column and carries a numeric actual value with a unit; every
 * issue location lies inside the claim-level contentLocations the review
 * returned for this claim; and no second number of the cell value's unit
 * family inside those claim-level locations equals it. The anchor proves which
 * cell was cited, never what the body shows; the body proves the shown number
 * and its uniqueness. Anything unresolved keeps the mismatch an error.
 */
function sameCapturedCell(
  claim: NonNullable<ConclusionContract['claims']>[number],
  support: ClaimSupportV1 | undefined,
  review: SemanticClaimAssessment,
  issue: SemanticClaimAssessment['issues'][number],
  body: string,
): {value: number | string; unit: string} | undefined {
  const semantics = claim.semantics;
  if (semantics?.predicate !== 'captured.cell' || !support) return undefined;
  const subject = semantics.scope.subjectRefs?.length === 1 &&
    (semantics.scope.objectRefs?.length || 0) === 0 ? semantics.scope.subjectRefs[0] : undefined;
  if (!subject?.evidenceRefId || subject.rowIndex === undefined || !subject.column) return undefined;
  const {rowIndex, column} = subject;
  // The unit is producer authority: the captured field semantics the anchor
  // carries, never a display string on the cell.
  const matches = (support.anchors ?? []).flatMap(anchor => {
    const unit = getCapturedAnchorFacts(anchor)?.fields[column]?.unit;
    if (!unit || !unit.trim()) return [];
    return (anchor.cells ?? [])
      .filter(cell => cell.rowIndex === rowIndex && cell.column === column)
      .map(cell => ({cell, unit}));
  }).filter(match => match.cell.actualValue !== undefined);
  if (matches.length !== 1) return undefined;
  const {cell, unit} = matches[0];
  const value = cell.actualValue;
  if (!(typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'string' && /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))) return undefined;
  if (rowIndex < 0) return undefined;
  // Every issue location must belong to this claim's located body text.
  const inside = (location: {start: number; end: number}) =>
    review.contentLocations.some(({start, end}) => location.start >= start && location.end <= end);
  if (!issue.contentLocations.length || !issue.contentLocations.every(inside)) return undefined;
  // A second same-value candidate anywhere the claim's locations reach makes
  // the located number ambiguous: which cell it renders cannot be known.
  const cellNumeric = {operator: 'eq', value, unit};
  return countLocatedNumbersShowingRounding(body, review.contentLocations, cellNumeric) === 1 &&
    countLocatedNumbersShowingRounding(body, issue.contentLocations, cellNumeric) === 1
    ? {value, unit} : undefined;
}

/** Finite proof never promotes itself; the full current proposition must agree with the body. */
function joinClaimVerification(input: {
  contract?: ConclusionContract;
  draft: ClaimVerificationResult;
  claimSupport?: readonly ClaimSupportV1[];
  semantic?: FinalSemanticAssessment;
  candidate: AnalysisCandidateIdentity;
  body: string;
  bindingEligibility: ConclusionBindingEligibility;
}): ClaimVerificationResult {
  const {draft, semantic, contract, candidate, body} = input;
  const declarations = contract?.claims ?? [];
  const eligible = input.bindingEligibility !== 'ineligible' && contract?.bindingEligibility !== 'ineligible';
  const bound = Boolean(eligible && semantic && ['checked', 'coverage_incomplete'].includes(semantic.status) &&
    sameAnalysisCandidate(semantic.binding?.canonicalCandidate, candidate, body));
  const complete = Boolean(bound && semantic &&
    semantic.coverage.body === 'complete' && semantic.coverage.claims === 'complete' &&
    sameAnalysisCandidate(semantic.binding?.canonicalCandidate, candidate, body));
  const issues: ClaimVerificationIssue[] = [...draft.issues];
  const reviewOf = (id: string) => {
    const reviews = semantic?.claims.filter(item => item.claimId === id) ?? [];
    return reviews.length === 1 ? reviews[0] : undefined;
  };
  const supportById = new Map((input.claimSupport ?? []).map(support => [support.claimId, support]));
  const claimResults: ClaimVerificationClaimResult[] = declarations.map((claim): ClaimVerificationClaimResult => {
    const id = claim.id ?? '';
    const drafts = draft.claimResults.filter(item => item.claimId === id);
    const prior = drafts.length === 1 ? drafts[0] : undefined;
    const review = reviewOf(id);
    const unique = id.length > 0 && declarations.filter(item => item.id === id).length === 1;
    // A claim that failed its own item validation is outside verification and
    // the review's scope: it stays not_checked whatever a review row says.
    if (!unique || !prior || !eligible || claim.valid === false) return {...prior, claimId: id, status: 'not_checked'};
    if (prior.status === 'unsupported' || prior.deterministicProof?.status === 'rejected') {
      return {...prior, status: 'unsupported'};
    }
    if (bound && review?.consistency === 'inconsistent') {
      // Only the issue's own located text: a contradiction whose location could
      // not be resolved stays a contradiction. A downgrade to display rounding
      // additionally needs the captured-cell identity of plan 2 D: the same
      // shown value in another cell's place is a real mismatch.
      const displayRounding = (issue: typeof review.issues[number]): boolean => {
        if (issue.code !== 'numeric_mismatch') return false;
        const cell = sameCapturedCell(claim, supportById.get(id), review, issue, body);
        return cell ? locatedNumbersShowDeclaredRounding(body, issue.contentLocations,
          {operator: 'eq', value: cell.value, unit: cell.unit}) : false;
      };
      const contradictions = review.issues.filter(issue => !displayRounding(issue));
      for (const issue of review.issues) issues.push(contradictions.includes(issue)
        ? {claimId: id, severity: 'error', code: semanticClaimIssueCode(issue.code), message: `Claim ${id}: ${issue.code}`}
        : {claimId: id, severity: 'warning', code: SEMANTIC_NUMERIC_DISPLAY_ROUNDING_ISSUE_CODE,
          message: `Claim ${id}: the body shows the declared value at its displayed precision`});
      // An unmarked rounding is not verified, but it contradicts nothing.
      return {...prior, status: contradictions.length ? 'unsupported' : 'partial'};
    }
    if (!complete || review?.consistency !== 'consistent') return {...prior, status: 'partial'};
    const semantics = claim.semantics;
    if (semantics && (semantics.discourse !== 'asserted' || semantics.modality !== 'certain' ||
      claim.kind === 'inference' || claim.kind === 'recommendation')) {
      return {...prior, status: 'inference'};
    }
    return {...prior, status: prior.deterministicProof?.status === 'proved' &&
      prior.propositionCoverage?.status === 'complete' ? 'verified' : 'partial'};
  }).map(result => {
    const review = bound ? reviewOf(result.claimId) : undefined;
    return review ? {...result, semanticReview: semanticReviewTrace(review, body)} : result;
  });
  // An undeclared assertion was never checked: the answer cannot pass, but it
  // contradicts nothing, so it leaves the result unverified rather than failed.
  if (bound && semantic?.omissions.length) issues.push({claimId: '', severity: 'warning',
    code: SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE, message: 'The answer contains assertions missing from its declared claims.'});
  const unsupportedClaimCount = claimResults.filter(claim => claim.status === 'unsupported').length;
  const failed = unsupportedClaimCount > 0 || issues.some(issue => issue.severity === 'error');
  const passed = !failed && complete && semantic?.omissions.length === 0 &&
    claimResults.every(claim => claim.status === 'verified' || claim.status === 'inference');
  const status = failed ? 'failed' : passed ? 'passed' : declarations.length || semantic ? 'partial' : 'not_checked';
  return {schemaVersion: 'claim_verifier@2', policy: 'record_only', status, passed,
    checkedClaimCount: claimResults.filter(claim => claim.status !== 'not_checked').length,
    unsupportedClaimCount, claimResults, issues,
    ...(semantic?.reason ? {notCheckedReason: semantic.reason,
      ...(semantic.notCheckedDetail ? {notCheckedDetail: semantic.notCheckedDetail} : {})}
      // A completed review that left claims unverified names why in its issues,
      // not as an unavailable review.
      : !passed && !failed && !complete ? {notCheckedReason: 'complete_proposition_review_unavailable'} : {})};
}

/**
 * Why the one semantic review must run; empty when `✓` is unreachable and no
 * obligation (report, selection, source, investigation, acknowledgement) needs
 * it. That skip is an accepted residual: a contradiction only the review would
 * find (`~` becoming `!`) then goes undetected, while a deterministic
 * `unsupported` from finite proof still yields `!`. The review is the only check of the whole body against
 * the declarations, the obligations and the selection (G2), so it runs when a
 * report, a selection, source access or declarations, or a resolved
 * investigation obligation gives it something to decide, and when a verified
 * (`✓`) verdict is still reachable. That last test asks the real join what a
 * perfect review would yield, so it covers inference and recommendation claims
 * exactly as the verdict does; the hypothetical review is never returned or
 * persisted. A zero-claim answer can reach `✓` only through a review, and only
 * a non-factual acknowledgement asks for one; every other zero-claim answer
 * stays `~` without a review.
 */
function semanticReviewTriggers(input: {
  context: RuntimeFinalizationContext;
  delivery: AnalysisDeliveryContext;
  selectionPresent: boolean;
  sourceScope?: Readonly<SourceExecutionScopeV1>;
  rawDeclaration: unknown;
  investigationRequirements?: ResolvedAnalysisInvestigationRequirements;
  contract?: ConclusionContract;
  finiteProofs: ClaimVerificationResult;
  candidate: AnalysisCandidateIdentity;
  body: string;
  bindingEligibility: ConclusionBindingEligibility;
}): RuntimeFinalReviewTrigger[] {
  const {context, delivery, contract, candidate, body} = input;
  const intent = context.turnIntent;
  const triggers: RuntimeFinalReviewTrigger[] = [];
  if (intent.status === 'resolved' && intent.deliverable === 'report') triggers.push('report');
  if (input.selectionPresent) triggers.push('selection');
  // Source access, not a source call: authorized source-derived history reaches
  // the prompt without one. Read the raw declaration: a malformed source field is
  // still a source declaration.
  if (input.sourceScope?.hasCodebaseAccess ||
    (input.rawDeclaration !== undefined && input.rawDeclaration !== null && !hasNoSourceDeclarations(input.rawDeclaration))) {
    triggers.push('source');
  }
  const investigation = input.investigationRequirements;
  if (investigation?.status === 'resolved' && investigation.requirements.some(requirement =>
    investigationRequirementNeedsReview(requirement, context.investigationEvidence))) triggers.push('investigation');
  // Only claims that passed their own item validation can ever reach `✓`; the
  // hypothetical perfect review judges exactly the valid declared set.
  const declarations = (contract?.claims ?? []).filter(claim => claim.valid !== false);
  if (declarations.length > 0) {
    const perfectReview: FinalSemanticAssessment = {schemaVersion: 'final_semantic_assessment@1',
      ruleVersion: FINAL_SEMANTIC_RULE_VERSION, binding: {snapshotFingerprint: 'hypothetical_review', canonicalCandidate: candidate},
      status: 'checked', consistency: 'consistent',
      coverage: {body: 'complete', claims: 'complete', report: 'not_applicable'},
      claims: declarations.map(claim => ({claimId: claim.id ?? '', consistency: 'consistent', contentLocations: [], issues: []})),
      omissions: [], requirements: []};
    if (joinClaimVerification({contract, draft: input.finiteProofs, semantic: perfectReview, candidate, body,
      bindingEligibility: input.bindingEligibility}).passed) triggers.push('claims_verifiable');
  } else if (intent.status === 'resolved' && intent.taskKind === 'acknowledgement' &&
    (input.bindingEligibility === 'eligible' || input.bindingEligibility === 'legacy_unchecked') &&
    // An acknowledgement rendered from its own proof already has claims not_applicable.
    !(delivery.entry === 'new_finalization' && delivery.outputOrigin === 'evidence_rendered' &&
      delivery.evidenceRenderedProof?.kind === 'acknowledgement')) {
    triggers.push('acknowledgement');
  }
  return triggers;
}

const CASE_PROJECTION_ROUNDS = 3;

/**
 * The one semantic review judges only claims that passed their own item
 * validation (plan A.2): the snapshot's contract carries the valid claims and
 * none of the raw invalid entries, so the review cannot spend its budget on
 * rows outside its scope. Diagnostics keep naming the dropped entries.
 */
function contractForSemanticReview(contract: ConclusionContract | undefined): ConclusionContract | undefined {
  if (!contract) return undefined;
  const claims = contract.claims;
  const invalid = claims?.some(claim => claim.valid === false) === true;
  const hasRaw = (['rawClaims', 'rawRelationProposals', 'rawDeclaration'] as const)
    .some(key => Object.prototype.hasOwnProperty.call(contract, key));
  if (!invalid && !hasRaw) return contract;
  const {rawClaims: _rawClaims, rawRelationProposals: _rawRelations, rawDeclaration: _rawDeclaration, ...rest} = contract;
  return {...rest, ...(claims ? {claims: claims.filter(claim => claim.valid !== false)} : {})};
}

/**
 * Project the hits inside the contract they join, as every later owner surface
 * projects that contract, until the projection stops changing them. A guard can
 * withhold a value or field name a hit's structure requires, such as its match
 * strength; the next projection's normalization then drops that hit (or that
 * recommendation), so a result accepted after one round would differ on every
 * later surface and invalidate the bindings made from this contract.
 */
function withRetrievedCaseRecommendations(sessionId: string, contract: ConclusionContract,
  recommendations: readonly CaseKnowledgeReportRecommendation[]): ConclusionContract {
  let hits = [...recommendations];
  for (let round = 0; round < CASE_PROJECTION_ROUNDS; round++) {
    const projected = projectOwnerConclusionContract(sessionId, {...contract, caseRecommendations: hits})
      ?.caseRecommendations ?? [];
    if (round > 0 && analysisDeliveryFingerprint(projected) === analysisDeliveryFingerprint(hits)) {
      return projected.length ? {...contract, caseRecommendations: projected} : contract;
    }
    hits = projected;
  }
  return contract;
}

function semanticReportAssessment(input: {
  candidate: AnalysisCandidateIdentity; result: AnalysisResult; context: RuntimeFinalizationContext;
  evidenceFingerprint: string; requirements?: PinnedAnalysisReportRequirements; semantic: FinalSemanticAssessment;
}): FinalReportAssessment | undefined {
  const {requirements, semantic, candidate, context, result} = input;
  if (!requirements) return undefined;
  const bound = sameAnalysisCandidate(semantic.binding?.canonicalCandidate, candidate, result.conclusion);
  return {schemaVersion: 1, binding: {...candidate,
    conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
    evidenceFingerprint: input.evidenceFingerprint,
    requirementsFingerprint: reportRequirementsFingerprint(requirements),
    registryFingerprint: context.strategyRegistry.registryFingerprint,
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent)},
    status: !bound ? 'not_checked' : semantic.status === 'checked' || semantic.status === 'coverage_incomplete'
      ? semantic.coverage.report === 'incomplete' ? 'coverage_incomplete' : 'checked'
      : semantic.status,
    requirements: bound ? semantic.requirements : []};
}

/** The only asynchronous final-verification boundary; all acquisition belongs to the run. */
/**
 * Build the investigation assessment.
 *
 * `semantic` is optional because the content rows need the final review and
 * that review is exactly what is missing on the runs worth catching: a
 * conclusion that excludes a mechanism it never measured. Without the review
 * the content side stays `unavailable`, and the ledger-derived acquisition
 * rows are still produced, so the coverage question is answered either way.
 */
function buildInvestigationAssessment(input: {
  candidate: AnalysisCandidateIdentity; result: AnalysisResult; context: RuntimeFinalizationContext;
  evidenceFingerprint: string; requirements: ResolvedAnalysisInvestigationRequirements; semantic?: FinalSemanticAssessment;
}): FinalInvestigationAssessment {
  const {candidate, result, context, requirements, semantic} = input;
  const bound = !!semantic && sameAnalysisCandidate(semantic.binding?.canonicalCandidate, candidate, result.conclusion);
  const investigation = semantic?.investigation;
  const ledgerAcquisition = requirements.status === 'resolved'
    ? assessLedgerAcquisition(requirements.requirements, context.investigationEvidence) : [];
  return {schemaVersion: 1, ...(ledgerAcquisition.length ? {ledgerAcquisition} : {}), binding: {...candidate,
    conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
    evidenceFingerprint: input.evidenceFingerprint, requirementsFingerprint: analysisDeliveryFingerprint(requirements),
    registryFingerprint: context.strategyRegistry.registryFingerprint,
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    ledgerFingerprint: analysisDeliveryFingerprint(context.investigationEvidence ?? null),
    evidenceRecordsFingerprint: analysisDeliveryFingerprint(context.investigationEvidence?.records ?? [])},
    status: !semantic ? 'unavailable' : !bound ? 'not_checked'
      : semantic.status === 'unavailable' || semantic.status === 'not_checked'
      ? semantic.status : semantic.coverage.body !== 'complete' ? 'coverage_incomplete' : investigation?.status ?? 'not_checked',
    evidenceRecords: context.investigationEvidence?.records,
    requirements: bound ? (investigation?.requirements ?? []).map(row => {
      const definition = requirements.requirements.find(requirement => requirement.id === row.requirementId)!;
      return {...row, domain: definition.domain,
        acquisition: assessInvestigationAcquisition(definition, row, context.investigationEvidence)};
    }) : []};
}

/**
 * A scene run's requested product is the committed timeline, read from the
 * sealed, assessed run state rather than from the answer text. The outcome can
 * only lower success: no committed segment means the product was not produced,
 * while a committed timeline never upgrades a native failure (it is retained
 * and stated instead). Completion, origin and quality facts stay as produced.
 */
function applySceneDeliveryOutcome(result: AnalysisResult, outputLanguage: OutputLanguage): void {
  const timeline = result.sceneTimeline;
  if (!timeline) return;
  const segments = timeline.segments.length;
  if (segments === 0) {
    result.success = false;
    result.partial = true;
    result.confidence = 0;
    appendTerminationMessage(result, localize(outputLanguage,
      '场景还原未产出任何被接受的时间线修订，本次运行没有交付场景时间线。',
      'Scene reconstruction produced no accepted timeline revision; this run delivered no scene timeline.'));
  } else if (!result.success) {
    appendTerminationMessage(result, localize(outputLanguage,
      `运行未正常完成；已保留场景时间线修订 ${timeline.revision}（${segments} 段）。`,
      `The run did not complete normally; scene timeline revision ${timeline.revision} (${segments} segments) is retained.`));
  }
}

/** The only asynchronous final-verification boundary; all acquisition belongs to the run. */
export async function finalizeAnalysisResult(input: FinalizeAnalysisResultInput): Promise<FinalizedAnalysisResult> {
  const {context, owner} = input;
  try {
    assertOwner(owner);
    if (input.scene && (input.scene.scope.runId !== owner.runId || input.scene.scope.sessionId !== input.result.sessionId)) {
      throw new Error('scene_finalization_identity_mismatch');
    }
    const sceneSnapshot = input.scene ? consumeSceneRuntimeSeal(input.scene.seal, input.scene.scope) : undefined;
    if (context) {
      if (context.runId !== owner.runId || context.sessionId !== input.result.sessionId || consumedContexts.has(context)) {
        throw new Error('finalization_run_identity_mismatch');
      }
      consumedContexts.add(context);
    }
    // A result without an answer to finalize still carries what its run delivered.
    const deliveryRecord = takeRunDeliveryRecord(input.result);
    if (deliveryRecord && (deliveryRecord.runId !== owner.runId || deliveryRecord.sessionId !== input.result.sessionId)) {
      throw new Error('finalization_run_identity_mismatch');
    }
    const query = input.query;
    const providerQuery = context?.getProviderQuery(owner.signal);
    if (providerQuery?.analysisContextFingerprint !== undefined &&
      providerQuery.analysisContextFingerprint !== owner.analysisContextFingerprint) {
      throw new Error('finalization_authorization_fingerprint_mismatch');
    }
    const {sceneTimeline: _untrustedSceneTimeline, sceneReport: _untrustedSceneReport, ...nativeResult} = input.result;
    const original = frozenSnapshot(nativeResult);
    const conversation = frozenSnapshot(input.conversation);
    const comparisonReportSection = frozenSnapshot(input.comparisonReportSection);
    const suppliedIdentity = frozenSnapshot(input.comparisonIdentity);
    const expectedPair = context?.traceIdentity;
    const pairConflict = suppliedIdentity && expectedPair && (
      (suppliedIdentity.currentTraceId !== undefined && suppliedIdentity.currentTraceId !== expectedPair.currentTraceId) ||
      (suppliedIdentity.referenceTraceId !== undefined && suppliedIdentity.referenceTraceId !== expectedPair.referenceTraceId));
    const comparisonIdentity = expectedPair && (expectedPair.referenceTraceId || suppliedIdentity)
      ? {...(pairConflict ? {} : suppliedIdentity), currentTraceId: expectedPair.currentTraceId,
        referenceTraceId: expectedPair.referenceTraceId} : suppliedIdentity;
    const caseRecommendations = frozenSnapshot(input.caseRecommendations);
    const nativeDeclaration = context?.getNativeDeclaration(original, owner.signal);
    const canonical = canonicalizeAnalysisResult(original, {context: context?.deliveryContext, nativeDeclaration, conversation});
    if (!isIssuedCanonicalAnalysisProjection(canonical.projection)) throw new Error('unissued_canonical_projection');
    const result = canonical.result;
    const candidate = canonical.projection.candidate ?? {runId: owner.runId,
      attemptId: 'unconfirmed', candidateRef: `unconfirmed-${randomUUID()}`,
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
    let delivery: AnalysisDeliveryContext = {entry: 'new_finalization', acceptedCandidate: candidate};
    if (canonical.projection.candidate && canonical.deliveryContext?.entry !== 'historical_restore') {
      delivery = {...canonical.deliveryContext, entry: 'new_finalization', acceptedCandidate: candidate,
        turnIntent: context?.turnIntent};
    }
    const sourceUse = context?.sourceUse;
    const sourceScope = context?.sourceScope;
    const rawDeclaration = canonical.protocolDiagnostics?.sidecar.rawPayload ??
      canonical.protocolDiagnostics?.typedJson?.rawPayload ?? nativeDeclaration?.contract ?? original.conclusionContract;
    const sourceNotApplicable = Boolean(context && isIssuedFinalizationContext(context) &&
      canonical.bindingEligibility === 'eligible' && sourceScopeHasNoAccess(sourceScope, sourceUse) &&
      (owner.analysisContextFingerprint === undefined || sourceScope?.analysisContextFingerprint === owner.analysisContextFingerprint) &&
      (providerQuery?.analysisContextFingerprint === undefined || sourceScope?.analysisContextFingerprint === providerQuery.analysisContextFingerprint) &&
      hasNoSourceDeclarations(rawDeclaration));
    const sourceReader = sourceUse ? {getSourceUseDecision: () => sourceUse} : undefined;
    attachSourceUseToAnalysisResult(result, sourceReader);
    const dataEnvelopes = frozenSnapshot(input.dataEnvelopes ?? []) as DataEnvelope[];
    const relations = prepareAnalysisRelations({conclusionContract: canonical.validationContract, dataEnvelopes});
    const validationContract = frozenSnapshot(relations.conclusionContract ?? undefined);
    const prepared = await prepareClaimEvidence({conclusionContract: validationContract,
      relationCandidates: relations.relationCandidates, bindingEligibility: canonical.bindingEligibility,
      identityDataEnvelopes: dataEnvelopes, identityTracePin: context?.traceIdentity,
      evidenceReadView: context ? {resolveReferences: (requests, signal) => context.resolveReferences(requests, signal ?? owner.signal)} : undefined,
      signal: owner.signal});
    assertOwner(owner);
    const evidenceSnapshot = preparedClaimEvidenceSnapshot(prepared);
    const evidenceFingerprint = analysisDeliveryFingerprint(evidenceSnapshot);
    const draft = runClaimVerification({conclusionContract: validationContract, dataEnvelopes,
      comparisonReportSection, relationCandidates: relations.relationCandidates,
      relationActivationClaimIds: relations.relationActivationClaimIds, preparedEvidence: prepared,
      bindingEligibility: canonical.bindingEligibility, policy: 'record_only'});
    const requirements = context ? pinnedRequirements(context) : undefined;
    const investigationRequirements = context ? resolveAnalysisInvestigationRequirements({
      intent: context.turnIntent, strategyRegistry: context.strategyRegistry}) : undefined;
    let semantic: FinalSemanticAssessment | undefined;
    const selectionScope = context?.getSelection(owner.signal);
    const declaredClaimCount = validationContract?.claims?.length ?? 0;
    // An ineligible declaration keeps its own unchecked reason; its review is never sent.
    const reviewTriggers = context && canonical.bindingEligibility !== 'ineligible' ? semanticReviewTriggers({
      context, delivery, selectionPresent: selectionScope?.present === true, sourceScope, rawDeclaration,
      investigationRequirements, contract: validationContract, finiteProofs: draft.claimVerificationResult,
      candidate, body: result.conclusion,
      bindingEligibility: canonical.bindingEligibility}) : undefined;
    if (context) {
      recordRuntimeFinalReview(currentRuntimePerformanceRecorder(), {
        necessity: !reviewTriggers ? 'declaration_ineligible' : reviewTriggers.length ? 'required' : 'not_required',
        triggers: reviewTriggers ?? [], declaredClaimCount});
    }
    if (context && reviewTriggers?.length === 0) {
      // Bound to the candidate and every input of the necessity decision, hashed once.
      semantic = semanticReviewNotRequired(candidate, analysisDeliveryFingerprint({decision: 'not_required',
        candidate, bindingEligibility: canonical.bindingEligibility, declaredClaimCount,
        turnIntent: context.turnIntent, hasCodebaseAccess: sourceScope?.hasCodebaseAccess === true,
        investigationRequirements: investigationRequirements ?? null, finiteProofs: draft.claimVerificationResult}));
    } else if (context) {
      const diagnostics = canonical.protocolDiagnostics;
      const snapshot: FinalSemanticSnapshot = {inputCoverage: 'complete', declarationBindingEligibility: canonical.bindingEligibility,
        query: providerQuery?.text ?? query,
        body: result.conclusion, conclusionContract: contractForSemanticReview(validationContract), evidenceSnapshot, sourceUse,
        capabilitySnapshot: context.capabilityEvidence, reportRequirements: requirements,
        investigationRequirements,
        ...(selectionScope ? {selectionScope} : {}),
        protocolDiagnostics: diagnostics ? {sidecar: {status: diagnostics.sidecar.status,
          issues: diagnostics.sidecar.issues, bindingEligibility: diagnostics.sidecar.bindingEligibility},
          // typedJson status/issues decide eligibility too; dropping the channel
          // would hide the exact reason a declaration was ruled ineligible.
          ...(diagnostics.typedJson ? {typedJson: {status: diagnostics.typedJson.status,
            issues: diagnostics.typedJson.issues}} : {}),
          conversation: diagnostics.conversation ? {status: diagnostics.conversation.status,
            issues: diagnostics.conversation.issues} : undefined} : undefined};
      // This query was accepted as provider input in the same run. The echo guard
      // still protects it in output and in every other role in this snapshot.
      const projectSnapshot = (value: FinalSemanticSnapshot) => withOwnerCodeAwareProjection(() =>
        projectConclusionSemanticInput({sessionId: result.sessionId, snapshot: value, prepared,
          providerQuery: providerQuery?.text, providerSelection: selectionScope, nativeDeclaration,
          ...(isIssuedFinalizationContext(context) ? {canonicalProjection: canonical.projection,
            canonicalCandidate: candidate, runId: context.runId} : {})}));
      const safeProjection = (value: FinalSemanticSnapshot, projected: ReturnType<typeof projectSnapshot>): FinalSemanticSnapshot =>
        projected.changed ? {...value, inputCoverage: 'incomplete',
          inputProjectionIssue: projected.limited ? 'structure_limit' : 'content_projection', query: '', body: result.conclusion,
          conclusionContract: undefined, protocolDiagnostics: undefined, evidenceSnapshot: null,
          sourceUse: undefined, capabilitySnapshot: undefined, investigationEvidence: undefined}
          : compactSemanticSourceSnapshot({...projected.value,
            evidenceSnapshot: compactSemanticEvidenceSnapshot(projected.value.evidenceSnapshot)});
      let safeSnapshot: FinalSemanticSnapshot;
      if (!context.investigationEvidence) {
        safeSnapshot = safeProjection(snapshot, projectSnapshot(snapshot));
      } else {
        // Select the largest complete-cohort ledger projection that fits the exact
        // shared prompt assembly. Every candidate crosses the same security boundary.
        // The search runs over the budgets where a cohort enters the view, so each
        // round sizes a distinct view: the prompt is assembled synchronously and
        // its cost comes out of the review's own deadline.
        const budgets = investigationEvidenceSemanticBudgets(context.investigationEvidence);
        let low = 0, high = budgets.length - 1;
        let best: FinalSemanticSnapshot | undefined;
        let smallestOverLimit: FinalSemanticSnapshot | undefined;
        let unsafe: FinalSemanticSnapshot | undefined;
        let templateUnavailable: FinalSemanticSnapshot | undefined;
        while (low <= high) {
          const index = Math.floor((low + high) / 2);
          const ledger = compactInvestigationEvidenceForSemantic(context.investigationEvidence, budgets[index]);
          if (!ledger) break;
          const value = {...snapshot, investigationEvidence: ledger};
          const projected = projectSnapshot(value);
          const candidateSnapshot = safeProjection(value, projected);
          if (projected.changed) {unsafe = candidateSnapshot; break;}
          let assembled: ReturnType<typeof buildFinalSemanticPrompt>;
          try {assembled = buildFinalSemanticPrompt({snapshot: candidateSnapshot, intent: context.turnIntent,
            traceIdentity: context.traceIdentity, registryFingerprint: context.strategyRegistry.registryFingerprint});}
          catch {templateUnavailable = candidateSnapshot; break;}
          if (!assembled) {templateUnavailable = candidateSnapshot; break;}
          const bytes = Buffer.byteLength(assembled.prompt, 'utf8');
          if (bytes <= FINAL_SEMANTIC_INPUT_BYTE_LIMIT) {best = candidateSnapshot; low = index + 1;}
          // The search only moves down after an overflow, so the latest one is the smallest.
          else {smallestOverLimit = candidateSnapshot; high = index - 1;}
        }
        // The ledger-free view is projected only when no ledger view was selected.
        const noLedgerFits = (): FinalSemanticSnapshot => {
          const baseProjection = safeProjection(snapshot, projectSnapshot(snapshot));
          return baseProjection.inputCoverage === 'complete'
            ? {...baseProjection, inputCoverage: 'incomplete', inputProjectionIssue: 'semantic_input_limit'}
            : baseProjection;
        };
        safeSnapshot = unsafe ?? templateUnavailable ?? best ?? smallestOverLimit ?? noLedgerFits();
      }
      assertOwner(owner);
      const report = (event: FinalizationProgressEvent) => {
        try { input.onProgress?.(event); } catch { /* Progress observers never change finalization. */ }
      };
      const deliverProvisional = (): boolean => {
        const onProvisionalAnswer = input.onProvisionalAnswer;
        if (!onProvisionalAnswer || input.scene || !result.conclusion.trim()) return false;
        try {
          assertOwner(owner);
          return onProvisionalAnswer({conclusion: result.conclusion}) !== false;
        } catch { return false; /* Delivery observers never change finalization. */ }
      };
      let reviewDispatched = false;
      semantic = await assessFinalSemantics({context, canonicalCandidate: candidate, snapshot: safeSnapshot, signal: owner.signal,
        ...(input.reviewStopSignal ? {stopSignal: input.reviewStopSignal} : {}),
        onDispatch: ({deadlineMs}) => {
          reviewDispatched = true;
          report({stage: 'final_review_started', deadlineAt: deadlineMs, ...(deliverProvisional() ? {answerReadable: true} : {})});
        }});
      assertOwner(owner);
      if (reviewDispatched) {
        report({stage: 'final_review_finished', status: semantic.status, ...(semantic.reason ? {reason: semantic.reason} : {})});
      }
    }
    result.claimVerificationResult = joinClaimVerification({contract: validationContract, draft: draft.claimVerificationResult,
      claimSupport: draft.claimSupport, semantic, candidate, body: result.conclusion,
      bindingEligibility: canonical.bindingEligibility});
    const statusByClaim = new Map(result.claimVerificationResult.claimResults.map(claim => [claim.claimId, claim.status]));
    result.claimSupport = draft.claimSupport.map(support => {
      const status = statusByClaim.get(support.claimId);
      return {...support, supportLevel: status === 'verified' || status === 'unsupported' || status === 'inference'
        ? status : 'partial'};
    });
    result.identityResolutions = preparedIdentityResolutions(prepared);
    result.sourceClaimVerificationResult = verifySourceClaimBindings({conclusionContract: validationContract,
      actualSourceUseDecision: sourceUse, body: result.conclusion,
      matchedTraceEvidenceRefIdsByClaimId: collectMatchedTraceEvidenceRefIdsByClaimId(result.claimVerificationResult)});
    if (nativeDeclaration) {
      // The verdict is computed from original values. Only its owner-safe projection enters private delivery artifacts.
      const storedContract = projectStoredConclusionSourceMetadata(validationContract, result.sourceUseDecision);
      const ownerContract = projectOwnerConclusionContract(result.sessionId, storedContract);
      if (!ownerContract && ((validationContract?.claims?.length ?? 0) > 0 || result.claimVerificationResult.passed)) {
        throw new Error('owner_conclusion_contract_projection_failed');
      }
      result.conclusionContract = ownerContract;
      result.claimVerificationResult = projectOwnerClaimVerification(result.sessionId, result.claimVerificationResult)!;
      result.claimSupport = projectOwnerClaimSupport(result.sessionId, result.claimSupport);
    }
    // After the contract's owner projection, before any binding fingerprints it.
    if (result.conclusionContract && caseRecommendations?.length) {
      result.conclusionContract = withRetrievedCaseRecommendations(result.sessionId, result.conclusionContract,
        caseRecommendations);
    }
    // Only finalization records knowledge use, from the run's own delivery
    // record (its context's, or the record a contextless failure keeps) and
    // the final body; a runtime-supplied value never survives. It is display
    // and audit: no verification or delivery verdict reads it.
    const knowledgeUse = buildKnowledgeUse(context ? context.knowledgeUse : deliveryRecord?.knowledgeUse,
      result.conclusion);
    if (knowledgeUse) result.knowledgeUse = knowledgeUse;
    else delete result.knowledgeUse;
    const claimsFingerprint = analysisDeliveryFingerprint(result.conclusionContract?.claims ?? []);
    const sourceUseFingerprint = analysisDeliveryFingerprint(result.sourceUseDecision);
    const sourceScopeFingerprint = sourceScope ? analysisDeliveryFingerprint(sourceScope) : undefined;
    delivery = {...delivery, evidenceFingerprint, sourceUseFingerprint, sourceScopeFingerprint,
      sourceApplicability: sourceNotApplicable && semantic?.coverage.body === 'complete' &&
        semantic.coverage.claims === 'complete' && semantic.omissions.length === 0 ? 'not_applicable' : undefined,
      claimVerificationBinding: {candidate, claimsFingerprint, evidenceFingerprint,
        verificationFingerprint: analysisDeliveryFingerprint(result.claimVerificationResult)},
      sourceVerificationBinding: result.sourceClaimVerificationResult ? {candidate, claimsFingerprint, evidenceFingerprint,
        sourceUseFingerprint, sourceScopeFingerprint, conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
        verificationFingerprint: analysisDeliveryFingerprint(result.sourceClaimVerificationResult)} : undefined,
      reportRequirements: requirements,
      investigationRequirements, investigationEvidence: context?.investigationEvidence,
      investigationAssessment: context && investigationRequirements ? buildInvestigationAssessment({
        candidate, result, context, evidenceFingerprint, requirements: investigationRequirements, semantic}) : undefined,
      reportAssessment: context && semantic ? semanticReportAssessment({candidate, result, context,
        evidenceFingerprint, requirements, semantic}) : undefined};
    assertOwner(owner);
    const qualityIssue = applyFinalResultQualityGate({result, query, context: delivery, comparisonIdentity});
    assertOwner(owner);
    if (sceneSnapshot && input.scene) {
      result.sceneTimeline = projectSceneTimelineForOwner(assessSceneTimeline(sceneSnapshot, input.scene.scope));
      if (result.sceneTimeline.status === 'partial') result.partial = true;
      applySceneDeliveryOutcome(result, input.scene.outputLanguage);
    }
    // Revision 0 has nothing to archive: an empty timeline is not published as a scene report.
    const scenePublication = result.sceneTimeline?.segments.length && input.scene ? issueSceneTimelinePublication({
      scope: input.scene.scope, assessment: result.sceneTimeline, summary: result.conclusion,
      outputLanguage: input.scene.outputLanguage, totalDurationMs: result.totalDurationMs,
      providerId: input.scene.providerId, runtimeKind: result.completion?.runtimeKind,
      registryFingerprint: context?.strategyRegistry.registryFingerprint,
    }) : undefined;
    return {result, qualityIssue, semanticAssessment: semantic,
      ...(scenePublication ? {scenePublication} : {}),
      ...(canonical.conversationOutcome ? {conversationOutcome: {...canonical.conversationOutcome, message: result.conclusion}} : {})};
  } finally {
    context?.dispose();
  }
}
