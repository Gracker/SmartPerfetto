// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  sanitizePublicArtifactData,
  type PublicArtifactSanitizationResult,
} from '../security/publicArtifactSanitizer';

export type ProposalSanitizationResult<T> =
  PublicArtifactSanitizationResult<T>;

export function sanitizeProposalData<T>(
  value: T,
): ProposalSanitizationResult<T> {
  return sanitizePublicArtifactData(value);
}
