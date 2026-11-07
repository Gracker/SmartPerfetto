// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject} from '../authoredClaimObject';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument, measureAuthoredJson} from '../authoredClaimDocument';
import {authoredClaimObjectSchema} from '../authoredClaimObjectSchema';
import {CONCLUSION_AUTHORING_LIMITS, CONCLUSION_AUTHORING_VERSION_V2, decodeConclusionAuthoring} from '../conclusionAuthoring';
import {CONCLUSION_PROTOCOL_VALUES, parseConclusionDeclarationPayload} from '../conclusionContract';
import {findQuoteOccurrence, quoteOccurrenceAtSpan} from '../numericQuoteLocator';
import {createJsonSchemaFromZodRawShape} from '../../../agentRuntime/runtimeToolSpec';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../../services/evidence/evidenceCapture';
import {prepareClaimEvidence} from '../../../services/evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../../services/verifier/claimVerificationRunner';
import {assessNumericPresentations} from '../../../services/numericPresentationAssessment';
import {buildTraceProcessorQueryProvenance} from '../../../services/traceProcessorConnectionModel';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';

type Json = Record<string, any>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const fullRef = {evidenceRefId: 'data:duration', rowIndex: 0, column: 'duration', value: 10};
const frame = () => ({predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted', quantifier: 'one',
  modality: 'certain', conditions: null, population: 'cited_rows'});
const wireRef = (fields: Json = {}) => ({evidenceRefId: null, sourceRef: null, sourceToolCallId: null,
  artifactId: null, sourceArtifactId: null, column: null, rowIndex: null, rowSelector: null, value: {kind: 'absent'}, ...fields});
function fixture() {
  const wire: Json = {representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    referenceDictionary: [wireRef({evidenceRefId: 'data:duration', column: 'duration', rowIndex: 0, value: {kind: 'present', value: 10}})],
    semanticFrames: [frame()], contract: {mode: 'focused_answer', conclusions: null, clusters: null, evidenceChain: null,
      uncertainties: null, nextSteps: null, relationProposals: null, sourceClaimBindings: null, metadata: null,
      claims: [{id: 'duration', conclusionId: null, text: '10 ms', kind: 'numeric', references: [0], artifactRefs: null,
        relationRefs: null, supportLevel: null, semantics: {frameIndex: 0, subjectRefs: [0], objectRefs: null,
          timeRangeNs: null, numeric: {operator: 'eq', value: 10, unit: 'ms', presentation: {unit: 'ms', decimalPlaces: 0,
            rounding: 'half_away_from_zero', quotes: [
              {kind: 'body_part', text: '10 ms', partIndex: 1, localOccurrence: null},
              {kind: 'body_part', text: '10 ms', partIndex: 3, localOccurrence: null}]}}}}]},
    bodyParts: ['Observation: ', {claimText: 'duration'}, '\n|Metric|\n|---|\n|', {claimText: 'duration'}, '|']};
  // Independently authored full canonical oracle: never produced by the new expander.
  const full: Json = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
    evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'duration', text: '10 ms', kind: 'numeric',
      references: [{...fullRef}], semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell',
        polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [{...fullRef}]}, numeric: {operator: 'eq', value: 10, unit: 'ms',
          presentation: {schemaVersion: 'numeric_presentation@1', unit: 'ms', decimalPlaces: 0,
            rounding: 'half_away_from_zero', quotes: [{text: '10 ms', occurrence: 0}, {text: '10 ms', occurrence: 1}]}}}}]};
  return {wire, full, body: 'Observation: 10 ms\n|Metric|\n|---|\n|10 ms|'};
}
function compiled(wire: unknown) {
  const result = compileAuthoredClaimObject(wire);
  if (result.status !== 'compiled') throw new Error(`Fixture failed: ${result.code}`);
  return result;
}
function material(value: unknown): {utf8Bytes: number; nodes: number; depth: number} {
  const children = value && typeof value === 'object' ? Object.values(value) : [];
  const nested = children.map(material);
  return {utf8Bytes: Buffer.byteLength(JSON.stringify(value)), nodes: 1 + nested.reduce((sum, child) => sum + child.nodes, 0),
    depth: 1 + nested.reduce((max, child) => Math.max(max, child.depth), 0)};
}
function proof(allowed = true, scopeKnown = true) {
  const store = new ArtifactStore();
  const origin = {kind: 'skill_literal' as const, skillId: 'fixture', stepId: 'root', definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)};
  const data = {columns: ['duration', 'other', 'state', 'process_name', 'ts', 'dur'], rows: [[10, 10, 'Ready', 'sample.app', '100', '20'], [8, 10, 'Ready', 'other.app', '110', '20']]};
  const fields = {duration: {origin, unit: 'ms', metricId: 'duration', aggregation: 'sum', populationKey: 'sample'},
    other: {origin, unit: 'ms'}, state: {origin}, process_name: {origin},
    ts: {origin, unit: 'ns', clock: 'trace_monotonic' as const, timeRole: 'start' as const},
    dur: {origin, unit: 'ns', clock: 'trace_monotonic' as const, timeRole: 'duration' as const}};
  const id = store.store({skillId: 'fixture', data, sourceToolCallId: 'call:fixture',
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'current', traceSide: 'current'}),
    ...(scopeKnown ? {scopeProvenance: {version: 'process_scope_evidence@1' as const, entries: [{role: 'target' as const,
      scope: {mode: 'unscoped' as const, traceId: 'current', traceSide: 'current' as const}, fields: data.columns, availability: 'available' as const}]}} : {})});
  store.registerEvidenceCapture(id, captureEvidenceTable(data, fields), {evidenceRefId: 'data:duration'});
  const referenceData = {columns: ['duration'], rows: [[8]]};
  const referenceId = store.store({skillId: 'fixture', data: referenceData,
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'reference', traceSide: 'reference'}),
    ...(scopeKnown ? {scopeProvenance: {version: 'process_scope_evidence@1' as const, entries: [{role: 'target' as const,
      scope: {mode: 'unscoped' as const, traceId: 'reference', traceSide: 'reference' as const}, fields: referenceData.columns, availability: 'available' as const}]}} : {})});
  store.registerEvidenceCapture(referenceId, captureEvidenceTable(referenceData, {duration: fields.duration}), {evidenceRefId: 'data:reference'});
  return async (payload: Json, body: string) => {
    const parsed = parseConclusionDeclarationPayload(payload, 'canonical_v1');
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: parsed.contract, bindingEligibility: parsed.bindingEligibility,
      evidenceReadView: store.createEvidenceReadView({ownerKey: 'fixture', allowedTraces: allowed
        ? [{traceId: 'current', traceSide: 'current'}, {traceId: 'reference', traceSide: 'reference'}] : []})});
    const verified = runClaimVerification({conclusionContract: parsed.contract, preparedEvidence});
    const presentation = assessNumericPresentations({contract: parsed.contract, claims: verified.claimVerificationResult.claimResults,
      support: verified.claimSupport, body, candidate: {candidateRef: 'candidate', runId: 'run', attemptId: 'attempt', conclusionFingerprint: analysisDeliveryFingerprint(body)}});
    // Both representations use this same issued store/read-view authority; compare verdict facts separately from IDs.
    return {parsed, verified: verified.claimVerificationResult.claimResults.map(claim => {
      const references = claim.referenceResults;
      if (!references) throw new Error('Fixture claim verification omitted reference results');
      return {status: claim.status,
        proof: claim.deterministicProof && {status: claim.deterministicProof.status, reason: claim.deterministicProof.reason},
        references: references.map(ref => ({status: ref.status, message: ref.message})), coverage: claim.propositionCoverage};
    }),
      presentation: [...presentation.values()].map(value => ({status: value.status, reason: value.reason, locations: value.locations}))};
  };
}

describe('native authored object pure compiler', () => {
  it.each(['uncertainties', 'nextSteps'] as const)('rejects a native %s text carrier while retaining the old authoring capability', field => {
    const f = fixture();
    f.wire.contract[field] = [{text: 'PRIVATE_NATIVE_CARRIER'}];
    const result = compileAuthoredClaimObject(f.wire);
    expect(result.status).toBe('projection_failed');
    if (result.status === 'projection_failed') expect(result.code).toBe('invalid_structure');
    expect(result.privateNativeDocument).toBe(f.wire);
    expect(result).not.toHaveProperty('rawCanonicalPayload');
    const legacy = decodeConclusionAuthoring({authoringVersion: CONCLUSION_AUTHORING_VERSION_V2,
      referenceDictionary: [], contract: {...f.full, [field]: [{text: 'PRIVATE_NATIVE_CARRIER'}]}});
    expect(legacy.status).toBe('expanded');
    if (legacy.status === 'expanded') {
      expect(legacy.expandedPayload[field]).toEqual(['PRIVATE_NATIVE_CARRIER']);
      expect(parseConclusionDeclarationPayload(legacy.expandedPayload, 'canonical_v1').status).toBe('valid');
    }
  });

  it.each(['uncertainties', 'nextSteps'] as const)('retains native %s strings, empty arrays and null semantics', field => {
    for (const value of [null, [], ['', 'Exact text\n中文 {"text":"literal"}']]) {
      const f = fixture(); f.wire.contract[field] = value; f.full[field] = value === null ? [] : value;
      const result = compiled(f.wire);
      expect(result.rawCanonicalPayload).toEqual(f.full);
      expect(result.privateNativeDocument.contract).toEqual(f.wire.contract);
    }
  });

  it('matches an independently authored canonical document, body, material and two local quote bindings', async () => {
    const f = fixture(), before = copy(f.wire), result = compiled(f.wire);
    expect(result.rawCanonicalPayload).toEqual(f.full);
    expect(result.body).toBe(f.body);
    expect(result.canonicalParse).toEqual(parseConclusionDeclarationPayload(f.full, 'canonical_v1'));
    expect(result.material).toEqual({nativeDocument: material(f.wire), expanded: material({body: f.body, contract: f.full}),
      bodyUtf8Bytes: Buffer.byteLength(f.body), bodyUtf16Length: f.body.length});
    expect(result.quoteBindings.map(binding => binding.canonicalQuote)).toEqual([{text: '10 ms', occurrence: 0}, {text: '10 ms', occurrence: 1}]);
    for (const binding of result.quoteBindings) expect(f.body.slice(binding.originalSpan.startUtf16, binding.originalSpan.endUtf16)).toBe('10 ms');
    expect(result.partSpans).toHaveLength(5); expect(f.wire).toEqual(before);
    const evaluate = proof(), actual = await evaluate(result.rawCanonicalPayload, result.body);
    expect(actual).toEqual(await evaluate(f.full, f.body));
    expect(actual.verified[0].proof).toEqual({status: 'proved', reason: 'numeric_operator_proved'});
    expect(actual.presentation[0]).toMatchObject({status: 'matched', reason: 'display_matches'});
    expect(result).not.toHaveProperty('verified'); expect(result).not.toHaveProperty('completion'); expect(result).not.toHaveProperty('documentJson');
  });

  it.each(CONCLUSION_PROTOCOL_VALUES.claimKind)('preserves legal %s declarations and existing proof outcomes', async kind => {
    const f = fixture(), c = f.wire.contract.claims[0], full = f.full.claims[0];
    c.kind = full.kind = kind; c.text = full.text = `Authored ${kind}.`; f.wire.bodyParts = [{claimText: 'duration'}];
    c.semantics.numeric = null; delete full.semantics.numeric;
    let expected = 'unsupported_predicate';
    if (kind === 'numeric' || kind === 'comparison') {
      c.semantics.numeric = {operator: 'eq', value: kind === 'numeric' ? 10 : 2, unit: 'ms', presentation: null};
      full.semantics.numeric = {operator: 'eq', value: kind === 'numeric' ? 10 : 2, unit: 'ms'};
      expected = kind === 'numeric' ? 'numeric_operator_proved' : 'cited_metric_delta_proved';
      if (kind === 'comparison') {
        f.wire.semanticFrames[0].predicate = full.semantics.predicate = 'comparison.delta';
        f.wire.referenceDictionary.push(wireRef({evidenceRefId: 'data:reference', rowIndex: 0, column: 'duration', value: {kind: 'present', value: 8}}));
        c.references.push(1); c.semantics.objectRefs = [1];
        const right = {evidenceRefId: 'data:reference', rowIndex: 0, column: 'duration', value: 8};
        full.references.push(right); full.semantics.scope.objectRefs = [right];
      }
    } else if (kind === 'identity' || kind === 'categorical') {
      f.wire.semanticFrames[0].predicate = full.semantics.predicate = 'captured.cell';
      const column = kind === 'identity' ? 'process_name' : 'state', value = kind === 'identity' ? 'sample.app' : 'Ready';
      f.wire.referenceDictionary[0].column = column; f.wire.referenceDictionary[0].value.value = value;
      full.references[0] = {evidenceRefId: 'data:duration', rowIndex: 0, column, value}; full.semantics.scope.subjectRefs = [full.references[0]];
      expected = 'captured_cell_value_proved';
    } else if (kind === 'time_range') {
      f.wire.semanticFrames[0].predicate = full.semantics.predicate = 'interval.overlap';
      f.wire.referenceDictionary = [wireRef({evidenceRefId: 'data:duration', rowIndex: 0}), wireRef({evidenceRefId: 'data:duration', rowIndex: 1})];
      c.references = [0, 1]; c.semantics.objectRefs = [1];
      full.references = [{evidenceRefId: 'data:duration', rowIndex: 0}, {evidenceRefId: 'data:duration', rowIndex: 1}];
      full.semantics.scope.subjectRefs = [full.references[0]]; full.semantics.scope.objectRefs = [full.references[1]];
      expected = 'half_open_interval_overlap_proved';
    } else {
      f.wire.semanticFrames[0].predicate = full.semantics.predicate = `${kind}.unconfigured`;
      f.wire.semanticFrames[0].modality = full.semantics.modality = 'possible';
      f.wire.semanticFrames[0].conditions = full.semantics.conditions = ['Additional execution evidence is required.'];
    }
    const result = compiled(f.wire); expect(result.rawCanonicalPayload).toEqual(f.full); expect(result.canonicalParse.issues).toEqual([]);
    const evaluate = proof(), actual = await evaluate(result.rawCanonicalPayload, result.body);
    expect(actual).toEqual(await evaluate(f.full, result.body)); expect(actual.verified[0].proof?.reason).toBe(expected);
    if (kind === 'comparison') {
      const missingScope = proof(true, false), unknown = await missingScope(result.rawCanonicalPayload, result.body);
      expect(unknown).toEqual(await missingScope(f.full, result.body));
      expect(unknown.verified[0].proof?.reason).toBe('comparison_field_scope_unknown');
    }
  });

  it('preserves every explicit stance/condition and does not assign semantics when null', () => {
    for (const polarity of CONCLUSION_PROTOCOL_VALUES.polarity) for (const discourse of CONCLUSION_PROTOCOL_VALUES.discourse)
      for (const quantifier of CONCLUSION_PROTOCOL_VALUES.quantifier) for (const modality of CONCLUSION_PROTOCOL_VALUES.modality) {
        const f = fixture(); Object.assign(f.wire.semanticFrames[0], {polarity, discourse, quantifier, modality, conditions: ['Only this sample.']});
        Object.assign(f.full.claims[0].semantics, {polarity, discourse, quantifier, modality, conditions: ['Only this sample.']});
        expect(compiled(f.wire).rawCanonicalPayload).toEqual(f.full);
      }
    const f = fixture(); f.wire.contract.claims[0].semantics = null; delete f.full.claims[0].semantics;
    expect(compiled(f.wire).rawCanonicalPayload).toEqual(f.full);
  });

  it.each(['asserted_value', 'reference_value', 'unit', 'row', 'unauthorized', 'conditions'])(
    'does not turn %s into a new proof', async failure => {
      const f = fixture();
      if (failure === 'asserted_value') {f.wire.contract.claims[0].semantics.numeric.value = 11; f.full.claims[0].semantics.numeric.value = 11;}
      if (failure === 'unit') {f.wire.contract.claims[0].semantics.numeric.unit = 'count'; f.full.claims[0].semantics.numeric.unit = 'count';}
      if (failure === 'reference_value') {f.wire.referenceDictionary[0].value.value = 11; f.full.claims[0].references[0].value = 11; f.full.claims[0].semantics.scope.subjectRefs[0].value = 11;}
      if (failure === 'row') {f.wire.referenceDictionary[0].rowIndex = 1; f.full.claims[0].references[0].rowIndex = 1; f.full.claims[0].semantics.scope.subjectRefs[0].rowIndex = 1;}
      if (failure === 'conditions') {f.wire.semanticFrames[0].conditions = ['Not established.']; f.full.claims[0].semantics.conditions = ['Not established.'];}
      const result = compiled(f.wire), evaluate = proof(failure !== 'unauthorized'), actual = await evaluate(result.rawCanonicalPayload, result.body);
      expect(result.rawCanonicalPayload).toEqual(f.full); expect(actual).toEqual(await evaluate(f.full, result.body));
      expect(actual.verified[0].proof?.status).not.toBe('proved');
    });

  it.each(['value', 'reference', 'rowIndex', 'stance', 'text'])('retains the good claim and original bad %s entry', field => {
    const f = fixture(), bad = copy(f.wire.contract.claims[0]); bad.id = 'bad'; bad.semantics.numeric.presentation = null;
    f.wire.contract.claims.push(bad); const invalid = copy(f.full.claims[0]); invalid.id = 'bad'; delete invalid.semantics.numeric.presentation;
    f.full.claims.push(invalid);
    if (field === 'value') {bad.semantics.numeric.value = Infinity; invalid.semantics.numeric.value = Infinity;}
    if (field === 'text') {bad.text = null; invalid.text = null;}
    if (field === 'stance') {f.wire.semanticFrames.push({...frame(), polarity: 'wrong'}); bad.semantics.frameIndex = 1; invalid.semantics.polarity = 'wrong';}
    if (field === 'reference' || field === 'rowIndex') {
      f.wire.referenceDictionary.push(copy(f.wire.referenceDictionary[0])); bad.references = [1]; bad.semantics.subjectRefs = [1];
      const key = field === 'rowIndex' ? 'rowIndex' : 'value';
      if (key === 'value') f.wire.referenceDictionary[1].value.value = Infinity; else f.wire.referenceDictionary[1].rowIndex = Number.MAX_SAFE_INTEGER + 1;
      const ref = {...fullRef, [key]: key === 'value' ? Infinity : Number.MAX_SAFE_INTEGER + 1}; invalid.references = [ref]; invalid.semantics.scope.subjectRefs = [ref];
    }
    const result = compiled(f.wire); expect(result.rawCanonicalPayload).toEqual(f.full);
    expect(result.canonicalParse).toEqual(parseConclusionDeclarationPayload(f.full, 'canonical_v1'));
    expect(result.canonicalParse.status).toBe('partially_valid'); expect(result.rawCanonicalPayload.claims).toHaveLength(2);
  });

  it('preserves all display, source and relation/proof fields without granting authority', () => {
    const f = fixture();
    f.wire.contract.conclusions = [{rank: 1, statement: 'Observed.', confidencePercent: 80, trigger: 'T', supply: 'S', amplification: 'A'}];
    f.full.conclusions = [{rank: 1, statement: 'Observed.', confidencePercent: 80, trigger: 'T', supply: 'S', amplification: 'A'}];
    f.wire.contract.clusters = [{cluster: 'C', description: 'D', frames: 2, percentage: 20, frameRefs: ['f1'], omittedFrameRefs: 1}];
    f.full.clusters = [{cluster: 'C', description: 'D', frames: 2, percentage: 20, frameRefs: ['f1'], omittedFrameRefs: 1}];
    f.wire.contract.evidenceChain = [{conclusionId: 'c', text: 'E'}]; f.full.evidenceChain = [{conclusionId: 'c', text: 'E'}];
    f.wire.contract.uncertainties = ['Unknown']; f.full.uncertainties = ['Unknown']; f.wire.contract.nextSteps = []; f.full.nextSteps = [];
    f.wire.contract.metadata = {confidencePercent: 80, sceneId: 'general', clusterPolicy: {outputMode: 'optional', frameListMode: 'top', maxFramesPerCluster: 5}};
    f.full.metadata = {confidencePercent: 80, sceneId: 'general', clusterPolicy: {outputMode: 'optional', frameListMode: 'top', maxFramesPerCluster: 5}};
    f.wire.contract.sourceClaimBindings = [{claimId: 'duration', sourceReferenceIds: ['source:one'], traceEvidenceRefIds: ['data:duration']}];
    f.full.sourceClaimBindings = [{claimId: 'duration', sourceReferenceIds: ['source:one'], traceEvidenceRefIds: ['data:duration']}];
    f.wire.contract.relationProposals = [{id: 'proposal:one', kind: 'lock_owner', direction: 'object_to_subject', subject: 0, object: 0, proof: 0,
      proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter'}, object: {endpointColumn: 'utid', proofColumn: 'owner'}},
      metricColumn: 'duration', value: {kind: 'present', value: 10}, unit: 'ms', deltaDirection: 'current_minus_reference'}];
    f.full.relationProposals = [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:one', kind: 'lock_owner', direction: 'object_to_subject',
      subject: {...fullRef}, object: {...fullRef}, proof: {...fullRef}, proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter'},
        object: {endpointColumn: 'utid', proofColumn: 'owner'}}, metricColumn: 'duration', value: 10, unit: 'ms', deltaDirection: 'current_minus_reference'}];
    expect(compiled(f.wire).rawCanonicalPayload).toEqual(f.full);
  });

  it.each([null, false, 0, '', -0])('keeps explicit reference value %p distinct from absent', value => {
    const f = fixture(); f.wire.referenceDictionary[0].value = {kind: 'present', value};
    const result = compiled(f.wire), reference = (result.rawCanonicalPayload.claims as Json[])[0].references[0];
    expect(Object.is(reference.value, value)).toBe(true);
    f.wire.referenceDictionary[0].value = {kind: 'absent'};
    expect((compiled(f.wire).rawCanonicalPayload.claims as Json[])[0].references[0]).not.toHaveProperty('value');
  });

  it('keeps scalar and nested selectors as own maps, including proto names and parsed nonfinite values', () => {
    const f = fixture();
    f.wire.referenceDictionary[0].rowSelector = [{key: '__proto__', value: 'own'}, {key: 'constructor', value: 0}];
    f.wire.contract.claims[0].artifactRefs = [{artifactId: 'art', rowIndex: null,
      rowSelector: {encoding: 'json_object', jsonText: '{"nested":[null,{"x":1e999,"z":-0}],"__proto__":{"own":true}}'}}];
    const result = compiled(f.wire), claim = (result.rawCanonicalPayload.claims as Json[])[0];
    expect(Object.prototype.hasOwnProperty.call(claim.references[0].rowSelector, '__proto__')).toBe(true);
    expect(claim.references[0].rowSelector.constructor).toBe(0);
    expect(claim.artifactRefs[0].rowSelector.nested[1].x).toBe(Infinity);
    expect(Object.is(claim.artifactRefs[0].rowSelector.nested[1].z, -0)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(claim.artifactRefs[0].rowSelector, '__proto__')).toBe(true);
    f.wire.contract.claims[0].artifactRefs[0].rowSelector = {encoding: 'entries', entries: [{key: 'cell', value: null}]};
    expect((compiled(f.wire).rawCanonicalPayload.claims as Json[])[0].artifactRefs[0].rowSelector).toEqual({cell: null});
  });

  it.each(['frame_negative', 'frame_fraction', 'frame_missing', 'ref_negative', 'ref_unsafe', 'ref_missing',
    'duplicate_selector', 'selector_json', 'unknown_key', 'wrong_version', 'semantics_container'])(
    'refuses structural %s without returning a filtered candidate', failure => {
      const f = fixture();
      if (failure.startsWith('frame_')) f.wire.contract.claims[0].semantics.frameIndex = failure === 'frame_negative' ? -1 : failure === 'frame_fraction' ? 0.5 : 1;
      if (failure.startsWith('ref_')) f.wire.contract.claims[0].references = [failure === 'ref_negative' ? -1 : failure === 'ref_unsafe' ? Number.MAX_SAFE_INTEGER + 1 : 1];
      if (failure === 'duplicate_selector') f.wire.referenceDictionary[0].rowSelector = [{key: 'id', value: 1}, {key: 'id', value: 2}];
      if (failure === 'selector_json') f.wire.contract.claims[0].artifactRefs = [{artifactId: 'a', rowIndex: null, rowSelector: {encoding: 'json_object', jsonText: '[1]'}}];
      if (failure === 'unknown_key') f.wire.contract.claims[0].verified = true;
      if (failure === 'wrong_version') f.wire.representationVersion = 'authored_claim_document@1';
      if (failure === 'semantics_container') f.wire.contract.claims[0].semantics = [];
      const result = compileAuthoredClaimObject(f.wire);
      expect(result.status).toBe('projection_failed'); expect(result).not.toHaveProperty('body'); expect(result).not.toHaveProperty('canonicalParse');
      expect(result.privateNativeDocument).toBe(f.wire);
    });

  it.each(['getter', 'cycle', 'function', 'undefined', 'symbol', 'exotic', 'array_hole'])(
    'rejects non-JSON %s before copying or executing it', kind => {
      const f = fixture(), getter = jest.fn(() => 'secret');
      if (kind === 'getter') Object.defineProperty(f.wire, 'bodyParts', {get: getter, enumerable: true});
      if (kind === 'cycle') f.wire.bodyParts.push(f.wire);
      if (kind === 'function') f.wire.bodyParts.push(() => 1);
      if (kind === 'undefined') f.wire.bodyParts.push(undefined);
      if (kind === 'symbol') Object.defineProperty(f.wire, Symbol('hidden'), {value: 1, enumerable: true});
      if (kind === 'exotic') f.wire.bodyParts.push(new Date());
      if (kind === 'array_hole') delete f.wire.bodyParts[0];
      expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'non_json_value'});
      expect(getter).not.toHaveBeenCalled();
    });

  it.each(['ordinary', 'nested', 'revoked'] as const)('rejects a %s Proxy without executing any trap', kind => {
    const trap = jest.fn();
    const target = fixture().wire;
    const revocable = Proxy.revocable(target, {
      getPrototypeOf(value) {trap(); return Reflect.getPrototypeOf(value);},
      ownKeys(value) {trap(); return Reflect.ownKeys(value);},
      getOwnPropertyDescriptor(value, key) {trap(); return Reflect.getOwnPropertyDescriptor(value, key);},
      get(value, key, receiver) {trap(); return Reflect.get(value, key, receiver);},
    });
    if (kind === 'revoked') revocable.revoke();
    const input = kind === 'nested' ? {...fixture().wire, bodyParts: [revocable.proxy]} : revocable.proxy;
    const result = compileAuthoredClaimObject(input);
    expect(trap).not.toHaveBeenCalled();
    expect(result.status).toBe('projection_failed');
    if (result.status === 'projection_failed') expect(result.code).toBe('non_json_value');
    expect(result.privateNativeDocument).toBe(input);
  });

  it.each(['bad_part', 'missing_local', 'ambiguous_local', 'bad_occurrence', 'empty_quote', 'cross_part', 'nonoverlap'])(
    'does not guess a body_part location: %s', failure => {
      const f = fixture(), p = f.wire.contract.claims[0].semantics.numeric.presentation;
      p.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 0, localOccurrence: null}];
      f.wire.bodyParts = ['10 ms'];
      if (failure === 'bad_part') p.quotes[0].partIndex = -1;
      if (failure === 'missing_local') f.wire.bodyParts = ['Other', '10 ms'];
      if (failure === 'ambiguous_local') f.wire.bodyParts = ['10 ms and 10 ms'];
      if (failure === 'bad_occurrence') p.quotes[0].localOccurrence = 1;
      if (failure === 'empty_quote') p.quotes[0].text = '';
      if (failure === 'cross_part') f.wire.bodyParts = ['10 ', 'ms'];
      if (failure === 'nonoverlap') {f.wire.bodyParts = ['1', '11']; p.quotes[0] = {kind: 'body_part', text: '11', partIndex: 1, localOccurrence: null};}
      expect(compileAuthoredClaimObject(f.wire).status).toBe('projection_failed');
    });

  it('keeps global cross-part bindings and repeated-global ambiguity unchanged', async () => {
    const f = fixture(); f.wire.bodyParts = ['10 ', 'ms'];
    f.wire.contract.claims[0].semantics.numeric.presentation.quotes = [{kind: 'global', text: '10 ms', occurrence: null}];
    const result = compiled(f.wire); expect(result.quoteBindings).toEqual([]);
    expect((result.rawCanonicalPayload.claims as Json[])[0].semantics.numeric.presentation.quotes).toEqual([{text: '10 ms'}]);
    const evaluate = proof(); expect((await evaluate(result.rawCanonicalPayload, result.body)).presentation[0].status).toBe('matched');
    f.wire.bodyParts.push(' / 10 ms'); const repeated = compiled(f.wire);
    expect((await evaluate(repeated.rawCanonicalPayload, repeated.body)).presentation[0].reason).toBe('quote_unresolved');
  });

  it.each([['1', '45 ms', ''], ['-', '10 ms', ''], ['', '10 ms', 'ec']])(
    'leaves full token boundaries to the unchanged numeric assessment: %s|%s|%s', async (prefix, text, suffix) => {
      const f = fixture(); f.wire.bodyParts = [prefix, text, suffix];
      f.wire.contract.claims[0].semantics.numeric.presentation.quotes = [{kind: 'body_part', text, partIndex: 1, localOccurrence: null}];
      const result = compiled(f.wire), actual = await proof()(result.rawCanonicalPayload, result.body);
      expect(actual.verified[0].proof?.status).toBe('proved'); expect(actual.presentation[0].reason).toBe('quote_unresolved');
    });

  it('does not resolve two claims binding the same numeric token', async () => {
    const f = fixture(); f.wire.bodyParts = ['10 ms'];
    f.wire.contract.claims[0].semantics.numeric.presentation.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 0, localOccurrence: null}];
    const other = copy(f.wire.contract.claims[0]); other.id = 'other'; f.wire.contract.claims.push(other);
    const result = compiled(f.wire), actual = await proof()(result.rawCanonicalPayload, result.body);
    expect(actual.presentation).toHaveLength(2); expect(actual.presentation.every(p => p.reason === 'binding_conflict')).toBe(true);
  });

  it('keeps exact UTF-16 locations across whitespace, empty parts, split surrogate and literal protocol examples', () => {
    const f = fixture(); f.wire.bodyParts = [' \n\ud83d', '', '\ude00 ', '10 ms and 10 ms', '\ud800', '\n```json\n{}\n```<!-- example -->'];
    f.wire.contract.claims[0].semantics.numeric.presentation.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 3, localOccurrence: 1}];
    const result = compiled(f.wire), expected = f.wire.bodyParts.join('');
    expect(result.body).toBe(expected); expect(result.partSpans[1]).toMatchObject({startUtf16: 3, endUtf16: 3});
    expect(result.quoteBindings[0]).toMatchObject({originalSpan: {startUtf16: expected.lastIndexOf('10 ms'), endUtf16: expected.lastIndexOf('10 ms') + 5}, canonicalQuote: {text: '10 ms', occurrence: 1}});
    expect(result.material.bodyUtf8Bytes).toBe(Buffer.byteLength(expected)); expect(result.material.expanded).toEqual(material({body: expected, contract: result.rawCanonicalPayload}));
    expect(findQuoteOccurrence('aaa', 'aa')).toEqual({start: 0, end: 2});
    expect(quoteOccurrenceAtSpan('111', '11', {start: 1, end: 3})).toBeUndefined();
    expect(findQuoteOccurrence('body', '')).toBeUndefined();
  });

  it('counts all unused raw material at exactly the byte and node limits', () => {
    const f = fixture(); f.wire.semanticFrames.push({...frame(), conditions: ['']});
    const padding = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - material(f.wire).utf8Bytes;
    f.wire.semanticFrames[1].conditions[0] = 'x'.repeat(padding);
    expect(compiled(f.wire).material.nativeDocument.utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    f.wire.semanticFrames[1].conditions[0] += 'x';
    expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'raw_bytes_exceeded'});
    const n = fixture(); n.wire.semanticFrames.push({...frame(), conditions: []});
    n.wire.semanticFrames[1].conditions = Array(CONCLUSION_AUTHORING_LIMITS.nodes - material(n.wire).nodes).fill('');
    expect(compiled(n.wire).material.nativeDocument.nodes).toBe(CONCLUSION_AUTHORING_LIMITS.nodes);
    n.wire.semanticFrames[1].conditions.push('');
    expect(compileAuthoredClaimObject(n.wire)).toMatchObject({status: 'projection_failed', code: 'raw_nodes_exceeded'});
  });

  it('bounds raw depth before projection, including unused semantic values', () => {
    const f = fixture(); f.wire.referenceDictionary.push(wireRef({value: {kind: 'present', value: {leaf: 1}}}));
    let value: Json = {leaf: 1}; f.wire.referenceDictionary[1].value.value = value;
    while (material(f.wire).depth < CONCLUSION_AUTHORING_LIMITS.depth) {value = {nested: value}; f.wire.referenceDictionary[1].value.value = value;}
    expect(compiled(f.wire).material.nativeDocument.depth).toBe(24);
    f.wire.referenceDictionary[1].value.value = {nested: value};
    expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'raw_depth_exceeded'});
  });

  it('counts the complete expanded body/contract at exactly 1 MiB, including repeat uses', () => {
    const f = fixture(); f.wire.contract.claims[0].semantics = null; delete f.full.claims[0].semantics;
    f.wire.contract.claims[0].text = ''; f.full.claims[0].text = ''; f.wire.bodyParts = [{claimText: 'duration'}, {claimText: 'duration'}, ''];
    const budget = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - material({body: '', contract: f.full}).utf8Bytes;
    const text = 'x'.repeat(Math.floor(budget / 3)), tail = 'x'.repeat(budget % 3);
    f.wire.contract.claims[0].text = text; f.full.claims[0].text = text; f.wire.bodyParts[2] = tail;
    expect(material({body: text + text + tail, contract: f.full}).utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    expect(compiled(f.wire).material.expanded.utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    f.wire.bodyParts[2] += 'x'; expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'expanded_bytes_exceeded'});
  });

  it('counts reused frames at every expanded node and refuses the next node', () => {
    const f = fixture(); f.wire.bodyParts = []; f.wire.contract.claims[0].semantics.numeric = null; delete f.full.claims[0].semantics.numeric;
    f.wire.semanticFrames[0].conditions = []; f.full.claims[0].semantics.conditions = [];
    const second = copy(f.wire.contract.claims[0]); second.id = 'second'; f.wire.contract.claims.push(second);
    const fullSecond = copy(f.full.claims[0]); fullSecond.id = 'second'; f.full.claims.push(fullSecond);
    let remaining = CONCLUSION_AUTHORING_LIMITS.nodes - material({body: '', contract: f.full}).nodes;
    if (remaining % 2) {second.semantics.objectRefs = []; fullSecond.semantics.scope.objectRefs = []; remaining--;}
    const conditions = Array(remaining / 2).fill(''); f.wire.semanticFrames[0].conditions = conditions;
    for (const claim of f.full.claims) claim.semantics.conditions = conditions;
    expect(material({body: '', contract: f.full}).nodes).toBe(CONCLUSION_AUTHORING_LIMITS.nodes);
    expect(compiled(f.wire).material.expanded.nodes).toBe(CONCLUSION_AUTHORING_LIMITS.nodes);
    conditions.push(''); expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'expanded_nodes_exceeded'});
  });

  it('bounds expanded reference depth at the destination rather than the dictionary location', () => {
    const f = fixture(); let value: unknown = 1;
    const set = () => {f.wire.referenceDictionary[0].value.value = value; f.full.claims[0].references[0].value = value; f.full.claims[0].semantics.scope.subjectRefs[0].value = value;};
    set(); while (material({body: f.body, contract: f.full}).depth < 24) {value = {nested: value}; set();}
    expect(material(f.wire).depth).toBeLessThanOrEqual(24); expect(compiled(f.wire).material.expanded.depth).toBe(24);
    value = {nested: value}; set(); expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'expanded_depth_exceeded'});
  });

  it('preserves the old v1 result exactly when using shared material/body helpers', () => {
    const f = fixture(), raw = JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, contract: f.full, bodyParts: f.wire.bodyParts});
    const old = compileAuthoredClaimDocument(raw); expect(old.status).toBe('compiled');
    if (old.status !== 'compiled') throw new Error('Fixture must compile');
    expect(old.rawCanonicalPayload).toEqual(f.full); expect(old.body).toBe(f.body);
    expect(old).not.toHaveProperty('partSpans'); expect(old).not.toHaveProperty('quoteBindings');
    expect(old.material).toEqual({rawInputUtf8Bytes: Buffer.byteLength(raw), raw: material(JSON.parse(raw)), expanded: material({body: f.body, contract: f.full}),
      bodyUtf8Bytes: Buffer.byteLength(f.body), bodyUtf16Length: f.body.length});
    expect(measureAuthoredJson({a: -0, b: Infinity})).toEqual(material({a: -0, b: Infinity}));
  });

  it('exposes the complete closed generation schema through the actual shared converter', () => {
    expect(authoredClaimObjectSchema.safeParse(fixture().wire).success).toBe(true);
    const schema = createJsonSchemaFromZodRawShape({document: authoredClaimObjectSchema}) as Json;
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const value = node as Json;
      expect(value).not.toHaveProperty('oneOf');
      if (value.type === 'object') {expect(value.additionalProperties).toBe(false); expect([...value.required].sort()).toEqual(Object.keys(value.properties).sort());}
      for (const [key, child] of Object.entries(value)) if (!['const', 'enum', 'default', 'examples'].includes(key)) {
        if (Array.isArray(child)) child.forEach(walk); else walk(child);
      }
    };
    walk(schema);
    const encoded = JSON.stringify(schema);
    expect(encoded.match(/"evidenceRefId":/g)).toHaveLength(1);
    expect(encoded).not.toContain('documentJson');
    console.log('[R10 pure schema bytes]', Buffer.byteLength(encoded));
  });

  it.each([1, 8, 32])('records offline serialized representation costs for %i claims without asserting latency', count => {
    for (const sharing of ['all', 'partial', 'independent'] as const) {
      const f = fixture(); f.wire.bodyParts = []; f.wire.contract.claims = []; f.full.claims = [];
      const seed = fixture(); seed.wire.contract.claims[0].semantics.numeric.presentation = null; delete seed.full.claims[0].semantics.numeric.presentation;
      f.wire.semanticFrames = []; const frames = sharing === 'all' ? 1 : sharing === 'partial' ? Math.ceil(count / 2) : count;
      for (let i = 0; i < frames; i++) f.wire.semanticFrames.push({...frame(), conditions: [`Authored frame ${i}`]});
      for (let i = 0; i < count; i++) {
        const wireClaim = copy(seed.wire.contract.claims[0]), canonicalClaim = copy(seed.full.claims[0]);
        wireClaim.id = canonicalClaim.id = `claim-${i}`; wireClaim.semantics.frameIndex = i % frames;
        canonicalClaim.semantics.conditions = [`Authored frame ${i % frames}`]; f.wire.contract.claims.push(wireClaim); f.full.claims.push(canonicalClaim);
      }
      const result = compiled(f.wire); expect(result.rawCanonicalPayload).toEqual(f.full);
      const v1 = {documentJson: JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, contract: f.full, bodyParts: []})};
      console.log('[R10 offline bytes]', {count, sharing, nativeObject: Buffer.byteLength(JSON.stringify({document: f.wire})),
        verboseCanonical: Buffer.byteLength(JSON.stringify(f.full)), v1DoubleEncoded: Buffer.byteLength(JSON.stringify(v1))});
    }
  });
});

describe('R14 private quote failure locations', () => {
  it.each([
    {name: 'absent', parts: ['PRIVATE_BODY_CANARY'], text: '10 ms', occurrence: null, partIndex: 0, reason: 'local_no_match', count: 0, precision: 'exact'},
    {name: 'explicit_zero_absent', parts: ['PRIVATE_BODY_CANARY'], text: '10 ms', occurrence: 0, partIndex: 0, reason: 'local_no_match', count: 0, precision: 'exact'},
    {name: 'duplicate_unique', parts: ['10 ms / 10 ms'], text: '10 ms', occurrence: null, partIndex: 0, reason: 'local_ambiguous', count: 2, precision: 'exact'},
    {name: 'ordinal_out_of_range', parts: ['10 ms'], text: '10 ms', occurrence: 1, partIndex: 0, reason: 'local_occurrence_out_of_range', count: 1, precision: 'exact'},
    {name: 'unicode', parts: ['前😀', '值 10 ms'], text: '10 ms', occurrence: 1, partIndex: 1, reason: 'local_occurrence_out_of_range', count: 1, precision: 'exact'},
    {name: 'global_nonoverlap', parts: ['1', '11'], text: '11', occurrence: null, partIndex: 1, reason: 'global_span_unrepresentable', count: 1, precision: 'exact'},
    {name: 'sixteen', parts: [Array(16).fill('10 ms').join(' / ')], text: '10 ms', occurrence: null, partIndex: 0, reason: 'local_ambiguous', count: 16, precision: 'exact'},
    {name: 'seventeen', parts: [Array(17).fill('10 ms').join(' / ')], text: '10 ms', occurrence: null, partIndex: 0, reason: 'local_ambiguous', count: 17, precision: 'at_least'},
    {name: 'beyond_cap_ordinal', parts: [Array(20).fill('10 ms').join(' / ')], text: '10 ms', occurrence: 25, partIndex: 0, reason: 'local_occurrence_out_of_range', count: 17, precision: 'at_least'},
  ])('records only original coordinates/counts for $name', item => {
    const f = fixture(), claim = f.wire.contract.claims[0];
    f.wire.contract.claims.unshift({...claim, id: 'PRIVATE_INVALID_FIRST', kind: 'invalid-kind', semantics: null});
    claim.semantics.numeric.presentation.quotes = [{kind: 'global', text: '10 ms', occurrence: 0},
      {kind: 'body_part', text: item.text, partIndex: item.partIndex, localOccurrence: item.occurrence}];
    f.wire.bodyParts = item.parts;
    const result = compileAuthoredClaimObject(f.wire);
    expect(result).toMatchObject({status: 'projection_failed', code: 'quote_unresolved', compilerFailureLocation: {
      reason: item.reason, claimOrdinal: 2, quoteOrdinal: 2, partIndex: item.partIndex,
      ...(item.occurrence === null ? {} : {localOccurrence: item.occurrence}), localMatchCount: {count: item.count, precision: item.precision},
    }});
    expect(result.privateNativeDocument).toBe(f.wire);
    const location = (result as unknown as {compilerFailureLocation: Record<string, unknown>}).compilerFailureLocation;
    if (item.occurrence === null) expect(location).not.toHaveProperty('localOccurrence');
    expect(JSON.stringify(location)).not.toMatch(/PRIVATE_|10 ms|reference|claimId|text/);
  });

  it('does not derive failure from saturated counts or alter successful/v1 material', () => {
    const f = fixture(); f.wire.bodyParts = [Array(20).fill('10 ms').join(' / ')];
    f.wire.contract.claims[0].semantics.numeric.presentation.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 0, localOccurrence: 18}];
    const result = compileAuthoredClaimObject(f.wire); expect(result.status).toBe('compiled'); expect(result).not.toHaveProperty('compilerFailureLocation');
    if (result.status === 'compiled') expect(result.quoteBindings[0].canonicalQuote).toEqual({text: '10 ms', occurrence: 18});
    const original = fixture(), legacy = compileAuthoredClaimDocument(JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
      contract: original.full, bodyParts: original.wire.bodyParts}));
    expect(legacy.status).toBe('compiled'); expect(legacy).not.toHaveProperty('compilerFailureLocation');
  });
});

/** C-core ordinary compilation data only. These cases do not create a native
 * ticket, an issued quote capability or an authored submission receipt. */
describe('R15 C-core authored evidence document contract', () => {
  type Material = {utf8Bytes: number; nodes: number; depth: number};
  type Span = {startUtf16: number; endUtf16: number};
  type Origin = Span & {partIndex: number; origin: 'model_literal' | 'model_claim_text' | 'program_evidence_quote'; quoteId?: string};
  type Selection = {viewId: string; rows: readonly number[]; columns: readonly string[];
    page: {visibleRows: number; hasMore: 'yes' | 'no' | 'unknown'; coverage: 'visible_page_only'}};
  type ReadRecord = {key: string; locator: {artifactId: string} | {evidenceRefId: string}; traceSide: 'current' | 'reference';
    rowIndex?: number; metadataOnly?: true; cells: readonly {column: string; value: unknown; unit?: string}[]};
  type QuotePart = {partIndex: number; quoteId: string; fidelity: 'matched' | 'unavailable'; reason?: string;
    selection: Selection; readKeys: readonly string[]};
  type QuoteOccurrence = Span & {quoteId: string; partIndex: number; fidelity: 'matched' | 'unavailable'; reason?: string;
    selection: Selection; readKeys: readonly string[]; dataSpans: readonly (Span & {readKey: string})[];
    contextSpans: readonly Span[]; headingSpans: readonly Span[]};
  type Failure = {status: 'projection_failed'; phase: 'raw' | 'derived' | 'compiler' | 'final'; code: string;
    privateNativeDocument?: unknown; compilerFailureLocation?: unknown};
  type Prepared = {status: 'prepared'; privateNativeDocument: Json; rawMaterial: Material; quotes: readonly unknown[]};
  type Composed = {status: 'composed'; representationVersion: string; compilerVersion: string; rendererVersion: string;
    privateNativeDocument: Json; internalModelDocument: Json; modelCompiled: ReturnType<typeof compiled>;
    body: string; rawCanonicalPayload: Json; originSpans: readonly Origin[]; quoteOccurrences: readonly QuoteOccurrence[];
    selectedReadSnapshot: readonly ReadRecord[]; resourcePhases: {raw: Material; derived: Material; compiler: Material; final: Material}};
  type Api = {AUTHORED_EVIDENCE_DOCUMENT_VERSION: string; AUTHORED_EVIDENCE_DOCUMENT_COMPILER_VERSION: string;
    authoredEvidenceDocumentSchema: {shape: Record<string, unknown>; safeParse(value: unknown): {success: boolean}};
    prepareAuthoredEvidenceDocument(value: unknown): Prepared | Failure;
    assembleAuthoredEvidenceDocument(prepared: Prepared,
      material: {quoteParts: readonly QuotePart[]; selectedReadSnapshot: readonly ReadRecord[]}): Composed | Failure};

  let restoreClone: (() => void) | undefined;
  beforeEach(() => {
    const helper = jest.requireActual<typeof import('../../../../tests/helpers/openAiRuntimeFixture')>(
      '../../../../tests/helpers/openAiRuntimeFixture');
    restoreClone = helper.installCurrentRealmStructuredCloneForTest();
  });
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  function api(): Api {
    let path: string | undefined;
    try {path = require.resolve('../authoredEvidenceDocument');}
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') throw error;
    }
    // Initially this assertion is API RED in a test body, not an import/setup failure.
    expect(path).toEqual(expect.any(String));
    if (!path) throw new Error('C-core module is not implemented');
    const loaded = jest.requireActual<Record<string, unknown>>(path);
    expect(loaded).toMatchObject({AUTHORED_EVIDENCE_DOCUMENT_VERSION: 'authored_claim_document@3',
      AUTHORED_EVIDENCE_DOCUMENT_COMPILER_VERSION: 'authored_claim_document_compiler@3',
      prepareAuthoredEvidenceDocument: expect.any(Function), assembleAuthoredEvidenceDocument: expect.any(Function),
      authoredEvidenceDocumentSchema: expect.objectContaining({safeParse: expect.any(Function)})});
    return loaded as unknown as Api;
  }
  function prepared(a: Api, raw: unknown): Prepared {
    const result = a.prepareAuthoredEvidenceDocument(raw);
    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') throw new Error(`C-core preparation failed: ${result.code}`);
    return result;
  }
  function composed(a: Api, raw: unknown, quoteParts: readonly QuotePart[] = [], records: readonly ReadRecord[] = []): Composed {
    const result = a.assembleAuthoredEvidenceDocument(prepared(a, raw), {quoteParts, selectedReadSnapshot: records});
    expect(result.status).toBe('composed');
    if (result.status !== 'composed') throw new Error(`C-core assembly failed: ${result.phase}/${result.code}`);
    return result;
  }
  const version = 'authored_claim_document@3';
  const quote = (id = 'quoted', viewId = 'view:one', column = 'duration') => ({evidenceQuote: {id, viewId,
    rows: {kind: 'indices', indices: [2]}, fields: [{column, format: {kind: 'raw'}}], layout: 'table'}});
  function sourceFixture() {
    const f = fixture();
    f.wire.representationVersion = version;
    f.wire.contract.claims[0].text = 'Independent model assertion: 11 ms.';
    f.wire.contract.claims[0].semantics.numeric = {operator: 'eq', value: 11, unit: 'ms', presentation: null};
    f.wire.referenceDictionary[0].value = {kind: 'present', value: 11};
    f.full.claims[0].text = 'Independent model assertion: 11 ms.';
    f.full.claims[0].semantics.numeric = {operator: 'eq', value: 11, unit: 'ms'};
    f.full.claims[0].references[0].value = 11;
    f.full.claims[0].semantics.scope.subjectRefs[0].value = 11;
    f.wire.bodyParts = ['Model prefix 😀\n', {claimText: 'duration'}, quote(), '\nModel suffix.'];
    const part: QuotePart = {partIndex: 2, quoteId: 'quoted', fidelity: 'matched',
      selection: {viewId: 'view:one', rows: [2], columns: ['duration'],
        page: {visibleRows: 1, hasMore: 'unknown', coverage: 'visible_page_only'}}, readKeys: ['selected:2']};
    const records: ReadRecord[] = [{key: 'selected:2', locator: {evidenceRefId: 'data:quote'}, traceSide: 'current', rowIndex: 2,
      cells: [{column: 'duration', value: 4, unit: 'ms'}]}];
    return {...f, part, records};
  }
  function plainFixture() {
    const f = sourceFixture(); f.wire.bodyParts = [{claimText: 'duration'}]; return f;
  }
  // This fixed literal oracle is independent of the new renderer and of the model assertion.
  const heading = '### 证据摘录 / Evidence excerpt\n';
  const tableHeader = '| rowIndex | field | display | raw | producer unit |\n|---|---|---|---|---|\n';
  const caption = (visibleRows = 1, selectedRows = 1, hasMore = 'unknown') =>
    `Source data:quote · trace side current · identity unknown · window unknown.\nVisible page ${visibleRows} rows · selected ${selectedRows} rows · hasMore ${hasMore} · coverage visible_page_only.\n`;
  const rawQuoteText = '\n\n' + heading + caption() + tableHeader + '| 2 | duration | 4 | 4 | ms |\n\n';
  const unavailableText = '\n\n' + heading + '摘录不可用 / Excerpt unavailable.\n\n';
  function finalGraph(result: Composed) {
    return {body: result.body, rawCanonicalPayload: result.rawCanonicalPayload, originSpans: result.originSpans,
      quoteOccurrences: result.quoteOccurrences, selectedReadSnapshot: result.selectedReadSnapshot};
  }
  function assertPartition(body: string, occurrence: QuoteOccurrence) {
    const pieces = [...occurrence.dataSpans, ...occurrence.contextSpans, ...occurrence.headingSpans]
      .sort((left, right) => left.startUtf16 - right.startUtf16);
    let cursor = occurrence.startUtf16;
    for (const piece of pieces) {
      expect(piece.startUtf16).toBe(cursor); expect(piece.endUtf16).toBeGreaterThan(piece.startUtf16);
      expect(piece.endUtf16).toBeLessThanOrEqual(occurrence.endUtf16); cursor = piece.endUtf16;
    }
    expect(cursor).toBe(occurrence.endUtf16);
    expect(body.slice(occurrence.startUtf16, occurrence.endUtf16)).not.toBe('');
  }

  it('reuses complete v2 generation shapes and adds only the closed quote branch', () => {
    const a = api(), f = sourceFixture(), shape = a.authoredEvidenceDocumentSchema.shape;
    for (const key of ['contract', 'referenceDictionary', 'semanticFrames'] as const) {
      expect(shape[key]).toBe(authoredClaimObjectSchema.shape[key]);
    }
    expect(a.authoredEvidenceDocumentSchema.safeParse(f.wire).success).toBe(true);
    expect(authoredClaimObjectSchema.safeParse(f.wire).success).toBe(false);
    const old = fixture(); expect(authoredClaimObjectSchema.safeParse(old.wire).success).toBe(true);
    expect(a.authoredEvidenceDocumentSchema.safeParse(old.wire).success).toBe(false);
    expect(compiled(old.wire).rawCanonicalPayload).toEqual(old.full);
  });

  it.each(['extra_root', 'extra_quote', 'extra_format', 'unknown_layout', 'duplicate_id', 'duplicate_field', 'duplicate_row',
    'negative_row', 'fraction_row', 'empty_fields', 'callback_part'] as const)('rejects structural %s without filtering model entries', failure => {
    const a = api(), f = sourceFixture(), q = f.wire.bodyParts[2].evidenceQuote;
    if (failure === 'extra_root') f.wire.programAuthority = true;
    if (failure === 'extra_quote') q.title = 'Caller chosen title';
    if (failure === 'extra_format') q.fields[0].format.expectedValue = 4;
    if (failure === 'unknown_layout') q.layout = 'narrative';
    if (failure === 'duplicate_id') f.wire.bodyParts.push(quote());
    if (failure === 'duplicate_field') q.fields.push({column: 'duration', format: {kind: 'raw'}});
    if (failure === 'duplicate_row') q.rows.indices = [2, 2];
    if (failure === 'negative_row') q.rows.indices = [-1];
    if (failure === 'fraction_row') q.rows.indices = [0.5];
    if (failure === 'empty_fields') q.fields = [];
    const callback = jest.fn(() => 'PRIVATE_CALLBACK');
    if (failure === 'callback_part') f.wire.bodyParts[2] = {render: callback};
    const result = a.prepareAuthoredEvidenceDocument(f.wire);
    expect(result.status).toBe('projection_failed'); expect(result).not.toHaveProperty('body');
    expect(callback).not.toHaveBeenCalled(); expect(f.wire.contract.claims).toHaveLength(1);
  });

  it.each(['getter', 'proxy', 'revoked_proxy', 'symbol', 'cycle', 'sparse', 'exotic'] as const)(
    'preflights %s without executing caller code', variant => {
      const a = api(), f = plainFixture(), trap = jest.fn(() => {throw new Error('PRIVATE_TRAP');});
      let raw: unknown = f.wire;
      if (variant === 'getter') Object.defineProperty(f.wire.contract, 'claims', {get: trap, enumerable: true});
      if (variant === 'proxy') raw = new Proxy(f.wire, {get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap});
      if (variant === 'revoked_proxy') {const proxy = Proxy.revocable(f.wire, {}); proxy.revoke(); raw = proxy.proxy;}
      if (variant === 'symbol') Object.defineProperty(f.wire, Symbol('private'), {value: 'PRIVATE_SYMBOL', enumerable: true});
      if (variant === 'cycle') f.wire.contract.metadata = f.wire;
      if (variant === 'sparse') {f.wire.bodyParts = new Array(2); f.wire.bodyParts[1] = 'suffix';}
      if (variant === 'exotic') f.wire.contract.metadata = new Date(0);
      expect(a.prepareAuthoredEvidenceDocument(raw)).toMatchObject({status: 'projection_failed', phase: 'raw', code: 'non_json_value'});
      expect(trap).not.toHaveBeenCalled();
    });

  it('snapshots raw values synchronously and leaves the caller mutable before any later work', () => {
    const a = api(), f = plainFixture();
    f.wire.referenceDictionary[0].value.value = -0;
    f.wire.contract.claims[0].semantics.numeric.value = Infinity;
    f.wire.contract.uncertainties = ['unchanged\ud800 e\u0301\n{"literal":true}'];
    const before = structuredClone(f.wire), p = prepared(a, f.wire);
    expect(Object.is(p.privateNativeDocument.referenceDictionary[0].value.value, -0)).toBe(true);
    expect(p.privateNativeDocument.contract.claims[0].semantics.numeric.value).toBe(Infinity);
    expect(p.privateNativeDocument.contract.uncertainties[0]).toBe('unchanged\ud800 e\u0301\n{"literal":true}');
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.privateNativeDocument.contract.claims)).toBe(true);
    expect(Object.isFrozen(f.wire)).toBe(false); expect(Object.isFrozen(f.wire.contract.claims[0])).toBe(false);
    f.wire.contract.claims[0].text = 'AFTER'; f.wire.contract.claims[0].semantics.numeric.value = 4;
    f.wire.referenceDictionary[0].value.value = 4; f.wire.bodyParts[0] = 'AFTER';
    expect(p.privateNativeDocument).toEqual(before); expect(p.rawMaterial).toEqual(material(before));
    const result = a.assembleAuthoredEvidenceDocument(p, {quoteParts: [], selectedReadSnapshot: []});
    expect(result.status).toBe('composed');
    if (result.status === 'composed') {
      expect(result.body).toBe(before.contract.claims[0].text);
      expect(result.rawCanonicalPayload.claims[0].semantics.numeric.value).toBe(Infinity);
      expect(Object.is(result.rawCanonicalPayload.claims[0].references[0].value, -0)).toBe(true);
      expect(result.modelCompiled.canonicalParse.status).toBe('partially_valid');
    }
  });

  it.each(CONCLUSION_PROTOCOL_VALUES.claimKind)('retains complete %s semantics and the old independent canonical oracle', kind => {
    const a = api(), f = plainFixture();
    const rawClaim = f.wire.contract.claims[0], fullClaim = f.full.claims[0];
    rawClaim.kind = fullClaim.kind = kind;
    f.wire.semanticFrames[0].conditions = ['Only the original sample.'];
    fullClaim.semantics.conditions = ['Only the original sample.'];
    if (kind === 'categorical' || kind === 'identity') {
      const column = kind === 'categorical' ? 'state' : 'process_name', value = kind === 'categorical' ? 'Ready' : 'sample.app';
      rawClaim.text = fullClaim.text = kind === 'categorical' ? 'The authored state is Ready.' : 'The authored process is sample.app.';
      f.wire.semanticFrames[0].predicate = fullClaim.semantics.predicate = 'captured.cell';
      f.wire.referenceDictionary[0] = wireRef({evidenceRefId: 'data:duration', rowIndex: 0, column, value: {kind: 'present', value}});
      fullClaim.references = [{evidenceRefId: 'data:duration', rowIndex: 0, column, value}];
      fullClaim.semantics.scope.subjectRefs = [{evidenceRefId: 'data:duration', rowIndex: 0, column, value}];
      rawClaim.semantics.numeric = null; delete fullClaim.semantics.numeric;
    } else if (kind === 'time_range') {
      rawClaim.text = fullClaim.text = 'The two authored intervals overlap.';
      f.wire.semanticFrames[0].predicate = fullClaim.semantics.predicate = 'interval.overlap';
      f.wire.referenceDictionary = [wireRef({evidenceRefId: 'data:duration', rowIndex: 0}), wireRef({evidenceRefId: 'data:duration', rowIndex: 1})];
      rawClaim.references = [0, 1]; rawClaim.semantics.objectRefs = [1]; rawClaim.semantics.numeric = null;
      fullClaim.references = [{evidenceRefId: 'data:duration', rowIndex: 0}, {evidenceRefId: 'data:duration', rowIndex: 1}];
      fullClaim.semantics.scope.subjectRefs = [{evidenceRefId: 'data:duration', rowIndex: 0}];
      fullClaim.semantics.scope.objectRefs = [{evidenceRefId: 'data:duration', rowIndex: 1}]; delete fullClaim.semantics.numeric;
    } else if (kind === 'comparison') {
      rawClaim.text = fullClaim.text = 'The independently authored difference is 3 ms.';
      f.wire.semanticFrames[0].predicate = fullClaim.semantics.predicate = 'comparison.delta';
      f.wire.referenceDictionary.push(wireRef({evidenceRefId: 'data:reference', rowIndex: 0, column: 'duration', value: {kind: 'present', value: 8}}));
      rawClaim.references = [0, 1]; rawClaim.semantics.objectRefs = [1]; rawClaim.semantics.numeric.value = 3;
      fullClaim.references.push({evidenceRefId: 'data:reference', rowIndex: 0, column: 'duration', value: 8});
      fullClaim.semantics.scope.objectRefs = [{evidenceRefId: 'data:reference', rowIndex: 0, column: 'duration', value: 8}];
      fullClaim.semantics.numeric.value = 3;
    } else if (kind !== 'numeric') {
      const text = {causal: 'The workload may cause the delay.', inference: 'The workload may contribute to this observation.',
        recommendation: 'Inspect the workload before choosing a remedy.'}[kind];
      rawClaim.text = fullClaim.text = text;
      f.wire.semanticFrames[0].predicate = fullClaim.semantics.predicate = `${kind}.unconfigured`;
      f.wire.semanticFrames[0].modality = fullClaim.semantics.modality = 'possible';
      rawClaim.semantics.numeric = null; delete fullClaim.semantics.numeric;
    }
    const result = composed(a, f.wire), oldInput = {...f.wire, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION};
    expect(result.rawCanonicalPayload).toEqual(f.full);
    expect(result.modelCompiled).toEqual(compiled(oldInput));
    expect(result.privateNativeDocument.contract).toEqual(f.wire.contract);
    expect(result.body).toBe(f.full.claims[0].text);
    expect(result).not.toHaveProperty('submission'); expect(result).not.toHaveProperty('verified');
    expect(result).not.toHaveProperty('completion'); expect(result).not.toHaveProperty('ticket');
  });

  it('retains explicit reference scalar presence independently of the numeric assertion', () => {
    const a = api();
    for (const value of [null, false, 0, '', -0, '0004.00']) {
      const f = plainFixture(); f.wire.referenceDictionary[0].value = {kind: 'present', value};
      const result = composed(a, f.wire), claim = result.rawCanonicalPayload.claims[0];
      expect(Object.prototype.hasOwnProperty.call(claim.references[0], 'value')).toBe(true);
      expect(Object.is(claim.references[0].value, value)).toBe(true);
      expect(Object.is(claim.semantics.scope.subjectRefs[0].value, value)).toBe(true);
      expect(claim.semantics.numeric.value).toBe(11);
      f.wire.referenceDictionary[0].value = {kind: 'absent'};
      expect(composed(a, f.wire).rawCanonicalPayload.claims[0].references[0]).not.toHaveProperty('value');
    }
  });

  it.each(['shared', 'independent'] as const)('preserves a complete mixed eight-kind document with %s refs and frames', sharing => {
    const a = api(), f = sourceFixture(), modelClaim = f.wire.contract.claims[0], canonicalClaim = f.full.claims[0];
    const originalReference = f.wire.referenceDictionary[0], originalFrame = f.wire.semanticFrames[0];
    f.wire.contract.claims = []; f.full.claims = []; f.wire.bodyParts = [];
    f.wire.referenceDictionary = sharing === 'shared' ? [originalReference] : [];
    f.wire.semanticFrames = sharing === 'shared' ? [originalFrame] : [];
    for (const [index, kind] of CONCLUSION_PROTOCOL_VALUES.claimKind.entries()) {
      const claim = structuredClone(modelClaim), expected = structuredClone(canonicalClaim);
      claim.id = expected.id = `mixed:${kind}`; claim.kind = expected.kind = kind;
      claim.text = expected.text = `Independently authored ${kind} assertion.`;
      if (sharing === 'independent') {
        f.wire.referenceDictionary.push(structuredClone(originalReference)); f.wire.semanticFrames.push(structuredClone(originalFrame));
        claim.references = [index]; claim.semantics.subjectRefs = [index]; claim.semantics.frameIndex = index;
      }
      f.wire.contract.claims.push(claim); f.full.claims.push(expected); f.wire.bodyParts.push({claimText: claim.id}, '\n');
    }
    const programIndex = f.wire.bodyParts.length; f.wire.bodyParts.push(quote());
    const result = composed(a, f.wire, [{...f.part, partIndex: programIndex}], f.records);
    expect(result.rawCanonicalPayload).toEqual(f.full);
    expect(result.rawCanonicalPayload.claims.map((claim: Json) => claim.kind)).toEqual(CONCLUSION_PROTOCOL_VALUES.claimKind);
    expect(result.privateNativeDocument.referenceDictionary).toHaveLength(sharing === 'shared' ? 1 : 8);
    expect(result.privateNativeDocument.semanticFrames).toHaveLength(sharing === 'shared' ? 1 : 8);
    expect(result.body).toBe(f.full.claims.map((claim: Json) => claim.text + '\n').join('') + rawQuoteText);
    expect(result.rawCanonicalPayload.claims.every((claim: Json) => claim.semantics.numeric.value === 11)).toBe(true);
  });

  it('keeps source bindings, relation endpoints, original expected values and invalid items in order', () => {
    const a = api(), f = sourceFixture();
    f.wire.contract.sourceClaimBindings = [{claimId: 'duration', sourceReferenceIds: ['source:a'], traceEvidenceRefIds: ['data:duration']}];
    f.full.sourceClaimBindings = [{claimId: 'duration', sourceReferenceIds: ['source:a'], traceEvidenceRefIds: ['data:duration']}];
    f.wire.contract.relationProposals = [{id: 'relation:a', kind: 'lock_owner', direction: 'object_to_subject', subject: 0, object: 0, proof: 0,
      proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter'}, object: {endpointColumn: 'utid', proofColumn: 'owner'}},
      metricColumn: 'duration', value: {kind: 'present', value: 11}, unit: 'ms', deltaDirection: 'current_minus_reference'}];
    const ref = {evidenceRefId: 'data:duration', rowIndex: 0, column: 'duration', value: 11};
    f.full.relationProposals = [{schemaVersion: 'evidence_relation_candidate@1', id: 'relation:a', kind: 'lock_owner',
      direction: 'object_to_subject', subject: {...ref}, object: {...ref}, proof: {...ref},
      proofBindings: {subject: {endpointColumn: 'utid', proofColumn: 'waiter'}, object: {endpointColumn: 'utid', proofColumn: 'owner'}},
      metricColumn: 'duration', value: 11, unit: 'ms', deltaDirection: 'current_minus_reference'}];
    const bad = structuredClone(f.wire.contract.claims[0]); bad.id = 'bad'; bad.text = null; bad.semantics.numeric.value = Infinity;
    f.wire.contract.claims.push(bad);
    const expectedBad = structuredClone(f.full.claims[0]); expectedBad.id = 'bad'; expectedBad.text = null; expectedBad.semantics.numeric.value = Infinity;
    f.full.claims.push(expectedBad);
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.rawCanonicalPayload).toEqual(f.full); expect(result.rawCanonicalPayload.claims).toHaveLength(2);
    expect(result.modelCompiled.canonicalParse.status).toBe('partially_valid');
    expect(result.rawCanonicalPayload.claims[0].references[0].value).toBe(11);
    expect(result.selectedReadSnapshot[0].cells[0].value).toBe(4);
    expect(result.rawCanonicalPayload.relationProposals[0].value).toBe(11);
  });

  it('does not turn ordinary rendered 4 into proof of the independent model assertion 11', async () => {
    const a = api(), f = sourceFixture(), result = composed(a, f.wire, [f.part], f.records), evaluate = proof();
    const actual = await evaluate(result.rawCanonicalPayload, result.body);
    expect(actual).toEqual(await evaluate(f.full, result.body));
    expect(actual.verified[0].proof?.status).not.toBe('proved');
    const control = fixture();
    expect((await evaluate(control.full, control.body)).verified[0].proof).toEqual({status: 'proved', reason: 'numeric_operator_proved'});
    expect(result.rawCanonicalPayload.claims[0].semantics.numeric.value).toBe(11);
    expect(result.selectedReadSnapshot[0].cells[0].value).toBe(4);
  });

  it('renders fixed program text and partitions UTF-16 origins without absorbing model words', () => {
    const a = api(), f = sourceFixture(), result = composed(a, f.wire, [f.part], f.records);
    const prefix = 'Model prefix 😀\n', claimText = 'Independent model assertion: 11 ms.', start = prefix.length + claimText.length;
    expect(result.body).toBe(prefix + claimText + rawQuoteText + '\nModel suffix.');
    expect(result.rawCanonicalPayload).toEqual(f.full);
    expect(result.internalModelDocument).toEqual({...f.wire, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      bodyParts: [prefix, {claimText: 'duration'}, rawQuoteText, '\nModel suffix.']});
    expect(result.originSpans).toEqual([
      {partIndex: 0, origin: 'model_literal', startUtf16: 0, endUtf16: prefix.length},
      {partIndex: 1, origin: 'model_claim_text', startUtf16: prefix.length, endUtf16: start},
      {partIndex: 2, origin: 'program_evidence_quote', quoteId: 'quoted', startUtf16: start, endUtf16: start + rawQuoteText.length},
      {partIndex: 3, origin: 'model_literal', startUtf16: start + rawQuoteText.length, endUtf16: result.body.length}]);
    const occurrence = result.quoteOccurrences[0];
    expect(occurrence).toMatchObject({quoteId: 'quoted', partIndex: 2, fidelity: 'matched', selection: f.part.selection, readKeys: ['selected:2']});
    expect(occurrence.dataSpans.map(span => ({text: result.body.slice(span.startUtf16, span.endUtf16), readKey: span.readKey})))
      .toEqual([{text: '4', readKey: 'selected:2'}, {text: '4', readKey: 'selected:2'}]);
    expect(occurrence.headingSpans.map(span => result.body.slice(span.startUtf16, span.endUtf16))).toEqual([heading]);
    assertPartition(result.body, occurrence);
    expect(result.resourcePhases.raw).toEqual(material(f.wire));
    expect(result.resourcePhases.compiler).toEqual(result.modelCompiled.material.expanded);
    expect(result.resourcePhases.final).toEqual(material(finalGraph(result)));
    expect(measureAuthoredJson(finalGraph(result))).toEqual(result.resourcePhases.final);
  });

  it.each([1, 8, 32, 128] as const)('keeps all %i selected cells and their ordered occurrences without adding model claims', count => {
    const a = api(), f = sourceFixture(), rows = Array.from({length: count}, (_, index) => 2 + index * 3);
    f.wire.bodyParts[2].evidenceQuote.rows.indices = rows;
    f.records = rows.map<ReadRecord>((rowIndex, index) => ({key: `selected:${rowIndex}`, locator: {evidenceRefId: 'data:quote'},
      traceSide: 'current', rowIndex, cells: [{column: 'duration', value: 1000 + index, unit: 'ms'}]}));
    f.part = {...f.part, selection: {...f.part.selection, rows, page: {...f.part.selection.page, visibleRows: count}},
      readKeys: f.records.map(record => record.key)};
    const result = composed(a, f.wire, [f.part], f.records), occurrence = result.quoteOccurrences[0];
    const expectedTable = '\n\n' + heading + caption(count, count) + tableHeader +
      rows.map((rowIndex, index) => `| ${rowIndex} | duration | ${1000 + index} | ${1000 + index} | ms |\n`).join('') + '\n';
    expect(result.body).toBe('Model prefix 😀\nIndependent model assertion: 11 ms.' + expectedTable + '\nModel suffix.');
    expect(result.rawCanonicalPayload).toEqual(f.full); expect(result.rawCanonicalPayload.claims).toHaveLength(1);
    expect(result.selectedReadSnapshot).toHaveLength(count); expect(occurrence.dataSpans).toHaveLength(count * 2);
    expect(occurrence.dataSpans.map(span => result.body.slice(span.startUtf16, span.endUtf16)))
      .toEqual(rows.flatMap((_, index) => [String(1000 + index), String(1000 + index)]));
    assertPartition(result.body, occurrence); expect(result.resourcePhases.final).toEqual(material(finalGraph(result)));
  });

  it('uses the supplied all-visible page order without inferring a contiguous or whole-capture range', () => {
    const a = api(), f = sourceFixture(); f.wire.bodyParts[2].evidenceQuote.rows = {kind: 'all_visible'};
    f.part = {...f.part, selection: {...f.part.selection, rows: [8, 2], page: {...f.part.selection.page, visibleRows: 2}},
      readKeys: ['selected:8', 'selected:2']};
    f.records.unshift({key: 'selected:8', locator: {evidenceRefId: 'data:quote'}, traceSide: 'current', rowIndex: 8,
      cells: [{column: 'duration', value: 6, unit: 'ms'}]});
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.body.indexOf('| 8 | duration | 6 | 6 | ms |')).toBeLessThan(result.body.indexOf('| 2 | duration | 4 | 4 | ms |'));
    expect(result.body).not.toContain('| 3 |'); expect(result.quoteOccurrences[0].selection.rows).toEqual([8, 2]);
    expect(result.rawCanonicalPayload).toEqual(f.full);
  });

  it.each([
    {name: 'exact_scale', value: 1500, source: 'us', target: 'ms', places: 1, display: '1.5 ms', displayNumber: '1.5'},
    {name: 'positive_half', value: '1.25', source: 'ms', target: 'ms', places: 1, display: '≈ 1.3 ms', displayNumber: '1.3'},
    {name: 'negative_half', value: '-1.25', source: 'ms', target: 'ms', places: 1, display: '≈ -1.3 ms', displayNumber: '-1.3'},
    {name: 'nonzero_to_zero', value: '0.001', source: 'ms', target: 'ms', places: 0, display: '≈ 0 ms', displayNumber: '0'},
    {name: 'decimal_string', value: '0004.00', source: 'ms', target: 'ms', places: 2, display: '4.00 ms', displayNumber: '4.00'},
    {name: 'sql_null', value: null, source: 'ms', target: 'ms', places: 2, display: 'NULL', displayNumber: 'NULL'},
  ])('formats $name from selected values, independently of model assertions', item => {
    const a = api(), f = sourceFixture();
    f.wire.bodyParts[2].evidenceQuote.fields[0].format = {kind: 'numeric', unit: item.target, decimalPlaces: item.places, rounding: 'half_away_from_zero'};
    f.records[0] = {...f.records[0], cells: [{column: 'duration', value: item.value, unit: item.source}]};
    const result = composed(a, f.wire, [f.part], f.records), occurrence = result.quoteOccurrences[0];
    expect(occurrence.fidelity).toBe('matched');
    expect(occurrence.dataSpans.map(span => result.body.slice(span.startUtf16, span.endUtf16)))
      .toEqual([item.displayNumber, item.value === null ? 'NULL' : String(item.value)]);
    const rowPrefix = '| 2 | duration | ';
    const rowStart = result.body.indexOf(rowPrefix + item.display + ' |', occurrence.startUtf16);
    expect(rowStart).toBeGreaterThanOrEqual(occurrence.startUtf16);
    const displayStart = rowStart + rowPrefix.length;
    if (item.value !== null) {
      const unitStart = displayStart + item.display.length - item.target.length;
      expect(occurrence.contextSpans.some(span => span.startUtf16 <= unitStart && span.endUtf16 >= unitStart + item.target.length)).toBe(true);
    }
    if (item.display.startsWith('≈ ')) {
      expect(occurrence.contextSpans.some(span => span.startUtf16 <= displayStart && span.endUtf16 >= displayStart + 1)).toBe(true);
    }
    expect(result.rawCanonicalPayload).toEqual(f.full); assertPartition(result.body, occurrence);
  });

  it.each([
    {name: 'unknown_unit', unit: undefined, format: {kind: 'numeric', unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero'}, reason: 'unit_unknown'},
    {name: 'wrong_dimension', unit: 'B', format: {kind: 'numeric', unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero'}, reason: 'unit_dimension_mismatch'},
    {name: 'invalid_precision', unit: 'ms', format: {kind: 'numeric', unit: 'ms', decimalPlaces: 19, rounding: 'half_away_from_zero'}, reason: 'invalid_precision'},
    {name: 'discrete_fraction', unit: 'events', format: {kind: 'numeric', unit: 'count', decimalPlaces: 1, rounding: 'half_away_from_zero'}, reason: 'discrete_format_required'},
  ])('keeps recognized but unusable $name local to the complete quote component', item => {
    const a = api(), f = sourceFixture(); f.wire.bodyParts[2].evidenceQuote.fields[0].format = item.format;
    f.records[0] = {...f.records[0], cells: [{column: 'duration', value: 4, ...(item.unit === undefined ? {} : {unit: item.unit})}]};
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.quoteOccurrences[0]).toMatchObject({fidelity: 'unavailable', reason: item.reason, dataSpans: []});
    expect(result.body).toBe('Model prefix 😀\nIndependent model assertion: 11 ms.' + unavailableText + '\nModel suffix.');
    expect(result.rawCanonicalPayload).toEqual(f.full);
  });

  it('shows unknown raw unit honestly and never obtains a unit from the model numeric assertion', () => {
    const a = api(), f = sourceFixture(); f.records[0] = {...f.records[0], cells: [{column: 'duration', value: '0004.00'}]};
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.body).toContain('| 2 | duration | 0004.00 | 0004.00 | unknown |');
    expect(result.body).not.toContain('| 2 | duration | 0004.00 | 0004.00 | ms |');
    expect(result.quoteOccurrences[0].fidelity).toBe('matched');
  });

  it('makes the entire two-row component unavailable when one selected cell is unsupported', () => {
    const a = api(), f = sourceFixture(); f.wire.bodyParts[2].evidenceQuote.rows.indices = [2, 5];
    f.part = {...f.part, selection: {...f.part.selection, rows: [2, 5], page: {...f.part.selection.page, visibleRows: 2}}, readKeys: ['selected:2', 'selected:5']};
    f.records.push({key: 'selected:5', locator: {evidenceRefId: 'data:quote'}, traceSide: 'current', rowIndex: 5,
      cells: [{column: 'duration', value: 'PRIVATE_UNSUPPORTED_STRING', unit: 'ms'}]});
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.quoteOccurrences[0]).toMatchObject({fidelity: 'unavailable', reason: 'unsupported_cell', dataSpans: []});
    expect(result.body).not.toContain('| 2 |'); expect(result.body).not.toContain('PRIVATE_UNSUPPORTED_STRING');
    expect(JSON.stringify(result.selectedReadSnapshot)).not.toContain('PRIVATE_UNSUPPORTED_STRING');
    expect(result.rawCanonicalPayload).toEqual(f.full);
  });

  it('represents an empty selection with a metadata-only record, without an absence claim', () => {
    const a = api(), f = sourceFixture(); f.wire.bodyParts[2].evidenceQuote.rows.indices = [];
    f.part = {...f.part, selection: {...f.part.selection, rows: []}, readKeys: ['metadata']};
    f.records = [{key: 'metadata', locator: {evidenceRefId: 'data:quote'}, traceSide: 'current', metadataOnly: true, cells: []}];
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.body).toContain(caption(1, 0) + '未选择行 / No rows selected. This does not establish an empty result or population.');
    expect(result.quoteOccurrences[0]).toMatchObject({fidelity: 'matched', dataSpans: [], readKeys: ['metadata']});
    const missing = composed(a, f.wire, [f.part], []);
    expect(missing.quoteOccurrences[0]).toMatchObject({fidelity: 'unavailable', reason: 'read_unavailable', dataSpans: []});
    expect(missing.body).not.toContain('data:quote');
  });

  it('escapes the supplied visible column while leaving all model literals byte-for-byte unchanged', () => {
    const a = api(), f = sourceFixture(), column = 'x|<tag>&\n`cmd`';
    f.wire.bodyParts[0] = 'MODEL <tag>& |\n'; f.wire.bodyParts[2].evidenceQuote.fields[0].column = column;
    f.part = {...f.part, selection: {...f.part.selection, columns: [column]}};
    f.records[0] = {...f.records[0], cells: [{column, value: 4, unit: 'ms'}]};
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.body.startsWith('MODEL <tag>& |\n')).toBe(true);
    expect(result.body).toContain('x&#124;&lt;tag&gt;&amp;<br>\\`cmd\\`');
    expect(result.quoteOccurrences[0].dataSpans.map(span => result.body.slice(span.startUtf16, span.endUtf16))).toEqual(['4', '4']);
  });

  it.each(['missing', 'extra', 'duplicate', 'reordered', 'wrong_id', 'wrong_part', 'free_text', 'callback'] as const)(
    'rejects %s material instead of giving the caller a general renderer', variant => {
      const a = api(), f = sourceFixture(), p = prepared(a, f.wire), callback = jest.fn(() => 'REPLACED');
      let parts: unknown = [f.part];
      if (variant === 'missing') parts = [];
      if (variant === 'extra' || variant === 'duplicate') parts = [f.part, {...f.part, ...(variant === 'extra' ? {quoteId: 'extra', partIndex: 99} : {})}];
      if (variant === 'wrong_id') parts = [{...f.part, quoteId: 'other'}];
      if (variant === 'wrong_part') parts = [{...f.part, partIndex: 1}];
      if (variant === 'free_text') parts = [{...f.part, text: 'Replace model body', header: 'Arbitrary heading'}];
      if (variant === 'callback') parts = [{...f.part, render: callback}];
      if (variant === 'reordered') {
        f.wire.bodyParts.push(quote('second')); const second = {...f.part, partIndex: 4, quoteId: 'second'};
        parts = [second, f.part];
      }
      const result = a.assembleAuthoredEvidenceDocument(variant === 'reordered' ? prepared(a, f.wire) : p,
        {quoteParts: parts as readonly QuotePart[], selectedReadSnapshot: f.records});
      expect(result.status).toBe('projection_failed'); expect(result).not.toHaveProperty('body'); expect(callback).not.toHaveBeenCalled();
    });

  it('preserves original local numeric quote failure rather than selecting a program numeral', () => {
    const a = api(), f = sourceFixture();
    f.wire.contract.claims[0].semantics.numeric.presentation = {unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero',
      quotes: [{kind: 'body_part', partIndex: 1, text: '4 ms', localOccurrence: null}]};
    const result = a.assembleAuthoredEvidenceDocument(prepared(a, f.wire), {quoteParts: [f.part], selectedReadSnapshot: f.records});
    expect(result).toMatchObject({status: 'projection_failed', phase: 'compiler', code: 'quote_unresolved',
      compilerFailureLocation: {claimOrdinal: 1, quoteOrdinal: 1, partIndex: 1, reason: 'local_no_match'}});
    expect(result).not.toHaveProperty('body');
  });

  it('keeps repeated quote occurrences distinct while retaining one selected-record entry', () => {
    const a = api(), f = sourceFixture(); f.wire.bodyParts.push(quote('second'));
    const second = {...f.part, quoteId: 'second', partIndex: 4};
    const result = composed(a, f.wire, [f.part, second], f.records);
    expect(result.selectedReadSnapshot).toHaveLength(1); expect(result.quoteOccurrences).toHaveLength(2);
    expect(result.quoteOccurrences[1].startUtf16).toBeGreaterThan(result.quoteOccurrences[0].endUtf16);
    expect(result.quoteOccurrences[1].dataSpans[0].startUtf16).toBeGreaterThan(result.quoteOccurrences[0].dataSpans[0].startUtf16);
    result.quoteOccurrences.forEach(item => assertPartition(result.body, item));
    expect(result.resourcePhases.final).toEqual(material(finalGraph(result)));
  });

  it('counts UTF-8 escaping and surrogate pairs exactly without normalizing UTF-16 parts', () => {
    const a = api(), f = plainFixture(); f.wire.bodyParts = ['\ud83d', '\ude00', '\ud800', '"\\\n中 e\u0301'];
    const result = composed(a, f.wire);
    expect(result.body).toBe('😀\ud800"\\\n中 e\u0301');
    expect(result.modelCompiled.partSpans).toEqual([{partIndex: 0, startUtf16: 0, endUtf16: 1},
      {partIndex: 1, startUtf16: 1, endUtf16: 2}, {partIndex: 2, startUtf16: 2, endUtf16: 3},
      {partIndex: 3, startUtf16: 3, endUtf16: result.body.length}]);
    expect(result.resourcePhases.final).toEqual(material(finalGraph(result)));
    expect(result.modelCompiled.material.bodyUtf8Bytes).toBe(Buffer.byteLength(result.body));
  });

  it.each(['bytes', 'nodes', 'depth'] as const)('enforces the raw %s exact boundary and boundary+1 before copying', axis => {
    const a = api(), f = plainFixture(), cap = CONCLUSION_AUTHORING_LIMITS;
    f.wire.bodyParts = [''];
    if (axis === 'bytes') f.wire.bodyParts[0] = 'x'.repeat(cap.utf8Bytes - material(f.wire).utf8Bytes);
    if (axis === 'nodes') {f.wire.contract.uncertainties = []; f.wire.contract.uncertainties = Array(cap.nodes - material(f.wire).nodes).fill('');}
    if (axis === 'depth') {
      let nested: unknown = null; f.wire.referenceDictionary[0].value.value = nested;
      while (material(f.wire).depth < cap.depth) {nested = [nested]; f.wire.referenceDictionary[0].value.value = nested;}
    }
    const key = axis === 'bytes' ? 'utf8Bytes' : axis;
    expect(material(f.wire)[key]).toBe(cap[key]); expect(prepared(a, f.wire).rawMaterial[key]).toBe(cap[key]);
    if (axis === 'bytes') f.wire.bodyParts[0] += 'x';
    if (axis === 'nodes') f.wire.contract.uncertainties.push('');
    if (axis === 'depth') f.wire.referenceDictionary[0].value.value = [f.wire.referenceDictionary[0].value.value];
    expect(material(f.wire)[key]).toBe(cap[key] + 1);
    expect(a.prepareAuthoredEvidenceDocument(f.wire)).toMatchObject({status: 'projection_failed', phase: 'raw', code: `raw_${axis}_exceeded`});
  });

  it.each(['bytes', 'nodes'] as const)('rejects derived %s expansion even when the raw document fits', axis => {
    const a = api(), f = sourceFixture(), count = axis === 'bytes' ? 40 : 280;
    const column = axis === 'bytes' ? '&'.repeat(8000) : 'duration';
    f.wire.bodyParts = Array.from({length: count}, (_, index) => quote(`q${index}`, 'view:one', column));
    const parts = Array.from({length: count}, (_, index) => ({...f.part, partIndex: index, quoteId: `q${index}`,
      selection: {...f.part.selection, columns: [column]}}));
    f.records[0] = {...f.records[0], cells: [{column, value: 4, unit: 'ms'}]};
    const p = prepared(a, f.wire); expect(p.rawMaterial.utf8Bytes).toBeLessThan(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    expect(p.rawMaterial.nodes).toBeLessThan(CONCLUSION_AUTHORING_LIMITS.nodes);
    const result = a.assembleAuthoredEvidenceDocument(p, {quoteParts: parts, selectedReadSnapshot: f.records});
    expect(result).toMatchObject({status: 'projection_failed', phase: 'derived', code: `${axis}_exceeded`});
    expect(result).not.toHaveProperty('body'); expect(f.wire.contract.claims[0].semantics.numeric.value).toBe(11);
  });

  it('retains the original compiler expansion limit rather than silently dropping repeated references', () => {
    const a = api(), f = plainFixture();
    f.wire.referenceDictionary[0].sourceRef = 'r'.repeat(5000);
    f.wire.contract.claims[0].references = Array(220).fill(0);
    const old = compileAuthoredClaimObject({...f.wire, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION});
    expect(old).toMatchObject({status: 'projection_failed', code: 'expanded_bytes_exceeded'});
    const result = a.assembleAuthoredEvidenceDocument(prepared(a, f.wire), {quoteParts: [], selectedReadSnapshot: []});
    expect(result).toMatchObject({status: 'projection_failed', phase: 'compiler', code: 'expanded_bytes_exceeded'});
    expect(f.wire.contract.claims[0].references).toHaveLength(220);
  });

  it('checks the exact final aggregate at the cap and cap+1 without changing raw or compiler limits', () => {
    const a = api(), f = sourceFixture(); f.wire.contract.uncertainties = ['']; f.full.uncertainties = [''];
    const base = composed(a, f.wire, [f.part], f.records);
    const padding = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - material(finalGraph(base)).utf8Bytes;
    expect(padding).toBeGreaterThan(0);
    for (const extra of [0, 1]) {
      const raw = structuredClone(f.wire); raw.contract.uncertainties = ['x'.repeat(padding + extra)];
      const expectedCanonical = structuredClone(f.full); expectedCanonical.uncertainties = ['x'.repeat(padding + extra)];
      const expectedGraph = {...finalGraph(base), rawCanonicalPayload: expectedCanonical};
      expect(material(expectedGraph).utf8Bytes).toBe(CONCLUSION_AUTHORING_LIMITS.utf8Bytes + extra);
      const p = prepared(a, raw);
      const internal = {...raw, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        bodyParts: ['Model prefix 😀\n', {claimText: 'duration'}, rawQuoteText, '\nModel suffix.']};
      const old = compiled(internal);
      expect(old.material.expanded.utf8Bytes).toBeLessThan(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
      const result = a.assembleAuthoredEvidenceDocument(p, {quoteParts: [f.part], selectedReadSnapshot: f.records});
      if (extra === 0) {
        expect(result.status).toBe('composed');
        if (result.status === 'composed') {
          expect(result.rawCanonicalPayload).toEqual(expectedCanonical);
          expect(result.resourcePhases.final).toEqual(material(expectedGraph));
          expect(Object.isFrozen(result.selectedReadSnapshot[0].cells)).toBe(true);
        }
      } else {
        expect(result).toMatchObject({status: 'projection_failed', phase: 'final', code: 'bytes_exceeded'});
        expect(result).not.toHaveProperty('body');
      }
    }
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e100, -1e100])(
    'preserves JSON-stable finite raw number %p independently of arithmetic eligibility', value => {
      const a = api(), f = sourceFixture();
      expect(Number.isFinite(value)).toBe(true);
      expect(Object.is(JSON.parse(JSON.stringify(value)), value)).toBe(true);
      f.records[0] = {...f.records[0], cells: [{column: 'duration', value, unit: 'ms'}]};
      const raw = composed(a, f.wire, [f.part], f.records);
      expect(raw.quoteOccurrences[0].fidelity).toBe('matched');
      expect(raw.quoteOccurrences[0].dataSpans.map(span => raw.body.slice(span.startUtf16, span.endUtf16)))
        .toEqual([String(value), String(value)]);
      expect(Object.is(raw.selectedReadSnapshot[0].cells[0].value, value)).toBe(true);
      expect(raw.rawCanonicalPayload).toEqual(f.full);
      expect(raw.rawCanonicalPayload.claims[0].semantics.numeric.value).toBe(11);

      f.wire.bodyParts[2].evidenceQuote.fields[0].format = {
        kind: 'numeric', unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero'};
      const numeric = composed(a, f.wire, [f.part], f.records);
      expect(numeric.quoteOccurrences[0]).toMatchObject({
        fidelity: 'unavailable', reason: 'unsupported_cell', dataSpans: []});
      expect(numeric.rawCanonicalPayload).toEqual(f.full);
    });

  it('keeps raw zero and the string negative zero distinct from JSON-unstable numeric negative zero', () => {
    const a = api();
    for (const value of [0, '-0']) {
      const f = sourceFixture();
      f.records[0] = {...f.records[0], cells: [{column: 'duration', value, unit: 'ms'}]};
      const result = composed(a, f.wire, [f.part], f.records);
      expect(result.quoteOccurrences[0].fidelity).toBe('matched');
      expect(result.quoteOccurrences[0].dataSpans.map(span => result.body.slice(span.startUtf16, span.endUtf16)))
        .toEqual([String(value), String(value)]);
      expect(Object.is(result.selectedReadSnapshot[0].cells[0].value, value)).toBe(true);
    }
    const f = sourceFixture();
    f.records[0] = {...f.records[0], cells: [{column: 'duration', value: -0, unit: 'ms'}]};
    expect(Object.is(JSON.parse(JSON.stringify(-0)), -0)).toBe(false);
    const result = composed(a, f.wire, [f.part], f.records);
    expect(result.quoteOccurrences[0]).toMatchObject({
      fidelity: 'unavailable', reason: 'unsupported_cell', dataSpans: []});
    expect(result.rawCanonicalPayload).toEqual(f.full);
  });
});
