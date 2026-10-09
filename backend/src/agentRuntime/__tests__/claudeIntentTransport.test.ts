// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runClaudeIntentTransport, type ClaudeIntentSdk, type ClaudeIntentTransportInput} from '../engines/claude/claudeIntentTransport';

function fixture(messages: unknown[] = [{
  type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'end_turn',
  modelUsage: {'actual-native-model': {}},
}]) {
  const stream = {
    async *[Symbol.asyncIterator]() {yield* messages;},
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const sdk = {query: jest.fn<ClaudeIntentSdk['query']>().mockReturnValue(stream)};
  const loadSdk = jest.fn<ClaudeIntentTransportInput['loadSdk']>().mockResolvedValue(sdk);
  const input: ClaudeIntentTransportInput = {
    prompt: 'current question', systemPrompt: 'assembled classifier contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024,
    config: {lightModel: 'configured-light-model', cwd: '/configured/cwd'},
    sdkEnv: {ANTHROPIC_BASE_URL: 'https://pinned-provider.example', ANTHROPIC_AUTH_TOKEN: 'SECRET_AUTH_CANARY'},
    sdkBinaryOptions: {pathToClaudeCodeExecutable: '/pinned/claude'},
    loadSdk,
  };
  return {input, stream, sdk, loadSdk};
}

describe('Claude intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('passes pinned environment and binary to one isolated tool-free SDK query', async () => {
    const {input, stream, sdk} = fixture();
    await expect(runClaudeIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{}', actualModel: 'actual-native-model', finishReason: 'end_turn',
    });
    expect(sdk.query).toHaveBeenCalledTimes(1);
    const sent = sdk.query.mock.calls[0][0];
    expect(sent.prompt).toBe(input.prompt);
    expect(sent.options).toMatchObject({
      env: input.sdkEnv, pathToClaudeCodeExecutable: '/pinned/claude', cwd: '/configured/cwd',
      model: input.config.lightModel, systemPrompt: input.systemPrompt, maxTurns: 1,
      tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: [], skills: [], plugins: [], persistSession: false, permissionMode: 'dontAsk',
    });
    expect(sent.options.env).toBe(input.sdkEnv);
    // Effort is the caller's choice; the transport adds none of its own.
    for (const key of ['resume', 'sessionId', 'allowDangerouslySkipPermissions', 'effort']) {
      expect(sent.options).not.toHaveProperty(key);
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    sent.options.stderr!('SECRET_STDERR_CANARY');
    expect(warn).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {messages: [{type: 'assistant', message: {content: [{type: 'text', text: '{}'}]}}]},
    {messages: [{type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['SECRET_ERROR_CANARY']}]},
    {messages: [{type: 'result', subtype: 'success', is_error: true, result: '{}'}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'max_tokens'}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'refusal'}]},
    {messages: [{type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash'}]}}]},
    {messages: [{type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_use'}}}]},
    {messages: [{type: 'system', subtype: 'model_refusal_fallback'}]},
    {messages: [{type: 'system', subtype: 'model_refusal_no_fallback'}]},
    {messages: [{type: 'result', subtype: 'success', is_error: false, result: '{}', permission_denials: [{tool_name: 'Bash'}]}]},
  ])('rejects drafts, failures, truncation and tools without returning their text %#', async ({messages}) => {
    const {input, stream, sdk} = fixture(messages);
    const result = await runClaudeIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(result).not.toHaveProperty('text');
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_CANARY');
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, {first: {}, second: {}}])('does not label a requested model as actual when usage is ambiguous %#', async modelUsage => {
    const {input} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '{}', modelUsage}]);
    const result = await runClaudeIntentTransport(input);
    expect(result).toMatchObject({status: 'ok'});
    expect(result).not.toHaveProperty('actualModel');
  });

  it.each([
    {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'call-1', content: 'result'}]}},
    {type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'tool_result', tool_use_id: 'call-1'}}},
  ])('rejects structured tool-result blocks before a later successful terminal %#', async firstMessage => {
    const {input, stream} = fixture([
      firstMessage,
      {type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'end_turn'},
    ]);
    await expect(runClaudeIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'tool_use'});
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it.each(['pause_turn', 'model_context_window_exceeded', 'future_reason', ''])('rejects incomplete or unknown terminal stop reason %s', async stopReason => {
    const {input, stream} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: stopReason}]);
    await expect(runClaudeIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_response'});
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined])('accepts an SDK success with a nullable or omitted provider stop reason %#', async stopReason => {
    const {input} = fixture([{
      type: 'result', subtype: 'success', is_error: false, result: '{}',
      ...(stopReason === undefined ? {} : {stop_reason: stopReason}),
    }]);
    await expect(runClaudeIntentTransport(input)).resolves.toEqual({status: 'ok', text: '{}'});
  });

  it('accepts a completed stop sequence while treating protocol words in text as ordinary data', async () => {
    const text = '{"reason":"tool_result describes the schema"}';
    const {input} = fixture([{type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'stop_sequence'}]);
    await expect(runClaudeIntentTransport(input)).resolves.toEqual({status: 'ok', text, finishReason: 'stop_sequence'});
  });

  it('times out, closes once and ignores an uncooperative late terminal message', async () => {
    const {input, stream, sdk} = fixture();
    let resolveNext!: (value: IteratorResult<unknown>) => void;
    sdk.query.mockReturnValue({
      [Symbol.asyncIterator]: () => ({next: () => new Promise(resolve => {resolveNext = resolve;})}),
      close: stream.close,
    });
    const pending = runClaudeIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    expect(sdk.query.mock.calls[0][0].options.abortController?.signal.aborted).toBe(true);
    resolveNext({done: false, value: {type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'end_turn'}});
    await jest.advanceTimersByTimeAsync(0);
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(sdk.query).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation during cleanup and still attempts close only once', async () => {
    const {input, stream, sdk} = fixture();
    let finishClose!: () => void;
    stream.close.mockReturnValue(new Promise<void>(resolve => {finishClose = resolve;}));
    const controller = new AbortController();
    const pending = runClaudeIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError', message: 'Intent classification cancelled'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('SECRET_PARENT_CANARY'));
    finishClose();
    await rejected;
    expect(sdk.query.mock.calls[0][0].options.abortController?.signal.aborted).toBe(true);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after late setup or expose raw SDK exceptions', async () => {
    const {input, sdk, loadSdk} = fixture();
    let resolveLoad!: (value: ClaudeIntentSdk) => void;
    loadSdk.mockReturnValueOnce(new Promise(resolve => {resolveLoad = resolve;}));
    const pending = runClaudeIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveLoad(sdk);
    await jest.advanceTimersByTimeAsync(0);
    expect(sdk.query).not.toHaveBeenCalled();
    sdk.query.mockImplementationOnce(() => {throw new Error('SECRET_SDK_CANARY');});
    await expect(runClaudeIntentTransport({...input, deadlineMs: Date.now() + 50}))
      .resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });

  it('rejects oversized terminal text rather than truncating it into a decision', async () => {
    const {input} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '中文'}]);
    await expect(runClaudeIntentTransport({...input, outputByteLimit: 5}))
      .resolves.toEqual({status: 'unavailable', reason: 'output_limit'});
  });

  it.each([
    ['classification', 'low'], ['review', 'low'], ['declaration_repair', 'low'],
    ['continuation', undefined], ['answer_turn', undefined], [undefined, undefined],
  ] as const)('sends effort for purpose %s as %s', async (purpose, effort) => {
    const {input, sdk} = fixture([{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'end_turn'}]);
    expect(await runClaudeIntentTransport({...input, ...(purpose ? {purpose} : {})})).toMatchObject({status: 'ok'});
    const sent = sdk.query.mock.calls[0][0] as {options: Record<string, unknown>};
    if (effort) expect(sent.options.effort).toBe(effort);
    else expect(sent.options).not.toHaveProperty('effort');
  });

  it.each([
    [{type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529'}, 'provider_error'],
    [{type: 'result', subtype: 'error_during_execution', is_error: true}, 'provider_error'],
    [{type: 'result', subtype: 'success', is_error: false, result: '{}', stop_reason: 'refusal'}, 'invalid_response'],
    [{type: 'result', subtype: 'error_max_turns', is_error: true}, 'invalid_response'],
  ] as const)('reports SDK result %# as its own failure reason', async (message, reason) => {
    const {input} = fixture([message]);
    expect(await runClaudeIntentTransport(input)).toEqual({status: 'unavailable', reason});
  });
});
