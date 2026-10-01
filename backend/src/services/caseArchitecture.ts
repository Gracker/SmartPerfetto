// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { RENDERING_ARCHITECTURE_TYPES } from '../agent/detectors/types';
import type { CaseNode } from '../types/sparkContracts';

/**
 * Which rendering architectures a case applies to.
 *
 * A case declares `context.app_architecture` in the detector's own vocabulary
 * (`RENDERING_ARCHITECTURE_TYPES`, spelled lowercase), so the mapping to a
 * trace's detected type is a case change and nothing else: `any`, one
 * architecture, or a list of them. `unknown` is not a declaration; a case
 * whose architecture nobody established is excluded wherever the trace's
 * architecture is known.
 */
export const CASE_APP_ARCHITECTURE_FIELD = 'app_architecture';
const ANY_ARCHITECTURE = 'any';

const CASE_ARCHITECTURES: ReadonlySet<unknown> = new Set(
  RENDERING_ARCHITECTURE_TYPES
    .filter(type => type !== 'UNKNOWN')
    .map(type => type.toLowerCase()),
);

/** The Markdown contract: `any`, or one or more distinct architectures in their canonical spelling. */
export function validateCaseAppArchitecture(value: unknown): {ok: true} | {ok: false; message: string} {
  if (value === ANY_ARCHITECTURE) return {ok: true};
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 0 && new Set(values).size === values.length && values.every(item => CASE_ARCHITECTURES.has(item))) {
    return {ok: true};
  }
  return {
    ok: false,
    message:
      `context.${CASE_APP_ARCHITECTURE_FIELD} must be '${ANY_ARCHITECTURE}', one of ` +
      `${[...CASE_ARCHITECTURES].join(', ')}, or a non-empty list of distinct architectures`,
  };
}

/** The case spelling of a detected architecture; undefined when it names none. */
function caseArchitectureFromDetector(type: unknown): string | undefined {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : undefined;
  return CASE_ARCHITECTURES.has(normalized) ? normalized : undefined;
}

/**
 * The declaration for a case learned from a trace: the architecture that trace
 * was detected as, or none when detection did not establish one.
 */
export function detectedCaseArchitecture(type: unknown): Record<string, string> {
  const architecture = caseArchitectureFromDetector(type);
  return architecture ? {[CASE_APP_ARCHITECTURE_FIELD]: architecture} : {};
}

/**
 * Whether a case may be offered to a trace of `traceArchitectureType`.
 *
 * A trace whose architecture is unknown cannot rule a case out. Otherwise a
 * case carrying case knowledge must declare `any` or the trace's architecture;
 * an absent or non-canonical declaration (a case stored before this contract,
 * or written through a path that bypasses the validator) does not apply.
 * Manual cases without case knowledge are found by their App/Device/CUJ key
 * and declare no architecture to check.
 */
export function caseAppliesToArchitecture(
  caseNode: Pick<CaseNode, 'knowledge'>,
  traceArchitectureType: string | undefined,
): boolean {
  const traceArchitecture = caseArchitectureFromDetector(traceArchitectureType);
  if (!traceArchitecture || !caseNode.knowledge) return true;
  const declared = caseNode.knowledge.context[CASE_APP_ARCHITECTURE_FIELD];
  const values = Array.isArray(declared) ? declared : [declared];
  return values.some(value => value === ANY_ARCHITECTURE || value === traceArchitecture);
}
