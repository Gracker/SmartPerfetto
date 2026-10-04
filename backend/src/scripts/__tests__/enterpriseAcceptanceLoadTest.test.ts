// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import {
  buildLoadTestReport,
  buildLoadTestPreflightReport,
  buildMarkdownLoadTestReport,
  buildMarkdownLoadTestPreflightReport,
  evaluateAcceptance,
  extractTraceIdsFromTraceListBody,
  parseLoadTestArgs,
  percentile,
  runEnterpriseAcceptanceLoadTest,
  summarizeLoadTest,
  type AnalysisRunRecord,
  type AnalysisStatusSnapshot,
  type EnterpriseLoadTestOptions,
  type HttpSample,
  type RuntimeSample,
} from '../enterpriseAcceptanceLoadTest';

function options(overrides: Partial<EnterpriseLoadTestOptions> = {}): EnterpriseLoadTestOptions {
  return {
    baseUrl: 'http://localhost:3000',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    preflightOnly: false,
    confirmRealRun: false,
    onlineUsers: 50,
    targetRunningRuns: 10,
    targetPendingRuns: 5,
    maxErrorRate: 0.01,
    durationMs: 60_000,
    pollIntervalMs: 1000,
    traceIds: ['trace-a'],
    query: 'load test',
    outputPath: '/tmp/load-test.json',
    ...overrides,
  };
}

function sample(operation: string, durationMs: number, ok = true, userId = 'user-a'): HttpSample {
  return {
    operation,
    userId,
    status: ok ? 200 : 500,
    ok,
    durationMs,
    timestamp: '2026-05-09T00:00:00.000Z',
    ...(operation.startsWith('trace_list') && ok ? { traceCount: 1000 } : {}),
  };
}

function runtimeDashboardSample(): HttpSample {
  return sample('runtime_dashboard', 5, true, 'load-runtime-admin');
}

function analyzeStartSample(): HttpSample {
  return sample('analyze_start', 30, true, 'load-user-001');
}

function onlineUserSamples(count: number): HttpSample[] {
  return Array.from({ length: count }, (_unused, index) =>
    sample('trace_list', 10, true, `online-user-${String(index + 1).padStart(3, '0')}`)
  );
}

function visibleTraceIds(count: number, requiredIds: string[] = []): string[] {
  const ids = [...requiredIds];
  for (let index = ids.length; index < count; index++) {
    ids.push(`trace-${String(index + 1).padStart(4, '0')}`);
  }
  return ids;
}

function passingHttpSamples(onlineUsers = 50): HttpSample[] {
  return [
    runtimeDashboardSample(),
    analyzeStartSample(),
    ...onlineUserSamples(onlineUsers),
  ];
}

function runtimeSample(overrides: Partial<RuntimeSample> = {}): RuntimeSample {
  return {
    timestamp: '2026-05-09T00:00:01.000Z',
    queueLength: 1,
    workerRssBytes: 256,
    leaseRssBytes: null,
    ...overrides,
  };
}

function passingRuntimeSamples(): RuntimeSample[] {
  return [
    runtimeSample({ timestamp: '2026-05-09T00:00:00.000Z' }),
    runtimeSample({ timestamp: '2026-05-09T00:00:01.000Z' }),
  ];
}

function analysisRun(index: number, overrides: Partial<AnalysisRunRecord> = {}): AnalysisRunRecord {
  const ordinal = index + 1;
  return {
    userId: `load-user-${String(ordinal).padStart(3, '0')}`,
    traceId: 'trace-a',
    sessionId: `session-${ordinal}`,
    runId: `run-${ordinal}`,
    startStatus: 200,
    startOk: true,
    lastStatus: 'running',
    ...overrides,
  };
}

/** The first run has completed, enough for the daily projection over the one-minute window. */
function analysisRuns(count: number, overrides: Partial<AnalysisRunRecord> = {}): AnalysisRunRecord[] {
  return Array.from({ length: count }, (_unused, index) =>
    analysisRun(index, { ...(index === 0 ? { lastStatus: 'completed' as const } : {}), ...overrides }));
}

describe('enterprise acceptance load test helpers', () => {
  it('parses repeatable trace ids and report paths', () => {
    const cwd = '/tmp/smartperfetto';
    const parsed = parseLoadTestArgs([
      '--base-url', 'http://127.0.0.1:3000/',
      '--tenant-id', 'tenant-z',
      '--workspace-id', 'workspace-z',
      '--users', '55',
      '--target-running', '12',
      '--target-pending', '7',
      '--max-error-rate', '0.02',
      '--duration-ms', '120000',
      '--poll-interval-ms', '2000',
      '--trace-id', 'trace-a',
      '--trace-id', 'trace-b',
      '--query', '验收压测',
      '--output', 'out/load.json',
      '--markdown', 'out/load.md',
      '--preflight-only',
      '--confirm-real-run',
    ], cwd);

    expect(parsed).toEqual(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:3000',
      tenantId: 'tenant-z',
      workspaceId: 'workspace-z',
      preflightOnly: true,
      confirmRealRun: true,
      onlineUsers: 55,
      targetRunningRuns: 12,
      targetPendingRuns: 7,
      maxErrorRate: 0.02,
      durationMs: 120000,
      pollIntervalMs: 2000,
      traceIds: ['trace-a', 'trace-b'],
      query: '验收压测',
      outputPath: path.resolve(cwd, 'out/load.json'),
      markdownPath: path.resolve(cwd, 'out/load.md'),
    }));
  });

  it('requires an explicit confirmation flag before starting a real load test', async () => {
    await expect(runEnterpriseAcceptanceLoadTest(options()))
      .rejects
      .toThrow('Refusing to start real load test without --confirm-real-run');
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([100, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([100, 10, 30, 20], 0.95)).toBe(100);
  });

  it('extracts trace ids from workspace trace list responses', () => {
    expect(extractTraceIdsFromTraceListBody({
      traces: [
        { id: 'trace-a' },
        { id: 'trace-b' },
        { name: 'missing id' },
      ],
    })).toEqual(['trace-a', 'trace-b']);
    expect(extractTraceIdsFromTraceListBody({ traces: 'not-array' })).toBeNull();
  });

  it('builds a ready preflight report without treating it as load evidence', () => {
    const opts = options({
      traceIds: ['trace-a', 'trace-b'],
      targetRunningRuns: 10,
      targetPendingRuns: 5,
    });
    const report = buildLoadTestPreflightReport({
      options: opts,
      traceList: {
        status: 200,
        ok: true,
        traceIds: visibleTraceIds(1000, ['trace-a', 'trace-b']),
      },
      runtimeSamples: [
        runtimeSample({
          queueLength: 0,
          workerRssBytes: 0,
          leaseRssBytes: 0,
        }),
      ],
      httpSamples: [
        runtimeDashboardSample(),
        sample('trace_list_preflight', 12, true, 'load-preflight-user'),
      ],
    });

    expect(report.ready).toBe(true);
    expect(report.checks.every(check => check.status === 'passed')).toBe(true);
    const markdown = buildMarkdownLoadTestPreflightReport(report);
    expect(markdown).toContain('Preflight status: ready');
    expect(markdown).toContain('not README §0.8 acceptance evidence');
    expect(markdown).toContain('| trace-metadata-scale | passed | visibleTraceMetadata=1000<br>minimum=1000 |');
    expect(markdown).toContain('| trace-id-access | passed | trace-a<br>trace-b |');
  });

  it('blocks preflight when runtime counters or configured traces are missing', () => {
    const report = buildLoadTestPreflightReport({
      options: options({
        onlineUsers: 20,
        targetRunningRuns: 20,
        targetPendingRuns: 0,
        traceIds: ['trace-missing'],
      }),
      traceList: {
        status: 200,
        ok: true,
        traceIds: ['trace-a'],
      },
      runtimeSamples: [
        runtimeSample({
          queueLength: null,
          workerRssBytes: null,
          leaseRssBytes: null,
        }),
      ],
      httpSamples: [
        runtimeDashboardSample(),
        sample('trace_list_preflight', 12, true, 'load-preflight-user'),
      ],
    });

    expect(report.ready).toBe(false);
    expect(report.checks.filter(check => check.status === 'blocked').map(check => check.id)).toEqual([
      'load-shape-config',
      'trace-metadata-scale',
      'trace-id-access',
      'runtime-rss-and-queue-counters',
    ]);
  });

  it('summarizes latency, error rate, run counts, queue, RSS, and the daily run projection', () => {
    const statusSnapshots: AnalysisStatusSnapshot[] = [
      {
        timestamp: '2026-05-09T00:00:01.000Z',
        counts: {
          queued: 2,
          pending: 3,
          running: 8,
          completed: 0,
          failed: 0,
          error: 0,
          quota_exceeded: 0,
          unknown: 0,
        },
      },
      {
        timestamp: '2026-05-09T00:00:02.000Z',
        counts: {
          queued: 1,
          pending: 2,
          running: 10,
          completed: 2,
          failed: 0,
          error: 0,
          quota_exceeded: 0,
          unknown: 0,
        },
      },
    ];
    const runtimeSamples: RuntimeSample[] = [
      {
        timestamp: '2026-05-09T00:00:01.000Z',
        queueLength: 4,
        workerRssBytes: 100,
        leaseRssBytes: 200,
      },
      {
        timestamp: '2026-05-09T00:00:02.000Z',
        queueLength: 9,
        workerRssBytes: 300,
        leaseRssBytes: 250,
      },
    ];

    const summary = summarizeLoadTest({
      options: options(),
      httpSamples: [
        sample('runtime_dashboard', 80, false),
        sample('trace_list', 10),
        sample('trace_list', 20),
        sample('analyze_start', 100),
        sample('analysis_status', 50),
      ],
      runs: [
        analysisRun(0, { userId: 'user-a', lastStatus: 'completed' }),
        { userId: 'user-b', traceId: 'trace-a', startStatus: 500, startOk: false, lastStatus: 'error' },
      ],
      statusSnapshots,
      runtimeSamples,
    });

    expect(summary.errorRate).toBe(0.2);
    expect(summary.scale.visibleTraceMetadataCount).toBe(1000);
    // One completed run in a one-minute window.
    expect(summary.scale.estimatedDailyAnalysisRuns).toBe(1440);
    expect(summary.onlineUsers).toEqual({
      configured: 50,
      observed: 0,
    });
    expect(summary.latency.overall.p50Ms).toBe(50);
    expect(summary.latency.overall.p95Ms).toBe(100);
    expect(summary.latency.byOperation.trace_list.p95Ms).toBe(20);
    expect(summary.analysis).toEqual(expect.objectContaining({
      started: 1,
      startFailures: 1,
      missingStartIdentifiers: 0,
      maxRunning: 10,
      maxPending: 5,
      runningInRangeSnapshots: 2,
      pendingSnapshots: 2,
    }));
    expect(summary.runtime).toEqual(expect.objectContaining({
      maxQueueLength: 9,
      maxWorkerRssBytes: 300,
      maxLeaseRssBytes: 250,
      preRunBaselineSampled: false,
    }));
    expect(JSON.stringify(summary)).not.toMatch(/llm/i);
  });

  it('requires direct load metrics before acceptance can pass', () => {
    const opts = options({ onlineUsers: 49 });
    const traceSampleWithoutCount = sample('trace_list', 10);
    delete traceSampleWithoutCount.traceCount;
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: [traceSampleWithoutCount],
      runs: [],
      statusSnapshots: [],
      runtimeSamples: [],
    });

    expect(evaluateAcceptance(opts, summary, [])).toEqual({
      passed: false,
      missing: expect.arrayContaining([
        'onlineUsers < 50',
        'observed online users < 50',
        'visible trace metadata < 1000',
        'started analysis runs < requested target',
        'observed max running runs < 5',
        'no queued/pending runs observed',
        'missing worker/lease RSS samples',
        'missing pre-run runtime baseline sample',
        'missing queue length samples',
        'estimated daily analysis runs < 200',
        'runtime dashboard was not sampled',
      ]),
    });
  });

  it('requires successful samples from 50 distinct online users', () => {
    const opts = options({ onlineUsers: 50, maxErrorRate: 0.05 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: [
        runtimeDashboardSample(),
        analyzeStartSample(),
        ...onlineUserSamples(49),
        sample('trace_list', 10, false, 'online-user-050'),
      ],
      runs: analysisRuns(15),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.onlineUsers.observed).toBe(49);
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['observed online users < 50'],
    });
  });

  it('requires running and pending state to be stable across multiple samples', () => {
    const opts = options({ onlineUsers: 50 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: analysisRuns(15),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.analysis).toEqual(expect.objectContaining({
      maxRunning: 5,
      maxPending: 2,
      runningInRangeSnapshots: 1,
      pendingSnapshots: 1,
    }));
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: [
        'running runs were not stable for at least 2 samples',
        'queued/pending runs were not stable for at least 2 samples',
      ],
    });
  });

  it('requires all requested analysis runs to start', () => {
    const opts = options({ onlineUsers: 50 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: [
        ...analysisRuns(14),
        {
          userId: 'load-user-015',
          traceId: 'trace-a',
          startStatus: 500,
          startOk: false,
          lastStatus: 'error' as const,
        },
      ],
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: [
        'started analysis runs < requested target',
        'analysis start failures observed',
        'terminal analysis failures observed',
      ],
    });
  });

  it('requires started analysis runs to include session and run ids', () => {
    const opts = options({ onlineUsers: 50 });
    const missingIdRun = analysisRun(14);
    delete missingIdRun.sessionId;
    delete missingIdRun.runId;
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: [
        ...analysisRuns(14),
        missingIdRun,
      ],
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.analysis.missingStartIdentifiers).toBe(1);
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['started analysis runs missing session or run id'],
    });
  });

  it('requires runtime baseline before analysis runs start', () => {
    const opts = options({ onlineUsers: 50 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: [
        analyzeStartSample(),
        ...onlineUserSamples(50),
        runtimeDashboardSample(),
      ],
      runs: analysisRuns(15),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.runtime.preRunBaselineSampled).toBe(false);
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['missing pre-run runtime baseline sample'],
    });
  });

  it('rejects terminal failed, error, or quota_exceeded analysis runs', () => {
    const opts = options({ onlineUsers: 50 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: [
        ...analysisRuns(12),
        analysisRun(12, { lastStatus: 'failed' }),
        analysisRun(13, { lastStatus: 'error' }),
        analysisRun(14, { lastStatus: 'quota_exceeded' }),
      ],
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.analysis.terminal).toEqual({
      completed: 1,
      failed: 1,
      error: 1,
      quota_exceeded: 1,
    });
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['terminal analysis failures observed'],
    });
  });

  it('requires HTTP error rate to stay within the configured threshold', () => {
    const opts = options({ onlineUsers: 50, maxErrorRate: 0.01 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: [
        ...passingHttpSamples(50),
        sample('analysis_status', 30, false, 'load-user-001'),
      ],
      runs: analysisRuns(15),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['error rate 1.89% exceeds max 1.00%'],
    });
  });

  it('projects daily scale from runs that completed during the load-test window', () => {
    const opts = options({ onlineUsers: 50 });
    const runtimeSamples = passingRuntimeSamples();
    const summary = summarizeLoadTest({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: analysisRuns(15, { lastStatus: 'running' }),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples,
    });

    expect(summary.scale.estimatedDailyAnalysisRuns).toBe(0);
    expect(evaluateAcceptance(opts, summary, runtimeSamples)).toEqual({
      passed: false,
      missing: ['estimated daily analysis runs < 200'],
    });
  });

  it('renders the required load-test report fields', () => {
    const opts = options();
    const report = buildLoadTestReport({
      options: opts,
      httpSamples: passingHttpSamples(50),
      runs: analysisRuns(15),
      statusSnapshots: [
        {
          timestamp: '2026-05-09T00:00:01.000Z',
          counts: {
            queued: 1,
            pending: 1,
            running: 5,
            completed: 0,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
        {
          timestamp: '2026-05-09T00:00:02.000Z',
          counts: {
            queued: 0,
            pending: 1,
            running: 5,
            completed: 1,
            failed: 0,
            error: 0,
            quota_exceeded: 0,
            unknown: 0,
          },
        },
      ],
      runtimeSamples: [
        runtimeSample({
          timestamp: '2026-05-09T00:00:00.000Z',
          queueLength: 1,
          workerRssBytes: 128 * 1024 * 1024,
          leaseRssBytes: 64 * 1024 * 1024,
        }),
        runtimeSample({
          timestamp: '2026-05-09T00:00:01.000Z',
          queueLength: 3,
          workerRssBytes: 256 * 1024 * 1024,
          leaseRssBytes: 128 * 1024 * 1024,
        }),
      ],
    });

    const markdown = buildMarkdownLoadTestReport(report);
    expect(markdown).toContain('Acceptance status: passed');
    expect(markdown).toContain('| Online users | 50 |');
    expect(markdown).toContain('| Observed online users | 50 |');
    expect(markdown).toContain('| Visible trace metadata | 1000 |');
    expect(markdown).toContain('| Max error rate | 1.00% |');
    expect(markdown).toContain('| Overall p50 | 10ms |');
    expect(markdown).toContain('| Started runs missing ids | 0 |');
    expect(markdown).toContain('| Running-in-range samples | 2 |');
    expect(markdown).toContain('| Queued/pending samples | 2 |');
    expect(markdown).toContain('| Pre-run runtime baseline | yes |');
    expect(markdown).toContain('| Max worker RSS | 256.0 MiB |');
    expect(markdown).toContain('| Completed analysis runs | 1 |');
    expect(markdown).toContain('| Estimated daily analysis runs | 1440 |');
    expect(markdown).toContain('the runtime keeps no global model-call or cost counter');
    expect(markdown).toContain('## Online User Samples');
    expect(markdown).toContain('| online-user-050 | 1 | 0 | 1000 |');
    expect(markdown).toContain('## Status Snapshots');
    expect(markdown).toContain('| 2026-05-09T00:00:01.000Z | 1 | 1 | 5 | 0 | 0 | 0 | 0 | 0 |');
    expect(markdown).toContain('## Runtime Samples');
    expect(markdown).toContain('| 2026-05-09T00:00:01.000Z | 3 | 256.0 MiB | 128.0 MiB |');
    expect(markdown).toContain('## Analysis Runs');
    expect(markdown).toContain('| load-user-015 | trace-a | session-15 | run-15 | 200 | running |  |');
  });
});
