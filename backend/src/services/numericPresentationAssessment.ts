// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {ConclusionContract, ConclusionContractClaimItem, NumericPresentationDeclaration} from '../agent/core/conclusionContract';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity} from '../types/analysisDelivery';
import type {ClaimVerificationClaimResult, NumericPresentationAssessment} from '../types/claimVerification';
import type {ClaimSupportV1} from '../types/evidenceContract';
import {exactNumber, type Rational} from '../utils/exactDecimal';
import {evidenceReferenceKey} from './evidence/claimEvidencePreparation';
import {getCapturedAnchorFacts} from './evidence/evidenceCapture';
import {claimUnitFor, countedUnitDimension, declaredUnitAcceptsProducerDimension} from './verifier/claimUnits';

/** One fixed-decimal literal, not a sentence, range, exponent, percentage-point claim or formula. */
const LITERAL = /^(-?(?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d+))?[ \u00a0\u202f]*([\p{L}%]+)?$/u;
// Display spellings only. Producer and declaration units still use the exact
// unit registry; these labels never confer unit authority on a captured field.
const TIME_LABELS: Readonly<Record<string, string>> = {纳秒: 'ns', 微秒: 'us', 毫秒: 'ms', 秒: 's'};

function sameDisplayUnit(token: string, declared: string): boolean {
  const displayed = claimUnitFor(Object.prototype.hasOwnProperty.call(TIME_LABELS, token) ? TIME_LABELS[token] : token);
  const expected = claimUnitFor(declared);
  return Boolean(displayed && expected && displayed.dimension === expected.dimension &&
    displayed.numerator * expected.denominator === expected.numerator * displayed.denominator);
}

function locate(body: string, quote: NumericPresentationDeclaration['quotes'][number]): {start: number; end: number} | undefined {
  const hits: number[] = [];
  for (let start = body.indexOf(quote.text); start >= 0; start = body.indexOf(quote.text, start + quote.text.length)) {
    hits.push(start);
    if (quote.occurrence === undefined ? hits.length > 1 : hits.length > quote.occurrence) break;
  }
  const start = quote.occurrence === undefined ? (hits.length === 1 ? hits[0] : undefined) : hits[quote.occurrence];
  if (start === undefined) return undefined;
  const end = start + quote.text.length;
  // Preserve the entire numeric token: no `45` inside `145`, a lost negative
  // sign, identifier suffix, partial decimal, or `ms` inside `msec`.
  if (start > 0 && /[A-Za-z0-9_.,+\-−－]/u.test(body[start - 1])) return undefined;
  if (/^[\p{L}\p{N}_%/⁻⁺^]|^[.,]\d/u.test(body.slice(end))) return undefined;
  return {start, end};
}

function rounded(value: Rational, decimalPlaces: number): bigint {
  const scaled = value.numerator * 10n ** BigInt(decimalPlaces);
  const magnitude = scaled < 0n ? -scaled : scaled;
  const result = (2n * magnitude + value.denominator) / (2n * value.denominator);
  return scaled < 0n ? -result : result;
}

function assess(input: {
  claim: ConclusionContractClaimItem; prior: ClaimVerificationClaimResult | undefined;
  support: ClaimSupportV1 | undefined; body: string; candidate: AnalysisCandidateIdentity;
}, presentation: NumericPresentationDeclaration): NumericPresentationAssessment {
  const {claim, prior, support, body, candidate} = input;
  const result: NumericPresentationAssessment = {schemaVersion: 'numeric_presentation_assessment@1',
    status: 'not_checked', reason: 'proposition_not_proved',
    binding: {candidate: {...candidate}, claimFingerprint: analysisDeliveryFingerprint(claim)}, locations: []};
  const finish = (reason: string, status: NumericPresentationAssessment['status'] = 'not_checked') => ({...result, reason, status});
  const semantics = claim.semantics;
  const proof = prior?.deterministicProof;
  if (claim.valid === false || semantics?.predicate !== 'numeric.cell' || semantics.numeric?.operator !== 'eq' ||
      prior?.status === 'unsupported' || proof?.kind !== 'numeric_cell' || proof.status !== 'proved' ||
      prior?.propositionCoverage?.status !== 'complete' || !support) return result;
  const subject = semantics.scope.subjectRefs?.length === 1 && !semantics.scope.objectRefs?.length
    ? semantics.scope.subjectRefs[0] : undefined;
  if (!subject?.column) return finish('capture_unresolved');
  const {column} = subject;
  const key = evidenceReferenceKey(subject);
  const matches = support.anchors.flatMap(anchor => {
    const facts = getCapturedAnchorFacts(anchor);
    if (!facts || !proof.anchorIds.includes(anchor.anchorId) ||
        (subject.rowIndex !== undefined && subject.rowIndex !== facts.originalRowIndex) ||
        (facts.referenceKey !== undefined ? facts.referenceKey !== key :
          !subject.evidenceRefId || anchor.evidenceRefId !== subject.evidenceRefId || subject.rowIndex !== facts.originalRowIndex) ||
        !anchor.cells?.some(cell => cell.column === column &&
          (cell.rowIndex === undefined || cell.rowIndex === facts.originalRowIndex))) return [];
    return [{anchor, facts}];
  });
  if (matches.length !== 1) return finish('capture_unresolved');
  const {anchor, facts} = matches[0];
  result.source = {anchorId: anchor.anchorId, captureId: facts.captureId, rowIndex: facts.originalRowIndex, column};
  const field = facts.fields[column];
  if (field?.identityRole) return finish('identity_field');
  const sourceUnit = claimUnitFor(field?.unit);
  const displayUnit = claimUnitFor(presentation.unit);
  if (!sourceUnit || !displayUnit) return finish('unit_unknown');
  if (sourceUnit.dimension !== displayUnit.dimension &&
      !declaredUnitAcceptsProducerDimension(presentation.unit, sourceUnit.dimension)) return finish('unit_dimension_mismatch', 'mismatch');
  const actual = exactNumber(facts.row[column]);
  if (!actual) return finish('numeric_value_unavailable');
  const counted = countedUnitDimension(field?.unit) !== undefined;
  if (counted && (presentation.decimalPlaces !== 0 || actual.numerator % actual.denominator !== 0n)) {
    return finish('discrete_format_required');
  }
  const converted = {numerator: actual.numerator * sourceUnit.numerator * displayUnit.denominator,
    denominator: actual.denominator * sourceUnit.denominator * displayUnit.numerator};
  const expected = rounded(converted, presentation.decimalPlaces);
  let issue: {reason: string; status: 'mismatch' | 'not_checked'} | undefined;
  const recordIssue = (reason: string, status: 'mismatch' | 'not_checked' = 'not_checked') => {
    if (!issue || (status === 'mismatch' && issue.status !== 'mismatch')) issue = {reason, status};
  };
  for (const quote of presentation.quotes) {
    const location = locate(body, quote);
    if (!location) { recordIssue('quote_unresolved'); continue; }
    const literal = LITERAL.exec(quote.text);
    if (!literal || (literal[2]?.length ?? 0) !== presentation.decimalPlaces ||
        (literal[3] ? !sameDisplayUnit(literal[3], presentation.unit) : !counted)) {
      recordIssue('unsupported_display_format'); continue;
    }
    const displayed = exactNumber(`${literal[1].replace(/,/g, '')}${literal[2] ? `.${literal[2]}` : ''}`);
    if (!displayed) { recordIssue('numeric_value_unavailable'); continue; }
    if (result.locations.some(other => location.start < other.end && location.end > other.start)) {
      recordIssue('binding_conflict'); continue;
    }
    result.locations.push(location);
    if (displayed.numerator === 0n && actual.numerator !== 0n) { recordIssue('nonzero_displayed_as_zero'); continue; }
    if (rounded(displayed, presentation.decimalPlaces) !== expected) recordIssue('display_value_mismatch', 'mismatch');
  }
  return issue ? finish(issue.reason, issue.status) : finish('display_matches', 'matched');
}

/** Always calculated from this candidate's issued captures, never from a model review or stored receipt. */
export function assessNumericPresentations(input: {
  contract?: ConclusionContract; claims: readonly ClaimVerificationClaimResult[];
  support: readonly ClaimSupportV1[]; body: string; candidate: AnalysisCandidateIdentity;
}): ReadonlyMap<string, NumericPresentationAssessment> {
  const results = new Map<string, NumericPresentationAssessment>();
  const declarations = input.contract?.claims ?? [];
  for (const claim of declarations) {
    const presentation = claim.semantics?.numeric?.presentation;
    if (!presentation || !claim.id || declarations.filter(other => other.id === claim.id).length !== 1) continue;
    const priors = input.claims.filter(other => other.claimId === claim.id);
    const supports = input.support.filter(other => other.claimId === claim.id);
    results.set(claim.id, assess({claim, body: input.body, candidate: input.candidate,
      prior: priors.length === 1 ? priors[0] : undefined, support: supports.length === 1 ? supports[0] : undefined}, presentation));
  }
  // The same body token cannot silently serve conflicting claim bindings.
  const intervals = [...results.values()].flatMap(result => result.locations.map(location => ({result, ...location})))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  for (let index = 1; index < intervals.length; index++) {
    const previous = intervals[index - 1], current = intervals[index];
    if (previous.end <= current.start || previous.result === current.result) continue;
    for (const entry of [previous, current]) {
      if (entry.result.status === 'mismatch') continue;
      entry.result.status = 'not_checked';
      entry.result.reason = 'binding_conflict';
    }
  }
  return results;
}
