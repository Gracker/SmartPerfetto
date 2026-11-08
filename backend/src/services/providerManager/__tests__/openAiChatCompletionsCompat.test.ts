// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildOpenAIChatCompletionsTokenLimit,
  resolveOpenAITextRequestPurpose,
  type OpenAITextRequestPurposeInput,
  isOpenAIChatCompletionsOutputTruncated,
  isOfficialGlmOrigin,
  readOpenAIChatCompletionsOutput,
} from '../openAiChatCompletionsCompat';

function purposeInput(input: Pick<OpenAITextRequestPurposeInput, 'requestUrl' | 'protocol'> &
  Partial<OpenAITextRequestPurposeInput>): OpenAITextRequestPurposeInput {
  return {model: 'deepseek-flash', runtimeKind: 'openai-agents-sdk',
    sdkCapabilities: {surface: input.protocol === 'responses' ? 'openai_responses' : 'openai_chat',
      thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      reasoningRoundtrip: 'unknown', source: 'contract_test'}, ...input};
}
const buildOpenAITextRequestPurposeOptions = (input: Parameters<typeof purposeInput>[0]) => resolveOpenAITextRequestPurpose(purposeInput(input)).options;

describe('JSON controls at the actual no-tool dispatch URL', () => {
  it.each([
    ['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'glm-5.3-flash'],
    ['https://api.deepseek.com/v1/chat/completions', 'deepseek-flash'],
  ])('requests JSON only for classification at %s', (url, model) => {
    expect(buildOpenAITextRequestPurposeOptions({requestUrl: new URL(url), protocol: 'chat_completions', model,
      purpose: 'classification'})).toHaveProperty('response_format', {type: 'json_object'});
    expect(buildOpenAITextRequestPurposeOptions({requestUrl: new URL(url), protocol: 'chat_completions', model,
      purpose: 'continuation', outputOnly: true})).not.toHaveProperty('response_format');
    for (const suffix of ['?', '#', '?private=PRIVATE_CANARY', '/unsupported']) {
      const options = buildOpenAITextRequestPurposeOptions({requestUrl: new URL(url + suffix), protocol: 'chat_completions',
        model, purpose: 'classification'});
      expect(options).not.toHaveProperty('response_format');
      expect(JSON.stringify(options)).not.toContain('PRIVATE_CANARY');
    }
  });
});

describe('official DeepSeek delivery protocol options', () => {
  it.each(['https://api.deepseek.com/v1', 'https://API.DEEPSEEK.COM:443/v1'])(
    'uses only the parsed official origin for %s', url => {
      const requestUrl = new URL(url);
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'chat_completions', purpose: 'classification'}))
        .toEqual({thinking: {type: 'disabled'}, response_format: {type: 'json_object'}});
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'responses', purpose: 'classification'}))
        .toEqual({reasoning: {effort: 'none'}});
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'chat_completions', purpose: 'continuation', outputOnly: true}))
        .toEqual({thinking: {type: 'disabled'}});
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'responses', purpose: 'continuation', outputOnly: true}))
        .toEqual({reasoning: {effort: 'none'}});
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'chat_completions'})).toEqual({});
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'responses'})).toEqual({});
    },
  );
  it.each(['http://api.deepseek.com/chat/completions', 'https://api.deepseek.com:8443/chat/completions',
    'https://api.deepseek.com.evil.test/chat/completions', 'https://evil.test/api.deepseek.com/chat/completions',
    'https://gateway.example/v1/chat/completions', 'https://api.deepseek.com@evil.test/chat/completions'])(
    'leaves other endpoints unchanged: %s', url => {
      for (const protocol of ['chat_completions', 'responses'] as const) {
        for (const purpose of ['classification', 'continuation'] as const) expect(buildOpenAITextRequestPurposeOptions({
          requestUrl: new URL(url), protocol, purpose,
        })).toEqual({});
      }
    },
  );
});

describe('official GLM origin boundary', () => {
  it.each(['https://open.bigmodel.cn/api/coding/paas/v4', 'https://api.z.ai/api/paas/v4',
    'https://OPEN.BIGMODEL.CN:443/api/paas/v4', 'https://API.Z.AI:443/api/coding/paas/v4'])(
    'recognizes the exact parsed official origin: %s', url => {
      expect(isOfficialGlmOrigin(url)).toBe(true);
      expect(isOfficialGlmOrigin(new URL(url))).toBe(true);
    });
  it.each(['', 'not a URL', 'http://open.bigmodel.cn/api/paas/v4', 'https://api.z.ai:8443/v4',
    'https://open.bigmodel.cn.evil.test/v4', 'https://evil.test/api.z.ai', 'https://open.bigmodel.cn@evil.test/v4',
    'https://gateway.example/v1?upstream=https://api.z.ai', 'https://api.openai.com/v1', 'blob:https://api.z.ai/opaque'])(
    'rejects other or malformed origins: %s', url => expect(isOfficialGlmOrigin(url)).toBe(false));
});

describe('official GLM delivery protocol options', () => {
  it.each([
    ['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', true],
    ['https://api.z.ai/api/paas/v4/chat/completions', false],
  ] as const)(
    'selects legal enabled low for the candidate delivery purposes on chat completions only on %s', (url, jsonKnown) => {
      const requestUrl = new URL(url);
      for (const purpose of ['classification', 'continuation'] as const) {
        expect(buildOpenAITextRequestPurposeOptions({requestUrl, model: 'glm-5.3-flash', protocol: 'chat_completions', purpose, outputOnly: true}))
          .toEqual({thinking: {type: 'enabled'}, reasoning_effort: 'low',
            ...(jsonKnown && purpose !== 'continuation' ? {response_format: {type: 'json_object'}} : {})});
        expect(buildOpenAITextRequestPurposeOptions({requestUrl, model: 'glm-5.3-flash', protocol: 'responses', purpose, outputOnly: true})).toEqual({});
      }
      expect(buildOpenAITextRequestPurposeOptions({requestUrl, model: 'glm-5.3-flash', protocol: 'chat_completions'})).toEqual({});
    },
  );
  it.each(['https://open.bigmodel.cn.evil.test/v1/chat/completions', 'http://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://gateway.example/open.bigmodel.cn/chat/completions'])('leaves look-alike endpoints unchanged: %s', url => {
    expect(buildOpenAITextRequestPurposeOptions({requestUrl: new URL(url), protocol: 'chat_completions',
      purpose: 'classification'})).toEqual({});
  });
});

describe('model-bound purpose policy metadata', () => {
  const requestUrl = new URL('https://open.bigmodel.cn/api/coding/paas/v4');
  it('uses the selected model, not the origin or the primary/light role name', () => {
    const known = resolveOpenAITextRequestPurpose(purposeInput({requestUrl, protocol: 'chat_completions',
      model: 'glm-5.3-flash', purpose: 'classification'}));
    expect(known.options).toEqual({thinking: {type: 'enabled'}, reasoning_effort: 'low', response_format: {type: 'json_object'}});
    expect(known.policy).toMatchObject({purpose: 'classification', modelId: 'glm-5.3-flash',
      selection: 'minimum_legal_candidate', wireObservation: 'not_observed'});
    expect(known.options).not.toHaveProperty('profile');
    expect(known.options).not.toHaveProperty('policy');
    expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'chat_completions',
      model: 'unknown-model', purpose: 'classification'})).toEqual({});
  });
  it('preserves an ordinary continuation and requires explicit output-only for its candidate', () => {
    expect(buildOpenAITextRequestPurposeOptions({requestUrl, protocol: 'chat_completions',
      model: 'glm-5.3-flash', purpose: 'continuation'})).toEqual({});
  });
  it('preserves legal authored controls and rejects unsupported ones rather than returning empty options', () => {
    const input = purposeInput({requestUrl, protocol: 'chat_completions', model: 'glm-5.3-flash', purpose: 'classification',
      effective: {authoredReasoning: {mode: 'enabled', effort: 'high'}}});
    expect(resolveOpenAITextRequestPurpose(input)).toMatchObject({options: {thinking: {type: 'enabled'}, reasoning_effort: 'high'},
      policy: {reason: 'authored_precedence'}});
    expect(() => resolveOpenAITextRequestPurpose({...input, effective: {authoredReasoning: {mode: 'disabled'}}}))
      .toThrow('openai_text_policy_invalid_configuration');
    expect(() => resolveOpenAITextRequestPurpose({...input, sdkCapabilities: {...input.sdkCapabilities, surface: 'pi_stream'}}))
      .toThrow('openai_text_policy_invalid_configuration');
  });
});

describe('OpenAI Chat Completions token-limit compatibility', () => {
  it.each([
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-sol-2026-07-24',
    'openai/gpt-5.6-sol',
    'accounts/example/models/gpt-5.6-terra-2026-07-24',
  ])('uses max_completion_tokens for %s', model => {
    expect(buildOpenAIChatCompletionsTokenLimit(model, 2048)).toEqual({
      max_completion_tokens: 2048,
    });
  });

  it.each([
    'gpt-5.4-mini',
    'deepseek-v4-pro',
    'qwen3:8b',
  ])('preserves max_tokens for compatible model %s', model => {
    expect(buildOpenAIChatCompletionsTokenLimit(model, 2048)).toEqual({
      max_tokens: 2048,
    });
  });
});

describe('readOpenAIChatCompletionsOutput', () => {
  it('reads content, finish reason, and reasoning usage', () => {
    expect(readOpenAIChatCompletionsOutput({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 42, completion_tokens_details: { reasoning_tokens: 39 } },
    })).toEqual({
      text: 'hi',
      finishReason: 'stop',
      completionTokens: 42,
      reasoningTokens: 39,
    });
  });

  it('normalizes an empty reasoning-only turn to empty text', () => {
    expect(readOpenAIChatCompletionsOutput({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 199 } },
    }).text).toBe('');
  });

  it('omits absent fields instead of inventing zeros', () => {
    expect(readOpenAIChatCompletionsOutput({ choices: [{ message: {} }] }))
      .toEqual({ text: '' });
  });

  it('tolerates a malformed or empty body', () => {
    expect(readOpenAIChatCompletionsOutput(undefined)).toEqual({ text: '' });
    expect(readOpenAIChatCompletionsOutput({ choices: [] })).toEqual({ text: '' });
    expect(readOpenAIChatCompletionsOutput({ choices: [{ message: { content: 7 } }] }))
      .toEqual({ text: '' });
  });
});

describe('isOpenAIChatCompletionsOutputTruncated', () => {
  it('trusts an explicit length finish reason', () => {
    expect(isOpenAIChatCompletionsOutputTruncated(
      { text: '', finishReason: 'length' }, 2048,
    )).toBe(true);
  });

  it('trusts an explicit non-length finish reason over usage', () => {
    expect(isOpenAIChatCompletionsOutputTruncated(
      { text: '', finishReason: 'stop', completionTokens: 2048 }, 2048,
    )).toBe(false);
  });

  it('falls back to usage when the gateway omits finish_reason', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 2048 }, 2048))
      .toBe(true);
    // Providers may bill a token or two below the cap on a truncated turn.
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 2040 }, 2048))
      .toBe(true);
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 400 }, 2048))
      .toBe(false);
  });

  it('reports not-truncated when usage is missing entirely', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '' }, 2048)).toBe(false);
  });

  it('reports not-truncated for a non-positive cap', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 5 }, 0))
      .toBe(false);
  });
});
