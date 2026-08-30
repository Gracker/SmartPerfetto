// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { jest } from '@jest/globals';

import {
  getQoderRuntimeDiagnostics,
  resolveQoderRuntimeConfig,
} from '../qoderConfig';
import {
  loadQoderSdkModule,
  resetQoderSdkModuleCache,
  type QoderSdkModule,
} from '../qoderSdkLoader';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createSdkModule(label: string): QoderSdkModule & { label: string } {
  return {
    label,
    query: jest.fn(),
    qodercliAuth: jest.fn(),
    accessTokenFromEnv: jest.fn(),
    createSdkMcpServer: jest.fn(),
  };
}

describe('Qoder runtime configuration', () => {
  beforeEach(() => {
    resetQoderSdkModuleCache();
  });
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

describe('Qoder SDK module cache', () => {
  beforeEach(() => {
    resetQoderSdkModuleCache();
  });

  it('shares one pending import for the same resolved module-path fingerprint', async () => {
    const deferred = createDeferred<QoderSdkModule>();
    const importer = jest.fn<(specifier: string) => Promise<unknown>>()
      .mockReturnValue(deferred.promise);
    const env = { SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-a' };

    const first = loadQoderSdkModule(env, importer);
    const second = loadQoderSdkModule(env, importer);

    expect(importer).toHaveBeenCalledTimes(1);
    deferred.resolve(createSdkModule('shared'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ label: 'shared' }),
      expect.objectContaining({ label: 'shared' }),
    ]);
  });

  it('preserves ordered fallback specifiers and reuses the successful module', async () => {
    const sdk = createSdkModule('fallback');
    const importer = jest.fn<(specifier: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('package missing'))
      .mockResolvedValueOnce(sdk);

    await expect(loadQoderSdkModule({}, importer)).resolves.toBe(sdk);
    await expect(loadQoderSdkModule({}, importer)).resolves.toBe(sdk);

    expect(importer).toHaveBeenCalledTimes(2);
    expect(importer.mock.calls[0][0]).toBe('@qoder-ai/qoder-agent-sdk');
    expect(importer.mock.calls[1][0]).toMatch(/\.qoder-sdk.*qoder-agent-sdk.*index\.js/);
  });

  it('isolates configured paths and retries a failed fingerprint', async () => {
    const importer = jest.fn<(specifier: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('transient import failure'))
      .mockResolvedValueOnce(createSdkModule('retry-a'))
      .mockResolvedValueOnce(createSdkModule('path-b'));

    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-a',
    }, importer)).rejects.toThrow('transient import failure');
    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-a',
    }, importer)).resolves.toEqual(expect.objectContaining({ label: 'retry-a' }));
    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-b',
    }, importer)).resolves.toEqual(expect.objectContaining({ label: 'path-b' }));

    expect(importer.mock.calls.map(call => call[0])).toEqual([
      'qoder-sdk-a',
      'qoder-sdk-a',
      'qoder-sdk-b',
    ]);
  });

  it('clears the previous successful module when the configured path changes', async () => {
    const importer = jest.fn<(specifier: string) => Promise<unknown>>()
      .mockResolvedValueOnce(createSdkModule('path-a-first'))
      .mockResolvedValueOnce(createSdkModule('path-b'))
      .mockResolvedValueOnce(createSdkModule('path-a-after-change'));

    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-a',
    }, importer)).resolves.toEqual(expect.objectContaining({ label: 'path-a-first' }));
    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-b',
    }, importer)).resolves.toEqual(expect.objectContaining({ label: 'path-b' }));
    await expect(loadQoderSdkModule({
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-a',
    }, importer)).resolves.toEqual(expect.objectContaining({ label: 'path-a-after-change' }));

    expect(importer).toHaveBeenCalledTimes(3);
  });

  it('keeps a stale pending import from repopulating the cache after reset', async () => {
    const stale = createDeferred<QoderSdkModule>();
    const current = createDeferred<QoderSdkModule>();
    const importer = jest.fn<(specifier: string) => Promise<unknown>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const env = { SMARTPERFETTO_QODER_SDK_MODULE_PATH: 'qoder-sdk-reset' };

    const staleLoad = loadQoderSdkModule(env, importer);
    resetQoderSdkModuleCache();
    const currentLoad = loadQoderSdkModule(env, importer);
    current.resolve(createSdkModule('current'));
    await expect(currentLoad).resolves.toEqual(expect.objectContaining({ label: 'current' }));
    stale.resolve(createSdkModule('stale'));
    await expect(staleLoad).resolves.toEqual(expect.objectContaining({ label: 'stale' }));
    await expect(loadQoderSdkModule(env, importer)).resolves.toEqual(
      expect.objectContaining({ label: 'current' }),
    );
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
