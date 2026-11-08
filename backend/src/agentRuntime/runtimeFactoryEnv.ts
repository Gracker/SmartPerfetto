// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getProviderService, type ProviderScope } from '../services/providerManager';
import { runtimeEnvFor } from '../services/providerManager/piProviderCatalog';
import type { RuntimeSelection } from './runtimeSelection';
import { warnRetiredOutputEnv } from './finalSubmissionConfig';

export type RuntimeFactoryEnv = Record<string, string | undefined>;

/**
 * The env a runtime is created with: a selected provider's isolated env, or
 * the process env. An env-only Pi selection also gets the Pi model the
 * retired runtime's Claude/OpenAI/Bedrock/Vertex env maps to.
 */
export function createRuntimeFactoryEnv(
  selection: Pick<RuntimeSelection<string>, 'source' | 'providerId'> & {kind?: string},
  providerScope?: ProviderScope,
  baseEnv: Record<string, string | undefined> = process.env,
): RuntimeFactoryEnv {
  const providerEnv = selection.source === 'provider' && selection.providerId
    ? getProviderService().getEnvForProvider(selection.providerId, providerScope)
    : null;
  const env = runtimeEnvFor(baseEnv, providerEnv, selection.kind);
  // The configuration boundary every runtime's environment passes through.
  warnRetiredOutputEnv(env);
  return env;
}
