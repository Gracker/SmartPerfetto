// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getProviderService, type ProviderScope } from '../services/providerManager';
import { mergeIsolatedProviderEnv } from '../services/providerManager/envIsolation';
import type { RuntimeSelection } from './runtimeSelection';
import { warnRetiredOutputEnv } from './finalSubmissionConfig';

export type RuntimeFactoryEnv = Record<string, string | undefined>;

export function createRuntimeFactoryEnv(
  selection: Pick<RuntimeSelection<string>, 'source' | 'providerId'>,
  providerScope?: ProviderScope,
  baseEnv: Record<string, string | undefined> = process.env,
): RuntimeFactoryEnv {
  const providerEnv = selection.source === 'provider' && selection.providerId
    ? getProviderService().getEnvForProvider(selection.providerId, providerScope)
    : null;
  const env = mergeIsolatedProviderEnv(baseEnv, providerEnv);
  // The configuration boundary every runtime's environment passes through.
  warnRetiredOutputEnv(env);
  return env;
}
