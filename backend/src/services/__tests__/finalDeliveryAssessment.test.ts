// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {CONCLUSION_CONTRACT_SIDECAR_MARKER, parseConclusionContractDeclaration, type ConclusionContract} from '../../agent/core/conclusionContract';
import type {AnalysisTurnIntent} from '../../agentRuntime/analysisTurnIntent';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, type StrategyDefinition} from '../../agentv3/strategyLoader';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {
  analysisDeliveryFingerprint,
  type AnalysisDeliveryContext,
} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import {applyFinalResultQualityGate, assessFinalResultQualityAssessment} from '../finalResultQualityGate';
import * as qualityGate from '../finalResultQualityGate';
import {sanitizeSourceReference, type SourceExecutionScopeV1, type SourceUseDecisionV1} from '../codebase/sourceUseDecision';

type FinalContext = Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}>;

function intent(overrides: Partial<AnalysisTurnIntent> = {}): AnalysisTurnIntent {
  return {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-v1',
    taskKind: 'fact', sceneId: 'startup', scope: 'bounded_question', recommendedComplexity: 'quick',
    deliverable: 'answer', evidenceAccess: 'read_new', ...overrides};
}

function result(conclusion = 'A concise answer'): AnalysisResult {
  return {sessionId: 'session-a', success: true, findings: [], hypotheses: [], conclusion,
    confidence: 0.8, rounds: 1, totalDurationMs: 10};
}

function contract(claims: NonNullable<ConclusionContract['claims']> = []): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
    clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims};
}

function current(target: AnalysisResult): FinalContext {
  const acceptedCandidate = {candidateRef: 'candidate-a', runId: 'run-a', attemptId: 'attempt-a',
    conclusionFingerprint: analysisDeliveryFingerprint(target.conclusion)};
  return {entry: 'new_finalization', acceptedCandidate, turnIntent: intent(), outputOrigin: 'sdk_final',
    completion: {...acceptedCandidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}};
}

async function verifiedFact(options: {declaredValue?: number; source?: boolean;
  metadataOnly?: boolean; report?: boolean; unusedSource?: Partial<SourceUseDecisionV1>;
  omitSourceScope?: boolean; sourceScope?: Partial<SourceExecutionScopeV1>; cloneContext?: boolean;
  rawSourceFields?: Record<string, unknown>} = {}) {
  const envelope = createDataEnvelope({columns: ['dur_ms'], rows: [[12.5]]}, {
    type: 'sql_result', source: 'execute_sql', title: 'Duration', evidenceRefId: 'data:duration',
    traceId: 'trace-a', traceSide: 'current', executionStatus: 'observed',
  });
  const declaredValue = options.declaredValue ?? 12.5;
  // A source-backed fact cites its location in the answer, where it can be checked.
  const draft = result(`The measured duration is ${declaredValue} ms${options.source ? ' at src/Foo.kt:L9-L15' : ''}.`);
  const reference = {evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms', value: declaredValue};
  const declaration = contract([{id: 'duration', kind: 'numeric', text: draft.conclusion, references: [reference],
    semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [reference]},
      numeric: {operator: 'eq', value: declaredValue, unit: 'ms'}}}]);
  let sourceUse: SourceUseDecisionV1 | undefined;
  if (options.source) {
    const source = sanitizeSourceReference({referenceId: 'lookup-a', codebaseId: 'source-a',
      filePath: 'src/Foo.kt', lineRange: {start: 9, end: 15}, lookupKind: options.metadataOnly ? 'metadata' : 'body'})!;
    sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: options.metadataOnly ? 'metadata_only' : 'provider_send',
      selectedCodebaseIds: ['source-a'], status: 'corroborated', attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['source-a'], usedCodebaseIds: ['source-a'], coverageComplete: true, references: [source]};
    declaration.sourceUseDecision = sourceUse;
    declaration.sourceReferences = [source];
    declaration.sourceClaimBindings = [{claimId: 'duration',
      sourceReferenceIds: [source.id], traceEvidenceRefIds: ['data:duration']}];
  }
  const parsed = parseConclusionContractDeclaration(declaration);
  if (!parsed.contract) throw new Error('Expected a valid typed duration declaration');
  draft.conclusionContract = parsed.contract;
  if (options.unusedSource) sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['source-a'], status: 'not_needed', attemptedTools: [], queriedCodebaseIds: [],
    usedCodebaseIds: [], references: [], ...options.unusedSource};
  if (options.rawSourceFields) draft.conclusion += `\n${CONCLUSION_CONTRACT_SIDECAR_MARKER}\n\`\`\`json\n${
    JSON.stringify({...declaration, ...options.rawSourceFields})}\n\`\`\`\n-->`;
  const store = new ArtifactStore();
  store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    dur_ms: {unit: 'ms', origin: {kind: 'native_producer', definitionFingerprint: 'duration-fixture-v1'}},
  }), {meta: envelope.meta, display: envelope.display});
  const strategy: StrategyDefinition = {scene: 'startup', classificationDescription: 'Measured duration.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], requiredCapabilities: [],
    optionalCapabilities: [], verifierMisdiagnosisPatterns: [], content: 'Measured duration.',
    detailSections: [], sourcePath: '/fixtures/duration.strategy.md', finalReportContract: {requiredSections: [{
      id: 'duration', label: 'Measured duration', required: true, triggerPatterns: [], patterns: [], patternGroups: [],
      recoveryText: {zh: [], en: []},
    }]}};
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'delivery-fixture'});
  const {acceptedCandidate, completion} = current(draft);
  attachFinalizationContext(draft, {runId: acceptedCandidate.runId, sessionId: draft.sessionId,
    deadlineMs: Date.now() + 600_000, strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a'}, sourceUse,
    sourceScope: options.omitSourceScope ? undefined : {codeAwareMode: sourceUse?.codeAwareMode ?? 'off',
      selectedCodebaseIds: sourceUse?.selectedCodebaseIds ?? [], hasCodebaseAccess: Boolean(sourceUse),
      analysisContextFingerprint: 'source-scope-a', ...options.sourceScope},
    turnIntent: intent({registryFingerprint: registry.registryFingerprint,
      deliverable: options.report ? 'report' : 'answer', scope: options.report ? 'scene_wide' : 'bounded_question'}),
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate, completion, outputOrigin: 'sdk_final'},
    evidenceReadView: store.createEvidenceReadView({ownerKey: acceptedCandidate.runId,
      allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}]}),
  });
  // Observe the real finalizer's bindings without substituting its verdict.
  const gate = jest.spyOn(qualityGate, 'applyFinalResultQualityGate');
  try {
    const issuedContext = takeFinalizationContext(draft)!;
    const finalized = await finalizeAnalysisResult({result: draft,
      context: options.cloneContext ? {...issuedContext} : issuedContext,
      owner: {runId: acceptedCandidate.runId, signal: new AbortController().signal, isCurrent: () => true, assertAuthorized: () => {}},
      query: 'What is the measured duration?', dataEnvelopes: [envelope]});
    const context = gate.mock.calls.find(([input]) => input.result === finalized.result)?.[0].context;
    if (context?.entry !== 'new_finalization') throw new Error('Expected the actual finalization binding context');
    return {target: finalized.result, context: structuredClone(context), envelope};
  } finally {gate.mockRestore();}
}

function sourceVerifiedFact(options: {metadataOnly?: boolean; report?: boolean} = {}) {
  return verifiedFact({...options, source: true});
}

describe('server-owned analysis delivery assessment', () => {
  it.each([{}, {sourceScope: {codeAwareMode: 'metadata_only' as const}}, {unusedSource: {}},
    {rawSourceFields: {sourceReferences: [], sourceClaimBindings: []}}])(
    'marks source-free runs not applicable without minting a source or claim verdict: %j', async options => {
      const {target, context} = await verifiedFact(options);
      expect(target).not.toHaveProperty('claimVerificationResult');
      expect(target).not.toHaveProperty('sourceClaimVerificationResult');
      expect(target.deliveryAssurance).toMatchObject({source: 'not_applicable', claims: 'not_applicable'});
      expect(assessFinalResultQualityAssessment({result: target, context}).assurance.source).toBe('not_applicable');
    });




  it('does not authorize completion from fields found in a provider or historical result', () => {
    const target = result('收到');
    target.completion = current(target).completion;
    target.outputOrigin = 'evidence_rendered';
    target.turnIntent = intent({taskKind: 'acknowledgement', evidenceAccess: 'existing_only'});
    target.confidence = 100;
    const before = structuredClone(target);
    const assessment = assessFinalResultQualityAssessment({result: target});
    expect(assessment.assurance.completion).toBe('not_checked');
    expect(assessment.assurance.claims).toBe('not_applicable');
    applyFinalResultQualityGate({result: target});
    expect(target).toEqual(before);
  });

  it.each(['Short', 'Short without terminal punctuation', '# Final Report\n\nShort',
    'Connection error was observed in the trace. Consider a full report.', 'x'.repeat(5000)])(
    'uses the SDK receipt rather than answer shape: %s', conclusion => {
      const target = result(conclusion);
      const assessment = assessFinalResultQualityAssessment({result: target, context: current(target)});
      expect(assessment.assurance.completion).toBe('passed');
      expect(assessment.assurance.report).toBe('not_applicable');
      expect(assessment.issues).toEqual([]);
    },
  );

  it.each(['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint'] as const)(
    'rejects a terminal receipt for another %s', field => {
      const target = result();
      const context = current(target);
      context.completion = {...context.completion!, [field]: 'other'};
      const assessment = assessFinalResultQualityAssessment({result: target, context});
      expect(assessment.assurance.completion).toBe('not_checked');
      expect(assessment.selectedIssue?.code).toBe('completion_not_checked');
      expect(assessment.selectedIssue?.recoveryKind).toBeUndefined();
    },
  );

  it('reports only the lifecycle failure when a runtime left a stale claim verdict on a partial answer', () => {
    const target = result('epoll_wait proves disk IO caused the delay.');
    target.partial = true;
    target.claimVerificationResult = {schemaVersion: 'claim_verifier@1', status: 'failed', passed: false,
      policy: 'record_only', checkedClaimCount: 1, unsupportedClaimCount: 1,
      claimResults: [{claimId: 'bad', status: 'unsupported'}],
      issues: [{claimId: 'bad', severity: 'error', code: 'missing', message: 'Missing evidence'}]};
    const context = current(target);
    context.completion = {...context.completion!, status: 'incomplete', reason: 'output_limit'};
    const assessment = assessFinalResultQualityAssessment({result: target, query: 'hello', context});
    expect(assessment.issues.map(issue => issue.code)).toEqual(['sdk_incomplete']);
    expect(assessment.selectedIssue?.recoveryKind).toBe('continue_output');
    expect(assessment.assurance.claims).toBe('not_applicable');
    expect(assessment.assurance.completion).toBe('failed');
  });


  it('does not inspect or recompute historical verdicts', () => {
    const target = result();
    target.partial = true;
    target.terminationMessage = 'Persisted verdict';
    Object.defineProperty(target, 'conclusion', {get: () => {throw new Error('historical body was inspected');}});
    Object.freeze(target);
    expect(applyFinalResultQualityGate({result: target, context: {entry: 'historical_restore'}})).toBeUndefined();
    expect(target.terminationMessage).toBe('Persisted verdict');
  });

  it('keeps fallback appendix outside the completed and verified body', () => {
    const target = result('');
    const context = current(target);
    target.runtimeAppendix = {schemaVersion: 1, origin: 'runtime_fallback',
      sourceCandidate: context.acceptedCandidate, text: '# Complete report\nEverything succeeded.'};
    applyFinalResultQualityGate({result: target, context});
    expect(target.conclusion).toBe('');
    expect(target.partial).toBe(true);
    expect(target.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(''));
    const fallback = result('Evidence summary');
    const fallbackContext = {...current(fallback), outputOrigin: 'runtime_fallback' as const};
    expect(assessFinalResultQualityAssessment({result: fallback, context: fallbackContext}).assurance.completion)
      .toBe('failed');
  });

  it('never passes completion for an evidence_rendered origin, which no current runtime produces', () => {
    const target = result('任意简短回应');
    const context = current(target);
    context.outputOrigin = 'evidence_rendered';
    context.turnIntent = intent({taskKind: 'acknowledgement', evidenceAccess: 'existing_only'});
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance)
      .toMatchObject({completion: 'not_checked', claims: 'not_applicable'});
  });



  it('maps the stored citation check directly: passed, coverage_incomplete, or not_applicable when absent', async () => {
    const {target, context} = await sourceVerifiedFact();
    expect(target.sourceClaimVerificationResult?.status).toBe('passed');
    expect(target.deliveryAssurance?.source).toBe('passed');
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.source).toBe('passed');
    const partial = structuredClone(target);
    partial.sourceClaimVerificationResult!.status = 'partial';
    expect(assessFinalResultQualityAssessment({result: partial, context}).assurance.source).toBe('coverage_incomplete');
    const absent = structuredClone(target);
    delete absent.sourceClaimVerificationResult;
    expect(assessFinalResultQualityAssessment({result: absent, context}).assurance.source).toBe('not_applicable');
    // A draft entry without a stored check is unknown, never not applicable.
    expect(assessFinalResultQualityAssessment({result: absent}).assurance.source).toBe('not_checked');
  });

  it('checks comparison identity from two side-specific resolutions rather than package-name prose', () => {
    const resolution = (side: 'current' | 'reference', name: string): IdentityResolutionV1 => ({
      version: 'identity_contract@1', identityRefId: `identity-${side}`, status: 'verified',
      target: {traceId: `trace-${side}`, traceSide: side, packageName: name, source: 'user_param'},
      processes: [{upid: 1, packageName: name, matchSources: ['process'], confidence: 1}], threads: [], warnings: [],
    });
    const identity = {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
      currentPackageName: 'app.a', referencePackageName: 'app.b',
      currentResolution: resolution('current', 'app.a'), referenceResolution: resolution('reference', 'app.b')};
    expect(assessFinalResultQualityAssessment({result: result('Left is slower.'), comparisonIdentity: identity})
      .assurance.identity).toBe('passed');
    expect(assessFinalResultQualityAssessment({result: result(), comparisonIdentity: {
      ...identity, referenceTraceId: undefined,
    }}).assurance.identity).toBe('not_checked');
    expect(assessFinalResultQualityAssessment({result: result(), comparisonIdentity: {
      ...identity, referenceTraceId: 'another-trace',
    }}).assurance.identity).toBe('failed');
    identity.referenceResolution.status = 'ambiguous';
    expect(assessFinalResultQualityAssessment({result: result('app.a and app.b'), comparisonIdentity: identity})
      .assurance.identity).toBe('failed');
  });
});

describe('report coverage', () => {
  it('is not assessed: a report deliverable records report not_applicable and raises no coverage issue', () => {
    const target = result('# Startup metrics\nTTID measured; TTFD unavailable');
    target.conclusionContract = contract();
    const context = current(target);
    context.turnIntent = intent({deliverable: 'report', scope: 'scene_wide'});
    const assessment = assessFinalResultQualityAssessment({result: target, context});
    expect(assessment.assurance.report).toBe('not_applicable');
    expect(assessment.selectedIssue).toBeUndefined();
  });
});
