// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import { uuidv4 } from '../utils/uuid';
import { openEnterpriseDb, resolveEnterpriseDbPath } from './enterpriseDb';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';

export type TraceProcessorLeaseMode = 'shared' | 'isolated';
export type TraceProcessorLeaseState =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'idle'
  | 'active'
  | 'draining'
  | 'released'
  | 'crashed'
  | 'restarting'
  | 'failed';

export type TraceProcessorHolderType =
  | 'frontend_http_rpc'
  | 'agent_run'
  | 'report_generation'
  | 'batch_trace_run'
  | 'metric_backfill'
  | 'manual_register';

export type FrontendHolderVisibility = 'visible' | 'hidden' | 'offline';

export interface TraceProcessorHolderTtlPolicy {
  heartbeatTtlMs: number;
  idleTtlMs: number;
}

export interface TraceProcessorHolderInput {
  holderType: TraceProcessorHolderType;
  holderRef: string;
  windowId?: string;
  frontendVisibility?: FrontendHolderVisibility;
  sessionId?: string;
  runId?: string;
  reportId?: string;
  metadata?: Record<string, unknown>;
}

export interface TraceProcessorLeaseRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  traceId: string;
  mode: TraceProcessorLeaseMode;
  state: TraceProcessorLeaseState;
  rssBytes: number | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
  holderCount: number;
  holders: TraceProcessorHolderRecord[];
}

export interface TraceProcessorLeaseSweepResult {
  holdersRemoved: number;
  leasesReleased: number;
  releasedLeases: Array<{
    id: string;
    tenantId: string;
    workspaceId: string;
    traceId: string;
    mode: TraceProcessorLeaseMode;
  }>;
}

export interface TraceProcessorHolderRecord {
  id: string;
  leaseId: string;
  holderType: TraceProcessorHolderType;
  holderRef: string;
  windowId: string | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  metadata: Record<string, unknown> | null;
}

interface LeaseRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  trace_id: string;
  mode: string;
  state: string;
  rss_bytes: number | null;
  heartbeat_at: number | null;
  expires_at: number | null;
}

interface HolderRow {
  id: string;
  lease_id: string;
  holder_type: string;
  holder_ref: string;
  window_id: string | null;
  heartbeat_at: number | null;
  expires_at: number | null;
  created_at: number;
  metadata_json: string | null;
}

const TERMINAL_STATES = new Set<TraceProcessorLeaseState>(['released', 'failed']);
const ACQUIRABLE_STATES = new Set<TraceProcessorLeaseState>([
  'pending',
  'starting',
  'ready',
  'idle',
  'active',
  'crashed',
  'restarting',
]);

const ALLOWED_TRANSITIONS: Record<TraceProcessorLeaseState, TraceProcessorLeaseState[]> = {
  pending: ['starting', 'draining', 'released', 'failed'],
  starting: ['ready', 'draining', 'crashed', 'failed'],
  ready: ['idle', 'active', 'draining', 'crashed', 'failed'],
  idle: ['active', 'draining', 'released', 'crashed', 'failed'],
  active: ['idle', 'draining', 'crashed', 'failed'],
  draining: ['released', 'failed'],
  released: [],
  crashed: ['restarting', 'draining', 'failed'],
  restarting: ['ready', 'draining', 'failed'],
  failed: [],
};

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} is required`);
  }
}

function assertValidTransition(from: TraceProcessorLeaseState, to: TraceProcessorLeaseState): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid trace processor lease transition: ${from} -> ${to}`);
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function metadataForHolder(holder: TraceProcessorHolderInput): string | null {
  const metadata = {
    ...(holder.metadata ?? {}),
    ...(holder.frontendVisibility ? { frontendVisibility: holder.frontendVisibility } : {}),
    ...(holder.sessionId ? { sessionId: holder.sessionId } : {}),
    ...(holder.runId ? { runId: holder.runId } : {}),
    ...(holder.reportId ? { reportId: holder.reportId } : {}),
  };
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

export function resolveHolderTtlPolicy(holder: TraceProcessorHolderInput): TraceProcessorHolderTtlPolicy {
  if (holder.holderType === 'frontend_http_rpc') {
    const visibility = holder.frontendVisibility ?? 'visible';
    if (visibility === 'hidden') {
      return {
        heartbeatTtlMs: 10 * 60 * 1000,
        idleTtlMs: 8 * 60 * 60 * 1000,
      };
    }
    if (visibility === 'offline') {
      return {
        heartbeatTtlMs: 30 * 60 * 1000,
        idleTtlMs: 30 * 60 * 1000,
      };
    }
    return {
      heartbeatTtlMs: 90 * 1000,
      idleTtlMs: 4 * 60 * 60 * 1000,
    };
  }

  if (holder.holderType === 'manual_register') {
    return {
      heartbeatTtlMs: 5 * 60 * 1000,
      idleTtlMs: 60 * 60 * 1000,
    };
  }

  if (holder.holderType === 'metric_backfill') {
    return {
      heartbeatTtlMs: 5 * 60 * 1000,
      idleTtlMs: 30 * 60 * 1000,
    };
  }

  if (holder.holderType === 'batch_trace_run') {
    return {
      heartbeatTtlMs: 5 * 60 * 1000,
      idleTtlMs: 24 * 60 * 60 * 1000,
    };
  }

  return {
    heartbeatTtlMs: 5 * 60 * 1000,
    idleTtlMs: 24 * 60 * 60 * 1000,
  };
}

export class TraceProcessorLeaseStore {
  constructor(private readonly db: Database.Database = openEnterpriseDb()) {}

  close(): void {
    this.db.close();
  }

  acquireHolder(
    scope: EnterpriseRepositoryScope,
    traceId: string,
    holder: TraceProcessorHolderInput,
    options: { mode?: TraceProcessorLeaseMode; now?: number } = {},
  ): TraceProcessorLeaseRecord {
    assertNonEmpty(scope.tenantId, 'tenantId');
    assertNonEmpty(scope.workspaceId, 'workspaceId');
    assertNonEmpty(traceId, 'traceId');
    assertNonEmpty(holder.holderRef, 'holderRef');

    return this.db.transaction(() => {
      const now = options.now ?? Date.now();
      const blockingLease = this.findTraceLeaseByStates(scope, traceId, ['draining']);
      if (blockingLease) {
        throw new Error(`Trace processor lease ${blockingLease.id} is draining`);
      }

      const requestedMode = options.mode ?? 'shared';
      let lease = requestedMode === 'isolated'
        ? null
        : this.findAcquirableTraceLease(scope, traceId, requestedMode);
      if (!lease) {
        const leaseId = uuidv4();
        const ttl = resolveHolderTtlPolicy(holder);
        this.db.prepare(`
          INSERT INTO trace_processor_leases
            (id, tenant_id, workspace_id, trace_id, mode, state, heartbeat_at, expires_at)
          VALUES
            (?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          leaseId,
          scope.tenantId,
          scope.workspaceId,
          traceId,
          requestedMode,
          now,
          now + ttl.idleTtlMs,
        );
        lease = this.mustGetLease(scope, leaseId);
      }

      if (!ACQUIRABLE_STATES.has(lease.state as TraceProcessorLeaseState)) {
        throw new Error(`Trace processor lease ${lease.id} is not acquirable (${lease.state})`);
      }

      this.upsertHolder(lease.id, holder, now);
      const ttl = resolveHolderTtlPolicy(holder);
      const expiresAt = Math.max(lease.expires_at ?? 0, now + ttl.idleTtlMs);
      this.db.prepare(`
        UPDATE trace_processor_leases
        SET heartbeat_at = ?, expires_at = ?
        WHERE id = ?
      `).run(now, expiresAt, lease.id);
      this.refreshLeaseActivityState(scope, lease.id);
      return this.getLeaseById(scope, lease.id)!;
    })();
  }

  acquireHolderForLease(
    scope: EnterpriseRepositoryScope,
    leaseId: string,
    holder: TraceProcessorHolderInput,
    options: { now?: number } = {},
  ): TraceProcessorLeaseRecord {
    assertNonEmpty(scope.tenantId, 'tenantId');
    assertNonEmpty(scope.workspaceId, 'workspaceId');
    assertNonEmpty(leaseId, 'leaseId');
    assertNonEmpty(holder.holderRef, 'holderRef');

    return this.db.transaction(() => {
      const now = options.now ?? Date.now();
      const lease = this.mustGetLease(scope, leaseId);
      const state = lease.state as TraceProcessorLeaseState;
      if (!ACQUIRABLE_STATES.has(state)) {
        throw new Error(`Trace processor lease ${lease.id} is not acquirable (${state})`);
      }

      this.upsertHolder(lease.id, holder, now);
      const ttl = resolveHolderTtlPolicy(holder);
      const expiresAt = Math.max(lease.expires_at ?? 0, now + ttl.idleTtlMs);
      this.db.prepare(`
        UPDATE trace_processor_leases
        SET heartbeat_at = ?, expires_at = ?
        WHERE id = ?
      `).run(now, expiresAt, lease.id);
      this.refreshLeaseActivityState(scope, lease.id);
      return this.getLeaseById(scope, lease.id)!;
    })();
  }

  heartbeatHolder(
    scope: EnterpriseRepositoryScope,
    leaseId: string,
    holder: TraceProcessorHolderInput,
    now = Date.now(),
  ): TraceProcessorLeaseRecord {
    assertNonEmpty(leaseId, 'leaseId');
    const lease = this.mustGetLease(scope, leaseId);
    const row = this.db.prepare(`
      SELECT id FROM trace_processor_holders
      WHERE lease_id = ? AND holder_type = ? AND holder_ref = ?
      LIMIT 1
    `).get(lease.id, holder.holderType, holder.holderRef) as { id: string } | undefined;
    if (!row) {
      throw new Error(`Trace processor holder not found: ${holder.holderType}/${holder.holderRef}`);
    }

    const ttl = resolveHolderTtlPolicy(holder);
    this.db.prepare(`
      UPDATE trace_processor_holders
      SET heartbeat_at = ?, expires_at = ?, window_id = COALESCE(?, window_id), metadata_json = ?
      WHERE id = ?
    `).run(now, now + ttl.heartbeatTtlMs, holder.windowId ?? null, metadataForHolder(holder), row.id);
    this.db.prepare(`
      UPDATE trace_processor_leases
      SET heartbeat_at = ?, expires_at = MAX(COALESCE(expires_at, 0), ?)
      WHERE id = ?
    `).run(now, now + ttl.idleTtlMs, lease.id);
    this.refreshLeaseActivityState(scope, lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  releaseHolder(
    scope: EnterpriseRepositoryScope,
    leaseId: string,
    holderType: TraceProcessorHolderType,
    holderRef: string,
  ): TraceProcessorLeaseRecord {
    assertNonEmpty(leaseId, 'leaseId');
    assertNonEmpty(holderRef, 'holderRef');
    const lease = this.mustGetLease(scope, leaseId);
    this.db.prepare(`
      DELETE FROM trace_processor_holders
      WHERE lease_id = ? AND holder_type = ? AND holder_ref = ?
    `).run(lease.id, holderType, holderRef);
    this.refreshLeaseActivityState(scope, lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  markStarting(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    return this.transition(scope, leaseId, 'starting');
  }

  markReady(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    const lease = this.transition(scope, leaseId, 'ready');
    this.refreshLeaseActivityState(scope, lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  markCrashed(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    return this.transition(scope, leaseId, 'crashed');
  }

  markRestarting(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    return this.transition(scope, leaseId, 'restarting');
  }

  markFailed(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    return this.transition(scope, leaseId, 'failed');
  }

  beginDraining(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord {
    const lease = this.transition(scope, leaseId, 'draining');
    this.refreshLeaseActivityState(scope, lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  recordRss(scope: EnterpriseRepositoryScope, leaseId: string, rssBytes: number | null): TraceProcessorLeaseRecord {
    const lease = this.mustGetLease(scope, leaseId);
    this.db.prepare(`
      UPDATE trace_processor_leases
      SET rss_bytes = ?, heartbeat_at = ?
      WHERE id = ?
    `).run(rssBytes, Date.now(), lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  getLeaseById(scope: EnterpriseRepositoryScope, leaseId: string): TraceProcessorLeaseRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM trace_processor_leases
      WHERE tenant_id = ? AND workspace_id = ? AND id = ?
      LIMIT 1
    `).get(scope.tenantId, scope.workspaceId, leaseId) as LeaseRow | undefined;
    return row ? this.mapLease(row) : null;
  }

  listLeases(
    scope: EnterpriseRepositoryScope,
    criteria: { traceId?: string; states?: TraceProcessorLeaseState[] } = {},
  ): TraceProcessorLeaseRecord[] {
    const params: unknown[] = [scope.tenantId, scope.workspaceId];
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    if (criteria.traceId) {
      clauses.push('trace_id = ?');
      params.push(criteria.traceId);
    }
    if (criteria.states && criteria.states.length > 0) {
      clauses.push(`state IN (${criteria.states.map(() => '?').join(', ')})`);
      params.push(...criteria.states);
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM trace_processor_leases
      WHERE ${clauses.join(' AND ')}
      ORDER BY heartbeat_at DESC, id ASC
    `).all(...params) as LeaseRow[];
    return rows.map(row => this.mapLease(row));
  }

  hasActiveHolders(scope: EnterpriseRepositoryScope, traceId: string): boolean {
    return this.listLeases(scope, { traceId })
      .some(lease => !TERMINAL_STATES.has(lease.state) && lease.holderCount > 0);
  }

  hasActiveHoldersForTrace(traceId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM trace_processor_leases l
      INNER JOIN trace_processor_holders h ON h.lease_id = l.id
      WHERE l.trace_id = ?
        AND l.state NOT IN ('released', 'failed')
      LIMIT 1
    `).get(traceId);
    return row !== undefined;
  }

  sweepExpired(now = Date.now()): TraceProcessorLeaseSweepResult {
    const holderResult = this.db.prepare(`
      DELETE FROM trace_processor_holders
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `).run(now);

    this.db.prepare(`
      UPDATE trace_processor_leases
      SET state = 'idle'
      WHERE state = 'active'
        AND id IN (
          SELECT l.id
          FROM trace_processor_leases l
          LEFT JOIN trace_processor_holders h ON h.lease_id = l.id
          GROUP BY l.id
          HAVING COUNT(h.id) = 0
        )
    `).run();

    const releasableRows = this.db.prepare(`
      SELECT l.*
      FROM trace_processor_leases l
      LEFT JOIN trace_processor_holders h ON h.lease_id = l.id
      WHERE l.state NOT IN ('released', 'failed')
        AND (
          l.mode = 'isolated'
          OR (l.expires_at IS NOT NULL AND l.expires_at <= ?)
        )
      GROUP BY l.id
      HAVING COUNT(h.id) = 0
    `).all(now) as LeaseRow[];

    for (const lease of releasableRows) {
      this.db.prepare(`
        UPDATE trace_processor_leases
        SET state = 'released'
        WHERE id = ?
      `).run(lease.id);
    }

    return {
      holdersRemoved: holderResult.changes,
      leasesReleased: releasableRows.length,
      releasedLeases: releasableRows.map((lease) => ({
        id: lease.id,
        tenantId: lease.tenant_id,
        workspaceId: lease.workspace_id,
        traceId: lease.trace_id,
        mode: lease.mode as TraceProcessorLeaseMode,
      })),
    };
  }

  private transition(
    scope: EnterpriseRepositoryScope,
    leaseId: string,
    nextState: TraceProcessorLeaseState,
  ): TraceProcessorLeaseRecord {
    const lease = this.mustGetLease(scope, leaseId);
    const currentState = lease.state as TraceProcessorLeaseState;
    assertValidTransition(currentState, nextState);
    this.db.prepare(`
      UPDATE trace_processor_leases
      SET state = ?, heartbeat_at = ?
      WHERE id = ?
    `).run(nextState, Date.now(), lease.id);
    return this.getLeaseById(scope, lease.id)!;
  }

  private upsertHolder(leaseId: string, holder: TraceProcessorHolderInput, now: number): void {
    const ttl = resolveHolderTtlPolicy(holder);
    const metadataJson = metadataForHolder(holder);
    const existing = this.db.prepare(`
      SELECT id FROM trace_processor_holders
      WHERE lease_id = ? AND holder_type = ? AND holder_ref = ?
      LIMIT 1
    `).get(leaseId, holder.holderType, holder.holderRef) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE trace_processor_holders
        SET window_id = ?, heartbeat_at = ?, expires_at = ?, metadata_json = ?
        WHERE id = ?
      `).run(holder.windowId ?? null, now, now + ttl.heartbeatTtlMs, metadataJson, existing.id);
      return;
    }

    this.db.prepare(`
      INSERT INTO trace_processor_holders
        (id, lease_id, holder_type, holder_ref, window_id, heartbeat_at, expires_at, created_at, metadata_json)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      leaseId,
      holder.holderType,
      holder.holderRef,
      holder.windowId ?? null,
      now,
      now + ttl.heartbeatTtlMs,
      now,
      metadataJson,
    );
  }

  private refreshLeaseActivityState(scope: EnterpriseRepositoryScope, leaseId: string): void {
    const lease = this.mustGetLease(scope, leaseId);
    const state = lease.state as TraceProcessorLeaseState;
    const holderCount = this.countHolders(lease.id);

    if (state === 'draining' && holderCount === 0) {
      this.db.prepare(`UPDATE trace_processor_leases SET state = 'released' WHERE id = ?`).run(lease.id);
      return;
    }
    if (state === 'ready' || state === 'idle' || state === 'active') {
      const nextState: TraceProcessorLeaseState = holderCount > 0 ? 'active' : 'idle';
      if (nextState !== state) {
        this.db.prepare(`UPDATE trace_processor_leases SET state = ? WHERE id = ?`).run(nextState, lease.id);
      }
    }
  }

  private findAcquirableTraceLease(
    scope: EnterpriseRepositoryScope,
    traceId: string,
    mode: TraceProcessorLeaseMode,
  ): LeaseRow | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM trace_processor_leases
      WHERE tenant_id = ? AND workspace_id = ? AND trace_id = ?
        AND mode = ?
      ORDER BY heartbeat_at DESC, id ASC
    `).all(scope.tenantId, scope.workspaceId, traceId, mode) as LeaseRow[];
    return rows.find(row => ACQUIRABLE_STATES.has(row.state as TraceProcessorLeaseState)) ?? null;
  }

  private findTraceLeaseByStates(
    scope: EnterpriseRepositoryScope,
    traceId: string,
    states: TraceProcessorLeaseState[],
  ): LeaseRow | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM trace_processor_leases
      WHERE tenant_id = ? AND workspace_id = ? AND trace_id = ?
        AND state IN (${states.map(() => '?').join(', ')})
      ORDER BY heartbeat_at DESC, id ASC
      LIMIT 1
    `).all(scope.tenantId, scope.workspaceId, traceId, ...states) as LeaseRow[];
    return rows[0] ?? null;
  }

  private mustGetLease(scope: EnterpriseRepositoryScope, leaseId: string): LeaseRow {
    const row = this.db.prepare(`
      SELECT *
      FROM trace_processor_leases
      WHERE tenant_id = ? AND workspace_id = ? AND id = ?
      LIMIT 1
    `).get(scope.tenantId, scope.workspaceId, leaseId) as LeaseRow | undefined;
    if (!row) {
      throw new Error(`Trace processor lease not found: ${leaseId}`);
    }
    return row;
  }

  private countHolders(leaseId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM trace_processor_holders
      WHERE lease_id = ?
    `).get(leaseId) as { count: number };
    return row.count;
  }

  private holdersForLease(leaseId: string): TraceProcessorHolderRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM trace_processor_holders
      WHERE lease_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(leaseId) as HolderRow[];
    return rows.map(row => ({
      id: row.id,
      leaseId: row.lease_id,
      holderType: row.holder_type as TraceProcessorHolderType,
      holderRef: row.holder_ref,
      windowId: row.window_id,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      metadata: parseMetadata(row.metadata_json),
    }));
  }

  private mapLease(row: LeaseRow): TraceProcessorLeaseRecord {
    const holders = this.holdersForLease(row.id);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      traceId: row.trace_id,
      mode: row.mode as TraceProcessorLeaseMode,
      state: row.state as TraceProcessorLeaseState,
      rssBytes: row.rss_bytes,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      holderCount: holders.length,
      holders,
    };
  }
}

let singleton: TraceProcessorLeaseStore | null = null;
let singletonDbPath: string | null = null;

export function getTraceProcessorLeaseStore(): TraceProcessorLeaseStore {
  const dbPath = resolveEnterpriseDbPath();
  if (!singleton || singletonDbPath !== dbPath) {
    try {
      singleton?.close();
    } catch {
      // Ignore stale singleton cleanup errors; a new DB handle is authoritative.
    }
    singleton = new TraceProcessorLeaseStore(openEnterpriseDb(dbPath));
    singletonDbPath = dbPath;
  }
  return singleton;
}

export function setTraceProcessorLeaseStoreForTests(store: TraceProcessorLeaseStore | null): void {
  singleton = store;
  singletonDbPath = store ? resolveEnterpriseDbPath() : null;
}
