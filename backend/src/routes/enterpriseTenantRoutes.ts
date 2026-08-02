// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Router, type Response } from 'express';

import { authenticate, requireRequestContext, type RequestContext } from '../middleware/auth';
import { openEnterpriseDb } from '../services/enterpriseDb';
import {
  createEnterpriseWorkspace,
  deleteEnterpriseWorkspaceMember,
  EnterpriseAdminControlPlaneError,
  getEnterpriseAdminControlPlaneSummary,
  listEnterpriseWorkspaceMembers,
  listEnterpriseWorkspaces,
  updateEnterpriseWorkspace,
  upsertEnterpriseWorkspaceMember,
  type WorkspaceUpsertInput,
} from '../services/enterpriseAdminControlPlaneService';
import {
  createTenantTombstone,
  getTenantTombstone,
  purgeTenantNow,
  TenantPurgeBlockedError,
  TenantPurgeWindowError,
  type TenantPurgeProof,
} from '../services/enterpriseTenantLifecycleService';
import { sendForbidden } from '../services/rbac';

interface TenantPurgeJob {
  id: string;
  tenantId: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  createdAt: number;
  completedAt?: number;
  proof?: TenantPurgeProof;
  blockers?: unknown[];
  error?: string;
}

const router = Router();
const tenantPurgeJobs = new Map<string, TenantPurgeJob>();

function canDeleteTenant(context: RequestContext): boolean {
  return context.scopes.includes('*')
    || context.scopes.includes('tenant:delete')
    || context.roles.includes('org_admin');
}

function canManageTenant(context: RequestContext): boolean {
  return context.scopes.includes('*')
    || context.scopes.includes('tenant:manage')
    || context.roles.includes('org_admin');
}

function canReadTenantMetadata(context: RequestContext): boolean {
  return canManageTenant(context)
    || context.scopes.includes('tenant:metadata')
    || context.roles.includes('tenant_admin');
}

function canManageWorkspace(context: RequestContext, workspaceId: string): boolean {
  return canManageTenant(context)
    || context.scopes.includes('workspace:manage')
    || context.scopes.includes('quota:manage')
    || (context.roles.includes('workspace_admin') && context.workspaceId === workspaceId);
}

function requireTenantDeletePermission(context: RequestContext, res: Response): boolean {
  if (canDeleteTenant(context)) return true;
  sendForbidden(res, 'Tenant deletion requires org_admin or tenant:delete scope');
  return false;
}

function requireTenantManagePermission(context: RequestContext, res: Response): boolean {
  if (canManageTenant(context)) return true;
  sendForbidden(res, 'Tenant management requires org_admin or tenant:manage scope');
  return false;
}

function requireTenantMetadataPermission(context: RequestContext, res: Response): boolean {
  if (canReadTenantMetadata(context)) return true;
  sendForbidden(res, 'Tenant metadata requires tenant_admin, org_admin, or tenant:metadata scope');
  return false;
}

function requireWorkspaceManagePermission(
  context: RequestContext,
  workspaceId: string,
  res: Response,
): boolean {
  if (canManageWorkspace(context, workspaceId)) return true;
  sendForbidden(res, 'Workspace management requires workspace_admin, workspace:manage, quota:manage, or tenant:manage');
  return false;
}

function sendControlPlaneError(res: Response, error: unknown): void {
  if (error instanceof EnterpriseAdminControlPlaneError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ success: false, error: message || 'Enterprise admin control plane failed' });
}

function requireTenantConfirmation(body: unknown, tenantId: string): string | null {
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return input.confirmTenantId === tenantId ? null : 'confirmTenantId must match the request tenant';
}

router.use(authenticate);

router.get('/admin/summary', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantMetadataPermission(context, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(getEnterpriseAdminControlPlaneSummary(db, context));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.get('/workspaces', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantMetadataPermission(context, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(listEnterpriseWorkspaces(db, context));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.post('/workspaces', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantManagePermission(context, res)) return;
  const db = openEnterpriseDb();
  try {
    res.status(201).json(createEnterpriseWorkspace(db, context, req.body as WorkspaceUpsertInput));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.patch('/workspaces/:workspaceId', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireWorkspaceManagePermission(context, req.params.workspaceId, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(updateEnterpriseWorkspace(db, context, req.params.workspaceId, req.body as WorkspaceUpsertInput));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.patch('/workspaces/:workspaceId/policies', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireWorkspaceManagePermission(context, req.params.workspaceId, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(updateEnterpriseWorkspace(
      db,
      context,
      req.params.workspaceId,
      req.body as WorkspaceUpsertInput,
      Date.now(),
      'tenant.workspace.policy_updated',
    ));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.get('/workspaces/:workspaceId/members', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireWorkspaceManagePermission(context, req.params.workspaceId, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(listEnterpriseWorkspaceMembers(db, context, req.params.workspaceId));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.put('/workspaces/:workspaceId/members/:userId', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireWorkspaceManagePermission(context, req.params.workspaceId, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(upsertEnterpriseWorkspaceMember(
      db,
      context,
      req.params.workspaceId,
      req.params.userId,
      req.body ?? {},
    ));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.delete('/workspaces/:workspaceId/members/:userId', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireWorkspaceManagePermission(context, req.params.workspaceId, res)) return;
  const db = openEnterpriseDb();
  try {
    res.json(deleteEnterpriseWorkspaceMember(db, context, req.params.workspaceId, req.params.userId));
  } catch (error) {
    sendControlPlaneError(res, error);
  } finally {
    db.close();
  }
});

router.post('/tombstone', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantDeletePermission(context, res)) return;
  const confirmationError = requireTenantConfirmation(req.body, context.tenantId);
  if (confirmationError) {
    return res.status(400).json({ success: false, error: confirmationError });
  }

  const db = openEnterpriseDb();
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const tombstone = createTenantTombstone(db, context, reason);
    res.status(202).json({
      success: true,
      tombstone,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to tombstone tenant',
    });
  } finally {
    db.close();
  }
});

router.get('/tombstone', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantDeletePermission(context, res)) return;

  const db = openEnterpriseDb();
  try {
    res.json({
      success: true,
      tombstone: getTenantTombstone(db, context.tenantId),
    });
  } finally {
    db.close();
  }
});

router.post('/purge', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantDeletePermission(context, res)) return;
  const confirmationError = requireTenantConfirmation(req.body, context.tenantId);
  if (confirmationError) {
    return res.status(400).json({ success: false, error: confirmationError });
  }

  const db = openEnterpriseDb();
  try {
    const tombstone = getTenantTombstone(db, context.tenantId);
    if (!tombstone) {
      return res.status(404).json({
        success: false,
        error: 'Tenant tombstone not found',
      });
    }
    if (tombstone.purgeAfter > Date.now()) {
      return res.status(409).json({
        success: false,
        code: 'TENANT_PURGE_WINDOW_ACTIVE',
        error: 'Tenant purge window has not elapsed',
        purgeAfter: tombstone.purgeAfter,
      });
    }
  } finally {
    db.close();
  }

  const jobId = `tenant-purge-${context.tenantId}-${Date.now()}`;
  const job: TenantPurgeJob = {
    id: jobId,
    tenantId: context.tenantId,
    status: 'running',
    createdAt: Date.now(),
  };
  tenantPurgeJobs.set(jobId, job);
  setImmediate(async () => {
    const jobDb = openEnterpriseDb();
    try {
      job.proof = await purgeTenantNow(jobDb, context);
      job.status = 'completed';
      job.completedAt = Date.now();
    } catch (error: any) {
      job.completedAt = Date.now();
      if (error instanceof TenantPurgeBlockedError) {
        job.status = 'blocked';
        job.blockers = error.blockers;
      } else if (error instanceof TenantPurgeWindowError) {
        job.status = 'failed';
        job.error = error.message;
      } else {
        job.status = 'failed';
        job.error = error.message || 'Tenant purge failed';
      }
    } finally {
      jobDb.close();
    }
  });

  res.status(202).json({
    success: true,
    jobId,
    status: job.status,
  });
});

router.get('/purge/:jobId', (req, res) => {
  const context = requireRequestContext(req);
  if (!requireTenantDeletePermission(context, res)) return;
  const job = tenantPurgeJobs.get(req.params.jobId);
  if (!job || job.tenantId !== context.tenantId) {
    return res.status(404).json({
      success: false,
      error: 'Tenant purge job not found',
    });
  }
  res.json({
    success: true,
    job,
  });
});

export function resetTenantPurgeJobsForTests(): void {
  tenantPurgeJobs.clear();
}

export default router;
