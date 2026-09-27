// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runOpenAiIntentTransport, type OpenAiIntentTransportInput} from '../engines/openai/openAiIntentTransport';

interface ResponseMessageFixture {
  type: 'message';
  role: 'assistant';
  status: string;
  phase?: 'commentary' | 'final_answer';
  content: Array<{type: 'output_text'; text: string} | {type: 'refusal'; refusal: string}>;
}

function fixture(protocol: 'chat_completions' | 'responses') {
  const chatMessage = {role: 'assistant', content: '{}'};
  const chatChoice: {finish_reason: string | null | undefined; message: typeof chatMessage} = {
    finish_reason: 'stop', message: chatMessage,
  };
  const responseMessage: ResponseMessageFixture = {
    type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: '{}'}],
  };
  const responseBody: {
    model: string; status: string | undefined; error: unknown; incomplete_details: unknown;
    output: Array<ResponseMessageFixture | {type: 'function_call'; name: string}>;
  } = {
    model: 'actual-model', status: 'completed', error: null, incomplete_details: null, output: [responseMessage],
  };
  const output: Record<string, unknown> = protocol === 'chat_completions'
    ? {model: 'actual-model', choices: [chatChoice]} : responseBody;
  const response = {ok: true, status: 200, headers: new Headers(), json: jest.fn<() => Promise<unknown>>().mockResolvedValue(output)};
  const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response as unknown as Response);
  const input: OpenAiIntentTransportInput = {
    prompt: 'current question', systemPrompt: 'assembled classifier contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024, maxOutputTokens: 2048,
    config: {protocol, baseURL: 'https://pinned.example/custom/v1', apiKey: 'SECRET_API_CANARY', lightModel: 'gpt-5.6-mini'},
    fetchImpl,
  };
  return {input, output, response, fetchImpl, chatChoice, chatMessage, responseBody, responseMessage};
}

describe('OpenAI native intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it.each(['responses', 'chat_completions'] as const)('disables official DeepSeek thinking only for explicit %s classification', async protocol => {
    for (const purpose of [undefined, 'classification'] as const) {
      const {input, fetchImpl} = fixture(protocol);
      input.config.baseURL = 'https://api.deepseek.com/v1';
      input.config.lightModel = 'deepseek-v4-flash';
      input.purpose = purpose;
      const deadline = input.deadlineMs;
      expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, request] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe(`https://api.deepseek.com/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
      const body = JSON.parse(request!.body as string);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']).toBe(2048);
      expect(input.deadlineMs).toBe(deadline);
      if (purpose === 'classification') expect(body[protocol === 'responses' ? 'reasoning' : 'thinking'])
        .toEqual(protocol === 'responses' ? {effort: 'none'} : {type: 'disabled'});
      else {expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning');}
      expect(body).not.toHaveProperty(protocol === 'responses' ? 'thinking' : 'reasoning');
    }
  });

  it.each(['responses', 'chat_completions'] as const)('requests official DeepSeek JSON mode only for %s final semantics', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    input.config.baseURL = 'https://api.deepseek.com/v1';
    input.config.lightModel = 'arbitrary-provider-model';
    input.purpose = 'final_semantic';
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    if (protocol === 'responses') {
      expect(body.text).toEqual({format: {type: 'json_object'}});
      expect(body).not.toHaveProperty('response_format');
    } else {
      expect(body.response_format).toEqual({type: 'json_object'});
      expect(body).not.toHaveProperty('text');
    }
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning');
  });

  it.each(['https://api.deepseek.com:8443/v1', 'http://api.deepseek.com/v1',
    'https://api.deepseek.com.evil.test/v1', 'https://gateway.example/api.deepseek.com/v1'])(
    'does not add purpose options through unrecognized endpoint %s', baseURL => {
      return Promise.all((['responses', 'chat_completions'] as const).flatMap(protocol =>
        (['classification', 'final_semantic'] as const).map(async purpose => {
        const {input, fetchImpl} = fixture(protocol);
        input.config.baseURL = baseURL; input.config.lightModel = 'deepseek-v4-flash'; input.purpose = purpose;
        expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
        const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
        expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning');
        expect(body).not.toHaveProperty('response_format'); expect(body).not.toHaveProperty('text');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      })));
    },
  );

  it.each(['semantic', 'analysis', '', null, 1])('rejects unknown explicit purpose %s without dispatch', purpose => {
    const {input, fetchImpl} = fixture('chat_completions');
    (input as {purpose?: unknown}).purpose = purpose;
    return expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_configuration'})
      .then(() => expect(fetchImpl).not.toHaveBeenCalled());
  });

  it('keeps a truncated official classification unavailable without increasing the cap or retrying', async () => {
    const {input, chatChoice, fetchImpl} = fixture('chat_completions');
    input.config.baseURL = 'https://api.deepseek.com/v1'; input.config.lightModel = 'deepseek-v4-flash'; input.purpose = 'classification';
    chatChoice.finish_reason = 'length';
    expect(await runOpenAiIntentTransport(input)).toEqual({status: 'unavailable', reason: 'incomplete_output'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({thinking: {type: 'disabled'}, max_tokens: 2048});
  });

  it.each(['responses', 'chat_completions'] as const)('pins endpoint/auth/model for one %s request without history or retries', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{}', actualModel: 'actual-model', finishReason: protocol === 'responses' ? 'completed' : 'stop',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, rawRequest] = fetchImpl.mock.calls[0];
    const request = rawRequest!;
    expect(String(url)).toBe(`https://pinned.example/custom/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
    expect(request.headers).toEqual({'Content-Type': 'application/json', Authorization: 'Bearer SECRET_API_CANARY'});
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(request.body as string);
    expect(body.model).toBe(input.config.lightModel);
    if (protocol === 'responses') {
      expect(body).toEqual({
        model: input.config.lightModel, instructions: input.systemPrompt,
        input: [{role: 'user', content: input.prompt}], tools: [], store: false, stream: true, max_output_tokens: 2048,
      });
    } else {
      expect(body).toEqual({
        model: input.config.lightModel,
        messages: [{role: 'system', content: input.systemPrompt}, {role: 'user', content: input.prompt}],
        temperature: 0, stream: true, max_completion_tokens: 2048,
      });
    }
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('conversation');
  });

  it.each(['responses', 'chat_completions'] as const)('omits the provider output-token field for %s when no explicit cap is supplied', async protocol => {
    const {input, fetchImpl} = fixture(protocol);
    delete (input as Partial<OpenAiIntentTransportInput>).maxOutputTokens;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok'});
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.model).toBe(input.config.lightModel);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8192', null])('rejects an explicitly invalid output-token limit %s before dispatch', async value => {
    const {input, fetchImpl} = fixture('chat_completions');
    input.maxOutputTokens = value as number;
    expect(await runOpenAiIntentTransport(input)).toEqual({status: 'unavailable', reason: 'invalid_configuration'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the existing Chat Completions token compatibility for a gateway model', async () => {
    const {input, fetchImpl} = fixture('chat_completions');
    input.config.lightModel = 'deepseek-chat';
    await runOpenAiIntentTransport(input);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(2048);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it.each(['length', 'content_filter', 'tool_calls', 'end_turn', null, undefined])('rejects Chat Completions finish %s even with complete-looking JSON', async finish => {
    const {input, chatChoice, fetchImpl} = fixture('chat_completions');
    chatChoice.finish_reason = finish;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'unavailable'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {tool_calls: [{id: 'call-1', function: {name: 'unexpected'}}]},
    {function_call: {name: 'legacy-tool'}},
    {refusal: 'REFUSAL_CANARY'},
  ])('rejects tool or refusal fields next to successful Chat Completions text %#', async fields => {
    const {input, chatMessage} = fixture('chat_completions');
    Object.assign(chatMessage, fields);
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(result).not.toHaveProperty('text');
  });

  it.each(['incomplete', 'failed', 'in_progress', undefined])('rejects Responses status %s without escalating output budget', async status => {
    const {input, responseBody, fetchImpl} = fixture('responses');
    responseBody.status = status;
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'unavailable'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'incomplete', 'tool', 'refusal', 'message-incomplete', 'commentary-refusal'])('rejects Responses %s mixed with final text', async kind => {
    const {input, responseBody, responseMessage} = fixture('responses');
    if (kind === 'error') responseBody.error = {message: 'SECRET_ERROR_CANARY'};
    if (kind === 'incomplete') responseBody.incomplete_details = {reason: 'max_output_tokens'};
    if (kind === 'tool') responseBody.output.push({type: 'function_call', name: 'unexpected'});
    if (kind === 'refusal') responseMessage.content.push({type: 'refusal', refusal: 'REFUSAL_CANARY'});
    if (kind === 'message-incomplete') responseMessage.status = 'incomplete';
    if (kind === 'commentary-refusal') responseBody.output.push({
      type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
      content: [{type: 'refusal', refusal: 'REFUSAL_CANARY'}],
    });
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(result).not.toHaveProperty('text');
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_CANARY');
  });

  it('ignores explicit Responses commentary and never uses output_text as a validation bypass', async () => {
    const {input, output, responseBody} = fixture('responses');
    output.output_text = 'TOP_LEVEL_CANARY';
    responseBody.output.unshift({
      type: 'message', role: 'assistant', status: 'completed', phase: 'commentary',
      content: [{type: 'output_text', text: 'DRAFT_CANARY'}],
    });
    expect(await runOpenAiIntentTransport(input)).toMatchObject({status: 'ok', text: '{}'});
    responseBody.output = [];
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
  });

  it.each(['responses', 'chat_completions'] as const)('keeps %s actualModel absent when the provider does not report it', async protocol => {
    const {input, output} = fixture(protocol);
    delete output.model;
    const result = await runOpenAiIntentTransport(input);
    expect(result).toMatchObject({status: 'ok'});
    expect(result).not.toHaveProperty('actualModel');
  });

  it.each(['responses', 'chat_completions'] as const)('propagates parent cancellation before a late %s response body is read', async protocol => {
    const {input, response, fetchImpl} = fixture(protocol);
    let resolveFetch!: (value: Response) => void;
    fetchImpl.mockReturnValue(new Promise(resolve => {resolveFetch = resolve;}));
    const controller = new AbortController();
    const pending = runOpenAiIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError', message: 'Intent classification cancelled'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('SECRET_PARENT_CANARY'));
    await rejected;
    resolveFetch(response as unknown as Response);
    await jest.advanceTimersByTimeAsync(0);
    expect(response.json).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1]!.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['responses', 'chat_completions'] as const)('covers %s response parsing with the same deadline and byte budget', async protocol => {
    const {input, output, response, fetchImpl, chatMessage, responseMessage} = fixture(protocol);
    let resolveJson!: (value: unknown) => void;
    response.json.mockReturnValueOnce(new Promise(resolve => {resolveJson = resolve;}));
    const pending = runOpenAiIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveJson(output);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (protocol === 'responses') responseMessage.content = [{type: 'output_text', text: '中文'}];
    else chatMessage.content = '中文';
    await expect(runOpenAiIntentTransport({...input, deadlineMs: Date.now() + 50, outputByteLimit: 5}))
      .resolves.toEqual({status: 'unavailable', reason: 'output_limit'});
  });

  it('does not read HTTP error bodies or return thrown provider secrets', async () => {
    const {input, response, fetchImpl} = fixture('responses');
    response.ok = false;
    response.json.mockRejectedValue(new Error('SECRET_HTTP_BODY_CANARY'));
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
    expect(response.json).not.toHaveBeenCalled();
    fetchImpl.mockRejectedValueOnce(new Error('SECRET_FETCH_CANARY'));
    await expect(runOpenAiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });
});

describe('OpenAI native intent transport provider retry', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  const retryConfig = {protocol: 'chat_completions' as const, baseURL: 'https://retry.example/v4',
    apiKey: 'k', lightModel: 'm'};
  const okBody = () => new Response(JSON.stringify({model: 'm', choices: [
    {message: {role: 'assistant', content: 'fine'}, finish_reason: 'stop'},
  ]}), {status: 200});
  const run = (fetchImpl: typeof fetch, budgetMs = 60_000) => runOpenAiIntentTransport({prompt: 'p', systemPrompt: '',
    deadlineMs: Date.now() + budgetMs, outputByteLimit: 1024, config: retryConfig, fetchImpl});

  it.each<[string, () => Promise<Response>]>([
    ['a 5xx', async () => new Response('{}', {status: 500})],
    ['a rate limit', async () => new Response('{}', {status: 429})],
    ['a thrown fetch error', async () => {throw new Error('socket hang up');}],
  ])('retries %s once and reports the attempt count', async (_label, firstCall) => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementationOnce(firstCall).mockImplementation(async () => okBody());
    const pending = run(fetchImpl);
    await jest.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toMatchObject({status: 'ok', text: 'fine', attempts: 2});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the http status and attempt count when both calls fail', async () => {
    const pending = run(jest.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {status: 502})));
    await jest.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'provider_error', httpStatus: 502, attempts: 2});
  });

  it.each([400, 401, 403, 404, 422])('never retries a deterministic %i', async status => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {status}));
    await expect(run(fetchImpl)).resolves.toEqual({status: 'unavailable', reason: 'provider_error', httpStatus: status});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown, object]>([
    ['an error body delivered with 200', {error: {message: 'bad model'}}, {status: 'unavailable', reason: 'provider_error'}],
    ['a protocol failure', {model: 'm', choices: []}, {status: 'unavailable', reason: 'invalid_response'}],
  ])('never retries %s', async (_label, body, expected) => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), {status: 200}));
    await expect(run(fetchImpl)).resolves.toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the deadline is nearly exhausted', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async () => new Response('{}', {status: 500}));
    await expect(run(fetchImpl, 1_000)).resolves.toEqual({status: 'unavailable', reason: 'provider_error', httpStatus: 500});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI native intent transport streaming', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  const encoder = new TextEncoder();
  /** An event stream from raw byte chunks; `open` leaves it unclosed, as a keep-alive server would. */
  function sse(chunks: Array<string | Uint8Array>, options: {open?: boolean; onCancel?: () => void} = {}): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        if (!options.open) controller.close();
      },
      cancel() {options.onCancel?.();},
    }), {status: 200, headers: {'content-type': 'text/event-stream; charset=utf-8'}});
  }
  const chat = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({model: 'glm-actual', choices: [{index: 0, delta, finish_reason: finish}], ...extra})}\n\n`;
  const input = (protocol: 'chat_completions' | 'responses', fetchImpl: typeof fetch, outputByteLimit = 1024): OpenAiIntentTransportInput => ({
    prompt: 'p', systemPrompt: '', deadlineMs: Date.now() + 60_000, outputByteLimit, fetchImpl,
    config: {protocol, baseURL: 'https://stream.example/v4', apiKey: 'k', lightModel: 'glm-5.3-flash'},
  });
  const once = (response: Response) => jest.fn<typeof fetch>().mockResolvedValue(response);
  const event = (value: Record<string, unknown>) => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`;
  const final = (status: string, extra: Record<string, unknown> = {}, text = '{}') => event({type: `response.${status}`, response: {
    model: 'm', status, error: null, incomplete_details: null, output: [{type: 'message', role: 'assistant', status: 'completed',
      content: [{type: 'output_text', text}]}], ...extra}});

  it('reports first output, usage and the reasoning control to an observer without changing the result', async () => {
    const seen: string[] = [];
    const usage: unknown[] = [];
    const observer = {firstOutput: () => seen.push('first'), usage: (value: unknown) => usage.push(value),
      reasoning: (policy: string) => seen.push(policy)};
    const chatFetch = once(sse([chat({role: 'assistant'}), chat({reasoning_content: 'thinking'}), chat({content: 'fine'}, 'stop'),
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n', 'data: [DONE]\n\n']));
    const plain = await runOpenAiIntentTransport(input('chat_completions', once(sse([chat({content: 'fine'}, 'stop'),
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n', 'data: [DONE]\n\n']))));
    const observed = await runOpenAiIntentTransport({...input('chat_completions', chatFetch), observer});
    expect(observed).toEqual(plain);
    expect(seen).toEqual(['provider_default', 'first']);
    expect(usage).toEqual([{prompt_tokens: 9, completion_tokens: 2}]);

    const responsesSeen: string[] = [];
    const responsesFetch = once(sse([event({type: 'response.output_text.delta', item_id: 'm', delta: '{}'}),
      final('completed', {usage: {input_tokens: 5, output_tokens: 1}})]));
    const responsesUsage: unknown[] = [];
    await runOpenAiIntentTransport({...input('responses', responsesFetch),
      observer: {firstOutput: () => responsesSeen.push('first'), usage: (value: unknown) => responsesUsage.push(value)}});
    expect(responsesSeen).toEqual(['first']);
    expect(responsesUsage).toEqual([{input_tokens: 5, output_tokens: 1}]);
  });

  it('asks both protocols to stream', async () => {
    for (const protocol of ['chat_completions', 'responses'] as const) {
      const fetchImpl = once(new Response('{}', {status: 200}));
      await runOpenAiIntentTransport(input(protocol, fetchImpl));
      expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).stream).toBe(true);
    }
  });

  it('folds a chat stream across split lines, CRLF, a split UTF-8 character and ignored reasoning into one answer', async () => {
    const answer = chat({content: '{"a":"中'}).replace(/\n/g, '\r\n');
    const bytes = encoder.encode(answer);
    const cut = answer.indexOf('中');
    const splitAt = encoder.encode(answer.slice(0, cut)).length + 1; // inside the 3-byte character
    const fetchImpl = once(sse([
      ': keep-alive comment\n\n',
      chat({role: 'assistant', reasoning_content: 'long thinking'}),
      bytes.slice(0, splitAt), bytes.slice(splitAt, bytes.length - 1), bytes.slice(bytes.length - 1),
      'data: {"model":"glm-actual","choices":[{"index":0,\ndata: "delta":{"content":"文\\"}"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    await expect(runOpenAiIntentTransport(input('chat_completions', fetchImpl)))
      .resolves.toEqual({status: 'ok', text: '{"a":"中文"}', actualModel: 'glm-actual', finishReason: 'stop'});
  });

  it('returns after the terminal event and releases a connection the server keeps open', async () => {
    const onCancel = jest.fn();
    const fetchImpl = once(sse([chat({content: 'fine'}, 'stop'), 'data: [DONE]\n\n'], {open: true, onCancel}));
    await expect(runOpenAiIntentTransport(input('chat_completions', fetchImpl))).resolves.toMatchObject({status: 'ok', text: 'fine'});
    await jest.advanceTimersByTimeAsync(0);
    expect(onCancel).toHaveBeenCalled();
  });

  it('ends CR-only lines at once, even when the server keeps the connection open', async () => {
    const fetchImpl = once(sse([chat({content: 'fine'}, 'stop').replace(/\n/g, '\r'), 'data: [DONE]\r\r'], {open: true}));
    await expect(runOpenAiIntentTransport(input('chat_completions', fetchImpl))).resolves.toMatchObject({status: 'ok', text: 'fine'});
  });

  it('closes a finished reply without [DONE] after the drain window on a kept-alive connection', async () => {
    const onCancel = jest.fn();
    const fetchImpl = once(sse([chat({content: 'fine'}, 'stop'), 'data: {"choices":[],"usage":{"completion_tokens":1}}\n\n'],
      {open: true, onCancel}));
    const pending = runOpenAiIntentTransport(input('chat_completions', fetchImpl));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({status: 'ok', text: 'fine', finishReason: 'stop'});
    expect(onCancel).toHaveBeenCalled();
  });

  it('does not let heartbeats after the finish renew the drain window', async () => {
    const onCancel = jest.fn();
    const fetchImpl = once(new Response(new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(encoder.encode(chat({content: 'fine'}, 'stop')));},
      pull(controller) {
        return new Promise<void>(resolve => {setTimeout(() => {controller.enqueue(encoder.encode(': ping\n\n')); resolve();}, 400);});
      },
      cancel() {onCancel();},
    }), {status: 200, headers: {'content-type': 'text/event-stream'}}));
    const pending = runOpenAiIntentTransport(input('chat_completions', fetchImpl));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({status: 'ok', text: 'fine'});
    expect(onCancel).toHaveBeenCalled();
  });

  it('accepts a finish reason without [DONE], and rejects [DONE] without a finish reason', async () => {
    await expect(runOpenAiIntentTransport(input('chat_completions', once(sse([chat({content: 'fine'}, 'stop')])))))
      .resolves.toMatchObject({status: 'ok', text: 'fine'});
    await expect(runOpenAiIntentTransport(input('chat_completions', once(sse([chat({content: 'fine'}), 'data: [DONE]\n\n'])))))
      .resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
  });

  it.each<[string, string[], object]>([
    ['a length finish', [chat({content: '{"a":'}, 'length')], {reason: 'incomplete_output'}],
    ['a tool call', [chat({tool_calls: [{index: 0, function: {name: 'x'}}]}), chat({}, 'tool_calls')], {reason: 'tool_use'}],
    ['a refusal', [chat({refusal: 'no'}), chat({}, 'stop')], {reason: 'invalid_response'}],
    ['a non-assistant role', [chat({role: 'user', content: 'x'}, 'stop')], {reason: 'invalid_response'}],
    ['a second choice', [`data: ${JSON.stringify({choices: [{index: 1, delta: {content: 'x'}, finish_reason: 'stop'}]})}\n\n`], {reason: 'invalid_response'}],
    ['text after the finish', [chat({content: 'a'}, 'stop'), chat({content: 'b'})], {reason: 'invalid_response'}],
    ['conflicting finish reasons', [chat({content: 'a'}, 'length'), chat({}, 'stop')], {reason: 'invalid_response'}],
    ['a malformed chunk', ['data: {"choices":\n\n'], {reason: 'invalid_response'}],
    ['an error chunk', ['data: {"error":{"message":"SECRET_STREAM_CANARY"}}\n\n'], {reason: 'provider_error'}],
  ])('keeps %s as the non-streamed body would, without retrying', async (_label, chunks, expected) => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async () => sse(chunks));
    const result = await runOpenAiIntentTransport(input('chat_completions', fetchImpl));
    expect(result).toEqual({status: 'unavailable', ...expected});
    expect(JSON.stringify(result)).not.toContain('SECRET_STREAM_CANARY');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops reading once answer text passes the output budget', async () => {
    const onCancel = jest.fn();
    const fetchImpl = once(sse([chat({content: 'x'.repeat(6)}), chat({content: 'y'.repeat(6)})], {open: true, onCancel}));
    await expect(runOpenAiIntentTransport(input('chat_completions', fetchImpl, 10)))
      .resolves.toEqual({status: 'unavailable', reason: 'output_limit'});
    await jest.advanceTimersByTimeAsync(0);
    expect(onCancel).toHaveBeenCalled();
  });

  it('rejects one event that grows past the buffer bound', async () => {
    const fetchImpl = once(sse([`data: ${'x'.repeat(2 * 1024 * 1024)}\n`, `data: ${'x'.repeat(2 * 1024 * 1024)}\n`], {open: true}));
    await expect(runOpenAiIntentTransport(input('chat_completions', fetchImpl)))
      .resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
  });

  it.each(['chat_completions', 'responses'] as const)('retries a %s stream that closes before its terminal event', async protocol => {
    const good = protocol === 'chat_completions' ? [chat({content: 'fine'}, 'stop')] : [final('completed', {}, 'fine')];
    const partial = protocol === 'chat_completions' ? [chat({content: 'fi'})]
      : [event({type: 'response.output_text.delta', item_id: 'm', delta: 'fi'})];
    const fetchImpl = jest.fn<typeof fetch>().mockImplementationOnce(async () => sse(partial)).mockImplementation(async () => sse(good));
    const pending = runOpenAiIntentTransport(input(protocol, fetchImpl));
    await jest.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toMatchObject({status: 'ok', text: 'fine', attempts: 2});
  });

  it('stops a stalled stream at the run deadline', async () => {
    const fetchImpl = once(sse([': thinking\n\n'], {open: true}));
    const pending = runOpenAiIntentTransport({...input('chat_completions', fetchImpl), deadlineMs: Date.now() + 50});
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    expect(fetchImpl.mock.calls[0][1]!.signal?.aborted).toBe(true);
  });

  describe('Responses', () => {
    it('takes the completed response and does not charge commentary against the answer budget', async () => {
      const fetchImpl = once(sse([
        event({type: 'response.output_item.added', item: {id: 'c', type: 'message', phase: 'commentary'}}),
        event({type: 'response.output_text.delta', item_id: 'c', delta: 'x'.repeat(50)}),
        event({type: 'response.output_text.delta', item_id: 'm', delta: '{}'}),
        final('completed'),
      ]));
      await expect(runOpenAiIntentTransport(input('responses', fetchImpl, 10)))
        .resolves.toEqual({status: 'ok', text: '{}', actualModel: 'm', finishReason: 'completed'});
    });

    it.each<[string, string[], object]>([
      ['answer text over budget', [event({type: 'response.output_text.delta', item_id: 'm', delta: 'x'.repeat(11)})], {reason: 'output_limit'}],
      ['an error event', [event({type: 'error', message: 'SECRET_STREAM_CANARY'})], {reason: 'provider_error'}],
      ['a failed response', [final('failed', {error: {message: 'SECRET_STREAM_CANARY'}})], {reason: 'provider_error'}],
      ['an incomplete response', [final('incomplete', {incomplete_details: {reason: 'max_output_tokens'}})], {reason: 'incomplete_output'}],
      ['an event without a type', ['data: {"response":{}}\n\n'], {reason: 'invalid_response'}],
    ])('keeps %s', async (_label, chunks, expected) => {
      const result = await runOpenAiIntentTransport(input('responses', once(sse(chunks, {open: true})), 10));
      expect(result).toEqual({status: 'unavailable', ...expected});
      expect(JSON.stringify(result)).not.toContain('SECRET_STREAM_CANARY');
    });
  });
});
