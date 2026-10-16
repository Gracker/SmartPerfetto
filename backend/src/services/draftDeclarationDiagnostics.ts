// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {MAX_CLAIM_DIAGNOSTICS, MAX_CONCLUSION_STRUCTURE_DETAILS, copyConclusionClaimDiagnostic,
  isConclusionClaimDiagnostic, isConclusionContractStructureDetail, isConclusionRelationProposalDiagnostic,
  isConclusionRootParseIssue, parseConclusionContractDeclaration,
  type ConclusionContractClaimReference} from '../agent/core/conclusionContract';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import {claimUnitFor} from '../utils/claimUnits';
import {prepareClaimEvidence, evidenceReferenceKey, preparedReferenceResolution} from './evidence/claimEvidencePreparation';
import {getCapturedAnchorFacts} from './evidence/evidenceCapture';
import {MAX_EVIDENCE_READ_REFERENCES, type EvidenceReadView} from './evidence/evidenceReadView';
import {isIssuedInvestigationEvidenceSnapshot} from './evidence/investigationEvidenceLedger';
import {assessNumericPresentations} from './numericPresentationAssessment';
import {runClaimVerification} from './verifier/claimVerificationRunner';

export const DRAFT_DECLARATION_MAX_BYTES = 65_536;
const boundary = {diagnosticOnly: true, coverageNotChecked: true, finalCertification: false} as const;
type DiagnosticInput = {body: unknown; declarationJson: unknown; runId?: string; sessionId?: string;
  readView?: EvidenceReadView; signal?: AbortSignal; assertCurrent?: () => void};
export const draftDiagnosticOwnerKey = (runId: string, sessionId: string) =>
  `draft-declaration:${analysisDeliveryFingerprint({runId, sessionId})}`;

// Diagnostic projection only: these existing read codes do not classify proof
// or authorize a fallback. Unknown producer strings never cross this boundary.
const REFERENCE_FAILURE_CODES = new Set([
  'binding_ineligible', 'execution_read_unavailable', 'execution_read_failed', 'read_cancelled',
  'read_budget_exhausted', 'multiple_evidence_records', 'identifier_conflict', 'evidence_not_retained',
  'execution_witness_mismatch', 'trace_capture_mismatch', 'trace_outside_read_scope',
  'execution_witness_unavailable', 'unmapped_evidence_shape', 'invalid_evidence_columns',
  'unmapped_evidence_columns', 'display_transformation_unmapped', 'unsupported_raw_cell',
  'execution_unavailable', 'execution_skipped', 'duplicate_evidence_columns', 'invalid_metadata_locator',
  'evidence_read_size_or_deadline_exhausted', 'invalid_row_index', 'invalid_row_selector',
  'selector_scan_incomplete', 'cell_read_budget_exhausted', 'row_selector_not_unique', 'row_selector_not_found', 'row_index_selector_conflict',
  'row_locator_required', 'row_index_out_of_range', 'required_column_missing',
  'whole_result_identity_scan_incomplete', 'whole_result_identity_cell_unreadable', 'whole_result_identity_conflict',
]);
const IDENTIFIER_FIELDS = ['evidenceRefId', 'artifactId', 'sourceArtifactId', 'sourceToolCallId', 'sourceRef'] as const;
const identifierFields = (fields: readonly string[] | undefined) => Array.isArray(fields)
  ? IDENTIFIER_FIELDS.filter(field => fields.includes(field)) : [];

/** Only local diagnostics: no semantic call, acquisition, completion, persistence or candidate admission. */
export async function diagnoseConclusionDraft(input: DiagnosticInput) {
  const unavailable = (reason: string) => ({...boundary, state: 'unavailable' as const, reason});
  if (!input.runId?.trim() || !input.sessionId?.trim()) return unavailable('run_context_missing');
  if (!input.readView) return unavailable('evidence_store_missing');
  if (input.signal?.aborted) return unavailable('cancelled');
  // Authorization errors must propagate; a caller must never swallow a revoked fence.
  input.assertCurrent?.();
  const scope = input.readView.investigationEvidence?.();
  if (!isIssuedInvestigationEvidenceSnapshot(scope) || scope.currentRunId !== input.runId ||
      scope.ownerKey !== draftDiagnosticOwnerKey(input.runId, input.sessionId)) return unavailable('read_context_mismatch');
  const {body, declarationJson} = input;
  if (typeof body !== 'string' || typeof declarationJson !== 'string')
    return {...boundary, state: 'invalid_input' as const, reason: 'input_type_invalid'};
  const inputBudget = {bodyBytes: Buffer.byteLength(body, 'utf8'),
    declarationBytes: Buffer.byteLength(declarationJson, 'utf8'), maxBytes: DRAFT_DECLARATION_MAX_BYTES,
    emptyBody: !body.trim()};
  if (inputBudget.emptyBody || inputBudget.bodyBytes > inputBudget.maxBytes || inputBudget.declarationBytes > inputBudget.maxBytes)
    return {...boundary, state: 'invalid_input' as const, reason: 'input_budget_or_body_invalid', inputBudget};
  let raw: unknown;
  try {raw = JSON.parse(declarationJson);} catch (error) {
    const position = error instanceof SyntaxError
      ? /\bat position (\d+)(?: \(line \d+ column \d+\))?$/.exec(error.message)?.[1] : undefined;
    const offset = position === undefined ? undefined : Number(position);
    const syntaxDiagnostic = {payloadChars: declarationJson.length,
      ...(offset !== undefined && Number.isSafeInteger(offset) && offset >= 0 && offset <= declarationJson.length
        ? {offsetUtf16: offset} : {})};
    return {...boundary, state: 'invalid_input' as const, reason: 'invalid_json', syntaxDiagnostic};
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as {claims?: unknown}).claims) &&
      (raw as {claims: unknown[]}).claims.length > MAX_EVIDENCE_READ_REFERENCES)
    return {...boundary, state: 'invalid_input' as const, reason: 'claim_budget_exhausted'};
  const parsed = parseConclusionContractDeclaration(raw);
  const schemaDiagnostics = parsed.issues.slice(0, MAX_CLAIM_DIAGNOSTICS).map(issue => ({
    code: issue.code, path: issue.path,
    ...(issue.code === 'invalid_contract' && issue.details ? {details: issue.details
      .filter(isConclusionContractStructureDetail).slice(0, MAX_CONCLUSION_STRUCTURE_DETAILS).map(detail => ({...detail}))} : {}),
    ...(isConclusionClaimDiagnostic(issue.claimDiagnostic) && issue.claimDiagnostic.code === issue.code
      ? {claimDiagnostic: copyConclusionClaimDiagnostic(issue.claimDiagnostic)} : {}),
    ...(issue.code === 'invalid_relation_proposal' && isConclusionRelationProposalDiagnostic(issue.relationProposalDiagnostic)
      ? {relationProposalDiagnostic: {...issue.relationProposalDiagnostic}} : {}),
  }));
  if (!parsed.contract || parsed.issues.some(isConclusionRootParseIssue))
    return {...boundary, state: 'invalid_input' as const, reason: 'invalid_declaration', schemaDiagnostics};
  const contract = parsed.contract;
  const preparedEvidence = await prepareClaimEvidence({conclusionContract: contract, bindingEligibility: 'eligible',
    evidenceReadView: input.readView, signal: input.signal});
  if (input.signal?.aborted) return unavailable('cancelled');
  input.assertCurrent?.();
  const finite = runClaimVerification({conclusionContract: contract, preparedEvidence, bindingEligibility: 'eligible'});
  const presentations = assessNumericPresentations({contract, claims: finite.claimVerificationResult.claimResults,
    support: finite.claimSupport, body, candidate: {runId: input.runId,
      attemptId: 'draft-diagnostic', candidateRef: 'draft-diagnostic', conclusionFingerprint: analysisDeliveryFingerprint(body)}});
  const diagnostics = finite.claimVerificationResult.claimResults.map((claim, index) => {
    const declaration = contract.claims?.[index];
    const support = finite.claimSupport.find(item => item.claimId === claim.claimId);
    const subjects = declaration?.semantics?.scope.subjectRefs;
    const subject = declaration?.kind === 'numeric' && subjects?.length === 1 ? subjects[0] : undefined;
    const producerUnits = [...new Set((support?.anchors ?? []).flatMap(anchor => {
      const facts = getCapturedAnchorFacts(anchor);
      if (!facts || !subject?.column || facts.referenceKey !== evidenceReferenceKey(subject) ||
          (subject.rowIndex !== undefined && subject.rowIndex !== facts.originalRowIndex) ||
          !anchor.cells?.some(cell => cell.column === subject.column)) return [];
      const field = facts.fields[subject.column];
      return field?.origin.definitionFingerprint && ['skill_literal', 'native_producer'].includes(field.origin.kind) &&
        claimUnitFor(field.unit) ? [field.unit!] : [];
    }))];
    const presentation = presentations.get(claim.claimId);
    const quoteOccurrences = (declaration?.semantics?.numeric?.presentation?.quotes ?? []).map((quote, quoteIndex) => {
      let exactSubstringOccurrences = 0;
      for (let offset = body.indexOf(quote.text); offset >= 0 && exactSubstringOccurrences < 17;
        offset = body.indexOf(quote.text, offset + quote.text.length)) exactSubstringOccurrences++;
      return {quoteIndex, exactSubstringOccurrences, ...(exactSubstringOccurrences === 17 ? {truncated: true} : {})};
    });
    const referenceReasons = [...new Set((claim.referenceResults ?? []).filter(reference => reference.status !== 'matched')
      .map(reference => reference.status))];
    const collections: readonly [string, readonly ConclusionContractClaimReference[] | undefined][] = [
      ['references', declaration?.references],
      ['artifactRefs', declaration?.artifactRefs as readonly ConclusionContractClaimReference[] | undefined],
      ['subjectRefs', subjects], ['objectRefs', declaration?.semantics?.scope.objectRefs],
    ];
    const referenceDiagnostics = collections.flatMap(([collection, references]) => (references ?? []).flatMap((ref, ordinal) => {
      const resolution = preparedReferenceResolution(preparedEvidence, ref);
      if (!resolution || resolution.status === 'resolved' ||
          !['missing', 'ambiguous', 'incomplete', 'denied'].includes(resolution.status)) return [];
      const matchedFields = identifierFields(resolution.locatorDetail?.matchedFields);
      const conflictingFields = identifierFields(resolution.locatorDetail?.conflictingFields);
      return [{collection, referenceOrdinal: ordinal + 1, status: resolution.status,
        ...(REFERENCE_FAILURE_CODES.has(resolution.reason) ? {reason: resolution.reason} : {}),
        ...(matchedFields.length ? {matchedFields} : {}), ...(conflictingFields.length ? {conflictingFields} : {})}];
    }));
    const diagnostic = {claimOrdinal: index + 1, claimId: claim.claimId.slice(0, 128),
      finiteReason: claim.deterministicProof?.reason ?? 'not_checked', referenceReasons, producerUnits,
      referenceDiagnostics: referenceDiagnostics.slice(0, MAX_CLAIM_DIAGNOSTICS),
      ...(referenceDiagnostics.length > MAX_CLAIM_DIAGNOSTICS
        ? {omittedReferenceDiagnosticCount: referenceDiagnostics.length - MAX_CLAIM_DIAGNOSTICS} : {}),
      ...(presentation ? {presentationReason: presentation.reason, quoteOccurrences} : {})};
    return {diagnostic, needsAttention: claim.deterministicProof?.status !== 'proved' ||
      referenceReasons.length > 0 || referenceDiagnostics.length > 0 ||
      (presentation !== undefined && presentation.reason !== 'display_matches')};
  });
  // Unproved candidates need feedback too; prioritizing them never invalidates
  // or rewrites a declaration. This is bounded feedback, never coverage.
  diagnostics.sort((left, right) => Number(right.needsAttention) - Number(left.needsAttention));
  return {...boundary, state: 'diagnosed' as const, schemaDiagnostics,
    evaluatedClaimCount: finite.claimVerificationResult.claimResults.length,
    omittedDiagnosticCount: Math.max(0, diagnostics.length - MAX_CLAIM_DIAGNOSTICS),
    diagnostics: diagnostics.slice(0, MAX_CLAIM_DIAGNOSTICS).map(item => item.diagnostic)};
}
