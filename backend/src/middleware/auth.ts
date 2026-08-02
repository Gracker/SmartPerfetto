// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ErrorResponse } from '../types';
import { isOidcConfigurationPresent, resolveFeatureConfig } from '../config';
import {
  EnterpriseApiKeyService,
  requestHasEnterpriseApiKeyCredential,
} from '../services/enterpriseApiKeyService';
import { EnterpriseSsoService } from '../services/enterpriseSsoService';

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
const SSO_TRUSTED_HEADERS_ENV = 'SMARTPERFETTO_SSO_TRUSTED_HEADERS';
const SSO_SESSION_TOKEN_PREFIX = 'sp_sso_';
const SSO_SESSION_COOKIE_NAME = 'sp_sso_session';
export const DEFAULT_TENANT_ID = 'default-dev-tenant';
export const DEFAULT_WORKSPACE_ID = 'default-workspace';
export const DEFAULT_DEV_USER_ID = 'dev-user-123';
const USAGE_WINDOW_MS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_WINDOW_MS || '', 10) || 24 * 60 * 60 * 1000;
const MAX_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_REQUESTS || '', 10);
const MAX_TRACE_REQUESTS = Number.parseInt(process.env.SMARTPERFETTO_USAGE_MAX_TRACE_REQUESTS || '', 10);

const usageTracker = new Map<string, { resetAt: number; total: number; trace: number }>();

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function enforceSsoCookieMutationProtection(
  req: Request,
  res: Response,
  service: EnterpriseSsoService,
): boolean {
  if (typeof req.headers.authorization === 'string'
    && req.headers.authorization.startsWith(`Bearer ${SSO_SESSION_TOKEN_PREFIX}`)) {
    return true;
  }
  if (isSafeMethod(req.method) || !service.isCookieAuthenticatedRequest(req)) return true;
  const configuredFrontendUrl = process.env.FRONTEND_URL?.trim();
  const origin = req.headers.origin;
  if (origin && configuredFrontendUrl) {
    try {
      if (new URL(origin).origin !== new URL(configuredFrontendUrl).origin) {
        res.status(403).json({ error: 'Forbidden', details: 'Invalid request origin' });
        return false;
      }
    } catch {
      res.status(403).json({ error: 'Forbidden', details: 'Invalid request origin' });
      return false;
    }
  }
  const csrfToken = typeof req.headers['x-csrf-token'] === 'string'
    ? req.headers['x-csrf-token']
    : undefined;
  if (!service.verifyCsrfTokenForRequest(req, csrfToken)) {
    res.status(403).json({ error: 'Forbidden', details: 'Invalid CSRF token' });
    return false;
  }
  return true;
}

interface ResolvedIdentity {
  userId: string;
  email: string;
  subscription: string;
  authType: RequestContextAuthType;
  tenantId?: string;
  workspaceId?: string;
  roles?: string[];
  scopes?: string[];
}

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

const requestHasSsoSessionCredential = (req: Request): boolean => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim().startsWith(SSO_SESSION_TOKEN_PREFIX);
  }
  return typeof req.headers.cookie === 'string'
    && req.headers.cookie.split(';').some((cookie) => {
      const [name, value = ''] = cookie.trim().split('=');
      return name === SSO_SESSION_COOKIE_NAME
        && decodeURIComponent(value).startsWith(SSO_SESSION_TOKEN_PREFIX);
    });
};

const requestHasOidcSessionCredential = (req: Request): boolean => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim().startsWith(SSO_SESSION_TOKEN_PREFIX);
  }
  return typeof req.headers.cookie === 'string'
    && req.headers.cookie.split(';').some((cookie) => {
      const part = cookie.trim();
      const separator = part.indexOf('=');
      if (separator <= 0 || part.slice(0, separator) !== SSO_SESSION_COOKIE_NAME) return false;
      try {
        return decodeURIComponent(part.slice(separator + 1))
          .startsWith(SSO_SESSION_TOKEN_PREFIX);
      } catch {
        return false;
      }
    });
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

const truthyEnv = (value: string | undefined): boolean => {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase());
};

const sanitizeContextId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
};

const sanitizeHeaderText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\r\n]/g, '').slice(0, 320);
};

const getHeaderValue = (req: Request, name: string): string => {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
};

const getFirstHeaderValue = (req: Request, names: string[]): string => {
  for (const name of names) {
    const value = getHeaderValue(req, name);
    if (value.trim().length > 0) return value;
  }
  return '';
};

const parseHeaderList = (req: Request, names: string[], fallback: string[]): string[] => {
  const raw = getFirstHeaderValue(req, names);
  if (!raw.trim()) return fallback;
  const parsed = raw
    .split(',')
    .map(value => sanitizeContextId(value))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
};

const defaultRolesForAuthType = (authType: RequestContextAuthType): string[] =>
  authType === 'dev' ? ['org_admin'] : ['analyst'];

const defaultScopesForAuthType = (authType: RequestContextAuthType): string[] =>
  authType === 'dev'
    ? ['*']
    : ['trace:read', 'trace:write', 'agent:run', 'report:read'];

const buildRequestContext = (req: Request, identity: ResolvedIdentity): RequestContext => {
  const tenantId = identity.tenantId
    || sanitizeContextId(getFirstHeaderValue(req, ['x-tenant-id', 'x-sso-tenant-id']))
    || DEFAULT_TENANT_ID;
  const workspaceId = identity.workspaceId || (
    identity.authType === 'api_key'
      ? DEFAULT_WORKSPACE_ID
      : sanitizeContextId(getFirstHeaderValue(req, ['x-workspace-id', 'x-sso-workspace-id']))
        || DEFAULT_WORKSPACE_ID
  );
  const requestId =
    sanitizeContextId(getHeaderValue(req, 'x-request-id')) ||
    `req-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const windowId = sanitizeContextId(getHeaderValue(req, 'x-window-id')) || undefined;

  return {
    tenantId,
    workspaceId,
    userId: identity.userId,
    authType: identity.authType,
    roles: identity.roles ?? defaultRolesForAuthType(identity.authType),
    scopes: identity.scopes ?? defaultScopesForAuthType(identity.authType),
    requestId,
    ...(windowId ? { windowId } : {}),
  };
};

const makeDevIdentity = (): ResolvedIdentity => ({
  userId: DEFAULT_DEV_USER_ID,
  email: 'dev@example.com',
  subscription: 'pro',
  authType: 'dev',
});

const makeStaticApiKeyIdentity = (req: Request, apiKey: string): ResolvedIdentity => ({
  userId: `api-key-${hashApiKey(apiKey)}`,
  email: '',
  subscription: 'pro',
  authType: 'api_key',
  // A single operator-managed local key is intentionally partition-selectable.
  // Enterprise API keys are resolved above from durable credential bindings and
  // never use these request headers as authority.
  tenantId: sanitizeContextId(getFirstHeaderValue(req, ['x-tenant-id'])) || DEFAULT_TENANT_ID,
  workspaceId: sanitizeContextId(getFirstHeaderValue(req, ['x-workspace-id'])) || DEFAULT_WORKSPACE_ID,
  // SMARTPERFETTO_API_KEY is the deployment operator's bootstrap credential,
  // not an end-user enterprise key. Enterprise keys resolve their own durable
  // roles/scopes before this fallback and remain least-privilege.
  roles: ['org_admin'],
  scopes: ['*'],
});

const resolveTrustedSsoIdentity = (req: Request): ResolvedIdentity | null => {
  if (!truthyEnv(process.env[SSO_TRUSTED_HEADERS_ENV])) return null;

  const userId = sanitizeContextId(getFirstHeaderValue(req, [
    'x-smartperfetto-sso-user-id',
    'x-sso-user-id',
    'x-auth-request-user',
  ]));
  if (!userId) return null;

  return {
    userId,
    email: sanitizeHeaderText(getFirstHeaderValue(req, [
      'x-smartperfetto-sso-email',
      'x-sso-email',
      'x-auth-request-email',
    ])),
    subscription: 'enterprise',
    authType: 'sso',
    tenantId: sanitizeContextId(getFirstHeaderValue(req, [
      'x-smartperfetto-sso-tenant-id',
      'x-sso-tenant-id',
      'x-tenant-id',
    ])) || undefined,
    workspaceId: sanitizeContextId(getFirstHeaderValue(req, [
      'x-smartperfetto-sso-workspace-id',
      'x-sso-workspace-id',
      'x-workspace-id',
    ])) || undefined,
    roles: parseHeaderList(req, [
      'x-smartperfetto-sso-roles',
      'x-sso-roles',
    ], defaultRolesForAuthType('sso')),
    scopes: parseHeaderList(req, [
      'x-smartperfetto-sso-scopes',
      'x-sso-scopes',
    ], defaultScopesForAuthType('sso')),
  };
};

const attachIdentity = (req: AuthenticatedRequest, identity: ResolvedIdentity): void => {
  req.user = {
    id: identity.userId,
    email: identity.email,
    subscription: identity.subscription,
  };
  req.requestContext = buildRequestContext(req, identity);
};

const sendUnauthorized = (res: Response, details: string): void => {
  const error: ErrorResponse = {
    error: 'Unauthorized',
    details,
  };
  res.status(401).json(error);
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
  const oidcConfigured = isOidcConfigurationPresent(process.env);
  const ssoIdentity = oidcConfigured ? null : resolveTrustedSsoIdentity(req);
  if (ssoIdentity) {
    attachIdentity(req, ssoIdentity);
    next();
    return;
  }

  const hasSessionCredential = oidcConfigured
    ? requestHasOidcSessionCredential(req)
    : requestHasSsoSessionCredential(req);
  if (hasSessionCredential) {
    try {
      const ssoService = EnterpriseSsoService.getInstance();
      const sessionIdentity = ssoService.resolveRequestIdentityFromRequest(req);
      if (sessionIdentity) {
        if (oidcConfigured && !enforceSsoCookieMutationProtection(req, res, ssoService)) return;
        attachIdentity(req, sessionIdentity);
        next();
        return;
      }
    } catch (error) {
      if (resolveFeatureConfig(process.env).enterprise) {
        sendUnauthorized(
          res,
          error instanceof Error ? error.message : 'Invalid SSO session',
        );
        return;
      }
    }
  }

  if (!oidcConfigured && requestHasEnterpriseApiKeyCredential(req)) {
    try {
      const apiKeyIdentity = EnterpriseApiKeyService.getInstance().resolveRequestIdentityFromRequest(req);
      if (apiKeyIdentity) {
        attachIdentity(req, apiKeyIdentity);
        next();
        return;
      }
      sendUnauthorized(res, 'Invalid or expired API key');
      return;
    } catch (error) {
      if (resolveFeatureConfig(process.env).enterprise) {
        sendUnauthorized(
          res,
          error instanceof Error ? error.message : 'Invalid or expired API key',
        );
        return;
      }
    }
  }

  if (oidcConfigured) {
    sendUnauthorized(res, 'OIDC session authentication is required');
    return;
  }

  const configuredKey = process.env[API_KEY_ENV];
  if (!configuredKey) {
    if (resolveFeatureConfig(process.env).enterprise) {
      sendUnauthorized(res, 'Enterprise mode requires SSO or API key authentication');
      return;
    }
    attachIdentity(req, makeDevIdentity());
    next();
    return;
  }

  const providedKey = getProvidedApiKey(req);
  if (!providedKey || !safeEquals(providedKey, configuredKey)) {
    sendUnauthorized(res, 'Invalid or missing API key');
    return;
  }

  attachIdentity(req, makeStaticApiKeyIdentity(req, providedKey));
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
