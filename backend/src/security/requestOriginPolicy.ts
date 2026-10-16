// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

function normalizeOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieHeaderHasName(
  cookieHeader: string | undefined,
  name: string,
): boolean {
  return Boolean(cookieHeader?.split(';').some(part => {
    const separator = part.indexOf('=');
    return separator > 0 && part.slice(0, separator).trim() === name;
  }));
}

export function isCorsOriginAllowed(
  requestOrigin: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const normalized = normalizeOrigin(requestOrigin);
  return normalized !== undefined && allowedOrigins.has(normalized);
}

export function normalizeCorsOrigins(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.flatMap(origin => {
    const normalized = normalizeOrigin(origin.replace(/\/+$/, ''));
    return normalized ? [normalized] : [];
  }));
}

export function isSsoCookieMutationOriginAllowed(input: {
  method: string;
  cookieHeader?: string;
  authorizationHeader?: string;
  apiKeyHeader?: string;
  requestOrigin?: string;
  requestProtocol: string;
  requestHost: string;
  allowedOrigins: ReadonlySet<string>;
  sessionCookieName?: string;
}): boolean {
  if (SAFE_HTTP_METHODS.has(input.method.toUpperCase())) return true;
  if (
    input.authorizationHeader?.startsWith('Bearer ')
    || Boolean(input.apiKeyHeader?.trim())
  ) {
    return true;
  }
  if (!cookieHeaderHasName(
    input.cookieHeader,
    input.sessionCookieName || 'sp_sso_session',
  )) {
    return true;
  }
  if (!input.requestOrigin) return false;
  if (isCorsOriginAllowed(input.requestOrigin, input.allowedOrigins)) return true;
  const normalizedRequestOrigin = normalizeOrigin(input.requestOrigin);
  const normalizedBackendOrigin = normalizeOrigin(
    `${input.requestProtocol}://${input.requestHost}`,
  );
  return normalizedRequestOrigin !== undefined
    && normalizedRequestOrigin === normalizedBackendOrigin;
}

/**
 * How far a request's Origin must be trusted, given the credential that
 * authenticates it. A credential the browser attaches to any page's request by
 * itself (a session cookie, a trusted proxy's session, keyless local mode)
 * needs an admitted Origin when one is sent; a session cookie must send one, as
 * a cookie mutation must. A credential the page has to hold needs none.
 */
export type BrowserOriginRequirement = 'none' | 'if_present' | 'required';

/**
 * Whether an Origin satisfies a requirement where no CORS check has run, such
 * as a WebSocket upgrade. Unlike the cookie mutation guard, the backend's own
 * origin is never inferred from Host: a DNS-rebinding page controls Host and is
 * same-origin with it. Only an exact admitted origin counts.
 */
export function isOriginAllowedForRequirement(
  requestOrigin: string | undefined,
  requirement: BrowserOriginRequirement,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (requirement === 'none') return true;
  if (requestOrigin === undefined) return requirement === 'if_present';
  return isCorsOriginAllowed(requestOrigin, allowedOrigins);
}

/** A Host header's hostname as Express reads `req.hostname`, or '' when unusable. */
export function hostnameOfHostHeader(host: string | undefined): string {
  try {
    return new URL(`http://${host ?? ''}`).hostname;
  } catch {
    return '';
  }
}

export function isLoopbackRequestHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const ipv4 = normalized.split('.').map(part => Number(part));
  return ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 127;
}
