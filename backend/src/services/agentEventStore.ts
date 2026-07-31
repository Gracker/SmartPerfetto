// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { openEnterpriseDb, resolveEnterpriseDbPath } from './enterpriseDb';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';

export interface AgentEventPersistenceScope extends EnterpriseRepositoryScope {
  sessionId: string;
  runId: string;
  traceId: string;
  query?: string;
}

export interface SerializedAgentEvent {
  cursor: number;
  eventType: string;
  eventData: string;
  createdAt: number;
}

interface AgentEventRow extends Record<string, unknown> {
  cursor: number;
  event_type: string;
  payload_json: string;
  created_at: number;
}

let singletonDb: Database.Database | null = null;
let singletonDbPath: string | null = null;

function getAgentEventDb(): Database.Database {
  const dbPath = resolveEnterpriseDbPath();
  if (!singletonDb || singletonDbPath !== dbPath) {
    singletonDb?.close();
    singletonDb = openEnterpriseDb(dbPath);
    singletonDbPath = dbPath;
  }
  return singletonDb;
}

export function resetAgentEventStoreForTests(): void {
  singletonDb?.close();
  singletonDb = null;
  singletonDbPath = null;
}

function ensureAgentEventGraph(
  db: Database.Database,
  scope: AgentEventPersistenceScope,
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
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run(
      scope.userId,
      scope.tenantId,
      `${scope.userId}@agent-event.local`,
      scope.userId,
      `agent-event:${scope.userId}`,
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
    JSON.stringify({ source: 'agent_event', sessionId: scope.sessionId, runId: scope.runId }),
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

  db.prepare(`
    INSERT OR IGNORE INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
    VALUES
      (?, ?, ?, ?, 'agent', 'running', ?, ?, NULL)
  `).run(
    scope.runId,
    scope.tenantId,
    scope.workspaceId,
    scope.sessionId,
    scope.query ?? '',
    now,
  );
}

function terminalStatusForEvent(eventType: string, eventData?: string): 'completed' | 'failed' | 'cancelled' | 'quota_exceeded' | null {
  if (eventType === 'analysis_completed') {
    try {
      const parsed = JSON.parse(eventData || '{}');
      const status = parsed?.data?.terminalRunStatus ?? parsed?.terminalRunStatus;
      if (status === 'quota_exceeded') return 'quota_exceeded';
    } catch {
      // Fall through to the historical completed mapping for old event payloads.
    }
    return 'completed';
  }
  if (eventType === 'analysis_cancelled') return 'cancelled';
  if (eventType === 'error') return 'failed';
  return null;
}

export function persistSerializedAgentEvent(
  scope: AgentEventPersistenceScope,
  event: SerializedAgentEvent,
  options: { updateSessionStatus?: boolean } = {},
): void {
  const updateSessionStatus = options.updateSessionStatus !== false;
  const db = getAgentEventDb();
  const write = db.transaction(() => {
    ensureAgentEventGraph(db, scope, event.createdAt);
    db.prepare(`
      INSERT OR IGNORE INTO agent_events
        (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      scope.tenantId,
      scope.workspaceId,
      scope.runId,
      event.cursor,
      event.eventType,
      event.eventData,
      event.createdAt,
    );

    const terminalStatus = terminalStatusForEvent(event.eventType, event.eventData);
    if (terminalStatus) {
      db.prepare(`
        UPDATE analysis_runs
        SET status = ?,
            completed_at = COALESCE(completed_at, ?),
            heartbeat_at = ?,
            updated_at = ?
        WHERE tenant_id = ? AND workspace_id = ? AND id = ?
      `).run(
        terminalStatus,
        event.createdAt,
        event.createdAt,
        event.createdAt,
        scope.tenantId,
        scope.workspaceId,
        scope.runId,
      );
      if (updateSessionStatus) {
        db.prepare(`
          UPDATE analysis_sessions
          SET status = ?, updated_at = ?
          WHERE tenant_id = ? AND workspace_id = ? AND id = ?
        `).run(terminalStatus, event.createdAt, scope.tenantId, scope.workspaceId, scope.sessionId);
      } else {
        db.prepare(`
          UPDATE analysis_sessions
          SET updated_at = ?
          WHERE tenant_id = ? AND workspace_id = ? AND id = ?
        `).run(event.createdAt, scope.tenantId, scope.workspaceId, scope.sessionId);
      }
    } else {
      db.prepare(`
        UPDATE analysis_runs
        SET heartbeat_at = ?, updated_at = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND id = ?
          AND status IN ('pending', 'running', 'awaiting_user')
      `).run(event.createdAt, event.createdAt, scope.tenantId, scope.workspaceId, scope.runId);
      db.prepare(`
        UPDATE analysis_sessions
        SET updated_at = ?
        WHERE tenant_id = ? AND workspace_id = ? AND id = ?
      `).run(event.createdAt, scope.tenantId, scope.workspaceId, scope.sessionId);
    }
  });
  write();
}

export function listSerializedAgentEventsAfter(
  scope: EnterpriseRepositoryScope,
  runId: string,
  cursor: number,
  limit = 1000,
): SerializedAgentEvent[] {
  const db = getAgentEventDb();
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = db.prepare<unknown[], AgentEventRow>(`
    SELECT cursor, event_type, payload_json, created_at
    FROM agent_events
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND run_id = ?
      AND cursor > ?
    ORDER BY cursor ASC
    LIMIT ?
  `).all(scope.tenantId, scope.workspaceId, runId, cursor, boundedLimit);
  return rows.map(row => ({
    cursor: row.cursor,
    eventType: row.event_type,
    eventData: row.payload_json,
    createdAt: row.created_at,
  }));
}

export function getLatestSerializedAgentEventByType(
  scope: EnterpriseRepositoryScope,
  runId: string,
  eventType: string,
): SerializedAgentEvent | null {
  const normalizedRunId = runId.trim();
  const normalizedEventType = eventType.trim();
  if (!normalizedRunId || !normalizedEventType) return null;

  const row = getAgentEventDb().prepare<unknown[], AgentEventRow>(`
    SELECT cursor, event_type, payload_json, created_at
    FROM agent_events
    WHERE tenant_id = ?
      AND workspace_id = ?
      AND run_id = ?
      AND event_type = ?
    ORDER BY cursor DESC
    LIMIT 1
  `).get(
    scope.tenantId,
    scope.workspaceId,
    normalizedRunId,
    normalizedEventType,
  );
  return row
    ? {
        cursor: row.cursor,
        eventType: row.event_type,
        eventData: row.payload_json,
        createdAt: row.created_at,
      }
    : null;
}
