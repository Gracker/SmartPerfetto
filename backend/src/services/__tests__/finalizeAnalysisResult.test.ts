// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration, renderConclusionContractSidecar, type ClaimSemanticsV1,
  type ConclusionContract} from '../../agent/core/conclusionContract';
import {
  attachFinalizationContext,
  attachRunDeliveryRecord,
  takeFinalizationContext,
} from '../../agentRuntime/analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../../agentRuntime/intentTransport';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, type StrategyDefinition} from '../../agentv3/strategyLoader';
import * as strategyTemplates from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import type {CaseKnowledgeReportRecommendation} from '../../types/caseKnowledge';
import {createDataEnvelope} from '../../types/dataContract';
import type {EvidenceScopeProvenanceV1, IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable, evidenceCaptureHash} from '../evidence/evidenceCapture';
import {attachInvestigationEvidence, recordCaptureToolCall} from '../evidence/investigationEvidenceLedger';
import type {EvidenceReadView} from '../evidence/evidenceReadView';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../finalizeAnalysisResult';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticAssessment';
import {clearAllCodeAwareOutputGuards, registerCodeAwareCanary,
  registerPrivateAnalysisQueryForEcho, registerOnDemandSourceLookupForEcho, sanitizeCodeAwareText} from '../security/codeAwareOutputRegistry';
import {sanitizeSourceReference, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';
import type {KnowledgeUseRecord} from '../knowledge/knowledgeUse';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../codebase/sourceClaimVerifier';
import {canonicalizeAnalysisResult} from '../canonicalAnalysisResult';
import {claimVerificationStatusLine, deriveDeliveryVerdict, summarizeClaimVerification} from '../analysisInvestigationPresentation';
import {activateSceneRuntime, createSceneRunDispatchBinding, sceneRunOwnerKey} from '../../agent/scene/sceneRuntimeBinding';
import {proposeSceneTimeline} from '../../agent/scene/sceneTimelineProposal';
import {resolveRuntimeEvidenceStore} from '../../agentRuntime/runtimeEvidenceContext';
import {finalReviewProgressUpdate, type FinalizationProgressEvent} from '../finalizationProgress';
import type {AnalysisRunSelection} from '../../agentRuntime/analysisRunSpec';
import type {AnalysisInvestigationRequirement} from '../../types/analysisInvestigation';
import {investigationRequirementNeedsReview} from '../finalInvestigationContractGate';
import {createRunManifestLifecycle, withRunManifestLifecycle, clearRunManifestLifecyclesForTests} from '../selfEvolution/runManifestLifecycle';
import {copyAnalysisResultForSnapshot, projectOwnerAnalysisResult, projectPrivateAnalysisResult} from '../security/privateAnalysisProjection';
import {buildAnalysisReceipt} from '../analysisReceiptBuilder';
import locationFault from '../../../tests/fixtures/location-verdict/fault.json';
import locationNormal from '../../../tests/fixtures/location-verdict/normal.json';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'final-result-test'});

describe('persisted location verdict regressions', () => {
  async function replay(sample: typeof locationFault | typeof locationNormal, reviews: unknown[],
    options: {bodyComplete?: boolean; omissions?: unknown[]} = {}) {
    const declared = parseConclusionContractDeclaration({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: sample.claims}).contract!;
    const result: AnalysisResult = {sessionId: 'location-replay', conclusion: sample.body, conclusionContract: declared,
      success: true, confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
    const store = new ArtifactStore();
    // These are newly issued TEST captures of the fixture's original values.
    // Serialized verifier receipts never become live production capture authority.
    const groups = new Map<string, NonNullable<ConclusionContract['claims']>>();
    for (const claim of declared.claims!) {
      const id = claim.references[0].evidenceRefId!;
      groups.set(id, [...(groups.get(id) ?? []), claim]);
    }
    for (const [evidenceRefId, claims] of groups) {
      const columns = [...new Set(claims.map(claim => claim.references[0].column!))];
      const rowCount = Math.max(...claims.map(claim => claim.references[0].rowIndex!)) + 1;
      const rows = Array.from({length: rowCount}, (_, index) => columns.map(column =>
        claims.find(claim => claim.references[0].rowIndex === index && claim.references[0].column === column)
          ?.references[0].value ?? null));
      const envelope = createDataEnvelope({columns, rows},
      {type: 'sql_result', source: 'execute_sql', title: 'Replay test capture', evidenceRefId,
        traceId: 'trace', traceSide: 'current', executionStatus: 'observed'});
      store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, Object.fromEntries(claims.map(claim =>
        [claim.references[0].column!, {
        ...(claim.semantics?.numeric ? {unit: claim.semantics.numeric.unit} : {}),
        origin: {kind: 'native_producer', definitionFingerprint: 'location-replay-test'}}]))), {meta: envelope.meta, display: envelope.display});
    }
    const runId = 'location-replay';
    const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
    const dispatch = jest.fn(async (): Promise<IntentTransportResult> => ({status: 'ok', text: JSON.stringify({
      schemaVersion: 'final_semantic_response@4',
      bodyCoverage: {status: options.bodyComplete === false ? 'incomplete' : 'complete', reviewedSpans: [{start: 0, end: sample.body.length}]},
      claims: reviews, omissions: options.omissions ?? [], requirements: [], investigation: [],
    })}));
    attachFinalizationContext(result, {runId, sessionId: result.sessionId, deadlineMs: Date.now() + 600_000,
      strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace'},
      turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
        taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
        deliverable: 'answer', evidenceAccess: 'existing_only'},
      deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
        completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}},
      evidenceReadView: store.createEvidenceReadView({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: runId}),
      dispatchText: dispatch});
    const context = takeFinalizationContext(result)!;
    return finalizeAnalysisResult({result, context, query: 'Replay location regression',
      owner: {runId, signal: new AbortController().signal, isCurrent: () => true, assertAuthorized: () => {}}});
  }

  it('verifies the located fault claim without promoting its unlocatable neighbor or the whole answer', async () => {
    const final = await replay(locationFault, [
      {claimId: 'c_type', consistency: 'consistent', contentLocations: [{text: locationFault.locatedQuote}], issues: []},
      {claimId: 'n_dur', consistency: 'consistent', contentLocations: [{text: 'not present in immutable body'}], issues: []},
    ]);
    expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
      claimResults: [
        {claimId: 'c_type', status: 'verified', deterministicProof: {status: 'proved'}, propositionCoverage: {status: 'complete'}},
        {claimId: 'n_dur', status: 'partial', semanticReview: {consistency: 'unknown'}},
      ]});
    expect(final.semanticAssessment).toMatchObject({coverage: {claims: 'incomplete'}, notCheckedDetail: 'resp_claim_invalid_location'});
    expect(deriveDeliveryVerdict(final.result)).toBe('unverified');
  });

  it('does not let duplicate empty-location normal contradictions reject proved claims', async () => {
    const final = await replay(locationNormal, locationNormal.claims.flatMap(claim => Array.from({length: 2}, () => ({
      claimId: claim.id, consistency: 'inconsistent', contentLocations: [],
      issues: [{code: 'declaration_not_expressed', contentLocations: []}],
    }))));
    expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', unsupportedClaimCount: 0});
    for (const claim of final.result.claimVerificationResult!.claimResults) {
      expect(claim).toMatchObject({status: 'partial', deterministicProof: {status: 'proved'},
        propositionCoverage: {status: 'complete'}, semanticReview: {consistency: 'unknown', contentLocations: []}});
    }
  });

  it.each([true, false])('requires complete body review for verified claims and aggregate acceptance: %s', async bodyComplete => {
    const final = await replay(locationFault, [
      {claimId: 'c_type', consistency: 'consistent', contentLocations: [{text: locationFault.locatedQuote}], issues: []},
      {claimId: 'n_dur', consistency: 'consistent', contentLocations: [{text: '2050 ms'}], issues: []},
    ], {bodyComplete});
    expect(final.result.claimVerificationResult).toMatchObject({status: bodyComplete ? 'passed' : 'partial', passed: bodyComplete});
    expect(final.result.claimVerificationResult!.claimResults.map(claim => claim.status))
      .toEqual(bodyComplete ? ['verified', 'verified'] : ['partial', 'partial']);
    expect(deriveDeliveryVerdict(final.result)).toBe(bodyComplete ? 'completed' : 'unverified');
  });

  it('preserves located proved fault claims when an omission location is unusable, without accepting the whole body', async () => {
    const final = await replay(locationFault, [
      {claimId: 'c_type', consistency: 'consistent', contentLocations: [{text: locationFault.locatedQuote}], issues: []},
      {claimId: 'n_dur', consistency: 'consistent', contentLocations: [{text: '2050 ms'}], issues: []},
    ], {omissions: [{code: 'undeclared_claim', contentLocations: [{text: 'not in the body'}]}]});
    expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false});
    expect(final.result.claimVerificationResult!.claimResults.map(claim => claim.status)).toEqual(['verified', 'verified']);
    expect(final.semanticAssessment).toMatchObject({coverage: {body: 'incomplete'},
      notCheckedDetail: 'resp_omission_invalid_location'});
    expect(deriveDeliveryVerdict(final.result)).toBe('unverified');
  });
});

function fixture(options: {body?: string; capture?: boolean; claim?: boolean; inconsistent?: boolean;
  omissions?: boolean; report?: boolean; providerQuery?: {text: string; analysisContextFingerprint?: string};
  /** Use a registered scene's real report policy; null represents an unknown scene. */
  reportStrategy?: StrategyDefinition | null;
  identity?: IdentityResolutionV1; scope?: EvidenceScopeProvenanceV1;
  deadlineMs?: number; capabilityRows?: number; capabilityCell?: string;
  source?: {marker: string; declaredMarker?: string; invalid?: boolean; hypothetical?: boolean;
    /** A retired model-declared status, sent to check that it is ignored. */
    mechanismStatus?: 'compatible' | 'corroborated'; declareBindings?: boolean};
  selection?: AnalysisRunSelection;
  /** Emit the declaration as an invalid sidecar that still carries its claims. */
  invalidDeclaration?: boolean;
  currentRead?: boolean;
  runId?: string;
  wrongReferenceValue?: number;
  toolCallReference?: boolean;
  selectorReference?: boolean;
  fieldIdentity?: 'upid';
  taskKind?: 'fact' | 'investigation' | 'acknowledgement';
  claimKind?: 'inference';
  /** No declaration at all: the canonical result is `legacy_unchecked`. */
  absentDeclaration?: boolean;
  /** Pin a strategy whose investigation contract has this one requirement. */
  investigationRequirement?: AnalysisInvestigationRequirement;
  /** Deliver the body as an evidence-rendered acknowledgement with its proof. */
  evidenceRenderedAcknowledgement?: boolean;
  /** The runtime hands over its own contract, with these recommendations and no sidecar in the body. */
  runtimeCaseRecommendations?: ConclusionContract['caseRecommendations'];
  /** Issue the runtime's protocol projection (a native declaration) even without source use. */
  nativeProjection?: boolean;
  /** The run had source access but made no source call. */
  sourceAccessOnly?: boolean;
  /** What the run delivered from its selected knowledge bases. */
  knowledgeUse?: KnowledgeUseRecord;
  /** The runtime's native terminal record for the candidate (default completed). */
  nativeCompletion?: {status: 'incomplete'; reason: 'output_limit'};
  /** A captured.cell proposition whose one cell holds this exact value and unit. */
  capturedCell?: {value: number | string; unit: string; displayed: string};
  /** A numeric.cell proposition with a captured raw value and independently declared numeric semantics. */
  numericCell?: {value: number | string; unit: string; displayed: string; numeric?: ClaimSemanticsV1['numeric']};
  /** A second reference naming the same cell: two matching anchor cells. */
  duplicateSubjectCellRef?: boolean;
  dispatch?: (input: IntentTransportInput) => Promise<IntentTransportResult>} = {}) {
  const runId = options.runId ?? 'run';
  const capturedCell = options.capturedCell;
  const numericCell = options.numericCell;
  const cell = capturedCell ?? numericCell;
  const body = options.body ?? (cell ? `The captured value is ${cell.displayed}.`
    : options.source ? 'The captured name identifies the source marker.' : 'The captured value is 49.');
  const ref = {...(options.toolCallReference ? {sourceToolCallId: 'sql:run-call'} : {evidenceRefId: 'data:count'}),
    ...(options.selectorReference ? {rowSelector: {count: numericCell?.value ?? 49}} : {rowIndex: 0}),
    column: options.source ? 'name' : 'count',
    value: options.source ? options.source.declaredMarker ?? options.source.marker
      // A captured.cell proposition declares its expected primitive as a string.
      : capturedCell ? String(capturedCell.value) : options.wrongReferenceValue ?? numericCell?.value ?? 49};
  const declared: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: options.claim === false ? [] : [{id: 'count', kind: options.source?.hypothetical || options.claimKind === 'inference'
      ? 'inference' : options.source || capturedCell ? 'identity' : 'numeric', text: body, references: options.duplicateSubjectCellRef
      ? [ref, {...ref, value: capturedCell ? `${capturedCell.value}0` : 490}] : [ref],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: capturedCell ? 'captured.cell'
        : options.source ? 'identity.marker' : 'numeric.cell', polarity: 'affirmed',
        discourse: options.source?.hypothetical ? 'hypothetical' : 'asserted', quantifier: 'one',
        modality: options.source?.hypothetical ? 'possible' : 'certain',
        scope: {population: 'cited_rows', subjectRefs: [ref]},
        ...(options.source || capturedCell ? {} : {numeric: numericCell?.numeric ?? {
          operator: 'eq' as const, value: numericCell?.value ?? 49, unit: numericCell?.unit ?? 'count'}})}}]};
  const result: AnalysisResult = {sessionId: 'final-result-test', conclusion: body, success: true,
    confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1,
    conclusionContract: parseConclusionContractDeclaration(declared).contract};
  const envelope = createDataEnvelope({columns: [ref.column],
    rows: [[options.source?.marker ?? (capturedCell ? String(capturedCell.value) : numericCell?.value ?? 49)]]}, {
    type: 'sql_result', source: 'execute_sql', title: 'Count', evidenceRefId: 'data:count',
    ...(options.toolCallReference ? {sourceToolCallId: 'sql:run-call'} : {}),
    traceId: 'trace', traceSide: 'current', executionStatus: 'observed', identityResolution: options.identity,
    scopeProvenance: options.scope});
  const store = new ArtifactStore();
  if (options.capture !== false) store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    count: {unit: cell?.unit ?? 'count', ...(options.fieldIdentity ? {identityRole: options.fieldIdentity} : {}),
      origin: {kind: 'native_producer', definitionFingerprint: 'count-v1'}},
  }), {meta: envelope.meta, display: envelope.display});
  let sourceUse: SourceUseDecisionV1 | undefined;
  if (options.source) {
    const reference = sanitizeSourceReference({referenceId: 'source-read', codebaseId: 'source-app',
      filePath: 'src/Probe.kt', lineRange: {start: 1, end: 1}, lookupKind: 'body'})!;
    sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['source-app'], status: 'corroborated', attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['source-app'], usedCodebaseIds: ['source-app'], coverageComplete: true, references: [reference]};
    if (options.source.declareBindings !== false) {
      declared.sourceClaimBindings = [{claimId: 'count', ...(options.source.mechanismStatus
        ? {mechanismStatus: options.source.mechanismStatus} : {}),
        sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['data:count']}];
    }
    registerOnDemandSourceLookupForEcho(result.sessionId, [{...reference, id: 'source-read',
      text: `Trace.beginSection("${options.source.marker}");\nTrace.endSection("${options.source.declaredMarker ?? options.source.marker}");`}]);
    // A bound source finding cites its location in the answer, where it can be checked.
    const narrative = options.source.declareBindings !== false ? `${body} (src/Probe.kt:L1)` : body;
    result.conclusion = `${narrative}\n${options.source.invalid
      ? '<!-- smartperfetto:conclusion-contract@1\n```json\n' + JSON.stringify({...declared, verified: true}) + '\n```\n-->'
      : renderConclusionContractSidecar(declared)}`;
    delete result.conclusionContract;
  }
  if (options.runtimeCaseRecommendations) {
    result.conclusion = body;
    result.conclusionContract = {...parseConclusionContractDeclaration(declared).contract!,
      caseRecommendations: options.runtimeCaseRecommendations};
  }
  if (options.invalidDeclaration && !options.source) {
    result.conclusion = `${body}\n` + '<!-- smartperfetto:conclusion-contract@1\n```json\n' +
      JSON.stringify({...declared, verified: true}) + '\n```\n-->';
    delete result.conclusionContract;
  }
  if (options.nativeProjection && !options.source && !options.invalidDeclaration) {
    result.conclusion = `${body}\n${renderConclusionContractSidecar(declared)}`;
    delete result.conclusionContract;
  }
  if (options.absentDeclaration) delete result.conclusionContract;
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const investigationStrategy: StrategyDefinition | undefined = options.investigationRequirement ? {scene: 'general',
    classificationDescription: 'General.', strategyKind: 'normal', priority: 1, effort: 'low', keywords: [],
    requiredCapabilities: [], optionalCapabilities: [], verifierMisdiagnosisPatterns: [],
    content: 'General.', detailSections: [], sourcePath: '/fixture/general.strategy.md',
    investigationContract: {schemaVersion: 1, profileRefs: [], requirements: [options.investigationRequirement]},
    finalReportContract: null} : undefined;
  const pinnedRegistryForIntent = investigationStrategy
    ? buildStrategyRegistrySnapshotFromDefinitions({definitions: [investigationStrategy], overlayGeneration: 'investigation-test'})
    : undefined;
  const taskKind = options.taskKind ?? 'fact';
  const intentFor = (fingerprint: string) => ({schemaVersion: 1 as const, status: 'resolved' as const, source: 'semantic' as const,
    registryFingerprint: fingerprint, taskKind, sceneId: options.reportStrategy?.scene ?? 'general',
    scope: options.report || taskKind === 'investigation' ? 'scene_wide' as const : 'bounded_question' as const,
    recommendedComplexity: 'quick' as const, deliverable: options.report ? 'report' as const : 'answer' as const,
    evidenceAccess: 'existing_only' as const});
  const nativeDelivery = {entry: 'runtime_draft' as const, acceptedCandidate: candidate,
    outputOrigin: options.evidenceRenderedAcknowledgement ? 'evidence_rendered' as const : 'sdk_final' as const,
    completion: {...candidate, schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const,
      ...(options.nativeCompletion ?? {status: 'completed' as const})},
    ...(options.evidenceRenderedAcknowledgement ? {evidenceRenderedProof: {kind: 'acknowledgement' as const, candidate,
      intentFingerprint: analysisDeliveryFingerprint(intentFor(registry.registryFingerprint)), evidence: 'not_applicable' as const}} : {})};
  const projection = sourceUse || options.nativeProjection ? finalizeOwnerSourceAwareAnalysisResultWithProjection(result,
    sourceUse ? {getSourceUseDecision: () => sourceUse!} : undefined, {context: nativeDelivery}) : undefined;
  const semanticBody = canonicalizeAnalysisResult(result).result.conclusion;
  const controller = new AbortController();
  const owner: AnalysisFinalizationOwner = {runId, signal: controller.signal,
    isCurrent: () => true, assertAuthorized: () => {}};
  const dispatch = jest.fn(options.dispatch ?? (async (): Promise<IntentTransportResult> => {
    const location = {start: semanticBody.indexOf(body), end: semanticBody.indexOf(body) + body.length, text: body};
    return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: semanticBody.length}]},
      claims: options.claim === false ? [] : [{claimId: 'count',
        consistency: options.inconsistent ? 'inconsistent' : 'consistent', contentLocations: [location],
        issues: options.inconsistent ? [{code: 'numeric_mismatch', contentLocations: [location]}] : []}],
      omissions: options.omissions ? [{code: 'undeclared_claim', contentLocations: [location]}] : [],
      requirements: options.report && options.reportStrategy === undefined ? [{requirementId: 'detail', applicability: 'applicable', coverage: 'unknown',
        contentLocations: [], claimIds: []}] : []})};
  }));
  const reportStrategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General analysis.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], requiredCapabilities: [],
    optionalCapabilities: [], verifierMisdiagnosisPatterns: [], content: 'General analysis.',
    detailSections: [], sourcePath: '/fixture/general.strategy.md', finalReportContract: {requiredSections: [{
      id: 'detail', label: 'Detail', required: true, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }]}};
  const pinnedRegistry = pinnedRegistryForIntent ?? (options.report
    ? buildStrategyRegistrySnapshotFromDefinitions({definitions: options.reportStrategy === null ? [] :
      [options.reportStrategy ?? reportStrategy], overlayGeneration: 'report-test'}) : registry);
  attachFinalizationContext(result, {runId, sessionId: result.sessionId, deadlineMs: options.deadlineMs ?? Date.now() + 600_000,
    strategyRegistry: pinnedRegistry, traceIdentity: {currentTraceId: 'trace'},
    selection: options.selection,
    providerQuery: options.providerQuery,
    capabilityEvidence: options.capabilityRows ? [createDataEnvelope({columns: ['observed'],
      rows: Array.from({length: options.capabilityRows}, () => [options.capabilityCell ?? 0])},
      {type: 'sql_result', source: 'capability_fixture', title: 'Capabilities'})] : undefined,
    sourceUse, protocolProjection: projection?.protocolProjection,
    ...(options.knowledgeUse ? {knowledgeUse: options.knowledgeUse} : {}),
    ...(options.sourceAccessOnly ? {sourceScope: {codeAwareMode: 'provider_send' as const, selectedCodebaseIds: ['source-app'],
      hasCodebaseAccess: true, analysisContextFingerprint: 'source-auth'}} : {}),
    turnIntent: intentFor(pinnedRegistry.registryFingerprint),
    deliveryContext: projection?.deliveryContext ?? nativeDelivery,
    evidenceReadView: store.createEvidenceReadView({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: 'run',
      ...(options.currentRead ? {currentRunId: runId} : {})}),
    dispatchText: dispatch});
  const context = takeFinalizationContext(result)!;
  return {result, context, controller, owner, dispatch, envelope,
    run: (extra: {caseRecommendations?: CaseKnowledgeReportRecommendation[]} = {}) => finalizeAnalysisResult({result, context, owner,
      query: 'What is the captured value?', dataEnvelopes: [envelope], ...extra})};
}

afterEach(() => {clearAllCodeAwareOutputGuards(); clearRunManifestLifecyclesForTests(); jest.useRealTimers();});

describe('finalizer-owned terminal state', () => {
  it('writes the quality verdict a runtime draft left to it', async () => {
    // A runtime records only native facts: an output-limited answer is partial,
    // with no quality termination reason of its own.
    const run = fixture({nativeCompletion: {status: 'incomplete', reason: 'output_limit'}});
    run.result.partial = true;
    expect(run.result.terminationReason).toBeUndefined();
    const final = await run.run();
    expect(final.qualityIssue?.code).toBe('sdk_incomplete');
    expect(final.result).toMatchObject({partial: true, terminationReason: 'quality_gate_failed'});
    expect(final.result.confidence).toBeLessThanOrEqual(0.55);
    expect(final.result.terminationMessage).toContain(final.qualityIssue!.message);
    expect(final.result.deliveryAssurance?.completion).toBe('failed');
  });

  it('leaves a delivered answer without a verdict when no gate issue applies', async () => {
    const final = await fixture({currentRead: true}).run();
    expect(final.qualityIssue).toBeUndefined();
    expect(final.result.partial).toBeUndefined();
    expect(final.result.terminationReason).toBeUndefined();
  });
});

describe('knowledge_use@1 in finalization', () => {
  const base = `eks_${'a'.repeat(24)}`;
  const record: KnowledgeUseRecord = {
    sources: [{knowledgeBaseId: base, kind: 'document_collection', generation: `dc_${'1'.repeat(32)}`, deliveredReferenceCount: 1}],
    locations: [{referenceId: 'kref-00000000-0000-4000-8000-000000000000', knowledgeBaseId: base,
      generation: `dc_${'1'.repeat(32)}`, relativePath: 'render/fence.md', lineRange: {start: 1, end: 9}, bodyDelivered: true}],
  };
  const body = 'The captured value is 49. Per internal documentation, kb:render/fence.md#L2-L3 and kb:render/other.md#L1.';

  it('grades the final body\'s knowledge citations without touching claim verification or delivery', async () => {
    const withKnowledge = await fixture({body, knowledgeUse: record}).run();
    expect(withKnowledge.result.knowledgeUse).toEqual({schemaVersion: 'knowledge_use@1', sources: record.sources,
      citations: [
        {citation: 'kb:render/fence.md#L2-L3', relativePath: 'render/fence.md', lineRange: {start: 2, end: 3},
          status: 'delivered', knowledgeBaseId: base, referenceId: record.locations[0]!.referenceId},
        {citation: 'kb:render/other.md#L1', relativePath: 'render/other.md', lineRange: {start: 1, end: 1}, status: 'unmatched'},
      ]});
    const without = await fixture({body}).run();
    expect(without.result).not.toHaveProperty('knowledgeUse');
    // Knowledge is background: no verdict reads it, so an unmatched citation changes nothing.
    expect(withKnowledge.result.claimVerificationResult).toEqual(without.result.claimVerificationResult);
    expect(withKnowledge.result.deliveryAssurance).toEqual(without.result.deliveryAssurance);
    expect(withKnowledge.result.success).toBe(without.result.success);
  });

  it('keeps what a failed run delivered when it returns no context, bound to that run', async () => {
    const {owner, context} = fixture({body});
    context.dispose();
    const failed = (): AnalysisResult => ({sessionId: 'final-result-test', success: false, findings: [], hypotheses: [],
      conclusion: 'See kb:render/fence.md#L2-L3.', confidence: 0, rounds: 1, totalDurationMs: 1, partial: true,
      terminationReason: 'execution_error'});
    const result = failed();
    attachRunDeliveryRecord(result, {runId: owner.runId, sessionId: result.sessionId, knowledgeUse: record});
    const finalized = (await finalizeAnalysisResult({result, owner, query: 'q'})).result;
    expect(finalized.success).toBe(false);
    expect(finalized.knowledgeUse).toEqual({schemaVersion: 'knowledge_use@1', sources: record.sources,
      citations: [{citation: 'kb:render/fence.md#L2-L3', relativePath: 'render/fence.md', lineRange: {start: 2, end: 3},
        status: 'delivered', knowledgeBaseId: base, referenceId: record.locations[0]!.referenceId}]});
    // Every surface of the failed result keeps it: receipt, snapshot, the owner's stream and replay.
    expect(buildAnalysisReceipt({runManifestId: 'manifest-failed-knowledge',
      session: {sessionId: finalized.sessionId, traceId: 'trace', dataEnvelopes: []}, result: finalized})
      .nonEvidenceContext.knowledgeReferenceCount).toBe(1);
    expect(copyAnalysisResultForSnapshot(finalized).knowledgeUse).toEqual(finalized.knowledgeUse);
    expect(projectOwnerAnalysisResult(finalized.sessionId, finalized, 'en').knowledgeUse).toEqual(finalized.knowledgeUse);
    // Other audiences keep the sources, never the citation text.
    expect(projectPrivateAnalysisResult(finalized.sessionId, finalized, 'en').knowledgeUse)
      .toEqual({schemaVersion: 'knowledge_use@1', sources: record.sources, citations: []});

    // Without the record a failure is "not recorded", never zero use.
    expect((await finalizeAnalysisResult({result: failed(), owner, query: 'q'})).result).not.toHaveProperty('knowledgeUse');
    // A record of another run is not this run's.
    const foreign = failed();
    attachRunDeliveryRecord(foreign, {runId: 'another-run', sessionId: foreign.sessionId, knowledgeUse: record});
    await expect(finalizeAnalysisResult({result: foreign, owner, query: 'q'}))
      .rejects.toThrow('finalization_run_identity_mismatch');
  });

  it('never keeps a knowledge record the runtime supplied itself', async () => {
    const forged = fixture({body});
    forged.result.knowledgeUse = {schemaVersion: 'knowledge_use@1', sources: record.sources, citations: []};
    expect((await forged.run()).result).not.toHaveProperty('knowledgeUse');
  });
});

/**
 * Owner surfaces project a result again, as does its reader after a JSON round
 * trip, and a public snapshot copies it; none of them may change it.
 */
function expectOwnerSurfacesStable(result: AnalysisResult): void {
  const stable = (projected: AnalysisResult) => {
    expect(projected.conclusionContract).toEqual(result.conclusionContract);
    expect(projected.claimVerificationResult).toEqual(result.claimVerificationResult);
    expect(projected.sourceClaimVerificationResult).toEqual(result.sourceClaimVerificationResult);
    expect(projected.reportAssessment).toEqual(result.reportAssessment);
    expect(projected.investigationAssessment).toEqual(result.investigationAssessment);
    expect(projected.deliveryAssurance).toEqual(result.deliveryAssurance);
  };
  const ownerAgain = projectOwnerAnalysisResult(result.sessionId, result, 'en');
  stable(ownerAgain);
  const readBack = JSON.parse(JSON.stringify(ownerAgain)) as AnalysisResult;
  stable(projectOwnerAnalysisResult(readBack.sessionId, readBack, 'en'));
  stable(copyAnalysisResultForSnapshot(result));
}

const areaSelection: AnalysisRunSelection = {present: true, kind: 'area', context: {kind: 'area', source: 'area_selection',
  startNs: 10, endNs: 20, tracks: [{uri: 'track://main', upid: 921}]},
sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace'}};

describe('semantic review necessity', () => {
  it.each(['media', 'general'])('reviews claims in a registered %s report without a section contract', async scene => {
    const strategy = strategyTemplates.loadStrategies().get(scene)!;
    expect(strategy).toBeDefined();
    expect(strategy.finalReportContract).toBeNull();
    const run = fixture({report: true, reportStrategy: strategy});
    const final = await run.run();
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(final.semanticAssessment).toMatchObject({status: 'checked', claims: [{consistency: 'consistent'}]});
    expect(final.result.claimVerificationResult).toMatchObject({claimResults: [{status: 'verified'}]});
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', report: 'not_applicable'});
    expect(final.result.conclusion).toBe(run.result.conclusion);
    expect(final.result.partial).not.toBe(true);
  });

  it('does not invent an empty report policy for an unknown scene', async () => {
    const run = fixture({report: true, reportStrategy: null});
    const final = await run.run();
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(final.semanticAssessment).toMatchObject({reason: 'invalid_snapshot', notCheckedDetail: 'report_requirement_pin_mismatch'});
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', report: 'not_checked'});
    expect(final.result.conclusion).toBe(run.result.conclusion);
  });

  const finalize = async (options: Parameters<typeof fixture>[0]) => {
    const run = fixture({currentRead: true, ...options});
    const events: FinalizationProgressEvent[] = [];
    const provisional = jest.fn((_answer: {conclusion: string}) => true);
    const final = await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner,
      query: 'What is the captured value?', dataEnvelopes: [run.envelope],
      onProgress: event => events.push(event), onProvisionalAnswer: provisional});
    return {final, run, events, provisional};
  };
  const expectNotRequired = ({final, run, events, provisional}: Awaited<ReturnType<typeof finalize>>) => {
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(provisional).not.toHaveBeenCalled();
    expect(final.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'not_required',
      binding: {canonicalCandidate: expect.objectContaining({runId: 'run'})}});
    expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false, notCheckedReason: 'not_required'});
    expect(final.result.deliveryAssurance?.claims).toBe('coverage_incomplete');
    expect(deriveDeliveryVerdict(final.result)).toBe('unverified');
  };
  const expectReviewed = ({run, events, provisional}: Awaited<ReturnType<typeof finalize>>) => {
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(events.map(event => event.stage)).toEqual(['final_review_started', 'final_review_finished']);
    expect(provisional).toHaveBeenCalledTimes(1);
  };

  it('sends no review for an answer without a declaration', async () => {
    expectNotRequired(await finalize({absentDeclaration: true}));
  });

  it('keeps a zero-claim factual answer unverified (~, never ✓) without a review', async () => {
    const outcome = await finalize({claim: false, body: 'The trace is 12 seconds long.'});
    expectNotRequired(outcome);
    expect(claimVerificationStatusLine(summarizeClaimVerification(outcome.final.result.claimVerificationResult), 'en'))
      .toContain('no semantic review was needed');
  });

  it('keeps an ineligible declaration on its own unchecked reason without a review', async () => {
    const {final, run, events, provisional} = await finalize({invalidDeclaration: true});
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(provisional).not.toHaveBeenCalled();
    expect(final.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'invalid_declarations'});
  });

  it('reviews when every declared claim is proved, so ✓ stays reachable', async () => {
    const outcome = await finalize({});
    expectReviewed(outcome);
    expect(deriveDeliveryVerdict(outcome.final.result)).toBe('completed');
  });

  it('reviews an inference claim whose ✓ is reachable without a finite proof', async () => {
    const outcome = await finalize({claimKind: 'inference', wrongReferenceValue: 99});
    expectReviewed(outcome);
    expect(outcome.final.result.claimVerificationResult?.claimResults[0].status).toBe('inference');
  });

  it('skips the review when no declared claim can reach ✓', async () => {
    expectNotRequired(await finalize({wrongReferenceValue: 99}));
  });

  it.each([
    ['a selection', {selection: areaSelection}],
    ['a report deliverable', {report: true}],
    ['a source declaration', {source: {marker: 'source_marker'}}],
    ['a resolved investigation requirement', {taskKind: 'investigation' as const,
      investigationRequirement: {id: 'cpu', domain: 'cpu', description: 'Describe CPU.', required: true}}],
  ])('reviews an unprovable answer when %s gives the review something to decide', async (_label, options) => {
    const outcome = await finalize({wrongReferenceValue: 99, ...options});
    expect(outcome.run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not review for an investigation requirement the pin leaves unresolved', async () => {
    // A factual turn is exempt from investigation obligations.
    expectNotRequired(await finalize({wrongReferenceValue: 99,
      investigationRequirement: {id: 'cpu', domain: 'cpu', description: 'Describe CPU.', required: true}}));
  });

  it('treats only a requirement the ledger rules out as determinably exempt', () => {
    const requirement: AnalysisInvestigationRequirement = {id: 'cpu', domain: 'cpu', description: 'Describe CPU.', required: true,
      condition: {kind: 'evidence', description: 'Only when throttled.', metricId: 'cpu.throttled', operator: 'gt', value: 0}};
    const ledger = (value: number) => ({records: [{metricId: 'cpu.throttled', status: 'observed', value}]}) as never;
    expect(investigationRequirementNeedsReview(requirement, ledger(0))).toBe(false);
    expect(investigationRequirementNeedsReview(requirement, ledger(3))).toBe(true);
    // An unobserved metric is unknown, never cleared.
    expect(investigationRequirementNeedsReview(requirement, undefined)).toBe(true);
    expect(investigationRequirementNeedsReview({...requirement, condition: undefined}, ledger(0))).toBe(true);
    expect(investigationRequirementNeedsReview({...requirement,
      condition: {kind: 'semantic', description: 'When the answer discusses CPU.'}}, ledger(0))).toBe(true);
  });

  it('reviews a zero-claim acknowledgement without a declaration (legacy_unchecked)', async () => {
    const outcome = await finalize({absentDeclaration: true, claim: false, taskKind: 'acknowledgement', body: 'Acknowledged.'});
    expectReviewed(outcome);
    expect(outcome.final.result.claimVerificationResult?.passed).toBe(true);
  });

  it('skips the review for an evidence-rendered acknowledgement, whose claims are not applicable', async () => {
    const outcome = await finalize({absentDeclaration: true, claim: false, taskKind: 'acknowledgement', body: 'Acknowledged.',
      evidenceRenderedAcknowledgement: true});
    expect(outcome.run.dispatch).not.toHaveBeenCalled();
    expect(outcome.final.semanticAssessment?.reason).toBe('not_required');
    expect(outcome.final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'not_applicable'});
    expect(deriveDeliveryVerdict(outcome.final.result)).toBe('completed');
  });

  it('records the decision and the review call in the run performance receipt', async () => {
    const lifecycle = createRunManifestLifecycle({runId: 'run', sessionId: 'final-result-test',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []} as never});
    const recorder = lifecycle.builder.runtimePerformanceRecorder;
    await withRunManifestLifecycle(lifecycle, () => finalize({}));
    expect(recorder.seal()).toMatchObject({finalReview: {necessity: 'required', triggers: ['claims_verifiable'], declaredClaimCount: 1},
      modelCalls: [{purpose: 'review', outcome: 'ok'}]});
    const second = createRunManifestLifecycle({runId: 'run-2', sessionId: 'final-result-test',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []} as never});
    const skipped = second.builder.runtimePerformanceRecorder;
    await withRunManifestLifecycle(second, () => finalize({claim: false}));
    expect(skipped.seal()).toMatchObject({finalReview: {necessity: 'not_required', triggers: [], declaredClaimCount: 0}});
    expect(skipped.seal().modelCalls).toBeUndefined();
  });

  it.each([
    {options: {absentDeclaration: true}, status: 'absent', declaredClaimCount: 0},
    {options: {nativeProjection: true}, status: 'valid', declaredClaimCount: 1},
    {options: {invalidDeclaration: true}, status: 'invalid', declaredClaimCount: 1},
  ])('records canonical declaration $status independently from claim verification', async ({options, status, declaredClaimCount}) => {
    const lifecycle = createRunManifestLifecycle({runId: 'run', sessionId: 'final-result-test',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []} as never});
    await withRunManifestLifecycle(lifecycle, () => finalize(options));
    expect(lifecycle.builder.runtimePerformanceRecorder.seal().declaration).toEqual({
      status, declaredClaimCount, repair: 'not_requested'});
  });

  it('reviews a run with source access that made no source call: authorized history can carry source', async () => {
    const lifecycle = createRunManifestLifecycle({runId: 'run', sessionId: 'final-result-test',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []} as never});
    const recorder = lifecycle.builder.runtimePerformanceRecorder;
    await withRunManifestLifecycle(lifecycle, () => finalize({claim: false, sourceAccessOnly: true}));
    expect(recorder.seal()).toMatchObject({finalReview: {necessity: 'required', triggers: ['source']}});
  });
});

describe('final review progress', () => {
  const finalizeWithProgress = async (options: Parameters<typeof fixture>[0], observer?: () => void) => {
    const run = fixture({currentRead: true, ...options});
    const events: FinalizationProgressEvent[] = [];
    const final = await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner,
      query: 'What is the captured value?', dataEnvelopes: [run.envelope],
      onProgress: event => {events.push(event); observer?.();}});
    return {final, events, run};
  };

  it('reports the one semantic review as started (with its deadline) and finished, in order, without provider text', async () => {
    const deadlineMs = Date.now() + 120_000;
    const {final, events, run} = await finalizeWithProgress({deadlineMs});
    expect(events).toEqual([
      {stage: 'final_review_started', deadlineAt: deadlineMs},
      {stage: 'final_review_finished', status: 'checked'},
    ]);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(final.result.deliveryAssurance?.claims).toBe('passed');
    const updates = events.map(event => finalReviewProgressUpdate(event, 'zh-CN', deadlineMs - 90_000));
    expect(updates.map(update => update.content)).toEqual([
      {phase: 'final_review', stage: 'started', deadlineAt: deadlineMs, message: '正在核验结论与其声明是否一致'},
      {phase: 'final_review', stage: 'finished', outcome: 'checked', message: '结论复核已完成'},
    ]);
    expect(JSON.stringify(updates)).not.toContain('captured value');
  });

  it('names a failed review outcome and never reports a review that was not sent', async () => {
    const timedOut = await finalizeWithProgress({dispatch: async () => ({status: 'unavailable', reason: 'timeout'})});
    expect(timedOut.events.map(event => event.stage)).toEqual(['final_review_started', 'final_review_finished']);
    expect(finalReviewProgressUpdate(timedOut.events[1], 'en').content).toMatchObject({outcome: 'unavailable', reason: 'timeout',
      message: 'Final review did not complete: semantic review ran out of time'});
    const skipped = await finalizeWithProgress({invalidDeclaration: true});
    expect(skipped.run.dispatch).not.toHaveBeenCalled();
    expect(skipped.events).toEqual([]);
  });

  it('ignores a throwing progress observer', async () => {
    const {final, events} = await finalizeWithProgress({}, () => {throw new Error('renderer failed');});
    expect(events).toHaveLength(2);
    expect(final.result.deliveryAssurance?.claims).toBe('passed');
  });
});

describe('deliver first, verify after', () => {
  const pendingReview = (input: IntentTransportInput): Promise<IntentTransportResult> =>
    new Promise((_resolve, reject) => {
      const signal = input.signal!;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });

  it('delivers the canonical body once, as the review is dispatched, before the started progress', async () => {
    const run = fixture({currentRead: true});
    const log: string[] = [];
    const answers: Array<{conclusion: string}> = [];
    const final = await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner,
      query: 'What is the captured value?', dataEnvelopes: [run.envelope],
      onProvisionalAnswer: answer => {answers.push({...answer}); log.push('provisional');},
      onProgress: event => log.push(event.stage)});
    expect(log).toEqual(['provisional', 'final_review_started', 'final_review_finished']);
    expect(answers).toEqual([{conclusion: 'The captured value is 49.'}]);
    // The review cannot rewrite the body: the delivered text is the finalized body.
    expect(final.result.conclusion).toBe(answers[0].conclusion);
    expect(final.result.deliveryAssurance?.claims).toBe('passed');
  });

  it('marks the started line readable only when the answer was delivered, and keeps the deadline', () => {
    const deadlineAt = Date.now() + 30 * 60_000;
    expect(finalReviewProgressUpdate({stage: 'final_review_started', deadlineAt, answerReadable: true}, 'zh-CN').content)
      .toEqual({phase: 'final_review', stage: 'started', deadlineAt, answerReadable: true,
        message: '结论已可阅读，正在核验结论与其声明是否一致'});
    const english = finalReviewProgressUpdate({stage: 'final_review_started', deadlineAt, answerReadable: true}, 'en');
    expect(english.content.message).toBe('The answer is ready to read; checking it against its declared claims');
    expect(JSON.stringify(english)).not.toMatch(/min|分钟/);
  });

  it('does not call the answer readable when the surface reports it did not deliver it', async () => {
    const run = fixture({currentRead: true});
    const events: FinalizationProgressEvent[] = [];
    await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner, query: 'q',
      dataEnvelopes: [run.envelope], onProvisionalAnswer: () => false, onProgress: event => events.push(event)});
    expect(events[0]).toEqual({stage: 'final_review_started', deadlineAt: expect.any(Number)});
  });

  it('never delivers when no review is dispatched or the observer throws', async () => {
    const skipped = fixture({currentRead: true, invalidDeclaration: true});
    const onProvisionalAnswer = jest.fn((_answer: {conclusion: string}) => true);
    await finalizeAnalysisResult({result: skipped.result, context: skipped.context, owner: skipped.owner,
      query: 'q', dataEnvelopes: [skipped.envelope], onProvisionalAnswer});
    expect(skipped.dispatch).not.toHaveBeenCalled();
    expect(onProvisionalAnswer).not.toHaveBeenCalled();

    const throwing = fixture({currentRead: true});
    const final = await finalizeAnalysisResult({result: throwing.result, context: throwing.context, owner: throwing.owner,
      query: 'q', dataEnvelopes: [throwing.envelope], onProvisionalAnswer: () => {throw new Error('renderer failed');}});
    expect(final.result.deliveryAssurance?.claims).toBe('passed');
  });

  it('never delivers a scene run, whose committed timeline owns terminal delivery', async () => {
    const run = fixture({currentRead: true});
    const scope = {runId: 'run', sessionId: run.result.sessionId, traceId: 'trace', ownerKey: sceneRunOwnerKey({})};
    const binding = createSceneRunDispatchBinding({scope, signal: new AbortController().signal, assertCurrent: () => {}});
    try {
      const options = binding.bindOptions({runId: scope.runId});
      const artifactStore = resolveRuntimeEvidenceStore(options, scope, () => {throw new Error('unexpected fallback');});
      const sceneContext = await activateSceneRuntime(options, {...scope, artifactStore, deadlineMs: Date.now() + 60_000,
        traceProcessorService: {query: (async () => ({columns: ['start_ns', 'end_ns'], rows: [['0', '100']]})) as never}});
      await proposeSceneTimeline(sceneContext!, {baseRevision: 0, proposalId: 'one', segments: [{id: 'unknown',
        startNs: '0', endNs: '100', object: {kind: 'device', key: 'unknown'}, userAction: 'Unknown',
        deviceState: 'Unknown', appResponse: 'Unknown', evidenceRefs: [],
        boundaries: {start: {source: 'trace_bound'}, end: {source: 'trace_bound'}}}]});
      const onProvisionalAnswer = jest.fn((_answer: {conclusion: string}) => true);
      await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner, query: 'q',
        dataEnvelopes: [run.envelope], onProvisionalAnswer,
        scene: {seal: binding.seal()!, scope, outputLanguage: 'en'}});
      expect(run.dispatch).toHaveBeenCalledTimes(1);
      expect(onProvisionalAnswer).not.toHaveBeenCalled();
    } finally {binding.release();}
  });

  it.each([
    {report: false, verdict: 'unverified'},
    {report: true, verdict: 'unverified'},
  ])('a review-only stop still finalizes the delivered answer (report=$report -> $verdict)', async ({report, verdict}) => {
    const run = fixture({currentRead: true, report, dispatch: pendingReview});
    const stop = new AbortController();
    const events: FinalizationProgressEvent[] = [];
    const final = await finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner,
      query: 'q', dataEnvelopes: [run.envelope], reviewStopSignal: stop.signal,
      onProvisionalAnswer: () => queueMicrotask(() => stop.abort()),
      onProgress: event => events.push(event)});
    expect(events[events.length - 1]).toEqual({stage: 'final_review_finished', status: 'not_checked', reason: 'cancelled_by_user'});
    expect(final.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'cancelled_by_user'});
    expect(final.result.conclusion).toBe('The captured value is 49.');
    expect(final.result.claimVerificationResult?.notCheckedReason).toBe('cancelled_by_user');
    expect(deriveDeliveryVerdict(final.result)).toBe(verdict);
    expect(claimVerificationStatusLine(summarizeClaimVerification(final.result.claimVerificationResult), 'zh-CN'))
      .toContain('已按用户要求停止语义复核');
    expect(finalReviewProgressUpdate(events[events.length - 1], 'en').content.message)
      .toBe('Final review did not complete: the semantic review was stopped at the user\'s request');
  });

  it('keeps a run cancellation fatal even when a review stop is wired', async () => {
    const run = fixture({currentRead: true, dispatch: pendingReview});
    const stop = new AbortController();
    await expect(finalizeAnalysisResult({result: run.result, context: run.context, owner: run.owner,
      query: 'q', dataEnvelopes: [run.envelope], reviewStopSignal: stop.signal,
      onProvisionalAnswer: () => queueMicrotask(() => run.controller.abort(new DOMException('cancelled', 'AbortError')))}))
      .rejects.toMatchObject({name: 'AbortError'});
  });
});

describe('current-run reference delivery diagnostics', () => {
  it.each([{capture: false}, {wrongReferenceValue: 99}])('delivers %j with an explicit unverified watermark', async options => {
    const final = await fixture({...options, currentRead: true}).run();
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'coverage_incomplete'});
    expect(final.result.claimVerificationResult?.status).toBe('partial');
    expect(final.result.claimVerificationResult?.claimResults[0].status).not.toBe('verified');
    expect(claimVerificationStatusLine(summarizeClaimVerification(final.result.claimVerificationResult), 'zh-CN'))
      .toContain('已核验 0/1');
    expect(final.result.terminationReason).not.toBe('quality_gate_failed');
  });

  it('does not let an advisory reference hide a canonical semantic rejection', async () => {
    // The advisory reference leaves no reachable ✓, so only a review another
    // obligation requires (here the selection) can find the contradiction.
    const final = await fixture({currentRead: true, wrongReferenceValue: 99, inconsistent: true,
      body: 'The captured value is 50.', selection: areaSelection}).run();
    expect(final.result.deliveryAssurance?.claims).toBe('failed');
    expect(final.result.claimVerificationResult?.claimResults[0].status).toBe('unsupported');
  });

  it('preserves correct verification and strict source identity failures', async () => {
    expect((await fixture({currentRead: true}).run()).result.deliveryAssurance?.claims).toBe('passed');
    const invalid = await fixture({currentRead: true,
      source: {marker: 'original_marker', declaredMarker: 'different_marker'}}).run();
    expect(invalid.result.claimVerificationResult?.status).toBe('failed');
  });

  it.each([false, true])('does not reuse previous-run proof when restored=%s', async restored => {
    const previous = (await fixture({currentRead: true, runId: 'previous-run'}).run()).result;
    expect(previous.deliveryAssurance?.claims).toBe('passed');
    const next = fixture({currentRead: true, runId: 'next-run', capture: false});
    const old = restored ? JSON.parse(JSON.stringify(previous)) as AnalysisResult : previous;
    next.result.claimSupport = old.claimSupport;
    next.result.claimVerificationResult = old.claimVerificationResult;
    const final = await next.run();
    expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
      referenceResults: [{status: 'missing', message: 'evidence_not_retained'}]});
    expect(final.result.deliveryAssurance?.claims).toBe('coverage_incomplete');
  });
});

describe('issued investigation ledger through finalization', () => {
  function investigationRun(settings: {rows?: number; originRunId?: string; partialSibling?: boolean;
    fakeLedger?: boolean; explanationOnly?: boolean; report?: boolean; oversizedBody?: boolean;
    /** Distinct metrics the producer declares. A real run spreads its ledger
     * across several; a fixture that puts every record under one metric would
     * be measuring the per-metric share rather than the semantic byte budget. */
    metrics?: number} = {}) {
    const body = 'The captured value is 49. CPU evidence describes the selected window.' +
      (settings.oversizedBody ? 'x'.repeat(FINAL_SEMANTIC_INPUT_BYTE_LIMIT) : '');
    const claimText = 'The captured value is 49.';
    const contract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{
        id: 'count', kind: 'numeric', text: claimText, references: [{evidenceRefId: 'data:count', rowIndex: 0, column: 'count', value: 49}],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted',
          quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows',
            subjectRefs: [{evidenceRefId: 'data:count', rowIndex: 0, column: 'count', value: 49}]},
          numeric: {operator: 'eq', value: 49, unit: 'count'}}}]};
    const result: AnalysisResult = {sessionId: 'investigation-integration', conclusion: body, success: true,
      confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1,
      conclusionContract: parseConclusionContractDeclaration(contract).contract};
    const store = new ArtifactStore();
    const count = createDataEnvelope({columns: ['count'], rows: [[49]]}, {type: 'sql_result', source: 'execute_sql',
      title: 'Count', evidenceRefId: 'data:count', traceId: 'trace', traceSide: 'current', executionStatus: 'observed'});
    store.registerStandaloneEvidenceCapture(captureEvidenceTable(count.data, {count: {unit: 'count',
      origin: {kind: 'native_producer', definitionFingerprint: 'count-v1'}}}), {meta: count.meta, display: count.display, originRunId: 'run'});
    if (!settings.explanationOnly) {
      const originRunId = settings.originRunId || 'run';
      store.observeInvestigationTool({toolCallId: 'system-call', toolName: 'fixture', params: {}, extra: {}, phase: 'started'}, originRunId);
      store.observeInvestigationTool({toolCallId: 'system-call', toolName: 'fixture', params: {}, extra: {}, phase: 'completed',
        result: {content: []}}, originRunId);
      // Each declared metric needs its own value column: captured field
      // semantics are keyed by column, so two metrics sharing one collide
      // instead of recording twice.
      const valueColumns = Array.from({length: settings.metrics ?? 1},
        (_, index) => index === 0 ? 'freq' : `freq_${index}`);
      const data = {columns: ['start', 'end', 'cpu', ...valueColumns, 'status'], rows: Array.from({length: settings.rows ?? 2}, (_, index) =>
        [100 * Math.floor(index / 10), 100 * Math.floor(index / 10) + 100, index % 10, ...valueColumns.map(() => 1200),
          settings.partialSibling && index === 1 ? 'partial' : 'observed'])};
      const witness = captureEvidenceTable(data);
      attachInvestigationEvidence(witness, {skillId: 'cpu_fixture', stepId: 'root', traceId: 'trace',
        definitionFingerprint: evidenceCaptureHash('producer-v1'), selectedSqlHash: evidenceCaptureHash('actual-sql'), declaration: {
          window: {start: 'start', end: 'end'}, identity: {cpu: 'cpu'},
          metrics: valueColumns.map((column, index) => ({domain: 'cpu_frequency',
            metric_id: index === 0 ? 'system.cpu.frequency.time_weighted' : `system.cpu.frequency.sibling_${index}`,
            value: column, unit: 'kHz', status: 'status', aggregation: 'window_time_weighted'}))}});
      const envelope = createDataEnvelope(data, {type: 'skill_result', source: 'cpu_fixture', title: 'CPU',
        traceId: 'trace', traceSide: 'current', sourceToolCallId: 'fixture:1:system', evidenceRefId: 'data:system', executionStatus: 'observed'});
      // The runtime call id, not the synthetic producer id, joins a capture to its observation.
      recordCaptureToolCall(witness, 'system-call');
      store.registerStandaloneEvidenceCapture(witness, {meta: envelope.meta, display: envelope.display, originRunId});
    }
    const strategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General.', strategyKind: 'normal',
      priority: 1, effort: 'low', keywords: [], requiredCapabilities: [], optionalCapabilities: [],
      verifierMisdiagnosisPatterns: [], content: 'General.', detailSections: [], sourcePath: '/fixture/general.strategy.md',
      investigationContract: {schemaVersion: 1, profileRefs: [], requirements: [{id: 'system-frequency', domain: 'cpu_frequency',
        description: 'Describe the selected CPU window.', required: true,
        ...(settings.explanationOnly ? {} : {evidenceMetrics: ['system.cpu.frequency.time_weighted']})}]},
      finalReportContract: settings.report ? {requiredSections: [{id: 'detail', label: 'Detail', required: true,
        triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []}}]} : null};
    const pinned = buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'ledger-finalization'});
    const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(body)};
    const actualView = store.createEvidenceReadView({ownerKey: 'run', currentRunId: 'run', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]});
    const originalLedger = actualView.investigationEvidence!();
    const evidenceReadView: EvidenceReadView = settings.fakeLedger ? {...actualView,
      investigationEvidence: () => JSON.parse(JSON.stringify(originalLedger))} : actualView;
    const dispatch = jest.fn(async (input: IntentTransportInput): Promise<IntentTransportResult> => {
      const snapshot = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n{') + 2));
      const selected = snapshot.investigationEvidence?.records[0];
      return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@4',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: snapshot.body.length}]},
        claims: [{claimId: 'count', consistency: 'consistent', contentLocations: [{text: claimText}], issues: []}], omissions: [],
        requirements: (snapshot.reportRequirements?.requirements || []).map((requirement: {id: string}) => ({
          requirementId: requirement.id, applicability: 'applicable', coverage: 'covered', contentLocations: [{text: snapshot.body}], claimIds: ['count']})),
        investigation: snapshot.investigationRequirements.requirements.map((requirement: {id: string}) => ({
          requirementId: requirement.id, applicability: 'applicable', coverage: 'covered', contentLocations: [{text: snapshot.body}],
          evidenceRecordIds: selected ? [selected.recordId] : [], scopeMatch: selected ? 'matched' : 'unknown',
          evidenceStatus: settings.explanationOnly ? 'not_applicable' : selected ? 'observed' : 'not_checked'}))})};
    });
    // Beyond Jest's own timeout: these tests assert what the review sees, never how
    // fast it is built. Prompt sizing is synchronous, so on a loaded machine any
    // wall-clock budget lapsed before dispatch and the review ended `timeout`.
    attachFinalizationContext(result, {runId: 'run', sessionId: result.sessionId, deadlineMs: Date.now() + 10 * 60_000,
      strategyRegistry: pinned, traceIdentity: {currentTraceId: 'trace'},
      turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: pinned.registryFingerprint,
        taskKind: 'investigation', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
        deliverable: settings.report ? 'report' : 'answer', evidenceAccess: 'existing_only'},
      deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
        completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}}, evidenceReadView, dispatchText: dispatch});
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    const owner: AnalysisFinalizationOwner = {runId: 'run', signal: controller.signal, isCurrent: () => true, assertAuthorized: () => {}};
    return {result, context, dispatch, originalLedger,
      run: (extra: {caseRecommendations?: CaseKnowledgeReportRecommendation[]} = {}) => finalizeAnalysisResult({result,
        context, owner, query: 'Describe the selected CPU window.', dataEnvelopes: [count], ...extra})};
  }

  it('keeps a checked investigation and report when a private guard breaks a retrieved hit', async () => {
    const guard = 'password=background';
    const baselineRun = investigationRun({report: true});
    registerPrivateAnalysisQueryForEcho(baselineRun.result.sessionId, guard);
    const baseline = await baselineRun.run();
    const target = investigationRun({report: true});
    registerPrivateAnalysisQueryForEcho(target.result.sessionId, guard);
    const final = await target.run({caseRecommendations: [{caseId: 'scroll-bg-002', title: 'A background case',
      matchStrength: 'background', recommendations: {app: [], oem: []}}]});

    expect(final.result.conclusionContract).not.toHaveProperty('caseRecommendations');
    expect(final.result.deliveryAssurance).toEqual(baseline.result.deliveryAssurance);
    expect(final.result.investigationAssessment?.status).toBe('checked');
    expect(final.result.reportAssessment?.status).toBe('checked');
    expectOwnerSurfacesStable(final.result);
  });

  it.each(['run', 'previous-run'])('preserves issued %s capture identity through the sole semantic review and delivery', async originRunId => {
    const target = investigationRun({originRunId});
    expect(target.context.investigationEvidence?.fingerprint).toBe(target.originalLedger.fingerprint);
    const final = await target.run();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(final.result.investigationAssessment?.evidenceRecords).toEqual(target.originalLedger.records);
    expect(final.result.investigationAssessment?.evidenceRecords?.[0]).toMatchObject({originRunId,
      origin: originRunId === 'run' ? 'current_run' : 'reused'});
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'passed', investigationEvidence: 'passed'});
  });

  it('isolates a bad investigation location without losing verified claims or delivered report content', async () => {
    const target = investigationRun({report: true});
    const originalDispatch = target.dispatch.getMockImplementation()!;
    target.dispatch.mockImplementation(async input => {
      const response = await originalDispatch(input);
      if (response.status !== 'ok') throw new Error('fixture expected a review');
      const review = JSON.parse(response.text);
      review.investigation[0].contentLocations = [{text: 'Not a quotation from this answer.'}];
      return {...response, text: JSON.stringify(review)};
    });
    const body = target.result.conclusion;
    const final = await target.run();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete',
      notCheckedDetail: 'resp_investigation_invalid_location'});
    expect(final.result.claimVerificationResult?.claimResults[0].status).toBe('verified');
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'passed',
      report: 'passed', investigation: 'coverage_incomplete'});
    expect(final.result.investigationAssessment?.requirements[0].coverage).toBe('unknown');
    expect(final.result.conclusion).toBe(body);
    expect(final.result.partial).not.toBe(true);
    expect(final.result.terminationReason).toBeUndefined();
  });

  // Every delivery surface reads the finalized assessment through an explicit
  // field copier, and the projection treats any difference from its input as
  // tampering. A field the finalizer emits but the copier does not know
  // (`ledgerAcquisition` once) therefore turned every covered row into
  // `coverage: unknown` on SSE, reports and snapshots.
  it('delivers the finalized investigation assessment unchanged through owner and snapshot projection', async () => {
    const final = await investigationRun().run();
    const assessment = final.result.investigationAssessment!;
    expect(assessment.status).toBe('checked');
    expect(assessment.ledgerAcquisition).toEqual([expect.objectContaining({requirementId: 'system-frequency',
      status: 'observed', observedMetrics: ['system.cpu.frequency.time_weighted']})]);
    for (const delivered of [projectOwnerAnalysisResult(final.result.sessionId, final.result, 'en'),
      copyAnalysisResultForSnapshot(final.result)]) {
      expect(delivered.investigationAssessment).toEqual(assessment);
      expect(delivered.investigationAssessment?.requirements[0]).toMatchObject({coverage: 'covered', acquisition: 'observed'});
      expect(delivered.deliveryAssurance).toMatchObject({investigation: 'passed', investigationEvidence: 'passed'});
    }
  });

  it('rejects a serialized ledger while preserving original claim evidence and native completion', async () => {
    const target = investigationRun({fakeLedger: true});
    expect(target.context.investigationEvidence).toBeUndefined();
    const final = await target.run();
    expect(final.result.investigationAssessment?.evidenceRecords).toBeUndefined();
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'passed'});
    expect(final.result.deliveryAssurance?.investigationEvidence).not.toBe('passed');
  });

  it('keeps explanations without capture obligations separate from fabricated acquisition', async () => {
    const target = investigationRun({explanationOnly: true});
    const final = await target.run();
    expect(final.result.investigationAssessment?.evidenceRecords).toEqual([]);
    expect(final.result.investigationAssessment?.requirements[0].acquisition).toBe('not_applicable');
    expect(final.result.deliveryAssurance).toMatchObject({investigation: 'passed', investigationEvidence: 'not_applicable'});
  });

  it('expands a selected good CPU record to its partial sibling instead of accepting cherry-picked acquisition', async () => {
    const target = investigationRun({partialSibling: true});
    const final = await target.run();
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(final.result.investigationAssessment?.requirements[0].acquisition).toBe('insufficient');
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'passed', investigationEvidence: 'coverage_incomplete'});
  });

  it('carries all 300 records when the complete ledger fits the shared semantic budget', async () => {
    const target = investigationRun({rows: 300, report: true});
    const final = await target.run();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    const input = target.dispatch.mock.calls[0][0];
    const snapshot = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n{') + 2));
    expect(snapshot.investigationEvidence.byteBudget).toBeGreaterThan(64 * 1024);
    expect(snapshot.investigationEvidence.byteBudget).toBeLessThanOrEqual(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(snapshot.investigationEvidence), 'utf8')).toBeLessThanOrEqual(snapshot.investigationEvidence.byteBudget);
    expect(snapshot.investigationEvidence.omittedRecordCount).toBe(0);
    expect(snapshot.investigationEvidence.complete).toBe(true);
    expect(snapshot.investigationEvidence.records).toHaveLength(300);
    expect(snapshot.investigationEvidence.records.length + snapshot.investigationEvidence.omittedRecordCount).toBe(300);
    expect(snapshot.contentLocationCatalog).toMatchObject({schemaVersion: 'final_semantic_location_catalog@1',
      entries: [expect.objectContaining({text: target.result.conclusion})]});
    expect(Buffer.byteLength(input.prompt, 'utf8')).toBeLessThanOrEqual(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(final.result.investigationAssessment?.evidenceRecords).toHaveLength(300);
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'passed', report: 'passed'});
  });

  it('omits only complete cohorts when the full ledger exceeds the shared semantic budget', async () => {
    const target = investigationRun({rows: 1000, metrics: 2, report: true});
    const final = await target.run();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    const input = target.dispatch.mock.calls[0][0];
    const snapshot = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n{') + 2));
    expect(Buffer.byteLength(input.prompt, 'utf8')).toBeLessThanOrEqual(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(snapshot.contentLocationCatalog.entries).toEqual([
      expect.objectContaining({text: target.result.conclusion}),
    ]);
    expect(snapshot.investigationEvidence.omittedRecordCount).toBeGreaterThan(0);
    expect(snapshot.investigationEvidence.records.length % 10).toBe(0);
    expect(snapshot.investigationEvidence.issues).toContain('investigation_provider_view_omitted_records');
    expect(snapshot.investigationEvidence.complete).toBe(false);
    expect(snapshot.investigationEvidence.records.length + snapshot.investigationEvidence.omittedRecordCount).toBe(2000);
    expect(final.result.investigationAssessment?.evidenceRecords).toHaveLength(2000);
  });

  it('does not dispatch when the complete semantic prompt exceeds the shared transport budget', async () => {
    const target = investigationRun({oversizedBody: true});
    const final = await target.run();
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit',
      inputDiagnostic: {stage: 'prompt_assembly', code: 'byte_limit_exceeded', limitBytes: FINAL_SEMANTIC_INPUT_BYTE_LIMIT}});
    expect(final.semanticAssessment?.inputDiagnostic?.actualBytes).toBeGreaterThan(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(target.originalLedger.records).toHaveLength(2);
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'coverage_incomplete'});
  });

  it('delivers the accepted body when template loading throws during ledger sizing', async () => {
    const target = investigationRun();
    const originalBody = target.result.conclusion;
    const loader = jest.spyOn(strategyTemplates, 'loadPromptTemplate').mockImplementation(() => {throw new Error('missing fixture template');});
    try {
      const final = await target.run();
      expect(final.semanticAssessment).toMatchObject({status: 'unavailable', reason: 'missing_template'});
      expect(final.result.conclusion).toBe(originalBody);
      expect(final.result.deliveryAssurance?.completion).toBe('passed');
      expect(final.result.investigationAssessment?.evidenceRecords).toHaveLength(2);
      expect(final.result.deliveryAssurance?.investigationEvidence).not.toBe('passed');
      expect(target.dispatch).not.toHaveBeenCalled();
    } finally {loader.mockRestore();}
  });
});

describe('shared final analysis boundary', () => {
  it('reviews source quotations and original declarations without an echo collision', async () => {
    const marker = 'synthetic_source_marker_long_name';
    const target = fixture({source: {marker}, body: `The captured name is ${marker}.`, dispatch: async input => {
      const snapshot = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n{') + 2));
      const location = {start: 0, end: snapshot.body.length, text: snapshot.body};
      return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: snapshot.body.length}]},
        claims: [{claimId: 'count', consistency: 'consistent', contentLocations: [location], issues: []}],
        omissions: [], requirements: []})};
    }});
    const final = await target.run();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(final.semanticAssessment?.status).toBe('checked');
    const prompt = target.dispatch.mock.calls[0][0].prompt;
    const snapshot = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
    expect(snapshot.body).toBe(final.result.conclusion);
    expect(snapshot.body).toContain(marker);
    expect(snapshot.conclusionContract.claims[0].text).toBe(`The captured name is ${marker}.`);
    expect(JSON.stringify(final.result)).toContain(marker);
  });

  it('matches original captured source-marker cells while retaining their owner declaration', async () => {
    const marker = 'synthetic_source_marker_long_name';
    const target = fixture({source: {marker}, body: `The captured name is ${marker}.`});
    expect(target.result.conclusion).toContain(marker);
    const final = await target.run();
    expect(final.result.conclusionContract?.bindingEligibility).toBe('eligible');
    expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
      referenceResults: [{status: 'matched'}]});
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(target.dispatch.mock.calls)).toContain(marker);
    expect(final.result.conclusionContract?.claims?.[0].text).toContain(marker);
    expect(final.result.claimSupport?.[0].text).toBe(final.result.conclusionContract?.claims?.[0].text);
    expect(final.result.claimVerificationResult?.claimResults[0].claimId).toBe(
      final.result.conclusionContract?.claims?.[0].id,
    );
    expect(final.result.deliveryAssurance).toMatchObject({claims: 'coverage_incomplete', source: 'passed'});
    expect(final.result.conclusionContract?.sourceUseDecision).toEqual(final.result.sourceUseDecision);
    expect(final.result.conclusionContract?.sourceReferences).toEqual(final.result.sourceReferences);

    const ownerAgain = projectOwnerAnalysisResult(final.result.sessionId, final.result, 'en');
    expect(ownerAgain.conclusionContract).toEqual(final.result.conclusionContract);
    expect(ownerAgain.claimVerificationResult).toEqual(final.result.claimVerificationResult);
    expect(ownerAgain.claimSupport).toEqual(final.result.claimSupport);
    expect(ownerAgain.sourceUseDecision).toEqual(final.result.sourceUseDecision);
    expect(ownerAgain.sourceClaimVerificationResult).toEqual(final.result.sourceClaimVerificationResult);
    expect(ownerAgain.deliveryAssurance).toEqual(final.result.deliveryAssurance);
    expect(ownerAgain.sourceClaimVerificationResult?.status).toBe('passed');

    const strict = projectPrivateAnalysisResult(final.result.sessionId, ownerAgain, 'en');
    expect(JSON.stringify(strict.conclusionContract)).not.toContain(marker);
    expect(strict.claimVerificationResult?.passed).toBe(false);
    expect(strict.claimSupport?.[0]).toMatchObject({supportLevel: 'partial', bindingEligibility: 'ineligible'});
    expect(strict.sourceClaimVerificationResult?.status).not.toBe('passed');
  });

  it('does not add source declarations when the model only used an authorized source ledger', async () => {
    const marker = 'synthetic_source_marker_long_name';
    const target = fixture({source: {marker, declareBindings: false}, body: `The captured name is ${marker}.`});
    const final = await target.run();

    expect(final.result.sourceUseDecision?.references).toHaveLength(1);
    expect(final.result.sourceReferences).toEqual(final.result.sourceUseDecision?.references);
    expect(final.result.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(final.result.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(final.result.conclusionContract).not.toHaveProperty('sourceClaimBindings');
    expect(final.result.sourceClaimVerificationResult).toEqual({
      schemaVersion: 'source_claim_verifier@2', status: 'not_checked', bindings: [], claims: [], citations: [], issues: [],
    });
    const ownerAgain = projectOwnerAnalysisResult(final.result.sessionId, final.result, 'en');
    expect(ownerAgain.conclusionContract).toEqual(final.result.conclusionContract);
    expect(ownerAgain.sourceUseDecision).toEqual(final.result.sourceUseDecision);
    expect(ownerAgain.sourceClaimVerificationResult).toEqual(final.result.sourceClaimVerificationResult);
    expect(ownerAgain.claimVerificationResult).toEqual(final.result.claimVerificationResult);
    expect(ownerAgain.deliveryAssurance).toEqual(final.result.deliveryAssurance);
  });

  it('does not turn different originals into a match when both display as the same CodeRef', async () => {
    const target = fixture({source: {marker: 'synthetic_source_marker_one_name', declaredMarker: 'synthetic_source_marker_two_name'}});
    const final = await target.run();
    expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
      referenceResults: [{status: 'value_mismatch'}]});
  });

  it.each(['compatible', 'corroborated'] as const)(
    'links a candidate source connection to its matched Trace evidence and ignores a declared %s status', async mechanismStatus => {
      const target = fixture({source: {marker: 'synthetic_source_marker_long_name', hypothetical: true, mechanismStatus},
        body: 'The captured marker might correspond to this source instrumentation.'});
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'passed', passed: true,
        claimResults: [{status: 'inference', referenceResults: [{status: 'matched'}]}]});
      // Source plus same-claim Trace evidence, never a proven mechanism; the declared status counts for nothing.
      expect(final.result.sourceClaimVerificationResult).toMatchObject({status: 'passed',
        claims: [{claimId: 'count', status: 'trace_linked', traceEvidenceRefIds: ['data:count']}]});
      expect(JSON.stringify(final.result.sourceClaimVerificationResult)).not.toContain('mechanismStatus');
      expect(final.result.sourceClaimVerificationResult?.issues).toEqual([]);
    });

  it('rejects mismatched Trace evidence even for a hypothetical source connection', async () => {
    const target = fixture({source: {marker: 'synthetic_source_marker_one_name',
      declaredMarker: 'synthetic_source_marker_two_name', hypothetical: true},
      body: 'The captured marker might correspond to this source instrumentation.'});
    const final = await target.run();
    expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
      referenceResults: [{status: 'value_mismatch'}]});
    expect(final.result.sourceClaimVerificationResult).toMatchObject({status: 'failed',
      claims: [{claimId: 'count', status: 'invalid'}]});
    expect(final.result.sourceClaimVerificationResult?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_trace_support_missing', severity: 'error'}),
    ]));
  });

  it('retains the semantic review reason alongside an independent failed claim', async () => {
    const marker = 'synthetic_source_marker_one_name';
    const target = fixture({source: {marker, declaredMarker: 'synthetic_source_marker_two_name'}});
    registerCodeAwareCanary(target.result.sessionId, marker);
    const final = await target.run();
    expect(final.semanticAssessment).toMatchObject({reason: 'input_projection_incomplete'});
    expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
      notCheckedReason: 'input_projection_incomplete', claimResults: [{status: 'unsupported'}]});
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('does not invent an unavailable reason when a completed semantic review rejects a claim', async () => {
    const target = fixture({inconsistent: true, body: 'The captured value is 50.'});
    const final = await target.run();
    expect(final.semanticAssessment).toMatchObject({status: 'checked', consistency: 'inconsistent'});
    expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
      claimResults: [{status: 'unsupported'}]});
    expect(final.result.claimVerificationResult?.notCheckedReason).toBeUndefined();
    expect(target.dispatch).toHaveBeenCalledTimes(1);
  });

  // An exact repetition does not explain a review mismatch as display rounding.
  it('keeps an exact numeric repetition reported as a mismatch an error', async () => {
    const target = fixture({inconsistent: true});
    const final = await target.run();
    const verification = final.result.claimVerificationResult;
    expect(verification).toMatchObject({status: 'failed', passed: false, unsupportedClaimCount: 1,
      claimResults: [{status: 'unsupported'}]});
    expect(verification?.issues.some(issue => issue.severity === 'error' && issue.code === 'semantic_numeric_mismatch'))
      .toBe(true);
    expect(verification?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding')).toBe(false);
  });

  describe('explicit numeric presentation bindings', () => {
    const numericCell = (displayed: string, text = displayed) => ({value: 32.57614380379747, unit: 'ms', displayed,
      numeric: {operator: 'eq' as const, value: 32.57614380379747, unit: 'ms', presentation: {
        schemaVersion: 'numeric_presentation@1' as const, unit: 'ms', decimalPlaces: 1,
        rounding: 'half_away_from_zero' as const, quotes: [{text}],
      }}});

    it('checks the displayed value before review and retains a separate matched result', async () => {
      const target = fixture({numericCell: numericCell('32.6 ms')});
      const original = structuredClone(target.result.conclusionContract);
      const final = await target.run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'verified',
        deterministicProof: {status: 'proved'}, numericPresentation: {schemaVersion: 'numeric_presentation_assessment@1',
          status: 'matched', reason: 'display_matches', locations: [{start: 22, end: 29}]}});
      expect(target.dispatch).toHaveBeenCalledTimes(1);
      expect(target.dispatch.mock.calls[0][0].prompt).toContain('numericPresentation');
      expect(target.dispatch.mock.calls[0][0].prompt).toContain('display_matches');
      expect(final.result.conclusionContract?.claims).toEqual(original?.claims);
      expect(final.result.conclusion).toContain('32.6 ms');
    });

    it('rejects an incorrect bound number even when the reviewer would say consistent', async () => {
      const final = await fixture({numericCell: numericCell('32.7 ms'), report: true}).run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
        claimResults: [{status: 'unsupported', deterministicProof: {status: 'proved'},
          numericPresentation: {status: 'mismatch', reason: 'display_value_mismatch'}}]});
      expect(final.result.terminationReason).toBeUndefined();
      expect(final.result.partial).not.toBe(true);
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
        code: 'numeric_presentation_mismatch', severity: 'error'}));
    });

    it('does not turn an unresolved binding into verification through model agreement', async () => {
      const final = await fixture({numericCell: numericCell('32.6 ms', '99.9 ms'), report: true}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
        numericPresentation: {status: 'not_checked', reason: 'quote_unresolved'}});
      expect(final.result.claimVerificationResult?.passed).toBe(false);
    });

    it.each([false, true])('keeps quote-unresolved rounding unverified with an issued reference alias=%s', async toolCallReference => {
      const body = 'The captured value is 32.6 ms.';
      const final = await fixture({toolCallReference, report: true, numericCell: numericCell('32.6 ms', '99.9 ms'),
        dispatch: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
          claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [{start: 22, end: 29, text: '32.6 ms'}],
            issues: [{code: 'numeric_mismatch', contentLocations: [{start: 22, end: 29, text: '32.6 ms'}]}]}],
          omissions: [], requirements: []})})}).run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
        unsupportedClaimCount: 0, claimResults: [{status: 'partial', numericPresentation: {
          status: 'not_checked', reason: 'quote_unresolved'}}]});
      expect(final.semanticAssessment).toMatchObject({claims: [{consistency: 'inconsistent'}]});
      expect(final.result.claimVerificationResult?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({code: 'numeric_presentation_not_checked', severity: 'warning'}),
        expect.objectContaining({code: 'semantic_numeric_display_rounding', severity: 'warning'}),
      ]));
    });

    it('retains a reviewer disagreement without asserting an arithmetic error or upgrading the claim', async () => {
      const body = 'The captured value is 32.6 ms.';
      const final = await fixture({numericCell: numericCell('32.6 ms'), dispatch: async () => ({status: 'ok',
        text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
          claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [{start: 0, end: body.length, text: body}],
            issues: [{code: 'numeric_mismatch', contentLocations: [{start: 22, end: 29, text: '32.6 ms'}]}]}],
          omissions: [], requirements: []})})}).run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
        claimResults: [{status: 'partial', numericPresentation: {status: 'matched'},
          semanticReview: {consistency: 'inconsistent'}}],
        issues: expect.arrayContaining([expect.objectContaining({severity: 'warning', code: 'numeric_presentation_review_disagreement'})])});
    });

    it.each([
      {value: 32576143, unit: 'ns', displayed: '32.6 ms', displayUnit: 'ms', decimals: 1, status: 'matched'},
      {value: 32.576, unit: 'ms', displayed: '32.6 毫秒', displayUnit: 'ms', decimals: 1, status: 'matched'},
      {value: 32576143, unit: 'ns', displayed: '0.033 秒', displayUnit: 's', decimals: 3, status: 'matched'},
      {value: 32600, unit: 'ns', displayed: '32.6 微秒', displayUnit: 'µs', decimals: 1, status: 'matched'},
      {value: 326, unit: 'ns', displayed: '326 纳秒', displayUnit: 'ns', decimals: 0, status: 'matched'},
      {value: 32.576, unit: 'ms', displayed: '32.7 毫秒', displayUnit: 'ms', decimals: 1, status: 'mismatch'},
      {value: 32.576, unit: 'ms', displayed: '32.6 分钟', displayUnit: 'ms', decimals: 1, status: 'not_checked'},
      {value: '32576143.80379747', unit: 'ns', displayed: '32.6 ms', displayUnit: 'ms', decimals: 1, status: 'matched'},
      {value: -2.25, unit: 'ms', displayed: '-2.3 ms', displayUnit: 'ms', decimals: 1, status: 'matched'},
      {value: 0.326, unit: 'ratio', displayed: '32.6%', displayUnit: '%', decimals: 1, status: 'matched'},
      {value: 1048576, unit: 'B', displayed: '1.0 MiB', displayUnit: 'MiB', decimals: 1, status: 'matched'},
      {value: 49, unit: 'frames', displayed: '49 count', displayUnit: 'count', decimals: 0, status: 'matched'},
      {value: 49, unit: 'count', displayed: '49', displayUnit: 'count', decimals: 0, status: 'matched'},
      {value: 61.995675, unit: 'ms', displayed: '61.99 ms', displayUnit: 'ms', decimals: 2, status: 'mismatch'},
      {value: 100, unit: 'count', displayed: '102', displayUnit: 'count', decimals: 0, status: 'mismatch'},
      {value: 130, unit: 'ms', displayed: '380 ms', displayUnit: 'ms', decimals: 0, status: 'mismatch'},
      {value: 380, unit: 'ms', displayed: '380 ms', displayUnit: 'ms', decimals: 0, status: 'matched'},
      {value: 32.576, unit: 'ms', displayed: '32.6 B', displayUnit: 'B', decimals: 1, status: 'mismatch'},
      {value: 49, unit: 'count', displayed: '49.0', displayUnit: 'count', decimals: 1, status: 'not_checked'},
      {value: 0.04, unit: 'ms', displayed: '0.0 ms', displayUnit: 'ms', decimals: 1, status: 'not_checked'},
      {value: 32.576, unit: 'ms', displayed: '32.6 sec', displayUnit: 'sec', decimals: 1, status: 'not_checked'},
    ])('calculates $value $unit -> $displayed independently of semantic agreement', async sample => {
      const final = await fixture({numericCell: {...sample, numeric: {operator: 'eq', value: sample.value, unit: sample.unit,
        presentation: {schemaVersion: 'numeric_presentation@1', unit: sample.displayUnit, decimalPlaces: sample.decimals,
          rounding: 'half_away_from_zero', quotes: [{text: sample.displayed}]}}}}).run();
      const checked = final.result.claimVerificationResult!;
      expect(checked.claimResults[0].numericPresentation?.status).toBe(sample.status);
      expect(checked.passed).toBe(sample.status === 'matched');
      if (sample.status === 'mismatch') expect(checked.status).toBe('failed');
    });

    it.each([
      ['substring of longer number', '132.6 ms', '32.6 ms'],
      ['lost sign', '-32.6 ms', '32.6 ms'],
      ['unit suffix', '32.6 msec', '32.6 ms'],
      ['identifier prefix', 'P32.6 ms', '32.6 ms'],
      ['duplicate quote', '32.6 ms and 32.6 ms', '32.6 ms'],
      ['scientific notation', '3.26e1 ms', '3.26e1 ms'],
      ['unit split by markup', '**32.6** ms', '**32.6** ms'],
    ])('leaves %s unresolved rather than blessing a convenient substring', async (_label, displayed, text) => {
      const final = await fixture({numericCell: numericCell(displayed, text), report: true}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
        numericPresentation: {status: 'not_checked'}});
    });

    it('binds repeated occurrences explicitly and rejects duplicated locations', async () => {
      const cell = numericCell('32.6 ms and 32.6 ms', '32.6 ms');
      Object.assign(cell.numeric.presentation, {quotes: [{text: '32.6 ms', occurrence: 0}, {text: '32.6 ms', occurrence: 1}]});
      const final = await fixture({numericCell: cell}).run();
      expect(final.result.claimVerificationResult).toMatchObject({passed: true,
        claimResults: [{numericPresentation: {status: 'matched', locations: [{start: 22, end: 29}, {start: 34, end: 41}]}}]});
      Object.assign(cell.numeric.presentation, {quotes: [{text: '32.6 ms', occurrence: 0}, {text: '32.6 ms', occurrence: 0}]});
      expect((await fixture({numericCell: cell}).run()).result.claimVerificationResult?.claimResults[0])
        .toMatchObject({status: 'partial', numericPresentation: {status: 'not_checked', reason: 'binding_conflict'}});
    });

    it('does not let two claims borrow the same body token', async () => {
      const target = fixture({numericCell: numericCell('32.6 ms')});
      const claim = target.result.conclusionContract!.claims![0];
      target.result.conclusionContract!.claims!.push({...structuredClone(claim), id: 'second'});
      const final = await target.run();
      expect(final.result.claimVerificationResult?.claimResults).toHaveLength(2);
      for (const checked of final.result.claimVerificationResult!.claimResults) {
        expect(checked.numericPresentation).toMatchObject({status: 'not_checked', reason: 'binding_conflict'});
      }
      expect(final.result.claimVerificationResult?.passed).toBe(false);
    });

    it('does not hide a known mismatch behind a second claim using the same token', async () => {
      const target = fixture({numericCell: numericCell('32.7 ms')});
      target.result.conclusionContract!.claims!.push({...structuredClone(target.result.conclusionContract!.claims![0]), id: 'second'});
      const verification = (await target.run()).result.claimVerificationResult!;
      expect(verification.status).toBe('failed');
      expect(verification.claimResults.every(claim => claim.numericPresentation?.status === 'mismatch')).toBe(true);
    });

    it('recomputes the result instead of trusting a receipt copied from a different answer', async () => {
      const original = (await fixture({numericCell: numericCell('32.6 ms')}).run()).result;
      const forged = fixture({numericCell: numericCell('32.7 ms')});
      forged.result.claimVerificationResult = structuredClone(original.claimVerificationResult);
      const final = (await forged.run()).result;
      expect(final.claimVerificationResult).toMatchObject({status: 'failed',
        claimResults: [{numericPresentation: {status: 'mismatch'}}]});
      expect(final.claimVerificationResult?.claimResults[0].numericPresentation?.binding.candidate.conclusionFingerprint)
        .toBe(analysisDeliveryFingerprint(final.conclusion));
    });

    it('keeps proof and original capture requirements even with a correct display binding', async () => {
      for (const options of [{capture: false}, {wrongReferenceValue: 32.6}]) {
        const final = await fixture({numericCell: numericCell('32.6 ms'), ...options}).run();
        expect(final.result.claimVerificationResult?.claimResults[0].numericPresentation)
          .toMatchObject({status: 'not_checked', reason: 'proposition_not_proved'});
        expect(final.result.claimVerificationResult?.passed).toBe(false);
      }
      const cell = numericCell('32.6 ms');
      cell.numeric.value = 32.6;
      const final = await fixture({numericCell: cell}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
        deterministicProof: {status: 'rejected'}, numericPresentation: {status: 'not_checked'}});
    });

    it.each([{toolCallReference: true}, {selectorReference: true}])('resolves an issued alternative reference (%#)', async options => {
      const final = await fixture({numericCell: numericCell('32.6 ms'), ...options}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({deterministicProof: {
        status: 'proved', reason: 'numeric_operator_proved'}});
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'verified',
        numericPresentation: {status: 'matched', reason: 'display_matches', source: {rowIndex: 0, column: 'count'}}});
    });

    it('never applies presentation rounding to an identity field', async () => {
      const final = await fixture({numericCell: numericCell('32.6 ms'), fieldIdentity: 'upid'}).run();
      expect(final.result.claimVerificationResult?.claimResults[0].numericPresentation)
        .toMatchObject({status: 'not_checked', reason: 'identity_field'});
      expect(final.result.claimVerificationResult?.passed).toBe(false);
    });

    it('does not turn an invalid sentence-shaped quote into another claim\'s binding conflict', async () => {
      const target = fixture({numericCell: numericCell('32.6 ms', 'The captured value is 32.6 ms.')});
      const second = structuredClone(target.result.conclusionContract!.claims![0]);
      second.id = 'second';
      second.semantics!.numeric!.presentation!.quotes = [{text: '32.6 ms'}];
      target.result.conclusionContract!.claims!.push(second);
      const checked = (await target.run()).result.claimVerificationResult!.claimResults;
      expect(checked[0].numericPresentation).toMatchObject({status: 'not_checked', reason: 'unsupported_display_format'});
      expect(checked[1].numericPresentation?.status).toBe('matched');
    });

    it('does not replace the authentic captured value with a mutable display table', async () => {
      const target = fixture({numericCell: numericCell('32.7 ms')});
      (target.envelope.data as {rows: number[][]}).rows[0][0] = 32.7;
      expect((await target.run()).result.claimVerificationResult?.claimResults[0].numericPresentation)
        .toMatchObject({status: 'mismatch', reason: 'display_value_mismatch'});
    });

    it('retains the numeric result when semantic review is unavailable', async () => {
      const final = await fixture({numericCell: numericCell('32.6 ms'),
        dispatch: async () => ({status: 'unavailable', reason: 'provider_error'})}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
        numericPresentation: {status: 'matched'}});
      expect(final.result.claimVerificationResult?.passed).toBe(false);
    });

    it('keeps a whole-sentence contradiction outside the numeric disagreement exception', async () => {
      const final = await fixture({numericCell: numericCell('32.6 ms'), inconsistent: true}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
        numericPresentation: {status: 'matched'}});
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({severity: 'error',
        code: 'semantic_numeric_mismatch'}));
    });

    it('retains bindings and separate outcomes through owner, snapshot and closed evidence projections', async () => {
      const final = await fixture({numericCell: numericCell('32.6 ms'), nativeProjection: true}).run();
      const checked = final.result.claimVerificationResult!.claimResults[0].numericPresentation;
      expect(checked?.status).toBe('matched');
      expect(projectOwnerAnalysisResult(final.result.sessionId, final.result, 'en').claimVerificationResult?.claimResults[0].numericPresentation).toEqual(checked);
      expect(copyAnalysisResultForSnapshot(final.result).claimVerificationResult?.claimResults[0].numericPresentation).toEqual(checked);
      expect(projectPrivateAnalysisResult(final.result.sessionId, final.result, 'en').claimVerificationResult?.claimResults[0].numericPresentation).toBeUndefined();
    });

    it('keeps a proven wrong display when another quote is unresolved', async () => {
      const cell = numericCell('32.7 ms');
      cell.numeric.presentation.quotes.push({text: 'missing'});
      expect((await fixture({numericCell: cell}).run()).result.claimVerificationResult?.claimResults[0])
        .toMatchObject({status: 'unsupported', numericPresentation: {status: 'mismatch'}});
    });

    it('does not verify a correct literal that the semantic review never located', async () => {
      const body = 'The captured value is 32.6 ms.';
      const final = await fixture({numericCell: numericCell('32.6 ms'), dispatch: async () => ({status: 'ok',
        text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
          claims: [{claimId: 'count', consistency: 'consistent', contentLocations: [{start: 0, end: 18, text: body.slice(0, 18)}],
            issues: []}], omissions: [], requirements: []})})}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'partial',
        numericPresentation: {status: 'matched'}, semanticReview: {consistency: 'consistent'}});
    });

    it('keeps scope contradictions even when the numeric literal matches', async () => {
      const body = 'The total is 32.6 ms.';
      const final = await fixture({body, numericCell: numericCell('32.6 ms'), dispatch: async () => ({status: 'ok',
        text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
          claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [{start: 0, end: body.length, text: body}],
            issues: [{code: 'scope_mismatch', contentLocations: [{start: 0, end: body.length, text: body}]}]}],
          omissions: [], requirements: []})})}).run();
      expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
        numericPresentation: {status: 'matched'}});
    });
  });

  describe('numeric display precision', () => {
    it.each([
      {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms'},
      {value: 32576143, unit: 'ns', displayed: '32.6 ms'},
      {value: '32576143', unit: 'ns', displayed: '32.6 ms',
        numeric: {operator: 'eq' as const, value: '32.576143', unit: 'ms'}},
      {value: 61.995675, unit: 'ms', displayed: '61.99 ms'},
      {value: 1048903, unit: 'bytes', displayed: '1.00 MiB'},
      {value: -3456000, unit: 'ns', displayed: '-3.45 ms'},
      {value: '0.9725389910893621', unit: 'ratio', displayed: '97.25%'},
    ])('records a faithful display of $value $unit as a warning without changing the raw proposition', async numericCell => {
      const target = fixture({inconsistent: true, numericCell});
      const original = structuredClone(target.result.conclusionContract);
      const originalBody = target.result.conclusion;
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
        unsupportedClaimCount: 0, claimResults: [{status: 'partial', deterministicProof: {status: 'proved'},
          propositionCoverage: {status: 'complete'}}]});
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
        code: 'semantic_numeric_display_rounding', severity: 'warning'}));
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(false);
      expect(final.result.conclusionContract?.claims?.[0].references).toEqual(original?.claims?.[0].references);
      expect(final.result.conclusionContract?.claims?.[0].semantics).toEqual(original?.claims?.[0].semantics);
      expect(final.result.conclusion).toBe(originalBody);
    });

    it.each([
      {value: 32.57614380379747, unit: 'ms', displayed: '32.7 ms'},
      {value: 100, unit: 'count', displayed: '102'},
      {value: 0.4, unit: 'ratio', displayed: '0 ratio'},
      {value: 32.57614380379747, unit: 'ms', displayed: '-32.6 ms'},
      {value: 32.57614380379747, unit: 'ms', displayed: 'over 32.6 ms'},
      {value: 32.57614380379747, unit: 'ms', displayed: '32.5–32.6 ms'},
      {value: 32.57614380379747, unit: 'ms', displayed: '32.6 MiB'},
      {value: 32500000, unit: 'ns', displayed: '32.5 ms'},
      {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms',
        numeric: {operator: 'gt' as const, value: 32, unit: 'ms'}},
    ])('keeps an incorrect or exact display $displayed an error', async numericCell => {
      const final = await fixture({inconsistent: true, numericCell}).run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
        claimResults: [{status: 'unsupported'}]});
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
        code: 'semantic_numeric_mismatch', severity: 'error'}));
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
        .toBe(false);
    });

    it('retains verified standing when a complete review accepts a marked faithful approximation', async () => {
      const target = fixture({numericCell: {value: 32.57614380379747, unit: 'ms', displayed: 'about 32.6 ms'}});
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'passed', passed: true,
        claimResults: [{status: 'verified', deterministicProof: {status: 'proved'}}]});
      expect(final.result.conclusionContract?.claims?.[0].references[0].value).toBe(32.57614380379747);
    });

    it.each(['reference', 'proposition'] as const)('does not repair a rounded raw %s value', async rounded => {
      const numericCell = {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms'};
      const target = fixture({inconsistent: true, report: true, currentRead: true, numericCell: rounded === 'proposition'
        ? {...numericCell, numeric: {operator: 'eq', value: 32.6, unit: 'ms'}} : numericCell,
      ...(rounded === 'reference' ? {wrongReferenceValue: 32.6} : {})});
      const final = await target.run();
      expect(final.result.claimVerificationResult?.claimResults[0].deterministicProof?.status)
        .toBe(rounded === 'reference' ? 'candidate' : 'rejected');
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
        .toBe(false);
      expect(final.result.claimVerificationResult?.passed).toBe(false);
    });

    it.each([
      {capture: false},
      {numericCell: {value: 32.57614380379747, unit: 'unknown_unit', displayed: '32.6 ms'}},
      {body: 'The captured value is 32.6 ms; another event lasts 32.6 ms.'},
    ])('requires one authoritative captured cell and one located display: %j', async options => {
      const target = fixture({inconsistent: true, report: true,
        numericCell: {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms'}, ...options});
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed',
        claimResults: [{status: 'unsupported'}]});
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
        .toBe(false);
    });

    it('preserves another semantic error when the numeric display is faithful', async () => {
      const body = 'The captured value is 32.6 ms.';
      const location = {start: 0, end: body.length, text: body};
      const target = fixture({body, numericCell: {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms'},
        dispatch: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
          claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [location], issues: [
            {code: 'numeric_mismatch', contentLocations: [location]}, {code: 'scope_mismatch', contentLocations: [location]},
          ]}], omissions: [], requirements: []})})});
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
        claimResults: [{status: 'unsupported'}]});
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
        code: 'semantic_scope_mismatch', severity: 'error'}));
    });

    it.each([{evidenceRefId: 'data:another-cell'}, {rowIndex: 1}, {column: 'another-column'}])(
      'cannot use a captured value for another semantic subject: %j', async referencePatch => {
        const target = fixture({inconsistent: true, report: true,
          numericCell: {value: 32.57614380379747, unit: 'ms', displayed: '32.6 ms'}});
        const scope = target.result.conclusionContract!.claims![0].semantics!.scope;
        scope.subjectRefs = [{...scope.subjectRefs![0], ...referencePatch}];
        const final = await target.run();
        expect(final.result.claimVerificationResult?.passed).toBe(false);
        expect(final.result.claimVerificationResult?.claimResults[0].deterministicProof?.status).not.toBe('proved');
        expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
          .toBe(false);
      });

    it('uses the issued raw value when a mutable display table would make the wrong rounding look faithful', async () => {
      const target = fixture({inconsistent: true,
        numericCell: {value: 32.57614380379747, unit: 'ms', displayed: '32.7 ms'}});
      target.envelope.data.rows[0][0] = 32.67614380379747;
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
        claimResults: [{status: 'unsupported', deterministicProof: {status: 'proved'}}]});
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
        .toBe(false);
    });

    it('rejects a 380 ms total bound to a 130 ms component, and proves the captured aggregate independently', async () => {
      const component = fixture({numericCell: {value: 130, unit: 'ms', displayed: '380 ms',
        numeric: {operator: 'eq', value: 380, unit: 'ms'}}});
      const failed = await component.run();
      expect(failed.result.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
        claimResults: [{status: 'unsupported', deterministicProof: {status: 'rejected', reason: 'numeric_operator_rejected'}}]});
      const aggregate = await fixture({numericCell: {value: 380, unit: 'ms', displayed: '380 ms'}}).run();
      expect(aggregate.result.claimVerificationResult).toMatchObject({status: 'passed', passed: true,
        claimResults: [{status: 'verified', deterministicProof: {status: 'proved'}}]});
    });
  });

  it('records a captured-cell mismatch that only shows the cell value at display precision as a warning', async () => {
    const target = fixture({inconsistent: true, capturedCell: {value: 61.25, unit: 'ms', displayed: '61.3 ms'}});
    const final = await target.run();
    const verification = final.result.claimVerificationResult;
    expect(verification).toMatchObject({status: 'partial', passed: false, unsupportedClaimCount: 0,
      claimResults: [{status: 'partial'}]});
    expect(verification?.issues).toContainEqual(expect.objectContaining({claimId: 'count', severity: 'warning',
      code: 'semantic_numeric_display_rounding'}));
    expect(verification?.issues.some(issue => issue.severity === 'error')).toBe(false);
  });

  it.each([
    ['a second same-value candidate in the claim text', {capturedCell: {value: 61.25, unit: 'ms', displayed: '61.3 ms'},
      body: 'The captured value is 61.3 ms; another 61.3 ms frame follows.'}],
    ['two anchor cells matching the subject reference', {capturedCell: {value: 61.25, unit: 'ms', displayed: '61.3 ms'},
      duplicateSubjectCellRef: true}],
  ])('keeps the mismatch an error with %s', async (_label, options) => {
    const target = fixture({inconsistent: true, ...options} as Parameters<typeof fixture>[0]);
    const final = await target.run();
    expect(final.result.claimVerificationResult).toMatchObject({status: 'failed',
      claimResults: [{status: 'unsupported'}]});
    expect(final.result.claimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(true);
    expect(final.result.claimVerificationResult?.issues.some(issue => issue.code === 'semantic_numeric_display_rounding'))
      .toBe(false);
  });

  it('keeps the mismatch an error when the issue location lies outside the claim locations', async () => {
    const body = 'The captured value is 61.3 ms.';
    const target = fixture({inconsistent: true, capturedCell: {value: 61.25, unit: 'ms', displayed: '61.3 ms'},
      dispatch: async (): Promise<IntentTransportResult> => ({status: 'ok', text: JSON.stringify({
        schemaVersion: 'final_semantic_response@1',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: target.result.conclusion.length}]},
        claims: [{claimId: 'count', consistency: 'inconsistent',
          contentLocations: [{start: 0, end: 12, text: 'The captured'}],
          issues: [{code: 'numeric_mismatch', contentLocations: [{start: body.indexOf('61.3 ms'),
            end: body.indexOf('61.3 ms') + '61.3 ms'.length, text: '61.3 ms'}]}]}],
        omissions: [], requirements: []})})});
    const final = await target.run();
    expect(final.result.claimVerificationResult).toMatchObject({status: 'failed',
      claimResults: [{status: 'unsupported'}]});
    expect(final.result.claimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(true);
  });

  it.each([false, true])('checks each explicitly located repeated rounded display, wrong second value=%s', async wrong => {
    const first = 'Captured target frequency is 3334433.6 kHz.';
    const second = `The same captured target frequency is ${wrong ? '3334433.7' : '3334433.6'} kHz.`;
    const body = `${first}\n${second}`;
    const locations = [{start: 0, end: first.length, text: first},
      {start: first.length + 1, end: body.length, text: second}];
    const target = fixture({body, numericCell: {value: 3334433.64, unit: 'kHz', displayed: '3334433.6 kHz'},
      dispatch: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
        claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: locations,
          issues: [{code: 'numeric_mismatch', contentLocations: locations}]}], omissions: [], requirements: []})})});
    const original = structuredClone(target.result.conclusionContract);
    const final = await target.run();
    expect(final.result.claimVerificationResult).toMatchObject({status: wrong ? 'failed' : 'partial', passed: false,
      unsupportedClaimCount: wrong ? 1 : 0,
      claimResults: [{status: wrong ? 'unsupported' : 'partial', deterministicProof: {status: 'proved'}}]});
    expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
      code: wrong ? 'semantic_numeric_mismatch' : 'semantic_numeric_display_rounding', severity: wrong ? 'error' : 'warning'}));
    expect(final.result.conclusionContract?.claims).toEqual(original?.claims);
    expect(final.result.conclusion).toBe(body);
  });

  it.each([
    ['another issue on the same claim', [{code: 'numeric_mismatch', located: true}, {code: 'scope_mismatch', located: true}]],
    ['a mismatch whose location did not resolve', [{code: 'numeric_mismatch', located: false}]],
  ])('requires a resolved objection before contradicting the captured value: %s', async (_label, reviewIssues) => {
    const body = 'The captured value is 49.';
    const location = {start: 0, end: body.length, text: body};
    const target = fixture({inconsistent: true, dispatch: async () => ({status: 'ok', text: JSON.stringify({
      schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
      claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [location],
        issues: reviewIssues.map(issue => ({code: issue.code, contentLocations: issue.located ? [location] : [{start: 0, end: 3, text: 'bad'}]}))}],
      omissions: [], requirements: []})})});
    const final = await target.run();
    if (reviewIssues.every(issue => issue.located)) {
      expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', claimResults: [{status: 'unsupported'}]});
      expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
        claimId: 'count', severity: 'error'}));
    } else {
      expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
        claimResults: [{status: 'partial', deterministicProof: {status: 'proved'}, semanticReview: {consistency: 'unknown'}}]});
      expect(final.result.claimVerificationResult?.unsupportedClaimCount).toBe(0);
      expect(final.result.claimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(false);
      expect(deriveDeliveryVerdict(final.result)).toBe('unverified');
    }
  });

  it('ignores tampered display evidence and continues to compare the original issued capture', async () => {
    const marker = 'synthetic_source_marker_long_name';
    const target = fixture({source: {marker}});
    target.envelope.data.rows[0][0] = 'FORGED_DISPLAY_CELL';
    const final = await target.run();
    expect(final.result.claimVerificationResult?.claimResults[0].referenceResults?.[0].status).toBe('matched');
    expect(JSON.stringify(target.dispatch.mock.calls)).not.toContain('FORGED_DISPLAY_CELL');
  });

  it.each(['claims', 'source'] as const)('rejects changed public %s after the private declaration was attached', async field => {
    const target = fixture({source: {marker: 'synthetic_source_marker_long_name'}});
    if (field === 'claims') target.result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []};
    else target.result.sourceUseDecision!.references = [];
    await expect(target.run()).rejects.toThrow('projection_mismatch');
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it.each(['canary', 'private_query'] as const)('does not restore captured values protected by a %s into semantic input', async kind => {
    const marker = 'synthetic_source_marker_long_name';
    const target = fixture({source: {marker}});
    if (kind === 'canary') registerCodeAwareCanary(target.result.sessionId, marker);
    else registerPrivateAnalysisQueryForEcho(target.result.sessionId, marker);
    const final = await target.run();
    expect(final.result.claimVerificationResult?.claimResults[0].referenceResults?.[0].status).toBe('matched');
    if (kind === 'canary') {
      expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete'});
      expect(target.dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(final.result)).not.toContain(marker);
    } else {
      expect(final.semanticAssessment?.status).toBe('checked');
      expect(target.dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(final.result)).toContain(marker);
    }
  });

  it('delivers claims of an invalid declaration as unverified rather than contradicted', async () => {
    const target = fixture({invalidDeclaration: true});
    const final = await target.run();
    expect(final.result.conclusionContract?.bindingEligibility).toBe('ineligible');
    expect(final.result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
      checkedClaimCount: 0, unsupportedClaimCount: 0, notCheckedReason: 'invalid_declarations',
      notCheckedDetail: 'untrusted_parser_metadata'});
    expect(final.result.claimVerificationResult?.issues.map(issue => [issue.severity, issue.code]))
      .toEqual([['warning', 'binding_ineligible']]);
    expect(final.result.deliveryAssurance?.claims).toBe('coverage_incomplete');
    expect(final.qualityIssue?.code).not.toBe('verifier_contradicted_claim');
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the native invalid declaration ineligible after source projection', async () => {
    const target = fixture({source: {marker: 'synthetic_source_marker_long_name', invalid: true}});
    const final = await target.run();
    expect(final.result.conclusionContract?.bindingEligibility).toBe('ineligible');
    expect(final.result.claimVerificationResult?.passed).toBe(false);
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(final.result)).toContain('synthetic_source_marker_long_name');
  });

  const capturedIdentity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: 'identity:target',
    status: 'verified', target: {traceId: 'trace', traceSide: 'current', upid: 42, source: 'skill_param'},
    processes: [{upid: 42, confidence: 1, matchSources: ['upid']}], threads: [], warnings: []};
  const capturedScope: EvidenceScopeProvenanceV1 = {version: 'process_scope_evidence@1', entries: [{role: 'target',
    scope: {mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 42, identityRefId: capturedIdentity.identityRefId}}]};

  it('replaces forged display identity with the issued capture even when no sidecar claims exist', async () => {
    const target = fixture({claim: false, identity: capturedIdentity, scope: capturedScope});
    delete target.result.conclusionContract;
    const forged = {...capturedIdentity, target: {...capturedIdentity.target, upid: 999},
      processes: [{upid: 999, confidence: 1, matchSources: ['FORGED']}]};
    target.envelope.meta.identityResolution = forged;
    target.result.identityResolutions = [forged];
    const {result} = await target.run();
    expect(result.identityResolutions).toEqual([capturedIdentity]);
    expect(target.result.identityResolutions).toEqual([forged]);
    expect(target.envelope.meta.identityResolution).toBe(forged);
  });

  it('never manufactures public identity from uncaptured compatibility metadata', async () => {
    const target = fixture({capture: false, identity: capturedIdentity, scope: capturedScope});
    target.envelope.meta.identityResolution = undefined;
    target.envelope.meta.identityRefId = capturedIdentity.identityRefId;
    target.envelope.meta.identityStatus = 'verified';
    target.result.identityResolutions = [capturedIdentity];
    expect((await target.run()).result.identityResolutions).toEqual([]);
  });

  it('retains captured ambiguous status instead of adopting a verified display override', async () => {
    const ambiguous = {...capturedIdentity, status: 'ambiguous' as const};
    const target = fixture({identity: ambiguous, scope: capturedScope});
    target.envelope.meta.identityResolution = capturedIdentity;
    target.envelope.meta.identityStatus = 'verified';
    expect((await target.run()).result.identityResolutions).toEqual([ambiguous]);
  });

  it('leaves public identity empty without a live context and never trusts result metadata', async () => {
    const target = fixture({identity: capturedIdentity, scope: capturedScope});
    target.context.dispose();
    target.result.identityResolutions = [capturedIdentity];
    const {result} = await finalizeAnalysisResult({result: target.result, owner: target.owner,
      query: 'What is already available?', dataEnvelopes: [target.envelope]});
    expect(result.identityResolutions).toEqual([]);
  });

  it('joins an issued captured cell with whole-body semantics before passing the current result', async () => {
    const target = fixture();
    const finalized = await target.run();
    expect(finalized.result.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', passed: true,
      claimResults: [{claimId: 'count', status: 'verified', deterministicProof: {status: 'proved'}}]});
    expect(finalized.result.deliveryAssurance).toMatchObject({entry: 'new_finalization', completion: 'passed', claims: 'passed'});
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(() => target.context.runId).toThrow();
  });

  it('does not turn matching preview values or semantic agreement into an execution proof', async () => {
    const target = fixture({capture: false});
    const {result} = await target.run();
    expect(result.claimVerificationResult?.passed).toBe(false);
    expect(result.claimVerificationResult?.claimResults.some(claim => claim.status === 'verified')).toBe(false);
    expect(result.deliveryAssurance?.claims).not.toBe('passed');
    expect(result.conclusion).toBe(target.result.conclusion);
  });

  it.each([false, true])('preserves native delivery while semantic review times out, report=%s', async report => {
    jest.useFakeTimers({now: 1_000});
    const target = fixture({report, deadlineMs: 901_000,
      dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const body = target.result.conclusion;
    const delivery = target.context.deliveryContext;
    if (delivery.entry !== 'runtime_draft') throw new Error('Expected the issued runtime draft fixture');
    const candidate = delivery.acceptedCandidate;
    const completion = delivery.completion;
    const pending = target.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].deadlineMs).toBe(901_000);
    await jest.advanceTimersByTimeAsync(900_000);
    const finalized = await pending;
    expect(finalized.semanticAssessment).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown',
      binding: {canonicalCandidate: candidate}});
    expect(finalized.result.conclusion).toBe(body);
    expect(target.result.conclusion).toBe(body);
    expect(finalized.result.completion).toEqual(completion);
    expect(finalized.result.success).toBe(true);
    expect(finalized.result.claimVerificationResult).toMatchObject({passed: false,
      claimResults: [{claimId: 'count', status: 'partial', deterministicProof: {status: 'proved'}}]});
    expect(finalized.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'coverage_incomplete'});
    expect(finalized.result.partial).not.toBe(true);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(() => target.context.runId).toThrow();
  });

  it.each([false, true])('keeps report gaps independent from a complete claim review, inconsistent=%s', async inconsistent => {
    // A rejection needs a body that actually disagrees with the declared 49.
    const target = fixture({report: true, inconsistent, ...(inconsistent ? {body: 'The captured value is 50.'} : {})});
    const finalized = await target.run();
    expect(finalized.semanticAssessment?.coverage).toEqual({body: 'complete', claims: 'complete', report: 'incomplete'});
    expect(finalized.result.deliveryAssurance?.report).toBe('coverage_incomplete');
    expect(finalized.result.deliveryAssurance?.claims).toBe(inconsistent ? 'failed' : 'passed');
    expect(finalized.result.claimVerificationResult?.claimResults[0].status).toBe(inconsistent ? 'unsupported' : 'verified');
  });

  it('keeps proved claims checked when the report reviewer miscopies a requirement claim reference', async () => {
    const body = 'The captured value is 49.';
    const location = {start: 0, end: body.length, text: body};
    const target = fixture({report: true, dispatch: async () => ({status: 'ok', text: JSON.stringify({
      schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
      claims: [{claimId: 'count', consistency: 'consistent', contentLocations: [location], issues: []}],
      omissions: [], requirements: [{requirementId: 'detail', applicability: 'applicable', coverage: 'covered',
        contentLocations: [location], claimIds: ['invented-claim']}]})})});
    const finalized = await target.run();
    expect(finalized.result.claimVerificationResult).toMatchObject({status: 'passed', passed: true, checkedClaimCount: 1,
      claimResults: [{status: 'verified', deterministicProof: {status: 'proved'}}]});
    expect(finalized.result.deliveryAssurance).toMatchObject({claims: 'passed', report: 'coverage_incomplete'});
    expect(finalized.result.partial).not.toBe(true);
    expect(finalized.semanticAssessment).toMatchObject({status: 'coverage_incomplete',
      responseDiagnostic: {stage: 'report_requirement', code: 'invalid_reference'}});
  });

  it('still reports an omitted claim when report coverage is incomplete', async () => {
    const target = fixture({report: true, omissions: true});
    const {result} = await target.run();
    // Unverified, not contradicted: the answer cannot pass, and the omission stays named.
    expect(result.claimVerificationResult).toMatchObject({status: 'partial', passed: false});
    expect(result.claimVerificationResult?.issues.map(issue => issue.code)).toContain('semantic_undeclared_claim');
  });

  it('retains source declarations for checking when no actual source ledger exists', async () => {
    const target = fixture();
    target.result.conclusionContract!.sourceClaimBindings = [{claimId: 'count',
      sourceReferenceIds: ['invented-source'], traceEvidenceRefIds: ['data:count']}];
    const {result} = await target.run();
    expect(result.sourceUseDecision).toBeUndefined();
    expect(result.sourceClaimVerificationResult).toMatchObject({status: 'partial', issues: [
      expect.objectContaining({code: 'source_claim_semantics_unchecked'}),
    ]});
    // Unchecked is delivered unverified (`~`), not failed.
    expect(result.deliveryAssurance?.source).toBe('coverage_incomplete');
  });

  it('uses a detached result when a caller changes the original during the semantic request', async () => {
    const target = fixture();
    const originalDispatch = target.dispatch.getMockImplementation()!;
    target.dispatch.mockImplementation(async request => {
      target.result.conclusion = 'A later run';
      target.result.conclusionContract!.claims![0].semantics!.numeric!.value = 999;
      return originalDispatch(request);
    });
    const {result} = await target.run();
    expect(result.conclusion).toBe('The captured value is 49.');
    expect(result.conclusionContract?.claims?.[0].semantics?.numeric?.value).toBe(49);
    expect(result.claimVerificationResult?.passed).toBe(true);
  });

  it('does not accept a self-consistent old comparison pair outside the runtime pin', async () => {
    const target = fixture();
    const resolution = (traceId: string, traceSide: 'current' | 'reference'): IdentityResolutionV1 => ({
      version: 'identity_contract@1' as const, identityRefId: `identity-${traceId}`, status: 'verified' as const,
      target: {traceId, traceSide, source: 'derived' as const},
      processes: [{upid: 1, pid: 1, processName: 'app', packageName: 'app', matchSources: [], confidence: 1}], threads: [], warnings: [],
    });
    const {result} = await finalizeAnalysisResult({result: target.result, context: target.context, owner: target.owner,
      query: 'Compare', comparisonIdentity: {currentTraceId: 'old-current', referenceTraceId: 'old-reference',
        currentResolution: resolution('old-current', 'current'), referenceResolution: resolution('old-reference', 'reference')}});
    expect(result.deliveryAssurance?.identity).not.toBe('passed');
    expect(result.partial).not.toBe(true);
  });

  it('rejects a mismatching proposition even when its reference value is correct', async () => {
    const target = fixture({body: 'The captured value is 50.', inconsistent: true});
    const {result} = await target.run();
    expect(result.conclusion).toBe(target.result.conclusion);
    expect(result.conclusionContract?.claims?.[0].references[0].value).toBe(49);
    expect(result.claimVerificationResult).toMatchObject({status: 'failed',
      claimResults: [{claimId: 'count', status: 'unsupported'}]});
    expect(result.deliveryAssurance?.claims).toBe('failed');
  });

  it('requires full semantics before an empty declaration set can represent a non-factual answer', async () => {
    const noFacts = fixture({body: 'Acknowledged.', claim: false, taskKind: 'acknowledgement'});
    expect((await noFacts.run()).result.claimVerificationResult?.passed).toBe(true);
    const omitted = fixture({claim: false, omissions: true, taskKind: 'acknowledgement'});
    expect((await omitted.run()).result.claimVerificationResult).toMatchObject({status: 'partial', passed: false});
    const unavailable = fixture({claim: false, taskKind: 'acknowledgement',
      dispatch: async () => ({status: 'unavailable', reason: 'provider_error'})});
    expect((await unavailable.run()).result.claimVerificationResult?.passed).toBe(false);
    // A factual turn with no declared claim never reaches ✓, so no review is sent.
    const factual = fixture({body: 'Acknowledged.', claim: false});
    expect((await factual.run()).result.claimVerificationResult).toMatchObject({status: 'partial', passed: false,
      notCheckedReason: 'not_required'});
    expect(factual.dispatch).not.toHaveBeenCalled();
  });

  it.each([1, 2])('does not convert %i invalid machine declarations into a verified empty claim set', async count => {
    const invalid = '<!-- smartperfetto:conclusion-contract@1\n```json\n{"mode":"broken"}\n```\n-->';
    const target = fixture({body: 'Visible answer\n' + Array(count).fill(invalid).join('\n'), claim: false});
    const finalized = await target.run();
    expect(finalized.result.claimVerificationResult?.passed).toBe(false);
    expect(finalized.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'invalid_declarations'});
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('does not call a provider after privacy projection makes the review input incomplete', async () => {
    const target = fixture();
    registerCodeAwareCanary(target.result.sessionId, 'What is the captured value?');
    const finalized = await target.run();
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(finalized.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete'});
    expect(finalized.result.claimVerificationResult?.passed).toBe(false);
  });

  it('allows the captured provider-query role while still suppressing the same query in output', async () => {
    const question = 'PRIVATE original provider question';
    const target = fixture({providerQuery: {text: question, analysisContextFingerprint: 'selection'}});
    target.owner.analysisContextFingerprint = 'selection';
    registerPrivateAnalysisQueryForEcho(target.result.sessionId, question);
    const {result} = await target.run();
    expect(result.claimVerificationResult?.passed).toBe(true);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].prompt).toContain(question);
    expect(sanitizeCodeAwareText(target.result.sessionId, question)).not.toBe(question);
    expect(JSON.stringify(result)).not.toContain(question);
  });

  it('sends the exact issued selection scope without treating it as captured evidence', async () => {
    const selection: AnalysisRunSelection = {present: true, kind: 'area', context: {kind: 'area', source: 'area_selection',
      startNs: 10, endNs: 20, tracks: [{uri: 'track://main', upid: 921}]},
    sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace'}};
    const target = fixture({selection});
    const final = await target.run();
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    const prompt = target.dispatch.mock.calls[0][0].prompt;
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2)).selectionScope).toEqual(selection);
    expect(JSON.stringify(final.result)).not.toContain('selectionScope');
  });

  it.each(['canary', 'credential'] as const)('fails closed when %s content appears inside selection metadata', async kind => {
    const marker = kind === 'canary' ? 'SELECTION_CANARY_NEVER_SEND' : 'api_key="selection-secret-value-123"';
    const selection: AnalysisRunSelection = {present: true, kind: 'track_event', context: {
      kind: 'track_event', eventId: 7, ts: 42, trackUri: `track://${marker}`},
    sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace'}};
    const target = fixture({selection});
    if (kind === 'canary') registerCodeAwareCanary(target.result.sessionId, marker);
    const final = await target.run();
    expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete'});
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('allows the owner query as analysis context without treating it as captured evidence', async () => {
    const question = 'PRIVATE original provider question';
    const target = fixture({providerQuery: {text: question}});
    target.result.conclusionContract!.claims![0].rawReferences = {privateValue: question};
    registerPrivateAnalysisQueryForEcho(target.result.sessionId, question);
    expect((await target.run()).result.claimVerificationResult?.passed).toBe(true);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
  });

  it('requires the original authorization selection for the captured query view', async () => {
    const target = fixture({providerQuery: {text: 'question', analysisContextFingerprint: 'old-selection'}});
    target.owner.analysisContextFingerprint = 'new-selection';
    await expect(target.run()).rejects.toThrow('finalization_authorization_fingerprint_mismatch');
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'authorization', 'superseded'] as const)('does not return a result after %s during semantic review', async reason => {
    const target = fixture();
    target.dispatch.mockImplementation(async () => {
      if (reason === 'cancel') target.controller.abort();
      if (reason === 'authorization') target.owner.assertAuthorized = () => {throw new Error('authorization changed');};
      if (reason === 'superseded') target.owner.isCurrent = () => false;
      return {status: 'unavailable', reason: 'provider_error'};
    });
    await expect(target.run()).rejects.toThrow();
    expect(() => target.context.hasSemanticTransport).toThrow();
  });

  it('cannot obtain current completion or intent from serialized result fields without a private context', async () => {
    const target = fixture();
    target.context.dispose();
    const {result} = await finalizeAnalysisResult({result: {...target.result,
      completion: {schemaVersion: 1, runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
        conclusionFingerprint: analysisDeliveryFingerprint(target.result.conclusion), runtimeKind: 'openai-agents-sdk', status: 'completed'}},
      owner: target.owner, query: 'value'});
    expect(result.deliveryAssurance?.completion).toBe('not_checked');
    expect(result.completion).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('checks the owner identity before invoking any finalization capability', async () => {
    const target = fixture();
    target.owner.runId = 'other-run';
    await expect(target.run()).rejects.toThrow('finalization_run_identity_mismatch');
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(() => target.context.runId).toThrow();
  });
});


describe('semantic finalization capacity', () => {
  it('reaches the existing single review with complete byte-bounded evidence above 10000 nodes', async () => {
    const target = fixture({capabilityRows: 3500});
    const final = await target.run();
    expect(final.semanticAssessment?.status).toBe('checked');
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    const prompt = target.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain(JSON.stringify(Array.from({length: 3500}, () => [0])));
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(128 * 1024);
  });
  it('retains the complete provider byte limit after structure projection', async () => {
    const target = fixture({capabilityRows: 5000, capabilityCell: 'x'.repeat(120)});
    const final = await target.run();
    expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit'});
    expect(target.dispatch).not.toHaveBeenCalled();
  });
  it('distinguishes structural capacity loss without treating incomplete input as complete', async () => {
    const target = fixture({capabilityRows: 170000});
    const final = await target.run();
    expect(final.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_limit'});
    expect(target.dispatch).not.toHaveBeenCalled();
  });
});

describe('case recommendations come only from the server retrieval', () => {
  const retrieved: CaseKnowledgeReportRecommendation = {caseId: 'scroll-shader-001', title: 'Shader compile on the first scroll',
    scene: 'scrolling', primaryRootCause: 'shader_compile', matchStrength: 'strong', evidenceRefs: ['data:count'],
    matchedSignatures: ['reason_code', 'render_slices'], missingRequiredSignatures: [],
    recommendations: {app: [{id: 'app.warm_shaders', priority: 'P0', action: 'Warm shaders before the first scroll.',
      applies_when: 'RenderThread compiles shaders inside janky frames', risks: 'More work before first frame'}], oem: []}};

  it('replaces what a native declaration carried with the retrieved hits', async () => {
    const run = fixture({currentRead: true, source: {marker: 'native-case-marker'}, runtimeCaseRecommendations: [
      {caseId: 'learned:0123456789abcdef', title: 'A learned case', matchStrength: 'strong', recommendations: {app: [], oem: []}},
      {caseId: 'model-case', title: 'A case the model named', matchStrength: 'strong', recommendations: {app: [], oem: []},
        learnedProvenance: {candidateId: 'casecand-run-1', supportingEvidence: 3, contradictingEvidence: 0, supported: true}},
    ]});
    // The native declaration is the runtime's own contract, recommendations included.
    expect(run.context.getNativeDeclaration(run.result, run.owner.signal)?.contract?.caseRecommendations).toHaveLength(2);

    const final = await run.run({caseRecommendations: [retrieved]});

    expect(final.result.conclusionContract?.caseRecommendations).toEqual([retrieved]);
    expectOwnerSurfacesStable(final.result);
  });

  it.each([false, true])('adds retrieved hits to a public result that owner and snapshot surfaces keep, native=%s', async native => {
    const final = await fixture({nativeProjection: native}).run({caseRecommendations: [retrieved]});
    expect(final.result.conclusionContract?.caseRecommendations).toEqual([retrieved]);
    expectOwnerSurfacesStable(final.result);
  });

  it.each([false, true])('projects hit text a private guard protects, so later surfaces leave it alone, native=%s', async native => {
    const canary = 'CASE_TEXT_CANARY_NEVER_SHOWN';
    const run = native ? fixture({currentRead: true, source: {marker: 'native-case-marker'}}) : fixture();
    registerCodeAwareCanary(run.result.sessionId, canary);
    const final = await run.run({caseRecommendations: [{...retrieved, title: `Shader compile ${canary}`}]});
    expect(final.result.conclusionContract?.caseRecommendations).toHaveLength(1);
    expect(JSON.stringify(final.result.conclusionContract)).not.toContain(canary);
    expectOwnerSurfacesStable(final.result);
  });

  it.each([
    ['a withheld match strength', 'password=background',
      [retrieved, {...retrieved, caseId: 'scroll-bg-002', matchStrength: 'background' as const}], [retrieved]],
    ['a withheld field name', 'password="matchStrength"', [retrieved], []],
    ['a withheld nested field name', 'password="applies_when"', [retrieved], [{...retrieved, recommendations: {app: [], oem: []}}]],
  ] as const)('drops what %s breaks, so owner surfaces keep every binding', async (_label, guard, hits, expected) => {
    for (const [options, valid] of [
      [{report: true}, {claims: 'passed'}],
      [{report: true, currentRead: true, source: {marker: 'native-case-marker'}}, {source: 'passed'}],
    ] as const) {
      // The query's credential value (8+ characters, quoted so its shape does not matter) is also a
      // value or field name a hit needs.
      const baselineRun = fixture(options);
      registerPrivateAnalysisQueryForEcho(baselineRun.result.sessionId, guard);
      const baseline = await baselineRun.run();
      const run = fixture(options);
      registerPrivateAnalysisQueryForEcho(run.result.sessionId, guard);
      const final = await run.run({caseRecommendations: [...hits]});

      expect(final.result.conclusionContract?.caseRecommendations ?? []).toEqual(expected);
      // The same bindings as without hits, and live ones, not two equally withdrawn results.
      expect(final.result.deliveryAssurance).toEqual(baseline.result.deliveryAssurance);
      expect(final.result.deliveryAssurance).toMatchObject({...valid, report: 'coverage_incomplete'});
      expect(final.result.reportAssessment).toBeDefined();
      expectOwnerSurfacesStable(final.result);
      clearAllCodeAwareOutputGuards();
    }
  });

  it.each([undefined, []])('delivers no recommendation without retrieved hits: %p', async caseRecommendations => {
    const run = fixture({runtimeCaseRecommendations: [retrieved]});
    const final = await run.run({caseRecommendations});
    expect(final.result.conclusionContract).toBeDefined();
    expect(final.result.conclusionContract).not.toHaveProperty('caseRecommendations');
  });

  it('adds no contract shell when the result has none', async () => {
    const final = await fixture({absentDeclaration: true}).run({caseRecommendations: [retrieved]});
    expect(final.result.conclusionContract?.caseRecommendations).toBeUndefined();
  });

  it('keeps retrieval out of the semantic review and the report assessment', async () => {
    const without = await fixture({report: true}).run();
    const run = fixture({report: true});
    const final = await run.run({caseRecommendations: [retrieved]});

    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.dispatch.mock.calls[0][0].prompt).not.toContain(retrieved.caseId);
    expect(final.result.conclusionContract?.caseRecommendations).toEqual([retrieved]);
    // Bound to the delivered contract, hits included, and otherwise what the run gets without them.
    expect(final.result.reportAssessment?.binding).not.toHaveProperty('caseRetrievalFingerprint');
    expect(final.result.reportAssessment?.binding.conclusionContractFingerprint)
      .toBe(analysisDeliveryFingerprint(final.result.conclusionContract));
    expect(final.result.deliveryAssurance).toEqual(without.result.deliveryAssurance);
  });
});
