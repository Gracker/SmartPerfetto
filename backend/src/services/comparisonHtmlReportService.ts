// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import {investigationStatusLines} from './analysisInvestigationPresentation';
import { persistReport } from '../routes/reportRoutes';
import type {
  ComparisonDelta,
  ComparisonMatrixCell,
  ComparisonMatrixRow,
  ComparisonResult,
  MultiTraceComparisonRun,
} from '../types/multiTraceComparison';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';

export interface RenderComparisonHtmlReportInput {
  comparisonId: string;
  query: string;
  result: ComparisonResult;
}

export interface PersistComparisonHtmlReportInput {
  comparison: MultiTraceComparisonRun;
  result: ComparisonResult;
  scope: EnterpriseRepositoryScope;
}

export interface PersistedComparisonHtmlReport {
  reportId: string;
  reportUrl: string;
  html: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function formatValue(cell: ComparisonMatrixCell | undefined, unit?: string): string {
  if (!cell) return '<span class="muted">missing</span>';
  const value = typeof cell.value === 'number' ? formatNumber(cell.value) : String(cell.value ?? 'missing');
  return `${escapeHtml(value)}${unit ? ` <span class="unit">${escapeHtml(unit)}</span>` : ''}`;
}

function deltaClass(delta: ComparisonDelta | undefined): string {
  if (!delta) return 'neutral';
  return delta.assessment === 'better'
    ? 'better'
    : delta.assessment === 'worse'
      ? 'worse'
      : 'neutral';
}

function formatDelta(delta: ComparisonDelta | undefined, unit?: string): string {
  if (!delta || delta.deltaValue === null) return '<span class="muted">n/a</span>';
  const sign = delta.deltaValue > 0 ? '+' : '';
  const pct = delta.deltaPct === null ? '' : ` (${delta.deltaPct > 0 ? '+' : ''}${formatNumber(delta.deltaPct)}%)`;
  return `${sign}${formatNumber(delta.deltaValue)}${unit ? ` <span class="unit">${escapeHtml(unit)}</span>` : ''}${escapeHtml(pct)}`;
}

function cellFor(row: ComparisonMatrixRow, snapshotId: string): ComparisonMatrixCell | undefined {
  return row.cells.find(cell => cell.snapshotId === snapshotId);
}

function deltaFor(row: ComparisonMatrixRow, snapshotId: string): ComparisonDelta | undefined {
  return row.deltas.find(delta => delta.snapshotId === snapshotId);
}

function renderList(items: string[]): string {
  if (items.length === 0) return '<p class="muted">None</p>';
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderMetricTable(result: ComparisonResult): string {
  const matrix = result.matrix;
  const baseline = matrix.inputSnapshots.find(snapshot => snapshot.snapshotId === matrix.baselineSnapshotId)
    || matrix.inputSnapshots[0];
  const candidates = matrix.inputSnapshots.filter(snapshot => snapshot.snapshotId !== baseline?.snapshotId);
  const candidateHeaders = candidates.map(snapshot => `
    <th>${escapeHtml(snapshot.title || snapshot.traceLabel || snapshot.snapshotId)}</th>
    <th>Delta</th>
  `).join('');
  const renderRows = (rows: ComparisonMatrixRow[]): string => rows.map(row => {
    const candidateCells = candidates.map(snapshot => {
      const delta = deltaFor(row, snapshot.snapshotId);
      return `
        <td>${formatValue(cellFor(row, snapshot.snapshotId), row.unit)}</td>
        <td class="${deltaClass(delta)}">${formatDelta(delta, row.unit)}</td>
      `;
    }).join('');
    return `
      <tr>
        <td>
          <div class="metric-label">${escapeHtml(row.label)}</div>
          <div class="metric-key">${escapeHtml(row.metricKey)}</div>
        </td>
        <td>${escapeHtml(row.group)}</td>
        <td>${formatValue(row.baseline, row.unit)}</td>
        ${candidateCells}
      </tr>
    `;
  }).join('');

  const renderTable = (rows: ComparisonMatrixRow[]): string => `
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Group</th>
          <th>Baseline: ${escapeHtml(baseline?.title || baseline?.traceLabel || baseline?.snapshotId || 'baseline')}</th>
          ${candidateHeaders}
        </tr>
      </thead>
      <tbody>${renderRows(rows)}</tbody>
    </table>
  `;

  const groups = matrix.groups || [];
  if (groups.length === 0) return renderTable(matrix.rows);

  const rowsByMetricKey = new Map(matrix.rows.map(row => [row.metricKey, row]));
  return groups.map(group => {
    const groupRows = group.rowMetricKeys
      .map(metricKey => rowsByMetricKey.get(metricKey))
      .filter((row): row is ComparisonMatrixRow => Boolean(row));
    if (groupRows.length === 0) return '';
    const summary = `${group.rowCount} metrics, ${group.significantChangeCount} significant`;
    return `
      <details class="metric-group" ${group.defaultCollapsed ? '' : 'open'}>
        <summary>
          <span>${escapeHtml(group.group)}</span>
          <span class="metric-group-summary">${escapeHtml(summary)}</span>
        </summary>
        ${renderTable(groupRows)}
      </details>
    `;
  }).join('');
}

function renderSnapshots(result: ComparisonResult): string {
  return result.matrix.inputSnapshots.map(snapshot => `
    <div class="snapshot">
      <div class="snapshot-title">${escapeHtml(snapshot.title || snapshot.traceLabel)}</div>
      <div class="snapshot-meta">${escapeHtml(snapshot.snapshotId)} &middot; ${escapeHtml(snapshot.sceneType)} &middot; ${escapeHtml(snapshot.traceLabel)}</div>
      ${investigationStatusLines(snapshot.investigationAssurance, 'en').map(line => `<p>${escapeHtml(line)}</p>`).join('')}
      ${snapshot.investigationAssessment ? `<details><summary>Saved investigation dimensions and evidence</summary>
        <pre>${escapeHtml(JSON.stringify(snapshot.investigationAssessment, null, 2))}</pre></details>` : ''}
    </div>
  `).join('');
}

export function renderComparisonHtmlReport(input: RenderComparisonHtmlReportInput): string {
  const { result } = input;
  const generatedAt = new Date().toISOString();
  const conclusion = result.conclusion;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SmartPerfetto Comparison Report</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f6f7f9; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 56px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .meta { color: #647084; font-size: 13px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
    .snapshot, .panel { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 14px; }
    .metric-group { margin: 12px 0; background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; overflow: hidden; }
    .metric-group summary { cursor: pointer; display: flex; justify-content: space-between; gap: 16px; padding: 12px 14px; font-weight: 650; background: #f8fafc; }
    .metric-group table { border: 0; border-top: 1px solid #dfe3ea; border-radius: 0; }
    .metric-group-summary { color: #718096; font-size: 12px; font-weight: 500; }
    .snapshot-title { font-weight: 650; margin-bottom: 4px; }
    .snapshot-meta, .metric-key, .muted { color: #718096; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #edf0f5; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #f0f3f7; color: #39465a; font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    .metric-label { font-weight: 650; }
    .unit { color: #718096; }
    .better { color: #087f5b; font-weight: 650; }
    .worse { color: #b42318; font-weight: 650; }
    .neutral { color: #49566a; }
    ul { margin: 8px 0 0 20px; padding: 0; }
    li { margin: 6px 0; }
  </style>
</head>
<body>
  <main data-comparison-id="${escapeHtml(input.comparisonId)}">
    <h1>SmartPerfetto Comparison Report</h1>
    <div class="meta">Comparison ${escapeHtml(input.comparisonId)} &middot; Generated ${escapeHtml(generatedAt)}</div>
    <h2>User Request</h2>
    <div class="panel">${escapeHtml(input.query)}</div>
    <h2>Input Snapshots</h2>
    <section class="summary">${renderSnapshots(result)}</section>
    <h2>Metric Delta Matrix</h2>
    ${renderMetricTable(result)}
    <h2>AI Conclusion</h2>
    <section class="summary">
      <div class="panel"><strong>Verified Facts</strong>${renderList(conclusion.verifiedFacts)}</div>
      <div class="panel"><strong>Inferences</strong>${renderList(conclusion.inferences)}</div>
      <div class="panel"><strong>Recommendations</strong>${renderList(conclusion.recommendations)}</div>
      <div class="panel"><strong>Uncertainty</strong>${renderList(conclusion.uncertainty)}</div>
    </section>
  </main>
</body>
</html>`;
}

export function persistComparisonHtmlReport(
  input: PersistComparisonHtmlReportInput,
): PersistedComparisonHtmlReport {
  const reportId = `comparison-report-${input.comparison.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const html = renderComparisonHtmlReport({
    comparisonId: input.comparison.id,
    query: input.comparison.query,
    result: input.result,
  });
  const baseline = input.result.matrix.inputSnapshots.find(
    snapshot => snapshot.snapshotId === input.result.matrix.baselineSnapshotId,
  ) || input.result.matrix.inputSnapshots[0];

  persistReport(reportId, {
    html,
    generatedAt: Date.now(),
    sessionId: `comparison-session-${input.comparison.id}`,
    runId: input.comparison.id,
    traceId: baseline?.traceId,
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    visibility: 'private',
    // The report embeds the input snapshots, so it inherits their audience.
    privateContext: input.comparison.privateContext,
  });

  return {
    reportId,
    reportUrl: `/api/reports/${reportId}`,
    html,
  };
}
