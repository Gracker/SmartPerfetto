// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {QueryResult} from './traceProcessorService';

export type OriginalTraceEvidenceRefusalReason =
  | 'reader_unavailable'
  | 'trace_not_authorized'
  | 'source_unavailable'
  | 'unsupported_query'
  | 'processor_unavailable'
  | 'capacity_unavailable';

/** Only emitted before the requested SQL is dispatched. Never carries native errors. */
export class OriginalTraceEvidenceRefusal extends Error {
  readonly executed = false;
  constructor(readonly reason: OriginalTraceEvidenceRefusalReason) {
    super('original_trace_refused');
    this.name = 'OriginalTraceEvidenceRefusal';
  }
}

/** The query failed without a QueryResult; its execution cannot be asserted. */
export class OriginalTraceEvidenceQueryUnknownError extends Error {
  readonly execution = 'unknown';
  readonly code = 'original_trace_execution_unknown';
  constructor() {
    super('original_trace_execution_unknown');
    this.name = 'OriginalTraceEvidenceQueryUnknownError';
  }
}

export interface OriginalTraceEvidenceQueryOptions {
  readonly signal?: AbortSignal;
  readonly assertAuthorized: () => void;
}

/** Internal run-group closure; neither this function nor a lease is a tool argument. */
export type RunOwnedOriginalTraceReader = (
  traceId: string, rawSql: string, options: OriginalTraceEvidenceQueryOptions,
) => Promise<QueryResult>;
