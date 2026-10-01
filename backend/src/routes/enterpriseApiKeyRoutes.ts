// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {
  authenticate,
  requireRequestContext,
  type AuthenticatedRequest,
  type RequestContext,
} from '../middleware/auth';
import { sendRouteError } from '../middleware/routeFailure';
import {
  ApiKeyRequestError,
  EnterpriseApiKeyService,
  type CreateEnterpriseApiKeyInput,
} from '../services/enterpriseApiKeyService';

interface EnterpriseApiKeyRouteDeps {
  apiKeyService?: EnterpriseApiKeyService;
}

function hasScope(context: RequestContext, scope: string): boolean {
  return context.scopes.includes('*') || context.scopes.includes(scope);
}

function canReadApiKeys(context: RequestContext): boolean {
  return hasScope(context, 'api_key:read')
    || hasScope(context, 'api_key:write')
    || context.roles.includes('workspace_admin')
    || context.roles.includes('org_admin');
}

function canWriteApiKeys(context: RequestContext): boolean {
  return hasScope(context, 'api_key:write')
    || context.roles.includes('workspace_admin')
    || context.roles.includes('org_admin');
}

function forbidden(res: express.Response): void {
  res.status(403).json({
    success: false,
    error: 'Forbidden',
    details: 'API key management requires api_key:write scope or workspace/org admin role',
  });
}

function createInputFromBody(body: any): CreateEnterpriseApiKeyInput {
  return {
    name: typeof body?.name === 'string' ? body.name : undefined,
    workspaceId: body?.workspaceId === null || typeof body?.workspaceId === 'string'
      ? body.workspaceId
      : undefined,
    ownerUserId: body?.ownerUserId === null || typeof body?.ownerUserId === 'string'
      ? body.ownerUserId
      : undefined,
    scopes: body?.scopes,
    expiresAt: body?.expiresAt,
  };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export function createEnterpriseApiKeyRouter(deps: EnterpriseApiKeyRouteDeps = {}): express.Router {
  const router = express.Router();
  const getService = () => deps.apiKeyService || EnterpriseApiKeyService.getInstance();

  router.get('/api-keys', authenticate, (req, res) => {
    const context = requireRequestContext(req);
    if (!canReadApiKeys(context)) {
      forbidden(res);
      return;
    }
    res.json({
      success: true,
      apiKeys: getService().listApiKeys(context),
    });
  });

  router.post('/api-keys', authenticate, (req: AuthenticatedRequest, res) => {
    const context = requireRequestContext(req);
    if (!canWriteApiKeys(context)) {
      forbidden(res);
      return;
    }
    try {
      const created = getService().createApiKey(context, createInputFromBody(req.body));
      res.status(201).json({
        success: true,
        apiKey: created.apiKey,
        token: created.token,
      });
    } catch (error) {
      sendRouteError(res, error, {
        code: 'api_key_create_failed',
        error: 'Failed to create API key',
        logLabel: '[EnterpriseApiKeyRoutes] Create error',
      }, [ApiKeyRequestError]);
    }
  });

  router.post('/api-keys/:id/revoke', authenticate, (req, res) => {
    const context = requireRequestContext(req);
    if (!canWriteApiKeys(context)) {
      forbidden(res);
      return;
    }
    const revoked = getService().revokeApiKey(context, firstParam(req.params.id));
    if (!revoked) {
      res.status(404).json({
        success: false,
        error: 'API key not found',
      });
      return;
    }
    res.json({
      success: true,
      apiKey: revoked,
    });
  });

  router.delete('/api-keys/:id', authenticate, (req, res) => {
    const context = requireRequestContext(req);
    if (!canWriteApiKeys(context)) {
      forbidden(res);
      return;
    }
    const revoked = getService().revokeApiKey(context, firstParam(req.params.id));
    if (!revoked) {
      res.status(404).json({
        success: false,
        error: 'API key not found',
      });
      return;
    }
    res.json({
      success: true,
      apiKey: revoked,
    });
  });

  return router;
}

export default createEnterpriseApiKeyRouter();
