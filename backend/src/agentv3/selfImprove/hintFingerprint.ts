// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Canonical-form fingerprint for `phase_hints` entries.
 *
 * The canonical form intentionally excludes `id` (auto-generated hint ids
 * were derived from the fingerprint, so including it would be circular).
 * It keeps `critical` because that *is* a semantic property of the hint
 * that should differentiate two hints with otherwise identical content.
 */

import { createHash } from 'crypto';

export interface CanonicalHintInput {
  keywords: ReadonlyArray<string>;
  constraints: string;
  criticalTools: ReadonlyArray<string>;
  critical: boolean;
}

/**
 * Compute a 16-char hex fingerprint of a phase_hint's canonical form.
 * Used by `strategyFingerprint` for drift detection of stored hints.
 */
export function computeHintFingerprint(input: CanonicalHintInput): string {
  const canonical = {
    keywords: [...input.keywords].map(s => s.trim().toLowerCase()).sort(),
    constraints: (input.constraints || '').trim(),
    criticalTools: [...input.criticalTools].map(s => s.trim().toLowerCase()).sort(),
    critical: input.critical === true,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').substring(0, 16);
}
