// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {
  createPkceChallenge,
  EnterpriseOidcClient,
  type EnterpriseOidcUserInfo,
  type OidcExchangeOptions,
} from '../services/enterpriseOidcClient';
import {
  EnterpriseSsoService,
  enterpriseSsoCookies,
  normalizeOidcReturnTo,
  type OnboardingResult,
} from '../services/enterpriseSsoService';

interface OidcClientLike {
  buildAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  exchangeCodeForUserInfo(code: string, options: OidcExchangeOptions): Promise<EnterpriseOidcUserInfo>;
}

interface EnterpriseAuthRouteDeps {
  oidcClient?: OidcClientLike | null;
  ssoService?: EnterpriseSsoService;
}

type CookieOptions = {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
};

function cookieHeader(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || '/'}`,
    `SameSite=${options.sameSite || 'Lax'}`,
  ];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  return parts.join('; ');
}

function clearCookieHeader(
  name: string,
  path = '/',
  options: Pick<CookieOptions, 'secure' | 'sameSite'> = {},
): string {
  return cookieHeader(name, '', { maxAgeSeconds: 0, path, ...options });
}

function tokenFromRequest(req: express.Request, service: EnterpriseSsoService): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const cookies = req.headers.cookie?.split(';') || [];
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name !== service.sessionCookieName) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

function oidcCallbackCookiePath(): string {
  try {
    return new URL(
      process.env.SMARTPERFETTO_OIDC_REDIRECT_URI || '',
    ).pathname || '/api/auth/oidc/callback';
  } catch {
    return '/api/auth/oidc/callback';
  }
}

function sendNoStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function sendOnboardingResult(
  res: express.Response,
  service: EnterpriseSsoService,
  result: OnboardingResult,
): void {
  sendNoStore(res);
  if (result.accessToken) {
    res.setHeader('Set-Cookie', cookieHeader(
      service.sessionCookieName,
      service.createSessionCookieValue(result.accessToken),
      {
        maxAgeSeconds: service.sessionCookieMaxAgeSeconds,
        secure: service.sessionCookieSecure,
        sameSite: service.sessionCookieSameSite,
      },
    ));
  }
  const { accessToken: _accessToken, ...publicResult } = result;
  res.json({ success: true, ...publicResult });
}

function frontendRedirect(returnTo: string | undefined): string {
  const frontendUrl = process.env.FRONTEND_URL?.trim();
  const safeReturnTo = normalizeOidcReturnTo(returnTo) || '/';
  if (!frontendUrl) return safeReturnTo;
  try {
    const base = new URL(frontendUrl);
    return new URL(safeReturnTo, `${base.toString().replace(/\/$/, '')}/`).toString();
  } catch {
    throw new Error('FRONTEND_URL must be an absolute URL in OIDC mode');
  }
}

function requireCookieMutationProtection(
  req: express.Request,
  res: express.Response,
  service: EnterpriseSsoService,
): boolean {
  if (typeof req.headers.authorization === 'string'
    && req.headers.authorization.startsWith('Bearer sp_sso_')) {
    return true;
  }
  if (!service.isCookieAuthenticatedRequest(req)) return true;
  const origin = req.headers.origin;
  if (origin && process.env.FRONTEND_URL) {
    try {
      if (new URL(origin).origin !== new URL(process.env.FRONTEND_URL).origin) {
        sendNoStore(res);
        res.status(403).json({ success: false, error: 'Invalid request origin' });
        return false;
      }
    } catch {
      sendNoStore(res);
      res.status(403).json({ success: false, error: 'Invalid request origin' });
      return false;
    }
  }
  const csrf = typeof req.headers['x-csrf-token'] === 'string'
    ? req.headers['x-csrf-token']
    : undefined;
  if (!service.verifyCsrfTokenForRequest(req, csrf)) {
    sendNoStore(res);
    res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    return false;
  }
  return true;
}

export function createEnterpriseAuthRouter(deps: EnterpriseAuthRouteDeps = {}): express.Router {
  const router = express.Router();
  const getService = () => deps.ssoService || EnterpriseSsoService.getInstance();
  let oidcClient = deps.oidcClient;
  let oidcClientResolved = deps.oidcClient !== undefined;
  const getOidcClient = (): OidcClientLike | null => {
    if (!oidcClientResolved) {
      oidcClient = EnterpriseOidcClient.fromEnv();
      oidcClientResolved = true;
    }
    return oidcClient ?? null;
  };

  router.get('/oidc/login', async (req, res) => {
    sendNoStore(res);
    const oidcClient = getOidcClient();
    if (!oidcClient) {
      return res.status(404).json({ success: false, error: 'OIDC is not configured' });
    }

    try {
      const service = getService();
      const statePayload = service.createStatePayload(
        typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined,
      );
      const authorizationUrl = await oidcClient.buildAuthorizationUrl({
        state: statePayload.state,
        nonce: statePayload.nonce,
        codeChallenge: createPkceChallenge(statePayload.codeVerifier),
      });
      const signedState = service.signStatePayload(statePayload);
      res.setHeader('Set-Cookie', cookieHeader(
        service.stateCookieName,
        signedState,
        {
          maxAgeSeconds: 10 * 60,
          path: oidcCallbackCookiePath(),
          secure: service.sessionCookieSecure,
          sameSite: 'lax',
        },
      ));
      return res.redirect(302, authorizationUrl);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start OIDC login',
      });
    }
  });

  router.get('/oidc/callback', async (req, res) => {
    sendNoStore(res);
    const oidcClient = getOidcClient();
    if (!oidcClient) {
      return res.status(404).json({ success: false, error: 'OIDC is not configured' });
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const service = getService();
    const stateCookie = req.headers.cookie
      ?.split(';')
      .map(cookie => cookie.trim())
      .find(cookie => cookie.startsWith(`${enterpriseSsoCookies.state}=`))
      ?.slice(enterpriseSsoCookies.state.length + 1);
    let decodedStateCookie: string | undefined;
    try {
      decodedStateCookie = stateCookie ? decodeURIComponent(stateCookie) : undefined;
    } catch {
      decodedStateCookie = undefined;
    }
    const statePayload = service.verifyStatePayload(decodedStateCookie);
    if (!code || !statePayload || statePayload.state !== state) {
      return res.status(400).json({ success: false, error: 'Invalid OIDC callback state' });
    }

    try {
      const userInfo = await oidcClient.exchangeCodeForUserInfo(code, {
        codeVerifier: statePayload.codeVerifier,
        expectedState: statePayload.state,
        expectedNonce: statePayload.nonce,
      });
      const result = service.completeOidcLogin(userInfo);
      const cookies = [clearCookieHeader(
        service.stateCookieName,
        oidcCallbackCookiePath(),
        { secure: service.sessionCookieSecure, sameSite: 'lax' },
      )];
      if (result.accessToken) {
        cookies.push(cookieHeader(
          service.sessionCookieName,
          service.createSessionCookieValue(result.accessToken),
          {
            maxAgeSeconds: service.sessionCookieMaxAgeSeconds,
            secure: service.sessionCookieSecure,
            sameSite: service.sessionCookieSameSite,
          },
        ));
      }
      res.setHeader('Set-Cookie', cookies);
      if (service.authMode === 'oidc') {
        const redirectUrl = new URL(frontendRedirect(statePayload.returnTo));
        if (result.status !== 'ready') {
          redirectUrl.searchParams.set('authStatus', result.status);
        }
        return res.redirect(302, redirectUrl.toString());
      }
      const { accessToken: _accessToken, ...publicResult } = result;
      return res.json({ success: true, ...publicResult, returnTo: statePayload.returnTo });
    } catch (error) {
      return res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : 'OIDC callback failed',
      });
    }
  });

  router.get('/session', (req, res) => {
    sendNoStore(res);
    return res.json(getService().getSessionView(req));
  });

  router.post('/onboarding/workspace', (req, res) => {
    const service = getService();
    if (!requireCookieMutationProtection(req, res, service)) return;
    const accessToken = tokenFromRequest(req, service);
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : '';
    if (!accessToken || !workspaceId) {
      sendNoStore(res);
      return res.status(400).json({ success: false, error: 'access token and workspaceId are required' });
    }
    return sendOnboardingResult(res, service, service.selectWorkspace(accessToken, workspaceId));
  });

  router.post('/logout', (req, res) => {
    const service = getService();
    if (!requireCookieMutationProtection(req, res, service)) return;
    const accessToken = tokenFromRequest(req, service);
    if (accessToken) service.revokeSession(accessToken);
    sendNoStore(res);
    res.setHeader('Set-Cookie', clearCookieHeader(
      service.sessionCookieName,
      '/',
      { secure: service.sessionCookieSecure, sameSite: service.sessionCookieSameSite },
    ));
    return res.json({ success: true });
  });

  return router;
}

export default createEnterpriseAuthRouter();
