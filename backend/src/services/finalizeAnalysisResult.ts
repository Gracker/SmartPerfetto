// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'node:crypto';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import type {ConclusionContract} from '../agent/core/conclusionContract';
import {
  takeRunDeliveryRecord,
  type RuntimeFinalizationContext,
} from '../agentRuntime/analysisFinalizationContext';
import type {DataEnvelope} from '../types/dataContract';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity, type AnalysisDeliveryContext} from '../types/analysisDelivery';
import type {CaseKnowledgeReportRecommendation} from '../types/caseKnowledge';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection} from './canonicalAnalysisResult';
import {attachSourceUseToAnalysisResult, verifySourceCitations} from './codebase/sourceClaimVerifier';
import {buildKnowledgeUse} from './knowledge/knowledgeUse';
import {resolveRunCapturedIdentities} from './processIdentity/capturedIdentity';
import {appendTerminationMessage, applyFinalResultQualityGate, type FinalResultComparisonIdentity,
  type FinalResultQualityIssue} from './finalResultQualityGate';
import {projectStoredConclusionSourceMetadata} from './security/analysisDeliveryProjection';
import type {SourceExecutionScopeV1, SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {projectOwnerConclusionContract} from './security/privateAnalysisProjection';
import {resolveAnalysisInvestigationRequirements} from '../agentRuntime/analysisInvestigationRequirements';
import {assessLedgerAcquisition} from './finalInvestigationContractGate';
import type {ResolvedAnalysisInvestigationRequirements} from '../types/analysisInvestigation';
import type {FinalInvestigationAssessment} from '../types/analysisInvestigationAssessment';
import {consumeSceneRuntimeSeal, type SceneRuntimeSeal} from '../agent/scene/sceneRuntimeBinding';
import {assessSceneTimeline} from '../agent/scene/sceneTimelineAssessment';
import {projectSceneTimelineForOwner} from '../agent/scene/sceneTimelineProjection';
import type {SceneScope} from '../agent/scene/sceneTimelineContract';
import {issueSceneTimelinePublication, type SceneTimelinePublication} from '../agent/scene/sceneTimelinePublication';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';

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
  comparisonIdentity?: FinalResultComparisonIdentity;
  /** Curated-case hits the server retrieved for this run. */
  caseRecommendations?: readonly CaseKnowledgeReportRecommendation[];
  conversation?: NonNullable<Parameters<typeof canonicalizeAnalysisResult>[1]>['conversation'];
  /** Issued product sidecar, separate from a provider's accepted body or result JSON. */
  scene?: {seal: SceneRuntimeSeal; scope: SceneScope; outputLanguage: OutputLanguage; providerId?: string | null};
}

export interface FinalizedAnalysisResult {
  result: AnalysisResult;
  qualityIssue?: FinalResultQualityIssue;
  conversationOutcome?: ReturnType<typeof canonicalizeAnalysisResult>['conversationOutcome'];
  scenePublication?: SceneTimelinePublication;
}

const consumedContexts = new WeakSet<RuntimeFinalizationContext>();

/**
 * Whether this run could read source at all. Only the run's own authorization
 * scope and source ledger decide it, never the answer text: a public stack
 * frame such as `Foo.java:123` in an ANR answer is not a source citation the
 * product can check when no codebase was selected.
 */
function hasSourceAccess(scope: Readonly<SourceExecutionScopeV1> | undefined,
  sourceUse: SourceUseDecisionV1 | undefined): boolean {
  return scope?.hasCodebaseAccess === true || sourceUse !== undefined;
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

/** Server-owned carrier for retrieved case hits when the answer yields no derived structure. */
function serverConclusionCarrier(mode: ConclusionContract['mode']): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode, conclusions: [], clusters: [], evidenceChain: [],
    uncertainties: [], nextSteps: []};
}

const CASE_PROJECTION_ROUNDS = 3;

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

/**
 * Record-only investigation display: the producer ledger's acquisition rows and
 * retained evidence records. The answer's coverage is not assessed (no content
 * rows), and nothing here sets an assurance status.
 */
function buildInvestigationRecord(input: {
  candidate: AnalysisCandidateIdentity; result: AnalysisResult; context: RuntimeFinalizationContext;
  evidenceFingerprint: string; requirements: ResolvedAnalysisInvestigationRequirements;
}): FinalInvestigationAssessment | undefined {
  const {candidate, result, context, requirements} = input;
  const ledger = context.investigationEvidence;
  const ledgerAcquisition = requirements.status === 'resolved' ? assessLedgerAcquisition(requirements.requirements, ledger) : [];
  const evidenceRecords = ledger?.records;
  if (!ledgerAcquisition.length && !evidenceRecords?.length) return undefined;
  return {schemaVersion: 1, ...(ledgerAcquisition.length ? {ledgerAcquisition} : {}), binding: {...candidate,
    conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
    evidenceFingerprint: input.evidenceFingerprint, requirementsFingerprint: analysisDeliveryFingerprint(requirements),
    registryFingerprint: context.strategyRegistry.registryFingerprint,
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    // The issued ledger snapshot already carries its content fingerprint; only the records are hashed here.
    ledgerFingerprint: ledger?.fingerprint ?? analysisDeliveryFingerprint(null),
    evidenceRecordsFingerprint: analysisDeliveryFingerprint(evidenceRecords ?? [])},
    status: 'not_checked', evidenceRecords, requirements: []};
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

/** The only finalization boundary; all acquisition belongs to the run. */
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
    const suppliedIdentity = frozenSnapshot(input.comparisonIdentity);
    const expectedPair = context?.traceIdentity;
    const pairConflict = suppliedIdentity && expectedPair && (
      (suppliedIdentity.currentTraceId !== undefined && suppliedIdentity.currentTraceId !== expectedPair.currentTraceId) ||
      (suppliedIdentity.referenceTraceId !== undefined && suppliedIdentity.referenceTraceId !== expectedPair.referenceTraceId));
    const comparisonIdentity = expectedPair && (expectedPair.referenceTraceId || suppliedIdentity)
      ? {...(pairConflict ? {} : suppliedIdentity), currentTraceId: expectedPair.currentTraceId,
        referenceTraceId: expectedPair.referenceTraceId} : suppliedIdentity;
    const caseRecommendations = frozenSnapshot(input.caseRecommendations);
    const canonical = canonicalizeAnalysisResult(original, {context: context?.deliveryContext, conversation});
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
    attachSourceUseToAnalysisResult(result, sourceUse ? {getSourceUseDecision: () => sourceUse} : undefined);
    // Identity resolution reads only the run's own data envelopes, never the answer.
    const identity = await resolveRunCapturedIdentities({
      dataEnvelopes: frozenSnapshot(input.dataEnvelopes ?? []) as DataEnvelope[],
      tracePin: context?.traceIdentity,
      resolveReferences: context ? requests => context.resolveReferences(requests, owner.signal) : undefined,
      signal: owner.signal,
    });
    assertOwner(owner);
    const investigationRequirements = context ? resolveAnalysisInvestigationRequirements({
      intent: context.turnIntent, strategyRegistry: context.strategyRegistry}) : undefined;
    result.identityResolutions = identity.identities;
    // Source citations are a quality annotation against the run's own ledger. Without
    // source access, or with access but no written citation, there is nothing to store.
    const sourceVerification = hasSourceAccess(sourceScope, sourceUse)
      ? verifySourceCitations({body: result.conclusion, sourceUse}) : undefined;
    if (sourceVerification && sourceVerification.status !== 'not_checked') {
      result.sourceClaimVerificationResult = sourceVerification;
    } else delete result.sourceClaimVerificationResult;
    if (context) {
      // Only the owner-safe projection enters private delivery artifacts.
      const storedContract = projectStoredConclusionSourceMetadata(result.conclusionContract, result.sourceUseDecision);
      const ownerContract = projectOwnerConclusionContract(result.sessionId, storedContract);
      // A present contract must survive projection.
      if (result.conclusionContract !== undefined && ownerContract === undefined) {
        throw new Error('owner_conclusion_contract_projection_failed');
      }
      result.conclusionContract = ownerContract;
    }
    // After the contract's owner projection, before any binding fingerprints it.
    // Case hits are server retrieval, so they attach with or without derived structure.
    if (caseRecommendations?.length) {
      const intent = context?.turnIntent;
      const carrier = result.conclusionContract ?? serverConclusionCarrier(
        intent?.status === 'resolved' && intent.deliverable === 'answer' ? 'focused_answer' : 'initial_report');
      const withCases = withRetrievedCaseRecommendations(result.sessionId, carrier, caseRecommendations);
      if (result.conclusionContract || withCases.caseRecommendations?.length) result.conclusionContract = withCases;
    }
    // Only finalization records knowledge use, from the run's own delivery
    // record (its context's, or the record a contextless failure keeps) and
    // the final body; a runtime-supplied value never survives. It is display
    // and audit: no verification or delivery verdict reads it.
    const knowledgeUse = buildKnowledgeUse(context ? context.knowledgeUse : deliveryRecord?.knowledgeUse,
      result.conclusion);
    if (knowledgeUse) result.knowledgeUse = knowledgeUse;
    else delete result.knowledgeUse;
    delivery = {...delivery, investigationRequirements, investigationEvidence: context?.investigationEvidence,
      investigationAssessment: context && investigationRequirements ? buildInvestigationRecord({
        candidate, result, context, evidenceFingerprint: identity.readsFingerprint,
        requirements: investigationRequirements}) : undefined};
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
    return {result, qualityIssue,
      ...(scenePublication ? {scenePublication} : {}),
      ...(canonical.conversationOutcome ? {conversationOutcome: {...canonical.conversationOutcome, message: result.conclusion}} : {})};
  } finally {
    context?.dispose();
  }
}
