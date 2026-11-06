// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {installCurrentRealmStructuredCloneForTest} from '../../../tests/helpers/openAiRuntimeFixture';
import {Agent, OpenAIProvider, Runner, shellTool, tool,
  type AgentInputItem, type FunctionToolResult, type RunContext} from '@openai/agents';
import OpenAI from 'openai';
import {z} from 'zod';
import {compileAuthoredClaimDocument, measureAuthoredJson} from '../../agent/core/authoredClaimDocument';
import {CONCLUSION_PROTOCOL_VALUES} from '../../agent/core/conclusionContract';
import type {RuntimeTypedOutputMaterial} from '../typedOutputMaterial';
import * as outputMaterial from '../engines/openai/openAiTypedFinalOutputMaterial';
import {compileAuthoredClaimObject, type AuthoredClaimObjectResult} from '../../agent/core/authoredClaimObject';
import {authoredClaimObjectSchema, type AuthoredClaimObjectInput} from '../../agent/core/authoredClaimObjectSchema';
import {createJsonSchemaFromZodRawShape, normalizeRuntimeToolArgs, preserveRuntimeLiteralJson} from '../runtimeToolSpec';
import {isDeepStrictEqual} from 'node:util';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';
import {createOpenAIToolsFromMcpDefinitions} from '../engines/openai/openAiToolAdapter';
import {__testing as openAiRuntimeTesting} from '../engines/openai/openAiRuntime';
import {createOpenAiTypedFinalAttempt, createOpenAiTypedFinalWireCollector, OPENAI_TYPED_FINAL_PENDING_ACK,
  OPENAI_TYPED_FINAL_RAW_BYTES, type OpenAiTypedFinalWireObserver} from '../engines/openai/openAiTypedFinalAdmission';
import {createAuthoredFinalSubmissionIssuer, readAuthoredFinalSubmission,
  AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION, revokeAuthoredFinalSubmissionIssuer} from '../authoredFinalSubmission';
import * as submissionAuthority from '../authoredFinalSubmission';
import type {AuthoredConclusionSubmission} from '../../services/security/conclusionProtocolProjection';

/**
 * Installed-SDK probes plus actual, still-unwired collector/admission coverage.
 * Runner, model conversion, function execution, guardrails and drain are real.
 * The fetch fixtures below are local; their known bytes do NOT prove a future
 * privacy projection or model compatibility. The final describes explicitly use
 * the production collector, attempt helper and shared issuer; the first describe
 * retains the deliberately unsafe SDK-only probes as counterexamples.
 */
const finalToolName = 'submit_final_fixture';
const ack = '{"status":"pending","kind":"authored_final_submission"}';
const documentJson = JSON.stringify({representationVersion: 'authored_claim_document@1',
  contract: {schemaVersion: 'conclusion_contract_v1', mode: 'need_input', conclusions: [], clusters: [],
    evidenceChain: [], claims: [], uncertainties: [], nextSteps: []}, bodyParts: ['Which interval should I inspect?']});
const rawArguments = JSON.stringify({documentJson});
const compiled = compileAuthoredClaimDocument(documentJson);
if (compiled.status !== 'compiled') throw new Error('Invalid test document');
const body = compiled.body;
const rawCanonicalPayload = compiled.rawCanonicalPayload;
function startNativeRun(runner: Runner, agent: Agent, signal: AbortSignal, input: string | AgentInputItem[] = 'fixture', maxTurns = 1) {
  return runner.run(agent, input, {stream: true, maxTurns, signal});
}
type NativeStream = Awaited<ReturnType<typeof startNativeRun>>;
type Callback = (stream: NativeStream, context: RunContext, results: FunctionToolResult[]) => string | Promise<string>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
function chatResponse(args = rawArguments, extras: Record<string, unknown> = {}, secondTool = false): Response {
  const calls = [{index: 0, id: 'final-call', type: 'function', function: {name: finalToolName, arguments: args}}];
  if (secondTool) calls.push({index: 1, id: 'other-call', type: 'function',
    function: {name: 'other_fixture', arguments: '{}'}});
  const chunks = [
    {id: 'chat-final', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{index: 0, delta: {role: 'assistant', tool_calls: calls, ...extras}, finish_reason: null}]},
    {id: 'chat-final', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}],
      usage: {prompt_tokens: 5, completion_tokens: 7, total_tokens: 12}},
  ];
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
    {headers: {'content-type': 'text/event-stream'}});
}
function responseWithHostedPending(): Response {
  const output = [
    {id: 'function-item', type: 'function_call', call_id: 'final-call', name: finalToolName,
      arguments: rawArguments, status: 'completed'},
    {id: 'shell-item', type: 'shell_call', call_id: 'hosted-pending', status: 'in_progress',
      action: {commands: ['echo fixture']}},
  ];
  const response = {id: 'response-final', object: 'response', created_at: 1, model: 'fixture-model',
    status: 'completed', output, usage: {input_tokens: 5, output_tokens: 7, total_tokens: 12}};
  const events = [
    {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
    ...output.map((item, output_index) => ({type: 'response.output_item.done', output_index, item})),
    {type: 'response.completed', response},
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    {headers: {'content-type': 'text/event-stream'}});
}

function probe(options: {
  fetch?: typeof fetch;
  response?: () => Response;
  manualBinding?: boolean;
  onCallback?: Callback;
  handlerGate?: Promise<void>;
  otherGate?: Promise<void>;
  guardrail?: 'input_reject' | 'output_rewrite';
  finalGuardrail?: () => Promise<{outputInfo: null; tripwireTriggered: boolean}>;
  hostedPending?: boolean;
  useAdmission?: boolean;
  skipPrivateSuccess?: boolean;
  deadlineAt?: () => number;
  consumerGate?: Promise<void>;
  handlerDocument?: string;
} = {}) {
  const controller = new AbortController();
  const productController = new AbortController();
  const ready = deferred<NativeStream>();
  void ready.promise.catch(() => undefined);
  const callbackEntered = deferred<void>(), handlerEntered = deferred<void>(), handlerWorkEntered = deferred<void>(), otherEntered = deferred<void>();
  const observations = {handlerCalls: 0, callbackCalls: 0, sdkArguments: '', publicSettled: false,
    drained: false, callbackAfterBinding: false, order: [] as string[], rawEvents: [] as unknown[],
    admissionFailure: undefined as unknown};
  const ownerBinding = {owner: {}, sessionId: 'session', runId: 'run', attemptId: 'attempt',
    providerPin: 'fixture-pinned', authorizationFingerprint: 'fixture-authorized'};
  let ownerCurrent = true, attemptCurrent = true;
  const assertOwner = () => {if (!ownerCurrent || productController.signal.aborted) throw new Error('fixture owner revoked');};
  const issuer = options.useAdmission ? createAuthoredFinalSubmissionIssuer({binding: ownerBinding,
    assertCurrent: assertOwner, assertAttemptCurrent: () => {if (!attemptCurrent) throw new Error('fixture attempt ended');}}) : undefined;
  let admission: ReturnType<typeof createOpenAiTypedFinalAttempt> | undefined;
  let submission: AuthoredConclusionSubmission | undefined;
  const fetcher = jest.fn<typeof fetch>(options.fetch ?? (async () => options.response?.() ?? chatResponse()));
  const finalTool = tool({name: finalToolName, description: 'Fixture final submission',
    parameters: z.object({documentJson: z.string()}), errorFunction: null,
    ...(options.guardrail === 'input_reject' ? {inputGuardrails: [{name: 'reject-fixture-input',
      run: async () => ({behavior: {type: 'rejectContent' as const, message: 'input rejected'}})}]} : {}),
    ...(options.guardrail === 'output_rewrite' ? {outputGuardrails: [{name: 'replace-fixture-output',
      run: async () => ({behavior: {type: 'rejectContent' as const, message: 'output replaced'}})}]} : {}),
    execute: async (args, _context, details) => {
      observations.handlerCalls++;
      observations.sdkArguments = details?.toolCall?.arguments ?? '';
      handlerEntered.resolve();
      const invocation = admission ? await admission.stageInvocation({tool: finalTool, context: _context,
        toolCall: details?.toolCall, parsedArguments: args}) : undefined;
      handlerWorkEntered.resolve();
      await options.handlerGate;
      expect(args.documentJson).toBe(documentJson);
      if (admission && invocation && !options.skipPrivateSuccess) admission.markPrivateHandlerSuccess(invocation,
        {output: OPENAI_TYPED_FINAL_PENDING_ACK, arguments: {documentJson: options.handlerDocument ?? args.documentJson}});
      return ack;
    }});
  if (issuer) admission = createOpenAiTypedFinalAttempt({finalTool, toolName: finalToolName, issuer, ownerBinding,
    signal: productController.signal, assertCurrent: assertOwner, deadlineAt: options.deadlineAt ?? (() => Date.now() + 60_000)});
  const otherTool = tool({name: 'other_fixture', description: 'Fixture gated work', parameters: z.object({}),
    execute: async () => {otherEntered.resolve(); await options.otherGate; return 'other finished';}});
  const agent = new Agent<unknown, 'text'>({name: 'typed-final-observability', model: 'fixture-model',
    instructions: 'Fixture only.', tools: [finalTool, ...(options.otherGate ? [otherTool] : []),
      ...(options.hostedPending ? [shellTool({environment: {type: 'container_auto'}})] : [])],
    ...(options.finalGuardrail ? {outputGuardrails: [{name: 'gated-final', execute: options.finalGuardrail}]} : {}),
    toolUseBehavior: async (context, results) => {
      observations.callbackCalls++;
      callbackEntered.resolve();
      if (admission) return admission.toolUseBehavior(context, results);
      const stream = await ready.promise;
      observations.callbackAfterBinding = true;
      observations.order.push('callback');
      if (controller.signal.aborted) throw new Error('prototype_cancelled');
      return {isFinalOutput: true, isInterrupted: undefined,
        finalOutput: options.onCallback ? await options.onCallback(stream, context, results) : body};
    }});
  const actualFetch = admission ? openAiRuntimeTesting.createOpenAiTerminalFetch(fetcher, () => undefined, admission.wireObserver) : fetcher;
  const runner = new Runner({modelProvider: new OpenAIProvider({useResponses: !!options.hostedPending,
    openAIClient: new OpenAI({apiKey: 'test-only', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: actualFetch})}),
    tracingDisabled: true, traceIncludeSensitiveData: false, toolExecution: {maxFunctionToolConcurrency: 1}});
  const started = startNativeRun(runner, agent, controller.signal);
  let actualStream: NativeStream | undefined;
  let admissionBound = false;
  const bind = (stream: NativeStream) => {
    ready.resolve(stream);
    if (admission && !admissionBound) {admission.bindStream(stream); admissionBound = true;}
  };
  const tracked = started.then(stream => {
    actualStream = stream;
    // The internal getter is intentionally inspected, never replaced or mocked.
    const getter = (stream as NativeStream & {_getStreamLoopPromise?: () => unknown})._getStreamLoopPromise;
    if (typeof getter !== 'function') throw new Error('SDK drain getter unavailable');
    const loop = getter.call(stream);
    expect(loop).toEqual(expect.objectContaining({then: expect.any(Function)}));
    const drain = Promise.resolve(loop).then(() => {observations.drained = true; observations.order.push('drain');});
    const completed = stream.completed.then(() => {observations.publicSettled = true;}, () => {
      observations.publicSettled = true;
    });
    if (!options.manualBinding) bind(stream);
    const consumer = (async () => {
      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event') observations.rawEvents.push(event.data);
      }
      await stream.completed;
      await options.consumerGate;
    })();
    void consumer.catch(() => undefined);
    return {stream, drain, completed, consumer};
  }, error => {ready.reject(error); throw error;});
  void tracked.catch(() => undefined);
  const admissionOutcome = admission ? tracked.then(async state => {
    try {submission = await admission!.settleAfterDrain(state.consumer); observations.order.push('issued');}
    catch (error) {observations.admissionFailure = error;}
  }) : Promise.resolve();
  void admissionOutcome.catch(() => undefined);
  return {started, tracked, agent, fetcher, observations, callbackEntered, handlerEntered, handlerWorkEntered, otherEntered,
    bind, controller, cancel: () => {productController.abort(); controller.abort();},
    submission: () => submission,
    admission: () => admission,
    revokeOwner: () => {ownerCurrent = false;},
    clearAttempt: () => {attemptCurrent = false;},
    readSubmission: () => readAuthoredFinalSubmission(submission!.submission, submission!.input),
    settle: async () => {const state = await tracked; await Promise.allSettled([state.drain, state.completed, state.consumer]);
      await admissionOutcome; return state.stream;},
    cleanup: async () => {controller.abort(); if (actualStream) bind(actualStream);
      const state = await tracked.catch(() => undefined);
      if (state) await Promise.allSettled([state.drain, state.completed, state.consumer]);},
  };
}

describe('installed OpenAI SDK typed-final observability (test-only prototype)', () => {
  it('allows callback to await stream handoff before an external runResult assignment without deadlock', async () => {
    const h = probe({manualBinding: true, onCallback: (stream, context, results) => {
      expect(context).toBe(stream.state._context);
      expect(stream.state._lastTurnResponse?.responseId).toBe('chat-final');
      expect(stream.state._lastProcessedResponse?.functions).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({type: 'function_output', output: ack});
      return body;
    }});
    try {
      await h.callbackEntered.promise;
      expect(h.observations.callbackAfterBinding).toBe(false);
      const stream = await h.started; // run() resolves independently of the blocked callback.
      expect(h.observations.drained).toBe(false);
      h.bind(stream);
      await h.settle();
      expect(stream.finalOutput).toBe(body);
      expect(stream.error).toBeNull();
      expect(stream.cancelled).toBe(false);
      expect(stream.state._currentStep?.type).toBe('next_step_final_output');
      expect(stream.state._currentTurnInProgress).toBe(false);
      expect(stream.state._pendingAgentToolRuns.size).toBe(0);
      expect(h.observations.order).toEqual(['callback', 'drain']);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('does not call final callback or drain while another real function handler is pending', async () => {
    const gate = deferred<void>();
    const h = probe({response: () => chatResponse(rawArguments, {}, true), otherGate: gate.promise,
      onCallback: (stream, _context, results) => {
        expect(results).toHaveLength(2);
        expect(stream.state._lastProcessedResponse?.functions).toHaveLength(2);
        throw new Error('prototype_multiple_tools');
      }});
    try {
      await h.otherEntered.promise;
      expect(h.observations.handlerCalls).toBe(1);
      expect(h.observations.callbackCalls).toBe(0);
      expect(h.observations.drained).toBe(false);
      gate.resolve();
      const stream = await h.settle();
      expect(stream.error).toMatchObject({message: 'prototype_multiple_tools'});
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
      expect(h.observations.drained).toBe(true); // loop resolves even though the run failed.
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('exposes provider-managed pending shell work that a function-only result list cannot attest', async () => {
    const h = probe({hostedPending: true, response: responseWithHostedPending,
      onCallback: (stream, _context, results) => {
        expect(results).toHaveLength(1);
        expect(stream.state._lastProcessedResponse?.shellActions).toEqual([]);
        expect(stream.state._lastTurnResponse?.output).toEqual(expect.arrayContaining([
          expect.objectContaining({type: 'shell_call', status: 'in_progress'}),
        ]));
        throw new Error('prototype_provider_pending');
      }});
    try {
      const stream = await h.settle();
      expect(h.observations.callbackCalls).toBe(1);
      expect(stream.error).toMatchObject({message: 'prototype_provider_pending'});
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('demonstrates that SDK arguments can differ from the fixture wire before the handler runs', async () => {
    const wireArguments = `{}` + rawArguments;
    const h = probe({response: () => chatResponse(wireArguments), onCallback: stream => {
      const call = stream.state._lastTurnResponse?.output.find(item => item.type === 'function_call');
      expect(call?.type === 'function_call' ? call.arguments : undefined).toBe(rawArguments);
      expect(h.observations.sdkArguments).not.toBe(wireArguments);
      throw new Error('prototype_raw_mismatch');
    }});
    try {
      const stream = await h.settle();
      expect(h.observations.handlerCalls).toBe(1);
      expect(stream.error).toMatchObject({message: 'prototype_raw_mismatch'});
    } finally {await h.cleanup();}
  });

  it('demonstrates an ignored legacy delta is absent from final SDK output but visible in raw model events', async () => {
    const h = probe({response: () => chatResponse(rawArguments,
      {function_call: {name: 'legacy_pending', arguments: '{}'}})});
    try {
      const stream = await h.settle();
      expect(stream.state._lastTurnResponse?.output.filter(item => item.type === 'function_call')).toHaveLength(1);
      expect(stream.finalOutput).toBe(body); // Deliberately unsafe prototype, NOT an admission success.
      expect(h.observations.rawEvents).toEqual(expect.arrayContaining([expect.objectContaining({type: 'model',
        event: expect.objectContaining({choices: expect.arrayContaining([expect.objectContaining({
          delta: expect.objectContaining({function_call: {name: 'legacy_pending', arguments: '{}'}}),
        })])})})]));
    } finally {await h.cleanup();}
  });

  it.each(['input_reject', 'output_rewrite'] as const)('shows function_output is not handler+ACK success: %s', async guardrail => {
    const h = probe({guardrail, onCallback: (_stream, _context, results) => {
      const result = results[0];
      expect(result.type).toBe('function_output');
      if (result.type !== 'function_output') throw new Error('Expected actual SDK function_output');
      expect(result.output).not.toBe(ack);
      expect(h.observations.handlerCalls).toBe(guardrail === 'input_reject' ? 0 : 1);
      throw new Error('prototype_no_exact_handler_receipt');
    }});
    try {
      const stream = await h.settle();
      expect(h.observations.callbackCalls).toBe(1);
      expect(stream.error).toMatchObject({message: 'prototype_no_exact_handler_receipt'});
    } finally {await h.cleanup();}
  });

  it('does not treat a visible finalOutput before output guardrails and drain as successful completion', async () => {
    const gate = deferred<void>(), entered = deferred<void>();
    const h = probe({finalGuardrail: async () => {
      entered.resolve(); await gate.promise;
      return {outputInfo: null, tripwireTriggered: true};
    }});
    try {
      await entered.promise;
      const stream = await h.started;
      expect(stream.finalOutput).toBe(body); // SDK exposes it before its guardrail succeeds.
      expect(h.observations.publicSettled).toBe(false);
      expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle();
      expect(stream.error).toBeTruthy();
      expect(stream.state._currentStep).toBeUndefined();
      expect(h.observations.drained).toBe(true);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it.each(['fetch', 'handler'] as const)('public completed on cancel precedes real native drain while %s ignores abort', async held => {
    const gate = deferred<void>(), fetchEntered = deferred<void>();
    const fetcher: typeof fetch = async () => {fetchEntered.resolve(); if (held === 'fetch') await gate.promise; return chatResponse();};
    const h = probe({fetch: fetcher, ...(held === 'handler' ? {handlerGate: gate.promise} : {})});
    try {
      await (held === 'fetch' ? fetchEntered.promise : h.handlerEntered.promise);
      const stream = await h.started;
      h.controller.abort();
      await stream.completed;
      await boundary();
      expect(stream.cancelled).toBe(true);
      expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle();
      expect(h.observations.drained).toBe(true);
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('reports a real provider failure without tool callback even though its drain promise settles', async () => {
    const h = probe({fetch: async () => {throw new Error('fixture network failure');}});
    try {
      const stream = await h.settle();
      expect(stream.error).toBeTruthy();
      expect(h.observations.handlerCalls).toBe(0);
      expect(h.observations.callbackCalls).toBe(0);
      expect(h.observations.drained).toBe(true);
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
    } finally {await h.cleanup();}
  });
});

function streamedArgumentResponse(argumentsParts: string[], suffix = 'data: [DONE]\n\n'): Response {
  const encoder = new TextEncoder();
  const frames = argumentsParts.map((part, index) => ({id: 'chat-final', object: 'chat.completion.chunk',
    choices: [{index: 0, delta: {tool_calls: [{index: 0,
      ...(index === 0 ? {id: 'final-call', type: 'function', function: {name: finalToolName, arguments: part}}
        : {function: {arguments: part}})}]}, finish_reason: null}]}));
  return new Response(new ReadableStream<Uint8Array>({start(controller) {
    for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    controller.enqueue(encoder.encode('data: {"id":"chat-final","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
    if (suffix) controller.enqueue(encoder.encode(suffix));
    controller.close();
  }}), {headers: {'content-type': 'text/event-stream'}});
}
async function consumeObserved(response: Response, observer: OpenAiTypedFinalWireObserver) {
  const wrapped = openAiRuntimeTesting.createOpenAiTerminalFetch(async () => response, () => undefined, observer);
  return (await wrapped('https://fixture.invalid/v1', {method: 'POST'})).text();
}

describe('actual bounded typed-final wire collector at the existing terminal fetch boundary', () => {
  const toolChunk = {id: 'finish-fixture', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'finish-call', type: 'function',
    function: {name: finalToolName, arguments: rawArguments}}]}, finish_reason: null}]};
  const terminalChunk = (reason: unknown) => ({id: 'finish-fixture', choices: [{index: 0, delta: {}, finish_reason: reason}]});

  it.each(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'insufficient_system_resource', 'aborted',
    'PRIVATE_FINISH_REASON'] as const)('observes a closed actual finish reason without changing admission: %s', reason => {
    const collector = createOpenAiTypedFinalWireCollector();
    const events = collector.startRequest();
    events.chunk(toolChunk); events.chunk(terminalChunk(reason)); events.done(); events.end(true);
    expect(collector.diagnostic()).toMatchObject({wireFinishReason: reason.startsWith('PRIVATE_') ? 'other' : reason,
      status: reason === 'tool_calls' ? 'complete' : 'rejected'});
    expect(Boolean(collector.current())).toBe(reason === 'tool_calls');
    expect(JSON.stringify(collector.diagnostic())).not.toContain('PRIVATE_');
    if (reason === 'tool_calls') expect(collector.current()).not.toHaveProperty('wireFinishReason');
  });

  it('omits absent terminals, resets observations and ignores an older dispatch finish', () => {
    const collector = createOpenAiTypedFinalWireCollector();
    const old = collector.startRequest(); old.chunk(toolChunk);
    const current = collector.startRequest(); current.chunk(toolChunk);
    expect(collector.diagnostic()).not.toHaveProperty('wireFinishReason');
    old.chunk(terminalChunk('length')); old.done(); old.end(true);
    expect(collector.diagnostic()).toEqual({dispatchOrdinal: 2, status: 'pending'});
    current.chunk(terminalChunk('tool_calls')); current.done(); current.end(true);
    expect(collector.diagnostic()).toEqual({dispatchOrdinal: 2, status: 'complete', wireFinishReason: 'tool_calls'});
    const absent = collector.startRequest(); absent.chunk(toolChunk); absent.done(); absent.end(true);
    expect(collector.diagnostic()).not.toHaveProperty('wireFinishReason');
    expect(collector.current()).toBeUndefined();
  });

  it.each([['length', 'stop'], ['PRIVATE_FIRST', 'PRIVATE_SECOND']])('keeps raw conflicting terminal rejection: %s / %s', (first, second) => {
    const collector = createOpenAiTypedFinalWireCollector();
    const events = collector.startRequest(); events.chunk(toolChunk);
    events.chunk(terminalChunk(first)); events.chunk(terminalChunk(second)); events.done(); events.end(true);
    expect(collector.diagnostic()).toMatchObject({status: 'rejected', reason: 'non_tool_terminal', wireFinishReason: 'other'});
    // Distinct unknown strings both project to other; they must still poison
    // admission as a raw conflict, rather than become an equal terminal pair.
    const next = collector.startRequest(); next.chunk(toolChunk); next.chunk(terminalChunk('tool_calls')); next.done(); next.end(true);
    expect(collector.current()).toBeUndefined();
    expect(collector.diagnostic()).toMatchObject({status: 'rejected', reason: 'non_tool_terminal', wireFinishReason: 'tool_calls'});
    expect(JSON.stringify(collector.diagnostic())).not.toContain('PRIVATE_');
  });

  it('preserves response bytes and reads original argument strings across real SSE chunks', async () => {
    const collector = createOpenAiTypedFinalWireCollector();
    const pieces = [rawArguments.slice(0, 13), rawArguments.slice(13, 27), rawArguments.slice(27)];
    const expected = await streamedArgumentResponse(pieces).text();
    const actual = await consumeObserved(streamedArgumentResponse(pieces), collector);
    expect(actual).toBe(expected);
    expect(collector.current()).toEqual({wireVersion: 'openai_chat_final_wire@1', dispatchOrdinal: 1,
      responseId: 'chat-final', callId: 'final-call', toolName: finalToolName, rawArguments});
    expect(Object.isFrozen(collector.current())).toBe(true);
  });

  it.each(['legacy', 'unknown', 'custom', 'multi_choice', 'extra_tool_key'] as const)('rejects original wire information the SDK might ignore: %s', async kind => {
    const collector = createOpenAiTypedFinalWireCollector();
    const wire = await chatResponse().text();
    const first = JSON.parse(wire.split('\n')[0].slice('data: '.length));
    if (kind === 'legacy') first.choices[0].delta.function_call = {name: 'legacy', arguments: '{}'};
    if (kind === 'unknown') first.choices[0].delta.future_action = {pending: true};
    if (kind === 'custom') first.choices[0].delta.tool_calls[0].type = 'custom';
    if (kind === 'multi_choice') first.choices.push({...first.choices[0], index: 1});
    if (kind === 'extra_tool_key') first.choices[0].delta.tool_calls[0].future_action = 'pending';
    const changed = `data: ${JSON.stringify(first)}` + wire.slice(wire.indexOf('\n'));
    await consumeObserved(new Response(changed, {headers: {'content-type': 'text/event-stream'}}), collector);
    expect(collector.current()).toBeUndefined();
    expect(collector.diagnostic().status).toBe('rejected');
  });

  it.each(['missing', 'data_after_done', 'unclosed_event'] as const)('requires DONE, event framing and real EOF: %s', async kind => {
    const collector = createOpenAiTypedFinalWireCollector();
    const suffix = kind === 'missing' ? '' : kind === 'data_after_done'
      ? 'data: [DONE]\n\ndata: {"id":"late","choices":[]}\n\n' : 'data: [DONE]';
    await consumeObserved(streamedArgumentResponse([rawArguments], suffix), collector);
    expect(collector.current()).toBeUndefined();
    expect(collector.diagnostic().status).toBe('rejected');
  });

  it('does not certify DONE until the underlying stream really ends', async () => {
    const collector = createOpenAiTypedFinalWireCollector();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new TextEncoder().encode(await chatResponse().text());
    const response = new Response(new ReadableStream<Uint8Array>({start(controller) {source = controller; controller.enqueue(bytes);}}),
      {headers: {'content-type': 'text/event-stream'}});
    const reading = consumeObserved(response, collector);
    try {
      await boundary();
      expect(collector.current()).toBeUndefined();
      source.close(); await reading;
      expect(collector.current()).toMatchObject({rawArguments: rawArguments});
    } finally {await reading;}
  });

  it.each([0, 1])('bounds the actual concatenated arguments at one MiB (excess=%i)', async excess => {
    const collector = createOpenAiTypedFinalWireCollector();
    const raw = 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES + excess);
    const pieces: string[] = [];
    for (let at = 0; at < raw.length; at += 8192) pieces.push(raw.slice(at, at + 8192));
    await consumeObserved(streamedArgumentResponse(pieces), collector);
    if (excess) expect(collector.diagnostic()).toMatchObject({status: 'rejected', reason: 'raw_limit'});
    else expect(collector.current()).toMatchObject({rawArguments: raw});
  });

  it('preserves lone surrogates and a surrogate pair split between argument deltas', async () => {
    const collector = createOpenAiTypedFinalWireCollector();
    const pieces = ['a\ud800', '\udc00', '\ud801'];
    await consumeObserved(streamedArgumentResponse(pieces), collector);
    expect(collector.current()).toMatchObject({rawArguments: pieces.join('')});
  });

  it('revokes an old receipt on another real request and never launders unsafe prior wire', async () => {
    const collector = createOpenAiTypedFinalWireCollector();
    await consumeObserved(chatResponse(), collector);
    const first = collector.current()!;
    await consumeObserved(chatResponse(rawArguments, {function_call: {name: 'unknown'}}), collector);
    expect(collector.isCurrent(first)).toBe(false);
    await consumeObserved(chatResponse(), collector);
    expect(collector.current()).toBeUndefined();
  });

  it('leaves byte delivery and existing terminal facts unchanged when an optional observer throws', async () => {
    const expected = await chatResponse().text();
    const terminal: unknown[] = [];
    const fetcher = openAiRuntimeTesting.createOpenAiTerminalFetch(async () => chatResponse(), value => terminal.push(value), {
      startRequest: () => ({chunk() {throw new Error('observer failure');}, done() {}, end() {}, fail() {}}),
    });
    expect(await (await fetcher('https://fixture.invalid/v1')).text()).toBe(expected);
    expect(terminal).toEqual([expect.objectContaining({responseId: 'chat-final', finishReason: 'tool_calls'})]);
  });
});

describe('actual typed-final attempt helper with installed SDK and shared issued submission', () => {
  it.each([
    {document: 'PRIVATE_COMPILER_CANARY', code: 'invalid_json'},
    {document: JSON.stringify({private: 'PRIVATE_COMPILER_CANARY'}), code: 'invalid_envelope'},
    {document: JSON.stringify({representationVersion: 'authored_claim_document@1', contract: {},
      bodyParts: [{claimText: 'PRIVATE_COMPILER_CANARY'}]}), code: 'unknown_claim_id'},
  ])('retains the first closed compiler failure through SDK drain: $code', async ({document, code}) => {
    const h = probe({useAdmission: true, response: () => chatResponse(JSON.stringify({documentJson: document}))});
    try {
      await h.settle();
      expect(h.submission()).toBeUndefined();
      expect(h.observations.admissionFailure).toMatchObject({code: 'invalid_submission'});
      const before = h.admission()!.diagnostic();
      expect(before).toEqual({dispatchOrdinal: 1, status: 'complete', wireFinishReason: 'tool_calls',
        admissionFailure: 'invalid_submission', compilerFailure: code});
      h.admission()!.revoke('sdk_incomplete');
      expect(h.admission()!.diagnostic()).toEqual(before);
      expect(JSON.stringify(before)).not.toContain('PRIVATE_COMPILER_CANARY');
    } finally {await h.cleanup();}
  });

  it('issues once only after real native and consumer drain, preserving the exact original document', async () => {
    const h = probe({useAdmission: true});
    try {
      const stream = await h.settle();
      expect(h.observations.admissionFailure).toBeUndefined();
      expect(h.admission()!.diagnostic()).not.toHaveProperty('compilerFailure');
      expect(h.submission()).toBeDefined();
      expect(h.readSubmission()).toMatchObject({rawArguments, documentJson, compiled: {body}});
      expect(h.readSubmission().compiled.rawCanonicalPayload).toEqual(rawCanonicalPayload);
      expect(h.submission()!.input.binding.compilerContractVersion).toBe(AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION);
      expect(stream.finalOutput).toBe(body);
      expect(h.observations.order[h.observations.order.length - 1]).toBe('issued');
      expect(h.observations.drained).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      const state = await h.tracked;
      await expect(h.admission()!.settleAfterDrain(state.consumer)).rejects.toMatchObject({code: 'already_settled'});
      expect(h.readSubmission().compiled.body).toBe(body); // duplicate settle did not erase the first receipt.
    } finally {await h.cleanup();}
  });

  it('can await the real stream handoff inside private staging without blocking runner.run()', async () => {
    const h = probe({useAdmission: true, manualBinding: true});
    try {
      await h.handlerEntered.promise;
      expect(h.submission()).toBeUndefined();
      const stream = await h.started;
      h.bind(stream); await h.settle();
      expect(h.submission()).toBeDefined();
    } finally {await h.cleanup();}
  });

  it.each(['sdk_rewrite', 'legacy_delta', 'multiple_tools', 'missing_private_success', 'handler_document_changed', 'input_reject', 'output_rewrite'] as const)(
    'declines issuance from actual wire/handler/SDK evidence: %s', async failure => {
      const h = probe({useAdmission: true,
        ...(failure === 'sdk_rewrite' ? {response: () => chatResponse('{}' + rawArguments)} : {}),
        ...(failure === 'legacy_delta' ? {response: () => chatResponse(rawArguments, {function_call: {name: 'ignored'}})} : {}),
        ...(failure === 'multiple_tools' ? {response: () => chatResponse(rawArguments, {}, true), otherGate: Promise.resolve()} : {}),
        ...(failure === 'missing_private_success' ? {skipPrivateSuccess: true} : {}),
        ...(failure === 'handler_document_changed' ? {handlerDocument: documentJson + ' '} : {}),
        ...(failure === 'input_reject' || failure === 'output_rewrite' ? {guardrail: failure} : {}),
      });
      try {
        await h.settle();
        expect(h.submission()).toBeUndefined();
        expect(h.observations.admissionFailure).toBeTruthy();
        expect(h.fetcher).toHaveBeenCalledTimes(1);
      } finally {await h.cleanup();}
    });

  it('does not issue a submission merely because finalOutput exists before a final guardrail fails', async () => {
    const gate = deferred<void>(), entered = deferred<void>();
    const h = probe({useAdmission: true, finalGuardrail: async () => {
      entered.resolve(); await gate.promise; return {outputInfo: null, tripwireTriggered: true};
    }});
    try {
      await entered.promise;
      expect((await h.started).finalOutput).toBe(body);
      expect(h.submission()).toBeUndefined();
      gate.resolve(); await h.settle();
      expect(h.submission()).toBeUndefined();
      expect(h.observations.admissionFailure).toMatchObject({code: 'sdk_incomplete'});
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('preserves natural completion through SDK cleanup and a consumer drain after the original deadline', async () => {
    const gate = deferred<void>();
    const deadline = Date.now() + 1000;
    const h = probe({useAdmission: true, deadlineAt: () => deadline, consumerGate: gate.promise});
    let restoreClock: (() => void) | undefined;
    try {
      const stream = await h.started;
      await stream.completed;
      expect(h.submission()).toBeUndefined();
      h.controller.abort(); // SDK cleanup only, not the product cancellation signal.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      restoreClock = () => clock.mockRestore();
      gate.resolve(); await h.settle();
      expect(h.observations.admissionFailure).toBeUndefined();
      h.clearAttempt();
      expect(h.readSubmission().compiled.body).toBe(body);
    } finally {restoreClock?.(); gate.resolve(); await h.cleanup();}
  });

  it('withholds the token and drains a real handler that ignores product cancellation', async () => {
    const gate = deferred<void>();
    const h = probe({useAdmission: true, handlerGate: gate.promise});
    try {
      await h.handlerWorkEntered.promise;
      const stream = await h.started;
      h.cancel(); await stream.completed; await boundary();
      expect(h.observations.drained).toBe(false);
      expect(h.submission()).toBeUndefined();
      gate.resolve(); await h.settle();
      expect(h.submission()).toBeUndefined();
      expect(h.observations.admissionFailure).toMatchObject({code: 'cancelled'});
      expect(h.observations.drained).toBe(true);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('revokes an issued submission on conflicting dispatch and rechecks finalization ownership', async () => {
    const h = probe({useAdmission: true});
    try {
      await h.settle(); expect(h.submission()).toBeDefined();
      h.admission()!.wireObserver.startRequest();
      expect(() => h.readSubmission()).toThrow();
    } finally {await h.cleanup();}
    const other = probe({useAdmission: true});
    try {
      await other.settle(); expect(other.submission()).toBeDefined();
      other.revokeOwner();
      expect(() => other.readSubmission()).toThrow();
    } finally {await other.cleanup();}
  });
});

/** Independent native wire fixture; P1 prototype and P2 actual bridge share only test data. */
function nativeObjectFixture(): AuthoredClaimObjectInput {
  return {representationVersion: 'authored_claim_document@2', referenceDictionary: [
    {evidenceRefId: 'data:fixture', sourceRef: null, sourceToolCallId: null, artifactId: null,
      sourceArtifactId: null, column: 'duration', rowIndex: 0, rowSelector: null, value: {kind: 'present', value: 10}},
    {evidenceRefId: null, sourceRef: null, sourceToolCallId: null, artifactId: null,
      sourceArtifactId: null, column: null, rowIndex: null, rowSelector: null, value: {kind: 'present', value: null}},
    {evidenceRefId: null, sourceRef: null, sourceToolCallId: null, artifactId: null,
      sourceArtifactId: null, column: null, rowIndex: null, rowSelector: [], value: {kind: 'absent'}},
  ], semanticFrames: [{predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted', quantifier: 'one',
    modality: 'certain', conditions: null, population: 'cited_rows'}], contract: {
    mode: 'focused_answer', conclusions: null, clusters: null, evidenceChain: null, uncertainties: [], nextSteps: [],
    relationProposals: null, sourceClaimBindings: null, metadata: null, claims: [{id: 'duration', conclusionId: null,
      text: '10 ms', kind: 'numeric', references: [0], artifactRefs: null, relationRefs: null, supportLevel: null,
      semantics: {frameIndex: 0, subjectRefs: [0], objectRefs: null, timeRangeNs: null,
        numeric: {operator: 'eq', value: 10, unit: 'ms', presentation: null}}}],
  }, bodyParts: ['{"literal":"keep"}', '[1,2]', '\n```json\n{"literal":true}\n```\n',
    '<!-- perfetto-conclusion-contract literal -->', ' emoji: 😀 lone: \ud800 ', {claimText: 'duration'}]};
}

function nativeObjectProbe(options: {
  contractVersion?: 'openai_typed_final_admission@3' | 'openai_typed_final_admission@4';
  input?: string | AgentInputItem[];
  maxTurns?: number;
  response?: () => Response;
  beforeCallback?: (stream: NativeStream) => void;
  productionBridge?: boolean;
  literalSubtree?: boolean;
  mutateHandler?: boolean;
  deadlineAt?: () => number;
  argumentsText?: string;
  normalizeHandler?: boolean;
  optionalNullControl?: boolean;
  manualBinding?: boolean;
  handlerGate?: Promise<void>;
  consumerGate?: Promise<void>;
  fetchGate?: Promise<void>;
  otherGate?: Promise<void>;
  guardrail?: 'input_reject' | 'output_rewrite';
} = {}) {
  const argumentsText = options.argumentsText ?? JSON.stringify({document: nativeObjectFixture()});
  const documentSchema = authoredClaimObjectSchema.describe('Native object fixture');
  const shape = {document: options.literalSubtree ? preserveRuntimeLiteralJson(documentSchema) : documentSchema,
    ...(options.optionalNullControl ? {optionalSelector: z.string().optional()} : {})};
  const schema = createJsonSchemaFromZodRawShape(shape);
  const controller = new AbortController(), productController = new AbortController(), ready = deferred<NativeStream>();
  void ready.promise.catch(() => undefined);
  const collector = createOpenAiTypedFinalWireCollector();
  const assistantTextEntered = deferred<void>();
  const fetchEntered = deferred<void>(), stageEntered = deferred<void>(), handlerEntered = deferred<void>(), callbackEntered = deferred<void>(), otherEntered = deferred<void>();
  const observations = {sdkArgs: undefined as unknown, handlerArgs: undefined as unknown, sdkRawArguments: '',
    requestSchema: undefined as unknown, rawEvents: [] as unknown[], handlerCalls: 0, callbackCalls: 0, drained: false, consumerDrained: false,
    compiled: undefined as AuthoredClaimObjectResult | undefined, admissionFailure: undefined as unknown};
  const handler = async (args: unknown) => {
    observations.handlerArgs = args; observations.handlerCalls++; handlerEntered.resolve();
    await options.handlerGate;
    if (options.mutateHandler) (args as {document: AuthoredClaimObjectInput}).document.bodyParts.push('handler mutation');
    const record = args as Record<string, unknown>;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(record, 'document')) throw new Error('prototype_outer_shape');
    const result = compileAuthoredClaimObject(record.document);
    observations.compiled = result;
    if (result.status !== 'compiled') throw new Error(`prototype_projection:${result.code}`);
    return OPENAI_TYPED_FINAL_PENDING_ACK;
  };
  let finalTool = tool({name: finalToolName, description: 'Local native-object feasibility fixture.',
    parameters: schema as any, strict: true, errorFunction: null,
    ...(options.guardrail === 'input_reject' ? {inputGuardrails: [{name: 'native-input-reject',
      run: async () => ({behavior: {type: 'rejectContent' as const, message: 'fixture reject'}})}]} : {}),
    ...(options.guardrail === 'output_rewrite' ? {outputGuardrails: [{name: 'native-output-rewrite',
      run: async () => ({behavior: {type: 'rejectContent' as const, message: 'fixture rewritten ACK'}})}]} : {}),
    execute: async (args, _context, details) => {
      observations.sdkArgs = args;
      observations.sdkRawArguments = details?.toolCall?.arguments ?? '';
      return handler(options.normalizeHandler ? normalizeRuntimeToolArgs(args, shape) : args);
    }});
  const ownerBinding = {owner: {}, sessionId: 'native-session', runId: 'native-run', attemptId: 'native-attempt',
    providerPin: 'native-pin', authorizationFingerprint: 'native-auth'};
  let ownerCurrent = true, attemptCurrent = true;
  const assertCurrent = () => {if (!ownerCurrent || productController.signal.aborted) throw new Error('owner revoked');};
  const issuer = options.productionBridge ? createAuthoredFinalSubmissionIssuer({binding: ownerBinding,
    representationVersion: 'authored_claim_document@2', assertCurrent,
    ...(options.contractVersion === 'openai_typed_final_admission@4' ? {sourcePolicy: 'function_or_assistant_json' as const} : {}),
    assertAttemptCurrent: () => {if (!attemptCurrent) throw new Error('attempt ended');}}) : undefined;
  let admission: ReturnType<typeof createOpenAiTypedFinalAttempt> | undefined;
  let submission: AuthoredConclusionSubmission | undefined;
  if (issuer) {
    const registry = new McpToolRegistry();
    registry.registerShared({name: finalToolName, role: 'final_candidate_submission', exposure: 'internal',
      evidenceEffect: 'none', description: 'Actual adapter native object fixture', inputSchema: shape,
      handler: async args => ({content: [{type: 'text', text: await handler(args)}]})});
    const [installed] = createOpenAIToolsFromMcpDefinitions(registry.list(), {currentFinalAttempt: () => admission});
    if (installed.type !== 'function') throw new Error('Expected function tool');
    // Add fixture guardrails before installation without replacing the adapter's invoke or identity.
    installed.inputGuardrails = finalTool.inputGuardrails;
    installed.outputGuardrails = finalTool.outputGuardrails;
    finalTool = installed;
    admission = createOpenAiTypedFinalAttempt({finalTool, toolName: finalTool.name, issuer, ownerBinding,
      representationVersion: 'authored_claim_document@2', ...(options.contractVersion ? {contractVersion: options.contractVersion} : {}),
      signal: productController.signal, assertCurrent,
      deadlineAt: options.deadlineAt ?? (() => Date.now() + 60_000)});
    const actualStage = admission.stageInvocation;
    admission.stageInvocation = call => {
      stageEntered.resolve();
      observations.sdkArgs = call.parsedArguments;
      observations.sdkRawArguments = (call.toolCall as {arguments?: string})?.arguments ?? '';
      return actualStage(call); // Observe the actual SDK values, never substitute parsed fixture data.
    };
  }
  const otherTool = tool({name: 'other_fixture', description: 'Independent pending work.', parameters: z.object({}),
    execute: async () => {otherEntered.resolve(); await options.otherGate; return 'finished';}});
  const agent = new Agent<unknown, 'text'>({name: 'native-object-test-only', model: 'fixture-model', instructions: 'Fixture only.',
    tools: [finalTool, ...(options.otherGate ? [otherTool] : [])], toolUseBehavior: async (context, results) => {
      observations.callbackCalls++; callbackEntered.resolve();
      if (options.beforeCallback) options.beforeCallback(await ready.promise);
      if (admission) return admission.toolUseBehavior(context, results);
      const stream = await ready.promise;
      if (controller.signal.aborted) throw new Error('prototype_cancelled');
      if (results.length !== 1) throw new Error('prototype_multiple_tools');
      const receipt = collector.current();
      if (!receipt || 'sourceKind' in receipt || observations.sdkRawArguments !== receipt.rawArguments) throw new Error('prototype_raw_mismatch');
      const wireValue: unknown = JSON.parse(receipt.rawArguments);
      if (!isDeepStrictEqual(wireValue, observations.sdkArgs)) throw new Error('prototype_sdk_args_changed');
      if (!isDeepStrictEqual(wireValue, observations.handlerArgs)) throw new Error('prototype_handler_args_changed');
      const result = results[0];
      if (result.type !== 'function_output' || result.tool !== finalTool || result.output !== OPENAI_TYPED_FINAL_PENDING_ACK ||
        observations.handlerCalls !== 1 || observations.compiled?.status !== 'compiled') throw new Error('prototype_handler_ack');
      expect(context).toBe(stream.state._context);
      expect(stream.state._lastTurnResponse?.responseId).toBe(receipt.responseId);
      expect(stream.state._lastProcessedResponse?.functions).toHaveLength(1);
      expect(stream.state._pendingAgentToolRuns.size).toBe(0);
      return {isFinalOutput: true, isInterrupted: undefined, finalOutput: observations.compiled.body};
    }});
  const fetcher = jest.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    observations.requestSchema = request.tools[0].function.parameters;
    fetchEntered.resolve(); await options.fetchGate;
    if (options.response) return options.response();
    if (options.otherGate) return chatResponse(argumentsText, {}, true);
    const pieces: string[] = [];
    for (let offset = 0; offset < argumentsText.length; offset += 4096) pieces.push(argumentsText.slice(offset, offset + 4096));
    return streamedArgumentResponse(pieces);
  });
  const actualFetch = openAiRuntimeTesting.createOpenAiTerminalFetch(fetcher, () => undefined, admission?.wireObserver ?? collector);
  const runner = new Runner({modelProvider: new OpenAIProvider({useResponses: false,
    openAIClient: new OpenAI({apiKey: 'test-only', baseURL: 'https://fixture.invalid/v1', maxRetries: 0, fetch: actualFetch})}),
    tracingDisabled: true, traceIncludeSensitiveData: false, toolExecution: {maxFunctionToolConcurrency: 1}});
  const started = startNativeRun(runner, agent, controller.signal, options.input, options.maxTurns);
  let native: NativeStream | undefined;
  let admissionBound = false;
  const bind = (stream: NativeStream) => {
    ready.resolve(stream);
    if (admission && !admissionBound) {admissionBound = true; admission.bindStream(stream);}
  };
  const tracked = started.then(stream => {
    native = stream;
    if (!options.manualBinding) bind(stream);
    const getter = (stream as NativeStream & {_getStreamLoopPromise?: () => unknown})._getStreamLoopPromise;
    if (typeof getter !== 'function') throw new Error('Missing actual SDK drain getter');
    const drain = Promise.resolve(getter.call(stream)).then(() => {observations.drained = true;});
    const consumer = (async () => {
      try {
        for await (const event of stream) {
          if (event.type === 'raw_model_stream_event') {
            observations.rawEvents.push(event.data);
            if (event.data.type === 'output_text_delta') assistantTextEntered.resolve();
          }
        }
        await stream.completed;
      }
      finally {await options.consumerGate; observations.consumerDrained = true;}
    })();
    void consumer.catch(() => undefined); void stream.completed.catch(() => undefined);
    return {stream, drain, consumer};
  }, error => {ready.reject(error); admission?.failStartup(); throw error;});
  void tracked.catch(() => undefined);
  const admissionOutcome = admission ? tracked.then(async state => {
    try {submission = await admission!.settleAfterDrain(state.consumer);}
    catch (error) {observations.admissionFailure = error;}
  }) : Promise.resolve();
  void admissionOutcome.catch(() => undefined);
  return {argumentsText, collector, observations, started, tracked, bind, controller,
    submission: () => submission, admission: () => admission,
    readSubmission: () => readAuthoredFinalSubmission(submission!.submission, submission!.input),
    cancel: () => {productController.abort(); controller.abort();},
    revokeOwner: () => {ownerCurrent = false;}, clearAttempt: () => {attemptCurrent = false;},
    fetchEntered, stageEntered, handlerEntered, callbackEntered, otherEntered, assistantTextEntered, fetcher,
    settle: async () => {const state = await tracked;
      await Promise.allSettled([state.drain, state.consumer, state.stream.completed]); await admissionOutcome; return state.stream;},
    cleanup: async () => {controller.abort(); if (native) bind(native);
      const state = await tracked.catch(() => undefined);
      if (state) await Promise.allSettled([state.drain, state.consumer, state.stream.completed]);
      await admissionOutcome; if (issuer) revokeAuthoredFinalSubmissionIssuer(issuer);},
  };
}

describe('S2 P1 native-object installed-SDK feasibility (no product issuer)', () => {
  it('sends the complete converted schema and preserves required nulls, literals and all three material views', async () => {
    const h = nativeObjectProbe();
    try {
      const stream = await h.settle();
      expect(stream.error).toBeNull();
      expect(h.observations.sdkRawArguments).toBe(h.argumentsText);
      expect(h.collector.current()).toMatchObject({rawArguments: h.argumentsText});
      const expected = JSON.parse(h.argumentsText);
      expect(h.observations.sdkArgs).toEqual(expected); expect(h.observations.handlerArgs).toEqual(expected);
      expect(expected.document.referenceDictionary[1].value).toEqual({kind: 'present', value: null});
      expect(expected.document.referenceDictionary[2].value).toEqual({kind: 'absent'});
      expect(h.observations.compiled?.status).toBe('compiled');
      if (h.observations.compiled?.status !== 'compiled') throw new Error('Expected local compiler result');
      expect(stream.finalOutput).toBe(h.observations.compiled.body);
      expect(h.observations.compiled.privateNativeDocument).toEqual(expected.document);
      const walk = (entry: unknown) => {
        if (!entry || typeof entry !== 'object') return;
        if (Array.isArray(entry)) {entry.forEach(walk); return;}
        const schema = entry as Record<string, unknown>;
        if (schema.type === 'object') {
          expect(schema.additionalProperties).toBe(false);
          expect(schema.required).toEqual(Object.keys(schema.properties as object));
        }
        expect(schema).not.toHaveProperty('oneOf');
        Object.values(schema).forEach(walk);
      };
      walk(h.observations.requestSchema);
      expect(h.observations.requestSchema).toMatchObject({type: 'object', required: ['document']});
      expect(h.observations.drained).toBe(true); expect(h.observations.consumerDrained).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.observations.handlerCalls).toBe(1);
      console.info('S2 P1 native schema observation', {schemaUtf8Bytes: Buffer.byteLength(JSON.stringify(h.observations.requestSchema)),
        rawArgumentsUtf8Bytes: Buffer.byteLength(h.argumentsText)});
    } finally {await h.cleanup();}
  });

  it.each(['1e999', '-0'] as const)('preserves raw numeric spelling %s through actual SDK and pure projection', async literal => {
    const finiteWire = JSON.stringify({document: nativeObjectFixture()});
    const argumentsText = finiteWire.replace('"numeric":{"operator":"eq","value":10', `"numeric":{"operator":"eq","value":${literal}`);
    expect(argumentsText).not.toBe(finiteWire); // Numeric wire text is never produced by stringify of Infinity/-0.
    const h = nativeObjectProbe({argumentsText});
    try {
      const stream = await h.settle(); expect(stream.error).toBeNull();
      const actual = (h.observations.handlerArgs as {document: AuthoredClaimObjectInput}).document;
      const expected = literal === '1e999' ? Infinity : -0;
      expect(Object.is(actual.contract.claims[0].semantics!.numeric!.value, expected)).toBe(true);
      expect(h.observations.sdkRawArguments).toBe(argumentsText);
      const compiled = h.observations.compiled;
      if (compiled?.status !== 'compiled') throw new Error('Expected preserved semantic value');
      const rawClaim = (compiled.rawCanonicalPayload.claims as Array<{semantics: {numeric: {value: unknown}}}>)[0];
      expect(Object.is(rawClaim.semantics.numeric.value, expected)).toBe(true);
      if (literal === '1e999') expect(compiled.canonicalParse.status).not.toBe('valid');
      expect(actual.referenceDictionary[0].value).toEqual({kind: 'present', value: 10});
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('can await real stream binding in the native-object callback without deadlock', async () => {
    const h = nativeObjectProbe({manualBinding: true});
    try {
      await h.callbackEntered.promise;
      const stream = await h.started; expect(h.observations.drained).toBe(false);
      h.bind(stream); await h.settle();
      expect(stream.error).toBeNull(); expect(stream.state._currentStep?.type).toBe('next_step_final_output');
      expect(stream.state._currentTurnInProgress).toBe(false);
    } finally {await h.cleanup();}
  });

  it('does not equate visible finalOutput/native drain with a completed caller consumer', async () => {
    const gate = deferred<void>(), h = nativeObjectProbe({consumerGate: gate.promise});
    let settled = false;
    const work = h.settle().then(stream => {settled = true; return stream;});
    try {
      const state = await h.tracked; await state.stream.completed; await state.drain; await boundary();
      expect(state.stream.finalOutput).toBeTruthy(); expect(h.observations.drained).toBe(true);
      expect(h.observations.consumerDrained).toBe(false); expect(settled).toBe(false);
      gate.resolve(); await work; expect(h.observations.consumerDrained).toBe(true);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('waits for another actual function and rejects the ambiguous multi-tool final', async () => {
    const gate = deferred<void>(), h = nativeObjectProbe({otherGate: gate.promise});
    try {
      await h.otherEntered.promise; expect(h.observations.callbackCalls).toBe(0); expect(h.observations.drained).toBe(false);
      gate.resolve(); const stream = await h.settle();
      expect(stream.error).toMatchObject({message: 'prototype_multiple_tools'});
      expect(h.collector.current()).toBeUndefined(); expect(h.observations.drained).toBe(true);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('detects actual SDK raw argument repair instead of accepting a normalized outer object', async () => {
    const raw = JSON.stringify({document: nativeObjectFixture()});
    const h = nativeObjectProbe({argumentsText: '{}' + raw});
    try {
      const stream = await h.settle();
      expect(h.observations.sdkRawArguments).toBe(raw); expect(h.collector.current()).toMatchObject({rawArguments: '{}' + raw});
      expect(stream.error).toMatchObject({message: 'prototype_raw_mismatch'});
    } finally {await h.cleanup();}
  });

  it('demonstrates optional-null SDK stripping on a deliberately unsafe control schema', async () => {
    const h = nativeObjectProbe({optionalNullControl: true,
      argumentsText: JSON.stringify({document: nativeObjectFixture(), optionalSelector: null})});
    try {
      const stream = await h.settle();
      expect(h.observations.sdkArgs).not.toHaveProperty('optionalSelector');
      const receipt = h.collector.current();
      if (!receipt || 'sourceKind' in receipt) throw new Error('Expected the original function receipt');
      expect(JSON.parse(receipt.rawArguments)).toHaveProperty('optionalSelector', null);
      expect(stream.error).toMatchObject({message: 'prototype_sdk_args_changed'});
    } finally {await h.cleanup();}
  });

  it.each(['input_reject', 'output_rewrite'] as const)('keeps actual %s distinct from handler plus exact ACK success', async guardrail => {
    const h = nativeObjectProbe({guardrail});
    try {
      const stream = await h.settle();
      expect(h.observations.handlerCalls).toBe(guardrail === 'input_reject' ? 0 : 1);
      expect(stream.error).toBeTruthy(); expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it.each(['fetch', 'handler'] as const)('drains actual native-object %s work which ignores cancellation', async held => {
    const gate = deferred<void>(), h = nativeObjectProbe(held === 'fetch' ? {fetchGate: gate.promise} : {handlerGate: gate.promise});
    try {
      await (held === 'fetch' ? h.fetchEntered.promise : h.handlerEntered.promise);
      const stream = await h.started; h.controller.abort(); await stream.completed; await boundary();
      expect(stream.cancelled).toBe(true); expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle(); expect(h.observations.drained).toBe(true);
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
    } finally {gate.resolve(); await h.cleanup();}
  });

  it.each(['version', 'extra_key', 'frame_index', 'nodes', 'expanded'] as const)('retains the local compiler refusal for actual SDK object input: %s', async kind => {
    const document = nativeObjectFixture();
    let argumentsText: string;
    if (kind === 'frame_index') document.contract.claims[0].semantics!.frameIndex = 999;
    if (kind === 'nodes') document.semanticFrames[0].conditions = Array(10_001).fill('condition');
    if (kind === 'expanded') {
      document.semanticFrames[0].conditions = ['x'.repeat(600_000)];
      document.contract.claims.push({...document.contract.claims[0], id: 'second'});
    }
    if (kind === 'version') argumentsText = JSON.stringify({document: {...document, representationVersion: 'unknown@999'}});
    else if (kind === 'extra_key') argumentsText = JSON.stringify({document: {...document, extra: 'unallowed'}});
    else argumentsText = JSON.stringify({document});
    const expected = {version: 'unsupported_version', extra_key: 'invalid_structure', frame_index: 'invalid_frame_index',
      nodes: 'raw_nodes_exceeded', expanded: 'expanded_bytes_exceeded'}[kind];
    const h = nativeObjectProbe({argumentsText});
    try {
      const stream = await h.settle();
      expect(h.observations.handlerCalls).toBe(1);
      expect(h.observations.compiled).toMatchObject({status: 'projection_failed', code: expected});
      expect(stream.error).toMatchObject({message: `Failed to run function tools: Error: prototype_projection:${expected}`,
        error: {message: `prototype_projection:${expected}`}});
      expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  // P1's retained RED log proves this defect; unmarked legacy behavior remains an explicit unsafe control.
  it('retains the unmarked normalizer counterexample without changing ordinary tool behavior', async () => {
    const h = nativeObjectProbe({normalizeHandler: true});
    try {
      await h.settle();
      expect(h.observations.sdkArgs).toEqual(JSON.parse(h.argumentsText));
      expect(h.observations.handlerArgs).not.toEqual(h.observations.sdkArgs);
      expect(h.observations.compiled?.status).toBe('projection_failed');
    } finally {await h.cleanup();}
  });
});


describe('S2 P2 registry/adapter/native SDK/issued object bridge', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it('preserves the marked object through all three views and issues only an actual drained native final', async () => {
    const h = nativeObjectProbe({productionBridge: true, literalSubtree: true});
    try {
      const stream = await h.settle(); expect(stream.error).toBeNull();
      expect(h.observations.admissionFailure).toBeUndefined();
      expect(h.observations.sdkRawArguments).toBe(h.argumentsText);
      expect(h.observations.sdkArgs).toEqual(JSON.parse(h.argumentsText));
      expect(h.observations.handlerArgs).toEqual(h.observations.sdkArgs);
      const issued = h.readSubmission();
      expect(issued.binding.representationVersion).toBe('authored_claim_document@2');
      expect(issued).not.toHaveProperty('documentJson');
      expect(issued).toMatchObject({rawArguments: h.argumentsText});
      expect(issued.compiled.body).toBe(stream.finalOutput);
      expect(issued.compiled.body).toContain('{"literal":"keep"}');
      expect(issued.compiled.body).toContain('[1,2]');
      expect(h.observations.drained).toBe(true); expect(h.observations.consumerDrained).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.observations.handlerCalls).toBe(1);
      h.clearAttempt(); h.controller.abort(); expect(h.readSubmission()).toBe(issued);
      h.revokeOwner(); expect(() => h.readSubmission()).toThrow('inactive');
    } finally {await h.cleanup();}
  });

  it.each(['1e999', '-0'])('issues original native %s without repairing its canonical value', async literal => {
    const finite = JSON.stringify({document: nativeObjectFixture()});
    const argumentsText = finite.replace('"numeric":{"operator":"eq","value":10', `"numeric":{"operator":"eq","value":${literal}`);
    const h = nativeObjectProbe({productionBridge: true, literalSubtree: true, argumentsText});
    try {
      const stream = await h.settle(); expect(stream.error).toBeNull();
      const issued = h.readSubmission();
      const rawClaim = (issued.compiled.rawCanonicalPayload.claims as Array<{semantics: {numeric: {value: unknown}}}>)[0];
      expect(Object.is(rawClaim.semantics.numeric.value, literal === '1e999' ? Infinity : -0)).toBe(true);
      expect(issued).toMatchObject({rawArguments: argumentsText});
      if (literal === '1e999') expect(issued.compiled.canonicalParse.status).not.toBe('valid');
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it.each(['unmarked', 'sdk_null_strip', 'handler_mutation', 'sdk_raw_repair', 'wrong_version', 'wrong_key', 'input_reject', 'output_rewrite'] as const)
    ('refuses actual transport/material mismatch %s without a receipt or fallback', async failure => {
      let argumentsText = JSON.stringify({document: nativeObjectFixture()});
      if (failure === 'sdk_null_strip') argumentsText = JSON.stringify({document: nativeObjectFixture(), optionalSelector: null});
      if (failure === 'sdk_raw_repair') argumentsText = '{}' + argumentsText;
      if (failure === 'wrong_version') argumentsText = argumentsText.replace('authored_claim_document@2', 'authored_claim_document@1');
      if (failure === 'wrong_key') argumentsText = JSON.stringify({documentJson});
      const h = nativeObjectProbe({productionBridge: true, literalSubtree: failure !== 'unmarked', argumentsText,
        optionalNullControl: failure === 'sdk_null_strip', mutateHandler: failure === 'handler_mutation',
        ...(failure === 'input_reject' || failure === 'output_rewrite' ? {guardrail: failure} : {})});
      try {
        const stream = await h.settle();
        expect(h.submission()).toBeUndefined(); expect(h.observations.admissionFailure).toBeDefined();
        expect(stream.state._currentStep?.type).not.toBe('next_step_final_output');
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        if (failure === 'sdk_null_strip') expect(h.observations.sdkArgs).not.toHaveProperty('optionalSelector');
        if (failure === 'sdk_raw_repair') expect(h.observations.sdkRawArguments).not.toBe(argumentsText);
        if (failure === 'handler_mutation') expect(h.admission()?.diagnostic()).toMatchObject({admissionFailure: 'handler_failed'});
      } finally {await h.cleanup();}
    });

  it('waits for real stream binding during the adapter stage without circular SDK dependency', async () => {
    const h = nativeObjectProbe({productionBridge: true, literalSubtree: true, manualBinding: true});
    try {
      await h.stageEntered.promise;
      const stream = await h.started;
      expect(h.observations.handlerCalls).toBe(0); expect(h.submission()).toBeUndefined();
      h.bind(stream); await h.settle();
      expect(stream.error).toBeNull(); expect(h.submission()).toBeDefined();
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('retains the issued body behind the real consumer-drain gate even after visible native completion', async () => {
    const gate = deferred<void>(), h = nativeObjectProbe({productionBridge: true, literalSubtree: true, consumerGate: gate.promise});
    try {
      const state = await h.tracked; await state.stream.completed; await state.drain; await boundary();
      expect(state.stream.finalOutput).toBeTruthy(); expect(h.submission()).toBeUndefined();
      expect(h.observations.consumerDrained).toBe(false);
      gate.resolve(); await h.settle(); expect(h.submission()).toBeDefined();
    } finally {gate.resolve(); await h.cleanup();}
  });

  it.each(['cancel', 'owner', 'deadline'])('rejects %s during actual handler work and drains without a second dispatch', async reason => {
    const gate = deferred<void>(); let deadline = Date.now() + 60_000;
    const h = nativeObjectProbe({productionBridge: true, literalSubtree: true, handlerGate: gate.promise, deadlineAt: () => deadline});
    try {
      await h.handlerEntered.promise;
      if (reason === 'cancel') h.cancel();
      if (reason === 'owner') h.revokeOwner();
      if (reason === 'deadline') deadline = 0;
      await boundary(); expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle();
      expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('waits for another actual tool before rejecting the non-unique final response', async () => {
    const gate = deferred<void>(), h = nativeObjectProbe({productionBridge: true, literalSubtree: true, otherGate: gate.promise});
    try {
      await h.otherEntered.promise; expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle(); expect(h.submission()).toBeUndefined();
      expect(h.admission()?.diagnostic()).toMatchObject({admissionFailure: 'wire_ineligible'});
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {gate.resolve(); await h.cleanup();}
  });
});


/** A-only observations: these tests require the old mixed-content rejection to remain. */
describe('R11 neutral per-request typed output material', () => {
  const provider = () => ({representationVersion: 'authored_claim_document@2' as const,
    rootKeys: Object.keys(authoredClaimObjectSchema.shape),
    contractKeys: Object.keys(authoredClaimObjectSchema.shape.contract.shape), measure: measureAuthoredJson});
  // Optional access keeps the pre-implementation RED an assertion about missing observation,
  // not a missing-module/import exception. The implementation must supply this per-request API.
  type MaterialEvents = ReturnType<ReturnType<typeof createOpenAiTypedFinalWireCollector>['startRequest']> & {
    readonly dispatchOrdinal?: number; materialSnapshot?(): RuntimeTypedOutputMaterial | undefined;
  };
  const make = (withProvider = true, measure = measureAuthoredJson) => createOpenAiTypedFinalWireCollector({
    finalToolName, ...(withProvider ? {materialProvider: {...provider(), measure}} : {})});
  const chunk = (args: string, extras: Record<string, unknown> = {}, index = 0) => ({id: 'material-response', choices: [{index: 0,
    delta: {...extras, tool_calls: [{index, id: `material-call-${index}`, type: 'function', function: {name: finalToolName, arguments: args}}]}, finish_reason: null}]});
  const end = (events: MaterialEvents, reason = 'tool_calls', done = true) => {
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {}, finish_reason: reason}]});
    if (done) events.done(); events.end(true);
  };
  const read = (events: MaterialEvents) => {
    const material = events.materialSnapshot?.();
    expect(material).toBeDefined();
    if (!material) throw new Error('Expected closed material observation');
    return material;
  };

  it('measures retained complete v2 arguments even when assistant_content rejected the same response', () => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    const document = nativeObjectFixture(), args = JSON.stringify({document}, null, 2);
    events.chunk(chunk(args, {content: 'PRIVATE_COMPANION'})); end(events);
    expect(collector.current()).toBeUndefined();
    expect(collector.diagnostic()).toMatchObject({status: 'rejected', reason: 'assistant_content'});
    const material = read(events);
    expect(events.dispatchOrdinal).toBe(1);
    expect(material).toMatchObject({schemaVersion: 'typed_output_material@1', wireToolRole: 'final_role',
      transport: {doneSeen: true, eofSeen: true, framing: 'valid', finishReason: 'tool_calls'},
      decoded: {arguments: {utf8Bytes: Buffer.byteLength(args), utf16Chars: args.length, utf8Precision: 'exact', utf16Precision: 'exact'},
        companion: {utf8Bytes: 17, utf16Chars: 17, utf8Precision: 'exact'}},
      retention: {arguments: {status: 'complete', retainedUtf8Bytes: Buffer.byteLength(args)},
        companion: {status: 'not_retained', retainedUtf8Bytes: 0}, combinedRetainedUtf8Bytes: Buffer.byteLength(args)},
      json: {status: 'complete_json'}, representation: 'authored_claim_document@2', structure: {status: 'measured'}});
    expect(JSON.stringify(material)).not.toMatch(/PRIVATE_COMPANION|data:fixture|numeric.cell|material-call|rawArguments/);
    expect(Object.isFrozen(material)).toBe(true);
  });

  it('preserves the old unsafe raw_limit diagnostic while independently refusing to parse a valid retained prefix', () => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk('{}', {content: 'prefix'}));
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {tool_calls: [{index: 0,
      function: {arguments: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES + 1)}}]}, finish_reason: null}]});
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: ' '}}]}, finish_reason: null}]});
    end(events);
    // The original collector's unsafeWireFailure takes precedence over its earlier soft content rejection.
    expect(collector.diagnostic()).toMatchObject({reason: 'raw_limit'});
    const material = read(events);
    expect(material).toMatchObject({transport: {doneSeen: true, eofSeen: true}, retention: {arguments: {status: 'over_limit', retainedUtf8Bytes: 2}},
      decoded: {arguments: {utf8Precision: 'lower_bound'}}, json: {status: 'not_parsed'}, structure: {status: 'not_observed'}});
    expect(collector.current()).toBeUndefined();
  });

  it.each(['length', 'missing_done', 'invalid_json'] as const)('separates observed JSON from native completion: %s', failure => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk(failure === 'invalid_json' ? '{"document":' : JSON.stringify({document: nativeObjectFixture()})));
    end(events, failure === 'length' ? 'length' : 'tool_calls', failure !== 'missing_done');
    const material = read(events);
    expect(material.transport).toMatchObject({eofSeen: true, doneSeen: failure !== 'missing_done'});
    expect(material.json.status).toBe(failure === 'invalid_json' ? 'invalid_json' : 'complete_json');
    if (failure !== 'invalid_json') expect(collector.current()).toBeUndefined();
  });

  it('uses the payload discriminant and leaves structure unknown without the candidate-only schema provider', () => {
    const collector = make(false), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document: nativeObjectFixture()}))); end(events);
    expect(read(events)).toMatchObject({representation: 'authored_claim_document@2', json: {status: 'complete_json'}, structure: {status: 'not_observed'}});
    const foreign = collector.startRequest() as MaterialEvents;
    foreign.chunk(chunk(JSON.stringify({document: {...nativeObjectFixture(), representationVersion: 'private-unknown-version'}}))); end(foreign);
    expect(read(foreign)).toMatchObject({representation: 'unknown', structure: {status: 'not_observed'}});
  });

  it('preserves original invalid entries, nullable kind and exact text reuse without normalizing them', () => {
    const document = nativeObjectFixture();
    const raw = {...document, contract: {...document.contract, claims: [
      {kind: 'numeric', text: 'A'}, {kind: null, text: 'A'}, {text: '{"x":1}'}, {}, 7, {kind: 'invented', text: 'other'}]},
      bodyParts: ['A', '{"x":1}', {claimText: 'not-resolved'}, false]};
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document: raw}))); end(events);
    const material = read(events);
    if (material.structure.status !== 'measured') throw new Error('Expected raw structure counts');
    expect(material.structure.collections.claims).toEqual({status: 'array', items: 6});
    expect(material.structure.claimKinds).toEqual({counts: Object.fromEntries(CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => [kind, kind === 'numeric' ? 1 : 0])), absent: 3, unclassified: 2});
    expect(material.structure.bodyParts).toEqual({literalPartCount: 2, literalPartTextUtf8Bytes: 8, claimTextUseCount: 1, unclassifiedPartCount: 1});
    expect(material.structure.exactTextReuse).toEqual({duplicateClaimTextCount: 1, duplicateClaimTextUtf8Bytes: 1,
      literalPartMatchingClaimTextCount: 2, literalPartMatchingClaimTextUtf8Bytes: 8});
    const partition = material.structure.partition;
    expect(partition.status).toBe('measured');
    if (partition.status !== 'measured') throw new Error('Expected normalized partition');
    expect(partition.claims).toBe(Buffer.byteLength(JSON.stringify(raw.contract.claims)));
    expect(partition.totalNormalizedUtf8Bytes).toBe(Buffer.byteLength(JSON.stringify({document: raw})));
    expect(partition.referenceDictionary + partition.semanticFrames + partition.claims + partition.bodyParts + partition.contractOther + partition.overhead)
      .toBe(partition.totalNormalizedUtf8Bytes);
    expect(material.structure).not.toHaveProperty('assembledBodyBytes');
  });

  it.each(['missing', 'null', 'wrong_type', 'empty'] as const)('does not turn %s collections into valid-subset zeroes', shape => {
    const document = nativeObjectFixture();
    const raw: Record<string, unknown> = {...document, contract: {...document.contract}};
    const contract = raw.contract as Record<string, unknown>;
    if (shape === 'missing') delete contract.claims;
    if (shape === 'null') contract.claims = null;
    if (shape === 'wrong_type') contract.claims = 'PRIVATE_WRONG_CONTAINER';
    if (shape === 'empty') contract.claims = [];
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document: raw}))); end(events);
    const material = read(events);
    if (material.structure.status !== 'measured') throw new Error('Expected observed container status');
    expect(material.structure.collections.claims).toEqual(shape === 'empty' ? {status: 'array', items: 0} : {status: shape});
    if (shape !== 'empty') expect(material.structure.claimKinds).toBeUndefined();
  });

  it.each(['root', 'contract'])('does not absorb an unknown %s key into normalized overhead', location => {
    const document = nativeObjectFixture();
    const raw = location === 'root' ? {...document, PRIVATE_UNKNOWN: 'secret'} : {...document, contract: {...document.contract, PRIVATE_UNKNOWN: 'secret'}};
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document: raw}))); end(events);
    const material = read(events);
    expect(material.structure).toMatchObject({status: 'measured', partition: {status: 'unsupported_shape'}});
    expect(JSON.stringify(material)).not.toContain('PRIVATE_UNKNOWN');
  });

  it('keeps per-call Unicode tails separate in ambiguous multi-tool output', () => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk('\ud83d', {}, 0)); events.chunk(chunk('\ude00', {}, 1)); end(events);
    expect(read(events)).toMatchObject({wireToolRole: 'ambiguous', decoded: {arguments: {utf8Bytes: 6, utf16Chars: 2, utf8Precision: 'exact'}},
      retention: {arguments: {status: 'ambiguous'}}, json: {status: 'not_parsed'}, structure: {status: 'not_observed'}});
    expect(collector.current()).toBeUndefined();
  });

  it('does not pair surrogate halves across a conflicting call id at the same index', () => {
    const events = make().startRequest() as MaterialEvents;
    events.chunk(chunk('\ud83d'));
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'different-call',
      type: 'function', function: {arguments: '\ude00'}}]}, finish_reason: null}]}); end(events);
    const material = read(events);
    expect(material).toMatchObject({wireToolRole: 'unknown', decoded: {arguments: {utf8Precision: 'lower_bound', utf16Chars: 2}}, json: {status: 'not_parsed'}});
    expect(material.decoded.arguments!.utf8Bytes).toBeLessThanOrEqual(6);
  });

  it('bounds tool identity tracking and marks lost byte precision rather than joining unrelated surrogate halves', () => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    for (let index = 0; index < 10_001; index++) events.chunk(chunk(index % 2 ? '\ude00' : '\ud83d', {}, index));
    end(events);
    const material = read(events);
    expect(material.wireToolRole).toBe('ambiguous');
    expect(material.decoded.arguments?.utf8Precision).toBe('lower_bound');
    expect(material.decoded.arguments!.utf8Bytes).toBeLessThanOrEqual(30_003);
    expect(material.json.status).toBe('not_parsed');
  });

  it('holds independent request snapshots when an old response finishes after a newer request starts', () => {
    const collector = make(), old = collector.startRequest() as MaterialEvents;
    old.chunk(chunk(JSON.stringify({document: nativeObjectFixture()})));
    const newer = collector.startRequest() as MaterialEvents; newer.chunk(chunk('{}'));
    end(old, 'length'); end(newer);
    expect(old.dispatchOrdinal).toBe(1); expect(newer.dispatchOrdinal).toBe(2);
    expect(read(old)).toMatchObject({transport: {finishReason: 'length'}, representation: 'authored_claim_document@2'});
    expect(read(newer)).toMatchObject({transport: {finishReason: 'tool_calls'}, representation: 'unknown'});
  });

  it('preserves one call’s surrogate tail through empty chunks and freezes earlier snapshots', () => {
    const collector = make(), events = collector.startRequest() as MaterialEvents;
    events.chunk(chunk('\ud83d'));
    const prefix = read(events);
    for (const fragment of ['', '\ude00']) events.chunk({id: 'material-response', choices: [{index: 0,
      delta: {tool_calls: [{index: 0, function: {arguments: fragment}}]}, finish_reason: null}]});
    end(events);
    expect(prefix).toMatchObject({transport: {eofSeen: false, framing: 'unknown'}, decoded: {arguments: {utf8Bytes: 3, utf16Chars: 1}}, json: {status: 'not_parsed'}});
    expect(read(events)).toMatchObject({decoded: {arguments: {utf8Bytes: 4, utf16Chars: 2, utf8Precision: 'exact', utf16Precision: 'exact'}}});
  });

  it.each([true, false])('classifies an ordinary tool only from the captured installed list: %s', known => {
    const collector = createOpenAiTypedFinalWireCollector({finalToolName, ...(known ? {knownToolNames: ['actual_read_tool']} : {})});
    const events = collector.startRequest() as MaterialEvents;
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'call', type: 'function',
      function: {name: 'actual_read_tool', arguments: '{"document":{}}'}}]}, finish_reason: null}]}); end(events);
    expect(read(events)).toMatchObject({wireToolRole: known ? 'other_tool' : 'unknown', json: {status: 'not_parsed'},
      representation: known ? 'not_applicable' : 'unknown', structure: {status: known ? 'not_applicable' : 'not_observed'}});
  });

  it('measures native no-tool output without parsing it as a final document', () => {
    const events = make().startRequest() as MaterialEvents;
    events.chunk({id: 'material-response', choices: [{index: 0, delta: {content: 'ordinary progress', refusal: ''}, finish_reason: null}]}); end(events, 'stop');
    expect(read(events)).toMatchObject({wireToolRole: 'no_tool', representation: 'not_applicable', structure: {status: 'not_applicable'},
      retention: {arguments: {status: 'not_observed', retainedUtf8Bytes: 0}, refusal: {status: 'complete', retainedUtf8Bytes: 0}}});
  });

  it('does not call an interrupted prefix complete JSON before actual EOF', () => {
    const events = make().startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document: nativeObjectFixture()}))); events.done(); events.fail('transport_error');
    expect(read(events)).toMatchObject({transport: {doneSeen: true, eofSeen: false, framing: 'unknown'}, json: {status: 'not_parsed'}});
  });

  it('shares the UTF8 saturation domain while keeping the actual smaller UTF16 count exact', () => {
    const events = make().startRequest() as MaterialEvents;
    const text = '中'.repeat(Math.floor(OPENAI_TYPED_FINAL_RAW_BYTES / 3) + 1);
    events.chunk(chunk(text)); end(events);
    expect(read(events)).toMatchObject({decoded: {arguments: {utf8Bytes: OPENAI_TYPED_FINAL_RAW_BYTES + 1,
      utf8Precision: 'lower_bound', utf16Chars: text.length, utf16Precision: 'exact'}}, retention: {arguments: {status: 'over_limit'}}});
  });

  it('bounds cumulative identity names across calls without changing the old raw collector', () => {
    const events = make().startRequest() as MaterialEvents;
    for (const index of [0, 1]) events.chunk({id: 'material-response', choices: [{index: 0, delta: {tool_calls: [{index,
      id: `call-${index}`, type: 'function', function: {name: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES / 2), arguments: '{}'}}]}, finish_reason: null}]});
    end(events);
    expect(read(events)).toMatchObject({wireToolRole: 'ambiguous', json: {status: 'not_parsed'}});
  });

  it('reports original SQL NULL slots and measurement resource limits without a compiler verdict', () => {
    const document = nativeObjectFixture(), events = make().startRequest() as MaterialEvents;
    events.chunk(chunk(JSON.stringify({document}))); end(events);
    const countNull = (value: unknown): number => value === null ? 1 : value && typeof value === 'object'
      ? Object.values(value).reduce<number>((sum, item) => sum + countNull(item), 0) : 0;
    expect(read(events).structure).toMatchObject({status: 'measured', explicitNullCount: countNull(document)});
    const limited = make(true, () => 'nodes').startRequest() as MaterialEvents;
    limited.chunk(chunk(JSON.stringify({document}))); end(limited);
    expect(read(limited)).toMatchObject({json: {status: 'complete_json'}, representation: 'authored_claim_document@2', structure: {status: 'resource_limit'}});
  });

  it('drops a throwing structure observer without changing the original collector receipt or failure path', () => {
    const collector = make(true, () => {throw new Error('PRIVATE_OBSERVER_FAILURE');}), events = collector.startRequest() as MaterialEvents;
    const args = JSON.stringify({document: nativeObjectFixture()}); events.chunk(chunk(args)); end(events);
    expect(collector.current()).toMatchObject({rawArguments: args}); expect(collector.diagnostic().status).toBe('complete');
    expect(events.materialSnapshot?.()).toBeUndefined();
    expect(collector.current()).toMatchObject({rawArguments: args}); expect(collector.diagnostic().status).toBe('complete');
  });
});

/** Real installed converter/Runner plus the actual registry/adapter/issuer chain. */
describe('R11 Stage B mixed-content native final', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});
  const argumentsText = () => JSON.stringify({document: nativeObjectFixture()});
  const mixedResponse = (fragments: string[], extra: Record<string, unknown> = {}, finish = 'tool_calls', done = true) => {
    const deltas = fragments.map(content => ({content} as Record<string, unknown>));
    deltas.push({tool_calls: [{index: 0, id: 'final-call', type: 'function', function: {name: finalToolName, arguments: argumentsText()}}], ...extra});
    const chunks = deltas.map(delta => ({id: 'chat-final', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{index: 0, delta, finish_reason: null as string | null}]}));
    chunks.push({id: 'chat-final', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{index: 0, delta: {}, finish_reason: finish}]});
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
      {headers: {'content-type': 'text/event-stream'}});
  };
  const mixedProbe = (options: Parameters<typeof nativeObjectProbe>[0] = {}) => nativeObjectProbe({
    productionBridge: true, literalSubtree: true, contractVersion: 'openai_typed_final_admission@3', ...options});

  it('observes the installed converter preserving same-response message/raw-item identity alongside a function call', async () => {
    const companion = '中文 progress 😀';
    const h = probe({response: () => chatResponse(rawArguments, {content: companion}), onCallback: (stream, context) => {
      const state = stream.state;
      const output = state._lastTurnResponse!.output;
      const message = output.find(item => item.type === 'message');
      expect(message).toMatchObject({id: 'chat-final', type: 'message', role: 'assistant', status: 'completed',
        content: [{type: 'output_text', text: companion}]});
      const processed = state._lastProcessedResponse!.newItems.find(item => item.type === 'message_output_item');
      expect(processed?.rawItem).toBe(message);
      expect(processed?.agent).toBe(state._currentAgent);
      expect(context).toBe(state._context);
      expect(output.filter(item => item.type === 'function_call')).toHaveLength(1);
      return body;
    }});
    try {const stream = await h.settle(); expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(body);}
    finally {await h.cleanup();}
  });

  it.each(['same_chunk', 'split_chunks', 'whitespace', 'literal_sidecar'] as const)
    ('selects only the compiled document after a real mixed %s response and drain', async variant => {
      const fragments = variant === 'split_chunks' ? ['中文 ', '\ud83d', '', '\ude00'] :
        variant === 'whitespace' ? [' \n\t'] : variant === 'literal_sidecar' ? ['<!-- perfetto-conclusion-contract\n{"claims":[]}\n-->'] : ['same chunk progress'];
      const companion = fragments.join('');
      const h = mixedProbe({response: () => variant === 'same_chunk' ? chatResponse(argumentsText(), {content: companion}) : mixedResponse(fragments)});
      try {
        const stream = await h.settle();
        expect(stream.error).toBeNull(); expect(h.observations.admissionFailure).toBeUndefined();
        expect(h.submission()).toBeDefined();
        const issued = h.readSubmission();
        expect(stream.finalOutput).toBe(issued.compiled.body);
        expect(stream.finalOutput).not.toBe(companion);
        expect(issued).toMatchObject({rawArguments: argumentsText()});
        expect(h.observations.sdkRawArguments).toBe(argumentsText());
        expect(h.observations.sdkArgs).toEqual(JSON.parse(argumentsText()));
        expect(h.observations.handlerArgs).toEqual(h.observations.sdkArgs);
        expect(h.admission()).toHaveProperty('contractIdentity', {representationVersion: 'authored_claim_document@2',
          compilerVersion: 'authored_claim_document_compiler@2', admissionVersion: 'openai_typed_final_admission@3', wireVersion: 'openai_chat_final_wire@2'});
        expect(stream.state._lastTurnResponse!.output.find(item => item.type === 'message')).toMatchObject({content: [{text: companion}]});
        expect(h.observations.drained).toBe(true); expect(h.observations.consumerDrained).toBe(true);
        expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.observations.handlerCalls).toBe(1);
      } finally {await h.cleanup();}
    });

  it('keeps omitted v2 contract selection on the old strict wire and keeps v1 strict', async () => {
    const v2 = nativeObjectProbe({productionBridge: true, literalSubtree: true, response: () => chatResponse(argumentsText(), {content: 'progress'})});
    try {await v2.settle(); expect(v2.submission()).toBeUndefined(); expect(v2.admission()!.diagnostic()).toMatchObject({reason: 'assistant_content'});
      expect(v2.admission()).toHaveProperty('contractIdentity.admissionVersion', 'openai_typed_final_admission@2');}
    finally {await v2.cleanup();}
    const v1 = probe({useAdmission: true, response: () => chatResponse(rawArguments, {content: 'progress'})});
    try {await v1.settle(); expect(v1.submission()).toBeUndefined(); expect(v1.admission()!.diagnostic()).toMatchObject({reason: 'assistant_content'});
      expect(v1.admission()).toHaveProperty('contractIdentity.admissionVersion', 'openai_typed_final_admission@1');}
    finally {await v1.cleanup();}
  });

  it.each(['text', 'role', 'status', 'id', 'copied_raw_item', 'agent', 'missing_item', 'duplicate_message'] as const)
    ('refuses changed actual SDK companion correspondence: %s', async mutation => {
      let mutated = false;
      const h = mixedProbe({response: () => mixedResponse(['unchanged wire text']), beforeCallback: stream => {
        mutated = true;
        const state = stream.state as unknown as {_lastTurnResponse: {output: Record<string, unknown>[]};
          _lastProcessedResponse: {newItems: {type: string; rawItem: Record<string, unknown>; agent: unknown}[]}};
        const message = state._lastTurnResponse.output.find(item => item.type === 'message')!;
        const items = state._lastProcessedResponse.newItems, item = items.find(item => item.type === 'message_output_item')!;
        if (mutation === 'text') (message.content as {text: string}[])[0].text = 'changed';
        if (mutation === 'role') message.role = 'user';
        if (mutation === 'status') message.status = 'in_progress';
        if (mutation === 'id') message.id = 'other-response';
        if (mutation === 'copied_raw_item') item.rawItem = {...message};
        if (mutation === 'agent') item.agent = {};
        if (mutation === 'missing_item') items.splice(items.indexOf(item), 1);
        if (mutation === 'duplicate_message') state._lastTurnResponse.output.push({...message});
      }});
      try {await h.settle(); expect(mutated).toBe(true); expect(h.observations.handlerCalls).toBe(1);
        expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(true); expect(h.fetcher).toHaveBeenCalledTimes(1);}
      finally {await h.cleanup();}
    });

  it.each(['refusal', 'bad_content', 'bad_refusal', 'legacy_action', 'custom_action', 'length', 'missing_done'] as const)
    ('does not widen raw final eligibility for mixed %s', async failure => {
      const extra: Record<string, unknown> = failure === 'refusal' ? {refusal: 'cannot comply'} :
        failure === 'bad_content' ? {content: {text: 'not a string'}} : failure === 'bad_refusal' ? {refusal: 7} :
        failure === 'legacy_action' ? {function_call: {name: 'hidden_action', arguments: '{}'}} :
        failure === 'custom_action' ? {tool_calls: [{index: 1, id: 'custom-call', type: 'custom', custom: {name: 'hidden', input: 'x'}}]} : {};
      const h = mixedProbe({response: () => mixedResponse(['visible progress'], extra, failure === 'length' ? 'length' : 'tool_calls', failure !== 'missing_done')});
      try {await h.settle(); expect(h.submission()).toBeUndefined(); expect(h.fetcher).toHaveBeenCalledTimes(1);}
      finally {await h.cleanup();}
    });

  it.each([null, ''])('preserves absent refusal semantics for %s', async refusal => {
    const h = mixedProbe({response: () => mixedResponse(['progress'], {refusal})});
    try {const stream = await h.settle(); expect(stream.error).toBeNull(); expect(h.submission()).toBeDefined();}
    finally {await h.cleanup();}
  });

  it('waits for the real consumer drain before issuing mixed output', async () => {
    const gate = deferred<void>(), h = mixedProbe({response: () => mixedResponse(['progress']), consumerGate: gate.promise});
    try {
      const state = await h.tracked; await state.stream.completed.catch(() => undefined); await state.drain.catch(() => undefined);
      expect(h.submission()).toBeUndefined(); expect(h.observations.consumerDrained).toBe(false);
      gate.resolve(); const stream = await h.settle(); expect(stream.error).toBeNull(); expect(h.submission()).toBeDefined();
    } finally {gate.resolve(); await h.cleanup();}
  });

  it.each(['cancel', 'supersede'] as const)('does not issue mixed output after %s during the held consumer', async action => {
    const gate = deferred<void>(), h = mixedProbe({response: () => mixedResponse(['progress']), consumerGate: gate.promise});
    try {
      const state = await h.tracked; await state.stream.completed; await state.drain;
      expect(h.observations.handlerCalls).toBe(1); expect(h.submission()).toBeUndefined();
      if (action === 'cancel') h.cancel(); else h.revokeOwner();
      gate.resolve(); await h.settle(); expect(h.submission()).toBeUndefined();
      expect(h.observations.admissionFailure).toMatchObject({code: action === 'cancel' ? 'cancelled' : 'stale_invocation'});
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('does not finalize mixed output while another actual function handler is pending', async () => {
    const gate = deferred<void>(), h = mixedProbe({otherGate: gate.promise,
      response: () => chatResponse(argumentsText(), {content: 'progress'}, true)});
    try {
      await h.otherEntered.promise; expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(false);
      gate.resolve(); await h.settle(); expect(h.submission()).toBeUndefined(); expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('rejects arguments rewritten by the SDK despite a matching companion message', async () => {
    const args = '{}' + argumentsText(), h = mixedProbe({argumentsText: args, response: () => chatResponse(args, {content: 'progress'})});
    try {await h.settle(); expect(h.observations.sdkRawArguments).toBe(argumentsText());
      expect(h.observations.handlerCalls).toBe(0); expect(h.submission()).toBeUndefined();}
    finally {await h.cleanup();}
  });

  it('rejects duplicate reasoning identity hiding an unmatched SDK item at equal lengths', async () => {
    let mutated = false;
    const h = mixedProbe({response: () => mixedResponse(['progress'], {reasoning: 'local fixture reasoning'}), beforeCallback: stream => {
      const state = stream.state as unknown as {_lastTurnResponse: {output: Record<string, unknown>[]};
        _lastProcessedResponse: {newItems: {type: string; rawItem: Record<string, unknown>; agent: unknown}[]}; _currentAgent: unknown};
      const output = state._lastTurnResponse.output, items = state._lastProcessedResponse.newItems;
      const reasoning = output.find(item => item.type === 'reasoning');
      expect(reasoning).toBeDefined();
      expect(items.find(item => item.type === 'reasoning_item')?.rawItem).toBe(reasoning);
      output.push(reasoning!); // Reuse the actual converter object, not a fabricated parsed result.
      items.push({type: 'unknown_item', rawItem: {type: 'unknown_action'}, agent: state._currentAgent});
      expect(output.length).toBe(items.length); mutated = true;
    }});
    try {
      await h.settle(); expect(mutated).toBe(true); expect(h.observations.handlerCalls).toBe(1);
      expect(h.submission()).toBeUndefined(); expect(h.observations.admissionFailure).toMatchObject({code: 'pending_work'});
      expect(h.observations.drained).toBe(true); expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('requires the original handler and output-guardrail ACK after mixed content', async () => {
    const h = mixedProbe({response: () => mixedResponse(['progress']), guardrail: 'output_rewrite'});
    try {await h.settle(); expect(h.observations.handlerCalls).toBe(1); expect(h.submission()).toBeUndefined();
      expect(h.observations.admissionFailure).toMatchObject({code: 'handler_failed'});}
    finally {await h.cleanup();}
  });
});


describe('R11 Stage B bounded mixed retention', () => {
  const chunk = (delta: Record<string, unknown>) => ({id: 'bounded-response', choices: [{index: 0, delta, finish_reason: null}]});
  const call = (args: string) => ({tool_calls: [{index: 0, id: 'bounded-call', type: 'function', function: {name: finalToolName, arguments: args}}]});
  const finish = (events: ReturnType<ReturnType<typeof createOpenAiTypedFinalWireCollector>['startRequest']>) => {
    events.chunk({id: 'bounded-response', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]}); events.done(); events.end(true);
  };
  const make = (wireVersion: 'openai_chat_final_wire@1' | 'openai_chat_final_wire@2' = 'openai_chat_final_wire@2') =>
    createOpenAiTypedFinalWireCollector({wireVersion, finalToolName, materialProvider: {representationVersion: 'authored_claim_document@2',
      rootKeys: Object.keys(authoredClaimObjectSchema.shape), contractKeys: Object.keys(authoredClaimObjectSchema.shape.contract.shape), measure: measureAuthoredJson}});

  it('does not parse a valid argument prefix lost only because companion consumed the combined limit', () => {
    const collector = make(), events = collector.startRequest();
    events.chunk(chunk({content: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES - 2)})); events.chunk(chunk(call('{}')));
    events.chunk(chunk({tool_calls: [{index: 0, function: {arguments: ' '}}]})); finish(events);
    expect(collector.current()).toBeUndefined(); expect(collector.diagnostic()).toMatchObject({reason: 'raw_limit'});
    expect(events.materialSnapshot!()).toMatchObject({decoded: {arguments: {utf8Bytes: 3, utf8Precision: 'exact'}},
      retention: {arguments: {status: 'over_limit', retainedUtf8Bytes: 2}, companion: {status: 'complete', retainedUtf8Bytes: OPENAI_TYPED_FINAL_RAW_BYTES - 2},
        combinedRetainedUtf8Bytes: OPENAI_TYPED_FINAL_RAW_BYTES}, json: {status: 'not_parsed'}});
  });

  it('still measures complete arguments when later companion retention exceeds only the combined limit', () => {
    const collector = make(), events = collector.startRequest(), args = JSON.stringify({document: nativeObjectFixture()});
    events.chunk(chunk(call(args))); events.chunk(chunk({content: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES - Buffer.byteLength(args) + 1)})); finish(events);
    expect(collector.current()).toBeUndefined();
    expect(events.materialSnapshot!()).toMatchObject({retention: {arguments: {status: 'complete', retainedUtf8Bytes: Buffer.byteLength(args)},
      companion: {status: 'over_limit', retainedUtf8Bytes: 0}, combinedRetainedUtf8Bytes: Buffer.byteLength(args)},
      json: {status: 'complete_json'}, structure: {status: 'measured'}});
  });

  it.each(['arguments', 'companion'] as const)('retains no oversized %s component and refuses the wire', component => {
    const collector = make(), events = collector.startRequest(), huge = 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES + 1);
    events.chunk(chunk(component === 'arguments' ? call(huge) : {...call('{}'), content: huge})); finish(events);
    expect(collector.current()).toBeUndefined();
    expect(events.materialSnapshot!()!.retention[component]).toEqual({status: 'over_limit', retainedUtf8Bytes: 0});
  });

  it('counts split companion Unicode bytes from the actual retained string and leaves old no-callback observations unchanged', () => {
    const snapshots: RuntimeTypedOutputMaterial[] = [];
    for (const wire of ['openai_chat_final_wire@1', 'openai_chat_final_wire@2'] as const) {
      const collector = make(wire), events = collector.startRequest();
      for (const content of ['中', '\ud83d', '', '\ude00']) events.chunk(chunk({content}));
      events.chunk(chunk(call('{}'))); finish(events); snapshots.push(events.materialSnapshot!()!);
      if (wire === 'openai_chat_final_wire@2') expect(collector.current()).toMatchObject({wireVersion: wire, companion: '中😀'});
      else expect(collector.current()).toBeUndefined();
    }
    expect(snapshots[0].decoded).toEqual(snapshots[1].decoded);
    expect(snapshots[0].retention.companion).toEqual({status: 'not_retained', retainedUtf8Bytes: 0});
    expect(snapshots[1].retention).toMatchObject({companion: {status: 'complete', retainedUtf8Bytes: 7}, combinedRetainedUtf8Bytes: 9});
  });

  it('drops a failing private retention observer without changing actual wire completion', () => {
    const original = outputMaterial.createOpenAiTypedFinalOutputMaterial;
    const spy = jest.spyOn(outputMaterial, 'createOpenAiTypedFinalOutputMaterial').mockImplementation((options, readArgs) =>
      original(options, readArgs, () => {throw new Error('PRIVATE_RETENTION_FAILURE');}));
    try {
      const collector = make(), events = collector.startRequest(); events.chunk(chunk({...call('{}'), content: 'retained'})); finish(events);
      expect(events.materialSnapshot!()).toBeUndefined(); expect(collector.current()).toMatchObject({rawArguments: '{}', companion: 'retained'});
      expect(collector.diagnostic().status).toBe('complete');
    } finally {spy.mockRestore();}
  });

  it.each(['length', 'missing_done', 'trailing', 'second_tool', 'unknown_delta', 'refusal'] as const)
    ('does not weaken terminal or action boundaries for %s', failure => {
      const collector = make(), events = collector.startRequest();
      events.chunk(chunk({...call('{}'), content: 'progress', ...(failure === 'refusal' ? {refusal: 'no'} : {})}));
      if (failure === 'second_tool') events.chunk(chunk({tool_calls: [{index: 1, id: 'other', type: 'function', function: {name: 'other', arguments: '{}'}}]}));
      if (failure === 'unknown_delta') events.chunk(chunk({audio: {data: 'hidden'}}));
      events.chunk({id: 'bounded-response', choices: [{index: 0, delta: {}, finish_reason: failure === 'length' ? 'length' : 'tool_calls'}]});
      if (failure !== 'missing_done') events.done();
      if (failure === 'trailing') events.chunk(chunk({content: 'late'}));
      events.end(true); expect(collector.current()).toBeUndefined();
      if (failure === 'refusal') expect(collector.diagnostic()).toMatchObject({reason: 'assistant_refusal'});
    });
});

/** Characterization only: no assistant-JSON acceptor, new carrier or issuer is added. */
describe('R12 whole-assistant-JSON installed-SDK characterization', () => {
  let restoreClone: (() => void) | undefined;
  let issue: jest.SpiedFunction<typeof submissionAuthority.issueAuthoredFinalSubmission>;
  beforeEach(() => {
    restoreClone = installCurrentRealmStructuredCloneForTest();
    issue = jest.spyOn(submissionAuthority, 'issueAuthoredFinalSubmission');
  });
  afterEach(() => {issue.mockRestore(); restoreClone?.(); restoreClone = undefined;});

  const wholeJson = JSON.stringify({document: nativeObjectFixture()}, null, 2);
  const sdkTextProbe = (options: Parameters<typeof nativeObjectProbe>[0]) => nativeObjectProbe({
    productionBridge: true, literalSubtree: true, contractVersion: 'openai_typed_final_admission@3', ...options});
  function assistantWire(parts: string[], options: {
    finish?: 'stop' | 'length' | 'tool_calls' | null; done?: boolean; ids?: Array<string | undefined>; extra?: Record<string, unknown>;
  } = {}): string {
    const chunks = [...parts.map((content, index) => ({delta: {role: 'assistant', content,
      ...(index === 0 ? options.extra : {})}, finish_reason: null})),
      {delta: {}, finish_reason: options.finish === undefined ? 'stop' : options.finish}];
    return chunks.map((choice, index) => `data: ${JSON.stringify({
      ...(options.ids ? options.ids[index] === undefined ? {} : {id: options.ids[index]} : {id: 'provider-assistant-id'}),
      object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, ...choice}],
    })}\n\n`).join('') + (options.done === false ? '' : 'data: [DONE]\n\n');
  }
  const response = (wire: string) => new Response(wire, {headers: {'content-type': 'text/event-stream'}});
  function rawChunks(h: ReturnType<typeof nativeObjectProbe>): Array<Record<string, unknown>> {
    return h.observations.rawEvents.flatMap(value => {
      const event = value as {type?: unknown; event?: unknown};
      return event?.type === 'model' && event.event && typeof event.event === 'object' && !Array.isArray(event.event)
        ? [event.event as Record<string, unknown>] : [];
    });
  }
  function rawText(h: ReturnType<typeof nativeObjectProbe>): string {
    return rawChunks(h).flatMap(chunk => Array.isArray(chunk.choices) ? chunk.choices.flatMap(choice =>
      typeof choice?.delta?.content === 'string' ? [choice.delta.content] : []) : []).join('');
  }
  function actualMessage(stream: NativeStream) {
    const messages = stream.state._lastTurnResponse?.output.filter(item => item.type === 'message') ?? [];
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message?.type !== 'message') throw new Error('Expected one actual SDK message');
    return message;
  }
  function exactTextViews(h: ReturnType<typeof nativeObjectProbe>, stream: NativeStream, text: string): void {
    expect(stream.error).toBeNull(); expect(rawText(h)).toBe(text); expect(stream.finalOutput).toBe(text);
    const message = actualMessage(stream);
    expect(message).toMatchObject({role: 'assistant', status: 'completed'});
    const content = message.content;
    if (!Array.isArray(content)) throw new Error('Expected an actual SDK output content array');
    expect(content.flatMap(part => part.type === 'output_text' ? [part.text] : []).join('')).toBe(text);
    const counterparts = stream.state._lastProcessedResponse?.newItems.filter(item => item.type === 'message_output_item') ?? [];
    expect(counterparts).toHaveLength(1); expect(counterparts[0].rawItem).toBe(message);
    // Message id is the converter's response id projection, not another provider witness.
    expect(message.id).toBe(stream.state._lastTurnResponse?.responseId);
  }
  function noSubmission(h: ReturnType<typeof nativeObjectProbe>): void {
    expect(h.submission()).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
    expect(h.observations.handlerCalls).toBe(0); expect(h.observations.compiled).toBeUndefined();
  }

  it.each([
    {name: 'complete JSON with Unicode and escapes', text: wholeJson},
    {name: 'ordinary prose', text: 'This is ordinary assistant prose, not JSON.'},
    {name: 'fenced JSON', text: `\`\`\`json\n${wholeJson}\n\`\`\``},
    {name: 'whitespace-only text', text: ' \n\t '},
    {name: 'JSON retaining outer whitespace', text: ` \n${wholeJson}\t `},
  ])('preserves $name in SDK text mode while current typed admission refuses it', async ({text}) => {
    // Split an actual surrogate pair when present; JSON escapes and literal whitespace remain verbatim.
    const emoji = text.indexOf('😀'), split = emoji >= 0 ? emoji + 1 : Math.floor(text.length / 2);
    const parts = [text.slice(0, split), text.slice(split)];
    const h = sdkTextProbe({response: () => response(assistantWire(parts))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, text); noSubmission(h);
      expect(h.observations.drained).toBe(true); expect(h.observations.consumerDrained).toBe(true);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.observations.requestSchema).toEqual(createJsonSchemaFromZodRawShape({document: authoredClaimObjectSchema.describe('Native object fixture')}));
      expect(h.admission()?.diagnostic()).toMatchObject({status: 'rejected', reason: 'non_tool_terminal', wireFinishReason: 'stop'});
    } finally {await h.cleanup();}
  });

  it.each(['v1', 'historical_v2'] as const)('does not promote assistant JSON through the existing %s function contract', async version => {
    const assistantText = version === 'v1' ? documentJson : wholeJson;
    const wire = assistantWire([assistantText]);
    const h = version === 'v1' ? probe({useAdmission: true, response: () => response(wire)})
      : nativeObjectProbe({productionBridge: true, literalSubtree: true, response: () => response(wire)});
    try {
      const stream = await h.settle();
      expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(assistantText);
      expect(h.submission()).toBeUndefined(); expect(issue).not.toHaveBeenCalled(); expect(h.observations.handlerCalls).toBe(0);
      expect(h.admission()?.diagnostic()).toMatchObject({status: 'rejected', reason: 'assistant_content'});
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it.each(['length', 'missing_done', 'missing_finish'] as const)('exposes text despite %s without treating SDK completion as a wire proof', async ending => {
    const h = sdkTextProbe({response: () => response(assistantWire([wholeJson], {
      finish: ending === 'length' ? 'length' : ending === 'missing_finish' ? null : 'stop', done: ending !== 'missing_done'}))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
      expect(h.admission()?.diagnostic()).toMatchObject({status: 'rejected',
        reason: ending === 'missing_done' ? 'missing_done' : 'non_tool_terminal'});
      expect(h.observations.drained).toBe(true); expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it.each([
    {name: 'missing provider IDs', ids: [undefined, undefined, undefined], projected: 'FAKE_ID', reason: 'invalid_chunk'},
    {name: 'first ID arriving later', ids: [undefined, 'late-provider-id', 'late-provider-id'], projected: 'late-provider-id', reason: 'invalid_chunk'},
    {name: 'later ID drift', ids: ['first-provider-id', 'different-provider-id', 'different-provider-id'], projected: 'first-provider-id', reason: 'conflicting_identity'},
  ])('distinguishes $name from the SDK response/message identity', async ({ids, projected, reason}) => {
    const split = Math.floor(wholeJson.length / 2), h = sdkTextProbe({response: () => response(assistantWire(
      [wholeJson.slice(0, split), wholeJson.slice(split)], {ids}))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
      expect(rawChunks(h).map(chunk => chunk.id)).toEqual(ids);
      expect(stream.state._lastTurnResponse?.responseId).toBe(projected);
      expect(actualMessage(stream).id).toBe(projected);
      expect(h.admission()?.diagnostic()).toMatchObject({status: 'rejected', reason});
      // FAKE_ID is the installed converter's synthetic initializer, never provider data.
      if (projected === 'FAKE_ID') expect(rawChunks(h).every(chunk => !Object.prototype.hasOwnProperty.call(chunk, 'id'))).toBe(true);
    } finally {await h.cleanup();}
  });

  it('coalesces repeated content frames into one message without deduplicating text or providing independent message IDs', async () => {
    const h = sdkTextProbe({response: () => response(assistantWire([wholeJson, wholeJson]))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, wholeJson + wholeJson); noSubmission(h);
      expect(() => JSON.parse(String(stream.finalOutput))).toThrow();
      const message = actualMessage(stream), copiedMessage = {...message};
      expect(copiedMessage.id).toBe(message.id); expect(copiedMessage).toEqual(message); expect(copiedMessage).not.toBe(message);
      // Current-response counterpart identity is exposed; equality of IDs/content alone does not prove it.
      expect(stream.state._lastProcessedResponse?.newItems.filter(item => item.type === 'message_output_item')[0].rawItem).toBe(message);
    } finally {await h.cleanup();}
  });

  it.each(['refusal', 'legacy_action', 'custom_action'] as const)('records raw %s that SDK text output alone cannot exclude', async action => {
    const extra = action === 'refusal' ? {refusal: 'fixture refusal'} : action === 'legacy_action'
      ? {function_call: {name: 'legacy_fixture', arguments: '{}'}}
      : {tool_calls: [{index: 0, id: 'custom-id', type: 'custom', custom: {name: 'custom_fixture', input: 'fixture'}}]};
    const h = sdkTextProbe({response: () => response(assistantWire([wholeJson], {extra}))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
      expect(rawChunks(h)[0]).toMatchObject({choices: [{delta: extra}]});
      expect(stream.state._lastTurnResponse?.output.filter(item => item.type === 'function_call')).toHaveLength(0);
      if (action === 'refusal') expect(actualMessage(stream).content).toEqual(expect.arrayContaining([{type: 'refusal', refusal: 'fixture refusal'}]));
      expect(h.admission()?.diagnostic().status).toBe('rejected'); expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });

  it('does not equate DONE with EOF or native drain while the real response remains open', async () => {
    const release = deferred<void>(); let pulled = false;
    const h = sdkTextProbe({response: () => new Response(new ReadableStream<Uint8Array>({async pull(controller) {
      if (!pulled) {pulled = true; controller.enqueue(new TextEncoder().encode(assistantWire([wholeJson]))); return;}
      await release.promise; controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}})});
    try {
      const state = await h.tracked; await h.assistantTextEntered.promise; await boundary();
      expect(h.observations.drained).toBe(false); expect(h.observations.consumerDrained).toBe(false);
      expect(state.stream.finalOutput).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
      release.resolve(); const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
    } finally {release.resolve(); await h.cleanup();}
  });

  it('exposes SDK finalOutput before a delayed real consumer finishes, with current issuance still absent', async () => {
    const release = deferred<void>(), h = sdkTextProbe({consumerGate: release.promise, response: () => response(assistantWire([wholeJson]))});
    try {
      const state = await h.tracked; await state.stream.completed; await state.drain;
      expect(state.stream.finalOutput).toBe(wholeJson); expect(h.observations.consumerDrained).toBe(false);
      expect(h.submission()).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
      release.resolve(); const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
    } finally {release.resolve(); await h.cleanup();}
  });

  it('serializes an unresolved prior function call without making its absence from the current response a completion proof', async () => {
    const pending: AgentInputItem = {type: 'function_call', callId: 'prior-unresolved', name: 'other_fixture', arguments: '{}'};
    const h = sdkTextProbe({otherGate: Promise.resolve(), input: [{role: 'user', content: 'fixture'}, pending], response: () => response(assistantWire([wholeJson]))});
    try {
      const stream = await h.settle(); exactTextViews(h, stream, wholeJson); noSubmission(h);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(h.fetcher.mock.calls[0][1]?.body));
      expect(request.messages).toEqual(expect.arrayContaining([expect.objectContaining({role: 'assistant', tool_calls: [
        {id: 'prior-unresolved', type: 'function', function: {name: 'other_fixture', arguments: '{}'}}]})]));
      expect(request.messages.some((item: {role?: string}) => item.role === 'tool')).toBe(false);
      expect(stream.state._lastTurnResponse?.output.every(item => item.type === 'message')).toBe(true);
      // The fake HTTP peer accepts this request; this says nothing about a real provider's history validation.
    } finally {await h.cleanup();}
  });

  it('waits for actual prior tool work before requesting the no-tool JSON turn', async () => {
    const release = deferred<void>(); let requests = 0;
    const h = sdkTextProbe({maxTurns: 2, otherGate: release.promise, response: () => ++requests === 1
      ? response(assistantWire([wholeJson], {finish: 'tool_calls', ids: ['prior-provider-id', 'prior-provider-id'],
        extra: {tool_calls: [{index: 0, id: 'prior-active', type: 'function', function: {name: 'other_fixture', arguments: '{}'}}]}}))
      : response(assistantWire([wholeJson]))});
    try {
      const state = await h.tracked; await h.otherEntered.promise; await boundary();
      expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.observations.drained).toBe(false);
      expect(state.stream.finalOutput).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
      release.resolve(); const stream = await h.settle();
      expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(wholeJson);
      expect(actualMessage(stream).content).toEqual(expect.arrayContaining([expect.objectContaining({type: 'output_text', text: wholeJson})]));
      expect(rawText(h)).toBe(wholeJson + wholeJson); // One text per response; never concatenate them into a new final document.
      expect(h.fetcher).toHaveBeenCalledTimes(2); noSubmission(h);
      const second = JSON.parse(String(h.fetcher.mock.calls[1][1]?.body));
      expect(second.messages).toEqual(expect.arrayContaining([expect.objectContaining({role: 'tool', tool_call_id: 'prior-active'})]));
    } finally {release.resolve(); await h.cleanup();}
  });
});

describe('R13 explicit dual carrier through the actual installed SDK', () => {
  let restoreClone: (() => void) | undefined;
  let issue: jest.SpiedFunction<typeof submissionAuthority.issueAuthoredFinalSubmission>;
  beforeEach(() => {
    restoreClone = installCurrentRealmStructuredCloneForTest();
    issue = jest.spyOn(submissionAuthority, 'issueAuthoredFinalSubmission');
  });
  afterEach(() => {issue.mockRestore(); restoreClone?.();});
  const document = nativeObjectFixture();
  const whole = JSON.stringify({document});
  const compiled = compileAuthoredClaimObject(document);
  if (compiled.status !== 'compiled') throw new Error('Invalid independent native fixture');
  const dual = (options: Parameters<typeof nativeObjectProbe>[0] = {}) => nativeObjectProbe({
    productionBridge: true, literalSubtree: true, contractVersion: 'openai_typed_final_admission@4', ...options});
  function wire(parts: string[], options: {finish?: string | null; done?: boolean;
    ids?: Array<string | undefined>; extra?: Record<string, unknown>} = {}) {
    const choices = [...parts.map((content, index) => ({delta: {role: 'assistant', content,
      ...(index === 0 ? options.extra : {})}, finish_reason: null})),
      {delta: {}, finish_reason: options.finish === undefined ? 'stop' : options.finish}];
    return choices.map((choice, index) => `data: ${JSON.stringify({
      ...(options.ids ? options.ids[index] === undefined ? {} : {id: options.ids[index]} : {id: 'dual-response'}),
      model: 'fixture-model', choices: [{index: 0, ...choice}],
    })}\n\n`).join('') + (options.done === false ? '' : 'data: [DONE]\n\n');
  }
  const response = (text: string) => new Response(text, {headers: {'content-type': 'text/event-stream'}});
  function expectNoIssue(h: ReturnType<typeof nativeObjectProbe>) {
    expect(h.submission()).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
  }

  it.each(['whole', 'split_unicode', 'outer_whitespace', 'literal_fake_id', 'empty_actions'] as const)
    ('issues exact assistant source after all original drains for %s', async variation => {
      const text = variation === 'outer_whitespace' ? ` \n${whole}\t ` : whole;
      const split = text.indexOf('😀') + 1;
      const parts = variation === 'split_unicode' ? [text.slice(0, split), text.slice(split)] : [text];
      const h = dual({response: () => response(wire(parts, {
        ...(variation === 'literal_fake_id' ? {ids: ['FAKE_ID', 'FAKE_ID']} : {}),
        ...(variation === 'empty_actions' ? {extra: {tool_calls: []}} : {}),
      }))});
      try {
        const stream = await h.settle();
        expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(text);
        expect(h.fetcher).toHaveBeenCalledTimes(1); expect(issue).toHaveBeenCalledTimes(1);
        expect(h.observations.handlerCalls).toBe(0); expect(h.observations.drained).toBe(true);
        expect(h.observations.consumerDrained).toBe(true);
        const snapshot = h.readSubmission();
        expect(snapshot).toMatchObject({sourceKind: 'assistant_json', rawAssistantText: text,
          nativeDocument: document, compiled: {body: compiled.body, rawCanonicalPayload: compiled.rawCanonicalPayload},
          binding: {dispatchOrdinal: 1, responseId: variation === 'literal_fake_id' ? 'FAKE_ID' : 'dual-response',
            messageId: variation === 'literal_fake_id' ? 'FAKE_ID' : 'dual-response'}});
        for (const forbidden of ['rawArguments', 'documentJson', 'callId']) expect(snapshot).not.toHaveProperty(forbidden);
        expect(snapshot.binding).not.toHaveProperty('callId'); expect(snapshot.hashes).not.toHaveProperty('rawArgumentsHash');
        h.clearAttempt(); h.controller.abort(); expect(h.readSubmission()).toBe(snapshot);
      } finally {await h.cleanup();}
    });

  it.each(['prose', 'fence', 'two_objects', 'extra_key', 'missing_document', 'invalid_document', 'whitespace'] as const)
    ('rejects whole-source %s without extracting or repairing JSON', async invalid => {
      const text = invalid === 'prose' ? `Answer ${whole}` : invalid === 'fence' ? `\`\`\`json\n${whole}\n\`\`\``
        : invalid === 'two_objects' ? whole + whole : invalid === 'extra_key' ? JSON.stringify({document, extra: true})
        : invalid === 'missing_document' ? '{}' : invalid === 'invalid_document' ? '{"document":{}}' : ' \n ';
      const h = dual({response: () => response(wire([text]))});
      try {const stream = await h.settle(); expect(stream.finalOutput).toBe(text); expectNoIssue(h);
        expect(h.observations.admissionFailure).toMatchObject({code: 'invalid_submission'});}
      finally {await h.cleanup();}
    });

  it.each(['length', 'missing_finish', 'missing_done', 'missing_id', 'id_drift', 'fake_id_drift',
    'refusal', 'legacy_action', 'custom_action', 'malformed_actions', 'unknown_field'] as const)
    ('refuses %s even when the SDK exposes a whole terminal text', async invalid => {
      const extra = invalid === 'refusal' ? {refusal: 'fixture refusal'} : invalid === 'legacy_action'
        ? {function_call: {name: 'hidden', arguments: '{}'}} : invalid === 'custom_action'
        ? {tool_calls: [{index: 0, id: 'custom', type: 'custom', custom: {name: 'hidden', input: '{}'}}]}
        : invalid === 'malformed_actions' ? {tool_calls: null} : invalid === 'unknown_field' ? {audio: {data: 'hidden'}} : {};
      const h = dual({response: () => response(wire([whole], {extra,
        finish: invalid === 'length' ? 'length' : invalid === 'missing_finish' ? null : 'stop', done: invalid !== 'missing_done',
        ...(invalid === 'missing_id' ? {ids: [undefined, undefined]} : invalid === 'id_drift' ? {ids: ['first', 'second']}
          : invalid === 'fake_id_drift' ? {ids: ['FAKE_ID', 'second']} : {}),
      }))});
      try {await h.settle(); expectNoIssue(h); expect(h.fetcher).toHaveBeenCalledTimes(1);
        expect(h.admission()?.diagnostic().status).toBe('rejected');}
      finally {await h.cleanup();}
    });

  it('retains the function lane and its actual ACK in dual mode', async () => {
    const h = dual({response: () => chatResponse(JSON.stringify({document}), {content: whole})});
    try {const stream = await h.settle(); expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(compiled.body);
      expect(h.observations.handlerCalls).toBe(1); expect(issue).toHaveBeenCalledTimes(1);
      expect(h.readSubmission()).toMatchObject({rawArguments: whole, compiled: {body: compiled.body}});
      expect(h.readSubmission()).not.toHaveProperty('sourceKind');}
    finally {await h.cleanup();}
  });

  it.each(['handler_rewrite', 'function_stop'] as const)('does not fall back to valid assistant JSON after %s', async invalid => {
    const h = dual({...(invalid === 'handler_rewrite' ? {guardrail: 'output_rewrite' as const} : {}),
      response: () => invalid === 'function_stop' ? response(wire([whole], {extra: {tool_calls: [{index: 0,
        id: 'failed-final', type: 'function', function: {name: finalToolName, arguments: whole}}]}}))
        : chatResponse(whole, {content: whole})});
    try {await h.settle(); expectNoIssue(h); expect(h.fetcher).toHaveBeenCalledTimes(1);}
    finally {await h.cleanup();}
  });

  it.each(['unresolved', 'duplicate', 'orphan', 'resolved'] as const)('checks actual original input work: %s', async kind => {
    const call: AgentInputItem = {type: 'function_call', callId: 'input-call', name: 'other_fixture', arguments: '{}'};
    const result: AgentInputItem = {type: 'function_call_result', name: 'other_fixture', callId: 'input-call',
      status: 'completed', output: 'complete'};
    const input: AgentInputItem[] = [{role: 'user', content: 'fixture'}, ...(kind === 'orphan' ? [result]
      : kind === 'unresolved' ? [call] : kind === 'duplicate' ? [call, result, call, result] : [call, result])];
    const h = dual({input, otherGate: Promise.resolve(), response: () => response(wire([whole]))});
    try {await h.settle(); expect(h.fetcher).toHaveBeenCalledTimes(1);
      if (kind === 'resolved') {expect(issue).toHaveBeenCalledTimes(1); expect(h.readSubmission()).toHaveProperty('sourceKind', 'assistant_json');}
      else {expectNoIssue(h); expect(h.observations.admissionFailure).toMatchObject({code: 'pending_work'});}}
    finally {await h.cleanup();}
  });

  it('checks original unresolved work even on the dual function lane', async () => {
    const h = dual({input: [{role: 'user', content: 'fixture'}, {type: 'function_call', callId: 'prior', name: 'other_fixture', arguments: '{}'}],
      otherGate: Promise.resolve(), response: () => chatResponse(whole)});
    try {await h.settle(); expectNoIssue(h); expect(h.observations.handlerCalls).toBe(1);
      expect(h.observations.admissionFailure).toMatchObject({code: 'pending_work'});}
    finally {await h.cleanup();}
  });

  it('R13 pending-result status rejects an in-progress original input result through the actual SDK', async () => {
    const input: AgentInputItem[] = [{role: 'user', content: 'fixture'},
      {type: 'function_call', callId: 'input-in-progress', name: 'other_fixture', arguments: '{}'},
      {type: 'function_call_result', callId: 'input-in-progress', name: 'other_fixture', status: 'in_progress', output: 'partial'}];
    const h = dual({input, otherGate: Promise.resolve(), response: () => response(wire([whole]))});
    try {
      const stream = await h.settle();
      expect(h.fetcher).toHaveBeenCalledTimes(1); expect(stream.error).toBeNull(); expect(stream.finalOutput).toBe(whole);
      expect(stream.state._originalInput).toEqual(input);
      const sent = JSON.parse(String(h.fetcher.mock.calls[0][1]?.body));
      expect(sent.messages).toEqual(expect.arrayContaining([expect.objectContaining({role: 'tool', tool_call_id: 'input-in-progress'})]));
      expectNoIssue(h); expect(h.observations.admissionFailure).toMatchObject({code: 'pending_work'});
    } finally {await h.cleanup();}
  });

  it('R13 pending-result status rechecks an actual prior generated result after natural completion', async () => {
    const gate = deferred<void>(); let requests = 0;
    const h = dual({maxTurns: 2, otherGate: Promise.resolve(), consumerGate: gate.promise,
      response: () => ++requests === 1 ? response(wire(['prior text'], {ids: ['prior-response', 'prior-response'], finish: 'tool_calls',
        extra: {tool_calls: [{index: 0, id: 'prior-status-call', type: 'function', function: {name: 'other_fixture', arguments: '{}'}}]}}))
        : response(wire([whole]))});
    try {
      const actual = await h.tracked; await actual.stream.completed; await actual.drain; await boundary();
      expect(h.fetcher).toHaveBeenCalledTimes(2); expect(actual.stream.finalOutput).toBe(whole);
      expect(h.observations.consumerDrained).toBe(false); expectNoIssue(h);
      const generated = actual.stream.state._generatedItems.find(item => item.rawItem.type === 'function_call_result');
      if (!generated || generated.rawItem.type !== 'function_call_result') throw new Error('Expected actual prior handler output');
      expect(generated.rawItem).toMatchObject({callId: 'prior-status-call', name: 'other_fixture', status: 'completed'});
      generated.rawItem.status = 'in_progress';
      gate.resolve(); await h.settle();
      expectNoIssue(h); expect(h.observations.admissionFailure).toMatchObject({code: 'pending_work'});
    } finally {gate.resolve(); await h.cleanup();}
  });

  it('waits for actual prior handler work and uses only the final response text', async () => {
    const gate = deferred<void>(); let requests = 0;
    const h = dual({maxTurns: 2, otherGate: gate.promise, response: () => ++requests === 1
      ? response(wire(['prior non-document text'], {ids: ['prior-response', 'prior-response'], finish: 'tool_calls',
        extra: {tool_calls: [{index: 0, id: 'prior-work', type: 'function', function: {name: 'other_fixture', arguments: '{}'}}]}}))
      : response(wire([whole]))});
    try {await h.otherEntered.promise; await boundary(); expectNoIssue(h); expect(h.observations.drained).toBe(false);
      expect(h.fetcher).toHaveBeenCalledTimes(1); gate.resolve(); await h.settle();
      expect(h.fetcher).toHaveBeenCalledTimes(2); expect(issue).toHaveBeenCalledTimes(1);
      expect(h.readSubmission()).toMatchObject({sourceKind: 'assistant_json', rawAssistantText: whole, binding: {dispatchOrdinal: 2}});}
    finally {gate.resolve(); await h.cleanup();}
  });

  it.each(['unchanged', 'cancel', 'supersede', 'message_text', 'output_order', 'copied_counterpart',
    'duplicate_output', 'step_replaced', 'orphan_result', 'pending_agent', 'original_pending', 'deadline_after_completion'] as const)
    ('rechecks the natural snapshot after the original consumer drains: %s', async change => {
      const gate = deferred<void>(); let deadline = Date.now() + 60_000;
      const h = dual({consumerGate: gate.promise, deadlineAt: () => deadline,
        response: () => response(wire([whole], {extra: {reasoning: 'fixture reasoning'}}))});
      try {
        const actual = await h.tracked; await actual.stream.completed; await actual.drain; await boundary();
        expectNoIssue(h); expect(h.observations.consumerDrained).toBe(false);
        // Mutate the actual SDK state to exercise post-completion tamper rejection.
        // This view does not replace the stream, getter or any admission material.
        const state = actual.stream.state as unknown as {
          _lastTurnResponse: {output: Array<Record<string, unknown>>};
          _lastProcessedResponse: {newItems: Array<{rawItem: Record<string, unknown>}>};
          _currentStep: Record<string, unknown>; _currentAgent: unknown;
          _generatedItems: Array<Record<string, unknown>>; _pendingAgentToolRuns: Map<string, unknown>;
          _originalInput: AgentInputItem[];
        };
        if (change === 'cancel') h.cancel();
        if (change === 'supersede') h.revokeOwner();
        if (change === 'deadline_after_completion') deadline = 0;
        const message = state._lastTurnResponse!.output.find(item => item.type === 'message');
        if (!message || message.type !== 'message' || !Array.isArray(message.content)) throw new Error('Expected actual assistant message');
        if (change === 'message_text') message.content = [{type: 'output_text', text: whole + ' '}];
        if (change === 'output_order') state._lastTurnResponse!.output.reverse();
        if (change === 'duplicate_output') state._lastTurnResponse!.output.push(message);
        if (change === 'copied_counterpart') {
          const counterpart = state._lastProcessedResponse!.newItems.find(item => item.rawItem === message)!;
          Object.defineProperty(counterpart, 'rawItem', {value: {...message}, configurable: true});
        }
        if (change === 'step_replaced') state._currentStep = {...state._currentStep!};
        if (change === 'orphan_result') state._generatedItems.push({type: 'tool_call_output_item',
          rawItem: {type: 'function_call_result', callId: 'orphan', output: 'forged'}, agent: state._currentAgent});
        if (change === 'pending_agent') state._pendingAgentToolRuns.set('unresolved', {});
        if (change === 'original_pending') state._originalInput = [{type: 'function_call', callId: 'late-input', name: 'other_fixture', arguments: '{}'}];
        gate.resolve(); await h.settle();
        if (change === 'unchanged' || change === 'deadline_after_completion') {
          expect(issue).toHaveBeenCalledTimes(1); expect(h.readSubmission()).toMatchObject({sourceKind: 'assistant_json'});
        } else expectNoIssue(h);
      } finally {gate.resolve(); await h.cleanup();}
    });

  it.each([false, true])('does not equate DONE to EOF or issue before real native drain, cancelled=%s', async cancelled => {
    const release = deferred<void>(); let pulled = false;
    const h = dual({response: () => new Response(new ReadableStream<Uint8Array>({async pull(controller) {
      if (!pulled) {pulled = true; controller.enqueue(new TextEncoder().encode(wire([whole]))); return;}
      await release.promise;
      if (cancelled) controller.error(new DOMException('Fixture cancelled', 'AbortError')); else controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}})});
    try {const actual = await h.tracked; await h.assistantTextEntered.promise; await boundary();
      expect(h.observations.drained).toBe(false); expectNoIssue(h);
      if (cancelled) {h.cancel(); await actual.stream.completed; await boundary();
        expect(h.observations.drained).toBe(false); expectNoIssue(h);}
      release.resolve(); await h.settle();
      if (cancelled) expectNoIssue(h); else expect(issue).toHaveBeenCalledTimes(1);
      expect(h.observations.drained).toBe(true);
    } finally {release.resolve(); await h.cleanup();}
  });

  it.each(['raw_limit', 'unknown_action', 'framing_loss'] as const)('keeps %s sticky across a later apparently complete response', fault => {
    const collector = createOpenAiTypedFinalWireCollector({wireVersion: 'openai_chat_final_wire@3', finalToolName});
    const first = collector.startRequest();
    first.chunk({id: 'first', choices: [{index: 0, delta: fault === 'raw_limit'
      ? {content: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES + 1)} : fault === 'unknown_action'
        ? {function_call: {name: 'hidden', arguments: '{}'}} : {content: whole}, finish_reason: 'stop'}]});
    first.done(); first.end(fault !== 'framing_loss');
    const later = collector.startRequest();
    later.chunk({id: 'later', choices: [{index: 0, delta: {content: whole}, finish_reason: 'stop'}]});
    later.done(); later.end(true);
    expect(collector.current()).toBeUndefined(); expect(collector.diagnostic().status).toBe('rejected');
  });

  it('keeps the combined argument plus assistant buffer bounded in the new wire contract', () => {
    const collector = createOpenAiTypedFinalWireCollector({wireVersion: 'openai_chat_final_wire@3', finalToolName});
    const events = collector.startRequest();
    events.chunk({id: 'bounded-dual', choices: [{index: 0, delta: {content: 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES - 2),
      tool_calls: [{index: 0, id: 'bounded-call', type: 'function', function: {name: finalToolName, arguments: '{} '}}]}, finish_reason: 'tool_calls'}]});
    events.done(); events.end(true);
    expect(collector.current()).toBeUndefined(); expect(collector.diagnostic()).toMatchObject({reason: 'raw_limit'});
    expect(events.materialSnapshot!()!.retention.combinedRetainedUtf8Bytes).toBeLessThanOrEqual(OPENAI_TYPED_FINAL_RAW_BYTES);
  });
});

describe('R14 first private compiler quote location', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});
  it.each(['function', 'assistant'] as const)('retains the original quote failure through real %s drain and cleanup', async lane => {
    const document = nativeObjectFixture(); document.bodyParts = ['PRIVATE_QUOTE_BODY 10 ms and 10 ms'];
    document.contract.claims[0].id = 'PRIVATE_CLAIM_ID';
    document.contract.claims[0].semantics!.numeric!.presentation = {unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero',
      quotes: [{kind: 'body_part', text: '10 ms', partIndex: 0, localOccurrence: null}]};
    const text = JSON.stringify({document});
    const response = () => lane === 'function' ? chatResponse(text) : new Response([
      {id: 'diagnostic-response', choices: [{index: 0, delta: {role: 'assistant', content: text}, finish_reason: null}]},
      {id: 'diagnostic-response', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]},
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
    const h = nativeObjectProbe({productionBridge: true, literalSubtree: true, contractVersion: 'openai_typed_final_admission@4',
      argumentsText: text, response});
    try {
      await h.settle(); expect(h.submission()).toBeUndefined(); expect(h.observations.drained).toBe(true); expect(h.observations.consumerDrained).toBe(true);
      const expected = {compilerFailure: 'quote_unresolved', compilerFailureLocation: {reason: 'local_ambiguous', claimOrdinal: 1,
        quoteOrdinal: 1, partIndex: 0, localMatchCount: {count: 2, precision: 'exact'}}};
      expect(h.admission()!.diagnostic()).toMatchObject(expected);
      h.admission()!.revoke('sdk_incomplete'); expect(h.admission()!.diagnostic()).toMatchObject(expected);
      expect(JSON.stringify(h.admission()!.diagnostic())).not.toMatch(/PRIVATE_|10 ms|rawArguments|nativeDocument/);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    } finally {await h.cleanup();}
  });
});
