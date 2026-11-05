// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';
import {CONCLUSION_AUTHORING_LIMITS, CONCLUSION_AUTHORING_VERSION, CONCLUSION_AUTHORING_VERSION_V2, decodeConclusionAuthoring,
  resolveConclusionDeclarationSyntax} from '../conclusionAuthoring';
import {CONCLUSION_PROTOCOL_VALUES, parseConclusionContractDeclaration, parseConclusionDeclarationPayload,
  conclusionDeclarationValidationPayload, conclusionDeclarationAuthoring,
  parseConclusionContractSidecar, wrapConclusionAuthoringPayload, renderConclusionContractSidecar,
  CONCLUSION_AUTHORING_FENCE, ConclusionSidecarFramingScanner} from '../conclusionContract';

type Json = Record<string, any>;

describe('private authoring JSON syntax diagnostics', () => {
  it.each(['{"text":"😀",}', '{"authoringVersion":"conclusion_authoring@2",}'])(
    'records bounded UTF-16 facts while keeping invalid JSON ineligible', payload => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const parsed = parseConclusionContractSidecar(wrapConclusionAuthoringPayload(payload, 'authoring_v2'));
        expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible', issues: [{code: 'invalid_json'}]});
        expect(warn).toHaveBeenCalledWith('[ConclusionAuthoring] invalid_json', {
          form: 'object_like', utf16Length: payload.length, utf16Offset: payload.length - 1, characterClass: 'close_object',
        });
        expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'invalid', canonicalRootRepairEligible: false});
      } finally {warn.mockRestore();}
    });

  it('never extracts an input-controlled position or logs an unexpected-token snippet', () => {
    const payload = 'PRIVATE_SYNTAX_CANARY position 1 (line 1 column 2)';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const parsed = parseConclusionContractSidecar(wrapConclusionAuthoringPayload(payload, 'authoring_v2'));
      expect(parsed.status).toBe('invalid');
      expect(warn).toHaveBeenCalledWith('[ConclusionAuthoring] invalid_json', {
        form: 'other', utf16Length: payload.length, utf16Offset: 'unknown', characterClass: 'unknown',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_SYNTAX_CANARY');
    } finally {warn.mockRestore();}
  });
});

const envelope = (contract: unknown, referenceDictionary: unknown[] = []) =>
  ({authoringVersion: CONCLUSION_AUTHORING_VERSION, referenceDictionary, contract});
const contract = (claims: unknown[], extra: Json = {}) => ({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
  conclusions: [], clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: [], ...extra});
function expanded(input: unknown) {
  const result = decodeConclusionAuthoring(input);
  if (result.status !== 'expanded') throw new Error(`Unexpected authoring failure: ${result.code}`);
  return result;
}

/** Independent literal controls: no encoder and no expected full claim derived from compact input. */
const corpus = [
  {
    kind: 'numeric',
    dictionary: '[{"evidenceRefId":"data:duration","rowIndex":0,"column":"dur_ms","value":33}]',
    compact: '{"id":"numeric","kind":"numeric","text":"Duration is 33 ms.","references":[{"$ref":0}],"semantics":{"predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"$ref":0}],"population":"cited_rows"},"numeric":{"operator":"eq","value":33,"unit":"ms"}}}',
    full: '{"id":"numeric","kind":"numeric","text":"Duration is 33 ms.","references":[{"evidenceRefId":"data:duration","rowIndex":0,"column":"dur_ms","value":33}],"semantics":{"predicate":"numeric.cell","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"evidenceRefId":"data:duration","rowIndex":0,"column":"dur_ms","value":33}],"population":"cited_rows"},"numeric":{"operator":"eq","value":33,"unit":"ms"}}}',
  },
  {
    kind: 'categorical',
    dictionary: '[{"sourceToolCallId":"call-state","rowIndex":2,"column":"state","value":"Sleeping"}]',
    compact: '{"id":"category","kind":"categorical","text":"The cited state is Sleeping.","references":[{"$ref":0}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"quoted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"$ref":0}],"population":"cited_rows"}}}',
    full: '{"id":"category","kind":"categorical","text":"The cited state is Sleeping.","references":[{"sourceToolCallId":"call-state","rowIndex":2,"column":"state","value":"Sleeping"}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"quoted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"sourceToolCallId":"call-state","rowIndex":2,"column":"state","value":"Sleeping"}],"population":"cited_rows"}}}',
  },
  {
    kind: 'time_range',
    dictionary: '[{"evidenceRefId":"data:interval","rowIndex":0}]',
    compact: '{"id":"range","kind":"time_range","text":"The interval spans 100 to 200 ns.","references":[{"$ref":0}],"semantics":{"predicate":"interval.bounds","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"$ref":0}],"population":"selected_interval","timeRangeNs":{"start":"100","end":"200"}}}}',
    full: '{"id":"range","kind":"time_range","text":"The interval spans 100 to 200 ns.","references":[{"evidenceRefId":"data:interval","rowIndex":0}],"semantics":{"predicate":"interval.bounds","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"evidenceRefId":"data:interval","rowIndex":0}],"population":"selected_interval","timeRangeNs":{"start":"100","end":"200"}}}}',
  },
  {
    kind: 'identity',
    dictionary: '[{"evidenceRefId":"data:current:process","rowSelector":{"upid":7},"column":"name","value":"app"}]',
    compact: '{"id":"identity","kind":"identity","text":"The name belongs to process instance 7.","references":[{"$ref":0}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"only","modality":"certain","scope":{"subjectRefs":[{"$ref":0}],"population":"process_instance"}}}',
    full: '{"id":"identity","kind":"identity","text":"The name belongs to process instance 7.","references":[{"evidenceRefId":"data:current:process","rowSelector":{"upid":7},"column":"name","value":"app"}],"semantics":{"predicate":"captured.cell","polarity":"affirmed","discourse":"asserted","quantifier":"only","modality":"certain","scope":{"subjectRefs":[{"evidenceRefId":"data:current:process","rowSelector":{"upid":7},"column":"name","value":"app"}],"population":"process_instance"}}}',
  },
  {
    kind: 'causal',
    dictionary: '[{"evidenceRefId":"data:waiter","rowSelector":{"utid":7}},{"evidenceRefId":"data:owner","rowSelector":{"utid":9}}]',
    compact: '{"id":"cause","kind":"causal","text":"The owner may explain the wait.","references":[{"$ref":0},{"$ref":1}],"relationRefs":["proposal:lock"],"semantics":{"predicate":"causal.blocking","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"possible","conditions":["The runtime edge binds both instances."],"scope":{"subjectRefs":[{"$ref":0}],"objectRefs":[{"$ref":1}],"population":"selected_interval"}}}',
    full: '{"id":"cause","kind":"causal","text":"The owner may explain the wait.","references":[{"evidenceRefId":"data:waiter","rowSelector":{"utid":7}},{"evidenceRefId":"data:owner","rowSelector":{"utid":9}}],"relationRefs":["proposal:lock"],"semantics":{"predicate":"causal.blocking","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"possible","conditions":["The runtime edge binds both instances."],"scope":{"subjectRefs":[{"evidenceRefId":"data:waiter","rowSelector":{"utid":7}}],"objectRefs":[{"evidenceRefId":"data:owner","rowSelector":{"utid":9}}],"population":"selected_interval"}}}',
  },
  {
    kind: 'comparison',
    dictionary: '[{"evidenceRefId":"data:current","rowIndex":0,"column":"dur_ms","value":10},{"evidenceRefId":"data:reference","rowIndex":0,"column":"dur_ms","value":8}]',
    compact: '{"id":"delta","kind":"comparison","text":"Current minus reference is 2 ms.","references":[{"$ref":0},{"$ref":1}],"semantics":{"predicate":"comparison.delta","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"$ref":0}],"objectRefs":[{"$ref":1}],"population":"cited_rows"},"numeric":{"operator":"eq","value":2,"unit":"ms"}}}',
    full: '{"id":"delta","kind":"comparison","text":"Current minus reference is 2 ms.","references":[{"evidenceRefId":"data:current","rowIndex":0,"column":"dur_ms","value":10},{"evidenceRefId":"data:reference","rowIndex":0,"column":"dur_ms","value":8}],"semantics":{"predicate":"comparison.delta","polarity":"affirmed","discourse":"asserted","quantifier":"one","modality":"certain","scope":{"subjectRefs":[{"evidenceRefId":"data:current","rowIndex":0,"column":"dur_ms","value":10}],"objectRefs":[{"evidenceRefId":"data:reference","rowIndex":0,"column":"dur_ms","value":8}],"population":"cited_rows"},"numeric":{"operator":"eq","value":2,"unit":"ms"}}}',
  },
  {
    kind: 'inference',
    dictionary: '[{"artifactId":"artifact:states","rowIndex":1}]',
    compact: '{"id":"inference","kind":"inference","text":"Some delays might share a cause.","references":[{"$ref":0}],"supportLevel":"inference","semantics":{"predicate":"unconfigured.inference","polarity":"undetermined","discourse":"hypothetical","quantifier":"some","modality":"possible","conditions":["Only the sampled rows were observed."],"scope":{"subjectRefs":[{"$ref":0}],"population":"cited_rows"}}}',
    full: '{"id":"inference","kind":"inference","text":"Some delays might share a cause.","references":[{"artifactId":"artifact:states","rowIndex":1}],"supportLevel":"inference","semantics":{"predicate":"unconfigured.inference","polarity":"undetermined","discourse":"hypothetical","quantifier":"some","modality":"possible","conditions":["Only the sampled rows were observed."],"scope":{"subjectRefs":[{"artifactId":"artifact:states","rowIndex":1}],"population":"cited_rows"}}}',
  },
  {
    kind: 'recommendation',
    dictionary: '[{"sourceArtifactId":"artifact:recommendation","rowIndex":0}]',
    compact: '{"id":"recommendation","kind":"recommendation","text":"Do not increase worker count without checking contention.","references":[{"$ref":0}],"semantics":{"predicate":"unconfigured.recommendation","polarity":"negated","discourse":"asserted","quantifier":"all","modality":"undetermined","conditions":["Contention has not been ruled out."],"scope":{"subjectRefs":[{"$ref":0}],"population":"process_instance"}}}',
    full: '{"id":"recommendation","kind":"recommendation","text":"Do not increase worker count without checking contention.","references":[{"sourceArtifactId":"artifact:recommendation","rowIndex":0}],"semantics":{"predicate":"unconfigured.recommendation","polarity":"negated","discourse":"asserted","quantifier":"all","modality":"undetermined","conditions":["Contention has not been ruled out."],"scope":{"subjectRefs":[{"sourceArtifactId":"artifact:recommendation","rowIndex":0}],"population":"process_instance"}}}',
  },
];

describe('pure conclusion authoring input', () => {
  it('selects only explicit internal configuration and never silently falls back on unknown values', () => {
    expect(resolveConclusionDeclarationSyntax(undefined)).toBe('canonical_v1');
    expect(resolveConclusionDeclarationSyntax('canonical_v1')).toBe('canonical_v1');
    expect(resolveConclusionDeclarationSyntax('authoring_v1')).toBe('authoring_v1');
    expect(resolveConclusionDeclarationSyntax('authoring_v2')).toBe('authoring_v2');
    for (const value of ['', ' authoring_v1', 'AUTHORING_V1', 'PRIVATE_VALUE']) {
      expect(() => resolveConclusionDeclarationSyntax(value)).toThrow('invalid_configuration:conclusion_authoring');
    }
  });
  it('has independent controls for all eight canonical kinds', () => {
    expect(corpus.map(item => item.kind)).toEqual(CONCLUSION_PROTOCOL_VALUES.claimKind);
  });

  it.each(corpus)('expands $kind exactly and preserves the direct full parser outcome', fixture => {
    const raw = envelope(contract([JSON.parse(fixture.compact)]), JSON.parse(fixture.dictionary));
    const before = JSON.stringify(raw);
    const expected = contract([JSON.parse(fixture.full)]);
    const decoded = expanded(raw);
    expect(decoded.expandedPayload).toEqual(expected);
    expect(parseConclusionContractDeclaration(decoded.expandedPayload)).toEqual(parseConclusionContractDeclaration(expected));
    expect(parseConclusionContractDeclaration(expected).issues).toEqual([]);
    expect(decoded.material.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
    expect(decoded.rawPayload).toBe(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(decoded).not.toHaveProperty('bindingEligibility');
    expect(decoded).not.toHaveProperty('verified');
    expect(expanded(envelope(expected)).expandedPayload).toEqual(expected);
  });

  it.each(corpus)('keeps an invalid $kind alongside a valid claim with original raw errors', fixture => {
    const bad = JSON.parse(fixture.compact);
    bad.semantics.polarity = 'invented';
    const expectedBad = JSON.parse(fixture.full);
    expectedBad.semantics.polarity = 'invented';
    const good = {id: 'separate-good', text: 'A separate declared fact.', references: [{sourceToolCallId: 'good'}]};
    const actual = parseConclusionContractDeclaration(expanded(envelope(contract([good, bad]), JSON.parse(fixture.dictionary))).expandedPayload);
    const control = parseConclusionContractDeclaration(contract([good, expectedBad]));
    expect(actual).toEqual(control);
    expect(actual.contract?.bindingEligibility).toBe('eligible');
    expect(actual.contract?.claims?.[0].valid).toBeUndefined();
    expect(actual.contract?.claims?.[1].valid).toBe(false);
    expect(actual.contract?.claims?.[1].rawSemantics).toEqual(expectedBad.semantics);
  });

  it('keeps assertion, cited value and handle changes independent', () => {
    const fixture = corpus[0];
    const input = (): Json => envelope(contract([JSON.parse(fixture.compact)]), JSON.parse(fixture.dictionary));
    const assertion = input();
    assertion.contract.claims[0].semantics.numeric.value = 34;
    const asserted = expanded(assertion).expandedPayload.claims as Json[];
    expect(asserted[0].semantics.numeric.value).toBe(34);
    expect(asserted[0].references[0].value).toBe(33);
    const captured = input();
    captured.referenceDictionary[0].value = 35;
    const cited = expanded(captured).expandedPayload.claims as Json[];
    expect(cited[0].semantics.numeric.value).toBe(33);
    expect(cited[0].references[0].value).toBe(35);
    const dangling = input();
    dangling.contract.claims[0].references[0].$ref = 1;
    const unbound = expanded(dangling);
    expect((unbound.expandedPayload.claims as Json[])[0].semantics.numeric.value).toBe(33);
    expect(parseConclusionContractDeclaration(unbound.expandedPayload).contract?.claims?.[0].rawReferences).toEqual([{$ref: 1}]);
  });

  it.each([CONCLUSION_AUTHORING_VERSION, CONCLUSION_AUTHORING_VERSION_V2])('preserves all relation/source structures in %s without source authority', authoringVersion => {
    const compact = JSON.parse(corpus[4].compact);
    const full = JSON.parse(corpus[4].full);
    const dictionary = JSON.parse(corpus[4].dictionary);
    dictionary.push({evidenceRefId: 'data:edge', rowIndex: 0});
    const relation = {id: 'proposal:lock', kind: 'lock_owner', direction: 'subject_to_object', subject: {$ref: 0},
      object: {$ref: 1}, proof: {$ref: 2}, proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter_utid'},
        object: {endpointColumn: 'utid', proofColumn: 'owner_utid'}}};
    const fullRelation = {id: 'proposal:lock', kind: 'lock_owner', direction: 'subject_to_object',
      subject: {evidenceRefId: 'data:waiter', rowSelector: {utid: 7}},
      object: {evidenceRefId: 'data:owner', rowSelector: {utid: 9}}, proof: {evidenceRefId: 'data:edge', rowIndex: 0},
      proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter_utid'},
        object: {endpointColumn: 'utid', proofColumn: 'owner_utid'}}};
    const source = {sourceReferences: [{id: 'source-read', codebaseId: 'app', filePath: 'src/Lock.kt',
      lineRange: {start: 10, end: 20}, lookupKind: 'body', sourceGeneration: 'live-example'}],
    sourceClaimBindings: [{claimId: 'cause', sourceReferenceIds: ['source-read'], traceEvidenceRefIds: ['data:waiter']}]};
    const actual = expanded({...envelope(contract([compact], {...source, relationProposals: [relation]}), dictionary), authoringVersion});
    const expected = contract([full], {...source, relationProposals: [fullRelation]});
    expect(actual.expandedPayload).toEqual(expected);
    expect(parseConclusionContractDeclaration(actual.expandedPayload)).toEqual(parseConclusionContractDeclaration(expected));
    expect(actual.referenceUses.map(use => use.kind)).toEqual([
      'claim_references', 'claim_references', 'subject_refs', 'object_refs',
      'relation_subject', 'relation_object', 'relation_proof',
    ]);
  });

  it('does not reinterpret lookalike slots, text, artifact refs, source IDs or proofBindings', () => {
    const raw = contract([{text: 'Literal {"$ref":0}', references: [], artifactRefs: [{$ref: 0}], relationRefs: ['0'],
      metadata: {references: [{$ref: 0}]}}], {
      sourceReferences: [{$ref: 0}], sourceClaimBindings: [{claimId: 'a', sourceReferenceIds: [{$ref: 0}]}],
      metadata: {claims: [{references: [{$ref: 0}]}]},
      relationProposals: [{proofBindings: {subject: {$ref: 0}, object: {$ref: 0}}}],
    });
    const result = expanded(envelope(raw, [{evidenceRefId: 'must-not-be-inserted'}]));
    expect(result.expandedPayload).toEqual(raw);
    expect(result.referenceUses).toEqual([]);
    expect(result.unusedDictionaryEntries).toEqual({validation: 'not_checked', count: 1});
  });

  it.each([{$ref: '0'}, {$ref: -1}, {$ref: 0.5}, {$ref: Number.MAX_SAFE_INTEGER + 1}, {$ref: 0, value: 33}, {$ref: 9}])(
    'retains invalid aliases for the canonical parser: %p', alias => {
      const result = expanded(envelope(contract([{id: 'bad', text: 'Bad reference.', references: [alias]}]), [{evidenceRefId: 'data:a'}]));
      expect((result.expandedPayload.claims as Json[])[0].references).toEqual([alias]);
      expect(result.diagnostics).toHaveLength(1);
      expect(parseConclusionContractDeclaration(result.expandedPayload).contract?.claims?.[0]).toMatchObject({valid: false, rawReferences: [alias]});
    });

  it.each([null, 'wrong', {$ref: 0}, {evidenceRefId: 'data:a', unexpected: true}])(
    'copies a malformed entry exactly, with no recursive reference resolution: %p', entry => {
      const result = expanded(envelope(contract([{text: 'Bad reference.', references: [{$ref: 0}]}]), [entry]));
      expect((result.expandedPayload.claims as Json[])[0].references).toEqual([entry]);
      expect(parseConclusionContractDeclaration(result.expandedPayload).contract?.claims?.[0].valid).toBe(false);
    });

  it('does not validate or clone an unused huge/deep dictionary entry', () => {
    const huge = {value: 'x'.repeat(CONCLUSION_AUTHORING_LIMITS.utf8Bytes + 1)};
    let deep: unknown = 'deep';
    for (let index = 0; index < 100; index++) deep = {child: deep};
    const raw = contract([{id: 'good', text: 'Good.', references: [{evidenceRefId: 'good'}]}]);
    const result = expanded(envelope(raw, [null, huge, deep]));
    expect(result.unusedDictionaryEntries).toEqual({validation: 'not_checked', count: 3});
    expect(result.diagnostics).toEqual([]);
    expect(parseConclusionContractDeclaration(result.expandedPayload).issues).toEqual([]);
    expect(result).not.toHaveProperty('canonicalRootRepairEligible');
  });

  it('allows renumbering only when the independently expanded reference stays identical', () => {
    const original = envelope(contract([{text: 'Value.', references: [{$ref: 0}]}]), [{evidenceRefId: 'a'}, {evidenceRefId: 'b'}]);
    const renumbered = envelope(contract([{text: 'Value.', references: [{$ref: 1}]}]), [{evidenceRefId: 'b'}, {evidenceRefId: 'a'}]);
    expect(expanded(original).expandedPayload).toEqual(expanded(renumbered).expandedPayload);
    const substituted = envelope(contract([{text: 'Value.', references: [{$ref: 0}]}]), [{evidenceRefId: 'b'}]);
    expect(expanded(original).expandedPayload).not.toEqual(expanded(substituted).expandedPayload);
  });

  it('retains duplicate IDs and untrusted parser metadata for canonical root rejection', () => {
    const raw = contract([{id: 'same', text: 'One.', references: [{$ref: 0}]},
      {id: 'same', text: 'Two.', references: [{$ref: 0}]}], {verified: true});
    const parsed = parseConclusionContractDeclaration(expanded(envelope(raw, [{evidenceRefId: 'a'}])).expandedPayload);
    expect(parsed.contract?.bindingEligibility).toBe('ineligible');
    expect(parsed.issues.map(issue => issue.code)).toContain('duplicate_claim_id');
    expect(parsed.issues.map(issue => issue.code)).toContain('untrusted_parser_metadata');
    expect(parsed.contract?.claims).toHaveLength(2);
  });

  it.each([null, {}, {authoringVersion: 'unknown'}, {...envelope({}), referenceDictionary: {}},
    {...envelope({}), extra: true}, envelope([])])('rejects envelope errors without a canonical-root repair exemption', raw => {
    expect(decodeConclusionAuthoring(raw)).toMatchObject({status: 'invalid', rawPayload: raw,
      bindingEligibility: 'ineligible', canonicalRootRepairEligible: false});
  });
});

describe('explicit authoring v2 compilation', () => {
  const v2 = (value: Json, dictionary: unknown[] = []) =>
    ({authoringVersion: CONCLUSION_AUTHORING_VERSION_V2, referenceDictionary: dictionary, contract: value});
  const rootCollections = ['conclusions', 'clusters', 'evidenceChain', 'uncertainties', 'nextSteps'] as const;

  it.each(corpus)('compiles $kind to an independent full control without changing the wire', fixture => {
    const raw = v2({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', claims: [JSON.parse(fixture.compact)],
      uncertainties: [{text: '尚未确定。\n🙂'}], nextSteps: [{text: '保留该限定词。'}]}, JSON.parse(fixture.dictionary));
    const expected = contract([JSON.parse(fixture.full)], {uncertainties: ['尚未确定。\n🙂'], nextSteps: ['保留该限定词。']});
    const before = JSON.stringify(raw);
    const result = expanded(raw);
    expect(result.authoringVersion).toBe('conclusion_authoring@2');
    expect(result.expandedPayload).toEqual(expected);
    expect(parseConclusionContractDeclaration(result.expandedPayload)).toEqual(parseConclusionContractDeclaration(expected));
    expect(result.material.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
    expect(result.rawPayload).toBe(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(parseConclusionDeclarationPayload({...raw, authoringVersion: CONCLUSION_AUTHORING_VERSION}).status).toBe('invalid');
    expect(parseConclusionDeclarationPayload(raw.contract, 'canonical_v1').status).toBe('invalid');
  });

  it.each(rootCollections)('only compiles an absent own root %s collection', field => {
    const input: Json = contract([]);
    delete input[field];
    expect(expanded(v2(input)).expandedPayload[field]).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(input, field)).toBe(false);
    const present = {conclusions: [{rank: 1, statement: 'Original.'}], clusters: [{cluster: 'unknown'}],
      evidenceChain: [{conclusionId: 'c', text: 'Original link.'}], uncertainties: ['Unknown.'], nextSteps: ['Inspect.']}[field];
    for (const value of [null, {text: 'Preserve this object.'}, 'wrong type', present]) {
      input[field] = value;
      expect(expanded(v2(input)).expandedPayload[field]).toEqual(value);
    }
    input[field] = undefined; // Present non-JSON data is not an absent collection.
    expect(decodeConclusionAuthoring(v2(input))).toMatchObject({status: 'invalid', code: 'non_json_value'});
  });

  it('keeps protected and unknown material and never adds optional collections', () => {
    const raw = v2({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      metadata: {uncertainties: [{text: 'Nested text remains an object.'}]},
      sourceClaimBindings: [{claimId: 'missing', sourceReferenceIds: ['source:a'], traceEvidenceRefIds: []}]});
    const result = expanded(raw).expandedPayload;
    expect(result).not.toHaveProperty('claims');
    expect(result).not.toHaveProperty('relationProposals');
    expect(result.metadata).toEqual(raw.contract.metadata);
    expect(result.sourceClaimBindings).toEqual(raw.contract.sourceClaimBindings);
    expect(parseConclusionContractDeclaration(result).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'invalid_reference'}),
    ]));
  });

  it.each(['uncertainties', 'nextSteps'])('preserves exact %s strings, order and non-carrier content', field => {
    const values = ['', {text: '空格 \n🙂\ud800'}, {text: 'Already qualified.', condition: 'Only if observed.'},
      {text: {text: 'Nested.'}}, {text: 7}, {other: 'No text key.'}];
    const input = v2(contract([], {[field]: values}));
    expect(expanded(input).expandedPayload[field]).toEqual(['', '空格 \n🙂\ud800', ...values.slice(2)]);
    expect(parseConclusionDeclarationPayload(input).status).toBe('invalid');
    expect(input.contract[field]).toEqual(values);
  });

  it('does not invoke accessors or mistake symbol/nonenumerable extra keys for exact carriers', () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, 'text', {enumerable: true, get() {invoked = true; return 'Changed.';}});
    expect(decodeConclusionAuthoring(v2(contract([], {uncertainties: [accessor]}))))
      .toMatchObject({status: 'invalid', code: 'non_json_value'});
    expect(invoked).toBe(false);
    const symbol = {text: 'Keep object.', [Symbol('qualifier')]: 'private qualifier'};
    const hidden = Object.defineProperty({text: 'Keep object.'}, 'qualifier', {value: 'private qualifier'});
    for (const item of [symbol, hidden, Object.defineProperty({}, 'text', {value: 'Not JSON text.'})]) {
      const parsed = parseConclusionDeclarationPayload(v2(contract([], {uncertainties: [item]})));
      expect(parsed.status).toBe('invalid');
      expect((conclusionDeclarationValidationPayload(parsed) as Json).uncertainties[0]).not.toEqual(expect.any(String));
    }
  });

  it('never repairs independent assertions, semantic qualifiers, invalid handles or source structures', () => {
    const claim = JSON.parse(corpus[0].compact);
    claim.semantics.numeric.value = 34;
    claim.semantics.numeric.unit = 'unissued-unit';
    claim.semantics.quantifier = 'all';
    claim.semantics.scope.subjectRefs = [{$ref: 99}];
    claim.text = {text: 'This protected field is not a root text carrier.'};
    const raw = v2(contract([claim]), JSON.parse(corpus[0].dictionary));
    const result = expanded(raw).expandedPayload as Json;
    expect(result.claims[0].semantics).toEqual(claim.semantics);
    expect(result.claims[0].references[0].value).toBe(33);
    expect(result.claims[0].text).toEqual(claim.text);
    expect(parseConclusionContractDeclaration(result).issues.length).toBeGreaterThan(0);
  });

  it('counts new collections and exact compiled strings before allocating the bounded result', () => {
    const full = {text: '', conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: []};
    const padding = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - Buffer.byteLength(JSON.stringify(full));
    expect(expanded(v2({text: 'a'.repeat(padding)})).material.utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    expect(decodeConclusionAuthoring(v2({text: 'a'.repeat(padding + 1)}))).toMatchObject({status: 'invalid', code: 'expanded_bytes_exceeded'});
    expect(expanded(v2({values: Array.from({length: 9_993}, () => null)})).material.nodes).toBe(10_000);
    expect(decodeConclusionAuthoring(v2({values: Array.from({length: 9_994}, () => null)})))
      .toMatchObject({status: 'invalid', code: 'expanded_nodes_exceeded'});
    expect(expanded(v2(contract([], {uncertainties: [{text: '中文🙂'}]}))).material)
      .toEqual(expanded(envelope(contract([], {uncertainties: ['中文🙂']}))).material);
  });

  it('requires exact known frame/payload versions and keeps successful actual-version attribution private', () => {
    const raw = v2(contract([]));
    const good = wrapConclusionAuthoringPayload(JSON.stringify(raw), 'authoring_v2');
    const parsed = parseConclusionContractSidecar(good);
    expect(parsed.status).toBe('valid');
    expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'expanded', authoringVersion: 'conclusion_authoring@2'});
    expect(JSON.stringify(parsed)).not.toContain('referenceUses');
    for (const wrong of [wrapConclusionAuthoringPayload(JSON.stringify(raw)),
      wrapConclusionAuthoringPayload(JSON.stringify(envelope(contract([]))), 'authoring_v2')]) {
      const rejected = parseConclusionContractSidecar(wrong);
      expect(rejected.status).toBe('invalid');
      expect(conclusionDeclarationValidationPayload(rejected)).toBeUndefined();
      expect(conclusionDeclarationAuthoring(rejected)).toMatchObject({status: 'invalid', code: 'syntax_mismatch', canonicalRootRepairEligible: false});
    }
    expect(parseConclusionDeclarationPayload(raw, 'canonical_v1').status).toBe('invalid');
    expect(decodeConclusionAuthoring(raw, CONCLUSION_AUTHORING_VERSION)).toMatchObject({status: 'invalid', code: 'syntax_mismatch'});
    expect(decodeConclusionAuthoring({...raw, authoringVersion: 'conclusion_authoring@3'}))
      .toMatchObject({status: 'invalid', code: 'unsupported_version'});
  });

  it('shares final and stream framing across splits, duplicates, ordinary JSON and truncated v2 frames', () => {
    const frame = wrapConclusionAuthoringPayload(JSON.stringify(v2(contract([]))), 'authoring_v2');
    const text = `Before.\n${frame}\nAfter.`;
    const expected = parseConclusionContractSidecar(text).narrative;
    for (let split = 0; split <= text.length; split++) {
      const scanner = new ConclusionSidecarFramingScanner();
      expect(scanner.write(text.slice(0, split)) + scanner.write(text.slice(split)) + scanner.finish()).toBe(expected);
    }
    for (const text of [`${frame}\n${frame}`, `${frame}\n${wrapConclusionAuthoringPayload(JSON.stringify(envelope(contract([]))))}`]) {
      expect(parseConclusionContractSidecar(text).issues).toEqual([{code: 'duplicate_marker', path: '$'}]);
    }
    const truncated = parseConclusionContractSidecar(`Before.\n${frame.slice(0, -3)}`);
    expect(truncated).toMatchObject({status: 'invalid', narrative: 'Before.\n'});
    expect(conclusionDeclarationValidationPayload(truncated)).toBeUndefined();
    const ordinary = `\`\`\`json\n${JSON.stringify(v2(contract([])))}\n\`\`\``;
    expect(parseConclusionContractSidecar(ordinary)).toMatchObject({status: 'absent', narrative: ordinary});
    const example = `\`\`\`\`text\n${frame}\n\`\`\`\``;
    expect(parseConclusionContractSidecar(example)).toMatchObject({status: 'absent', narrative: example});
  });
});

describe('shared explicit authoring ingress', () => {
  it.each(corpus)('keeps wire and expanded validation separate for $kind', fixture => {
    const raw = envelope(contract([JSON.parse(fixture.compact)]), JSON.parse(fixture.dictionary));
    const expected = contract([JSON.parse(fixture.full)]);
    const parsed = parseConclusionDeclarationPayload(raw);
    expect(parsed.rawPayload).toBe(raw);
    expect(conclusionDeclarationValidationPayload(parsed)).toEqual(expected);
    expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'expanded',
      material: {utf8Bytes: Buffer.byteLength(JSON.stringify(expected))}});
    expect(parsed.contract).toEqual(parseConclusionContractDeclaration(expected).contract);
    expect(JSON.stringify(parsed)).not.toContain('referenceUses');
    const framed = parseConclusionContractSidecar(`Body.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw))}`);
    expect(framed.rawPayload).toEqual(raw);
    expect(conclusionDeclarationValidationPayload(framed)).toEqual(expected);
    expect(framed.narrative).toBe('Body.\n');
    expect(framed.status).toBe('valid');
  });

  it('has no validation fallback or repair exemption after authoring decode failure', () => {
    for (const raw of [{authoringVersion: 'unknown'}, envelope(contract([]), [])]) {
      if ('contract' in raw) raw.referenceDictionary = {} as never;
      const parsed = parseConclusionDeclarationPayload(raw);
      expect(parsed.status).toBe('invalid');
      expect(parsed.issues).toEqual([{code: 'invalid_contract', path: '$'}]);
      expect(parsed.rawPayload).toBe(raw);
      expect(conclusionDeclarationValidationPayload(parsed)).toBeUndefined();
      expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'invalid', canonicalRootRepairEligible: false});
    }
  });

  it('keeps full-v1 raw validation and ordinary fenced JSON compatibility unchanged', () => {
    const raw = contract([]);
    const parsed = parseConclusionDeclarationPayload(raw);
    expect(conclusionDeclarationValidationPayload(parsed)).toBe(raw);
    expect(conclusionDeclarationAuthoring(parsed)).toBeUndefined();
    const ordinary = `Body.\n\`\`\`json\n${JSON.stringify(envelope(raw))}\n\`\`\``;
    const inspected = parseConclusionContractSidecar(ordinary);
    expect(inspected.status).toBe('absent');
    expect(inspected.narrative).toBe(ordinary);
  });

  it('rejects an explicit canonical transport carrying an authoring envelope without expanding it', () => {
    const raw = envelope(contract([JSON.parse(corpus[0].compact)]), JSON.parse(corpus[0].dictionary));
    const parsed = parseConclusionDeclarationPayload(raw, 'canonical_v1');
    expect(parsed).toMatchObject({status: 'invalid', rawPayload: raw, bindingEligibility: 'ineligible',
      issues: [{code: 'invalid_contract', path: '$'}]});
    expect(conclusionDeclarationValidationPayload(parsed)).toBeUndefined();
    expect(conclusionDeclarationAuthoring(parsed)).toEqual({status: 'invalid', rawPayload: raw,
      code: 'syntax_mismatch', bindingEligibility: 'ineligible', canonicalRootRepairEligible: false});
    expect(parsed.contract).toBeUndefined();
  });

  it('rejects old/new competing frames without preferring either valid declaration', () => {
    const raw = contract([]);
    const full = renderConclusionContractSidecar(raw as any);
    const compact = wrapConclusionAuthoringPayload(JSON.stringify(envelope(raw)));
    for (const candidate of [`${full}\n${compact}`, `${compact}\n${full}`, `${compact}\n${compact}`]) {
      const parsed = parseConclusionContractSidecar(candidate);
      expect(parsed).toMatchObject({status: 'invalid', bindingEligibility: 'ineligible',
        issues: [{code: 'duplicate_marker', path: '$'}]});
      expect(conclusionDeclarationValidationPayload(parsed)).toBeUndefined();
      expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'invalid', canonicalRootRepairEligible: false});
    }
  });

  it('quarantines unknown versions, malformed JSON and unfinished explicit frames', () => {
    const frame = wrapConclusionAuthoringPayload(JSON.stringify(envelope(contract([]))));
    for (const candidate of [frame.replace('-v1\n', '-v9\n'), `${CONCLUSION_AUTHORING_FENCE}\n{bad}\n\`\`\``,
      frame.slice(0, -3)]) {
      const parsed = parseConclusionContractSidecar(`Before.\n${candidate}`);
      expect(parsed.status).toBe('invalid');
      expect(parsed.narrative).toBe('Before.\n');
      expect(conclusionDeclarationValidationPayload(parsed)).toBeUndefined();
      expect(conclusionDeclarationAuthoring(parsed)).toMatchObject({status: 'invalid', canonicalRootRepairEligible: false});
    }
  });

  it('uses one framing grammar across every chunk split without treating code examples as protocol', () => {
    const frame = wrapConclusionAuthoringPayload(JSON.stringify(envelope(contract([]))));
    for (const newline of ['\n', '\r\n']) {
      const candidate = `Before.\n${frame}\nAfter.`.replace(/\n/g, newline);
      const expected = parseConclusionContractSidecar(candidate).narrative;
      for (let split = 0; split <= candidate.length; split++) {
        const scanner = new ConclusionSidecarFramingScanner();
        expect(scanner.write(candidate.slice(0, split)) + scanner.write(candidate.slice(split)) + scanner.finish()).toBe(expected);
      }
    }
    const example = `\`\`\`\`text\n${frame}\n\`\`\`\``;
    expect(parseConclusionContractSidecar(example)).toMatchObject({status: 'absent', narrative: example});
  });
});

describe('expanded authoring material budgets', () => {
  it.each(['ASCII', '中文🙂', '"\\\b\t\n\f\r\u0000\u001f', '\ud800', '\udc00', '\ud800x\udc00'])('matches independent JSON UTF-8 counting for %p', text => {
    const raw = {[text]: text, values: [null, true, false, 0, -0, 1.2e20]};
    const result = expanded(envelope(raw));
    expect(result.material.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(raw)));
  });

  it('accepts exactly 1 MiB and rejects one byte above without expanded output', () => {
    const padding = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - Buffer.byteLength(JSON.stringify({text: ''}));
    expect(expanded(envelope({text: 'a'.repeat(padding)})).material.utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    expect(decodeConclusionAuthoring(envelope({text: 'a'.repeat(padding + 1)}))).toMatchObject({
      status: 'invalid', code: 'expanded_bytes_exceeded', canonicalRootRepairEligible: false,
    });
  });

  it('counts reused entries at every occurrence, including the full inline escape', () => {
    const entry = {evidenceRefId: 'data:large', value: 'a'.repeat(90_000)};
    const compact = envelope(contract([{text: 'Repeated.', references: Array.from({length: 13}, () => ({$ref: 0}))}]), [entry]);
    const inline = envelope(contract([{text: 'Repeated.', references: Array.from({length: 13}, () => entry)}]));
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    for (const input of [compact, inline]) {
      const result = decodeConclusionAuthoring(input);
      expect(result).toMatchObject({status: 'invalid', code: 'expanded_bytes_exceeded', bindingEligibility: 'ineligible'});
      expect(result).not.toHaveProperty('expandedPayload');
    }
  });

  it('counts the root, container and primitive values at exactly 10,000 nodes', () => {
    expect(expanded(envelope({values: Array.from({length: 9_998}, () => null)})).material.nodes).toBe(10_000);
    expect(decodeConclusionAuthoring(envelope({values: Array.from({length: 9_999}, () => null)})))
      .toMatchObject({status: 'invalid', code: 'expanded_nodes_exceeded'});
  });

  it('counts the contract root as depth one and fails before cloning depth 25', () => {
    let nested: unknown = 'leaf';
    for (let index = 1; index < 24; index++) nested = {child: nested};
    expect(expanded(envelope(nested)).material.depth).toBe(24);
    expect(decodeConclusionAuthoring(envelope({child: nested}))).toMatchObject({status: 'invalid', code: 'expanded_depth_exceeded'});
  });

  it('keeps aliases at destination depth without an extra wrapper level', () => {
    const raw = contract([{text: 'Reference.', references: [{$ref: 0}]}]);
    const result = expanded(envelope(raw, [{evidenceRefId: 'a', rowSelector: {upid: 7}}]));
    // contract / claims / claim / references / reference / rowSelector / upid
    expect(result.material.depth).toBe(7);
  });

  it('rejects cycles/accessors without invoking model-controlled code and preserves proto-named data', () => {
    const cycle: Json = {}; cycle.self = cycle;
    expect(decodeConclusionAuthoring(envelope(cycle))).toMatchObject({status: 'invalid', code: 'non_json_value'});
    let invoked = false;
    const accessor = Object.defineProperty({}, 'private', {enumerable: true, get() {invoked = true; return 'secret';}});
    expect(decodeConclusionAuthoring(envelope(accessor))).toMatchObject({status: 'invalid', code: 'non_json_value'});
    expect(invoked).toBe(false);
    const proto = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal"}');
    const result = expanded(envelope(proto));
    expect(result.expandedPayload).toEqual(proto);
    expect(Object.getPrototypeOf(result.expandedPayload)).toBe(Object.prototype);
    expect(({} as Json).polluted).toBeUndefined();
  });
});
