// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import {describe, expect, it} from '@jest/globals';

import {deriveServerSecret} from '../serverSecret';

const legacyDerivation = (root: string, purpose: string): Buffer =>
  crypto.createHmac('sha256', root).update(`smartperfetto.${purpose}.v1`).digest();

describe('server secret derivation', () => {
  it('derives stable, purpose-separated keys from the dedicated server secret', () => {
    const env = {
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
    } as NodeJS.ProcessEnv;

    expect(deriveServerSecret({purpose: 'browser-session', env})).toEqual(
      deriveServerSecret({purpose: 'browser-session', env}),
    );
    expect(deriveServerSecret({purpose: 'browser-session', env})).not.toEqual(
      deriveServerSecret({purpose: 'trace-processor-capability', env}),
    );
  });

  it('does not use the OIDC client secret as the server signing root', () => {
    const env = {
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'oidc-client-secret',
      SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
      FRONTEND_URL: 'https://app.example.test',
    } as NodeJS.ProcessEnv;

    expect(() => deriveServerSecret({purpose: 'browser-session', env})).toThrow(
      /SMARTPERFETTO_SERVER_SECRET/,
    );
  });

  it('keeps the caller-specific minimum for legacy signing roots', () => {
    const sixteenByteSecret = '1234567890abcdef';
    const env = {
      SMARTPERFETTO_ENTERPRISE: 'true',
      SMARTPERFETTO_API_KEY: sixteenByteSecret,
    } as NodeJS.ProcessEnv;

    expect(deriveServerSecret({
      purpose: 'external-issue-review',
      env,
      minimumBytes: 16,
    })).toEqual(deriveServerSecret({
      purpose: 'external-issue-review',
      env,
      minimumBytes: 16,
    }));
    expect(() => deriveServerSecret({
      purpose: 'trace-processor-capability',
      env,
      minimumBytes: 32,
    })).toThrow(/at least 32 bytes/);
  });

  // The provider-secret-store key encrypts data at rest and the browser-session
  // key signs live cookies: moving the selection rule must not rotate either.
  it.each(['provider-secret-store', 'browser-session'])(
    'keeps the %s key derived from the selected root exactly as before',
    (purpose) => {
      const root = 'test-server-secret-at-least-32-bytes';
      const env = {SMARTPERFETTO_SERVER_SECRET: `  ${root}  `} as NodeJS.ProcessEnv;
      expect(deriveServerSecret({purpose, env, minimumBytes: 32}))
        .toEqual(legacyDerivation(root, purpose));
    },
  );

  it('picks the first candidate long enough in UTF-8 bytes, in priority order', () => {
    const long = (label: string) => `${label}-secret-padded-to-at-least-32-bytes`;
    const purpose = 'trace-processor-capability';
    const derive = (env: Record<string, string>) => deriveServerSecret({
      purpose, env: env as NodeJS.ProcessEnv, preferredEnvKeys: ['PREFERRED'], minimumBytes: 32,
    });

    expect(derive({
      PREFERRED: long('preferred'),
      SMARTPERFETTO_SERVER_SECRET: long('server'),
    })).toEqual(legacyDerivation(long('preferred'), purpose));
    expect(derive({
      PREFERRED: 'too-short',
      SMARTPERFETTO_SERVER_SECRET: long('server'),
      SMARTPERFETTO_SSO_COOKIE_SECRET: long('cookie'),
    })).toEqual(legacyDerivation(long('server'), purpose));
    expect(derive({
      SMARTPERFETTO_SSO_COOKIE_SECRET: long('cookie'),
      SMARTPERFETTO_API_KEY: long('api'),
    })).toEqual(legacyDerivation(long('cookie'), purpose));
    // 16 characters, 32 UTF-8 bytes.
    const multibyte = 'é'.repeat(16);
    expect(derive({SMARTPERFETTO_API_KEY: multibyte}))
      .toEqual(legacyDerivation(multibyte, purpose));
  });

  it('names every candidate key when enterprise mode has no usable secret', () => {
    expect(() => deriveServerSecret({
      purpose: 'trace-processor-capability',
      env: {SMARTPERFETTO_ENTERPRISE: 'true'} as NodeJS.ProcessEnv,
      preferredEnvKeys: ['SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET'],
    })).toThrow(
      'set one of SMARTPERFETTO_TP_PROXY_CAPABILITY_SECRET, SMARTPERFETTO_SERVER_SECRET, '
      + 'SMARTPERFETTO_SSO_COOKIE_SECRET, SMARTPERFETTO_API_KEY',
    );
  });
});
