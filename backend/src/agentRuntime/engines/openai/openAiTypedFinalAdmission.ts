// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {isDeepStrictEqual, types} from 'node:util';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument, measureAuthoredJson,
  type AuthoredClaimDocumentResult} from '../../../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject,
  type AuthoredClaimObjectFailure, type AuthoredClaimObjectResult} from '../../../agent/core/authoredClaimObject';
import {AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION, AUTHORED_FINAL_SUBMISSION_PENDING_ACK,
  AUTHORED_CLAIM_OBJECT_COMPILER_VERSION,
  issueAuthoredFinalSubmission, readAuthoredFinalSubmission, revokeAuthoredFinalSubmissionIssuer,
  type AuthoredFinalSubmissionIssuer, type AuthoredFinalSubmissionOwnerBinding,
  type AuthoredFinalSubmissionReadInput, type AuthoredFinalSubmissionAssistantV2ReadInput,
  type AuthoredFinalSubmissionVersion, type IssuedAuthoredFinalSubmission} from '../../authoredFinalSubmission';
import type {AuthoredConclusionSubmission} from '../../../services/security/conclusionProtocolProjection';
import {authoredClaimObjectSchema} from '../../../agent/core/authoredClaimObjectSchema';
import {createOpenAiTypedFinalOutputMaterial, type OpenAiTypedFinalMaterialOptions} from './openAiTypedFinalOutputMaterial';
import {TYPED_OUTPUT_WIRE_FINISH_REASONS, type RuntimeTypedOutputMaterial} from '../../typedOutputMaterial';
import {OPENAI_TYPED_FINAL_CONTRACTS, getOpenAiTypedFinalContractIdentity,
  type OpenAiTypedFinalContractIdentity} from '../../finalSubmissionImplementation';

/** Versioned experimental transport boundary; not enabled by importing it. */
export const OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION = 'openai_typed_final_admission@1';
export const OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION_V2 = 'openai_typed_final_admission@2';
export const OPENAI_TYPED_FINAL_WIRE_VERSION = 'openai_chat_final_wire@1';
export const OPENAI_TYPED_FINAL_RAW_BYTES = 1024 * 1024;
const MIXED_CONTRACT = OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@3'];
const DUAL_CONTRACT = OPENAI_TYPED_FINAL_CONTRACTS['openai_typed_final_admission@4'];

export type OpenAiTypedFinalWireFailure =
  | 'invalid_json' | 'invalid_framing' | 'transport_error' | 'not_sse'
  | 'unknown_field' | 'invalid_chunk' | 'multiple_choices' | 'invalid_tool_delta'
  | 'multiple_tools' | 'conflicting_identity' | 'raw_limit' | 'assistant_content' | 'assistant_refusal'
  | 'missing_done' | 'data_after_done' | 'missing_tool' | 'non_tool_terminal';

const WIRE_FINISH_REASONS = TYPED_OUTPUT_WIRE_FINISH_REASONS;
type WireFinishReason = typeof WIRE_FINISH_REASONS[number];

interface OpenAiTypedFinalWireMaterial {
  readonly dispatchOrdinal: number;
  readonly responseId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly rawArguments: string;
}
type FunctionWireReceipt = OpenAiTypedFinalWireMaterial & (
  {readonly wireVersion: typeof OPENAI_TYPED_FINAL_WIRE_VERSION} |
  {readonly wireVersion: typeof MIXED_CONTRACT.wireVersion | typeof DUAL_CONTRACT.wireVersion; readonly companion: string});
interface AssistantWireReceipt {
  readonly sourceKind: 'assistant_json';
  readonly wireVersion: typeof DUAL_CONTRACT.wireVersion;
  readonly dispatchOrdinal: number;
  readonly responseId: string;
  readonly rawAssistantText: string;
}
export type OpenAiTypedFinalWireReceipt = FunctionWireReceipt | AssistantWireReceipt;
const isAssistantReceipt = (receipt: OpenAiTypedFinalWireReceipt): receipt is AssistantWireReceipt =>
  'sourceKind' in receipt;
export interface OpenAiTypedFinalWireEvents {
  readonly dispatchOrdinal?: number;
  materialSnapshot?(): RuntimeTypedOutputMaterial | undefined;
  chunk(value: unknown): void;
  done(): void;
  end(framingValid: boolean): void;
  fail(reason: 'invalid_json' | 'invalid_framing' | 'transport_error' | 'not_sse' | 'data_after_done'): void;
}
export interface OpenAiTypedFinalWireObserver {
  startRequest(): OpenAiTypedFinalWireEvents;
}
export interface OpenAiTypedFinalWireCollector extends OpenAiTypedFinalWireObserver {
  current(): OpenAiTypedFinalWireReceipt | undefined;
  isCurrent(receipt: OpenAiTypedFinalWireReceipt): boolean;
  diagnostic(): {dispatchOrdinal: number; status: 'pending' | 'complete' | 'rejected'; reason?: OpenAiTypedFinalWireFailure;
    wireFinishReason?: WireFinishReason};
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const chunkKeys = ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'];
const deltaKeys = ['role', 'content', 'refusal', 'reasoning', 'reasoning_content', 'tool_calls'];

/** Count UTF-8 incrementally, including surrogate pairs split between deltas. */
function appendedUtf8Bytes(previous: string, fragment: string): number {
  const high = previous.charCodeAt(previous.length - 1), low = fragment.charCodeAt(0);
  return Buffer.byteLength(fragment) - (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 0);
}

/** Receives the existing terminal fetch parser's data; never reads or rewrites a response. */
export function createOpenAiTypedFinalWireCollector(options: OpenAiTypedFinalMaterialOptions & {
  readonly wireVersion?: OpenAiTypedFinalContractIdentity['wireVersion'];
} = {}): OpenAiTypedFinalWireCollector {
  const wireVersion = options.wireVersion ?? OPENAI_TYPED_FINAL_WIRE_VERSION;
  if (wireVersion !== OPENAI_TYPED_FINAL_WIRE_VERSION && wireVersion !== MIXED_CONTRACT.wireVersion &&
    wireVersion !== DUAL_CONTRACT.wireVersion) {
    throw new OpenAiTypedFinalAdmissionError('contract_unavailable');
  }
  const dual = wireVersion === DUAL_CONTRACT.wireVersion;
  const mixed = wireVersion !== OPENAI_TYPED_FINAL_WIRE_VERSION;
  let ordinal = 0;
  let current: OpenAiTypedFinalWireReceipt | undefined;
  let diagnostic: ReturnType<OpenAiTypedFinalWireCollector['diagnostic']> = {dispatchOrdinal: 0, status: 'pending'};
  let wireFinishReason: WireFinishReason | undefined;
  // SDK conversion can discard unknown provider actions. A later response may
  // not erase that uncertainty about this attempt's outstanding work.
  let unsafeWireFailure: OpenAiTypedFinalWireFailure | undefined;
  return {
    current: () => unsafeWireFailure ? undefined : current,
    isCurrent: receipt => current === receipt && !unsafeWireFailure,
    diagnostic: () => ({...(unsafeWireFailure
      ? {dispatchOrdinal: ordinal, status: 'rejected' as const, reason: unsafeWireFailure} : diagnostic),
      ...(wireFinishReason ? {wireFinishReason} : {})}),
    startRequest() {
      const dispatchOrdinal = ++ordinal;
      current = undefined;
      diagnostic = {dispatchOrdinal, status: 'pending'};
      wireFinishReason = undefined;
      let failure: OpenAiTypedFinalWireFailure | undefined;
      let responseId: string | undefined, callId: string | undefined, callIndex: number | undefined;
      let toolName = '', rawArguments = '', argumentBytes = 0;
      let companion = '', companionBytes = 0, argumentsOverLimit = false, companionOverLimit = false;
      let finishReason: string | undefined;
      let done = false, ended = false;
      let actionSeen = false;
      const material = createOpenAiTypedFinalOutputMaterial(options, () => rawArguments, mixed
        ? () => ({companion, argumentsOverLimit, companionOverLimit}) : undefined);
      const reject = (reason: OpenAiTypedFinalWireFailure, unsafe = true) => {
        failure ??= reason;
        if (unsafe) unsafeWireFailure ??= reason;
        if (ordinal === dispatchOrdinal) {
          current = undefined;
          diagnostic = {dispatchOrdinal, status: 'rejected', reason: failure};
        }
      };
      const events: OpenAiTypedFinalWireEvents = {
        dispatchOrdinal, materialSnapshot: () => material.snapshot(),
        fail: reason => {material.fail(reason); reject(reason);},
        done() {
          material.done();
          if (done || ended) reject('data_after_done');
          done = true;
        },
        chunk(value) {
          material.chunk(value);
          if (done || ended) {reject('data_after_done'); return;}
          if (!record(value) || !onlyKeys(value, chunkKeys)) {reject('unknown_field'); return;}
          if (!Array.isArray(value.choices)) {reject('invalid_chunk'); return;}
          if (value.id !== undefined) {
            if (!nonempty(value.id) || (responseId !== undefined && responseId !== value.id)) {
              reject('conflicting_identity'); return;
            }
            if (Buffer.byteLength(value.id) > OPENAI_TYPED_FINAL_RAW_BYTES) {reject('raw_limit'); return;}
            responseId = value.id;
          } else if (value.choices.length) {reject('invalid_chunk'); return;}
          if (value.choices.length > 1) {reject('multiple_choices'); return;}
          for (const choice of value.choices) {
            if (!record(choice) || !onlyKeys(choice, ['index', 'delta', 'finish_reason', 'logprobs']) ||
              choice.index !== 0 || (choice.logprobs !== undefined && choice.logprobs !== null)) {
              reject('multiple_choices'); continue;
            }
            const delta = choice.delta;
            if (!record(delta) || !onlyKeys(delta, deltaKeys)) {reject('unknown_field'); continue;}
            const addsOutput = Object.values(delta).some(item => item != null && item !== '' &&
              (!Array.isArray(item) || item.length > 0));
            if (finishReason !== undefined && addsOutput) reject('data_after_done');
            if (choice.finish_reason != null) {
              if (ordinal === dispatchOrdinal) {
                const projected = WIRE_FINISH_REASONS.find(reason => reason === choice.finish_reason) ?? 'other';
                wireFinishReason = wireFinishReason === 'other' || !nonempty(choice.finish_reason) ||
                  finishReason !== undefined && finishReason !== choice.finish_reason ? 'other' : projected;
              }
              if (!nonempty(choice.finish_reason) || (finishReason !== undefined && finishReason !== choice.finish_reason)) {
                reject('non_tool_terminal');
              } else finishReason = choice.finish_reason;
            }
            if (delta.role !== undefined && delta.role !== 'assistant') reject('invalid_chunk');
            for (const name of ['content', 'refusal', 'reasoning', 'reasoning_content']) {
              if (delta[name] != null && typeof delta[name] !== 'string') reject('invalid_chunk');
            }
            if (mixed) {
              if (typeof delta.refusal === 'string' && delta.refusal.length) reject('assistant_refusal', false);
              if (typeof delta.content === 'string' && !companionOverLimit) {
                const nextBytes = companionBytes + appendedUtf8Bytes(companion, delta.content);
                if (nextBytes > OPENAI_TYPED_FINAL_RAW_BYTES || nextBytes + argumentBytes > OPENAI_TYPED_FINAL_RAW_BYTES) {
                  companionOverLimit = true; reject('raw_limit');
                } else {companionBytes = nextBytes; companion += delta.content;}
              }
            } else if ((typeof delta.content === 'string' && delta.content.length) ||
              (typeof delta.refusal === 'string' && delta.refusal.length)) reject('assistant_content', false);
            if (delta.tool_calls === undefined) continue;
            if (!Array.isArray(delta.tool_calls)) {reject('invalid_tool_delta'); continue;}
            for (const item of delta.tool_calls) {
              actionSeen = true;
              if (!record(item) || !onlyKeys(item, ['index', 'id', 'type', 'function']) ||
                !Number.isSafeInteger(item.index) || (item.index as number) < 0 ||
                (item.type !== undefined && item.type !== 'function') ||
                !record(item.function) || !onlyKeys(item.function, ['name', 'arguments'])) {
                reject('invalid_tool_delta'); continue;
              }
              if (callIndex !== undefined && item.index !== callIndex) {reject('multiple_tools', false); continue;}
              if (callIndex === undefined) {
                if (item.type !== 'function' || !nonempty(item.id)) {reject('invalid_tool_delta'); continue;}
                callIndex = item.index as number; callId = item.id;
              } else if (item.id !== undefined && item.id !== callId) reject('conflicting_identity');
              if (Buffer.byteLength(callId ?? '') > OPENAI_TYPED_FINAL_RAW_BYTES) {reject('raw_limit'); continue;}
              const name = item.function.name, args = item.function.arguments;
              if ((name !== undefined && typeof name !== 'string') || (args !== undefined && typeof args !== 'string')) {
                reject('invalid_tool_delta'); continue;
              }
              if (typeof name === 'string') {
                if (Buffer.byteLength(toolName) + Buffer.byteLength(name) > OPENAI_TYPED_FINAL_RAW_BYTES) reject('raw_limit');
                else toolName += name;
              }
              if (mixed && typeof args === 'string') {
                if (!argumentsOverLimit) {
                  const nextBytes = argumentBytes + appendedUtf8Bytes(rawArguments, args);
                  if (nextBytes > OPENAI_TYPED_FINAL_RAW_BYTES || nextBytes + companionBytes > OPENAI_TYPED_FINAL_RAW_BYTES) {
                    argumentsOverLimit = true; reject('raw_limit');
                  } else {argumentBytes = nextBytes; rawArguments += args;}
                }
              } else if (typeof args === 'string' && failure !== 'raw_limit') {
                argumentBytes += appendedUtf8Bytes(rawArguments, args);
                if (argumentBytes > OPENAI_TYPED_FINAL_RAW_BYTES) reject('raw_limit');
                else rawArguments += args;
              }
            }
          }
        },
        end(framingValid) {
          material.end(framingValid);
          if (ended) {reject('invalid_framing'); return;}
          ended = true;
          if (!framingValid) reject('invalid_framing');
          if (!done) reject('missing_done');
          if (dual && !actionSeen) {
            if (finishReason !== 'stop') reject('non_tool_terminal', false);
            if (!responseId) reject('conflicting_identity');
            if (failure || unsafeWireFailure || ordinal !== dispatchOrdinal) return;
            current = Object.freeze({sourceKind: 'assistant_json', wireVersion: DUAL_CONTRACT.wireVersion,
              dispatchOrdinal, responseId: responseId!, rawAssistantText: companion});
            diagnostic = {dispatchOrdinal, status: 'complete'};
            return;
          }
          if (finishReason !== 'tool_calls') reject('non_tool_terminal', false);
          if (!responseId || !callId || !toolName || !rawArguments || (mixed && toolName !== options.finalToolName)) reject('missing_tool', false);
          if (failure || unsafeWireFailure || ordinal !== dispatchOrdinal) return;
          const retained = {dispatchOrdinal, responseId: responseId!, callId: callId!, toolName, rawArguments};
          current = Object.freeze(mixed ? {...retained, wireVersion: dual ? DUAL_CONTRACT.wireVersion : MIXED_CONTRACT.wireVersion, companion}
            : {...retained, wireVersion: OPENAI_TYPED_FINAL_WIRE_VERSION});
          diagnostic = {dispatchOrdinal, status: 'complete'};
        },
      };
      return events;
    },
  };
}

/** The adapter compares this after shared-handler success AND after SDK tool output guardrails. */
// stringifyRuntimeToolResult preserves the text of this one text block.
export const OPENAI_TYPED_FINAL_PENDING_ACK = AUTHORED_FINAL_SUBMISSION_PENDING_ACK;

export type OpenAiTypedFinalAdmissionFailure = 'contract_unavailable' | 'wire_ineligible' | 'stale_invocation' |
  'invalid_submission' | 'handler_failed' | 'pending_work' | 'sdk_incomplete' | 'cancelled' |
  'deadline' | 'subsequent_dispatch' | 'already_settled';
export class OpenAiTypedFinalAdmissionError extends Error {
  readonly code: OpenAiTypedFinalAdmissionFailure;
  constructor(code: OpenAiTypedFinalAdmissionFailure) {super(`OpenAI typed final unavailable: ${code}`); this.code = code;}
}
export interface OpenAiTypedFinalInvocation {readonly kind: 'openai_typed_final_invocation'}
interface NativeStream {
  state: unknown;
  completed: Promise<void>;
  error: unknown;
  cancelled: boolean;
  finalOutput: unknown;
  interruptions: unknown;
}
type CompiledV1 = Extract<AuthoredClaimDocumentResult, {status: 'compiled'}>;
type CompiledV2 = Extract<AuthoredClaimObjectResult, {status: 'compiled'}>;
interface PendingCommon {
  invocation: OpenAiTypedFinalInvocation;
  context: object;
  receipt: FunctionWireReceipt;
  handlerSucceeded: boolean;
}
type PendingSubmission = PendingCommon & (
  {representationVersion: typeof AUTHORED_CLAIM_DOCUMENT_VERSION; documentJson: string; compiled: CompiledV1} |
  {representationVersion: typeof AUTHORED_CLAIM_OBJECT_VERSION; nativeDocument: Record<string, unknown>; compiled: CompiledV2});
interface StopDecision {response: object; processed: object; deadlineAt: number}
interface AssistantCompletionSnapshot {
  receipt: AssistantWireReceipt;
  response: Record<string, unknown>;
  processed: Record<string, unknown>;
  agent: object;
  context: unknown;
  step: Record<string, unknown>;
  output: readonly unknown[];
  newItems: readonly unknown[];
  message: Record<string, unknown>;
  messageId: string;
  text: string;
  completedAt: number;
  deadlineAt: number;
}

/** Compare actual arguments, not a replacement decoded from the wire. The native
 * subtree's own S1 bound excludes the outer transport wrapper's independent byte cap. */
function sameSubmissionArguments(actual: unknown, original: Record<string, unknown>): boolean {
  if (types.isProxy(actual) || !record(actual) || Object.getPrototypeOf(actual) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(actual), expected = Object.keys(original);
  if (keys.length !== 1 || expected.length !== 1 || keys[0] !== expected[0] ||
    (expected[0] !== 'documentJson' && expected[0] !== 'document')) return false;
  const descriptor = Object.getOwnPropertyDescriptor(actual, keys[0]);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
  if (expected[0] === 'document' && typeof measureAuthoredJson(descriptor.value) === 'string') return false;
  return isDeepStrictEqual(actual, original);
}

/** Private attempt bridge. No tool registration, feature selection, model call or finalizer lives here. */
export function createOpenAiTypedFinalAttempt(input: {
  finalTool: object;
  toolName: string;
  /** Observation only: names of this attempt's actual installed tools. */
  knownToolNames?: readonly string[];
  issuer: AuthoredFinalSubmissionIssuer;
  ownerBinding: AuthoredFinalSubmissionOwnerBinding;
  /** Captured run syntax; omission keeps the existing v1 adapter contract. */
  representationVersion?: AuthoredFinalSubmissionVersion;
  /** Actual pre-dispatch SDK/profile contract; omission keeps historical strict callers. */
  contractVersion?: OpenAiTypedFinalContractIdentity['admissionVersion'];
  /** Product/run cancellation only; never the SDK's successful-finally cleanup controller. */
  signal: AbortSignal;
  assertCurrent(): void;
  deadlineAt(): number;
}) {
  input = Object.freeze({...input, ownerBinding: Object.freeze({...input.ownerBinding})});
  const representationVersion = input.representationVersion === undefined ? AUTHORED_CLAIM_DOCUMENT_VERSION : input.representationVersion;
  if (representationVersion !== AUTHORED_CLAIM_DOCUMENT_VERSION && representationVersion !== AUTHORED_CLAIM_OBJECT_VERSION) {
    throw new OpenAiTypedFinalAdmissionError('contract_unavailable');
  }
  const contractIdentity = getOpenAiTypedFinalContractIdentity(input.contractVersion ??
    (representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION ? OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION : OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION_V2));
  if (!contractIdentity || contractIdentity.representationVersion !== representationVersion) {
    throw new OpenAiTypedFinalAdmissionError('contract_unavailable');
  }
  const dual = contractIdentity.admissionVersion === DUAL_CONTRACT.admissionVersion;
  const collector = createOpenAiTypedFinalWireCollector({finalToolName: input.toolName, knownToolNames: input.knownToolNames,
    wireVersion: contractIdentity.wireVersion,
    ...(representationVersion === AUTHORED_CLAIM_OBJECT_VERSION ? {materialProvider: {
      representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      rootKeys: Object.keys(authoredClaimObjectSchema.shape),
      contractKeys: Object.keys(authoredClaimObjectSchema.shape.contract.shape), measure: measureAuthoredJson,
    }} : {})});
  let resolveReady!: (stream: NativeStream) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<NativeStream>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
  void ready.catch(() => undefined);
  let bound = false, agent: object | undefined, nativeDrain: Promise<unknown> | undefined;
  let naturalCompletion: Promise<boolean> | undefined;
  let assistantCompletion: AssistantCompletionSnapshot | undefined;
  let pending: PendingSubmission | undefined, decision: StopDecision | undefined;
  let revoked: OpenAiTypedFinalAdmissionFailure | undefined, settled = false;
  let firstCompilerFailure: AuthoredClaimObjectFailure | undefined;
  let issued: IssuedAuthoredFinalSubmission | undefined;
  const revoke = (reason: OpenAiTypedFinalAdmissionFailure) => {
    revoked ??= reason;
    pending = undefined;
    revokeAuthoredFinalSubmissionIssuer(input.issuer);
    rejectReady(new OpenAiTypedFinalAdmissionError(reason));
  };
  const fail = (code: OpenAiTypedFinalAdmissionFailure): never => {revoke(code); throw new OpenAiTypedFinalAdmissionError(code);};
  const readDeadline = () => {
    let deadline: number;
    try {deadline = input.deadlineAt();} catch {return fail('contract_unavailable');}
    return Number.isFinite(deadline) ? deadline : fail('contract_unavailable');
  };
  const assertCurrent = (checkDeadline = true) => {
    if (revoked) throw new OpenAiTypedFinalAdmissionError(revoked);
    if (input.signal.aborted) fail('cancelled');
    try {input.assertCurrent();} catch {fail('stale_invocation');}
    if (checkDeadline && Date.now() >= readDeadline()) fail('deadline');
  };
  const readState = (stream: NativeStream): Record<string, unknown> => {
    try {const state = stream.state; if (record(state)) return state;} catch { /* Fixed contract failure below. */ }
    return fail('contract_unavailable');
  };
  const awaitStream = async (): Promise<NativeStream> => {
    assertCurrent();
    let onAbort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new OpenAiTypedFinalAdmissionError('cancelled'));
      input.signal.addEventListener('abort', onAbort, {once: true});
      if (input.signal.aborted) onAbort();
    });
    try {const stream = await Promise.race([ready, cancellation]); assertCurrent(); return stream;}
    finally {input.signal.removeEventListener('abort', onAbort);}
  };
  const matchesCall = (call: unknown, receipt: FunctionWireReceipt): boolean => record(call) &&
    call.type === 'function_call' && call.name === receipt.toolName && call.callId === receipt.callId &&
    call.arguments === receipt.rawArguments;
  /** Work is checked from the actual SDK structures, never inferred from prose. */
  const checkDualWork = (state: Record<string, unknown>, response: Record<string, unknown>,
    processed: Record<string, unknown>, currentCallId?: string): void => {
    for (const key of ['handoffs', 'computerActions', 'shellActions', 'applyPatchActions', 'mcpApprovalRequests']) {
      if (!Array.isArray(processed[key]) || processed[key].length !== 0) return fail('pending_work');
    }
    if (processed.functionToolsNotFound !== undefined && (!Array.isArray(processed.functionToolsNotFound) ||
      processed.functionToolsNotFound.length !== 0)) return fail('pending_work');
    if (!(state._pendingAgentToolRuns instanceof Map) || state._pendingAgentToolRuns.size !== 0 ||
      !Array.isArray(state._modelResponses) || state._modelResponses[state._modelResponses.length - 1] !== response ||
      !Array.isArray(state._generatedItems)) return fail('pending_work');
    const seenInput = new Set<string>(), pendingInput = new Set<string>();
    if (typeof state._originalInput !== 'string') {
      if (!Array.isArray(state._originalInput)) return fail('contract_unavailable');
      for (const item of state._originalInput) {
        if (!record(item)) return fail('pending_work');
        if (item.type === 'function_call') {
          if (!nonempty(item.callId) || seenInput.has(item.callId)) return fail('pending_work');
          seenInput.add(item.callId); pendingInput.add(item.callId);
        } else if (item.type === 'function_call_result') {
          if (item.status !== 'completed' || !nonempty(item.callId) || !pendingInput.delete(item.callId)) return fail('pending_work');
        } else if (item.type !== 'reasoning' && item.type !== 'message' &&
          !(item.type === undefined && ['user', 'system', 'developer', 'assistant'].includes(String(item.role)))) {
          return fail('pending_work');
        }
      }
    }
    if (pendingInput.size || currentCallId !== undefined && seenInput.has(currentCallId)) return fail('pending_work');
    const priorCalls = new Set<string>(), pendingPrior = new Set<string>();
    const responseCalls = new Map<string, object>();
    if (currentCallId !== undefined && Array.isArray(response.output)) {
      const currentCall = response.output.find(item => record(item) && item.type === 'function_call' && item.callId === currentCallId);
      if (!record(currentCall)) return fail('pending_work');
      responseCalls.set(currentCallId, currentCall);
    }
    for (const prior of state._modelResponses.slice(0, -1)) {
      if (!record(prior) || !Array.isArray(prior.output)) return fail('contract_unavailable');
      for (const item of prior.output) {
        if (!record(item)) return fail('pending_work');
        if (item.type === 'function_call') {
          if (!nonempty(item.callId) || priorCalls.has(item.callId) || seenInput.has(item.callId) ||
            item.callId === currentCallId) return fail('pending_work');
          priorCalls.add(item.callId); pendingPrior.add(item.callId); responseCalls.set(item.callId, item);
        } else if (item.type !== 'message' && item.type !== 'reasoning') return fail('pending_work');
      }
    }
    let currentResultSeen = false;
    const generatedCalls = new Set<string>();
    for (const generated of state._generatedItems) {
      if (!record(generated) || !record(generated.rawItem)) return fail('pending_work');
      const raw = generated.rawItem;
      if (raw.type === 'function_call_result') {
        if (generated.type !== 'tool_call_output_item' || raw.status !== 'completed' || !nonempty(raw.callId)) return fail('pending_work');
        if (raw.callId === currentCallId) {
          if (currentResultSeen) return fail('pending_work');
          currentResultSeen = true;
        } else if (!pendingPrior.delete(raw.callId)) return fail('pending_work');
      } else if (raw.type === 'function_call') {
        if (generated.type !== 'tool_call_item' || !nonempty(raw.callId) ||
          generatedCalls.has(raw.callId) || responseCalls.get(raw.callId) !== raw) return fail('pending_work');
        generatedCalls.add(raw.callId);
      } else if ((raw.type !== 'message' || generated.type !== 'message_output_item') &&
        (raw.type !== 'reasoning' || generated.type !== 'reasoning_item')) return fail('pending_work');
    }
    // The SDK appends this turn's items only after toolUseBehavior returns.
    // Prior turns must already be complete at both checks; the current final
    // function has its separate actual handler/ACK/guardrail gate.
    if (pendingPrior.size || [...priorCalls].some(callId => !generatedCalls.has(callId))) return fail('pending_work');
  };
  const readAssistantCompletion = (stream: NativeStream, receipt: AssistantWireReceipt,
    timing?: Pick<AssistantCompletionSnapshot, 'completedAt' | 'deadlineAt'>): AssistantCompletionSnapshot => {
    const state = readState(stream), response = state._lastTurnResponse, processed = state._lastProcessedResponse;
    const step = state._currentStep;
    if (!agent || state._currentAgent !== agent || !record(state._context) || !collector.isCurrent(receipt) ||
      !record(response) || response.responseId !== receipt.responseId || !Array.isArray(response.output) ||
      new Set(response.output).size !== response.output.length || !record(processed) ||
      !Array.isArray(processed.functions) || processed.functions.length || !Array.isArray(processed.newItems) ||
      processed.newItems.length !== response.output.length || !record(step) || step.type !== 'next_step_final_output' ||
      step.output !== receipt.rawAssistantText || stream.finalOutput !== receipt.rawAssistantText ||
      stream.cancelled || stream.error != null) return fail('sdk_incomplete');
    const messages = response.output.filter(item => record(item) && item.type === 'message');
    const message = messages[0];
    if (messages.length !== 1 || !record(message) || !onlyKeys(message, ['id', 'content', 'role', 'type', 'status']) ||
      message.id !== receipt.responseId || message.role !== 'assistant' || message.status !== 'completed' ||
      !Array.isArray(message.content) || message.content.length !== 1 || !record(message.content[0]) ||
      !onlyKeys(message.content[0], ['type', 'text', 'providerData']) || message.content[0].type !== 'output_text' ||
      message.content[0].text !== receipt.rawAssistantText) return fail('sdk_incomplete');
    for (const output of response.output) {
      if (!record(output) || (output.type !== 'message' && output.type !== 'reasoning')) return fail('pending_work');
      const counterparts = processed.newItems.filter(item => record(item) && item.rawItem === output);
      if (counterparts.length !== 1 || !record(counterparts[0]) || counterparts[0].agent !== agent ||
        counterparts[0].type !== (output.type === 'message' ? 'message_output_item' : 'reasoning_item')) return fail('pending_work');
    }
    checkDualWork(state, response, processed);
    return {receipt, response, processed, agent, context: state._context, step,
      output: Object.freeze([...response.output]), newItems: Object.freeze([...processed.newItems]),
      message, messageId: receipt.responseId, text: receipt.rawAssistantText,
      completedAt: timing?.completedAt ?? Date.now(), deadlineAt: timing?.deadlineAt ?? readDeadline()};
  };
  const checkSdkState = (stream: NativeStream, context: unknown, submission: PendingSubmission): StopDecision => {
    const state = readState(stream), receipt = submission.receipt;
    if (state._context !== context || context !== submission.context || state._currentAgent !== agent ||
      !collector.isCurrent(receipt)) return fail('stale_invocation');
    const response = state._lastTurnResponse, processed = state._lastProcessedResponse;
    if (!record(response) || response.responseId !== receipt.responseId || !Array.isArray(response.output) ||
      !record(processed) || !Array.isArray(processed.functions) || processed.functions.length !== 1 ||
      !record(processed.functions[0]) || processed.functions[0].tool !== input.finalTool ||
      !matchesCall(processed.functions[0].toolCall, receipt)) return fail('contract_unavailable');
    const calls = response.output.filter(item => record(item) && item.type === 'function_call');
    if (calls.length !== 1 || !matchesCall(calls[0], receipt)) return fail('pending_work');
    if (receipt.wireVersion !== OPENAI_TYPED_FINAL_WIRE_VERSION) {
      if (new Set(response.output).size !== response.output.length) return fail('pending_work');
      const messages = response.output.filter(item => record(item) && item.type === 'message');
      const message = messages[0];
      if (messages.length !== (receipt.companion.length ? 1 : 0) ||
        (receipt.companion.length && (!record(message) || !onlyKeys(message, ['id', 'content', 'role', 'type', 'status']) ||
          message.id !== receipt.responseId || message.role !== 'assistant' || message.status !== 'completed' ||
          !Array.isArray(message.content) || message.content.length !== 1 || !record(message.content[0]) ||
          !onlyKeys(message.content[0], ['type', 'text', 'providerData']) || message.content[0].type !== 'output_text' ||
          message.content[0].text !== receipt.companion)) ||
        !record(calls[0]) || calls[0].id !== receipt.responseId || processed.functions[0].toolCall !== calls[0] ||
        !Array.isArray(processed.newItems) || processed.newItems.length !== response.output.length) return fail('pending_work');
      for (const output of response.output) {
        if (!record(output) || (output.type !== 'message' && output.type !== 'function_call' && output.type !== 'reasoning')) return fail('pending_work');
        const counterparts = processed.newItems.filter(item => record(item) && item.rawItem === output);
        const expectedType = output.type === 'message' ? 'message_output_item' : output.type === 'function_call' ? 'tool_call_item' : 'reasoning_item';
        if (counterparts.length !== 1 || !record(counterparts[0]) || counterparts[0].type !== expectedType ||
          counterparts[0].agent !== agent) return fail('pending_work');
      }
    } else if (response.output.some(item => !record(item) || (item.type !== 'function_call' && item.type !== 'reasoning'))) {
      return fail('pending_work');
    }
    for (const key of ['handoffs', 'computerActions', 'shellActions', 'applyPatchActions', 'mcpApprovalRequests']) {
      if (!Array.isArray(processed[key]) || processed[key].length !== 0) return fail('pending_work');
    }
    if (processed.functionToolsNotFound !== undefined && (!Array.isArray(processed.functionToolsNotFound) ||
      processed.functionToolsNotFound.length !== 0)) return fail('pending_work');
    if (receipt.wireVersion === OPENAI_TYPED_FINAL_WIRE_VERSION && (!Array.isArray(processed.newItems) || processed.newItems.some(item => !record(item) ||
      !record(item.rawItem) || (item.type !== 'tool_call_item' && item.type !== 'reasoning_item') ||
      (item.rawItem.type !== 'reasoning' && !matchesCall(item.rawItem, receipt))))) return fail('pending_work');
    if (!(state._pendingAgentToolRuns instanceof Map) || state._pendingAgentToolRuns.size !== 0 ||
      !Array.isArray(state._modelResponses) || !Array.isArray(state._generatedItems)) return fail('pending_work');
    if (dual) {
      checkDualWork(state, response, processed, receipt.callId);
      return {response, processed, deadlineAt: readDeadline()};
    }
    const previous = new Set<string>();
    for (const prior of state._modelResponses.slice(0, -1)) {
      if (!record(prior) || !Array.isArray(prior.output)) return fail('contract_unavailable');
      for (const item of prior.output) {
        if (!record(item)) return fail('pending_work');
        if (item.type === 'function_call') {
          if (!nonempty(item.callId) || previous.has(item.callId) || item.callId === receipt.callId) return fail('pending_work');
          previous.add(item.callId);
        } else if (item.type !== 'message' && item.type !== 'reasoning') return fail('pending_work');
      }
    }
    for (const item of state._generatedItems) {
      if (!record(item) || item.type === 'tool_approval_item') return fail('pending_work');
      const raw = item.rawItem;
      if (record(raw) && raw.type === 'function_call_result' && raw.callId !== receipt.callId &&
        (typeof raw.callId !== 'string' || !previous.delete(raw.callId))) return fail('pending_work');
    }
    if (previous.size !== 0) return fail('pending_work');
    return {response, processed, deadlineAt: readDeadline()};
  };
  const wireObserver: OpenAiTypedFinalWireObserver = {startRequest() {
    if (pending || decision || assistantCompletion || issued) revoke('subsequent_dispatch');
    const events = collector.startRequest();
    const checkAfter = () => {if (pending && !collector.isCurrent(pending.receipt)) revoke('wire_ineligible');};
    return {dispatchOrdinal: events.dispatchOrdinal, materialSnapshot: events.materialSnapshot,
      chunk: value => {events.chunk(value); checkAfter();}, done: () => {events.done(); checkAfter();},
      end: valid => {events.end(valid); checkAfter();}, fail: code => {events.fail(code); checkAfter();}};
  }};
  return {
    get contractIdentity() {return contractIdentity;},
    wireObserver,
    diagnostic: () => ({...collector.diagnostic(), ...(revoked ? {admissionFailure: revoked} : {}),
      ...(firstCompilerFailure ? {compilerFailure: firstCompilerFailure} : {})}),
    bindStream(value: unknown) {
      if (bound) return fail('contract_unavailable');
      bound = true;
      try {
        if (!record(value)) return fail('contract_unavailable');
        const state = value.state, completed = value.completed, getter = value._getStreamLoopPromise;
        if (!record(state) || !record(state._currentAgent) ||
          !completed || typeof (completed as PromiseLike<unknown>).then !== 'function' ||
          typeof getter !== 'function') return fail('contract_unavailable');
        const drain: unknown = getter.call(value);
        if (!drain || typeof (drain as PromiseLike<unknown>).then !== 'function') return fail('contract_unavailable');
        const stream = value as unknown as NativeStream;
        agent = state._currentAgent;
        nativeDrain = Promise.resolve(drain);
        void nativeDrain.catch(() => undefined);
        naturalCompletion = Promise.resolve(completed).then(() => {
          const receipt = collector.current();
          if (dual && receipt && isAssistantReceipt(receipt)) {
            assertCurrent();
            if (pending || decision) return fail('sdk_incomplete');
            assistantCompletion = readAssistantCompletion(stream, receipt);
            return assistantCompletion.completedAt <= assistantCompletion.deadlineAt;
          }
          const state = readState(stream);
          return Boolean(decision && pending && Date.now() <= decision.deadlineAt && !stream.cancelled &&
            stream.error == null && record(state._currentStep) && state._currentStep.type === 'next_step_final_output' &&
            state._currentStep.output === pending.compiled.body && stream.finalOutput === pending.compiled.body);
        }, () => false);
        void naturalCompletion.catch(() => undefined);
        resolveReady(stream);
      } catch {return fail('contract_unavailable');}
    },
    failStartup() {revoke('contract_unavailable');},
    /** Only the actual adapter execute path receives this object-identity capability. */
    async stageInvocation(call: {tool: object; context: unknown; toolCall: unknown; parsedArguments: unknown}): Promise<OpenAiTypedFinalInvocation> {
      const stream = await awaitStream();
      if (pending || decision || settled || call.tool !== input.finalTool || !record(call.context) ||
        readState(stream)._context !== call.context) return fail('stale_invocation');
      const receipt = collector.current();
      if (!receipt || isAssistantReceipt(receipt) || !collector.isCurrent(receipt) || receipt.toolName !== input.toolName || !matchesCall(call.toolCall, receipt)) {
        return fail('wire_ineligible');
      }
      let outer: unknown;
      try {outer = JSON.parse(receipt.rawArguments);} catch {return fail('invalid_submission');}
      if (!record(outer) || Object.keys(outer).length !== 1 || !sameSubmissionArguments(call.parsedArguments, outer)) return fail('invalid_submission');
      const invocation: OpenAiTypedFinalInvocation = Object.freeze({kind: 'openai_typed_final_invocation'});
      const common = {invocation, context: call.context, receipt, handlerSucceeded: false};
      if (representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION) {
        if (typeof outer.documentJson !== 'string') return fail('invalid_submission');
        const compiled = compileAuthoredClaimDocument(outer.documentJson);
        if (compiled.status !== 'compiled') {firstCompilerFailure ??= compiled.code; return fail('invalid_submission');}
        pending = {...common, representationVersion, documentJson: outer.documentJson, compiled};
      } else {
        if (!Object.prototype.hasOwnProperty.call(outer, 'document')) return fail('invalid_submission');
        const compiled = compileAuthoredClaimObject(outer.document);
        if (compiled.status !== 'compiled') {firstCompilerFailure ??= compiled.code; return fail('invalid_submission');}
        pending = {...common, representationVersion, nativeDocument: compiled.privateNativeDocument, compiled};
      }
      return invocation;
    },
    markPrivateHandlerSuccess(invocation: OpenAiTypedFinalInvocation, result: {output: unknown; arguments: unknown}) {
      assertCurrent();
      if (!pending || pending.invocation !== invocation || pending.handlerSucceeded ||
        !collector.isCurrent(pending.receipt) || result.output !== OPENAI_TYPED_FINAL_PENDING_ACK) return fail('handler_failed');
      const original = pending.representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION
        ? {documentJson: pending.documentJson} : {document: pending.nativeDocument};
      if (!sameSubmissionArguments(result.arguments, original)) return fail('handler_failed');
      pending.handlerSucceeded = true;
    },
    async toolUseBehavior(context: unknown, results: readonly unknown[]) {
      const stream = await awaitStream();
      const state = readState(stream), response = state._lastTurnResponse;
      const hasFinalCall = record(response) && Array.isArray(response.output) && response.output.some(item =>
        record(item) && item.type === 'function_call' && item.name === input.toolName);
      if (!pending && !hasFinalCall) return {isFinalOutput: false as const, isInterrupted: undefined};
      if (!pending?.handlerSucceeded || decision || results.length !== 1 || !record(results[0])) return fail('handler_failed');
      const result = results[0];
      if (result.type !== 'function_output' || result.tool !== input.finalTool || result.output !== OPENAI_TYPED_FINAL_PENDING_ACK ||
        result.agentRunResult !== undefined || (result.interruptions !== undefined &&
          (!Array.isArray(result.interruptions) || result.interruptions.length !== 0)) ||
        !record(result.runItem) || !record(result.runItem.rawItem) || result.runItem.rawItem.callId !== pending.receipt.callId) {
        return fail('handler_failed');
      }
      decision = checkSdkState(stream, context, pending);
      return {isFinalOutput: true as const, isInterrupted: undefined, finalOutput: pending.compiled.body};
    },
    /** All known work drains before any rejection or issuance; cleanup abort is not a product cancellation. */
    async settleAfterDrain(consumer: Promise<unknown>): Promise<AuthoredConclusionSubmission> {
      const stream = await ready;
      const outcomes = await Promise.allSettled([nativeDrain, naturalCompletion, consumer]);
      if (settled) throw new OpenAiTypedFinalAdmissionError('already_settled');
      settled = true;
      assertCurrent(false);
      if (outcomes.some(outcome => outcome.status !== 'fulfilled') || outcomes[1].status !== 'fulfilled' ||
        outcomes[1].value !== true) return fail('sdk_incomplete');
      try {
        if (assistantCompletion) {
          const snapshot = assistantCompletion, current = readAssistantCompletion(stream, snapshot.receipt, snapshot);
          const sameOrder = (left: readonly unknown[], right: readonly unknown[]) =>
            left.length === right.length && left.every((value, index) => value === right[index]);
          if (current.response !== snapshot.response || current.processed !== snapshot.processed ||
            current.agent !== snapshot.agent || current.context !== snapshot.context || current.step !== snapshot.step ||
            current.message !== snapshot.message || current.messageId !== snapshot.messageId || current.text !== snapshot.text ||
            !sameOrder(current.output, snapshot.output) || !sameOrder(current.newItems, snapshot.newItems) ||
            !Array.isArray(stream.interruptions) || stream.interruptions.length || readState(stream)._currentTurnInProgress !== false ||
            snapshot.completedAt > snapshot.deadlineAt) return fail('sdk_incomplete');
          let outer: unknown;
          try {outer = JSON.parse(snapshot.text);} catch {return fail('invalid_submission');}
          if (!record(outer) || Object.keys(outer).length !== 1 || !Object.prototype.hasOwnProperty.call(outer, 'document')) return fail('invalid_submission');
          const compiled = compileAuthoredClaimObject(outer.document);
          if (compiled.status !== 'compiled') {firstCompilerFailure ??= compiled.code; return fail('invalid_submission');}
          assertCurrent(false);
          const dispatch = {dispatchOrdinal: snapshot.receipt.dispatchOrdinal, responseId: snapshot.receipt.responseId,
            messageId: snapshot.messageId};
          issued = issueAuthoredFinalSubmission(input.issuer, {sourceKind: 'assistant_json', ...dispatch,
            rawAssistantText: snapshot.text, nativeDocument: compiled.privateNativeDocument, compiled});
          const readInput: AuthoredFinalSubmissionAssistantV2ReadInput = {sourceKind: 'assistant_json',
            binding: Object.freeze({...input.ownerBinding, ...dispatch, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
              compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION}), rawAssistantText: snapshot.text,
            nativeDocument: structuredClone(compiled.privateNativeDocument), body: compiled.body,
            rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)};
          const issuedSnapshot = readAuthoredFinalSubmission(issued, readInput);
          return Object.freeze({submission: issued, input: Object.freeze({...readInput,
            nativeDocument: issuedSnapshot.nativeDocument, rawCanonicalPayload: issuedSnapshot.compiled.rawCanonicalPayload})});
        }
        if (!pending?.handlerSucceeded || !decision) return fail('sdk_incomplete');
        const state = readState(stream);
        const final = checkSdkState(stream, pending.context, pending);
        if (final.response !== decision.response || final.processed !== decision.processed || stream.error != null ||
          !Array.isArray(stream.interruptions) || stream.interruptions.length || state._currentTurnInProgress !== false ||
          !record(state._currentStep) || state._currentStep.type !== 'next_step_final_output' ||
          state._currentStep.output !== pending.compiled.body || stream.finalOutput !== pending.compiled.body) return fail('sdk_incomplete');
        assertCurrent(false);
        const dispatch = {dispatchOrdinal: pending.receipt.dispatchOrdinal,
          responseId: pending.receipt.responseId, callId: pending.receipt.callId, rawArguments: pending.receipt.rawArguments};
        issued = issueAuthoredFinalSubmission(input.issuer, pending.representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION
          ? {...dispatch, documentJson: pending.documentJson, compiled: pending.compiled}
          : {...dispatch, nativeDocument: pending.nativeDocument, compiled: pending.compiled});
        const binding = {...input.ownerBinding,
          dispatchOrdinal: pending.receipt.dispatchOrdinal, responseId: pending.receipt.responseId,
          callId: pending.receipt.callId};
        const material = {rawArguments: pending.receipt.rawArguments, body: pending.compiled.body,
          rawCanonicalPayload: structuredClone(pending.compiled.rawCanonicalPayload)};
        const readInput: AuthoredFinalSubmissionReadInput = pending.representationVersion === AUTHORED_CLAIM_DOCUMENT_VERSION
          ? {...material, binding: Object.freeze({...binding, representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
              compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION}), documentJson: pending.documentJson}
          : {...material, binding: Object.freeze({...binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
              compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION}), nativeDocument: structuredClone(pending.nativeDocument)};
        const snapshot = readAuthoredFinalSubmission(issued, readInput);
        // Hand off the issued immutable identity, not another parser result or a JSON receipt.
        if ('nativeDocument' in readInput && 'nativeDocument' in snapshot) return Object.freeze({submission: issued,
          input: Object.freeze({...readInput, nativeDocument: snapshot.nativeDocument, rawCanonicalPayload: snapshot.compiled.rawCanonicalPayload})});
        return Object.freeze({submission: issued,
          input: Object.freeze({...readInput, rawCanonicalPayload: snapshot.compiled.rawCanonicalPayload})});
      } catch (error) {
        if (error instanceof OpenAiTypedFinalAdmissionError) throw error;
        return fail('contract_unavailable');
      }
    },
    /** Explicit product cancellation/conflicting work, never successful SDK-finally disposal. */
    revoke,
  };
}
