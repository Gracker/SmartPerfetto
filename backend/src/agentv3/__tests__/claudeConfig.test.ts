// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it } from '@jest/globals';
import {
  createQuickConfig,
  explainClaudeRuntimeError,
  getClaudeRuntimeDiagnostics,
  loadClaudeConfig,
} from '../claudeConfig';

const ORIGINAL_QUICK_MAX_TURNS = process.env.CLAUDE_QUICK_MAX_TURNS;
const ORIGINAL_ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_CLAUDE_MODEL = process.env.CLAUDE_MODEL;
const ORIGINAL_CLAUDE_LIGHT_MODEL = process.env.CLAUDE_LIGHT_MODEL;
const ORIGINAL_CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;

afterEach(() => {
  if (ORIGINAL_QUICK_MAX_TURNS === undefined) {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
  } else {
    process.env.CLAUDE_QUICK_MAX_TURNS = ORIGINAL_QUICK_MAX_TURNS;
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
});

describe('createQuickConfig', () => {
  it('keeps the existing quick max-turn default', () => {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 30 }));

    expect(config.maxTurns).toBe(5);
    expect(config.enableVerification).toBe(false);
    expect(config.enableSubAgents).toBe(false);
  });

  it('allows quick max-turn override via env', () => {
    process.env.CLAUDE_QUICK_MAX_TURNS = '8';
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 30 }));

    expect(config.maxTurns).toBe(8);
  });

  it('ignores invalid quick max-turn env values', () => {
    process.env.CLAUDE_QUICK_MAX_TURNS = '0';
    const config = createQuickConfig(loadClaudeConfig({ maxTurns: 30 }));

    expect(config.maxTurns).toBe(5);
  });
});

describe('getClaudeRuntimeDiagnostics', () => {
  it('reports Anthropic-compatible proxy mode', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:3000';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.CLAUDE_MODEL = 'mimo-main';
    process.env.CLAUDE_LIGHT_MODEL = 'mimo-light';

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.runtime).toBe('claude-agent-sdk');
    expect(diagnostics.providerMode).toBe('anthropic_compatible_proxy');
    expect(diagnostics.model).toBe('mimo-main');
    expect(diagnostics.lightModel).toBe('mimo-light');
    expect(diagnostics.configured).toBe(true);
    expect(diagnostics.credentialSources).toContain('anthropic_compatible_proxy');
  });

  it('reports unconfigured mode when no credential source is set', () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;

    const diagnostics = getClaudeRuntimeDiagnostics();

    expect(diagnostics.providerMode).toBe('unconfigured');
    expect(diagnostics.configured).toBe(false);
  });
});

describe('explainClaudeRuntimeError', () => {
  it('adds provider guidance for quota/auth failures', () => {
    const message = explainClaudeRuntimeError("You're out of extra usage");

    expect(message).toContain("You're out of extra usage");
    expect(message).toContain('ANTHROPIC_BASE_URL');
    expect(message).toContain('CC Switch');
  });

  it('leaves unrelated errors unchanged', () => {
    const message = 'trace processor failed';

    expect(explainClaudeRuntimeError(message)).toBe(message);
  });
});
