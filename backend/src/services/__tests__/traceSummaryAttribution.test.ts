// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TraceSummaryExecutionV1} from '../traceSummaryExecutor';
import {
  buildTraceSummaryAttributionV1,
  sanitizeStoredTraceSummaryAttribution,
} from '../traceSummaryAttribution';

function readyExecution(): TraceSummaryExecutionV1 {
  const definition = (id: string) => ({
    id, dimensions: [], valueColumn: id, unit: 'COUNT' as const,
    polarity: 'NOT_APPLICABLE' as const, dimensionUniqueness: 'UNIQUE' as const,
  });
  const metrics = [definition('metric_b'), definition('metric_a')];
  return {
    schemaVersion: 'trace_summary_execution@1', status: 'ready',
    spec: {schemaVersion: 'trace_summary_spec@1', id: 'smartperfetto.core.v1',
      digestSha256: 'a'.repeat(64), metricIds: metrics.map(item => item.id), metrics},
    trace: {fingerprintSha256: 'b'.repeat(64), fingerprintKind: 'trace_bytes_sha256', traceSide: 'current'},
    traceProcessor: {source: 'bundled', gitRevision: 'c'.repeat(40), reportedVersion: '/private/path'},
    resultDigestSha256: 'd'.repeat(64),
    metrics: [
      {...metrics[0], status: 'missing', missingReason: 'no_rows'},
      {...metrics[1], status: 'available', value: 7},
    ],
    durationMs: 1,
  };
}

describe('traceSummaryAttribution', () => {
  it('projects a ready execution to a sorted path-free durable contract', () => {
    const attribution = buildTraceSummaryAttributionV1(readyExecution());
    expect(attribution).toEqual({
      schemaVersion: 'trace_summary_attribution@1', status: 'ready',
      specId: 'smartperfetto.core.v1', specDigestSha256: 'a'.repeat(64),
      traceFingerprintSha256: 'b'.repeat(64),
      traceProcessor: {source: 'bundled', gitRevision: 'c'.repeat(40)},
      resultDigestSha256: 'd'.repeat(64),
      availableMetricIds: ['metric_a'], missingMetricIds: ['metric_b'],
    });
    expect(JSON.stringify(attribution)).not.toContain('/private/path');
  });

  it('projects explicit unavailable/error states without inventing identities', () => {
    const spec = readyExecution().spec;
    expect(buildTraceSummaryAttributionV1({
      schemaVersion: 'trace_summary_execution@1', status: 'unavailable', spec,
      reason: 'external_rpc_unsupported',
    })).toEqual(expect.objectContaining({
      status: 'unavailable', reason: 'external_rpc_unsupported',
      availableMetricIds: [], missingMetricIds: [],
    }));
    expect(buildTraceSummaryAttributionV1({
      schemaVersion: 'trace_summary_execution@1', status: 'error', spec,
      reason: 'timeout', durationMs: 1,
    })).toEqual(expect.objectContaining({status: 'error', reason: 'timeout'}));
  });

  it('sanitizes hostile stored input and rejects invalid ready contracts', () => {
    const canary = '/private/TRACE_SUMMARY_CANARY';
    const ready = buildTraceSummaryAttributionV1(readyExecution());
    expect(sanitizeStoredTraceSummaryAttribution({
      ...ready,
      localPath: canary,
      traceProcessor: {...ready.traceProcessor, reportedVersion: canary, localPath: canary},
      availableMetricIds: ['metric_a', 'metric_a'],
    })).toEqual(ready);
    expect(JSON.stringify(sanitizeStoredTraceSummaryAttribution({...ready, localPath: canary}))).not.toContain(canary);
    expect(sanitizeStoredTraceSummaryAttribution({...ready, resultDigestSha256: undefined})).toBeUndefined();
    expect(sanitizeStoredTraceSummaryAttribution({...ready, traceFingerprintSha256: 'bad'})).toBeUndefined();
    expect(sanitizeStoredTraceSummaryAttribution({...ready, availableMetricIds: ['same'], missingMetricIds: ['same']}))
      .toBeUndefined();
    expect(sanitizeStoredTraceSummaryAttribution({...ready, status: 'unavailable'})).toBeUndefined();
  });

  it('keeps legacy absence optional', () => {
    expect(sanitizeStoredTraceSummaryAttribution(undefined)).toBeUndefined();
    expect(sanitizeStoredTraceSummaryAttribution(null)).toBeUndefined();
  });
});
