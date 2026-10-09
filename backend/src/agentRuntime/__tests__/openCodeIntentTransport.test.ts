// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {runOpenCodeIntentTransport, type OpenCodeClassifierHost, type OpenCodeIntentTransportInput} from '../engines/opencode/openCodeIntentTransport';

type ClassifierSession = OpenCodeClassifierHost['client']['session'];

function fixture() {
  const message = {
    info: {id: 'reply', role: 'assistant', time: {completed: 1000}, modelID: 'pinned-light', finish: 'end_turn'},
    parts: [{type: 'text', text: '{"intent":"focused"}'}],
  };
  const session = {
    create: jest.fn<ClassifierSession['create']>().mockResolvedValue({data: {id: 'classifier-session'}}),
    prompt: jest.fn<ClassifierSession['prompt']>().mockResolvedValue({data: message}),
    messages: jest.fn<ClassifierSession['messages']>()
      .mockResolvedValue({data: [{info: {role: 'user'}}, message]}),
    abort: jest.fn<ClassifierSession['abort']>().mockResolvedValue({data: true}),
    delete: jest.fn<NonNullable<ClassifierSession['delete']>>().mockResolvedValue({data: true}),
  };
  const host = {
    client: {session}, projectDir: '/isolated/classifier', agentName: 'classifier',
    disabledTools: {bash: false, read: false, task: false},
    close: jest.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined),
  };
  const createClassifierHost = jest.fn<OpenCodeIntentTransportInput['createClassifierHost']>().mockResolvedValue(host);
  const input: OpenCodeIntentTransportInput = {
    prompt: 'current question', systemPrompt: 'assembled contract',
    deadlineMs: Date.now() + 50, outputByteLimit: 1024,
    model: {providerID: 'same-provider', modelID: 'pinned-light'}, createClassifierHost,
  };
  return {input, host, session, createClassifierHost, message};
}

describe('OpenCode intent transport', () => {
  beforeEach(() => {jest.useFakeTimers({now: 1000});});
  afterEach(() => {jest.useRealTimers();});

  it('uses one fresh session and synchronous prompt with the host disabled-tool map', async () => {
    const {input, host, session, createClassifierHost} = fixture();
    await expect(runOpenCodeIntentTransport(input)).resolves.toEqual({
      status: 'ok', text: '{"intent":"focused"}', actualModel: 'pinned-light', finishReason: 'end_turn',
    });
    expect(createClassifierHost).toHaveBeenCalledWith({
      model: input.model, deadlineMs: input.deadlineMs, signal: expect.any(AbortSignal),
    });
    expect(session.create).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt.mock.calls[0][0]).toEqual({
      path: {id: 'classifier-session'}, query: {directory: host.projectDir}, signal: expect.any(AbortSignal),
      body: {
        model: input.model, agent: 'classifier', system: input.systemPrompt,
        tools: host.disabledTools, parts: [{type: 'text', text: input.prompt}],
      },
    });
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.delete).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('gives the host the call purpose that selects its provider controls', async () => {
    const {input, createClassifierHost} = fixture();
    await runOpenCodeIntentTransport({...input, purpose: 'classification'});
    expect(createClassifierHost).toHaveBeenCalledWith(expect.objectContaining({purpose: 'classification'}));
  });

  it('rejects a reply from a step after a tool call, which the prompt alone does not show', async () => {
    const {input, session, message} = fixture();
    // OpenCode's last step answers with its own "maximum steps reached" summary.
    session.messages.mockResolvedValue({data: [{info: {role: 'user'}},
      {info: {role: 'assistant', finish: 'tool-calls'}, parts: [{type: 'tool', tool: 'bash'}]}, message]});
    expect(await runOpenCodeIntentTransport(input)).toEqual({status: 'unavailable', reason: 'tool_use'});
  });

  it('rejects a session whose only reply is not the one the prompt returned', async () => {
    const {input, session, message} = fixture();
    session.messages.mockResolvedValue({data: [{info: {role: 'user'}}, {...message, info: {...message.info, id: 'other'}}]});
    expect(await runOpenCodeIntentTransport(input)).toEqual({status: 'unavailable', reason: 'tool_use'});
  });

  it('reads the session in the wrappers the answer session accepts', async () => {
    const {input, session, message} = fixture();
    session.messages.mockResolvedValue({data: {data: [{info: {role: 'user'}}, message], cursor: 'next'}});
    expect(await runOpenCodeIntentTransport(input)).toMatchObject({status: 'ok'});
    session.messages.mockResolvedValue([{info: {role: 'user'}}, message]);
    expect(await runOpenCodeIntentTransport(input)).toMatchObject({status: 'ok'});
  });

  it('rejects a reply whose session cannot be read back', async () => {
    const {input, session} = fixture();
    session.messages.mockResolvedValue({error: {name: 'NotFound'}});
    expect(await runOpenCodeIntentTransport(input)).toEqual({status: 'unavailable', reason: 'invalid_response'});
  });

  it.each(['length', 'error', 'tool-calls'])('rejects explicit finish %s', async finish => {
    const {input, session, message} = fixture();
    session.prompt.mockResolvedValue({data: {...message, info: {...message.info, finish}}});
    expect(await runOpenCodeIntentTransport(input)).toMatchObject({status: 'unavailable'});
  });

  it.each(['tool', 'provider-error', 'unfinished'])('rejects %s and never returns draft text', async kind => {
    const {input, session, message} = fixture();
    session.prompt.mockResolvedValue({data: {
      ...message,
      ...(kind === 'tool' ? {parts: [...message.parts, {type: 'tool', tool: 'bash'}]} : {}),
      info: {
        ...message.info,
        ...(kind === 'provider-error' ? {error: {message: 'SECRET_ERROR_CANARY'}} : {}),
        ...(kind === 'unfinished' ? {time: {created: 1000}} : {}),
      },
    }});
    const result = await runOpenCodeIntentTransport(input);
    expect(result).toMatchObject({status: 'unavailable'});
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_CANARY');
    expect(result).not.toHaveProperty('text');
  });

  it.each([
    ['MessageOutputLengthError', 'incomplete_output'],
    ['APIError', 'provider_error'],
    ['ProviderAuthError', 'provider_error'],
    ['UnknownError', 'provider_error'],
    ['MessageAbortedError', 'invalid_response'],
    [undefined, 'invalid_response'],
  ] as const)('reports a failed reply of error type %s as %s without its text', async (name, reason) => {
    const {input, session, message} = fixture();
    session.prompt.mockResolvedValue({data: {...message,
      info: {...message.info, error: {...(name ? {name} : {}), data: {message: 'SECRET_ERROR_CANARY'}}}}});
    const result = await runOpenCodeIntentTransport(input);
    expect(result).toEqual({status: 'unavailable', reason});
  });

  it('reports a prompt that outlived the local headers timeout as a timeout', async () => {
    const {input, session} = fixture();
    session.prompt.mockRejectedValue(Object.assign(new TypeError('fetch failed'),
      {cause: {name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT'}}));
    expect(await runOpenCodeIntentTransport(input)).toEqual({status: 'unavailable', reason: 'timeout'});
  });

  it('rejects an enabled tool before creating a session and still closes the host', async () => {
    const {input, session, host} = fixture();
    host.disabledTools.bash = true;
    await expect(runOpenCodeIntentTransport(input)).resolves.toEqual({status: 'unavailable', reason: 'invalid_configuration'});
    expect(session.create).not.toHaveBeenCalled();
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('uses an independent abort request and closes once when the parent cancels a prompt', async () => {
    const {input, host, session} = fixture();
    session.prompt.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = runOpenCodeIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(session.prompt.mock.calls[0][0].signal.aborted).toBe(true);
    expect(session.abort).toHaveBeenCalledTimes(1);
    const cleanupSignal = session.abort.mock.calls[0][0].signal;
    expect(cleanupSignal).not.toBe(session.prompt.mock.calls[0][0].signal);
    expect(cleanupSignal.aborted).toBe(false);
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('closes a host that arrives after the startup deadline without dispatching a session', async () => {
    const {input, host, session, createClassifierHost} = fixture();
    let resolveHost!: (value: typeof host) => void;
    createClassifierHost.mockReturnValue(new Promise(resolve => {resolveHost = resolve;}));
    const pending = runOpenCodeIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveHost(host);
    await jest.advanceTimersByTimeAsync(0);
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(session.create).not.toHaveBeenCalled();
  });

  it('cleans a session ID returned after timeout, without prompting or closing the host twice', async () => {
    const {input, host, session} = fixture();
    let resolveSession!: (value: unknown) => void;
    session.create.mockReturnValue(new Promise(resolve => {resolveSession = resolve;}));
    const pending = runOpenCodeIntentTransport(input);
    await jest.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toEqual({status: 'unavailable', reason: 'timeout'});
    resolveSession({data: {id: 'late-classifier-session'}});
    await jest.advanceTimersByTimeAsync(0);
    expect(session.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'late-classifier-session'}}));
    expect(session.delete).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'late-classifier-session'}}));
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('propagates a cancellation during cleanup and attempts close even when abort hangs', async () => {
    const {input, host, session} = fixture();
    host.close.mockReturnValue(new Promise(() => undefined));
    session.abort.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = runOpenCodeIntentTransport({...input, signal: controller.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    await jest.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });
});
