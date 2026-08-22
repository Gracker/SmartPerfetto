// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CapabilityManifestTraceProcessorIdentityV1} from '../types/capabilityManifest';
import {
  TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION,
  type TraceSummaryAttributionReason,
  type TraceSummaryAttributionV1,
} from '../types/traceSummaryAttribution';
import type {TraceSummaryExecutionV1} from './traceSummaryExecutor';

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const MAX_METRIC_IDS = 128;
const REASONS = new Set<TraceSummaryAttributionReason>([
  'trace_identity_unavailable',
  'trace_processor_identity_unavailable',
  'trace_processor_session_unavailable',
  'trace_source_unavailable',
  'external_rpc_unsupported',
  'temp_spec_failed',
  'temp_cleanup_failed',
  'timeout',
  'output_limit',
  'process_failed',
  'invalid_output',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metricIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_METRIC_IDS) return undefined;
  const ids = value.filter((item): item is string => typeof item === 'string');
  if (ids.length !== value.length || ids.some(id => !SAFE_ID.test(id))) return undefined;
  return [...new Set(ids)].sort();
}

function traceProcessorIdentity(value: unknown): CapabilityManifestTraceProcessorIdentityV1 | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (input.source === 'bundled' && typeof input.gitRevision === 'string' && GIT_REVISION.test(input.gitRevision)) {
    return {source: 'bundled', gitRevision: input.gitRevision};
  }
  if (input.source === 'custom' && typeof input.binarySha256 === 'string' && SHA256.test(input.binarySha256)) {
    return {source: 'custom', binarySha256: input.binarySha256};
  }
  return undefined;
}

export function buildTraceSummaryAttributionV1(
  execution: TraceSummaryExecutionV1,
): TraceSummaryAttributionV1 {
  const shared = {
    schemaVersion: TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION,
    status: execution.status,
    specId: execution.spec.id,
    specDigestSha256: execution.spec.digestSha256,
  } as const;
  if (execution.status !== 'ready') {
    return {
      ...shared,
      reason: execution.reason,
      availableMetricIds: [],
      missingMetricIds: [],
    };
  }
  const traceProcessor = traceProcessorIdentity(execution.traceProcessor);
  if (!traceProcessor) throw new Error('trace_summary_attribution_invalid_ready_processor');
  return {
    ...shared,
    traceFingerprintSha256: execution.trace.fingerprintSha256,
    traceProcessor,
    resultDigestSha256: execution.resultDigestSha256,
    availableMetricIds: execution.metrics
      .filter(metric => metric.status === 'available')
      .map(metric => metric.id)
      .sort(),
    missingMetricIds: execution.metrics
      .filter(metric => metric.status === 'missing')
      .map(metric => metric.id)
      .sort(),
  };
}

export function sanitizeStoredTraceSummaryAttribution(
  value: unknown,
): TraceSummaryAttributionV1 | undefined {
  const input = record(value);
  if (!input || input.schemaVersion !== TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION) return undefined;
  if (typeof input.specId !== 'string' || !SAFE_ID.test(input.specId) ||
    typeof input.specDigestSha256 !== 'string' || !SHA256.test(input.specDigestSha256)) {
    return undefined;
  }
  const availableMetricIds = metricIds(input.availableMetricIds);
  const missingMetricIds = metricIds(input.missingMetricIds);
  if (!availableMetricIds || !missingMetricIds ||
    availableMetricIds.some(id => missingMetricIds.includes(id))) return undefined;

  if (input.status === 'ready') {
    if (input.reason !== undefined || typeof input.traceFingerprintSha256 !== 'string' ||
      !SHA256.test(input.traceFingerprintSha256) || typeof input.resultDigestSha256 !== 'string' ||
      !SHA256.test(input.resultDigestSha256)) return undefined;
    const traceProcessor = traceProcessorIdentity(input.traceProcessor);
    if (!traceProcessor) return undefined;
    return {
      schemaVersion: TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION,
      status: 'ready',
      specId: input.specId,
      specDigestSha256: input.specDigestSha256,
      traceFingerprintSha256: input.traceFingerprintSha256,
      traceProcessor,
      resultDigestSha256: input.resultDigestSha256,
      availableMetricIds,
      missingMetricIds,
    };
  }

  if ((input.status !== 'unavailable' && input.status !== 'error') ||
    typeof input.reason !== 'string' || !REASONS.has(input.reason as TraceSummaryAttributionReason) ||
    input.traceFingerprintSha256 !== undefined || input.traceProcessor !== undefined ||
    input.resultDigestSha256 !== undefined || availableMetricIds.length > 0 || missingMetricIds.length > 0) {
    return undefined;
  }
  return {
    schemaVersion: TRACE_SUMMARY_ATTRIBUTION_SCHEMA_VERSION,
    status: input.status,
    specId: input.specId,
    specDigestSha256: input.specDigestSha256,
    availableMetricIds: [],
    missingMetricIds: [],
    reason: input.reason as TraceSummaryAttributionReason,
  };
}
