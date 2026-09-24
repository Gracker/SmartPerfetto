// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ClaimSemanticsV1, ConclusionContractClaimReference} from '../../agent/core/conclusionContract';
import type {ClaimSupportV1, EvidenceAnchorV1} from '../../types/evidenceContract';
import type {
  ClaimPropositionCoverage,
  ClaimReferenceVerificationResult,
  ClaimVerificationClaimResultV2,
  ClaimVerificationIssue,
  ClaimVerificationPolicy,
  ClaimVerificationResultV2,
  DeterministicClaimProof,
  DeterministicClaimProofKind,
} from '../../types/claimVerification';
import {
  getCapturedAnchorFacts,
  unreadableEvidenceAnchorReason,
  type CapturedFieldSemantics,
  type EvidenceScalar,
} from '../evidence/evidenceCapture';
import {evidenceReferenceKey} from '../evidence/claimEvidencePreparation';
import {compareRationals as compare, exactNumber, type Rational} from '../../utils/exactDecimal';
import {referenceBindingFailureIsAdvisory} from '../evidence/evidenceReadView';

export interface DeterministicClaimVerifierInput {
  claimSupport?: ClaimSupportV1[];
  policy?: ClaimVerificationPolicy;
}

type CapturedFacts = NonNullable<ReturnType<typeof getCapturedAnchorFacts>>;
type BoundAnchor = {anchor: EvidenceAnchorV1; facts: CapturedFacts};
type BoundCell = BoundAnchor & {column: string; value: EvidenceScalar; field?: CapturedFieldSemantics};
type Resolution<T> = {value: T} | {reason: string};
type Unit = {dimension: string; numerator: bigint; denominator: bigint};

const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const proofKinds: Readonly<Record<string, DeterministicClaimProofKind>> = Object.freeze({
  'numeric.cell': 'numeric_cell',
  'captured.cell': 'captured_cell',
  'source.location': 'source_location',
  'interval.overlap': 'interval_overlap',
  'comparison.delta': 'comparison_delta',
});

export interface SupportedDeterministicClaimRule {
  readonly id: string;
  readonly proofKind: DeterministicClaimProofKind;
}

export const SUPPORTED_DETERMINISTIC_CLAIM_RULES: readonly SupportedDeterministicClaimRule[] = Object.freeze(
  Object.entries(proofKinds).map(([id, proofKind]) => Object.freeze({id, proofKind})),
);

// These are explicit unit definitions, not aliases inferred from a column name.
const units: Readonly<Record<string, Unit>> = {
  ns: {dimension: 'time', numerator: 1n, denominator: 1n},
  us: {dimension: 'time', numerator: 1000n, denominator: 1n},
  'µs': {dimension: 'time', numerator: 1000n, denominator: 1n},
  'μs': {dimension: 'time', numerator: 1000n, denominator: 1n},
  ms: {dimension: 'time', numerator: 1000000n, denominator: 1n},
  s: {dimension: 'time', numerator: 1000000000n, denominator: 1n},
  count: {dimension: 'count', numerator: 1n, denominator: 1n},
  frame: {dimension: 'frames', numerator: 1n, denominator: 1n},
  frames: {dimension: 'frames', numerator: 1n, denominator: 1n},
  event: {dimension: 'events', numerator: 1n, denominator: 1n},
  events: {dimension: 'events', numerator: 1n, denominator: 1n},
  ratio: {dimension: 'ratio', numerator: 1n, denominator: 1n},
  '%': {dimension: 'ratio', numerator: 1n, denominator: 100n},
  percent: {dimension: 'ratio', numerator: 1n, denominator: 100n},
  B: {dimension: 'bytes', numerator: 1n, denominator: 1n},
  bytes: {dimension: 'bytes', numerator: 1n, denominator: 1n},
  KiB: {dimension: 'bytes', numerator: 1024n, denominator: 1n},
  MiB: {dimension: 'bytes', numerator: 1048576n, denominator: 1n},
  GiB: {dimension: 'bytes', numerator: 1073741824n, denominator: 1n},
  Hz: {dimension: 'frequency', numerator: 1n, denominator: 1n},
  kHz: {dimension: 'frequency', numerator: 1000n, denominator: 1n},
  MHz: {dimension: 'frequency', numerator: 1000000n, denominator: 1n},
  GHz: {dimension: 'frequency', numerator: 1000000000n, denominator: 1n},
};

function unitFor(unit: string | undefined): Unit | undefined {
  return unit !== undefined && hasOwn(units, unit) ? units[unit] : undefined;
}

function exactPrimitiveMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected !== typeof actual) return false;
  if (typeof expected === 'number') return Number.isFinite(expected) && expected === actual;
  return (typeof expected === 'string' || typeof expected === 'boolean') && expected === actual;
}

function scale(value: Rational, unit: Unit): Rational {
  return {numerator: value.numerator * unit.numerator, denominator: value.denominator * unit.denominator};
}


function numericOperator(comparison: number, operator: NonNullable<ClaimSemanticsV1['numeric']>['operator']): boolean {
  switch (operator) {
    case 'eq': return comparison === 0;
    case 'ne': return comparison !== 0;
    case 'lt': return comparison < 0;
    case 'lte': return comparison <= 0;
    case 'gt': return comparison > 0;
    case 'gte': return comparison >= 0;
  }
}

function trustedField(field: CapturedFieldSemantics | undefined): field is CapturedFieldSemantics {
  return Boolean(field && (field.origin.kind === 'skill_literal' || field.origin.kind === 'native_producer') &&
    field.origin.definitionFingerprint);
}

function anchorFailure(anchor: EvidenceAnchorV1): string | undefined {
  if (anchor.missing) return anchor.missingReason || 'referenced_evidence_missing';
  const provenance = anchor.scopeProvenance;
  if (provenance && (provenance.invalid || provenance.entries.length === 0 ||
      provenance.entries.some(entry => entry.availability === 'unavailable' || entry.fields?.length === 0 ||
        entry.scope.traceId !== anchor.context.traceId || entry.scope.traceSide !== anchor.context.traceSide))) {
    return 'evidence_scope_invalid';
  }
  if (provenance && anchor.identity?.status === 'verified') {
    const identity = anchor.identity;
    const targets = provenance.entries.filter(entry => entry.role === 'target');
    if (!identity.identityRefId || !targets.some(entry => entry.scope.identityRefId === identity.identityRefId &&
        (entry.scope.upid === undefined || identity.upid === undefined || entry.scope.upid === identity.upid))) {
      return 'evidence_identity_scope_conflict';
    }
  }
  return undefined;
}

function scopeRoleForField(anchor: EvidenceAnchorV1, column: string): string | undefined {
  const entries = anchor.scopeProvenance?.entries.filter(entry =>
    entry.availability !== 'unavailable' && (entry.fields === undefined || entry.fields.includes(column)));
  return entries?.length === 1 ? entries[0].role : undefined;
}

function verifyAnchor(anchor: EvidenceAnchorV1, ineligible: boolean): ClaimReferenceVerificationResult[] {
  const base = {
    anchorId: anchor.anchorId,
    evidenceRefId: anchor.evidenceRefId,
    artifactId: anchor.context.artifactId,
    sourceToolCallId: anchor.context.sourceToolCallId,
  };
  // An ineligible binding is never read, so how its anchor failed is moot.
  if (ineligible) return [{...base, status: 'ineligible', message: 'claim binding is ineligible'}];
  const failure = anchorFailure(anchor);
  // Only an issued read outcome can show the product failed to read; the reason string alone cannot.
  if (failure) return [{...base, status: unreadableEvidenceAnchorReason(anchor) ? 'not_checked' : 'missing', message: failure}];
  const facts = getCapturedAnchorFacts(anchor);
  if (!facts) return [{...base, status: 'not_checked', message: anchor.missingReason || 'immutable execution capture is unavailable'}];
  if (!anchor.cells?.length) return [{...base, status: 'not_checked', message: 'no expected cell value was supplied'}];
  return anchor.cells.map(cell => {
    const reference = {...base, sourceRef: cell.sourceRef, column: cell.column};
    if (anchor.scopeProvenance && !scopeRoleForField(anchor, cell.column)) {
      return {...reference, status: 'missing', message: `no unambiguous scope exists for ${cell.column}`};
    }
    if (!hasOwn(facts.row, cell.column)) {
      return {...reference, status: 'missing', message: `no captured value exists for ${cell.column}`};
    }
    if (!hasOwn(cell, 'value') || cell.value === undefined) {
      return {...reference, status: 'not_checked', message: `no expected value was supplied for ${cell.column}`};
    }
    const actual = facts.row[cell.column];
    // The reference schema permits both numeric and string literals. Different
    // encodings cannot prove equality or a contradiction; typed numeric proof
    // independently compares the original proposition with the captured value.
    if ((typeof cell.value === 'string' && typeof actual === 'number') ||
      (typeof cell.value === 'number' && typeof actual === 'string')) {
      return {...reference, status: 'not_checked', message: `reference value type is unresolved for ${cell.column}`};
    }
    const matched = exactPrimitiveMatch(cell.value, actual);
    return {
      ...reference,
      status: matched ? 'matched' : 'value_mismatch',
      ...(matched ? {} : {message: `value mismatch for ${cell.column}`}),
    };
  });
}

function referenceMatches(reference: ConclusionContractClaimReference, bound: BoundAnchor): boolean {
  const {anchor, facts} = bound;
  // Prepared references were already resolved against the complete capture.
  // Their private key preserves all identifiers and locators without reinterpreting aliases.
  if (facts.referenceKey !== undefined) return facts.referenceKey === evidenceReferenceKey(reference);
  const context = anchor.context;
  if (reference.evidenceRefId !== undefined && reference.evidenceRefId !== anchor.evidenceRefId) return false;
  if (reference.sourceToolCallId !== undefined && reference.sourceToolCallId !== context.sourceToolCallId) return false;
  const artifactId = context.artifactId || context.sourceArtifactId;
  if (reference.artifactId !== undefined && reference.artifactId !== artifactId) return false;
  if (reference.sourceArtifactId !== undefined && reference.sourceArtifactId !== artifactId) return false;
  if (reference.sourceRef !== undefined && !anchor.cells?.some(cell => cell.sourceRef === reference.sourceRef)) return false;
  if (reference.rowIndex !== undefined && reference.rowIndex !== facts.originalRowIndex) return false;
  if (reference.rowSelector !== undefined && !Object.entries(reference.rowSelector).every(([key, value]) =>
    hasOwn(facts.row, key) && exactPrimitiveMatch(value, facts.row[key]))) return false;
  return reference.column === undefined || hasOwn(facts.row, reference.column);
}

function resolveReference(claim: ClaimSupportV1, reference: ConclusionContractClaimReference): Resolution<BoundAnchor> {
  if (!reference.evidenceRefId && !reference.sourceToolCallId && !reference.artifactId &&
      !reference.sourceArtifactId && !reference.sourceRef) return {reason: 'semantic_reference_identifier_missing'};
  const candidates = [...claim.anchors, ...(claim.relationAnchors || [])].flatMap(anchor => {
    const facts = getCapturedAnchorFacts(anchor);
    return !anchorFailure(anchor) && facts && referenceMatches(reference, {anchor, facts}) ? [{anchor, facts}] : [];
  });
  const unique = new Map(candidates.map(bound => [`${bound.facts.captureId}:${bound.facts.originalRowIndex}`, bound]));
  if (unique.size !== 1) return {reason: unique.size === 0 ? 'semantic_reference_missing' : 'semantic_reference_ambiguous'};
  const bound = [...unique.values()][0];
  if (!bound.anchor.context.traceId || bound.anchor.context.traceId === 'unknown' ||
      !bound.anchor.context.traceSide || bound.anchor.context.traceSide === 'unknown') {
    return {reason: 'trace_context_missing'};
  }
  return {value: bound};
}

function resolveCell(claim: ClaimSupportV1, reference: ConclusionContractClaimReference): Resolution<BoundCell> {
  const bound = resolveReference(claim, reference);
  if ('reason' in bound) return bound;
  const columns = reference.column ? [reference.column] : [...new Set(bound.value.anchor.cells?.map(cell => cell.column))];
  if (columns.length !== 1) return {reason: 'numeric_cell_ambiguous'};
  const column = columns[0];
  if (!hasOwn(bound.value.facts.row, column)) return {reason: 'numeric_cell_missing'};
  return {value: {...bound.value, column, value: bound.value.facts.row[column], field: bound.value.facts.fields[column]}};
}

function proof(
  kind: DeterministicClaimProofKind,
  status: DeterministicClaimProof['status'],
  reason: string,
  anchors: EvidenceAnchorV1[] = [],
): DeterministicClaimProof {
  const nativeRows = [...new Set(anchors)].flatMap(anchor => {
    const facts = getCapturedAnchorFacts(anchor);
    const native = facts?.nativeRow;
    if (!native || native.traceId !== anchor.context.traceId || native.traceSide !== anchor.context.traceSide ||
        facts.captureId !== anchor.context.captureId) return [];
    return [{anchorId: anchor.anchorId, evidenceRefId: anchor.evidenceRefId, captureId: facts.captureId,
      traceId: native.traceId, traceSide: native.traceSide, relation: native.relation, idColumn: native.idColumn,
      id: native.id, schemaFingerprint: native.schemaFingerprint}];
  });
  return {
    kind, status, reason,
    anchorIds: [...new Set(anchors.map(anchor => anchor.anchorId))],
    evidenceRefIds: [...new Set(anchors.map(anchor => anchor.evidenceRefId))],
    ...(nativeRows.length ? {nativeRows} : {}),
  };
}

function numericProof(claim: ClaimSupportV1, semantics: ClaimSemanticsV1): DeterministicClaimProof {
  const kind = 'numeric_cell';
  if (semantics.scope.subjectRefs?.length !== 1 || (semantics.scope.objectRefs?.length || 0) !== 0) {
    return proof(kind, 'candidate', 'numeric_scope_requires_one_cell');
  }
  if (!semantics.numeric) return proof(kind, 'candidate', 'numeric_declaration_missing');
  const resolved = resolveCell(claim, semantics.scope.subjectRefs[0]);
  if ('reason' in resolved) return proof(kind, 'candidate', resolved.reason);
  const cell = resolved.value;
  const anchors = [cell.anchor];
  if (cell.anchor.scopeProvenance && !scopeRoleForField(cell.anchor, cell.column)) {
    return proof(kind, 'candidate', 'numeric_field_scope_unknown', anchors);
  }
  const actualUnit = unitFor(cell.field?.unit);
  const expectedUnit = unitFor(semantics.numeric.unit);
  if (!trustedField(cell.field) || !actualUnit || !expectedUnit) {
    return proof(kind, 'candidate', 'unit_authority_unknown', anchors);
  }
  if (actualUnit.dimension !== expectedUnit.dimension) return proof(kind, 'rejected', 'unit_dimension_mismatch', anchors);
  const actual = exactNumber(cell.value);
  const expected = exactNumber(semantics.numeric.value);
  if (!actual || !expected) return proof(kind, 'candidate', 'exact_numeric_value_unavailable', anchors);
  const matched = numericOperator(compare(scale(actual, actualUnit), scale(expected, expectedUnit)), semantics.numeric.operator);
  return proof(kind, matched ? 'proved' : 'rejected', matched ? 'numeric_operator_proved' : 'numeric_operator_rejected', anchors);
}

/** Proves only the explicitly declared nonnumeric value of one captured cell. */
function capturedCellProof(claim: ClaimSupportV1, semantics: ClaimSemanticsV1): DeterministicClaimProof {
  const kind = 'captured_cell';
  if (semantics.scope.subjectRefs?.length !== 1 || semantics.scope.objectRefs?.length) {
    return proof(kind, 'candidate', 'captured_scope_requires_one_cell');
  }
  if (semantics.numeric) return proof(kind, 'candidate', 'captured_numeric_not_supported');
  const subject = semantics.scope.subjectRefs[0];
  if (!subject.column || !hasOwn(subject, 'value')) return proof(kind, 'candidate', 'captured_declaration_missing');
  if (subject.value !== null && typeof subject.value !== 'string' && typeof subject.value !== 'boolean') {
    return proof(kind, 'candidate', 'captured_numeric_not_supported');
  }
  const resolved = resolveCell(claim, subject);
  if ('reason' in resolved) return proof(kind, 'candidate', resolved.reason);
  const {anchor, value} = resolved.value;
  const matched = exactPrimitiveMatch(subject.value, value);
  if (!matched && losslessPrimitiveEncoding(subject.value, value)) {
    // The same value in another JSON type ('858' vs 858) neither proves the
    // declared string nor contradicts the captured value. The reference layer
    // reports this pair as an unresolved type, not a mismatch (verifyAnchor).
    return proof(kind, 'candidate', 'captured_value_type_mismatch', [anchor]);
  }
  return proof(kind, matched ? 'proved' : 'rejected',
    matched ? 'captured_cell_value_proved' : 'captured_cell_value_rejected', [anchor]);
}

/** A declared string that is exactly the captured number's decimal value ('858' or '858.0' for 858). */
function losslessPrimitiveEncoding(declared: unknown, actual: EvidenceScalar): boolean {
  if (typeof declared !== 'string' || typeof actual !== 'number') return false;
  const expected = exactNumber(declared);
  const captured = exactNumber(actual);
  return Boolean(expected && captured && compare(expected, captured) === 0);
}

function exactNanoseconds(value: EvidenceScalar, field: CapturedFieldSemantics): bigint | undefined {
  const unit = unitFor(field.unit);
  if (!trustedField(field) || field.clock !== 'trace_monotonic' || !unit || unit.dimension !== 'time') return undefined;
  const rational = exactNumber(value);
  if (!rational) return undefined;
  const ns = scale(rational, unit);
  return ns.numerator % ns.denominator === 0n ? ns.numerator / ns.denominator : undefined;
}

function capturedInterval(bound: BoundAnchor): Resolution<{start: bigint; end: bigint}> {
  const byRole = (role: CapturedFieldSemantics['timeRole']) => Object.entries(bound.facts.fields)
    .filter(([column, field]) => field.timeRole === role && hasOwn(bound.facts.row, column));
  const starts = byRole('start');
  const ends = byRole('end');
  const durations = byRole('duration');
  if (starts.length !== 1 || ends.length > 1 || durations.length > 1 || (ends.length === 0 && durations.length === 0)) {
    return {reason: 'interval_time_roles_unknown'};
  }
  if (bound.anchor.scopeProvenance) {
    const roles = [...starts, ...ends, ...durations].map(([column]) => scopeRoleForField(bound.anchor, column));
    if (roles.some(role => role === undefined)) return {reason: 'interval_field_scope_unknown'};
    if (new Set(roles).size !== 1) return {reason: 'interval_field_scope_mismatch'};
  }
  const read = ([column, field]: [string, CapturedFieldSemantics]) => exactNanoseconds(bound.facts.row[column], field);
  const start = read(starts[0]);
  const end = ends.length ? read(ends[0]) : undefined;
  const duration = durations.length ? read(durations[0]) : undefined;
  if (start === undefined || (ends.length && end === undefined) || (durations.length && duration === undefined)) {
    return {reason: 'interval_exact_clock_unavailable'};
  }
  const effectiveEnd = end ?? (start + duration!);
  if (start < 0n || effectiveEnd <= start || (duration !== undefined && start + duration !== effectiveEnd)) {
    return {reason: 'interval_range_invalid'};
  }
  return {value: {start, end: effectiveEnd}};
}

function intervalProof(claim: ClaimSupportV1, semantics: ClaimSemanticsV1): DeterministicClaimProof {
  const kind = 'interval_overlap';
  if (semantics.scope.subjectRefs?.length !== 1 || semantics.scope.objectRefs?.length !== 1 || semantics.numeric) {
    return proof(kind, 'candidate', 'interval_scope_requires_two_rows');
  }
  const subject = resolveReference(claim, semantics.scope.subjectRefs[0]);
  const object = resolveReference(claim, semantics.scope.objectRefs[0]);
  if ('reason' in subject) return proof(kind, 'candidate', subject.reason);
  if ('reason' in object) return proof(kind, 'candidate', object.reason);
  const anchors = [subject.value.anchor, object.value.anchor];
  if (anchors[0].context.traceId !== anchors[1].context.traceId || anchors[0].context.traceSide !== anchors[1].context.traceSide) {
    return proof(kind, 'rejected', 'interval_trace_context_mismatch', anchors);
  }
  const left = capturedInterval(subject.value);
  const right = capturedInterval(object.value);
  if ('reason' in left) return proof(kind, left.reason === 'interval_range_invalid' ? 'rejected' : 'candidate', left.reason, anchors);
  if ('reason' in right) return proof(kind, right.reason === 'interval_range_invalid' ? 'rejected' : 'candidate', right.reason, anchors);
  const overlaps = left.value.start < right.value.end && right.value.start < left.value.end;
  return proof(kind, overlaps ? 'proved' : 'rejected', overlaps ? 'half_open_interval_overlap_proved' : 'half_open_intervals_disjoint', anchors);
}

function comparisonProof(claim: ClaimSupportV1, semantics: ClaimSemanticsV1): DeterministicClaimProof {
  const kind = 'comparison_delta';
  if (semantics.scope.subjectRefs?.length !== 1 || semantics.scope.objectRefs?.length !== 1 || !semantics.numeric) {
    return proof(kind, 'candidate', 'comparison_scope_requires_two_cells');
  }
  const current = resolveCell(claim, semantics.scope.subjectRefs[0]);
  const reference = resolveCell(claim, semantics.scope.objectRefs[0]);
  if ('reason' in current) return proof(kind, 'candidate', current.reason);
  if ('reason' in reference) return proof(kind, 'candidate', reference.reason);
  const left = current.value;
  const right = reference.value;
  const anchors = [left.anchor, right.anchor];
  if (left.anchor.context.traceSide !== 'current' || right.anchor.context.traceSide !== 'reference') {
    return proof(kind, 'rejected', 'comparison_side_mismatch', anchors);
  }
  if (!trustedField(left.field) || !trustedField(right.field)) return proof(kind, 'candidate', 'comparison_metric_authority_unknown', anchors);
  for (const key of ['metricId', 'aggregation', 'populationKey'] as const) {
    if (!left.field[key] || !right.field[key]) return proof(kind, 'candidate', `comparison_${key}_unknown`, anchors);
    if (left.field[key] !== right.field[key]) return proof(kind, 'rejected', `comparison_${key}_mismatch`, anchors);
  }
  if (left.field.origin.definitionFingerprint !== right.field.origin.definitionFingerprint ||
      left.field.origin.kind !== right.field.origin.kind || left.field.origin.skillId !== right.field.origin.skillId ||
      left.field.origin.stepId !== right.field.origin.stepId) return proof(kind, 'rejected', 'comparison_metric_definition_mismatch', anchors);
  const leftRole = scopeRoleForField(left.anchor, left.column);
  const rightRole = scopeRoleForField(right.anchor, right.column);
  if (!leftRole || !rightRole) return proof(kind, 'candidate', 'comparison_field_scope_unknown', anchors);
  if (leftRole !== rightRole) return proof(kind, 'rejected', 'comparison_field_scope_mismatch', anchors);
  const leftUnit = unitFor(left.field.unit);
  const rightUnit = unitFor(right.field.unit);
  const declaredUnit = unitFor(semantics.numeric.unit);
  if (!leftUnit || !rightUnit || !declaredUnit) return proof(kind, 'candidate', 'unit_authority_unknown', anchors);
  if (leftUnit.dimension !== rightUnit.dimension || leftUnit.dimension !== declaredUnit.dimension) {
    return proof(kind, 'rejected', 'unit_dimension_mismatch', anchors);
  }
  const leftNumber = exactNumber(left.value);
  const rightNumber = exactNumber(right.value);
  const declaredNumber = exactNumber(semantics.numeric.value);
  if (!leftNumber || !rightNumber || !declaredNumber) return proof(kind, 'candidate', 'exact_numeric_value_unavailable', anchors);
  const a = scale(leftNumber, leftUnit);
  const b = scale(rightNumber, rightUnit);
  const delta = {numerator: a.numerator * b.denominator - b.numerator * a.denominator, denominator: a.denominator * b.denominator};
  const matched = numericOperator(compare(delta, scale(declaredNumber, declaredUnit)), semantics.numeric.operator);
  return proof(kind, matched ? 'proved' : 'rejected', matched ? 'cited_metric_delta_proved' : 'comparison_delta_rejected', anchors);
}

function deterministicProof(claim: ClaimSupportV1, references: ClaimReferenceVerificationResult[]): DeterministicClaimProof {
  const semantics = claim.semantics;
  const kind = semantics && hasOwn(proofKinds, semantics.predicate) ? proofKinds[semantics.predicate] : 'none';
  // Nothing was evaluated: an invalid declaration is unverified, not a rejected proposition.
  if (claim.bindingEligibility === 'ineligible') return proof(kind, 'not_checked', 'binding_ineligible');
  if (!semantics) return proof(kind, 'not_checked', 'semantics_not_declared');
  if (claim.bindingEligibility !== 'eligible') return proof(kind, 'candidate', 'binding_eligibility_unchecked');
  if (kind === 'none') return proof(kind, 'candidate', 'unsupported_predicate');
  // Source locations are evaluated against the private current-run source ledger
  // by the shared finalizer, never against Trace anchors or model metadata here.
  if (kind === 'source_location') return proof(kind, 'not_checked', 'source_evidence_required');
  if (semantics.source) return proof(kind, 'candidate', 'source_declaration_not_supported');
  const unresolved = references.some(reference => reference.status === 'missing' || reference.status === 'ambiguous' || reference.status === 'value_mismatch');
  // An extra broken citation must not hide a contradiction in the predicate's
  // own captured inputs. Evaluate those inputs, but never prove from bad refs.
  const evaluated = evaluateTypedProposition(claim, semantics, kind, unresolved);
  return unresolved && evaluated.status !== 'rejected' ? proof(kind, 'candidate', 'reference_cells_unresolved') : evaluated;
}

function evaluateTypedProposition(claim: ClaimSupportV1, semantics: ClaimSemanticsV1,
  kind: Exclude<DeterministicClaimProofKind, 'none' | 'source_location'>, rejectOnly: boolean): DeterministicClaimProof {
  if (!rejectOnly && claim.anchors.some(anchor => !getCapturedAnchorFacts(anchor))) return proof(kind, 'candidate', 'execution_capture_missing');
  if (semantics.discourse !== 'asserted' || semantics.polarity !== 'affirmed' || semantics.modality !== 'certain') {
    return proof(kind, 'candidate', 'proposition_assertion_not_supported');
  }
  if (semantics.quantifier !== 'one') return proof(kind, 'candidate', 'proposition_quantifier_not_supported');
  if (semantics.conditions?.length) return proof(kind, 'candidate', 'proposition_conditions_unproved');
  if (semantics.scope.population !== 'cited_rows') return proof(kind, 'candidate', 'proposition_population_unproved');
  if (semantics.scope.timeRangeNs) return proof(kind, 'candidate', 'proposition_window_unproved');
  if ((kind === 'numeric_cell' && claim.kind !== 'numeric') || (kind === 'interval_overlap' && claim.kind !== 'time_range') ||
      (kind === 'captured_cell' && claim.kind !== 'identity' && claim.kind !== 'categorical') ||
      (kind === 'comparison_delta' && claim.kind !== 'comparison')) return proof(kind, 'candidate', 'claim_kind_predicate_mismatch');
  switch (kind) {
    case 'numeric_cell': return numericProof(claim, semantics);
    case 'captured_cell': return capturedCellProof(claim, semantics);
    case 'interval_overlap': return intervalProof(claim, semantics);
    case 'comparison_delta': return comparisonProof(claim, semantics);
  }
}

function coverageFor(proved: DeterministicClaimProof, references: ClaimReferenceVerificationResult[]): ClaimPropositionCoverage {
  if (proved.status === 'proved') return {
    status: 'complete',
    covered: ['predicate', 'polarity', 'discourse', 'quantifier', 'modality', 'conditions', 'scope',
      ...(proved.kind === 'captured_cell' ? ['value'] : proved.kind === 'interval_overlap' ? [] : ['numeric'])],
    uncovered: [],
    reason: 'complete_typed_proposition_proved',
  };
  const matched = references.some(reference => reference.status === 'matched');
  return {
    status: matched ? 'partial' : 'none',
    covered: matched ? ['reference_cells'] : [],
    uncovered: ['typed_proposition'],
    reason: proved.reason,
  };
}

function issueForReference(claim: ClaimSupportV1, reference: ClaimReferenceVerificationResult): ClaimVerificationIssue | undefined {
  // Unverified references are reported once per claim and reason by verifyClaim.
  if (reference.status === 'matched' || reference.status === 'not_checked' || reference.status === 'ineligible') return undefined;
  const anchors = claim.anchors.filter(anchor => anchor.anchorId === reference.anchorId);
  const advisory = claim.kind !== 'identity' && !claim.semantics?.source &&
    anchors.length === 1 && referenceBindingFailureIsAdvisory(anchors[0], reference.status);
  return {
    claimId: claim.claimId,
    severity: advisory ? 'warning' : 'error',
    code: `claim_reference_${reference.status}`,
    message: reference.message || `claim reference ${reference.status}`,
    evidenceRefId: reference.evidenceRefId,
  };
}

function verifyClaim(claim: ClaimSupportV1): {result: ClaimVerificationClaimResultV2; issues: ClaimVerificationIssue[]} {
  const referenceCells = claim.anchors.flatMap(anchor => verifyAnchor(anchor, claim.bindingEligibility === 'ineligible'));
  const evaluated = deterministicProof(claim, referenceCells);
  const propositionCoverage = coverageFor(evaluated, referenceCells);
  const issues = referenceCells.map(reference => issueForReference(claim, reference))
    .filter((issue): issue is ClaimVerificationIssue => Boolean(issue));
  const ineligible = claim.bindingEligibility === 'ineligible';
  if (ineligible) issues.push({claimId: claim.claimId, severity: 'warning', code: 'binding_ineligible',
    message: 'the conclusion declaration was not admitted for verification'});
  const unreadable = ineligible ? new Set<string>() : new Set(claim.anchors.flatMap(anchor => {
    const reason = unreadableEvidenceAnchorReason(anchor);
    return reason ? [reason] : [];
  }));
  for (const reason of unreadable) {
    issues.push({claimId: claim.claimId, severity: 'warning', code: 'claim_reference_unverified', message: reason});
  }
  if (evaluated.status === 'rejected' || evaluated.status === 'candidate') issues.push({
    claimId: claim.claimId,
    severity: evaluated.status === 'rejected' ? 'error' : 'warning',
    code: evaluated.reason,
    message: `deterministic proposition proof: ${evaluated.reason}`,
  });
  if (claim.kind === 'causal') issues.push({
    claimId: claim.claimId,
    severity: 'warning',
    code: claim.relations?.length ? 'causal_relation_candidate' : 'causal_relation_missing',
    message: 'causal mechanisms require canonical native proof; endpoint equality is not mechanism evidence',
  });
  const hasError = issues.some(issue => issue.severity === 'error');
  // This stage checks the typed declaration, not whether it represents the prose.
  // Only the final shared semantic assessment may join a draft into verified.
  const status = ineligible ? 'not_checked' : hasError ? 'unsupported'
    : evaluated.status === 'proved' && propositionCoverage.status === 'complete' ? 'partial'
      : claim.kind === 'inference' || claim.kind === 'causal' ? 'inference'
        : evaluated.status === 'candidate' || referenceCells.some(reference => reference.status === 'matched') ? 'partial'
          : 'not_checked';
  return {result: {
    claimId: claim.claimId,
    status,
    referenceResults: referenceCells,
    referenceCells,
    deterministicProof: evaluated,
    propositionCoverage,
  }, issues};
}

export function runDeterministicClaimVerifier(input: DeterministicClaimVerifierInput): ClaimVerificationResultV2 {
  const verified = (input.claimSupport || []).map(verifyClaim);
  const claimResults = verified.map(item => item.result);
  const issues = verified.flatMap(item => item.issues);
  const unsupportedClaimCount = claimResults.filter(item => item.status === 'unsupported').length;
  const status = unsupportedClaimCount > 0 || issues.some(issue => issue.severity === 'error') ? 'failed'
    : claimResults.length === 0 || claimResults.every(item => item.status === 'not_checked') ? 'not_checked'
      : 'partial';
  return {
    schemaVersion: 'claim_verifier@2',
    status,
    policy: input.policy || 'record_only',
    ...(claimResults.length === 0 ? {notCheckedReason: 'no structured claim support was available'} : {}),
    passed: false,
    checkedClaimCount: claimResults.length,
    unsupportedClaimCount,
    claimResults,
    issues,
  };
}
