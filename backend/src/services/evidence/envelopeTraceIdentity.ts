// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {DataEnvelope} from '../../types/dataContract';

type TraceMarkKey = 'traceSide' | 'traceId' | 'paneSide';
type TraceMarks = Partial<Record<TraceMarkKey, unknown>>;

/**
 * A trace marking on an envelope. Producers stamp it on `meta`, on the
 * envelope itself or in its `traceProvenance`; the first non-empty one wins.
 */
export function envelopeTraceValue(env: DataEnvelope, key: TraceMarkKey): string | undefined {
  const marked = env as DataEnvelope & TraceMarks & {traceProvenance?: TraceMarks};
  for (const marks of [env.meta as TraceMarks, marked, marked.traceProvenance]) {
    const value = marks?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Whether an envelope measured the session's own trace. A raw-trace comparison
 * session also holds reference-trace envelopes: one marked as the reference
 * side, or stamped with a trace id other than `traceId` (when known), measured
 * a different trace. An unmarked envelope is the session's own trace, so this
 * serves display, navigation and metrics; evidence admission must keep
 * requiring an exact issued `meta` marking.
 */
export function measuresTrace(env: DataEnvelope, traceId: string | undefined): boolean {
  if (envelopeTraceValue(env, 'traceSide') === 'reference') return false;
  const envelopeTraceId = envelopeTraceValue(env, 'traceId');
  return !traceId || envelopeTraceId === undefined || envelopeTraceId === traceId;
}
