// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';
import {Agent, OpenAIProvider, Runner, shellTool, tool,
  type FunctionToolResult, type RunContext} from '@openai/agents';
import OpenAI from 'openai';
import {z} from 'zod';
import {compileAuthoredClaimDocument} from '../../agent/core/authoredClaimDocument';
import {__testing as openAiRuntimeTesting} from '../engines/openai/openAiRuntime';
import {createOpenAiTypedFinalAttempt, createOpenAiTypedFinalWireCollector, OPENAI_TYPED_FINAL_PENDING_ACK,
  OPENAI_TYPED_FINAL_RAW_BYTES, type OpenAiTypedFinalWireObserver} from '../engines/openai/openAiTypedFinalAdmission';
import {createAuthoredFinalSubmissionIssuer, readAuthoredFinalSubmission,
  AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION} from '../authoredFinalSubmission';
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
function startNativeRun(runner: Runner, agent: Agent, signal: AbortSignal) {
  return runner.run(agent, 'fixture', {stream: true, maxTurns: 1, signal});
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
        toolCall: details?.toolCall}) : undefined;
      handlerWorkEntered.resolve();
      await options.handlerGate;
      expect(args.documentJson).toBe(documentJson);
      if (admission && invocation && !options.skipPrivateSuccess) admission.markPrivateHandlerSuccess(invocation,
        {output: OPENAI_TYPED_FINAL_PENDING_ACK, documentJson: options.handlerDocument ?? args.documentJson});
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
      expect(collector.current()?.rawArguments).toBe(rawArguments);
    } finally {await reading;}
  });

  it.each([0, 1])('bounds the actual concatenated arguments at one MiB (excess=%i)', async excess => {
    const collector = createOpenAiTypedFinalWireCollector();
    const raw = 'x'.repeat(OPENAI_TYPED_FINAL_RAW_BYTES + excess);
    const pieces: string[] = [];
    for (let at = 0; at < raw.length; at += 8192) pieces.push(raw.slice(at, at + 8192));
    await consumeObserved(streamedArgumentResponse(pieces), collector);
    if (excess) expect(collector.diagnostic()).toMatchObject({status: 'rejected', reason: 'raw_limit'});
    else expect(collector.current()?.rawArguments).toBe(raw);
  });

  it('preserves lone surrogates and a surrogate pair split between argument deltas', async () => {
    const collector = createOpenAiTypedFinalWireCollector();
    const pieces = ['a\ud800', '\udc00', '\ud801'];
    await consumeObserved(streamedArgumentResponse(pieces), collector);
    expect(collector.current()?.rawArguments).toBe(pieces.join(''));
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
