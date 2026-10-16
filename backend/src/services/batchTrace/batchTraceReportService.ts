// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {
  localize,
  parseOutputLanguage,
  type OutputLanguage,
} from '../../agentv3/outputLanguage';
import type { BatchTraceRunV1 } from './batchTraceTypes';
import {REPORT_LAYOUT_FIX_CSS} from '../reportLayoutAssets';
import {REPORT_DOCUMENT_SCRIPT, REPORT_DOCUMENT_NO_SCRIPT} from '../reportDocumentAssets';

export function batchTraceStatusLabel(status: string, language: OutputLanguage): string {
  const labels: Record<string, [string, string]> = {
    queued: ['等待中', 'Queued'],
    running: ['运行中', 'Running'],
    completed: ['已完成', 'Completed'],
    partial: ['部分完成', 'Partial'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    unsupported: ['不支持', 'Unsupported'],
    unavailable: ['不可用', 'Unavailable'],
  };
  const label = labels[status];
  return label ? localize(language, label[0], label[1]) : status;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return '';
  return escapeHtml(String(value));
}

function perTraceRows(run: BatchTraceRunV1, language: OutputLanguage): string {
  return run.perTrace.map(result => {
    const diagnostics = result.diagnostics.map(item => `${item.severity}: ${item.message}`).join('; ');
    return `<tr>
      <td>${result.ordinal}</td>
      <td>${escapeHtml(result.input.label ?? result.input.traceId ?? result.input.tracePath)}</td>
      <td data-status="${escapeHtml(result.status)}">${escapeHtml(batchTraceStatusLabel(result.status, language))}</td>
      <td>${result.metrics.length}<details><summary>${localize(language, '指标与证据引用', 'Metrics and evidence references')}</summary>
        <pre class="report-value-json">${escapeHtml(JSON.stringify({metrics: result.metrics, evidenceEnvelopeIds: result.evidenceEnvelopeIds}, null, 2))}</pre></details></td>
      <td class="numeric">${formatNumber(result.executionTimeMs)} ms</td>
      <td>${escapeHtml(result.error ?? diagnostics)}</td>
    </tr>`;
  }).join('\n');
}

function aggregateRows(run: BatchTraceRunV1): string {
  return (run.aggregate?.metrics ?? []).map(metric => `<tr>
    <td>${escapeHtml(metric.label)}</td>
    <td>${escapeHtml(metric.unit ?? '')}</td>
    <td>${metric.count}</td>
    <td>${metric.missingCount}</td>
    <td>${formatNumber(metric.min)}</td>
    <td>${formatNumber(metric.p50)}</td>
    <td>${formatNumber(metric.p90)}</td>
    <td>${formatNumber(metric.p95)}</td>
    <td>${formatNumber(metric.max)}</td>
    <td>${formatNumber(metric.mean)}</td>
    <td>${escapeHtml(metric.outlierOrdinals.join(', '))}</td>
  </tr>`).join('\n');
}

function limitationItems(run: BatchTraceRunV1, language: OutputLanguage): string {
  const limitations = run.aggregate?.limitations ?? [];
  if (limitations.length === 0) return `<li>${localize(language, '无', 'None')}</li>`;
  return limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('\n');
}

function listItems(values: string[], language: OutputLanguage): string {
  if (values.length === 0) return `<li>${localize(language, '无', 'None')}</li>`;
  return values.map(value => `<li>${escapeHtml(value)}</li>`).join('\n');
}

function domainAnalysisSection(run: BatchTraceRunV1, language: OutputLanguage): string {
  const domain = run.domainAnalysis;
  if (!domain || domain.operation !== 'heap_path_cluster') return '';
  const result = domain.result;
  const clusterRows = result.clusters.map(cluster => `<tr>
    <td><code>${escapeHtml(cluster.id)}</code></td>
    <td>${escapeHtml(cluster.representativePath)}</td>
    <td>${cluster.traceCount} (${formatNumber(cluster.traceSupportPct)}%)</td>
    <td>${cluster.sampleCount}</td>
    <td>${cluster.rowCount}</td>
    <td>${formatNumber(cluster.meanRetainedBytes)}</td>
    <td>${formatNumber(cluster.p95RetainedBytes)}</td>
    <td>${escapeHtml(cluster.collapsedPaths.join('; '))}</td>
    <td>${cluster.evidenceRefIds.length}</td>
  </tr>`).join('\n');
  const failures = result.failures.map(failure =>
    `${localize(language, '轨迹序号', 'Trace ordinal')} ${failure.traceOrdinal}${failure.traceId ? ` (${failure.traceId})` : ''}${localize(language, '：', ':')} ${failure.reason}`);
  const unavailable = localize(language, '不可用', 'N/A');
  const colon = localize(language, '：', ':');
  const separator = localize(language, '，', ', ');
  return `<h2>${localize(language, '堆内存路径聚类分析', 'Heap Path Cluster Analysis')}</h2>
  <p><strong>${localize(language, '状态', 'Status')}${colon}</strong> <span data-status="${escapeHtml(result.status)}">${escapeHtml(batchTraceStatusLabel(result.status, language))}</span></p>
  <p><strong>${localize(language, '选定 K 值', 'Selected K')}${colon}</strong> ${result.selectedK ?? unavailable}</p>
  <p><strong>${localize(language, '轮廓系数', 'Silhouette')}${colon}</strong> ${result.silhouetteScore === null ? unavailable : formatNumber(result.silhouetteScore)}</p>
  <p><strong>${localize(language, '输入', 'Input')}${colon}</strong> ${result.input.traceCount} ${localize(language, '条轨迹', 'traces')}${separator}${result.input.sampleCount} ${localize(language, '个样本', 'samples')}${separator}${result.input.rowCount} ${localize(language, '行', 'rows')}</p>
  <p><strong>${localize(language, '证据行', 'Evidence rows')}${colon}</strong> ${domain.evidence.rowCount}</p>
  <p><strong>${localize(language, '拒绝行', 'Rejected rows')}${colon}</strong> ${domain.evidence.rejectedRowCount}</p>
  <p><strong>${localize(language, '截断行', 'Truncated rows')}${colon}</strong> ${domain.evidence.truncatedRowCount}</p>
  <p><strong>${localize(language, '种子', 'Seed')}${colon}</strong> <code>${escapeHtml(result.seedHash)}</code></p>
  <div class="table-container"><table>
    <thead>
      <tr><th>${localize(language, '聚类', 'Cluster')}</th><th>${localize(language, '代表路径', 'Representative path')}</th><th>${localize(language, '轨迹支持率', 'Trace support')}</th><th>${localize(language, '样本', 'Samples')}</th><th>${localize(language, '行数', 'Rows')}</th><th>${localize(language, '平均保留字节', 'Mean retained bytes')}</th><th>${localize(language, 'P95 保留字节', 'P95 retained bytes')}</th><th>${localize(language, '合并路径', 'Collapsed paths')}</th><th>${localize(language, '证据引用', 'Evidence refs')}</th></tr>
    </thead>
    <tbody>${clusterRows}</tbody>
  </table></div>
  <h3>${localize(language, '聚类限制', 'Cluster Limitations')}</h3>
  <ul>${listItems(result.limitations, language)}</ul>
  <h3>${localize(language, '聚类失败项', 'Cluster Failures')}</h3>
  <ul>${listItems(failures, language)}</ul>`;
}

export function renderBatchTraceHtmlReport(
  run: BatchTraceRunV1,
  language: OutputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
): string {
  const colon = localize(language, '：', ':');
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${localize(language, 'SmartPerfetto 批量轨迹分析', 'SmartPerfetto Batch Trace Run')} ${escapeHtml(run.id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2328; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0 28px; }
    th, td { border: 1px solid #d0d7de; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; }
    code { background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }
    ${REPORT_LAYOUT_FIX_CSS}
  </style>
</head>
<body class="batch-report">
  <h1>${localize(language, 'SmartPerfetto 批量轨迹分析', 'SmartPerfetto Batch Trace Run')}</h1>
  <p><strong>${localize(language, '运行', 'Run')}${colon}</strong> <code>${escapeHtml(run.id)}</code></p>
  <p><strong>${localize(language, '技能', 'Skill')}${colon}</strong> <code>${escapeHtml(run.input.skillId)}</code></p>
  <p><strong>${localize(language, '状态', 'Status')}${colon}</strong> <span data-status="${escapeHtml(run.status)}">${escapeHtml(batchTraceStatusLabel(run.status, language))}</span></p>
  <p><strong>${localize(language, '轨迹数量', 'Trace count')}${colon}</strong> ${run.input.traceInputs.length}</p>
  <h2>${localize(language, '逐轨迹结果', 'Per Trace Results')}</h2>
  <div class="table-container"><table>
    <thead>
      <tr><th>${localize(language, '序号', 'Ordinal')}</th><th>${localize(language, '轨迹', 'Trace')}</th><th>${localize(language, '状态', 'Status')}</th><th>${localize(language, '指标', 'Metrics')}</th><th>${localize(language, '执行耗时', 'Execution')}</th><th>${localize(language, '诊断 / 错误', 'Diagnostics / Error')}</th></tr>
    </thead>
    <tbody>${perTraceRows(run, language)}</tbody>
  </table></div>
  <h2>${localize(language, '聚合指标', 'Aggregate Metrics')}</h2>
  <div class="table-container"><table>
    <thead>
      <tr><th>${localize(language, '指标', 'Metric')}</th><th>${localize(language, '单位', 'Unit')}</th><th>${localize(language, '数量', 'Count')}</th><th>${localize(language, '缺失', 'Missing')}</th><th>${localize(language, '最小值', 'Min')}</th><th>P50</th><th>P90</th><th>P95</th><th>${localize(language, '最大值', 'Max')}</th><th>${localize(language, '平均值', 'Mean')}</th><th>${localize(language, '离群项', 'Outliers')}</th></tr>
    </thead>
    <tbody>${aggregateRows(run)}</tbody>
  </table></div>
  ${domainAnalysisSection(run, language)}
  <h2>${localize(language, '限制', 'Limitations')}</h2>
  <ul>${limitationItems(run, language)}</ul>
<script>${REPORT_DOCUMENT_SCRIPT}</script>
${REPORT_DOCUMENT_NO_SCRIPT}
</body>
</html>`;
}

export function writeBatchTraceArtifacts(input: {
  run: BatchTraceRunV1;
  directory: string;
  htmlPath?: string;
  jsonPath?: string;
  outputLanguage?: OutputLanguage;
}): BatchTraceRunV1 {
  fs.mkdirSync(input.directory, { recursive: true });
  const jsonPath = input.jsonPath ?? path.join(input.directory, 'result.json');
  const htmlPath = input.htmlPath ?? path.join(input.directory, 'report.html');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  const withPaths: BatchTraceRunV1 = {
    ...input.run,
    report: {
      ...(input.run.report ?? {}),
      jsonPath,
      htmlPath,
    },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(withPaths, null, 2));
  fs.writeFileSync(htmlPath, renderBatchTraceHtmlReport(withPaths, input.outputLanguage));
  return withPaths;
}
