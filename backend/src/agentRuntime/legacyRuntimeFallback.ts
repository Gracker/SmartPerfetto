// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import logger from '../utils/logger';
import {
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  isRecordedRuntimeKind,
  type AgentRuntimeKind,
} from './runtimeKinds';

/**
 * Pi Agent Core is the only selectable runtime. For one release the Claude
 * Agent SDK and OpenAI Agents SDK engines stay reachable through this
 * maintainer-only opt-in, which is read from the process environment alone:
 * a provider profile, its env overrides and its generated env never carry it.
 * When set it outranks the provider record, and every recorded runtime pin
 * (session snapshot, conversation descriptor, CLI session) resolves through
 * the same function, so a pin and the engine that runs it always agree.
 */
export const LEGACY_AGENT_RUNTIME_ENV = 'SMARTPERFETTO_LEGACY_AGENT_RUNTIME';

const LEGACY_FALLBACK_RUNTIME_KINDS = [CLAUDE_AGENT_RUNTIME_KIND, OPENAI_AGENT_RUNTIME_KIND] as const;

export type LegacyFallbackRuntimeKind = typeof LEGACY_FALLBACK_RUNTIME_KINDS[number];

const warned = new Set<string>();

const legacyActiveMessage = (kind: string) => `${LEGACY_AGENT_RUNTIME_ENV}=${kind} keeps the deprecated ${kind} engine ` +
  'for the provider profiles and env setup that ran on it, for this release only; everything else runs on Pi Agent ' +
  'Core. Unset it to run Pi Agent Core everywhere.';
const agentRuntimeEnvDeprecatedMessage = (value: string) => `SMARTPERFETTO_AGENT_RUNTIME=${value} is deprecated: ` +
  'analysis runs on Pi Agent Core with the same endpoint, model and credentials. Remove the variable.';
const retiredExperimentalMessage = (key: string) =>
  `${key} is retired and ignored: Pi Agent Core is the production runtime.`;

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn('AgentRuntime', message);
}

/** The hidden legacy runtime, or undefined when Pi runs. An unknown value fails closed. */
export function legacyAgentRuntimeFallback(): LegacyFallbackRuntimeKind | undefined {
  const raw = process.env[LEGACY_AGENT_RUNTIME_ENV]?.trim();
  if (!raw) return undefined;
  if (!(LEGACY_FALLBACK_RUNTIME_KINDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unsupported ${LEGACY_AGENT_RUNTIME_ENV}="${raw}". Use "${CLAUDE_AGENT_RUNTIME_KIND}" or ` +
      `"${OPENAI_AGENT_RUNTIME_KIND}", or unset it to run Pi Agent Core.`,
    );
  }
  warnOnce(`legacy:${raw}`, legacyActiveMessage(raw));
  return raw as LegacyFallbackRuntimeKind;
}

/** The runtime every analysis runs on now: the legacy opt-in when set, else Pi Agent Core. */
export function effectiveAgentRuntimeKind(): AgentRuntimeKind {
  return legacyAgentRuntimeFallback() ?? PI_AGENT_CORE_RUNTIME_KIND;
}

/**
 * `SMARTPERFETTO_AGENT_RUNTIME` from an existing `.env`: every value it ever
 * accepted now selects the effective runtime (a non-Pi value logs one
 * deprecation warning), so an upgrade never moves an env-only user to an error.
 * An unknown value still fails closed. Undefined when the variable is unset.
 */
export function agentRuntimeFromEnv(value = process.env.SMARTPERFETTO_AGENT_RUNTIME): AgentRuntimeKind | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!isRecordedRuntimeKind(raw)) {
    throw new Error(
      `Unsupported SMARTPERFETTO_AGENT_RUNTIME="${raw}". Pi Agent Core is the only runtime; remove the variable.`,
    );
  }
  if (raw !== PI_AGENT_CORE_RUNTIME_KIND) {
    warnOnce(`env:${raw}`, agentRuntimeEnvDeprecatedMessage(raw));
  }
  return effectiveAgentRuntimeKind();
}

const RETIRED_EXPERIMENTAL_RUNTIME_ENV_KEYS = [
  'SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME',
  'SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME',
] as const;

/** The retired experimental runtime switches select nothing any more; each logs one warning. */
export function warnRetiredExperimentalRuntimeEnv(): void {
  for (const key of RETIRED_EXPERIMENTAL_RUNTIME_ENV_KEYS) {
    if (process.env[key]?.trim()) {
      warnOnce(`experimental:${key}`, retiredExperimentalMessage(key));
    }
  }
}

/** Deprecations the doctor and health reports show for the current process environment. */
export function runtimeDeprecationNotices(env: Record<string, string | undefined> = process.env): string[] {
  const notices: string[] = [];
  const legacy = env[LEGACY_AGENT_RUNTIME_ENV]?.trim();
  if (legacy) notices.push(legacyActiveMessage(legacy));
  const selected = env.SMARTPERFETTO_AGENT_RUNTIME?.trim();
  if (selected && selected !== PI_AGENT_CORE_RUNTIME_KIND) notices.push(agentRuntimeEnvDeprecatedMessage(selected));
  for (const key of RETIRED_EXPERIMENTAL_RUNTIME_ENV_KEYS) {
    if (env[key]?.trim()) notices.push(retiredExperimentalMessage(key));
  }
  return notices;
}

/** @internal Test seam: deprecation warnings are logged once per process. */
export function resetRuntimeDeprecationWarningsForTests(): void {
  warned.clear();
}
