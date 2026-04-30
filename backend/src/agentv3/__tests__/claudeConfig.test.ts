// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it } from '@jest/globals';
import { createQuickConfig, loadClaudeConfig } from '../claudeConfig';

const ORIGINAL_QUICK_MAX_TURNS = process.env.CLAUDE_QUICK_MAX_TURNS;

afterEach(() => {
  if (ORIGINAL_QUICK_MAX_TURNS === undefined) {
    delete process.env.CLAUDE_QUICK_MAX_TURNS;
  } else {
    process.env.CLAUDE_QUICK_MAX_TURNS = ORIGINAL_QUICK_MAX_TURNS;
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
