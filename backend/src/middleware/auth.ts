// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ErrorResponse } from '../types';

type RequestContextAuthType = 'sso' | 'api_key' | 'dev';

interface RequestContext {
  tenantId: string;
  workspaceId: string;
  userId: string;
  authType: RequestContextAuthType;
  roles: string[];
  scopes: string[];
  requestId: string;
  windowId?: string;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    subscription: string;
  };
  requestContext?: RequestContext;
}

const API_KEY_ENV = 'SMARTPERFETTO_API_KEY';
export const DEFAULT_TENANT_ID = 'default-dev-tenant';
export const DEFAULT_WORKSPACE_ID = 'default-workspace';
export const DEFAULT_DEV_USER_ID = 'dev-user-123';
const USAGE_WINDOW_MS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_WINDOW_MS || '', 10) || 24 * 60 * 60 * 1000;
const MAX_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_REQUESTS || '', 10);
const MAX_TRACE_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS || '', 10);

const usageTracker = new Map<string, { resetAt: number; total: number; trace: number }>();

const getProvidedApiKey = (req: Request): string | undefined => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
    return headerKey.trim();
  }
  return undefined;
};

const safeEquals = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const hashApiKey = (apiKey: string): string =>
  crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8);

const sanitizeContextId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
};

const getHeaderValue = (req: Request, name: string): string => {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
};

const buildRequestContext = (
  req: Request,
  userId: string,
  authType: RequestContextAuthType,
): RequestContext => {
  const tenantId = sanitizeContextId(getHeaderValue(req, 'x-tenant-id')) || DEFAULT_TENANT_ID;
  const workspaceId = sanitizeContextId(getHeaderValue(req, 'x-workspace-id')) || DEFAULT_WORKSPACE_ID;
  const requestId =
    sanitizeContextId(getHeaderValue(req, 'x-request-id')) ||
    `req-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const windowId = sanitizeContextId(getHeaderValue(req, 'x-window-id')) || undefined;

  return {
    tenantId,
    workspaceId,
    userId,
    authType,
    roles: authType === 'dev' ? ['org_admin'] : ['analyst'],
    scopes: authType === 'dev'
      ? ['*']
      : ['trace:read', 'trace:write', 'agent:run', 'report:read'],
    requestId,
    ...(windowId ? { windowId } : {}),
  };
};

export const getRequestContext = (req: Request): RequestContext | undefined =>
  (req as AuthenticatedRequest).requestContext;

export const requireRequestContext = (req: Request): RequestContext => {
  const context = getRequestContext(req);
  if (!context) {
    throw new Error('RequestContext is missing. Did you forget to mount authenticate/attachRequestContext?');
  }
  return context;
};

/**
 * Authentication middleware - API key based (optional for dev)
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const configuredKey = process.env[API_KEY_ENV];
  if (!configuredKey) {
    // No auth configured: use mock user
    req.user = {
      id: DEFAULT_DEV_USER_ID,
      email: 'dev@example.com',
      subscription: 'pro',
    };
    req.requestContext = buildRequestContext(req, req.user.id, 'dev');
    next();
    return;
  }

  const providedKey = getProvidedApiKey(req);
  if (!providedKey || !safeEquals(providedKey, configuredKey)) {
    const error: ErrorResponse = {
      error: 'Unauthorized',
      details: 'Invalid or missing API key',
    };
    res.status(401).json(error);
    return;
  }

  req.user = {
    id: `api-key-${hashApiKey(providedKey)}`,
    email: '',
    subscription: 'pro',
  };
  req.requestContext = buildRequestContext(req, req.user.id, 'api_key');
  next();
};

export const attachRequestContext = authenticate;

/**
 * Usage check middleware - in-memory rate limiting (optional)
 */
export const checkUsage = (isTraceAnalysis: boolean = false) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const hasTotalLimit = Number.isFinite(MAX_REQUESTS);
    const hasTraceLimit = Number.isFinite(MAX_TRACE_REQUESTS);

    if (!hasTotalLimit && !hasTraceLimit) {
      next();
      return;
    }

    const apiKey = getProvidedApiKey(req);
    const identity = req.user?.id
      || (apiKey ? `api-key-${hashApiKey(apiKey)}` : undefined)
      || req.ip
      || 'anonymous';

    const now = Date.now();
    const entry = usageTracker.get(identity);
    const record = entry && entry.resetAt > now
      ? entry
      : { resetAt: now + USAGE_WINDOW_MS, total: 0, trace: 0 };

    record.total += 1;
    if (isTraceAnalysis) {
      record.trace += 1;
    }

    usageTracker.set(identity, record);

    if (hasTotalLimit && record.total > MAX_REQUESTS) {
      const error: ErrorResponse = {
        error: 'Usage limit exceeded',
        details: `Exceeded max requests (${MAX_REQUESTS}) in current window`,
      };
      res.status(429).json(error);
      return;
    }

    if (isTraceAnalysis && hasTraceLimit && record.trace > MAX_TRACE_REQUESTS) {
      const error: ErrorResponse = {
        error: 'Trace analysis limit exceeded',
        details: `Exceeded max trace analyses (${MAX_TRACE_REQUESTS}) in current window`,
      };
      res.status(429).json(error);
      return;
    }

    next();
  };
};

export type { AuthenticatedRequest };
export type { RequestContext, RequestContextAuthType };
