// backend/src/services/providerManager/__tests__/providerService.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ProviderService } from '../providerService';
import type { ProviderCreateInput } from '../types';

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `provider-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('ProviderService', () => {
  let dir: string;
  let svc: ProviderService;

  beforeEach(async () => {
    dir = makeTmpDir();
    await fsp.mkdir(dir, { recursive: true });
    svc = new ProviderService(path.join(dir, 'providers.json'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const validInput: ProviderCreateInput = {
    name: 'My Anthropic',
    category: 'official',
    type: 'anthropic',
    models: { primary: 'claude-sonnet-4-6', light: 'claude-haiku-4-5' },
    connection: { apiKey: 'sk-ant-test123456' },
  };

  describe('create', () => {
    it('creates a provider with generated id and timestamps', () => {
      const result = svc.create(validInput);
      expect(result.id).toBeDefined();
      expect(result.name).toBe('My Anthropic');
      expect(result.isActive).toBe(false);
      expect(result.createdAt).toBeDefined();
    });

    it('throws on missing name', () => {
      expect(() => svc.create({ ...validInput, name: '' })).toThrow();
    });
  });

  describe('list (masked)', () => {
    it('masks apiKey in returned list', () => {
      svc.create(validInput);
      const list = svc.list();
      expect(list[0].connection.apiKey).toMatch(/^\*{4}/);
      expect(list[0].connection.apiKey).not.toBe('sk-ant-test123456');
    });
  });

  describe('activate', () => {
    it('sets provider as active and deactivates others', () => {
      const p1 = svc.create({ ...validInput, name: 'P1' });
      const p2 = svc.create({ ...validInput, name: 'P2' });
      svc.activate(p1.id);
      expect(svc.get(p1.id)!.isActive).toBe(true);
      svc.activate(p2.id);
      expect(svc.get(p1.id)!.isActive).toBe(false);
      expect(svc.get(p2.id)!.isActive).toBe(true);
    });

    it('throws on nonexistent id', () => {
      expect(() => svc.activate('fake-id')).toThrow();
    });
  });

  describe('delete', () => {
    it('deletes inactive provider', () => {
      const p = svc.create(validInput);
      svc.delete(p.id);
      expect(svc.list()).toHaveLength(0);
    });

    it('throws when deleting active provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      expect(() => svc.delete(p.id)).toThrow(/active/i);
    });
  });

  describe('getEffectiveEnv', () => {
    it('returns null when no active provider', () => {
      expect(svc.getEffectiveEnv()).toBeNull();
    });

    it('returns env vars for active anthropic provider', () => {
      const p = svc.create(validInput);
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
      expect(env.CLAUDE_MODEL).toBe('claude-sonnet-4-6');
      expect(env.CLAUDE_LIGHT_MODEL).toBe('claude-haiku-4-5');
    });

    it('returns bedrock env vars', () => {
      const p = svc.create({
        ...validInput,
        type: 'bedrock',
        connection: { awsRegion: 'us-west-2', awsBearerToken: 'tok123' },
      });
      svc.activate(p.id);
      const env = svc.getEffectiveEnv()!;
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.AWS_REGION).toBe('us-west-2');
      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('tok123');
    });
  });

  describe('getEnvForProvider', () => {
    it('returns env for a specific provider by id', () => {
      const p = svc.create(validInput);
      const env = svc.getEnvForProvider(p.id)!;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });

    it('returns null for nonexistent id', () => {
      expect(svc.getEnvForProvider('nope')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates name without touching credentials', () => {
      const p = svc.create(validInput);
      svc.update(p.id, { name: 'Renamed' });
      expect(svc.get(p.id)!.name).toBe('Renamed');
      expect(svc.getEnvForProvider(p.id)!.ANTHROPIC_API_KEY).toBe('sk-ant-test123456');
    });
  });
});
