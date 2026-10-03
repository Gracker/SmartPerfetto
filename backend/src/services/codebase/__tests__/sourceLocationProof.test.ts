// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {ClaimSemanticsV1, ConclusionContract} from '../../../agent/core/conclusionContract';
import type {ClaimVerificationResult} from '../../../types/claimVerification';
import {
  collectMatchedTraceEvidenceRefIdsByClaimId,
  collectVerifiedTraceOccurrenceRefIdsByClaimId,
} from '../../verifier/claimVerificationRunner';
import {applySourceLocationProofs} from '../sourceLocationProof';
import {sanitizeSourceReference, type SourceReferenceV1, type SourceUseDecisionV1} from '../sourceUseDecision';

function reference(overrides: Partial<SourceReferenceV1> = {}): SourceReferenceV1 {
  return sanitizeSourceReference({referenceId: 'current-lookup', codebaseId: 'app-source',
    filePath: 'src/main/Foo.kt', lineRange: {start: 10, end: 20}, lookupKind: 'body', ...overrides})!;
}

function fixture(source = reference()) {
  const semantics: ClaimSemanticsV1 = {schemaVersion: 'claim_semantics@1', predicate: 'source.location',
    polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
    scope: {population: 'codebase'}, source: {sourceReferenceId: source.id,
      filePath: source.filePath, lineRange: {...(source.lineRange ?? {start: 10, end: 20})}}};
  const contract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], bindingEligibility: 'eligible',
    claims: [{id: 'location', kind: 'identity', text: 'The lookup returned src/main/Foo.kt:L10-L20.', references: [], semantics}],
    sourceClaimBindings: [{claimId: 'location', mechanismStatus: 'compatible',
      sourceReferenceIds: [source.id], traceEvidenceRefIds: []}]};
  const sourceUse: SourceUseDecisionV1 = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['app-source'], status: 'located', attemptedTools: ['read_codebase_file'],
    queriedCodebaseIds: ['app-source'], usedCodebaseIds: ['app-source'], references: [source]};
  const draft: ClaimVerificationResult = {schemaVersion: 'claim_verifier@2', status: 'not_checked', policy: 'record_only',
    passed: false, checkedClaimCount: 1, unsupportedClaimCount: 0, issues: [], claimResults: [{claimId: 'location',
      status: 'not_checked', referenceResults: [], referenceCells: [],
      deterministicProof: {kind: 'source_location', status: 'not_checked', reason: 'source_evidence_required',
        anchorIds: [], evidenceRefIds: []},
      propositionCoverage: {status: 'none', covered: [], uncovered: ['typed_proposition'], reason: 'source_evidence_required'}}]};
  return {contract, sourceUse, draft, claim: contract.claims![0], binding: contract.sourceClaimBindings![0]};
}

function expectProof(input: ReturnType<typeof fixture>, status: 'candidate' | 'rejected', reason: string) {
  const result = applySourceLocationProofs(input);
  expect(result.claimResults[0].deterministicProof).toEqual({kind: 'source_location', status, reason,
    anchorIds: [], evidenceRefIds: []});
  expect(result.passed).toBe(false);
  expect(result.claimResults[0].status).toBe(status === 'rejected' ? 'unsupported' : 'partial');
}

describe('applySourceLocationProofs', () => {
  it.each<SourceReferenceV1['lookupKind']>(['body', 'metadata', 'indexed', 'graph'])(
    'proves only the returned %s location snapshot and leaves semantic verification pending', lookupKind => {
      const input = fixture(reference({lookupKind}));
      if (lookupKind === 'metadata') input.sourceUse.codeAwareMode = 'metadata_only';
      const before = structuredClone(input);
      const result = applySourceLocationProofs(input);
      expect(result).toMatchObject({status: 'partial', passed: false, unsupportedClaimCount: 0, issues: [],
        claimResults: [{status: 'partial', referenceResults: [], referenceCells: [],
          deterministicProof: {kind: 'source_location', status: 'proved', reason: 'source_location_snapshot_proved',
            anchorIds: [], evidenceRefIds: []}, propositionCoverage: {status: 'complete', uncovered: []}}]});
      expect(collectMatchedTraceEvidenceRefIdsByClaimId(result)).toEqual({});
      expect(collectVerifiedTraceOccurrenceRefIdsByClaimId(result)).toEqual({});
      expect(input).toEqual(before);
    });

  it('accepts a categorical location and a positive hit from incomplete search', () => {
    const input = fixture(reference({filePath: '应用 模块/Foo.kt'}));
    input.claim.kind = 'categorical';
    input.sourceUse.status = 'search_incomplete';
    input.sourceUse.coverageComplete = false;
    input.sourceUse.incompleteReasons = ['time_budget'];
    expect(applySourceLocationProofs(input).claimResults[0].deterministicProof?.status).toBe('proved');
  });

  it.each(['path', 'start', 'end'] as const)('rejects an original %s that differs from the returned tuple', field => {
    const input = fixture();
    if (field === 'path') input.claim.semantics!.source!.filePath = 'src/main/Other.kt';
    else input.claim.semantics!.source!.lineRange[field] += 1;
    expectProof(input, 'rejected', 'source_location_tuple_mismatch');
  });

  it('does not infer a missing declared line range from source metadata', () => {
    const input = fixture();
    delete (input.claim.semantics!.source as Partial<NonNullable<ClaimSemanticsV1['source']>>).lineRange;
    expectProof(input, 'candidate', 'source_location_declaration_missing');
  });

  it('does not infer a missing returned line range from the declaration', () => {
    expectProof(fixture(reference({lineRange: undefined})), 'candidate', 'source_location_reference_range_unavailable');
  });

  it('ignores a model-authored ledger without a current accessor ledger', () => {
    const input = fixture();
    input.contract.sourceUseDecision = input.sourceUse;
    input.contract.sourceReferences = input.sourceUse.references;
    const result = applySourceLocationProofs({...input, sourceUse: undefined});
    expect(result.claimResults[0].deterministicProof).toMatchObject({status: 'candidate',
      reason: 'source_location_current_ledger_unavailable'});
  });

  it('rejects an old reference even when the model copies it into declared sourceReferences', () => {
    const input = fixture();
    input.contract.sourceReferences = input.sourceUse.references;
    // The file was read again after it changed: a different reference.
    input.sourceUse.references = [reference({sourceGeneration: 'live-new'})];
    expectProof(input, 'rejected', 'source_location_reference_not_returned');
  });

  it.each(['selected', 'queried'] as const)('requires the returned codebase in the current %s partition', field => {
    const input = fixture();
    if (field === 'selected') input.sourceUse.selectedCodebaseIds = ['other-source'];
    else input.sourceUse.queriedCodebaseIds = [];
    expectProof(input, 'rejected', 'source_location_reference_outside_current_query');
  });

  it('rejects a forged ledger identifier instead of repairing it with the sanitizer', () => {
    const input = fixture();
    input.sourceUse.references[0].id = 'forged-id';
    input.claim.semantics!.source!.sourceReferenceId = 'forged-id';
    input.binding.sourceReferenceIds = ['forged-id'];
    expectProof(input, 'rejected', 'source_location_reference_invalid');
  });

  it.each(['claim', 'draft', 'binding', 'sourceId', 'ledgerReference'] as const)(
    'rejects duplicate %s identities without collapsing them', field => {
      const input = fixture();
      if (field === 'claim') input.contract.claims!.push(structuredClone(input.claim));
      if (field === 'draft') input.draft.claimResults.push(structuredClone(input.draft.claimResults[0]));
      if (field === 'binding') input.contract.sourceClaimBindings!.push(structuredClone(input.binding));
      if (field === 'sourceId') input.binding.sourceReferenceIds.push(input.binding.sourceReferenceIds[0]);
      if (field === 'ledgerReference') input.sourceUse.references.push(structuredClone(input.sourceUse.references[0]));
      const reason = field === 'claim' || field === 'draft' ? 'source_location_claim_identity_invalid'
        : field === 'ledgerReference' ? 'source_location_reference_not_returned' : 'source_location_binding_invalid';
      expectProof(input, 'rejected', reason);
    });

  it.each(['absent', 'empty', 'other_claim'] as const)('proves an exact location with %s root bindings', mode => {
    const input = fixture();
    if (mode === 'absent') delete input.contract.sourceClaimBindings;
    if (mode === 'empty') input.contract.sourceClaimBindings = [];
    if (mode === 'other_claim') input.binding.claimId = 'other-claim';
    const before = structuredClone(input);
    const result = applySourceLocationProofs(input);
    expect(result).toMatchObject({status: 'partial', passed: false, issues: [], claimResults: [{
      status: 'partial', deterministicProof: {kind: 'source_location', status: 'proved',
        reason: 'source_location_snapshot_proved', anchorIds: [], evidenceRefIds: []},
    }]});
    expect(input).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(input.contract, 'sourceClaimBindings')).toBe(mode !== 'absent');
  });

  it.each(['wrongSourceId', 'traceBinding'] as const)('rejects %s', field => {
    const input = fixture();
    if (field === 'wrongSourceId') input.binding.sourceReferenceIds = ['different-id'];
    if (field === 'traceBinding') input.binding.traceEvidenceRefIds = ['data:trace'];
    expectProof(input, 'rejected', 'source_location_binding_invalid');
  });

  it.each([null, {claimId: 'location'}, {claimId: 'location', sourceReferenceIds: [], traceEvidenceRefIds: ''}])(
    'rejects malformed original bindings without sanitizing away their invalidity: %j', binding => {
      const input = fixture();
      input.contract.sourceClaimBindings = [binding] as unknown as ConclusionContract['sourceClaimBindings'];
      expectProof(input, 'rejected', 'source_location_binding_invalid');
    });

  it.each([undefined, null, {}, 'bindings', 1, [null], [{}], new Array(1)])(
    'rejects malformed whole roots before considering a missing matching binding: %j', value => {
      const input = fixture();
      input.contract.sourceClaimBindings = value as ConclusionContract['sourceClaimBindings'];
      expectProof(input, 'rejected', 'source_location_binding_invalid');
    });

  it.each(['unrelated_null', 'unrelated_missing_arrays', 'source_hole', 'trace_hole',
    'claim_whitespace', 'source_whitespace', 'trace_whitespace', 'invalid_status', 'invalid_reason', 'extra_field'] as const)(
    'does not hide malformed %s declarations among other claim bindings', field => {
      const input = fixture();
      const other: Record<string, unknown> = {...input.binding, claimId: 'other-claim'};
      if (field === 'unrelated_missing_arrays') delete other.sourceReferenceIds;
      if (field === 'source_hole') other.sourceReferenceIds = new Array(1);
      if (field === 'trace_hole') other.traceEvidenceRefIds = new Array(1);
      if (field === 'claim_whitespace') other.claimId = ' other-claim ';
      if (field === 'source_whitespace') other.sourceReferenceIds = [` ${input.binding.sourceReferenceIds[0]} `];
      if (field === 'trace_whitespace') other.traceEvidenceRefIds = [' trace-id '];
      if (field === 'invalid_status') other.mechanismStatus = 'proved';
      if (field === 'invalid_reason') other.reason = {};
      if (field === 'extra_field') other.verified = true;
      input.contract.sourceClaimBindings = [input.binding, field === 'unrelated_null' ? null : other] as
        ConclusionContract['sourceClaimBindings'];
      expectProof(input, 'rejected', 'source_location_binding_invalid');
    });

  it.each(['bindings', 'source_ids', 'trace_ids'] as const)('rejects %s beyond the existing declaration budget', field => {
    const input = fixture();
    if (field === 'bindings') input.contract.sourceClaimBindings = Array.from({length: 101}, () => ({...input.binding, claimId: 'other'}));
    if (field === 'source_ids') input.binding.sourceReferenceIds = Array(101).fill(input.binding.sourceReferenceIds[0]);
    if (field === 'trace_ids') input.binding.traceEvidenceRefIds = Array(101).fill('trace-id');
    expectProof(input, 'rejected', 'source_location_binding_invalid');
  });

  it.each(['rawSemantics', 'rawReferences', 'parseIssue', 'ineligible', 'legacy'] as const)(
    'does not grant proof to %s declarations', field => {
      const input = fixture();
      if (field === 'rawSemantics') input.claim.rawSemantics = {};
      if (field === 'rawReferences') input.claim.rawReferences = [];
      if (field === 'parseIssue') input.claim.semanticsParseIssues = [{code: 'invalid_semantics', path: 'semantics'}];
      if (field === 'ineligible') input.contract.bindingEligibility = 'ineligible';
      if (field === 'legacy') input.contract.bindingEligibility = 'legacy_unchecked';
      expectProof(input, 'rejected', field === 'ineligible' || field === 'legacy'
        ? 'source_location_binding_ineligible' : 'source_location_declaration_invalid');
    });

  it.each(['causal', 'numeric', 'inference', 'recommendation'] as const)('cannot turn a %s claim into location proof', kind => {
    const input = fixture();
    input.claim.kind = kind;
    expectProof(input, 'candidate', 'source_location_proposition_unsupported');
  });

  it.each(['negative', 'possible', 'hypothetical', 'all', 'condition', 'traceScope', 'timeRange', 'numeric'] as const)(
    'leaves the broader %s proposition unproved', field => {
      const input = fixture();
      const semantics = input.claim.semantics!;
      if (field === 'negative') semantics.polarity = 'negated';
      if (field === 'possible') semantics.modality = 'possible';
      if (field === 'hypothetical') semantics.discourse = 'hypothetical';
      if (field === 'all') semantics.quantifier = 'all';
      if (field === 'condition') semantics.conditions = ['The process executes the function.'];
      if (field === 'traceScope') semantics.scope.population = 'trace';
      if (field === 'timeRange') semantics.scope.timeRangeNs = {start: '1', end: '2'};
      if (field === 'numeric') semantics.numeric = {operator: 'eq', value: 42, unit: 'ms'};
      expectProof(input, 'candidate', 'source_location_proposition_unsupported');
    });

  it.each(['references', 'artifactRefs', 'relationRefs', 'subjectRefs', 'objectRefs'] as const)(
    'does not erase %s to fit the location rule', field => {
      const input = fixture();
      if (field === 'references') input.claim.references = [{sourceRef: input.binding.sourceReferenceIds[0]}];
      if (field === 'artifactRefs') input.claim.artifactRefs = [{artifactId: 'artifact'}];
      if (field === 'relationRefs') input.claim.relationRefs = ['relation'];
      if (field === 'subjectRefs' || field === 'objectRefs') input.claim.semantics!.scope[field] = [{evidenceRefId: 'data:trace'}];
      expectProof(input, 'candidate', 'source_location_trace_references_not_permitted');
    });

  it.each(['source.existence', 'code.calls', 'numeric.cell'])('does not add proof for %s', predicate => {
    const input = fixture();
    input.claim.semantics!.predicate = predicate;
    expect(applySourceLocationProofs(input)).toBe(input.draft);
  });

  it('does not upgrade a source placeholder carrying unrelated matched Trace results', () => {
    const input = fixture();
    input.draft.claimResults[0].referenceCells = [{evidenceRefId: 'data:trace', status: 'matched'}];
    expectProof(input, 'candidate', 'source_location_trace_references_not_permitted');
    expect(applySourceLocationProofs(input).claimResults[0].referenceCells).toEqual(input.draft.claimResults[0].referenceCells);
  });

  it.each(['unsupported', 'rejected', 'error', 'missing', 'globalError', 'unknownPredicate'] as const)(
    'preserves an existing %s draft without any promotion', field => {
      const input = fixture();
      const prior = input.draft.claimResults[0];
      if (field === 'unsupported') prior.status = 'unsupported';
      if (field === 'rejected') prior.deterministicProof!.status = 'rejected';
      if (field === 'error' || field === 'globalError') input.draft.issues = [{claimId: field === 'error' ? 'location' : '',
        severity: 'error', code: 'original_error', message: 'Keep the original error.'}];
      if (field === 'missing') prior.referenceCells = [{status: 'missing', message: 'evidence_not_retained'}];
      if (field === 'unknownPredicate') prior.deterministicProof = {kind: 'none', status: 'candidate',
        reason: 'unsupported_predicate', anchorIds: [], evidenceRefIds: []};
      expect(applySourceLocationProofs(input)).toBe(input.draft);
    });

  it('preserves errors for a different claim while proving the location draft', () => {
    const input = fixture();
    input.draft.status = 'failed';
    input.draft.claimResults.push({claimId: 'other', status: 'unsupported'});
    input.draft.issues = [{claimId: 'other', severity: 'error', code: 'claim_reference_missing', message: 'Missing trace.'}];
    const result = applySourceLocationProofs(input);
    expect(result).toMatchObject({status: 'failed', passed: false, unsupportedClaimCount: 1,
      claimResults: [{claimId: 'location', deterministicProof: {status: 'proved'}}, {claimId: 'other', status: 'unsupported'}],
      issues: input.draft.issues});
  });
});
