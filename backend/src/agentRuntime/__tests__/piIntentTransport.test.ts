// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {AssistantMessage} from '@earendil-works/pi-ai';
import type {PiAgentCoreProviderRuntime} from '../engines/pi/piAgentCoreProvider';
import {piOutputTokensForByteLimit, runPiIntentTransport, type PiIntentTransportInput} from '../engines/pi/piIntentTransport';

function fixture() {
  const model: PiAgentCoreProviderRuntime['model'] = {
    id: 'pinned-model', name: 'Pinned model', provider: 'pinned-provider', api: 'anthropic-messages',
    baseUrl: 'https://pinned.example', maxTokens: 128, contextWindow: 8192, input: ['text'], reasoning: false,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
  };
  const message: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, timestamp: 1000,
    content: [{type: 'text', text: '{"intent":"focused"}'}], stopReason: 'stop', model: model.id,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
  };
  const result = jest.fn<() => Promise<AssistantMessage>>().mockResolvedValue(message);
  const streamFn = jest.fn<PiAgentCoreProviderRuntime['streamFn']>()
    .mockReturnValue({result} as unknown as ReturnType<PiAgentCoreProviderRuntime['streamFn']>);
  const input: PiIntentTransportInput = {
    prompt: 'current question only', systemPrompt: 'assembled classifier contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024, maxOutputTokens: 256,
    providerRuntime: {model, streamFn},
  };
  return {input, model, message, result, streamFn};
}

describe('Pi intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it('uses the supplied authenticated stream and complete model for one tool-free call', async () => {
    const {input, model, streamFn, result} = fixture();
    await expect(runPiIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{"intent":"focused"}', actualModel: model.id, finishReason: 'stop',
    });
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
    const [sentModel, context, options] = streamFn.mock.calls[0];
    expect(sentModel).toBe(model);
    expect(context).toEqual({
      systemPrompt: input.systemPrompt,
      messages: [{role: 'user', content: input.prompt, timestamp: 1000}], tools: [],
    });
    expect(options).toEqual({
      signal: expect.any(AbortSignal), timeoutMs: 50, maxRetries: 0, maxTokens: 128, cacheRetention: 'none',
    });
    expect(options).not.toHaveProperty('apiKey');
    expect(options).not.toHaveProperty('sessionId');
  });

  it('derives the output cap from the byte limit when no explicit cap is supplied', async () => {
    const {input, model, streamFn} = fixture();
    delete (input as Partial<PiIntentTransportInput>).maxOutputTokens;
    model.maxTokens = 65_536;
    // A provider default cap ended GLM reviews at `length`: 64 KiB -> 16384 tokens * 1.25.
    expect(await runPiIntentTransport({...input, outputByteLimit: 64 * 1024})).toMatchObject({status: 'ok'});
    expect(streamFn.mock.calls[0][0]).toBe(model);
    expect(streamFn.mock.calls[0][2]).toMatchObject({maxTokens: 20_480});
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it('caps the derived output limit at the model cap', () => {
    expect(piOutputTokensForByteLimit(64 * 1024, 8192)).toBe(8192);
    expect(piOutputTokensForByteLimit(1, 8192)).toBe(2);
    expect(piOutputTokensForByteLimit(1024, 65_536)).toBe(320);
  });

  it.each(['classification', 'declaration_repair', 'continuation', 'review'] as const)(
    'selects the pinned %s stream without changing the no-tool budget', async purpose => {
      const {input, streamFn} = fixture();
      const streamFnForPurpose = jest.fn<NonNullable<PiAgentCoreProviderRuntime['streamFnForPurpose']>>()
        .mockReturnValue(streamFn);
      const result = await runPiIntentTransport({...input, purpose,
        providerRuntime: {...input.providerRuntime, streamFnForPurpose}});
      expect(result.status).toBe('ok');
      expect(streamFnForPurpose).toHaveBeenCalledWith(purpose);
      expect(streamFn.mock.calls[0][1].tools).toEqual([]);
      expect(streamFn.mock.calls[0][2]).toMatchObject({maxRetries: 0, maxTokens: 128, timeoutMs: 50});
    });

  it('does not dispatch when the pinned model cannot represent the classification policy', async () => {
    const {input, streamFn} = fixture();
    const result = await runPiIntentTransport({...input, purpose: 'classification',
      providerRuntime: {...input.providerRuntime, streamFnForPurpose: () => {
        throw new Error('UNSUPPORTED_PRIVATE_CONFIGURATION');
      }}});
    expect(result).toEqual({status: 'unavailable', reason: 'invalid_configuration'});
    expect(streamFn).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8192', null])('rejects an explicitly invalid output-token limit %s before dispatch', async value => {
    const {input, streamFn} = fixture();
    input.maxOutputTokens = value as number;
    expect(await runPiIntentTransport(input)).toEqual({status: 'unavailable', reason: 'invalid_configuration'});
    expect(streamFn).not.toHaveBeenCalled();
  });

  it.each(['error', 'aborted', 'length', 'toolUse', 'deferred', 'pending'] as const)('rejects terminal %s', async stopReason => {
    const {input, result, message} = fixture();
    result.mockResolvedValue({...message, stopReason});
    expect(await runPiIntentTransport(input)).toMatchObject({status: 'unavailable'});
  });

  it('rejects tool calls even with a successful finish, and never includes thinking in text', async () => {
    const {input, result, message} = fixture();
    result.mockResolvedValueOnce({...message, content: [{type: 'toolCall', id: 'call-1', name: 'unexpected_tool', arguments: {}}]});
    await expect(runPiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'tool_use'});
    result.mockResolvedValueOnce({...message, content: [
      {type: 'thinking', thinking: 'private reasoning'}, ...message.content,
    ]});
    expect(await runPiIntentTransport(input)).toMatchObject({status: 'ok', text: '{"intent":"focused"}'});
  });

  it('aborts on timeout and does not accept an uncooperative late provider result', async () => {
    const {input, result, streamFn, message} = fixture();
    let resolve!: (value: AssistantMessage) => void;
    result.mockReturnValue(new Promise(done => {resolve = done;}));
    const pending = runPiIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    expect(streamFn.mock.calls[0][2]?.signal?.aborted).toBe(true);
    resolve(message);
    await jest.advanceTimersByTimeAsync(0);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation and keeps provider secrets out of failure results', async () => {
    const {input, result, streamFn} = fixture();
    result.mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = runPiIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError', message: 'Intent classification cancelled'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('SECRET_PARENT_CANARY'));
    await rejected;
    expect(streamFn.mock.calls[0][2]?.signal?.aborted).toBe(true);
    result.mockRejectedValueOnce(new Error('SECRET_PROVIDER_CANARY'));
    await expect(runPiIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'provider_error'});
  });
});
