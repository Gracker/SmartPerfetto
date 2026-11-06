// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument} from '../../agent/core/authoredClaimDocument';
import {CONCLUSION_AUTHORING_LIMITS} from '../../agent/core/conclusionAuthoring';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {
  AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION,
  claimAuthoredFinalSubmission,
  createAuthoredFinalSubmissionIssuer,
  issueAuthoredFinalSubmission,
  readAuthoredFinalSubmission,
  revokeAuthoredFinalSubmission,
  revokeAuthoredFinalSubmissionIssuer,
  type AuthoredFinalSubmissionReadInput,
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
  const read: AuthoredFinalSubmissionReadInput = {binding: {...binding, dispatchOrdinal: 4, responseId: 'response', callId: 'call',
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
