// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisCandidateIdentity} from '../types/analysisDelivery';

/** Preserve the runtime's candidate identity and property order for correlation. */
export function createOpenAiCandidateIdentity(input: Readonly<{
  runId: string;
  attemptId: string;
  conclusionFingerprint: string;
}>): AnalysisCandidateIdentity {
  return {
    runId: input.runId,
    attemptId: input.attemptId,
    candidateRef: `${input.runId}:${input.attemptId}`,
    conclusionFingerprint: input.conclusionFingerprint,
  };
}
