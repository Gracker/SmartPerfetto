// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_AGENT_QUICK_MAX_TURNS,
  DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
  DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
  resolveAgentRuntimeBudgetConfig,
  resolveAgentSessionConfig,
} from '../index';

describe('agent runtime budget config', () => {
  it('uses shared defaults when env is empty', () => {
    expect(resolveAgentRuntimeBudgetConfig({})).toEqual({
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      quickMaxTurns: DEFAULT_AGENT_QUICK_MAX_TURNS,
    });
  });

  it('accepts positive shared turn budget overrides', () => {
    expect(resolveAgentRuntimeBudgetConfig({
      AGENT_MAX_TURNS: '90',
      AGENT_QUICK_MAX_TURNS: '15',
    })).toEqual({
      maxTurns: 90,
      quickMaxTurns: 15,
    });
  });

  it('ignores non-positive shared turn budget overrides', () => {
    expect(resolveAgentRuntimeBudgetConfig({
      AGENT_MAX_TURNS: '0',
      AGENT_QUICK_MAX_TURNS: '-1',
    })).toEqual({
      maxTurns: DEFAULT_AGENT_MAX_TURNS,
      quickMaxTurns: DEFAULT_AGENT_QUICK_MAX_TURNS,
    });
  });
});

describe('agent session config', () => {
  it('retains assistant sessions for 12 hours by default', () => {
    expect(resolveAgentSessionConfig({})).toEqual({
      terminalMaxIdleMs: DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      nonTerminalMaxIdleMs: DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      contextMaxAgeMs: DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      cleanupIntervalMs: DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
    });
  });

  it('keeps context TTL aligned with non-terminal retention unless overridden', () => {
    expect(resolveAgentSessionConfig({
      AGENT_TERMINAL_SESSION_MAX_IDLE_MS: '1000',
      AGENT_NON_TERMINAL_SESSION_MAX_IDLE_MS: '2000',
    })).toEqual({
      terminalMaxIdleMs: 1000,
      nonTerminalMaxIdleMs: 2000,
      contextMaxAgeMs: 2000,
      cleanupIntervalMs: DEFAULT_AGENT_SESSION_CLEANUP_INTERVAL_MS,
    });
  });

  it('allows explicit context TTL and cleanup cadence overrides', () => {
    expect(resolveAgentSessionConfig({
      AGENT_SESSION_CONTEXT_MAX_AGE_MS: '3000',
      AGENT_SESSION_CLEANUP_INTERVAL_MS: '4000',
    })).toEqual({
      terminalMaxIdleMs: DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      nonTerminalMaxIdleMs: DEFAULT_AGENT_SESSION_MAX_IDLE_MS,
      contextMaxAgeMs: 3000,
      cleanupIntervalMs: 4000,
    });
  });
});
