// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {adjudicateLlmSourceFacet, buildLlmExecutionQuality, compareLlmExecutionQuality, elapsedIntervalUnion, scoreLlmExecutionLatency,
  type LlmExecutionLatencyPair, type LlmMaterialChangeReview} from '../llmExecutionBenchmark';

function report() {
  return {completeAcceptance: true, semanticAcceptance: 'PASSED', proofAcceptance: 'PASSED', hardGatesPassed: true,
    checkGroups: {value: {oracle: true}, proof: {verified: true}, delivery: {completed: true}},
    uncoveredFacets: [], runIdentity: {expectationHash: 'a'.repeat(64)},
    taskVerification: {facts: {duration: {matched: true, proposition: 'supported'}}},
    summary: {terminalAnalysis: {conclusion: 'The selected interval is 33 ms.',
      completion: {status: 'completed'}, deliveryAssurance: {identity: 'passed'},
      conclusionContract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'The selected interval is 33 ms.'}], clusters: [], evidenceChain: [],
        uncertainties: [] as string[], nextSteps: [] as string[],
        claims: [{id: 'duration', text: 'The selected interval is 33 ms.', kind: 'numeric',
          references: [{evidenceRefId: 'ref-duration', rowIndex: 0, column: 'dur', value: 33000000}],
          semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
            discourse: 'asserted', quantifier: 'one', modality: 'certain', conditions: [] as string[],
            scope: {population: 'cited_rows', subjectRefs: [{evidenceRefId: 'ref-duration', rowIndex: 0, column: 'dur', value: 33000000}]},
            numeric: {operator: 'eq', value: 33, unit: 'ms'}}}],
        relationProposals: [{id: 'proposal:overlap', kind: 'overlap', direction: 'symmetric',
          subject: {evidenceRefId: 'ref-duration'}, object: {evidenceRefId: 'ref-other'}}],
        sourceClaimBindings: [{claimId: 'duration', sourceReferenceIds: ['source-a'], traceEvidenceRefIds: ['ref-duration']}]},
      investigationAssessment: {status: 'checked', requirements: [{id: 'thread_state', coverage: 'covered'}]},
      claimVerificationResult: {status: 'passed', checkedClaims: 1}}}};
}

describe('LLM execution quality, separate from latency', () => {
  it('requires a closed six-item source rubric and preserves raw fingerprints and incomplete automatic verdicts', () => {
    const {SOURCE_FACET} = require('../../../scripts/llm-execution-lifecycle.cjs');
    const {createHash} = require('node:crypto');
    const raw: any = report();
    raw.completeAcceptance = false; raw.semanticAcceptance = 'INCONCLUSIVE';
    raw.uncoveredFacets = [SOURCE_FACET.facetId];
    raw.analysisContext = {codebaseIds: ['source']};
    raw.summary.analysisCompletedVerifiedSourceBindings = [{claimId: 'duration', status: 'source_only', sourceReferenceIds: ['source-ref-v1-test']}];
    raw.summary.analysisCompletedSourceUseDecision = {references: [{id: 'source-ref-v1-test', codebaseId: 'source',
      filePath: 'StartupHooks.kt', lookupKind: 'body', lineRange: {start: 1, end: 47}}]};
    const body = raw.summary.terminalAnalysis.conclusion;
    const review: any = {schemaVersion: SOURCE_FACET.reviewSchema, rubricVersion: SOURCE_FACET.rubricVersion,
      facetId: SOURCE_FACET.facetId, bindings: {rawReportSha256: 'b'.repeat(64)},
      reviewer: {kind: 'human', id: 'independent-reviewer', independentOfImplementation: true}, rationale: 'Synthetic structural review.',
      verdict: 'covered', items: SOURCE_FACET.rubric.map((id: string) => ({id, verdict: 'covered', rationale: id,
        evidence: [{body: {start: 0, end: body.length, sha256: createHash('sha256').update(body).digest('hex')},
          claimIds: ['duration'], source: {filePath: 'backend/tests/e2e/context-fixtures/app/StartupHooks.kt',
            symbol: 'StartupHooks.initializeOnMainThread', referenceId: 'source-ref-v1-test', sourceGeneration: null,
            lineRange: {start: 17, end: 29}}, reason: 'Synthetic original position.'}]}))};
    const input = {report: raw, collectionEligible: true, review, evidenceSha256: 'c'.repeat(64), bindings: review.bindings,
      sourceEvidence: {filePath: 'backend/tests/e2e/context-fixtures/app/StartupHooks.kt', symbols: ['StartupHooks.initializeOnMainThread'], lineCount: 47}};
    const before = JSON.stringify(raw), passed = adjudicateLlmSourceFacet(input);
    expect(passed).toMatchObject({rawQuality: {status: 'incomplete'}, effectiveQuality: {status: 'passed'},
      acceptanceBasis: 'automatic_and_independent_review'});
    expect(passed.effectiveQuality.fingerprints).toEqual(passed.rawQuality.fingerprints);
    expect(JSON.stringify(raw)).toBe(before);
    expect(adjudicateLlmSourceFacet({...input, collectionEligible: false}).effectiveQuality.status).toBe('incomplete');
    for (const mutation of [
      (value: any) => {value.review.items.push(value.review.items[0]);},
      (value: any) => {value.review.items[1].id = value.review.items[0].id;},
      (value: any) => {value.review.passed = true;},
      (value: any) => {value.review.reviewer.independentOfImplementation = false;},
      (value: any) => {value.review.bindings.rawReportSha256 = 'd'.repeat(64);},
      (value: any) => {value.review.items[0].evidence[0].source.lineRange.end = 999;},
      (value: any) => {value.review.items[0].evidence[0].body.sha256 = 'd'.repeat(64);},
    ]) {
      const candidate = structuredClone(input);
      // Keep expected bindings independent of the review object's mutable claim.
      candidate.bindings = structuredClone(input.bindings);
      mutation(candidate);
      expect(adjudicateLlmSourceFacet(candidate).effectiveQuality.status).toBe('incomplete');
    }
    raw.checkGroups.proof.verified = false;
    expect(adjudicateLlmSourceFacet(input).effectiveQuality.status).not.toBe('passed');
  });

  it('requires independent complete oracle acceptance, not a successful response or matching failed baselines', () => {
    const input = report();
    const quality = buildLlmExecutionQuality(input);
    expect(quality.status).toBe('passed');
    expect(compareLlmExecutionQuality(quality, quality).status).toBe('passed');
    input.completeAcceptance = false;
    input.checkGroups.proof.verified = false;
    input.proofAcceptance = 'INCOMPLETE';
    const failedBaseline = buildLlmExecutionQuality(input);
    expect(compareLlmExecutionQuality(failedBaseline, failedBaseline)).toMatchObject({status: 'inconclusive'});
    expect(compareLlmExecutionQuality(failedBaseline, quality)).toEqual({status: 'inconclusive', reason: 'baseline_incomplete'});
    expect(buildLlmExecutionQuality({summary: {terminalAnalysis: {success: true, conclusion: 'OK'}}}).status).not.toBe('passed');
  });

  it.each([
    ['asserted number', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.numeric.value = 34;}],
    ['captured number', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].references[0].value = 34000000;}],
    ['unit', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.numeric.unit = 'ns';}],
    ['polarity', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.polarity = 'negated';}],
    ['quantifier', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.quantifier = 'all';}],
    ['modality', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.modality = 'possible';}],
    ['conditions', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.conditions.push('Only in this window');}],
    ['scope', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].semantics.scope.population = 'trace';}],
    ['text', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].text = 'A cause was proved.';}],
    ['kind', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.claims[0].kind = 'causal';}],
    ['relation direction', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.relationProposals[0].direction = 'object_to_subject';}],
    ['source', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.sourceClaimBindings[0].sourceReferenceIds[0] = 'wrong-source';}],
    ['obligation', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.investigationAssessment.requirements[0].coverage = 'missing';}],
    ['body', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusion = 'All intervals are always 33 ms.';}],
    ['uncertainty', (r: ReturnType<typeof report>) => {r.summary.terminalAnalysis.conclusionContract.uncertainties.push('Cause unknown');}],
  ] as const)('detects %s changes even with identical counts and gate booleans', (_name, mutate) => {
    const original = report(), changed = report();
    mutate(changed);
    const before = buildLlmExecutionQuality(original), after = buildLlmExecutionQuality(changed);
    expect(after.fingerprints.full).not.toBe(before.fingerprints.full);
    expect(compareLlmExecutionQuality(before, after)).toEqual({status: 'inconclusive', reason: 'material_review_required'});
  });

  it('requires a review bound to both artifacts, while allowing legitimate rewriting and run-local IDs', () => {
    const base = buildLlmExecutionQuality(report()), changed = report();
    changed.summary.terminalAnalysis.conclusion = 'This selected interval lasts 33 ms.';
    changed.summary.terminalAnalysis.conclusionContract.claims[0].references[0].evidenceRefId = 'new-run-ref';
    const candidate = buildLlmExecutionQuality(changed);
    const review: LlmMaterialChangeReview = {schemaVersion: 'llm_execution_material_review@1',
      baselineFingerprint: base.fingerprints.full, candidateFingerprint: candidate.fingerprints.full,
      verdict: 'equivalent_or_improved', evidenceSha256: 'b'.repeat(64)};
    expect(compareLlmExecutionQuality(base, candidate, review).status).toBe('passed');
    expect(compareLlmExecutionQuality(base, candidate, {...review, candidateFingerprint: 'c'.repeat(64)}).status).toBe('inconclusive');
    expect(compareLlmExecutionQuality(base, candidate, {...review, verdict: 'regressed'}).status).toBe('failed');
    expect(JSON.stringify(candidate)).not.toContain('This selected interval');
  });
});

function pairs(): LlmExecutionLatencyPair[] {
  return Array.from({length: 3}, (_, i) => ({pairId: String(i), comparisonFingerprint: 'd'.repeat(64), sampleKind: 'real_provider',
    lifecycle: 'matched', quality: {status: 'passed', reason: 'quality_preserved'},
    baseline: {outcome: 'completed', totalMs: 10000, targetPhaseMs: 5000},
    candidate: {outcome: 'completed', totalMs: 8000, targetPhaseMs: 4000}}));
}

describe('LLM execution latency scoring', () => {
  it('does not sum overlapping stages or fabricate unavailable timings', () => {
    expect(elapsedIntervalUnion([{startOffsetMs: 0, durationMs: 20}, {startOffsetMs: 5, durationMs: 20},
      {startOffsetMs: 30, durationMs: 10}])).toBe(35);
    expect(elapsedIntervalUnion([])).toBeUndefined();
    expect(elapsedIntervalUnion([{startOffsetMs: 0, durationMs: NaN}])).toBeUndefined();
  });

  it('scores observed latency without requiring unreported token cost, never claiming p95', () => {
    expect(scoreLlmExecutionLatency(pairs())).toMatchObject({status: 'passed', baselineMedianMs: 10000,
      candidateMedianMs: 8000, p95: 'inconclusive'});
    const phaseOnly = pairs().map(pair => ({...pair, candidate: {...pair.candidate, totalMs: 10000, targetPhaseMs: 3000}}));
    expect(scoreLlmExecutionLatency(phaseOnly).status).toBe('passed');
    expect(scoreLlmExecutionLatency(phaseOnly.map(pair => ({...pair, candidate: {...pair.candidate, totalMs: 11000}}))))
      .toMatchObject({status: 'failed', reason: 'material_total_regression'});
  });

  it('keeps failures/censored samples and refuses mixed providers, duplicate pairs and synthetic admission', () => {
    const failed = pairs(); failed[1].candidate.outcome = 'censored';
    expect(scoreLlmExecutionLatency(failed).status).toBe('inconclusive');
    failed[1].quality = {status: 'failed', reason: 'candidate_failed'};
    expect(scoreLlmExecutionLatency(failed).status).toBe('failed');
    const mixed = pairs(); mixed[1].comparisonFingerprint = 'e'.repeat(64);
    expect(scoreLlmExecutionLatency(mixed).status).toBe('inconclusive');
    expect(scoreLlmExecutionLatency([pairs()[0], pairs()[0], pairs()[0]]).status).toBe('inconclusive');
    expect(scoreLlmExecutionLatency(pairs().map(pair => ({...pair, sampleKind: 'synthetic'}))).status).toBe('inconclusive');
  });
});
