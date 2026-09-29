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
import type { EnterpriseRepositoryScope } from './enterpriseRepository';
import { unrestrictedPrivateContextSql } from './security/analysisPrivateContext';

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

/**
 * The local single-user identity, which owns everything written without an
 * account. Only it may claim an artifact whose creator was never recorded.
 */
export function isLocalDevRequestContext(context: RequestContext): boolean {
  return context.authType === 'dev' && context.userId === DEFAULT_DEV_USER_ID;
}

/**
 * Creator check for an artifact whose audience is restricted to its creator.
 * Unlike isOwnedByContext, a missing creator is not read as the dev user:
 * under accounts it means unknown (never recorded, or the user was deleted
 * and the reference nulled), and an unknown creator admits no one.
 */
export function isRecordedCreatorOf(
  resource: ResourceOwnerFields | null | undefined,
  context: RequestContext,
): boolean {
  const recorded = Boolean(normalizeOwnerId(resource?.userId ?? resource?.ownerUserId));
  return isOwnedByContext(resource, context) && (recorded || isLocalDevRequestContext(context));
}

/**
 * SQL audience of an artifact a private context can restrict: its recorded
 * creator (isRecordedCreatorOf) always, and whoever the artifact's own rule
 * admits only while it is known to be unrestricted (`private_context = 0`).
 * Scope the statement to the tenant and workspace separately.
 */
export function restrictableArtifactAudienceSql(columnPrefix: string, unrestrictedAudienceSql: string): string {
  const createdBy = `${columnPrefix}created_by`;
  return `(${createdBy} = @userId OR (${createdBy} IS NULL AND @localDevIdentity = 1) ` +
    `OR (${unrestrictedPrivateContextSql(`${columnPrefix}private_context`)} AND ${unrestrictedAudienceSql}))`;
}

export function restrictableArtifactAudienceParams(scope: EnterpriseRepositoryScope): {
  userId: string | null;
  localDevIdentity: 0 | 1;
} {
  return {userId: scope.userId ?? null, localDevIdentity: scope.localDevIdentity ? 1 : 0};
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

export function sendResourceNotFound(
  res: Response,
  error = 'Resource not found',
  code?: string,
): Response {
  return res.status(404).json({
    success: false,
    error,
    ...(code ? {code} : {}),
  });
}
