// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { applyEnterpriseMinimalSchema } from '../services/enterpriseSchema';
import type { EnterpriseRepositoryScope } from '../services/enterpriseRepository';
import {
  getTracesDir,
  listTraceMetadata,
  readTraceMetadataForContext,
  writeTraceMetadata,
} from '../services/traceMetadataStore';
import { TraceProcessorLeaseStore } from '../services/traceProcessorLeaseStore';
import {
  TP_ADMISSION_CONTROL_ENV,
  TP_ESTIMATE_MULTIPLIER_ENV,
  TP_MIN_ESTIMATE_BYTES_ENV,
  TP_RAM_BUDGET_BYTES_ENV,
  decideTraceProcessorAdmission,
} from '../services/traceProcessorRamBudget';
import {
  decodeQueryArgsSql,
  encodeQueryResult,
} from '../services/traceProcessorProtobuf';
import { TraceProcessorSqlWorker } from '../services/traceProcessorSqlWorker';
import { ownerFieldsFromContext } from '../services/resourceOwnership';
import type { RequestContext } from '../middleware/auth';

type ScenarioName = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9' | 'D10';

interface VerifyOptions {
  tracePath?: string;
  uploadRoot?: string;
  outputPath?: string;
  keepTemp: boolean;
  longSqlMs: number;
}

export interface EnterpriseWindowRegressionOptions {
  tracePath?: string;
  uploadRoot?: string;
  outputPath?: string;
  keepTemp?: boolean;
  longSqlMs?: number;
}

interface WindowContext {
  label: string;
  context: RequestContext;
}

interface UploadRecord {
  traceId: string;
  originalName: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
  context: WindowContext;
}

interface RunRecord {
  sessionId: string;
  runId: string;
}

interface ScenarioReport {
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
}

export interface EnterpriseWindowRegressionReport {
  timestamp: string;
  passed: boolean;
  checks: Record<ScenarioName, boolean>;
  uploadRoot: string;
  tracePath: string;
  scenarios: Record<ScenarioName, ScenarioReport>;
  coverageLimitations: string[];
}

const DEFAULT_TRACE_CANDIDATES = [
  '../Trace/real/android-startup-light/trace.pftrace',
  'Trace/real/android-startup-light/trace.pftrace',
  '../Trace/real/android-scroll-standard/trace.pftrace',
  'Trace/real/android-scroll-standard/trace.pftrace',
];

function printUsage(): void {
  console.log('Usage: npm run enterprise:multi-tenant-windows -- [options]');
  console.log('');
  console.log('Options:');
  console.log('  --trace <path>         Fixture trace path. Defaults to the cataloged android-startup-light case.');
  console.log('  --upload-root <path>   Temporary upload root. Defaults to an OS temp dir.');
  console.log('  --output <path>        JSON report path. Defaults to backend/test-output.');
  console.log('  --long-sql-ms <ms>     Simulated long SQL window for D2 (default: 100).');
  console.log('  --keep-temp            Keep generated upload files.');
  console.log('  --help                 Show this help.');
}

function parseArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {
    keepTemp: false,
    longSqlMs: 100,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg === '--trace') {
      if (!next) throw new Error('--trace requires a value');
      options.tracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--upload-root') {
      if (!next) throw new Error('--upload-root requires a value');
      options.uploadRoot = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      if (!next) throw new Error('--output requires a value');
      options.outputPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--long-sql-ms') {
      if (!next) throw new Error('--long-sql-ms requires a value');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error('--long-sql-ms must be a positive integer');
      }
      options.longSqlMs = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveDefaultTracePath(): string {
  for (const candidate of DEFAULT_TRACE_CANDIDATES) {
    const resolved = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error('No default trace fixture found. Pass --trace <path>.');
}

function context(label: string, input: {
  tenantId: string;
  workspaceId: string;
  userId: string;
  windowId: string;
}): WindowContext {
  return {
    label,
    context: {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      windowId: input.windowId,
      authType: 'api_key',
      roles: ['analyst'],
      scopes: ['trace:read', 'trace:write', 'agent:run', 'report:read'],
      requestId: `req-${label}`,
    },
  };
}

function leaseScope(wc: WindowContext): EnterpriseRepositoryScope {
  return {
    tenantId: wc.context.tenantId,
    workspaceId: wc.context.workspaceId,
    userId: wc.context.userId,
  };
}

function seedIdentity(db: Database.Database, wc: WindowContext): void {
  const now = Date.now();
  const { tenantId, workspaceId, userId } = wc.context;
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(tenantId, tenantId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspaceId, tenantId, workspaceId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    tenantId,
    `${userId}@example.test`,
    userId,
    `oidc|${tenantId}|${userId}`,
    now,
    now,
  );
  db.prepare(`
    INSERT OR IGNORE INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
    VALUES (?, ?, ?, 'analyst', ?)
  `).run(tenantId, workspaceId, userId, now);
}

function ensureProviderSnapshot(db: Database.Database, wc: WindowContext): string {
  const now = Date.now();
  const providerSnapshotId = `provider-snapshot-${wc.context.tenantId}`;
  db.prepare(`
    INSERT OR IGNORE INTO provider_snapshots
      (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
    VALUES (?, ?, 'provider-regression', ?, 'claude-agent-sdk', ?, 'regression-v1', ?)
  `).run(
    providerSnapshotId,
    wc.context.tenantId,
    `hash-${wc.context.tenantId}`,
    JSON.stringify({ models: { primary: 'regression-primary', light: 'regression-light' } }),
    now,
  );
  return providerSnapshotId;
}

async function sha256File(filePath: string): Promise<string> {
  const buffer = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function simulateUpload(
  db: Database.Database,
  wc: WindowContext,
  tracePath: string,
  originalName: string,
): Promise<UploadRecord> {
  seedIdentity(db, wc);
  const tracesDir = getTracesDir();
  await fsp.mkdir(tracesDir, { recursive: true });

  const traceId = crypto.randomUUID();
  const localPath = path.join(tracesDir, `${traceId}.trace`);
  await fsp.copyFile(tracePath, localPath);
  const stat = await fsp.stat(localPath);
  const sha256 = await sha256File(localPath);
  const now = Date.now();

  await writeTraceMetadata({
    id: traceId,
    filename: originalName,
    size: stat.size,
    uploadedAt: new Date(now).toISOString(),
    status: 'ready',
    path: localPath,
    ...ownerFieldsFromContext(wc.context),
  });

  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).run(
    traceId,
    wc.context.tenantId,
    wc.context.workspaceId,
    wc.context.userId,
    localPath,
    sha256,
    stat.size,
    JSON.stringify({
      originalName,
      windowId: wc.context.windowId,
      regressionScenario: 'enterprise-window',
    }),
    now,
  );

  return {
    traceId,
    originalName,
    localPath,
    sha256,
    sizeBytes: stat.size,
    context: wc,
  };
}

function createAnalysisRun(
  db: Database.Database,
  wc: WindowContext,
  upload: UploadRecord,
  status: 'pending' | 'running' | 'completed',
): RunRecord {
  seedIdentity(db, wc);
  const providerSnapshotId = ensureProviderSnapshot(db, wc);
  const now = Date.now();
  const sessionId = `session-${crypto.randomUUID()}`;
  const runId = `run-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id, title, visibility, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)
  `).run(
    sessionId,
    wc.context.tenantId,
    wc.context.workspaceId,
    upload.traceId,
    wc.context.userId,
    providerSnapshotId,
    `${wc.label} ${upload.originalName}`,
    status,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at)
    VALUES (?, ?, ?, ?, 'full', ?, ?, ?)
  `).run(
    runId,
    wc.context.tenantId,
    wc.context.workspaceId,
    sessionId,
    status,
    `regression analysis for ${wc.label}`,
    now,
  );
  return { sessionId, runId };
}

function appendAgentEvent(
  db: Database.Database,
  wc: WindowContext,
  runId: string,
  cursor: number,
  eventType = 'progress',
  payload?: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO agent_events
      (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `event-${crypto.randomUUID()}`,
    wc.context.tenantId,
    wc.context.workspaceId,
    runId,
    cursor,
    eventType,
    JSON.stringify(payload ?? {
      scenario: 'enterprise-window',
      label: wc.label,
      cursor,
    }),
    Date.now(),
  );
}

function listAgentEventsAfter(
  db: Database.Database,
  wc: WindowContext,
  runId: string,
  lastEventId: number,
): Array<{ cursor: number; eventType: string; payload: Record<string, unknown> }> {
  return db.prepare<unknown[], { cursor: number; event_type: string; payload_json: string }>(`
    SELECT cursor, event_type, payload_json
    FROM agent_events
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND run_id = ?
      AND cursor > ?
    ORDER BY cursor ASC
  `).all(
    wc.context.tenantId,
    wc.context.workspaceId,
    runId,
    lastEventId,
  ).map(row => ({
    cursor: row.cursor,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}

function scalar<T>(db: Database.Database, sql: string, params: unknown[] = [], column = 'value'): T {
  const row = db.prepare(sql).get(...params) as Record<string, T>;
  return row[column];
}

async function ownedTraceIds(contextValue: RequestContext): Promise<string[]> {
  const ids: string[] = [];
  for (const metadata of await listTraceMetadata()) {
    if (await readTraceMetadataForContext(metadata.id, contextValue)) {
      ids.push(metadata.id);
    }
  }
  return ids.sort();
}

async function scenarioD1(db: Database.Database, tracePath: string, windows: {
  userAWindow1: WindowContext;
  userAWindow2: WindowContext;
  userBWindow1: WindowContext;
  userCWindow1: WindowContext;
}): Promise<ScenarioReport> {
  const sameName = 'same-name-regression.pftrace';
  const uploads = [
    await simulateUpload(db, windows.userAWindow1, tracePath, sameName),
    await simulateUpload(db, windows.userAWindow2, tracePath, sameName),
    await simulateUpload(db, windows.userBWindow1, tracePath, sameName),
    await simulateUpload(db, windows.userCWindow1, tracePath, sameName),
  ];
  const userAWindow1Run = createAnalysisRun(db, windows.userAWindow1, uploads[0], 'running');
  const userAWindow2Run = createAnalysisRun(db, windows.userAWindow2, uploads[1], 'running');

  const traceIds = uploads.map(upload => upload.traceId);
  const localPaths = uploads.map(upload => upload.localPath);
  const aOwned = await ownedTraceIds(windows.userAWindow1.context);
  const bOwned = await ownedTraceIds(windows.userBWindow1.context);
  const cOwned = await ownedTraceIds(windows.userCWindow1.context);
  const a1VisibleToB = await readTraceMetadataForContext(uploads[0].traceId, windows.userBWindow1.context);
  const bVisibleToA = await readTraceMetadataForContext(uploads[2].traceId, windows.userAWindow1.context);
  const a1VisibleToC = await readTraceMetadataForContext(uploads[0].traceId, windows.userCWindow1.context);
  const cVisibleToA = await readTraceMetadataForContext(uploads[3].traceId, windows.userAWindow1.context);

  const checks = {
    sameFilenameUsesDistinctTraceIds: new Set(traceIds).size === uploads.length,
    sameFilenameUsesDistinctFiles: new Set(localPaths).size === uploads.length,
    traceAssetsHaveOneRowPerUpload: scalar<number>(
      db,
      'SELECT COUNT(*) AS value FROM trace_assets WHERE metadata_json LIKE ?',
      [`%"originalName":"${sameName}"%`],
    ) === uploads.length,
    ownerGuardAllowsOwnTwoWindowUploads: aOwned.includes(uploads[0].traceId)
      && aOwned.includes(uploads[1].traceId),
    workspaceRbacAllowsSameWorkspacePeerTraces: Boolean(a1VisibleToB) && Boolean(bVisibleToA),
    workspaceGuardBlocksCrossTenantTraces: !a1VisibleToC && !cVisibleToA,
    threeUsersHaveScopedTraceLists: aOwned.length === 3 && bOwned.length === 3 && cOwned.length === 1,
    twoWindowsHaveSeparateSessions: userAWindow1Run.sessionId !== userAWindow2Run.sessionId
      && userAWindow1Run.runId !== userAWindow2Run.runId,
  };

  return {
    checks,
    details: {
      traceIds,
      userAOwnedTraceIds: aOwned,
      userBOwnedTraceIds: bOwned,
      userCOwnedTraceIds: cOwned,
      userAWindow1Run,
      userAWindow2Run,
    },
  };
}

async function scenarioD2(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
  userBWindow1: WindowContext,
  longSqlMs: number,
): Promise<ScenarioReport> {
  const aUpload = await simulateUpload(db, userAWindow1, tracePath, 'd2-user-a.pftrace');
  const aRun = createAnalysisRun(db, userAWindow1, aUpload, 'running');
  appendAgentEvent(db, userAWindow1, aRun.runId, 1, 'progress');

  let simulatedLongSqlDone = false;
  const simulatedLongSql = new Promise<void>((resolve) => {
    setTimeout(() => {
      simulatedLongSqlDone = true;
      resolve();
    }, longSqlMs);
  });

  await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.floor(longSqlMs / 2))));
  appendAgentEvent(db, userAWindow1, aRun.runId, 2, 'progress');
  const bStartedBeforeALongSqlDone = !simulatedLongSqlDone;

  const bUpload = await simulateUpload(db, userBWindow1, tracePath, 'd2-user-b.pftrace');
  const bRun = createAnalysisRun(db, userBWindow1, bUpload, 'pending');
  appendAgentEvent(db, userBWindow1, bRun.runId, 1, 'progress');

  const aReadableDuringBStart = await readTraceMetadataForContext(aUpload.traceId, userAWindow1.context);
  const aVisibleToB = await readTraceMetadataForContext(aUpload.traceId, userBWindow1.context);
  const bVisibleToA = await readTraceMetadataForContext(bUpload.traceId, userAWindow1.context);
  appendAgentEvent(db, userAWindow1, aRun.runId, 3, 'progress');

  await simulatedLongSql;
  db.prepare(`
    UPDATE analysis_runs SET status = 'completed', completed_at = ? WHERE id = ?
  `).run(Date.now(), aRun.runId);
  db.prepare(`
    UPDATE analysis_sessions SET status = 'completed', updated_at = ? WHERE id = ?
  `).run(Date.now(), aRun.sessionId);
  appendAgentEvent(db, userAWindow1, aRun.runId, 4, 'analysis_completed');

  const aRunEventCursors = db.prepare<unknown[], { cursor: number }>(`
    SELECT cursor FROM agent_events WHERE run_id = ? ORDER BY cursor ASC
  `).all(aRun.runId).map(row => row.cursor);
  const bRunEventCursors = db.prepare<unknown[], { cursor: number }>(`
    SELECT cursor FROM agent_events WHERE run_id = ? ORDER BY cursor ASC
  `).all(bRun.runId).map(row => row.cursor);
  const bRunStatus = scalar<string>(
    db,
    'SELECT status AS value FROM analysis_runs WHERE id = ?',
    [bRun.runId],
  );
  const aSessionTraceId = scalar<string>(
    db,
    'SELECT trace_id AS value FROM analysis_sessions WHERE id = ?',
    [aRun.sessionId],
  );
  const aFileStillExists = fs.existsSync(aUpload.localPath);

  const checks = {
    bCanStartWhileALongSqlPending: bStartedBeforeALongSqlDone && Boolean(bRun.runId),
    aTraceReadableDuringBStart: Boolean(aReadableDuringBStart) && aFileStillExists,
    workspaceRbacAllowsPeerTraceReadsDuringLongSql: Boolean(aVisibleToB) && Boolean(bVisibleToA),
    aEventStreamContinuesAfterBStart: aRunEventCursors.join(',') === '1,2,3,4',
    bRunCanQueueOrRun: bRunStatus === 'pending' || bRunStatus === 'running',
    runEventsDoNotMix: bRunEventCursors.join(',') === '1',
    aSessionStillPointsAtOriginalTrace: aSessionTraceId === aUpload.traceId,
  };

  return {
    checks,
    details: {
      aTraceId: aUpload.traceId,
      bTraceId: bUpload.traceId,
      aRun,
      bRun,
      aRunEventCursors,
      bRunEventCursors,
      bRunStatus,
    },
  };
}

async function scenarioD3(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
  userBWindow1: WindowContext,
): Promise<ScenarioReport> {
  const aUpload = await simulateUpload(db, userAWindow1, tracePath, 'd3-user-a-timeline.pftrace');
  const bUpload = await simulateUpload(db, userBWindow1, tracePath, 'd3-user-b-full-agent.pftrace');
  const bRun = createAnalysisRun(db, userBWindow1, bUpload, 'running');
  const store = new TraceProcessorLeaseStore(db);
  const aScope = leaseScope(userAWindow1);
  const bScope = leaseScope(userBWindow1);
  const frontendHolderRef = userAWindow1.context.windowId ?? userAWindow1.label;

  let frontendLease = store.acquireHolder(aScope, aUpload.traceId, {
    holderType: 'frontend_http_rpc',
    holderRef: frontendHolderRef,
    windowId: frontendHolderRef,
    frontendVisibility: 'visible',
    metadata: {
      scenario: 'D3',
      workload: 'timeline',
      priority: 'p0',
    },
  });
  store.markStarting(aScope, frontendLease.id);
  frontendLease = store.markReady(aScope, frontendLease.id);

  let agentLease = store.acquireHolder(bScope, bUpload.traceId, {
    holderType: 'agent_run',
    holderRef: bRun.runId,
    sessionId: bRun.sessionId,
    runId: bRun.runId,
    metadata: {
      scenario: 'D3',
      workload: 'full-agent',
      priority: 'p2',
    },
  });
  store.markStarting(bScope, agentLease.id);
  agentLease = store.markReady(bScope, agentLease.id);
  agentLease = store.acquireHolderForLease(bScope, agentLease.id, {
    holderType: 'report_generation',
    holderRef: `report-${bRun.runId}`,
    reportId: `report-${bRun.runId}`,
    metadata: {
      scenario: 'D3',
      workload: 'background-report',
      priority: 'p2',
    },
  });

  const frontendProxyTargets = [
    `/api/tp/${encodeURIComponent(frontendLease.id)}/websocket`,
    `/api/tp/${encodeURIComponent(frontendLease.id)}/query?priority=p0`,
    `/api/tp/${encodeURIComponent(frontendLease.id)}/heartbeat`,
  ];

  const gates = new Map<string, {
    promise: Promise<Buffer>;
    resolve: (value: Buffer) => void;
  }>();
  const makeGate = (): {
    promise: Promise<Buffer>;
    resolve: (value: Buffer) => void;
  } => {
    let resolve!: (value: Buffer) => void;
    const promise = new Promise<Buffer>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const gateFor = (sql: string) => {
    let gate = gates.get(sql);
    if (!gate) {
      gate = makeGate();
      gates.set(sql, gate);
    }
    return gate;
  };
  const flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const encodeSqlResult = (sql: string) => encodeQueryResult({
    columnNames: ['sql'],
    rows: [[sql]],
  });
  const labelForSql = (sql: string) => {
    if (sql.includes('p0')) return 'p0';
    if (sql.includes('p1')) return 'p1';
    if (sql.includes('queued_p2')) return 'queued-p2';
    return 'running-p2';
  };
  const queryDispatchOrder: string[] = [];
  const queryEventLog: string[] = [];
  const worker = new TraceProcessorSqlWorker({
    processorId: 'd3-priority-regression',
    traceId: bUpload.traceId,
    port: 1,
    forceInline: true,
    rawExecutor: async request => {
      const sql = decodeQueryArgsSql(request.body);
      const label = labelForSql(sql);
      queryDispatchOrder.push(label);
      queryEventLog.push(`start:${label}`);
      const result = await gateFor(sql).promise;
      queryEventLog.push(`finish:${label}`);
      return result;
    },
  });

  let queuedStats: ReturnType<TraceProcessorSqlWorker['getStats']>;
  try {
    const runningP2 = worker.query('SELECT d3_running_p2_full_agent', { priority: 'p2' });
    await flushPromises();

    const queuedP1 = worker.query('SELECT d3_p1_agent_context', { priority: 'p1' });
    const queuedP2 = worker.query('SELECT d3_queued_p2_report', { priority: 'p2' });
    const frontendP0 = worker.query('SELECT d3_p0_frontend_timeline', { priority: 'p0' });
    await flushPromises();
    queuedStats = worker.getStats();

    gateFor('SELECT d3_running_p2_full_agent').resolve(encodeSqlResult('SELECT d3_running_p2_full_agent'));
    const runningP2Result = await runningP2;
    await flushPromises();

    gateFor('SELECT d3_p0_frontend_timeline').resolve(encodeSqlResult('SELECT d3_p0_frontend_timeline'));
    const frontendP0Result = await frontendP0;
    await flushPromises();

    gateFor('SELECT d3_p1_agent_context').resolve(encodeSqlResult('SELECT d3_p1_agent_context'));
    const queuedP1Result = await queuedP1;
    await flushPromises();

    gateFor('SELECT d3_queued_p2_report').resolve(encodeSqlResult('SELECT d3_queued_p2_report'));
    const queuedP2Result = await queuedP2;
    await flushPromises();

    const targetHasLeaseIdOnly = frontendProxyTargets.every(target =>
      target.includes(encodeURIComponent(frontendLease.id))
      && !target.includes('127.0.0.1')
      && !target.includes('localhost')
      && !target.includes('://')
      && !/:\d{2,5}/.test(target),
    );
    const finishRunningP2Index = queryEventLog.indexOf('finish:running-p2');
    const startP0Index = queryEventLog.indexOf('start:p0');
    const queryRows = [
      runningP2Result.rows[0]?.[0],
      frontendP0Result.rows[0]?.[0],
      queuedP1Result.rows[0]?.[0],
      queuedP2Result.rows[0]?.[0],
    ];

    const checks = {
      frontendTimelineUsesLeaseProxy: targetHasLeaseIdOnly
        && frontendProxyTargets.every(target => target.startsWith('/api/tp/')),
      frontendAndAgentUseLeaseHolders: frontendLease.state === 'active'
        && agentLease.state === 'active'
        && frontendLease.holders.some(holder => holder.holderType === 'frontend_http_rpc')
        && agentLease.holders.some(holder => holder.holderType === 'agent_run')
        && agentLease.holders.some(holder => holder.holderType === 'report_generation'),
      p0DoesNotWaitBehindQueuedP1OrP2: queryDispatchOrder.join(',') === 'running-p2,p0,p1,queued-p2',
      queueIsNonPreemptive: queryEventLog[0] === 'start:running-p2'
        && finishRunningP2Index > -1
        && startP0Index > finishRunningP2Index,
      workerStatsExposeQueuedP0: queuedStats.running
        && queuedStats.queuedP0 === 1
        && queuedStats.queuedP1 === 1
        && queuedStats.queuedP2 === 1,
      queryResultsStayAssociatedWithOriginalSql: queryRows.join('|') === [
        'SELECT d3_running_p2_full_agent',
        'SELECT d3_p0_frontend_timeline',
        'SELECT d3_p1_agent_context',
        'SELECT d3_queued_p2_report',
      ].join('|'),
    };

    return {
      checks,
      details: {
        frontendTraceId: aUpload.traceId,
        agentTraceId: bUpload.traceId,
        frontendLeaseId: frontendLease.id,
        agentLeaseId: agentLease.id,
        frontendProxyTargets,
        frontendHolderTypes: frontendLease.holders.map(holder => holder.holderType),
        agentHolderTypes: agentLease.holders.map(holder => holder.holderType),
        queuedStats,
        queryDispatchOrder,
        queryEventLog,
        queryRows,
      },
    };
  } finally {
    worker.destroy();
  }
}

async function scenarioD4(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const upload = await simulateUpload(db, userAWindow1, tracePath, 'd4-user-a-crash.pftrace');
  const store = new TraceProcessorLeaseStore(db);
  const scope = leaseScope(userAWindow1);
  const windowId = userAWindow1.context.windowId ?? userAWindow1.label;
  const runId = `run-${crypto.randomUUID()}`;
  const startedAt = 1_777_100_000_000;
  const oldInternalPort: number = 9810;
  const newInternalPort: number = 9811;

  let lease = store.acquireHolder(scope, upload.traceId, {
    holderType: 'frontend_http_rpc',
    holderRef: windowId,
    windowId,
    frontendVisibility: 'visible',
    metadata: {
      scenario: 'D4',
      internalPort: oldInternalPort,
    },
  }, { now: startedAt });
  store.markStarting(scope, lease.id);
  lease = store.markReady(scope, lease.id);
  lease = store.acquireHolderForLease(scope, lease.id, {
    holderType: 'agent_run',
    holderRef: runId,
    runId,
    metadata: { scenario: 'D4' },
  }, { now: startedAt + 1 });

  const leaseIdBeforeCrash = lease.id;
  const frontendProxyTargets = [
    `/api/tp/${encodeURIComponent(lease.id)}/status`,
    `/api/tp/${encodeURIComponent(lease.id)}/websocket`,
    `/api/tp/${encodeURIComponent(lease.id)}/heartbeat`,
  ];

  const crashedLease = store.markCrashed(scope, lease.id);
  const restartingLease = store.markRestarting(scope, lease.id);
  const readyLease = store.markReady(scope, lease.id);
  const recoveredLease = store.acquireHolderForLease(scope, readyLease.id, {
    holderType: 'frontend_http_rpc',
    holderRef: windowId,
    windowId,
    frontendVisibility: 'visible',
    metadata: {
      scenario: 'D4',
      recovery: 'processor-restart',
      internalPort: newInternalPort,
    },
  }, { now: startedAt + 2 });
  const frontendHolder = recoveredLease.holders.find(holder => holder.holderRef === windowId);
  const agentHolder = recoveredLease.holders.find(holder => holder.holderRef === runId);

  const checks = {
    leaseIdStableAcrossCrashRestart: leaseIdBeforeCrash === recoveredLease.id
      && crashedLease.id === leaseIdBeforeCrash
      && restartingLease.id === leaseIdBeforeCrash,
    stateMachineUsesSingleRestartSequence: crashedLease.state === 'crashed'
      && restartingLease.state === 'restarting'
      && readyLease.state === 'active'
      && recoveredLease.state === 'active',
    holdersWaitOnSameLeaseAfterRestart: recoveredLease.holderCount === 2
      && frontendHolder?.metadata?.recovery === 'processor-restart'
      && agentHolder?.holderType === 'agent_run',
    frontendContractDoesNotExposeOldPort: frontendProxyTargets.every(target =>
      target.includes(leaseIdBeforeCrash)
      && !target.includes(String(oldInternalPort))
      && !target.includes(String(newInternalPort)),
    ),
    internalPortCanChangeWithoutChangingFrontendTarget: oldInternalPort !== newInternalPort
      && frontendHolder?.metadata?.internalPort === newInternalPort,
  };

  return {
    checks,
    details: {
      traceId: upload.traceId,
      leaseId: leaseIdBeforeCrash,
      oldInternalPort,
      newInternalPort,
      frontendProxyTargets,
      crashStates: [crashedLease.state, restartingLease.state, readyLease.state, recoveredLease.state],
      holderRefs: recoveredLease.holders.map(holder => holder.holderRef),
    },
  };
}

async function scenarioD5(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const upload = await simulateUpload(db, userAWindow1, tracePath, 'd5-user-a-sleep.pftrace');
  const store = new TraceProcessorLeaseStore(db);
  const scope = leaseScope(userAWindow1);
  const holderRef = userAWindow1.context.windowId ?? userAWindow1.label;
  const startedAt = 1_777_000_000_000;
  const offlineAt = startedAt + 30_000;
  const insideGraceAt = offlineAt + 30 * 60 * 1000 - 1;
  const afterGraceAt = offlineAt + 30 * 60 * 1000 + 1;
  const recoveredAt = afterGraceAt + 1_000;

  let lease = store.acquireHolder(scope, upload.traceId, {
    holderType: 'frontend_http_rpc',
    holderRef,
    windowId: holderRef,
    frontendVisibility: 'visible',
    metadata: { scenario: 'D5' },
  }, { now: startedAt });
  store.markStarting(scope, lease.id);
  lease = store.markReady(scope, lease.id);

  lease = store.acquireHolderForLease(scope, lease.id, {
    holderType: 'frontend_http_rpc',
    holderRef,
    windowId: holderRef,
    frontendVisibility: 'offline',
    metadata: {
      heartbeat: 'frontend',
      scenario: 'D5',
    },
  }, { now: offlineAt });
  const offlineHolder = lease.holders.find(holder => holder.holderRef === holderRef);

  const insideGraceSweep = store.sweepExpired(insideGraceAt);
  const insideGraceLease = store.getLeaseById(scope, lease.id);

  const afterGraceSweep = store.sweepExpired(afterGraceAt);
  const afterGraceLease = store.getLeaseById(scope, lease.id);

  const recoveredLease = store.acquireHolderForLease(scope, lease.id, {
    holderType: 'frontend_http_rpc',
    holderRef,
    windowId: holderRef,
    frontendVisibility: 'visible',
    metadata: {
      heartbeat: 'frontend',
      scenario: 'D5',
      recovery: 'pageshow',
    },
  }, { now: recoveredAt });
  const recoveredHolder = recoveredLease.holders.find(holder => holder.holderRef === holderRef);

  const checks = {
    offlineHeartbeatKeepsThirtyMinuteGrace: (offlineHolder?.expiresAt ?? 0) >= insideGraceAt,
    leaseStaysActiveInsideOfflineGrace: insideGraceSweep.holdersRemoved === 0
      && insideGraceLease?.state === 'active'
      && insideGraceLease.holderCount === 1,
    staleOfflineHolderDoesNotReleaseLease: afterGraceSweep.holdersRemoved === 1
      && afterGraceLease?.state === 'idle'
      && afterGraceLease.holderCount === 0,
    pageshowHeartbeatReacquiresSameLease: recoveredLease.id === lease.id
      && recoveredLease.state === 'active'
      && recoveredLease.holderCount === 1
      && recoveredHolder?.metadata?.frontendVisibility === 'visible'
      && recoveredHolder.expiresAt !== null
      && recoveredHolder.expiresAt >= recoveredAt + 90_000,
  };

  return {
    checks,
    details: {
      traceId: upload.traceId,
      leaseId: lease.id,
      offlineHolderExpiresAt: offlineHolder?.expiresAt ?? null,
      insideGraceAt,
      afterGraceAt,
      recoveredAt,
      insideGraceSweep,
      afterGraceSweep,
      afterGraceLeaseState: afterGraceLease?.state ?? null,
      recoveredLeaseState: recoveredLease.state,
      recoveredHolder,
    },
  };
}

async function scenarioD6(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
  userCWindow1: WindowContext,
): Promise<ScenarioReport> {
  const upload = await simulateUpload(db, userAWindow1, tracePath, 'd6-user-a-sse-replay.pftrace');
  const run = createAnalysisRun(db, userAWindow1, upload, 'running');
  const reportId = `report-${crypto.randomUUID()}`;
  const reportUrl = `/api/reports/${reportId}`;
  const disconnectedAfterCursor = 10;
  const completedCursor = 11;

  appendAgentEvent(db, userAWindow1, run.runId, disconnectedAfterCursor, 'conclusion', {
    type: 'conclusion',
    data: {
      summary: 'client received conclusion before disconnect',
    },
  });

  db.prepare(`
    INSERT INTO report_artifacts
      (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, NULL)
  `).run(
    reportId,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    run.sessionId,
    run.runId,
    `reports/${reportId}.html`,
    crypto.createHash('sha256').update(reportId).digest('hex'),
    userAWindow1.context.userId,
    Date.now(),
  );
  appendAgentEvent(db, userAWindow1, run.runId, completedCursor, 'analysis_completed', {
    type: 'analysis_completed',
    data: {
      reportId,
      reportUrl,
    },
  });
  db.prepare(`
    UPDATE analysis_runs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?
  `).run(Date.now(), Date.now(), run.runId);
  db.prepare(`
    UPDATE analysis_sessions SET status = 'completed', updated_at = ? WHERE id = ?
  `).run(Date.now(), run.sessionId);

  const replayed = listAgentEventsAfter(db, userAWindow1, run.runId, disconnectedAfterCursor);
  const crossTenantReplay = listAgentEventsAfter(db, userCWindow1, run.runId, disconnectedAfterCursor);
  const terminal = replayed.find(event => event.eventType === 'analysis_completed');
  const terminalPayload = terminal?.payload.data as { reportId?: string; reportUrl?: string } | undefined;
  const reportRow = db.prepare<unknown[], { id: string; run_id: string }>(`
    SELECT id, run_id FROM report_artifacts
    WHERE tenant_id = ? AND workspace_id = ? AND id = ?
  `).get(
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    reportId,
  );
  const runStatus = scalar<string>(
    db,
    'SELECT status AS value FROM analysis_runs WHERE id = ?',
    [run.runId],
  );
  const sessionStatus = scalar<string>(
    db,
    'SELECT status AS value FROM analysis_sessions WHERE id = ?',
    [run.sessionId],
  );

  const checks = {
    conclusionPersistedBeforeDisconnect: scalar<number>(
      db,
      'SELECT COUNT(*) AS value FROM agent_events WHERE run_id = ? AND cursor = ? AND event_type = ?',
      [run.runId, disconnectedAfterCursor, 'conclusion'],
    ) === 1,
    terminalReplayAfterLastEventIdIncludesReportUrl: replayed.length === 1
      && terminal?.cursor === completedCursor
      && terminalPayload?.reportUrl === reportUrl,
    replayUsesMonotonicCursorAfterDisconnect: replayed.map(event => event.cursor).join(',') === String(completedCursor),
    replayIsTenantWorkspaceScoped: crossTenantReplay.length === 0,
    reportArtifactMatchesReplayedUrl: reportRow?.id === reportId && reportRow.run_id === run.runId,
    terminalEventCompletesRunAndSession: runStatus === 'completed' && sessionStatus === 'completed',
  };

  return {
    checks,
    details: {
      traceId: upload.traceId,
      run,
      disconnectedAfterCursor,
      replayed,
      crossTenantReplayCount: crossTenantReplay.length,
      reportId,
      reportUrl,
      runStatus,
      sessionStatus,
    },
  };
}

async function scenarioD7(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const upload = await simulateUpload(db, userAWindow1, tracePath, 'd7-user-a-delete-draining.pftrace');
  const run = createAnalysisRun(db, userAWindow1, upload, 'running');
  const store = new TraceProcessorLeaseStore(db);
  const scope = leaseScope(userAWindow1);
  const windowId = userAWindow1.context.windowId ?? userAWindow1.label;
  const reportId = `report-${crypto.randomUUID()}`;

  let lease = store.acquireHolder(scope, upload.traceId, {
    holderType: 'frontend_http_rpc',
    holderRef: windowId,
    windowId,
    frontendVisibility: 'visible',
    metadata: { scenario: 'D7' },
  });
  store.markStarting(scope, lease.id);
  lease = store.markReady(scope, lease.id);
  lease = store.acquireHolderForLease(scope, lease.id, {
    holderType: 'agent_run',
    holderRef: run.runId,
    runId: run.runId,
    sessionId: run.sessionId,
    metadata: { scenario: 'D7' },
  });
  lease = store.acquireHolderForLease(scope, lease.id, {
    holderType: 'report_generation',
    holderRef: reportId,
    reportId,
    metadata: { scenario: 'D7' },
  });

  const activeRuns = db.prepare<unknown[], { id: string; status: string }>(`
    SELECT id, status
    FROM analysis_runs
    WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND status = 'running'
  `).all(userAWindow1.context.tenantId, userAWindow1.context.workspaceId, run.sessionId);
  const activeHolderTypes = Array.from(new Set(lease.holders.map(holder => holder.holderType))).sort();
  const blockedBeforeDelete = lease.holderCount > 0 || activeRuns.length > 0;
  const drainingLease = store.beginDraining(scope, lease.id);
  let newHolderRejected = false;
  try {
    store.acquireHolderForLease(scope, drainingLease.id, {
      holderType: 'manual_register',
      holderRef: 'port:9810',
      metadata: { scenario: 'D7' },
    });
  } catch {
    newHolderRejected = true;
  }
  const traceAssetStillPresent = scalar<number>(
    db,
    'SELECT COUNT(*) AS value FROM trace_assets WHERE id = ?',
    [upload.traceId],
  ) === 1;
  const fileStillPresent = fs.existsSync(upload.localPath);

  const checks = {
    deleteDetectsRunningRunBeforeRemovingTrace: activeRuns.length === 1
      && activeRuns[0]?.id === run.runId
      && activeRuns[0]?.status === 'running',
    activeLeaseBlocksCleanupOrDelete: blockedBeforeDelete
      && drainingLease.id === lease.id
      && drainingLease.state === 'draining'
      && drainingLease.holderCount === 3,
    reportGenerationHolderIsProtected: activeHolderTypes.includes('report_generation')
      && lease.holders.some(holder => holder.holderRef === reportId),
    drainingLeaseRejectsNewWork: newHolderRejected,
    blockedDeleteLeavesTraceAssetAndFileIntact: traceAssetStillPresent && fileStillPresent,
  };

  return {
    checks,
    details: {
      traceId: upload.traceId,
      run,
      leaseId: lease.id,
      activeRuns,
      activeHolderTypes,
      drainingState: drainingLease.state,
      drainingHolderCount: drainingLease.holderCount,
      newHolderRejected,
      traceAssetStillPresent,
      fileStillPresent,
    },
  };
}

async function scenarioD8(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const upload = await simulateUpload(db, userAWindow1, tracePath, 'd8-provider-snapshot-resume.pftrace');
  const now = Date.now();
  const providerId = `provider-d8-${crypto.randomUUID()}`;
  const originalSnapshotId = `provider-snapshot-d8-original-${crypto.randomUUID()}`;
  const changedSnapshotId = `provider-snapshot-d8-changed-${crypto.randomUUID()}`;
  const originalConfig = {
    baseUrl: 'https://llm.example.test/v1',
    models: {
      primary: 'd8-primary-v1',
      light: 'd8-light-v1',
    },
    timeouts: {
      fullPerTurnMs: 120_000,
      quickPerTurnMs: 30_000,
    },
    secretRef: 'secret://provider-d8',
  };
  const changedConfig = {
    ...originalConfig,
    baseUrl: 'https://llm.example.test/v2',
    models: {
      primary: 'd8-primary-v2',
      light: 'd8-light-v2',
    },
  };
  const hashInput = (config: unknown, secretVersion: string) => JSON.stringify({
    providerId,
    runtimeKind: 'openai-agents-sdk',
    config,
    secretVersion,
  });
  const originalHash = crypto.createHash('sha256').update(hashInput(originalConfig, 'secret-v1')).digest('hex');
  const changedHash = crypto.createHash('sha256').update(hashInput(changedConfig, 'secret-v2')).digest('hex');

  db.prepare(`
    INSERT INTO provider_snapshots
      (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
    VALUES (?, ?, ?, ?, 'openai-agents-sdk', ?, ?, ?)
  `).run(
    originalSnapshotId,
    userAWindow1.context.tenantId,
    providerId,
    originalHash,
    JSON.stringify(originalConfig),
    'secret-v1',
    now,
  );
  db.prepare(`
    INSERT INTO provider_snapshots
      (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
    VALUES (?, ?, ?, ?, 'openai-agents-sdk', ?, ?, ?)
  `).run(
    changedSnapshotId,
    userAWindow1.context.tenantId,
    providerId,
    changedHash,
    JSON.stringify(changedConfig),
    'secret-v2',
    now + 1,
  );

  const sessionId = `session-${crypto.randomUUID()}`;
  const originalRunId = `run-${crypto.randomUUID()}`;
  const followUpRunId = `run-${crypto.randomUUID()}`;
  const oldSdkSessionId = 'sdk-response-d8-old';
  const freshSdkSessionId = 'sdk-response-d8-fresh';

  db.prepare(`
    INSERT INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id, title, visibility, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 'completed', ?, ?)
  `).run(
    sessionId,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    upload.traceId,
    userAWindow1.context.userId,
    originalSnapshotId,
    `${userAWindow1.label} D8 provider snapshot`,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'full', 'completed', ?, ?, ?)
  `).run(
    originalRunId,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    'first turn before provider config changed',
    now,
    now + 10,
  );
  db.prepare(`
    INSERT INTO runtime_snapshots
      (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'openai-agents-sdk', ?, ?)
  `).run(
    `runtime-snapshot-d8-original-${crypto.randomUUID()}`,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    originalRunId,
    JSON.stringify({
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: providerId,
      agentRuntimeProviderSnapshotHash: originalHash,
      sdkSessionId: oldSdkSessionId,
      runSequence: 1,
    }),
    now + 20,
  );

  const pinnedSnapshot = db.prepare<unknown[], {
    id: string;
    provider_id: string;
    snapshot_hash: string;
    runtime_kind: string;
    resolved_config_json: string;
    secret_version: string;
  }>(`
    SELECT ps.id, ps.provider_id, ps.snapshot_hash, ps.runtime_kind, ps.resolved_config_json, ps.secret_version
    FROM analysis_sessions s
    JOIN provider_snapshots ps ON ps.id = s.provider_snapshot_id
    WHERE s.tenant_id = ? AND s.workspace_id = ? AND s.id = ?
  `).get(userAWindow1.context.tenantId, userAWindow1.context.workspaceId, sessionId);
  const latestProviderSnapshot = db.prepare<unknown[], {
    id: string;
    snapshot_hash: string;
    resolved_config_json: string;
    secret_version: string;
  }>(`
    SELECT id, snapshot_hash, resolved_config_json, secret_version
    FROM provider_snapshots
    WHERE tenant_id = ? AND provider_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userAWindow1.context.tenantId, providerId);
  const originalRuntimeRow = db.prepare<unknown[], { snapshot_json: string }>(`
    SELECT snapshot_json
    FROM runtime_snapshots
    WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND run_id = ?
  `).get(
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    originalRunId,
  );
  const originalRuntimeSnapshot = JSON.parse(originalRuntimeRow?.snapshot_json ?? '{}') as {
    agentRuntimeProviderId?: string;
    agentRuntimeProviderSnapshotHash?: string;
    sdkSessionId?: string;
  };
  const providerSnapshotChanged = Boolean(
    originalRuntimeSnapshot.agentRuntimeProviderSnapshotHash
    && latestProviderSnapshot?.snapshot_hash
    && originalRuntimeSnapshot.agentRuntimeProviderSnapshotHash !== latestProviderSnapshot.snapshot_hash,
  );
  const sdkSessionReusable = Boolean(
    !providerSnapshotChanged
    && originalRuntimeSnapshot.sdkSessionId
    && originalRuntimeSnapshot.agentRuntimeProviderId === providerId,
  );

  db.prepare(`
    INSERT INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'followup', 'completed', ?, ?, ?)
  `).run(
    followUpRunId,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    'follow-up turn after provider config changed',
    now + 30,
    now + 40,
  );
  db.prepare(`
    INSERT INTO runtime_snapshots
      (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'openai-agents-sdk', ?, ?)
  `).run(
    `runtime-snapshot-d8-followup-${crypto.randomUUID()}`,
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    followUpRunId,
    JSON.stringify({
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: providerId,
      agentRuntimeProviderSnapshotHash: changedHash,
      sdkSessionId: freshSdkSessionId,
      previousProviderSnapshotHash: originalHash,
      providerSnapshotChangeReason: 'provider_snapshot_hash_mismatch',
      runSequence: 2,
    }),
    now + 50,
  );
  const followUpRuntimeRow = db.prepare<unknown[], { snapshot_json: string }>(`
    SELECT snapshot_json
    FROM runtime_snapshots
    WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND run_id = ?
  `).get(
    userAWindow1.context.tenantId,
    userAWindow1.context.workspaceId,
    sessionId,
    followUpRunId,
  );
  const followUpRuntimeSnapshot = JSON.parse(followUpRuntimeRow?.snapshot_json ?? '{}') as {
    agentRuntimeProviderSnapshotHash?: string;
    sdkSessionId?: string;
    previousProviderSnapshotHash?: string;
  };
  const pinnedConfigJson = pinnedSnapshot?.resolved_config_json ?? '';
  const latestConfigJson = latestProviderSnapshot?.resolved_config_json ?? '';

  const checks = {
    sessionStoresOriginalProviderSnapshot: pinnedSnapshot?.id === originalSnapshotId
      && pinnedSnapshot.provider_id === providerId
      && pinnedSnapshot.snapshot_hash === originalHash,
    latestProviderConfigUsesDifferentHash: latestProviderSnapshot?.id === changedSnapshotId
      && latestProviderSnapshot.snapshot_hash === changedHash
      && latestProviderSnapshot.snapshot_hash !== pinnedSnapshot?.snapshot_hash,
    resumeDetectsProviderSnapshotHashMismatch: providerSnapshotChanged,
    oldSdkSessionIsNotReusableAfterMismatch: !sdkSessionReusable
      && originalRuntimeSnapshot.sdkSessionId === oldSdkSessionId,
    followUpRuntimeUsesFreshSdkSession: followUpRuntimeSnapshot.agentRuntimeProviderSnapshotHash === changedHash
      && followUpRuntimeSnapshot.previousProviderSnapshotHash === originalHash
      && followUpRuntimeSnapshot.sdkSessionId === freshSdkSessionId
      && followUpRuntimeSnapshot.sdkSessionId !== originalRuntimeSnapshot.sdkSessionId,
    providerSnapshotsDoNotPersistPlaintextSecret: !pinnedConfigJson.includes('sk-')
      && !latestConfigJson.includes('sk-')
      && pinnedSnapshot?.secret_version === 'secret-v1'
      && latestProviderSnapshot?.secret_version === 'secret-v2',
  };

  return {
    checks,
    details: {
      traceId: upload.traceId,
      sessionId,
      originalRunId,
      followUpRunId,
      providerId,
      originalSnapshotId,
      changedSnapshotId,
      originalHash,
      changedHash,
      oldSdkSessionId,
      freshSdkSessionId,
      providerSnapshotChanged,
      sdkSessionReusable,
    },
  };
}

async function scenarioD9(
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const restartDbPath = path.join(path.dirname(getTracesDir()), `d9-restart-${crypto.randomUUID()}.sqlite`);
  let restartDb = new Database(restartDbPath);
  try {
    applyEnterpriseMinimalSchema(restartDb);
    const upload = await simulateUpload(restartDb, userAWindow1, tracePath, 'd9-backend-restart.pftrace');
    const pendingRun = createAnalysisRun(restartDb, userAWindow1, upload, 'pending');
    const runningRun = createAnalysisRun(restartDb, userAWindow1, upload, 'running');
    const completedRun = createAnalysisRun(restartDb, userAWindow1, upload, 'completed');
    const recoveryAt = 1_777_200_100_000;
    const recoveryErrorJson = JSON.stringify({
      message: 'backend restart during D9 regression',
      source: 'backend_startup_recovery',
    });

    appendAgentEvent(restartDb, userAWindow1, pendingRun.runId, 1, 'progress', {
      type: 'progress',
      data: { phase: 'queued-before-restart' },
    });
    appendAgentEvent(restartDb, userAWindow1, runningRun.runId, 1, 'progress', {
      type: 'progress',
      data: { phase: 'running-before-restart' },
    });
    appendAgentEvent(restartDb, userAWindow1, runningRun.runId, 2, 'thought', {
      type: 'thought',
      data: { summary: 'partial thought before restart' },
    });
    appendAgentEvent(restartDb, userAWindow1, completedRun.runId, 1, 'conclusion', {
      type: 'conclusion',
      data: { summary: 'completed before restart' },
    });
    appendAgentEvent(restartDb, userAWindow1, completedRun.runId, 2, 'analysis_completed', {
      type: 'analysis_completed',
      data: { reportUrl: '/api/reports/d9-terminal-report' },
    });
    restartDb.prepare(`
      UPDATE analysis_runs
      SET completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(recoveryAt - 1_000, recoveryAt - 1_000, completedRun.runId);
    restartDb.prepare(`
      UPDATE analysis_sessions
      SET status = 'completed', updated_at = ?
      WHERE id = ?
    `).run(recoveryAt - 1_000, completedRun.sessionId);

    restartDb.close();
    restartDb = new Database(restartDbPath);
    applyEnterpriseMinimalSchema(restartDb);

    const interrupted = restartDb.prepare<unknown[], {
      id: string;
      tenant_id: string;
      workspace_id: string;
      session_id: string;
      status: string;
    }>(`
      SELECT id, tenant_id, workspace_id, session_id, status
      FROM analysis_runs
      WHERE status IN ('pending', 'running', 'awaiting_user')
      ORDER BY updated_at ASC, started_at ASC, id ASC
    `).all();
    const recoverInterrupted = restartDb.transaction(() => {
      for (const run of interrupted) {
        restartDb.prepare(`
          UPDATE analysis_runs
          SET status = 'failed',
              heartbeat_at = ?,
              updated_at = ?,
              completed_at = COALESCE(completed_at, ?),
              error_json = COALESCE(error_json, ?)
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND id = ?
            AND status = ?
        `).run(
          recoveryAt,
          recoveryAt,
          recoveryAt,
          recoveryErrorJson,
          run.tenant_id,
          run.workspace_id,
          run.id,
          run.status,
        );
        restartDb.prepare(`
          UPDATE analysis_sessions
          SET status = 'failed',
              updated_at = ?
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND id = ?
            AND status IN ('pending', 'running', 'awaiting_user')
        `).run(recoveryAt, run.tenant_id, run.workspace_id, run.session_id);
      }
    });
    recoverInterrupted();

    const lifecycleRows = restartDb.prepare<unknown[], {
      id: string;
      status: string;
      completed_at: number | null;
      error_json: string | null;
    }>(`
      SELECT id, status, completed_at, error_json
      FROM analysis_runs
      WHERE id IN (?, ?, ?)
      ORDER BY id ASC
    `).all(pendingRun.runId, runningRun.runId, completedRun.runId);
    const lifecycleById = Object.fromEntries(lifecycleRows.map(row => [row.id, row]));
    const pendingEvents = listAgentEventsAfter(restartDb, userAWindow1, pendingRun.runId, 0);
    const runningEvents = listAgentEventsAfter(restartDb, userAWindow1, runningRun.runId, 0);
    const completedEvents = listAgentEventsAfter(restartDb, userAWindow1, completedRun.runId, 0);
    const traceMetadata = await readTraceMetadataForContext(upload.traceId, userAWindow1.context);
    const traceAssetRow = restartDb.prepare<unknown[], { id: string; local_path: string; status: string }>(`
      SELECT id, local_path, status
      FROM trace_assets
      WHERE tenant_id = ? AND workspace_id = ? AND id = ?
    `).get(userAWindow1.context.tenantId, userAWindow1.context.workspaceId, upload.traceId);
    const sessionStatuses = restartDb.prepare<unknown[], { id: string; status: string }>(`
      SELECT id, status
      FROM analysis_sessions
      WHERE id IN (?, ?, ?)
      ORDER BY id ASC
    `).all(pendingRun.sessionId, runningRun.sessionId, completedRun.sessionId);
    const sessionStatusById = Object.fromEntries(sessionStatuses.map(row => [row.id, row.status]));
    const recoveredPreviousStatuses = interrupted.map(run => [run.id, run.status]);

    const checks = {
      fileBackedDbReopensWithTraceAsset: traceAssetRow?.id === upload.traceId
        && traceAssetRow.status === 'ready'
        && fs.existsSync(upload.localPath),
      traceMetadataReadableAfterRestart: traceMetadata?.id === upload.traceId
        && traceMetadata.tenantId === userAWindow1.context.tenantId
        && traceMetadata.workspaceId === userAWindow1.context.workspaceId,
      startupRecoveryFindsOnlyNonterminalRuns: recoveredPreviousStatuses.length === 2
        && recoveredPreviousStatuses.some(([id, status]) => id === pendingRun.runId && status === 'pending')
        && recoveredPreviousStatuses.some(([id, status]) => id === runningRun.runId && status === 'running')
        && !recoveredPreviousStatuses.some(([id]) => id === completedRun.runId),
      pendingAndRunningRunsBecomeFailed: lifecycleById[pendingRun.runId]?.status === 'failed'
        && lifecycleById[runningRun.runId]?.status === 'failed'
        && lifecycleById[pendingRun.runId]?.completed_at === recoveryAt
        && lifecycleById[runningRun.runId]?.completed_at === recoveryAt,
      terminalRunRemainsCompleted: lifecycleById[completedRun.runId]?.status === 'completed'
        && lifecycleById[completedRun.runId]?.completed_at === recoveryAt - 1_000,
      persistedEventsReplayAfterRestart: pendingEvents.map(event => event.cursor).join(',') === '1'
        && runningEvents.map(event => event.cursor).join(',') === '1,2'
        && completedEvents.map(event => `${event.cursor}:${event.eventType}`).join(',') === '1:conclusion,2:analysis_completed',
      failedSessionsMarkedWithoutTouchingTerminalSession: sessionStatusById[pendingRun.sessionId] === 'failed'
        && sessionStatusById[runningRun.sessionId] === 'failed'
        && sessionStatusById[completedRun.sessionId] === 'completed',
      recoveryErrorIsAuditable: lifecycleById[pendingRun.runId]?.error_json === recoveryErrorJson
        && lifecycleById[runningRun.runId]?.error_json === recoveryErrorJson
        && lifecycleById[completedRun.runId]?.error_json === null,
    };

    return {
      checks,
      details: {
        traceId: upload.traceId,
        restartDbPath,
        pendingRun,
        runningRun,
        completedRun,
        recoveredPreviousStatuses,
        pendingEvents,
        runningEvents,
        completedEvents,
        sessionStatusById,
      },
    };
  } finally {
    restartDb.close();
  }
}

async function scenarioD10(
  db: Database.Database,
  tracePath: string,
  userAWindow1: WindowContext,
): Promise<ScenarioReport> {
  const mib = 1024 * 1024;
  const activeUpload = await simulateUpload(db, userAWindow1, tracePath, 'd10-active-window.pftrace');
  const candidateUpload = await simulateUpload(db, userAWindow1, tracePath, 'd10-rejected-new-lease.pftrace');
  const store = new TraceProcessorLeaseStore(db);
  const scope = leaseScope(userAWindow1);
  const windowId = userAWindow1.context.windowId ?? userAWindow1.label;
  const activeRssBytes = 448 * mib;
  const budgetBytes = 512 * mib;
  const minEstimateBytes = 128 * mib;

  let activeLease = store.acquireHolder(scope, activeUpload.traceId, {
    holderType: 'frontend_http_rpc',
    holderRef: windowId,
    windowId,
    frontendVisibility: 'visible',
    metadata: { scenario: 'D10' },
  });
  store.markStarting(scope, activeLease.id);
  activeLease = store.markReady(scope, activeLease.id);
  activeLease = store.recordRss(scope, activeLease.id, activeRssBytes);

  const admissionEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [TP_ADMISSION_CONTROL_ENV]: 'true',
    [TP_RAM_BUDGET_BYTES_ENV]: String(budgetBytes),
    [TP_ESTIMATE_MULTIPLIER_ENV]: '1',
    [TP_MIN_ESTIMATE_BYTES_ENV]: String(minEstimateBytes),
  };
  const processorSamples = store.listLeases(scope, {
    states: ['pending', 'starting', 'ready', 'idle', 'active', 'crashed', 'restarting'],
  }).map(lease => ({
    traceId: lease.traceId,
    rssBytes: lease.rssBytes,
  }));
  const decision = decideTraceProcessorAdmission({
    traceId: candidateUpload.traceId,
    traceSizeBytes: candidateUpload.sizeBytes,
    processors: processorSamples,
    env: admissionEnv,
  });

  let newLeaseAttempted = false;
  if (decision.admitted) {
    newLeaseAttempted = true;
    store.acquireHolder(scope, candidateUpload.traceId, {
      holderType: 'agent_run',
      holderRef: 'run-d10-candidate',
      metadata: { scenario: 'D10' },
    });
  }

  const activeLeaseAfterRejectedAdmission = store.getLeaseById(scope, activeLease.id);
  const candidateLeases = store.listLeases(scope, { traceId: candidateUpload.traceId });
  const activeHolderCountBeforeShare = activeLeaseAfterRejectedAdmission?.holderCount ?? 0;
  const sharedLease = store.acquireHolder(scope, activeUpload.traceId, {
    holderType: 'agent_run',
    holderRef: 'run-d10-existing-trace',
    runId: 'run-d10-existing-trace',
    metadata: { scenario: 'D10', reuse: 'existing-lease' },
  });
  const activeTraceLeases = store.listLeases(scope, { traceId: activeUpload.traceId });
  const activeTraceAssetPresent = scalar<number>(
    db,
    'SELECT COUNT(*) AS value FROM trace_assets WHERE id = ?',
    [activeUpload.traceId],
  ) === 1;
  const candidateTraceAssetPresent = scalar<number>(
    db,
    'SELECT COUNT(*) AS value FROM trace_assets WHERE id = ?',
    [candidateUpload.traceId],
  ) === 1;

  const checks = {
    admissionRejectsNewLeaseNearRamBudget: !decision.admitted
      && decision.estimatedRssBytes === minEstimateBytes
      && decision.stats.availableForNewLeaseBytes === budgetBytes - activeRssBytes
      && Boolean(decision.reason?.includes('exceeds available budget')),
    rejectedAdmissionDoesNotCreateCandidateLease: !newLeaseAttempted
      && candidateLeases.length === 0
      && candidateTraceAssetPresent
      && fs.existsSync(candidateUpload.localPath),
    activeLeaseSurvivesRejectedAdmission: activeLeaseAfterRejectedAdmission?.id === activeLease.id
      && activeLeaseAfterRejectedAdmission.state === 'active'
      && activeLeaseAfterRejectedAdmission.rssBytes === activeRssBytes
      && activeLeaseAfterRejectedAdmission.holderCount === 1,
    existingTraceCanReuseSharedLeaseWithoutNewProcessor: sharedLease.id === activeLease.id
      && sharedLease.holderCount === activeHolderCountBeforeShare + 1
      && activeTraceLeases.length === 1,
    noOomStyleCleanupOfExistingWindow: activeTraceAssetPresent
      && fs.existsSync(activeUpload.localPath)
      && store.getLeaseById(scope, activeLease.id)?.state === 'active',
  };

  return {
    checks,
    details: {
      activeTraceId: activeUpload.traceId,
      candidateTraceId: candidateUpload.traceId,
      activeLeaseId: activeLease.id,
      activeRssBytes,
      budgetBytes,
      estimatedRssBytes: decision.estimatedRssBytes,
      availableForNewLeaseBytes: decision.stats.availableForNewLeaseBytes,
      admissionReason: decision.reason,
      activeHolderCountBeforeShare,
      activeHolderCountAfterShare: sharedLease.holderCount,
      candidateLeaseCount: candidateLeases.length,
    },
  };
}

function allChecksPassed(report: EnterpriseWindowRegressionReport): boolean {
  return Object.values(report.scenarios).every(scenario =>
    Object.values(scenario.checks).every(Boolean),
  );
}

function scenarioPassed(scenario: ScenarioReport): boolean {
  return Object.values(scenario.checks).every(Boolean);
}

export async function runEnterpriseWindowRegression(
  input: EnterpriseWindowRegressionOptions = {},
): Promise<EnterpriseWindowRegressionReport> {
  const tracePath = input.tracePath ? path.resolve(input.tracePath) : resolveDefaultTracePath();
  const createdUploadRoot = !input.uploadRoot;
  const uploadRoot = input.uploadRoot
    ? path.resolve(input.uploadRoot)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-window-'));
  const previousUploadRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadRoot;

  const db = new Database(':memory:');
  applyEnterpriseMinimalSchema(db);

  try {
    const windows = {
      userAWindow1: context('user-a-window-1', {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
        windowId: 'window-a-1',
      }),
      userAWindow2: context('user-a-window-2', {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
        windowId: 'window-a-2',
      }),
      userBWindow1: context('user-b-window-1', {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-b',
        windowId: 'window-b-1',
      }),
      userCWindow1: context('user-c-window-1', {
        tenantId: 'tenant-b',
        workspaceId: 'workspace-c',
        userId: 'user-c',
        windowId: 'window-c-1',
      }),
    };

    const scenarios = {
      D1: await scenarioD1(db, tracePath, windows),
      D2: await scenarioD2(
        db,
        tracePath,
        windows.userAWindow1,
        windows.userBWindow1,
        input.longSqlMs ?? 100,
      ),
      D3: await scenarioD3(db, tracePath, windows.userAWindow1, windows.userBWindow1),
      D4: await scenarioD4(db, tracePath, windows.userAWindow1),
      D5: await scenarioD5(db, tracePath, windows.userAWindow1),
      D6: await scenarioD6(db, tracePath, windows.userAWindow1, windows.userCWindow1),
      D7: await scenarioD7(db, tracePath, windows.userAWindow1),
      D8: await scenarioD8(db, tracePath, windows.userAWindow1),
      D9: await scenarioD9(tracePath, windows.userAWindow1),
      D10: await scenarioD10(db, tracePath, windows.userAWindow1),
    };
    const report: EnterpriseWindowRegressionReport = {
      timestamp: new Date().toISOString(),
      passed: false,
      checks: {
        D1: scenarioPassed(scenarios.D1),
        D2: scenarioPassed(scenarios.D2),
        D3: scenarioPassed(scenarios.D3),
        D4: scenarioPassed(scenarios.D4),
        D5: scenarioPassed(scenarios.D5),
        D6: scenarioPassed(scenarios.D6),
        D7: scenarioPassed(scenarios.D7),
        D8: scenarioPassed(scenarios.D8),
        D9: scenarioPassed(scenarios.D9),
        D10: scenarioPassed(scenarios.D10),
      },
      uploadRoot,
      tracePath,
      scenarios,
      coverageLimitations: [
        'D1 covers same-name trace isolation across three users and two windows at the trace metadata, TraceAsset, workspace RBAC, and analysis session/run schema layers.',
        'D2 covers a deterministic long-SQL window at the run/event metadata layer without invoking a real LLM provider.',
        'D3 covers lease-proxy target shape plus TraceProcessorSqlWorker priority ordering; traceProcessorProxyRoutes tests cover authenticated live route priority forwarding.',
        'D4 covers the lease state contract and frontend proxy target stability around a simulated trace_processor crash; TraceProcessorService restart backoff and single-supervisor behavior are covered by traceProcessorLeaseProcessorRouting tests.',
        'D5 covers TraceProcessorLease holder grace and pageshow-style reacquire semantics after offline heartbeat expiry; frontend stale-lease reload signaling is covered by HttpRpcEngine unit tests.',
        'D6 covers the persisted AgentEvent replay contract after a conclusion cursor; the live stream route path is covered by agentRoutesRbac tests.',
        'D7 covers running run, active lease, report_generation holder, and draining rejection invariants; actual route blocking is covered by enterpriseTraceMetadataRoutes tests.',
        'D8 covers the DB ProviderSnapshot pin/hash-mismatch invariant in the enterprise window regression; AgentAnalyzeSessionService tests cover actual in-memory and persisted SDK session non-reuse.',
        'D9 covers file-backed DB close/reopen recovery for trace metadata, run states, and AgentEvent replay; enterpriseRestartPersistence tests cover the route-level restart recovery path.',
        'D10 covers RAM-admission rejection without creating a new lease or cleaning up existing active holders; TraceProcessorFactory tests cover pre-spawn rejection before a real processor starts.',
        'Production backend proxy and queue behavior remain future §0.7 D1/D2/D3/D4/D5/D6/D7/D8/D9/D10 final-acceptance work against a live browser and trace_processor_shell.',
      ],
    };
    report.passed = allChecksPassed(report);

    const outputPath = input.outputPath
      ? path.resolve(input.outputPath)
      : path.resolve(
          process.cwd(),
          'test-output',
          `enterprise-window-regression-${Date.now()}.json`,
        );
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`Report written to: ${outputPath}`);

    return report;
  } finally {
    db.close();
    if (previousUploadRoot === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadRoot;
    }
    if (createdUploadRoot && !input.keepTemp) {
      await fsp.rm(uploadRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runEnterpriseWindowRegression(options)
    .then((report) => {
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
