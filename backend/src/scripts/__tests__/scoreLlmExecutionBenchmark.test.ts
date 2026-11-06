// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';
import {createRuntimePerformanceRecorder, buildRuntimeConfigCommitments, buildRuntimeAppliedModelControls,
  buildRuntimeExecutionProfileObservation} from '../../agentRuntime/runtimePerformance';
import {resolveModelExecutionProfile} from '../../services/providerManager/modelExecutionProfile';
import {resolveOpenAITextRequestPurpose} from '../../services/providerManager/openAiChatCompletionsCompat';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OPENAI_TYPED_FINAL_CONTRACTS, OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION} from '../../agentRuntime/finalSubmissionImplementation';
import {stableStringify} from '../../utils/stableJson';
import {buildLlmExecutionQuality} from '../llmExecutionBenchmark';
import {parseLlmExecutionScoreArgs, scoreLlmExecutionBenchmark} from '../scoreLlmExecutionBenchmark';

// Synthetic saved receipts exercise the checker; these tests establish no real-provider performance.
type Json = Record<string, any>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const CELLS = ['scheduler', 'startup', 'scrolling', 'source', 'dual'];
const MODEL = 'deepseek-flash';
const ORIGIN = 'https://api.deepseek.com';
const BASE_SOURCE = 'a'.repeat(64), CANDIDATE_SOURCE = 'b'.repeat(64), CORE = 'c'.repeat(64);
const repositoryRoot = path.resolve(__dirname, '../../../..');
const sourceLifecycle = require('../../../scripts/llm-execution-lifecycle.cjs');

function sourceReport(report: Json, context: any) {
  const sourceId = 'source-ref-v1-test', traceId = 'source-trace';
  const anchors = ['duration', 'mapping'].map(id => ({anchorId: `anchor-${id}`, evidenceRefId: `data-${id}`,
    context: {traceId, traceSide: 'current', captureId: `capture-${id}`}, cells: [{column: 'dur'}]}));
  const proofs = anchors.map((anchor, index) => ({claimId: index ? 'mapping' : 'duration', status: 'verified',
    propositionCoverage: {status: 'complete', uncovered: []},
    referenceCells: [{anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, column: 'dur', status: 'matched'}],
    deterministicProof: {kind: 'numeric_cell', status: 'proved', anchorIds: [anchor.anchorId], evidenceRefIds: [anchor.evidenceRefId],
      nativeRows: [{anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, captureId: anchor.context.captureId,
        traceId, traceSide: 'current', relation: 'slice', idColumn: 'id', id: 50, schemaFingerprint: 'a'.repeat(64)}]}}));
  Object.assign(report, {traceId, strict: true, passed: false, completeAcceptance: false, semanticAcceptance: 'INCONCLUSIVE',
    observedChecksPassed: true, checks: {oracle: true}, ungroupedChecks: {}, query: context.inputs.query.text,
    uncoveredFacets: [sourceLifecycle.SOURCE_FACET.facetId],
    analysisContext: {codeAwareMode: 'provider_send', codebaseIds: ['source'], setup: {codebases: [{setupMode: 'register-only',
      chunkCount: 0, activeIndexState: 'none', pendingGeneration: false, reindexRequests: 0}]}},
    taskVerification: {checks: {'fact:source_marker_duration': true}, uncoveredFacets: [sourceLifecycle.SOURCE_FACET.facetId],
      facts: {source_marker_duration: {matched: true, proposition: 'proved', matchedClaimIds: ['duration'], matchedAnchorIds: [anchors[0].anchorId]}}}});
  Object.assign(report.runIdentity, {query: context.inputs.query.text, traceSha256: context.contract.traceSha256,
    expectationHash: context.contract.expectationHash});
  report.executionTarget.sourceFacet = context.contract;
  Object.assign(report.summary, {analysisCompletedSourceReferenceCount: 1, analysisCompletedSourceBindingCount: 1,
    analysisCompletedSourceClaimVerifierStatus: 'passed', analysisCompletedSourceReferenceMembershipPassed: true,
    analysisCompletedSourceClaimStatuses: ['trace_linked'], analysisCompletedVerifiedSourceBindings: [{claimId: 'mapping',
      status: 'trace_linked', sourceReferenceIds: [sourceId], traceEvidenceRefIds: ['data-mapping']}],
    analysisCompletedSourceUseDecision: {references: [{id: sourceId, codebaseId: 'source', filePath: 'StartupHooks.kt',
      lookupKind: 'body', lineRange: {start: 1, end: 47}}]}});
  Object.assign(report.summary.terminalAnalysis, {conclusion: 'The selected synthetic marker on com.smartperfetto.fixture/main lasts 42 ms. '
    + 'Application.onCreate invokes initializeOnMainThread, which synchronously reads policy through readStartupPolicySynchronously and File.readText. '
    + 'Preload the policy before entering the marker and keep the nonempty check dependent on the loaded policy; preserve thread safety. '
    + 'This is a candidate mechanism in the constructed pair, not proof of the base APK or of all 42 ms being caused by this read. '
    + 'Measure the same marker and synthetic first-frame boundary after a change; real startup gain remains unknown.',
    completion: {schemaVersion: 1, status: 'completed', runId: report.executionMetrics.runId, runtimeKind: report.executionMetrics.runtime},
    conclusionContract: {claims: [{id: 'duration', kind: 'numeric'}, {id: 'mapping', kind: 'numeric'}]},
    claimSupport: anchors.map((anchor, index) => ({claimId: index ? 'mapping' : 'duration', anchors: [anchor]})),
    claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'passed', passed: true, claimResults: proofs}});
}

function write(root: string, relative: string, value: unknown): string {
  const filename = path.join(root, relative), bytes = `${JSON.stringify(value)}\n`;
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  fs.writeFileSync(filename, bytes);
  return hash(bytes);
}

function fixture(root: string, cells = ['scheduler']) {
  const observerEvidence = {schemaVersion: 'llm_execution_observer_review@1',
    baselineSourceFingerprint: BASE_SOURCE, candidateSourceFingerprint: CANDIDATE_SOURCE, coreFingerprint: CORE,
    verdict: 'equivalent', reviewer: {kind: 'independent_agent', id: 'test-reviewer', independentOfImplementation: true},
    rationale: 'Synthetic fixture for validating the evidence reader; no model was executed.'};
  const hook = write(root, 'reviews/observer.json', observerEvidence);
  const observer = {coreFingerprint: CORE, reviewedHookContractFingerprint: hook,
    fingerprint: hash(stableStringify({coreFingerprint: CORE, reviewedHookContractFingerprint: hook})),
    hookEvidence: 'reviewed_contract_not_automatic_wire_equivalence'};
  const reviews: Json = {schemaVersion: 'llm_execution_reviews@1',
    observerReviews: [{evidencePath: 'reviews/observer.json', evidenceSha256: hook}], materialReviews: [], sourceFacetReviews: []};
  const nonce = 'd'.repeat(32), samples: Json[] = [];
  let ordinal = 0, scoreOrdinal = 0;
  for (const cellId of cells) for (let repetition = 1; repetition <= 3; repetition++) for (const side of ['base', 'candidate']) {
    ordinal++;
    const pairId = `${cellId}-${String(repetition).padStart(2, '0')}`;
    const preparedAt = 100000 + ordinal * 20000, totalMs = side === 'base' ? 10000 : 8000;
    const sessionId = `session-${ordinal}`, runId = `run-${ordinal}`;
    const sourceFingerprint = side === 'base' ? BASE_SOURCE : CANDIDATE_SOURCE;
    const configFingerprint = 'e'.repeat(64), dataRootHash = hash(`data-root-${ordinal}`);
    const target = {schemaVersion: 'llm_execution_target@1', nonce, side, pairId, cellId, repetition,
      origin: `http://127.0.0.1:${side === 'base' ? 19881 : 19882}`, processId: 100 + ordinal,
      sourceFingerprint, dataRootHash, declaredObserverFingerprint: observer.fingerprint,
      declaredConfigFingerprint: configFingerprint, status: 'matched', sessionId, runId};
    const report: Json = {completeAcceptance: true, semanticAcceptance: 'PASSED', proofAcceptance: 'PASSED', hardGatesPassed: true,
      checkGroups: {value: {oracle: true}, proof: {proved: true}, delivery: {completed: true}}, uncoveredFacets: [],
      sessionId, runIdentity: {schemaVersion: 1, runtime: 'openai-agents-sdk', query: `Independent ${cellId} query`,
        gateSchemaVersion: 'agent_sse_gate@1', verificationSchemaVersion: 'agent_sse_verification@1',
        traceSha256: hash(`trace-${cellId}`), expectationHash: hash(`expectation-${cellId}`),
        traceProcessorVersion: `bundled:${'f'.repeat(40)}`, stdlibRevision: 'f'.repeat(40)},
      executionTarget: target,
      executionMetrics: {schemaVersion: 'llm_execution_metrics_artifact@1', status: 'sealed', sessionId, runId,
        sealedAt: preparedAt + totalMs, wallclockMs: totalMs, runtime: 'openai-agents-sdk', modelHash: hash(MODEL),
        providerSnapshotHash: '1'.repeat(64), performance: {schemaVersion: 1,
          modelCalls: [{purpose: 'answer_turn', outcome: 'ok', modelHash: hash(MODEL), providerOriginHash: hash(ORIGIN),
            startOffsetMs: 100, durationMs: totalMs - 200}],
          modelRequests: [{dispatchOrdinal: 1, startOffsetMs: 100, fetchOutcome: 'headers', headersMs: 1,
            body: {status: 'observed', bodyBytes: 12000}}],
          phases: [{name: 'provider', startOffsetMs: 100, durationMs: 200},
            {name: 'provider', startOffsetMs: 200, durationMs: 200}], tools: [], sql: []}},
      taskVerification: {facts: {duration: {matched: true, proposition: 'supported'}}},
      summary: {terminalAnalysis: {success: true, completion: {status: 'completed'}, conclusion: 'The selected interval is 33 ms.',
        conclusionContract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
          conclusions: [{rank: 1, statement: 'The selected interval is 33 ms.'}], clusters: [], evidenceChain: [],
          uncertainties: [], nextSteps: [], claims: [{id: 'duration', kind: 'numeric', text: 'The selected interval is 33 ms.',
            references: [{evidenceRefId: 'duration-row', rowIndex: 0, column: 'dur', value: 33000000}],
            semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted',
              quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows',
                subjectRefs: [{evidenceRefId: 'duration-row', rowIndex: 0, column: 'dur', value: 33000000}]},
              numeric: {operator: 'eq', value: 33, unit: 'ms'}}}], relationProposals: []}}}};
    const reportPath = `${pairId}/${side}/report.json`;
    const sample: Json = {schemaVersion: 'llm_execution_sample@1', nonce, side, pairId, cellId, repetition,
      measurementOrigin: 'real_provider', sampleKind: 'local-cold', providerCacheState: 'unknown',
      pin: {provider: 'deepseek', runtime: 'openai-agents-sdk', model: MODEL, lightModel: MODEL, origin: ORIGIN},
      sourceFingerprint, configFingerprint, taskFingerprint: hash(`task-${cellId}`), observer,
      targetStatus: 'matched', dataCleanup: 'removed', report: reportPath, reportStatus: 'available', reportHash: write(root, reportPath, report),
      lifecycle: {preparedAt: preparedAt + 1, settledAt: preparedAt + totalMs + 20, processId: target.processId,
        exitCode: 0, signal: null, outcome: 'exited', cleanup: 'confirmed', censored: false},
      reset: {schemaVersion: 'llm_execution_pair_reset@1', nonce, side, pairId, cellId, repetition,
        sampleKind: 'local-cold', status: 'observed', preparedAt, completedAt: preparedAt + totalMs + 30, dataRootHash,
        actions: ['created_fresh_data_root', 'spawned_process', 'awaited_process', 'confirmed_process_group_exit', 'confirmed_backend_port_release']}};
    write(root, `${pairId}/${side}/receipt.json`, sample);
    samples.push(sample);
  }
  const benchmark: Json = {schemaVersion: 'llm_execution_benchmark@1', candidate: 'llm-execution-v1', nonce,
    measurementOrigin: 'real_provider', provider: 'deepseek', runtime: 'openai-agents-sdk', model: MODEL, lightModel: MODEL,
    sampleKind: 'local-cold', lifecycle: 'collected', differentSources: true,
    coverage: {cells, requiredCells: CELLS, repetitions: 3, scheduledSamples: samples.length, observedSamples: samples.length}, samples};
  const save = () => {write(root, 'benchmark.json', benchmark); write(root, 'reviews.json', reviews);};
  const reportFor = (sample: Json) => JSON.parse(fs.readFileSync(path.join(root, sample.report), 'utf8')) as Json;
  const resave = (sample: Json, report?: Json) => {
    if (report) sample.reportHash = write(root, sample.report, report);
    write(root, `${sample.pairId}/${sample.side}/receipt.json`, sample); save();
  };
  const materialReview = (base: Json, candidate: Json, overrides: Json = {}) => {
    const before = buildLlmExecutionQuality(reportFor(base)), after = buildLlmExecutionQuality(reportFor(candidate));
    const evidence = {schemaVersion: 'llm_execution_material_review@1', baselineFingerprint: before.fingerprints.full,
      candidateFingerprint: after.fingerprints.full, baselineReportSha256: base.reportHash, candidateReportSha256: candidate.reportHash,
      verdict: 'equivalent_or_improved', reviewer: {kind: 'human', id: 'test-reviewer', independentOfImplementation: true},
      rationale: 'Synthetic independent-review receipt exercising exact artifact bindings.', ...overrides};
    const evidencePath = `reviews/material-${reviews.materialReviews.length}.json`;
    reviews.materialReviews.push({evidencePath, evidenceSha256: write(root, evidencePath, evidence)}); save();
  };
  const sourceArtifacts = (sample: Json, overrides: Json = {}) => {
    const context = sourceLifecycle.sourceFacetContext(repositoryRoot), report = reportFor(sample);
    const request = {...report.executionTarget, port: Number(new URL(report.executionTarget.origin).port),
      expectedSourceFingerprint: sample.sourceFingerprint, observerFingerprint: observer.fingerprint,
      configFingerprint: sample.configFingerprint, dataRootHash: sample.reset.dataRootHash};
    const pending = sourceLifecycle.evaluateSourceFacetPending(report, request, repositoryRoot);
    if (!pending) throw new Error('Synthetic source fixture failed automatic A2 checks');
    const receiptPath = `${sample.pairId}/${sample.side}/${sourceLifecycle.SOURCE_FACET.receiptFile}`;
    const receiptHash = write(root, receiptPath, {...pending, rawReportSha256: sample.reportHash, settledAt: sample.lifecycle.settledAt - 1});
    sample.sourceFacetCollection = {path: receiptPath, sha256: receiptHash, disposition: 'collected_pending_independent_review'};
    const quality = buildLlmExecutionQuality(report), body = report.summary.terminalAnalysis.conclusion;
    const review = {schemaVersion: sourceLifecycle.SOURCE_FACET.reviewSchema, rubricVersion: sourceLifecycle.SOURCE_FACET.rubricVersion,
      facetId: sourceLifecycle.SOURCE_FACET.facetId,
      bindings: {rawReportSha256: sample.reportHash, collectionReceiptSha256: receiptHash,
        bodyFingerprint: quality.fingerprints.body, contractFingerprint: quality.fingerprints.contract,
        fullQualityFingerprint: quality.fingerprints.full, runId: report.executionMetrics.runId, sessionId: report.sessionId,
        provider: sample.pin.provider, providerSnapshotHash: report.executionMetrics.providerSnapshotHash,
        modelHash: report.executionMetrics.modelHash, runtime: report.executionMetrics.runtime, ...context.contract},
      reviewer: {kind: 'independent_agent', id: 'synthetic-reviewer', independentOfImplementation: true},
      rationale: 'Synthetic review evidence tests admission; it is not a real model quality judgment.', verdict: 'covered',
      items: sourceLifecycle.SOURCE_FACET.rubric.map((id: string) => ({id, verdict: 'covered', rationale: `Fixture coverage: ${id}`,
        evidence: [{body: {start: 0, end: body.length, sha256: hash(body)},
          claimIds: [report.summary.analysisCompletedVerifiedSourceBindings[0].claimId], reason: 'Explicit fixture body and source mechanism.',
          source: {filePath: context.groundTruth.relativeSourcePath, symbol: context.groundTruth.symbol,
            referenceId: 'source-ref-v1-test', sourceGeneration: null, lineRange: {start: 17, end: 29}}}]})),
      ...overrides};
    const evidencePath = `reviews/facet-${sample.pairId}-${sample.side}.json`;
    reviews.sourceFacetReviews = reviews.sourceFacetReviews.filter((entry: Json) => entry.evidencePath !== evidencePath);
    reviews.sourceFacetReviews.push({evidencePath, evidenceSha256: write(root, evidencePath, review)});
    resave(sample);
    return review;
  };
  if (cells.includes('source')) {
    const context = sourceLifecycle.sourceFacetContext(repositoryRoot);
    benchmark.sourceFacet = context.contract;
    benchmark.sourceFacetStatus = 'matched';
    for (const sample of samples.filter(sample => sample.cellId === 'source')) {
      const report = reportFor(sample); sourceReport(report, context);
      sample.sourceFacet = context.contract;
      sample.lifecycle.outcome = 'nonzero_exit'; sample.lifecycle.exitCode = 3;
      resave(sample, report); sourceArtifacts(sample);
    }
    for (let repetition = 1; repetition <= 3; repetition++) {
      const pair = samples.filter(sample => sample.cellId === 'source' && sample.repetition === repetition);
      materialReview(pair.find(sample => sample.side === 'base')!, pair.find(sample => sample.side === 'candidate')!);
    }
  }
  save();
  return {benchmark, samples, reviews, save, resave, reportFor, materialReview, sourceArtifacts,
    score: (withReviews = true) => scoreLlmExecutionBenchmark({input: path.join(root, 'benchmark.json'),
      ...(withReviews ? {reviews: path.join(root, 'reviews.json')} : {}), output: path.join(root, `score-${++scoreOrdinal}.json`)})};
}

describe('saved LLM execution benchmark scoring', () => {
  let directory: string;
  beforeEach(() => {directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-score-'));});
  afterEach(() => {fs.rmSync(directory, {recursive: true, force: true});});

  it('keeps the source strict report and uncovered facet while deriving reviewed effective quality', () => {
    const test = fixture(directory, ['source']), before = test.samples.map(sample => fs.readFileSync(path.join(directory, sample.report), 'utf8'));
    const result = test.score(), cell = result.cells[0];
    expect(cell.performance.status).toBe('passed');
    expect(cell.samples[0]).toMatchObject({rawQuality: {status: 'incomplete', uncoveredFacetCount: 1},
      uncoveredFacets: ['source recommendation action semantics'], effectiveQuality: {status: 'passed'},
      facetCoverage: {status: 'covered'}, acceptanceBasis: 'automatic_and_independent_review'});
    expect(test.samples.every(sample => sample.lifecycle.outcome === 'nonzero_exit' && sample.lifecycle.exitCode === 3)).toBe(true);
    expect(test.samples.map(sample => fs.readFileSync(path.join(directory, sample.report), 'utf8'))).toEqual(before);
    test.reviews.sourceFacetReviews = []; test.save();
    expect(test.score().cells[0]).toMatchObject({qualityAdmission: 'inconclusive', performance: {status: 'inconclusive'}});
  });

  it.each(['exit1', 'signalAfterReceipt', 'cleanupFailed', 'fakeExit3', 'oldNonce', 'copiedReportHash',
    'receiptHash', 'fixtureHash', 'groundTruthHash', 'bodyHash', 'modelBinding', 'implementer',
    'missingItem', 'missingEvidence', 'wrongBodyPosition', 'unknownClaim', 'wrongSource', 'wrongGeneration', 'wrongReference', 'selfReported', 'duplicateReview',
    'extraFacet', 'badBaselineProof', 'wrongPermission', 'wrongA2Index'])(
    'does not admit a source sample with %s', change => {
      const test = fixture(directory, ['source']), sample = test.samples[0];
      const entry = test.reviews.sourceFacetReviews[0], review = JSON.parse(fs.readFileSync(path.join(directory, entry.evidencePath), 'utf8'));
      const receiptPath = sample.sourceFacetCollection.path;
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, receiptPath), 'utf8'));
      if (change === 'exit1') sample.lifecycle.exitCode = 1;
      if (change === 'signalAfterReceipt') sample.lifecycle.signal = 'SIGTERM';
      if (change === 'cleanupFailed') sample.lifecycle.cleanup = 'failed';
      if (change === 'fakeExit3') delete sample.sourceFacetCollection;
      if (change === 'oldNonce') receipt.nonce = 'f'.repeat(32);
      if (change === 'copiedReportHash') receipt.rawReportSha256 = test.samples[1].reportHash;
      if (change === 'receiptHash') sample.sourceFacetCollection.sha256 = 'f'.repeat(64);
      if (change === 'fixtureHash') review.bindings.sourceFixtureHash = 'f'.repeat(64);
      if (change === 'groundTruthHash') review.bindings.groundTruthHash = 'f'.repeat(64);
      if (change === 'bodyHash') review.bindings.bodyFingerprint = 'f'.repeat(64);
      if (change === 'modelBinding') review.bindings.modelHash = 'f'.repeat(64);
      if (change === 'implementer') review.reviewer.independentOfImplementation = false;
      if (change === 'missingItem') review.items.pop();
      if (change === 'missingEvidence') review.items[2].evidence = [];
      if (change === 'wrongBodyPosition') review.items[2].evidence[0].body.start = 1;
      if (change === 'unknownClaim') review.items[2].evidence[0].claimIds = ['nonexistent'];
      if (change === 'wrongSource') review.items[2].evidence[0].source.filePath = '../../other.kt';
      if (change === 'wrongGeneration') review.items[2].evidence[0].source.sourceGeneration = 'foreign-generation';
      if (change === 'wrongReference') review.items[2].evidence[0].source.referenceId = 'source-ref-v1-unread';
      if (change === 'selfReported') {delete review.items; review.passed = true;}
      if (change === 'duplicateReview') test.reviews.sourceFacetReviews.push({...entry});
      if (change === 'oldNonce' || change === 'copiedReportHash') {
        sample.sourceFacetCollection.sha256 = write(directory, receiptPath, receipt);
        review.bindings.collectionReceiptSha256 = sample.sourceFacetCollection.sha256;
      }
      if (['extraFacet', 'badBaselineProof', 'wrongPermission', 'wrongA2Index'].includes(change)) {
        const report = test.reportFor(sample);
        if (change === 'extraFacet') report.uncoveredFacets.push('uncovered value');
        if (change === 'badBaselineProof') report.checkGroups.proof.proved = false;
        if (change === 'wrongPermission') report.analysisContext.codeAwareMode = 'off';
        if (change === 'wrongA2Index') report.analysisContext.setup.codebases[0].activeIndexState = 'active';
        test.resave(sample, report);
        // Even refreshing outer byte hashes cannot create automatic A2 acceptance.
        receipt.rawReportSha256 = sample.reportHash;
        sample.sourceFacetCollection.sha256 = write(directory, receiptPath, receipt);
        review.bindings.rawReportSha256 = sample.reportHash;
        review.bindings.collectionReceiptSha256 = sample.sourceFacetCollection.sha256;
        const quality = buildLlmExecutionQuality(report);
        review.bindings.fullQualityFingerprint = quality.fingerprints.full;
      }
      entry.evidenceSha256 = write(directory, entry.evidencePath, review); test.resave(sample);
      const result = test.score();
      expect(result.cells[0].performance.status).toBe('inconclusive');
      expect(result.cells[0].qualityAdmission).toBe('inconclusive');
      expect(result.cells[0].performance).not.toHaveProperty('totalImprovement');
    });

  it.each(['move_marker', 'delete_policy_check', 'generic_async', 'actual_apk_overclaim', 'no_action'])(
    'retains an independent negative judgment of %s rather than blessing any review file', problem => {
      const test = fixture(directory, ['source']), sample = test.samples[1];
      const review = test.sourceArtifacts(sample);
      const verdict = problem === 'no_action' ? 'incomplete' : 'failed';
      review.items[2].verdict = verdict; review.items[2].rationale = `Independent rubric rejection: ${problem}`;
      review.verdict = verdict;
      test.sourceArtifacts(sample, review);
      const result = test.score();
      expect(result.cells[0].samples[1].facetCoverage?.status).toBe(verdict);
      expect(result.cells[0].qualityAdmission).toBe(verdict === 'failed' ? 'failed' : 'inconclusive');
      expect(result.cells[0].performance).not.toHaveProperty('totalImprovement');
    });

  it('allows a source-grounded rewrite only with individual facet evidence and separate material review', () => {
    const test = fixture(directory, ['source']), base = test.samples[0], candidate = test.samples[1];
    const report = test.reportFor(candidate);
    report.summary.terminalAnalysis.conclusion = report.summary.terminalAnalysis.conclusion.replace('Preload the policy', 'Cache the validated policy once');
    const terminal = report.summary.terminalAnalysis;
    terminal.conclusionContract.claims[1].id = 'mapped-policy';
    terminal.claimSupport[1].claimId = 'mapped-policy';
    terminal.claimVerificationResult.claimResults[1].claimId = 'mapped-policy';
    report.summary.analysisCompletedVerifiedSourceBindings[0].claimId = 'mapped-policy';
    test.resave(candidate, report); test.sourceArtifacts(candidate);
    expect(test.score().cells[0].pairs[0].quality?.reason).toBe('material_review_required');
    test.materialReview(base, candidate);
    expect(test.score().cells[0].performance.status).toBe('passed');
    test.reviews.materialReviews = []; test.save();
    test.materialReview(base, candidate, {verdict: 'regressed'});
    expect(test.score().cells[0]).toMatchObject({qualityAdmission: 'failed', performance: {status: 'failed'}});
  });

  it('makes complete maintained coverage scoreable without fabricating unreported usage or summing overlaps', () => {
    const test = fixture(directory, CELLS), result = test.score();
    expect(result.status).toBe('passed');
    expect(result.cells).toHaveLength(5);
    expect(result.cells[0].performance).toMatchObject({status: 'passed', baselineMedianMs: 10000, candidateMedianMs: 8000});
    expect(result.cells[0].samples[0].costs).toMatchObject({requestBodyBytes: {status: 'complete', observedBytes: 12000},
      phaseDurationsMs: {provider: 300}, costUsd: 'unavailable'});
    expect(result.cells[0].samples[0].costs?.providerUsage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('The selected interval');
  });

  it('does not call one selected cell full acceptance or fill missing pairs', () => {
    const test = fixture(directory), result = test.score();
    expect(result.status).toBe('inconclusive');
    expect(result.coverage.complete).toBe(false);
    expect(result.cells[0].performance.status).toBe('passed');
    test.samples.pop(); test.save();
    const incomplete = test.score();
    expect(incomplete.cells[0].performance.status).toBe('inconclusive');
    expect(incomplete.issues).toContain('sample_coverage_incomplete');
  });

  it.each(['synthetic', undefined])('refuses unproven measurement origin %s', measurementOrigin => {
    const test = fixture(directory);
    test.benchmark.measurementOrigin = measurementOrigin; test.save();
    const result = test.score();
    expect(result.cells[0].performance.status).toBe('inconclusive');
    expect(result.issues).toContain('real_provider_origin_unproven');
  });

  it.each([
    ['source', (s: Json, _r: Json) => {s.sourceFingerprint = '9'.repeat(64);}],
    ['config', (s: Json, _r: Json) => {s.configFingerprint = '9'.repeat(64);}],
    ['nonce', (_s: Json, r: Json) => {r.executionTarget.nonce = '9'.repeat(32);}],
    ['PID', (_s: Json, r: Json) => {r.executionTarget.processId++;}],
    ['model', (_s: Json, r: Json) => {r.executionMetrics.modelHash = hash('different-model');}],
    ['call model', (_s: Json, r: Json) => {r.executionMetrics.performance.modelCalls[0].modelHash = hash('different-model');}],
    ['provider', (_s: Json, r: Json) => {r.executionMetrics.performance.modelCalls[0].providerOriginHash = hash('https://other.test');}],
    ['snapshot', (_s: Json, r: Json) => {delete r.executionMetrics.providerSnapshotHash;}],
    ['processor', (_s: Json, r: Json) => {r.runIdentity.traceProcessorVersion = 'unknown:identity_resolution_failed';}],
    ['cleanup', (s: Json, _r: Json) => {s.lifecycle.cleanup = 'failed';}],
    ['failureCode', (s: Json, _r: Json) => {s.failureCode = 'benchmark_source_changed';}],
  ] as const)('does not admit a %s mismatch', (_name, mutate) => {
    const test = fixture(directory), sample = test.samples[1], report = test.reportFor(sample);
    mutate(sample, report); test.resave(sample, report);
    const result = test.score();
    expect(result.cells[0].performance.status).toBe('inconclusive');
    expect(result.cells[0].pairs[0].issues.length).toBeGreaterThan(0);
  });

  it.each(['answer_turn', 'classification'])('requires the provider origin on every %s call, even when another call is identified', missingPurpose => {
    const test = fixture(directory), sample = test.samples[1], report = test.reportFor(sample);
    const main = report.executionMetrics.performance.modelCalls[0];
    report.executionMetrics.performance.modelCalls = [{...main, purpose: 'classification', durationMs: 100}, main];
    test.resave(sample, report);
    expect(test.score().cells[0].performance.status).toBe('passed');
    delete report.executionMetrics.performance.modelCalls.find((call: Json) => call.purpose === missingPurpose).providerOriginHash;
    test.resave(sample, report);
    const cell = test.score().cells[0];
    expect(cell.performance.status).toBe('inconclusive');
    expect(cell.pairs[0].issues).toContain('actual_provider_unproven');
  });

  it.each([1, '0', null])('keeps truncated or malformed model-call coverage inconclusive: %j', modelCalls => {
    const test = fixture(directory), sample = test.samples[1], report = test.reportFor(sample);
    report.executionMetrics.performance.truncated = {modelCalls: 0};
    test.resave(sample, report);
    expect(test.score().cells[0].performance.status).toBe('passed');
    report.executionMetrics.performance.truncated.modelCalls = modelCalls;
    test.resave(sample, report);
    const cell = test.score().cells[0];
    expect(cell.performance.status).toBe('inconclusive');
    expect(cell.pairs[0].issues).toContain('model_call_coverage_incomplete');
  });

  it('retains timed-out baselines and reports candidate absolute acceptance without a speedup', () => {
    const test = fixture(directory), sample = test.samples[0], report = test.reportFor(sample);
    report.errorCode = 'SSE_TIMEOUT'; report.completeAcceptance = false; report.semanticAcceptance = 'INCONCLUSIVE';
    delete report.summary; test.resave(sample, report);
    const result = test.score();
    expect(result.cells[0].performance.status).toBe('inconclusive');
    expect(result.cells[0].performance).not.toHaveProperty('totalImprovement');
    expect(result.cells[0].candidateAbsoluteAcceptance).toEqual({passed: 3, observed: 3, required: 3});
    expect(result.cells[0].samples[0].outcome).toBe('censored');
  });

  it.each([
    {outcome: 'nonzero_exit', exitCode: 1},
    {outcome: 'exited', exitCode: 1},
    {outcome: 'nonzero_exit', exitCode: 0},
    {outcome: 'exited', exitCode: -1},
  ])('does not let a passed report override an unsuccessful process receipt: %j', lifecycle => {
    const test = fixture(directory, CELLS);
    expect(test.score().status).toBe('passed');
    const sample = test.samples[1];
    Object.assign(sample.lifecycle, lifecycle); test.resave(sample);
    const result = test.score(), cell = result.cells[0];
    expect(result.status).toBe('inconclusive');
    expect(cell.performance.status).toBe('inconclusive');
    expect(cell.performance).not.toHaveProperty('totalImprovement');
    expect(cell.pairs[0].issues).toContain('lifecycle_unconfirmed');
    expect(cell.samples[1]).toMatchObject({quality: 'passed', outcome: 'failed'});
  });

  it('retains process cancellation as censored even when a completed report was written first', () => {
    const test = fixture(directory), sample = test.samples[1];
    Object.assign(sample.lifecycle, {outcome: 'cancelled', exitCode: null, signal: 'SIGTERM', censored: true});
    test.resave(sample);
    const cell = test.score().cells[0];
    expect(cell.performance.status).toBe('inconclusive');
    expect(cell.samples[1]).toMatchObject({quality: 'passed', outcome: 'censored'});
  });

  it('detects semantic mutation with unchanged counts and booleans, then consumes exact saved independent review', () => {
    const test = fixture(directory), base = test.samples[0], candidate = test.samples[1], report = test.reportFor(candidate);
    report.summary.terminalAnalysis.conclusionContract.claims[0].semantics.numeric.value = 34;
    test.resave(candidate, report);
    expect(test.score().cells[0].pairs[0].quality?.reason).toBe('material_review_required');
    test.materialReview(base, candidate, {verdict: 'regressed'});
    expect(test.score().cells[0].qualityAdmission).toBe('failed');
  });

  it('permits a reviewed rewrite but refuses stale, self-attested or edited review evidence', () => {
    const test = fixture(directory), base = test.samples[0], candidate = test.samples[1], report = test.reportFor(candidate);
    report.summary.terminalAnalysis.conclusion = 'This selected interval lasts 33 ms.';
    test.resave(candidate, report); test.materialReview(base, candidate);
    expect(test.score().cells[0].qualityAdmission).toBe('passed');
    const entry = test.reviews.materialReviews[0], file = path.join(directory, entry.evidencePath);
    const review = JSON.parse(fs.readFileSync(file, 'utf8'));
    review.candidateReportSha256 = '0'.repeat(64);
    entry.evidenceSha256 = write(directory, entry.evidencePath, review); test.save();
    expect(test.score().cells[0].pairs[0].quality?.reason).toBe('material_review_required');
    review.candidateReportSha256 = candidate.reportHash; review.reviewer.independentOfImplementation = false;
    entry.evidenceSha256 = write(directory, entry.evidencePath, review); test.save();
    expect(test.score().issues).toContain('review_evidence_invalid');
    fs.appendFileSync(file, 'changed after receipt');
    expect(test.score().cells[0].performance.status).toBe('inconclusive');
  });

  it('does not infer observer equivalence from a declared hash alone', () => {
    const test = fixture(directory);
    expect(test.score(false).cells[0].pairs[0].issues).toContain('observer_review_required');
    fs.appendFileSync(path.join(directory, 'reviews/observer.json'), ' ');
    expect(test.score().issues).toContain('review_evidence_invalid');
  });

  it('rejects cross-run report reuse and a replaced report even if its neighboring pass field says success', () => {
    const test = fixture(directory), first = test.samples[0], other = test.samples[2], report = test.reportFor(other);
    report.executionMetrics.runId = test.reportFor(first).executionMetrics.runId;
    report.executionTarget.runId = report.executionMetrics.runId;
    test.resave(other, report);
    expect(test.score().cells[0].pairs[1].issues).toContain('session_not_fresh');
    fs.appendFileSync(path.join(directory, first.report), ' ');
    expect(test.score().cells[0].pairs[0].issues).toContain('report_hash_mismatch');
  });

  it('enforces artifact read/write boundaries, exclusive output and no symlink descendants', () => {
    const test = fixture(directory), sample = test.samples[0];
    sample.report = '../foreign.json'; test.resave(sample);
    expect(test.score().cells[0].pairs[0].issues).toContain('llm_score_path_invalid');
    const file = path.join(directory, 'existing.json'); fs.writeFileSync(file, 'keep');
    expect(() => scoreLlmExecutionBenchmark({input: path.join(directory, 'benchmark.json'), output: file})).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
    expect(() => scoreLlmExecutionBenchmark({input: path.join(directory, 'benchmark.json'), output: path.join(directory, '../escape.json')}))
      .toThrow('llm_score_path_invalid');
    fs.mkdirSync(path.join(directory, 'actual'));
    fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'redirect'));
    expect(() => scoreLlmExecutionBenchmark({input: path.join(directory, 'benchmark.json'), output: path.join(directory, 'redirect/result.json')}))
      .toThrow('llm_score_path_invalid');
    fs.symlinkSync(directory, path.join(directory, 'root-redirect'));
    expect(() => scoreLlmExecutionBenchmark({input: path.join(directory, 'benchmark.json'), output: path.join(directory, 'root-redirect/result.json')}))
      .toThrow('llm_score_path_invalid');
  });

  it('accepts platform root aliases and canonical paths in either direction without changing the output boundary', () => {
    fixture(directory);
    const canonical = fs.realpathSync(directory);
    // macOS exposes the same temporary tree through /var and /private/var.
    const alias = process.platform === 'darwin' ? canonical.replace(/^\/private(?=\/(?:var|tmp)\/)/, '') : directory;
    expect(fs.realpathSync(alias)).toBe(canonical);
    for (const [index, inputRoot, outputRoot] of [[1, alias, canonical], [2, canonical, alias]] as const) {
      const output = path.join(outputRoot, `nested-${index}`, 'score.json');
      const result = scoreLlmExecutionBenchmark({input: path.join(inputRoot, 'benchmark.json'),
        reviews: path.join(inputRoot, 'reviews.json'), output});
      expect(result.cells[0].performance.status).toBe('passed');
      expect(fs.existsSync(path.join(canonical, `nested-${index}`, 'score.json'))).toBe(true);
      expect(() => scoreLlmExecutionBenchmark({input: path.join(inputRoot, 'benchmark.json'), output}))
        .toThrow('llm_score_output_unavailable');
    }
  });

  it('reports unobserved wire and partial token data without replacing them with zero', () => {
    const test = fixture(directory), sample = test.samples[1], report = test.reportFor(sample);
    report.executionMetrics.performance.modelRequests[0].body = {status: 'body_unobservable'};
    report.executionMetrics.performance.modelCalls[0].usage = {inputTokens: 100};
    test.resave(sample, report);
    const result = test.score(), costs = result.cells[0].samples[1].costs!;
    expect(result.cells[0].performance.status).toBe('passed');
    expect(costs.requestBodyBytes).toEqual({status: 'partial'});
    expect(costs.providerUsage).toEqual({inputTokens: 100});
  });

  it('keeps malformed stored input out of error output and rejects arbitrary CLI options', () => {
    fs.writeFileSync(path.join(directory, 'private.json'), '{"PRIVATE_CANARY":');
    expect(() => scoreLlmExecutionBenchmark({input: path.join(directory, 'private.json'), output: path.join(directory, 'out.json')}))
      .toThrow('llm_score_file_unreadable');
    expect(parseLlmExecutionScoreArgs(['--help'])).toEqual({help: true});
    expect(parseLlmExecutionScoreArgs(['--input', 'a', '--output', 'b'])).toEqual({input: 'a', output: 'b'});
    expect(() => parseLlmExecutionScoreArgs(['--input', 'a', '--output', 'b', '--target-phase', 'provider'])).toThrow();
    expect(() => parseLlmExecutionScoreArgs(['--input', 'a', '--input', 'b', '--output', 'c'])).toThrow();
  });
});


function syntheticPurposeContracts(common: {baseURL: string; protocol: string; model: string; lightModel: string; maxOutputTokens?: number; [key: string]: unknown}) {
  const sdk = {packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'};
  const limit = (value: number | undefined) => value === undefined ? {status: 'absent'}
    : {status: 'explicit', field: 'max_tokens', valueCommitment: canonicalContentHash(['number', String(value)])};
  return {schemaVersion: 'llm_purpose_controls@1', classification: {commonConfig: buildRuntimeConfigCommitments({...common, sdk}),
    tokenLimit: limit(Math.min(common.maxOutputTokens ?? 2048, 2048))}, review: {
    commonConfig: buildRuntimeConfigCommitments({baseURL: common.baseURL, protocol: common.protocol, lightModel: common.model,
      ...(common.maxOutputTokens === undefined ? {} : {maxOutputTokens: common.maxOutputTokens}), runtime: 'openai-agents-sdk', sdk}),
    tokenLimit: limit(common.maxOutputTokens)}};
}

/** Synthetic reader fixtures only: these never constitute real benchmark evidence. */
function treatmentScoreFixture(root: string, cells = ['scheduler'], configured: {maxOutputTokens?: number} = {maxOutputTokens: 4096},
  treatmentId: string = sourceLifecycle.TREATMENT_ID) {
  const mixed = treatmentId === sourceLifecycle.MIXED_CONTENT_TREATMENT_ID;
  const identity = OPENAI_TYPED_FINAL_CONTRACTS[mixed ? 'openai_typed_final_admission@3' : 'openai_typed_final_admission@2'];
  const {wireVersion: _wireVersion, ...historicalIdentity} = identity;
  const {maxOutputTokens} = configured;
  const data = fixture(root, cells);
  const sdk = {agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', identity: 'matched' as const};
  const common = {model: MODEL, lightModel: MODEL, baseURL: 'https://api.deepseek.com/v1', protocol: 'chat_completions',
    maxOutputTokens, maxTurns: 100, runtime: 'openai-agents-sdk', sdk};
  const materials = Object.fromEntries(['base', 'candidate'].map(side => [side, {configuration: {provider: 'deepseek',
    model: MODEL, lightModel: MODEL, baseUrl: 'https://api.deepseek.com/v1'}, runtime: 'openai-agents-sdk', timeoutMs: 1200000,
    environment: {SMARTPERFETTO_FINAL_SUBMISSION: sourceLifecycle.TREATMENT_OUTPUTS[side].finalSubmission,
      SMARTPERFETTO_CONCLUSION_AUTHORING: sourceLifecycle.TREATMENT_OUTPUTS[side].declarationSyntax,
      ...(maxOutputTokens === undefined ? {} : {OPENAI_MAX_OUTPUT_TOKENS: String(maxOutputTokens)})}}]));
  const aligned = sourceLifecycle.alignConfigCommitments(sourceLifecycle.buildConfigCommitments(materials.base), sourceLifecycle.buildConfigCommitments(materials.candidate));
  const configurations: Json = Object.fromEntries(['base', 'candidate'].map((side, index) => [side,
    sourceLifecycle.makeConfigCommitments(aligned[index], hash(stableStringify(materials[side])))]));
  const treatment = sourceLifecycle.makeRepresentationTreatment(configurations.base, configurations.candidate, treatmentId);
  Object.assign(data.benchmark, {schemaVersion: 'llm_execution_benchmark@2', candidate: treatmentId,
    nodeVersion: process.versions.node, treatment, preflights: []});
  const initial = new Set<string>();
  for (const sample of data.benchmark.samples) {
    const report = data.reportFor(sample), side = sample.side, configuration = configurations[side];
    const output = sourceLifecycle.TREATMENT_OUTPUTS[side];
    const nativeCandidate = {runId: report.executionMetrics.runId, attemptId: `attempt-${sample.repetition}-${side}`,
      candidateRef: `candidate-${sample.repetition}-${side}`, conclusionFingerprint: hash(report.summary.terminalAnalysis.conclusion)};
    const nativeKey = hash(JSON.stringify(nativeCandidate));
    report.summary.terminalAnalysis.completion = {schemaVersion: 1, runtimeKind: 'openai-agents-sdk', ...nativeCandidate, status: 'completed', sdkFinishReason: side === 'base' ? 'stop' : 'tool_calls'};
    const profiles = [];
    if (side === 'candidate') {
      const profile = resolveModelExecutionProfile({runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', modelId: MODEL,
        baseUrl: common.baseURL, sdk: {packageName: '@openai/agents-openai', version: '0.13.0', adapterContractVersion: identity.admissionVersion},
        sdkCapabilities: {surface: 'none', thinking: 'unknown', reasoningRoundtrip: 'unknown', source: 'contract_test'},
        effective: {maxOutputTokens, maxTurns: 100}});
      const {fingerprint: _fingerprint, ...facts} = profile;
      const body = {...facts, effective: {...output, ...(maxOutputTokens === undefined ? {} : {maxOutputTokens}), maxTurns: 100}};
      profiles.push(buildRuntimeExecutionProfileObservation({...body, fingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: `sha256:${hash(JSON.stringify(body))}`}},
        {role: 'typed_admission', purpose: 'answer_turn'})!);
    }
    const controls = buildRuntimeAppliedModelControls({requestedOutput: output, commonConfig: common,
      appliedSettings: {...(maxOutputTokens === undefined ? {} : {maxTokens: maxOutputTokens}), parallelToolCalls: false, store: false}, profiles})!;
    const recorder = createRuntimePerformanceRecorder({now: () => 100});
    const attemptKey = hash(nativeCandidate.attemptId), logicalCallKey = hash(`${sample.pairId}-${side}-call`);
    recorder.recordFinalTransportEvent({kind: 'main_dispatch', attemptKey, logicalCallKey, purpose: 'answer_turn',
      configuredModelHash: hash(MODEL), providerOriginHash: hash(ORIGIN), controls});
    const terminal = side === 'base' ? recorder.recordFinalTransportEvent({kind: 'native_terminal', fact: {attemptKey, logicalCallKey,
      response: {status: 'observed', hash: hash('native-response')}, actualModel: {status: 'observed', hash: hash(MODEL)},
      nativeStatus: 'completed', finish: 'stop', rawMaterial: {status: 'observed', hash: nativeCandidate.conclusionFingerprint},
      nativeContract: 'openai_native_completion_observer@1', sdkStreamCompleted: true}, drainStatus: 'fulfilled'})!
      : recorder.recordFinalTransportEvent({kind: 'typed_issued_after_drain', attemptKey, logicalCallKey,
        responseKey: hash('native-response'), callKey: hash('native-call'), actualModel: {status: 'observed', hash: hash(MODEL)},
        nativeStatus: 'completed', drainStatus: 'fulfilled', nativeBodyHash: nativeCandidate.conclusionFingerprint,
        ...(mixed ? identity : historicalIdentity)})!;
    const retained = recorder.recordFinalTransportEvent({kind: 'candidate_retained', nativeCandidateKey: nativeKey,
      carrier: side === 'base' ? 'assistant_text' : 'model_tool_arguments', transform: 'native',
      authors: [{role: 'body_and_declaration', terminalEventKey: terminal}], declaredBody: 'present', declaredClaims: 'present', productStatus: 'completed'})!;
    recorder.recordFinalTransportEvent({kind: 'finalizer_selected', retainedEventKey: retained, nativeCandidateKey: nativeKey,
      displayCandidateKey: nativeKey, canonicalSourceCandidateKey: nativeKey, canonicalCandidateKey: nativeKey, productStatus: 'completed'});
    report.executionMetrics.performance.finalTransportObservation = recorder.seal().finalTransportObservation;
    report.executionMetrics.requestedOutputConfig = output;
    Object.assign(sample, {schemaVersion: 'llm_execution_sample@2', configuration,
      configFingerprint: configuration.legacyConfigFingerprint, treatmentHash: hash(stableStringify(treatment)), preflights: []});
    const probe = (directory: string, initialProbe = false) => {
      const request = {schemaVersion: 'llm_target_preflight_request@1', nonce: sample.nonce, side, cellId: sample.cellId,
        requestedMode: 'auto', expectedSourceFingerprint: sample.sourceFingerprint, declaredConfig: configuration, treatmentHash: sample.treatmentHash};
      const result = {schemaVersion: mixed ? 'llm_target_preflight@3' : 'llm_target_preflight@2',
        ...(mixed ? {outputImplementation: side === 'base' ? OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION : {kind: 'typed', ...identity}} : {}), nonce: sample.nonce, side, cellId: sample.cellId,
        requestedMode: 'auto', observedSourceFingerprint: sample.sourceFingerprint, declaredConfigFingerprint: configuration.fullFingerprint,
        declaredControlsFingerprint: configuration.controlsFingerprint, declaredTreatmentHash: sample.treatmentHash, status: 'ready',
        capturedOutput: output, actualResolvedConfig: buildRuntimeConfigCommitments({...common, outputConfig: output}),
        purposeContracts: syntheticPurposeContracts(common), sdk: {...sdk, nodeVersion: process.versions.node}};
      const proof = {request: `${directory}/request.json`, requestHash: write(root, `${directory}/request.json`, request),
        receipt: `${directory}/receipt.json`, receiptHash: write(root, `${directory}/receipt.json`, result), side, cellId: sample.cellId, requestedMode: 'auto',
        lifecycle: {preparedAt: initialProbe ? 50000 : sample.reset.preparedAt - 20, settledAt: initialProbe ? 50010 : sample.reset.preparedAt - 10,
          processId: sample.lifecycle.processId + 1000, exitCode: 0, signal: null, outcome: 'exited', cleanup: 'confirmed', censored: false}};
      return proof;
    };
    const initialKey = `${sample.cellId}:${side}`;
    if (!initial.has(initialKey)) {data.benchmark.preflights.push(probe(`preflight/${sample.cellId}/${side}`, true)); initial.add(initialKey);}
    sample.preflights.push(probe(`${sample.pairId}/${side}/preflight-0`));
    Object.assign(report.executionTarget, {schemaVersion: 'llm_execution_target@2', declaredConfigFingerprint: configuration.legacyConfigFingerprint,
      declaredConfigFullFingerprint: configuration.fullFingerprint, declaredConfigControlsFingerprint: configuration.controlsFingerprint,
      declaredTreatmentHash: sample.treatmentHash, declaredPreflightFingerprint: hash(stableStringify(sample.preflights))});
    data.resave(sample, report);
  }
  data.save();
  return {...data, common};
}

function rehashTransport(report: Json) {
  const events = report.executionMetrics.performance.finalTransportObservation.events;
  const changed = new Map<string, string>();
  for (const event of events) {
    const oldKey = event.eventKey;
    for (const author of event.authors ?? []) author.terminalEventKey = changed.get(author.terminalEventKey) ?? author.terminalEventKey;
    if (event.retainedEventKey) event.retainedEventKey = changed.get(event.retainedEventKey) ?? event.retainedEventKey;
    const {eventKey: _eventKey, ...body} = event;
    event.eventKey = canonicalContentHash(body); changed.set(oldKey, event.eventKey);
  }
}

function addStageObservation(data: ReturnType<typeof treatmentScoreFixture>, sample: Json, purpose: 'classification' | 'review',
  modelSource: 'provider_reported' | 'configured' = 'provider_reported', capOverride?: number) {
  const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
  const sdk = {packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'};
  const cap = capOverride ?? (purpose === 'classification' ? Math.min(data.common.maxOutputTokens ?? 2048, 2048) : data.common.maxOutputTokens);
  const common = purpose === 'classification' ? {...data.common, sdk}
    : {baseURL: data.common.baseURL, protocol: 'chat_completions', lightModel: MODEL,
      ...(data.common.maxOutputTokens === undefined ? {} : {maxOutputTokens: data.common.maxOutputTokens}), runtime: 'openai-agents-sdk', sdk};
  const execution = resolveOpenAITextRequestPurpose({requestUrl: new URL('https://api.deepseek.com/v1/chat/completions'),
    protocol: 'chat_completions', model: MODEL, runtimeKind: 'openai-agents-sdk', purpose: purpose === 'review' ? 'final_semantic' : purpose,
    sdkIdentity: sdk, sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      reasoningRoundtrip: 'unknown', source: 'contract_test'},
    effective: {...(purpose === 'classification' ? {maxTurns: 100} : {}), maxOutputTokens: cap}});
  const controls = buildRuntimeAppliedModelControls({requestedOutput: sourceLifecycle.TREATMENT_OUTPUTS[sample.side], commonConfig: common,
    appliedSettings: {model: MODEL, temperature: 0, stream: true, ...execution.options, ...(cap === undefined ? {} : {max_tokens: cap})},
    profiles: [buildRuntimeExecutionProfileObservation(execution.profile, {role: 'stage_policy', purpose})!]})!;
  const event = {eventKey: hash(`stage-${purpose}-${sample.pairId}-${sample.side}`), sequence: 1, offsetMs: 0, kind: 'stage_dispatch',
    stageCallKey: hash(`stage-call-${purpose}-${sample.pairId}-${sample.side}`), purpose, configuredModelHash: hash(MODEL), providerOriginHash: hash(ORIGIN), controls};
  observation.events.unshift(event);
  observation.events.forEach((item: Json, index: number) => {item.sequence = index + 1;});
  report.executionMetrics.performance.modelCalls.unshift({purpose, modelHash: hash(MODEL), providerOriginHash: hash(ORIGIN),
    modelSource, startOffsetMs: 0, durationMs: 30, outcome: 'ok'});
  rehashTransport(report); data.resave(sample, report);
}

function bindSyntheticMaterialReviews(data: ReturnType<typeof treatmentScoreFixture>) {
  for (const pairId of new Set(data.samples.map(sample => sample.pairId))) {
    const pair = data.samples.filter(sample => sample.pairId === pairId);
    data.materialReview(pair.find(sample => sample.side === 'base')!, pair.find(sample => sample.side === 'candidate')!);
  }
}

describe('W0 versioned representation-treatment scoring', () => {
  let root: string;
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-treatment-score-'));});
  afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

  it('keeps the synthetic full-chain fixture inconclusive without independent material review', () => {
    const data = treatmentScoreFixture(root), result = data.score();
    expect(result.cells[0].pairs.map((pair: any) => pair.issues)).toEqual([[], [], []]);
    expect(result.cells[0].pairs.map((pair: any) => pair.quality)).toEqual(Array.from({length: 3}, () => ({status: 'inconclusive', reason: 'material_review_required'})));
    expect(result.cells[0].performance).toMatchObject({status: 'inconclusive', reason: 'incomplete_pair'});
    expect(result.status).toBe('inconclusive');
  });

  it('exercises a qualified cell with explicit bound synthetic reviews, without claiming real-provider or full-matrix acceptance', () => {
    const data = treatmentScoreFixture(root);
    for (let repetition = 1; repetition <= 3; repetition++) {
      const pair = data.samples.filter(sample => sample.repetition === repetition);
      data.materialReview(pair.find(sample => sample.side === 'base')!, pair.find(sample => sample.side === 'candidate')!);
    }
    const result = data.score();
    expect(result.cells[0].pairs.map((pair: any) => pair.issues)).toEqual([[], [], []]);
    expect(result.cells[0].performance.status).toBe('passed');
    expect(result.status).toBe('inconclusive'); // Synthetic reader exercise, one cell, not real-provider evidence.
  });

  it('does not let contradictory new implementation facts pass a legitimately rehashed historical probe', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'candidate')!;
    const proof = sample.preflights[0], filename = path.join(root, proof.receipt);
    const result = JSON.parse(fs.readFileSync(filename, 'utf8'));
    result.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
    proof.receiptHash = write(root, proof.receipt, result);
    const report = data.reportFor(sample);
    report.executionTarget.declaredPreflightFingerprint = hash(stableStringify(sample.preflights));
    data.resave(sample, report); bindSyntheticMaterialReviews(data);
    const score = data.score();
    expect(score.cells[0].performance.status).toBe('inconclusive');
    expect(score.cells[0].pairs.some((pair: Json) => pair.issues.some((issue: string) => issue.includes('preflight')))).toBe(true);
  });

  it('checks the complete mixed tuple/profile/probe chain as a synthetic reader exercise, not real performance admission', () => {
    const data = treatmentScoreFixture(root, ['scheduler'], {maxOutputTokens: 4096}, sourceLifecycle.MIXED_CONTENT_TREATMENT_ID);
    bindSyntheticMaterialReviews(data);
    const result = data.score();
    expect(result.cells[0].pairs.map((pair: Json) => pair.issues)).toEqual([[], [], []]);
    expect(result.cells[0].performance.status).toBe('passed');
    expect(result.status).toBe('inconclusive'); // One synthetic fixture cell, never a real-provider five-cell admission.
  });

  it.each(['missing_implementation', 'old_receipt', 'old_admission', 'wrong_wire', 'wrong_compiler', 'base_typed'])(
    'rejects independently rehashed mixed preflight implementation mutation: %s', mutation => {
      const data = treatmentScoreFixture(root, ['scheduler'], {maxOutputTokens: 4096}, sourceLifecycle.MIXED_CONTENT_TREATMENT_ID);
      const sample = data.samples.find(item => item.side === (mutation === 'base_typed' ? 'base' : 'candidate'))!;
      const proof = sample.preflights[0], report = data.reportFor(sample);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, proof.receipt), 'utf8'));
      if (mutation === 'missing_implementation') delete receipt.outputImplementation;
      if (mutation === 'old_receipt') {receipt.schemaVersion = 'llm_target_preflight@2'; delete receipt.outputImplementation;}
      if (mutation === 'old_admission') receipt.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@2']};
      if (mutation === 'wrong_wire') receipt.outputImplementation.wireVersion = 'openai_chat_final_wire@1';
      if (mutation === 'wrong_compiler') receipt.outputImplementation.compilerVersion = 'authored_claim_document_compiler@1';
      if (mutation === 'base_typed') receipt.outputImplementation = {kind: 'typed', ...OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3']};
      proof.receiptHash = write(root, proof.receipt, receipt);
      report.executionTarget.declaredPreflightFingerprint = hash(stableStringify(sample.preflights));
      data.resave(sample, report); bindSyntheticMaterialReviews(data);
      const result = data.score();
      expect(result.cells[0].performance.status).toBe('inconclusive');
      expect(result.cells[0].pairs.some((pair: Json) => pair.issues.includes('llm_score_preflight_implementation_unproven'))).toBe(true);
    });

  it.each(['old_admission', 'missing_wire', 'wrong_wire', 'wrong_compiler', 'profile_adapter'])(
    'rejects independently rehashed mixed native implementation mutation: %s', mutation => {
      const data = treatmentScoreFixture(root, ['scheduler'], {maxOutputTokens: 4096}, sourceLifecycle.MIXED_CONTENT_TREATMENT_ID);
      const sample = data.samples.find(item => item.side === 'candidate')!, report = data.reportFor(sample);
      const observation = report.executionMetrics.performance.finalTransportObservation;
      const issued = observation.events.find((event: Json) => event.kind === 'typed_issued_after_drain');
      if (mutation === 'old_admission') Object.assign(issued, OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@2']);
      if (mutation === 'missing_wire') delete issued.wireVersion;
      if (mutation === 'wrong_wire') issued.wireVersion = 'openai_chat_final_wire@1';
      if (mutation === 'wrong_compiler') issued.compilerVersion = 'authored_claim_document_compiler@1';
      if (mutation === 'profile_adapter') {
        const controls = observation.events[0].controls, profile = controls.profiles[0];
        profile.fields.find((row: Json) => row.field === '/sdk/adapterContractVersion').valueCommitment = canonicalContentHash(['string', 'openai_typed_final_admission@2']);
        profile.structureFingerprint = sourceLifecycle.configFieldsFingerprint(profile.fields);
        const {fullFingerprint: _full, ...body} = controls; controls.fullFingerprint = canonicalContentHash(body);
      }
      rehashTransport(report); data.resave(sample, report); bindSyntheticMaterialReviews(data);
      const result = data.score();
      expect(result.cells[0].performance.status).toBe('inconclusive');
      const expected = mutation === 'old_admission' ? 'typed_native_author_unproven' : mutation === 'profile_adapter'
        ? 'actual_profile_contract_unproven' : 'actual_transport_observation_unproven';
      expect(result.cells[0].pairs.some((pair: Json) => pair.issues.includes(expected))).toBe(true);
    });

  it('does not upgrade an old artifact by relabeling its treatment and rehashing all declared target bindings', () => {
    const data = treatmentScoreFixture(root);
    const baseline = data.samples.find(item => item.side === 'base')!, candidate = data.samples.find(item => item.side === 'candidate')!;
    const treatment = sourceLifecycle.makeRepresentationTreatment(baseline.configuration, candidate.configuration, sourceLifecycle.MIXED_CONTENT_TREATMENT_ID);
    data.benchmark.candidate = sourceLifecycle.MIXED_CONTENT_TREATMENT_ID; data.benchmark.treatment = treatment;
    for (const sample of data.samples) {
      sample.treatmentHash = hash(stableStringify(treatment));
      for (const proof of sample.preflights) {
        const request = JSON.parse(fs.readFileSync(path.join(root, proof.request), 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(path.join(root, proof.receipt), 'utf8'));
        request.treatmentHash = sample.treatmentHash; receipt.declaredTreatmentHash = sample.treatmentHash;
        proof.requestHash = write(root, proof.request, request); proof.receiptHash = write(root, proof.receipt, receipt);
      }
      const report = data.reportFor(sample); report.executionTarget.declaredTreatmentHash = sample.treatmentHash;
      report.executionTarget.declaredPreflightFingerprint = hash(stableStringify(sample.preflights)); data.resave(sample, report);
    }
    for (const proof of data.benchmark.preflights) {
      const request = JSON.parse(fs.readFileSync(path.join(root, proof.request), 'utf8'));
      const receipt = JSON.parse(fs.readFileSync(path.join(root, proof.receipt), 'utf8'));
      request.treatmentHash = hash(stableStringify(treatment)); receipt.declaredTreatmentHash = request.treatmentHash;
      proof.requestHash = write(root, proof.request, request); proof.receiptHash = write(root, proof.receipt, receipt);
    }
    data.save(); bindSyntheticMaterialReviews(data);
    const result = data.score();
    expect(result.cells[0].performance.status).toBe('inconclusive');
    expect(result.cells[0].pairs.every((pair: Json) => pair.issues.includes('llm_score_preflight_implementation_unproven'))).toBe(true);
  });

  it('checks real stage SDK profiles and permits fewer bounded reviews as an outcome, not a parameter exemption', () => {
    const data = treatmentScoreFixture(root);
    for (const sample of data.samples) addStageObservation(data, sample, 'classification');
    addStageObservation(data, data.samples.find(sample => sample.side === 'candidate')!, 'review');
    for (let repetition = 1; repetition <= 3; repetition++) {
      const pair = data.samples.filter(sample => sample.repetition === repetition);
      data.materialReview(pair.find(sample => sample.side === 'base')!, pair.find(sample => sample.side === 'candidate')!);
    }
    const result = data.score();
    expect(result.cells[0].pairs.map((pair: any) => pair.issues)).toEqual([[], [], []]);
    expect(result.cells[0].performance.status).toBe('passed');
    expect(result.status).toBe('inconclusive');
  });

  it('does not use a configured stage model as evidence of the actual provider model', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(sample => sample.side === 'candidate')!;
    addStageObservation(data, sample, 'classification', 'configured');
    const result = data.score();
    expect(result.cells[0].pairs[0].issues).toContain('stage_actual_model_source_unproven');
    expect(result.cells[0].performance.status).toBe('inconclusive');
  });

  it('rejects a one-sided review parameter mutation even after every observation hash is refreshed', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(sample => sample.side === 'candidate')!;
    addStageObservation(data, sample, 'review');
    const report = data.reportFor(sample), controls = report.executionMetrics.performance.finalTransportObservation.events[0].controls;
    controls.appliedSettings.find((row: Json) => row.field === '/temperature').valueCommitment = canonicalContentHash(['number', '0.8']);
    const {fullFingerprint: _full, ...body} = controls; controls.fullFingerprint = canonicalContentHash(body);
    rehashTransport(report); data.resave(sample, report);
    expect(data.score().cells[0].pairs[0].issues).toContain('actual_stage_settings_unproven');
  });

  it.each(['classification', 'review'] as const)('rejects a reported no-tool call without its actual stage controls: %s', purpose => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(sample => sample.side === 'candidate')!;
    addStageObservation(data, sample, purpose);
    const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
    observation.events = observation.events.filter((event: Json) => event.kind !== 'stage_dispatch');
    observation.events.forEach((event: Json, index: number) => {event.sequence = index + 1;});
    rehashTransport(report); data.resave(sample, report);
    for (let repetition = 1; repetition <= 3; repetition++) {
      const pair = data.samples.filter(item => item.repetition === repetition);
      data.materialReview(pair.find(item => item.side === 'base')!, pair.find(item => item.side === 'candidate')!);
    }
    const cell = data.score().cells[0];
    expect({status: cell.performance.status, issues: cell.pairs[0].issues}).toEqual({status: 'inconclusive',
      issues: expect.arrayContaining(['stage_controls_coverage_incomplete'])});
  });

  it('requires every logical no-tool call, not merely one same-purpose stage observation', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'candidate')!;
    addStageObservation(data, sample, 'classification');
    const report = data.reportFor(sample);
    report.executionMetrics.performance.modelCalls.unshift({...report.executionMetrics.performance.modelCalls[0]});
    data.resave(sample, report);
    expect(data.score().cells[0].pairs[0].issues).toContain('stage_controls_coverage_incomplete');
  });

  it('counts retries with one stageCallKey as one logical call and leaves absent purposes unexercised', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'candidate')!;
    addStageObservation(data, sample, 'classification');
    const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
    observation.events.splice(1, 0, {...observation.events[0], eventKey: hash('retry-event')});
    observation.events.forEach((event: Json, index: number) => {event.sequence = index + 1;});
    rehashTransport(report); data.resave(sample, report);
    expect(data.score().cells[0].pairs[0].issues).toEqual([]);
  });

  it.each(['opposite_side', 'other_cell'] as const)('rejects initial probes completed after any first paid sample: %s', location => {
    const data = treatmentScoreFixture(root, location === 'other_cell' ? ['scheduler', 'startup'] : ['scheduler']);
    const firstPaid = Math.min(...data.samples.map(sample => sample.lifecycle.preparedAt));
    const initial = data.benchmark.preflights.find((proof: Json) => proof.side === 'candidate' &&
      proof.cellId === (location === 'other_cell' ? 'startup' : 'scheduler'));
    initial.lifecycle.settledAt = firstPaid + 1;
    data.save(); bindSyntheticMaterialReviews(data);
    const result = data.score();
    expect({status: result.cells[0].performance.status, issues: result.issues}).toEqual({status: 'inconclusive',
      issues: expect.arrayContaining(['initial_preflight_not_before_first_sample'])});
  });

  it('accepts ordinary continuation with the production toolChoice none override while retaining every other control', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'base')!;
    const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
    const controls = buildRuntimeAppliedModelControls({requestedOutput: sourceLifecycle.TREATMENT_OUTPUTS.base, commonConfig: data.common,
      appliedSettings: {maxTokens: 4096, parallelToolCalls: false, store: false, toolChoice: 'none'}})!;
    observation.events.splice(2, 0, {eventKey: hash('ordinary-continuation'), sequence: 3, offsetMs: 0, kind: 'main_dispatch',
      attemptKey: hash('continuation-attempt'), logicalCallKey: hash('continuation-call'), purpose: 'continuation',
      configuredModelHash: hash(MODEL), providerOriginHash: hash(ORIGIN), controls});
    observation.events.forEach((event: Json, index: number) => {event.sequence = index + 1;});
    report.executionMetrics.performance.modelCalls.push({purpose: 'continuation', modelHash: hash(MODEL), providerOriginHash: hash(ORIGIN),
      startOffsetMs: 0, durationMs: 30, outcome: 'error'});
    rehashTransport(report); data.resave(sample, report); bindSyntheticMaterialReviews(data);
    const result = data.score();
    expect({status: result.cells[0].performance.status, issues: result.cells[0].pairs[0].issues}).toEqual({status: 'passed', issues: []});
    expect(result.status).toBe('inconclusive'); // Synthetic single-cell reader fixture remains non-admissible evidence.
  });

  it.each([{toolChoice: 'auto'}, {maxTokens: 99999}, {store: true}, {newBehavior: true}])(
    'rejects ordinary continuation control drift: %j', mutation => {
      const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'base')!;
      const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
      const controls = buildRuntimeAppliedModelControls({requestedOutput: sourceLifecycle.TREATMENT_OUTPUTS.base, commonConfig: data.common,
        appliedSettings: {maxTokens: 4096, parallelToolCalls: false, store: false, toolChoice: 'none', ...mutation}})!;
      observation.events.splice(2, 0, {eventKey: hash('changed-continuation'), sequence: 3, offsetMs: 0, kind: 'main_dispatch',
        attemptKey: hash('continuation-attempt'), logicalCallKey: hash('continuation-call'), purpose: 'continuation',
        configuredModelHash: hash(MODEL), providerOriginHash: hash(ORIGIN), controls});
      observation.events.forEach((event: Json, index: number) => {event.sequence = index + 1;});
      rehashTransport(report); data.resave(sample, report);
      expect(data.score().cells[0].pairs[0].issues).toContain('continuation_controls_unproven');
    });

  it('rejects a review cap deleted consistently from common config, profile and applied settings', () => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'candidate')!;
    addStageObservation(data, sample, 'review');
    const report = data.reportFor(sample), controls = report.executionMetrics.performance.finalTransportObservation.events[0].controls;
    const remove = (rows: Json[], path: string) => {
      const result = rows.filter(row => row.field !== path), parent = path.slice(0, path.lastIndexOf('/'));
      const keys = result.filter(row => row.field.startsWith(`${parent}/`) && !row.field.slice(parent.length + 1).includes('/'))
        .map(row => row.field.slice(parent.length + 1).replace(/~1/g, '/').replace(/~0/g, '~')).sort();
      result.find(row => row.field === parent)!.valueCommitment = canonicalContentHash(['object', keys]);
      return result;
    };
    controls.commonConfig = remove(controls.commonConfig, '/maxOutputTokens');
    controls.profiles[0].fields = remove(controls.profiles[0].fields, '/effective/maxOutputTokens');
    controls.profiles[0].structureFingerprint = sourceLifecycle.configFieldsFingerprint(controls.profiles[0].fields);
    controls.appliedSettings = remove(controls.appliedSettings, '/max_tokens');
    const {fullFingerprint: _full, ...body} = controls; controls.fullFingerprint = canonicalContentHash(body);
    rehashTransport(report); data.resave(sample, report); bindSyntheticMaterialReviews(data);
    const cell = data.score().cells[0];
    expect({status: cell.performance.status, issues: cell.pairs[0].issues}).toEqual({status: 'inconclusive',
      issues: expect.arrayContaining(['actual_common_controls_mismatch'])});
  });

  it.each([{configured: 4096, actual: 4096}, {configured: 1000, actual: 2048}])(
    'rejects a classifier cap that violates the production min formula: %j', ({configured, actual}) => {
      const data = treatmentScoreFixture(root, ['scheduler'], {maxOutputTokens: configured}), sample = data.samples.find(item => item.side === 'candidate')!;
      addStageObservation(data, sample, 'classification', 'provider_reported', actual);
      bindSyntheticMaterialReviews(data);
      const cell = data.score().cells[0];
      expect({status: cell.performance.status, issues: cell.pairs[0].issues}).toEqual({status: 'inconclusive',
        issues: expect.arrayContaining(['actual_profile_contract_unproven'])});
    });

  it.each([
    {label: 'absent', config: {}, expected: 2048},
    {label: 'larger configured cap', config: {maxOutputTokens: 4096}, expected: 2048},
    {label: 'smaller configured cap', config: {maxOutputTokens: 1000}, expected: 1000},
  ])('uses the exact trusted classifier cap: $label', ({config, expected}) => {
    const data = treatmentScoreFixture(root, ['scheduler'], config);
    for (const sample of data.samples) addStageObservation(data, sample, 'classification');
    addStageObservation(data, data.samples.find(item => item.side === 'candidate')!, 'review');
    const sample = data.samples.find(item => item.side === 'base')!, report = data.reportFor(sample);
    const stage = report.executionMetrics.performance.finalTransportObservation.events.find((event: Json) => event.kind === 'stage_dispatch');
    expect(stage.controls.appliedSettings.find((row: Json) => row.field === '/max_tokens').valueCommitment)
      .toBe(canonicalContentHash(['number', String(expected)]));
    bindSyntheticMaterialReviews(data);
    const result = data.score();
    expect(result.cells[0].pairs.map((pair: Json) => pair.issues)).toEqual([[], [], []]);
    expect(result.cells[0].performance.status).toBe('passed');
    expect(result.status).toBe('inconclusive');
  });

  it.each(['wrong_field', 'wrong_type', 'extra_field'])('rejects a malformed applied token limit against the trusted purpose contract: %s', mutation => {
    const data = treatmentScoreFixture(root), sample = data.samples.find(item => item.side === 'candidate')!;
    addStageObservation(data, sample, 'review');
    const report = data.reportFor(sample), controls = report.executionMetrics.performance.finalTransportObservation.events[0].controls;
    const row = controls.appliedSettings.find((row: Json) => row.field === '/max_tokens');
    if (mutation === 'wrong_type') {row.type = 'string'; row.valueCommitment = canonicalContentHash(['string', '4096']);}
    else {
      if (mutation === 'wrong_field') row.field = '/max_completion_tokens';
      else controls.appliedSettings.push({...row, field: '/max_output_tokens'});
      controls.appliedSettings.sort((a: Json, b: Json) => a.field < b.field ? -1 : a.field > b.field ? 1 : 0);
      const keys = controls.appliedSettings.filter((row: Json) => /^\/[^/]+$/.test(row.field)).map((row: Json) => row.field.slice(1)).sort();
      controls.appliedSettings[0].valueCommitment = canonicalContentHash(['object', keys]);
    }
    const {fullFingerprint: _full, ...body} = controls; controls.fullFingerprint = canonicalContentHash(body);
    rehashTransport(report); data.resave(sample, report);
    expect(data.score().cells[0].pairs[0].issues).toContain('actual_stage_settings_unproven');
  });

  it.each(['missing_contract', 'old_probe', 'node_version'])('rejects stale purpose/SDK preflight provenance: %s', mutation => {
    const data = treatmentScoreFixture(root), sample = data.samples[0], report = data.reportFor(sample), proof = sample.preflights[0];
    const receipt = JSON.parse(fs.readFileSync(path.join(root, proof.receipt), 'utf8'));
    if (mutation === 'missing_contract') delete receipt.purposeContracts;
    if (mutation === 'old_probe') receipt.schemaVersion = 'llm_target_preflight@1';
    if (mutation === 'node_version') receipt.sdk.nodeVersion = '1.0.0';
    proof.receiptHash = write(root, proof.receipt, receipt);
    report.executionTarget.declaredPreflightFingerprint = hash(stableStringify(sample.preflights));
    data.resave(sample, report);
    const result = data.score();
    expect(result.cells[0].pairs[0].issues.length).toBeGreaterThan(0);
    expect(result.cells[0].performance.status).toBe('inconclusive');
  });

  it.each(['requested_only', 'wrong_model', 'undrained', 'wrong_carrier', 'wrong_version', 'wrong_candidate', 'missing_author', 'truncated', 'profile_cap'])
    ('keeps independent actual-transport mutations inconclusive even when report quality still passes: %s', mutation => {
      const data = treatmentScoreFixture(root), sample = data.benchmark.samples.find((item: Json) => item.side === 'candidate');
      const report = data.reportFor(sample), observation = report.executionMetrics.performance.finalTransportObservation;
      const native = observation.events.find((event: Json) => event.kind === 'typed_issued_after_drain');
      const retained = observation.events.find((event: Json) => event.kind === 'candidate_retained');
      if (mutation === 'requested_only') delete report.executionMetrics.performance.finalTransportObservation;
      if (mutation === 'wrong_model') native.actualModel.hash = hash('wrong-model');
      if (mutation === 'undrained') native.drainStatus = 'rejected';
      if (mutation === 'wrong_carrier') retained.carrier = 'assistant_text';
      if (mutation === 'wrong_version') native.representationVersion = 'authored_claim_document@1';
      if (mutation === 'wrong_candidate') observation.events.find((event: Json) => event.kind === 'finalizer_selected').canonicalCandidateKey = hash('foreign');
      if (mutation === 'missing_author') retained.authors = [];
      if (mutation === 'truncated') observation.truncated = 1;
      if (mutation === 'profile_cap') {
        const controls = observation.events[0].controls;
        const row = controls.profiles[0].fields.find((row: Json) => row.field === '/effective/maxOutputTokens');
        row.valueCommitment = canonicalContentHash(['number', '999999']);
        controls.profiles[0].structureFingerprint = sourceLifecycle.configFieldsFingerprint(controls.profiles[0].fields);
        const {fullFingerprint: _full, ...body} = controls; controls.fullFingerprint = canonicalContentHash(body);
      }
      if (mutation !== 'requested_only') rehashTransport(report);
      data.resave(sample, report);
      const result = data.score();
      expect(result.cells[0].performance.status).toBe('inconclusive');
      expect(result.cells[0].pairs[0].issues.length).toBeGreaterThan(0);
    });

  it('refuses a stale preflight with self-consistent local hashes and preserves the failed baseline rule', () => {
    const data = treatmentScoreFixture(root), sample = data.benchmark.samples[0], report = data.reportFor(sample);
    const proof = sample.preflights[0], receipt = JSON.parse(fs.readFileSync(path.join(root, proof.receipt), 'utf8'));
    receipt.observedSourceFingerprint = hash('stale-source'); proof.receiptHash = write(root, proof.receipt, receipt);
    report.executionTarget.declaredPreflightFingerprint = hash(stableStringify(sample.preflights));
    data.resave(sample, report);
    expect(data.score().cells[0].performance.status).toBe('inconclusive');
  });
});
