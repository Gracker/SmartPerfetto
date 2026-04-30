// backend/src/services/providerManager/__tests__/providerStore.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderStore } from '../providerStore';
import type { ProviderConfig } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-id-1',
    name: 'Test Provider',
    category: 'official',
    type: 'anthropic',
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    connection: { apiKey: 'sk-test-key' },
    ...overrides,
  };
}

describe('ProviderStore', () => {
  let dir: string;
  let store: ProviderStore;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    store = new ProviderStore(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('initializes with empty array when file does not exist', () => {
    store.load();
    expect(store.getAll()).toEqual([]);
  });

  it('loads existing providers from file', async () => {
    const providers = [makeProvider()];
    await fsp.writeFile(path.join(dir, 'providers.json'), JSON.stringify(providers));
    store.load();
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].id).toBe('test-id-1');
  });

  it('gets a provider by id', () => {
    store.load();
    store.set(makeProvider({ id: 'abc' }));
    expect(store.get('abc')?.id).toBe('abc');
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('sets a provider and persists to file', async () => {
    store.load();
    store.set(makeProvider({ id: 'persist-test' }));

    const raw = await fsp.readFile(path.join(dir, 'providers.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('persist-test');
  });

  it('deletes a provider and persists', () => {
    store.load();
    store.set(makeProvider({ id: 'to-delete' }));
    expect(store.getAll()).toHaveLength(1);
    store.delete('to-delete');
    expect(store.getAll()).toHaveLength(0);
  });

  it('getActive returns the active provider', () => {
    store.load();
    store.set(makeProvider({ id: 'a', isActive: false }));
    store.set(makeProvider({ id: 'b', isActive: true }));
    expect(store.getActive()?.id).toBe('b');
  });

  it('getActive returns undefined when none active', () => {
    store.load();
    store.set(makeProvider({ id: 'a', isActive: false }));
    expect(store.getActive()).toBeUndefined();
  });
});
