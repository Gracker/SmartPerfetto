// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {isDeepStrictEqual, types} from 'node:util';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument, measureAuthoredJson,
  type AuthoredClaimDocumentResult} from '../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject,
  type AuthoredClaimObjectResult} from '../agent/core/authoredClaimObject';
import {CONCLUSION_AUTHORING_LIMITS} from '../agent/core/conclusionAuthoring';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';

export const AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION = 'authored_claim_document_compiler@1';
export const AUTHORED_CLAIM_OBJECT_COMPILER_VERSION = 'authored_claim_document_compiler@2';
export const AUTHORED_FINAL_SUBMISSION_PENDING_ACK = '{"status":"pending","kind":"authored_final_submission"}';
type CompiledV1 = Extract<AuthoredClaimDocumentResult, {status: 'compiled'}>;
type CompiledV2 = Extract<AuthoredClaimObjectResult, {status: 'compiled'}>;
export type AuthoredFinalSubmissionSourcePolicy = 'function_only' | 'function_or_assistant_json';
export type AuthoredFinalSubmissionVersion = typeof AUTHORED_CLAIM_DOCUMENT_VERSION | typeof AUTHORED_CLAIM_OBJECT_VERSION;
type Frozen<T> = T extends object ? {readonly [Key in keyof T]: Frozen<T[Key]>} : T;

export interface AuthoredFinalSubmissionOwnerBinding {
  owner: object;
  sessionId: string;
  runId: string;
  attemptId: string;
  providerPin: string;
  authorizationFingerprint: string;
}
interface SubmissionDispatch {
  dispatchOrdinal: number;
  responseId: string;
  callId: string;
}
interface AssistantSubmissionDispatch {dispatchOrdinal: number; responseId: string; messageId: string}
interface V1Version {
  representationVersion: typeof AUTHORED_CLAIM_DOCUMENT_VERSION;
  compilerContractVersion: typeof AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION;
}
interface V2Version {
  representationVersion: typeof AUTHORED_CLAIM_OBJECT_VERSION;
  compilerContractVersion: typeof AUTHORED_CLAIM_OBJECT_COMPILER_VERSION;
}
interface CommonHashes {
  rawArgumentsHash: string;
  bodyHash: string;
  rawCanonicalPayloadHash: string;
}
export interface AuthoredFinalSubmissionV1Hashes extends CommonHashes {documentJsonHash: string}
export interface AuthoredFinalSubmissionAssistantV2Hashes {rawAssistantTextHash: string; bodyHash: string; rawCanonicalPayloadHash: string}
export interface IssuedAuthoredFinalSubmission {readonly kind: 'authored_final_submission'}
export interface AuthoredFinalSubmissionIssuer {readonly kind: 'authored_final_submission_issuer'}
type SnapshotIdentity = Omit<AuthoredFinalSubmissionOwnerBinding, 'owner'> & SubmissionDispatch;
export type AuthoredFinalSubmissionV1Snapshot = Frozen<{
  binding: SnapshotIdentity & V1Version;
  rawArguments: string;
  documentJson: string;
  compiled: CompiledV1;
  hashes: AuthoredFinalSubmissionV1Hashes;
}>;
export type AuthoredFinalSubmissionV2Snapshot = Frozen<{
  binding: SnapshotIdentity & V2Version;
  rawArguments: string;
  nativeDocument: Record<string, unknown>;
  compiled: CompiledV2;
  hashes: CommonHashes;
}>;
export type AuthoredFinalSubmissionAssistantV2Snapshot = Frozen<{
  sourceKind: 'assistant_json';
  binding: Omit<AuthoredFinalSubmissionOwnerBinding, 'owner'> & AssistantSubmissionDispatch & V2Version;
  rawAssistantText: string; nativeDocument: Record<string, unknown>; compiled: CompiledV2;
  hashes: AuthoredFinalSubmissionAssistantV2Hashes;
}>;
export type AuthoredFinalSubmissionSnapshot = AuthoredFinalSubmissionV1Snapshot | AuthoredFinalSubmissionV2Snapshot | AuthoredFinalSubmissionAssistantV2Snapshot;
interface ReadCommon {
  rawArguments: string;
  body: string;
  rawCanonicalPayload: unknown;
}
export type AuthoredFinalSubmissionV1ReadInput = ReadCommon & {
  binding: AuthoredFinalSubmissionOwnerBinding & SubmissionDispatch & V1Version;
  documentJson: string; hashes?: AuthoredFinalSubmissionV1Hashes;
};
export type AuthoredFinalSubmissionV2ReadInput = ReadCommon & {
  binding: AuthoredFinalSubmissionOwnerBinding & SubmissionDispatch & V2Version;
  nativeDocument: unknown; hashes?: CommonHashes;
};
export type AuthoredFinalSubmissionAssistantV2ReadInput = {
  sourceKind: 'assistant_json';
  binding: AuthoredFinalSubmissionOwnerBinding & AssistantSubmissionDispatch & V2Version;
  rawAssistantText: string; nativeDocument: unknown; body: string; rawCanonicalPayload: unknown;
  hashes?: AuthoredFinalSubmissionAssistantV2Hashes;
};
export type AuthoredFinalSubmissionReadInput = AuthoredFinalSubmissionV1ReadInput | AuthoredFinalSubmissionV2ReadInput | AuthoredFinalSubmissionAssistantV2ReadInput;
export type AuthoredFinalSubmissionAssistantV2IssueInput = AssistantSubmissionDispatch & {
  sourceKind: 'assistant_json'; rawAssistantText: string; nativeDocument: unknown; compiled: CompiledV2;
};
export type AuthoredFinalSubmissionIssueInput = SubmissionDispatch & {rawArguments: string} & (
  {documentJson: string; compiled: CompiledV1} | {nativeDocument: unknown; compiled: CompiledV2}) | AuthoredFinalSubmissionAssistantV2IssueInput;

interface State {
  issuer: AuthoredFinalSubmissionIssuer;
  binding: AuthoredFinalSubmissionOwnerBinding;
  representationVersion: AuthoredFinalSubmissionVersion;
  sourcePolicy: AuthoredFinalSubmissionSourcePolicy;
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
const assistantSubmissionFields = ['dispatchOrdinal', 'responseId', 'messageId', 'representationVersion', 'compilerContractVersion'] as const;
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
  /** Captured by the run, never inferred from the submitted model payload. */
  representationVersion?: AuthoredFinalSubmissionVersion;
  sourcePolicy?: AuthoredFinalSubmissionSourcePolicy;
  assertAttemptCurrent(): void;
  /** Run/finalization lifetime; never the SDK's normal cleanup signal. */
  assertCurrent(): void;
}): AuthoredFinalSubmissionIssuer {
  const binding = input.binding;
  const sourcePolicy = input.sourcePolicy === undefined ? 'function_only' : input.sourcePolicy;
  const representationVersion = input.representationVersion === undefined ? AUTHORED_CLAIM_DOCUMENT_VERSION : input.representationVersion;
  if (!binding || binding.owner === null || typeof binding.owner !== 'object' ||
      ownerFields.some(field => !nonempty(binding[field])) ||
      (representationVersion !== AUTHORED_CLAIM_DOCUMENT_VERSION && representationVersion !== AUTHORED_CLAIM_OBJECT_VERSION) ||
      (sourcePolicy !== 'function_only' && sourcePolicy !== 'function_or_assistant_json') ||
      (sourcePolicy === 'function_or_assistant_json' && representationVersion !== AUTHORED_CLAIM_OBJECT_VERSION) ||
      typeof input.assertAttemptCurrent !== 'function' || typeof input.assertCurrent !== 'function') {
    throw new Error('authored_final_submission_invalid_binding');
  }
  const issuer: AuthoredFinalSubmissionIssuer = Object.freeze({kind: 'authored_final_submission_issuer'});
  // Copy identity strings, but never clone or freeze the live owner/lease itself.
  const state: State = {issuer, representationVersion, sourcePolicy, binding: Object.freeze({owner: binding.owner, sessionId: binding.sessionId,
    runId: binding.runId, attemptId: binding.attemptId, providerPin: binding.providerPin,
    authorizationFingerprint: binding.authorizationFingerprint}), assertCurrent: input.assertCurrent,
    assertAttemptCurrent: input.assertAttemptCurrent, used: false, claimed: false, revoked: false};
  assertCurrent(state, true);
  issuers.set(issuer, state);
  return issuer;
}

/** Read only own data descriptors. In particular, do not probe a Proxy for its source tag. */
function assistantSource(value: unknown): value is {sourceKind: 'assistant_json'} {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw new Error();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'sourceKind');
  if (!descriptor) return false;
  if (!('value' in descriptor) || !descriptor.enumerable || descriptor.value !== 'assistant_json') throw new Error();
  return true;
}
function ownData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) throw new Error();
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error();
    captured[key as string] = descriptor.value;
  }
  return captured;
}

/** Compare against the independently compiled bounded shape without evaluating accessors.
 * This is not a new material cap: repeated raw/native/expanded copies are not summed. */
function sameCompiledData(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object' || types.isProxy(actual) ||
      Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  const keys = Reflect.ownKeys(expected), actualKeys = Reflect.ownKeys(actual);
  if (keys.length !== actualKeys.length || keys.some(key => !actualKeys.includes(key))) return false;
  return keys.every(key => {
    const a = Object.getOwnPropertyDescriptor(actual, key), b = Object.getOwnPropertyDescriptor(expected, key);
    return Boolean(a && b && 'value' in a && 'value' in b && a.enumerable === b.enumerable && sameCompiledData(a.value, b.value));
  });
}

function assistantSnapshot(state: State, input: unknown): AuthoredFinalSubmissionAssistantV2Snapshot {
  if (state.sourcePolicy !== 'function_or_assistant_json' || state.representationVersion !== AUTHORED_CLAIM_OBJECT_VERSION) throw new Error();
  const captured = ownData(input, ['sourceKind', 'dispatchOrdinal', 'responseId', 'messageId', 'rawAssistantText', 'nativeDocument', 'compiled']);
  const {dispatchOrdinal, responseId, messageId, rawAssistantText, nativeDocument, compiled} = captured;
  if (captured.sourceKind !== 'assistant_json' || !Number.isSafeInteger(dispatchOrdinal) || (dispatchOrdinal as number) <= 0 ||
      !nonempty(responseId) || !nonempty(messageId) || typeof rawAssistantText !== 'string' ||
      rawAssistantText.length > CONCLUSION_AUTHORING_LIMITS.utf8Bytes || Buffer.byteLength(rawAssistantText, 'utf8') > CONCLUSION_AUTHORING_LIMITS.utf8Bytes ||
      typeof measureAuthoredJson(nativeDocument) === 'string') throw new Error();
  const outer: unknown = JSON.parse(rawAssistantText);
  const envelope = ownData(outer, ['document']);
  const expected = compileAuthoredClaimObject(envelope.document);
  if (expected.status !== 'compiled' || !isDeepStrictEqual(expected.privateNativeDocument, nativeDocument) ||
      !sameCompiledData(compiled, expected)) throw new Error();
  const {owner: _owner, ...identity} = state.binding;
  return immutable({sourceKind: 'assistant_json', binding: {...identity, dispatchOrdinal: dispatchOrdinal as number, responseId, messageId,
    representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION},
    rawAssistantText, nativeDocument: expected.privateNativeDocument, compiled: expected,
    hashes: {rawAssistantTextHash: analysisDeliveryFingerprint(rawAssistantText), bodyHash: analysisDeliveryFingerprint(expected.body),
      rawCanonicalPayloadHash: analysisDeliveryFingerprint(expected.rawCanonicalPayload)}});
}
function assistantReadMatches(state: State, snapshot: AuthoredFinalSubmissionAssistantV2Snapshot, input: unknown): boolean {
  const captured = ownData(input, ['sourceKind', 'binding', 'rawAssistantText', 'nativeDocument', 'body', 'rawCanonicalPayload'], ['hashes']);
  const binding = ownData(captured.binding, ['owner', ...ownerFields, ...assistantSubmissionFields]);
  const native = captured.nativeDocument;
  if (captured.sourceKind !== 'assistant_json' || binding.owner !== state.binding.owner ||
      ownerFields.some(field => binding[field] !== snapshot.binding[field]) ||
      assistantSubmissionFields.some(field => binding[field] !== snapshot.binding[field]) ||
      captured.rawAssistantText !== snapshot.rawAssistantText || captured.body !== snapshot.compiled.body ||
      !(native === snapshot.nativeDocument || typeof measureAuthoredJson(native) !== 'string' && isDeepStrictEqual(native, snapshot.nativeDocument)) ||
      !sameCompiledData(captured.rawCanonicalPayload, snapshot.compiled.rawCanonicalPayload)) return false;
  if (captured.hashes !== undefined) {
    const hashes = ownData(captured.hashes, ['rawAssistantTextHash', 'bodyHash', 'rawCanonicalPayloadHash']);
    if (Object.entries(snapshot.hashes).some(([key, value]) => hashes[key] !== value)) return false;
  }
  return true;
}

/** Invoke only after the adapter's unique actual-native-terminal/drain gate. */
export function issueAuthoredFinalSubmission(issuer: AuthoredFinalSubmissionIssuer,
  input: AuthoredFinalSubmissionIssueInput): IssuedAuthoredFinalSubmission {
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
    if (assistantSource(input)) snapshot = assistantSnapshot(state, input);
    else {
      const legacyInput = input;
      const {dispatchOrdinal, responseId, callId, rawArguments, compiled} = legacyInput;
      if (!Number.isSafeInteger(dispatchOrdinal) || dispatchOrdinal <= 0 ||
          !nonempty(responseId) || !nonempty(callId) || typeof rawArguments !== 'string' ||
          rawArguments.length > CONCLUSION_AUTHORING_LIMITS.utf8Bytes ||
          Buffer.byteLength(rawArguments, 'utf8') > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) throw new Error();
      const args: unknown = JSON.parse(rawArguments);
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1) throw new Error();
      const {owner: _owner, ...identity} = state.binding;
      if (state.representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION) {
        if (!('documentJson' in legacyInput) || 'nativeDocument' in legacyInput) throw new Error();
        const documentJson = legacyInput.documentJson;
        if (typeof documentJson !== 'string' || !('privateRawDocument' in compiled) || compiled.privateRawDocument !== documentJson ||
          !Object.prototype.hasOwnProperty.call(args, 'documentJson') || (args as {documentJson: unknown}).documentJson !== documentJson) throw new Error();
        const expected = compileAuthoredClaimDocument(documentJson);
        if (expected.status !== 'compiled' || !isDeepStrictEqual(expected, compiled)) throw new Error();
        snapshot = immutable({binding: {...identity, dispatchOrdinal, responseId, callId,
          representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION},
          rawArguments, documentJson, compiled: expected,
          hashes: {rawArgumentsHash: analysisDeliveryFingerprint(rawArguments), documentJsonHash: analysisDeliveryFingerprint(documentJson),
            bodyHash: analysisDeliveryFingerprint(expected.body), rawCanonicalPayloadHash: analysisDeliveryFingerprint(expected.rawCanonicalPayload)}});
      } else {
        if (!('nativeDocument' in legacyInput) || 'documentJson' in legacyInput || !Object.prototype.hasOwnProperty.call(args, 'document')) throw new Error();
        const nativeDocument = legacyInput.nativeDocument;
        if (typeof measureAuthoredJson(nativeDocument) === 'string') throw new Error();
        const expected = compileAuthoredClaimObject((args as {document: unknown}).document);
        if (expected.status !== 'compiled' || !isDeepStrictEqual(expected.privateNativeDocument, nativeDocument) ||
          !isDeepStrictEqual(expected, compiled)) throw new Error();
        snapshot = immutable({binding: {...identity, dispatchOrdinal, responseId, callId,
          representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION},
          rawArguments, nativeDocument: expected.privateNativeDocument, compiled: expected,
          hashes: {rawArgumentsHash: analysisDeliveryFingerprint(rawArguments), bodyHash: analysisDeliveryFingerprint(expected.body),
            rawCanonicalPayloadHash: analysisDeliveryFingerprint(expected.rawCanonicalPayload)}});
      }
    }
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

export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission, input: AuthoredFinalSubmissionAssistantV2ReadInput): AuthoredFinalSubmissionAssistantV2Snapshot;
export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission, input: AuthoredFinalSubmissionV1ReadInput): AuthoredFinalSubmissionV1Snapshot;
export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission, input: AuthoredFinalSubmissionV2ReadInput): AuthoredFinalSubmissionV2Snapshot;
export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission, input: AuthoredFinalSubmissionReadInput): AuthoredFinalSubmissionSnapshot;
export function readAuthoredFinalSubmission(token: IssuedAuthoredFinalSubmission,
  input: AuthoredFinalSubmissionReadInput): AuthoredFinalSubmissionSnapshot {
  const state = submissions.get(token);
  if (!state?.snapshot) throw new Error('authored_final_submission_invalid');
  assertCurrent(state);
  const snapshot = state.snapshot;
  let matches = false;
  try {
    const inputIsAssistant = assistantSource(input);
    if ('sourceKind' in snapshot) matches = inputIsAssistant && assistantReadMatches(state, snapshot, input);
    else if (!inputIsAssistant) {
      const legacyInput = input;
      const nativeDocument = 'nativeDocument' in legacyInput ? legacyInput.nativeDocument : undefined;
      const documentMatches = 'documentJson' in snapshot
        ? 'documentJson' in legacyInput && !('nativeDocument' in legacyInput) && legacyInput.documentJson === snapshot.documentJson
        : 'nativeDocument' in legacyInput && !('documentJson' in legacyInput) && (nativeDocument === snapshot.nativeDocument ||
          typeof measureAuthoredJson(nativeDocument) !== 'string' && isDeepStrictEqual(nativeDocument, snapshot.nativeDocument));
      matches = legacyInput.binding.owner === state.binding.owner &&
        ownerFields.every(field => legacyInput.binding[field] === snapshot.binding[field]) &&
        submissionFields.every(field => legacyInput.binding[field] === snapshot.binding[field]) &&
        legacyInput.rawArguments === snapshot.rawArguments && documentMatches &&
        legacyInput.body === snapshot.compiled.body &&
        (legacyInput.rawCanonicalPayload === snapshot.compiled.rawCanonicalPayload ||
          isDeepStrictEqual(legacyInput.rawCanonicalPayload, snapshot.compiled.rawCanonicalPayload)) &&
        (legacyInput.hashes === undefined ||
          Object.keys(legacyInput.hashes).length === Object.keys(snapshot.hashes).length &&
          Object.entries(snapshot.hashes).every(([key, value]) =>
            Object.prototype.hasOwnProperty.call(legacyInput.hashes, key) &&
            (legacyInput.hashes as unknown as Record<string, unknown>)[key] === value));
    }
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
