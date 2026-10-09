// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runQoderIntentTransport, type QoderIntentTransportInput} from '../engines/qoder/qoderIntentTransport';
import type {QoderSdkModule} from '../engines/qoder/qoderSdkLoader';

interface QoderOptionsProbe {
  model?: string;
  abortController: AbortController;
  resolveModel?: (input: {purpose: string}) => unknown;
}

// The optional SDK loader deliberately exposes unknown options. Probe only the
// native fields exercised by this adapter, without importing an optional package.
function queryOptions(options: unknown): QoderOptionsProbe {
  return options as QoderOptionsProbe;
}

function fixture(messages: unknown[] = [{
  type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: null, modelUsage: {'same-light': {}},
}]) {
  const query = {
    async *[Symbol.asyncIterator]() {yield* messages;},
    interrupt: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const sdk = {
    query: jest.fn<QoderSdkModule['query']>().mockReturnValue(query),
    qodercliAuth: jest.fn<QoderSdkModule['qodercliAuth']>(),
    accessTokenFromEnv: jest.fn<QoderSdkModule['accessTokenFromEnv']>(),
    createSdkMcpServer: jest.fn<QoderSdkModule['createSdkMcpServer']>(),
  };
  const auth = {type: 'test-auth'};
  const loadSdk = jest.fn<QoderIntentTransportInput['loadSdk']>().mockResolvedValue(sdk);
  const resolveAuth = jest.fn<(sdk: QoderSdkModule) => Promise<unknown>>().mockResolvedValue(auth);
  const input: QoderIntentTransportInput = {
    prompt: 'current question', systemPrompt: 'assembled contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024,
    isolatedClassifierDirectory: '/isolated/classifier',
    loadSdk, resolveAuth,
    config: {model: 'same-primary', lightModel: 'same-light', byok: {
      provider: 'pinned-provider', apiKey: 'SECRET_BYOK_CANARY', baseUrl: 'https://provider.example/v1', style: 'openai',
    }},
    scopedEnv: {PATH: '/usr/bin', QODER_BYOK_API_KEY: 'SECRET_BYOK_CANARY'},
  };
  return {input, query, sdk, auth, loadSdk, resolveAuth};
}

describe('Qoder intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it('checks the run authorization at the query boundary, after auth resolved', async () => {
    const {input, sdk, resolveAuth} = fixture();
    let releaseAuth!: (auth: unknown) => void;
    resolveAuth.mockReturnValue(new Promise(resolve => { releaseAuth = resolve; }));
    let revoked = false;
    const beforeQuery = jest.fn(() => {
      if (revoked) throw new Error('analysis_context_changed_restart_required');
    });
    const pending = runQoderIntentTransport({...input, deadlineMs: Date.now() + 5_000, beforeQuery});
    await jest.advanceTimersByTimeAsync(0);
    expect(resolveAuth).toHaveBeenCalledTimes(1);
    revoked = true; // Consent is withdrawn while auth resolves.
    releaseAuth({type: 'test-auth'});
    await pending;
    expect(beforeQuery).toHaveBeenCalledTimes(1);
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('dispatches one isolated tool-free query with fixed same-provider BYOK selection', async () => {
    const {input, query, sdk, auth, resolveAuth} = fixture();
    await expect(runQoderIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{}', actualModel: 'same-light',
    });
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(resolveAuth).toHaveBeenCalledWith(sdk);
    const sent = sdk.query.mock.calls[0][0];
    expect(sent.prompt).toBe(input.prompt);
    expect(sent.options).toMatchObject({
      auth, cwd: input.isolatedClassifierDirectory, systemPrompt: input.systemPrompt, model: 'same-light',
      maxTurns: 1, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      closeGraceMs: 500, controlRequestTimeoutMs: 50,
      settingSources: [], skills: [], plugins: [], promptSuggestions: false, permissionMode: 'dontAsk',
      env: {PATH: '/usr/bin'},
    });
    for (const purpose of ['main', 'title', 'utility']) {
      expect(queryOptions(sent.options).resolveModel!({purpose})).toEqual({model: {
        provider: 'pinned-provider', api_key: 'SECRET_BYOK_CANARY', model: 'same-light',
        url: 'https://provider.example/v1', style: 'openai',
      }});
    }
    expect(JSON.stringify(sent.options)).not.toContain('SECRET_BYOK_CANARY');
    for (const key of ['resume', 'sessionId', 'maxOutputTokens', 'maxTokens']) {
      expect(sent.options).not.toHaveProperty(key);
    }
    expect(query.close).toHaveBeenCalledTimes(1);
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it.each([
    {model: 'primary', lightModel: 'light', expected: 'light'},
    {model: 'primary', lightModel: undefined, expected: 'primary'},
    {model: undefined, lightModel: undefined, expected: undefined},
  ])('uses the configured platform model without inventing a light model: $expected', async config => {
    const {input, sdk} = fixture();
    await runQoderIntentTransport({...input, config: {...config, byok: {}}});
    const options = queryOptions(sdk.query.mock.calls[0][0].options);
    expect(options.model).toBe(config.expected);
    expect(options).not.toHaveProperty('resolveModel');
  });

  it('uses only successful terminal output and enforces UTF-8 bytes on structured output', async () => {
    const {input} = fixture([
      {type: 'assistant', message: {content: [{type: 'text', text: 'DRAFT_CANARY'}]}},
      {type: 'result', subtype: 'success', is_error: false, result: 'ignored', structured_output: {intent: 'focused'}},
    ]);
    await expect(runQoderIntentTransport(input)).resolves.toMatchObject({status: 'ok', text: '{"intent":"focused"}'});
    const oversized = fixture([{type: 'result', subtype: 'success', is_error: false, structured_output: {text: '中文'}}]);
    await expect(runQoderIntentTransport({...oversized.input, outputByteLimit: 12}))
      .resolves.toEqual({status: 'unavailable', reason: 'output_limit'});
  });

  it.each([
    {modelUsage: {'routed-native-model': {}}, actualModel: 'routed-native-model'},
    {modelUsage: undefined, actualModel: undefined},
    {modelUsage: {first: {}, second: {}}, actualModel: undefined},
  ])('reports an actual model only from unambiguous terminal usage: $actualModel', async ({modelUsage, actualModel}) => {
    const {input} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '{}', modelUsage}]);
    const result = await runQoderIntentTransport(input);
    expect(result).toMatchObject({status: 'ok'});
    if (actualModel) expect(result).toHaveProperty('actualModel', actualModel);
    else expect(result).not.toHaveProperty('actualModel');
  });

  it.each([
    {messages: [{type: 'assistant', message: {content: [{type: 'text', text: '{}'}]}}]},
    {messages: [{type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['SECRET_ERROR_CANARY']}]},
    {messages: [{type: 'result', subtype: 'success', is_error: true, result: '{}'}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens', result: '{}'}]},
    {messages: [{type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash'}]}}]},
    {messages: [{type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_use'}}}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, result: '{}', deferred_tool_use: {name: 'Bash'}}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: []}]},
  ])('rejects incomplete, erroneous or tool-bearing output %#', async ({messages}) => {
    const {input, query} = fixture(messages);
    const result = await runQoderIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_CANARY');
    expect(result).not.toHaveProperty('text');
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'call-1', content: 'result'}]}},
    {type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_result', tool_use_id: 'call-1'}}},
  ])('rejects structured tool-result blocks before a later successful terminal %#', async firstMessage => {
    const {input, query} = fixture([
      firstMessage,
      {type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: null},
    ]);
    await expect(runQoderIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'tool_use'});
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{type: 'result', subtype: 'success', is_error: true, result: 'API Error'}, 'provider_error'],
    [{type: 'result', subtype: 'error_during_execution', is_error: true}, 'provider_error'],
    [{type: 'result', subtype: 'error_max_turns', is_error: true}, 'invalid_response'],
  ] as const)('reports SDK result %# as its own failure reason', async (message, reason) => {
    const {input} = fixture([message]);
    await expect(runQoderIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason});
  });

  it.each(['pause_turn', 'refusal', 'model_context_window_exceeded', 'future_reason', ''])('rejects incomplete or unknown explicit stop reason %s', async stopReason => {
    const {input, query} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: stopReason}]);
    await expect(runQoderIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it.each(['model_refusal_fallback', 'model_refusal_no_fallback'])('rejects an explicit %s SDK event before success', async subtype => {
    const {input, query} = fixture([
      {type: 'system', subtype},
      {type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: null},
    ]);
    await expect(runQoderIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, 'end_turn', 'stop_sequence'])('accepts native completed or nullable stop reason %# without matching protocol words in text', async stopReason => {
    const text = '{"reason":"tool_result describes the schema"}';
    const {input} = fixture([{
      type: 'result', subtype: 'success', is_error: false, result: text,
      ...(stopReason === undefined ? {} : {stop_reason: stopReason}),
    }]);
    await expect(runQoderIntentTransport(input)).resolves.toEqual({
      status: 'ok', text, ...(typeof stopReason === 'string' ? {finishReason: stopReason} : {}),
    });
  });

  it('times out an uncooperative iterator and attempts close even if interrupt hangs', async () => {
    const {input, sdk, query} = fixture();
    query.interrupt.mockReturnValue(new Promise(() => undefined));
    sdk.query.mockReturnValue({
      [Symbol.asyncIterator]: () => ({next: () => new Promise(() => undefined)}),
      interrupt: query.interrupt, close: query.close,
    });
    const pending = runQoderIntentTransport(input);
    await jest.advanceTimersByTimeAsync(1051);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(query.close).toHaveBeenCalledTimes(1);
    expect(queryOptions(sdk.query.mock.calls[0][0].options).abortController.signal.aborted).toBe(true);
  });

  it('throws parent cancellation and ignores a late terminal result', async () => {
    const {input, sdk, query} = fixture();
    let resolveNext!: (value: unknown) => void;
    sdk.query.mockReturnValue({
      [Symbol.asyncIterator]: () => ({next: () => new Promise(resolve => {resolveNext = resolve;})}),
      interrupt: query.interrupt, close: query.close,
    });
    const controller = new AbortController();
    const pending = runQoderIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('SECRET_PARENT_CANARY'));
    await rejected;
    resolveNext({done: false, value: {type: 'result', subtype: 'success', is_error: false, result: '{}'}});
    await jest.advanceTimersByTimeAsync(0);
    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(query.close).toHaveBeenCalledTimes(1);
    expect(sdk.query).toHaveBeenCalledTimes(1);
  });

  it('still interrupts and throws cancellation when the parent aborts during close', async () => {
    const {input, sdk, query} = fixture();
    let finishClose!: () => void;
    query.close.mockReturnValue(new Promise<void>(resolve => {finishClose = resolve;}));
    const controller = new AbortController();
    const pending = runQoderIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    finishClose();
    await rejected;
    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(query.close).toHaveBeenCalledTimes(1);
    expect(queryOptions(sdk.query.mock.calls[0][0].options).abortController.signal.aborted).toBe(true);
  });

  it('does not authenticate or dispatch after a late SDK load, and redacts load errors', async () => {
    const {input, loadSdk, resolveAuth, sdk} = fixture();
    let resolveLoad!: (value: QoderSdkModule) => void;
    loadSdk.mockReturnValueOnce(new Promise(resolve => {resolveLoad = resolve;}));
    const pending = runQoderIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveLoad(sdk);
    await jest.advanceTimersByTimeAsync(0);
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(sdk.query).not.toHaveBeenCalled();
    loadSdk.mockRejectedValueOnce(new Error('SECRET_LOAD_CANARY'));
    await expect(runQoderIntentTransport({...input, deadlineMs: Date.now() + 50}))
      .resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });
});
