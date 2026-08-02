// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  createPkceChallenge,
  EnterpriseOidcClient,
  resolveOidcRuntimeConfig,
  type OidcRuntimeConfig,
} from '../enterpriseOidcClient';

function runtimeConfig(
  overrides: Partial<OidcRuntimeConfig> = {},
): OidcRuntimeConfig {
  return {
    issuerUrl: 'https://idp.example.test',
    clientId: 'client-a',
    clientSecret: 'secret-a',
    redirectUri: 'https://app.example.test/api/auth/oidc/callback',
    scopes: ['openid', 'email', 'profile'],
    allowInsecureHttp: false,
    requestTimeoutMs: 10_000,
    ...overrides,
  };
}

function mockOpenidClient(input: {
  idTokenClaims?: Record<string, unknown>;
  serverMetadata?: Record<string, unknown>;
  userInfo?: Record<string, unknown>;
} = {}) {
  const customFetch = Symbol('customFetch');
  const allowInsecureRequests = jest.fn();
  const clientAuth = jest.fn();
  const configuration = {
    serverMetadata: jest.fn(() => ({
      issuer: 'https://idp.example.test',
      userinfo_endpoint: 'https://idp.example.test/userinfo',
      ...input.serverMetadata,
    })),
  } as Record<PropertyKey, unknown>;
  const tokens = {
    access_token: 'access-123',
    claims: jest.fn(() => ({
      sub: 'alice-sub',
      email: 'alice-token@example.test',
      email_verified: true,
      name: 'Alice Token',
      ...input.idTokenClaims,
    })),
  };
  const module = {
    customFetch,
    allowInsecureRequests,
    ClientSecretBasic: jest.fn(() => clientAuth),
    discovery: jest.fn(async () => configuration),
    buildAuthorizationUrl: jest.fn((_configuration, params) => {
      const url = new URL('https://idp.example.test/authorize');
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') url.searchParams.set(key, value);
      }
      return url;
    }),
    authorizationCodeGrant: jest.fn(async () => tokens),
    fetchUserInfo: jest.fn(async () => ({
      sub: 'alice-sub',
      email: 'alice@example.test',
      email_verified: true,
      name: 'Alice',
      ...input.userInfo,
    })),
  };
  return {allowInsecureRequests, clientAuth, configuration, customFetch, module, tokens};
}

describe('EnterpriseOidcClient', () => {
  test('delegates discovery, PKCE, callback validation, and userinfo to openid-client', async () => {
    const mocked = mockOpenidClient();
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const client = new EnterpriseOidcClient(
      runtimeConfig(),
      fetchImpl,
      async () => mocked.module as never,
    );

    const authorizationUrl = await client.buildAuthorizationUrl({
      state: 'state-123',
      nonce: 'nonce-123',
      codeChallenge: createPkceChallenge('verifier-123'),
    });
    expect(authorizationUrl).toContain('response_mode=query');
    expect(authorizationUrl).toContain('code_challenge_method=S256');
    expect(mocked.module.discovery).toHaveBeenCalledWith(
      new URL('https://idp.example.test'),
      'client-a',
      {
        client_secret: 'secret-a',
        token_endpoint_auth_method: 'client_secret_basic',
      },
      mocked.clientAuth,
      expect.objectContaining({timeout: 10}),
    );
    expect(mocked.module.ClientSecretBasic).toHaveBeenCalledWith('secret-a');
    expect(mocked.module.buildAuthorizationUrl).toHaveBeenCalledWith(
      mocked.configuration,
      expect.objectContaining({
        redirect_uri: 'https://app.example.test/api/auth/oidc/callback',
        scope: 'openid email profile',
        state: 'state-123',
        nonce: 'nonce-123',
        code_challenge_method: 'S256',
      }),
    );
    expect(mocked.configuration[mocked.customFetch]).toBe(fetchImpl);

    const userInfo = await client.exchangeCodeForUserInfo('code-123', {
      codeVerifier: 'verifier-123',
      expectedState: 'state-123',
      expectedNonce: 'nonce-123',
    });
    expect(mocked.module.authorizationCodeGrant).toHaveBeenCalledWith(
      mocked.configuration,
      new URL(
        'https://app.example.test/api/auth/oidc/callback?code=code-123&state=state-123',
      ),
      {
        pkceCodeVerifier: 'verifier-123',
        expectedState: 'state-123',
        expectedNonce: 'nonce-123',
        idTokenExpected: true,
      },
    );
    expect(mocked.module.fetchUserInfo).toHaveBeenCalledWith(
      mocked.configuration,
      'access-123',
      'alice-sub',
    );
    expect(userInfo).toMatchObject({
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      email: 'alice@example.test',
      displayName: 'Alice',
    });
  });

  test('does not trust an email claim unless the provider verified it', async () => {
    const mocked = mockOpenidClient({
      idTokenClaims: {email_verified: false},
      userInfo: {email: 'unverified@example.test', email_verified: false},
    });
    const client = new EnterpriseOidcClient(
      runtimeConfig(),
      fetch,
      async () => mocked.module as never,
    );

    const userInfo = await client.exchangeCodeForUserInfo('code-123', {
      codeVerifier: 'verifier-123',
      expectedState: 'state-123',
      expectedNonce: 'nonce-123',
    });

    expect(userInfo.email).toBeUndefined();
  });

  test('uses the fixed minimal runtime policy and explicit insecure HTTP test flag', () => {
    const baseEnv = {
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test/',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://app.example.test/api/auth/oidc/callback',
    };
    expect(resolveOidcRuntimeConfig(baseEnv)).toEqual({
      issuerUrl: 'https://idp.example.test/',
      clientId: 'client-a',
      clientSecret: 'secret-a',
      redirectUri: 'https://app.example.test/api/auth/oidc/callback',
      scopes: ['openid', 'email', 'profile'],
      allowInsecureHttp: false,
      requestTimeoutMs: 10_000,
    });
    expect(resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_CLIENT_SECRET: '',
    })).toBeNull();
    expect(() => resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://idp.example.test',
    })).toThrow(/must use HTTPS/);

    const insecure = resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://idp.example.test/',
      SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP: 'true',
    });
    expect(insecure?.issuerUrl).toBe('http://idp.example.test/');
    expect(insecure?.allowInsecureHttp).toBe(true);

    expect(resolveOidcRuntimeConfig({
      ...baseEnv,
      SMARTPERFETTO_OIDC_ISSUER_URL:
        'https://idp.example.test/application/o/smartperfetto',
    })?.issuerUrl).toBe(
      'https://idp.example.test/application/o/smartperfetto',
    );
  });

  test('passes the insecure HTTP extension to discovery only when enabled', async () => {
    const mocked = mockOpenidClient();
    const client = new EnterpriseOidcClient(
      runtimeConfig({
        issuerUrl: 'http://idp.example.test',
        allowInsecureHttp: true,
      }),
      fetch,
      async () => mocked.module as never,
    );

    await client.buildAuthorizationUrl({
      state: 'state-123',
      nonce: 'nonce-123',
      codeChallenge: 'challenge-123',
    });

    expect(mocked.module.discovery).toHaveBeenCalledWith(
      new URL('http://idp.example.test'),
      'client-a',
      expect.any(Object),
      mocked.clientAuth,
      expect.objectContaining({execute: [mocked.allowInsecureRequests]}),
    );
  });
});
