// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it, jest} from '@jest/globals';
import {createModelRequestMetricsFetch, measureModelRequestBody} from '../modelRequestMetrics';
import {createRuntimePerformanceRecorder} from '../runtimePerformance';
import {createRuntimePerformanceScope, withModelRequestPurpose} from '../runtimePerformanceContext';

const identity = (runId: string) => ({runId, sessionId: 'session', scope: {tenantId: 'tenant', workspaceId: 'workspace'}});

describe('final fetch request measurement', () => {
  it('separates exact UTF-8 bytes from normalized JSON, including escaping and private content', () => {
    const raw = ' { "messages": [{"role":"user","content":"私有🙂 \\u0061"}], "tools": [] } ';
    const result = measureModelRequestBody(raw);
    expect(result.bodyBytes).toBe(Buffer.byteLength(raw));
    expect(result.normalized?.totalBytes).toBe(Buffer.byteLength(JSON.stringify(JSON.parse(raw))));
    expect(result.bodyBytes).not.toBe(result.normalized?.totalBytes);
    expect(JSON.stringify(result)).not.toContain('私有');
    const bytes = Buffer.from(raw);
    expect(measureModelRequestBody(bytes)).toEqual(result);
    expect(bytes.toString()).toBe(raw);
  });

  it('does not count tool description inside its schema or arguments inside assistant text twice', () => {
    const schema = {type: 'object', properties: {name: {type: 'string', description: 'parameter description'}}};
    const payload = {tools: [{type: 'function', function: {name: 'read', description: 'tool description', parameters: schema}}],
      messages: [{role: 'assistant', content: 'visible', reasoning_content: 'private thought',
        tool_calls: [{type: 'function', function: {name: 'read', arguments: '{"name":"value"}'}}]},
      {role: 'tool', content: '{"result":"data"}'}]};
    const result = measureModelRequestBody(JSON.stringify(payload));
    const components = result.normalized!.components;
    expect(components.toolDescription).toBe(Buffer.byteLength(JSON.stringify('tool description')));
    expect(components.toolSchema).toBe(Buffer.byteLength(JSON.stringify(schema)));
    expect(components.reasoning).toBe(Buffer.byteLength(JSON.stringify('private thought')));
    expect(components.toolArguments).toBe(Buffer.byteLength(JSON.stringify('{"name":"value"}')));
    expect(Object.values(components).reduce((a, b) => a + b, 0)).toBe(result.normalized!.totalBytes);
    expect(JSON.stringify(result)).not.toMatch(/private thought|tool description|parameter description|value/);
  });

  it('keeps unknown, invalid and oversized inputs explicit without reading streams', () => {
    const stream = new ReadableStream({start() {}});
    expect(measureModelRequestBody(stream)).toEqual({status: 'body_unobservable'});
    expect(stream.locked).toBe(false);
    expect(measureModelRequestBody('invalid')).toEqual({status: 'observed', bodyBytes: 7, normalizedUnavailableReason: 'non_json'});
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(measureModelRequestBody(huge)).toEqual({status: 'observed', bodyBytes: huge.length, normalizedUnavailableReason: 'too_large'});
  });

  it('preserves original request/response/signal and never touches either stream', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const controller = new AbortController();
    const input = new Request('https://example.test/chat?secret=PRIVATE', {method: 'POST', body: 'secret body'});
    const response = new Response('private response');
    const requestClone = jest.spyOn(input, 'clone');
    const responseClone = jest.spyOn(response, 'clone');
    const base = jest.fn<typeof fetch>().mockResolvedValue(response);
    const observed = createModelRequestMetricsFetch(base, {source: {runtimePerformanceRecorder: recorder}});
    const init = {signal: controller.signal};
    expect(await observed(input, init)).toBe(response);
    expect(base).toHaveBeenCalledWith(input, init);
    expect(base.mock.calls[0][0]).toBe(input);
    expect(base.mock.calls[0][1]).toBe(init);
    expect(input.bodyUsed).toBe(false);
    expect(response.bodyUsed).toBe(false);
    expect(requestClone).not.toHaveBeenCalled();
    expect(responseClone).not.toHaveBeenCalled();
    const receipt = recorder.seal();
    expect(receipt.modelRequests).toEqual([expect.objectContaining({dispatchOrdinal: 1, fetchOutcome: 'headers',
      httpStatus: 200, body: {status: 'body_unobservable'}})]);
    expect(receipt.modelCalls).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|private|secret|example/);
  });

  it('counts actual retries separately and preserves rejection identity', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const error = new Error('private failure');
    const response = new Response('{}');
    const base = jest.fn<typeof fetch>().mockRejectedValueOnce(error).mockResolvedValueOnce(response);
    const fetcher = createModelRequestMetricsFetch(base, {source: {runtimePerformanceRecorder: recorder}});
    const init = {method: 'POST', body: '{"input":"hello"}'};
    await expect(fetcher('https://provider.invalid', init)).rejects.toBe(error);
    await expect(withModelRequestPurpose({purpose: 'review'}, () => fetcher('https://provider.invalid', init))).resolves.toBe(response);
    const receipt = recorder.seal();
    expect(receipt.modelRequests?.map(item => [item.dispatchOrdinal, item.fetchOutcome, item.purpose]))
      .toEqual([[1, 'error', undefined], [2, 'headers', 'review']]);
    expect(JSON.stringify(receipt)).not.toContain(error.message);
  });

  it('records cancellation without waiting for a pending fetch and freezes late headers after seal', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const controller = new AbortController();
    let complete!: (response: Response) => void;
    const base = jest.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    const fetcher = createModelRequestMetricsFetch(base, {source: {runtimePerformanceRecorder: recorder}});
    const pending = fetcher('https://provider.invalid', {signal: controller.signal, body: '{}'});
    controller.abort();
    const receipt = recorder.seal();
    expect(receipt.modelRequests?.[0].fetchOutcome).toBe('cancelled');
    const response = new Response('{}');
    complete(response);
    expect(await pending).toBe(response);
    expect(recorder.seal()).toBe(receipt);
    expect(receipt.modelRequests?.[0].headersMs).toBeUndefined();
  });

  it('retains pending dispatches and bounds the receipt rather than altering fetch count', async () => {
    const recorder = createRuntimePerformanceRecorder({maxModelRequests: 1});
    const base = jest.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const fetcher = createModelRequestMetricsFetch(base, {source: {runtimePerformanceRecorder: recorder}});
    void fetcher('https://provider.invalid', {body: '{}'});
    void fetcher('https://provider.invalid', {body: '{}'});
    const receipt = recorder.seal();
    expect(base).toHaveBeenCalledTimes(2);
    expect(receipt.modelRequests).toHaveLength(1);
    expect(receipt.modelRequests?.[0].fetchOutcome).toBe('pending');
    expect(receipt.truncated?.modelRequests).toBe(1);
  });

  it('suppresses held callbacks in another run and suppresses observation faults only', async () => {
    const first = createRuntimePerformanceRecorder();
    const second = createRuntimePerformanceRecorder();
    const firstScope = createRuntimePerformanceScope({identity: identity('first'), recorder: first, assertCurrent() {}});
    const secondScope = createRuntimePerformanceScope({identity: identity('second'), recorder: second, assertCurrent() {}});
    const response = new Response('{}');
    const base = jest.fn<typeof fetch>().mockResolvedValue(response);
    const held = firstScope.run(() => createModelRequestMetricsFetch(base));
    expect(await secondScope.run(() => held('https://provider.invalid', {body: '{}'}))).toBe(response);
    expect(first.seal().modelRequests).toBeUndefined();
    expect(second.seal().modelRequests).toBeUndefined();
    const broken = createRuntimePerformanceRecorder();
    jest.spyOn(broken, 'startModelRequest').mockImplementation(() => {throw new Error('private observer fault');});
    expect(await createModelRequestMetricsFetch(base, {source: {runtimePerformanceRecorder: broken}})('https://provider.invalid', {body: '{}'})).toBe(response);
    firstScope.dispose(); secondScope.dispose();
  });
});
