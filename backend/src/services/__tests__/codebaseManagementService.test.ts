// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  CodebaseManagementError,
  CodebaseManagementService,
} from '../codebase/codebaseManagementService';
import {
  CodebaseRegistry,
  type IndexCoverage,
} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {CodebaseStateError, type CodebaseStateReason} from '../codebase/codebaseRequestError';
import {SourceEnumerator} from '../codebase/sourceEnumerator';
import {RagStore} from '../ragStore';
import type {RagChunk} from '../../types/sparkContracts';

const DEFAULT_SCOPE = {
  tenantId: 'default-dev-tenant',
  workspaceId: 'default-workspace',
  userId: 'dev-user-123',
};

const OTHER_SCOPE = {
  tenantId: 'other-tenant',
  workspaceId: 'other-workspace',
  userId: 'other-user',
};

let tmpDir: string;
let registry: CodebaseRegistry;
let store: RagStore;
let service: CodebaseManagementService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-management-'));
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  service = new CodebaseManagementService({
    registry,
    store,
    gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
    sourceEnumerator: new SourceEnumerator(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function registerApp(displayName = 'App') {
  const root = path.join(tmpDir, displayName.replace(/\s+/g, '-').toLowerCase());
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
  return registry.register({
    kind: 'app_source',
    displayName,
    rootPath: root,
    rootRealpath: root,
    sendToProvider: true,
    ...DEFAULT_SCOPE,
  });
}

describe('live on-demand source availability', () => {
  it('keeps an unindexed registered root available and refreshes a removed root', async () => {
    const ref = registerApp();
    expect(service.rootCapability(ref.codebaseId, DEFAULT_SCOPE)).toEqual({available: true, rootRealpath: ref.rootRealpath});
    expect((await service.list(DEFAULT_SCOPE))[0]).toMatchObject({rootAvailable: true, activeIndexState: 'none'});
    expect((await service.list(DEFAULT_SCOPE))[0]).not.toHaveProperty('unavailableReason');
    fs.renameSync(ref.rootRealpath, `${ref.rootRealpath}-moved`);
    expect(service.rootCapability(ref.codebaseId, DEFAULT_SCOPE)).toEqual({available: false, reason: 'root_missing'});
    expect((await service.list(DEFAULT_SCOPE))[0]).toMatchObject({rootAvailable: false, unavailableReason: 'root_missing'});
    expect(service.get(ref.codebaseId, DEFAULT_SCOPE)).toMatchObject({rootAvailable: false, unavailableReason: 'root_missing'});
  });

  it('does not treat an existing root outside the current allowlist as readable', async () => {
    const ref = registerApp();
    const restricted = new CodebaseManagementService({registry, store, gate: new PathSecurityGate({allowlistRoots: []})});
    expect(restricted.rootCapability(ref.codebaseId, DEFAULT_SCOPE))
      .toEqual({available: false, reason: 'outside_allowlist'});
    expect((await restricted.list(DEFAULT_SCOPE))[0]).toMatchObject({rootAvailable: false, unavailableReason: 'outside_allowlist'});
    expect(restricted.get(ref.codebaseId, DEFAULT_SCOPE)).toMatchObject({rootAvailable: false, unavailableReason: 'outside_allowlist'});
    expect(service.rootCapability(ref.codebaseId, OTHER_SCOPE).available).toBe(false);
  });

  it('does not turn a root replaced by a regular file into an available source', async () => {
    const ref = registerApp();
    fs.renameSync(ref.rootRealpath, `${ref.rootRealpath}-moved`);
    fs.writeFileSync(ref.rootRealpath, 'not a directory');
    expect(service.rootCapability(ref.codebaseId, DEFAULT_SCOPE))
      .toEqual({available: false, reason: 'root_not_directory'});
  });

  it('reports a root replaced by a link elsewhere as an identity change, never the new path', async () => {
    const ref = registerApp();
    const elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.renameSync(ref.rootRealpath, `${ref.rootRealpath}-moved`);
    fs.symlinkSync(elsewhere, ref.rootRealpath);
    expect(service.rootCapability(ref.codebaseId, DEFAULT_SCOPE))
      .toEqual({available: false, reason: 'root_identity_changed'});
    expect(JSON.stringify(await service.list(DEFAULT_SCOPE))).not.toContain(tmpDir);
  });
});

function coverage(selectionPolicyRevision = 1): IndexCoverage {
  return {
    selectionPolicyRevision,
    enumerationBackend: 'ripgrep',
    backendFidelity: 'exact',
    enumerationComplete: true,
    deterministic: true,
    filesEnumerated: 1,
    filesSelected: 1,
    bytesSelected: 10,
    chunksIndexed: 1,
    truncated: true,
    complete: false,
    truncationReason: 'file_budget',
  };
}

function sourceChunk(codebaseId: string, chunkId: string, generation: string): RagChunk {
  return {
    chunkId,
    kind: 'app_source',
    uri: `codebase://${codebaseId}/Main.kt`,
    snippet: 'class Main',
    codebaseId,
    registryOrigin: 'codebase_registry',
    sourceGeneration: generation,
    filePath: 'Main.kt',
    indexedAt: Date.now(),
  };
}

describe('CodebaseManagementService', () => {
  it('owns source preview and AOSP manifest project/group suggestions', async () => {
    const root = path.join(tmpDir, 'aosp');
    fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
    fs.mkdirSync(path.join(root, 'frameworks/base'), {recursive: true});
    fs.writeFileSync(path.join(root, 'frameworks/base/Foo.java'), 'class Foo {}\n');
    fs.writeFileSync(path.join(root, '.repo/manifest.xml'), [
      '<manifest>',
      '  <project name="platform/frameworks/base" path="frameworks/base" groups="pdk,default" />',
      '</manifest>',
    ].join('\n'));

    const preview = await service.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE);

    expect(preview).toMatchObject({
      blocked: false,
      complete: true,
      acceptedFileCount: 1,
      manifestProjects: [{
        name: 'platform/frameworks/base',
        path: 'frameworks/base',
        groups: ['default', 'pdk'],
      }],
      manifestGroups: ['default', 'pdk'],
    });
    expect(JSON.stringify(preview)).not.toContain(root);
  });

  it('degrades optional manifest metadata but hard-fails root identity drift', async () => {
    const root = path.join(tmpDir, 'aosp-degraded');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Foo.java'), 'class Foo {}\n');
    const degraded = new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: new SourceEnumerator(),
      readAospManifestProjects: async () => {
        throw new Error('source_metadata_too_large');
      },
    });

    await expect(degraded.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE))
      .resolves.toMatchObject({manifestUnavailableReason: 'source_metadata_too_large'});

    const secretCanary = 'secret_token_canary';
    const unknown = new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: new SourceEnumerator(),
      readAospManifestProjects: async () => {
        throw new Error(secretCanary);
      },
    });
    const unknownPreview = await unknown.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE);
    expect(unknownPreview.manifestUnavailableReason).toBe('aosp_manifest_discovery_failed');
    expect(JSON.stringify(unknownPreview)).not.toContain(secretCanary);

    const drifted = new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: new SourceEnumerator(),
      readAospManifestProjects: async () => {
        throw new CodebaseStateError('codebase_root_realpath_drift');
      },
    });
    await expect(drifted.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE))
      .rejects.toMatchObject({
        code: 'CODEBASE_ROOT_DRIFT',
        status: 400,
      } satisfies Partial<CodebaseManagementError>);

    // The state is the error's type; a plain message that spells the token is
    // an unclassified manifest failure.
    const spelled = new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: new SourceEnumerator(),
      readAospManifestProjects: async () => {
        throw new Error('codebase_root_realpath_drift');
      },
    });
    await expect(spelled.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE))
      .resolves.toMatchObject({manifestUnavailableReason: 'aosp_manifest_discovery_failed'});
  });

  it.each([
    ['codebase_deleting', 'CODEBASE_DELETING', 409],
    ['codebase_reindex_in_progress', 'CODEBASE_BUSY', 409],
    ['codebase_reindex_lease_lost', 'CODEBASE_BUSY', 409],
    ['codebase_root_realpath_drift', 'CODEBASE_ROOT_DRIFT', 400],
    ['pending_generation_expired', 'PENDING_GENERATION_EXPIRED', 409],
    ['pending_generation_not_found', 'PENDING_GENERATION_NOT_FOUND', 409],
    ['pending_generation_stale', 'PENDING_GENERATION_STALE', 409],
    ['provider_send_consent_required', 'CODEBASE_CONSENT_REQUIRED', 409],
  ] satisfies Array<[CodebaseStateReason, string, number]>)(
    'answers the %s state with %s by type', async (reason, code, status) => {
      const ref = registerApp();
      jest.spyOn(registry, 'setProviderConsent').mockImplementation(() => {
        throw new CodebaseStateError(reason);
      });
      await expect(service.setConsent(ref.codebaseId, true, 'user', DEFAULT_SCOPE))
        .rejects.toMatchObject({code, status, message: reason});
    });

  it('does not classify a plain error by its message', async () => {
    const ref = registerApp();
    jest.spyOn(registry, 'setProviderConsent').mockImplementation(() => {
      throw new Error('codebase_deleting');
    });
    await expect(service.setConsent(ref.codebaseId, true, 'user', DEFAULT_SCOPE))
      .rejects.toMatchObject({code: 'CODEBASE_OPERATION_FAILED', status: 500});
  });

  it('does not expose a root from unexpected preview diagnostics', async () => {
    const root = path.join(tmpDir, 'private-preview-root');
    fs.mkdirSync(root, {recursive: true});
    const failed = new CodebaseManagementService({
      registry,
      store,
      gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: {
        enumerate: async () => {
          throw new Error(`source file not found below ${root}`);
        },
      },
    });

    try {
      await failed.preview({rootPath: root, kind: 'app_source'}, DEFAULT_SCOPE);
      throw new Error('expected preview to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CODEBASE_PREVIEW_FAILED',
        status: 400,
        message: 'Codebase preview failed',
      });
      expect(JSON.stringify(error)).not.toContain(root);
    }
  });

  it('shares selection, consent, and authorization state without private roots', async () => {
    const ref = registerApp('Managed App');
    fs.mkdirSync(path.join(ref.rootRealpath, 'src'));
    fs.writeFileSync(path.join(ref.rootRealpath, 'src', 'Feature.kt'), 'class Feature\n');

    const selected = await service.updateSelection(ref.codebaseId, {
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    }, DEFAULT_SCOPE);
    expect(selected).toMatchObject({
      selectionPolicyRevision: 2,
      activeIndexState: 'none',
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
      // Narrowed inside the whole-root grant: the grant follows the selection.
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: true,
    });
    // Never indexed, so nothing asks for a reindex.
    expect(selected).not.toHaveProperty('reindexRequired');
    expect(JSON.stringify(selected)).not.toContain(tmpDir);
    expect(JSON.stringify(selected)).not.toContain('rootAuthorization');

    const disabled = await service.setConsent(
      ref.codebaseId,
      false,
      DEFAULT_SCOPE.userId,
      DEFAULT_SCOPE,
    );
    expect(disabled.eligibleForSendToProvider).toBe(false);
    await service.setConsent(ref.codebaseId, true, DEFAULT_SCOPE.userId, DEFAULT_SCOPE);

    const extensions = await service.authorizeAvailableExtensions(
      ref.codebaseId,
      DEFAULT_SCOPE.userId,
      DEFAULT_SCOPE,
    );
    expect(extensions.availableNotConsentedExtensions).toEqual([]);
    const current = await service.authorizeCurrentSelection(
      ref.codebaseId,
      DEFAULT_SCOPE.userId,
      DEFAULT_SCOPE,
    );
    expect(current.providerGrantScopeCurrent).toBe(true);

    // Widening beyond the grant revokes consent; one action grants it again.
    const widened = await service.updateSelection(ref.codebaseId, {pathFilters: []}, DEFAULT_SCOPE);
    expect(widened).toMatchObject({eligibleForSendToProvider: false});
    // The token is part of every management view, list and detail alike.
    const listed = (await service.list(DEFAULT_SCOPE)).find(item => item.codebaseId === ref.codebaseId)!;
    expect(listed.contentDisclosureToken).toBe(widened.contentDisclosureToken);
    const content = await service.authorizeContent(ref.codebaseId, DEFAULT_SCOPE.userId,
      widened.contentDisclosureToken, DEFAULT_SCOPE);
    expect(content).toMatchObject({eligibleForSendToProvider: true, providerGrantScopeCurrent: true,
      availableNotConsentedExtensions: []});
    const repeated = await service.authorizeContent(ref.codebaseId, DEFAULT_SCOPE.userId,
      content.contentDisclosureToken, DEFAULT_SCOPE);
    expect(repeated.consent).toEqual(content.consent);
    // A disclosure from before a selection edit grants nothing.
    const edited = await service.updateSelection(ref.codebaseId, {excludeGlobs: ['**/fixtures/**']}, DEFAULT_SCOPE);
    await expect(service.authorizeContent(ref.codebaseId, DEFAULT_SCOPE.userId, content.contentDisclosureToken,
      DEFAULT_SCOPE)).rejects.toMatchObject({code: 'CODEBASE_CONSENT_DISCLOSURE_STALE', status: 409});
    expect(service.get(ref.codebaseId, DEFAULT_SCOPE).consent).toEqual(edited.consent);
  });

  it('previews a selection edit exactly as a save would enumerate it, without the root', async () => {
    const ref = registerApp('Preview App');
    fs.mkdirSync(path.join(ref.rootRealpath, 'feature'));
    fs.writeFileSync(path.join(ref.rootRealpath, 'feature', 'A.kt'), 'class A\n');
    fs.writeFileSync(path.join(ref.rootRealpath, 'feature', 'notes.txt'), 'not source\n');

    const preview = await service.previewSelection(ref.codebaseId, {pathFilters: ['feature']}, DEFAULT_SCOPE);
    expect(preview).toMatchObject({status: 'complete', selectionPolicyRevision: 1,
      preview: {acceptedFileCount: 1, acceptedFiles: [{relativePath: 'feature/A.kt'}]}});
    expect(JSON.stringify(preview)).not.toContain(tmpDir);
    // Absent fields keep the registered value: the whole root here.
    expect(await service.previewSelection(ref.codebaseId, {}, DEFAULT_SCOPE))
      .toMatchObject({status: 'complete', preview: {acceptedFileCount: 2}});

    const empty = await service.previewSelection(ref.codebaseId, {excludeGlobs: ['**/*.kt']}, DEFAULT_SCOPE);
    expect(empty).toMatchObject({status: 'complete', preview: {acceptedFileCount: 0}});
    await expect(service.updateSelection(ref.codebaseId, {excludeGlobs: ['**/*.kt']}, DEFAULT_SCOPE))
      .rejects.toMatchObject({code: 'CODEBASE_SELECTION_EMPTY_MATCH', status: 400});
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)!.selectionPolicyRevision).toBe(1);

    const restricted = new CodebaseManagementService({registry, store, gate: new PathSecurityGate({allowlistRoots: []})});
    expect(await restricted.previewSelection(ref.codebaseId, {pathFilters: ['feature']}, DEFAULT_SCOPE))
      .toEqual({status: 'unavailable', selectionPolicyRevision: 1, unavailableReason: 'outside_allowlist'});
  });

  it('reports a traversal that stopped early as a partial lower bound and lets it save', async () => {
    const ref = registerApp('Partial App');
    const partial = new CodebaseManagementService({
      registry, store, gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: {enumerate: async () => ({
        backend: 'node-walk', fidelity: 'degraded', files: [], enumerationComplete: false, deterministic: false,
        incompleteReason: 'time_budget', skipped: [], skippedCount: 0,
      })},
    });
    expect(await partial.previewSelection(ref.codebaseId, {pathFilters: ['big']}, DEFAULT_SCOPE))
      .toMatchObject({status: 'partial', preview: {acceptedFileCount: 0, truncationReason: 'time_budget'}});
    await expect(partial.updateSelection(ref.codebaseId, {pathFilters: ['big']}, DEFAULT_SCOPE))
      .resolves.toMatchObject({pathFilters: ['big'], selectionPolicyRevision: 2});
  });

  it('refuses a save whose revision a concurrent edit replaced while it was enumerating', async () => {
    const ref = registerApp('Race App');
    let enumerationStarted!: () => void;
    const started = new Promise<void>(resolve => {enumerationStarted = resolve;});
    let finishEnumeration!: () => void;
    const finished = new Promise<void>(resolve => {finishEnumeration = resolve;});
    const racing = new CodebaseManagementService({
      registry, store, gate: new PathSecurityGate({allowlistRoots: [tmpDir]}),
      sourceEnumerator: {enumerate: async () => {
        enumerationStarted();
        await finished;
        return {backend: 'node-walk', fidelity: 'exact', files: [{relativePath: 'Main.kt', sizeBytes: 11}],
          enumerationComplete: true, deterministic: true, skipped: [], skippedCount: 0};
      }},
    });

    // The precheck passes (revision 1); the edit lands while the save enumerates.
    const save = racing.updateSelection(ref.codebaseId, {excludeGlobs: ['**/generated/**'],
      expectedSelectionPolicyRevision: 1}, DEFAULT_SCOPE);
    await started;
    const concurrent = registry.updateSelectionPolicy(ref.codebaseId, DEFAULT_SCOPE, {pathFilters: ['src']});
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, concurrent.indexGeneration, {
      candidateGenerationId: 'candidate-concurrent',
      coverage: {...coverage(concurrent.selectionPolicyRevision)},
      contentFingerprint: 'concurrent-fingerprint',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    const concurrentState = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    finishEnumeration();

    await expect(save).rejects.toMatchObject({code: 'CODEBASE_SELECTION_STALE', status: 409});
    const after = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    expect(after).toEqual(concurrentState);
    expect(after).toMatchObject({pathFilters: ['src'], selectionPolicyRevision: 2,
      pendingGeneration: {candidateGenerationId: 'candidate-concurrent'}});
    expect(after.excludeGlobs).toBeUndefined();
  });

  it('refuses a save against a selection revision edited since the caller read it', async () => {
    const ref = registerApp('Revision App');
    await service.updateSelection(ref.codebaseId, {excludeGlobs: ['**/generated/**']}, DEFAULT_SCOPE);

    await expect(service.updateSelection(ref.codebaseId, {excludeGlobs: [], expectedSelectionPolicyRevision: 1},
      DEFAULT_SCOPE)).rejects.toMatchObject({code: 'CODEBASE_SELECTION_STALE', status: 409});
    await expect(service.updateSelection(ref.codebaseId, {excludeGlobs: [], expectedSelectionPolicyRevision: 'two'},
      DEFAULT_SCOPE)).rejects.toMatchObject({code: 'CODEBASE_SELECTION_INVALID', status: 400});
    await expect(service.updateSelection(ref.codebaseId, {excludeGlobs: [], expectedSelectionPolicyRevision: 2},
      DEFAULT_SCOPE)).resolves.toMatchObject({selectionPolicyRevision: 3});
  });

  it('keeps unsafe preview and selection validation transport-neutral and stable', async () => {
    const ref = registerApp('Validation App');

    await expect(service.preview({
      rootPath: ref.rootRealpath,
      kind: 'app_source',
      pathFilters: ['../private'],
    }, DEFAULT_SCOPE)).rejects.toMatchObject({
      code: 'CODEBASE_SELECTION_INVALID',
      status: 400,
      message: 'pathFilters[0] must not traverse parent directories',
    });
    await expect(service.updateSelection(ref.codebaseId, {
      excludeGlobs: ['/absolute/private'],
    }, DEFAULT_SCOPE)).rejects.toMatchObject({
      code: 'CODEBASE_SELECTION_INVALID',
      status: 400,
      message: 'excludeGlobs[0] must be relative',
    });
  });

  it('keeps pending accept/reject CAS exact and stable', async () => {
    const ref = registerApp('Pending App');
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, ref.indexGeneration, {
      candidateGenerationId: 'candidate-a',
      coverage: coverage(),
      contentFingerprint: 'fingerprint-a',
      chunkCount: 1,
      createdAt: Date.now(),
    });

    await expect(service.acceptPending(
      ref.codebaseId,
      'candidate-a',
      DEFAULT_SCOPE,
      {selectionPolicyRevision: 2, grantRevision: 1},
    )).rejects.toMatchObject({code: 'PENDING_GENERATION_STALE', status: 409});

    const accepted = await service.acceptPending(
      ref.codebaseId,
      'candidate-a',
      DEFAULT_SCOPE,
      {selectionPolicyRevision: 1, grantRevision: 1},
    );
    expect(accepted.activeGeneration).toBe('candidate-a');

    const current = registry.get(ref.codebaseId, DEFAULT_SCOPE)!;
    registry.setPendingGeneration(ref.codebaseId, DEFAULT_SCOPE, current.indexGeneration, {
      candidateGenerationId: 'candidate-b',
      coverage: coverage(),
      contentFingerprint: 'fingerprint-b',
      chunkCount: 1,
      createdAt: Date.now(),
    });
    await expect(service.rejectPending(ref.codebaseId, 'wrong-candidate', DEFAULT_SCOPE))
      .rejects.toMatchObject({code: 'PENDING_GENERATION_STALE', status: 409});
    const rejected = await service.rejectPending(ref.codebaseId, 'candidate-b', DEFAULT_SCOPE);
    expect(rejected.pendingGeneration).toBeUndefined();
  });

  it('returns rich list/audit state without root authorization or unsafe diagnostics', async () => {
    const ref = registerApp('Private App');
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'failed',
      lastIngestError: `failed at ${tmpDir}/secret-token`,
    }, DEFAULT_SCOPE);

    const listed = await service.list(DEFAULT_SCOPE);
    const audit = service.audit(ref.codebaseId, DEFAULT_SCOPE);
    const serialized = JSON.stringify({listed, audit});

    expect(listed[0]).toMatchObject({
      rootAvailable: true,
      activeIndexState: 'none',
      selectionPolicyRevision: 1,
      grantRevision: 1,
      providerGrantScopeCurrent: true,
      eligibleForSendToProvider: true,
    });
    expect(serialized).not.toContain(tmpDir);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('rootAuthorization');
  });

  it('maps token-shaped secrets to a generic diagnostic and preserves finite safe codes', async () => {
    const ref = registerApp('Diagnostic App');
    const tokenCanary = 'TOKEN_SHAPED_SECRET_CANARY_123456';
    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'failed',
      lastIngestError: tokenCanary,
    }, DEFAULT_SCOPE);

    const unknown = JSON.stringify({
      list: await service.list(DEFAULT_SCOPE),
      detail: service.get(ref.codebaseId, DEFAULT_SCOPE),
      audit: service.audit(ref.codebaseId, DEFAULT_SCOPE),
    });
    expect(unknown).not.toContain(tokenCanary);
    expect(unknown).toContain('codebase_operation_failed');

    registry.updateIngestStatus(ref.codebaseId, {
      lastIngestStatus: 'blocked_by_security',
      lastIngestError: 'codebase_root_realpath_drift',
    }, DEFAULT_SCOPE);
    const known = JSON.stringify({
      list: await service.list(DEFAULT_SCOPE),
      detail: service.get(ref.codebaseId, DEFAULT_SCOPE),
      audit: service.audit(ref.codebaseId, DEFAULT_SCOPE),
    });
    expect(known).toContain('codebase_root_realpath_drift');
    expect(known).not.toContain(tokenCanary);
  });

  it('deletes every scoped generation, resumes incomplete cleanup, and is idempotent', async () => {
    const ref = registerApp('Delete App');
    store.addChunk(sourceChunk(ref.codebaseId, 'active', 'active-generation'), DEFAULT_SCOPE);
    store.addChunk(sourceChunk(ref.codebaseId, 'pending', 'pending-generation'), DEFAULT_SCOPE);
    const removeSpy = jest.spyOn(store, 'removeCodebaseChunks')
      .mockImplementationOnce(() => {
        throw new Error(`cleanup failed at ${tmpDir}/private`);
      });

    await expect(service.delete(ref.codebaseId, DEFAULT_SCOPE))
      .rejects.toMatchObject({code: 'CODEBASE_DELETE_INCOMPLETE', status: 500});
    expect(registry.get(ref.codebaseId, DEFAULT_SCOPE)?.lifecycleState).toBe('deleting');

    removeSpy.mockRestore();
    await expect(service.delete(ref.codebaseId, DEFAULT_SCOPE)).resolves.toEqual({
      codebaseId: ref.codebaseId,
      removedChunkCount: 2,
    });
    await expect(service.delete(ref.codebaseId, DEFAULT_SCOPE)).resolves.toEqual({
      codebaseId: ref.codebaseId,
      removedChunkCount: 0,
      alreadyDeleted: true,
    });
  });

  it('keeps wrong-scope deletion non-enumerating and other missing operations stable', async () => {
    const ref = registerApp('Scoped App');

    await expect(service.delete(ref.codebaseId, OTHER_SCOPE)).resolves.toEqual({
      codebaseId: ref.codebaseId,
      removedChunkCount: 0,
      alreadyDeleted: true,
    });
    expect(() => service.audit(ref.codebaseId, OTHER_SCOPE)).toThrow(
      expect.objectContaining({
        code: 'CODEBASE_NOT_FOUND',
        status: 404,
      }),
    );
  });

  it('treats only a typed not-found as already deleted, not any message that says so', async () => {
    const ref = registerApp('Untyped Failure App');
    const lease = jest.spyOn(registry, 'withIngestLease').mockImplementation(() => {
      throw new Error('ENOENT: chunk file not found');
    });
    try {
      await expect(service.delete(ref.codebaseId, DEFAULT_SCOPE)).rejects.toMatchObject({
        code: 'CODEBASE_DELETE_FAILED',
        status: 500,
      });
    } finally {
      lease.mockRestore();
    }
  });

  it('passes a typed selection rejection through with its text', async () => {
    const ref = registerApp('Selection App');
    await expect(service.updateSelection(ref.codebaseId, {pathFilters: ['/abs']}, DEFAULT_SCOPE))
      .rejects.toMatchObject({code: 'CODEBASE_SELECTION_INVALID', status: 400, message: 'pathFilters[0] must be relative'});
  });
});
