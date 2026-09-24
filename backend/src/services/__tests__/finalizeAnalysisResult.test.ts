// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration, renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../../agentRuntime/intentTransport';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, type StrategyDefinition} from '../../agentv3/strategyLoader';
import * as strategyTemplates from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import type {EvidenceScopeProvenanceV1, IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {attachInvestigationEvidence} from '../evidence/investigationEvidenceLedger';
import type {EvidenceReadView} from '../evidence/evidenceReadView';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../finalizeAnalysisResult';
import {FINAL_SEMANTIC_INPUT_BYTE_LIMIT} from '../finalSemanticAssessment';
import {clearAllCodeAwareOutputGuards, registerCodeAwareCanary,
  registerPrivateAnalysisQueryForEcho, registerOnDemandSourceLookupForEcho, sanitizeCodeAwareText} from '../security/codeAwareOutputRegistry';
import {sanitizeSourceReference, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../codebase/sourceClaimVerifier';
import {canonicalizeAnalysisResult} from '../canonicalAnalysisResult';
import {claimVerificationStatusLine, summarizeClaimVerification} from '../analysisInvestigationPresentation';
import {finalReviewProgressUpdate, type FinalizationProgressEvent} from '../finalizationProgress';
import type {AnalysisRunSelection} from '../../agentRuntime/analysisRunSpec';
import {projectOwnerAnalysisResult, projectPrivateAnalysisResult} from '../security/privateAnalysisProjection';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'final-result-test'});

function fixture(options: {body?: string; capture?: boolean; claim?: boolean; inconsistent?: boolean;
  omissions?: boolean; report?: boolean; providerQuery?: {text: string; analysisContextFingerprint?: string};
  identity?: IdentityResolutionV1; scope?: EvidenceScopeProvenanceV1;
  deadlineMs?: number; capabilityRows?: number; capabilityCell?: string;
  source?: {marker: string; declaredMarker?: string; invalid?: boolean; hypothetical?: boolean;
    mechanismStatus?: 'compatible' | 'corroborated'; declareBindings?: boolean};
  selection?: AnalysisRunSelection;
  /** Emit the declaration as an invalid sidecar that still carries its claims. */
  invalidDeclaration?: boolean;
  currentRead?: boolean;
  runId?: string;
  wrongReferenceValue?: number;
  dispatch?: (input: IntentTransportInput) => Promise<IntentTransportResult>} = {}) {
  const runId = options.runId ?? 'run';
  const body = options.body ?? (options.source ? 'The captured name identifies the source marker.' : 'The captured value is 49.');
  const ref = {evidenceRefId: 'data:count', rowIndex: 0, column: options.source ? 'name' : 'count',
    value: options.source ? options.source.declaredMarker ?? options.source.marker : options.wrongReferenceValue ?? 49};
  const declared: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: options.claim === false ? [] : [{id: 'count', kind: options.source?.hypothetical ? 'inference' : options.source ? 'identity' : 'numeric', text: body, references: [ref],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: options.source ? 'identity.marker' : 'numeric.cell', polarity: 'affirmed',
        discourse: options.source?.hypothetical ? 'hypothetical' : 'asserted', quantifier: 'one',
        modality: options.source?.hypothetical ? 'possible' : 'certain',
        scope: {population: 'cited_rows', subjectRefs: [ref]},
        ...(options.source ? {} : {numeric: {operator: 'eq' as const, value: 49, unit: 'count'}})}}]};
  const result: AnalysisResult = {sessionId: 'final-result-test', conclusion: body, success: true,
    confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1,
    conclusionContract: parseConclusionContractDeclaration(declared).contract};
  const envelope = createDataEnvelope({columns: [ref.column], rows: [[options.source?.marker ?? 49]]}, {
    type: 'sql_result', source: 'execute_sql', title: 'Count', evidenceRefId: 'data:count',
    traceId: 'trace', traceSide: 'current', executionStatus: 'observed', identityResolution: options.identity,
    scopeProvenance: options.scope});
  const store = new ArtifactStore();
  if (options.capture !== false) store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    count: {unit: 'count', origin: {kind: 'native_producer', definitionFingerprint: 'count-v1'}},
  }), {meta: envelope.meta, display: envelope.display});
  let sourceUse: SourceUseDecisionV1 | undefined;
  if (options.source) {
    const reference = sanitizeSourceReference({referenceId: 'source-read', codebaseId: 'source-app',
      filePath: 'src/Probe.kt', lineRange: {start: 1, end: 1}, lookupKind: 'body'})!;
    sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['source-app'], status: 'corroborated', attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['source-app'], usedCodebaseIds: ['source-app'], coverageComplete: true, references: [reference]};
    if (options.source.declareBindings !== false) {
      declared.sourceClaimBindings = [{claimId: 'count', mechanismStatus: options.source.mechanismStatus ?? 'compatible',
        sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['data:count']}];
    }
    registerOnDemandSourceLookupForEcho(result.sessionId, [{...reference, referenceId: 'source-read',
      text: `Trace.beginSection("${options.source.marker}");\nTrace.endSection("${options.source.declaredMarker ?? options.source.marker}");`}]);
    result.conclusion = `${body}\n${options.source.invalid
      ? '<!-- smartperfetto:conclusion-contract@1\n```json\n' + JSON.stringify({...declared, verified: true}) + '\n```\n-->'
      : renderConclusionContractSidecar(declared)}`;
    delete result.conclusionContract;
  }
  if (options.invalidDeclaration && !options.source) {
    result.conclusion = `${body}\n` + '<!-- smartperfetto:conclusion-contract@1\n```json\n' +
      JSON.stringify({...declared, verified: true}) + '\n```\n-->';
    delete result.conclusionContract;
  }
  const candidate = {runId, attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const nativeDelivery = {entry: 'runtime_draft' as const, acceptedCandidate: candidate, outputOrigin: 'sdk_final' as const,
    completion: {...candidate, schemaVersion: 1 as const, runtimeKind: 'openai-agents-sdk' as const, status: 'completed' as const}};
  const projection = sourceUse ? finalizeOwnerSourceAwareAnalysisResultWithProjection(result,
    {getSourceUseDecision: () => sourceUse!}, {context: nativeDelivery}) : undefined;
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
      requirements: options.report ? [{requirementId: 'detail', applicability: 'applicable', coverage: 'unknown',
        contentLocations: [], claimIds: []}] : []})};
  }));
  const reportStrategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General analysis.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], requiredCapabilities: [],
    optionalCapabilities: [], phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'General analysis.',
    detailSections: [], sourcePath: '/fixture/general.strategy.md', finalReportContract: {requiredSections: [{
      id: 'detail', label: 'Detail', required: true, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }]}};
  const pinnedRegistry = options.report
    ? buildStrategyRegistrySnapshotFromDefinitions({definitions: [reportStrategy], overlayGeneration: 'report-test'}) : registry;
  attachFinalizationContext(result, {runId, sessionId: result.sessionId, deadlineMs: options.deadlineMs ?? Date.now() + 10_000,
    strategyRegistry: pinnedRegistry, traceIdentity: {currentTraceId: 'trace'},
    selection: options.selection,
    providerQuery: options.providerQuery,
    capabilityEvidence: options.capabilityRows ? [createDataEnvelope({columns: ['observed'],
      rows: Array.from({length: options.capabilityRows}, () => [options.capabilityCell ?? 0])},
      {type: 'sql_result', source: 'capability_fixture', title: 'Capabilities'})] : undefined,
    sourceUse, protocolProjection: projection?.protocolProjection,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: pinnedRegistry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: options.report ? 'scene_wide' : 'bounded_question', recommendedComplexity: 'quick',
      deliverable: options.report ? 'report' : 'answer', evidenceAccess: 'existing_only'},
    deliveryContext: projection?.deliveryContext ?? nativeDelivery,
    evidenceReadView: store.createEvidenceReadView({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: 'run',
      ...(options.currentRead ? {currentRunId: runId} : {})}),
    dispatchText: dispatch});
  const context = takeFinalizationContext(result)!;
  return {result, context, controller, owner, dispatch, envelope,
    run: () => finalizeAnalysisResult({result, context, owner, query: 'What is the captured value?', dataEnvelopes: [envelope]})};
}

afterEach(() => {clearAllCodeAwareOutputGuards(); jest.useRealTimers();});

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
      {phase: 'final_review', stage: 'started', deadlineAt: deadlineMs, message: '正在复核结论正文与其声明是否一致（最长约 2 分钟）'},
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
    const final = await fixture({currentRead: true, wrongReferenceValue: 99, inconsistent: true,
      body: 'The captured value is 50.'}).run();
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
        definitionFingerprint: 'producer-v1', selectedSqlHash: 'actual-sql', declaration: {
          window: {start: 'start', end: 'end'}, identity: {cpu: 'cpu'},
          metrics: valueColumns.map((column, index) => ({domain: 'cpu_frequency',
            metric_id: index === 0 ? 'system.cpu.frequency.time_weighted' : `system.cpu.frequency.sibling_${index}`,
            value: column, unit: 'kHz', status: 'status', aggregation: 'window_time_weighted'}))}});
      const envelope = createDataEnvelope(data, {type: 'skill_result', source: 'cpu_fixture', title: 'CPU',
        traceId: 'trace', traceSide: 'current', sourceToolCallId: 'system-call', evidenceRefId: 'data:system', executionStatus: 'observed'});
      store.registerStandaloneEvidenceCapture(witness, {meta: envelope.meta, display: envelope.display, originRunId});
    }
    const strategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General.', strategyKind: 'normal',
      priority: 1, effort: 'low', keywords: [], requiredCapabilities: [], optionalCapabilities: [],
      phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'General.', detailSections: [], sourcePath: '/fixture/general.strategy.md',
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
    attachFinalizationContext(result, {runId: 'run', sessionId: result.sessionId, deadlineMs: Date.now() + 10_000,
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
      run: () => finalizeAnalysisResult({result, context, owner, query: 'Describe the selected CPU window.', dataEnvelopes: [count]})};
  }

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
      schemaVersion: 'source_claim_verifier@1', status: 'not_checked', bindings: [], issues: [],
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
    'retains matched Trace membership for a candidate source connection without granting %s authority', async mechanismStatus => {
      const target = fixture({source: {marker: 'synthetic_source_marker_long_name', hypothetical: true, mechanismStatus},
        body: 'The captured marker might correspond to this source instrumentation.'});
      const final = await target.run();
      expect(final.result.claimVerificationResult).toMatchObject({status: 'passed', passed: true,
        claimResults: [{status: 'inference', referenceResults: [{status: 'matched'}]}]});
      expect(final.result.sourceClaimVerificationResult).toMatchObject({
        status: mechanismStatus === 'corroborated' ? 'partial' : 'passed', bindings: [{
        claimId: 'count', mechanismStatus: 'compatible', traceEvidenceRefIds: ['data:count'],
      }]});
      expect(final.result.sourceClaimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(false);
      if (mechanismStatus === 'corroborated') expect(final.result.sourceClaimVerificationResult?.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({code: 'source_binding_mechanism_unverified', severity: 'warning'})]),
      );
    });

  it('rejects mismatched Trace evidence even for a hypothetical source connection', async () => {
    const target = fixture({source: {marker: 'synthetic_source_marker_one_name',
      declaredMarker: 'synthetic_source_marker_two_name', hypothetical: true},
      body: 'The captured marker might correspond to this source instrumentation.'});
    const final = await target.run();
    expect(final.result.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'unsupported',
      referenceResults: [{status: 'value_mismatch'}]});
    expect(final.result.sourceClaimVerificationResult?.bindings).toEqual([]);
    expect(final.result.sourceClaimVerificationResult?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_trace_support_missing'}),
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

  it('records a numeric mismatch that only shows the declared value at display precision as a warning', async () => {
    const target = fixture({inconsistent: true});
    const final = await target.run();
    const verification = final.result.claimVerificationResult;
    expect(verification).toMatchObject({status: 'partial', passed: false, unsupportedClaimCount: 0,
      claimResults: [{status: 'partial'}]});
    expect(verification?.issues).toContainEqual(expect.objectContaining({claimId: 'count', severity: 'warning',
      code: 'semantic_numeric_display_rounding'}));
    expect(verification?.issues.some(issue => issue.severity === 'error')).toBe(false);
  });

  it.each([
    ['another issue on the same claim', [{code: 'numeric_mismatch', located: true}, {code: 'scope_mismatch', located: true}]],
    ['a mismatch whose location did not resolve', [{code: 'numeric_mismatch', located: false}]],
  ])('keeps a rounding-shaped mismatch a contradiction with %s', async (_label, reviewIssues) => {
    const body = 'The captured value is 49.';
    const location = {start: 0, end: body.length, text: body};
    const target = fixture({inconsistent: true, dispatch: async () => ({status: 'ok', text: JSON.stringify({
      schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
      claims: [{claimId: 'count', consistency: 'inconsistent', contentLocations: [location],
        issues: reviewIssues.map(issue => ({code: issue.code, contentLocations: issue.located ? [location] : [{start: 0, end: 3, text: 'bad'}]}))}],
      omissions: [], requirements: []})})});
    const final = await target.run();
    expect(final.result.claimVerificationResult).toMatchObject({status: 'failed', claimResults: [{status: 'unsupported'}]});
    expect(final.result.claimVerificationResult?.issues).toContainEqual(expect.objectContaining({
      claimId: 'count', severity: 'error'}));
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
    expect(finalized.result.partial === true).toBe(report);
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

  it('still reports an omitted claim when report coverage is incomplete', async () => {
    const target = fixture({report: true, omissions: true});
    const {result} = await target.run();
    // Unverified, not contradicted: the answer cannot pass, and the omission stays named.
    expect(result.claimVerificationResult).toMatchObject({status: 'partial', passed: false});
    expect(result.claimVerificationResult?.issues.map(issue => issue.code)).toContain('semantic_undeclared_claim');
  });

  it('retains source declarations for checking when no actual source ledger exists', async () => {
    const target = fixture();
    target.result.conclusionContract!.sourceClaimBindings = [{claimId: 'count', mechanismStatus: 'compatible',
      sourceReferenceIds: ['invented-source'], traceEvidenceRefIds: ['data:count']}];
    const {result} = await target.run();
    expect(result.sourceUseDecision).toBeUndefined();
    expect(result.sourceClaimVerificationResult).toMatchObject({status: 'partial', issues: [
      expect.objectContaining({code: 'source_claim_semantics_unchecked'}),
    ]});
    expect(result.partial).toBe(true);
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
    expect(result.partial).toBe(true);
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
    const noFacts = fixture({body: 'Acknowledged.', claim: false});
    expect((await noFacts.run()).result.claimVerificationResult?.passed).toBe(true);
    const omitted = fixture({claim: false, omissions: true});
    expect((await omitted.run()).result.claimVerificationResult).toMatchObject({status: 'partial', passed: false});
    const unavailable = fixture({claim: false, dispatch: async () => ({status: 'unavailable', reason: 'provider_error'})});
    expect((await unavailable.run()).result.claimVerificationResult?.passed).toBe(false);
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
