// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import express from 'express';
import { resolveFeatureConfig, serverConfig } from '../config';
import { isCorsOriginAllowed, normalizeCorsOrigins } from '../security/requestOriginPolicy';
import {
  EnterpriseOidcClient,
  type EnterpriseOidcUserInfo,
  type OidcAuthorizationTransaction,
} from '../services/enterpriseOidcClient';
import {
  EnterpriseSsoService,
  type OnboardingResult,
} from '../services/enterpriseSsoService';

interface OidcClientLike {
  readonly publicConfig?: {
    issuerUrl: string;
    clientId: string;
    scopes: string[];
  };
  buildAuthorizationRequest(params: {
    state: string;
    nonce: string;
  }): Promise<{ authorizationUrl: string; codeVerifier: string }>;
  exchangeCodeForUserInfo(
    callbackUrl: URL,
    transaction: OidcAuthorizationTransaction,
  ): Promise<EnterpriseOidcUserInfo>;
}

export interface EnterpriseSsoCookiePolicy {
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  sessionMaxAgeSeconds: number;
}

interface EnterpriseAuthRouteDeps {
  oidcClient?: OidcClientLike | null;
  ssoService?: EnterpriseSsoService;
  allowedOrigins?: readonly string[];
  cookiePolicy?: EnterpriseSsoCookiePolicy;
}

export const SSO_COOKIE_ENV = {
  secure: 'SMARTPERFETTO_SSO_COOKIE_SECURE',
  sameSite: 'SMARTPERFETTO_SSO_COOKIE_SAME_SITE',
  sessionTtlMs: 'SMARTPERFETTO_SSO_SESSION_TTL_MS',
} as const;

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(
    value?.trim().toLowerCase() || '',
  );
}

function falsey(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off', 'disabled'].includes(
    value?.trim().toLowerCase() || '',
  );
}

export function resolveEnterpriseSsoCookiePolicy(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseSsoCookiePolicy {
  const redirectUri = env.SMARTPERFETTO_OIDC_REDIRECT_URI?.trim() || '';
  const secureValue = env[SSO_COOKIE_ENV.secure];
  const secure = truthy(secureValue)
    || (!falsey(secureValue) && redirectUri.startsWith('https://'));
  const configuredSameSite = env[SSO_COOKIE_ENV.sameSite]?.trim().toLowerCase();
  let sameSite: EnterpriseSsoCookiePolicy['sameSite'] = 'Lax';
  if (configuredSameSite === 'strict') sameSite = 'Strict';
  if (configuredSameSite === 'none') sameSite = 'None';
  if (
    configuredSameSite
    && !['lax', 'strict', 'none'].includes(configuredSameSite)
  ) {
    throw new Error(
      'SMARTPERFETTO_SSO_COOKIE_SAME_SITE must be lax, strict, or none',
    );
  }
  if (sameSite === 'None' && !secure) {
    throw new Error('SameSite=None requires SMARTPERFETTO_SSO_COOKIE_SECURE=true');
  }
  const parsedTtl = Number.parseInt(env[SSO_COOKIE_ENV.sessionTtlMs] || '', 10);
  const sessionTtlMs = Number.isFinite(parsedTtl) && parsedTtl > 0
    ? parsedTtl
    : 8 * 60 * 60 * 1000;
  return {
    secure,
    sameSite,
    sessionMaxAgeSeconds: Math.ceil(sessionTtlMs / 1000),
  };
}

function cookieHeader(
  name: string,
  value: string,
  policy: EnterpriseSsoCookiePolicy,
  options: {
    maxAgeSeconds?: number;
    path?: string;
    httpOnly?: boolean;
  } = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `SameSite=${policy.sameSite}`,
  ];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (policy.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}

function clearCookieHeader(
  name: string,
  policy: EnterpriseSsoCookiePolicy,
  path = '/',
): string {
  return cookieHeader(name, '', policy, { maxAgeSeconds: 0, path });
}

function cookieValue(req: express.Request, name: string): string | undefined {
  for (const part of req.headers.cookie?.split(';') || []) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function tokenFromRequest(
  req: express.Request,
  service: EnterpriseSsoService,
): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return cookieValue(req, service.sessionCookieName) || null;
}

function hasBearerCredential(req: express.Request): boolean {
  return typeof req.headers.authorization === 'string'
    && req.headers.authorization.startsWith('Bearer ');
}

function requireCookieMutationOrigin(
  req: express.Request,
  res: express.Response,
  service: EnterpriseSsoService,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (hasBearerCredential(req) || !cookieValue(req, service.sessionCookieName)) {
    return true;
  }
  const origin = req.headers.origin;
  const sameBackendOrigin = `${req.protocol}://${req.get('host') || ''}`;
  const acceptedOrigins = new Set([...allowedOrigins, sameBackendOrigin]);
  if (typeof origin === 'string' && isCorsOriginAllowed(origin, acceptedOrigins)) {
    return true;
  }
  res.status(403).json({
    success: false,
    error: 'Cookie-authenticated mutations require an allowed Origin',
  });
  return false;
}

function publicOnboardingResult(result: OnboardingResult): Omit<
OnboardingResult,
'accessToken' | 'sessionId'
> {
  const {
    accessToken: _accessToken,
    sessionId: _sessionId,
    ...publicResult
  } = result;
  return publicResult;
}

function sendOnboardingResult(
  res: express.Response,
  service: EnterpriseSsoService,
  result: OnboardingResult,
  policy: EnterpriseSsoCookiePolicy,
): void {
  if (result.accessToken) {
    res.setHeader(
      'Set-Cookie',
      cookieHeader(
        service.sessionCookieName,
        service.createSessionCookieValue(result.accessToken),
        policy,
        { maxAgeSeconds: policy.sessionMaxAgeSeconds },
      ),
    );
  }
  res.json({ success: true, ...publicOnboardingResult(result) });
}

function callbackUrl(req: express.Request): URL {
  return new URL(req.originalUrl, 'http://smartperfetto.invalid');
}

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function callbackTargetOrigin(
  returnTo: string,
  req: express.Request,
): string {
  const fallbackOrigin = `${req.protocol}://${req.get('host') || 'localhost'}`;
  return new URL(returnTo, fallbackOrigin).origin;
}

function sendPopupCallback(
  req: express.Request,
  res: express.Response,
  input: {
    returnTo: string;
    ok: boolean;
    status: string;
  },
): void {
  const nonce = crypto.randomBytes(18).toString('base64');
  const message = escapeJsonForHtml({
    type: 'smartperfetto:oidc-callback',
    perfettoIgnore: true,
    ok: input.ok,
    status: input.status,
  });
  const target = escapeJsonForHtml(input.returnTo);
  const targetOrigin = escapeJsonForHtml(callbackTargetOrigin(input.returnTo, req));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SmartPerfetto sign-in</title>
  <style nonce="${nonce}">
    body{font:16px system-ui,sans-serif;margin:3rem;line-height:1.5;color:#1f2937}
    a{color:#315a9b}
  </style>
</head>
<body>
  <p id="status">${input.ok ? 'SmartPerfetto sign-in completed.' : 'SmartPerfetto sign-in failed.'}</p>
  <p><a id="continue" href="#">Continue to SmartPerfetto</a></p>
  <script nonce="${nonce}">
    const message=${message};
    const target=${target};
    const targetOrigin=${targetOrigin};
    document.getElementById('continue').href=target;
    if(window.opener && !window.opener.closed){
      window.opener.postMessage(message,targetOrigin);
      window.close();
    }else{
      window.setTimeout(()=>window.location.replace(target),500);
    }
  </script>
</body>
</html>`);
}

export function createEnterpriseAuthRouter(
  deps: EnterpriseAuthRouteDeps = {},
): express.Router {
  const router = express.Router();
  const getService = () => deps.ssoService || EnterpriseSsoService.getInstance();
  const oidcClient = deps.oidcClient === undefined
    ? EnterpriseOidcClient.fromEnv()
    : deps.oidcClient;
  const allowedOrigins = normalizeCorsOrigins(
    deps.allowedOrigins || serverConfig.corsOrigins,
  );
  const cookiePolicy = deps.cookiePolicy || resolveEnterpriseSsoCookiePolicy();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/config', (_req, res) => {
    const publicConfig = oidcClient?.publicConfig;
    return res.json({
      success: true,
      enterprise: resolveFeatureConfig(process.env).enterprise,
      oidc: {
        enabled: Boolean(oidcClient),
        ...(publicConfig
          ? {
              issuerUrl: publicConfig.issuerUrl,
              clientId: publicConfig.clientId,
              scopes: publicConfig.scopes,
            }
          : {}),
        loginPath: '/api/auth/oidc/login',
        localLogoutOnly: true,
      },
    });
  });

  router.get('/oidc/login', async (req, res) => {
    if (!oidcClient) {
      return res.status(404).json({
        success: false,
        error: 'OIDC is not configured',
      });
    }

    try {
      const service = getService();
      const requestedReturnTo = typeof req.query.returnTo === 'string'
        ? req.query.returnTo
        : undefined;
      const statePayload = service.createStatePayload(
        requestedReturnTo,
        allowedOrigins,
      );
      if (requestedReturnTo && !statePayload.returnTo) {
        return res.status(400).json({
          success: false,
          error: 'OIDC returnTo is not an allowed frontend URL',
        });
      }
      const authorization = await oidcClient.buildAuthorizationRequest({
        state: statePayload.state,
        nonce: statePayload.nonce,
      });
      const signedState = service.signStatePayload({
        ...statePayload,
        codeVerifier: authorization.codeVerifier,
      });
      res.setHeader(
        'Set-Cookie',
        cookieHeader(service.stateCookieName, signedState, cookiePolicy, {
          maxAgeSeconds: 10 * 60,
          path: '/api/auth/oidc/callback',
        }),
      );
      return res.redirect(302, authorization.authorizationUrl);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start OIDC login',
      });
    }
  });

  router.get('/oidc/callback', async (req, res) => {
    if (!oidcClient) {
      return res.status(404).json({
        success: false,
        error: 'OIDC is not configured',
      });
    }
    const service = getService();
    const statePayload = service.verifyStatePayload(
      cookieValue(req, service.stateCookieName),
    );
    const clearStateCookie = clearCookieHeader(
      service.stateCookieName,
      cookiePolicy,
      '/api/auth/oidc/callback',
    );
    res.setHeader('Set-Cookie', clearStateCookie);

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!statePayload || statePayload.state !== state) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OIDC callback state',
      });
    }

    const providerError = typeof req.query.error === 'string'
      ? req.query.error
      : '';
    if (providerError) {
      if (statePayload.returnTo) {
        sendPopupCallback(req, res, {
          returnTo: statePayload.returnTo,
          ok: false,
          status: 'provider_error',
        });
        return;
      }
      return res.status(400).json({
        success: false,
        error: 'OIDC provider rejected the sign-in request',
      });
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'OIDC callback did not include an authorization code',
      });
    }

    try {
      const userInfo = await oidcClient.exchangeCodeForUserInfo(
        callbackUrl(req),
        {
          state: statePayload.state,
          nonce: statePayload.nonce,
          codeVerifier: statePayload.codeVerifier!,
        },
      );
      const result = service.completeOidcLogin(userInfo);
      const cookies = [clearStateCookie];
      if (result.accessToken) {
        cookies.push(
          cookieHeader(
            service.sessionCookieName,
            service.createSessionCookieValue(result.accessToken),
            cookiePolicy,
            { maxAgeSeconds: cookiePolicy.sessionMaxAgeSeconds },
          ),
        );
      }
      res.setHeader('Set-Cookie', cookies);
      if (statePayload.returnTo) {
        sendPopupCallback(req, res, {
          returnTo: statePayload.returnTo,
          ok: result.status !== 'needs_tenant_join',
          status: result.status,
        });
        return;
      }
      return res.json({
        success: true,
        ...publicOnboardingResult(result),
      });
    } catch (error) {
      if (statePayload.returnTo) {
        sendPopupCallback(req, res, {
          returnTo: statePayload.returnTo,
          ok: false,
          status: 'callback_error',
        });
        return;
      }
      return res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'OIDC callback failed',
      });
    }
  });

  router.get('/session', (req, res) => {
    const summary = getService().getSessionSummaryFromRequest(req);
    if (!summary) {
      return res.json({ success: true, authenticated: false });
    }
    return res.json({ success: true, ...summary });
  });

  router.post('/onboarding/workspace', (req, res) => {
    const service = getService();
    if (!requireCookieMutationOrigin(req, res, service, allowedOrigins)) return;
    const accessToken = tokenFromRequest(req, service);
    const workspaceId = typeof req.body?.workspaceId === 'string'
      ? req.body.workspaceId
      : '';
    if (!accessToken || !workspaceId) {
      return res.status(400).json({
        success: false,
        error: 'session and workspaceId are required',
      });
    }
    return sendOnboardingResult(
      res,
      service,
      service.selectWorkspace(accessToken, workspaceId),
      cookiePolicy,
    );
  });

  router.post('/logout', (req, res) => {
    const service = getService();
    if (!requireCookieMutationOrigin(req, res, service, allowedOrigins)) return;
    const accessToken = tokenFromRequest(req, service);
    if (accessToken) service.revokeSession(accessToken);
    res.setHeader(
      'Set-Cookie',
      clearCookieHeader(service.sessionCookieName, cookiePolicy),
    );
    return res.json({ success: true });
  });

  return router;
}

export default createEnterpriseAuthRouter();
