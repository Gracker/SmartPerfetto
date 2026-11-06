// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import {admitFinalSubmissionConfiguration, installedOpenAiSdkCompatibility} from '../engines/openai/openAiFinalSubmissionConfig';
import type {OpenAIAgentConfig} from '../engines/openai/openAiConfig';

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
  it('checks the actual installed SDK exports and versions', () => {
    expect(installedOpenAiSdkCompatibility()).toEqual({
      agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0',
      contractVersion: 'openai_typed_final_admission@1',
    });
  });

  it('selects the installed native v2 contract only for its captured mode', () => {
    expect(installedOpenAiSdkCompatibility('authored_claim_document_v2')).toEqual({
      agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', contractVersion: 'openai_typed_final_admission@2',
    });
    const input = config({outputConfig: {finalSubmission: 'authored_claim_document_v2', declarationSyntax: 'authoring_v2'}});
    const profile = admitFinalSubmissionConfiguration(input, 'auto')?.get('deepseek-flash');
    expect(profile?.sdk.adapterContractVersion).toBe('openai_typed_final_admission@2');
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
