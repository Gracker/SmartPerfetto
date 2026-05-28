// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'path';
// Use require so jest.spyOn can rebind these properties — `import * as fs`
// produces a frozen module namespace in some TS-Jest configs.
const fs: typeof import('fs') = require('fs');
import {
  createSdkEnv,
  createQuickConfig,
  explainClaudeRuntimeError,
  getClaudeRuntimeDiagnostics,
  getClaudeSdkBinaryDiagnostics,
  getSdkBinaryOption,
  isClaudeQuotaError,
  loadClaudeConfig,
  resetSdkBinaryOptionCache,
} from '../claudeConfig';

const ORIGINAL_QUICK_MAX_TURNS = process.env.CLAUDE_QUICK_MAX_TURNS;
const ORIGINAL_MAX_TURNS = process.env.CLAUDE_MAX_TURNS;
const ORIGINAL_AGENT_MAX_TURNS = process.env.AGENT_MAX_TURNS;
const ORIGINAL_AGENT_QUICK_MAX_TURNS = process.env.AGENT_QUICK_MAX_TURNS;
const ORIGINAL_ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ORIGINAL_CLAUDE_MODEL = process.env.CLAUDE_MODEL;
const ORIGINAL_CLAUDE_LIGHT_MODEL = process.env.CLAUDE_LIGHT_MODEL;
const ORIGINAL_CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
const ORIGINAL_AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK;
const ORIGINAL_AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const ORIGINAL_AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const ORIGINAL_AWS_PROFILE = process.env.AWS_PROFILE;
const ORIGINAL_CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX;
const ORIGINAL_ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
const ORIGINAL_CLOUD_ML_REGION = process.env.CLOUD_ML_REGION;
const ORIGINAL_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
const ORIGINAL_DISABLE_TELEMETRY = process.env.DISABLE_TELEMETRY;
const ORIGINAL_CLAUDE_CODE_ENABLE_TELEMETRY = process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
const ORIGINAL_DISABLE_ERROR_REPORTING = process.env.DISABLE_ERROR_REPORTING;

afterEach(() => {
  if (ORIGINAL_QUICK_MAX_TURNS === undefined) {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
  } else {
    process.env.CLAUDE_QUICK_MAX_TURNS = ORIGINAL_QUICK_MAX_TURNS;
  }
  if (ORIGINAL_MAX_TURNS === undefined) {
    delete process.env.CLAUDE_MAX_TURNS;
  } else {
    process.env.CLAUDE_MAX_TURNS = ORIGINAL_MAX_TURNS;
  }
  if (ORIGINAL_AGENT_MAX_TURNS === undefined) {
    delete process.env.AGENT_MAX_TURNS;
  } else {
    process.env.AGENT_MAX_TURNS = ORIGINAL_AGENT_MAX_TURNS;
  }
  if (ORIGINAL_AGENT_QUICK_MAX_TURNS === undefined) {
    delete process.env.AGENT_QUICK_MAX_TURNS;
  } else {
    process.env.AGENT_QUICK_MAX_TURNS = ORIGINAL_AGENT_QUICK_MAX_TURNS;
  }
  if (ORIGINAL_ANTHROPIC_BASE_URL === undefined) {
    delete process.env.ANTHROPIC_BASE_URL;
  } else {
    process.env.ANTHROPIC_BASE_URL = ORIGINAL_ANTHROPIC_BASE_URL;
  }
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  }
  if (ORIGINAL_ANTHROPIC_AUTH_TOKEN === undefined) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_ANTHROPIC_AUTH_TOKEN;
  }
  if (ORIGINAL_CLAUDE_MODEL === undefined) {
    delete process.env.CLAUDE_MODEL;
  } else {
    process.env.CLAUDE_MODEL = ORIGINAL_CLAUDE_MODEL;
  }
  if (ORIGINAL_CLAUDE_LIGHT_MODEL === undefined) {
    delete process.env.CLAUDE_LIGHT_MODEL;
  } else {
    process.env.CLAUDE_LIGHT_MODEL = ORIGINAL_CLAUDE_LIGHT_MODEL;
  }
  if (ORIGINAL_CLAUDE_CODE_USE_BEDROCK === undefined) {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  } else {
    process.env.CLAUDE_CODE_USE_BEDROCK = ORIGINAL_CLAUDE_CODE_USE_BEDROCK;
  }
  if (ORIGINAL_AWS_BEARER_TOKEN_BEDROCK === undefined) {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  } else {
    process.env.AWS_BEARER_TOKEN_BEDROCK = ORIGINAL_AWS_BEARER_TOKEN_BEDROCK;
  }
  if (ORIGINAL_AWS_ACCESS_KEY_ID === undefined) {
    delete process.env.AWS_ACCESS_KEY_ID;
  } else {
    process.env.AWS_ACCESS_KEY_ID = ORIGINAL_AWS_ACCESS_KEY_ID;
  }
  if (ORIGINAL_AWS_SECRET_ACCESS_KEY === undefined) {
    delete process.env.AWS_SECRET_ACCESS_KEY;
  } else {
    process.env.AWS_SECRET_ACCESS_KEY = ORIGINAL_AWS_SECRET_ACCESS_KEY;
  }
  if (ORIGINAL_AWS_PROFILE === undefined) {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = ORIGINAL_AWS_PROFILE;
  }
  if (ORIGINAL_CLAUDE_CODE_USE_VERTEX === undefined) {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
  } else {
    process.env.CLAUDE_CODE_USE_VERTEX = ORIGINAL_CLAUDE_CODE_USE_VERTEX;
  }
  if (ORIGINAL_ANTHROPIC_VERTEX_PROJECT_ID === undefined) {
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  } else {
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = ORIGINAL_ANTHROPIC_VERTEX_PROJECT_ID;
  }
  if (ORIGINAL_CLOUD_ML_REGION === undefined) {
    delete process.env.CLOUD_ML_REGION;
  } else {
    process.env.CLOUD_ML_REGION = ORIGINAL_CLOUD_ML_REGION;
  }
  if (ORIGINAL_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  } else {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = ORIGINAL_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  }
  if (ORIGINAL_DISABLE_TELEMETRY === undefined) {
    delete process.env.DISABLE_TELEMETRY;
  } else {
    process.env.DISABLE_TELEMETRY = ORIGINAL_DISABLE_TELEMETRY;
  }
  if (ORIGINAL_CLAUDE_CODE_ENABLE_TELEMETRY === undefined) {
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
  } else {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = ORIGINAL_CLAUDE_CODE_ENABLE_TELEMETRY;
  }
  if (ORIGINAL_DISABLE_ERROR_REPORTING === undefined) {
    delete process.env.DISABLE_ERROR_REPORTING;
  } else {
    process.env.DISABLE_ERROR_REPORTING = ORIGINAL_DISABLE_ERROR_REPORTING;
  }
});

describe('createQuickConfig', () => {
  it('keeps the existing quick max-turn default', () => {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
    delete process.env.AGENT_QUICK_MAX_TURNS;
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 60 }));

    expect(config.maxTurns).toBe(10);
    expect(config.enableVerification).toBe(false);
    expect(config.enableSubAgents).toBe(false);
  });

  it('allows quick max-turn override via env', () => {
    delete process.env.AGENT_QUICK_MAX_TURNS;
    process.env.CLAUDE_QUICK_MAX_TURNS = '8';
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 60 }));

    expect(config.maxTurns).toBe(8);
  });

  it('uses shared quick max-turn config as fallback', () => {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
    process.env.AGENT_QUICK_MAX_TURNS = '12';
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 60 }));

    expect(config.maxTurns).toBe(12);
  });

  it('ignores invalid quick max-turn env values', () => {
    delete process.env.AGENT_QUICK_MAX_TURNS;
    process.env.CLAUDE_QUICK_MAX_TURNS = '0';
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 60 }));

    expect(config.maxTurns).toBe(10);
  });

  it('uses shared full max-turn config as fallback', () => {
    delete process.env.CLAUDE_MAX_TURNS;
    process.env.AGENT_MAX_TURNS = '90';
    const config = loadClaudeConfig();

    expect(config.maxTurns).toBe(90);
  });

  it('can resolve quick max turns from an isolated SDK env', () => {
    process.env.CLAUDE_QUICK_MAX_TURNS = '8';

    expect(createQuickConfig(loadClaudeConfig({ maxTurns: 60 }), {}).maxTurns).toBe(10);
    expect(createQuickConfig(loadClaudeConfig({ maxTurns: 60 }), {
      CLAUDE_QUICK_MAX_TURNS: '6',
    }).maxTurns).toBe(6);
  });
});

describe('getClaudeRuntimeDiagnostics', () => {
  it('reports Anthropic-compatible proxy mode', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:3000';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.CLAUDE_MODEL = 'mimo-main';
    process.env.CLAUDE_LIGHT_MODEL = 'mimo-light';

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.runtime).toBe('claude-agent-sdk');
    expect(diagnostics.providerMode).toBe('anthropic_compatible_proxy');
    expect(diagnostics.model).toBe('mimo-main');
    expect(diagnostics.lightModel).toBe('mimo-light');
    expect(diagnostics.baseUrl).toBe('http://localhost:3000/');
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.credentialSources).toContain('anthropic_compatible_proxy');
  });

  it('treats ANTHROPIC_AUTH_TOKEN as a configured credential source', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-deepseek-test';

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('anthropic_compatible_proxy');
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.credentialSources).toContain('anthropic_auth_token');
  });

  it('reports unconfigured mode when no credential source is set', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('unconfigured');
    expect(diagnostics.configured).toBe(false);
  });

  it('ignores placeholder credential values', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'your_anthropic_api_key_here';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('unconfigured');
    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.credentialSources).not.toContain('anthropic_api_key');
  });

  it('reports Google Vertex mode as configured', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'smartperfetto-project';
    process.env.CLOUD_ML_REGION = 'us-central1';

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('google_vertex');
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.credentialSources).toContain('google_vertex');
    expect(diagnostics.vertex).toMatchObject({
      enabled: true,
      configured: true,
      projectId: 'smartperfetto-project',
      region: 'us-central1',
    });
  });

  it('does not mark Vertex as configured without a project id', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('google_vertex');
    expect(diagnostics.configured).toBe(false);
    expect(diagnostics.vertex).toMatchObject({
      enabled: true,
      configured: false,
      missing: ['ANTHROPIC_VERTEX_PROJECT_ID'],
    });
  });
});

describe('explainClaudeRuntimeError', () => {
  it('adds provider guidance for quota/auth failures', () => {
    const message = explainClaudeRuntimeError("You're out of extra usage");

    expect(message).toContain("You're out of extra usage");
    expect(message).toContain('ANTHROPIC_BASE_URL');
    expect(message).toContain('CC Switch');
  });

  it('explains when active Provider Manager credentials override env fallback', () => {
    const message = explainClaudeRuntimeError('Not logged in', 'zh-CN', {
      source: 'provider-manager',
      providerName: 'DeepSeek',
      providerType: 'deepseek',
      providerRuntime: 'claude-agent-sdk',
      envCredentialSources: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
      providerOverridesEnv: true,
    });

    expect(message).toContain('Provider Manager active provider "DeepSeek (deepseek)", runtime=claude-agent-sdk');
    expect(message).toContain('active Provider Manager profile 优先级更高');
    expect(message).toContain('停用 active provider');
    expect(message).not.toContain('Environment/.env');
  });

  it('explains env fallback paths for Docker and local source runs', () => {
    const message = explainClaudeRuntimeError('Unauthorized', 'en', {
      source: 'env-or-default',
      envCredentialSources: ['ANTHROPIC_API_KEY'],
      providerOverridesEnv: false,
    });

    expect(message).toContain('Current credential source: .env or environment fallback (ANTHROPIC_API_KEY)');
    expect(message).toContain('Docker Hub compose reads the repository-root .env');
    expect(message).toContain('local source runs use backend/.env');
  });

  it('leaves unrelated errors unchanged', () => {
    const message = 'trace processor failed';

    expect(explainClaudeRuntimeError(message)).toBe(message);
  });

  it('classifies Claude usage limit messages as quota errors', () => {
    expect(isClaudeQuotaError("You've hit your limit · resets 1am (Asia/Shanghai)")).toBe(true);
    expect(isClaudeQuotaError('rate limit exceeded')).toBe(true);
    expect(isClaudeQuotaError('trace processor failed')).toBe(false);
  });

  it('detects SDK native-binary-missing errors and points at CLAUDE_BINARY_PATH (zh-CN)', () => {
    const sdkError = 'Claude Code native binary not found at /app/backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.';
    const explained = explainClaudeRuntimeError(sdkError, 'zh-CN');

    expect(explained).toContain(sdkError);
    expect(explained).toContain('CLAUDE_BINARY_PATH');
    expect(explained).toContain('docker exec');
    expect(explained).toContain('原生二进制');
    // Must NOT be misclassified as a quota/auth issue
    expect(explained).not.toContain('CC Switch');
  });

  it('detects SDK native-binary-missing errors in English mode', () => {
    const sdkError = 'Claude Code native binary not found at /app/backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude.';
    const explained = explainClaudeRuntimeError(sdkError, 'en');

    expect(explained).toContain('CLAUDE_BINARY_PATH');
    expect(explained).toContain('platform detection failed');
    expect(explained).not.toContain('CC Switch');
  });

  it('explains malformed Anthropic-compatible proxy responses without quota wording', () => {
    const explained = explainClaudeRuntimeError('HTTP 200 proxy returned empty or malformed response', 'en');

    expect(explained).toContain('Anthropic-compatible Messages API');
    expect(explained).toContain('OpenAI-compatible path');
    expect(explained).not.toContain('CC Switch');
  });
});

describe('createSdkEnv', () => {
  it('disables nonessential Claude Code subprocess traffic by default', () => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    delete process.env.DISABLE_TELEMETRY;
    delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    delete process.env.DISABLE_ERROR_REPORTING;

    const env = createSdkEnv(null);

    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0');
    expect(env.DISABLE_ERROR_REPORTING).toBe('1');
  });
});

describe('getSdkBinaryOption — auto fallback', () => {
  let accessSyncSpy: jest.SpiedFunction<typeof fs.accessSync>;
  let readdirSyncSpy: jest.SpiedFunction<typeof fs.readdirSync>;
  let originalReport: NodeJS.Process['report'];
  const ORIGINAL_BINARY_PATH = process.env.CLAUDE_BINARY_PATH;

  beforeEach(() => {
    resetSdkBinaryOptionCache();
    delete process.env.CLAUDE_BINARY_PATH;
    accessSyncSpy = jest.spyOn(fs, 'accessSync');
    readdirSyncSpy = jest.spyOn(fs, 'readdirSync');
    originalReport = process.report;
  });

  afterEach(() => {
    accessSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    Object.defineProperty(process, 'report', { value: originalReport, configurable: true });
    if (ORIGINAL_BINARY_PATH === undefined) {
      delete process.env.CLAUDE_BINARY_PATH;
    } else {
      process.env.CLAUDE_BINARY_PATH = ORIGINAL_BINARY_PATH;
    }
    resetSdkBinaryOptionCache();
  });

  function mockGlibcReport(glibcVersion: string | undefined): void {
    Object.defineProperty(process, 'report', {
      value: { getReport: () => ({ header: { glibcVersionRuntime: glibcVersion } }) },
      configurable: true,
    });
  }

  function expectedAnthropicDir(): string {
    const sdkMain = require.resolve('@anthropic-ai/claude-agent-sdk');
    return path.resolve(path.dirname(sdkMain), '..');
  }

  /** accessSync mock that throws ENOENT for any path NOT in the allowlist. */
  function mockBinariesPresent(...allowedPaths: string[]): void {
    accessSyncSpy.mockImplementation((p) => {
      if (!allowedPaths.includes(String(p))) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    });
  }

  it('explicit CLAUDE_BINARY_PATH wins and bypasses fs probing', () => {
    process.env.CLAUDE_BINARY_PATH = '/custom/claude';
    const opt = getSdkBinaryOption();

    expect(opt).toEqual({ pathToClaudeCodeExecutable: '/custom/claude' });
    expect(accessSyncSpy).not.toHaveBeenCalled();
    expect(getClaudeSdkBinaryDiagnostics().source).toBe('env-override');
  });

  it('explicit override reads from passed env, not just process.env', () => {
    delete process.env.CLAUDE_BINARY_PATH;
    const opt = getSdkBinaryOption({ CLAUDE_BINARY_PATH: '/passed/claude' });
    expect(opt).toEqual({ pathToClaudeCodeExecutable: '/passed/claude' });
  });

  it('picks SDK default variant when its binary exists', () => {
    if (process.platform !== 'linux') return; // linux-only branch
    mockGlibcReport('2.36');
    const dir = expectedAnthropicDir();
    const expected = path.join(dir, `claude-agent-sdk-linux-${process.arch}`, 'claude');
    mockBinariesPresent(expected);

    const opt = getSdkBinaryOption();
    expect(opt.pathToClaudeCodeExecutable).toBe(expected);

    const diag = getClaudeSdkBinaryDiagnostics();
    expect(diag.source).toBe('sdk-default');
    expect(diag.fallbackUsed).toBe(false);
    expect(diag.detectedPlatformKey).toBe(`linux-${process.arch}`);
  });

  it('falls back to a sibling variant when SDK default is missing', () => {
    if (process.platform !== 'linux') return; // linux-only branch
    mockGlibcReport(undefined); // SDK would pick -musl
    const dir = expectedAnthropicDir();
    const muslPath = path.join(dir, `claude-agent-sdk-linux-${process.arch}-musl`, 'claude');
    const glibcPath = path.join(dir, `claude-agent-sdk-linux-${process.arch}`, 'claude');

    mockBinariesPresent(glibcPath);
    readdirSyncSpy.mockReturnValue([
      { name: `claude-agent-sdk-linux-${process.arch}`, isDirectory: () => true },
      { name: `claude-agent-sdk-linux-${process.arch}-musl`, isDirectory: () => true },
      { name: 'claude-agent-sdk', isDirectory: () => true },
    ] as unknown as never);

    const opt = getSdkBinaryOption();
    expect(opt.pathToClaudeCodeExecutable).toBe(glibcPath);
    expect(opt.pathToClaudeCodeExecutable).not.toBe(muslPath);

    const diag = getClaudeSdkBinaryDiagnostics();
    expect(diag.source).toBe('fallback');
    expect(diag.fallbackUsed).toBe(true);
  });

  it('returns {} and reports source=none when nothing is found', () => {
    if (process.platform !== 'linux') return; // linux-only branch
    mockGlibcReport('2.36');
    mockBinariesPresent(); // nothing exists
    readdirSyncSpy.mockReturnValue([] as unknown as never);

    expect(getSdkBinaryOption()).toEqual({});
    expect(getClaudeSdkBinaryDiagnostics().source).toBe('none');
  });

  it('memoizes auto-detection across calls', () => {
    if (process.platform !== 'linux') return; // linux-only branch
    mockGlibcReport('2.36');
    const dir = expectedAnthropicDir();
    const expected = path.join(dir, `claude-agent-sdk-linux-${process.arch}`, 'claude');
    mockBinariesPresent(expected);

    getSdkBinaryOption();
    const callsAfterFirst = accessSyncSpy.mock.calls.length;
    getSdkBinaryOption();
    getSdkBinaryOption();
    expect(accessSyncSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('skips process.report.getReport on env-override (hot health-poll path)', () => {
    process.env.CLAUDE_BINARY_PATH = '/custom/claude';
    const reportSpy = jest.fn(() => ({ header: { glibcVersionRuntime: '2.36' } }));
    Object.defineProperty(process, 'report', {
      value: { getReport: reportSpy },
      configurable: true,
    });

    getClaudeSdkBinaryDiagnostics();
    getClaudeSdkBinaryDiagnostics();
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('swallows probe errors and returns {} (never crashes the runtime)', () => {
    accessSyncSpy.mockImplementation(() => { throw new Error('EACCES'); });
    readdirSyncSpy.mockImplementation(() => { throw new Error('EACCES'); });

    expect(() => getSdkBinaryOption()).not.toThrow();
    expect(getSdkBinaryOption()).toEqual({});
  });
});
