// backend/src/services/providerManager/__tests__/providerStore.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { jest } from '@jest/globals';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderStore, ProviderStoreUnreadableError } from '../providerStore';
import type { ProviderConfig } from '../types';
import { warningsDuring } from '../../../../tests/helpers/consoleWarnings';

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

  it('logs an unreadable providers.json by position, never its keys', async () => {
    // Unquoted, so the parser would quote the key around it.
    await fsp.writeFile(path.join(dir, 'providers.json'), '[{"connection":{"apiKey":sk-PROVIDER-CANARY-9e1}}]');
    const warnings = warningsDuring(() => store.load());
    expect(store.getAll()).toEqual([]);
    expect(warnings).toEqual([[
      '[ProviderStore] providers.json could not be read; provider writes are refused until it is repaired',
      expect.objectContaining({store: 'providers.json', reason: 'invalid_json'})]]);
    expect(JSON.stringify(warnings)).not.toContain('PROVIDER-CANARY');
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

describe('ProviderStore with an unreadable providers.json', () => {
  const CANARY = 'sk-canary-7f3e1b2a9d';
  let dir: string;
  let file: string;
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    file = path.join(dir, 'providers.json');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function expectUnreadable(store: ProviderStore): void {
    expect(store.getStatus()).toBe('unreadable');
    expect(store.getAll()).toEqual([]);
    expect(() => store.assertWritable()).toThrow(ProviderStoreUnreadableError);
  }

  const brokenFiles: Array<[string, string]> = [
    ['invalid JSON', `[{"id":"a","connection":{"apiKey":"${CANARY}"}`],
    ['a non-array', JSON.stringify({ id: 'a', apiKey: CANARY })],
    ['an entry without an id', JSON.stringify([makeProvider({ connection: { apiKey: CANARY } }), { name: 'x', models: {}, connection: {} }])],
    ['a repeated id', JSON.stringify([makeProvider({ connection: { apiKey: CANARY } }), makeProvider()])],
    ['an entry without a connection', JSON.stringify([{ ...makeProvider(), connection: null }])],
  ];

  it.each(brokenFiles)('refuses writes for %s and leaves memory and disk unchanged', async (_label, content) => {
    await fsp.writeFile(file, content);
    const store = new ProviderStore(file);
    store.load();
    expectUnreadable(store);

    expect(() => store.set(makeProvider({ id: 'new' }))).toThrow(ProviderStoreUnreadableError);
    expect(() => store.delete('test-id-1')).toThrow(ProviderStoreUnreadableError);

    expect(store.get('new')).toBeUndefined();
    expect(store.getAll()).toEqual([]);
    expect(await fsp.readFile(file, 'utf-8')).toBe(content);
    expect((await fsp.readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it('never logs text from the broken file', async () => {
    await fsp.writeFile(file, `[{"id":"a","connection":{"apiKey":"${CANARY}"`);
    const store = new ProviderStore(file);
    store.load();
    store.getAll();
    store.load();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
  });

  it('picks up a repaired file without data loss and accepts writes again', async () => {
    await fsp.writeFile(file, '[{"id": ');
    const store = new ProviderStore(file);
    store.load();
    expectUnreadable(store);

    const repaired = [makeProvider({ id: 'kept-a' }), makeProvider({ id: 'kept-b', isActive: true })];
    await fsp.writeFile(file, JSON.stringify(repaired));
    expect(store.getStatus()).toBe('ok');
    expect(store.getAll().map(p => p.id)).toEqual(['kept-a', 'kept-b']);

    store.set(makeProvider({ id: 'added' }));
    const persisted = JSON.parse(await fsp.readFile(file, 'utf-8')) as ProviderConfig[];
    expect(persisted.map(p => p.id)).toEqual(['kept-a', 'kept-b', 'added']);
  });

  it('refuses a write when the file broke after a successful load', async () => {
    await fsp.writeFile(file, JSON.stringify([makeProvider({ id: 'kept' })]));
    const store = new ProviderStore(file);
    store.load();
    expect(store.getStatus()).toBe('ok');

    const broken = `[{"id":"kept","connection":{"apiKey":"${CANARY}"`;
    await fsp.writeFile(file, broken);
    expect(() => store.set(makeProvider({ id: 'new' }))).toThrow(ProviderStoreUnreadableError);
    expect(await fsp.readFile(file, 'utf-8')).toBe(broken);
  });

  it('writes on top of an edit made since the last load instead of the stale cache', async () => {
    await fsp.writeFile(file, JSON.stringify([makeProvider({ id: 'first' })]));
    const store = new ProviderStore(file);
    store.load();

    await fsp.writeFile(file, JSON.stringify([makeProvider({ id: 'first' }), makeProvider({ id: 'hand-added' })]));
    store.set(makeProvider({ id: 'api-added' }));

    const persisted = JSON.parse(await fsp.readFile(file, 'utf-8')) as ProviderConfig[];
    expect(persisted.map(p => p.id)).toEqual(['first', 'hand-added', 'api-added']);
  });

  it('picks up a permission repair', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await fsp.writeFile(file, JSON.stringify([makeProvider({ id: 'locked' })]));
    await fsp.chmod(file, 0o000);
    const store = new ProviderStore(file);
    store.load();
    expectUnreadable(store);

    await fsp.chmod(file, 0o600);
    expect(store.getStatus()).toBe('ok');
    expect(store.get('locked')?.id).toBe('locked');
  });

  it.each([['an empty file', ''], ['a whitespace-only file', '  \n'], ['a BOM-prefixed array', `﻿${JSON.stringify([makeProvider()])}`]])(
    'reads %s as a valid store',
    async (_label, content) => {
      await fsp.writeFile(file, content);
      const store = new ProviderStore(file);
      store.load();
      expect(store.getStatus()).toBe('ok');
      expect(() => store.set(makeProvider({ id: 'new' }))).not.toThrow();
    },
  );

  it('treats a removed file as an empty, writable store', async () => {
    await fsp.writeFile(file, '{');
    const store = new ProviderStore(file);
    store.load();
    expectUnreadable(store);

    await fsp.rm(file);
    expect(store.getStatus()).toBe('ok');
    store.set(makeProvider({ id: 'fresh' }));
    expect(store.get('fresh')?.id).toBe('fresh');
  });
});
