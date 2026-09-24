// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'node:crypto';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import type {ConclusionBindingEligibility, ConclusionContract} from '../agent/core/conclusionContract';
import {isIssuedFinalizationContext, type RuntimeFinalizationContext} from '../agentRuntime/analysisFinalizationContext';
import type {ComparisonReportSection} from '../agentv3/sessionStateSnapshot';
import {getFinalReportContract} from '../agentv3/strategyLoader';
import type {DataEnvelope} from '../types/dataContract';
import {analysisDeliveryFingerprint, reportRequirementsFingerprint, sameAnalysisCandidate,
  type AnalysisCandidateIdentity, type AnalysisCaseRetrievalState, type AnalysisDeliveryContext,
  type FinalReportAssessment, type PinnedAnalysisReportRequirements} from '../types/analysisDelivery';
import type {ClaimVerificationResult, ClaimVerificationClaimResult, ClaimVerificationIssue} from '../types/claimVerification';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection} from './canonicalAnalysisResult';
import {attachSourceUseToAnalysisResult, verifySourceClaimBindings} from './codebase/sourceClaimVerifier';
import {prepareAnalysisRelations} from './evidence/analysisRelationPreparation';
import {prepareClaimEvidence, preparedClaimEvidenceSnapshot, preparedIdentityResolutions} from './evidence/claimEvidencePreparation';
import {runClaimVerification, collectMatchedTraceEvidenceRefIdsByClaimId,
  collectVerifiedTraceOccurrenceRefIdsByClaimId} from './verifier/claimVerificationRunner';
import {assessFinalSemantics, buildFinalSemanticPrompt, FINAL_SEMANTIC_INPUT_BYTE_LIMIT,
  type FinalSemanticAssessment, type FinalSemanticSnapshot} from './finalSemanticAssessment';
import {SEMANTIC_UNDECLARED_CLAIM_ISSUE_CODE, semanticClaimIssueCode} from './finalSemanticIssueCodes';
import {appendTerminationMessage, applyFinalResultQualityGate, type FinalResultComparisonIdentity,
  type FinalResultQualityIssue} from './finalResultQualityGate';
import {projectCodeAwareStructuredText, withOwnerCodeAwareProjection} from './security/codeAwareOutputRegistry';
import {projectConclusionSemanticInput} from './security/conclusionProtocolProjection';
import {projectStoredConclusionSourceMetadata} from './security/analysisDeliveryProjection';
import {compactSemanticEvidenceSnapshot} from './evidence/semanticEvidenceSnapshot';
import {compactSemanticSourceSnapshot} from './evidence/semanticSourceSnapshot';
import {compactInvestigationEvidenceForSemantic} from './evidence/investigationEvidenceLedger';
import {applySourceLocationProofs} from './codebase/sourceLocationProof';
import {isUnusedSourceDecision, type SourceExecutionScopeV1, type SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {projectOwnerClaimVerification, projectOwnerClaimSupport,
  projectOwnerConclusionContract} from './security/privateAnalysisProjection';
import {resolveAnalysisInvestigationRequirements} from '../agentRuntime/analysisInvestigationRequirements';
import {assessInvestigationAcquisition, assessLedgerAcquisition} from './finalInvestigationContractGate';
import type {ResolvedAnalysisInvestigationRequirements} from '../types/analysisInvestigation';
import type {FinalInvestigationAssessment} from '../types/analysisInvestigationAssessment';
import {consumeSceneRuntimeSeal, type SceneRuntimeSeal} from '../agent/scene/sceneRuntimeBinding';
import {assessSceneTimeline} from '../agent/scene/sceneTimelineAssessment';
import {projectSceneTimelineForOwner} from '../agent/scene/sceneTimelineProjection';
import type {SceneScope} from '../agent/scene/sceneTimelineContract';
import {issueSceneTimelinePublication, type SceneTimelinePublication} from '../agent/scene/sceneTimelinePublication';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {FinalizationProgressEvent, FinalizationProgressObserver} from './finalizationProgress';

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
  caseRetrieval?: AnalysisCaseRetrievalState;
  conversation?: NonNullable<Parameters<typeof canonicalizeAnalysisResult>[1]>['conversation'];
  /** Issued product sidecar, separate from a provider's accepted body or result JSON. */
  scene?: {seal: SceneRuntimeSeal; scope: SceneScope; outputLanguage: OutputLanguage; providerId?: string | null};
  /**
   * Live progress for the one semantic review: `final_review_started` only when
   * a provider request is actually sent, then exactly one `final_review_finished`.
   * Observer failures are ignored; they never change finalization.
   */
  onProgress?: FinalizationProgressObserver;
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

/** Finite proof never promotes itself; the full current proposition must agree with the body. */
function joinClaimVerification(input: {
  contract?: ConclusionContract;
  draft: ClaimVerificationResult;
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
  const claimResults: ClaimVerificationClaimResult[] = declarations.map(claim => {
    const id = claim.id ?? '';
    const drafts = draft.claimResults.filter(item => item.claimId === id);
    const reviews = semantic?.claims.filter(item => item.claimId === id) ?? [];
    const prior = drafts.length === 1 ? drafts[0] : undefined;
    const review = reviews.length === 1 ? reviews[0] : undefined;
    const unique = id.length > 0 && declarations.filter(item => item.id === id).length === 1;
    if (!unique || !prior || !eligible) return {...prior, claimId: id, status: 'not_checked'};
    if (prior.status === 'unsupported' || prior.deterministicProof?.status === 'rejected') {
      return {...prior, status: 'unsupported'};
    }
    if (bound && review?.consistency === 'inconsistent') {
      for (const issue of review.issues) issues.push({claimId: id, severity: 'error',
        code: semanticClaimIssueCode(issue.code), message: `Claim ${id}: ${issue.code}`});
      return {...prior, status: 'unsupported'};
    }
    if (!complete || review?.consistency !== 'consistent') return {...prior, status: 'partial'};
    const semantics = claim.semantics;
    if (semantics && (semantics.discourse !== 'asserted' || semantics.modality !== 'certain' ||
      claim.kind === 'inference' || claim.kind === 'recommendation')) {
      return {...prior, status: 'inference'};
    }
    return {...prior, status: prior.deterministicProof?.status === 'proved' &&
      prior.propositionCoverage?.status === 'complete' ? 'verified' : 'partial'};
  });
  if (bound && semantic?.omissions.length) issues.push({claimId: '', severity: 'error',
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
      : !passed && !failed ? {notCheckedReason: 'complete_proposition_review_unavailable'} : {})};
}

function semanticReportAssessment(input: {
  candidate: AnalysisCandidateIdentity; result: AnalysisResult; context: RuntimeFinalizationContext;
  evidenceFingerprint: string; requirements?: PinnedAnalysisReportRequirements;
  caseRetrieval?: AnalysisCaseRetrievalState; semantic: FinalSemanticAssessment;
}): FinalReportAssessment | undefined {
  const {requirements, semantic, candidate, context, result} = input;
  if (!requirements) return undefined;
  const bound = sameAnalysisCandidate(semantic.binding?.canonicalCandidate, candidate, result.conclusion);
  return {schemaVersion: 1, binding: {...candidate,
    conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
    evidenceFingerprint: input.evidenceFingerprint,
    requirementsFingerprint: reportRequirementsFingerprint(requirements),
    registryFingerprint: context.strategyRegistry.registryFingerprint,
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    caseRetrievalFingerprint: analysisDeliveryFingerprint(input.caseRetrieval)},
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
    const caseRetrieval = frozenSnapshot(input.caseRetrieval ?? (context?.deliveryContext.entry !== 'historical_restore'
      ? context?.deliveryContext.caseRetrieval : undefined));
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
    if (context) {
      const diagnostics = canonical.protocolDiagnostics;
      const selectionScope = context.getSelection(owner.signal);
      const snapshot: FinalSemanticSnapshot = {inputCoverage: 'complete', declarationBindingEligibility: canonical.bindingEligibility,
        query: providerQuery?.text ?? query,
        body: result.conclusion, conclusionContract: validationContract, evidenceSnapshot, sourceUse,
        capabilitySnapshot: context.capabilityEvidence, reportRequirements: requirements, caseRetrieval,
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
          sourceUse: undefined, capabilitySnapshot: undefined, caseRetrieval: undefined, investigationEvidence: undefined}
          : compactSemanticSourceSnapshot({...projected.value,
            evidenceSnapshot: compactSemanticEvidenceSnapshot(projected.value.evidenceSnapshot)});
      let safeSnapshot: FinalSemanticSnapshot;
      if (!context.investigationEvidence) {
        safeSnapshot = safeProjection(snapshot, projectSnapshot(snapshot));
      } else {
        // Select the largest complete-cohort ledger projection that fits the exact
        // shared prompt assembly. Every candidate crosses the same security boundary.
        let low = 0, high = FINAL_SEMANTIC_INPUT_BYTE_LIMIT;
        let best: FinalSemanticSnapshot | undefined;
        let smallestOverLimit: {budget: number; snapshot: FinalSemanticSnapshot} | undefined;
        let unsafe: FinalSemanticSnapshot | undefined;
        let templateUnavailable: FinalSemanticSnapshot | undefined;
        while (low <= high) {
          const budget = Math.floor((low + high) / 2);
          const ledger = compactInvestigationEvidenceForSemantic(context.investigationEvidence, budget);
          if (!ledger) {low = budget + 1; continue;}
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
          if (bytes <= FINAL_SEMANTIC_INPUT_BYTE_LIMIT) {best = candidateSnapshot; low = budget + 1;}
          else {
            if (!smallestOverLimit || budget < smallestOverLimit.budget) smallestOverLimit = {budget, snapshot: candidateSnapshot};
            high = budget - 1;
          }
        }
        const baseProjection = safeProjection(snapshot, projectSnapshot(snapshot));
        const noLedgerFits = baseProjection.inputCoverage === 'complete'
          ? {...baseProjection, inputCoverage: 'incomplete' as const, inputProjectionIssue: 'semantic_input_limit' as const}
          : baseProjection;
        safeSnapshot = unsafe ?? templateUnavailable ?? best ?? smallestOverLimit?.snapshot ?? noLedgerFits;
      }
      assertOwner(owner);
      const report = (event: FinalizationProgressEvent) => {
        try { input.onProgress?.(event); } catch { /* Progress observers never change finalization. */ }
      };
      let reviewDispatched = false;
      semantic = await assessFinalSemantics({context, canonicalCandidate: candidate, snapshot: safeSnapshot, signal: owner.signal,
        onDispatch: ({deadlineMs}) => {
          reviewDispatched = true;
          report({stage: 'final_review_started', deadlineAt: deadlineMs});
        }});
      assertOwner(owner);
      if (reviewDispatched) {
        report({stage: 'final_review_finished', status: semantic.status, ...(semantic.reason ? {reason: semantic.reason} : {})});
      }
    }
    const finiteProofs = applySourceLocationProofs({contract: validationContract, sourceUse,
      draft: draft.claimVerificationResult});
    result.claimVerificationResult = joinClaimVerification({contract: validationContract, draft: finiteProofs,
      semantic, candidate, body: result.conclusion, bindingEligibility: canonical.bindingEligibility});
    const statusByClaim = new Map(result.claimVerificationResult.claimResults.map(claim => [claim.claimId, claim.status]));
    result.claimSupport = draft.claimSupport.map(support => {
      const status = statusByClaim.get(support.claimId);
      return {...support, supportLevel: status === 'verified' || status === 'unsupported' || status === 'inference'
        ? status : 'partial'};
    });
    result.identityResolutions = preparedIdentityResolutions(prepared);
    result.sourceClaimVerificationResult = verifySourceClaimBindings({conclusionContract: validationContract,
      actualSourceUseDecision: sourceUse, semanticsPolicy: 'declared',
      matchedTraceEvidenceRefIdsByClaimId: collectMatchedTraceEvidenceRefIdsByClaimId(result.claimVerificationResult),
      verifiedTraceOccurrenceRefIdsByClaimId: collectVerifiedTraceOccurrenceRefIdsByClaimId(result.claimVerificationResult)});
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
      reportRequirements: requirements, caseRetrieval,
      investigationRequirements, investigationEvidence: context?.investigationEvidence,
      investigationAssessment: context && investigationRequirements ? buildInvestigationAssessment({
        candidate, result, context, evidenceFingerprint, requirements: investigationRequirements, semantic}) : undefined,
      reportAssessment: context && semantic ? semanticReportAssessment({candidate, result, context,
        evidenceFingerprint, requirements, caseRetrieval, semantic}) : undefined};
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
