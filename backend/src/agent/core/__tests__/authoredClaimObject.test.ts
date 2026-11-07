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

  it('reports closed structure diagnostics without private keys or values', () => {
    const f = fixture();
    delete f.wire.referenceDictionary[0].sourceRef;
    f.wire.referenceDictionary[0]['private-key-canary'] = 'private-value-canary';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'invalid_structure'});
      expect(warn).toHaveBeenCalledWith('[AuthoredClaimObject] structure mismatch', expect.objectContaining({
        expectedFields: expect.arrayContaining(['sourceRef']), missingFields: ['sourceRef'],
        unexpectedFieldCount: 1, actualKind: 'object',
      }));
      expect(warn).toHaveBeenCalledWith('[AuthoredClaimObject] invalid structure location', {
        sourceLocations: expect.any(Array),
      });
      const locations = warn.mock.calls.find(call => call[0] === '[AuthoredClaimObject] invalid structure location')?.[1].sourceLocations;
      expect(locations.length).toBeGreaterThan(0);
      expect(locations.length).toBeLessThanOrEqual(3);
      for (const location of locations) {
        expect(Object.keys(location).sort()).toEqual(['column', 'line']);
        expect(Number.isSafeInteger(location.line) && location.line > 0).toBe(true);
        expect(Number.isSafeInteger(location.column) && location.column > 0).toBe(true);
      }
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-key-canary');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private-value-canary');
    } finally {warn.mockRestore();}
  });

  it('preserves the structure failure when diagnostic logging throws', () => {
    const f = fixture(); delete f.wire.referenceDictionary[0].sourceRef;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {throw new Error('diagnostic unavailable');});
    try {expect(compileAuthoredClaimObject(f.wire)).toMatchObject({status: 'projection_failed', code: 'invalid_structure'});}
    finally {warn.mockRestore();}
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
