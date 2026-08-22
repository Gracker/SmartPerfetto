// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CapabilityManifestTraceProcessorIdentityV1} from './capabilityManifest';

export const TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION =
  'trace_summary_attribution@1' as const;

export type TraceSummaryAttributionReason =
  | 'trace_identity_unavailable'
  | 'trace_processor_identity_unavailable'
  | 'trace_processor_session_unavailable'
  | 'trace_source_unavailable'
  | 'external_rpc_unsupported'
  | 'temp_spec_failed'
  | 'temp_cleanup_failed'
  | 'timeout'
  | 'output_limit'
  | 'process_failed'
  | 'invalid_output';

export interface TraceSummaryAttributionV1 {
  schemaVersion: typeof TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION;
  status: 'ready' | 'unavailable' | 'error';
  specId: string;
  specDigestSha256: string;
  traceFingerprintSha256?: string;
  traceProcessor?: CapabilityManifestTraceProcessorIdentityV1;
  resultDigestSha256?: string;
  availableMetricIds: string[];
  missingMetricIds: string[];
  reason?: TraceSummaryAttributionReason;
}
