// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {isDeepStrictEqual} from 'node:util';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument,
  type AuthoredClaimDocumentResult} from '../agent/core/authoredClaimDocument';
import {CONCLUSION_AUTHORING_LIMITS} from '../agent/core/conclusionAuthoring';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';

export const AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION = 'authored_claim_document_compiler@1';
export const AUTHORED_FINAL_SUBMISSION_PENDING_ACK = '{"status":"pending","kind":"authored_final_submission"}';
type Compiled = Extract<AuthoredClaimDocumentResult, {status: 'compiled'}>;
type Frozen<T> = T extends object ? {readonly [Key in keyof T]: Frozen<T[Key]>} : T;

export interface AuthoredFinalSubmissionOwnerBinding {
  owner: object;
  sessionId: string;
  runId: string;
  attemptId: string;
  providerPin: string;
  authorizationFingerprint: string;
}
export interface AuthoredFinalSubmissionBinding extends AuthoredFinalSubmissionOwnerBinding {
  dispatchOrdinal: number;
  responseId: string;
  callId: string;
  representationVersion: typeof AUTHORED_CLAIM_DOCUMENT_VERSION;
  compilerContractVersion: typeof AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION;
}
export interface AuthoredFinalSubmissionHashes {
  rawArgumentsHash: string;
  documentJsonHash: string;
  bodyHash: string;
  rawCanonicalPayloadHash: string;
}
export interface IssuedAuthoredFinalSubmission {readonly kind: 'authored_final_submission'}
export interface AuthoredFinalSubmissionIssuer {readonly kind: 'authored_final_submission_issuer'}
export type AuthoredFinalSubmissionSnapshot = Frozen<{
  binding: Omit<AuthoredFinalSubmissionBinding, 'owner'>;
  rawArguments: string;
  documentJson: string;
  compiled: Compiled;
  hashes: AuthoredFinalSubmissionHashes;
}>;
export interface AuthoredFinalSubmissionReadInput {
  binding: AuthoredFinalSubmissionBinding;
  rawArguments: string;
  documentJson: string;
  body: string;
  rawCanonicalPayload: unknown;
  hashes?: AuthoredFinalSubmissionHashes;
}

interface State {
  issuer: AuthoredFinalSubmissionIssuer;
  binding: AuthoredFinalSubmissionOwnerBinding;
  assertAttemptCurrent?: () => void;
  assertCurrent?: () => void;
  used: boolean;
  claimed: boolean;
  revoked: boolean;
  token?: IssuedAuthoredFinalSubmission;
  snapshot?: AuthoredFinalSubmissionSnapshot;
}
const issuers = new WeakMap<AuthoredFinalSubmissionIssuer, State>();
const submissions = new WeakMap<IssuedAuthoredFinalSubmission, State>();
const ownerFields = ['sessionId', 'runId', 'attemptId', 'providerPin', 'authorizationFingerprint'] as const;
const submissionFields = ['dispatchOrdinal', 'responseId', 'callId', 'representationVersion', 'compilerContractVersion'] as const;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Clone values, not their JSON serialization: Infinity, -0 and invalid items survive. */
function immutable<T>(value: T): Frozen<T> {
  const copied = structuredClone(value);
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    Object.values(item).forEach(visit);
    Object.freeze(item);
  };
  visit(copied);
  return copied as Frozen<T>;
}

function revoke(state: State): void {
  state.revoked = true;
  issuers.delete(state.issuer);
  if (state.token) submissions.delete(state.token);
  state.snapshot = undefined;
  state.assertAttemptCurrent = undefined;
  state.assertCurrent = undefined;
}

function assertCurrent(state: State, attempt = false): void {
  try {
    if (state.revoked || !state.assertCurrent || attempt && !state.assertAttemptCurrent) throw new Error();
    state.assertCurrent();
    if (attempt) state.assertAttemptCurrent!();
    if (state.revoked) throw new Error();
  } catch {
    revoke(state);
    throw new Error('authored_final_submission_inactive');
  }
}

/** Server capability only. The adapter, not a caller boolean, owns its native gate. */
export function createAuthoredFinalSubmissionIssuer(input: {
  binding: AuthoredFinalSubmissionOwnerBinding;
  assertAttemptCurrent(): void;
  /** Run/finalization lifetime; never the SDK's normal cleanup signal. */
  assertCurrent(): void;
}): AuthoredFinalSubmissionIssuer {
  const binding = input.binding;
  if (!binding || binding.owner === null || typeof binding.owner !== 'object' ||
      ownerFields.some(field => !nonempty(binding[field])) ||
      typeof input.assertAttemptCurrent !== 'function' || typeof input.assertCurrent !== 'function') {
    throw new Error('authored_final_submission_invalid_binding');
  }
  const issuer: AuthoredFinalSubmissionIssuer = Object.freeze({kind: 'authored_final_submission_issuer'});
  // Copy identity strings, but never clone or freeze the live owner/lease itself.
  const state: State = {issuer, binding: Object.freeze({owner: binding.owner, sessionId: binding.sessionId,
    runId: binding.runId, attemptId: binding.attemptId, providerPin: binding.providerPin,
    authorizationFingerprint: binding.authorizationFingerprint}), assertCurrent: input.assertCurrent,
    assertAttemptCurrent: input.assertAttemptCurrent, used: false, claimed: false, revoked: false};
  assertCurrent(state, true);
  issuers.set(issuer, state);
  return issuer;
}

/** Invoke only after the adapter's unique actual-native-terminal/drain gate. */
export function issueAuthoredFinalSubmission(issuer: AuthoredFinalSubmissionIssuer, input: {
  dispatchOrdinal: number;
  responseId: string;
  callId: string;
  rawArguments: string;
  documentJson: string;
  compiled: Compiled;
}): IssuedAuthoredFinalSubmission {
  const state = issuers.get(issuer);
  if (!state) throw new Error('authored_final_submission_issuer_invalid');
  if (state.used) {
    revoke(state);
    throw new Error('authored_final_submission_already_issued');
  }
  state.used = true;
  assertCurrent(state, true);
  let snapshot: AuthoredFinalSubmissionSnapshot;
  try {
    const {dispatchOrdinal, responseId, callId, rawArguments, documentJson, compiled} = input;
    if (!Number.isSafeInteger(dispatchOrdinal) || dispatchOrdinal <= 0 ||
        !nonempty(responseId) || !nonempty(callId) || typeof rawArguments !== 'string' ||
        rawArguments.length > CONCLUSION_AUTHORING_LIMITS.utf8Bytes ||
        Buffer.byteLength(rawArguments, 'utf8') > CONCLUSION_AUTHORING_LIMITS.utf8Bytes ||
        typeof documentJson !== 'string' || compiled.privateRawDocument !== documentJson) throw new Error();
    const args: unknown = JSON.parse(rawArguments);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(args, 'documentJson') ||
        (args as {documentJson: unknown}).documentJson !== documentJson) throw new Error();
    const expected = compileAuthoredClaimDocument(documentJson);
    if (expected.status !== 'compiled' || !isDeepStrictEqual(expected, compiled)) throw new Error();
    const {owner: _owner, ...identity} = state.binding;
    snapshot = immutable({binding: {...identity, dispatchOrdinal,
      responseId, callId, representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
      compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION},
      rawArguments, documentJson, compiled: expected,
      hashes: {rawArgumentsHash: analysisDeliveryFingerprint(rawArguments),
        documentJsonHash: analysisDeliveryFingerprint(documentJson), bodyHash: analysisDeliveryFingerprint(expected.body),
        rawCanonicalPayloadHash: analysisDeliveryFingerprint(expected.rawCanonicalPayload)}});
  } catch {
    revoke(state);
    throw new Error('authored_final_submission_invalid_input');
  }
  assertCurrent(state, true);
  const token: IssuedAuthoredFinalSubmission = Object.freeze({kind: 'authored_final_submission'});
  state.token = token;
  state.snapshot = snapshot;
  // Successful handoff belongs to the run, not to the now-retired SDK attempt.
  state.assertAttemptCurrent = undefined;
  submissions.set(token, state);
  return token;
}

export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission,
  input: AuthoredFinalSubmissionReadInput): AuthoredFinalSubmissionSnapshot {
  const state = submissions.get(token);
  if (!state?.snapshot) throw new Error('authored_final_submission_invalid');
  assertCurrent(state);
  const snapshot = state.snapshot;
  let matches = false;
  try {
    matches = input.binding.owner === state.binding.owner &&
      ownerFields.every(field => input.binding[field] === snapshot.binding[field]) &&
      submissionFields.every(field => input.binding[field] === snapshot.binding[field]) &&
      input.rawArguments === snapshot.rawArguments && input.documentJson === snapshot.documentJson &&
      input.body === snapshot.compiled.body &&
      (input.rawCanonicalPayload === snapshot.compiled.rawCanonicalPayload ||
        isDeepStrictEqual(input.rawCanonicalPayload, snapshot.compiled.rawCanonicalPayload)) &&
      (input.hashes === undefined ||
        Object.keys(input.hashes).length === Object.keys(snapshot.hashes).length &&
        Object.entries(snapshot.hashes).every(([key, value]) =>
          Object.prototype.hasOwnProperty.call(input.hashes, key) &&
          input.hashes![key as keyof AuthoredFinalSubmissionHashes] === value));
  } catch { /* Fixed mismatch below; never expose caller getters or private parser text. */ }
  if (!matches) throw new Error('authored_final_submission_mismatch');
  assertCurrent(state);
  return snapshot;
}

/** Attach once. Reading remains valid until run revocation/finalization disposal. */
export function claimAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission): void {
  const state = submissions.get(token);
  if (!state) throw new Error('authored_final_submission_invalid');
  assertCurrent(state);
  if (state.claimed) throw new Error('authored_final_submission_already_claimed');
  state.claimed = true;
}

export function revokeAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission): void {
  const state = submissions.get(token);
  if (state) revoke(state);
}

/** Explicit cancellation/conflict; not ordinary successful SDK cleanup. */
export function revokeAuthoredFinalSubmissionIssuer(issuer: AuthoredFinalSubmissionIssuer): void {
  const state = issuers.get(issuer);
  if (state) revoke(state);
}
