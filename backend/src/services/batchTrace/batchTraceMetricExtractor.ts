// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DataEnvelope, DataPayload } from '../../types/dataContract';
import type {
  ComparisonMetricKey,
  NormalizedMetricUnit,
  NormalizedMetricValue,
  StandardComparisonMetricKey,
} from '../../types/multiTraceComparison';
import { STANDARD_COMPARISON_METRICS, standardMetricDescribesApp } from '../../types/multiTraceComparison';
import { outsideTargetScopeFields } from '../../types/identityContract';
import type { SkillExecutionResult } from '../skillEngine/types';
import type { BatchTraceMetricV1 } from './batchTraceTypes';

interface ExtractBatchTraceMetricsInput {
  skillId: string;
  ordinal: number;
  result: SkillExecutionResult;
  dataEnvelopes: DataEnvelope[];
}

const STANDARD_METRIC_DEFINITIONS = new Map(
  STANDARD_COMPARISON_METRICS.map(metric => [metric.key, metric]),
);

const COLUMN_KEY_MAP: Array<{ key: StandardComparisonMetricKey; aliases: string[] }> = [
  { key: 'startup.total_ms', aliases: ['startup_total_ms', 'startup_duration_ms', 'total_duration_ms', 'total_ms', 'launch_total_ms'] },
  { key: 'startup.first_frame_ms', aliases: ['first_frame_ms', 'time_to_first_frame_ms', 'ttff_ms', 'first_frame_duration_ms'] },
  { key: 'startup.bind_application_ms', aliases: ['bind_application_ms', 'bind_app_ms', 'bindapplication_ms', 'bind_application_duration_ms'] },
  { key: 'startup.activity_start_ms', aliases: ['activity_start_ms', 'activity_start_duration_ms', 'activitystart_ms'] },
  { key: 'startup.main_thread_blocked_ms', aliases: ['main_thread_blocked_ms', 'main_blocked_ms', 'blocked_ms', 'main_thread_blocked_duration_ms'] },
  { key: 'scrolling.avg_fps', aliases: ['avg_fps', 'average_fps', 'mean_fps', 'fps'] },
  { key: 'scrolling.frame_count', aliases: ['frame_count', 'total_frames', 'frames'] },
  { key: 'scrolling.jank_count', aliases: ['jank_count', 'janky_frame_count', 'janky_frames'] },
  { key: 'scrolling.jank_rate_pct', aliases: ['jank_rate_pct', 'jank_pct', 'jank_percentage', 'jank_rate'] },
  { key: 'scrolling.p50_frame_ms', aliases: ['p50_frame_ms', 'frame_p50_ms', 'p50_ms'] },
  { key: 'scrolling.p95_frame_ms', aliases: ['p95_frame_ms', 'frame_p95_ms', 'p95_ms'] },
  { key: 'scrolling.p99_frame_ms', aliases: ['p99_frame_ms', 'frame_p99_ms', 'p99_ms'] },
  { key: 'trace.duration_ms', aliases: ['trace_duration_ms', 'duration_ms'] },
  { key: 'trace.device_model', aliases: ['device_model', 'model'] },
  { key: 'trace.android_version', aliases: ['android_version', 'os_version'] },
  { key: 'trace.capture_config_summary', aliases: ['capture_config_summary', 'config_summary'] },
];

function normalizeMetricName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasStartupContext(contextNames: readonly string[]): boolean {
  return contextNames
    .map(normalizeMetricName)
    .some(name => name.includes('startup') || name.includes('launch') || name.includes('get_startups'));
}

function standardKeyForName(
  name: string,
  contextNames: readonly string[] = [],
): StandardComparisonMetricKey | undefined {
  const normalized = normalizeMetricName(name);
  for (const entry of COLUMN_KEY_MAP) {
    if (entry.aliases.includes(normalized)) return entry.key;
  }
  if (hasStartupContext(contextNames)) {
    if (normalized === 'dur_ms') return 'startup.total_ms';
    if (normalized === 'ttid_ms' || normalized === 'time_to_initial_display_ms') {
      return 'startup.first_frame_ms';
    }
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function metricUnitForKey(key: ComparisonMetricKey | undefined): NormalizedMetricUnit | undefined {
  if (!key) return undefined;
  return STANDARD_METRIC_DEFINITIONS.get(key as StandardComparisonMetricKey)?.unit;
}

function labelForKey(key: string, fallback: string): string {
  return STANDARD_METRIC_DEFINITIONS.get(key as StandardComparisonMetricKey)?.label ?? fallback;
}

function batchMetric(input: {
  key: string;
  label: string;
  value: number | string | null;
  source: BatchTraceMetricV1['source'];
  promotableMetricKey?: ComparisonMetricKey;
}): BatchTraceMetricV1 {
  const numericValue = toFiniteNumber(input.value);
  const unit = metricUnitForKey(input.promotableMetricKey);
  return {
    key: input.promotableMetricKey ?? input.key,
    label: input.promotableMetricKey ? labelForKey(input.promotableMetricKey, input.label) : input.label,
    value: input.value,
    ...(numericValue !== undefined ? { numericValue } : {}),
    ...(unit ? { unit } : {}),
    source: input.source,
    ...(input.promotableMetricKey ? { promotableMetricKey: input.promotableMetricKey } : {}),
  };
}

function synthesizeRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data)) {
    if (Array.isArray(data.rows) && Array.isArray(data.columns)) {
      const columns = data.columns.filter((column): column is string => typeof column === 'string');
      return data.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
    }
    return [data];
  }
  return [];
}

function extractFromSynthesizeData(input: ExtractBatchTraceMetricsInput): BatchTraceMetricV1[] {
  const synthesizeItems = Array.isArray(input.result.synthesizeData) ? input.result.synthesizeData : [];
  const metrics: BatchTraceMetricV1[] = [];
  for (const item of synthesizeItems) {
    if (!isRecord(item)) continue;
    const config = isRecord(item.config) ? item.config : undefined;
    if (config?.role !== 'overview') continue;
    const stepId = typeof item.stepId === 'string' ? item.stepId : undefined;
    for (const row of synthesizeRows(item.data)) {
      for (const [field, value] of Object.entries(row)) {
        const numericValue = toFiniteNumber(value);
        const contextNames = [input.skillId, stepId].filter((name): name is string => typeof name === 'string');
        const standardKey = standardKeyForName(field, contextNames);
        const canKeepString = typeof value === 'string' && standardKey !== undefined;
        if (numericValue === undefined && !canKeepString) continue;
        const localKey = `${stepId ?? 'synthesize'}.${normalizeMetricName(field)}`;
        metrics.push(batchMetric({
          key: localKey,
          label: field,
          value: numericValue ?? String(value),
          source: { skillId: input.skillId, ...(stepId ? { stepId } : {}) },
          ...(standardKey ? { promotableMetricKey: standardKey } : {}),
        }));
      }
    }
  }
  return metrics;
}

function payloadRows(payload: DataPayload): Array<Record<string, unknown>> {
  const columns = Array.isArray(payload.columns)
    ? payload.columns.filter((column): column is string => typeof column === 'string')
    : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (columns.length === 0 || rows.length === 0) return [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function columnLabel(envelope: DataEnvelope, column: string): string {
  const definition = envelope.display.columns?.find(item => item.name === column);
  return definition?.label ?? column;
}

function extractFromDataEnvelopes(input: ExtractBatchTraceMetricsInput): BatchTraceMetricV1[] {
  const metrics: BatchTraceMetricV1[] = [];
  for (const envelope of input.dataEnvelopes) {
    const layer = envelope.display.layer;
    const level = envelope.display.level;
    if (layer !== 'overview' && level !== 'key') continue;
    const stepId = envelope.meta.stepId;
    const rows = payloadRows(envelope.data);
    // A field declared trace-wide or peer stays a local metric, never an app standard metric.
    const outsideTarget = outsideTargetScopeFields(envelope.meta.scopeProvenance);
    rows.forEach((row, rowIndex) => {
      for (const [column, value] of Object.entries(row)) {
        const numericValue = toFiniteNumber(value);
        const contextNames = [input.skillId, envelope.meta.source, stepId, envelope.display.title]
          .filter((name): name is string => typeof name === 'string');
        const namedKey = standardKeyForName(column, contextNames);
        const definition = namedKey && STANDARD_METRIC_DEFINITIONS.get(namedKey);
        const standardKey = definition && standardMetricDescribesApp(definition) && outsideTarget(column)
          ? undefined : namedKey;
        const canKeepString = typeof value === 'string' && standardKey !== undefined;
        if (numericValue === undefined && !canKeepString) continue;
        const normalized = normalizeMetricName(column);
        const localKey = rows.length > 1
          ? `${stepId ?? envelope.meta.source}.row${rowIndex}.${normalized}`
          : `${stepId ?? envelope.meta.source}.${normalized}`;
        metrics.push(batchMetric({
          key: localKey,
          label: columnLabel(envelope, column),
          value: numericValue ?? String(value),
          source: {
            skillId: input.skillId,
            ...(stepId ? { stepId } : {}),
            ...(envelope.meta.evidenceRefId ? { dataEnvelopeId: envelope.meta.evidenceRefId } : {}),
            ...(stepId ? { displayResultStepId: stepId } : {}),
          },
          ...(standardKey ? { promotableMetricKey: standardKey } : {}),
        }));
      }
    });
  }
  return metrics;
}

function dedupeMetrics(metrics: BatchTraceMetricV1[]): BatchTraceMetricV1[] {
  const byKey = new Map<string, BatchTraceMetricV1>();
  for (const metric of metrics) {
    if (!byKey.has(metric.key)) {
      byKey.set(metric.key, metric);
    }
  }
  return [...byKey.values()];
}

export function extractBatchTraceMetrics(input: ExtractBatchTraceMetricsInput): BatchTraceMetricV1[] {
  return dedupeMetrics([
    ...extractFromSynthesizeData(input),
    ...extractFromDataEnvelopes(input),
  ]);
}

export function toPromotableNormalizedMetrics(metrics: BatchTraceMetricV1[]): NormalizedMetricValue[] {
  return metrics
    .filter((metric): metric is BatchTraceMetricV1 & { promotableMetricKey: ComparisonMetricKey } =>
      metric.promotableMetricKey !== undefined)
    .map(metric => {
      const definition = STANDARD_METRIC_DEFINITIONS.get(metric.promotableMetricKey as StandardComparisonMetricKey);
      return {
        key: metric.promotableMetricKey,
        label: definition?.label ?? metric.label,
        group: definition?.group ?? 'batch',
        value: metric.value,
        ...(definition?.unit ? { unit: definition.unit } : {}),
        ...(definition?.direction ? { direction: definition.direction } : {}),
        ...(definition?.aggregation ? { aggregation: definition.aggregation } : {}),
        confidence: 1,
        ...(metric.missingReason ? { missingReason: metric.missingReason } : {}),
        source: {
          type: 'skill',
          skillId: metric.source.skillId,
          ...(metric.source.stepId ? { stepId: metric.source.stepId } : {}),
          ...(metric.source.dataEnvelopeId ? { dataEnvelopeId: metric.source.dataEnvelopeId } : {}),
        },
      };
    });
}
