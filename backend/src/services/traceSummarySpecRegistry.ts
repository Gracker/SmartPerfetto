// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

export const TRACE_SUMMARY_SPEC_SCHEMA_VERSION = 'trace_summary_spec@1' as const;

export type TraceSummaryMetricUnitV1 = 'COUNT' | 'TIME_NANOS';
export type TraceSummaryMetricPolarityV1 =
  | 'NOT_APPLICABLE'
  | 'LOWER_IS_BETTER'
  | 'HIGHER_IS_BETTER';

export interface TraceSummaryMetricDefinitionV1 {
  id: string;
  dimensions: string[];
  valueColumn: string;
  unit: TraceSummaryMetricUnitV1;
  polarity: TraceSummaryMetricPolarityV1;
  dimensionUniqueness: 'UNIQUE';
}

export interface TraceSummarySpecIdentityV1 {
  schemaVersion: typeof TRACE_SUMMARY_SPEC_SCHEMA_VERSION;
  id: 'smartperfetto.core.v1';
  digestSha256: string;
  metricIds: string[];
  metrics: TraceSummaryMetricDefinitionV1[];
}

interface MetricBundleDefinition {
  kind: 'metric' | 'template';
  idOrPrefix: string;
  querySql: string;
  queryColumns: string[];
  metrics: TraceSummaryMetricDefinitionV1[];
}

const TRACE_DURATION_SQL =
  'SELECT end_ts - start_ts AS duration_ns FROM trace_bounds';
const FRAME_TIMELINE_SQL =
  "WITH per_frame AS (SELECT upid, name, MAX(CASE WHEN jank_type IS NOT NULL AND jank_type != 'None' " +
  'THEN 1 ELSE 0 END) AS is_jank FROM actual_frame_timeline_slice GROUP BY upid, name) ' +
  'SELECT COUNT(*) AS total_count, COALESCE(SUM(is_jank), 0) AS jank_count FROM per_frame ' +
  'HAVING COUNT(*) > 0';

const BUNDLES: MetricBundleDefinition[] = [{
  kind: 'metric',
  idOrPrefix: 'smartperfetto_trace_duration_ns',
  querySql: TRACE_DURATION_SQL,
  queryColumns: ['duration_ns'],
  metrics: [{
    id: 'smartperfetto_trace_duration_ns',
    dimensions: [],
    valueColumn: 'duration_ns',
    unit: 'TIME_NANOS',
    polarity: 'NOT_APPLICABLE',
    dimensionUniqueness: 'UNIQUE',
  }],
}, {
  kind: 'template',
  idOrPrefix: 'smartperfetto_frame_timeline',
  querySql: FRAME_TIMELINE_SQL,
  queryColumns: ['total_count', 'jank_count'],
  metrics: [{
    id: 'smartperfetto_frame_timeline_total_count',
    dimensions: [],
    valueColumn: 'total_count',
    unit: 'COUNT',
    polarity: 'NOT_APPLICABLE',
    dimensionUniqueness: 'UNIQUE',
  }, {
    id: 'smartperfetto_frame_timeline_jank_count',
    dimensions: [],
    valueColumn: 'jank_count',
    unit: 'COUNT',
    polarity: 'LOWER_IS_BETTER',
    dimensionUniqueness: 'UNIQUE',
  }],
}];

function textprotoString(value: string): string {
  return JSON.stringify(value);
}

function renderQuery(lines: string[], bundle: MetricBundleDefinition, indent: string): void {
  lines.push(`${indent}query {`, `${indent}  sql {`,
    `${indent}    sql: ${textprotoString(bundle.querySql)}`);
  for (const column of bundle.queryColumns) {
    lines.push(`${indent}    column_names: ${textprotoString(column)}`);
  }
  lines.push(`${indent}  }`, `${indent}}`);
}

function renderMetricBundle(bundle: MetricBundleDefinition): string[] {
  const lines: string[] = [];
  if (bundle.kind === 'metric') {
    const metric = bundle.metrics[0];
    lines.push('metric_spec {', `  id: ${textprotoString(metric.id)}`,
      `  value: ${textprotoString(metric.valueColumn)}`, `  unit: ${metric.unit}`,
      `  polarity: ${metric.polarity}`, `  dimension_uniqueness: ${metric.dimensionUniqueness}`);
    renderQuery(lines, bundle, '  ');
    lines.push('}');
    return lines;
  }

  lines.push('metric_template_spec {', `  id_prefix: ${textprotoString(bundle.idOrPrefix)}`);
  for (const metric of bundle.metrics) {
    lines.push('  value_column_specs {', `    name: ${textprotoString(metric.valueColumn)}`,
      `    unit: ${metric.unit}`, `    polarity: ${metric.polarity}`, '  }');
  }
  lines.push(`  dimension_uniqueness: ${bundle.metrics[0].dimensionUniqueness}`);
  renderQuery(lines, bundle, '  ');
  lines.push('}');
  return lines;
}

export function renderTraceSummarySpecV1(): string {
  return `${BUNDLES.flatMap(renderMetricBundle).join('\n')}\n`;
}

function copyMetric(metric: TraceSummaryMetricDefinitionV1): TraceSummaryMetricDefinitionV1 {
  return {...metric, dimensions: [...metric.dimensions]};
}

export function getCoreTraceSummarySpecV1(): TraceSummarySpecIdentityV1 {
  const metrics = BUNDLES.flatMap(bundle => bundle.metrics.map(copyMetric));
  const rendered = renderTraceSummarySpecV1();
  return {
    schemaVersion: TRACE_SUMMARY_SPEC_SCHEMA_VERSION,
    id: 'smartperfetto.core.v1',
    digestSha256: crypto.createHash('sha256').update(rendered).digest('hex'),
    metricIds: metrics.map(metric => metric.id),
    metrics,
  };
}
