// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ClientAuth,
  Configuration,
  DiscoveryRequestOptions,
} from 'openid-client';

export type OidcClientAuthMethod =
  | 'client_secret_post'
  | 'client_secret_basic'
  | 'none';

export interface OidcRuntimeConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  clientAuthMethod: OidcClientAuthMethod;
  redirectUri: string;
  scopes: string[];
  allowInsecureHttp: boolean;
  requireVerifiedEmail: boolean;
  timeoutSeconds: number;
}

export interface EnterpriseOidcUserInfo {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  claims: Record<string, unknown>;
}

export interface OidcAuthorizationRequest {
  authorizationUrl: string;
  codeVerifier: string;
}

export interface OidcAuthorizationTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
}

type OpenidClientModule = typeof import('openid-client');
type OpenidClientLoader = () => Promise<OpenidClientModule>;

export const OIDC_ENV = {
  issuerUrl: 'SMARTPERFETTO_OIDC_ISSUER_URL',
  clientId: 'SMARTPERFETTO_OIDC_CLIENT_ID',
  clientSecret: 'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  clientAuthMethod: 'SMARTPERFETTO_OIDC_CLIENT_AUTH_METHOD',
  redirectUri: 'SMARTPERFETTO_OIDC_REDIRECT_URI',
  scopes: 'SMARTPERFETTO_OIDC_SCOPES',
  allowInsecureHttp: 'SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP',
  requireVerifiedEmail: 'SMARTPERFETTO_OIDC_REQUIRE_VERIFIED_EMAIL',
  timeoutSeconds: 'SMARTPERFETTO_OIDC_TIMEOUT_SECONDS',
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHttpUrl(
  value: string,
  label: string,
  allowInsecureHttp: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  if (parsed.search) {
    throw new Error(`${label} must not contain a query`);
  }
  if (/\/\.well-known\/openid-configuration\/?$/.test(parsed.pathname)) {
    throw new Error(
      `${label} must be an issuer identifier, not a discovery document URL`,
    );
  }
  if (parsed.protocol !== 'https:' && !(allowInsecureHttp && parsed.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed.toString().replace(/\/+$/, '');
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
    || parsed.hash
  ) {
    throw new Error(
      'OIDC redirect URI must be an HTTP(S) URL without credentials or a fragment',
    );
  }
  return parsed.toString();
}

function parseClientAuthMethod(
  value: string | undefined,
  hasClientSecret: boolean,
): OidcClientAuthMethod {
  const normalized = value?.trim().toLowerCase();
  const fallback = hasClientSecret ? 'client_secret_post' : 'none';
  if (!normalized) return fallback;
  if (
    normalized !== 'client_secret_post'
    && normalized !== 'client_secret_basic'
    && normalized !== 'none'
  ) {
    throw new Error(
      'SMARTPERFETTO_OIDC_CLIENT_AUTH_METHOD must be client_secret_post, client_secret_basic, or none',
    );
  }
  if (normalized !== 'none' && !hasClientSecret) {
    throw new Error(
      `SMARTPERFETTO_OIDC_CLIENT_SECRET is required for ${normalized}`,
    );
  }
  return normalized;
}

function parseScopes(value: string | undefined): string[] {
  const configured = (value || 'openid email profile')
    .split(/[,\s]+/)
    .map(scope => scope.trim())
    .filter(Boolean);
  return [...new Set(['openid', ...configured])];
}

export function resolveOidcRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): OidcRuntimeConfig | null {
  const issuerUrl = env[OIDC_ENV.issuerUrl]?.trim();
  const clientId = env[OIDC_ENV.clientId]?.trim();
  const redirectUri = env[OIDC_ENV.redirectUri]?.trim();
  if (!issuerUrl || !clientId || !redirectUri) return null;

  const allowInsecureHttp = truthy(env[OIDC_ENV.allowInsecureHttp]);
  const clientSecret = env[OIDC_ENV.clientSecret]?.trim() || undefined;
  return {
    issuerUrl: normalizeHttpUrl(
      issuerUrl,
      'OIDC issuer URL',
      allowInsecureHttp,
    ),
    clientId,
    clientSecret,
    clientAuthMethod: parseClientAuthMethod(
      env[OIDC_ENV.clientAuthMethod],
      Boolean(clientSecret),
    ),
    redirectUri: normalizeRedirectUri(redirectUri),
    scopes: parseScopes(env[OIDC_ENV.scopes]),
    allowInsecureHttp,
    requireVerifiedEmail: !falsey(env[OIDC_ENV.requireVerifiedEmail]),
    timeoutSeconds: parsePositiveInteger(env[OIDC_ENV.timeoutSeconds], 15),
  };
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

function resolveEmail(
  claims: Record<string, unknown>,
  requireVerifiedEmail: boolean,
): string | undefined {
  const email = stringClaim(claims, 'email');
  if (!email) return undefined;
  if (requireVerifiedEmail && claims.email_verified !== true) return undefined;
  return email;
}

export class EnterpriseOidcClient {
  private configuration: Configuration | null = null;
  private clientModule: OpenidClientModule | null = null;

  constructor(
    private readonly config: OidcRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadClient: OpenidClientLoader = () => import('openid-client'),
  ) {}

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): EnterpriseOidcClient | null {
    const config = resolveOidcRuntimeConfig(env);
    return config ? new EnterpriseOidcClient(config) : null;
  }

  get publicConfig(): Pick<OidcRuntimeConfig, 'issuerUrl' | 'clientId' | 'scopes'> {
    return {
      issuerUrl: this.config.issuerUrl,
      clientId: this.config.clientId,
      scopes: this.config.scopes,
    };
  }

  async buildAuthorizationRequest(params: {
    state: string;
    nonce: string;
  }): Promise<OidcAuthorizationRequest> {
    const [client, configuration] = await this.getClient();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const authorizationUrl = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state: params.state,
      nonce: params.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
    };
  }

  async exchangeCodeForUserInfo(
    callbackUrl: URL,
    transaction: OidcAuthorizationTransaction,
  ): Promise<EnterpriseOidcUserInfo> {
    const [client, configuration] = await this.getClient();
    const normalizedCallbackUrl = new URL(this.config.redirectUri);
    normalizedCallbackUrl.search = callbackUrl.search;

    const tokens = await client.authorizationCodeGrant(
      configuration,
      normalizedCallbackUrl,
      {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
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
      email: resolveEmail(claims, this.config.requireVerifiedEmail),
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
    const clientAuth = this.createClientAuth(client);
    const options: DiscoveryRequestOptions = {
      timeout: this.config.timeoutSeconds,
      [client.customFetch]: this.fetchImpl,
      ...(this.config.allowInsecureHttp
        ? { execute: [client.allowInsecureRequests] }
        : {}),
    };
    const configuration = await client.discovery(
      new URL(this.config.issuerUrl),
      this.config.clientId,
      {
        ...(this.config.clientSecret
          ? { client_secret: this.config.clientSecret }
          : {}),
        token_endpoint_auth_method: this.config.clientAuthMethod,
      },
      clientAuth,
      options,
    );
    configuration[client.customFetch] = this.fetchImpl;
    this.clientModule = client;
    this.configuration = configuration;
    return [client, configuration];
  }

  private createClientAuth(client: OpenidClientModule): ClientAuth {
    switch (this.config.clientAuthMethod) {
      case 'client_secret_basic':
        return client.ClientSecretBasic(this.config.clientSecret);
      case 'client_secret_post':
        return client.ClientSecretPost(this.config.clientSecret);
      case 'none':
        return client.None();
    }
  }
}
