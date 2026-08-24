// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EvalAllowedGapV1,
  EvalCausalEdgeExpectationV1,
  EvalForbiddenClaimV1,
  EvalGroundTruthV1,
  EvalIdentityExpectationV1,
  EvalNumericExpectationV1,
  EvalRequiredEvidenceV1,
  EvalRequiredFactV1,
  EvalScalar,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';

export interface GoldenTraceObservationV1 {
  schemaVersion: 1;
  facts: Record<string, {
    value: EvalScalar;
    unit?: string;
    evidenceIds: string[];
  }>;
  evidence: string[];
  claims: Array<{
    text: string;
    supportLevel: 'verified' | 'partial' | 'inference' | 'unsupported';
  }>;
  gaps: Array<{code: string; missingEvidenceIds: string[]}>;
  identities: Record<string, EvalScalar>;
  causalEdges: Array<{
    subject: string;
    relation: string;
    object: string;
    level: 'correlation' | 'mechanism';
    verified: boolean;
  }>;
}

export type GoldenTraceScoreResult =
  | {status: 'inconclusive'; reason: 'ground_truth_missing'}
  | {
      status: 'scored';
      passed: boolean;
      blockers: string[];
      assertions: Array<{
        id: string;
        category:
          | 'required_fact'
          | 'numeric_expectation'
          | 'required_evidence'
          | 'forbidden_claim'
          | 'claim_support'
          | 'gap'
          | 'identity'
          | 'causal_edge';
        status: 'passed' | 'failed' | 'not_evaluable';
        blocker?: string;
      }>;
      summary: {
        evaluated: number;
        passed: number;
        failed: number;
        notEvaluable: number;
      };
      contentHash: string;
    };

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  error: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    throw new Error(error);
  }
}

function nonemptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function finiteNumber(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(error);
  }
  return value;
}

function nonnegativeNumber(value: unknown, error: string): number {
  const parsed = finiteNumber(value, error);
  if (parsed < 0) throw new Error(error);
  return parsed;
}

function scalar(value: unknown, error: string): EvalScalar {
  if (
    value !== null
    && typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
  ) {
    throw new Error(error);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(error);
  }
  return value;
}

function stringArray(
  value: unknown,
  error: string,
  options: {allowEmpty?: boolean} = {},
): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new Error(error);
  }
  const result = value.map(item => nonemptyString(item, error));
  if (new Set(result).size !== result.length) throw new Error(error);
  return result;
}

function parseRequiredFact(value: unknown): EvalRequiredFactV1 {
  const fact = record(value, 'eval_required_fact_invalid');
  exactKeys(
    fact,
    ['id', 'statement', 'evaluation', 'observationKey', 'expected'],
    'eval_required_fact_unknown_field',
  );
  if (fact.evaluation !== 'deterministic' && fact.evaluation !== 'semantic') {
    throw new Error('eval_required_fact_evaluation_invalid');
  }
  const base = {
    id: nonemptyString(fact.id, 'eval_required_fact_id_invalid'),
    statement: nonemptyString(
      fact.statement,
      'eval_required_fact_statement_invalid',
    ),
    evaluation: fact.evaluation,
  };
  if (fact.evaluation === 'deterministic') {
    if (fact.observationKey === undefined || fact.expected === undefined) {
      throw new Error('eval_required_fact_deterministic_binding_invalid');
    }
    return {
      ...base,
      evaluation: 'deterministic',
      observationKey: nonemptyString(
        fact.observationKey,
        'eval_required_fact_deterministic_binding_invalid',
      ),
      expected: scalar(
        fact.expected,
        'eval_required_fact_deterministic_binding_invalid',
      ),
    };
  }
  if (fact.observationKey !== undefined || fact.expected !== undefined) {
    throw new Error('eval_required_fact_semantic_binding_invalid');
  }
  return {...base, evaluation: 'semantic'};
}

function parseNumericExpectation(value: unknown): EvalNumericExpectationV1 {
  const expectation = record(value, 'eval_numeric_expectation_invalid');
  exactKeys(expectation, [
    'id',
    'observationKey',
    'expected',
    'unit',
    'absoluteTolerance',
    'relativeTolerance',
  ], 'eval_numeric_expectation_unknown_field');
  if (
    expectation.absoluteTolerance === undefined
    && expectation.relativeTolerance === undefined
  ) {
    throw new Error('eval_numeric_tolerance_required');
  }
  const absoluteTolerance = expectation.absoluteTolerance === undefined
    ? undefined
    : nonnegativeNumber(
      expectation.absoluteTolerance,
      'eval_numeric_absolute_tolerance_invalid',
    );
  const relativeTolerance = expectation.relativeTolerance === undefined
    ? undefined
    : nonnegativeNumber(
      expectation.relativeTolerance,
      'eval_numeric_relative_tolerance_invalid',
    );
  if (relativeTolerance !== undefined && relativeTolerance > 1) {
    throw new Error('eval_numeric_relative_tolerance_invalid');
  }
  return {
    id: nonemptyString(expectation.id, 'eval_numeric_id_invalid'),
    observationKey: nonemptyString(
      expectation.observationKey,
      'eval_numeric_observation_key_invalid',
    ),
    expected: finiteNumber(expectation.expected, 'eval_numeric_expected_invalid'),
    unit: nonemptyString(expectation.unit, 'eval_numeric_unit_invalid'),
    ...(absoluteTolerance === undefined ? {} : {absoluteTolerance}),
    ...(relativeTolerance === undefined ? {} : {relativeTolerance}),
  };
}

function parseRequiredEvidence(value: unknown): EvalRequiredEvidenceV1 {
  const evidence = record(value, 'eval_required_evidence_invalid');
  exactKeys(evidence, ['id', 'kind', 'locator'], 'eval_required_evidence_unknown_field');
  if (![
    'coverage_expectation',
    'evidence_ref',
    'skill',
    'sql',
    'relation',
  ].includes(String(evidence.kind))) {
    throw new Error('eval_required_evidence_kind_invalid');
  }
  return {
    id: nonemptyString(evidence.id, 'eval_required_evidence_id_invalid'),
    kind: evidence.kind as EvalRequiredEvidenceV1['kind'],
    locator: nonemptyString(
      evidence.locator,
      'eval_required_evidence_locator_invalid',
    ),
  };
}

function parseForbiddenClaim(value: unknown): EvalForbiddenClaimV1 {
  const claim = record(value, 'eval_forbidden_claim_invalid');
  exactKeys(claim, ['id', 'contains', 'reason'], 'eval_forbidden_claim_unknown_field');
  return {
    id: nonemptyString(claim.id, 'eval_forbidden_claim_id_invalid'),
    contains: stringArray(claim.contains, 'eval_forbidden_claim_contains_invalid'),
    reason: nonemptyString(claim.reason, 'eval_forbidden_claim_reason_invalid'),
  };
}

function parseAllowedGap(value: unknown): EvalAllowedGapV1 {
  const gap = record(value, 'eval_allowed_gap_invalid');
  exactKeys(
    gap,
    ['id', 'code', 'requiresMissingEvidence'],
    'eval_allowed_gap_unknown_field',
  );
  return {
    id: nonemptyString(gap.id, 'eval_allowed_gap_id_invalid'),
    code: nonemptyString(gap.code, 'eval_allowed_gap_code_invalid'),
    requiresMissingEvidence: stringArray(
      gap.requiresMissingEvidence,
      'eval_allowed_gap_missing_evidence_invalid',
      {allowEmpty: true},
    ),
  };
}

function parseIdentityExpectation(value: unknown): EvalIdentityExpectationV1 {
  const identity = record(value, 'eval_identity_expectation_invalid');
  exactKeys(
    identity,
    ['id', 'observationKey', 'expected'],
    'eval_identity_expectation_unknown_field',
  );
  if (identity.expected === undefined) {
    throw new Error('eval_identity_expected_invalid');
  }
  return {
    id: nonemptyString(identity.id, 'eval_identity_id_invalid'),
    observationKey: nonemptyString(
      identity.observationKey,
      'eval_identity_observation_key_invalid',
    ),
    expected: scalar(identity.expected, 'eval_identity_expected_invalid'),
  };
}

function parseCausalEdge(value: unknown): EvalCausalEdgeExpectationV1 {
  const edge = record(value, 'eval_causal_edge_invalid');
  exactKeys(edge, [
    'id',
    'subject',
    'relation',
    'object',
    'minimumLevel',
  ], 'eval_causal_edge_unknown_field');
  if (edge.minimumLevel !== 'correlation' && edge.minimumLevel !== 'mechanism') {
    throw new Error('eval_causal_edge_level_invalid');
  }
  return {
    id: nonemptyString(edge.id, 'eval_causal_edge_id_invalid'),
    subject: nonemptyString(edge.subject, 'eval_causal_edge_subject_invalid'),
    relation: nonemptyString(edge.relation, 'eval_causal_edge_relation_invalid'),
    object: nonemptyString(edge.object, 'eval_causal_edge_object_invalid'),
    minimumLevel: edge.minimumLevel,
  };
}

function parseArray<T>(
  value: unknown,
  error: string,
  parser: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(error);
  const result = value.map(parser);
  const ids = result.map(item => (item as {id: string}).id);
  if (new Set(ids).size !== ids.length) throw new Error(`${error}_duplicate_id`);
  return result;
}

export function parseEvalGroundTruth(value: unknown): EvalGroundTruthV1 {
  const groundTruth = record(value, 'eval_ground_truth_invalid');
  exactKeys(groundTruth, [
    'schemaVersion',
    'requiredFacts',
    'numericExpectations',
    'requiredEvidence',
    'forbiddenClaims',
    'allowedGaps',
    'identityExpectations',
    'causalEdges',
  ], 'eval_ground_truth_unknown_field');
  if (groundTruth.schemaVersion !== 1) {
    throw new Error('eval_ground_truth_schema_version_invalid');
  }
  const parsed: EvalGroundTruthV1 = {
    schemaVersion: 1,
    requiredFacts: parseArray(
      groundTruth.requiredFacts,
      'eval_required_facts_invalid',
      parseRequiredFact,
    ),
    numericExpectations: parseArray(
      groundTruth.numericExpectations,
      'eval_numeric_expectations_invalid',
      parseNumericExpectation,
    ),
    requiredEvidence: parseArray(
      groundTruth.requiredEvidence,
      'eval_required_evidence_list_invalid',
      parseRequiredEvidence,
    ),
    forbiddenClaims: parseArray(
      groundTruth.forbiddenClaims,
      'eval_forbidden_claims_invalid',
      parseForbiddenClaim,
    ),
    allowedGaps: parseArray(
      groundTruth.allowedGaps,
      'eval_allowed_gaps_invalid',
      parseAllowedGap,
    ),
    identityExpectations: parseArray(
      groundTruth.identityExpectations,
      'eval_identity_expectations_invalid',
      parseIdentityExpectation,
    ),
    causalEdges: parseArray(
      groundTruth.causalEdges,
      'eval_causal_edges_invalid',
      parseCausalEdge,
    ),
  };
  const allIds = [
    ...parsed.requiredFacts,
    ...parsed.numericExpectations,
    ...parsed.requiredEvidence,
    ...parsed.forbiddenClaims,
    ...parsed.allowedGaps,
    ...parsed.identityExpectations,
    ...parsed.causalEdges,
  ].map(item => item.id);
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('eval_ground_truth_duplicate_id');
  }
  if (
    new Set(parsed.requiredEvidence.map(item => item.locator)).size
      !== parsed.requiredEvidence.length
    || new Set(parsed.allowedGaps.map(item => item.code)).size
      !== parsed.allowedGaps.length
    || new Set(parsed.identityExpectations.map(item => item.observationKey)).size
      !== parsed.identityExpectations.length
  ) {
    throw new Error('eval_ground_truth_ambiguous_binding');
  }
  return immutableCanonicalSnapshot(parsed);
}

export function parseGoldenTraceObservation(
  value: unknown,
): GoldenTraceObservationV1 {
  const observation = record(value, 'golden_trace_observation_invalid');
  exactKeys(observation, [
    'schemaVersion',
    'facts',
    'evidence',
    'claims',
    'gaps',
    'identities',
    'causalEdges',
  ], 'golden_trace_observation_unknown_field');
  if (observation.schemaVersion !== 1) {
    throw new Error('golden_trace_observation_schema_invalid');
  }
  const rawFacts = record(
    observation.facts,
    'golden_trace_observation_facts_invalid',
  );
  const facts: GoldenTraceObservationV1['facts'] = {};
  for (const [key, rawValue] of Object.entries(rawFacts)) {
    nonemptyString(key, 'golden_trace_observation_fact_key_invalid');
    const fact = record(rawValue, 'golden_trace_observation_fact_invalid');
    exactKeys(
      fact,
      ['value', 'unit', 'evidenceIds'],
      'golden_trace_observation_fact_unknown_field',
    );
    if (!Object.prototype.hasOwnProperty.call(fact, 'value')) {
      throw new Error('golden_trace_observation_fact_value_invalid');
    }
    facts[key] = {
      value: scalar(
        fact.value,
        'golden_trace_observation_fact_value_invalid',
      ),
      ...(fact.unit === undefined
        ? {}
        : {
            unit: nonemptyString(
              fact.unit,
              'golden_trace_observation_fact_unit_invalid',
            ),
          }),
      evidenceIds: stringArray(
        fact.evidenceIds,
        'golden_trace_observation_fact_evidence_invalid',
        {allowEmpty: true},
      ),
    };
  }
  const evidence = stringArray(
    observation.evidence,
    'golden_trace_observation_evidence_invalid',
    {allowEmpty: true},
  );
  if (!Array.isArray(observation.claims)) {
    throw new Error('golden_trace_observation_claims_invalid');
  }
  const claims = observation.claims.map(rawClaim => {
    const claim = record(rawClaim, 'golden_trace_observation_claim_invalid');
    exactKeys(
      claim,
      ['text', 'supportLevel'],
      'golden_trace_observation_claim_unknown_field',
    );
    if (!['verified', 'partial', 'inference', 'unsupported'].includes(
      String(claim.supportLevel),
    )) {
      throw new Error('golden_trace_observation_claim_support_invalid');
    }
    return {
      text: nonemptyString(
        claim.text,
        'golden_trace_observation_claim_text_invalid',
      ),
      supportLevel: claim.supportLevel as GoldenTraceObservationV1[
        'claims'
      ][number]['supportLevel'],
    };
  });
  if (!Array.isArray(observation.gaps)) {
    throw new Error('golden_trace_observation_gaps_invalid');
  }
  const gaps = observation.gaps.map(rawGap => {
    const gap = record(rawGap, 'golden_trace_observation_gap_invalid');
    exactKeys(
      gap,
      ['code', 'missingEvidenceIds'],
      'golden_trace_observation_gap_unknown_field',
    );
    return {
      code: nonemptyString(
        gap.code,
        'golden_trace_observation_gap_code_invalid',
      ),
      missingEvidenceIds: stringArray(
        gap.missingEvidenceIds,
        'golden_trace_observation_gap_evidence_invalid',
        {allowEmpty: true},
      ),
    };
  });
  if (new Set(gaps.map(gap => gap.code)).size !== gaps.length) {
    throw new Error('golden_trace_observation_gap_duplicate');
  }
  const rawIdentities = record(
    observation.identities,
    'golden_trace_observation_identities_invalid',
  );
  const identities: GoldenTraceObservationV1['identities'] = {};
  for (const [key, rawValue] of Object.entries(rawIdentities)) {
    nonemptyString(key, 'golden_trace_observation_identity_key_invalid');
    identities[key] = scalar(
      rawValue,
      'golden_trace_observation_identity_value_invalid',
    );
  }
  if (!Array.isArray(observation.causalEdges)) {
    throw new Error('golden_trace_observation_causal_edges_invalid');
  }
  const causalEdges = observation.causalEdges.map(rawEdge => {
    const edge = record(rawEdge, 'golden_trace_observation_causal_edge_invalid');
    exactKeys(edge, [
      'subject',
      'relation',
      'object',
      'level',
      'verified',
    ], 'golden_trace_observation_causal_edge_unknown_field');
    if (edge.level !== 'correlation' && edge.level !== 'mechanism') {
      throw new Error('golden_trace_observation_causal_edge_level_invalid');
    }
    if (typeof edge.verified !== 'boolean') {
      throw new Error('golden_trace_observation_causal_edge_verified_invalid');
    }
    return {
      subject: nonemptyString(
        edge.subject,
        'golden_trace_observation_causal_edge_subject_invalid',
      ),
      relation: nonemptyString(
        edge.relation,
        'golden_trace_observation_causal_edge_relation_invalid',
      ),
      object: nonemptyString(
        edge.object,
        'golden_trace_observation_causal_edge_object_invalid',
      ),
      level: edge.level as GoldenTraceObservationV1[
        'causalEdges'
      ][number]['level'],
      verified: edge.verified,
    };
  });
  const edgeKeys = causalEdges.map(edge =>
    `${edge.subject}\0${edge.relation}\0${edge.object}\0${edge.level}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) {
    throw new Error('golden_trace_observation_causal_edge_duplicate');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    facts,
    evidence,
    claims,
    gaps,
    identities,
    causalEdges,
  });
}

function scalarMatches(actual: EvalScalar, expected: EvalScalar): boolean {
  return Object.is(actual, expected);
}

export function scoreGoldenTraceObservation(
  inputGroundTruth: EvalGroundTruthV1 | undefined,
  inputObservation: GoldenTraceObservationV1,
): GoldenTraceScoreResult {
  if (!inputGroundTruth) {
    return {status: 'inconclusive', reason: 'ground_truth_missing'};
  }
  const groundTruth = parseEvalGroundTruth(inputGroundTruth);
  const observation = parseGoldenTraceObservation(inputObservation);
  const blockers: string[] = [];
  const assertions: Array<{
    id: string;
    category:
      | 'required_fact'
      | 'numeric_expectation'
      | 'required_evidence'
      | 'forbidden_claim'
      | 'claim_support'
      | 'gap'
      | 'identity'
      | 'causal_edge';
    status: 'passed' | 'failed' | 'not_evaluable';
    blocker?: string;
  }> = [];
  let evaluated = 0;
  let passed = 0;
  let failed = 0;
  let notEvaluable = 0;
  const recordResult = (
    id: string,
    category: (typeof assertions)[number]['category'],
    ok: boolean,
    blocker: string,
  ) => {
    evaluated += 1;
    if (ok) {
      passed += 1;
      assertions.push({id, category, status: 'passed'});
      return;
    }
    failed += 1;
    blockers.push(blocker);
    assertions.push({id, category, status: 'failed', blocker});
  };

  for (const fact of groundTruth.requiredFacts) {
    if (fact.evaluation === 'semantic') {
      notEvaluable += 1;
      assertions.push({
        id: fact.id,
        category: 'required_fact',
        status: 'not_evaluable',
      });
      continue;
    }
    const observed = observation.facts[fact.observationKey!];
    recordResult(
      fact.id,
      'required_fact',
      observed !== undefined && scalarMatches(observed.value, fact.expected!),
      observed === undefined
        ? 'deterministic_fact_missing'
        : 'deterministic_fact_mismatch',
    );
  }

  for (const expectation of groundTruth.numericExpectations) {
    const observed = observation.facts[expectation.observationKey];
    if (!observed || typeof observed.value !== 'number') {
      recordResult(
        expectation.id,
        'numeric_expectation',
        false,
        'numeric_fact_missing',
      );
      continue;
    }
    if (observed.unit !== expectation.unit) {
      recordResult(
        expectation.id,
        'numeric_expectation',
        false,
        'numeric_unit_mismatch',
      );
      continue;
    }
    const absoluteLimit = expectation.absoluteTolerance ?? 0;
    const relativeLimit = Math.abs(expectation.expected)
      * (expectation.relativeTolerance ?? 0);
    recordResult(
      expectation.id,
      'numeric_expectation',
      Math.abs(observed.value - expectation.expected)
        <= Math.max(absoluteLimit, relativeLimit),
      'numeric_value_mismatch',
    );
  }

  const observedEvidence = new Set(observation.evidence);
  for (const evidence of groundTruth.requiredEvidence) {
    recordResult(
      evidence.id,
      'required_evidence',
      observedEvidence.has(evidence.locator),
      'required_evidence_missing',
    );
  }

  for (const forbidden of groundTruth.forbiddenClaims) {
    const needles = forbidden.contains.map(item => item.toLocaleLowerCase());
    const present = observation.claims.some(claim => {
      const text = claim.text.toLocaleLowerCase();
      return needles.some(needle => text.includes(needle));
    });
    recordResult(
      forbidden.id,
      'forbidden_claim',
      !present,
      'forbidden_claim',
    );
  }

  observation.claims.forEach((claim, index) => {
    if (claim.supportLevel !== 'unsupported') return;
    recordResult(
      `observed-claim-${index}`,
      'claim_support',
      false,
      'unsupported_claim',
    );
  });

  const allowedGaps = new Map(groundTruth.allowedGaps.map(gap => [gap.code, gap]));
  for (const gap of observation.gaps) {
    const allowed = allowedGaps.get(gap.code);
    const missing = new Set(gap.missingEvidenceIds);
    recordResult(
      `observed-gap-${gap.code}`,
      'gap',
      allowed !== undefined
        && allowed.requiresMissingEvidence.every(id =>
          missing.has(id) && !observedEvidence.has(id)),
      'invalid_gap',
    );
  }

  for (const identity of groundTruth.identityExpectations) {
    recordResult(
      identity.id,
      'identity',
      Object.prototype.hasOwnProperty.call(
        observation.identities,
        identity.observationKey,
      )
        && scalarMatches(
          observation.identities[identity.observationKey],
          identity.expected,
        ),
      'identity_mismatch',
    );
  }

  for (const expectedEdge of groundTruth.causalEdges) {
    recordResult(
      expectedEdge.id,
      'causal_edge',
      observation.causalEdges.some(edge =>
        edge.verified
        && edge.subject === expectedEdge.subject
        && edge.relation === expectedEdge.relation
        && edge.object === expectedEdge.object
        && (
          expectedEdge.minimumLevel === 'correlation'
          || edge.level === 'mechanism'
        )),
      'causal_edge_missing',
    );
  }

  const uniqueBlockers = [...new Set(blockers)];
  if (notEvaluable > 0) uniqueBlockers.push('semantic_fact_not_evaluated');
  const scoreBody = {
    status: 'scored' as const,
    passed: failed === 0 && notEvaluable === 0,
    blockers: uniqueBlockers,
    assertions,
    summary: {evaluated, passed, failed, notEvaluable},
  };
  return immutableCanonicalSnapshot({
    ...scoreBody,
    contentHash: canonicalContentHash({groundTruth, observation, scoreBody}),
  });
}
