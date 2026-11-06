// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument} from '../authoredClaimDocument';
import {CONCLUSION_AUTHORING_LIMITS} from '../conclusionAuthoring';
import {CONCLUSION_PROTOCOL_VALUES, parseConclusionDeclarationPayload} from '../conclusionContract';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../../services/evidence/evidenceCapture';
import {prepareClaimEvidence} from '../../../services/evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../../services/verifier/claimVerificationRunner';
import {assessNumericPresentations} from '../../../services/numericPresentationAssessment';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';

type Json = Record<string, any>;
const contract = (claims: unknown[] = [], extra: Json = {}): Json => ({schemaVersion: 'conclusion_contract_v1',
  mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: [], ...extra});
const document = (payload: Json, bodyParts: unknown[] = []) =>
  ({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, contract: payload, bodyParts});
const ref = {evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms', value: 10};
const numeric = (): Json => ({id: 'duration', text: '10 ms', kind: 'numeric', references: [{...ref}],
  semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
    discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [{...ref}]},
    numeric: {operator: 'eq', value: 10, unit: 'ms', presentation: {schemaVersion: 'numeric_presentation@1',
      unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero',
      quotes: [{text: '10 ms', occurrence: 0}, {text: '10 ms', occurrence: 1}]}}}});
const twice = ['Observation: ', {claimText: 'duration'}, '\n\n|Metric|\n|---|\n|', {claimText: 'duration'}, '|'];

function compile(value: unknown) {
  const result = compileAuthoredClaimDocument(JSON.stringify(value));
  if (result.status !== 'compiled') throw new Error(`Unexpected projection failure: ${result.code}`);
  return result;
}

/** Independent material oracle: actual JSON.stringify and UTF-8 serialization. */
function material(value: unknown): {utf8Bytes: number; nodes: number; depth: number} {
  const children = value && typeof value === 'object' ? Object.values(value) : [];
  const nested = children.map(material);
  return {utf8Bytes: Buffer.byteLength(JSON.stringify(value)),
    nodes: 1 + nested.reduce((sum, child) => sum + child.nodes, 0),
    depth: 1 + nested.reduce((maximum, child) => Math.max(maximum, child.depth), 0)};
}

async function verify(compiled: ReturnType<typeof compile>, allowed = true) {
  const store = new ArtifactStore();
  const data = {columns: ['dur_ms', 'other_ms'], rows: [[10, 10]]};
  const origin = {kind: 'skill_literal' as const, skillId: 'duration_fixture', stepId: 'root',
    definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)};
  const witness = captureEvidenceTable(data, {dur_ms: {unit: 'ms', origin}, other_ms: {unit: 'ms', origin}});
  const id = store.store({skillId: 'duration_fixture', data, sourceToolCallId: 'invoke:duration',
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'current', traceSide: 'current'})});
  expect(store.registerEvidenceCapture(id, witness, {evidenceRefId: 'data:duration'})).toBe(true);
  const parsed = compiled.canonicalParse;
  const preparedEvidence = await prepareClaimEvidence({conclusionContract: parsed.contract, bindingEligibility: parsed.bindingEligibility,
    evidenceReadView: store.createEvidenceReadView({ownerKey: 'fixture', allowedTraces: allowed
      ? [{traceId: 'current', traceSide: 'current'}] : []})});
  const verified = runClaimVerification({conclusionContract: parsed.contract, preparedEvidence});
  const presentation = assessNumericPresentations({contract: parsed.contract, claims: verified.claimVerificationResult.claimResults,
    support: verified.claimSupport, body: compiled.body,
    candidate: {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
      conclusionFingerprint: analysisDeliveryFingerprint(compiled.body)}}).get('duration');
  return {verified, presentation};
}

describe('experimental authored claim document pure compiler', () => {
  it('renders an explicitly authored 10 ms twice and passes independent issued proof and presentation', async () => {
    const payload = contract([numeric()]);
    const raw = JSON.stringify(document(payload, twice), null, 2);
    const result = compileAuthoredClaimDocument(raw);
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.privateRawDocument).toBe(raw);
    expect(result.rawCanonicalPayload).toEqual(payload);
    expect(result.body).toBe('Observation: 10 ms\n\n|Metric|\n|---|\n|10 ms|');
    expect(result.occurrences).toEqual([
      {partIndex: 1, claimOrdinal: 1, claimId: 'duration', startUtf16: 13, endUtf16: 18},
      {partIndex: 3, claimOrdinal: 1, claimId: 'duration', startUtf16: 36, endUtf16: 41},
    ]);
    for (const occurrence of result.occurrences) {
      expect(result.body.slice(occurrence.startUtf16, occurrence.endUtf16)).toBe(numeric().text);
    }
    expect(result.canonicalParse).toEqual(parseConclusionDeclarationPayload(payload, 'canonical_v1'));
    expect(result.material).toEqual({rawInputUtf8Bytes: Buffer.byteLength(raw), raw: material(JSON.parse(raw)),
      expanded: material({body: result.body, contract: payload}), bodyUtf8Bytes: Buffer.byteLength(result.body), bodyUtf16Length: result.body.length});
    const {verified, presentation} = await verify(result);
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof)
      .toMatchObject({status: 'proved', reason: 'numeric_operator_proved'});
    expect(presentation).toMatchObject({status: 'matched', reason: 'display_matches', locations: [
      {start: result.occurrences[0].startUtf16, end: result.occurrences[0].endUtf16},
      {start: result.occurrences[1].startUtf16, end: result.occurrences[1].endUtf16}]});
    expect(result).not.toHaveProperty('verified');
    expect(result).not.toHaveProperty('completion');
  });

  it.each(['missing', 'out_of_range'] as const)('does not supply a %s occurrence for repeated numeric presentation', async failure => {
    const claim = numeric();
    claim.semantics.numeric.presentation.quotes = failure === 'missing' ? [{text: '10 ms'}]
      : [{text: '10 ms', occurrence: 0}, {text: '10 ms', occurrence: 2}];
    const result = compile(document(contract([claim]), twice));
    expect(result.rawCanonicalPayload.claims).toEqual([claim]);
    const {verified, presentation} = await verify(result);
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof?.status).toBe('proved');
    expect(presentation).toMatchObject({status: 'not_checked', reason: 'quote_unresolved'});
  });

  it.each(['asserted_value', 'reference_value', 'unit', 'unauthorized'] as const)('keeps %s errors separate from rendering', async failure => {
    const claim = numeric();
    if (failure === 'asserted_value') claim.semantics.numeric.value = 11;
    if (failure === 'unit') claim.semantics.numeric.unit = 'count';
    if (failure === 'reference_value') {
      claim.references[0].value = 11;
      claim.semantics.scope.subjectRefs[0].value = 11;
    }
    const result = compile(document(contract([claim]), twice));
    expect(result.rawCanonicalPayload.claims).toEqual([claim]);
    expect(result.body).toBe('Observation: 10 ms\n\n|Metric|\n|---|\n|10 ms|');
    const {verified, presentation} = await verify(result, failure !== 'unauthorized');
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof?.status).not.toBe('proved');
    expect(presentation?.status).not.toBe('matched');
  });

  it('does not repair a same-valued wrong column or infer subject correctness from a finite value proof', async () => {
    const claim = numeric();
    claim.references[0].column = 'other_ms';
    claim.semantics.scope.subjectRefs[0].column = 'other_ms';
    const result = compile(document(contract([claim]), twice));
    expect(result.rawCanonicalPayload.claims).toEqual([claim]);
    const {verified} = await verify(result);
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof?.status).toBe('proved');
    // Subject/name/omission review is still independent; this compiler has no verdict.
    expect(result).not.toHaveProperty('verified');
  });

  it.each(['| pipe |', '\n\r\t', '```json\n{"claimText":"other"}\n```', '<!-- example -->', '"\\\u0000', '中文 😀'])
  ('copies literal and claim text verbatim: %p', text => {
    const claim = {...numeric(), text};
    const result = compile(document(contract([claim]), ['before', {claimText: 'duration'}, text, 'after']));
    expect(result.body).toBe(`before${text}${text}after`);
    expect(result.rawCanonicalPayload.claims).toEqual([claim]);
    expect(result.occurrences[0]).toMatchObject({startUtf16: 6, endUtf16: 6 + text.length});
    expect(result.material.expanded).toEqual(material({body: result.body, contract: result.rawCanonicalPayload}));
  });

  it.each([
    ['\ud83d', '', '\ude00'], ['\ud83d', '\ud83d', '\ude00'], ['\ude00', '\ud83d'],
    ['\ud83d', 'x', '\ude00'], ['', '😀', '\ud83d'], ['\u0008', '\u000b', '\n', '"', '\\'],
  ])('measures concatenated UTF-16 parts, including split surrogate pairs: %p', (...parts) => {
    const claim = {...numeric(), text: parts[1]};
    const bodyParts = [parts[0], {claimText: 'duration'}, ...parts.slice(2)];
    const result = compile(document(contract([claim]), bodyParts));
    expect(result.body).toBe(parts.join(''));
    expect(result.material.bodyUtf8Bytes).toBe(Buffer.byteLength(parts.join('')));
    expect(result.material.bodyUtf16Length).toBe(parts.join('').length);
    expect(result.material.raw).toEqual(material(document(contract([claim]), bodyParts)));
    expect(result.material.expanded).toEqual(material({body: parts.join(''), contract: contract([claim])}));
    expect(result.occurrences[0]).toMatchObject({startUtf16: parts[0].length, endUtf16: parts[0].length + parts[1].length});
  });

  it('allows empty text and zero implicit concatenation without inventing missing facts', () => {
    const empty = compile(document(contract(), []));
    expect(empty.body).toBe('');
    expect(empty.material.bodyUtf8Bytes).toBe(0);
    const result = compile(document(contract([{id: 'empty', text: '', semantics: false}]), ['A', {claimText: 'empty'}, 'B']));
    expect(result.body).toBe('AB');
    expect(result.occurrences).toEqual([{partIndex: 1, claimOrdinal: 1, claimId: 'empty', startUtf16: 1, endUtf16: 1}]);
    expect(result.rawCanonicalPayload.claims).toEqual([{id: 'empty', text: '', semantics: false}]);
  });

  it.each([
    [null, 'invalid_envelope'], [[], 'invalid_envelope'],
    [{...document(contract()), extra: 1}, 'invalid_envelope'],
    [{...document(contract()), representationVersion: 'authored_claim_document@2'}, 'unsupported_version'],
    [{...document(contract()), contract: []}, 'invalid_envelope'],
    [{...document(contract()), bodyParts: 'text'}, 'invalid_envelope'],
    [document(contract(), [1]), 'invalid_body_part'], [document(contract(), [null]), 'invalid_body_part'],
    [document(contract(), [{claimText: ''}]), 'invalid_body_part'],
    [document(contract(), [{claimText: 'x', fallback: 'text'}]), 'invalid_body_part'],
    [document(contract(), [{claimText: 'x'}]), 'unknown_claim_id'],
    [document(contract([{id: 'x', text: 3}]), [{claimText: 'x'}]), 'claim_text_unavailable'],
    [document(contract([{id: 'x', text: 'one'}, {id: 'x', text: 'two', semantics: false}]), [{claimText: 'x'}]), 'ambiguous_claim_id'],
  ])('rejects only an unresolved representation, preserving the private raw document: %p', (value, code) => {
    const raw = JSON.stringify(value);
    expect(compileAuthoredClaimDocument(raw)).toEqual({status: 'projection_failed', code, privateRawDocument: raw});
  });

  it('matches raw IDs exactly without trimming or case coercion', () => {
    const payload = contract([{id: ' x ', text: 'spaced'}, {id: 'x', text: 'plain'}, {id: '__proto__', text: 'own'}]);
    const result = compile(document(payload, [{claimText: ' x '}, '/', {claimText: 'x'}, '/', {claimText: '__proto__'}]));
    expect(result.body).toBe('spaced/plain/own');
    expect(result.occurrences.map(item => item.claimOrdinal)).toEqual([1, 2, 3]);
    expect(compileAuthoredClaimDocument(JSON.stringify(document(payload, [{claimText: 'X'}]))))
      .toMatchObject({status: 'projection_failed', code: 'unknown_claim_id'});
  });

  it('preserves unreferenced duplicate IDs, unreadable items and referenced invalid semantics as raw canonical input', () => {
    const bad = {...numeric(), id: 'invalid', text: 'Invalid but visible.', semantics: {polarity: 'invented'}};
    const payload = contract([{id: 'duplicate', text: 'first'}, {id: 'duplicate'}, null, bad]);
    const result = compile(document(payload, [{claimText: 'invalid'}]));
    expect(result.body).toBe(bad.text);
    expect(result.occurrences[0].claimOrdinal).toBe(4);
    expect(result.rawCanonicalPayload).toEqual(payload);
    expect(result.canonicalParse).toEqual(parseConclusionDeclarationPayload(payload, 'canonical_v1'));
    expect(result.canonicalParse.status).not.toBe('valid');
    expect(result.rawCanonicalPayload.claims).toHaveLength(4);
  });

  it('does not hydrate cell aliases, authoring dictionaries or parser metadata', () => {
    const claim = numeric();
    claim.references = [{cell: 'unissued', value: 10}, {$ref: 0}];
    const payload = contract([claim], {verified: true, authoringVersion: 'conclusion_authoring@2', referenceDictionary: [ref]});
    const result = compile(document(payload, [{claimText: 'duration'}]));
    expect(result.rawCanonicalPayload).toEqual(payload);
    expect(result.canonicalParse.status).toBe('invalid');
    expect(result.canonicalParse.bindingEligibility).toBe('ineligible');
  });

  it('retains all eight kinds, source bindings, dual-trace references and explicit stances', () => {
    const claims: Json[] = CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => ({id: kind, kind,
      text: `${kind}: explicitly authored.`, references: [], semantics: {schemaVersion: 'claim_semantics@1',
        predicate: `unconfigured.${kind}`, polarity: 'affirmed', discourse: 'asserted', quantifier: 'one',
        modality: 'certain', scope: {population: 'cited_rows', subjectRefs: []}}}));
    const numericIndex = claims.findIndex(claim => claim.kind === 'numeric');
    claims[numericIndex] = {...numeric(), id: 'numeric'};
    const comparison = claims.find(claim => claim.kind === 'comparison')!;
    comparison.references = [ref, {evidenceRefId: 'data:reference', rowIndex: 0, column: 'dur_ms', value: 8}];
    comparison.semantics = {...numeric().semantics, predicate: 'comparison.delta',
      scope: {population: 'cited_rows', subjectRefs: [ref], objectRefs: [comparison.references[1]]},
      numeric: {operator: 'eq', value: 2, unit: 'ms'}};
    comparison.relationRefs = ['proposal:delta'];
    const cause = claims.find(claim => claim.kind === 'causal')!;
    cause.semantics = {...cause.semantics, predicate: 'source.causes_delay', modality: 'possible', quantifier: 'some',
      conditions: ['Execution and causality are not established.']};
    const payload = contract(claims, {sourceClaimBindings: [{claimId: 'causal', sourceReferenceIds: ['source:issued'], traceEvidenceRefIds: []}],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:delta', kind: 'comparison_delta',
        direction: 'subject_to_object', subject: ref, object: comparison.references[1], value: 2, unit: 'ms', deltaDirection: 'current_minus_reference'}]});
    const result = compile(document(payload, claims.flatMap(claim => [{claimText: claim.id}, '\n'])));
    expect(result.rawCanonicalPayload).toEqual(payload);
    expect(result.canonicalParse).toEqual(parseConclusionDeclarationPayload(payload, 'canonical_v1'));
    expect(result.canonicalParse.issues).toEqual([]);
    expect(result.body).toBe(claims.map(claim => `${claim.text}\n`).join(''));
    for (const polarity of CONCLUSION_PROTOCOL_VALUES.polarity) {
      for (const discourse of CONCLUSION_PROTOCOL_VALUES.discourse) {
        for (const quantifier of CONCLUSION_PROTOCOL_VALUES.quantifier) {
          for (const modality of CONCLUSION_PROTOCOL_VALUES.modality) {
            const stanced = structuredClone(payload);
            stanced.claims[0].semantics = {...stanced.claims[0].semantics, polarity, discourse,
              quantifier, modality, conditions: ['Only the stated sample.']};
            const compiled = compile(document(stanced, [{claimText: stanced.claims[0].id}]));
            expect(compiled.rawCanonicalPayload).toEqual(stanced);
            expect(compiled.canonicalParse).toEqual(parseConclusionDeclarationPayload(stanced, 'canonical_v1'));
          }
        }
      }
    }
  });

  it('keeps unknown distinct from a model-authored zero and does not correct non-finite raw data', () => {
    const unknown = {id: 'unknown', text: 'Not known.', kind: 'inference', references: [], semantics: {
      schemaVersion: 'claim_semantics@1', predicate: 'unconfigured.unknown', polarity: 'undetermined', discourse: 'asserted',
      quantifier: 'one', modality: 'undetermined', scope: {population: 'selected_interval', subjectRefs: []}}};
    const zero = numeric(); zero.id = 'zero'; zero.text = '0 ms'; zero.semantics.numeric.value = 0;
    const result = compile(document(contract([unknown, zero]), [{claimText: 'unknown'}, '\n', {claimText: 'zero'}]));
    expect(result.body).toBe('Not known.\n0 ms');
    expect(result.rawCanonicalPayload.claims).toEqual([unknown, zero]);
    const raw = JSON.stringify(document(contract([numeric()], {untrusted: 0}), [])).replace('"untrusted":0', '"untrusted":1e400');
    const nonfinite = compileAuthoredClaimDocument(raw);
    expect(nonfinite.status).toBe('compiled');
    if (nonfinite.status === 'compiled') {
      expect(nonfinite.rawCanonicalPayload.untrusted).toBe(Infinity);
      expect(nonfinite.material.raw).toEqual(material(JSON.parse(raw)));
      expect(nonfinite.privateRawDocument).toBe(raw);
    }
  });
});

describe('authored document pre-allocation resource limits', () => {
  const limit = CONCLUSION_AUTHORING_LIMITS;
  it('bounds raw input bytes independently of compact parsed material', () => {
    const raw = JSON.stringify(document(contract(), []));
    const exact = raw + ' '.repeat(limit.utf8Bytes - Buffer.byteLength(raw));
    expect(compileAuthoredClaimDocument(exact)).toMatchObject({status: 'compiled', material: {rawInputUtf8Bytes: limit.utf8Bytes}});
    expect(compileAuthoredClaimDocument(exact + ' ')).toMatchObject({status: 'projection_failed', code: 'raw_input_bytes_exceeded'});
    expect(compileAuthoredClaimDocument('{"private":"SENSITIVE",}')).toEqual({status: 'projection_failed', code: 'invalid_json',
      privateRawDocument: '{"private":"SENSITIVE",}'});
  });

  it('bounds actual serialized raw material including escaped lone surrogates', () => {
    const base = document(contract([], {padding: ''}), []);
    const remaining = limit.utf8Bytes - Buffer.byteLength(JSON.stringify(base));
    base.contract.padding = '\ud800'.repeat(Math.floor(remaining / 6)) + 'x'.repeat(remaining % 6);
    const serialized = JSON.stringify(base);
    expect(Buffer.byteLength(serialized)).toBe(limit.utf8Bytes);
    const raw = serialized.replace(/\\ud800/g, '\ud800');
    expect(Buffer.byteLength(raw)).toBeLessThan(limit.utf8Bytes);
    expect(compileAuthoredClaimDocument(raw)).toMatchObject({status: 'compiled', material: {raw: {utf8Bytes: limit.utf8Bytes}}});
    const tooLarge = raw.replace('"padding":"', '"padding":"x');
    expect(compileAuthoredClaimDocument(tooLarge)).toMatchObject({status: 'projection_failed', code: 'raw_bytes_exceeded'});
  });

  it.each(['x', '"\n', '😀'])('admits exactly the aggregate byte cap, then rejects expansion without truncation: %p', token => {
    const claim = {id: 'x', text: '', references: []};
    const payload = contract([claim]);
    const fixed = Buffer.byteLength(JSON.stringify({body: '', contract: payload}));
    const perRepeat = (Buffer.byteLength(JSON.stringify(token)) - 2) * 3;
    claim.text = token.repeat(Math.floor((limit.utf8Bytes - fixed) / perRepeat));
    const padding = 'x'.repeat((limit.utf8Bytes - fixed) % perRepeat);
    const input = document(payload, [{claimText: 'x'}, {claimText: 'x'}, padding]);
    const expected = {body: claim.text + claim.text + padding, contract: payload};
    expect(Buffer.byteLength(JSON.stringify(expected))).toBe(limit.utf8Bytes);
    const result = compile(input);
    expect(result.body).toBe(expected.body);
    expect(result.material.expanded).toEqual(material(expected));
    input.bodyParts.push('x');
    const failed = compileAuthoredClaimDocument(JSON.stringify(input));
    expect(failed).toMatchObject({status: 'projection_failed', code: 'expanded_bytes_exceeded'});
    expect(failed).not.toHaveProperty('body');
    expect(failed).not.toHaveProperty('rawCanonicalPayload');
  });

  it('bounds raw nodes and depth before canonical parsing, including unused fields', () => {
    const nodeInput = document(contract([], {extra: []}), []);
    nodeInput.contract.extra = Array(limit.nodes - material(nodeInput).nodes).fill(null);
    expect(material(nodeInput).nodes).toBe(limit.nodes);
    expect(compile(nodeInput).material.raw.nodes).toBe(limit.nodes);
    nodeInput.contract.extra.push(null);
    expect(compileAuthoredClaimDocument(JSON.stringify(nodeInput))).toMatchObject({status: 'projection_failed', code: 'raw_nodes_exceeded'});
    let deep: unknown = 0;
    for (let index = 0; index < limit.depth - 3; index++) deep = [deep];
    const depthInput = document(contract([], {extra: deep}), []);
    expect(material(depthInput).depth).toBe(limit.depth);
    expect(compile(depthInput).material.expanded.depth).toBeLessThanOrEqual(limit.depth);
    depthInput.contract.extra = [deep];
    expect(compileAuthoredClaimDocument(JSON.stringify(depthInput))).toMatchObject({status: 'projection_failed', code: 'raw_depth_exceeded'});
  });

  it('counts every repeated text expansion and never returns a shortened valid subset', () => {
    const payload = contract([{id: 'large', text: 'large'.repeat(20000)}, {...numeric(), id: 'unused-invalid', semantics: false}]);
    const raw = JSON.stringify(document(payload, Array.from({length: 1000}, () => ({claimText: 'large'}))));
    expect(Buffer.byteLength(raw)).toBeLessThan(limit.utf8Bytes);
    const result = compileAuthoredClaimDocument(raw);
    expect(result).toEqual({status: 'projection_failed', code: 'expanded_bytes_exceeded', privateRawDocument: raw});
  });
});
