// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RequestContext} from '../../middleware/auth';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../utils/localDevIdentity';
import {
  canCreateAnalysisResultResource,
  canShareAnalysisResultResource,
  canDeleteTraceResource,
  canReadReportResource,
  canReadTraceResource,
  hasRbacPermission,
  sharesWorkspaceWithContext,
} from '../rbac';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

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

    expect(hasRbacPermission(context('personal_workspace_owner'), 'trace:delete_any')).toBe(true);
    expect(hasRbacPermission(context('personal_workspace_owner'), 'provider:manage_workspace')).toBe(true);
    expect(hasRbacPermission(context('personal_workspace_owner'), 'runtime:manage')).toBe(false);
    expect(hasRbacPermission(context('personal_workspace_owner'), 'audit:read')).toBe(false);
    expect(hasRbacPermission(context('personal_workspace_owner'), 'self_evolution:apply')).toBe(false);

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

    expect(canCreateAnalysisResultResource(analyst)).toBe(true);
    expect(canCreateAnalysisResultResource(viewer)).toBe(false);
    expect(canShareAnalysisResultResource(ownPrivateResult, analyst)).toBe(true);
    expect(canShareAnalysisResultResource(peerPrivateResult, analyst)).toBe(false);
  });

  test('keeps reports of private or unknown analysis context with their creator', () => {
    const analyst = context('analyst');
    const viewer = context('viewer');
    const own = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: analyst.userId};
    const peer = {...own, userId: 'peer-user'};
    for (const privateContext of [{codebase: true, knowledge: false}, {codebase: false, knowledge: true},
      'unknown' as const]) {
      expect(canReadReportResource({...peer, privateContext}, viewer)).toBe(false);
      expect(canReadReportResource({...own, privateContext}, analyst)).toBe(true);
    }
    expect(canReadReportResource({...peer, privateContext: NO_PRIVATE_CONTEXT}, viewer)).toBe(true);
    expect(canReadReportResource({...peer, privateContext: NO_PRIVATE_CONTEXT, tenantId: 'tenant-b'}, viewer)).toBe(false);
  });

  test('treats a local artifact without a recorded creator as the local user\'s own', () => {
    const local: RequestContext = {tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID,
      userId: DEFAULT_DEV_USER_ID, authType: 'dev', roles: ['org_admin'], scopes: ['*'], requestId: 'req-local'};
    // No owner fields at all: a report or snapshot written before accounts existed.
    const legacy = {};
    expect(canReadReportResource({...legacy, privateContext: 'unknown'}, local)).toBe(true);
  });

  test('admits no account to a restricted artifact whose creator is unknown', () => {
    const admin = context('org_admin', ['*']);
    // Never recorded, or nulled when the creating user was deleted.
    const orphan = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
    expect(canReadReportResource({...orphan, privateContext: {codebase: true, knowledge: false}}, admin)).toBe(false);
    // An account named like the local user is not the local identity.
    const impostor = {...context('analyst'), userId: DEFAULT_DEV_USER_ID};
    expect(canReadReportResource({...orphan, privateContext: 'unknown'}, impostor)).toBe(false);
    // Unrestricted artifacts keep their existing owner-less behaviour.
    expect(canReadReportResource({...orphan, privateContext: NO_PRIVATE_CONTEXT}, admin)).toBe(true);
  });
});
