// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type Database from 'better-sqlite3';

import type { RequestContext } from '../middleware/auth';
import { stableStringify } from '../utils/stableJson';
import { recordEnterpriseAuditEvent } from './enterpriseAuditService';
import { openEnterpriseDb } from './enterpriseDb';
import { resolveEnterpriseDataRoot } from './traceMetadataStore';

const DELETE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_TENANT_SEGMENT_RE = /^[a-zA-Z0-9._:-]+$/;
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'awaiting_user'];
const ACTIVE_LEASE_STATES = ['pending', 'starting', 'active', 'draining', 'restarting'];

export type TenantTombstoneStatus = 'tombstoned' | 'purging' | 'purge_blocked' | 'purged';

export interface TenantTombstoneRecord {
  tenantId: string;
  requestedBy: string | null;
  requestedAt: number;
  purgeAfter: number;
  status: TenantTombstoneStatus;
  proofHash: string | null;
}

export interface TenantMutationDecision {
  allowed: boolean;
  httpStatus: number;
  code: string;
  status: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TenantPurgeProof {
  tenantId: string;
  requestedBy: string | null;
  purgedBy: string;
  requestedAt: number;
  purgeAfter: number;
  purgedAt: number;
  deletedCounts: Record<string, number>;
  dataPath: string;
  dataPathRemoved: boolean;
  proofHash: string;
}

interface TenantTombstoneRow {
  tenant_id: string;
  requested_by: string | null;
  requested_at: number;
  purge_after: number;
  status: TenantTombstoneStatus;
  proof_hash: string | null;
}

interface BlockerRow {
  id: string;
  kind: 'analysis_run' | 'trace_processor_lease';
  status: string;
  workspace_id: string;
}

export class TenantPurgeBlockedError extends Error {
  constructor(readonly blockers: BlockerRow[]) {
    super('Tenant purge is blocked by active work');
    this.name = 'TenantPurgeBlockedError';
  }
}

export class TenantPurgeWindowError extends Error {
  constructor(readonly purgeAfter: number) {
    super('Tenant purge window has not elapsed');
    this.name = 'TenantPurgeWindowError';
  }
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertSafeTenantId(tenantId: string): string {
  if (!SAFE_TENANT_SEGMENT_RE.test(tenantId) || tenantId === '.' || tenantId === '..') {
    throw new Error(`Unsafe tenant id: ${tenantId}`);
  }
  return tenantId;
}

function rowToRecord(row: TenantTombstoneRow): TenantTombstoneRecord {
  return {
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    purgeAfter: row.purge_after,
    status: row.status,
    proofHash: row.proof_hash,
  };
}

function getTenantTombstoneRow(
  db: Database.Database,
  tenantId: string,
): TenantTombstoneRow | null {
  return db.prepare<unknown[], TenantTombstoneRow>(`
    SELECT *
    FROM tenant_tombstones
    WHERE tenant_id = ?
    LIMIT 1
  `).get(tenantId) ?? null;
}

export function getTenantTombstone(
  db: Database.Database,
  tenantId: string,
): TenantTombstoneRecord | null {
  const row = getTenantTombstoneRow(db, tenantId);
  return row ? rowToRecord(row) : null;
}

function ensureTenantLifecycleGraph(db: Database.Database, context: RequestContext, now: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(context.tenantId, context.tenantId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    context.userId,
    context.tenantId,
    `${context.userId}@tenant.local`,
    context.userId,
    `tenant:${context.tenantId}:${context.userId}`,
    now,
    now,
  );
}

export function createTenantTombstone(
  db: Database.Database,
  context: RequestContext,
  reason?: string,
  now = Date.now(),
): TenantTombstoneRecord {
  assertSafeTenantId(context.tenantId);
  const purgeAfter = now + DELETE_WINDOW_MS;
  const tx = db.transaction(() => {
    ensureTenantLifecycleGraph(db, context, now);
    db.prepare(`
      INSERT INTO tenant_tombstones
        (tenant_id, requested_by, requested_at, purge_after, status, proof_hash)
      VALUES
        (?, ?, ?, ?, 'tombstoned', NULL)
      ON CONFLICT(tenant_id) DO UPDATE SET
        requested_by = excluded.requested_by,
        requested_at = excluded.requested_at,
        purge_after = excluded.purge_after,
        status = excluded.status,
        proof_hash = NULL
    `).run(context.tenantId, context.userId, now, purgeAfter);
    db.prepare(`
      UPDATE organizations
      SET status = 'tombstoned', updated_at = ?
      WHERE id = ?
    `).run(now, context.tenantId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: 'tenant.tombstoned',
      resourceType: 'tenant',
      resourceId: context.tenantId,
      metadata: {
        purgeAfter,
        reason: reason || undefined,
        requestId: context.requestId,
      },
    });
  });
  tx();
  return rowToRecord(getTenantTombstoneRow(db, context.tenantId)!);
}

export function evaluateTenantMutationPolicy(context: RequestContext): TenantMutationDecision {
  const db = openEnterpriseDb();
  try {
    const tombstone = getTenantTombstoneRow(db, context.tenantId);
    if (!tombstone) {
      return {
        allowed: true,
        httpStatus: 200,
        code: 'TENANT_ACTIVE',
        status: 'active',
        message: 'Tenant accepts new work',
      };
    }
    return {
      allowed: false,
      httpStatus: 423,
      code: 'TENANT_TOMBSTONED',
      status: tombstone.status,
      message: 'Tenant is tombstoned and does not accept new uploads or analysis runs',
      details: {
        tenantId: context.tenantId,
        requestedAt: tombstone.requested_at,
        purgeAfter: tombstone.purge_after,
        proofHash: tombstone.proof_hash,
      },
    };
  } finally {
    db.close();
  }
}

export function sendTenantMutationDeniedPayload(decision: TenantMutationDecision): Record<string, unknown> {
  return {
    success: false,
    code: decision.code,
    status: decision.status,
    error: decision.message,
    details: decision.details,
  };
}

function getPurgeBlockers(db: Database.Database, tenantId: string): BlockerRow[] {
  const activeRuns = db.prepare<unknown[], BlockerRow>(`
    SELECT id, 'analysis_run' AS kind, status, workspace_id
    FROM analysis_runs
    WHERE tenant_id = ?
      AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(', ')})
    ORDER BY workspace_id ASC, id ASC
  `).all(tenantId, ...ACTIVE_RUN_STATUSES);
  const activeLeases = db.prepare<unknown[], BlockerRow>(`
    SELECT id, 'trace_processor_lease' AS kind, state AS status, workspace_id
    FROM trace_processor_leases
    WHERE tenant_id = ?
      AND state IN (${ACTIVE_LEASE_STATES.map(() => '?').join(', ')})
    ORDER BY workspace_id ASC, id ASC
  `).all(tenantId, ...ACTIVE_LEASE_STATES);
  return [...activeRuns, ...activeLeases];
}

function countRows(db: Database.Database, table: string, tenantId: string): number {
  const row = db.prepare<unknown[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM ${table}
    WHERE tenant_id = ?
  `).get(tenantId);
  return row?.count ?? 0;
}

function collectDeletedCounts(db: Database.Database, tenantId: string): Record<string, number> {
  const holderCount = db.prepare<unknown[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM trace_processor_holders h
    JOIN trace_processor_leases l ON l.id = h.lease_id
    WHERE l.tenant_id = ?
  `).get(tenantId)?.count ?? 0;
  return {
    workspaces: countRows(db, 'workspaces', tenantId),
    users: countRows(db, 'users', tenantId),
    apiKeys: countRows(db, 'api_keys', tenantId),
    traceAssets: countRows(db, 'trace_assets', tenantId),
    traceProcessorLeases: countRows(db, 'trace_processor_leases', tenantId),
    traceProcessorHolders: holderCount,
    analysisSessions: countRows(db, 'analysis_sessions', tenantId),
    analysisRuns: countRows(db, 'analysis_runs', tenantId),
    conversationTurns: countRows(db, 'conversation_turns', tenantId),
    reportArtifacts: countRows(db, 'report_artifacts', tenantId),
    memoryEntries: countRows(db, 'memory_entries', tenantId),
    skillRegistryEntries: countRows(db, 'skill_registry_entries', tenantId),
    providerCredentials: countRows(db, 'provider_credentials', tenantId),
    providerSnapshots: countRows(db, 'provider_snapshots', tenantId),
  };
}

function tenantDataPath(tenantId: string): string {
  const safeTenantId = assertSafeTenantId(tenantId);
  const root = path.resolve(resolveEnterpriseDataRoot());
  const target = path.resolve(root, safeTenantId);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Resolved tenant data path escapes data root: ${target}`);
  }
  return target;
}

async function removeTenantDataPath(tenantId: string): Promise<{ path: string; removed: boolean }> {
  const target = tenantDataPath(tenantId);
  await fs.rm(target, { recursive: true, force: true });
  return { path: target, removed: true };
}

export async function purgeTenantNow(
  db: Database.Database,
  context: RequestContext,
  now = Date.now(),
): Promise<TenantPurgeProof> {
  assertSafeTenantId(context.tenantId);
  const tombstone = getTenantTombstoneRow(db, context.tenantId);
  if (!tombstone || tombstone.status === 'purged') {
    throw new Error('Tenant tombstone not found');
  }
  if (tombstone.purge_after > now) {
    throw new TenantPurgeWindowError(tombstone.purge_after);
  }

  const blockers = getPurgeBlockers(db, context.tenantId);
  if (blockers.length > 0) {
    db.prepare(`
      UPDATE tenant_tombstones
      SET status = 'purge_blocked'
      WHERE tenant_id = ?
    `).run(context.tenantId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      action: 'tenant.purge_blocked',
      resourceType: 'tenant',
      resourceId: context.tenantId,
      metadata: {
        blockers,
        requestId: context.requestId,
      },
    });
    throw new TenantPurgeBlockedError(blockers);
  }

  const deletedCounts = collectDeletedCounts(db, context.tenantId);
  db.prepare(`
    UPDATE tenant_tombstones
    SET status = 'purging'
    WHERE tenant_id = ?
  `).run(context.tenantId);
  const dataRemoval = await removeTenantDataPath(context.tenantId);
  const proofWithoutHash = {
    tenantId: context.tenantId,
    requestedBy: tombstone.requested_by,
    purgedBy: context.userId,
    requestedAt: tombstone.requested_at,
    purgeAfter: tombstone.purge_after,
    purgedAt: now,
    deletedCounts,
    dataPath: dataRemoval.path,
    dataPathRemoved: dataRemoval.removed,
  };
  const proofHash = sha256(stableStringify(proofWithoutHash));
  const proof: TenantPurgeProof = {
    ...proofWithoutHash,
    proofHash,
  };

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rag_knowledge_fts WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM provider_snapshots WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM provider_credentials WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM api_keys WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM memory_entries WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM skill_registry_entries WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM workspaces WHERE tenant_id = ?').run(context.tenantId);
    db.prepare('DELETE FROM users WHERE tenant_id = ?').run(context.tenantId);
    db.prepare(`
      UPDATE organizations
      SET status = 'purged', updated_at = ?
      WHERE id = ?
    `).run(now, context.tenantId);
    db.prepare(`
      UPDATE tenant_tombstones
      SET status = 'purged', proof_hash = ?
      WHERE tenant_id = ?
    `).run(proofHash, context.tenantId);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      action: 'tenant.purged',
      resourceType: 'tenant',
      resourceId: context.tenantId,
      metadata: {
        proof,
        requestId: context.requestId,
      },
    });
  });
  tx();
  return proof;
}
