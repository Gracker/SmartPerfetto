// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
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
