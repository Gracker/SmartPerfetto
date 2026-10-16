// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import type { RequestContext } from '../middleware/auth';
import { openEnterpriseDb } from './enterpriseDb';
import {
  repositoryScopeFromRequestContext,
  type EnterpriseRepositoryScope,
} from './enterpriseRepository';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseRecord,
  type TraceProcessorLeaseState,
  type TraceProcessorHolderType,
} from './traceProcessorLeaseStore';
import {
  TraceProcessorFactory,
  type TraceProcessorRuntimeStats,
} from './workingTraceProcessor';

type TraceProcessorFactoryStats = ReturnType<typeof TraceProcessorFactory.getStats>;

export interface EnterpriseRuntimeDashboardDependencies {
  now?: () => number;
  eventLimit?: number;
  openDb?: () => Database.Database;
  listLeases?: (scope: EnterpriseRepositoryScope) => TraceProcessorLeaseRecord[];
  traceProcessorStatsProvider?: () => TraceProcessorFactoryStats;
}

interface RecentAgentEventRow {
  run_id: string;
  cursor: number;
  event_type: string;
  created_at: number;
}

interface RecentAuditEventRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_user_id: string | null;
  workspace_id: string | null;
  created_at: number;
}

function isActiveLeaseState(state: TraceProcessorLeaseState): boolean {
  return state !== 'released' && state !== 'failed';
}

function addCount<T extends string>(counts: Partial<Record<T, number>>, key: T, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function processorQueueLength(processor: TraceProcessorRuntimeStats): number {
  const worker = processor.sqlWorker;
  return worker ? worker.queuedP0 + worker.queuedP1 + worker.queuedP2 : 0;
}

function processorBelongsToScopedLeases(
  processor: TraceProcessorRuntimeStats,
  traceIds: Set<string>,
  leaseIds: Set<string>,
): boolean {
  if (processor.leaseId && leaseIds.has(processor.leaseId)) return true;
  return traceIds.has(processor.traceId);
}

function queueLengthForLease(
  lease: TraceProcessorLeaseRecord,
  processors: TraceProcessorRuntimeStats[],
): number {
  if (lease.mode === 'isolated') {
    return processors
      .filter(processor => processor.leaseId === lease.id)
      .reduce((sum, processor) => sum + processorQueueLength(processor), 0);
  }
  return processors
    .filter(processor => processor.traceId === lease.traceId && (processor.leaseMode ?? 'shared') === 'shared')
    .reduce((sum, processor) => sum + processorQueueLength(processor), 0);
}

function summarizeQueueTotals(processors: TraceProcessorRuntimeStats[]): {
  queuedP0: number;
  queuedP1: number;
  queuedP2: number;
  total: number;
} {
  const totals = processors.reduce((sum, processor) => {
    const worker = processor.sqlWorker;
    if (!worker) return sum;
    sum.queuedP0 += worker.queuedP0;
    sum.queuedP1 += worker.queuedP1;
    sum.queuedP2 += worker.queuedP2;
    return sum;
  }, { queuedP0: 0, queuedP1: 0, queuedP2: 0 });
  return {
    ...totals,
    total: totals.queuedP0 + totals.queuedP1 + totals.queuedP2,
  };
}

function listRecentAgentEvents(
  db: Database.Database,
  scope: EnterpriseRepositoryScope,
  limit: number,
): Array<{
  runId: string;
  cursor: number;
  eventType: string;
  createdAt: number;
}> {
  return db.prepare<unknown[], RecentAgentEventRow>(`
    SELECT run_id, cursor, event_type, created_at
    FROM agent_events
    WHERE tenant_id = ?
      AND workspace_id = ?
    ORDER BY created_at DESC, cursor DESC
    LIMIT ?
  `).all(scope.tenantId, scope.workspaceId, limit)
    .map(row => ({
      runId: row.run_id,
      cursor: row.cursor,
      eventType: row.event_type,
      createdAt: row.created_at,
    }));
}

function listRecentAuditEvents(
  db: Database.Database,
  scope: EnterpriseRepositoryScope,
  limit: number,
): Array<{
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  workspaceId: string | null;
  createdAt: number;
}> {
  return db.prepare<unknown[], RecentAuditEventRow>(`
    SELECT action, resource_type, resource_id, actor_user_id, workspace_id, created_at
    FROM audit_events
    WHERE tenant_id = ?
      AND (workspace_id = ? OR workspace_id IS NULL)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(scope.tenantId, scope.workspaceId, limit)
    .map(row => ({
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      actorUserId: row.actor_user_id,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
    }));
}

export function buildEnterpriseRuntimeDashboard(
  context: RequestContext,
  deps: EnterpriseRuntimeDashboardDependencies = {},
) {
  const scope = repositoryScopeFromRequestContext(context);
  const generatedAtMs = deps.now?.() ?? Date.now();
  const eventLimit = Math.max(1, Math.min(100, Math.floor(deps.eventLimit ?? 20)));
  const leases = deps.listLeases
    ? deps.listLeases(scope)
    : getTraceProcessorLeaseStore().listLeases(scope);
  const traceIds = new Set(leases.map(lease => lease.traceId));
  const leaseIds = new Set(leases.map(lease => lease.id));
  const traceStats = deps.traceProcessorStatsProvider
    ? deps.traceProcessorStatsProvider()
    : TraceProcessorFactory.getStats();
  const processors = traceStats.processors
    .filter(processor => processorBelongsToScopedLeases(processor, traceIds, leaseIds));
  const activeLeases = leases.filter(lease => isActiveLeaseState(lease.state));
  const countsByState: Partial<Record<TraceProcessorLeaseState, number>> = {};
  const countsByHolderType: Partial<Record<TraceProcessorHolderType, number>> = {};

  for (const lease of leases) {
    addCount(countsByState, lease.state);
    for (const holder of lease.holders) {
      addCount(countsByHolderType, holder.holderType);
    }
  }

  let recentAgentEvents: ReturnType<typeof listRecentAgentEvents> = [];
  let recentAuditEvents: ReturnType<typeof listRecentAuditEvents> = [];
  const db = deps.openDb ? deps.openDb() : openEnterpriseDb();
  try {
    recentAgentEvents = listRecentAgentEvents(db, scope, eventLimit);
    recentAuditEvents = listRecentAuditEvents(db, scope, eventLimit);
  } finally {
    db.close();
  }

  const queueTotals = summarizeQueueTotals(processors);
  const observedProcessorRssBytes = processors.reduce((sum, processor) => {
    return sum + (processor.rssBytes && processor.rssBytes > 0 ? processor.rssBytes : 0);
  }, 0);

  return {
    success: true,
    generatedAt: new Date(generatedAtMs).toISOString(),
    scope: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      userId: scope.userId ?? context.userId,
    },
    leases: {
      count: leases.length,
      activeCount: activeLeases.length,
      holderCount: leases.reduce((sum, lease) => sum + lease.holderCount, 0),
      totalRssBytes: leases.reduce((sum, lease) => sum + (lease.rssBytes ?? 0), 0),
      countsByState,
      countsByHolderType,
      items: leases.map(lease => ({
        id: lease.id,
        traceId: lease.traceId,
        mode: lease.mode,
        state: lease.state,
        rssBytes: lease.rssBytes,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
        queueLength: queueLengthForLease(lease, processors),
        holderCount: lease.holderCount,
        holderTypes: Array.from(new Set(lease.holders.map(holder => holder.holderType))),
      })),
    },
    processors: {
      count: processors.length,
      traceIds: Array.from(new Set(processors.map(processor => processor.traceId))),
      queueTotals,
      rssTotals: {
        observedProcessorRssBytes,
        unknownRssProcessorCount: processors.filter(processor => processor.rssBytes === null).length,
      },
      ramBudget: traceStats.ramBudget,
      items: processors.map(processor => ({
        kind: processor.kind,
        processorId: processor.processorId,
        traceId: processor.traceId,
        leaseId: processor.leaseId,
        leaseMode: processor.leaseMode,
        status: processor.status,
        activeQueries: processor.activeQueries,
        rssBytes: processor.rssBytes,
        startupRssBytes: processor.startupRssBytes,
        peakRssBytes: processor.peakRssBytes,
        lastRssSampleAt: processor.lastRssSampleAt,
        rssSampleSource: processor.rssSampleSource,
        sqlWorker: processor.sqlWorker,
      })),
    },
    events: {
      recentAgentEvents,
      recentAuditEvents,
    },
  };
}
