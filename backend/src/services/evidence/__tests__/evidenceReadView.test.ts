// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {ArtifactStore, EVIDENCE_RETENTION_CELLS_ENV} from '../../../agentv3/artifactStore';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {captureEvidenceTable, captureRawSqlEvidence, evidenceTableFor, getCapturedAnchorFacts, type CapturedFieldSemantics} from '../evidenceCapture';
import * as runtimeIdentity from '../../capabilityManifestRuntimeIdentity';
import * as sqlDocs from '../../perfettoSqlDocs';
import {beginRawSqlNativeQuery, createRawSqlNativeProvenance, initializeRawSqlNativeProvenance,
  sealRawSqlNativeQuery, readRawSqlCaptureFields} from '../rawSqlNativeProvenance';
import {runDeterministicClaimVerifier} from '../../verifier/deterministicClaimVerifier';
import {SkillExecutor} from '../../skillEngine/skillExecutor';
import {prepareClaimEvidence, preparedClaimEvidenceSnapshot, preparedEvidenceMatchesInput, evidenceReferenceKey,
  preparedIdentityResolutions, type PreparedClaimEvidence} from '../claimEvidencePreparation';
import {bindReadResolutionToAnchor, evidenceReadFailureIsUnreadable, isIssuedEvidenceReadResolution, type EvidenceReadView, type EvidenceReadViewOptions} from '../evidenceReadView';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {runClaimVerification, collectVerifiedTraceOccurrenceRefIdsByClaimId} from '../../verifier/claimVerificationRunner';
import type {ConclusionContract, ConclusionContractClaimReference} from '../../../agent/core/conclusionContract';
import type {EvidenceScopeProvenanceV1, IdentityResolutionV1} from '../../../types/identityContract';
import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {capturedIdentityReadRequests} from '../../processIdentity/capturedIdentity';

const readOptions: EvidenceReadViewOptions = {ownerKey: 'run:workspace:tenant', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]};
const field: CapturedFieldSemantics = {unit: 'ms', origin: {kind: 'skill_literal', skillId: 'fixture', stepId: 'table',
  definitionFingerprint: 'declared-skill', selectedSqlHash: 'executed-sql'}};
const identity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: 'identity:42', status: 'verified',
  target: {traceId: 'trace', traceSide: 'current', upid: 42, source: 'skill_param'},
  processes: [{upid: 42, processName: 'example', confidence: 1, matchSources: ['upid']}], threads: [], warnings: []};
const targetScope: EvidenceScopeProvenanceV1 = {version: 'process_scope_evidence@1', entries: [{role: 'target',
  scope: {mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 42, identityRefId: identity.identityRefId}}]};

function add(store: ArtifactStore, data = {columns: ['id', 'metric'], rows: [[1, 2]] as unknown[][]},
  options: {title?: string; evidenceRefId?: string; scope?: EvidenceScopeProvenanceV1; identity?: IdentityResolutionV1;
    fields?: Record<string, CapturedFieldSemantics>} = {}) {
  const witness = captureEvidenceTable(data, options.fields || {metric: field});
  const id = store.store({skillId: 'fixture', stepId: 'table', title: options.title || 'Table', data,
    sourceToolCallId: `invoke:${options.evidenceRefId || 'table'}`, traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'}),
    scopeProvenance: options.scope || targetScope, identityResolution: options.identity || identity});
  const evidenceRefId = options.evidenceRefId || `evidence:${id}`;
  store.registerEvidenceCapture(id, witness, {evidenceRefId, queryHash: 'executed-sql'});
  return {id, evidenceRefId, witness};
}
const read = (view: EvidenceReadView, reference: ConclusionContractClaimReference) => view.resolveReferences([
  {key: evidenceReferenceKey(reference), reference, requiredColumns: reference.column ? [reference.column] : []},
]);
function contract(reference: ConclusionContractClaimReference): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
    uncertainties: [], nextSteps: [], bindingEligibility: 'eligible', claims: [{id: 'metric', kind: 'numeric', text: 'Metric is 2000 us',
      references: [reference], semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [reference]},
        numeric: {operator: 'eq', value: 2000, unit: 'us'}}}]};
}

describe('runtime execution evidence read view', () => {
  it('reads identity metadata with no row/cell budget and cannot bind it as a cell proof', async () => {
    const store = new ArtifactStore(); const {id} = add(store);
    const view = store.createEvidenceReadView({...readOptions, budget: {maxCells: 0}});
    const [metadata] = await view.resolveReferences([{key: 'identity-only', reference: {artifactId: id}, requiredColumns: [], metadataOnly: true}]);
    expect(metadata).toMatchObject({status: 'resolved', record: {meta: {identityResolution: identity}}});
    expect(isIssuedEvidenceReadResolution(metadata)).toBe(true);
    expect(metadata).not.toHaveProperty('row');
    expect(metadata).not.toHaveProperty('originalRowIndex');
    const anchor = {};
    bindReadResolutionToAnchor(anchor, metadata);
    expect(getCapturedAnchorFacts(anchor)).toBeUndefined();
    expect((await read(view, {artifactId: id}))[0].status).toBe('incomplete');
  });

  it.each([{rowIndex: 0}, {rowSelector: {id: 1}}, {column: 'metric'}, {value: 2}] as ConclusionContractClaimReference[])(
    'rejects a metadata lookup mixed with a cell locator: %j', fields => {
      const store = new ArtifactStore(); const {id} = add(store);
      return expect(store.createEvidenceReadView(readOptions).resolveReferences([
        {key: 'identity-only', reference: {artifactId: id, ...fields}, requiredColumns: [], metadataOnly: true},
      ])).resolves.toMatchObject([{status: 'missing', reason: 'invalid_metadata_locator'}]);
    },
  );

  it('rejects required columns for metadata reads and retains trace/byte/deadline fences', async () => {
    const store = new ArtifactStore(); const {id} = add(store);
    const request = {key: 'identity-only', reference: {artifactId: id}, requiredColumns: [], metadataOnly: true as const};
    expect(await store.createEvidenceReadView(readOptions).resolveReferences([{...request, requiredColumns: ['metric']}]))
      .toMatchObject([{status: 'missing', reason: 'invalid_metadata_locator'}]);
    for (const budget of [{maxBytes: 0}, {maxElapsedMs: 0}, {maxReferences: 0}]) {
      expect(await store.createEvidenceReadView({...readOptions, budget}).resolveReferences([request]))
        .toMatchObject([{status: 'incomplete'}]);
    }
    expect(await store.createEvidenceReadView({...readOptions, allowedTraces: [{traceId: 'other', traceSide: 'current'}]})
      .resolveReferences([request])).toMatchObject([{status: 'denied', reason: 'trace_outside_read_scope'}]);
  });

  it('captures actual Skill primitives before formatting and only literal declared units', async () => {
    const originalText = 'trace-cell-'.repeat(400);
    const executor = new SkillExecutor({query: async () => ({columns: ['metric', 'inferred_ms', 'flag', 'empty', 'text'],
      rows: [[2, 2, true, null, originalText]], durationMs: 1})});
    executor.registerSkill({name: 'capture_fixture', version: '1', type: 'atomic',
      meta: {display_name: 'Captured fixture', description: 'Raw evidence capture'},
      process_scope: {role: 'global_context'}, sql: 'SELECT actual_fields FROM source_table',
      output: {display: {layer: 'overview', level: 'summary', format: 'table', columns: [
        {name: 'metric', type: 'duration', unit: 'ms'}, {name: 'inferred_ms', type: 'duration', format: 'duration_ms'},
        {name: 'flag', type: 'boolean'}, {name: 'empty', type: 'string'}, {name: 'text', type: 'string'},
      ]}}});
    const result = await executor.execute('capture_fixture', 'trace');
    expect(result.success).toBe(true);
    const display = result.displayResults[0];
    expect(display.data.rows?.[0][2]).not.toBe(true);
    expect(display.data.rows?.[0][3]).not.toBeNull();
    const store = new ArtifactStore();
    const id = store.store({skillId: result.skillId, data: display.data, scopeProvenance: display.scopeProvenance,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'}), sourceToolCallId: 'invoke:capture'});
    expect(store.registerEvidenceCapture(id, evidenceTableFor(display)!, {evidenceRefId: 'captured-fixture'})).toBe(true);
    const view = store.createEvidenceReadView(readOptions);
    const [raw] = await read(view, {artifactId: id, rowIndex: 0});
    expect(raw).toMatchObject({status: 'resolved', row: {metric: 2, inferred_ms: 2, flag: true, empty: null, text: originalText}});
    for (const [column, proofStatus] of [['metric', 'proved'], ['inferred_ms', 'candidate']]) {
      const conclusionContract = contract({artifactId: id, rowIndex: 0, column, value: 2});
      const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: view});
      expect(runClaimVerification({conclusionContract, preparedEvidence}).claimVerificationResult.claimResults[0].deterministicProof?.status)
        .toBe(proofStatus);
    }
  });

  it.each([49, 50, 499, 500, 5001])('reads absolute original row %i beyond preview caps', async rowIndex => {
    const store = new ArtifactStore();
    const {id} = add(store, {columns: ['id', 'metric'], rows: Array.from({length: 5002}, (_, index) => [index, index + 1])});
    const [result] = await read(store.createEvidenceReadView(readOptions), {artifactId: id, rowIndex, column: 'metric'});
    expect(result).toMatchObject({status: 'resolved', originalRowIndex: rowIndex, row: {metric: rowIndex + 1}});
  });

  it('establishes record identity before looking for a matching row', async () => {
    const store = new ArtifactStore();
    const first = add(store, undefined, {title: 'Same', evidenceRefId: 'first'});
    const second = add(store, {columns: ['id', 'metric'], rows: [[2, 3]]}, {title: 'Same', evidenceRefId: 'second'});
    const view = store.createEvidenceReadView(readOptions);
    expect((await read(view, {sourceRef: 'Same', rowSelector: {id: 2}, column: 'metric'}))[0].status).toBe('ambiguous');
    for (const reference of [{artifactId: first.id, evidenceRefId: second.evidenceRefId},
      {artifactId: first.id, sourceToolCallId: 'invoke:second'}, {artifactId: first.id, sourceArtifactId: second.id}]) {
      expect((await read(view, reference))[0]).toMatchObject({status: 'missing', reason: 'identifier_conflict'});
    }
    // Repair hints name identifier fields only, never values.
    const [conflict] = await read(view, {artifactId: first.id, sourceToolCallId: 'invoke:second', evidenceRefId: first.evidenceRefId});
    expect(conflict).toMatchObject({locatorDetail: {matchedFields: ['evidenceRefId', 'artifactId'], conflictingFields: ['sourceToolCallId']}});
    expect(JSON.stringify(conflict)).not.toContain('invoke:second');
  });

  it('reports available columns and row count for locator repairs without cell values', async () => {
    const store = new ArtifactStore();
    const {id} = add(store, {columns: ['id', 'metric'], rows: [[1, 2], [2, 3]]});
    const view = store.createEvidenceReadView(readOptions);
    const [column] = await read(view, {artifactId: id, rowIndex: 0, column: 'end_ns'});
    expect(column).toMatchObject({reason: 'required_column_missing', locatorDetail: {availableColumns: ['id', 'metric']}});
    const [row] = await read(view, {artifactId: id, rowIndex: 7, column: 'metric'});
    expect(row).toMatchObject({reason: 'row_index_out_of_range', locatorDetail: {rowCount: 2}});
  });

  it('requires a complete unique selector scan and agreement with any row index', async () => {
    const store = new ArtifactStore();
    const {id} = add(store, {columns: ['id', 'metric'], rows: [[1, 2], [2, 3], [3, 4], [1, 9]]});
    const limited = store.createEvidenceReadView({...readOptions, budget: {maxScannedRows: 2}});
    expect((await read(limited, {artifactId: id, rowSelector: {id: 1}, column: 'metric'}))[0].status).toBe('incomplete');
    const view = store.createEvidenceReadView(readOptions);
    expect((await read(view, {artifactId: id, rowSelector: {id: 1}}))[0].status).toBe('ambiguous');
    expect((await read(view, {artifactId: id, rowIndex: 0, rowSelector: {id: 2}}))[0])
      .toMatchObject({status: 'missing', reason: 'row_index_selector_conflict'});
    expect((await read(view, {artifactId: id, rowSelector: {id: '2'}}))[0].status).toBe('missing');
  });

  it('rejects duplicate columns, denied traces and exhausted cell/deadline budgets', async () => {
    const duplicates = new ArtifactStore();
    const duplicate = add(duplicates, {columns: ['metric', 'metric'], rows: [[1, 2]]});
    expect((await read(duplicates.createEvidenceReadView(readOptions), {artifactId: duplicate.id, rowIndex: 0, column: 'metric'}))[0].status).toBe('ambiguous');
    const store = new ArtifactStore(); const {id} = add(store);
    const ref = {artifactId: id, rowIndex: 0, column: 'metric'};
    expect((await read(store.createEvidenceReadView({...readOptions, allowedTraces: [{traceId: 'other', traceSide: 'current'}]}), ref))[0].status).toBe('denied');
    expect((await read(store.createEvidenceReadView({...readOptions, budget: {maxCells: 0}}), ref))[0].status).toBe('incomplete');
    expect((await read(store.createEvidenceReadView({...readOptions, budget: {maxElapsedMs: 0}}), ref))[0].status).toBe('incomplete');
    expect((await read(store.createEvidenceReadView({...readOptions, budget: {maxBytes: 0}}), ref))[0].status).toBe('incomplete');
  });

  it('reports a condition-skipped step as not observed with its own reason', async () => {
    const statusRead = async (executionStatus: 'skipped' | 'unavailable', witnessReason?: string) => {
      const store = new ArtifactStore();
      const data = {columns: ['id', 'metric'], rows: [[1, 2]] as unknown[][]};
      const id = store.store({skillId: 'fixture', stepId: 'table', title: 'Table', data, executionStatus,
        sourceToolCallId: 'invoke:table', traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'}),
        scopeProvenance: targetScope, identityResolution: identity});
      store.registerEvidenceCapture(id, captureEvidenceTable(witnessReason ? undefined : data, {metric: field}, witnessReason),
        {evidenceRefId: `evidence:${id}`});
      return (await read(store.createEvidenceReadView(readOptions), {artifactId: id, rowIndex: 0, column: 'metric'}))[0];
    };
    expect(await statusRead('skipped')).toMatchObject({status: 'missing', reason: 'execution_skipped'});
    // The witness a skipped DisplayResult actually carries yields the same reason.
    expect(await statusRead('skipped', 'execution_skipped')).toMatchObject({status: 'missing', reason: 'execution_skipped'});
    expect(await statusRead('unavailable')).toMatchObject({status: 'missing', reason: 'execution_unavailable'});
    // Nothing was captured, so a claim citing it stays unverified rather than contradicted.
    expect(evidenceReadFailureIsUnreadable('execution_skipped')).toBe(true);
    expect(evidenceReadFailureIsUnreadable('execution_unavailable')).toBe(false);
  });

  it('binds the capture generation set when the view is created and still observes eviction', async () => {
    // The payload cache and the witness ledger are separate budgets now, so the
    // eviction observed through the old view is the ledger's own. Each fixture
    // capture is one 2-column row, so a 4-cell budget holds exactly two.
    process.env[EVIDENCE_RETENTION_CELLS_ENV] = '4';
    try {
      const store = new ArtifactStore(2);
      const first = add(store, undefined, {evidenceRefId: 'first'});
      const old = store.createEvidenceReadView(readOptions);
      await Promise.resolve();
      const second = add(store, undefined, {evidenceRefId: 'second'});
      expect((await read(old, {artifactId: first.id}))[0].status).toBe('resolved');
      expect((await read(old, {artifactId: second.id}))[0].status).toBe('missing');
      add(store, undefined, {evidenceRefId: 'third'});
      expect((await read(old, {artifactId: first.id}))[0].status).toBe('missing');
    } finally {
      delete process.env[EVIDENCE_RETENTION_CELLS_ENV];
    }
  });

  it('revokes every captured record on clear and cannot restore or reuse its read authority', async () => {
    const store = new ArtifactStore();
    const first = add(store, undefined, {evidenceRefId: 'before-clear'});
    const old = store.createEvidenceReadView(readOptions);
    const [original] = await read(old, {artifactId: first.id});
    expect(original.status).toBe('resolved');
    if (original.status !== 'resolved') throw new Error('Expected the original runtime capture');
    store.registerStandaloneEvidenceCapture(first.witness, {meta: {...original.record.meta,
      artifactId: undefined, sourceArtifactId: undefined, evidenceRefId: 'standalone-before-clear'}, display: original.record.display});
    const beforeClear = store.createEvidenceReadView(readOptions);
    const snapshot = structuredClone(store.serialize());
    store.clear();
    for (const view of [old, beforeClear, store.createEvidenceReadView(readOptions),
      ArtifactStore.fromSnapshot(snapshot).createEvidenceReadView(readOptions)]) {
      expect((await read(view, {evidenceRefId: 'before-clear'}))[0].status).toBe('missing');
      expect((await read(view, {evidenceRefId: 'standalone-before-clear'}))[0].status).toBe('missing');
    }
    const next = add(store, {columns: ['id', 'metric'], rows: [[1, 8]]}, {evidenceRefId: 'before-clear'});
    expect(next.id).toBe(first.id);
    expect((await read(old, {artifactId: first.id}))[0].status).toBe('missing');
    const [fresh] = await read(store.createEvidenceReadView(readOptions), {artifactId: next.id, rowIndex: 0, column: 'metric'});
    expect(fresh).toMatchObject({status: 'resolved', row: {metric: 8}});
    if (fresh.status === 'resolved') expect(fresh.record.generation).toBeGreaterThan(original.record.generation);
  });

  it('preserves original null, booleans and long strings despite producer/display/read mutation', async () => {
    const store = new ArtifactStore();
    const long = 'raw'.repeat(1000);
    const data = {columns: ['metric', 'flag', 'empty', 'text', 'complex'], rows: [[2, true, null, long, {not: 'scalar'}]]};
    const {id, witness} = add(store, data);
    expect(store.registerEvidenceCapture(id, JSON.parse(JSON.stringify(witness)), {evidenceRefId: 'forged'})).toBe(false);
    data.rows[0][0] = 999;
    store.get(id)!.data.rows[0] = ['formatted', '是', '', long.slice(0, 20), '{}'];
    const view = store.createEvidenceReadView(readOptions);
    for (const [column, expected] of [['metric', 2], ['flag', true], ['empty', null], ['text', long]]) {
      const [result] = await read(view, {artifactId: id, rowIndex: 0, column: String(column)});
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') {
        expect(result.row?.[String(column)]).toBe(expected);
        expect(() => { (result.row as Record<string, unknown>).metric = 4; }).toThrow();
      }
    }
    expect((await read(view, {artifactId: id, rowIndex: 0, column: 'complex'}))[0].status).toBe('missing');
    const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
    expect((await read(restored.createEvidenceReadView(readOptions), {artifactId: id, rowIndex: 0}))[0].status).toBe('missing');
  });

  it('prepares once, keeps the original target identity, and only produces a deterministic draft', async () => {
    const store = new ArtifactStore(); const {id} = add(store);
    const ref = {artifactId: id, rowIndex: 0, column: 'metric', value: 2};
    const conclusionContract = contract(ref);
    const actualView = store.createEvidenceReadView(readOptions);
    const resolveReferences = jest.fn(actualView.resolveReferences);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: {resolveReferences}});
    const output = runClaimVerification({conclusionContract, preparedEvidence});
    expect(resolveReferences).toHaveBeenCalledTimes(1);
    expect(resolveReferences.mock.calls[0][0]).toHaveLength(1);
    const anchor = output.evidenceContract.anchors[0];
    expect(anchor.identity).toMatchObject({status: 'verified', identityRefId: identity.identityRefId});
    expect(anchor.scopeProvenance?.entries[0].scope.upid).toBe(42);
    expect(getCapturedAnchorFacts(anchor)?.row.metric).toBe(2);
    expect(output.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', status: 'partial', passed: false});
    expect(output.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status: 'proved', kind: 'numeric_cell'});
    expect(collectVerifiedTraceOccurrenceRefIdsByClaimId(output.claimVerificationResult)).toEqual({});
    const snapshot = preparedClaimEvidenceSnapshot(preparedEvidence);
    expect(JSON.parse(JSON.stringify(snapshot)).reads).toHaveLength(1);
    expect(buildEvidenceContract({conclusionContract, preparedEvidence: JSON.parse(JSON.stringify(preparedEvidence)) as PreparedClaimEvidence})
      .anchors.every(item => item.missing)).toBe(true);
    conclusionContract.claims![0].references[0].rowIndex = 3;
    expect(buildEvidenceContract({conclusionContract, preparedEvidence}).anchors.every(item => item.missing)).toBe(true);
  });

  it('binds preparation to the declaration before an asynchronous read begins', async () => {
    const store = new ArtifactStore(); const {id} = add(store);
    const conclusionContract = contract({artifactId: id, rowIndex: 0, column: 'metric', value: 2});
    const original = structuredClone(conclusionContract);
    const actual = store.createEvidenceReadView(readOptions);
    let resume: () => void = () => { throw new Error('Read barrier was not initialized'); };
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const preparedPromise = prepareClaimEvidence({conclusionContract, evidenceReadView: {
      resolveReferences: async (requests, signal) => { await barrier; return actual.resolveReferences(requests, signal); },
    }});
    conclusionContract.claims![0].semantics!.numeric!.value = 9000;
    resume();
    const preparedEvidence = await preparedPromise;
    expect(preparedEvidenceMatchesInput(preparedEvidence, original, undefined)).toBe(true);
    expect(preparedEvidenceMatchesInput(preparedEvidence, conclusionContract, undefined)).toBe(false);
    expect(buildEvidenceContract({conclusionContract, preparedEvidence}).anchors.every(anchor => anchor.missing)).toBe(true);
    expect(runClaimVerification({conclusionContract: original, preparedEvidence}).claimVerificationResult.claimResults[0]
      .deterministicProof?.status).toBe('proved');
  });

  it.each(['invalid', 'conflict', 'global'] as const)('does not lend target verification to %s captured field scope', async kind => {
    const store = new ArtifactStore();
    const scope: EvidenceScopeProvenanceV1 = kind === 'invalid' ? {version: 'process_scope_evidence@1', entries: [], invalid: true}
      : kind === 'global' ? {version: 'process_scope_evidence@1', entries: [{role: 'global_context', fields: ['metric'],
        scope: {mode: 'unscoped', traceId: 'trace', traceSide: 'current'}}]} : targetScope;
    const wrongIdentity = {...identity, status: 'ambiguous' as const};
    const {id} = add(store, undefined, {scope, ...(kind === 'conflict' ? {identity: wrongIdentity} : {})});
    const conclusionContract = contract({artifactId: id, rowIndex: 0, column: 'metric', value: 2});
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: store.createEvidenceReadView(readOptions)});
    const anchor = buildEvidenceContract({conclusionContract, preparedEvidence}).anchors[0];
    expect(anchor.identity?.status).not.toBe('verified');
    if (kind !== 'global') expect(anchor.missing).toBe(true);
  });

  it('does not read or bind any positive reference for invalid machine declarations', async () => {
    const conclusionContract = contract({artifactId: 'art-1', rowIndex: 0, column: 'metric'});
    const resolveReferences = jest.fn(async () => []);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, bindingEligibility: 'ineligible', evidenceReadView: {resolveReferences}});
    expect(resolveReferences).not.toHaveBeenCalled();
    expect(buildEvidenceContract({conclusionContract, preparedEvidence}).anchors.every(anchor => anchor.missing)).toBe(true);
  });
});

describe('prepared captured identity projection', () => {
  function envelope(store: ArtifactStore, name = 'first', candidate = identity,
    scope: EvidenceScopeProvenanceV1 | undefined = targetScope): DataEnvelope {
    const value = createDataEnvelope({columns: ['metric'], rows: [[2]]}, {type: 'sql_result', source: 'execute_sql',
      title: name, evidenceRefId: `data:${name}`, traceId: 'trace', traceSide: 'current',
      identityResolution: candidate, identityRefId: candidate.identityRefId, identityStatus: candidate.status,
      identityWarnings: candidate.warnings, scopeProvenance: scope});
    store.registerStandaloneEvidenceCapture(captureEvidenceTable(value.data, {metric: field}), {meta: value.meta, display: value.display});
    return value;
  }

  it('reads captured identities without a claim declaration and ignores forged display identity', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    display.meta.identityResolution = {...identity, identityRefId: 'FORGED', status: 'verified', target: {...identity.target, upid: 999}};
    const actual = store.createEvidenceReadView(readOptions);
    const resolveReferences = jest.fn(actual.resolveReferences);
    const prepared = await prepareClaimEvidence({identityDataEnvelopes: [display, structuredClone(display)],
      identityTracePin: {currentTraceId: 'trace'}, evidenceReadView: {resolveReferences}});
    expect(resolveReferences).toHaveBeenCalledTimes(1);
    expect(resolveReferences.mock.calls[0][0]).toMatchObject([{metadataOnly: true, reference: {evidenceRefId: 'data:first'}}]);
    expect(preparedIdentityResolutions(prepared)).toEqual([identity]);
    const projected = preparedIdentityResolutions(prepared); projected[0].status = 'error';
    expect(preparedIdentityResolutions(prepared)).toEqual([identity]);
    expect(preparedIdentityResolutions(structuredClone(prepared))).toEqual([]);
    expect(preparedIdentityResolutions(preparedClaimEvidenceSnapshot(prepared) as unknown as PreparedClaimEvidence)).toEqual([]);
  });

  it('keeps metadata identity reads separate from ineligible claim references', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const conclusionContract = contract({evidenceRefId: 'data:first', rowIndex: 0, column: 'metric', value: 2});
    const actual = store.createEvidenceReadView(readOptions);
    const resolveReferences = jest.fn(actual.resolveReferences);
    const prepared = await prepareClaimEvidence({conclusionContract, bindingEligibility: 'ineligible',
      identityDataEnvelopes: [display], identityTracePin: {currentTraceId: 'trace'}, evidenceReadView: {resolveReferences}});
    expect(resolveReferences).toHaveBeenCalledTimes(1);
    expect(resolveReferences.mock.calls[0][0]).toHaveLength(1);
    expect(resolveReferences.mock.calls[0][0][0]).toMatchObject({metadataOnly: true});
    expect(preparedIdentityResolutions(prepared)).toEqual([identity]);
    const checked = runClaimVerification({conclusionContract, preparedEvidence: prepared});
    expect(checked.evidenceContract.anchors.every(anchor => anchor.missing)).toBe(true);
    expect(checked.claimVerificationResult.claimResults[0].deterministicProof?.status).not.toBe('proved');
  });

  it('prioritizes claim proof in the same batch and leaves an incomplete identity scan unknown', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const conclusionContract = contract({evidenceRefId: 'data:first', rowIndex: 0, column: 'metric', value: 2});
    const view = store.createEvidenceReadView({...readOptions, budget: {maxReferences: 1}});
    const resolveReferences = jest.fn(view.resolveReferences);
    const prepared = await prepareClaimEvidence({conclusionContract, identityDataEnvelopes: [display],
      identityTracePin: {currentTraceId: 'trace'}, evidenceReadView: {resolveReferences}});
    expect(resolveReferences).toHaveBeenCalledTimes(1);
    expect(resolveReferences.mock.calls[0][0].map(request => request.metadataOnly)).toEqual([undefined, true]);
    const checked = runClaimVerification({conclusionContract, preparedEvidence: prepared});
    expect(checked.evidenceContract.anchors[0].missing).not.toBe(true);
    expect(getCapturedAnchorFacts(checked.evidenceContract.anchors[0])?.row.metric).toBe(2);
    expect(checked.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({kind: 'numeric_cell', status: 'proved'});
    expect(preparedIdentityResolutions(prepared)).toEqual([]);
  });

  it('never restores identity authority from serialized read replies', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const view = store.createEvidenceReadView(readOptions);
    const prepared = await prepareClaimEvidence({identityDataEnvelopes: [display], identityTracePin: {currentTraceId: 'trace'},
      evidenceReadView: {resolveReferences: async (requests, signal) => structuredClone(await view.resolveReferences(requests, signal))}});
    expect(preparedIdentityResolutions(prepared)).toEqual([]);
  });

  it('does not expose issued identities returned after the read was cancelled', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const view = store.createEvidenceReadView(readOptions); const controller = new AbortController();
    const prepared = await prepareClaimEvidence({identityDataEnvelopes: [display], identityTracePin: {currentTraceId: 'trace'},
      signal: controller.signal, evidenceReadView: {resolveReferences: async (requests, signal) => {
        const received = await view.resolveReferences(requests, signal); controller.abort(); return received;
      }}});
    expect(preparedIdentityResolutions(prepared)).toEqual([]);
  });

  it('retains unsuccessful captured states and rejects conflicting same-ID records in either order', async () => {
    const store = new ArtifactStore(); const ambiguous = {...identity, status: 'ambiguous' as const};
    const first = envelope(store, 'one', ambiguous);
    const view = () => store.createEvidenceReadView(readOptions);
    const one = await prepareClaimEvidence({identityDataEnvelopes: [first], identityTracePin: {currentTraceId: 'trace'}, evidenceReadView: view()});
    expect(preparedIdentityResolutions(one)).toEqual([ambiguous]);
    const second = envelope(store, 'two', identity);
    for (const displays of [[first, second], [second, first]]) {
      const prepared = await prepareClaimEvidence({identityDataEnvelopes: displays, identityTracePin: {currentTraceId: 'trace'}, evidenceReadView: view()});
      expect(preparedIdentityResolutions(prepared)).toEqual([]);
    }
  });

  it('deduplicates matching captured identities across different locators', async () => {
    const store = new ArtifactStore(); const first = envelope(store, 'one'); const second = envelope(store, 'two');
    const prepared = await prepareClaimEvidence({identityDataEnvelopes: [second, first], identityTracePin: {currentTraceId: 'trace'},
      evidenceReadView: store.createEvidenceReadView(readOptions)});
    expect(preparedIdentityResolutions(prepared)).toEqual([identity]);
  });

  it('pins the expected trace before an asynchronous reader can change caller input', async () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const pin = {currentTraceId: 'foreign'};
    const view = store.createEvidenceReadView(readOptions);
    const prepared = await prepareClaimEvidence({identityDataEnvelopes: [display], identityTracePin: pin,
      evidenceReadView: {resolveReferences: async (requests, signal) => {
        pin.currentTraceId = 'trace'; return view.resolveReferences(requests, signal);
      }}});
    expect(preparedIdentityResolutions(prepared)).toEqual([]);
  });

  it('exposes only immutable metadata locators, without model-supplied scope/status/rows', () => {
    const store = new ArtifactStore(); const display = envelope(store);
    const [request] = capturedIdentityReadRequests([display]);
    expect(request).toEqual({key: expect.stringMatching(/^identity:/), reference: {evidenceRefId: 'data:first'}, requiredColumns: [], metadataOnly: true});
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.reference)).toBe(true);
  });
});


describe('native row companions in prepared evidence', () => {
  const revision = 'b'.repeat(40);
  beforeEach(() => {
    jest.spyOn(runtimeIdentity, 'resolveCapabilityTraceProcessorIdentity').mockResolvedValue({source: 'bundled', gitRevision: revision, stdlibRevision: revision});
    jest.spyOn(sqlDocs, 'loadPerfettoSqlDocsAsset').mockReturnValue({version: 1, generatedFrom: revision, modules: [], symbolToModule: {},
      entries: [{id: 'slice', name: 'slice', type: 'view', category: 'prelude', module: 'prelude.views', package: 'prelude', description: '',
        columns: [{name: 'id', type: 'ID'}, {name: 'dur', type: 'DURATION'}]}]});
  });
  afterEach(() => jest.restoreAllMocks());

  async function rawFixture(mode: 'raw' | 'generic' | 'copy' | 'wrong-trace' = 'raw') {
    const native = createRawSqlNativeProvenance('actual-instance', [], 'trace');
    await initializeRawSqlNativeProvenance(native.provenance, {source: 'local_binary', selectedPath: '/pinned/tp', selectionOrigin: 'default'});
    const data = {columns: ['event_id', 'dur'], rows: [[7, 42_000_000], [8, 42_000_000]]};
    sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, 'SELECT id AS event_id, dur FROM slice'), data);
    const witness = mode === 'generic' ? captureEvidenceTable({...data, nativeRows: [{id: 7}]}, readRawSqlCaptureFields(data)) :
      captureRawSqlEvidence(mode === 'copy' ? JSON.parse(JSON.stringify(data)) : data,
        {traceId: mode === 'wrong-trace' ? 'other' : 'trace', traceSide: 'current'});
    const store = new ArtifactStore();
    const id = store.store({skillId: 'execute_sql', data, traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'}),
      sourceToolCallId: 'native-invocation'});
    store.registerEvidenceCapture(id, witness, {evidenceRefId: 'native-result'});
    const ref = {evidenceRefId: 'native-result', rowIndex: 0, column: 'dur', value: 42_000_000};
    const declaration = contract(ref);
    declaration.claims![0].semantics!.numeric = {operator: 'eq', value: 42, unit: 'ms'};
    return {store, witness, ref, declaration};
  }

  it('retains the directly projected ID for a dur-only operand and binds the original capture', async () => {
    const {store, witness, ref, declaration} = await rawFixture();
    const view = store.createEvidenceReadView(readOptions);
    expect(await read(view, ref)).toMatchObject([{status: 'resolved', row: {event_id: 7, dur: 42_000_000}}]);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: declaration, evidenceReadView: view});
    const result = runClaimVerification({conclusionContract: declaration, preparedEvidence});
    const anchor = result.claimSupport[0].anchors[0];
    const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
    expect(proof).toMatchObject({kind: 'numeric_cell', status: 'proved', nativeRows: [{anchorId: anchor.anchorId,
      evidenceRefId: anchor.evidenceRefId, captureId: witness.captureId, traceId: 'trace', traceSide: 'current', relation: 'slice',
      idColumn: 'id', id: 7, schemaFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)}]});
    expect(anchor.context.captureId).toBe(witness.captureId);
    expect(anchor.cells).toHaveLength(1);
    expect(anchor.cells![0].column).toBe('dur');
    expect(getCapturedAnchorFacts(anchor)?.fields.dur).not.toHaveProperty('clock');
    expect(result.claimVerificationResult.passed).toBe(false);
    const copied = JSON.parse(JSON.stringify(result.claimSupport));
    expect(runDeterministicClaimVerifier({claimSupport: copied}).claimResults[0].deterministicProof.nativeRows).toBeUndefined();
  });

  it('charges ID cells, bytes and deadlines, while metadata-only reads have no row witness', async () => {
    const {store, ref} = await rawFixture();
    expect(await read(store.createEvidenceReadView({...readOptions, budget: {maxCells: 1}}), ref))
      .toMatchObject([{status: 'incomplete', reason: 'cell_read_budget_exhausted'}]);
    expect(await read(store.createEvidenceReadView({...readOptions, budget: {maxCells: 2}}), ref))
      .toMatchObject([{status: 'resolved'}]);
    for (const budget of [{maxBytes: 1}, {maxElapsedMs: 0}]) {
      expect(await read(store.createEvidenceReadView({...readOptions, budget}), ref)).toMatchObject([{status: 'incomplete'}]);
    }
    const [metadata] = await store.createEvidenceReadView({...readOptions, budget: {maxCells: 0}}).resolveReferences([
      {key: 'native-metadata', reference: {evidenceRefId: ref.evidenceRefId}, requiredColumns: [], metadataOnly: true},
    ]);
    const anchor = {context: {traceId: 'trace', traceSide: 'current'}};
    bindReadResolutionToAnchor(anchor, metadata);
    expect(metadata).toMatchObject({status: 'resolved'});
    expect(getCapturedAnchorFacts(anchor)).toBeUndefined();
    expect(anchor.context).not.toHaveProperty('captureId');
  });

  it.each(['generic', 'copy', 'wrong-trace'] as const)('does not sign native identity from %s captures', async mode => {
    const {store, declaration} = await rawFixture(mode);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: declaration,
      evidenceReadView: store.createEvidenceReadView(readOptions)});
    const proof = runClaimVerification({conclusionContract: declaration, preparedEvidence})
      .claimVerificationResult.claimResults[0].deterministicProof!;
    expect(proof.nativeRows).toBeUndefined();
    if (mode === 'copy') expect(proof.reason).toBe('unit_authority_unknown');
    if (mode === 'wrong-trace') expect(proof.reason).toBe('reference_cells_unresolved');
  });

  it('rejects a valid raw witness relabeled as another Trace after capture', async () => {
    const {witness} = await rawFixture();
    const store = new ArtifactStore();
    const id = store.store({skillId: 'execute_sql', data: {columns: ['event_id', 'dur'], rows: [[7, 42_000_000]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'other', traceSide: 'reference'}), sourceToolCallId: 'relabel'});
    store.registerEvidenceCapture(id, witness, {evidenceRefId: 'relabel'});
    const result = await read(store.createEvidenceReadView({ownerKey: 'other-run',
      allowedTraces: [{traceId: 'other', traceSide: 'reference'}]}), {evidenceRefId: 'relabel', rowIndex: 0, column: 'dur'});
    expect(result).toMatchObject([{status: 'denied', reason: 'trace_capture_mismatch'}]);
  });

  it.each(['wrong-trace', 'invalid-side', 'unsigned-custom'] as const)(
    'preserves captured.cell provenance through %s raw capture and artifact registration', async mode => {
      const native = createRawSqlNativeProvenance('cell-instance', [], 'trace-a');
      await initializeRawSqlNativeProvenance(native.provenance,
        {source: 'local_binary', selectedPath: '/pinned/tp', selectionOrigin: 'default'});
      const data = {columns: ['id', 'label'], rows: [[7, 'observed']]};
      if (mode !== 'unsigned-custom') {
        sealRawSqlNativeQuery(beginRawSqlNativeQuery(native.provenance, "SELECT id, 'observed' AS label FROM slice"), data);
      }
      const traceId = mode === 'wrong-trace' ? 'trace-b' : 'trace-a';
      const witness = captureRawSqlEvidence(data, {traceId,
        traceSide: (mode === 'invalid-side' ? 'invalid' : 'current') as 'current'});
      const store = new ArtifactStore();
      const id = store.store({skillId: 'execute_sql', data,
        traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'}), sourceToolCallId: 'cell-invocation'});
      store.registerEvidenceCapture(id, witness, {evidenceRefId: 'cell-result'});
      const ref = {evidenceRefId: 'cell-result', rowIndex: 0, column: 'label', value: 'observed'};
      const declaration = contract(ref);
      declaration.claims![0].kind = 'categorical';
      declaration.claims![0].semantics = {...declaration.claims![0].semantics!, predicate: 'captured.cell', numeric: undefined};
      const view = store.createEvidenceReadView({ownerKey: 'cell-run', allowedTraces: [{traceId, traceSide: 'current'}]});
      const preparedEvidence = await prepareClaimEvidence({conclusionContract: declaration, evidenceReadView: view});
      const result = runClaimVerification({conclusionContract: declaration, preparedEvidence});
      const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
      if (mode === 'unsigned-custom') {
        expect(proof).toMatchObject({kind: 'captured_cell', status: 'proved'});
        expect(proof.nativeRows).toBeUndefined();
      } else {
        expect(proof.status).not.toBe('proved');
        expect(proof.nativeRows).toBeUndefined();
        expect(await read(view, ref)).toMatchObject([{status: 'missing', reason: 'trace_capture_mismatch'}]);
        expect(result.claimSupport[0].anchors.every(anchor => getCapturedAnchorFacts(anchor) === undefined)).toBe(true);
      }
    },
  );

  it('includes only actual proof operands even when another referenced row has the target ID', async () => {
    const {store, declaration, ref} = await rawFixture();
    const other = {...ref, rowIndex: 1};
    declaration.claims![0].references!.push(other);
    declaration.claims![0].semantics!.scope.subjectRefs = [other];
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: declaration,
      evidenceReadView: store.createEvidenceReadView(readOptions)});
    const result = runClaimVerification({conclusionContract: declaration, preparedEvidence});
    expect(result.claimSupport[0].anchors).toHaveLength(2);
    const proof = result.claimVerificationResult.claimResults[0].deterministicProof!;
    expect(proof.status).toBe('proved');
    expect(proof.nativeRows?.map(row => row.id)).toEqual([8]);
    expect(proof.nativeRows?.[0].anchorId).toBe(result.claimSupport[0].anchors[1].anchorId);
  });
});
