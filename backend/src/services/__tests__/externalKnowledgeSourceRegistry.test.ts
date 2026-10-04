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
import {channelAuthorizedRoots} from '../codebase/codebaseCapability';
import {
  type ExternalKnowledgeSource,
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
  sanitizeExternalKnowledgeSource,
} from '../externalKnowledgeSourceRegistry';
import {getScopedKnowledgeRecord, upsertScopedKnowledgeRecord} from '../scopedKnowledgeStore';

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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection',
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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
      kind: 'document_collection' as const,
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
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

describe('ExternalKnowledgeSourceRegistry document collections and deletion', () => {
  const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};

  function collectionInput(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'document_collection' as const,
      displayName: 'Team docs',
      rootRealpath: path.join(tmpDir, 'docs'),
      revision: 'content-1',
      contentFingerprint: 'c'.repeat(64),
      dirty: false,
      rightsAcknowledged: true,
      consentedBy: 'user-1',
      scope,
      ...overrides,
    };
  }

  function activate(registry: ExternalKnowledgeSourceRegistry, sourceId: string, generation: string) {
    return registry.withIngestLease(sourceId, scope, lease => lease.activateGeneration({
      generation,
      revision: `content-${generation}`,
      contentFingerprint: generation,
      dirty: false,
      indexedArticleCount: 1,
      indexedChunkCount: 1,
    }));
  }

  it('keeps recorded consent when a re-registration omits it and changes it only when explicit', () => {
    const input = (sendToProvider?: boolean) => collectionInput({sendToProvider});
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    expect(registry.register(input()).sendToProvider).toBe(false);
    const granted = registry.register(input(true));
    expect(granted).toEqual(expect.objectContaining({sendToProvider: true, consentedAt: expect.any(Number)}));
    const kept = registry.register({...input(), consentedBy: 'user-2'});
    expect(kept).toEqual(expect.objectContaining({
      sendToProvider: true,
      consentedAt: granted.consentedAt,
      consentedBy: 'user-1',
    }));
    const revoked = registry.register(input(false));
    expect(revoked.sendToProvider).toBe(false);
    expect(revoked.consentedAt).toBeUndefined();
  });

  it('records owner-written collection metadata, bounded and kept when omitted', () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register(collectionInput({
      description: '  Internal render framework and trace tags  ',
      attribution: 'Render team',
      license: 'Internal use only',
    }));
    expect(source).toEqual(expect.objectContaining({
      kind: 'document_collection',
      description: 'Internal render framework and trace tags',
      attribution: 'Render team',
      license: 'Internal use only',
    }));
    expect(registry.register(collectionInput())).toEqual(expect.objectContaining({
      description: 'Internal render framework and trace tags',
      attribution: 'Render team',
    }));
    expect(registry.register(collectionInput({attribution: ''})).attribution).toBeUndefined();
    expect(() => registry.register(collectionInput({description: 'x'.repeat(281)})))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_METADATA_INVALID'}));
  });

  it('allows local indexing and owner search on rights alone; provider access still needs consent', () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register(collectionInput());
    expect(registry.requireIndexAccess(source.sourceId, scope)).toEqual(source);
    expect(registry.evaluateAccess(source.sourceId, scope, [source.sourceId]))
      .toEqual({allowed: false, reason: 'provider_send_not_consented'});
    expect(() => registry.requireIndexAccess(source.sourceId, {...scope, userId: 'user-2'}))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_NOT_FOUND', status: 404}));
  });

  it('records the replaced generation of a document collection', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register(collectionInput());
    await activate(registry, source.sourceId, 'dc_one');
    const second = await activate(registry, source.sourceId, 'dc_two');
    expect(second).toEqual(expect.objectContaining({activeGeneration: 'dc_two', previousGeneration: 'dc_one'}));
    expect(registry.referencedGenerations(source.sourceId, scope)).toEqual(new Set(['dc_one', 'dc_two']));
  });

  it('tombstones before removing the index: access is revoked and every mutation refused until the record is gone', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register(collectionInput({sendToProvider: true}));
    await activate(registry, source.sourceId, 'dc_one');
    const observed: unknown[] = [];
    await expect(registry.remove(source.sourceId, scope, 'user-2', tombstone => {
      observed.push(
        tombstone.lifecycleState,
        tombstone.activeGeneration,
        tombstone.sendToProvider,
        registry.get(source.sourceId, scope),
        registry.list(scope),
        registry.evaluateAccess(source.sourceId, scope, [source.sourceId]),
        (() => {
          try {
            return registry.requireIndexAccess(source.sourceId, scope);
          } catch (error) {
            return (error as {code?: string}).code;
          }
        })(),
      );
      throw new Error('index_removal_failed_for_test');
    })).rejects.toThrow('index_removal_failed_for_test');
    expect(observed).toEqual([
      'deleting',
      undefined,
      false,
      undefined,
      [],
      {allowed: false, reason: 'source_not_found_or_out_of_scope'},
      'KNOWLEDGE_SOURCE_NOT_FOUND',
    ]);

    // The failed removal leaves the tombstone in force.
    expect(registry.get(source.sourceId, scope)).toBeUndefined();
    expect(() => registry.register(collectionInput({sendToProvider: true})))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_DELETING'}));
    expect(() => registry.setProviderConsent(source.sourceId, scope, true, 'user-1'))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_DELETING'}));
    await expect(activate(registry, source.sourceId, 'dc_two'))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_DELETING'});

    // A retry finishes it, and a later registration starts over.
    const removeIndex = jest.fn<(tombstone: ExternalKnowledgeSource, fence: unknown) => void>();
    await registry.remove(source.sourceId, scope, 'user-2', removeIndex);
    expect(removeIndex).toHaveBeenCalledWith(expect.objectContaining({lifecycleState: 'deleting'}), expect.anything());
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sources.json'), 'utf8'));
    expect(stored.sources).toEqual([]);
    await expect(registry.remove(source.sourceId, scope, 'user-2', removeIndex))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_NOT_FOUND'});
    const again = registry.register(collectionInput());
    expect(again).toEqual(expect.objectContaining({sendToProvider: false, indexGeneration: 0}));
    expect(again.activeGeneration).toBeUndefined();
  });

  it('does not let another scope delete a source', async () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    const source = registry.register(collectionInput());
    await expect(registry.remove(source.sourceId, {...scope, workspaceId: 'workspace-2'}, 'user-1', () => undefined))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_NOT_FOUND'});
    expect(registry.get(source.sourceId, scope)).toEqual(source);
  });

  it('removes the record from the enterprise store when it is the authority', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-remove.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'retired.json'));
    const source = registry.register(collectionInput());
    await registry.remove(source.sourceId, scope, 'user-1', () => undefined);
    expect(getScopedKnowledgeRecord('external_knowledge_source', source.sourceId, scope)).toBeUndefined();
    expect(registry.get(source.sourceId, scope)).toBeUndefined();
  });

  it('keeps a DB-only tombstone in force across dual-write until a retry removes both copies', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-dual-remove.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const storagePath = path.join(tmpDir, 'dual-remove.json');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = registry.register(collectionInput({sendToProvider: true}));
    jest.spyOn(registry as any, 'persist').mockImplementationOnce(() => {
      throw new Error('simulated_filesystem_persist_failure');
    });
    await expect(registry.remove(source.sourceId, scope, 'user-1', () => undefined))
      .rejects.toThrow('simulated_filesystem_persist_failure');
    expect(getScopedKnowledgeRecord<{lifecycleState?: string}>(
      'external_knowledge_source', source.sourceId, scope)?.record.lifecycleState).toBe('deleting');
    const other = new ExternalKnowledgeSourceRegistry(storagePath);
    expect(other.get(source.sourceId, scope)).toBeUndefined();
    expect(() => other.register(collectionInput({sendToProvider: true})))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_DELETING'}));

    await other.remove(source.sourceId, scope, 'user-1', () => undefined);
    expect(getScopedKnowledgeRecord('external_knowledge_source', source.sourceId, scope)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources).toEqual([]);
  });

  function useDualWrite(name: string): string {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, `${name}.sqlite`);
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    return path.join(tmpDir, `${name}.json`);
  }

  function failPersist(registry: ExternalKnowledgeSourceRegistry, pattern: readonly boolean[]): void {
    const target = registry as unknown as {persist(): void};
    // The prototype's method, not an earlier spy on this instance.
    const original = (ExternalKnowledgeSourceRegistry.prototype as unknown as {persist(): void}).persist;
    const spy = jest.spyOn(target, 'persist');
    for (const fail of pattern) {
      spy.mockImplementationOnce(() => {
        if (fail) throw new Error('simulated_filesystem_persist_failure');
        original.call(registry);
      });
    }
  }

  function expectDenied(storagePath: string, sourceId: string): void {
    const reader = new ExternalKnowledgeSourceRegistry(storagePath);
    expect(reader.get(sourceId, scope)).toBeUndefined();
    expect(reader.evaluateAccess(sourceId, scope, [sourceId]))
      .toEqual({allowed: false, reason: 'source_not_found_or_out_of_scope'});
  }

  it('keeps access denied through consecutive filesystem persist failures while deleting', async () => {
    const storagePath = useDualWrite('dual-delete-retry');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = registry.register(collectionInput({sendToProvider: true}));

    // Attempt 1: the DB tombstone lands, the filesystem copy does not.
    failPersist(registry, [true]);
    await expect(registry.remove(source.sourceId, scope, 'user-1', () => undefined))
      .rejects.toThrow('simulated_filesystem_persist_failure');
    expectDenied(storagePath, source.sourceId);

    // Attempt 2: the retry rewrites the tombstone everywhere before deleting, and fails there again.
    failPersist(registry, [true]);
    await expect(registry.remove(source.sourceId, scope, 'user-1', () => undefined))
      .rejects.toThrow('simulated_filesystem_persist_failure');
    expectDenied(storagePath, source.sourceId);

    // Attempt 3: both tombstones land, the DB record goes, the filesystem deletion fails.
    failPersist(registry, [false, true]);
    await expect(registry.remove(source.sourceId, scope, 'user-1', () => undefined))
      .rejects.toThrow('simulated_filesystem_persist_failure');
    expect(getScopedKnowledgeRecord('external_knowledge_source', source.sourceId, scope)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources)
      .toEqual([expect.objectContaining({lifecycleState: 'deleting', sendToProvider: false})]);
    expectDenied(storagePath, source.sourceId);

    await registry.remove(source.sourceId, scope, 'user-1', () => undefined);
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources).toEqual([]);
    expect(getScopedKnowledgeRecord('external_knowledge_source', source.sourceId, scope)).toBeUndefined();
  });

  it('does not let an omitted-consent re-registration restore a consent a partial dual write revoked', () => {
    const input = (sendToProvider?: boolean) => collectionInput({sendToProvider});
    const storagePath = useDualWrite('dual-consent');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = registry.register(input(true));
    failPersist(registry, [true]);
    expect(() => registry.setProviderConsent(source.sourceId, scope, false, 'user-2'))
      .toThrow('simulated_filesystem_persist_failure');
    expect(registry.get(source.sourceId, scope)?.sendToProvider).toBe(false);

    const reregistered = registry.register(input());
    expect(reregistered).toEqual(expect.objectContaining({sendToProvider: false, consentedBy: 'user-2'}));
    expect(reregistered.consentedAt).toBeUndefined();
    expect(registry.evaluateAccess(source.sourceId, scope, [source.sourceId]))
      .toEqual({allowed: false, reason: 'provider_send_not_consented'});
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources[0].sendToProvider).toBe(false);
    expect(getScopedKnowledgeRecord<{sendToProvider: boolean}>(
      'external_knowledge_source', source.sourceId, scope)?.record.sendToProvider).toBe(false);
    // Only an explicit grant restores it.
    expect(registry.register(input(true)).sendToProvider).toBe(true);
  });

  it('records the root channel of each registration and hides it from management projections', () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'channel.json'));
    const picked = registry.register(collectionInput({rootAuthorization: 'native_picker'}));
    expect(picked.rootAuthorization).toBe('native_picker');
    expect(sanitizeExternalKnowledgeSource(picked)).not.toHaveProperty('rootAuthorization');
    expect(channelAuthorizedRoots(picked)).toEqual({additionalAllowlistRoots: [picked.rootRealpath]});
    // A later registration through the configured allowlist records its own channel, not the picker's.
    const reregistered = registry.register(collectionInput());
    expect(reregistered.sourceId).toBe(picked.sourceId);
    expect(reregistered).not.toHaveProperty('rootAuthorization');
    expect(channelAuthorizedRoots(reregistered)).toBeUndefined();
    // The same folder in another scope is another source with no channel of its own.
    const otherScope = registry.register(collectionInput({scope: {...scope, userId: 'user-2'}}));
    expect(otherScope.sourceId).not.toBe(picked.sourceId);
    expect(channelAuthorizedRoots(otherScope)).toBeUndefined();
  });

  it('does not trust a root channel only one dual-write side records', () => {
    const storagePath = useDualWrite('dual-channel');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = registry.register(collectionInput({rootAuthorization: 'native_picker'}));
    expect(new ExternalKnowledgeSourceRegistry(storagePath).get(source.sourceId, scope)?.rootAuthorization)
      .toBe('native_picker');
    // The DB copy loses the channel; the filesystem copy (the dual-write authority) keeps it.
    const {rootAuthorization: _channel, ...unchannelled} = getScopedKnowledgeRecord<ExternalKnowledgeSource>(
      'external_knowledge_source', source.sourceId, scope)!.record;
    upsertScopedKnowledgeRecord('external_knowledge_source', source.sourceId, 'external-knowledge-source',
      unchannelled, scope);
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources[0].rootAuthorization).toBe('native_picker');
    const reader = new ExternalKnowledgeSourceRegistry(storagePath);
    expect(reader.get(source.sourceId, scope)).toBeDefined();
    expect(reader.get(source.sourceId, scope)).not.toHaveProperty('rootAuthorization');
    expect(reader.list(scope)[0]).not.toHaveProperty('rootAuthorization');
  });

  it('refuses fenced activation and clearing when only the filesystem copy is a tombstone', async () => {
    const storagePath = useDualWrite('dual-file-tombstone');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const source = registry.register(collectionInput({sendToProvider: true}));
    const stored = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    stored.sources[0].lifecycleState = 'deleting';
    fs.writeFileSync(storagePath, JSON.stringify(stored));

    await expect(activate(registry, source.sourceId, 'dc_one'))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_DELETING'});
    await expect(registry.withIngestLease(source.sourceId, scope, lease => lease.clearActiveGeneration()))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_DELETING'});
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources[0].lifecycleState).toBe('deleting');
    expect(getScopedKnowledgeRecord<{activeGeneration?: string}>(
      'external_knowledge_source', source.sourceId, scope)?.record.activeGeneration).toBeUndefined();
    expect(registry.get(source.sourceId, scope)).toBeUndefined();
  });

  it('bounds the display name', () => {
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
    expect(() => registry.register({...collectionInput(), displayName: 'x'.repeat(121)}))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_METADATA_INVALID'}));
  });

  it('lets a record stored before the limit keep its long name, but not take a new one', () => {
    const storagePath = path.join(tmpDir, 'legacy-sources.json');
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const stored = registry.register(collectionInput());
    const longName = 'Docs '.repeat(40).trim();
    // A record written before display names were bounded.
    const envelope = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    envelope.sources[0].displayName = longName;
    fs.writeFileSync(storagePath, JSON.stringify(envelope));
    expect(registry.register(collectionInput({displayName: longName}))).toMatchObject({
      sourceId: stored.sourceId, displayName: longName});
    expect(() => registry.register(collectionInput({displayName: `${longName} renamed`})))
      .toThrow(expect.objectContaining({code: 'KNOWLEDGE_SOURCE_METADATA_INVALID'}));
  });
});

describe('ExternalKnowledgeSourceRegistry retired Wiki records', () => {
  const scope = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
  const sourceId = `eks_${'a'.repeat(24)}`;

  /**
   * A record the retired Android Internals Wiki connector wrote: registration
   * no longer accepts the kind, so it exists only as stored state. It is
   * otherwise fully usable: rights, consent and an active index.
   */
  function retiredWikiRecord(): ExternalKnowledgeSource {
    return {
      kind: 'android_internals_wiki',
      sourceId,
      displayName: 'Android Internals Wiki',
      rootRealpath: path.join(tmpDir, 'wiki'),
      revision: 'a'.repeat(40),
      contentFingerprint: 'b'.repeat(64),
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      rightsAcknowledgedAt: 1,
      sendToProvider: true,
      consentedBy: 'user-1',
      consentedAt: 1,
      scope,
      indexGeneration: 1,
      activeGeneration: 'wiki_gen_1',
      indexedArticleCount: 1,
      indexedChunkCount: 2,
    };
  }

  function writeStoredSources(storagePath: string, sources: ExternalKnowledgeSource[]): void {
    fs.writeFileSync(storagePath, JSON.stringify({schemaVersion: 1, sources}));
  }

  it('still loads and lists a stored retired record but never grants it to a run', () => {
    const storagePath = path.join(tmpDir, 'retired-sources.json');
    writeStoredSources(storagePath, [retiredWikiRecord()]);
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);

    expect(registry.get(sourceId, scope)).toEqual(expect.objectContaining({kind: 'android_internals_wiki'}));
    expect(registry.list(scope).map(source => source.sourceId)).toEqual([sourceId]);
    expect(registry.evaluateAccess(sourceId, scope, [sourceId]))
      .toEqual({allowed: false, reason: 'knowledge_kind_retired'});
    // The whitelist and the scope are still checked first.
    expect(registry.evaluateAccess(sourceId, scope, []))
      .toEqual({allowed: false, reason: 'source_not_whitelisted'});
    expect(registry.evaluateAccess(sourceId, {...scope, workspaceId: 'workspace-2'}, [sourceId]))
      .toEqual({allowed: false, reason: 'source_not_found_or_out_of_scope'});
  });

  it('removes a stored retired record through the kind-agnostic deletion path', async () => {
    const storagePath = path.join(tmpDir, 'retired-remove.json');
    writeStoredSources(storagePath, [retiredWikiRecord()]);
    const registry = new ExternalKnowledgeSourceRegistry(storagePath);
    const removeIndex = jest.fn<(tombstone: ExternalKnowledgeSource, fence: unknown) => void>();

    await registry.remove(sourceId, scope, 'user-1', removeIndex);

    expect(removeIndex).toHaveBeenCalledWith(
      expect.objectContaining({kind: 'android_internals_wiki', lifecycleState: 'deleting', sendToProvider: false}),
      expect.anything(),
    );
    expect(registry.get(sourceId, scope)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(storagePath, 'utf8')).sources).toEqual([]);
  });

  it('refuses a retired record held by the enterprise store too', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-retired-kind.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    upsertScopedKnowledgeRecord('external_knowledge_source', sourceId, 'external-knowledge-source',
      retiredWikiRecord(), scope);
    const registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'enterprise-retired-kind.json'));

    expect(registry.list(scope).map(source => source.sourceId)).toEqual([sourceId]);
    expect(registry.evaluateAccess(sourceId, scope, [sourceId]))
      .toEqual({allowed: false, reason: 'knowledge_kind_retired'});
    await registry.remove(sourceId, scope, 'user-1', () => undefined);
    expect(getScopedKnowledgeRecord('external_knowledge_source', sourceId, scope)).toBeUndefined();
  });
});
