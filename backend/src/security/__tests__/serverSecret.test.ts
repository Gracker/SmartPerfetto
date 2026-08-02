// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {deriveServerSecret} from '../serverSecret';

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
});
