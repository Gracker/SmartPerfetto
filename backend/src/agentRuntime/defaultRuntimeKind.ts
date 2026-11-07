// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The runtime an analysis uses when neither a provider nor
 * SMARTPERFETTO_AGENT_RUNTIME selects one. Pi Agent Core is the default; an
 * env-only setup that already carries Claude credentials (Anthropic key or
 * token, Bedrock, Vertex) keeps the Claude Agent SDK, so legacy `.env` users
 * are never moved silently. Runtime selection and the env provider snapshot
 * both read this one rule.
 */
export function defaultEnvRuntimeKind(
  env: Record<string, string | undefined> = process.env,
): 'claude-agent-sdk' | 'pi-agent-core' {
  // Lazy: the Claude config module pulls in strategy loading; selection and snapshots stay cycle-free.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {hasClaudeCredentials} = require('./engines/claude/claudeConfig') as typeof import('./engines/claude/claudeConfig');
  return hasClaudeCredentials(env) ? 'claude-agent-sdk' : 'pi-agent-core';
}
