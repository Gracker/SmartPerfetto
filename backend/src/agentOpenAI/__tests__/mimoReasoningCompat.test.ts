// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import {OpenAIChatCompletionsModel, withTrace} from '@openai/agents';
import OpenAI from 'openai';
import {
  createMimoReasoningContentFetch,
  normalizeMimoChatCompletionPayload,
  normalizeMimoChatRequestPayload,
  normalizeMimoSseText,
  shouldUseMimoReasoningContentCompat,
} from '../mimoReasoningCompat';

describe('reasoning_content compatibility', () => {
  it('enables only for supported chat-completions providers', () => {
    expect(shouldUseMimoReasoningContentCompat({
      protocol: 'chat_completions',
      baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
      model: 'mimo-v2.5-pro',
      lightModel: 'mimo-v2.5-pro',
    })).toBe(true);

    expect(shouldUseMimoReasoningContentCompat({
      protocol: 'chat_completions',
      baseURL: 'https://compatible.example/v1',
      model: 'mimo-v2.5',
      lightModel: 'mimo-v2.5',
    })).toBe(true);

    expect(shouldUseMimoReasoningContentCompat({
      protocol: 'chat_completions',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
      lightModel: 'deepseek-v4-flash',
    })).toBe(true);

    expect(shouldUseMimoReasoningContentCompat({
      protocol: 'responses',
      baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
      model: 'mimo-v2.5-pro',
      lightModel: 'mimo-v2.5-pro',
    })).toBe(false);

    expect(shouldUseMimoReasoningContentCompat({
      protocol: 'chat_completions',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      lightModel: 'gpt-5.4-mini',
    })).toBe(false);
  });

  it.each(['https://open.bigmodel.cn/api/coding/paas/v4', 'https://api.z.ai/api/paas/v4'])(
    'enables official GLM only on chat completions: %s', baseURL => {
      const config = {baseURL, model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'};
      expect(shouldUseMimoReasoningContentCompat({...config, protocol: 'chat_completions'})).toBe(true);
      expect(shouldUseMimoReasoningContentCompat({...config, protocol: 'responses'})).toBe(false);
    });

  it.each(['https://gateway.example/v1', 'https://open.bigmodel.cn.evil.test/v4',
    'https://evil.test/api.z.ai', 'http://open.bigmodel.cn/v4', 'https://api.z.ai:8443/v4', 'blob:https://api.z.ai/opaque', 'invalid'])(
    'does not enable GLM compatibility from a model name or look-alike endpoint: %s', baseURL => {
      expect(shouldUseMimoReasoningContentCompat({baseURL, protocol: 'chat_completions',
        model: 'glm-5.3-flash', lightModel: 'glm-5.3-flash'})).toBe(false);
    });

  it('logs only the HTTP status when an error response echoes private content', async () => {
    const canary = 'PRIVATE_GLM_ERROR_ECHO_7612';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = JSON.stringify({error: {message: canary}});
    const baseFetch = jest.fn<typeof fetch>(async () => new Response(error, {
      status: 400, statusText: canary, headers: {'content-type': 'application/json'},
    }));
    try {
      const response = await createMimoReasoningContentFetch(baseFetch)(
        'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', {
          method: 'POST', body: JSON.stringify({model: canary, messages: [{role: 'user', content: canary}]}),
        });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(error); // Preserve the SDK's error handling; only the diagnostic is projected.
      expect(warn.mock.calls).toEqual([['[ReasoningContentCompat] Chat completions request failed', {status: 400}]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    } finally {warn.mockRestore();}
  });

  it('preserves GLM non-streamed reasoning as private native SDK content', async () => {
    const reasoning = '私有推理完整原文：PRIVATE_GLM_REASONING_JSON；结束。';
    const baseFetch = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'glm-json', object: 'chat.completion', created: 1, model: 'glm-5.3-flash',
      choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: '公开回答', reasoning_content: reasoning}}],
    }), {headers: {'content-type': 'application/json'}}));
    const client = new OpenAI({apiKey: 'test-only', baseURL: 'https://api.z.ai/api/paas/v4',
      fetch: createMimoReasoningContentFetch(baseFetch), maxRetries: 0});
    const model = new OpenAIChatCompletionsModel(client, 'glm-5.3-flash');
    const response = await withTrace('GLM private reasoning compatibility', () => model.getResponse({
      input: [{role: 'user', content: '问题'}], systemInstructions: '', modelSettings: {},
      tools: [], handoffs: [], outputType: 'text', tracing: false} as any));
    expect(response.output.find(item => item.type === 'reasoning')).toMatchObject({content: [],
      rawContent: [{type: 'reasoning_text', text: reasoning}]});
    expect(response.output.flatMap(item => item.type === 'message' && item.role === 'assistant'
      ? item.content.flatMap(part => part.type === 'output_text' ? [part.text] : []) : [])).toEqual(['公开回答']);
  });

  it('converts SDK reasoning history back to MiMo reasoning_content', () => {
    const payload: any = {
      model: 'mimo-v2.5-pro',
      messages: [
        {
          role: 'assistant',
          content: null,
          reasoning: 'Need SQL evidence before answering.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute_sql', arguments: '{}' } }],
        },
      ],
    };

    expect(normalizeMimoChatRequestPayload(payload)).toBe(true);
    expect(payload.messages[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'Need SQL evidence before answering.',
    });
    expect(payload.messages[0]).not.toHaveProperty('reasoning');
  });

  it('folds split SDK assistant reasoning/content into the tool-call message', () => {
    const payload: any = {
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: 'Analyze startup.' },
        {
          role: 'assistant',
          content: null,
          reasoning: 'Need a plan before tool calls.',
        },
        {
          role: 'assistant',
          content: 'I will submit the analysis plan.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_plan', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"success":true}',
        },
      ],
    };

    expect(normalizeMimoChatRequestPayload(payload)).toBe(true);
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'I will submit the analysis plan.',
      reasoning_content: 'Need a plan before tool calls.',
      tool_calls: [{ id: 'call_1' }],
    });
    expect(payload.messages[1]).not.toHaveProperty('reasoning');
    expect(payload.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('removes only a closed-shape SDK reasoning-only message from the wire', async () => {
    const history: any[] = [
      {role: 'user', content: 'Inspect the selected interval.'},
      {type: 'function_call', callId: 'call_1', name: 'execute_sql', arguments: '{}'},
      {type: 'function_call_result', callId: 'call_1', output: '{"ok":true}'},
      {
        type: 'reasoning',
        content: [],
        rawContent: [{type: 'reasoning_text', text: 'Need a bounded final answer.'}],
      },
      {role: 'user', content: 'Complete the final answer.'},
    ];
    const originalHistory = structuredClone(history);
    let captured: any;
    const baseFetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = input instanceof Request ? await input.clone().text() : init?.body;
      captured = JSON.parse(String(body));
      return new Response(JSON.stringify({
        id: 'chatcmpl-reasoning-history',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {role: 'assistant', content: 'Complete.'},
        }],
        created: 0,
        model: 'deepseek-flash',
        object: 'chat.completion',
      }), {headers: {'content-type': 'application/json'}});
    });
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com/v1',
      fetch: createMimoReasoningContentFetch(baseFetch as any) as any,
    });
    const model = new OpenAIChatCompletionsModel(client, 'deepseek-flash');

    await withTrace('MiMo reasoning-only wire normalization test', async () => {
      await model.getResponse({
        input: history,
        systemInstructions: '',
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: 'text',
        tracing: false,
      } as any);
    });

    expect(history).toEqual(originalHistory);
    expect(captured.messages).toEqual([
      {role: 'user', content: 'Inspect the selected interval.'},
      expect.objectContaining({
        role: 'assistant',
        content: null,
        tool_calls: [expect.objectContaining({id: 'call_1'})],
      }),
      {role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}'},
      {role: 'user', content: 'Complete the final answer.'},
    ]);
  });

  it('also removes the closed SDK shape with explicit empty tool_calls', () => {
    const payload = {messages: [{
      role: 'assistant',
      content: null,
      reasoning_content: 'Need more evidence.',
      tool_calls: [],
    }]};

    expect(normalizeMimoChatRequestPayload(payload)).toBe(true);
    expect(payload.messages).toEqual([]);
  });

  it.each([
    ['refusal', {refusal: 'Cannot comply'}],
    ['audio', {audio: {id: 'audio_1'}}],
    ['name', {name: 'assistant-name'}],
    ['tool call id', {tool_call_id: 'call_1'}],
    ['unknown field', {provider_extension: 'preserve-me'}],
    ['non-empty content', {content: 'Visible answer'}],
    ['array content', {content: []}],
    ['tool calls', {tool_calls: [{id: 'call_1'}]}],
  ] as const)('preserves a reasoning assistant with %s', (_label, extra) => {
    const message = {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need more evidence.',
      ...extra,
    };
    const payload = {messages: [message]};

    expect(normalizeMimoChatRequestPayload(payload)).toBe(false);
    expect(payload.messages).toEqual([message]);
  });

  it('maps MiMo reasoning_content responses into SDK reasoning', () => {
    const payload: any = {
      choices: [
        {
          delta: {
            reasoning_content: 'I should inspect the thread slices.',
            tool_calls: [],
          },
        },
      ],
    };

    expect(normalizeMimoChatCompletionPayload(payload)).toBe(true);
    expect(payload.choices[0].delta.reasoning).toBe('I should inspect the thread slices.');
  });

  it('normalizes streaming SSE data lines', () => {
    const input = [
      'data: {"choices":[{"delta":{"reasoning_content":"think","tool_calls":[]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const normalized = normalizeMimoSseText(input);

    expect(normalized).toContain('"reasoning_content":"think"');
    expect(normalized).toContain('"reasoning":"think"');
    expect(normalized).toContain('data: [DONE]');
  });

  it('converts reasoning history when the SDK passes a Request object', async () => {
    let captured: any;
    const baseFetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = input instanceof Request
        ? await input.clone().text()
        : init?.body;
      captured = JSON.parse(String(body));
      return new Response(JSON.stringify({ choices: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const fetch = createMimoReasoningContentFetch(baseFetch as any);
    const request = new Request('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5-pro',
        messages: [
          {
            role: 'assistant',
            content: null,
            reasoning: 'Need SQL evidence before answering.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute_sql', arguments: '{}' } }],
          },
        ],
      }),
    });

    await fetch(request);

    expect(captured.messages[0].reasoning_content).toBe('Need SQL evidence before answering.');
    expect(captured.messages[0]).not.toHaveProperty('reasoning');
  });

  it('converts reasoning history when fetch init body is binary encoded JSON', async () => {
    let captured: any;
    const baseFetch = jest.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const fetch = createMimoReasoningContentFetch(baseFetch as any);

    await fetch('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'mimo-v2.5-pro',
        messages: [
          {
            role: 'assistant',
            content: null,
            reasoning: 'Need SQL evidence before answering.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'execute_sql', arguments: '{}' } }],
          },
        ],
      })),
    });

    expect(captured.messages[0].reasoning_content).toBe('Need SQL evidence before answering.');
    expect(captured.messages[0]).not.toHaveProperty('reasoning');
  });
});
