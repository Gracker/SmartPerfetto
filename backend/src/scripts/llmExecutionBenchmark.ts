// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'node:crypto';
import {stableStringify} from '../utils/stableJson';

type QualityStatus = 'passed' | 'failed' | 'incomplete' | 'unavailable';
type CheckStatus = 'passed' | 'failed' | 'unavailable';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fingerprint = (value: unknown): string => createHash('sha256')
  .update(stableStringify({present: value !== undefined, value})).digest('hex');

export interface LlmExecutionQuality {
  schemaVersion: 'llm_execution_quality@1';
  /** Acceptance comes from the independent E2E oracle, never a model's assertion. */
  status: QualityStatus;
  groups: {value: CheckStatus; proof: CheckStatus; delivery: CheckStatus};
  hardGates: CheckStatus;
  /** Hashes detect changes; they do not judge the truth or equivalence of natural answers. */
  fingerprints: {body: string; contract: string; claims: string; proposals: string;
    investigation: string; source: string; identity: string; full: string};
  expectationHash?: string;
  uncoveredFacetCount?: number;
}

function checkStatus(value: unknown): CheckStatus {
  const entries = Object.values(object(value) ?? {});
  if (entries.length === 0 || entries.some(entry => typeof entry !== 'boolean')) return 'unavailable';
  return entries.every(entry => entry === true) ? 'passed' : 'failed';
}

/** Only the maintained verifier's output enters here, never provider tool/model output. */
export function buildLlmExecutionQuality(report: unknown): LlmExecutionQuality {
  const value = object(report) ?? {};
  const summary = object(value.summary);
  const terminal = object(summary?.terminalAnalysis);
  const contract = object(terminal?.conclusionContract);
  const checkGroups = object(value.checkGroups);
  const groups = {value: checkStatus(checkGroups?.value), proof: checkStatus(checkGroups?.proof),
    delivery: checkStatus(checkGroups?.delivery)};
  const hardGates = value.hardGatesPassed === true ? 'passed' : value.hardGatesPassed === false ? 'failed' : 'unavailable';
  const uncoveredFacetCount = Array.isArray(value.uncoveredFacets) ? value.uncoveredFacets.length : undefined;
  const identity = object(value.runIdentity);
  const expectationHash = typeof identity?.expectationHash === 'string' && /^[a-f0-9]{64}$/.test(identity.expectationHash)
    ? identity.expectationHash : undefined;
  const complete = value.completeAcceptance === true && value.semanticAcceptance === 'PASSED' &&
    value.proofAcceptance === 'PASSED' && hardGates === 'passed' &&
    Object.values(groups).every(group => group === 'passed') && uncoveredFacetCount === 0 && expectationHash !== undefined;
  const status: QualityStatus = !terminal || typeof terminal.conclusion !== 'string' ? 'unavailable'
    : complete ? 'passed' : groups.value === 'failed' || groups.delivery === 'failed' || hardGates === 'failed' ? 'failed' : 'incomplete';
  // Keep complete typed structures, including parser diagnostics and independent
  // asserted values. A selected list of reference IDs/counts would miss semantic changes.
  return {schemaVersion: 'llm_execution_quality@1', status, groups, hardGates,
    fingerprints: {
      body: fingerprint(terminal?.conclusion), contract: fingerprint(contract),
      claims: fingerprint(contract?.claims), proposals: fingerprint(contract?.relationProposals),
      investigation: fingerprint(terminal?.investigationAssessment),
      source: fingerprint({sourceUseDecision: terminal?.sourceUseDecision,
        sourceClaimBindings: contract?.sourceClaimBindings, sourceReferences: contract?.sourceReferences}),
      identity: fingerprint({intent: terminal?.turnIntent, assurance: terminal?.deliveryAssurance,
        claimVerificationResult: terminal?.claimVerificationResult, claimSupport: terminal?.claimSupport}),
      // Full delivered canonical payload also covers future semantic fields.
      // This is an internal hash, not a second authority or a source-content export.
      full: fingerprint({terminal, taskVerification: value.taskVerification, uncoveredFacets: value.uncoveredFacets}),
    }, ...(expectationHash ? {expectationHash} : {}),
    ...(uncoveredFacetCount === undefined ? {} : {uncoveredFacetCount})};
}

const {SOURCE_FACET} = require('../../scripts/llm-execution-lifecycle.cjs') as {
  SOURCE_FACET: {reviewSchema: string; rubricVersion: string; facetId: string; rubric: readonly string[]};
};

/** The fixed source action rubric is an independent saved judgment, never a model-declared pass. */
export function adjudicateLlmSourceFacet(input: {report: unknown; collectionEligible: boolean;
  review?: unknown; evidenceSha256?: string; bindings: Record<string, unknown>;
  sourceEvidence: {filePath: string; symbols: string[]; lineCount: number}}) {
  const rawQuality = buildLlmExecutionQuality(input.report);
  const report = object(input.report), terminal = object(object(report?.summary)?.terminalAnalysis);
  const body = terminal?.conclusion;
  const originalFacets = Array.isArray(report?.uncoveredFacets) ? report.uncoveredFacets : [];
  const result = (status: 'covered' | 'failed' | 'incomplete', reason: string) => ({rawQuality,
    uncoveredFacets: originalFacets,
    facetCoverage: {facetId: SOURCE_FACET.facetId, status, reason,
      ...(input.evidenceSha256 ? {evidenceSha256: input.evidenceSha256} : {})},
    effectiveQuality: {...rawQuality, ...(status === 'covered' ? {status: 'passed' as const, uncoveredFacetCount: 0}
      : status === 'failed' ? {status: 'failed' as const} : {})},
    acceptanceBasis: status === 'covered' ? 'automatic_and_independent_review' : 'raw_automatic_checks'});
  if (!input.collectionEligible || rawQuality.status !== 'incomplete' || rawQuality.hardGates !== 'passed' ||
      Object.values(rawQuality.groups).some(status => status !== 'passed') ||
      originalFacets.length !== 1 || originalFacets[0] !== SOURCE_FACET.facetId || typeof body !== 'string') {
    return result('incomplete', 'automatic_source_collection_unproven');
  }
  const review = object(input.review), reviewer = object(review?.reviewer);
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!review || !exactKeys(review, ['schemaVersion', 'rubricVersion', 'facetId', 'bindings', 'reviewer', 'rationale', 'verdict', 'items']) ||
      review.schemaVersion !== SOURCE_FACET.reviewSchema || review.rubricVersion !== SOURCE_FACET.rubricVersion ||
      review.facetId !== SOURCE_FACET.facetId || !reviewer ||
      !exactKeys(reviewer, ['kind', 'id', 'independentOfImplementation']) ||
      !['human', 'independent_agent'].includes(String(reviewer.kind)) || !nonempty(reviewer.id) ||
      reviewer.independentOfImplementation !== true || !nonempty(review.rationale) ||
      !/^[a-f0-9]{64}$/.test(input.evidenceSha256 ?? '') ||
      stableStringify(review.bindings) !== stableStringify(input.bindings) || !Array.isArray(review.items) ||
      review.items.length !== SOURCE_FACET.rubric.length) return result('incomplete', 'source_facet_review_required');
  const claims = object(terminal?.conclusionContract)?.claims;
  const claimIds = new Set(Array.isArray(claims) ? claims.map(claim => object(claim)?.id) : []);
  const sourceDecision = object(object(report?.summary)?.analysisCompletedSourceUseDecision) ??
    object(object(terminal?.conclusionContract)?.sourceUseDecision);
  const references = Array.isArray(sourceDecision?.references) ? sourceDecision.references.map(object) : [];
  const selected = object(report?.analysisContext)?.codebaseIds;
  const selectedCodebases = new Set(Array.isArray(selected) ? selected : []);
  const verified = object(report?.summary)?.analysisCompletedVerifiedSourceBindings;
  const sourceBindings = Array.isArray(verified) ? verified.map(object) : [];
  const seen = new Set<string>();
  const statuses: string[] = [];
  for (const itemValue of review.items) {
    const item = object(itemValue);
    if (!item || !exactKeys(item, ['id', 'verdict', 'rationale', 'evidence']) || typeof item.id !== 'string' ||
        !SOURCE_FACET.rubric.includes(item.id) || seen.has(item.id) || !nonempty(item.rationale) ||
        !['covered', 'failed', 'incomplete'].includes(String(item.verdict)) || !Array.isArray(item.evidence) ||
        item.evidence.length > 16 || item.verdict === 'covered' && item.evidence.length === 0) {
      return result('incomplete', 'source_facet_rubric_invalid');
    }
    seen.add(item.id); statuses.push(String(item.verdict));
    for (const evidenceValue of item.evidence) {
      const evidence = object(evidenceValue), position = object(evidence?.body), source = object(evidence?.source);
      const lines = object(source?.lineRange);
      const evidenceClaimIds = Array.isArray(evidence?.claimIds) ? evidence.claimIds : [];
      if (!evidence || !exactKeys(evidence, ['body', 'claimIds', 'source', 'reason']) || !nonempty(evidence.reason) ||
          !position || !exactKeys(position, ['start', 'end', 'sha256']) ||
          !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end) ||
          Number(position.start) < 0 || Number(position.end) <= Number(position.start) || Number(position.end) > body.length ||
          position.sha256 !== createHash('sha256').update(body.slice(Number(position.start), Number(position.end))).digest('hex') ||
          !Array.isArray(evidence.claimIds) || !evidence.claimIds.length ||
          new Set(evidence.claimIds).size !== evidence.claimIds.length || evidence.claimIds.some(id => !claimIds.has(id)) ||
          !source || !exactKeys(source, ['filePath', 'symbol', 'lineRange', 'referenceId', 'sourceGeneration']) ||
          source.filePath !== input.sourceEvidence.filePath || !input.sourceEvidence.symbols.includes(String(source.symbol)) ||
          !lines || !exactKeys(lines, ['start', 'end']) || !Number.isSafeInteger(lines.start) || !Number.isSafeInteger(lines.end) ||
          Number(lines.start) < 1 || Number(lines.end) < Number(lines.start) || Number(lines.end) > input.sourceEvidence.lineCount ||
          !references.some(reference => reference?.id === source.referenceId && selectedCodebases.has(reference?.codebaseId) &&
            (reference?.sourceGeneration ?? null) === source.sourceGeneration &&
            ['body', 'indexed'].includes(String(reference?.lookupKind)) &&
            typeof reference?.filePath === 'string' && input.sourceEvidence.filePath.endsWith(`/${reference.filePath}`) &&
            Number(object(reference.lineRange)?.start) <= Number(lines.start) && Number(object(reference.lineRange)?.end) >= Number(lines.end)) ||
          !sourceBindings.some(binding => ['trace_linked', 'source_only'].includes(String(binding?.status)) &&
            evidenceClaimIds.includes(binding?.claimId) && Array.isArray(binding?.sourceReferenceIds) &&
            binding.sourceReferenceIds.includes(source.referenceId))) {
        return result('incomplete', 'source_facet_evidence_invalid');
      }
    }
  }
  const verdict = statuses.includes('failed') ? 'failed' : statuses.includes('incomplete') ? 'incomplete' : 'covered';
  if (review.verdict !== verdict) return result('incomplete', 'source_facet_verdict_inconsistent');
  return result(verdict, verdict === 'covered' ? 'source_action_independently_covered' : 'source_action_not_covered');
}

export interface LlmMaterialChangeReview {
  schemaVersion: 'llm_execution_material_review@1';
  baselineFingerprint: string;
  candidateFingerprint: string;
  verdict: 'equivalent_or_improved' | 'regressed';
  /** Hash of the saved independent review evidence, not arbitrary text in a score. */
  evidenceSha256: string;
}

export function compareLlmExecutionQuality(baseline: LlmExecutionQuality, candidate: LlmExecutionQuality,
  review?: LlmMaterialChangeReview): {status: 'passed' | 'failed' | 'inconclusive';
    reason: 'candidate_failed' | 'candidate_incomplete' | 'baseline_incomplete' | 'expectation_mismatch' |
      'material_review_required' | 'material_regression' | 'quality_preserved'} {
  if (candidate.status === 'failed') return {status: 'failed', reason: 'candidate_failed'};
  if (candidate.status !== 'passed') return {status: 'inconclusive', reason: 'candidate_incomplete'};
  if (baseline.status !== 'passed') return {status: 'inconclusive', reason: 'baseline_incomplete'};
  if (!baseline.expectationHash || baseline.expectationHash !== candidate.expectationHash) {
    return {status: 'inconclusive', reason: 'expectation_mismatch'};
  }
  if (baseline.fingerprints.full !== candidate.fingerprints.full) {
    if (!review || review.schemaVersion !== 'llm_execution_material_review@1' ||
        review.baselineFingerprint !== baseline.fingerprints.full ||
        review.candidateFingerprint !== candidate.fingerprints.full || !/^[a-f0-9]{64}$/.test(review.evidenceSha256)) {
      return {status: 'inconclusive', reason: 'material_review_required'};
    }
    if (review.verdict === 'regressed') return {status: 'failed', reason: 'material_regression'};
    if (review.verdict !== 'equivalent_or_improved') return {status: 'inconclusive', reason: 'material_review_required'};
  }
  return {status: 'passed', reason: 'quality_preserved'};
}

/** Duration of the union, not the sum of overlapping instrumentation spans. */
export function elapsedIntervalUnion(spans: readonly {startOffsetMs: number; durationMs: number}[]): number | undefined {
  if (spans.length === 0 || spans.some(span => !Number.isFinite(span.startOffsetMs) || span.startOffsetMs < 0 ||
      !Number.isFinite(span.durationMs) || span.durationMs < 0 || !Number.isFinite(span.startOffsetMs + span.durationMs))) return undefined;
  const sorted = [...spans].sort((left, right) => left.startOffsetMs - right.startOffsetMs);
  let end = 0;
  let duration = 0;
  for (const span of sorted) {
    const nextEnd = span.startOffsetMs + span.durationMs;
    duration += Math.max(0, nextEnd - Math.max(end, span.startOffsetMs));
    end = Math.max(end, nextEnd);
  }
  return duration;
}

export interface LlmExecutionLatencyPair {
  pairId: string;
  /** Same provider/model/runtime/task/oracle/SDK configuration, excluding changed source. */
  comparisonFingerprint: string;
  sampleKind: 'real_provider' | 'synthetic';
  /** Lifecycle/pin/source validation must pass before this sample is scoreable. */
  lifecycle: 'matched' | 'inconclusive';
  quality: ReturnType<typeof compareLlmExecutionQuality>;
  baseline: {outcome: 'completed' | 'failed' | 'censored'; totalMs?: number; targetPhaseMs?: number};
  candidate: {outcome: 'completed' | 'failed' | 'censored'; totalMs?: number; targetPhaseMs?: number};
}

/** One provider/runtime/scenario/config cell only. Cross-model timing is not a code speedup. */
export function scoreLlmExecutionLatency(pairs: readonly LlmExecutionLatencyPair[]) {
  const incomplete = (reason: string) => ({status: 'inconclusive' as const, reason, sampleCount: pairs.length});
  if (pairs.length < 3 || new Set(pairs.map(pair => pair.pairId)).size !== pairs.length) return incomplete('insufficient_unique_pairs');
  if (pairs.some(pair => pair.sampleKind !== 'real_provider')) return incomplete('synthetic_not_admissible');
  if (!/^[a-f0-9]{64}$/.test(pairs[0].comparisonFingerprint) ||
      pairs.some(pair => pair.comparisonFingerprint !== pairs[0].comparisonFingerprint)) return incomplete('comparison_identity_mismatch');
  if (pairs.some(pair => pair.quality.status === 'failed')) return {status: 'failed' as const, reason: 'quality_regression', sampleCount: pairs.length};
  if (pairs.some(pair => pair.lifecycle !== 'matched' || pair.quality.status !== 'passed' ||
      pair.baseline.outcome !== 'completed' || pair.candidate.outcome !== 'completed')) return incomplete('incomplete_pair');
  const positive = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const baselineTimes = pairs.map(pair => pair.baseline.totalMs), candidateTimes = pairs.map(pair => pair.candidate.totalMs);
  if (!baselineTimes.every(positive) || !candidateTimes.every(positive)) return incomplete('total_latency_unavailable');
  const baselineMedianMs = median(baselineTimes), candidateMedianMs = median(candidateTimes);
  const totalImprovement = 1 - candidateMedianMs / baselineMedianMs;
  const phases = pairs.flatMap(pair => [pair.baseline.targetPhaseMs, pair.candidate.targetPhaseMs]);
  const targetPhaseImprovement = phases.every(positive)
    ? 1 - median(pairs.map(pair => pair.candidate.targetPhaseMs!)) / median(pairs.map(pair => pair.baseline.targetPhaseMs!)) : undefined;
  const materialRegression = candidateMedianMs > baselineMedianMs * 1.05 && candidateMedianMs - baselineMedianMs > 250;
  const passed = !materialRegression && (totalImprovement >= 0.15 || (targetPhaseImprovement ?? -Infinity) >= 0.30);
  return {status: passed ? 'passed' as const : 'failed' as const,
    reason: materialRegression ? 'material_total_regression' : passed ? 'threshold_met' : 'threshold_not_met',
    sampleCount: pairs.length, baselineMedianMs, candidateMedianMs, totalImprovement,
    ...(targetPhaseImprovement === undefined ? {} : {targetPhaseImprovement}), p95: 'inconclusive' as const};
}
