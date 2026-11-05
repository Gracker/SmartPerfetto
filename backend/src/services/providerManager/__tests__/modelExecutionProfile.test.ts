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
