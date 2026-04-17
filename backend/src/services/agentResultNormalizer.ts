// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared "normalize an AnalysisResult before it reaches the user" helpers.
 *
 * Both delivery paths (HTTP SSE and CLI HTML report) need to:
 *   1. Run the conclusion text through `normalizeConclusionOutput` when the
 *      heuristic says to (see `shouldNormalizeConclusionOutput`).
 *   2. Sanitize user-facing narrative text (strip internal evidence IDs,
 *      replace legacy phrases).
 *   3. If the orchestrator didn't populate `conclusionContract`, derive one
 *      from the normalized conclusion using a rounds-based mode heuristic.
 *
 * HTTP route used to inline all of this in `sendAgentDrivenResult`. CLI's
 * `buildReportHtml` skipped the step entirely, so the CLI-produced HTML
 * diverged from the web UI for the same session. Centralize the logic
 * here so `buildAgentDrivenReportData` receives an already-normalized
 * result regardless of the delivery path.
 */

import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { sanitizeNarrativeForClient } from '../routes/narrativeSanitizer';
import type { AnalysisResult } from '../agent/core/orchestratorTypes';

/**
 * Normalize a conclusion string for end-user display. Safe to call on any
 * input; falls back to the original text when normalization would empty it.
 */
export function normalizeNarrativeForClient(narrative: string): string {
  const raw = String(narrative || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  let normalized = raw;
  if (shouldNormalizeConclusionOutput(trimmed)) {
    try {
      normalized = normalizeConclusionOutput(trimmed).trim() || raw;
    } catch {
      normalized = raw;
    }
  }

  return sanitizeNarrativeForClient(normalized) || normalized;
}

/**
 * Normalize an AnalysisResult's conclusion + re-derive its conclusionContract
 * (if missing) using the same rounds-based mode heuristic the HTTP path uses.
 * Returns the input unchanged when no fields would actually change, so the
 * identity check in callers (`result === normalized`) stays cheap.
 */
export function normalizeResultForReport(result: AnalysisResult): AnalysisResult {
  const normalizedConclusion = normalizeNarrativeForClient(result.conclusion);
  const normalizedContract =
    result.conclusionContract ||
    deriveConclusionContract(normalizedConclusion, {
      mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
    }) ||
    undefined;

  if (
    normalizedConclusion === result.conclusion &&
    normalizedContract === result.conclusionContract
  ) {
    return result;
  }
  return {
    ...result,
    conclusion: normalizedConclusion,
    conclusionContract: normalizedContract,
  };
}
