// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import { type RequestContext } from '../../middleware/auth';
import { applyEnterpriseMinimalSchema } from '../enterpriseSchema';
import {
  ENTERPRISE_WORKSPACE_SCOPED_TABLES,
  buildWorkspaceScopedWhere,
  createEnterpriseWorkspaceRepository,
  repositoryScopeFromRequestContext,
} from '../enterpriseRepository';

interface TraceAssetRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  workspace_id: string;
  status: string;
}

function seedWorkspace(db: Database.Database, tenantId: string, workspaceId: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(tenantId, tenantId, now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspaceId, tenantId, workspaceId, now, now);
}

function seedTrace(
  db: Database.Database,
  input: { id: string; tenantId: string; workspaceId: string; status?: string },
): void {
  db.prepare(`
    INSERT INTO trace_assets
      (id, tenant_id, workspace_id, local_path, status, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.tenantId,
    input.workspaceId,
    `/tmp/${input.id}.pftrace`,
    input.status ?? 'ready',
    Date.now(),
  );
}

describe('enterprise repository scope abstraction', () => {
  let db: Database.Database | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
    seedWorkspace(db, 'tenant-a', 'workspace-a');
    seedWorkspace(db, 'tenant-a', 'workspace-b');
    seedWorkspace(db, 'tenant-b', 'workspace-c');
    seedTrace(db, { id: 'trace-a', tenantId: 'tenant-a', workspaceId: 'workspace-a' });
    seedTrace(db, { id: 'trace-b', tenantId: 'tenant-a', workspaceId: 'workspace-b' });
    seedTrace(db, { id: 'trace-c', tenantId: 'tenant-b', workspaceId: 'workspace-c' });
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('derives repository scope from RequestContext', () => {
    const context: RequestContext = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      authType: 'sso',
      roles: ['analyst'],
      scopes: ['trace:read'],
      requestId: 'req-a',
    };

    expect(repositoryScopeFromRequestContext(context)).toEqual({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    });
  });

  test('always prepends tenant and workspace filters to generated WHERE clauses', () => {
    const where = buildWorkspaceScopedWhere(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { status: 'ready' },
    );

    expect(where.sql).toBe(
      'tenant_id = @scopeTenantId AND workspace_id = @scopeWorkspaceId AND status = @criteria_status',
    );
    expect(where.params).toEqual({
      scopeTenantId: 'tenant-a',
      scopeWorkspaceId: 'workspace-a',
      criteria_status: 'ready',
    });
  });

  test('does not allow callers to override tenant or workspace criteria', () => {
    expect(() => buildWorkspaceScopedWhere(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { tenant_id: 'tenant-b' },
    )).toThrow('tenant_id must come from EnterpriseRepositoryScope');

    expect(() => buildWorkspaceScopedWhere(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { workspace_id: 'workspace-b' },
    )).toThrow('workspace_id must come from EnterpriseRepositoryScope');
  });

  test('lists only rows inside the scope tenant and workspace', () => {
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db!, 'trace_assets');

    const rows = repo.list(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { status: 'ready' },
      { orderBy: 'id' },
    );

    expect(rows.map(row => row.id)).toEqual(['trace-a']);
  });

  test('declares all id-based workspace scoped core tables as repository tables', () => {
    expect(ENTERPRISE_WORKSPACE_SCOPED_TABLES).toEqual([
      'trace_assets',
      'trace_processor_leases',
      'analysis_sessions',
      'analysis_runs',
      'conversation_turns',
      'agent_events',
      'runtime_snapshots',
      'report_artifacts',
      'memory_entries',
      'skill_registry_entries',
    ]);
  });

  test('upserts rows without allowing cross-scope ownership moves', () => {
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db!, 'trace_assets');
    const scopeA = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };
    const scopeB = { tenantId: 'tenant-b', workspaceId: 'workspace-c' };

    expect(repo.upsertById(scopeA, 'trace-new', {
      local_path: '/tmp/trace-new.pftrace',
      status: 'ready',
      created_at: 123,
    })).toBe(1);
    expect(repo.getById(scopeA, 'trace-new')).toEqual(expect.objectContaining({
      id: 'trace-new',
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      status: 'ready',
    }));

    expect(repo.upsertById(scopeA, 'trace-new', {
      local_path: '/tmp/trace-new-v2.pftrace',
      status: 'archived',
      created_at: 124,
    })).toBe(1);
    expect(repo.getById(scopeA, 'trace-new')).toEqual(expect.objectContaining({
      local_path: '/tmp/trace-new-v2.pftrace',
      status: 'archived',
    }));

    expect(repo.upsertById(scopeA, 'trace-c', {
      local_path: '/tmp/attempted-move.pftrace',
      status: 'deleted',
      created_at: 125,
    })).toBe(0);
    expect(repo.getById(scopeA, 'trace-c')).toBeNull();
    expect(repo.getById(scopeB, 'trace-c')).toEqual(expect.objectContaining({
      tenant_id: 'tenant-b',
      workspace_id: 'workspace-c',
      status: 'ready',
    }));
  });

  test('get, update, and delete stay scoped by tenant and workspace', () => {
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db!, 'trace_assets');
    const scopeA = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };
    const scopeB = { tenantId: 'tenant-b', workspaceId: 'workspace-c' };

    expect(repo.getById(scopeA, 'trace-c')).toBeNull();
    expect(repo.updateById(scopeA, 'trace-c', { status: 'deleted' })).toBe(0);
    expect(repo.deleteById(scopeA, 'trace-c')).toBe(0);
    expect(repo.getById(scopeB, 'trace-c')?.status).toBe('ready');

    expect(repo.updateById(scopeA, 'trace-a', { status: 'archived' })).toBe(1);
    expect(repo.getById(scopeA, 'trace-a')?.status).toBe('archived');
    expect(repo.deleteById(scopeA, 'trace-a')).toBe(1);
    expect(repo.getById(scopeA, 'trace-a')).toBeNull();
  });

  test('rejects non-workspace tables and unsafe dynamic columns', () => {
    expect(() => createEnterpriseWorkspaceRepository(db!, 'organizations' as never)).toThrow(
      'Table is not workspace-scoped',
    );
    expect(() => buildWorkspaceScopedWhere(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      { 'status; DROP TABLE trace_assets': 'ready' },
    )).toThrow('Invalid criteria column');

    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db!, 'trace_assets');
    expect(() => repo.list(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      {},
      { orderBy: 'id; DROP TABLE trace_assets' },
    )).toThrow('Invalid orderBy column');
    expect(() => repo.list(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      {},
      { orderBy: 'id', direction: 'DESC; DROP TABLE trace_assets' as never },
    )).toThrow('Invalid orderBy direction');
  });

  test('does not allow scoped updates to mutate identity columns', () => {
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db!, 'trace_assets');

    expect(() => repo.updateById(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      'trace-a',
      { workspace_id: 'workspace-b' },
    )).toThrow('workspace_id cannot be updated through a scoped repository');

    expect(() => repo.upsertById(
      { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
      'trace-a',
      { tenant_id: 'tenant-b', local_path: '/tmp/x', status: 'ready', created_at: 1 },
    )).toThrow('tenant_id cannot be written through a scoped repository');
  });
});
