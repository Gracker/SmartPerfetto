// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import {
  STANDARD_COMPARISON_METRICS,
  type AnalysisResultSnapshot,
  type ComparisonMetricKey,
  type EvidenceRef,
  type NormalizedMetricValue,
  type StandardComparisonMetricKey,
} from '../types/multiTraceComparison';
import type { AnalysisResultSnapshotRepository, SnapshotAccessScope } from './analysisResultSnapshotStore';
import type { QueryResult, TraceProcessorServiceQueryOptions } from './traceProcessorService';
import {rowObject} from '../utils/traceProcessorRowUtils';

export const BACKFILL_SUPPORTED_STANDARD_METRIC_KEYS: readonly StandardComparisonMetricKey[] = [
  'startup.total_ms',
  'scrolling.avg_fps',
  'scrolling.frame_count',
  'scrolling.jank_count',
  'scrolling.jank_rate_pct',
] as const;

export interface StandardMetricBackfillTraceProcessor {
  query(
    traceId: string,
    sql: string,
    options?: TraceProcessorServiceQueryOptions,
  ): Promise<QueryResult>;
}

export interface BackfillStandardMetricsInput {
  snapshot: AnalysisResultSnapshot;
  metricKeys: ComparisonMetricKey[];
  traceProcessor: StandardMetricBackfillTraceProcessor;
  repository?: AnalysisResultSnapshotRepository;
  scope?: SnapshotAccessScope;
  queryOptions?: TraceProcessorServiceQueryOptions;
}

export interface BackfillStandardMetricsResult {
  snapshot: AnalysisResultSnapshot;
  metrics: NormalizedMetricValue[];
  evidenceRefs: EvidenceRef[];
  missingReasons: Record<string, string>;
}

const METRIC_DEFINITION_BY_KEY = new Map(
  STANDARD_COMPARISON_METRICS.map(metric => [metric.key, metric]),
);
const SUPPORTED_KEYS = new Set<ComparisonMetricKey>(BACKFILL_SUPPORTED_STANDARD_METRIC_KEYS);

const STARTUP_SQL = `
SELECT
  dur / 1000000.0 AS startup_total_ms
FROM android_startups
WHERE dur IS NOT NULL
ORDER BY dur DESC
LIMIT 1;
`;

const SCROLLING_SQL = `
WITH frames AS (
  SELECT
    ts,
    dur,
    jank_type
  FROM actual_frame_timeline_slice
  WHERE dur IS NOT NULL AND dur > 0
),
summary AS (
  SELECT
    COUNT(*) AS frame_count,
    SUM(CASE WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1 ELSE 0 END) AS jank_count,
    MIN(ts) AS start_ts,
    MAX(ts + dur) AS end_ts
  FROM frames
)
SELECT
  frame_count,
  jank_count,
  CASE
    WHEN frame_count > 0 AND end_ts > start_ts
      THEN frame_count * 1000000000.0 / (end_ts - start_ts)
    ELSE NULL
  END AS avg_fps,
  CASE
    WHEN frame_count > 0
      THEN jank_count * 100.0 / frame_count
    ELSE NULL
  END AS jank_rate_pct
FROM summary;
`;

function firstRowObject(result: QueryResult): Record<string, unknown> | null {
  const first = result.rows[0];
  return first ? rowObject(result.columns, first) : null;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function metricValue(
  key: StandardComparisonMetricKey,
  value: number,
  backfillRunId: string,
  sql: string,
): NormalizedMetricValue {
  const definition = METRIC_DEFINITION_BY_KEY.get(key);
  if (!definition) {
    throw new Error(`Unsupported backfill metric key: ${key}`);
  }
  return {
    key,
    label: definition.label,
    group: definition.group,
    value,
    unit: definition.unit,
    direction: definition.direction,
    aggregation: definition.aggregation,
    confidence: 0.7,
    source: {
      type: 'backfill',
      sql,
      backfillRunId,
    },
  };
}

function addMetricFromRow(
  output: Map<ComparisonMetricKey, NormalizedMetricValue>,
  key: StandardComparisonMetricKey,
  row: Record<string, unknown> | null,
  field: string,
  backfillRunId: string,
  sql: string,
): void {
  const value = toNumber(row?.[field]);
  if (value === undefined) return;
  output.set(key, metricValue(key, value, backfillRunId, sql));
}

function evidenceRef(
  snapshot: AnalysisResultSnapshot,
  backfillRunId: string,
  metricKeys: ComparisonMetricKey[],
): EvidenceRef {
  return {
    id: `${snapshot.id}:backfill:${backfillRunId}`,
    type: 'trace_backfill',
    snapshotId: snapshot.id,
    runId: snapshot.runId,
    label: 'Trace metric backfill',
    metadata: {
      traceId: snapshot.traceId,
      metricKeys,
      backfillRunId,
    },
  };
}

export async function backfillStandardMetrics(
  input: BackfillStandardMetricsInput,
): Promise<BackfillStandardMetricsResult> {
  const existingKeys = new Set(input.snapshot.metrics.map(metric => metric.key));
  const requestedMissingKeys = [...new Set(input.metricKeys)]
    .filter(key => !existingKeys.has(key));
  const supportedMissingKeys = requestedMissingKeys
    .filter(key => SUPPORTED_KEYS.has(key));
  const missingReasons: Record<string, string> = {};
  for (const key of requestedMissingKeys) {
    if (!SUPPORTED_KEYS.has(key)) {
      missingReasons[key] = 'metric_backfill_not_supported';
    }
  }
  if (supportedMissingKeys.length === 0) {
    return {
      snapshot: input.snapshot,
      metrics: [],
      evidenceRefs: [],
      missingReasons,
    };
  }

  const backfillRunId = `metric-backfill-${crypto.randomUUID()}`;
  const metrics = new Map<ComparisonMetricKey, NormalizedMetricValue>();

  if (supportedMissingKeys.some(key => key.startsWith('startup.'))) {
    try {
      const row = firstRowObject(await input.traceProcessor.query(
        input.snapshot.traceId,
        STARTUP_SQL,
        input.queryOptions,
      ));
      addMetricFromRow(metrics, 'startup.total_ms', row, 'startup_total_ms', backfillRunId, STARTUP_SQL);
    } catch (error) {
      for (const key of supportedMissingKeys.filter(item => item.startsWith('startup.'))) {
        missingReasons[key] = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (supportedMissingKeys.some(key => key.startsWith('scrolling.'))) {
    try {
      const row = firstRowObject(await input.traceProcessor.query(
        input.snapshot.traceId,
        SCROLLING_SQL,
        input.queryOptions,
      ));
      addMetricFromRow(metrics, 'scrolling.avg_fps', row, 'avg_fps', backfillRunId, SCROLLING_SQL);
      addMetricFromRow(metrics, 'scrolling.frame_count', row, 'frame_count', backfillRunId, SCROLLING_SQL);
      addMetricFromRow(metrics, 'scrolling.jank_count', row, 'jank_count', backfillRunId, SCROLLING_SQL);
      addMetricFromRow(metrics, 'scrolling.jank_rate_pct', row, 'jank_rate_pct', backfillRunId, SCROLLING_SQL);
    } catch (error) {
      for (const key of supportedMissingKeys.filter(item => item.startsWith('scrolling.'))) {
        missingReasons[key] = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const selectedMetrics = supportedMissingKeys
    .map(key => metrics.get(key))
    .filter((metric): metric is NormalizedMetricValue => Boolean(metric));
  for (const key of supportedMissingKeys) {
    if (!selectedMetrics.some(metric => metric.key === key) && !missingReasons[key]) {
      missingReasons[key] = 'metric_not_found_in_trace';
    }
  }
  const evidenceRefs = selectedMetrics.length > 0
    ? [evidenceRef(input.snapshot, backfillRunId, selectedMetrics.map(metric => metric.key))]
    : [];
  const updatedSnapshot = input.repository && input.scope && selectedMetrics.length > 0
    ? input.repository.upsertMetrics(input.scope, input.snapshot.id, selectedMetrics, evidenceRefs)
    : null;

  return {
    snapshot: updatedSnapshot || {
      ...input.snapshot,
      metrics: [...input.snapshot.metrics, ...selectedMetrics],
      evidenceRefs: [...input.snapshot.evidenceRefs, ...evidenceRefs],
      status: input.snapshot.status === 'failed' ? input.snapshot.status : 'ready',
    },
    metrics: selectedMetrics,
    evidenceRefs,
    missingReasons,
  };
}
