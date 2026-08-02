// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type Database from 'better-sqlite3';
import type { RequestContext } from '../middleware/auth';
import { recordEnterpriseAuditEvent } from './enterpriseAuditService';

const SAFE_ID_RE = /^[a-zA-Z0-9._:-]+$/;
const MEMBER_ROLES = new Set(['viewer', 'analyst', 'workspace_admin', 'org_admin']);
const WORKSPACE_ADMIN_DELEGATABLE_ROLES = new Set(['viewer', 'analyst']);

export interface WorkspacePolicyInput {
  quotaPolicy?: Record<string, unknown> | null;
  retentionPolicy?: Record<string, unknown> | null;
}

export interface WorkspaceUpsertInput extends WorkspacePolicyInput {
  workspaceId?: string;
  name?: string;
}

export interface MemberUpsertInput {
  email?: string;
  displayName?: string;
  idpSubject?: string;
  role?: string;
}

export class EnterpriseAdminControlPlaneError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EnterpriseAdminControlPlaneError';
  }
}

interface WorkspaceRow {
  id: string;
  tenant_id: string;
  name: string;
  retention_policy: string | null;
  quota_policy: string | null;
  created_at: number;
  updated_at: number;
  member_count: number;
  trace_count: number;
  provider_count: number;
}

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string | null;
  idp_subject: string | null;
  role: string;
  created_at: number;
}

function canManageOrgMembership(context: RequestContext): boolean {
  return context.roles.includes('org_admin')
    || context.scopes.includes('*')
    || context.scopes.includes('tenant:manage');
}

function getMembershipRole(
  db: Database.Database,
  tenantId: string,
  workspaceId: string,
  userId: string,
): string | undefined {
  return db.prepare<unknown[], {role: string}>(`
    SELECT role FROM memberships
    WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?
  `).get(tenantId, workspaceId, userId)?.role;
}

function isPersonalWorkspace(
  db: Database.Database,
  tenantId: string,
  workspaceId: string,
): boolean {
  return Boolean(db.prepare<unknown[], { workspace_id: string }>(`
    SELECT workspace_id
    FROM sso_personal_workspaces
    WHERE tenant_id = ? AND workspace_id = ?
    LIMIT 1
  `).get(tenantId, workspaceId));
}

function assertMembershipMutationAllowed(
  context: RequestContext,
  targetUserId: string,
  existingRole: string | undefined,
  requestedRole?: string,
): void {
  if (canManageOrgMembership(context)) return;
  if (targetUserId === context.userId) {
    throw new EnterpriseAdminControlPlaneError(403, 'Workspace administrators cannot change their own role');
  }
  if (existingRole === 'workspace_admin' || existingRole === 'org_admin') {
    throw new EnterpriseAdminControlPlaneError(403, 'Workspace administrators cannot manage peer or organization administrators');
  }
  if (requestedRole && !WORKSPACE_ADMIN_DELEGATABLE_ROLES.has(requestedRole)) {
    throw new EnterpriseAdminControlPlaneError(403, `Workspace administrators cannot grant role: ${requestedRole}`);
  }
}

function assertNotLastOrgAdmin(
  db: Database.Database,
  context: RequestContext,
  existingRole: string | undefined,
  nextRole?: string,
): void {
  if (existingRole !== 'org_admin' || nextRole === 'org_admin') return;
  const count = db.prepare<unknown[], {count: number}>(`
    SELECT COUNT(*) AS count FROM memberships
    WHERE tenant_id = ? AND role = 'org_admin'
  `).get(context.tenantId)?.count ?? 0;
  if (count <= 1) {
    throw new EnterpriseAdminControlPlaneError(409, 'Cannot remove or demote the last organization administrator');
  }
}

function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    throw new EnterpriseAdminControlPlaneError(400, `Invalid ${label}: ${value}`);
  }
  return value;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
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

function normalizeJsonObject(
  value: Record<string, unknown> | null | undefined,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new EnterpriseAdminControlPlaneError(400, `${label} must be an object or null`);
  }
  return JSON.stringify(value);
}

function rowToWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    retentionPolicy: parseJsonObject(row.retention_policy),
    quotaPolicy: parseJsonObject(row.quota_policy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: row.member_count,
    traceCount: row.trace_count,
    providerCount: row.provider_count,
  };
}

function ensureTenantAndActor(db: Database.Database, context: RequestContext, now: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(context.tenantId, context.tenantId, now, now);
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).run(
    context.userId,
    context.tenantId,
    `${context.userId}@admin.local`,
    context.userId,
    `admin:${context.userId}`,
    now,
    now,
  );
}

function workspaceRows(db: Database.Database, tenantId: string): WorkspaceRow[] {
  return db.prepare<unknown[], WorkspaceRow>(`
    SELECT
      w.*,
      COUNT(DISTINCT m.user_id) AS member_count,
      COUNT(DISTINCT t.id) AS trace_count,
      COUNT(DISTINCT p.id) AS provider_count
    FROM workspaces w
    LEFT JOIN memberships m
      ON m.tenant_id = w.tenant_id
     AND m.workspace_id = w.id
    LEFT JOIN trace_assets t
      ON t.tenant_id = w.tenant_id
     AND t.workspace_id = w.id
    LEFT JOIN provider_credentials p
      ON p.tenant_id = w.tenant_id
     AND p.workspace_id = w.id
    WHERE w.tenant_id = ?
    GROUP BY w.id
    ORDER BY w.name ASC, w.id ASC
  `).all(tenantId);
}

function recordControlPlaneAudit(
  db: Database.Database,
  context: RequestContext,
  action: string,
  resourceType: string,
  resourceId: string | undefined,
  metadata: Record<string, unknown> = {},
): void {
  recordEnterpriseAuditEvent(db, {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action,
    resourceType,
    resourceId,
    metadata: {
      ...metadata,
      requestId: context.requestId,
    },
  });
}

export function getEnterpriseAdminControlPlaneSummary(
  db: Database.Database,
  context: RequestContext,
) {
  const tenant = db.prepare<unknown[], {
    id: string;
    name: string;
    status: string;
    plan: string | null;
    created_at: number;
    updated_at: number;
  }>(`
    SELECT id, name, status, plan, created_at, updated_at
    FROM organizations
    WHERE id = ?
    LIMIT 1
  `).get(context.tenantId) ?? null;
  const workspaces = workspaceRows(db, context.tenantId).map(rowToWorkspace);
  const userCount = db.prepare<unknown[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE tenant_id = ?
  `).get(context.tenantId)?.count ?? 0;
  const membershipCount = db.prepare<unknown[], { count: number }>(`
    SELECT COUNT(*) AS count
    FROM memberships
    WHERE tenant_id = ?
  `).get(context.tenantId)?.count ?? 0;

  return {
    success: true,
    tenant: tenant ? {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      createdAt: tenant.created_at,
      updatedAt: tenant.updated_at,
    } : null,
    workspaces,
    counts: {
      workspaces: workspaces.length,
      users: userCount,
      memberships: membershipCount,
      providers: workspaces.reduce((sum, workspace) => sum + workspace.providerCount, 0),
    },
    providerManagement: {
      workspaceEndpointTemplate: '/api/workspaces/:workspaceId/providers',
      legacyEndpoint: '/api/v1/providers',
    },
  };
}

export function listEnterpriseWorkspaces(db: Database.Database, context: RequestContext) {
  return {
    success: true,
    workspaces: workspaceRows(db, context.tenantId).map(rowToWorkspace),
  };
}

export function createEnterpriseWorkspace(
  db: Database.Database,
  context: RequestContext,
  input: WorkspaceUpsertInput,
  now = Date.now(),
) {
  const workspaceId = assertSafeId(String(input.workspaceId ?? '').trim(), 'workspaceId');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : workspaceId;
  const quotaPolicy = normalizeJsonObject(input.quotaPolicy, 'quotaPolicy');
  const retentionPolicy = normalizeJsonObject(input.retentionPolicy, 'retentionPolicy');

  return db.transaction(() => {
    ensureTenantAndActor(db, context, now);
    db.prepare(`
      INSERT INTO workspaces
        (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      context.tenantId,
      name,
      retentionPolicy ?? null,
      quotaPolicy ?? null,
      now,
      now,
    );
    recordControlPlaneAudit(db, context, 'tenant.workspace.created', 'workspace', workspaceId, {
      name,
    });
    return {
      success: true,
      workspace: rowToWorkspace(workspaceRows(db, context.tenantId).find(row => row.id === workspaceId)!),
    };
  })();
}

export function updateEnterpriseWorkspace(
  db: Database.Database,
  context: RequestContext,
  workspaceIdInput: string,
  input: WorkspaceUpsertInput,
  now = Date.now(),
  action = 'tenant.workspace.updated',
) {
  const workspaceId = assertSafeId(workspaceIdInput, 'workspaceId');
  const updates: string[] = [];
  const params: unknown[] = [];
  if (typeof input.name === 'string' && input.name.trim()) {
    updates.push('name = ?');
    params.push(input.name.trim());
  }
  const quotaPolicy = normalizeJsonObject(input.quotaPolicy, 'quotaPolicy');
  if (quotaPolicy !== undefined) {
    updates.push('quota_policy = ?');
    params.push(quotaPolicy);
  }
  const retentionPolicy = normalizeJsonObject(input.retentionPolicy, 'retentionPolicy');
  if (retentionPolicy !== undefined) {
    updates.push('retention_policy = ?');
    params.push(retentionPolicy);
  }
  if (updates.length === 0) {
    throw new EnterpriseAdminControlPlaneError(400, 'At least one workspace field is required');
  }

  return db.transaction(() => {
    ensureTenantAndActor(db, context, now);
    if (isPersonalWorkspace(db, context.tenantId, workspaceId)
      && typeof input.name === 'string' && input.name.trim()) {
      throw new EnterpriseAdminControlPlaneError(403, 'Personal workspace name is managed by OIDC');
    }
    const result = db.prepare(`
      UPDATE workspaces
      SET ${updates.join(', ')}, updated_at = ?
      WHERE tenant_id = ?
        AND id = ?
    `).run(...params, now, context.tenantId, workspaceId);
    if (result.changes === 0) {
      throw new EnterpriseAdminControlPlaneError(404, 'Workspace not found');
    }
    recordControlPlaneAudit(db, context, action, 'workspace', workspaceId, {
      changedFields: Object.keys(input).filter(key => input[key as keyof WorkspaceUpsertInput] !== undefined),
    });
    return {
      success: true,
      workspace: rowToWorkspace(workspaceRows(db, context.tenantId).find(row => row.id === workspaceId)!),
    };
  })();
}

export function listEnterpriseWorkspaceMembers(
  db: Database.Database,
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = assertSafeId(workspaceIdInput, 'workspaceId');
  const members = db.prepare<unknown[], MemberRow>(`
    SELECT u.id AS user_id, u.email, u.display_name, u.idp_subject, m.role, m.created_at
    FROM memberships m
    JOIN users u
      ON u.tenant_id = m.tenant_id
     AND u.id = m.user_id
    WHERE m.tenant_id = ?
      AND m.workspace_id = ?
    ORDER BY u.email ASC, u.id ASC
  `).all(context.tenantId, workspaceId);
  return {
    success: true,
    members: members.map(member => ({
      userId: member.user_id,
      email: member.email,
      displayName: member.display_name,
      idpSubject: member.idp_subject,
      role: member.role,
      createdAt: member.created_at,
    })),
  };
}

export function upsertEnterpriseWorkspaceMember(
  db: Database.Database,
  context: RequestContext,
  workspaceIdInput: string,
  userIdInput: string,
  input: MemberUpsertInput,
  now = Date.now(),
) {
  const workspaceId = assertSafeId(workspaceIdInput, 'workspaceId');
  const userId = assertSafeId(userIdInput, 'userId');
  const role = input.role ?? 'analyst';
  if (!MEMBER_ROLES.has(role)) {
    throw new EnterpriseAdminControlPlaneError(400, `Invalid role: ${role}`);
  }
  const email = typeof input.email === 'string' && input.email.trim()
    ? input.email.trim()
    : `${userId}@member.local`;
  const displayName = typeof input.displayName === 'string' && input.displayName.trim()
    ? input.displayName.trim()
    : userId;
  const idpSubject = typeof input.idpSubject === 'string' && input.idpSubject.trim()
    ? input.idpSubject.trim()
    : `admin-member:${userId}`;

  return db.transaction(() => {
    ensureTenantAndActor(db, context, now);
    const workspace = db.prepare(`
      SELECT id FROM workspaces
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).get(context.tenantId, workspaceId);
    if (!workspace) {
      throw new EnterpriseAdminControlPlaneError(404, 'Workspace not found');
    }
    if (isPersonalWorkspace(db, context.tenantId, workspaceId)) {
      throw new EnterpriseAdminControlPlaneError(403, 'Personal workspace membership is managed by OIDC');
    }
    const existingRole = getMembershipRole(db, context.tenantId, workspaceId, userId);
    assertMembershipMutationAllowed(context, userId, existingRole, role);
    assertNotLastOrgAdmin(db, context, existingRole, role);
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        idp_subject = excluded.idp_subject,
        updated_at = excluded.updated_at
    `).run(userId, context.tenantId, email, displayName, idpSubject, now, now);
    db.prepare(`
      INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, workspace_id, user_id) DO UPDATE SET
        role = excluded.role
    `).run(context.tenantId, workspaceId, userId, role, now);
    recordControlPlaneAudit(db, context, 'tenant.member.upserted', 'membership', `${workspaceId}:${userId}`, {
      workspaceId,
      userId,
      role,
    });
    return {
      success: true,
      member: listEnterpriseWorkspaceMembers(db, context, workspaceId).members
        .find(member => member.userId === userId),
    };
  })();
}

export function deleteEnterpriseWorkspaceMember(
  db: Database.Database,
  context: RequestContext,
  workspaceIdInput: string,
  userIdInput: string,
) {
  const workspaceId = assertSafeId(workspaceIdInput, 'workspaceId');
  const userId = assertSafeId(userIdInput, 'userId');
  return db.transaction(() => {
    if (isPersonalWorkspace(db, context.tenantId, workspaceId)) {
      throw new EnterpriseAdminControlPlaneError(403, 'Personal workspace membership is managed by OIDC');
    }
    const existingRole = getMembershipRole(db, context.tenantId, workspaceId, userId);
    if (!existingRole) {
      throw new EnterpriseAdminControlPlaneError(404, 'Membership not found');
    }
    assertMembershipMutationAllowed(context, userId, existingRole);
    assertNotLastOrgAdmin(db, context, existingRole);
    db.prepare(`
      DELETE FROM memberships
      WHERE tenant_id = ?
        AND workspace_id = ?
        AND user_id = ?
    `).run(context.tenantId, workspaceId, userId);
    recordControlPlaneAudit(db, context, 'tenant.member.deleted', 'membership', `${workspaceId}:${userId}`, {
      workspaceId,
      userId,
    });
    return { success: true };
  })();
}
