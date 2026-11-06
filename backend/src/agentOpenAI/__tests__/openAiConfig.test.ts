// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createOpenAIEnv, getOpenAIRuntimeDiagnostics, loadOpenAIConfig } from '../openAiConfig';
import { getProviderService, resetProviderService } from '../../services/providerManager';
import {SMARTPERFETTO_FINAL_SUBMISSION_ENV, FinalSubmissionConfigurationError} from '../../agentRuntime/finalSubmissionConfig';
import {CONCLUSION_AUTHORING_ENV} from '../../agent/core/conclusionAuthoring';

const ORIGINAL_ENV = {
  [SMARTPERFETTO_FINAL_SUBMISSION_ENV]: process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV],
  [CONCLUSION_AUTHORING_ENV]: process.env[CONCLUSION_AUTHORING_ENV],
  PROVIDER_DATA_DIR_OVERRIDE: process.env.PROVIDER_DATA_DIR_OVERRIDE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MAX_OUTPUT_TOKENS: process.env.OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_ANALYSIS_REASONING_EFFORT: process.env.OPENAI_ANALYSIS_REASONING_EFFORT,
  OPENAI_MAX_TURNS: process.env.OPENAI_MAX_TURNS,
  OPENAI_QUICK_MAX_TURNS: process.env.OPENAI_QUICK_MAX_TURNS,
  OPENAI_FULL_REQUEST_TIMEOUT_MS: process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS,
  OPENAI_STREAM_IDLE_TIMEOUT_MS: process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS,
  OPENAI_MAX_HISTORY_BYTES: process.env.OPENAI_MAX_HISTORY_BYTES,
  AGENT_FULL_REQUEST_TIMEOUT_MS: process.env.AGENT_FULL_REQUEST_TIMEOUT_MS,
  AGENT_STREAM_IDLE_TIMEOUT_MS: process.env.AGENT_STREAM_IDLE_TIMEOUT_MS,
  AGENT_MAX_HISTORY_BYTES: process.env.AGENT_MAX_HISTORY_BYTES,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  CLAUDE_MAX_TURNS: process.env.CLAUDE_MAX_TURNS,
  CLAUDE_QUICK_MAX_TURNS: process.env.CLAUDE_QUICK_MAX_TURNS,
  CLAUDE_MODEL: process.env.CLAUDE_MODEL,
  AGENT_MAX_TURNS: process.env.AGENT_MAX_TURNS,
  AGENT_QUICK_MAX_TURNS: process.env.AGENT_QUICK_MAX_TURNS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('createOpenAIEnv', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `openai-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir, { recursive: true });
    process.env.PROVIDER_DATA_DIR_OVERRIDE = dir;
    delete process.env.OPENAI_ANALYSIS_REASONING_EFFORT;
    delete process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV];
    delete process.env[CONCLUSION_AUTHORING_ENV];
    resetProviderService();
  });

  afterEach(async () => {
    restoreEnv();
    resetProviderService();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'captures explicit analysis effort %s without changing the selected models', effort => {
      process.env.OPENAI_ANALYSIS_REASONING_EFFORT = effort;
      expect(loadOpenAIConfig(null).analysisReasoningEffort).toBe(effort);
      expect(getOpenAIRuntimeDiagnostics(null).analysisReasoningEffort).toBe(effort);
    });

  it('keeps analysis effort absent by default', () => {
    expect(loadOpenAIConfig(null).analysisReasoningEffort).toBeUndefined();
  });

  it('captures immutable output configuration once with the selected provider config', () => {
    const legacy = loadOpenAIConfig(null);
    expect(legacy.outputConfig).toEqual({finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'});
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'authored_claim_document_v1';
    const typed = loadOpenAIConfig(null);
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'assistant_text';
    process.env[CONCLUSION_AUTHORING_ENV] = 'authoring_v2';
    expect(Object.isFrozen(typed.outputConfig)).toBe(true);
    expect(typed.outputConfig).toEqual({finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1'});
    expect(legacy.outputConfig.declarationSyntax).toBe('canonical_v1');
  });

  it('captures object mode once and preserves each independently selected rollback', () => {
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'authored_claim_document_v2';
    process.env[CONCLUSION_AUTHORING_ENV] = 'authoring_v2';
    const native = loadOpenAIConfig(null);
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'authored_claim_document_v1';
    process.env[CONCLUSION_AUTHORING_ENV] = 'canonical_v1';
    expect(loadOpenAIConfig(null).outputConfig).toEqual({finalSubmission: 'authored_claim_document_v1', declarationSyntax: 'canonical_v1'});
    delete process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV];
    expect(loadOpenAIConfig(null).outputConfig).toEqual({finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'});
    expect(native.outputConfig).toEqual({finalSubmission: 'authored_claim_document_v2', declarationSyntax: 'authoring_v2'});
    expect(Object.isFrozen(native.outputConfig)).toBe(true);
  });

  it('rejects invalid or conflicting output configuration through a typed, value-free error', () => {
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'PRIVATE_FINAL_MODE_CANARY';
    expect(() => loadOpenAIConfig(null)).toThrow('invalid_configuration:final_submission:mode');
    process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV] = 'authored_claim_document_v1';
    process.env[CONCLUSION_AUTHORING_ENV] = 'authoring_v2';
    expect(() => loadOpenAIConfig(null)).toThrow('declaration_syntax_conflict');
    delete process.env[SMARTPERFETTO_FINAL_SUBMISSION_ENV];
    process.env[CONCLUSION_AUTHORING_ENV] = 'PRIVATE_SYNTAX_CANARY';
    expect(() => loadOpenAIConfig(null)).toThrow(FinalSubmissionConfigurationError);
    expect(() => loadOpenAIConfig(null)).toThrow('invalid_configuration:final_submission:declaration_syntax');
  });

  it.each(['', ' low', 'low ', 'LOW', 'PRIVATE_EFFORT_CANARY', 'ultra'])(
    'rejects invalid analysis effort without reflecting its value', effort => {
      process.env.OPENAI_ANALYSIS_REASONING_EFFORT = effort;
      expect(() => loadOpenAIConfig(null)).toThrow(/^invalid_configuration:openai_analysis_reasoning_effort$/);
    });

  it('isolates active provider env from unrelated global LLM credentials', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';
    process.env.ANTHROPIC_API_KEY = 'sk-global-anthropic';
    process.env.CLAUDE_MODEL = 'global-claude-model';
    process.env.OPENAI_ANALYSIS_REASONING_EFFORT = 'PRIVATE_EFFORT_CANARY';

    const svc = getProviderService();
    const p = svc.create({
      name: 'DeepSeek OpenAI Surface',
      category: 'official',
      type: 'deepseek',
      models: { primary: 'deepseek-v4-pro', light: 'deepseek-v4-flash' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://api.deepseek.com/v1',
        openaiProtocol: 'chat_completions',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv();

    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBeUndefined();
    expect(loadOpenAIConfig(p.id).analysisReasoningEffort).toBeUndefined();
  });

  it('ignores an active Claude provider when resolving OpenAI env without an explicit providerId', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';

    const svc = getProviderService();
    const p = svc.create({
      name: 'Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-provider-model', light: 'claude-provider-light' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeBaseUrl: 'https://provider-anthropic.example',
        claudeApiKey: 'sk-provider-anthropic',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv();

    expect(env.OPENAI_API_KEY).toBe('sk-global-openai');
    expect(env.OPENAI_BASE_URL).toBe('https://global-openai.example/v1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MODEL).toBeUndefined();
  });

  it('ignores the active OpenAI provider when providerId is explicitly null', () => {
    process.env.OPENAI_API_KEY = 'sk-global-openai';
    process.env.OPENAI_BASE_URL = 'https://global-openai.example/v1';

    const svc = getProviderService();
    const p = svc.create({
      name: 'OpenAI Provider',
      category: 'official',
      type: 'openai',
      models: { primary: 'gpt-provider-model', light: 'gpt-provider-light' },
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://provider-openai.example/v1',
        openaiApiKey: 'sk-provider-openai',
      },
    });
    svc.activate(p.id);

    const env = createOpenAIEnv(null);

    expect(env.OPENAI_API_KEY).toBe('sk-global-openai');
    expect(env.OPENAI_BASE_URL).toBe('https://global-openai.example/v1');
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it('throws instead of falling back when explicit providerId is missing', () => {
    expect(() => createOpenAIEnv('missing-provider')).toThrow(
      'Provider not found: missing-provider',
    );
  });

  it('throws instead of falling back when explicit providerId targets a Claude runtime', () => {
    const svc = getProviderService();
    const p = svc.create({
      name: 'Claude Provider',
      category: 'official',
      type: 'anthropic',
      models: { primary: 'claude-provider-model', light: 'claude-provider-light' },
      connection: {
        agentRuntime: 'claude-agent-sdk',
        claudeApiKey: 'sk-provider-anthropic',
      },
    });

    expect(() => createOpenAIEnv(p.id)).toThrow(
      `Provider ${p.id} is configured for claude-agent-sdk, not openai-agents-sdk`,
    );
  });

  it('does not report the default OpenAI base URL as an env credential source', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;

    const diagnostics = getOpenAIRuntimeDiagnostics(null);

    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.baseUrlConfigured).toBe(false);
    expect(diagnostics.credentialSources).toEqual([]);
    expect(diagnostics.model).toBe('gpt-5.4-mini');
  });

  it('ignores placeholder OpenAI keys in diagnostics', () => {
    process.env.OPENAI_API_KEY = 'your_openai_api_key_here';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';

    const diagnostics = getOpenAIRuntimeDiagnostics(null);

    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.baseUrlConfigured).toBe(true);
    expect(diagnostics.credentialSources).toEqual(['openai_base_url']);
  });

  it('redacts sensitive URL parts from diagnostic base URL', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    process.env.OPENAI_BASE_URL = 'https://user:pass@example.com/v1?token=secret#fragment';

    const diagnostics = getOpenAIRuntimeDiagnostics(null);

    expect(diagnostics.baseUrl).toBe('https://example.com/v1');
  });

  it('leaves the primary generation cap unset by default and respects an explicit cap', () => {
    delete process.env.OPENAI_MAX_OUTPUT_TOKENS;
    expect(loadOpenAIConfig(null).maxOutputTokens).toBeUndefined();
    expect(getOpenAIRuntimeDiagnostics(null).maxOutputTokens).toBeUndefined();

    process.env.OPENAI_MAX_OUTPUT_TOKENS = '2048';
    expect(loadOpenAIConfig(null).maxOutputTokens).toBe(2048);

    const diagnostics = getOpenAIRuntimeDiagnostics(null);
    expect(diagnostics.maxOutputTokens).toBe(2048);
  });

  it.each(['', ' ', '0', '-1', '1.5', '8192suffix', 'Infinity', '9007199254740992'])('rejects malformed explicit output cap %j', value => {
    process.env.OPENAI_MAX_OUTPUT_TOKENS = value;
    expect(() => loadOpenAIConfig(null)).toThrow('OPENAI_MAX_OUTPUT_TOKENS must be a positive safe integer');
  });

  it('uses shared turn budget config when runtime-specific values are unset', () => {
    delete process.env.OPENAI_MAX_TURNS;
    delete process.env.OPENAI_QUICK_MAX_TURNS;
    delete process.env.OPENAI_QUICK_TARGET_TURNS;
    delete process.env.CLAUDE_MAX_TURNS;
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
    delete process.env.CLAUDE_QUICK_TARGET_TURNS;
    process.env.AGENT_MAX_TURNS = '90';
    process.env.AGENT_QUICK_MAX_TURNS = '12';
    process.env.AGENT_QUICK_TARGET_TURNS = '4';

    const config = loadOpenAIConfig(null);

    expect(config.maxTurns).toBe(90);
    expect(config.quickMaxTurns).toBe(12);
    expect(config.quickTargetTurns).toBe(4);
  });

  it('bounds full requests, provider-stream idle time, and retained history by default', () => {
    delete process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS;
    delete process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS;
    delete process.env.OPENAI_MAX_HISTORY_BYTES;
    delete process.env.AGENT_FULL_REQUEST_TIMEOUT_MS;
    delete process.env.AGENT_STREAM_IDLE_TIMEOUT_MS;
    delete process.env.AGENT_MAX_HISTORY_BYTES;

    expect(loadOpenAIConfig(null)).toMatchObject({
      fullRequestTimeoutMs: 20 * 60_000,
      streamIdleTimeoutMs: 5 * 60_000,
      maxHistoryBytes: 4 * 1024 * 1024,
    });

    process.env.AGENT_FULL_REQUEST_TIMEOUT_MS = '54321';
    process.env.AGENT_STREAM_IDLE_TIMEOUT_MS = '9876';
    process.env.AGENT_MAX_HISTORY_BYTES = '16384';
    expect(loadOpenAIConfig(null)).toMatchObject({
      fullRequestTimeoutMs: 54_321,
      streamIdleTimeoutMs: 9_876,
      maxHistoryBytes: 16_384,
    });

    process.env.OPENAI_FULL_REQUEST_TIMEOUT_MS = '12345';
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS = '6789';
    process.env.OPENAI_MAX_HISTORY_BYTES = '8192';
    expect(loadOpenAIConfig(null)).toMatchObject({
      fullRequestTimeoutMs: 12_345,
      streamIdleTimeoutMs: 6_789,
      maxHistoryBytes: 8_192,
    });
  });
});
