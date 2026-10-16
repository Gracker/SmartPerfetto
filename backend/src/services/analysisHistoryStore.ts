// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import {openEnterpriseDb, resolveEnterpriseDbPath} from './enterpriseDb';
import type {AnalysisHistoryTurn, AnalysisHistoryEvidenceLocator} from '../agentRuntime/analysisHistory';

export interface AnalysisHistoryScope {
  tenantId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  runId?: string;
}

let defaultDb: Database.Database | undefined;
let defaultPath: string | undefined;
function historyDb(): Database.Database {
  const path = resolveEnterpriseDbPath();
  if (!defaultDb || defaultPath !== path) {
    defaultDb?.close(); defaultDb = openEnterpriseDb(path); defaultPath = path;
  }
  return defaultDb;
}

/** @internal Test seam. */
export function resetAnalysisHistoryStoreForTests(): void {
  defaultDb?.close(); defaultDb = undefined; defaultPath = undefined;
}

function assertScope(scope: AnalysisHistoryScope): void {
  if (![scope.tenantId, scope.workspaceId, scope.userId, scope.sessionId, scope.traceId]
    .every(value => typeof value === 'string' && value.trim().length > 0)) throw new Error('analysis_history_scope_required');
}

export function parseAnalysisHistoryEvidenceLocator(value: unknown): AnalysisHistoryEvidenceLocator | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const ref: AnalysisHistoryEvidenceLocator = {};
  for (const key of ['artifactId', 'evidenceRefId', 'sourceToolCallId', 'traceId', 'column', 'sourceRef'] as const) {
    if (typeof candidate[key] === 'string') ref[key] = candidate[key];
  }
  if (!ref.artifactId && typeof candidate.sourceArtifactId === 'string') ref.artifactId = candidate.sourceArtifactId;
  if (typeof candidate.rowIndex === 'number' && Number.isSafeInteger(candidate.rowIndex) && candidate.rowIndex >= 0) {
    ref.rowIndex = candidate.rowIndex;
  }
  const selector = candidate.rowSelector;
  if (selector && typeof selector === 'object' && !Array.isArray(selector) && Object.values(selector).every(item =>
    typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)))) {
    ref.rowSelector = {...selector} as Record<string, string | number | boolean>;
  }
  return ref.artifactId || ref.evidenceRefId || ref.sourceToolCallId || ref.sourceRef ? ref : undefined;
}

export function parseAnalysisHistoryTurn(value: unknown): AnalysisHistoryTurn | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const turn = value as AnalysisHistoryTurn;
  const valid = typeof turn.id === 'string' && turn.id.length > 0 && turn.id.length <= 200 &&
    Number.isSafeInteger(turn.turnIndex) && turn.turnIndex >= 0 && Number.isFinite(turn.timestamp) &&
    typeof turn.query === 'string' && typeof turn.answer === 'string' && typeof turn.traceId === 'string' &&
    typeof turn.partial === 'boolean' && ['completed', 'incomplete', 'unknown'].includes(turn.completionStatus) &&
    [turn.uncertainties, turn.nextSteps].every(items => Array.isArray(items) && items.every(item => typeof item === 'string')) &&
    Array.isArray(turn.evidence);
  if (!valid) return undefined;
  const completionStatus = turn.partial && turn.completionStatus === 'completed' ? 'incomplete' : turn.completionStatus;
  return {id: turn.id, turnIndex: turn.turnIndex, timestamp: turn.timestamp, query: turn.query, answer: turn.answer,
    traceId: turn.traceId, partial: completionStatus !== 'completed', completionStatus,
    uncertainties: [...turn.uncertainties], nextSteps: [...turn.nextSteps],
    ...(typeof turn.terminationReason === 'string' ? {terminationReason: turn.terminationReason} : {}),
    ...(typeof turn.terminationMessage === 'string' ? {terminationMessage: turn.terminationMessage} : {}),
    ...(turn.sourceDerived === true ? {sourceDerived: true} : {}),
    ...(typeof turn.analysisContextFingerprint === 'string' && turn.analysisContextFingerprint.trim()
      ? {analysisContextFingerprint: turn.analysisContextFingerprint} : {}),
    evidence: turn.evidence.flatMap(value => {
      const ref = parseAnalysisHistoryEvidenceLocator(value);
      return ref ? [ref] : [];
    })};
}

/** Shares the existing enterprise graph; injected DB keeps descriptor+turn writes atomic. */
export class AnalysisHistoryStore {
  constructor(private readonly injectedDb?: Database.Database) {}

  append(scope: AnalysisHistoryScope, entry: AnalysisHistoryTurn): void {
    assertScope(scope);
    const normalized = parseAnalysisHistoryTurn(entry);
    if (!scope.runId?.trim() || !normalized || entry.traceId !== scope.traceId) {
      throw new Error('analysis_history_invalid_turn');
    }
    const db = this.injectedDb ?? historyDb();
    // Reads the parent before writing: IMMEDIATE (see openEnterpriseDb).
    db.transaction(() => {
      const parent = db.prepare(`SELECT r.id FROM analysis_runs r JOIN analysis_sessions s
        ON s.id = r.session_id AND s.tenant_id = r.tenant_id AND s.workspace_id = r.workspace_id
        WHERE r.id = ? AND s.id = ? AND s.tenant_id = ? AND s.workspace_id = ? AND s.created_by = ? AND s.trace_id = ?`)
        .get(scope.runId, scope.sessionId, scope.tenantId, scope.workspaceId, scope.userId, scope.traceId);
      if (!parent) throw new Error('analysis_history_parent_not_authorized');
      const existing = db.prepare('SELECT tenant_id, workspace_id, session_id, run_id, role FROM conversation_turns WHERE id = ?')
        .get(entry.id) as {tenant_id: string; workspace_id: string; session_id: string; run_id: string; role: string} | undefined;
      if (existing && (existing.tenant_id !== scope.tenantId || existing.workspace_id !== scope.workspaceId ||
        existing.session_id !== scope.sessionId || existing.run_id !== scope.runId || existing.role !== 'analysis_history')) {
        throw new Error('analysis_history_id_conflict');
      }
      db.prepare(`INSERT INTO conversation_turns (id,tenant_id,workspace_id,session_id,run_id,role,content_json,created_at)
        VALUES (?,?,?,?,?,'analysis_history',?,?) ON CONFLICT(id) DO UPDATE SET content_json = excluded.content_json`)
        .run(entry.id, scope.tenantId, scope.workspaceId, scope.sessionId, scope.runId,
          JSON.stringify({schemaVersion: 1, kind: 'analysis_history', turn: normalized}), entry.timestamp);
    }).immediate();
  }

  list(scope: AnalysisHistoryScope): AnalysisHistoryTurn[] {
    assertScope(scope);
    const db = this.injectedDb ?? historyDb();
    const rows = db.prepare(`SELECT t.content_json FROM conversation_turns t JOIN analysis_sessions s
      ON s.id = t.session_id AND s.tenant_id = t.tenant_id AND s.workspace_id = t.workspace_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.workspace_id = ? AND s.created_by = ? AND s.trace_id = ?
        AND t.role = 'analysis_history' ORDER BY t.created_at, t.id`)
      .all(scope.sessionId, scope.tenantId, scope.workspaceId, scope.userId, scope.traceId) as Array<{content_json: string}>;
    return rows.flatMap(row => {
      try {
        const value = JSON.parse(row.content_json);
        const turn = parseAnalysisHistoryTurn(value.turn);
        if (value.schemaVersion !== 1 || value.kind !== 'analysis_history' || !turn || turn.traceId !== scope.traceId) return [];
        return [turn];
      } catch { return []; }
    }).sort((a, b) => a.timestamp - b.timestamp || a.turnIndex - b.turnIndex);
  }
}
