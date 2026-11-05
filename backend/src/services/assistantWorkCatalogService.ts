// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type {AssistantWorkCatalogResponse, AssistantWorkItem, AssistantWorkSummary} from '../assistant/contracts/assistantWorkContract';
import {projectAssistantWork, withAssistantWorkResult} from '../assistant/application/assistantWorkProjection';
import {CONVERSATION_SNAPSHOT_RUNTIME_TYPE, ConversationSessionStore, type ConversationSessionOwner, type ConversationSessionDescriptor} from './conversationSessionStore';
import {enterpriseDbReadAuthorityEnabled} from './enterpriseMigration';
import {parseStoredJson} from '../utils/storedData';
import {PublicRequestError} from '../utils/publicRequestError';

export class AssistantWorkCatalogRequestError extends PublicRequestError {}
export interface AssistantWorkCursor {startedAt: number; runId: string}
export interface AssistantWorkCatalogQuery {
  filter: 'recent' | 'needs_input';
  limit: number;
  cursor?: AssistantWorkCursor;
}
export type AssistantWorkLiveReader = (
  owner: ConversationSessionOwner, sessionId: string, runId?: string,
) => AssistantWorkSummary | undefined;
interface WorkRow {id: string; session_id: string; mode: string; status: string; started_at: number;
  completed_at: number | null; error_json: string | null}
interface WorkGroup {session_id: string; started_at: number; anchor_id: string; candidate_count: number; conversation_count: number}

export function parseAssistantWorkCatalogQuery(query: Record<string, unknown>): AssistantWorkCatalogQuery {
  const filter = query.filter ?? 'recent';
  const limit = query.limit === undefined ? 20 : typeof query.limit === 'string' && /^\d+$/.test(query.limit)
    ? Number(query.limit) : NaN;
  if ((filter !== 'recent' && filter !== 'needs_input') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AssistantWorkCatalogRequestError('WORK_CATALOG_QUERY_INVALID', 'Invalid work catalog filter or limit');
  }
  let cursor: AssistantWorkCursor | undefined;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const raw: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const value = raw as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'runId,startedAt' || !Number.isSafeInteger(value.startedAt) ||
        (value.startedAt as number) < 0 || typeof value.runId !== 'string' || !value.runId || value.runId.length > 256) throw new Error();
      cursor = {startedAt: value.startedAt as number, runId: value.runId};
    } catch { throw new AssistantWorkCatalogRequestError('WORK_CATALOG_CURSOR_INVALID', 'Invalid work catalog cursor'); }
  }
  return {filter, limit, ...(cursor ? {cursor} : {})};
}

function startupInterrupted(errorJson: string | null): boolean {
  if (!errorJson) return false;
  try {
    const value = parseStoredJson<unknown>(errorJson, 'work recovery metadata');
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).source === 'backend_startup_recovery');
  } catch { return false; }
}

/** Reads existing product records. Listing never restores a runtime or extends its lifetime. */
export class AssistantWorkCatalogService {
  constructor(private readonly db: Database.Database, private readonly options: {
    readLiveWork?: AssistantWorkLiveReader;
    canReadSnapshots?: boolean;
    canReadReports?: boolean;
    now?: () => number;
    reportReadAuthority?: () => boolean;
    isReportFile?: (path: string) => boolean;
  } = {}) {}

  list(owner: ConversationSessionOwner, query: AssistantWorkCatalogQuery): AssistantWorkCatalogResponse {
    // Millisecond timestamps can tie. MAX(id) is a pagination anchor only,
    // never an admission order. Keep the entire latest candidate group together.
    const rows = this.db.prepare<unknown[], WorkGroup>(`
      WITH owned_runs AS (
        SELECT r.id, r.session_id, r.mode, r.status, r.started_at,
          MAX(r.started_at) OVER (PARTITION BY r.session_id) AS latest_started_at
        FROM analysis_runs r JOIN analysis_sessions s ON s.id = r.session_id
          AND s.tenant_id = r.tenant_id AND s.workspace_id = r.workspace_id
        WHERE r.tenant_id = ? AND r.workspace_id = ? AND s.created_by = ?
      ), latest_groups AS (
        SELECT r.session_id, r.started_at, MAX(r.id) AS anchor_id, COUNT(*) AS candidate_count,
          SUM(CASE WHEN r.mode = 'conversation' THEN 1 ELSE 0 END) AS conversation_count
        FROM owned_runs r WHERE r.started_at = r.latest_started_at
        GROUP BY r.session_id, r.started_at
        HAVING ? = 'recent' OR MAX(CASE WHEN r.status = 'awaiting_user' OR
          (r.mode = 'conversation' AND EXISTS (
            SELECT 1 FROM runtime_snapshots snapshot WHERE snapshot.tenant_id = ? AND snapshot.workspace_id = ?
              AND snapshot.session_id = r.session_id AND snapshot.run_id = r.id AND snapshot.runtime_type = ?
              AND CASE WHEN json_valid(snapshot.snapshot_json) THEN
                json_extract(snapshot.snapshot_json, '$.lastRun.runId') = r.id AND
                json_extract(snapshot.snapshot_json, '$.lastOutcome.kind') IN ('needs_user_input', 'recommend_full')
                ELSE 0 END
          )) THEN 1 ELSE 0 END) = 1
      )
      SELECT * FROM latest_groups WHERE (? IS NULL OR started_at < ? OR (started_at = ? AND anchor_id < ?))
      ORDER BY started_at DESC, anchor_id DESC LIMIT ?
    `).all(owner.tenantId, owner.workspaceId, owner.userId, query.filter,
      owner.tenantId, owner.workspaceId, CONVERSATION_SNAPSHOT_RUNTIME_TYPE,
      query.cursor?.startedAt ?? null, query.cursor?.startedAt ?? null,
      query.cursor?.startedAt ?? null, query.cursor?.runId ?? null, query.limit + 1);
    const scanned = rows.slice(0, query.limit);
    const items = scanned.map(group => this.resolveGroup(owner, group)).filter(item =>
      query.filter === 'recent' || item.work.phase === 'needs_input' || item.metadata === 'unavailable');
    const last = scanned[scanned.length - 1];
    return {success: true, filter: query.filter, items,
      ...(rows.length > query.limit && last ? {nextCursor: Buffer.from(JSON.stringify({
        startedAt: last.started_at, runId: last.anchor_id})).toString('base64url')} : {})};
  }

  private candidate(owner: ConversationSessionOwner, group: WorkGroup, runId: string): WorkRow | undefined {
    return this.db.prepare<unknown[], WorkRow>(`
      SELECT r.id, r.session_id, r.mode, r.status, r.started_at, r.completed_at, r.error_json
      FROM analysis_runs r JOIN analysis_sessions s ON s.id = r.session_id
        AND s.tenant_id = r.tenant_id AND s.workspace_id = r.workspace_id
      WHERE r.tenant_id = ? AND r.workspace_id = ? AND s.created_by = ?
        AND r.session_id = ? AND r.started_at = ? AND r.id = ?
    `).get(owner.tenantId, owner.workspaceId, owner.userId, group.session_id, group.started_at, runId);
  }

  private resolveGroup(owner: ConversationSessionOwner, group: WorkGroup): AssistantWorkItem {
    if (group.candidate_count === 1) {
      const row = this.candidate(owner, group, group.anchor_id);
      if (row) return this.project(owner, row);
    } else {
      const live = this.options.readLiveWork?.(owner, group.session_id);
      const liveId = live?.sessionId === group.session_id ? live.runId : undefined;
      const liveRow = liveId ? this.candidate(owner, group, liveId) : undefined;
      let descriptor: ConversationSessionDescriptor | undefined;
      try {descriptor = new ConversationSessionStore(this.db).load(owner, group.session_id);} catch { /* One unreadable row. */ }
      const descriptorId = descriptor?.lastRun.runId;
      const recordedRow = descriptorId ? this.candidate(owner, group, descriptorId) : undefined;
      const descriptorRow = recordedRow?.mode === 'conversation' ? recordedRow : undefined;
      // A present pointer outside this candidate group is conflicting evidence,
      // not permission to fall back to another, older pointer.
      const conflict = (liveId && !liveRow) || (descriptorId && !descriptorRow) ||
        (liveId && descriptorId && liveId !== descriptorId);
      const selected = conflict ? undefined : liveRow ?? descriptorRow;
      if (selected) return this.project(owner, selected);
    }
    return {surface: group.conversation_count === group.candidate_count ? 'conversation' : 'analysis',
      metadata: 'unavailable', metadataReason: 'latest_run_ambiguous',
      work: projectAssistantWork({sessionId: group.session_id, status: 'unknown', live: false,
        startedAt: group.started_at, hasResult: false})};
  }

  private project(owner: ConversationSessionOwner, row: WorkRow): AssistantWorkItem {
    const surface = row.mode === 'conversation' ? 'conversation' : 'analysis';
    let metadata: AssistantWorkItem['metadata'] = 'available';
    let outcomeKind: string | undefined;
    let hasResult = false;
    if (surface === 'conversation') {
      try {
        const descriptor = new ConversationSessionStore(this.db).load(owner, row.session_id);
        if (!descriptor || descriptor.lastRun.runId !== row.id) metadata = 'unavailable';
        else {
          outcomeKind = descriptor.lastOutcome?.kind;
          hasResult = Boolean(descriptor.lastOutcome?.message?.trim());
        }
      } catch { metadata = 'unavailable'; }
    }
    const now = (this.options.now ?? Date.now)();
    const result = surface === 'analysis' && this.options.canReadSnapshots ? this.db.prepare<unknown[], {id: string}>(`
      SELECT id FROM analysis_result_snapshots WHERE tenant_id = ? AND workspace_id = ? AND created_by = ?
        AND session_id = ? AND run_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(owner.tenantId, owner.workspaceId, owner.userId, row.session_id, row.id, now) : undefined;
    const reportId = this.report(owner, row, now);
    hasResult ||= Boolean(result || reportId);
    const live = this.options.readLiveWork?.(owner, row.session_id, row.id);
    const matchingLive = live?.sessionId === row.session_id && live.runId === row.id ? live : undefined;
    const projected = matchingLive ?? projectAssistantWork({sessionId: row.session_id, runId: row.id,
      status: row.status, live: false, startedAt: row.started_at,
      ...(row.completed_at === null ? {} : {completedAt: row.completed_at}),
      interrupted: startupInterrupted(row.error_json), hasResult, outcomeKind});
    const work = withAssistantWorkResult(projected, hasResult);
    return {surface, metadata, work,
      ...(result ? {result: {kind: 'snapshot', id: result.id}} : {}), ...(reportId ? {reportId} : {})};
  }

  private report(owner: ConversationSessionOwner, row: WorkRow, now: number): string | undefined {
    if (!this.options.canReadReports) return undefined;
    if (!(this.options.reportReadAuthority ?? enterpriseDbReadAuthorityEnabled)()) return undefined;
    const report = this.db.prepare<unknown[], {id: string; local_path: string}>(`
      SELECT id, local_path FROM report_artifacts WHERE tenant_id = ? AND workspace_id = ? AND created_by = ?
        AND session_id = ? AND run_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(owner.tenantId, owner.workspaceId, owner.userId, row.session_id, row.id, now);
    if (!report) return undefined;
    try {
      const exists = this.options.isReportFile?.(report.local_path) ?? fs.statSync(report.local_path).isFile();
      return exists ? report.id : undefined;
    } catch { return undefined; }
  }
}
