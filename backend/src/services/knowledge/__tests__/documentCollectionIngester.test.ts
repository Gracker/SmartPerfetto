// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../../config';
import {ENTERPRISE_DB_PATH_ENV} from '../../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../../enterpriseMigration';
import {
  type ExternalKnowledgeIngestLeaseGuard,
  ExternalKnowledgeSourceRegistry,
} from '../../externalKnowledgeSourceRegistry';
import {DocumentCollectionIngester} from '../documentCollectionIngester';
import {DocumentCollectionStore, KnowledgeIndexUnavailableError} from '../documentCollectionStore';

const SCOPE = {tenantId: 'tenant-1', workspaceId: 'workspace-1', userId: 'user-1'};
const ENV_KEYS = [
  'SMARTPERFETTO_KNOWLEDGE_ROOTS',
  ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_DB_PATH_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let tmpDir: string;
let docsRoot: string;
let indexRoot: string;
let registry: ExternalKnowledgeSourceRegistry;
let ingester: DocumentCollectionIngester;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'document-collection-ingester-')));
  docsRoot = path.join(tmpDir, 'docs');
  indexRoot = path.join(tmpDir, 'index');
  fs.mkdirSync(docsRoot);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SMARTPERFETTO_KNOWLEDGE_ROOTS = docsRoot;
  registry = new ExternalKnowledgeSourceRegistry(path.join(tmpDir, 'sources.json'));
  ingester = new DocumentCollectionIngester(registry, new DocumentCollectionStore(indexRoot));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function writeDoc(relativePath: string, content: string): void {
  const filePath = path.join(docsRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, content);
}

function register(sendToProvider?: boolean) {
  return registry.register({
    kind: 'document_collection',
    displayName: 'Team docs',
    rootRealpath: docsRoot,
    revision: 'content-initial',
    contentFingerprint: 'initial',
    dirty: false,
    description: 'Internal render framework notes',
    rightsAcknowledged: true,
    sendToProvider,
    consentedBy: 'user-1',
    scope: SCOPE,
  });
}

/** Every generation file of the one registered source. */
function indexFiles(): string[] {
  if (!fs.existsSync(indexRoot)) return [];
  return fs.readdirSync(indexRoot).flatMap(scopeDirectory =>
    fs.readdirSync(path.join(indexRoot, scopeDirectory)).flatMap(sourceId =>
      fs.readdirSync(path.join(indexRoot, scopeDirectory, sourceId)))).sort();
}

/** Run the next ingest with `override` applied to its lease guard. */
function overrideLease(override: (guard: ExternalKnowledgeIngestLeaseGuard) => Partial<ExternalKnowledgeIngestLeaseGuard>): void {
  const original = registry.withIngestLease.bind(registry);
  jest.spyOn(registry, 'withIngestLease').mockImplementationOnce((sourceId, scope, operation) =>
    original(sourceId, scope, guard => operation({...guard, ...override(guard)})));
}

describe('DocumentCollectionIngester', () => {
  it('previews counts and fingerprints without registering anything', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    writeDoc('b.txt', ' \n');
    const preview = await ingester.previewIndexable(docsRoot);
    expect(preview.summary).toEqual(expect.objectContaining({documentCount: 1, skipped: {empty_text: 1}}));
    await expect(ingester.previewIndexable(path.join(tmpDir, 'index'))).rejects.toMatchObject({
      code: 'KNOWLEDGE_ROOT_BLOCKED',
      details: {blockedReason: 'root_not_found'},
    });
    await expect(ingester.previewIndexable(tmpDir)).rejects.toMatchObject({
      code: 'KNOWLEDGE_ROOT_BLOCKED',
      details: {blockedReason: 'root_outside_allowlist'},
    });
    fs.writeFileSync(path.join(docsRoot, 'a.md'), '  \n');
    await expect(ingester.previewIndexable(docsRoot)).rejects.toMatchObject({
      code: 'KNOWLEDGE_COLLECTION_EMPTY',
      details: {empty_text: 2},
    });
  });

  it('indexes without provider-send consent and answers the owner search from the active generation', async () => {
    writeDoc('render/compositor.md', '# Compositor\nXRenderCompositorWorker composes every frame.\n');
    writeDoc('notes.txt', 'binder notes\n');
    const source = register();
    expect(source.sendToProvider).toBe(false);
    expect(() => ingester.search(source.sourceId, SCOPE, 'binder', 5)).toThrow(KnowledgeIndexUnavailableError);

    const result = await ingester.ingest(source.sourceId, SCOPE);
    expect(result).toEqual(expect.objectContaining({
      documentCount: 2,
      chunkCount: 2,
      generation: expect.stringMatching(/^dc_[0-9a-f]{32}$/),
      cleanup: {status: 'completed', removedFileCount: 0, failedFileCount: 0},
    }));
    expect(registry.get(source.sourceId, SCOPE)).toEqual(expect.objectContaining({
      activeGeneration: result.generation,
      contentFingerprint: result.contentFingerprint,
      indexedArticleCount: 2,
      indexedChunkCount: 2,
      sendToProvider: false,
    }));
    const found = ingester.search(source.sourceId, SCOPE, 'XRenderCompositorWorker', 5);
    expect(found.generation).toBe(result.generation);
    expect(found.hits[0]).toEqual(expect.objectContaining({relativePath: 'render/compositor.md', heading: 'Compositor'}));
    expect(registry.evaluateAccess(source.sourceId, SCOPE, [source.sourceId])).toEqual({
      allowed: false,
      reason: 'provider_send_not_consented',
    });
  });

  it('keeps the current and previous generation and collects older ones', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    const first = await ingester.ingest(source.sourceId, SCOPE);
    const second = await ingester.ingest(source.sourceId, SCOPE);
    expect(indexFiles()).toEqual([`${first.generation}.sqlite`, `${second.generation}.sqlite`].sort());
    expect(registry.get(source.sourceId, SCOPE)?.previousGeneration).toBe(first.generation);
    const third = await ingester.ingest(source.sourceId, SCOPE);
    expect(third.cleanup).toEqual({status: 'completed', removedFileCount: 1, failedFileCount: 0});
    expect(indexFiles()).toEqual([`${second.generation}.sqlite`, `${third.generation}.sqlite`].sort());
  });

  it('deletes a new generation whose activation failed before any pointer named it', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    const first = await ingester.ingest(source.sourceId, SCOPE);
    overrideLease(() => ({
      activateGeneration: () => {
        throw new Error('activation_failed_for_test');
      },
    }));
    await expect(ingester.ingest(source.sourceId, SCOPE)).rejects.toThrow('activation_failed_for_test');
    expect(indexFiles()).toEqual([`${first.generation}.sqlite`]);
    expect(registry.get(source.sourceId, SCOPE)?.activeGeneration).toBe(first.generation);
  });

  it('keeps a new generation when its pointer landed before the activation error', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    let landed: string | undefined;
    overrideLease(guard => ({
      activateGeneration: input => {
        guard.activateGeneration(input);
        landed = input.generation;
        throw new Error('replica_write_failed_for_test');
      },
    }));
    await expect(ingester.ingest(source.sourceId, SCOPE)).rejects.toThrow('replica_write_failed_for_test');
    expect(indexFiles()).toEqual([`${landed}.sqlite`]);
    expect(ingester.search(source.sourceId, SCOPE, 'alpha', 5).hits).toHaveLength(1);
  });

  it('stops collecting old generations when the lease is lost after activation', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    const first = await ingester.ingest(source.sourceId, SCOPE);
    const second = await ingester.ingest(source.sourceId, SCOPE);
    let activated = false;
    overrideLease(guard => ({
      assertHeld: () => {
        if (activated) throw new Error('external_knowledge_reindex_lease_lost');
        guard.assertHeld();
      },
      activateGeneration: input => {
        const result = guard.activateGeneration(input);
        activated = true;
        return result;
      },
    }));
    const third = await ingester.ingest(source.sourceId, SCOPE);
    expect(third.cleanup).toEqual({status: 'failed', removedFileCount: 0, failedFileCount: 0});
    expect(indexFiles()).toEqual([first, second, third].map(result => `${result.generation}.sqlite`).sort());
  });

  it('stops and deletes its staging file when the lease is lost between batches', async () => {
    for (let index = 0; index < 40; index += 1) writeDoc(`doc-${index}.md`, `# D${index}\nbody\n`);
    const source = register();
    let checks = 0;
    overrideLease(guard => ({
      assertHeld: () => {
        checks += 1;
        if (checks === 3) throw new Error('external_knowledge_reindex_lease_lost');
        guard.assertHeld();
      },
    }));
    await expect(ingester.ingest(source.sourceId, SCOPE)).rejects.toThrow('external_knowledge_reindex_lease_lost');
    expect(indexFiles()).toEqual([]);
    expect(registry.get(source.sourceId, SCOPE)?.activeGeneration).toBeUndefined();
  });

  it('honours cancellation, refuses an empty folder and refuses another kind', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    const controller = new AbortController();
    controller.abort();
    await expect(ingester.ingest(source.sourceId, SCOPE, {signal: controller.signal}))
      .rejects.toThrow('knowledge_ingest_cancelled');
    fs.writeFileSync(path.join(docsRoot, 'a.md'), '   \n');
    await expect(ingester.ingest(source.sourceId, SCOPE)).rejects.toMatchObject({
      code: 'KNOWLEDGE_COLLECTION_EMPTY',
      details: {empty_text: 1},
    });
    expect(indexFiles()).toEqual([]);

    const wiki = registry.register({
      kind: 'android_internals_wiki',
      displayName: 'Wiki',
      rootRealpath: docsRoot,
      revision: 'r',
      contentFingerprint: 'f',
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      consentedBy: 'user-1',
      scope: SCOPE,
    });
    await expect(ingester.ingest(wiki.sourceId, SCOPE)).rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_KIND_MISMATCH'});
  });

  it('removes every index file of a source', async () => {
    writeDoc('a.md', '# A\nalpha\n');
    const source = register();
    await ingester.ingest(source.sourceId, SCOPE);
    await registry.remove(source.sourceId, SCOPE, 'user-1', (_tombstone, fence) =>
      ingester.removeIndex(SCOPE, source.sourceId, fence));
    expect(indexFiles()).toEqual([]);
    expect(registry.get(source.sourceId, SCOPE)).toBeUndefined();
  });

  it('keeps a generation the DB pointer names when the filesystem replica write fails, and fails closed', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-dual.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    writeDoc('a.md', '# A\nalpha\n');
    const source = register(true);
    const first = await ingester.ingest(source.sourceId, SCOPE);
    jest.spyOn(registry as any, 'persist').mockImplementationOnce(() => {
      throw new Error('simulated_filesystem_persist_failure');
    });
    await expect(ingester.ingest(source.sourceId, SCOPE)).rejects.toThrow('simulated_filesystem_persist_failure');
    const pointers = registry.referencedGenerations(source.sourceId, SCOPE);
    expect(pointers.size).toBe(2);
    expect(indexFiles()).toEqual([...pointers].map(id => `${id}.sqlite`).sort());
    // The two sides disagree, so neither generation is served until a reindex settles them.
    expect(registry.get(source.sourceId, SCOPE)?.activeGeneration).toBeUndefined();
    expect(() => ingester.search(source.sourceId, SCOPE, 'alpha', 5)).toThrow(KnowledgeIndexUnavailableError);
    const third = await ingester.ingest(source.sourceId, SCOPE);
    expect(registry.get(source.sourceId, SCOPE)?.activeGeneration).toBe(third.generation);
    expect(indexFiles()).not.toContain(`${first.generation}.sqlite`);
  });

  it('activates through the enterprise store on a distributed lease', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    writeDoc('a.md', '# A\nalpha\n');
    const source = register(true);
    const result = await ingester.ingest(source.sourceId, SCOPE);
    expect(registry.referencedGenerations(source.sourceId, SCOPE)).toEqual(new Set([result.generation]));
    expect(ingester.search(source.sourceId, SCOPE, 'alpha', 5).hits).toHaveLength(1);
  });
});

describe('DocumentCollectionIngester registration and removal', () => {
  it('registers only with acknowledged rights and keeps the consent in effect when it is left out', async () => {
    writeDoc('a.md', '# A\n\nAlpha notes.');
    await expect(ingester.register({rootPath: docsRoot, rightsAcknowledged: false, consentedBy: 'user-1', scope: SCOPE}))
      .rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_RIGHTS_REQUIRED'});
    expect(registry.list(SCOPE)).toEqual([]);
    const first = await ingester.register({rootPath: docsRoot, rightsAcknowledged: true, sendToProvider: true,
      consentedBy: 'user-1', scope: SCOPE});
    expect(first.source).toMatchObject({kind: 'document_collection', displayName: 'docs', sendToProvider: true});
    expect(first.preview.summary.documentCount).toBe(1);
    const again = await ingester.register({rootPath: docsRoot, displayName: 'Team', rightsAcknowledged: true,
      consentedBy: 'user-1', scope: SCOPE});
    expect(again.source).toMatchObject({sourceId: first.source.sourceId, displayName: 'Team', sendToProvider: true});
  });

  it('removes a document collection with its index, and refuses another kind before revoking it', async () => {
    writeDoc('a.md', '# A\n\nAlpha notes.');
    const source = register(true);
    await ingester.ingest(source.sourceId, SCOPE);
    expect(indexFiles().length).toBeGreaterThan(0);
    await ingester.remove(source.sourceId, SCOPE, 'user-1');
    expect(registry.get(source.sourceId, SCOPE)).toBeUndefined();
    expect(indexFiles()).toEqual([]);
    const wiki = registry.register({kind: 'android_internals_wiki', displayName: 'Wiki', rootRealpath: docsRoot,
      revision: 'r', contentFingerprint: 'f', dirty: false, license: 'internal', rightsAcknowledged: true,
      sendToProvider: true, consentedBy: 'user-1', scope: SCOPE});
    await expect(ingester.remove(wiki.sourceId, SCOPE, 'user-1')).rejects.toMatchObject({code: 'KNOWLEDGE_SOURCE_KIND_MISMATCH'});
    // Refused before its tombstone: the Wiki is still readable.
    expect(registry.get(wiki.sourceId, SCOPE)).toMatchObject({sourceId: wiki.sourceId, sendToProvider: true});
  });
});
