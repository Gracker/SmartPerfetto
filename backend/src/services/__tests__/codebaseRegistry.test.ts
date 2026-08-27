// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  activeCodebaseGeneration,
  PENDING_GENERATION_TTL_MS,
  codebaseRegistrationRequirements,
  CodebaseRegistry,
  isCodebaseKind,
} from '../codebase/codebaseRegistry';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-registry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('CodebaseRegistry', () => {
  it('throttles hot lease assertions while retaining durable batch fences', async () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'lease-heartbeat.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'Lease', rootPath: tmpDir});

    await registry.withIngestLease(ref.codebaseId, {}, lease => {
      lease.assertHeld();
      const lockName = fs.readdirSync(tmpDir).find(name =>
        name.startsWith('lease-heartbeat.json.ingest.') && name.endsWith('.lock'));
      expect(lockName).toBeDefined();
      const lockPath = path.join(tmpDir, lockName!);
      const firstHeartbeat = fs.statSync(lockPath).mtimeMs;
      for (let index = 0; index < 999; index += 1) lease.assertHeld();
      expect(fs.statSync(lockPath).mtimeMs).toBe(firstHeartbeat);
      fs.utimesSync(lockPath, new Date(1), new Date(1));
      lease.assertHeld(true);
      expect(fs.statSync(lockPath).mtimeMs).toBeGreaterThan(1);
    });
  });

  it('defines conditional registration requirements for every supported kind', () => {
    expect(isCodebaseKind('app_source')).toBe(true);
    expect(isCodebaseKind('unknown')).toBe(false);
    expect(codebaseRegistrationRequirements('app_source')).toEqual({
      vendor: false,
      licenseTag: false,
      pathFilters: false,
    });
    expect(codebaseRegistrationRequirements('aosp')).toEqual({
      vendor: false,
      licenseTag: true,
      pathFilters: false,
    });
    expect(codebaseRegistrationRequirements('kernel_source')).toEqual({
      vendor: true,
      licenseTag: false,
      pathFilters: true,
    });
    expect(codebaseRegistrationRequirements('oem_sdk')).toEqual({
      vendor: true,
      licenseTag: true,
      pathFilters: false,
    });
  });

  it('registers codebases and exposes summaries without rootPath', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'HighPerformance',
      rootPath: tmpDir,
      pathFilters: ['src', 'lib'],
      excludeGlobs: ['**/generated/**'],
      sendToProvider: true,
      userId: 'user-a',
    });

    expect(ref.rootRealpath).toBe(fs.realpathSync(tmpDir));
    expect(ref.consent.sendToProvider).toBe(true);
    expect(activeCodebaseGeneration(ref)).toBeUndefined();
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'partial',
      lastIngestAt: 123,
      lastIngestError: 'one file was skipped',
      chunkCount: 7,
      blockedFileCount: 1,
      redactionHitCount: 2,
    }, {userId: 'user-a'});
    const summary = registry.list({userId: 'user-a'})[0] as any;
    expect(summary.codebaseId).toBe(ref.codebaseId);
    expect(summary.rootPath).toBeUndefined();
    expect(summary.eligibleForSendToProvider).toBe(true);
    expect(summary).toMatchObject({
      pathFilters: ['lib', 'src'],
      excludeGlobs: ['**/generated/**'],
      lastIngestStatus: 'ok',
      lastIngestAt: 123,
      lastIngestError: 'one file was skipped',
      maintenanceWarning: 'inactive_chunk_cleanup_failed',
      chunkCount: 7,
      blockedFileCount: 1,
      redactionHitCount: 2,
    });
  });

  it('persists across instances', () => {
    const registryPath = path.join(tmpDir, 'registry.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'App',
      rootPath: tmpDir,
    });
    const reloaded = new CodebaseRegistry(registryPath);
    expect(reloaded.get(ref.codebaseId)?.displayName).toBe('App');
  });

  it('migrates schema v1 consent without widening newly available languages', () => {
    const registryPath = path.join(tmpDir, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      codebases: [{
        codebaseId: 'cb-legacy',
        kind: 'app_source',
        displayName: 'Legacy App',
        rootPath: tmpDir,
        rootRealpath: fs.realpathSync(tmpDir),
        pathFilters: ['app'],
        excludeGlobs: ['**/generated/**'],
        consent: {
          sendToProvider: true,
          consentedAt: 1,
          consentedBy: 'legacy-user',
          consentHash: 'legacy-hash',
        },
        indexGeneration: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    const migrated = new CodebaseRegistry(registryPath).get('cb-legacy')!;

    expect(migrated.consent.sendToProvider).toBe(true);
    expect(migrated.selectionPolicyRevision).toBe(1);
    expect(migrated.consent.grant).toEqual(expect.objectContaining({
      revision: 1,
      includePrefixes: ['app'],
      excludeGlobs: ['**/generated/**'],
    }));
    expect(migrated.consent.grant?.extensions).toEqual(expect.arrayContaining(['.java', '.kt']));
    expect(migrated.consent.grant?.extensions).not.toContain('.dart');
    expect(migrated.consent.grant?.extensions).toEqual(expect.arrayContaining(['.go', '.py']));
  });

  it('migrates legacy partial cleanup state to ok plus a maintenance warning', () => {
    const registryPath = path.join(tmpDir, 'legacy-partial.json');
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      codebases: [{
        codebaseId: 'cb-partial',
        kind: 'app_source',
        displayName: 'Legacy Partial',
        rootPath: tmpDir,
        rootRealpath: fs.realpathSync(tmpDir),
        consent: {
          sendToProvider: false,
          consentedAt: 1,
          consentedBy: 'legacy-user',
          consentHash: 'legacy-hash',
        },
        indexGeneration: 1,
        lastIngestStatus: 'partial',
        lastIngestError: 'inactive chunk cleanup failed',
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    expect(new CodebaseRegistry(registryPath).get('cb-partial')).toMatchObject({
      lastIngestStatus: 'ok',
      maintenanceWarning: 'inactive_chunk_cleanup_failed',
    });
  });

  it('never turns on provider send while authorizing newly available extensions', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'extension-consent.json'));
    const metadataOnly = registry.register({
      kind: 'app_source',
      displayName: 'Metadata only',
      rootPath: tmpDir,
      sendToProvider: false,
    });

    expect(() => registry.authorizeAvailableExtensions(metadataOnly.codebaseId, {}, 'user'))
      .toThrow('provider_send_consent_required');
    expect(registry.get(metadataOnly.codebaseId)?.consent.sendToProvider).toBe(false);

    const consented = registry.setProviderConsent(metadataOnly.codebaseId, {}, true, 'user');
    const updated = registry.authorizeAvailableExtensions(consented.codebaseId, {}, 'user');
    expect(updated.consent.sendToProvider).toBe(true);
    expect(updated.consent.grant!.revision).toBe(consented.consent.grant!.revision + 1);
  });

  it('explicitly authorizes the current selection scope without changing language consent', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'selection-consent.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Scoped app',
      rootPath: tmpDir,
      pathFilters: ['app'],
      excludeGlobs: ['**/generated/**'],
      sendToProvider: true,
    });
    const changed = registry.updateSelectionPolicy(ref.codebaseId, {}, {
      pathFilters: ['app', 'lib'],
      excludeGlobs: [],
    });

    expect(registry.list()[0]).toMatchObject({providerGrantScopeCurrent: false});
    const previousExtensions = [...changed.consent.grant!.extensions];
    const authorized = (registry as any).authorizeCurrentSelection(ref.codebaseId, {}, 'user');

    expect(authorized.consent.grant).toMatchObject({
      revision: changed.consent.grant!.revision + 1,
      includePrefixes: ['app', 'lib'],
      excludeGlobs: [],
      extensions: previousExtensions,
    });
    expect(registry.list()[0]).toMatchObject({providerGrantScopeCurrent: true});
  });

  it('marks an active legacy index for rebuild after new languages are authorized', () => {
    const registryPath = path.join(tmpDir, 'extension-reindex.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Legacy index',
      rootPath: tmpDir,
      sendToProvider: true,
    });
    registry.activateIndexGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: 'legacy-active',
      contentFingerprint: 'legacy-content',
      chunkCount: 1,
    });
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));

    const migrated = new CodebaseRegistry(registryPath);
    const updated = migrated.authorizeAvailableExtensions(ref.codebaseId, {}, 'user');

    expect(updated.reindexRequired).toBe('provider_language_scope_expanded');
  });

  it('accepts pending generations only while policy and grant revisions still match', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'pending-registry.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Pending App',
      rootPath: tmpDir,
      sendToProvider: true,
    });
    const coverage = {
      selectionPolicyRevision: 1,
      enumerationBackend: 'ripgrep' as const,
      backendFidelity: 'exact' as const,
      enumerationComplete: true,
      deterministic: true,
      filesEnumerated: 10,
      filesSelected: 5,
      bytesSelected: 500,
      chunksIndexed: 5,
      truncated: true,
      complete: false,
      truncationReason: 'file_budget' as const,
    };
    registry.setPendingGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      candidateGenerationId: 'candidate-1',
      coverage,
      contentFingerprint: 'fingerprint-1',
      chunkCount: 5,
      createdAt: Date.now(),
    });

    expect(() => registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      1,
      'stale-candidate',
    )).toThrow('pending_generation_stale');
    expect(registry.get(ref.codebaseId)?.pendingGeneration?.candidateGenerationId)
      .toBe('candidate-1');

    const accepted = registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      1,
      'candidate-1',
    );

    expect(activeCodebaseGeneration(accepted)).toBe('candidate-1');
    expect(accepted.pendingGeneration).toBeUndefined();
    expect(accepted.indexGeneration).toBe(2);

    registry.setPendingGeneration(ref.codebaseId, {}, accepted.indexGeneration, {
      candidateGenerationId: 'candidate-2',
      coverage,
      contentFingerprint: 'fingerprint-2',
      chunkCount: 4,
      createdAt: Date.now(),
    });
    expect(() => registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      0,
      'candidate-2',
    ))
      .toThrow('pending_generation_stale');
    expect(() => registry.rejectPendingGeneration(ref.codebaseId, {}, 'stale-candidate'))
      .toThrow('pending_generation_stale');
    expect(registry.get(ref.codebaseId)?.pendingGeneration?.candidateGenerationId)
      .toBe('candidate-2');
    registry.setProviderConsent(ref.codebaseId, {}, false, 'user');

    expect(() => registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      1,
      'candidate-2',
    ))
      .toThrow('pending_generation_not_found');
  });

  it('clears and blocks pending actions when deletion begins', async () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'deleting-pending.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'Deleting', rootPath: tmpDir});
    registry.setPendingGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      candidateGenerationId: 'candidate-before-delete',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      contentFingerprint: 'candidate',
      chunkCount: 1,
      createdAt: Date.now(),
    });

    const deleting = await registry.withIngestLease(
      ref.codebaseId,
      {},
      lease => lease.beginDeletion('user'),
      'delete',
    );

    expect(deleting.lifecycleState).toBe('deleting');
    expect(deleting.pendingGeneration).toBeUndefined();
    expect(() => registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      1,
      'candidate-before-delete',
    )).toThrow(/codebase_deleting|pending_generation_not_found/);
    expect(() => registry.rejectPendingGeneration(
      ref.codebaseId,
      {},
      'candidate-before-delete',
    )).toThrow(/codebase_deleting|pending_generation_not_found/);
  });

  it('drops a previous pending candidate when a complete generation activates', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'activation-clears-pending.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'App', rootPath: tmpDir});
    registry.setPendingGeneration(ref.codebaseId, {}, 1, {
      candidateGenerationId: 'candidate-before-complete',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      contentFingerprint: 'candidate',
      chunkCount: 1,
      createdAt: Date.now(),
    });

    const activated = registry.activateIndexGeneration(ref.codebaseId, {}, 1, {
      lastIngestStatus: 'ok',
      activeGeneration: 'complete-generation',
      contentFingerprint: 'complete',
      chunkCount: 2,
    });

    expect(activeCodebaseGeneration(activated)).toBe('complete-generation');
    expect(activated.pendingGeneration).toBeUndefined();
  });

  it('expires pending generations without activating them', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'expired-pending.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'App', rootPath: tmpDir});
    registry.setPendingGeneration(ref.codebaseId, {}, 1, {
      candidateGenerationId: 'expired-candidate',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'node-walk',
        backendFidelity: 'degraded',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 1,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      contentFingerprint: 'expired',
      chunkCount: 1,
      createdAt: 1,
    });

    const expired = registry.expirePendingGeneration(
      ref.codebaseId,
      {},
      'expired-candidate',
      1 + PENDING_GENERATION_TTL_MS,
    );

    expect(activeCodebaseGeneration(expired)).toBeUndefined();
    expect(expired.pendingGeneration).toBeUndefined();
    expect(expired.maintenanceWarning).toBe('pending_generation_expired');
  });

  it('does not expire or accept a replaced or expired pending candidate', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'candidate-expiry-cas.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'Pending', rootPath: tmpDir});
    const coverage = {
      selectionPolicyRevision: 1,
      enumerationBackend: 'ripgrep' as const,
      backendFidelity: 'exact' as const,
      enumerationComplete: true,
      deterministic: true,
      filesEnumerated: 2,
      filesSelected: 1,
      bytesSelected: 10,
      chunksIndexed: 1,
      truncated: true,
      complete: false,
      truncationReason: 'file_budget' as const,
    };
    registry.setPendingGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      candidateGenerationId: 'candidate-a',
      coverage,
      contentFingerprint: 'a',
      chunkCount: 1,
      createdAt: 1,
    });
    registry.setPendingGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      candidateGenerationId: 'candidate-b',
      coverage,
      contentFingerprint: 'b',
      chunkCount: 1,
      createdAt: 2,
    });

    const unchanged = registry.expirePendingGeneration(
      ref.codebaseId,
      {},
      'candidate-a',
      PENDING_GENERATION_TTL_MS + 10,
    );
    expect(unchanged.pendingGeneration?.candidateGenerationId).toBe('candidate-b');
    expect(() => registry.acceptPendingGeneration(
      ref.codebaseId,
      {},
      1,
      1,
      'candidate-b',
      PENDING_GENERATION_TTL_MS + 10,
    )).toThrow('pending_generation_expired');
  });

  it('fails closed and revokes the active generation when selection scope changes', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'selection-registry.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'App', rootPath: tmpDir});
    const active = registry.activateIndexGeneration(ref.codebaseId, {}, 1, {
      lastIngestStatus: 'ok',
      activeGeneration: 'active-before-narrowing',
      contentFingerprint: 'fingerprint',
      chunkCount: 1,
    });

    const narrowed = registry.updateSelectionPolicy(active.codebaseId, {}, {
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    });

    expect(activeCodebaseGeneration(narrowed)).toBeUndefined();
    expect(narrowed.selectionPolicyRevision).toBe(2);
    expect(narrowed.indexGeneration).toBe(active.indexGeneration + 1);
    expect(narrowed.reindexRequired).toBe('selection_scope_changed');
    expect(narrowed.consent.grant?.revision).toBe(active.consent.grant?.revision);
    expect(() => registry.activateIndexGeneration(active.codebaseId, {}, active.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: 'stale-old-policy',
      contentFingerprint: 'stale',
      chunkCount: 1,
    })).toThrow('codebase_index_generation_changed');

    const noOp = registry.updateSelectionPolicy(active.codebaseId, {}, {
      pathFilters: ['src', 'src'],
      excludeGlobs: ['**/generated/**', '**/generated/**'],
    });
    expect(noOp.selectionPolicyRevision).toBe(narrowed.selectionPolicyRevision);
    expect(noOp.indexGeneration).toBe(narrowed.indexGeneration);
  });

  it('persists registration selection patterns in canonical order', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'canonical-registration.json'));
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Canonical',
      rootPath: tmpDir,
      pathFilters: ['z/src', 'a/src', 'z/src'],
      excludeGlobs: ['**/z/**', '**/a/**', '**/z/**'],
      sendToProvider: true,
    });

    expect(ref.pathFilters).toEqual(['a/src', 'z/src']);
    expect(ref.excludeGlobs).toEqual(['**/a/**', '**/z/**']);
    expect(ref.consent.grant).toMatchObject({
      includePrefixes: ['a/src', 'z/src'],
      excludeGlobs: ['**/a/**', '**/z/**'],
    });
  });

  it('persists and summarizes native-picker root authorization without exposing paths', () => {
    const registryPath = path.join(tmpDir, 'registry.json');
    const ref = new CodebaseRegistry(registryPath).register({
      kind: 'app_source',
      displayName: 'Selected App',
      rootPath: tmpDir,
      rootAuthorization: 'native_picker',
    });

    const reloaded = new CodebaseRegistry(registryPath);
    expect(reloaded.get(ref.codebaseId)?.rootAuthorization).toBe('native_picker');
    expect(reloaded.list()[0]).toMatchObject({
      rootAuthorization: 'native_picker',
    });
    expect(reloaded.list()[0]).not.toHaveProperty('rootPath');
    expect(reloaded.list()[0]).not.toHaveProperty('rootRealpath');
  });

  it('deletes a registration only while holding its ingest lease', async () => {
    const registryPath = path.join(tmpDir, 'registry.json');
    const registry = new CodebaseRegistry(registryPath);
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Private App',
      rootPath: tmpDir,
      ...scope,
    });

    const deleted = await registry.withIngestLease(ref.codebaseId, scope, lease => {
      const deleting = lease.beginDeletion('user-a');
      expect(deleting.lifecycleState).toBe('deleting');
      expect(deleting.consent.sendToProvider).toBe(false);
      return lease.deleteRegistration();
    }, 'delete');

    expect(deleted.codebaseId).toBe(ref.codebaseId);
    expect(registry.get(ref.codebaseId, scope)).toBeUndefined();
    expect(new CodebaseRegistry(registryPath).get(ref.codebaseId, scope)).toBeUndefined();
    await expect(registry.withIngestLease(ref.codebaseId, scope, () => undefined))
      .rejects.toThrow(`Codebase '${ref.codebaseId}' not found`);
  });
});
