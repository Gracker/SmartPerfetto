// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  LocalEncryptedSecretStore,
  SECRET_STORE_KEYRING_ACCOUNT_ENV,
  SECRET_STORE_KEYRING_SERVICE_ENV,
  SECRET_STORE_MASTER_KEY_ENV,
} from '../localSecretStore';

const originalMasterKey = process.env[SECRET_STORE_MASTER_KEY_ENV];
const originalKeyringService = process.env[SECRET_STORE_KEYRING_SERVICE_ENV];
const originalKeyringAccount = process.env[SECRET_STORE_KEYRING_ACCOUNT_ENV];
const oidcEnvKeys = [
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  'SMARTPERFETTO_OIDC_REDIRECT_URI',
  'SMARTPERFETTO_SERVER_SECRET',
  'FRONTEND_URL',
] as const;
const originalOidcEnv = Object.fromEntries(
  oidcEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof oidcEnvKeys)[number], string | undefined>;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('LocalEncryptedSecretStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-secret-store-'));
    for (const key of oidcEnvKeys) delete process.env[key];
    process.env[SECRET_STORE_KEYRING_SERVICE_ENV] =
      `SmartPerfetto Test ${path.basename(tmpDir)}`;
    process.env[SECRET_STORE_KEYRING_ACCOUNT_ENV] = 'provider-master-key';
    process.env[SECRET_STORE_MASTER_KEY_ENV] = Buffer.alloc(32, 7).toString('base64');
  });

  afterEach(async () => {
    restoreEnvValue(SECRET_STORE_MASTER_KEY_ENV, originalMasterKey);
    restoreEnvValue(SECRET_STORE_KEYRING_SERVICE_ENV, originalKeyringService);
    restoreEnvValue(SECRET_STORE_KEYRING_ACCOUNT_ENV, originalKeyringAccount);
    for (const key of oidcEnvKeys) restoreEnvValue(key, originalOidcEnv[key]);
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  it('encrypts provider secrets with libsodium secretbox and never writes plaintext', async () => {
    const store = new LocalEncryptedSecretStore(tmpDir);
    expect(store.info()).toEqual(expect.objectContaining({
      algorithm: 'libsodium-secretbox',
      masterKeySource: 'env',
    }));

    expect(store.put('secret:provider:test', {
      openaiApiKey: 'sk-secret-value',
      openaiBaseUrl: 'not-sensitive-but-ignored-by-caller',
      empty: '',
    })).toBe(1);

    const raw = await fs.readFile(path.join(tmpDir, 'provider-secrets.enc.json'), 'utf-8');
    expect(raw).toContain('libsodium-secretbox');
    expect(raw).not.toContain('sk-secret-value');
    expect(raw).not.toContain('not-sensitive-but-ignored-by-caller');
    await expect(fs.access(path.join(tmpDir, '.master-key'))).rejects.toBeTruthy();

    expect(store.get('secret:provider:test')).toEqual({
      openaiApiKey: 'sk-secret-value',
      openaiBaseUrl: 'not-sensitive-but-ignored-by-caller',
    });
  });

  it('rotates ciphertext and version without changing the decrypted secret', async () => {
    const store = new LocalEncryptedSecretStore(tmpDir);
    store.put('secret:provider:test', {openaiApiKey: 'sk-secret-value'});
    const before = await fs.readFile(path.join(tmpDir, 'provider-secrets.enc.json'), 'utf-8');

    expect(store.rotate('secret:provider:test')).toBe(2);
    const after = await fs.readFile(path.join(tmpDir, 'provider-secrets.enc.json'), 'utf-8');

    expect(after).not.toEqual(before);
    expect(store.getVersion('secret:provider:test')).toBe(2);
    expect(store.get('secret:provider:test')).toEqual({
      openaiApiKey: 'sk-secret-value',
    });
  });

  it('derives the OIDC provider key from the deployment server secret', () => {
    delete process.env[SECRET_STORE_MASTER_KEY_ENV];
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test/api/auth/oidc/callback';
    process.env.SMARTPERFETTO_SERVER_SECRET =
      'test-server-secret-at-least-32-bytes';
    process.env.FRONTEND_URL = 'https://app.example.test';

    const first = new LocalEncryptedSecretStore(tmpDir);
    expect(first.info().masterKeySource).toBe('server-secret');
    first.put('secret:provider:oidc', {openaiApiKey: 'sk-oidc-secret'});

    const second = new LocalEncryptedSecretStore(tmpDir);
    expect(second.get('secret:provider:oidc')).toEqual({
      openaiApiKey: 'sk-oidc-secret',
    });
  });

  it('migrates legacy AES-GCM secret files to libsodium on read', async () => {
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({openaiApiKey: 'sk-legacy-secret'}), 'utf-8'),
      cipher.final(),
    ]);
    await fs.mkdir(tmpDir, {recursive: true});
    await fs.writeFile(path.join(tmpDir, 'provider-secrets.enc.json'), JSON.stringify({
      version: 1,
      entries: {
        'secret:provider:legacy': {
          version: 3,
          algorithm: 'aes-256-gcm',
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          updatedAt: 123,
        },
      },
    }), 'utf-8');

    const store = new LocalEncryptedSecretStore(tmpDir);

    expect(store.get('secret:provider:legacy')).toEqual({
      openaiApiKey: 'sk-legacy-secret',
    });
    expect(store.getVersion('secret:provider:legacy')).toBe(3);
    const migratedRaw = await fs.readFile(path.join(tmpDir, 'provider-secrets.enc.json'), 'utf-8');
    expect(JSON.parse(migratedRaw).version).toBe(2);
    expect(migratedRaw).toContain('libsodium-secretbox');
    expect(migratedRaw).not.toContain('sk-legacy-secret');
  });

  it('fails closed when the configured master key changes', () => {
    const store = new LocalEncryptedSecretStore(tmpDir);
    store.put('secret:provider:test', {openaiApiKey: 'sk-secret-value'});

    process.env[SECRET_STORE_MASTER_KEY_ENV] = Buffer.alloc(32, 9).toString('base64');
    const wrongKeyStore = new LocalEncryptedSecretStore(tmpDir);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(wrongKeyStore.get('secret:provider:test')).toEqual({});
    warnSpy.mockRestore();
  });

  it('fails closed instead of overwriting malformed encrypted storage', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'provider-secrets.enc.json'),
      '{not-json',
      'utf-8',
    );
    const store = new LocalEncryptedSecretStore(tmpDir);

    expect(() => store.put('secret:provider:new', {openaiApiKey: 'must-not-write'}))
      .toThrow(/secret_store_invalid_storage_requires_recovery/);
    await expect(fs.readFile(path.join(tmpDir, 'provider-secrets.enc.json'), 'utf-8'))
      .resolves.toBe('{not-json');
  });

  it('merges writes from separate store instances under the shared filesystem lock', () => {
    const first = new LocalEncryptedSecretStore(tmpDir);
    const second = new LocalEncryptedSecretStore(tmpDir);
    first.put('secret:first', {openaiApiKey: 'first'});
    second.put('secret:second', {openaiApiKey: 'second'});

    expect(first.get('secret:first')).toEqual({openaiApiKey: 'first'});
    expect(first.get('secret:second')).toEqual({openaiApiKey: 'second'});
  });
});
