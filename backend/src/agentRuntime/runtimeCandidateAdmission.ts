// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV =
  'SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES';

export const RUNTIME_CANDIDATE_IDS = [
  'task4',
  'task5',
  'task6',
  'task7',
  'task8',
  'task9',
] as const;

export type RuntimeCandidateId = typeof RUNTIME_CANDIDATE_IDS[number];

const RUNTIME_CANDIDATE_ID_SET = new Set<string>(RUNTIME_CANDIDATE_IDS);

/**
 * Parse the maintainer-owned admission boundary. Any ambiguity invalidates the
 * complete value so a typo can never partially activate a performance branch.
 */
export function parseAdmittedRuntimeCandidates(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<RuntimeCandidateId> {
  const raw = env[SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV];
  if (!raw || raw.trim() !== raw) return new Set();
  const values = raw.split(',');
  if (
    values.length === 0
    || values.some(value => !RUNTIME_CANDIDATE_ID_SET.has(value))
    || new Set(values).size !== values.length
  ) {
    return new Set();
  }
  return new Set(values as RuntimeCandidateId[]);
}

export function isRuntimeCandidateAdmitted(
  candidate: RuntimeCandidateId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseAdmittedRuntimeCandidates(env).has(candidate);
}
