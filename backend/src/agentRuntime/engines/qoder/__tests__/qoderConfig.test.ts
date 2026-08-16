// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  getQoderRuntimeDiagnostics,
  resolveQoderRuntimeConfig,
} from '../qoderConfig';

describe('Qoder runtime configuration', () => {
  it('reports complete BYOK configuration without exposing the API key or URL credentials', () => {
    const diagnostics = getQoderRuntimeDiagnostics({
      QODER_PERSONAL_ACCESS_TOKEN: 'qoder-auth-secret',
      QODER_MODEL: 'deepseek-main',
      QODER_LIGHT_MODEL: 'deepseek-light',
      QODER_BYOK_API_KEY: 'deepseek-provider-secret',
      QODER_BYOK_PROVIDER: 'deepseek',
      QODER_BYOK_BASE_URL: 'https://user:pass@api.deepseek.com/v1?token=secret#fragment',
      QODER_BYOK_STYLE: 'openai',
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: '/opt/qoder-sdk/index.js',
    });

    expect(diagnostics).toMatchObject({
      configured: true,
      providerMode: 'qoder-byok',
      byokConfigured: true,
      byokApiKeyConfigured: true,
      byokProvider: 'deepseek',
      byokBaseUrl: 'https://api.deepseek.com/v1',
      byokStyle: 'openai',
      sdkModule: '/opt/qoder-sdk/index.js',
    });
    expect(JSON.stringify(diagnostics)).not.toContain('deepseek-provider-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('qoder-auth-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('user:pass');
    expect(JSON.stringify(diagnostics)).not.toContain('token=secret');
  });

  it('keeps Qoder authentication and BYOK model credentials as separate configuration', () => {
    const config = resolveQoderRuntimeConfig({
      QODER_MODEL: 'deepseek-main',
      QODER_BYOK_API_KEY: 'deepseek-provider-secret',
      QODER_BYOK_PROVIDER: 'deepseek',
    });

    expect(config.hasAccessToken).toBe(false);
    expect(config.byok).toEqual({
      apiKey: 'deepseek-provider-secret',
      provider: 'deepseek',
      baseUrl: undefined,
      style: undefined,
    });
  });
});
