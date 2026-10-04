// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

type AnalysisStatus = 'queued' | 'pending' | 'running' | 'completed' | 'failed' | 'error' | 'quota_exceeded' | 'unknown';

export interface EnterpriseLoadTestOptions {
  baseUrl: string;
  tenantId: string;
  workspaceId: string;
  apiKey?: string;
  preflightOnly: boolean;
  confirmRealRun: boolean;
  onlineUsers: number;
  targetRunningRuns: number;
  targetPendingRuns: number;
  maxErrorRate: number;
  durationMs: number;
  pollIntervalMs: number;
  traceIds: string[];
  query: string;
  outputPath: string;
  markdownPath?: string;
}

export interface HttpSample {
  operation: string;
  userId: string;
  status: number;
  ok: boolean;
  durationMs: number;
  timestamp: string;
  traceCount?: number;
  error?: string;
}

export interface RuntimeSample {
  timestamp: string;
  queueLength: number | null;
  workerRssBytes: number | null;
  leaseRssBytes: number | null;
}

export interface AnalysisRunRecord {
  userId: string;
  traceId: string;
  sessionId?: string;
  runId?: string;
  startStatus: number;
  startOk: boolean;
  lastStatus: AnalysisStatus;
  error?: string;
}

export interface AnalysisStatusSnapshot {
  timestamp: string;
  counts: Record<AnalysisStatus, number>;
}

export interface LatencySummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface EnterpriseLoadTestSummary {
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  scale: {
    visibleTraceMetadataCount: number | null;
    /**
     * Completed analysis runs per day at the measured rate. Each run makes at
     * least one model call, so this is a lower bound on daily model calls; the
     * runtime keeps no global model-call or cost counter to read instead.
     */
    estimatedDailyAnalysisRuns: number | null;
  };
  onlineUsers: {
    configured: number;
    observed: number;
  };
  latency: {
    overall: LatencySummary;
    byOperation: Record<string, LatencySummary>;
  };
  analysis: {
    started: number;
    startFailures: number;
    missingStartIdentifiers: number;
    maxRunning: number;
    maxPending: number;
    runningInRangeSnapshots: number;
    pendingSnapshots: number;
    terminal: Record<string, number>;
  };
  runtime: {
    preRunBaselineSampled: boolean;
    maxQueueLength: number | null;
    maxWorkerRssBytes: number | null;
    maxLeaseRssBytes: number | null;
  };
}

export interface EnterpriseLoadTestReport {
  generatedAt: string;
  host: {
    platform: string;
    arch: string;
    node: string;
    cpuCount: number;
  };
  target: {
    baseUrl: string;
    tenantId: string;
    workspaceId: string;
  };
  config: {
    onlineUsers: number;
    targetRunningRuns: number;
    targetPendingRuns: number;
    maxErrorRate: number;
    durationMs: number;
    pollIntervalMs: number;
    traceCount: number;
  };
  summary: EnterpriseLoadTestSummary;
  acceptance: {
    passed: boolean;
    missing: string[];
  };
  runs: AnalysisRunRecord[];
  statusSnapshots: AnalysisStatusSnapshot[];
  runtimeSamples: RuntimeSample[];
  httpSamples: HttpSample[];
}

export interface EnterpriseLoadTestPreflightCheck {
  id: string;
  status: 'passed' | 'blocked';
  message: string;
  evidence: string[];
}

export interface EnterpriseLoadTestTraceListProbe {
  status: number;
  ok: boolean;
  traceIds: string[] | null;
  error?: string;
}

export interface EnterpriseLoadTestPreflightReport {
  generatedAt: string;
  target: {
    baseUrl: string;
    tenantId: string;
    workspaceId: string;
  };
  config: {
    onlineUsers: number;
    targetRunningRuns: number;
    targetPendingRuns: number;
    maxErrorRate: number;
    durationMs: number;
    pollIntervalMs: number;
    traceIds: string[];
  };
  ready: boolean;
  checks: EnterpriseLoadTestPreflightCheck[];
  runtimeSamples: RuntimeSample[];
  httpSamples: HttpSample[];
}

interface RequestResult<T = any> {
  status: number;
  ok: boolean;
  body: T | null;
  sample: HttpSample;
}

const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_ERROR_RATE = 0.01;
export const MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA = 1000;
export const MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Why the report has no model cost or call totals: there is nothing to sample. */
const LLM_COUNTER_NOTE = 'Model cost and model-call totals are not measured: the runtime keeps no global '
  + 'model-call or cost counter, so the daily projection counts completed analysis runs (each makes at least '
  + 'one model call).';
const TERMINAL_STATUSES = new Set<AnalysisStatus>(['completed', 'failed', 'error', 'quota_exceeded']);

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/enterpriseAcceptanceLoadTest.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --base-url <url>              Backend base URL. Default: http://localhost:3000.');
  console.log('  --tenant-id <id>              Tenant id. Default: tenant-a.');
  console.log('  --workspace-id <id>           Workspace id. Default: workspace-a.');
  console.log('  --api-key <key>               Optional SMARTPERFETTO_API_KEY bearer token.');
  console.log('  --users <n>                   Online user count. Default: 50.');
  console.log('  --target-running <n>          Target running analysis run count. Default: 15.');
  console.log('  --target-pending <n>          Extra pending run count. Default: 10.');
  console.log('  --max-error-rate <0-1>        Maximum accepted HTTP error rate. Default: 0.01.');
  console.log('  --duration-ms <ms>            Test duration. Default: 300000.');
  console.log('  --poll-interval-ms <ms>       Poll interval. Default: 1000.');
  console.log('  --trace-id <id>               Existing trace id. Repeatable; required.');
  console.log('  --query <text>                Analysis query. Default: 企业验收压测：快速检查 trace.');
  console.log('  --output <path>               JSON report path.');
  console.log('  --markdown <path>             Optional Markdown report path.');
  console.log('  --preflight-only              Check load-test prerequisites without starting runs.');
  console.log('  --confirm-real-run            Required for the real load test; not needed for --preflight-only.');
  console.log('  --help                        Show this help.');
}

function positiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function boundedRate(value: string, label: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return parsed;
}

function resolveOutputPath(cwd: string, value: string | undefined, fallbackName: string): string {
  return path.resolve(cwd, value ?? path.join('test-output', fallbackName));
}

export function parseLoadTestArgs(argv: string[], cwd = process.cwd()): EnterpriseLoadTestOptions {
  const options: EnterpriseLoadTestOptions = {
    baseUrl: 'http://localhost:3000',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    preflightOnly: false,
    confirmRealRun: false,
    onlineUsers: 50,
    targetRunningRuns: 15,
    targetPendingRuns: 10,
    maxErrorRate: DEFAULT_MAX_ERROR_RATE,
    durationMs: DEFAULT_DURATION_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    traceIds: [],
    query: '企业验收压测：快速检查 trace 状态并返回简短结论',
    outputPath: resolveOutputPath(cwd, undefined, 'enterprise-acceptance-load-test.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--base-url':
        options.baseUrl = next().replace(/\/+$/, '');
        break;
      case '--tenant-id':
        options.tenantId = next();
        break;
      case '--workspace-id':
        options.workspaceId = next();
        break;
      case '--api-key':
        options.apiKey = next();
        break;
      case '--users':
        options.onlineUsers = positiveInt(next(), '--users');
        break;
      case '--target-running':
        options.targetRunningRuns = positiveInt(next(), '--target-running');
        break;
      case '--target-pending':
        options.targetPendingRuns = positiveInt(next(), '--target-pending');
        break;
      case '--max-error-rate':
        options.maxErrorRate = boundedRate(next(), '--max-error-rate');
        break;
      case '--duration-ms':
        options.durationMs = positiveInt(next(), '--duration-ms');
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = positiveInt(next(), '--poll-interval-ms');
        break;
      case '--trace-id':
        options.traceIds.push(next());
        break;
      case '--query':
        options.query = next();
        break;
      case '--output':
        options.outputPath = resolveOutputPath(cwd, next(), 'enterprise-acceptance-load-test.json');
        break;
      case '--markdown':
        options.markdownPath = resolveOutputPath(cwd, next(), 'enterprise-acceptance-load-test.md');
        break;
      case '--preflight-only':
        options.preflightOnly = true;
        break;
      case '--confirm-real-run':
        options.confirmRealRun = true;
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function latencySummary(samples: HttpSample[]): LatencySummary {
  const values = samples.map(sample => sample.durationMs);
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : null,
  };
}

function statusFromBody(body: any): AnalysisStatus {
  const status = typeof body?.status === 'string' ? body.status : 'unknown';
  switch (status) {
    case 'queued':
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'error':
    case 'quota_exceeded':
      return status;
    default:
      return 'unknown';
  }
}

function maxNullable(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length > 0 ? Math.max(...present) : null;
}

function estimateDailyAnalysisRuns(completedRuns: number, durationMs: number): number | null {
  if (durationMs <= 0) return null;
  return (completedRuns / durationMs) * DAY_MS;
}

function hasPreRunRuntimeBaseline(samples: HttpSample[]): boolean {
  const firstAnalyzeStartIndex = samples.findIndex(sample => sample.operation === 'analyze_start');
  const firstRuntimeDashboardIndex = samples.findIndex(sample =>
    sample.operation === 'runtime_dashboard' && sample.ok
  );
  return firstAnalyzeStartIndex >= 0
    && firstRuntimeDashboardIndex >= 0
    && firstRuntimeDashboardIndex < firstAnalyzeStartIndex;
}

export function summarizeLoadTest(input: {
  options: EnterpriseLoadTestOptions;
  httpSamples: HttpSample[];
  runs: AnalysisRunRecord[];
  statusSnapshots: AnalysisStatusSnapshot[];
  runtimeSamples: RuntimeSample[];
}): EnterpriseLoadTestSummary {
  const byOperation: Record<string, LatencySummary> = {};
  for (const operation of Array.from(new Set(input.httpSamples.map(sample => sample.operation))).sort()) {
    byOperation[operation] = latencySummary(input.httpSamples.filter(sample => sample.operation === operation));
  }
  const terminal: Record<string, number> = {};
  for (const run of input.runs) {
    if (TERMINAL_STATUSES.has(run.lastStatus)) {
      terminal[run.lastStatus] = (terminal[run.lastStatus] ?? 0) + 1;
    }
  }
  const maxRunning = Math.max(0, ...input.statusSnapshots.map(snapshot => snapshot.counts.running ?? 0));
  const maxPending = Math.max(0, ...input.statusSnapshots.map(snapshot =>
    (snapshot.counts.pending ?? 0) + (snapshot.counts.queued ?? 0)
  ));
  const runningInRangeSnapshots = input.statusSnapshots.filter((snapshot) => {
    const running = snapshot.counts.running ?? 0;
    return running >= 5 && running <= 15;
  }).length;
  const pendingSnapshots = input.statusSnapshots.filter(snapshot =>
    ((snapshot.counts.pending ?? 0) + (snapshot.counts.queued ?? 0)) > 0
  ).length;
  const failedRequests = input.httpSamples.filter(sample => !sample.ok).length;
  const observedOnlineUsers = new Set(
    input.httpSamples
      .filter(sample => sample.ok && sample.operation === 'trace_list' && sample.userId.startsWith('online-user-'))
      .map(sample => sample.userId),
  ).size;
  const visibleTraceMetadataCount = maxNullable(input.httpSamples
    .filter(sample => sample.ok && sample.operation === 'trace_list')
    .map(sample => sample.traceCount));
  return {
    totalRequests: input.httpSamples.length,
    failedRequests,
    errorRate: input.httpSamples.length > 0 ? failedRequests / input.httpSamples.length : 0,
    scale: {
      visibleTraceMetadataCount,
      estimatedDailyAnalysisRuns: estimateDailyAnalysisRuns(terminal.completed ?? 0, input.options.durationMs),
    },
    onlineUsers: {
      configured: input.options.onlineUsers,
      observed: observedOnlineUsers,
    },
    latency: {
      overall: latencySummary(input.httpSamples),
      byOperation,
    },
    analysis: {
      started: input.runs.filter(run => run.startOk).length,
      startFailures: input.runs.filter(run => !run.startOk).length,
      missingStartIdentifiers: input.runs.filter(run => run.startOk && (!run.sessionId || !run.runId)).length,
      maxRunning,
      maxPending,
      runningInRangeSnapshots,
      pendingSnapshots,
      terminal,
    },
    runtime: {
      preRunBaselineSampled: hasPreRunRuntimeBaseline(input.httpSamples),
      maxQueueLength: maxNullable(input.runtimeSamples.map(sample => sample.queueLength)),
      maxWorkerRssBytes: maxNullable(input.runtimeSamples.map(sample => sample.workerRssBytes)),
      maxLeaseRssBytes: maxNullable(input.runtimeSamples.map(sample => sample.leaseRssBytes)),
    },
  };
}

export function evaluateAcceptance(
  options: EnterpriseLoadTestOptions,
  summary: EnterpriseLoadTestSummary,
  runtimeSamples: RuntimeSample[],
): EnterpriseLoadTestReport['acceptance'] {
  const missing: string[] = [];
  const requestedRuns = options.targetRunningRuns + options.targetPendingRuns;
  if (options.onlineUsers < 50) missing.push('onlineUsers < 50');
  if (summary.onlineUsers.observed < 50) missing.push('observed online users < 50');
  if (
    summary.scale.visibleTraceMetadataCount === null
    || summary.scale.visibleTraceMetadataCount < MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA
  ) {
    missing.push(`visible trace metadata < ${MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA}`);
  }
  if (summary.errorRate > options.maxErrorRate) {
    missing.push(`error rate ${formatPercent(summary.errorRate)} exceeds max ${formatPercent(options.maxErrorRate)}`);
  }
  if (summary.analysis.started < requestedRuns) missing.push('started analysis runs < requested target');
  if (summary.analysis.startFailures > 0) missing.push('analysis start failures observed');
  if (summary.analysis.missingStartIdentifiers > 0) {
    missing.push('started analysis runs missing session or run id');
  }
  const terminalFailures = (summary.analysis.terminal.failed ?? 0)
    + (summary.analysis.terminal.error ?? 0)
    + (summary.analysis.terminal.quota_exceeded ?? 0);
  if (terminalFailures > 0) missing.push('terminal analysis failures observed');
  if (summary.analysis.maxRunning < 5) missing.push('observed max running runs < 5');
  else if (summary.analysis.maxRunning > 15) missing.push('observed max running runs > 15');
  else if (summary.analysis.runningInRangeSnapshots < 2) {
    missing.push('running runs were not stable for at least 2 samples');
  }
  if (summary.analysis.maxPending < 1) missing.push('no queued/pending runs observed');
  else if (summary.analysis.pendingSnapshots < 2) {
    missing.push('queued/pending runs were not stable for at least 2 samples');
  }
  if (summary.latency.overall.p50Ms === null || summary.latency.overall.p95Ms === null) {
    missing.push('missing p50/p95 latency samples');
  }
  if (summary.runtime.maxWorkerRssBytes === null && summary.runtime.maxLeaseRssBytes === null) {
    missing.push('missing worker/lease RSS samples');
  }
  if (!summary.runtime.preRunBaselineSampled) missing.push('missing pre-run runtime baseline sample');
  if (summary.runtime.maxQueueLength === null) missing.push('missing queue length samples');
  if (
    summary.scale.estimatedDailyAnalysisRuns === null
    || summary.scale.estimatedDailyAnalysisRuns < MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS
  ) {
    missing.push(`estimated daily analysis runs < ${MIN_ACCEPTANCE_ESTIMATED_DAILY_ANALYSIS_RUNS}`);
  }
  if (runtimeSamples.length === 0) missing.push('runtime dashboard was not sampled');
  return {
    passed: missing.length === 0,
    missing,
  };
}

function requestHeaders(options: EnterpriseLoadTestOptions, userId: string, runtimeAdmin = false): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    'X-SmartPerfetto-SSO-User-Id': userId,
    'X-SmartPerfetto-SSO-Email': `${userId}@load.local`,
    'X-SmartPerfetto-SSO-Tenant-Id': options.tenantId,
    'X-SmartPerfetto-SSO-Workspace-Id': options.workspaceId,
    'X-SmartPerfetto-SSO-Roles': runtimeAdmin ? 'workspace_admin' : 'analyst',
    'X-SmartPerfetto-SSO-Scopes': runtimeAdmin
      ? 'runtime:manage,audit:read'
      : 'trace:read,trace:write,agent:run,report:read',
  };
}

async function requestJson<T>(
  options: EnterpriseLoadTestOptions,
  samples: HttpSample[],
  input: {
    operation: string;
    userId: string;
    path: string;
    method?: string;
    body?: unknown;
    runtimeAdmin?: boolean;
  },
): Promise<RequestResult<T>> {
  const started = Date.now();
  try {
    const response = await fetch(`${options.baseUrl}${input.path}`, {
      method: input.method ?? 'GET',
      headers: requestHeaders(options, input.userId, input.runtimeAdmin),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    let body: T | null = null;
    let parseError: string | undefined;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }
    const traceIds = response.ok && !parseError && input.operation.startsWith('trace_list')
      ? extractTraceIdsFromTraceListBody(body)
      : null;
    const sample: HttpSample = {
      operation: input.operation,
      userId: input.userId,
      status: response.status,
      ok: response.ok && !parseError,
      durationMs: Date.now() - started,
      timestamp: new Date().toISOString(),
      ...(traceIds === null ? {} : { traceCount: traceIds.length }),
      ...(response.ok && !parseError ? {} : {
        error: parseError
          ?? (typeof (body as any)?.error === 'string' ? (body as any).error : text.slice(0, 200)),
      }),
    };
    samples.push(sample);
    return { status: response.status, ok: sample.ok, body, sample };
  } catch (error) {
    const sample: HttpSample = {
      operation: input.operation,
      userId: input.userId,
      status: 0,
      ok: false,
      durationMs: Date.now() - started,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    samples.push(sample);
    return { status: 0, ok: false, body: null, sample };
  }
}

function readRuntimeSample(body: any): RuntimeSample {
  return {
    timestamp: new Date().toISOString(),
    queueLength: typeof body?.processors?.queueTotals?.total === 'number'
      ? body.processors.queueTotals.total
      : null,
    workerRssBytes: typeof body?.processors?.rssTotals?.observedProcessorRssBytes === 'number'
      ? body.processors.rssTotals.observedProcessorRssBytes
      : null,
    leaseRssBytes: typeof body?.leases?.totalRssBytes === 'number' ? body.leases.totalRssBytes : null,
  };
}

export function extractTraceIdsFromTraceListBody(body: any): string[] | null {
  if (!Array.isArray(body?.traces)) return null;
  return body.traces
    .map((trace: any) => trace?.id)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
}

function preflightCheck(
  id: string,
  passed: boolean,
  message: string,
  evidence: string[],
): EnterpriseLoadTestPreflightCheck {
  return {
    id,
    status: passed ? 'passed' : 'blocked',
    message,
    evidence,
  };
}

export function buildLoadTestPreflightReport(input: {
  options: EnterpriseLoadTestOptions;
  traceList: EnterpriseLoadTestTraceListProbe;
  runtimeSamples: RuntimeSample[];
  httpSamples: HttpSample[];
}): EnterpriseLoadTestPreflightReport {
  const { options, traceList, runtimeSamples, httpSamples } = input;
  const firstRuntimeSample = runtimeSamples[0];
  const missingTraceIds = traceList.traceIds === null
    ? options.traceIds
    : options.traceIds.filter(traceId => !traceList.traceIds!.includes(traceId));
  const visibleTraceMetadataCount = traceList.traceIds?.length ?? null;
  const checks: EnterpriseLoadTestPreflightCheck[] = [
    preflightCheck(
      'load-shape-config',
      options.onlineUsers >= 50
        && options.targetRunningRuns >= 5
        && options.targetRunningRuns <= 15
        && options.targetPendingRuns > 0,
      'Load shape can exercise README §0.8 online/running/pending acceptance.',
      [
        `users=${options.onlineUsers}`,
        `targetRunning=${options.targetRunningRuns}`,
        `targetPending=${options.targetPendingRuns}`,
        `maxErrorRate=${formatPercent(options.maxErrorRate)}`,
      ],
    ),
    preflightCheck(
      'trace-id-configured',
      options.traceIds.length > 0,
      'At least one existing trace id is configured.',
      options.traceIds.length > 0 ? options.traceIds : ['no --trace-id provided'],
    ),
    preflightCheck(
      'trace-list-access',
      traceList.ok && traceList.traceIds !== null,
      'Trace list endpoint is reachable and returns a parseable trace list.',
      [
        `status=${traceList.status}`,
        traceList.traceIds === null ? 'trace list body did not contain traces[]' : `visibleTraces=${traceList.traceIds.length}`,
        ...(traceList.error ? [`error=${traceList.error}`] : []),
      ],
    ),
    preflightCheck(
      'trace-metadata-scale',
      visibleTraceMetadataCount !== null
        && visibleTraceMetadataCount >= MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA,
      'Target workspace exposes enough trace metadata for README §19 load scale.',
      [
        `visibleTraceMetadata=${visibleTraceMetadataCount ?? 'missing'}`,
        `minimum=${MIN_ACCEPTANCE_VISIBLE_TRACE_METADATA}`,
      ],
    ),
    preflightCheck(
      'trace-id-access',
      options.traceIds.length > 0 && traceList.traceIds !== null && missingTraceIds.length === 0,
      'Configured trace ids are visible in the target workspace.',
      missingTraceIds.length === 0
        ? options.traceIds
        : missingTraceIds.map(traceId => `missing traceId=${traceId}`),
    ),
    preflightCheck(
      'runtime-dashboard-access',
      runtimeSamples.length > 0,
      'Runtime dashboard endpoint is reachable before the load run.',
      runtimeSamples.length > 0
        ? [`samples=${runtimeSamples.length}`, `firstSample=${runtimeSamples[0]!.timestamp}`]
        : ['no successful /api/admin/runtime sample'],
    ),
    preflightCheck(
      'runtime-rss-and-queue-counters',
      !!firstRuntimeSample
        && firstRuntimeSample.queueLength !== null
        && (firstRuntimeSample.workerRssBytes !== null || firstRuntimeSample.leaseRssBytes !== null),
      'Runtime dashboard exposes queue length and worker/lease RSS counters.',
      firstRuntimeSample
        ? [
            `queueLength=${firstRuntimeSample.queueLength ?? 'missing'}`,
            `workerRssBytes=${firstRuntimeSample.workerRssBytes ?? 'missing'}`,
            `leaseRssBytes=${firstRuntimeSample.leaseRssBytes ?? 'missing'}`,
          ]
        : ['no runtime sample'],
    ),
  ];

  return {
    generatedAt: new Date().toISOString(),
    target: {
      baseUrl: options.baseUrl,
      tenantId: options.tenantId,
      workspaceId: options.workspaceId,
    },
    config: {
      onlineUsers: options.onlineUsers,
      targetRunningRuns: options.targetRunningRuns,
      targetPendingRuns: options.targetPendingRuns,
      maxErrorRate: options.maxErrorRate,
      durationMs: options.durationMs,
      pollIntervalMs: options.pollIntervalMs,
      traceIds: options.traceIds,
    },
    ready: checks.every(check => check.status === 'passed'),
    checks,
    runtimeSamples,
    httpSamples,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runOnlineUserLoop(options: EnterpriseLoadTestOptions, samples: HttpSample[], userId: string, endAt: number): Promise<void> {
  while (Date.now() < endAt) {
    await requestJson(options, samples, {
      operation: 'trace_list',
      userId,
      path: `/api/workspaces/${encodeURIComponent(options.workspaceId)}/traces`,
    });
    await sleep(options.pollIntervalMs);
  }
}

async function startAnalysisRun(
  options: EnterpriseLoadTestOptions,
  samples: HttpSample[],
  index: number,
): Promise<AnalysisRunRecord> {
  const userId = `load-user-${String(index + 1).padStart(3, '0')}`;
  const traceId = options.traceIds[index % options.traceIds.length];
  const response = await requestJson<any>(options, samples, {
    operation: 'analyze_start',
    userId,
    path: `/api/workspaces/${encodeURIComponent(options.workspaceId)}/agent/analyze`,
    method: 'POST',
    body: {
      traceId,
      query: `${options.query} #${index + 1}`,
      options: { analysisMode: 'full' },
    },
  });
  return {
    userId,
    traceId,
    sessionId: typeof response.body?.sessionId === 'string' ? response.body.sessionId : undefined,
    runId: typeof response.body?.runId === 'string' ? response.body.runId : undefined,
    startStatus: response.status,
    startOk: response.ok,
    lastStatus: response.ok ? 'pending' : 'error',
    ...(response.sample.error ? { error: response.sample.error } : {}),
  };
}

async function pollAnalysisStatuses(
  options: EnterpriseLoadTestOptions,
  samples: HttpSample[],
  runs: AnalysisRunRecord[],
  snapshots: AnalysisStatusSnapshot[],
  endAt: number,
): Promise<void> {
  while (Date.now() < endAt) {
    const counts: Record<AnalysisStatus, number> = {
      queued: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      error: 0,
      quota_exceeded: 0,
      unknown: 0,
    };
    await Promise.all(runs.map(async (run) => {
      if (!run.sessionId || TERMINAL_STATUSES.has(run.lastStatus)) {
        counts[run.lastStatus] = (counts[run.lastStatus] ?? 0) + 1;
        return;
      }
      const response = await requestJson<any>(options, samples, {
        operation: 'analysis_status',
        userId: run.userId,
        path: `/api/workspaces/${encodeURIComponent(options.workspaceId)}/agent/${encodeURIComponent(run.sessionId)}/status`,
      });
      const status = response.ok ? statusFromBody(response.body) : 'error';
      run.lastStatus = status;
      if (!response.ok && response.sample.error) run.error = response.sample.error;
      counts[status] = (counts[status] ?? 0) + 1;
    }));
    snapshots.push({
      timestamp: new Date().toISOString(),
      counts,
    });
    await sleep(options.pollIntervalMs);
  }
}

async function pollRuntimeDashboard(
  options: EnterpriseLoadTestOptions,
  samples: HttpSample[],
  runtimeSamples: RuntimeSample[],
  endAt: number,
): Promise<void> {
  while (Date.now() < endAt) {
    await sampleRuntimeDashboard(options, samples, runtimeSamples);
    await sleep(options.pollIntervalMs);
  }
}

async function sampleRuntimeDashboard(
  options: EnterpriseLoadTestOptions,
  samples: HttpSample[],
  runtimeSamples: RuntimeSample[],
): Promise<void> {
  const response = await requestJson<any>(options, samples, {
    operation: 'runtime_dashboard',
    userId: 'load-runtime-admin',
    path: '/api/admin/runtime',
    runtimeAdmin: true,
  });
  if (response.ok && response.body) {
    runtimeSamples.push(readRuntimeSample(response.body));
  }
}

export async function runEnterpriseAcceptanceLoadTestPreflight(
  options: EnterpriseLoadTestOptions,
): Promise<EnterpriseLoadTestPreflightReport> {
  const httpSamples: HttpSample[] = [];
  const runtimeSamples: RuntimeSample[] = [];

  await sampleRuntimeDashboard(options, httpSamples, runtimeSamples);
  const traceListResponse = await requestJson<any>(options, httpSamples, {
    operation: 'trace_list_preflight',
    userId: 'load-preflight-user',
    path: `/api/workspaces/${encodeURIComponent(options.workspaceId)}/traces`,
  });
  const traceList: EnterpriseLoadTestTraceListProbe = {
    status: traceListResponse.status,
    ok: traceListResponse.ok,
    traceIds: traceListResponse.ok ? extractTraceIdsFromTraceListBody(traceListResponse.body) : null,
    ...(traceListResponse.sample.error ? { error: traceListResponse.sample.error } : {}),
  };

  return buildLoadTestPreflightReport({
    options,
    traceList,
    runtimeSamples,
    httpSamples,
  });
}

export function buildLoadTestReport(input: {
  options: EnterpriseLoadTestOptions;
  httpSamples: HttpSample[];
  runs: AnalysisRunRecord[];
  statusSnapshots: AnalysisStatusSnapshot[];
  runtimeSamples: RuntimeSample[];
}): EnterpriseLoadTestReport {
  const summary = summarizeLoadTest(input);
  return {
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
    },
    target: {
      baseUrl: input.options.baseUrl,
      tenantId: input.options.tenantId,
      workspaceId: input.options.workspaceId,
    },
    config: {
      onlineUsers: input.options.onlineUsers,
      targetRunningRuns: input.options.targetRunningRuns,
      targetPendingRuns: input.options.targetPendingRuns,
      maxErrorRate: input.options.maxErrorRate,
      durationMs: input.options.durationMs,
      pollIntervalMs: input.options.pollIntervalMs,
      traceCount: input.options.traceIds.length,
    },
    summary,
    acceptance: evaluateAcceptance(input.options, summary, input.runtimeSamples),
    runs: input.runs,
    statusSnapshots: input.statusSnapshots,
    runtimeSamples: input.runtimeSamples,
    httpSamples: input.httpSamples,
  };
}

function formatMs(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(0)}ms`;
}

function formatBytes(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCount(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(0);
}

function buildOnlineUserSampleRows(samples: HttpSample[]): Array<{
  userId: string;
  successfulTraceListSamples: number;
  failedTraceListSamples: number;
  maxVisibleTraceMetadata: number | null;
}> {
  const rows = new Map<string, {
    successfulTraceListSamples: number;
    failedTraceListSamples: number;
    maxVisibleTraceMetadata: number | null;
  }>();

  for (const sample of samples) {
    if (sample.operation !== 'trace_list' || !sample.userId.startsWith('online-user-')) continue;
    const existing = rows.get(sample.userId) ?? {
      successfulTraceListSamples: 0,
      failedTraceListSamples: 0,
      maxVisibleTraceMetadata: null,
    };
    if (sample.ok) {
      existing.successfulTraceListSamples += 1;
      if (typeof sample.traceCount === 'number') {
        existing.maxVisibleTraceMetadata = Math.max(existing.maxVisibleTraceMetadata ?? 0, sample.traceCount);
      }
    } else {
      existing.failedTraceListSamples += 1;
    }
    rows.set(sample.userId, existing);
  }

  return Array.from(rows.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([userId, row]) => ({ userId, ...row }));
}

export function buildMarkdownLoadTestReport(report: EnterpriseLoadTestReport): string {
  const lines: string[] = [];
  const onlineUserRows = buildOnlineUserSampleRows(report.httpSamples);

  lines.push('# Enterprise Acceptance Load Test Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target: ${report.target.baseUrl} / tenant=${report.target.tenantId} / workspace=${report.target.workspaceId}`);
  lines.push('');
  lines.push(`Acceptance status: ${report.acceptance.passed ? 'passed' : 'blocked_or_failed'}`);
  if (!report.acceptance.passed) {
    lines.push('');
    lines.push('Missing acceptance evidence:');
    for (const item of report.acceptance.missing) lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Online users | ${report.config.onlineUsers} |`);
  lines.push(`| Observed online users | ${report.summary.onlineUsers.observed} |`);
  lines.push(`| Target running runs | ${report.config.targetRunningRuns} |`);
  lines.push(`| Target pending runs | ${report.config.targetPendingRuns} |`);
  lines.push(`| Max error rate | ${formatPercent(report.config.maxErrorRate)} |`);
  lines.push(`| Duration | ${formatMs(report.config.durationMs)} |`);
  lines.push(`| Trace count | ${report.config.traceCount} |`);
  lines.push(`| Visible trace metadata | ${report.summary.scale.visibleTraceMetadataCount ?? 'n/a'} |`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| Total HTTP requests | ${report.summary.totalRequests} |`);
  lines.push(`| Failed HTTP requests | ${report.summary.failedRequests} |`);
  lines.push(`| Error rate | ${formatPercent(report.summary.errorRate)} |`);
  lines.push(`| Overall p50 | ${formatMs(report.summary.latency.overall.p50Ms)} |`);
  lines.push(`| Overall p95 | ${formatMs(report.summary.latency.overall.p95Ms)} |`);
  lines.push(`| Started analysis runs | ${report.summary.analysis.started} |`);
  lines.push(`| Start failures | ${report.summary.analysis.startFailures} |`);
  lines.push(`| Started runs missing ids | ${report.summary.analysis.missingStartIdentifiers} |`);
  lines.push(`| Max running runs observed | ${report.summary.analysis.maxRunning} |`);
  lines.push(`| Max queued/pending runs observed | ${report.summary.analysis.maxPending} |`);
  lines.push(`| Running-in-range samples | ${report.summary.analysis.runningInRangeSnapshots} |`);
  lines.push(`| Queued/pending samples | ${report.summary.analysis.pendingSnapshots} |`);
  lines.push(`| Max queue length | ${report.summary.runtime.maxQueueLength ?? 'n/a'} |`);
  lines.push(`| Pre-run runtime baseline | ${report.summary.runtime.preRunBaselineSampled ? 'yes' : 'no'} |`);
  lines.push(`| Max worker RSS | ${formatBytes(report.summary.runtime.maxWorkerRssBytes)} |`);
  lines.push(`| Max lease RSS | ${formatBytes(report.summary.runtime.maxLeaseRssBytes)} |`);
  lines.push(`| Completed analysis runs | ${report.summary.analysis.terminal.completed ?? 0} |`);
  lines.push(`| Estimated daily analysis runs | ${formatCount(report.summary.scale.estimatedDailyAnalysisRuns)} |`);
  lines.push('');
  lines.push(LLM_COUNTER_NOTE);
  lines.push('');
  lines.push('## Latency By Operation');
  lines.push('');
  lines.push('| Operation | Count | p50 | p95 | Max |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [operation, summary] of Object.entries(report.summary.latency.byOperation)) {
    lines.push(`| ${operation} | ${summary.count} | ${formatMs(summary.p50Ms)} | ${formatMs(summary.p95Ms)} | ${formatMs(summary.maxMs)} |`);
  }
  lines.push('');
  lines.push('## Online User Samples');
  lines.push('');
  lines.push('| User | Successful trace_list samples | Failed trace_list samples | Max visible trace metadata |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const row of onlineUserRows) {
    lines.push(`| ${row.userId} | ${row.successfulTraceListSamples} | ${row.failedTraceListSamples} | ${row.maxVisibleTraceMetadata ?? 'n/a'} |`);
  }
  lines.push('');
  lines.push('## Status Snapshots');
  lines.push('');
  lines.push('| Timestamp | Queued | Pending | Running | Completed | Failed | Error | Quota exceeded | Unknown |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const snapshot of report.statusSnapshots) {
    lines.push([
      `| ${snapshot.timestamp}`,
      snapshot.counts.queued ?? 0,
      snapshot.counts.pending ?? 0,
      snapshot.counts.running ?? 0,
      snapshot.counts.completed ?? 0,
      snapshot.counts.failed ?? 0,
      snapshot.counts.error ?? 0,
      snapshot.counts.quota_exceeded ?? 0,
      `${snapshot.counts.unknown ?? 0} |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Runtime Samples');
  lines.push('');
  lines.push('| Timestamp | Queue length | Worker RSS | Lease RSS |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const sample of report.runtimeSamples) {
    lines.push([
      `| ${sample.timestamp}`,
      sample.queueLength ?? 'n/a',
      formatBytes(sample.workerRssBytes),
      `${formatBytes(sample.leaseRssBytes)} |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Analysis Runs');
  lines.push('');
  lines.push('| User | Trace | Session | Run | Start | Last status | Error |');
  lines.push('| --- | --- | --- | --- | ---: | --- | --- |');
  for (const run of report.runs) {
    lines.push(`| ${run.userId} | ${run.traceId} | ${run.sessionId ?? ''} | ${run.runId ?? ''} | ${run.startStatus} | ${run.lastStatus} | ${run.error ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildMarkdownLoadTestPreflightReport(report: EnterpriseLoadTestPreflightReport): string {
  const lines: string[] = [];
  lines.push('# Enterprise Acceptance Load Test Preflight');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target: ${report.target.baseUrl} / tenant=${report.target.tenantId} / workspace=${report.target.workspaceId}`);
  lines.push('');
  lines.push(`Preflight status: ${report.ready ? 'ready' : 'blocked'}`);
  lines.push('');
  lines.push('This preflight does not start analysis runs and is not README §0.8 acceptance evidence.');
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| Check | Status | Evidence |');
  lines.push('| --- | --- | --- |');
  for (const check of report.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${check.evidence.join('<br>')} |`);
  }
  lines.push('');
  lines.push('## HTTP Samples');
  lines.push('');
  lines.push('| Operation | User | Status | OK | Duration | Error |');
  lines.push('| --- | --- | ---: | --- | ---: | --- |');
  for (const sample of report.httpSamples) {
    lines.push(`| ${sample.operation} | ${sample.userId} | ${sample.status} | ${sample.ok ? 'yes' : 'no'} | ${formatMs(sample.durationMs)} | ${sample.error ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runEnterpriseAcceptanceLoadTest(options: EnterpriseLoadTestOptions): Promise<EnterpriseLoadTestReport> {
  if (!options.confirmRealRun) {
    throw new Error('Refusing to start real load test without --confirm-real-run. Run --preflight-only first and confirm the prepared enterprise test environment.');
  }
  if (options.traceIds.length === 0) {
    throw new Error('At least one --trace-id is required for a real load test run');
  }

  const endAt = Date.now() + options.durationMs;
  const httpSamples: HttpSample[] = [];
  const runtimeSamples: RuntimeSample[] = [];
  const statusSnapshots: AnalysisStatusSnapshot[] = [];
  const runCount = options.targetRunningRuns + options.targetPendingRuns;

  await sampleRuntimeDashboard(options, httpSamples, runtimeSamples);

  const runs = await Promise.all(
    Array.from({ length: runCount }, (_unused, index) => startAnalysisRun(options, httpSamples, index)),
  );

  const onlineLoops = Array.from({ length: options.onlineUsers }, (_unused, index) =>
    runOnlineUserLoop(options, httpSamples, `online-user-${String(index + 1).padStart(3, '0')}`, endAt)
  );

  await Promise.all([
    ...onlineLoops,
    pollAnalysisStatuses(options, httpSamples, runs, statusSnapshots, endAt),
    pollRuntimeDashboard(options, httpSamples, runtimeSamples, endAt),
  ]);

  return buildLoadTestReport({
    options,
    httpSamples,
    runs,
    statusSnapshots,
    runtimeSamples,
  });
}

async function main(): Promise<void> {
  const options = parseLoadTestArgs(process.argv.slice(2));
  if (options.preflightOnly) {
    const preflight = await runEnterpriseAcceptanceLoadTestPreflight(options);
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, `${JSON.stringify(preflight, null, 2)}\n`);
    console.log(`[Enterprise Load Test Preflight] JSON report: ${options.outputPath}`);
    if (options.markdownPath) {
      await fs.mkdir(path.dirname(options.markdownPath), { recursive: true });
      await fs.writeFile(options.markdownPath, buildMarkdownLoadTestPreflightReport(preflight));
      console.log(`[Enterprise Load Test Preflight] Markdown report: ${options.markdownPath}`);
    }
    if (!preflight.ready) {
      const blocked = preflight.checks
        .filter(check => check.status === 'blocked')
        .map(check => check.id);
      console.warn(`[Enterprise Load Test Preflight] Blocked: ${blocked.join(', ')}`);
      process.exitCode = 2;
    }
    return;
  }
  const report = await runEnterpriseAcceptanceLoadTest(options);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[Enterprise Load Test] JSON report: ${options.outputPath}`);
  if (options.markdownPath) {
    await fs.mkdir(path.dirname(options.markdownPath), { recursive: true });
    await fs.writeFile(options.markdownPath, buildMarkdownLoadTestReport(report));
    console.log(`[Enterprise Load Test] Markdown report: ${options.markdownPath}`);
  }
  if (!report.acceptance.passed) {
    console.warn(`[Enterprise Load Test] Acceptance incomplete: ${report.acceptance.missing.join(', ')}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Enterprise Load Test] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
