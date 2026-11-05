// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable, type CapturedFieldSemantics} from '../evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../traceProcessorConnectionModel';
import {diagnoseConclusionDraft, draftDiagnosticOwnerKey, DRAFT_DECLARATION_MAX_BYTES} from '../draftDeclarationDiagnostics';
import {MAX_CLAIM_DIAGNOSTICS, parseConclusionContractDeclaration} from '../../agent/core/conclusionContract';
import * as presentationAssessment from '../numericPresentationAssessment';

function fixture(options: {unit?: boolean; unitToken?: string; trace?: string; budget?: number; viewRun?: string; viewSession?: string} = {}) {
  const store = new ArtifactStore();
  const value = 7.123456;
  const data = {columns: ['elapsed', 'secret', 'events'], rows: [[value, 'never return retained private cell', 2]]};
  const origin = {kind: 'skill_literal' as const, skillId: 'fixture', stepId: 'table', definitionFingerprint: 'issued-definition'};
  const witness = captureEvidenceTable(data, options.unit === false ? {} : {
    elapsed: {unit: options.unitToken ?? 'ms', origin}, events: {unit: 'events', origin}});
  const artifactId = store.store({skillId: 'fixture', data,
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: options.trace ?? 'trace', traceSide: 'current'})});
  store.registerEvidenceCapture(artifactId, witness, {evidenceRefId: 'evidence:fixture'});
  const reference = {artifactId, rowIndex: 0, column: 'elapsed', value};
  const contract: any = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
    clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'duration', text: 'Elapsed 7.1 ms.',
      kind: 'numeric', references: [reference], semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell',
        polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value, unit: 'ms',
          presentation: {schemaVersion: 'numeric_presentation@1', unit: 'ms', decimalPlaces: 1,
            rounding: 'half_away_from_zero', quotes: [{text: '7.1 ms'}]}}}}]};
  const runId = 'run', sessionId = 'session';
  const viewRun = options.viewRun ?? runId, viewSession = options.viewSession ?? sessionId;
  const readView = store.createEvidenceReadView({currentRunId: viewRun,
    ownerKey: draftDiagnosticOwnerKey(viewRun, viewSession), allowedTraces: [{traceId: 'trace', traceSide: 'current'}],
    ...(options.budget !== undefined ? {budget: {maxReferences: options.budget}} : {})});
  return {store, contract, input: {body: 'Elapsed 7.1 ms.', declarationJson: JSON.stringify(contract), runId, sessionId, readView}};
}

function claimKindFixture(kind: string) {
  const f = fixture();
  const claim = f.contract.claims[0];
  const semantics = claim.semantics;
  claim.kind = kind;
  const origin = {kind: 'skill_literal' as const, definitionFingerprint: 'kind-fixture', skillId: 'kind-fixture', stepId: 'table'};
  const capture = (data: {columns: string[]; rows: unknown[][]}, fields: Record<string, CapturedFieldSemantics>, side: 'current' | 'reference' = 'current') => {
    const traceId = side === 'current' ? 'trace' : 'reference-trace';
    const id = f.store.store({skillId: 'kind-fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: side}),
      scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target',
        scope: {mode: 'unscoped', traceId, traceSide: side}, fields: data.columns, availability: 'available'}]}});
    f.store.registerEvidenceCapture(id, captureEvidenceTable(data, fields), {evidenceRefId: `kind:${id}`});
    return id;
  };
  let expected = 'numeric_operator_proved';
  if (kind !== 'numeric') delete semantics.numeric;
  if (kind === 'categorical' || kind === 'identity') {
    const column = kind === 'identity' ? 'process_name' : 'state';
    const value = kind === 'identity' ? 'sample.app' : 'Ready';
    const id = capture({columns: [column], rows: [[value]]}, {[column]: {origin}});
    const ref = {artifactId: id, rowIndex: 0, column, value};
    claim.text = `The captured ${column} is ${value}.`;
    claim.references = [ref]; semantics.scope.subjectRefs = [ref]; semantics.predicate = 'captured.cell';
    expected = 'captured_cell_value_proved';
  } else if (kind === 'time_range') {
    const id = capture({columns: ['ts', 'dur'], rows: [['100', '20'], ['110', '20']]}, {
      ts: {origin, unit: 'ns', clock: 'trace_monotonic', timeRole: 'start'},
      dur: {origin, unit: 'ns', clock: 'trace_monotonic', timeRole: 'duration'},
    });
    const subject = {artifactId: id, rowIndex: 0}, object = {artifactId: id, rowIndex: 1};
    claim.text = 'The captured half-open intervals overlap.';
    claim.references = [subject, object]; semantics.predicate = 'interval.overlap';
    semantics.scope.subjectRefs = [subject]; semantics.scope.objectRefs = [object];
    expected = 'half_open_interval_overlap_proved';
  } else if (kind === 'comparison') {
    const fields = {duration: {origin, unit: 'ms', metricId: 'duration', aggregation: 'sum', populationKey: 'sample'}};
    const current = capture({columns: ['duration'], rows: [[10]]}, fields);
    const reference = capture({columns: ['duration'], rows: [[8]]}, fields, 'reference');
    const subject = {artifactId: current, rowIndex: 0, column: 'duration', value: 10};
    const object = {artifactId: reference, rowIndex: 0, column: 'duration', value: 8};
    claim.text = 'Current minus reference duration is 2 ms.';
    claim.references = [subject, object]; semantics.predicate = 'comparison.delta';
    semantics.scope.subjectRefs = [subject]; semantics.scope.objectRefs = [object];
    semantics.numeric = {operator: 'eq', value: 2, unit: 'ms'};
    expected = 'cited_metric_delta_proved';
  } else if (kind === 'causal' || kind === 'inference' || kind === 'recommendation') {
    semantics.predicate = `${kind}.unconfigured`;
    semantics.modality = 'possible';
    semantics.conditions = ['Additional execution evidence is required.'];
    claim.text = kind === 'causal' ? 'Blocking might explain the duration.'
      : kind === 'inference' ? 'The sampled duration may reflect contention.' : 'Inspect contention before changing worker count.';
    expected = 'unsupported_predicate';
  }
  const readView = f.store.createEvidenceReadView({currentRunId: 'run', ownerKey: draftDiagnosticOwnerKey('run', 'session'),
    allowedTraces: [{traceId: 'trace', traceSide: 'current'}, {traceId: 'reference-trace', traceSide: 'reference'}]});
  return {...f, expected, input: {...f.input, readView}};
}

describe('draft declaration diagnostics', () => {
  it.each([undefined, '', 'Wrong quotation: 999 ms.'])('claims_only never checks presentation, supplied body=%j', async body => {
    const f = fixture();
    const check = jest.spyOn(presentationAssessment, 'assessNumericPresentations');
    try {
      const result = await diagnoseConclusionDraft({...f.input, diagnosticMode: 'claims_only', body});
      expect(result).toMatchObject({state: 'diagnosed', coverageNotChecked: true, finalCertification: false,
        presentation: {status: 'not_checked', reason: 'claims_only'},
        diagnostics: [{finiteReason: 'numeric_operator_proved'}]});
      expect(check).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/presentationReason|quoteOccurrences/);
    } finally {check.mockRestore();}
  });

  it('keeps legacy and explicit presentation checks identical', async () => {
    const f = fixture();
    expect(await diagnoseConclusionDraft({...f.input, diagnosticMode: 'presentation'}))
      .toEqual(await diagnoseConclusionDraft(f.input));
    expect(await diagnoseConclusionDraft({...f.input, diagnosticMode: 'presentation', body: undefined}))
      .toMatchObject({state: 'invalid_input', reason: 'input_type_invalid'});
  });

  it.each(['numeric', 'categorical', 'time_range', 'identity', 'causal', 'comparison', 'inference', 'recommendation'])(
    'preserves legal %s full/compact finite diagnostics over the same issued facts', async kind => {
      const f = claimKindFixture(kind);
      const full = JSON.parse(JSON.stringify(f.contract));
      expect(parseConclusionContractDeclaration(full).issues).toEqual([]);
      const dictionary = full.claims[0].references;
      const compact = JSON.parse(JSON.stringify(full));
      compact.claims[0].references = dictionary.map((_ref: unknown, index: number) => ({$ref: index}));
      compact.claims[0].semantics.scope.subjectRefs = [{$ref: 0}];
      if (compact.claims[0].semantics.scope.objectRefs) compact.claims[0].semantics.scope.objectRefs = [{$ref: 1}];
      const input = {...f.input, body: undefined, diagnosticMode: 'claims_only'};
      const result = await diagnoseConclusionDraft({...input, declarationJson: JSON.stringify({
        authoringVersion: 'conclusion_authoring@1', referenceDictionary: dictionary, contract: compact})});
      expect(result).toEqual(await diagnoseConclusionDraft({...input, declarationJson: JSON.stringify(full)}));
      expect(result).toMatchObject({state: 'diagnosed', schemaDiagnostics: [], diagnostics: [{finiteReason: f.expected}],
        presentation: {status: 'not_checked', reason: 'claims_only'}, finalCertification: false});
    });

  it('does not let compact inputs bypass the draft expanded-byte budget or read evidence', async () => {
    const f = fixture();
    const ref = {...f.contract.claims[0].references[0], column: 'x'.repeat(33000)};
    f.contract.claims[0].references = [{$ref: 0}];
    f.contract.claims[0].semantics.scope.subjectRefs = [{$ref: 0}];
    const declarationJson = JSON.stringify({authoringVersion: 'conclusion_authoring@1', referenceDictionary: [ref], contract: f.contract});
    expect(Buffer.byteLength(declarationJson)).toBeLessThan(DRAFT_DECLARATION_MAX_BYTES);
    const read = jest.fn(f.input.readView.resolveReferences);
    const result = await diagnoseConclusionDraft({...f.input, diagnosticMode: 'claims_only', body: undefined, declarationJson,
      readView: {...f.input.readView, resolveReferences: read}});
    expect(result).toMatchObject({state: 'invalid_input', reason: 'expanded_budget_exhausted',
      inputBudget: {declarationBytes: Buffer.byteLength(declarationJson), maxBytes: DRAFT_DECLARATION_MAX_BYTES}});
    expect(read).not.toHaveBeenCalled();
  });

  it('reports invalid authoring resource/envelope failures without private input echo', async () => {
    const f = fixture();
    const result = await diagnoseConclusionDraft({...f.input, diagnosticMode: 'claims_only', body: undefined,
      declarationJson: JSON.stringify({authoringVersion: 'PRIVATE_VERSION', contract: f.contract, referenceDictionary: []})});
    expect(result).toMatchObject({state: 'invalid_input', reason: 'invalid_authoring', authoringCode: 'unsupported_version'});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VERSION');
  });

  it('checks supplied claims_only body type and UTF-8 size before evidence reads', async () => {
    const f = fixture();
    const read = jest.fn(f.input.readView.resolveReferences);
    for (const body of [null, 3, {}, '汉'.repeat(Math.floor(DRAFT_DECLARATION_MAX_BYTES / 3) + 1)]) {
      const result = await diagnoseConclusionDraft({...f.input, diagnosticMode: 'claims_only', body,
        readView: {...f.input.readView, resolveReferences: read}});
      expect(result).toMatchObject({state: 'invalid_input', presentation: {status: 'not_checked', reason: 'claims_only'}});
    }
    expect(read).not.toHaveBeenCalled();
    expect(await diagnoseConclusionDraft({...f.input, diagnosticMode: 'PRIVATE_UNKNOWN_MODE'}))
      .toMatchObject({reason: 'diagnostic_mode_invalid'});
  });
  it('checks issued quantities without storing changes, private values or final certification', async () => {
    const f = fixture();
    const before = JSON.stringify(f.store.serialize());
    const input = JSON.stringify({...f.input, readView: undefined});
    const fetch = jest.spyOn(globalThis, 'fetch');
    try {
      const result = await diagnoseConclusionDraft(f.input);
      expect(result).toMatchObject({diagnosticOnly: true, coverageNotChecked: true, finalCertification: false, state: 'diagnosed',
        diagnostics: [{finiteReason: 'numeric_operator_proved', presentationReason: 'display_matches', producerUnits: ['ms']}]});
      expect(JSON.stringify(result)).not.toContain('never return');
      expect(JSON.stringify(result)).not.toContain('7.123456');
      expect(JSON.stringify(result)).not.toMatch(/"(?:anchors|binding|receipt|passed|claimSupport)"/);
      expect(JSON.stringify(f.store.serialize())).toBe(before);
      expect(JSON.stringify({...f.input, readView: undefined})).toBe(input);
      expect(fetch).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
  });
  it('diagnoses a wrong proposition instead of changing it', async () => {
    const f = fixture(); f.contract.claims[0].semantics.numeric.value = 9;
    expect(await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)})).toMatchObject({
      diagnostics: [{finiteReason: 'numeric_operator_rejected', presentationReason: 'proposition_not_proved'}]});
    expect(f.contract.claims[0].semantics.numeric.value).toBe(9);
  });
  it('prioritizes an unproved valid candidate after more than a feedback budget of proved categorical claims', async () => {
    const f = fixture();
    const ref = {...f.contract.claims[0].references[0], column: 'secret', value: 'never return retained private cell'};
    const semantics = {...f.contract.claims[0].semantics, predicate: 'captured.cell', numeric: undefined,
      scope: {population: 'cited_rows', subjectRefs: [ref]}};
    // These full IDs differ even though their projected prefixes collide.
    const idPrefix = 'claim-'.padEnd(128, 'x');
    f.contract.claims = Array.from({length: MAX_CLAIM_DIAGNOSTICS + 1}, (_, index) => ({
      id: `${idPrefix}${index}`, text: 'The captured category is retained.', kind: 'categorical',
      references: [ref], semantics,
    }));
    f.contract.claims.push({id: `${idPrefix}candidate`, text: 'All captured categories agree.', kind: 'categorical',
      references: [ref], semantics: {...semantics, quantifier: 'all'}});
    const declarationJson = JSON.stringify(f.contract);
    const body = 'The captured category is retained. All captured categories agree.';
    const beforeStore = JSON.stringify(f.store.serialize());
    const read = jest.fn(f.input.readView.resolveReferences);
    const input = {...f.input, body, declarationJson, readView: {...f.input.readView, resolveReferences: read}};
    const beforeInput = JSON.stringify({...input, readView: undefined});
    const result = await diagnoseConclusionDraft(input);
    expect(result).toMatchObject({state: 'diagnosed', evaluatedClaimCount: MAX_CLAIM_DIAGNOSTICS + 2,
      omittedDiagnosticCount: 2, schemaDiagnostics: [], coverageNotChecked: true, finalCertification: false});
    if (!('diagnostics' in result)) throw new Error('expected diagnosed feedback');
    expect(result.diagnostics).toHaveLength(MAX_CLAIM_DIAGNOSTICS);
    expect(result.diagnostics[0]).toEqual({claimOrdinal: MAX_CLAIM_DIAGNOSTICS + 2, claimId: idPrefix,
      finiteReason: 'proposition_quantifier_not_supported', referenceReasons: [], referenceDiagnostics: [], producerUnits: []});
    expect(result.diagnostics.slice(1).every(diagnostic => diagnostic.finiteReason === 'captured_cell_value_proved')).toBe(true);
    expect(result.diagnostics.slice(1).map(diagnostic => diagnostic.claimOrdinal))
      .toEqual(Array.from({length: MAX_CLAIM_DIAGNOSTICS - 1}, (_, index) => index + 1));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toHaveLength(1);
    expect(JSON.stringify(f.contract)).toBe(declarationJson);
    expect(JSON.stringify(f.store.serialize())).toBe(beforeStore);
    expect(JSON.stringify(result)).not.toMatch(/needsAttention|never return retained private cell|invalid_claim/);
    expect(JSON.stringify({...input, readView: undefined})).toBe(beforeInput);
  });
  it('retains unknown producer units', async () => {
    expect(await diagnoseConclusionDraft(fixture({unit: false}).input)).toMatchObject({
      diagnostics: [{finiteReason: 'unit_authority_unknown', producerUnits: []}]});
  });
  it('identifies the missing clusters root field without echoing declaration values or reading private cells', async () => {
    const f = fixture();
    delete f.contract.clusters;
    f.contract.claims[0].text = 'MODEL_PRIVATE_CANARY';
    const read = jest.fn(f.input.readView.resolveReferences);
    const result = await diagnoseConclusionDraft({...f.input, readView: {...f.input.readView, resolveReferences: read},
      declarationJson: JSON.stringify(f.contract)});
    expect(result).toEqual({diagnosticOnly: true, coverageNotChecked: true, finalCertification: false,
      state: 'invalid_input', reason: 'invalid_declaration', schemaDiagnostics: [{code: 'invalid_contract', path: '$',
        details: [{field: '$.clusters', reason: 'missing_required', expected: 'array', actual: 'missing'}]}]});
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/MODEL_PRIVATE_CANARY|never return retained private cell|7\.123456/);
  });
  it('locates a single claim numeric value failure using the closed parser diagnostic', async () => {
    const f = fixture(); f.contract.claims[0].semantics.numeric.value = 'MODEL_PRIVATE_NUMERIC_CANARY';
    const result = await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)});
    expect(result).toMatchObject({state: 'diagnosed', schemaDiagnostics: [{code: 'invalid_semantics', path: 'claims[0].semantics',
      claimDiagnostic: {ordinal: 1, code: 'invalid_semantics', field: 'semantics.numeric', subreason: 'value'}}],
      diagnostics: [{finiteReason: 'invalid_claim', producerUnits: []}], coverageNotChecked: true, finalCertification: false});
    expect(JSON.stringify(result)).not.toMatch(/MODEL_PRIVATE_NUMERIC_CANARY|never return retained private cell|7\.123456/);
  });
  it.each([
    ['MODEL_PRIVATE_RELATION_CANARY', 'relationProposals', {scope: 'collection', reason: 'collection_not_array'}],
    [[{MODEL_PRIVATE_RELATION_CANARY: true}], 'relationProposals[0]', {scope: 'item', ordinal: 1, reason: 'unknown_field'}],
  ])('preserves closed relation shape diagnostics without echoing proposal fields: %j', async (proposals, path, diagnostic) => {
    const f = fixture(); f.contract.relationProposals = proposals;
    const result = await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)});
    expect(result).toMatchObject({schemaDiagnostics: [{code: 'invalid_relation_proposal', path, relationProposalDiagnostic: diagnostic}],
      coverageNotChecked: true, finalCertification: false});
    expect(JSON.stringify(result)).not.toMatch(/MODEL_PRIVATE_RELATION_CANARY|never return retained private cell|7\.123456/);
  });
  it('keeps schema feedback bounded when multiple claims fail the same numeric schema', async () => {
    const f = fixture(); const claim = f.contract.claims[0];
    f.contract.claims = Array.from({length: MAX_CLAIM_DIAGNOSTICS + 1}, (_, index) => ({...claim, id: `claim-${index}`,
      semantics: {...claim.semantics, numeric: {...claim.semantics.numeric, value: 'MODEL_PRIVATE_NUMERIC_CANARY'}}}));
    const result = await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)});
    expect('schemaDiagnostics' in result ? result.schemaDiagnostics : undefined).toHaveLength(MAX_CLAIM_DIAGNOSTICS);
    expect(JSON.stringify(result)).not.toContain('MODEL_PRIVATE_NUMERIC_CANARY');
  });
  it('does not project arbitrary stored unit strings or promote an invalid schema item', async () => {
    const hiddenUnit = 'private-unit-value';
    const result = await diagnoseConclusionDraft(fixture({unitToken: hiddenUnit}).input);
    expect(result).toMatchObject({diagnostics: [{producerUnits: []}]});
    expect(JSON.stringify(result)).not.toContain(hiddenUnit);
    const f = fixture(); f.contract.claims[0].semantics.numeric.value = 'invalid-number';
    const read = jest.fn(f.input.readView.resolveReferences);
    const readView = {...f.input.readView, resolveReferences: read};
    expect(await diagnoseConclusionDraft({...f.input, readView, declarationJson: JSON.stringify(f.contract)})).toMatchObject({
      diagnostics: [{finiteReason: 'invalid_claim', producerUnits: []}]});
    expect(read).not.toHaveBeenCalled();
  });
  it('projects only the numeric subject unit when other references have different units', async () => {
    const f = fixture();
    f.contract.claims[0].references.push({...f.contract.claims[0].references[0], column: 'events', value: 2});
    expect(await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)})).toMatchObject({
      diagnostics: [{producerUnits: ['ms'], finiteReason: 'numeric_operator_proved'}]});
  });
  it('reports unbound references without inventing retained cells', async () => {
    const f = fixture();
    f.contract.claims[0].references[0].artifactId = 'not-retained';
    expect(await diagnoseConclusionDraft({...f.input, declarationJson: JSON.stringify(f.contract)})).toMatchObject({
      diagnostics: [{referenceReasons: expect.arrayContaining(['missing'])}]});
  });
  it('locates conflicting issued identifiers without repairing a composite reference or its scope', async () => {
    const f = fixture();
    const ref = f.contract.claims[0].references[0];
    ref.sourceArtifactId = ref.artifactId;
    ref.evidenceRefId = 'REPORT_LOCAL_E1';
    const declarationJson = JSON.stringify(f.contract);
    const read = jest.fn(f.input.readView.resolveReferences);
    const result = await diagnoseConclusionDraft({...f.input, declarationJson,
      readView: {...f.input.readView, resolveReferences: read}});
    expect(result).toMatchObject({state: 'diagnosed', coverageNotChecked: true, finalCertification: false,
      diagnostics: [{referenceReasons: ['missing'], producerUnits: [], referenceDiagnostics: [
        {collection: 'references', referenceOrdinal: 1, status: 'missing', reason: 'identifier_conflict',
          matchedFields: ['artifactId', 'sourceArtifactId'], conflictingFields: ['evidenceRefId']},
        {collection: 'subjectRefs', referenceOrdinal: 1, status: 'missing', reason: 'identifier_conflict',
          matchedFields: ['artifactId', 'sourceArtifactId'], conflictingFields: ['evidenceRefId']},
      ]}]});
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.contract)).toBe(declarationJson);
    expect(JSON.stringify(result)).not.toMatch(/REPORT_LOCAL_E1|evidence:fixture|7\.123456|never return retained private cell/);
    expect(JSON.stringify(result)).not.toContain(ref.artifactId);
  });
  it('omits unknown failure strings and private locator details, exposing only identifier field names', async () => {
    const f = fixture();
    const resolveReferences = jest.fn(async (requests: Parameters<typeof f.input.readView.resolveReferences>[0]) =>
      requests.map(request => ({key: request.key, status: 'missing' as const, reason: 'PRIVATE_REASON_CANARY',
        locatorDetail: {matchedFields: ['artifactId', 'PRIVATE_MATCH_CANARY'],
          conflictingFields: ['evidenceRefId', 'PRIVATE_CONFLICT_CANARY'],
          availableColumns: ['PRIVATE_COLUMN_CANARY'], rowCount: 123456789}})));
    const result = await diagnoseConclusionDraft({...f.input, readView: {...f.input.readView, resolveReferences}});
    expect(result).toMatchObject({diagnostics: [{referenceDiagnostics: [
      {collection: 'references', referenceOrdinal: 1, status: 'missing',
        matchedFields: ['artifactId'], conflictingFields: ['evidenceRefId']},
      {collection: 'subjectRefs', referenceOrdinal: 1, status: 'missing'},
    ]}]});
    expect(resolveReferences).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|availableColumns|rowCount|123456789/);
    const details = 'diagnostics' in result ? result.diagnostics[0].referenceDiagnostics : [];
    expect(details.every(detail => !('reason' in detail))).toBe(true);
  });
  it('bounds locator feedback without dropping the submitted claims or references', async () => {
    const f = fixture(); const ref = f.contract.claims[0].references[0];
    f.contract.claims[0].references = Array.from({length: MAX_CLAIM_DIAGNOSTICS + 2}, (_, index) =>
      ({...ref, artifactId: `not-retained-${index}`}));
    const declarationJson = JSON.stringify(f.contract);
    const result = await diagnoseConclusionDraft({...f.input, declarationJson});
    expect('diagnostics' in result ? result.diagnostics[0].referenceDiagnostics : undefined).toHaveLength(MAX_CLAIM_DIAGNOSTICS);
    expect(result).toMatchObject({evaluatedClaimCount: 1, diagnostics: [{omittedReferenceDiagnosticCount: 2}]});
    expect('diagnostics' in result && result.diagnostics[0].referenceDiagnostics[0]).toMatchObject({
      collection: 'references', referenceOrdinal: 1, reason: 'evidence_not_retained'});
    expect(JSON.stringify(f.contract)).toBe(declarationJson);
  });
  it('reports only a safe numeric syntax position and payload length, never parser text', async () => {
    const f = fixture(); const declarationJson = '{"private":"PRIVATE_JSON_CANARY","value":1,}';
    const read = jest.fn(f.input.readView.resolveReferences);
    const result = await diagnoseConclusionDraft({...f.input, declarationJson,
      readView: {...f.input.readView, resolveReferences: read}});
    expect(result).toEqual({diagnosticOnly: true, coverageNotChecked: true, finalCertification: false,
      state: 'invalid_input', reason: 'invalid_json',
      syntaxDiagnostic: {payloadChars: declarationJson.length, offsetUtf16: declarationJson.length - 1}});
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_JSON_CANARY|SyntaxError|column|line/);
    const truncated = await diagnoseConclusionDraft({...f.input, declarationJson: '{'});
    expect(truncated).toMatchObject({reason: 'invalid_json', syntaxDiagnostic: {payloadChars: 1}});
    const unknownFormat = await diagnoseConclusionDraft({...f.input, declarationJson: 'PRIVATE_JSON_CANARY'});
    expect('syntaxDiagnostic' in unknownFormat && unknownFormat.syntaxDiagnostic).not.toHaveProperty('offsetUtf16');
    expect(JSON.stringify(unknownFormat)).not.toContain('PRIVATE_JSON_CANARY');
  });
  it.each([
    ['body', '汉'.repeat(Math.floor(DRAFT_DECLARATION_MAX_BYTES / 3) + 1)],
    ['declarationJson', '汉'.repeat(Math.floor(DRAFT_DECLARATION_MAX_BYTES / 3) + 1)],
    ['body', ' \n\t'],
  ] as const)('locates the actual UTF-8 input budget failure in %s', async (field, value) => {
    const f = fixture(); const input = {...f.input, [field]: value};
    const read = jest.fn(f.input.readView.resolveReferences);
    const result = await diagnoseConclusionDraft({...input, readView: {...f.input.readView, resolveReferences: read}});
    expect(result).toEqual({diagnosticOnly: true, coverageNotChecked: true, finalCertification: false,
      state: 'invalid_input', reason: 'input_budget_or_body_invalid', inputBudget: {
        bodyBytes: Buffer.byteLength(input.body, 'utf8'), declarationBytes: Buffer.byteLength(input.declarationJson, 'utf8'),
        maxBytes: DRAFT_DECLARATION_MAX_BYTES, emptyBody: !input.body.trim(),
      }});
    expect(read).not.toHaveBeenCalled();
  });
  it('reports repeated and nonexistent quotes, accepting explicit zero-based occurrences', async () => {
    const f = fixture(); const body = 'Elapsed 7.1 ms. Again 7.1 ms.';
    expect(await diagnoseConclusionDraft({...f.input, body})).toMatchObject({diagnostics: [{
      presentationReason: 'quote_unresolved', quoteOccurrences: [{quoteIndex: 0, exactSubstringOccurrences: 2}]}]});
    f.contract.claims[0].semantics.numeric.presentation.quotes = [{text: '7.1 ms', occurrence: 0}, {text: '7.1 ms', occurrence: 1}];
    expect(await diagnoseConclusionDraft({...f.input, body, declarationJson: JSON.stringify(f.contract)})).toMatchObject({
      diagnostics: [{presentationReason: 'display_matches'}]});
    expect(await diagnoseConclusionDraft({...f.input, body: 'No numeric literal.'})).toMatchObject({diagnostics: [{
      presentationReason: 'quote_unresolved', quoteOccurrences: [{exactSubstringOccurrences: 0}]}]});
  });
  it.each([{viewRun: 'other-run'}, {viewSession: 'other-session'}])('rejects a mismatched read context: %j', async settings => {
    expect(await diagnoseConclusionDraft(fixture(settings).input)).toMatchObject({state: 'unavailable', reason: 'read_context_mismatch'});
  });
  it('respects allowed traces and existing read budgets', async () => {
    for (const settings of [{trace: 'other-trace'}, {budget: 0}]) {
      const result = await diagnoseConclusionDraft(fixture(settings).input);
      expect(result).toMatchObject({diagnostics: [{producerUnits: [], referenceReasons: expect.not.arrayContaining(['matched'])}]});
      expect(JSON.stringify(result)).not.toContain('numeric_operator_proved');
    }
  });
  it('propagates authorization revocation after an asynchronous read', async () => {
    const f = fixture(); let checks = 0;
    const assertCurrent = () => {if (++checks === 2) throw new Error('authorization_revoked');};
    await expect(diagnoseConclusionDraft({...f.input, assertCurrent})).rejects.toThrow('authorization_revoked');
  });
  it('stops when cancellation arrives during the existing-evidence read', async () => {
    const f = fixture(); const controller = new AbortController();
    const readView = {investigationEvidence: f.input.readView.investigationEvidence,
      resolveReferences: async (...args: Parameters<typeof f.input.readView.resolveReferences>) => {
        controller.abort(); return f.input.readView.resolveReferences(...args);
      }};
    expect(await diagnoseConclusionDraft({...f.input, readView, signal: controller.signal}))
      .toMatchObject({state: 'unavailable', reason: 'cancelled'});
  });
  it('does not certify semantic meaning or omissions when finite bindings match', async () => {
    const f = fixture();
    const result = await diagnoseConclusionDraft({...f.input, body: 'Thermal throttling caused 7.1 ms. Original classification warm.'});
    expect(result).toMatchObject({coverageNotChecked: true, finalCertification: false,
      diagnostics: [{finiteReason: 'numeric_operator_proved', presentationReason: 'display_matches'}]});
  });
  it('refuses missing context, cancellation, invalid JSON and input budgets explicitly', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect(await diagnoseConclusionDraft({...f.input, runId: undefined})).toMatchObject({reason: 'run_context_missing'});
    expect(await diagnoseConclusionDraft({...f.input, readView: undefined})).toMatchObject({reason: 'evidence_store_missing'});
    expect(await diagnoseConclusionDraft({...f.input, signal: controller.signal})).toMatchObject({reason: 'cancelled'});
    expect(await diagnoseConclusionDraft({...f.input, declarationJson: '{} trailing'})).toMatchObject({reason: 'invalid_json'});
    expect(await diagnoseConclusionDraft({...f.input, declarationJson: '{}'})).toMatchObject({reason: 'invalid_declaration'});
    expect(await diagnoseConclusionDraft({...f.input, body: '汉'.repeat(DRAFT_DECLARATION_MAX_BYTES)}))
      .toMatchObject({reason: 'input_budget_or_body_invalid'});
  });
  it.each([{}, [], null, 42, undefined])('rejects unexpected input types without crashing: %j', async invalid => {
    const f = fixture();
    for (const field of ['body', 'declarationJson']) {
      expect(await diagnoseConclusionDraft({...f.input, [field]: invalid}))
        .toMatchObject({state: 'invalid_input', reason: 'input_type_invalid', finalCertification: false});
    }
  });
});
