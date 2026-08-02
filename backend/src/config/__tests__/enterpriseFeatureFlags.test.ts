// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  ENTERPRISE_FEATURE_FLAG_ENV,
  resolveAuthConfig,
  resolveFeatureConfig,
  resolveServerConfig,
  SMARTPERFETTO_BACKEND_PORT_ENV,
  SMARTPERFETTO_FRONTEND_PORT_ENV,
} from '../index';

describe('enterprise feature flag', () => {
  it('defaults enterprise mode off', () => {
    expect(resolveFeatureConfig({}).enterprise).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', 'enabled'])(
    'enables enterprise mode for %s',
    (value) => {
      expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: value }).enterprise).toBe(true);
    }
  );

  it.each(['0', 'false', 'FALSE', 'no', 'off', 'disabled'])(
    'keeps enterprise mode off for %s',
    (value) => {
      expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: value }).enterprise).toBe(false);
    }
  );

  it('does not enable enterprise mode for unknown values', () => {
    expect(resolveFeatureConfig({ [ENTERPRISE_FEATURE_FLAG_ENV]: 'enterprise' }).enterprise).toBe(false);
  });

  it('enables enterprise behavior with minimal OIDC values and a server secret', () => {
    const env = {
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test:3000/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'https://app.example.test:10000',
    } as NodeJS.ProcessEnv;
    expect(resolveAuthConfig(env)).toMatchObject({
      mode: 'oidc',
      oidcEnabled: true,
      cookieSecure: true,
    });
    expect(resolveFeatureConfig(env).enterprise).toBe(true);
  });

  it('fails closed for partial OIDC configuration', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
    })).toThrow(/requires SMARTPERFETTO_OIDC_CLIENT_ID/);
  });

  it('requires a dedicated persistent server secret for OIDC sessions', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
      FRONTEND_URL: 'https://app.example.test',
    })).toThrow(/SMARTPERFETTO_SERVER_SECRET/);
  });

  it('rejects plaintext OIDC URLs unless the test-only override is explicit', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'http://app.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'http://app.example.test',
    })).toThrow(/absolute HTTPS URL/);
  });

  it('allows an explicit plaintext OIDC test deployment without Secure cookies', () => {
    expect(resolveAuthConfig({
      NODE_ENV: 'production',
      SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP: 'true',
      SMARTPERFETTO_OIDC_ISSUER_URL: 'http://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'http://app.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'http://app.example.test',
    })).toMatchObject({
      mode: 'oidc',
      allowInsecureHttp: true,
      cookieSecure: false,
    });
  });

  it('rejects trusted identity headers when the built-in OIDC flow is active', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      SMARTPERFETTO_SSO_TRUSTED_HEADERS: 'true',
      FRONTEND_URL: 'https://app.example.test',
    })).toThrow(/cannot be combined/);
  });

  it('rejects the legacy static API key when the built-in OIDC flow is active', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      SMARTPERFETTO_API_KEY: 'legacy-static-key',
      FRONTEND_URL: 'https://app.example.test',
    })).toThrow(/cannot be combined with SMARTPERFETTO_API_KEY/);
  });

  it('rejects cross-site frontend and callback hosts for Lax session cookies', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://backend.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'https://app.example.test',
    })).toThrow(/same scheme and hostname/);
  });

  it('rejects a browser backend URL that cannot receive the callback cookie', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://backend.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      SMARTPERFETTO_BACKEND_PUBLIC_URL: 'https://other.example.test',
      FRONTEND_URL: 'https://backend.example.test',
    })).toThrow(/BACKEND_PUBLIC_URL.*same scheme and hostname/i);
  });

  it('validates the public callback path before startup', () => {
    expect(() => resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/wrong-callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'https://app.example.test',
    })).toThrow(/must end with \/api\/auth\/oidc\/callback/);

    expect(resolveAuthConfig({
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://app.example.test/smartperfetto/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      SMARTPERFETTO_BACKEND_PUBLIC_URL: 'https://app.example.test/smartperfetto',
      FRONTEND_URL: 'https://app.example.test',
    }).mode).toBe('oidc');
  });
});

describe('server port config', () => {
  it('keeps default backend and frontend ports', () => {
    expect(resolveServerConfig({}).port).toBe(DEFAULT_BACKEND_PORT);
    expect(resolveServerConfig({}).frontendPort).toBe(DEFAULT_FRONTEND_PORT);
    expect(resolveServerConfig({}).bindHost).toBe('127.0.0.1');
  });

  it('requires an explicit opt-in before listening beyond loopback', () => {
    expect(resolveServerConfig({SMARTPERFETTO_BIND_HOST: '0.0.0.0'}).bindHost).toBe('0.0.0.0');
  });

  it('prefers SMARTPERFETTO_BACKEND_PORT over PORT', () => {
    expect(resolveServerConfig({
      PORT: '3100',
      [SMARTPERFETTO_BACKEND_PORT_ENV]: '3200',
    }).port).toBe(3200);
  });

  it('falls back to PORT when the preferred backend port is invalid', () => {
    expect(resolveServerConfig({
      PORT: '3100',
      [SMARTPERFETTO_BACKEND_PORT_ENV]: '3000abc',
    }).port).toBe(3100);
  });

  it('rejects out-of-range frontend ports and keeps the default', () => {
    expect(resolveServerConfig({
      [SMARTPERFETTO_FRONTEND_PORT_ENV]: '70000',
    }).frontendPort).toBe(DEFAULT_FRONTEND_PORT);
  });

  it('includes the configured frontend port in default CORS origins', () => {
    expect(resolveServerConfig({
      [SMARTPERFETTO_FRONTEND_PORT_ENV]: '11000',
    }).corsOrigins).toEqual(expect.arrayContaining([
      'http://localhost:11000',
      'http://127.0.0.1:11000',
    ]));
  });
});
