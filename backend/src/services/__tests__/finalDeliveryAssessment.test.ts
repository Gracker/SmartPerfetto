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
  reportRequirementsFingerprint,
  type AnalysisDeliveryContext,
} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import {assessFinalReportContract} from '../finalReportContractGate';
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
    evidenceFingerprint: 'evidence-v1',
    completion: {...acceptedCandidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}};
}

async function verifiedFact(options: {declaredValue?: number; source?: boolean;
  metadataOnly?: boolean; report?: boolean; unusedSource?: Partial<SourceUseDecisionV1>;
  omitSourceScope?: boolean; sourceScope?: Partial<SourceExecutionScopeV1>; cloneContext?: boolean;
  rawSourceFields?: Record<string, unknown>; incompleteSemanticCoverage?: boolean} = {}) {
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
  const narrative = draft.conclusion + (options.rawSourceFields ? '\n' : '');
  if (options.rawSourceFields) draft.conclusion += `\n${CONCLUSION_CONTRACT_SIDECAR_MARKER}\n\`\`\`json\n${
    JSON.stringify({...declaration, ...options.rawSourceFields})}\n\`\`\`\n-->`;
  const store = new ArtifactStore();
  store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    dur_ms: {unit: 'ms', origin: {kind: 'native_producer', definitionFingerprint: 'duration-fixture-v1'}},
  }), {meta: envelope.meta, display: envelope.display});
  const strategy: StrategyDefinition = {scene: 'startup', classificationDescription: 'Measured duration.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], requiredCapabilities: [],
    optionalCapabilities: [], phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'Measured duration.',
    detailSections: [], sourcePath: '/fixtures/duration.strategy.md', finalReportContract: {requiredSections: [{
      id: 'duration', label: 'Measured duration', required: true, triggerPatterns: [], patterns: [], patternGroups: [],
      recoveryText: {zh: [], en: []},
    }]}};
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'delivery-fixture'});
  const {acceptedCandidate, completion} = current(draft);
  attachFinalizationContext(draft, {runId: acceptedCandidate.runId, sessionId: draft.sessionId,
    deadlineMs: Date.now() + 10_000, strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a'}, sourceUse,
    sourceScope: options.omitSourceScope ? undefined : {codeAwareMode: sourceUse?.codeAwareMode ?? 'off',
      selectedCodebaseIds: sourceUse?.selectedCodebaseIds ?? [], hasCodebaseAccess: Boolean(sourceUse),
      analysisContextFingerprint: 'source-scope-a', ...options.sourceScope},
    turnIntent: intent({registryFingerprint: registry.registryFingerprint,
      deliverable: options.report ? 'report' : 'answer', scope: options.report ? 'scene_wide' : 'bounded_question'}),
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate, completion, outputOrigin: 'sdk_final'},
    evidenceReadView: store.createEvidenceReadView({ownerKey: acceptedCandidate.runId,
      allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}]}),
    dispatchText: async () => ({status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: options.incompleteSemanticCoverage ? 'incomplete' : 'complete',
        reviewedSpans: [{start: 0, end: narrative.length}]},
      claims: [{claimId: 'duration', consistency: 'consistent', contentLocations: [
        {start: 0, end: narrative.length, text: narrative}], issues: []}],
      omissions: [], requirements: options.report ? [{requirementId: 'duration', applicability: 'applicable', coverage: 'covered',
        contentLocations: [{start: 0, end: narrative.length, text: narrative}], claimIds: ['duration']}] : []})}),
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

function report(body = 'Measured TTID 12ms; TTFD was unavailable.') {
  const target = result(body);
  target.conclusionContract = contract();
  const context = current(target);
  context.turnIntent = intent({deliverable: 'report', scope: 'scene_wide'});
  context.reportRequirements = {sceneId: 'startup', registryFingerprint: 'registry-v1', requirements: [
    {id: 'startup_metrics', label: 'Startup metrics', description: 'Measured TTID and TTFD with evidence limits.', required: true},
  ]};
  context.reportAssessment = {schemaVersion: 1, status: 'checked', binding: {
    ...context.acceptedCandidate,
    conclusionContractFingerprint: analysisDeliveryFingerprint(target.conclusionContract),
    evidenceFingerprint: context.evidenceFingerprint!,
    registryFingerprint: 'registry-v1',
    intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    requirementsFingerprint: reportRequirementsFingerprint(context.reportRequirements),
  }, requirements: [{requirementId: 'startup_metrics', applicability: 'applicable', coverage: 'covered',
    contentLocations: [{start: 0, end: body.length}]}]};
  return {target, context};
}

describe('server-owned analysis delivery assessment', () => {
  it.each([{}, {sourceScope: {codeAwareMode: 'metadata_only' as const}}, {unusedSource: {}},
    {rawSourceFields: {sourceReferences: [], sourceClaimBindings: []}}])(
    'marks captured source-free runs not applicable without minting a source verdict: %j', async options => {
      const {target, context} = await verifiedFact(options);
      expect(target.claimVerificationResult).toMatchObject({passed: true});
      expect(target.sourceClaimVerificationResult).toMatchObject({status: 'not_checked', bindings: [], issues: []});
      expect(context.sourceApplicability).toBe('not_applicable');
      expect(target.deliveryAssurance?.source).toBe('not_applicable');
    });

  it.each([
    {omitSourceScope: true}, {cloneContext: true}, {incompleteSemanticCoverage: true},
    {unusedSource: {status: 'pending' as const}}, {unusedSource: {status: 'disallowed' as const}},
    {unusedSource: {attemptedTools: ['search_codebase']}}, {unusedSource: {queriedCodebaseIds: ['source-a']}},
    {unusedSource: {usedCodebaseIds: ['source-a']}}, {unusedSource: {coverageComplete: false}},
    {unusedSource: {incompleteReasons: ['search_timeout']}},
    {unusedSource: {}, sourceScope: {selectedCodebaseIds: ['different-source']}},
    {sourceScope: {hasCodebaseAccess: true}},
    {rawSourceFields: {sourceReferences: 'invalid'}}, {rawSourceFields: {sourceClaimBindings: {}}},
    {rawSourceFields: {sourceUseDecision: null}},
    {rawSourceFields: {sourceReferences: [{id: 'invented'}]}},
  ])('does not infer source-free applicability from missing, changed or incomplete inputs: %j', async options => {
    const {target, context} = await verifiedFact(options);
    expect(context.sourceApplicability).toBeUndefined();
    expect(target.deliveryAssurance?.source).not.toBe('not_applicable');
  });

  it('binds source applicability to the complete current declaration, scope, ledger and candidate', async () => {
    const {target, context} = await verifiedFact();
    const assess = (changed = target, delivery = context) =>
      assessFinalResultQualityAssessment({result: changed, context: delivery}).assurance.source;
    expect(assess()).toBe('not_applicable');
    expect(assess({...target, sourceReferences: [{id: 'forged'}] as AnalysisResult['sourceReferences']})).not.toBe('not_applicable');
    expect(assess({...target, conclusionContract: {...target.conclusionContract!, nextSteps: ['changed']}})).not.toBe('not_applicable');
    expect(assess({...target, conclusion: `${target.conclusion} changed`})).not.toBe('not_applicable');
    expect(assess(target, {...context, sourceScopeFingerprint: 'changed'})).not.toBe('not_applicable');
    expect(assess(target, {...context, sourceUseFingerprint: 'changed'})).not.toBe('not_applicable');
    expect(assessFinalResultQualityAssessment({result: target, context: {entry: 'runtime_draft'}}).assurance.source).toBe('not_checked');
  });

  it.each([
    {predicate: 'source.existence'}, {scope: {population: 'codebase'}},
    {source: {sourceReferenceId: 'invented', filePath: 'Foo.kt', lineRange: {start: 1, end: 1}}},
  ])('does not treat a declared source proposition as source-free: %j', async semantics => {
    const {context, target} = await verifiedFact({rawSourceFields: {claims: [{id: 'duration',
      text: 'The measured duration is 12.5 ms.', kind: 'inference', references: [], semantics: {
        schemaVersion: 'claim_semantics@1', predicate: 'example.hypothesis', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'cited_rows'},
        ...semantics,
      }}]}});
    expect(context.sourceApplicability).toBeUndefined();
    expect(target.deliveryAssurance?.source).not.toBe('not_applicable');
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
    expect(assessment.assurance.claims).toBe('not_checked');
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

  it('collects bad evidence before interruption even when the runtime already marked partial', () => {
    const target = result('epoll_wait proves disk IO caused the delay.');
    target.partial = true;
    target.claimVerificationResult = {schemaVersion: 'claim_verifier@1', status: 'failed', passed: false,
      policy: 'record_only', checkedClaimCount: 1, unsupportedClaimCount: 1,
      claimResults: [{claimId: 'bad', status: 'unsupported'}],
      issues: [{claimId: 'bad', severity: 'error', code: 'missing', message: 'Missing evidence'}]};
    const context = current(target);
    context.completion = {...context.completion!, status: 'incomplete', reason: 'output_limit'};
    const assessment = assessFinalResultQualityAssessment({result: target, query: 'hello', context});
    expect(assessment.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'verifier_contradicted_claim', 'kernel_blocking_claim_boundary', 'sdk_incomplete',
    ]));
    expect(assessment.selectedIssue?.recoveryKind).toBe('correct_evidence');
    expect(assessment.assurance.claims).toBe('failed');
    expect(assessment.assurance.completion).toBe('failed');
  });

  it('keeps runtime drafts read-only while returning their actual evidence failure', async () => {
    const {target} = await verifiedFact({declaredValue: 999});
    expect(target.claimVerificationResult).toMatchObject({status: 'failed', passed: false,
      claimResults: [{claimId: 'duration', status: 'unsupported'}]});
    const before = structuredClone(target);
    expect(applyFinalResultQualityGate({result: target, context: {entry: 'runtime_draft'}})?.code)
      .toBe('verifier_contradicted_claim');
    expect(target).toEqual(before);
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

  it('accepts an explicit acknowledgement proof without converting confidence or words into evidence', () => {
    const target = result('任意简短回应');
    target.confidence = 0;
    const context = current(target);
    context.outputOrigin = 'evidence_rendered';
    context.turnIntent = intent({taskKind: 'acknowledgement', evidenceAccess: 'existing_only'});
    context.evidenceRenderedProof = {kind: 'acknowledgement', candidate: context.acceptedCandidate,
      intentFingerprint: analysisDeliveryFingerprint(context.turnIntent), evidence: 'not_applicable'};
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance)
      .toMatchObject({completion: 'passed', claims: 'not_applicable'});
    target.conclusionContract = contract([{id: 'fact', text: 'A factual claim', references: []}]);
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.completion).toBe('not_checked');
    target.conclusionContract = contract();
    context.turnIntent = intent();
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.completion).toBe('not_checked');
  });

  it('requires current claim IDs and actual reference verification for evidence-rendered facts', async () => {
    const {target: baseline, context: baselineContext} = await verifiedFact();
    const target = structuredClone(baseline);
    const context = structuredClone(baselineContext);
    context.outputOrigin = 'evidence_rendered';
    context.evidenceRenderedProof = {kind: 'verified_facts', candidate: context.acceptedCandidate,
      claimIds: ['duration'], claimsFingerprint: analysisDeliveryFingerprint(target.conclusionContract?.claims),
      verificationFingerprint: analysisDeliveryFingerprint(target.claimVerificationResult),
      evidenceFingerprint: context.evidenceFingerprint!};
    expect(target.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'passed', passed: true,
      claimResults: [{claimId: 'duration', status: 'verified', deterministicProof: {status: 'proved'}}]});
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.completion).toBe('passed');
    delete target.conclusionContract!.claims![0].id;
    context.evidenceRenderedProof.claimsFingerprint = analysisDeliveryFingerprint(target.conclusionContract?.claims);
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.completion).toBe('not_checked');
    expect(assessFinalResultQualityAssessment({result: baseline, context: baselineContext}).assurance.claims).toBe('passed');
  });

  it.each(['claims', 'evidence', 'candidate', 'missing_binding'] as const)(
    'does not reuse actual verified facts after changing %s', async changed => {
      const {target: baseline, context: baselineContext} = await verifiedFact();
      const target = structuredClone(baseline);
      const context = structuredClone(baselineContext);
      expect(target.claimVerificationResult?.status).toBe('passed');
      expect(assessFinalResultQualityAssessment({result: target, context}).assurance.claims).toBe('passed');
      if (changed === 'claims') {
        target.conclusionContract!.claims![0] = {...target.conclusionContract!.claims![0],
          text: 'The measured duration is 999 ms.',
          references: [{evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms', value: 999}]};
      } else if (changed === 'evidence') context.evidenceFingerprint = 'new-evidence-snapshot';
      else if (changed === 'candidate') {
        target.conclusion = 'A revised answer';
        const next = current(target);
        context.acceptedCandidate = next.acceptedCandidate;
        context.completion = next.completion;
      } else context.claimVerificationBinding = undefined;
      expect(assessFinalResultQualityAssessment({result: target, context}).assurance.claims).toBe('not_checked');
      expect(target.claimVerificationResult?.status).toBe('passed');
      expect(assessFinalResultQualityAssessment({result: baseline, context: baselineContext}).assurance.claims).toBe('passed');
    },
  );

  it('binds actual source verification to current claims, source use and evidence', async () => {
    const {target, context} = await sourceVerifiedFact();
    expect(target.sourceClaimVerificationResult?.status).toBe('passed');
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.source).toBe('passed');
    for (const changed of ['source', 'evidence', 'contract', 'claim_binding', 'source_binding'] as const) {
      const changedTarget = structuredClone(target);
      const changedContext = structuredClone(context);
      if (changed === 'source') changedContext.sourceUseFingerprint = 'new-source-scope';
      else if (changed === 'evidence') changedContext.evidenceFingerprint = 'new-evidence';
      else if (changed === 'contract') changedTarget.conclusionContract!.sourceClaimBindings = [];
      else if (changed === 'claim_binding') changedContext.claimVerificationBinding = undefined;
      else changedContext.sourceVerificationBinding = undefined;
      expect(assessFinalResultQualityAssessment({result: changedTarget, context: changedContext}).assurance.source)
        .toBe('not_checked');
    }
    expect(assessFinalResultQualityAssessment({result: target, context}).assurance.source).toBe('passed');
  });

  it('keeps the accepted report contract stable when a source claim is weaker than linked', async () => {
    const {target, context} = await sourceVerifiedFact({metadataOnly: true, report: true});
    expect(target.sourceUseDecision?.codeAwareMode).toBe('metadata_only');
    const acceptedContract = structuredClone(target.conclusionContract);
    const assessedHash = context.reportAssessment!.binding.conclusionContractFingerprint;
    for (let application = 0; application < 2; application++) {
      // A locate-only claim is delivered unverified, not failed.
      expect(applyFinalResultQualityGate({result: target, context})?.code).not.toBe('source_claim_binding_invalid');
      expect(target.sourceClaimVerificationResult).toMatchObject({schemaVersion: 'source_claim_verifier@2',
        claims: [{claimId: 'duration', status: 'location_only'}]});
      expect(target.conclusionContract).toEqual(acceptedContract);
      expect(analysisDeliveryFingerprint(target.conclusionContract)).toBe(assessedHash);
      expect(target.reportAssessment?.binding.conclusionContractFingerprint).toBe(assessedHash);
      expect(target.deliveryAssurance?.report).toBe('passed');
      expect(target.deliveryAssurance?.source).toBe('coverage_incomplete');
    }
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

describe('typed final report coverage', () => {
  it('does not infer coverage from headings or generic contract fields', () => {
    const {target, context} = report('# Startup metrics\n## Evidence\n## Recommendations');
    context.reportAssessment = undefined;
    target.conclusionContract!.evidenceChain = [{conclusionId: 'one', text: 'Some evidence exists'}];
    expect(assessFinalReportContract({conclusion: target.conclusion, conclusionContract: target.conclusionContract, context})
      .status).toBe('not_checked');
  });

  it.each(['TTID measured; TTFD unavailable', '# Arbitrary heading\nTTID measured; TTFD unavailable'])(
    'accepts matching semantic coverage independently of headings: %s', body => {
      const {target, context} = report(body);
      expect(assessFinalReportContract({conclusion: body, conclusionContract: target.conclusionContract, context}).status)
        .toBe('passed');
    },
  );

  it('returns typed missing requirements without parsing localized messages', () => {
    const {target, context} = report();
    context.reportAssessment!.requirements = [{requirementId: 'startup_metrics', applicability: 'applicable', coverage: 'missing'}];
    const issue = assessFinalResultQualityAssessment({result: target, context}).selectedIssue;
    expect(issue?.recoveryKind).toBe('complete_report_content');
    expect(issue?.missingSections?.map(section => section.id)).toEqual(['startup_metrics']);
    expect(issue?.missingSections?.[0].description).toContain('TTID');
  });

  it('does not let semantic output waive an unconditional scene-wide obligation', () => {
    const {target, context} = report();
    context.reportAssessment!.requirements = [{requirementId: 'startup_metrics',
      applicability: 'not_applicable', coverage: 'unknown'}];
    const assessment = assessFinalReportContract({conclusion: target.conclusion,
      conclusionContract: target.conclusionContract, context});
    expect(assessment.status).toBe('coverage_incomplete');
    expect(assessment.requirements[0].applicability).toBe('applicable');
  });

  it.each(['legacy_trigger_patterns', 'invalid_condition'] as const)(
    'keeps %s unresolved even when semantic output claims coverage or exemption', reason => {
      const {target, context} = report();
      context.reportRequirements!.requirements = [{...context.reportRequirements!.requirements[0],
        condition: {kind: 'unresolved', reason}}];
      context.reportAssessment!.binding.requirementsFingerprint = reportRequirementsFingerprint(context.reportRequirements!);
      for (const applicability of ['applicable', 'not_applicable'] as const) {
        context.reportAssessment!.requirements = [{requirementId: 'startup_metrics', applicability,
          coverage: 'covered', contentLocations: [{start: 0, end: target.conclusion.length}]}];
        const assessment = assessFinalReportContract({conclusion: target.conclusion,
          conclusionContract: target.conclusionContract, context});
        expect(assessment.status).toBe('coverage_incomplete');
        expect(assessment.requirements[0].applicability).toBe('unknown');
        expect(assessment.missingSections).toEqual([]);
      }
    },
  );

  it.each(['not_checked', 'unavailable', 'coverage_incomplete'] as const)(
    'keeps %s observable without supplying a speculative recovery', status => {
      const {target, context} = report();
      context.reportAssessment!.status = status;
      const assessment = assessFinalResultQualityAssessment({result: target, context});
      expect(assessment.assurance.report).toBe(status);
      expect(assessment.selectedIssue?.recoveryKind).toBeUndefined();
    },
  );

  it.each(['conclusionFingerprint', 'conclusionContractFingerprint', 'evidenceFingerprint',
    'requirementsFingerprint', 'registryFingerprint', 'intentFingerprint', 'candidateRef', 'runId', 'attemptId'] as const)(
    'refuses semantic coverage bound to a different %s', field => {
      const {target, context} = report();
      context.reportAssessment!.binding[field] = 'other-version';
      expect(assessFinalReportContract({conclusion: target.conclusion, conclusionContract: target.conclusionContract, context})
        .status).toBe('not_checked');
    },
  );

  it('does not grant report assurance for a preview or a coverage record without valid locations', () => {
    const {target, context} = report();
    context.reportAssessment!.requirements = [{requirementId: 'startup_metrics', applicability: 'applicable',
      coverage: 'covered', contentLocations: [{start: 0, end: 10000}]}];
    expect(assessFinalReportContract({conclusion: target.conclusion, conclusionContract: target.conclusionContract, context})
      .status).toBe('coverage_incomplete');
  });

  it('does not impose a report contract on an answer, at any budget or scope', () => {
    const {target, context} = report();
    context.turnIntent = intent({recommendedComplexity: 'full', scope: 'bounded_question', deliverable: 'answer'});
    context.reportAssessment = undefined;
    expect(assessFinalReportContract({conclusion: target.conclusion, context}).status).toBe('not_applicable');
  });
});
