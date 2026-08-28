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
        throw new Error('codebase_root_realpath_drift');
      },
    });
    await expect(drifted.preview({rootPath: root, kind: 'aosp'}, DEFAULT_SCOPE))
      .rejects.toMatchObject({
        code: 'CODEBASE_ROOT_DRIFT',
        status: 400,
      } satisfies Partial<CodebaseManagementError>);
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

    const selected = await service.updateSelection(ref.codebaseId, {
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    }, DEFAULT_SCOPE);
    expect(selected).toMatchObject({
      selectionPolicyRevision: 2,
      activeIndexState: 'none',
      reindexRequired: 'selection_scope_changed',
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    });
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
});
