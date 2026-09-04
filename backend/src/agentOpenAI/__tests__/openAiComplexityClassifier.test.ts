// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CLASSIFIER_OUTPUT_TOKENS,
  CLASSIFIER_RETRY_OUTPUT_TOKENS,
  buildChatCompletionsUrl,
  classifyQueryWithOpenAILightModel,
} from '../openAiComplexityClassifier';

type FetchArgs = { input: URL | string; init?: RequestInit };

function installFetchMock(impl: (args: FetchArgs) => Promise<Response>): jest.Mock {
  const mock = jest.fn(async (input: URL | string, init?: RequestInit) => impl({ input, init }));
  (globalThis as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;
  return mock as unknown as jest.Mock;
}

const baseConfig = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-test-key',
  lightModel: 'gpt-5.4-mini',
  classifierTimeoutMs: 5_000,
};

describe('buildChatCompletionsUrl', () => {
  it('appends /chat/completions to a baseURL without trailing slash', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1').toString())
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('handles trailing slash without producing a double slash', () => {
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/').toString())
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('preserves Azure-style custom path prefixes', () => {
    expect(buildChatCompletionsUrl('https://x.openai.azure.com/openai/deployments/gpt/').toString())
      .toBe('https://x.openai.azure.com/openai/deployments/gpt/chat/completions');
  });
});

describe('classifyQueryWithOpenAILightModel', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    jest.useRealTimers();
  });

  it('parses a normal JSON response into quick complexity', async () => {
    installFetchMock(async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"complexity":"quick","reason":"simple lookup"}' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await classifyQueryWithOpenAILightModel('trace 时长?', baseConfig);
    expect(result.complexity).toBe('quick');
    expect(result.reason).toBe('simple lookup');
  });

  it('falls back to full when the response has no parseable JSON', async () => {
    installFetchMock(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'no json here at all' } }] }),
      { status: 200 },
    ));

    const result = await classifyQueryWithOpenAILightModel('q', baseConfig);
    expect(result.complexity).toBe('full');
    expect(result.reason).toContain('no JSON');
  });

  it('falls back to full on HTTP non-200', async () => {
    installFetchMock(async () => new Response('forbidden', { status: 403 }));

    const result = await classifyQueryWithOpenAILightModel('q', baseConfig);
    expect(result.complexity).toBe('full');
    expect(result.reason).toContain('HTTP 403');
  });

  it('falls back to full when fetch is aborted by the configured timeout', async () => {
    installFetchMock(async ({ init }) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));

    const result = await classifyQueryWithOpenAILightModel('q', { ...baseConfig, classifierTimeoutMs: 5 });
    expect(result.complexity).toBe('full');
    expect(result.reason).toContain('timed out');
  });

  it('propagates cancellation from the owning analysis', async () => {
    installFetchMock(async ({ init }) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        const error = new Error('caller aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const analysis = new AbortController();

    const classification = classifyQueryWithOpenAILightModel('q', baseConfig, analysis.signal);
    analysis.abort();

    await expect(classification).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('falls back to full when baseURL is missing without making any HTTP call', async () => {
    const fetchMock = installFetchMock(async () => new Response('{}', { status: 200 }));

    const result = await classifyQueryWithOpenAILightModel('q', { ...baseConfig, baseURL: '' });
    expect(result.complexity).toBe('full');
    expect(result.reason).toBe('OpenAI baseURL missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends model + Authorization + chat-completions URL correctly', async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let capturedBody: {
      model?: string;
      messages?: unknown[];
      max_tokens?: number;
      max_completion_tokens?: number;
    } | undefined;

    installFetchMock(async ({ input, init }) => {
      capturedUrl = (input as URL).toString();
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.Authorization;
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"complexity":"full","reason":"x"}' } }] }),
        { status: 200 },
      );
    });

    await classifyQueryWithOpenAILightModel('hello', baseConfig);
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(capturedAuth).toBe('Bearer sk-test-key');
    expect(capturedBody?.model).toBe('gpt-5.4-mini');
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect(capturedBody?.max_tokens).toBe(CLASSIFIER_OUTPUT_TOKENS);
    expect(capturedBody?.max_completion_tokens).toBeUndefined();
  });

  it('uses max_completion_tokens for a GPT-5.6 light model', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    installFetchMock(async ({ init }) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"complexity":"quick","reason":"x"}' } }] }),
        { status: 200 },
      );
    });

    await classifyQueryWithOpenAILightModel('hello', {
      ...baseConfig,
      lightModel: 'openai/gpt-5.6-sol',
    });

    expect(capturedBody?.max_completion_tokens).toBe(CLASSIFIER_OUTPUT_TOKENS);
    expect(capturedBody).not.toHaveProperty('max_tokens');
  });

  it('sends structured classifier context in the prompt', async () => {
    let capturedBody: { messages?: Array<{ content?: string }> } | undefined;
    const longPreviousQuery = `${'x'.repeat(260)}TAIL_SHOULD_BE_CUT`;

    installFetchMock(async ({ init }) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"complexity":"quick","reason":"bounded"}' } }] }),
        { status: 200 },
      );
    });

    await classifyQueryWithOpenAILightModel({
      query: '上面 rcustomscroller 这个线程的核心摆放和 running 时候对应的频率是多少',
      sceneType: 'general',
      hasSelectionContext: false,
      hasReferenceTrace: false,
      hasExistingFindings: true,
      hasPriorFullAnalysis: true,
      previousQueries: [
        '找到 Trace 里面 running time 排名前十的线程，从大到小排序',
        longPreviousQuery,
      ],
      previousFindings: ['rcustomscroller high running time | category=scheduling | severity=medium'],
    }, baseConfig);

    const prompt = capturedBody?.messages?.[0]?.content ?? '';
    expect(prompt).toContain('sceneType: general');
    expect(prompt).toContain('hasPriorFullAnalysis: true');
    expect(prompt).toContain('找到 Trace 里面 running time 排名前十的线程');
    expect(prompt).not.toContain('TAIL_SHOULD_BE_CUT');
    expect(prompt).toContain('rcustomscroller');
    expect(prompt).toContain('previousFindings:');
    expect(prompt).toContain('rcustomscroller high running time');
  });

  it('omits Authorization header when no apiKey is configured', async () => {
    let capturedAuth: string | undefined;
    installFetchMock(async ({ init }) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"complexity":"quick","reason":"x"}' } }] }),
        { status: 200 },
      );
    });

    await classifyQueryWithOpenAILightModel('q', { ...baseConfig, apiKey: undefined });
    expect(capturedAuth).toBeUndefined();
  });

  describe('reasoning-model output budget', () => {
    function truncatedEmptyBody(reasoningTokens: number, completionTokens: number) {
      return JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: {
          completion_tokens: completionTokens,
          completion_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      });
    }

    it('retries at a larger budget when reasoning tokens exhausted the first one', async () => {
      const budgets: number[] = [];
      const fetchMock = installFetchMock(async ({ init }) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
        budgets.push(body.max_tokens ?? -1);
        if (budgets.length === 1) {
          return new Response(truncatedEmptyBody(2047, 2048), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"complexity":"quick","reason":"bounded entity lookup"}' }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        );
      });

      const result = await classifyQueryWithOpenAILightModel('why is this one frame slow?', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(budgets).toEqual([CLASSIFIER_OUTPUT_TOKENS, CLASSIFIER_RETRY_OUTPUT_TOKENS]);
      expect(result.complexity).toBe('quick');
      // The model's own verdict must survive; starvation is transport diagnostics.
      expect(result.reason).toBe('bounded entity lookup');
    });

    it('keeps a parseable verdict without retrying even when the cap was hit', async () => {
      const fetchMock = installFetchMock(async () => new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"complexity":"quick","reason":"still valid"}' }, finish_reason: 'length' }],
          usage: { completion_tokens: 2048 },
        }),
        { status: 200 },
      ));

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ complexity: 'quick', reason: 'still valid' });
    });

    it('detects exhaustion from usage alone when the gateway omits finish_reason', async () => {
      const fetchMock = installFetchMock(async ({ init }) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
        if (body.max_tokens === CLASSIFIER_OUTPUT_TOKENS) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '' } }],
              usage: { completion_tokens: 2048 },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"complexity":"full","reason":"scene wide"}' } }] }),
          { status: 200 },
        );
      });

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.complexity).toBe('full');
      expect(result.reason).toBe('scene wide');
    });

    it('does not retry a plain unparseable answer that did not hit the cap', async () => {
      const fetchMock = installFetchMock(async () => new Response(
        JSON.stringify({
          choices: [{ message: { content: 'no json here at all' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 12 },
        }),
        { status: 200 },
      ));

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        complexity: 'full',
        reason: 'no JSON in OpenAI response',
        degraded: true,
      });
    });

    it('does not retry when usage is missing and no finish_reason is reported', async () => {
      const fetchMock = installFetchMock(async () => new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }] }),
        { status: 200 },
      ));

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.complexity).toBe('full');
      expect(result.reason).toContain('empty OpenAI classifier response');
    });

    it('reports the exhausted budget when the retry is truncated too', async () => {
      const fetchMock = installFetchMock(async () => new Response(
        truncatedEmptyBody(6143, 6144),
        { status: 200 },
      ));

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.complexity).toBe('full');
      expect(result.reason).toContain(String(CLASSIFIER_RETRY_OUTPUT_TOKENS));
      expect(result.reason).toContain('reasoning tokens');
    });

    it('falls back on the retry HTTP failure rather than making a third request', async () => {
      let calls = 0;
      const fetchMock = installFetchMock(async () => {
        calls += 1;
        if (calls === 1) return new Response(truncatedEmptyBody(2047, 2048), { status: 200 });
        return new Response('server error', { status: 500 });
      });

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.reason).toContain('HTTP 500');
    });

    it('skips the retry when the first request consumed most of the deadline', async () => {
      // Deadline comfortably exceeds the retry floor, so only the elapsed time
      // of the first request can make the retry unaffordable.
      const fetchMock = installFetchMock(async () => {
        await new Promise(resolve => setTimeout(resolve, 700));
        return new Response(truncatedEmptyBody(2047, 2048), { status: 200 });
      });

      const result = await classifyQueryWithOpenAILightModel('q', {
        ...baseConfig,
        classifierTimeoutMs: 2_500,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.complexity).toBe('full');
      expect(result.reason).toContain(String(CLASSIFIER_OUTPUT_TOKENS));
    });

    it('aborts a started retry on the original deadline instead of restarting it', async () => {
      let calls = 0;
      const fetchMock = installFetchMock(async ({ init }) => {
        calls += 1;
        if (calls === 1) return new Response(truncatedEmptyBody(2047, 2048), { status: 200 });
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const started = Date.now();
      const result = await classifyQueryWithOpenAILightModel('q', {
        ...baseConfig,
        classifierTimeoutMs: 2_600,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.complexity).toBe('full');
      expect(result.reason).toContain('timed out after 2.6s');
      // The retry must share the original deadline, not restart it.
      expect(Date.now() - started).toBeLessThan(2_600 * 2);
    });

    it('keeps the malformed-JSON diagnosis distinct from a missing one', async () => {
      const fetchMock = installFetchMock(async () => new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"complexity": quick,}' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 14 },
        }),
        { status: 200 },
      ));

      const result = await classifyQueryWithOpenAILightModel('q', baseConfig);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        complexity: 'full',
        reason: 'failed to parse OpenAI JSON response',
        degraded: true,
      });
    });
  });

  describe('a failed classification is reported as a fallback, not a verdict', () => {
    it('marks HTTP, timeout, and truncation fallbacks as degraded', async () => {
      installFetchMock(async () => new Response('nope', { status: 500 }));
      const http = await classifyQueryWithOpenAILightModel('q', baseConfig);
      expect(http).toMatchObject({ complexity: 'full', degraded: true });

      installFetchMock(async () => new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: {completion_tokens: 6144, completion_tokens_details: {reasoning_tokens: 6143}},
        }),
        { status: 200 },
      ));
      const starved = await classifyQueryWithOpenAILightModel('q', baseConfig);
      expect(starved).toMatchObject({ complexity: 'full', degraded: true });
    });

    it('does not mark a real verdict as degraded', async () => {
      installFetchMock(async () => new Response(
        JSON.stringify({choices: [{message: {content: '{"complexity":"full","reason":"scene wide"}'}}]}),
        { status: 200 },
      ));
      const verdict = await classifyQueryWithOpenAILightModel('分析滑动性能', baseConfig);
      expect(verdict.complexity).toBe('full');
      expect(verdict).not.toHaveProperty('degraded');
    });
  });
});