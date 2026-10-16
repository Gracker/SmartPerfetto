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
  activeCodebaseGeneration,
  PENDING_GENERATION_TTL_MS,
  codebaseRegistrationRequirements,
  CodebaseRegistry,
  isCodebaseKind,
  type CodebaseRef,
} from '../codebase/codebaseRegistry';
import {
  channelAuthorizedRoots,
  codebaseProviderGrantScopeCurrent,
  evaluateCodebaseModeAuthorization,
  resetRegistrationChannelTrustForTests,
  trustLocalCliRegistrations,
} from '../codebase/codebaseCapability';
import * as selectionPolicy from '../codebase/sourceSelectionPolicy';
import {sourceExtensionsForKind} from '../codebase/sourceSelectionPolicy';
import {contentDisclosure, sourcePathAllowedForProvider} from '../codebase/sourceDisclosure';
import {buildAnalysisContextAuthorizationFingerprint} from '../resolvedAnalysisContext';
import {getScopedKnowledgeRecord, upsertScopedKnowledgeRecord} from '../scopedKnowledgeStore';

let tmpDir: string;

const enterpriseEnvKeys = [ENTERPRISE_FEATURE_FLAG_ENV, ENTERPRISE_DB_PATH_ENV, ENTERPRISE_MIGRATION_PHASE_ENV];
const originalEnterpriseEnv = enterpriseEnvKeys.map(key => process.env[key]);

function useRetiredEnterpriseStore(dbName: string): void {
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, dbName);
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-registry-test-'));
  for (const key of enterpriseEnvKeys) delete process.env[key];
});

afterEach(() => {
  enterpriseEnvKeys.forEach((key, index) => {
    const value = originalEnterpriseEnv[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  jest.restoreAllMocks();
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
    const fingerprint = () => buildAnalysisContextAuthorizationFingerprint(
      {codeAwareMode: 'provider_send', codebaseIds: [consented.codebaseId]}, {}, {codebaseRegistry: registry});
    const fingerprintBefore = fingerprint();
    // Registration already granted every language: nothing to add, nothing changes.
    const updated = registry.authorizeAvailableExtensions(consented.codebaseId, {}, 'user');
    expect(updated).toEqual(consented);
    expect(updated.consent.grant!.revision).toBe(consented.consent.grant!.revision);
    expect(updated.pendingGeneration).toEqual(consented.pendingGeneration);
    expect(fingerprint()).toBe(fingerprintBefore);
  });

  it('explicitly authorizes the current selection scope without changing language consent', () => {
    const registryPath = path.join(tmpDir, 'selection-consent.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({
      kind: 'app_source',
      displayName: 'Scoped app',
      rootPath: tmpDir,
      pathFilters: ['app', 'lib'],
      sendToProvider: true,
    });
    // A grant narrower than the selection, as a record from before grants
    // followed selection edits carries it.
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app'];
    envelope.codebases[0].consent.grant.excludeGlobs = ['**/generated/**'];
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const legacy = new CodebaseRegistry(registryPath);
    const changed = legacy.get(ref.codebaseId)!;

    expect(legacy.list()[0]).toMatchObject({providerGrantScopeCurrent: false});
    const authorized = legacy.authorizeCurrentSelection(ref.codebaseId, {}, 'user');

    expect(authorized.consent.grant).toMatchObject({
      revision: changed.consent.grant!.revision + 1,
      includePrefixes: ['app', 'lib'],
      excludeGlobs: [],
      extensions: ['.java', '.kt'],
    });
    expect(legacy.list()[0]).toMatchObject({providerGrantScopeCurrent: true});
  });

  it('keeps the narrow consent actions to their own boundary and precondition', () => {
    const registryPath = path.join(tmpDir, 'narrow-actions.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({
      kind: 'app_source', displayName: 'Both stale', rootPath: tmpDir, pathFilters: ['app', 'lib'], sendToProvider: true,
    });
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app'];
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const legacy = new CodebaseRegistry(registryPath);

    // Paths and languages are both stale: each narrow action renews only its half.
    const paths = legacy.authorizeCurrentSelection(ref.codebaseId, {}, 'user');
    expect(paths.consent.grant).toMatchObject({includePrefixes: ['app', 'lib'], extensions: ['.java', '.kt']});
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const languages = new CodebaseRegistry(registryPath).authorizeAvailableExtensions(ref.codebaseId, {}, 'user');
    expect(languages.consent.grant!.includePrefixes).toEqual(['app']);
    expect(languages.consent.grant!.extensions).toEqual([...sourceExtensionsForKind('app_source')]);

    // After consent is revoked neither narrow action grants anything.
    const revoked = new CodebaseRegistry(registryPath);
    revoked.setProviderConsent(ref.codebaseId, {}, false, 'user');
    expect(() => revoked.authorizeCurrentSelection(ref.codebaseId, {}, 'user')).toThrow('provider_send_consent_required');
    expect(() => revoked.authorizeAvailableExtensions(ref.codebaseId, {}, 'user')).toThrow('provider_send_consent_required');
    expect(revoked.get(ref.codebaseId)!.consent.sendToProvider).toBe(false);
  });

  it('authorizes exactly the current selection and every language in one action, idempotently', () => {
    const registryPath = path.join(tmpDir, 'content-consent.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({
      kind: 'app_source', displayName: 'Content', rootPath: tmpDir, pathFilters: ['app', 'lib'], sendToProvider: false,
    });
    const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app'];
    envelope.codebases[0].consent.grant.extensions = ['.java', '.kt'];
    fs.writeFileSync(registryPath, JSON.stringify(envelope));
    const legacy = new CodebaseRegistry(registryPath);
    const before = legacy.get(ref.codebaseId)!;

    const granted = legacy.authorizeContent(ref.codebaseId, {}, 'user', contentDisclosure(before).token);
    expect(granted.consent.sendToProvider).toBe(true);
    expect(granted.consent.consentHash).not.toBe(before.consent.consentHash);
    expect(granted.consent.grant).toMatchObject({
      revision: before.consent.grant!.revision + 1,
      includePrefixes: ['app', 'lib'],
      excludeGlobs: [],
      extensions: [...sourceExtensionsForKind('app_source')],
    });
    expect(codebaseProviderGrantScopeCurrent(granted)).toBe(true);

    const again = legacy.authorizeContent(ref.codebaseId, {}, 'user', contentDisclosure(granted).token);
    expect(again.consent).toEqual(granted.consent);
    const repeatedOn = legacy.setProviderConsent(ref.codebaseId, {}, true, 'user');
    expect(repeatedOn.consent).toEqual(granted.consent);

    const off = legacy.setProviderConsent(ref.codebaseId, {}, false, 'user');
    expect(off.consent.grant!.revision).toBe(granted.consent.grant!.revision + 1);
    const repeatedOff = legacy.setProviderConsent(ref.codebaseId, {}, false, 'user');
    expect(repeatedOff.consent).toEqual(off.consent);
    expect(() => legacy.authorizeContent('missing', {}, 'user', contentDisclosure(granted).token)).toThrow();
  });

  describe('the combined grant is bound to what was disclosed', () => {
    const registered = () => {
      const registry = new CodebaseRegistry(path.join(tmpDir, `disclosure-${Math.random()}.json`));
      const ref = registry.register({kind: 'app_source', displayName: 'Disclosed', rootPath: tmpDir, pathFilters: ['app']});
      return {registry, ref, token: contentDisclosure(ref).token};
    };

    it('grants with the token of the current disclosure', () => {
      const {registry, ref, token} = registered();
      expect(token).toMatch(/^cd1:1:[0-9a-f]{16}$/);
      expect(registry.authorizeContent(ref.codebaseId, {}, 'user', token).consent.sendToProvider).toBe(true);
    });

    it('refuses a disclosure older than a selection edit and changes nothing', () => {
      const {registry, ref, token} = registered();
      const edited = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app', 'lib']});
      expect(contentDisclosure(edited).token).not.toBe(token);

      expect(() => registry.authorizeContent(ref.codebaseId, {}, 'user', token)).toThrow('consent_disclosure_stale');
      expect(registry.get(ref.codebaseId)).toEqual(edited);
    });

    it('refuses a disclosure that did not show a newly available language and changes nothing', () => {
      const {registry, ref, token} = registered();
      const original = selectionPolicy.sourceExtensionsForKind;
      const withNewLanguage = jest.spyOn(selectionPolicy, 'sourceExtensionsForKind')
        .mockImplementation(kind => [...original(kind), '.zig']);
      try {
        expect(contentDisclosure(ref).token).not.toBe(token);
        expect(() => registry.authorizeContent(ref.codebaseId, {}, 'user', token)).toThrow('consent_disclosure_stale');
        expect(registry.get(ref.codebaseId)).toEqual(ref);
      } finally {
        withNewLanguage.mockRestore();
      }
    });
  });

  it('leaves a grant that already covers every language untouched when languages are authorized again', () => {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'extensions-idempotent.json'));
    const ref = registry.register({kind: 'app_source', displayName: 'Languages', rootPath: tmpDir, sendToProvider: true});
    const active = registry.activateIndexGeneration(ref.codebaseId, {}, ref.indexGeneration, {
      lastIngestStatus: 'ok', activeGeneration: 'active-a', contentFingerprint: 'x', chunkCount: 1,
    });
    registry.setPendingGeneration(ref.codebaseId, {}, active.indexGeneration, {
      candidateGenerationId: 'candidate-kept',
      coverage: {
        selectionPolicyRevision: 1, enumerationBackend: 'ripgrep', backendFidelity: 'exact',
        enumerationComplete: true, deterministic: true, filesEnumerated: 2, filesSelected: 1,
        bytesSelected: 1, chunksIndexed: 1, truncated: true, complete: false, truncationReason: 'file_budget',
      },
      contentFingerprint: 'y', chunkCount: 1, createdAt: Date.now(),
    });
    const before = registry.get(ref.codebaseId)!;
    const fingerprint = () => buildAnalysisContextAuthorizationFingerprint(
      {codeAwareMode: 'provider_send', codebaseIds: [ref.codebaseId]}, {}, {codebaseRegistry: registry});
    const fingerprintBefore = fingerprint();

    const again = registry.authorizeAvailableExtensions(ref.codebaseId, {}, 'user');
    expect(again).toEqual(before);
    expect(again.consent.grant!.revision).toBe(before.consent.grant!.revision);
    expect(again.pendingGeneration?.candidateGenerationId).toBe('candidate-kept');
    expect(fingerprint()).toBe(fingerprintBefore);
  });

  describe('a selection edit and the provider grant', () => {
    const consented = (pathFilters?: string[], excludeGlobs?: string[]) => {
      const registry = new CodebaseRegistry(path.join(tmpDir, `grant-${Math.random()}.json`));
      const ref = registry.register({
        kind: 'app_source', displayName: 'Grant', rootPath: tmpDir, pathFilters, excludeGlobs, sendToProvider: true,
      });
      return {registry, ref};
    };

    it.each([
      ['a whole-root grant narrowed to a prefix', undefined, undefined, {pathFilters: ['app']}],
      ['a prefix narrowed to a subdirectory', ['app'], undefined, {pathFilters: ['app/src']}],
      ['a prefix narrowed to one of two', ['app', 'lib'], undefined, {pathFilters: ['lib']}],
      ['an exclusion added', ['app'], undefined, {excludeGlobs: ['**/generated/**']}],
      ['an explicitly granted noise directory narrowed', ['app/build'], undefined, {pathFilters: ['app/build/gen']}],
    ])('narrows the grant to %s', (_label, pathFilters, excludeGlobs, patch) => {
      const {registry, ref} = consented(pathFilters, excludeGlobs);
      const updated = registry.updateSelectionPolicy(ref.codebaseId, {}, patch);

      expect(updated.consent.sendToProvider).toBe(true);
      expect(updated.consent.consentHash).toBe(ref.consent.consentHash);
      expect(updated.consent.grant!.revision).toBe(ref.consent.grant!.revision + 1);
      expect(updated.consent.grant!.extensions).toEqual(ref.consent.grant!.extensions);
      expect(codebaseProviderGrantScopeCurrent(updated)).toBe(true);
    });

    it.each([
      ['a prefix widened to the whole root', ['app'], undefined, {pathFilters: []}],
      ['a sibling prefix added', ['app'], undefined, {pathFilters: ['app', 'lib']}],
      ['a prefix moved', ['app'], undefined, {pathFilters: ['lib']}],
      ['an exclusion removed', ['app'], ['**/generated/**'], {excludeGlobs: []}],
      ['a whole-root grant reaching into a noise directory', undefined, undefined, {pathFilters: ['node_modules/lib']}],
      ['a prefix reaching into a nested noise directory', ['app'], undefined, {pathFilters: ['app/build']}],
      ['a noise directory differing only in case', undefined, undefined, {pathFilters: ['BUILD/out']}],
      ['a prefix differing only in case', ['app'], undefined, {pathFilters: ['App/src']}],
    ])('revokes provider-send consent for %s', (_label, pathFilters, excludeGlobs, patch) => {
      const {registry, ref} = consented(pathFilters, excludeGlobs);
      const updated = registry.updateSelectionPolicy(ref.codebaseId, {}, patch);

      expect(updated.consent.sendToProvider).toBe(false);
      expect(updated.consent.consentHash).not.toBe(ref.consent.consentHash);
      // The old grant stays for the record; it authorizes nothing without consent.
      expect(updated.consent.grant!.includePrefixes).toEqual(ref.consent.grant!.includePrefixes);
      expect(evaluateCodebaseModeAuthorization(updated, 'provider_send'))
        .toEqual({authorized: false, reason: 'consent_required'});
    });

    describe('what a narrowed or revoked grant admits', () => {
      const nfc = 'src/caf\u00e9';
      const nfd = 'src/cafe\u0301';
      const admitted = (ref: CodebaseRef, files: string[]) =>
        files.filter(file => sourcePathAllowedForProvider(ref, file));

      it.each([
        ['an adjacent prefix', ['src/a'], ['src/ab']],
        ['a shorter adjacent prefix', ['src/ab'], ['src/a']],
        ['a decomposed form of a composed prefix', [nfc], [`${nfd}/x`]],
      ])('revokes for %s, so the grant admits no file', (_label, granted, edited) => {
        const {registry, ref} = consented(granted);
        const updated = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: edited});
        expect(updated.consent.sendToProvider).toBe(false);
        expect(admitted(updated, ['src/a/A.kt', 'src/ab/A.kt', `${nfc}/x/A.kt`, `${nfd}/x/A.kt`])).toEqual([]);
      });

      it('narrows to a prefix written with a trailing slash and admits only files under it', () => {
        const {registry, ref} = consented(['src']);
        const updated = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['src/a/']});
        expect(updated.consent.grant!.includePrefixes).toEqual(['src/a']);
        expect(admitted(updated, ['src/a/A.kt', 'src/a/deep/B.kt', 'src/ab/A.kt', 'src/b/A.kt', 'src/A.kt']))
          .toEqual(['src/a/A.kt', 'src/a/deep/B.kt']);
      });

      it('narrows within a composed prefix and admits only the composed form', () => {
        const {registry, ref} = consented([nfc]);
        const updated = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: [`${nfc}/x`]});
        expect(updated.consent.sendToProvider).toBe(true);
        expect(admitted(updated, [`${nfc}/x/A.kt`, `${nfd}/x/A.kt`, `${nfc}/y/A.kt`])).toEqual([`${nfc}/x/A.kt`]);
      });

      it('refuses a prefix that climbs with .. and keeps the grant and what it admits', () => {
        const {registry, ref} = consented(['src']);
        expect(() => registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['src/a/../b']}))
          .toThrow('source_include_prefix_invalid');
        const unchanged = registry.get(ref.codebaseId)!;
        expect(unchanged).toEqual(ref);
        expect(admitted(unchanged, ['src/b/A.kt', 'lib/A.kt'])).toEqual(['src/b/A.kt']);
      });
    });

    it('leaves a metadata-only registration without consent and an unchanged selection untouched', () => {
      const registry = new CodebaseRegistry(path.join(tmpDir, 'metadata-grant.json'));
      const ref = registry.register({kind: 'app_source', displayName: 'Meta', rootPath: tmpDir, pathFilters: ['app']});
      const widened = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app', 'lib']});
      expect(widened.consent).toEqual(ref.consent);

      const same = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['lib', 'app', 'lib/']});
      expect(same).toEqual(widened);
    });

    it('fences index builds with the generation and asks for a reindex only when an index was active', () => {
      const registry = new CodebaseRegistry(path.join(tmpDir, 'fence.json'));
      const ref = registry.register({kind: 'app_source', displayName: 'Fence', rootPath: tmpDir});
      // A first build started before the edit cannot activate after it.
      const firstBuildGeneration = ref.indexGeneration;
      const edited = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app']});
      expect(edited.indexGeneration).toBe(firstBuildGeneration + 1);
      expect(edited.reindexRequired).toBeUndefined();
      expect(() => registry.activateIndexGeneration(ref.codebaseId, {}, firstBuildGeneration, {
        lastIngestStatus: 'ok', activeGeneration: 'stale-first-build', contentFingerprint: 'x', chunkCount: 1,
      })).toThrow('codebase_index_generation_changed');
      expect(() => registry.setPendingGeneration(ref.codebaseId, {}, firstBuildGeneration, {
        candidateGenerationId: 'stale-pending',
        coverage: {
          selectionPolicyRevision: 1, enumerationBackend: 'ripgrep', backendFidelity: 'exact',
          enumerationComplete: true, deterministic: true, filesEnumerated: 1, filesSelected: 1,
          bytesSelected: 1, chunksIndexed: 1, truncated: false, complete: true,
        },
        contentFingerprint: 'x', chunkCount: 1, createdAt: Date.now(),
      })).toThrow('codebase_index_generation_changed');

      const active = registry.activateIndexGeneration(ref.codebaseId, {}, edited.indexGeneration, {
        lastIngestStatus: 'ok', activeGeneration: 'active-a', contentFingerprint: 'x', chunkCount: 1,
      });
      const reedited = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app/src']});
      expect(reedited.indexGeneration).toBe(active.indexGeneration + 1);
      expect(reedited.reindexRequired).toBe('selection_scope_changed');
      // A second edit before the rebuild keeps asking for it.
      expect(registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app/src/main']}).reindexRequired)
        .toBe('selection_scope_changed');
    });

    it('drops a pending candidate built under the old selection', () => {
      const registry = new CodebaseRegistry(path.join(tmpDir, 'pending-fence.json'));
      const ref = registry.register({kind: 'app_source', displayName: 'Pending', rootPath: tmpDir});
      const active = registry.activateIndexGeneration(ref.codebaseId, {}, ref.indexGeneration, {
        lastIngestStatus: 'ok', activeGeneration: 'active-a', contentFingerprint: 'x', chunkCount: 1,
      });
      registry.setPendingGeneration(ref.codebaseId, {}, active.indexGeneration, {
        candidateGenerationId: 'candidate-old-scope',
        coverage: {
          selectionPolicyRevision: 1, enumerationBackend: 'ripgrep', backendFidelity: 'exact',
          enumerationComplete: true, deterministic: true, filesEnumerated: 2, filesSelected: 1,
          bytesSelected: 1, chunksIndexed: 1, truncated: true, complete: false, truncationReason: 'file_budget',
        },
        contentFingerprint: 'y', chunkCount: 1, createdAt: Date.now(),
      });

      const edited = registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app']});
      expect(edited.pendingGeneration).toBeUndefined();
      expect(() => registry.acceptPendingGeneration(ref.codebaseId, {}, 1, edited.consent.grant!.revision,
        'candidate-old-scope')).toThrow('pending_generation_not_found');
    });

    it('refuses a save against a selection revision the caller did not read', () => {
      const registry = new CodebaseRegistry(path.join(tmpDir, 'revision.json'));
      const ref = registry.register({kind: 'app_source', displayName: 'Revision', rootPath: tmpDir});
      registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['app']});

      expect(() => registry.updateSelectionPolicy(ref.codebaseId, {}, {pathFilters: ['lib']},
        {expectedSelectionPolicyRevision: 1})).toThrow('selection_policy_stale');
      expect(registry.get(ref.codebaseId)!.pathFilters).toEqual(['app']);
    });
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

  it('trusts local_cli and unrecorded channels only in a process that opted in', () => {
    const root = {rootRealpath: tmpDir};
    try {
      expect(channelAuthorizedRoots({...root, rootAuthorization: 'native_picker'}))
        .toEqual({additionalAllowlistRoots: [tmpDir]});
      // The server reads CLI records without trusting them.
      expect(channelAuthorizedRoots({...root, rootAuthorization: 'local_cli'})).toBeUndefined();
      expect(channelAuthorizedRoots(root)).toBeUndefined();
      trustLocalCliRegistrations();
      expect(channelAuthorizedRoots({...root, rootAuthorization: 'local_cli'}))
        .toEqual({additionalAllowlistRoots: [tmpDir]});
      expect(channelAuthorizedRoots(root)).toEqual({additionalAllowlistRoots: [tmpDir]});
      expect(channelAuthorizedRoots({...root, rootAuthorization: 'configured_allowlist'})).toBeUndefined();
    } finally {
      resetRegistrationChannelTrustForTests();
    }
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

  it('deletes a distributed registration only while its database lease is live', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-delete.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const ref = registry.register({kind: 'app_source', displayName: 'Private App', rootPath: tmpDir, ...scope});
    const baseTime = 2_000_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    await expect(registry.withIngestLease(ref.codebaseId, scope, lease => {
      lease.beginDeletion('user-a');
      clock.mockReturnValue(baseTime + 10 * 60 * 1000 + 1);
      return lease.deleteRegistration();
    }, 'delete')).rejects.toThrow('codebase_reindex_lease_lost');
    expect(registry.get(ref.codebaseId, scope)?.lifecycleState).toBe('deleting');

    const deleted = await registry.withIngestLease(ref.codebaseId, scope, lease => lease.deleteRegistration(), 'delete');
    expect(deleted.codebaseId).toBe(ref.codebaseId);
    expect(registry.get(ref.codebaseId, scope)).toBeUndefined();
  });

  it('fences a stale generation switch behind the enterprise ingest lease', async () => {
    useRetiredEnterpriseStore('enterprise-fence.sqlite');
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const first = new CodebaseRegistry(path.join(tmpDir, 'first.json'));
    const second = new CodebaseRegistry(path.join(tmpDir, 'second.json'));
    const ref = first.register({kind: 'app_source', displayName: 'Fence', rootPath: tmpDir, ...scope});
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
    const staleRun = first.withIngestLease(ref.codebaseId, scope, async lease => {
      lease.assertHeld(true);
      checked();
      await held;
      return lease.activateIndexGeneration(ref.indexGeneration, {
        lastIngestStatus: 'ok',
        activeGeneration: 'stale-generation',
      });
    });
    await staleChecked;

    clock.mockReturnValue(baseTime + 10 * 60 * 1000 + 1);
    await second.withIngestLease(ref.codebaseId, scope, lease =>
      lease.activateIndexGeneration(ref.indexGeneration, {
        lastIngestStatus: 'ok',
        activeGeneration: 'current-generation',
      }));
    release();

    await expect(staleRun).rejects.toThrow('codebase_reindex_lease_lost');
    expect(first.get(ref.codebaseId, scope)).toEqual(expect.objectContaining({
      activeGeneration: 'current-generation',
      indexGeneration: ref.indexGeneration + 1,
    }));
  });

  it('rejects fenced writes once the filesystem ingest lock is lost', async () => {
    const stealLock = (registryName: string): void => {
      const lockName = fs.readdirSync(tmpDir).find(name =>
        name.startsWith(`${registryName}.ingest.`) && name.endsWith('.lock'));
      expect(lockName).toBeDefined();
      fs.writeFileSync(path.join(tmpDir, lockName!, 'owner.json'), JSON.stringify({token: 'intruder'}));
    };
    const activating = new CodebaseRegistry(path.join(tmpDir, 'fs-activate.json'));
    const activateRef = activating.register({kind: 'app_source', displayName: 'Activate', rootPath: tmpDir});
    await expect(activating.withIngestLease(activateRef.codebaseId, {}, lease => {
      stealLock('fs-activate.json');
      return lease.activateIndexGeneration(activateRef.indexGeneration, {
        lastIngestStatus: 'ok',
        activeGeneration: 'stale-generation',
      });
    })).rejects.toThrow('codebase_reindex_lease_lost');
    expect(activating.get(activateRef.codebaseId, {})?.activeGeneration).not.toBe('stale-generation');

    const deleting = new CodebaseRegistry(path.join(tmpDir, 'fs-delete.json'));
    const deleteRef = deleting.register({kind: 'app_source', displayName: 'Delete', rootPath: tmpDir});
    await expect(deleting.withIngestLease(deleteRef.codebaseId, {}, lease => {
      lease.beginDeletion('user-a');
      stealLock('fs-delete.json');
      return lease.deleteRegistration();
    }, 'delete')).rejects.toThrow('codebase_reindex_lease_lost');
    expect(deleting.get(deleteRef.codebaseId, {})?.lifecycleState).toBe('deleting');
  });

  it('does not trust a root channel only one dual-write side records', () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-dual-channel.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const registryPath = path.join(tmpDir, 'dual-channel.json');
    const ref = new CodebaseRegistry(registryPath).register({
      kind: 'app_source', displayName: 'Picked', rootPath: tmpDir, rootAuthorization: 'native_picker', ...scope});
    expect(new CodebaseRegistry(registryPath).get(ref.codebaseId, scope)?.rootAuthorization).toBe('native_picker');
    // The DB copy loses the channel; the filesystem copy (the dual-write authority) keeps it.
    const {rootAuthorization: _channel, ...unchannelled} =
      getScopedKnowledgeRecord<CodebaseRef>('codebase_registry_ref', ref.codebaseId, scope)!.record;
    upsertScopedKnowledgeRecord('codebase_registry_ref', ref.codebaseId, 'codebase-registry-ref', unchannelled, scope);
    expect(fs.readFileSync(registryPath, 'utf8')).toContain('native_picker');
    const merged = new CodebaseRegistry(registryPath).get(ref.codebaseId, scope)!;
    expect(merged).toBeDefined();
    expect(merged.rootAuthorization).toBeUndefined();
    expect(channelAuthorizedRoots(merged)).toBeUndefined();
  });

  it('replicates fenced generation switches to the filesystem during dual-write', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise-dual.sqlite');
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    const registryPath = path.join(tmpDir, 'dual.json');
    const registry = new CodebaseRegistry(registryPath);
    const ref = registry.register({kind: 'app_source', displayName: 'Dual', rootPath: tmpDir, ...scope});

    await registry.withIngestLease(ref.codebaseId, scope, lease =>
      lease.activateIndexGeneration(ref.indexGeneration, {
        lastIngestStatus: 'ok',
        activeGeneration: 'dual-generation',
      }));

    expect(fs.readdirSync(tmpDir).some(name => name.startsWith('dual.json.ingest.'))).toBe(false);
    expect(fs.readFileSync(registryPath, 'utf8')).toContain('dual-generation');
    expect(registry.get(ref.codebaseId, scope)).toEqual(expect.objectContaining({
      activeGeneration: 'dual-generation',
      indexGeneration: ref.indexGeneration + 1,
    }));
  });
});
