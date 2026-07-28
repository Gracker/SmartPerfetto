// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
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
      sendToProvider: true,
      userId: 'user-a',
    });

    expect(ref.rootRealpath).toBe(fs.realpathSync(tmpDir));
    expect(ref.consent.sendToProvider).toBe(true);
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
      lastIngestStatus: 'partial',
      lastIngestAt: 123,
      lastIngestError: 'one file was skipped',
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
