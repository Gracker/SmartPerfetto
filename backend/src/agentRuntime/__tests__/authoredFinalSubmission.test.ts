// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import {installCurrentRealmStructuredCloneForTest} from '../../../tests/helpers/openAiRuntimeFixture';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument} from '../../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject} from '../../agent/core/authoredClaimObject';
import {CONCLUSION_AUTHORING_LIMITS} from '../../agent/core/conclusionAuthoring';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {
  AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION,
  AUTHORED_CLAIM_OBJECT_COMPILER_VERSION,
  claimAuthoredFinalSubmission,
  createAuthoredFinalSubmissionIssuer,
  issueAuthoredFinalSubmission,
  readAuthoredFinalSubmission,
  revokeAuthoredFinalSubmission,
  revokeAuthoredFinalSubmissionIssuer,
  type AuthoredFinalSubmissionV1ReadInput,
  type AuthoredFinalSubmissionV2ReadInput,
  type AuthoredFinalSubmissionAssistantV2ReadInput, type AuthoredFinalSubmissionAssistantV2IssueInput,
  type AuthoredFinalSubmissionSourcePolicy,
} from '../authoredFinalSubmission';

function rawDocument(text = 'Authored text.'): string {
  return JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
    contract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'a', text, kind: 'inference', references: [],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'unconfigured.inference', polarity: 'undetermined',
          discourse: 'hypothetical', quantifier: 'some', modality: 'possible', conditions: ['Original condition.'],
          scope: {population: 'cited_rows', subjectRefs: []}}}]},
    bodyParts: ['## Body\n', {claimText: 'a'}, '\n{"literal":"not a declaration"}']}, null, 2);
}

function fixture(documentJson = rawDocument(), rawArguments = JSON.stringify({documentJson}, null, 2)) {
  const compiled = compileAuthoredClaimDocument(documentJson);
  if (compiled.status !== 'compiled') throw new Error('Fixture must compile');
  const owner = {active: true, attemptActive: true};
  const binding = {owner, sessionId: 'session', runId: 'run', attemptId: 'attempt',
    providerPin: 'provider-model-protocol-pin', authorizationFingerprint: 'authorized-scope'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding,
    assertAttemptCurrent: () => {if (!owner.attemptActive) throw new Error('PRIVATE_ATTEMPT_CANARY');},
    assertCurrent: () => {if (!owner.active) throw new Error('PRIVATE_RUN_CANARY');}});
  const input = {dispatchOrdinal: 4, responseId: 'response', callId: 'call', rawArguments, documentJson, compiled};
  const read: AuthoredFinalSubmissionV1ReadInput = {binding: {...binding, dispatchOrdinal: 4, responseId: 'response', callId: 'call',
    representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION},
    rawArguments, documentJson, body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)};
  return {owner, binding, issuer, input, read};
}

function assertFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(assertFrozen);
}

describe('run-bound authored submission snapshots', () => {
  it('issues one opaque token with separately bound raw arguments, document, body and canonical values', () => {
    const f = fixture(rawDocument('中文 "quoted" \\ literal {"x":1} 😀'));
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    expect(Object.keys(token)).toEqual(['kind']);
    expect(JSON.stringify(token)).toBe('{"kind":"authored_final_submission"}');
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    assertFrozen(snapshot);
    expect(snapshot.compiled).toEqual(f.input.compiled);
    expect(snapshot.compiled).not.toBe(f.input.compiled);
    expect(snapshot.compiled.rawCanonicalPayload).not.toBe(f.input.compiled.rawCanonicalPayload);
    expect(snapshot.compiled.canonicalParse.rawPayload).toBe(snapshot.compiled.rawCanonicalPayload);
    expect(snapshot.rawArguments).toBe(f.input.rawArguments);
    expect(snapshot.documentJson).toBe(f.input.documentJson);
    expect(snapshot.hashes).toEqual({rawArgumentsHash: analysisDeliveryFingerprint(f.input.rawArguments),
      documentJsonHash: analysisDeliveryFingerprint(f.input.documentJson), bodyHash: analysisDeliveryFingerprint(f.input.compiled.body),
      rawCanonicalPayloadHash: analysisDeliveryFingerprint(f.input.compiled.rawCanonicalPayload)});
    expect(snapshot.binding).not.toHaveProperty('owner');
    expect(Object.isFrozen(f.owner)).toBe(false);
    expect(snapshot).not.toHaveProperty('completed');
    expect(snapshot).not.toHaveProperty('verified');
    expect(readAuthoredFinalSubmission(token, {...f.read, rawCanonicalPayload: snapshot.compiled.rawCanonicalPayload,
      hashes: {...snapshot.hashes}})).toBe(snapshot);
    expect(() => readAuthoredFinalSubmission(token, {...f.read,
      hashes: {...snapshot.hashes, completed: true} as any})).toThrow('authored_final_submission_mismatch');
  });

  it('detaches mutable compiler/identity inputs and freezes nested invalid entries without JSON cloning', () => {
    const original = JSON.parse(rawDocument()) as any;
    original.contract.claims.push({id: 'bad', text: 'Keep invalid claim.', kind: 'numeric', references: [], semantics: false});
    original.contract.overflow = 0;
    original.contract.negativeZero = 0;
    const raw = JSON.stringify(original).replace('"overflow":0', '"overflow":1e999').replace('"negativeZero":0', '"negativeZero":-0');
    const f = fixture(raw);
    expect(f.input.compiled.canonicalParse.status).toBe('partially_valid');
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(snapshot.compiled.rawCanonicalPayload.overflow).toBe(Infinity);
    expect(Object.is(snapshot.compiled.rawCanonicalPayload.negativeZero, -0)).toBe(true);
    expect(snapshot.compiled.canonicalParse).toEqual(f.input.compiled.canonicalParse);
    expect((snapshot.compiled.rawCanonicalPayload.claims as readonly unknown[])).toHaveLength(2);
    (f.input.compiled.rawCanonicalPayload as any).claims.pop();
    f.input.compiled.body = 'Mutated after handoff';
    f.binding.runId = 'changed-external-binding';
    expect(readAuthoredFinalSubmission(token, f.read)).toBe(snapshot);
    expect(() => { (snapshot.compiled.rawCanonicalPayload as any).overflow = null; }).toThrow(TypeError);
    expect(() => { (snapshot.compiled.occurrences as any[]).push({}); }).toThrow('object is not extensible');
  });

  it.each(['token_json', 'token_spread', 'snapshot', 'completed_boolean'] as const)('does not restore live authority from %s', kind => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    const fake = kind === 'token_json' ? JSON.parse(JSON.stringify(token)) : kind === 'token_spread' ? {...token}
      : kind === 'snapshot' ? snapshot : {kind: token.kind, completed: true, ...snapshot};
    expect(() => readAuthoredFinalSubmission(fake as any, f.read)).toThrow('authored_final_submission_invalid');
    expect(() => claimAuthoredFinalSubmission(fake as any)).toThrow('authored_final_submission_invalid');
    expect(readAuthoredFinalSubmission(token, f.read)).toBe(snapshot);
  });

  it.each(['json', 'spread', 'plain_completed'] as const)('rejects a forged issuer: %s', kind => {
    const f = fixture();
    const fake = kind === 'json' ? JSON.parse(JSON.stringify(f.issuer)) : kind === 'spread' ? {...f.issuer}
      : {kind: 'authored_final_submission_issuer', completed: true};
    expect(() => issueAuthoredFinalSubmission(fake, f.input)).toThrow('authored_final_submission_issuer_invalid');
  });

  it.each(['owner', 'sessionId', 'runId', 'attemptId', 'providerPin', 'authorizationFingerprint',
    'dispatchOrdinal', 'responseId', 'callId', 'representationVersion', 'compilerContractVersion'] as const)
  ('rejects a foreign %s even when every model value and hash is identical', field => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    const binding = {...f.read.binding, [field]: field === 'owner' ? {} : field === 'dispatchOrdinal' ? 5 : 'foreign'};
    expect(() => readAuthoredFinalSubmission(token, {...f.read, binding: binding as any, hashes: {...snapshot.hashes}}))
      .toThrow('authored_final_submission_mismatch');
  });

  it.each(['rawArguments', 'documentJson', 'body', 'rawCanonicalPayload'] as const)('rejects changed %s with copied hashes', field => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    const changed = field === 'rawCanonicalPayload' ? {...f.input.compiled.rawCanonicalPayload, mode: 'need_input'}
      : `${f.read[field]}\n`;
    expect(() => readAuthoredFinalSubmission(token, {...f.read, [field]: changed, hashes: {...snapshot.hashes}}))
      .toThrow('authored_final_submission_mismatch');
  });

  it.each(['rawArgumentsHash', 'documentJsonHash', 'bodyHash', 'rawCanonicalPayloadHash'] as const)
  ('keeps %s distinct without treating it as authority', hash => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, hashes: {...snapshot.hashes, [hash]: 'wrong'}}))
      .toThrow('authored_final_submission_mismatch');
  });

  it.each(['overflow', 'negativeZero'] as const)('rejects ordinary JSON hash collisions for %s', field => {
    const original = JSON.parse(rawDocument());
    original.contract[field] = 0;
    const raw = JSON.stringify(original).replace(`"${field}":0`, `"${field}":${field === 'overflow' ? '1e999' : '-0'}`);
    const f = fixture(raw);
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    const changed = structuredClone(f.input.compiled.rawCanonicalPayload);
    changed[field] = field === 'overflow' ? null : 0;
    expect(analysisDeliveryFingerprint(changed)).toBe(snapshot.hashes.rawCanonicalPayloadHash);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, rawCanonicalPayload: changed, hashes: {...snapshot.hashes}}))
      .toThrow('authored_final_submission_mismatch');
  });

  it.each(['rawArguments', 'documentJson', 'body'] as const)('rejects a UTF-8 collision in %s using exact UTF-16 strings', field => {
    // Literal unpaired surrogate in valid JSON, then an unescaped occurrence in
    // the outer arguments too: both decoded layers remain exactly that string.
    const documentJson = rawDocument('\ud800').replace(/\\ud800/g, '\ud800');
    const rawArguments = JSON.stringify({documentJson}).replace(/\\ud800/g, '\ud800');
    const f = fixture(documentJson, rawArguments);
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    for (const replacement of ['\ud801', '\ufffd']) {
      const changed = f.read[field].replace('\ud800', replacement);
      expect(changed).not.toBe(f.read[field]);
      expect(analysisDeliveryFingerprint(changed)).toBe(analysisDeliveryFingerprint(f.read[field]));
      expect(() => readAuthoredFinalSubmission(token, {...f.read, [field]: changed, hashes: {...snapshot.hashes}}))
        .toThrow('authored_final_submission_mismatch');
    }
  });

  it.each(['body', 'raw_object', 'json_clone', 'occurrence', 'private_raw', 'outer_extra', 'outer_reencoded', 'limit'] as const)
  ('does not issue from mutated or misbound pending compiler material: %s', mutation => {
    const f = fixture();
    if (mutation === 'body') f.input.compiled.body = 'Not the authored text';
    if (mutation === 'raw_object') f.input.compiled.rawCanonicalPayload.mode = 'need_input';
    if (mutation === 'json_clone') {
      const original = JSON.parse(rawDocument()); original.contract.overflow = 0;
      const raw = JSON.stringify(original).replace('"overflow":0', '"overflow":1e999');
      const lossy = fixture(raw);
      f.input.documentJson = lossy.input.documentJson;
      f.input.rawArguments = lossy.input.rawArguments;
      f.input.compiled = JSON.parse(JSON.stringify(lossy.input.compiled));
    }
    if (mutation === 'occurrence') f.input.compiled.occurrences[0].startUtf16++;
    if (mutation === 'private_raw') f.input.compiled.privateRawDocument += ' ';
    if (mutation === 'outer_extra') f.input.rawArguments = JSON.stringify({documentJson: f.input.documentJson, completed: true});
    if (mutation === 'outer_reencoded') f.input.rawArguments = JSON.stringify({documentJson: JSON.parse(f.input.documentJson)});
    if (mutation === 'limit') f.input.rawArguments = ' '.repeat(CONCLUSION_AUTHORING_LIMITS.utf8Bytes + 1);
    expect(() => issueAuthoredFinalSubmission(f.issuer, f.input)).toThrow('authored_final_submission_invalid_input');
    expect(() => issueAuthoredFinalSubmission(f.issuer, fixture().input)).toThrow('authored_final_submission_issuer_invalid');
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid dispatch ordinals: %p', dispatchOrdinal => {
    const f = fixture();
    expect(() => issueAuthoredFinalSubmission(f.issuer, {...f.input, dispatchOrdinal}))
      .toThrow('authored_final_submission_invalid_input');
  });

  it.each([
    ['compiled', 2], ['rawArguments', 4], ['documentJson', 4],
    ['dispatchOrdinal', 2], ['responseId', 1], ['callId', 1],
  ] as const)('never signs later unvalidated %s values from a switching input getter', (field, switchAfter) => {
    const f = fixture();
    const original = f.input[field];
    const replacement = field === 'compiled'
      ? {...f.input.compiled, body: 'UNVALIDATED_BODY', rawCanonicalPayload: {claims: ['UNVALIDATED_CONTRACT']}}
      : field === 'dispatchOrdinal' ? 999 : 'UNVALIDATED_VALUE';
    let reads = 0;
    Object.defineProperty(f.input, field, {get: () => ++reads <= switchAfter ? original : replacement});
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(reads).toBe(1);
    expect(snapshot.rawArguments).toBe(f.read.rawArguments);
    expect(snapshot.documentJson).toBe(f.read.documentJson);
    expect(snapshot.compiled.body).toBe(f.read.body);
    expect(snapshot.compiled.rawCanonicalPayload).toEqual(f.read.rawCanonicalPayload);
    expect(snapshot.binding).toEqual({sessionId: 'session', runId: 'run', attemptId: 'attempt',
      providerPin: 'provider-model-protocol-pin', authorizationFingerprint: 'authorized-scope',
      dispatchOrdinal: 4, responseId: 'response', callId: 'call',
      representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
      compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION});
  });

  it('clones only the locally compiled result when a nested compiler getter mutates after comparison', () => {
    const f = fixture();
    const originalBody = f.input.compiled.body;
    let reads = 0;
    Object.defineProperty(f.input.compiled, 'body', {enumerable: true,
      get: () => ++reads === 1 ? originalBody : 'UNVALIDATED_BODY'});
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(reads).toBe(1);
    expect(snapshot.compiled.body).toBe(originalBody);
    expect(snapshot.hashes.bodyHash).toBe(analysisDeliveryFingerprint(originalBody));
    expect(snapshot.compiled.rawCanonicalPayload).toEqual(f.read.rawCanonicalPayload);
  });

  it('treats a second issue as a conflicting submission, never last-wins', () => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    expect(() => issueAuthoredFinalSubmission(f.issuer, f.input)).toThrow('authored_final_submission_already_issued');
    expect(() => readAuthoredFinalSubmission(token, f.read)).toThrow('authored_final_submission_invalid');
  });
});

describe('submission handoff and revocation lifetime', () => {
  it('survives normal SDK attempt cleanup, attaches once and releases only at finalization disposal', () => {
    const f = fixture();
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    f.owner.attemptActive = false;
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    claimAuthoredFinalSubmission(token);
    expect(() => claimAuthoredFinalSubmission(token)).toThrow('authored_final_submission_already_claimed');
    expect(readAuthoredFinalSubmission(token, f.read)).toBe(snapshot);
    revokeAuthoredFinalSubmission(token);
    revokeAuthoredFinalSubmission(token);
    expect(() => readAuthoredFinalSubmission(token, f.read)).toThrow('authored_final_submission_invalid');
  });

  it('rejects a retired attempt before issue without exposing its error text', () => {
    const f = fixture(); f.owner.attemptActive = false;
    expect(() => issueAuthoredFinalSubmission(f.issuer, f.input)).toThrow('authored_final_submission_inactive');
    f.owner.attemptActive = true;
    expect(() => issueAuthoredFinalSubmission(f.issuer, f.input)).toThrow('authored_final_submission_issuer_invalid');
  });

  it.each(['before_issue', 'read', 'claim'] as const)('permanently revokes on product cancellation/authorization loss at %s', point => {
    const f = fixture();
    if (point === 'before_issue') {
      f.owner.active = false;
      expect(() => issueAuthoredFinalSubmission(f.issuer, f.input)).toThrow('authored_final_submission_inactive');
      return;
    }
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    f.owner.active = false;
    expect(() => point === 'read' ? readAuthoredFinalSubmission(token, f.read) : claimAuthoredFinalSubmission(token))
      .toThrow('authored_final_submission_inactive');
    f.owner.active = true;
    expect(() => readAuthoredFinalSubmission(token, f.read)).toThrow('authored_final_submission_invalid');
  });

  it('revokes pending or handed-off material on explicit conflicting dispatch and does not affect a new run', () => {
    const pending = fixture();
    revokeAuthoredFinalSubmissionIssuer(pending.issuer);
    expect(() => issueAuthoredFinalSubmission(pending.issuer, pending.input)).toThrow('authored_final_submission_issuer_invalid');
    const old = fixture();
    const token = issueAuthoredFinalSubmission(old.issuer, old.input);
    revokeAuthoredFinalSubmissionIssuer(old.issuer);
    revokeAuthoredFinalSubmissionIssuer(old.issuer);
    expect(() => readAuthoredFinalSubmission(token, old.read)).toThrow('authored_final_submission_invalid');
    const next = fixture();
    const nextToken = issueAuthoredFinalSubmission(next.issuer, next.input);
    expect(() => readAuthoredFinalSubmission(nextToken, old.read)).toThrow('authored_final_submission_mismatch');
    expect(readAuthoredFinalSubmission(nextToken, next.read).compiled.body).toBe(next.input.compiled.body);
  });

  it('rejects a plain completed flag in place of live owner checks', () => {
    const f = fixture();
    expect(() => createAuthoredFinalSubmissionIssuer({binding: f.binding,
      assertAttemptCurrent: true, assertCurrent: true} as any)).toThrow('authored_final_submission_invalid_binding');
  });
});


function nativeFixture(numberLiteral = '7') {
  // Raw number spelling is intentionally not round-tripped through JSON.stringify.
  const rawArguments = `{"document":{"representationVersion":"authored_claim_document@2",
    "referenceDictionary":[],"semanticFrames":[{"predicate":"numeric.cell","polarity":"affirmed",
    "discourse":"asserted","quantifier":"one","modality":"certain","conditions":null,"population":"cited_rows"}],
    "contract":{"mode":"focused_answer","conclusions":null,"clusters":null,"evidenceChain":null,
    "uncertainties":null,"nextSteps":null,"relationProposals":null,"sourceClaimBindings":null,"metadata":null,
    "claims":[{"id":"number","conclusionId":null,"text":"Original value","kind":"numeric","references":[],
    "artifactRefs":null,"relationRefs":null,"supportLevel":null,"semantics":{"frameIndex":0,"subjectRefs":null,
    "objectRefs":null,"timeRangeNs":null,"numeric":{"operator":"eq","value":${numberLiteral},"unit":"ms","presentation":null}}}]},
    "bodyParts":["Original literal ",{"claimText":"number"}]}}`;
  const nativeDocument = JSON.parse(rawArguments).document;
  const compiled = compileAuthoredClaimObject(nativeDocument);
  if (compiled.status !== 'compiled') throw new Error('Native fixture must compile');
  const owner = {active: true, attemptActive: true};
  const binding = {owner, sessionId: 'native-session', runId: 'native-run', attemptId: 'native-attempt',
    providerPin: 'native-pin', authorizationFingerprint: 'native-auth'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    assertCurrent: () => {if (!owner.active) throw new Error('closed');},
    assertAttemptCurrent: () => {if (!owner.attemptActive) throw new Error('closed');}});
  const dispatch = {dispatchOrdinal: 1, responseId: 'native-response', callId: 'native-call'};
  const input = {...dispatch, rawArguments, nativeDocument, compiled};
  const read: AuthoredFinalSubmissionV2ReadInput = {binding: {...binding, ...dispatch,
    representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION},
    rawArguments, nativeDocument: structuredClone(nativeDocument), body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)};
  return {owner, issuer, input, read, binding};
}

describe('versioned native-object authored snapshots', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it.each(['7', '1e999', '-0'])('retains original native IR and canonical value %s without a fake string document', literal => {
    const f = nativeFixture(literal), token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    assertFrozen(snapshot);
    expect(snapshot).not.toHaveProperty('documentJson');
    expect(snapshot.compiled).not.toHaveProperty('privateRawDocument');
    expect(Object.keys(snapshot.hashes).sort()).toEqual(['bodyHash', 'rawArgumentsHash', 'rawCanonicalPayloadHash']);
    expect(snapshot.rawArguments).toBe(f.input.rawArguments);
    expect(snapshot.nativeDocument).toEqual(f.input.nativeDocument);
    expect(snapshot.nativeDocument).toBe(snapshot.compiled.privateNativeDocument);
    const value = (snapshot.compiled.rawCanonicalPayload.claims as Array<{semantics: {numeric: {value: number}}}>)[0].semantics.numeric.value;
    expect(Object.is(value, literal === '1e999' ? Infinity : Number(literal))).toBe(true);
    if (literal === '1e999') expect(snapshot.compiled.canonicalParse.status).not.toBe('valid');
    f.owner.attemptActive = false;
    const fromIssued = {...f.read, nativeDocument: snapshot.nativeDocument, rawCanonicalPayload: snapshot.compiled.rawCanonicalPayload};
    expect(readAuthoredFinalSubmission(token, fromIssued)).toBe(snapshot);
    f.input.nativeDocument.bodyParts.push('later mutation');
    expect(snapshot.compiled.body).toBe(f.read.body);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, nativeDocument: structuredClone(f.input.nativeDocument)})).toThrow('mismatch');
    f.owner.active = false;
    expect(() => readAuthoredFinalSubmission(token, fromIssued)).toThrow('inactive');
  });

  it.each(['raw', 'native', 'body', 'canonical', 'version', 'compiler', 'extra_hash', 'hybrid'])('rejects changed read binding: %s', field => {
    const f = nativeFixture('-0'), token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    let read: AuthoredFinalSubmissionV2ReadInput = {...f.read};
    if (field === 'raw') read.rawArguments += ' ';
    if (field === 'native') read.nativeDocument = {...f.input.nativeDocument, bodyParts: ['different']};
    if (field === 'body') read.body += ' ';
    if (field === 'canonical') read.rawCanonicalPayload = {...snapshot.compiled.rawCanonicalPayload, claims: []};
    if (field === 'version') read = {...read, binding: {...read.binding, representationVersion: 'authored_claim_document@1'}} as unknown as AuthoredFinalSubmissionV2ReadInput;
    if (field === 'compiler') read = {...read, binding: {...read.binding, compilerContractVersion: 'authored_claim_document_compiler@1'}} as unknown as AuthoredFinalSubmissionV2ReadInput;
    if (field === 'extra_hash') read.hashes = {...snapshot.hashes, documentJsonHash: 'not-native'} as typeof read.hashes;
    if (field === 'hybrid') read = {...read, documentJson: '{}'} as AuthoredFinalSubmissionV2ReadInput;
    expect(() => readAuthoredFinalSubmission(token, read)).toThrow('mismatch');
  });

  it.each(['v1_issuer', 'v1_material', 'hybrid', 'native_changed', 'compiled_changed'])('refuses wrong issued representation: %s', change => {
    const f = nativeFixture();
    let issuer = f.issuer, input: Parameters<typeof issueAuthoredFinalSubmission>[1] = f.input;
    if (change === 'v1_issuer') issuer = fixture().issuer;
    if (change === 'v1_material') input = fixture().input;
    if (change === 'hybrid') input = {...f.input, documentJson: '{}'};
    if (change === 'native_changed') input = {...f.input, nativeDocument: {...f.input.nativeDocument, bodyParts: ['changed']}};
    if (change === 'compiled_changed') input = {...f.input, compiled: {...f.input.compiled, body: 'changed'}};
    expect(() => issueAuthoredFinalSubmission(issuer, input)).toThrow('invalid_input');
  });

  it.each(['proxy', 'accessor', 'cycle'])('rejects hostile native material before reading values: %s', kind => {
    const f = nativeFixture(); let reads = 0;
    let nativeDocument: unknown;
    if (kind === 'proxy') nativeDocument = new Proxy(f.input.nativeDocument, {ownKeys: () => {reads++; throw new Error('private');}});
    if (kind === 'accessor') nativeDocument = {get representationVersion() {reads++; throw new Error('private');}};
    if (kind === 'cycle') {const value: Record<string, unknown> = {}; value.self = value; nativeDocument = value;}
    expect(() => issueAuthoredFinalSubmission(f.issuer, {...f.input, nativeDocument})).toThrow('invalid_input');
    expect(reads).toBe(0);
  });

  it('does not accept a JSON clone that erases invalid numbers or a serialized token', () => {
    const f = nativeFixture('1e999'), token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, nativeDocument: JSON.parse(JSON.stringify(f.input.nativeDocument))})).toThrow('mismatch');
    expect(() => readAuthoredFinalSubmission(JSON.parse(JSON.stringify(token)), f.read)).toThrow('invalid');
    claimAuthoredFinalSubmission(token);
    expect(() => claimAuthoredFinalSubmission(token)).toThrow('already_claimed');
    revokeAuthoredFinalSubmission(token);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, nativeDocument: snapshot.nativeDocument})).toThrow('invalid');
  });
});


describe('native read preflight before strict equality', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it.each(['root_getter', 'nested_getter', 'root_proxy', 'nested_proxy', 'revoked_proxy'] as const)
    ('rejects an equal %s without executing caller behavior', kind => {
      const f = nativeFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input);
      const snapshot = readAuthoredFinalSubmission(token, f.read);
      const clone = structuredClone(snapshot.nativeDocument) as Record<string, unknown>;
      let executions = 0;
      const proxy = (target: object) => new Proxy(target, {
        get: (target, key, receiver) => {executions++; return Reflect.get(target, key, receiver);},
        ownKeys: target => {executions++; return Reflect.ownKeys(target);},
        getPrototypeOf: target => {executions++; return Reflect.getPrototypeOf(target);},
      });
      let nativeDocument: unknown = clone;
      if (kind === 'root_getter') {
        const original = clone.representationVersion;
        Object.defineProperty(clone, 'representationVersion', {enumerable: true, get() {executions++; return original;}});
      }
      if (kind === 'nested_getter') {
        const target = clone.contract as Record<string, unknown>, original = target.mode;
        Object.defineProperty(target, 'mode', {enumerable: true, get() {executions++; return original;}});
      }
      if (kind === 'root_proxy') nativeDocument = proxy(clone);
      if (kind === 'nested_proxy') clone.contract = proxy(clone.contract as object);
      if (kind === 'revoked_proxy') {const revoked = Proxy.revocable(clone, {}); revoked.revoke(); nativeDocument = revoked.proxy;}
      let failure: unknown;
      try {readAuthoredFinalSubmission(token, {...f.read, nativeDocument});} catch (error) {failure = error;}
      expect({failure: failure instanceof Error ? failure.message : undefined, executions})
        .toEqual({failure: 'authored_final_submission_mismatch', executions: 0});
    });

  it('accepts the issued identity and a separate legal lossless clone', () => {
    const f = nativeFixture('-0'), token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(readAuthoredFinalSubmission(token, {...f.read, nativeDocument: snapshot.nativeDocument})).toBe(snapshot);
    const clone = structuredClone(snapshot.nativeDocument);
    expect(clone).not.toBe(snapshot.nativeDocument);
    expect(readAuthoredFinalSubmission(token, {...f.read, nativeDocument: clone})).toBe(snapshot);
  });
});



it('keeps the scoped clone fixture lossless, alias-preserving and reversible', () => {
  const original = globalThis.structuredClone;
  const shared = {values: [Infinity, -0, '\ud800']};
  const source = {first: shared, second: shared, cycle: undefined as unknown, date: new Date(123)};
  source.cycle = source;
  const nativeDatePrototype = Object.getPrototypeOf(original(source.date));
  const restore = installCurrentRealmStructuredCloneForTest();
  try {
    const copied = structuredClone(source);
    expect(copied).not.toBe(source); expect(copied.first).not.toBe(shared);
    expect(copied.first).toBe(copied.second); expect(copied.cycle).toBe(copied);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(copied.first.values)).toBe(Array.prototype);
    expect(Object.is(copied.first.values[0], Infinity)).toBe(true);
    expect(Object.is(copied.first.values[1], -0)).toBe(true);
    expect(copied.first.values[2]).toBe('\ud800');
    expect(Object.getPrototypeOf(copied.date)).toBe(nativeDatePrototype);
    expect(copied.date.getTime()).toBe(123);
    expect(source.first).toBe(shared); expect(source.cycle).toBe(source);
  } finally {restore();}
  expect(globalThis.structuredClone).toBe(original);
});


function assistantFixture(numberLiteral = '7', overrideText?: string) {
  const original = nativeFixture(numberLiteral);
  revokeAuthoredFinalSubmissionIssuer(original.issuer);
  // The same independent document fixture is now authored as whole assistant text;
  // no function call/ACK is fabricated or supplied to this source variant.
  const rawAssistantText = overrideText ?? ` \n${original.input.rawArguments}\n `;
  const nativeDocument = JSON.parse(rawAssistantText).document;
  const compiled = compileAuthoredClaimObject(nativeDocument);
  if (compiled.status !== 'compiled') throw new Error('Assistant fixture must compile');
  const {owner, binding} = original;
  const issuer = createAuthoredFinalSubmissionIssuer({binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    sourcePolicy: 'function_or_assistant_json', assertCurrent: () => {if (!owner.active) throw new Error('closed');},
    assertAttemptCurrent: () => {if (!owner.attemptActive) throw new Error('closed');}});
  const dispatch = {dispatchOrdinal: 1, responseId: 'assistant-response', messageId: 'assistant-response'};
  const input: AuthoredFinalSubmissionAssistantV2IssueInput = {sourceKind: 'assistant_json', ...dispatch, rawAssistantText, nativeDocument, compiled};
  const read: AuthoredFinalSubmissionAssistantV2ReadInput = {sourceKind: 'assistant_json', binding: {...binding, ...dispatch,
    representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION},
    rawAssistantText, nativeDocument: structuredClone(nativeDocument), body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)};
  return {owner, binding, issuer, input, read};
}

describe('independent assistant JSON source authority', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it('issues a disjoint lossless assistant snapshot without fabricated function identities', () => {
    const f = assistantFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input);
    const snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(snapshot.sourceKind).toBe('assistant_json'); expect(snapshot.rawAssistantText).toBe(f.input.rawAssistantText);
    expect(snapshot.compiled).toEqual(f.input.compiled); expect(snapshot.compiled).not.toBe(f.input.compiled); assertFrozen(snapshot);
    expect(snapshot.hashes).toEqual({rawAssistantTextHash: analysisDeliveryFingerprint(f.input.rawAssistantText),
      bodyHash: analysisDeliveryFingerprint(f.input.compiled.body), rawCanonicalPayloadHash: analysisDeliveryFingerprint(f.input.compiled.rawCanonicalPayload)});
    for (const key of ['callId', 'rawArguments', 'documentJson', 'rawArgumentsHash', 'handlerAck']) {
      expect(snapshot).not.toHaveProperty(key); expect(snapshot.binding).not.toHaveProperty(key); expect(snapshot.hashes).not.toHaveProperty(key);
    }
    expect(snapshot.binding).not.toHaveProperty('owner'); expect(Object.isFrozen(f.owner)).toBe(false);
    f.owner.attemptActive = false; expect(readAuthoredFinalSubmission(token, f.read)).toBe(snapshot);
    claimAuthoredFinalSubmission(token); expect(() => claimAuthoredFinalSubmission(token)).toThrow('already_claimed');
    revokeAuthoredFinalSubmission(token); expect(() => readAuthoredFinalSubmission(token, f.read)).toThrow('invalid');
  });

  it.each([undefined, 'function_only'] as const)('never widens issuer policy from a submitted source tag: %s', sourcePolicy => {
    const f = assistantFixture();
    const options: Parameters<typeof createAuthoredFinalSubmissionIssuer>[0] = {binding: f.binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      sourcePolicy: sourcePolicy as AuthoredFinalSubmissionSourcePolicy | undefined, assertCurrent() {}, assertAttemptCurrent() {}};
    const issuer = createAuthoredFinalSubmissionIssuer(options); options.sourcePolicy = 'function_or_assistant_json';
    expect(() => issueAuthoredFinalSubmission(issuer, f.input)).toThrow('invalid_input');
    expect(() => createAuthoredFinalSubmissionIssuer({...options, representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION})).toThrow('invalid_binding');
  });

  it('keeps a dual issuer’s function branch on the complete original function snapshot shape', () => {
    const old = nativeFixture(), dual = createAuthoredFinalSubmissionIssuer({binding: old.binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      sourcePolicy: 'function_or_assistant_json', assertCurrent() {}, assertAttemptCurrent() {}});
    const oldSnapshot = readAuthoredFinalSubmission(issueAuthoredFinalSubmission(old.issuer, old.input), old.read);
    const snapshot = readAuthoredFinalSubmission(issueAuthoredFinalSubmission(dual, old.input), old.read);
    expect(snapshot).toEqual(oldSnapshot); expect(JSON.stringify(snapshot)).toBe(JSON.stringify(oldSnapshot));
    expect(snapshot).not.toHaveProperty('sourceKind'); expect(snapshot).not.toHaveProperty('rawAssistantText');
    expect(snapshot.binding).toHaveProperty('callId', 'native-call');
  });

  it.each(['callId', 'rawArguments', 'documentJson', 'rawArgumentsHash', 'handlerAck', 'completed'] as const)
    ('rejects a function/authority-only field in the assistant source envelope: %s', field => {
      const f = assistantFixture(); expect(() => issueAuthoredFinalSubmission(f.issuer, {...f.input, [field]: 'not-authority'})).toThrow('invalid_input');
    });

  it.each(['prose', 'fence', 'two_objects', 'extra_key', 'array'] as const)('parses only the complete original assistant JSON envelope: %s', kind => {
    const f = assistantFixture();
    const rawAssistantText = kind === 'prose' ? 'Assistant prose' : kind === 'fence' ? `\`\`\`json\n${f.input.rawAssistantText}\n\`\`\`` :
      kind === 'two_objects' ? f.input.rawAssistantText + '{}' : kind === 'array' ? `[${f.input.rawAssistantText}]` :
        JSON.stringify({...JSON.parse(f.input.rawAssistantText), unexpected: true});
    expect(() => issueAuthoredFinalSubmission(f.issuer, {...f.input, rawAssistantText})).toThrow('invalid_input');
  });

  it.each(['sourceKind', 'rawAssistantText', 'nativeDocument', 'compiled', 'root_proxy', 'revoked_proxy', 'native_proxy', 'compiled_getter', 'compiled_proxy', 'symbol_extra', 'nonenum_extra'] as const)
    ('does not execute source-envelope or compiled-material traps: %s', kind => {
      const f = assistantFixture(); let executions = 0; let input: unknown = {...f.input};
      const proxy = (value: object) => new Proxy(value, {get() {executions++; throw new Error('private');},
        ownKeys() {executions++; throw new Error('private');}, getPrototypeOf() {executions++; throw new Error('private');}});
      if (['sourceKind', 'rawAssistantText', 'nativeDocument', 'compiled'].includes(kind)) {
        Object.defineProperty(input, kind, {enumerable: true, get() {executions++; return f.input[kind as keyof typeof f.input];}});
      } else if (kind === 'root_proxy') input = proxy(input as object);
      else if (kind === 'revoked_proxy') {const revoked = Proxy.revocable(input as object, {}); revoked.revoke(); input = revoked.proxy;}
      else if (kind === 'native_proxy') input = {...f.input, nativeDocument: proxy(f.input.nativeDocument as object)};
      else if (kind === 'compiled_proxy') input = {...f.input, compiled: proxy(f.input.compiled)};
      else if (kind === 'symbol_extra') Object.defineProperty(input, Symbol('private'), {value: true});
      else if (kind === 'nonenum_extra') Object.defineProperty(input, 'extra', {value: true, enumerable: false});
      else {
        const altered = {...f.input.compiled}; Object.defineProperty(altered, 'body', {enumerable: true, get() {executions++; return f.input.compiled.body;}});
        input = {...f.input, compiled: altered};
      }
      expect(() => issueAuthoredFinalSubmission(f.issuer, input as AuthoredFinalSubmissionAssistantV2IssueInput)).toThrow('invalid_input');
      expect(executions).toBe(0);
    });

  it.each(['owner', 'sessionId', 'runId', 'attemptId', 'providerPin', 'authorizationFingerprint', 'dispatchOrdinal', 'responseId', 'messageId',
    'representationVersion', 'compilerContractVersion'] as const)('binds the actual assistant %s independently', field => {
    const f = assistantFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input), snapshot = readAuthoredFinalSubmission(token, f.read);
    const binding = {...f.read.binding, [field]: field === 'owner' ? {} : field === 'dispatchOrdinal' ? 2 : 'foreign'};
    expect(() => readAuthoredFinalSubmission(token, {...f.read, binding: binding as typeof f.read.binding, hashes: {...snapshot.hashes}})).toThrow('mismatch');
  });

  it.each(['sourceKind', 'rawAssistantText', 'nativeDocument', 'body', 'rawCanonicalPayload'] as const)('rejects changed %s with copied source hashes', field => {
    const f = assistantFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input), snapshot = readAuthoredFinalSubmission(token, f.read);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, [field]: field.includes('Document') || field === 'rawCanonicalPayload' ? {} : 'changed',
      hashes: {...snapshot.hashes}} as AuthoredFinalSubmissionAssistantV2ReadInput)).toThrow('mismatch');
  });

  it.each(['-0', '1e999'])('preserves canonical-invalid/original numeric %s and refuses a normalized substitute', literal => {
    const f = assistantFixture(literal), token = issueAuthoredFinalSubmission(f.issuer, f.input), snapshot = readAuthoredFinalSubmission(token, f.read);
    const original = literal === '-0' ? -0 : Infinity;
    const value = (snapshot.compiled.rawCanonicalPayload.claims as any[])[0].semantics.numeric.value;
    expect(Object.is(value, original)).toBe(true); expect(snapshot.compiled.canonicalParse).toEqual(f.input.compiled.canonicalParse);
    if (literal === '1e999') expect(snapshot.compiled.canonicalParse.status).toBe('partially_valid');
    const changed = structuredClone(snapshot.compiled.rawCanonicalPayload) as any;
    changed.claims[0].semantics.numeric.value = literal === '-0' ? 0 : null;
    expect(() => readAuthoredFinalSubmission(token, {...f.read, rawCanonicalPayload: changed, hashes: {...snapshot.hashes}})).toThrow('mismatch');
    const other = assistantFixture(literal), fake = structuredClone(other.input.compiled);
    (fake.rawCanonicalPayload.claims as any[])[0].semantics.numeric.value = literal === '-0' ? 0 : null;
    expect(() => issueAuthoredFinalSubmission(other.issuer, {...other.input, compiled: fake})).toThrow('invalid_input');
  });

  it('does not treat UTF8 hash equality as equality of original UTF16 assistant text or body', () => {
    const base = nativeFixture(), text = base.input.rawArguments.replace('Original literal ', 'Original literal \ud800');
    revokeAuthoredFinalSubmissionIssuer(base.issuer);
    const f = assistantFixture('7', text), token = issueAuthoredFinalSubmission(f.issuer, f.input), snapshot = readAuthoredFinalSubmission(token, f.read);
    const changedText = text.replace('\ud800', '\ufffd'), changedBody = f.read.body.replace('\ud800', '\ufffd');
    expect(analysisDeliveryFingerprint(changedText)).toBe(snapshot.hashes.rawAssistantTextHash);
    expect(analysisDeliveryFingerprint(changedBody)).toBe(snapshot.hashes.bodyHash);
    expect(() => readAuthoredFinalSubmission(token, {...f.read, rawAssistantText: changedText, hashes: {...snapshot.hashes}})).toThrow('mismatch');
    expect(() => readAuthoredFinalSubmission(token, {...f.read, body: changedBody, hashes: {...snapshot.hashes}})).toThrow('mismatch');
  });

  it('does not impose a new sum cap over duplicate raw/native/expanded compiler material', () => {
    const base = nativeFixture(); revokeAuthoredFinalSubmissionIssuer(base.issuer);
    const document = JSON.parse(base.input.rawArguments).document;
    document.bodyParts = ['x'.repeat(300_000), 'y'.repeat(300_000)];
    const f = assistantFixture('7', JSON.stringify({document}));
    expect(Buffer.byteLength(f.input.rawAssistantText)).toBeLessThan(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    expect(Buffer.byteLength(JSON.stringify(f.input.compiled))).toBeGreaterThan(CONCLUSION_AUTHORING_LIMITS.utf8Bytes);
    const token = issueAuthoredFinalSubmission(f.issuer, f.input);
    expect(readAuthoredFinalSubmission(token, f.read).compiled.body).toBe(f.input.compiled.body);
  });

  it('rejects cross-source reads and revokes a prior source on a second issue attempt', () => {
    const f = assistantFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input), old = nativeFixture();
    expect(() => readAuthoredFinalSubmission(token, old.read)).toThrow('mismatch');
    const oldToken = issueAuthoredFinalSubmission(old.issuer, old.input);
    expect(() => readAuthoredFinalSubmission(oldToken, f.read)).toThrow('mismatch');
    expect(() => issueAuthoredFinalSubmission(f.issuer, old.input)).toThrow('already_issued');
    expect(() => readAuthoredFinalSubmission(token, f.read)).toThrow('invalid');
    const current = assistantFixture(), liveToken = issueAuthoredFinalSubmission(current.issuer, current.input);
    current.owner.active = false; expect(() => readAuthoredFinalSubmission(liveToken, current.read)).toThrow('inactive');
  });

  it('checks read-envelope data descriptors before any getter or proxy executes', () => {
    const f = assistantFixture(), token = issueAuthoredFinalSubmission(f.issuer, f.input); let executions = 0;
    const getter = {...f.read}; Object.defineProperty(getter, 'binding', {enumerable: true, get() {executions++; return f.read.binding;}});
    expect(() => readAuthoredFinalSubmission(token, getter)).toThrow('mismatch');
    const proxy = new Proxy(f.read, {get() {executions++; throw new Error('private');}, ownKeys() {executions++; throw new Error('private');}});
    expect(() => readAuthoredFinalSubmission(token, proxy)).toThrow('mismatch'); expect(executions).toBe(0);
  });
});
