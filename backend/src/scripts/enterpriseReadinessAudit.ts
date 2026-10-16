// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  REQUIRED_RSS_BENCHMARK_SCENES,
  REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS,
} from './enterpriseRssBenchmarkMatrix';
import {
  MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS,
  MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA,
} from './enterpriseAcceptanceLoadTest';

type ReadinessStatus = 'passed' | 'blocked';

export interface ReadinessCheck {
  id: string;
  status: ReadinessStatus;
  message: string;
  evidence: string[];
}

export interface EnterpriseReadinessAuditOptions {
  readmePath: string;
  acceptanceEvidencePath: string;
  loadTestReportPath: string;
  rssBenchmarkPath: string;
  releaseNotesPath: string;
  outputPath?: string;
  markdownPath?: string;
  requireReady: boolean;
  allowUserDeferredExternalEvidence?: boolean;
}

export interface EnterpriseReadinessAuditReport {
  generatedAt: string;
  ready: boolean;
  checks: ReadinessCheck[];
  artifacts: Record<string, string>;
}

interface TodoItem {
  checked: boolean;
  text: string;
  line: number;
}

interface MarkdownSection {
  content: string;
  startLine: number;
}

const REQUIRED_ACCEPTANCE_EVIDENCE_ITEMS = [
  '50 online users + 5-15 running runs + stable pending queue',
  'Users cannot guess traceId / sessionId / runId / reportId for cross-resource access',
  'A delete/cleanup does not affect B running run / active lease',
  'Provider isolation: A personal provider does not affect B; workspace default changes only affect new sessions',
  'Provider config changes do not resume the wrong SDK session',
  'SSE fetch-stream reconnects with Last-Event-ID',
  'Two windows open two traces without pending trace / AI session / SSE / lease cross-talk',
  'One slow SQL does not directly kill a frontend-owned lease',
  'Memory / SQL learning / case / baseline default to tenant/workspace isolation',
  'Tenant export / tombstone / async purge / audit proof all work',
  // No global model cost or call counter exists, so scale is projected from completed analysis runs.
  'Load-test report includes p50/p95, error rate, worker RSS, queue length, trace metadata scale, and daily analysis run projection',
];
const USER_DEFERRED_EXTERNAL_VALIDATION_MARKER = 'User-deferred external validation: yes';

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/enterpriseReadinessAudit.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --readme <path>               README with §0 TODOs.');
  console.log('  --acceptance-evidence <path>  §0.8 acceptance evidence doc.');
  console.log('  --load-test-report <path>     §0.8 load-test report doc.');
  console.log('  --rss-benchmark <path>        §0.4.3 RSS benchmark doc.');
  console.log('  --release-notes <path>        Final release notes doc.');
  console.log('  --output <path>               JSON report path.');
  console.log('  --markdown <path>             Optional Markdown report path.');
  console.log('  --require-ready               Exit non-zero unless every readiness check passes.');
  console.log('  --allow-user-deferred-external-evidence');
  console.log('                                  Accept maintainer-deferred RSS/load evidence when docs carry an explicit marker.');
  console.log('  --help                        Show this help.');
}

function defaultDocsPath(...parts: string[]): string {
  return path.resolve(process.cwd(), '..', 'docs', 'features', 'enterprise-multi-tenant', ...parts);
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function sectionSlice(markdown: string, startHeading: string, endHeading?: string): MarkdownSection {
  const startIndex = markdown.indexOf(startHeading);
  if (startIndex < 0) return { content: '', startLine: 1 };
  const startLine = markdown.slice(0, startIndex).split(/\r?\n/).length;
  if (!endHeading) return { content: markdown.slice(startIndex), startLine };
  const endIndex = markdown.indexOf(endHeading, startIndex + startHeading.length);
  return {
    content: endIndex < 0 ? markdown.slice(startIndex) : markdown.slice(startIndex, endIndex),
    startLine,
  };
}

function parseTodos(markdown: string, lineOffset = 0): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^- \[([ xX])\] (.+)$/);
    if (!match) return;
    items.push({
      checked: match[1].toLowerCase() === 'x',
      text: match[2],
      line: lineOffset + index + 1,
    });
  });
  return items;
}

function blocked(id: string, message: string, evidence: string[]): ReadinessCheck {
  return { id, status: 'blocked', message, evidence };
}

function passed(id: string, message: string, evidence: string[]): ReadinessCheck {
  return { id, status: 'passed', message, evidence };
}

function hasUserDeferredExternalValidation(markdown: string): boolean {
  return markdown.includes(USER_DEFERRED_EXTERNAL_VALIDATION_MARKER);
}

function auditReadmeTodos(readme: string, readmePath: string): ReadinessCheck {
  const section0 = sectionSlice(readme, '## 0. 开发执行 TODO', '### 0.10 PR / 提交收尾');
  const todos = parseTodos(section0.content, section0.startLine - 1);
  const unchecked = todos.filter(item => !item.checked);

  if (unchecked.length > 0) {
    return blocked(
      'readme-section-0-todos',
      `README §0 before the PR closeout checklist still has ${unchecked.length} unchecked item(s).`,
      unchecked.map(item => `${path.basename(readmePath)}:${item.line} ${item.text}`),
    );
  }

  return passed(
    'readme-section-0-todos',
    `README §0 before the PR closeout checklist has ${todos.length} checked item(s) and no unchecked TODOs.`,
    [`${path.basename(readmePath)} §0`],
  );
}

function auditD1D10(readme: string): ReadinessCheck {
  const section = sectionSlice(readme, '### 0.7', '### 0.8');
  const items = parseTodos(section.content, section.startLine - 1)
    .filter(item => /^D(?:10|[1-9])\b/.test(item.text));
  const missingIds = Array.from({ length: 10 }, (_unused, index) => `D${index + 1}`)
    .filter(id => !items.some(item => item.text.startsWith(id)));
  const unchecked = items.filter(item => !item.checked);

  if (items.length !== 10 || missingIds.length > 0 || unchecked.length > 0) {
    return blocked(
      'd1-d10-automated-regression',
      'README §0.7 D1-D10 is not fully checked.',
      [
        `found=${items.length}`,
        `missing=${missingIds.join(', ') || 'none'}`,
        ...unchecked.map(item => `unchecked ${item.text}`),
      ],
    );
  }

  return passed(
    'd1-d10-automated-regression',
    'README §0.7 lists D1-D10 and all ten rows are checked.',
    items.map(item => item.text),
  );
}

function auditSection08(readme: string): ReadinessCheck {
  const section = sectionSlice(readme, '### 0.8', '### 0.9');
  const items = parseTodos(section.content, section.startLine - 1);
  const unchecked = items.filter(item => !item.checked);

  if (items.length !== 11 || unchecked.length > 0) {
    return blocked(
      'section-19-acceptance',
      'README §0.8 / §19 total acceptance is not fully checked.',
      [
        `found=${items.length}`,
        ...unchecked.map(item => `unchecked ${item.text}`),
      ],
    );
  }

  return passed(
    'section-19-acceptance',
    'README §0.8 has all 11 total-acceptance rows checked.',
    items.map(item => item.text),
  );
}

function auditPrCloseout(readme: string): ReadinessCheck {
  const section = sectionSlice(readme, '### 0.10', '## 1.');
  const items = parseTodos(section.content, section.startLine - 1);
  const unchecked = items.filter(item => !item.checked);

  if (items.length === 0 || unchecked.length > 0) {
    return blocked(
      'pr-closeout-checklist',
      'README §0.10 PR closeout checklist is not fully checked.',
      [
        `found=${items.length}`,
        ...unchecked.map(item => `unchecked README.md:${item.line} ${item.text}`),
      ],
    );
  }

  return passed(
    'pr-closeout-checklist',
    'README §0.10 PR closeout checklist is fully checked.',
    items.map(item => item.text),
  );
}

function auditAcceptanceEvidence(
  markdown: string,
  filePath: string,
  allowUserDeferredExternalEvidence: boolean,
): ReadinessCheck {
  const openRows = markdown
    .split(/\r?\n/)
    .filter(line => /^\| .+ \| Open \|/.test(line));
  const matrixRows = markdownTableRows(markdown).filter(row =>
    row['README §0.8 item'] !== undefined
    && row.Status !== undefined
    && row.Evidence !== undefined
  );
  const itemTexts = matrixRows.map(row => row['README §0.8 item']);
  const missingItems = REQUIRED_ACCEPTANCE_EVIDENCE_ITEMS.filter(required =>
    !itemTexts.some(item => normalizeAcceptanceEvidenceText(item).includes(normalizeAcceptanceEvidenceText(required)))
  );
  const hasDeferredMarker = hasUserDeferredExternalValidation(markdown);
  const unsupportedStatuses = matrixRows.filter((row) => {
    const status = row.Status.trim().toLowerCase();
    if (status === 'covered') return false;
    return !(allowUserDeferredExternalEvidence && hasDeferredMarker && status === 'user-deferred');
  });

  if (openRows.length > 0 || missingItems.length > 0 || unsupportedStatuses.length > 0) {
    return blocked(
      'acceptance-evidence-open-rows',
      `${path.basename(filePath)} is missing, open, or has non-final §19 acceptance row(s).`,
      [
        `found=${matrixRows.length}`,
        ...openRows,
        ...unsupportedStatuses.map(row => `non-final acceptance status: ${row['README §0.8 item']} => ${row.Status}`),
        ...missingItems.map(item => `missing acceptance evidence item: ${item}`),
      ],
    );
  }

  return passed(
    'acceptance-evidence-open-rows',
    allowUserDeferredExternalEvidence && hasDeferredMarker
      ? `${path.basename(filePath)} has all 11 §19 acceptance rows; maintainer-deferred external rows are explicit.`
      : `${path.basename(filePath)} has all 11 §19 acceptance rows and no Open rows.`,
    itemTexts,
  );
}

function normalizeAcceptanceEvidenceText(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function markdownTableValue(markdown: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^\\|\\s*${escapedLabel}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function parseMarkdownNumber(value: string | null): number | null {
  if (!value || value.toLowerCase() === 'n/a') return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMarkdownBytes(value: string | null): number | null {
  if (!value || value.trim().toLowerCase() === 'n/a') return null;
  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B|[KMGT]?B)?$/i);
  if (!match) return null;

  const numeric = Number.parseFloat(match[1]!);
  if (!Number.isFinite(numeric)) return null;

  const unit = (match[2] ?? 'B').toUpperCase();
  const multiplier = unit === 'GIB' || unit === 'GB'
    ? 1024 ** 3
    : unit === 'MIB' || unit === 'MB'
      ? 1024 ** 2
      : unit === 'KIB' || unit === 'KB'
        ? 1024
        : 1;
  return numeric * multiplier;
}

function requiredRssBucketMinimumBytes(sizeBucket: string): number {
  if (sizeBucket === '1GB') return 1024 ** 3;
  if (sizeBucket === '500MB') return 500 * 1024 ** 2;
  return 100 * 1024 ** 2;
}

function isPresentMarkdownMetric(value: string | null): boolean {
  return value !== null && value.trim().length > 0 && value.trim().toLowerCase() !== 'n/a';
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isMarkdownSeparatorRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function markdownTableRows(markdown: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i].trim().startsWith('|') || !isMarkdownSeparatorRow(lines[i + 1])) continue;
    const headers = splitMarkdownTableRow(lines[i]);

    let rowIndex = i + 2;
    while (rowIndex < lines.length && lines[rowIndex].trim().startsWith('|')) {
      if (!isMarkdownSeparatorRow(lines[rowIndex])) {
        const cells = splitMarkdownTableRow(lines[rowIndex]);
        const row: Record<string, string> = {};
        headers.forEach((header, index) => {
          row[header] = cells[index] ?? '';
        });
        rows.push(row);
      }
      rowIndex += 1;
    }
    i = rowIndex;
  }

  return rows;
}

function missingLoadReportMetricEvidence(markdown: string): string[] {
  const missing: string[] = [];
  const observedUsers = parseMarkdownNumber(markdownTableValue(markdown, 'Observed online users'));
  const targetRunning = parseMarkdownNumber(markdownTableValue(markdown, 'Target running runs'));
  const targetPending = parseMarkdownNumber(markdownTableValue(markdown, 'Target pending runs'));
  const visibleTraceMetadata = parseMarkdownNumber(markdownTableValue(markdown, 'Visible trace metadata'));
  const totalRequests = parseMarkdownNumber(markdownTableValue(markdown, 'Total HTTP requests'));
  const failedRequests = parseMarkdownNumber(markdownTableValue(markdown, 'Failed HTTP requests'));
  const maxErrorRate = parseMarkdownNumber(markdownTableValue(markdown, 'Max error rate'));
  const errorRate = parseMarkdownNumber(markdownTableValue(markdown, 'Error rate'));
  const startedRuns = parseMarkdownNumber(markdownTableValue(markdown, 'Started analysis runs'));
  const startFailures = parseMarkdownNumber(markdownTableValue(markdown, 'Start failures'));
  const missingIds = parseMarkdownNumber(markdownTableValue(markdown, 'Started runs missing ids'));
  const maxRunning = parseMarkdownNumber(markdownTableValue(markdown, 'Max running runs observed'));
  const maxPending = parseMarkdownNumber(markdownTableValue(markdown, 'Max queued/pending runs observed'));
  const runningSamples = parseMarkdownNumber(markdownTableValue(markdown, 'Running-in-range samples'));
  const pendingSamples = parseMarkdownNumber(markdownTableValue(markdown, 'Queued/pending samples'));
  const maxQueueLength = parseMarkdownNumber(markdownTableValue(markdown, 'Max queue length'));
  const preRunBaseline = markdownTableValue(markdown, 'Pre-run runtime baseline')?.trim().toLowerCase() ?? null;
  const estimatedDailyRuns = parseMarkdownNumber(markdownTableValue(markdown, 'Estimated daily analysis runs'));

  if (observedUsers === null || observedUsers < 50) missing.push('observed online users < 50');
  if (targetRunning === null || targetRunning < 5 || targetRunning > 15) missing.push('target running runs not in 5-15 range');
  if (targetPending === null || targetPending < 1) missing.push('target pending runs missing');
  if (visibleTraceMetadata === null || visibleTraceMetadata < MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA) {
    missing.push(`visible trace metadata < ${MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA}`);
  }
  if (totalRequests === null || totalRequests <= 0) missing.push('total HTTP requests <= 0');
  if (failedRequests === null || failedRequests < 0) missing.push('missing failed HTTP requests');
  if (maxErrorRate === null) missing.push('missing max error rate');
  if (errorRate === null) missing.push('missing error rate');
  else if (maxErrorRate !== null && errorRate > maxErrorRate) missing.push('error rate exceeds max error rate');
  if (startedRuns === null || targetRunning === null || targetPending === null || startedRuns < targetRunning + targetPending) {
    missing.push('started analysis runs < requested target');
  }
  if (startFailures !== 0) missing.push('start failures not zero');
  if (missingIds !== 0) missing.push('started runs missing ids not zero');
  if (maxRunning === null || maxRunning < 5 || maxRunning > 15) missing.push('max running runs not in 5-15 range');
  if (runningSamples === null || runningSamples < 2) missing.push('running runs stable samples < 2');
  if (maxPending === null || maxPending < 1) missing.push('queued/pending runs not observed');
  if (pendingSamples === null || pendingSamples < 2) missing.push('queued/pending stable samples < 2');
  if (!isPresentMarkdownMetric(markdownTableValue(markdown, 'Overall p50'))) missing.push('missing overall p50');
  if (!isPresentMarkdownMetric(markdownTableValue(markdown, 'Overall p95'))) missing.push('missing overall p95');
  if (maxQueueLength === null) missing.push('missing max queue length');
  if (preRunBaseline !== 'yes') missing.push('pre-run runtime baseline not yes');
  if (
    !isPresentMarkdownMetric(markdownTableValue(markdown, 'Max worker RSS'))
    && !isPresentMarkdownMetric(markdownTableValue(markdown, 'Max lease RSS'))
  ) {
    missing.push('missing worker/lease RSS');
  }
  if (estimatedDailyRuns === null || estimatedDailyRuns < MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS) {
    missing.push(`estimated daily analysis runs < ${MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS}`);
  }
  const requestedRuns = targetRunning !== null && targetPending !== null
    ? targetRunning + targetPending
    : null;
  missing.push(...missingLoadReportOnlineUserEvidence(markdown, observedUsers));
  missing.push(...missingLoadReportRunTableEvidence(markdown, requestedRuns));
  missing.push(...missingLoadReportStatusSnapshotEvidence(markdown));
  missing.push(...missingLoadReportRuntimeSampleEvidence(markdown));

  return missing;
}

function missingLoadReportOnlineUserEvidence(markdown: string, observedUsers: number | null): string[] {
  const missing: string[] = [];
  const userRows = markdownTableRows(markdown).filter(row =>
    row.User !== undefined
    && row['Successful trace_list samples'] !== undefined
    && row['Failed trace_list samples'] !== undefined
    && row['Max visible trace metadata'] !== undefined
  );
  const distinctUsers = new Set(userRows.map(row => row.User.trim()).filter(user => user.startsWith('online-user-')));
  const requiredUsers = Math.max(50, observedUsers ?? 0);

  if (distinctUsers.size < requiredUsers) {
    missing.push(`online user sample rows < ${requiredUsers}`);
  }

  const rowsWithNoSuccessfulTraceList = userRows.filter((row) => {
    const successCount = parseMarkdownNumber(row['Successful trace_list samples']);
    return row.User.trim().startsWith('online-user-') && (successCount === null || successCount < 1);
  });
  if (rowsWithNoSuccessfulTraceList.length > 0) {
    missing.push('online user sample rows without successful trace_list samples');
  }

  const rowsBelowTraceScale = userRows.filter((row) => {
    const visibleTraceMetadata = parseMarkdownNumber(row['Max visible trace metadata']);
    return row.User.trim().startsWith('online-user-')
      && (
        visibleTraceMetadata === null
        || visibleTraceMetadata < MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA
      );
  });
  if (rowsBelowTraceScale.length > 0) {
    missing.push(`online user sample rows with max visible trace metadata < ${MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA}`);
  }

  return missing;
}

function missingLoadReportStatusSnapshotEvidence(markdown: string): string[] {
  const missing: string[] = [];
  const snapshotRows = markdownTableRows(markdown).filter(row =>
    row.Timestamp !== undefined
    && row.Queued !== undefined
    && row.Pending !== undefined
    && row.Running !== undefined
    && row.Failed !== undefined
    && row.Error !== undefined
    && row['Quota exceeded'] !== undefined
  );

  if (snapshotRows.length === 0) {
    missing.push('missing status snapshot table');
    return missing;
  }

  const runningInRangeRows = snapshotRows.filter((row) => {
    const running = parseMarkdownNumber(row.Running);
    return running !== null && running >= 5 && running <= 15;
  });
  if (runningInRangeRows.length < 2) {
    missing.push('status snapshot rows with running 5-15 < 2');
  }

  const queuedOrPendingRows = snapshotRows.filter((row) => {
    const queued = parseMarkdownNumber(row.Queued) ?? 0;
    const pending = parseMarkdownNumber(row.Pending) ?? 0;
    return queued + pending > 0;
  });
  if (queuedOrPendingRows.length < 2) {
    missing.push('status snapshot rows with queued/pending > 0 < 2');
  }

  if (snapshotRows.some((row) => {
    const failed = parseMarkdownNumber(row.Failed) ?? 0;
    const error = parseMarkdownNumber(row.Error) ?? 0;
    const quotaExceeded = parseMarkdownNumber(row['Quota exceeded']) ?? 0;
    return failed + error + quotaExceeded > 0;
  })) {
    missing.push('status snapshot table has failed/error/quota_exceeded counts');
  }

  return missing;
}

function missingLoadReportRuntimeSampleEvidence(markdown: string): string[] {
  const missing: string[] = [];
  const runtimeRows = markdownTableRows(markdown).filter(row =>
    row.Timestamp !== undefined
    && row['Queue length'] !== undefined
    && row['Worker RSS'] !== undefined
    && row['Lease RSS'] !== undefined
  );

  if (runtimeRows.length < 2) {
    missing.push('runtime sample rows < 2');
    return missing;
  }

  if (runtimeRows.every(row => parseMarkdownNumber(row['Queue length']) === null)) {
    missing.push('runtime sample table missing queue length values');
  }
  if (runtimeRows.every(row =>
    !isPresentMarkdownMetric(row['Worker RSS'] ?? null)
    && !isPresentMarkdownMetric(row['Lease RSS'] ?? null)
  )) {
    missing.push('runtime sample table missing RSS values');
  }

  return missing;
}

function missingLoadReportRunTableEvidence(markdown: string, requestedRuns: number | null): string[] {
  const missing: string[] = [];
  const runRows = markdownTableRows(markdown).filter(row =>
    row.User !== undefined
    && row.Trace !== undefined
    && row.Session !== undefined
    && row.Run !== undefined
    && row.Start !== undefined
    && row['Last status'] !== undefined
  );

  if (runRows.length === 0) {
    missing.push('missing analysis run table');
    return missing;
  }
  if (requestedRuns !== null && runRows.length < requestedRuns) {
    missing.push('analysis run rows < requested target');
  }
  if (runRows.some(row => row.Session.trim().length === 0 || row.Run.trim().length === 0)) {
    missing.push('analysis run table has missing session/run ids');
  }
  if (runRows.some(row => {
    const startStatus = parseMarkdownNumber(row.Start);
    return startStatus === null || startStatus < 200 || startStatus >= 300;
  })) {
    missing.push('analysis run table has non-2xx start status');
  }
  if (runRows.some(row => ['failed', 'error', 'quota_exceeded'].includes(row['Last status'].trim().toLowerCase()))) {
    missing.push('analysis run table has terminal failed/error/quota_exceeded rows');
  }

  return missing;
}

function missingRssBenchmarkMetricEvidence(markdown: string): string[] {
  const missing: string[] = [];
  const rssRows = markdownTableRows(markdown).filter(row =>
    row.Scene !== undefined
    && row['Size bucket'] !== undefined
    && row.Status !== undefined
  );
  const requiredMetrics = [
    ['Startup RSS', 'startup RSS'],
    ['Load peak', 'load peak'],
    ['Post-load RSS', 'post-load RSS'],
    ['Query peak', 'query peak'],
    ['Query delta', 'query delta'],
    ['Query headroom', 'query headroom'],
  ] as const;

  for (const scene of REQUIRED_RSS_BENCHMARK_SCENES) {
    for (const sizeBucket of REQUIRED_RSS_BENCHMARK_SIZE_BUCKETS) {
      const cell = `${scene}:${sizeBucket}`;
      const cellRows = rssRows.filter(row =>
        row.Scene.trim().toLowerCase() === scene
        && row['Size bucket'].trim().toUpperCase() === sizeBucket
      );
      if (cellRows.length === 0) {
        missing.push(`missing RSS matrix cell ${cell}`);
        continue;
      }

      const passedRows = cellRows.filter(row => row.Status.trim().toLowerCase().startsWith('passed'));
      if (passedRows.length === 0) {
        missing.push(`RSS cell ${cell} missing passed status`);
        continue;
      }

      const hasRequiredFileSize = passedRows.some((row) => {
        const fileSizeBytes = parseMarkdownBytes(row['File size'] ?? null);
        return fileSizeBytes !== null && fileSizeBytes >= requiredRssBucketMinimumBytes(sizeBucket);
      });
      if (!hasRequiredFileSize) {
        missing.push(`RSS cell ${cell} missing file size >= ${sizeBucket}`);
      }

      for (const [column, label] of requiredMetrics) {
        if (passedRows.every(row => !isPresentMarkdownMetric(row[column] ?? null))) {
          missing.push(`RSS cell ${cell} missing ${label}`);
        }
      }
    }
  }

  return missing;
}

function auditLoadReport(
  markdown: string,
  filePath: string,
  allowUserDeferredExternalEvidence: boolean,
): ReadinessCheck {
  if (allowUserDeferredExternalEvidence && hasUserDeferredExternalValidation(markdown)) {
    return passed(
      'load-test-report-final',
      `${path.basename(filePath)} explicitly defers the real 50-user load-test run to the maintainer.`,
      [USER_DEFERRED_EXTERNAL_VALIDATION_MARKER],
    );
  }

  const lower = markdown.toLowerCase();
  const hasPendingStatus = lower.includes('status: pending');
  const hasAcceptancePass = markdown.includes('Acceptance status: passed');
  const hasPreflightMarker = lower.includes('preflight');
  const missingMetrics = missingLoadReportMetricEvidence(markdown);

  if (hasPendingStatus || !hasAcceptancePass || hasPreflightMarker || missingMetrics.length > 0) {
    return blocked(
      'load-test-report-final',
      `${path.basename(filePath)} is not a final passing load-test report.`,
      [
        hasPendingStatus ? 'contains Status: pending' : 'does not contain Status: pending',
        hasAcceptancePass ? 'contains passing acceptance marker' : 'missing passing acceptance marker',
        hasPreflightMarker ? 'contains preflight marker' : 'does not contain preflight marker',
        ...missingMetrics,
      ],
    );
  }

  return passed(
    'load-test-report-final',
    `${path.basename(filePath)} contains final passing load-test evidence.`,
    [path.basename(filePath)],
  );
}

function auditRssBenchmark(
  markdown: string,
  filePath: string,
  allowUserDeferredExternalEvidence: boolean,
): ReadinessCheck {
  if (allowUserDeferredExternalEvidence && hasUserDeferredExternalValidation(markdown)) {
    return passed(
      'rss-benchmark-final',
      `${path.basename(filePath)} explicitly defers the real large-trace RSS matrix to the maintainer.`,
      [USER_DEFERRED_EXTERNAL_VALIDATION_MARKER],
    );
  }

  const lower = markdown.toLowerCase();
  const hasBlockedLanguage = lower.includes('blocked');
  const hasCompleteMarker = markdown.includes('Coverage status: complete');
  const hasCandidateAuditMarker = lower.includes('candidate audit')
    || lower.includes('candidate_matrix_ready')
    || lower.includes('not rss benchmark evidence');
  const missingMetrics = missingRssBenchmarkMetricEvidence(markdown);

  if (hasBlockedLanguage || !hasCompleteMarker || hasCandidateAuditMarker || missingMetrics.length > 0) {
    return blocked(
      'rss-benchmark-final',
      `${path.basename(filePath)} does not contain complete §0.4.3 RSS matrix evidence.`,
      [
        hasBlockedLanguage ? 'contains blocked/missing language' : 'no blocked/missing language found',
        hasCompleteMarker ? 'contains complete coverage marker' : 'missing complete coverage marker',
        hasCandidateAuditMarker ? 'contains candidate-audit marker' : 'does not contain candidate-audit marker',
        ...missingMetrics,
      ],
    );
  }

  return passed(
    'rss-benchmark-final',
    `${path.basename(filePath)} contains complete §0.4.3 RSS matrix evidence.`,
    [path.basename(filePath)],
  );
}

function auditReleaseNotes(
  markdown: string,
  filePath: string,
  allowUserDeferredExternalEvidence: boolean,
): ReadinessCheck {
  if (allowUserDeferredExternalEvidence && hasUserDeferredExternalValidation(markdown)) {
    return passed(
      'release-notes-final',
      `${path.basename(filePath)} is final for agent scope with explicit maintainer-deferred external validation.`,
      [USER_DEFERRED_EXTERNAL_VALIDATION_MARKER],
    );
  }

  const lower = markdown.toLowerCase();
  const draftOrOpen = lower.includes('status: draft')
    || lower.includes('pending final')
    || /\| [^|\n]+ \| Open \|/.test(markdown);

  if (draftOrOpen) {
    return blocked(
      'release-notes-final',
      `${path.basename(filePath)} is still draft or contains Open acceptance rows.`,
      ['draft/pending/open marker found'],
    );
  }

  return passed(
    'release-notes-final',
    `${path.basename(filePath)} has no draft/pending/open marker.`,
    [path.basename(filePath)],
  );
}

export function parseEnterpriseReadinessAuditArgs(
  argv: string[],
  cwd = process.cwd(),
): EnterpriseReadinessAuditOptions {
  const options: EnterpriseReadinessAuditOptions = {
    readmePath: defaultDocsPath('README.md'),
    acceptanceEvidencePath: defaultDocsPath('acceptance-evidence.md'),
    loadTestReportPath: defaultDocsPath('load-test-report.md'),
    rssBenchmarkPath: defaultDocsPath('rss-benchmark.md'),
    releaseNotesPath: defaultDocsPath('release-notes.md'),
    requireReady: false,
    allowUserDeferredExternalEvidence: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--readme') {
      if (!next) throw new Error('--readme requires a value');
      options.readmePath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--acceptance-evidence') {
      if (!next) throw new Error('--acceptance-evidence requires a value');
      options.acceptanceEvidencePath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--load-test-report') {
      if (!next) throw new Error('--load-test-report requires a value');
      options.loadTestReportPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--rss-benchmark') {
      if (!next) throw new Error('--rss-benchmark requires a value');
      options.rssBenchmarkPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--release-notes') {
      if (!next) throw new Error('--release-notes requires a value');
      options.releaseNotesPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!next) throw new Error('--output requires a value');
      options.outputPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--markdown') {
      if (!next) throw new Error('--markdown requires a value');
      options.markdownPath = path.resolve(cwd, next);
      i += 1;
      continue;
    }
    if (arg === '--require-ready') {
      options.requireReady = true;
      continue;
    }
    if (arg === '--allow-user-deferred-external-evidence') {
      options.allowUserDeferredExternalEvidence = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function buildEnterpriseReadinessAuditReport(
  options: EnterpriseReadinessAuditOptions,
): EnterpriseReadinessAuditReport {
  const readme = readFile(options.readmePath);
  const acceptanceEvidence = readFile(options.acceptanceEvidencePath);
  const loadTestReport = readFile(options.loadTestReportPath);
  const rssBenchmark = readFile(options.rssBenchmarkPath);
  const releaseNotes = readFile(options.releaseNotesPath);

  const checks = [
    auditReadmeTodos(readme, options.readmePath),
    auditD1D10(readme),
    auditSection08(readme),
    auditPrCloseout(readme),
    auditAcceptanceEvidence(
      acceptanceEvidence,
      options.acceptanceEvidencePath,
      options.allowUserDeferredExternalEvidence === true,
    ),
    auditLoadReport(loadTestReport, options.loadTestReportPath, options.allowUserDeferredExternalEvidence === true),
    auditRssBenchmark(rssBenchmark, options.rssBenchmarkPath, options.allowUserDeferredExternalEvidence === true),
    auditReleaseNotes(releaseNotes, options.releaseNotesPath, options.allowUserDeferredExternalEvidence === true),
  ];

  return {
    generatedAt: new Date().toISOString(),
    ready: checks.every(check => check.status === 'passed'),
    checks,
    artifacts: {
      readme: options.readmePath,
      acceptanceEvidence: options.acceptanceEvidencePath,
      loadTestReport: options.loadTestReportPath,
      rssBenchmark: options.rssBenchmarkPath,
      releaseNotes: options.releaseNotesPath,
    },
  };
}

export function determineEnterpriseReadinessAuditExitCode(
  report: EnterpriseReadinessAuditReport,
  options: Pick<EnterpriseReadinessAuditOptions, 'requireReady'>,
): number {
  return options.requireReady && !report.ready ? 2 : 0;
}

export function buildMarkdownEnterpriseReadinessAudit(report: EnterpriseReadinessAuditReport): string {
  const lines: string[] = [];
  lines.push('# Enterprise Multi-Tenant Readiness Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`Overall status: ${report.ready ? 'ready' : 'blocked'}`);
  lines.push('');
  lines.push('| Check | Status | Message |');
  lines.push('| --- | --- | --- |');
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${check.message} |`);
  }
  lines.push('');
  lines.push('## Blocking Evidence');
  lines.push('');
  const blockers = report.checks.filter(check => check.status === 'blocked');
  if (blockers.length === 0) {
    lines.push('- none');
  } else {
    for (const check of blockers) {
      lines.push(`- ${check.id}: ${check.message}`);
      for (const item of check.evidence) {
        lines.push(`  - ${item}`);
      }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeReportFiles(
  report: EnterpriseReadinessAuditReport,
  options: EnterpriseReadinessAuditOptions,
): Promise<void> {
  if (options.outputPath) {
    await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fsp.writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[Enterprise Readiness Audit] JSON report: ${options.outputPath}`);
  }

  if (options.markdownPath) {
    await fsp.mkdir(path.dirname(options.markdownPath), { recursive: true });
    await fsp.writeFile(options.markdownPath, buildMarkdownEnterpriseReadinessAudit(report), 'utf8');
    console.log(`[Enterprise Readiness Audit] Markdown report: ${options.markdownPath}`);
  }
}

async function main(): Promise<void> {
  const options = parseEnterpriseReadinessAuditArgs(process.argv.slice(2));
  const report = buildEnterpriseReadinessAuditReport(options);
  await writeReportFiles(report, options);

  if (!report.ready) {
    const blockers = report.checks
      .filter(check => check.status === 'blocked')
      .map(check => check.id)
      .join(', ');
    console.warn(`[Enterprise Readiness Audit] Blocked: ${blockers}`);
  }

  process.exitCode = determineEnterpriseReadinessAuditExitCode(report, options) || undefined;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Enterprise Readiness Audit] ${error.message}`);
    process.exit(1);
  });
}
