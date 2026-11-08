// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {selectRuntimeForProvider} from '../../agentRuntime/runtimeSelection';
import {hasClaudeCredentials, runtimeConfigForProviderEnv, sdkEnvForProviderEnv} from '../../agentv3/claudeConfig';
import {AI_CAPABILITY_ENV_KEY, resolveAiCapabilityPolicy} from '../aiCapabilityPolicy';
import {createPiAgentCoreProviderRuntime} from '../../agentRuntime/engines/pi/piAgentCoreProvider';
import {runPiIntentTransport} from '../../agentRuntime/engines/pi/piIntentTransport';
import {
  oneShotFallbackWarning,
  resolveOneShotProvider,
  runIsolatedPiOneShot,
  runOneShotSummary,
} from '../oneShotModelCall';
import {isolatedClaudeOneShotOptions, runIsolatedClaudeOneShot} from '../../agentRuntime/engines/claude/claudeOneShot';

jest.mock('../../agentRuntime/engines/pi/piAgentCoreProvider', () => ({
  createPiAgentCoreProviderRuntime: jest.fn(),
}));
jest.mock('../../agentRuntime/engines/pi/piIntentTransport', () => ({
  runPiIntentTransport: jest.fn(),
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../../agentRuntime/runtimeSelection', () => ({
  selectRuntimeForProvider: jest.fn(),
}));

// The Claude engine's config module, which the agentv3 entry re-exports.
jest.mock('../../agentRuntime/engines/claude/claudeConfig', () => ({
  sdkEnvForProviderEnv: jest.fn(),
  hasClaudeCredentials: jest.fn(),
  loadClaudeConfig: jest.fn(() => ({model: 'env-model', lightModel: 'env-light'})),
  runtimeConfigForProviderEnv: jest.fn(),
  getSdkBinaryOption: jest.fn(() => ({pathToClaudeCodeExecutable: '/bin/claude'})),
  resolveClaudeSdkPermissionOptions: jest.fn(() => ({permissionMode: 'dontAsk'})),
}));

const mockProviderService = {
  getRawEffectiveProvider: jest.fn<(...args: any[]) => any>(),
  getRawProvider: jest.fn<(...args: any[]) => any>(),
  getEnvForProviderConfig: jest.fn<(...args: any[]) => any>(),
};
jest.mock('../providerManager', () => ({
  ...(jest.requireActual('../providerManager') as object),
  getProviderService: () => mockProviderService,
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockSelection = selectRuntimeForProvider as unknown as jest.Mock<(...args: any[]) => any>;
const mockSdkEnv = sdkEnvForProviderEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockHasCredentials = hasClaudeCredentials as unknown as jest.Mock<(...args: any[]) => any>;
const mockRuntimeConfig = runtimeConfigForProviderEnv as unknown as jest.Mock<(...args: any[]) => any>;

const mockPiRuntime = createPiAgentCoreProviderRuntime as unknown as jest.Mock<(...args: any[]) => any>;
const mockPiTransport = runPiIntentTransport as unknown as jest.Mock<(...args: any[]) => any>;
const PI_MODEL_JSON = JSON.stringify({id: 'pi-model', provider: 'deepseek', api: 'openai-completions',
  baseUrl: 'https://pi.example', reasoning: true, input: ['text'],
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 8192, maxTokens: 1024,
  apiKeyEnv: 'DEEPSEEK_API_KEY'});

const SCOPE = {tenantId: 't', workspaceId: 'w', userId: 'u'};
const CLAUDE = {
  env: {ANTHROPIC_API_KEY: 'profile-key'},
  config: {model: 'main-model', lightModel: 'light-model', cwd: '/tmp/cwd'} as any,
};

function stream(messages: unknown[]) {
  const close = jest.fn();
  return {
    close,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

/** A stream that waits until the SDK's abort controller fires, then throws like the SDK does. */
function hangingStream(params: any) {
  const abort: AbortController = params.options.abortController;
  return {
    close: jest.fn(),
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), {once: true}));
      throw new Error('Claude Code process aborted by user');
    },
  };
}

function baseInput() {
  return {prompt: 'p', claude: CLAUDE, tier: 'main' as const, timeoutMs: 5_000, logLabel: 'Test'};
}

function useClaudeProvider(): void {
  mockProviderService.getRawEffectiveProvider.mockReturnValue({id: 'provider-a'});
  mockProviderService.getEnvForProviderConfig.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
  mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'provider'});
  mockSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
  mockRuntimeConfig.mockReturnValue({model: 'main-model', lightModel: 'light-model', cwd: '/tmp/cwd'});
}

describe('resolveOneShotProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useClaudeProvider();
  });

  it('reads the provider once and builds runtime, env and config from that record', () => {
    const resolved = resolveOneShotProvider({providerScope: SCOPE, logLabel: 'Test'});

    expect(resolved).toMatchObject({kind: 'resolved', runtime: 'claude-agent-sdk',
      claude: {env: {ANTHROPIC_API_KEY: 'profile-key'}, config: {model: 'main-model'}}});
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledTimes(1);
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledWith(SCOPE);
    expect(mockProviderService.getEnvForProviderConfig).toHaveBeenCalledTimes(1);
    expect(mockSelection).toHaveBeenCalledWith({id: 'provider-a'});
  });

  it('reads no env for a runtime other than Claude, and reports an unresolvable provider as unavailable', () => {
    mockSelection.mockReturnValueOnce({kind: 'openai-agents-sdk', source: 'provider'});
    expect(resolveOneShotProvider({providerScope: SCOPE, logLabel: 'Test'}))
      .toEqual({kind: 'resolved', runtime: 'openai-agents-sdk'});
    expect(mockProviderService.getEnvForProviderConfig).not.toHaveBeenCalled();

    mockProviderService.getRawProvider.mockReturnValueOnce(undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveOneShotProvider({providerId: 'deleted', providerScope: SCOPE, logLabel: 'Test'}))
      .toEqual({kind: 'unavailable'});
    warn.mockRestore();
  });
});

describe('Pi one-shot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderService.getRawEffectiveProvider.mockReturnValue({id: 'provider-pi'});
    mockProviderService.getEnvForProviderConfig.mockReturnValue({
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core', SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: PI_MODEL_JSON,
    });
    mockSelection.mockReturnValue({kind: 'pi-agent-core', source: 'provider'});
    mockPiRuntime.mockResolvedValue({model: {id: 'pi-model'}});
  });

  it('resolves the provider env for Pi from one store read and never builds a Claude context', () => {
    const resolved = resolveOneShotProvider({providerScope: SCOPE, logLabel: 'Test'});

    expect(resolved).toMatchObject({kind: 'resolved', runtime: 'pi-agent-core',
      pi: {env: {SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: PI_MODEL_JSON}}});
    expect(resolved).not.toHaveProperty('claude');
    expect(mockProviderService.getEnvForProviderConfig).toHaveBeenCalledTimes(1);
    expect(mockSdkEnv).not.toHaveBeenCalled();
  });

  it('runs one tool-free review-purpose call through the pinned Pi runtime', async () => {
    mockPiTransport.mockResolvedValue({status: 'ok', text: '  pi answer  ', actualModel: 'pi-model-actual'});
    const env = {SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: PI_MODEL_JSON};

    const result = await runIsolatedPiOneShot({prompt: 'p', pi: {env}, timeoutMs: 5_000, logLabel: 'Test'});

    expect(result).toEqual({ok: true, text: 'pi answer', model: 'pi-model-actual'});
    expect(mockPiRuntime).toHaveBeenCalledWith(expect.objectContaining({model: expect.objectContaining({id: 'pi-model'}),
      apiKeyEnv: 'DEEPSEEK_API_KEY'}), env);
    expect(mockPiTransport).toHaveBeenCalledWith(expect.objectContaining({prompt: 'p', systemPrompt: '',
      purpose: 'review', providerRuntime: {model: {id: 'pi-model'}}}));
  });

  it.each([
    [{status: 'unavailable', reason: 'timeout'}, 'timed_out'],
    [{status: 'unavailable', reason: 'tool_use'}, 'failed'],
    [{status: 'unavailable', reason: 'incomplete_output'}, 'failed'],
  ])('maps transport result %j to %s', async (transport, reason) => {
    mockPiTransport.mockResolvedValue(transport);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runIsolatedPiOneShot({prompt: 'p', pi: {env: {SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: PI_MODEL_JSON}},
      timeoutMs: 5_000, logLabel: 'Test'});
    warn.mockRestore();
    expect(result).toEqual({ok: false, reason, model: 'pi-model'});
  });

  it('reports a missing Pi model as missing configuration without dispatching', async () => {
    const result = await runIsolatedPiOneShot({prompt: 'p', pi: {env: {}}, timeoutMs: 5_000, logLabel: 'Test'});

    expect(result).toEqual({ok: false, reason: 'credentials_missing'});
    expect(mockPiRuntime).not.toHaveBeenCalled();
  });

  it('answers a summary on the Pi runtime instead of degrading', async () => {
    mockPiTransport.mockResolvedValue({status: 'ok', text: 'pi summary', actualModel: 'pi-model'});
    const result = await runOneShotSummary({
      feature: 'critical_path_ai_summary', label: {zh: '测试', en: 'test'}, outputLanguage: 'en',
      aiPolicy: resolveAiCapabilityPolicy({[AI_CAPABILITY_ENV_KEY]: 'true'}), providerScope: SCOPE,
      logLabel: 'Test', timeoutMs: 5_000, ruleSummary: () => 'rule summary',
      buildPrompt: () => ({prompt: 'p', redactionApplied: false}),
    } as any);

    expect(result).toMatchObject({generated: true, summary: 'pi summary', model: 'pi-model'});
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('runOneShotSummary gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useClaudeProvider();
    mockHasCredentials.mockReturnValue(true);
    mockQuery.mockImplementation(() => stream([{type: 'result', subtype: 'success', result: 'model answer'}]));
  });

  function summary(overrides: Partial<Parameters<typeof runOneShotSummary>[0]> = {}) {
    const buildPrompt = jest.fn(() => ({prompt: 'p', redactionApplied: true}));
    const ruleSummary = jest.fn(() => 'rule summary');
    return {
      buildPrompt,
      ruleSummary,
      run: () => runOneShotSummary({
        feature: 'critical_path_ai_summary',
        label: {zh: '测试 AI 总结', en: 'test AI summary'},
        logLabel: 'Test',
        outputLanguage: 'en',
        ruleSummary,
        buildPrompt,
        timeoutMs: 5_000,
        aiPolicy: resolveAiCapabilityPolicy({[AI_CAPABILITY_ENV_KEY]: 'true'}),
        providerScope: SCOPE,
        ...overrides,
      }),
    };
  }

  it.each([
    ['ai_disabled', {aiPolicy: resolveAiCapabilityPolicy({[AI_CAPABILITY_ENV_KEY]: 'false'})}],
    ['permission_denied', {aiPermitted: false}],
    ['client_disconnected', {signal: AbortSignal.abort()}],
  ])('answers %s before the provider is read', async (reason, overrides) => {
    const {run, buildPrompt} = summary(overrides as any);

    const result = await run();

    expect(result).toMatchObject({generated: false, summary: 'rule summary', fallbackReason: reason});
    expect(mockProviderService.getRawEffectiveProvider).not.toHaveBeenCalled();
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('names the runtime it does not support and never builds the prompt for it', async () => {
    mockSelection.mockReturnValue({kind: 'opencode', source: 'provider'});
    const {run, buildPrompt} = summary();

    const result = await run();

    expect(result.fallbackReason).toBe('runtime_not_supported');
    expect(result.warnings[0]).toContain('opencode');
    expect(result.warnings[0]).toContain('test AI summary');
    expect(buildPrompt).not.toHaveBeenCalled();
  });

  it('builds the rule summary only when no model answers', async () => {
    const {run, ruleSummary} = summary();

    expect(await run()).toMatchObject({generated: true, summary: 'model answer', model: 'main-model', redactionApplied: true});
    expect(ruleSummary).not.toHaveBeenCalled();
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledTimes(1);
  });

  it('localizes every fallback reason in both languages', () => {
    const label = {zh: '测试 AI 总结', en: 'test AI summary'};
    for (const reason of ['ai_disabled', 'permission_denied', 'runtime_not_supported', 'runtime_unavailable',
      'credentials_missing', 'client_disconnected', 'timed_out', 'failed', 'empty_response'] as const) {
      expect(oneShotFallbackWarning(reason, label, 'en', 'opencode')).toMatch(/[a-z]/);
      expect(oneShotFallbackWarning(reason, label, 'zh-CN', 'opencode')).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe('isolatedClaudeOneShotOptions', () => {
  it('detaches the call from tools, skills, plugins, MCP servers, settings and transcripts', () => {
    const options = isolatedClaudeOneShotOptions({model: 'm', env: {}, stderr: () => undefined});

    expect(options).toMatchObject({
      model: 'm',
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      pathToClaudeCodeExecutable: '/bin/claude',
    });
    expect(options).not.toHaveProperty('resume');
  });
});

describe('runIsolatedClaudeOneShot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockHasCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers with the result text of the selected tier, with no provider read of its own', async () => {
    mockQuery.mockImplementation(() => stream([{type: 'result', subtype: 'success', result: '  answer  '}]));

    const main = await runIsolatedClaudeOneShot(baseInput());
    const light = await runIsolatedClaudeOneShot({...baseInput(), tier: 'light', effort: 'low'});

    expect(main).toEqual({ok: true, text: 'answer', model: 'main-model'});
    expect(light).toEqual({ok: true, text: 'answer', model: 'light-model'});
    expect(mockProviderService.getRawEffectiveProvider).not.toHaveBeenCalled();
    const lightOptions = mockQuery.mock.calls[1][0].options;
    expect(lightOptions).toMatchObject({model: 'light-model', effort: 'low', cwd: '/tmp/cwd', env: {ANTHROPIC_API_KEY: 'profile-key'}});
    expect(lightOptions.abortController).toBeInstanceOf(AbortController);
  });

  it('checks credentials in the resolved profile env and never starts the SDK without them', async () => {
    mockHasCredentials.mockReturnValue(false);

    const result = await runIsolatedClaudeOneShot(baseInput());

    expect(result).toEqual({ok: false, reason: 'credentials_missing', model: 'main-model'});
    expect(mockHasCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats a tool call in a tool-less call as a failure and closes the stream', async () => {
    const toolStream = stream([
      {type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash', input: {}}]}},
      {type: 'result', subtype: 'success', result: 'should not be used'},
    ]);
    mockQuery.mockReturnValue(toolStream);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runIsolatedClaudeOneShot(baseInput());
    warn.mockRestore();

    expect(result).toEqual({ok: false, reason: 'failed', model: 'main-model'});
    expect(toolStream.close).toHaveBeenCalled();
  });

  it('treats a refusal or an error result as a failure', async () => {
    mockQuery.mockImplementationOnce(() => stream([{type: 'result', subtype: 'success', result: 'x', stop_reason: 'refusal'}]));
    mockQuery.mockImplementationOnce(() => stream([{type: 'result', subtype: 'error_during_execution', is_error: true}]));

    expect(await runIsolatedClaudeOneShot(baseInput())).toMatchObject({ok: false, reason: 'failed'});
    expect(await runIsolatedClaudeOneShot(baseInput())).toMatchObject({ok: false, reason: 'failed'});
  });

  it('reports an empty answer as empty_response', async () => {
    mockQuery.mockImplementation(() => stream([{type: 'result', subtype: 'success', result: '   '}]));

    expect(await runIsolatedClaudeOneShot(baseInput())).toEqual({ok: false, reason: 'empty_response', model: 'main-model'});
  });

  it('keeps the raw SDK error in the log and returns only the reason', async () => {
    mockQuery.mockImplementation(() => ({
      close: jest.fn(),
      async *[Symbol.asyncIterator]() {
        throw new Error('401 invalid x-api-key sk-secret');
      },
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runIsolatedClaudeOneShot(baseInput());

    expect(result).toEqual({ok: false, reason: 'failed', model: 'main-model'});
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never starts the SDK for an already cancelled caller', async () => {
    const caller = new AbortController();
    caller.abort();

    expect(await runIsolatedClaudeOneShot({...baseInput(), signal: caller.signal}))
      .toEqual({ok: false, reason: 'client_disconnected'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aborts the SDK subprocess when the caller cancels mid-call', async () => {
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return hangingStream(params);
    });
    const caller = new AbortController();

    const pending = runIsolatedClaudeOneShot({...baseInput(), signal: caller.signal});
    await new Promise((resolve) => setImmediate(resolve));
    expect(sdkAbort?.signal.aborted).toBe(false);
    caller.abort();

    expect(await pending).toEqual({ok: false, reason: 'client_disconnected', model: 'main-model'});
    expect(sdkAbort?.signal.aborted).toBe(true);
  });

  it('aborts the SDK subprocess at the deadline', async () => {
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return hangingStream(params);
    });

    const result = await runIsolatedClaudeOneShot({...baseInput(), timeoutMs: 20});

    expect(result).toEqual({ok: false, reason: 'timed_out', model: 'main-model'});
    expect(sdkAbort?.signal.aborted).toBe(true);
  });
});
