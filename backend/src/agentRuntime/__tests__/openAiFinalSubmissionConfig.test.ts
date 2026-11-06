// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import {admitFinalSubmissionConfiguration, installedOpenAiSdkCompatibility} from '../engines/openai/openAiFinalSubmissionConfig';
import type {OpenAIAgentConfig} from '../engines/openai/openAiConfig';
import {OPENAI_TYPED_FINAL_CONTRACTS, OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION,
  expectedOpenAiTypedFinalContract, getOpenAiTypedFinalContractIdentity} from '../finalSubmissionImplementation';
import {AUTHORED_CLAIM_DOCUMENT_VERSION} from '../../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_OBJECT_VERSION} from '../../agent/core/authoredClaimObject';
import {AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION, AUTHORED_CLAIM_OBJECT_COMPILER_VERSION} from '../authoredFinalSubmission';

function config(overrides: Partial<OpenAIAgentConfig> = {}): OpenAIAgentConfig {
  return {
    outputConfig: {finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1'},
    model: 'deepseek-flash', lightModel: 'deepseek-flash', protocol: 'chat_completions',
    baseURL: 'https://api.deepseek.com/v1', cwd: '/test-only', outputLanguage: 'zh-CN',
    maxTurns: 20, quickMaxTurns: 8, quickTargetTurns: 5,
    fullPathPerTurnMs: 60_000, quickPathPerTurnMs: 30_000, classifierTimeoutMs: 15_000,
    fullRequestTimeoutMs: 120_000, streamIdleTimeoutMs: 60_000, maxRunTimeoutMs: 300_000,
    maxHistoryBytes: 128_000,
    ...overrides,
  };
}

describe('shared production final-submission configuration gate', () => {
  it('keeps all three implementation tuples exact and historical descriptors immutable', () => {
    const identities = Object.values(OPENAI_TYPED_FINAL_CONTRACTS);
    expect(identities).toEqual([
      {representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, compilerVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION,
        admissionVersion: 'openai_typed_final_admission@1', wireVersion: 'openai_chat_final_wire@1'},
      {representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION,
        admissionVersion: 'openai_typed_final_admission@2', wireVersion: 'openai_chat_final_wire@1'},
      {representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION,
        admissionVersion: 'openai_typed_final_admission@3', wireVersion: 'openai_chat_final_wire@2'},
    ]);
    expect(Object.isFrozen(OPENAI_TYPED_FINAL_CONTRACTS)).toBe(true);
    for (const identity of identities) {
      expect(Object.isFrozen(identity)).toBe(true);
      expect(getOpenAiTypedFinalContractIdentity(identity.admissionVersion)).toBe(identity);
    }
    expect(expectedOpenAiTypedFinalContract('authored_claim_document_v1')).toBe(identities[0]);
    expect(expectedOpenAiTypedFinalContract('authored_claim_document_v2')).toBe(identities[2]);
    expect(OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION).toEqual({kind: 'assistant', nativeContract: 'openai_native_completion_observer@1'});
  });

  it.each([undefined, null, '', 'unknown', 'openai_typed_final_admission@4', '__proto__',
    {admissionVersion: 'openai_typed_final_admission@3'}, 'PRIVATE_VERSION_CANARY'])(
    'does not infer an implementation for an unknown admission descriptor: %p', value => {
      expect(getOpenAiTypedFinalContractIdentity(value)).toBeUndefined();
    });

  it('checks the actual installed SDK exports and versions', () => {
    expect(installedOpenAiSdkCompatibility()).toEqual({
      agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0',
      contractVersion: 'openai_typed_final_admission@1',
    });
    expect(installedOpenAiSdkCompatibility('authored_claim_document_v1')).toEqual(installedOpenAiSdkCompatibility());
    expect(installedOpenAiSdkCompatibility('assistant_text')).toEqual(installedOpenAiSdkCompatibility());
  });

  it('selects the installed native v2 contract only for its captured mode', () => {
    expect(installedOpenAiSdkCompatibility('authored_claim_document_v2')).toEqual({
      agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', contractVersion: 'openai_typed_final_admission@3',
    });
    const input = config({outputConfig: {finalSubmission: 'authored_claim_document_v2', declarationSyntax: 'authoring_v2'}});
    const profile = admitFinalSubmissionConfiguration(input, 'auto')?.get('deepseek-flash');
    expect(profile?.sdk.adapterContractVersion).toBe('openai_typed_final_admission@3');
    expect(profile?.effective).toMatchObject({finalSubmission: 'authored_claim_document_v2', declarationSyntax: 'authoring_v2'});
    expect(installedOpenAiSdkCompatibility().contractVersion).toBe('openai_typed_final_admission@1');
  });

  it.each(['canonical_v1', 'authoring_v1', 'authoring_v2'] as const)(
    'preserves the generic %s branch without typed model or protocol admission', declarationSyntax => {
      expect(admitFinalSubmissionConfiguration(config({
        outputConfig: {finalSubmission: 'assistant_text', declarationSyntax},
        protocol: 'responses', model: 'unobserved-primary', lightModel: 'unobserved-light',
        analysisReasoningEffort: 'max',
      }), 'auto')).toBeUndefined();
    });

  it('deduplicates identical possible-main models and preserves the effective configuration', () => {
    const input = config({analysisReasoningEffort: 'none', maxOutputTokens: 16_384});
    const result = admitFinalSubmissionConfiguration(input, 'auto');
    expect(result).toBeDefined();
    expect([...result!.keys()]).toEqual(['deepseek-flash']);
    const profile = result!.get('deepseek-flash');
    expect(profile?.effective).toEqual({
      finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1',
      authoredReasoning: {mode: 'disabled'}, maxOutputTokens: 16_384,
      maxTurns: 20, quickMaxTurns: 8, quickTargetTurns: 5,
      fullPerTurnMs: 60_000, quickPerTurnMs: 30_000,
      fullRequestTimeoutMs: 120_000, streamIdleTimeoutMs: 60_000,
      maxRunTimeoutMs: 300_000, classifierTimeoutMs: 15_000, maxHistoryBytes: 128_000,
    });
    expect(profile?.adapter.thinking).toBe('unknown');
  });

  it('keeps absent authored controls absent in the resolved profile', () => {
    const profile = admitFinalSubmissionConfiguration(config(), 'full')?.get('deepseek-flash');
    expect(profile?.effective).not.toHaveProperty('authoredReasoning');
    expect(profile?.effective.maxOutputTokens).toBeUndefined();
  });

  it('checks only the primary model on the full path', () => {
    const result = admitFinalSubmissionConfiguration(config({lightModel: 'unobserved-light'}), 'full');
    expect([...result!.keys()]).toEqual(['deepseek-flash']);
  });

  it.each(['auto', 'fast'] as const)('checks both possible-main models on the %s path', mode => {
    expect(() => admitFinalSubmissionConfiguration(config({lightModel: 'unobserved-light'}), mode))
      .toThrow('unsupported_final_submission:final_submission:function_tool_primitive');
  });

  it('retains the protocol failure from the production gate', () => {
    expect(() => admitFinalSubmissionConfiguration(config({protocol: 'responses'}), 'full'))
      .toThrow('unsupported_final_submission:final_submission:protocol');
  });

  it('retains the captured mode/syntax conflict from the production gate', () => {
    expect(() => admitFinalSubmissionConfiguration(config({outputConfig: {
      finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'authoring_v2',
    }}), 'full')).toThrow('invalid_configuration:final_submission:declaration_syntax_conflict');
  });
});
