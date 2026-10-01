// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';
import {
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
} from '../externalKnowledgeSourceRegistry';
import {getScopedKnowledgeRecord} from '../scopedKnowledgeStore';

let tmpDir: string;

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-knowledge-registry-'));
  delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
  delete process.env[ENTERPRISE_DB_PATH_ENV];
  delete process.env[ENTERPRISE_MIGRATION_PHASE_ENV];
});

afterEach(() => {
  restoreEnv(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnv(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnv(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('ExternalKnowledgeSourceRegistry', () => {
  it('is available as the persistent private-knowledge policy boundary', async () => {
    const modulePath = '../externalKnowledgeSourceRegistry';

    await expect(import(modulePath)).resolves.toHaveProperty('ExternalKnowledgeSourceRegistry');
  });

  it('shares one default registry between admin and runtime consumers', () => {
    expect(getDefaultExternalKnowledgeSourceRegistry())
      .toBe(getDefaultExternalKnowledgeSourceRegistry());
  });

  it('rejects registration without a separate right-to-use acknowledgement', () => {
    const Registry = ExternalKnowledgeSourceRegistry as any;
    const registry = new Registry(path.join(tmpDir, 'sources.json'));

    expect(() => registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: false,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope: {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'},
    })).toThrow(/right-to-use acknowledgement/i);
  });

  it('persists source identity, consent, rights, and scope', () => {
    const storagePath = path.join(tmpDir, 'sources.json');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath) as any;
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: true,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope: {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'},
    });

    const reloaded = (new ExternalKnowledgeSourceRegistry(storagePath) as any).get(
      source.sourceId,
      {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'},
    );

    expect(reloaded).toEqual(expect.objectContaining({
      sourceId: source.sourceId,
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: true,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
    }));
  });

  it('blocks retrieval immediately after provider consent is revoked', () => {
    const registry = new ExternalKnowledgeSourceRegistry(
      path.join(tmpDir, 'sources.json'),
    );
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });

    expect(registry.evaluateAccess(source.sourceId, scope, [source.sourceId])).toEqual({
      allowed: true,
      source,
    });

    registry.setProviderConsent(source.sourceId, scope, false, 'user-1');

    expect(registry.evaluateAccess(source.sourceId, scope, [source.sourceId])).toEqual({
      allowed: false,
      reason: 'provider_send_not_consented',
    });
  });

  it('uses the scoped enterprise store as cross-instance consent authority', () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const first = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'first.json'));
    const second = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'second.json'));
    const source = first.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });

    expect(second.evaluateAccess(source.sourceId, scope, [source.sourceId]))
      .toEqual(expect.objectContaining({allowed: true}));

    second.setProviderConsent(source.sourceId, scope, false, 'user-1');

    expect(first.evaluateAccess(source.sourceId, scope, [source.sourceId])).toEqual({
      allowed: false,
      reason: 'provider_send_not_consented',
    });
    expect(fs.existsSync(path.join(tmpDir, 'first.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'second.json'))).toBe(false);
  });

  it('fails closed across dual-write instances when filesystem consent persistence fails', () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-dual-consent.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const storagePath = path.join(tmpDir, 'dual-sources.json');
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const first = new ExternalKnowledgeSourceRegistry(storagePath);
    const second = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = first.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    jest.spyOn(first as any, 'persist').mockImplementationOnce(() => {
      throw new Error('simulated_filesystem_persist_failure');
    });

    expect(() => first.setProviderConsent(source.sourceId, scope, false, 'user-1'))
      .toThrow('simulated_filesystem_persist_failure');
    expect(second.evaluateAccess(source.sourceId, scope, [source.sourceId])).toEqual({
      allowed: false,
      reason: 'provider_send_not_consented',
    });
  });

  it('serializes reindex operations across enterprise registry instances', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-lease.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const first = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'first-lease.json'));
    const second = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'second-lease.json'));
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const acquired = new Promise<void>(resolve => {
      entered = resolve;
    });
    const firstRun = first.withIngestLease('source-a', scope, async () => {
      entered();
      await held;
      return 'first';
    });
    await acquired;

    await expect(second.withIngestLease('source-a', scope, () => 'second'))
      .rejects.toThrow('external_knowledge_reindex_in_progress');

    release();
    await expect(firstRun).resolves.toBe('first');
    await expect(second.withIngestLease('source-a', scope, () => 'second'))
      .resolves.toBe('second');
  });

  it('renews the enterprise lease row on every fence check', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-renew.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'renew.json'));
    const baseTime = 2_000_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    const leaseExpiry = (): number | undefined => getScopedKnowledgeRecord<{expiresAt: number}>(
      'external_knowledge_ingest_lease',
      'source-a',
      scope,
    )?.record.expiresAt;

    await registry.withIngestLease('source-a', scope, lease => {
      for (let step = 1; step <= 3; step += 1) {
        clock.mockReturnValue(baseTime + step);
        lease.assertHeld();
        expect(leaseExpiry()).toBe(baseTime + step + 10 * 60 * 1000);
      }
    });
  });

  it('atomically fences activation after an earlier lease check becomes stale', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-fence.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const first = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'first-fence.json'));
    const second = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'second-fence.json'));
    const source = first.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const baseTime = 2_000_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let checked!: () => void;
    const staleChecked = new Promise<void>(resolve => {
      checked = resolve;
    });
    const staleRun = first.withIngestLease(source.sourceId, scope, async lease => {
      lease.assertHeld();
      checked();
      await held;
      return lease.activateGeneration({
        generation: 'stale-generation',
        revision: 'c'.repeat(40),
        contentFingerprint: 'd'.repeat(64),
        dirty: false,
        indexedArticleCount: 1,
        indexedChunkCount: 1,
      });
    });
    await staleChecked;

    clock.mockReturnValue(baseTime + 10 * 60 * 1000 + 1);
    await second.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'current-generation',
        revision: 'e'.repeat(40),
        contentFingerprint: 'f'.repeat(64),
        dirty: false,
        indexedArticleCount: 2,
        indexedChunkCount: 3,
      }));
    release();

    await expect(staleRun).rejects.toThrow('external_knowledge_reindex_lease_lost');
    expect(first.get(source.sourceId, scope)).toEqual(expect.objectContaining({
      activeGeneration: 'current-generation',
      revision: 'e'.repeat(40),
      indexedChunkCount: 3,
    }));
  });

  it('atomically fences clear after an earlier lease check becomes stale', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-clear-fence.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const first = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'first-clear.json'));
    const second = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'second-clear.json'));
    const source = first.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });
    const baseTime = 2_100_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let checked!: () => void;
    const staleChecked = new Promise<void>(resolve => {
      checked = resolve;
    });
    const staleClear = first.withIngestLease(source.sourceId, scope, async lease => {
      lease.assertHeld();
      checked();
      await held;
      return lease.clearActiveGeneration();
    });
    await staleChecked;

    clock.mockReturnValue(baseTime + 10 * 60 * 1000 + 1);
    await second.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'current-generation',
        revision: 'c'.repeat(40),
        contentFingerprint: 'd'.repeat(64),
        dirty: false,
        indexedArticleCount: 2,
        indexedChunkCount: 3,
      }));
    release();

    await expect(staleClear).rejects.toThrow('external_knowledge_reindex_lease_lost');
    expect(first.get(source.sourceId, scope)).toEqual(expect.objectContaining({
      activeGeneration: 'current-generation',
      indexedChunkCount: 3,
    }));
  });

  it('does not expose a source across tenant or workspace scope', () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope: {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'},
    });

    expect(registry.evaluateAccess(
      source.sourceId,
      {tenantId: 'tenant-2', workspaceId: 'workspace-1', userId: 'user-1'},
      [source.sourceId],
    )).toEqual({allowed: false, reason: 'source_not_found_or_out_of_scope'});
  });

  it('activates a fully staged index generation with exact corpus identity', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(
      path.join(tmpDir, 'sources.json'),
    );
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const source = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    });

    const activated = await registry.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'gen-2',
        revision: 'c'.repeat(40),
        contentFingerprint: 'd'.repeat(64),
        dirty: true,
        indexedArticleCount: 12,
        indexedChunkCount: 34,
      }));

    expect(activated).toEqual(expect.objectContaining({
      activeGeneration: 'gen-2',
      indexGeneration: 1,
      revision: 'c'.repeat(40),
      contentFingerprint: 'd'.repeat(64),
      dirty: true,
      indexedArticleCount: 12,
      indexedChunkCount: 34,
    }));

    const cleared = await registry.withIngestLease(source.sourceId, scope, lease =>
      lease.clearActiveGeneration());
    expect(cleared.activeGeneration).toBeUndefined();
    expect(cleared.indexedArticleCount).toBe(0);
    expect(cleared.indexedChunkCount).toBe(0);
  });

  it('does not relabel an active generation when the same checkout is re-registered', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
    const base = {
      kind: 'android_internals_wiki' as const,
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: 'user-1',
      scope,
    };
    const source = registry.register({
      ...base,
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
    });
    await registry.withIngestLease(source.sourceId, scope, lease =>
      lease.activateGeneration({
        generation: 'gen-1',
        revision: 'c'.repeat(40),
        contentFingerprint: 'd'.repeat(64),
        dirty: false,
        indexedArticleCount: 1,
        indexedChunkCount: 2,
      }));

    const reregistered = registry.register({
      ...base,
      revision: 'e'.repeat(40),
      contentFingerprint: 'f'.repeat(64),
    });

    expect(reregistered).toEqual(expect.objectContaining({
      activeGeneration: 'gen-1',
      revision: 'c'.repeat(40),
      contentFingerprint: 'd'.repeat(64),
      indexedArticleCount: 1,
      indexedChunkCount: 2,
    }));
  });
});
