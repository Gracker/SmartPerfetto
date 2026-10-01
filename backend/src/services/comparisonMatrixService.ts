// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {projectPrivateAnalysisDelivery} from './security/analysisDeliveryProjection';
import type {
  AnalysisResultSnapshot,
  ComparisonDelta,
  ComparisonMatrix,
  ComparisonMatrixCell,
  ComparisonMatrixGroup,
  ComparisonMatrixInput,
  ComparisonMatrixRow,
  ComparisonMetricKey,
  EvidenceRef,
  NormalizedMetricDirection,
  NormalizedMetricValue,
} from '../types/multiTraceComparison';
import {
  COMPARISON_MATRIX_SCHEMA_VERSION,
  STANDARD_COMPARISON_METRICS,
} from '../types/multiTraceComparison';
import { isSignificantComparisonDelta } from './comparisonSignificance';

export interface BuildComparisonMatrixOptions {
  baselineSnapshotId?: string;
  metricKeys?: ComparisonMetricKey[];
}

interface ResolvedMetricDefinition {
  key: ComparisonMetricKey;
  label: string;
  group: string;
  unit?: NormalizedMetricValue['unit'];
  direction: NormalizedMetricDirection;
}

const STANDARD_METRIC_BY_KEY = new Map<ComparisonMetricKey, ResolvedMetricDefinition>(
  STANDARD_COMPARISON_METRICS.map(metric => [metric.key, metric]),
);

function snapshotToInput(snapshot: AnalysisResultSnapshot): ComparisonMatrixInput {
  const delivery = projectPrivateAnalysisDelivery({...snapshot.summary, conclusionContract: snapshot.conclusionContract},
    {conclusion: snapshot.summary.conclusion ?? '', conclusionContract: snapshot.conclusionContract}, text => text, {privateMetadata: false});
  return {
    snapshotId: snapshot.id,
    traceId: snapshot.traceId,
    title: snapshot.title,
    traceLabel: snapshot.traceLabel,
    sceneType: snapshot.sceneType,
    userQuery: snapshot.userQuery,
    visibility: snapshot.visibility,
    ...(snapshot.createdBy ? { createdBy: snapshot.createdBy } : {}),
    createdAt: snapshot.createdAt,
    traceMetadata: snapshot.traceMetadata,
    ...(delivery.investigationAssessment ? {investigationAssessment: delivery.investigationAssessment} : {}),
    ...(delivery.deliveryAssurance ? {investigationAssurance: {
      investigation: delivery.deliveryAssurance.investigation ?? 'not_checked',
      investigationEvidence: delivery.deliveryAssurance.investigationEvidence ?? 'not_checked',
    }} : {}),
  };
}

function metricNumericValue(metric: NormalizedMetricValue | undefined): number | undefined {
  if (!metric || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
    return undefined;
  }
  return metric.value;
}

function metricToCell(
  snapshotId: string,
  metricKey: ComparisonMetricKey,
  metric: NormalizedMetricValue,
): ComparisonMatrixCell {
  const numericValue = metricNumericValue(metric);
  return {
    snapshotId,
    metricKey,
    value: metric.value,
    ...(numericValue !== undefined ? { numericValue } : {}),
    ...(metric.unit ? { unit: metric.unit } : {}),
    confidence: metric.confidence,
    ...(metric.missingReason ? { missingReason: metric.missingReason } : {}),
    source: metric.source,
  };
}

function metricKeysFromSnapshots(
  snapshots: AnalysisResultSnapshot[],
  requestedKeys: ComparisonMetricKey[] | undefined,
): ComparisonMetricKey[] {
  if (requestedKeys && requestedKeys.length > 0) {
    return [...new Set(requestedKeys)];
  }
  const keys = new Set<ComparisonMetricKey>();
  for (const metric of STANDARD_COMPARISON_METRICS) {
    if (snapshots.some(snapshot => snapshot.metrics.some(item => item.key === metric.key))) {
      keys.add(metric.key);
    }
  }
  for (const snapshot of snapshots) {
    for (const metric of snapshot.metrics) {
      keys.add(metric.key);
    }
  }
  return [...keys];
}

function resolveMetricDefinition(
  metricKey: ComparisonMetricKey,
  metricsBySnapshot: Map<string, NormalizedMetricValue | undefined>,
): ResolvedMetricDefinition {
  const standard = STANDARD_METRIC_BY_KEY.get(metricKey);
  if (standard) return standard;
  const firstMetric = [...metricsBySnapshot.values()].find(Boolean);
  return {
    key: metricKey,
    label: firstMetric?.label || metricKey,
    group: firstMetric?.group || 'custom',
    ...(firstMetric?.unit ? { unit: firstMetric.unit } : {}),
    direction: firstMetric?.direction || 'neutral',
  };
}

function missingReasonForMetric(metricKey: ComparisonMetricKey): string {
  return STANDARD_METRIC_BY_KEY.has(metricKey)
    ? 'metric_not_found'
    : 'custom_metric_not_found';
}

function assessDelta(
  deltaValue: number | null,
  direction: NormalizedMetricDirection,
): ComparisonDelta['assessment'] {
  if (deltaValue === null || direction === 'neutral') return 'unknown';
  if (Math.abs(deltaValue) < 1e-9) return 'same';
  if (direction === 'lower_is_better') return deltaValue < 0 ? 'better' : 'worse';
  return deltaValue > 0 ? 'better' : 'worse';
}

function buildDelta(
  baselineSnapshotId: string,
  snapshotId: string,
  metricKey: ComparisonMetricKey,
  baselineMetric: NormalizedMetricValue | undefined,
  candidateMetric: NormalizedMetricValue | undefined,
  direction: NormalizedMetricDirection,
  definitionsDiffer: boolean,
): ComparisonDelta {
  const baselineValue = metricNumericValue(baselineMetric);
  const candidateValue = metricNumericValue(candidateMetric);
  const deltaValue =
    baselineValue === undefined || candidateValue === undefined || definitionsDiffer
      ? null
      : candidateValue - baselineValue;
  const deltaPct =
    deltaValue === null || baselineValue === undefined || baselineValue === 0
      ? null
      : (deltaValue / baselineValue) * 100;
  return {
    snapshotId,
    baselineSnapshotId,
    metricKey,
    deltaValue,
    deltaPct,
    direction,
    assessment: assessDelta(deltaValue, direction),
  };
}

function metricEvidenceRef(snapshot: AnalysisResultSnapshot, metric: NormalizedMetricValue): EvidenceRef {
  return {
    id: `${snapshot.id}:${metric.key}`,
    type: 'snapshot_metric',
    label: metric.label,
    snapshotId: snapshot.id,
    metricKey: metric.key,
    reportId: metric.source.reportId || snapshot.reportId,
    runId: metric.source.backfillRunId || snapshot.runId,
    metadata: {
      sourceType: metric.source.type,
      confidence: metric.confidence,
    },
  };
}

function hasSignificantDelta(row: ComparisonMatrixRow): boolean {
  return row.deltas.some(delta => isSignificantComparisonDelta(delta, row));
}

function buildMatrixGroups(rows: ComparisonMatrixRow[]): ComparisonMatrixGroup[] {
  const grouped = new Map<string, ComparisonMatrixRow[]>();
  for (const row of rows) {
    const groupRows = grouped.get(row.group) || [];
    groupRows.push(row);
    grouped.set(row.group, groupRows);
  }
  return [...grouped.entries()].map(([group, groupRows]) => ({
    group,
    rowMetricKeys: groupRows.map(row => row.metricKey),
    rowCount: groupRows.length,
    significantChangeCount: groupRows.filter(hasSignificantDelta).length,
    missingMetricCount: groupRows.reduce(
      (sum, row) => sum + row.missingSnapshotIds.length,
      0,
    ),
    defaultCollapsed: groupRows.length > 3 && !groupRows.some(hasSignificantDelta),
  }));
}

export function buildComparisonMatrix(
  snapshots: AnalysisResultSnapshot[],
  options: BuildComparisonMatrixOptions = {},
): ComparisonMatrix {
  if (snapshots.length < 2) {
    throw new Error('Comparison matrix requires at least two snapshots');
  }
  const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const baselineSnapshotId = options.baselineSnapshotId || snapshots[0].id;
  const baseline = snapshotsById.get(baselineSnapshotId);
  if (!baseline) {
    throw new Error('Baseline snapshot is not part of comparison input');
  }

  const metricKeys = metricKeysFromSnapshots(snapshots, options.metricKeys);
  const missingMatrix: Record<string, Record<string, string>> = {};
  const evidenceRefsById = new Map<string, EvidenceRef>();
  const rows: ComparisonMatrixRow[] = [];
  const warnings: string[] = [];

  for (const metricKey of metricKeys) {
    const metricsBySnapshot = new Map<string, NormalizedMetricValue | undefined>();
    for (const snapshot of snapshots) {
      metricsBySnapshot.set(
        snapshot.id,
        snapshot.metrics.find(metric => metric.key === metricKey),
      );
    }
    const definition = resolveMetricDefinition(metricKey, metricsBySnapshot);
    const baselineMetric = metricsBySnapshot.get(baselineSnapshotId);
    const cells: ComparisonMatrixCell[] = [];
    const missingSnapshotIds: string[] = [];

    for (const snapshot of snapshots) {
      const metric = metricsBySnapshot.get(snapshot.id);
      if (!metric) {
        missingSnapshotIds.push(snapshot.id);
        missingMatrix[snapshot.id] = {
          ...(missingMatrix[snapshot.id] || {}),
          [metricKey]: missingReasonForMetric(metricKey),
        };
        continue;
      }
      cells.push(metricToCell(snapshot.id, metricKey, metric));
      evidenceRefsById.set(`${snapshot.id}:${metric.key}`, metricEvidenceRef(snapshot, metric));
    }

    const deltas = snapshots
      .filter(snapshot => snapshot.id !== baselineSnapshotId)
      .map(snapshot => {
        const metric = metricsBySnapshot.get(snapshot.id);
        // Values compare only under the definition their producers declared.
        const baselineDefinition = baselineMetric?.source?.metricDefinition ?? 'undeclared';
        const candidateDefinition = metric?.source?.metricDefinition ?? 'undeclared';
        const definitionsDiffer = !!baselineMetric && !!metric && baselineDefinition !== candidateDefinition;
        if (definitionsDiffer) {
          warnings.push(`Metric ${metricKey} uses different definitions in ${baselineSnapshotId} ` +
            `(${baselineDefinition}) and ${snapshot.id} (${candidateDefinition}); delta not computed`);
        }
        return buildDelta(baselineSnapshotId, snapshot.id, metricKey, baselineMetric, metric,
          definition.direction, definitionsDiffer);
      });

    rows.push({
      metricKey,
      label: definition.label,
      group: definition.group,
      ...(definition.unit ? { unit: definition.unit } : {}),
      direction: definition.direction,
      ...(baselineMetric
        ? { baseline: metricToCell(baselineSnapshotId, metricKey, baselineMetric) }
        : {}),
      cells,
      deltas,
      missingSnapshotIds,
    });
  }

  for (const row of rows) {
    if (!row.baseline) {
      warnings.push(`Baseline is missing metric ${row.metricKey}`);
    }
  }

  return {
    schemaVersion: COMPARISON_MATRIX_SCHEMA_VERSION,
    inputSnapshots: snapshots.map(snapshotToInput),
    baselineSnapshotId,
    rows,
    groups: buildMatrixGroups(rows),
    evidenceRefs: [...evidenceRefsById.values()],
    missingMatrix,
    warnings,
    createdAt: Date.now(),
  };
}
