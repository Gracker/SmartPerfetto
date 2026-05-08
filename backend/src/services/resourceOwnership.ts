// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Response } from 'express';
import {
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
  type RequestContext,
} from '../middleware/auth';

export interface ResourceOwnerFields {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  /** Compatibility for any interim code that used ownerUserId before the schema settled. */
  ownerUserId?: string;
}

export interface NormalizedResourceOwner {
  tenantId: string;
  workspaceId: string;
  userId: string;
}

const normalizeOwnerId = (value: unknown): string => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

export function ownerFieldsFromContext(context: RequestContext): NormalizedResourceOwner {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

export function normalizeResourceOwner(resource: ResourceOwnerFields | null | undefined): NormalizedResourceOwner {
  return {
    tenantId: normalizeOwnerId(resource?.tenantId) || DEFAULT_TENANT_ID,
    workspaceId: normalizeOwnerId(resource?.workspaceId) || DEFAULT_WORKSPACE_ID,
    userId: normalizeOwnerId(resource?.userId ?? resource?.ownerUserId) || DEFAULT_DEV_USER_ID,
  };
}

export function isOwnedByContext(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  const owner = normalizeResourceOwner(resource);
  return owner.tenantId === context.tenantId
    && owner.workspaceId === context.workspaceId
    && owner.userId === context.userId;
}

export function ownersMatch(
  resource: ResourceOwnerFields | null | undefined,
  ownerFields: ResourceOwnerFields | null | undefined,
): boolean {
  const left = normalizeResourceOwner(resource);
  const right = normalizeResourceOwner(ownerFields);
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId
    && left.userId === right.userId;
}

export function isPrivilegedRequestContext(context: RequestContext): boolean {
  return context.roles.includes('org_admin') || context.scopes.includes('*');
}

export function sendResourceNotFound(res: Response, error = 'Resource not found'): Response {
  return res.status(404).json({
    success: false,
    error,
  });
}
