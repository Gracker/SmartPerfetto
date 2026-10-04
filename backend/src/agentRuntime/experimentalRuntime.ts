// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  isExperimentalAgentRuntimeKind,
  type ExperimentalAgentRuntimeKind,
} from './runtimeKinds';

export {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
  isExperimentalAgentRuntimeKind,
  listExperimentalRuntimeKinds,
  type ExperimentalAgentRuntimeKind,
} from './runtimeKinds';
import {parseFlagValue} from '../utils/envFlag';

export const EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV = 'SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME';
export const EXPERIMENTAL_AGENT_RUNTIME_ENV = 'SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME';

export interface ExperimentalRuntimeSelection {
  kind: ExperimentalAgentRuntimeKind;
  source: 'env';
}

export function resolveExperimentalAgentRuntimeSelection(
  env: Record<string, string | undefined> = process.env,
): ExperimentalRuntimeSelection | undefined {
  const requestedRuntime = env[EXPERIMENTAL_AGENT_RUNTIME_ENV]?.trim();
  const enabled = parseFlagValue(env[EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV]) === true;

  if (!requestedRuntime) return undefined;
  if (!enabled) {
    throw new Error(
      `${EXPERIMENTAL_AGENT_RUNTIME_ENV} requires ${EXPERIMENTAL_AGENT_RUNTIME_ENABLED_ENV}=1`,
    );
  }
  if (!isExperimentalAgentRuntimeKind(requestedRuntime)) {
    throw new Error(
      `Unsupported ${EXPERIMENTAL_AGENT_RUNTIME_ENV}="${requestedRuntime}". ` +
      `Use "${EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND}" or "${EXPERIMENTAL_OPENCODE_RUNTIME_KIND}".`,
    );
  }
  return { kind: requestedRuntime, source: 'env' };
}
