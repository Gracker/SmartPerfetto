// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type {
  Configuration,
  DiscoveryRequestOptions,
} from 'openid-client';

export interface OidcRuntimeConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  allowInsecureHttp: boolean;
  requestTimeoutMs: number;
}

export interface EnterpriseOidcUserInfo {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  claims: Record<string, unknown>;
}

export interface OidcExchangeOptions {
  codeVerifier: string;
  expectedState: string;
  expectedNonce: string;
}

type OpenidClientModule = typeof import('openid-client');
type OpenidClientLoader = () => Promise<OpenidClientModule>;

export const OIDC_ENV = {
  issuerUrl: 'SMARTPERFETTO_OIDC_ISSUER_URL',
  clientId: 'SMARTPERFETTO_OIDC_CLIENT_ID',
  clientSecret: 'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  redirectUri: 'SMARTPERFETTO_OIDC_REDIRECT_URI',
  allowInsecureHttp: 'SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP',
} as const;

const OIDC_SCOPES = ['openid', 'email', 'profile'];
const OIDC_REQUEST_TIMEOUT_MS = 10_000;

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(
    value?.trim().toLowerCase() || '',
  );
}

function normalizeIssuerUrl(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OIDC issuer URL must be a valid URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OIDC issuer URL must not contain credentials, a query, or a fragment');
  }
  if (/\/\.well-known\/openid-configuration\/?$/.test(parsed.pathname)) {
    throw new Error('OIDC issuer URL must be an issuer identifier, not a discovery document URL');
  }
  if (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) {
    throw new Error('OIDC issuer URL must use HTTPS');
  }
  return parsed.toString();
}

function normalizeRedirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OIDC redirect URI must be a valid URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'OIDC redirect URI must be an HTTP(S) URL without credentials, a query, or a fragment',
    );
  }
  return parsed.toString();
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function verifiedEmail(claims: Record<string, unknown>): string | undefined {
  if (claims.email_verified !== true) return undefined;
  return stringClaim(claims, 'email');
}

export function createPkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function resolveOidcRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): OidcRuntimeConfig | null {
  const issuerUrl = env[OIDC_ENV.issuerUrl]?.trim();
  const clientId = env[OIDC_ENV.clientId]?.trim();
  const clientSecret = env[OIDC_ENV.clientSecret]?.trim();
  const redirectUri = env[OIDC_ENV.redirectUri]?.trim();
  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return null;
  const allowInsecureHttp = truthy(env[OIDC_ENV.allowInsecureHttp]);
  return {
    issuerUrl: normalizeIssuerUrl(issuerUrl, allowInsecureHttp),
    clientId,
    clientSecret,
    redirectUri: normalizeRedirectUri(redirectUri),
    scopes: OIDC_SCOPES,
    allowInsecureHttp,
    requestTimeoutMs: OIDC_REQUEST_TIMEOUT_MS,
  };
}

export class EnterpriseOidcClient {
  private configuration: Configuration | null = null;
  private clientModule: OpenidClientModule | null = null;

  constructor(
    private readonly config: OidcRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadClient: OpenidClientLoader = () => import('openid-client'),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnterpriseOidcClient | null {
    const config = resolveOidcRuntimeConfig(env);
    return config ? new EnterpriseOidcClient(config) : null;
  }

  async buildAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string> {
    const [client, configuration] = await this.getClient();
    return client.buildAuthorizationUrl(configuration, {
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
  }

  async exchangeCodeForUserInfo(
    code: string,
    options: OidcExchangeOptions,
  ): Promise<EnterpriseOidcUserInfo> {
    const [client, configuration] = await this.getClient();
    const callbackUrl = new URL(this.config.redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', options.expectedState);
    const tokens = await client.authorizationCodeGrant(
      configuration,
      callbackUrl,
      {
        pkceCodeVerifier: options.codeVerifier,
        expectedState: options.expectedState,
        expectedNonce: options.expectedNonce,
        idTokenExpected: true,
      },
    );
    const idTokenClaims = tokens.claims();
    const subject = idTokenClaims?.sub?.trim();
    if (!idTokenClaims || !subject) {
      throw new Error('OIDC token response did not include a valid ID Token subject');
    }

    let claims: Record<string, unknown> = {
      ...(idTokenClaims as Record<string, unknown>),
    };
    if (
      configuration.serverMetadata().userinfo_endpoint
      && typeof tokens.access_token === 'string'
      && tokens.access_token
    ) {
      const userInfo = await client.fetchUserInfo(
        configuration,
        tokens.access_token,
        subject,
      );
      claims = {
        ...claims,
        ...(userInfo as Record<string, unknown>),
      };
    }

    return {
      issuer: configuration.serverMetadata().issuer,
      subject,
      email: verifiedEmail(claims),
      displayName:
        stringClaim(claims, 'name')
        || stringClaim(claims, 'preferred_username'),
      claims,
    };
  }

  private async getClient(): Promise<[OpenidClientModule, Configuration]> {
    if (this.clientModule && this.configuration) {
      return [this.clientModule, this.configuration];
    }
    const client = await this.loadClient();
    const options: DiscoveryRequestOptions = {
      timeout: Math.max(1, Math.ceil(this.config.requestTimeoutMs / 1000)),
      [client.customFetch]: this.fetchImpl,
      ...(this.config.allowInsecureHttp
        ? {execute: [client.allowInsecureRequests]}
        : {}),
    };
    const configuration = await client.discovery(
      new URL(this.config.issuerUrl),
      this.config.clientId,
      {
        client_secret: this.config.clientSecret,
        token_endpoint_auth_method: 'client_secret_basic',
      },
      client.ClientSecretBasic(this.config.clientSecret),
      options,
    );
    configuration[client.customFetch] = this.fetchImpl;
    this.clientModule = client;
    this.configuration = configuration;
    return [client, configuration];
  }
}
