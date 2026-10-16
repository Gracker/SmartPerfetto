// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ProviderTuning } from './types';

/**
 * Tuning knobs no runtime reads any more. A stored profile, or a client built
 * before their removal, may still carry them: they are dropped wherever a
 * profile enters the product (store reads, create, update), so no surface
 * shows them and the next save writes the profile without them. They bounded
 * and toggled the Claude LLM verifier, which the product-owned finalization
 * review replaced.
 */
const RETIRED_TUNING_KEYS: readonly string[] = ['verifierTimeoutMs', 'enableVerification'];

export function withoutRetiredTuning<T extends ProviderTuning | null | undefined>(tuning: T): T {
  if (!tuning || !RETIRED_TUNING_KEYS.some(key => Object.prototype.hasOwnProperty.call(tuning, key))) return tuning;
  return Object.fromEntries(Object.entries(tuning).filter(([key]) => !RETIRED_TUNING_KEYS.includes(key))) as T;
}
