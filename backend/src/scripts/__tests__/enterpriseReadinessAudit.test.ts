// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildEnterpriseReadinessAuditReport,
  buildMarkdownEnterpriseReadinessAudit,
  determineEnterpriseReadinessAuditExitCode,
  parseEnterpriseReadinessAuditArgs,
} from '../enterpriseReadinessAudit';

async function writeFixture(root: string, name: string, content: string): Promise<string> {
  const filePath = path.join(root, name);
  await fsp.writeFile(filePath, content, 'utf8');
  return filePath;
}

function completeReadme(): string {
  const section08Rows = Array.from({ length: 11 }, (_unused, index) => `- [x] §19 item ${index + 1}`).join('\n');
  const dRows = Array.from({ length: 10 }, (_unused, index) => `- [x] D${index + 1} scenario`).join('\n');
  return [
    '# README',
    '',
    '## 0. 开发执行 TODO',
    '- [x] setup',
    '### 0.7 §23 反证循环',
    dRows,
    '### 0.8 §19 总验收',
    section08Rows,
    '### 0.9 新增 / 引用文档登记',
    '- [x] docs',
    '### 0.10 PR / 提交收尾',
    '- [x] PR gate',
    '## 1. 文档定位',
    '',
  ].join('\n');
}

function finalAnalysisRunRows(count = 15): string[] {
  return [
    '## Analysis Runs',
    '',
    '| User | Trace | Session | Run | Start | Last status | Error |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
    ...Array.from({ length: count }, (_unused, index) => {
      const ordinal = index + 1;
      return `| load-user-${String(ordinal).padStart(3, '0')} | trace-a | session-${ordinal} | run-${ordinal} | 200 | running |  |`;
    }),
  ];
}

function finalOnlineUserSampleRows(count = 50): string[] {
  return [
    '## Online User Samples',
    '',
    '| User | Successful trace_list samples | Failed trace_list samples | Max visible trace metadata |',
    '| --- | ---: | ---: | ---: |',
    ...Array.from({ length: count }, (_unused, index) => {
      const ordinal = index + 1;
      return `| online-user-${String(ordinal).padStart(3, '0')} | 1 | 0 | 1000 |`;
    }),
  ];
}

function finalStatusSnapshotRows(): string[] {
  return [
    '## Status Snapshots',
    '',
    '| Timestamp | Queued | Pending | Running | Completed | Failed | Error | Quota exceeded | Unknown |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    '| 2026-05-09T00:00:01.000Z | 3 | 2 | 5 | 0 | 0 | 0 | 0 | 0 |',
    '| 2026-05-09T00:00:02.000Z | 2 | 3 | 10 | 0 | 0 | 0 | 0 | 0 |',
    '| 2026-05-09T00:00:03.000Z | 0 | 1 | 10 | 4 | 0 | 0 | 0 | 0 |',
  ];
}

function finalRuntimeSampleRows(): string[] {
  return [
    '## Runtime Samples',
    '',
    '| Timestamp | Queue length | Worker RSS | Lease RSS |',
    '| --- | ---: | ---: | ---: |',
    '| 2026-05-09T00:00:00.000Z | 1 | 128.0 MiB | 64.0 MiB |',
    '| 2026-05-09T00:00:01.000Z | 5 | 256.0 MiB | 128.0 MiB |',
  ];
}

function finalLoadReport(): string {
  return [
    '# Enterprise Acceptance Load Test Report',
    '',
    'Acceptance status: passed',
    '',
    '## Configuration',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    '| Online users | 50 |',
    '| Observed online users | 50 |',
    '| Target running runs | 10 |',
    '| Target pending runs | 5 |',
    '| Max error rate | 1.00% |',
    '| Duration | 300000ms |',
    '| Trace count | 1 |',
    '| Visible trace metadata | 1000 |',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    '| Total HTTP requests | 500 |',
    '| Failed HTTP requests | 0 |',
    '| Error rate | 0.00% |',
    '| Overall p50 | 42ms |',
    '| Overall p95 | 120ms |',
    '| Started analysis runs | 15 |',
    '| Start failures | 0 |',
    '| Started runs missing ids | 0 |',
    '| Max running runs observed | 10 |',
    '| Max queued/pending runs observed | 5 |',
    '| Running-in-range samples | 3 |',
    '| Queued/pending samples | 3 |',
    '| Max queue length | 5 |',
    '| Pre-run runtime baseline | yes |',
    '| Max worker RSS | 256.0 MiB |',
    '| Max lease RSS | 128.0 MiB |',
    '| Completed analysis runs | 4 |',
    '| Estimated daily analysis runs | 1152 |',
    '',
    ...finalOnlineUserSampleRows(),
    '',
    ...finalStatusSnapshotRows(),
    '',
    ...finalRuntimeSampleRows(),
    '',
    ...finalAnalysisRunRows(),
    '',
  ].join('\n');
}

function finalAcceptanceEvidence(): string {
  return [
    '| README §0.8 item | Status | Evidence |',
    '| --- | --- | --- |',
    '| 50 online users + 5-15 running runs + stable pending queue | Covered | measured load report |',
    '| Users cannot guess `traceId` / `sessionId` / `runId` / `reportId` for cross-resource access | Covered | route tests |',
    '| A delete/cleanup does not affect B running run / active lease | Covered | cleanup tests |',
    '| Provider isolation: A personal provider does not affect B; workspace default changes only affect new sessions | Covered | provider tests |',
    '| Provider config changes do not resume the wrong SDK session | Covered | snapshot tests |',
    '| SSE fetch-stream reconnects with `Last-Event-ID` | Covered | SSE replay tests |',
    '| Two windows open two traces without pending trace / AI session / SSE / lease cross-talk | Covered | D1-D10 tests |',
    '| One slow SQL does not directly kill a frontend-owned lease | Covered | runtime tests |',
    '| Memory / SQL learning / case / baseline default to tenant/workspace isolation | Covered | scope tests |',
    '| Tenant export / tombstone / async purge / audit proof all work | Covered | tenant tests |',
    '| Load-test report includes p50/p95, error rate, worker RSS, queue length, trace metadata scale, and daily analysis run projection | Covered | measured load report |',
    '',
  ].join('\n');
}

function finalRssBenchmark(): string {
  const scenes = ['scroll', 'startup', 'anr', 'memory', 'heapprofd', 'vendor'];
  const sizeBuckets = ['100MB', '500MB', '1GB'];
  const rows = scenes.flatMap(scene =>
    sizeBuckets.map(sizeBucket => [
      `| ${scene}-${sizeBucket}`,
      scene,
      sizeBucket,
      sizeBucket,
      '10ms',
      '100.0 MiB',
      '200.0 MiB',
      '205.0 MiB',
      '210.0 MiB',
      '5.0 MiB',
      '63.00 GiB',
      'passed |',
    ].join(' | '))
  );

  return [
    '# Trace Processor RSS Benchmark',
    '',
    'Coverage status: complete',
    '',
    '| Trace | Scene | Size bucket | File size | Init | Startup RSS | Load peak | Post-load RSS | Query peak | Query delta | Query headroom | Status |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    'Missing required matrix cells:',
    '',
    '- none',
    '',
  ].join('\n');
}

function deferredAcceptanceEvidence(): string {
  return [
    'User-deferred external validation: yes',
    '',
    '| README §0.8 item | Status | Evidence |',
    '| --- | --- | --- |',
    '| 50 online users + 5-15 running runs + stable pending queue | User-deferred | Maintainer deferred the real 50-user run on 2026-05-09. |',
    '| Users cannot guess `traceId` / `sessionId` / `runId` / `reportId` for cross-resource access | Covered | route tests |',
    '| A delete/cleanup does not affect B running run / active lease | Covered | cleanup tests |',
    '| Provider isolation: A personal provider does not affect B; workspace default changes only affect new sessions | Covered | provider tests |',
    '| Provider config changes do not resume the wrong SDK session | Covered | snapshot tests |',
    '| SSE fetch-stream reconnects with `Last-Event-ID` | Covered | SSE replay tests |',
    '| Two windows open two traces without pending trace / AI session / SSE / lease cross-talk | Covered | D1-D10 tests |',
    '| One slow SQL does not directly kill a frontend-owned lease | Covered | runtime tests |',
    '| Memory / SQL learning / case / baseline default to tenant/workspace isolation | Covered | scope tests |',
    '| Tenant export / tombstone / async purge / audit proof all work | Covered | tenant tests |',
    '| Load-test report includes p50/p95, error rate, worker RSS, queue length, trace metadata scale, and daily analysis run projection | User-deferred | Maintainer deferred the real load metrics on 2026-05-09. |',
    '',
  ].join('\n');
}

function deferredLoadReport(): string {
  return [
    '# Enterprise Acceptance Load Test Report',
    '',
    'User-deferred external validation: yes',
    '',
    'Maintainer deferred the real 50-online-user load run on 2026-05-09.',
    'This is not measured load-test evidence.',
    '',
  ].join('\n');
}

function deferredRssBenchmark(): string {
  return [
    '# §0.4.3 Trace Processor RSS Benchmark Runbook',
    '',
    'User-deferred external validation: yes',
    '',
    'Maintainer deferred the full large-trace RSS matrix on 2026-05-09.',
    'This is not complete RSS benchmark evidence.',
    '',
  ].join('\n');
}

function deferredReleaseNotes(): string {
  return [
    '# SmartPerfetto Enterprise Multi-Tenant Release Notes',
    '',
    'Status: agent scope complete; external validation deferred to maintainer.',
    '',
    'User-deferred external validation: yes',
    '',
  ].join('\n');
}

describe('enterprise readiness audit', () => {
  it('parses artifact paths and require-ready mode', () => {
    const cwd = '/tmp/smartperfetto/backend';
    const options = parseEnterpriseReadinessAuditArgs([
      '--readme', '../docs/README.md',
      '--acceptance-evidence', '../docs/acceptance.md',
      '--load-test-report', '../docs/load.md',
      '--rss-benchmark', '../docs/rss.md',
      '--release-notes', '../docs/release.md',
      '--output', 'out/readiness.json',
      '--markdown', 'out/readiness.md',
      '--require-ready',
      '--allow-user-deferred-external-evidence',
    ], cwd);

    expect(options).toMatchObject({
      readmePath: path.resolve(cwd, '../docs/README.md'),
      acceptanceEvidencePath: path.resolve(cwd, '../docs/acceptance.md'),
      loadTestReportPath: path.resolve(cwd, '../docs/load.md'),
      rssBenchmarkPath: path.resolve(cwd, '../docs/rss.md'),
      releaseNotesPath: path.resolve(cwd, '../docs/release.md'),
      outputPath: path.resolve(cwd, 'out/readiness.json'),
      markdownPath: path.resolve(cwd, 'out/readiness.md'),
      requireReady: true,
      allowUserDeferredExternalEvidence: true,
    });
  });

  it('blocks current-style incomplete evidence instead of relying on green tests', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme().replace('- [x] §19 item 1', '- [ ] 50 online users'));
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', '| item | Status | Evidence |\n| load | Open | pending |\n');
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', 'Status: pending real 50-user run.\n');
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', 'Coverage status: blocked_missing_required_traces\nMissing required matrix cells:\n- scroll:100MB\n');
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', 'Status: draft, pending final RSS matrix and 50-user load-test evidence.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.filter(check => check.status === 'blocked').map(check => check.id)).toEqual([
        'readme-section-0-todos',
        'section-19-acceptance',
        'acceptance-evidence-open-rows',
        'load-test-report-final',
        'rss-benchmark-final',
        'release-notes-final',
      ]);
      expect(determineEnterpriseReadinessAuditExitCode(report, { requireReady: true })).toBe(2);
      expect(buildMarkdownEnterpriseReadinessAudit(report)).toContain('Overall status: blocked');
      expect(report.checks.find(check => check.id === 'pr-closeout-checklist')).toMatchObject({
        status: 'passed',
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes only when README §0, D1-D10, §19, and terminal docs are all final', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(true);
      expect(report.checks.every(check => check.status === 'passed')).toBe(true);
      expect(determineEnterpriseReadinessAuditExitCode(report, { requireReady: true })).toBe(0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes maintainer-deferred external evidence only when explicitly allowed', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', deferredAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', deferredLoadReport());
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', deferredRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', deferredReleaseNotes());

      const strictReport = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
        allowUserDeferredExternalEvidence: false,
      });
      expect(strictReport.ready).toBe(false);
      expect(strictReport.checks.filter(check => check.status === 'blocked').map(check => check.id)).toEqual([
        'acceptance-evidence-open-rows',
        'load-test-report-final',
        'rss-benchmark-final',
      ]);

      const deferredReport = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
        allowUserDeferredExternalEvidence: true,
      });

      expect(deferredReport.ready).toBe(true);
      expect(deferredReport.checks.every(check => check.status === 'passed')).toBe(true);
      expect(determineEnterpriseReadinessAuditExitCode(deferredReport, { requireReady: true })).toBe(0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final load report metrics, not just a passing marker', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', 'Acceptance status: passed\n');
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'observed online users < 50',
          'missing overall p50',
          'missing worker/lease RSS',
          'estimated daily analysis runs < 200',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires load-test scale evidence for trace metadata and daily analysis runs', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        finalLoadReport()
          .replace('| Visible trace metadata | 1000 |', '| Visible trace metadata | 999 |')
          .replace('| Estimated daily analysis runs | 1152 |', '| Estimated daily analysis runs | 199 |'),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'visible trace metadata < 1000',
          'estimated daily analysis runs < 200',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final load report baseline and budget evidence, not just passing text', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        finalLoadReport()
          .replace('| Error rate | 0.00% |', '| Error rate | 2.00% |')
          .replace('| Pre-run runtime baseline | yes |', '| Pre-run runtime baseline | no |'),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'error rate exceeds max error rate',
          'pre-run runtime baseline not yes',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final load report analysis run rows to be directly auditable', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        finalLoadReport().replace(
          '| load-user-015 | trace-a | session-15 | run-15 | 200 | running |  |',
          '| load-user-015 | trace-a |  | run-15 | 500 | failed | boom |',
        ),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'analysis run table has missing session/run ids',
          'analysis run table has non-2xx start status',
          'analysis run table has terminal failed/error/quota_exceeded rows',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final load report online user sample rows to be directly auditable', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        finalLoadReport()
          .replace('| online-user-050 | 1 | 0 | 1000 |', '')
          .replace('| online-user-049 | 1 | 0 | 1000 |', '| online-user-049 | 0 | 1 | n/a |'),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'online user sample rows < 50',
          'online user sample rows without successful trace_list samples',
          'online user sample rows with max visible trace metadata < 1000',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final load report status snapshots and runtime samples to be directly auditable', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        finalLoadReport()
          .replace('| 2026-05-09T00:00:01.000Z | 3 | 2 | 5 | 0 | 0 | 0 | 0 | 0 |', '| 2026-05-09T00:00:01.000Z | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 |')
          .replace('| 2026-05-09T00:00:02.000Z | 2 | 3 | 10 | 0 | 0 | 0 | 0 | 0 |', '| 2026-05-09T00:00:02.000Z | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |')
          .replace('| 2026-05-09T00:00:03.000Z | 0 | 1 | 10 | 4 | 0 | 0 | 0 | 0 |', '| 2026-05-09T00:00:03.000Z | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |')
          .replace('| 2026-05-09T00:00:00.000Z | 1 | 128.0 MiB | 64.0 MiB |', '| 2026-05-09T00:00:00.000Z | n/a | n/a | n/a |')
          .replace('| 2026-05-09T00:00:01.000Z | 5 | 256.0 MiB | 128.0 MiB |', '| 2026-05-09T00:00:01.000Z | n/a | n/a | n/a |'),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'status snapshot rows with running 5-15 < 2',
          'status snapshot rows with queued/pending > 0 < 2',
          'status snapshot table has failed/error/quota_exceeded counts',
          'runtime sample table missing queue length values',
          'runtime sample table missing RSS values',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects load-test preflight output even if it contains a passing marker', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(
        tmpDir,
        'load.md',
        [
          '# Enterprise Acceptance Load Test Preflight',
          'Preflight status: ready',
          'Acceptance status: passed',
          'This preflight does not start analysis runs and is not README §0.8 acceptance evidence.',
        ].join('\n'),
      );
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'load-test-report-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'contains preflight marker',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires all eleven §19 acceptance evidence rows, not just a covered marker', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(
        tmpDir,
        'acceptance.md',
        '| README §0.8 item | Status | Evidence |\n| --- | --- | --- |\n| load | Covered | measured |\n',
      );
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'acceptance-evidence-open-rows')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'found=1',
          expect.stringContaining('missing acceptance evidence item: 50 online users'),
          expect.stringContaining('missing acceptance evidence item: Load-test report includes p50/p95'),
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final RSS matrix rows and metrics, not just a complete marker', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', 'Coverage status: complete\n');
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'rss-benchmark-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'missing RSS matrix cell scroll:100MB',
          'missing RSS matrix cell vendor:1GB',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires query headroom in final RSS benchmark rows', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(
        tmpDir,
        'rss.md',
        finalRssBenchmark().replace(/63\.00 GiB/g, 'n/a'),
      );
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'rss-benchmark-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'RSS cell scroll:100MB missing query headroom',
          'RSS cell vendor:1GB missing query headroom',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final RSS rows to include the full memory measurement set', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(
        tmpDir,
        'rss.md',
        finalRssBenchmark()
          .replace(/205\.0 MiB/g, 'n/a')
          .replace(/210\.0 MiB/g, 'n/a')
          .replace(/5\.0 MiB/g, 'n/a'),
      );
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'rss-benchmark-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'RSS cell scroll:100MB missing post-load RSS',
          'RSS cell scroll:100MB missing query peak',
          'RSS cell scroll:100MB missing query delta',
          'RSS cell vendor:1GB missing post-load RSS',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires final RSS matrix rows to carry file sizes matching their buckets', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(
        tmpDir,
        'rss.md',
        finalRssBenchmark()
          .replace('| scroll-1GB | scroll | 1GB | 1GB |', '| scroll-1GB | scroll | 1GB | 100MB |')
          .replace('| vendor-500MB | vendor | 500MB | 500MB |', '| vendor-500MB | vendor | 500MB | n/a |'),
      );
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'rss-benchmark-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'RSS cell scroll:1GB missing file size >= 1GB',
          'RSS cell vendor:500MB missing file size >= 500MB',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects RSS candidate audit output even if it contains a complete marker', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme());
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(
        tmpDir,
        'rss.md',
        [
          '# Trace Processor RSS Matrix Candidate Audit',
          'This audit only checks candidate trace availability. It is not RSS benchmark evidence.',
          'Coverage status: complete',
          'Missing required matrix cells:',
          '- none',
        ].join('\n'),
      );
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'rss-benchmark-final')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          'contains candidate-audit marker',
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requires all ten D1-D10 rows, not just a checked §0 summary', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(tmpDir, 'README.md', completeReadme().replace('- [x] D10 scenario\n', ''));
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', finalAcceptanceEvidence());
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', finalLoadReport());
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', finalRssBenchmark());
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', '# Release Notes\nAll final.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.ready).toBe(false);
      expect(report.checks.find(check => check.id === 'd1-d10-automated-regression')).toMatchObject({
        status: 'blocked',
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports PR closeout blockers separately from measured-evidence blockers', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enterprise-readiness-'));
    try {
      const readmePath = await writeFixture(
        tmpDir,
        'README.md',
        completeReadme()
          .replace('- [x] §19 item 1', '- [ ] 50 online users')
          .replace('- [x] PR gate', '- [ ] PR Gate `npm run verify:pr` 通过'),
      );
      const acceptanceEvidencePath = await writeFixture(tmpDir, 'acceptance.md', '| item | Status | Evidence |\n| load | Open | pending |\n');
      const loadTestReportPath = await writeFixture(tmpDir, 'load.md', 'Status: pending real 50-user run.\n');
      const rssBenchmarkPath = await writeFixture(tmpDir, 'rss.md', 'Coverage status: blocked_missing_required_traces\nMissing required matrix cells:\n- scroll:100MB\n');
      const releaseNotesPath = await writeFixture(tmpDir, 'release.md', 'Status: draft, pending final RSS matrix and 50-user load-test evidence.\n');

      const report = buildEnterpriseReadinessAuditReport({
        readmePath,
        acceptanceEvidencePath,
        loadTestReportPath,
        rssBenchmarkPath,
        releaseNotesPath,
        requireReady: true,
      });

      expect(report.checks.find(check => check.id === 'readme-section-0-todos')).toMatchObject({
        status: 'blocked',
      });
      expect(report.checks.find(check => check.id === 'pr-closeout-checklist')).toMatchObject({
        status: 'blocked',
        evidence: expect.arrayContaining([
          expect.stringContaining('PR Gate `npm run verify:pr` 通过'),
        ]),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
