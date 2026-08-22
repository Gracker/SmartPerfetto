// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  RunningTraceSummaryInput,
  TraceProcessorServiceQueryOptions,
} from './traceProcessorService';
import {
  executeTraceSummaryV1,
  unavailableTraceSummaryV1,
  type ExecuteTraceSummaryDependencies,
  type ExecuteTraceSummaryInput,
  type TraceSummaryExecutionV1,
} from './traceSummaryExecutor';
import type {
  TraceSummaryMetricPolarityV1,
  TraceSummaryMetricUnitV1,
} from './traceSummarySpecRegistry';

export interface ManagedTraceSummarySource {
  getRunningTraceSummaryInput?: (
    traceId: string,
    options?: TraceProcessorServiceQueryOptions,
  ) => RunningTraceSummaryInput | undefined;
}

export type ManagedTraceSummaryExecutor = (
  input: ExecuteTraceSummaryInput,
  dependencies?: ExecuteTraceSummaryDependencies,
) => Promise<TraceSummaryExecutionV1>;

export type ManagedTraceSummaryRunner = (
  source: ManagedTraceSummarySource,
  traceId: string,
  traceSide: 'current' | 'reference',
  options?: TraceProcessorServiceQueryOptions,
) => Promise<TraceSummaryExecutionV1>;

export const runManagedTraceSummaryV1: ManagedTraceSummaryRunner = (
  source,
  traceId,
  traceSide,
  options = {},
) => executeManagedTraceSummaryV1(source, traceId, traceSide, {}, options);

export interface ExecuteManagedTraceSummaryDependencies {
  executor?: ManagedTraceSummaryExecutor;
}

export interface TraceSummaryComparisonMetricV1 {
  id: string;
  unit: TraceSummaryMetricUnitV1;
  polarity: TraceSummaryMetricPolarityV1;
  currentStatus: 'available' | 'missing';
  referenceStatus: 'available' | 'missing';
  currentValue?: number;
  referenceValue?: number;
  delta?: number;
}

export type TraceSummaryComparisonV1 =
  | {
      schemaVersion: 'trace_summary_comparison@1';
      status: 'compatible';
      specId: string;
      specDigestSha256: string;
      metrics: TraceSummaryComparisonMetricV1[];
    }
  | {
      schemaVersion: 'trace_summary_comparison@1';
      status: 'incompatible';
      reason:
        | 'summary_unavailable'
        | 'spec_mismatch'
        | 'trace_processor_mismatch'
        | 'metric_contract_mismatch';
      metrics: [];
    };

export async function executeManagedTraceSummaryV1(
  source: ManagedTraceSummarySource,
  traceId: string,
  traceSide: 'current' | 'reference',
  dependencies: ExecuteManagedTraceSummaryDependencies = {},
  options: TraceProcessorServiceQueryOptions = {},
): Promise<TraceSummaryExecutionV1> {
  let managed: RunningTraceSummaryInput | undefined;
  try {
    managed = source.getRunningTraceSummaryInput?.(traceId, options);
  } catch {
    return unavailableTraceSummaryV1('trace_processor_session_unavailable');
  }
  if (!managed) return unavailableTraceSummaryV1('trace_source_unavailable');
  if (managed.source === 'external_rpc') {
    return unavailableTraceSummaryV1('external_rpc_unsupported');
  }
  return (dependencies.executor ?? executeTraceSummaryV1)({
    tracePath: managed.tracePath,
    traceSide,
    remotePort: managed.port,
  }, {
    binarySelection: managed.binarySelection,
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function compareTraceSummariesV1(
  current: TraceSummaryExecutionV1,
  reference: TraceSummaryExecutionV1,
): TraceSummaryComparisonV1 {
  if (current.status !== 'ready' || reference.status !== 'ready') {
    return {
      schemaVersion: 'trace_summary_comparison@1', status: 'incompatible',
      reason: 'summary_unavailable', metrics: [],
    };
  }
  if (current.spec.id !== reference.spec.id ||
    current.spec.digestSha256 !== reference.spec.digestSha256) {
    return {
      schemaVersion: 'trace_summary_comparison@1', status: 'incompatible',
      reason: 'spec_mismatch', metrics: [],
    };
  }
  if (canonical(current.traceProcessor) !== canonical(reference.traceProcessor)) {
    return {
      schemaVersion: 'trace_summary_comparison@1', status: 'incompatible',
      reason: 'trace_processor_mismatch', metrics: [],
    };
  }
  const referenceMetrics = new Map(reference.metrics.map(metric => [metric.id, metric]));
  if (current.metrics.some(metric => !referenceMetrics.has(metric.id)) ||
    reference.metrics.some(metric => !current.metrics.some(item => item.id === metric.id))) {
    return {
      schemaVersion: 'trace_summary_comparison@1', status: 'incompatible',
      reason: 'metric_contract_mismatch', metrics: [],
    };
  }
  return {
    schemaVersion: 'trace_summary_comparison@1',
    status: 'compatible',
    specId: current.spec.id,
    specDigestSha256: current.spec.digestSha256,
    metrics: current.metrics.map(metric => {
      const other = referenceMetrics.get(metric.id);
      if (!other) throw new Error('unreachable_trace_summary_comparison_metric_missing');
      const comparable = metric.status === 'available' && other.status === 'available';
      return {
        id: metric.id,
        unit: metric.unit,
        polarity: metric.polarity,
        currentStatus: metric.status,
        referenceStatus: other.status,
        ...(metric.status === 'available' ? {currentValue: metric.value} : {}),
        ...(other.status === 'available' ? {referenceValue: other.value} : {}),
        ...(comparable ? {delta: metric.value! - other.value!} : {}),
      };
    }),
  };
}
