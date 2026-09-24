// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {parseConclusionContractDeclaration, type ClaimSemanticsV1, type ConclusionContract,
  type ConclusionContractClaimReference} from '../../../agent/core/conclusionContract';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import type {ClaimSupportV1, EvidenceAnchorV1} from '../../../types/evidenceContract';
import type {EvidenceScopeRole} from '../../../types/identityContract';
import {createDataEnvelope} from '../../../types/dataContract';
import {
  bindCapturedAnchorFacts,
  captureEvidenceTable,
  getCapturedAnchorFacts,
  type CapturedFieldSemantics,
  type EvidenceScalar,
} from '../../evidence/evidenceCapture';
import {evidenceReferenceKey, prepareClaimEvidence, preparedReferenceResolution} from '../../evidence/claimEvidencePreparation';
import {buildEvidenceContract} from '../../evidence/evidenceContractBuilder';
import {runDeterministicClaimVerifier, SUPPORTED_DETERMINISTIC_CLAIM_RULES} from '../deterministicClaimVerifier';

const literal = (overrides: Partial<CapturedFieldSemantics> = {}): CapturedFieldSemantics => ({
  origin: {kind: 'skill_literal', definitionFingerprint: 'pinned-definition', skillId: 'test_skill', stepId: 'metric'},
  unit: 'ms',
  ...overrides,
});

interface AnchorInput {
  id?: string;
  row: Record<string, EvidenceScalar>;
  fields?: Record<string, CapturedFieldSemantics>;
  column?: string;
  expected?: EvidenceScalar;
  side?: 'current' | 'reference';
  trace?: string;
  role?: EvidenceScopeRole;
  captured?: boolean;
  beforeCapture?: (anchor: EvidenceAnchorV1) => void;
}

function anchor(input: AnchorInput): EvidenceAnchorV1 {
  const id = input.id || 'metric';
  const traceSide = input.side || 'current';
  const traceId = input.trace || `trace-${traceSide}`;
  const columns = Object.keys(input.row);
  const result: EvidenceAnchorV1 = {
    anchorId: `anchor:${id}`,
    version: 'evidence_contract@1',
    evidenceRefId: `data:${id}`,
    context: {traceId, traceSide, producerKind: 'invoke_skill', sourceToolCallId: `tool:${id}`, artifactId: `artifact:${id}`},
    ...(input.column ? {cells: [{
      column: input.column,
      rowIndex: 0,
      sourceRef: `ref:${id}:${input.column}`,
      ...(Object.prototype.hasOwnProperty.call(input, 'expected') ? {value: input.expected} : {}),
    }]} : {}),
    scopeProvenance: {version: 'process_scope_evidence@1', entries: [{
      role: input.role || 'target',
      scope: {mode: 'unscoped', traceId, traceSide},
      fields: columns,
      availability: 'available',
    }]},
  };
  input.beforeCapture?.(result);
  if (input.captured !== false) bindCapturedAnchorFacts(result, captureEvidenceTable({columns, rows: [input.row]}, input.fields), 0);
  return result;
}

function reference(target: EvidenceAnchorV1, column?: string): ConclusionContractClaimReference {
  return {evidenceRefId: target.evidenceRefId, artifactId: target.context.artifactId,
    sourceToolCallId: target.context.sourceToolCallId, rowIndex: 0, ...(column ? {column} : {})};
}

function semantics(subject: EvidenceAnchorV1, options: Partial<ClaimSemanticsV1> = {}): ClaimSemanticsV1 {
  return {
    schemaVersion: 'claim_semantics@1',
    predicate: 'numeric.cell',
    discourse: 'asserted',
    polarity: 'affirmed',
    modality: 'certain',
    quantifier: 'one',
    scope: {population: 'cited_rows', subjectRefs: [reference(subject, 'value')]},
    numeric: {operator: 'eq', value: 1000, unit: 'us'},
    ...options,
  };
}

function claim(anchors: EvidenceAnchorV1[], overrides: Partial<ClaimSupportV1> = {}): ClaimSupportV1 {
  return {claimId: 'claim', kind: 'numeric', text: 'A typed proposition', anchors,
    bindingEligibility: 'eligible', supportLevel: 'partial', ...overrides};
}

const verify = (item: ClaimSupportV1) => runDeterministicClaimVerifier({claimSupport: [item]}).claimResults[0];
const metric = (overrides: Partial<AnchorInput> = {}) => anchor({row: {value: 1}, fields: {value: literal()}, column: 'value', expected: 1, ...overrides});

describe('captured.cell finite proof', () => {
  function captured(value: EvidenceScalar, declared: EvidenceScalar = value): ClaimSupportV1 {
    const evidence = anchor({row: {value}, column: 'value', expected: value});
    return claim([evidence], {kind: 'categorical', semantics: semantics(evidence, {
      predicate: 'captured.cell', numeric: undefined,
      scope: {population: 'cited_rows', subjectRefs: [{...reference(evidence, 'value'), value: declared}]},
    })});
  }

  it.each(['main', '', '1', true, false, null])('proves only the original nonnumeric value %j', value => {
    const output = verify(captured(value));
    expect(output.deterministicProof).toMatchObject({kind: 'captured_cell', status: 'proved'});
    expect(output.propositionCoverage).toMatchObject({status: 'complete', covered: expect.arrayContaining(['value'])});
    expect(output.status).toBe('partial'); // Final semantic assessment remains required.
  });

  it.each([
    {actual: 'main', expected: 'Main'}, {actual: 'main', expected: ' main'},
    {actual: true, expected: 'true'}, {actual: null, expected: 'null'},
    {actual: 1, expected: '2'},
  ])('does not coerce or normalize $actual to $expected', ({actual, expected}) => {
    expect(verify(captured(actual, expected)).deterministicProof).toMatchObject({status: 'rejected'});
  });

  it.each([{actual: 1, expected: '1'}, {actual: 858, expected: '858.0'}])(
    'neither proves nor rejects the same number declared as string $expected', ({actual, expected}) => {
      const output = verify(captured(actual, expected));
      expect(output.deterministicProof).toMatchObject({status: 'candidate', reason: 'captured_value_type_mismatch'});
      expect(output.status).not.toBe('unsupported');
    });

  it('cannot use an observed reference value as an omitted proposition or bypass numeric units', () => {
    const missing = captured(null);
    delete missing.semantics!.scope.subjectRefs![0].value;
    expect(verify(missing).deterministicProof.reason).toBe('captured_declaration_missing');
    expect(verify(captured(42)).deterministicProof.reason).toBe('captured_numeric_not_supported');
    const numeric = captured('42');
    numeric.semantics!.numeric = {operator: 'eq', value: 42, unit: 'ms'};
    expect(verify(numeric).deterministicProof.reason).toBe('captured_numeric_not_supported');
  });

  it('requires an explicit column and uniquely captured original row', () => {
    const item = captured('main');
    delete item.semantics!.scope.subjectRefs![0].column;
    expect(verify(item).deterministicProof.reason).toBe('captured_declaration_missing');
    const wrongRow = captured('main');
    wrongRow.semantics!.scope.subjectRefs![0].rowIndex = 1;
    expect(verify(wrongRow).deterministicProof.status).not.toBe('proved');
    const absentColumn = captured(null);
    absentColumn.semantics!.scope.subjectRefs![0].column = 'absent';
    expect(verify(absentColumn).deterministicProof.status).not.toBe('proved');
    const ambiguous = captured('main');
    const duplicate = anchor({row: {value: 'main'}, column: 'value', expected: 'main'});
    ambiguous.anchors.push(duplicate);
    expect(verify(ambiguous).deterministicProof.reason).toBe('semantic_reference_ambiguous');
  });

  it('does not accept deserialized or forged captures', () => {
    const item = captured('main');
    item.anchors = JSON.parse(JSON.stringify(item.anchors));
    expect(verify(item).deterministicProof.status).not.toBe('proved');
  });

  it.each(['numeric', 'causal', 'time_range', 'comparison'] as const)('does not prove %s claims', kind => {
    const item = captured('main');
    item.kind = kind;
    expect(verify(item).deterministicProof.reason).toBe('claim_kind_predicate_mismatch');
  });

  it.each([
    {polarity: 'negated'}, {discourse: 'hypothetical'}, {modality: 'possible'},
    {quantifier: 'all'}, {conditions: ['unless another thread']},
  ] as Partial<ClaimSemanticsV1>[])('preserves qualified or broader propositions %j', overrides => {
    const item = captured('main');
    Object.assign(item.semantics!, overrides);
    expect(verify(item).deterministicProof.status).not.toBe('proved');
  });
});

describe('claim_verifier@2 reference cells', () => {
  it('keeps literal reference equality separate from a complete proposition', () => {
    const evidence = metric();
    const output = runDeterministicClaimVerifier({claimSupport: [claim([evidence])]});
    expect(output.schemaVersion).toBe('claim_verifier@2');
    expect(output.passed).toBe(false);
    expect(output.claimResults[0]).toEqual(expect.objectContaining({
      status: 'partial',
      referenceCells: [expect.objectContaining({status: 'matched'})],
      deterministicProof: expect.objectContaining({status: 'not_checked', reason: 'semantics_not_declared'}),
      propositionCoverage: expect.objectContaining({status: 'partial', uncovered: ['typed_proposition']}),
    }));
    expect(output.claimResults[0].referenceResults).toEqual(output.claimResults[0].referenceCells);
  });

  it.each([
    {raw: true, expected: 'true'},
    {raw: false, expected: 0},
    {raw: null, expected: 'null'},
    {raw: null, expected: 0},
    {raw: 1.0000000000000002, expected: 1},
  ])('does not coerce or epsilon-match $raw against $expected', ({raw, expected}) => {
    const evidence = metric({row: {value: raw}, expected});
    expect(verify(claim([evidence])).referenceCells[0].status).toBe('value_mismatch');
  });

  it.each([
    {raw: 54, expected: '54'},
    {raw: 54, expected: '55'},
    {raw: '54', expected: 54},
    {raw: '54', expected: 55},
  ])('leaves differently encoded string/number references unchecked: $raw against $expected', ({raw, expected}) => {
    const evidence = metric({row: {value: raw}, expected});
    const output = runDeterministicClaimVerifier({claimSupport: [claim([evidence])]});
    expect(output.status).toBe('not_checked');
    expect(output.claimResults[0].referenceCells[0].status).toBe('not_checked');
    expect(output.claimResults[0].deterministicProof.status).toBe('not_checked');
    expect(output.issues).toEqual([]);
    expect(evidence.cells![0].value).toBe(expected);
    expect(getCapturedAnchorFacts(evidence)?.row.value).toBe(raw);
  });

  it('matches captured SQL null without interpreting a display string', () => {
    const evidence = metric({row: {value: null}, expected: null,
      beforeCapture: result => {result.cells![0].displayValue = 'not null';}});
    expect(verify(claim([evidence])).referenceCells[0].status).toBe('matched');
  });

  it('uses the pre-format boolean and full string after display fields change', () => {
    const value = 'x'.repeat(1200);
    const evidence = anchor({row: {flag: false, value}, column: 'value', expected: value,
      beforeCapture: result => {
        result.cells![0].actualValue = value.slice(0, 50);
        result.cells![0].displayValue = '…';
      }});
    expect(verify(claim([evidence])).referenceCells[0].status).toBe('matched');
  });

  it('cannot recover witness authority from copied or serialized anchors', () => {
    const source = metric();
    const copied = structuredClone(source);
    copied.cells![0].actualValue = 1;
    copied.cells![0].displayValue = '1';
    const result = verify(claim([copied], {semantics: semantics(copied)}));
    expect(result.status).not.toBe('verified');
    expect(result.referenceCells[0].status).toBe('not_checked');
    expect(result.deterministicProof.reason).toBe('execution_capture_missing');
  });

  it('denies every positive path for an ineligible binding without calling it contradicted', () => {
    const evidence = metric();
    const output = verify(claim([evidence], {bindingEligibility: 'ineligible', semantics: semantics(evidence)}));
    expect(output.status).toBe('not_checked');
    expect(output.referenceCells.map(cell => cell.status)).toEqual(['ineligible']);
    expect(output.deterministicProof).toEqual(expect.objectContaining({status: 'not_checked', reason: 'binding_ineligible'}));
    expect(output.propositionCoverage.status).toBe('none');
  });

  it('does not prove legacy or missing binding eligibility', () => {
    const evidence = metric();
    for (const bindingEligibility of ['legacy_unchecked', undefined] as const) {
      expect(verify(claim([evidence], {bindingEligibility, semantics: semantics(evidence)})).deterministicProof.reason)
        .toBe('binding_eligibility_unchecked');
    }
  });

  it('preserves invalid provenance even when the row has a private capture', () => {
    const evidence = metric({beforeCapture: result => {
      result.scopeProvenance = {version: 'process_scope_evidence@1', entries: [], invalid: true};
    }});
    const output = verify(claim([evidence], {semantics: semantics(evidence)}));
    expect(output.referenceCells[0].status).toBe('missing');
    expect(output.status).toBe('unsupported');
  });

  it('freezes the bound trace, field roles and locators with the execution witness', () => {
    const evidence = metric();
    expect(() => {evidence.context.traceSide = 'reference';}).toThrow();
    expect(() => {evidence.scopeProvenance!.entries[0].role = 'global_context';}).toThrow();
    expect(() => {evidence.cells![0].rowIndex = 5;}).toThrow();
    expect(verify(claim([evidence], {semantics: semantics(evidence)})).deterministicProof.status).toBe('proved');
  });

  it.each(['global_context', 'peer_context'] as const)('does not borrow target identity from %s relativeTo', role => {
    const evidence = metric({role, beforeCapture: result => {
      result.identity = {status: 'verified', identityRefId: 'identity:target', upid: 42};
      result.scopeProvenance!.entries[0].relativeTo = {mode: 'exact_upid', traceId: 'trace-current',
        traceSide: 'current', upid: 42, identityRefId: 'identity:target'};
    }});
    expect(verify(claim([evidence], {semantics: semantics(evidence)})).referenceCells[0])
      .toEqual(expect.objectContaining({status: 'missing', message: 'evidence_identity_scope_conflict'}));
  });
});

describe('finite numeric.cell proof', () => {
  it.each([
    {nanoseconds: 8_040_000, milliseconds: 8.04, status: 'proved'},
    {nanoseconds: 8_040_000, milliseconds: 804, status: 'rejected'},
    {nanoseconds: 16_700_000, milliseconds: 16.7, status: 'proved'},
    {nanoseconds: 16_700_000, milliseconds: 167, status: 'rejected'},
  ])('checks the declared conversion $nanoseconds ns to $milliseconds ms', ({nanoseconds, milliseconds, status}) => {
    const evidence = metric({row: {value: nanoseconds}, expected: nanoseconds, fields: {value: literal({unit: 'ns'})}});
    const result = verify(claim([evidence], {semantics: semantics(evidence, {
      numeric: {operator: 'eq', value: milliseconds, unit: 'ms'},
    })}));
    expect(result.deterministicProof.status).toBe(status);
  });

  it('converts a literal ms field to us and proves the complete typed proposition', () => {
    const evidence = metric();
    const result = verify(claim([evidence], {semantics: semantics(evidence)}));
    expect(result.status).toBe('partial');
    expect(result.deterministicProof).toEqual(expect.objectContaining({
      kind: 'numeric_cell', status: 'proved', reason: 'numeric_operator_proved', evidenceRefIds: [evidence.evidenceRefId],
    }));
    expect(result.propositionCoverage.status).toBe('complete');
    const draft = runDeterministicClaimVerifier({claimSupport: [claim([evidence], {semantics: semantics(evidence)})]});
    expect(draft.status).toBe('partial');
    expect(draft.passed).toBe(false);
  });

  it.each([
    {operator: 'eq', value: 1000, proved: true},
    {operator: 'ne', value: 999, proved: true},
    {operator: 'lt', value: 1001, proved: true},
    {operator: 'lte', value: 1000, proved: true},
    {operator: 'gt', value: 999, proved: true},
    {operator: 'gte', value: 1000, proved: true},
    {operator: 'eq', value: 999, proved: false},
    {operator: 'gt', value: 1000, proved: false},
  ] as const)('evaluates actual cell $operator $value', ({operator, value, proved}) => {
    const evidence = metric();
    const result = verify(claim([evidence], {semantics: semantics(evidence, {numeric: {operator, value, unit: 'us'}})}));
    expect(result.deterministicProof.status).toBe(proved ? 'proved' : 'rejected');
  });

  it('can prove a numeric proposition with a locator that did not duplicate its expected value', () => {
    const evidence = metric({expected: undefined});
    const result = verify(claim([evidence], {semantics: semantics(evidence)}));
    expect(result.referenceCells[0].status).toBe('not_checked');
    expect(result.status).toBe('partial');
  });

  it('does not treat raw SQL aliases or display unit fields as unit authority', () => {
    const evidence = anchor({row: {dur_ms: 1}, column: 'dur_ms', expected: 1,
      beforeCapture: result => {result.cells![0].unit = 'ms';}});
    const declaration = semantics(evidence, {scope: {population: 'cited_rows', subjectRefs: [reference(evidence, 'dur_ms')]}});
    expect(verify(claim([evidence], {semantics: declaration})).deterministicProof.reason).toBe('unit_authority_unknown');
  });

  it.each(['fortnights', 'constructor', '__proto__'])('keeps unknown unit %s candidate', unit => {
    const evidence = metric({fields: {value: literal({unit})}});
    expect(verify(claim([evidence], {semantics: semantics(evidence)})).deterministicProof.reason).toBe('unit_authority_unknown');
  });

  it('rejects wrong dimensions while keeping unknown values candidate', () => {
    const evidence = metric();
    const mismatch = verify(claim([evidence], {semantics: semantics(evidence, {numeric: {operator: 'eq', value: 1, unit: 'bytes'}})}));
    expect(mismatch.deterministicProof).toEqual(expect.objectContaining({status: 'rejected', reason: 'unit_dimension_mismatch'}));
    const nullValue = metric({row: {value: null}, expected: null});
    expect(verify(claim([nullValue], {semantics: semantics(nullValue)})).deterministicProof.reason).toBe('exact_numeric_value_unavailable');
  });

  it('does not guess rounding and handles decimal exponents with exact arithmetic', () => {
    const precise = metric({row: {value: '0.000001'}, expected: '0.000001'});
    expect(verify(claim([precise], {semantics: semantics(precise, {numeric: {operator: 'eq', value: '1e-3', unit: 'us'}})})).status)
      .toBe('partial');
    const rounded = metric({row: {value: 0.1 + 0.2}, expected: 0.1 + 0.2});
    expect(verify(claim([rounded], {semantics: semantics(rounded, {numeric: {operator: 'eq', value: '0.3', unit: 'ms'}})}))
      .deterministicProof.status).toBe('rejected');
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, '1e1000000', '9'.repeat(513), ' 1 '])('refuses inexact or unbounded value %s', value => {
    const evidence = metric({row: {value}, expected: value});
    expect(verify(claim([evidence], {semantics: semantics(evidence)})).deterministicProof.reason).toBe('exact_numeric_value_unavailable');
  });

  it.each([
    {quantifier: 'all'}, {quantifier: 'some'}, {quantifier: 'only'},
    {polarity: 'negated'}, {polarity: 'undetermined'},
    {discourse: 'hypothetical'}, {discourse: 'quoted'}, {discourse: 'rejected_quote'},
    {modality: 'possible'}, {modality: 'undetermined'}, {conditions: ['if scheduling is unchanged']},
  ] as Partial<ClaimSemanticsV1>[])('does not widen proof to unsupported proposition features %j', patch => {
    const evidence = metric();
    const result = verify(claim([evidence], {semantics: semantics(evidence, patch)}));
    expect(result.deterministicProof.status).toBe('candidate');
    expect(result.propositionCoverage.status).toBe('partial');
    expect(result.status).not.toBe('verified');
  });

  it('does not prove broader populations or an unproved time window', () => {
    const evidence = metric();
    for (const scope of [
      {population: 'trace' as const, subjectRefs: [reference(evidence, 'value')]},
      {population: 'cited_rows' as const, subjectRefs: [reference(evidence, 'value')], timeRangeNs: {start: '1', end: '2'}},
    ]) expect(verify(claim([evidence], {semantics: semantics(evidence, {scope})})).deterministicProof.status).toBe('candidate');
  });

  it('accepts only the frozen predicate and kind without inspecting claim text', () => {
    const evidence = metric();
    for (const predicate of ['numeric_cell', 'Numeric.Cell', 'wakeup', 'constructor']) {
      expect(verify(claim([evidence], {text: 'numeric.cell is exactly 1 ms', semantics: semantics(evidence, {predicate})}))
        .deterministicProof.reason).toBe('unsupported_predicate');
    }
    expect(verify(claim([evidence], {kind: 'causal', semantics: semantics(evidence)})).deterministicProof.reason)
      .toBe('claim_kind_predicate_mismatch');
  });

  it('jointly constrains every semantic reference identifier and locator', () => {
    const evidence = metric();
    const valid = reference(evidence, 'value');
    for (const invalid of [
      {...valid, artifactId: 'other'}, {...valid, sourceArtifactId: 'other'},
      {...valid, sourceToolCallId: 'other'}, {...valid, evidenceRefId: 'other'},
      {...valid, sourceRef: 'other'}, {...valid, rowIndex: 1}, {...valid, rowSelector: {value: '1'}},
      {...valid, column: 'missing'},
    ]) {
      const declaration = semantics(evidence, {scope: {population: 'cited_rows', subjectRefs: [invalid]}});
      expect(verify(claim([evidence], {semantics: declaration})).deterministicProof.reason).toBe('semantic_reference_missing');
    }
  });

  it('rejects ambiguous capture bindings and permits two anchors of the same captured row', () => {
    const first = metric();
    const second = metric();
    expect(verify(claim([first, second], {semantics: semantics(first)})).deterministicProof.reason).toBe('semantic_reference_ambiguous');
    const sharedFirst = metric({captured: false});
    const sharedSecond = metric({captured: false});
    const witness = captureEvidenceTable({columns: ['value'], rows: [[1]]}, {value: literal()});
    bindCapturedAnchorFacts(sharedFirst, witness, 0);
    bindCapturedAnchorFacts(sharedSecond, witness, 0);
    expect(verify(claim([sharedFirst, sharedSecond], {semantics: semantics(sharedFirst)})).deterministicProof.status).toBe('proved');
  });

  it('uses the prepared reference key without reinterpreting a resolved alias', () => {
    const evidence = metric({captured: false});
    const resolvedAlias = {sourceRef: 'Title for row', rowIndex: 0, column: 'value'};
    bindCapturedAnchorFacts(evidence, captureEvidenceTable({columns: ['value'], rows: [[1]]}, {value: literal()}),
      0, undefined, evidenceReferenceKey(resolvedAlias));
    const declaration = semantics(evidence, {scope: {population: 'cited_rows', subjectRefs: [resolvedAlias]}});
    expect(verify(claim([evidence], {semantics: declaration})).deterministicProof.status).toBe('proved');
    expect(verify(claim([evidence], {semantics: semantics(evidence)})).deterministicProof.reason).toBe('semantic_reference_missing');
  });
});

function interval(id: string, start: EvidenceScalar, end: EvidenceScalar, overrides: Partial<AnchorInput> = {}): EvidenceAnchorV1 {
  return anchor({id, row: {start, end}, fields: {
    start: literal({unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'}),
    end: literal({unit: 'ns', timeRole: 'end', clock: 'trace_monotonic'}),
  }, ...overrides});
}

function overlap(subject: EvidenceAnchorV1, object: EvidenceAnchorV1, patch: Partial<ClaimSupportV1> = {}): ClaimSupportV1 {
  return claim([subject, object], {kind: 'time_range', semantics: semantics(subject, {
    predicate: 'interval.overlap', numeric: undefined,
    scope: {population: 'cited_rows', subjectRefs: [reference(subject)], objectRefs: [reference(object)]},
  }), ...patch});
}

describe('finite interval.overlap proof', () => {
  it('proves large integer ns strings without losing precision', () => {
    const subject = interval('subject', '9007199254740993000', '9007199254740993020');
    const object = interval('object', '9007199254740993019', '9007199254740993030');
    const result = verify(overlap(subject, object));
    expect(result.status).toBe('partial');
    expect(result.deterministicProof).toEqual(expect.objectContaining({kind: 'interval_overlap', status: 'proved'}));
  });

  it('does not count touching half-open boundaries as overlap', () => {
    const result = verify(overlap(interval('subject', '9007199254740993000', '9007199254740993020'),
      interval('object', '9007199254740993020', '9007199254740993030')));
    expect(result.deterministicProof.reason).toBe('half_open_intervals_disjoint');
    expect(result.status).toBe('unsupported');
  });

  it('uses literal start plus duration and exact unit conversion', () => {
    const subject = anchor({id: 'subject', row: {begin: '0.000001', length: '0.000002'}, fields: {
      begin: literal({timeRole: 'start', clock: 'trace_monotonic'}),
      length: literal({timeRole: 'duration', clock: 'trace_monotonic'}),
    }});
    expect(verify(overlap(subject, interval('object', 2, 4))).deterministicProof.status).toBe('proved');
  });

  it.each([
    {row: {start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 3}},
    {row: {start: '0.1', end: '1.1'}},
    {fields: {start: literal({unit: 'ns'}), end: literal({unit: 'ns'})}},
    {fields: {start: literal({unit: 'ns', timeRole: 'start'}), end: literal({unit: 'ns', timeRole: 'end'})}},
  ] as Partial<AnchorInput>[])('keeps unknown roles, unsafe integers and sub-ns intervals candidate %j', patch => {
    expect(verify(overlap(interval('subject', 1, 3, patch), interval('object', 2, 4))).deterministicProof.status).toBe('candidate');
  });

  it('does not borrow an inferred timeRange or serialized interval metadata', () => {
    const subject = anchor({id: 'subject', row: {ts: 1, dur: 5}, beforeCapture: result => {
      result.timeRange = {startTs: 1, endTs: 6, unit: 'ns', source: 'row'};
    }});
    expect(verify(overlap(subject, interval('object', 2, 4))).deterministicProof.reason).toBe('interval_time_roles_unknown');
  });

  it('does not borrow time fields excluded by the anchor scope projection', () => {
    const subject = interval('subject', 1, 3, {beforeCapture: result => {
      result.scopeProvenance!.entries[0].fields = ['start'];
    }});
    expect(verify(overlap(subject, interval('object', 2, 4))).deterministicProof.reason).toBe('interval_field_scope_unknown');
  });

  it.each([{start: 1, end: 1}, {start: 4, end: 1}, {start: -1, end: 2}])('rejects invalid intervals %j', row => {
    expect(verify(overlap(interval('subject', row.start, row.end), interval('object', 2, 4))).deterministicProof.reason)
      .toBe('interval_range_invalid');
  });

  it('rejects inconsistent literal end and duration', () => {
    const subject = interval('subject', 1, 3, {row: {start: 1, end: 3, duration: 7}, fields: {
      start: literal({unit: 'ns', timeRole: 'start', clock: 'trace_monotonic'}),
      end: literal({unit: 'ns', timeRole: 'end', clock: 'trace_monotonic'}),
      duration: literal({unit: 'ns', timeRole: 'duration', clock: 'trace_monotonic'}),
    }});
    expect(verify(overlap(subject, interval('object', 2, 4))).deterministicProof.reason).toBe('interval_range_invalid');
  });

  it.each([{trace: 'other-trace'}, {side: 'reference' as const}])('rejects trace or side mixing %j', patch => {
    expect(verify(overlap(interval('subject', 1, 3), interval('object', 2, 4, patch))).deterministicProof.reason)
      .toBe('interval_trace_context_mismatch');
  });

  it('never promotes overlap into causality', () => {
    expect(verify(overlap(interval('subject', 1, 3), interval('object', 2, 4), {kind: 'causal'})).status).toBe('inference');
  });
});

const comparable = (patch: Partial<CapturedFieldSemantics> = {}) => literal({metricId: 'cpu.time', aggregation: 'sum',
  populationKey: 'declared_window_and_population', ...patch});
function comparison(current: EvidenceAnchorV1, prior: EvidenceAnchorV1): ClaimSupportV1 {
  return claim([current, prior], {kind: 'comparison', semantics: semantics(current, {
    predicate: 'comparison.delta', numeric: {operator: 'eq', value: 1000, unit: 'us'},
    scope: {population: 'cited_rows', subjectRefs: [reference(current, 'value')], objectRefs: [reference(prior, 'value')]},
  })});
}
const pair = () => [metric({id: 'current', row: {value: 2}, expected: 2, fields: {value: comparable()}}),
  metric({id: 'prior', side: 'reference', fields: {value: comparable()}})] as const;

describe('finite comparison.delta proof', () => {
  it('proves only the cited-row metric delta with equal declared definitions and population', () => {
    const [current, prior] = pair();
    expect(verify(comparison(current, prior))).toEqual(expect.objectContaining({
      status: 'partial',
      deterministicProof: expect.objectContaining({kind: 'comparison_delta', reason: 'cited_metric_delta_proved'}),
    }));
  });

  it.each([
    {metricId: 'other'}, {aggregation: 'avg'}, {populationKey: 'different-window'},
    {origin: {kind: 'skill_literal' as const, definitionFingerprint: 'other'}},
    {unit: 'bytes'},
  ])('rejects different metric semantics %j', patch => {
    const [current] = pair();
    const prior = metric({id: 'prior', side: 'reference', fields: {value: comparable(patch)}});
    expect(verify(comparison(current, prior)).deterministicProof.status).toBe('rejected');
  });

  it.each(['metricId', 'aggregation', 'populationKey'] as const)('keeps absent %s candidate', key => {
    const [current] = pair();
    const prior = metric({id: 'prior', side: 'reference', fields: {value: comparable({[key]: undefined})}});
    expect(verify(comparison(current, prior)).deterministicProof.status).toBe('candidate');
  });

  it('rejects target/global field mixing and swapped current/reference sides', () => {
    const [current, prior] = pair();
    const global = metric({id: 'global', side: 'reference', role: 'global_context', fields: {value: comparable()}});
    expect(verify(comparison(current, global)).deterministicProof.reason).toBe('comparison_field_scope_mismatch');
    expect(verify(comparison(prior, current)).deterministicProof.reason).toBe('comparison_side_mismatch');
  });

  it('does not rely on matching params hashes or column names when field semantics are absent', () => {
    const sameParams = (result: EvidenceAnchorV1) => {result.context.paramsHash = 'same';};
    const current = metric({id: 'current', fields: {}, beforeCapture: sameParams});
    const prior = metric({id: 'prior', side: 'reference', fields: {}, beforeCapture: sameParams});
    expect(verify(comparison(current, prior)).deterministicProof.reason).toBe('comparison_metric_authority_unknown');
  });
});

describe('supported deterministic rule catalog', () => {
  it.each(SUPPORTED_DETERMINISTIC_CLAIM_RULES)('dispatches the published $id to $proofKind', rule => {
    const evidence = metric();
    const declaration = rule.proofKind === 'numeric_cell'
      ? claim([evidence], {semantics: semantics(evidence)})
      : rule.proofKind === 'interval_overlap'
        ? overlap(interval('subject', 1, 3), interval('object', 2, 4))
        : comparison(...pair());
    declaration.semantics!.predicate = rule.id;
    const result = verify(declaration);
    expect(result.deterministicProof.kind).toBe(rule.proofKind);
    expect(result.deterministicProof.reason).not.toBe('unsupported_predicate');
    expect(result.status).not.toBe('verified');
  });

  it('exports a frozen JSON catalog without allowing consumers to register a predicate', () => {
    expect(Object.isFrozen(SUPPORTED_DETERMINISTIC_CLAIM_RULES)).toBe(true);
    expect(SUPPORTED_DETERMINISTIC_CLAIM_RULES.every(Object.isFrozen)).toBe(true);
    expect(JSON.parse(JSON.stringify(SUPPORTED_DETERMINISTIC_CLAIM_RULES))).toEqual(SUPPORTED_DETERMINISTIC_CLAIM_RULES);
    expect(Reflect.set(SUPPORTED_DETERMINISTIC_CLAIM_RULES, 'length', 0)).toBe(false);
    expect(Reflect.set(SUPPORTED_DETERMINISTIC_CLAIM_RULES[0], 'id', 'consumer.predicate')).toBe(false);
    const evidence = metric();
    expect(verify(claim([evidence], {semantics: semantics(evidence, {predicate: 'consumer.predicate'})})).deterministicProof)
      .toMatchObject({kind: 'none', status: 'candidate', reason: 'unsupported_predicate'});
  });
});

describe('mechanism and empty results', () => {
  it.each(['wakeup', 'blocking_state', 'binder_peer', 'lock_owner'] as const)('does not trust serialized %s endpoint equality proofs', kind => {
    const evidence = metric();
    const result = verify(claim([evidence], {kind: 'causal', relationEvaluation: 'verified', relations: [{
      schemaVersion: 'evidence_relation@1', id: 'relation', kind, direction: 'subject_to_object',
      verificationStatus: 'verified', reasonCode: 'binary_proof_verified', subjectAnchorId: evidence.anchorId,
      objectAnchorId: evidence.anchorId, directEvidenceAnchorIds: [evidence.anchorId], supportLevel: 'verified',
    }]}));
    expect(result.status).toBe('inference');
    expect(result.deterministicProof.status).not.toBe('proved');
    expect(result.propositionCoverage.status).not.toBe('complete');
  });

  it('emits an explicit unchecked v2 result when no structured claims exist', () => {
    expect(runDeterministicClaimVerifier({})).toEqual(expect.objectContaining({
      schemaVersion: 'claim_verifier@2', status: 'not_checked', passed: false,
      checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [],
    }));
  });
});

describe('prepared reference outcomes across capture, builder and verifier', () => {
  async function preparedFixture(options: {
    reference?: ConclusionContractClaimReference;
    rows?: EvidenceScalar[][];
    declaredNumber?: number;
    readBudget?: number;
    denied?: boolean;
    invalidScope?: boolean;
    ineligible?: boolean;
    currentRunId?: string;
    extraReferences?: ConclusionContractClaimReference[];
    copiedReads?: boolean;
    unknownUnit?: boolean;
    categorical?: boolean;
    /** Register a capture whose table the product could not map, with this reason. */
    unavailableTable?: string;
  } = {}) {
    const ref = options.reference ?? {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: '54'};
    const raw: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'count', kind: options.categorical ? 'categorical' : 'numeric',
        text: `The observed value is ${options.declaredNumber ?? 54}.`, references: [ref, ...(options.extraReferences ?? [])],
        ...(options.declaredNumber === undefined && !options.categorical ? {} : {semantics: {
          schemaVersion: 'claim_semantics@1' as const, predicate: options.categorical ? 'captured.cell' : 'numeric.cell', polarity: 'affirmed' as const,
          discourse: 'asserted' as const, quantifier: 'one' as const, modality: 'certain' as const,
          scope: {population: 'cited_rows' as const, subjectRefs: [ref]},
          ...(options.categorical ? {} : {numeric: {operator: 'eq' as const, value: options.declaredNumber!, unit: 'count'}}),
        }}),
      }],
    };
    const original = structuredClone(raw);
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues).toEqual([]);
    if (!parsed.contract) throw new Error('Prepared fixture requires a valid declaration');
    const envelope = createDataEnvelope({columns: ['value'], rows: options.rows ?? [[54]]}, {
      type: 'sql_result', source: 'execute_sql', title: 'Count', evidenceRefId: 'data:prepared',
      traceId: 'trace-current', traceSide: 'current', executionStatus: 'observed',
      ...(options.invalidScope ? {scopeProvenance: {version: 'process_scope_evidence@1' as const, entries: [], invalid: true}} : {}),
    });
    const originalData = structuredClone(envelope.data);
    const store = new ArtifactStore();
    expect(store.registerStandaloneEvidenceCapture(options.unavailableTable
      ? captureEvidenceTable(undefined, {}, options.unavailableTable)
      : captureEvidenceTable(envelope.data, {
        value: {...(options.unknownUnit ? {} : {unit: 'count'}), origin: {kind: 'native_producer', definitionFingerprint: 'count-v1'}},
      }), {meta: envelope.meta, display: envelope.display})).toBe(true);
    const view = store.createEvidenceReadView({ownerKey: 'prepared-test', currentRunId: options.currentRunId,
      allowedTraces: [{traceId: options.denied ? 'another-trace' : 'trace-current', traceSide: 'current'}],
      ...(options.readBudget === undefined ? {} : {budget: {maxReferences: options.readBudget}}),
    });
    const prepared = await prepareClaimEvidence({conclusionContract: parsed.contract, bindingEligibility: 'eligible',
      evidenceReadView: options.copiedReads ? {resolveReferences: async requests => structuredClone(await view.resolveReferences(requests))} : view});
    const built = buildEvidenceContract({conclusionContract: parsed.contract, preparedEvidence: prepared,
      bindingEligibility: options.ineligible ? 'ineligible' : 'eligible', dataEnvelopes: [envelope]});
    const output = runDeterministicClaimVerifier({claimSupport: built.claimSupport});
    expect(raw).toEqual(original);
    expect(parsed.contract.claims![0].references).toEqual(original.claims![0].references);
    expect(parsed.contract.claims![0].semantics).toEqual(original.claims![0].semantics);
    expect(envelope.data).toEqual(originalData);
    return {output, built, resolution: preparedReferenceResolution(prepared, ref)};
  }

  it.each([54, 55])('checks typed numeric %s independently of an unchecked string reference', async declaredNumber => {
    const {output, built} = await preparedFixture({declaredNumber});
    expect(output.claimResults[0].referenceCells[0].status).toBe('not_checked');
    expect(output.claimResults[0].deterministicProof.status).toBe(declaredNumber === 54 ? 'proved' : 'rejected');
    expect(output.status).toBe(declaredNumber === 54 ? 'partial' : 'failed');
    expect(output.passed).toBe(false);
    expect(built.anchors[0].cells![0].value).toBe('54');
    expect(getCapturedAnchorFacts(built.anchors[0])?.row.value).toBe(54);
  });

  it.each([
    {evidenceRefId: 'data:invented', rowIndex: 0, column: 'value', value: 54},
    {evidenceRefId: 'data:prepared', rowIndex: 9, column: 'value', value: 54},
    {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'absent', value: 54},
  ])('watermarks a live lookup binding failure without changing the failed reference: %j', async reference => {
    const {output, built} = await preparedFixture({reference, currentRunId: 'run-current', declaredNumber: 54});
    expect(output.status).not.toBe('failed');
    expect(output.claimResults[0].referenceCells[0].status).toBe('missing');
    expect(output.claimResults[0].deterministicProof.status).not.toBe('proved');
    expect(output.issues.every(issue => issue.severity === 'warning')).toBe(true);
    expect(runDeterministicClaimVerifier({claimSupport: structuredClone(built.claimSupport)}).status).toBe('failed');
  });

  it('does not grant advisory authority to copied read receipts or readers without a run', async () => {
    const reference = {evidenceRefId: 'data:invented', rowIndex: 0, column: 'value', value: 54};
    for (const options of [{copiedReads: true, currentRunId: 'run-current'}, {}]) {
      expect((await preparedFixture({...options, reference})).output.status).toBe('failed');
    }
  });

  it('reports an empty-table row locator as unverified instead of a proved zero', async () => {
    const {output} = await preparedFixture({currentRunId: 'run-current', rows: [], declaredNumber: 0,
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 0}});
    expect(output.status).not.toBe('failed');
    expect(output.claimResults[0]).toMatchObject({referenceCells: [{status: 'missing', message: 'row_index_out_of_range'}]});
    expect(output.claimResults[0].deterministicProof.status).not.toBe('proved');
  });

  it.each([54, 55])('evaluates proposition %s independently but never proves a mismatched reference', async declaredNumber => {
    const {output} = await preparedFixture({currentRunId: 'run-current', declaredNumber,
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 99}});
    expect(output.claimResults[0].referenceCells[0].status).toBe('value_mismatch');
    expect(output.claimResults[0].deterministicProof.status).toBe(declaredNumber === 54 ? 'candidate' : 'rejected');
    expect(output.status).toBe(declaredNumber === 54 ? 'partial' : 'failed');
  });

  it.each([54, 55])('an extra absent citation cannot prove or hide proposition %s', async declaredNumber => {
    const {output} = await preparedFixture({currentRunId: 'run-current', declaredNumber,
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 54},
      extraReferences: [{evidenceRefId: 'data:invented'}]});
    expect(output.claimResults[0].referenceCells.map(cell => cell.status)).toEqual(['matched', 'missing']);
    expect(output.claimResults[0].deterministicProof.status).toBe(declaredNumber === 54 ? 'candidate' : 'rejected');
    expect(output.status).toBe(declaredNumber === 54 ? 'partial' : 'failed');
  });

  it('retains categorical rejection and leaves unknown-unit numeric propositions unverified', async () => {
    const categorical = await preparedFixture({currentRunId: 'run-current', categorical: true, rows: [['actual']],
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 'different'}});
    expect(categorical.output.status).toBe('failed');
    expect(categorical.output.claimResults[0].deterministicProof).toMatchObject({status: 'rejected', reason: 'captured_cell_value_rejected'});
    const unknown = await preparedFixture({currentRunId: 'run-current', unknownUnit: true, declaredNumber: 55,
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 55}});
    expect(unknown.output.status).toBe('partial');
    expect(unknown.output.claimResults[0].deterministicProof.status).toBe('candidate');
  });

  it.each([
    {declared: '858', status: 'candidate', reason: 'captured_value_type_mismatch', verdict: 'partial'},
    {declared: '858.0', status: 'candidate', reason: 'captured_value_type_mismatch', verdict: 'partial'},
    {declared: '859', status: 'rejected', reason: 'captured_cell_value_rejected', verdict: 'failed'},
    {declared: '858 ms', status: 'rejected', reason: 'captured_cell_value_rejected', verdict: 'failed'},
  ] as const)('treats captured string $declared against integer 858 by value, not by JSON type', async ({declared, status, reason, verdict}) => {
    // rooted_lowmem_monkey_a1: a declared '858' against a captured 858 was the sole contradiction.
    const {output} = await preparedFixture({categorical: true, rows: [[858]],
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: declared}});
    expect(output.claimResults[0].referenceCells[0].status).toBe('not_checked');
    expect(output.claimResults[0].deterministicProof).toMatchObject({status, reason});
    expect(output.status).toBe(verdict);
    expect(output.issues.find(issue => issue.code === reason)?.severity).toBe(status === 'rejected' ? 'error' : 'warning');
  });

  it.each([
    {denied: true}, {invalidScope: true},
    {reference: {evidenceRefId: 'data:prepared', sourceToolCallId: 'wrong-source', rowIndex: 0, column: 'value', value: 54}},
    {unavailableTable: 'execution_witness_mismatch'},
  ])('keeps scope, identity-source and integrity failures hard in a current reader: %j', async options => {
    expect((await preparedFixture({...options, currentRunId: 'run-current'})).output.status).toBe('failed');
  });

  it('preserves explicit null from declaration through prepared capture and builder without proving a number or cause', async () => {
    const ref = {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: null};
    const {output, built} = await preparedFixture({reference: ref, rows: [[null]], declaredNumber: 0});
    expect(built.anchors[0].cells![0]).toMatchObject({value: null, actualValue: null, isSqlNull: true});
    expect(getCapturedAnchorFacts(built.anchors[0])?.row.value).toBeNull();
    expect(output.claimResults[0].referenceCells[0].status).toBe('matched');
    expect(output.claimResults[0].deterministicProof.status).not.toBe('proved');
    expect(output.claimResults[0].deterministicProof.reason).toBe('exact_numeric_value_unavailable');
    expect(output.passed).toBe(false);
    const causal = runDeterministicClaimVerifier({claimSupport: [{...built.claimSupport[0],
      kind: 'causal', text: 'The missing IO flag proves that IO caused the delay.',
      semantics: {...built.claimSupport[0].semantics!, predicate: 'causal.blocking', numeric: undefined},
    }]});
    expect(causal.claimResults[0].deterministicProof.status).not.toBe('proved');
    expect(causal.passed).toBe(false);
  });

  it.each([0, false, '', 'null'] as const)('does not turn null into %j through the prepared evidence chain', async value => {
    for (const [expected, actual] of [[null, value], [value, null]] as const) {
      const {output, built} = await preparedFixture({rows: [[actual]],
        reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: expected}});
      expect(built.anchors[0].cells![0]).toHaveProperty('value', expected);
      expect(output.claimResults[0].referenceCells[0].status).toBe('value_mismatch');
      expect(output.passed).toBe(false);
    }
  });

  it('distinguishes explicit null from an omitted expectation or absent captured column', async () => {
    const omitted = await preparedFixture({rows: [[null]],
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value'}});
    expect(omitted.built.anchors[0].cells![0]).not.toHaveProperty('value');
    expect(omitted.output.claimResults[0].referenceCells[0].status).toBe('not_checked');
    const missing = await preparedFixture({rows: [[null]],
      reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'absent', value: null}});
    expect(missing.output.claimResults[0].referenceCells[0].status).toBe('missing');
    expect(missing.output.passed).toBe(false);
  });

  it.each([
    {reference: {evidenceRefId: 'data:prepared', column: 'value', value: 54}, rows: [[54], [55]],
      readBudget: undefined, status: 'ambiguous', reason: 'row_locator_required'},
    {reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 54}, rows: [[54]],
      readBudget: 0, status: 'incomplete', reason: 'read_budget_exhausted'},
  ])('keeps a typed $status read unchecked without creating a cell witness', async input => {
    const {output, built, resolution} = await preparedFixture(input);
    expect(resolution).toMatchObject({status: input.status, reason: input.reason});
    expect(built.anchors[0]).toMatchObject({confidence: 0, missingReason: input.reason});
    expect(built.anchors[0].missing).toBeUndefined();
    expect(getCapturedAnchorFacts(built.anchors[0])).toBeUndefined();
    expect(output.claimResults[0].referenceCells).toEqual([expect.objectContaining({status: 'not_checked', message: input.reason})]);
    expect(output.status).toBe('not_checked');
    expect(output.issues).toEqual([]);
    expect(output.passed).toBe(false);
  });

  it.each([
    {reference: {evidenceRefId: 'data:absent', rowIndex: 0, column: 'value', value: 54}},
    {reference: {evidenceRefId: 'data:prepared', rowIndex: 9, column: 'value', value: 54}},
    {reference: {evidenceRefId: 'data:prepared', rowSelector: {value: '54'}, column: 'value', value: 54}},
    {reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'absent', value: 54}},
    {denied: true},
    {invalidScope: true},
  ])('retains missing, denied and invalid binding failures: %j', async input => {
    const {output, built} = await preparedFixture(input);
    expect(built.anchors[0].missing).toBe(true);
    expect(getCapturedAnchorFacts(built.anchors[0])).toBeUndefined();
    expect(output.status).toBe('failed');
    expect(output.claimResults[0].referenceCells[0].status).toBe('missing');
    expect(output.passed).toBe(false);
  });

  it('keeps an ineligible declaration unverified instead of contradicted', async () => {
    const {output, built} = await preparedFixture({ineligible: true, declaredNumber: 55});
    expect(built.anchors[0].missing).toBe(true);
    expect(output.status).toBe('not_checked');
    expect(output.unsupportedClaimCount).toBe(0);
    expect(output.claimResults[0]).toMatchObject({status: 'not_checked',
      deterministicProof: {status: 'not_checked', reason: 'binding_ineligible'}});
    expect(output.claimResults[0].referenceCells.map(cell => cell.status)).toEqual(['ineligible']);
    expect(output.issues).toEqual([expect.objectContaining({severity: 'warning', code: 'binding_ineligible'})]);
  });

  it.each(['display_transformation_unmapped', 'unmapped_evidence_shape'])(
    'reports evidence the product could not read (%s) once as unverified', async reason => {
      const {output, built, resolution} = await preparedFixture({unavailableTable: reason});
      expect(resolution).toMatchObject({status: 'missing', reason});
      expect(built.anchors[0]).toMatchObject({missing: true, missingReason: reason});
      expect(output.claimResults[0].referenceCells.map(cell => cell.status)).toEqual(['not_checked']);
      expect(output.status).not.toBe('failed');
      expect(output.issues).toEqual([{claimId: 'count', severity: 'warning', code: 'claim_reference_unverified', message: reason}]);
    });

  it('does not let a copied unreadable reason downgrade a missing reference', async () => {
    const {built} = await preparedFixture({unavailableTable: 'display_transformation_unmapped'});
    const copied = runDeterministicClaimVerifier({claimSupport: structuredClone(built.claimSupport)});
    expect(copied.claimResults[0].referenceCells.map(cell => cell.status)).toEqual(['missing']);
    expect(copied.status).toBe('failed');
  });

  it('still rejects a different same-type value with an exact captured locator', async () => {
    const {output} = await preparedFixture({reference: {evidenceRefId: 'data:prepared', rowIndex: 0, column: 'value', value: 55}});
    expect(output.status).toBe('failed');
    expect(output.claimResults[0].referenceCells[0].status).toBe('value_mismatch');
  });

  it('does not interpret a diagnostic string as an unresolved read receipt', () => {
    const evidence = metric({captured: false, beforeCapture: target => {
      target.missing = true;
      target.missingReason = 'row_locator_required';
    }});
    expect(verify(claim([evidence])).status).toBe('unsupported');
    expect(verify(claim([evidence])).referenceCells[0].status).toBe('missing');
  });
});
