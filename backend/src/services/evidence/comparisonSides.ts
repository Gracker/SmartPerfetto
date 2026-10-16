// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {EvidenceContextV1} from '../../types/evidenceContract';

type ComparisonSideContext = Pick<EvidenceContextV1, 'traceId' | 'traceSide'>;

/**
 * - `applies`: current minus reference, both traces known.
 * - `trace_context_missing`: current minus reference, a trace unknown.
 * - `comparison_not_cross_trace`: two current cells of one known trace. The
 *   cross-trace rule does not apply to a within-trace difference; that is not a
 *   contradiction.
 * - `comparison_side_mismatch`: anything else, including cells of different
 *   traces with a mislabelled or reversed side.
 */
export type ComparisonSideClassification =
  | 'applies'
  | 'trace_context_missing'
  | 'comparison_not_cross_trace'
  | 'comparison_side_mismatch';

const knownTrace = (traceId: string | undefined) => Boolean(traceId) && traceId !== 'unknown';

/** Shared side rule of `comparison_delta` for the relation builder and the finite claim verifier. */
export function classifyComparisonSides(left: ComparisonSideContext, right: ComparisonSideContext): ComparisonSideClassification {
  if (left.traceSide === 'current' && right.traceSide === 'reference') {
    return knownTrace(left.traceId) && knownTrace(right.traceId) ? 'applies' : 'trace_context_missing';
  }
  if (left.traceSide === 'current' && right.traceSide === 'current' &&
      knownTrace(left.traceId) && left.traceId === right.traceId) {
    return 'comparison_not_cross_trace';
  }
  return 'comparison_side_mismatch';
}
