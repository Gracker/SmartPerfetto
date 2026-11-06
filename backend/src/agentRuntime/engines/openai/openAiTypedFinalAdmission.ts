// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument, type AuthoredClaimDocumentFailure, type AuthoredClaimDocumentResult} from '../../../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION, AUTHORED_FINAL_SUBMISSION_PENDING_ACK,
  issueAuthoredFinalSubmission, readAuthoredFinalSubmission, revokeAuthoredFinalSubmissionIssuer,
  type AuthoredFinalSubmissionIssuer, type AuthoredFinalSubmissionOwnerBinding,
  type AuthoredFinalSubmissionReadInput, type IssuedAuthoredFinalSubmission} from '../../authoredFinalSubmission';
import type {AuthoredConclusionSubmission} from '../../../services/security/conclusionProtocolProjection';

/** Versioned experimental transport boundary; not enabled by importing it. */
export const OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION = 'openai_typed_final_admission@1';
export const OPENAI_TYPED_FINAL_WIRE_VERSION = 'openai_chat_final_wire@1';
export const OPENAI_TYPED_FINAL_RAW_BYTES = 1024 * 1024;

export type OpenAiTypedFinalWireFailure =
  | 'invalid_json' | 'invalid_framing' | 'transport_error' | 'not_sse'
  | 'unknown_field' | 'invalid_chunk' | 'multiple_choices' | 'invalid_tool_delta'
  | 'multiple_tools' | 'conflicting_identity' | 'raw_limit' | 'assistant_content'
  | 'missing_done' | 'data_after_done' | 'missing_tool' | 'non_tool_terminal';

export interface OpenAiTypedFinalWireReceipt {
  readonly wireVersion: typeof OPENAI_TYPED_FINAL_WIRE_VERSION;
  readonly dispatchOrdinal: number;
  readonly responseId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly rawArguments: string;
}
export interface OpenAiTypedFinalWireEvents {
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
  diagnostic(): {dispatchOrdinal: number; status: 'pending' | 'complete' | 'rejected'; reason?: OpenAiTypedFinalWireFailure};
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
export function createOpenAiTypedFinalWireCollector(): OpenAiTypedFinalWireCollector {
  let ordinal = 0;
  let current: OpenAiTypedFinalWireReceipt | undefined;
  let diagnostic: ReturnType<OpenAiTypedFinalWireCollector['diagnostic']> = {dispatchOrdinal: 0, status: 'pending'};
  // SDK conversion can discard unknown provider actions. A later response may
  // not erase that uncertainty about this attempt's outstanding work.
  let unsafeWireFailure: OpenAiTypedFinalWireFailure | undefined;
  return {
    current: () => unsafeWireFailure ? undefined : current,
    isCurrent: receipt => current === receipt && !unsafeWireFailure,
    diagnostic: () => unsafeWireFailure ? {dispatchOrdinal: ordinal, status: 'rejected', reason: unsafeWireFailure} : {...diagnostic},
    startRequest() {
      const dispatchOrdinal = ++ordinal;
      current = undefined;
      diagnostic = {dispatchOrdinal, status: 'pending'};
      let failure: OpenAiTypedFinalWireFailure | undefined;
      let responseId: string | undefined, callId: string | undefined, callIndex: number | undefined;
      let toolName = '', rawArguments = '', argumentBytes = 0;
      let finishReason: string | undefined;
      let done = false, ended = false;
      const reject = (reason: OpenAiTypedFinalWireFailure, unsafe = true) => {
        failure ??= reason;
        if (unsafe) unsafeWireFailure ??= reason;
        if (ordinal === dispatchOrdinal) {
          current = undefined;
          diagnostic = {dispatchOrdinal, status: 'rejected', reason: failure};
        }
      };
      const events: OpenAiTypedFinalWireEvents = {
        fail: reason => reject(reason),
        done() {
          if (done || ended) reject('data_after_done');
          done = true;
        },
        chunk(value) {
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
              if (!nonempty(choice.finish_reason) || (finishReason !== undefined && finishReason !== choice.finish_reason)) {
                reject('non_tool_terminal');
              } else finishReason = choice.finish_reason;
            }
            if (delta.role !== undefined && delta.role !== 'assistant') reject('invalid_chunk');
            for (const name of ['content', 'refusal', 'reasoning', 'reasoning_content']) {
              if (delta[name] != null && typeof delta[name] !== 'string') reject('invalid_chunk');
            }
            if ((typeof delta.content === 'string' && delta.content.length) ||
              (typeof delta.refusal === 'string' && delta.refusal.length)) reject('assistant_content', false);
            if (delta.tool_calls === undefined) continue;
            if (!Array.isArray(delta.tool_calls)) {reject('invalid_tool_delta'); continue;}
            for (const item of delta.tool_calls) {
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
              if (typeof args === 'string' && failure !== 'raw_limit') {
                argumentBytes += appendedUtf8Bytes(rawArguments, args);
                if (argumentBytes > OPENAI_TYPED_FINAL_RAW_BYTES) reject('raw_limit');
                else rawArguments += args;
              }
            }
          }
        },
        end(framingValid) {
          if (ended) {reject('invalid_framing'); return;}
          ended = true;
          if (!framingValid) reject('invalid_framing');
          if (!done) reject('missing_done');
          if (finishReason !== 'tool_calls') reject('non_tool_terminal', false);
          if (!responseId || !callId || !toolName || !rawArguments) reject('missing_tool', false);
          if (failure || unsafeWireFailure || ordinal !== dispatchOrdinal) return;
          current = Object.freeze({wireVersion: OPENAI_TYPED_FINAL_WIRE_VERSION, dispatchOrdinal,
            responseId: responseId!, callId: callId!, toolName, rawArguments});
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
type Compiled = Extract<AuthoredClaimDocumentResult, {status: 'compiled'}>;
interface PendingSubmission {
  invocation: OpenAiTypedFinalInvocation;
  context: object;
  receipt: OpenAiTypedFinalWireReceipt;
  documentJson: string;
  compiled: Compiled;
  handlerSucceeded: boolean;
}
interface StopDecision {response: object; processed: object; deadlineAt: number}

/** Private attempt bridge. No tool registration, feature selection, model call or finalizer lives here. */
export function createOpenAiTypedFinalAttempt(input: {
  finalTool: object;
  toolName: string;
  issuer: AuthoredFinalSubmissionIssuer;
  ownerBinding: AuthoredFinalSubmissionOwnerBinding;
  /** Product/run cancellation only; never the SDK's successful-finally cleanup controller. */
  signal: AbortSignal;
  assertCurrent(): void;
  deadlineAt(): number;
}) {
  input = Object.freeze({...input, ownerBinding: Object.freeze({...input.ownerBinding})});
  const collector = createOpenAiTypedFinalWireCollector();
  let resolveReady!: (stream: NativeStream) => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<NativeStream>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
  void ready.catch(() => undefined);
  let bound = false, agent: object | undefined, nativeDrain: Promise<unknown> | undefined;
  let naturalCompletion: Promise<boolean> | undefined;
  let pending: PendingSubmission | undefined, decision: StopDecision | undefined;
  let revoked: OpenAiTypedFinalAdmissionFailure | undefined, settled = false;
  let firstCompilerFailure: AuthoredClaimDocumentFailure | undefined;
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
  const matchesCall = (call: unknown, receipt: OpenAiTypedFinalWireReceipt): boolean => record(call) &&
    call.type === 'function_call' && call.name === receipt.toolName && call.callId === receipt.callId &&
    call.arguments === receipt.rawArguments;
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
    if (calls.length !== 1 || !matchesCall(calls[0], receipt) || response.output.some(item =>
      !record(item) || (item.type !== 'function_call' && item.type !== 'reasoning'))) return fail('pending_work');
    for (const key of ['handoffs', 'computerActions', 'shellActions', 'applyPatchActions', 'mcpApprovalRequests']) {
      if (!Array.isArray(processed[key]) || processed[key].length !== 0) return fail('pending_work');
    }
    if (processed.functionToolsNotFound !== undefined && (!Array.isArray(processed.functionToolsNotFound) ||
      processed.functionToolsNotFound.length !== 0)) return fail('pending_work');
    if (!Array.isArray(processed.newItems) || processed.newItems.some(item => !record(item) ||
      !record(item.rawItem) || (item.type !== 'tool_call_item' && item.type !== 'reasoning_item') ||
      (item.rawItem.type !== 'reasoning' && !matchesCall(item.rawItem, receipt)))) return fail('pending_work');
    if (!(state._pendingAgentToolRuns instanceof Map) || state._pendingAgentToolRuns.size !== 0 ||
      !Array.isArray(state._modelResponses) || !Array.isArray(state._generatedItems)) return fail('pending_work');
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
    if (pending || decision || issued) revoke('subsequent_dispatch');
    const events = collector.startRequest();
    const checkAfter = () => {if (pending && !collector.isCurrent(pending.receipt)) revoke('wire_ineligible');};
    return {chunk: value => {events.chunk(value); checkAfter();}, done: () => {events.done(); checkAfter();},
      end: valid => {events.end(valid); checkAfter();}, fail: code => {events.fail(code); checkAfter();}};
  }};
  return {
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
    async stageInvocation(call: {tool: object; context: unknown; toolCall: unknown}): Promise<OpenAiTypedFinalInvocation> {
      const stream = await awaitStream();
      if (pending || decision || settled || call.tool !== input.finalTool || !record(call.context) ||
        readState(stream)._context !== call.context) return fail('stale_invocation');
      const receipt = collector.current();
      if (!receipt || !collector.isCurrent(receipt) || receipt.toolName !== input.toolName || !matchesCall(call.toolCall, receipt)) {
        return fail('wire_ineligible');
      }
      let outer: unknown;
      try {outer = JSON.parse(receipt.rawArguments);} catch {return fail('invalid_submission');}
      if (!record(outer) || Object.keys(outer).length !== 1 || typeof outer.documentJson !== 'string') return fail('invalid_submission');
      const compiled = compileAuthoredClaimDocument(outer.documentJson);
      if (compiled.status !== 'compiled') {
        firstCompilerFailure ??= compiled.code;
        return fail('invalid_submission');
      }
      const invocation: OpenAiTypedFinalInvocation = Object.freeze({kind: 'openai_typed_final_invocation'});
      pending = {invocation, context: call.context, receipt, documentJson: outer.documentJson, compiled, handlerSucceeded: false};
      return invocation;
    },
    markPrivateHandlerSuccess(invocation: OpenAiTypedFinalInvocation, result: {output: unknown; documentJson: unknown}) {
      assertCurrent();
      if (!pending || pending.invocation !== invocation || pending.handlerSucceeded ||
        !collector.isCurrent(pending.receipt) || result.output !== OPENAI_TYPED_FINAL_PENDING_ACK ||
        result.documentJson !== pending.documentJson) return fail('handler_failed');
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
        outcomes[1].value !== true || !pending?.handlerSucceeded || !decision) return fail('sdk_incomplete');
      try {
        const state = readState(stream);
        const final = checkSdkState(stream, pending.context, pending);
        if (final.response !== decision.response || final.processed !== decision.processed || stream.error != null ||
          !Array.isArray(stream.interruptions) || stream.interruptions.length || state._currentTurnInProgress !== false ||
          !record(state._currentStep) || state._currentStep.type !== 'next_step_final_output' ||
          state._currentStep.output !== pending.compiled.body || stream.finalOutput !== pending.compiled.body) return fail('sdk_incomplete');
        assertCurrent(false);
        issued = issueAuthoredFinalSubmission(input.issuer, {dispatchOrdinal: pending.receipt.dispatchOrdinal,
          responseId: pending.receipt.responseId, callId: pending.receipt.callId, rawArguments: pending.receipt.rawArguments,
          documentJson: pending.documentJson, compiled: pending.compiled});
        const readInput: AuthoredFinalSubmissionReadInput = {binding: Object.freeze({...input.ownerBinding,
          dispatchOrdinal: pending.receipt.dispatchOrdinal, responseId: pending.receipt.responseId,
          callId: pending.receipt.callId, representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
          compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION}), rawArguments: pending.receipt.rawArguments,
          documentJson: pending.documentJson, body: pending.compiled.body,
          rawCanonicalPayload: structuredClone(pending.compiled.rawCanonicalPayload)};
        const snapshot = readAuthoredFinalSubmission(issued, readInput);
        // Hand off the issued immutable identity, not another parser result or a JSON receipt.
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
