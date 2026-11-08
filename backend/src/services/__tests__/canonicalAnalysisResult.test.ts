// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {renderConclusionContractSidecar, wrapConclusionContractSidecarPayload, parseConclusionContractDeclaration, type ConclusionContract,
  type ConclusionContractClaimItem, wrapConclusionAuthoringPayload} from '../../agent/core/conclusionContract';
import {deriveConclusionContract} from '../../agent/core/conclusionGenerator';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection, inspectCandidateProtocol,
  buildCandidateProtocolDiagnostic, sanitizeCandidateProtocolDiagnostic} from '../canonicalAnalysisResult';
import {assessFinalResultQualityAssessment} from '../finalResultQualityGate';
import {runClaimVerification} from '../verifier/claimVerificationRunner';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {runPreparedAnalysisClaimVerification} from '../evidence/analysisRelationPreparation';
import {projectConclusionProtocol} from '../security/conclusionProtocolProjection';
import {prepareClaimEvidence} from '../evidence/claimEvidencePreparation';

function declaration(value = 999): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
    evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'measured-duration', kind: 'numeric',
      text: `Measured duration is ${value} ms.`, references: [{evidenceRefId: 'data:duration', rowIndex: 0,
        column: 'dur_ms', value}]}]};
}

function result(conclusion: string): AnalysisResult {
  return {sessionId: 'canonical-session', success: true, findings: [], hypotheses: [], conclusion,
    confidence: 0.8, rounds: 1, totalDurationMs: 10};
}

function contextFor(source: AnalysisResult, status: AnalysisCompletion['status'] = 'completed',
  deliverable: 'answer' | 'report' = 'answer'): Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
  const acceptedCandidate = {candidateRef: 'native-a', runId: 'run-a', attemptId: 'attempt-a',
    conclusionFingerprint: analysisDeliveryFingerprint(source.conclusion)};
  return {entry: 'new_finalization', acceptedCandidate, outputOrigin: 'sdk_final',
    completion: {...acceptedCandidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-a',
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable, evidenceAccess: 'read_new'}};
}

describe('authoring wire and canonical privacy boundaries', () => {
  const authoring = (invalidReference = false) => {
    const full = declaration(33);
    const reference = {...full.claims![0].references[0], ...(invalidReference ? {unrecognized: 'PRIVATE_AUTHORING_RAW'} : {})};
    return {authoringVersion: 'conclusion_authoring@1', referenceDictionary: [reference],
      contract: {...full, claims: [{...full.claims![0], references: [{$ref: 0}]}]}};
  };

  it('strips a stray authoring v2 frame unparsed and stores nothing of it', () => {
    const raw = {authoringVersion: 'conclusion_authoring@2', referenceDictionary: [], contract: {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', claims: declaration(33).claims,
      uncertainties: [{text: '未证明因果。'}], nextSteps: [{text: '检查覆盖范围。'}]}};
    const native = `Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw), 'authoring_v2')}`;
    const source = result(native);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Body remains.\n');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toMatch(/referenceDictionary|conclusion_authoring@2|未证明因果/);
    const projected = projectConclusionProtocol(undefined, native).text;
    expect(projected).not.toContain('referenceDictionary');
    expect(projected).not.toContain('conclusion_authoring@2');
    expect(projected).toContain('Body remains.');
  });

  it.each([false, true])('never stores original wire or expanded data of a stray v1 frame (invalid=%s)', invalid => {
    const raw = authoring(invalid);
    const native = `Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw))}`;
    const source = result(native);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Body remains.\n');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toMatch(/referenceDictionary|PRIVATE_AUTHORING_RAW|data:duration/);
    const projected = projectConclusionProtocol(undefined, native).text;
    expect(projected).not.toContain('referenceDictionary');
    expect(projected).not.toContain('PRIVATE_AUTHORING_RAW');
    expect(projected).not.toContain('smartperfetto-conclusion-authoring');
  });

  it('strips an undecodable frame without deriving replacement claims from prose', () => {
    const raw = {...authoring(), referenceDictionary: {bad: 'PRIVATE_AUTHORING_BAD_DICTIONARY'}};
    const source = result(`Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw))}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Body remains.\n');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toContain('PRIVATE_AUTHORING_BAD_DICTIONARY');
  });
});

const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Which trace?"} -->';



describe('canonical analysis result projection', () => {
  it('quarantines a malformed reserved declaration without supplying claims or authorizing its raw payload', () => {
    const payload = declaration();
    const raw = `Visible body.\n<!-- smartperfetto:conclusion_contract@1\n${JSON.stringify(payload)}\n-->`;
    const source = result(raw);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Visible body.\n');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.result.claimVerificationResult).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toContain('data:duration');
    expect(inspectCandidateProtocol(source.conclusion).sidecar.rawPayload).toEqual(payload);
    expect(source.conclusion).toBe(raw);
  });

  it('preserves a long final answer while dropping every stray declared measurement', () => {
    const contract = declaration();
    contract.claims = Array.from({length: 240}, (_, index) => ({
      id: `phase-${index}`, kind: 'numeric', text: `Phase ${index} took ${index + 0.125} ms.`,
      references: [{evidenceRefId: 'data:all-phases', rowIndex: index + 1000,
        column: 'duration_ms', value: index + 0.125}],
    }));
    const body = contract.claims.map(claim => `${claim.text} This measurement describes only the cited phase. ` +
      'Overlapping work must not be added to the launch total, and the measurement alone does not establish a cause.\n')
      .join('\n') + '\n| Final phase | Duration (ms) | Source |\n| --- | ---: | --- |\n' +
      '| Tail-only finding | 239.125 | data:all-phases, row 1239 |\n\n' +
      'TAIL_FINDING: The last phase remains independently relevant; its cause is still unknown.';
    expect(body.length).toBeGreaterThan(40_000);
    const source = result(`${body}\n\n${renderConclusionContractSidecar(contract)}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});

    expect(canonical.result.conclusion).toBe(`${body}\n\n`);
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.result.claimVerificationResult).toBeUndefined();
    expect(source.conclusion).toContain(renderConclusionContractSidecar(contract));
  });

  it('preserves a final comparison table while removing only the sidecar', () => {
    const body = [
      '阶段耗时对比如下，机制仍需结合调度证据解释。', '',
      '| 阶段 | 基线（ms） | 对比（ms） | 来源 |',
      '| --- | ---: | ---: | --- |',
      '| `bind\\|Application` | 120 | 200 | 两侧启动阶段原始记录 |', '',
      '比例分母和因果关系尚未核验，不从这张表推断根因。',
    ].join('\n');
    const contract = declaration(120);
    contract.claims![0].references[0] = {evidenceRefId: 'data:baseline', rowIndex: 900, column: 'duration_ms', value: 120};
    contract.claims!.push({...contract.claims![0], id: 'comparison-duration', text: 'Comparison duration is 200 ms.',
      references: [{evidenceRefId: 'data:comparison', rowIndex: 901, column: 'duration_ms', value: 200}]});
    const source = result(`${body}\n\n${renderConclusionContractSidecar(contract)}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(`${body}\n\n`);
    expect(canonical.result.conclusion).not.toContain('conclusion_contract_v1');
    expect(JSON.stringify(canonical)).not.toContain('data:comparison');
  });

  it('uses the same protocol inspection for native diagnostics and canonical narrative', () => {
    const raw = `Visible body\n${renderConclusionContractSidecar(declaration())}`;
    const inspected = inspectCandidateProtocol(raw);
    expect(inspected.canonicalBody).toBe(canonicalizeAnalysisResult(result(raw)).result.conclusion);
    expect(buildCandidateProtocolDiagnostic(inspected, 'native', 1)).toMatchObject({
      status: 'valid', sidecarStatus: 'valid', typedJsonStatus: 'not_checked', canonicalChars: 12,
      projectionKind: 'protocol_projection', issueCodes: [], issueCount: 0,
    });
    const onlySidecar = inspectCandidateProtocol(renderConclusionContractSidecar(declaration()));
    expect(buildCandidateProtocolDiagnostic(onlySidecar, 'native', 1)).toMatchObject({status: 'valid', canonicalChars: 0});
  });

  it.each([
    ['marker', 'not_exact', 2, (text: string) => text.replace('contract@1', 'contract@2 PRIVATE_FRAMING_CANARY')],
    ['opening_fence', 'not_exact', 3, (text: string) => text.replace('```json', '```JSON PRIVATE_FRAMING_CANARY')],
    ['closing_fence', 'not_exact', 5, (text: string) => text.replace('\n```\n-->', '\n``` \n-->')],
    ['terminator', 'missing', 2, (text: string) => text.replace('\n-->', '')],
    ['comment', 'noncanonical', 2, (text: string) => text.replace('contract@1', 'declaration').replace('```json\n', '').replace('\n```', '')],
    ['payload', 'embedded_terminator', 4, (text: string) => text.replace('Measured duration is', '--> PRIVATE_FRAMING_CANARY Measured duration is')],
  ])('locates %s without publishing native framing text', (field, reason, line, mutate) => {
    const raw = `Body PRIVATE_FRAMING_CANARY\n${(mutate as (text: string) => string)(wrapConclusionContractSidecarPayload(JSON.stringify(declaration())))}`;
    const inspected = inspectCandidateProtocol(raw);
    const diagnostic = buildCandidateProtocolDiagnostic(inspected, 'native', 1);
    expect(diagnostic).toMatchObject({status: 'invalid', issueCodes: ['invalid_framing'],
      framingDiagnostic: {field, reason, line}});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_FRAMING_CANARY');
    expect(inspected.sidecar.bindingEligibility).toBe('ineligible');
    expect(inspectCandidateProtocol(raw)).toEqual(inspected);
    const old = {...diagnostic};
    delete old.framingDiagnostic;
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('rejects forged framing facts, private fields and impossible positions', () => {
    const raw = `Body\n${renderConclusionContractSidecar(declaration()).replace('```json', '```JSON')}`;
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    const detail = diagnostic.framingDiagnostic!;
    for (const framingDiagnostic of [null, {}, {...detail, field: 'PRIVATE_PATH'}, {...detail, reason: 'missing'},
      {...detail, line: 0}, {...detail, line: 1.5}, {...detail, line: raw.length + 2},
      {...detail, source: 'PRIVATE_SOURCE'}, {...detail, text: 'PRIVATE_VALUE'}]) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, framingDiagnostic})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid'})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, sidecarStatus: 'absent'})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_json']})).toBeUndefined();
    const valid = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(renderConclusionContractSidecar(declaration())), 'native', 1);
    expect(valid).not.toHaveProperty('framingDiagnostic');
  });

  it('distinguishes valid native declarations from a later malformed projected declaration without disclosing text', () => {
    const raw = `Body PRIVATE_DIAGNOSTIC_CANARY\n${renderConclusionContractSidecar(declaration())}`;
    const changed = raw.replace('"focused_answer"', '"PRIVATE_DIAGNOSTIC_CANARY"');
    const native = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    const projected = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(changed), 'runtime_projected', 1, 'redacted');
    expect(native.status).toBe('valid');
    expect(projected).toMatchObject({status: 'invalid', projectionKind: 'redacted', issueCodes: ['invalid_contract']});
    expect(sanitizeCandidateProtocolDiagnostic(projected)).toEqual(projected);
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    expect(projected).toMatchObject({claimCount: 1, semanticClaimCount: 0, sourceBindingCount: 0, status: 'invalid'});
  });

  it('records declared claim/semantic/binding counts without treating them as valid evidence', () => {
    const original = {...declaration(), claims: [
      {id: 'one', text: 'A hypothetical statement.', kind: 'inference', references: [], semantics: {
        schemaVersion: 'claim_semantics@1', predicate: 'example.hypothesis', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'},
      }},
      {id: 'two', text: 'An unchecked statement.', kind: 'inference', references: []},
    ], sourceClaimBindings: [{invalid: 'PRIVATE_DIAGNOSTIC_CANARY'}, {alsoInvalid: true}]};
    const inspect = (payload: unknown) => inspectCandidateProtocol(
      `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n-->`);
    const native = buildCandidateProtocolDiagnostic(inspect(original), 'native', 1);
    expect(native).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 2});
    expect(sanitizeCandidateProtocolDiagnostic(native)).toEqual(native);
    const projected = buildCandidateProtocolDiagnostic(inspect({...original, sourceClaimBindings: []}), 'runtime_projected', 1);
    expect(projected).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 0});
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    const old = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(old).not.toHaveProperty('claimCount');
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('projects only fixed root structure facts and raw declaration entry counts for an invalid shell', () => {
    const raw = renderConclusionContractSidecar({...declaration(), mode: 'PRIVATE_STRUCTURE_CANARY'} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic).toMatchObject({status: 'invalid', issueCount: 1, claimCount: 1, semanticClaimCount: 0,
      sourceBindingCount: 0, details: [{field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'}]});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it('rejects duplicate, excessive, unknown or impossible structure detail combinations while accepting old diagnostics', () => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(
      renderConclusionContractSidecar({...declaration(), mode: 'bad'} as any)), 'native', 1);
    const detail = {field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'};
    for (const details of [[detail, detail], Array(25).fill(detail), [null],
      [{...detail, field: '/private/source'}], [{...detail, actual: 'PRIVATE_STRUCTURE_CANARY'}],
      [{...detail, expected: 'string'}], [{...detail, reason: 'wrong_type'}],
      [{...detail, field: '$.conclusions[].rank', expected: 'finite_number'}],
      [{...detail, field: '$', expected: 'object', actual: 'missing', reason: 'missing_required'}],
      [{...detail, raw: 'PRIVATE_STRUCTURE_CANARY'}]]) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details})).toBeUndefined();
    }
    const uniqueDetails = ['$', '$.conclusions[]', '$.clusters[]', '$.evidenceChain[]'].flatMap(field =>
      ['null', 'array', 'string', 'number', 'boolean', 'undefined', 'other', 'nonfinite_number'].map(actual =>
        ({field, expected: 'object', actual, reason: 'wrong_type'})));
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 24)})).toBeDefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 25)})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_reference'], details: [detail]})).toBeUndefined();
    const {details: _details, ...old} = diagnostic;
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('projects bounded relation failures without retaining raw keys, values, IDs or source text', () => {
    const raw = renderConclusionContractSidecar({...declaration(), relationProposals: [{
      schemaVersion: 'evidence_relation_candidate@1', id: 'PRIVATE_RELATION_ID_CANARY', kind: 'overlap',
      direction: 'symmetric', subject: {sourceRef: 'PRIVATE_RELATION_SOURCE_CANARY'},
      PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY',
    }]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    // A single invalid proposal item is item-scoped (plan A.1): partially valid.
    expect(diagnostic).toMatchObject({status: 'partially_valid', issueCodes: ['invalid_relation_proposal'], issueCount: 1,
      relationProposalDiagnostics: [{scope: 'item', ordinal: 1, reason: 'unknown_field'}]});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_RELATION_');
  });

  it('locates failing claims by position and schema field so one repair can find them, even past claim 24', () => {
    const semantics = {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'}};
    const claim = (index: number) => ({id: `claim-${index}`, kind: 'numeric', text: `Claim ${index}.`, references: [], semantics});
    const claims: any[] = Array.from({length: 31}, (_, index) => claim(index + 1));
    claims[1] = {...claim(2), semantics: {...semantics, scope: {population: 'PRIVATE_POPULATION_CANARY'}}};
    claims[2] = {...claim(3), id: 'claim-1'};
    claims[3] = {...claim(4), artifactRefs: 'PRIVATE_REF_CANARY'};
    claims[29] = {...claim(30), semantics: {...semantics, predicate: 'has whitespace', PRIVATE_KEY_CANARY: 1}};
    const raw = renderConclusionContractSidecar({...declaration(), claims} as any);
    const inspected = inspectCandidateProtocol(raw);
    const diagnostic = buildCandidateProtocolDiagnostic(inspected, 'native', 1);
    expect(diagnostic.claimDiagnostics).toEqual([
      {ordinal: 2, code: 'invalid_semantics', field: 'semantics.scope.population'},
      {ordinal: 3, code: 'duplicate_claim_id', field: 'id'},
      {ordinal: 4, code: 'invalid_reference', field: 'artifactRefs'},
      {ordinal: 30, code: 'invalid_semantics', field: 'semantics.unknown_field'},
    ]);
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    // Diagnostics ride on the returned issues only; stored claim items keep their own issue shape.
    const stored = inspected.sidecar.contract!.claims!.find(item => item.id === 'claim-2') as any;
    expect(stored.semanticsParseIssues).toEqual([{code: 'invalid_semantics', path: 'claims[1].semantics'}]);
    expect(JSON.stringify(inspected.sidecar.contract!.claims)).not.toContain('claimDiagnostic');
  });

  it('sanitizes claim diagnostics as a bounded collection of pairs a parser can produce', () => {
    const raw = renderConclusionContractSidecar({...declaration(), claims: [
      {...declaration().claims![0], semantics: {schemaVersion: 'other'}}]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic.claimDiagnostics).toEqual([{ordinal: 1, code: 'invalid_semantics', field: 'semantics.schemaVersion'}]);
    const item = {ordinal: 1, code: 'invalid_semantics', field: 'semantics.predicate'};
    const invalidCollections: unknown[] = [
      [], null, item, [item, item], Array.from({length: 25}, (_, index) => ({...item, ordinal: index + 1})),
      [{...item, field: 'id'}], [{...item, code: 'duplicate_claim_id'}], [{...item, field: 'PRIVATE_FIELD_CANARY'}],
      [{...item, ordinal: 0}], [{...item, ordinal: 1.5}], [{...item, raw: 'PRIVATE_VALUE_CANARY'}],
      [{...item, code: 'invalid_reference', field: 'references'}],
    ];
    for (const claimDiagnostics of invalidCollections) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, claimDiagnostics})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, claimDiagnostics: [{...item, ordinal: 40}]}))
      .toMatchObject({claimDiagnostics: [{ordinal: 40}]});
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid'})).toBeUndefined();
  });

  it('sanitizes relation diagnostics as a closed bounded discriminated collection', () => {
    const raw = renderConclusionContractSidecar({...declaration(), relationProposals: null} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic.relationProposalDiagnostics).toEqual([
      {scope: 'collection', reason: 'collection_not_array'},
    ]);
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    const item = {scope: 'item', ordinal: 1, reason: 'invalid_id'};
    const invalidCollections: unknown[] = [
      [], null, item, [item, item], Array.from({length: 25}, (_, index) => ({...item,
        ordinal: index % 24 + 1, reason: index === 24 ? 'invalid_kind' : 'invalid_id'})),
      [{...item, scope: 'other'}], [{...item, reason: 'PRIVATE_RELATION_REASON_CANARY'}],
      [{scope: 'item', reason: 'invalid_id'}], [{...item, ordinal: 0}], [{...item, ordinal: 25}],
      [{...item, ordinal: 1.5}], [{...item, raw: 'PRIVATE_RELATION_VALUE_CANARY'}],
      [{scope: 'collection', reason: 'collection_not_array', ordinal: 1}],
      [{scope: 'collection', reason: 'invalid_id'}],
      [{scope: 'collection', reason: 'collection_not_array'}, item],
    ];
    for (const relationProposalDiagnostics of invalidCollections) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, relationProposalDiagnostics})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid', relationProposalDiagnostics: [item]})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_reference'],
      relationProposalDiagnostics: [item]})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCount: 0,
      relationProposalDiagnostics: [item]})).toBeUndefined();
  });

  it.each(['Ordinary answer', JSON.stringify(declaration())])('keeps ordinary or legacy declarations absent rather than invalid: %s', raw => {
    expect(inspectCandidateProtocol(raw).status).toBe('absent');
  });

  it.each([
    {raw: 'PRIVATE_DIAGNOSTIC_CANARY'}, {path: '/private/source'}, {claimId: 'private-claim'},
    {issueCodes: ['private_failure'], issueCount: 1}, {rawChars: -1}, {canonicalChars: Infinity},
    {issueCount: Number.MAX_SAFE_INTEGER + 1}, {candidateIndex: 3}, {stage: 'model_claim'},
    {claimCount: 1}, {claimCount: 1, semanticClaimCount: 2, sourceBindingCount: 0},
    {claimCount: 1, semanticClaimCount: 1, sourceBindingCount: -1},
  ])('rejects unsafe or malformed diagnostic metadata %j', extra => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, ...extra})).toBeUndefined();
  });

  it.each(['sidecar_first', 'control_first'] as const)('preserves exact narrative for %s', order => {
    const sidecar = renderConclusionContractSidecar(declaration());
    const blocks = order === 'sidecar_first' ? `${sidecar}\r\n${control}` : `${control}\r\n${sidecar}`;
    const source = result(` \r\nConnection error is trace content.  \r\n${blocks}\r\n \t`);
    const context = contextFor(source);
    const canonical = canonicalizeAnalysisResult(source, {context, conversation: {fallbackQuestion: 'Never the body'}});
    expect(canonical.result.conclusion).toBe(' \r\nConnection error is trace content.  \r\n\r\n\r\n \t');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?',
      message: canonical.result.conclusion});
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.projection.disposition).toBe('protocol_projection');
    expect(canonical.result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(canonical.result.conclusion));
    expect(canonical.result.completion?.status).toBe('completed');
    expect(source.conclusion).toContain(sidecar);
    expect(JSON.stringify(canonical.result)).not.toContain(canonical.projection.inputFingerprint);
    expect(canonical.result).not.toHaveProperty('projection');
    expect(canonical.result).not.toHaveProperty('protocolDiagnostics');
  });

  it('leaves pure control questions outside the body so the empty gate can reject delivery', () => {
    const source = result(control);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source),
      conversation: {fallbackQuestion: 'Fallback question'}});
    expect(canonical.result.conclusion).toBe('');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?', message: ''});
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext}).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({code: 'empty_conclusion'})]));
  });

  it('removes all duplicate terminal control segments without applying the final one', () => {
    const answered = '<!-- smartperfetto:conversation-control {"kind":"answered"} -->';
    const canonical = canonicalizeAnalysisResult(result(`Body\n${answered}\n${control}`),
      {conversation: {fallbackQuestion: 'Fallback'}});
    expect(canonical.result.conclusion).toBe('Body\n\n');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'answered', message: 'Body\n\n'});
  });

  it('stores neither an invalid stray sidecar nor a runtime-supplied contract', () => {
    const marker = '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":"RAW_DIAGNOSTIC_CANARY"}\n```\n-->';
    const source = result(`Actual answer\n${marker}`);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Actual answer\n');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toContain('RAW_DIAGNOSTIC_CANARY');
  });

  it('keeps a malformed stray declaration out of the stored result', () => {
    const malformed = {...declaration(), claims: [{...declaration().claims![0], semantics: 'RAW_SEMANTICS_CANARY'}]};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const canonical = canonicalizeAnalysisResult(result(`Actual answer\n${marker}`));
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.result.conclusionContract?.bindingEligibility).toBeUndefined();
    expect(JSON.stringify(canonical)).not.toMatch(/RAW_SEMANTICS_CANARY|Measured duration is 999/);
    expect(canonical.result.completion).toBeUndefined();
  });

  it.each(['sidecar', 'legacy'] as const)('projects nested source and claim fields without leaking raw diagnostics on %s', path => {
    const untrusted = {...declaration(), bindingEligibility: 'ineligible',
      conclusions: [{rank: 1, statement: 'A statement', trigger: {rawDeclaration: 'TRIGGER_RAW_CANARY'}}],
      sourceUseDecision: {rawDeclaration: 'SOURCE_RAW_CANARY'},
      sourceReferences: [{referenceId: 'lookup-current', codebaseId: 'source-current', filePath: 'src/Foo.ts',
        lookupKind: 'body', snippet: 'REFERENCE_RAW_CANARY', rawDeclaration: 'REFERENCE_RAW_CANARY'}],
      sourceClaimBindings: [{claimId: 'measured-duration', mechanismStatus: 'compatible',
        sourceReferenceIds: [], traceEvidenceRefIds: [], rawDeclaration: 'BINDING_RAW_CANARY'}],
      claims: [{...declaration().claims![0], artifactRefs: [{artifactId: 'artifact-a',
        rowSelector: {row: 1, unsupported: {rawDeclaration: 'SELECTOR_RAW_CANARY'}}}],
        semantics: {rawDeclaration: 'SEMANTICS_RAW_CANARY'}}],
    };
    const source = result(path === 'sidecar'
      ? `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(untrusted)}\n\`\`\`\n-->` : 'Body');
    if (path === 'legacy') source.conclusionContract = untrusted as unknown as ConclusionContract;
    const canonical = canonicalizeAnalysisResult(source);
    expect(JSON.stringify(canonical)).not.toContain('RAW_CANARY');
    expect(canonical.result.conclusionContract?.sourceUseDecision).toBeUndefined();
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.result.conclusionContract?.sourceClaimBindings).toBeUndefined();
  });

  it.each(['valid', 'invalid'] as const)('keeps a whole-body typed JSON %s declaration as text and stores no claims', state => {
    const original = {...declaration(999), relationProposals: [],
      ...(state === 'invalid' ? {verified: true} : {})};
    const body = `  ${JSON.stringify(original)}  `;
    const source = result(body);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(body);
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.result.conclusionContract?.relationProposals).toBeUndefined();
    expect(JSON.stringify(canonical.result.conclusionContract ?? {})).not.toContain('"verified"');
  });

  it('stores no declaration for an invalid protocol shell, nor the runtime-supplied contract', () => {
    for (const body of [
      '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":true}\n```\n-->',
      JSON.stringify({schemaVersion: 'conclusion_contract_v1', relationProposals: [], mode: 'focused_answer'}),
    ]) {
      const source = result(body);
      source.conclusionContract = declaration(12.5);
      const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
      expect(canonical.result.conclusionContract?.claims).toBeUndefined();
      expect(JSON.stringify(canonical.result.conclusionContract ?? null)).not.toContain('Measured duration is 12.5');
    }
  });

  it('keeps a full raw stray declaration out of the stored result', () => {
    const malformed = {...declaration(), bindingEligibility: 'eligible', metadata: {
      sceneId: 'general', unknownField: {rawDeclaration: 'NESTED_RAW_CANARY'},
      clusterPolicy: {outputMode: 'optional', frameListMode: 'none', unexpected: 'POLICY_RAW_CANARY'},
    }};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const canonical = canonicalizeAnalysisResult(result(`Body\n${marker}`));
    expect(canonical.result.conclusion).toBe('Body\n');
    expect(JSON.stringify(canonical)).not.toContain('RAW_CANARY');
    expect(canonical.result.conclusionContract?.rawDeclaration).toBeUndefined();
    expect(canonical.result.conclusionContract?.bindingEligibility).toBeUndefined();
  });

  it('does not activate a nested second protocol or a nonterminal control', () => {
    const quotedSidecar = renderConclusionContractSidecar(declaration());
    const payload = JSON.stringify({kind: 'needs_user_input', question: quotedSidecar}).replace(/-->/g, '\\u002d\\u002d>');
    const nestedControl = `<!-- smartperfetto:conversation-control ${payload} -->`;
    const nested = canonicalizeAnalysisResult(result(nestedControl), {conversation: {fallbackQuestion: 'Fallback'}});
    expect(nested.result.conclusion).toBe('');
    const ordinary = `${control}\nThis is subsequent narrative, so the earlier marker is ordinary content.`;
    expect(canonicalizeAnalysisResult(result(ordinary), {conversation: {fallbackQuestion: 'Fallback'}}).result.conclusion).toBe(ordinary);
  });

  it('preserves exact prose without a sidecar and derives structure instead of keeping a supplied contract', () => {
    const source = result('  ## Complete report\n\n快速回答：Connection error and full analysis are trace content.  ');
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(source.conclusion);
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
    expect(canonical.projection.disposition).toBe('preserved');
  });

  it.each(['completed', 'incomplete', 'unknown'] as const)('transfers only native %s completion through issued projection', status => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source, status);
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(isIssuedCanonicalAnalysisProjection(canonical.projection)).toBe(true);
    expect(isIssuedCanonicalAnalysisProjection({...canonical.projection})).toBe(false);
    expect(Object.isFrozen(canonical.projection)).toBe(true);
    expect(Object.isFrozen(canonical.projection.sourceCandidate)).toBe(true);
    expect(Object.isFrozen(canonical.projection.candidate)).toBe(true);
    expect(canonical.result.completion?.status).toBe(status);
    expect(canonical.result.completion?.candidateRef).not.toBe(context.acceptedCandidate.candidateRef);
    expect(assessFinalResultQualityAssessment({result: canonical.result, context}).assurance.completion).toBe('not_checked');
  });

  it.each(['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint'] as const)(
    'does not transfer a native receipt for another %s', field => {
      const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
      const context = contextFor(source);
      context.completion = {...context.completion!, [field]: 'stale'};
      expect(canonicalizeAnalysisResult(source, {context}).result.completion).toBeUndefined();
    },
  );

  it('does not re-sign a stale source body or trust result metadata without explicit context', () => {
    const source = result('Original body');
    const context = contextFor(source);
    source.conclusion = `Different body\n${renderConclusionContractSidecar(declaration())}`;
    source.completion = context.completion;
    source.outputOrigin = 'sdk_final';
    for (const options of [{context}, {}]) {
      const canonical = canonicalizeAnalysisResult(source, options);
      expect(canonical.result.completion).toBeUndefined();
      expect(canonical.projection.candidate).toBeUndefined();
      expect(canonical.projection.sourceCandidate).toBeUndefined();
    }
  });

  it('drops claim verdicts and stale assessments when the body or structure changes', () => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source);
    source.conclusionContract = declaration(12.5);
    source.claimSupport = [];
    source.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
      claims: 'passed', source: 'passed', identity: 'passed', report: 'passed'};
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result.claimSupport).toBeUndefined();
    expect(canonical.result.claimVerificationResult).toBeUndefined();
    expect(canonical.result.deliveryAssurance).toBeUndefined();
    if (canonical.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing canonical context');
    expect(canonical.deliveryContext.investigationAssessment).toBeUndefined();
  });

  it('preserves a typed whole privacy fallback without granting completion', () => {
    const source = result('[PRIVATE_OUTPUT_SUPPRESSED]');
    source.success = false;
    source.partial = true;
    source.outputOrigin = 'runtime_fallback';
    const context = contextFor(source, 'unknown');
    context.outputOrigin = 'runtime_fallback';
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
    expect(canonical.result.completion?.status).toBe('unknown');
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext})
      .assurance.completion).toBe('failed');
  });
});


describe('source binding declaration ownership', () => {
  function sourceDeclaration(): any {
    return {...declaration(), claims: [{id: 'source-body', text: 'Implementation may explain the wait', kind: 'inference', references: [],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.mechanism', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'}}}],
      sourceClaimBindings: [{claimId: 'source-body', sourceReferenceIds: ['source-returned'], traceEvidenceRefIds: [] as string[]}]};
  }
  it('admits source-only empty Trace links without declaring source proof', () => {
    const parsed = parseConclusionContractDeclaration(sourceDeclaration());
    expect(parsed.issues).toEqual([]);
    expect(parsed.contract?.sourceClaimBindings).toEqual([{claimId: 'source-body',
      sourceReferenceIds: ['source-returned'], traceEvidenceRefIds: []}]);
  });
  it.each(['missing', 'duplicate', 'foreign_trace'] as const)('rejects %s links while retaining the original declaration', kind => {
    const raw = sourceDeclaration();
    raw.privateNote = 'PRIVATE_DECLARATION_NOTE';
    if (kind === 'missing') raw.sourceClaimBindings[0].claimId = 'not-declared';
    if (kind === 'duplicate') raw.claims.push(structuredClone(raw.claims[0]));
    if (kind === 'foreign_trace') {
      raw.sourceClaimBindings[0].traceEvidenceRefIds = ['data:duration'];
      raw.claims.push(declaration().claims![0]);
    }
    const before = structuredClone(raw);
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues).toContainEqual({code: 'invalid_reference', path: `sourceClaimBindings[0].${kind === 'foreign_trace' ? 'traceEvidenceRefIds' : 'claimId'}`});
    expect(parsed.contract?.bindingEligibility).toBe('ineligible');
    expect(parsed.contract?.sourceClaimBindings).toEqual(raw.sourceClaimBindings);
    expect(parsed.contract?.rawDeclaration).toEqual(raw);
    expect(raw).toEqual(before);
    const native = `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n-->`;
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(native), 'native', 1);
    expect(diagnostic.issueCodes).toContain('invalid_reference');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_DECLARATION_NOTE');
    expect(JSON.stringify(canonicalizeAnalysisResult(result(native)).result)).not.toContain('PRIVATE_DECLARATION_NOTE');
  });
  it('reports cluster shape and unowned Trace bindings together for one correction opportunity', () => {
    const raw = sourceDeclaration();
    raw.clusters = ['wrong shape'];
    raw.sourceClaimBindings[0].traceEvidenceRefIds = ['foreign'];
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['invalid_contract', 'invalid_reference']));
    expect(parsed.contract).toBeUndefined();
  });
  it.each(['references', 'artifactRefs', 'relationRefs', 'subjectRefs', 'objectRefs'] as const)(
    'leaves %s aliases and evidence truth to the verifier', field => {
      const raw = sourceDeclaration();
      const claim = raw.claims[0];
      raw.sourceClaimBindings[0].traceEvidenceRefIds = ['data:duration'];
      if (field === 'references') claim.references = [{artifactId: 'artifact-alias', rowIndex: 0, column: 'dur_ms'}];
      else if (field === 'artifactRefs') claim.artifactRefs = [{artifactId: 'artifact-alias'}];
      else if (field === 'relationRefs') claim.relationRefs = ['relation:observed'];
      else claim.semantics.scope[field] = [{evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms'}];
      expect(parseConclusionContractDeclaration(raw).issues).toEqual([]);
    });
});




describe('legacy narrative derivation at the canonical boundary', () => {
  // Legacy bodies carry no sidecar: their structure is derived from the prose,
  // or a producer's contract is kept, as historical and replay reads still do.
  const legacyContract = (conclusion: string, conclusionContract?: ConclusionContract) =>
    conclusionContract ?? deriveConclusionContract(conclusion) ?? undefined;
  const skillTable = (evidenceRefId: string, title: string, columns: string[], rows: unknown[][],
    meta: Partial<DataEnvelope['meta']> = {}): DataEnvelope => {
    const envelope = createDataEnvelope({columns, rows}, {type: 'skill_result', source: title, title, evidenceRefId,
      traceId: 'trace-1', traceSide: 'current'});
    return {...envelope, meta: {...envelope.meta, ...meta}};
  };
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  it('derives legacy claim provenance from the body, which a new result never stores', () => {
    expect(legacyContract(narrativeWithEvClaim)?.claims?.[0]?.references?.[0]).toMatchObject({
      evidenceRefId: 'ev_deadbeef1234', sourceRef: '表 1'});
    const canonical = canonicalizeAnalysisResult(result(narrativeWithEvClaim));
    expect(canonical.result.conclusion).toContain('ev_deadbeef1234');
    expect(canonical.result.conclusionContract?.claims).toBeUndefined();
  });

  it('takes a derived contract mode from the current typed deliverable, never from result metadata', () => {
    const source = result(narrativeWithEvClaim);
    expect(canonicalizeAnalysisResult(source, {context: contextFor(source, 'completed', 'answer')}).result.conclusionContract?.mode)
      .toBe('focused_answer');
    expect(canonicalizeAnalysisResult(source, {context: contextFor(source, 'completed', 'report')}).result.conclusionContract?.mode)
      .toBe('initial_report');
    const metadataOnly = {...source, turnIntent: contextFor(source).turnIntent};
    expect(canonicalizeAnalysisResult(metadataOnly).result.conclusionContract?.mode).toBe('initial_report');
  });

  describe('original claim fidelity', () => {
    const envelope = createDataEnvelope(
      {columns: ['ttid_ms'], rows: [[1912]]},
      {type: 'skill_result', source: 'startup_analysis', title: '启动概览',
        skillId: 'startup_analysis', stepId: 'get_startups', executionStatus: 'observed',
        evidenceRefId: 'data:startup-original', traceId: 'trace-original', traceSide: 'current'},
    );
    const originalContract = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract & {claims: NonNullable<ConclusionContract['claims']>} => ({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: '启动耗时待核验'}],
      clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: [],
    });
    const numericClaim = (id: string, value: number, text = `TTID=${value}ms`): ConclusionContractClaimItem => {
      const reference = {evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value};
      return {id, text, kind: 'numeric', references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value, unit: 'ms'}}};
    };
    const parsedOriginal = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract => {
      const parsed = parseConclusionContractDeclaration(originalContract(claims));
      expect(parsed.issues).toEqual([]);
      if (!parsed.contract) throw new Error('Expected a valid fixture declaration');
      return parsed.contract;
    };
    const verifyCaptured = async (conclusionContract: ConclusionContract | null | undefined) => {
      const store = new ArtifactStore();
      store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
        ttid_ms: {unit: 'ms', origin: {kind: 'skill_literal', skillId: 'startup_analysis',
          stepId: 'get_startups', definitionFingerprint: 'startup-original-fixture'}},
      }), {meta: envelope.meta, display: envelope.display});
      const preparedEvidence = await prepareClaimEvidence({conclusionContract,
        evidenceReadView: store.createEvidenceReadView({ownerKey: 'original-claims',
          allowedTraces: [{traceId: 'trace-original', traceSide: 'current'}]})});
      return runPreparedAnalysisClaimVerification({conclusionContract, dataEnvelopes: [envelope], preparedEvidence});
    };

    it('keeps a contradicted claim failed when unrelated prose contains the true evidence value', async () => {
      const original = parsedOriginal([numericClaim('wrong-ttid', 9999)]);
      const canonical = legacyContract('启动概览：TTID=9999ms，事件计数1912次。', original);
      const verified = await verifyCaptured(canonical);

      expect(canonical).toBe(original);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults[0]).toMatchObject({claimId: 'wrong-ttid', status: 'unsupported',
        referenceCells: [{status: 'value_mismatch'}],
        deterministicProof: {status: 'rejected', reason: 'numeric_operator_rejected'}});
    });

    it('preserves mixed supported, contradicted and unreferenced claims', async () => {
      const original = parsedOriginal([
        numericClaim('supported', 1912),
        numericClaim('contradicted', 9999),
        {id: 'no-reference', text: 'The delay may come from initialization.', kind: 'inference', references: []},
      ]);
      const canonical = legacyContract('启动概览：TTID=9999ms，事件计数1912次。', original);
      const verified = await verifyCaptured(canonical);

      expect(canonical?.claims).toEqual(original.claims);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults).toMatchObject([
        {claimId: 'supported', status: 'partial', deterministicProof: {status: 'proved'}, propositionCoverage: {status: 'complete'}},
        {claimId: 'contradicted', status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]},
        {claimId: 'no-reference', status: 'inference', referenceCells: []},
      ]);
    });

    it('reads typed JSON before display conversion can discard causal kind or relation references', () => {
      const original = originalContract([{
        id: 'cause', text: 'No evidence yet proves that initialization caused the delay.', kind: 'causal',
        relationRefs: ['relation-candidate'],
        references: [{evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value: 1912}],
      }]);
      expect(legacyContract(JSON.stringify(original))?.claims)
        .toEqual(original.claims.map(claim => ({...claim, conclusionId: 'C1'})));
    });

    it('retains explicit JSON claims whose references are absent, malformed or relation-only', () => {
      const raw = originalContract([
        {id: 'missing', text: 'Initialization may be slow.', kind: 'inference', references: []},
        {id: 'relation-only', text: 'The dependency blocks initialization.', kind: 'causal', references: [], relationRefs: ['relation-1']},
        {id: 'malformed', text: 'TTID=9999ms', kind: 'numeric', references: [{}]},
      ]);
      const parsed = legacyContract(JSON.stringify(raw));
      expect(parsed?.claims?.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})))
        .toEqual(raw.claims.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})));
      expect(parsed?.claims?.[1].relationRefs).toEqual(['relation-1']);
      expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult.passed).toBe(false);
    });

    it('retains explicit Markdown claims without references as unverified statements', () => {
      const parsed = legacyContract([
        '## 逐句数据引用（结构化来源）',
        '- Q-missing / C1: 初始化耗时尚未得到证据支持。',
      ].join('\n'));
      expect(parsed?.claims).toEqual([{id: 'Q-missing', conclusionId: 'C1', text: '初始化耗时尚未得到证据支持。', references: []}]);
      expect(runClaimVerification({conclusionContract: parsed}).claimVerificationResult.passed).toBe(false);
    });

    it('does not create claims merely because narrative and evidence contain the same number', () => {
      const parsed = legacyContract('事件计数1912次。');
      expect(parsed?.claims ?? []).toEqual([]);
      expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult)
        .toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
    });

    it('does not silently truncate explicitly supplied claims before verification', async () => {
      const claims = Array.from({length: 51}, (_, index) => numericClaim(
        `Q${index + 1}`, index === 50 ? 9999 : 1912, `TTID observation ${index + 1}`,
      ));
      const parsed = legacyContract(JSON.stringify(originalContract(claims)));
      expect(parsed?.claims?.map(({id, references, semantics}) => ({id, references, semantics})))
        .toEqual(claims.map(({id, references, semantics}) => ({id, references, semantics})));
      const verified = await verifyCaptured(parsed);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults).toHaveLength(51);
      expect(verified.claimVerificationResult.claimResults.slice(0, 50).every(claim =>
        claim.status === 'partial' && claim.deterministicProof?.status === 'proved')).toBe(true);
      expect(verified.claimVerificationResult.claimResults[50]).toMatchObject({claimId: 'Q51',
        status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]});
    });

    it.each([{}, {id: 'empty', references: []}, {text: '   ', references: []}])(
      'does not fabricate a statement for an empty claim entry: %j',
      entry => {
        const parsed = legacyContract(JSON.stringify({...originalContract([]), claims: [entry]}));
        expect(parsed?.claims ?? []).toEqual([]);
        expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult)
          .toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
      },
    );
  });

  it('keeps rich reports without explicit claims unverified despite matching evidence', () => {
    const envelopes = [
      skillTable('data:skill:startup_analysis:get_startups:current:abc', '检测到的启动事件',
        ['package', 'startup_type', 'dur_ms', 'ttid_ms'], [['com.example.launch.aosp.heavy', 'cold', 1339, 1912]],
        {artifactId: 'art-2'}),
      skillTable('data:skill:startup_detail:actionable_hotspots:current:def', '可操作热点',
        ['slice_name', 'self_ms', 'self_percent'], [['ChaosTask', 456, 34.1], ['LoadSimulator_ActivityInit', 249.8, 18.7]],
        {artifactId: 'art-30'}),
    ];
    const contract = legacyContract([
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，dur=1339ms，主因是 ChaosTask self=456ms 和 LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 关键证据链',
      '',
      '- 启动事件与热点表均已采集。',
    ].join('\n'));
    expect(contract?.claims ?? []).toEqual([]);
    expect(contract?.metadata?.derivedFromNarrativeEvidenceMatch).not.toBe(true);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult).toMatchObject({status: 'not_checked', checkedClaimCount: 0});
  });

  it('preserves unresolvable references rather than replacing claims with matching data', () => {
    const envelopes = [skillTable('data:skill:scrolling_analysis:jank_type_stats:current:abc', '掉帧类型分布',
      ['jank_type', 'count', 'real_jank_count', 'false_positive'], [['App Deadline Missed', 6, 6, 0]], {artifactId: 'art-6'})];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1', mode: 'initial_report', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'Q1', text: 'App Deadline Missed 有 6 帧', kind: 'numeric', references: [{
        evidenceRefId: 'missing-artifact', sourceRef: 'jank_type_stats', rowIndex: 0, column: 'count', value: 6}]}],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const contract = legacyContract(
      '# 滑动性能分析报告\n\n## 概览\n\nApp Deadline Missed 有 6 帧，real_jank_count=6，false_positive=0。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.passed).toBe(false);
  });

  it('never verifies a claim that cites a knowledge reference as trace evidence', () => {
    const envelopes = [skillTable('data:skill:scrolling_analysis:jank_type_stats:current:abc', '掉帧类型分布',
      ['jank_type', 'count'], [['App Deadline Missed', 6]], {artifactId: 'art-6'})];
    const knowledgeReference = 'kref-00000000-0000-0000-0000-000000000000';
    const contract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'Q1', text: 'App Deadline Missed 有 6 帧', kind: 'numeric', references: [{
        evidenceRefId: knowledgeReference, sourceRef: '掉帧类型分布', rowIndex: 0, column: 'count', value: 6}]}],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const verification = runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes,
      policy: 'record_only'}).claimVerificationResult;
    expect(verification.passed).toBe(false);
    expect(verification.status).not.toBe('passed');
  });

  it('preserves conflicting artifact references for the verifier to reject', () => {
    const envelopes = [
      skillTable('data:skill:scrolling_analysis:performance_summary:current:abc', '滑动性能概览',
        ['total_frames', 'perceived_jank_frames', 'jank_rate'], [[347, 7, 2.02]], {artifactId: 'art-4'}),
      skillTable('data:skill:scrolling_analysis:batch_frame_root_cause:current:def', '掉帧列表',
        ['dur_ms', 'vsync_missed'], [[18.66, 2], [62.73, 7]], {artifactId: 'art-9'}),
    ];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1', mode: 'initial_report', conclusions: [], clusters: [], evidenceChain: [],
      claims: [
        {id: 'Q1', text: '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%', kind: 'numeric', references: [
          {evidenceRefId: 'data:art-4', sourceRef: '滑动性能概览', rowIndex: 0, column: 'total_frames', value: 347}]},
        {id: 'Q2', text: '最长帧 62.73ms，最长连续丢帧 7 VSync', kind: 'numeric', references: [
          {evidenceRefId: 'data:art-14', sourceRef: '掉帧列表', rowIndex: 1, column: 'dur_ms', value: 62.73}]},
      ],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const contract = legacyContract(
      '# 滑动性能分析报告\n\n## 概览\n\n总帧数 347，真实掉帧 7 帧，掉帧率 2.02%。最长帧 62.73ms，最长连续丢帧 7 VSync。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.passed).toBe(false);
  });

  it('does not invent cell expectations for row-only identity claims', () => {
    const envelopes = [skillTable('data:skill:process_identity_resolver:current:identity', '进程身份候选',
      ['process_name', 'package_name', 'pid', 'upid', 'confidence_score'],
      [['com.example.wechatfriendforcustomscroller', 'com.example.wechatfriendforcustomscroller', 13534, 885, 100]],
      {identityStatus: 'verified', identityRefId: 'identity:trace-1:current:process:885'})];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'C2', text: '主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885',
        kind: 'identity', references: [{evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
          sourceRef: '进程身份候选', rowIndex: 0}]}],
      uncertainties: [], nextSteps: [],
    };
    const contract = legacyContract(
      '这个 trace 的主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.status).toBe('not_checked');
  });
});
