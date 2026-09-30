// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import { openEnterpriseDb, resolveEnterpriseDbPath } from './enterpriseDb';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';
import {
  decodePrivateContextColumn,
  encodePrivateContextColumn,
  unrestrictedPrivateContextSql,
  type AnalysisPrivateContextMarker,
} from './security/analysisPrivateContext';

export type PersistedAnalysisRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'quota_exceeded';

export interface AnalysisRunPersistenceScope extends EnterpriseRepositoryScope {
  sessionId: string;
  runId: string;
  traceId: string;
  query?: string;
  mode?: string;
  /**
   * The run's authorized private material, written with the run row by
   * whichever store creates it first and never rewritten.
   */
  privateContext: AnalysisPrivateContextMarker;
}

export interface AnalysisRunLifecycle {
  id: string;
  status: PersistedAnalysisRunStatus | string;
  startedAt: number;
  completedAt: number | null;
  heartbeatAt: number | null;
  updatedAt: number | null;
  errorJson: string | null;
}

export interface InterruptedAnalysisRunRecovery {
  id: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  previousStatus: PersistedAnalysisRunStatus | string;
}

interface AnalysisRunRow extends Record<string, unknown> {
  id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  heartbeat_at: number | null;
  updated_at: number | null;
  error_json: string | null;
}

interface InterruptedAnalysisRunRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  status: string;
}

let singletonDb: Database.Database | null = null;
let singletonDbPath: string | null = null;

function getAnalysisRunDb(): Database.Database {
  const dbPath = resolveEnterpriseDbPath();
  if (!singletonDb || singletonDbPath !== dbPath) {
    singletonDb?.close();
    singletonDb = openEnterpriseDb(dbPath);
    singletonDbPath = dbPath;
  }
  return singletonDb;
}

export function resetAnalysisRunStoreForTests(): void {
  singletonDb?.close();
  singletonDb = null;
  singletonDbPath = null;
}

export interface AnalysisRunRowSeed {
  id: string;
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  mode: string;
  status: string;
  question: string;
  startedAt: number;
  completedAt?: number | null;
  heartbeatAt?: number | null;
  updatedAt?: number | null;
  privateContext: AnalysisPrivateContextMarker;
}

/**
 * The one writer of new analysis_runs rows. Several stores may create a run's
 * row first; whichever does fixes its private-context marker, which nothing
 * rewrites afterwards. A run that may have read private material stores no
 * question text: its only reader, tenant export, omits it, and a row that
 * never held the text cannot leak it.
 */
export function insertAnalysisRunIfMissing(db: Database.Database, row: AnalysisRunRowSeed): void {
  const privateContext = encodePrivateContextColumn(row.privateContext);
  db.prepare(`
    INSERT OR IGNORE INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at,
       heartbeat_at, updated_at, private_context)
    VALUES
      (@id, @tenantId, @workspaceId, @sessionId, @mode, @status, @question, @startedAt, @completedAt,
       @heartbeatAt, @updatedAt, @privateContext)
  `).run({
    ...row,
    // Same test as the update below: only a row stored as public holds text.
    question: privateContext === 0 ? row.question : '',
    completedAt: row.completedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    updatedAt: row.updatedAt ?? null,
    privateContext,
  });
}

/** The run's marker; a missing run is unknown. */
export function getAnalysisRunPrivateContext(
  scope: EnterpriseRepositoryScope,
  runId: string,
): AnalysisPrivateContextMarker {
  const row = getAnalysisRunDb().prepare<unknown[], {private_context: number | null}>(`
    SELECT private_context
    FROM analysis_runs
    WHERE tenant_id = ? AND workspace_id = ? AND id = ?
    LIMIT 1
  `).get(scope.tenantId, scope.workspaceId, runId);
  return decodePrivateContextColumn(row?.private_context);
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'quota_exceeded';
}

function ensureAnalysisRunGraph(
  db: Database.Database,
  scope: AnalysisRunPersistenceScope,
  now: number,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(scope.tenantId, scope.tenantId, now, now);

  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(scope.workspaceId, scope.tenantId, scope.workspaceId, now, now);

  if (scope.userId) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.userId,
      scope.tenantId,
      `${scope.userId}@analysis-run.local`,
      scope.userId,
      `analysis-run:${scope.userId}`,
      now,
      now,
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, 0, 'metadata_only', ?, ?)
  `).run(
    scope.traceId,
    scope.tenantId,
    scope.workspaceId,
    scope.userId ?? null,
    `metadata-only:${scope.traceId}`,
    JSON.stringify({ source: 'analysis_run', sessionId: scope.sessionId, runId: scope.runId }),
    now,
  );

  db.prepare(`
    INSERT OR IGNORE INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'private', 'running', ?, ?)
  `).run(
    scope.sessionId,
    scope.tenantId,
    scope.workspaceId,
    scope.traceId,
    scope.userId ?? null,
    `Agent session ${scope.sessionId}`,
    now,
    now,
  );

  insertAnalysisRunIfMissing(db, {
    id: scope.runId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    mode: scope.mode ?? 'agent',
    status: 'running',
    question: scope.query ?? '',
    startedAt: now,
    heartbeatAt: now,
    updatedAt: now,
    privateContext: scope.privateContext,
  });
}

export function persistAnalysisRunState(
  scope: AnalysisRunPersistenceScope,
  status: PersistedAnalysisRunStatus,
  options: { now?: number; error?: string; updateSessionStatus?: boolean } = {},
): void {
  const now = options.now ?? Date.now();
  const terminal = isTerminalStatus(status);
  const updateSessionStatus = options.updateSessionStatus !== false;
  const db = getAnalysisRunDb();
  const write = db.transaction(() => {
    ensureAnalysisRunGraph(db, scope, now);
    db.prepare(`
      UPDATE analysis_runs
      SET status = ?,
          question = CASE WHEN ? <> '' AND ${unrestrictedPrivateContextSql('private_context')} THEN ? ELSE question END,
          heartbeat_at = ?,
          updated_at = ?,
          completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
          error_json = ?
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND id = ?
    `).run(
      status,
      scope.query ?? '',
      scope.query ?? '',
      now,
      now,
      terminal ? 1 : 0,
      now,
      options.error ? JSON.stringify({ message: options.error }) : null,
      scope.tenantId,
      scope.workspaceId,
      scope.runId,
    );
    if (updateSessionStatus) {
      db.prepare(`
        UPDATE analysis_sessions
        SET status = ?, updated_at = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND id = ?
      `).run(
        terminal ? status : 'running',
        now,
        scope.tenantId,
        scope.workspaceId,
        scope.sessionId,
      );
    } else {
      db.prepare(`
        UPDATE analysis_sessions
        SET updated_at = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND id = ?
      `).run(now, scope.tenantId, scope.workspaceId, scope.sessionId);
    }
  });
  write();
}

export function heartbeatAnalysisRun(
  scope: AnalysisRunPersistenceScope,
  now = Date.now(),
): void {
  const db = getAnalysisRunDb();
  const write = db.transaction(() => {
    ensureAnalysisRunGraph(db, scope, now);
    db.prepare(`
      UPDATE analysis_runs
      SET heartbeat_at = ?, updated_at = ?
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND id = ?
        AND status IN ('pending', 'running', 'awaiting_user')
    `).run(now, now, scope.tenantId, scope.workspaceId, scope.runId);
    db.prepare(`
      UPDATE analysis_sessions
      SET updated_at = ?
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND id = ?
    `).run(now, scope.tenantId, scope.workspaceId, scope.sessionId);
  });
  write();
}

export function getAnalysisRunLifecycle(
  scope: EnterpriseRepositoryScope,
  runId: string,
): AnalysisRunLifecycle | null {
  const db = getAnalysisRunDb();
  const row = db.prepare<unknown[], AnalysisRunRow>(`
    SELECT id, status, started_at, completed_at, heartbeat_at, updated_at, error_json
    FROM analysis_runs
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND id = ?
    LIMIT 1
  `).get(scope.tenantId, scope.workspaceId, runId);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    updatedAt: row.updated_at,
    errorJson: row.error_json,
  };
}

export function isAnalysisRunHeartbeatFresh(
  scope: EnterpriseRepositoryScope,
  runId: string,
  now: number,
  maxStaleMs: number,
): boolean {
  const lifecycle = getAnalysisRunLifecycle(scope, runId);
  if (!lifecycle || isTerminalStatus(lifecycle.status)) return false;
  const heartbeatAt = lifecycle.heartbeatAt ?? lifecycle.updatedAt ?? lifecycle.startedAt;
  return now - heartbeatAt <= maxStaleMs;
}

export function failInterruptedAnalysisRunsOnStartup(
  options: { now?: number; error?: string } = {},
): InterruptedAnalysisRunRecovery[] {
  const now = options.now ?? Date.now();
  const errorJson = JSON.stringify({
    message: options.error ?? 'Backend restarted before analysis completed',
    source: 'backend_startup_recovery',
  });
  const db = getAnalysisRunDb();
  return db.transaction(() => {
    const interrupted = db.prepare<unknown[], InterruptedAnalysisRunRow>(`
      SELECT id, tenant_id, workspace_id, session_id, status
      FROM analysis_runs
      WHERE status IN ('pending', 'running', 'awaiting_user')
      ORDER BY updated_at ASC, started_at ASC, id ASC
    `).all();

    for (const run of interrupted) {
      db.prepare(`
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
        now,
        now,
        now,
        errorJson,
        run.tenant_id,
        run.workspace_id,
        run.id,
        run.status,
      );
      db.prepare(`
        UPDATE analysis_sessions
        SET status = 'failed',
            updated_at = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND id = ?
          AND status IN ('pending', 'running', 'awaiting_user')
      `).run(now, run.tenant_id, run.workspace_id, run.session_id);
    }

    return interrupted.map(run => ({
      id: run.id,
      tenantId: run.tenant_id,
      workspaceId: run.workspace_id,
      sessionId: run.session_id,
      previousStatus: run.status,
    }));
  }).immediate();
}
