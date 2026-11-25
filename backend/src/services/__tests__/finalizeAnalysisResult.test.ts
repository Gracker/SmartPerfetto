// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {
  attachFinalizationContext,
  attachRunDeliveryRecord,
  takeFinalizationContext,
} from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, type StrategyDefinition} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import type {CaseKnowledgeReportRecommendation} from '../../types/caseKnowledge';
import {createDataEnvelope} from '../../types/dataContract';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../finalizeAnalysisResult';
import {clearAllCodeAwareOutputGuards, registerCodeAwareCanary} from '../security/codeAwareOutputRegistry';
import {sanitizeSourceReference, type SourceExecutionScopeV1, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';
import type {KnowledgeUseRecord} from '../knowledge/knowledgeUse';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../codebase/sourceClaimVerifier';
import {deriveDeliveryVerdict, investigationStatusLines} from '../analysisInvestigationPresentation';
import {createRunManifestLifecycle, withRunManifestLifecycle, clearRunManifestLifecyclesForTests} from '../selfEvolution/runManifestLifecycle';
import {copyAnalysisResultForSnapshot, projectOwnerAnalysisResult, projectPrivateAnalysisResult} from '../security/privateAnalysisProjection';
import {buildAnalysisReceipt} from '../analysisReceiptBuilder';
import {recordRuntimeFinalTransportEvent} from '../../agentRuntime/runtimePerformance';
import {HTMLReportGenerator} from '../htmlReportGenerator';
import {applyFinalResultQualityGate} from '../finalResultQualityGate';
import {copyAnalysisDeliveryFields} from '../security/analysisDeliveryProjection';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../traceProcessorConnectionModel';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'final-result-test'});
const DEFAULT_BODY = 'The captured frame count is 49.';

/**
 * The Perfetto UI's notice rule (sse_event_handlers.ts), replicated so a
 * backend change that would raise "verification incomplete" fails here.
 */
function uiRaisesVerificationNotice(result: Pick<AnalysisResult, 'deliveryAssurance' | 'sourceClaimVerificationResult'>): boolean {
  const assurance = result.deliveryAssurance as unknown as Record<string, unknown> | undefined;
  const axisNotice = Boolean(assurance && assurance.schemaVersion === 1 &&
    ['claims', 'source', 'identity', 'report', 'investigation', 'investigationEvidence']
      .some(key => typeof assurance[key] === 'string' && !['passed', 'not_applicable'].includes(assurance[key] as string)));
  const verifier = result.sourceClaimVerificationResult as unknown as Record<string, unknown> | undefined;
  const sourceNotice = Boolean(verifier && (verifier.schemaVersion === 'source_claim_verifier@1' ||
    verifier.schemaVersion === 'source_claim_verifier@2') && verifier.status !== 'passed');
  return axisNotice || sourceNotice;
}

/** Claim-verdict wording the report shows only for a stored result that carries claim records. */
const CLAIM_VERDICT_TEXT = ['Claim verification', '断言核验', 'Verified Claims', '已核验断言',
  'Verification unavailable', '核验信息不可用'];

function renderReport(result: AnalysisResult, outputLanguage: 'en' | 'zh-CN'): string {
  return new HTMLReportGenerator().generateAgentDrivenHTML({traceId: 'trace', query: 'q', timestamp: 1714600000000,
    hypotheses: [], dialogue: [], result, outputLanguage});
}

const RETIRED_AXES = {claims: 'not_applicable', report: 'not_applicable', investigation: 'not_applicable',
  investigationEvidence: 'not_applicable'} as const;

type SourceMode = 'none' | 'access_no_ledger' | 'ledger';

function fixture(options: {
  body?: string;
  /** Append a stray model declaration sidecar to the body (the prompt no longer asks for one). */
  straySidecar?: boolean;
  /** Issue the runtime's protocol projection (a native declaration). */
  nativeProjection?: boolean;
  source?: SourceMode;
  report?: boolean;
  investigation?: boolean;
  knowledgeUse?: KnowledgeUseRecord;
  scrolling?: (store: ArtifactStore) => void;
  intentUnavailable?: boolean;
  nativeCompletion?: {status: 'incomplete'; reason: 'output_limit'};
} = {}) {
  const runId = 'run';
  const body = options.body ?? DEFAULT_BODY;
  const declared: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: [{id: 'count', kind: 'numeric', text: body, references: [{evidenceRefId: 'data:count', rowIndex: 0,
      column: 'count', value: 49}]}]};
  const result: AnalysisResult = {sessionId: 'final-result-test', success: true, confidence: 0.8, findings: [],
    hypotheses: [], rounds: 1, totalDurationMs: 1,
    conclusion: options.straySidecar ? `${body}\n${renderConclusionContractSidecar(declared)}` : body};
  const envelope = createDataEnvelope({columns: ['count'], rows: [[49]]}, {type: 'sql_result', source: 'execute_sql',
    title: 'Count', evidenceRefId: 'data:count', traceId: 'trace', traceSide: 'current', executionStatus: 'observed'});
  const reference = sanitizeSourceReference({referenceId: 'source-read', codebaseId: 'source-app',
    filePath: 'src/Probe.kt', lineRange: {start: 1, end: 3}, lookupKind: 'body'})!;
  const sourceUse: SourceUseDecisionV1 | undefined = options.source === 'ledger' ? {schemaVersion: 'source_use_decision@1',
    codeAwareMode: 'provider_send', selectedCodebaseIds: ['source-app'], status: 'corroborated',
    attemptedTools: ['read_codebase_file'], queriedCodebaseIds: ['source-app'], usedCodebaseIds: ['source-app'],
    coverageComplete: true, references: [reference]} : undefined;
  const sourceScope: SourceExecutionScopeV1 = options.source && options.source !== 'none'
    ? {codeAwareMode: 'provider_send', selectedCodebaseIds: ['source-app'], hasCodebaseAccess: true,
      analysisContextFingerprint: 'source-auth'}
    : {codeAwareMode: 'off', selectedCodebaseIds: [], hasCodebaseAccess: false, analysisContextFingerprint: 'source-auth'};
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const nativeDelivery = {entry: 'runtime_draft' as const, acceptedCandidate: candidate, outputOrigin: 'sdk_final' as const,
    completion: {...candidate, schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const,
      ...(options.nativeCompletion ?? {status: 'completed' as const})}};
  const projection = options.nativeProjection || options.straySidecar
    ? finalizeOwnerSourceAwareAnalysisResultWithProjection(result, undefined, {context: nativeDelivery}) : undefined;
  const strategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General analysis.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], requiredCapabilities: [],
    optionalCapabilities: [], verifierMisdiagnosisPatterns: [], content: 'General analysis.',
    detailSections: [], sourcePath: '/fixture/general.strategy.md', finalReportContract: {requiredSections: [{
      id: 'detail', label: 'Detail', required: true, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }]},
    ...(options.scrolling ? {entrySkill: {id: 'scrolling_analysis', params: {}}} : {}),
    ...(options.investigation ? {investigationContract: {schemaVersion: 1 as const, profileRefs: [], requirements: [{
      id: 'thread_state', domain: 'thread_state', description: 'Thread state', required: true,
      evidenceMetrics: ['system.thread.state.duration']}]}} : {})} as StrategyDefinition;
  const pinnedRegistry = options.report || options.investigation || options.scrolling
    ? buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'report-test'}) : registry;
  const store = new ArtifactStore();
  options.scrolling?.(store);
  const owner: AnalysisFinalizationOwner = {runId, signal: new AbortController().signal,
    isCurrent: () => true, assertAuthorized: () => {}};
  attachFinalizationContext(result, {runId, sessionId: result.sessionId, deadlineMs: Date.now() + 600_000,
    strategyRegistry: pinnedRegistry, traceIdentity: {currentTraceId: 'trace'},
    turnIntent: {schemaVersion: 1, status: options.intentUnavailable ? 'unavailable' : 'resolved',
      source: options.intentUnavailable ? 'fallback' : 'semantic', registryFingerprint: pinnedRegistry.registryFingerprint,
      taskKind: options.investigation || options.scrolling ? 'investigation' : 'fact', sceneId: 'general',
      scope: options.report || options.investigation ? 'scene_wide' : 'bounded_question', recommendedComplexity: 'quick',
      deliverable: options.report ? 'report' : 'answer', evidenceAccess: options.scrolling ? 'read_new' : 'existing_only'},
    deliveryContext: projection?.deliveryContext ?? nativeDelivery,
    ...(sourceUse ? {sourceUse} : {}), sourceScope,
    ...(options.knowledgeUse ? {knowledgeUse: options.knowledgeUse} : {}),
    evidenceReadView: store.createEvidenceReadView({allowedTraces: [{traceId: 'trace', traceSide: 'current'}],
      ownerKey: 'run', ...(options.scrolling ? {currentRunId: runId} : {})})});
  const context = takeFinalizationContext(result)!;
  return {result, context, owner, envelope,
    run: (extra: {caseRecommendations?: CaseKnowledgeReportRecommendation[]} = {}) => finalizeAnalysisResult({result, context, owner,
      query: 'How many frames?', dataEnvelopes: [envelope], ...extra})};
}

afterEach(() => {clearAllCodeAwareOutputGuards(); clearRunManifestLifecyclesForTests(); jest.useRealTimers();});

describe('new finalization without model-authored declarations', () => {
  it('delivers a plain answer with retired axes not_applicable, no claim verdict and no notice', async () => {
    const final = await fixture().run();
    expect(final.qualityIssue).toBeUndefined();
    expect(final.result.deliveryAssurance).toMatchObject({entry: 'new_finalization',
      completion: 'passed', identity: 'not_applicable', source: 'not_applicable', ...RETIRED_AXES});
    expect(final.result).not.toHaveProperty('claimVerificationResult');
    expect(final.result).not.toHaveProperty('claimSupport');
    expect(final.result).not.toHaveProperty('sourceClaimVerificationResult');
    expect(final.result).not.toHaveProperty('reportAssessment');
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
    // The CLI prints the success marker and no investigation lines for it.
    expect(deriveDeliveryVerdict(final.result)).toBe('completed');
    expect(investigationStatusLines(final.result.deliveryAssurance, 'en')).toEqual([]);
    // The analysis receipt reports the retired gates as not applicable, not partial.
    const receipt = buildAnalysisReceipt({runManifestId: 'manifest-plain',
      session: {sessionId: final.result.sessionId, traceId: 'trace', dataEnvelopes: []}, result: final.result});
    expect(receipt.qualityGates).toMatchObject({claimVerification: 'not_applicable', finalReportContract: 'not_applicable'});
    // The HTML report shows no claim-verification line or verified-claim count for it.
    for (const language of ['en', 'zh-CN'] as const) {
      const html = renderReport(final.result, language);
      for (const text of CLAIM_VERDICT_TEXT) expect(html).not.toContain(text);
    }
  });

  it.each([{report: true}, {investigation: true}])('keeps a %j deliverable free of coverage notices', async options => {
    const final = await fixture(options).run();
    expect(final.result.deliveryAssurance).toMatchObject(RETIRED_AXES);
    expect(final.result).not.toHaveProperty('reportAssessment');
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
    expect(deriveDeliveryVerdict(final.result)).toBe('completed');
  });

  it('strips a stray declaration from the body and stores no declared claims or claim verdict', async () => {
    const final = await fixture({straySidecar: true}).run();
    expect(final.result.conclusion).not.toContain('smartperfetto:conclusion-contract');
    expect(final.result.conclusion).toContain(DEFAULT_BODY);
    expect(final.result.conclusionContract?.claims).toBeUndefined();
    expect(final.result.conclusionContract?.relationProposals).toBeUndefined();
    expect(final.result.conclusionContract?.bindingEligibility).toBeUndefined();
    expect(final.result).not.toHaveProperty('claimVerificationResult');
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed', ...RETIRED_AXES});
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
    expect(deriveDeliveryVerdict(final.result)).toBe('completed');
  });

  it('records no retired declaration or final review in the run performance receipt', async () => {
    const target = fixture();
    const lifecycle = createRunManifestLifecycle({runId: 'run', sessionId: target.result.sessionId,
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []}});
    await withRunManifestLifecycle(lifecycle, () => target.run());
    const receipt = lifecycle.builder.runtimePerformanceRecorder.seal();
    expect(receipt).not.toHaveProperty('finalReview');
    expect(receipt).not.toHaveProperty('declaration');
  });

  it('keeps native completion failures as the only delivery verdict', async () => {
    const run = fixture({nativeCompletion: {status: 'incomplete', reason: 'output_limit'}});
    run.result.partial = true;
    const final = await run.run();
    expect(final.qualityIssue?.code).toBe('sdk_incomplete');
    expect(final.result).toMatchObject({partial: true, terminationReason: 'quality_gate_failed'});
    expect(final.result.confidence).toBeLessThanOrEqual(0.55);
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'failed', ...RETIRED_AXES});
  });

  it('checks the owner identity before invoking any finalization capability', async () => {
    const target = fixture();
    await expect(finalizeAnalysisResult({result: target.result, context: target.context, query: 'q',
      owner: {...target.owner, isCurrent: () => false}})).rejects.toThrow('no longer current');
  });
});

describe('source citations as a quality annotation', () => {
  it('omits the source result without source access, even for public stack frames in an ANR answer', async () => {
    const body = 'ANR: main thread blocked at com.example.Foo.run(Foo.java:123) waiting on Bar.java:45.';
    const final = await fixture({body, source: 'none'}).run();
    expect(final.result).not.toHaveProperty('sourceClaimVerificationResult');
    expect(final.result.deliveryAssurance?.source).toBe('not_applicable');
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
    expect(deriveDeliveryVerdict(final.result)).toBe('completed');
  });

  it('omits the source result when a code-aware run writes no citation', async () => {
    const final = await fixture({source: 'ledger'}).run();
    expect(final.result.sourceUseDecision?.references).toHaveLength(1);
    expect(final.result).not.toHaveProperty('sourceClaimVerificationResult');
    expect(final.result.deliveryAssurance?.source).toBe('not_applicable');
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
  });

  it('passes a citation the run returned', async () => {
    const final = await fixture({source: 'ledger', body: `${DEFAULT_BODY} The marker is set at src/Probe.kt:L2.`}).run();
    expect(final.result.sourceClaimVerificationResult).toMatchObject({schemaVersion: 'source_claim_verifier@2',
      status: 'passed', claims: [], bindings: [], citations: [expect.objectContaining({filePath: 'src/Probe.kt'})]});
    expect(final.result.deliveryAssurance?.source).toBe('passed');
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
  });

  it('records an unmatched citation with access as advisory coverage_incomplete, not a failure', async () => {
    const final = await fixture({source: 'ledger', body: `${DEFAULT_BODY} See src/Other.kt:L5.`}).run();
    expect(final.result.sourceClaimVerificationResult).toMatchObject({status: 'partial',
      issues: [expect.objectContaining({severity: 'warning', code: 'source_citation_unmatched'})]});
    expect(final.result.deliveryAssurance?.source).toBe('coverage_incomplete');
    expect(final.qualityIssue).toBeUndefined();
    expect(final.result.success).toBe(true);
    expect(final.result.partial).toBeUndefined();
  });

  it('treats a citation under access without a recorded ledger as unchecked coverage, not a failure', async () => {
    const final = await fixture({source: 'access_no_ledger', body: `${DEFAULT_BODY} See src/Probe.kt:L2.`}).run();
    expect(final.result.sourceClaimVerificationResult?.status).toBe('partial');
    expect(final.result.deliveryAssurance?.source).toBe('coverage_incomplete');
    expect(final.qualityIssue).toBeUndefined();
  });
});

describe('case recommendations come only from the server retrieval', () => {
  const retrieved: CaseKnowledgeReportRecommendation = {caseId: 'scroll-shader-001', title: 'Shader compile on the first scroll',
    scene: 'scrolling', primaryRootCause: 'shader_compile', matchStrength: 'strong', evidenceRefs: ['data:count'],
    matchedSignatures: ['reason_code', 'render_slices'], missingRequiredSignatures: [],
    recommendations: {app: [{id: 'app.warm_shaders', priority: 'P0', action: 'Warm shaders before the first scroll.',
      applies_when: 'RenderThread compiles shaders inside janky frames', risks: 'More work before first frame'}], oem: []}};

  it.each([false, true])('attaches retrieved hits without any model declaration, native=%s', async native => {
    const final = await fixture({nativeProjection: native}).run({caseRecommendations: [retrieved]});
    expect(final.result.conclusionContract?.caseRecommendations).toEqual([retrieved]);
    expect(final.result.conclusionContract?.claims).toBeUndefined();
    expect(uiRaisesVerificationNotice(final.result)).toBe(false);
    expectOwnerSurfacesStable(final.result);
  });

  it('replaces what a stray declaration carried with the retrieved hits', async () => {
    const final = await fixture({straySidecar: true}).run({caseRecommendations: [retrieved]});
    expect(final.result.conclusionContract?.caseRecommendations).toEqual([retrieved]);
    expectOwnerSurfacesStable(final.result);
  });

  it('projects hit text a private guard protects, so later surfaces leave it alone', async () => {
    const canary = 'CASE_TEXT_CANARY_NEVER_SHOWN';
    const run = fixture();
    registerCodeAwareCanary(run.result.sessionId, canary);
    const final = await run.run({caseRecommendations: [{...retrieved, title: `Shader compile ${canary}`}]});
    expect(final.result.conclusionContract?.caseRecommendations).toHaveLength(1);
    expect(JSON.stringify(final.result.conclusionContract)).not.toContain(canary);
    expectOwnerSurfacesStable(final.result);
  });

  it.each([undefined, []])('adds no recommendation without retrieved hits: %p', async caseRecommendations => {
    const final = await fixture().run({caseRecommendations});
    expect(final.result.conclusionContract?.caseRecommendations).toBeUndefined();
  });
});

describe('record-only investigation ledger', () => {
  it('does not alter completion, body or termination because of the investigation ledger', async () => {
    const run = fixture({investigation: true});
    const body = run.result.conclusion;
    const final = await run.run();
    expect(final.qualityIssue).toBeUndefined();
    expect(final.result).toMatchObject({conclusion: body, success: true});
    expect(final.result.terminationReason).toBeUndefined();
    expect(final.result.partial).toBeUndefined();
    expect(final.result.deliveryAssurance).toMatchObject({completion: 'passed',
      investigation: 'not_applicable', investigationEvidence: 'not_applicable'});
    const assessment = final.result.investigationAssessment;
    expect(assessment?.requirements).toEqual([]);
    expect(assessment?.ledgerAcquisition?.[0]).toMatchObject({requirementId: 'thread_state', domain: 'thread_state'});
  });
});

describe('finalizer transport observation', () => {
  it('keeps a retained runtime event and records no finalizer selection', async () => {
    const target = fixture({nativeProjection: true});
    const lifecycle = createRunManifestLifecycle({runId: 'run', sessionId: target.result.sessionId,
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}, runtime: 'openai-agents-sdk', outputLanguage: 'en',
      analysisMode: 'fast', skillRegistry: {registryFingerprint: 'registry', evolutionOverlayGeneration: 'builtin', skills: []}});
    const recorder = lifecycle.builder.runtimePerformanceRecorder;
    const retainedKey = recordRuntimeFinalTransportEvent({identity: lifecycle.identity, runtimePerformanceRecorder: recorder}, {
      kind: 'candidate_retained', nativeCandidateKey: 'a'.repeat(64), carrier: 'assistant_text',
      transform: 'native', authors: [], declaredBody: 'present', declaredClaims: 'unknown', productStatus: 'completed',
    });
    expect(retainedKey).toMatch(/^[a-f0-9]{64}$/);
    const final = await withRunManifestLifecycle(lifecycle, () => target.run());
    expect(final.result.conclusion).toBe(DEFAULT_BODY);
    expect(final.result.completion?.status).toBe('completed');
    const events = recorder.seal().finalTransportObservation?.events ?? [];
    expect(events.map(event => event.kind)).toEqual(['candidate_retained']);
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

  it('grades the final body\'s knowledge citations without touching delivery', async () => {
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
    expect(buildAnalysisReceipt({runManifestId: 'manifest-failed-knowledge',
      session: {sessionId: finalized.sessionId, traceId: 'trace', dataEnvelopes: []}, result: finalized})
      .nonEvidenceContext.knowledgeReferenceCount).toBe(1);
    expect(copyAnalysisResultForSnapshot(finalized).knowledgeUse).toEqual(finalized.knowledgeUse);
    expect(projectOwnerAnalysisResult(finalized.sessionId, finalized, 'en').knowledgeUse).toEqual(finalized.knowledgeUse);
    expect(projectPrivateAnalysisResult(finalized.sessionId, finalized, 'en').knowledgeUse)
      .toEqual({schemaVersion: 'knowledge_use@1', sources: record.sources, citations: []});
    expect((await finalizeAnalysisResult({result: failed(), owner, query: 'q'})).result).not.toHaveProperty('knowledgeUse');
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

describe('owner and non-owner projections of a new finalization', () => {
  it('keeps the retired axes not_applicable when a non-owner projection changes the body', async () => {
    const final = await fixture({body: `${DEFAULT_BODY} PRIVATE_PROJECTION_CANARY`}).run();
    registerCodeAwareCanary(final.result.sessionId, 'PRIVATE_PROJECTION_CANARY');
    const privateView = projectPrivateAnalysisResult(final.result.sessionId, final.result, 'en');
    expect(privateView.conclusion).not.toContain('PRIVATE_PROJECTION_CANARY');
    expect(privateView.deliveryAssurance).toMatchObject({source: 'not_applicable', ...RETIRED_AXES});
    expect(uiRaisesVerificationNotice(privateView)).toBe(false);
    expect(projectOwnerAnalysisResult(final.result.sessionId, final.result, 'en').deliveryAssurance)
      .toMatchObject(RETIRED_AXES);
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
    expect(projected.investigationAssessment).toEqual(result.investigationAssessment);
    expect(projected.deliveryAssurance).toEqual(result.deliveryAssurance);
  };
  const ownerAgain = projectOwnerAnalysisResult(result.sessionId, result, 'en');
  stable(ownerAgain);
  const readBack = JSON.parse(JSON.stringify(ownerAgain)) as AnalysisResult;
  stable(projectOwnerAnalysisResult(readBack.sessionId, readBack, 'en'));
  stable(copyAnalysisResultForSnapshot(result));
}

describe('historical restore of a stored result', () => {
  function storedResult(): AnalysisResult {
    return {sessionId: 'stored-session', success: true, findings: [], hypotheses: [], conclusion: 'Stored answer.',
      confidence: 0.6, rounds: 1, totalDurationMs: 1,
      conclusionContract: {schemaVersion: 'conclusion_contract_v1', claims: [
        {id: 'c1', text: 'Stored first claim', references: []}, {id: 'c2', text: 'Stored second claim', references: []}]},
      claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'partial', policy: 'record_only', passed: false,
        checkedClaimCount: 2, unsupportedClaimCount: 0,
        claimResults: [{claimId: 'c1', status: 'verified'}, {claimId: 'c2', status: 'partial'}], issues: []},
      deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'coverage_incomplete',
        source: 'not_applicable', identity: 'not_applicable', report: 'not_checked', investigation: 'failed',
        investigationEvidence: 'not_checked'},
    } as unknown as AnalysisResult;
  }

  it('keeps the stored verdicts, assurance and report presentation unchanged', () => {
    const stored = storedResult();
    const before = structuredClone(stored);
    expect(applyFinalResultQualityGate({result: stored, query: 'q', context: {entry: 'historical_restore'}})).toBeUndefined();
    expect(stored).toEqual(before);
    expect(copyAnalysisDeliveryFields(stored).deliveryAssurance).toEqual(before.deliveryAssurance);
    // Old verdicts keep their old presentation: the notice, the CLI marker and the report's claim records.
    expect(uiRaisesVerificationNotice(stored)).toBe(true);
    expect(deriveDeliveryVerdict(stored)).toBe('unverified');
    const html = renderReport(stored, 'en');
    expect(html).toContain('Verified Claims');
    expect(html).toContain('1/2');
    expect(html).toContain('Stored second claim');
  });
});

function captureScrollingRows(store: ArtifactStore, stepId: string,
  rows: Array<Record<string, string | number | null>>, options: {runId?: string; traceId?: string} = {}): string {
  const columns = Object.keys(rows[0]);
  const data = {columns, rows: rows.map(row => columns.map(column => row[column]))};
  const traceId = options.traceId ?? 'trace';
  const artifactId = store.store({skillId: 'scrolling_analysis', stepId, layer: 'overview',
    title: stepId, data, traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'})});
  const evidenceRefId = `evidence-${artifactId}`;
  store.registerEvidenceCapture(artifactId, captureEvidenceTable(data, {}), {
    evidenceRefId, originRunId: options.runId ?? 'run',
  });
  return evidenceRefId;
}

const scrollingFrameRow = {
  upid: 17, process_name: 'example.scroller', layer_name: 'Main', primary_layer: 1,
  presentation_status: 'measured', smoothness_rating: 'fair', start_ts: '100', end_ts: '200',
  layer_frames: 1232, layer_tagged_frames: 0, layer_hybrid_frames: 0,
  layer_present_gap_count: 1231, layer_over_budget_gaps: 66, cadence_gap_count: 1231,
  cadence_gaps_over_1_5x_budget: 66, cadence_gap_max_ns: 28_550_000, budget_status: 'measured',
};

describe('product-owned scrolling conclusion', () => {
  it('publishes captured scrolling measurements when semantic intent was unavailable', async () => {
    const {run} = fixture({intentUnavailable: true, scrolling(store) {
      captureScrollingRows(store, 'smoothness_basis', [scrollingFrameRow]);
    }});
    const {result} = await run();
    expect(result.conclusionEvidence?.markdown).toContain('66/1231 (5.36%)');
  });

  it('ignores an asserted measurement summary from the runtime result', async () => {
    const {result: nativeResult, run} = fixture();
    nativeResult.conclusionEvidence = {
      schemaVersion: 'scrolling_conclusion@1', markdown: 'Forged measurement', evidenceRefIds: ['unissued'],
    };
    const {result} = await run();
    expect(result.conclusionEvidence).toBeUndefined();
    expect(copyAnalysisDeliveryFields(result).conclusionEvidence).toBeUndefined();
  });

  it('publishes same-layer rates including both zero measurements and keeps the canonical body and its binding', async () => {
    let evidenceRefId = '';
    const {run} = fixture({body: 'Native analysis of the producer pipeline.', scrolling(store) {
      evidenceRefId = captureScrollingRows(store, 'smoothness_basis', [
        scrollingFrameRow,
        {...scrollingFrameRow, start_ts: '300', end_ts: '420'},
        {...scrollingFrameRow, layer_name: 'secondary', primary_layer: 0, layer_tagged_frames: 55},
        {...scrollingFrameRow, layer_name: 'secondary-proxy', primary_layer: 0, presentation_status: 'unmeasured'},
      ]);
      captureScrollingRows(store, 'smoothness_basis', [
        {...scrollingFrameRow, layer_name: 'historical'},
      ], {runId: 'earlier-run'});
      captureScrollingRows(store, 'smoothness_basis', [
        {...scrollingFrameRow, layer_name: 'other-trace'},
      ], {traceId: 'other'});
    }});
    const {result} = await run();
    expect(result.conclusion).toBe('Native analysis of the producer pipeline.');
    expect(result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    const measurement = result.conclusionEvidence!;
    expect(measurement.evidenceRefIds).toEqual([evidenceRefId]);
    expect(measurement.markdown).toContain('66/1231 (5.36%)');
    expect(measurement.markdown.match(/0\/1232 \(0\.00%\)/g)).toHaveLength(2);
    expect(measurement.markdown).toContain('100–420 ns');
    expect(measurement.markdown).not.toMatch(/secondary|historical|other-trace/);
    expect(copyAnalysisDeliveryFields(result).conclusionEvidence).toEqual(measurement);
    const report = renderReport(result, 'zh-CN');
    expect(report.indexOf('66/1231 (5.36%)')).toBeGreaterThan(-1);
    expect(report.indexOf('66/1231 (5.36%)')).toBeLessThan(report.indexOf(result.conclusion));
  });

  it('keeps unavailable presentation and unknown Flutter touch state separate from causal analysis', async () => {
    const {run} = fixture({scrolling(store) {
      captureScrollingRows(store, 'smoothness_basis', [{
        ...scrollingFrameRow, layer_name: null, primary_layer: null, presentation_status: 'unmeasured',
        smoothness_rating: 'unrated', layer_frames: null, layer_tagged_frames: null, layer_hybrid_frames: null,
        layer_present_gap_count: null, layer_over_budget_gaps: null, cadence_gap_count: 1658,
        cadence_gaps_over_1_5x_budget: 71, cadence_gap_max_ns: null,
      }]);
      captureScrollingRows(store, 'flutter_swap_touch_gaps', [{
        upid: 17, utid: 31, process_name: 'example.scroller',
        swap_count: 1584, complete_contacts: 12, gap_class: 'between_contacts_or_next_touch_onset', max_gap_ns: 266_844_800,
        touch_over_budget_gaps: 19, between_contact_gaps: 22, unresolved_touch_gaps: 2,
        longest_touch_gap_ns: 18_497_920, longest_unresolved_gap_ns: 249_350_400,
      }]);
    }});
    const {result} = await run();
    const markdown = result.conclusionEvidence?.markdown ?? '';
    expect(markdown).toContain('无法评级');
    expect(markdown.match(/不可用/g)).toHaveLength(3);
    expect(markdown).toContain('71/1658 (4.28%)');
    expect(markdown).toContain('手势之间或下一手势起始 22 · 最长 266.84 ms');
    expect(markdown).toContain('触摸状态未知，未计入触摸内卡顿 2 · 最长 249.35 ms');
  });
});
