// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';
import {afterEach, describe, expect, it} from '@jest/globals';
import {
  HEAP_PATH_CLUSTER_SCHEMA_VERSION,
  HEAP_PATH_NORMALIZATION_VERSION,
} from '../../../types/heapPathCluster';
import {renderBatchTraceHtmlReport, writeBatchTraceArtifacts} from '../batchTraceReportService';
import {
  BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
  BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
  BATCH_TRACE_RUN_SCHEMA_VERSION,
  type BatchTraceRunV1,
} from '../batchTraceTypes';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

function run(): BatchTraceRunV1 {
  return {
    schemaVersion: BATCH_TRACE_RUN_SCHEMA_VERSION,
    id: 'batch-<unsafe>',
    createdAt: 1,
    status: 'partial',
    input: {
      skillId: 'android_heap_dominator_path_extract',
      params: {},
      maxConcurrency: 2,
      traceLimit: 100,
      traceInputs: [{ordinal: 0, source: 'workspace_trace', traceId: 'trace-a'}],
    },
    perTrace: [{
      ordinal: 0,
      input: {ordinal: 0, source: 'workspace_trace', traceId: 'trace-a'},
      traceId: 'trace-a',
      status: 'completed',
      metrics: [],
      evidenceEnvelopeIds: [],
      diagnostics: [],
      executionTimeMs: 5,
    }],
    aggregate: {metrics: [], limitations: []},
    domainAnalysis: {
      schemaVersion: BATCH_TRACE_DOMAIN_ANALYSIS_SCHEMA_VERSION,
      operation: 'heap_path_cluster',
      evidence: {
        schemaVersion: BATCH_TRACE_DOMAIN_EVIDENCE_SCHEMA_VERSION,
        skillId: 'android_heap_dominator_path_extract',
        sourceStepId: 'dominator_paths',
        requiredColumns: ['path'],
        rowCount: 4,
        rejectedRowCount: 1,
        truncatedRowCount: 2,
        rows: [],
      },
      result: {
        schemaVersion: HEAP_PATH_CLUSTER_SCHEMA_VERSION,
        normalizationVersion: HEAP_PATH_NORMALIZATION_VERSION,
        status: 'partial',
        seedHash: 'abc123',
        selectedK: 2,
        silhouetteScore: 0.875,
        collapseTolerancePct: 5,
        input: {traceCount: 4, sampleCount: 4, rowCount: 4, rejectedRowCount: 1},
        clusters: [{
          id: 'heap-cluster-1',
          representativePath: 'Root -> <script>alert(1)</script>',
          classNames: ['LeakedActivity'],
          rootTypes: ['ROOT_JNI_GLOBAL'],
          traceCount: 3,
          sampleCount: 3,
          rowCount: 3,
          traceSupportPct: 75,
          meanRetainedBytes: 4096,
          p95RetainedBytes: 8192,
          collapsedPaths: ['Root -> Child <unsafe>'],
          evidenceRefIds: ['batch-row-1'],
        }],
        failures: [{traceOrdinal: 9, traceId: 'trace-b', reason: '<query failed>'}],
        limitations: ['batch_source_rows_truncated:2', '<limited>'],
      },
    },
  };
}

describe('batch trace report domain analysis', () => {
  it('renders escaped heap cluster status, quality, evidence, limitations, and failures', () => {
    const html = renderBatchTraceHtmlReport(run(), 'en');

    expect(html).toContain('Heap Path Cluster Analysis');
    expect(html).toContain('Silhouette');
    expect(html).toContain('0.875');
    expect(html).toContain('Root -&gt; &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('batch_source_rows_truncated:2');
    expect(html).toContain('&lt;query failed&gt;');
    expect(html).toContain('Rejected rows:</strong> 1');
  });

  it('renders report chrome in the selected language without translating stable data', () => {
    const html = renderBatchTraceHtmlReport(run(), 'zh-CN');

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('批量轨迹分析');
    expect(html).toContain('堆内存路径聚类分析');
    expect(html).toContain('部分完成');
    expect(html).toContain('轨迹序号 9');
    expect(html).toContain('data-status="partial"');
    expect(html).toContain('android_heap_dominator_path_extract');
  });

  it('preserves the typed domain envelope in JSON artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-batch-report-'));
    temporaryDirectories.push(directory);

    const written = writeBatchTraceArtifacts({run: run(), directory});
    const parsed = JSON.parse(fs.readFileSync(written.report?.jsonPath ?? '', 'utf-8')) as BatchTraceRunV1;

    expect(parsed.domainAnalysis).toEqual(run().domainAnalysis);
  });
  it('retains precise values, authored units, and per-trace evidence references', () => {
    const data = run();
    data.aggregate!.metrics = [{key: 'test', label: 'Observed', unit: 'ms', count: 1, missingCount: 0,
      min: 0.000123456, p50: 0.000123456, mean: 0.000123456, outlierOrdinals: []}];
    data.perTrace[0].evidenceEnvelopeIds = ['BATCH_EVIDENCE_ANCHOR'];
    const html = renderBatchTraceHtmlReport(data, 'en');
    expect(html).toContain('0.000123456'); expect(html).toContain('<th>Unit</th>');
    expect(html).toContain('<td>ms</td>'); expect(html).toContain('BATCH_EVIDENCE_ANCHOR');
    expect(html).toContain('name="viewport"'); expect(html).toContain('smartperfetto-report-document-v1');
  });

});
