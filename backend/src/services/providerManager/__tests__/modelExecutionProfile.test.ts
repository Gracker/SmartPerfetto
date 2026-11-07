// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {MODEL_EXECUTION_PROFILE_RULESET, resolveModelExecutionProfile,
  type ModelEffectiveSettings, type ResolveModelExecutionProfileInput} from '../modelExecutionProfile';

function config(overrides: Partial<ResolveModelExecutionProfileInput> = {}): ResolveModelExecutionProfileInput {
  return {runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', modelId: 'glm-5.3-flash',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    sdk: {packageName: '@openai/agents', version: '0.13.0', adapterContractVersion: 'openai-chat@1'},
    sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', efforts: ['low', 'high', 'max'],
      reasoningRoundtrip: 'supported', source: 'contract_test'}, effective: {}, ...overrides};
}

describe('model execution profile facts', () => {
  it.each([
    ['glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-json-output-2026-11-07'],
    ['glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', 'glm-json-output-2026-11-07'],
    ['deepseek-flash', 'https://api.deepseek.com/v1', 'deepseek-json-output-2026-11-07'],
    ['deepseek-flash', 'https://api.deepseek.com/v1/chat/completions', 'deepseek-json-output-2026-11-07'],
  ])('records the documented JSON output parameter for the admitted %s endpoint', (modelId, baseUrl, evidenceId) => {
    const profile = resolveModelExecutionProfile(config({modelId, baseUrl}));
    expect(profile.server.jsonOutput).toEqual({status: 'supported', value: 'json_object', source: 'official', evidenceId});
    expect(Object.isFrozen(profile.server.jsonOutput)).toBe(true);
    expect(profile.server).not.toHaveProperty('typedFinalQuality');
  });

  it.each([
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1?extra=1'},
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1?'},
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1#'},
    {modelId: 'deepseek-flash', baseUrl: 'https://PRIVATE_CANARY@api.deepseek.com/v1'},
    {modelId: 'deepseek-flash', baseUrl: 'https://gateway.invalid/v1'},
    {modelId: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1'},
    {modelId: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4'},
    {modelId: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4'},
    {protocol: 'responses' as const},
    {protocol: 'anthropic_messages' as const},
  ])('does not extrapolate JSON controls beyond the exact admitted endpoint: %p', overrides => {
    const profile = resolveModelExecutionProfile(config(overrides));
    expect(profile.server.jsonOutput).toEqual({status: 'unknown', reason: 'unrecognized_endpoint_model_protocol'});
    expect(JSON.stringify(profile)).not.toContain('PRIVATE_CANARY');
  });

  it.each(['deepseek-flash', 'deepseek-v4-pro'].flatMap(modelId => [
    'https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/', 'https://api.deepseek.com/chat/completions',
    'https://api.deepseek.com/v1/chat/completions/', 'https://API.DEEPSEEK.COM:443/v1',
  ].map(baseUrl => ({modelId, baseUrl}))))('records documented Chat output parameters only for $modelId at $baseUrl', input => {
    const profile = resolveModelExecutionProfile(config(input));
    expect(profile.server.outputTokens).toEqual({status: 'supported', source: 'official',
      evidenceId: 'deepseek-chat-completion-max-tokens-2026-11-06', value: {
        parameter: 'max_tokens', range: {minimum: 1, maximum: 393216},
        defaults: {thinkingDisabled: 8192, thinkingEnabled: 65536, thinkingEnabledMaxEffort: 131072},
      }});
    expect(profile.effective).not.toHaveProperty('maxOutputTokens');
    expect(profile.server).not.toHaveProperty('contextSize');
    expect(profile.server).not.toHaveProperty('availableOutputTokens');
    expect(profile.rulesetVersion).toBe('model_execution_profile_rules@5');
  });

  it.each([
    'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1', 'https://gateway.example/v1',
    'https://api.deepseek.com.evil.test/v1', 'https://api.deepseek.com@evil.test/v1',
    'https://user:PRIVATE_CANARY@api.deepseek.com/v1', 'https://@api.deepseek.com/v1',
    'https://api.deepseek.com/v1?credential=PRIVATE_CANARY', 'https://api.deepseek.com/v1#PRIVATE_CANARY',
    'https://api.deepseek.com/v1?', 'https://api.deepseek.com/v1#',
    'https://api.deepseek.com/responses', 'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/beta', 'https://api.deepseek.com/unrecognized', 'https://api.deepseek.com/v1//',
    'not a URL', undefined,
  ])('independently rejects unofficial or decorated output-fact endpoints: %s', baseUrl => {
    const profile = resolveModelExecutionProfile(config({modelId: 'deepseek-flash', baseUrl}));
    expect(profile.server.outputTokens).toEqual({status: 'unknown', reason: 'unrecognized_endpoint_model_protocol'});
    expect(JSON.stringify(profile)).not.toContain('PRIVATE_CANARY');
  });

  it('does not silently tighten the older endpoint-family reasoning facts', () => {
    const profile = resolveModelExecutionProfile(config({modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1?extra=1'}));
    expect(profile.server.thinking).toMatchObject({status: 'supported', value: 'optional'});
    expect(profile.server.outputTokens?.status).toBe('unknown');
  });

  it.each(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner',
    'gateway/deepseek-flash', 'deepseek-flash-next', 'DEEPSEEK-FLASH', ' deepseek-flash ', 'glm-5.3-flash'])(
    'does not extrapolate output parameters to an alias or another model: %s', modelId => {
      expect(resolveModelExecutionProfile(config({modelId, baseUrl: 'https://api.deepseek.com/v1'})).server.outputTokens)
        .toEqual({status: 'unknown', reason: 'unrecognized_endpoint_model_protocol'});
    });

  it.each(['responses', 'anthropic_messages', 'native', 'unknown'] as const)('keeps Chat output facts unknown for %s', protocol => {
    expect(resolveModelExecutionProfile(config({modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', protocol}))
      .server.outputTokens).toEqual({status: 'unknown', reason: 'unrecognized_endpoint_model_protocol'});
  });

  it('keeps GLM and an unknown native model explicitly unknown', () => {
    expect(resolveModelExecutionProfile(config()).server.outputTokens)
      .toEqual({status: 'unknown', reason: 'unrecognized_endpoint_model_protocol'});
    expect(resolveModelExecutionProfile(config({modelId: undefined})).server.outputTokens)
      .toEqual({status: 'unknown', reason: 'native_model_unknown'});
  });

  it('does not turn documented defaults or range into effective settings or a new budget validator', () => {
    const input = config({modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', effective: {
      authoredReasoning: {mode: 'enabled', effort: 'low'}, sdkEffectiveReasoning: {mode: 'disabled'}, maxOutputTokens: 16384,
    }});
    const profile = resolveModelExecutionProfile(input);
    expect(profile.effective).toEqual(input.effective);
    expect(profile).not.toHaveProperty('providerSnapshotHash');
    expect(resolveModelExecutionProfile({...input, effective: {maxOutputTokens: 393217}}).effective.maxOutputTokens).toBe(393217);
    expect(resolveModelExecutionProfile({...input, effective: {maxOutputTokens: undefined}}).effective)
      .not.toHaveProperty('maxOutputTokens');
    const fact = profile.server.outputTokens!;
    if (fact.status !== 'supported') throw new Error('Expected documented output fact');
    for (const value of [fact, fact.value, fact.value.range, fact.value.defaults]) expect(Object.isFrozen(value)).toBe(true);
    expect(resolveModelExecutionProfile(input).fingerprint).toEqual(profile.fingerprint);
  });

  it.each([
    ['glm-5.3-flash', 'https://open.bigmodel.cn/api/coding/paas/v4', 'r5-glm-function-tools'],
    ['deepseek-flash', 'https://api.deepseek.com/v1', 'r5-deepseek-function-tools'],
  ])('records only the observed function primitive for %s, not typed final quality', (modelId, baseUrl, evidencePrefix) => {
    const profile = resolveModelExecutionProfile(config({modelId, baseUrl}));
    expect(profile.server.functionTools).toEqual({status: 'supported', value: 'function_call_arguments',
      source: 'runtime_observation', evidenceId: expect.stringMatching(new RegExp(`^${evidencePrefix}:sha256:[a-f0-9]{64}$`))});
    expect(profile.server).not.toHaveProperty('strictFinal');
    expect(profile.server).not.toHaveProperty('typedFinalQuality');
    expect(profile).not.toHaveProperty('actualFinalSubmission');
  });

  it.each([
    {baseUrl: 'https://api.z.ai/api/coding/paas/v4'},
    {baseUrl: 'https://open.bigmodel.cn/api/paas/v4'},
    {baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'},
    {baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4?credential=PRIVATE_CANARY'},
    {baseUrl: 'http://open.bigmodel.cn/api/coding/paas/v4'},
    {modelId: 'glm-5.3'},
    {modelId: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1'},
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com'},
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', protocol: 'responses' as const},
    {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic_messages' as const},
  ])('does not extrapolate observed tool support to %p', overrides => {
    expect(resolveModelExecutionProfile(config(overrides)).server.functionTools.status).toBe('unknown');
  });

  it('separates required GLM server thinking from what the SDK can encode', () => {
    const profile = resolveModelExecutionProfile(config());
    expect(profile.server).toMatchObject({thinking: {status: 'supported', value: 'required', source: 'official'},
      efforts: {status: 'supported', value: ['low', 'high', 'max']},
      defaultReasoning: {status: 'supported', value: {mode: 'enabled', effort: 'max'}}});
    expect(profile.adapter.thinking).toBe('optional');
    expect(profile.model).toEqual({identity: 'configured', requestedId: 'glm-5.3-flash', revisionEvidence: 'unknown'});
    expect(profile.rulesetVersion).toBe(MODEL_EXECUTION_PROFILE_RULESET);
    expect(profile.fingerprint).toMatchObject({schemaVersion: 'model_execution_fingerprint@1', value: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)});
  });

  it.each(['https://api.z.ai/api/coding/paas/v4', 'https://OPEN.BIGMODEL.CN:443/api/coding/paas/v4/chat/completions'])(
    'recognizes an official Chat endpoint without model rewriting: %s', baseUrl => {
      expect(resolveModelExecutionProfile(config({baseUrl})).server.thinking).toMatchObject({status: 'supported', value: 'required'});
    });

  it.each(['http://open.bigmodel.cn/api/coding/paas/v4', 'https://open.bigmodel.cn:8443/api/coding/paas/v4',
    'https://open.bigmodel.cn.evil.test/api/coding/paas/v4', 'https://evil.test/open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn@evil.test/api/coding/paas/v4', 'blob:https://api.z.ai/opaque',
    'https://user:private@api.z.ai/api/coding/paas/v4', 'https://api.z.ai/unrecognized/endpoint', 'not a URL'])(
    'keeps an unrecognized endpoint unknown: %s', baseUrl => {
      expect(resolveModelExecutionProfile(config({baseUrl})).server.thinking.status).toBe('unknown');
    });

  it.each(['responses', 'anthropic_messages', 'native', 'unknown'] as const)(
    'does not borrow GLM Chat capabilities for %s', protocol => {
      expect(resolveModelExecutionProfile(config({protocol})).server.thinking.status).toBe('unknown');
    });

  it.each(['glm-5.3-flash-next', 'gateway/glm-5.3-flash', 'GLM-5.3-FLASH', ' glm-5.3-flash '])(
    'preserves an exact unrecognized ID rather than matching a substring: %s', modelId => {
      const profile = resolveModelExecutionProfile(config({modelId}));
      expect(profile.model.requestedId).toBe(modelId);
      expect(profile.server.thinking.status).toBe('unknown');
    });

  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])(
    'records the documented revision without changing requested alias %s', modelId => {
      const profile = resolveModelExecutionProfile(config({modelId, baseUrl: 'https://api.deepseek.com/v1'}));
      expect(profile.model).toEqual({identity: 'configured', requestedId: modelId,
        documentedRevision: 'DeepSeek-V4.1-Flash-1017', revisionEvidence: 'documented_alias',
        revisionEvidenceId: 'deepseek-models-pricing-2026-11-05'});
      expect(profile.server.thinking).toMatchObject({status: 'supported', value: 'optional'});
      expect(profile.server.defaultReasoning).toMatchObject({value: {mode: 'enabled', effort: 'high'}});
    });

  it('separates canonical DeepSeek candidate levels from accepted authored spellings and documented mappings', () => {
    const profile = resolveModelExecutionProfile(config({modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com'}));
    expect(profile.server.efforts).toMatchObject({status: 'supported', value: ['low', 'high', 'max']});
    expect(profile.server.effortAliases).toMatchObject({status: 'supported', source: 'official',
      evidenceId: 'deepseek-thinking-mode-2026-11-05', value: [
        {accepted: 'minimal', documented: 'low'}, {accepted: 'medium', documented: 'high'}, {accepted: 'xhigh', documented: 'high'},
      ]});
    expect(resolveModelExecutionProfile(config()).server.effortAliases).toMatchObject({status: 'supported', value: []});
    expect(resolveModelExecutionProfile(config({modelId: 'deepseek-flash', baseUrl: 'https://gateway.example/v1'}))
      .server.effortAliases.status).toBe('unknown');
  });

  it('requires the DeepSeek endpoint and protocol to agree', () => {
    const base = {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic'};
    expect(resolveModelExecutionProfile(config({...base, protocol: 'anthropic_messages'})).server.thinking.status).toBe('supported');
    expect(resolveModelExecutionProfile(config({...base, protocol: 'chat_completions'})).server.thinking.status).toBe('unknown');
    expect(resolveModelExecutionProfile(config({...base, protocol: 'responses'})).server.thinking.status).toBe('unknown');
  });

  it('keeps absent native model identity legal and unknown, but rejects explicitly blank IDs', () => {
    const profile = resolveModelExecutionProfile(config({runtimeKind: 'qoder-agent-sdk', protocol: 'native',
      modelId: undefined, baseUrl: undefined, sdkCapabilities: {surface: 'none', thinking: 'unknown',
        reasoningRoundtrip: 'unknown', source: 'installed_sdk'}}));
    expect(profile.model).toEqual({identity: 'native_default_unknown', revisionEvidence: 'unknown'});
    expect(profile.server.thinking).toEqual({status: 'unknown', reason: 'native_model_unknown'});
    for (const modelId of ['', '  ']) expect(() => resolveModelExecutionProfile(config({modelId})))
      .toThrow('model_execution_invalid_configuration');
  });

  it('retains a Pi SDK/server disagreement rather than copying a second catalog or clamping', () => {
    const profile = resolveModelExecutionProfile(config({runtimeKind: 'pi-agent-core', modelId: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com', sdkCapabilities: {surface: 'pi_stream', thinking: 'optional',
        efforts: ['high', 'max'], nativeDefault: {mode: 'disabled'}, reasoningRoundtrip: 'supported', source: 'installed_sdk'}}));
    expect(profile.server.efforts).toMatchObject({value: ['low', 'high', 'max']});
    expect(profile.adapter.efforts).toEqual(['high', 'max']);
    expect(profile.adapter.nativeDefault).toEqual({mode: 'disabled'});
    expect(profile.effective.sdkEffectiveReasoning).toBeUndefined();
  });
});

describe('independent model execution fingerprint', () => {
  it('fingerprints captured output choices separately from provider snapshots and adoption', () => {
    const assistant = resolveModelExecutionProfile(config({effective: {finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'}}));
    const typed = resolveModelExecutionProfile(config({effective: {finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1'}}));
    const authoring = resolveModelExecutionProfile(config({effective: {finalSubmission: 'assistant_text', declarationSyntax: 'authoring_v2'}}));
    expect(new Set([assistant, typed, authoring].map(profile => profile.fingerprint.value)).size).toBe(3);
    expect(typed.effective).toEqual({finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1'});
    expect(typed).not.toHaveProperty('providerSnapshotHash');
    for (const effective of [{finalSubmission: 'PRIVATE_CANARY'}, {declarationSyntax: 'PRIVATE_CANARY'}]) {
      expect(() => resolveModelExecutionProfile(config({effective: effective as ModelEffectiveSettings})))
        .toThrow('model_execution_invalid_configuration');
    }
  });

  it.each(['maxOutputTokens', 'maxTurns', 'quickMaxTurns', 'quickTargetTurns', 'fullPerTurnMs', 'quickPerTurnMs',
    'fullRequestTimeoutMs', 'streamIdleTimeoutMs', 'maxRunTimeoutMs', 'classifierTimeoutMs', 'maxHistoryBytes'] as const)(
    'includes captured effective %s without changing a provider snapshot contract', key => {
      const first = resolveModelExecutionProfile(config({effective: {[key]: 100}}));
      const changed = resolveModelExecutionProfile(config({effective: {[key]: 101}}));
      expect(changed.fingerprint.value).not.toBe(first.fingerprint.value);
      expect(first).not.toHaveProperty('providerSnapshotHash');
    });

  it('includes model, protocol, endpoint family, SDK/adapter versions and reasoning facts', () => {
    const initial = config();
    const original = resolveModelExecutionProfile(initial);
    const variants = [
      config({modelId: 'glm-5.3'}), config({protocol: 'responses'}),
      config({baseUrl: 'https://open.bigmodel.cn/api/paas/v4'}),
      config({sdk: {...initial.sdk, version: '0.14.0'}}),
      config({sdk: {...initial.sdk, adapterContractVersion: 'openai-chat@2'}}),
      config({sdkCapabilities: {...initial.sdkCapabilities, efforts: ['high', 'max']}}),
      config({effective: {authoredReasoning: {mode: 'enabled', effort: 'high'}}}),
      config({effective: {sdkEffectiveReasoning: {mode: 'disabled'}}}),
    ];
    for (const input of variants) expect(resolveModelExecutionProfile(input).fingerprint.value).not.toBe(original.fingerprint.value);
  });

  it('normalizes capability sets and field order and excludes unknown or secret-bearing properties', () => {
    const initial = config({effective: {maxTurns: 3, maxHistoryBytes: 400}});
    const original = resolveModelExecutionProfile(initial);
    const canary = 'PRIVATE_CONFIG_NOT_IN_RECEIPT';
    const extra = {...initial, apiKey: canary, environment: {OPENAI_API_KEY: canary},
      sdk: {...initial.sdk, headers: {Authorization: canary}},
      sdkCapabilities: {...initial.sdkCapabilities, efforts: ['max', 'low', 'high', 'low'] as const, rawModel: canary},
      effective: {maxHistoryBytes: 400, maxTurns: 3, secret: canary}};
    const projected = resolveModelExecutionProfile(extra);
    expect(projected.fingerprint).toEqual(original.fingerprint);
    expect(JSON.stringify(projected)).not.toContain(canary);
    const withPrivateUrl = resolveModelExecutionProfile(config({baseUrl: `https://api.z.ai/api/paas/v4?credential=${canary}`}));
    expect(JSON.stringify(withPrivateUrl)).not.toContain(canary);
    expect(withPrivateUrl.endpoint.origin).toBe('https://api.z.ai');
  });

  it('copies and freezes nested state without freezing or retaining the caller config', () => {
    const input = config({effective: {authoredReasoning: {mode: 'enabled', effort: 'high'}}});
    const profile = resolveModelExecutionProfile(input);
    const before = JSON.stringify(profile);
    (input.sdkCapabilities.efforts as string[]).push('minimal');
    (input.effective as {maxTurns?: number}).maxTurns = 99;
    expect(JSON.stringify(profile)).toBe(before);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.effective.authoredReasoning)).toBe(true);
    expect(Object.isFrozen(profile.adapter.efforts)).toBe(true);
    expect(Object.isFrozen(input.effective)).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid effective numeric settings without input echo: %s', maxOutputTokens => {
    expect(() => resolveModelExecutionProfile(config({effective: {maxOutputTokens}})))
      .toThrow('model_execution_invalid_configuration');
  });

  it('rejects malformed authored reasoning rather than silently normalizing it', () => {
    for (const setting of [{mode: 'disabled', effort: 'high'}, {mode: 'enabled', effort: 'secret-effort'}]) {
      expect(() => resolveModelExecutionProfile(config({effective: {authoredReasoning: setting} as ModelEffectiveSettings})))
        .toThrow('model_execution_invalid_configuration');
    }
  });
});
