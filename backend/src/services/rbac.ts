// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Response } from 'express';
import type { RequestContext } from '../middleware/auth';
import {
  isOwnedByContext,
  normalizeResourceOwner,
  type ResourceOwnerFields,
} from './resourceOwnership';

export type RbacPermission =
  | 'trace:read'
  | 'trace:write'
  | 'trace:download'
  | 'trace:delete_own'
  | 'trace:delete_any'
  | 'agent:run'
  | 'report:read'
  | 'report:delete'
  | 'analysis_result:read'
  | 'analysis_result:create'
  | 'analysis_result:share'
  | 'analysis_result:delete'
  | 'comparison:create'
  | 'comparison:read'
  | 'codebase:read'
  | 'codebase:manage'
  | 'codebase:admin'
  | 'provider:manage_workspace'
  | 'provider:manage_org'
  | 'audit:read'
  | 'runtime:manage'
  | 'self_evolution:read'
  | 'self_evolution:curate'
  | 'self_evolution:apply'
  | 'self_evolution:export'
  | 'self_evolution:revert';

const ROLE_PERMISSIONS: Record<string, RbacPermission[]> = {
  viewer: ['trace:read', 'report:read', 'analysis_result:read', 'comparison:read'],
  analyst: [
    'trace:read',
    'trace:write',
    'trace:download',
    'trace:delete_own',
    'agent:run',
    'report:read',
    'analysis_result:read',
    'analysis_result:create',
    'analysis_result:share',
    'comparison:create',
    'comparison:read',
    'codebase:read',
    'self_evolution:read',
  ],
  workspace_admin: [
    'trace:read',
    'trace:write',
    'trace:download',
    'trace:delete_own',
    'trace:delete_any',
    'agent:run',
    'report:read',
    'report:delete',
    'analysis_result:read',
    'analysis_result:create',
    'analysis_result:share',
    'analysis_result:delete',
    'comparison:create',
    'comparison:read',
    'codebase:read',
    'codebase:manage',
    'provider:manage_workspace',
    'audit:read',
    'runtime:manage',
    'self_evolution:read',
    'self_evolution:curate',
    'self_evolution:apply',
    'self_evolution:export',
    'self_evolution:revert',
  ],
  org_admin: [
    'trace:read',
    'trace:write',
    'trace:download',
    'trace:delete_own',
    'trace:delete_any',
    'agent:run',
    'report:read',
    'report:delete',
    'analysis_result:read',
    'analysis_result:create',
    'analysis_result:share',
    'analysis_result:delete',
    'comparison:create',
    'comparison:read',
    'codebase:read',
    'codebase:manage',
    'codebase:admin',
    'provider:manage_workspace',
    'provider:manage_org',
    'audit:read',
    'runtime:manage',
    'self_evolution:read',
    'self_evolution:curate',
    'self_evolution:apply',
    'self_evolution:export',
    'self_evolution:revert',
  ],
};

const SCOPE_IMPLICATIONS: Partial<Record<RbacPermission, string[]>> = {
  'trace:delete_own': ['trace:write', 'trace:delete'],
  'trace:delete_any': ['trace:delete:any'],
  'report:delete': ['report:write'],
  'analysis_result:share': ['analysis_result:write'],
  'analysis_result:delete': ['analysis_result:write', 'analysis_result:delete_any'],
};

export function hasRbacPermission(context: RequestContext, permission: RbacPermission): boolean {
  if (context.scopes.includes('*')) return true;
  if (context.scopes.includes(permission)) return true;
  if (SCOPE_IMPLICATIONS[permission]?.some(scope => context.scopes.includes(scope))) return true;
  return context.roles.some(role => ROLE_PERMISSIONS[role]?.includes(permission));
}

export function sharesWorkspaceWithContext(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  const owner = normalizeResourceOwner(resource);
  return owner.tenantId === context.tenantId && owner.workspaceId === context.workspaceId;
}

export function canReadTraceResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  return sharesWorkspaceWithContext(resource, context) && hasRbacPermission(context, 'trace:read');
}

export function canDownloadTraceResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  return sharesWorkspaceWithContext(resource, context)
    && (hasRbacPermission(context, 'trace:download') || hasRbacPermission(context, 'trace:read'));
}

export function canDeleteTraceResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  if (!sharesWorkspaceWithContext(resource, context)) return false;
  if (hasRbacPermission(context, 'trace:delete_any')) return true;
  return isOwnedByContext(resource, context) && hasRbacPermission(context, 'trace:delete_own');
}

export function canReadReportResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  return sharesWorkspaceWithContext(resource, context) && hasRbacPermission(context, 'report:read');
}

export function canDeleteReportResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  if (!sharesWorkspaceWithContext(resource, context)) return false;
  if (hasRbacPermission(context, 'report:delete')) return true;
  return isOwnedByContext(resource, context) && hasRbacPermission(context, 'report:delete');
}

export function canReadAnalysisResultResource(
  resource: (ResourceOwnerFields & { visibility?: string | null }) | null | undefined,
  context: RequestContext,
): boolean {
  if (!sharesWorkspaceWithContext(resource, context)) return false;
  if (!hasRbacPermission(context, 'analysis_result:read')) return false;
  if (resource?.visibility === 'workspace') return true;
  return isOwnedByContext(resource, context);
}

export function canCreateAnalysisResultResource(context: RequestContext): boolean {
  return hasRbacPermission(context, 'analysis_result:create');
}

export function canShareAnalysisResultResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  if (!sharesWorkspaceWithContext(resource, context)) return false;
  if (!hasRbacPermission(context, 'analysis_result:share')) return false;
  if (isOwnedByContext(resource, context)) return true;
  return hasRbacPermission(context, 'analysis_result:delete');
}

export function canDeleteAnalysisResultResource(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  if (!sharesWorkspaceWithContext(resource, context)) return false;
  if (hasRbacPermission(context, 'analysis_result:delete')) return true;
  return false;
}

export function sendForbidden(res: Response, details = 'Forbidden'): Response {
  return res.status(403).json({
    success: false,
    error: 'Forbidden',
    details,
  });
}
