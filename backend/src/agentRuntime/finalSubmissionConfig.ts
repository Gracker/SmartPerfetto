// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {getFinalSubmissionModeDescriptor, type FinalSubmissionModeKey} from './finalSubmissionImplementation';

/**
 * Retired output selectors. Every run now delivers the model's plain
 * assistant answer with no authored declaration; a value left in an operator
 * environment is ignored with one process-wide warning rather than failing runs.
 */
const RETIRED_OUTPUT_ENV = Object.freeze({
  finalSubmission: 'SMARTPERFETTO_FINAL_SUBMISSION',
  conclusionAuthoring: 'SMARTPERFETTO_CONCLUSION_AUTHORING',
});

/** Mode labels that historical manifests and receipts may carry; production records only `assistant_text`. */
export type FinalSubmissionMode = FinalSubmissionModeKey;

/** The only output every run delivers, as manifests and applied-control receipts record it. */
export const ANALYSIS_OUTPUT_CONFIG = Object.freeze({finalSubmission: 'assistant_text' as const});

export function isFinalSubmissionMode(value: unknown): value is FinalSubmissionMode {
  return getFinalSubmissionModeDescriptor(value) !== undefined;
}

let retiredOutputEnvWarned = false;

/** Warn once per process when runtime configuration still sets a retired selector. Never echoes values. */
export function warnRetiredOutputEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (retiredOutputEnvWarned) return;
  const finalSubmission = env[RETIRED_OUTPUT_ENV.finalSubmission];
  const authoring = env[RETIRED_OUTPUT_ENV.conclusionAuthoring];
  const stale = (finalSubmission !== undefined && finalSubmission !== '' && finalSubmission !== 'assistant_text') ||
    (authoring !== undefined && authoring !== '');
  if (!stale) return;
  retiredOutputEnvWarned = true;
  console.warn(`[OutputConfig] ${RETIRED_OUTPUT_ENV.finalSubmission} and ${RETIRED_OUTPUT_ENV.conclusionAuthoring} ` +
    'are retired and ignored; analyses deliver plain assistant answers.');
}
