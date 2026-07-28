// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import { applyEnterpriseMinimalSchema } from '../enterpriseSchema';
import {
  resolveHolderTtlPolicy,
  TraceProcessorLeaseStore,
  type TraceProcessorHolderType,
} from '../traceProcessorLeaseStore';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';

const scope: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

function seedGraph(db: Database.Database, traceId = 'trace-a'): void {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, local_path, status, created_at)
    VALUES
      (?, 'tenant-a', 'workspace-a', ?, 'ready', ?)
  `).run(traceId, `/tmp/${traceId}.pftrace`, now);
}

describe('TraceProcessorLeaseStore', () => {
  let db: Database.Database;
  let store: TraceProcessorLeaseStore;

  beforeEach(() => {
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
    seedGraph(db);
    store = new TraceProcessorLeaseStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('defines graded TTL policies for frontend, agent, report, metric backfill, and manual holders', () => {
    expect(resolveHolderTtlPolicy({
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      frontendVisibility: 'visible',
    })).toEqual({
      heartbeatTtlMs: 90_000,
      idleTtlMs: 4 * 60 * 60 * 1000,
    });
    expect(resolveHolderTtlPolicy({
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      frontendVisibility: 'hidden',
    }).idleTtlMs).toBe(8 * 60 * 60 * 1000);
    expect(resolveHolderTtlPolicy({
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      frontendVisibility: 'offline',
    }).heartbeatTtlMs).toBe(30 * 60 * 1000);
    expect(resolveHolderTtlPolicy({
      holderType: 'manual_register',
      holderRef: 'port:9100',
    }).idleTtlMs).toBe(60 * 60 * 1000);
    expect(resolveHolderTtlPolicy({
      holderType: 'agent_run',
      holderRef: 'run-a',
    }).idleTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(resolveHolderTtlPolicy({
      holderType: 'report_generation',
      holderRef: 'report-a',
    }).heartbeatTtlMs).toBe(5 * 60 * 1000);
    expect(resolveHolderTtlPolicy({
      holderType: 'metric_backfill',
      holderRef: 'comparison-a',
    }).idleTtlMs).toBe(30 * 60 * 1000);
  });

  it('acquires all five holder classes on one scoped lease', () => {
    const holders: Array<{ holderType: TraceProcessorHolderType; holderRef: string; windowId?: string }> = [
      { holderType: 'frontend_http_rpc', holderRef: 'window-a', windowId: 'window-a' },
      { holderType: 'agent_run', holderRef: 'run-a' },
      { holderType: 'report_generation', holderRef: 'report-a' },
      { holderType: 'metric_backfill', holderRef: 'comparison-a' },
      { holderType: 'manual_register', holderRef: 'port:9100' },
    ];

    let lease = store.acquireHolder(scope, 'trace-a', holders[0], { now: 1000 });
    store.markStarting(scope, lease.id);
    lease = store.markReady(scope, lease.id);
    for (const holder of holders.slice(1)) {
      lease = store.acquireHolder(scope, 'trace-a', holder, { now: 2000 });
    }

    expect(lease.state).toBe('active');
    expect(lease.holderCount).toBe(5);
    expect(lease.holders.map(holder => holder.holderType).sort()).toEqual([
      'agent_run',
      'frontend_http_rpc',
      'manual_register',
      'metric_backfill',
      'report_generation',
    ]);
  });

  it('refreshes an existing holder heartbeat without duplicating the holder', () => {
    let lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
      frontendVisibility: 'visible',
    }, { now: 1000 });
    store.markStarting(scope, lease.id);
    lease = store.markReady(scope, lease.id);
    const originalHolderId = lease.holders[0].id;

    lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
      frontendVisibility: 'hidden',
    }, { now: 5000 });

    expect(lease.state).toBe('active');
    expect(lease.holderCount).toBe(1);
    expect(lease.heartbeatAt).toBe(5000);
    expect(lease.holders[0]).toMatchObject({
      id: originalHolderId,
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      heartbeatAt: 5000,
      expiresAt: 5000 + 10 * 60 * 1000,
      metadata: { frontendVisibility: 'hidden' },
    });
  });

  it('reuses shared leases but creates distinct isolated leases for the same trace', () => {
    const sharedA = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
    }, { mode: 'shared', now: 1000 });
    const sharedB = store.acquireHolder(scope, 'trace-a', {
      holderType: 'agent_run',
      holderRef: 'run-a',
      runId: 'run-a',
    }, { mode: 'shared', now: 2000 });
    const isolatedA = store.acquireHolder(scope, 'trace-a', {
      holderType: 'agent_run',
      holderRef: 'run-isolated-a',
      runId: 'run-isolated-a',
    }, { mode: 'isolated', now: 3000 });
    const isolatedB = store.acquireHolder(scope, 'trace-a', {
      holderType: 'report_generation',
      holderRef: 'report-isolated-b',
      reportId: 'report-isolated-b',
    }, { mode: 'isolated', now: 4000 });

    expect(sharedB.id).toBe(sharedA.id);
    expect(sharedB.mode).toBe('shared');
    expect(isolatedA.id).not.toBe(sharedA.id);
    expect(isolatedB.id).not.toBe(sharedA.id);
    expect(isolatedB.id).not.toBe(isolatedA.id);
    expect(store.listLeases(scope, { traceId: 'trace-a' }).map(lease => lease.mode).sort()).toEqual([
      'isolated',
      'isolated',
      'shared',
    ]);
  });

  it('follows pending -> starting -> active -> idle -> released through the state machine', () => {
    let lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'agent_run',
      holderRef: 'run-a',
      runId: 'run-a',
      sessionId: 'session-a',
    }, { now: 1000 });
    expect(lease.state).toBe('pending');

    lease = store.markStarting(scope, lease.id);
    expect(lease.state).toBe('starting');

    lease = store.markReady(scope, lease.id);
    expect(lease.state).toBe('active');
    expect(lease.holders[0].metadata).toMatchObject({
      runId: 'run-a',
      sessionId: 'session-a',
    });

    lease = store.releaseHolder(scope, lease.id, 'agent_run', 'run-a');
    expect(lease.state).toBe('idle');
    expect(lease.holderCount).toBe(0);

    lease = store.beginDraining(scope, lease.id);
    expect(lease.state).toBe('released');
  });

  it('rejects new holders while a lease is draining and releases after active holders leave', () => {
    let lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
    }, { now: 1000 });
    store.markStarting(scope, lease.id);
    lease = store.markReady(scope, lease.id);

    lease = store.beginDraining(scope, lease.id);
    expect(lease.state).toBe('draining');

    expect(() => store.acquireHolder(scope, 'trace-a', {
      holderType: 'manual_register',
      holderRef: 'port:9100',
    })).toThrow('is draining');

    lease = store.releaseHolder(scope, lease.id, 'frontend_http_rpc', 'window-a');
    expect(lease.state).toBe('released');
  });

  it('keeps lease visibility scoped to tenant and workspace', () => {
    const lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'manual_register',
      holderRef: 'port:9100',
    });

    expect(store.getLeaseById(scope, lease.id)?.id).toBe(lease.id);
    expect(store.getLeaseById({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-b',
    }, lease.id)).toBeNull();
  });

  it('sweeps expired holders and releases holderless expired leases', () => {
    const lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'manual_register',
      holderRef: 'port:9100',
    }, { now: 1000 });
    store.markStarting(scope, lease.id);
    store.markReady(scope, lease.id);

    const result = store.sweepExpired(1000 + 60 * 60 * 1000 + 1);
    const swept = store.getLeaseById(scope, lease.id)!;

    expect(result).toMatchObject({ holdersRemoved: 1, leasesReleased: 1 });
    expect(result.releasedLeases).toEqual([expect.objectContaining({
      id: lease.id,
      traceId: 'trace-a',
      mode: 'shared',
    })]);
    expect(swept.state).toBe('released');
    expect(swept.holderCount).toBe(0);
  });

  it('moves an active lease to idle when holder heartbeat TTL expires before idle TTL', () => {
    const lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-a',
      windowId: 'window-a',
      frontendVisibility: 'visible',
    }, { now: 1000 });
    store.markStarting(scope, lease.id);
    store.markReady(scope, lease.id);

    const result = store.sweepExpired(1000 + 90_001);
    const swept = store.getLeaseById(scope, lease.id)!;

    expect(result).toEqual({
      holdersRemoved: 1,
      leasesReleased: 0,
      releasedLeases: [],
    });
    expect(swept.state).toBe('idle');
    expect(swept.holderCount).toBe(0);
  });

  it('releases an isolated viewer as soon as its final holder expires', () => {
    const lease = store.acquireHolder(scope, 'trace-a', {
      holderType: 'frontend_http_rpc',
      holderRef: 'window-isolated',
      frontendVisibility: 'visible',
    }, {mode: 'isolated', now: 1000});
    store.markStarting(scope, lease.id);
    store.markReady(scope, lease.id);

    const result = store.sweepExpired(1000 + 90_001);

    expect(result).toMatchObject({holdersRemoved: 1, leasesReleased: 1});
    expect(result.releasedLeases).toEqual([expect.objectContaining({
      id: lease.id,
      traceId: 'trace-a',
      mode: 'isolated',
    })]);
    expect(store.getLeaseById(scope, lease.id)?.state).toBe('released');
  });
});
