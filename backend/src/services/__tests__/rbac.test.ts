// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { RequestContext } from '../../middleware/auth';
import {
  canCreateAnalysisResultResource,
  canReadAnalysisResultResource,
  canShareAnalysisResultResource,
  canDeleteTraceResource,
  canReadTraceResource,
  hasRbacPermission,
  sharesWorkspaceWithContext,
} from '../rbac';

function context(role: string, scopes: string[] = []): RequestContext {
  return {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: `${role}-user`,
    authType: 'sso',
    roles: [role],
    scopes,
    requestId: `req-${role}`,
  };
}

describe('enterprise RBAC matrix', () => {
  test('maps viewer, analyst, workspace admin, and org admin role permissions', () => {
    expect(hasRbacPermission(context('viewer'), 'trace:read')).toBe(true);
    expect(hasRbacPermission(context('viewer'), 'analysis_result:read')).toBe(true);
    expect(hasRbacPermission(context('viewer'), 'codebase:read')).toBe(false);
    expect(hasRbacPermission(context('viewer'), 'analysis_result:create')).toBe(false);
    expect(hasRbacPermission(context('viewer'), 'trace:write')).toBe(false);
    expect(hasRbacPermission(context('viewer'), 'agent:run')).toBe(false);
    expect(hasRbacPermission(context('viewer'), 'self_evolution:read')).toBe(false);

    expect(hasRbacPermission(context('analyst'), 'trace:write')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'agent:run')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'analysis_result:create')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'comparison:create')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'codebase:read')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'codebase:manage')).toBe(false);
    expect(hasRbacPermission(context('analyst'), 'trace:delete_any')).toBe(false);
    expect(hasRbacPermission(context('analyst'), 'self_evolution:read')).toBe(true);
    expect(hasRbacPermission(context('analyst'), 'self_evolution:apply')).toBe(false);

    expect(hasRbacPermission(context('workspace_admin'), 'trace:delete_any')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'analysis_result:delete')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'provider:manage_workspace')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'provider:manage_org')).toBe(false);
    expect(hasRbacPermission(context('workspace_admin'), 'runtime:manage')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'codebase:manage')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'codebase:admin')).toBe(false);
    expect(hasRbacPermission(context('workspace_admin'), 'self_evolution:curate')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'self_evolution:apply')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'self_evolution:export')).toBe(true);
    expect(hasRbacPermission(context('workspace_admin'), 'self_evolution:revert')).toBe(true);

    expect(hasRbacPermission(context('org_admin'), 'provider:manage_org')).toBe(true);
    expect(hasRbacPermission(context('org_admin'), 'runtime:manage')).toBe(true);
    expect(hasRbacPermission(context('org_admin'), 'codebase:admin')).toBe(true);
    expect(hasRbacPermission(context('org_admin'), 'self_evolution:revert')).toBe(true);
  });

  test('lets explicit scopes authorize API key contexts without granting unrelated permissions', () => {
    const apiKeyContext: RequestContext = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'api-key-owner',
      authType: 'api_key',
      roles: ['api_key'],
      scopes: ['trace:read', 'agent:run'],
      requestId: 'req-api-key',
    };

    expect(hasRbacPermission(apiKeyContext, 'trace:read')).toBe(true);
    expect(hasRbacPermission(apiKeyContext, 'agent:run')).toBe(true);
    expect(hasRbacPermission({
      ...apiKeyContext,
      scopes: ['analysis_result:write'],
    }, 'analysis_result:share')).toBe(true);
    expect(hasRbacPermission(apiKeyContext, 'trace:write')).toBe(false);
  });

  test('combines owner guard with role permissions for workspace resources', () => {
    const peerTrace = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'peer-user',
    };
    const analyst = context('analyst');
    const admin = context('workspace_admin');

    expect(sharesWorkspaceWithContext(peerTrace, analyst)).toBe(true);
    expect(canReadTraceResource(peerTrace, context('viewer'))).toBe(true);
    expect(canDeleteTraceResource(peerTrace, analyst)).toBe(false);
    expect(canDeleteTraceResource(peerTrace, admin)).toBe(true);

    expect(canReadTraceResource({
      ...peerTrace,
      tenantId: 'tenant-b',
    }, admin)).toBe(false);
  });

  test('combines owner guard, visibility, and role permissions for analysis results', () => {
    const analyst = context('analyst');
    const viewer = context('viewer');
    const ownPrivateResult = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: analyst.userId,
      visibility: 'private',
    };
    const peerPrivateResult = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'peer-user',
      visibility: 'private',
    };
    const peerWorkspaceResult = {
      ...peerPrivateResult,
      visibility: 'workspace',
    };

    expect(canCreateAnalysisResultResource(analyst)).toBe(true);
    expect(canCreateAnalysisResultResource(viewer)).toBe(false);
    expect(canReadAnalysisResultResource(ownPrivateResult, analyst)).toBe(true);
    expect(canReadAnalysisResultResource(peerPrivateResult, analyst)).toBe(false);
    expect(canReadAnalysisResultResource(peerWorkspaceResult, viewer)).toBe(true);
    expect(canShareAnalysisResultResource(ownPrivateResult, analyst)).toBe(true);
    expect(canShareAnalysisResultResource(peerPrivateResult, analyst)).toBe(false);
  });
});
