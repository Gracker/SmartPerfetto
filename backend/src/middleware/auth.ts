// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { ErrorResponse } from '../types';
import {
  isKeylessLocalMode,
  isOidcConfigurationPresent,
  isSsoTrustedHeadersEnabled,
  resolveFeatureConfig,
  SMARTPERFETTO_API_KEY_ENV,
} from '../config';
import {
  EnterpriseApiKeyService,
  requestHasEnterpriseApiKeyCredential,
} from '../services/enterpriseApiKeyService';
import { EnterpriseSsoService } from '../services/enterpriseSsoService';
import { getFirstHeaderValue, getHeaderValue, parseHeaderList } from './requestHeaders';
import { sanitizeContextId } from '../utils/contextId';
import { requestIdOf } from './requestId';
import type { BrowserOriginRequirement } from '../security/requestOriginPolicy';

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

/** The parts of an identity that shape its RequestContext. */
export type ContextIdentity = Pick<
  ResolvedIdentity,
  'userId' | 'authType' | 'tenantId' | 'workspaceId' | 'roles' | 'scopes'
>;

/**
 * Scope values a caller supplies outside the headers, consulted after them.
 * Only the WebSocket upgrade path has any: a browser cannot set headers on it.
 */
interface RequestContextFallbacks {
  tenantId?: string;
  workspaceId?: string;
  windowId?: string;
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

/**
 * How a request carries its SSO session, if it does: any Bearer header decides,
 * so a session cookie counts only without one. A malformed session cookie
 * counts as no session rather than throwing.
 */
const sessionCredentialTransport = (req: IncomingMessage): 'bearer' | 'cookie' | undefined => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim().startsWith(SSO_SESSION_TOKEN_PREFIX)
      ? 'bearer'
      : undefined;
  }
  const hasCookie = typeof req.headers.cookie === 'string'
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
  return hasCookie ? 'cookie' : undefined;
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

const sanitizeHeaderText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\r\n]/g, '').slice(0, 320);
};

const defaultRolesForAuthType = (authType: RequestContextAuthType): string[] =>
  authType === 'dev' ? ['org_admin'] : ['analyst'];

const defaultScopesForAuthType = (authType: RequestContextAuthType): string[] =>
  authType === 'dev'
    ? ['*']
    : ['trace:read', 'trace:write', 'agent:run', 'report:read'];

/**
 * The RequestContext of a resolved identity, shared by HTTP authentication and
 * the trace-processor WebSocket upgrade. An API-key identity without a bound
 * workspace gets the default one: neither headers nor fallbacks select it.
 */
export const buildRequestContext = (
  req: IncomingMessage,
  identity: ContextIdentity,
  fallbacks: RequestContextFallbacks = {},
): RequestContext => {
  const tenantId = identity.tenantId
    || sanitizeContextId(getFirstHeaderValue(req, ['x-tenant-id', 'x-sso-tenant-id']))
    || fallbacks.tenantId
    || DEFAULT_TENANT_ID;
  const workspaceId = identity.workspaceId || (
    identity.authType === 'api_key'
      ? DEFAULT_WORKSPACE_ID
      : sanitizeContextId(getFirstHeaderValue(req, ['x-workspace-id', 'x-sso-workspace-id']))
        || fallbacks.workspaceId
        || DEFAULT_WORKSPACE_ID
  );
  const requestId = requestIdOf(req);
  const windowId = sanitizeContextId(getHeaderValue(req, 'x-window-id'))
    || fallbacks.windowId
    || undefined;

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

/** The identity a trusted SSO proxy asserted in headers, when that trust is enabled. */
const resolveTrustedSsoIdentity = (req: IncomingMessage): ResolvedIdentity | null => {
  if (!isSsoTrustedHeadersEnabled(process.env)) return null;

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

type CredentialResolution =
  | {
    kind: 'identity';
    identity: ResolvedIdentity;
    source: 'trusted_headers' | 'sso_session' | 'enterprise_api_key';
    /**
     * The Origin this credential needs where CORS does not run. Trusted headers
     * come from a proxy's own browser session, so they are as ambient as a
     * cookie; bearer tokens and API keys must be held by the page.
     */
    originRequirement: BrowserOriginRequirement;
  }
  | { kind: 'rejected'; details: string }
  | { kind: 'none' };

/**
 * A credential lookup that threw (storage, secret): the caller gets fixed text,
 * the cause goes to the log under the request id.
 */
const rejectedLookup = (req: IncomingMessage, details: string, error: unknown): CredentialResolution => {
  console.error('[Auth] Credential lookup failed', {requestId: requestIdOf(req), details}, error);
  return { kind: 'rejected', details };
};

/**
 * The identity carried by a request's SSO or enterprise credential: trusted SSO
 * headers, then an SSO/OIDC session, then an enterprise API key. HTTP
 * authentication and the trace-processor WebSocket upgrade both use it, so the
 * trust rules cannot drift apart. Built-in OIDC accepts neither trusted headers
 * nor enterprise API keys. A credential that is present but unusable is
 * `rejected` (a failing lookup only in enterprise mode); `none` leaves the
 * caller to its own fallbacks.
 */
export const resolveCredentialIdentity = (req: IncomingMessage): CredentialResolution => {
  const oidcConfigured = isOidcConfigurationPresent(process.env);

  const trustedIdentity = oidcConfigured ? null : resolveTrustedSsoIdentity(req);
  if (trustedIdentity) {
    return { kind: 'identity', identity: trustedIdentity, source: 'trusted_headers', originRequirement: 'if_present' };
  }

  const sessionTransport = sessionCredentialTransport(req);
  if (sessionTransport) {
    try {
      const sessionIdentity = EnterpriseSsoService.getInstance().resolveRequestIdentityFromRequest(req);
      if (sessionIdentity) {
        return {
          kind: 'identity',
          identity: sessionIdentity,
          source: 'sso_session',
          originRequirement: sessionTransport === 'cookie' ? 'required' : 'none',
        };
      }
    } catch (error) {
      if (resolveFeatureConfig(process.env).enterprise) {
        return rejectedLookup(req, 'Invalid SSO session', error);
      }
    }
  }

  if (!oidcConfigured && requestHasEnterpriseApiKeyCredential(req)) {
    try {
      const apiKeyIdentity = EnterpriseApiKeyService.getInstance().resolveRequestIdentityFromRequest(req);
      return apiKeyIdentity
        ? { kind: 'identity', identity: apiKeyIdentity, source: 'enterprise_api_key', originRequirement: 'none' }
        : { kind: 'rejected', details: 'Invalid or expired API key' };
    } catch (error) {
      if (resolveFeatureConfig(process.env).enterprise) {
        return rejectedLookup(req, 'Invalid or expired API key', error);
      }
    }
  }

  return { kind: 'none' };
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
  const credential = resolveCredentialIdentity(req);
  if (credential.kind === 'rejected') {
    sendUnauthorized(res, credential.details);
    return;
  }
  if (credential.kind === 'identity') {
    if (credential.source === 'sso_session'
      && oidcConfigured
      && !enforceSsoCookieMutationProtection(req, res, EnterpriseSsoService.getInstance())) {
      return;
    }
    attachIdentity(req, credential.identity);
    next();
    return;
  }

  if (oidcConfigured) {
    sendUnauthorized(res, 'OIDC session authentication is required');
    return;
  }

  if (isKeylessLocalMode()) {
    attachIdentity(req, makeDevIdentity());
    next();
    return;
  }
  const configuredKey = process.env[SMARTPERFETTO_API_KEY_ENV];
  if (!configuredKey) {
    sendUnauthorized(res, 'Enterprise mode requires SSO or API key authentication');
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
