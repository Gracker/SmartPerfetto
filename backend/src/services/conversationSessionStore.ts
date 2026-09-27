// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import type {AgentRuntimeKind} from './providerManager';
import {isProductionAgentRuntimeKind} from '../agentRuntime/runtimeKinds';
import type {AssistantSessionStatus} from '../assistant/application/assistantApplicationService';
import type {ConversationRuntimeOutcome, ConversationTraceContext} from '../assistant/contracts/conversationContract';
import type {AnalysisHistoryTurn} from '../agentRuntime/analysisHistory';
import {AnalysisHistoryStore, type AnalysisHistoryScope} from './analysisHistoryStore';
import {openEnterpriseDb, resolveEnterpriseDbPath} from './enterpriseDb';

const RUNTIME_TYPE = 'conversation-logical-session@1';
type WithoutRuntimeResult<T> = T extends unknown ? Omit<T, 'finalResult' | 'recoveryStatus'> : never;
export type ConversationSessionOwner = {tenantId: string; workspaceId: string; userId: string};

/** Serializable product state only. No SDK history, credentials, or execution witness. */
export interface ConversationSessionDescriptor extends ConversationSessionOwner {
  version: 1;
  sessionId: string;
  traceContext: ConversationTraceContext;
  providerId: string | null;
  providerFollowsActive: boolean;
  runtimeKind: AgentRuntimeKind;
  providerSnapshotHash: string;
  analysisContextFingerprint: string;
  outputLanguage?: AnalysisOptions['outputLanguage'];
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  status: AssistantSessionStatus;
  createdAt: number;
  lastActivityAt: number;
  lastRun: {runId: string; query: string; turnIndex: number; startedAt: number;
    completedAt?: number; status: 'running' | 'completed' | 'cancelled' | 'failed'; sourceDerived?: boolean};
  /** Control data is already projected for the authenticated owner. */
  lastOutcome?: WithoutRuntimeResult<ConversationRuntimeOutcome>;
}

function snapshotId(scope: ConversationSessionOwner & {sessionId: string}): string {
  return `conversation:${createHash('sha256').update(JSON.stringify([
    scope.tenantId, scope.workspaceId, scope.userId, scope.sessionId,
  ])).digest('hex')}`;
}

export function conversationHistoryScope(descriptor: ConversationSessionDescriptor): AnalysisHistoryScope {
  return {tenantId: descriptor.tenantId, workspaceId: descriptor.workspaceId, userId: descriptor.userId,
    sessionId: descriptor.sessionId, runId: descriptor.lastRun.runId,
    traceId: descriptor.traceContext.kind === 'attached' ? descriptor.traceContext.traceId
      : `conversation-no-trace:${descriptor.sessionId}`};
}

function projectedDescriptor(input: ConversationSessionDescriptor): ConversationSessionDescriptor {
  const outcome = input.lastOutcome as ConversationRuntimeOutcome | undefined;
  const lastOutcome: ConversationRuntimeOutcome | undefined = outcome ? {kind: outcome.kind,
    message: outcome.message, ...(outcome.evidence ? {evidence: outcome.evidence.map(({id, label, source}) => ({id, label, source}))} : {}),
    ...(outcome.kind === 'needs_user_input' ? {question: outcome.question} : {}),
    ...(outcome.kind === 'recommend_full' ? {handoff: {question: outcome.handoff.question, scope: outcome.handoff.scope,
      assumptions: [...outcome.handoff.assumptions], evidence: outcome.handoff.evidence.map(({id, label, source}) => ({id, label, source}))}} : {}),
  } as ConversationRuntimeOutcome : undefined;
  return {version: 1, sessionId: input.sessionId, tenantId: input.tenantId, workspaceId: input.workspaceId,
    userId: input.userId, providerId: input.providerId, providerFollowsActive: input.providerFollowsActive,
    runtimeKind: input.runtimeKind, providerSnapshotHash: input.providerSnapshotHash,
    analysisContextFingerprint: input.analysisContextFingerprint,
    traceContext: input.traceContext.kind === 'attached' ? {kind: 'attached', traceId: input.traceContext.traceId} : {kind: 'none'},
    outputLanguage: input.outputLanguage, codeAwareMode: input.codeAwareMode,
    codebaseIds: input.codebaseIds ? [...input.codebaseIds] : undefined,
    knowledgeSourceIds: input.knowledgeSourceIds ? [...input.knowledgeSourceIds] : undefined,
    status: input.status, createdAt: input.createdAt, lastActivityAt: input.lastActivityAt,
    lastRun: {runId: input.lastRun.runId, query: input.lastRun.query, turnIndex: input.lastRun.turnIndex,
      startedAt: input.lastRun.startedAt, completedAt: input.lastRun.completedAt, status: input.lastRun.status,
      sourceDerived: input.lastRun.sourceDerived}, ...(lastOutcome ? {lastOutcome} : {}),
  };
}

/** Single descriptor row plus append-only finalized turns in the existing enterprise graph. */
export class ConversationSessionStore {
  private readonly db: Database.Database;
  private readonly history: AnalysisHistoryStore;
  private readonly ownsDb: boolean;

  constructor(db?: Database.Database) {
    this.ownsDb = !db;
    this.db = db ?? openEnterpriseDb();
    this.history = new AnalysisHistoryStore(this.db);
  }

  load(owner: ConversationSessionOwner, sessionId: string): ConversationSessionDescriptor | undefined {
    const row = this.db.prepare(`SELECT snapshot.snapshot_json FROM runtime_snapshots snapshot
      JOIN analysis_sessions session ON session.id = snapshot.session_id
        AND session.tenant_id = snapshot.tenant_id AND session.workspace_id = snapshot.workspace_id
      WHERE snapshot.id = ? AND snapshot.runtime_type = ? AND snapshot.tenant_id = ?
        AND snapshot.workspace_id = ? AND snapshot.session_id = ? AND session.created_by = ?`).get(
      snapshotId({...owner, sessionId}), RUNTIME_TYPE, owner.tenantId, owner.workspaceId, sessionId, owner.userId,
    ) as {snapshot_json: string} | undefined;
    if (!row) return undefined;
    const parsed: ConversationSessionDescriptor = JSON.parse(row.snapshot_json);
    if (parsed.version !== 1 || parsed.sessionId !== sessionId || parsed.userId !== owner.userId ||
      parsed.tenantId !== owner.tenantId || parsed.workspaceId !== owner.workspaceId ||
      !parsed.lastRun?.runId || !Number.isSafeInteger(parsed.lastRun.turnIndex) || parsed.lastRun.turnIndex < 0 ||
      !Number.isFinite(parsed.lastRun.startedAt) || !parsed.providerSnapshotHash || !isProductionAgentRuntimeKind(parsed.runtimeKind) ||
      (parsed.providerId !== null && typeof parsed.providerId !== 'string') ||
      !parsed.analysisContextFingerprint || !['none', 'attached'].includes(parsed.traceContext?.kind)) {
      throw new Error('conversation_recovery_descriptor_invalid');
    }
    return projectedDescriptor(parsed);
  }

  listTurns(descriptor: ConversationSessionDescriptor): AnalysisHistoryTurn[] {
    return this.history.list(conversationHistoryScope(descriptor));
  }

  save(input: ConversationSessionDescriptor, finalizedTurn?: AnalysisHistoryTurn): void {
    const descriptor = projectedDescriptor(input);
    const scope = conversationHistoryScope(descriptor);
    // Reads the owner and previous descriptor before writing: IMMEDIATE (see openEnterpriseDb).
    this.db.transaction(() => {
      const owner = this.db.prepare(`SELECT id FROM analysis_sessions WHERE id = ? AND tenant_id = ?
        AND workspace_id = ? AND created_by = ? AND trace_id = ?`).get(scope.sessionId,
      scope.tenantId, scope.workspaceId, scope.userId, scope.traceId);
      if (!owner) throw new Error('conversation_recovery_owner_unavailable');
      const previous = this.load(descriptor, descriptor.sessionId);
      if (previous && (previous.lastRun.turnIndex > descriptor.lastRun.turnIndex ||
        (previous.lastRun.runId === descriptor.lastRun.runId && previous.lastRun.status !== 'running' && descriptor.lastRun.status === 'running') ||
        (finalizedTurn && descriptor.lastRun.status !== 'running' && previous.lastRun.runId !== descriptor.lastRun.runId))) {
        throw new Error('conversation_recovery_stale_run');
      }
      // One terminal write per run: a turn that already settled is never rewritten.
      if (previous && finalizedTurn && descriptor.lastRun.status !== 'running' &&
        previous.lastRun.runId === descriptor.lastRun.runId && previous.lastRun.status !== 'running') {
        throw new Error('conversation_recovery_turn_already_terminal');
      }
      if (finalizedTurn) {
        if (finalizedTurn.id !== descriptor.lastRun.runId || finalizedTurn.turnIndex !== descriptor.lastRun.turnIndex) {
          throw new Error('conversation_recovery_turn_identity_mismatch');
        }
        this.history.append(scope, finalizedTurn);
      }
      this.db.prepare(`INSERT INTO runtime_snapshots
        (id, tenant_id, workspace_id, session_id, run_id, runtime_type, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, snapshot_json = excluded.snapshot_json,
          created_at = excluded.created_at`).run(snapshotId(descriptor), descriptor.tenantId,
        descriptor.workspaceId, descriptor.sessionId, descriptor.lastRun.runId, RUNTIME_TYPE,
        JSON.stringify(descriptor), descriptor.lastActivityAt);
    }).immediate();
  }

  close(): void { if (this.ownsDb) this.db.close(); }
}

let singleton: {path: string; store: ConversationSessionStore} | undefined;
export function getConversationSessionStore(): ConversationSessionStore {
  const path = resolveEnterpriseDbPath();
  if (!singleton || singleton.path !== path) {
    singleton?.store.close();
    singleton = {path, store: new ConversationSessionStore()};
  }
  return singleton.store;
}
export function resetConversationSessionStoreForTests(): void {
  singleton?.store.close();
  singleton = undefined;
}
