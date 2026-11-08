// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveModelExecutionProfile, type ResolveModelExecutionProfileInput} from '../../services/providerManager/modelExecutionProfile';
import {resolveModelExecutionPolicy, type ResolveModelExecutionPolicyInput} from '../modelExecutionPolicy';

function profile(overrides: Partial<ResolveModelExecutionProfileInput> = {}) {
  return resolveModelExecutionProfile({runtimeKind: 'openai-agents-sdk', protocol: 'chat_completions', modelId: 'glm-5.3-flash',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    sdk: {packageName: 'test-sdk', version: '1', adapterContractVersion: 'test-adapter@1'},
    sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', efforts: ['low', 'high', 'max'],
      reasoningRoundtrip: 'supported', source: 'contract_test'}, effective: {}, ...overrides});
}
function policy(target = profile(), overrides: Partial<Omit<ResolveModelExecutionPolicyInput, 'profile'>> = {}) {
  return resolveModelExecutionPolicy({profile: target, purpose: 'classification', selection: 'minimum_legal_candidate', ...overrides});
}
const deepseek = {modelId: 'deepseek-flash', baseUrl: 'https://api.deepseek.com'};

describe('explicit model execution policy', () => {
  it.each([undefined, 16384])('keeps documented output defaults descriptive with authored maxOutputTokens=%s', maxOutputTokens => {
    const target = profile({...deepseek, effective: {
      authoredReasoning: {mode: 'enabled', effort: 'low'}, sdkEffectiveReasoning: {mode: 'enabled', effort: 'high'},
      ...(maxOutputTokens !== undefined ? {maxOutputTokens} : {}),
    }});
    const {outputTokens, ...legacyServer} = target.server;
    expect(outputTokens?.status).toBe('supported');
    for (const selection of ['preserve', 'minimum_legal_candidate'] as const) {
      const result = policy(target, {purpose: 'review', selection});
      expect(result).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {
        outcome: 'preserved', authored: {mode: 'enabled', effort: 'low'}, sdkEffective: {mode: 'enabled', effort: 'high'},
        mapped: 'unchanged', wireObservation: 'not_observed',
      }});
      expect(policy({...target, server: legacyServer}, {purpose: 'review', selection})).toEqual(result);
      if (result.status === 'ready') expect(result.controls).toEqual({surface: 'none'});
    }
    if (maxOutputTokens === undefined) expect(target.effective).not.toHaveProperty('maxOutputTokens');
    else expect(target.effective.maxOutputTokens).toBe(maxOutputTokens);
  });

  it.each(['classification', 'review', 'answer_turn', 'continuation'] as const)(
    'preserves native configuration for %s unless a candidate was explicitly selected', purpose => {
      expect(policy(profile(), {purpose, selection: 'preserve'})).toMatchObject({status: 'ready', controls: {surface: 'none'},
        receipt: {outcome: 'preserved', mapped: 'unchanged', authored: 'absent', sdkEffective: 'unknown', wireObservation: 'not_observed'}});
    });

  it.each(['classification', 'review'] as const)(
    'maps explicit GLM %s candidate to enabled low, never off or a claimed observed wire setting', purpose => {
      expect(policy(profile(), {purpose})).toMatchObject({status: 'ready',
        controls: {surface: 'openai_chat', thinking: {type: 'enabled'}, reasoning_effort: 'low'},
        receipt: {selection: 'minimum_legal_candidate', outcome: 'candidate_applied',
          mapped: {mode: 'enabled', effort: 'low'}, wireObservation: 'not_observed'}});
    });

  it('uses disabled only when both DeepSeek and the adapter can express it', () => {
    const target = profile(deepseek);
    const result = policy(target);
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'openai_chat', thinking: {type: 'disabled'}},
      receipt: {modelId: 'deepseek-flash', executionFingerprint: target.fingerprint, mapped: {mode: 'disabled'}}});
    if (result.status === 'ready') expect(result.controls).not.toHaveProperty('reasoning_effort');
  });

  it.each(['answer_turn', 'continuation'] as const)('refuses an effort candidate on ordinary %s', purpose => {
    expect(policy(profile(), {purpose})).toMatchObject({status: 'unsupported', reason: 'candidate_stage_not_allowed'});
  });

  it('requires explicit output-only continuation for a bounded candidate', () => {
    expect(policy(profile(), {purpose: 'continuation', outputOnly: true})).toMatchObject({status: 'ready',
      controls: {thinking: {type: 'enabled'}, reasoning_effort: 'low'}});
    expect(policy(profile(), {purpose: 'answer_turn', outputOnly: true})).toMatchObject({status: 'unsupported', reason: 'candidate_stage_not_allowed'});
  });

  it('preserves known legal authored reasoning ahead of the candidate and keeps SDK-effective distinct', () => {
    const result = policy(profile({effective: {authoredReasoning: {mode: 'enabled', effort: 'max'},
      sdkEffectiveReasoning: {mode: 'enabled', effort: 'max'}}}));
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {outcome: 'preserved',
      reason: 'authored_precedence', authored: {mode: 'enabled', effort: 'max'}, sdkEffective: {mode: 'enabled', effort: 'max'}, mapped: 'unchanged'}});
  });

  it.each(['preserve', 'minimum_legal_candidate'] as const)('rejects explicit unsupported GLM settings even for %s', selection => {
    expect(policy(profile({effective: {authoredReasoning: {mode: 'disabled'}}}), {selection}))
      .toMatchObject({status: 'unsupported', reason: 'unsupported_authored_mode'});
    expect(policy(profile({effective: {authoredReasoning: {mode: 'enabled', effort: 'medium'}}}), {selection}))
      .toMatchObject({status: 'unsupported', reason: 'unsupported_authored_effort'});
  });

  it.each([['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high']] as const)(
    'preserves legal DeepSeek authored %s and separately records documented %s', (effort, documented) => {
      const target = profile({...deepseek, sdkCapabilities: {surface: 'openai_chat', thinking: 'optional',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], reasoningRoundtrip: 'supported', source: 'contract_test'},
      effective: {authoredReasoning: {mode: 'enabled', effort}}});
      for (const selection of ['preserve', 'minimum_legal_candidate'] as const) {
        const result = policy(target, {selection});
        expect(result).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {
          outcome: 'preserved', authored: {mode: 'enabled', effort}, documentedAuthoredEffort: documented,
          mapped: 'unchanged', sdkEffective: 'unknown', wireObservation: 'not_observed',
        }});
      }
      expect(target.effective.authoredReasoning).toEqual({mode: 'enabled', effort});
    });

  it('does not use a documented server alias to bypass the SDK accepted-spelling intersection', () => {
    expect(policy(profile({...deepseek, effective: {authoredReasoning: {mode: 'enabled', effort: 'minimal'}}}), {selection: 'preserve'}))
      .toMatchObject({status: 'unsupported', reason: 'unsupported_authored_effort'});
  });

  it('does not apply an official DeepSeek effort alias to an unknown gateway', () => {
    const target = profile({...deepseek, baseUrl: 'https://gateway.example/v1',
      sdkCapabilities: {surface: 'openai_chat', thinking: 'optional', efforts: ['medium'],
        reasoningRoundtrip: 'supported', source: 'contract_test'},
      effective: {authoredReasoning: {mode: 'enabled', effort: 'medium'}}});
    const result = policy(target, {selection: 'preserve'});
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'none'},
      receipt: {authored: {mode: 'enabled', effort: 'medium'}, mapped: 'unchanged'}});
    expect(result.receipt).not.toHaveProperty('documentedAuthoredEffort');
  });

  it.each([
    {purpose: 'PRIVATE_POLICY_CANARY'}, {selection: 'PRIVATE_POLICY_CANARY'},
    {purpose: '__proto__'}, {purpose: {toString: (): string => 'PRIVATE_POLICY_CANARY'}},
    {selection: null}, {purpose: undefined},
  ])('rejects malformed policy selectors before creating a receipt: %j', malformed => {
    let caught: unknown;
    try {
      policy(profile(), malformed as unknown as Partial<Omit<ResolveModelExecutionPolicyInput, 'profile'>>);
    } catch (error) {caught = error;}
    expect(caught).toEqual(new Error('model_execution_invalid_policy_selection'));
    expect(String(caught)).not.toContain('PRIVATE_POLICY_CANARY');
  });

  it('does not silently clamp an effort the server supports but the installed Pi model excludes', () => {
    const target = profile({...deepseek, runtimeKind: 'pi-agent-core', sdkCapabilities: {surface: 'pi_stream', thinking: 'optional',
      efforts: ['high', 'max'], reasoningRoundtrip: 'supported', source: 'installed_sdk'},
    effective: {authoredReasoning: {mode: 'enabled', effort: 'low'}}});
    expect(policy(target)).toMatchObject({status: 'unsupported', reason: 'unsupported_authored_effort'});
  });

  it('keeps a custom gateway unknown even when model and SDK capabilities look official', () => {
    const target = profile({baseUrl: 'https://gateway.example/v1'});
    expect(policy(target)).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {outcome: 'not_applied_unknown',
      reason: 'server_capability_unknown', mapped: 'unknown'}});
    expect(policy(profile({baseUrl: 'https://gateway.example/v1', effective: {authoredReasoning: {mode: 'enabled', effort: 'high'}}})))
      .toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {reason: 'authored_precedence'}});
  });

  it('does not treat an official server as proof of an unknown SDK capability', () => {
    const unknown = profile({sdkCapabilities: {surface: 'openai_chat', thinking: 'unknown', reasoningRoundtrip: 'unknown', source: 'installed_sdk'}});
    expect(policy(unknown)).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {reason: 'sdk_capability_unknown'}});
    const noLevel = profile({sdkCapabilities: {surface: 'openai_chat', thinking: 'required', reasoningRoundtrip: 'supported', source: 'installed_sdk'}});
    expect(policy(noLevel)).toMatchObject({receipt: {outcome: 'not_applied_unknown', reason: 'sdk_capability_unknown'}});
  });

  it('keeps a missing model legal with no invented identity or controls', () => {
    const target = profile({runtimeKind: 'qoder-agent-sdk', protocol: 'native', modelId: undefined, baseUrl: undefined,
      sdkCapabilities: {surface: 'none', thinking: 'unknown', reasoningRoundtrip: 'unknown', source: 'installed_sdk'}});
    const result = policy(target);
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'none'}, receipt: {outcome: 'not_applied_unknown'}});
    expect(result.receipt).not.toHaveProperty('modelId');
    expect(result.receipt.sdkEffective).toBe('unknown');
  });

  it('does not infer SDK-effective reasoning from a documented server or SDK default', () => {
    const target = profile({...deepseek, runtimeKind: 'pi-agent-core', sdkCapabilities: {surface: 'pi_stream', thinking: 'optional',
      efforts: ['low', 'high', 'max'], nativeDefault: {mode: 'disabled'}, reasoningRoundtrip: 'supported', source: 'installed_sdk'}});
    expect(policy(target, {selection: 'preserve'}).receipt.sdkEffective).toBe('unknown');
  });
});

describe('closed native control surfaces', () => {
  it('maps the same DeepSeek candidate to Responses none rather than Chat thinking', () => {
    const result = policy(profile({...deepseek, protocol: 'responses', sdkCapabilities: {surface: 'openai_responses',
      thinking: 'optional', efforts: ['low', 'high', 'max'], reasoningRoundtrip: 'supported', source: 'contract_test'}}));
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'openai_responses', reasoning: {effort: 'none'}}});
  });

  it('uses a Pi native level without copying provider options', () => {
    const result = policy(profile({runtimeKind: 'pi-agent-core', sdkCapabilities: {surface: 'pi_stream', thinking: 'required',
      efforts: ['low', 'high', 'max'], reasoningRoundtrip: 'supported', source: 'installed_sdk'}}));
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'pi_stream', reasoning: 'low'}});
  });

  it('emits Claude effort only for known matching Anthropic server and SDK facts', () => {
    const result = policy(profile({...deepseek, baseUrl: 'https://api.deepseek.com/anthropic', runtimeKind: 'claude-agent-sdk',
      protocol: 'anthropic_messages', sdkCapabilities: {surface: 'claude_effort', thinking: 'required',
        efforts: ['low', 'high', 'max'], reasoningRoundtrip: 'supported', source: 'contract_test'}}));
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'claude_effort', effort: 'low'}});
  });

  it('keeps OpenCode controls in its agent-options surface', () => {
    const result = policy(profile({...deepseek, runtimeKind: 'opencode', sdkCapabilities: {surface: 'opencode_agent_options',
      thinking: 'optional', efforts: ['low', 'high', 'max'], reasoningRoundtrip: 'supported', source: 'contract_test'}}));
    expect(result).toMatchObject({status: 'ready', controls: {surface: 'opencode_agent_options', thinking: {type: 'disabled'}}});
  });

  it.each([
    {runtimeKind: 'qoder-agent-sdk' as const}, {runtimeKind: 'claude-agent-sdk' as const}, {protocol: 'responses' as const},
  ])('rejects a mismatched runtime/protocol/SDK surface: %j', overrides => {
    expect(policy(profile(overrides))).toMatchObject({status: 'unsupported', reason: 'adapter_surface_mismatch'});
  });

  it('records a known empty intersection separately from unknown support', () => {
    const target = profile({sdkCapabilities: {surface: 'openai_chat', thinking: 'required', efforts: [],
      reasoningRoundtrip: 'supported', source: 'installed_sdk'}});
    expect(policy(target)).toMatchObject({status: 'ready', controls: {surface: 'none'},
      receipt: {outcome: 'not_applied_unsupported', reason: 'no_common_control'}});
  });

  it('returns immutable receipts and controls without borrowing mutable user settings', () => {
    const result = policy();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.mapped)).toBe(true);
    if (result.status === 'ready') {
      expect(Object.isFrozen(result.controls)).toBe(true);
      expect(Object.isFrozen('thinking' in result.controls ? result.controls.thinking : undefined)).toBe(true);
    }
  });
});
