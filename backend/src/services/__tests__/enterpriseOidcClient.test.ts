// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  EnterpriseOidcClient,
  resolveOidcRuntimeConfig,
  type OidcRuntimeConfig,
} from '../enterpriseOidcClient';

const BASE_CONFIG: OidcRuntimeConfig = {
  issuerUrl: 'https://idp.example.test',
  clientId: 'client-a',
  clientSecret: 'secret-a',
  clientAuthMethod: 'client_secret_basic',
  redirectUri: 'https://smartperfetto.example.test/api/auth/oidc/callback',
  scopes: ['openid', 'email', 'profile'],
  allowInsecureHttp: false,
  requireVerifiedEmail: true,
  timeoutSeconds: 12,
};

function createProtocolHarness(options: {
  emailVerified?: boolean;
} = {}) {
  const customFetch = Symbol('customFetch');
  const configuration: any = {
    serverMetadata: () => ({
      issuer: 'https://idp.example.test',
      userinfo_endpoint: 'https://idp.example.test/userinfo',
    }),
  };
  const calls: Record<string, any[]> = {
    discovery: [],
    authorization: [],
    grant: [],
    userinfo: [],
  };
  const module: any = {
    customFetch,
    allowInsecureRequests: jest.fn(),
    ClientSecretBasic: jest.fn(secret => ({ method: 'basic', secret })),
    ClientSecretPost: jest.fn(secret => ({ method: 'post', secret })),
    None: jest.fn(() => ({ method: 'none' })),
    discovery: jest.fn(async (...args: any[]) => {
      calls.discovery.push(args);
      return configuration;
    }),
    randomPKCECodeVerifier: jest.fn(() => 'verifier-123'),
    calculatePKCECodeChallenge: jest.fn(async verifier => {
      expect(verifier).toBe('verifier-123');
      return 'challenge-123';
    }),
    buildAuthorizationUrl: jest.fn((_config, params) => {
      calls.authorization.push(params);
      const url = new URL('https://idp.example.test/authorize');
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
      return url;
    }),
    authorizationCodeGrant: jest.fn(async (...args: any[]) => {
      calls.grant.push(args);
      return {
        access_token: 'access-123',
        claims: () => ({
          iss: 'https://idp.example.test',
          aud: 'client-a',
          sub: 'alice-sub',
          nonce: 'nonce-123',
          email: 'stale@example.test',
          email_verified: false,
          name: 'Alice ID Token',
        }),
      };
    }),
    fetchUserInfo: jest.fn(async (...args: any[]) => {
      calls.userinfo.push(args);
      return {
        sub: 'alice-sub',
        email: 'alice@example.test',
        email_verified: options.emailVerified ?? true,
        name: 'Alice',
      };
    }),
  };
  return { module, configuration, calls, customFetch };
}

describe('EnterpriseOidcClient', () => {
  test('uses discovery, PKCE S256, and validated ID Token callback checks', async () => {
    const harness = createProtocolHarness();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const client = new EnterpriseOidcClient(
      BASE_CONFIG,
      fetchImpl,
      async () => harness.module,
    );

    const authorization = await client.buildAuthorizationRequest({
      state: 'state-123',
      nonce: 'nonce-123',
    });
    expect(authorization).toMatchObject({
      codeVerifier: 'verifier-123',
    });
    expect(
      new URL(authorization.authorizationUrl).searchParams.get('scope'),
    ).toBe('openid email profile');
    expect(harness.calls.authorization[0]).toMatchObject({
      redirect_uri: BASE_CONFIG.redirectUri,
      state: 'state-123',
      nonce: 'nonce-123',
      code_challenge: 'challenge-123',
      code_challenge_method: 'S256',
    });
    expect(harness.calls.discovery).toHaveLength(1);
    expect(harness.configuration[harness.customFetch]).toBe(fetchImpl);

    const userInfo = await client.exchangeCodeForUserInfo(
      new URL(
        'http://untrusted-host.test/api/auth/oidc/callback?code=code-123&state=state-123',
      ),
      {
        state: 'state-123',
        nonce: 'nonce-123',
        codeVerifier: authorization.codeVerifier,
      },
    );

    const [, normalizedCallback, checks] = harness.calls.grant[0];
    expect(normalizedCallback.toString()).toBe(
      `${BASE_CONFIG.redirectUri}?code=code-123&state=state-123`,
    );
    expect(checks).toEqual({
      pkceCodeVerifier: 'verifier-123',
      expectedState: 'state-123',
      expectedNonce: 'nonce-123',
      idTokenExpected: true,
    });
    expect(harness.calls.userinfo[0].slice(1)).toEqual([
      'access-123',
      'alice-sub',
    ]);
    expect(userInfo).toMatchObject({
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      email: 'alice@example.test',
      displayName: 'Alice',
    });
  });

  test('does not expose an unverified email when verified email is required', async () => {
    const harness = createProtocolHarness({ emailVerified: false });
    const client = new EnterpriseOidcClient(
      BASE_CONFIG,
      fetch,
      async () => harness.module,
    );
    const userInfo = await client.exchangeCodeForUserInfo(
      new URL(`${BASE_CONFIG.redirectUri}?code=code-123&state=state-123`),
      {
        state: 'state-123',
        nonce: 'nonce-123',
        codeVerifier: 'verifier-123',
      },
    );
    expect(userInfo.email).toBeUndefined();
  });
});

describe('resolveOidcRuntimeConfig', () => {
  test('defaults to a confidential client, adds openid scope, and requires HTTPS', () => {
    const config = resolveOidcRuntimeConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test/',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'http://127.0.0.1:3000/api/auth/oidc/callback',
      SMARTPERFETTO_OIDC_SCOPES: 'email profile',
    });
    expect(config).toMatchObject({
      issuerUrl: 'https://idp.example.test',
      clientAuthMethod: 'client_secret_post',
      scopes: ['openid', 'email', 'profile'],
      requireVerifiedEmail: true,
    });
    expect(() => resolveOidcRuntimeConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'http://127.0.0.1:3000/api/auth/oidc/callback',
    })).toThrow('must use HTTPS');
  });

  test('allows an explicit insecure local issuer and public-client auth', () => {
    expect(resolveOidcRuntimeConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://127.0.0.1:8080',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'local-client',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'http://127.0.0.1:3000/api/auth/oidc/callback',
      SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP: 'true',
      SMARTPERFETTO_OIDC_CLIENT_AUTH_METHOD: 'none',
      SMARTPERFETTO_OIDC_REQUIRE_VERIFIED_EMAIL: 'false',
    })).toMatchObject({
      allowInsecureHttp: true,
      clientAuthMethod: 'none',
      requireVerifiedEmail: false,
    });
  });

  test('rejects issuer URLs that bypass issuer discovery validation', () => {
    const baseEnv = {
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://smartperfetto.example.test/api/auth/oidc/callback',
    };
    expect(() => resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_ISSUER_URL:
        'https://idp.example.test/tenant?discovery=custom',
    })).toThrow('must not contain a query');
    expect(() => resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_ISSUER_URL:
        'https://idp.example.test/.well-known/openid-configuration',
    })).toThrow('must be an issuer identifier');
  });
});
